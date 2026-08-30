-- R2 canonical Postgres runtime boundary.
-- Runtime credentials are provisioned outside Git. These are NOLOGIN access profiles.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'siton_web_runtime') THEN
    CREATE ROLE siton_web_runtime NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'siton_worker_runtime') THEN
    CREATE ROLE siton_worker_runtime NOLOGIN NOINHERIT;
  END IF;
END
$roles$;

-- Supabase migration principals are not SUPERUSER and therefore cannot spell
-- ALTER ROLE ... NOSUPERUSER/NOBYPASSRLS. CREATE ROLE defaults those flags to
-- false; the safety block below asserts every flag and aborts on drift.
ALTER ROLE siton_web_runtime NOLOGIN NOINHERIT;
ALTER ROLE siton_worker_runtime NOLOGIN NOINHERIT;

DO $role_safety$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname IN ('siton_web_runtime', 'siton_worker_runtime')
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolcanlogin OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'R2 runtime access profiles must remain non-admin NOLOGIN roles';
  END IF;
END
$role_safety$;

REVOKE ALL ON SCHEMA siton FROM siton_web_runtime, siton_worker_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA siton FROM siton_web_runtime, siton_worker_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA siton FROM siton_web_runtime, siton_worker_runtime;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA siton FROM siton_web_runtime, siton_worker_runtime;
REVOKE ALL ON SCHEMA siton_inventory FROM siton_web_runtime, siton_worker_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA siton_inventory FROM siton_web_runtime, siton_worker_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA siton_inventory FROM siton_web_runtime, siton_worker_runtime;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA siton_inventory FROM siton_web_runtime, siton_worker_runtime;

DO $database_access$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO siton_web_runtime, siton_worker_runtime',
    current_database()
  );
END
$database_access$;

GRANT USAGE ON SCHEMA siton, public TO siton_web_runtime, siton_worker_runtime;

GRANT USAGE, SELECT ON SEQUENCE
  siton.otp_delivery_attempts_attempt_id_seq,
  siton.operational_recovery_audit_audit_sequence_seq
  TO siton_web_runtime;

GRANT USAGE, SELECT ON SEQUENCE
  siton.notification_attempts_attempt_id_seq,
  siton.operational_recovery_audit_audit_sequence_seq
  TO siton_worker_runtime;

ALTER TABLE siton.participants
  ADD COLUMN IF NOT EXISTS inventory_reservation_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS participants_inventory_reservation_uidx
  ON siton.participants(inventory_reservation_id)
  WHERE inventory_reservation_id IS NOT NULL;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'participants_inventory_reservation_fk'
      AND conrelid = 'siton.participants'::regclass
  ) THEN
    ALTER TABLE siton.participants
      ADD CONSTRAINT participants_inventory_reservation_fk
      FOREIGN KEY (inventory_reservation_id)
      REFERENCES siton_inventory.inventory_reservations(reservation_id)
      ON UPDATE RESTRICT
      ON DELETE RESTRICT;
  END IF;
END
$constraint$;

COMMENT ON COLUMN siton.participants.inventory_reservation_id IS
  'Canonical cross-schema link to the single siton_inventory reservation committed with this Join.';

