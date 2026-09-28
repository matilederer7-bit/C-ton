# Siton Claude Code Entry Point

This file is the repository entry point for Claude Code.

Before any meaningful task, read and obey:

1. `AGENTS.md` — binding short operating rules for every coding agent.
2. `AI_WORKFLOW.md` — detailed execution workflow, testing, Git, coordination, and completion protocol.
3. `PROJECT_STATUS.md` — current implementation state and active blockers.
4. `docs/CANONICAL_FOUNDATION_SOURCE_OF_TRUTH_2026-04-18.md` plus any newer canonical amendments relevant to the task.
5. `docs/CLAUDE_TEAM_LEAD.md` — you are the owner's permanent team lead: plan, check the plan with `scripts/team_plan_check.cjs`, dispatch, review, CI, merge and verify deploy.

Do not ask the owner to repeat rules already defined in those files.

## Default execution mode

Work autonomously within the assigned scope. Inspect before editing. Reuse existing implementation instead of rebuilding it. Keep the patch narrow and coherent. Do not spend coding-agent credits on broad external research unless explicitly assigned.

For meaningful work, use an isolated task branch and do not touch another agent's working tree or branch. When parallel work exists, inspect current branch, status, recent commits, and likely overlap before editing.

Run focused tests first, then the appropriate broader gates for the risk level. Never weaken tests or safety boundaries merely to get green results.

At every meaningful milestone update `PROJECT_STATUS.md` with completed, checked, open, percentage, and next step.

When the task is coherent and verified, commit it clearly, push the branch, and open a Pull Request when integration or review is expected.

## Push checkpoint rule

Follow the push checkpoint rule in `AGENTS.md`: fetch, isolated task branch, preflight push before substantial implementation, checkpoint pushes at each coherent milestone, final push after tests and the `PROJECT_STATUS.md` update, then verify the remote SHA before reporting or opening a Pull Request. Never leave completed work only in a session container.

## Failure-loop and Git failure rule

Do not repeat materially identical failed tactics more than twice.

If GitHub push fails because the current session lacks repository authorization, especially a repeated 403 after access/setup was already attempted:

1. stop retrying the same push path;
2. keep the working tree clean and the completed commit intact;
3. produce a complete patch from the intended base;
4. report branch, base SHA, final commit SHA, patch path/name, and exact apply command;
5. continue only with work that does not depend on the blocked push.

Do not burn time or credits on authentication loops.

## Protected actions

Do not trigger real customer charges, payouts, refunds, production messaging, production data destruction, production schema changes, credential rotation, or other live irreversible effects unless the owner explicitly authorized that specific action.

## Codebase map

### What the product is

Siton (C-ton) is a Hebrew-default, bilingual (`he`/`en`) group-deal marketplace. Hebrew is the product default and is never inferred from the browser; direction follows locale (`he` → RTL, `en` → LTR). A seller publishes a deal with a finite mandatory `max_units`; buyers join and pay; when the deal tips, Siton captures/settles charges, takes its platform fee (rate and rules are binding in `AGENTS.md` — not restated here), and the seller fulfils by shipping or pickup. There is no distributor/affiliate role or product path (`AGENTS.md`).

### Runtime shape

Two Node processes share one PostgreSQL database and one codebase (package `"type": "module"`, Node >= 22):

- **Web** — entry `src/app.ts` (`npm run dev` locally, `node .demo_dist/src/app.js` in the demo/prod bundle). Fastify HTTP API, the deal/participant state machine, charging, plus server-rendered no-JS shells (legal pages, share/pay fallbacks). Serves the built `web/` (Vite/React) app in production.
- **Worker** — entry `src/worker.ts` (`npm run start:worker`). Polls the outbox table and dispatches payment, notification, invoice and payout events; runs reclaim/maintenance cycles and a watchdog. Can be disabled per-environment (`DISABLE_OUTBOX_WORKER`).

Both processes connect to one canonical PostgreSQL authority (`src/db.ts`, `src/runtime_database_boundary.ts` refuse a silent fallback database). Schema changes go through a numbered, checksummed migration ledger (`src/migrations/`, applied by `npm run db:migrate`, tracked in table `siton.migration_ledger`). Object storage (deal images, etc.) goes through a pluggable adapter (`src/storage_adapter.ts`: local / S3 / Supabase broker). Side effects that must survive a crash (notifications, invoices, payouts, reconciliation) are written to an outbox in the same transaction as the state change and drained by the worker (`src/outbox_worker_helpers.ts`, `src/notification_dispatch.ts`, `src/payment_attempt_helpers.ts`), not fired inline from a request handler.

