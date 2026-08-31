# Environment Contract

Status: contract documented. The application reads all configuration from environment variables. No secrets are committed to the repository. No `.env` files are baked into Docker images.

## Verdict

- `env_contract_documented`: yes
- `secrets_in_repo`: no
- `env_in_image`: no (`.dockerignore` excludes `.env*`, Dockerfile defense-in-depth deletes any that slipped through)
- `production_like_fail_closed`: yes for `ADMIN_API_KEY`, `PAYMENT_WEBHOOK_SECRET` in live mode

## Modes

The application observes three runtime modes:

| Mode | How detected | What it means |
|---|---|---|
| `demo` / `demo-preview` | `APP_DEPLOYMENT_MODE=demo-preview` (default) | Mock providers, demo admin key allowed, in-memory rate limit accepted, single instance. **No live money.** |
| `sandbox` | `APP_DEPLOYMENT_MODE=production` + provider envs pointing to provider sandbox | Real provider sandbox calls, no real charges. |
| `live` / `real` | `APP_DEPLOYMENT_MODE=production` + provider envs pointing to live keys | Real money. Requires Provider Sandbox / Live Money Validation gate to be closed. **Currently blocked.** |

Production-like detection (`isProductionLikeEnv` in [`src/runtime_config.ts`](../src/runtime_config.ts)):

```
NODE_ENV === "production"
|| APP_ENV === "production"
|| RENDER === "true"
|| RENDER_EXTERNAL_URL is set
```

`RENDER` and `RENDER_EXTERNAL_URL` remain compatibility-only detection inputs
for the quarantined portable runtime. They do not select or describe the
canonical production architecture. In production-like mode, missing critical
envs must fail closed rather than fall back to demo defaults silently.

## Variables

Legend:
- **Required**: ✅ required, ⚠ required in production-like, ⬜ optional
- **Secret**: 🔒 must come from secret store (Secrets Manager / SSM / Render env), 📄 non-secret config

