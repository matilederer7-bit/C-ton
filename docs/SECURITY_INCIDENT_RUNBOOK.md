# Security Incident Runbook

Status: operational document for the hosted Siton (C-ton) staging topology
(Render web + worker, Supabase Postgres via the Supavisor session pooler,
Supabase Storage via the `storage-broker` Edge Function). Every step is marked
IMPLEMENTED (exists in the repository or the provisioned topology as cited),
EXPECTED (the design requires it; the repository documents but does not execute
it) or OPEN (no tooling or procedure exists yet). Steps that need a hosted
console are written as "hosted action - document only, not executed".

Companion: [PRODUCTION_DATA_ACCESS_BOUNDARIES.md](PRODUCTION_DATA_ACCESS_BOUNDARIES.md)
(who may touch what), [ENVIRONMENT_CONTRACT.md](ENVIRONMENT_CONTRACT.md),
[ADMIN_IDENTITY_RBAC_MFA.md](ADMIN_IDENTITY_RBAC_MFA.md),
[OPERATIONS_MONEY_INCIDENT_RUNBOOK.md](OPERATIONS_MONEY_INCIDENT_RUNBOOK.md)
(money incidents are out of scope here),
[INFORMATION_SECURITY_POLICY.md](INFORMATION_SECURITY_POLICY.md).

## 1. Rules that apply to every incident

1. Never paste a secret value into a chat, a ticket, a commit, a log line or a
   `PROJECT_STATUS.md` entry. Record *which* secret and *when*, never the value.
2. Snapshot before you change anything (section 3). Evidence in
   `siton.audit_log`, `siton.admin_actions`, the session tables and the
   security-event tables is only useful if it is captured before rotation.
3. Rotation order is: revoke access at the source (hosted console) -> update
   the consumer (Render env) -> restart/redeploy -> verify with the repository
   proofs -> only then delete the old value.
4. Money incidents (double charge, provider/DB disagreement) follow
   [OPERATIONS_MONEY_INCIDENT_RUNBOOK.md](OPERATIONS_MONEY_INCIDENT_RUNBOOK.md);
   this runbook only says which secret rotation can break in-flight money
   (section 4, `GROW_REFERENCE_ENCRYPTION_KEY`).
5. Real money is not enabled anywhere today
   (`config/runtime-environment-policy.json` staging: `PAYMENT_PROVIDER=mockpay`,
   production: `PAYMENT_ENVIRONMENT=live` refused). Treat that as a fact to
   verify, not an assumption.

## 2. Repository commands used in this runbook

| Command | What it proves | Needs |
|---|---|---|
| `npm run scan:secrets` | no committed secret / real PII shapes (`scripts/secret_pii_scan.cjs`: private keys, Stripe, Supabase `service_role` JWT + `sb_secret_`, Render `rnd_`, Twilio, Grow assignments, non-local `postgres://` credentials, Luhn PANs, tracked `.env`) | nothing |
| `npm run gate:logging-hygiene` | no NEVER_LOG field inside a log call in `src/` (`config/logging-data-classification.json`), URL serializer redaction, SQL logging opt-in | nothing (runtime seam if a local `DATABASE_URL` exists) |
| `npm run report:routes` | every HTTP route classified; `UNGUARDED_PROTECTED_ROUTES = 0`; unclassified route fails (`scripts/route_inventory_report.cjs`, `config/route-classification.json`) | nothing |
| `npm run ci:route-authorization` | behavioural: every protected route refuses an anonymous caller on a fresh DB (`scripts/ci_route_authorization_gate.cjs`) | local Postgres |
| `npm run gate:runtime-env` | env policy for every target; `SUPABASE_SERVICE_ROLE_KEY` must be ABSENT from every application runtime; staging/production `DATABASE_URL` must not start with `postgres://postgres:` | nothing |
| `npm run smoke:http-security` | headers, no-store, no stack leak, anonymous admin refused, unsigned webhook refused (`scripts/http_security_smoke.cjs`) | local Postgres |
| `npm run check:health-contract` | `/health` = liveness only, `/readiness` = DB + schema + runtime role (`scripts/health_contract_check.cjs`) | local Postgres |
| `node scripts/r3_hosted_proof.cjs --base-url=https://<service>.onrender.com` | hosted responses carry no secret material; with `R3_WEB_DATABASE_URL` set it also proves the DB identity boundary (`scripts/r3_hosted_proof.cjs:6-11`) | network |
| `npm run release:preflight:static` | all static gates above in one run (`config/release-preflight-gates.json`) | nothing |
| `npm run db:backup-restore-rehearsal` | dump/restore of the canonical schema on disposable LOCAL databases only | pg_dump/pg_restore |

