# Foundation pack 2026-04-18 — HISTORICAL SOURCE, NOT CURRENT POLICY

The four `.docx` files in this directory are the owner's **original foundation
pack**: the constitution/checklist, the binding system spec, the full product
spec and the UX document. They are kept **verbatim** as provenance and are
never edited.

Loose copies of several of these documents also sit directly in `docs/`, plus
`חוקה לסיטון.docx`, which is not part of this pack. Those are marked by
`docs/SOURCE_DOCX_OBSOLETE_RULES.md`, which carries the same obsolescence
notice for them.

They are **not** the current product policy. Per `AGENTS.md` ("Source of
truth"), these are rank 5 — *older foundation, delivery, and historical
documents*. Current canonical decisions and amendments override them.

## OBSOLETE rule in these documents: the seven-day deal-deadline maximum

These source documents state a **maximum deal deadline of seven days**. That
rule is **OBSOLETE / HISTORICAL and must not be implemented, reintroduced or
cited as active policy.** Specifically:

| Document | Obsolete text (verbatim) |
|---|---|
| `חוקה וצקליסט לסיטון.docx` §3.3 "כללים עסקיים מחייבים" | "דדליין מקסימום 7 ימים" |
| `סיטון אפיון מוצר מלא עדכני.docx` | "דדליין לעיסקה לא יעלה על 7 ימים ממועד הפרסום" · "דדליין עד 7 ימים" · "מקסימום עד שבעה ימים קלנדריים, מינימום החל מ‑2 שעות" |
| `UX סיטון.docx` שלב 4 – תנאים | "דדליין עד 7 ימים" |

**Current binding rule (LONG_HORIZON_DEALS, owner decision 2026-09-16):**
there is **no fixed maximum deal duration**. A deal's lifetime is a product
quantity and is not bounded by the lifetime of a payment-provider card
authorization. What remains is a **2-hour minimum** (still a product rule), a
**technical sanity ceiling** of 20 years that protects against typo'd dates,
and an advisory (never blocking) notice above one year.

Authoritative current sources, in order:

1. `docs/CANONICAL_PRODUCT_POLICY_AMENDMENT_2026-09-16.md`
2. `docs/LONG_HORIZON_AUTHORIZATION_ARCHITECTURE.md`
3. `src/deadline_policy.ts` — the single server-side source of truth
   (`web/src/deadlinePolicy.ts` mirrors it; a test pins both together)
4. `src/migrations/071_long_horizon_authorization_renewal.sql`

Regression cover: `tests/long_horizon_deadline_policy_validation.ts` and
`tests/long_horizon_staging_smoke_validation.ts` fail if a seven-day cap is
reintroduced in the backend policy, the web mirror, the seller page, the
Hebrew error map or the shipped frontend bundle.

## What else in these documents is superseded

The seven-day cap is the rule most likely to be misread as still active, which
is why it is called out above. Other deltas between this pack and current
policy are recorded in `docs/CANONICAL_DRIFT_AUDIT_2026-04-18.md`,
`docs/SPEC_DRIFT_MAP_2026-04-19.md` (itself `[CLOSED — HISTORICAL]`) and the
canonical amendments in `docs/`. Read those before treating anything in this
directory as a requirement.

## Unrelated seven-day values — NOT this rule

Do not "fix" these; they are legitimate and unrelated to deal duration:

- Grow's documented **J5 authorization-hold validity** (≈7 days) — a provider
  fact recorded on the authorization binding, never a bound on a Siton deal.
- **Admin alert thresholds** on authorization age (`Authorization > 7 ימים`).
- **Freeze Payouts** approval validity (7 days).
- **Support SLA** for Low priority (7 days) and operational freeze warnings.
- **Analytics windows** (`7d` ranges in seller, distribution and admin views).
