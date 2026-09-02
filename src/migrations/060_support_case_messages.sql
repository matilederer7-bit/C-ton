-- 060 — P0.5 support case conversation.
--
-- A support case becomes a THREAD: the original customer message stays on
-- operational_cases.description; every further message (admin reply to the
-- customer, internal note, and — future — customer replies) is a row here.
--
-- Truthful delivery: a saved reply is NOT a delivered email. delivery_status
-- starts at 'Saved'; only the approved outbound-email rail (disabled by
-- default — notification safety) may ever move it to Queued/Sent/Failed/
-- Blocked. Nothing in this migration sends anything.

BEGIN;

SET search_path TO siton, public;

CREATE TABLE IF NOT EXISTS siton.support_case_messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES siton.operational_cases(case_id) ON DELETE RESTRICT,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('Customer','Admin','InternalNote')),
  sender_ref TEXT NOT NULL DEFAULT 'admin',
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  delivery_status TEXT NOT NULL DEFAULT 'Saved' CHECK (
    delivery_status IN ('Saved','Queued','Sent','Failed','Blocked')
  ),
  provider_message_id TEXT NULL,
  request_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_case_messages_case
  ON siton.support_case_messages (case_id, created_at ASC);

-- case event vocabulary learns the reply action (audit convention 034)
ALTER TABLE siton.operational_case_events
  DROP CONSTRAINT IF EXISTS operational_case_events_event_type_check;
ALTER TABLE siton.operational_case_events
  ADD CONSTRAINT operational_case_events_event_type_check CHECK (event_type IN (
    'case.create',
    'case.update_status',
    'case.assign',
    'case.close',
    'case.escalate',
    'case.refund_request_marked',
    'case.reply',
    'case.internal_note'
  ));

COMMIT;
