BEGIN;
-- Site CMS: draft/published separation on the existing site_content rows.
-- value_jsonb stays the PUBLISHED page (the only thing the public site reads);
-- draft_jsonb is the owner's unpublished working copy. Forward-only, additive.
ALTER TABLE siton.site_content ADD COLUMN IF NOT EXISTS draft_jsonb JSONB NULL;
ALTER TABLE siton.site_content ADD COLUMN IF NOT EXISTS draft_updated_at TIMESTAMPTZ NULL;
ALTER TABLE siton.site_content ADD COLUMN IF NOT EXISTS draft_updated_by TEXT NULL;
ALTER TABLE siton.site_content ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ NULL;
-- Hero video: content assets may now be a bounded MP4/WebM uploaded by a named
-- admin (server validates signature, size and ownership; sellers stay image-only).
ALTER TABLE siton.content_assets DROP CONSTRAINT IF EXISTS content_assets_mime_type_check;
ALTER TABLE siton.content_assets ADD CONSTRAINT content_assets_mime_type_check
  CHECK (mime_type IN ('image/png','image/jpeg','image/webp','video/mp4','video/webm'));
COMMIT;
