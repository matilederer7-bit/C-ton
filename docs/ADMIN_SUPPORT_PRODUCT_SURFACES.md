# Admin + Support Product Surfaces

## What was aligned

- The admin dashboard now presents an explicit urgency hierarchy:
  - critical
  - needs attention
  - steady operational activity
- The admin deal surface now shows a canonical deal-ops summary instead of relying on raw tables only.
- A dedicated participant-ops read surface was added on top of the existing canonical endpoint.
- Support tickets now use operator-facing Hebrew wording instead of internal or English status copy.

## UX baseline for this slice

- Operators should understand within seconds:
  - what is burning
  - what is stable
  - where to drill down
- Read surfaces must stay tied to canonical truth:
  - notifications
  - invoice documents
  - outbox
  - participant state
  - deal state
- Empty, loading, and error states must stay explicit and non-misleading.

## Operator understanding model

- `admin dashboard`:
  fast triage and drill-down
- `deal profile`:
  full operational picture of one deal
- `participant profile`:
  support-grade truth for one participant across notifications, documents, and outbox
- `user profile`:
  join history and navigation into participant/deal investigation

## Still open

- Deeper admin action flows remain outside this track.
- Payout/accounting management remains outside this track.
- External rails are still not activated and must stay framed as such.
