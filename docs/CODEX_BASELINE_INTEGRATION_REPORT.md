# Independently repaired baseline integration

The two repaired inputs passed independent review and were integrated only after admission. The combined baseline passed all 197 test files in the required ten-group order and all recorded static/build/mobile gates. No merge to master was performed.

## References

- Master base: 60ebf6d64fb0d5909ae98fa335a4a27ad45c9172
- Original pre-financial reviewed SHA: 82f9171490ae84fb85eeea198ae071c7e96d4f59
- Original CI repair reviewed SHA: 00861b9ee7205cf9f1304a919a74adad1c32e72f
- Independently repaired resilience input: 7317b7211fcfd6ea67dfb2f787a5fa0c0b96f6ff
- Independently repaired CI input: 2c4fa9c3d8bcedb1f07cd07d2a4da5b92c76d671
- Integration branch: codex/baseline-resilience-ci-integration
- Source SHA under the complete regression: c0d25d97d3238e3e5a8a84362faeaad87322c0b9
- The final publication commit adds documentation/evidence only; its exact SHA is supplied in the final response and branch head.

## Repairs and independent admission

The cancel correction takes the canonical deal row before idempotency/state reads and before durable audit/outbox writes. Exactly one cancellation wins; same-key calls replay and different-key losers return STATE_CONFLICT. The reviewed publish/edit/reopen/worker lock intersections introduce no observed inversion. This is scoped evidence for the Draft cancellation path, not a global financial deadlock certification.

The PG guard remains attached to each physical pooled client after checkout. It records only allowlisted connection error codes, with unknown as fallback; arbitrary error messages and credential-bearing code strings never enter its diagnostics. Statement and transaction errors still reach callers, including the original failure when rollback also loses its connection. Diagnostic observations remain bounded at 200. The PG test disables only its competing idle-retirement timer, verifies successful backend termination, and explicitly ends the pool. Active-statement promises have an immediate rejection observer and are subsequently awaited, preventing a test-created unhandled rejection without swallowing the transaction error.

The CI repair is test-only: a shared detector checks raw, encoded and JSON-escaped credential forms while excluding ambiguous username substrings from bare-secret matching. JSON request-log IDs are compared exactly with the canonical response ID; the route proof also compares the audit ID. Short, long, UUID, control-character, overlapping-ID and mixed-stream negative cases are covered.

| Independent positive proof | Result |
|---|---|
| Cancel matrix: same/different key; 2/5/10/25 actors; publish/edit/worker/retry | 22/22 |
| PG process survival including before/after BEGIN, statements, locks, COMMIT boundary and rollback | 11/11 on three independent-input runs, then passed in full DB group |
| PG log safety, single attachment and bounded observations | 7/7 on three independent-input runs, then passed in full DB group |
| Credential/correlation adversarial matrix | 181/181 |
| Real request-ID route/audit proof | 9/9 |
| Two-process worker fencing/reconnect proof | Passed independently and in full WORKERS group |

All eight deliberate mutations turned red and were restored: cancel serialization (16 failed scenarios), locked state reread (15), outbox ordering (22), missing PG guard (both PG files failed; child died), arbitrary PG message logging, blind credential detector, raw-substring credential detector, and bypassed request-ID correlation. Negative failures are expected proof, not unresolved final failures.

The original master failures remain independently reproduced in the historical report: cancel HTTP 500 at all requested actor counts (6 passed / 16 failed) and real unguarded child exit 1 (20 uncaught errors in the accompanying parent suite). Original credential false positives and missed encodings were forced with synthetic values. No real secret was published.

## Full sequential regression

Counts below are test files, not an inflated sum of nested assertions. No TEST_FILE_PATTERN filter was set; inventory total=197 and filtered=197. Each file used a disposable migrated local PostgreSQL database. No conflicting runner shared the worktree output directory.

| Group | Passed | Failed |
|---|---:|---:|
| UNIT | 12 | 0 |
| INTEGRATION | 29 | 0 |
| DB | 8 | 0 |
| API | 41 | 0 |
| WORKERS | 13 | 0 |
| PAYMENTS | 29 | 0 |
| SECURITY | 37 | 0 |
| CONCURRENCY | 6 | 0 |
| FAILURE | 9 | 0 |
| E2E | 13 | 0 |
| TOTAL | 197 | 0 |

All requested static gates passed: typecheck, lint, backend enforcement, payment compliance, runtime DDL (62 runtime files), architecture, secret scan, demo build, route authorization (4/4 behavioral files), mobile verification (build, normalize, gate), and diff --check. The mobile gate verifies shell/capability configuration; external signing/store-release placeholders remain pending. Exact command results and durations are in CODEX_BASELINE_FULL_REGRESSION.json.

## Scope, CI and disposition

Runtime changes are confined to src/app.ts and src/db.ts. The CI input changes only tests. The combined diff contains relevant regression tests, review scripts and status/evidence documentation. No SQL/migration changes, migration 063 additions, R9C lifecycle, financial torture lab, Amazon product code, Grow/provider changes, or financial branch content were imported. Claude's financial worktree and branches were not modified.

GitHub branch CI is NOT_TRIGGERED: workflow push filters target master, and the Actions API returned no runs for the integration push. Local green results are not GitHub CI green. No hosted deployment/smoke or financial-candidate approval is claimed. A disconnect while COMMIT is already in flight can still leave the transaction outcome uncertain; this patch does not add automatic retries or provider guarantees.

- CANCEL_RACE_REPRODUCED: YES
- CANCEL_FIX_CORRECT: YES
- CANCEL_DUPLICATE_INTENT: 0 observed
- CANCEL_500_AFTER_FIX: 0
- PG_UNCAUGHT_ERROR_REPRODUCED: YES
- PG_PROCESS_SURVIVAL: PASS
- PG_ERROR_NOT_SWALLOWED: PASS
- DEADLOCKS: 0 observed in reviewed scenarios
- NEGATIVE_CONTROLS: PASS
- CI_BRANCH_RUNTIME_DIFF: 0
- REQUEST_ID_FLAKE_REPRODUCED: YES
- REQUEST_ID_FIX_SAFE: YES
- CREDENTIAL_FALSE_POSITIVE_REPRODUCED: YES
- REAL_CREDENTIAL_LEAK_STILL_CAUGHT: YES for the required matrix
- CI_NEGATIVE_CONTROLS: PASS
- ONLY_EXPECTED_FILES: YES
- FINANCIAL_CODE_IMPORTED: NO
- MIGRATIONS_CHANGED: NO
- TESTS_FAILED: 0 final acceptance failures
- TESTS_BLOCKED: 0
- PROJECT_STATUS_UPDATED: YES
- SAFE_TO_FAST_FORWARD_MASTER: YES as a locally validated baseline candidate
- SAFE_FOR_FINANCIAL_BASELINE: YES as a baseline only, not financial-candidate approval

NEXT STEP: the owner fast-forwards this candidate to master, verifies GitHub CI and hosted smoke, and only then rebases/ports and independently reviews Claude's FINAL financial candidate against the new baseline. Codex did not merge master.
