-- Migration 052: R7 canonical Supabase Storage provider.
--
-- Supabase Storage (bucket deal-images, reached through the privileged
-- storage-broker Edge Function) becomes the canonical durable authority for
-- deal media. The runtime records provider 'supabase' on new image rows and
-- cleanup tasks; 'local' remains only for tests/dev and legacy rows, and 's3'
-- remains for the CI MinIO smoke and a future direct S3 deployment.

ALTER TABLE siton.storage_cleanup_tasks
  DROP CONSTRAINT IF EXISTS storage_cleanup_tasks_storage_provider_check;

ALTER TABLE siton.storage_cleanup_tasks
  ADD CONSTRAINT storage_cleanup_tasks_storage_provider_check
  CHECK (storage_provider IN ('local','s3','supabase'));

ALTER TABLE siton.deal_images
  DROP CONSTRAINT IF EXISTS ck_deal_images_storage_provider;

ALTER TABLE siton.deal_images
  ADD CONSTRAINT ck_deal_images_storage_provider
  CHECK (storage_provider IN ('local','s3','supabase'));

-- public_url, when present, must be an absolute https URL (the storage CDN)
-- or a server-relative proxy path; never a javascript:/data: vector.
ALTER TABLE siton.deal_images
  DROP CONSTRAINT IF EXISTS ck_deal_images_public_url_shape;

ALTER TABLE siton.deal_images
  ADD CONSTRAINT ck_deal_images_public_url_shape
  CHECK (public_url IS NULL OR public_url ~ '^(https://|/)');
