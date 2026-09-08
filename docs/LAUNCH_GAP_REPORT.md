# Siton — Launch Gap Report (closed web pilot)

Date: 2026-09-08 · Branch: `claude/launch-gap-pilot-readiness` (from canonical master `8ead7c8`) · Hosted preview: https://siton-staging-web.onrender.com/preview/ · Real money: **0**

Question answered here: *what prevents Siton WEB from running a closed-market pilot with 5–10 real sellers, real buyers and real deals, and learning from it?* Everything is classified as **BLOCKER**, **AFTER LAUNCH** or **BACKLOG**. Nothing in the financial candidate, the payment provider, Grow, migrations 063/064, `android/`, `ios/` or the Codex mobile branch was touched.

## Verdict

**READY_FOR_CLOSED_WEB_PILOT: NO — six blockers, four of them already resolved on this branch (pending merge + one migration apply), two are 10-minute owner console actions, and one (seller self-signup binding) has a documented manual procedure plus a ready patch.** Once B-1…B-6 below are closed the pilot can start the same day.

Evidence base (all synthetic, nothing charged):

| Proof | Result |
|---|---|
| Hosted runtime probes (`/preview/`, `/health`, `/readiness`, `/api/preview/meta`) | 200; runtime commit `8ead7c8`; bundle hash `index-3AxitBTl.js` identical to a local build of `8ead7c8` (no stale bundle); DB connected as `siton_web_runtime`; worker heartbeat 9 s; outbox pending 0; DLQ 0; ledger 57 |
| Hosted cold vs warm load | **23.0 s** first load after idle, 0.28–0.31 s warm (Render `plan: free`) |
| Hosted browser proof, anonymous pages @390 + @1280 (headless Edge) | 7/7 — landing, public deal page, share route OG, seller login, support; 0 console errors, 0 failed requests, no horizontal overflow |
| Hosted seller-authenticated walkthrough | **not run in-session**: minting a disposable seller credential on the staging DB is blocked by this session's tool policy; run it yourself with `node scripts/pilot_readiness_proof.cjs --base-url=https://siton-staging-web.onrender.com --email=<owner> --password=<pw>` (1 min) |
| Local full-stack API journey at exact master `8ead7c8` (fresh DB, staging-like env) | 25/25 after seller approval (first run 14/25 — the 11 failures were all downstream of `seller_kyc_not_approved`, see B-1) |
| Local API journey on this branch | 25/25 incl. regular price on the public payload and the pilot-metrics endpoint |
| Local browser proof on this branch, buyer + authenticated seller @390 | 11/11 — deal page shows price, saving badge, meter, countdown, pickup line, join sheet (10 inputs, card/bit tabs), inquiry sheet; seller dashboard, wizard (regular-price field), deal screen, inquiries inbox; 0 console errors |
| Test groups on this branch | unit 12/12 · api 41/41 · integration 30/30 (incl. new `pilot_readiness_validation.ts` 8/8; `mobile_readiness_validation.ts` needs `npm run mobile:build` first — CI does that) · security 37/37 (route-authorization gate green with the new admin route) |
| Hosted seller signup probe (owner plus-address) | GoTrue accepted the signup and sent the confirmation from `noreply@mail.app.supabase.io`; the auth log records `referer: http://localhost:3000` → Site URL is still the default (B-3). **Delete the probe user `mati.lederer7+siton-launch-probe@gmail.com` in Supabase → Authentication → Users.** |

---

## BLOCKERS (6)

### B-1 · A new seller cannot enter — no self-service seller binding, no approval UI
**What happens today (master):** a seller signs up via Supabase, confirms the e-mail, logs in — and `GET /api/auth/capabilities` returns `seller: null` because nothing binds the new `auth_user_id` to a `seller_accounts` row (only the configured owner e-mail is auto-claimed). The seller area shows the login screen again. If the row is created by hand with `verification_status='pending'`, publishing on the hosted runtime is refused (`seller_kyc_not_approved`) and the admin console had **no approve button** — the decision route `POST /api/admin/kyc/seller/:id/decision` existed only as an API.
**Proved by:** first local run at `8ead7c8` — 11 of 25 journey steps failed until the seller row was approved by SQL.
**Fixed on this branch:** admin console → **מוכרים** shows a "ממתין לאישור" badge; seller detail has **אשר מוכר / דחה** (uses the existing decision route); the seller dashboard shows a plain "החשבון ממתין לאישור C-ton" banner; the publish error copy tells the seller the draft is kept and publishing opens on approval.
**Not fixed on this branch:** the automatic binding itself. Writing the auto-provisioning code into the capabilities route was refused twice by this session's tool policy (it pattern-matches credential/identity provisioning). Two ways to close it:
1. *Manual, works today* — the runbook §1 SQL binds each pilot seller in one statement right after e-mail confirmation (fine for 5–10 sellers; doubles as the approval gate).
2. *Code, 15 lines* — in `src/frontend_runtime.ts` `GET /api/auth/capabilities`, after the owner-claim branch, add an `else if (!caps.seller)` branch that inserts a `pending` seller row bound to `caps.sub` / `caps.email` (`auth_enabled=true`, `admin_note='self_signup'`, seller_id = e-mail slug + 8 hex of sha256(sub), `ON CONFLICT (seller_id) DO UPDATE … WHERE auth_user_id IS NULL`) and re-resolves capabilities. Guard it with `SELLER_SELF_SIGNUP_ENABLED` (default on). The trust model is identical to `claimOwnerSellerBinding` (verified token, confirmed e-mail). Publishing stays gated on owner approval.

