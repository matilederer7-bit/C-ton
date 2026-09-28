# Configuration Outside Git — Inventory (Black-Sky E11)

Status: canonical inventory, 2026-09-27. Every setting that decides how Siton behaves but does **not** live in this repository: runtime environment variables and secrets, hosting-console settings, Supabase project settings, GitHub repository settings, and provider accounts. No value is recorded here — only the name, the owner, where it is set, how it is rotated, and whether the boot guard (`src/production_guards.ts`, run by `src/app.ts` and `src/worker.ts` at startup) refuses a bad value.

Related: `docs/ENVIRONMENT_CONTRACT.md` (per-variable semantics and defaults), `config/runtime-environment-policy.json` (pre-deploy release gate), `config/startup-config-matrix.json` (boot-guard failure matrix), `docs/LOCAL_RESTORE_CHECKLIST.md` (rebuilding a machine).

Legend — **Guard**: `BOOT` = the boot guard refuses a missing/unsafe value in production (and, where noted, on any hosted deployment); `GATE` = only the pre-deploy release gate checks it; `—` = not validated. **Owner**: `O` = owner (the only person with console access); `E` = engineering (may change via a reviewed PR). Rotation is always an owner console action and is never implied by an engineering task.

## 1. Render — Web (`siton-staging-web`) and Worker (`siton-staging-worker`)

Where set: Render dashboard → service → Environment. `render.yaml` declares the non-secret values; entries marked `sync: false` / `generateValue: true` exist only in the console.

| Variable | Web | Worker | Owner | Rotation | Guard |
|---|---|---|---|---|---|
| `DATABASE_URL` | ✅ `siton_web_login` | ✅ `siton_worker_login` | O | `ALTER ROLE … PASSWORD` in Supabase, then update both consoles; redeploy | BOOT (present) |
| `ADMIN_API_KEY` | ✅ generated | ✅ generated | O | Render "generate" → redeploy; bootstrap/read-only key only | BOOT (≥24, non-placeholder) |
| `SELLER_SESSION_SECRET` | ✅ generated | ✅ generated | O | regenerate → all seller sessions invalidate | BOOT (≥32, non-placeholder) |
| `OTP_HASH_SALT` | ✅ | ✅ | O | change invalidates pending OTP challenges only (≤10 min) | BOOT (present, not public default) |
| `OTP_TOKEN_SECRET` | **add** | **add** | O | change invalidates issued OTP proofs (≤15 min) | BOOT (≥32, distinct from `SELLER_SESSION_SECRET` and `OTP_HASH_SALT`) — Black-Sky E10 |
| `BUYER_SESSION_SECRET` | recommended | — | O | invalidates buyer resume cookies; falls back to `OTP_TOKEN_SECRET` when unset | GATE |
| `LINK_VIEWER_SESSION_SECRET` | optional | — | O | invalidates link-dashboard sessions | — |
| `SITON_STORAGE_BROKER_KEY` | ✅ | ✅ | O | new random key → put its SHA-256 in `supabase/functions/storage-broker/index.ts` (`BROKER_KEY_SHA256`), redeploy the function, then both consoles | BOOT (when `STORAGE_ADAPTER=supabase`) |
| `SITON_ADMIN_PROVISIONER_KEY` | ✅ web | ✅ web | O | new random key → put its SHA-256 in `supabase/functions/admin-provisioner/index.ts` (`PROVISIONER_KEY_SHA256`), redeploy the function, then the web console | — (only `POST /api/admin/team/admins` needs it; without it that route answers 503) |
| `STORAGE_ADAPTER`, `SUPABASE_URL`, `SUPABASE_STORAGE_BUCKET`, `OBJECT_STORAGE_PREFIX` | ✅ blueprint | ✅ blueprint | E | n/a (not secret) | BOOT (supabase adapter needs URL + key) |
| `SITON_OWNER_EMAIL` | console | — | O | n/a | — |
| `SITON_OWNER_AUTH_USER_ID` | **add** | — | O | only if the owner's Supabase auth user is recreated | BOOT in production when `SITON_OWNER_EMAIL` is set; on any hosted runtime the owner auto-claim is refused without it — Black-Sky B2 |
| `PUBLIC_BASE_URL` | recommended (custom domain) | optional | O | n/a | — (falls back to `RENDER_EXTERNAL_URL`; share page served `no-store` if neither) — Black-Sky B7 |
| `SENTRY_DSN` | console | console | O | Sentry project settings | — |
| `APP_DEPLOYMENT_MODE`, `RUNTIME_ROLE`, `CANONICAL_POSTGRES_RUNTIME`, `DISABLE_OUTBOX_WORKER` | ✅ blueprint | ✅ blueprint | E | n/a | BOOT (hosted: explicit, non-demo; role matches process; canonical runtime) |
| `PAYMENT_PROVIDER`, `PAYMENT_PROVIDER_MODE`, `PAYMENT_ENVIRONMENT` | blueprint (mock) | blueprint (mock) | O (switch to real money is an owner release decision) | n/a | BOOT + GATE + `config/real-money-release-policy.json` |
| `TRUST_PROXY_HOPS` | optional (`1`) | — | E | n/a | BOOT (integer 0–8) |
| `SELLER_CONTENT_ASSET_MAX_COUNT`, `SELLER_DEAL_IMAGE_MAX_COUNT`, `SELLER_DEAL_IMAGE_MAX_BYTES` | optional | — | E | n/a | — (positive integers; defaults 40 / 240 / 512 MiB) — Black-Sky B8 |
| `SUPABASE_SERVICE_ROLE_KEY` | **must be absent** | **must be absent** | O | — | BOOT (production) + GATE |
| `SUPABASE_MANAGEMENT_API_TOKEN` | **must be absent** | **must be absent** | O | — | BOOT (any hosted or production runtime) + GATE — Black-Sky E2 |
| `OTP_TEST_BYPASS_CODE`, `TRACKING_LEGACY_COMPAT`, `DEBUG_SURFACES_ENABLED`, `COMPLETION_WINDOW_MINUTES` | must be absent | must be absent | E | — | BOOT (production) |

