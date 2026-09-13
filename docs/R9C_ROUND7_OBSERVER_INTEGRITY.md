# R9C ROUND 7 — OBSERVER INTEGRITY HARDENING (oracle / lab only)

Branch `claude/review-r9c-financial` · old review SHA `9df33bf` · master `82c91d6` (unmoved) · 2026-09-13/14.
NOT merged · NOT deployed · no migration · real money 0 · Grow never called.
**No production source changed: `git diff 9df33bf -- src/` is empty.**

Codex's round-6 independent re-review (`.tmp_r9c_round6_independent_report.md`,
read only) closed the transport-hold blocker (its exact control PASS, F12
12/12 + 4/4, orphan 1/1, R1–R6 unique-id controls PASS) and found three P1
defects in the PROOF observer — `tests/lab/siton_observer.ts` — not in the
oracle rule and not in production:

| # | Codex finding | Round-6 cause |
|---|---|---|
| A | query id reuse after a process restart: `worker-restart:q1` minted twice; a REAL restart + held transport let a withheld Q2 borrow Q1's receipt (`received_seq=7` for an answer created at 9) | `query_id = <label>:q<counter>`, counter reset per install / process, no incarnation nonce |
| B | false `verdict_recorded`: emitted for a 0-row UPDATE, for a COMMIT that answered `ROLLBACK` (aborted tx), and with a NOTE parameter listed as an updated identity | verdict derived from every string parameter, queued before the statement result, published when the COMMIT promise resolved regardless of its command tag |
| C | `status_received` stamped after `response.text()` but before `JSON.parse` | body hooks fired when `text()/json()/…` resolved |

## 1. Reproduction first (unchanged 9df33bf)

Codex's own scripts, copied with absolute requires (`.tmp_r7/independent_r6_controls_copy.cjs`,
`.tmp_r7/independent_r6_restart_transport_copy.cjs`; the worktrees stayed read-only), run
against the unchanged tree:

* `.tmp_r7/r7-codex-controls-vs-9df33bf.log` — **12 PASS / 6 FAIL**:
  `RESTART_IDS [{auth-C, worker-restart:q1},{auth-D, worker-restart:q1}]`;
  `BEFORE_JSON_PARSE [{status_received, text-reader:q1}]` (emitted before the parse);
  `ZERO_ROW {rowCount:0, events:[verdict_recorded MISSING]}`;
  `ABORTED_COMMIT {command:"ROLLBACK", row:{result_class:"unknown"}, events:[verdict_recorded OTHER]}`;
  `WRONG_IDENTITY identities:["VICTIM","OTHER"]`; and the synthetic reused-id control accepted.
* `.tmp_r7/r7-codex-restart-vs-9df33bf.log` — **exit 1**: `received=false`, both status
  queries `stable-worker-id:q1`, evidence `received_seq=7` (Q1's receipt) for Q2 (`seq=9`,
  written at 10), recovery `sent_seq=11`, `violations=[]` — "held Q2 borrowed Q1 receipt
  after worker observer restart".

QUERY_RESTART_BUG_REPRODUCED = YES · FALSE_VERDICT_ZERO_ROW_REPRODUCED = YES ·
FALSE_VERDICT_ROLLBACK_REPRODUCED = YES · PARAMETER_MISATTRIBUTION_REPRODUCED = YES ·
PRE_PARSE_RECEIVE_BUG_REPRODUCED = YES.

## 2. The observer contract (now the header of `tests/lab/siton_observer.ts`)

* **QUERY_ID** = `<process>:<instance>:q<n>`; `<instance>` is a UUID minted when the
  observer incarnation is installed (per process boot in workers via the preload, per
  install in-process), `<n>` a per-incarnation monotonic counter. Unique across process
  lifetime, restart, worker identity and concurrency. The provider echoes it
  (`x-siton-lab-query-id` response header, simulator change) so that one answer names
  one query.
* **STATUS_RECEIVED** is recorded only when the answer echoes the id of the query this
  response was obtained for AND the envelope is 2xx, AND the app has PARSED the body —
  the observer hooks `JSON.parse` and recognises the exact string it handed to the app
  from `text()` (`json()` is `text()` + `JSON.parse`) — AND the parse succeeded AND the
  value has the provider status shape (object with a string `state`). Parse failure,
  invalid shape, non-2xx, missing / mismatching echo, a body never parsed, or a body
  handed over by a dead (uninstalled) incarnation record nothing. The receipt is
  positioned inside the app's parse, before the value is returned; one body → at most one
  receipt.
