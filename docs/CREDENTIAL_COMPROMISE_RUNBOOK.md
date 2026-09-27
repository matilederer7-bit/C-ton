# Credential Compromise Runbook — Siton (C-ton)

Status: the rotation matrix for every secret the system holds. Written 2026-09-27 (Black-Sky branch, base `dd378dd`). **Every rotation is an owner action**: no coding agent, CI job or runbook step rotates a hosted credential; agents prepare, verify and record. Values never appear anywhere — only names, locations and procedures.

This document extends `docs/SECURITY_INCIDENT_RUNBOOK.md` (§4 rotation implications, §5–§11 scenarios) and `docs/INCIDENT_RESPONSE_RUNBOOK.md` (severity, first 15 minutes, evidence). Read those first; this file is the per-secret matrix and the procedures that were OPEN there (Grow keyring re-seal, off-site backup keys, GitHub/CI tokens).

## 0. Never-do list

1. Never rotate before the evidence snapshot (`docs/INCIDENT_RESPONSE_RUNBOOK.md` §5). Session tables and security events are the only record of what the leaked credential was used for.
2. Never rotate `GROW_REFERENCE_ENCRYPTION_KEY` by replacing it: **add** the new key as primary and keep the old one in `GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS` until `scripts/grow_reference_reseal.cjs` reports `retire_safe` for its kid (§3.7). Replacing it outright makes every stored Grow reference unreadable (`grow_reference_invalid`) and blocks settle/refund/status on in-flight attempts.
3. Never give the CI runner the age **private** identity; `.github/workflows/offsite-db-backup.yml:77-80` refuses anything that is not an `age1…` public recipient, and the restore path (`docs/DISASTER_RECOVERY_RUNBOOK.md` §5) is the only place the identity is used.
4. Never set `SUPABASE_SERVICE_ROLE_KEY` on any Render service or in CI; `npm run gate:runtime-env` and the boot guard fail on it. It belongs only to the `storage-broker` Edge Function runtime.
5. Never reuse the web `DATABASE_URL` on the worker (or vice versa); each service has its own LOGIN role and password.
6. Never paste a value into a commit, a test fixture, a log line, a ticket, `PROJECT_STATUS.md` or chat. `npm run scan:secrets` (working tree + full git history) is the gate; if it ever fires on a real value, that value is compromised by definition.
7. Never "rotate" by editing a migration or a grant file: role passwords are set with `ALTER ROLE … PASSWORD` outside Git (`supabase/staging/010_r3_web_login_provisioning.sql:7`).
8. Never delete the old value before the new one is verified live (order: revoke at source → update consumer → restart → verify → delete old; `docs/SECURITY_INCIDENT_RUNBOOK.md` §1.3).
9. Never rotate the Supabase JWT secret casually: it invalidates every Supabase Auth session and the anon key at once (§3.9).

## 1. Detection signals (what tells you a secret leaked)

