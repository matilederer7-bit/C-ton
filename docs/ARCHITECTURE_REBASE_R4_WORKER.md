# SITON ARCHITECTURE REBASE — R4 CONTINUOUS FENCED WORKER

Date: 2026-08-31 (overnight run)

Target: a separate continuously running Render Background Worker using its
own dedicated external LOGIN identity (`siton_worker_login`) that adopts the
audited `siton_worker_runtime` profile, against Supabase `siton-staging`
(`hnptacfzuqebfgeshadq`, eu-central-1). Base44 is absent from this path.

## Status

`R4_REPOSITORY_READY` for everything repository-controlled; hosted staging
role provisioning and the paid Render Worker deployment remain gated (see
"Cost gate" and "Hosted blockers").

## R4A — Worker database identity

`supabase/staging/011_r4_worker_login_provisioning.sql` provisions the
Worker login exactly symmetric to the R3 Web design and contains no secret:

- `siton_worker_login`: LOGIN, NOINHERIT, no admin/BYPASSRLS flags, zero
  direct object privileges, CONNECT only.
- `GRANT siton_worker_runtime TO siton_worker_login WITH SET TRUE, INHERIT
  FALSE, ADMIN FALSE` — SET-only adoption of the audited profile.
- `ALTER ROLE siton_worker_login SET role = 'siton_worker_runtime'` — every
  session adopts the Worker profile server-side, pooler-safe.
- Self-asserting safety block, including both cross-guards:
  `siton_worker_login` must not hold the Web profile and `siton_web_login`
  must not hold the Worker profile; both R2 profiles must remain NOLOGIN.
- Until the external `ALTER ROLE siton_worker_login PASSWORD '...'` runs, the
  role cannot authenticate. Web and Worker credentials are separate secrets.

Proven by `tests/r4_worker_login_provisioning_validation.ts`: replay of
staging 001+006–011 with an idempotent double-apply of 011, every role-flag /
membership / session-default / zero-grant invariant, catalog-level
cross-profile separation in both directions, worker-profile readiness boot
(`assertWorkerDatabaseReady`), and the Web readiness check refusing the
Worker identity.

Not applied to hosted staging: this session has no authenticated Supabase
channel (same blocker as R3 steps 1–2).

## R4B — Boot contract

`src/worker.ts` (unchanged tonight): bounded ready-wait against a migrated
database, heartbeat writer with status transitions
starting/ready/draining/stopped, poll loop with per-cycle error containment,
SIGTERM/SIGINT drain with `WORKER_SHUTDOWN_TIMEOUT_MS`, control pool separate
from the app pool. Fencing lives in the database, so a shutdown that
overruns the drain window strands nothing: leases expire and are reclaimed.

Hardened tonight:

- `src/production_guards.ts`: a declared `RUNTIME_ROLE` that does not match
  the starting process now fails closed in EVERY mode, not only production.
  A staging Worker misconfigured as `web` (or vice versa) refuses to boot.
  (`tests/security_production_guards_validation.ts` extended.)
- `src/db.ts`: the shared application pool is labeled from `RUNTIME_ROLE`,
  so a Worker deployment appears as `siton-worker-runtime` in
  `pg_stat_activity` instead of masquerading as the Web pool. Idle-pool
  error absorption (R3 fix) applies to every pool the Worker uses.
- `src/schema_contract.ts` (committed earlier tonight): startup schema
  failures are SQLSTATE-routed, so a wrong Worker DATABASE_URL identity is
  reported as denied access, never as "schema missing".

## R4C/R4D — Leases, fencing and the two-process proof

In-process adversarial coverage already existed and passes
(`outbox_worker_recovery_validation`, `outbox_reclaim_precision_proof`,
`outbox_worker_failure_recovery_validation`, `worker_separation_validation`,
`operational_hardening_proof`): generation fencing on claim/heartbeat/
completion/failure, the `outbox_processing_requires_fenced_lease` DB
constraint, 20-reclaimers/20-claimers exactly-one ownership, stale-owner
completion rejection after transaction BEGIN, DLQ archival at the attempt
cap, poison-row quarantine, admin requeue fencing.

