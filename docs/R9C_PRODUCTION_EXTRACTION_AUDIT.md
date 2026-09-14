# R9C PRODUCTION CANDIDATE — EXTRACTION AUDIT

Branch `claude/r9c-production-candidate`, created from canonical master
`82c91d62fd092350748405c8aec15a23d0e2af5e` (a separate worktree; the review
branch `claude/review-r9c-financial` @ `ca6c0c41571c1317ea7fe009c9055ba745949b33`
was read only and is now historical review evidence).

**Mission.** Stop the proof-lab repair loop and extract a CLEAN production
financial candidate: every real production fix found during R9C, the two
financial migrations, the stable regression tests that validate production
behaviour — and nothing that depends on the disputed proof model (the
dispatch-legality oracle, the Siton-side observer, the sequencer simulator, the
mutation harness). Production correctness is then re-proven by a new
black-box test layer that treats Siton as a black box and asserts only
externally durable facts (provider requests / effects, committed rows).

NOT merged · NOT deployed · no hosted database touched · Grow never called · real money 0.

## 1. How the candidate was built

1. `git diff 82c91d6 ca6c0c4` = 89 files (+23 619 / −534). Every file was
   classified from its actual diff (§2), never from a commit message.
2. The candidate took the FINAL state of every category-A/B file from
   `ca6c0c4` (`git checkout ca6c0c4 -- <file>`), so `git diff ca6c0c4 -- src/`
   is empty on the candidate: the production source is byte-identical to the
   reviewed branch, without any lab file.
3. Category C (22 test files: 11 existing tests whose expectations follow the
   new production behaviour, 11 added tests that already drove the real
   application with their own HTTP stub and never imported `tests/lab`) was
   taken as is.
4. Category D/E (42 lab / oracle / observer / mutation / review-tooling
   files, 8 review reports) was NOT taken.
5. A new black-box layer was added (§6): `tests/blackbox/provider_stub.ts`,
   `tests/blackbox/harness.ts` and four scenario files (B1–B12, 25 controls).
6. The migration validation script kept from the review
   (`scripts/review_r9c_migration_independent_proof.cjs`) was run for §12.

Classification totals: **A = 12, B = 5, C = 22, D = 42, E = 8, F = 0** (89).

## 2. Per-file classification (master 82c91d6 → review ca6c0c4)

Categories: A production runtime required · B production migration required ·
C stable regression test required · D review-lab / oracle / observer only ·
E review documentation only · F unrelated / should not ship.

