# Production Data Access Boundaries

Status: one section per principal that can touch Siton (C-ton) data in the
hosted topology (Render web + worker, Supabase Postgres via the Supavisor
session pooler, Supabase Storage via the `storage-broker` Edge Function,
GitHub Actions CI). Every claim is marked IMPLEMENTED (enforced by code, SQL
or a checked-in gate, cited), EXPECTED (required by the design, enforced only
by procedure or a hosted console) or OPEN (not implemented; a gap). Hosted
steps are "hosted action - document only, not executed".

Companion: [SECURITY_INCIDENT_RUNBOOK.md](SECURITY_INCIDENT_RUNBOOK.md)
(rotation implications and scenarios),
[ENVIRONMENT_CONTRACT.md](ENVIRONMENT_CONTRACT.md) (variable catalogue),
[ARCHITECTURE_REBASE_R2_CANONICAL_POSTGRES.md](ARCHITECTURE_REBASE_R2_CANONICAL_POSTGRES.md),
[R2_RUNTIME_PERMISSION_AUDIT.md](R2_RUNTIME_PERMISSION_AUDIT.md) (operation-level
grant matrix), [ARCHITECTURE_REBASE_R3_RENDER_WEB.md](ARCHITECTURE_REBASE_R3_RENDER_WEB.md),
[ARCHITECTURE_REBASE_R4_WORKER.md](ARCHITECTURE_REBASE_R4_WORKER.md),
[ADMIN_IDENTITY_RBAC_MFA.md](ADMIN_IDENTITY_RBAC_MFA.md).

## 0. Topology in one table

| Layer | Identity | Where the credential lives | Gate that proves the boundary |
|---|---|---|---|
| Web process | `siton_web_login` -> `SET ROLE siton_web_runtime` | Render `siton-staging-web` `DATABASE_URL` (`sync: false`, `render.yaml:33-34`) | `assertCanonicalRuntimeReady(pool,"web")` at boot and on `/readiness` (`src/app.ts:5786-5787`, `:3572-3578`) |
| Worker process | `siton_worker_login` -> `SET ROLE siton_worker_runtime` | Render `siton-staging-worker` `DATABASE_URL` (`render.yaml:87-88`) | same assertion for `"worker"` (`src/app.ts:3131`); `RUNTIME_ROLE` mismatch fails boot (`src/production_guards.ts:102-103`) |
| Schema owner / migrations | `postgres` (Supabase project owner) | Supabase dashboard / management channel only | never an application credential: refused at runtime (`src/runtime_database_boundary.ts:36-38`) and by policy (`config/runtime-environment-policy.json` staging/production `DATABASE_URL not_matches ^postgres://postgres:`) |
| Storage mutation | `service_role` inside the Edge Function | Supabase-injected `SUPABASE_SERVICE_ROLE_KEY` in the function runtime only (`supabase/functions/storage-broker/index.ts:26-30`) | `SUPABASE_SERVICE_ROLE_KEY must absent` for every app target (`config/runtime-environment-policy.json`) |
| Browser | anonymous, buyer tokens, seller/admin/distributor sessions, Supabase Auth JWT | HttpOnly cookies; publishable anon key only | route policy (`scripts/protected_route_policy.cjs`), SQL revokes for `anon`/`authenticated` (`supabase/staging/003_browser_fail_closed.sql:6-9`) |
| CI | GitHub Actions runner | none for hosted systems; local service Postgres | workflows use `postgresql://postgres:postgres@127.0.0.1` (`.github/workflows/backend-quality-gates.yml:41`) |

## 1. Web runtime role (`siton_web_runtime` via `siton_web_login`)

