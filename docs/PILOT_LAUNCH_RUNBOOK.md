# Siton — Closed Web Pilot: Launch Runbook

Scope: a closed-market web pilot on the hosted staging runtime
(`https://siton-staging-web.onrender.com/preview/`) with 5–10 real sellers,
real buyers, real deals — and **real money = 0**. Every join is an app-internal
mock authorization; no card is charged, no provider is called. Sellers and
buyers must be told this in plain words (see §2.4 and §5).

Companion documents: `docs/LAUNCH_GAP_REPORT.md` (what blocks, what waits),
`docs/PILOT_DEAL_TEMPLATES.md` (five fillable deal structures),
`docs/PILOT_METRICS.sql` (the pilot questions as SQL), and the two proof tools
`scripts/pilot_readiness_proof.cjs` (API journey) and the admin console's
**מדדי פיילוט** panel.

---

## 0. Before day one — owner checklist (once)

| # | Action | Where | Why |
|---|---|---|---|
| 0.1 | Merge `claude/launch-gap-pilot-readiness` (after review) and let Render redeploy `siton-staging-web` + `siton-staging-worker` | GitHub → Render | brings migration 065, the pilot metrics panel, seller approval UI, regular-price field |
| 0.2 | **DONE 2026-09-08** — migration `065_pilot_readiness.sql` is applied on staging (ledger position 58, checksum recorded, rerun proven idempotent, the running master runtime stayed healthy). Nothing to do. The web container runs `start:web:prod` and never runs migrations itself; a **new** environment gets the file + the ledger statement below | — | schema is ahead of the deployed code, which is the safe order |
| 0.3 | Render dashboard → **siton-staging-web** → *Settings* → *Instance Type* → choose **Starter** (0.5 CPU / 512 MB, US$7/mo, same tier the worker already uses) → *Save changes*. Render restarts the service (~2 min). Verify: open the preview after 20 idle minutes — first paint must be < 2 s | Render dashboard (billing-scoped, owner only) | `free` idles after 15 min; measured **23.0 s** cold vs 0.3 s warm; the first buyer on every shared link after a quiet period lands on a dark blank page |
| 0.4 | Supabase dashboard → project **siton-staging** → *Authentication* → *URL Configuration*: set **Site URL** to `https://siton-staging-web.onrender.com/preview/` → *Save*; under **Redirect URLs** → *Add URL* → `https://siton-staging-web.onrender.com/preview/**` → *Save* | Supabase dashboard (no API/MCP for this) | the auth log still shows `referer: localhost:3000` (the default). Confirmation itself works, but after clicking the link the seller is bounced to localhost instead of the product — confusing on a phone |
| 0.5 | SMTP — **after launch.** Delivery with the default Supabase sender is proven: the probe signup of 2026-09-08 06:17Z was confirmed from the owner's Gmail inbox. Caveat: the built-in sender is capped (a few mails per hour) — onboard sellers one at a time, not ten in one hour; if a seller reports no mail, use the "שכחתי סיסמה / שליחה חוזרת" button after 30 min, then a custom SMTP provider (*Authentication* → *SMTP Settings*) | Supabase dashboard | switch to a custom sender when the cap bites or on the first spam report |
| 0.6 | Confirm your owner login works on the hosted preview (`#/seller` with your Supabase e-mail) and the admin gate (two taps on the hidden corner dot → step-up) opens `#/admin` | browser | you will approve sellers and read metrics from here |
| 0.7 | Read the deal templates and pick 2–3 for your first conversations | `docs/PILOT_DEAL_TEMPLATES.md` | |

Ledger row for a **brand-new** environment only (staging already has it; checksum
= sha256 of the file as stored in git, LF line endings, BOM stripped):

```sql
INSERT INTO siton.migration_ledger
  (migration_id, position, filename, checksum_sha256, started_at, completed_at, status)
VALUES
  ('065', 58, '065_pilot_readiness.sql',
   '94da04e4d5ec1e5841da28075fa4737952e0a83927694ac44046c36a0b1ab308', now(), now(), 'succeeded');
```

If the financial branch (063/064) lands on staging first, its rows take positions
58–59 and this row becomes position 60 — keep the manifest order and the ledger
positions identical.

