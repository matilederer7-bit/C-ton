# Seller Distribution Hub — attribution + analytics only (2026-09-17)

Status: implemented (owner task 2026-09-17). Companion to
`docs/CANONICAL_PRODUCT_POLICY_AMENDMENT_2026-09-16.md` §4.

## What it is

A seller can mint several **distribution links** for the same deal (WhatsApp
group A, Facebook campaign, newsletter, an external person who spreads the
deal, a paid campaign …) and measure each one separately. The module is
**attribution + analytics only**:

- Siton computes no commission, sets no commission, creates no entitlement,
  holds no balance, pays nobody, manages no payout, issues no invoice to a link
  holder. Any arrangement between a seller and a link holder is a private,
  external agreement.
- Siton's own platform fee (8% of everything collected from the customer,
  excluding VAT) is untouched by this module.
- The module never changes `DealState`, `BuyerState`, `MoneyState`, payments
  or transitions.

## Reused rails (no parallel system)

| Concern | Canonical rail |
| --- | --- |
| Link | `siton.affiliate_links` with `origin_type='seller'`, `affiliate_id NULL`; owned through the deal's `seller_id`. New optional `channel` column (migration 070). |
| Entry / unique visitor | `siton.affiliate_link_events` (`entry` events; PII-free). New optional opaque `visitor_id` (migration 070). |
| Join attribution | `siton.viral_attributions.parent_link_id`, resolved inside the Join transaction by `viral_graph.recordViralJoinAttribution` (existing last-touch resolution). |
| Final charge / gross | `participants.money_state IN ('ChargedSuccess','RecoveredCharge')` and `platform_fee_money_events` (`logical_entry_type='charge'`) gross actually collected — the same source seller analytics uses. |
| Browser capture | `web/src/viral.ts`: `?ref=` captured once at boot into localStorage (bounded history, 90 days), sent with the Join payload; the resume context keeps `attribution_ref` server-side. |

## Attribution rule (single, documented)

**Last Eligible Distribution Link before Join.**

A Join is attributed to the last distribution link the buyer entered through
before joining, provided the link belongs to the same deal and was active (not
disabled) at Join time. The browser keeps the last touched code across
navigation, OTP, login, checkout and refresh; the server resolves it
authoritatively at Join. There is no multi-touch model. A disabled, foreign or
unknown code degrades to an unattributed Join — never to an error.

Per link the seller can answer: which link a Join came from, how many units
were attributed, whether those units were finally charged, and the gross
actually collected from them.

## Metrics

| Metric | Definition |
| --- | --- |
| Entries | `entry` events on the link (one per browser session; a refresh replays the same entry id and is deduplicated) |
| Unique visitors | `COUNT(DISTINCT visitor_id)` over entries (opaque anonymous browser id) |
| Joins / joined units | attributed participants (`buyer_state <> 'NotJoined'`) and their `qty` — a **commitment**, never shown as a sale |
| Final charged units | attributed participants in `ChargedSuccess` / `RecoveredCharge` |
| Attributed gross | sum of `platform_fee_money_events.gross_amount` (charge entries) for those participants; when no money event exists yet, `qty × price + delivery` |
| Conversion | joins ÷ entries; charged buyers ÷ entries (4-decimal ratios) |
| Time series | hourly buckets for 24h, daily for 7d / 30d / all (capped at 400 points) |

## Surfaces

Seller (`/api/seller/...`, seller capability, ownership by `deals.seller_id`,
mismatch = 404):

- `GET  /api/seller/deals/:dealId/distribution` — links + all-time metrics + totals
- `POST /api/seller/deals/:dealId/distribution/links` — create (`internal_name`, `channel?`); only for a published deal open for joining
- `PATCH /api/seller/deals/:dealId/distribution/links/:linkId` — rename, channel, `status` active/disabled (disabling keeps history)
- `GET  /api/seller/deals/:dealId/distribution/links/:linkId?range=24h|7d|30d|all` — per-link dashboard (totals, windowed totals, series)
- `POST /api/seller/deals/:dealId/distribution/links/:linkId/external-access` — `enable` / `disable` / `reset_password`

External link viewer (`/api/link-viewer/...`, HttpOnly cookie session):

- `POST /api/link-viewer/session/login` (`username`, `password`; rate limited per address and per username, unknown user and wrong password answer identically)
- `GET  /api/link-viewer/session`, `POST /api/link-viewer/session/logout`
- `GET  /api/link-viewer/dashboard?range=&link=` — aggregates of the granted link only. `link` is a selector among the viewer's own grants; any other id is 403. Authorization is enforced in the backend; no PII is ever selected for this account.

Web: the seller deal screen embeds the distribution panel; per-link dashboard
at `#/seller/deal/:dealId/distribution/:linkId`; external dashboard at
`/preview/#/link-dashboard` (no seller navigation).

## External access model

- Default: disabled. Enabling creates a `distribution_link_viewers` identity
  (generated username, generated password shown once, scrypt hash stored) and
  a `distribution_link_viewer_grants` row for that link. Identity and grants
  are separate tables so one identity may be granted several links later.
- Disabling revokes the grant, disables the identity and revokes all sessions;
  the link and its analytics are untouched. Re-enabling mints a fresh identity.
- Password reset stores a new hash and revokes all sessions.
- Session secret: `LINK_VIEWER_SESSION_SECRET` (falls back to
  `BUYER_SESSION_SECRET` / `OTP_TOKEN_SECRET`; a local-only constant outside
  production-like environments).

This is **not** a distributor role in the sense of the 2026-09-16 amendment:
no economics, no seller relationship surface, no participant data, no admin,
no other deals — a scoped read-only analytics credential requested by the
owner on 2026-09-17. The amendment's wording ("no distributor login/dashboard")
should be updated by the owner to name this scoped viewer explicitly.

## Buyer experience

Identical for the main deal URL and every distribution link: same page, same
price, same UI, no banner, no distributor/source/referral/affiliate wording.
Tracking only, behind the scenes.

## Proofs

- `tests/seller_distribution_hub_validation.ts` — links, visits, attribution, replay, disable, final charge + gross, series, seller isolation, external access lifecycle, PII isolation, rate limit.
- `tests/distribution_otp_join_attribution_validation.ts` — OTP-required Join keeps attribution (request → verify → resume → Join).
- `tests/link_viewer_authority_validation.ts` — internal-runtime: the viewer credential is refused on every seller/admin/affiliate/distributor route; A1 never reads A2; revocation kills sessions.
- `tests/frontend_foundation_distribution_hub_validation.ts` — browser wiring contract.
- Route gates: `/api/link-viewer/` is a protected namespace in `scripts/protected_route_policy.cjs`; `requireLinkViewer(` is a recognised refusing guard.
