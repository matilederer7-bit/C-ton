# Canonical Foundation Source Of Truth

Date: `2026-04-18`

## Binding Decision

The foundation documents under [docs/foundation-canonical-2026-04-18](/c:/Users/Lenovo/Documents/C-ton/docs/foundation-canonical-2026-04-18) are now the binding source of truth for Siton.

These files supersede older repository foundation documents anywhere there is contradiction, ambiguity, duplication, or drift:

1. [סיטון אפיון מוצר מלא עדכני.docx](/c:/Users/Lenovo/Documents/C-ton/docs/foundation-canonical-2026-04-18/סיטון אפיון מוצר מלא עדכני.docx)
2. [UX סיטון.docx](/c:/Users/Lenovo/Documents/C-ton/docs/foundation-canonical-2026-04-18/UX סיטון.docx)
3. [סיטון - מפרט מערכת מחייב.docx](/c:/Users/Lenovo/Documents/C-ton/docs/foundation-canonical-2026-04-18/סיטון - מפרט מערכת מחייב.docx)
4. [חוקה וצקליסט לסיטון.docx](/c:/Users/Lenovo/Documents/C-ton/docs/foundation-canonical-2026-04-18/חוקה וצקליסט לסיטון.docx)

## How To Read Conflicts

Use the new canonical set by domain:

- Product scope, business model, user roles, and what exists in the product: the updated product spec and UX are authoritative.
- System invariants, state discipline, idempotency, atomicity, and backend rules: the updated system spec and constitution/checklist are authoritative.
- Older `.docx` and `.md` files in `docs/` may remain useful as historical reference, but they no longer override this canonical set.

If a legacy repository document disagrees with the canonical set, the canonical set wins.

## Material Product Shift Locked In

The updated foundation pack changes the distributor layer in a substantive way:

- Distributors are now a measured distribution channel, not an in-system commission and payout engine.
- The platform no longer treats distributor compensation as a core in-system money rail.
- Commercial settlement between seller and distributor is outside the system unless a future canonical foundation pack explicitly changes that.

This is a real product-direction change, not wording polish.

## Immediate Repository Interpretation

Until the next implementation pass finishes:

- do not treat old affiliate/commission flows as canonical product scope
- do not reopen deprecated commission behavior just because older repo docs mention it
- do treat the updated distributor model as the guiding product truth for future code and UX work

## Open Follow-Up Items

The new foundation pack also exposes follow-up work that is not implemented in this step:

- repository code and DB drift must be re-mapped against the new canonical pack
- repeated purchases by the same buyer in the same deal are explicitly allowed in the updated product spec and must be reconciled against any remaining schema/runtime uniqueness assumptions
- legacy references to `commission_rate` and old affiliate payout assumptions must be cleaned out of secondary docs and then from code/schema where relevant