| Aspect | Truth | Marker |
|---|---|---|
| Identity | LOGIN principal `siton_web_login` (NOINHERIT, no direct privileges) that may only `SET ROLE` into the NOLOGIN profile `siton_web_runtime`; every session adopts it server-side via `ALTER ROLE ... SET role` so `current_user` is always the profile, pooler-safe (`supabase/staging/010_r3_web_login_provisioning.sql:13`, `:37`, `:43`, `:103-110`) | IMPLEMENTED |
| May read | the web SELECT list: deals, participants, sessions (admin/seller/buyer/distributor), OTP tables, payment attempts, invoices, outbox, notification events, audit, storage cleanup/orphan reports, migration ledger, worker heartbeats, ... (`supabase/staging/006_canonical_postgres_runtime_boundary.sql:97-112`) with permissive `r2_web_*` RLS policies scoped to this role (`:163-167`) | IMPLEMENTED |
| May write | web INSERT list (`:113-126`), UPDATE list (`:127-135`), DELETE only `deal_delivery_options`, `deal_images` (`:136`); sequences for OTP delivery attempts and recovery audit (`:54-57`); `EXECUTE public.siton_inventory_rpc(text,jsonb)` (`:207-208`) plus seven non-mutating trigger helpers (`008_runtime_trigger_helper_execute.sql`) | IMPLEMENTED |
| Must never | DDL (runtime code never issues DDL: `npm run scan:runtime-ddl`, `scripts/runtime_ddl_scan.cjs:3`); own or alter a schema; read `siton_inventory` tables directly (`:38-41`); delete `outbox_events` (worker-only, `:161`); insert worker-only money/payout rows (`seller_payout_*`, `seller_settlements` are absent from the web lists); hold `SUPERUSER`/`BYPASSRLS`/`LOGIN` on the profile (`:21-32`) | IMPLEMENTED (live negative proofs recorded in `docs/ARCHITECTURE_REBASE_R2_CANONICAL_POSTGRES.md:78-91`) |
| Storage | via the broker only: `x-siton-broker-key` header (`src/storage_adapter.ts:141`); public CDN URL for published imagery (`:209-211`); Draft imagery through the authenticated `/api/deal-images/:id` proxy (`docs/ENVIRONMENT_CONTRACT.md:174`) | IMPLEMENTED |
| Other secrets it holds | `ADMIN_API_KEY`, `SELLER_SESSION_SECRET` (Render-generated, `render.yaml:35-38`), `SITON_STORAGE_BROKER_KEY` (`:50-51`), `PAYMENT_WEBHOOK_SECRET` (production web only, `src/production_guards.ts:136`), optional `OTP_TOKEN_SECRET`/`OTP_HASH_SALT`/`BUYER_SESSION_SECRET`/`DISTRIBUTOR_SESSION_SECRET`, `SUPABASE_ANON_KEY` (publishable) | IMPLEMENTED consumers; OPEN: the optional ones are not declared in `render.yaml` |
| Never holds | `SUPABASE_SERVICE_ROLE_KEY`, the `postgres` password, the worker `DATABASE_URL` (`render.yaml:65-70`) | IMPLEMENTED (gate) / EXPECTED (dashboard discipline) |
| Where the secret lives | Render dashboard only (`sync: false`); password set by `ALTER ROLE siton_web_login PASSWORD` outside Git (`docs/ARCHITECTURE_REBASE_R3_RENDER_WEB.md:149-155`) | EXPECTED |
| Rotation | set new password (hosted) -> update Render `DATABASE_URL` (hosted) -> restart -> `/readiness` 200 with `runtime_role: siton_web_runtime` (`src/runtime_database_boundary.ts:45-51`) -> `scripts/r3_hosted_proof.cjs` with `R3_WEB_DATABASE_URL` from an operator machine. Web sessions of buyers/sellers/admins are unaffected (they hash against app secrets, not the DB password). | EXPECTED |
| Observability | pool `application_name = siton-web-runtime` (`src/db.ts:8-17`, `:38-40`) so foreign sessions under the login are visible in `pg_stat_activity` | IMPLEMENTED |

## 2. Worker runtime role (`siton_worker_runtime` via `siton_worker_login`)