### Where things live

| Path | Holds | Owner |
|---|---|---|
| `src/` | Fastify backend: routes, state machine, payments, business logic | backend |
| `src/app.ts` | Web process entry: routes, deal/participant state machine, charging, outbox producers | backend / state machine |
| `src/worker.ts` | Worker process entry: outbox consumer loop, scheduling, watchdog | backend / workers |
| `src/migrations/` | Numbered, checksummed SQL/TS migrations | database |
| `web/` | Current React + Vite buyer/seller/admin app | frontend |
| `frontend/` | Legacy PWA shell (service worker, manifest, static `app.js`) for no-JS/mobile-bridge surfaces | frontend (legacy) |
| `tests/` | ~326 `.ts` validation suites, grouped by `scripts/run_test_group.cjs` | test authors, reviewed per risk family |
| `scripts/` | Gates, proofs, migration tooling, release tooling | tooling / CI |
| `config/` | JSON policy tables the gates read (route classification, runtime-environment policy, real-money release policy, etc.) | tooling / CI |
| `docs/` | Canonical foundation + amendments, runbooks, architecture/decision records | product / process record |
| `supabase/` | Staging Supabase-specific SQL (login provisioning, storage broker) | database / staging ops |
| `docker-compose*.yml`, `Dockerfile` | Local demo stack and CI/release-lab containers | tooling / CI |
| `render.yaml` | Render staging blueprint: web + worker services, env var contract | deploy / ops |
| `.github/workflows/` | CI gates (backend, release readiness, web runtime, mobile, Codex re-review, off-site backup) | CI |
| `android/`, `ios/`, `mobile/`, `mobile-plugins/`, `capacitor.config.ts` | Capacitor mobile shell | mobile |

### How to run and test

- **Local dev**: `npm run dev` (web), `npm run start:worker` (worker), `npm run db:migrate` (apply migrations), `npm run bootstrap:demo-db` / `npm run start:demo` (seeded demo stack).
- **Grouped backend suite** (`scripts/run_test_group.cjs`, each group runs against disposable per-file PostgreSQL databases): `npm run test:unit`, `test:integration`, `test:db`, `test:api`, `test:workers`, `test:payments`, `test:security`, `test:concurrency`, `test:failure`, `test:e2e` — or all of them via `npm run test:all` (alias `npm test`).
- **Migrations**: `npm run db:migrate`, `npm run ci:migrations` (ledger report), `npm run test:migrations-isolated` (isolated proof), `npm run migrations:preflight`, `migrations:doctor`, `migrations:repair`.
- **Static/backend gates**: `npm run lint`, `npm run scan:backend`, `npm run scan:payment`, `npm run scan:runtime-ddl`, `npm run gate:architecture`, `npm run gate:i18n`, `npm run gate:seven-day-cap`, `npm run gate:base44-canonical-integrity` (+ `npm run test:base44-canonical-integrity`).
- **Web/mobile depth**: `npm run web:routes`, `npm run ci:web-runtime` / `ci:web-runtime:extended`, `npm run ci:route-authorization`, `npm run mobile:verify` (= sync + gate), `npm run test:mobile-readiness`.
- **Release readiness**: `npm run release:preflight` (`:static` / `:full` profiles), `release:manifest`, `release:checklist`, `release:owner-check`, `release:local-lab`, `npm run proof:no-real-money` (alias `gate:real-money`).
- **Named feature suites**: many more `test:<feature>` scripts (e.g. `test:platform-fee-payments`, `test:seller-payout-rail`, `test:grow-adapter`) each compile via `tsconfig.test.json` and run one focused `.tmp_test_dist/tests/*_validation.js` file — grep `package.json` for the one that matches the feature rather than guessing its name.

### Gates that must stay green

