-- Black-Sky DB integrity (canonical migration 078) — staging runtime boundary.
-- Apply AFTER src/migrations/078_black_sky_db_integrity.sql, and RE-APPLY after
-- any re-run of 006 (006 re-grants table-level UPDATE on payment_attempts and
-- webhook_events, which would silently undo section (b)). Idempotent.
--
-- (a) siton.fixture_purge_audit (078) is test-fixture evidence: no runtime or
--     browser role holds any privilege on it. 078's trigger functions run with
--     the caller's rights and need no EXECUTE grant (trigger bodies; see 024).
--     The deal-delete guard reads only tables the web runtime already SELECTs
--     (006 + 018): participants, payment_attempts, platform_fee_money_events,
--     webhook_events, payment_authorization_bindings, invoice_documents.
-- (b) D9: the web runtime's UPDATE on payment_attempts and webhook_events is
--     narrowed from the whole table to the columns the web code paths write:
--       payment_attempts — src/payment_attempt_helpers.ts (retire, settle,
--         arm/dispatch, settle-dispatch, horizon extension): result_class,
--         outcome_note, dispatch_state, provider_reference, failure_evidence,
--         owner_event_uuid, owner_lease_generation, dispatched_at,
--         settlement_horizon_at, negative_finality_authoritative (+ resolved_at,
--         updated_at, which the 067 lifecycle trigger maintains).
--       webhook_events — src/webhook_ingestion.ts (reprocess claim, markEvent):
--         status, processed_at, payload_jsonb, deal_id, participant_id.
--     Identity columns (payment_attempts attempt_id/participant_id/deal_id/
--     attempt_type/correlation_id/created_at; webhook_events provider/event_id/
--     received_at/request_id) are no longer writable by the web runtime at all;
--     078 additionally makes them immutable for every role. The worker's
--     table-level grants are unchanged (006/014).
-- (c) D12: the web runtime keeps DELETE on outbox_events / outbox_dlq /
--     idempotency_log / viral_metrics_cache — the draft-delete route
--     (src/app.ts DELETE /api/seller/deals/:dealId) clears a deleted draft's
--     bookkeeping rows with it (018). It is intentionally NOT revoked here.

BEGIN;

DO $$
BEGIN
  IF to_regclass('siton.fixture_purge_audit') IS NULL THEN
    RAISE EXCEPTION 'run src/migrations/078_black_sky_db_integrity.sql before this grant file';
  END IF;
END
$$;

-- (a)
ALTER TABLE siton.fixture_purge_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE siton.fixture_purge_audit FROM PUBLIC, anon, authenticated, siton_web_runtime, siton_worker_runtime;
REVOKE ALL ON SEQUENCE siton.fixture_purge_audit_purge_id_seq FROM PUBLIC, anon, authenticated, siton_web_runtime, siton_worker_runtime;

-- (b)
REVOKE UPDATE ON siton.payment_attempts FROM siton_web_runtime;
GRANT UPDATE (
  result_class, outcome_note, dispatch_state, provider_reference, failure_evidence,
  owner_event_uuid, owner_lease_generation, dispatched_at, settlement_horizon_at,
  negative_finality_authoritative, resolved_at, updated_at
) ON siton.payment_attempts TO siton_web_runtime;

REVOKE UPDATE ON siton.webhook_events FROM siton_web_runtime;
GRANT UPDATE (status, processed_at, payload_jsonb, deal_id, participant_id)
  ON siton.webhook_events TO siton_web_runtime;

-- Self-check.
DO $verify$
DECLARE
  v_role text;
  v_col text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'siton_web_runtime', 'siton_worker_runtime'] LOOP
    IF has_table_privilege(v_role, 'siton.fixture_purge_audit', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') THEN
      RAISE EXCEPTION '% must hold no privilege on siton.fixture_purge_audit', v_role;
    END IF;
  END LOOP;

  IF has_table_privilege('siton_web_runtime', 'siton.payment_attempts', 'UPDATE')
     OR has_table_privilege('siton_web_runtime', 'siton.webhook_events', 'UPDATE') THEN
    RAISE EXCEPTION 'siton_web_runtime still holds table-level UPDATE on payment_attempts/webhook_events';
  END IF;
  FOREACH v_col IN ARRAY ARRAY['result_class', 'outcome_note', 'dispatch_state', 'provider_reference', 'failure_evidence',
      'owner_event_uuid', 'owner_lease_generation', 'dispatched_at', 'settlement_horizon_at', 'negative_finality_authoritative'] LOOP
    IF NOT has_column_privilege('siton_web_runtime', 'siton.payment_attempts', v_col, 'UPDATE') THEN
      RAISE EXCEPTION 'siton_web_runtime is missing UPDATE(%) on payment_attempts', v_col;
    END IF;
  END LOOP;
  FOREACH v_col IN ARRAY ARRAY['attempt_id', 'participant_id', 'deal_id', 'attempt_type', 'correlation_id', 'created_at'] LOOP
    IF has_column_privilege('siton_web_runtime', 'siton.payment_attempts', v_col, 'UPDATE') THEN
      RAISE EXCEPTION 'siton_web_runtime must not UPDATE payment_attempts.%', v_col;
    END IF;
  END LOOP;
  FOREACH v_col IN ARRAY ARRAY['status', 'processed_at', 'payload_jsonb', 'deal_id', 'participant_id'] LOOP
    IF NOT has_column_privilege('siton_web_runtime', 'siton.webhook_events', v_col, 'UPDATE') THEN
      RAISE EXCEPTION 'siton_web_runtime is missing UPDATE(%) on webhook_events', v_col;
    END IF;
  END LOOP;
  FOREACH v_col IN ARRAY ARRAY['provider', 'event_id', 'received_at', 'request_id'] LOOP
    IF has_column_privilege('siton_web_runtime', 'siton.webhook_events', v_col, 'UPDATE') THEN
      RAISE EXCEPTION 'siton_web_runtime must not UPDATE webhook_events.%', v_col;
    END IF;
  END LOOP;

  -- money/audit history: no runtime DELETE/TRUNCATE (mirrors src/schema_contract.ts)
  FOREACH v_role IN ARRAY ARRAY['siton_web_runtime', 'siton_worker_runtime'] LOOP
    FOREACH v_col IN ARRAY ARRAY['participants', 'payment_attempts', 'platform_fee_money_events', 'seller_settlements',
        'seller_payout_batches', 'seller_payout_batch_items', 'invoice_documents', 'audit_log', 'webhook_events',
        'payment_authorization_bindings', 'fulfillment_units', 'deal_field_change_audit'] LOOP
      IF has_table_privilege(v_role, format('siton.%I', v_col), 'DELETE,TRUNCATE') THEN
        RAISE EXCEPTION '% holds DELETE/TRUNCATE on siton.%', v_role, v_col;
      END IF;
    END LOOP;
  END LOOP;
END
$verify$;

COMMIT;