| Signal | Source | Likely secret |
|---|---|---|
| `npm run scan:secrets` FAIL (masked fingerprint printed, never the value) | CI `scan:secrets` gate, `scripts/secret_pii_scan.cjs`, `scripts/git_history_secret_scan.cjs` | whatever shape matched: `postgres://user:pass@`, `sk_live_`, `sb_secret_`, `service_role` JWT, `rnd_`, Twilio, Grow assignments, private keys |
| `pg_stat_activity` rows for `siton_web_login`/`siton_worker_login` with an `application_name` other than `siton-web-runtime` / `siton-worker-runtime` | hosted SQL as owner | `DATABASE_URL` |
| `siton.admin_sessions` / `seller_sessions` rows with unexpected `ip_hash`/`user_agent_hash`; `seller_security_events` logins outside the seller's pattern | hosted SQL | session cookies, `SELLER_SESSION_SECRET` |
| `siton.admin_actions` requested/executed by an identity you did not use | `GET /api/admin/mission-control` | admin credentials |
| `siton.payment_webhook_security_events` with signature failures, then successes from a new source | `GET /api/admin/payment-ops-status` | `PAYMENT_WEBHOOK_SECRET` (a signed-and-accepted webhook you did not send = the secret is out) |
| Storage broker `401 broker_unauthorized` bursts, or objects in `deal-images` you did not upload | Supabase logs / `siton.storage_orphan_reports` | `SITON_STORAGE_BROKER_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
| Sentry events from a project/environment you do not run | Sentry | `SENTRY_DSN` (write-only; nuisance, not data loss) |
| Render/Supabase/GitHub audit logs show API actions you did not perform; unexpected workflow runs; unexpected Actions secrets changes | platform consoles (OWNER ACTION) | Render API key, `SUPABASE_MANAGEMENT_API_TOKEN`, GitHub tokens |
| Off-site bucket lists objects with a stamp you did not produce, or a `manifest.json` whose `repository`/`commit` is foreign | bucket console | `OFFSITE_BACKUP_S3_*` |
| Grow / Stripe dashboard shows API calls with your credentials from an unknown source | provider dashboard | `GROW_*`, `PAYMENT_PROVIDER_API_KEY`, `STRIPE_WEBHOOK_SECRET` |

## 2. Matrix

Columns: **Where it lives** (consumer), **Blast radius**, **Contain** (immediate, before rotation), **Rotate** (owner action, exact names), **Invalidate** (sessions/tokens that must die), **Verify**.

| # | Secret | Where it lives | Blast radius | Contain | Rotate (OWNER ACTION) | Invalidate | Verify |
|---|---|---|---|---|---|---|---|
| 1 | `DATABASE_URL` (web) = password of `siton_web_login` | Render `siton-staging-web` (`sync: false`) | read/write of every business table through the `siton_web_runtime` profile; no DDL, no `siton_inventory` direct access, cannot grant (`docs/PRODUCTION_DATA_ACCESS_BOUNDARIES.md` §1) | hosted SQL as owner: `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='siton_web_login' AND application_name <> 'siton-web-runtime';` (foreign sessions first); `pause_joining_emergency` global if writes are suspected | `ALTER ROLE siton_web_login PASSWORD '<new>';` in the Supabase SQL editor; compose the new session-pooler URL (`siton_web_login.<project-ref>`, port 5432, `sslmode=verify-full`); set on the web service only; restart | every web DB session (restart does it) | `GET /readiness` 200 with `runtime_role: siton_web_runtime`; `psql "<old-url>" -c 'select 1'` fails auth (operator machine only); `npm run gate:runtime-env` |
| 2 | `DATABASE_URL` (worker) = password of `siton_worker_login` | Render `siton-staging-worker` (`sync: false`) | outbox/payment/payout writes through `siton_worker_runtime`; same DDL limits | terminate foreign `siton_worker_login` sessions; suspend the worker | `ALTER ROLE siton_worker_login PASSWORD '<new>';` → new URL on the worker only → resume | worker sessions | one fresh `ready` heartbeat; `stuck_candidates=0` after a reclaim interval |
| 3 | `postgres` project owner password / Supabase dashboard account | Supabase (never an app credential) | everything: DDL, grants, RLS, `auth`, `storage` | S1; freeze deploys; snapshot evidence | Supabase dashboard reset; enable dashboard MFA (OPEN in `SECURITY_INCIDENT_RUNBOOK` §6) | dashboard sessions | ACL snapshot diff (`docs/DISASTER_RECOVERY_RUNBOOK.md` §6) and 11 enforcement triggers present |
| 4 | `SELLER_SESSION_SECRET` | Render both services (`generateValue: true`) | all seller cookie sessions (hash = sha256(secret:token)); OTP proof tokens when `OTP_TOKEN_SECRET` is unset (`src/otp_rail.ts`); buyer resume cookies and link-viewer sessions via the fallback chain | none needed beyond evidence | Render → regenerate on **both** services → restart both | every seller session, in-flight `otp_token`s (buyers re-verify), buyer/link-viewer sessions on the fallback chain | seller login works; `curl` with an old cookie → 401; `npm run smoke:http-security` |
| 5 | `ADMIN_SESSION_SECRET` (requested name) | **does not exist** in this codebase: admin sessions are hashed as `sha256('admin-session:' + token)` with a fixed prefix (`src/admin_identity.ts:118`); admin identity = named user password (scrypt) + MFA + DB session row | a leaked admin cookie = that session until `expires_at`/`revoked_at` | hosted SQL: `UPDATE siton.admin_sessions SET revoked_at=now() WHERE revoked_at IS NULL;` | none to rotate; if a named admin's password is suspect re-provision it (`scripts/create_admin_user.cjs` semantics, hosted SQL) and `POST /api/admin/auth/mfa/disable` + re-enrol only with `admin_users.manage` | all admin sessions (SQL above) | old cookie → 401; `npm run ci:route-authorization` |
| 6 | `ADMIN_API_KEY` | Render both services (`generateValue: true`) | `x-admin-key` bootstrap identity: **read-only** (`mission_control.read`, `admin_actions.read`, `security.read`); buyer/seller details visible in Mission Control | none (cannot mutate) | Render regenerate on both services → restart | the header only; admin sessions unaffected | `curl -H "x-admin-key: <old>" https://<web>/api/admin/mission-control` → 401 |
| 7 | `OTP_TOKEN_SECRET` / `BUYER_SESSION_SECRET` / `LINK_VIEWER_SESSION_SECRET` / `OTP_HASH_SALT` | Render (not declared in `render.yaml` except `OTP_HASH_SALT sync: false`; fallbacks to `SELLER_SESSION_SECRET`/defaults) | OTP proof tokens (15 min), buyer resume cookies (24 h, deal-bound), external link-dashboard sessions; salt affects only new OTP hashes | none | set/rotate each on Render (both services) → restart | OTP tokens, buyer cookies, link-viewer sessions | buyer join with OTP works end to end on staging; `npm run gate:runtime-env --target staging` |
| 8 | `PAYMENT_WEBHOOK_SECRET` (generic HMAC), `STRIPE_WEBHOOK_SECRET` | Render web | forged provider events (`charge_captured`, `refund_issued`) — bounded by state-gated classification and `(provider,event_id)` dedupe, but a forged capture for a participant in `ChargeAttempt` is a money-truth lie | `pause_charging_emergency` (global, second approval) until rotated; export `payment_webhook_security_events` | provider dashboard: new endpoint secret → set on Render web → restart | nothing stored; old-secret signatures now rejected | send a signed test event from the provider; `payment_webhook_security_events` shows old-secret attempts rejected; timestamp required (`PAYMENT_WEBHOOK_REQUIRE_TIMESTAMP` enforced on production-like) |
| 9 | `GROW_USER_ID`, `GROW_PAGE_CODE`, `GROW_API_KEY`, `GROW_SUCCESS_URL`/`CANCEL_URL`/`NOTIFY_URL` | Render (only when `PAYMENT_PROVIDER=grow`; not set today) | provider calls on your merchant account | pause charging; Grow support | issued by Grow support; update on Render → restart; boot guard refuses placeholders and non-`https://` | none stored | `GET /health/integrations` posture; Grow sandbox proof (`docs/R9B_GROW_SANDBOX_PROOF_RUNBOOK.md`) |
| 10 | `GROW_REFERENCE_ENCRYPTION_KEY` (+ `GROW_REFERENCE_ENCRYPTION_KEY_ID`, `GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS`) | Render both services | AES-256-GCM seal of stored Grow references (`payment_authorization_bindings.provider_reference`, `authorization_id`, `replaced_authorization_id`, evidence columns); a leaked key + DB read = provider process credentials | none until rotation (do not pause: the rail keeps working under the old key) | §3.7 keyring rotation with `scripts/grow_reference_reseal.cjs` | none; old key retired only when `retire_safe` | inventory shows `UNOPENABLE` count 0 and every reference under the new kid |
| 11 | `PAYMENT_PROVIDER_API_KEY` / `PAYMENT_PROVIDER_PUBLIC_KEY` (Stripe or generic HTTP rail), `PAYOUT_PROVIDER_API_KEY` | Render (not set on staging) | provider API on your account; payouts if an external payout rail is ever configured | provider dashboard revoke; pause charging / freeze payouts | provider dashboard → Render → restart; boot guard enforces `sk_live_`/`pk_live_` only in production and refuses test keys there | none stored | posture endpoints; provider dashboard shows the old key revoked |
| 12 | `SUPABASE_SERVICE_ROLE_KEY` | ONLY the `storage-broker` Edge Function runtime | bypasses RLS; can call `public.siton_inventory_rpc`; full Storage | Supabase: pause the Edge Function | Supabase dashboard: rotate JWT secret / service-role key (also rotates anon key and kills every Auth session) → Supabase re-injects into the function → update `SUPABASE_ANON_KEY` on Render web if set | every Supabase Auth session; anon key | `npm run gate:runtime-env` (key absent from app targets); seller image upload → broker 200; `GET /api/preview/auth-config` shows the new anon key |
| 13 | `SUPABASE_ANON_KEY` / `SUPABASE_PUBLISHABLE_KEY` | Render web; published to browsers by design | not a secret; server verifies tokens against JWKS, never against this key | none | rotates with #12 | none | `GET /api/preview/auth-config` `configured:true` |
| 14 | `SUPABASE_MANAGEMENT_API_TOKEN`, `SUPABASE_METRICS_SECRET_KEY` | Render (optional; compute-approval and metrics) | Management API: project settings/billing for every project the PAT can see; metrics: read-only Prometheus scrape | revoke in Supabase account settings | new PAT/metrics key → Render → restart | none | Mission Control `infrastructure` section reports `configured:true` and reads succeed |
| 15 | `SITON_STORAGE_BROKER_KEY` | Render both services + its SHA-256 digest pinned in `supabase/functions/storage-broker/index.ts:21` | bucket-scoped put/head/get/delete/list on `deal-images` | none (published imagery keeps serving from the CDN; uploads fail closed on mismatch) | generate → update the digest in the function source (a reviewed PR) → redeploy the function → set the new key on both Render services → restart | none | seller Draft image upload 200; old key → `401 broker_unauthorized` |
| 16 | `INVOICE_PROVIDER_API_KEY`, `INVOICE_PROVIDER_BEARER_TOKEN`, `INVOICE_WEBHOOK_SECRET` | Render (unset on staging; invoice provider is internal/log-only) | tax-document issuance on your provider account | provider dashboard revoke | provider → Render → restart | none | `GET /api/admin/invoice-status`; `retry_invoice_failed` admin action for backlog |
| 17 | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Render (unset; `NOTIFICATION_PROVIDER=log-only`) | SMS sending on your account (cost, spam) | Twilio console revoke | Twilio → Render → restart | none | `GET /health/integrations` `notifications.provider` |
| 18 | `DEBUG_SURFACES_ACCESS_KEY` | Render (must be unset with `DEBUG_SURFACES_ENABLED` off; production boot guard refuses `DEBUG_SURFACES_ENABLED=1`) | `/debug/*` surfaces | unset both | n/a | none | `npm run gate:runtime-env` |
| 19 | `SENTRY_DSN` | Render both services (`sync: false`) | write-only ingest: an attacker can spam events into your project (quota), not read them | none | Sentry → project keys → new DSN → Render → restart | none | `errorMonitoringSummary` log line at boot; a self-test event arrives (`captureSelfTestIfRequested`) |
| 20 | Render API key (`rnd_…`) | operator machine only (never repo, never CI) | full control of Render services and env vars = every secret above | revoke in Render account settings | new key; re-check every env var on both services for tampering (compare against `render.yaml` + your record) | none | Render audit log shows only your actions |
| 21 | GitHub: `SITON_AGENT_GITHUB_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `stripe-sandbox` environment secrets | GitHub Actions secrets / environments | push task branches, open PRs, trigger workflows (never auto-merge); model spend; Stripe **test** keys | revoke at the issuer (GitHub token settings, provider consoles) | issue new → GitHub → run `.github/workflows/cloud-credential-preflight.yml` (`docs/ENGINEERING_OPERATING_SYSTEM.md`) | none | preflight reports each as configured and accepted; branch protection still requires review |
| 22 | Off-site backup: `OFFSITE_BACKUP_DATABASE_URL` (dedicated READ-ONLY role), `OFFSITE_BACKUP_ENCRYPTION_PUBLIC_KEY` (age recipient), `OFFSITE_BACKUP_S3_BUCKET`, `OFFSITE_BACKUP_S3_ACCESS_KEY_ID`, `OFFSITE_BACKUP_S3_SECRET_ACCESS_KEY`, optional `OFFSITE_BACKUP_S3_ENDPOINT`/`_REGION`/`_PREFIX` | GitHub Actions secrets | DB URL: read of every business row (S1 data exposure, no writes if the role is truly read-only); S3 keys: read/delete of encrypted objects (useless without the private identity, but availability of backups); public key: none | disable the workflow (OWNER ACTION) | new read-only DB role password (`ALTER ROLE <offsite-role> PASSWORD`), new S3 credential pair (write-only prefix policy), re-check bucket contents; the age public key rotates only if the private identity is suspect (§3.8) | none | `workflow_dispatch` run prints `OFFSITE_BACKUP_PASS object=… encrypted_sha256=…` |
| 23 | Off-site age **private identity** | offline, owner-held; never on any host | every backup object decryptable | treat every object encrypted to it as exposed data (S1) | generate a new identity; set the new public recipient as `OFFSITE_BACKUP_ENCRYPTION_PUBLIC_KEY`; decide whether old objects must be deleted (cannot be re-encrypted without decrypting them first with the compromised identity on an offline machine) | none | next run encrypts to the new recipient (manifest is unchanged in shape; verify by decrypting one object with the new identity) |

## 3. Procedures for the rows that need more than a table cell

### 3.1 Any Render-held secret (rows 1–2, 4, 6–11, 15–19)

1. Evidence snapshot first.
2. OWNER ACTION: Render dashboard → service → Environment → set the new value (or *Regenerate* for `generateValue` keys) — on **both** services when the table says so.
3. Manual restart of the service(s). Render restarts on env change; confirm `/readiness` returned to 200 and, for the worker, a fresh `ready` heartbeat.
4. Run the verify column. Then delete the old value at its source (provider dashboard, `ALTER ROLE`, …).
5. Record which secret and when (never the value) in the incident note.

### 3.2 Database login passwords (rows 1–2)

```sql
-- as the project owner in the Supabase SQL editor; one statement per role; nothing is logged in Git
ALTER ROLE siton_web_login PASSWORD '<new-web-password>';
ALTER ROLE siton_worker_login PASSWORD '<new-worker-password>';
-- foreign sessions (keep the runtime pools; they reconnect with the new password after restart)
SELECT pid, application_name, client_addr, backend_start FROM pg_stat_activity WHERE usename IN ('siton_web_login','siton_worker_login') AND application_name NOT IN ('siton-web-runtime','siton-worker-runtime');
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename IN ('siton_web_login','siton_worker_login') AND application_name NOT IN ('siton-web-runtime','siton-worker-runtime');
```

Then Render (`DATABASE_URL` per service), restart, verify `/readiness` `runtime_role` and the worker heartbeat. The provisioning files (`supabase/staging/010_*.sql`, `011_*.sql`) are structure only and never carry a password; do not edit them.

### 3.3 Admin sessions and admin users (row 5)

There is no bulk-revoke route (OPEN). Hosted SQL as owner:

```sql
UPDATE siton.admin_sessions SET revoked_at=now() WHERE revoked_at IS NULL;                -- all admins
UPDATE siton.admin_sessions SET revoked_at=now() WHERE admin_user_id='<id>' AND revoked_at IS NULL;  -- one admin
```

Password reset for cookie-login admins has no route: re-provision through the `scripts/create_admin_user.cjs` semantics (env-driven, hosted SQL). MFA re-enrolment needs `admin_users.manage`. Per-account login lockout (10 failures / 15 min, self-healing) and the per-challenge MFA cap (5) are the throttles you rely on while rotating.

### 3.4 Seller / buyer sessions (rows 4, 7)

Global kill = rotate `SELLER_SESSION_SECRET` (row 4) — accept that in-flight OTP tokens and buyer cookies on the fallback chain die too. Per seller: hosted SQL `UPDATE siton.seller_sessions SET revoked_at=now() WHERE seller_id=$1 AND revoked_at IS NULL;` (check the column contract first). Participant tracking tokens are not secret-derived; revoke per participant with `UPDATE siton.participant_tracking_tokens SET status='Revoked', revoked_at=now() WHERE participant_id=$1 AND status='Active';` and re-issue through the recovery flow (`docs/SECURITY_INCIDENT_RUNBOOK.md` §8).

### 3.5 Webhook secret (row 8)

1. `pause_charging_emergency` global (second approval) — a forged `charge_captured` is only dangerous for participants in `ChargeAttempt`.
2. Provider dashboard: rotate the endpoint secret. Set `PAYMENT_WEBHOOK_SECRET` (or `STRIPE_WEBHOOK_SECRET`) on Render web. Restart.
3. Audit: `SELECT provider, event_id, status, payload_jsonb->>'classification_reason', received_at FROM siton.webhook_events WHERE received_at > '<window-start>' ORDER BY received_at;` — any `processed` event with no matching `payment_attempts` correlation is a forged event; open a `PaymentMismatch` case and hand it to `docs/PAYMENT_RECONCILIATION_RUNBOOK.md` §4. Never delete the row.
4. Release the pause with a reason.

### 3.6 Storage broker key (row 15)

Order matters: generate → PR that updates `BROKER_KEY_SHA256` in `supabase/functions/storage-broker/index.ts` → deploy the function (OWNER ACTION) → set `SITON_STORAGE_BROKER_KEY` on both Render services → restart → upload proof. Between the function deploy and the Render update, uploads fail closed (`401 broker_unauthorized`); published imagery keeps serving.

### 3.7 Grow reference keyring rotation (row 10) — `scripts/grow_reference_reseal.cjs`

The adapter and the tool share one keyring format (`src/grow_payment_adapter.ts:276-279`): `GROW_REFERENCE_ENCRYPTION_KEY` (primary, ≥ 32 chars), optional `GROW_REFERENCE_ENCRYPTION_KEY_ID` (kid, `[A-Za-z0-9_-]{1,32}`; derived from the key when unset), `GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS` (comma-separated `key` or `kid:key`, decrypt-only). Sealed values are `grow_ref_v2.<kid>.<iv>.<tag>.<ct>` (or legacy `grow_ref_v1.…`, opened by trying every key).

Procedure (owner runs the tool from the operator machine against the hosted database; the tool refuses a non-local host without `--allow-hosted --yes`; `--apply` rewrites **only** `siton.payment_authorization_bindings.provider_reference`, compare-and-set inside one transaction; it never rewrites `authorization_id`/`replaced_authorization_id`/evidence columns and never calls the provider):

```bash
# 0. inventory under the CURRENT keyring (read-only; exit 3 if anything is UNOPENABLE — stop and investigate before changing keys)
DATABASE_URL="<hosted-owner-url>" GROW_REFERENCE_ENCRYPTION_KEY="<current>" \
  node scripts/grow_reference_reseal.cjs --allow-hosted --yes --json > grow-inventory-before.json