| # | File | Δ | Category | Keep/Drop | Reason (from the diff) | Originating issue / fix |
|---|---|---|---|---|---|---|
| 1 | `src/app.ts` | M +1995/−388 | A | keep | money rails (durable identity, arm-before-I/O, owner settle, recovery pre-flight, settlement horizon), reconcile rail (in-flight deferral, exact-operation identity, never-dispatched retirement), F-12 identity-based dual-capture detection + atomic escalation + fail-closed read, finalize F-2/F-14/F-15/R-11, release F-16/residual C, maintenance sweepers | C1/C2, F-1..F-16, SR-1, residuals A/B/C, R-11 |
| 2 | `src/fault_injection.ts` | M +13/−1 | A | keep | fault points `payment.*` the production rails call (test-only barriers; production no-op) — required by stable tests and the black-box layer (B7, B9) | R9C, F-12 |
| 3 | `src/frontend_runtime.ts` | M +21/−0 | A | keep | HTTP webhook path parity: a stale-state `ignored` classification records the late money effect (F-3) instead of discarding it | F-3 |
| 4 | `src/grow_payment_adapter.ts` | M +27/−12 | A | keep | dispatch honesty (`dispatched`), post-dispatch non-2xx = UNKNOWN, repeat semantics declared unproven | C2 / H1 |
| 5 | `src/operational_repair.ts` | M +4/−0 | A | keep | comment only: legacy F-6 transition kept canonical for historical audit rows | F-6 |
| 6 | `src/outbox_worker_helpers.ts` | M +26/−0 | A | keep | `assertLeaseForProviderIo` — pre-I/O lease fence for stale workers | R9C |
| 7 | `src/payment_attempt_helpers.ts` | M +701/−8 | A | keep | provider-operation identity lifecycle: mint (admitted states), arm CAS, owner settle, in-flight checks, settlement fence, horizon extension, never-dispatched retirement | R9C, round 5 |
| 8 | `src/payment_provider.ts` | M +375/−48 | A | keep | ambiguity policy per provider, `dispatched`, post-dispatch HTTP classification (UNKNOWN), declared refund/release outcomes only (F-7), truthful mock status memory (F-9), reference discipline (`reference_matches_query`) | C2, F-7, F-9, residual A |
| 9 | `src/payment_reconciliation.ts` | M +31/−8 | A | keep | event classification carries deal state / window for the reconcile rail | R9C |
| 10 | `src/platform_fee_money.ts` | M +14/−6 | A | keep | `recordProviderFinancialEventInTx` — fee ledger written inside the state transaction | ledger atomicity |
| 11 | `src/runtime_config.ts` | M +14/−0 | A | keep | `PAYMENT_SETTLEMENT_HORIZON_MS`, `PAYMENT_NEGATIVE_STATUS_AUTHORITATIVE` | residual A, settlement horizon |
| 12 | `src/synthetic_payment_provider.ts` | M +11/−2 | A | keep | synthetic in-process provider declares pre-dispatch failures and its ambiguity policy | SR-2 |
| 13 | `.gitignore` | M +3/−0 | B | keep | ignores `.review-artifacts/`, the output directory of the kept migration validator (`review_r9c_migration_independent_proof.cjs` writes its proof JSON there); needed to keep the worktree clean after §12 | migration validation |
| 14 | `scripts/migration_manifest.cjs` | M +9/−4 | B | keep | registers 067/068 after landed 066 (ledger positions 60/61) | R9C migrations |
| 15 | `scripts/review_r9c_migration_independent_proof.cjs` | A +484/−0 | B | keep | fresh-install / true master→candidate upgrade / checksum-tamper / schema-equivalence proof for 067+068 on disposable local databases — reused as the candidate's migration validation (§12) | R9C master integration review |
| 16 | `src/migrations/067_payment_operation_lifecycle.sql` | A +322/−0 | B | keep | dispatch_state / owner lease / lifecycle + eligibility guards, `payment_operation_in_flight` | migration 063 → 067 renumbered |
| 17 | `src/migrations/068_payment_settlement_horizon.sql` | A +333/−0 | B | keep | settlement horizon, failure evidence provenance, negative-finality authority, capture settlement fence | migration 064 → 068 renumbered |
| 18 | `tests/charge_attempt_rate_limit_validation.ts` | M +11/−3 | C | keep | seeds resolved attempts (067 forbids a new identity behind an unresolved one) | migration 067 |
| 19 | `tests/charging_completion_window_validation.ts` | M +13/−0 | C | keep | stub answers the status seam the recovery pre-flight now reads | F-1 |
| 20 | `tests/deal_types_e2e_validation.ts` | M +26/−6 | C | keep | deterministic mock draws pinned through undispatched identities | SR-2 |
| 21 | `tests/full_e2e_gate_validation.ts` | M +9/−8 | C | keep | capture identity is minted from the attempts table, not the outbox attempt_count | R9C identity |
| 22 | `tests/full_system_qa_validation.ts` | M +5/−1 | C | keep | F-6: a failed recovery leaves ChargeFailedRecovery until the release rail proves the release | F-6 |
| 23 | `tests/grow_payment_sandbox_activation_validation.ts` | M +100/−1 | C | keep | Grow C2/H1 cases 16/17 (503 after effect → UNKNOWN, no repeat settle/refund) | C2 / H1 |
| 24 | `tests/payment_grow_ambiguity_policy_validation.ts` | A +191/−0 | C | keep | Grow ambiguity policy declared and honoured (fail closed) | H1 |
| 25 | `tests/payment_provider_operation_identity_crash_validation.ts` | A +543/−0 | C | keep | identity under crash / stall / lease reclaim (own HTTP stub, real handlers) | R9C |
| 26 | `tests/payment_r9c_ambiguous_outcomes_validation.ts` | A +324/−0 | C | keep | ambiguous outcomes after dispatch are UNKNOWN (own HTTP stub) | C2 |
| 27 | `tests/payment_r9c_reconciliation_race_validation.ts` | A +388/−0 | C | keep | capture / reconcile race, recovery eligibility (own HTTP stub) | C1 |
| 28 | `tests/payment_r9c_stale_owner_settle_validation.ts` | A +442/−0 | C | keep | stale dispatching owner may write only SUCCESS | SR-1 |
| 29 | `tests/payment_recovery_real_rail_validation.ts` | M +40/−5 | C | keep | F-6 release through the provider-proofed rail; truthful status stub | F-6, F-1 |
| 30 | `tests/payment_release_lifecycle_validation.ts` | M +23/−7 | C | keep | release 503 after dispatch = UNKNOWN on the same identity; declared release only | C2, R-9 |
| 31 | `tests/payment_review_grow_negative_status_validation.ts` | A +183/−0 | C | keep | Grow negative status never proves non-execution | H1 |
| 32 | `tests/payment_review_mock_provider_truth_validation.ts` | A +91/−0 | C | keep | mock provider answers status from what it executed | F-9 |
| 33 | `tests/payment_state_ledger_atomicity_validation.ts` | A +181/−0 | C | keep | money state + fee ledger commit together (fault injection) | ledger atomicity |
| 34 | `tests/payment_terminal_state_late_events_validation.ts` | A +195/−0 | C | keep | late / out-of-order money events never flip terminal states silently | F-3 |
| 35 | `tests/platform_fee_boundary_rounding_validation.ts` | A +146/−0 | C | keep | pure rounding / boundary proof of the fee constitution | financial constitution |
| 36 | `tests/real_integrations_validation.ts` | M +4/−1 | C | keep | F-6 expectation (ChargeFailedRecovery until release proof) | F-6 |
| 37 | `tests/review_payment_foreign_reference_ab_validation.ts` | A +274/−0 | C | keep | P0 foreign provider reference cannot prove another operation's capture (own HTTP stub) | P0 foreign reference |
| 38 | `tests/webhook_truth_handling_validation.ts` | M +11/−1 | C | keep | F-3: a late real effect converges the identity and opens a case on the HTTP webhook path | F-3 |
| 39 | `tests/worker_two_process_fencing_validation.ts` | M +114/−23 | C | keep | arrangement retried: the maintenance sweeper `rescheduleStalledFinalizations` scans siton.deals during the phase lock | stabilization for the new sweeper |
| 40 | `scripts/financial_lab_mutations.cjs` | A +283/−0 | D | drop | mutation harness for the torture lab (production mutants proven by lab suites) | financial torture program |
| 41 | `scripts/r9c_master_migration_proof.cjs` | A +117/−0 | D | drop | migration proof pinned to review-time SHAs (c1ce4e4 / 3809b32); superseded by the independent proof kept below | R9C master integration |
| 42 | `scripts/review_ab_driver.cjs` | A +101/−0 | D | drop | A/B driver (fresh DB per file) used by the mutation harness and review runs; `TEST_FILE_PATTERN` on run_test_group covers single-file runs | review tooling |
| 43 | `scripts/review_db_fencing_proof.cjs` | A +258/−0 | D | drop | review-time DB fencing proof script | R9C master integration review |
| 44 | `scripts/review_flake_probe.cjs` | A +122/−0 | D | drop | flake-attribution probe for review runs | review tooling |
| 45 | `scripts/review_mutation_proof.cjs` | A +639/−0 | D | drop | RM-*/OM-* mutation proof (production mutants killed by lab/oracle suites; observer mutants) | review tooling |
| 46 | `scripts/run_test_group.cjs` | M +6/−1 | D | drop | only raises the runner timeout for the lab fuzz/soak files, which are excluded | torture lab |
| 47 | `tests/lab/dispatch_legality.ts` | A +504/−0 | D | drop | the disputed dispatch-time legality oracle | R9C rounds 4–7 |
| 48 | `tests/lab/oracle.ts` | A +500/−0 | D | drop | financial-truth oracle (`auditFinancialTruth`) | R9C rounds 4–7 |
| 49 | `tests/lab/provider_simulator.ts` | A +608/−0 | D | drop | sequencer-positioned provider simulator used to prove the oracle | R9C rounds 4–7 |
| 50 | `tests/lab/runtime.ts` | A +418/−0 | D | drop | lab runtime (bootLab) that installs the observer and judges with the oracle | R9C rounds 4–7 |
| 51 | `tests/lab/siton_observer_preload.ts` | A +18/−0 | D | drop | observer preload for worker processes | R9C rounds 4–7 |
| 52 | `tests/lab/siton_observer.ts` | A +510/−0 | D | drop | the Siton-side observer (fetch / JSON.parse / pg wrappers) | R9C rounds 4–7 |
| 53 | `tests/payment_final_b2_threshold_validation.ts` | A +18/−0 | D | drop | depends on tests/lab (bootLab / simulator / oracle); its production behaviour is covered by the stable tests and the black-box layer | R9C rounds 1–7 |
| 54 | `tests/payment_final_reference_collision_validation.ts` | A +30/−0 | D | drop | depends on tests/lab (bootLab / simulator / oracle); its production behaviour is covered by the stable tests and the black-box layer | R9C rounds 1–7 |
| 55 | `tests/payment_final_residual_a_authoritative_validation.ts` | A +160/−0 | D | drop | depends on tests/lab (bootLab / simulator / oracle); its production behaviour is covered by the stable tests and the black-box layer | R9C rounds 1–7 |
| 56 | `tests/payment_final_residual_a_unproven_validation.ts` | A +260/−0 | D | drop | depends on tests/lab (bootLab / simulator / oracle); its production behaviour is covered by the stable tests and the black-box layer | R9C rounds 1–7 |
| 57 | `tests/payment_final_residual_b_validation.ts` | A +162/−0 | D | drop | depends on tests/lab (bootLab / simulator / oracle); its production behaviour is covered by the stable tests and the black-box layer | R9C rounds 1–7 |
| 58 | `tests/payment_final_residual_c_validation.ts` | A +233/−0 | D | drop | depends on tests/lab (bootLab / simulator / oracle); its production behaviour is covered by the stable tests and the black-box layer | R9C rounds 1–7 |
| 59 | `tests/payment_lab_c1_c2_validation.ts` | A +236/−0 | D | drop | depends on tests/lab (bootLab / simulator / oracle); its production behaviour is covered by the stable tests and the black-box layer | R9C rounds 1–7 |
| 60 | `tests/payment_lab_concurrency_matrix_validation.ts` | A +301/−0 | D | drop | two-worker matrix judged by the oracle (workers run the observer preload) | R9C rounds 1–7 |
| 61 | `tests/payment_lab_crash_matrix_validation.ts` | A +267/−0 | D | drop | depends on tests/lab (bootLab / simulator / oracle); its production behaviour is covered by the stable tests and the black-box layer | R9C rounds 1–7 |
| 62 | `tests/payment_lab_finalize_guard_validation.ts` | A +131/−0 | D | drop | depends on tests/lab (bootLab / simulator / oracle); its production behaviour is covered by the stable tests and the black-box layer | R9C rounds 1–7 |
| 63 | `tests/payment_lab_foundation_validation.ts` | A +215/−0 | D | drop | depends on tests/lab (bootLab / simulator / oracle); its production behaviour is covered by the stable tests and the black-box layer | R9C rounds 1–7 |
| 64 | `tests/payment_lab_lifecycle_reconcile_validation.ts` | A +468/−0 | D | drop | depends on tests/lab (bootLab / simulator / oracle); its production behaviour is covered by the stable tests and the black-box layer | R9C rounds 1–7 |
| 65 | `tests/payment_lab_random_schedule_fuzz_validation.ts` | A +237/−0 | D | drop | seeded fuzz judged by the oracle | R9C rounds 1–7 |
| 66 | `tests/payment_lab_refund_release_recovery_validation.ts` | A +443/−0 | D | drop | depends on tests/lab (bootLab / simulator / oracle); its production behaviour is covered by the stable tests and the black-box layer | R9C rounds 1–7 |
| 67 | `tests/payment_lab_soak_validation.ts` | A +176/−0 | D | drop | bounded soak judged by the oracle | R9C rounds 1–7 |
| 68 | `tests/payment_lab_terminal_economics_validation.ts` | A +218/−0 | D | drop | depends on tests/lab (bootLab / simulator / oracle); its production behaviour is covered by the stable tests and the black-box layer | R9C rounds 1–7 |
| 69 | `tests/payment_review_adversarial_validation.ts` | A +362/−0 | D | drop | depends on tests/lab (bootLab / simulator / oracle); its production behaviour is covered by the stable tests and the black-box layer | R9C rounds 1–7 |
| 70 | `tests/payment_review_findings_reconstruction_validation.ts` | A +376/−0 | D | drop | depends on tests/lab (bootLab / simulator / oracle); its production behaviour is covered by the stable tests and the black-box layer | R9C rounds 1–7 |
| 71 | `tests/payment_review_settlement_horizon_validation.ts` | A +295/−0 | D | drop | depends on tests/lab (bootLab / simulator / oracle); its production behaviour is covered by the stable tests and the black-box layer | R9C rounds 1–7 |
| 72 | `tests/review_arm_race_orphan_hold_validation.ts` | A +165/−0 | D | drop | orphan authorization race — re-proven black-box in B6 | R9C rounds 1–7 |
| 73 | `tests/review_attempt_lifecycle_crash_race_matrix_validation.ts` | A +341/−0 | D | drop | lifecycle crash/race matrix judged by the oracle | R9C rounds 1–7 |
| 74 | `tests/review_finalize_participant_race_terminal_state_validation.ts` | A +385/−0 | D | drop | F-14/F-15 finalize race — re-proven black-box in B7/B11 | R9C rounds 1–7 |
| 75 | `tests/review_observer_integrity_validation.ts` | A +590/−0 | D | drop | observer integrity suite (O1–O17) — proves the observer, not production | R9C rounds 1–7 |
| 76 | `tests/review_oracle_causal_binding_validation.ts` | A +376/−0 | D | drop | oracle causal-binding controls — synthetic histories judged by the oracle | R9C rounds 1–7 |
| 77 | `tests/review_oracle_observation_negative_validation.ts` | A +485/−0 | D | drop | oracle observation controls | R9C rounds 1–7 |
| 78 | `tests/review_oracle_temporal_negative_validation.ts` | A +406/−0 | D | drop | oracle temporal controls | R9C rounds 1–7 |
| 79 | `tests/review_payment_dual_capture_durable_escalation_validation.ts` | A +527/−0 | D | drop | F-12 durable escalation — behaviour re-proven black-box in B3/B9 (no lab) | R9C rounds 1–7 |
| 80 | `tests/review_payment_dual_capture_escalation_validation.ts` | A +258/−0 | D | drop | F-12 escalation — re-proven black-box in B3 | R9C rounds 1–7 |
| 81 | `tests/review_payment_reference_identity_rails_validation.ts` | A +472/−0 | D | drop | exact-operation identity on every rail, judged with lab.oracle | R9C rounds 1–7 |
| 82 | `docs/R9C_FINANCIAL_INDEPENDENT_REVIEW.md` | A +916/−0 | E | drop | independent review report | R9C review |
| 83 | `docs/R9C_MASTER_INTEGRATION_EVIDENCE.json` | A +1059/−0 | E | drop | proof JSON of the master-integration review | R9C review |
| 84 | `docs/R9C_MASTER_INTEGRATION_REPORT.md` | A +179/−0 | E | drop | master-integration review report | R9C review |
| 85 | `docs/R9C_ROUND4_ORACLE_AND_CONCURRENCY.md` | A +253/−0 | E | drop | round-4 report (oracle soundness, F-14/15/16) | R9C round 4 |
| 86 | `docs/R9C_ROUND5_OBSERVED_EVIDENCE_AND_ARM_RACE.md` | A +304/−0 | E | drop | round-5 report (observed-evidence oracle, orphan authorization) | R9C round 5 |
| 87 | `docs/R9C_ROUND6_STATUS_RESPONSE_CAUSAL_BINDING.md` | A +174/−0 | E | drop | round-6 report (observer / causal binding) | R9C round 6 |
| 88 | `docs/R9C_ROUND7_OBSERVER_INTEGRITY.md` | A +203/−0 | E | drop | round-7 report (observer integrity) | R9C round 7 |
| 89 | `PROJECT_STATUS.md` | M +157/−0 | E | drop (own entry added) | review-round status entries (rounds 3–7); the candidate records its own entry | review history |

