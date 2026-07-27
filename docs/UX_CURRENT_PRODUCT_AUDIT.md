# UX Current Product Audit

Date: 2026-07-27
Branch: `ux-current-product-review`
Scope: current product only; no redesign and no changes to payments, Stripe, Join, OTP, inventory, storage, state machines, migrations, API contracts, permissions, or the 8% fee formula.

## Executive summary

The current Siton frontend is a server-hosted Hebrew RTL single-page application implemented in `frontend/app.js`, `frontend/styles.css`, and `frontend/index.html`; Fastify serves the shell and JSON API from `src/frontend_runtime.ts`. The isolated local preview successfully ran PostgreSQL, 40 canonical migrations, Web, Worker, frontend, local test storage, log-only notifications, and `mockpay`/`mock-backed` payment.

The application is technically usable and unusually broad: buyer, seller, affiliate, admin, legal, support, recovery, and operational surfaces exist and hydrate in a real Edge browser on desktop and mobile. The main UX problem is not missing UI volume; it is discoverability and cognitive load. A first-time reviewer has no single guided role entry, the homepage does not lead to a concrete seeded public deal, and several direct-flow pages require browser-local state from a previous step.

No public preview can currently be claimed. Both documented Render URLs timed out without headers, and this workspace exposes no Render API token, deploy hook, or connected Render deployment capability. The exact owner action is documented below.

## Environment verified

- Local URL during audit: `http://127.0.0.1:3390/app` (not externally shareable).
- Isolated database: local-only `siton_ux_preview`.
- Schema: 40 canonical migrations.
- Runtime separation: Web and Worker ran as separate Node processes.
- Payment: `mockpay`, `mock-backed`; Preview metadata confirms `payment_is_real=false`.
- Notifications: `log-only`.
- Storage: local test storage only.
- Data: synthetic demo records only. No production data was used.
- The canonical base seed is supplemented by the demo-only `bootstrap:ux-review` fixture: ten deterministic synthetic deals cover Draft, open/low participation, near target, target reached, closed, cancelled, limited inventory, multiple delivery options, with image, and without image. Reruns are idempotent and production/mock guards fail closed.

## Project and route map

| Area | Routes / entry points |
|---|---|
| Home and legal | `/app`, `/legal/terms`, `/legal/privacy`, `/legal/refunds`, `/app/accessibility`, `/app/contact` |
| Buyer | `/app/deal/:dealId`, `/app/join/:dealId/otp`, `/app/join/:dealId/payment`, `/app/join/:dealId/confirmation`, `/app/track/:participantId` |
| Seller | `/app/seller`, `/app/seller/new`, `/app/seller/deals/:dealId` |
| Affiliate | `/app/affiliate`, shared deal URL with `?ref=CODE` |
| Admin | `/app/admin`, `/app/admin/support`, `/app/admin/deals/:dealId`, `/app/admin/participants/:participantId`, `/app/admin/users/:buyerId` |
| API boundary | same-origin `/api/*`; no silent client-only fallback was observed in the browser smoke |
| Entry point | Fastify serves `frontend/index.html`; `frontend/app.js` performs routing and API hydration |

## Role access in demo-preview

| Role | Demo identity / entry | Intended capability |
|---|---|---|
| Buyer | Open a public deal link; synthetic buyer identity is created during the join flow | Understand offer, OTP, quantity/delivery, mock authorization, confirmation and tracking |
| Seller | `/app/seller`; demo-preview uses explicit seller context rather than production authentication | Dashboard, create/publish deal, inspect participants and deal progress |
| Affiliate | `/app/affiliate`; canonical fixture code `DEMO01` | Generate/open attributed link and view aggregate attribution only; no buyer PII, commission or balance |
| Admin | `/app/admin`; API remains protected when `ADMIN_API_KEY` is configured | Operational overview, deal/participant/support/audit surfaces and only already-authorized actions |

This is not a production authentication model. The preview metadata explicitly labels seller access as `demo-context` and the environment must remain controlled.

## User journeys reviewed

### Buyer

Public deal → offer/price/delivery/progress → Join → OTP → quantity and delivery → mock authorization disclosure → confirmation → tracking → refresh/reopen. Automated real-browser coverage passed public deal and tracking on desktop/mobile. Direct OTP/payment/confirmation links without saved flow state correctly show recovery guidance, but this creates share/reload fragility.

### Seller

