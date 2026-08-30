# R2 runtime permission audit

Date: 2026-08-30

Scope: `supabase/staging/006_canonical_postgres_runtime_boundary.sql` and every
runtime SQL statement reachable from the monolithic Fastify Web process or the
continuous Worker process. The profiles are PostgreSQL group roles. External
LOGIN principals and secrets are intentionally deferred to R3.

`supabase/staging/007_runtime_role_admin_set_proof.sql` enables the existing
`postgres` administrative owner to use `SET ROLE` for live proof. The membership
remains non-inheriting. This does not add application authority because
`postgres` already owns the canonical schemas; it only permits testing the
strictly weaker runtime identities.

## Classification rules

- `REQUIRED_BY_RUNTIME`: an operation is issued by the current runtime path.
- `REQUIRED_BY_UPDATE_PREDICATE`: RLS visibility required for an UPDATE or an
  `INSERT ... ON CONFLICT DO UPDATE`, even though no independent read path exists.
- `REQUIRED_BY_READINESS`: the schema-contract readiness query.
- `UNNECESSARY`: no reachable operation in that process requires the privilege.

## Web profile

Database and schemas:

- `CONNECT` on the current database: `REQUIRED_BY_RUNTIME`
- `USAGE` on `siton` and `public`: `REQUIRED_BY_RUNTIME`
- no `USAGE` on `siton_inventory`

Tables:

| Operation | Classification | Exact tables |
| --- | --- | --- |
| SELECT | `REQUIRED_BY_READINESS` | `migration_ledger` |
| SELECT | `REQUIRED_BY_UPDATE_PREDICATE` | `admin_mfa_factors`, `invoice_reconciliation_cases` |
| SELECT | `REQUIRED_BY_RUNTIME` | `admin_actions`, `admin_control_flags`, `admin_mfa_challenges`, `admin_sessions`, `admin_users`, `affiliate_accounts`, `affiliate_attributions`, `affiliate_link_events`, `affiliate_links`, `audit_log`, `buyer_payment_methods`, `buyer_resume_contexts`, `buyer_sessions`, `deal_chat_messages`, `deal_delivery_options`, `deal_images`, `deal_ticket_terms`, `deal_voucher_terms`, `deals`, `distributor_sessions`, `fulfillment_units`, `idempotency_log`, `infrastructure_change_audit`, `invoice_document_attempts`, `invoice_documents`, `invoice_webhook_events`, `invoice_webhook_security_events`, `join_idempotency_results`, `legal_acceptances`, `notification_events`, `notifications`, `operational_cases`, `otp_challenges`, `otp_proofs`, `outbox_dlq`, `outbox_events`, `participant_tracking_tokens`, `participants`, `payment_attempts`, `payment_webhook_security_events`, `platform_fee_money_events`, `seller_accounts`, `seller_payout_batches`, `seller_sessions`, `storage_cleanup_tasks`, `storage_orphan_reports`, `support_tickets`, `webhook_events`, `worker_heartbeats` |
| INSERT | `REQUIRED_BY_RUNTIME` | `admin_actions`, `admin_control_flag_events`, `admin_control_flags`, `admin_mfa_challenges`, `admin_mfa_factors`, `admin_sessions`, `affiliate_attributions`, `affiliate_link_events`, `affiliate_links`, `audit_log`, `buyer_payment_methods`, `buyer_resume_contexts`, `buyer_sessions`, `deal_chat_messages`, `deal_delivery_options`, `deal_images`, `deal_ticket_terms`, `deal_voucher_terms`, `deals`, `discovery_events`, `distributor_sessions`, `fulfillment_units`, `idempotency_log`, `infrastructure_change_audit`, `invoice_document_attempts`, `invoice_documents`, `invoice_reconciliation_cases`, `invoice_webhook_events`, `invoice_webhook_security_events`, `join_idempotency_results`, `legal_acceptances`, `operational_case_events`, `operational_cases`, `operational_recovery_audit`, `otp_challenges`, `otp_delivery_attempts`, `otp_proofs`, `outbox_events`, `participant_tracking_tokens`, `participants`, `payment_attempts`, `payment_webhook_security_events`, `platform_fee_money_events`, `seller_accounts`, `seller_security_events`, `seller_sessions`, `storage_cleanup_tasks`, `storage_orphan_reports`, `support_tickets`, `webhook_events` |
| UPDATE | `REQUIRED_BY_RUNTIME` | `admin_actions`, `admin_control_flags`, `admin_mfa_challenges`, `admin_mfa_factors`, `admin_sessions`, `admin_users`, `affiliate_accounts`, `buyer_payment_methods`, `buyer_resume_contexts`, `buyer_sessions`, `deal_images`, `deal_ticket_terms`, `deal_voucher_terms`, `deals`, `distributor_sessions`, `fulfillment_units`, `infrastructure_change_audit`, `invoice_document_attempts`, `invoice_documents`, `invoice_reconciliation_cases`, `invoice_webhook_events`, `notification_events`, `operational_cases`, `otp_challenges`, `outbox_events`, `participant_tracking_tokens`, `participants`, `payment_attempts`, `seller_accounts`, `seller_sessions`, `storage_cleanup_tasks`, `support_tickets`, `webhook_events` |
| DELETE | `REQUIRED_BY_RUNTIME` | `deal_delivery_options`, `deal_images` |

Sequences:

- `USAGE, SELECT` on `otp_delivery_attempts_attempt_id_seq` and
  `operational_recovery_audit_audit_sequence_seq`: `REQUIRED_BY_RUNTIME`

Function:

