# Siton — Launch Polish Sprint 2: buyer conversion, trust, feedback, share loop

Date: 2026-09-08 · Branch: `claude/launch-polish-buyer-conversion` (from exact master `eb89fae`) · Hosted target: https://siton-staging-web.onrender.com/preview/ · Real money: **0**

Goal of the sprint (not a hardening pass, not a backend project): a brand-new buyer arriving from a WhatsApp link must understand within ten seconds what Siton is, why the price is lower, what they are buying, what they save, how many units are still needed, when it ends, what happens if the target is missed, and what to press — then join with the least friction that keeps legal acceptance intact, know exactly what happened afterwards, share naturally, and tell us what was unclear. Boundaries respected: no payment provider / Grow / capture-refund-recovery / reconciliation code, no financial candidate branch, **no migration** (063/064 untouched; the feedback rail reuses the existing operational-cases table), no external e-mail/SMS provider, no Android/iOS, no Codex mobile branch, no merge to master.

## Audit before the changes (390 px, hosted-equivalent local runtime)

| Question | Before | After |
|---|---|---|
| WHAT is Siton? | Only the topbar tagline; nothing on the deal page | One-line explainer under the title: "קנייה קבוצתית: המחיר הקבוצתי תקף רק אם מספיק אנשים מצטרפים עד מועד הסיום. לא הגיעו ליעד — אף אחד לא משלם." |
| WHY is the price lower? | Not said | "המחיר נמוך כי קונים ביחד — המוכר מוכר בכמות, ואתם משלמים פחות." under the price |
| WHAT am I buying? | Title + image + short description | unchanged |
| Normal vs group price, saving | Strike-through number with no label + "% saving" badge | "מחיר רגיל ₪65" labelled, "חיסכון 31%", **"חוסכים ₪20 ליחידה"** |
| HOW MANY still needed? | Meter footer only | Three fact tiles: יחידות ביעד / כבר הצטרפו / **עוד חסרות** (+ participants and remaining stock line) |
| WHEN does it end? | Countdown only | Countdown + **absolute Israel-time deadline** ("עד יום חמישי, 10 בספטמבר בשעה 22:46 (שעון ישראל)") |
| What if the target is missed? | Buried in the order note | Explainer line + 3-step "איך זה עובד?" strip right under the CTA, step 3 = "לא הגיעו ליעד? … אף אחד לא משלם" |
| WHAT do I press? | CTA one screen below the fold | Same CTA + a slim **sticky phone bar** (price + "הצטרפו — עוד N ליעד") shown only while the real CTA is off-screen, hidden on desktop and whenever a sheet is open |

## What changed

