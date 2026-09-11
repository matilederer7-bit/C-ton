# Backend-sensitive UX extensions — architecture and implementation plan

**Status:** PLANNING ONLY. No runtime code, migration, test, grant, Edge Function or
frozen branch was modified. This document is the only deliverable of the task.

| | |
|---|---|
| Planned against master | `82c91d62fd092350748405c8aec15a23d0e2af5e` (verified with `git ls-remote` + `git fetch`) |
| Frozen financial branch (read-only) | `claude/review-r9c-financial` @ `ec9cf243084bf5379ff3020933bd9f820503901a` |
| Frozen UX branch (read-only) | `claude/ux-product-polish-round2` @ `9ce6df986c7c8d230dbce1c36e4138b3a5210331` |
| Plan branch | `claude/backend-sensitive-ux-plan` (from exact master, docs only) |
| Prior art consulted (read-only, unmerged) | `claude/launch-ux-cleanup` @ `682b93c` — `src/growth_window.ts`, `src/growth_metrics.ts`, `web/src/growthRange.ts` |

Everything below was derived from the **actual** files on master and the two frozen
branches (`src/receipt_trust.ts`, `src/receipt_content_routes.ts`, `src/site_content.ts`,
`src/physical_fulfillment.ts`, `src/deal_types.ts`, `src/product_image_storage.ts`,
`src/storage_adapter.ts`, `supabase/functions/storage-broker/index.ts`, `src/viral_graph.ts`,
`src/frontend_runtime.ts`, `src/app.ts`, migrations 038/046/051/065/066,
`scripts/migration_manifest.cjs`, `supabase/staging/023_receipt_content_grants.sql`, and the
UX branch's `web/src/heroMedium.ts`, `faqContent.ts`, `receiptContent.tsx`, `landing.tsx`,
`track.tsx`, `admin.tsx`). Line numbers cite master unless a branch is named.

---

## 0. Implementation order recommendation

All four items are gated on the financial merge landing first (it appends migrations
067/068; nothing here may be numbered below 069). Recommended order, by risk and by
dependency on operator actions:

| # | Feature | Migration | Operator action | Financial overlap | Why this position |
|---|---|---|---|---|---|
| 1 | **Windowed virality** | none | none | none | Pure additive read model in isolated new modules + one route; proven prior art; zero data-model risk. Warms up the sprint. |
| 2 | **CMS FAQ** | none | none | none | `site_content` already stores JSONB with revisions; only the validator gains a list-valued field kind and the editor gains a list renderer. |
| 3 | **Multi-method receipt / redemption** | none | none | none | Highest *logic* risk (touches the entitlement rail and two redemption rails) — needs the concurrency matrix; but no schema change because `deals.receipt_config` is unconstrained JSONB read through one function. |
| 4 | **Hero image OR video** | **069** (one) | **Edge Function redeploy** + staging migration | none | The only item with a migration and an out-of-repo dependency (the storage broker's hard-coded MIME allow-list and 2 MiB cap). Last, so the migration takes 069 cleanly after 067/068 and the operator step is scheduled once. |

**Expected migrations for the whole sprint: exactly one** (`069_content_assets_video.sql`).
Items 1–3 deliberately need none.

Hard rule for every item: build on the merged master that already contains **both**
frozen branches. The UX branch owns the frontend contracts these items complete
(`heroMedium.ts`, `faqContent.ts`, `ReceiptFields`/`BuyerEntitlement`); implementing
against pre-UX master would re-create the very files the UX branch added.

---

## 1. Multi-method receipt / redemption

### CURRENT_STATE

**Storage.** `siton.deals.receipt_config JSONB NULL` (migration 066, one column, no CHECK).
Shape v1: `{ method, instructions, url }`, `method ∈ RECEIPT_METHODS = qr | code | name_phone | digital_link | instructions`
(`src/receipt_trust.ts:5`). When NULL, `receiptConfig()` defaults to `code` for vouchers and
`qr` for everything else (`src/receipt_trust.ts:13-16`). `validateReceiptConfig()`
(`:17-28`) accepts exactly one method; `digital_link` requires an `https:` URL without
credentials and may carry a `{code}` placeholder; `instructions` requires text.
Editable only while the deal is `Draft` (`receipt_locked_after_publish` 409,
`src/receipt_content_routes.ts:49-57`).

**Entitlement.** One entitlement per (deal, participant) = that participant's
`siton.fulfillment_units` rows (migration 038: one row per unit, `status`,
`metadata_jsonb`, `UNIQUE (deal_id, participant_id, unit_index)`). Issued lazily by
`issueFulfillmentUnitsForParticipant` (`src/deal_types.ts:165-224`, idempotent).

**Three credential identities already live on those same rows:**

| Credential | Where | Minted by | Consumed by | Scope |
|---|---|---|---|---|
| `code_hash` / `code_display_last4` (per unit, voucher/ticket only) | columns (038) | `issueFulfillmentUnitsForParticipant` | `POST /api/seller/fulfillment/:unitId/redeem` (`src/frontend_runtime.ts:5176`) | per unit |
| `metadata_jsonb.order_code` = `CT-NNNN-NNNN` (8 crypto digits, locator not secret) | Sprint 3 | `ensurePhysicalOrderCredential` (`src/physical_fulfillment.ts:358`) | `/api/seller/fulfillment/resolve`, `/search`, `POST /api/seller/fulfillment/handoff` (`src/frontend_runtime.ts:4727-4864`) | whole order, physical only |
| `metadata_jsonb.receipt_code` = 32 hex in 8 groups (128 random bits) | 066 (`fulfillment_receipt_locator` unique partial index on `unit_index = 1`) | `receiptForOrder` (`src/receipt_trust.ts:43-62`) | `GET /api/participants/:id/entitlement`, `GET /api/seller/receipts?q=`, `POST /api/seller/receipts/:id/redeem` (`src/receipt_content_routes.ts:58-95`) | whole order, all deal types |

**Eligibility** is read live on every call, never cached:
`decideFulfillmentIssuance` (`src/deal_types.ts:104-118`) = deal `Completed` ∧ buyer
`DealCompleted` ∧ money ∈ {`ChargedSuccess`, `RecoveredCharge`}. A refunded participant
(`money_state = Refunded`) therefore gets `entitlement: null`, `409` on redeem and is
filtered out of `/api/seller/receipts` (`WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')`,
`src/receipt_content_routes.ts:79`). `VoidedDueToDealFailure` is **never written** by any
runtime path (grep confirms only a read in `admin_mission_control.ts:1620`) — voiding is
not part of the design and does not need to become one.

**Exactly-once** is a row-state flip `status IN ('Issued','Sent') → 'Redeemed'` under
`FOR UPDATE`, idempotent on replay, in all three rails. Lock order: `redeemReceipt` takes
deal → participant → units (`src/receipt_trust.ts:32-43`); `handoffPhysicalOrder` takes
participant → units (`src/physical_fulfillment.ts:305-320`) plus `idempotency_log`
replay and a `seller_security_events (fulfillment.handoff)` audit row; the per-unit
redeem takes the unit row directly.

**Fulfillment path today** is implicit: `deal_type` (`physical_product | voucher | ticket`)
+ the buyer's delivery choice (`participants.delivery_method_type`, option types
`delivery | pickup | distribution_point`, `src/pickup_location.ts:14`).

**The concept collapse the owner flagged**, exactly as it exists in code: the buyer
tracking page shows the physical pickup card **only** when
`!data.configured && pickup?.applicable` (UX branch `web/src/receiptContent.tsx:117`,
mounted from `track.tsx:164`). Saving *any* `receipt_config` on a physical deal
hides the pickup credential and shows a second, unrelated 32-hex code. So a physical
pickup order can carry two different codes for two different seller screens
(`#/seller/pickup` scans `CT-…`, `#/seller/receipts` scans the hex code).

