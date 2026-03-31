# REMAINING PRODUCT SURFACES ISSUES

## Non-Blocking

1. External receipt issuance is still inactive.
   The seller receipts surface is internally ready and contractually correct, but no external accounting / invoice transport was activated in this pass.

2. Delivery is internally modeled, not carrier-integrated.
   Seller delivery states and tracking numbers are now persisted, but no real shipping provider or label workflow is connected yet.

3. Affiliate payouts are internally modeled, not externally executed.
   Attribution, verification, payout profile, and admin approval now exist in-product, but no bank / payout rail has been activated.

4. Admin KYC is internally modeled, not provider-backed.
   Queue, decisions, and semantics are present, but no external KYC document provider is connected.

5. Push was not performed.
   No `git remote` is configured in this repository, so this pass was committed locally only.
