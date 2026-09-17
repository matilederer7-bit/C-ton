-- Apply after canonical migration 072 (product catalog). The web runtime is an
-- authenticated server role; seller ownership is additionally enforced in
-- every API query. No anon/authenticated Data API grants are introduced.
-- Products are archived, never deleted, by the web runtime.

DO $$
BEGIN
  IF to_regclass('siton.products') IS NULL
     OR to_regclass('siton.product_images') IS NULL THEN
    RAISE EXCEPTION 'run migration 072 before this grant file';
  END IF;
END
$$;

BEGIN;
ALTER TABLE siton.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE siton.product_images ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON siton.products, siton.product_images FROM PUBLIC, anon, authenticated, siton_worker_runtime;

GRANT SELECT, INSERT, UPDATE ON siton.products TO siton_web_runtime;
GRANT SELECT, INSERT ON siton.product_images TO siton_web_runtime;

DROP POLICY IF EXISTS r2_web_select ON siton.products;
CREATE POLICY r2_web_select ON siton.products FOR SELECT TO siton_web_runtime USING (true);
DROP POLICY IF EXISTS r2_web_insert ON siton.products;
CREATE POLICY r2_web_insert ON siton.products FOR INSERT TO siton_web_runtime WITH CHECK (true);
DROP POLICY IF EXISTS r2_web_update ON siton.products;
CREATE POLICY r2_web_update ON siton.products FOR UPDATE TO siton_web_runtime USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS r2_web_select ON siton.product_images;
CREATE POLICY r2_web_select ON siton.product_images FOR SELECT TO siton_web_runtime USING (true);
DROP POLICY IF EXISTS r2_web_insert ON siton.product_images;
CREATE POLICY r2_web_insert ON siton.product_images FOR INSERT TO siton_web_runtime WITH CHECK (true);
COMMIT;

DO $verify$
BEGIN
  IF has_table_privilege('siton_web_runtime', 'siton.products', 'DELETE') THEN
    RAISE EXCEPTION 'products must be archived, not deleted by the web runtime';
  END IF;
  IF has_table_privilege('anon', 'siton.products', 'SELECT')
     OR has_table_privilege('authenticated', 'siton.products', 'SELECT') THEN
    RAISE EXCEPTION 'Product catalog must not be exposed directly through the Data API';
  END IF;
END
$verify$;