None of these commands touches the hosted database. Hosted reads go through
the Supabase SQL editor / MCP channel as the `postgres` owner (hosted action).

## 3. First 15 minutes (every scenario)

| Step | Action | Marker |
|---|---|---|
| 3.1 | Open an incident note (time, reporter, suspected secret/surface, blast radius guess). No values. | EXPECTED |
| 3.2 | Freeze deploys: Render `autoDeploy: true` from `master` (`render.yaml:20-23`, `:76-79`) means a merge is a deploy. Hosted action - document only, not executed: pause auto-deploy on both services. | EXPECTED |
| 3.3 | Snapshot evidence (hosted SQL, read-only, as the `postgres` owner): `SELECT count(*), max(created_at) FROM siton.audit_log;` `SELECT admin_session_id, admin_user_id, created_at, expires_at, revoked_at, last_seen_at FROM siton.admin_sessions ORDER BY created_at DESC LIMIT 50;` same shape for `siton.seller_sessions`, `siton.distributor_sessions`, `siton.buyer_sessions`; `SELECT * FROM siton.seller_security_events ORDER BY 1 DESC LIMIT 100;` `SELECT * FROM siton.payment_webhook_security_events ORDER BY 1 DESC LIMIT 100;` `SELECT * FROM siton.infrastructure_change_audit ORDER BY 1 DESC LIMIT 50;` | IMPLEMENTED (tables exist: `supabase/staging/006_canonical_postgres_runtime_boundary.sql:97-135`; writers at `src/frontend_runtime.ts:1474`, `:2013`, `:7513`, `:7783`) |
| 3.4 | Export Render logs for both services for the window (hosted action - document only). Logs never carry env values (`docs/ENVIRONMENT_CONTRACT.md` "Anti-patterns"), but they carry request ids and redacted URLs (`src/app.ts:3187-3228`). | EXPECTED |
| 3.5 | Confirm nothing in Git: `npm run scan:secrets` on the current checkout and on the suspected commit (`git checkout <sha> -- . ` in a scratch worktree, then run the scan). | IMPLEMENTED |
| 3.6 | Decide the scenario (sections 5-11) and whether an emergency pause is needed: `pause_joining_emergency` / `pause_charging_emergency` are admin actions requiring `emergency.pause` (SuperAdmin only, `src/admin_identity.ts:58-72`, `:88-94`), created via `POST /api/admin/actions` and released via `POST /api/admin/control-flags/:flagId/release` (`src/frontend_runtime.ts:7155`, `:7313`). | IMPLEMENTED |

## 4. Rotation implications table

Which secret invalidates what. "Consumer" is where the value must be updated.

