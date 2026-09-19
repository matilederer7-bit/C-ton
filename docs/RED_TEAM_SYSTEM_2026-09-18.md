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

## §2.6 — PII in public responses: one real consent defect

A deal was published with a real participant carrying distinctive canary values (name,
phone, e-mail, address, notes), and every registered public GET route was then swept
unauthenticated — 284 requests, 126 of which returned 2xx — grepping each body for those
canaries and for secret-shaped fields (`*_token_hash`, `*_secret_hash`, `password_hash`,
`bank_account_number`, `access_code`, …).

**No secret-shaped field was returned anywhere, and no phone, e-mail, address or note
leaked to an unauthenticated caller.**

Two classes of hit needed separating before any of it could be called a finding:

*Not findings.* The `/api/admin/*` hits were an artifact of the probe's own configuration:
it never set `ADMIN_API_KEY`, so the admin surface was unguarded by construction.
`admin_route_auth_coverage_validation` already proves every registered admin route refuses
an anonymous caller when that key is configured. Likewise `/api/seller/analytics` returned
the caller's *own* workspace under demo-preview's auto-provisioning, and
`/api/participants/:id/tracking` showed a buyer their own record.

*A real finding.* `siton.participants.public_name_opt_in` is an explicit consent flag — the
buyer decides whether their name may be shown publicly. Two unauthenticated endpoints
publish buyer names for the same deal, and only one honoured it:

```
GET /api/deals/:id/public-names -> {"names":["דנה"]}      gated on the flag, correct
GET /api/deals/:id/activity     -> ["רותי","דנה"]         ignored it
```

רותי had set `public_name_opt_in = false` and her first name was still broadcast on the
public deal page. First-name-only (`split_part(buyer_name, ' ', 1)`, with a `משתתף`
fallback) is real minimisation and someone clearly thought about it — but a recorded consent
choice is not a formatting preference, and the codebase already has the flag and already
enforces it one endpoint over.

**Fix.** The activity feed resolves the first name only when the buyer consented. The join
itself is **not** hidden — it still appears as `משתתף` with its real quantity — so the feed,
the participant count and the unit count all stay truthful. Consent hides a name, not an
event.

`tests/buyer_public_name_consent_validation.ts`, 3 checks, **all three failing before the fix
and passing after**, including one that asserts the two public surfaces agree with each other
in both directions so they cannot drift apart again.

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

## §2.9 — The worker runtime role: attacked, found sound

The merged gate covers the Web role. The worker was attacked the same way: a scratch clone
with the full canonical boundary, a LOGIN role that becomes `siton_worker_runtime`, and then
the **real** worker entry points from `src/app.ts` (`assertWorkerDatabaseReady`,
`reclaimWorkerJobs`, `claimPendingOutboxBatch`, `processClaimedOutboxEvent`,
`runWorkerMaintenance`) driven over that connection.

Result: jobs claimed and processed — real notification dispatch — with **zero 42501**.

One detour worth recording, because the first run looked like a finding and was not.
`assertWorkerDatabaseReady` reported *"schema drift: missing tables seller_sessions,
distributor_sessions, support_tickets, deal_delivery_options, deal_images,
deal_chat_messages"*. Those tables exist; the worker role simply holds no grants on them,
and `information_schema.tables` is **privilege-filtered**, so it conflates "absent" with
"not granted". Live staging confirms the worker cannot SELECT any of them — correctly, they
are web-owned.

That distinction is already handled deliberately: `queryRequiredTables` switches to
`to_regclass('siton.%I')`, which reports existence regardless of privilege, when
`CANONICAL_POSTGRES_RUNTIME=1` — and `render.yaml` sets that for **both** the web and worker
services. The probe simply had not set it. With the production flag set, the readiness check
passes and the whole cycle runs clean. No defect; a good design someone already got right.

## §2.10 — Migrations: attacked, found sound (and the first reading was wrong)

Ledger on live staging: **65 rows, max position 65, high-water `072`, zero not-succeeded** —
matching the 65 files on disk exactly. No drift. The red-team chain added no migration.

24 of the 65 files carry no explicit `BEGIN`, and `scripts/run_migrations.cjs` wraps nothing
itself: it inserts a `running` ledger row, runs `client.query(sql)`, and on error issues a
`ROLLBACK` that looks like a no-op. That reads like partial application — earlier statements
committed while the ledger says `failed`.

It was tested rather than assumed, and the reading was wrong. PostgreSQL's **simple query
protocol wraps a multi-statement string in one implicit transaction**, so a failure mid-file
rolls the whole file back:

```
CREATE TABLE probe_first  (id int);
CREATE TABLE probe_second (id int);
SELECT 1/0;                      -- 22012
-> tables surviving: []
```

No defect. Worth noting only that the safety is **implicit**: it depends on the whole file
going through one `query()` call on the simple protocol. Splitting migrations into
per-statement execution, or moving to the extended protocol, would silently remove it and no
test would notice.

## §2.13 / §2.14 — Supabase advisors: one hygiene item, no exploitable finding

Three advisor classes on the live staging project, each checked rather than relayed:

**`rls_enabled_no_policy` (INFO, 5 tables in `siton_inventory`).** RLS on with no policies is
**fail-closed**, not open: nobody but the owner reads those tables. `anon` and `authenticated`
hold zero grants on any `siton` table and zero tables lack RLS. Not a defect.

**`function_search_path_mutable` (WARN, 5 functions).** Real as hygiene, and notable because
`005_fix_siton_function_search_paths.sql` exists precisely to pin these — so these five
drifted or arrived later. It is **not exploitable**: all five are `SECURITY INVOKER`
(`prosecdef = false`), so there is no owner privilege to escalate to, and their bodies
reference **no database objects at all** — they are pure logic over their arguments and
`OLD`/`NEW`, so a hostile `search_path` has no unqualified name to capture.

Remediation, deliberately **not** applied in this pass: `ALTER FUNCTION siton.<name>(...) SET
search_path = pg_catalog, siton` for `is_valid_action_name`, `is_valid_deal_transition`,
`is_valid_money_transition`, `deal_field_change_audit_append_only` and
`prevent_published_deal_product_snapshot_change`, shipped as a migration. The next migration
number is claimed by the open payments branch (`073_payment_authorization_create_idempotency`),
which also edits `scripts/migration_manifest.cjs`; taking `074` now would put a textual
conflict into that file for a non-exploitable hygiene item. It should land once that PR merges.

**`auth_leaked_password_protection` (WARN).** Supabase Auth's HaveIBeenPwned check is off.
Siton runs its own seller/admin/buyer session rails, so this governs a surface the product
does not authenticate through; enabling it is free and harmless, and it is an owner setting,
not a code change.

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
4. **Function `search_path` pinning** — five `siton` functions, proven non-exploitable
   above, with the exact remediation recorded. Held back only to avoid a migration-number
   and manifest conflict with the open payments branch.
5. **Sections not attacked in this pass**, and therefore claiming nothing: §2.3 integration
   depth beyond the existing suite, §2.7 payments (deliberately untouched — the open
   payments red-team branch owns that ground), and §2.11 browser UX beyond the bilingual
   surfaces.

## Activation consequence

Nothing here changes payment activation. `REAL_MONEY_ALLOWED` remains `false` and Grow live
remains off. No file touched by this work overlaps the open payments red-team branch.