| Env | Required (demo) | Required (sandbox) | Required (live) | Secret | Default | Purpose |
|---|---|---|---|---|---|---|
| `APP_DEPLOYMENT_MODE` | ✅ | ✅ | ✅ | 📄 | `demo-preview` | Selects runtime mode. |
| `NODE_ENV` | ✅ | ✅ | ✅ | 📄 | — / `production` in container | Standard Node mode flag. |
| `HOST` | ⬜ | ⬜ | ⬜ | 📄 | `0.0.0.0` | Bind address. |
| `PORT` | ✅ | ✅ | ✅ | 📄 | `3000` | TCP port. |
| `LOG_LEVEL` | ⬜ | ⬜ | ⬜ | 📄 | `info` | Pino log level. |
| `DATABASE_URL` | ✅ | ✅ | ✅ | 🔒 | local fallback | Postgres connection string. Live mode must point to a managed Postgres. |
| `DB_SCHEMA` | ⬜ | ⬜ | ⬜ | 📄 | `siton` | Schema name. |
| `EXPECTED_COMMIT_SHA` | ⬜ | ⚠ | ⚠ | 📄 | — | Mission Control reports drift if deployed sha doesn't match. |
| `ADMIN_API_KEY` | ⬜ | ⚠ | ⚠ | 🔒 | — | Admin route gate. Demo accepts empty; production-like blocks. |
| `DEBUG_SURFACES_ENABLED` | ⬜ | ⬜ (off recommended) | ⬜ (off required) | 📄 | `0` | Toggles `/debug/*` surfaces. |
| `DEBUG_SURFACES_ACCESS_KEY` | ⬜ | ⚠ if enabled | ⚠ if enabled | 🔒 | — | Required when `DEBUG_SURFACES_ENABLED=1`. |
| `PAYMENT_PROVIDER` | ✅ | ✅ | ✅ | 📄 | `mockpay` | Selects payment adapter. `stripe` is the first live adapter. |
| `PAYMENT_PROVIDER_MODE` | ✅ | ✅ | ✅ | 📄 | `mock-backed` | Mode for the chosen provider. |
| `PAYMENT_ENVIRONMENT` | ⬜ | ⚠ | ✅ | 📄 | `demo` | `sandbox` requires Stripe test credentials; production requires `live`. |
| `PAYMENT_PROVIDER_BASE_URL` | ⬜ | ⚠ for live | ⚠ for live | 📄 | — | |
| `PAYMENT_PROVIDER_API_KEY` | ⬜ | ⚠ | ⚠ | 🔒 | — | Provider API key. |
| `PAYMENT_PROVIDER_PUBLIC_KEY` | ⬜ | ⚠ | ⚠ | 🔒 | — | Provider public key (e.g. Stripe `pk_*`). |
| `PAYMENT_PROVIDER_TIMEOUT_MS` | ⬜ | ⬜ | ⬜ | 📄 | `8000` | Provider HTTP timeout. |
| `PAYMENT_PROVIDER_RELEASE_PATH` | ⬜ | ⬜ | ⬜ | 📄 | `/release` | Generic provider-ready compatibility path; Stripe uses PaymentIntent cancel. |
| `PAYMENT_PROVIDER_STATUS_PATH` | ⬜ | ⬜ | ⬜ | 📄 | `/status` | Generic provider-ready compatibility path; Stripe retrieves PaymentIntent/Refund. |
| `PAYMENT_PROVIDER_CURRENCY` | ⬜ | ⬜ | ⬜ | 📄 | `ILS` | |
| `PAYMENT_WEBHOOK_PROVIDER` | ✅ | ✅ | ✅ | 📄 | matches `PAYMENT_PROVIDER` | |
| `PAYMENT_WEBHOOK_SECRET` | ⬜ (`mock-webhook-secret`) | ⚠ | ⚠ | 🔒 | demo default in demo-preview | Live requires a real provider webhook secret. |
| `STRIPE_ALLOW_SERVER_SIDE_CARD_TOKENIZATION` | ⬜ | ⬜ | ⬜ (`0` recommended) | 📄 | `0` | Compliance posture flag. |
| `PAYOUT_PROVIDER` | ✅ | ✅ | ✅ | 📄 | `internal-ledger` | |
| `PAYOUT_PROVIDER_MODE` | ✅ | ✅ | ✅ | 📄 | `internal-truth-only` | |
| `PAYOUT_PROVIDER_API_KEY` | ⬜ | ⚠ if external | ⚠ if external | 🔒 | — | |
| `INVOICE_PROVIDER` | ⬜ | ⬜ | ⚠ | 📄 | unset | `morning` is the first live invoice adapter. |
| `INVOICE_PROVIDER_MODE` | ⬜ | ⬜ | ⚠ | 📄 | unset | |
| `INVOICE_PROVIDER_BASE_URL` | ⬜ | ⬜ | ⚠ | 📄 | unset | |
| `INVOICE_PROVIDER_API_KEY` | ⬜ | ⚠ | ⚠ | 🔒 | — | |
| `INVOICE_PROVIDER_BEARER_TOKEN` | ⬜ | ⚠ | ⚠ | 🔒 | — | |
| `INVOICE_WEBHOOK_SECRET` | ⬜ | ⚠ | ⚠ | 🔒 | — | |
| `NOTIFICATION_PROVIDER` | ✅ | ✅ | ✅ | 📄 | `log-only` | `twilio` / similar require their own envs. |
| `TWILIO_ACCOUNT_SID` | ⬜ | ⚠ if Twilio | ⚠ if Twilio | 🔒 | — | |
| `TWILIO_AUTH_TOKEN` | ⬜ | ⚠ if Twilio | ⚠ if Twilio | 🔒 | — | |
| `TWILIO_FROM` | ⬜ | ⚠ if Twilio | ⚠ if Twilio | 📄 | — | E.164 sender. |
| `NOTIFICATION_MAX_ATTEMPTS` | ⬜ | ⬜ | ⬜ | 📄 | `3` | |
| `SELLER_SESSION_SECRET` | ⬜ (demo skips) | ⚠ | ⚠ | 🔒 | — | Required for non-demo seller sessions. |
| `BUYER_SESSION_SECRET` | ⬜ (local-only fallback) | ⚠ | ⚠ | 🔒 | — | Signs deal-bound HttpOnly buyer sessions used only for safe server-side resume. |
| `DISTRIBUTOR_SESSION_SECRET` | ⬜ (demo context) | ⚠ | ⚠ | 🔒 | — | Required for non-demo distributor sessions and tenant resolution. |
| `SITON_PLATFORM_FEE_VAT_RATE` | ⬜ | ⬜ | ⬜ | 📄 | `0.18` | |
| `COMPLETION_WINDOW_MINUTES` | ⬜ | ⬜ | ⬜ | 📄 | `1440` | C6 spec — 24 h. |
| `OUTBOX_POLL_MS` | ⬜ | ⬜ | ⬜ | 📄 | `1000` | |
| `OUTBOX_MAX_ATTEMPTS` | ⬜ | ⬜ | ⬜ | 📄 | `4` | |
| `DISABLE_OUTBOX_WORKER` | ⬜ | ⬜ | ⬜ | 📄 | unset | Set `1` when running a dedicated worker container. |
| `RATE_LIMIT_MAX` | ⬜ | ⬜ | ⬜ | 📄 | adapter default | `0` disables. |
| `RATE_LIMIT_WINDOW_MS` | ⬜ | ⬜ | ⬜ | 📄 | adapter default | |
| `MOCK_SEED` | ⬜ (demo only) | ⬜ | ⬜ | 📄 | unset | |
| `UPLOAD_DIR` / `DEAL_IMAGE_UPLOAD_DIR` | ⬜ | ⬜ | ⬜ | 📄 | `uploads/deal-images` | Writable local/demo image directory; `DEAL_IMAGE_UPLOAD_DIR` takes precedence. Production uses object storage. |
| `SUPABASE_PROJECT_REF` | ⬜ | ⬜ | ⚠ for hosted metrics/compute | 📄 | unset | Hosted project identifier; never treated as a credential. |
| `SUPABASE_METRICS_SECRET_KEY` | ⬜ | ⬜ | ⚠ for hosted metrics | 🔒 | unset | Dedicated Secret API key used server-side for the Prometheus-compatible Metrics API. |
| `SUPABASE_METRICS_TIMEOUT_MS` | ⬜ | ⬜ | ⬜ | 📄 | `5000` | Bounded hosted-metrics request timeout. |
| `SUPABASE_MANAGEMENT_API_TOKEN` | ⬜ | ⬜ | ⚠ only for compute approval | 🔒 | unset | PAT/OAuth token for billing add-on read/update; never sent to the browser. |
| `SUPABASE_MANAGEMENT_TIMEOUT_MS` | ⬜ | ⬜ | ⬜ | 📄 | `5000` | Bounded Management API read/update timeout. |
| `SUPABASE_COMPUTE_MANAGEMENT_ENABLED` | ✅ | ✅ | ✅ | 📄 | `false` | Explicit feature flag for a human-approved one-tier compute upgrade. Monitoring remains active when false. |
| `INFRA_*_WARNING` / `INFRA_*_CRITICAL` / `INFRA_*_WINDOW_MINUTES` | ⬜ | ⬜ | ⬜ | 📄 | documented defaults | Central overrides for sustained health thresholds; see `INFRASTRUCTURE_HEALTH_AND_CAPACITY.md`. |