Optional but recommended: run the API journey against hosted with your owner
login once after the deploy (takes ~1 min, creates one synthetic deal under
your seller account which you can delete as a Draft afterwards or leave paused):

```
node scripts/pilot_readiness_proof.cjs --base-url=https://siton-staging-web.onrender.com --email=<owner e-mail> --password=<owner password> --keep
```

---

## 1. Onboard a seller — 2 minutes, two steps (automatic binding)

**Since launch polish sprint 1 (branch `claude/launch-polish-seller-ops`) the
binding is automatic.** A confirmed Supabase login is bound to a **pending**
seller account on its first login (`GET /api/auth/capabilities`; deterministic
`seller_id` = `s-<e-mail slug>-<8 hex>`; audited in `seller_security_events` as
`seller.self_signup.bound`; capped at `SELLER_SELF_SIGNUP_HOURLY_CAP` = 20 per
hour platform-wide; `SELLER_SELF_SIGNUP_ENABLED=0` switches it off). Nothing is
auto-approved: publishing opens only after your **אשר מוכר**. The manual SQL
below stays as the fallback. The earlier manual procedure was verified on
staging 2026-09-08 (bound + approved seller ran the whole journey 23/23).

**Step 1 — seller signs up and logs in (1–2 min, the seller alone).**
Send the seller this link: `https://siton-staging-web.onrender.com/preview/#/seller?signup=1`.
They enter e-mail + password, open the confirmation mail, tap the link, log in
at `/preview/#/seller` → they land on the dashboard with the banner
"החשבון ממתין לאישור C-ton — עדיין לא ניתן לפרסם" and the 5-step
"מה קורה מכאן?" strip. They can already fill **פרופיל עסקי**, create a draft,
upload photos and preview it — not publish.

If instead they see "ההתחברות הצליחה, אבל אין לחשבון הזה גישת מוכר" the
automatic binding refused, and the notice says why: `email_in_use` = an older
seller account owns that e-mail and was deliberately NOT claimed → bind it with
the fallback SQL (fill `auth_user_id` from `auth.users`); `throttled` = more than
20 signups in the last hour → log in again later; anything else → fallback SQL.

**Step 2 — owner approves (30 s).** Admin → **תמונת מצב** opens with
"N מוכרים ממתינים לאישור → לאישור עכשיו", or Admin → **מוכרים** → the
**ממתינים לאישור** queue at the top: business name (from their profile),
e-mail, signed up when, drafts so far; **פתיחה** for the full identity block
and "יכול לפרסם: לא/כן"; **אשר מוכר** (one tap) or **דחייה** (two taps). On the
seller's next dashboard load the banner disappears and publishing works.

**Fallback — manual bind (1 min, only when the automatic binding refused or is
switched off).** Supabase → SQL editor → paste, fill the three `<…>` values,
run. `'approved'` lets them publish immediately; use `'pending'` if you want to
look at the first draft first.

```sql
INSERT INTO siton.seller_accounts
  (seller_id, display_name, login_email, business_name, support_email,
   verification_status, settlement_status, auth_enabled, auth_user_id, admin_note)
SELECT 'pilot-<business-slug>',                       -- lowercase letters, digits, dashes
       '<Business name>', u.email, '<Business name>', u.email,
       'approved', 'active', true, u.id, 'pilot_manual_onboarding_' || to_char(now(),'YYYY-MM-DD')
FROM auth.users u
WHERE lower(u.email) = lower('<seller e-mail>')
  AND u.email_confirmed_at IS NOT NULL
ON CONFLICT (seller_id) DO NOTHING
RETURNING seller_id, verification_status;
```

Zero rows returned = the e-mail is not confirmed yet (or the slug already
exists). One row = bound.

After a fallback bind the seller logs in again (30 s): `/preview/#/seller` →
dashboard. If you chose `'pending'`, approve from the queue exactly as in
step 2; until then they see "החשבון ממתין לאישור" and can prepare a draft,
upload photos and preview, but not publish.

Then, together (phone or screen share): **פרופיל עסקי** → business name,
contact name, phone/e-mail (bank details optional — money is 0) → first deal
per §2 → the three pilot truths (§2.4).

