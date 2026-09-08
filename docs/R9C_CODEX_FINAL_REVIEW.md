# Independent final financial review

Reviewed candidate: 0a24396fc7edc8731075f033010e2ee2d221b7a5.
Exact master: 8ead7c828e6d6233bf7d17bf7f67d1a67ad35767.
Review branch: codex/r9c-final-financial-review. No merge, deployment or real Grow calls.
GitHub remote refs independently verified; merge-base is exact master, behind=0, ahead=38.
Candidate src/tests/scripts tree matches tested code tip 2aff706 exactly.

## Findings and disposition

### FFR-1 ? HIGH ? LAUNCH BLOCKER ? fixed and regression verified
The provider-ready status adapter removed ANY three-letter prefix from both references.
A response for xyz-<authorization> consequently passed the exact-reference guard.
The independent real-worker proof dispatched a capture that returned 503 with no effect,
then supplied a captured status for this foreign reference with the correct amount/currency.
Before repair: money_state=ChargedSuccess, attempt=success, provider captures=0.
The regression failed on false canonical capture. After repair: the regression passes,
identity remains unresolved and a reference-mismatch operational case exists.
Repair restricts aliases to defined cap/rec/ref/rel prefixes (case-sensitive), matching the
provider-ready protocol. No other payment behavior changes.
Proof: tests/payment_final_reference_collision_validation.ts. Mutation M36 restores the defect.
Local raw evidence: .review-evidence/independent-before-fix.log and independent-after-fix.log.

### FFR-2 ? MEDIUM ? POST-LAUNCH FOLLOW-UP category ? test defect repaired
B2 seeded RNG with 1, but its correlation keys include random UUIDs. Each buyer gets one
capture draw, regardless of quantity. There is a 10% first-draw permanent-decline region;
transient pre-dispatch failures retry and can subsequently decline. Four buyers with
quantities 3,2,2,1 must contribute at least two successfully captured units. Declining the
first three and capturing the one-unit buyer legitimately produces Failed; the first-draw
shape alone has probability 0.1^3*0.75=0.00075 under independent uniform draws (an explanatory
approximation, not a measured distribution of this hash). More retries cannot guarantee success.
The controlled real-worker proof verifies Failed for the one-unit survivor and Completed for
the three-unit survivor. The original historical capture trace is unavailable: this establishes
a sufficient reproducible cause, not forensic certainty about that one execution.
B2 and ticket fixtures now seed undispatched identities whose real mock first draw is known.
B2 exercises three successful buyers plus one declined buyer, with exact eligibility assertions.
No product threshold, finalization or retry semantics were changed. Tests run in isolated child
processes/databases with the background worker disabled; UUID-based input variability exists
within a file despite fixed MOCK_SEED, independently of inter-test sharing or worker timing.

### FFR-3 ? MEDIUM ? POST-LAUNCH FOLLOW-UP ? migration tooling portability
The long-lived local 014 checksum matches the LF file exactly and does not match this Windows
CRLF checkout. run_migrations hashes line endings. This is TOOLING_ISSUE, with no demonstrated
SQL-content drift. Never edit the old ledger to hide drift. A portable checksum/checkout policy
is deferred; a deployment must use migration bytes matching its ledger. This candidate did not
change migration 014. Disposable upgrade from master's 57 migrations to candidate's 59,
clean rerun, sentinel preservation, deliberate 014 mismatch rejection and unchanged bad ledger
all pass. Script: scripts/final_review_migration_proof.cjs. The production/hosted ledger has not
been inspected and no compatibility claim is made for an unknown hosted ledger.

### EP-1 ? EXTERNAL PROVIDER BLOCKER ? OPEN
Grow sandbox credentials and contractual evidence for exact-operation status, finality,
settlement horizon, callbacks and money operations remain external. Real Grow calls=0.
Grow automatic recovery from unproven negative status remains fail-closed.
The authoritative-provider contract-breach scenarios intentionally demonstrate duplicate
capture when a provider lies after its declared settlement horizon. Signed provider events
can also assert effects the provider ledger does not contain: existing synthetic late-refund
fixtures deliberately produce FALSE_CANONICAL_REFUND. Passing such tests is not evidence
of universal zero financial violations. Zero claims must be scoped to supported provider
contracts and honest effect evidence; these boundaries prevent real-money approval.

