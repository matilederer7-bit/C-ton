# Real-money release governance

`REAL_MONEY_ALLOWED = false`. Status: **BLOCKED**. Decided by the owner on 2026-09-14. Source of truth: `config/real-money-release-policy.json`.

This is release governance, not a runtime flag. The application never reads this file. It exists so that no release process can describe a build as "production ready for money" merely because tests pass. The financial runtime keeps its own fail-closed guards (`src/production_guards.ts`, the provider adapters, the payment operation lifecycle); this file cannot enable money by itself and cannot weaken those guards.

## Where it is enforced

| Tool | Effect while BLOCKED |
|---|---|
| `npm run release:preflight` | prints `REAL_MONEY: BLOCKED` with the reasons on every run; the `no-real-money-proof` gate runs |
| `npm run proof:no-real-money` (`npm run gate:real-money`) | 16 checks: governance file consistent; every target config, workflow and npm script free of live money; runtime seam refuses live outside production, mock inside production, live credentials against the sandbox host; no live credential shape in runtime source |
| `npm run gate:runtime-env` | the production rule `PAYMENT_ENVIRONMENT != live` carries `governed_by: real-money-release-policy` and is lifted only when the governance file says ALLOWED |
| `npm run gate:startup-matrix` | proves that the fully configured live production environment is accepted by the runtime guard and refused by the release policy on exactly that rule |
| `npm run release:owner-check` | `READY FOR REAL MONEY: NO` |
| `npm run release:manifest` / `release:checklist` | record the status and the uncleared reasons |

## Blocking reasons (all uncleared)

1. `F13_PROVIDER_CONTRACT_UNRESOLVED` - the F-13 provider-contract issue is unresolved in the financial review (`claude/review-r9c-financial`, under independent review).
2. `GROW_LIVE_VERIFICATION_NOT_PERFORMED` - only sandbox transport proof exists (`docs/R9B_GROW_SANDBOX_PROOF_RUNBOOK.md`); the sandbox `userId`/`pageCode` blocker is still with Grow support; live mode has never been exercised.
3. `PRODUCTION_PAYMENT_ACTIVATION_NOT_APPROVED` - the owner has not approved production payment activation. Code deploy, database migration and real-money activation are three separate decisions (`docs/DEPLOYMENT_RUNBOOK.md`).
4. `FINANCIAL_BRANCH_NOT_INTEGRATED` - master carries no settlement-horizon or dispatch-lifecycle protection for real provider money until the financial candidate branch lands.

## How the flag is changed, intentionally

1. Every entry in `blocking_reasons` is set to `"cleared": true` with a dated `evidence` link (review report, Grow live proof, signed owner decision).
2. `real_money_allowed` becomes `true` and `status` becomes `ALLOWED` in the same commit, with `decided_by` / `decided_on` updated.
3. The commit is reviewed by a second person. `npm run proof:no-real-money` then switches from "assert blocked" to "assert every reason cleared with evidence" and fails on any reason left uncleared or without evidence (proven by `tests/release_tools/runtime_environment_policy.test.cjs`).
4. Runtime activation is STILL a separate action: production variables (`PAYMENT_PROVIDER=grow`, `PAYMENT_ENVIRONMENT=live`, credentials) are set in the hosting console after the file allows it, never before; `src/production_guards.ts` still refuses a mock provider, sandbox environment, test credentials, a sandbox host for live, missing `SITON_VAT_MODE=explicit` and missing secrets.
5. The release manifest for the activating deploy must show `real_money: ALLOWED` and the preflight must be green for that exact SHA.

## What this governance does NOT do

- It does not prove financial correctness. That is the financial review program (`docs/` R9C reports, `tests/lab`).
- It does not touch Grow, Supabase or Render.
- It does not replace the runtime guard; it precedes it.
