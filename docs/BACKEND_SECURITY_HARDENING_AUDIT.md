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
| Real vulnerabilities found | 4 |
| Real vulnerabilities fixed | 4 |
| Consistency hardenings | 7 |
| Protected routes enumerated | 87 |
| `UNGUARDED_PROTECTED_ROUTES` | 0 |
| Guard-ordering violations remaining | 0 |
| Cross-tenant 2xx leaks | 0 |
| New CI gates | 8 (behavioural authz, static authz, cross-principal isolation, principal state authority, mutation replay, state-machine races, outbox poison/progress, storage boundary) |
| Phases complete | 8 of 14 (Phases 0-7) |

**No protected content was ever served to a caller who should not see it.** Three
of the four findings are existence oracles — what leaked was the *fact* that an
object exists — and the fourth is an error-surface defect.

- **V1** (unauthenticated existence oracle): an anonymous caller could
  distinguish admin action ids that exist from ids that do not.
- **V2** (authenticated cross-tenant existence oracle): any logged-in seller
  could distinguish a real deal id belonging to another seller from a fabricated
  one, on six export and handoff routes. Drafts are never public, so this told a
  competitor whether a given id was a real unpublished deal.
- **V3** (error surface): routine lifecycle conflicts — a lost compare-and-swap
  when two operations race — were reported as `500 internal_error` instead of
  `409`. Not an authorization bug and it discloses nothing, but it is the failure
  mode that hides real incidents in routine noise and tells retrying clients to
  hammer a conflict they can never win.

- **V4** (anonymous existence oracle over private imagery): on the public
  `/api/deal-images/:imageId` route, an anonymous caller got `401` for a real
  Draft image and `404` for a fabricated id. Draft imagery is never public, so
  this confirmed that a given image id was a real private file.

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

### V3 — Lifecycle conflicts reported as internal faults (`500` instead of `409`)

**Class:** robustness / error-surface defect with operational consequences.
**Severity:** MEDIUM. Not an authorization bug and it discloses nothing, but it
is the failure mode that hides real incidents and amplifies load.

**What happens.** Two guards protect the deal lifecycle, and both worked
correctly — they just reported failure as a server error:

```ts
assertValidTransition(...)   // throw new Error(`Illegal ${stateType} transition ...`)
if (upd.rowCount !== 1)      // throw new Error(`State mismatch deal ${id} expected ${from}`)
```

Neither carried a `statusCode`, so Fastify mapped both to `500 internal_error`.
The second is the compare-and-swap on `UPDATE siton.deals SET state=$1 WHERE
deal_id=$2 AND state=$3` — the concurrency control doing exactly its job. Losing
that CAS is the **normal** outcome whenever two lifecycle calls race, which is
every time two admin tabs, a retrying client, or a user double-clicking act at
once.

**Why it matters beyond tidiness.**

- A `500` tells a retrying client to try again. The answer will never change, so
  a well-behaved client with backoff hammers a conflict it can never win. A `409`
  tells it to refresh and stop.
- Routine contention and genuine internal faults became indistinguishable in
  logs and error budgets. During an incident that is the difference between
  seeing the fault and not.
- Callers got `{"ok":false,"error":"internal_error"}` — nothing actionable, for a
  condition the server understood perfectly well.

**Fix.** Both throw sites now carry `statusCode: 409` plus a machine-readable
code (`ILLEGAL_STATE_TRANSITION`, `STATE_CONFLICT`) and the states involved. The
**messages are deliberately unchanged**: `tests/backend_sanity_suite.ts` matches
on them, and they name both states, which is what an operator needs. Control flow
is untouched — nothing is swallowed, and this does not convert genuine internal
faults into 4xx; it only classifies the two conditions the server already
recognised as conflicts.

The CAS covers `participants` too (`buyer_state`, `money_state`), so this changes
the status code money-path endpoints return on an illegal transition, from `500`
to `409`. That is the same correction for the same reason and moves no money, but
because it is shared code the **entire suite** was re-run rather than the security
group alone.

**A/B proof.** With the fix reverted,
`tests/state_machine_race_authority_validation.ts` fails on two probes with
`a racing lifecycle call faulted: 500 {"ok":false,"error":"internal_error"}`;
restored, both pass.

---

### V4 — Anonymous existence oracle over Draft imagery (`GET /api/deal-images/:imageId`)

**Class:** information disclosure / enumeration oracle over private files.
**Severity:** LOW–MEDIUM. Image ids are random v4 UUIDs, so this is not
guessable at scale; it matters when a Draft image URL escapes — a shared link, a
screenshot, a log line — and an outsider wants to confirm it names a real private
file.

**Root cause.** The route is public by contract: it must serve anonymous buyers
for published deals. For an *unpublished* deal it fell back to seller authority:

```ts
if (!image.published_at) {
  const sellerAuthority = await requireSellerAuthorityWithoutBody(req, c);  // throws 401 anonymously
  if (normalizeSellerId(image.seller_id) !== sellerAuthority.seller_id) throw 404;
}
```

