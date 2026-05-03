-- Migration 032: public per-deal chat, phase 1.
-- Chat is scoped to a single deal and never owns deal, money, inventory,
-- attribution, payout, or notification state.

CREATE TABLE IF NOT EXISTS siton.deal_chat_messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  participant_id UUID NULL REFERENCES siton.participants(participant_id) ON DELETE SET NULL,
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','hidden')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deal_chat_messages_deal_created
  ON siton.deal_chat_messages (deal_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deal_chat_messages_deal_status_created
  ON siton.deal_chat_messages (deal_id, status, created_at DESC);
