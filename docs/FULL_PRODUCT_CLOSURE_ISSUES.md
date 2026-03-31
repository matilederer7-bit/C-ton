# FULL PRODUCT CLOSURE ISSUES

## Non-Blocking But Real

1. Seller receipts and delivery remain open because no canonical backend entities exist for them yet.
2. Affiliate remains partial because the backend still has no attribution persistence, verification workflow, or payout model.
3. Admin exists now as a real operational read surface, but not yet as a full operations console with onboarding, settlements, support, and forensic tooling.
4. Public marketplace search/catalog was not part of the original current spec. It is now started as product expansion because the user explicitly requested it.

## Fixed In This Pass

1. Seller detail originally queried `payment_attempts.status`, which does not exist. It was corrected to `payment_attempts.result_class`.
2. The product had no real public discovery surface. A public marketplace search/listing layer was added.
3. The product had no real seller/admin UI surface. Working read/write seller flows and working admin read surfaces were added.
