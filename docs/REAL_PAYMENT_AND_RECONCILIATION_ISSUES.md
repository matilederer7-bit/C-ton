# Real Payment And Reconciliation Issues

## Open / Non-Blocking

- The active provider remains `mock-backed` by default. The new `provider-ready` mode and config surface are in place, but no live external provider is connected in this workspace.
- Webhook reconciliation now mutates the domain for the minimal charge/recovery event set, but a full provider-specific event catalog is still not implemented.
- Notification delivery remains `log-only`, by choice for this pass.
- No `git remote` is configured in this workspace, so no push was performed.
