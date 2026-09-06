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
| Real vulnerabilities found | 7 |
| Real vulnerabilities fixed | 7 |
| Consistency hardenings | 7 |
| Protected routes enumerated | 87 |
| `UNGUARDED_PROTECTED_ROUTES` | 0 |
| Guard-ordering violations remaining | 0 |
| Cross-tenant 2xx leaks | 0 |
| New CI gates | 13 (authz behavioural + static, cross-principal isolation, principal state authority, mutation replay, state-machine races, outbox poison/progress, storage boundary, input/error surface, DB invariants, forensic logging, rate-limit classifier, synthetic soak) |
| Phases complete | **14 of 14** |

**No request was ever served to the wrong caller.** Three of the seven findings
are existence oracles — what leaked was the *fact* that an object exists — two
are error-surface defects, one wrote a credential into the logs, and one made
incidents harder to reconstruct.

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

- **V5** (error surface): a NUL byte in a query parameter reached the database
  driver and produced `500` instead of a bounded `400`. Reachable only by an
  authenticated admin where it was found, but every route forwarding a query
  parameter into a query had the same exposure, so the fix sits at the entry
  point.

- **V6** (credential in logs): the buyer's inquiry-thread access token travels
  as `?t=<token>`, and the request logger wrote the full URL — so a credential
  granting read access to a private conversation was persisted to the
  application log on every read.
- **V7** (forensic gap): log lines carried a Fastify-minted request id while
  audit rows carried the caller's `x-request-id`, so the two could not be
  joined — exactly the correlation an incident needs.

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

### V5 — A NUL byte in a query parameter faults the server (`500`)

**Class:** unhandled input reaching the database driver.
**Severity:** LOW–MEDIUM. Reachable only by an authenticated admin on the route
where it was found, so it is not an anonymous availability lever. It is still a
`500` produced by a value the caller chose, which is the shape this phase exists
to eliminate.

**Found:** `GET /api/admin/support-cases?seller_id=%00` → `500 internal_error`.

**Root cause.** PostgreSQL cannot represent a NUL byte in a `text` value, so any
query parameter carrying one is guaranteed to fail once it reaches the driver.
Nothing rejected it earlier, so it surfaced as a server error rather than a
bounded refusal.

**Fix — placed at the entry point, not in the handler.** Every route that
forwards a query parameter into a query has the same exposure, so a per-handler
patch would have fixed one instance of a class. An `onRequest` hook now rejects
any query value containing a NUL with `400 NUL_BYTE_IN_QUERY`.

**Rejecting rather than stripping** is deliberate: a NUL is never meaningful
input, and silently rewriting it would change what the caller asked for.
Control-character scrubbing already exists for *stored* text
(`seller_inquiries`, `pickup_location`, `frontend_runtime`); this closes the
query-string entry point in the same spirit.

**A/B proof.** The sweep reported
`/api/admin/support-cases ?seller_id=\x00 -> 500` before the hook and `0 faults`
across 5,781 probes after it.

---

### V6 — Buyer inquiry access tokens written to the application log

**Class:** credential disclosure into a lower-security store.
**Severity:** MEDIUM. No request was mishandled and nothing was served to the
wrong caller — but a credential ended up somewhere that outlives the request, is
copied to log aggregators, and is read by far more people than the request ever
was.

**Root cause.** The buyer's inquiry-thread access token travels in the **query
string**:

```ts
// GET /api/inquiries/:threadId — src/frontend_runtime.ts
const token = String(req.query?.t || "").trim();
```

Fastify's default request serializer logs the full URL, so every read of a buyer
thread wrote `?t=<access token>` into the log. That token grants read access to a
private conversation — customer name, masked e-mail, message history.

**Fix.** A request serializer that mirrors Fastify's default but sanitises the
URL, masking the values of query keys that carry credentials rather than filters
(`t`, `token`, `access_token`, `auth`, `key`, `api_key`, `admin_key`, `secret`,
`password`, `code`, `signature`, `sig`).

**Masked, not dropped.** A reader must be able to tell a redaction from an absent
parameter, and ordinary parameters must survive — redacting everything trades a
credential leak for an undebuggable log. The suite asserts both directions: the
credential appears as `t=[redacted]`, while an ordinary `q=` search term and the
route itself are still present.