| Secret | Consumer | Rotating it invalidates | Side effects / gotchas | Marker |
|---|---|---|---|---|
| `DATABASE_URL` (web) = `siton_web_login` password | Render `siton-staging-web` (`render.yaml:33-34`) | every web DB session after restart | password set by `ALTER ROLE siton_web_login PASSWORD` outside Git (`docs/ARCHITECTURE_REBASE_R3_RENDER_WEB.md:149-155`); session-mode pooler URL, user `siton_web_login.<project-ref>`; `/readiness` fails closed on identity mismatch (`src/runtime_database_boundary.ts:25-38`) | IMPLEMENTED structure, EXPECTED procedure |
| `DATABASE_URL` (worker) = `siton_worker_login` password | Render `siton-staging-worker` (`render.yaml:87-88`) | worker DB sessions; outbox stops until restart | separate secret from web by design (`supabase/staging/011_r4_worker_login_provisioning.sql:11-13`); worker boot asserts `siton_worker_runtime` (`src/app.ts:3131`) | IMPLEMENTED structure, EXPECTED procedure |
| `ADMIN_API_KEY` | Render both services (`render.yaml:35-36`, `:89-90`) | the bootstrap `x-admin-key` header only. Admin **sessions are NOT invalidated**: session hashes use a fixed prefix, not this key (`src/admin_identity.ts:115-117`) | shared key yields only `BootstrapReadOnly` (`mission_control.read`, `admin_actions.read`, `security.read`; `src/admin_identity.ts:284-317`, `docs/ADMIN_IDENTITY_RBAC_MFA.md:81-96`). Render `generateValue` regenerates a new one on request (hosted action) | IMPLEMENTED |
| `SELLER_SESSION_SECRET` | Render both services (`render.yaml:37-38`, `:91-92`) | ALL seller sessions (hash = sha256(secret:token), `src/seller_auth.ts:171-175`) AND the OTP proof token signature when `OTP_TOKEN_SECRET` is unset (`src/otp_rail.ts:57-64`, `:572`, `:582`) -> in-flight buyer joins holding an `otp_token` get `otp_not_verified` and must re-verify | also required in production by `src/production_guards.ts:135`; min 32 chars per env policy | IMPLEMENTED |
| `OTP_TOKEN_SECRET` (optional) | Render (not declared in `render.yaml`) | OTP proof tokens (15 min TTL, `src/otp_rail.ts:29`) and buyer resume sessions when `BUYER_SESSION_SECRET` is unset (`src/buyer_session.ts:9-13`) | when unset the fallback chain is `SELLER_SESSION_SECRET` then a public default string | IMPLEMENTED fallback; OPEN (not declared for staging) |
| `BUYER_SESSION_SECRET` | Render (not declared in `render.yaml`) | all buyer resume cookies (`siton_buyer_session`, 24 h; hash uses the secret, `src/buyer_session.ts:23-28`) | in production-like mode an unset value disables buyer sessions (empty secret) rather than falling back | IMPLEMENTED; OPEN (not declared for staging) |
| `DISTRIBUTOR_SESSION_SECRET` | Render (not declared in `render.yaml`) | all distributor sessions (`src/distributor_identity.ts:9-11`, `:23-28`) | distributor auth fails closed without it | IMPLEMENTED; OPEN (not declared for staging) |
| `OTP_HASH_SALT` | Render (not declared) | nothing already persisted (challenges expire); new codes hash with the new salt | runtime falls back to the literal `siton-otp-salt-default` in every mode - runtime gap `OTP_HASH_SALT_DEFAULT_IN_PRODUCTION` (`config/runtime-environment-policy.json` "runtime_gaps"; `src/otp_rail.ts:53-55`) | OPEN |
| `SITON_STORAGE_BROKER_KEY` | Render both services (`render.yaml:50-51`, `:103-104`) AND the SHA-256 digest pinned in `supabase/functions/storage-broker/index.ts:21` | every broker call (put/head/get/delete/list) until both sides agree | order: generate -> update digest in the function source -> redeploy the function -> update both Render services (`docs/ENVIRONMENT_CONTRACT.md:174`). Published imagery keeps serving from the public CDN during the swap; uploads/deletes fail closed (401 `broker_unauthorized`, `index.ts:129-133`) | IMPLEMENTED design, EXPECTED procedure (function redeploy is a hosted action) |
| `SUPABASE_SERVICE_ROLE_KEY` | ONLY the Edge Function runtime (`index.ts:26-30`); must be ABSENT from every app runtime (`config/runtime-environment-policy.json`, every target) | the broker's storage client; Supabase dashboard/API access for anyone holding it | rotation is a Supabase project action (hosted action). No Render env needs updating. | IMPLEMENTED boundary, EXPECTED procedure |
| `SUPABASE_ANON_KEY` / `SUPABASE_PUBLISHABLE_KEY` | Render web (read at request time, `src/frontend_runtime.ts:1887-1897`), published to the browser by design | browser Supabase Auth calls (seller/admin login through Supabase) | not a secret; server verifies tokens against the project JWKS, never against this key (`src/supabase_auth.ts:223-232`) | IMPLEMENTED |
| `PAYMENT_WEBHOOK_SECRET` | Render web | generic HMAC webhook verification (`src/frontend_runtime.ts:1574-1627`) | staging runs `mockpay`/`mock-backed` where verification is skipped by design (`:1600-1605`); Grow callbacks are unsigned and never money truth; Stripe verifies its own header | IMPLEMENTED |
| `GROW_REFERENCE_ENCRYPTION_KEY` | Render (only when `PAYMENT_PROVIDER=grow`) | **decryptability of every stored Grow provider reference** (AES-256-GCM sealed with sha256(key), `src/grow_payment_adapter.ts:222-241`; used at `:424-548`) -> settle/refund/status on existing attempts fails with `grow_reference_invalid` | do NOT rotate while Grow attempts are in flight; requires a re-seal migration that does not exist | IMPLEMENTED encryption; OPEN re-seal tooling |
| `GROW_USER_ID` / `GROW_PAGE_CODE` / `GROW_API_KEY` | Render (Grow stage only) | provider calls | issued by Grow support (hosted action - Grow support) | EXPECTED |
| Render API key (`rnd_`) | operator machine only | Render API automation | never in repo (`scripts/secret_pii_scan.cjs` detector `render-api-key`) | IMPLEMENTED detection |
| GitHub `stripe-sandbox` environment secrets | `.github/workflows/stripe-sandbox-proof.yml:27`, `:34-36` | the manual Stripe sandbox proof only | test-mode keys; rotate in Stripe dashboard + GitHub environment (hosted action) | IMPLEMENTED |

