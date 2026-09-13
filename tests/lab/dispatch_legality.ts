// FINANCIAL TORTURE LAB — dispatch-time legality of money-moving operations.
//
// R9C ROUND 4 (oracle soundness). The round-3 oracle judged "a repeat is legal
// only after the previous identity was provider-declared failed" from the FINAL
// database row and then EXEMPTED rows carrying a late_money_effect note. Codex
// showed that is temporal leakage: a note written AFTER a dispatch could
// legalise that dispatch retroactively.
//
// THE INVARIANT
//
//   The legality of a money-moving dispatch is decided ONLY from evidence whose
//   position in the causal order is strictly BEFORE that dispatch. Nothing
//   observed later — a late money effect, a reconciliation verdict, a webhook,
//   an operator case, a later provider status, the final result_class of any
//   row — may convert an unsafe earlier repeat into a legal one.
//
// ORDERING SOURCES (from the actual data model; no invented clocks)
//
//   R9C ROUND 6 — CAUSAL BINDING OF EVIDENCE TO ONE RESPONSE. Codex's final
//   gate showed that round 5 still leaked in two coupled places: it took the
//   provider's WRITE of an answer (delivered_seq) as Siton's observation of it
//   (a transport hop that holds the bytes is invisible to the provider), and
//   it took an attempt-level `resolved_at` earlier than the arm as proof that
//   Siton had recorded THAT answer — although resolved_at is set once, by
//   whatever verdict came first, and is not tied to any particular response.
//   An old verdict from a pre-horizon read therefore "lent" observability to a
//   later, still-undelivered post-horizon read.
//
//     PROVIDER KNOWLEDGE != SITON KNOWLEDGE, and
//     SOME EARLIER VERDICT != A RECORD OF THIS RESPONSE.
//
//   The model now names every arrow of the chain
//     STATUS QUERY Q → PROVIDER RESPONSE R → TRANSPORT DELIVERY OF R TO SITON
//     → SITON RECORDS THE VERDICT IT DREW FROM R → DISPATCH D
//   with facts the lab actually records, all on the SIMULATOR'S SINGLE
//   SEQUENCER (positions, never wall clocks):
//
//     query_id            unique identity of Q, stamped by the Siton-side
//                         observer on the outgoing request and echoed by the
//                         provider into its log entry for R
//     seq / at            provider RECEIVED Q and generated R (provider clock:
//                         positions the dispatch itself and the settlement
//                         horizon, which is about when the PROVIDER may settle)
//     delivered_seq       provider WROTE R back (transport handed R over —
//                         necessary, never sufficient)
//     status_received     the APP PARSED R's body (observer, keyed by query_id):
//                         Siton's observation of R
//     dispatch_sent       the APP is about to send D (observer, keyed by D's
//                         identity): D's own position — every piece of
//                         evidence must be OBSERVED strictly before it
//     dispatch_received   the app parsed the provider's answer to D (used for
//                         exact declines / successes of D itself)
//     verdict_recorded    the app COMMITTED a terminal result_class on an
//                         identity (observer on the pg client, at COMMIT):
//                         Siton's durable record — bound to the response it
//                         was drawn from by process + job (when the lab drove
//                         the job) and by order (received before committed);
//                         only a verdict SOURCED from a received non-executed
//                         answer or a received exact decline counts as
//                         "Siton recorded R"
//
//   `resolved_at` is NOT used for provider-channel evidence any more (it was
//   the floating timestamp Codex rejected). Out-of-channel evidence keeps its
//   own DB order: a callback (webhook_events.received_at, written after
//   authentication) and an operator verdict are compared with the DB arm
//   instant (dispatched_at), DB instant against DB instant.
//
//   Two responses may play two roles for one capture-side repeat, exactly as
//   the production rails work: the DURABLE VERDICT on the prior identity (a
//   reconcile / prior-attempt resolution / exact settle, committed before D was
//   sent, sourced from a received answer) and the POST-HORIZON CONFIRMATION (a
//   final non-executed read received before D was sent — the recovery rail's
//   pre-flight, which records nothing). One response may be both.
//
// WHAT COUNTS AS AUTHORITATIVE NEGATIVE EVIDENCE for identity K (all before D)
//
//   E1 exact-operation decline — a request carrying K itself was answered with
//      a provider-declared failure: a definitive 4xx (not 408/425/429) or a
//      2xx whose body says ok:false. This is the provider-ready contract's
//      definition of a declared outcome; it is read from the provider's log,
//      never from the app's rows. Round 6: the decline counts only once the
//      app RECEIVED it (dispatch_received) and COMMITTED the verdict it drew
//      from it (verdict_recorded), both before the app SENT D (dispatch_sent).
//   E2 status read declaring NON-execution of K's operation, FINAL, correctly
//      referenced, and (round 6) RECEIVED by the app (status_received for its
//      query_id) before the app sent D, together with a durable verdict on K
//      committed before D and causally sourced from a received answer (same
//      process / job, received before committed). For a CAPTURE-SIDE identity it must be taken
//      at or after the SETTLEMENT HORIZON: horizon = (the later of K's
//      dispatch and the provider's last non-final answer about that
//      operation) + the provider's settlement-horizon policy — before it the
//      provider may still settle, so an earlier negative read proves nothing
//      (migration 068, owner decision: recovery, release and the terminal
//      decision wait for the horizon). Refund / release identities carry NO
//      horizon in the production contract (app.ts arms them with
//      settlement_horizon_ms = null), so for them a final non-executed read
//      positioned before the dispatch is the contract's evidence — the
//      residual risk of that contract is recorded as finding F-13, not
//      silently re-legislated here. Only counts when the provider contract
//      declares negative finality authoritative (never for Grow).
//   E3 operator verdict recorded on K's row before the dispatch was armed.
//   E4 provider callback declaring K's operation failed, received before the
//      dispatch was armed.
//
// AMBIGUOUS answers (pending, 5xx, 408/425/429, hang/reset/lost/timeout,
// malformed or truncated bodies, non-final or mis-referenced status reads)
// are NOT evidence in either direction. UNKNOWN is never failed.
//
// WHAT IS JUDGED
//
//   capture-side family (capture + recover share one obligation): every
//     identity after the first needs authoritative negative evidence for the
//     previous capture-side identity → else AUTOMATIC_REPEAT_WHILE_UNKNOWN.
//   refund family / release family: same rule within the family.
//   release: every capture-side identity dispatched before it must carry
//     authoritative negative evidence (a capture that could still succeed, or
//     one declared executed, forbids the release) →
//     RELEASE_AFTER_CAPTURE_DECLARED / RELEASE_WHILE_CAPTURE_UNRESOLVED.
//   refund: if any capture-side identity exists in the provider log, one of
//     them must have been declared EXECUTED before the refund (exact success
//     answer, executed status read, or a captured callback) →
//     else REFUND_WITHOUT_CAPTURE_EVIDENCE.
//
// This module is PURE (no DB, no network) and returns a judgement per dispatch
// naming the exact evidence it relied on, so a test can assert chronology and
// verdict together, and a trace can be read by a human.