- `backend-quality-gates.yml` — TypeScript build, `lint` + `scan:backend`, `gate:i18n`, `scan:payment`, `scan:runtime-ddl`, `gate:seven-day-cap`, `gate:base44-canonical-integrity`, `build:demo`, `gate:architecture`, `mobile:verify`, `ci:migrations`, the full `test:unit` → `test:e2e` sequence, `ci:route-authorization`, `ci:fault-report`, `test:all`, `ci:docker-smoke`. The authoritative merge gate for backend/product changes.
- `release-readiness.yml` — `release:preflight:static`, `release:manifest`, `release:checklist`, `release:preflight`, `release:local-lab`. Guards that a release is deployable and every real-money/legal precondition holds.
- `web-runtime-depth.yml` — `web:routes`, `ci:web-runtime` / `ci:web-runtime:extended`. Guards the built web app's routing and runtime behavior in a browser.
- `mobile-readiness.yml` — `mobile:verify`, `test:mobile-readiness`, plus a clean `git diff` on `android`/`ios`. Guards the Capacitor native bundles stay in sync with web output.
- `codex-rereview.yml` — re-requests the Codex independent review whenever a PR head changes (see `docs/CLAUDE_TEAM_LEAD.md`).

Never weaken, skip, or disable any of the above merely to get a green result.

### Conventions that are not obvious from a single file

- **Hebrew/RTL**: Hebrew is the default and only inferred locale on first visit — never from `navigator.language`. Direction follows locale (`web/src/i18n/locale.ts`) and the choice is persisted in both `localStorage` and a first-party cookie, so server-rendered shells and the React app never disagree on language.
- **Migration numbering + ledger**: migrations apply in a fixed, hand-maintained order (`scripts/migration_manifest.cjs`), not filename sort — a same-numbered split (e.g. two files both prefixed `015_`) is ordered explicitly as `015a`/`015b`. Every migration body is checksummed (BOM-stripped, CRLF-normalized to LF) into `siton.migration_ledger`; `.gitattributes` forces `src/migrations/*.sql` to LF so the checksum matches on Windows and Linux checkouts alike.
- **Money and VAT**: every money column is `numeric(12,2)`; an accepted amount is rounded to that scale before validation so the validated value and the stored value can never disagree (`src/money_input.ts`). The platform fee is computed through one canonical engine (`src/platform_fee_money.ts`); VAT through `src/vat_authority.ts`. Never reimplement rounding or fee math inline.
- **Idempotency and outbox**: money- and notification-relevant side effects are written to an outbox row in the same transaction as the state change, then drained by the worker under lease/idempotency-key discipline (`src/outbox_worker_helpers.ts`, `src/payment_attempt_helpers.ts`). Never call a notification or payment provider directly from a request handler.
- **`.cjs` script convention**: the package is ESM (`"type": "module"`), so operational/gate scripts are plain CommonJS `.cjs` files — this lets them `require()` synchronously with no build step. A script that needs TypeScript runs via `tsx` instead.

## Orchestration default

Parallel sub-agent orchestration is the default operating mode for meaningful work, not an opt-in. `docs/CLAUDE_TEAM_LEAD.md` is the detailed procedure; this is the short version every session follows:

- A small, single-scope task (one file, one narrow fix) is fine to work solo.
- Two or more independent workstreams are dispatched as parallel sub-agents, not serialized one after another.
- Do not spawn an agent that earns nothing: no sub-agent for work that is faster to do directly, and no extra reviewer for a change too small to need one.
- Use the cheapest model that fits the risk: cheap (`haiku`) for recon and lookup, mid (`sonnet`) for ordinary build work, senior (`opus`) for anything touching database, security, payments/money, auth, the state machine, or architecture.
- The builder and its reviewer are never the same agent; Codex is an additional independent reviewer on top of the Claude reviewer, not a replacement for one.
- Every work plan is machine-checked by `scripts/team_plan_check.cjs` before any writer starts; a plan that does not print `TEAM_PLAN_PASS` is not dispatched. An overlap with an open branch is accepted by listing the path in `plan.accepted_overlaps` with a written `plan.overlap_decision`, never by dispatching around a failing or ignored check output.

Where this default would conflict with an existing repository rule, the repository rule wins — this section adds a default on top of `AGENTS.md` and `docs/CLAUDE_TEAM_LEAD.md`, it does not relax either, and it does not restate the product invariants already binding in `AGENTS.md`.

## Completion report

Return only useful evidence:

- Result
- Changed
- Tested
- Commit
- Branch / PR
- Open blocker
- Next step

The goal is maximum verified progress with minimum owner intervention and minimum token/credit waste.
