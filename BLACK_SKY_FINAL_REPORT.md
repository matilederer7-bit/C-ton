# Black-Sky Final Report

Date: 2026-09-27 · Branch `claude/festive-wright-kx4e5a` · PR [#99](https://github.com/matilederer7-bit/C-ton/pull/99) · Base `d186153` (master after PR #98)

Mission: prepare Siton for the day several things fail at once, with no systemic collapse, no money or data loss, recovery possible, and fail-closed behaviour whenever money is uncertain. Method per finding: FIND → PROVE → BREAK SAFELY → FIX → TEST → ATTACK AGAIN → RESTORE → VERIFY. No real money was moved. No production system was attacked. Every destructive or chaos exercise ran on disposable local databases only.

This report does not claim Siton is "secure" or immune to disaster. It lists what was found, what was changed, what proves it, and what can still hurt.

---

## 1. Summary

| | |
|---|---|
| Findings in the ledger | 74 (DR/secrets E1–E11, resilience F-H1…F-L2, DoS C1–C14, web/auth B1–B10, DB D1–D12, money A-F1…A-F9, plus BSC-1 found by the chaos suite and the seller-login race found by CI) |
| Fixed in code with a regression test | 65 (incl. BSC-2 from the post-merge Codex review) |
| Fixed in code, residual needs an owner check | 4 (B2, E2, E5 deploy, E1 provisioning) |
| Deliberately not changed (documented) | 4 (D11 DB guard, C12 shared limiter store, D12 web outbox delete, C13 already bounded) |
| Owner-only actions | listed in §7 |
| New migrations | 077, 078, 079 (all additive; 072 total ledger entries) |
| Combined-failure scenarios | 7 suites / 10 scenarios, all passing |
| Recovery proof | `RECOVERY_PROOF_PASS` (real worker SIGKILLed mid-capture, second worker recovers, 34/34 money invariants) |
| Backup/restore rehearsal | `DB_BACKUP_RESTORE_REHEARSAL_PASS` (18 steps, per-table content hashes, grant diff, negative control) |
| Test suite | 300+ files across 10 groups plus 199 release-tool tests, green on the integrated head (§6) |

Every "failing before" claim below was observed by running the new test against the pre-fix code, not inferred.

---

## 2. Threat model (short)

The full model is `docs/BLACK_SKY_THREAT_MODEL.md`: assets, actors, 14 combined-failure scenarios the system is designed to survive and 13 it is not.

- **Assets:**
  - buyer card authorizations and captures;
  - the fee ledger (8% of the amount actually collected, including shipping and every purchase component, excluding VAT; no distributor commission);
  - seller settlements and payouts;
  - audit history;
  - buyer PII.
- **Actors:**
  - an anonymous internet attacker (rate, ReDoS, spoofed headers);
  - a malicious buyer (foreign payment methods, OTP reuse);
  - a malicious or compromised seller (deal churn, uploads, deletion);
  - a forged or replayed provider callback;
  - an insider or compromised credential;
  - a buggy deploy or migration;
  - infrastructure failure: DB, Render, Supabase, Grow.
- **Invariant priorities:**
  1. never move money without proof;
  2. never lose a money record;
  3. never guess an unknown outcome (open a case instead);
  4. stay recoverable;
  5. stay available.

---

## 3. Findings ledger

Format per row: **THREAT/FAILURE** · PROOF · SEVERITY · BEFORE → FIX · TEST · RECOVERY · STATUS · RESIDUAL RISK.

### 3.1 Money and state integrity

| ID | Threat / failure | Sev | Before → Fix | Test (failing before → after) | Status / residual |
|---|---|---|---|---|---|
| A-F1 | A seller pauses a deal below its threshold, so it escapes the deadline and can be charged below the minimum | HIGH | `deadline_check` returned before deferring for non-open states, and `prepare_charging` had no threshold check → deferral now happens before the state filter, a paused deal below threshold fails at the deadline (new edge ClosedForJoining→Failed, migration 077), and prepare refuses below threshold with 409 | `db_deal_deadline_threshold_validation` 4 fail → 7/7; chaos `black_sky_deadline_pause` | FIXED |
| A-F5 / D4 | Joins and authorizations accepted after the deadline | MED | No deadline check → both refuse after the deadline (DB clock) under the deal lock with 409 `deal_deadline_passed` | same file, plus chaos variant 3 | FIXED |
| BSC-1 | A signed webhook naming an unknown operation marks a buyer charged with no provider capture | HIGH | Resolution fell back to participant_id → an unverified correlation can be ignored but can never move money (`unverified_correlation`) | chaos C1b (pinned defect → strict PASS); late-event suites still "ignored" | FIXED (found by the chaos suite) |
| BSC-2 | A stalled webhook processor wakes after a stale reclaim and overwrites the new claimant's terminal status (processed → failed), making the event re-claimable and re-running money reconciliation | P2 (Codex review on PR #99, after merge) | The A-F3 reclaim had no claim fencing → every claim stamps a fresh `claim_token`; `markEvent` is a compare-and-set on (`processing`, token), so only the current claimant can finish; the sweep clears the token | `webhook_stale_processing_reclaim` fencing cases 7 fail on the pre-fix code → 12/12 | FIXED in the follow-up PR (no migration: the token lives in `payload_jsonb`) |
| A-F2 | Recovery capture after the completion window; finalize without a lock | MED-HIGH | The arm step did not re-check the deal → a deal gate under `FOR SHARE`, and finalize locks the deal and re-checks inside its transaction | `payment_black_sky_recovery_window_gate` 3 fail → 4/4 | FIXED |
| A-F3 | Webhook stuck in `processing` after a worker crash is swallowed forever | MED | No reclaim → a stale claim is re-claimable by exactly one redelivery, plus a maintenance sweep | `webhook_stale_processing_reclaim` 3 fail → 5/5 | FIXED |
| A-F4 | Another buyer's payment method is accepted and ownership reassigned | MED (confirmed) | `ON CONFLICT SET buyer_id` → 409 `payment_method_not_owned`, and ownership is never reassigned | `payment_method_ownership` attacker 200 → 5/5 | FIXED; the recovery-route 409 has no route-level test |
| A-F6 | Refund ledger recomputes VAT from the live environment | LOW-MED | Refund ≠ −charge after a VAT change → the refund row is the exact negation of the charge row | `platform_fee_refund_negates_charge` 54.40 vs −57.11 → 3/3 | FIXED |
| A-F7 / F7 | Payout outcome unknown treated as not executed; re-dispatch | HIGH (latent) | createPayout could run twice → a fixed correlation per batch, unknown stays `processing` with a case, re-dispatch only looks up, operator attestation action (079, dual approval, MFA) | `seller_payout_rail_race` all pass; `admin_payout_dispatch_attestation` 4/4 | FIXED |
| D5 | Settlement upsert unconditional; status can go backwards | MED | No lock, no guard → an advisory lock per deal, conditional upsert, forward-only triggers, monotonic amounts, amount CHECKs (077) | payout race suite; chaos `black_sky_settlement_combo` | FIXED |
| A-F8 | A capture webhook's amount/currency is not compared | LOW | 1-agora capture accepted → a mismatch opens a case and moves nothing | `webhook_capture_amount_mismatch` 3 fail → 5/5 | FIXED |
| A-F9 | A refund is possible on a non-failed deal | LOW | No gate → `refund_issue` only on Failed (`cancel_refund`: Failed/Cancelled); otherwise a case | `payment_refund_deal_state_gate` → 3/3 | FIXED |
| D1 | Fee ledger has no sign/arithmetic CHECKs | HIGH | Detected only by the invariants CLI → sign/arithmetic enforced by the invariants checker; payout-side CHECKs in 077 | `db_money_invariants_validation` 6 cases | FIXED (detective control for fee rows; preventive for payouts) |
| D11 | ChargedSuccess/Refunded without a successful attempt | LOW-MED | — | invariants `participant.charged_state_has_successful_capture` | DOCUMENTED: a DB guard would break 43 fixtures; the invariants checker detects it. Gap: `Refunded` is not covered by an invariant |

### 3.2 Database doomsday

| ID | Threat | Sev | Fix | Test | Status |
|---|---|---|---|---|---|
| D2 | Deleting a deal cascades away fee events, attempts, settlements, payouts and audit | HIGH | 12 money FKs set to ON DELETE RESTRICT, plus a BEFORE DELETE guard: only untouched Draft/Cancelled/PendingTarget deals can be deleted (product behaviour kept); test-only escape hatch that is off for runtime roles and audited | `db_black_sky_integrity` 17 fail → 20/20 | FIXED |
| D3 | `test.%` actions accepted in production; outbox requirement keyed by action | MED | `test.%` only under `siton.allow_test_actions=1` (test DBs only); outbox requirement also keyed by transition | same | FIXED |
| D8 | Readiness ignores disabled triggers; payment-lifecycle triggers not in the contract | MED | Contract fails closed on `tgenabled` ∉ {O,A}, includes the 067/068/077/078 triggers, and refuses DELETE/TRUNCATE for runtime roles on 18 money tables | `schema_contract_manifest` | FIXED |
| D9 | Issued invoices mutable; web may UPDATE identity columns | MED | Issued-invoice immutability, one issued receipt per participant, immutable identity columns, staging grant file 027 narrows web UPDATE | same, plus route privilege sweep | FIXED |
| D10 | Price/delivery unchecked; seller_id and delivery editable after money | LOW-MED | CHECKs, frozen seller_id after publish, frozen delivery once charging starts | same | FIXED |
| D12 | NOT VALID constraints; self-signup cap race | LOW | Validated (warn on legacy); cap serialized with an advisory lock | `seller_self_signup_cap_race` 10/12 bound → exactly 3 | FIXED; web DELETE on outbox kept (draft-delete needs it) |
| D6 / D7 | Migration runner: no lock, ledger outside the transaction, no lock_timeout | MED | Advisory runner lock, atomic ledger row for non-self-transacting files, `lock_timeout`/`statement_timeout`, doctor fingerprint verdict, `--clear-running` repair | `migration_runner_hardening` 7/7; chaos `black_sky_migration_crash` | FIXED |

### 3.3 Web, auth and DoS

| ID | Threat | Sev | Fix | Test | Status |
|---|---|---|---|---|---|
| C1/B1 | Multipart parser quadratic regex: about 25 minutes of CPU per 8 MB | CRIT | Form parsing only on the Grow callback, 64 KB, linear parser | `security_multipart_redos` (320 KB 2360 ms → linear) | FIXED |
| C2 | Nested pool checkout deadlocks the web pool | CRIT | Schema checks memoized and hoisted out of transactions | `security_pool_nested_checkout` (deadlock at max=2 → pass) | FIXED |
| C3/C4/B3 | Rate-limit bypass via percent-encoding, the /api alias, IPv6 rotation; unbudgeted payments/logins | HIGH | Normalized classification, stricter-wins alias check, IPv6 /64 key, new budgets | `security_rate_limit_bypass`, `rate_limit_classifier` | FIXED |
| C4 (owner decision C) | Seller mutations throttled by the 20/min public bucket | — | Seller-mutation budget keyed by identity: 90/min per seller plus 150/min per IP; no identity → tight bucket; authorize shares the join budget | `rate_limit_seller_mutation` 8/8 (90-edit burst with zero 429; per-seller refusal; IP ceiling) | FIXED |
| — | Seller login lockout race (found by CI) | HIGH | 401 sent before COMMIT; parallel guesses all verified → per-account advisory lock | 12 parallel guesses verified → exactly 3; 3 consecutive passes | FIXED |
| B4/B5 | Login existence oracles (429 vs 401, timing) | MED | Identical 401; dummy hash on every path | `security_login_oracle_and_cookie` | FIXED |
| B9 | Malformed cookie → 500 | LOW | Cookie parsers made total | same | FIXED |
| C5 | Global caps on support/inquiries/feedback let one abuser starve everyone | HIGH | Per-IP hourly caps (10/30/30) in front of the global caps; a throttled follow-up now answers 429 | `rate_limit_public_write_caps` 5/5 | FIXED |
| C8 | `/api/payments/status` provider amplifier | MED | Requires the binding's `correlation_id`; foreign or unknown → 404 without a provider call | Grow suite C8 case | FIXED (API contract change) |
| C7/C9/C12 | Unbounded analytics writers; 8 MB global body; no request timeout | MED | Analytics budget; 1 MiB global body (8 MiB only on uploads); 60 s request timeout; IPv6 /64 | classifier suites | FIXED; limiter is per-instance (see §8) |
| C11 / F-H4 | Readiness hits the DB on every probe; a DB blip restarts the service | HIGH | Cached verdict (5 s), 3 s timeout with single-flight, 60 s transient grace; schema/role failures still fail | `readiness_probe` 11 + `readiness_http` 2 | FIXED |
| C14 | Mall query cast defeats the state index | LOW | `= ANY($1::deal_state[])` | 1518 → 13 buffers | FIXED |
| B2 | Owner-e-mail claim via unverified JWT → SuperAdmin; conflict re-activates | HIGH | Refuse anonymous/unverified; pinned `SITON_OWNER_AUTH_USER_ID` on hosted runtimes; never flips status | `security_black_sky_identity_config` | FIXED; residual UNCONFIRMED: Supabase "Confirm email" setting (owner) |
| B6 | OTP challenge id reusable; join accepts the id alone | MED | Signed token required; bound to destination/purpose; locked to the first deal | same | FIXED |
| B7 | Share page og:url from the Host header and publicly cached | LOW | Configured origin; `no-store` fallback | `seller_upload_quota_share_origin` | FIXED |
| B8 | Unbounded seller uploads | LOW-MED | Per-seller count/byte quotas under lock, checked before storage | same | FIXED |

### 3.4 Resilience and observability

| ID | Threat | Sev | Fix | Test | Status |
|---|---|---|---|---|---|
| F-H1 | Grow malformed 2xx or 401/403/404 treated as final failure | HIGH | Unknown outcome (dispatched) with `configuration_fault`, which is now kept through `executionResult`; pre-settle 400/422 is a bounded retry | `grow_payment_adapter_unknown_outcome`, `payment_grow_black_sky_leftovers` 8 fail → 12/12 | FIXED |
| F-H2 | Outbox retry budget about 10 s, so a 30 s outage sends every money event to the DLQ | HIGH | Per-class jittered budgets (money 30 s → 15 min, 8 attempts); unknown event types deferred, not DLQ | `workers_retry_policy_alerting` 16 | FIXED |
| F-H3 | Web logger has no error serializer (PII in logs) | HIGH | `errorLogSerializer`; req serializer order kept for the logging gate | `security_web_logger_scrub` | FIXED |
| F-H5 / F-M1 / F-M2 / F-M3 | No pushed alerts, no watchdog, no backoff, no per-job deadline | HIGH/MED | `worker_alert` keys + Sentry, watchdog exit, exponential cycle backoff, enforced per-job deadline with fencing | `workers_*`; chaos `black_sky_catchup_poison`, `black_sky_rolling_deploy` | FIXED |
| F-M4 | JWKS refresh blocks every request for up to 8 s | MED | Stale-while-revalidate, single-flight, 3 s timeout, fail-fast window | `supabase_auth_jwks_cache` 6 | FIXED |
| F-M5 | A Grow callback lookup failure is final | MED | Stored as retryable; bounded status-only sweep of pending bindings | `payment_grow_callback_lookup_retry` 4/4 | FIXED |
| F-M6 | No 401/403/429 counters; admin login failures unrecorded | MED | In-process counters on `/api/admin/system-status`; hashed-e-mail security events | `security_counters` 5 | FIXED; counters are per-process, not persisted |
| F-L1 / F-L2 | Invoice 2xx garbage treated as success; silent reclaim catch | LOW | Unknown → retry with the same key; counted and logged | invoice suites; `outbox_worker_swallowed_error` | FIXED |
| — | Admin tooling hardcoded to 4 attempts | LOW | Shared `outboxEffectiveMaxAttempts` | `admin_outbox_attempt_ceiling` 4 | FIXED |

### 3.5 Disaster recovery, secrets and supply chain

| ID | Threat | Sev | Fix | Status |
|---|---|---|---|---|
| E1 | No off-platform backup; hosted backups unverified | CRIT | Secrets-gated daily encrypted off-site dump workflow (age, sha256 round-trip), rehearsal with content hashes and grant diff | Code DONE; **provisioning is an owner action (§7)** |
| E2 | `SUPABASE_MANAGEMENT_API_TOKEN` readable by the web runtime | CRIT | Web/worker refuse to boot on hosted/production if it is set | FIXED; residual UNCONFIRMED: whether it is set on Render today |
| E3 | Agent workflow commits run repository hooks with a write token | HIGH | Hook-free commits from a clean control checkout (complements open PR #78) | FIXED |
| E4 | Single Grow reference key, no rotation | HIGH | Key ring `v2.<kid>`, reseal script, boot-time validation via the standalone `grow_reference_keyring` module | FIXED |
| E5 | Storage broker can delete/list the whole bucket | HIGH | Namespaced key/prefix enforcement (`scope.ts`) | Code FIXED; **edge function not deployed (owner)** |
| E6 / E7 | Weak restore drill; unguarded destructive scripts | MED | 18-step rehearsal; `destructive_target_guard` on every DB-destroying script | FIXED |
| E8 | Auto-deploy without CI | MED | `autoDeployTrigger: checksPass` | FIXED (takes effect after blueprint sync) |
| E9 | Dev deps in image, tag-pinned base, no audit | MED | Digest-pinned base, `npm prune --omit=dev`, `npm audit` gate, Dependabot | FIXED |
| E10 | OTP token secret falls back to the session secret | LOW-MED | Production requires a distinct `OTP_TOKEN_SECRET` | FIXED |
| E11 | Config outside git undocumented | MED | `docs/CONFIG_INVENTORY.md` | FIXED |

---

## 4. Black-Sky combination tests (2–5 simultaneous failures)

All run on disposable local databases; files `tests/black_sky_*_failure_validation.ts` (failure group).

| # | Combined failures | Expected fail-closed outcome | Result |
|---|---|---|---|
| C1a | Worker killed after claim + provider moved money and answered 503 + webhook replayed concurrently and under a new id | Exactly one capture effect, one fee row, one completion, invariants PASS | PASS |
| C1b | Dead worker + 503 with nothing moved + signed webhook naming a foreign operation | Never charged on foreign evidence (found BSC-1) | PASS after fix |
| 2 | DB backend killed mid-join + two joins racing for the last unit + pool exhausted | No over-capacity, no orphan rows, the survivor completes, process survives | PASS |
| 3 | Deadline passes while paused + concurrent prepare_charging + late join | Failed, prepare 409, join 409, 0 captures, holds released once | PASS (3 variants) |
| 4 | Refund during payout dispatch + payout outcome unknown + re-delivered reconcile | One createPayout, blocking cases, 077 triggers reject regressions | PASS |
| 5 | Migration runner crash mid-file + concurrent runner + readiness during a dirty ledger | Second runner refused, readiness fails closed, doctor/repair restore it | PASS |
| 6 | 2-hour worker outage + mass catch-up + poison event | Poison to DLQ with alert, 20 jobs exactly once, one capture per authorization | PASS |
| 7 | Rolling deploy: unknown event type + DB unavailable + heartbeat failures | Deferred (not DLQ), no exit inside the grace window, watchdog exit beyond it, restart completes exactly once | PASS |

---

## 5. Recovery proof

- **`npm run chaos:recovery-proof`:**
  - guarded to local, freshly created, auto-dropped databases;
  - a real worker is SIGKILLed mid-capture after the money moved;
  - a second worker reclaims the lease and completes.
  - Lifecycle `claim@1(w1) → reclaim@1 → claim@2(w2) → completion@2`, one capture per authorization, money invariants 34 pass / 0 fail → `RECOVERY_PROOF_PASS`.
- **`node scripts/db_backup_restore_rehearsal.cjs` → `DB_BACKUP_RESTORE_REHEARSAL_PASS`:**
  - all 87 tables byte-identical after restore;
  - the same invariant results before and after;
  - `audit_log` stays append-only after restore;
  - grants are re-applied and must match the source exactly;
  - a negative control proves the checker catches exactly the 9 seeded corruptions.
- **`npm run db:money-invariants`:** 37 read-only invariants in one `READ ONLY` REPEATABLE READ transaction, always rolled back. It is the daily reconciliation check (`docs/PAYMENT_RECONCILIATION_RUNBOOK.md`).

---

## 6. Verification

Clean full pass on the final code (local PostgreSQL 16, nothing else running):

| Group | Files passed | Failed |
|---|---|---|
| unit | 17 | 0 |
| db | 13 | 0 |
| workers | 19 | 0 |
| failure (incl. 7 Black-Sky combination suites) | 16 | 0 |
| payments | 57 | 0 |
| concurrency | 10 | 0 |
| api | 53 | 0 |
| security | 61 | 0 |
| e2e | 17 | 0 |
| integration | 50 | 0 |
| **total** | **313** | **0** |

- Release-tool tests: **199/199**.
- `npm run chaos:recovery-proof` → `RECOVERY_PROOF_PASS invariants=PASS pass=34 fail=0`.
- `db_backup_restore_rehearsal.cjs` → `DB_BACKUP_RESTORE_REHEARSAL_PASS`.
- `migration_preflight.cjs` → `MIGRATION_PREFLIGHT_PASS high_water=079 migrations=72`.
- `test:migrations-isolated` → `ISOLATED_MIGRATION_PROOF_PASS fresh_install=pass repeat=pass checksum_ledger=pass drift=0`.
- `release:preflight:static` → technical WARNING (warnings only: legal/route-inventory/supply-chain notes), `REAL_MONEY_ACTIVATION: BLOCKED` by policy, as intended.
- CI on PR #99: see the PR checks on the final head.
- **Independent review:** the "Codex re-review" workflow skips draft PRs; it requested `@codex review` when PR #99 left draft and the merge followed two seconds later. Codex then reviewed head `2d26d53` after the merge and reported one P2 finding (BSC-2, webhook claim fencing), fixed with regression tests in the follow-up PR. The Black-Sky track is marked 100% only after that fix is merged and a fresh Codex review of its head reports no material finding.

---

## 7. Owner actions (cannot be done by an agent)

Full detail: `docs/CREDENTIAL_COMPROMISE_RUNBOOK.md`, `docs/BACKUP_RESTORE_RUNBOOK.md`, `docs/CONFIG_INVENTORY.md`.

1. **Staging DB before the merge deploys:** apply migrations **077, 078, 079**, then `supabase/staging/027_black_sky_db_integrity_grants.sql`. The schema contract fails closed without them. 078 re-adds 12 FKs, so apply it in a quiet window. Never set `siton.allow_test_actions` on staging.
2. **Render, both services:** make sure `SUPABASE_MANAGEMENT_API_TOKEN` is **not** set; hosted services refuse to boot with it. If it ever was set, rotate it.
3. **Render (production-mode runtimes):** add `OTP_TOKEN_SECRET` (random, ≥32 characters, distinct) and, on web, `SITON_OWNER_AUTH_USER_ID` (the owner's Supabase auth UUID). Both are required at boot in production. Staging (`APP_DEPLOYMENT_MODE=staging`) does not require them.
4. **Off-site backups:**
   - provision the `OFFSITE_BACKUP_*` secrets: a read-only role URL, an age public key, bucket name and scoped access keys;
   - keep the age identity offline (two copies);
   - run the workflow once and confirm `OFFSITE_BACKUP_PASS`.
5. **Hosted backups checklist for `siton-staging`:**
   - plan and whether PITR is on;
   - retention and last backup date;
   - whether a restore has ever been done;
   - who can restore, and whether they have MFA.
6. **Supabase:**
   - confirm "Confirm email" is on;
   - set `SITON_BROKER_ALLOWED_PREFIXES` and redeploy the `storage-broker` edge function.
7. **Second SuperAdmin:** create one with a separate MFA device. Payout freeze/unfreeze, emergency pauses and the payout attestation action need a second approver.
8. **MFA:** turn it on for the Supabase, Render and GitHub owner accounts, and keep the backup bucket on a separate account.
9. **Render auto-deploy:** after the blueprint syncs, confirm it shows "After CI checks pass".
10. **GitHub:** enable Dependabot security updates and keep the required checks on master.
11. **Decisions:**
    - alert routing for `worker_alert:*` (no pager exists);
    - a WAF/CDN in front of Render;
    - a backup path for `auth.users` and Storage objects;
    - how to handle a partly charged deal whose charge budget is exhausted.
12. **Legacy service:** delete or reconfigure the orphan Render service `siton-staging-web-atp1`.

---

## 8. What can still kill Siton?

Plainly, the risks this work did **not** remove:

1. **Losing the only database copy.**
   - Until the off-site backup secrets are provisioned and one hosted restore has been performed, recovery depends entirely on Supabase's hosted backups, which have not been verified by us. RPO/RTO are targets, not measurements.
   - `auth.users` and Storage objects are not covered by any dump.
2. **Credential compromise of the owner accounts.**
   - Supabase, Render, GitHub and Grow owner logins can bypass every in-app control.
   - MFA on those accounts and the second-approver setup are owner actions.
3. **Provider truth drift.**
   - Grow real-money behaviour is unproven (F-13 is still a real-money blocker).
   - Unknown outcomes are fail-closed into cases, but cases need a human. A backlog of unresolved cases during a long provider incident is operational risk, not a code guarantee.
4. **Volumetric DDoS.**
   - Rate limits are per-instance and in-process. There is no WAF or CDN.
   - A large enough flood saturates the single web instance regardless of limits.
5. **Single-instance, single-region topology.**
   - One web and one worker instance, in one Render region (Frankfurt) and one Supabase project.
   - A regional outage takes Siton down until the owner rebuilds per `docs/DISASTER_RECOVERY_RUNBOOK.md`.
6. **Human error at the console.**
   - A manual SQL change on the hosted DB with a superuser bypasses triggers.
   - A restore with `--no-privileges` silently drops 321 grants unless the runbook's re-grant step is followed.
7. **Unresolved-case accumulation.**
   - A partly charged deal whose `charge_deal` retries are exhausted has no automatic re-dispatch path; it needs an owner decision.
8. **Fee rows are guarded only by the checker.**
   - Fee-ledger arithmetic is enforced by the invariants checker (detective), not by DB constraints (preventive).
   - `Refunded` without a successful refund attempt is not yet covered by an invariant.

---

## 9. Second Black-Sky pass

After integration, the combined-failure suite, the recovery proof, the rehearsal and the full suite were re-run on the integrated head. The integration exposed four new defects and one reporting issue:

- BSC-1, found by the chaos suite and fixed;
- the seller-login race, found by CI and fixed;
- a never-log `authorization_id` in a new sweep log, fixed;
- the boot guard importing the payment adapter, which broke the isolated no-real-money proof; extracted into a leaf module;
- two agents' fixtures colliding with 078's new outbox requirement. The fixtures were adapted to release the mandated job; no assertion was weakened.

Each has a regression test or gate that failed before and passes after.
