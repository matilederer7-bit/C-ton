# System Red Team — 2026-09-18

Baseline reviewed: `d4855504455adb06970de3f881db053519558e12` (master, after the bilingual milestone).
Posture: attack first, fix only what was proven against a running system.
Real money executed: **0**. Provider credentials used: **0**. Production data destroyed: **0**.

This document records what was **proven**, and — equally — what was tried and found sound.
It deliberately does not say "everything is fine".

---

## §2.4 — The database boundary: no product defect, but the suite could not have found one

### What was measured

`src/*.ts` touches **81** real tables in `siton`. The canonical boundary suite asserts
privileges on **20** named tables, by hand. **112** test files open a database connection;
**6** ever mention a runtime role.

Every DB-touching suite reads one `DATABASE_URL` for **both** the application pool and its own
fixtures, and CI supplies the owning superuser there. So the suite cannot distinguish
"the Web runtime may do this" from "the owner may do this".

### The experiment

Two byte-identical databases were cloned from the CI database and given the full canonical
boundary (`supabase/staging/001`–`026`). The entire suite (257 files) was then run twice:
once as `postgres`, once on a connection whose `current_user` is `siton_web_runtime`
(via a LOGIN role with `ALTER ROLE … SET role`, exactly as production does it).

| | result |
|---|---|
| pass as owner, pass as runtime role | 155 |
| pass as owner, **fail** as runtime role | **46** |
| of those 46, failing with SQLSTATE 42501 | **38** |
| of those 38, failing inside **product code** | **0** |

Every one of the 38 fails inside the test's *own* fixture or cleanup code — `deleteByKey`,
`cleanupParticipant`, `cleanupKey` — writing to tables the Web runtime is correctly forbidden
from touching (`notification_events`, `invoice_documents`, `operational_recovery_audit`,
`otp_delivery_attempts`, `platform_fee_money_events`, …). Those are worker-owned tables and
the boundary is doing its job.

### Verdict

**No product privilege defect was found.** Separately, the real app was driven on a
production-shaped connection across **142 registered GET routes** plus the full seller deal
lifecycle: zero `42501`. The current grants are adequate for what was exercised.

But that is what *this experiment* proves, not what the test suite proves. A route that
started needing a grant it does not hold would be green in CI and 500 in production, and
nothing would say so.

### Fix

`tests/runtime_role_route_privilege_validation.ts` — an empirical gate, not a hand-maintained
list. It applies the canonical boundary, builds a LOGIN role that becomes `siton_web_runtime`,
asserts the app pool really is that non-superuser role, then drives the real route table and
the real lifecycle over it. No table list to keep in sync: a route that starts touching a new
table is covered the day it is written.

It also asserts the one column the boundary makes write-only — `seller_business_profiles.bank_account_number`
is not SELECTable by the Web runtime, while the masked `bank_account_last4` the seller UI
shows still is.

### The gate was itself red-teamed, and was weak

First version read response bodies for "permission denied". Driven with a deliberately
powerless role, it caught **1 of 142** routes: every other route correctly sanitises the
failure into `{"ok":false,"error":"internal_error"}`. Reading bodies is the wrong instrument.

The denial is now captured where it happens — a Fastify `onError` hook reading SQLSTATE
`42501` off the original error, which nothing downstream can hide. Same negative control:
**32 of 142**. The gate is kept honest by that negative control, not by its own green.

---

## §2.2 / §2.7 — Money inputs: four proven defects, one root cause

Every money column is `numeric(12,2)`. The route validators checked the raw JavaScript float
and then handed it to PostgreSQL, so **the value that passed validation and the value that got
stored were not the same number**. The guard and the storage disagreed, and the product took
the storage's side.

### M-1 — a refused price, reached through a different input (High)

```
price_per_unit: 0      ->  400 "price_per_unit must be a positive number"
price_per_unit: 0.001  ->  200, stored 0.00, PUBLISHED, publicly live
```

Reproduced end to end against a running server: create 200 → row `0.00` → publish 200,
state `PendingTarget` → `GET /api/deals/:id/public` live with `price_per_unit: 0`. The money
rail then computed gross 0, platform fee 0, seller net 0. The exact state the guard exists to
prevent, live on the site.

### M-2 — a NaN delivery cost that publishes and zeroes the fee (High)

`cost: "abc"` → `Math.max(0, Number("abc"))` is **NaN**, and `numeric` accepts `'NaN'`
verbatim. The deal published; `/api/deals/:id/public` showed the buyer `cost: null`; and
`calculatePlatformFeeMoney` turned the poisoned total into a well-formed snapshot of **zero**
through `Number(value) || 0` — no fee for Siton, no charge for the buyer, no error anywhere.

The create path was strictly weaker than the patch path, which already rejected a non-finite
cost.

### M-3 — an advertised saving of zero (Medium)

The validator's own comment says the regular price must be above the group price "otherwise
the shown saving would be a lie". `list_price_per_unit: 50.001` against `price_per_unit: 50`
stored **50.00 vs 50.00**.

### M-4 — leaked database errors as 500s (Medium)

`price_per_unit: 1e15` → `500 internal_error`, an unhandled `22003 numeric field overflow`
reaching the client. Same on delivery cost and list price. `min_units: 10.4` → `500`, an
unhandled `22P02 invalid input syntax for type integer` — while the draft-patch path already
answered 400.

### Fix

