# Staging acceptance closure — 2026-09-14

**Verdict: hosted redemption acceptance CLOSED on the live SHA; seller acceptance closed at the API layer; authenticated React seller/admin/CMS UI remains BLOCKED on Supabase staging credentials; one LOW client defect found on staging, fixed on this branch (not yet deployed). Real money = 0. Grow, payment provider and financial state logic untouched.**

## Baseline

| Item | Value |
|---|---|
| `origin/master` at start and end of the run | `82c91d62fd092350748405c8aec15a23d0e2af5e` (unchanged; verified with `git fetch origin`) |
| Live Render runtime SHA (`/api/preview/meta`) | `c1ce4e4164fd4ee64d124fec29fade97b4557df0`, `is_stale:false`, `payment_is_real:false`, `payout_is_real:false` |
| Live hosted bundle | `/preview/assets/index-BS7DFdSQ.js`, `/preview/assets/index-DkD8CdbB.css` — byte-identical hash to a local build of master's `web/` (see §5) |
| Supabase staging ledger (`siton.migration_ledger`) | 59 rows, max position 59, all `succeeded`; latest `066_receipt_trust_content.sql` checksum `c1aed14c…6ef2` |
| Staging counts before this run | deals 31, participants 81, fulfillment units 9, payment attempts 42 |
| Work branch | `claude/staging-acceptance-closure` from exact master `82c91d6` (worktree `C:\Users\Lenovo\Documents\C-ton-staging-closure`); the dirty `claude/system-hardening-sweep` checkout was left untouched |
| Render deploy id | Render MCP is unauthenticated in this session; the deploy id could not be re-read. The runtime SHA above is the deterministic evidence. |

The 2026-09-10 fixtures were inspected first and reused unchanged: the five synthetic deals had left CompletionWindow **naturally** (worker transitions at 2026-09-11 15:27:36–44 UTC), all five were `Completed`, each buyer `DealCompleted` / `ChargedSuccess`, qty 1. No fixture was recreated, no timer shortened, no forced transition. The two synthetic server-session sellers (`acceptance-20260910-1`, `acceptance-20260910-2`) were re-authenticated through the real `POST /api/seller/session/login` (the 12-hour sessions from 2026-09-10 had expired and were proven refused).

## 1. Hosted redemption lifecycle — `hosted_redemption_acceptance.cjs` → **33/34** (the 1 = edge WAF, see below)

All calls against the live Render web service; mutations paced under the hosted 20/60 s per-IP sensitive budget so a 429 could never masquerade as product behaviour. DB evidence by read-only SQL on Supabase staging after the run.

| Area | Evidence |
|---|---|
| Eligibility after CompletionWindow | Every deal `Completed`; every buyer entitlement issued: `status:valid`, `remaining_quantity:1`, `redeemed_at:null`, method matches; `code` only for qr/code (`XXXX-…` 8×4 hex), `url` only for digital_link with the encoded code, instructions on all five |
| Issuance stable | Second read returns the same `entitlement_id`, code and URL for all five |
| Public privacy | `/api/deals/:id/public` and `/receipt-info` never carry the code, the private URL or the buyer phone — before and after redemption |
| Seller resolution (owner) | exact QR code → 1 order; code normalised (lowercase, no dashes, padded) → 1 order; phone `0500000192` finds the name+phone buyer; name finds all 5; empty search lists exactly 5 valid orders across the five methods |
| Seller resolution (foreign) | seller 2 with the owner's codes / phone / empty search → 0 orders every time |
| Authorization on redeem | anonymous 401; buyer tracking token on the seller route refused; foreign seller 404; unknown participant 404; malformed id 400; expired 2026-09-10 cookie 401 — and the entitlement stayed `valid` after each refusal |
| Successful redemption | QR order: 200 `idempotent:false`, `status:redeemed`, `remaining_quantity:0`, `redeemed_at` set |
| Buyer state after | `redeemed`, 0 remaining, same entitlement id and code, same `redeemed_at` |
| Seller state after | search shows `redeemed`, 0 remaining, same `redeemed_at` |
| Duplicate redemption | sequential repeats: 200 `idempotent:true`, original `redeemed_at` kept |
| **Concurrent redemption** | **10 parallel owner redeems on the code order → 10 × 200, exactly 1 `idempotent:false`, 9 `idempotent:true`, one distinct `redeemed_at` (`2026-09-14T09:01:44.312Z`)** |
| **Mixed race** | **5 owner + 5 foreign parallel redeems on the name+phone order → owner: one fresh + four replays with one timestamp; foreign: 5 × 404** |
| Remaining methods | digital_link and instructions each redeemed once; private link stable after redemption |
| Persistence | seller logout → session unauthenticated / 401 → fresh login → all five `redeemed`; every buyer re-reads `redeemed` with the recorded timestamps on a fresh request; a later owner redeem on every order is `idempotent:true` |
| Public seller statistics | `published:5, completed:5, success_rate:100` |

