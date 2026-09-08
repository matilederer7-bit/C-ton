# Physical fulfillment — pickup credential + seller handoff

Launch Sprint 3. Closes the last operational gap of the closed web pilot for
physical-product deals: after a deal succeeds and the money is canonically
settled, the buyer holds a pickup credential, the seller verifies it in
seconds, hands over the exact quantity, and Siton records the handoff exactly
once. Voucher and ticket fulfillment are untouched.

Real money executed by this sprint: 0. Payment provider, Grow, capture,
refund, recovery, reconciliation, the financial state machine and migrations
063/064 are untouched. Fulfillment never charges, captures or refunds.

## 1. Architecture decision

**Reuse the canonical `siton.fulfillment_units` rail. No new table, no
migration.**

The audit (backend, React, test infrastructure) found that the repository
already has one fulfillment rail for all three deal types:

| Fact | Where |
|---|---|
| `fulfillment_units` rows exist for `physical_product` (one per unit, `fulfillment_kind='physical_delivery'`, `status='Issued'`, `code_hash=NULL`, `metadata_jsonb='{}'`) | migration 038, `src/deal_types.ts` `issueFulfillmentUnitsForParticipant` |
| Units are issued only after `deal.state='Completed'` **and** `participant.buyer_state='DealCompleted'` **and** `money_state IN ('ChargedSuccess','RecoveredCharge')` | `src/app.ts` `issueFulfillmentForCompletedDeal`, `decideFulfillmentIssuance` |
| Mission Control raises a P0 blocker for any unit outside that predicate | `src/admin_mission_control.ts` `buildFulfillmentReadiness` |
| The seller voucher/ticket redeem route already establishes the mutation shape: `withTx` → seller guard → `FOR UPDATE` → ownership → `Completed` → idempotent-on-state → conditional `UPDATE` | `POST /api/seller/fulfillment/:unitId/redeem` |
| `idempotency_log` accepts `entity_type='participant'` with a free `action_name` | migration 014 |
| `seller_security_events` is a seller-scoped, append-only event rail with free-text `event_type`, `actor_ref`, `request_id`, `idempotency_key`, `payload` | migration 033 |
| `audit_log` is reserved for lifecycle state transitions (trigger-enforced closed action list, `from != to`) — a handoff is **not** a lifecycle transition | migration 008/056 |
| Buyer access is the hashed, purpose-scoped, expiring tracking token | `src/participant_tracking_security.ts` |

Therefore the physical handoff extends that rail instead of creating a
parallel one:

* **Order code** — minted lazily per participant order (`ensurePhysicalOrderCode`),
  stored on every unit row of the order in `metadata_jsonb.order_code`
  (with `code_display_last4`). It is a *locator*, not a secret (§3).
* **Handoff** — whole-order: every `Issued` unit of the participant becomes
  `Redeemed` with `redeemed_at = now()` in one transaction under `FOR UPDATE`;
  the handoff record (`seller_id`, actor, request id, idempotency key, qty,
  source) is written into `metadata_jsonb.handoff` of each unit. For
  `physical_product`, **`Redeemed` means "handed over"**; `redeemed_at` is the
  authoritative fulfillment timestamp. Voucher/ticket semantics of the same
  column are unchanged.
* **Replay** — `idempotency_log (entity_type='participant', action_name='fulfillment.handoff')`
  stores the first response per idempotency key; the same key returns the
  same body. Without a key, state-based idempotency still answers
  `already_fulfilled` (200, no second effect).
* **Audit** — one `seller_security_events` row per handoff
  (`event_type='fulfillment.handoff'`, `actor_ref`, `request_id`,
  `idempotency_key`, payload with deal/participant/qty/unit ids/last4).
* **Eligibility** — `decideFulfillmentIssuance` (the existing canonical
  predicate) evaluated **live** on the participant/deal rows at every
  resolve/handoff. A unit row never *creates* eligibility; a later
  `Refunded`/`AuthReleased` participant is refused even though units exist.

Why not a migration: everything above fits existing columns and constraints;
a new table or column would add a ledger position (066 would be the next safe
id, after 065 applied on staging and before the reserved 063/064) for no
semantic gain. Known limitation: lookups by order code are scoped to the
seller's deals (index `idx_fulfillment_units_deal`) and the global uniqueness
check at mint time is a bounded scan — fine for pilot volume; an index on
`(metadata_jsonb->>'order_code')` is the first thing to add if volume grows.