### Grow and mobile activation additions

When `PAYMENT_PROVIDER=grow` (or `PAYMENT_PROVIDER_MODE=grow`), the server-side
adapter additionally requires externally provisioned `GROW_USER_ID`,
`GROW_PAGE_CODE`, a minimum-32-character `GROW_REFERENCE_ENCRYPTION_KEY`, and
credential-free HTTPS `GROW_SUCCESS_URL`, `GROW_CANCEL_URL`, and
`GROW_NOTIFY_URL`. `GROW_API_KEY` and the `GROW_*_PATH` overrides are supplied
only when the provisioned Grow contract requires them. Missing production
configuration fails closed; none of these values belongs in a browser bundle.

Native packaging uses non-secret build inputs `SITON_APP_ID`,
`SITON_APP_LINK_HOST`, and `SITON_API_BASE_URL`. The checked-in defaults end in
`.invalid` or use the preview bundle identifier and therefore cannot silently
be mistaken for store-release configuration.

## Failure modes

When a required env is missing in production-like mode the relevant readiness section reports `blocked`:

| Missing env | Surface | Blocker code |
|---|---|---|
| `DATABASE_URL` | mission-control / `accordion_scaling_readiness` | `database_url_missing` |
| `ADMIN_API_KEY` (in production-like) | mission-control / `security` | `admin_key_missing_in_production_like_env` |
| `PAYMENT_WEBHOOK_SECRET` (in live) | mission-control / `live_money_readiness` | `payment_webhook_secret_missing_for_live` |
| `STRIPE_SECRET_KEY` (when stripe selected) | mission-control / `live_money_readiness` | `payment_provider_not_live_validated` |
| `INVOICE_PROVIDER_API_KEY` (in live with `INVOICE_PROVIDER=morning`) | mission-control / `live_money_readiness` | `invoice provider not externally issuing live tax documents` (warning) |

