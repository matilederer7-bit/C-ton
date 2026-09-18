-- 073 — Durable pre-dispatch identity for hosted Grow authorization creation.
--
-- createPaymentProcess is an external side effect and the reviewed J4/J5
-- contract exposes no provider-side idempotency key. The existing
-- payment_authorization_bindings.correlation_id uniqueness is therefore used
-- as the durable Siton intent identity BEFORE provider I/O. The customer-facing
-- hosted URL is persisted only so an exact idempotent replay can return the
-- original successful response without creating a second provider process.
--
-- Real money remains governed separately; this migration does not enable any
-- provider or payment environment.

BEGIN;

ALTER TABLE siton.payment_authorization_bindings
  ADD COLUMN IF NOT EXISTS provider_payment_url TEXT NULL;

COMMIT;
