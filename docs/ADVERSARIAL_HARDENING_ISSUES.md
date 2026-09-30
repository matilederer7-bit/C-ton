# Adversarial Hardening Issues

> **SUPERSEDED — HISTORICAL (2026-09-30).** This document is tiered ARCHIVE in `docs/DOCUMENTATION_MAP.md`: history, never authority. Its decisions, "canonical" lists and contracts describe an earlier state of the project. Product rules are in `docs/SITON_PRODUCT_CONSTITUTION_2026-09-30.md`, the runtime in `docs/CURRENT_ARCHITECTURE_2026-09-30.md`, current state in `PROJECT_STATUS.md`.

## Non-blocking

1. Payment execution remains mock-backed.
Reason: the pass intentionally attacked the internal system without activating a live provider.

2. Notifications remain log-only.
Reason: they do not currently weaken domain integrity or system coherence under internal operation.

3. Browser-level race automation is still approximated through route and contract abuse rather than a full browser harness.
Reason: current validation focuses on internal hardening in the repo/runtime, not on external browser tooling.

4. Full provider-specific webhook catalog is still not active.
Reason: only the internally supported event set can be proven until a real provider is chosen.

5. No push was performed.
Reason: the repository still has no configured git remote.
