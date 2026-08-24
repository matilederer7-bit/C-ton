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

## Milestone 3 final surface audit

Status: **GREEN on the repository candidate**, with the final unified suite
still required before the V1.1 freeze.

| Surface | Where am I? | What is happening? | Important status/number | What should I do next? | Why trust C-ton? |
|---|---|---|---|---|---|
| Public Mall | Single public `/app` landing/Mall | Published canonical deals are discoverable; Drafts are absent | type, mapped canonical outcome, price, target progress, remaining units and date | filter/sort, load a bounded next page, or open the canonical Deal | explicit seller, real/placeholder image, honest historical outcomes, no invented availability |
| Public Deal | The same Deal page for direct and Mall traffic | One canonical deal is open, closed, completed or failed | state, target/progress, price, capacity, deadline, fulfilment/type terms | join only when backend truth permits; otherwise inspect the outcome | server-rendered canonical/OG metadata, legal links, gallery and safe state-specific CTA |
| Seller entry/dashboard | Authenticated seller workspace | identity/session and portfolio priorities are visible | current seller, publish readiness, urgent/live/closed counts and state | log in/reauthenticate, complete profile, create, resume or manage | server-owned identity mapping, visible logout, friendly expiry and ownership-hidden IDOR failures |
| Seller Draft/edit/preview | One persisted seller-owned Draft | canonical fields, type terms, delivery and up to five images are being prepared | save state/version, validation summary, primary image and progress | save the same Draft, reorder/delete/retry images, preview, accept terms and publish | no browser seller authority; content signature/size/ownership validation and one buyer renderer for preview |
| Seller live/history | Canonical management/detail for a published or terminal deal | state-specific operations, sharing, fulfilment and evidence are shown | joined/target/max, time/state, document/export availability | share/manage a live deal or inspect/export a completed outcome | no Draft share links, no invented completion, state/money actions remain server-authoritative |
| Buyer join/OTP/payment | Guided join funnel for the selected canonical deal | quantity/delivery, identity proof and authorization handoff progress in order | selected quantity, delivery cost, disclosure/OTP/authorization state | complete the single current step or resume safe non-sensitive context | no raw card capture, transient OTP/payment data, provider result revalidated by server |
| Buyer confirmation/tracking/recovery | Personal post-join command center | authorization, deal progress, fulfilment and bounded recovery truth are explained | participant/deal state, amount, completion window and next action | wait/track, retrieve eligible fulfilment, or retry only inside an open recovery window | no premature “charged/completed” claim; cross-device token/session is scoped and sensitive data is excluded |
| Distributor | Attribution-only workspace | named links, aggregate performance and seller-provided assets are available | clicks, entries, joins, units and attributed gross as measurement only | create/share a verified link or inspect its performance | no buyer PII, balance, wallet, payout or entitlement; Mall source stays separate and commission is 0 |
| Admin | Internal Mission Control/Support/Deal/Participant surfaces | operational priorities, search, KYC/support, audit and system truth remain visible | urgency, exceptions, queue/provider health and canonical profile state | investigate through internal Omnisearch and existing guarded actions | RBAC/session/audit controls remain; public Mall does not broaden admin or money authority |

The real Edge audit completed the full seller-create/publish flow, an attributed
buyer OTP/mock-authorization/confirmation/tracking flow, distributor metrics,
seller closed-state management, admin Omnisearch/Audit/System Status, recovery,
legal pages, missing-data fallbacks, all central desktop routes at 1440px, and
the critical route set at 390px with RTL and no horizontal overflow. The audit
found and closed one V1.1 product defect: server-rendered SEO titles used
`Siton` while the public shell and Open Graph site name use `C-ton`; metadata is
now consistent. Repeated local runs also exposed two harness-isolation issues
(fixed synthetic OTP identities and persisted user-content Unicode); no rate
limit, encoding guard, or product security rule was weakened.

No further route-level screen is justified. V1.1 added only the Mall landing
surface and the persisted Draft edit route. Existing Deal, buyer, seller,
distributor and admin surfaces were deepened and reused rather than duplicated.

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

The checked-in local runtime now server-renders canonical title, description,
canonical URL, robots policy and the safe primary Open Graph image for each
public Deal. Social-crawler preview correctness on the final Base44 bundle and
production domain must still be verified after approved publication/domain
activation. No such external activation is part of this repository task.
