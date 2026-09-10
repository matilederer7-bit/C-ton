# Staging activation and acceptance — 2026-09-10

**Verdict: exact staging deployment verified; hosted acceptance remains PARTIAL. Real money = 0.**

## Scope and baseline

Approved application SHA: `c1ce4e4164fd4ee64d124fec29fade97b4557df0`, verified against GitHub `refs/heads/master`.
The original checkout was on `claude/system-hardening-sweep` at `75baa21dc11c0771cd997cf71f4ea3a720c0cbe8`, with existing changes in PROJECT_STATUS.md/styles.css and untracked diagnostic/worktree files. Its local master was also stale. Those working changes were preserved. Work ran in a new detached checkout, `.worktrees/staging-acceptance`, initially clean at the approved SHA.

Only Supabase `hnptacfzuqebfgeshadq` (`siton-staging`, eu-central-1) and Render `srv-daa5o9u7bikc73fgjskg` were changed. No production deployment, Grow implementation change, financial transition implementation change, or external payment activation occurred.

## Database activation

The actual staging project was ACTIVE_HEALTHY. Migration 066 was absent from both the application ledger and schema. The manifest has 58 prerequisite entries, not a numeric 001–065 sequence: it begins with bootstrap 014, includes suffixed IDs, and reserves unmerged IDs. All expected positions and filenames existed.

Pre-existing metadata drift was reproduced and repaired before 066:

- Positions 49–58 (053–061 and 065) had UUID migration IDs rather than canonical IDs.
- 053 and 054 recorded SHA-256 values for CRLF files. Hashing both byte forms proved that their SQL content was identical to the canonical LF files. Exact Git object bytes were independently hashed.
- A locked transaction checked all 58 rows, accepted only those two specifically verified line-ending hashes, and corrected IDs/checksums. No old migration SQL or financial functions were re-executed. A subsequent comparison matched 58/58 rows exactly.

Applied the unmodified 066 schema statements using the repository's established staging SQL + application-ledger procedure (see PILOT_LAUNCH_RUNBOOK.md), transported through Supabase MCP `apply_migration`. The ledger entry and DDL committed together; this was **not** a claim that `scripts/run_migrations.cjs` executed remotely. No direct staging DB credential was available locally.

- 066 position: **59**, status **succeeded**, count **1**.
- Canonical checksum: `c1aed14cf2146841ab7a8c9a274210a1e500978f3bc00bbcadc1f37cbcca6ef2`.
- Verified five added columns, both unique indexes, and both tables.
- Before/after migration counts unchanged: deals 25, participants 76, fulfillment units 4, payment attempts 34, sellers 5. These counts precede the explicitly synthetic acceptance fixtures.
- All 59 ledger entries matched canonical IDs, positions, filenames, checksums and succeeded status. Under the canonical runner policy, matching entries are skipped on rerun.
- A fresh disposable localhost install and repeat passed: 59 migrations, 75 tables, 17 functions, 15 triggers, 252 indexes, 73 foreign keys. No shared database was reset.

**Deployment permission defect repaired:** 066 creates tables without the separate staging runtime grants. Actual privilege queries showed the web role could neither read nor insert into either new table. Added/applied `supabase/staging/023_receipt_content_grants.sql`, following the existing staging role/RLS model:

| Role | content_assets | site_content |
|---|---|---|
| siton_web_runtime | SELECT, INSERT | SELECT, INSERT, UPDATE |
| anon / authenticated / worker | none | none |

RLS is enabled; no browser access, web DELETE, asset UPDATE, or worker grant was added. Server route guards retain buyer/seller/admin authorization. `verify_receipt_content.sql` exercised actual web-role inserts/reads/content updates and asserted excess privileges absent inside a rolled-back transaction. A separate query confirmed no probe content remained.

Supabase security advisors reported existing mutable-search-path warnings on four older functions, disabled leaked-password protection, and five inventory RLS/no-policy informational entries. None concerns the two new tables. Financial functions were deliberately left unchanged.

## Render and live build

The earlier automatic deployment `dep-dah89onavr4c73e6skng` failed because `content_assets` and `site_content` were missing. The old build had remained live.

After DB activation, explicitly deployed the approved SHA as **`dep-dah8k1p42hec73f921sg`**, live at **2026-09-10 10:44:59 UTC**. `/api/preview/meta` independently reports the exact SHA; hosted JS and CSS hashes equal the local build:

- `/preview/assets/index-BS7DFdSQ.js`
- `/preview/assets/index-DkD8CdbB.css`

Root and preview return 200, as do health, readiness and public content. Hosted runtime/security smoke: **11/11** after deployment. Readiness identifies `siton_web_runtime` and `siton_inventory_rpc_v1`. No post-deploy error logs were returned in the inspected windows. Docker startup is `start:web:prod`; migrations do not run during boot.

The final documentation/operations commit uses `[skip render]` so pushing the status does not replace the approved application SHA. Render documents this behavior at https://render.com/docs/deploys#skipping-an-automatic-deploy .

## Hosted acceptance evidence

Two dedicated synthetic server-session sellers (`acceptance-20260910-1` and `acceptance-20260910-2`) logged in through the real API. Random credentials and buyer tracking tokens exist only in ignored local artifacts; they are not part of this report or any commit.

**21/21 executed hosted API checks passed**, including:

