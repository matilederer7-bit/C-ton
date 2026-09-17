# Source `.docx` documents in `docs/` — HISTORICAL SOURCE, NOT CURRENT POLICY

`docs/` holds loose copies of the owner's original Word documents alongside the
Markdown canon. They are kept **verbatim** as provenance and are never edited.

They are **not** the current product policy. Per `AGENTS.md` ("Source of
truth"), they are rank 5 — *older foundation, delivery, and historical
documents*. Current canonical decisions and amendments override them.

`docs/foundation-canonical-2026-04-18/` carries its own `README.md` marking the
same rule obsolete for the four files in that directory. This file does the
same job for the copies that sit directly in `docs/`, which that README does
not cover — including `חוקה לסיטון.docx`, which is not part of the foundation
pack at all.

## The seven-day deal-deadline maximum — CORRECTED IN THE DOCUMENTS THEMSELVES

These documents used to state a **maximum deal deadline of seven days**. That
text is **gone**: on 2026-09-17 the `.docx` files were edited in place so the
rule no longer appears in any of them. This file is now a record of what was
changed, not a warning about text that is still there.

| Document | Was (verbatim) | Now reads |
|---|---|---|
| `docs/חוקה וצקליסט לסיטון.docx` §3.3 "כללים עסקיים מחייבים" | "דדליין מקסימום 7 ימים" | "דדליין מינימום 2 שעות, ללא מגבלת מקסימום מוצרית קבועה" |
| `docs/חוקה לסיטון.docx` §3.3 "כללים עסקיים מחייבים" | "דדליין מקסימום 7 ימים" | "דדליין מינימום 2 שעות, ללא מגבלת מקסימום מוצרית קבועה" |
| `docs/סיטון אפיון מוצר מלא.docx` | "דדליין לעיסקה לא יעלה על 7 ימים ממועד הפרסום." | "דדליין לעיסקה: מינימום 2 שעות ממועד הפרסום. אין מגבלת מקסימום מוצרית קבועה; קיימת תקרת מערכת טכנית בלבד למניעת שגיאות קלט." |
| `docs/סיטון אפיון מוצר מלא.docx` שלב 1 | "דדליין עד 7 ימים" | "דדליין (מינימום 2 שעות, ללא מקסימום קבוע)" |
| `docs/סיטון אפיון מוצר מלא.docx` שדות ניתנים לעריכה | "(מקסימום עד שבעה ימים קלנדריים, מינימום החל מ 2 שעות)" | "(מינימום החל מ 2 שעות, ללא מגבלת מקסימום קבועה)" |
| `docs/UX סיטון.docx` שלב 1 – פרטי בסיס | "דדליין עד 7 ימים" | "דדליין (מינימום 2 שעות, ללא מקסימום קבוע)" |

The same three files exist as historical copies under
`docs/foundation-canonical-2026-04-18/` and were corrected identically, so no
copy of the rule survives anywhere in the repository.

Only `word/document.xml` was rewritten inside each archive. Styles, numbering,
fonts, relationships and content types are byte-identical, and the replacement
text inherits the formatting of the run it replaced.

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

Verified on hosted staging 2026-09-17: 30-, 60- and 90-day deadlines are all
accepted and persisted to the exact instant, and a 60-day deal ran live.

Regression cover: `tests/long_horizon_deadline_policy_validation.ts` and
`tests/long_horizon_staging_smoke_validation.ts` fail if a seven-day cap is
reintroduced in the backend policy, the web mirror, the seller page, the
Hebrew error map or the shipped frontend bundle.

## Unrelated seven-day values — NOT this rule

Do not "fix" these; they are legitimate and unrelated to deal duration. Three
of them appear in `docs/UX סיטון.docx` itself:

- **Admin alert thresholds** on authorization age (`Authorization > 7 ימים`) —
  two occurrences in the UX document, both legitimate.
- **Freeze Payouts** approval validity (`תוקף 7 ימים`) — one occurrence in the
  UX document, legitimate.
- Grow's documented **J5 authorization-hold validity** (≈7 days) — a provider
  fact recorded on the authorization binding, never a bound on a Siton deal.
- **Support SLA** for Low priority (7 days) and operational freeze warnings.
- **Analytics windows** (`7d` ranges in seller, distribution and admin views).
- A product's **delivery estimate** (for example 3–7 business days) — that is
  fulfilment time after a deal completes, not the deal's duration.
