# SITON Architecture Rebase — Stage R1 Supabase Staging

**Work date:** 2026-08-27

**Starting Git baseline:** `master == origin/master == 7797ee95c5ff10d3b303f80d6c1ff32c8a347a2c`, divergence `0/0`, clean, no stash, one worktree

**Current authority:** `BASE44_ACTIVE`

**Target status:** `NEW_SUPABASE_STAGING_NON_AUTHORITATIVE`
**R1 status:** blocked before hosted project creation; no existing Supabase project was modified

## 1. Staging project metadata

| Field | Result |
|---|---|
| Requested name | `siton-staging` |
| Created | **No** |
| Project ref | Not allocated |
| Region | Planned `eu-central-1` / Central EU (Frankfurt) |
| Database version | Not available until project creation |
| Creation timestamp/status | Not created |

Frankfurt is the explicit target because it is the common specific region available for the planned Render service and Supabase project and is the nearest common listed region to the Israeli user base. Supabase documents `eu-central-1` as Central EU (Frankfurt), and Render currently lists Frankfurt as a service region: [Supabase regions](https://supabase.com/docs/guides/platform/regions), [Render regions](https://render.com/docs/regions).

The installed Supabase plugin was present but exposed no callable Supabase project/database tools in this session. No local Supabase CLI session, management token, or Supabase environment credential existed. The Base44 Supabase OAuth token is backend-only and was deliberately not exposed. Creating a project without a secure callable connection would require a password/token in command output or an unauthorized Base44 mutation, so execution stopped at that boundary.

Explicit exclusions remained intact: `siton-stage31` (`nqgbqbqextiryqqpggju`) was read only; inactive `siciwktgeyftnqhhaall` was not restored; production Supabase was not written.

## 2. Canonical migration inventory and counts

The repository has exactly **45 portable SQL migrations**. Canonical order comes from `scripts/migration_manifest.cjs`, not lexical filename order:

1. `014` — `014_demo_preview_bootstrap.sql`
2. `007` — `007_db_alignment_phase1.sql`
3. `008` — `008_db_enforcement_phase2a.sql`
4. `009` — `009_db_enforcement_phase2c.sql`
5. `010` — `010_runtime_contract_hard_checks.sql`
6. `011` — `011_outbox_status_processing_fix.sql`
7. `012` — `012_payment_attempts_idempotency.sql`
8. `013` — `013_payment_attempts_not_null.sql`
9. `014a` — `014a_product_account_prerequisites.sql`
10. `015a` — `015_notifications.sql`
11. `015b` — `015_seller_ownership_alignment.sql`
12. `016` — `016_delivery_method_persistence.sql`
13. `017` — `017_open_production_seller_auth.sql`
14. `018` — `018_invoice_documents.sql`
15. `019` — `019_platform_fee_money_events.sql`
16. `020` — `020_drop_affiliate_legacy_columns.sql`
17. `021` — `021_seller_payout_rail.sql`
18. `022` — `022_drop_deals_commission_rate.sql`
19. `023` — `023_invoice_rail.sql`
20. `024` — `024_payment_provider_production_hardening.sql`
21. `025` — `025_invoice_provider_morning_adapter.sql`
22. `026` — `026_participant_delivery_snapshot.sql`
23. `027` — `027_deal_images.sql`
24. `028` — `028_seller_profiles.sql`
25. `029` — `029_notification_rail.sql`
26. `030` — `030_legal_acceptances.sql`
27. `031` — `031_otp_rail.sql`
28. `032` — `032_deal_chat_messages.sql`
29. `033` — `033_seller_enforcement_status.sql`
30. `034` — `034_operational_cases.sql`
31. `035` — `035_admin_control_plane.sql`
32. `036` — `036_security_identity_tracking.sql`
33. `037` — `037_admin_intervention_and_storage.sql`
34. `038` — `038_deal_types_voucher_ticket.sql`
35. `039` — `039_webhook_processing_status.sql`
36. `040` — `040_outbox_worker_leases.sql`
37. `041` — `041_join_idempotency_key_ownership.sql`
38. `042` — `042_single_use_otp_consumption.sql`
39. `043` — `043_deal_image_checksums.sql`
40. `044` — `044_storage_cleanup_tasks.sql`
41. `045` — `045_operational_recovery.sql`
42. `046` — `046_distributor_measurement_surfaces.sql`
43. `047` — `047_infrastructure_change_audit.sql`
44. `048` — `048_internal_identity_sessions.sql`
45. `049` — `049_mall_discovery_read_model.sql`

An isolated fresh local PostgreSQL proof produced **63 `siton` tables including `migration_ledger`** (62 business/operational tables), 15 functions, 12 non-internal triggers, 899 constraints, 210 indexes and 56 foreign keys. The source includes schema creation, state guards, idempotency, append-only audit, outbox/fencing, money, seller, participant, delivery, fulfillment, notifications, invoice, payout, deal type, Mall/discovery, OTP and identity prerequisites.

These are local portability counts. Hosted Supabase actual counts are unproven because the new project does not yet exist.

## 3. Migration ledger proof

`npm run test:migrations-isolated` passed on a disposable local database:

- fresh install: pass;
- 45/45 ledger rows succeeded;
- manifest order: pass;
- SHA-256 checksums: pass;
- second/replay run: pass;
- isolated drift: 0;
- production changes: 0.

The non-isolated `npm run ci:migrations` correctly rejected the workstation's historical local database at migration `045` for checksum mismatch. It was not used as R1 evidence and was not repaired or reset. This demonstrates fail-closed ledger behavior, not canonical source drift. Hosted staging ledger/replay/drift remain unproven.

## 4. Canonical inventory assets

The Stage31 Base44 provisioner and RPC sources were read without invoking their mutating actions. `scripts/extract_base44_inventory_sql.ps1` deterministically extracted them into `supabase/staging/001_siton_inventory_v1.sql` (SHA-256 at extraction: `ee1ad644f142aadb40db84b1ef8557e65f39b023ed88c9000d4d67af7fe539ad`).

Assets:

- five tables: `inventory_deals`, `inventory_reservations`, `inventory_action_idempotency`, `deal_state_audit`, `participant_state_audit`;
- three partial/lookup indexes in addition to primary/unique/FK indexes;
- two append-only mutation-rejection trigger functions and two triggers;
- `error_result`, `reclaim_expired`, and `reservation_snapshot` internal functions;
- `public.siton_inventory_rpc(text,jsonb)` for `sync`, `close`, `hold`, `commit`, `release`, `lookup`, `reservation_status`, `status`, and `probe`;
- transactional row locks/advisory locks, immutable thresholds, capacity checks, idempotency payload mismatch guards, atomic commit/audit/target transition, hold expiry and close guards;
- fixed `search_path` on every inventory function;
- RLS enabled on all five tables;
- all schema/table/sequence/function access revoked from `PUBLIC`, `anon`, and `authenticated`;
- RPC execute granted only to `service_role`; internal helpers are not executable by browser roles or `service_role`.

The extracted source is complete in Git, but it has not been applied to a new project.

## 5. RLS and grants model

`supabase/staging/003_browser_fail_closed.sql` is the initial core security boundary. It revokes schema, table, sequence and function privileges from `PUBLIC`, `anon`, and `authenticated`, revokes equivalent default privileges, and enables RLS on every ordinary/partitioned `siton` table. It intentionally creates no permissive policies.

| Role | `siton.*` | `siton_inventory.*` | Intended use |
|---|---|---|---|
| `anon` | no direct access | no direct access/RPC | Auth/public client only; business reads/writes through Render |
| `authenticated` | no direct core access | no direct access/RPC | identity assertion only; authorization stays in Render |
| `service_role` | not the preferred core DB writer | inventory RPC execute only | server-side use only if an adapter genuinely requires it |
| `postgres`/migration admin | full administrative access | full administrative access | migrations, recovery and controlled inspection only |
| future Render DB roles | not created in R1 | not created in R1 | least-privilege web/worker roles in a later implementation gate |

Authentication is not authorization. No browser CRUD policy exists for deals, participants, money, inventory, audit, outbox, payments or payouts.

## 6. Auth foundation

`supabase/staging/002_auth_identity_foundation.sql` adds nullable, unique `auth_user_id` bindings to:

- `siton.seller_accounts`;
- `siton.admin_users`;
- `siton.affiliate_accounts` (distributor identity).

Each binding references `auth.users(id)` and becomes `NULL` on auth-user deletion so business/audit rows are retained. The migration creates no auth user and imports no credentials. Existing server-authoritative seller/admin/distributor session tables remain migration compatibility evidence until the Render auth adapter replaces them.

Buyer guest/session + OTP remains intact. No buyer `auth_user_id` is introduced and full buyer registration is not required.

## 7. Storage foundation

`supabase/staging/004_deal_images_bucket.sql` reconstructs a private `deal-images` bucket with:

- `public = false`;
- 2 MiB object limit;
- MIME allowlist `image/jpeg`, `image/png`, `image/webp`;
- no browser Storage policies in R1.

Supabase documents S3-compatible standard uploads, deletes and AWS SigV4 presigning, and private objects can be delivered by signed URL: [S3 compatibility](https://supabase.com/docs/guides/storage/s3/compatibility), [private/signed downloads](https://supabase.com/docs/guides/storage/serving/downloads). S3 object versioning is not supported, so deletion/cleanup must remain explicit and auditable.

Live R1 created the private `deal-images` bucket in `siton-staging` with a 2 MiB limit and no synthetic object. The repository upload constant and focused tests now use the same 2 MiB limit, matching the current Base44 seller-image contract and the staging bucket before R2 product traffic.

## 8. Inventory 7/7 reproduction

Stage31 source describes seven checks: RPC probe, sync/idempotency, hold replay, commit/audit/target/mismatch, release/status, a 20-attempt last-unit race, and close guards. It proves one winner and 19 `inventory_exhausted` responses in the proof project.

**New `siton-staging` result:** not run. Therefore inventory 7/7, the 20-participant race, synthetic cleanup and zero-residue evidence do not pass R1.

## 9. Money-rule synthetic proof

No provider was called. Local payment tests passed 24/24 and explicitly proved:

- platform fee exactly 8%;
- delivery/shipping included in the charged gross/fee base;
- VAT tracked separately and not deducted from that fee base;
- distributor attribution creates no money rail, commission or payout entitlement;
- synthetic provider paths only; no Grow call or real authorization/charge/refund.

This is valid source/domain evidence, not a hosted-money activation.

## 10. Base44 data census summary

The binding detail is in `docs/BASE44_DATA_MIGRATION_CENSUS_R1.md`.

- 31 queryable canonical types checked;
- 36 total live records;
- heuristic classification: 6 real, 0 test, 30 system/proof/scaffold;
- 4 source-only/unavailable canonical types;
- 25 PascalCase/kebab duplicate pairs;
- no PII values exported or committed;
- Base44 writes/deletes: 0.

## 11. Drift report

| Boundary | Result |
|---|---|
| Git migration manifest vs files | 45/45, pass |
| Disposable local fresh install/replay | pass, drift 0 |
| Stage31 inventory source vs extracted Git SQL | deterministic extraction, static contract 7/7 pass |
| Hosted `siton-staging` expected vs actual | unavailable; project not created |
| Local historical DB vs current checksums | mismatch at `045`; quarantined from evidence |
| Storage size contract | resolved at 2 MiB across bucket, application constant, and focused tests |

## 12. Security advisor results

Not run: there is no new Supabase project. No finding is falsely classified as fixed.

Expected review categories after creation:

- `rls_enabled_no_policy` on core tables: **INTENTIONAL** while browser access is fully denied;
- inventory `function_search_path_mutable`: expected **0**; any occurrence is **FIX**;
- any broad `anon`/`authenticated` core grant or permissive policy: **FIX**;
- unrelated extension/platform observations: classify individually only after live output exists.

## 13. Performance advisor results

Not run: there is no new Supabase project. Unused-index, duplicate-index, FK-index, RLS-plan or connection observations cannot be classified without live advisor output and representative staging use. All remain **DEFER — REQUIRES LIVE EVIDENCE**, not waived.

## 14. Future Render database connection model

Use the same Frankfurt region for Render web/worker and Supabase. For migrations, backup and administrative work, use a direct connection when IPv6 is reachable. For persistent Render services on an IPv4-only path, use Supavisor **session mode on 5432**; transaction mode is unsuitable for this code where session settings, advisory locks or prepared-statement behavior matter. Supabase's current connection matrix documents these distinctions: [Connect to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres).

- Separate small application-side pools for web and worker; start conservatively and reserve capacity for Supabase Auth/Storage/PostgREST and administration.
- Enforce TLS/SSL certificate verification.
- Use `DATABASE_URL` and `DB_SCHEMA=siton` for server database access.
- Use `SUPABASE_URL` plus a publishable/anon key only where browser Auth is needed.
- Keep `SUPABASE_SERVICE_ROLE_KEY` server-side and omit it entirely if direct DB roles plus Storage S3 credentials cover the actual adapters.
- Never place connection strings or credentials in Git, docs, status files or test output.

## 15. Rollback and rebuild procedure

Once a project connection is available, the intended deterministic rebuild is:

1. create a fresh `siton-staging` project in Frankfurt and record non-secret metadata;
2. run the repository's 45-migration runner against the direct/session-safe connection;
3. rerun it and verify the 45-row checksum ledger;
4. apply `supabase/staging/001_siton_inventory_v1.sql`;
5. apply `002_auth_identity_foundation.sql`;
6. apply `003_browser_fail_closed.sql`;
7. apply `004_deal_images_bucket.sql`;
8. execute `verify_r1_foundation.sql`, schema contract, advisor review and synthetic proofs;
9. remove synthetic non-audit rows and retain only explicitly intended audit evidence.

All business-critical schema/config source is now in Git. The operational answer to “can the deleted staging project be fully reconstructed?” remains **not yet proven** until this sequence succeeds on an actual fresh project.

## 16. Exact blockers

1. A secure callable Supabase connection is unavailable in this session, so `siton-staging` could not be created.
2. Consequently no hosted migrations, inventory SQL, Auth binding, RLS/grants or Storage bucket were applied.
3. Inventory 7/7 and the 20-participant race were not reproduced on new staging.
4. Security/performance advisors were not run.
5. Hosted counts, database version, replay ledger, drift and cleanup are unavailable.
6. Resolved in live R1: application upload validation and the private staging bucket both enforce 2 MiB.

## 17. R2 entry criteria

R2 must not start until R1 is resumed with an authenticated Supabase app/CLI channel and all R1 live gates pass. Exact continuation:

1. expose the already-installed Supabase app to the session (or provide a securely authenticated CLI without putting secrets in chat/logs);
2. create only `siton-staging` in Frankfurt;
3. apply and prove the Git rebuild sequence above;
4. run inventory 7/7 plus 20-way race and cleanup;
5. run and classify every security/performance advisor finding;
6. run the full repository suite and close Git on the resulting evidence;
7. only then authorize R2 separately. Do not deploy Render or migrate Base44 data during this closure.

## Safety firewall accounting

| Action | Count |
|---|---:|
| Grow calls | 0 |
| Payment authorization / charge / refund | 0 / 0 / 0 |
| Real SMS / email / invoice / payout | 0 / 0 / 0 / 0 |
| Base44 writes / deletes | 0 / 0 |
| Production Supabase writes | 0 |
| Stage31 writes | 0 |
| New staging writes | 0 (project not created) |

## Repository verification

- The initial restricted `npm run test:all` invocation discovered 143 files. It reported `groups_passed=8`, `groups_failed=2`, `duration_ms=490598`; the failed groups were `failure` and `e2e`.
- The restricted-run failures were process-launch denials, not product assertion failures: `web_sigterm_fault_process_validation.ts` and `frontend_browser_v11_validation.ts` returned Windows `spawn EPERM`; the browser smoke also failed only within the grouped restricted context.
- In a permitted local child-process context, the entire `failure` group passed **9/9** in `52283 ms` and the entire `e2e` group passed **13/13** in `113281 ms`. The browser smoke independently passed as well. Combined exact-tree evidence therefore covers **143/143 files**, but no false claim of a single consolidated 10/10 invocation is made.
- Focused R1 security-foundation checks passed **7/7**; selected security execution passed **1/1**; database **5/5**, concurrency **4/4**, payments **24/24**, and security **15/15** passed.
- Isolated migrations passed **45/45**, including fresh install, repeat, checksum ledger and drift zero. Test TypeScript and diff hygiene passed. The historical local database checksum mismatch at `045` remained untouched and excluded from proof.
- None of these local results substitutes for the missing hosted Supabase staging proof.

## Verdict

`R1_BLOCKED`