Demo defaults are accepted **only** in demo-preview mode and only when documented as such (e.g. `mock-webhook-secret`).

## Mission Control posture

Mission Control reports environment posture as **configured: true / false**, never as raw values. Specifically:

- `mission_control.security.admin_auth.configured`
- `mission_control.live_money_readiness.secret_policy[*].configured`
- `mission_control.security.debug_surfaces.access_key_configured`
- `mission_control.accordion_scaling_readiness.external_db_ready`

No env value is logged, surfaced, or returned by any admin endpoint.

## Where envs live in deployment

| Tier | Source |
|---|---|
| Tier 0 — local | `.env` (gitignored) for local dev. Compose hardcodes demo defaults inline. |
| Tier 1 — small market launch | Base44 secret/environment configuration plus the approved Supabase secret boundary. |
| Tier 2 — accordion scale | Same canonical Base44 + Supabase boundary plus rotation policy and least-privilege access. |
| Tier 3 — mature production | Plus annual rotation, audit log, optional SIEM forwarding. |

## Anti-patterns explicitly forbidden

- Committing `.env` / `.env.local` / `.env.production` / `.env.real` to the repository.
- Baking `.env` into the Docker image (`.dockerignore` excludes them; Dockerfile deletes any that slipped through).
- Logging env values.
- Returning env values from any admin / mission-control / control-plane endpoint.
- Falling back from real-mode to demo defaults silently when a required env is missing.

## Cross-references

- [`src/runtime_config.ts`](../src/runtime_config.ts) — single source of truth for env reads.
- [DOCKER_READINESS.md](DOCKER_READINESS.md) — what envs the container needs.
- [AWS_ACCORDION_DEPLOYMENT_BLUEPRINT.md](AWS_ACCORDION_DEPLOYMENT_BLUEPRINT.md) — env per tier.
- [PROVIDER_LIVE_MONEY_READINESS.md](PROVIDER_LIVE_MONEY_READINESS.md) — required envs before live money.
- [PRODUCTION_LAUNCH_READINESS.md](PRODUCTION_LAUNCH_READINESS.md) — full launch checklist.

## External object storage (Stage 5a)

`STORAGE_ADAPTER=object` selects the canonical S3-compatible adapter. Web and Worker must receive `OBJECT_STORAGE_REGION`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_ACCESS_KEY_ID`, and `OBJECT_STORAGE_SECRET_ACCESS_KEY` from the deployment secret manager. `OBJECT_STORAGE_ENDPOINT` is optional for AWS and required for a custom compatible provider; `OBJECT_STORAGE_FORCE_PATH_STYLE=1` is intended for compatible services such as MinIO. `OBJECT_STORAGE_PREFIX` separates sandbox and production object namespaces. Production rejects local storage and object mode fails closed on missing or placeholder configuration. See `docs/STORAGE_PRODUCTION_FOUNDATION.md` for the security, rotation and cleanup contract.

## Canonical Supabase Storage (R7)

`STORAGE_ADAPTER=supabase` selects the canonical staging/production media authority: Supabase Storage bucket `deal-images`, reached exclusively through the `storage-broker` Edge Function (`supabase/functions/storage-broker/index.ts`). Required env: `SUPABASE_URL` and `SITON_STORAGE_BROKER_KEY` (fail-closed on missing/placeholder). Optional: `SITON_STORAGE_BROKER_URL` (defaults to `${SUPABASE_URL}/functions/v1/storage-broker`), `SUPABASE_STORAGE_BUCKET` (default `deal-images`), `OBJECT_STORAGE_TIMEOUT_MS` (default 15000 for broker mode), and `OBJECT_STORAGE_PREFIX` for the key namespace. Security contract: the Supabase service-role key never leaves the Edge Function runtime; the Render services hold only the broker key, whose SHA-256 digest is pinned inside the deployed function; the browser holds no storage credential at all. Published deal imagery is served from the public storage CDN (`/storage/v1/object/public/deal-images/...`, immutable cache); Draft imagery stays private behind the authenticated `/api/deal-images/:id` proxy. Rotation: generate a new key, update the digest in the broker source, redeploy the function, then update `SITON_STORAGE_BROKER_KEY` on both Render services.
