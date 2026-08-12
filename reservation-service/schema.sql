CREATE SCHEMA IF NOT EXISTS siton_inventory;

CREATE TABLE IF NOT EXISTS siton_inventory.inventory_deals (
  deal_id uuid PRIMARY KEY,
  max_units integer NOT NULL CHECK (max_units > 0),
  min_units integer NOT NULL CHECK (min_units > 0 AND min_units <= max_units),
  reserved_units integer NOT NULL DEFAULT 0 CHECK (reserved_units >= 0 AND reserved_units <= max_units),
  committed_units integer NOT NULL DEFAULT 0 CHECK (committed_units >= 0 AND committed_units <= reserved_units),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  deal_state text NOT NULL DEFAULT 'PendingTarget' CHECK (deal_state IN ('PendingTarget','TargetReached')),
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
  buyer_state text NOT NULL DEFAULT 'NotJoined' CHECK (buyer_state IN ('NotJoined','JoinedAuthorized')),
  money_state text NOT NULL DEFAULT 'NoFinancial' CHECK (money_state IN ('NoFinancial','AuthHeld')),
  authorization_evidence_hash varchar(64),
  hold_generation integer NOT NULL DEFAULT 1 CHECK (hold_generation > 0),
  expires_at timestamptz NOT NULL,
  canonical_response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  released_at timestamptz,
  expired_at timestamptz,
  UNIQUE (deal_id, idempotency_key),
  CHECK (
    (status='committed' AND buyer_state='JoinedAuthorized' AND money_state='AuthHeld' AND authorization_evidence_hash ~ '^[0-9a-f]{64}$')
    OR
    (status<>'committed' AND buyer_state='NotJoined' AND money_state='NoFinancial' AND authorization_evidence_hash IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS inventory_reservations_expiry_idx
  ON siton_inventory.inventory_reservations(deal_id, expires_at)
  WHERE status='held';

CREATE INDEX IF NOT EXISTS inventory_reservations_status_idx
  ON siton_inventory.inventory_reservations(deal_id, status);

CREATE TABLE IF NOT EXISTS siton_inventory.participant_state_audit (
  audit_id uuid PRIMARY KEY,
  participant_id uuid NOT NULL REFERENCES siton_inventory.inventory_reservations(reservation_id),
  deal_id uuid NOT NULL REFERENCES siton_inventory.inventory_deals(deal_id),
  state_type text NOT NULL CHECK (state_type IN ('buyer_state','money_state')),
  action_name text NOT NULL CHECK (action_name IN ('participant.join_authorize')),
  from_state text NOT NULL,
  to_state text NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  authorization_evidence_hash varchar(64) NOT NULL CHECK (authorization_evidence_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (participant_id, state_type, action_name, idempotency_key),
  CHECK (
    (state_type='buyer_state' AND from_state='NotJoined' AND to_state='JoinedAuthorized')
    OR
    (state_type='money_state' AND from_state='NoFinancial' AND to_state='AuthHeld')
  )
);

CREATE OR REPLACE FUNCTION siton_inventory.reject_participant_state_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'participant_state_audit is append-only';
END;
$$;

DROP TRIGGER IF EXISTS participant_state_audit_append_only ON siton_inventory.participant_state_audit;
CREATE TRIGGER participant_state_audit_append_only
BEFORE UPDATE OR DELETE ON siton_inventory.participant_state_audit
FOR EACH ROW EXECUTE FUNCTION siton_inventory.reject_participant_state_audit_mutation();

CREATE TABLE IF NOT EXISTS siton_inventory.deal_state_audit (
  audit_id uuid PRIMARY KEY,
  deal_id uuid NOT NULL REFERENCES siton_inventory.inventory_deals(deal_id),
  source_reservation_id uuid NOT NULL REFERENCES siton_inventory.inventory_reservations(reservation_id),
  action_name text NOT NULL CHECK (action_name IN ('deal.target_reached')),
  from_state text NOT NULL CHECK (from_state IN ('PendingTarget')),
  to_state text NOT NULL CHECK (to_state IN ('TargetReached')),
  idempotency_key varchar(200) NOT NULL,
  committed_units integer NOT NULL CHECK (committed_units > 0),
  min_units integer NOT NULL CHECK (min_units > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, action_name, idempotency_key)
);

CREATE OR REPLACE FUNCTION siton_inventory.reject_deal_state_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'deal_state_audit is append-only';
END;
$$;

DROP TRIGGER IF EXISTS deal_state_audit_append_only ON siton_inventory.deal_state_audit;
CREATE TRIGGER deal_state_audit_append_only
BEFORE UPDATE OR DELETE ON siton_inventory.deal_state_audit
FOR EACH ROW EXECUTE FUNCTION siton_inventory.reject_deal_state_audit_mutation();
