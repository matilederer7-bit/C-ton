# Codex upgrade audit and integration checkpoint

This is a preparatory checkpoint, **not an activated model migration**. The new
capability policy has no managed-run caller yet. Existing production and agent
workflows are unchanged. Do not merge this checkpoint as completion of the upgrade.

## Evidence and environment boundaries

- Inspected master `904f72e3c196996d8f86399c81631816df84b8a9` and PR #124 at
  `698f7b48d664f5cb856e4eed4d318bbdda7cf7f3`. Later pushes need fresh review.
- Local `codex --version`: `codex-cli 0.149.0`.
- Desktop installed version `26.917.71314`, build `10954`, production channel;
  updater returned `restart_required`. No restart or installation performed.
- Actual local app-server `model/list` call, 2026-09-28, `includeHidden:false`,
  limit 100, `nextCursor:null`: GPT-5.6 Sol, Terra, Luna, Daybreak Blue, GPT-5.5.
  **No GPT-6 model was advertised by that CLI process.**
- Sol/Terra advertised low/medium/high/xhigh/max/ultra and multi-agent v2;
  Luna low/medium/high/xhigh/max and v1. GPT-5.5 advertised an upgrade to
  GPT-5.6 Sol and retirement on 2026-10-14. This is runtime metadata, not inference.
- Desktop task tools separately advertise GPT-6 Luna/Sol/Astra. These two execution
  surfaces disagree. Neither establishes access for the GitHub Actions API key.
- No cloud credential access or authenticated GPT-6 inference was performed.

Official sources opened during this audit:

- [OpenAI model catalog](https://developers.openai.com/api/docs/models): GPT-6
  Luna, Sol, Astra are current models. Published input/output prices per million
  tokens: Luna $0.10/$0.50, Sol $2/$10, Astra $10/$50. Luna is the cheapest of
  these three, not a claim about every specialized OpenAI model.
- [Codex models](https://learn.chatgpt.com/docs/models).
- [App-server model discovery](https://learn.chatgpt.com/docs/app-server): use
  `model/list` for runtime model IDs, supported reasoning and migration signals.
  Availability varies by account/client. Discovery is not successful inference.

## Intended central assignments (not active)

| Tier | Model | Reasoning | Use |
|---|---|---|---|
| economy | gpt-6-luna | low | Scout, inventory, simple checks, status |
| standard | gpt-6-sol | medium | Ordinary development and QA |
| senior | gpt-6-sol | high | DB, security/auth, money, state machine, architecture |
| apex | gpt-6-astra | high | Explicit approved escalation with evidence |

Reuse PR #124's `scripts/agent_model_tiers.cjs` as the assignment source of truth.
Do not create a second tier-to-model mapping. The new capability policy accepts
assignments from a caller; its approved model capability floors are project
policy, not a provider guarantee about quality. Same model at different reasoning
levels is valid for Standard and Senior. Unknown model overrides fail closed.

## Coordination and open work

- [PR #124 handoff](https://github.com/matilederer7-bit/C-ton/pull/124#issuecomment-5877151310)
  assigns the Codex column, swarm model matrix and Codex preflight work to Codex
  **after #124 merges**. Its Claude aliases, router/wiring and guard remain owned
  by Claude. No overlapping file is changed in this checkpoint.
- [PR #126 coordination](https://github.com/matilederer7-bit/C-ton/pull/126#issuecomment-5877145973):
  Claude owns CI shortening, classifier, verdict, test runner and shared gates.
- PR #79 remains unmerged. Its security fix must be verified rather than inferred
  from a PR description. PR #124's discussion still identifies the shared runner
  boundary between builder and reviewer as requiring isolation. This checkpoint
  does not resolve or approve that security boundary.
- The independent read-only review found that Codex pin validation has no approved
  capability floor; same-model tier validation needs reasoning awareness; routing
  misses architecture/state-machine and contradictory task-type declarations;
  team-plan output resolves Codex through Claude aliases; metadata access is not
  a capability/version check; the swarm has separate hard-coded GPT-5.6 models;
  reviewer identity needs execution-level enforcement. These findings require
  owner-path coordination before editing.

## Prepared gate and explicit migration path

`scripts/codex_capability_policy.cjs` validates approved model/effort pairs,
explicit Apex justification, complete fresh runtime discovery, a reviewed CLI
version, reasoning/text/subagent metadata and retirement signals. It preserves
capability requirements across explicitly selected upward fallbacks. Senior and
Apex never fall back. It returns `inferenceVerified:false` even on success.

The reviewed CLI version list currently contains only the locally inspected
0.149.0. This is a conservative qualification boundary, not proof that GPT-6 runs
on that CLI. Its observed catalog would reject GPT-6. Policy review expires after
30 days; discovery expires after five minutes. Those intervals are project policy.

After dependency merge and path handoff:

1. Update the central assignments and remove swarm literals; consume the same
   resolved model and effort for preflight, build, review, fix and synthesis.
2. Run fresh runtime discovery on each execution host. Bind the discovery to the
   current run, follow every cursor and fail closed on missing/incomplete data.
   Never accept a builder-authored discovery artifact as trusted evidence.
3. Keep the API-key metadata check, then perform an authorized harmless inference
   smoke for each selected model/effort in the actual cloud environment. Record
   requested and executed identities separately; do not expose credentials.
4. Wire the gate before every managed invocation and prohibit weaker substitution.
   Complete critical routing and distinct reviewer-session/path ownership checks.
5. Refresh official catalog/deprecation evidence and compare live discovery on
   each run. A new ID, retirement signal or runtime upgrade creates an explicit
   reviewed migration; it does not auto-promote the newest/most expensive model.
6. Add workflow integration tests, current-head independent review, green required
   CI, then merge and run a harmless managed smoke. No product staging change is
   needed for these isolated policy files; managed execution verification is needed.

## Status

- COMPLETED: repository/parallel-work audit; official documentation comparison;
  local runtime discovery; handoff recorded; isolated capability gate and tests.
- TESTED: 11 focused capability-policy tests pass locally. Initial isolated test
  runner hit Windows spawn EPERM; direct execution of the same node:test suite
  succeeded without modifying tests or gates. Independent review identified a
  fallback capability-loss bug, now fixed with a regression test.
- OPEN: #124 merge and handoff; managed wiring; critical routing and reviewer
  isolation; actual cloud GPT-6 access/inference; final review/CI/merge/smoke.
- PERCENT: 25% of the requested end-to-end upgrade; no activation claimed.
- NEXT: resolve dependency and integrate the gate with the central table and every
  managed invocation. PROJECT_STATUS Codex slot update waits for shared-file
  coordination; this status remains isolated to avoid overwriting active work.
