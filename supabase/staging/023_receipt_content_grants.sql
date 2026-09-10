-- Apply after canonical migration 066. Server-side guards enforce ownership
-- and named-admin permissions; browser and worker roles have no direct access.
BEGIN;
ALTER TABLE siton.content_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE siton.site_content ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON siton.content_assets, siton.site_content FROM PUBLIC, anon, authenticated, siton_worker_runtime;
GRANT SELECT, INSERT ON siton.content_assets TO siton_web_runtime;
GRANT SELECT, INSERT, UPDATE ON siton.site_content TO siton_web_runtime;
DROP POLICY IF EXISTS r2_web_select ON siton.content_assets;
CREATE POLICY r2_web_select ON siton.content_assets FOR SELECT TO siton_web_runtime USING (true);
DROP POLICY IF EXISTS r2_web_insert ON siton.content_assets;
CREATE POLICY r2_web_insert ON siton.content_assets FOR INSERT TO siton_web_runtime WITH CHECK (true);
DROP POLICY IF EXISTS r2_web_select ON siton.site_content;
CREATE POLICY r2_web_select ON siton.site_content FOR SELECT TO siton_web_runtime USING (true);
DROP POLICY IF EXISTS r2_web_insert ON siton.site_content;
CREATE POLICY r2_web_insert ON siton.site_content FOR INSERT TO siton_web_runtime WITH CHECK (true);
DROP POLICY IF EXISTS r2_web_update ON siton.site_content;
CREATE POLICY r2_web_update ON siton.site_content FOR UPDATE TO siton_web_runtime USING (true) WITH CHECK (true);
COMMIT;