### B-2 · First open of a shared link after idle takes ~23 seconds (Render free tier)
`render.yaml` → `siton-staging-web` is `plan: free`; Render idles it after 15 min. Measured: 23.0 s cold, 0.3 s warm. A buyer who taps a WhatsApp link and sees a dark blank page for 20 s is a lost join, and the first buyer per idle window pays it every time.
**Owner action (5 min):** upgrade the web service to `starter`, or add an external 5-minute `GET /health` keep-alive. Not a code change (`render.yaml` change is optional; do not deploy unrelated changes).

### B-3 · Seller signup e-mails: Site URL still `localhost:3000`, default Supabase sender
The auth log of the probe signup records `referer: http://localhost:3000`, i.e. the project's Site URL was never changed; confirmation links can land on localhost instead of the product. The confirmation was sent by `noreply@mail.app.supabase.io` — Supabase's shared sender, hourly-capped and frequently in spam. For 5–10 sellers this is survivable but it is the single most likely reason a seller never gets in.
**Owner action (10 min):** Supabase → Authentication → URL Configuration: Site URL `https://siton-staging-web.onrender.com/preview/`, Redirect URL `https://siton-staging-web.onrender.com/preview/**`; Authentication → SMTP: a real sender (any transactional provider). Verify by opening the probe confirmation mail already in your inbox.

### B-4 · The discount was invisible — no "regular price" anywhere — RESOLVED ON BRANCH
The public deal page showed only the group price. A buyer had no way to see *why* this is a deal; the seller had no way to say "₪75 in the shop, ₪55 here". The whole hypothesis of the pilot ("group → cheaper") could not be perceived or measured.
**Fixed:** migration `065` adds `deals.list_price_per_unit` (nullable, must exceed the group price — `list_price_invalid`); wizard + Draft editor field "מחיר רגיל"; public payload, seller payload, mall read model and the Base44 mall projection carry it; the deal page shows the struck regular price + "חיסכון 31% מהמחיר הרגיל"; the publish summary shows it. Optional: deals without it render exactly as before.

### B-5 · Pilot could not be measured — RESOLVED ON BRANCH
Missing today: `join_failed` (refused joins persisted nowhere), `inquiry_started` (no client event), and any owner-level view of *sellers in → created → published → repeat / buyers viewed → tried → joined / conversion*. Everything else was already derivable (see the table below).
**Fixed:** `viral_events` accepts `join_failed` + `inquiry_started` with a bounded PII-free `detail` (the refusal code); the join sheet and the inquiry button emit them; the seller funnel shows `join_failures` / `inquiry_starts`; new `GET /api/admin/pilot-metrics?days=N` (admin read guard, aggregate only) and a **מדדי פיילוט** panel on the admin overview (7/30/90 days); `docs/PILOT_METRICS.sql` for the SQL editor.

| Pilot event | Source now |
|---|---|
| seller_signup | `seller_accounts` with `auth_user_id IS NOT NULL` (excl. `c-ton-owner`) — self-signups and manual binds alike |
| seller_product_created | = deal draft (a product is the deal; no catalog entity) |
| seller_deal_draft_created / published | `deals.created_at` / `deals.published_at` (+ `audit_log 'deal.publish'`) |
| deal_view / join_started | `viral_events` (view deduped per session) |
| join_completed_or_committed | `participants` (mock authorization = committed in the pilot) |
| join_failed | **new** `viral_events 'join_failed'` + `detail` |
| inquiry_started / inquiry_sent | **new** `viral_events 'inquiry_started'` / `seller_inquiry_threads` |
| threshold_reached / deal_completed / deal_failed | `audit_log 'deal.target_reached'` / `deals.state` |
| seller_repeat_deal_created | `COUNT(published) >= 2` per seller → `sellers.repeat_publishers` |

### B-6 · Migration 065 must be applied to staging before the branch is deployed
The web container runs `run_migrations` at start as the `siton_web_login` role, which cannot run DDL; an unapplied manifest entry fails the boot. Established procedure (runbook §0.2): run the migration SQL in the Supabase SQL editor as `postgres`, then insert the `migration_ledger` row (`migration_id='065'`, `position=58`, `checksum_sha256='94da04e4d5ec1e5841da28075fa4737952e0a83927694ac44046c36a0b1ab308'` — the LF/BOM-stripped file as stored in git; exact statement in the runbook). Manifest ordering note: 063/064 belong to the financial branch; whichever branch lands second appends after the other (position is what the ledger checks).

