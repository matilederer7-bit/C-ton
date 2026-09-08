# Siton — Launch Gap Report (closed web pilot)

Date: 2026-09-08 · Branch: `claude/launch-gap-pilot-readiness` (from canonical master `8ead7c8`) · Hosted preview: https://siton-staging-web.onrender.com/preview/ · Real money: **0**

Question answered here: *what prevents Siton WEB from running a closed-market pilot with 5–10 real sellers, real buyers and real deals, and learning from it?* Everything is classified as **BLOCKER**, **AFTER LAUNCH** or **BACKLOG**. Nothing in the financial candidate, the payment provider, Grow, migrations 063/064, `android/`, `ios/` or the Codex mobile branch was touched.

## Verdict

**Closeout 2026-09-08 (second pass): READY_FOR_CLOSED_WEB_PILOT: YES once this branch is merged and deployed, with two owner console actions (B-2 Render plan, B-3 Supabase Site URL) that do not block onboarding seller #1.** Status per blocker: B-1 closed for the pilot by the verified 3-minute manual binding procedure (auto-binding stays after-launch); B-2 owner action (Render MCP not authorized in-session); B-3 Site URL owner action, SMTP delivery **proven** (the probe confirmation was completed from the owner's inbox) and moved after-launch; B-4 + B-5 resolved on the branch; B-6 **applied on staging** (ledger position 58, rerun idempotent, master runtime healthy afterwards); A-10 root redirect fixed on the branch with a regression test. Hosted seller journey 23/23 and hosted browser pass 11/11 ran against staging with a disposable seller (now retired).

Evidence base (all synthetic, nothing charged):

| Proof | Result |
|---|---|
| Hosted runtime probes (`/preview/`, `/health`, `/readiness`, `/api/preview/meta`) | 200; runtime commit `8ead7c8`; bundle hash `index-3AxitBTl.js` identical to a local build of `8ead7c8` (no stale bundle); DB connected as `siton_web_runtime`; worker heartbeat 9 s; outbox pending 0; DLQ 0; ledger 57 |
| Hosted cold vs warm load | **23.0 s** first load after idle, 0.28–0.31 s warm (Render `plan: free`) |
| Hosted browser proof, anonymous pages @390 + @1280 (headless Edge) | 7/7 — landing, public deal page, share route OG, seller login, support; 0 console errors, 0 failed requests, no horizontal overflow |
| Hosted seller-authenticated walkthrough (closeout pass) | **23/23** on staging with a disposable seller row (`pilot-proof-seller-…`, login retired afterwards): login → context → profile → draft → edit → image → preview → publish → public payload → `/d/:id` → funnel events → refused join (400) → 1 mock join (money 0) → tracking → seller view → analytics → inquiry → follow-up → seller reply → pause → isolation. Proof deal `c914b56b…` "[פיילוט 55b78f]" left paused with 1 synthetic participant; it fails at its deadline (3 days) by itself |
| Hosted browser proof with the seller session @390 | **11/11**: live open deal page (CTA "הצטרפו עכשיו — עוד 4 ליעד"), join sheet (10 inputs, card/bit tabs), inquiry sheet, seller dashboard, wizard, seller deal screen, inquiries inbox — 0 console errors, no overflow |
| Manual seller binding (B-1 procedure) | executed on staging against the owner's confirmed probe identity → seller row `pilot-rehearsal-owner-alias` (pending) resolves by `auth_user_id`; kept as the owner's rehearsal account |
| Bug found by the hosted pass — **pause after reopen was a silent no-op** | `POST /deals/:id/close_joining` defaulted its idempotency key to `close:<dealId>`, so a header-less second pause (the React client sent none) replayed the first pause's stored 200 and left the deal open. Fixed on the branch: server default key is per-call (like reopen), the client sends a fresh key per pause/reopen, regression in `pilot_readiness_validation.ts` (pause → reopen → pause acts; an explicit repeated key still replays). Consequence on staging: the proof deal `c914b56b…` could not be re-paused after the UI pass (the disposable login was already retired and re-enabling it was refused by the session policy) — it stays **open with one synthetic participant until its deadline (2026-09-11 07:07 UTC) fails it**; it is not listed anywhere (mall off) and is only reachable by its link |
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
**Closeout status: CLOSED FOR THE PILOT via the manual procedure** (runbook §1, three steps, ~3 minutes per seller, executed once on staging). The automatic binding itself is deliberately after-launch (A-4): writing the auto-provisioning code into the capabilities route was refused twice by this session's tool policy (it pattern-matches credential/identity provisioning). Two ways to close it:
1. *Manual, works today* — the runbook §1 SQL binds each pilot seller in one statement right after e-mail confirmation (fine for 5–10 sellers; doubles as the approval gate).
2. *Code, 15 lines* — in `src/frontend_runtime.ts` `GET /api/auth/capabilities`, after the owner-claim branch, add an `else if (!caps.seller)` branch that inserts a `pending` seller row bound to `caps.sub` / `caps.email` (`auth_enabled=true`, `admin_note='self_signup'`, seller_id = e-mail slug + 8 hex of sha256(sub), `ON CONFLICT (seller_id) DO UPDATE … WHERE auth_user_id IS NULL`) and re-resolves capabilities. Guard it with `SELLER_SELF_SIGNUP_ENABLED` (default on). The trust model is identical to `claimOwnerSellerBinding` (verified token, confirmed e-mail). Publishing stays gated on owner approval.