DO $runtime_grants$
DECLARE
  v_table text;
  -- SELECT is limited to tables read by Web plus the two tables whose columns
  -- are read by UPDATE predicates under RLS.
  web_select_tables text[] := ARRAY[
    'admin_actions','admin_control_flags','admin_mfa_challenges','admin_mfa_factors',
    'admin_sessions','admin_users','affiliate_accounts','affiliate_attributions',
    'affiliate_link_events','affiliate_links','audit_log','buyer_payment_methods',
    'buyer_resume_contexts','buyer_sessions','deal_chat_messages','deal_delivery_options',
    'deal_images','deal_ticket_terms','deal_voucher_terms','deals','distributor_sessions',
    'fulfillment_units','idempotency_log','infrastructure_change_audit',
    'invoice_document_attempts','invoice_documents','invoice_reconciliation_cases',
    'invoice_webhook_events','invoice_webhook_security_events','join_idempotency_results',
    'legal_acceptances','migration_ledger','notification_events','notifications',
    'operational_cases','otp_challenges','otp_proofs','outbox_dlq','outbox_events',
    'participant_tracking_tokens','participants','payment_attempts',
    'payment_webhook_security_events','platform_fee_money_events','seller_accounts',
    'seller_payout_batches','seller_sessions','storage_cleanup_tasks','storage_orphan_reports',
    'support_tickets','webhook_events','worker_heartbeats'
  ];
  web_insert_tables text[] := ARRAY[
    'admin_actions','admin_control_flag_events','admin_control_flags','admin_mfa_challenges',
    'admin_mfa_factors','admin_sessions','affiliate_attributions','affiliate_link_events',
    'affiliate_links','audit_log','buyer_payment_methods','buyer_resume_contexts','buyer_sessions',
    'deal_chat_messages','deal_delivery_options','deal_images','deal_ticket_terms','deal_voucher_terms',
    'deals','discovery_events','distributor_sessions','fulfillment_units','idempotency_log',
    'infrastructure_change_audit','invoice_document_attempts','invoice_documents',
    'invoice_reconciliation_cases','invoice_webhook_events','invoice_webhook_security_events',
    'join_idempotency_results','legal_acceptances','operational_case_events','operational_cases',
    'operational_recovery_audit','otp_challenges','otp_delivery_attempts','otp_proofs','outbox_events',
    'participant_tracking_tokens','participants','payment_attempts','payment_webhook_security_events',
    'platform_fee_money_events','seller_accounts','seller_security_events','seller_sessions',
    'storage_cleanup_tasks','storage_orphan_reports','support_tickets','webhook_events'
  ];
  web_update_tables text[] := ARRAY[
    'admin_actions','admin_control_flags','admin_mfa_challenges','admin_mfa_factors','admin_sessions',
    'admin_users','affiliate_accounts','buyer_payment_methods','buyer_resume_contexts','buyer_sessions',
    'deal_images','deal_ticket_terms','deal_voucher_terms','deals','distributor_sessions',
    'fulfillment_units','infrastructure_change_audit','invoice_document_attempts','invoice_documents',
    'invoice_reconciliation_cases','invoice_webhook_events','notification_events','operational_cases',
    'otp_challenges','outbox_events','participant_tracking_tokens','participants','payment_attempts',
    'seller_accounts','seller_sessions','storage_cleanup_tasks','support_tickets','webhook_events'
  ];
  web_delete_tables text[] := ARRAY['deal_delivery_options','deal_images'];
  -- Worker SELECT is limited to queue, money, invoice, payout, recovery and
  -- readiness tables. UPDATE predicate dependencies are included explicitly.
  worker_select_tables text[] := ARRAY[
    'admin_control_flags','audit_log','deals','fulfillment_units','idempotency_log',
    'invoice_document_attempts','invoice_documents','invoice_reconciliation_cases',
    'migration_ledger','notification_events',
    'operational_recovery_audit','outbox_dlq','outbox_events','participants','payment_attempts',
    'platform_fee_money_events','seller_accounts','seller_payout_attempts',
    'seller_payout_batch_items','seller_payout_batches','seller_payout_reconciliation_cases',
    'seller_settlements','storage_cleanup_tasks','worker_heartbeats'
  ];
  worker_insert_tables text[] := ARRAY[
    'audit_log','fulfillment_units','idempotency_log','invoice_document_attempts','invoice_documents',
    'invoice_reconciliation_cases','notification_attempts','notification_events',
    'operational_recovery_audit','outbox_dlq','outbox_events','payment_attempts','platform_fee_money_events',
    'seller_payout_attempts','seller_payout_batch_items','seller_payout_batches',
    'seller_payout_reconciliation_cases','seller_settlements','storage_cleanup_tasks','worker_heartbeats'
  ];
  worker_update_tables text[] := ARRAY[
    'deals','invoice_document_attempts','invoice_documents','invoice_reconciliation_cases',
    'notification_events','outbox_events','participants','payment_attempts','seller_payout_attempts',
    'seller_payout_batch_items','seller_payout_batches','seller_payout_reconciliation_cases','seller_settlements',
    'storage_cleanup_tasks','worker_heartbeats'
  ];
  worker_delete_tables text[] := ARRAY['outbox_events'];
