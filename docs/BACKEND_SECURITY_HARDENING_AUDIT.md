# Backend security hardening audit

Branch `claude/system-hardening-sweep`. Defensive Secure-SDLC work against local
disposable databases with synthetic principals. No real money, no provider calls,
no e-mail, no SMS, no invoices, no change to canonical staging or production
state. The R9C payment lifecycle branch is out of scope and untouched.

This document is written phase by phase as work lands, so it is a record, not a
plan. Anything not yet run says so.

---

## EXECUTIVE SUMMARY

| | |
|---|---|
| Real vulnerabilities found | 2 |
| Real vulnerabilities fixed | 2 |
| Consistency hardenings | 7 |
| Protected routes enumerated | 87 |
| `UNGUARDED_PROTECTED_ROUTES` | 0 |
| Guard-ordering violations remaining | 0 |
| Cross-tenant 2xx leaks | 0 |
| New CI gates | 3 (behavioural authz, static authz, cross-principal isolation) |
| Phases complete | 3 of 14 (Phase 0, 1, 2) |

Both real findings are **existence oracles**, not data leaks. No cross-tenant
content was ever served; what leaked was the *fact* that an object exists.

- **V1** (unauthenticated): an anonymous caller could distinguish admin action
  ids that exist from ids that do not.
- **V2** (authenticated, cross-tenant): any logged-in seller could distinguish a
  real deal id belonging to another seller from a fabricated one, on six export
  and handoff routes. Drafts are never public, so this told a competitor whether
  a given id was a real unpublished deal.

Everything else is guard-order consistency — validation of the caller's own
input running before authorization. Those are recorded as hardenings,
deliberately **not** inflated into vulnerabilities.

---

## REAL VULNERABILITIES FOUND

### V1 — Admin action existence oracle (`POST /api/admin/actions/:adminActionId/execute`)

**Class:** information disclosure / enumeration oracle.
**Severity:** MEDIUM. No body content leaked and no state changed, but an
anonymous caller could enumerate valid admin action ids, which is reconnaissance
for a targeted attack on the approval rail.

**Root cause.** The handler opened its transaction and ran

```sql
SELECT action_type FROM siton.admin_actions WHERE admin_action_id=$1
```

*before* any authorization guard. A missing id produced `404
admin_action_not_found`; an existing id fell through to the permission check and
produced `401`. The status code itself answered "does this id exist?".

The ordering was not careless — the action-type-specific permission genuinely
cannot be known until the row is read. The fix keeps that requirement and adds a
cheap authentication gate in front of it.

**Fix.** Authenticate (`sessionRequired: true`) before the lookup, then load the
row, then enforce the action-type permission and MFA:

```ts
const authenticated = await requireAdminAuthContext(req, reply, c, { sessionRequired: true });
if (!authenticated) return reply;
requireUuid(adminActionId, "admin_action_id");
const actionResult = await c.query(`SELECT action_type FROM siton.admin_actions WHERE admin_action_id=$1`, [adminActionId]);
...
const identity = await requireAdminAuthContext(req, reply, c, {
  permission: ADMIN_ACTION_PERMISSION[actionTypeForPermission] || "admin_actions.execute",
  sessionRequired: true,
  recentMfa: HIGH_TRUST_ADMIN_ACTIONS.has(actionTypeForPermission)
});
```

The second guard call is safe: `requireAdminAuthContext` only resolves and
validates the session — no audit write, no token consumption, no counter — so
calling it twice costs one extra session read and has no side effect.

**A/B proof.** With `src/` reverted the gate reports
`POST /api/admin/actions/:adminActionId/execute -> 404` for an anonymous caller
and fails. With the fix it reports `401` and passes. Additionally
`tests/protected_route_authorization_gate.ts` asserts that two independent random
ids produce the *same* status on every parametric protected route, which is the
general form of this bug.

### V2 — Cross-tenant deal existence oracle (six seller export / handoff routes)

**Class:** IDOR-adjacent information disclosure. Object-level authorization was
correct; the *shape of the refusal* was not.
**Severity:** MEDIUM. No cross-tenant data was ever served — every probe was
refused. What leaked was existence: a foreign deal answered `403` while a
fabricated id answered `404`, so any authenticated seller could test whether an
arbitrary deal UUID was real. Draft deals are never public, so this is a
disclosure about objects the caller has no other way to observe.

Affected:

