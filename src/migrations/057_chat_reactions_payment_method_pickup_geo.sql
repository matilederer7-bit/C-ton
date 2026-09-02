-- 057 — P0.3 product-surface extensions (all additive, legacy-safe):
--
-- 1) Deal chat becomes a real lightweight chat: replies to a specific message
--    and like/dislike reactions with one current reaction per actor. The
--    actor key is the server-side hash of the PII-free browser visitor id —
--    the same tracked-identity mechanism the viral funnel already uses; no
--    client-chosen authority is trusted beyond that opaque identity.
-- 2) Buyer payment-method PREFERENCE (credit_card | bit) recorded at join.
--    Presentation/orchestration only — real money stays 0 and no provider
--    call is introduced.
-- 3) Pickup delivery options may carry explicit coordinates chosen by the
--    seller (browser geolocation on explicit action), enabling a buyer
--    map-navigation action.

BEGIN;

SET search_path TO siton, public;

-- 1) chat replies + reactions
ALTER TABLE siton.deal_chat_messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id UUID NULL REFERENCES siton.deal_chat_messages(message_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_deal_chat_messages_reply
  ON siton.deal_chat_messages (reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS siton.deal_chat_message_reactions (
  reaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES siton.deal_chat_messages(message_id) ON DELETE CASCADE,
  actor_key TEXT NOT NULL,
  reaction TEXT NOT NULL CHECK (reaction IN ('like','dislike')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_deal_chat_reaction_actor UNIQUE (message_id, actor_key)
);

CREATE INDEX IF NOT EXISTS idx_deal_chat_reactions_message
  ON siton.deal_chat_message_reactions (message_id, reaction);

-- 2) join payment-method preference
ALTER TABLE siton.participants
  ADD COLUMN IF NOT EXISTS payment_method TEXT NULL;
ALTER TABLE siton.participants DROP CONSTRAINT IF EXISTS participants_payment_method_check;
ALTER TABLE siton.participants
  ADD CONSTRAINT participants_payment_method_check
  CHECK (payment_method IS NULL OR payment_method IN ('credit_card','bit'));

-- 3) pickup coordinates
ALTER TABLE siton.deal_delivery_options
  ADD COLUMN IF NOT EXISTS latitude NUMERIC(9,6) NULL,
  ADD COLUMN IF NOT EXISTS longitude NUMERIC(9,6) NULL;

COMMIT;
