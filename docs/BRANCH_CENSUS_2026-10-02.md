# Branch census — 2026-10-02 (Lean Refactor round 2)

Census only: **nothing was deleted.** The session's attempt to delete remote branches was refused by the
agent permission policy, so deletion is an owner action. Method: `git ls-remote --heads origin`, all PRs
(`/pulls?state=all`, 178), and `git ls-remote origin 'refs/pull/*/head'`. A branch counts as recoverable
only when its tip SHA equals the head of a **merged** PR **and** GitHub's `refs/pull/<n>/head` holds that
same SHA, so `git push origin refs/pull/<n>/head:refs/heads/<branch>` restores it exactly.

| Class (204 non-master branches) | Count | Deletion |
|---|---|---|
| ACTIVE — open PR (#192 and the three Dependabot PRs) | 4 | no |
| MERGED — tip = merged PR head, verified against `refs/pull/<n>/head` | 104 | 101 listed below; the 3 `ccr-*` session branches are kept, since those sessions may still push |
| SUPERSEDED — tip = closed, unmerged PR head | 29 | recoverable through `refs/pull`, but unmerged work: owner review first |
| MOVED — the PR exists but the tip moved after it (`chatgpt/distributor-financial-policy-guard`, `claude/eloquent-dijkstra-xlmlo2`, `claude/happy-mccarthy-qv1j9d`, `claude/nice-goldberg-a3qxq8`) | 4 | no — the later commits are the only copy |
| NO PR — the branch is the only copy of its commits | 63 | no — archive-tag or bundle before any deletion |

## Verified-recoverable merged branches (owner may delete; each restores with the PR ref)

| Branch | Tip | PR (restore: `git push origin refs/pull/<PR>/head:refs/heads/<branch>`) |
|---|---|---|
| `stripe-sandbox-proof-prep` | `9df609cb6136` | #1 |
| `stripe-authorization-only-proof` | `07a61a082cae` | #3 |
| `agent/stage-32c-product-surface-closure` | `48ea28a5f70b` | #6 |
| `claude/staging-acceptance-closure` | `d77aecbce335` | #8 |
| `codex/r9c-post-acceptance-prep` | `f6f5cb87a10e` | #9 |
| `claude/staging-apply-067-068` | `f94a4857b82b` | #10 |
| `claude/hosted-r9c-proof-charge-copy` | `4cd96cb57157` | #11 |
| `claude/restore-green-master-ci` | `feb3070ecf18` | #12 |
| `claude/ux-reintegration-after-green-master` | `411a4affd1af` | #13 |
| `claude/release-readiness-reintegration` | `0a0ec0bfc5e3` | #14 |
| `chore/agent-workflow-baseline-2026-09-15` | `ee7f0ec21036` | #15 |
| `claude/senior-adversarial-production-review-cwupc5` | `1402abebf646` | #18 |
| `chatgpt/integrate-pr18-product-path-f620072` | `45501f14121b` | #19 |
| `chore/agent-efficiency-v2-2026-09-16` | `459ded8498ae` | #20 |
| `fix/affiliate-visit-post-efficiency-v2` | `5ecf9d338557` | #22 |
| `chore/agent-efficiency-v3-status-isolation` | `4f2ee026fb3d` | #23 |
| `chatgpt/canonical-product-policy-alignment-20260916` | `cbe88a45e046` | #26 |
| `chore/agent-entrypoints-v4` | `5480ed5e23d6` | #27 |
| `chore/status-refresh-2026-09-16` | `33017e46ec92` | #30 |
| `chore/distributor-attribution-guard` | `381f5d7fe68b` | #31 |
| `chatgpt/agent-workflow-v5-refresh-r2` | `4a6de5cbe342` | #33 |
| `claude/siton-admin-cms-templates-s8g2ih` | `5bf669719f63` | #34 |
| `chatgpt/integrate-cloud-agent-manager-20260917` | `5f0262373eba` | #35 |
| `chatgpt/integrate-distribution-hub-20260917` | `ed885169e63b` | #37 |
| `claude/shelf-heavy-closeout-20260917` | `595c6b972241` | #38 |
| `claude/long-horizon-current-master-20260917` | `57d66371dcd6` | #42 |
| `claude/long-horizon-closeout-20260917` | `6987ce6051bc` | #43 |
| `claude/optimistic-meitner-qasx1a` | `2f9b14117400` | #48 |
| `claude/docx-seven-day-fix` | `d6c50b56d9a4` | #49 |
| `chatgpt/payment-activation-source-of-truth-20260918` | `92ffc6873a8d` | #55 |
| `claude/redteam-money-input` | `5a2c40c21ad0` | #59 |
| `claude/redteam-runtime-role-gate` | `98a3b3725bb8` | #60 |
| `claude/redteam-plural-agreement` | `2bae7ae353bb` | #61 |
| `claude/redteam-closeout` | `83bcff5d4ad3` | #62 |
| `chatgpt/payment-red-team-v2-20260918` | `832e38258430` | #63 |
| `chatgpt/otp-blueprint-20260918` | `c672c3d20c03` | #64 |
| `claude/redteam-phase2-final` | `b831319500a2` | #65 |
| `claude/peaceful-johnson-7rqtz1` | `0e5a29d74f5e` | #69 |
| `codex/engineering-operating-system-v2` | `bfd90cc5c39b` | #72 |
| `claude/admiring-brahmagupta-5bwqxx` | `c40df2917473` | #75 |
| `claude/elegant-edison-uqin15` | `3f1a6ac099d8` | #81 |
| `claude/team-lead-operating-model` | `a0e7439e57a6` | #82 |
| `claude/smoke-worker-log-scrub` | `e95d22039de6` | #83 |
| `claude/ci-minio-image-source` | `310afd1b9de4` | #84 |
| `claude/pensive-curie-sqa8ud` | `ae9ca88209b9` | #86 |
| `claude/daylight-legacy-native` | `4e67b6a3c54c` | #87 |
| `codex/post-pr87-cleanup` | `bb4950a7b66d` | #88 |
| `claude/daylight-closeout` | `44b52e3d8b48` | #89 |
| `claude/graphite-mint-status` | `89aceceb917b` | #91 |
| `claude/redteam-hardening-kx4e5a` | `081a504e9761` | #92 |
| `claude/redteam-status-close` | `db86b8166df8` | #93 |
| `chatgpt/codex-rereview-latest-head-20260926` | `9b514ecd5130` | #94 |
| `claude/festive-wright-kx4e5a-claim-fence` | `26a6f8231250` | #117 |
| `claude/festive-wright-kx4e5a` | `15dab963f3bf` | #123 |
| `claude/homepage-how-it-works-infographic-ed3is4` | `68373dc3167e` | #125 |
| `claude/zen-brown-ufd0cm` | `b4441101ba40` | #132 |
| `chatgpt/codex-bot-auth-fix-20260929` | `21e406159379` | #135 |
| `chatgpt/integrate-review-isolation-20260929` | `5eb8bd29247c` | #136 |
| `chatgpt/homepage-closeout-139` | `f6e8e5109ba7` | #144 |
| `chatgpt/unblock-worker-fencing-ci-20260929` | `194dee777e85` | #145 |
| `chatgpt/status-pipeline-recovery-closeout-20260929` | `fe4ab4e88494` | #146 |
| `claude/product-constitution-sot` | `41d2a3a07726` | #148 |
| `claude/outbox-evidence-rls` | `2ee0ef23d557` | #149 |
| `claude/lean-refactor-map` | `7d3bfe38ace6` | #150 |
| `claude/remove-product-library` | `1ed6134d6543` | #151 |
| `claude/legacy-app-mall-gate` | `b7de4aead558` | #152 |
| `claude/status-2026-09-30-close` | `96fcd75a529a` | #153 |
| `claude/lean-refactor-d1` | `e7054037efaf` | #154 |
| `claude/lean-refactor-d2` | `be3716086c7f` | #155 |
| `claude/lean-refactor-d3a` | `2cd230f02d38` | #157 |
| `claude/lean-refactor-d3b` | `0e4817958754` | #158 |
| `chatgpt/legal-distribution-links` | `8ac4b120c54f` | #159 |
| `chatgpt/product-library-schema-decouple` | `f860ccd87903` | #161 |
| `claude/lean-refactor-d3-closeout` | `fce05c53ccfc` | #162 |
| `chatgpt/lean-refactor-d5-docs-batch1` | `d7336ab8673b` | #163 |
| `chatgpt/openai-routing-gpt6-refresh` | `0f65ce9f3cae` | #165 |
| `claude/product-library-c2-schema-retirement` | `03343d2c2829` | #168 |
| `claude/lean-refactor-r1-unused-deps` | `063fa6e24a02` | #171 |
| `claude/lean-refactor-r2-src-dead-code` | `074528c3e5a8` | #172 |
| `chatgpt/lean-refactor-d5-docs-batch2` | `d6c9daaa2c74` | #173 |
| `chatgpt/fix-cms-video-storage-broker-r2` | `f229c71f61e4` | #174 |
| `claude/lean-refactor-r3-web-dead-code` | `d8a92ad11b32` | #175 |
| `claude/lean-refactor-r4-stale-scripts` | `652166275efb` | #176 |
| `claude/lean-refactor-d5-docs-batch3` | `37dca13619a0` | #177 |
| `claude/lean-refactor-d5-docs-batch4` | `8ea3b2df31cd` | #178 |
| `claude/lean-refactor-r5-tracking-projection` | `2cd110cea7ef` | #179 |
| `claude/lean-refactor-d5-docs-batch5` | `dc4ea37866ac` | #180 |
| `claude/lean-refactor-d5-docs-batch6` | `38b14542e2e7` | #181 |
| `claude/lean-refactor-census-2026-10-01` | `a845220cd7f0` | #182 |
| `chatgpt/cms-storage-staging-verified` | `5fc4998bd320` | #183 |
| `claude/d5-project-status-trim` | `9759fb2968ae` | #184 |
| `claude/d5-completed` | `d253e96ab488` | #185 |
| `claude/cms-video-phone-upload` | `c7ff41a865ec` | #186 |
| `claude/cms-video-stall-fix` | `08fa8f2639a4` | #187 |
| `claude/cms-video-webcodecs` | `a32f6608828c` | #188 |
| `claude/cms-video-proof-status` | `c09da63bf7a3` | #189 |
| `chatgpt/refactor-remove-notifications-alias` | `901a9c834073` | #190 |
| `claude/lr2-legal-html` | `e630a282bbb0` | #191 |
| `claude/video-test-source-duration` | `49f9eb37fdc0` | #193 |
| `claude/lr2-http-security-headers` | `909ba350434a` | #194 |
| `claude/lr2-cdp-launcher` | `767c6f391c5a` | #195 |
