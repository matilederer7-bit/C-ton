BEGIN;

SET search_path TO siton;

ALTER TABLE siton.deals
  ALTER COLUMN state SET NOT NULL,
  ALTER COLUMN price_per_unit SET NOT NULL,
  ALTER COLUMN min_units SET NOT NULL,
  ALTER COLUMN deadline SET NOT NULL,
  ALTER COLUMN commission_rate SET NOT NULL,
  ALTER COLUMN threshold_units SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE siton.deals
  ALTER COLUMN state SET DEFAULT 'Draft',
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'siton'
      AND table_name = 'deals'
      AND constraint_name = 'deals_price_per_unit_positive'
  ) THEN
    ALTER TABLE siton.deals
      ADD CONSTRAINT deals_price_per_unit_positive
      CHECK (price_per_unit >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'siton'
      AND table_name = 'deals'
      AND constraint_name = 'deals_min_units_positive'
  ) THEN
    ALTER TABLE siton.deals
      ADD CONSTRAINT deals_min_units_positive
      CHECK (min_units > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'siton'
      AND table_name = 'deals'
      AND constraint_name = 'deals_threshold_units_positive'
  ) THEN
    ALTER TABLE siton.deals
      ADD CONSTRAINT deals_threshold_units_positive
      CHECK (threshold_units > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'siton'
      AND table_name = 'deals'
      AND constraint_name = 'deals_max_units_check'
  ) THEN
    ALTER TABLE siton.deals
      ADD CONSTRAINT deals_max_units_check
      CHECK (max_units IS NULL OR max_units >= min_units);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'siton'
      AND table_name = 'deals'
      AND constraint_name = 'deals_pending_plus_requires_published_at'
  ) THEN
    ALTER TABLE siton.deals
      ADD CONSTRAINT deals_pending_plus_requires_published_at
      CHECK (
        state IN ('Draft','Cancelled')
        OR published_at IS NOT NULL
      );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION siton.deals_before_update_enforce_hardening()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  is_published boolean;
BEGIN
  is_published := (OLD.published_at IS NOT NULL);

  IF is_published AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'published_at is immutable once set';
  END IF;

  IF is_published AND NEW.threshold_units IS DISTINCT FROM OLD.threshold_units THEN
    RAISE EXCEPTION 'threshold_units is immutable once set';
  END IF;

  IF is_published THEN
    IF NEW.price_per_unit IS DISTINCT FROM OLD.price_per_unit
      OR NEW.min_units IS DISTINCT FROM OLD.min_units
      OR NEW.max_units IS DISTINCT FROM OLD.max_units
      OR NEW.deadline IS DISTINCT FROM OLD.deadline
      OR NEW.commission_rate IS DISTINCT FROM OLD.commission_rate
    THEN
      RAISE EXCEPTION 'critical fields are immutable after publish';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deals_before_update_enforce_hardening ON siton.deals;

CREATE TRIGGER trg_deals_before_update_enforce_hardening
BEFORE UPDATE ON siton.deals
FOR EACH ROW
EXECUTE FUNCTION siton.deals_before_update_enforce_hardening();

COMMIT;