```
GET /api/seller/deals/:dealId/delivery-handoff
GET /api/seller/deals/:dealId/delivery-handoff/export.xlsx
GET /api/seller/deals/:dealId/shipping-export
GET /api/seller/deals/:dealId/voucher-export
GET /api/seller/deals/:dealId/ticket-export
GET /api/seller/deals/:dealId/export.xlsx
```

**Root cause.** Each handler loaded the deal, then branched:

```ts
if (!dealResult.rowCount)  throw { statusCode: 404 };            // missing
if (deal.effective_seller_id !== sellerId) throw { statusCode: 403 };  // foreign
```

The two branches are distinguishable, and that difference is the oracle.

**Why 404 is the right answer, not 403.** The codebase had already made this
decision elsewhere and these six routes simply had not been brought in line: the
seller-authorized Draft buyer preview (P0.7 polish) states that "a foreign deal
answers 404 exactly like a missing one", and `draft`, `delivery`, `duplicate`
and `delete` already behaved that way. The fix makes the six consistent with the
convention the project already chose.

**Three existing tests pinned the old `403`** — `S9 ownership 403 still
enforced`, `T2 unauthorized seller gets 403`, and `shipping export returns 403
when seller does not own the deal`. Each was written to prove *refusal*, with the
status code incidental. They were upgraded rather than merely edited to pass:
each now asserts the **stronger** property — refused, **and** returning the same
status as a nonexistent deal — so they would catch a regression in either
direction.

**A/B proof.** `tests/cross_principal_authorization_isolation_validation.ts`
failed before the fix, naming all six routes as `foreign 403 vs missing 404`, and
passes after. The suite carries a vacuity guard (seller A must be able to read
its *own* deal and its own inquiry thread) so a broken session fixture cannot
make the isolation assertions pass trivially.

---

## CONSISTENCY HARDENINGS

Seven routes ran `requireUuid` or body validation before their authorization
guard, so an anonymous caller could tell a malformed request from a well-formed
one. These validate the **caller's own input**, not server state, so they are not
disclosure bugs. They are still worth closing: they let unauthenticated traffic
reach parsing and validation logic, and they make the guard's answer
non-uniform.

| # | Route | Was |
|---|---|---|
| C1 | `POST /api/admin/actions/:adminActionId/approve` | 400 before guard |
| C2 | `POST /api/admin/actions/:adminActionId/reject` | 400 before guard |
| C3 | `POST /api/admin/control-flags/:flagId/release` | 400 before guard |
| C4 | `PATCH /api/seller/deals/:dealId/draft` | 400 before guard |
| C5 | `PUT /api/seller/deals/:dealId/delivery` | 400 before guard |
| C6 | `POST /api/seller/inquiries/:threadId/reply` | 400 before guard |
| C7 | `POST /api/affiliate/links` | 400 before guard |

C1–C6 were found by inspection. **C7 was found by the gate itself on its first
run**, on a namespace the manual sweep had not covered — which is the argument
for enumerating namespaces instead of maintaining a list.

---

## AUTHORIZATION MATRIX SUMMARY

Route membership is derived from the **live Fastify router** by namespace, never
from a hand-written list, so a protected route added tomorrow is covered the
moment it is registered.

| Namespace | Protected | Anonymous by design |
|---|---|---|
| `/api/admin/` | 59 | 3 |
| `/api/seller/` | 26 | 3 |
| `/api/affiliate/` | 2 | 1 |
| `/api/distributor/` | 0 | 3 |
| **Total** | **87** | **10** |

Anonymous probes: **95**. Outcomes: refused (401/403) **94**, fail-closed (503)
**0**, unguarded **0**, guard-ordering **0**. One probe fewer than 95 per route
because HEAD/OPTIONS are skipped.

### Three classes that are never collapsed

The defect in the previous static report was a single `"not detected"` string
used for both a missing guard and a surface it had no opinion about — so a public
route and a real hole read identically. The classes are now disjoint and
asserted to partition the router:

- **`protected`** — must refuse an anonymous caller
- **`anonymous-by-design`** — reviewed exception with a written reason
- **`public-contract`** — outside every protected namespace; never counted as unguarded

### Two outcomes that are never collapsed

- **`unguarded`** — 2xx. The route served an anonymous caller. Disclosure.
- **`guard_ordering`** — any other non-401/403/503. The request reached
  validation, a lookup or a handler fault behind the guard. An oracle even when
  no body leaked.

Reporting these as one number hides which one you have.

### Anonymous-by-design allowlist (10, each reasoned)

Maintained in `scripts/protected_route_policy.cjs` and policed by the gate: a
stale entry whose path is no longer registered fails; a reason under 40
characters fails; growth past 12 entries fails.

