## Seller Identity Minimum Hardening

### Goal

Strengthen seller identity semantics without introducing full authentication.

### What changed

- Added explicit seller context routes:
  - `GET /api/seller/context`
  - `POST /api/seller/context`
- Normalized seller identity resolution from:
  - persisted context
  - request headers
  - explicit fallback marked as default context
- Bound seller workspace and seller management payloads to the active seller context.
- Enforced seller ownership checks on:
  - seller deal detail
  - publish flow
  - seller-side delivery update flow
- Ensured new deals are created under the active seller identity, not just UI framing.
- Added frontend persistence for the active seller context via local storage and request headers.
- Added visible seller identity framing in seller surfaces so it is always clear who the active seller is.

### Minimum identity model

- The system now works with a minimum viable seller identity model:
  - one active seller context
  - explicit `seller_id`
  - optional display name
  - default fallback only when no explicit context was selected
  - fallback is marked as default context rather than pretending to be an explicit seller session

### Why this is enough for now

- It keeps the seller-first story operationally credible.
- It avoids a misleading anonymous seller workspace.
- It does not open a full auth project.
- It preserves existing deal ownership and keeps workspace visibility scoped to the active seller.

### What remains intentionally out of scope

- full login and password flows
- permission matrix
- KYC and payout verification flows
- full seller account lifecycle
