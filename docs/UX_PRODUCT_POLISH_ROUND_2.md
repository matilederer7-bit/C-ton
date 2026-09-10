# UX / product polish — round 2 (owner findings)

Branch `claude/ux-product-polish-round2`, cut from canonical master
`82c91d62fd092350748405c8aec15a23d0e2af5e`.

Frontend-first. **No migration, no payment rail, no Grow, no money, no deploy.**
The single backend edit is one additive READ projection (see UX-5); it touches no
state machine, no write path and no financial code.

Reference branch `claude/launch-ux-cleanup` (`682b93c`) was read for prior art —
**not** merged or cherry-picked. Each item below records whether the change was
newly written, ported semantically, or deliberately skipped because current
master already solves it another way.

---

## Closed in this round

### UX-1 — guest / pilot screen: decorative glyph removed, text kept

`web/src/pages/landing.tsx`. The closed-pilot disclosure
("פיילוט סגור — בשלב זה לא מתבצעים חיובים אמיתיים.") carried a decorative
test-tube glyph beside it. The glyph is gone; the sentence, its saffron weight
and its position are unchanged, and **nothing was inserted in its place** — the
block keeps its own spacing (`.landing-pilot`) so the section still reads
balanced.

The large hero image was deliberately **kept**: it is the CMS-editable primary
medium ("תמונת פתיחה") that UX-7B is about extending to image-or-video. Removing
it would contradict that item.

> Scope note, deliberate: the buyer-facing deal page carries the same pilot
> pattern (`data-testid="pilot-line"` and `pay-pilot-note`), also with the
> glyph. That is not the guest screen, and both lines are asserted verbatim by
> `tests/frontend_foundation_buyer_polish_validation.ts:85-86` as a
> buyer-comprehension pattern from an earlier round. Left as-is rather than
> silently widening the owner's request. **One-line follow-up if wanted.**

### UX-2 — required-field validation you cannot miss

New `web/src/fieldAttention.ts` — one rule, no global hack:

* `attention(errors, key)` / `attentionBlock(...)` decorate **the exact control
  that failed** with `.needs-attention` (a slow two-second border breath, three
  cycles then rest — never a strobe), `aria-invalid="true"`, and the `f-<key>`
  scroll/focus anchor.
* `settleErrors(shown, next)` only ever **removes** errors while the user works,
  so typing in one field can never light up another. A text field clears on the
  first valid character; a select / number / option group clears the moment its
  value becomes valid.
* `focusField(key)` scrolls the first failing control to centre and focuses it.
* `@media (prefers-reduced-motion: reduce)` swaps the animation for a static
  ring, so nothing is carried by motion alone.

Wired into both seller forms: the create wizard (22 fields + the images block +
the delivery notice + the receipt fieldset) and the draft edit form, whose
validation was extracted into one `validateEdit()` so the live rule and the
submit rule cannot drift.

### UX-3 — decorative glyphs off section / subsection headings

37 heading glyphs removed across the seller flow, the deal page, tracking,
pickup, inquiries and admin — every `panel-title` / `section-title` / `h1..h3` /
`legend`, including the four the owner named (פרטי העסקה, אספקה ומשלוח,
איסוף עצמי, משלוח). The buyer's delivery-type glyphs (🚚 / 🏪 / 📍) are gone
too; the option name carries itself.

**Functional icons on actions were left alone** — buttons, share glyphs, status
pills, empty-state illustrations. Clean typography and hierarchy, not a purge.

### UX-4 — Siton selection controls

New `ChoiceCard` in `web/src/components.tsx` plus `.choice-card` / `.choice-ind`
in `styles.css`. One control for every "pick an option" surface:

| state | card | indicator |
|---|---|---|
| unselected | neutral border, recessed ground | empty, neutral |
| selected | Siton orange border + orange tint | **inside fills with the canonical Siton orange** |

The indicator **shape carries the arity**: a round dot when exactly one option
may be active, a square check when several may be. The native input stays in the
accessibility tree and is only visually replaced.

Applied to the section the owner named ("איך הקונה יקבל את מה ששילם עליו"), to
the buyer's delivery choice, and to the buyer's public-name opt-in (the real
square multi-select case).

**See BACKEND GAP 1** for why the receipt method stays single-select.

### UX-5 — seller public profile, exposed (existing backend, not a new model)

The data already existed and was already canonical: migration 066 added
`seller_accounts.public_profile_id` + `profile_image_id`, and `publicSeller()`
in `src/receipt_trust.ts` already returns name / about / image / stats / deals.
Two things were missing.