## 3. Production fixes preserved — traced in the candidate's source

Every item below was traced in the candidate's `src/` (identical to `ca6c0c4`),
not inferred from commit messages. Line numbers refer to the candidate.

| Fix | Where it lives now | Black-box proof |
|---|---|---|
| **F12 late dual capture — durable escalation** | `src/app.ts:1049` `readCaptureSideIdentityEvidence` (distinct executed capture-side identities, stable across redeliveries), `:1091` `recordLateMoneyEffectException` — evidence + escalation in ONE transaction (`settleAttemptInTx` then `openPaymentOperationalCaseInTx`, `:1183`), no error suppression; the HTTP webhook path calls the same routine (`src/frontend_runtime.ts`, `recordLateMoneyEffectException` dep) | B2, B3, B9a/B9b, B10 |
| **F12 unreadable evidence fails closed** | `src/app.ts:1039` `PaymentDualCaptureEvidenceUnavailableError`, `:1111` `if (evidence.outcome === "unreadable") throw` — before any write; the delivery is marked `failed` and stays retryable | B9c |
| **Foreign provider-reference identity** | `src/payment_provider.ts:228` `reference_matches_query` (adapter judges the provider's reference discipline; `:1189` provider-ready status); `src/app.ts:2367` reconcile refuses a mismatching answer (case, no verdict), `:2833` prior-attempt resolution refuses it, `:3457` recovery pre-flight refuses a foreign read (case, no recovery) | B4, B4b; `review_payment_foreign_reference_ab_validation.ts` |
| **Unreadable provider state — fail closed** | `src/payment_provider.ts:514` `parseJsonSafely` → `{ raw_body }`, `:272` `classifyPostDispatchHttpFailure` (5xx/408/425/429/malformed = UNKNOWN), `:280` `responseBodyMalformed`; `src/app.ts:2639` `classifyMoneyOutcome` (only a proven pre-dispatch failure retries; everything else UNKNOWN on the SAME identity); reconcile on unreadable status stays UNKNOWN / retries (`payment_reconcile_unresolved`) | B1a, B1b, B5a, B5b, B12b |
| **Orphan authorization / never-dispatched retirement** | `src/payment_attempt_helpers.ts:77` `AdmittedParticipantStates` + `:330` `beginProviderAttempt(admitted)` (state re-read under the participant/deal lock before the mint), `:196` `retireNeverDispatchedInTx` (ABANDONED_BEFORE_DISPATCH = temporary_fail + recorded + no dispatch instant); `src/app.ts:2215` reconcile never status-reads a `recorded` identity — live rail job → nothing, phase open → operator case, else retire + queue the release; `:1981` `reconcileOrphanedUnknownIdentities` sweeper (longer quiet period for `recorded` rows) | B6, B6b |
| **F14 sibling completion** | `src/app.ts:4018` `applyCompletedDealOutcome` — the whole completed-deal outcome (complete paid, fail unpaid, release holds, notifications, receipts, fulfillment, payout), idempotent, used by the fresh finalize and by every retry on an already-Completed deal | B11, B11b |
| **F15 deal-failure vs capture race** | `src/app.ts:4067` the fail-participant CAS takes the participant/deal advisory lock and refuses any participant with a minted / armed / executed capture-side identity (a retired never-dispatched row does not defer); the F-2 gate defers finalize while any capture-side identity is UNKNOWN or executed-but-unapplied | B7, B6 |
| **F16 authorization release / never-attempted hold** | `src/app.ts:2061` `scheduleAuthorizationReleasesForDeal` includes `ChargeAttempt`; `:2575` `applyAuthorizationRelease` admits ChargeAttempt only when no capture-side identity is unresolved or executed; release rail mint admitted in ChargeAttempt; F-6: `recovery_failed` never sets AuthReleased — the release rail proves it | B6, B11, B12a, B12b, B12c |
| **Exact executed-capture identity** | `src/app.ts:2245` FR-4: a job carrying a resolved identity draws no conclusion while a sibling identity of the same family is UNKNOWN; every rail mints ONE durable identity (`identity: (n) => …:n<logical>:…`), arms it under the lease (`:2623` `assertOutboxLeaseForProviderIo`), settles it as owner (`:2707` `settleOwnedMoneyOperation`, SR-1: a stale owner may write only SUCCESS) | B8a, B8b, B8c; `payment_r9c_stale_owner_settle_validation.ts`, `payment_provider_operation_identity_crash_validation.ts` |
| **Case-write atomicity** | `src/app.ts:1183` `openPaymentOperationalCaseInTx` inside the evidence transaction (F-12 path) — the best-effort `openPaymentOperationalCase` stays for the 30-odd observability call sites where a case reports a decision already persisted | B9a, B9b |
| **Recovery retry safeguards** | `src/app.ts:3641` settlement-horizon fence before any recovery (`captureSettlementFenceUntil`, migration 068), `:3405` `verifyOriginalCaptureBeforeRecovery` — two status reads a confirmation interval apart (`:3443`), captured → late-effect case + no recovery, pending → defer + extend horizon, flapping / foreign / unverifiable → hold + case, negative finality unproven → hold; the recovery identity is minted only after the pre-flight | B1b, B4, B4b, B5a; `charging_completion_window_validation.ts`, `payment_recovery_real_rail_validation.ts` |

## 4. What was deliberately NOT taken (category D) — and why the candidate does not need it

* `tests/lab/**` (dispatch-legality oracle, financial-truth oracle, sequencer
  simulator, Siton-side observer + worker preload, lab runtime) and the 27
  suites that import it. Their money-safety content is re-proven black-box:
  F-12 (B2/B3/B9), orphan authorization (B6), finalize race F-14/F-15 (B7/B11),
  identity discipline under stale workers (B8), unreadable / foreign / lost
  provider answers (B1/B4/B5), release path (B12). The fuzz/soak/matrix suites
  judged by the oracle are not reproduced: their verdicts are the disputed
  proof model itself.
* `scripts/review_mutation_proof.cjs`, `scripts/financial_lab_mutations.cjs`,
  `scripts/review_ab_driver.cjs`, `scripts/review_flake_probe.cjs`,
  `scripts/review_db_fencing_proof.cjs`, `scripts/r9c_master_migration_proof.cjs`
  (pinned to review-time SHAs), the lab timeout branch in
  `scripts/run_test_group.cjs`, the `.review-artifacts/` ignore line.
* The seven R9C review reports and the evidence JSON stay on the review branch.

## 5. Direct black-box production tests (new, no lab dependency)

`tests/blackbox/provider_stub.ts` — an HTTP provider that logs every request
BEFORE answering, applies money effects when IT decides, and lets the test
script the schedule per authorization/operation (declared success / decline,
effect-then-5xx, effect-then-dropped-socket, effect-then-held-answer released by
the test, request-parked-at-the-door, pending; truthful or scripted status
answers, malformed / 500 / dropped / held). Optional native idempotency
(a repeated key is replayed, never executed twice — the provider-ready
contract). `tests/blackbox/harness.ts` boots the real application against it,
seeds rows, drives jobs through the real `processOutboxEventById`, runs the
real maintenance sweepers, and exposes only committed facts.

| Scenario | File | Controls | Result |
|---|---|---|---|
| B1 capture answer lost / unknown → no second capture until safe proof | `payment_blackbox_capture_recovery_validation.ts` | B1a lost socket (money moved) → one effect, ChargedSuccess; B1b 503 nothing moved → status-inferred failure, horizon honoured, exactly one recovery | PASS (2/2) |
| B2 original settles late while the recovery is in flight | same | both identities success, two effects recorded, open late-money-effect cases, no further money op | PASS |
| B3 second capture then the original reports success | same | exactly one `dual-capture` case, stable across same-id / fresh-id / concurrent redeliveries | PASS |
| B4 foreign provider reference | same | reconcile: no verdict, case; pre-flight: no recovery, case; truth resolves with one recovery | PASS (2/2) |
| B5 status unreadable / transport failure | same | malformed / 500 / dropped → identity UNKNOWN, no money; held past timeout → UNKNOWN, one effect | PASS (2/2) |
| B6 armed but never dispatched | `payment_blackbox_hold_finalize_release_validation.ts` | real finalize-vs-charge race under a row lock → nothing sent, one release, AuthReleased; seeded never-dispatched row retired by the sweeper after its real quiet period | PASS (2/2) |
| B7 deal decided while the capture is in flight | same | finalize defers (`finalize_waiting_for_unresolved_captures`), capture lands, buyer DealCompleted, one effect | PASS |
| B8 two workers race one recovery | `payment_blackbox_concurrency_recovery_race_validation.ts` | stale-lease reclaim: one identity, one effect, stale owner `lease_lost`; live lease: no second claim, reconcile defers; two participants: one each | PASS (3/3) |
| B9 case insertion failure during dual-money evidence | `payment_blackbox_evidence_atomicity_events_validation.ts` | trigger-blocked INSERT and the production fault point: HTTP 500, evidence not committed, webhook `failed`; same id repairs both halves; unreadable evidence fails closed | PASS (3/3) |
| B10 duplicate webhook / provider event | same | capture ×8 (incl. concurrent) → one transition, one ledger row, no case; recovery duplicates + late contradicting failure → monotonic; refund duplicates → one refund request, one adjustment | PASS (3/3) |
| B11 siblings after recovery / mid-loop abort | `payment_blackbox_hold_finalize_release_validation.ts` | paid → DealCompleted, unpaid → DealFailed + one release; control finalize completes both | PASS (2/2) |
| B12 authorization release path | same | declined recovery → Dropped, release only via the rail (one request); release 503-after-effect → UNKNOWN then status → AuthReleased, one request; refused release → AuthHeld + case | PASS (3/3) |

Facts used: `provider.requestsOf / moneyRequestsOf / effectsOf` (the stub's log
and effect ledger) and `siton.payment_attempts`, `participants`, `deals`,
`operational_cases`, `outbox_events` / `outbox_dlq`, `webhook_events`,
`platform_fee_money_events`, `audit_log`.

## 6. Existing stable suites on the clean candidate

One continuous `node scripts/run_test_group.cjs all` on the candidate (each file on a fresh migrated database; `.tmp_pc/test-all.log`), after `npm run mobile:verify` (the mobile readiness test needs `.mobile_dist`):

| Group | Files | Result | Duration |
|---|---|---|---|
| unit | 15 | 15/15 | 40 s |
| integration | 31 | 31/31 | 90 s |
| db | 8 | 8/8 | 51 s |
| api | 44 | 44/44 | 149 s |
| workers | 13 | 13/13 | 57 s |
| payments | 43 (incl. the 4 black-box files, 25 controls) | 43/43 | 134 s |
| security | 39 | 39/39 | 230 s |
| concurrency | 8 (incl. B8) | 8/8 | 95 s |
| failure | 9 | 9/9 | 48 s |
| e2e | 13 | 13/13 | 152 s |
| **all** | **223** | **10/10 groups, 0 FAIL lines** | **17.5 min** |

Also green: `tsc -p tsconfig.json` (production build), `npm run lint` (backend enforcement scan: state-mutation, payment-SDK boundary, secrets, control bytes).

Corrective reruns while building the black-box layer (recorded honestly): B6b first failed because the maintenance sweeper deliberately leaves a never-dispatched identity alone for a real ≥ 10 s quiet period (`updated_at` cannot be back-dated) — the scenario now waits for it; B9a first asserted the wrong durable webhook status (`processed`) — the late-effect path keeps the canonical classification `ignored` while writing evidence + case in one transaction, which the scenario now asserts; a harness query named a non-existent `webhook_events.event_type` column — removed. No production change was needed for any of them.

## 7. Migration validation (§12)

`node scripts/review_r9c_migration_independent_proof.cjs` on disposable LOCAL databases only (`.tmp_pc/migration-proof.log`): **49/49 PASS**.

* manifest: 61 entries, contiguous positions, 067 @ 60, 068 @ 61, the 59 landed migrations keep ids and positions; both new migrations wrapped in explicit transactions, no DROP of existing data;
* fresh install: 61/61 applied, no failed migration;
* true master → candidate upgrade: the 59 landed migrations applied first (canonical master ledger), legacy production-shaped data seeded (8 participants, 9 attempts in every result_class), then the manifest applied again → exactly two more migrations (067 @ 60, 068 @ 61), all 59 historical ledger rows byte-identical, business rows unchanged, legacy defaults as documented (dispatch_state `responded`, NULL evidence / authority, legacy status-inferred failures fenced at infinity, dispatch-response failures not fenced);
* fresh and upgraded schemas equivalent (columns 997, constraints 1073, indexes 254, triggers 19, functions 24); 067's money-transition table is master's 053 table plus ChargeAttempt→AuthReleased;
* re-running the manifest is a no-op; 067/068 re-execute idempotently; a tampered historical checksum is rejected and the ledger left unchanged; 067/068 ledger checksums equal the on-disk SQL bytes.

Every test file of the full suite also ran on a freshly migrated database (run_test_group applies the manifest per file). No hosted database was used.

## 8. Diff safety audit — candidate vs master

`git status` of the candidate against master (before commit; `.tmp_pc/candidate-files.txt`):

* **PRODUCTION_FILES_CHANGED (12):** `src/app.ts`, `src/fault_injection.ts`, `src/frontend_runtime.ts`, `src/grow_payment_adapter.ts`, `src/operational_repair.ts`, `src/outbox_worker_helpers.ts`, `src/payment_attempt_helpers.ts`, `src/payment_provider.ts`, `src/payment_reconciliation.ts`, `src/platform_fee_money.ts`, `src/runtime_config.ts`, `src/synthetic_payment_provider.ts` — byte-identical to `ca6c0c4` (`git diff ca6c0c4 -- src/` empty).
* **MIGRATIONS_CHANGED (2 + manifest + validator):** `src/migrations/067_payment_operation_lifecycle.sql`, `src/migrations/068_payment_settlement_horizon.sql`, `scripts/migration_manifest.cjs`, `scripts/review_r9c_migration_independent_proof.cjs` (validation tooling, not an oracle).
* **STABLE_TEST_FILES_ADDED (17):** black-box layer `tests/blackbox/provider_stub.ts`, `tests/blackbox/harness.ts`, `tests/payment_blackbox_capture_recovery_validation.ts`, `tests/payment_blackbox_hold_finalize_release_validation.ts`, `tests/payment_blackbox_concurrency_recovery_race_validation.ts`, `tests/payment_blackbox_evidence_atomicity_events_validation.ts`; taken from the review branch (lab-free): `tests/payment_grow_ambiguity_policy_validation.ts`, `tests/payment_provider_operation_identity_crash_validation.ts`, `tests/payment_r9c_ambiguous_outcomes_validation.ts`, `tests/payment_r9c_reconciliation_race_validation.ts`, `tests/payment_r9c_stale_owner_settle_validation.ts`, `tests/payment_review_grow_negative_status_validation.ts`, `tests/payment_review_mock_provider_truth_validation.ts`, `tests/payment_state_ledger_atomicity_validation.ts`, `tests/payment_terminal_state_late_events_validation.ts`, `tests/platform_fee_boundary_rounding_validation.ts`, `tests/review_payment_foreign_reference_ab_validation.ts`.
* **STABLE_TEST_FILES_MODIFIED (11):** `charge_attempt_rate_limit`, `charging_completion_window`, `deal_types_e2e`, `full_e2e_gate`, `full_system_qa`, `grow_payment_sandbox_activation`, `payment_recovery_real_rail`, `payment_release_lifecycle`, `real_integrations`, `webhook_truth_handling`, `worker_two_process_fencing` (all `*_validation.ts`; expectation / stub updates that follow the production behaviour, §2).
* **DOCS:** this audit, one PROJECT_STATUS.md entry.
* **LAB_FILES_INCLUDED: NONE.** `tests/lab/` does not exist on the candidate; a scan of `tests/`, `src/`, `scripts/` for `tests/lab`, `./lab/`, `siton_observer`, `dispatch_legality`, `auditFinancialTruth`, `review_mutation_proof`, `review_ab_driver` finds one COMMENT line (in `review_payment_foreign_reference_ab_validation.ts`, describing what the BEFORE tree lacked) and no import.

## 9. Review-lab defects — NOT SHIPPING

Codex's round-7 review established five proof-model defects. None of them is
production code; the candidate contains no file in which they could exist.

| Codex finding (proof layer) | Where it lived | Production runtime check on the candidate |
|---|---|---|
| wrong-response receipts (a `status_received` bound to the wrong query / echo) | `tests/lab/siton_observer.ts` fetch + JSON.parse hooks | production binds every status answer to the request that produced it by construction (`fetch` returns the response of that request; `src/payment_provider.ts` status()) and keys decisions on `provider_reference` / amount / currency checks, never on a lab query id |
| wrong-row identity binding (a verdict attributed by parameter guessing) | `tests/lab/siton_observer.ts` pg wrapper | production identity is the `correlation_id` in the WHERE clause of `settleAttemptInTx` / `settleProviderDispatch` (`src/payment_attempt_helpers.ts`), with `rowCount` checked (`=== 1`, `classifySettleRefusal`) |
| non-durable terminal verdict (published before / without COMMIT) | `tests/lab/siton_observer.ts` pg wrapper | production settles inside `withTx`; nothing is reported outside the transaction; a failed COMMIT leaves the worker job retryable |
| impossible causal histories (synthetic timelines accepted by the oracle) | `tests/lab/dispatch_legality.ts` + synthetic suites | not a production concept — the black-box layer never reconstructs chronology; each scenario controls its own schedule |
| false mutation kills (observer/oracle mutants) | `scripts/review_mutation_proof.cjs` | the candidate ships no mutation harness; its proof is the direct test layer |

These defects remain documented on `claude/review-r9c-financial` (rounds 6–7) as
historical evidence and are not fixed here.

## 10. Open items

* **F-13** provider-contract issue: OPEN — `REAL_MONEY_BLOCKER = YES` (this does
  not by itself block a code merge).
* No new production P0/P1 was found by the black-box layer.

## 11. Next step

Codex independent review of the clean production candidate, then PR → GitHub
CI / Docker gates → merge if green.