## Verification record
Initial unchanged-product financial proof set: 16 files passed, 0 failed.
Final accepted mutations: 10/10 distinct defects caught, each with a financial test failure. M18 required repair of the runner; its setup-error results are excluded. The full sequential suite passed 226/226 files in 1,939,493 ms. The final soak proof hard-fails UNRESOLVED_WITHOUT_CASE. See R9C_CODEX_FINAL_REVIEW_EVIDENCE.json for exact counts and mutation summaries.

### FFR-4 ? MEDIUM ? POST-LAUNCH FOLLOW-UP category ? proof tooling repaired
Raw M18 evidence showed migration setup failed with SQL syntax error before any financial test ran.
The replacement string contained PostgreSQL $$ delimiters; String.replace interpreted $$ as a literal
single dollar. The runner also treated any non-TypeScript error as a caught mutation.
The fix uses a replacement callback, requires TEST_FAIL evidence for RED, classifies setup failures
separately and exits nonzero for invalid or surviving mutations. The original M18 result is excluded
from accepted proof. A corrected M18 rerun is retained separately.

## Required attack coverage

| Attack | Executed proof files (tests/) |
|---|---|
| 1. Lost capture response, failed status | payment_lab_c1_c2; payment_final_residual_a_unproven |
| 2. Capture effect + 503, authorized status | payment_lab_c1_c2; payment_review_settlement_horizon |
| 3. Consistent lies past horizon | payment_final_residual_a_unproven; payment_final_residual_a_authoritative (explicit contract breach) |
| 4. Wrong reference | payment_review_adversarial; payment_final_residual_a_authoritative; new payment_final_reference_collision |
| 5. Wrong currency | payment_review_adversarial RA-3; residual A AA-6 |
| 6. Stale sibling identity | payment_review_findings_reconstruction FR-4 |
| 7. Recovery before original settles | payment_review_settlement_horizon H-1/H-3; payment_lab_refund_release_recovery |
| 8. Release while capture unresolved | settlement horizon H-5; payment_lab_refund_release_recovery |
| 9. Capture while release unresolved | payment_final_residual_c RC-1/RC-3/RC-5/RC-6/RC-7 |
| 10. Refund after ambiguous capture | payment_lab_refund_release_recovery; payment_lab_lifecycle_reconcile |
| 11. Two workers | payment_lab_concurrency_matrix; worker_two_process_fencing |
| 12. Stale worker ownership | payment_r9c_stale_owner_settle; residual C RC-4 |
| 13. Reconcile versus capture | payment_r9c_reconciliation_race; payment_lab_c1_c2 |
| 14. Finalize before canonical apply | payment_review_findings_reconstruction FR-2b/FR-2c; payment_lab_finalize_guard |
| 15. Legacy NULL horizon | payment_final_residual_b LB-1 through LB-7 |
| 16. Identity rotation | payment_lab_lifecycle_reconcile; settlement horizon H-8 |
| 17. Post-completion late effect | payment_lab_terminal_economics; payment_review_findings_reconstruction |

File names above omit the _validation.ts suffix. Contract-breach controls and deliberately
false signed callbacks are reported separately from supported-contract economic invariants.
The legacy oracle allows certain provider-contradiction codes in fuzz; a green fuzz result
alone does not establish every requested zero. The final soak independently hard-fails lost
provider effects and unresolved operations without a case and reports global reconciliation.

## Final promotion gate: master advanced during the review

### FFR-5 ? HIGH ? LAUNCH BLOCKER ? OPEN for integration with current master
At review start GitHub master was exactly 8ead7c8. At final verification it was
ed9d6f80aedb8f77a52d2ea8f1452af73dbc5f00 (seven commits ahead of the specified base).
The financial candidate remains 0a24396. Current master adds pilot migration 065 at ledger
position 58, while the financial candidate assigns position 58 to migration 063.
A disposable database upgraded through current master's 065 then rejected the financial
manifest with duplicate key migration_ledger_position_key. This is a real new-target upgrade
risk, separate from the LF/CRLF checksum issue. No hosted database was queried or changed.
The exact requested baseline 57-to-59 upgrade passed; it does not prove compatibility with
the seven new master commits. No merge, rebase, cherry-pick of those commits, or protected
branch modification was performed: doing so would change the expressly requested review target.
Required integration: preserve already-applied 065 at position 58, append 063/064 afterward,
combine the pilot and financial application changes in a new integration candidate, and verify
that combined candidate before promotion. Do not rewrite an applied ledger or reorder 065.

