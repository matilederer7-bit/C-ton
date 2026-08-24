# Siton V1.1 Base44 pre-activation snapshot

Date: 2026-08-24 (Asia/Jerusalem)

Status: **BLOCKED before any hosted write**

This record is the read-only pre-activation evidence for frozen source commit
`7ab6a61861a87bcaf6be4759912564a3abbbf043`. It does not claim that the
Base44 site, Base44 resources, or hosted Supabase schema were activated.

## Safety outcome

- Base44 resource deployments: **0**
- Base44 site deployments/publishes: **0**
- Hosted Supabase migrations: **0**
- Hosted records created, changed, or deleted: **0**
- Grow/provider calls: **0**
- Payment authorizations or money movements: **0**
- SMS, email, or invoice deliveries: **0**
- Temporary activation records: **0**; cleanup is not applicable
- Rollback action: not required because no hosted write occurred

## Repository and local gate

- Branch: `master`
- Local `HEAD` and fetched `origin/master` both resolved to
  `7ab6a61861a87bcaf6be4759912564a3abbbf043`, with divergence `0/0`.
- The working tree was clean before hosted inspection.
- `npm run test:all` passed 140/140 files in 10/10 groups with zero failures
  (`duration_ms=1401853`), including real Microsoft Edge proof.
- Architecture, Base44 canonical integrity, isolated migrations (45/45 with
  repeat/checksum proof), runtime and test TypeScript, lint/backend enforcement,
  direct-state/payment-SDK/secret scans, and `git diff --check` passed.

## Base44 identity and authentication evidence

- A temporary project-local Base44 CLI `0.1.10` was installed in ignored
  `node_modules` without changing `package.json` or `package-lock.json`.
- The mandatory first command, `npx base44 whoami`, reported an authenticated
  identity; the account email was redacted.
- The authenticated read-only app listing returned two owned apps. Exactly one
  matches the immutable Siton runtime manifest: app ID
  `6a79b3ce58f678716af8d295`, name `ראש גשר`. The other app has a different ID
  and name and is not a Siton candidate.
- A local link was attempted only against that exact existing ID, without
  `--create`. The CLI project-list request failed with `401 Unauthorized` and
  the documented hint to run `npx base44 login`.
- No `base44/.app.jsonc` was created. The checkout therefore remains unlinked.
- The hosted/public URL and site deployment metadata could not be obtained
  through the unauthenticated CLI path. No URL is guessed in this record.

The successful MCP read session and the failed CLI link demonstrate two
different authentication contexts. They are not treated as deployment
authority. Base44 deployment is fail-closed until interactive CLI login is
completed and the exact app is linked again.

## Observable hosted Base44 state

The Base44 entity API returned 57 current entity schemas. The names are:

`AdminControlAudit`, `AdminControlFlag`, `ConcurrencyLockProbe`, `Deal`,
`DealAudit`, `DealComment`, `DeliveryRecord`, `DistributionAttribution`,
`DistributionEvent`, `DistributionSource`, `DistributorDealAccess`,
`FulfillmentUnit`, `IdempotencyRecord`, `InvoiceDocument`, `MoneyLedgerEvent`,
`NotificationAttempt`, `NotificationEvent`, `OperationalCase`,
`OperationalCaseEvent`, `OtpChallenge`, `OtpDeliveryAttempt`,
`OutboxDeadLetter`, `OutboxEvent`, `Participant`, `PaymentAttempt`,
`PaymentReconcileJob`, `SellerAccount`, `SellerPayoutBatch`,
`SellerSettlement`, `Task`, `User`, `_noop`, and the 25 classified legacy
lowercase/kebab-case counterparts recorded by Stage 32A.

The read-only remote app source tree exposed 69 function directories:

