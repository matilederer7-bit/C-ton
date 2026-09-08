# R9C current-master integration candidate

CURRENT MASTER SHA: d4c7877f9b704734036d69f57f7d98f794f4d034
SOURCE REVIEW SHA: 3809b32c11d82e57d6ed106f88dea7a55b76499a
BRANCH: codex/r9c-master-integration-candidate
COMMON ANCESTOR: 8ead7c828e6d6233bf7d17bf7f67d1a67ad35767

## Port manifest (recorded before production edits)

Counts are semantic work items, not files or commits. MUST_PORT=16; ALREADY_PRESENT=3; OBSOLETE/SUPERSEDED=2; MANUAL_RECONCILIATION=3; DO_NOT_PORT=4. Manual items enable the must-port semantics and are not counted twice.

| ID | Classification / correction | Source file = target file unless noted | Symbol | Why required | Targeted tests (tests/, _validation.ts omitted) |
|---|---|---|---|---|---|
| P01 | MUST_PORT: P0 / FFR-1 exact-reference aliases | src/payment_provider.ts | buildProviderReadyPaymentProvider.status / bareReference / referenceMatchesQuery | Foreign xyz- reference must not prove capture | payment_final_reference_collision |
| P02 | MUST_PORT: B2 deterministic voucher/ticket fixtures | tests/deal_types_e2e_validation.ts; tests/payment_final_b2_threshold_validation.ts | B2 / controlled capture identities | UUID-sensitive mock declines made Completed probabilistic | deal_types_e2e; payment_final_b2_threshold |
| P03 | MUST_PORT: Durable operation identity and duplicate-effect fencing | src/payment_attempt_helpers.ts; src/app.ts | beginProviderAttempt / resolvePriorProviderAttempt | Reclaims must reuse/reconcile existing operations | payment_provider_operation_identity_crash; payment_lab_lifecycle_reconcile |
| P04 | MUST_PORT: Pre-I/O lease and dispatch lifecycle CAS | src/outbox_worker_helpers.ts; src/payment_attempt_helpers.ts; src/app.ts | assertLeaseForProviderIo / armMoneyOperation | Stale workers must not dispatch money | payment_r9c_reconciliation_race; payment_lab_concurrency_matrix |
| P05 | MUST_PORT: Owner-fenced settlement SR-1 | src/payment_attempt_helpers.ts; src/app.ts | settleProviderDispatch / settleOwnedMoneyOperation | Late owner may not erase successor/provider truth | payment_r9c_stale_owner_settle |
| P06 | MUST_PORT: Post-dispatch ambiguity and provider policy | src/payment_provider.ts; src/grow_payment_adapter.ts; src/runtime_config.ts; src/synthetic_payment_provider.ts; src/app.ts | classifyMoneyOutcome / providerAmbiguityPolicy / capture / refund / release | 503, transport loss and pending/id-only responses are not retryable no-effect or success proof | payment_r9c_ambiguous_outcomes; payment_grow_ambiguity_policy; payment_review_findings_reconstruction |
| P07 | MUST_PORT: Atomic money state, operation outcome and fee ledger | src/app.ts; src/platform_fee_money.ts; src/fault_injection.ts | applyPaymentWebhookClassification / recordProviderFinancialEventInTx | Crash cannot split successful state from fee ledger | payment_state_ledger_atomicity; payment_lab_foundation; platform_fee_boundary_rounding |
| P08 | MUST_PORT: Late-effect exception visibility and family discipline | src/app.ts; src/frontend_runtime.ts; src/payment_reconciliation.ts | recordLateMoneyEffectException / resolveTarget | Late callbacks cannot silently vanish or settle another operation family | payment_terminal_state_late_events; payment_lab_terminal_economics; payment_review_findings_reconstruction |
| P09 | MUST_PORT: Orphan reconcile and stalled-finalize recovery | src/app.ts | schedulePaymentReconcile / reconcileOrphanedUnknownIdentities / rescheduleStalledFinalizations | Pending-event collision and expired jobs must not lose unresolved money | payment_lab_lifecycle_reconcile; payment_review_findings_reconstruction |
| P10 | MUST_PORT: Recovery preflight and exact amount/currency/reference evidence | src/app.ts; src/payment_provider.ts | verifyOriginalCaptureBeforeRecovery / handlePaymentReconcileEvent | Second capture must wait for verified original outcome; two consistent reads alone insufficient | payment_review_adversarial; payment_lab_refund_release_recovery |
| P11 | MUST_PORT: Settlement horizon, negative-finality authority and legacy NULL fences | src/app.ts; src/payment_attempt_helpers.ts; src/runtime_config.ts | settlementFenceInTx / handleFinalizeDealEvent / armProviderDispatch | Horizon expiry alone and legacy unknown authority must not permit recovery/release; preserve exact Date precision | payment_review_settlement_horizon; payment_final_residual_a_unproven; payment_final_residual_a_authoritative; payment_final_residual_b |
| P12 | MUST_PORT: Release proof and capture/release conflict | src/app.ts; src/payment_attempt_helpers.ts; src/payment_reconciliation.ts; src/operational_repair.ts | handlePaymentReleaseEvent / applyAuthorizationRelease / MONEY_TRANSITIONS | Failed recovery is not AuthReleased; unresolved release blocks capture | payment_review_adversarial; payment_final_residual_c; payment_release_lifecycle |
| P13 | MUST_PORT: Executed-but-unapplied finalization R-11 | src/app.ts | handleFinalizeDealEvent / completeParticipantsOfCompletedDeal | Wait for provider success to commit and finish every paid participant on retry | payment_lab_finalize_guard; payment_review_findings_reconstruction |
| P14 | MUST_PORT: Stale sibling identity protection R-10 | src/app.ts | handlePaymentReconcileEvent | A stale declined attempt may not claim newer operation evidence | payment_review_findings_reconstruction |
| P15 | MUST_PORT: Truthful mock execution ledger R-8 | src/payment_provider.ts | mockRemember / mockExecutedState / mockOutcomeDraw | Mock status must reflect actual effects; same-identity transient retry must progress | payment_review_mock_provider_truth; payment_recovery_real_rail |
| P16 | MUST_PORT: Direct financial regression and proof harness support | tests/lab/*; tests/payment_*; financial fixture updates; scripts/run_test_group.cjs; scripts/financial_lab_mutations.cjs | simulator / oracle / isolated runner / mutation evidence classification | Retain reviewed deterministic regressions; setup failure must never count as killed mutant | all directly ported financial tests; selected mutations; 100 seeded fuzz scenarios |

| ID | Classification | Evidence / disposition |
|---|---|---|
| A01 | ALREADY_PRESENT | Current master already contains deal.cancel entity serialization; preserve master implementation. Reviewed source history explicitly skipped duplicate baseline patch. |
| A02 | ALREADY_PRESENT | src/db.ts persistent client error guard plus safeCodes allowlist are unchanged between common base and review; preserve master. |
| A03 | ALREADY_PRESENT | Exact 8% fee calculation includes delivery, excludes authoritative buyer VAT; no distributor payout model. Source changes transaction ownership only; retain formula and prove boundary/ledger tests. |
| O01 | OBSOLETE / SUPERSEDED | Historical intermediate recovery policies superseded by final reviewed residual A/B/C authority and horizon protection. Port final SHA only. |
| O02 | OBSOLETE / SUPERSEDED | Old exact-8ead7c8 migration upgrade proof does not prove current 065 upgrade; replace with current-master proof, not its old ledger assumptions. |
| M01 | MANUAL_RECONCILIATION | src/app.ts: add only common-base-to-review financial hunks onto current app; preserve list-price, pause/reopen and camera policy additions. |
| M02 | MANUAL_RECONCILIATION | src/frontend_runtime.ts: only the 21 financial lines (late-effect dependency and webhook call); preserve all current seller/buyer/feedback/pickup code. |
| M03 | MANUAL_RECONCILIATION | Canonical migrations live in src/migrations, not supabase/migrations (absent). Preserve 065 at manifest position 58. Append reviewed 063 as 066 at 59 and 064 as 067 at 60. No 066/067 currently exist. Update executable test/mutant path references. |
| D01 | DO_NOT_PORT | All reverse differences in web/, Base44 projections and seller/buyer/physical/auth product files; preserve current master. |
| D02 | DO_NOT_PORT | Historical PROJECT_STATUS replacement, unrelated reports, old frontend/browser/route snapshots and product test deletions. |
| D03 | DO_NOT_PORT | Historical full 226-file, 700-scenario and multi-minute soak campaigns; retain reusable financial harness, execute bounded new proof only. |
| D04 | DO_NOT_PORT | Unrelated pg process-survival fixture adjustment; current master test and runtime baseline retained. |

## Review provenance and exact P0/B2

Source evidence: docs/R9C_CODEX_FINAL_REVIEW.md (FFR-1, FFR-2, FFR-4, FFR-5), docs/R9C_FINANCIAL_REVIEW.md (R-1..R-11), docs/R9C_FINAL_FINANCIAL_INTEGRATION.md (residual A/B/C, I-1), all read from source SHA. Source history includes 11b0ba0 (P0), bf05b76 (residuals), 36de7c5 (R-11), b7a57df (horizon/release proof), fa3f761 (owner settlement), 8332164 (lifecycle), f7777a0 (atomic ledger), 400e489 (identity).

BAD PATH: provider capture returns NO_EFFECT_503; status supplies captured/final for xyz-<authorization> with matching amount/currency. Arbitrary three-letter prefix removal aliases the foreign operation, creating ChargedSuccess and success attempt with zero captures.
GOOD PATH: only defined case-sensitive cap/rec/ref/rel operation prefixes may alias the queried reference; mismatch remains unresolved with a reference-mismatch operational case. Current master lacks the reviewed identity protections; port the full reviewed path plus final exact-prefix correction.
TEST THAT PROVES IT: payment_final_reference_collision_validation.ts; mutation M36_arbitrary_reference_prefix restores the dangerous regex.

B2_NAME: voucher buyer-flow probabilistic capture fixture.
B2_OLD_FAILURE: fixed MOCK_SEED=1 still hashes random UUID correlations; three declines among buyers of quantities 3,2,2 and only the one-unit survivor legitimately miss threshold 2, yielding Failed. Historical one-off trace unavailable; reviewed controlled test establishes a sufficient cause.
B2_CORRECTION: seed undispatched operation identities with known actual mock first draws, assert three successful buyers plus one declined buyer; retain threshold/product rules.
B2_TARGET_TEST: deal_types_e2e_validation.ts B2 and payment_final_b2_threshold_validation.ts (one-unit survivor Failed; three-unit survivor Completed).

## Migration reconciliation

063_payment_operation_lifecycle.sql -> 066_payment_operation_lifecycle.sql
064_payment_settlement_horizon.sql -> 067_payment_settlement_horizon.sql

Copy reviewed SQL bytes unchanged; old numeric comments preserve provenance. Keep every existing master migration byte and every existing manifest id/position unchanged. Runner hashes exact file text (BOM excluded) and rejects changed checksums/positions; do not normalize historical checksums or edit a hosted ledger. Repository documents staging through 065; no hosted inspection or mutation is authorized. Fresh install and true 58-to-60 upgrade with ONLY new migrations passed locally, including legacy payment rows; see the results below.

## Final implementation and decision

SAFE_TO_MERGE_CODE: YES (bounded local integration proof passed; this is a reviewable candidate, not a merge or deployment).
SAFE_FOR_REAL_MONEY: NO.
REAL_MONEY_EXECUTED: 0. GROW_RUNTIME_ENABLED: NO.

P01-P16 implemented: MUST_PORT_IDENTIFIED=16; MUST_PORT_IMPLEMENTED=16; ALREADY_PRESENT=3; OBSOLETE=2; MANUAL_RECONCILIATION=3; DO_NOT_PORT=4. No unresolved code-integration blocker remains in the executed scope. The historical full audit was not repeated.

Runtime/test commit: 803d9b06b21b8b1f5bfa18c60fb16614ffb96224.
Migration commit: 7358d7d79e2e15a943ab2d94760272fb3fa60bd0.
The final proof/documentation commit changes no runtime or financial SQL. Final publication SHA and remote-tip verification are reported with delivery of the branch.

All 12 financial runtime files equal the final reviewed semantics. For app.ts and frontend_runtime.ts, the exact newer-master delta was reversed in a throwaway copy and the remainder compared with source 3809b32; other financial runtime files compare directly. This proves preservation of both sides, including list-price validation, repeat pause/reopen, camera policy, seller context, buyer conversion, feedback and physical fulfillment. frontend_runtime.ts has exactly 21 added financial lines. web/, product/auth files and historical migrations remain unchanged. BEHIND_MASTER=0 at initial and refreshed-origin verification. No merge, rebase or cherry-pick was used: common-base-to-source financial hunks were checked and applied file by file.

## Fresh DB and current-master upgrade results

| Proof | Result |
|---|---|
| Fresh canonical install | PASS, 60 migrations; rerun leaves ledger identical |
| Actual master chain | 58 migrations through 065 at position 58 |
| Upgrade | PASS, apply ONLY 066 at position 59 and 067 at position 60 |
| Historical migration bytes/content | Unchanged; committed financial SQL blobs exactly equal reviewed 063/064 |
| Ledger protection | All 58 prior rows unchanged, including positions, filenames, checksums and timestamps |
| Existing data | Seller, deal, list_price_per_unit and participant data unchanged |
| Legacy payment rows | permanent_fail, unknown and success survive; original canonical states preserved; legacy negative remains permanently fenced |
| Fresh/upgrade schema equivalence | PASS, columns/defaults, functions, triggers and indexes match |
| Repeat execution | PASS, full runner rerun and direct re-execution of both new SQL files |
| Deliberate historical checksum mismatch | REJECTED; ledger unchanged (no checksum normalization/repair) |
| Hosted changes | 0; no staging/production database accessed |

Executable proof: scripts/r9c_master_migration_proof.cjs. It pins master and review SHAs, refuses non-local PostgreSQL and creates/drops only its disposable databases. The proof compares committed SQL bytes and tolerates checkout-only CRLF/LF differences when checking content. The unchanged migration runner still hashes exact local SQL bytes: a deployment must use bytes compatible with its existing ledger. This task does not certify an uninspected hosted ledger or authorize deployment.

## Targeted test results

Exact file-level results and durations: [R9C_MASTER_INTEGRATION_EVIDENCE.json](R9C_MASTER_INTEGRATION_EVIDENCE.json).

| Campaign | Final result |
|---|---|
| All directly ported executable tests | 39/39 files PASS; coverage validated against the port inventory |
| Payments group | 57/57 files PASS |
| Concurrency group | 8/8 files PASS, including financial two-worker matrix and physical handoff concurrency |
| API group | 44/44 files PASS |
| Integration group | 30/30 files PASS after building the missing ignored local mobile artifact |
| Security group | 39/39 files PASS |
| Charging completion window | 1/1 file PASS |
| Additional directly ported E2E fixtures | full_e2e_gate and full_system_qa: 2/2 files PASS |
| P0/B2 focused proof | reference collision, threshold control and deal_types_e2e: 3/3 files PASS |
| Small frontend product smoke | buyer_polish, pickup and react_legacy_route: 3/3 files PASS |
| Worker recovery/fencing | 3/3 files PASS, including two separate worker processes |
| After mutation restoration | 4/4 financial files PASS (75 assertions: 1 + 10 + 27 + 37) |
| Distinct passing files across campaign | 188 (overlapping focused/regression runs counted once) |
| Final failed tests | 0 |

There is no separately named reconciliation group in the repository runner. Its dedicated reconciliation files all passed in payments: payment_lab_lifecycle_reconcile, payment_r9c_reconciliation_race, payment_reconcile_boundary (3/3). Dedicated recovery files passed: payment_lab_refund_release_recovery, payment_recovery_real_rail, buyer_recovery_flow, outbox_worker_recovery, outbox_worker_failure_recovery (5/5); residual/horizon/release suites add recovery-eligibility coverage.

P0_FIXED_ON_CANDIDATE=YES. The good run records ChargeAttempt, unknown identity, capture=0 and a reference-mismatch case. B2_FIXED=YES: controlled threshold proof 2/2; the one-unit survivor yields Failed and the three-unit survivor yields Completed. The deterministic voucher/ticket E2E fixture passes with exact eligible/ineligible counts. Source commit 11b0ba0 carries both final-review corrections; product thresholds and retry rules were not changed to make B2 pass.

## Selected mutation proof

| Mutant | Test that kills it | Expected red result |
|---|---|---|
| M36_arbitrary_reference_prefix | payment_final_reference_collision | 0 passed / 1 failed; ChargedSuccess and success identity with capture=0 |
| M01_unknown_fencing_503_declared | payment_lab_c1_c2 | 19 passed / 8 failed; post-dispatch capture/recovery/refund/release ambiguity protection broken |
| M04_identity_rotation | payment_lab_lifecycle_reconcile | 24 passed / 13 failed; existing recorded/unknown/success identities not reused/resolved correctly |
| M32_horizon_expiry_alone_is_proof | payment_final_residual_a_unproven | 8 passed / 2 failed; unproven provider-event negative finality incorrectly allows recovery/terminal decision |

MUTANTS=4/4 killed; survived=0; invalid=0. P0_MUTANT_KILLED=YES. Financial TEST_FAIL evidence is required; setup and TypeScript errors are not accepted. M04 removes the application identity-selection fence; the separate database backstop remains, so its red result proves the required lifecycle behavior rather than claiming that every layer permitted a duplicate effect.

The runner targets renamed 066/067 paths and preserves the reviewed replacement-callback and evidence-classification corrections. Restoration now writes the exact pre-mutation bytes instead of using git checkout, avoiding CRLF conversion of migration checksums. All runtime/test files are restored to committed content. The four affected financial files were recompiled and passed again after restoration; the final static gates passed too.

## Small fuzz / concurrency proof

FUZZ=100/100 PASS; seed=26090866; 162 participants; 191 simulated provider effects; 47 seconds. The sample covers duplicates, ambiguous responses, retries, late callbacks and varying schedules. The existing financial concurrency matrix and separate two-process worker proof also pass.

The payment group additionally ran a 10-second synthetic load period plus drain: 82 deals, 213 participants, 409 provider operations, 769 jobs and 6 lease expiries. Final oracle: capture 176, recovery 32, release 5, refund 0; unknown identities 0; 11 visible unresolved obligations with 11 cases; 208 ledger entries; fee total and ledger fee total both 168376 minor units; violations 0. Refund behavior is exercised separately by the refund/release and ambiguity suites. This is the bounded sample, not the historical long soak or 700-scenario audit.

## Static gates and current product smoke

PASS: TypeScript --noEmit, test TypeScript compilation, lint/backend enforcement scan, payment compliance scan, runtime-DDL scan, architecture truth gate and whole-delta whitespace check.

MASTER_PRODUCT_SMOKE=PASS. Existing master fixtures prove seller onboarding/context and ownership, buyer join without real money, tracking, feedback commit behavior, physical fulfillment eligibility, concurrent pickup handoff and preserved frontend routes. Exact smoke files are listed in the evidence JSON. The pickup helper/source suite also passes 9/9 with three real QR encode/decode fixture roundtrips; the final QR run skips nothing. No browser campaign was repeated.

SITON_FEE_8_PERCENT_PRESERVED=YES. Charge base includes applicable delivery and excludes authoritative buyer VAT. Platform-fee calculation is unchanged; the port makes ledger/state writes atomic. Boundary and ledger tests pass. DISTRIBUTOR_COMMISSION_PRESENT=NO; no distributor payout model was introduced.

## Setup failures and their resolution

These are retained separately from accepted final results:

- The first new migration-proof draft used an incorrect fixture table name, then encountered a JavaScript quoting error while fixing it. Proof code was corrected; the final fresh/upgrade/legacy proof passes.
- Initial integration was 29/30: mobile_readiness could not read .mobile_dist/app/index.html in the fresh worktree. The ignored local artifact was built using placeholder .invalid origins; the group then passed 30/30. No mobile source changed.
- A temporary campaign-driver edit introduced a quoting error and encountered a transient file lock. A replacement driver was syntax-checked before resuming; no product/test failure or mutation kill was inferred from this setup interruption.
- The initial pickup helper run visibly skipped QR decoding because web dependencies were absent. Dependencies from the current-master fulfillment checkout had identical package and lock manifests and were reused locally; the final pure helper run executed all 9 assertions, including QR decoding.

## Grow external blockers / what remains before real money

SAFE_FOR_REAL_MONEY=NO. Grow runtime is not enabled. Existing adapter code is preserved with no automatic repeat of ambiguous settle/refund and no authoritative negative-finality assumption. All provider/Grow execution in this campaign uses local simulators or in-process test transports; test fixture values are not external credentials or E2E evidence. Real charge/refund/capture/notification=0. Render payment environment and Supabase staging/production configuration are unchanged.

Still required: securely provisioned Grow sandbox credentials; provider-side evidence for exact-operation references, amount/currency and positive/negative finality; contractual and observed settlement horizon; settle/refund idempotency; authenticated callbacks matched to actual effects; external financial review of this combined candidate. Hosted deployment/ledger compatibility and controlled sandbox/live verification remain separate work.

Proof boundary: reviewed authoritative-provider contract-breach controls deliberately demonstrate duplicate effects when a provider lies beyond its declared horizon. Deliberately false signed-callback controls likewise are not universal provider-effect proof. Passing the bounded campaign is evidence within the supported contract and honest effect evidence; it does not establish Grow E2E readiness or zero violations under fabricated provider truth.

## Reproduction

Use a localhost PostgreSQL admin connection as DATABASE_URL, with synthetic/test configuration and no external credentials. Install/reuse the locked local dependencies; the integration mobile gate expects the ignored bundle built by node scripts/build_mobile_bundle.cjs.

- node scripts/r9c_master_migration_proof.cjs
- node scripts/run_test_group.cjs payments (LAB_FUZZ_SEED=26090866, LAB_FUZZ_SCENARIOS=100, LAB_SOAK_SECONDS=10)
- Run concurrency, api, integration and security through the same runner.
- TEST_FILE_PATTERN selects the remaining exact files listed in the evidence JSON in their db/e2e/unit/workers groups.
- node scripts/financial_lab_mutations.cjs M36 M01 M04 M32 --report .tmp_r9c_evidence/mutants.json
- Re-run payment_final_reference_collision, payment_lab_c1_c2, payment_lab_lifecycle_reconcile and payment_final_residual_a_unproven after restoration.
- TypeScript --noEmit; scripts/backend_enforcement_scan.cjs; scripts/compliance_payment_scan.cjs; scripts/runtime_ddl_scan.cjs; scripts/architecture_truth_gate.cjs; git diff --check.

NEXT_STEP: Independent financial review of the pushed integration candidate and its migration/mutation evidence.