1. **The public deal payload did not carry it.**
   `buildPublicDealPayload` in `src/frontend_runtime.ts` selected
   `business_name`, `business_description` and `verification_status` but not the
   profile id or the logo — so the deal page could not render either. The SELECT
   and the `seller` block now also project `public_profile_id` → `profile_id`
   and `profile_image_id` → `image` (the existing `/api/content-assets/<uuid>`
   URL). **Additive read projection from the same canonical row — no second
   model, no new storage, no write path.**
2. **The frontend did not render it.** The deal page's seller panel now shows
   the logo, the display name, the operator-proved approval badge, the About
   text and a link to the full public profile. `SellerIdentity` and
   `PublicSellerPage` were restyled into the Siton design language.

Still never exposed: e-mail, phone, address, bank details, payment identifiers,
the internal `seller_id`, raw verification status, buyer information. Contact
remains the internal inquiry rail only.

`tests/buyer_feedback_support_operations_validation.ts` assertion 8 keeps its
**strict** key allow-list (a future key must be added deliberately) and was
extended with explicit negative proofs: the projected id is the public profile
UUID and not the internal `seller_id`, and the block carries no contact/bank
detail and no raw status.

### UX-6 — share card promoted, social buttons standardised

* "מכירים מישהו שזה יעניין אותו?" now renders **directly under the decision
  block and above "איך זה עובד"**, where a buyer who has just understood the
  group rule is most likely to pass the deal on. Proved by DOM order *and*
  measured page position at all four widths.
* Every social button is now **one identical white disc** with the network glyph
  on top — the previous X implementation generalised to all five. The
  per-network coloured discs are gone; size, radius, glyph colour, hover and
  focus are one rule.

### UX-7 — hero medium: exactly one, never both (frontend groundwork)

New `web/src/heroMedium.ts` — one pure precedence rule, one medium out. This
fixes a real defect: a configured background video used to render *behind* the
configured hero image. A video now wins only when the runtime flag, the asset
and the viewer's own conditions (not reduced-motion, not save-data/2G) all
allow; otherwise the medium is the image. **See BACKEND GAP 2** — the CMS still
cannot store the choice.

### UX-8 — virality label

"צמיחה וויראליות" → "ויראליות" in both user-facing places (the admin growth
screen heading and its nav item). Historical documentation left untouched.

### UX-9 — old UX work recovered where master lacked it

| Ported | What |
|---|---|
| ✅ `web/src/quantityInput.ts` + `QtyInput` | Quantities are **typed** — digits only, numeric keyboard, no `+/−` stepper and no browser spinner. Replaces `QtyStepper` on the buyer join. |
| ✅ `web/src/scrollRestoration.ts` + `App.tsx` | True back/forward scroll restoration **per history entry**; a new entry still starts at the top. Replaces the unconditional scroll-to-top. |
| ✅ buyer-side viral-tree cleanup | `web/src/vtree.tsx` (281 lines) was orphaned on master — nothing imported it. Deleted. The buyer's tracking page already shows share identity + impact only. |
| ✅ legal-page Siton shell | Achieved on master's own route model (see below). |

| Deliberately NOT ported | Why |
|---|---|
| `web/src/pages/legal.tsx` + `#/legal/*` routes | **Superseded.** Master serves the same canonical `src/legal_pages.ts` content through the CMS (`/api/site-content` → `ContentPage` at `#/content/legal_*`). Porting the old route would create a second legal renderer. Instead the *shell* was brought up to standard: `.content-doc` (orange section markers, measured line length, RTL-safe wrapping) plus a chip strip between the legal documents. |
| virality date filters | **Not frontend-compatible** — see BACKEND GAP 3. |
| `navIcons.tsx` / pickup navigation, buyer-search intent, growth windows | Outside this round's scope, or already solved differently on master. |
| the old branch's `.impact-stats` CSS removal | Master's tracking page still uses those classes. |

### UX-10 / UX-11 — acceptance

`scripts/ux_polish_round2_browser_proof.cjs` — **85/85 PASS** at **390 / 430 /
1280 / 1440**, driving the *real* React components in headless Edge over CDP
against deterministic fixtures. No database, no money, no network beyond
127.0.0.1.

---

## Backend-sensitive items left OPEN

These need a migration and/or a new persistence contract. Per the parallel-work
constraint they are documented, not faked, and carry safe frontend groundwork so
the UI needs no rework when the backend lands.