New tonight — `tests/worker_two_process_fencing_validation.ts` runs TWO REAL
`src/worker.ts` processes against one database (synthetic `deadline_check`
jobs on Draft deals; a held ACCESS EXCLUSIVE lock creates deterministic
long-running handlers):

- 30 competing jobs complete exactly once across two live workers.
- Both workers hold blocked active ownership 3+3; heartbeats keep the
  blocked survivor's leases valid past a full lease window while the
  SIGKILLed owner's leases expire without heartbeats.
- The survivor reclaims the dead owner's jobs; exactly-once completion is
  proven from the lifecycle audit (one `completion` row per event).
- SIGTERM during active ownership, then a fresh worker process finishes the
  queue with no duplicate completion (graceful drain exit is asserted on
  POSIX; Windows delivers a forced kill, which the same invariants cover).
- Poison inputs: an unknown event type cannot even enter the queue (the
  `outbox_events_event_type_check` constraint fails closed at insert;
  `workerProcessEvent`'s PermanentFailError stays as defense-in-depth), and a
  malformed payload is DLQ-archived on first attempt with no crash-loop.
- `pg_terminate_backend` of every worker connection: the process survives,
  reconnects and completes new jobs.
- Final: 44/44 synthetic jobs sent exactly once, DLQ 0, processing residue
  0, and no worker log line contains credential material.

## R4E/R4F — Idempotency and money invariants

Existing suite evidence (all green in tonight's full run): platform fee
exactly 8% on product+delivery excluding buyer VAT
(`platform_fee_payments_8_percent_validation`), server-side money authority,
payout rail without any distributor payout lane, refund policy, provider
UNKNOWN entering reconciliation instead of user-visible state
(`payment_recovery_real_rail_validation`, reconciliation validations),
notification/invoice/storage-cleanup idempotency lanes, retry backoff and
DLQ bounds (`operational_hardening_proof` R3 scenario).

Verified finding (spec alignment, open): the constitution's "maximum 3
charge attempts per participant/deal per 30 minutes" is enforced
STRUCTURALLY, not as a literal time-windowed counter: outbox attempt caps
(effective max ≤ 4) with exponential backoff capped at 15 minutes, DLQ
after exhaustion, money-state machine exits `ChargeAttempt` on terminal
results, and UNKNOWN routes to reconciliation. No unbounded retry storm is
possible, but the literal 3-per-30-minutes window is not encoded anywhere.
Decision deferred to a spec-led change with its own tests; not altered
overnight.

## R4G — Failure matrix mapping

| Failure | Evidence |
| --- | --- |
| DB unavailable on startup | `worker.ts` bounded ready-wait; R3 validation boot retries |
| DB loss while idle / during job; recovery | two-process proof P4; `db_transaction_fault_validation`; r3 pool-kill proof |
| Malformed payload / unknown job type | unknown type rejected by the event_type CHECK at insert; malformed payload `PermanentFailError` → DLQ on first attempt (two-process proof P3b) |
| Handler throw / timeout | per-cycle containment; statement/query timeouts; retry/backoff proofs |
| Lease loss mid-handler | heartbeat-ownership loss → `lease_lost` result, no ack (in-process proofs) |
| Duplicate delivery / replay | idempotency-key proofs (`concurrency_proof` I-series, webhook/idempotency suites) |
| Provider timeout / UNKNOWN (synthetic) | payment recovery/reconciliation validations |
| Retry exhaustion → DLQ | `operational_hardening_proof` R3; `outbox_worker_recovery_validation` |
| SIGTERM / restart | two-process proof P3; `web_sigterm_fault_process_validation` pattern |
| Hard process death | two-process proof P2 (SIGKILL, fenced, reclaimed) |
| Stale fencing token | generation-fenced completion rejection proofs; DB constraint |
| Terminal deal state / late job | `deadline_check` no-op lane; cutover quarantine proofs; late-result guards |

## R4H — Observability

Worker cycle logs carry worker_id, jobs completed/failed/lease-lost, retry
count, queue depth, processing, stale leases, DLQ count, latency. Lifecycle
audit rows carry worker identity, lease generation, attempt, from/to status,
reason code, and hashed (never raw) evidence fields. Failure paths log
SQLSTATE/error codes only. The two-process proof asserts no credential
material reaches worker stdout/stderr. `DATABASE_URL` is never logged.

## R4I — Deployment (PROVISIONED 2026-08-31)

The Render Background Worker is now the canonical `siton-staging-worker` service
in `render.yaml`, created by the canonical `C-ton` Blueprint after the owner
disconnected the duplicate `C-ton-demo` Blueprint (so exactly one worker is
synced) and approved the single US$7/month instance. The architecture gate now
asserts the blueprint declares exactly one Worker started via
`npm run start:worker:prod` with `RUNTIME_ROLE=worker` and no embedded secret.

```yaml
  - type: worker
    name: siton-staging-worker
    runtime: docker
    region: frankfurt          # same region as the Web service and close to eu-central-1
    plan: starter              # 0.5 CPU / 512 MB — cheapest valid worker plan (~US$7/mo)
    branch: master
    dockerfilePath: ./Dockerfile
    dockerCommand: npm run start:worker:prod
    autoDeploy: true
    envVars: APP_DEPLOYMENT_MODE=staging, RUNTIME_ROLE=worker,
             CANONICAL_POSTGRES_RUNTIME=1, DATABASE_URL (sync: false,
             siton_worker_login Supavisor session-pooler secret — NEVER the Web
             login), ADMIN_API_KEY/SELLER_SESSION_SECRET generated by Render,
             providers synthetic/off exactly as the Web service.
```

`DATABASE_URL` is set on the service only through the Render dashboard/API
(never in Git) as the `siton_worker_login` session-mode pooler string.

Start command `npm run start:worker:prod` (`node .demo_dist/src/worker.js`)
reuses the existing Docker image unchanged. One instance is the canonical
staging topology; scaling beyond one instance is already safe (proven by the
two-process fencing proof) but unnecessary. Health = `worker_heartbeats`
freshness (no HTTP port); restart policy is Render's default for workers.

## Cost gate (owner approval required — the only expected gate tonight)

- Render Background Workers have NO free tier; the smallest valid plan is
  0.5 CPU / 512 MB ("starter") at **US$7/month**, prorated per second
  (render.com/docs/compute-plans; render.com pricing, verified 2026-08-31).
- No additional attached cost is required for staging: the database is
  Supabase (existing), no Render Postgres/Key-Value is needed, bandwidth is
  in the free allowance at staging volume.
- Cheaper valid staging alternative: none on Render for a CONTINUOUS worker
  (cron jobs start at lower cost but are not continuous and violate the R4
  target). Everything short of hosting — identity, fencing, concurrency,
  recovery, money invariants — is already proven without the paid resource.
- What the paid Worker adds that local proof cannot: a continuously running
  hosted process on the staging DATABASE_URL through the Supavisor pooler,
  hosted heartbeat/latency evidence, and Render restart-policy behavior.
- **No paid resource was created tonight.**

## Hosted blockers

1. Supabase channel (same as R3): apply staging 010+011, set both login
   passwords externally.
2. Owner approval of the US$7/month Worker instance (this cost gate).
3. R3 Web service must be live first (activation order).

## External activity in R4 so far

- Grow calls 0; real money 0; real SMS/email/invoices 0; Base44 writes 0.
- Render resources created/modified/deleted 0/0/0; paid infrastructure 0.
- Supabase writes 0 (channel unavailable).
