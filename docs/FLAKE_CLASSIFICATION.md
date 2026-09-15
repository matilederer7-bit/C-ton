# Flake classification

Three words, deliberately distinct. Helper: `scripts/lib/flake_classifier.cjs`; runner: `npm run qa:classified -- <command>` (`scripts/qa_run_classified.cjs`); also applied by `scripts/release_preflight.cjs` to every failing gate.

| Word | Meaning | What happens |
|---|---|---|
| REAL_FAILURE | the code under test is wrong. Default for every failure. | exit code preserved; nobody reruns |
| ENVIRONMENT_FAILURE | the run could not be executed as intended on this machine (documented signal present in the child's output, no test-failure marker) | exit code preserved; the preflight reports the gate as `SKIPPED_ENVIRONMENT`, never `PASS` |
| SPAWN_REFUSED | the harness's OWN spawn of the gate program was refused by the OS (`error.code` `EPERM` / `EACCES`, no exit status) - a sandbox, antivirus or permission policy | environmental: `SKIPPED_ENVIRONMENT`, the refused command is named |
| EXECUTABLE_MISSING | the harness's own spawn found no program (`ENOENT`, `EFTYPE`, `ENOEXEC`) - every catalogue command names a checked-in tool dependency, so this is a repository/catalogue defect | `FAIL`, never skipped |
| TIMEOUT | the child did not finish inside the harness timeout (`ETIMEDOUT`) | `FAIL` (a hang is real until proven otherwise) |
| CORRECTIVE_RERUN | a second run explicitly requested by an operator with `--rerun-once-on-environment-failure` after an ENVIRONMENT_FAILURE; recorded as such in `.release-artifacts/qa-classified-*.json` | the SECOND run's exit code is final; a REAL_FAILURE is never rerun |

No test is ever silently converted into a retry. Classification is advisory and never changes an exit code by itself.

## Documented environment signals (from this repository's history)

| Signal id | Pattern | Root cause seen | Prevention |
|---|---|---|---|
| docker-unavailable | `docker: command not found`, `Cannot connect to the Docker daemon` | local QA machines without Docker | `SKIPPED_ENVIRONMENT`; CI proves Docker paths |
| spawn-eperm | `spawnSync ... EPERM` | sandboxed review shells refusing child processes (R9C review: listener, two-worker matrix, fencing proof) | run outside the sandbox; the failure is not the code |
| port-in-use | `EADDRINUSE` | leftover web runtime on 3000/3001 from an earlier run | `allocateFreePort()` in `scripts/lib/test_db_isolation.cjs`; `npm run qa:diagnose` lists occupied ports |
| postgres-unreachable | `ECONNREFUSED 127.0.0.1:5432` | local Postgres stopped / sleep-resume | restart the service; the run is environmental |
| postgres-too-many-clients | `too many clients already` | leaked pools from killed runners | `npm run qa:diagnose` shows leaked test-DB connections |
| database-in-use / database-exists | `is being accessed by other users`, `already exists` | two runners on one `DATABASE_URL`; stale template DB names | agent-tagged unique names; one runner at a time; `npm run qa:cleanup-stale-dbs -- --yes` |
| windows-file-lock | `EBUSY`, `EPERM ... unlink` | editor/antivirus/previous node holding `.tmp_test_dist` files | rerun after closing the holder; never `rm -rf` while a runner is alive |
| npx-wrapper-missing | `spawnSync npx.cmd ENOENT` | Windows wrapper resolution in non-interactive shells | `scripts/lib/run_command.cjs` invokes `cmd.exe /c npm ...` or the Node binary directly |
| spawn-timeout | `ETIMEDOUT`, `timed out after N ms` | host under load, sleep/suspend mid-run | rerun when the host is quiet; check the clock |
| libuv-teardown | libuv assertion at exit | Windows libuv teardown race after a passing test body (R9A) | drain handles before exit; treat as environmental only when the body passed |
| playwright-browser-missing | `Executable doesn't exist`, CDP `ECONNREFUSED` | browser binary not installed / CDP port | install browsers; hosted browser proofs run on staging |
| clock-jump | clock moved backwards | laptop sleep | rerun |

## Order of evaluation (structural first, text second)

`classifySpawnResult()` looks at the harness's own `spawnSync` result before reading any output: a timeout, a refused spawn (`EPERM`/`EACCES`) and a missing program (`ENOENT`/`EFTYPE`) are decided from `error.code` and the absence of an exit status. Only a child that actually RAN is judged by its text, and there a test-failure marker always dominates: `AssertionError`, `ERR_ASSERTION`, `TEST_FAIL`, `FAILED_GROUP`, `_FAIL`, TAP `not ok` and a node:test summary `ℹ fail N` (N > 0) make the failure REAL even when an environment signal appears in the same output. The signals are then reported as `ignored_signals=` rather than `signals=`, so the summary line never reads like an environment verdict.

Why: the first GitHub run of `release-readiness.yml` reported the `release-tools-tests` gate as `FAILURE_CLASS=REAL_FAILURE signals=spawn-eperm assertion_seen=true`. The `spawn-eperm` text came from a NESTED preflight fixture (`tests/release_tools/release_orchestration.test.cjs` deliberately prints `spawnSync docker EPERM` to prove the SKIPPED_ENVIRONMENT path); the real failure was an assertion in that test - its `needs: docker` fixture gate expected SKIPPED_ENVIRONMENT, which holds on a laptop without Docker but not on a GitHub runner, where the gate ran and passed (`skipped_environment=1`, expected 2). The test now forces the capability absent through `SITON_PREFLIGHT_ASSUME_UNAVAILABLE=docker` (a control seam that can only remove capabilities), and the same file carries adversarial gates for exit 1, nested-noise assertion failure, a genuine environment signal, a hang, a missing executable and (POSIX) a refused spawn - each classified distinctly.

## Sources of environmental flakiness and the helper that removes each

| Source | Helper |
|---|---|
| shared database names | `scripts/lib/test_db_isolation.cjs` - `siton_<purpose>_<agent>_<pid>_<time>_<rand>`, local hosts only, exit-hook drop, preserve-on-failure |
| fixed ports | `allocateFreePort()`; the local runtime harness (`scripts/lib/local_runtime.cjs`) never uses 3000 |
| leftover node processes | `scripts/lib/process_cleanup_guard.cjs` - kills only owned children; `qa:diagnose` lists strays without killing |
| Docker availability | capability probe in the preflight; `SKIPPED_ENVIRONMENT` |
| sleep/suspend, clock | spawn-timeout / clock-jump signals |
| Windows npx wrappers | `scripts/lib/run_command.cjs` |
| CRLF/LF | migration checksums are LF-canonical; `.gitattributes` pins `*.sql`; test fixtures normalise anchors |
| parallel worker collisions | agent-tagged names + the one-runner rule (`docs/PARALLEL_AGENT_DEVELOPMENT.md`) |

Controls: `tests/release_tools/process_and_flake.test.cjs` (classifier positives/negatives incl. the structural `classifySpawnResult` cases - EPERM/EACCES refused, ENOENT/EFTYPE missing, ETIMEDOUT, exit 1, nested-noise; runner exit codes and rerun semantics, owned-child-only kill, diagnose CLI) and `tests/release_tools/release_orchestration.test.cjs` (the same categories end-to-end through the real preflight).
