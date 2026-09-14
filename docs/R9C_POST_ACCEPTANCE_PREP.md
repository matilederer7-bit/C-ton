# R9C post-acceptance preparation

This is code preparation for PR/CI, not merge, deployment, or real-money approval.
R9C is NOT MERGED, NOT DEPLOYED; REAL MONEY 0; F13 OPEN and REAL_MONEY_BLOCKER YES.

## Inputs and integration

- Original master: `82c91d62fd092350748405c8aec15a23d0e2af5e`.
- PR #8 head at start: `fd2e1b996f7989526de1acbaa39e04c64179f4af`.
- Reviewed R9C source: `17cb25bdaff64a72f9a0af152fa519bf0edaecf6`.
- Preparation branch: `codex/r9c-post-acceptance-prep`, in a fresh worktree.
- R9C was one extraction commit directly on the original master; it was cherry-picked onto the provisional PR #8 base.
- Only conflict: both branches prepended sections to `PROJECT_STATUS.md`. Both sections were preserved. No production conflict occurred.
- PR #8 then advanced to `f3175dfd458035240428707be8f828caf7ec9058`: Docker diagnostics, MinIO image references, and workflow pipefail. These non-overlapping changes were incorporated by rebasing only this preparation branch.
- PR #8 subsequently advanced to `d77aecbce3353d7dd0b22eeae43532e1169c7d79`: Web runtime ephemeral-port resolution, removal of its temporary diagnostic workflow, and documentation. No R9C production file overlaps.
- During validation, PR #8 was merged by others. Final integration base: `a5e60cfb6fd1b0b09de41a6c4875e398a35889bc`, whose tree equals the final PR #8 tree. The preparation branch was rebased onto that landed master. This session performed no merge.
- Neither Claude branch nor local master was modified. No historical experimental branch was integrated.

`src/` and `scripts/migration_manifest.cjs` remain identical to the reviewed R9C source. The only file common to the R9C and PR #8 changes is `PROJECT_STATUS.md`.

## Validation

Executed on local PostgreSQL with disposable databases and a sanitized environment. Provider behavior uses HTTP stubs or injected test transports. No real provider credentials, hosted database, email, or SMS service was used.

| Check | Result |
| --- | --- |
| Independent migration proof | PASS 49/49 |
| Black-box B1–B12 | PASS 25/25 |
| payments | PASS 43/43 |
| workers | PASS 13/13 |
| concurrency | PASS 8/8 |
| failure | PASS 9/9 |
| integration | PASS 31/31 |
| db | PASS 8/8 |
| api | PASS 44/44 |
| security | PASS 39/39 |
| e2e | PASS 13/13 |
| Full test:all | PASS 223 files; 10/10 groups; 0 failed groups |
| Backend TypeScript, enforcement, payment compliance, runtime DDL | PASS |
| Architecture, canonical integrity, mobile build/normalization/release gate | PASS |
| Production server bundle and React production build | PASS |
| Static route inventory | PASS; 127 protected routes; 0 unguarded |
| Extended Docker / MinIO / multi-Web smoke | NOT RUN; Docker unavailable locally (`ENOENT`) |

The full suite ran on `1562ea88e45c7ae1b898509971582d5b482ab294` (R9C on PR #8 `f3175df`), in 1,160,915 ms. Final-base updates changed only CI scripts/workflows and documentation; runtime, test sources, manifest, and migration proof are unchanged. No second full-suite run is needed for unchanged runtime and tests.

Final-base reruns on `2cdc89a255b91062d62292badc91f54de0c4fbf5` (R9C on landed master `a5e60cf`): migration **49/49**, B1–B12 **25/25**, Docker readiness contract **1/1 test file**, syntax checks for both changed CI runtime scripts, and backend enforcement scan all **PASS**. The Docker readiness contract is a local test; it does not substitute for executing containers.

The React build initially lacked `jsqr` and `qrcode-generator` in the shared local dependency installation. A worktree-local `npm ci --offline` from the existing Web lockfile resolved this; the verified build returned exit 0. No lockfile or product code changed. Vite reported a non-failing bundle-size warning.

The initial automatic approval review rejected the Docker smoke runner because its `down -v --remove-orphans` cleanup can remove local project volumes. That cleanup was not executed. A separate read-only `docker version` check confirmed Docker is absent. Therefore this session cannot independently reproduce or clear the original PR #8 Docker failure. PR #8's inherited documentation reports its CI fixes; those claims are not counted as this combined branch's Docker execution evidence. R9C introduces no change to Docker/MinIO topology or the smoke scripts relative to the final base.

Local logs are under `.ci-artifacts/r9c-prep/` (ignored), including per-group logs, the full-suite log, migration logs, build logs, and runner exit-code summaries. Existing repository runners were used; no new proof framework was added.

## Financial facts and migration order

- B1–B12 assertions use provider requests/effects and committed PostgreSQL rows: lost/late captures, identity preservation, dispatch/lease fencing, foreign-reference refusal, ambiguity, dual-capture escalation, duplicate events, finalize races, orphan holds, and provider-proofed release.
- Migration 067 is manifest position **60**; migration 068 is position **61**. The 59 landed migrations through 066 keep their original bytes, identifiers, and order.
- Migration proof covers fresh install, master-shaped upgrade, legacy row preservation, historical checksums, tamper rejection, schema equivalence, and idempotent reruns.
- Siton fee rate is **8%**, with currency rounding, on the buyer charge including delivery and excluding authoritative buyer VAT. Any configured VAT on Siton's own fee is accounted for separately.
- Distributor commission and distributor payout commission are **0**. The payout rail derives the seller amount from canonical fee/charge/refund entries without a distributor commission deduction.
- F13 remains **OPEN**, a **real-money blocker**. No external F13 research was performed and Grow was not called.

## Packaging and next step

No R9C review lab, oracle, or mutation harness was imported. Existing test-only guarded fault hooks remain. As in the reviewed source, Docker's `COPY . .` includes test source files because `.dockerignore` does not exclude them; the compiled runtime excludes tests. This preparation preserves the source candidate's packaging rather than changing it.

PR #8 has landed. The next step is an R9C PR with required GitHub CI, including the actual Docker/MinIO/multi-Web and Web-runtime jobs. Local results support proceeding to PR/CI; they do not establish final merge readiness. No PR, merge, deployment, or real-money operation was performed by this preparation session.
