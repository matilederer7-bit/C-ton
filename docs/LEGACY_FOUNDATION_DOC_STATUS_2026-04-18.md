# Legacy Foundation Document Status

Date: `2026-04-18`

This file is the initial deprecation map for the older repository foundation documents after adoption of the new canonical pack in [CANONICAL_FOUNDATION_SOURCE_OF_TRUTH_2026-04-18.md](/c:/Users/Lenovo/Documents/C-ton/docs/CANONICAL_FOUNDATION_SOURCE_OF_TRUTH_2026-04-18.md).

## Fully Deprecated As Foundation Source

- [סיטון אפיון מוצר מלא.docx](/c:/Users/Lenovo/Documents/C-ton/docs/סיטון אפיון מוצר מלא.docx)
  Replaced by the updated product spec. It still reflects the older affiliate-and-commission product model.

- [חוקה לסיטון.docx](/c:/Users/Lenovo/Documents/C-ton/docs/חוקה לסיטון.docx)
  Replaced by the updated constitution/checklist package for current foundation use.

## Partially Deprecated / Historical Reference Only

- [חוקה לדאטה בייס.docx](/c:/Users/Lenovo/Documents/C-ton/docs/חוקה לדאטה בייס.docx)
  Historical DB reference only. Must not override the new canonical product/system pack.

- [מנגנון אכיפה.docx](/c:/Users/Lenovo/Documents/C-ton/docs/מנגנון אכיפה.docx)
  Historical enforcement reference only. Valid only where it does not contradict the new canonical pack.

- `DB.docx`
  Removed from the repository on `2026-04-21` because it was an outdated DB reference and no longer a safe source of truth.

## Secondary Markdown Documents No Longer Count As Foundation Truth

- [PRODUCT_DIRECTION_ALIGNMENT_2026-04-09.md](/c:/Users/Lenovo/Documents/C-ton/docs/PRODUCT_DIRECTION_ALIGNMENT_2026-04-09.md)
- [STAGE12_LEGACY_DOC_ALIGNMENT.md](/c:/Users/Lenovo/Documents/C-ton/docs/STAGE12_LEGACY_DOC_ALIGNMENT.md)

These can remain as working notes, but they are no longer the final authority over product direction or foundation scope.

## Concrete Drift Already Identified (CLOSED)

> **Update 2026-04-22 (Wave 4):** all three items below have been resolved in the live codebase.

- Old product docs modeled affiliate commissions, payout timing, and internal distributor accounting. **Resolved** — Wave 2.5 migration `020_drop_affiliate_legacy_columns.sql` removed the affiliate economic subsystem from schema/API/UI.
- New product and UX docs move distributors to attribution, link tracking, and aggregate performance only. **In force** — this is the current canonical model.
- Older DB-oriented docs reflected `commission_rate` and one-purchase-per-buyer assumptions. **Resolved** — `deals.commission_rate` is no longer present after Wave 4 migration `022_drop_deals_commission_rate.sql`; Siton fee is a system constant at 8% in `src/platform_fee_money.ts`. Multi-participation per deal per buyer is supported.

## Required Next-Step Use

From this point on:

- use the canonical foundation pack first
- treat the documents above as archival or partial-reference material
- do not justify new implementation decisions from these deprecated documents when they conflict with the canonical pack
