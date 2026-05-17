# Privacy Data Map

Written as an initial MVP response; legal validation is recommended later.

## Buyer

| Data | Purpose | Basis | Visible To | Stored In | Vendors | Retention | Minimize |
|---|---|---|---|---|---|---|---|
| Name | delivery/contact | contract/service | seller after completion, support/admin | participants | email/SMS if used | 7 years for transaction records | optional unless delivery needs it |
| Phone | OTP, tracking, support | authentication/service | support/admin, seller where needed for delivery | participants/OTP | SMS provider | OTP short term; transaction record 7 years | mask outside operational need |
| Email | delivery/support notices | service | seller where needed, support/admin | participants | email provider | 7 years for transaction records | optional |
| Shipping address | fulfillment | contract/service | seller, support/admin | participants | delivery/export tools | fulfillment plus 7 years if accounting/support requires | collect only for shipping |
| Quantity | deal operation | contract | seller/admin/buyer | participants | none | 7 years | no |
| Deal status | tracking | service | buyer/seller/admin | deals/participants | none | 7 years | no |
| Charge status | payment operation | contract/legal obligation | buyer/admin, seller summarized | participants/payment attempts | payment provider | 7 years | expose labels, not provider refs |
| Token/auth id | authorization/capture/reconcile | payment necessity | server/admin only | audit/payment events | payment provider | 7 years | never expose to buyer UI |
| OTP messages | verification | security | buyer, support metadata | OTP tables/notifications | SMS provider | short operational retention | avoid content storage where possible |
| Tracking link ids | secure tracking | service/security | buyer/admin | tracking tokens | none | expire where possible | tokenized links |
| cookies/localStorage | session/flow continuity | service | browser/server session | browser/session tables | none | session/short TTL | no marketing by default |

## Seller

| Data | Purpose | Basis | Visible To | Stored In | Vendors | Retention | Minimize |
|---|---|---|---|---|---|---|---|
| Business/name/contact | public deal and support | contract/legal disclosure | buyers/admin | seller_accounts | email/SMS | account life + legal period | required for publish |
| KYC details | seller approval | legal/risk | admin only | seller_accounts/docs | KYC/bank if integrated | 7 years after activity | collect MVP minimum |
| Bank details | settlement | contract/legal | finance/admin | payout provider/tables | bank/payout provider | 7 years | masked in UI |
| Deals/documents | operation/accounting | contract/legal | seller/admin | DB/invoice docs | invoice provider | 7 years | scope by seller |
| settlement/payout data | seller payment | contract/accounting | seller/admin | payout rail | payout provider | 7 years | aggregate where possible |

## Distributor

Distributor data includes name, contact, share links, clicks, visits, aggregate joins, attributed units and attributed gross. Distributor surfaces must not expose buyer personal information.

Purpose: attribution and measurement. Basis: service/legitimate operational need. Visible to: distributor/seller/admin in aggregate. Stored in affiliate tables and analytics. Vendors: none unless analytics provider is added. Retention: 24 months for attribution, longer only for disputes. Minimize by keeping aggregate-only surfaces.

## Admin

Admin identity, actions, audit records, sessions and MFA events are collected for security, RBAC, audit and incident response. Visible only to authorized admins. Stored in admin identity/control/audit tables. Retention: 7 years for sensitive audit, shorter for sessions and MFA events. Minimize by showing buyer PII only when needed.
