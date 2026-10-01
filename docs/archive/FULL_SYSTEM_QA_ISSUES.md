# Full System QA Issues

> **SUPERSEDED — HISTORICAL (2026-09-30).** This document is tiered ARCHIVE in `docs/DOCUMENTATION_MAP.md`: history, never authority. Its decisions, "canonical" lists and contracts describe an earlier state of the project. Product rules are in `docs/SITON_PRODUCT_CONSTITUTION_2026-09-30.md`, the runtime in `docs/CURRENT_ARCHITECTURE_2026-09-30.md`, current state in `PROJECT_STATUS.md`.

## Non-blocking

1. Payment provider execution remains mock-backed.
Reason: this QA pass intentionally verifies whole-system coherence without activating a live external provider.

2. Notifications remain log-only.
Reason: they do not block full-system coherence under the current internal operating model.

3. Full browser automation is still not present.
Reason: the current closest practical substitute is strong route-level and contract-level validation through `app.inject`.

4. External-provider webhook catalog is still limited to the currently supported internal event set.
Reason: expanding the full matrix should happen only after the first real provider is chosen.

5. No push was performed.
Reason: the repository currently has no configured git remote.
