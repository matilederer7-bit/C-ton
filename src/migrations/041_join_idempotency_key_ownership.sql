-- A Join key is scoped to the logical deal+buyer request, rather than the
-- participant UUID allocated by the winning transaction.
CREATE TABLE IF NOT EXISTS siton.join_idempotency_results (
  deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  buyer_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  participant_id UUID NOT NULL REFERENCES siton.participants(participant_id) ON DELETE CASCADE,
  response_jsonb JSONB NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (deal_id, buyer_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_join_idempotency_result_participant
  ON siton.join_idempotency_results (participant_id);