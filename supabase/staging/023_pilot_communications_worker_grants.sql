-- PILOT COMMUNICATIONS: runtime boundary for transactional notifications that
-- the WORKER now enqueues inside deal transitions (finalize completed/failed,
-- deadline failure, voucher/ticket issuance).
--
-- (a) participant_tracking_tokens — the Worker mints the buyer's tokenized
--     tracking link for those messages (purpose 'tracking', issued_via
--     'notification:<event>'). Without this grant the mint is rolled back to a
--     savepoint and the message is still queued with a TOKENLESS canonical
--     link (payload link_mode='tokenless', visible in the admin inspection
--     endpoint) — never a lost notification, never an aborted transition.
-- (b) seller_business_profiles — the seller recipient resolver falls back to
--     the business contact e-mail when the account carries no support/login
--     e-mail. Column-level SELECT that EXCLUDES bank_account_number, mirroring
--     the Web grant in 019. The lookup is savepoint-guarded, so a missing
--     grant degrades to the internal channel.
-- The Web runtime already holds INSERT on notification_events (012),
-- participant_tracking_tokens and seller_security_events (006) and
-- payment_webhook_security_events (006). Idempotent, safe to re-apply.

DO $$
BEGIN
  IF to_regclass('siton.participant_tracking_tokens') IS NULL OR to_regclass('siton.seller_business_profiles') IS NULL THEN
    RAISE EXCEPTION 'run migrations 032/058 before this grant file';
  END IF;
END
$$;

-- (a) worker mints tracking tokens for notification links
GRANT INSERT ON siton.participant_tracking_tokens TO siton_worker_runtime;
DROP POLICY IF EXISTS r2_worker_insert ON siton.participant_tracking_tokens;
CREATE POLICY r2_worker_insert ON siton.participant_tracking_tokens FOR INSERT TO siton_worker_runtime WITH CHECK (true);

-- (b) worker resolves the seller's business contact e-mail (no bank number)
GRANT SELECT (seller_id, contact_email, contact_name, business_name, updated_at)
  ON siton.seller_business_profiles TO siton_worker_runtime;
DROP POLICY IF EXISTS r2_worker_select ON siton.seller_business_profiles;
CREATE POLICY r2_worker_select ON siton.seller_business_profiles FOR SELECT TO siton_worker_runtime USING (true);

DO $verify$
BEGIN
  IF NOT has_table_privilege('siton_worker_runtime', 'siton.participant_tracking_tokens', 'INSERT') THEN
    RAISE EXCEPTION 'siton_worker_runtime is missing INSERT on participant_tracking_tokens';
  END IF;
  IF has_table_privilege('siton_worker_runtime', 'siton.participant_tracking_tokens', 'DELETE') THEN
    RAISE EXCEPTION 'siton_worker_runtime must NOT have DELETE on participant_tracking_tokens';
  END IF;
  IF NOT has_column_privilege('siton_worker_runtime', 'siton.seller_business_profiles', 'contact_email', 'SELECT') THEN
    RAISE EXCEPTION 'siton_worker_runtime is missing SELECT(contact_email) on seller_business_profiles';
  END IF;
  IF has_column_privilege('siton_worker_runtime', 'siton.seller_business_profiles', 'bank_account_number', 'SELECT') THEN
    RAISE EXCEPTION 'siton_worker_runtime must NOT read bank_account_number';
  END IF;
  IF has_table_privilege('siton_worker_runtime', 'siton.seller_business_profiles', 'INSERT')
     OR has_table_privilege('siton_worker_runtime', 'siton.seller_business_profiles', 'UPDATE') THEN
    RAISE EXCEPTION 'seller_business_profiles must stay read-only for siton_worker_runtime';
  END IF;
END
$verify$;
