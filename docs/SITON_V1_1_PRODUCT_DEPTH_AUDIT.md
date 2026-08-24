# Siton V1.1 — Product Depth Audit

Status: evidence-first implementation matrix, 2026-08-23.

The current repository frontend was exercised in real Microsoft Edge before
implementation. Its baseline browser smoke passed on desktop and 390px mobile,
including a seller-created Draft with two images. The owner's observed raw
Axios-style 401 and absent image control do not originate from this checked-in
frontend: it uses `fetch`, contains the image picker, and contains none of the
reported Axios text. The observation is therefore consistent with a stale or
separate Base44 browser bundle. The repository still has a real architectural
gap: it did not contain a Base44 identity-to-`SellerAccount` bootstrap, and its
portable session flow did not deliberately recover a draft after expiry.

| Surface | Purpose | Evidence before V1.1 | V1.1 action |
|---|---|---|---|
| Public `/app` | Discovery and value proposition | Branded but static and direct-link-only | Replace with the canonical Mall, real cards, bounded filters, ordering, pagination, history, and honest empty/error/loading states |
| Public deal | One canonical buyer detail | Strong join/progress/gallery surface | Reuse for Mall and direct traffic; enrich type/outcome metadata; never expose Draft anonymously |
| Buyer OTP/payment/confirmation | Safe join funnel | Already deep and server-authoritative | Preserve; add Mall source without changing attribution or money |
| Buyer tracking/recovery | Explain current truth and next action | Functional, with richer helpers available | Reuse existing richer status/fulfilment/document copy; no duplicate screen |
| Seller entry | Establish owner authority | Custom pre-provisioned session; stale expiry handling | Add canonical Base44 identity bootstrap plus friendly signed-out/expired/forbidden states and safe return |
| Seller dashboard | Priorities and portfolio | Strong cards, but profile/analytics helpers underused | Reuse existing profile and analytics sections; keep state-first hierarchy |
| Create/edit Draft | Create a credible deal | Create form and image picker exist; no persisted Draft editor | Draft-first persistence, owner-bound edit route, recoverable context, all canonical types |
| Images | Product credibility | Up to five, previews, primary/delete and native camera already exist | Make the area prominent; add drag/drop, persisted ordering/primary, retry/loading and deliberate placeholder |
| Seller preview/live/closed | See buyer view and operate lifecycle | Existing canonical preview and detail | Reuse same presentation; correct state-specific headers and expose existing useful exports/fulfilment information |
| Distributor | Attribution and assets | Named links, performance and image assets | Add type/image consistency only; Mall organic traffic remains separate |
| Admin | Operations and control | Already deep | Preserve; clarify that admin Omnisearch is not the public Mall |

Only two new route-level surfaces are justified:

- `/app` becomes the single Mall/landing experience; and
- `/app/seller/deals/:dealId/edit` reuses the create renderer for a persisted,
  seller-owned Draft.

Filters remain tabs/controls inside the Mall. Existing public-deal, buyer,
seller, distributor, and admin routes remain the source of their respective
business logic.

## Browser proof target

Final browser evidence must include multiple synthetic deal types and outcomes,
visible filtering and ordering, Mall-to-canonical-detail navigation, signed-out
seller entry, authentication and safe return, Draft creation, image previews,
session expiry/reauthentication, owner isolation, no raw HTTP/SDK error, and no
horizontal overflow on desktop, 390px, common iPhone, and common Android widths.

## Honest external limitation

Client-side metadata can improve document titles and in-app canonical/Open
Graph tags but is not server-side rendering. Social-crawler preview correctness
on the final domain must be verified after approved Base44 publication/domain
activation. No such external activation is part of this repository task.