**Scope honesty.** This is the narrow fix for the *logging* problem and changes
no API. Moving the token out of the query string entirely is the deeper fix —
query strings also reach browser history, `Referer` headers and proxy logs — but
that is a product/API change, because existing buyer links carry `?t=`. It is
recorded as an open item rather than done silently here.

**A/B proof.** `tests/forensic_logging_authority_validation.ts` reported
`credential in query` (plus its URL-encoded and fragment forms) before the
serializer and passes after.

### V7 — Log lines could not be joined to the audit trail

**Class:** forensic gap. Not exploitable; it is what makes an incident hard to
reconstruct.

The application already treats `x-request-id` as the canonical correlation id —
it normalises the header onto the request and writes it into audit rows. Fastify
was minting its own `reqId` for the log line, so the log entry and the audit row
for the same request carried **different ids and could not be joined**. Fixed by
`requestIdHeader: "x-request-id"`, so one id runs through logs, audit rows and
the caller's own tracing. Pino JSON-encodes the value, so a caller cannot inject
a forged log line through it.

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

## INPUT / ERROR-SURFACE RESULT

`tests/input_error_surface_authority_validation.ts`, 6/6. Two invariants, and the
second is the one that leaks:

1. Caller-controlled input produces a **bounded 4xx, never a 5xx**. A 500 from a
   value the caller chose means the request reached logic that did not expect it.
2. An error body **never describes the server** — no stack frame, SQL, driver
   text, filesystem path, connection string or configured secret.

Deliberately *not* asserted: that any particular hostile value is rejected. A
route may ignore an unknown parameter, clamp a silly one, or return an empty
page. Demanding rejection everywhere would invent a contract the product never
made.

| Probe | Result |
|---|---|
| Query fuzz — 5,781 probes across 123 GET routes | **0 faults** (1 before the V5 fix) |
| Error bodies describing the server | None |
| Malformed path parameters (7 shapes incl. traversal, NUL, 4KB, short UUID) | Bounded 4xx, no internal detail |
| Pagination abuse (`limit=1000000`, `999999999999`, `-1`, `1e400`) | No fault, no unbounded body |
| Hostile JSON bodies (10 shapes: negative, overflow, NaN strings, wrong types, 200-deep nesting, 200KB strings, all-null, invalid enum, invalid timestamp, `__proto__` pollution) | Bounded 4xx, `Object.prototype` unpolluted |

### Two flaws in this suite that a negative control caught

Both are recorded because they decide whether the "0 faults" result means
anything. The suite was built, an intentionally broken route was injected, and it
was **not** detected — twice — before the instrument was fixed.

**1. Aggregate coverage is not per-route coverage.** The first design walked a
rotating stride of (parameter, value) pairs across the route list. Over the whole
corpus every pair was exercised, but each individual route saw only a slice — so
an injected route that faulted on `limit=NaN` was never hit with that pair. The
sweep now has a **core** set (every route meets every high-signal value on the
parameters that actually reach parsing and query construction) *plus* the stride
for breadth across the long tail.

**2. The rate limiter silently invalidated everything after the first sweep.**
A thousands-of-request sweep exhausts the 200/min per-IP bucket within seconds,
after which every later probe gets `429` — so the leak, path-parameter,
pagination and JSON-body tests were all measuring the limiter, not the routes,
and passed vacuously. The suite now disables rate limiting explicitly, with the
reason written next to it. The limiter has its own suites
(`rate_limiter_validation`, `rate_limit_read_budget_validation`); this one is
about input handling.

