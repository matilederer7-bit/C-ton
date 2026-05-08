# Horizontal Scale Readiness

Status: foundation added, not full multi-instance readiness.

## Verdict

Overall: `partial`

Siton is closer to running behind a load balancer because the main authorities for sessions, OTP, idempotency, and outbox work are DB-oriented. It is not ready to be presented as fully multi-instance until the blockers below are closed.

## Scale Readiness Contract

Admin Mission Control now includes `scale_readiness`:

- `stateless_api`
- `in_memory_state_risks`
- `otp_scale_status`
- `rate_limit_scale_status`
- `storage_scale_status`
- `worker_parallelism_status`
- `idempotency_scale_status`
- `db_pool_status`
- `load_balancer_readiness`
- `blockers[]`

## In-Memory State Inventory

- `rateLimitStore`: classification `B`, non-business truth, scale-sensitive, `single_instance_only`.
- `legacyPhoneByChallenge`: classification `B`, legacy compatibility shim. Canonical OTP authority is DB-backed `otp_challenges`.
- immutable constants and static Sets are acceptable.

No new Redis or memory cache was added.

## Auth And Sessions

Seller session authority is DB-backed in non-demo mode through `siton.seller_sessions` and token hash lookup. Demo-preview seller context remains demo-only.

Admin auth is still environment-key based and suitable for demo/basic operations, not full production identity or MFA.

## Storage

Deal image storage uses local filesystem via `product_image_storage`.

Current safeguards:

- MIME allowlist
- 5 MB size limit
- path traversal protection through resolved-path checks

Blocker before multi-instance:

- `object_storage_required_before_multi_instance`

## Workers And Idempotency

Outbox claiming uses `FOR UPDATE SKIP LOCKED` and sets `processing_started_at`, with reclaim support for stuck processing events. This is a good foundation for parallel workers.

Idempotency is DB-backed through `idempotency_log`. Full production scale still requires live load testing under concurrent traffic and deployment-level DB connection limits.

## Load Balancer Readiness

Readiness is partial. `/health` exists, and Mission Control reports DB and operational readiness signals. Full load balancer readiness should require a stricter readiness endpoint that fails closed when DB/schema/config requirements are missing in production-like mode.

## Cost And Autoscaling Guardrails

Do not implement autoscaling inside the app. Before multi-instance deployment, configure cloud-side max instances, DB connection alerts, error-rate alerts, traffic anomaly alerts, WAF/DDoS controls, and bot abuse protection.

## Validation

- `npm run test:scale-readiness` passed.
- No migration was added.
- No state machine or money logic was changed.
