#!/usr/bin/env node
/**
 * INDEPENDENT REVIEW — anti-vacuity proof for the reviewer's own suites.
 *
 * A green counterexample proves nothing unless removing the defence turns it
 * red. This applies one deliberate defect at a time to a throwaway working
 * copy of the source, runs the reviewer's suites that are supposed to catch
 * it, records whether they went RED, and restores the exact pre-mutation
 * bytes. A mutant that stays GREEN is reported honestly, never hidden.
 *
 * Every mutant here reverts one layer of the exact-operation identity defence
 * that the R9C integration candidate adds, including the final review's own
 * correction (RM-1 restores the `/^[a-z]{3}-/i` alias that made a foreign
 * `xyz-` reference look like the queried authorization).
 *
 * R9C ROUND 4 — ORACLE mutants (OM-*). The dispatch-time legality oracle
 * (tests/lab/dispatch_legality.ts + tests/lab/oracle.ts) is itself a defence
 * that must be proven non-vacuous: each OM mutant re-introduces one way an
 * oracle can be fooled by hindsight — evidence from after the dispatch, the
 * round-3 late_money_effect exemption, UNKNOWN read as failed — and the
 * temporal negative controls MUST go red. These mutate TEST source only; the
 * src/ clean-tree guard still applies and the exact bytes are restored.
 *
 * Usage:  node scripts/review_mutation_proof.cjs [RM-1 RM-2 ... OM-1a ...]
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MUTANTS = [
  {
    id: "RM-1",
    invariant: "an arbitrary three-letter prefix never aliases the queried provider reference",
    layer: "provider-ready adapter reference discipline (the final review's own correction)",
    edits: [
      {
        file: "src/payment_provider.ts",
        from: `const bareReference = (value: unknown) => String(value || "").trim().replace(/^(cap|rec|ref|rel)-/, "");`,
        to: `const bareReference = (value: unknown) => String(value || "").trim().replace(/^[a-z]{3}-/i, "");`
      }
    ],
    suites: ["review_payment_foreign_reference_ab_validation.ts", "review_payment_reference_identity_rails_validation.ts"]
  },
  {
    id: "RM-2",
    invariant: "the reconcile rail refuses a status answer that names another operation",
    layer: "handlePaymentReconcileEvent reference-mismatch guard",
    edits: [
      {
        file: "src/app.ts",
        from: `  if (status.reference_matches_query === false) {
    await openPaymentOperationalCase({
      autoKey: \`payment-reconcile-reference-mismatch:\${participantId}:\${attemptType}\`,`,
        to: `  if ((status.reference_matches_query as unknown as string) === "never") {
    await openPaymentOperationalCase({
      autoKey: \`payment-reconcile-reference-mismatch:\${participantId}:\${attemptType}\`,`
      }
    ],
    suites: ["review_payment_foreign_reference_ab_validation.ts", "review_payment_reference_identity_rails_validation.ts"]
  },
  {
    id: "RM-3",
    invariant: "the recovery pre-flight refuses foreign evidence before authorising a second capture",
    layer: "verifyOriginalCaptureBeforeRecovery foreignRead guard",
    edits: [
      {
        file: "src/app.ts",
        from: `  const foreignRead = reads.find((r) => r.reference_matches_query === false || (expectedCurrencyAll && r.currency && String(r.currency).toUpperCase() !== expectedCurrencyAll));`,
        to: `  const foreignRead = reads.find((r) => Number(1) === 2);`
      }
    ],
    suites: ["review_payment_reference_identity_rails_validation.ts"]
  },
  // RM-5 (round 1: "a SECOND capture is escalated, never absorbed as a replay")
  // is RETIRED: the predicate it mutated (captureSideDualSuccess) was replaced in
  // round 2 by the identity-COUNTING predicate, which RM-6 mutates. Keeping a
  // mutant whose anchor no longer exists would abort the whole run (ANCHOR_MISSING).
  {
    id: "RM-6",
    invariant: "dual capture is decided by COUNTING distinct executed capture-side identities, not by a replay test that its own evidence defeats",
    layer: "captureSideExecutedIdentities / dual-capture predicate (Codex blocker, root cause 2)",
    edits: [
      {
        file: "src/app.ts",
        // ROUND 4: re-anchored on the round-3 structure (readCaptureSideIdentityEvidence
        // decides confirmed_dual); the mutation is the same self-defeating replay
        // test — "every executed identity differs from the reported one" — which
        // the reported identity's own committed success permanently defeats.
        from: `  const sorted = [...identities].sort();
  return sorted.length >= 2
    ? { outcome: "confirmed_dual", identities: sorted, reportedExactDecline }`,
        to: `  const sorted = [...identities].sort();
  const reportedKey = reportedFamily && reported ? \`\${reportedFamily}:\${reported}\` : "";
  return sorted.length >= 2 && sorted.every((identity) => identity !== reportedKey)
    ? { outcome: "confirmed_dual", identities: sorted, reportedExactDecline }`
      }
    ],
    suites: ["review_payment_dual_capture_durable_escalation_validation.ts"]
  },
  {
    id: "RM-7",
    invariant: "a known double capture is never acknowledged as handled unless its escalation is durably committed with the money evidence",
    layer: "atomic, error-propagating escalation (Codex blocker, root cause 1)",
    edits: [
      {
        file: "src/app.ts",
        from: `    await openPaymentOperationalCaseInTx(c, escalation);`,
        // the pre-fix architecture: the case written on its OWN transaction by
        // the suppressing wrapper, so its failure is invisible and the money
        // evidence commits alone
        to: `    await openPaymentOperationalCase(escalation);`
      }
    ],
    suites: ["review_payment_dual_capture_durable_escalation_validation.ts"]
  },
  {
    id: "RM-8",
    invariant: "an unreadable capture-side identity evidence set is never answered as \"not a dual capture\"",
    layer: "readCaptureSideIdentityEvidence fail-closed (Codex round-3 blocker)",
    edits: [
      {
        file: "src/app.ts",
        from: `  } catch (cause) {
    // NOT an empty set. The evidence is unknown, and unknown is its own answer.
    return { outcome: "unreadable", cause };
  }`,
        // the pre-fix swallow: a read error becomes an empty evidence set, which
        // is spelled exactly like "no other capture succeeded"
        to: `  } catch (cause) {
    void cause;
    rows = [];
  }`
      }
    ],
    suites: ["review_payment_dual_capture_durable_escalation_validation.ts"]
  },
  {
    id: "RM-9",
    invariant: "a reported real money effect converges the identity, which is what blocks a release of money that really moved",
    layer: "late-effect identity convergence (the candidate's FR-3 contract)",
    edits: [
      {
        file: "src/app.ts",
        from: `  const settleReportedIdentity = Boolean(correlation);`,
        to: `  const settleReportedIdentity = false && Boolean(correlation);`
      }
    ],
    suites: ["review_payment_dual_capture_escalation_validation.ts"]
  },
  {
    id: "RM-4",
    invariant: "prior-attempt resolution refuses a status answer about another operation before reusing an identity",
    layer: "resolvePriorProviderAttempt reference-mismatch guard",
    edits: [
      {
        file: "src/app.ts",
        from: `  if (status.reference_matches_query === false) {
    await openPaymentOperationalCase({
      autoKey: \`payment-reconcile-reference-mismatch:\${args.participant_id}:\${args.attempt_type}\`,`,
        to: `  if ((status.reference_matches_query as unknown as string) === "never") {
    await openPaymentOperationalCase({
      autoKey: \`payment-reconcile-reference-mismatch:\${args.participant_id}:\${args.attempt_type}\`,`
      }
    ],
    suites: ["review_payment_reference_identity_rails_validation.ts"]
  },
  // ── R9C ROUND 5 — never-dispatched identity lifecycle (production source) ─
  {
    id: "RM-10",
    invariant: "an identity is minted only while the participant is in the rail's admitted state, re-read under the participant/deal lock (Codex round-4 race: a stale snapshot minted an orphan)",
    layer: "beginProviderAttempt admitted-state check",
    edits: [
      {
        file: "src/payment_attempt_helpers.ts",
        // hindsight: any existing participant counts as admitted — the state re-read under the lock decides nothing
        from: `        const admitted = Boolean(state)
          && args.admitted.money_states.includes(String(state!.money_state))
          && (!args.admitted.buyer_states || args.admitted.buyer_states.includes(String(state!.buyer_state)));`,
        to: `        const admitted = Boolean(state);`
      }
    ],
    suites: ["review_arm_race_orphan_hold_validation.ts"]
  },
  {
    id: "RM-11",
    invariant: "a never-dispatched identity of a conflicting operation never blocks a rail: the superseding rail retires it (a release is not held for ever behind a capture that never left the process)",
    layer: "beginProviderAttempt conflicting-identity retirement",
    edits: [
      {
        file: "src/payment_attempt_helpers.ts",
        from: `attempt_types: conflicting, reason: `,
        to: `attempt_types: [], reason: `
      }
    ],
    suites: ["review_attempt_lifecycle_crash_race_matrix_validation.ts"]
  },
  {
    id: "RM-12",
    invariant: "reconcile never turns a status read into a verdict on an identity the provider never saw (never-dispatched → live job owns it / operator case / retire; never permanent_fail)",
    layer: "handlePaymentReconcileEvent never-dispatched branch",
    edits: [
      {
        file: "src/app.ts",
        from: `  if (unresolvedRow && unresolvedRow.result_class === "unknown" && unresolvedRow.dispatch_state === "recorded") {`,
        to: `  if (false) {`
      }
    ],
    suites: ["review_attempt_lifecycle_crash_race_matrix_validation.ts"]
  },
  {
    id: "RM-13",
    invariant: "the terminal decision does not defer for ever on an identity already retired as ABANDONED_BEFORE_DISPATCH",
    layer: "applyCompletedDealOutcome F-15 guard predicate",
    edits: [
      {
        file: "src/app.ts",
        from: `               AND NOT (result_class = 'temporary_fail' AND dispatch_state = 'recorded' AND dispatched_at IS NULL)`,
        to: `               AND TRUE`
      }
    ],
    suites: ["review_attempt_lifecycle_crash_race_matrix_validation.ts"]
  },
  // ── R9C ROUND 4 — oracle soundness mutants (test source) ──────────────────
  // OM-1a (round 4: "a status read positioned AFTER a dispatch never counts")
  // is RETIRED in round 5: the E2 scan's provider-order break is subsumed by the
  // observation rule (observedBefore: delivered_seq < D.seq, and an answer is
  // always delivered after it arrives), so removing the break no longer changes
  // any verdict — OM-4 mutates the rule that now carries that invariant.
  {
    id: "OM-1b",
    invariant: "M1: an operator verdict or provider callback recorded AFTER the arm instant never counts as evidence for that dispatch",
    layer: "dispatch_legality E3/E4 arm-instant guard",
    edits: [
      {
        file: "tests/lab/dispatch_legality.ts",
        from: `        if (operatorAt !== null && operatorAt <= armedAt) return { kind: "operator", at: new Date(operatorAt).toISOString() };`,
        to: `        if (operatorAt !== null) return { kind: "operator", at: new Date(operatorAt).toISOString() };`
      },
      {
        file: "tests/lab/dispatch_legality.ts",
        from: `          if (at === null || at >= armedAt) continue;
          if (!CALLBACK_FAILED[target.family].includes(cb.event_type)) continue;`,
        to: `          if (at === null) continue;
          if (!CALLBACK_FAILED[target.family].includes(cb.event_type)) continue;`
      }
    ],
    suites: ["review_oracle_temporal_negative_validation.ts"]
  },
  {
    id: "OM-2",
    invariant: "M2: a late_money_effect note on the previous identity is NOT pre-dispatch failure evidence (the round-3 exemption Codex rejected)",
    layer: "oracle.ts final-note exemption re-introduced",
    edits: [
      {
        file: "tests/lab/oracle.ts",
        from: `      for (const x of legality.violations) v(x.code, pid, x.detail);`,
        to: `      const convergedLate = attempts.some((a) => a.result_class === "success" && String(a.outcome_note || "").startsWith("late_money_effect:"));
      for (const x of legality.violations) if (!(convergedLate && x.code === "AUTOMATIC_REPEAT_WHILE_UNKNOWN")) v(x.code, pid, x.detail);`
      }
    ],
    suites: ["review_oracle_temporal_negative_validation.ts"]
  },
  {
    id: "OM-3",
    invariant: "M3: an UNKNOWN / ambiguous provider answer (5xx, pending) is never read as a declared failure",
    layer: "dispatch_legality isDeclaredFailure",
    edits: [
      {
        file: "tests/lab/dispatch_legality.ts",
        from: `  if (answered === "200-ok-false") return true;`,
        to: `  if (answered === "200-ok-false" || answered === "503" || answered === "200-pending" || answered === "lost") return true;`
      }
    ],
    // round 5: the DB observation clause would mask this mutant in the round-4
    // controls (their rows record the verdict after the arm), so the
    // layer-isolating control L1 (ledger claims an early verdict) kills it.
    suites: ["review_oracle_observation_negative_validation.ts", "review_oracle_temporal_negative_validation.ts"]
  },
  // ── R9C ROUND 5 — observed-evidence mutants (test source) ─────────────────
  // ── R9C ROUND 6 — causal-binding mutants (test source). Each re-introduces one
  // round-5 shortcut; Codex's transport-hold control (T1) and the N-controls
  // kill them. OM-4/5/6 of round 5 are RE-ANCHORED on the round-6 rules (their
  // former anchors — observedBefore / recordedBeforeArm — no longer exist).
  {
    id: "OM-4",
    invariant: "M2: provider creation / write treated as delivery — a status answer counts from the provider's positions instead of Siton's receipt",
    layer: "dispatch_legality receivedSeqOfStatus (Siton receipt vs provider write)",
    edits: [
      {
        file: "tests/lab/dispatch_legality.ts",
        // R9C ROUND 7 — re-anchored on the hardened receivedSeqOfStatus (uniqueness / written / position guards stay; the receipt itself becomes the provider write)
        from: `    const received = obs.statusReceived.get(r.query_id);
    if (typeof received !== "number" || received <= r.seq) return null;
    return received;`,
        to: `    return r.delivered_seq;`
      }
    ],
    suites: ["review_oracle_causal_binding_validation.ts", "review_oracle_observation_negative_validation.ts"]
  },
  {
    id: "OM-5",
    invariant: "M2': an answer Siton never received is usable (a missing receipt reads as received at the start of time)",
    layer: "dispatch_legality receivedSeqOfStatus (unreceived answers)",
    edits: [
      {
        file: "tests/lab/dispatch_legality.ts",
        // R9C ROUND 7 — re-anchored on the hardened receivedSeqOfStatus (a missing receipt reads as position 0)
        from: `    const received = obs.statusReceived.get(r.query_id);
    if (typeof received !== "number" || received <= r.seq) return null;
    return received;`,
        to: `    return obs.statusReceived.get(r.query_id) ?? 0;`
      }
    ],
    suites: ["review_oracle_causal_binding_validation.ts"]
  },
  {
    id: "OM-6",
    invariant: "M1: the response/query causal binding is dropped and the oracle falls back to the identity-level row timestamp (round-5 DB clause) plus the provider's write",
    layer: "dispatch_legality E2 (binding removed → row updated_at <= arm + delivered_seq)",
    edits: [
      {
        file: "tests/lab/dispatch_legality.ts",
        from: `        const received = receivedSeqOfStatus(r);
        if (received === null || received >= sent) continue;             // generated / written, but not observed by Siton before D`,
        to: `        const received = typeof r.delivered_seq === "number" ? r.delivered_seq : null;
        if (received === null || received >= before.seq) continue;`
      },
      {
        file: "tests/lab/dispatch_legality.ts",
        from: `        const verdict = durableNegativeVerdict(target, sent);
        if (!verdict) continue;                                           // observed, but Siton never durably recorded a sourced verdict before D`,
        to: `        const rowAt = ms(rowByIdentity.get(target.identity)?.updated_at ?? null); const armAt = ms(rowByIdentity.get(before.identity)?.dispatched_at ?? null);
        const verdict = (rowAt !== null && armAt !== null && rowAt <= armAt) ? { verdict_seq: 0, source: "row-timestamp" } : durableNegativeVerdict(target, sent);
        if (!verdict) continue;`
      }
    ],
    suites: ["review_oracle_causal_binding_validation.ts"]
  },
  {
    id: "OM-8",
    invariant: "M3: delivery treated as durable recording — a received answer counts without any committed verdict",
    layer: "dispatch_legality E2 durable-verdict requirement",
    edits: [
      {
        file: "tests/lab/dispatch_legality.ts",
        from: `        const verdict = durableNegativeVerdict(target, sent);
        if (!verdict) continue;                                           // observed, but Siton never durably recorded a sourced verdict before D`,
        to: `        const verdict = durableNegativeVerdict(target, sent) ?? { verdict_seq: received, source: "delivery-counts-as-record" };`
      }
    ],
    suites: ["review_oracle_causal_binding_validation.ts"]
  },
  {
    id: "OM-9",
    invariant: "M4: any prior verdict on the same identity authorises the repeat by itself — the post-horizon answer no longer has to be received",
    layer: "dispatch_legality E2 (prior verdict short-circuits the receipt requirement)",
    edits: [
      {
        file: "tests/lab/dispatch_legality.ts",
        from: `        const received = receivedSeqOfStatus(r);
        if (received === null || received >= sent) continue;             // generated / written, but not observed by Siton before D`,
        to: `        const priorVerdict = obs.verdicts.some((v) => v.result_class === "permanent_fail" && v.identities.includes(target.identity) && v.seq < sent);
        const received = priorVerdict ? 0 : receivedSeqOfStatus(r);
        if (received === null || received >= sent) continue;`
      }
    ],
    suites: ["review_oracle_causal_binding_validation.ts"]
  },
  {
    id: "OM-10",
    invariant: "M4': a verdict counts regardless of what Siton received before committing it (source binding removed)",
    layer: "dispatch_legality durableNegativeVerdict source binding",
    edits: [
      {
        file: "tests/lab/dispatch_legality.ts",
        from: `    for (const v of candidates) {`,
        to: `    for (const v of candidates) {
      if (v.seq >= 0) return { verdict_seq: v.seq, source: "unbound" };`
      }
    ],
    suites: ["review_oracle_causal_binding_validation.ts"]
  },
  {
    id: "OM-7",
    invariant: "M4: UNKNOWN treated as failed — a non-final (pending / unknown) status answer is read as declared non-execution",
    layer: "dispatch_legality usableStatus finality + E2 non-final re-open guard",
    edits: [
      {
        file: "tests/lab/dispatch_legality.ts",
        from: `    && r.declared!.final === true && typeof r.declared!.state === "string";`,
        to: `    && typeof r.declared!.state === "string";`
      },
      {
        file: "tests/lab/dispatch_legality.ts",
        // hindsight: a non-final answer no longer re-opens the settlement window and skips the evidence test
        from: `        if (r.op === "status" && r.declared && r.declared.operation === operation && r.declared.delivered && r.declared.final === false) {`,
        to: `        if (false) {`
      }
    ],
    suites: ["review_oracle_observation_negative_validation.ts", "review_oracle_temporal_negative_validation.ts"]
  },
  // ── R9C ROUND 7 — OBSERVER INTEGRITY mutants (Codex round-6 findings A/B/C).
  // Each re-introduces one round-6 observer defect, or removes one round-7
  // guard; all must be killed by the observer integrity suite alone.
  {
    id: "OM-A",
    invariant: "R7-A: query ids are unique across process restarts — a restarted worker with the same WORKER_ID never mints an id it minted before",
    layer: "siton_observer query id (instance UUID dropped: label + counter, as in round 6)",
    edits: [
      {
        file: "tests/lab/siton_observer.ts",
        from: "      const query_id = `${proc}:${instance}:q${++queryCounter}`;",
        to: "      const query_id = `${proc}:q${++queryCounter}`;"
      }
    ],
    suites: ["review_observer_integrity_validation.ts"]
  },
  {
    id: "OM-B",
    invariant: "R7-B: a verdict is published only when its COMMIT succeeded — never at the UPDATE itself",
    layer: "siton_observer pg wrapper (publish inside the transaction instead of staging)",
    edits: [
      {
        file: "tests/lab/siton_observer.ts",
        from: "          if (inTx) for (const v of verdicts) state.staged.push({ ...v, depth });\n          else for (const v of verdicts) await publish(v, job);              // autocommit: durable as soon as it returned",
        to: "          for (const v of verdicts) await publish(v, job);"
      }
    ],
    suites: ["review_observer_integrity_validation.ts"]
  },
  {
    id: "OM-C",
    invariant: "R7-B: a statement that matched no row records no verdict (rowCount is not ignored)",
    layer: "siton_observer settle() row-count guard",
    edits: [
      {
        file: "tests/lab/siton_observer.ts",
        from: "    if (rowCount === 0) { stats.verdicts_discarded.zero_row += 1; return []; }\n    if (rowCount !== 1) { stats.verdicts_discarded.multi_row += 1; return []; }",
        to: "    if (rowCount > 1) { stats.verdicts_discarded.multi_row += 1; return []; }"
      }
    ],
    suites: ["review_observer_integrity_validation.ts"]
  },
  {
    id: "OM-D",
    invariant: "R7-B: a ROLLBACK discards the staged verdicts — nothing is published after a rollback",
    layer: "siton_observer pg wrapper ROLLBACK branch (publishes the stage)",
    edits: [
      {
        file: "tests/lab/siton_observer.ts",
        from: "    } else if (/^(ROLLBACK|ABORT)\\b/i.test(text)) {\n      stats.verdicts_discarded.rollback += state.staged.length;\n      state.tx = false; state.staged = []; state.savepoints = [];",
        to: "    } else if (/^(ROLLBACK|ABORT)\\b/i.test(text)) {\n      const rolled = state.staged;\n      state.tx = false; state.staged = []; state.savepoints = [];\n      onResolved = async (r: any) => { for (const v of rolled) await publish(v, job); return r; };"
      }
    ],
    suites: ["review_observer_integrity_validation.ts"]
  },
  {
    id: "OM-D2",
    invariant: "R7-B: a COMMIT of an aborted transaction (command tag ROLLBACK) publishes nothing — the command tag is checked",
    layer: "siton_observer pg wrapper COMMIT branch (command tag ignored)",
    edits: [
      {
        file: "tests/lab/siton_observer.ts",
        from: "          if (command !== \"COMMIT\") { stats.verdicts_discarded.aborted_commit += staged.length; return r; }   // an aborted transaction answers ROLLBACK",
        to: "          if (command !== \"COMMIT\" && command !== \"ROLLBACK\") { stats.verdicts_discarded.aborted_commit += staged.length; return r; }"
      }
    ],
    suites: ["review_observer_integrity_validation.ts"]
  },
  {
    id: "OM-E",
    invariant: "R7-B: the identity of a verdict is the WHERE-bound correlation_id parameter — never every string parameter (a note is not an identity)",
    layer: "siton_observer settle() identity binding (round-6 parameter guessing)",
    edits: [
      {
        file: "tests/lab/siton_observer.ts",
        from: "      return [{ identities: [identity], result_class: cls, row_count: 1, class_source: \"statement\" }];",
        to: "      return [{ identities: params.filter((p): p is string => typeof p === \"string\" && p !== cls), result_class: cls, row_count: 1, class_source: \"statement\" }];"
      }
    ],
    suites: ["review_observer_integrity_validation.ts"]
  },
  {
    id: "OM-F",
    invariant: "R7-C: a status answer is received only when the app PARSED it — never when the bytes of text() arrived",
    layer: "siton_observer hookBody (receipt at text(), before JSON.parse)",
    edits: [
      {
        file: "tests/lab/siton_observer.ts",
        from: "      const body = await originalText();\n      registerBody(body, onParsed);\n      return body;",
        to: "      const body = await originalText();\n      if (alive) onParsed({ state: \"unknown\" });\n      return body;"
      }
    ],
    suites: ["review_observer_integrity_validation.ts"]
  },
  {
    id: "OM-G",
    invariant: "R7-C: an answer that does not echo THIS query id is not a receipt of it (query_id match enforced)",
    layer: "siton_observer status fetch (echo mismatch ignored)",
    edits: [
      {
        file: "tests/lab/siton_observer.ts",
        from: "      if (res.headers.get(QUERY_ID_HEADER) !== query_id) { stats.receipts_dropped.echo_mismatch += 1; return res; }",
        to: "      if (false) { stats.receipts_dropped.echo_mismatch += 1; return res; }"
      }
    ],
    suites: ["review_observer_integrity_validation.ts"]
  },
  {
    id: "OM-I",
    invariant: "R7-A (oracle): a query id shared by two provider requests binds no receipt (defence in depth against id reuse)",
    layer: "dispatch_legality receivedSeqOfStatus uniqueness guard",
    edits: [
      {
        file: "tests/lab/dispatch_legality.ts",
        from: "    if (!r.query_id || requestsOfQuery.get(r.query_id) !== 1) return null;",
        to: "    if (!r.query_id) return null;"
      }
    ],
    suites: ["review_observer_integrity_validation.ts"]
  },
  {
    id: "OM-J",
    invariant: "R7-A (oracle): a receipt positioned before its query reached the provider binds nothing",
    layer: "dispatch_legality receivedSeqOfStatus position guard",
    edits: [
      {
        file: "tests/lab/dispatch_legality.ts",
        from: "    if (typeof received !== \"number\" || received <= r.seq) return null;",
        to: "    if (typeof received !== \"number\") return null;"
      }
    ],
    suites: ["review_observer_integrity_validation.ts"]
  },
  {
    id: "OM-K",
    invariant: "R7-A (oracle): an answer the provider never wrote can have no receipt",
    layer: "dispatch_legality receivedSeqOfStatus written guard",
    edits: [
      {
        file: "tests/lab/dispatch_legality.ts",
        from: "    if (typeof r.delivered_seq !== \"number\") return null;\n    const received = obs.statusReceived.get(r.query_id);",
        to: "    const received = obs.statusReceived.get(r.query_id);"
      }
    ],
    suites: ["review_observer_integrity_validation.ts"]
  }
];

function normalizeEol(text, eol) {
  return eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text.replace(/\r\n/g, "\n");
}

function gitClean() {
  const status = spawnSync("git", ["status", "--porcelain", "src"], { encoding: "utf8" });
  return String(status.stdout || "").trim() === "";
}

function main() {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const toRun = requested.length ? MUTANTS.filter((m) => requested.includes(m.id)) : MUTANTS;
  if (!toRun.length) throw new Error(`no mutant matched ${JSON.stringify(requested)}`);
  if (!gitClean()) throw new Error("src/ has uncommitted changes; refusing to mutate an unclean tree");

  const report = [];
  for (const mutant of toRun) {
    const originals = new Map();
    try {
      for (const edit of mutant.edits) {
        const current = fs.readFileSync(edit.file, "utf8");
        // R9C ROUND 4 — a mutant may carry several edits on ONE file: the
        // original is the bytes seen BEFORE the first edit, never an
        // intermediate (recording it per edit left the first edit in the tree).
        if (!originals.has(edit.file)) originals.set(edit.file, current);
        const eol = current.includes("\r\n") ? "\r\n" : "\n";
        const from = normalizeEol(edit.from, eol);
        if (!current.includes(from)) {
          // R9C ROUND 6 — a missing anchor on the SECOND edit of a mutant used to
          // abort with the first edit still in the tree; restore every original first.
          for (const [file, original] of originals) fs.writeFileSync(file, original);
          console.error(`  ANCHOR_MISSING ${mutant.id} in ${edit.file} (tree restored)`);
          process.exit(3);
        }
        fs.writeFileSync(edit.file, current.replace(from, () => normalizeEol(edit.to, eol)));
      }
      console.log(`\n[${mutant.id}] ${mutant.layer}\n         invariant: ${mutant.invariant}`);

      const suiteResults = [];
      for (const suite of mutant.suites) {
        const started = Date.now();
        const run = spawnSync(process.execPath, ["scripts/review_ab_driver.cjs", suite], {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          env: process.env
        });
        const out = `${run.stdout || ""}\n${run.stderr || ""}`;
        const compileFailed = /error TS\d+/.test(out) || /TypeScript compilation failed/.test(out);
        // A mutant is KILLED only by a genuine test failure, never by a setup or
        // compile error: that would prove nothing about the invariant.
        const testFailure = /^FAIL /m.test(out) || /failed=[1-9]/.test(out) || /failures=[1-9]/.test(out);
        const killed = testFailure && !compileFailed;
        const firstFailure = (out.match(/^FAIL .*/m) || [""])[0].slice(0, 160);
        suiteResults.push({
          suite,
          killed,
          compile_failed: compileFailed,
          exit: run.status,
          duration_ms: Date.now() - started,
          first_failure: firstFailure || null
        });
        console.log(`  ${killed ? "KILLED " : compileFailed ? "INVALID" : "SURVIVED"} ${suite} (${Date.now() - started}ms)${firstFailure ? `\n            ${firstFailure}` : ""}`);
      }
      report.push({ id: mutant.id, invariant: mutant.invariant, layer: mutant.layer, killed: suiteResults.some((r) => r.killed), suites: suiteResults });
    } finally {
      for (const [file, body] of originals) {
        fs.writeFileSync(file, body);
        if (fs.readFileSync(file, "utf8") !== body) throw new Error(`restore verification failed for ${file}`);
      }
    }
  }

  if (!gitClean()) throw new Error("src/ was not restored to committed bytes after mutation");

  const killed = report.filter((r) => r.killed).length;
  const outDir = path.join(process.cwd(), ".review-artifacts");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "review-mutations.json"), JSON.stringify({ generated_at: new Date().toISOString(), killed, total: report.length, report }, null, 2));
  console.log(`\nREVIEW_MUTATION_PROOF killed=${killed}/${report.length} survived=${report.length - killed}`);
  for (const row of report.filter((r) => !r.killed)) console.log(`  SURVIVED ${row.id}: ${row.invariant}`);
  process.exit(killed === report.length ? 0 : 1);
}

try {
  main();
} catch (error) {
  console.error(`REVIEW_MUTATION_PROOF_ERROR ${error?.message || error}`);
  process.exit(1);
}