| Aspect | Truth | Marker |
|---|---|---|
| Identity | exactly symmetric to the web login: `siton_worker_login` LOGIN NOINHERIT, SET-only membership, `SET role = siton_worker_runtime`, zero direct table privileges, must not hold the web profile and vice versa (`supabase/staging/011_r4_worker_login_provisioning.sql:18`, `:42`, `:49`, `:76-96`, `:120-127`) | IMPLEMENTED |
| May read | queue, money, invoice, payout, recovery and readiness tables only (`006:139-147`) | IMPLEMENTED |
| May write | INSERT (`:148-154`) / UPDATE (`:155-160`) on outbox, notifications, payment attempts, fee events, payouts, settlements, storage cleanup tasks, heartbeats; DELETE only `outbox_events` (`:161`); notification/recovery sequences (`:59-62`); inventory RPC (`:207-208`) | IMPLEMENTED |
| Must never | insert deals/participants/sessions (web-only lists); read seller sessions or OTP tables; DDL; direct inventory table access; run inside the web process (`DISABLE_OUTBOX_WORKER=1` required on web, `src/production_guards.ts:137`; policy `staging`/`production` rules) | IMPLEMENTED (live denials in `docs/ARCHITECTURE_REBASE_R2_CANONICAL_POSTGRES.md:92-99`) |
| Storage | same broker identity as web (asynchronous cleanup must reach the same bucket, `render.yaml:93-94`) | IMPLEMENTED |
| Where the secret lives | Render `siton-staging-worker` `DATABASE_URL` (`render.yaml:87-88`); never reuses the web credential (`:65-70`) | EXPECTED |
| Rotation | as for web; outbox processing pauses until the restarted worker writes a fresh `siton.worker_heartbeats` row (`src/worker.ts:36`) | EXPECTED |
| Boot guard | `assertProductionRuntimeGuards("worker")` (`src/worker.ts:92`) then `assertCanonicalRuntimeReady(pool,"worker")` (`src/app.ts:3131`); a web `DATABASE_URL` pasted on the worker fails closed with `canonical runtime role mismatch` (`src/runtime_database_boundary.ts:33-35`) | IMPLEMENTED |

## 3. Migration / admin role (`postgres` project owner)

| Aspect | Truth | Marker |
|---|---|---|
| Identity | Supabase project owner `postgres` (not SUPERUSER on Supabase; owns schemas `siton` and `siton_inventory`); holds SET-only, non-inheriting membership in both runtime profiles for proofs (`supabase/staging/007_runtime_role_admin_set_proof.sql:9-10`, `:19-28`) | IMPLEMENTED |
| May do | apply `supabase/staging/*.sql` (roles, grants, RLS, bucket policy) and `src/migrations/*.sql` (application schema via the ledgered runner, `scripts/run_migrations.cjs:47-50`) through the management channel; PITR/backup; role password resets (`ALTER ROLE ... PASSWORD`) | EXPECTED (hosted action - document only) |
| Must never | be the `DATABASE_URL` of any application runtime: refused at readiness for `postgres`, `supabase_admin`, `service_role` (`src/runtime_database_boundary.ts:36-38`) and by the env gate (`DATABASE_URL not_matches ^postgres://postgres:`); appear in CI against hosted systems (CI only ever uses local service Postgres) | IMPLEMENTED |
| Where the secret lives | Supabase dashboard (database password) and the operator's authenticated Supabase session / MCP channel; never Git (`npm run scan:secrets` detector `database-url-credential` rejects any non-local `postgres://user:pass@host`) | IMPLEMENTED detection, EXPECTED custody |
| Rotation | Supabase dashboard database-password reset (hosted action - document only, not executed). No Render env depends on it. Re-run `010`/`011` safety blocks afterwards to confirm memberships are intact (idempotent) | EXPECTED |
| Audit | migration history in `siton.migration_ledger` (checksums, LF-normalised, `scripts/run_migrations.cjs:14-19`); `siton.infrastructure_change_audit` for runtime-driven infra changes (`src/frontend_runtime.ts:7783`); Supabase project logs (hosted) | IMPLEMENTED / EXPECTED |
| Repository proofs | `npm run migrations:preflight`, `npm run ci:migrations`, `npm run db:backup-restore-rehearsal` run on disposable LOCAL databases only (`scripts/db_backup_restore_rehearsal.cjs:1-20`) | IMPLEMENTED |

## 4. Service role (`service_role`, storage broker)