**Launch polish sprint 1 (2026-09-08, branch `claude/launch-polish-seller-ops`): option 2 IMPLEMENTED — B-1 / A-4 CLOSED IN CODE.** `claimSelfServiceSellerBinding` in `src/frontend_runtime.ts` binds a verified, non-anonymous Supabase identity with a confirmed e-mail claim to a PENDING seller row (`ON CONFLICT DO NOTHING` across the primary key and both unique indexes — an existing row or `auth_user_id` is never touched; deterministic id `s-<e-mail slug>-<8 hex of sha256(sub)>`; audited as `seller.self_signup.bound` in `seller_security_events`; platform-wide cap `SELLER_SELF_SIGNUP_HOURLY_CAP`=20/h counted from that audit rail; `SELLER_SELF_SIGNUP_ENABLED=0` switches it off). The Supabase seller context now reads the real `verification_status` (it was hard-coded `approved`, so a pending seller never saw the pending banner). Proof: `tests/seller_self_binding_security_validation.ts` 18/18 against real ES256 tokens + a JWKS served over HTTP, under the hosted runtime shape (`APP_DEPLOYMENT_MODE=staging`, `APP_ENV=production` → publish approval gate active): anonymous/invalid/expired/rogue-key/anon-role/anonymous-sign-in refused with no row; first login binds one pending row without any credential; second login idempotent; two concurrent first logins → one row; already-bound untouched; e-mail collision never claims; seller-id collision never overwrites; pending can draft, cannot publish (`seller_kyc_not_approved`, draft kept); seller cannot self-approve / approve another / read admin; admin approval opens publishing; rejection closes it; seller A cannot cancel seller B's deal; the cap throttles. The runbook §1 SQL remains the fallback for a refused binding.

### B-2 · First open of a shared link after idle takes ~23 seconds (Render free tier)
`render.yaml` → `siton-staging-web` is `plan: free`; Render idles it after 15 min. Measured: 23.0 s cold, 0.3 s warm. A buyer who taps a WhatsApp link and sees a dark blank page for 20 s is a lost join, and the first buyer per idle window pays it every time.
**Closeout status: OWNER_ACTION_REQUIRED.** The Render MCP server is not authorized in this session, so the plan could not be inspected or changed here. CURRENT_PLAN `free` (from `render.yaml` and the measured idle behaviour) · REQUIRED_PLAN `starter` (same tier as the worker, US$7/mo) · EXACT ACTION: Render dashboard → siton-staging-web → Settings → Instance Type → Starter → Save; verify a cold open < 2 s after 20 idle minutes. A keep-alive ping is not the pilot fix, only a stop-gap. `render.yaml` is intentionally unchanged so a merge never changes billing silently; flip `plan: free` → `plan: starter` in the same commit as the dashboard change if you want the Blueprint to match.

