-- Align the staging deal-media bucket with the application content contract.
-- The bucket has one global file-size ceiling, so it must allow the largest
-- supported admin asset (10 MiB video). Narrower per-type limits remain
-- enforced by the trusted Fastify boundary and storage-broker:
--   images: 5 MiB
--   admin hero video: 10 MiB
--
-- This changes storage metadata only. It does not create client mutation
-- policies, does not alter bucket public-read state, and does not touch data.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'deal-images') THEN
    RAISE EXCEPTION 'deal-images bucket is missing';
  END IF;
END
$$;

UPDATE storage.buckets
SET
  file_size_limit = 10485760,
  allowed_mime_types = ARRAY[
    'image/jpeg',
    'image/png',
    'image/webp',
    'video/mp4',
    'video/webm'
  ]::text[]
WHERE id = 'deal-images';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM storage.buckets
    WHERE id = 'deal-images'
      AND file_size_limit = 10485760
      AND allowed_mime_types @> ARRAY[
        'image/jpeg',
        'image/png',
        'image/webp',
        'video/mp4',
        'video/webm'
      ]::text[]
  ) THEN
    RAISE EXCEPTION 'deal-images bucket media policy did not converge';
  END IF;
END
$$;

COMMIT;
