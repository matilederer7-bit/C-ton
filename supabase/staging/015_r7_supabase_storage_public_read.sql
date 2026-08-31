-- R7: deal imagery becomes publicly readable product media served from the
-- Supabase Storage CDN. Object keys are system-generated UUID paths (never
-- user filenames or PII), so public read exposes only intentionally public
-- product imagery.
--
-- Mutations remain privileged: storage.objects carries NO client policies, so
-- anon/authenticated keys cannot insert/update/delete. The only mutation path
-- is the storage-broker Edge Function (service role inside Supabase's own
-- runtime, gated by the SHA-256-pinned x-siton-broker-key header whose
-- plaintext lives solely in the Render Web/Worker environment).

BEGIN;

UPDATE storage.buckets
SET public = true
WHERE id = 'deal-images';

COMMIT;