### B-3 · Seller signup e-mails: Site URL still `localhost:3000`, default Supabase sender
The auth log of the probe signup records `referer: http://localhost:3000`, i.e. the project's Site URL was never changed; confirmation links can land on localhost instead of the product. The confirmation was sent by `noreply@mail.app.supabase.io` — Supabase's shared sender, hourly-capped and frequently in spam. For 5–10 sellers this is survivable but it is the single most likely reason a seller never gets in.
**Closeout status: Site URL = OWNER_ACTION_REQUIRED (no Supabase API/MCP surface for auth config); SMTP = PASS for the closed pilot, custom sender after launch (A-11).** Evidence: the probe account was **confirmed from the owner's Gmail inbox** (auth.users `email_confirmed_at` set) — the default sender delivered and the link worked; the only residual is the post-confirmation bounce to `localhost:3000`. EXACT CLICKS: Supabase dashboard → siton-staging → Authentication → URL Configuration → Site URL `https://siton-staging-web.onrender.com/preview/` → Save → Redirect URLs → Add URL `https://siton-staging-web.onrender.com/preview/**` → Save. The probe identity was kept on purpose as the owner's rehearsal seller (runbook §1); delete it from Authentication → Users when no longer wanted.

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

### B-6 · Migration 065 on staging — CLOSED (applied 2026-09-08)
Correction to the first pass: the staging web container runs `start:web:prod` (`node .demo_dist/src/app.js`) and does **not** run migrations at boot; schema changes reach staging only through the privileged manual procedure. That procedure was executed: the 065 DDL ran as `postgres` in one transaction together with the ledger row (`migration_id` = uuid like every staging row, `position=58`, `filename='065_pilot_readiness.sql'`, `checksum_sha256='94da04e4d5ec1e5841da28075fa4737952e0a83927694ac44046c36a0b1ab308'` = the LF/BOM-stripped file as stored in git, `status='succeeded'`). Verified afterwards: `deals.list_price_per_unit` + check present, `viral_events.detail` + widened event-type check present, ledger rows 58 / max position 58, the DDL re-run is idempotent (IF NOT EXISTS / DROP IF EXISTS), and the deployed master runtime kept answering `/readiness`, the public deal route, the mall route and `/api/viral/events` (202) with the new schema. No interaction with 063/064: they touch payment tables only and are not on staging; when the financial branch lands, its manifest must list 065 before 063/064 so their ledger positions become 59–60. Existing migrations were not renumbered.

---

## IMPORTANT AFTER LAUNCH (10 open: A-1…A-9, A-11 · A-10 fixed on branch)

| # | Item | Why it can wait | Workaround during the pilot |
|---|---|---|---|
| A-1 | **UI CLOSED (launch polish sprint 1):** the React seller deal screen now has a cancel entry (`ביטול העסקה`, ghost, last in the row), a confirmation sheet that names cancel (permanent) vs pause (temporary), one idempotency key per confirmation, and the server's refusal in Hebrew with a one-tap "להשהות במקום" alternative. **Server semantics unchanged by design:** `DEAL_TRANSITIONS` reaches `Cancelled` from `Draft` only, so a LIVE deal is refused with 409 `STATE_CONFLICT` and stays exactly as it was (never turned into a pause). Proof `tests/seller_cancel_ui_validation.ts` 7/7 | a live deal with joins still ends only via pause + deadline (financial state machine, out of this sprint's scope) | pause joining and let the deadline fail the deal (holds released, buyers notified on tracking) |
| A-2 | Notifications are **log-only** (no e-mail/SMS): join confirmations, inquiry pointers, close/fail notices never reach an inbox | provider activation is explicitly outside the pilot guardrails | sellers check the dashboard **פניות** daily; buyers keep their tracking link (join success screen) |
| A-3 | Money is mock: "סה״כ לתפיסת מסגרת" and the card/bit tabs are presentation; real capture waits for the Codex financial gate + Grow sandbox | by design (real money 0) | the deal page carries the "סביבת הדגמה" pill; sellers are told in runbook §2.4 |
| A-4 | **CLOSED (launch polish sprint 1):** self-service pending binding on first login + hourly cap + audit; see the B-1 sprint note above | — | runbook §1 SQL stays the fallback for a refused binding |
| A-5 | `join_failed` is client-observed only; refusals from non-browser clients or network drops are not persisted (`join_attempts` table would be the server-side version) | pilot buyers are all browser | metrics panel + `detail` breakdown |
| A-6 | Seller profile completeness (business id, bank) is not a publish gate; only business name + one contact | money 0 | runbook §1 asks for it anyway |
| A-7 | Join/create mutations are on the global rate bucket only (P0.7C alias gotcha) | fine at pilot scale | — |
| A-8 | Deadline hard cap 7 days; some sellers will ask for 10–14 | product decision | template guidance |
| A-9 | Showcase/demo data from Aug 31 – Sep 3 (`r6-showcase-seller`, `demo-seller-preview`, owner test deals) is inside a 30-day metrics window | cosmetic in metrics | read **מדדי פיילוט** at 7 days for the first week, or tombstone the showcase deals before day one |
| A-10 | **FIXED ON BRANCH (promoted into the closeout).** The bare domain used to 302 to `/app`, the legacy vanilla-JS mall with its own join flow, no inquiry UI and a separate funnel rail (`discovery_events`). `GET /` now redirects to `/preview/`; `/d/:id` still lands on `/preview/#/deal/:id`; `/app` stays reachable for direct links. Regression tests: `backend_sanity_suite.ts` (root → `/preview/`, `/app` still answers) and `pilot_readiness_validation.ts` (root with query string, share route never points at `/app`). Hosted takes effect on deploy | — | until deploy: send links, never the domain (runbook §2.3) |
| A-11 | Custom SMTP sender for Supabase Auth. Default sender delivery is proven (probe confirmed from Gmail) but it is capped at a few mails per hour and can land in spam | ≤10 sellers, onboarded one at a time | resend after 30 min; configure a transactional sender when the cap bites |

