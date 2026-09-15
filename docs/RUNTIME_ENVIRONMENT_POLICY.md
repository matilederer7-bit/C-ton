# Runtime environment policy

Source of truth: `config/runtime-environment-policy.json`. Validator: `npm run gate:runtime-env` (`scripts/runtime_environment_gate.cjs`). Unsafe-combination proof: `npm run gate:startup-matrix` (`scripts/startup_config_matrix.cjs`, `config/startup-config-matrix.json`). Neither calls a provider, a database or the network.

The policy is release governance layered ON TOP of the boot-time guard in `src/production_guards.ts`. The runtime guard stays authoritative at process start; the policy catches what the runtime does not (see "Runtime gaps") and lets a release be refused before anything boots.

## Targets

| Target | Identity | Money | Notes |
|---|---|---|---|
| development | `APP_DEPLOYMENT_MODE` unset, `NODE_ENV` unset/development | mock | local Postgres; hosted `DATABASE_URL` is a warning |
| demo-preview | `APP_DEPLOYMENT_MODE=demo-preview` | mock only | mock provider and mode enforced; no live credential; no real notifications |
| test | `NODE_ENV=test` | mock only | `DISABLE_OUTBOX_WORKER=1`; `DATABASE_URL` must be local/CI-service (tests create and drop databases); `RENDER` absent |
| staging | `APP_DEPLOYMENT_MODE=staging` | mock only (`PAYMENT_PROVIDER=mockpay`, `PAYMENT_ENVIRONMENT` demo/sandbox) | `RUNTIME_ROLE`, `CANONICAL_POSTGRES_RUNTIME=1`, real secrets, Supabase Storage broker, no debug/test seams, rate limits on |
| production | `APP_DEPLOYMENT_MODE=production` | **BLOCKED** until `config/real-money-release-policy.json` is ALLOWED | every secret real and non-placeholder, explicit VAT, https public base, no seams; `PAYMENT_ENVIRONMENT=live` is refused by the governed rule |

Operators: `present`, `absent`, `equal`, `not_equal`, `one_of`, `not_one_of`, `matches`, `not_matches`, `not_placeholder`, `min_length`, `absent_or_equal`, `https_url`. Rules may be restricted to a `role` (`web` / `worker`). Secret-looking values are never echoed in failure messages.

## What MUST be true (production)

- real money disabled by default: `PAYMENT_ENVIRONMENT != live` (governed by the real-money policy; lifted only there)
- Grow live mode disabled: same rule; the runtime additionally refuses live credentials against the sandbox host
- `TRACKING_LEGACY_COMPAT` absent or `0` (legacy links disabled)
- `DEBUG_SURFACES_ENABLED` absent or `0`; `OTP_TEST_BYPASS_CODE` absent; `MOCK_SEED` absent
- `APP_DEPLOYMENT_MODE` is production (demo-only routes and demo seller context are off)
- `STORAGE_ADAPTER` is `object` or `supabase` (no local disk)
- secrets present and non-placeholder: `DATABASE_URL` (never superuser, never localhost), `ADMIN_API_KEY` (>= 24 chars), `SELLER_SESSION_SECRET` (>= 32), `BUYER_SESSION_SECRET`, `DISTRIBUTOR_SESSION_SECRET`, `OTP_HASH_SALT`, `PAYMENT_WEBHOOK_SECRET` (web)
- `SUPABASE_SERVICE_ROLE_KEY` ABSENT from every application runtime (it lives only inside the storage-broker Edge Function)
- `PUBLIC_BASE_URL` https; `LOG_LEVEL` not debug/trace; `DEBUG_SQL_LOGGING` / `DEBUG_JOIN_LOGGING` off; rate limits not `0`
- `RUNTIME_ROLE` declared; web has `DISABLE_OUTBOX_WORKER=1`, worker does not
- `SITON_VAT_MODE=explicit` with `SITON_VAT_RATE_PRODUCT` / `SITON_VAT_RATE_DELIVERY`
- `STRIPE_ALLOW_SERVER_SIDE_CARD_TOKENIZATION` off

## Reference configurations evaluated by `--all-targets`

| Source | Target | Result (2026-09-14) |
|---|---|---|
| `docker-compose.yml` app / worker | demo-preview | PASS |
| `docker-compose.ci.yml` web | test | PASS |
| `render.yaml` siton-staging-web / worker | staging | WARNING: `OTP_HASH_SALT` not declared (external secrets marked, not verified) |
| `.env.demo.example` | demo-preview | PASS |
| empty production env | production | negative control: 19 rules fail (gate is not vacuous) |

## Startup failure matrix (`config/startup-config-matrix.json`)

23 unsafe combinations. Each is run through the REAL boot guard (`scripts/probes/production_guards_probe.ts` executes `assertProductionRuntimeGuards`) and the release policy. Result on 2026-09-14: 20 PASS, 0 FAIL, 6 WARNING (documented runtime gaps, see below), plus three baselines proving the matrix is not vacuous: the fully live production baseline is ACCEPTED by the runtime guard and fails the release policy on exactly one rule (`REAL_MONEY_BLOCKED`).

Diagnostics are messages, never stack traces: the matrix fails a case whose runtime error contains stack frames.

## Runtime gaps (documented, NOT implemented on this branch)

These are cases the runtime accepts today; only the release gate refuses them. They are candidates for a future runtime hardening change owned by engineering, outside the isolation rules of this branch.

| Id | Where | Gap |
|---|---|---|
| OTP_HASH_SALT_DEFAULT_IN_PRODUCTION | `src/otp_rail.ts` `getOtpHashSalt()` | falls back to the literal `siton-otp-salt-default` in every mode; `production_guards` does not require it; `render.yaml` does not declare it (staging hashes OTP codes with the public salt) |
| NO_RUNTIME_CHECK_FOR_TRACKING_LEGACY_COMPAT | `src/participant_tracking_security.ts` | `TRACKING_LEGACY_COMPAT=1` re-enables legacy tracking links in production-like mode |
| DEBUG_SURFACES_ALLOWED_IN_PRODUCTION_WITH_KEY | `src/runtime_config.ts` | `DEBUG_SURFACES_ENABLED=1` + key activates `/debug/*` in any mode |
| production_unsafe_admin_key | `src/production_guards.ts` | only presence of `ADMIN_API_KEY` is required; the demo compose value passes the guard |
| production_demo_deployment_mode_bypass | `src/production_guards.ts` | a production host mislabelled `demo-preview` with mock money boots as a demo (demo seller context, mock routes, demo webhook secret) |
| production_otp_bypass | `src/otp_rail.ts` | `OTP_TEST_BYPASS_CODE` is inert in production-like mode but still accepted in the environment |
| production_service_role_key_present | (no reader) | nothing in the app reads `SUPABASE_SERVICE_ROLE_KEY`, so nothing can refuse its presence |

## How to use

```
npm run gate:runtime-env                       # every checked-in reference config
node scripts/runtime_environment_gate.cjs --env-file .env.production.local --role web
node scripts/runtime_environment_gate.cjs --render-service siton-staging-web --target staging --role web
node scripts/runtime_environment_gate.cjs --target production --json .release-artifacts/env-gate.json
npm run gate:startup-matrix
```

Exit 1 only when a FAIL rule is violated. `REAL_MONEY: BLOCKED/ALLOWED` and the open runtime gaps are printed on every run.
