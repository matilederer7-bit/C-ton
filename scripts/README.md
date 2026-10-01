# Scripts Surface

`scripts/` holds the gates, release tooling, migration runners, proofs and operational
tools that `package.json`, the CI workflows, the release preflight and the live runbooks
call. The classification of every file (CORE / SUPPORT / ARCHIVE) is in
`docs/LEAN_REFACTOR_MAP_2026-09-30.md` §3.5; re-derive a file's callers with
`rg -n -F "<basename>" --glob '!scripts/<name>*' .` before touching it.

Canonical / operational (prescribed by live runbooks, no automated caller):
- `run_pg_query.cjs` — the incident and operational runbooks' query tool
- `r3_hosted_proof.cjs` — hosted proof named by the deployment, credential-compromise,
  disaster-recovery and security-incident runbooks
- `restart_server_clean.ps1`, `restart_server_tsnode_clean.ps1`, `register-ts-node.mjs` —
  `docs/OPERATIONAL_RUNBOOK.md` restart procedure
- `r7r8_browser_proof.cjs`, `launch_polish_browser_proof.cjs`, `buyer_polish_browser_proof.cjs`,
  `pickup_fulfillment_browser_proof.cjs`, `p0_browser_proof.cjs` — `docs/DEPLOYMENT_RUNBOOK.md` §10
- `pilot_readiness_proof.cjs` — `docs/PILOT_LAUNCH_RUNBOOK.md`
- `receipt_content_browser_proof.cjs` — `docs/SITE_CMS.md`, `docs/RECEIPT_TRUST_CONTENT.md`

Utility / reference:
- `inspect_db.cjs`
- `drop_create_db.cjs`
- `init_db.sql`:
  legacy bootstrap reference only, not the canonical live schema source of truth

Retired (no automated caller; moved by Lean Refactor D2, still runnable from the
repository root): see `scripts/retired/README.md`.

Historical one-off scripts from the 2026-03-30 hygiene pass were removed from the
repository (`archive/` is git-ignored); `scripts/retired/` is the only tracked archive.