## 2. Identity model

```
buyer  ── tracking token (hashed, 45 d, purpose tracking/recovery/support)
       └─ GET /api/participants/:id/tracking  → tracking.pickup {…, order_code, qr_payload}

seller ── seller session / Supabase seller capability (resolveRequiredSellerContext)
       ├─ GET  /api/seller/fulfillment/resolve?code=…     (QR or typed code)
       ├─ GET  /api/seller/fulfillment/search?q=…         (phone / name)
       ├─ POST /api/seller/fulfillment/handoff            (mutation)
       └─ GET  /api/seller/deals/:dealId/fulfillment      (operational list)
              + /delivery-handoff/export.xlsx gains order code, payment, fulfillment columns

admin  ── GET /api/admin/deals/:id/profile → fulfillment {awaiting, fulfilled, …}
```

The server resolves `code → units → participant → deal → seller ownership →
live eligibility` on every call. IDs supplied alongside a code are only
cross-checked, never trusted.

## 3. Short-code model

`CT-NNNN-NNNN` — eight decimal digits from `crypto.randomBytes`, grouped for
reading aloud, typed on a numeric keypad. Accepted input: any case, with or
without `CT`, dashes, spaces, or the full QR URL. Properties:

* stable per order (minted once, stored),
* no PII, no payment data, no provider reference, no sequence (no volume leak),
* collision-safe: uniqueness is checked at mint (bounded retry); resolution is
  seller-scoped, and an ambiguous match inside one seller's orders is refused
  (`pickup_code_ambiguous`) instead of guessing.

The code is a **locator only**. Anonymous resolution is impossible (seller
guard first), another seller's code answers exactly like an unknown code
(404, no enumeration), and nothing can be mutated with the code alone.

## 4. QR threat model — why the QR is not payment authority

QR payload: `https://<host>/preview/#/seller/pickup?code=CT-NNNN-NNNN`.
Contains the locator and nothing else — no name, phone, address, participant
id, tracking token, invoice or provider data. A forwarded screenshot leaks
nothing: resolution needs an authenticated seller who owns the deal.

Scanning proves possession of a locator. Payment truth comes from
`participants.money_state` / `deals.state` in PostgreSQL, read at resolve time
and again inside the handoff transaction. A screenshot, an e-mail, a receipt,
a provider reference shown by the buyer or a seller click never count.

## 5. Seller verification

Traffic-light result, never colour alone (icon + text + `data-state`):

| Verdict | Copy | Action |
|---|---|---|
| `ready` | ✓ מוכן למסירה + buyer, product, qty, payment "שולם ✓", method, code | "אישור מסירה — N יחידות" → explicit confirmation sheet |
| `already_fulfilled` | כבר נמסר + time, code | none (repeat scans are safe) |
| `not_ready` | אין למסור את ההזמנה + reason (payment incomplete / deal not completed / failed / cancelled / refunded / unavailable) | none |
| 404 | הקוד אינו תקין | none |

"שולם" is shown only for `ChargedSuccess` / `RecoveredCharge`. Staging/mock
runtimes keep the disclosure "סביבת הדגמה — אין חיוב אמיתי".

## 6. Fallback identification

Camera is never required: "הקלדת קוד" (numeric keypad) and search by phone or
buyer name across the seller's completed physical deals are always one tap
away. Camera outcomes handled: granted, denied, unavailable, unsupported
(desktop / iOS without `BarcodeDetector` → jsQR fallback), invalid/unreadable
QR, foreign-seller code, unknown code.

## 7. Delivery / export flow

Delivery (courier) orders get the same order code and the same whole-order
handoff ("סומן כנמסר") from the list — no QR emphasis for the buyer. The Excel
export (`/delivery-handoff/export.xlsx`) carries: order code, deal/product,
buyer, phone, e-mail, quantity, delivery method, address, city, notes,
payment status, fulfillment status. No carrier integration, no shipment
tracking.

## 8. Privacy

Seller sees buyer data only for orders of deals they own. Anonymous callers
never see name, phone, e-mail, address, payment or fulfillment state. Seller
A cannot resolve or fulfill seller B's order (404 identical to unknown).
Admin lists never show the full order code (last 4 only). No raw tokens or
codes are logged.

Sprint-2 wording correction: buyer feedback has no structured PII fields;
optional free text must be treated as user-provided content.

## 9. Known limitations