| # | Area | Change | Where |
|---|---|---|---|
| P1 | Ten-second comprehension | Explainer + why line + labelled regular price + saving amount + needed tiles + absolute deadline + how-it-works strip + sticky phone CTA (IntersectionObserver on the real CTA; same `join_started` funnel event). Copy lives in one module. | `web/src/pages/deal.tsx`, `web/src/buyerCopy.ts`, `web/src/styles.css` |
| P2 | Trust surface | The public projection carries `seller.approved` — a boolean derived from the operator's KYC decision (`verification_status = 'approved'`), never the raw status, date or reviewer. Badge "✓ מוכר מאושר" next to the business name (top + seller panel). Privacy line for inquiries, pilot mock-money disclosure ("פיילוט: בשלב זה לא מתבצע חיוב אמיתי ולא נדרש להזין כרטיס") on the deal, in the sheet, on success and on tracking. No ratings, reviews, guarantees, insurance, refund or payment promises anywhere (pinned by test). | `src/frontend_runtime.ts` (`buildPublicDealPayload`), `web/src/pages/deal.tsx` |
| P3 | Join flow friction | "מה קורה באישור?" box before the fields; `*` required markers + legend; per-field Hebrew errors under the field (name, plausible Israeli phone, e-mail format, address for delivery, both consents) with a summary in the footer and scroll-to-first-error; name/phone/e-mail remembered on the buyer's own device (`siton_buyer_identity_v1`) so a refused join or a reload costs no retype; every server refusal answered in Hebrew with a **what-next** (stock → change quantity, state → refresh status, network → try again, other → support) and the form is never reset; the demo payment slots carry the pilot line. Legal + disclosure acceptance, the payment-method preference and the join payload are unchanged. | `web/src/pages/deal.tsx` (`JoinModal`), `web/src/he.ts` (codes `joining_paused_by_admin`, `delivery_address_required`, `invalid_delivery_option`, `payment_disclosure_required`, `payment_authorization_required`, `delivery_notes_too_long`; patterns for the code-less 409 / inventory / missing buyer id; status 423) |
| P4 | Success / tracking | Success moment in decision order: joined facts (units, total, "לא בוצע חיוב", pilot line) → progress **including this join** (one authoritative activity read) → tracking link first + copy → honest notification line → share loop → feedback → ask the seller. Tracking page gains "מה עוד צריך לקרות?" (units to target, deadline in Israel time, what happens either way), copy-link, back-to-deal, "שאלה למוכר" with the privacy line, share loop, feedback, and load failures with a way out (invalid link / gone / network / busy). The notification sentence is read from the runtime (`preview.guardrails.notifications_are_real`): while external delivery is off it says so and tells the buyer to keep the link. | `web/src/pages/deal.tsx` (`JoinSuccess`), `web/src/pages/track.tsx`, `web/src/buyerCopy.ts` |
| P5 | Share loop | `ShareActions layout="loop"`: a labelled WhatsApp lead button, native share + exactly ONE copy control, the rest as icons; the message carries the group price and the rule ("העסקה יוצאת לפועל רק אם מספיק אנשים מצטרפים"), the URL stays the canonical `/d/:id?ref=<personal code>`; every click is a `share_button_click` funnel event. Headline "עזרו לעסקה להצליח — שתפו עם עוד אנשים". No forced share, no repeat prompts. | `web/src/components.tsx` |
| P6 | Buyer feedback | One question "היה משהו שלא היה ברור?" (success + tracking), six fixed answers + "הכול היה ברור", optional 280-char text, once per deal per browser. `POST /api/deals/:id/feedback` (public class, outside every protected namespace) stores it on the **existing operational-cases rail** as Closed / Low / Buyer / `opened_by = buyer_feedback` with the deal and seller ids — no name, phone, e-mail, participant id or buyer ref are accepted or stored; honeypot; 60/deal/h + 200/h caps; unpublished deals 404. `GET /api/admin/pilot-metrics` adds `feedback` (total, by category, last texts) and the admin overview shows "משוב קונים". `PILOT_METRICS.sql` + runbook §7 updated. | `src/frontend_runtime.ts`, `web/src/feedback.tsx`, `web/src/pages/admin.tsx`, `docs/PILOT_METRICS.sql`, `docs/PILOT_LAUNCH_RUNBOOK.md` |
| P7 | Inquiry discoverability | "שאלה למוכר" at the top of the deal page, under the CTA, on every closed state, on the success moment and on the tracking page (`#/deal/:id?inquiry=1` opens the sheet directly). Copy says the inquiry goes through Siton and no contact details are exposed. A stale stored thread token is forgotten and explained instead of failing silently. | `web/src/pages/deal.tsx`, `web/src/pages/track.tsx`, `web/src/App.tsx` |
| P8 | Failure / empty states | `closedStory()` derives WHAT happened / CAN I do anything / WHAT next from canonical state + deadline: sold out, **expired while open = "ממתינים להכרעה"**, **seller pause = "ההצטרפות מושהית זמנית"** (deadline still ahead), closing, completion window, completed, failed (target missed vs charges), cancelled. Load failures: network (retry), busy 429/5xx (retry), gone (support). Tracking: invalid link / gone / network / busy. Join refusals as in P3. No technical code is rendered as copy (pinned). | `web/src/pages/deal.tsx`, `web/src/pages/track.tsx` |
| P9 | Landing | Hero sentence names both sides ("C-ton (סיטון) היא פלטפורמה לקנייה קבוצתית: …"); buyer entry box ("קונים? ככה מצטרפים", link-based, no account; "לעסקאות הפתוחות" → `#/deals` only while the Mall is enabled); pilot disclosure "פיילוט סגור — בשלב זה לא מתבצעים חיובים אמיתיים"; seller CTAs unchanged; zero legacy references (existing gate). | `web/src/pages/landing.tsx`, `web/src/content/landing.he.ts`, `web/src/App.tsx` |

Bundle: JS 449.21 → 474.70 kB (gzip 133.27 → 141.08), CSS 63.92 → 69.90 kB; no new dependency.

## Analytics (existing rail only)

`deal_view` · `join_started` (CTA and sticky bar) · `join_failed` (refusal code/status only) · `share_button_click` (channel) · `inquiry_started` (top / CTA / closed state / tracking link) — all on `viral_events`; joins committed = `participants`; inquiries sent = `seller_inquiry_threads`; buyer feedback aggregated from `operational_cases` in `GET /api/admin/pilot-metrics`. No new event type, no new analytics backend.

## Proofs

