# Release readiness scorecard

Date: 2026-09-14. Branch: `claude/release-readiness-night` (from canonical master `82c91d62fd092350748405c8aec15a23d0e2af5e`). Evidence machine: Windows 11, Node 24.13.1 (CI/Docker use Node 22), PostgreSQL 18 local, **no Docker engine locally**. Percentages describe how much of each area is PROVEN by an automated, repeatable gate for this commit; they are not inflated for hosted or provider work that was not executed. Real money stays **BLOCKED**.

Regenerate the live numbers with `npm run release:preflight` (`.release-artifacts/release-preflight.md`), `npm run release:checklist` and `npm run release:owner-check`.

| Area | Status | % | Evidence (2026-09-14) | Next step |
|---|---|---|---|---|
| Repository hygiene | COMPLETE | 95 | `repository-hygiene` PASS: 951 tracked files, no tracked artefacts/env files, whitespace clean on the branch range, migrations LF in the index + `.gitattributes` pin, `.worktrees/` + `.release-artifacts/` ignored (git and Docker); canonical scan policy with 5 tests; `.worktrees` on the developer machine still holds 15+ checkouts | keep; prune stale worktrees on the dev machine (`git worktree prune`) |
| Build | COMPLETE | 95 | TypeScript clean; demo bundle 82 files, mobile 17, Vite 10 - all DETERMINISTIC across two clean builds; mobile/PWA contract PASS; Docker static readiness PASS; **image build itself not executed here (no engine)** | image build proven by `release-readiness.yml` / `docker-release-lab` on the next PR |
| Tests | PARTIAL | 85 | route-authorization behavioural gate PASS (static 1 + 4 suites); 59 release-tool tests PASS; existing groups unchanged and green in CI at master; `payment`/`security` groups run in CI and in the `full` profile (not re-run in this overnight run) | run `npm run release:preflight:full` after rebase on the integrated master |
| Security | PARTIAL | 85 | semantic raw-card scan PASS (302 files, 3 documented allow-list evidence identifiers); secret/PII scan 829 files 0 findings; logging hygiene 0 NEVER_LOG, 1 SENSITIVE unmasked (`recipient_ref`, LOG-1); route inventory 213/213 classified; HTTP smoke 11/11 + GAP-HTTP-1 (`/readiness` no-store); legal gate PASS with the production KYC step as OWNER_DECISION; 6 documented runtime gaps (OTP salt default, legacy tracking flag, debug surfaces, demo admin key, demo-mode bypass, service-role presence) refused by the release policy but accepted by the runtime | owner decisions on KYC step; engineering tickets for the runtime gaps (not on this branch) |
| Database | COMPLETE | 90 | migration preflight 10/10 (fresh, upgrade from master, partial ledger, CRLF ledger, tampered checksum, dirty ledger, failing migration atomic x2, schema drift 0); backup/restore rehearsal 9/9 (75 tables, 986 columns, 73 FKs, 252 indexes, ledger identical, Hebrew intact, dump free of secret shapes); doctor + repair with 6 tests; LF-canonical checksums fix the Windows/Linux split that corrupted the staging ledger metadata before | run `migrations:doctor --allow-hosted` (read-only) against staging before the next deploy (not executed here) |
| Financial safety | BLOCKED | 60 | money/tax canon gate: executed fee vectors (100/0, 118/18, refund sign, VAT clamp) + AST invariants, 9 mutants killed; no-real-money proof 16/16; startup matrix proves the runtime guard accepts only a fully live config and the release policy refuses it on `REAL_MONEY_BLOCKED`; governance file with 4 uncleared reasons | **F-13 unresolved; financial branch not integrated; Grow live verification not performed; owner activation not approved** |
| UX | NOT TESTED | 0 | out of scope for this branch by isolation rule (Codex UX branch in flight); no UX file changed; browser proofs not run | rebase after UX integration; hosted browser proofs per `docs/RC_STAGING_SMOKE.md` |
| Infrastructure | PARTIAL | 70 | runtime environment policy for 5 targets + 23-case startup matrix; reference configs evaluated (`render.yaml` staging: `OTP_HASH_SALT` missing); Docker compose lab defined and wired into CI; supply chain: 4 production high advisories = owner upgrade decision; **Docker lab SKIPPED_ENVIRONMENT locally; hosted staging NOT CHECKED** | Render: add `OTP_HASH_SALT` (hosted action); merge to get the CI Docker lab result; dependency upgrade change after integration |
| Observability | PARTIAL | 70 | health contract 6/6 incl. negative control (DB dropped -> `/health` 200, `/readiness` 503); worker heartbeat proven; gaps HC-1..HC-4 documented; logging classification doc + gate | runtime changes for HC-1/HC-3 and LOG-1 (engineering, later) |
| Operations | COMPLETE | 90 | runbooks: deployment (three separate actions), rollback, payment incident, security incident, database incident, parallel-agent model; process guard + flake classifier + isolated-DB helper with tests; owner one-command check | owner acknowledgement of the runbooks; first rehearsal of the rollback runbook on staging (hosted, later) |
| Real-money activation | BLOCKED FOR REAL MONEY | 0 | `config/real-money-release-policy.json` BLOCKED; `REAL_MONEY: BLOCKED` printed by preflight, proof, env gate, owner check; F-13 open | see `docs/REAL_MONEY_RELEASE_GOVERNANCE.md`: four reasons, each needs dated evidence |

## Overall

- READY FOR CODE DEPLOY (release tooling on top of master `82c91d6`): **preflight standard profile PASS with documented warnings; Docker lab unproven locally** - see the latest `.release-artifacts/release-preflight.md`.
- READY FOR REAL MONEY: **NO** (F-13 BLOCKED FOR REAL MONEY).
- This branch is NOT to be merged before the financial branch and the UX branch are integrated; then rebase, run `release:preflight` + the Docker CI job, then merge the release tooling (see `PROJECT_STATUS.md`).

## Open items by owner

| Owner | Item |
|---|---|
| Owner | KYC approval step in production intended? (`legal_compliance_gate` OWNER_DECISION) |
| Owner (hosted) | `OTP_HASH_SALT` on both Render services; Render Starter plan; Supabase Site URL |
| Owner + reviewer | F-13 resolution and financial branch integration |
| Provider (Grow) | sandbox `userId`/`pageCode`; live verification |
| Engineering | runtime gaps (7 listed in `docs/RUNTIME_ENVIRONMENT_POLICY.md`), HC-1/HC-3, LOG-1, GAP-HTTP-1..3, dependency upgrades (`docs/SUPPLY_CHAIN_STATUS.md`), optional removal of `vitest` |
| Engineering (found while grounding the runbooks, `src/` untouched here) | `src/admin_mission_control.ts` outbox/correlation trace queries reference non-existent columns (`outbox_events.event_id`, `payment_attempts.provider_reference`) and return empty through `safeQuery`; `service_role` retains EXECUTE on `siton_inventory_rpc`; tracking-token revoke helper has no route caller; no bulk session-revocation route; `ADMIN_API_KEY` rotation does not invalidate existing admin sessions; `pause_charging_emergency` is enforced only at `charging/start`, not worker-side; no DLQ redrive for money events; no repair path for a `running` ledger row (crash mid-migration) |
| CI | first green run of `release-readiness.yml` incl. `docker-release-lab` |