## 5. Scenario: secret leak (any value seen where it must not be)

| Phase | Action | Marker |
|---|---|---|
| Contain | Identify the secret from the table in section 4. If it is in Git history: do not force-push yet; freeze deploys (3.2). If it is in a log line: export then purge the Render log window (hosted action - document only). | EXPECTED |
| Rotate | Follow the row in section 4. For Render-generated values (`ADMIN_API_KEY`, `SELLER_SESSION_SECRET`) regenerate in the Render dashboard (hosted action - document only, not executed). Restart both services. | EXPECTED |
| Verify | `npm run scan:secrets` (repo clean); `npm run gate:runtime-env` (policy shape); `node scripts/r3_hosted_proof.cjs --base-url=...` (no secret in responses); `GET /readiness` = 200 on web; `siton.worker_heartbeats` fresh (`src/worker.ts:36`). | IMPLEMENTED |
| Audit | Diff `siton.audit_log` / `siton.admin_actions` / session tables against the 3.3 snapshot. Check `siton.seller_security_events` for logins in the window. | IMPLEMENTED (tables) |
| Restore | Un-freeze deploys. If Git history must be rewritten, do it on a dedicated branch with owner approval; the leaked value is dead anyway after rotation. | EXPECTED |
| Postmortem | Section 12. Add the shape to `scripts/secret_pii_scan.cjs` if the detector missed it; add the field to `config/logging-data-classification.json` `never_log` if it came from a log. | IMPLEMENTED (extension points) |

## 6. Scenario: service-role exposure (`SUPABASE_SERVICE_ROLE_KEY`)

The service-role key bypasses RLS and can call `public.siton_inventory_rpc`
(`supabase/staging/001_siton_inventory_v1.sql:769`). It exists only inside the
`storage-broker` Edge Function runtime (`index.ts:26-30`); no Render service,
CI job or browser holds it (policy: `config/runtime-environment-policy.json`,
rule `SUPABASE_SERVICE_ROLE_KEY must absent` in every target).