`admin-control-flags`, `admin-deals`, `admin-distribution`, `admin-forensics`,
`admin-notifications`, `admin-omnisearch`, `admin-overview`, `admin-payouts`,
`admin-review-seller`, `admin-sellers`, `admin-support-cases`,
`admin-system-status`, `apply-charge-results`, `apply-recovery-results`,
`apply-refund-results`, `base44-inventory-lifecycle-proof`, `cancel-deal`,
`canonical-integrity-gate`, `close-joining`, `communication-delivery`,
`create-deal-draft`, `deal-comments`, `deliver-notifications`,
`distributor-portal`, `finalize-deal`, `get-buyer-tracking`, `get-public-deal`,
`get-seller-profile`, `inventory-bridge`, `join-deal`,
`payment-attempt-guard`, `postgres-connectivity-probe`, `prepare-charging`,
`publish-deal`, `reconcile-join-intent`, `reconcile-join-intents`,
`reconcile-outbox-projections`, `reconcile-payment-jobs`, `request-otp`,
`seller-analytics`, `seller-deal-detail`, `seller-deal-images`, `seller-deals`,
`seller-digital-fulfillment`, `seller-fulfillment`, `seller-payouts`,
`seller-receipts`, `siton-base44-lifecycle-proof`,
`siton-base44-lifecycle-proof-v3`, `siton-core-readiness`,
`siton-inventory-bridge`, `siton-lifecycle-proof-v4`,
`siton-reconcile-join-intents-v2`, `siton-transition-engine`,
`siton-transition-engine-v2`, `siton-transition-engine-v3`, `start-charging`,
`stripe-capability-probe`, `supabase-inventory-live-proof`,
`supabase-inventory-rpc-admin`, `supabase-schema-admin`,
`track-distribution-event`, `transition-engine`, `update-deal-draft`,
`update-seller-profile`, `verify-otp`, `worker-claim-outbox`,
`worker-finish-outbox`, and `worker-heartbeat-outbox`.

This is an observable source inventory, not a CLI-confirmed deployed-function
inventory; the latter is unavailable until CLI authentication/linking works.
The app exposes one `supabase` connector declaration. Only configuration keys
were inspected and all values remained redacted.

Auth observations are limited to the readable schema/configuration surface:
the built-in `User` schema exposes `admin` and `user` roles, sampled `Deal` and
`SellerAccount` schemas are admin-only through their entity RLS, and no
`base44/auth/` directory was observable. This is not sufficient evidence for
the complete active site authentication configuration.

## Frozen V1.1 versus remote source

The remote source identifies itself as `base44-app` and its top status entry is
Stage 32A dated 2026-08-14. Its `base44/config.jsonc` has a Vite site contract
(`npm install`, `npm run build`, `./dist`), while its
`base44/runtime-manifest.json` is absent.

A read-only remote search returned no matches for the frozen V1.1 resources or
freeze markers. In particular, the hosted schema/source inventory lacks:

- entities `DealImage`, `DiscoveryEvent`, `MallDealProjection`, and
  `SellerIdentity`;
- functions `list-mall-deals`, `project-mall-deal`, `record-mall-event`,
  `siton-seller-bootstrap`, `siton-seller-deal-image`, and
  `siton-worker-tick`;
- the `SITON V1.1 — MALL & PRODUCT DEPTH FREEZE` marker.

The frozen local checkout contains those resources, but its checked-in
`base44/config.jsonc` contains only the runtime name and has no site build or
output-directory contract. Therefore the stale remote bundle is proven, while
a safe documented site deployment from the exact frozen checkout is not.
Inventing a build output or copying generated files would violate the release
freeze and was not attempted.

## Supabase pre-migration state

- No hosted Supabase project ref or hosted database URL is available in the
  current process or tracked configuration.
- The ignored local `.env` points only to loopback PostgreSQL and is not a
  hosted Supabase target; its value was not printed.
- Read-only remote source inspection found only the environment-key names
  `SUPABASE_URL` and `SUPABASE_SECRET_KEY`; values were not read or exposed, and
  no literal Supabase project host is checked into those inspected functions.
- The repository migration manifest is internally consistent at 45 migrations
  through `049_mall_discovery_read_model.sql`. Migration 049 has local SHA-256
  `a6938a72b063ff7fcdc84031d9d17e7d24587c2812711165c5d5eea69e6d94bb`.
- The hosted migration ledger, checksums, drift, table sizes/load, RLS state,
  and whether migration 049 is pending remain unknown.
- No hosted recovery point, PITR confirmation, or protected logical backup was
  available for verification.

Applying `npm run db:migrate` without proving the hosted project, exact ledger
prefix, and recovery point would be a blind production mutation. It was not
run.

## Blockers and remediation

1. Complete the interactive Base44 CLI authentication step:
   `npx base44 login`. Then rerun `npx base44 whoami`, re-list the owned apps,
   and link only app `6a79b3ce58f678716af8d295`.
2. Prove the public hosted URL, active auth/site metadata, and deployed function
   inventory after the authenticated link.
3. Supply an owner-confirmed Siton Supabase project ref and its matching
   protected hosted connection, independently verify the Base44 connector
   binding, inspect the ledger in forced read-only mode, and establish a
   recovery point before any migration.
4. Resolve the missing site deployment contract for the exact frozen source
   through the explicitly required activation-fix branch if repository change
   is necessary. Do not reuse or manually copy the stale remote bundle.

Until all four boundaries are proven, activation remains blocked and no hosted
browser result—including the reported raw `401`—may be claimed fixed.
