ALTER TABLE siton.deal_images
  ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT NULL;

ALTER TABLE siton.deal_images
  DROP CONSTRAINT IF EXISTS ck_deal_images_checksum_sha256;

ALTER TABLE siton.deal_images
  ADD CONSTRAINT ck_deal_images_checksum_sha256
  CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$');