# R9C round 6 — status-response causal binding (targeted oracle fix)

Branch `claude/review-r9c-financial`. Frozen review SHA at start `43e4dfc6e409cd6dffbe4d0989427b8308c47e09`;
canonical master `82c91d62fd092350748405c8aec15a23d0e2af5e` (verified unmoved at start and at the end).

Codex's final merge gate (2026-09-13, `.tmp_r9c_final_merge_gate_20260913.md`, read only) closed the
orphan-authorization blocker and left ONE: the round-5 oracle still legalised a retry on a status
answer that had not arrived at Siton. This round is an oracle / proof-soundness fix only.
**No production source was changed** (§4 records the audit that justifies that). Real money 0; Grow
untouched and never called; no migration; no deploy; not merged.

---

## 1. Codex's exact reproduction against the unchanged tree

`independent_transport_window_control.cjs` (Codex's own script, `.worktrees/f12-round5-review`,
executed from a read-only copy pointed at this tree's compiled lab, before any edit):
`.tmp_r6/r6-codex-transport-vs-43e4dfc.log` — **exit 1, `FULL_ORACLE_VIOLATIONS []`,
`status_received_at_second_dispatch: false`** (line 124 of Codex's log reproduced verbatim).

Chronology on the provider's sequencer:

| seq | event | provider wrote (`delivered_seq`) | reached Siton? |
|---|---|---|---|
| 1 | capture `first` → `200-pending` (no effect) | 2 | yes |
| 3 | status read, PRE-horizon → `authorized/final` | 4 | yes → Siton recorded `permanent_fail` (this is the "old `resolved_at`") |
| — | 1 550 ms pass (settlement horizon 1 500 ms) | | |
| 5 | status read, POST-horizon → `authorized/final` | 6 | **no — held by a transport hop** |
| 7 | capture `second` → `200`, **money moved** | 8 | (sent while seq 5 was still held) |

Round-5 judgement: `second` legal on `{status_non_executed seq 5, delivered_seq 6}`; in the full
oracle the DB clause (`resolved_at <= dispatched_at`) was satisfied by the verdict of seq 3.

## 2. Root cause — two coupled defects, not one

1. **Observation = provider write.** `delivered_seq` is the instant the provider wrote the answer.
   A transport hop between the provider and Siton that holds the bytes is invisible to the
   provider, so "written" was taken for "known to Siton". (Round 5 had named this residual and
   claimed the DB clause covered it — Codex showed it does not.)
2. **`resolved_at` floats free of the response.** It is set once, by whatever terminal verdict
   came first, at the identity level. A verdict drawn from an EARLIER read (here a pre-horizon one
   that, by the horizon policy, cannot itself authorise a retry) satisfied the timing predicate on
   behalf of a LATER read it has nothing to do with. Provider answer existence + some prior
   identity-level resolution timestamp were accepted as proof that Siton observed THIS response.

## 3. The causal model (`tests/lab/dispatch_legality.ts`, `provider_simulator.ts`, `siton_observer.ts`)

Every arrow of `Q → R → delivered → received by Siton → recorded by Siton → D` is now a recorded
fact, all positioned on the simulator's single sequencer (integers, never wall clocks):

| fact | recorded by | meaning |
|---|---|---|
| `query_id` | Siton-side observer stamps `x-siton-lab-query-id` on the outgoing status request; the provider echoes it into its log entry | the causal identity of ONE query / ONE answer |
| `seq` / `at` | provider | Q received / R generated (positions the dispatch and the provider-side settlement horizon) |
| `delivered_seq` | provider | R written back — necessary, never sufficient |
| `status_received(query_id)` | observer, when the app has PARSED R's body | Siton observed R |
| `dispatch_sent(key)` | observer, BEFORE the money request leaves the process | D's own position |
| `dispatch_received(key)` | observer, when the app parsed D's answer | exact declines / successes of D |
| `verdict_recorded(identity, class)` | observer on `pg.Client.prototype.query`, at the COMMIT that made an `UPDATE siton.payment_attempts … result_class` durable | Siton's durable record, with process + outbox job |

The observer is installed by the lab runtime before the app loads (in-process runs carry the job
via `AsyncLocalStorage`), and by `siton_observer_preload.ts` inside real worker processes
(positions over the simulator's `/lab/observe` seam) — no production source is touched.

**Rule.** A capture-side repeat D after prior identity K is legal through status evidence only if
(S1) a final, non-executed, correctly-referenced read about K's operation, taken at/after the
settlement horizon (provider clock), was **received** by Siton before D was **sent**
(`status_received < dispatch_sent`); **and** (S2) a `permanent_fail` verdict on K was **committed**
before D was sent and is **causally sourced** from a received answer — a non-executed read
received by the same process (and the same job, when both are known) before the commit, or K's
own received exact decline. Exact declines (E1) require receipt of the decline and the committed
verdict, both before the send. Callbacks and operator verdicts keep their DB-instant order against
the arm (E3/E4). Positive evidence (release/refund rules) requires receipt before the send.

Two responses may play two roles for one repeat, exactly as the production rails work: the
durable verdict (reconcile / prior-attempt resolution / exact settle) and the post-horizon
confirmation (the recovery rail's pre-flight, which records nothing). One response may be both
(N6/P2/P4 pin the response-specific binding: the evidence names the query it came from).

**`resolved_at` disposition: removed from the oracle** (option B of the brief). It is no longer
read for any provider-channel evidence; `oracle.ts` no longer passes it. The only DB instants left
in the legality audit are `webhook_events.received_at` / operator `updated_at` against
`dispatched_at` (E3/E4, both DB clocks, unchanged since round 4).

## 4. Production audit — ORACLE_ONLY_DEFECT = YES

Traced the real retry decision before touching anything (`src/app.ts`, `src/payment_attempt_helpers.ts`):

* `payment_attempts.resolved_at` is **never read** by any production payment path (the only
  `resolved_at` references in `src/` are invoice and payout tables). It is written by the 067
  trigger and consumed by nothing.
* A recovery is dispatched only when (a) the prior identity is `permanent_fail` in the DB — written
  by `settleProviderDispatch` after the awaited capture answer, by `finalizeAttemptResult` after an
  awaited status answer (reconcile / `resolvePriorProviderAttempt`), by an authenticated callback,
  or by an operator; (b) the 064/068 settlement fence has elapsed (or the evidence is exact);
  (c) `verifyOriginalCaptureBeforeRecovery` took TWO awaited pre-flight status reads
  (`recovery_preflight:<job>:<participant>:<n>`, unique per read) that both declare non-execution;
  then `beginProviderAttempt → armProviderDispatch → provider.recover`. Every status answer is
  awaited before any decision; the verdict is durable before the next identity is minted; the
  dispatch is sent after both pre-flight answers were parsed.
* The charge rail's `resolvePriorProviderAttempt` records the verdict and `continue`s; a fresh
  identity is minted only on a later run.

Production never authorises a retry from an attempt-level timestamp, and never from a response it
has not received. The defect was confined to the lab's oracle. No production file changed.

## 5. Controls (`tests/review_oracle_causal_binding_validation.ts`)

All on the round-6 oracle (`.tmp_r6/r6b-oracle-causal.log`): **14/14**.

| control | chronology | verdict |
|---|---|---|
| **T1** REAL simulator + REAL observer, Codex's chronology: pre-horizon read received → verdict recorded → post-horizon answer written by the provider but HELD by a localhost transport hop → second capture sent inside the hold | reject; the waited twin (received → recorded → sent, distinct identities) accept | **REJECT / ACCEPT** |
| N1 provider generates the final answer, transport withholds it, retry sent | | REJECT |
| N2 (Codex) an OLD verdict from a pre-horizon read is on record; the post-horizon answer is withheld | rows carry the early `resolved_at` the round-5 clause accepted | REJECT |
| N3 Q1 delivered and recorded but pre-horizon; Q2 post-horizon generated and withheld | | REJECT |
| N4 answer delivered and received, no durable verdict on K before the retry | | REJECT |
| N5 answer received and verdict recorded only after the retry was sent | | REJECT |
| N6 two simultaneous queries, only q1 delivered/received | ACCEPT with `evidence.query_id === "q1"` and `verdict_source === "q1"` — response-specific | ACCEPT |
| N7 an unrelated callback resolves K before a withheld status answer | ACCEPT through `callback_failed`; the withheld answer is never cited | ACCEPT |
| N8 verdict committed after the send while the row claims an early `resolved_at` | | REJECT |
| N9 a verdict with no observed source (nothing received before it) + a received post-horizon read | | REJECT |
| P1 exact synchronous decline received and recorded before the retry | `exact_decline` | ACCEPT |
| P2 post-horizon answer received and its verdict recorded before the retry | `status_non_executed`, `query_id`/`verdict_source` = q1, received/verdict < sent | ACCEPT |
| P3 authenticated callback received and committed before the retry | `callback_failed` | ACCEPT |
| P4 earlier fully-observed post-horizon Q1 while a later Q2 is pending | evidence = q1 ("latest delivered" is NOT required) | ACCEPT |

Round-5 observation controls (`review_oracle_observation_negative_validation.ts`, its real-simulator P1 now runs with the observer): **17/17**; round-4 temporal controls: **18/18**. Both files derive their observations from their stories (sent just before arrival, received right after the provider's write, verdicts stated explicitly where a story says Siton recorded one).

## 6. Mutations (`scripts/review_mutation_proof.cjs`, `.tmp_r6/r6-oracle-mutations.log`)

| mutant | re-introduces | killed by |
|---|---|---|
| OM-6 | **M1** — response/query binding dropped; identity-level row timestamp (`updated_at <= arm`) + provider write | T1 (Codex transport hold) |
| OM-4 | **M2** — provider creation / write treated as delivery | T1 (Codex transport hold) |
| OM-5 | M2′ — an answer Siton never received is usable | N3 |
| OM-8 | **M3** — delivery treated as durable recording (no committed verdict needed) | N4 |
| OM-9 | **M4** — any prior verdict on the identity authorises the repeat (receipt no longer required) | T1 (Codex transport hold) |
| OM-10 | M4′ — a verdict counts regardless of what Siton received before committing it | N6 (evidence must name the delivered response) |
| OM-3, OM-7 | round 5 (503/pending as failure; non-final read as non-execution) | L1, U — both controls now carry the verdict Siton would have recorded, so only the mutated clause can reject them |
| OM-1b, OM-2 | round 4 | unchanged |

Result (`.tmp_r6/r6b-mutations-oracle.log`): **10/10 killed** (OM-1b, OM-2, OM-3, OM-4, OM-5, OM-6, OM-7, OM-8, OM-9, OM-10). Codex's transport-hold control (T1) is the kill for M1, M2 and M4 as required. Sources restored byte-exactly.

Recorded, not hidden: (1) the first run of the new mutants reported OM-6/OM-9/OM-10 INVALID (their edits did not type-check — a compile error is never a kill) and OM-3/OM-7 SURVIVED because L1/U no longer carried a verdict, so the durable-verdict clause masked the mutated clause; the mutants were rewritten to compile and the two controls state their verdict explicitly. (2) One re-run hit `ANCHOR_MISSING` on OM-1b (its anchor moved when E3/E4 were wrapped) and the harness exited with OM-1b's FIRST edit still in the tree; the guard was restored by hand (the temporal suite's I5 confirms), OM-1b re-anchored, and the harness now restores every original before exiting on a missing anchor. (3) A stray `require` of the harness from a one-off script triggered one unintended full run (RM + OM, all RM production mutants killed on the current source); it completed and restored the tree.

## 7. Targeted validation

Sequential, one runner at a time, fresh disposable databases (`.tmp_r6/driver.log`, `r6b-*` = final oracle):

| step | result |
|---|---|
| Codex exact transport-hold script vs 43e4dfc (before) | exit 1, `FULL_ORACLE_VIOLATIONS []` — reproduced |
| Codex exact transport-hold script vs the fixed oracle | exit 0, `AUTOMATIC_REPEAT_WHILE_UNKNOWN` |
| N1–N9, P1–P4, T1 | 14/14 |
| oracle mutation proof (OM-1b…OM-10) | 10/10 killed |
| round-5 observation suite / round-4 temporal suite | 17/17 / 18/18 |
| exact seed 209752203 (traced) | **300/300**; 540 dispatches, 61 repeats all legal: 32 `status_non_executed` (every one names its `query_id`, `received_seq < sent_seq`, `verdict_seq < sent_seq`, `verdict_source` = a named query) + 29 `exact_decline`; 0 illegal, 0 unbound |
| exact seed 203965851 | 300/300 |
| exact seed 273739535 | 300/300 |
| fresh seed 474592646 | 300/300 |
| F12 targeted (durable escalation 12/12; dual detect 4/4) | PASS |
| orphan-authorization regression | 1/1 |
| attempt-lifecycle crash/race matrix | 10/10 |
| F-14/F-15/F-16 | 8/8 |
| two-worker concurrency matrix (real workers carry the observer preload) | **32/32** |

No production code changed, so the full 246-file suite was not rerun (task §10).

## 8. Out of scope, unchanged

KYC product-policy mismatch, the unpaid pickup-card UX regression, the mobile CTA placement, the
stale P0 copy assertions, F-13 (provider-contract; **REAL_MONEY_BLOCKER = YES**), Grow. The
compliance / money-tax / legal scanner defects Codex classified are untouched.