Render service settings (console, not env): **Auto-Deploy = "After CI checks pass"** (blueprint `autoDeployTrigger: checksPass`, Black-Sky E8 — confirm in the console after the next blueprint sync), branch `master`, health check `/readiness`, plan/region, custom domain + TLS, deploy notifications. Owner: O.

### Grow (only when the owner authorises the Grow stage)

| Variable | Owner | Rotation | Guard |
|---|---|---|---|
| `GROW_USER_ID`, `GROW_PAGE_CODE`, `GROW_API_KEY` | O | Grow merchant console | BOOT (present, non-placeholder) |
| `GROW_REFERENCE_ENCRYPTION_KEY` | O | add the old key to `GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS` first, then replace | BOOT (≥32) |
| `GROW_REFERENCE_ENCRYPTION_KEY_ID` | O | set a new kid with each new primary key | BOOT (1–32 of `[A-Za-z0-9_-]`) — Black-Sky Grow leftover |
| `GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS` | O | remove a key only after every reference encrypted with it is settled | BOOT (comma list of `key` / `kid:key`, each ≥32, no empty entry, no placeholder, no kid naming two keys) |
| `PAYMENT_PROVIDER_BASE_URL`, `GROW_SUCCESS_URL`, `GROW_CANCEL_URL`, `GROW_NOTIFY_URL` | O | n/a | BOOT (https; sandbox/live host pinning) |

### Invoice and notification providers (not active)

`INVOICE_PROVIDER*`, `INVOICE_WEBHOOK_SECRET`, `NOTIFICATION_PROVIDER*`, `NOTIFICATION_DELIVERY_ENABLED`, `TWILIO_*`, `PAYOUT_PROVIDER*` — owner O, rotated in the provider console. Guard: BOOT refuses `NOTIFICATION_PROVIDER_MODE=real` with any non-log provider and `NOTIFICATION_DELIVERY_ENABLED=1` without real mode; invoice/payout credentials are GATE-only. No real communications or invoice adapter is live.

## 2. Supabase (project `siton-staging`, eu-central-1)

