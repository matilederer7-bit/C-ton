-- Amazon Benchmark P0 staging boundary. The web runtime is an authenticated
-- server role; seller ownership is additionally enforced in every API query.
-- No anon/authenticated Data API grants are introduced.

DO $$
BEGIN
  IF to_regclass('siton.products') IS NULL
     OR to_regclass('siton.product_images') IS NULL
     OR to_regclass('siton.deal_service_terms') IS NULL THEN
    RAISE EXCEPTION 'run migration 062 before this grant file';
  END IF;
END
$$;

ALTER TABLE siton.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE siton.product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE siton.deal_service_terms ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON siton.products TO siton_web_runtime;
GRANT SELECT, INSERT ON siton.product_images TO siton_web_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON siton.deal_service_terms TO siton_web_runtime;

DROP POLICY IF EXISTS r2_web_all ON siton.products;
CREATE POLICY r2_web_all ON siton.products FOR ALL TO siton_web_runtime USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS r2_web_select ON siton.product_images;
CREATE POLICY r2_web_select ON siton.product_images FOR SELECT TO siton_web_runtime USING (true);
DROP POLICY IF EXISTS r2_web_insert ON siton.product_images;
CREATE POLICY r2_web_insert ON siton.product_images FOR INSERT TO siton_web_runtime WITH CHECK (true);
DROP POLICY IF EXISTS r2_web_all ON siton.deal_service_terms;
CREATE POLICY r2_web_all ON siton.deal_service_terms FOR ALL TO siton_web_runtime USING (true) WITH CHECK (true);

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
