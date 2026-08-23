# Synthetic Money Proof

Status: PASS with zero external provider/network traffic.

## What was proved

The deterministic `synthetic` provider implements the production-neutral
`PaymentProvider` interface. Outcomes are scripted, references are stable,
same-key replay is idempotent, a changed payload conflicts, callbacks can be
duplicated or delivered out of order, and UNKNOWN stays non-final until an
authoritative status/reconciliation result exists.

The isolated launch rehearsal ran 12 selected tests across all ten canonical
groups on disposable local PostgreSQL databases. The network-deny preload
blocked non-loopback sockets and `fetch`; no Grow, Stripe, Base44, Supabase,
SMS, email, invoice, storage, deploy, or publish request was made.

## Scenario matrix

| Scenario | Evidence |
|---|---|
| A — below threshold | failed-deal/refund and full E2E contracts prove no illegal capture, payout, or fee |
| B — exact 90% | canonical `threshold_units` transition starts once; replay is rejected/idempotent |
| C — above threshold | successful close, charge, completion, ledger, documents, and settlement |
| D — max inventory | concurrent joins cannot reserve above `max_units`; valid winners alone remain |
| E — repeat buyer | separate valid purchases by one buyer remain separate while capacity exists |
| F — mixed charging | success/failure/recovery stay in the completion-window constitution |
| G — recovery success | recovered charge is counted once and creates canonical money evidence |
| H — recovery expiry/failure | late recovery fails closed and does not create entitlement |
| I — refund | eligible system refund, signed ledger reversal, and duplicate-refund idempotency |
| J — crash/replay | fenced Outbox recovery prevents stale completion and duplicate economic effect |
| K — UNKNOWN | timeout does not guess; webhook/status reconciliation supplies final truth |

## Accounting truth

The canonical integer-minor-unit calculations passed for product-only,
delivery-inclusive, multi-unit, multi-buyer, recovery, refund, replay, and
rounding cases:

- customer-collected gross includes product plus delivery;
- Siton fee base equals that gross and the fee rate is exactly 8%;
- VAT is represented separately and is excluded from the fee base under the
  existing accounting model;
- seller entitlement is derived from the canonical ledger, not recomputed in
  seller/admin UI;
- distributor commission and entitlement are exactly zero;
- failed/unsettled buyers do not enter seller settlement;
- reversals and duplicate events do not create or destroy an agora.

## Reproducible commands

`npm run test:synthetic-money` builds the mobile bundle, denies external
network, creates isolated databases, applies all 44 migrations, and runs the
scenario set. `npm run rehearsal:no-network` adds architecture, security,
payment, runtime-DDL, and bundle gates around the same proof.

Latest focused result: 12/12 selected test files, 10/10 groups, zero failures;
`LAUNCH_REHEARSAL_PASS ... external_network=0`.
