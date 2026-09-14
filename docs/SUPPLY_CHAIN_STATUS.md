# Supply chain status

Command: `npm run check:supply-chain` (`scripts/supply_chain_check.cjs`). Snapshot 2026-09-14 on this branch. Nothing was upgraded here: dependency upgrades are runtime changes and belong to a dedicated, reviewed change after the financial branch lands.

## Facts

| Check | Result |
|---|---|
| lockfile (root) | lockfileVersion 3, 505 packages, 0 non-registry, 1 local link (`@siton/secure-storage` -> `mobile-plugins/siton-secure-storage`, expected) |
| lockfile (web) | lockfileVersion 3, 117 packages, 0 non-registry |
| installed tree | `npm ls`: no missing/invalid/extraneous top-level dependency |
| `npm audit` | 20 advisories: critical 2, high 11, moderate 6, low 1 -> production critical/high 4, production other 3, dev-only 13 |
| duplicate majors (production) | `archiver-utils` 2/3, `minimatch` 3/5, `brace-expansion` 1/2, `readable-stream` 2/3, `process-warning` 4/5 |
| Node engines | package.json `>=22`, Dockerfile `node:22`, CI `22`; local machine 24 (local results are not identical to CI/hosted) |

## Advisories requiring an owner/engineering upgrade decision

| Package | Severity | Path | Fix | Note |
|---|---|---|---|---|
| `fastify` | moderate (direct, production) | runtime | yes (minor) | schema validation bypass via root primitive coercion; `X-Forwarded-*` spoofing under trustProxy hop-count. The app does not use `trustProxy` hop counts; validation is handler-level. Upgrade in a dedicated change with the full suite. |
| `find-my-way` | high (transitive via fastify, production) | runtime | yes | DDoS with HTTP/2; the app serves HTTP/1.1 behind Render. Comes with the fastify upgrade. |
| `fast-uri` | high (transitive via fastify/ajv, production) | runtime | yes | host confusion / percent-encoded traversal in URI parsing. Comes with the fastify upgrade. |
| `brace-expansion` | high (transitive, production) | runtime tree via exceljs/archiver | yes | regex DoS in expansion; not reachable from request handling. |
| `tmp` | high (transitive, production tree) | build/native tooling path | yes | path traversal in temp prefix; not used at request time. |
| `exceljs` | moderate (direct, production) | seller Excel export | yes, MAJOR (`exceljs@3.4.0` downgrade path reported by npm; verify) | via old `uuid`; upgrade needs export validation (`tests/seller_deal_excel_export_validation.ts`). |
| `uuid` (old) | moderate (transitive) | via exceljs / xcode | no | buffer bounds in v3/v5/v6; not used with buffers here. |
| `tar` | critical (dev: `@capacitor/cli`) | mobile tooling | yes | dev-only; upgrade capacitor CLI/assets together. |
| `vitest` / `@vitest/mocker` | critical (dev) | unused test framework (the suite uses `node --test` / compiled TS) | yes | consider removing `vitest` from devDependencies. |
| `vite`, `postcss`, `esbuild` (web) | high/low (dev) | web build | yes | upgrade with the web toolchain. |
| `sharp` (via `@capacitor/assets`) | high (dev) | icon generation | no | dev-only. |
| `xmldom`, `xcode`, `@trapezedev/project` (via capacitor) | high/moderate (dev) | mobile tooling | partial | dev-only. |

## Policy

- Production critical/high advisories are reported as WARNING with the label "OWNER UPGRADE DECISION"; they do not block a release by themselves because the exploitability in this deployment is assessed above, and an unreviewed mass upgrade is a larger risk to the financial branch integration.
- Non-registry dependencies (git/http) and unexpected `file:` links FAIL.
- A missing lockfile FAILS.
- The check runs in `npm run release:preflight` (needs network for `npm audit`; offline it reports `SKIPPED_ENVIRONMENT` for the audit step only).

## Next step

After financial + UX integration: one dedicated change upgrading `fastify` (and its transitive tree), reviewing `exceljs`, removing `vitest` if unused, and refreshing the capacitor toolchain; run `npm run release:preflight:full` on the result.
