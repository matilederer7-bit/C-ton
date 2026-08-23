# Siton V1 Canonical Architecture

Status: binding architecture decision for V1.

## One answer

Siton V1 production is **Base44 + Supabase**. Base44 owns the application,
authenticated backend functions, business entities, browser delivery, and the
scheduled worker entry point. Supabase supplies the database-grade inventory
authority/proof boundary reached through the canonical inventory bridge.

Render is not a production runtime. Docker, Fastify, PostgreSQL migrations, and
the standalone Web/Worker remain a portable local/test implementation and a
contract-proving harness. They do not create a second production architecture.

## Runtime and authority

| Concern | V1 authority | Execution/storage boundary |
|---|---|---|
| Deals | Base44 `Deal` | Base44 entity; transitions only through `siton-transition-engine-v3` |
| Participants | Base44 `Participant` | Base44 entity and canonical backend functions |
| Inventory | Supabase inventory authority | Called only through `siton-inventory-bridge`; Base44 Deal fields are projections, never an excuse to guess through disagreement |
| State transitions | Base44 transition engine | `siton-transition-engine-v3`, with constitution, idempotency, and Audit evidence |
| Money ledger | Base44 `MoneyLedgerEvent` | Written only by canonical server/worker orchestration; provider adapters never own business state |
| Outbox / DLQ | Base44 `OutboxEvent` / `OutboxDeadLetter` | Claimed in bounded batches; replay and UNKNOWN require idempotency/reconciliation |
| Audit | Base44 `DealAudit` and control/audit entities | Append-only business and control evidence |
| Seller data | Base44 `SellerAccount`, `SellerSettlement`, documents | Server-authorized tenant scope |
| Distributor attribution | Base44 distribution entities | Measurement only; commission, wallet, payout, and entitlement are zero |
| Buyer sessions | Hashed, bounded server sessions | HttpOnly cookie to backend; safe resume allowlist only |

Supabase canonically stores the inventory reservation/commit/release truth and
database-grade proof consumed by the bridge. It is not called by the browser.
When Base44 and its inventory projection disagree with Supabase evidence, the
operation fails closed and is reconciled; no layer chooses a winner from time
order or convenience.

## Request and worker lifecycle

The browser calls HTTPS backend routes. It never calls Supabase or Grow
directly. The web/PWA uses same-origin routes; a native build resolves only
`/api/*` and `/deals*` against its configured HTTPS `SITON_API_BASE_URL` and
uses the native HTTP/cookie bridge. Provider-hosted payment UI may open in the
system browser, but final truth returns through server lookup/callback and
reconciliation.

`siton-worker-tick` is the canonical Base44 scheduled function. Its recurring
five-minute automation requires an authenticated Base44 admin-owned automation,
uses a bounded batch limit, creates one tick ID, and invokes as service role:

1. `reconcile-payment-jobs`
2. `deliver-notifications`
3. `reconcile-outbox-projections`

Each child reports completed, failed, or unknown. A partial/unknown tick returns
failure and leaves reconciliation evidence; it does not manufacture success.
Secrets remain in Base44/Supabase server-side configuration. Browser bundles,
mobile projects, logs, Git, and callback URLs contain no server credential.

## Artifact classification

| Classification | Artifacts |
|---|---|
| CANONICAL | `base44/config.jsonc`, `base44/runtime-manifest.json`, `base44/functions/siton-worker-tick/`, canonical Base44 registry/callers, Supabase inventory bridge contract |
| SUPPORTING | `src/`, `db/migrations/`, `Dockerfile`, Compose, portable Web/Worker, operational scanners and isolated migration/test harnesses |
| TEST-ONLY | synthetic provider, mock provider transports, fixtures, MinIO/Docker CI, `.tmp*`, `.demo_dist`, `.mobile_dist`, copied Capacitor web assets |
| LEGACY | everything under `legacy/render/`, including the renamed manifest, Procfile, gate, and historical deployment reports |

The root `render.yaml`, root `Procfile`, and Render gate are deliberately absent.
The architecture gate fails if they return. Historical documents that mention a
Render preview are evidence only and do not override this decision.

## Activation boundary

Publishing the Base44 app, applying hosted Supabase changes, entering secrets,
creating the scheduled automation under the correct admin owner, configuring
domains, and running live provider checks are external operations. No such
write was performed by this closure.
