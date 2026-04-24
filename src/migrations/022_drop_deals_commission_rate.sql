-- Migration 022: drop legacy deals.commission_rate column end-to-end.
--
-- Spec (Wave 4 Final Audit, 2026-04-22): Siton platform fee is the system
-- constant SITON_PLATFORM_FEE_RATE = 0.08 (see src/platform_fee_money.ts).
-- It is neither per-deal nor seller-selectable.
--
-- Prior waves hardcoded the value to 0.08 at INSERT time, but the physical
-- column, its NOT NULL constraint, and its post-publish immutability trigger
-- remained in the schema. That was a confusion vector: a reader of the schema
-- would believe Siton supports per-deal variable commissions. This migration
-- removes the column and its associated trigger logic.
--
-- Safe to run against both Wave 3 databases (where the column still exists
-- and is populated with 0.08) and against any fresh-install database
-- (where the column was already removed from init_db.sql / migration 014 /
-- stage10c).

BEGIN;

-- Rewrite the enforce trigger function to match migration 014's body but
-- without the commission_rate immutability check. Function must be redefined
-- BEFORE the column is dropped because plpgsql functions do not re-compile
-- transitively on ALTER TABLE DROP COLUMN.
CREATE OR REPLACE FUNCTION siton.deals_before_update_enforce()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_action text;
BEGIN
  IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'deals.published_at is immutable once set';
  END IF;

  IF OLD.published_at IS NOT NULL THEN
    IF NEW.threshold_units IS DISTINCT FROM OLD.threshold_units THEN
      RAISE EXCEPTION 'deals.threshold_units is immutable after publish';
    END IF;
    IF NEW.price_per_unit IS DISTINCT FROM OLD.price_per_unit THEN
      RAISE EXCEPTION 'deals.price_per_unit is immutable after publish';
    END IF;
    IF NEW.min_units IS DISTINCT FROM OLD.min_units THEN
      RAISE EXCEPTION 'deals.min_units is immutable after publish';
    END IF;
    IF NEW.max_units IS DISTINCT FROM OLD.max_units THEN
      RAISE EXCEPTION 'deals.max_units is immutable after publish';
    END IF;
    IF NEW.deadline IS DISTINCT FROM OLD.deadline THEN
      RAISE EXCEPTION 'deals.deadline is immutable after publish';
    END IF;
  END IF;

  IF OLD.completion_window_until IS NOT NULL
     AND NEW.completion_window_until IS DISTINCT FROM OLD.completion_window_until THEN
    RAISE EXCEPTION 'deals.completion_window_until is immutable once set';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    v_action := siton.require_action_name();
    IF NOT siton.is_valid_deal_transition(OLD.state::text, NEW.state::text) THEN
      RAISE EXCEPTION 'illegal deal transition from=% to=% action=%', OLD.state, NEW.state, v_action;
    END IF;
    IF NOT siton.flag_is_set('siton.audit_written') THEN
      RAISE EXCEPTION 'deal state change requires audit_log in same transaction. action=%', v_action;
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- Rewrite the Stage 10C hardening trigger, also without commission_rate.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'siton'
      AND p.proname = 'deals_before_update_enforce_hardening'
  ) THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION siton.deals_before_update_enforce_hardening()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $body$
      DECLARE
        is_published BOOLEAN := OLD.published_at IS NOT NULL;
      BEGIN
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
          THEN
            RAISE EXCEPTION 'critical fields are immutable after publish';
          END IF;
        END IF;

        RETURN NEW;
      END
      $body$;
    $fn$;
  END IF;
END $$;

-- Now safe to drop the column.
ALTER TABLE siton.deals DROP COLUMN IF EXISTS commission_rate;

COMMIT;
