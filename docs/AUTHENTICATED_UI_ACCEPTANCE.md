# Authenticated UI acceptance harness (staging)

`scripts/authenticated_ui_acceptance.cjs` drives the deployed React app through the
authenticated seller and admin/CMS surfaces in a real headless browser (Edge/Chrome
over CDP, no third-party driver), the way a person would: credentials are typed into
the real auth panels and go only to the canonical Supabase password grant. The harness
creates no users, touches no Supabase configuration, stores no credential in Git and
invents no token.

## Credentials — environment variables only

| Variable | Meaning |
| --- | --- |
| `SITON_ACCEPTANCE_SELLER_EMAIL` / `SITON_ACCEPTANCE_SELLER_PASSWORD` | a staging Supabase login bound to an **approved** seller |
| `SITON_ACCEPTANCE_ADMIN_EMAIL` / `SITON_ACCEPTANCE_ADMIN_PASSWORD` | a staging Supabase login holding the Admin capability |
| `SITON_ACCEPTANCE_BASE_URL` (optional) | default `https://siton-staging-web.onrender.com` |
| `SITON_ACCEPTANCE_FOREIGN_DEAL_ID` (optional) | a deal owned by **another** seller; otherwise discovered from the public catalog |
| `SITON_ACCEPTANCE_BROWSER` (optional) | explicit `msedge.exe` / `chrome.exe` path |

The harness never loads `.env` files and never reads credentials from disk. Set them in
the shell for one session only, e.g. PowerShell:

```powershell
$env:SITON_ACCEPTANCE_SELLER_EMAIL = "<seller login>"
$env:SITON_ACCEPTANCE_SELLER_PASSWORD = "<seller password>"
$env:SITON_ACCEPTANCE_ADMIN_EMAIL = "<admin login>"
$env:SITON_ACCEPTANCE_ADMIN_PASSWORD = "<admin password>"
npm run acceptance:ui                      # both flows, desktop-primary (1440) + 390 re-check
npm run acceptance:ui -- --viewport=mobile # both flows at 390 with a 1440 re-check
npm run acceptance:ui -- --flow=seller     # one flow
```

Credential **values** are never printed; only `seller=present|missing admin=present|missing`.

## Boundary behaviour (no fake PASS)

- `npm run acceptance:ui:check` — presence only, no browser, no network. Exit 3 +
  `CREDENTIALS_MISSING` + `MISSING_CREDENTIALS=<variables>` when anything is absent.
- `npm run acceptance:ui:plan` — prints every step with its disposition
  (`RUN`, `SKIP:CREDENTIALS_MISSING(seller|admin)`, `NOT_SUPPORTED`) without a browser.
- A full run without credentials still executes the credential-free checks (real
  PASS/FAIL) and reports every authenticated step as `SKIP … CREDENTIALS_MISSING(...)`;
  the verdict is `CREDENTIALS_MISSING`, exit 3. Only a run in which every step passed and
  nothing was skipped reports `verdict=PASS` (exit 0). Any failure → `FAIL`, exit 1.
- `tests/authenticated_ui_acceptance_harness_validation.ts` pins this contract
  (no browser/network): missing → exit 3 and SKIP, values never echoed, non-loopback
  dry-fit refused, no `.env` loading.

## Steps

Seller (`--flow=seller`):

| Step | What is proven |
| --- | --- |
| S0 (no creds) | `#/seller` shows only the auth panel (no dashboard content); `GET /api/seller/deals` is 401 without a token; RTL + no horizontal overflow at 1440 and 390 |
| S1 | login through the real `AuthPanel` → Supabase password grant → capabilities adopted → dashboard; refusals and "no seller surface" notices fail the step with the Hebrew message |
| S2 | dashboard renders (heading, RTL, no overflow); `GET /api/seller/deals` 200 with the stored session |
| S3 | `#/seller/profile`: public profile form + business profile form render |
| S4–S6 | edit the public-profile "about" field (append a run marker) → save (`הפרופיל נשמר`) → reload → value persisted → **original value restored and re-verified** |
| S7 | another seller's deal (env or public-catalog discovery): `GET /api/seller/deals/:id` and `/fulfillment` answer 401/403/404; `#/seller/deal/:id` renders the refusal state and no deal controls |
| S8 | dashboard + profile at the other viewport width, no overflow |
| S9 | console/network hygiene over every executed step (uncaught exceptions, `console.error/warn`, failed loads, unexpected ≥400 responses) |

Admin/CMS (`--flow=admin`):

| Step | What is proven |
| --- | --- |
| A0 (no creds) | `#/admin` shows the password step-up gate, never the shell; `GET /api/admin/site-content` is 401 without a token; a forged `sessionStorage` unlock marker with no session still yields no shell |
| A1 (seller creds) | the seller identity is refused at the step-up (`לחשבון זה אין הרשאת ניהול`), no shell; its token is refused by the admin API |
| A2 | admin login through the real step-up → server-confirmed Admin capability → shell |
| A3 | `#/admin/content` (CMS) loads; `GET /api/admin/site-content` 200 |
| A4–A6 | edit `footer.text` (append a run marker) → save (`התוכן נשמר ויוצג באתר`) → reload → CMS form and public `/api/site-content` carry the edit |
| A7 | revision conflict: a concurrent write with the form's revision (which also restores the original text) → the form's stale save is refused with `התוכן עודכן בידי מנהל אחר…` (HTTP 409); public content verified restored |
| A8 | restore/revert: **NOT_SUPPORTED** on master (the server stores `previous_value_jsonb`, but no route or UI exists) — reported as such, never PASS |
| A9 | CMS at the other viewport width, no overflow |
| A10 | console/network hygiene |

Side effects on staging once credentials exist: the seller's public "about" text and the
site footer text are each modified with a run marker and restored inside the same run
(S6 / A7). Both restorations are verified; a failed restoration fails the step loudly.
Hosted non-GET rate budget (20/60 s per IP) is far above the run's write count.

## Output

`.tmp_acceptance_ui/<run-id>/` (git-ignored): `report.json` (steps, statuses, credential
presence booleans), `diagnostics.jsonl` (every console error/warning, uncaught exception,
failed request and ≥400 response tagged by step) and PNG screenshots per step. The
throwaway browser profile is deleted and `localStorage`/`sessionStorage` are cleared
before the browser closes.

## Local dry-fit (harness self-validation, not acceptance)

`--local-dryfit` drives every post-login step against a **loopback demo-preview server
with Supabase not configured** (it refuses anything else), seeding the same non-secret
local demo session the repo's other local browser proofs seed. Login steps (S1, A1, A2)
cannot be dry-fitted and are reported as `DRYFIT`; the verdict is `DRYFIT_PASS` /
`DRYFIT_FAIL`, never an acceptance PASS. Recipe:

```powershell
# fresh local DB + migrations, web build, demo server on 127.0.0.1:3719 (see scripts/run_migrations.cjs, web/ build)
$env:DATABASE_URL = "<loopback database the server uses>"
npm run acceptance:ui:dryfit-seed -- --base-url=http://127.0.0.1:3719   # prints the two env lines below
$env:SITON_ACCEPTANCE_FOREIGN_DEAL_ID = "<printed>"
$env:SITON_ACCEPTANCE_DRYFIT_ADMIN_COOKIE = "<printed local cookie session>"
npm run acceptance:ui -- --local-dryfit --base-url=http://127.0.0.1:3719
```

The seed creates a draft under another seller context (demo-mode `x-seller-id`) and a
throwaway local SuperAdmin cookie session (CMS writes are cookie-guarded even locally).
