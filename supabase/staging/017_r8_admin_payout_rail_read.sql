-- R8: the admin deal drilldown (GET /api/admin/deals/:id/profile) reads the
-- seller payout rail via getDealPayoutSummary — seller_settlements,
-- seller_payout_batch_items, seller_payout_reconciliation_cases (and the admin
-- payout ops surface also reads seller_payout_attempts). The R2 matrix granted
-- the Web runtime SELECT + an r2_web_select policy on seller_payout_batches but
-- NOT on these sibling tables, so the profile endpoint 500s (42501 permission
-- denied on seller_settlements) — which also blocks the in-deal Viral Tree UX.
--
-- Grant SELECT + an r2_web_select read policy on the four missing payout tables,
-- mirroring the existing seller_payout_batches grant exactly. Read-only for Web;
-- the worker keeps its existing INSERT/UPDATE authority (unchanged). These hold
-- settlement/payout amounts + statuses (admin-only money truth), never buyer
-- contact PII.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'seller_settlements',
    'seller_payout_batch_items',
    'seller_payout_reconciliation_cases',
    'seller_payout_attempts'
  ]
  LOOP
    EXECUTE format('GRANT SELECT ON siton.%I TO siton_web_runtime', t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='siton' AND tablename=t AND policyname='r2_web_select'
    ) THEN
      EXECUTE format(
        'CREATE POLICY r2_web_select ON siton.%I FOR SELECT TO siton_web_runtime USING (true)', t
      );
    END IF;
  END LOOP;
END
$$;

DO $verify$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'seller_settlements',
    'seller_payout_batch_items',
    'seller_payout_reconciliation_cases',
    'seller_payout_attempts'
  ]
  LOOP
    IF NOT has_table_privilege('siton_web_runtime', 'siton.'||t, 'SELECT') THEN
      RAISE EXCEPTION 'siton_web_runtime is missing SELECT on %', t;
    END IF;
  END LOOP;
END
$verify$;
