-- Migration 030: basic trust/legal acceptance records.
-- Stores policy-version acknowledgement without raw IP or legal CMS semantics.

CREATE TABLE IF NOT EXISTS siton.legal_acceptances (
  acceptance_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('buyer','seller')),
  actor_ref TEXT NOT NULL,
  deal_id UUID NULL,
  participant_id UUID NULL,
  acceptance_type TEXT NOT NULL CHECK (acceptance_type IN (
    'buyer_join_terms',
    'buyer_payment_disclosure',
    'seller_publish_terms'
  )),
  policy_version TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_hash TEXT NULL,
  user_agent_hash TEXT NULL,
  metadata_jsonb JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT ux_legal_acceptances_scope UNIQUE (
    actor_type,
    actor_ref,
    deal_id,
    participant_id,
    acceptance_type,
    policy_version
  )
);

CREATE INDEX IF NOT EXISTS idx_legal_acceptances_deal
  ON siton.legal_acceptances (deal_id, accepted_at);

CREATE INDEX IF NOT EXISTS idx_legal_acceptances_actor
  ON siton.legal_acceptances (actor_type, actor_ref, accepted_at);
