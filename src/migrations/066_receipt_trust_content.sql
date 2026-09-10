BEGIN;
ALTER TABLE siton.deals ADD COLUMN IF NOT EXISTS receipt_config JSONB NULL;
ALTER TABLE siton.seller_accounts ADD COLUMN IF NOT EXISTS public_profile_id UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS seller_public_profile_id ON siton.seller_accounts(public_profile_id);
ALTER TABLE siton.seller_accounts ADD COLUMN IF NOT EXISTS profile_image_id UUID NULL;
ALTER TABLE siton.participants ADD COLUMN IF NOT EXISTS public_name_opt_in BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE siton.deal_chat_messages ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '' CHECK (char_length(title) <= 80);
CREATE UNIQUE INDEX IF NOT EXISTS fulfillment_receipt_locator ON siton.fulfillment_units ((metadata_jsonb->>'receipt_code')) WHERE unit_index = 1 AND metadata_jsonb->>'receipt_code' IS NOT NULL;
CREATE TABLE IF NOT EXISTS siton.content_assets (
  asset_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_ref TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/webp')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS siton.site_content (
  content_key TEXT PRIMARY KEY,
  value_jsonb JSONB NOT NULL,
  previous_value_jsonb JSONB NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMIT;