- Seller business profile, image upload/replacement/readback, public name and About persistence.
- Five real drafts and receipt configurations, cross-seller draft refusal, draft exclusion from public statistics.
- Published all five methods, verified public pre-join summaries and private-link omission, and verified configuration locks with 409 responses.
- Five mock joins returned participant-bound tracking tokens. Each buyer initially had no entitlement and public-name opt-in was false. The database independently contained zero fulfillment units for these preeligible buyers.
- Cross-buyer token misuse returned 403; anonymous entitlement reads returned 401. Opt-in disclosed only the first name and could be withdrawn.
- Anonymous and seller callers could not read or mutate admin CMS. Invalid receipt search was safe; a foreign seller could not redeem; the correct seller could not redeem a noneligible buyer.

After explicit user confirmation, all five deals followed the existing API `close_joining → prepare_charging → charging/start`, each operation returning 200. The real worker performed **mock** captures. All five reached CompletionWindow with ChargedSuccess buyer/money states. Their unmodified 24-hour completion windows end **2026-09-11 15:27:34–15:27:43 UTC** (18:27 Israel time). The timer was not shortened and no forced state transition was used. Five additional hosted checks confirmed entitlement is still withheld during CompletionWindow; live SHA and the real-money guard were rechecked. Successful issuance and redemption therefore remain open on these hosted fixtures.

| Method | Synthetic deal ID |
|---|---|
| QR | 807923e5-0e4b-509c-969a-88d890ce515b |
| Code | f68da479-b80c-57c4-803c-635a5c0621b7 |
| Name + phone | 4845c4bf-0be6-564b-a26e-efdc723abc83 |
| Digital link | 7ed73be0-5bda-5c4b-a94c-14b6a747c3b1 |
| Instructions | fe6c344e-6e76-5322-91b6-9854de6bb227 |

**Browser:** 30 actual hosted screen visits at 390/430/1440px, all RTL with zero horizontal overflow. Fifteen are public landing/deal/seller-profile/About/terms visits; the other fifteen prove seller/admin login gates, **not authenticated seller/admin screens**. Public seller logo, About, five-deal history, zero completed count and unavailable success percentage rendered correctly. Five deals do not exercise multi-page navigation. Terms remain in the Siton shell. Screenshots were visually inspected. Hosted social icons independently measured 24×24px, buttons 46×46px, centered, with correct five-network colors at all three widths.

The older `r6_hosted_browser_proof.cjs` returned 1 pass/5 failures because it assumes Mall-on and obsolete login selectors. Staging intentionally reports `public_mall_enabled:false`. Current landing/direct-deal checks replaced those assertions; Mall was not enabled to satisfy the old test.

The server-session API login does not unlock the current React seller UI, which requires a Supabase session. No client auth state was forged. A local path to dedicated Supabase seller/admin credentials was requested but not supplied.

## Local verification and camera

Receipt/content DB integration: **13/13**, including all methods, successful issuance, failed/refunded refusal, buyer/seller isolation, concurrent/idempotent redemption, CMS persistence/revision conflicts, legal updates, image storage and chat constraints. These are local DB results, not hosted success claims.

Real React components with deterministic local API fixtures passed at 390/430/1440px: all eight receipt/content screens, title above body, 80-character enforcement, taller message body, five method controls, CMS preload/edit submission, legal headings, no overflow. Local fake-device camera permission and denied-permission fallback passed; typed entry stayed available; generated QR data round-tripped through real jsQR decoding. This does not prove physical optics or the authenticated hosted scanner.

**PHYSICAL DEVICE CAMERA ACCEPTANCE: OPEN**

Backend/frontend TypeScript and web/demo/mobile builds passed. Backend enforcement/secret/control-byte/payment/runtime-DDL/architecture scans passed. Static route gate: 213 routes, 127 protected, zero unguarded; behavioral authorization: 635 probes, zero gaps. Web bundle size warning remains nonblocking.

The initial complete run passed 189/195 executed files, discovered six environment-related failures (missing generated mobile bundle and subprocess restrictions), and timed out before the e2e group executed. The affected six files plus all 13 e2e files then passed **19/19** with the necessary subprocess access. A file-by-file inventory comparison confirmed **208/208 test files have passing results, zero missing, zero unresolved failures**. This is a consolidated full run plus corrective rerun, not one uninterrupted 208/208 invocation. No runtime product patch was needed. Final enforcement, secret, control-byte, payment, runtime-DDL and architecture scans remained green.

## Open acceptance and next step

1. After the completion windows expire, verify eligible hosted artifacts, private digital link delivery, all successful receipt modes, duplicate/concurrent redemption, refunded/failed refusal and foreign-code privacy. Retain these synthetic fixtures for that continuation.
2. Use dedicated Supabase seller/admin logins for authenticated browser flows and CMS headline/subtitle/image/About/legal edits, reload persistence and revision conflict protection. Server-session API checks and local fixtures do not close this requirement.
3. Physical-device camera acceptance remains open independently.

LOCAL IMPLEMENTATION: 100% milestone; STAGING DEPLOYMENT: 100%; HOSTED ACCEPTANCE: approximately 50% (planning estimate, gate still open); PHYSICAL DEVICE CAMERA ACCEPTANCE: 0%/OPEN; REAL MONEY READINESS: 0%/NOT COMPLETE.

Ignored local evidence in the acceptance worktree: `.tmp_staging_full.log`, `.tmp_staging_rerun.log`, `.tmp_hosted_acceptance.log`, `.tmp_hosted_browser_results.json`, `.tmp_hosted_detail_results.json`, `.tmp_receipt_camera.log`, `.tmp_migration_proof.log`, and `.tmp_current_hosted_shots/`. Credential-bearing `.tmp_hosted_facts.json` must not be published.
