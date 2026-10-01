# Internal Maximal Closure Issues

> **SUPERSEDED — HISTORICAL (2026-09-30).** This document is tiered ARCHIVE in `docs/DOCUMENTATION_MAP.md`: history, never authority. Its decisions, "canonical" lists and contracts describe an earlier state of the project. Product rules are in `docs/SITON_PRODUCT_CONSTITUTION_2026-09-30.md`, the runtime in `docs/CURRENT_ARCHITECTURE_2026-09-30.md`, current state in `PROJECT_STATUS.md`.

## Non-blocking

1. Payment execution remains mock-backed by design in this pass.
Reason: the current objective is maximal internal closure, not outbound live-provider activation.

2. Notifications remain log-only.
Reason: they are not the first internal blocker once payment abstraction and webhook reconciliation are structurally in place.

3. Provider-ready mode exists without a live provider attached.
Reason: this is an intentional boundary state that preserves architecture readiness without introducing external dependency risk.

4. Reconciliation coverage is intentionally limited to the minimal internally-supported event set.
Reason: expanding to a full provider-specific event matrix only makes sense once the first real provider is chosen.

5. No push was performed.
Reason: no git remote is configured in the repository.
