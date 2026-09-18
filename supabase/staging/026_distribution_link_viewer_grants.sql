-- Apply after canonical migration 070 (Seller Distribution Hub).
--
-- This file also repairs one further web-runtime grant gap of the same shape,
-- found by auditing every siton table the Fastify app reaches against what the
-- canonical boundary grants it (see the tail of this file): affiliate_links had
-- SELECT and INSERT but NOT UPDATE.
--
-- WHY THIS FILE EXISTS. Migration 070 created the four distribution_link_viewer_*
-- tables, but nothing ever granted the web runtime anything on them, so EVERY
-- seller opening the distribution panel on ANY deal got a 500:
--
--   GET /api/seller/deals/:id/distribution
--     -> permission denied for table distribution_link_viewer_grants (42501)
--
-- The Seller Distribution Hub was therefore dead on staging from the day it
-- shipped. Repository CI could not have caught it: the suites drive these
-- routes as the owning superuser, where table privileges never apply. It was
-- found by opening the deployed seller UI and reading the Render logs.
--
-- The canonical boundary (006) now carries these tables, so a full re-run of
-- that file is equivalent to this one; this file is the narrow, idempotent
-- repair for a staging database that is already provisioned.
--
-- The rails stay NON-DESTRUCTIVE for the web runtime: SELECT/INSERT/UPDATE
-- only. A viewer, a grant and a session are REVOKED (revoked_at) and never
-- deleted; login attempts are append-only. No anon/authenticated Data API
-- grant is introduced, so none of this is reachable through PostgREST.

DO $$
BEGIN
  IF to_regclass('siton.distribution_link_viewers') IS NULL
     OR to_regclass('siton.distribution_link_viewer_grants') IS NULL
     OR to_regclass('siton.distribution_link_viewer_sessions') IS NULL
     OR to_regclass('siton.distribution_link_viewer_login_attempts') IS NULL THEN
    RAISE EXCEPTION 'run canonical migration 070 before this grant file';
  END IF;
END
$$;

BEGIN;
ALTER TABLE siton.distribution_link_viewers ENABLE ROW LEVEL SECURITY;
ALTER TABLE siton.distribution_link_viewer_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE siton.distribution_link_viewer_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE siton.distribution_link_viewer_login_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON
  siton.distribution_link_viewers,
  siton.distribution_link_viewer_grants,
  siton.distribution_link_viewer_sessions,
  siton.distribution_link_viewer_login_attempts
  FROM PUBLIC, anon, authenticated, siton_worker_runtime;

GRANT SELECT, INSERT, UPDATE ON siton.distribution_link_viewers TO siton_web_runtime;
GRANT SELECT, INSERT, UPDATE ON siton.distribution_link_viewer_grants TO siton_web_runtime;
GRANT SELECT, INSERT, UPDATE ON siton.distribution_link_viewer_sessions TO siton_web_runtime;
GRANT SELECT, INSERT ON siton.distribution_link_viewer_login_attempts TO siton_web_runtime;