## Final verification and decision

- Tested code/scripts/tests SHA: f62ab41428efbcf9b5d420aff9b62afc8abdbd31. Final tip is documentation/evidence only.
- Full suite: unit 12/12; integration 29/29; DB 8/8; API 41/41; workers 13/13; payments 57/57; security 37/37; concurrency 7/7; failure 9/9; E2E 13/13. Total 226/226, 0 failed.
- Fresh fuzz: 500/500, seed 26090817, 783 participants, 886 effects, 269 seconds. Known F-9 replay: 200/200, seed 2061983203, 300 participants, 343 effects, 89 seconds.
- Soak: 120-second load period plus drain (210,483 ms suite); 853 deals, 2,156 participants, 3,941 provider operations, two workers/reconciler, global oracle violations 0. Captures 1,741, recoveries 68, releases 346, refunds 0; provider and canonical captured totals both 16,235,450 minor units. Fee ledger and oracle both 1,532,354 minor units. Unknown identities 0; visible unresolved 13, cases 14; deadlocks/unhandled/uncaught 0. Refund invariants additionally exercised in targeted and concurrency suites.
- Baseline preserved: cancel concurrency 22/22, PG process survival 11/11, request-id suite PASS, credential-log detection 181/181, two-process worker proof PASS.
- Static gates 9/9, demo build PASS, mobile build/normalization/gate PASS, whole-delta whitespace PASS, fresh migrations 59/59 plus rerun/drift 0 PASS.
- Economic invariant counters in the strict final soak: DUPLICATE_CAPTURE=0, DUPLICATE_RECOVERY=0, DUPLICATE_REFUND=0, DUPLICATE_RELEASE=0, FALSE_AUTH_RELEASED=0, FALSE_CANONICAL_SUCCESS=0, LOST_PROVIDER_EFFECT=0, UNRESOLVED_WITHOUT_CASE=0. These are not unconditional claims about deliberately false provider evidence: authoritative-provider breach cases AA-2/AA-7 each exhibited capture+recovery, and the late-refund false-callback control admits FALSE_CANONICAL_REFUND.
- Exactly 8% commission on applicable gross including delivery excluding buyer VAT; distributor commission/payout 0. Verified by real ledger assertions and independent oracle; fee mutation caught.
- B2 root cause: FOUND (probabilistic test design; sufficient controlled cause proven; historical one-off trace unavailable). Disposition PASS after deterministic fixture.
- Migration 014 checksum disposition: TOOLING_ISSUE (LF/CRLF). Separate current-master 065 upgrade disposition: REAL_RISK, reproduced.
- Findings: Critical 0/0 fixed; High 2/1 fixed (FFR-1 fixed, FFR-5 current-master integration OPEN); Medium 3/2 fixed; Low 0. Launch blockers OPEN 1; post-launch followups OPEN 1; external provider blockers OPEN 1.
- R1-R11 PASS on repaired reviewed code. Residual A/B/C PASS within the explicitly stated provider contract.
- Failed final tests 0; blocked required local tests 0. Real Grow proof remains external and unexecuted. Preliminary evidence retained: missing mobile build artifact caused one setup-related test failure before the clean rerun; first draft of the new threshold fixture tried to enqueue an existing finalize event and was corrected; expected pre-fix/mutation red runs are not final regression failures.
- SAFE_TO_MERGE_TO_MASTER=NO (current master advanced and its upgrade path conflicts). SAFE_FOR_REAL_MONEY=NO. READY_FOR_LAUNCH_MODE=NO for current combined release; exact-base financial review completed.
- NEXT STEP: integrate the reviewed financial branch with current master while preserving applied migration positions, validate the combined candidate, then verify GitHub CI and hosted smoke and proceed with Launch Gap Review. Grow sandbox proof remains required before real money.
