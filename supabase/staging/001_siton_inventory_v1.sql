-- Canonical SITON inventory foundation, extracted read-only from the Stage31
-- Base44 provisioners. This file contains schema, RPC, RLS, grants and
-- search_path hardening and is intended for fresh staging reconstruction.
-- Source project nqgbqbqextiryqqpggju was not mutated by this extraction.
BEGIN;

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
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'participant_state_audit is append-only';
END;
$function$;

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
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'deal_state_audit is append-only';
END;
$function$;

DROP TRIGGER IF EXISTS deal_state_audit_append_only ON siton_inventory.deal_state_audit;
CREATE TRIGGER deal_state_audit_append_only
BEFORE UPDATE OR DELETE ON siton_inventory.deal_state_audit
FOR EACH ROW EXECUTE FUNCTION siton_inventory.reject_deal_state_audit_mutation();

REVOKE ALL ON SCHEMA siton_inventory FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA siton_inventory FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA siton_inventory FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA siton_inventory FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA siton_inventory REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA siton_inventory REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA siton_inventory REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMIT;

BEGIN;

ALTER TABLE siton_inventory.inventory_deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE siton_inventory.inventory_action_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE siton_inventory.inventory_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE siton_inventory.participant_state_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE siton_inventory.deal_state_audit ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION siton_inventory.error_result(
  p_status integer,
  p_code text,
  p_message text,
  p_details jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'ok', false,
    'http_status', p_status,
    'code', p_code,
    'error', p_message,
    'details', p_details
  ));
$function$;