## BACKLOG (6)

| # | Item |
|---|---|
| K-1 | Persist refused joins server-side (`join_attempts`) and expose them per deal to the seller |
| K-2 | **DONE (launch polish sprint 1):** the 5-step "מה קורה מכאן? / איך העסקה עובדת?" strip (יצירת עסקה → תצוגה מקדימה → פרסום → איסוף משתתפים → הצלחה / כישלון) on the seller dashboard (never-published sellers) and on every seller deal screen, current step lit by the real deal state, demo disclosure on the strip; 231 px tall at 390 px |
| K-3 | Buyer feedback prompt on the tracking page after close (1-tap "מה היה לא ברור?") |
| K-4 | Base44 mall projection consumers: `list_price_per_unit` is additive/nullable; downstream readers should render it |
| K-5 | Admin metrics export (CSV) for the pilot sheet |
| K-6 | `mobile_readiness_validation.ts` depends on a prior `npm run mobile:build`; make the test build or skip explicitly |

---

## Fixed on this branch during the closeout (not blockers, but pilot-relevant)

- **Root redirect** `GET /` → `/preview/` (A-10), regression-tested; `/d/:id` and `/app` unchanged.
- **Pause idempotency** (see evidence table): the seller's only emergency lever now works on every use.

## What was verified as fine (no action)

- **Buyer comprehension in 10 s:** landing hero states the model and the no-charge promise in one screen; deal page order is identity → image → price (+saving) → group meter → countdown → quantity → pickup/delivery → CTA; CTA copy says how many are still needed ("הצטרפו עכשיו — עוד N ליעד"); countdown is four labelled cells.
- **Seller after publish:** status pill, countdown, "מה יקרה עכשיו", participants table, pause/reopen, export, inquiries panel; preview as buyer works on Drafts.
- **Failure messages:** every backend code that a seller can hit maps to Hebrew (`he.ts`); publish checklist explains each blocker; pickup-location and deadline rules are explained inline.
- **Mobile browser:** no horizontal overflow at 390 px on landing, deal, join sheet, inquiry sheet, seller dashboard, wizard, seller deal, inquiries; 0 console errors on every page hosted and local.
- **Security at the pilot boundary:** anonymous callers refused on seller read + publish; wrong inquiry token → 404; tracking token required; seller e-mail never in the public payload; route-authorization gate green with the new admin route.
- **Hosted health:** worker alive, outbox empty, DLQ empty, DB role and schema correct, guardrails all `false`.

## Deploy sequence for the pilot (smallest set)

1. Independent quick review of this branch → merge to master → CI green → Render auto-deploys web + worker (schema 065 is already on staging).
2. Hosted smoke: `GET /` → 302 `/preview/`; `GET /api/preview/meta` shows the new runtime commit; `node scripts/pilot_readiness_proof.cjs --base-url=https://siton-staging-web.onrender.com --email=<owner> --password=<pw> --joins=0 --cleanup` (leaves nothing behind); open the admin overview and see **מדדי פיילוט**.
3. Owner console, any time before or after step 1: B-2 Render plan (5 min) and B-3 Supabase Site URL (5 min).
4. Rehearse runbook §1 once with the prepared alias, then onboard seller #1 (3 minutes) and create the first deal from `docs/PILOT_DEAL_TEMPLATES.md`.
5. Read **מדדי פיילוט** twice a day (7-day window for the first week); collect feedback per runbook §6–7.