| Phase | Action | Marker |
|---|---|---|
| Contain | Hosted action - document only, not executed: rotate the project JWT secret / service-role key in the Supabase dashboard; this also invalidates the anon key and every issued Supabase Auth session (sellers/admins re-login). Consider pausing the Edge Function until redeployed. | EXPECTED |
| Rotate | Supabase re-injects the new key into the Edge Function environment (hosted action). Update `SUPABASE_ANON_KEY` on Render web if it was set there (hosted action). The broker key is unaffected unless it was exposed together. | EXPECTED |
| Verify | `npm run gate:runtime-env` proves no app target may hold the key; `npm run scan:secrets` (detector `supabase-service-role-jwt` decodes JWT payloads for `role=service_role`); upload a Draft image through the seller UI and confirm the broker answers 200 (`index.ts:175`); `GET /api/preview/auth-config` returns the new anon key and `configured:true`. | IMPLEMENTED |
| Audit | Hosted action - document only: Supabase API/Postgres logs for `service_role` activity in the window; `storage.objects` changes in bucket `deal-images`; `siton.storage_orphan_reports` (web-readable, `006:110`). Compare image rows vs bucket listing via the broker `list` op. | EXPECTED |
| Restore | Redeploy the function; re-run the seller upload proof; release any emergency pause. | EXPECTED |
| Postmortem | Confirm the exposure path (dashboard account, CLI cache, screenshot). Owner dashboard MFA is a hosted control (OPEN: not documented here). | OPEN |

## 7. Scenario: admin-key leak (`ADMIN_API_KEY` or an admin session cookie)

| Phase | Action | Marker |
|---|---|---|
| Contain | The shared key grants read-only bootstrap identity (`src/admin_identity.ts:303-317`): mission control, admin-action reads, security reads. It cannot create/approve/execute actions, freeze payouts, pause, or manage users (`docs/ADMIN_IDENTITY_RBAC_MFA.md:81-96`). Data exposure (buyer/seller details visible to mission control) is the real blast radius. If a **session cookie** leaked, revoke it: hosted SQL `UPDATE siton.admin_sessions SET revoked_at=now() WHERE revoked_at IS NULL;` (all sessions; there is no admin route for bulk revocation - only own logout at `src/frontend_runtime.ts:2653-2664`). | IMPLEMENTED (SQL path), OPEN (no bulk-revoke route) |
| Rotate | Regenerate `ADMIN_API_KEY` on both Render services (hosted action - document only, not executed; `render.yaml:35-36`, `:89-90`). Restart. Rotation does not touch admin sessions (section 4). If a named admin's password is suspect: `POST /api/admin/auth/mfa/disable` needs `admin_users.manage` (`:2631-2635`); password reset for cookie-login admins has no route (OPEN) - re-provision via `scripts/create_admin_user.cjs` semantics (env-driven, `:14-16`) as a hosted SQL update. | IMPLEMENTED / OPEN as marked |
| Verify | `curl -H "x-admin-key: <old>" https://<web>/api/admin/mission-control` -> 401; `npm run smoke:http-security` (anonymous admin refused); `npm run ci:route-authorization` (127 protected routes refuse anonymous callers, `.ci-artifacts/web-route-inventory.json`). | IMPLEMENTED |
| Audit | `siton.admin_actions` created/approved/executed in the window; `siton.admin_sessions` rows with `ip_hash`/`user_agent_hash` (hashed at issue, `src/admin_identity.ts:170-183`); `siton.audit_log` actor fields. | IMPLEMENTED |
| Restore | Named admins re-login (Supabase Auth or cookie login), MFA re-verify for high-trust actions (15 min window, `src/admin_identity.ts:19`). | IMPLEMENTED |
| Postmortem | Decide whether the shared key stays enabled for pilot ("disable or tightly restrict" is a listed live-pilot requirement, `docs/ADMIN_IDENTITY_RBAC_MFA.md:98-104`). | OPEN |

## 8. Scenario: buyer-token leak (OTP proof token, tracking/recovery token, buyer resume cookie)

Three different tokens with three different kill switches.