**Frontend (UX branch, groundwork already shipped):** `ReceiptFields` is single-select
`ChoiceCard mode="one"` with `ReceiptConfig = { method, instructions, url }`
(`receiptContent.tsx:10-37`); `ChoiceCard mode="many"` exists and is browser-proven;
`BuyerEntitlement` branches on `receipt.method` (`:119-123`); `SellerReceipts` scanner
regex accepts only the hex pattern (`:143`).

### TARGET_STATE

Two orthogonal concepts, never one field:

- **A. `fulfillment.path`** — *how the purchase reaches the buyer.* Derived, not newly
  stored: physical → `pickup | delivery | distribution_point` (from the participant's
  chosen delivery option, deal-level from `deal_delivery_options`); voucher and ticket →
  `digital`.
- **B. `redemption.methods`** — *which proofs the seller accepts.* An ordered, non-empty
  set ⊆ {`qr`, `code`, `name_phone`, `digital_link`, `instructions`}; `primary = methods[0]`.

Decisions (each answers a question in the brief):

1. **Multiple methods coexist for one entitlement** — they are *presentations of the same
   entitlement*, not separate entitlements.
2. **The seller exposes several equivalent proofs; the buyer does not choose.** The buyer's
   tracking page shows every enabled proof; `primary` is the expanded/default one and drives
   the public deal-page promise text (`RECEIPT_LABELS`).
3. **One credential per order, selected by deal type ("credential unification rule"):**
   `physical_product` → the Sprint 3 `order_code` (`CT-…`), QR = `pickupQrPayload`
   (`#/seller/pickup?code=`); `voucher` / `ticket` → `receipt_code`, QR = the receipts
   scanner URL (`#/seller/receipts?code=`). The `qr` and `code` methods are two renderings
   of *that one* credential; `name_phone` resolves to the same participant; `digital_link`
   substitutes the same credential into `{code}`. A physical order never has two codes.
4. **Exactly-once stays where it is** (unit status flip under `FOR UPDATE`). Both
   whole-order rails converge on one lock helper (deal → participant → units) so a
   receipt-rail redeem racing a pickup-rail handoff yields exactly one non-idempotent
   success and one `idempotent: true`.
5. **Physical redemption through the receipts rail delegates to `handoffPhysicalOrder`**
   so the Sprint 3 audit (`fulfillment.handoff`), `idempotency_log` replay and the
   buyer-visible "נמסר" state stay the single truth for physical orders. Voucher/ticket keep
   `redeemReceipt` (`fulfillment.redeem`).
6. **Digital links stay private**: only in the token-gated `entitlement` response
   (`Cache-Control: no-store`), never in `/api/deals/:id/receipt-info` or the public deal
   payload (already asserted by `tests/receipt_content_integration_validation.ts:105-108`).
7. **Failed/refunded buyers stay ineligible** by the existing live gate; nothing new to
   write, one new test to pin it across methods.
8. **The pickup card and the redemption proofs are both shown for physical pickup orders**
   (the card is a *path* surface: where/when + map + the credential; the proofs are
   *redemption* surfaces). The `!configured` heuristic is deleted.

### DATA_MODEL

`deals.receipt_config` stays the single store. **No table, no migration.** Reasons: it is
one seller edit, Draft-locked, ≤ 5 items; a `deal_receipt_methods` table would need a
staging grant/RLS file (pattern `supabase/staging/023_receipt_content_grants.sql`), a
join on every entitlement read, and a backfill — for no invariant the app cannot enforce.

**v2 document (written from now on):**

```json
{
  "v": 2,
  "methods": ["qr", "code", "name_phone"],
  "instructions": "הציגו את הקוד בדלפק",
  "url": ""
}
```

Rules enforced by `validateReceiptConfig` v2:

