-- 059 — P0.4 deal field-change audit rail.
--
-- The canonical audit_log records STATE TRANSITIONS only (its trigger rightly
-- refuses from=to rows), so content changes on a live deal need their own
-- append-only evidence. First user: delivery/pickup editing on a published
-- deal with ZERO reliance (no participants ever, no payment bindings) —
-- allowed transactionally, recorded here with the full before/after value.

BEGIN;

SET search_path TO siton, public;

CREATE TABLE IF NOT EXISTS siton.deal_field_change_audit (
  change_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL,
  field_scope TEXT NOT NULL,
  deal_state TEXT NOT NULL,
  old_value JSONB NOT NULL,
  new_value JSONB NOT NULL,
  request_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_deal_field_change_audit_deal
  ON siton.deal_field_change_audit (deal_id, created_at DESC);

CREATE OR REPLACE FUNCTION siton.deal_field_change_audit_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'deal_field_change_audit is append-only';
END
$$;

-- Update-only immutability: rows are never rewritten. DELETE stays possible
-- solely through the deal FK cascade — deleting a zero-activity deal (already
-- tombstoned as an operational case) takes its field audit with it; there is
-- no standalone DELETE path in runtime code.
DROP TRIGGER IF EXISTS trg_deal_field_change_audit_no_update ON siton.deal_field_change_audit;
CREATE TRIGGER trg_deal_field_change_audit_no_update
BEFORE UPDATE ON siton.deal_field_change_audit
FOR EACH ROW
EXECUTE FUNCTION siton.deal_field_change_audit_append_only();

COMMIT;
