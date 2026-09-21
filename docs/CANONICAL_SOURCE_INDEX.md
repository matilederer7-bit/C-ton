# Siton canonical source index

Status: canonical. Updated 2026-09-21.

This index tells a new engineer which source governs each domain. `AGENTS.md`
defines the precedence rule. When an older document conflicts with this index,
the older document remains provenance and must not be used to restore removed
behaviour.

| Domain | Canonical source | Supporting implementation or proof |
|---|---|---|
| Product invariants | `AGENTS.md`; `docs/CANONICAL_PRODUCT_POLICY_AMENDMENT_2026-09-16.md` | product-policy regression tests |
| Deal duration | `docs/LONG_HORIZON_AUTHORIZATION_ARCHITECTURE.md`; `src/deadline_policy.ts` | `web/src/deadlinePolicy.ts`; long-horizon tests |
| Completion Window | `AGENTS.md`; current state-machine contract | fixed 24 hours; recovery only for `ChargeFailedCompletion` |
| Database schema | ordered files in `src/migrations/`; `scripts/migration_manifest.cjs` | migration preflight and runtime-role tests |
| State machines and actions | current transition implementation plus DB triggers and checks | state-machine, atomicity, audit and outbox tests |
| Architecture and enforcement | `AGENTS.md`; `AI_WORKFLOW.md`; executable gates | `scripts/architecture_truth_gate.cjs`; enforcement scans |
| Platform fee | `docs/PLATFORM_FEE_PAYMENTS_8_PERCENT.md`; current owner rule in `AGENTS.md` | 8% of all customer money actually collected, including delivery and other collected purchase components, excluding customer VAT |
| Distribution links | `AGENTS.md`; `docs/SELLER_DISTRIBUTION_HUB_2026-09-17.md` only where consistent with it | attribution and aggregate scoped viewing only; no distributor economics or commission |
| Refunds | `docs/REFUND_POLICY.md` | system-mandated failed-deal path only; no manual commercial refund |
| Payment provider | `docs/PAYMENT_RED_TEAM_2026-09-18.md`; `docs/GROW_PAYMENTS_INTEGRATION_READINESS.md` | payment and production-guard tests |
| Real-money activation | `config/real-money-release-policy.json`; `docs/REAL_MONEY_RELEASE_GOVERNANCE.md` | `npm run proof:no-real-money` |
| UX | current React implementation and current CMS contracts, constrained by active product policy | browser, accessibility, i18n and product-surface tests |
| Release verification | `docs/CI_TEST_STRATEGY.md` | `npm run verify:full`; `npm run verify:release` |
| Current operational state | `PROJECT_STATUS.md` | Git and hosted evidence named there |

## Historical Word sources

The original Word specifications are historical inputs, not current policy.
This includes loose `.docx` files under `docs/`, the foundation pack, and the
six owner-supplied review copies named below:

- `חוקה לדאטה בייס.docx`
- `מנגנון אכיפה.docx`
- `DB.docx`
- `חוקה וצקליסט לסיטון.docx`
- `UX סיטון.docx`
- `סיטון אפיון מוצר מלא עדכני.docx`

They contain superseded structures and rules, including a Python repository
skeleton, optional or null `max_units`, configurable Completion Window fields,
a seven-day deal cap, a distributor role, and older state/action lists. They
are retained as provenance. They do not override current migrations, current
contracts, the policy amendment, or owner decisions. See
`docs/SOURCE_DOCX_OBSOLETE_RULES.md` for the repository-copy preservation rule.

## Locked interpretation

- A deal has no fixed seven-day maximum. The 20-year ceiling is input sanity,
  not product policy.
- Completion Window is fixed at 24 hours and cannot be configured per deal.
- Siton's fee is 8% on the full customer amount actually collected, including
  delivery and other collected purchase components, excluding customer VAT.
- Distribution is attribution only. No distributor commission, balance,
  payout, or financial ledger is permitted.
- `REAL_MONEY_ALLOWED` remains false and Grow Live remains disabled until the
  separate release-governance blockers are cleared with evidence.
- An `UNKNOWN` external-money result never progresses as success and is never
  blindly retried.
