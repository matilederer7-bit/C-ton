-- 061 — P0.7 internal buyer → seller inquiries.
--
-- Contact between a buyer and a seller stays INSIDE the product: a public
-- "פנייה למוכר" creates a seller-owned inquiry THREAD bound to the deal (the
-- deal determines the seller; the browser never supplies a seller id) and the
-- authoritative conversation lives here. The seller is only NOTIFIED by the
-- canonical notification rail that a new inquiry exists (the e-mail is a
-- pointer back into the product, never the conversation itself), and the
-- seller's e-mail address is never exposed to the buyer.
--
-- This is deliberately NOT the platform Support case rail (operational_cases):
-- support is admin-owned; an inquiry is seller-owned and seller-isolated.
--
-- Also widens the notification vocabulary CHECKs (029) to the code-defined
-- event list — they were never extended past the original eleven — and adds
-- the new seller_customer_inquiry event/template.

BEGIN;

SET search_path TO siton, public;

CREATE TABLE IF NOT EXISTS siton.seller_inquiry_threads (
  thread_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL,
  customer_name TEXT NOT NULL CHECK (char_length(customer_name) BETWEEN 1 AND 120),
  customer_email TEXT NOT NULL CHECK (char_length(customer_email) BETWEEN 3 AND 200),
  customer_ref TEXT NOT NULL,
  customer_access_token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Answered','Closed')),
  seller_unread_count INT NOT NULL DEFAULT 0 CHECK (seller_unread_count >= 0),
  customer_unread_count INT NOT NULL DEFAULT 0 CHECK (customer_unread_count >= 0),
  message_count INT NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_preview TEXT NOT NULL DEFAULT '',
  last_sender_type TEXT NOT NULL DEFAULT 'Customer' CHECK (last_sender_type IN ('Customer','Seller')),
  seller_last_read_at TIMESTAMPTZ NULL,
  request_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seller_inquiry_threads_seller
  ON siton.seller_inquiry_threads (seller_id, last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_seller_inquiry_threads_deal
  ON siton.seller_inquiry_threads (deal_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_seller_inquiry_threads_customer
  ON siton.seller_inquiry_threads (customer_ref, created_at DESC);

CREATE TABLE IF NOT EXISTS siton.seller_inquiry_messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES siton.seller_inquiry_threads(thread_id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('Customer','Seller')),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  body_hash TEXT NOT NULL,
  request_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seller_inquiry_messages_thread
  ON siton.seller_inquiry_messages (thread_id, created_at ASC);

-- Notification vocabulary: align the DB CHECKs with src/notification_templates.ts
-- and add the seller inquiry pointer event.
ALTER TABLE siton.notification_events
  DROP CONSTRAINT IF EXISTS notification_events_event_type_check;
ALTER TABLE siton.notification_events
  ADD CONSTRAINT notification_events_event_type_check CHECK (event_type IN (
    'buyer_joined_authorized',
    'buyer_deal_target_reached',
    'buyer_deal_completed',
    'buyer_deal_failed',
    'buyer_recovery_required',
    'buyer_payment_recovered',
    'buyer_voucher_issued',
    'buyer_ticket_issued',
    'seller_deal_published',
    'seller_target_reached',
    'seller_deal_completed',
    'seller_deal_failed',
    'seller_excel_ready',
    'seller_kyc_approved',
    'seller_kyc_rejected',
    'seller_payout_frozen',
    'seller_payout_unfrozen',
    'seller_customer_inquiry',
    'admin_security_alert'
  ));

ALTER TABLE siton.notification_events
  DROP CONSTRAINT IF EXISTS notification_events_template_key_check;
ALTER TABLE siton.notification_events
  ADD CONSTRAINT notification_events_template_key_check CHECK (template_key IN (
    'buyer_joined_authorized_he',
    'buyer_deal_target_reached_he',
    'buyer_deal_completed_he',
    'buyer_deal_failed_he',
    'buyer_recovery_required_he',
    'buyer_payment_recovered_he',
    'buyer_voucher_issued_he',
    'buyer_ticket_issued_he',
    'seller_deal_published_he',
    'seller_target_reached_he',
    'seller_deal_completed_he',
    'seller_deal_failed_he',
    'seller_excel_ready_he',
    'seller_kyc_approved_he',
    'seller_kyc_rejected_he',
    'seller_payout_frozen_he',
    'seller_payout_unfrozen_he',
    'seller_customer_inquiry_he',
    'admin_security_alert_he'
  ));

COMMIT;