| Token | Stored as | Bound to | Kill switch | Marker |
|---|---|---|---|---|
| `otp_token` (`v1.<body>.<sig>`) | HMAC over body with `OTP_TOKEN_SECRET` or `SELLER_SESSION_SECRET` (`src/otp_rail.ts:57-64`, `:572`); proof hash in `siton.otp_proofs` (`:394-396`, `:462`) | challenge id, destination hash, purpose, 15 min (`:29`) | single: hosted SQL `UPDATE siton.otp_challenges SET status='expired' WHERE challenge_id=...` (check the column contract first); global: rotate the signing secret (invalidates all seller sessions too - section 4) | IMPLEMENTED (design), EXPECTED (SQL) |
| participant tracking token (`?t=` / Bearer) | `sha256('participant-tracking:'+token)` in `siton.participant_tracking_tokens` - no secret involved (`src/participant_tracking_security.ts:23-25`) | participant id + deal id + purpose, 45 days (`:5`) | per participant: `revokeParticipantTrackingTokens` exists (`:78-88`) but **no route calls it** - hosted SQL `UPDATE siton.participant_tracking_tokens SET status='Revoked', revoked_at=now() WHERE participant_id=$1 AND status='Active';` then re-issue through the join/recovery flow (`src/app.ts:5279`) | IMPLEMENTED helper, OPEN (no admin surface) |
| buyer resume cookie `siton_buyer_session` | `sha256(secret:token)` in `siton.buyer_sessions` (`src/buyer_session.ts:23-28`) | deal-bound, 24 h (`:7`), HttpOnly SameSite=Lax | own logout `POST /api/buyer/session/logout` (`src/frontend_runtime.ts:2513-2517`); global: rotate `BUYER_SESSION_SECRET` (or `OTP_TOKEN_SECRET` if that is the effective value) | IMPLEMENTED |

| Phase | Action | Marker |
|---|---|---|
| Contain | Revoke per the table; tracking links are the only long-lived token (45 d) so treat a leaked share/recovery URL as the priority. Query string tokens are redacted in request logs (`src/app.ts:3159-3162`, key `t`/`token`). | IMPLEMENTED |
| Rotate | Only if the leak is systemic (e.g. token minted into a log or an email template): rotate the relevant secret from section 4 and accept the seller-session side effect. | EXPECTED |
| Verify | `curl "https://<web>/api/participants/<id>/tracking?t=<leaked>"` -> `tracking_token_invalid`/`tracking_token_inactive`; `npm run gate:logging-hygiene` (fields `otp_token`, `tracking_access_token`, `session_token` are NEVER_LOG). | IMPLEMENTED |
| Audit | `siton.participant_tracking_tokens.last_used_at` (`:120`), `issued_via`, `correlation_id`; `siton.otp_delivery_attempts`; `siton.buyer_sessions.last_seen_at`. | IMPLEMENTED |
| Restore | Buyer re-verifies OTP or receives a fresh tracking link from the recovery flow. | IMPLEMENTED |
| Postmortem | Decide whether an admin tracking-token revoke/reissue surface is needed (`docs/PARTICIPANT_TRACKING_SECURITY.md:44,56` already lists it as missing). | OPEN |

## 9. Scenario: unexpected public route

| Phase | Action | Marker |
|---|---|---|
| Contain | Identify the route: `npm run report:routes` writes `.release-artifacts/` + `.ci-artifacts/web-route-inventory.json` (last committed artifact: 213 routes, 127 protected, 10 anonymous-by-design, 0 unguarded). A route matching no rule is UNCLASSIFIED and fails; a protected-namespace route with no guard call is flagged `NO GUARD CALL`. There is no per-route kill switch (`docs/RELEASE_READINESS_CHECKLIST.md` "Kill Switch"); options are an emergency pause flag (3.6) for join/charge paths, or rollback of the Render deploy (hosted action - document only). | IMPLEMENTED (detection), OPEN (per-route kill) |
| Rotate | Not a secret event unless the route returned one; if it did, jump to section 5 for that secret. | n/a |
| Verify | Fix on a branch; `npm run ci:route-authorization` (behavioural, fresh DB); `npm run smoke:http-security`; the anonymous-by-design allowlist in `scripts/protected_route_policy.cjs` is the only hand-maintained exception list and every entry must carry an executed behavioural expectation. | IMPLEMENTED |
| Audit | Render request logs for the path (URL query redacted, method/path kept, `src/app.ts:3209-3228`); `x-request-id` correlates with `siton.audit_log` rows (`src/app.ts` `genReqId`). Quantify: distinct IPs are hashed in sessions but raw in Fastify request logs (`remoteAddress`) - handle as personal data. | IMPLEMENTED |
| Restore | Merge the fix; Render auto-deploys from `master`; confirm `/readiness` 200. | IMPLEMENTED |
| Postmortem | Add the route to `config/route-classification.json` deliberately (class + note) and, if it must refuse anonymous callers, register it with `config.authority` metadata so the policy derives membership from the live router. | IMPLEMENTED (mechanism) |