**Rehearse it once before seller #1:** the alias
`mati.lederer7+siton-launch-probe@gmail.com` is already confirmed and bound as
seller `pilot-rehearsal-owner-alias` (status **pending**). Use "שכחתי סיסמה" to
set its password, log in, see the pending banner, approve it from the admin
console, publish a draft, delete it. Delete the alias afterwards from
Supabase → Authentication → Users if you do not want to keep it.

Record in your pilot sheet: seller name, e-mail, seller_id, date, template used.

---

## 2. Create the first deal (with the seller)

### 2.1 Wizard (`#/seller/new`, 5 steps)

| Step | What to fill | Gotchas |
|---|---|---|
| 1 פרטי העסקה | type (מוצר / שובר / כרטיס), title, **short description** (the sentence that sells), full description, **group price**, **regular price** (optional, must be higher — buyers then see "חיסכון X%"), 1–12 photos | photos upload after "שמירה"; a failed upload keeps the Draft and can be retried from the deal screen |
| 2 כמויות | minimum (the goal) and maximum (stock) | success threshold = 90 % of minimum, auto |
| 3 אספקה / מימוש | physical: at least one option; pickup/distribution point **must carry a full address or GPS** ("השתמש במיקום שלי"); voucher/ticket: all term fields | the publish button is blocked without a pickup address |
| 4 מועד סיום | date + hour, Israel time, 2 h … 7 days ahead | pick an evening after a weekend |
| 5 סיכום | save as Draft | |

### 2.2 Before publish — the owner's checks (2 minutes)