BEGIN
  FOREACH v_table IN ARRAY web_select_tables LOOP
    EXECUTE format('GRANT SELECT ON siton.%I TO siton_web_runtime', v_table);
    EXECUTE format('DROP POLICY IF EXISTS r2_web_select ON siton.%I', v_table);
    EXECUTE format('CREATE POLICY r2_web_select ON siton.%I FOR SELECT TO siton_web_runtime USING (true)', v_table);
  END LOOP;
  FOREACH v_table IN ARRAY web_insert_tables LOOP
    EXECUTE format('GRANT INSERT ON siton.%I TO siton_web_runtime', v_table);
    EXECUTE format('DROP POLICY IF EXISTS r2_web_insert ON siton.%I', v_table);
    EXECUTE format('CREATE POLICY r2_web_insert ON siton.%I FOR INSERT TO siton_web_runtime WITH CHECK (true)', v_table);
  END LOOP;
  FOREACH v_table IN ARRAY web_update_tables LOOP
    EXECUTE format('GRANT UPDATE ON siton.%I TO siton_web_runtime', v_table);
    EXECUTE format('DROP POLICY IF EXISTS r2_web_update ON siton.%I', v_table);
    EXECUTE format('CREATE POLICY r2_web_update ON siton.%I FOR UPDATE TO siton_web_runtime USING (true) WITH CHECK (true)', v_table);
  END LOOP;
  FOREACH v_table IN ARRAY web_delete_tables LOOP
    EXECUTE format('GRANT DELETE ON siton.%I TO siton_web_runtime', v_table);
    EXECUTE format('DROP POLICY IF EXISTS r2_web_delete ON siton.%I', v_table);
    EXECUTE format('CREATE POLICY r2_web_delete ON siton.%I FOR DELETE TO siton_web_runtime USING (true)', v_table);
  END LOOP;

  FOREACH v_table IN ARRAY worker_select_tables LOOP
    EXECUTE format('GRANT SELECT ON siton.%I TO siton_worker_runtime', v_table);
    EXECUTE format('DROP POLICY IF EXISTS r2_worker_select ON siton.%I', v_table);
    EXECUTE format('CREATE POLICY r2_worker_select ON siton.%I FOR SELECT TO siton_worker_runtime USING (true)', v_table);
  END LOOP;
  FOREACH v_table IN ARRAY worker_insert_tables LOOP
    EXECUTE format('GRANT INSERT ON siton.%I TO siton_worker_runtime', v_table);
    EXECUTE format('DROP POLICY IF EXISTS r2_worker_insert ON siton.%I', v_table);
    EXECUTE format('CREATE POLICY r2_worker_insert ON siton.%I FOR INSERT TO siton_worker_runtime WITH CHECK (true)', v_table);
  END LOOP;
  FOREACH v_table IN ARRAY worker_update_tables LOOP
    EXECUTE format('GRANT UPDATE ON siton.%I TO siton_worker_runtime', v_table);
    EXECUTE format('DROP POLICY IF EXISTS r2_worker_update ON siton.%I', v_table);
    EXECUTE format('CREATE POLICY r2_worker_update ON siton.%I FOR UPDATE TO siton_worker_runtime USING (true) WITH CHECK (true)', v_table);
  END LOOP;
  FOREACH v_table IN ARRAY worker_delete_tables LOOP
    EXECUTE format('GRANT DELETE ON siton.%I TO siton_worker_runtime', v_table);
    EXECUTE format('DROP POLICY IF EXISTS r2_worker_delete ON siton.%I', v_table);
    EXECUTE format('CREATE POLICY r2_worker_delete ON siton.%I FOR DELETE TO siton_worker_runtime USING (true)', v_table);
  END LOOP;
END
$runtime_grants$;

GRANT EXECUTE ON FUNCTION public.siton_inventory_rpc(text, jsonb)
  TO siton_web_runtime, siton_worker_runtime;

REVOKE ALL ON SCHEMA siton, siton_inventory FROM anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA siton, siton_inventory FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA siton, siton_inventory FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.siton_inventory_rpc(text, jsonb)
  FROM PUBLIC, anon, authenticated;
