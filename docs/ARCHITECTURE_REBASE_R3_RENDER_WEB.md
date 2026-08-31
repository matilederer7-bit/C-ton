# SITON ARCHITECTURE REBASE — R3 RENDER WEB RUNTIME

Date: 2026-08-30

Target: Render staging Web Service → `siton-staging` / `hnptacfzuqebfgeshadq` / `eu-central-1`

Baseline: R2 closure `8925726678014e445e0900006436482042b93ff8`

## Status

`R3_REPOSITORY_READY_HOSTED_BLOCKED`.

Every repository-controlled R3 artifact is implemented and gated. The hosted
half of R3 — applying migration 010 to `siton-staging`, provisioning the login
secret, creating the Render service and running the live proofs — requires an
authenticated Supabase management channel and a Render account channel, neither
of which exists in the current environment. No hosted claim is made.

## R3 target architecture

```
Internet / browser
  → Render Fastify Web Service   (this repository, Docker, Node 22)
  → siton_web_login              (LOGIN principal, password external to Git)
  → SET role = siton_web_runtime (server-side session default, R2 audited profile)
  → Supabase PostgreSQL          (siton-staging, eu-central-1)
```

Inventory access remains exclusively `public.siton_inventory_rpc(text,jsonb)`.
Base44 is absent from the canonical Web runtime path. The continuous Worker is
R4 and is intentionally not part of the blueprint.

## Secure database identity design

`siton_web_runtime` and `siton_worker_runtime` remain NOLOGIN permission
profiles exactly as audited in `docs/R2_RUNTIME_PERMISSION_AUDIT.md`. They are
not converted to LOGIN roles.

`supabase/staging/010_r3_web_login_provisioning.sql` provisions the dedicated
external identity:

- `siton_web_login`: `LOGIN`, `NOINHERIT`, no superuser/createdb/createrole/
  replication/BYPASSRLS flags, zero direct object privileges.
- Membership `GRANT siton_web_runtime TO siton_web_login WITH SET TRUE,
  INHERIT FALSE, ADMIN FALSE` — the login principal can only adopt the audited
  profile, cannot inherit it ambiently and cannot administer it.
- `ALTER ROLE siton_web_login SET role = 'siton_web_runtime'` — every session
  adopts the audited profile at session start, server-side. `current_user` is
  always `siton_web_runtime`; the `/readiness` identity check fails closed on
  any drift. This holds through a session-mode pooler with no client-side
  cooperation.
- The migration contains no password and no secret. Until
  `ALTER ROLE siton_web_login PASSWORD '...'` is executed through the external
  secret channel, the role cannot authenticate at all.
- The migration self-asserts: LOGIN flags, SET-only membership, session
  default, zero direct table privileges, no Worker-profile membership, and
  that both R2 profiles remain NOLOGIN.

Forbidden runtime identities (`postgres`, database owner, `service_role`,
`anon`, `authenticated`) remain rejected by
`src/runtime_database_boundary.ts` at readiness time.

## Render blueprint

`render.yaml` (root) is the canonical staging blueprint:

- One `web` service, Docker runtime, Frankfurt, `free` plan (no new recurring
  cost), branch `master`, health check `/readiness`.
- `DATABASE_URL` is `sync: false` — set only in the Render dashboard.
- `ADMIN_API_KEY` and `SELLER_SESSION_SECRET` are `generateValue: true` —
  created by Render, never in Git.
- `APP_DEPLOYMENT_MODE=staging`, `CANONICAL_POSTGRES_RUNTIME=1`,
  `RUNTIME_ROLE=web`, `DISABLE_OUTBOX_WORKER=1`.
- Payments stay `mockpay`/`mock-backed`/`demo`; notifications stay `log-only`;
  payouts stay `internal-ledger`. Grow remains off.

The architecture gate (`scripts/architecture_truth_gate.cjs`) now asserts the
blueprint exists, health-checks `/readiness`, embeds no credential, enables the
canonical runtime, contains no Base44 reference and contains no Worker service.
Legacy Render artifacts stay quarantined under `legacy/render/`.

## /api namespace normalization

`src/api_route_aliases.ts` rewrites the canonical Deal lifecycle aliases
(`/api/deals`, `/api/deals/:id/{publish,join,close_joining,prepare_charging,
charging/start,cancel}`) onto the existing bare routes before Fastify routing.
One business implementation; zero duplicated handlers. Pre-existing `/api`
routes (`/api/deals/:id/public`, `/api/deals/:id/chat`, `/api/deal-images/*`,
`/api/otp/*`, admin surfaces) are never rewritten.