| Route | Reason (abridged) |
|---|---|
| `/api/admin/auth/login` | Credential entry point; cannot require the session it issues. Wrong credentials and unknown accounts answer identically. |
| `/api/admin/auth/logout` | Idempotent teardown; clearing an absent cookie is a success and carries no admin data. |
| `/api/admin/auth/mfa/verify` | Second login factor; caller holds a challenge id, never a session. Unknown and expired challenges both answer 401. |
| `/api/seller/session` | Browser asks "am I signed in?"; reports unauthenticated state, returns no seller data. |
| `/api/seller/session/login` | Credential entry point. |
| `/api/seller/session/logout` | Idempotent teardown. |
| `/api/distributor/session` | Distributor session probe; no distributor data when unauthenticated. |
| `/api/distributor/session/login` | Credential entry point. |
| `/api/distributor/session/logout` | Idempotent teardown. |
| `/api/affiliate/links/visit` | Public click/entry tracking; share links are handed to anonymous buyers by design. Records only click and entry events keyed by a source code the visitor already holds. |

The gate additionally asserts that allowlisted routes return no principal data
(`seller_id`, `admin_user_id`, `distributor_id`, `login_email`, `email`) to an
anonymous caller. Being reachable is the exception; leaking is never part of it.

---

## IDOR / CROSS-TENANT RESULT

Synthetic principals SELLER_A and SELLER_B, provisioned through the real admin
route and holding real DB-backed sessions in `internal-runtime` — **not** the
demo-preview `x-seller-id` convenience header, which auto-creates a workspace for
any caller and would make an isolation proof meaningless. The route set is
enumerated from the live router, so a seller route added tomorrow is probed
without editing the suite.

| Probe | Result |
|---|---|
| Vacuity guard: A reaches its own deal, own draft, own thread; B's list excludes A's deal | PASS |
| A receives 2xx for B's deal on any parametric seller route (17 routes) | 0 |
| Foreign deal vs nonexistent deal status parity | PASS after the V2 fix |
| A mutates B's deal (draft / delivery / duplicate / delete) — status **and** durable DB state | PASS; B's row unchanged, no copy created in A's account |
| A reads or replies to B's inquiry thread; foreign/missing parity; no message written on refusal | PASS |
| A's inquiry list leaks B's thread | No |
| `x-seller-id` overrides an existing session | No |
| `x-seller-id` alone is authority | No (401) |
| Seller session reaches `/api/admin/overview`, `/api/admin/actions`, `/api/admin/mission-control`, `/api/admin/auth/me` | No (401/403) |
| Seller session reaches `/api/affiliate/overview` | No |

Two details that decide whether this suite is worth anything:

- **The vacuity guard is not decoration.** If the session fixture broke, every
  probe would return 401 and every isolation assertion would pass while proving
  nothing. The suite therefore proves A *can* reach its own objects first.
- **The role-confusion probes assert their targets are registered.** An earlier
  draft probed `/api/admin/deals`, which does not exist; it passed on the 404 and
  proved nothing. The suite now fails if a probe target is not in the router.

Write refusals are checked against the **database**, not only the status code: a
refused cross-tenant reply must also leave zero rows behind, and a refused
`duplicate` must not have copied the foreign deal into the attacker's account.

## CI COVERAGE

Two independent halves, both asserting `UNGUARDED_PROTECTED_ROUTES = 0` with no
numeric threshold:

1. **Behavioural** — `tests/protected_route_authorization_gate.ts`, in the
   security suite. Enumerates the live router, probes every protected route
   anonymously, classifies outcomes, writes
   `.ci-artifacts/route-authorization-gate.json`.
2. **Static** — `npm run ci:route-authorization`
   (`scripts/web_route_inventory.cjs`), a named step in
   `backend-quality-gates.yml`. Requires a guard helper in the code that actually
   runs, and exits non-zero listing offenders.

**Both gates were proved to have teeth**: an injected
`GET /api/admin/__gate_probe_unguarded` returning `{ ok: true }` was caught by
the static gate (`UNGUARDED_PROTECTED_ROUTES=1`, exit 1) and by the runtime gate
(`unguarded` bucket = 1, correctly *not* filed as guard-ordering), then removed.

**Static detection is evidence, not proof.** It reads source text; the
authoritative verdict is behavioural. A false "guarded" claim is the dangerous
direction, and the one hardcoded path exemption that existed
(`includes("/notifications")`) was removed: it asserted two routes were guarded
without checking. They are in fact guarded — `requireAdminRead` inside the shared
`notificationStatusHandler` — but the scanner could not see it because those
routes register a handler by name. The scanner now follows named-handler
references, so the evidence comes from the code that runs rather than from the
path.