## 10. Scenario: PII in logs

| Phase | Action | Marker |
|---|---|---|
| Contain | Confirm the env did not enable a verbose seam: `DEBUG_SQL_LOGGING`, `DEBUG_JOIN_LOGGING`, `LOG_LEVEL=debug|trace` are refused for staging/production by `npm run gate:runtime-env --target staging` (`config/runtime-environment-policy.json`). Hosted action - document only, not executed: check the Render env of both services for those keys. Purge/limit Render log retention for the window (hosted action). | IMPLEMENTED (gate), EXPECTED (hosted) |
| Rotate | None, unless a credential was logged (then section 5). | n/a |
| Verify | `npm run gate:logging-hygiene` locates every `log.*`/`console.*` call in `src/` by AST and fails on NEVER_LOG identifiers (`otp_code`, `development_code`, `otp_token`, `tracking_access_token`, `session_token`, `cookie`, `authorization`, `x_admin_key`, `password`, card fields, ...); SENSITIVE fields (`buyer_phone`, ...) warn unless visibly masked (`config/logging-data-classification.json`). The request serializer only logs method, redacted URL, host, remote address/port (`src/app.ts:3209-3228`). | IMPLEMENTED |
| Audit | Grep the exported log window for the leaked field; count affected subjects; record the log line shape (not the values) in the incident note. | EXPECTED |
| Restore | Ship the fix (mask/hash/remove), re-run the gate, redeploy. | IMPLEMENTED |
| Postmortem | Add the identifier to `never_log` or `sensitive`; if the leak came from a provider payload echo, add a control to `tests/release_tools/`. Note: `docs/LOGGING_DATA_CLASSIFICATION.md` is referenced by the gate but is not present in this worktree. | OPEN (doc) |

## 11. Scenario: database credential compromise (`DATABASE_URL`)

