# Canonical Foundation Source Of Truth

Date: `2026-04-18`

## Binding Decision

The foundation documents under [docs/foundation-canonical-2026-04-18](/c:/Users/Lenovo/Documents/C-ton/docs/foundation-canonical-2026-04-18) are now the binding source of truth for Siton.

These files supersede older repository foundation documents anywhere there is contradiction, ambiguity, duplication, or drift:

1. [סיטון אפיון מוצר מלא עדכני.docx](/c:/Users/Lenovo/Documents/C-ton/docs/foundation-canonical-2026-04-18/סיטון אפיון מוצר מלא עדכני.docx)
2. [UX סיטון.docx](/c:/Users/Lenovo/Documents/C-ton/docs/foundation-canonical-2026-04-18/UX סיטון.docx)
3. [סיטון - מפרט מערכת מחייב.docx](/c:/Users/Lenovo/Documents/C-ton/docs/foundation-canonical-2026-04-18/סיטון - מפרט מערכת מחייב.docx)
4. [חוקה וצקליסט לסיטון.docx](/c:/Users/Lenovo/Documents/C-ton/docs/foundation-canonical-2026-04-18/חוקה וצקליסט לסיטון.docx)

## How To Read Conflicts

Use the new canonical set by domain:

- Product scope, business model, user roles, and what exists in the product: the updated product spec and UX are authoritative.
- System invariants, state discipline, idempotency, atomicity, and backend rules: the updated system spec and constitution/checklist are authoritative.
- Older `.docx` and `.md` files in `docs/` may remain useful as historical reference, but they no longer override this canonical set.

If a legacy repository document disagrees with the canonical set, the canonical set wins.

## Material Product Shift Locked In

The updated foundation pack changes the distributor layer in a substantive way:

- Distributors are now a measured distribution channel, not an in-system commission and payout engine.
- The platform no longer treats distributor compensation as a core in-system money rail.
- Commercial settlement between seller and distributor is outside the system unless a future canonical foundation pack explicitly changes that.

This is a real product-direction change, not wording polish.

## Immediate Repository Interpretation

Until the next implementation pass finishes:

- do not treat old affiliate/commission flows as canonical product scope
- do not reopen deprecated commission behavior just because older repo docs mention it
- do treat the updated distributor model as the guiding product truth for future code and UX work

## Follow-Up Items — CLOSED 2026-04-22

All follow-up items identified by the original `2026-04-18` foundation adoption have been resolved by Waves 2, 2.5, 3, and 4:

- ✅ Repository code and DB drift re-mapped against the new canonical pack (see `tests/spec_drift_regression_wave3_validation.ts` — 12/12 source-level regression checks).
- ✅ Repeated purchases by the same buyer in the same deal are fully supported end-to-end; any legacy `(buyer_id, deal_id)` uniqueness assumption was removed.
- ✅ Legacy `commission_rate` and old affiliate payout assumptions have been removed from code/schema: Wave 2.5 migration `020_drop_affiliate_legacy_columns.sql` dropped affiliate economic columns; Wave 4 migration `022_drop_deals_commission_rate.sql` dropped `deals.commission_rate`. Siton fee is the system constant `SITON_PLATFORM_FEE_RATE = 0.08`, fee base includes delivery per spec.