A third, smaller instrument bug came from the same control: the Windows-path
detector was written for an unescaped path (`C:\Users\`) but error bodies are
JSON, where it arrives as `C:\\Users\\`. Every backslash in the internal-detail
patterns now tolerates one or two.

## DB-INVARIANT RESULT

`tests/db_invariant_authority_validation.ts`, 8/8. **No findings** — and the
result is only worth stating because the instrument was built to be able to
produce one.

Two different questions need two different instruments:

1. **Is the invariant backed by the schema?** Probed with direct SQL. If the
   database accepts the violation, the rule lives only in TypeScript and a new
   code path that forgets it has no backstop. This half is a regression gate:
   drop a `CHECK` and it fails.
2. **Where the rule cannot be a constraint** — "the sum of joined quantities must
   not exceed this deal's `max_units`" is not expressible as a column check —
   **does the concurrency control actually hold?** Probed with real concurrent
   requests, because that is the only thing that distinguishes a correct lock
   from a comment claiming there is one.

| Invariant | Backing | Verified |
|---|---|---|
| `participants.qty` within 1…1000 | `CHECK` | Zero, negative and absurd all rejected |
| `deals.min_units > 0`, `max_units >= min_units`, `threshold_units > 0` | `CHECK` | All three rejected |
| Participant → deal | FK | Orphan rejected |
| Image → deal | FK + `ON DELETE CASCADE` | Orphan rejected; imagery dies with its deal |
| Inquiry thread → deal | FK | Orphan rejected |
| **Total joined units ≤ `max_units`** | Application + `SELECT … FOR UPDATE` on the deal row | **14 concurrent joins → exactly 5 accepted, 5/5 units**; mixed quantities `[3,3,3,2,2,1,1,4]` → 6/6, no oversell |

The capacity race is the reason this file exists: read the remaining capacity,
decide there is room, write. Two requests interleaved between the read and the
write both decide yes. The row lock serialises them correctly.

**"5 of 14 succeeded" is only evidence if the other nine were refused because the
deal was full.** Had they failed for an unrelated reason — a bad fixture, an
exhausted pool, a validation slip — the counts would look identical while proving
nothing about the lock. The suite therefore asserts every rejection carries a
capacity reason, and that accepted count equals recorded units.

Two invariants were traced in code rather than tested, and both hold:
`threshold_units` is **derived** (`ceil(0.9 × min_units)`) at creation *and*
recomputed on every draft patch, so a caller cannot supply a threshold above
`max_units` and strand a deal that can never complete.

**No migration was written.** Nothing critical was found relying on TypeScript
alone with a race or bypass path, so adding schema is not justified here.
Migration numbers stay clean: this branch ends at 061 (P0.7), with 062 reserved
for the Amazon product work and 063 for the R9C payment lifecycle.

## OBSERVABILITY RESULT

`tests/forensic_logging_authority_validation.ts`, 6/6. Two requirements that pull
in opposite directions, and a test checking only one is worthless:

- **Log too little** and a security event cannot be reconstructed — "no secrets
  leaked" is trivially true of a silent server.
- **Log too much** and the log *is* the breach.

So the suite asserts both. Sentinel secrets are pushed through every channel a
request has — `Authorization`, `Cookie`, `x-admin-key`, request body, query
string — while the logger's output is captured, and the capture is checked for
the secrets **and** for the evidence that must be present.

| Probe | Result |
|---|---|
| Admin key, bearer token, session cookie, password, body token, card number, query credential in logs | None, including URL-encoded and fragment forms |
| Raw `Authorization` / `Cookie` / `x-admin-key` / `set-cookie` values logged | None |
| Ordinary query parameter and route survive redaction | Yes — credential shows as `t=[redacted]`, `q=` term intact |
| Refusal leaves correlatable evidence (request id, route, 401/403) | Yes, and the rejected credential is not logged |
| Internal fault carries a correlatable id without request secrets | Yes |

**Capturing the real logger was the only honest way to do this**, and the first
version of the suite proved why by capturing **0 bytes**: intercepting
`process.stdout.write` does not work, because Fastify's pino writes through
sonic-boom straight to the file descriptor. Had the vacuity guard not been there,
the two "no secrets leaked" assertions would have passed against an empty capture
and the whole phase would have been a false negative. The suite now swaps the
logger's own destination stream, so every assertion runs against the real
serializers and the real formatted line — what an aggregator would actually
store — rather than against `redact:` configuration read out of the source.

## SECRET / CONFIG RESULT

Largely **pre-existing and already covered**; this audit verified rather than
rebuilt. `npm run lint` carries the committed-secret scan (`SECRET_SCAN_PASS`),
and `src/production_guards.ts` fails closed on production configuration —
placeholder credentials, external storage without complete credentials,
`PAYMENT_ENVIRONMENT=live` outside production mode, and a real provider name
without its matching environment. Those are exercised by
`security_production_guards_validation`, `provider_production_readiness_validation`,
`payment_authorization_env_guard_validation` and `webhook_secret_policy_validation`.

One addition from this audit: a **raw control-byte gate** in the same scan. A
stray NUL byte reached a test file while the input-surface suite was being built,
and git then classified that file as **binary** — no diff, no line-level review,
no blame, so a source change had effectively landed unreviewable. The scan now
fails on any raw C0 byte (excluding tab/CR/LF), naming file, line and code point,
over a deliberately **wider** file list than the checks around it: those are
scoped to `src`/`frontend`/`scripts` because tests legitimately carry synthetic
secrets, whereas a control byte is never legitimate anywhere — and `tests/` is
exactly where this one landed.

**Real external e-mail delivery remains OPEN / PROVIDER REQUIRED** and is not
claimed otherwise anywhere in this audit. The repository contains one
notification adapter (`LogNotificationProvider`); real mode cannot boot. No
e-mail, SMS or provider call was made during any of this work.

## RATE-LIMIT RESULT

`tests/rate_limit_classifier_authority_validation.ts`, 6/6. Numeric limits are
covered elsewhere; this audits the **classifier**, which those suites cannot see.
A 20/min limit is worth nothing if the request never reaches the bucket, and
worth less than nothing if a read lands in the mutation bucket and starves normal
browsing.

| Probe | Result |
|---|---|
| Sensitive mutations (OTP request/verify, support, inquiries, chat post/patch/delete) | All in the mutation bucket |
| Public reads on the same prefixes (`/public`, `/activity`, `/chat`, HEAD, `/api/support`, `/api/otp/status`) | All in the **read** budget — the P0.7C requirement holds |
| Trailing slash, query string, lower-case method | Classification unchanged |
| Near-miss prefixes (`/api/dealsomething`, `/api/otpx`) | Correctly **not** swept in |

### OPEN — join is outside the mutation bucket (pinned, not fixed)

`rewriteUrl` maps the canonical `/api/deals/:id/join` onto the bare
`/deals/:id/join` **before routing**, and Fastify runs `rewriteUrl` before every
`onRequest` hook. The limiter therefore sees the rewritten path, which does not
match the `/api/deals` prefix, so join — and `publish`, `close_joining`,
`reopen_joining`, `prepare_charging`, `cancel`, plus the `/api/deals` listing —
are classified `none`. The classifier itself is correct: given the `/api` form it
returns `sensitive`. It never sees it.

**Not fixed here, deliberately.** Every fix that puts join into the sensitive
bucket applies a **20/min per-IP** limit to it, and a shared NAT — a school, an
office, a mobile carrier — is one IP for hundreds of legitimate buyers. A deal
that goes viral inside one organisation is precisely the case the product wants
to succeed. Throttling that is a product and identity decision, not a patch, so
the current behaviour is **pinned by test** instead: the suite asserts today's
buckets exactly, so a change in either direction fails loudly and gets reviewed.

**Why the gap is survivable today.** Join is not unprotected, it is protected by
something other than the IP bucket, and the suite asserts each of these still
exists in the handler: a per-`buyer+deal+idempotency-key` advisory lock, a
`SELECT … FOR UPDATE` on the deal row, an idempotency record, and the
`max_units_exceeded` ceiling — the last two proven behaviourally in the Phase 10
capacity race (14 concurrent joins → exactly 5 accepted). The global 200/min
per-IP bucket also still applies to every request including join. If any of those
guards moves, the missing bucket stops being an acceptable trade and the test
says so.

**Proposed design, for an owner decision.** Limit join by **identity, not by
address**: a bucket keyed on `(deal_id, buyer_id)` — say 5/min, 20/hour — plus
the existing per-IP *global* bucket left as-is. That throttles the actual abuse
shape (one buyer hammering one deal, or rotating idempotency keys against it)
while a hundred distinct buyers behind one NAT are unaffected, because they are a
hundred distinct identities. It needs a decision on what counts as buyer identity
before an OTP is verified, which is why it is written down here rather than
implemented.

## SOAK / CHAOS RESULT

`tests/synthetic_soak_authority_validation.ts`, 5/5. Every other suite probes one
behaviour with a clean start. A soak asks whether the system stays correct while
it is *busy*, and whether anything drifts once the same code runs thousands of
times rather than once — connection leaks, unhandled rejections, duplicated
durable effects and stuck work only appear under sustained mixed load.

Deliberately **realistic** concurrency, not resource exhaustion: the point is to
find drift, not to prove a laptop can be overwhelmed. Local and disposable only —
no third-party service, no provider call, no money: joins are synthetic buyers
with pre-verified OTP challenges against the fake adapter, notifications are
log-only.

**Run of record — 30 s, 12 virtual users (4 anonymous readers, 3 seller readers,
2 buyer joiners, 2 inquiry senders, 1 outbox drainer):**

| Measure | Result |
|---|---|
| Requests | 11,843 (~395/s) |
| Status | 9,477 × 2xx, 2,366 × 4xx |
| 5xx | **0** |
| Transport errors | **0** |
| Unhandled promise rejections | **0** |
| Unexplained 429 | **0** (1,750 were the documented inquiry spam caps engaging) |
| Joins accepted | 160 = exactly 4 deals × `max_units` 40 — **no oversell under load** |
| Duplicate durable effects | **0** — accepted joins equal participant rows exactly |
| Outbox events left claimed | **0** |
| Connections idle-in-transaction > 30 s | **0** |
| DB connections | 1 → 12 (the pool ceiling, not unbounded growth) |

Two guards make these numbers mean something:

**The vacuity guard is per-path, not global.** The first version of this file ran
a whole soak with `inquiries 0` — the payload used the wrong field names — and a
guard that only checked joins reported a healthy soak that had never touched the
inquiry rail. Each write path is now asserted separately.

**429s are classified, not counted.** The per-IP limiter is disabled for this run,
so an initial "any 429 is an anomaly" assertion flagged the inquiry rail's
DB-backed spam caps — a deliberate P0.7 protection — as a defect. The suite now
separates a documented product cap from an unexplained throttle, and asserts
**both** directions: no unexplained 429, *and* the spam caps must actually engage
under this much load, because a protection that never fires may be inert.

**Memory, stated honestly.** Heap grew from ~31 MB to ~95 MB across 11,843
requests. That is within normal allocator behaviour for a Node process under load
with no forced collection, and is **not** evidence of a leak — but neither is it
proof of its absence. A definitive leak measurement needs `--expose-gc` and a
much longer run, which is outside this bounded budget. Recorded as an
observation, not a clean bill of health.

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
| Rate limit / abuse boundary | **PASS with 1 OPEN** — classifier correct; the join alias gap is pinned by test and left for an owner decision |
| Input / query / error surface | **PASS after fix** — 1 finding (V5); 0 faults across 5,781 probes, no internal detail in any error body |
| DB authority / invariants | **PASS** — 0 findings; schema backs the bounds and FKs, and the capacity guard holds under real concurrency |
| Observability / forensic truth | **PASS after fix** — 2 findings (V6, V7); no secret in any log line, and evidence sufficient to reconstruct a refusal |
| Secret / config / fail-closed | **PASS** — pre-existing guards verified; control-byte gate added |
| Soak / chaos | **PASS** — 11,843 requests in 30s: 0 × 5xx, 0 unhandled rejections, 0 duplicate effects, no oversell |

---

## OPEN ITEMS

Nothing below was left open by accident. Each is either an owner decision or a
provider dependency, and each says what it would take to close.

### OPEN P1

**Join is outside the rate-limit mutation bucket** — pinned by test, not patched.
Full reasoning in the rate-limit section: every fix that buckets join applies a
20/min **per-IP** limit, and a shared NAT is one IP for hundreds of legitimate
buyers, so it is a product and identity decision rather than a patch. Proposed
design: limit by identity, keyed on `(deal_id, buyer_id)`. **To close:** decide
what counts as buyer identity before an OTP is verified.

**Real external e-mail delivery: PROVIDER REQUIRED.** The repository has exactly
one notification adapter (`LogNotificationProvider`); real mode cannot boot. The
inquiry pointer event is created, addressed, rendered and queued — that much is
proven — but **no e-mail reaches anyone and none is claimed anywhere in this
audit**. **To close:** an owner decision on a provider, then a wiring task.

### OPEN P2

**The inquiry access token lives in a query string.** V6 stopped it reaching the
application log, which was the acute problem. The token still travels as `?t=` and
therefore also reaches browser history, `Referer` headers and any intermediary
proxy log. **To close:** move it to a header or a short-lived exchange — an
API change, because existing buyer links carry `?t=`.

**`POST /api/affiliate/links/visit` answers `recorded: true|false`**, which
distinguishes a live share code from a dead one. Source codes are handed to
anonymous buyers by design, so this is a weak oracle over semi-public data rather
than a leak. **To close:** answer identically either way, if the analytics
pipeline does not need the distinction.

**Static guard detection is heuristic.** A new guard helper must be added to
`GUARD_PATTERNS` or the static gate fails closed — loudly, which is the intended
direction, but it is a maintenance cost worth stating.

**A retried seller inquiry reply stores a second message.** Same `x-request-id`,
same body. Inquiry *creation* dedupes within its 10-minute window; replies do
not. Not a security issue, and a seller may legitimately send the same text
twice, so it is documented rather than "fixed" by imposing idempotency the
product never asked for. The suite pins current behaviour so a change is visible.

**Memory under sustained load is an observation, not a clean bill.** Heap grew
~31 MB → ~95 MB over 11,843 requests with no forced collection. Within normal
Node allocator behaviour; not evidence of a leak, and not proof of its absence.
**To close:** an `--expose-gc` run over a much longer window.

### Environment note (not a repository defect)

`npm run ci:migrations` fails on the development machine used for this audit with
`checksum mismatch: 045`. That is the long-lived local database's ledger, not the
repository: no commit on this branch touches `src/migrations/`, and 045 is
byte-identical to HEAD. Proven directly on a brand-new database — **fresh install
exit 0 (57 migrations), rerun exit 0, checksum mismatch false**. Every test group
also migrates a fresh database per file and all pass.

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
| `input_error_surface_authority_validation` | 6/6 (5,781 query probes, 123 GET routes) |
| `db_invariant_authority_validation` | 8/8 (schema backing + 14-way concurrent join race) |
| `forensic_logging_authority_validation` | 6/6 (real logger capture, secrets + evidence) |
| `rate_limit_classifier_authority_validation` | 6/6 (bucket classification + pinned alias gap) |
| `synthetic_soak_authority_validation` | 5/5 (11,843 requests, 12 virtual users, 30s) |

### Full repository suite, final run

| Group | Result |
|---|---|
| unit | 12/12 |
| integration | 29/29 |
| db | 6/6 |
| api | 41/41 |
| workers | 13/13 |
| payments | 29/29 |
| security | 31/31 |
| concurrency | 4/4 |
| failure | 9/9 |
| e2e | 13/13 |
| **Total** | **187/187 files, 10/10 groups, 0 failures** |

### Static gates

| Gate | Result |
|---|---|
| `npm run lint` — backend enforcement, direct-state-mutation, payment SDK boundary, secret scan, control-byte scan | PASS |
| `npm run gate:architecture` | PASS |
| `tsc -p tsconfig.test.json` | PASS |
| `npm run ci:route-authorization` | PASS (`UNGUARDED_PROTECTED_ROUTES=0`) |
| Migrations, fresh install + rerun on a brand-new database | PASS (57 migrations, no checksum mismatch) |
| `npm run ci:migrations` on the audit machine | FAILS — stale local ledger, not the repository; see the environment note |

A/B discipline: every fix in this document was proved by reverting it and
watching a test fail with the offending route named, then restoring it and
watching the test pass. No test in this branch asserts an implementation detail
back to itself.

---

## RECOMMENDED NEXT STEP

**Owner review of this branch, then a decision on the two P1 items.** The branch
is not merged and should not be merged without that review.

In priority order:

1. **Decide the join rate-limit policy.** It is the only remaining item where an
   attacker has a cheap action and the platform has no identity-shaped defence.
   The proposed `(deal_id, buyer_id)` bucket is written up and ready to build once
   "what is buyer identity before OTP" is answered.
2. **Decide the e-mail provider.** Everything up to delivery is built and proven;
   only the adapter is missing. Until then the product's buyer→seller
   notification is a pointer that nobody receives.
3. **Move the inquiry token out of the query string.** V6 closed the log leak;
   this closes browser history, `Referer` and proxy logs.
4. **Consider extending the enumerated-invariant pattern to the R9C branch.** The
   gates added here — live-router enumeration, vacuity guards, A/B negative
   controls — found seven real defects in code that already had 180 passing
   tests. The payment lifecycle is the part of this system where the same
   technique would be worth the most, and it is deliberately untouched here.