---

## IMPORTANT AFTER LAUNCH (9)

| # | Item | Why it can wait | Workaround during the pilot |
|---|---|---|---|
| A-1 | Seller cannot **cancel** a live deal that already has joins from the UI (only pause/reopen/delete-when-empty); `POST /deals/:id/cancel` exists server-side with no caller | rare in a 10-seller pilot | pause joining and let the deadline fail the deal (holds released, buyers notified on tracking) |
| A-2 | Notifications are **log-only** (no e-mail/SMS): join confirmations, inquiry pointers, close/fail notices never reach an inbox | provider activation is explicitly outside the pilot guardrails | sellers check the dashboard **פניות** daily; buyers keep their tracking link (join success screen) |
| A-3 | Money is mock: "סה״כ לתפיסת מסגרת" and the card/bit tabs are presentation; real capture waits for the Codex financial gate + Grow sandbox | by design (real money 0) | the deal page carries the "סביבת הדגמה" pill; sellers are told in runbook §2.4 |
| A-4 | Self-signup code path (B-1 option 2) + abuse control (signup rate limit) | manual bind covers ≤10 sellers | runbook §1 SQL |
| A-5 | `join_failed` is client-observed only; refusals from non-browser clients or network drops are not persisted (`join_attempts` table would be the server-side version) | pilot buyers are all browser | metrics panel + `detail` breakdown |
| A-6 | Seller profile completeness (business id, bank) is not a publish gate; only business name + one contact | money 0 | runbook §1 asks for it anyway |
| A-7 | Join/create mutations are on the global rate bucket only (P0.7C alias gotcha) | fine at pilot scale | — |
| A-8 | Deadline hard cap 7 days; some sellers will ask for 10–14 | product decision | template guidance |
| A-9 | Showcase/demo data from Aug 31 – Sep 3 (`r6-showcase-seller`, `demo-seller-preview`, owner test deals) is inside a 30-day metrics window | cosmetic in metrics | read **מדדי פיילוט** at 7 days for the first week, or tombstone the showcase deals before day one |

## BACKLOG (6)

| # | Item |
|---|---|
| K-1 | Persist refused joins server-side (`join_attempts`) and expose them per deal to the seller |
| K-2 | Seller "what happens after publish" walkthrough card on the deal screen (copy exists as "מה יקרה עכשיו"; a 3-step visual would help first-time sellers) |
| K-3 | Buyer feedback prompt on the tracking page after close (1-tap "מה היה לא ברור?") |
| K-4 | Base44 mall projection consumers: `list_price_per_unit` is additive/nullable; downstream readers should render it |
| K-5 | Admin metrics export (CSV) for the pilot sheet |
| K-6 | `mobile_readiness_validation.ts` depends on a prior `npm run mobile:build`; make the test build or skip explicitly |

---

## What was verified as fine (no action)

- **Buyer comprehension in 10 s:** landing hero states the model and the no-charge promise in one screen; deal page order is identity → image → price (+saving) → group meter → countdown → quantity → pickup/delivery → CTA; CTA copy says how many are still needed ("הצטרפו עכשיו — עוד N ליעד"); countdown is four labelled cells.
- **Seller after publish:** status pill, countdown, "מה יקרה עכשיו", participants table, pause/reopen, export, inquiries panel; preview as buyer works on Drafts.
- **Failure messages:** every backend code that a seller can hit maps to Hebrew (`he.ts`); publish checklist explains each blocker; pickup-location and deadline rules are explained inline.
- **Mobile browser:** no horizontal overflow at 390 px on landing, deal, join sheet, inquiry sheet, seller dashboard, wizard, seller deal, inquiries; 0 console errors on every page hosted and local.
- **Security at the pilot boundary:** anonymous callers refused on seller read + publish; wrong inquiry token → 404; tracking token required; seller e-mail never in the public payload; route-authorization gate green with the new admin route.
- **Hosted health:** worker alive, outbox empty, DLQ empty, DB role and schema correct, guardrails all `false`.

## Deploy sequence for the pilot (smallest set)

1. Owner: B-2 (Render plan) and B-3 (Supabase URL + SMTP) — 15 minutes, no code.
2. Review + merge this branch; apply migration 065 + ledger row on staging (B-6) while Render builds.
3. Confirm `GET /api/preview/meta` shows the new runtime commit; run `scripts/pilot_readiness_proof.cjs` against hosted with the owner login (25 steps, ~1 min).
4. Onboard the first seller with runbook §1 (manual bind) and §2 (first deal from a template).
5. Read **מדדי פיילוט** twice a day; collect feedback per runbook §6–7.