Seller workspace → inspect multiple deals → create deal → validate product/price/units/deadline/delivery/terms → image handling → publish → open public page → inspect live deal and participants. Browser validation covered creation, validation, terms, up to five images, distribution points and hydrated seller surfaces.

### Affiliate

Affiliate overview → campaign/share link → public deal with referral code → attribution metrics. The surface correctly describes attribution-only behavior and does not present commission, payout or buyer personal information.

### Admin

Admin overview → system/deal search → deal/participant/support/audit surfaces. Browser smoke confirms the routes hydrate. External preview setup must supply the admin key through protected configuration and must not expose it to reviewers or frontend code.

## Highest-severity findings

1. **High — no guided demo entry or concrete deal CTA.** The home surface exposes product concepts and internal roles, but an external reviewer is not handed one obvious “start here” public deal. The prominent home CTA can lead toward seller context, which conflicts with buyer expectations.
2. **High — buyer continuation depends on browser-local flow state.** Direct opening, refresh, or device switching on OTP/payment/confirmation can yield recovery screens even when the URL looks valid. The messages are helpful, but users may perceive lost progress.
3. **High — the complete fixture matrix requires an explicit Preview bootstrap.** `bootstrap:ux-review` now supplies the matrix, but `render.yaml` still runs migrations only. A Preview owner must use the documented pre-deploy command or the richer review data will be absent.
4. **High — role discovery is fragmented.** Seller, affiliate and admin routes exist, but there is no preview-only role launcher explaining who the reviewer is, what can be tested, and what is simulated. Reviewers need out-of-band route instructions.
5. **Medium — dense operational copy and tables.** Seller and admin screens expose extensive truth and safeguards, but hierarchy is text-heavy. New reviewers must scan many cards, technical statuses and caveats before identifying the primary action.

## Additional findings

- Mobile layouts remain functional and primary CTAs stay visible, but long seller forms and operational dashboards require substantial vertical scanning.
- Empty/missing data routes have usable recovery copy and do not collapse into blank pages.
- The Preview banner and mock-payment disclosure are strong trust safeguards, though repeated operational caveats add visual weight.
- Admin and internal surfaces contain English operational terms mixed with Hebrew; this is consistent enough for operators but not polished.
- The product deliberately has no marketplace/search/catalog. The UX must therefore provide reviewers with direct links; adding a marketplace would contradict the product contract.

## What works well

- Consistent RTL shell and readable Hebrew on desktop/mobile.
- Clear deal progress and target language.
- Explicit “authorization only / no charge yet” messaging in buyer payment flow.
- Strong validation and recovery states instead of silent failures.
- Seller creation covers terms, delivery variants, images and validation summaries.
- Affiliate surface maintains attribution-only boundaries and explicitly excludes commission.
- Preview metadata truthfully marks all mocked or incomplete commercial integrations.
- Missing routes and missing records render controlled recovery surfaces.

## Screenshot evidence

All screenshots contain synthetic data only and no secrets, OTP values, tokens or real personal information.

| Screen | Role | Purpose | Notes | Severity |
|---|---|---|---|---|
| [Home desktop](ux-current-product-screenshots/home-desktop.png) / [mobile](ux-current-product-screenshots/home-mobile.png) | General | Understand product and choose next action | Rich but entry choice is ambiguous | High |
| [Public deal desktop](ux-current-product-screenshots/deal-desktop.png) / [mobile](ux-current-product-screenshots/deal-mobile.png) | Buyer | Understand offer and join | Strong progress and trust copy | Medium |
| [Near-target fixture](ux-current-product-screenshots/near_target-desktop.png) | Buyer | Judge urgency close to threshold | Synthetic fixture from the full UX matrix | Low |
| [Buyer tracking desktop](ux-current-product-screenshots/tracking-desktop.png) / [mobile](ux-current-product-screenshots/tracking-mobile.png) | Buyer | Understand participation state | Clear next-state explanation | Low |
| [Seller dashboard desktop](ux-current-product-screenshots/seller-desktop.png) / [mobile](ux-current-product-screenshots/seller-mobile.png) | Seller | Manage deals | Dense on small screens | Medium |
| [Create deal desktop](ux-current-product-screenshots/seller_new-desktop.png) / [mobile](ux-current-product-screenshots/seller_new-mobile.png) | Seller | Create/publish | Long but comprehensive form | Medium |
| [Affiliate](ux-current-product-screenshots/affiliate-desktop.png) | Affiliate | Share and inspect attribution | Boundaries are explicit | Low |
| [Admin](ux-current-product-screenshots/admin-desktop.png) | Admin | Operate and investigate | High information density | Medium |
| [Missing deal](ux-current-product-screenshots/error-desktop.png) | Buyer | Recover from bad link | Controlled error instead of blank screen | Low |

