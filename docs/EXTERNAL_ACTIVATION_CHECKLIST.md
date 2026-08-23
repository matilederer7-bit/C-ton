# Siton V1 External Activation Checklist

Status: operational/business work only. No item below authorizes a live write.

| Boundary | Configuration only | Account/credential only | Live verification only | Development required |
|---|---|---|---|---|
| Base44 runtime | environment, domains, automation owner/schedule | Base44 production access | publish, health, worker tick and rollback smoke | None known |
| Supabase | pool/connection, hosted migration plan, least privilege | project and server credentials | migration, inventory bridge, backup/restore and reconciliation | None known |
| Grow payments | base URL, paths, HTTPS callbacks, fail-closed mode | Sandbox IDs/key and later production approval | authorization/status/settlement/refund/webhook/replay/UNKNOWN | None known before provider discrepancy evidence |
| OTP/SMS | provider mode, sender, limits | provider account/credentials | delivery, retry, abuse and masked-log validation | None known |
| Email/notifications | provider mode/templates/sender | account/domain credentials | delivery, bounce, retry and DLQ | None known |
| Object storage | private bucket, CORS, lifecycle, prefix | least-privilege keys | upload/read/delete/signing/restart/cleanup | None known |
| Morning invoices | endpoint/template/tax policy | account/API/webhook secrets | issue/status/cancel/callback/PDF delivery | None known |
| Seller payout | approved operational rail/config | bank/provider account if external | controlled settlement and reconciliation | None known |
| Android/iOS | final IDs, URLs, association files, push config | Apple/Google/signing credentials | devices, signed archives, store review | None known |
| Legal/business | policies, company/bank/tax details | company, bank and provider onboarding | counsel/accountant approval | None known |
| Operations | dashboards, alert contacts, rollback window | named operators/admin MFA | backup restore, incident drill, pilot and accessibility review | None known |

## Required order

1. Establish company, bank, tax/legal approvals, named operators, and protected
   credential stores.
2. Provision Base44/Supabase and apply the reviewed hosted migration/publish
   plan with backup and rollback evidence.
3. Configure one external boundary at a time, starting in Sandbox or a
   non-money environment; retain correlation IDs and redacted evidence.
4. Run the no-network and full regression gates against the exact release SHA.
5. Perform controlled provider, mobile-device, security, recovery, and
   accessibility validation. UNKNOWN outcomes must reconcile before proceeding.
6. Obtain explicit business/security approval before production or real money.

Do not revive Render, expose secrets to the browser, use raw card data, enable
manual money/state bypasses, or treat a provider callback as final without the
canonical verification path.