The **foreign-seller** branch was already correct — `404`, indistinguishable from
a missing image. The **anonymous** branch was not: `requireSellerAuthorityWithoutBody`
threw `401`, so `401` meant "real but private" and `404` meant "no such image".

**Fix.** Every caller who is not the owner now gets the same `404`. The authority
resolution is wrapped so its failure becomes the not-found answer rather than an
authentication answer.

**A/B proof.** `tests/storage_boundary_authority_validation.ts` failed before the
fix with `anonymous can tell an existing draft image (401) from a missing one
(404)`, and passes after. The same probe runs as a foreign seller, which was
already correct and stays correct — so the test would also catch a regression
that "fixed" anonymous by breaking the foreign case.

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

## ROLE / SESSION / ACCOUNT-STATE RESULT

`tests/principal_state_authority_validation.ts`, 12/12. A credential is not a
capability; a session that *was* valid is not one that *is* valid; an account
that *could* act is not one that *may still* act.

The headline invariant is enumerated from the live router, so a new admin
mutation is covered the moment it is registered: **a ReadOnlyAdmin holds a real,
fully authenticated, MFA-verified session and must still never mutate platform
state.** All 19 admin write route/method pairs are probed with it.

| Probe | Result |
|---|---|
| ReadOnlyAdmin mutates anything (19 write routes) | 0 — 17× 403, 1× 404 (analysed below), 1 self-service route excluded and separately proven |
| ReadOnlyAdmin write probe causes a 5xx | 0 |
| SupportAdmin approves / rejects / executes an admin action | Refused (holds `admin_actions.read`+`.create`, not `.approve`/`.execute`) |
| Shared bootstrap key mutates anything | 0 — it is a break-glass READ credential, `sessionRequired` rejects it (R5C) |
| Revoked admin session still works | No |
| Expired admin session still works | No |
| Disabled admin account still holds authority through a live session | No |
| Forged / malformed session material (8 shapes incl. oversized, traversal, NUL bytes, a JSON identity blob) | All 401/403, none fatal |
| Suspended seller still edits its own draft | No — 403 `SELLER_SUSPENDED`, and the DB row is unchanged |
| Seller logout revokes the session for later requests | Yes |

### Two investigated non-findings

Both were surfaced by the enumeration and are recorded as **not vulnerabilities**
after tracing the code, rather than being silently excluded.

**1. `POST /api/admin/auth/mfa/setup` answers 200 for a ReadOnlyAdmin.** Correct.
Enrolling your *own* second factor is an account action, not a platform mutation;
an admin who cannot set up MFA cannot secure their own login. The dangerous
neighbour, `/api/admin/auth/mfa/disable`, correctly requires
`admin_users.manage`. The exception is safe only while the route cannot be aimed
at somebody else, so that is **proven, not assumed**: the suite calls it as a
ReadOnlyAdmin with `{admin_user_id: <SuperAdmin>}`, `{email: <SuperAdmin>}` and a
combined body, then asserts the victim's `admin_mfa_challenges` count is
unchanged and the caller's own is not — the handler reads only
`identity.admin_user_id` and has no target parameter at all.

**2. `POST /api/admin/actions/:adminActionId/execute` answers 404 to an
authenticated caller who lacks the permission.** This is the Phase 0 fix working
as designed: the action-type-specific permission genuinely cannot be known before
the row is read, so the order is authenticate → load → authorise. That leaves a
404-for-missing versus guard-answer-for-real split *for authenticated callers*,
which would be an oracle — unless everyone who passes the authentication gate can
already enumerate admin actions. That premise is load-bearing, so the suite
**proves** it: all four roles (`SuperAdmin`, `OpsAdmin`, `SupportAdmin`,
`ReadOnlyAdmin`) are checked to hold `admin_actions.read`, and the bootstrap key
is confirmed to be stopped *before* the lookup. If a future role is added without
`admin_actions.read`, that test fails and the route's ordering must be revisited.

## MUTATION REPLAY RESULT

`tests/mutation_replay_authority_validation.ts`, 10/10. The property under test
is **not** "everything is idempotent" — it is that a logical operation which
should happen once creates one durable effect, however the client retries. Its
mirror is asserted just as explicitly, because a test demanding idempotency
everywhere would be arguing for a product bug.

Every outcome is checked in the **database**. A 200 that wrote a second row and a
200 that wrote none look identical over HTTP.

| Probe | Result |
|---|---|
| Same idempotency key replayed sequentially | 1 deal |
| Same idempotency key fired 5× in **parallel** | 1 deal |
| Two creates with **no** key | 2 deals — distinct actions, correctly not collapsed |
| Two **different** keys, same content | 2 deals |
| Publish twice | one transition, `published_at` unmoved, ≤1 `deal.publish` audit row |
| 5 **parallel** publishes | one publication, ≤1 audit row, delivery options not duplicated |
| Two different draft edits | both apply — replay protection does not freeze the draft |
| 4 concurrent draft edits | exactly one winner, one row, no torn value |
| Seller inquiry: identical retry, then a genuinely different reply | retry adds at most one; the different reply is never swallowed |

