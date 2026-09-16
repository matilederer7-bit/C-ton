# Canonical Foundation Source Of Truth

Date: `2026-04-18`

V1.1 product-scope amendment: `2026-08-23`.

Latest binding product-policy amendment: `2026-09-16`.

## Binding Decision

The foundation documents under `docs/foundation-canonical-2026-04-18` remain the historical foundation pack for Siton.

The owner later made binding product amendments. Agents must read newer amendments before relying on older binary source material.

Current precedence for product-policy conflicts is:

1. owner's explicit current decision
2. `docs/CANONICAL_PRODUCT_POLICY_AMENDMENT_2026-09-16.md`
3. current later canonical repository decisions
4. the 2026-04-18 foundation pack and the 2026-08-23 Mall amendment
5. older repository documents and historical implementation

## 2026-08-23 Mall Amendment

Siton is no longer direct-link-only. It supports direct deal links plus the public Siton Mall described in `SITON_V1_1_MALL_PRODUCT_DIRECTION.md`.

The binary foundation documents remain historical source artifacts; their no-catalog/no-browse wording is not current product canon. Their state, money, idempotency, atomicity, security, and 90% rules remain binding unless a later explicit amendment changes a specific rule.

## 2026-09-16 Product Policy Amendment

`docs/CANONICAL_PRODUCT_POLICY_AMENDMENT_2026-09-16.md` is binding for the following areas and supersedes conflicting older wording:

- every publishable deal must have a finite mandatory `max_units`;
- Completion Window is fixed at exactly 24 hours and exists only for failed-charge recovery;
- Siton fee is fixed at 8% of the full collected purchase amount including shipping/delivery, excluding the customer VAT component;
- there is no per-deal commission-rate override;
- there is no distributor/affiliate user role or distributor product module;
- ordinary sharing may remain as a normal deal capability without creating a distributor entity or economic rail;
- the previously decided removal of the fixed seven-day maximum deal duration remains binding;
- current legal text remains unchanged for now.

Any older DOCX, migration comment, UX note, code path, schema contract, or test that contradicts these points is historical drift and must not be used to restore deprecated behavior.

## Foundation Pack

The historical foundation pack contains:

1. `סיטון אפיון מוצר מלא עדכני.docx`
2. `UX סיטון.docx`
3. `סיטון - מפרט מערכת מחייב.docx`
4. `חוקה וצקליסט לסיטון.docx`

Use the pack for domains not superseded by later amendments.

## How To Read Conflicts

- Product scope and public discovery: the V1.1 Mall decision is authoritative where it conflicts with the April pack.
- Product rules listed in the 2026-09-16 amendment: the September amendment is authoritative.
- System invariants, state discipline, idempotency, atomicity, audit, backend safety, and the 90% rule remain authoritative unless a later explicit decision changes them.
- Historical migrations are immutable records of prior schema evolution. Never edit an already-applied migration merely to make its old wording match current product policy. Use forward migrations.
- Current implementation is evidence of what exists, not authority to override a newer product decision.

## Implementation State At 2026-09-16

Already aligned:

- staging `siton.deals.max_units` is `NOT NULL` and constrained to be at least `min_units`;
- legacy per-deal `commission_rate` is absent from staging `siton.deals`;
- the money implementation uses the fixed 8% system rate and includes delivery in gross before excluding the customer VAT component from the fee base.

Known cleanup still required:

- hard-lock Completion Window to 24 hours in runtime code rather than accepting an environment override;
- remove remaining distributor/affiliate identity, session, route, UI, schema-contract, environment, and test surfaces;
- preserve generic sharing and role-neutral viral analytics without a distributor product role;
- coordinate with the separate active implementation task removing the obsolete seven-day deal-duration cap;
- do not touch the parallel CMS/content-management implementation while doing this cleanup.

See `docs/CANONICAL_PRODUCT_POLICY_CODE_CLEANUP_2026-09-16.md` for the implementation task.
