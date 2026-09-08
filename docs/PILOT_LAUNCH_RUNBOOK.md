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
| 0.2 | Apply migration `065_pilot_readiness.sql` to staging **before** the deploy finishes: run its SQL in the Supabase SQL editor, then insert the ledger row (`migration_id='065'`, `position=58`, `filename`, `checksum_sha256` = sha256 of the file with BOM stripped, `status='succeeded'`, `started_at/completed_at=now()`) | Supabase → SQL editor | the container runs `run_migrations` at start as the web login role, which cannot run DDL; an un-applied manifest entry fails the boot |
| 0.3 | Upgrade the Render **web** service from `free` to `starter` (or add an external 5-minute keep-alive ping to `/health`) | Render → siton-staging-web → Settings | free tier idles after 15 min; first buyer on a shared link waits ~20–25 s on a blank page (measured 23.0 s cold / 0.3 s warm) |
| 0.4 | Supabase → Authentication → URL Configuration: **Site URL** = `https://siton-staging-web.onrender.com/preview/`, add `https://siton-staging-web.onrender.com/preview/**` to Redirect URLs | Supabase dashboard | seller signup confirmation links must land on the product, not on localhost |
| 0.5 | Supabase → Authentication → SMTP: configure a real SMTP sender (or confirm the default sender's hourly cap is acceptable for ≤10 sellers) | Supabase dashboard | the built-in sender is rate-limited and lands in spam; a seller who never gets the mail never enters |
| 0.6 | Confirm your owner login works on the hosted preview (`#/seller` with your Supabase e-mail) and the admin gate (two taps on the hidden corner dot → step-up) opens `#/admin` | browser | you will approve sellers and read metrics from here |
| 0.7 | Read the deal templates and pick 2–3 for your first conversations | `docs/PILOT_DEAL_TEMPLATES.md` | |

Optional but recommended: run the API journey against hosted with your owner
login once after the deploy (takes ~1 min, creates one synthetic deal under
your seller account which you can delete as a Draft afterwards or leave paused):

```
node scripts/pilot_readiness_proof.cjs --base-url=https://siton-staging-web.onrender.com --email=<owner e-mail> --password=<owner password> --keep
```

---

## 1. Onboard a seller (per seller, ~10 minutes)

**Seller self-signup (today's code path):** the seller opens
`/preview/#/seller`, taps **פתיחת חשבון מוכר**, enters e-mail + password,
confirms the e-mail, and logs in.

> On the canonical master there is **no automatic seller binding** for a new
> Supabase login — the seller sees the login screen again with no seller
> workspace. Until the self-signup patch in `docs/LAUNCH_GAP_REPORT.md` (B-1)
> is merged, bind each pilot seller manually in the Supabase SQL editor,
> right after they confirm their e-mail:

```sql
-- one row per pilot seller: binds the confirmed login to a seller account
INSERT INTO siton.seller_accounts
  (seller_id, display_name, login_email, business_name, support_email,
   verification_status, settlement_status, auth_enabled, auth_user_id, admin_note)
SELECT 'pilot-<short-business-slug>',          -- lowercase, digits, dashes only
       '<Display name>', u.email, '<Business name>', u.email,
       'approved', 'active', true, u.id, 'pilot_manual_onboarding_' || to_char(now(),'YYYY-MM-DD')
FROM auth.users u
WHERE lower(u.email) = lower('<seller e-mail>')
  AND u.email_confirmed_at IS NOT NULL
ON CONFLICT (seller_id) DO NOTHING;
```

Set `verification_status='pending'` instead of `'approved'` if you want to
review the first draft before allowing publish (then approve from
Admin → מוכרים → the seller → **אשר מוכר**, or `UPDATE … SET verification_status='approved'`).

Then, with the seller (phone or screen share):

1. Seller logs in again → lands on the dashboard.
2. **פרופיל עסקי** → business name, contact name, phone/e-mail (bank details are optional for the pilot — money is 0).
3. Walk through §2 together for the first deal.
4. Tell them the three pilot truths (§2.4).

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

- The join success screen and the tracking page are the only two moments you
  own. For the pilot, ask each seller to forward this one-line message to their
  group after the deal closes: "מה היה לא ברור בדף העסקה? תשובה במילה אחת מספיקה."
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