---

## RESULTS BY AREA

| Area | Status |
|---|---|
| Authorization ordering | **PASS** — 87 protected routes, 0 unguarded, 0 ordering violations |
| IDOR / cross-tenant | **PASS after fix** — 1 finding (V2), 0 cross-tenant 2xx, foreign/missing parity on every parametric seller route |
| Role confusion | **PASS** — a seller session reaches neither the admin nor the distributor surface; a caller-supplied `x-seller-id` never overrides or supplies authority |
| Role / session / account state | PARTIAL (Phase 3) — forged and header-only identity covered; expiry, revocation, suspended accounts and admin capability tiers not yet |
| Mutation replay / double-submit | NOT RUN (Phase 4) |
| Concurrency / state-machine races | NOT RUN (Phase 5) |
| Worker / outbox resilience | NOT RUN (Phase 6) |
| Storage / file boundary | NOT RUN (Phase 7) |
| Rate limit / abuse boundary | NOT RUN (Phase 8) |
| Input / query / error surface | NOT RUN (Phase 9) |
| DB authority / invariants | NOT RUN (Phase 10) |
| Observability / forensic truth | NOT RUN (Phase 11) |
| Secret / config / fail-closed | Partial — repository secret scan PASS via `npm run lint`; full Phase 12 audit not run |
| Soak / chaos | NOT RUN (Phase 13) |

---

## OPEN ITEMS

### OPEN P1

- **Phases 1–13 not started.** The marathon scope below Phase 0 is untouched.

### OPEN P2

- **`POST /api/affiliate/links/visit` returns `recorded: true|false`**, which
  distinguishes a live source code from a dead one. Source codes are handed to
  anonymous buyers in share links by design, so this is a weak oracle over
  semi-public data rather than a leak. Recorded for Phase 8/9 rather than
  "fixed" here.
- **Static guard detection is heuristic.** A new guard helper name must be added
  to `GUARD_PATTERNS`, and until it is the static gate fails closed (loudly).
  That is the intended direction, but it is a maintenance cost worth stating.

### Pre-existing, carried forward (not introduced here)

- **Join rate hardening / shared-IP.** The aliased `/api/deals/:id/join` and bare
  `/deals*` lifecycle routes are governed by the global 200/min per-IP bucket
  plus join idempotency and DB guards; they never matched the `/api/…` sensitive
  prefixes because the alias rewrite runs before the limiter hook. Solving this
  with a blunt per-IP limit would throttle legitimate buyers behind one NAT.
  Phase 8 item, needs a product/identity decision.
- **Real external e-mail delivery is OPEN / PROVIDER REQUIRED.** The repository
  contains one notification adapter (`LogNotificationProvider`); real mode cannot
  boot. No e-mail was sent during any of this work and none is claimed.

---

## OUT-OF-SCOPE FINANCIAL / R9C ITEMS

None found so far. Nothing in this branch touches payment, reconciliation,
payout, provider dispatch or the R9C durable operation lifecycle. If a finding
lands there it will be proved and documented here, not fixed on this branch.

---

## TEST MATRIX

| Suite | Result |
|---|---|
| `admin_route_auth_coverage_validation` | 3/3 (59 admin routes) |
| `seller_route_auth_coverage_validation` | 3/3 (26 seller routes) |
| `protected_route_authorization_gate` | 6/6 (87 protected routes, 95 probes) |
| Security group | see PROJECT_STATUS for the run of record |
| Tests touching changed routes | 11/11 |
| `npm run lint` (backend enforcement + secret scan) | PASS |
| `npm run gate:architecture` | PASS |
| `tsc -p tsconfig.test.json` | PASS |
| `npm run ci:route-authorization` | PASS (`UNGUARDED_PROTECTED_ROUTES=0`) |

A/B discipline: every fix in this document was proved by reverting it and
watching a test fail with the offending route named, then restoring it and
watching the test pass. No test in this branch asserts an implementation detail
back to itself.

---

## RECOMMENDED NEXT STEP

Phase 1 — extend the authorization matrix from "does it refuse an anonymous
caller?" to the full per-route classification (role/capability, object ownership,
MFA, mutation vs read, expected wrong-role response), then Phase 2 cross-account
isolation with synthetic principals, which is where object-level authorization
bugs actually live.
