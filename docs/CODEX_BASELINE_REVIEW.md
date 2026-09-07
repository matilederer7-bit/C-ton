# Independent baseline candidate review — 2026-09-07

Decision: **REJECT the supplied pair for promotion. No combined runtime candidate was built.** Part C explicitly permits integration only when Parts A and B are independently clean. This branch is a review record, not a baseline to fast-forward into master.

## Verified references and isolation

- MASTER_BASE_SHA: `60ebf6d64fb0d5909ae98fa335a4a27ad45c9172`
- PRE_FINANCIAL_REVIEWED_SHA: `82f9171490ae84fb85eeea198ae071c7e96d4f59`
- CI_REPAIR_REVIEWED_SHA: `00861b9ee7205cf9f1304a919a74adad1c32e72f`
- CODEX_INTEGRATION_BRANCH: `codex/baseline-resilience-ci-integration` (review-only disposition)
- Worktree: `C:/Users/Lenovo/Documents/C-ton-codex-baseline`

`git ls-remote origin` independently confirmed all three supplied remote refs. Local master instead pointed to `75baa21`; it was not used or changed. The isolated branch starts at the exact requested SHA. No financial or Amazon branch/worktree was modified, merged, or cherry-picked. Candidate runtime files were temporarily materialized solely for tests and restored afterward.

## Promotion blockers

1. **CI credential detector misses real credential representations.** Executing the exact `leaksCredential` body from `00861b9` misses short passwords in spaced JSON; a password containing special characters in an encoded URL; and JSON-escaped special-character passwords. Examples are synthetic and reproducible in `scripts/review_baseline_candidates.cjs`. A redacted URL also incorrectly fails when its username contains a password of at least 12 characters. The repaired detector is not safe across the requested matrix even though the two-process worker scenario passes with the local credentials.
2. **The PG guard copies code-less error messages into logs.** `String(err?.code || err?.message || "unknown")` in `82f9171:src/db.ts` logs a synthetic `Error("password=SYNTHETIC_SENTINEL")` unchanged. This is a demonstrated logging path, not a claim that a real production credential was leaked. The previous pool handler logged a code or `unknown`, without the message fallback. Remove arbitrary message logging and prove redaction before promotion.
3. **The unmodified PG candidate test is not green here.** Its result was 9 passed / 1 failed, zero uncaught errors, 21 guard observations. The failed assertion was `guard did not observe the idle termination` in the pool-hygiene scenario. Real child-process survival passed. Increasing only the test pool idle timeout from 100 ms to 5 seconds, and adding an independent during-rollback scenario, produced 11/11 with zero uncaught errors. This supports an idle-timeout race in the original harness but is not a controlled repetition proving its unique cause. A diagnostic test modification does not make the exact supplied candidate green.

## Runtime evidence and negative controls

All database runs used the repository runner, a localhost PostgreSQL server, and separately created/migrated disposable test databases. Runners were sequential. The existing environment file was read without copying or printing its credentials. Tests target backend PIDs from the disposable test database.

| Runtime / experiment | Result |
|---|---|
| Exact master + candidate cancel tests | 6 passed / 16 failed; concurrent cancel HTTP 500 reproduced |
| Exact master + candidate PG tests | 0 passed / 10 failed; 20 uncaught errors; real child exit 1 |
| Exact proposed cancel runtime | 22 passed / 0 failed |
| Exact proposed PG runtime | 9 passed / 1 failed; 0 uncaught; real child exit 0 |
| Remove cancel serialization | 6 passed / 16 failed |
| Remove locked state reread | 7 passed / 15 failed |
| Move outbox insert after state CAS | 0 passed / 22 failed |
| CI request-ID tests with proposed resilience runtime | 9 passed / 0 failed |
| CI two-process worker test with proposed resilience runtime | test file passed |
| CI-only request-ID changes on unchanged master runtime | 9 passed / 0 failed |
| CI-only two-process worker changes on unchanged master runtime | test file passed |
| Diagnostic PG test: 5-second idle timeout plus independent during-rollback termination | 11 passed / 0 failed; 0 uncaught; 23 observations |
| Independent exact-source matrix | 59 checks: 51 passed / 8 failed (7 credential representations; 1 PG logging) |

