# Agent efficiency implementation note

This branch intentionally contains only workflow-efficiency changes.

Included:

- standing agent rules and condensed workflow
- one canonical repository verification entry point
- isolated Codex / Claude Code worktree helper
- short task protocol and builder/reviewer handoff
- compact current `PROJECT_STATUS.md` with exact historical archive preservation
- focused repository contract tests for the verification/worktree helpers
- one-screen owner quickstart

Explicitly excluded from this branch:

- Grow changes
- real-money activation
- payment/business logic changes
- staging smoke automation
- new CI governance/rulesets
- production hardening unrelated to agent workflow efficiency

The only local-machine action that cannot be performed through GitHub is instantiating the sibling worktree directories themselves. After merge, run `node scripts/agent_workspace.cjs setup` once from the canonical local repository.