`src/money_input.ts` — one canonical reader that reads every client amount **as the column will
hold it**: round to the storage scale first, validate the rounded value, persist that same
rounded value. Wired into deal create, draft patch, delivery cost on both paths, and the
regular-price comparison. `readUnitCount` does the same for the integer unit columns.

`calculatePlatformFeeMoney` now **fails closed** on a non-finite amount instead of silently
settling at zero.

`0.01` remains a legal price: this is a boundary, not a ban on cheap deals.

Regression suite: `tests/platform_fee_money_input_boundary_validation.ts`, 9 checks.
**7 of them fail before the fix and pass after it.** One of the nine (the 90% target always
equalling `ceil(0.9 × stored min_units)`) passed both before and after — it is a guard-rail
pinning correct behaviour, not a bug fix, and is labelled as such.

---

## §2.15 — Bilingual layer: structurally clean, one real English defect

2454 keys in each dictionary. Attacked for missing keys, orphan keys, placeholder mismatch,
empty English, bidi control marks, key-echo and untranslated Hebrew:

- missing in English: **0**
- orphan English keys: **0**
- placeholder mismatches (`{name}` present in one language only): **0**
- empty English where Hebrew has content: **0**
- bidi control marks leaking into English: **0**

Two hits, one of them a false positive:

- `content_admin.content_language_he = "עברית"` in **both** dictionaries. This is **correct
  by design** — a language picker names each language in its own script, the same way the
  English option reads "English" in both. Recorded here so the next scanner run does not
  "fix" it.
- **12 keys interpolate a count into a hard-coded English plural** — `{qty} units` renders
  **"1 units"** at quantity 1, reachable from the pickup card whenever a buyer joins with a
  single unit. Hebrew has the mirror defect (`1 יחידות`). **Fixed**: a key may declare a
  singular under `<key>#one`, chosen when exactly one count is passed and it is 1. Counts
  arrive as locale-formatted STRINGS (`num()` returns `"1,234"`), so testing for a JavaScript
  number would have made the mechanism dead code. A sentence carrying two independent counts
  is split into two keys rather than given one variant, and a contract test enforces that.

---

## §2.5 — Cross-role escalation: attacked, found sound

Every registered `/api/admin/*` route was enumerated from the live router and probed with a
**valid, live seller session** — 71 endpoints across 68 routes, behind a vacuity guard proving
the session really worked on its own surface first. **Zero 2xx.** No escalation.

The existing suites cover the neighbouring cases well: `admin_route_auth_coverage_validation`
enumerates every admin route against an anonymous caller, and
`cross_principal_authorization_isolation_validation` covers seller-A-versus-seller-B IDOR
including the 403-versus-404 existence oracle. The one gap is coverage, not behaviour: that
file's admin-escalation probe uses **4 hand-listed paths** while its seller side is enumerated
from the live router, so a new admin route is covered against anonymous callers but not
against a valid seller session. Worth closing; no defect behind it.

## §2.8 — Concurrency: attacked, found sound

`tests/concurrency_proof.ts` was examined for the usual cheat (simulating concurrency in one
connection). It does not cheat: it runs 100 parallel joins with distinct buyers across **two
separate web app instances**, and 13 further `Promise.all` races. The join rail's concurrency
coverage is real. No defect found, and none manufactured to look productive.

---

## §2.12 — Hosted reality: one service has been failing to boot

`siton-demo-preview` (`srv-d77p6tgule4c73denj7g`) is the only hosted service that runs in
`demo-preview` mode, which is what makes unauthenticated deal creation — and therefore a
hosted test of the money-input guards — possible. It does not boot:

```
external storage runtime guard failed: APP_DEPLOYMENT_MODE=demo-preview
is a demo/preview mode and cannot run on a hosted deployment
    at assertProductionRuntimeGuards (src/production_guards.js:148)
```

and separately its database no longer resolves:

```
Error: getaddrinfo ENOTFOUND dpg-d77p6boule4c73denbjg-a
```

Neither is caused by this work, and the first is a **safety guard doing its job** — the
service is configured to run a mode the guard forbids hosting. It is recorded here, not
"fixed": the correct resolutions are to retire the service or to give it a non-demo
deployment mode and a live database, and both are owner decisions. Weakening
`production_guards.ts` to make a test pass would be exactly the move this review exists to
catch.

The consequence is stated plainly in the open list below: the money-input findings are
verified against a running server locally, in CI, and by the deployed SHA matching master —
but **not** by a hosted HTTP request.

## Still open

1. **Hosted verification of the money-input guards.** Verified against a running server
   locally (failing before the fix, passing after), by CI, and by the deployed SHA matching
   master — but not by a hosted HTTP request, because both hosted paths are blocked:
   staging runs `internal-runtime` and needs a seller session that was not provisioned, and
   `siton-demo-preview` does not boot (above). Owner action.
2. **The plural singulars are not observable on staging.** There are no live deals and no
   single-unit participants, so no count-bearing copy renders. Verified locally in a real
   browser and by direct rendering in both languages instead.
3. **Silent clamping of integral out-of-range unit counts** — `min_units: -5` still becomes
   `1` without an error. Deliberately preserved: it is long-standing behaviour the create
   defaults rely on, and changing it is a product decision, not a bug fix.
4. **Sections not attacked in this pass**, and therefore claiming nothing: §2.9 workers and
   outbox beyond what the suite already covers, §2.10 migrations, §2.13 Supabase and §2.14
   general security.

## Activation consequence

Nothing here changes payment activation. `REAL_MONEY_ALLOWED` remains `false` and Grow live
remains off. No file touched by this work overlaps the open payments red-team branch.