The cancel suite exercises deterministic same/different-key races at 2/5/10/25 actors, seeded free-running variants, sequential new-key cancel, response-loss retry, edit, publish in both winner orders, worker pickup, worker retry, and independent-deal lock scope. It verifies a single canonical cancel audit and cancel_refund event, no duplicate provider intent, and no loser residue. Observed after fix: duplicate intents 0; unexpected HTTP 500 0; deadlocks 0. These statements are scoped to the tested Draft-deal cancellation path, not a financial lifecycle certification.

The PG tests cover before/after BEGIN, between statements, before COMMIT, active statements, row-lock release, after rollback, helper error propagation, pool reuse, and a real child with no uncaughtException handler. They check rollback of probe writes and rejected transaction outcomes. A kill while COMMIT is already in flight remains an ambiguous outcome; this review does not claim distributed commit certainty.

### Lock ordering assessment

`atomicMultiTransition` takes the canonical deal row first when serialization is enabled, then reads idempotency and current state before audit/outbox insertion and CAS. This prevents a benign cancel loser from reaching the partial unique outbox index. Publish takes the same initial deal lock; draft edit/delete also begin with that row. Reopen starts from ClosedForJoining, while cancel requires Draft, and its transaction updates the deal before inserting its deadline event. Worker claim/ack transactions lock outbox rows but commit their claim before event handling; the cancel_refund handler reads participants in a separate transaction and a cancelled Draft fixture has none. The reviewed paths did not expose a newly introduced outbox-to-deal/deal-to-outbox cycle. Payment-related participant locks and provider operations were inspected for this intersection, not exhaustively certified across every financial path. The row lock is an appropriate scoped fix; it is not a global deadlock proof.

## CI harness evidence

`60ebf6d..00861b9` changes exactly two test files and zero runtime files. The original request-ID substring false positive is forced by an unrelated deal ID containing `abc`. The original password substring false positive is forced by `postgresql://postgres:***@localhost/db`. Both are independent deterministic reproductions, not acceptance of branch reports.

The nine independent correlation checks accept exact UUID, short canonical and long IDs and reject prefix/suffix/contained-ID collisions, mixed IDs in one stream, wrong correlation, and control characters. The actual route suite covers hostile `abc`, absent/oversized/control-character values, real audit correlation, forced unrelated-ID collision, and fault logging. Incorrect correlation still produces red assertions. Credential negative controls expose the failures above; they cannot honestly be marked PASS.

## Scope and remaining validation

No runtime or migrations are imported in the final review record. No R9C, migration 063, Grow/provider, Amazon, or financial-torture source is imported. The supplied pre-financial status text also contains financial-program history and was not copied; this report adds only independent baseline evidence.

Parts C/D are not declared complete. The full ten-group sequential regression is deferred because the admission gate failed and there is no combined candidate to certify. All 11 static/build/authorization/mobile command executions passed on the restored review-only branch: typecheck, lint, backend enforcement (including secret scan), payment compliance, runtime DDL (62 files), architecture, demo build, route authorization (4/4 behavioral files), mobile build, normalization, and mobile gate. Mobile external signing/release placeholders remain pending. `git diff --check` also passed. These results apply to unchanged master runtime, not an accepted combined candidate; see CODEX_BASELINE_STATIC_GATES.json. The initial `all` run had an explicit two-file filter: its zero-selected groups are NOT full-suite passes. There are 191 other test files outside the four selected review files in the temporary 195-file inventory. No infrastructure-blocked execution is being disguised as a pass.

Suggested remediation: use a structured/escaping-aware credential detector with the full matrix; restrict PG error observations to safe error codes; make idle-termination tests retain a live selected backend and confirm termination; rerun exact-source tests and negative controls. Only after both repaired inputs pass should verified changes be ported, the full regression/gates executed, and an actual integration candidate pushed for promotion consideration.

## Reproduction

Run `node scripts/review_baseline_candidates.cjs` from this checkout with installed dependencies and the two reviewed git objects available. It deliberately exits 1 when the supplied candidates fail their required properties. It never uses real secrets or modifies runtime code. Sanitized matrix output and test summaries are stored alongside this report. Raw local test logs remain in the ignored `.tmp_baseline_evidence` directory and are not published.