* **DISPATCH_SENT** before the bytes leave; **DISPATCH_RECEIVED** when the app parsed the
  money answer into an object (same parse rule).
* **VERDICT_RECORDED** only for a recognised terminal write — `UPDATE siton.payment_attempts`
  whose SET clause assigns `result_class` success/permanent_fail and whose WHERE clause
  binds `correlation_id = $n` exactly once (identity = that parameter; notes, references
  and owner uuids are never identities), or a statement with `RETURNING correlation_id`
  (identities = returned rows) — that matched the intended attempt (`rowCount` exactly 1;
  0 rows → nothing) and became durable: staged during the transaction, published only when
  the COMMIT resolved with command tag `COMMIT` (an aborted transaction's COMMIT answers
  `ROLLBACK` → nothing; a rejected COMMIT, ROLLBACK or ROLLBACK TO a savepoint before the
  write → the stage is discarded; RELEASE keeps it); autocommit publishes on the statement
  result with the same row-count rule. The published class is the durable class: from the
  statement when it assigns a parameter/literal, READ BACK from the locked row inside the
  same transaction when the statement computes it (`CASE … ELSE $n END`,
  `settleProviderDispatch`). Nothing is guessed from parameter values; a terminal
  assignment the classifier cannot bind is counted as `terminal_writes_unrecognised`
  (a lab alarm, never a verdict) — O17 proves production has none.
* Every emission of one incarnation is serialised in call order (per-incarnation queue),
  so a receipt recorded inside `JSON.parse` reaches the sequencer before anything the app
  does next, in-process and over the worker `/lab/observe` seam alike.

## 3. Fixes (lab only)