| Aspect | Truth | Marker |
|---|---|---|
| Identity | Supabase `service_role` (RLS bypass) used by the `storage-broker` Edge Function's Supabase client; the key is injected by the platform and read from `Deno.env`, never echoed (`supabase/functions/storage-broker/index.ts:10-11`, `:26-30`) | IMPLEMENTED |
| May do (through the broker) | `put` (no overwrite, size <= 2 MiB, jpeg/png/webp, checksum verified, HEAD-verified after upload), `head`, `get`, idempotent `delete`, bounded `list`; ONE bucket `deal-images`; keys re-validated against traversal (`index.ts:20-24`, `:52-69`, `:144-212`) | IMPLEMENTED |
| Caller authentication | `verify_jwt` disabled; every request must carry `x-siton-broker-key` whose SHA-256 must equal the pinned digest, timing-safe (`index.ts:21`, `:45-50`, `:129-133`) | IMPLEMENTED |
| Latent authority (not used) | the raw key could also call `public.siton_inventory_rpc` (`supabase/staging/001_siton_inventory_v1.sql:769`) and bypass RLS on any table it has grants for; a Supabase-issued `service_role` JWT is rejected as an end-user token by the app (`src/supabase_auth.ts:153-156`) | IMPLEMENTED (app side); EXPECTED (no other consumer exists) |
| Must never | leave the function runtime; appear in Render, CI, browser, Git (`config/runtime-environment-policy.json` every target; `scripts/secret_pii_scan.cjs` detectors `supabase-service-role-jwt`, `supabase-secret-key`) | IMPLEMENTED |
| Where the secret lives | Supabase project secrets (platform-managed) | EXPECTED |
| Rotation | service-role key: Supabase dashboard (hosted action - document only, not executed); broker key: new random value -> new digest in `index.ts:21` -> function redeploy (hosted) -> update `SITON_STORAGE_BROKER_KEY` on both Render services (`docs/ENVIRONMENT_CONTRACT.md:174`) | EXPECTED |
| Public read path | bucket `deal-images` is `public = true` (`supabase/staging/015_r7_supabase_storage_public_read.sql:14-16`); object keys are system-generated UUID paths, never filenames/PII; `storage.objects` carries no client mutation policies (`:6-10`) | IMPLEMENTED |

## 5. Browser / client (React `web/`, legacy `frontend/`, mobile shells)

| Aspect | Truth | Marker |
|---|---|---|
| Holds | no secret. `SUPABASE_URL` + publishable anon key are fetched from `GET /api/preview/auth-config` (`src/frontend_runtime.ts:1887-1897`; consumed in `web/src/session.ts:109-115`, `web/src/api.ts:211-220`) and used only for Supabase Auth calls (`apikey` header) | IMPLEMENTED |
| May read | `public-read` routes (published deal data, public names, receipt info, mall/site content, public sellers, content assets, deal images) and the app shell (`config/route-classification.json` rules) | IMPLEMENTED |
| May write anonymously | the deliberate `public-write` set: mall/viral events, support contact, deal inquiries/chat/feedback, chat reactions, inquiry messages (rate-limited, validated; `config/route-classification.json`) | IMPLEMENTED |
| With a buyer token | `buyer-token` routes: join, OTP start/verify, payments authorize/status/tokenize, participant tracking/recovery/impact/entitlement/public-name, buyer resume/logout, `/app/track|recovery` (`config/route-classification.json`); tokens are random, hash-only persisted, bounded TTL (`src/participant_tracking_security.ts:19-25`, `:5`; `src/buyer_session.ts:7`, `:23-28`; `src/otp_rail.ts:29`) | IMPLEMENTED |
| With a session | seller / distributor / admin cookies (`HttpOnly; SameSite=Lax; Secure` in production-like; `src/seller_auth.ts:206-212`, `src/distributor_identity.ts:32-34`, `src/admin_identity.ts:119-129`) or a Supabase Auth bearer verified against the project JWKS with `role=authenticated` only (`src/supabase_auth.ts:153-156`, `:223-232`); authority comes from `auth_user_id` bindings in Postgres, never from JWT claims (`src/actor_resolver.ts:90-100`) | IMPLEMENTED |
| Must never | reach Postgres or Storage directly: `anon`/`authenticated` have no privileges on `siton`/`siton_inventory` or the RPC (`003_browser_fail_closed.sql:6-13`, `006:210-214`, `009_runtime_function_public_fail_closed.sql`); no client policies on `storage.objects` (`015:6-8`); RLS enabled on every `siton` table (`003:16-30`) | IMPLEMENTED |
| Must never see | env values (no admin/mission-control endpoint returns them, `docs/ENVIRONMENT_CONTRACT.md` "Mission Control posture"); stack traces (`npm run smoke:http-security`); seller email on the public deal payload (P0.7 inquiries rail) | IMPLEMENTED |
| Rotation | nothing to rotate client-side; a rotated anon key propagates on next `auth-config` fetch; a rotated session secret logs everyone of that class out (see runbook section 4) | IMPLEMENTED |
| Gate | `npm run report:routes` (all 213 routes classified, 0 unguarded protected) and `npm run ci:route-authorization` (behavioural refusal) | IMPLEMENTED |

