# Real Payment And Reconciliation Issues

> **SUPERSEDED — HISTORICAL (2026-09-30).** This document is tiered ARCHIVE in `docs/DOCUMENTATION_MAP.md`: history, never authority. Its decisions, "canonical" lists and contracts describe an earlier state of the project. Product rules are in `docs/SITON_PRODUCT_CONSTITUTION_2026-09-30.md`, the runtime in `docs/CURRENT_ARCHITECTURE_2026-09-30.md`, current state in `PROJECT_STATUS.md`.

## Open / Non-Blocking

- The active provider remains `mock-backed` by default. The new `provider-ready` mode and config surface are in place, but no live external provider is connected in this workspace.
- Webhook reconciliation now mutates the domain for the minimal charge/recovery event set, but a full provider-specific event catalog is still not implemented.
- Notification delivery remains `log-only`, by choice for this pass.
- No `git remote` is configured in this workspace, so no push was performed.
