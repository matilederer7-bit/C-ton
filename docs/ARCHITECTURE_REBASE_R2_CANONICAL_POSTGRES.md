# SITON ARCHITECTURE REBASE — R2 CANONICAL POSTGRES RUNTIME

Date: 2026-08-29  
Target: `siton-staging` / `hnptacfzuqebfgeshadq` / `eu-central-1`  
Baseline: `be868ddd177ff3365f79fafbdfd35b8ddcd32f2e`

## Verdict

`R2_BLOCKED`.

The repository-side canonical Postgres boundary is implemented and test coverage is versioned. The persistent least-privilege role migration was not applied to staging because the available change-control path rejected its Web and Worker grant surface as too broad for a permanent security-boundary change. The SQL passed transaction-wrapped staging preflight and was rolled back. No role, grant, policy, column, constraint or synthetic operational row from R2 was persisted.

## Runtime database model

Fastify Web and the continuous Worker use PostgreSQL through `pg` pools created by `src/db.ts`. Credentials remain external to Git and logs. Canonical mode is enabled only with `CANONICAL_POSTGRES_RUNTIME=1`.

The intended deployed model uses a dedicated external LOGIN credential for each process and an effective database access profile:

- Web effective role: `siton_web_runtime`
- Worker effective role: `siton_worker_runtime`
- Both profiles: `NOLOGIN`, `NOINHERIT`, no superuser, database creation, role creation, replication or RLS bypass
- Persistent processes: direct Supabase Postgres connection where IPv6 is available, or the session pooler where IPv4 is required
- TLS and credentials: connection-string secret supplied by the runtime platform, never committed or emitted in SQL logs
- Forbidden application identities: `postgres`, `supabase_admin`, `service_role`, `anon`, and `authenticated`

Canonical readiness fails closed unless the effective role exactly matches the process profile and `public.siton_inventory_rpc('probe', '{}')` succeeds.

## Canonical inventory path

`src/inventory_repository.ts` is the single target-runtime adapter. It invokes `public.siton_inventory_rpc(text,jsonb)` on the transaction's existing `PoolClient`. It contains no Base44 import, Base44 SDK call, HTTPS bridge, `fetch`, or Axios call.

The repository preserves:

- `sync`
- `hold`
- `commit`
- `release`
- `lookup`
- reservation status
- deal status
- close
- stable request hashing
- idempotency
- capacity enforcement
- canonical inventory audit

Fastify Join no longer calculates inventory availability from a separate sum of `siton.participants`.

## Cross-schema transaction

The target Join order is:

1. Lock the business deal and business idempotency key.
2. Sync and Hold through the canonical inventory RPC on the same client.
3. Insert the business participant with `inventory_reservation_id`.
4. Commit the inventory reservation and its append-only inventory audits.
5. Write business audits and update buyer and money states.
6. If the inventory target transitioned, update the business deal and audit it.
7. Store the business idempotency result.
8. Commit once.

Failure injection exists after the business mutation and after the inventory commit. Because both schemas use the same PostgreSQL transaction and client, either failure rolls back business rows, inventory rows and both audit streams together. The new tests also cover duplicate idempotency replay and `max_units` exhaustion.

This behavior is covered in an isolated PostgreSQL test, but it was not executed against live staging because the runtime role migration was not persisted.

## Fastify readiness

- `/health` is liveness only and does not depend on PostgreSQL.
- `/readiness` checks the complete canonical schema contract, exact effective runtime role and inventory RPC probe.
- A database failure returns HTTP 503 with the safe body `{"ok":false,"code":"not_ready"}`.
- Startup fails before listening if readiness fails.
- Schema checks use catalog lookups and contain no runtime DDL.
- SQL debug logging records duration and error code only, not SQL parameters.

The test suite boots Fastify against an isolated migrated PostgreSQL database under `SET ROLE siton_web_runtime`. A literal Fastify process could not be booted against `siton-staging` because this chat has no database password or temporary secret channel and the persistent access profiles were not approved for activation.

## Money authority

The existing server-side money authority remains canonical:

- Siton fee rate: exactly 8 percent
- Gross source: database quantity multiplied by database unit price, plus database delivery cost
- Shipping: included in the fee base
- Buyer-side VAT: excluded from the fee base only when supplied by authoritative server/provider truth
- Current no-tax-provider fallback: authoritative VAT is zero
- Client VAT fields: not authoritative and not passed into fee calculation
- Distributor commission: zero; attribution remains measurement-only
- Real provider calls in R2: zero

## Base44 disposition

No Base44 dependency exists in the target Fastify inventory repository or canonical Join path. Base44 source files, deployed production functions and the current production runtime manifest remain in the repository because R2 does not authorize production cutover, production data migration or deletion. They are historical/current-production dependencies only, not dependencies of the Render/Supabase target inventory path.

## Migration and security status

`supabase/staging/006_canonical_postgres_runtime_boundary.sql` is a reviewed draft with operation-specific grants and policies. It also adds the cross-schema reservation foreign key and retains zero direct inventory-table access for Web, Worker and browser roles.

Two transaction-wrapped staging preflights succeeded and rolled back. Persistent application was rejected by the available safety reviewer due to the size and sensitivity of the Fastify monolith's required table surface. No workaround was used.

Because no R2 DDL was persisted, the advisor run describes the unchanged R1 database: Security has 0 WARN and 68 intentional fail-closed `rls_enabled_no_policy` INFO notices. Performance has 18 unindexed-foreign-key INFO notices and 99 unused-index INFO notices. The remediation reference for the intentional security notice is [Supabase database linter 0008](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).

## Open gate and next step

R2 can close only after the access surface is split into narrower database capabilities, or the exact operation-level role matrix receives explicit security approval, followed by:

- persistent staging migration
- real Web and Worker credentials through a secret channel
- literal Fastify staging boot
- live cross-schema synthetic proof and cleanup
- post-DDL Security and Performance Advisors
- full green regression suite

Do not deploy Render or start R3 before those gates pass.