# 1. OWNER ACTION on Render (both services), then restart: 
#      GROW_REFERENCE_ENCRYPTION_KEY            = <new key>
#      GROW_REFERENCE_ENCRYPTION_KEY_ID         = <new kid>            (optional but recommended)
#      GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS  = <old kid>:<old key>  (keep the old key here)
#    From this point new seals use the new key; old references still open. No pause needed.
# 2. re-seal the operational lookup column under the new primary (dry run first, then --apply)
DATABASE_URL="<hosted-owner-url>" GROW_REFERENCE_ENCRYPTION_KEY="<new>" GROW_REFERENCE_ENCRYPTION_KEY_ID="<new kid>" \
GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS="<old kid>:<old key>" \
  node scripts/grow_reference_reseal.cjs --allow-hosted --yes                 # prints the inventory and "dry run; re-run with --apply"
DATABASE_URL="<hosted-owner-url>" GROW_REFERENCE_ENCRYPTION_KEY="<new>" GROW_REFERENCE_ENCRYPTION_KEY_ID="<new kid>" \
GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS="<old kid>:<old key>" \
  node scripts/grow_reference_reseal.cjs --allow-hosted --yes --apply --json > grow-reseal.json
#    APPLY {examined, resealed, already_current, unopenable, raced}: unopenable must be 0; raced rows are re-run.
# 3. retire the old key ONLY when the inventory says retire_safe[<old kid>] = true for EVERY column
#    (authorization_id / evidence columns keep their original seal until the rows age out).
```

Until `retire_safe` is true the old key stays in `GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS`; removing it early makes settle/refund/status on those rows fail with `grow_reference_invalid`. `tests/grow_payment_reference_keyring_validation.ts` proves the tool and the adapter interoperate. Staging has no Grow key today; this procedure is for the Grow activation stage.

### 3.8 Off-site backup keys (rows 22–23)

- DB role: a **dedicated read-only** role (SELECT on `siton`, `siton_inventory` only). Rotate with `ALTER ROLE <offsite-role> PASSWORD '<new>'` and update `OFFSITE_BACKUP_DATABASE_URL` in GitHub → Actions secrets. The workflow runs `pg_dump` under `PGOPTIONS=-c default_transaction_read_only=on`.
- S3 credential: a write-only key (PutObject/GetObject on the prefix; the restore-verify step needs GetObject). Rotate at the storage provider; update `OFFSITE_BACKUP_S3_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY`. List the bucket afterwards and reconcile object stamps against workflow run ids.
- age identity: generate a new one offline (`age-keygen -o <new-identity-file>`), store it where the old one was **not**, set the printed `age1…` public key as `OFFSITE_BACKUP_ENCRYPTION_PUBLIC_KEY`. Dispatch the workflow; decrypt the newest object with the new identity on the operator machine as proof; then decide on the old objects.

### 3.9 Supabase JWT secret / service role (row 12)

Rotating the JWT secret logs out every seller and admin using Supabase Auth and changes the anon key. Do it deliberately: announce to sellers, rotate, update `SUPABASE_ANON_KEY` on Render web if set, verify `GET /api/preview/auth-config`, then confirm the Edge Function still authenticates to Storage (upload proof).

### 3.10 GitHub and CI tokens (row 21)

Revoke at the issuer, issue new, update Actions secrets, run `.github/workflows/cloud-credential-preflight.yml` and read its per-secret table. Check the repository for unexpected branches, PRs, workflow edits and secret changes in the audit log; `npm run scan:secrets-history` on `master` afterwards.

## 4. Verification after any rotation (checklist)

```bash
npm run scan:secrets                                   # repo + history clean (masked fingerprints only)
npm run gate:runtime-env                               # every target's policy shape; service-role key absent; no postgres:// owner URL on staging/production
curl -s https://<web>/readiness                        # 200, runtime_role, client_ip, trust_proxy_hops
curl -s https://<web>/health/integrations              # provider posture unchanged (mockpay on staging)
node scripts/r3_hosted_proof.cjs --base-url=https://<web>   # no secret material in responses
node scripts/run_pg_query.cjs "select worker_id, status, heartbeat_at > now() - interval '30 seconds' as fresh from siton.worker_heartbeats order by heartbeat_at desc" "[]"
```

Plus the row-specific verify column. Record the result markers in the incident note; the rotation is not closed until the old value is confirmed dead at its source.

## 5. Open items

- OPEN: bulk session revocation route; admin password-reset route; tracking-token revoke surface.
- OPEN: `OTP_TOKEN_SECRET`, `BUYER_SESSION_SECRET`, `LINK_VIEWER_SESSION_SECRET` not declared in `render.yaml` (staging uses the fallback chain; the production gate FAILs without them) — OWNER ACTION to declare them.
- OPEN: no scripted Render/Supabase rotation; MCP connectors need interactive auth and are not part of this runbook.
- OPEN: the off-site read-only role and the write-only S3 policy are described, not yet provisioned (the workflow prints `OFFSITE_BACKUP_SKIPPED` until they exist).