### BACKEND GAP 1 — multiple receipt / fulfillment methods per deal

**Owner intent:** a seller enables several supported ways for the buyer to
receive what they paid for.

**Current contract (single-value):** `siton.deals.receipt_config` is a JSONB
object with exactly one `method`, and `validateReceiptConfig()`
(`src/receipt_trust.ts:17`) rejects anything else. `receiptForOrder`,
`RECEIPT_LABELS`, the buyer entitlement and the seller redemption surface all
read that one method.

**Therefore:** the UI keeps single-select radio semantics and the **round**
indicator. A frontend-only multi-select would show the seller choices the
database cannot store and the buyer would never receive.

**Groundwork shipped:** `ChoiceCard` already supports `mode="many"` (square
indicator, checkbox semantics, identical orange fill) and is proven in the
browser on the real multi-select opt-in. Wiring the receipt surface to it is a
one-line change once the contract exists.

**Required to close:** a migration widening `receipt_config` to an ordered
collection of methods (or a `deal_receipt_methods` table), a `validateReceiptConfig`
that validates the collection, a per-method entitlement/redemption path, and a
backfill for existing single-method deals.

### BACKEND GAP 2 — CMS hero media as IMAGE **or** VIDEO

**Owner intent:** one active primary medium, chosen in the admin CMS.

**Current contract blocks it twice:**
1. `siton.content_assets.mime_type` has
   `CHECK (mime_type IN ('image/png','image/jpeg','image/webp'))` (migration
   066) — a video upload is rejected **at the database**.
2. `validateContent()` (`src/site_content.ts`) validates an image field against
   `^/api/content-assets/[0-9a-f-]{36}$` and has no notion of a medium *kind*,
   so "which of the two is active" cannot be stored at all.

Today the video comes from unrelated runtime env
(`LANDING_HERO_VIDEO_ENABLED` / `_URL` / `_POSTER`), which is why the two could
collide.

**Groundwork shipped:** `web/src/heroMedium.ts` is the single decision point and
already returns exactly one medium; the landing renders `medium.kind`, so both
can never appear. The video branch renders a responsive, muted, poster-backed
`<video>` today if the runtime flag is on.

**Required to close:** a migration adding video MIME types to `content_assets`
(plus size/duration limits and a storage decision), a `kind` on the hero content
field, `validateContent` support for it, and an admin editor that picks one.

### BACKEND GAP 3 — CMS-managed FAQ

**Owner intent:** add / edit / remove / **reorder** FAQ entries in the CMS.

**Current contract:** `siton.site_content` stores one JSONB object per
`content_key`, and `validateContent()` accepts **only** a flat
`Record<string, string>` against a fixed per-section field list — every value
must be a string of a declared field. An ordered array of `{q, a}` pairs is
rejected before it reaches the database.

**Groundwork shipped:** `web/src/faqContent.ts` is now the ONE place the landing
reads its FAQ from. It already accepts the eventual ordered shape
(`{ items: [{q, a}] }`), a bare array, and the flat numbered `faq_N_q` /
`faq_N_a` pairs a string-only store could carry — falling back to the canonical
Hebrew list, so a malformed payload can never blank the section. When the
backend gains the contract, only this resolver's input changes.

**Required to close:** a list-valued content contract (validation, length caps,
ordering, revisioning) and an admin editor with add / edit / remove / reorder.

### BACKEND GAP 4 — virality date filters

The old branch's windowed virality needed new backend modules
(`src/growth_window.ts`, `src/growth_metrics.ts`), `viral_graph` changes and a
`/api/admin/growth` that accepts `?days=` / `?from=&to=` / `?range=all`. Master's
route takes no parameters, so the filter is **not** frontend-compatible. Left
OPEN rather than faking a client-side filter over data the server did not
window.

---

## Proof

```
node scripts/ux_polish_round2_browser_proof.cjs [--shots=<dir>]
```

Renders the real components at 390 / 430 / 1280 / 1440 and asserts: the pilot
text without its glyph and with nothing replacing it; exactly one hero medium;
the marked control after a failed continue (pulsing border + `aria-invalid` +
scrolled into view + focused) and its clearing on the first valid character,
with the other missing controls still marked; zero decorative glyphs on
headings; the orange-filled indicator on selection (round for single, square for
multi) with neutral unselected; the share block above "איך זה עובד"; five
identical white social discs; the seller logo / name / About / stats rendered
with no contact leak; the Siton legal shell; typed quantities with no stepper or
spinner; RTL; zero horizontal overflow; zero console errors.