## 6. Supabase (platform)

| Aspect | Truth | Marker |
|---|---|---|
| Owns | Postgres (`siton-staging`, eu-central-1), Supavisor pooler, Storage bucket `deal-images`, Auth (JWKS at `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, `src/supabase_auth.ts:228`), the `storage-broker` Edge Function and its service-role secret | IMPLEMENTED (topology per `render.yaml:1-13`, `:44-47`) |
| Platform principals | `postgres` owner, `supabase_admin`, `service_role`, `anon`, `authenticated`; the application refuses to run as the first three (`src/runtime_database_boundary.ts:36-38`) and strips the last two of every canonical privilege (`003`, `006:210-214`) | IMPLEMENTED |
| Data it can see | everything (platform operator). Backups/PITR and log retention are platform features (hosted). Encryption at rest is a platform property. | EXPECTED (hosted) |
| Must never be given | application-level authority by role grant: `010`/`011` assert the login roles hold no worker/web cross-membership and no direct table grants; `007` asserts `postgres` does not inherit runtime privileges | IMPLEMENTED |
| Dashboard access | owner account. `SITON_OWNER_EMAIL` auto-binds a VERIFIED Supabase Auth user with that email to a SuperAdmin row on first admin contact (`src/admin_identity.ts:197-220`) - so the Supabase Auth email of the owner is a high-value identity | IMPLEMENTED; OPEN (owner dashboard MFA / Site URL discipline are console settings, not in repo) |
| Rotation levers (all hosted action - document only, not executed) | database password (owner), role passwords (`ALTER ROLE`), JWT secret / anon key / service-role key, Edge Function redeploy (broker digest), Auth user password resets | EXPECTED |
| Repository controls | `supabase/staging/*.sql` are the reproducible, secret-free structure (`010:1-8`); `verify_r1_foundation.sql` and the `DO` safety blocks abort on drift | IMPLEMENTED |
| Channel | Supabase MCP / SQL editor as the authenticated owner; requires interactive auth in this environment | EXPECTED |

## 7. Render (platform)

| Aspect | Truth | Marker |
|---|---|---|
| Owns | `siton-staging-web` (Docker, free plan, `/readiness` health check) and `siton-staging-worker` (Docker, starter, `npm run start:worker:prod`), both `branch: master`, `autoDeploy: true`, region frankfurt (`render.yaml:15-23`, `:71-79`) | IMPLEMENTED |
| Holds (per service) | `DATABASE_URL` (`sync: false`), `ADMIN_API_KEY` and `SELLER_SESSION_SECRET` (`generateValue: true`, never in Git), `SITON_STORAGE_BROKER_KEY` (`sync: false`), non-secret mode flags (`APP_DEPLOYMENT_MODE=staging`, `RUNTIME_ROLE`, `CANONICAL_POSTGRES_RUNTIME=1`, `STORAGE_ADAPTER=supabase`, `SUPABASE_URL`, mock/log-only providers) (`render.yaml:24-63`, `:80-116`) | IMPLEMENTED |
| Must never hold | `SUPABASE_SERVICE_ROLE_KEY` (policy FAIL), a `postgres://postgres:` URL (policy FAIL), live provider keys in staging (`PAYMENT_PROVIDER_API_KEY not_matches ^sk_live_`), debug/test seams (`DEBUG_SURFACES_ENABLED`, `OTP_TEST_BYPASS_CODE`, `MOCK_SEED`, `TRACKING_LEGACY_COMPAT`, `DEBUG_SQL_LOGGING`) - all `config/runtime-environment-policy.json` staging rules, evaluated against `render.yaml` by `npm run gate:runtime-env --render-service <name>` | IMPLEMENTED (gate); EXPECTED (dashboard values are not readable by the gate - "external secrets are marked, not verified", `scripts/runtime_environment_gate.cjs:12-13`) |
| Data it can see | process env, stdout/stderr logs (request logs carry method, redacted URL, host, remote IP; never env values or `DATABASE_URL`: `src/app.ts:3209-3228`, `docs/ARCHITECTURE_REBASE_R4_WORKER.md:145`), the Docker image (no `.env` inside: `Dockerfile:15`, `.dockerignore`) | IMPLEMENTED |
| Deploy trust | a push to `master` deploys; CI does not deploy. Rollback = redeploy previous image (hosted action). | IMPLEMENTED (config) / EXPECTED (procedure) |
| Rotation levers (hosted action - document only, not executed) | regenerate `generateValue` secrets, edit `sync: false` secrets, restart/redeploy, pause auto-deploy, purge logs | EXPECTED |
| Platform credential | Render dashboard account; optional API key `rnd_...` on an operator machine only (detector `render-api-key`). The Render MCP server in this environment requires interactive auth. | IMPLEMENTED detection; EXPECTED custody |

## 8. CI (GitHub Actions)

| Aspect | Truth | Marker |
|---|---|---|
| Workflows (tracked) | `backend-quality-gates.yml`, `web-runtime-depth.yml`, `stripe-sandbox-proof.yml`; all `permissions: contents: read`; `release-readiness.yml` is present but untracked in this worktree at time of writing | IMPLEMENTED / EXPECTED |
| Database | a disposable service container `postgresql://postgres:postgres@127.0.0.1:5432/siton_ci` (`backend-quality-gates.yml:41`); the `test` policy target FAILs any non-local `DATABASE_URL` and requires `RENDER` absent (`config/runtime-environment-policy.json` "test") | IMPLEMENTED |
| Hosted access | none. No Supabase, Render or broker credential is referenced by any workflow; nothing deploys from CI (Render pulls `master` itself) | IMPLEMENTED |
| Secrets it does hold | GitHub environment `stripe-sandbox` only, on manual `workflow_dispatch` with an explicit "Test Mode only" input: `STRIPE_SANDBOX_SECRET_KEY`, `STRIPE_SANDBOX_PUBLISHABLE_KEY`, `STRIPE_SANDBOX_WEBHOOK_SECRET` (`stripe-sandbox-proof.yml:4-15`, `:27`, `:34-36`, `:66-68`) | IMPLEMENTED |
| Must never | receive production/staging `DATABASE_URL`, `SITON_STORAGE_BROKER_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, live provider keys (`sk_live_` refused by the `test`/`development` targets and by `src/production_guards.ts:115`); write to the repository (`contents: read`) | IMPLEMENTED |
| Artifacts | `.ci-artifacts/` and `.release-artifacts/` reports contain route inventories and gate logs; gates are designed to print no secret values (`scripts/r3_hosted_proof.cjs:11`, `docs/ENVIRONMENT_CONTRACT.md` "Anti-patterns") | IMPLEMENTED; EXPECTED (artifact review before sharing) |
| Rotation | Stripe sandbox keys: Stripe dashboard + GitHub environment secret (hosted action - document only, not executed). Nothing else to rotate. | EXPECTED |
| Gate | `npm run scan:secrets` fails on any committed secret shape, tracked `.env`, or real PII in `src/`/`config/` (`scripts/secret_pii_scan.cjs:3-21`); `config/secret-scan-allowlist.json` is empty by design | IMPLEMENTED |

## 9. Access matrix

R = read, W = write, X = execute, `-` = no access, `pub` = public CDN read,
`bkr` = via broker only, `tok` = token/session-scoped through the API only.

| Principal | `siton` business tables | `siton_inventory` tables | `siton_inventory_rpc` | DDL / grants | Storage `deal-images` | Supabase Auth | Render env | Marker |
|---|---|---|---|---|---|---|---|---|
| Web runtime (`siton_web_runtime`) | R/W per web lists; DELETE 2 tables | - | X | - | bkr (+ pub) | verifies JWT via JWKS | reads own | IMPLEMENTED |
| Worker runtime (`siton_worker_runtime`) | R/W per worker lists; DELETE `outbox_events` | - | X | - | bkr | - | reads own | IMPLEMENTED |
| Migration/admin (`postgres`) | all (owner) | all (owner) | X | yes | via dashboard | dashboard | - | EXPECTED (hosted) |
| Service role (Edge Function) | latent (RLS bypass), unused | latent | X (granted) | - | R/W one bucket | - | - | IMPLEMENTED boundary |
| Browser / client | tok (API only) | - | - | - | pub | login only | - | IMPLEMENTED |
| Supabase platform | all | all | all | all | all | all | - | EXPECTED (hosted) |
| Render platform | - (holds `DATABASE_URL`) | - | - | - | - (holds broker key) | - | all | EXPECTED (hosted) |
| CI (GitHub Actions) | local disposable DB only | local only | local only | local only | - | - | - | IMPLEMENTED |

## 9a. Data classes and who may see them

Derived from the grant lists in `006`, the logging classification and the
route classification. "API" means only through the Fastify authorization
boundary; no principal below reaches these rows through Supabase clients.

| Data class | Canonical home | Web runtime | Worker runtime | Browser (anon) | Browser (buyer token) | Browser (seller session) | Browser (distributor) | Browser (admin) | Logs | Marker |
|---|---|---|---|---|---|---|---|---|---|---|
| Buyer PII (name, phone, email) | `siton.participants`, `siton.otp_challenges` (destination hash only) | R/W | R (participants in worker SELECT, `006:139-147`) | public names only via `/api/deals/:id/public-names` (`config/route-classification.json`) | own participant via tracking/recovery token | fulfillment fields for own deals | never (aggregate attribution only, `docs/INFORMATION_SECURITY_POLICY.md`) | API, audited | SENSITIVE: `buyer_phone`/`buyer_email`/`buyer_name` warn unless masked (`config/logging-data-classification.json:144-152`) | IMPLEMENTED |
| Card data (PAN, CVV, expiry) | nowhere (hosted fields / provider) | never | never | never | never | never | never | never | NEVER_LOG (`:5-27`); `npm run scan:payment` fails on raw-card terms in runtime code (`docs/PAYMENT_SECURITY_AND_PCI_SCOPE.md`) | IMPLEMENTED |
| Payment references (auth id, provider token, sealed Grow reference) | `siton.payment_attempts`, `siton.buyer_payment_methods` | R/W | R/W | never | only what the current operation needs (`docs/INFORMATION_SECURITY_POLICY.md` "Sensitive Endpoint Review") | never in exports | never | API, audited | `provider_reference` SENSITIVE (`:204`) | IMPLEMENTED |
| Money truth (fee events, settlements, payouts) | `siton.platform_fee_money_events`, `siton.seller_settlements`, `siton.seller_payout_*` | R fee events + insert; no settlement/payout writes | R/W (worker-only lists) | never | never | own settlement summary, `payout_details_masked` only (`src/frontend_runtime.ts:332-343`) | never | API (`payout.freeze` SuperAdmin) | amounts allowed, identifiers hashed | IMPLEMENTED |
| Credentials (session hashes, OTP hashes, MFA code hashes, seller scrypt secrets, admin scrypt passwords) | `*_sessions`, `otp_proofs`, `admin_mfa_challenges`, `seller_accounts`, `admin_users` | R/W (hash only) | never (absent from worker lists) | never | never | never | never | never returned | NEVER_LOG (`session_token`, `password_hash`, `otp_code`, ...) | IMPLEMENTED |
| Deal media | Storage bucket `deal-images` + `siton.deal_images` metadata | broker R/W | broker delete (cleanup) | published: public CDN; Draft: never | published only | own via authenticated proxy | published only | API | key paths only | IMPLEMENTED |
| Infra/audit evidence | `siton.audit_log`, `admin_actions`, `*_security_events`, `infrastructure_change_audit`, `migration_ledger` | R/W | R audit + migration ledger; W audit/recovery | never | never | never | never | R (`security.read`, `admin_actions.read`) | request ids only | IMPLEMENTED |
| Environment values | process env | reads | reads | never (`/api/preview/auth-config` publishes only URL + anon key) | never | never | never | never (Mission Control reports `configured: true/false`, `docs/ENVIRONMENT_CONTRACT.md`) | never (`DATABASE_URL` never logged) | IMPLEMENTED |

## 9b. Verification commands per principal

| Principal | Repository proof (local, no hosted access) | Hosted proof (network only; prints no secret) | Marker |
|---|---|---|---|
| Web runtime | `npm run check:health-contract`; `tests/canonical_postgres_runtime_boundary_validation.ts` (group `integration`: `npm run test:integration`) | `GET /readiness` -> `runtime_role: siton_web_runtime`; `node scripts/r3_hosted_proof.cjs --base-url=...` (+ `R3_WEB_DATABASE_URL` on an operator machine) | IMPLEMENTED |
| Worker runtime | `npm run check:health-contract` (boots the real worker, checks `worker_heartbeats`) | hosted SQL `SELECT worker_id, status, heartbeat_at FROM siton.worker_heartbeats ORDER BY heartbeat_at DESC LIMIT 5;` | IMPLEMENTED / EXPECTED |
| Migration/admin | `npm run migrations:preflight`, `npm run ci:migrations`, `npm run db:backup-restore-rehearsal` | re-run the `DO` safety blocks of `006`/`007`/`010`/`011` (idempotent, raise on drift) | IMPLEMENTED / EXPECTED |
| Service role | `npm run gate:runtime-env` (absent everywhere); `npm run scan:secrets` | seller Draft image upload returns 201 and the broker answers `verified: true` (`index.ts:175`); a request without `x-siton-broker-key` answers 401 | IMPLEMENTED / EXPECTED |
| Browser | `npm run report:routes`; `npm run ci:route-authorization`; `npm run smoke:http-security` | anonymous `GET /api/admin/mission-control` -> 401/503, never 200; `GET /debug/...` -> 404 | IMPLEMENTED |
| Supabase / Render | `npm run gate:runtime-env --render-service siton-staging-web` (static block of `render.yaml`) | console review of dashboard-only values (hosted action - document only) | IMPLEMENTED / EXPECTED |
| CI | `npm run scan:secrets`; `npm run check:repo-hygiene`; workflow `permissions: contents: read` | GitHub environment `stripe-sandbox` secret inventory (hosted action) | IMPLEMENTED / EXPECTED |

## 10. Open items

| Item | Impact | Marker |
|---|---|---|
| `OTP_HASH_SALT`, `OTP_TOKEN_SECRET`, `BUYER_SESSION_SECRET`, `DISTRIBUTOR_SESSION_SECRET` are not declared in `render.yaml`; staging runs on documented fallbacks (`src/otp_rail.ts:53-64`, `src/buyer_session.ts:9-13`); production policy FAILs without them | secret custody incomplete for two buyer/distributor rails | OPEN |
| Runtime does not fail closed on the OTP salt default, `TRACKING_LEGACY_COMPAT=1`, `DEBUG_SURFACES_ENABLED=1` in production (gate-only) | boundary relies on the release gate, not the process | OPEN (`config/runtime-environment-policy.json` "runtime_gaps") |
| `service_role` retains `EXECUTE` on `public.siton_inventory_rpc` (`001:769`) although no consumer uses it | latent authority if the key leaks | OPEN (revoke candidate; verify no Supabase-side caller first) |
| `siton.admin_sessions` hashing has no secret component (`src/admin_identity.ts:115-117`) so an offline copy of the table plus a raw cookie is enough; bulk revocation is SQL-only | incident response is manual | OPEN |
| Render dashboard values cannot be verified by the repository gate (marked, not read) | drift between `render.yaml` and live env is invisible to CI | EXPECTED (hosted review) |
| Owner-level controls (Supabase/Render account MFA, Site URL, log retention) are console settings without a checked-in record | custody documentation gap | OPEN |
| `docs/HTTP_SECURITY_SURFACE.md`, `docs/HEALTH_CHECK_CONTRACT.md`, `docs/LOGGING_DATA_CLASSIFICATION.md` referenced by scripts are absent in this worktree | broken doc pointers | OPEN |