## Hosted proof harness

`scripts/r3_hosted_proof.cjs` runs the live R3 checklist against the deployed
service and prints no secret material:

- HTTP: `/health` 200, `/readiness` 200 with
  `runtime_role=siton_web_runtime` and `inventory=siton_inventory_rpc_v1`,
  sanitized client-error envelopes, no-leak scan of error responses,
  `/api` alias parity, security headers.
- Database identity (only where `R3_WEB_DATABASE_URL` is present, e.g. the
  Render shell): `session_user=siton_web_login`,
  `current_user=siton_web_runtime`, non-admin assertion, DDL denied, direct
  inventory read denied, Worker-only outbox DELETE denied, browser-role
  escalation denied, cross-profile `SET ROLE` denied, inventory RPC probe and
  permitted business read succeed.

Database-loss readiness (503 while `/health` stays 200) is proven by the
repository suite (`tests/canonical_postgres_runtime_boundary_validation.ts`);
the hosted equivalent is exercised by temporarily rotating the login password
or pausing the database during the activation window.

## Database-loss resilience fix

The R3 rehearsal exposed a real defect the R2 proof missed: R2 simulated
database loss with a graceful `pool.end()`, but a server-side connection kill
(failover, restart, `pg_terminate_backend`, administrator command) raised an
unhandled `'error'` event on the idle `pg` pool clients and crashed the whole
Web process. `src/db.ts` now absorbs idle-pool errors (logging only the error
code, never connection details), so real dependency loss degrades to
`/readiness` 503 while `/health` stays 200 and the process survives to
reconnect.

## Repository verification

`tests/r3_render_web_runtime_validation.ts` replays migrations 001 + 006–010
(including an idempotent double-apply of 010), asserts every login-role
invariant, boots the canonical-mode Fastify app, proves readiness identity and
`/api` alias parity, and terminates every backend of the live pool to prove
the process survives and readiness recovers on a fresh connection.

## Local rehearsal of the hosted checklist

The full hosted flow was rehearsed end-to-end against a disposable local
PostgreSQL: all 45 canonical migrations plus staging replays 001 + 006–010,
a real network Fastify boot in canonical mode with the runtime role adopted,
then `node scripts/r3_hosted_proof.cjs --base-url=http://127.0.0.1:3777` —
11/11 HTTP proofs passed (health, readiness identity/inventory, sanitized
errors, leak scan, alias parity, security headers). Dropping the database
under the live server then yielded `/readiness` 503 with the sanitized
`not_ready` body, `/health` 200, and a surviving process. The rehearsal
database and every synthetic artifact were dropped afterwards; leaked
disposable `siton_test_*` databases from interrupted historical runs were also
cleaned (33 dropped, 0 remaining).

## Hosted activation runbook (external channel required)

1. Apply `supabase/staging/010_r3_web_login_provisioning.sql` to
   `siton-staging` through the authenticated management channel.
2. Set the login secret outside Git and outside logs:
   `ALTER ROLE siton_web_login PASSWORD '<generated-strong-password>'`.
3. Compose `DATABASE_URL` for Render (dashboard only) using the Supavisor
   **session-mode** endpoint (port 5432; transaction mode does not preserve
   session state) with `sslmode=verify-full` (fallback
   `uselibpqcompat=true&sslmode=require` if the CA chain is not public), user
   `siton_web_login.<project-ref>` per Supabase pooler convention.
4. Create the Render Blueprint from this repository (root `render.yaml`),
   confirm branch `master`, set `DATABASE_URL` when prompted.
5. Wait for the deploy to pass the `/readiness` health check.
6. Run `node scripts/r3_hosted_proof.cjs --base-url=https://<service>.onrender.com`
   from any machine; run it again from the Render shell with
   `R3_WEB_DATABASE_URL` to cover the database-identity section.
7. Exercise the synthetic staging flows, then clean synthetic residue.
8. Record results here and in `PROJECT_STATUS.md`; only then may R3 be called
   complete.

## Hosted evidence 2026-08-31 (overnight run, Render channel live)

A Render MCP account channel became available. Read/inspect operations were
performed; no service was created, deleted or reconfigured and no secret was
read or written.

