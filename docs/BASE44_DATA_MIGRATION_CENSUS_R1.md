# Base44 Data Migration Census — R1

**Captured:** 2026-08-27

**Mode:** read-only count/category census; no Base44 writes/deletes and no row export
**Authority:** Base44 remains active; this document does not authorize migration or cutover

## Method and limits

The census used the authenticated Base44 CLI and requested records in memory only. Output was restricted to aggregate counts and the buckets `real`, `test`, and `system`; no names, email addresses, telephone numbers, addresses, message bodies, provider references, tokens, or row identifiers were written to this repository. Classification is a conservative non-PII heuristic based on platform `is_sample` plus known Stage/proof/system markers. Before R2 import, the six rows currently classified as `real` require an owner-reviewed, private classification pass.

Remote sandbox source contains 61 entity configuration files and 25 PascalCase/kebab duplicate pairs documented in R0. PascalCase is the canonical side. Four lower-case/source configurations (`deal-image`, `discovery-event`, `mall-deal-projection`, `seller-identity`) do not have a queryable live PascalCase entity schema and returned 404; they are source/config drift, not counted as live records.

## Aggregate result

| Measure | Count |
|---|---:|
| Queryable canonical entity types checked | 31 |
| Live records counted | 36 |
| Heuristic real | 6 |
| Heuristic test | 0 |
| Heuristic system/proof/scaffold | 30 |
| Source-only/unavailable canonical types | 4 |
| PascalCase/kebab duplicate pairs | 25 |

## Canonical entity census

| Canonical entity | Count | Real / test / system | PII category only | Duplicate/config note | R2/R3 disposition |
|---|---:|---:|---|---|---|
| `AdminControlAudit` | 0 | 0 / 0 / 0 | admin identifiers, audit metadata | paired | migrate retained audit if any |
| `AdminControlFlag` | 0 | 0 / 0 / 0 | admin identifiers, operational metadata | paired | migrate open flags if any |
| `ConcurrencyLockProbe` | 1 | 0 / 0 / 1 | none | canonical-only proof resource | do not migrate; delete after cutover evidence |
| `Deal` | 9 | 2 / 0 / 7 | seller linkage, product/business content | paired | required, after private owner classification |
| `DealAudit` | 4 | 0 / 0 / 4 | actor identifiers, audit metadata | paired | preserve required audit evidence; proof rows separable |
| `DealComment` | 0 | 0 / 0 / 0 | author identifiers, free-text content | paired | migrate if populated and retention permits |
| `DealImage` | unavailable | — | uploader linkage, object metadata | source config only; live schema 404 | metadata/object migration required only if source appears |
| `DeliveryRecord` | 0 | 0 / 0 / 0 | name, phone, email, address | paired | transform to participant delivery snapshot |
| `DiscoveryEvent` | unavailable | — | behavioral/attribution identifiers | source config only; live schema 404 | optional aggregate import by retention policy |
| `DistributionAttribution` | 0 | 0 / 0 / 0 | pseudonymous visitor/buyer linkage | paired | migrate if populated |
| `DistributionEvent` | 0 | 0 / 0 / 0 | behavioral/attribution metadata | paired | migrate non-PII evidence if populated |
| `DistributionSource` | 0 | 0 / 0 / 0 | distributor identity/contact linkage | paired | transform to affiliate accounts/links |
| `DistributorDealAccess` | 0 | 0 / 0 / 0 | distributor and deal identifiers | paired | normalize; entity eliminated after import |
| `FulfillmentUnit` | 0 | 0 / 0 / 0 | recipient/contact and fulfillment secret references | paired | required if populated; sensitive transform |
| `IdempotencyRecord` | 4 | 0 / 0 / 4 | pseudonymous request metadata | paired | migrate only live/relevant evidence; proof rows separable |
| `InvoiceDocument` | 0 | 0 / 0 / 0 | billing identity, financial metadata | paired | required if populated; never migrate secrets |
| `MallDealProjection` | unavailable | — | derived public business data | source config only; live schema 404 | do not migrate; rebuild from canonical deal truth |
| `MoneyLedgerEvent` | 0 | 0 / 0 / 0 | financial and pseudonymous participant metadata | paired | required financial reconciliation if populated |
| `NotificationAttempt` | 0 | 0 / 0 / 0 | destination/contact delivery metadata | paired | migrate retained evidence if populated |
| `NotificationEvent` | 0 | 0 / 0 / 0 | destination/contact and message metadata | paired | migrate retained events if populated |
| `OperationalCase` | 0 | 0 / 0 / 0 | support identifiers, possible free-text PII | paired | required if open/retained |
| `OperationalCaseEvent` | 0 | 0 / 0 / 0 | actor/support audit metadata | paired | migrate with retained cases |
| `OtpChallenge` | 0 | 0 / 0 / 0 | hashed/masked contact, security metadata | paired | do not migrate expired challenges |
| `OtpDeliveryAttempt` | 0 | 0 / 0 / 0 | masked contact, delivery metadata | paired | retain only under audit policy |
| `OutboxDeadLetter` | 0 | 0 / 0 / 0 | event identifiers; payload may contain indirect PII | canonical-only | migrate all unresolved evidence |
| `OutboxEvent` | 1 | 1 / 0 / 0 | event identifiers; payload may contain indirect PII | canonical-only | freeze/reconcile before transformed import |
| `Participant` | 0 | 0 / 0 / 0 | name, phone, email, address, buyer identity | paired | required if populated; highest PII handling tier |
| `PaymentAttempt` | 0 | 0 / 0 / 0 | financial metadata, provider references | canonical-only | required financial evidence if populated |
| `PaymentReconcileJob` | 0 | 0 / 0 / 0 | financial/pseudonymous identifiers | paired | normalize into payment/outbox/case tables |
| `SellerAccount` | 1 | 0 / 0 / 1 | owner identity, business contact/KYC metadata | paired | proof row excluded; real rows would be required |
| `SellerIdentity` | unavailable | — | email/contact/auth identity | source config only; live schema 404 | rewrite boundary to `auth.users` binding; never credentials |
| `SellerPayoutBatch` | 0 | 0 / 0 / 0 | business financial/payout metadata | paired | required reconciliation if populated |
| `SellerSettlement` | 9 | 2 / 0 / 7 | business financial and seller identifiers | paired | required after private classification/reconciliation |
| `Task` | 6 | 0 / 0 / 6 | arbitrary scaffold free text possible | canonical-only scaffold | do not migrate unless a consumer is proven |
| `User` | 1 | 1 / 0 / 0 | name, email, role/auth identity | built-in | migrate identity link only; never password/credentials |

## Migration boundary

- No Base44 row was created, updated, deleted, or exported.
- No user is imported in R1.
- The 6 heuristic-real records are not automatically approved for migration; they are the bounded private review set for R2 planning.
- Financial/outbox/audit evidence must be reconciled together before any import. A count alone is not authority.
- Duplicate kebab/Pascal schemas must not become duplicate target tables. PascalCase mappings in R0 remain canonical.