| Field | Fix |
|---|---|
| QUERY_ID_FIX | instance UUID at install + monotonic counter (`siton_observer.ts`); the simulator echoes the id (`provider_simulator.ts`); the oracle additionally refuses a receipt whose query id names more than one provider request, whose answer was never written, or that is positioned before the query reached the provider (`dispatch_legality.ts` `receivedSeqOfStatus`, defence in depth — Codex's synthetic reused-id control now REJECTS) |
| TRANSACTION_OBSERVER_FIX | pg wrapper stages per client with savepoint depth, publishes only on `command === "COMMIT"`, discards on ROLLBACK / ROLLBACK TO / rejected COMMIT / aborted COMMIT; `rowCount` must be exactly 1 (keyed) or ≥ 1 rows (RETURNING); callback-style `client.query` handled too |
| IDENTITY_BINDING_FIX | exact-shape classifier `classifyPaymentAttemptWrite()`: identity = the `correlation_id = $n` WHERE binding (or RETURNING rows), class = the SET assignment (parameter / literal / CASE read-back); `isUnboundTerminalWrite()` alarms on any terminal assignment the classifier cannot bind |
| STATUS_RECEIVED_FIX | receipt inside the app's own `JSON.parse` of the exact body string handed over by `text()`, after echo match + 2xx + shape validation; `json()` routed through `text()` + `JSON.parse`; a dead incarnation's hooks record nothing |

The observer handle now exposes `instance`, `stats()` (queries, receipts, every drop
reason, verdicts, every discard reason, unrecognised terminal writes) and `drain()`.
`ObservationRecord` carries `instance`, `row_count`, `class_source` (forwarded by
`/lab/observe`). The round-6 causal suite's T1 transport hop now forwards the echo header
(an honest hop); nothing else in the round-6 suites changed.

## 4. Observer integrity suite — `tests/review_observer_integrity_validation.ts` (O1–O17)

Real simulator, real observer incarnations (uninstall/install = restart; O1/O2 spawn
REAL child processes), real localhost hops, real PostgreSQL (fresh lab database, real
schema and triggers) with the production statement texts read verbatim from
`src/payment_attempt_helpers.ts`. No observation is injected by hand.

| Control | Result |
|---|---|
| O1 restart: two REAL successive processes, same `WORKER_ID` → distinct ids (`worker-restart:<uuid>:q1` × 2), one receipt each, after the write | PASS |
| O2 three simultaneous workers incl. two with the same label → distinct ids | PASS |
| O3 24 concurrent queries of one incarnation → 24 ids, receipts 1:1, each after its own write | PASS |
| O4 restart while the hop holds A's answer → no receipt for the dead incarnation's query; B's own query binds; A counts `dead_instance=1` | PASS |
| O5 0-row production UPDATE in a tx and autocommit → no verdict (`zero_row=2`) | PASS |
| O6 ROLLBACK, ROLLBACK TO SAVEPOINT → no verdict (row still unknown); RELEASE + COMMIT → exactly one | PASS |
| O7 COMMIT answering `ROLLBACK` (after `SELECT 1/0`) → nothing; COMMIT rejected (backend terminated) → nothing; rows unknown | PASS |
| O8 committed `settleAttemptInTx` → exactly one verdict, none before COMMIT, `class_source=statement`; `settleProviderDispatch` CASE on unknown → `permanent_fail` read back; the same statement on an already-`success` row → verdict `success` (row truth, not the parameter) | PASS |
| O9 note parameter = another live identity (production shape and Codex's shape) → identities `[K]` only, victim untouched | PASS |
| O10 MALFORMED: `text()` ok, `JSON.parse` throws → no receipt; `json()` rejects → no receipt (`parse_failed=2`) | PASS |
| O11 hop rewrites / strips the echo → no receipt (`echo_mismatch=1` each) | PASS |
| O12 valid parse → exactly one receipt after the provider's write, bound to this query and incarnation | PASS |
| O13 same body parsed three times → one receipt; byte-identical replayed answer → its own query, its own single receipt | PASS |
| O14 Codex's restart + held-transport chronology through an HONEST hop with REAL committed verdicts → `AUTOMATIC_REPEAT_WHILE_UNKNOWN`, evidence null, the older query never cited; waited twin → legal with evidence naming Q2 as receipt and verdict source | PASS |
| O15 oracle: consistent synthetic chronology legal; a query id shared by two provider requests binds no receipt | PASS |
| O16 oracle: receipt before the query reached the provider / answer never written → nothing | PASS |
| O17 static conformance: 6 production `UPDATE siton.payment_attempts` statements — 2 keyed terminal writes (param `$1`/identity `$5`; CASE `$5`/identity `$4`), 1 RETURNING non-terminal (`temporary_fail`, never a verdict), 3 without a `result_class` assignment; none unrecognised | PASS |

`.tmp_r7/r7-observer-integrity.log`: **17/17**.

## 5. Observer mutation proof (`scripts/review_mutation_proof.cjs`, suite = O-suite only)

| Mutant | Defect re-introduced / guard removed | Result |
|---|---|---|
| OM-A | query id = label + counter (no incarnation UUID) | KILLED (O1) |
| OM-B | verdict published at the UPDATE, before COMMIT | KILLED (O6/O8) |
| OM-C | rowCount ignored (0-row publishes) | KILLED (O5) |
| OM-D | ROLLBACK publishes the stage | KILLED (O6) |
| OM-D2 | COMMIT command tag ignored (aborted COMMIT publishes) | KILLED (O7) |
| OM-E | identities = every string parameter | KILLED (O9) |
| OM-F | receipt at `text()`, before the parse | KILLED (O10) |
| OM-G | echo mismatch ignored | KILLED (O11) |
| OM-I | oracle: shared query id allowed | KILLED (O15) |
| OM-J | oracle: receipt position unchecked | KILLED (O16) |
| OM-K | oracle: unwritten answer may have a receipt | KILLED (O16) |

`.tmp_r7/r7-observer-mutations.log`: **11/11 killed, 0 survived, 0 compilation-invalid**. Round-6 oracle mutants
OM-1b…OM-10 (M1–M4) were rerun on the hardened tree: 10/10 killed (`.tmp_r7/r7-mutations-round6-oracle*.log`; OM-4 and OM-5 re-anchored on the hardened `receivedSeqOfStatus` — their round-6 anchor no longer exists — with the same semantics: provider write as receipt / missing receipt as position 0; OM-3 and OM-7 are killed by the observation suite and survive the temporal suite alone, as in round 6).

## 6. Codex's independent controls, rerun on the hardened tree

* `.tmp_r7/r7-codex-controls-vs-fixed.log` — **18/18 PASS** (R1–R6, wrong-operation,
  out-of-order, reused-query-id, JSON-parse boundary, distinct workers, worker restart,
  zero-row, aborted COMMIT, note parameter).
* `.tmp_r7/r7-codex-restart-vs-fixed.log` — **exit 0**: `AUTOMATIC_REPEAT_WHILE_UNKNOWN`
  raised. Note: Codex's hop does not forward the echo header, so the hardened observer
  records no receipt through it at all (fail-closed); the meaningful variant with an
  honest hop and REAL committed verdicts is O14 (REJECT / waited twin ACCEPT).

## 7. Targeted regression (one runner at a time, fresh databases, `.tmp_r7/`)

| Run | Result |
|---|---|
| Observer integrity O1–O17 | 17/17 |
| Observer mutants OM-A..OM-K | 11/11 killed, 0 survived, 0 compilation-invalid |
| Codex independent controls / restart-transport | 18/18 · exit 0 |
| Round-6 causal-binding suite (T1 real hop now forwards the echo) | 14/14 (T1 unsafe REJECT / waited ACCEPT through the echo-forwarding hop) |
| Round-5 observation suite | 17/17 |
| Round-4 temporal suite | 18/18 |
| R1–R6 (Codex's fixtures, inside the controls run) | 8/8 ACCEPT/REJECT as expected |
| Seed 209752203 (traced) | 300/300 (474 participants, 542 provider effects) — trace: 61 legal repeats, 32 status-read evidences all bound (query_id + received + verdict + source), 29 exact declines, 0 unbound, 0 illegal |
| Fresh seed 480387699 | 300/300 (472 participants, 551 provider effects) |
| F12 smoke (durable escalation + escalation) | 12/12 + 4/4 |
| Orphan-authorization smoke | 1/1 |
| Two-worker concurrency matrix (workers run the hardened preload: JSON.parse hook + serialised `/lab/observe` emissions) | 32/32 |

Full 246-file suite deliberately NOT rerun (task §10: observer integrity only). One unintended partial run of the PRODUCTION mutants (RM-1, RM-2 killed 2/2 suites each) was started by a harness-loading mistake and stopped during RM-3 with its `src/app.ts` edit still applied; the file was restored with `git checkout` and `git diff 9df33bf -- src/` verified empty before every later run and before the commit.

## 8. Production audit (task §11) — ORACLE_OBSERVER_ONLY = YES

* Query identity: production stamps `x-request-id` with the operation's correlation id
  (`src/payment_provider.ts` status()), `reconcile:<eventId>` and
  `recovery_preflight:<eventId>:<pid>:<n>` (`src/app.ts`) — outbox UUID based, no
  per-process counter; production never keys a decision on a restart-reset id.
* Durability: every terminal write is inside `deps.withTx` (`settleAttemptInTx`,
  `settleProviderDispatch`), the helpers check `rowCount` (`Number(updated.rowCount || 0) === 1`
  → otherwise `classifySettleRefusal`), `if (!row) return "missing"`; production never
  reports a verdict it did not commit — the false `verdict_recorded` existed only in the lab
  wrapper's reading of the statements.
* Parse boundary: `parseJsonSafely` awaits `text()`, then `JSON.parse`, returns
  `{ raw_body }` on failure → `state: "unknown"` / `final: false`; production never acts on
  an unparsed or malformed body; the pre-parse stamp existed only in the lab hook.
* `git diff 9df33bf -- src/` is empty; nothing in the three findings named a production
  authorisation mechanism.

## 9. Corrective reruns recorded

* O1/O2 first failed with the Windows libuv `!(handle->flags & UV_HANDLE_CLOSING)` abort
  in the child processes at `process.exit` (known R9A gotcha) — a 700 ms teardown drain
  was added to the child; the assertion itself was never reached. 15/17 → 17/17.
* The first oracle rule required the receipt to follow the provider's WRITE
  (`received > delivered_seq`); Codex's synthetic out-of-order fixture keeps
  `delivered_seq` from its builder after moving the request earlier, so that rule rejected
  a chronology Codex expects legal. The rule now requires "written at all" and "received
  after the query reached the provider" (`received > seq`), which is what the real
  restart counterexample needs (17/18 → 18/18 on Codex's controls).

## 10. Open / out of scope (untouched)

F-13 provider-contract blocker — REAL_MONEY_BLOCKER = YES; KYC policy mismatch; unpaid
pickup-card UX; mobile CTA placement; stale P0 copy assertions; Grow. No new production
P0/P1 was established by this round.
