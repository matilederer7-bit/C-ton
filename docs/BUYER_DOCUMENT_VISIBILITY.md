# Buyer Document Visibility

## What was aligned

- Buyer tracking now reads canonical document visibility from `siton.invoice_documents`.
- The buyer surface shows a real document identifier only when an actual issued row exists.
- When no issued row exists yet, the buyer now sees an explicit waiting message instead of a pseudo receipt state.
- Failed and cancelled outcomes now explain when no document is expected at all.

## UX baseline for this slice

- Tracking remains the buyer's source of truth.
- Document visibility is read-only.
- No fake receipt ids.
- No "sent" wording without evidence from a real document row.

## Covered states

- `issued`
- `pending_issue`
- `issue_failed`
- `not_expected`
- `not_available_yet`

## Still open

- Real document download or external invoice-provider delivery remains outside this track.
- Any future buyer document email/SMS confirmation must still rely on canonical notification truth before being surfaced.
