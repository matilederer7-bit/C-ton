-- Admin Support Hub / Operational Cases.
-- Soft references are intentional: historical local/demo data has not always
-- carried stable seller/buyer foreign keys, and support cases must survive even
-- when the referenced operational record is later cleaned up.

BEGIN;

SET search_path TO siton, public;

CREATE SCHEMA IF NOT EXISTS siton;

CREATE TABLE IF NOT EXISTS siton.operational_cases (
  case_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_type TEXT NOT NULL CHECK (case_type IN (
    'RefundRequest',
    'DeliveryIssue',
    'SellerRisk',
    'BuyerComplaint',
    'PaymentMismatch',
    'InvoiceIssue',
    'ContentReport',
    'SystemException',
    'Other'
  )),
  status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN (
    'Open',
    'NeedsSeller',
    'NeedsAdmin',
    'WaitingExternal',
    'Resolved',
    'Closed'
  )),
  priority TEXT NOT NULL DEFAULT 'Normal' CHECK (priority IN ('Low','Normal','High','Urgent')),
  source TEXT NOT NULL DEFAULT 'Admin' CHECK (source IN ('Admin','Buyer','Seller','System')),
  deal_id UUID NULL,
  seller_id TEXT NULL,
  participant_id UUID NULL,
  buyer_ref TEXT NULL,
  opened_by TEXT NULL,
  assigned_to TEXT NULL,
  subject TEXT NOT NULL,
  description TEXT NULL,
  resolution_note TEXT NULL,
  auto_key TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ NULL,
  CONSTRAINT operational_cases_close_note_check
    CHECK (status NOT IN ('Resolved','Closed') OR NULLIF(btrim(COALESCE(resolution_note,'')), '') IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS siton.operational_case_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES siton.operational_cases(case_id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'case.create',
    'case.update_status',
    'case.assign',
    'case.close',
    'case.escalate',
    'case.refund_request_marked'
  )),
  actor_ref TEXT NOT NULL DEFAULT 'admin',
  reason TEXT NOT NULL DEFAULT '',
  from_status TEXT NULL,
  to_status TEXT NULL,
  from_priority TEXT NULL,
  to_priority TEXT NULL,
  request_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_operational_cases_status_priority_created
  ON siton.operational_cases (status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_operational_cases_type_status
  ON siton.operational_cases (case_type, status);
CREATE INDEX IF NOT EXISTS idx_operational_cases_deal
  ON siton.operational_cases (deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_operational_cases_seller
  ON siton.operational_cases (seller_id) WHERE seller_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_operational_cases_participant
  ON siton.operational_cases (participant_id) WHERE participant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_operational_cases_open_auto_key
  ON siton.operational_cases (auto_key)
  WHERE auto_key IS NOT NULL AND status IN ('Open','NeedsSeller','NeedsAdmin','WaitingExternal');
CREATE INDEX IF NOT EXISTS idx_operational_case_events_case_created
  ON siton.operational_case_events (case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operational_case_events_type_created
  ON siton.operational_case_events (event_type, created_at DESC);

COMMIT;
