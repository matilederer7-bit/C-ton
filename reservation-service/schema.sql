CREATE SCHEMA IF NOT EXISTS siton_inventory;

CREATE TABLE IF NOT EXISTS siton_inventory.inventory_deals (
  deal_id uuid PRIMARY KEY,
  max_units integer NOT NULL CHECK (max_units > 0),
  reserved_units integer NOT NULL DEFAULT 0 CHECK (reserved_units >= 0 AND reserved_units <= max_units),
  committed_units integer NOT NULL DEFAULT 0 CHECK (committed_units >= 0 AND committed_units <= reserved_units),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS siton_inventory.inventory_action_idempotency (
  operation text NOT NULL CHECK (operation IN ('sync','close')),
  deal_id uuid NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  request_hash varchar(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('processing','completed')),
  lease_until timestamptz NOT NULL,
  response_status integer,
  canonical_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operation, deal_id, idempotency_key),
  CHECK ((status='processing' AND response_status IS NULL AND canonical_response IS NULL)
      OR (status='completed' AND response_status IS NOT NULL AND canonical_response IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS inventory_action_idempotency_processing_idx
  ON siton_inventory.inventory_action_idempotency(status, lease_until)
  WHERE status='processing';

CREATE TABLE IF NOT EXISTS siton_inventory.inventory_reservations (
  reservation_id uuid PRIMARY KEY,
  deal_id uuid NOT NULL REFERENCES siton_inventory.inventory_deals(deal_id) ON DELETE CASCADE,
  idempotency_key varchar(200) NOT NULL,
  request_hash varchar(128) NOT NULL,
  qty integer NOT NULL CHECK (qty > 0),
  status text NOT NULL CHECK (status IN ('held','committed','released','expired')),
  hold_generation integer NOT NULL DEFAULT 1 CHECK (hold_generation > 0),
  expires_at timestamptz NOT NULL,
  canonical_response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  released_at timestamptz,
  expired_at timestamptz,
  UNIQUE (deal_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS inventory_reservations_expiry_idx
  ON siton_inventory.inventory_reservations(deal_id, expires_at)
  WHERE status='held';

CREATE INDEX IF NOT EXISTS inventory_reservations_status_idx
  ON siton_inventory.inventory_reservations(deal_id, status);
