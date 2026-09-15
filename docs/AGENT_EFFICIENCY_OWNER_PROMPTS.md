# Minimal owner prompt examples

These are examples, not required wording.

## Builder

```text
TASK: Fix seller draft image ordering so the chosen primary image persists after refresh.
```

## Builder with boundary

```text
TASK: Add seller profile photo upload.
SCOPE: seller profile API + storage + tests.
DO NOT TOUCH: seller dashboard layout.
```

## Reviewer

```text
REVIEW: PR #123
FOCUS: concurrency and seller ownership boundaries.
```

## Parallel work

Codex:

```text
TASK: Add seller profile photo backend support.
SCOPE: API, storage, tests.
DO NOT TOUCH: frontend; Claude owns it.
MODE: parallel-part
```

Claude Code:

```text
TASK: Add seller profile photo UI.
SCOPE: seller frontend only.
DO NOT TOUCH: API/storage; Codex owns it.
MODE: parallel-part
```

The agents must obtain standing instructions from the repository rather than requiring the owner to repeat them in each prompt.