| Rule | Error code (400) |
|---|---|
| `methods` is a non-empty array of distinct `RECEIPT_METHODS` values, ≤ 5 | `invalid_receipt_methods`, `duplicate_receipt_method`, `invalid_receipt_method` |
| order is the seller's display order; `primary` is never stored separately (= `methods[0]`) | — |
| `digital_link ∈ methods` ⇒ `url` required: `https:` only, no userinfo, ≤ 2000, `{code}` allowed (existing check) | `invalid_receipt_url` |
| `digital_link ∉ methods` ⇒ `url` stored as `""` | — |
| `instructions ∈ methods` ⇒ `instructions.trim()` non-empty | `receipt_instructions_required` |
| `instructions` ≤ 1000 chars, plain text (reuse the `site_content` HTML/control-char reject) | `invalid_receipt_details` |
| `name_phone` allowed for every deal type; `digital_link` allowed for every deal type (uses the order's credential in `{code}`) | — |

**Read-time normalisation (`receiptConfig(row)`), replaces the v1 default logic:**

```
null                         → { v:2, methods: dealType === "voucher" ? ["code"] : ["qr","code"], instructions:"", url:"" }
{ method, instructions, url } (v1) → { v:2, methods:[method], instructions, url }
{ v:2, ... }                 → as stored
```

No backfill: v1 rows are read as v2 forever (three lines), so there is nothing to migrate
and nothing that can half-migrate.

**Credential selection (`credentialForOrder(c, row)`):**

```
physical_product → { kind:"order_code",   code: ensurePhysicalOrderCredential(...),   qr_payload: pickupQrPayload(origin, code) }
voucher | ticket → { kind:"receipt_code", code: <existing lazily minted receipt_code>, qr_payload: `${origin}/preview/#/seller/receipts?code=${code}` }
```

The 066 `fulfillment_receipt_locator` index and the Sprint 3 uniqueness probe stay as they
are; the only change is *which* one an order uses.

### API_CONTRACT

| Route | Change |
|---|---|
| `GET /api/seller/deals/:id/receipt` | `receipt` becomes v2 `{ v, methods, primary, instructions, url }`; adds `deal_type`, `fulfillment_path: { kind: "physical"\|"digital", options: [option_type…] }`, `allowed_methods` (all five today; the list exists so a type-specific restriction can land without a client change). `editable` unchanged. |
| `PUT /api/seller/deals/:id/receipt` | Body v2. A v1 body `{ method, … }` is accepted for one release and normalised (`methods:[method]`) — log a deprecation counter. Draft-only 409 unchanged. Error codes above. |
| `GET /api/deals/:id/receipt-info` (public) | `{ ok, methods, primary, labels: { <method>: RECEIPT_LABELS[method] }, seller }` plus deprecated mirrors `method = primary`, `label = labels[primary]` for one release. Never `url`/`instructions`. |
| `GET /api/participants/:id/entitlement` (buyer token) | `entitlement` gains `methods`, `primary`, `credential: { kind, code, qr_payload }`, `fulfillment: { path }`; keeps `code` (= `credential.code` when `qr`/`code` enabled, else `null`), `url` (only when `digital_link` enabled), `instructions`, `status`, `remaining_quantity`, `redeemed_at`, `title`, `quantity`. `configured` kept. The `tracking.pickup` block on the tracking payload is unchanged (still the pickup card's source). |
| `GET /api/seller/receipts?q=` | `q` matches buyer name, phone, `receipt_code` **or** `order_code` (digits normalised by `normalizeOrderCodeInput`). Rows add `credential.kind`, `methods`. |
| `POST /api/seller/receipts/:id/redeem` | Same shape; physical orders delegate to `handoffPhysicalOrder` (audit `fulfillment.handoff`, `idempotency_log`); others `redeemReceipt`. Passes `ensureSellerActionAllowed(seller,"operate")` like the handoff route (today the receipts redeem skips the enforcement gate — close that while here). |
| `POST /api/seller/fulfillment/handoff`, `/resolve`, `/search` | Unchanged (Sprint 3 contract is browser-proven; the receipts rail moves toward it, not the reverse). |
| `POST /api/seller/fulfillment/:unitId/redeem` | Unchanged. |

**Frontend contract (all on the UX branch's files):**

- `ReceiptFields` → `ChoiceCard mode="many"` (the shipped groundwork), plus up/down
  reorder buttons (primary = first); `url` field visible iff `digital_link` checked;
  `instructions` required iff `instructions` checked. `ReceiptConfig = { v:2, methods, instructions, url }`.
- `BuyerEntitlement` renders **all** enabled proofs from one `credential`: QR (if `qr`),
  code text (if `code`), the name+phone hint (if `name_phone`), the private link (if
  `digital_link`), the instructions block (if `instructions`); primary first/expanded. For
  physical pickup it renders `PickupCard` **and** the proofs (drop the `!configured` gate).
- `SellerReceipts` scanner decode regex = union of the hex pattern and the `CT-` pattern;
  a `CT-` result is searched through the same `/api/seller/receipts?q=`.

### AUTHORIZATION

Unchanged principals, made explicit:

- Seller config read/write: `requireSeller` + `seller_id` match + Draft-only write.
- Buyer entitlement: tracking token with purposes `tracking | receipt | recovery | support`
  (`buyerOrder`, `src/receipt_content_routes.ts:18-27`); 401 without token, 403 wrong
  participant (existing tests `:65-66`).
- Seller lookup/redeem: seller-scoped SQL (`d.seller_id = $1`), foreign seller → 404
  identical to unknown (existing), plus the `operate` enforcement gate (new for the
  receipts redeem, already on handoff).
- Public `receipt-info`: only for published, non-Draft deals; exposes methods/labels only.

### MIGRATION_PLAN

None. Optional, deliberately deferred: a `CHECK (receipt_config IS NULL OR jsonb_typeof(receipt_config->'methods') = 'array')`
would reject v1 rows that still exist; the app-level normaliser is the contract.

### BACKWARD_COMPATIBILITY

- v1 rows read as v2 (normaliser); v1 PUT bodies accepted one release.
- Response mirrors `method`, `label`, `code` kept one release for the shipped web bundle
  and the Capacitor mobile bundle (`mobile:verify` consumes the same API).
- Existing 066 receipt codes remain valid for voucher/ticket orders. Existing physical
  orders that already received a receipt code (physical deals with a saved
  `receipt_config`) switch to their `order_code` on the next read; the receipt code stays
  in `metadata_jsonb` (harmless, unique index unaffected) and the seller search still
  matches it, so a buyer holding a printed hex code is not stranded.
- `tests/receipt_content_integration_validation.ts:30-33` (v1 `validateReceiptConfig`
  assertions) are updated to v2 and gain a v1-normalisation assertion; the 13-case suite
  must stay green.

### FAILURE_MODES

| Scenario | Outcome | Mechanism / test |
|---|---|---|
| Physical order shows two different codes | Cannot happen | credential unification rule; assert `entitlement.credential.code === tracking.pickup.code` |
| Redeem via receipts rail, then handoff via pickup rail (or reverse) | second call `idempotent: true`, units unchanged | both rails flip the same rows; delegation for physical |
| Concurrent redeem across both rails, N = 10 | exactly one `idempotent:false`, one audit row, one `redeemed_at` | shared lock helper; concurrency test |
| Refund after issuance | `entitlement: null`, redeem 409, absent from seller search, `digital_link` URL no longer returned | live gate (`eligible`), test per method |
| `methods: []`, unknown method, duplicate | 400 | validator |
| `digital_link` without https URL / with userinfo / `javascript:` | 400 `invalid_receipt_url` | existing check kept |
| Seller edits after publish | 409 | existing |
| v1 client posts `{ method }` | accepted, stored v2 | normaliser |
| QR from a physical order scanned on `#/seller/receipts` | resolves (union regex + `order_code` search) | browser proof |
| `order_code` collision on mint | existing uniqueness probe + retry (`ensurePhysicalOrderCredential`) | existing test |
| `url`/`instructions` in public payloads | absent | existing privacy assertions extended to every method |

### TEST_PLAN

- **unit** (`tests/receipt_methods_v2_validation.ts`): validator matrix (all subsets of
  size 1–5, ordering preserved, `url`/`instructions` conditional rules), normaliser
  (null × deal types, v1, v2), credential rule by deal type.
- **api** (extend `receipt_content_integration_validation.ts`): v2 round trip; receipt-info
  shape + mirrors; entitlement shape for physical/voucher/ticket × method sets; seller
  search by `order_code`, hex code, phone, name; physical redeem writes
  `fulfillment.handoff` audit + `idempotency_log`; voucher redeem writes
  `fulfillment.redeem`; refund revocation per method.
- **concurrency** (`tests/receipt_rails_concurrency_validation.ts`): mixed-rail race at
  2/5/10 parked at COMMIT, exactly one success; plus the existing
  `pickup_fulfillment_concurrency_validation` 6/6 unchanged.
- **security**: private link never in public payloads for any method set; foreign seller
  404 on both rails; buyer token 401/403; enforcement-gated seller refused on receipts
  redeem (new).
- **browser** (`scripts/ux_polish_round2_browser_proof.cjs` extension): multi-select +
  reorder; buyer page shows pickup card + proofs (physical) / proofs only (voucher) at
  390/430/1280; seller receipts page scans both patterns; no overflow, no console errors.
- **regression gates**: `seller_pickup_fulfillment_validation` 21/21,
  `seller_fulfillment_security_validation` 5/5, route-authorization gate, full suite one
  runner at a time.

### ROLLOUT_ORDER

1. `receipt_trust.ts`: v2 normaliser + validator (read both, write v2); shared
   `lockOrderForRedemption(c, participantId)` used by `redeemReceipt` and by
   `handoffPhysicalOrder` (deal → participant → units).
2. `credentialForOrder` + receipts search union + physical delegation to handoff +
   enforcement gate on receipts redeem.
3. Route responses (v2 + mirrors).
4. Frontend: `ReceiptFields` many-select, `BuyerEntitlement` all-proofs, scanner union.
5. Tests above; browser proof re-run.
6. One release later: remove v1 body acceptance and the `method/label/code` mirrors.

### KNOWN_CONFLICTS

- Financial branch: **none** (touches no receipt/fulfillment/deal_types module — verified
  with `git diff --name-only`).
- UX branch: `web/src/receiptContent.tsx`, `track.tsx`, `pickupCard.tsx`, `seller.tsx` are
  the base for step 4 — **MEDIUM** if step 4 is started before the UX branch merges.
- `PROJECT_STATUS.md`: **HIGH** (every branch prepends), trivial resolution.

---

## 2. CMS FAQ

### CURRENT_STATE

`siton.site_content (content_key PK, value_jsonb, previous_value_jsonb, revision, updated_by, updated_at)`
(migration 066) — the column is already JSONB and already revisioned. What is flat is the
**validator**: `validateContent()` (`src/site_content.ts:18-32`) accepts only
`Record<string, string>` against a fixed per-section field list (`CONTENT_SECTIONS`,
`:6-17`), rejects unknown keys, HTML-looking text and control characters, and validates the
`image` field as `/api/content-assets/<uuid>`. `PUT /api/admin/site-content/:key`
(`src/receipt_content_routes.ts:123-142`) requires `admin_users.manage`, serialises on
`pg_advisory_xact_lock(hashtext('site-content:'||key))`, enforces optimistic `revision`
(409 `content_changed_reload`), and keeps `previous_value_jsonb` (one-step undo).
`GET /api/site-content` (`:115-118`) is public and `no-store` (global hook,
`docs/CACHE_POLICY.md`). The admin editor `ContentAdmin` (UX branch
`receiptContent.tsx:205-214`) renders input / textarea / image per declared field.

The landing (UX branch `landing.tsx:110`) already reads `content.faq` through
`resolveFaqItems` (`faqContent.ts`), preferring `{ items: [{ q, a }] }`, with caps
40 items / 300 / 2000 and the canonical Hebrew list as fallback.

### TARGET_STATE

Admin adds / edits / deletes / reorders FAQ entries; the list persists, reloads, survives
concurrent editing without lost updates, and renders safely on the landing.

**Evaluation of the three options:**

| Option | Ordering | Revisions / conflicts | Sanitisation | Auth | Public read | Cost | Verdict |
|---|---|---|---|---|---|---|---|
| A. normalised `site_faq_items` table | `position` column, renumber on move | per-row; needs a new revision scheme or accepts row-level last-writer-wins | same text rules, new code path | new routes + RLS/grant file (staging 024) | join + order by | migration + grants + 4 routes + editor | over-built for ≤ 40 rows edited by one admin at a time |
| **B. structured JSON in `site_content`** | array order | whole-document optimistic `revision` + `previous_value_jsonb` — already implemented | reuse existing plain-text rules per item | existing `admin_users.manage` route | one row, existing endpoint | validator field kind + editor renderer | **chosen** |
| C. another abstraction (`legal_pages`, `LANDING_HE` constants) | — | — | — | — | — | — | `legal_pages` *is* a `site_content` section with code defaults; nothing else in the repo holds admin-editable structured content |

B is chosen on the merits, not convenience: ordering is intrinsic to an array; the
conflict protection asked for (revision + reload) already exists at the document level and
is the right granularity for a list that is edited as a whole; and a single admin PUT is
atomic, so a reorder can never be half-applied (which a per-row table needs a transaction
to guarantee).

### DATA_MODEL

`content_key = 'faq'`, `value_jsonb`:

```json
{
  "items": [
    { "id": "f_9k2m4x", "q": "מה קורה אם לא מגיעים ליעד?", "a": "לא מחייבים…" }
  ]
}
```

| Rule | Error (400) |
|---|---|
| `items` array, 0–40 entries (0 allowed: hides the section, landing falls back to canonical list) | `invalid_content_list`, `invalid_content_list_length` |
| each item object with `id`, `q`, `a` only | `invalid_content_item` |
| `id`: `^f_[a-z0-9]{6,16}$`, unique within the list; server assigns one when missing/invalid (so a first save from an editor that lacks ids still succeeds) | — |
| `q`: NFC, trimmed, 1–300, single line (newlines → space) | `invalid_content_item_length` |
| `a`: NFC, trimmed, 1–2000, `\n` allowed (rendered pre-wrap) | `invalid_content_item_length` |
| existing HTML-tag / control-char reject applied to `q` and `a` | `content_html_not_allowed` |
| exact duplicate `q` (case-insensitive after NFC) | `content_faq_duplicate_question` |

Ids give the editor stable row keys across reorders and make a future per-item merge
possible without a schema change.

`site_content.ts` changes: `Field` gains `list?: { maxItems: number; item: Record<string, { max: number; multiline?: boolean }> }`;
`CONTENT_SECTIONS.faq = { label: "שאלות נפוצות", fields: { items: { label: "שאלות ותשובות", max: 40, list: {...} } }, defaults: { items: LANDING_HE.faq.items.map(…with ids…) } }`.
`defaults` / `validateContent` return types widen from `Record<string,string>` to
`Record<string, unknown>` (the only type change; string sections are unaffected).

### API_CONTRACT

No new endpoint.

- `GET /api/site-content` → `content.faq = { items: [...] }` (defaults when no row).
- `GET /api/admin/site-content` → `sections.faq = { label, fields, defaults, value, revision, updated_at, updated_by }`.
- `PUT /api/admin/site-content/faq` body `{ value: { items: [...] }, revision }` →
  `200 { ok, sections }` | `409 content_changed_reload` | `400 <codes above>` |
  `401/403` (existing admin gate).
- `previous_value_jsonb` keeps the prior list (first save stores the code defaults, as
  today for legal pages).

### AUTHORIZATION

`requireAdminMutation(req, reply, "admin_users.manage")` — unchanged (SuperAdmin only,
per `ROLE_PERMISSIONS` in `src/admin_identity.ts:57-72`). Public GET is anonymous by
design. If the owner later wants an OpsAdmin to edit content, the correct change is a new
`content.manage` permission in `ADMIN_PERMISSIONS` — out of scope here and noted so it is
not solved by loosening `admin_users.manage`.

### MIGRATION_PLAN

None. `site_content` already has `SELECT, INSERT, UPDATE` for `siton_web_runtime`
(staging 023) — no grant change.

### BACKWARD_COMPATIBILITY

- Landing already resolves the target shape (`faqContent.ts`) — no landing change.
- Absent row → code defaults → identical rendering to today.
- The string-only editor loop keeps working for every other section (the list renderer is
  additive, keyed on `field.list`).
- `previous_value_jsonb` semantics unchanged.

### FAILURE_MODES

| Scenario | Outcome |
|---|---|
| Two admins edit; second saves with a stale `revision` | 409, existing "התוכן עודכן בידי מנהל אחר" message; no lost update |
| HTML / script / control chars in `q` or `a` | 400; and React renders text nodes only (no `dangerouslySetInnerHTML`) |
| 41 items / 2001-char answer / empty question | 400 with a specific code the editor maps to a field |
| Malformed JSON reaches the landing (e.g. manual DB edit) | `resolveFaqItems` ignores it and falls back — section never blanks |
| Editor loaded before the upgrade and submits `{ }` for `faq` | server treats missing `items` as `[]` only if explicitly `[]`; missing key → 400 `invalid_content_list` (fail closed, editor reloads) |
| Reorder mid-flight with a delete | whole-document PUT: last consistent list wins atomically |

### TEST_PLAN

- **unit**: `validateContent("faq", …)` matrix (caps, ids assigned/unique, dedupe, HTML,
  control chars, NFC, newline handling, other sections unaffected).
- **api**: persist → reload → reorder → 409 on stale revision → `previous_value_jsonb`
  holds prior list → public GET shape.
- **security**: anonymous PUT 401; `ReadOnlyAdmin`/`OpsAdmin` PUT 403; oversize body.
- **browser**: editor add / edit / delete / move up / move down / save / reload; landing
  renders N items in order at 390 and 1280; RTL; keyboard-only reorder.

### ROLLOUT_ORDER

1. `site_content.ts` list field kind + `faq` section (server accepts and validates).
2. `ContentAdmin` list renderer (add / edit / delete / up / down / save).
3. Tests + browser proof.

### KNOWN_CONFLICTS

- Financial: none.
- UX branch: `receiptContent.tsx` (`ContentAdmin`) and `admin.tsx` (only emoji removals)
  — **LOW/MEDIUM**, same file different function; `faqContent.ts` / `landing.tsx` are
  consumers and stay untouched.

---

## 3. Hero image OR video

### CURRENT_STATE

**Three independent layers reject video today**, all of which the plan must widen together:

1. **Database:** `siton.content_assets.mime_type CHECK (mime_type IN ('image/png','image/jpeg','image/webp'))`
   (migration 066). The table is `INSERT`-only for the web runtime (staging 023 revokes
   `UPDATE` — "content assets must be immutable to runtime", `verify_receipt_content.sql`).
2. **Fastify:** `saveDealImage` → `validateImageFile` (`src/product_image_storage.ts:38-70`):
   image MIME set, 5 MiB, magic-byte sniff; body arrives as base64 JSON under the global
   `bodyLimit: 8 MiB` (`src/app.ts:3243`); route `POST /api/admin/content-assets`
   (`src/receipt_content_routes.ts:154-164`) writes storage **first**, DB **second**, deletes
   the object if the INSERT fails.
3. **Storage broker Edge Function** (`supabase/functions/storage-broker/index.ts:22-23,145-153`):
   `MAX_BYTES = 2 MiB`, `ALLOWED_CONTENT_TYPES` = the three image types, enforced again on
   `put`; uploads with `cacheControl: "31536000"`, `upsert: false`, verify-after-put.

**Delivery:** `GET /api/content-assets/:id` (`:165-170`) proxies the whole buffer
(`readDealImage` → broker `get` → base64 → Buffer), sets `nosniff`, and — because the
global hook only exempts `/api/deal-images/` (`src/app.ts:3287-3289, 3327-3331`) — is served
`no-store`. No `Range` support. By contrast `/api/deal-images/:id` (`src/app.ts:3603-3657`)
302-redirects published images to the durable Supabase public URL with
`public, max-age=31536000, immutable`, and `SupabaseBrokerStorageAdapter.publicReadUrl()`
(`src/storage_adapter.ts`) already computes that URL from a key.

**CMS:** `home.image` is a flat string validated as `/api/content-assets/<uuid>` owned by
`admin:%`. **Video** comes from unrelated env (`LANDING_HERO_VIDEO_ENABLED/_URL/_POSTER`
on `/api/preview/meta`, `src/frontend_runtime.ts:2175-2177`). The UX branch's
`heroMedium.ts` is the one decision point (video wins only if enabled + URL + no
reduced-motion + no Save-Data; otherwise image) and `landing.tsx:52-59` renders
`<video muted autoPlay loop playsInline preload="metadata" poster>` with
`<source type="video/mp4">` after first paint. No CSP header exists (`grep` on
`Content-Security-Policy` is empty), so `media-src` is not a constraint today.

### TARGET_STATE

The admin picks **one** hero medium in the CMS. `kind = image` renders the image;
`kind = video` renders a responsive, muted, looping, poster-backed video with a visible
pause control. The public contract emits exactly one medium; the admin contract keeps both
slots so switching back does not destroy the other upload.

**Supported formats and limits (policy, enforced server-side unless stated):**

| Item | Value | Where enforced |
|---|---|---|
| MIME | `video/mp4`, `video/webm` (admin route only; the seller asset route stays image-only) | Fastify validator, broker allow-list, DB CHECK |
| Magic bytes | MP4: `ftyp` at offset 4 with major brand ∈ {`isom`,`iso2`,`mp41`,`mp42`,`avc1`,`M4V `}; reject `qt  ` (QuickTime). WebM: EBML `1A 45 DF A3` and DocType `webm` | Fastify validator (`validateVideoFile`) + broker |
| Size | `HERO_VIDEO_MAX_BYTES = 6_000_000` — the largest raw payload whose base64 JSON fits the existing 8 MiB body limit; images keep 5 MiB | Fastify validator; broker `MAX_BYTES_VIDEO` |
| Duration | ≤ 20 s. Client pre-check (`HTMLVideoElement.duration` before upload) + server best-effort for MP4 by parsing `moov/mvhd` (`timescale`, `duration`); WebM is bounded by size only | client + Fastify |
| Guidance (not enforced) | ≤ 1280×720, ≤ 30 fps, ~1.5–3 Mbps, no audio track | admin editor help text |
| Poster | **required** for `kind = video`: an image content asset (existing upload path) | `validateContent` cross-field |

**Storage:** same adapter, new key namespace `${prefix}/content/hero/${uuid}.mp4|.webm`
(images keep `deals/<id>/images/…` for now); `product_image_storage.ts` is generalised
into `content_asset_storage.ts` exposing `saveContentAsset({ kind:"image"|"video", … })`
with the same "put → verify → return key" contract and the same fail-closed cleanup.
No external video hosting: the canonical Supabase Storage bucket already serves public,
immutable, CDN-cached objects, which is exactly what a hero loop needs.

**Delivery:** `GET /api/content-assets/:id` → if the adapter exposes `publicReadUrl`,
`302` to it with `cache-control: public, max-age=31536000, immutable` (mirrors
deal-images; the browser then does Range requests directly against Supabase); otherwise
(local adapter, CI) proxy with `Accept-Ranges: bytes`, `Content-Length`, and `206` for a
single byte range. Exempt `/api/content-assets/` from the global no-store hook (rename
`isImmutableDealImageRoute` → `isImmutableAssetRoute`, one regex). Content assets are
public and immutable by construction (UUID key, INSERT-only) so this is safe for images
too — a side benefit, not a behaviour change in what is exposed.

**Poster / fallback / autoplay / a11y / mobile:**

- `<video muted autoplay loop playsinline preload="metadata" poster>` — autoplay is
  browser-permitted only because it is muted + inline; no `controls`; decorative →
  `aria-hidden="true"`; text content lives outside the video (existing overlay).
- **WCAG 2.2.2**: motion that starts automatically and lasts > 5 s must be pausable → a
  visible pause/play toggle (≥ 44 px target, labelled "השהיית הווידאו" / "הפעלת הווידאו"),
  state persisted in `localStorage` for the session.
- `prefers-reduced-motion` or Save-Data / 2G → poster only (existing `heroMedium` rule;
  the poster *is* the video's still, not a second medium).
- `onerror` / `stalled` beyond 3 s → swap to poster (`<img>`), no spinner.
- Mobile: poster first paint (LCP), video becomes eligible after first paint (existing
  `deferred`), iOS Low-Power blocks autoplay → poster remains; the pause control is
  reachable by thumb.
- No CSP exists; if one is added later `media-src` must include the Supabase origin.

**CDN / cache:** Supabase sets `cache-control: 31536000` at upload; keys are immutable, so
replacing the hero = new asset + new CMS revision; old objects remain (cleanup is the
existing `storage_cleanup_tasks` concern, out of scope).

**Admin preview:** after upload the editor shows `<video controls muted>` + poster preview
*before* Save; Save runs the cross-field validation; the public site changes only on Save
(revision).

**Mutual exclusion:** server `hero_kind` is the single switch; the public projection emits
one `hero` object; the editor uses `ChoiceCard mode="one"`; the landing renders
`medium.kind` only (existing).

### DATA_MODEL

**Migration `069_content_assets_video.sql`** (the sprint's only migration; appended to
`scripts/migration_manifest.cjs` **after** `068`):

```sql
BEGIN;
-- Widen the media allow-list. The 066 inline CHECK was auto-named
-- content_assets_mime_type_check; the DO block tolerates a different name.
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'siton.content_assets'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%mime_type%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE siton.content_assets DROP CONSTRAINT %I', c); END IF;
END $$;
ALTER TABLE siton.content_assets ADD CONSTRAINT content_assets_mime_type_check
  CHECK (mime_type IN ('image/png','image/jpeg','image/webp','video/mp4','video/webm'));
-- Recorded at INSERT (the runtime has no UPDATE privilege); NULL for pre-069 rows.
ALTER TABLE siton.content_assets ADD COLUMN IF NOT EXISTS size_bytes INTEGER NULL
  CHECK (size_bytes IS NULL OR size_bytes > 0);
ALTER TABLE siton.content_assets ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT NULL
  CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$');
COMMIT;
```

`size_bytes` lets the proxy set `Content-Length` without a HEAD round-trip and lets the
editor show what was stored; `checksum_sha256` is what the upload already computes. Both
are optional to the design; the CHECK widening is the required part.

**`site_content` `home` section** (JSONB, no migration): add fields
`hero_kind` (`select: ["image","video"]`, default `"image"`), `hero_video` (`video: true`,
`/api/content-assets/<uuid>` of a `video/*` asset owned by `admin:%`), `hero_poster`
(`image: true`). Cross-field: `kind=video` ⇒ `hero_video` and `hero_poster` required;
`kind=image` ⇒ `image` used, video slots retained but ignored. **Missing new keys on write
default** (`hero_kind → "image"`, others → `""`) so an editor that loaded the pre-upgrade
value can still save.

### API_CONTRACT

| Route | Change |
|---|---|
| `POST /api/admin/content-assets` | accepts `mime_type ∈ video/mp4\|video/webm`; response adds `kind: "image"\|"video"`, `size_bytes`; errors `invalid_video_type`, `video_too_large`, `video_content_mismatch`, `video_too_long`, `invalid_video_file`. |
| `POST /api/seller/content-assets` | unchanged; video → 400 `invalid_image_type`. |
| `GET /api/content-assets/:id` | 302 to CDN when available (immutable cache) else proxy with Range; `nosniff` kept; exempt from no-store. |
| `PUT /api/admin/site-content/home` | accepts `hero_kind`, `hero_video`, `hero_poster`; asset ownership check (`owner_ref LIKE 'admin:%'`) extended to both; `hero_video` must reference a `video/*` asset and `hero_poster`/`image` an `image/*` asset (`invalid_content_video`, `invalid_content_image`, `hero_poster_required`, `hero_video_required`). |
| `GET /api/site-content` | `content.home.hero = { kind:"image", url } \| { kind:"video", url, poster }`; legacy `content.home.image` kept one release (= image url, or the poster when kind=video). |
| `GET /api/admin/site-content` | `home.value` carries all slots. |
| `GET /api/preview/meta` | unchanged this release; `landing_hero_video_*` deprecated: CMS `hero` wins whenever `hero_kind` is set; env removed next release. |

Frontend: `useHeroMedium` (UX `landing.tsx:40-48`) takes `content.home.hero` as its input
(`imageUrl` = image url or poster; `videoEnabled = kind === "video"`, `videoUrl`,
`videoPoster`) — `resolveHeroMedium` itself is unchanged; `HeroMediumView` adds the pause
control and error fallback; `ContentAdmin` gains the kind radio, video upload with
pre-check + preview, poster upload.

### AUTHORIZATION

Admin upload and content PUT: `admin_users.manage` (existing). Ownership: assets referenced
by the CMS must be `admin:%`-owned (existing check, extended). Public read of content
assets: anonymous by design (unchanged). Seller routes cannot upload video.

### MIGRATION_PLAN

1. **Broker first** (backward compatible — images unchanged): extend
   `ALLOWED_CONTENT_TYPES`, add `MAX_BYTES_VIDEO = 6_000_000`, sniff video magic; redeploy
   the Edge Function to staging (operator: Supabase CLI/console — the same path that placed
   the current function; the broker key digest does not change). **Probe** in staging that
   the function accepts an ~8 MB JSON `put` (Edge Function request-size behaviour is not
   documented in-repo; if it refuses, the fallback is a `put_part`/`put_complete` pair in the
   broker, not a change to this plan's contract).
2. Apply `069` on staging after `067/068` (ledger position must follow them); no grant
   file needed (same table, INSERT-only stays); add `verify_content_video.sql` in the
   `verify_receipt_content.sql` style (constraint definition, columns, role privileges,
   rollback probe).
3. Deploy the app.
4. Rollback: CMS `hero_kind=image` (instant, no deploy); app rollback keeps working because
   069 is additive; the broker's wider allow-list is harmless to the old app.

### BACKWARD_COMPATIBILITY

- Pre-069 `content_assets` rows: `size_bytes`/`checksum_sha256` NULL; proxy falls back to
  buffer length.
- `home.image` keeps its meaning; `hero_kind` absent ⇒ image.
- Old admin bundle saving `home` without the new keys ⇒ server defaults.
- Env-driven video keeps working until the CMS sets a kind; removed next release.
- Content-asset URLs in existing content (seller logos, CMS image) are unchanged; they gain
  long-lived caching.

### FAILURE_MODES

| Scenario | Outcome / mitigation |
|---|---|
| Upload larger than cap / JSON > 8 MiB | 400 `video_too_large` or Fastify 413 before the handler; no object written |
| Declared MIME ≠ magic (e.g. HTML named `.mp4`) | 400 `video_content_mismatch`; if anything ever slipped through, `nosniff` + `video/*` content type prevents rendering as a document |
| Stale broker (not yet redeployed) rejects video | 400/503 from storage → **no DB row** (storage-first order kept) → editor shows the error |
| INSERT fails after put | object deleted (existing pattern) |
| `kind=video` without poster / poster is a video / video is an image | 400 with a specific code |
| CDN 302 to a missing object | 404 from Supabase; prevented by broker verify-after-put; proxy path unaffected |
| Autoplay blocked / reduced motion / Save-Data / decode error | poster image; no layout shift (poster sized like the video) |
| Duration > 20 s in WebM (not server-parsed) | bounded by 6 MB; documented as best-effort |
| Cache poisoning of an immutable URL | impossible to overwrite (UUID key, `upsert:false`, INSERT-only) |
| A future CSP without `media-src` | documented here; add the Supabase origin when CSP lands |

### TEST_PLAN

- **unit**: `validateVideoFile` matrix (brands, WebM DocType, QuickTime reject, size
  boundary 6_000_000 ± 1, empty, truncated `moov`, `mvhd` duration 19.9 s / 20.1 s);
  `validateContent("home")` cross-field matrix incl. missing-key defaults; `resolveHeroMedium`
  with CMS-shaped input (kind/poster/reduced-motion/save-data).
- **api**: admin video upload → row with `video/mp4` + `size_bytes`; seller video upload
  400; content PUT combinations; public projection emits exactly one `hero`; content-assets
  GET on the local adapter → 200 with `Accept-Ranges` and 206 for `Range: bytes=0-99`; on a
  stubbed Supabase adapter → 302 + immutable cache header; no-store absent on this route
  only (extend `tests/cache_policy_validation.ts`).
- **migration proof** (style of the financial branch's `scripts/review_r9c_migration_independent_proof.cjs`): fresh
  install, upgrade from a 068 database with existing image rows, constraint name/definition
  assertion, rerun idempotence, checksum tamper rejection.
- **security**: hostile MP4 carrying `<script>` served as `video/mp4` + `nosniff`;
  anonymous/seller upload refused; `owner_ref` foreign asset refused in CMS.
- **browser**: editor image↔video toggle keeps both slots, preview before save; landing
  video-only / image-only; reduced-motion → poster; pause control keyboard + touch;
  390/430/1280; no overflow, no console errors.
- **staging**: Edge Function accepts a 6 MB put; CDN URL plays with Range; rollback via
  `hero_kind=image`.

### ROLLOUT_ORDER

1. Broker Edge Function change + staging redeploy + size probe.
2. Migration 069 (manifest after 068) + staging apply + verify script.
3. `content_asset_storage.ts` (video validator, key namespace) + upload/serve routes +
   cache exemption.
4. `site_content.ts` hero fields + public projection.
5. Landing `useHeroMedium` input + pause control; `ContentAdmin` editor.
6. Env deprecation notice; removal next release.

### KNOWN_CONFLICTS

- `src/app.ts`: one-line hook regex change at `3287-3289` — financial hunks are elsewhere
  (nearest `3119-3125`) → **LOW**; alternative with zero app.ts contact: set
  `cache-control` in the route handler (overrides the hook) and accept the stale
  `pragma`/`expires` companions — not recommended.
- `scripts/migration_manifest.cjs`: financial appends 067/068 exactly where 069 must go →
  **HIGH textual, trivial semantic** (append after 068; keep the financial comment).
- UX branch `heroMedium.ts` / `landing.tsx` are consumers — build on them → **LOW** after
  the UX merge, **MEDIUM** before.
- `supabase/functions/storage-broker/index.ts`: neither branch touches it → LOW, but it is
  an operator-deployed artefact, not a repo merge.

---

## 4. Windowed virality

### CURRENT_STATE

`GET /api/admin/growth` (`src/frontend_runtime.ts:10668-10692`) returns
`platform` = the **lifetime** cache row (`viral_metrics_cache('platform','global')`,
worker-computed by folding every per-deal cache — `recomputeAggregateViralMetrics`,
`src/viral_graph.ts:662-727`) plus a **hard-coded** `last_7_days` (`viral_events` counts
by type; attributed `viral_attributions` count). The per-deal cache has no time dimension
except `viral_joins_last_7d`. The UX branch `GrowthScreen` (`admin.tsx:934+`) renders
`platform.*` tiles, `platform.top_deals/top_sellers`, and `last7.attributed_joins`;
`api.adminGrowth()` takes no parameters (`web/src/api.ts:178`).

**Every source row is timestamped**, so windows can be computed at read time:

| Table | Timestamp | Index today |
|---|---|---|
| `siton.participants` (a join) | `created_at` | `(deal_id)`, `(deal_id, …)` — none on `created_at` alone |
| `siton.viral_attributions` (join attribution) | `created_at` (= join), `first_touch_at`, `last_touch_at` | `(deal_id, generation)`, parent/origin partials |
| `siton.viral_events` (funnel) | `created_at` | `(deal_id, event_type, created_at DESC)` |
| `siton.affiliate_link_events` (link click/entry) | `created_at` | `(link_id, event_type, created_at DESC)` |
| `siton.affiliate_links` (personal links) | `created_at` | origin partials |

A query-time window already exists in the repo as precedent: `GET /api/admin/pilot-metrics?days=`
(`src/frontend_runtime.ts:10536-10540`, 7/30/90, capped 365).

**Prior art (read-only, unmerged, `claude/launch-ux-cleanup` @ `682b93c`):**
`src/growth_window.ts` (validated resolver: `days` | `from/to` | `range=all`; defaults 7;
floor 2020-01-01; +2 days future tolerance; 20-year span; Hebrew labels),
`src/growth_metrics.ts` (six live queries over `[from, to)` mirroring the lifetime
semantics), `tests/admin_growth_window_validation.ts`, `web/src/growthRange.ts`. That
commit also removed buyer-side impact aggregates from `viral_graph.ts` — unrelated and
**not** part of this plan; port the window modules semantically, do not cherry-pick.

### TARGET_STATE

**Determination:** the current data supports correct range filtering. **No schema,
cache, or worker change is required.** The work is a read model + route parameters +
response shape + UI selector.

Owner requirements mapped: default 7 days ✔ (`GROWTH_DEFAULT_DAYS`), 7/30/90 presets ✔,
custom range ✔ (`from`/`to`), all-time ✔ (`range=all`), **separate lifetime block** ✔
(`platform` stays as-is, labelled "מצטבר — כל הזמן" with its `computed_at`).

**Window semantics (documented so the two blocks are comparable):**

| Metric | Counted in window when |
|---|---|
| joins | `participants.created_at ∈ [from,to)` and `buyer_state <> 'NotJoined'` |
| attributed joins / sharing participants / max generation / top deals & sellers | `viral_attributions.created_at ∈ window` and `origin_ref_type <> 'none'` |
| charged units / GMV (and attributed variants) | participant **joined** in the window and is charged **now** (`money_state ∈ ChargedSuccess, RecoveredCharge`); GMV = `qty × price_per_unit + delivery_cost` (same as lifetime) — the UI labels the block "הצטרפו בטווח" so the "joined then, charged as of now" reading is explicit |
| funnel events (`deal_view`, `share_button_click`, `join_started`, `join_failed`, `inquiry_started`, `personal_link_created`) | `viral_events.created_at ∈ window` |
| link clicks / entries | `affiliate_link_events.created_at ∈ window` |
| personal links | `affiliate_links.created_at ∈ window`, `origin_type='participant'` |
| ratios (`viral_coefficient`, `viral_share_of_joins`, `viral_share_of_charged`, `visit_to_join_rate`) | computed from the window counts with the lifetime formulas (`finalizeRollup`) |

Timezone: the UI takes Israel-local day pickers and sends UTC instants
(`from = 00:00 Asia/Jerusalem`, `to = next day 00:00`, exclusive); the server is UTC-only
and never interprets local dates.

### DATA_MODEL

None new. Optional, deferred until measured: `idx_participants_created_at` and
`idx_viral_attributions_created_at` (a later migration, only if staging p95 for
`range=all` exceeds ~300 ms; pilot volumes are hundreds to low thousands of rows and the
queries are six non-recursive aggregates).

### API_CONTRACT

`GET /api/admin/growth?days=7|30|90` (default `days=7`) | `?from=<ISO>&to=<ISO>` | `?range=all`

```json
{
  "ok": true,
  "window": { "kind": "days", "days": 7, "from": "…Z", "to": "…Z", "label_he": "7 הימים האחרונים" },
  "windowed": { "joins": 0, "attributed_joins": 0, "viral_coefficient": 0, "viral_share_of_joins": 0,
                "charged_units": 0, "charged_gmv": 0, "attributed_charged_units": 0, "attributed_charged_gmv": 0,
                "viral_share_of_charged": 0, "sharing_participants": 0, "max_generation": 0, "personal_links": 0,
                "share_button_clicks": 0, "deal_views": 0, "link_clicks": 0, "link_entries": 0,
                "funnel_events": {}, "top_deals": [], "top_sellers": [] },
  "platform": { "…lifetime cache unchanged…" },
  "last_7_days": { "…deprecated: equals the windowed funnel/attributed counts when days=7; removed next release…" }
}
```

Errors: `400 { ok:false, code: growth_range_invalid | growth_range_inverted | growth_range_too_early | growth_range_future | growth_range_too_long, message_he }`.
`days` outside `1..3650` clamps to the default (prior-art behaviour) — keep, but reject
non-numeric explicitly rather than silently defaulting.

Frontend: `api.adminGrowth(params)`; `web/src/growthRange.ts` (preset/custom/all state +
local-day → UTC conversion, ported); `GrowthScreen` gains the selector row (7 / 30 / 90 /
טווח מותאם / כל הזמן) above the windowed tiles and keeps the lifetime block below with its
own heading.

### AUTHORIZATION

`requireAdminRead` (`mission_control.read`) — unchanged. Seller-scoped windows for
`/api/seller/deals/:dealId/viral` are a natural follow-up using the same module with a
`deal_id` predicate; not in this task.

### MIGRATION_PLAN

None.

### BACKWARD_COMPATIBILITY

Parameter-less call returns the 7-day window (today's implicit behaviour) plus the
unchanged `platform` block, so the current `GrowthScreen` keeps rendering before it is
updated; `last_7_days` is kept one release.

### FAILURE_MODES

| Scenario | Outcome |
|---|---|
| inverted / pre-2020 / future / > 20-year custom range | 400 with Hebrew message; UI keeps the previous window |
| `range=all` on a large table | bounded aggregate queries; measured in the api test with `EXPLAIN (ANALYZE)` logged; index added later only if needed |
| lifetime cache empty (worker not yet run) | `platform: null` as today; windowed block still answers from source tables |
| DST edge in custom days | resolved client-side with `Intl` in `Asia/Jerusalem`; server only sees instants |

### TEST_PLAN

- **unit** (`tests/growth_window_validation.ts`): resolver matrix (default, presets,
  clamp, custom valid/inverted/too-early/future/too-long, all).
- **api** (`tests/admin_growth_window_validation.ts`, port + extend): fixture with joins,
  attributions and events at three synthetic timestamps (via direct `UPDATE … created_at`
  on the fresh test DB) → counts for 7/30/90/custom/all; `range=all` joins equal the
  recomputed lifetime cache's `participants`; 400 cases; anonymous 401; `ReadOnlyAdmin`
  200.
- **browser**: selector changes tiles; lifetime block unchanged and separately headed;
  RTL date inputs at 390 and 1280.

### ROLLOUT_ORDER

1. `src/growth_window.ts`, `src/growth_metrics.ts` (ported, no `viral_graph.ts` change).
2. Route parameters + response.
3. `api.ts`, `growthRange.ts`, `GrowthScreen`.
4. Tests + browser proof.

### KNOWN_CONFLICTS

- `src/frontend_runtime.ts` route region `10668-10692` and the import block `~216`:
  financial edits `1349` and `5921`, UX edits `2889` and `3045` → **LOW** (distinct
  regions; auto-merge expected — see §5).
- `web/src/pages/admin.tsx` `GrowthScreen` (UX changed the heading text only) → **LOW**.
- `web/src/api.ts`: untouched by both → LOW.

---

## 5. Cross-check against the frozen branches — conflict map

**Method.** `git diff --name-only 82c91d6 <branch>` for both branches, intersection, and a
read-only `git merge-tree --write-tree ec9cf24 9ce6df9` (writes a tree object only; no ref
moved). Result: the two frozen branches intersect on **exactly two files**
(`PROJECT_STATUS.md`, `src/frontend_runtime.ts`); `merge-tree` reports **one** content
conflict — `PROJECT_STATUS.md` — and auto-merges `frontend_runtime.ts`.

Financial branch footprint: `src/app.ts` (+2139/−…, payment lifecycle), `payment_*`,
`grow_payment_adapter.ts`, `platform_fee_money.ts`, `runtime_config.ts`,
`outbox_worker_helpers.ts`, `operational_repair.ts`, `fault_injection.ts`,
`frontend_runtime.ts` (2 hunks), migrations `067/068` + manifest, `tests/lab/*`, ~45 test
files, `scripts/review_*`, `docs/R9C_*`. UX branch footprint: `web/src/**` (16 files),
`frontend_runtime.ts` (public deal payload), `tests/buyer_feedback_support_operations_validation.ts`,
`package.json` (1 line), `scripts/ux_polish_round2_browser_proof.cjs`, docs.

| Path | Financial | UX | This plan touches | Risk | Reason |
|---|---|---|---|---|---|
| `PROJECT_STATUS.md` | prepends | prepends | implementation branches will prepend | **HIGH** (certain, trivial) | Every branch prepends a section at the top; resolve by keeping both in date order. This plan branch deliberately does **not** edit it to avoid adding a third head. |
| `scripts/migration_manifest.cjs` | appends 067/068 + rewrites the reservation comment | — | appends 069 (hero) | **HIGH** textual, trivial semantic | 069 must be appended *after* 068; merge financial first, then add one line. |
| `src/frontend_runtime.ts` | `~1349` deps type, `~5921` webhook, `~5779` registration in app.ts | `~2889` SELECT, `~3045` seller block | `~216` imports, `~1721` receipt deps, `10668-10692` growth route | **MEDIUM** | Four parties, one 11.9k-line file; all regions are disjoint and merge-tree already proves financial×UX auto-merge; run `git merge-tree` again before each implementation PR. |
| `src/app.ts` | 50+ hunks (payments) | — | one regex at `3287-3289` (hero cache exemption) | **LOW** | Nearest financial hunk `3119-3125`; no overlap. Everything else in this plan stays out of app.ts by design (receipt routes live in `receipt_content_routes.ts`, growth in `frontend_runtime.ts`). |
| `src/receipt_trust.ts`, `src/receipt_content_routes.ts`, `src/physical_fulfillment.ts`, `src/deal_types.ts` | — | — | multi-method (1) | **LOW** | Untouched by both frozen branches (verified). |
| `src/site_content.ts` | — | — | FAQ (2), hero (3) | **LOW** | Untouched by both. |
| `src/product_image_storage.ts`, `src/storage_adapter.ts` | — | — | hero (3): new `content_asset_storage.ts`, storage untouched | **LOW** | Untouched by both. |
| `src/viral_graph.ts` | — | — | none (windowing lives in new modules) | **LOW** | Untouched by both; prior art's change here is excluded. |
| `src/migrations/` | `067_*`, `068_*` | — | `069_*` | **LOW** | New files only; ids reserved in order. |
| `supabase/functions/storage-broker/index.ts` | — | — | hero (3) | **LOW** (repo) / operator step | Not a merge concern; a deploy concern. |
| `web/src/receiptContent.tsx` | — | +115 (ReceiptFields, BuyerEntitlement, ContentAdmin) | (1) receipt UI, (2) FAQ editor, (3) hero editor | **MEDIUM** | Must be based on the UX version; three features edit three different functions in one file — sequence PRs, do not parallelise. |
| `web/src/pages/landing.tsx`, `heroMedium.ts`, `faqContent.ts` | — | rewritten/new | (3) hero input, (2) none | **LOW** after UX merge, **MEDIUM** before | Consumers of the contracts this plan completes. |
| `web/src/pages/admin.tsx` | — | emoji/label edits | (4) GrowthScreen selector | **LOW** | Disjoint lines. |
| `web/src/pages/track.tsx`, `pickupCard.tsx`, `seller.tsx` | — | edited | (1) pickup+proofs | **MEDIUM** before UX merge | Same reason as `receiptContent.tsx`. |
| `web/src/styles.css` | — | +127 | small additions (editor rows, pause control) | **LOW** | Append-only. |
| `web/src/api.ts` | — | — | (4) `adminGrowth(params)` | **LOW** | Untouched by both. |
| `tests/full_e2e_gate_validation.ts`, `full_system_qa_validation.ts`, `deal_types_e2e_validation.ts` | edited | — | none (new test files only) | **LOW** | Keep new coverage in new files. |
| `package.json` | — | +1 script | none | **LOW** | — |
| `docs/` | `R9C_*` | `UX_PRODUCT_POLISH_ROUND_2.md` | this file + per-feature runbooks | **LOW** | Disjoint. |

**Highest-risk conflicts, summarised:** `PROJECT_STATUS.md` (certain, trivial) and
`scripts/migration_manifest.cjs` (certain, trivial, order-sensitive). No HIGH-risk
*semantic* conflict was found: nothing in this plan touches payment code, financial state
machines, migrations 053/066/067/068, or the Grow adapter.

---

## 6. What this task did and did not do

- **Did:** inspect master and both frozen branches read-only; run a read-only
  `merge-tree`; write this plan; commit it on `claude/backend-sensitive-ux-plan` (created
  from exact master `82c91d6`) and push that branch only.
- **Did not:** modify runtime code, tests, migrations, the manifest, grants, the Edge
  Function, `PROJECT_STATUS.md`, or either frozen branch; merge; deploy; call Grow; move
  money. `PROJECT_STATUS.md` is intentionally untouched: the next implementation branch
  records the milestone when runtime work actually lands, and this avoids a third
  concurrent head on the file that already conflicts between the two frozen branches.
