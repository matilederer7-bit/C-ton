# SITON ARCHITECTURE REBASE — R2 CANONICAL POSTGRES RUNTIME

Date: 2026-08-30

Target: `siton-staging` / `hnptacfzuqebfgeshadq` / `eu-central-1`

Baseline: `3a1eb2e499b7c9fd6dbd249d1de9045a71b65c22`

## Verdict

`R2_CANONICAL_POSTGRES_READY`.

The repository-controlled runtime boundary is persistent on staging. The
NOLOGIN Web and Worker profiles passed live positive and negative `SET ROLE`
tests. The canonical Join and inventory repository passed live cross-schema
transaction, rollback, audit, idempotency, capacity and foreign-key proofs with
zero synthetic residue. R3 was not started.

## Runtime database model

Fastify Web and the continuous Worker use PostgreSQL through separate `pg`
pools created by `src/db.ts`. Canonical mode is enabled only with
`CANONICAL_POSTGRES_RUNTIME=1`.

- Web access profile: `siton_web_runtime`
- Worker access profile: `siton_worker_runtime`
- Both profiles: `NOLOGIN`, `NOINHERIT`, `NOSUPERUSER`, `NOCREATEDB`,
  `NOCREATEROLE`, `NOREPLICATION`, and `NOBYPASSRLS`
- Neither profile owns a canonical schema or receives schema `CREATE`
- Neither profile receives direct `siton_inventory` schema or table access
- Inventory access is only `public.siton_inventory_rpc(text,jsonb)`
- `anon` and `authenticated` have no direct canonical schema, table, sequence,
  or inventory RPC access
- LOGIN principals, passwords and `DATABASE_URL` provisioning are R3 work and
  do not exist in Git

The exact operation-level table, sequence, function and classification matrix
is versioned in `docs/R2_RUNTIME_PERMISSION_AUDIT.md`.

## Permission audit result

The monolithic process boundary was retained. No per-route role architecture
was introduced.

The source audit removed 22 unnecessary Worker operation-level table
privileges:

- 8 SELECT privileges
- 10 INSERT privileges
- 2 UPDATE privileges
- 2 DELETE privileges

The same audit corrected missing operations that current runtime code already
performs:

- Web UPDATE for four `ON CONFLICT DO UPDATE` tables
- Worker SELECT and INSERT on `fulfillment_units`
- Worker UPDATE on two `ON CONFLICT DO UPDATE` tables
- Web and Worker EXECUTE on seven non-mutating helpers called by state and
  audit triggers

No mutating or security-definer `siton` function was granted directly.

## Persistent migrations

The live staging migration history now includes:

- `r2_canonical_postgres_runtime_boundary`
- `r2_runtime_role_admin_set_proof`
- `r2_runtime_trigger_helper_execute`
- `r2_runtime_function_public_fail_closed`

The second migration permits the existing `postgres` administrative owner to
use `SET ROLE` while keeping role membership non-inheriting. This adds no
application authority because that administrator already owns both canonical
schemas. It provides a reproducible administrative proof path.

## Live role proofs

The Web role succeeded at schema readiness, inventory RPC probe, business
INSERT and UPDATE, and its permitted DELETE surface. It was denied:

- schema DDL
- schema ownership change
- direct inventory table read
- granting its role to `authenticated`
- Worker-only outbox DELETE

The Worker role succeeded at schema readiness, inventory RPC probe, heartbeat
INSERT with conflict UPDATE, and outbox DELETE. It was denied:

- schema DDL
- schema ownership change
- direct inventory table read
- granting its role to `authenticated`
- Web-only Deal INSERT
- Web-only seller-session read

Every role-proof transaction was rolled back.

## Canonical inventory and cross-schema transaction

`src/inventory_repository.ts` is the single target-runtime adapter. It invokes
the inventory RPC on the transaction's existing PostgreSQL client and contains
no Base44 import, Base44 SDK call, HTTPS bridge, `fetch`, or Axios call.

The live staging proof used the same transaction semantics as the repository
and passed:

- participant Join mutation and committed reservation observed together
- forced failure after business mutation rolled back business and inventory
- forced failure after inventory mutation rolled back inventory, business and
  both audit streams
- duplicate idempotency replay returned the same reservation and reserved units
  once
- an over-capacity hold returned `inventory_exhausted`; reserved units remained
  4 of 5
- the participant reservation foreign key joined to the committed reservation
- a dangling reservation foreign key was rejected
- final synthetic residue count across business, inventory and audit tables was
  zero

The earlier R1 strict 20-participant capacity race was not repeated. R2 reused
the same canonical RPC and proved its transaction-scoped runtime call path;
repository concurrency regression remains part of full CI.

## Fastify stage boundary

R2 evidence combines the prior isolated full-PostgreSQL Fastify proof with the
new live staging role and atomicity proof:

- `/health` returns 200
- `/readiness` returns 200 with the canonical schema, inventory contract and
  effective Web role
- database loss makes readiness return 503 while health remains 200
- schema checks are read-only and no runtime DDL exists
- canonical inventory operations do not depend on Base44

A literal network Fastify boot against staging is intentionally the first R3
deployment gate. R2 does not create external LOGIN roles, passwords or
`DATABASE_URL` secrets merely to repeat the already-proven process behavior.

## Money authority

No provider call was made. Existing regression tests reconfirm:

- Siton fee is exactly 8 percent
- the fee base includes product and delivery or shipping
- authoritative buyer-side VAT is excluded
- client-supplied VAT is never authoritative
- distributor commission and payout entitlement are zero

## Advisors

Post-DDL Security Advisors:

- WARN: 0
- INFO: 5 `rls_enabled_no_policy` notices on the five inventory tables
- Classification: `INTENTIONAL`; private inventory tables remain fail-closed
  and are available only through the security-definer canonical RPC

Post-DDL Performance Advisors:

- WARN: 0
- INFO: 18 unindexed foreign keys
- INFO: 98 unused indexes
- Classification: `DEFERRED`; no new R2 performance finding was introduced,
  and fresh-staging usage statistics are not evidence for dropping canonical
  indexes. Revisit with representative R3 workload evidence.

## External activity

- Grow calls: 0
- real authorizations, charges, refunds and payouts: 0
- real SMS, emails and invoices: 0
- Render deploys: 0
- Base44 writes and deletes: 0
- production data migration: 0

## Next step

R3 may begin only as a separately authorized stage. Its first gate is Render Web
runtime deployment with secure LOGIN-principal and `DATABASE_URL` provisioning,
followed by literal network health and readiness verification. Do not activate
Grow, migrate Base44 production data, send real communications or execute real
money without their later explicit gates.