* Whole-order handoff only (no partial quantities) — by design for the pilot.
* No reversal ("undo handed over") — support/admin after launch.
* No e-mail/SMS on readiness; the tracking page is the credential carrier.
  The payload already exposes order code, product, quantity, pickup location
  and the tracking link for a future notification.
* Order-code lookups are seller-scoped scans without a dedicated index.

## 10. Pilot operating procedure (counter)

1. Seller opens **סריקת איסוף** (dashboard or deal screen) on the phone.
2. Scans the buyer's QR, or taps **הקלדת קוד** and types the 8 digits, or
   searches by phone/name.
3. Reads the card: buyer, product, **quantity**, "שולם ✓", method.
4. Taps **אישור מסירה — N יחידות**, confirms "אתם מוסרים עכשיו N יחידות של X ל-Y".
5. Sees "נמסר ✓". A second scan shows "כבר נמסר" with the time.
6. If the card is red, does not hand over; the reason line says why.

## 11. What is proven (2026-09-08, branch `claude/physical-fulfillment-pickup`)

| Suite | Group | Result |
|---|---|---|
| `tests/seller_pickup_fulfillment_validation.ts` — bookstore lifecycle (A–J), 6 non-settled money states, RecoveredCharge, failed/open deal, qty mismatch, delivery + Excel row, admin snapshot, voucher isolation, existing delivery-handoff contract | api | 21/21 |
| `tests/pickup_fulfillment_concurrency_validation.ts` — 2/5/10/25 simultaneous confirms parked at COMMIT with PostgreSQL-reported lock waiters, free-running burst, durable-before-reply | concurrency | 6/6 |
| `tests/seller_fulfillment_security_validation.ts` — hosted runtime shape: anonymous × hostile inputs, forged header, buyer bearer, policy classification | security | 5/5 |
| `tests/frontend_foundation_pickup_validation.ts` — client/server normaliser parity, scanner outcomes, QR locator, encode → jsQR decode roundtrip, React source pins, camera policy, dependency pins | unit | 9/9 |
| `scripts/pickup_fulfillment_browser_proof.cjs` — buyer @390/@430 (card, full-screen, not-ready), seller @390/@430/@1280 (dashboard entry, camera granted, camera denied, invalid + real typed code), counter moment @390 (QR deep link → green → confirm → נמסר → amber → buyer fulfilled), unpaid search → red, deal list pending → fulfilled, desktop; 0 console errors, 0 failed requests, no overflow, no unreadable text | browser | 25/25, scan → confirm ≈ 1 s |
| Regression: unit 15/15, api 44/44, security 39/39, integration 30/30, concurrency 7/7; route-authorization gate (static 1 + behavioural 4); TypeScript, lint + backend scans, payment compliance, runtime DDL, Base44 integrity, architecture, mobile contract, demo build, fresh-DB migrations 58/58; Sprint 2 buyer proof 32/32 | | all PASS |

Negative controls from the sprint brief covered by the suites above: anonymous cannot
resolve / search / fulfill (401/403 hosted, 404 demo default seller); seller A cannot
resolve or fulfill seller B's order (identical 404); invalid, malformed, tampered and
hostile codes leak nothing; AuthHeld, AuthLocked, ChargeAttempt, ChargeFailedRecovery,
AuthReleased and Refunded cannot fulfill; failed and open deals cannot fulfill; a
fulfilled order cannot fulfill twice; 25 concurrent confirms → one handoff; displayed
qty = canonical qty (stale qty refused); handoff cannot mutate money/buyer/deal state,
payment attempts, lifecycle audit or fee events; a buyer token cannot fulfill; voucher
units and the voucher redeem route are untouched; the QR carries no PII.

Bundle impact (web): `qrcode-generator` 1.4.4 (MIT, zero deps) in the main chunk and
`jsqr` 1.4.0 (Apache-2.0, zero deps) as a lazy chunk loaded only when the scanner
starts without a native `BarcodeDetector`. Main JS 474.70 → 529.48 kB (gzip 141.08 →
159.54), CSS 69.90 → 75.68 kB, jsQR chunk 130.63 kB (gzip 47.43) on demand.

Incidental fix found by the proof: the Sprint 2 feedback honeypot input was hidden
with `left: -9999px`, which in an RTL document made the tracking page horizontally
scrollable by 10 000 px on phones; it now uses the clip-based visually-hidden pattern.
