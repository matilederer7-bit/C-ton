# Independent final financial review

Reviewed candidate: 0a24396fc7edc8731075f033010e2ee2d221b7a5.
Exact master: 8ead7c828e6d6233bf7d17bf7f67d1a67ad35767.
Review branch: codex/r9c-final-financial-review. No merge, deployment or real Grow calls.
GitHub remote refs independently verified; merge-base is exact master, behind=0, ahead=38.
Candidate src/tests/scripts tree matches tested code tip 2aff706 exactly.

## Findings and disposition

### FFR-1 ? HIGH ? LAUNCH BLOCKER ? fixed, final regression pending
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

## Verification in progress
Initial unchanged-product financial proof set: 16 files passed, 0 failed.
Initial targeted mutations: 9/9 reported caught. Final evidence rerun will preserve raw
per-mutation output; first fee run overlapped a subsequently stopped filtered test runner,
so it is not the run of record. The full regression will run sequentially after stabilization.
The final soak proof now fails on UNRESOLVED_WITHOUT_CASE rather than allowing it.
