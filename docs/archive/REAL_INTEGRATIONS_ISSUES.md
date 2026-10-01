# Real Integrations Issues

> **SUPERSEDED — HISTORICAL (2026-09-30).** This document is tiered ARCHIVE in `docs/DOCUMENTATION_MAP.md`: history, never authority. Its decisions, "canonical" lists and contracts describe an earlier state of the project. Product rules are in `docs/SITON_PRODUCT_CONSTITUTION_2026-09-30.md`, the runtime in `docs/CURRENT_ARCHITECTURE_2026-09-30.md`, current state in `PROJECT_STATUS.md`.

## Open / Non-Blocking

- Live payment provider is still mock-backed. This pass focuses on provider abstraction, failure mapping, and replacement readiness rather than connecting a real acquirer inside the current sandboxed environment.
- Webhook ingestion currently stores and classifies external events, but it does not yet mutate payment state from real provider callbacks. That remains the next integration step, not a blocker for this closure pass.
- Browser-level external-provider validation is still constrained by the local sandbox; validation is done through app/runtime injection and contract checks.
- No `git remote` is configured in this workspace, so no push was performed in this pass.