| Setting | Where | Owner | Notes / rotation |
|---|---|---|---|
| Database password, `siton_web_login` / `siton_worker_login` passwords | Dashboard → Database; `ALTER ROLE` | O | rotate → update Render `DATABASE_URL` for that service |
| JWT signing keys (asymmetric, JWKS) | Dashboard → Auth → Signing keys | O | the runtime fetches JWKS; rotate with the standby-key flow |
| Anon / publishable key | Dashboard → API | O | public by design |
| Service-role key | Dashboard → API | O | used only by the `storage-broker` Edge Function runtime (injected by the platform); never in Render |
| **Auth → "Confirm email" enabled** | Dashboard → Auth → Providers → Email | O | **UNCONFIRMED from the repository.** Black-Sky B2 no longer depends on it on hosted runtimes (the owner claim requires `SITON_OWNER_AUTH_USER_ID`), but self-service seller bindings still assume confirmed e-mails. Owner check: confirm it is ON. |
| Auth → third-party / OAuth providers | Dashboard → Auth → Providers | O | any provider that asserts unverified e-mails must stay disabled |
| Auth → anonymous sign-ins | Dashboard → Auth | O | keep OFF (anonymous tokens are refused for provisioning regardless) |
| Auth → Site URL / redirect allow-list, MFA for the owner dashboard account | Dashboard → Auth / Account | O | console only |
| Edge Function `storage-broker` + secret `SITON_BROKER_ALLOWED_PREFIXES` | `supabase functions deploy storage-broker`; Dashboard → Edge Functions → Secrets | O | default `staging`; set to the deployment namespace(s) actually used (`OBJECT_STORAGE_PREFIX`) — Black-Sky E5; requires a redeploy of the function |
| Storage bucket `deal-images` (public read) | Dashboard → Storage | O | `supabase/staging/004`, `015` |
| Grants / roles | `supabase/staging/*.sql` (in Git) | E | applied by the owner through the SQL editor / MCP |
| Management API token (compute add-ons) | Supabase account → Access tokens | O | **owner tooling / CI only**; never in Render (boot guard refuses it) — Black-Sky E2 |
| Metrics secret key (`SUPABASE_METRICS_SECRET_KEY`), `SUPABASE_PROJECT_REF` | Render console (optional) | O | read-only metrics; rotate in Dashboard → API |
| Backups / PITR | Dashboard → Database → Backups | O | platform feature; the repository rehearses restore only |

## 3. GitHub repository `matilederer7-bit/C-ton`

| Setting | Where | Owner | Notes |
|---|---|---|---|
| Actions secrets `SITON_AGENT_GITHUB_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` | Settings → Secrets → Actions | O | cloud agent manager / swarm; see `docs/CLOUD_AGENT_MANAGER.md`; token expiry = rotation |
| `STRIPE_SANDBOX_SECRET_KEY`, `STRIPE_SANDBOX_PUBLISHABLE_KEY`, `STRIPE_SANDBOX_WEBHOOK_SECRET` | same | O | sandbox proof workflow only |
| `OFFSITE_BACKUP_DATABASE_URL`, `OFFSITE_BACKUP_ENCRYPTION_PUBLIC_KEY`, `OFFSITE_BACKUP_S3_{ACCESS_KEY_ID,SECRET_ACCESS_KEY,BUCKET,ENDPOINT,PREFIX,REGION}` | same | O | `offsite-db-backup.yml`; the private decryption key never enters GitHub |
| Branch protection on `master` (required checks: backend gates, release readiness, web runtime depth) | Settings → Branches | O | Render deploys on `checksPass`, so the required-check set is also the deploy gate |
| Dependabot alerts + security updates | Settings → Code security | O | `.github/dependabot.yml` (npm, web, docker, actions) — Black-Sky E9 |
| Secret scanning / push protection | Settings → Code security | O | complements `scripts/git_history_secret_scan` |
| Default workflow token permissions = read | Settings → Actions | O | workflows request write explicitly |

## 4. Local and CI-only variables

`TEST_FILE_PATTERN`, `SITON_TEST_DB_ALLOWED_HOSTS`, `SITON_PRESERVE_TEST_DB`, `SITON_RELEASE_ARTIFACTS_DIR`, `SITON_*` agent-router variables, `STATUS_*`, `DR_BASE_URL`, `SITON_ACCEPTANCE_*` — CI / operator tooling; never set on Render. `MOCK_SEED`, `OTP_TEST_BYPASS_CODE`, `DEBUG_*` — local/test only (production boot refuses the dangerous ones).

## 5. Owner action list created by the Black-Sky hardening track

1. Render (both services): add `OTP_TOKEN_SECRET` — a new random value ≥32 characters, different from every other secret.
2. Render (web): add `SITON_OWNER_AUTH_USER_ID` = the owner's Supabase `auth.users.id` (Dashboard → Authentication → Users). Until then a *first-time* owner auto-claim is refused on the hosted runtime; an existing bound owner keeps working.
3. Render (both services): confirm `SUPABASE_MANAGEMENT_API_TOKEN` is **not** set (the service will refuse to boot if it is); keep that token in owner tooling only and rotate it if it was ever set on Render.
4. Render (web): set `PUBLIC_BASE_URL` to the canonical public origin once a custom domain is used.
5. Render: after the blueprint sync, confirm Auto-Deploy shows "After CI checks pass" for both services.
6. Supabase: set the `storage-broker` function secret `SITON_BROKER_ALLOWED_PREFIXES` (default `staging`) and redeploy the function from this repository.
7. Supabase: confirm Auth → Email → "Confirm email" is ON and no provider asserting unverified e-mails is enabled.
8. GitHub: enable Dependabot security updates; keep `master` branch protection requiring the CI checks.