DO $policies$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'distribution_link_viewers','distribution_link_viewer_grants',
    'distribution_link_viewer_sessions','distribution_link_viewer_login_attempts'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS r2_web_select ON siton.%I', v_table);
    EXECUTE format('CREATE POLICY r2_web_select ON siton.%I FOR SELECT TO siton_web_runtime USING (true)', v_table);
    EXECUTE format('DROP POLICY IF EXISTS r2_web_insert ON siton.%I', v_table);
    EXECUTE format('CREATE POLICY r2_web_insert ON siton.%I FOR INSERT TO siton_web_runtime WITH CHECK (true)', v_table);
  END LOOP;
  FOREACH v_table IN ARRAY ARRAY[
    'distribution_link_viewers','distribution_link_viewer_grants','distribution_link_viewer_sessions'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS r2_web_update ON siton.%I', v_table);
    EXECUTE format('CREATE POLICY r2_web_update ON siton.%I FOR UPDATE TO siton_web_runtime USING (true) WITH CHECK (true)', v_table);
  END LOOP;
END
$policies$;
COMMIT;

DO $verify$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'distribution_link_viewers','distribution_link_viewer_grants',
    'distribution_link_viewer_sessions','distribution_link_viewer_login_attempts'
  ] LOOP
    IF NOT has_table_privilege('siton_web_runtime', format('siton.%I', v_table), 'SELECT') THEN
      RAISE EXCEPTION 'web runtime must be able to read siton.% — that gap is the 500 this file repairs', v_table;
    END IF;
    IF has_table_privilege('siton_web_runtime', format('siton.%I', v_table), 'DELETE') THEN
      RAISE EXCEPTION 'siton.% is revoked, never deleted, by the web runtime', v_table;
    END IF;
    IF has_table_privilege('anon', format('siton.%I', v_table), 'SELECT')
       OR has_table_privilege('authenticated', format('siton.%I', v_table), 'SELECT') THEN
      RAISE EXCEPTION 'siton.% must not be exposed through the Data API', v_table;
    END IF;
    IF has_table_privilege('siton_worker_runtime', format('siton.%I', v_table), 'SELECT') THEN
      RAISE EXCEPTION 'the worker has no business reading siton.%', v_table;
    END IF;
  END LOOP;
  IF has_table_privilege('siton_web_runtime', 'siton.distribution_link_viewer_login_attempts', 'UPDATE') THEN
    RAISE EXCEPTION 'login attempts are append-only';
  END IF;
  RAISE NOTICE 'staging_026 distribution link viewer grants verified';
END
$verify$;

-- ── one further gap of the same shape ─────────────────────────────────────
--
-- affiliate_links: the web runtime could CREATE a distribution link but not
-- change one, so renaming it, changing its channel, or disabling and
-- re-enabling it (PATCH .../distribution/links/:linkId) answered 500.
--
-- seller_business_profiles looks like the same gap and is NOT: staging file 019
-- deliberately revokes table-level access and re-grants COLUMN-level SELECT
-- that excludes bank_account_number, so `has_table_privilege(...,'SELECT')` is
-- false ON PURPOSE. Granting it here (or adding the table to the boundary's
-- select list) would hand the web runtime the raw bank account number.
BEGIN;
GRANT UPDATE ON siton.affiliate_links TO siton_web_runtime;
DROP POLICY IF EXISTS r2_web_update ON siton.affiliate_links;
CREATE POLICY r2_web_update ON siton.affiliate_links FOR UPDATE TO siton_web_runtime USING (true) WITH CHECK (true);
COMMIT;

DO $verify_more$
BEGIN
  IF NOT has_table_privilege('siton_web_runtime', 'siton.affiliate_links', 'UPDATE') THEN
    RAISE EXCEPTION 'the web runtime must be able to rename and disable a distribution link it created';
  END IF;
  IF has_table_privilege('siton_web_runtime', 'siton.affiliate_links', 'DELETE') THEN
    RAISE EXCEPTION 'a distribution link is disabled, never deleted, by the web runtime';
  END IF;
  IF has_table_privilege('authenticated', 'siton.affiliate_links', 'SELECT') THEN
    RAISE EXCEPTION 'affiliate_links must not be exposed through the Data API';
  END IF;
  -- the column-level bank restriction from staging file 019 must survive this file
  IF to_regclass('siton.seller_business_profiles') IS NOT NULL THEN
    IF has_column_privilege('siton_web_runtime', 'siton.seller_business_profiles', 'bank_account_number', 'SELECT') THEN
      RAISE EXCEPTION 'the web runtime must NOT be able to read the raw bank account number';
    END IF;
  END IF;
  RAISE NOTICE 'staging_026 affiliate_links update verified; bank-number restriction intact';
END
$verify_more$;
