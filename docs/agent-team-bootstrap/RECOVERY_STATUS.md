# Bootstrap recovery — 2026-09-24

- Completed: preserved the original `claude/system-hardening-sweep` checkout,
  its two modified files and sixteen untracked files, with an independently
  SHA-256-verified backup. Reconciled the package on master `28523f1` in isolated
  branch `codex/bootstrap-reconcile-20260924`. Retained current product policy,
  Claude entry point, manager lifecycle and the entire master project status.
- Completed: added ten reconciled Claude specialist definitions and the PR
  template. Replaced the resetting/self-deleting installer with a preflighted,
  exclusive-create installer. No machine permission allowlist is installed.
  The original legacy installer and local files remain intact in the source
  checkout and backup; run only the reconciled installer in this task checkout.
- Checked: installer safety tests 6/6 PASS; shell syntax PASS; actual shell
  installation PASS (11 files), repeat installation PASS (0 files).
- Checked: adjacent agent suites plus bootstrap: 44 PASS / 5 FAIL. All five
  failures reproduce on unmodified master content with this Windows checkout's
  CRLF workflow files (baseline: 38 PASS / 5 FAIL); they are pre-existing
  LF-sensitive assertions. No gate or workflow was changed to hide them.
  Secret/PII scan PASS (1129 files, zero failures/warnings). Full canonical
  database-backed verification NOT RUN for this config-only recovery; the new
  isolated checkout has no provisioned disposable database or dependency install.
- Open: normal PR CI/review/merge. Cloud credential configuration and actual
  agent inference are outside this local bootstrap and are not claimed complete.
- Coordination: PR #78 owns cloud manager/router/workflow changes and shared
  status; PR #71 also owns shared status restructuring. This branch leaves
  `PROJECT_STATUS.md` byte-for-byte unchanged to respect those active scopes.
  This milestone is staged here for its lifecycle owner to carry into the
  Codex status slot at integration, rather than editing an actively claimed file.
- Progress: local recovery and installation 100%; repository integration
  pending PR CI/review/merge. This does not change cloud activation percentages.
- Next: review and integrate this branch after coordinating the shared status
  entry with PR #78/#71. No product runtime, payment, database or hosted change.