export type ProviderRequestLike = {
  seq: number;
  at: string;
  /** R9C ROUND 5 — position at which the provider wrote its answer back (same counter as seq); null/undefined = never delivered */
  delivered_seq?: number | null;
  delivered_at?: string | null;
  /** R9C ROUND 6 — status reads: the unique identity of the query this answer belongs to (matched against status_received observations) */
  query_id?: string | null;
  op: string;                       // capture | recover | refund | release | status | authorize
  authorization: string;
  idempotency_key: string;
  answered: string;
  replayed: boolean;
  behavior: string;
  effect_applied?: boolean;
  /** status reads only: what the provider DECLARED (recorded by the simulator, never inferred here) */
  declared?: { operation: string; state: string | null; final: boolean | null; delivered: boolean; reference_ok: boolean; amount_ok: boolean } | null;
};

export type DispatchRowLike = {
  attempt_type: string;
  correlation_id: string;
  dispatched_at: Date | string | null;
  failure_evidence: string | null;
  updated_at: Date | string | null;
};

/** R9C ROUND 6 — what Siton observed, on the provider's sequencer (see siton_observer.ts) */
export type ObservationLike = {
  seq: number;
  kind: string;                      // status_received | dispatch_sent | dispatch_received | verdict_recorded
  process: string;
  query_id?: string | null;          // status_received: the query the parsed answer belongs to
  op?: string | null;
  key?: string | null;               // dispatch_*: the money identity (idempotency key)
  identities?: string[];             // verdict_recorded: identities the committed statement named
  result_class?: string | null;      // verdict_recorded: the terminal class committed
  job?: string | null;               // outbox job, when the observing process knew it
};

