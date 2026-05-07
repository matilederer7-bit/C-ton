BEGIN;

SET search_path TO siton, public;

ALTER TABLE IF EXISTS siton.deals
  ADD COLUMN IF NOT EXISTS completion_window_until TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_deals_state_published_at
  ON siton.deals (state, published_at);

CREATE INDEX IF NOT EXISTS idx_deals_state_completion_window_until
  ON siton.deals (state, completion_window_until);

ALTER TABLE IF EXISTS siton.participants
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ NULL;

ALTER TABLE IF EXISTS siton.participants
  ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_participants_deal_locked_buyer
  ON siton.participants (deal_id, locked_at, buyer_state);

CREATE INDEX IF NOT EXISTS idx_participants_deal_buyer_money
  ON siton.participants (deal_id, buyer_state, money_state);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'siton'
      AND table_name = 'participants'
      AND column_name = 'user_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_participants_user ON siton.participants (user_id)';
  END IF;
END
$$;

ALTER TABLE IF EXISTS siton.outbox_events
  ADD COLUMN IF NOT EXISTS max_attempts INT NOT NULL DEFAULT 10;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'siton.payment_attempts'::regclass
      AND conname = 'payment_attempts_result_class_check'
  ) THEN
    ALTER TABLE siton.payment_attempts
      ADD CONSTRAINT payment_attempts_result_class_check
      CHECK (result_class IN ('success','permanent_fail','temporary_fail','unknown')) NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'siton.outbox_events'::regclass
      AND conname = 'outbox_events_status_check'
  ) THEN
    ALTER TABLE siton.outbox_events
      ADD CONSTRAINT outbox_events_status_check
      CHECK (status IN ('pending','sent','failed')) NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'siton.outbox_events'::regclass
      AND conname = 'outbox_events_aggregate_type_check'
  ) THEN
    ALTER TABLE siton.outbox_events
      ADD CONSTRAINT outbox_events_aggregate_type_check
      CHECK (aggregate_type IN ('deal','participant')) NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'siton.outbox_events'::regclass
      AND conname = 'outbox_events_attempt_count_check'
  ) THEN
    ALTER TABLE siton.outbox_events
      ADD CONSTRAINT outbox_events_attempt_count_check
      CHECK (attempt_count <= max_attempts AND max_attempts >= 1 AND max_attempts <= 50) NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'siton.idempotency_log'::regclass
      AND conname = 'idempotency_log_response_code_check'
  ) THEN
    ALTER TABLE siton.idempotency_log
      ADD CONSTRAINT idempotency_log_response_code_check
      CHECK (response_code IN ('OK','ERROR')) NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'siton.audit_log'::regclass
      AND conname = 'audit_log_state_type_check'
  ) THEN
    ALTER TABLE siton.audit_log
      ADD CONSTRAINT audit_log_state_type_check
      CHECK (state_type IN ('deal_state','buyer_state','money_state')) NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'siton.audit_log'::regclass
      AND conname = 'audit_log_states_match_state_type_check'
  ) THEN
    ALTER TABLE siton.audit_log
      ADD CONSTRAINT audit_log_states_match_state_type_check
      CHECK (
        (
          state_type = 'deal_state'
          AND from_state IN ('Draft','PendingTarget','TargetReached','ClosedForJoining','ReadyForCharging','Charging','CompletionWindow','Completed','Failed','Cancelled')
          AND to_state   IN ('Draft','PendingTarget','TargetReached','ClosedForJoining','ReadyForCharging','Charging','CompletionWindow','Completed','Failed','Cancelled')
        )
        OR
        (
          state_type = 'buyer_state'
          AND from_state IN ('NotJoined','JoinedAuthorized','LockedIn','ChargingAttempt','ChargedSuccess','ChargeFailedCompletion','Recovered','Dropped','DealCompleted','DealFailed')
          AND to_state   IN ('NotJoined','JoinedAuthorized','LockedIn','ChargingAttempt','ChargedSuccess','ChargeFailedCompletion','Recovered','Dropped','DealCompleted','DealFailed')
        )
        OR
        (
          state_type = 'money_state'
          AND from_state IN ('NoFinancial','AuthHeld','AuthLocked','ChargeAttempt','ChargedSuccess','ChargeFailedRecovery','RecoveredCharge','AuthReleased','Refunded')
          AND to_state   IN ('NoFinancial','AuthHeld','AuthLocked','ChargeAttempt','ChargedSuccess','ChargeFailedRecovery','RecoveredCharge','AuthReleased','Refunded')
        )
      ) NOT VALID;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS siton.webhook_events (
  provider       TEXT NOT NULL,
  event_id       TEXT NOT NULL,
  payload_jsonb  JSONB NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  deal_id        UUID NULL REFERENCES siton.deals(deal_id) ON DELETE RESTRICT,
  participant_id UUID NULL REFERENCES siton.participants(participant_id) ON DELETE RESTRICT,
  CONSTRAINT webhook_events_pk PRIMARY KEY (provider, event_id),
  CONSTRAINT webhook_events_status_check CHECK (status IN ('pending','processed','ignored','failed'))
);

CREATE INDEX IF NOT EXISTS idx_webhook_status_received
  ON siton.webhook_events (status, received_at);

CREATE INDEX IF NOT EXISTS idx_webhook_provider_received
  ON siton.webhook_events (provider, received_at);

CREATE INDEX IF NOT EXISTS idx_webhook_deal_received
  ON siton.webhook_events (deal_id, received_at);

COMMIT;