| Phase | Action | Marker |
|---|---|---|
| Contain | Blast radius is bounded by the login design: `siton_web_login` / `siton_worker_login` hold zero direct privileges and only `SET ROLE` into the NOLOGIN profile (`supabase/staging/010_r3_web_login_provisioning.sql:37`, `:43`, `:103-110`; `011_...:42`, `:49`). Neither profile can DDL, own schemas, read `siton_inventory` tables directly, or grant to browser roles (`docs/ARCHITECTURE_REBASE_R2_CANONICAL_POSTGRES.md:78-99`). The web profile can still read/write business tables (`006:97-136`), so treat as a data-access incident. Hosted action - document only, not executed: `ALTER ROLE siton_web_login PASSWORD '<new>'` (and/or worker) in the Supabase SQL editor; terminate live sessions `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename IN ('siton_web_login','siton_worker_login');` (pools are labelled `siton-web-runtime` / `siton-worker-runtime` via `application_name`, `src/db.ts:8-17`). | IMPLEMENTED (boundary), EXPECTED (procedure) |
| Rotate | Compose the new session-mode Supavisor URL (port 5432, `sslmode=verify-full`, user `siton_web_login.<project-ref>`; `docs/ARCHITECTURE_REBASE_R3_RENDER_WEB.md:151-155`), set it on the matching Render service only (`sync: false`, `render.yaml:33-34`, `:87-88`) - never reuse the web URL on the worker (`render.yaml:65-70`). Restart. If the `postgres` owner password is suspect: Supabase dashboard reset (hosted action) - it is not an application credential. | EXPECTED |
| Verify | `GET /readiness` -> 200 with `runtime_role: siton_web_runtime` (`src/runtime_database_boundary.ts:45-51`); worker heartbeat fresh; `node scripts/r3_hosted_proof.cjs --base-url=... ` with `R3_WEB_DATABASE_URL` set on the operator machine proves identity + denied DDL; `npm run gate:runtime-env` rejects any `postgres://postgres:` URL for staging/production. Old URL must now fail: `psql "<old-url>" -c 'select 1'` -> auth failure (run from the operator machine; never commit the URL). | IMPLEMENTED |
| Audit | Hosted action - document only: Supabase Postgres logs / `pg_stat_activity` history for the login role in the window; unexpected `application_name` values (anything other than `siton-web-runtime` / `siton-worker-runtime` under those users is foreign). Diff `siton.audit_log`, money tables (`payment_attempts`, `platform_fee_money_events`) against the 3.3 snapshot; money invariants per `docs/OPERATIONS_MONEY_INCIDENT_RUNBOOK.md`. | EXPECTED |
| Restore | If data was altered: point-in-time restore is a Supabase platform capability (hosted action - document only); the repository proves restorability only on local databases (`npm run db:backup-restore-rehearsal`, `scripts/dr_backup_restore_drill.cjs`). Re-run `npm run db:migrate` semantics are NOT for hosted (migrations reach staging through the management channel, `docs/ARCHITECTURE_REBASE_R2_CANONICAL_POSTGRES.md:64-76`). | EXPECTED (hosted PITR), IMPLEMENTED (local rehearsal) |
| Postmortem | Confirm where the URL leaked (Render dashboard access, operator shell history, `R3_WEB_DATABASE_URL` left in an environment). Verify `.env` never enters images (`Dockerfile:15`, `.dockerignore`). | IMPLEMENTED (image hygiene) |

## 12. Postmortem template (all scenarios)

Record in the incident note (and a one-line pointer in `PROJECT_STATUS.md`):
timeline (detect/contain/rotate/verify), secret or surface class (never the
value), blast radius (tables, subjects, money impact = expected 0 while
`mockpay`), commands run and their PASS/FAIL markers, hosted actions performed
by whom, detector/gate/classification change made, and the OPEN items below
that the incident touched.

## 13. Open items this runbook depends on

| Item | Where | Marker |
|---|---|---|
| Bulk admin/seller/distributor session revocation route (today: SQL or per-principal provisioning routes `src/frontend_runtime.ts:7543`, `:7578-7584`, `:7627-7628`) | app | OPEN |
| Admin surface to revoke/reissue participant tracking tokens (helper exists, no caller) | app | OPEN |
| `OTP_HASH_SALT`, `BUYER_SESSION_SECRET`, `DISTRIBUTOR_SESSION_SECRET`, `OTP_TOKEN_SECRET` not declared in `render.yaml` (staging relies on fallbacks; production gate FAILs without them) | render.yaml / runtime | OPEN |
| Runtime does not fail closed on `OTP_HASH_SALT` default, `TRACKING_LEGACY_COMPAT=1`, or `DEBUG_SURFACES_ENABLED=1` in production (only the release gate does) | `config/runtime-environment-policy.json` "runtime_gaps" | OPEN |
| Grow reference re-seal tooling for `GROW_REFERENCE_ENCRYPTION_KEY` rotation | app/scripts | OPEN |
| Hosted log export/purge, Supabase PITR, key rotation and deploy freeze procedures are console actions with no repository automation (Render MCP / Supabase MCP exist but require interactive auth) | hosted | EXPECTED |
| `docs/HTTP_SECURITY_SURFACE.md`, `docs/HEALTH_CHECK_CONTRACT.md`, `docs/LOGGING_DATA_CLASSIFICATION.md` are referenced by release scripts but absent in this worktree | docs | OPEN |
