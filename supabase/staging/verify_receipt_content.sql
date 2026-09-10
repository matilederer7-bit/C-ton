-- Run against siton-staging after 066 + staging 023. All probe writes roll back.
BEGIN;
DO $verify$
DECLARE role_name text; table_name text;
BEGIN
  IF (SELECT count(*) FROM siton.migration_ledger WHERE migration_id='066'
      AND position=59 AND status='succeeded'
      AND checksum_sha256='c1aed14cf2146841ab7a8c9a274210a1e500978f3bc00bbcadc1f37cbcca6ef2') <> 1 THEN
    RAISE EXCEPTION '066 ledger mismatch';
  END IF;
  FOREACH table_name IN ARRAY ARRAY['content_assets','site_content'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=('siton.'||table_name)::regclass) THEN
      RAISE EXCEPTION 'RLS missing: %', table_name;
    END IF;
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','siton_worker_runtime'] LOOP
      IF has_table_privilege(role_name,'siton.'||table_name,'SELECT,INSERT,UPDATE,DELETE') THEN
        RAISE EXCEPTION 'unexpected privilege: % %', role_name, table_name;
      END IF;
    END LOOP;
    IF has_table_privilege('siton_web_runtime','siton.'||table_name,'DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'excess web privilege: %',table_name;
    END IF;
  END LOOP;
  IF has_table_privilege('siton_web_runtime','siton.content_assets','UPDATE') THEN
    RAISE EXCEPTION 'content assets must be immutable to runtime';
  END IF;
END $verify$;
SET LOCAL ROLE siton_web_runtime;
INSERT INTO siton.content_assets(asset_id,owner_ref,storage_key,mime_type)
VALUES ('accec066-0000-4000-8000-000000000001','acceptance-probe','__acceptance_rollback_only__','image/png');
INSERT INTO siton.site_content(content_key,value_jsonb,updated_by)
VALUES ('__acceptance_rollback_only__','{"title":"probe"}','acceptance-probe');
UPDATE siton.site_content SET revision=revision+1 WHERE content_key='__acceptance_rollback_only__';
DO $verify$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM siton.site_content WHERE content_key='__acceptance_rollback_only__' AND revision=2) THEN
    RAISE EXCEPTION 'web content persistence failed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM siton.content_assets WHERE asset_id='accec066-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'web asset persistence failed';
  END IF;
END $verify$;
RESET ROLE;
ROLLBACK;
