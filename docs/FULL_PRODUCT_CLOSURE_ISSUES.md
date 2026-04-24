# [SUPERSEDED — NOT CANONICAL] FULL PRODUCT CLOSURE ISSUES

> **STATUS: SUPERSEDED 2026-04-22.** Items 2 and 4 below refer to an "affiliate payout model" and a "public marketplace search/catalog" that are **NOT part of the current product**. Wave 2.5 dismantled the affiliate economic subsystem (migration `020_drop_affiliate_legacy_columns.sql`); the canonical 2026-04-18 spec explicitly excludes any public marketplace / catalog / search surface. See [PROJECT_STATUS.md](/c:/Users/Lenovo/Documents/C-ton/PROJECT_STATUS.md) (Wave 4 Final Audit).

## Non-Blocking But Real (historical, mostly superseded)

1. Seller receipts and delivery remain open because no canonical backend entities exist for them yet.
2. Affiliate remains partial because the backend still has no attribution persistence, verification workflow, or payout model.
3. Admin exists now as a real operational read surface, but not yet as a full operations console with onboarding, settlements, support, and forensic tooling.
4. Public marketplace search/catalog was not part of the original current spec. It is now started as product expansion because the user explicitly requested it.

## Fixed In This Pass

1. Seller detail originally queried `payment_attempts.status`, which does not exist. It was corrected to `payment_attempts.result_class`.
2. The product had no real public discovery surface. A public marketplace search/listing layer was added.
3. The product had no real seller/admin UI surface. Working read/write seller flows and working admin read surfaces were added.