- `EXECUTE` on `public.siton_inventory_rpc(text,jsonb)`:
  `REQUIRED_BY_RUNTIME`
- `EXECUTE` on the non-mutating trigger helpers `flag_is_set(text)`,
  `is_valid_action_name(text)`, `is_valid_buyer_transition(text,text)`,
  `is_valid_deal_transition(text,text)`, `is_valid_money_transition(text,text)`,
  `is_valid_transition(text,text,text)`, and `require_action_name()`:
  `REQUIRED_BY_RUNTIME`

## Worker profile

Database and schemas:

- `CONNECT` on the current database: `REQUIRED_BY_RUNTIME`
- `USAGE` on `siton` and `public`: `REQUIRED_BY_RUNTIME`
- no `USAGE` on `siton_inventory`

Tables:

| Operation | Classification | Exact tables |
| --- | --- | --- |
| SELECT | `REQUIRED_BY_READINESS` | `migration_ledger` |
| SELECT | `REQUIRED_BY_UPDATE_PREDICATE` | `invoice_document_attempts`, `invoice_reconciliation_cases`, `worker_heartbeats` |
| SELECT | `REQUIRED_BY_RUNTIME` | `admin_control_flags`, `audit_log`, `deals`, `fulfillment_units`, `idempotency_log`, `invoice_documents`, `notification_events`, `operational_recovery_audit`, `outbox_dlq`, `outbox_events`, `participants`, `payment_attempts`, `platform_fee_money_events`, `seller_accounts`, `seller_payout_attempts`, `seller_payout_batch_items`, `seller_payout_batches`, `seller_payout_reconciliation_cases`, `seller_settlements`, `storage_cleanup_tasks` |
| INSERT | `REQUIRED_BY_RUNTIME` | `audit_log`, `fulfillment_units`, `idempotency_log`, `invoice_document_attempts`, `invoice_documents`, `invoice_reconciliation_cases`, `notification_attempts`, `notification_events`, `operational_recovery_audit`, `outbox_dlq`, `outbox_events`, `payment_attempts`, `platform_fee_money_events`, `seller_payout_attempts`, `seller_payout_batch_items`, `seller_payout_batches`, `seller_payout_reconciliation_cases`, `seller_settlements`, `storage_cleanup_tasks`, `worker_heartbeats` |
| UPDATE | `REQUIRED_BY_RUNTIME` | `deals`, `invoice_document_attempts`, `invoice_documents`, `invoice_reconciliation_cases`, `notification_events`, `outbox_events`, `participants`, `payment_attempts`, `seller_payout_attempts`, `seller_payout_batch_items`, `seller_payout_batches`, `seller_payout_reconciliation_cases`, `seller_settlements`, `storage_cleanup_tasks`, `worker_heartbeats` |
| DELETE | `REQUIRED_BY_RUNTIME` | `outbox_events` |

Sequences:

- `USAGE, SELECT` on `notification_attempts_attempt_id_seq` and
  `operational_recovery_audit_audit_sequence_seq`: `REQUIRED_BY_RUNTIME`

Function:

- `EXECUTE` on `public.siton_inventory_rpc(text,jsonb)`:
  `REQUIRED_BY_RUNTIME`
- `EXECUTE` on the same seven non-mutating trigger helpers listed for Web:
  `REQUIRED_BY_RUNTIME`

## Unnecessary permissions removed

All entries below are Worker permissions. No Web permission was demonstrably
unnecessary for the current monolithic process.

| Operation | Classification | Exact tables |
| --- | --- | --- |
| SELECT | `UNNECESSARY` | `affiliate_accounts`, `affiliate_links`, `buyer_resume_contexts`, `deal_delivery_options`, `deal_images`, `join_idempotency_results`, `notification_attempts`, `seller_sessions` |
| INSERT | `UNNECESSARY` | `affiliate_attributions`, `deal_delivery_options`, `deal_images`, `deals`, `discovery_events`, `join_idempotency_results`, `legal_acceptances`, `operational_case_events`, `operational_cases`, `participants` |
| UPDATE | `UNNECESSARY` | `buyer_resume_contexts`, `deal_images` |
| DELETE | `UNNECESSARY` | `deal_delivery_options`, `deal_images` |

Total removed: 22 operation-level table privileges.

## Required operation gaps corrected

- Web `UPDATE`: `buyer_payment_methods`, `deal_ticket_terms`,
  `deal_voucher_terms`, `invoice_document_attempts`. These are current Web
  `ON CONFLICT DO UPDATE` paths.
- Worker `SELECT, INSERT`: `fulfillment_units`. Deal completion issues
  fulfillment units in the Worker.
- Worker `UPDATE`: `invoice_document_attempts`, `seller_payout_attempts`.
  Both are Worker `ON CONFLICT DO UPDATE` paths.
- Web and Worker `EXECUTE`: seven validation helpers called by the canonical
  state/audit triggers. The live transaction proof found this caller-rights
  dependency; no mutating or security-definer `siton` function was granted.

These corrections do not grant schema ownership, DDL, inventory-table access,
or browser access. They make the audited operation-specific matrix match the
current two-process runtime exactly.

## Explicit denials retained

- Both access profiles are `NOLOGIN`, `NOINHERIT`, `NOSUPERUSER`, `NOCREATEDB`,
  `NOCREATEROLE`, `NOREPLICATION`, and `NOBYPASSRLS`.
- Neither profile owns `siton`, `siton_inventory`, or their objects.
- Neither profile receives DDL privileges or direct privileges in
  `siton_inventory`.
- `anon` and `authenticated` retain no direct access to `siton`,
  `siton_inventory`, or the canonical inventory RPC.
