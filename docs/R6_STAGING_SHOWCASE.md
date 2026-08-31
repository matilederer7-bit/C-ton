# R6 Staging Showcase — synthetic evaluation data

Everything described here is **synthetic staging data** created for owner
evaluation. No real buyers, no real money (mockpay), no real notifications
(log-only provider). Deal descriptions are marked `[דמו סינתטי]`.

## Where

- Public Mall: https://siton-staging-web.onrender.com/preview
- Seller dashboard: https://siton-staging-web.onrender.com/preview#/seller
- Admin control center: https://siton-staging-web.onrender.com/preview#/admin
  (also reachable via the deliberately faded dots at the extreme top-left and
  bottom-left of every public page — that is visual subtlety only; the server
  enforces canonical Supabase auth + admin membership on every request)

## Owner login (one canonical account)

1. Open the admin entry → "הקמה ראשונית של חשבון הבעלים".
2. Sign up with **mati.lederer7@gmail.com** and the password of your choice —
   the password goes only to Supabase Auth from your browser; it is never sent
   to the Siton server, never stored in the repo, logs, or docs.
3. Confirm the verification email Supabase sends, then log in.
4. On first authenticated contact the server auto-provisions your SuperAdmin
   binding (`SITON_OWNER_EMAIL` gate — only your verified email can claim it).

The same login also works on any owner-visible surface; each surface checks
its own capability server-side (admin routes require the admin binding; the
seller dashboard requires a seller binding — use the synthetic seller below to
evaluate the seller experience).

## Synthetic seller (for evaluating the seller UX)

- Email: `r6-showcase-seller@siton-staging.dev`
- The password is an out-of-band, rotatable staging secret. It must never be
  committed, pasted into logs, or embedded in the browser bundle.
- This staging-only identity (mock money) owns the showcase catalog seeded by
  `scripts/r6_staging_showcase_seed.cjs`.

## What the seed creates (all through the real hosted APIs)

- ~8 deals with generated imagery across states: Draft, PendingTarget,
  TargetReached, one deal walked through Close→Prepare→Charge so the
  continuous Worker produces synthetic charged-state outcomes via mockpay.
- Synthetic buyers joining through the public Join API, including
  multi-generation personal-share-link chains (`?ref=` codes), share-click and
  deal-view funnel events — so the viral tree, generation chart and
  first/last-touch rankings in the admin Growth screen are backed by real
  staging events.

Re-run the seed any time:

```
node scripts/r6_staging_showcase_seed.cjs \
  --base-url=https://siton-staging-web.onrender.com \
  --seller-email=r6-showcase-seller@siton-staging.dev \
  --seller-password="$SEED_SELLER_PASSWORD"
```

Set `SEED_SELLER_PASSWORD` only in the invoking process or secret manager. Do
not place it in a repository file. Any credential previously documented in
plain text must be treated as compromised and rotated after the closure proof.
