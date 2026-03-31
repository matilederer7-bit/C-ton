# Real Integrations Issues

## Open / Non-Blocking

- Live payment provider is still mock-backed. This pass focuses on provider abstraction, failure mapping, and replacement readiness rather than connecting a real acquirer inside the current sandboxed environment.
- Webhook ingestion currently stores and classifies external events, but it does not yet mutate payment state from real provider callbacks. That remains the next integration step, not a blocker for this closure pass.
- Browser-level external-provider validation is still constrained by the local sandbox; validation is done through app/runtime injection and contract checks.
- No `git remote` is configured in this workspace, so no push was performed in this pass.