**DB evidence (read-only SQL, all five participants):** 1 unit each, `Redeemed`, exactly 1 distinct `redeemed_at`, `redeemed_by = acceptance-20260910-1`, and **exactly one** `seller_security_events` row `fulfillment.redeem` (`Issued>Redeemed`, `seller_confirmation`) per participant — the 10-way and 5+5-way bursts produced one event each. API `redeemed_at` values equal the DB rows: qr `09:00:43.979`, code `09:01:44.312`, name_phone `09:02:45.712`, digital_link `09:02:46.311`, instructions `09:02:46.679` (UTC).

**The one non-pass:** the probe string `' OR 1=1 --` returns **403 HTML "Blocked" from the Cloudflare edge in front of Render** (`server: cloudflare`, `cf-ray`, route-independent — the same on a public route). The application never saw it; the parameterised query is covered by the local security suites. Not an application defect. The other hostile inputs (`INVALID-ACCEPTANCE`, all-`A` code, `<script>`, path traversal) answered 200 with zero orders.

**Observation, no change:** the receipts search uses `ILIKE '%'||$2||'%'` without escaping LIKE wildcards, so `%`, `_` or `%00` act as wildcards. It is scoped by `d.seller_id = $1` (the empty search already lists every own order): owner gets its own 5, foreign seller gets 0 for every wildcard probe. No cross-tenant exposure; functionally equivalent to the empty search.

## 2. Hosted React browser acceptance — `hosted_browser_acceptance.cjs` → **33/33** (headless Edge CDP, live staging)

Widths 390 / 430 / 1280 / 1440. Every visit: RTL, no horizontal overflow, no text under 10 px, zero console errors, zero failed requests, zero unexpected 4xx/5xx.

- **Buyer tracking page after redemption, token-authenticated, all five methods** (qr and digital_link at all four widths, the others at 390/1440): "המימוש שלי", "כבר מומש", the deal title and instructions; the code still shown for qr/code; the QR image and the private-link button correctly hidden once redeemed; name+phone shows its instruction line.
- Public completed deal page; public seller profile (5 completed, 100 %); landing; content pages (`about`, `legal_terms`) rendered from the CMS; seller login gate; `#/seller/receipts` → login gate; admin gate ("כניסת מנהל", the P0.5 hidden gate); `#/admin/content` → gate.
- Buyer tracking with a foreign token in a fresh document → refusal state; the 403s are the expected ones.
- Cosmetic environment note: the browser's automatic `/favicon.ico` request answers 404 on the first visit of a fresh profile (the page declares `/preview/brand/favicon-64.png`). Not a functional defect; no change made.

## 3. Defect found on staging and fixed on this branch — stale tracking page on an in-document link change (LOW)

**Symptom (hosted, reproduced deterministically, `track_stale_repro.cjs`):** load buyer A's valid tracking link, then change the hash in the same document to buyer B's participant with A's token (server answers 403). Expected: "אין גישה למסך המעקב". Observed: the page kept showing **deal A's title and status** under B's URL while the entitlement panel (which re-keys on participant) showed its own refusal — a chimera page. Fresh-document control shows the refusal correctly.

**Root cause:** `web/src/pages/track.tsx` keeps `payload` across `participantId`/`token` prop changes and the load guard `if (!alive || payload) return;` is a stale closure: on the first mount it captures `null` (so it never protects polling), and when the link changes it captures A's payload, so every refusal for link B is swallowed and A's page stays.

**Fix (1 line at the single mount site, `web/src/App.tsx`):** `<TrackPage key={participantId:token} …>` — a different tracking link is a different page; the whole page state (payload, impact, error, toast, entitlement, feedback) resets and every fetch is per link. Polling semantics on the same link are unchanged. No backend, migration, payment or financial change.

**Regression coverage:**
- `scripts/buyer_polish_browser_proof.cjs` — new step "in-document link change @390": valid tracking page → hash changed to another participant with a bogus token → refusal, never the previous buyer's page. **A/B on a local demo-preview runtime:** master bundle (`index-BS7DFdSQ.js`, the same hash as the live staging bundle) → **32/33, exactly this step fails**; fixed bundle (`index-DwQhN0Dn.js`) → **33/33** (Mall runtime skipped; 0 console errors, 0 failed essential requests, 27 page checks).
- `tests/frontend_foundation_buyer_polish_validation.ts` — new pin `P8b` (unit group): **15/15** with the fix, **14/15** (only P8b fails) against master's `App.tsx`.