Parallel probes use `Promise.all` against one app instance so requests interleave
in a single process and contend on the same pool. A sequential "retry" exercises
only the stored-result path and would never catch a check-then-write race.

## CONCURRENCY / STATE-MACHINE RESULT

`tests/state_machine_race_authority_validation.ts`, 6/6. Races are judged against
the **declared** machine (`DEAL_TRANSITIONS`, imported rather than restated), not
against a hand-written expectation: whatever state survives must be reachable
from the state the deal was in. The suite therefore stays correct if the product
legitimately changes which operation wins, and fails only when the outcome is
*impossible*.

| Race | Result |
|---|---|
| Publish vs cancel (×5) | one reachable state; a `Cancelled` deal never keeps a `published_at`, so both operations never win |
| Publish vs draft edit (×5) | one row, never torn: published ⇒ has `published_at`, still Draft ⇒ has none |
| Terminal deal: publish, cancel and edit after `Cancelled` | state unchanged, edit rejected — terminal truth never reopens |
| 3 concurrent delivery updates | the surviving set is one of the submitted sets, never a union; no duplicated option |
| Approve vs reject on one admin action | a single decision, one row, no impossible status |

This is where **V3** was found: the races were safe, but the loser's answer was
`500`.

## WORKER / OUTBOX RESULT

**Pre-existing coverage here is strong and this audit did not duplicate it.**
`worker_two_process_fencing_validation` already proves two live workers complete
30 competing jobs exactly once, that a hard-killed owner is fenced out and
reclaimed, that SIGTERM during active ownership never duplicates, that heartbeat
renewal keeps a blocked survivor owned, and that an unknown type or malformed
payload is DLQ-archived without crashing.
`outbox_reclaim_precision_proof` proves the lease timeout boundaries, that two
concurrent reclaims never double-process, and that reclaim-then-fail lands in the
DLQ with no phantom `sent` row.

What none of them asked is whether the queue keeps **moving** when one event can
never succeed — liveness rather than safety.
`tests/outbox_poison_progress_authority_validation.ts`, 6/6:

| Probe | Result |
|---|---|
| Poison event is bounded | stops at `3/3` attempts, lands in the DLQ, never `sent` |
| Poison event blocks the queue behind it | No — healthy events queued *after* it are still attempted |
| Event whose aggregate was deleted between enqueue and processing | terminal at `3/3`, not retried forever |
| A failing event reports itself as sent | No — `sent=false`, `sent_at` null, `last_error` never an empty string |
| Same event handed to two concurrent claimers | No overlap |

A terminal event is copied into `siton.outbox_dlq` and deleted from
`siton.outbox_events` in one transaction, so the suite asserts an event lives in
**exactly one** of the two tables: in neither means it was lost, in both means it
can be reprocessed after archival.

## STORAGE RESULT

`tests/storage_boundary_authority_validation.ts`, 6/6. The storage *adapter* is
already covered (atomicity, cleanup leases, fault boundaries, the Supabase
broker, readiness); this is the authorization question those suites do not ask.

| Probe | Result |
|---|---|
| Draft image served to another seller or to the public | No — and now indistinguishable from a missing image (**V4**) |
| Object key contains the original filename or the seller id | No — in neither `storage_key` nor `public_url`; the filename is retained as metadata only |
| Path traversal in a filename reaches the key (`../`, `..\`, `a/../../b`) | No |
| Malformed uploads: empty, zero-byte, unsupported MIME, executable disguised as PNG, non-base64, MIME/data mismatch, `text/html` MIME | All bounded 4xx, no 5xx, nothing non-image persisted |
| Refused cross-seller write (upload / reorder / delete) changed the victim's rows | No — row set byte-identical before and after |

Object keys are checked because they end up in CDN URLs, access logs and support
tickets. A key like `seller-acme/price-list-confidential.png` leaks both the
tenant and the document name to anyone who ever sees the URL.

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
| Role / session / account state | **PASS** — capability tiers, session lifecycle, account state; 0 findings, 2 investigated non-findings documented below |
| Mutation replay / double-submit | **PASS** — sequential and parallel replay land once; distinct actions are not collapsed |
| Concurrency / state-machine races | **PASS after fix** — 1 finding (V3); no impossible state, no torn row, no duplicate durable effect |
| Worker / outbox resilience | **PASS** — pre-existing coverage is strong; 3 liveness gaps added and green |
| Storage / file boundary | **PASS after fix** — 1 finding (V4); object keys clean, upload validation bounded, cross-seller writes inert |
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
| `cross_principal_authorization_isolation_validation` | 7/7 (17 parametric seller routes, 2 principals) |
| `principal_state_authority_validation` | 12/12 (19 admin write routes, 4 roles) |
| `mutation_replay_authority_validation` | 10/10 (sequential + parallel replay) |
| `state_machine_race_authority_validation` | 6/6 (5 race classes, judged against DEAL_TRANSITIONS) |
| `outbox_poison_progress_authority_validation` | 6/6 (queue liveness under poison) |
| `storage_boundary_authority_validation` | 6/6 (draft imagery, object keys, upload validation) |
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