export type CallbackLike = {
  event_type: string;
  correlation_id: string | null;
  provider_reference: string | null;
  received_at: Date | string;
};

export type LegalityPolicy = {
  settlementHorizonMs: number;
  negativeStatusAuthoritative: boolean;
};

export type Family = "capture" | "refund" | "release";

export type EvidenceRef =
  | { kind: "exact_decline"; seq: number; received_seq: number; verdict_seq: number; sent_seq: number; answered: string }
  | { kind: "status_non_executed"; query_id: string; seq: number; delivered_seq: number | null; received_seq: number; sent_seq: number; verdict_seq: number; verdict_source: string; state: string; horizon_from: string; horizon_ms: number }
  | { kind: "operator"; at: string }
  | { kind: "callback_failed"; event_type: string; at: string };

export type PositiveRef =
  | { kind: "exact_success"; seq: number; received_seq: number; sent_seq: number; answered: string }
  | { kind: "status_executed"; query_id: string; seq: number; received_seq: number; sent_seq: number; state: string }
  | { kind: "callback_executed"; event_type: string; at: string };

export type Judgement = {
  family: Family;
  op: string;
  identity: string;
  seq: number;                       // provider position of the dispatch (first request carrying the identity)
  dispatched_at: string | null;      // DB arm instant, when the app recorded one
  previous: string | null;           // previous identity of the family
  evidence: EvidenceRef | null;      // the pre-dispatch negative evidence relied on, if any
  verdict: "legal" | "illegal" | "first";
  code: string | null;
  detail: string | null;
};

export type LegalityReport = { judgements: Judgement[]; violations: Array<{ code: string; detail: string }> };

const FAMILY_OF: Record<string, Family | undefined> = { capture: "capture", recover: "capture", refund: "refund", release: "release" };
const STATUS_OPERATION_OF: Record<Family, string> = { capture: "capture", refund: "refund", release: "release" };
const NON_EXECUTED_STATES: Record<Family, string[]> = {
  capture: ["authorized", "failed"],
  refund: ["captured", "authorized", "failed"],
  release: ["authorized", "captured", "failed"]
};
const EXECUTED_STATES: Record<Family, string[]> = { capture: ["captured", "refunded"], refund: ["refunded"], release: ["released"] };
const CALLBACK_FAILED: Record<Family, string[]> = { capture: ["charge_failed", "recovery_failed"], refund: ["refund_failed"], release: ["release_failed"] };
const CALLBACK_EXECUTED: Record<Family, string[]> = { capture: ["charge_captured", "recovery_captured"], refund: ["refund_issued"], release: ["payment_released"] };

