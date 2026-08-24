# Siton V1.1 — Mall Product Direction

Status: binding product decision, 2026-08-23.

## Decision

Siton supports both first-class entry paths:

1. direct deal links; and
2. the public Siton Mall at `/app`.

The previous V1 rule that prohibited a marketplace, catalog, browsing, or
public discovery is superseded for product scope. Direct links remain fully
supported. Historical documents retain their evidence value, but their
direct-link-only conclusion is not current product canon.

The Mall is deliberately a focused discovery surface, not a second commerce
engine. It reads published canonical deals and always opens the existing
canonical public deal page. It does not own inventory, deal state, payment,
ledger, settlement, refunds, or attribution truth.

## Eligibility and classification

`Draft` is never public. A deal is eligible only when `published_at` is set.
Mall labels are a read classification over the existing state machine:

| Mall status | Canonical Deal states |
|---|---|
| `underway` / בדרך ליעד | `PendingTarget` |
| `reached_target` / הגיע ליעד | `TargetReached`, `ClosedForJoining`, `ReadyForCharging`, `Charging`, `CompletionWindow` |
| `succeeded` / הצליח | `Completed` |
| `failed` / לא הצליח | `Failed` |
| `cancelled` / בוטלה | a published `Cancelled` record, if one exists |

Reaching the target is not the same as final success. Join availability still
comes from canonical backend truth and is revalidated by the Join operation.

The initial filters are the three existing deal types
(`physical_product`, `voucher`, `ticket`) and the statuses above. Default order
is `published_at` newest first. Inputs are closed enums, page size is bounded,
and pagination never accepts arbitrary SQL or field names.

## Architecture and privacy

Base44 remains the production application/entity/function runtime. Supabase
remains the inventory authority and proof boundary. The portable
Fastify/PostgreSQL implementation is a supporting contract and test harness.
Render remains legacy only.

The Base44 Mall projection is disposable and repairable. Its public field
allowlist contains only card-safe deal, progress, seller display-name, image,
publication, and outcome data. It contains no buyer identity, contact or
delivery data; no seller private account data; and no provider, ledger, audit,
payment, settlement, or storage-key fields.

Organic Mall traffic uses the acquisition source `mall`. It never creates a
distributor attribution. Distributor references remain a separate, validated
rail and distributor commission remains exactly zero.

Discovery events are aggregate, non-financial evidence only. They contain no
phone, email, address, payment data, IP address, user agent, or buyer identity,
and cannot mutate state, money, inventory, payout, or availability.

## Immutable business boundaries

- Siton fee is exactly 8% of everything collected from the customer,
  including delivery/shipping and excluding VAT.
- Distributor commission is exactly 0.
- The 90% target rule, state constitution, server-side money authority,
  payment safety, worker fencing, and reconciliation boundaries are unchanged.
- The browser never becomes seller authority and never calls Supabase or a
  payment provider as business-state authority.

## Activation boundary

This repository milestone may prepare Base44 resources and frontend source,
but it does not publish the Base44 app, deploy a site/function, apply a hosted
migration, configure a production domain, activate a provider, or write to
production. Those remain separately authorized external actions.
