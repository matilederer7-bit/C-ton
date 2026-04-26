CREATE TABLE IF NOT EXISTS siton.deal_images (
  image_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  storage_provider TEXT NOT NULL DEFAULT 'local',
  storage_key TEXT NOT NULL,
  public_url TEXT NULL,
  original_filename TEXT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
  size_bytes INT NOT NULL CHECK (size_bytes > 0),
  width INT NULL,
  height INT NULL,
  sort_order INT NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deal_images_deal_order
  ON siton.deal_images (deal_id, sort_order, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_images_one_primary
  ON siton.deal_images (deal_id)
  WHERE is_primary = true;