function ms(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/** The provider-ready contract's notion of a DECLARED failure of the exact request. */
export function isDeclaredFailure(answered: string): boolean {
  if (answered === "200-ok-false") return true;
  if (!/^\d{3}$/.test(answered)) return false;
  const code = Number(answered);
  return code >= 400 && code < 500 && code !== 408 && code !== 425 && code !== 429;
}

/** A declared success of the exact request (the app received a 2xx success body in time). */
export function isDeclaredSuccess(answered: string): boolean {
  return answered === "200" || answered === "200-id-only";
}

/** A status read is USABLE evidence only when it was deliverable, final and correctly referenced. */
function usableStatus(r: ProviderRequestLike): r is ProviderRequestLike & { declared: NonNullable<ProviderRequestLike["declared"]> } {
  return r.op === "status" && Boolean(r.declared) && r.declared!.delivered && r.declared!.reference_ok && r.declared!.amount_ok
    && r.declared!.final === true && typeof r.declared!.state === "string";
}

/**
 * R9C ROUND 6 — the observation index: what SITON received / sent / committed,
 * keyed the way the oracle asks about it. Positions live on the provider's
 * sequencer, so "before" is a plain integer comparison.
 */
function indexObservations(observations: ObservationLike[]) {
  const statusReceived = new Map<string, number>();           // query_id → position the app parsed the answer
  const dispatchSent = new Map<string, number>();             // money identity → FIRST position the app sent it
  const dispatchReceived = new Map<string, number>();         // money identity → FIRST position the app parsed its answer
  const jobOfQuery = new Map<string, string | null>();
  const processOfQuery = new Map<string, string>();
  const jobOfDispatch = new Map<string, string | null>();
  const verdicts: Array<{ identities: string[]; result_class: string; seq: number; process: string; job: string | null }> = [];
  for (const o of [...observations].sort((a, b) => a.seq - b.seq)) {
    if (o.kind === "status_received" && o.query_id) {
      if (!statusReceived.has(o.query_id)) { statusReceived.set(o.query_id, o.seq); jobOfQuery.set(o.query_id, o.job ?? null); processOfQuery.set(o.query_id, o.process); }
    } else if (o.kind === "dispatch_sent" && o.key) {
      if (!dispatchSent.has(o.key)) { dispatchSent.set(o.key, o.seq); jobOfDispatch.set(o.key, o.job ?? null); }
    } else if (o.kind === "dispatch_received" && o.key) {
      if (!dispatchReceived.has(o.key)) dispatchReceived.set(o.key, o.seq);
    } else if (o.kind === "verdict_recorded" && Array.isArray(o.identities) && o.result_class) {
      verdicts.push({ identities: o.identities, result_class: o.result_class, seq: o.seq, process: o.process, job: o.job ?? null });
    }
  }
  return { statusReceived, dispatchSent, dispatchReceived, jobOfQuery, processOfQuery, jobOfDispatch, verdicts };
}

export function canonicalReference(reference: string | null | undefined): string | null {
  return reference ? String(reference).replace(/^(cap|rec|ref|rel)-/, "") : null;
}

export function auditDispatchLegality(input: {
  authorization: string;
  requests: ProviderRequestLike[];
  rows: DispatchRowLike[];
  callbacks: CallbackLike[];
  /** R9C ROUND 6 — Siton-side observations on the provider's sequencer (required: without them nothing is observed) */
  observations?: ObservationLike[];
  policy: LegalityPolicy;
}): LegalityReport {
  const obs = indexObservations(input.observations || []);
  const auth = input.authorization;
  const requests = input.requests
    .filter((r) => r.authorization === auth)
    .slice()
    .sort((a, b) => a.seq - b.seq);
  const rowByIdentity = new Map(input.rows.map((r) => [r.correlation_id, r] as const));
  const judgements: Judgement[] = [];
  const violations: Array<{ code: string; detail: string }> = [];

  // ── dispatches: first provider position of every distinct money identity ──
  type Dispatch = { family: Family; op: string; identity: string; seq: number; at: string };
  const firstSeen = new Map<string, Dispatch>();
  for (const r of requests) {
    const family = FAMILY_OF[r.op];
    if (!family) continue;
    const key = `${family}:${r.idempotency_key}`;
    if (!firstSeen.has(key)) firstSeen.set(key, { family, op: r.op, identity: r.idempotency_key, seq: r.seq, at: r.at });
  }
  const dispatches = [...firstSeen.values()].sort((a, b) => a.seq - b.seq);
  const familySeq: Record<Family, Dispatch[]> = { capture: [], refund: [], release: [] };
  for (const d of dispatches) familySeq[d.family].push(d);

  // ── Siton's own position of a dispatch: when the app SENT it ──────────────
  // Unknown (no observer saw the send) means the dispatch cannot be ordered
  // against anything Siton observed: no evidence can be proven prior to it.
  const sentSeq = (d: Dispatch): number | null => obs.dispatchSent.get(d.identity) ?? null;
  const receivedSeqOfStatus = (r: ProviderRequestLike): number | null => (r.query_id ? obs.statusReceived.get(r.query_id) ?? null : null);
  const receivedSeqOfMoney = (identity: string, afterSeq: number): number | null => {
    const at = obs.dispatchReceived.get(identity);
    return typeof at === "number" && at > afterSeq ? at : null;
  };

  // A durable verdict on the identity committed before `beforeSeq`, causally
  // sourced from a RECEIVED answer: the source must be a non-executed final
  // status read about this operation (or an exact decline of the identity
  // itself) that the SAME process — and the same job, when both are known —
  // received before the commit. The newest such verdict wins; an unrelated
  // earlier verdict never speaks for a later response (resolved_at no longer
  // exists here).
  const durableNegativeVerdict = (target: Dispatch, beforeSeq: number): { verdict_seq: number; source: string } | null => {
    const operation = STATUS_OPERATION_OF[target.family];
    const candidates = obs.verdicts
      .filter((v) => v.result_class === "permanent_fail" && v.identities.includes(target.identity) && v.seq < beforeSeq)
      .sort((a, b) => b.seq - a.seq);
    const declineReceived = receivedSeqOfMoney(target.identity, target.seq);
    const declined = requests.some((r) => FAMILY_OF[r.op] === target.family && r.idempotency_key === target.identity && isDeclaredFailure(r.answered));
    for (const v of candidates) {
      // exact decline of the identity itself, received before the commit
      if (declined && declineReceived !== null && declineReceived < v.seq) return { verdict_seq: v.seq, source: "exact_decline:" + target.identity };
      // a non-executed final status read about this operation, received by the same process / job before the commit
      const source = requests
        .filter((r) => usableStatus(r) && r.declared.operation === operation && NON_EXECUTED_STATES[target.family].includes(r.declared.state!) && r.seq > target.seq && Boolean(r.query_id))
        .map((r) => ({ query_id: String(r.query_id), received: receivedSeqOfStatus(r) }))
        .filter((x): x is { query_id: string; received: number } => x.received !== null && x.received < v.seq)
        .filter((x) => obs.processOfQuery.get(x.query_id) === v.process)
        .filter((x) => { const jq = obs.jobOfQuery.get(x.query_id) ?? null; return jq === null || v.job === null || jq === v.job; })
        .sort((a, b) => b.received - a.received)[0];
      if (source) return { verdict_seq: v.seq, source: source.query_id };
    }
    return null;
  };

  // ── evidence about ONE identity, restricted to what Siton had OBSERVED before it sent the dispatch ─
  const negativeEvidenceBefore = (target: Dispatch, before: Dispatch): EvidenceRef | null => {
    const sent = sentSeq(before);
    // provider-channel evidence first (E1, E2 — response-bound); out-of-channel (E3, E4) after
    const outOfChannel = (): EvidenceRef | null => {
      // E3 / E4 — out-of-channel evidence, DB order against the ARM instant of the dispatch
      const armedAt = ms(rowByIdentity.get(before.identity)?.dispatched_at ?? null);
      if (armedAt !== null) {
        const row = rowByIdentity.get(target.identity);
        const operatorAt = row && row.failure_evidence === "operator" ? ms(row.updated_at) : null;
        if (operatorAt !== null && operatorAt <= armedAt) return { kind: "operator", at: new Date(operatorAt).toISOString() };
        for (const cb of input.callbacks) {
          const at = ms(cb.received_at);
          if (at === null || at >= armedAt) continue;
          if (!CALLBACK_FAILED[target.family].includes(cb.event_type)) continue;
          const names = cb.correlation_id ? cb.correlation_id === target.identity : canonicalReference(cb.provider_reference) === auth;
          if (names) return { kind: "callback_failed", event_type: cb.event_type, at: new Date(at).toISOString() };
        }
      }
      return null;
    };
    if (sent === null) return outOfChannel();
    // E1 — exact-operation decline: the provider's answer to the exact request,
    // RECEIVED by the app before it sent D, and the verdict it drew from it
    // COMMITTED before it sent D
    for (const r of requests) {
      if (r.seq >= before.seq) break;
      if (!(FAMILY_OF[r.op] === target.family && r.idempotency_key === target.identity && isDeclaredFailure(r.answered))) continue;
      const received = receivedSeqOfMoney(target.identity, r.seq);
      if (received === null || received >= sent) continue;
      const verdict = obs.verdicts.filter((v) => v.result_class === "permanent_fail" && v.identities.includes(target.identity) && v.seq > received && v.seq < sent).sort((a, b) => a.seq - b.seq)[0];
      if (!verdict) continue;
      return { kind: "exact_decline", seq: r.seq, received_seq: received, verdict_seq: verdict.seq, sent_seq: sent, answered: r.answered };
    }
    // E2 — a final non-executed status read taken at/after the settlement
    // horizon (provider clock), RECEIVED by the app before it sent D, together
    // with a durable verdict on the identity committed before D and sourced
    // from a received answer (the two roles may be the same response)
    if (input.policy.negativeStatusAuthoritative) {
      const operation = STATUS_OPERATION_OF[target.family];
      const horizonMs = target.family === "capture" ? input.policy.settlementHorizonMs : 0;
      let horizonFrom = ms(target.at)!;
      for (const r of requests) {
        if (r.seq >= before.seq) break;
        if (r.seq <= target.seq) continue;
        // any non-final answer about this operation re-opens the settlement window
        if (r.op === "status" && r.declared && r.declared.operation === operation && r.declared.delivered && r.declared.final === false) {
          horizonFrom = Math.max(horizonFrom, ms(r.at)!);
          continue;
        }
        if (FAMILY_OF[r.op] === target.family && r.idempotency_key === target.identity && r.answered === "200-pending") {
          horizonFrom = Math.max(horizonFrom, ms(r.at)!);
          continue;
        }
        if (!(usableStatus(r) && r.declared.operation === operation && NON_EXECUTED_STATES[target.family].includes(r.declared.state!))) continue;
        const readAt = ms(r.at)!;
        if (readAt < horizonFrom + horizonMs) continue;
        const received = receivedSeqOfStatus(r);
        if (received === null || received >= sent) continue;             // generated / written, but not observed by Siton before D
        const verdict = durableNegativeVerdict(target, sent);
        if (!verdict) continue;                                           // observed, but Siton never durably recorded a sourced verdict before D
        return { kind: "status_non_executed", query_id: String(r.query_id), seq: r.seq, delivered_seq: r.delivered_seq ?? null, received_seq: received, sent_seq: sent, verdict_seq: verdict.verdict_seq, verdict_source: verdict.source, state: r.declared.state!, horizon_from: new Date(horizonFrom).toISOString(), horizon_ms: horizonMs };
      }
    }
    return outOfChannel();
  };

  const positiveEvidenceBefore = (target: Dispatch, before: Dispatch): PositiveRef | null => {
    const sent = sentSeq(before);
    if (sent !== null) for (const r of requests) {
      if (r.seq >= before.seq) break;
      if (FAMILY_OF[r.op] === target.family && r.idempotency_key === target.identity && isDeclaredSuccess(r.answered)) {
        const received = receivedSeqOfMoney(target.identity, r.seq);
        if (received !== null && received < sent) return { kind: "exact_success", seq: r.seq, received_seq: received, sent_seq: sent, answered: r.answered };
      }
      if (r.seq > target.seq && usableStatus(r) && r.declared.operation === STATUS_OPERATION_OF[target.family] && EXECUTED_STATES[target.family].includes(r.declared.state!)) {
        const received = receivedSeqOfStatus(r);
        if (received !== null && received < sent) return { kind: "status_executed", query_id: String(r.query_id), seq: r.seq, received_seq: received, sent_seq: sent, state: r.declared.state! };
      }
    }
    const armedAt = ms(rowByIdentity.get(before.identity)?.dispatched_at ?? null);
    if (armedAt !== null) {
      for (const cb of input.callbacks) {
        const at = ms(cb.received_at);
        if (at === null || at >= armedAt) continue;
        if (!CALLBACK_EXECUTED[target.family].includes(cb.event_type)) continue;
        const names = cb.correlation_id ? cb.correlation_id === target.identity : canonicalReference(cb.provider_reference) === auth;
        if (names) return { kind: "callback_executed", event_type: cb.event_type, at: new Date(at).toISOString() };
      }
    }
    return null;
  };

  const armInstant = (d: Dispatch) => {
    const t = ms(rowByIdentity.get(d.identity)?.dispatched_at ?? null);
    return t === null ? null : new Date(t).toISOString();
  };

  // ── rule 1: repeats within a family ───────────────────────────────────────
  for (const family of ["capture", "refund", "release"] as Family[]) {
    const seq = familySeq[family];
    for (let i = 0; i < seq.length; i += 1) {
      const d = seq[i]!;
      if (i === 0) { judgements.push({ family, op: d.op, identity: d.identity, seq: d.seq, dispatched_at: armInstant(d), previous: null, evidence: null, verdict: "first", code: null, detail: null }); continue; }
      const prev = seq[i - 1]!;
      const evidence = negativeEvidenceBefore(prev, d);
      if (evidence) {
        judgements.push({ family, op: d.op, identity: d.identity, seq: d.seq, dispatched_at: armInstant(d), previous: prev.identity, evidence, verdict: "legal", code: null, detail: null });
      } else {
        const detail = `${d.op}: identity ${d.identity} reached the provider at seq ${d.seq} while ${prev.identity} (seq ${prev.seq}) had no authoritative failure evidence before that position`;
        judgements.push({ family, op: d.op, identity: d.identity, seq: d.seq, dispatched_at: armInstant(d), previous: prev.identity, evidence: null, verdict: "illegal", code: "AUTOMATIC_REPEAT_WHILE_UNKNOWN", detail });
        violations.push({ code: "AUTOMATIC_REPEAT_WHILE_UNKNOWN", detail });
      }
    }
  }

  // ── rule 2: a release must not race or contradict any capture-side identity ─
  for (const rel of familySeq.release) {
    for (const cap of familySeq.capture) {
      if (cap.seq >= rel.seq) continue;
      if (positiveEvidenceBefore(cap, rel)) {
        const detail = `release ${rel.identity} (seq ${rel.seq}) dispatched after capture-side ${cap.identity} was declared executed`;
        violations.push({ code: "RELEASE_AFTER_CAPTURE_DECLARED", detail });
        continue;
      }
      if (!negativeEvidenceBefore(cap, rel)) {
        const detail = `release ${rel.identity} (seq ${rel.seq}) dispatched while capture-side ${cap.identity} (seq ${cap.seq}) could still have succeeded (no authoritative failure evidence before the release)`;
        violations.push({ code: "RELEASE_WHILE_CAPTURE_UNRESOLVED", detail });
      }
    }
  }

  // ── rule 3: a refund needs money known to have moved ──────────────────────
  for (const ref of familySeq.refund) {
    const captureSide = familySeq.capture.filter((c) => c.seq < ref.seq);
    if (!captureSide.length) continue; // seeded / out-of-band captures leave no provider request; nothing to order against
    if (!captureSide.some((cap) => positiveEvidenceBefore(cap, ref))) {
      const detail = `refund ${ref.identity} (seq ${ref.seq}) dispatched while no capture-side identity (${captureSide.map((c) => c.identity).join("|")}) had been declared executed`;
      violations.push({ code: "REFUND_WITHOUT_CAPTURE_EVIDENCE", detail });
    }
  }

  return { judgements, violations };
}