What the live account shows:

- The blueprint sync of commit `26ccb73` ran on 2026-08-30 16:36 UTC and
  created **two** Frankfurt free-plan Web services 0.3s apart:
  `siton-staging-web` (`srv-daa5o9u7bikc73fgjskg`) and
  `siton-staging-web-atp1` (`srv-daa5o9u7bikc73fgjsjg`). The same duplication
  pattern exists for the older Oregon demo pair (`siton-demo-preview`
  2026-04-03, `siton-demo-preview-atp1` 2026-05-20), which is strong evidence
  of **two Blueprint instances** attached to the same repository, each owning
  one copy. `render.yaml` declares exactly one service named
  `siton-staging-web`; the `-atp1` name is Render's collision rename.
  **Canonical: `siton-staging-web` (`srv-daa5o9u7bikc73fgjskg`).**
  Deleting the `-atp1` service alone is not safe closure: its owning Blueprint
  instance would recreate it on the next sync. The duplicate Blueprint
  instance must be disconnected/deleted in the Render dashboard (no MCP tool
  exposes blueprint management or service deletion), then the `-atp1`
  services removed. Both duplicates are free-plan and never went live, so no
  cost and no traffic ambiguity exists tonight.
- Both services' first deploys (commit `26ccb73`) built the Docker image
  successfully on Render, booted the app, and the app **failed closed by
  design**: startup aborted before binding a port, Render's port scan timed
  out, the deploys are `update_failed`, no instance is live and the public
  URL serves nothing. Logs contain no credential material; only the sanitized
  startup error appears.
- The startup error was `database schema is not migrated:
  siton.migration_ledger is missing` — which proves a **DATABASE_URL secret
  was already entered** at blueprint-sync time and a real database connection
  succeeded. R1 evidence shows the 45-migration ledger IS live on
  `siton-staging`; `siton_web_login` does not exist yet. The connecting
  identity therefore could not see schema `siton` (privilege failure), and
  pre-fix `assertDatabaseSchema` collapsed every error cause into the
  "missing ledger" message.

Defect found and fixed from this hosted evidence:

- `src/schema_contract.ts` previously swallowed the underlying query error
  (`.catch(() => null)`), so permission-denied, wrong-database and
  connection-level failures were all misreported as an unmigrated schema.
  It now routes by SQLSTATE (code-only, never connection details):
  `42P01`/`3F000` → genuinely unmigrated; `42501` → connected identity lacks
  privilege on the ledger; anything else → surfaced with its code.
  `tests/database_migration_system_validation.ts` proves the routing,
  including a real 42501 raised through an unprivileged role.

Runbook amendment (applies to steps 3–5): both staging services currently
hold a DATABASE_URL entered on 2026-08-30 that fails the identity/privilege
boundary. During activation, the canonical service's DATABASE_URL must be
**replaced** with the `siton_web_login` session-mode URL after migration 010
and the external password step; the pre-entered value must not be treated as
usable configuration. The `-atp1` service should never receive a working
secret.

Correction from the fixed diagnostics (2026-08-31, after the autodeploy of
`5cb9b65`): the live boot now reports `database schema check failed before
migration inspection (code ECONNREFUSED)`. The pre-entered DATABASE_URL does
not reach a database at all — the earlier inference that "a connection
succeeded but the identity could not see the schema" was an artifact of the
masked error and is withdrawn. Probable causes: the free-tier Supabase
project is paused, or the URL uses the IPv6-only direct
`db.<ref>.supabase.co` endpoint that Render egress cannot reach. Both are
resolved by runbook step 3 (session-mode Supavisor pooler URL) after
confirming the project is active. Activation must first verify
`siton-staging` is not paused.

Session constraint recorded 2026-08-31: the Supabase MCP server is configured
(project-scoped `hnptacfzuqebfgeshadq`) but its tools did not register in the
running engineering session, and no CLI/token/connection-string channel
exists on the workstation. Runbook steps 1–2 (apply 010, set the login
password) therefore remain blocked in this session; they unblock by starting
a session in which the Supabase MCP tools are registered.

## External activity in this stage so far

- Grow calls: 0. Real authorizations/charges/refunds/payouts: 0.
- Real SMS/emails/invoices: 0.
- Render deploys: 0 (no account channel in this environment).
- Supabase writes: 0 (no management channel in this environment).
- Base44 writes/deletes: 0.