CREATE OR REPLACE FUNCTION siton_inventory.reclaim_expired(p_deal_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, siton_inventory
AS $function$
DECLARE
  v_released integer := 0;
BEGIN
  WITH expired AS (
    UPDATE siton_inventory.inventory_reservations
       SET status = 'expired', expired_at = now()
     WHERE deal_id = p_deal_id
       AND status = 'held'
       AND expires_at <= now()
     RETURNING qty
  )
  SELECT COALESCE(sum(qty), 0)::integer INTO v_released FROM expired;

  IF v_released > 0 THEN
    UPDATE siton_inventory.inventory_deals
       SET reserved_units = GREATEST(committed_units, reserved_units - v_released),
           updated_at = now()
     WHERE deal_id = p_deal_id;
  END IF;
  RETURN v_released;
END;
$function$;

CREATE OR REPLACE FUNCTION siton_inventory.reservation_snapshot(p_reservation_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, siton_inventory
AS $function$
  SELECT jsonb_build_object(
    'ok', true,
    'reservation_id', r.reservation_id::text,
    'deal_id', r.deal_id::text,
    'idempotency_key', r.idempotency_key,
    'request_hash', r.request_hash,
    'qty', r.qty,
    'status', r.status,
    'hold_generation', r.hold_generation,
    'expires_at', r.expires_at,
    'created_at', r.created_at,
    'committed_at', r.committed_at,
    'released_at', r.released_at,
    'expired_at', r.expired_at,
    'buyer_state', r.buyer_state,
    'money_state', r.money_state,
    'authorization_evidence_hash', r.authorization_evidence_hash,
    'join_authorize_audit_count', (
      SELECT count(*)::integer
        FROM siton_inventory.participant_state_audit a
       WHERE a.participant_id = r.reservation_id
         AND a.action_name = 'participant.join_authorize'
    ),
    'max_units', d.max_units,
    'min_units', d.min_units,
    'deal_state', d.deal_state,
    'reserved_units', d.reserved_units,
    'committed_units', d.committed_units,
    'inventory_status', d.status
  )
  FROM siton_inventory.inventory_reservations r
  JOIN siton_inventory.inventory_deals d ON d.deal_id = r.deal_id
  WHERE r.reservation_id = p_reservation_id;
$function$;

CREATE OR REPLACE FUNCTION public.siton_inventory_rpc(p_operation text, p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, siton_inventory
AS $function$
DECLARE
  v_operation text := btrim(COALESCE(p_operation, ''));
  v_text text;
  v_deal_id uuid;
  v_reservation_id uuid;
  v_max integer;
  v_min integer;
  v_qty integer;
  v_key text;
  v_request_hash text;
  v_evidence_hash text;
  v_action_hash text;
  v_expires timestamptz;
  v_result jsonb;
  v_error jsonb;
  v_deal record;
  v_res record;
  v_action record;
  v_active record;
  v_buyer_audit_id uuid;
  v_money_audit_id uuid;
  v_target_audit_id uuid;
  v_audit_count integer;
  v_audit_ids jsonb;
  v_target_transitioned boolean := false;
BEGIN
  IF v_operation = 'probe' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'service', 'siton_inventory_rpc',
      'schema_version', 'v1',
      'joins_enabled', false,
      'payments_enabled', false
    );
  END IF;

  IF v_operation NOT IN ('sync','close','hold','commit','release','lookup','reservation_status','status') THEN
    RETURN siton_inventory.error_result(400, 'unsupported_inventory_operation', 'unsupported inventory operation');
  END IF;

  IF v_operation IN ('sync','close','hold','lookup','status') THEN
    v_text := btrim(COALESCE(p_payload->>'deal_id', ''));
    IF v_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RETURN siton_inventory.error_result(400, 'invalid_deal_id', 'deal_id must be a valid UUID');
    END IF;
    v_deal_id := v_text::uuid;
  END IF;

  IF v_operation IN ('commit','release','reservation_status') THEN
    v_text := btrim(COALESCE(p_payload->>'reservation_id', ''));
    IF v_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RETURN siton_inventory.error_result(400, 'invalid_reservation_id', 'reservation_id must be a valid UUID');
    END IF;
    v_reservation_id := v_text::uuid;
  END IF;

  IF v_operation IN ('sync','close') THEN
    v_text := COALESCE(p_payload->>'max_units', '');
    IF v_text !~ '^[1-9][0-9]{0,8}$' THEN
      RETURN siton_inventory.error_result(400, 'invalid_max_units', 'max_units must be a positive integer');
    END IF;
    v_max := v_text::integer;

    v_key := btrim(COALESCE(p_payload->>'idempotency_key', ''));
    IF v_key = '' OR length(v_key) > 200 THEN
      RETURN siton_inventory.error_result(400, 'invalid_idempotency_key', 'idempotency_key is required and must be at most 200 characters');
    END IF;

    v_action_hash := lower(btrim(COALESCE(p_payload->>'_action_request_hash', '')));
    IF v_action_hash !~ '^[0-9a-f]{64}$' THEN
      RETURN siton_inventory.error_result(400, 'invalid_action_request_hash', 'action request hash is invalid');
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('siton_inventory:deal:' || v_deal_id::text, 0));

    SELECT request_hash, status, response_status, canonical_response
      INTO v_action
      FROM siton_inventory.inventory_action_idempotency
     WHERE operation = v_operation
       AND deal_id = v_deal_id
       AND idempotency_key = v_key
     FOR UPDATE;

    IF FOUND THEN
      IF v_action.request_hash <> v_action_hash THEN
        RETURN siton_inventory.error_result(409, 'idempotency_payload_mismatch', 'idempotency key was already used with a different payload');
      END IF;
      IF v_action.status = 'completed' THEN
        RETURN v_action.canonical_response;
      END IF;
    ELSE
      INSERT INTO siton_inventory.inventory_action_idempotency(
        operation, deal_id, idempotency_key, request_hash, status, lease_until
      ) VALUES (
        v_operation, v_deal_id, v_key, v_action_hash, 'processing', now() + interval '30 seconds'
      );
    END IF;
  END IF;

  IF v_operation = 'sync' THEN
    v_text := COALESCE(p_payload->>'min_units', '');
    IF v_text !~ '^[1-9][0-9]{0,8}$' THEN
      v_error := siton_inventory.error_result(400, 'invalid_min_units', 'min_units must be a positive integer');
      UPDATE siton_inventory.inventory_action_idempotency
         SET status='completed', response_status=400, canonical_response=v_error, lease_until=now(), updated_at=now()
       WHERE operation='sync' AND deal_id=v_deal_id AND idempotency_key=v_key;
      RETURN v_error;
    END IF;
    v_min := v_text::integer;
    IF v_min > v_max THEN
      v_error := siton_inventory.error_result(400, 'invalid_min_units', 'min_units cannot exceed max_units');
      UPDATE siton_inventory.inventory_action_idempotency
         SET status='completed', response_status=400, canonical_response=v_error, lease_until=now(), updated_at=now()
       WHERE operation='sync' AND deal_id=v_deal_id AND idempotency_key=v_key;
      RETURN v_error;
    END IF;

    SELECT * INTO v_deal
      FROM siton_inventory.inventory_deals
     WHERE deal_id=v_deal_id
     FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO siton_inventory.inventory_deals(
        deal_id,max_units,min_units,reserved_units,committed_units,status,deal_state
      ) VALUES (
        v_deal_id,v_max,v_min,0,0,'open','PendingTarget'
      )
      RETURNING * INTO v_deal;
      v_result := jsonb_build_object(
        'ok',true,'deal_id',v_deal.deal_id::text,'max_units',v_deal.max_units,
        'min_units',v_deal.min_units,'reserved_units',v_deal.reserved_units,
        'committed_units',v_deal.committed_units,'status',v_deal.status,
        'deal_state',v_deal.deal_state,'created',true,'replay',false
      );
    ELSE
      IF v_deal.max_units <> v_max OR v_deal.min_units <> v_min THEN
        v_error := siton_inventory.error_result(
          409,'inventory_thresholds_immutable','max_units and min_units cannot change after inventory sync',
          jsonb_build_object(
            'existing_max_units',v_deal.max_units,'requested_max_units',v_max,
            'existing_min_units',v_deal.min_units,'requested_min_units',v_min
          )
        );
        UPDATE siton_inventory.inventory_action_idempotency
           SET status='completed', response_status=409, canonical_response=v_error, lease_until=now(), updated_at=now()
         WHERE operation='sync' AND deal_id=v_deal_id AND idempotency_key=v_key;
        RETURN v_error;
      END IF;
      PERFORM siton_inventory.reclaim_expired(v_deal_id);
      UPDATE siton_inventory.inventory_deals
         SET status='open', updated_at=now()
       WHERE deal_id=v_deal_id
       RETURNING * INTO v_deal;
      v_result := jsonb_build_object(
        'ok',true,'deal_id',v_deal.deal_id::text,'max_units',v_deal.max_units,
        'min_units',v_deal.min_units,'reserved_units',v_deal.reserved_units,
        'committed_units',v_deal.committed_units,'status',v_deal.status,
        'deal_state',v_deal.deal_state,'created',false,'replay',false
      );
    END IF;

    UPDATE siton_inventory.inventory_action_idempotency
       SET status='completed', response_status=200, canonical_response=v_result, lease_until=now(), updated_at=now()
     WHERE operation='sync' AND deal_id=v_deal_id AND idempotency_key=v_key;
    RETURN v_result;
  END IF;

  IF v_operation = 'close' THEN
    SELECT * INTO v_deal
      FROM siton_inventory.inventory_deals
     WHERE deal_id=v_deal_id
     FOR UPDATE;

    IF NOT FOUND THEN
      v_error := siton_inventory.error_result(404,'inventory_deal_not_found','inventory deal not found');
    ELSIF v_deal.max_units <> v_max THEN
      v_error := siton_inventory.error_result(
        409,'inventory_max_units_mismatch','max_units does not match synced inventory',
        jsonb_build_object('existing_max_units',v_deal.max_units,'requested_max_units',v_max)
      );
    ELSE
      SELECT count(*)::integer AS count, COALESCE(sum(qty),0)::integer AS qty
        INTO v_active
        FROM siton_inventory.inventory_reservations
       WHERE deal_id=v_deal_id
         AND status='held'
         AND expires_at > now();
      IF v_active.count > 0 THEN
        v_error := siton_inventory.error_result(
          409,'inventory_holds_in_flight','inventory cannot close while active Holds are in flight',
          jsonb_build_object('active_holds',v_active.count,'active_hold_units',v_active.qty)
        );
      END IF;
    END IF;

    IF v_error IS NOT NULL THEN
      UPDATE siton_inventory.inventory_action_idempotency
         SET status='completed', response_status=(v_error->>'http_status')::integer,
             canonical_response=v_error, lease_until=now(), updated_at=now()
       WHERE operation='close' AND deal_id=v_deal_id AND idempotency_key=v_key;
      RETURN v_error;
    END IF;

    PERFORM siton_inventory.reclaim_expired(v_deal_id);
    UPDATE siton_inventory.inventory_deals
       SET status='closed', updated_at=now()
     WHERE deal_id=v_deal_id
     RETURNING * INTO v_deal;

    v_result := jsonb_build_object(
      'ok',true,'deal_id',v_deal.deal_id::text,'max_units',v_deal.max_units,
      'reserved_units',v_deal.reserved_units,'committed_units',v_deal.committed_units,
      'status',v_deal.status,'replay',false
    );
    UPDATE siton_inventory.inventory_action_idempotency
       SET status='completed',response_status=200,canonical_response=v_result,lease_until=now(),updated_at=now()
     WHERE operation='close' AND deal_id=v_deal_id AND idempotency_key=v_key;
    RETURN v_result;
  END IF;

  IF v_operation = 'hold' THEN
    v_text := COALESCE(p_payload->>'qty','');
    IF v_text !~ '^[1-9][0-9]{0,8}$' THEN
      RETURN siton_inventory.error_result(400,'invalid_qty','qty must be a positive integer');
    END IF;
    v_qty := v_text::integer;
    v_key := btrim(COALESCE(p_payload->>'idempotency_key',''));
    IF v_key='' OR length(v_key)>200 THEN
      RETURN siton_inventory.error_result(400,'invalid_idempotency_key','idempotency_key is required and must be at most 200 characters');
    END IF;
    v_request_hash := btrim(COALESCE(p_payload->>'request_hash',''));
    IF v_request_hash='' OR length(v_request_hash)>128 THEN
      RETURN siton_inventory.error_result(400,'invalid_request_hash','request_hash is required and must be at most 128 characters');
    END IF;

    SELECT * INTO v_deal FROM siton_inventory.inventory_deals WHERE deal_id=v_deal_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN siton_inventory.error_result(404,'inventory_deal_not_found','inventory deal not found');
    END IF;
    IF v_deal.status <> 'open' THEN
      RETURN siton_inventory.error_result(409,'inventory_deal_closed','deal inventory is closed');
    END IF;

    PERFORM siton_inventory.reclaim_expired(v_deal_id);
    SELECT * INTO v_deal FROM siton_inventory.inventory_deals WHERE deal_id=v_deal_id FOR UPDATE;
    SELECT * INTO v_res
      FROM siton_inventory.inventory_reservations
     WHERE deal_id=v_deal_id AND idempotency_key=v_key
     FOR UPDATE;

    IF FOUND THEN
      IF v_res.request_hash <> v_request_hash OR v_res.qty <> v_qty THEN
        RETURN siton_inventory.error_result(409,'idempotency_payload_mismatch','idempotency key was already used with a different payload');
      END IF;
      IF v_res.status IN ('held','committed') THEN
        RETURN jsonb_build_object(
          'ok',true,'reservation_id',v_res.reservation_id::text,'deal_id',v_deal_id::text,
          'qty',v_res.qty,'status',v_res.status,'expires_at',v_res.expires_at,
          'reserved_units',v_deal.reserved_units,'committed_units',v_deal.committed_units,
          'max_units',v_deal.max_units,'min_units',v_deal.min_units,
          'deal_state',v_deal.deal_state,'available_units',v_deal.max_units-v_deal.reserved_units,
          'replay',true
        );
      END IF;
      IF v_qty > v_deal.max_units-v_deal.reserved_units THEN
        RETURN siton_inventory.error_result(
          409,'inventory_exhausted','requested quantity exceeds available inventory',
          jsonb_build_object('requested_qty',v_qty,'available_units',GREATEST(0,v_deal.max_units-v_deal.reserved_units))
        );
      END IF;

      v_expires := now()+interval '120 seconds';
      UPDATE siton_inventory.inventory_reservations
         SET status='held',hold_generation=hold_generation+1,expires_at=v_expires,
             released_at=NULL,expired_at=NULL,committed_at=NULL
       WHERE reservation_id=v_res.reservation_id;
      UPDATE siton_inventory.inventory_deals
         SET reserved_units=reserved_units+v_qty,updated_at=now()
       WHERE deal_id=v_deal_id AND reserved_units+v_qty<=max_units
       RETURNING * INTO v_deal;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'inventory_exhausted' USING ERRCODE='P0001';
      END IF;
      v_result := jsonb_build_object(
        'ok',true,'reservation_id',v_res.reservation_id::text,'deal_id',v_deal_id::text,
        'qty',v_qty,'status','held','expires_at',v_expires,'reserved_units',v_deal.reserved_units,
        'committed_units',v_deal.committed_units,'max_units',v_deal.max_units,
        'min_units',v_deal.min_units,'deal_state',v_deal.deal_state,
        'available_units',v_deal.max_units-v_deal.reserved_units,
        'replay',true,'renewed',true
      );
      UPDATE siton_inventory.inventory_reservations
         SET canonical_response=v_result
       WHERE reservation_id=v_res.reservation_id;
      RETURN v_result;
    END IF;

    IF v_qty > v_deal.max_units-v_deal.reserved_units THEN
      RETURN siton_inventory.error_result(
        409,'inventory_exhausted','requested quantity exceeds available inventory',
        jsonb_build_object('requested_qty',v_qty,'available_units',GREATEST(0,v_deal.max_units-v_deal.reserved_units))
      );
    END IF;

    v_reservation_id := gen_random_uuid();
    v_expires := now()+interval '120 seconds';
    UPDATE siton_inventory.inventory_deals
       SET reserved_units=reserved_units+v_qty,updated_at=now()
     WHERE deal_id=v_deal_id AND reserved_units+v_qty<=max_units
     RETURNING * INTO v_deal;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'inventory_exhausted' USING ERRCODE='P0001';
    END IF;
    v_result := jsonb_build_object(
      'ok',true,'reservation_id',v_reservation_id::text,'deal_id',v_deal_id::text,
      'qty',v_qty,'status','held','expires_at',v_expires,'reserved_units',v_deal.reserved_units,
      'committed_units',v_deal.committed_units,'max_units',v_deal.max_units,
      'min_units',v_deal.min_units,'deal_state',v_deal.deal_state,
      'available_units',v_deal.max_units-v_deal.reserved_units,'replay',false
    );
    INSERT INTO siton_inventory.inventory_reservations(
      reservation_id,deal_id,idempotency_key,request_hash,qty,status,hold_generation,expires_at,canonical_response
    ) VALUES (
      v_reservation_id,v_deal_id,v_key,v_request_hash,v_qty,'held',1,v_expires,v_result
    );
    RETURN v_result;
  END IF;

  IF v_operation = 'commit' THEN
    v_evidence_hash := lower(btrim(COALESCE(p_payload->>'authorization_evidence_hash','')));
    IF v_evidence_hash !~ '^[0-9a-f]{64}$' THEN
      RETURN siton_inventory.error_result(400,'invalid_authorization_evidence_hash','authorization_evidence_hash must be a SHA-256 hex digest');
    END IF;

    SELECT deal_id INTO v_deal_id
      FROM siton_inventory.inventory_reservations
     WHERE reservation_id=v_reservation_id;
    IF NOT FOUND THEN
      RETURN siton_inventory.error_result(404,'reservation_not_found','reservation not found');
    END IF;
    SELECT * INTO v_deal FROM siton_inventory.inventory_deals WHERE deal_id=v_deal_id FOR UPDATE;
    SELECT * INTO v_res FROM siton_inventory.inventory_reservations WHERE reservation_id=v_reservation_id FOR UPDATE;

    IF v_res.status='held' AND v_res.expires_at<=now() THEN
      RETURN siton_inventory.error_result(409,'reservation_expired','reservation is already expired');
    END IF;
    PERFORM siton_inventory.reclaim_expired(v_deal_id);
    SELECT * INTO v_deal FROM siton_inventory.inventory_deals WHERE deal_id=v_deal_id FOR UPDATE;
    SELECT * INTO v_res FROM siton_inventory.inventory_reservations WHERE reservation_id=v_reservation_id FOR UPDATE;

    IF v_res.status='committed' THEN
      IF COALESCE(v_res.authorization_evidence_hash,'')<>v_evidence_hash THEN
        RETURN siton_inventory.error_result(409,'authorization_evidence_mismatch','committed reservation used different authorization evidence');
      END IF;
      SELECT count(*)::integer, COALESCE(jsonb_agg(audit_id::text ORDER BY state_type),'[]'::jsonb)
        INTO v_audit_count,v_audit_ids
        FROM siton_inventory.participant_state_audit
       WHERE participant_id=v_reservation_id
         AND action_name='participant.join_authorize';
      IF v_res.buyer_state<>'JoinedAuthorized' OR v_res.money_state<>'AuthHeld' OR v_audit_count<>2 THEN
        RETURN siton_inventory.error_result(500,'join_authorize_audit_incomplete','committed Join authorization evidence is incomplete');
      END IF;
      SELECT audit_id INTO v_target_audit_id
        FROM siton_inventory.deal_state_audit
       WHERE deal_id=v_deal_id AND action_name='deal.target_reached'
       ORDER BY created_at LIMIT 1;
      RETURN jsonb_build_object(
        'ok',true,'reservation_id',v_reservation_id::text,'status','committed','replay',true,
        'reserved_units',v_deal.reserved_units,'committed_units',v_deal.committed_units,
        'max_units',v_deal.max_units,'min_units',v_deal.min_units,'deal_state',v_deal.deal_state,
        'buyer_state',v_res.buyer_state,'money_state',v_res.money_state,
        'authorization_evidence_hash',v_evidence_hash,
        'join_authorize_audit_count',v_audit_count,'join_authorize_audit_ids',v_audit_ids,
        'target_transitioned',false,'target_audit_id',v_target_audit_id
      );
    END IF;

    IF v_res.status<>'held' THEN
      RETURN siton_inventory.error_result(409,'reservation_'||v_res.status,'reservation is already '||v_res.status);
    END IF;
    IF v_res.buyer_state<>'NotJoined' OR v_res.money_state<>'NoFinancial' OR v_res.authorization_evidence_hash IS NOT NULL THEN
      RETURN siton_inventory.error_result(409,'join_authorize_source_state_invalid','reservation is not in the canonical Join source state');
    END IF;

    v_buyer_audit_id:=gen_random_uuid();
    v_money_audit_id:=gen_random_uuid();
    UPDATE siton_inventory.inventory_reservations
       SET status='committed',committed_at=now(),buyer_state='JoinedAuthorized',
           money_state='AuthHeld',authorization_evidence_hash=v_evidence_hash
     WHERE reservation_id=v_reservation_id AND status='held'
     RETURNING * INTO v_res;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reservation_state_conflict' USING ERRCODE='P0001';
    END IF;
    INSERT INTO siton_inventory.participant_state_audit(
      audit_id,participant_id,deal_id,state_type,action_name,from_state,to_state,idempotency_key,authorization_evidence_hash
    ) VALUES
      (v_buyer_audit_id,v_reservation_id,v_deal_id,'buyer_state','participant.join_authorize','NotJoined','JoinedAuthorized',v_res.idempotency_key,v_evidence_hash),
      (v_money_audit_id,v_reservation_id,v_deal_id,'money_state','participant.join_authorize','NoFinancial','AuthHeld',v_res.idempotency_key,v_evidence_hash);

    UPDATE siton_inventory.inventory_deals
       SET committed_units=committed_units+v_res.qty,updated_at=now()
     WHERE deal_id=v_deal_id AND committed_units+v_res.qty<=reserved_units
     RETURNING * INTO v_deal;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'inventory_commit_invariant_failed' USING ERRCODE='P0001';
    END IF;

    IF v_deal.deal_state='PendingTarget' AND v_deal.committed_units>=v_deal.min_units THEN
      v_target_audit_id:=gen_random_uuid();
      UPDATE siton_inventory.inventory_deals
         SET deal_state='TargetReached',updated_at=now()
       WHERE deal_id=v_deal_id AND deal_state='PendingTarget' AND committed_units>=min_units
       RETURNING * INTO v_deal;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'target_transition_conflict' USING ERRCODE='P0001';
      END IF;
      INSERT INTO siton_inventory.deal_state_audit(
        audit_id,deal_id,source_reservation_id,action_name,from_state,to_state,idempotency_key,committed_units,min_units
      ) VALUES (
        v_target_audit_id,v_deal_id,v_reservation_id,'deal.target_reached','PendingTarget','TargetReached',
        'target-reached:'||v_deal_id::text,v_deal.committed_units,v_deal.min_units
      );
      v_target_transitioned:=true;
    END IF;

    RETURN jsonb_build_object(
      'ok',true,'reservation_id',v_reservation_id::text,'status','committed','replay',false,
      'max_units',v_deal.max_units,'min_units',v_deal.min_units,'reserved_units',v_deal.reserved_units,
      'committed_units',v_deal.committed_units,'deal_state',v_deal.deal_state,
      'buyer_state','JoinedAuthorized','money_state','AuthHeld',
      'authorization_evidence_hash',v_evidence_hash,'join_authorize_audit_count',2,
      'join_authorize_audit_ids',jsonb_build_array(v_buyer_audit_id::text,v_money_audit_id::text),
      'target_transitioned',v_target_transitioned,'target_audit_id',v_target_audit_id
    );
  END IF;

  IF v_operation='release' THEN
    SELECT deal_id INTO v_deal_id
      FROM siton_inventory.inventory_reservations
     WHERE reservation_id=v_reservation_id;
    IF NOT FOUND THEN
      RETURN siton_inventory.error_result(404,'reservation_not_found','reservation not found');
    END IF;
    SELECT * INTO v_deal FROM siton_inventory.inventory_deals WHERE deal_id=v_deal_id FOR UPDATE;
    SELECT * INTO v_res FROM siton_inventory.inventory_reservations WHERE reservation_id=v_reservation_id FOR UPDATE;
    IF v_res.status='committed' THEN
      RETURN siton_inventory.error_result(409,'reservation_already_committed','committed reservation cannot be released by the pre-commit compensation path');
    END IF;
    PERFORM siton_inventory.reclaim_expired(v_deal_id);
    SELECT * INTO v_res FROM siton_inventory.inventory_reservations WHERE reservation_id=v_reservation_id FOR UPDATE;
    IF v_res.status='released' THEN
      RETURN jsonb_build_object('ok',true,'reservation_id',v_reservation_id::text,'status','released','replay',true);
    END IF;
    IF v_res.status='expired' THEN
      RETURN jsonb_build_object('ok',true,'reservation_id',v_reservation_id::text,'status','expired','replay',true);
    END IF;

    UPDATE siton_inventory.inventory_reservations
       SET status='released',released_at=now()
     WHERE reservation_id=v_reservation_id AND status='held'
     RETURNING * INTO v_res;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reservation_state_conflict' USING ERRCODE='P0001';
    END IF;
    UPDATE siton_inventory.inventory_deals
       SET reserved_units=GREATEST(committed_units,reserved_units-v_res.qty),updated_at=now()
     WHERE deal_id=v_deal_id
     RETURNING * INTO v_deal;
    RETURN jsonb_build_object(
      'ok',true,'reservation_id',v_reservation_id::text,'status','released','replay',false,
      'max_units',v_deal.max_units,'reserved_units',v_deal.reserved_units,'committed_units',v_deal.committed_units
    );
  END IF;

  IF v_operation='lookup' THEN
    v_key:=btrim(COALESCE(p_payload->>'idempotency_key',''));
    IF v_key='' OR length(v_key)>200 THEN
      RETURN siton_inventory.error_result(400,'invalid_idempotency_key','idempotency_key is required and must be at most 200 characters');
    END IF;
    SELECT reservation_id INTO v_reservation_id
      FROM siton_inventory.inventory_reservations
     WHERE deal_id=v_deal_id AND idempotency_key=v_key
     LIMIT 1;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok',true,'found',false,'deal_id',v_deal_id::text,'idempotency_key',v_key);
    END IF;
    RETURN siton_inventory.reservation_snapshot(v_reservation_id)||jsonb_build_object('found',true);
  END IF;

  IF v_operation='reservation_status' THEN
    v_result:=siton_inventory.reservation_snapshot(v_reservation_id);
    IF v_result IS NULL THEN
      RETURN siton_inventory.error_result(404,'reservation_not_found','reservation not found');
    END IF;
    RETURN v_result;
  END IF;

  IF v_operation='status' THEN
    SELECT * INTO v_deal FROM siton_inventory.inventory_deals WHERE deal_id=v_deal_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN siton_inventory.error_result(404,'inventory_deal_not_found','inventory deal not found');
    END IF;
    PERFORM siton_inventory.reclaim_expired(v_deal_id);
    SELECT * INTO v_deal FROM siton_inventory.inventory_deals WHERE deal_id=v_deal_id FOR UPDATE;
    RETURN jsonb_build_object(
      'ok',true,'deal_id',v_deal_id::text,'status',v_deal.status,'deal_state',v_deal.deal_state,
      'max_units',v_deal.max_units,'min_units',v_deal.min_units,'reserved_units',v_deal.reserved_units,
      'committed_units',v_deal.committed_units,'available_units',v_deal.max_units-v_deal.reserved_units
    );
  END IF;

  RETURN siton_inventory.error_result(500,'inventory_internal_error','inventory operation did not return a result');
END;
$function$;

REVOKE ALL ON FUNCTION public.siton_inventory_rpc(text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.siton_inventory_rpc(text,jsonb) TO service_role;

REVOKE ALL ON FUNCTION siton_inventory.error_result(integer,text,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION siton_inventory.reclaim_expired(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION siton_inventory.reservation_snapshot(uuid) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;

BEGIN;
ALTER FUNCTION siton_inventory.reject_participant_state_audit_mutation() SET search_path = '';
ALTER FUNCTION siton_inventory.reject_deal_state_audit_mutation() SET search_path = '';
COMMIT;
