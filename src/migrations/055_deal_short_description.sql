-- P0.2 — deals carry BOTH a short sales description (cards / OG / top of the
-- deal page, bounded at 200 chars in the API) and the existing long
-- description (full story, bounded at 4000 chars in the API).
-- Forward-only and non-destructive: existing deals stay valid; surfaces fall
-- back to an excerpt of the long description while description_short is NULL.

ALTER TABLE siton.deals ADD COLUMN IF NOT EXISTS description_short TEXT;