The live staging app (`c1ce4e4`) still has the defect until this branch is merged and deployed; re-run `track_stale_repro.cjs` against staging after the deploy (expected `RESULT NO_DEFECT`).

## 4. Seller acceptance at the API layer — `hosted_seller_api_acceptance.cjs` → **17/17**

The endpoints the React seller screens call, with the real server sessions: wrong password / unknown identifier → 401 `SELLER_AUTH_INVALID_CREDENTIALS` without a cookie; session and context reflect the seller honestly; `/api/seller/deals` lists exactly the five synthetic deals (all `Completed`) for the owner and none for the foreign seller; per-deal read 200 for the owner and 404 for the foreign seller; receipt configuration locked after publish (`editable:false`, PUT 409) for every method; analytics / viral / propagation / preview reads 200; fulfillment list 200 and receipts search shows the five redeemed orders; pickup resolve/search with unknown input → safe 404 / empty; business profile and public profile (5/5/100 %) equal the public page; public-profile edit persists and was reverted; invalid inputs 400 / unknown 404; inquiries inbox 200; every seller read 401 without a session; logout expires the session.

## 5. Admin / CMS on the live SHA — boundary evidence only (**15/15**)

Public CMS read (`/api/site-content`, 10 sections, `no-store`) feeds the rendered About/legal pages. Anonymous and seller sessions are refused (401) on admin CMS read, CMS write, admin asset upload, admin sellers list (`/api/admin/r6/sellers`), admin deal profile and `/api/admin/auth/me`; the admin cookie login with unknown credentials answers 401 `admin_invalid_credentials` without a cookie.

**BLOCKER — authenticated React seller / admin / CMS UI acceptance (edit → save → reload → revision conflict → restore):** the React seller and admin surfaces authenticate only through Supabase GoTrue (`AuthPanel` → `supabaseSignIn` → Bearer, validated per request); the server-session cookie path has no React client mode. No Supabase staging seller/admin login exists in the approved local environment (`.env` holds only a local `DATABASE_URL`), GoTrue sign-up requires mailbox confirmation, and the service-role key lives only inside the storage-broker Edge runtime. Per the task rules no principal was minted and no client auth state was forged. **Minimal owner action:** create (or share) one dedicated staging Supabase seller login bound to an approved seller and one staging admin login bound to an admin identity, and place them out-of-band in an ignored local env file (e.g. `SEED_SELLER_EMAIL/SEED_SELLER_PASSWORD`, `SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD`); the authenticated walkthrough (seller dashboard/profile/deal/receipts screens; admin sellers/deal/fulfillment/CMS edit-save-reload-conflict-restore at 390/1440) is then a one-session task.

## 6. Gates on the branch

Backend TypeScript and web TypeScript clean; web production build OK (545.23 kB, existing non-blocking size warning); `lint` (enforcement + secret + control-byte scans) PASS; payment compliance PASS; runtime DDL scan PASS (66 files); architecture gate PASS; unit group **15/15** (fresh migrated DB per file); route-authorization gate PASS (static 1 + behavioural 4); `git diff --check` clean. The change is one React mount line plus a proof step and a unit pin, so the full 208-file suite was not re-run.

## 7. Safety

Real money 0 (mock provider; `payment_is_real:false` re-checked at the start of the run). No Grow, provider, capture/refund/recovery/reconciliation or financial-state change. No production deployment; no production data. Only synthetic fixtures were mutated (five synthetic orders redeemed by their synthetic seller; one reversible profile edit). No staging schema or grant change. The seller passwords and buyer tracking tokens exist only in the ignored local files of the 2026-09-10 acceptance worktree and this session's scratchpad; none is in this report or in Git.

## 8. Status

- Code complete: **yes** (fix + regression on `claude/staging-acceptance-closure`, not merged).
- Staging accepted: **hosted redemption lifecycle — YES on `c1ce4e4`; seller API layer — YES; hosted React tracking/public/gate screens — YES; authenticated React seller/admin/CMS UI — NO (credential blocker above).** Hosted acceptance ≈ 85 % (estimate, not a passed gate).
- Physical-device camera acceptance: **OPEN** — not tested on a physical device in this run.
- Real-money readiness: **0 % / NOT COMPLETE** — unchanged and separate.

Local evidence (scratchpad, ignored): `hosted_redemption_acceptance.log/.json`, `hosted_browser_acceptance.log/.json` + `hosted_shots/` (33 screenshots), `hosted_seller_api_acceptance.log/.json`, `hosted_admin_boundary.log/.json`, `hosted_like_wildcard_observation.log`, `track_stale_repro_hosted.log`, `buyer_polish_proof_fixed.log` / `buyer_polish_proof_control.log`, `unit_group.log`, `route_auth_gate.log`.