- Open `#/seller/deal/<id>/preview` (the seller's **תצוגה מקדימה**) on a phone: price, saving, threshold meter, countdown, pickup line + map link, one real photo, no typos in the title.
- Threshold makes sense for the seller (90 % of minimum is what gets charged).
- Deadline is ≥ 48 h away (buyers need time to share).
- Seller profile has a support contact (publishing is refused otherwise).
- The seller understands §2.4.

### 2.3 Publish

`#/seller/deal/<id>` → **פרסום העסקה** → checklist all ✓ → two acknowledgements → publish. State becomes **PendingTarget**. The share link is `https://siton-staging-web.onrender.com/d/<deal id>` (real Open-Graph card with the product photo). The seller shares it in their own WhatsApp groups first; every buyer then gets a personal link after joining.

> **Send links, not the domain.** Share `/d/<id>` (deal) and `/preview/#/seller`
> (sellers). Once this branch is deployed the bare domain lands on `/preview/`
> too; until then it still opens the legacy `/app` mall, which has no inquiries
> and is not counted by **מדדי פיילוט**.

### 2.4 What the seller must understand after publish (say it out loud)

1. **Nothing is charged during the pilot.** Joining "holds a frame" in the app only; the deal closing does **not** move money. Fulfilment and payment are settled between seller and buyers outside Siton for now.
2. Price, quantities and deadline are **locked** after publish. The only levers are *pause joining* (השהיית ההצטרפות → reopen) and, for a Draft or a deal with zero joins, *delete*.
3. Buyers' questions arrive in **פניות** on the dashboard (e-mail pointer is log-only in staging — check the dashboard, not the inbox).

---

## 3. Monitor a live deal

Where to look (owner):

| Question | Where |
|---|---|
| Which deals are live, how many joined, how far from threshold | Admin → **תמונת מצב** (deals by state) → **עסקאות** → deal; Seller dashboard shows the same per seller |
| Views → join attempts → joins → refusals, per window | Admin → תמונת מצב → **מדדי פיילוט** (7/30/90 days) or `docs/PILOT_METRICS.sql` |
| Buyer inquiries waiting for the seller | Seller dashboard **פניות** panel; nudge the seller if `seller_unread_count` grows (Admin → מוכרים → seller → תמיכה) |
| Failures: DLQ, stuck outbox, worker heartbeat | Admin → תמונת מצב (DLQ tile, Worker tile) → **תור ו-Worker** |
| Operational cases (support, payment anomalies) | Admin → **תמיכה** (open cases) |
| Runtime health | `GET /health`, `GET /readiness` (database connected, runtime role), `GET /api/preview/meta` (runtime commit, guardrails all `false`) |

Cadence for the pilot: check the metrics panel **twice a day**; check the
seller's inquiries once a day and message the seller if something waits > 12 h.

What happens automatically:

- Reaching the threshold flips the deal to **TargetReached** (buyers see a
  celebration; joining continues up to the maximum).
- At the deadline the worker runs the deadline check: at/above threshold →
  charging (mock) → **Completed**; below → **Failed** and all holds are
  released (mock). Buyers' tracking pages update themselves.

---

## 4. If something fails

| Symptom | First check | Action |
|---|---|---|
| Buyer says the link shows a blank page for 20 s | Render web plan still `free` | upgrade to `starter` (0.3) or accept the cold start |
| "העסקה אינה זמינה" on a shared link | deal is Draft / deleted, or the link lost its id | seller must publish; re-copy from **שיתוף** |
| Buyer/seller sees an unfamiliar "קניון" screen with no inquiry button | they typed the bare domain → legacy `/app` | send them the `/d/<id>` or `/preview/#/seller` link |
| Publish refused: `חשבון המוכר ממתין לאישור` | seller `verification_status` ≠ `approved` | Admin → מוכרים → seller → **אשר מוכר** |
| Publish refused: pickup address | option label is generic ("איסוף עצמי") | edit delivery options with a full address or GPS |
| Buyer cannot join: "ההצטרפות הסתיימה" | deadline passed, or seller paused joining | seller **פתיחה מחדש** (only while deadline ahead and stock left) |
| Buyer joined twice by mistake | admin → buyers → participant | leave it; money is 0 — note it in the pilot sheet |
| Inquiry not answered | seller unread | message the seller; reply is only possible from the seller dashboard |
| DLQ > 0 / worker "לא מדווח" | Admin → תור ו-Worker | restart the worker service on Render (Manual Deploy → "Clear build cache & deploy" is not needed; **Restart** is) and re-check within 2 min |
| 5xx on a page | Render logs (web service) | copy the `request_id` from the error toast; check `GET /api/preview/meta` runtime commit is the expected SHA |
| Signup e-mail never arrives | Supabase Auth logs / SMTP cap | resend from the login screen; if still nothing, use the manual bind SQL (§1) after creating the user with "Invite user" in the Supabase dashboard |

Never edit deals, participants or money tables by hand. If a deal must be
stopped, use §5.

---

## 5. Pause / disable a deal

| Need | Who | How | Effect |
|---|---|---|---|
| Stop new joins temporarily | seller | deal screen → **השהיית ההצטרפות** | state `ClosedForJoining` (manual); buyers see "ההצטרפות הושהתה"; **פתיחה מחדש** reverses it while the deadline is ahead |
| Remove a Draft or a live deal with **zero** joins | seller | deal screen → **מחיקת העסקה** | tombstoned; link shows "העסקה אינה זמינה" |
| Abort a live deal that already has joins | owner (no seller UI yet) | Admin console has no cancel button on master. Today: pause it from the seller side and let the deadline fail it (holds released, buyers notified on their tracking page). The server route `POST /deals/:id/cancel` exists for the seller session and is listed as after-launch work (`LAUNCH_GAP_REPORT.md` A-1). | |
| Take the whole product offline | owner | Render → suspend the web service (buyers get the Render "service unavailable" page) | use only for a real incident |

---

## 6. Collect seller feedback

- Day 1 after publish and the day after the deal closes: a 5-question WhatsApp
  message (voice notes are fine):
  1. How long did the first deal take you to set up? Where did you get stuck?
  2. Did the buyers understand the price/threshold from the link alone, or did you have to explain?
  3. What did buyers ask you (outside Siton) that the page should have answered?
  4. Would you run another deal next week? Which product?
  5. One thing to remove, one thing to add.
- Record answers in the pilot sheet next to the seller's row; tag each answer
  `signup`, `wizard`, `share`, `buyers`, `inquiries`, `close`.
- The quantitative side is already in **מדדי פיילוט**: `sellers_repeat_publishers`
  is the number that matters.

## 7. Collect buyer feedback

- **In product (sprint 2):** the join success screen and the tracking page ask
  ONE question — "היה משהו שלא היה ברור?" — with six fixed answers (how it
  works / price / what if the target is missed / payment / delivery / other),
  an optional 280-character text and a "הכול היה ברור" shortcut. Asked once per
  deal per browser, never forced. Answers are PII-free (no name, phone, e-mail
  or participant id) and land on the operational-cases rail as CLOSED, low
  priority, `opened_by = buyer_feedback` — they never appear as open support
  work. Read the aggregate in Admin → overview → **מדדי פיילוט** → "משוב
  קונים" (counts per answer + the last free texts), or with the SQL block
  "buyer feedback" in `PILOT_METRICS.sql`. A category that repeats across
  deals is a page defect to fix, not a buyer problem.
- For the buyers who never reached the success screen, ask each seller to
  forward this one-line message to their group after the deal closes:
  "מה היה לא ברור בדף העסקה? תשובה במילה אחת מספיקה."
- Buyers who used **פנייה למוכר** already told you what was unclear — read the
  first message of every inquiry thread (Admin → מוכרים → seller → תמיכה, or the SQL in
  `PILOT_METRICS.sql`, "join refusals by reason" for the automated part).
- Watch two numbers per deal in the metrics panel: `view_to_join_pct` and
  `join_failures` (with `detail` = the refusal code). A refusal code that repeats
  is a UX defect, not a buyer problem.

---

## 8. Pilot exit criteria (what "we learned enough" looks like)

- ≥ 5 sellers published at least one deal; ≥ 2 published a second one.
- ≥ 3 deals reached threshold; at least one failed (so the failure path was seen by real buyers).
- `view_to_join_pct` measured on ≥ 200 deal views.
- Every inquiry thread answered by the seller within 24 h.
- Zero DLQ entries and zero 5xx in the web logs during live deals.

## 9. Counter pickup — physical handoff (LAUNCH SPRINT 3)

When a physical deal is **Completed** and a buyer's payment is canonically settled, the buyer's tracking page shows a pickup card: product, quantity, pickup point, an order code `CT-NNNN-NNNN` and a QR. The seller verifies it in the product — no SQL, no Excel, no e-mail search. Full design: `docs/PHYSICAL_FULFILLMENT_PICKUP.md`.

**At the counter (5–10 seconds):**

1. Seller opens **📷 סריקת איסוף** (seller dashboard, or the deal's **📦 הזמנות למסירה** screen) on the phone.
2. Scans the buyer's QR (the buyer taps **הצגת קוד לאיסוף** for the full-screen code). If the camera is denied or unavailable: tap **הקלדת קוד** and type the 8 digits, or **חיפוש** by phone / name. A phone camera app that scans the QR opens the same screen with the code filled in.
3. Reads the card. Only a **✓ מוכן למסירה** card with **שולם ✓** is a go. It names the buyer, the product, the **quantity**, the method and the code.
4. Taps **אישור מסירה — N יחידות**, then confirms "אתם מוסרים עכשיו N יחידות של X ל-Y" (**אישור מסירה** / **חזרה**).
5. Sees **נמסר ✓**. The buyer's page now says **ההזמנה נמסרה** with the time.

**Do not hand over when the card is red — the reason line says why:** התשלום לא הושלם · העסקה טרם הושלמה · העסקה נכשלה · העסקה בוטלה · התשלום הוחזר · הקוד אינו תקין (unknown, mistyped, or another seller's code — all answer the same).

**Amber — כבר נמסר:** the order was already handed over (time shown). A second scan or a double tap never marks it twice; two devices confirming together record exactly one handoff.

**Delivery (courier) orders:** no counter QR. Open **📦 הזמנות למסירה** → the courier rows carry code, buyer, phone, e-mail, quantity, address, city, notes, payment and handoff state; **אישור מסירה** marks them from the list. The Excel export (**הורדת Excel לוגיסטי**) carries the same columns for bulk logistics.

**Support / disputes (admin):** the admin deal profile shows ממתינות למסירה / נמסרו and, per buyer, the handoff time and the last 4 digits of the code. Every handoff is an audit event (seller, request id, idempotency key, quantity). There is no "undo delivered" in the product — a mistaken handoff is a support case.

**What the pilot does NOT do:** no e-mail/SMS when an order becomes ready (the tracking link is the credential carrier), no partial handoff, no carrier integration, no shipment tracking.