| Proof | Result |
|---|---|
| `scripts/buyer_polish_browser_proof.cjs` — headless Edge CDP @390×844, @430×932, @1280×900 against a local demo-preview runtime (+ a second runtime with `PUBLIC_MALL_ENABLED=1` for the Mall) | **35/35** — per width: landing (sentence, buyer entry, seller CTAs, pilot note), public deal (all ten-second facts, decision order, approved badge, ask-seller entries, sticky bar only on phones and only while the CTA is off-screen), join sheet (what-next, 5+ required markers, 4 field errors + summary on empty submit, phone rule), join → success (facts, progress incl. this join, tracking first + copy, honest notification line, WhatsApp lead with `/d/:id?ref=`, one copy control, feedback → stored Closed/Low/PII-free), tracking (next steps, deadline, copy, back, ask-seller `?inquiry=1`, share loop, feedback once), inquiry round trip (auto-opened sheet → sent → "הפניות שלי" → seller reply via API → buyer sees it → follow-up), seller login entry, Mall (cards with regular price + needed + countdown); @390: five failure states (sold out, paused, failed, completed, expired-while-open), join refused mid-sheet (pause → Hebrew + refresh, typed data kept, `join_failed` recorded PII-free), invalid tracking link, stale inquiry token, network failure; **0 console errors, 0 failed essential requests, no horizontal overflow, no text under 10 px on 29 page checks** |
| `tests/buyer_feedback_support_operations_validation.ts` (api group) | **9/9** — stored shape; hostile PII ignored; all-clear answer; refusals (category, length, uuid, draft 404, honeypot); never in the open support queue, visible as closed; per-deal cap 429 without a row and other deals unaffected; admin aggregate (anonymous refused, no PII); `seller.approved` boolean only (pending → false, no raw status); tracking contract |
| `tests/frontend_foundation_buyer_polish_validation.ts` (unit group) | **14/14** — source pins for every rule above (canonical fields only, no invented trust claims, required markers + field errors + phone rule + data kept on refusal + legal acceptance unchanged, refusal Hebrew for every server code, success order, runtime-derived notification line, tracking links, share loop invariants, feedback PII-free/no migration, closed stories, landing, existing funnel rail) |
| Existing pinned suites | `frontend_foundation_countdown_pickup_validation` 12/12 · `frontend_foundation_polling_validation` 10/10 · `frontend_foundation_react_legacy_route_validation` 6/6 · `p07_seller_inquiries_pickup_validation` 14/14 · `p07b_seller_draft_preview_validation` 7/7 · `pilot_readiness_validation` 10/10 · `base44_mall_contract_validation` PASS |
| Static gates | TypeScript (web + backend) clean · lint/backend enforcement PASS · payment compliance PASS · runtime DDL scan PASS (62 files) · architecture gate PASS |
| Test groups | unit **14/14** · api **43/43** · security **38/38** · integration **30/30** (after `npm run mobile:build`) — 125 files, 0 failures, one runner at a time, fresh migrated database per file |

## Negative controls (exact)

1. feedback with name/phone/e-mail/participant id in the body → 201, none of it stored, none of it in the aggregate
2. feedback on a draft (unpublished) deal → 404 `feedback_deal_unavailable`; unknown category → 400; 281 chars → 400; honeypot → 200 and no row
3. 61st feedback for one deal within the hour → 429 `feedback_rate_limited`, no row; another deal still accepts
4. anonymous `GET /api/admin/pilot-metrics` → refused; the feedback route itself lives outside every protected namespace (route-authorization gate classifies it `public`)
5. the public projection never carries `verification_status`, only `approved: true|false`
6. a join refused because the seller paused → Hebrew sentence + "רענון הסטטוס", typed data kept, `join_failed` detail is the code/status only
7. a stale inquiry token (401/403/404) → forgotten from the browser and explained; the deal page never shows a silent hole
8. the sticky CTA never renders on a closed deal, on desktop, in seller preview, or while a sheet is open

## Open / deliberately not done

- `Cancelled` is unreachable publicly (cancel exists from Draft only, and a Draft is never published) — the story exists for completeness.
- Buyer e-mail stays optional in the join sheet (used by the invoice rail later); no notification is promised for it.
- The proof runtimes need raised per-IP budgets (`RATE_LIMIT_MAX=10000 RATE_LIMIT_READ_MAX=5000 RATE_LIMIT_SENSITIVE_MAX=500`) because three simulated devices from one IP trip the product's limiter — the limiter is a feature, and the buyer now gets a "עומס רגעי — נסו שוב" state with a retry instead of a generic sentence when it fires.
- Real notifications (e-mail/SMS), a public deal list on the landing while the Mall is hidden, and any payment-flow change remain out of scope.

## Next step

Independent quick review → merge → deploy → read "משוב קונים" and `view_to_join_pct` daily. Highest-value next improvement: real buyer/seller e-mail notifications (A-2) so the honest "no e-mail in the pilot" line can be retired and buyers no longer depend on keeping the tracking link.