OTP, payment and confirmation are covered by the existing browser suite but were not stored as static screenshots in this pass because those pages depend on an active, browser-local flow and the audit must not preserve OTP/proof values.

## Basic accessibility and mobile review

- Semantic headings, labels and actionable controls are present in the tested routes.
- Focus/keyboard behavior is covered by existing frontend foundation tests; no new accessibility claim beyond those gates is made.
- Desktop and 390px mobile DOM/browser smoke passed.
- No clipped primary CTA was detected by the automated smoke.
- Remaining concern: long forms and wide operational tables increase cognitive and scrolling burden on mobile.

## Technical validation

- `npm run test:demo-readiness` — PASS.
- `npm run test:demo-preview` — PASS.
- `npm run test:frontend-browser-smoke` — PASS: desktop, mobile and fallback routes.
- `npx tsc --noEmit` — PASS.
- `git diff --check` — PASS before documentation finalization.
- Local `/health` — `200 {"ok":true}`.
- Local `/api/preview/meta` — demo-preview, mock payment, no real commercial rail.
- No Stripe request or real payment was made.

## External Preview blocker and exact owner action

No deployment credential or connector is available in this session. Both `https://siton-demo-preview.onrender.com` and `https://siton-demo-preview-atp1.onrender.com` timed out without response headers on 2026-07-27. Therefore this report does **not** claim an externally accessible site.

The Render account owner can complete the missing action safely:

1. Open Render and create or restore an isolated Preview PostgreSQL database; do not reuse Production data.
2. Create Web and Background Worker services from branch `ux-current-product-review`, using the repository `Dockerfile`.
3. Web start command: `npm run start:web:prod`; Worker start command: `npm run start:worker:prod`.
4. Web pre-deploy command: `npm run bootstrap:ux-review` (canonical migrations/base seed plus the guarded, idempotent ten-deal UX matrix).
5. Configure both services with the Preview database URL and `APP_DEPLOYMENT_MODE=demo-preview`, `DB_SCHEMA=siton`.
6. Configure payment strictly as `PAYMENT_PROVIDER=mockpay`, `PAYMENT_PROVIDER_MODE=mock-backed`, `PAYMENT_WEBHOOK_PROVIDER=mockpay`. Do not configure Stripe keys.
7. Use `NOTIFICATION_PROVIDER=log-only`, a generated Preview-only `ADMIN_API_KEY`, and a generated Preview-only webhook secret.
8. Web: `RUNTIME_ROLE=web`, `DISABLE_OUTBOX_WORKER=1`; Worker: `RUNTIME_ROLE=worker`.
9. Set `EXPECTED_COMMIT_SHA` to this branch's final commit and deploy only after branch CI is green.
10. Return the generated `https://...onrender.com/app` URL and verify `/health` plus `/api/preview/meta` before sharing it externally.

## Prioritized future upgrade map — do not implement in this task

1. Basic design-system inventory and token consolidation. Risk: medium; frontend CSS only; can run in parallel if no agent edits `frontend/styles.css`.
2. Preview-only role launcher and guided demo entry. Risk: low/medium; frontend plus synthetic fixture links; must never activate in production.
3. Public deal hierarchy and buyer decision information. Risk: medium; frontend only; do not change pricing, inventory or Join APIs.
4. Buyer continuation/recovery across refresh. Risk: high; likely API/session contract implications; must be isolated from current Join/OTP work.
5. OTP and connection presentation. Risk: medium; presentation only; OTP rail is forbidden to change.
6. Seller workspace hierarchy. Risk: medium; frontend only.
7. Deal creation progressive disclosure. Risk: medium; frontend only; preserve validation/API contract.
8. Affiliate role clarity. Risk: low; no commission/payout additions.
9. Admin information architecture. Risk: medium/high; preserve permissions and audit truth.
10. Mobile/accessibility pass. Risk: medium; shared CSS/components.
11. Loading, empty and error-state consistency. Risk: low/medium.
12. Screenshot comparison browser gates. Risk: low; tests/artifacts only.

## Recommended next step

Approve the upgrade map and begin **Design System only** after a live Preview URL has been restored and reviewed. Do not begin broader redesign before that decision.