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
//   R9C ROUND 5 — OBSERVED EVIDENCE. Codex (round 4) showed that ordering a
//   provider STATUS answer by the provider's request-log position leaked time
//   in the other direction: `seq`/`at` are assigned when the provider RECEIVES
//   a request and generates its answer, so an answer the provider held for a
//   second was treated as known to Siton a second before Siton could read it,
//   and a capture dispatched inside that hold was judged legal.
//
//     PROVIDER KNOWLEDGE != SITON KNOWLEDGE.
//
//   The causal model therefore distinguishes, per provider interaction:
//     provider_effect_seq   `seq`            the request ARRIVED / the provider acted
//     siton_observed_seq    `delivered_seq`  the provider finished WRITING its
//                                            answer back to the app (same
//                                            monotonic counter; null = never)
//   and, per money identity in Siton's ledger:
//     dispatch_seq / arm    `dispatched_at`  the app ARMED the dispatch (DB
//                                            instant, committed BEFORE I/O, 067)
//     db_commit             `resolved_at`    the app RECORDED the identity's
//                                            terminal verdict (DB instant, set
//                                            once by the 067 trigger)
//
//   * A provider-channel fact (the answer to an exact money request, or a
//     status read) is evidence for dispatch D only when the provider had
//     written it back BEFORE D arrived (`delivered_seq < D.seq`) — an answer
//     that was generated but still held, timed out, truncated, reset or lost
//     is NOT evidence, whatever the provider knew. Provider positions are
//     compared with provider positions only.
//   * When Siton's ledger carries the identity the evidence is about, Siton
//     must additionally have RECORDED that identity's verdict before it armed
//     D (`resolved_at <= D.dispatched_at`, database instant against database
//     instant): a dispatch armed on in-memory knowledge that was persisted
//     only afterwards is legalised by later DB state, which is temporal
//     leakage of the DB kind. A ledger row without a recorded verdict is not
//     evidence. (Rows are consulted only for their timing; result_class and
//     notes are never read.)
//   * Evidence that reaches the app OUTSIDE the provider request channel — a
//     provider callback (siton.webhook_events.received_at, written after
//     authentication) or an operator's recorded verdict
//     (payment_attempts.failure_evidence='operator', updated_at) — is ordered
//     against the arm instant of D. The two clocks (provider counter, DB
//     timestamps) are never compared with each other.
//   * The provider's own `seq`/`at` still position the DISPATCH itself and
//     drive the provider-side settlement horizon (that horizon is about when
//     the PROVIDER may still settle, not about what Siton knows).
//
//   Residual, stated rather than hidden: `delivered_seq` is the instant the
//   provider wrote the answer; the app read it at or after that instant, and
//   sent D at or before D's arrival. A dispatch sent inside that write→arrival
//   window is distinguishable only through the DB clause above, which the
//   real rails always satisfy (they record a verdict before minting the next
//   identity). The lab cannot and does not claim finer precision.
//
// WHAT COUNTS AS AUTHORITATIVE NEGATIVE EVIDENCE for identity K (all before D)
//
//   E1 exact-operation decline — a request carrying K itself was answered with
//      a provider-declared failure: a definitive 4xx (not 408/425/429) or a
//      2xx whose body says ok:false. This is the provider-ready contract's
//      definition of a declared outcome; it is read from the provider's log,
//      never from the app's rows.
//   E2 status read declaring NON-execution of K's operation, FINAL, correctly
//      referenced and delivered. For a CAPTURE-SIDE identity it must be taken
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
  /** R9C ROUND 5 — DB instant at which Siton recorded this identity's terminal verdict (067 trigger; null = none recorded) */
  resolved_at?: Date | string | null;
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
  | { kind: "exact_decline"; seq: number; delivered_seq: number; recorded_at: string | null; answered: string }
  | { kind: "status_non_executed"; seq: number; delivered_seq: number; recorded_at: string | null; state: string; horizon_from: string; horizon_ms: number }
  | { kind: "operator"; at: string }
  | { kind: "callback_failed"; event_type: string; at: string };

export type PositiveRef =
  | { kind: "exact_success"; seq: number; delivered_seq: number; answered: string }
  | { kind: "status_executed"; seq: number; delivered_seq: number; state: string }
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
 * R9C ROUND 5 — the provider-channel observation rule: the provider had
 * WRITTEN this answer back to the app before dispatch D arrived at the
 * provider. An answer never written (null) or written at/after D's arrival was
 * not Siton's knowledge when D was sent, whatever the provider knew.
 */
function observedBefore(r: ProviderRequestLike, dispatchSeq: number): r is ProviderRequestLike & { delivered_seq: number } {
  return typeof r.delivered_seq === "number" && Number.isFinite(r.delivered_seq) && r.delivered_seq < dispatchSeq;
}

export function canonicalReference(reference: string | null | undefined): string | null {
  return reference ? String(reference).replace(/^(cap|rec|ref|rel)-/, "") : null;
}

export function auditDispatchLegality(input: {
  authorization: string;
  requests: ProviderRequestLike[];
  rows: DispatchRowLike[];
  callbacks: CallbackLike[];
  policy: LegalityPolicy;
}): LegalityReport {
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

  // ── evidence about ONE identity, restricted to positions before a dispatch ─
  const negativeEvidenceBefore = (target: Dispatch, before: Dispatch): EvidenceRef | null => {
    // R9C ROUND 5 — a provider-channel verdict about `target` counts only if
    // Siton had also RECORDED it before arming `before` (when the ledger can say).
    const recorded = recordedBeforeArm(target.identity, before);
    const providerEvidenceUsable = recorded !== false;
    // E1 — exact-operation decline: the provider's answer to the exact request,
    // WRITTEN BACK before the dispatch arrived (provider order, delivery position)
    if (providerEvidenceUsable) for (const r of requests) {
      if (r.seq >= before.seq) break;
      if (FAMILY_OF[r.op] === target.family && r.idempotency_key === target.identity && isDeclaredFailure(r.answered) && observedBefore(r, before.seq)) {
        return { kind: "exact_decline", seq: r.seq, delivered_seq: r.delivered_seq, recorded_at: recorded, answered: r.answered };
      }
    }
    // E2 — final non-executed status read, provider order; capture-side targets
    // additionally wait for the settlement horizon (the contract scopes the
    // horizon to charge_start / recovery identities — see the header).
    if (input.policy.negativeStatusAuthoritative && providerEvidenceUsable) {
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
        // the read is evidence only once its answer was WRITTEN BACK before the
        // dispatch arrived (round 5) — the horizon is judged on the provider's
        // answer instant (the provider's settlement window), the observation on
        // the delivery position
        if (usableStatus(r) && observedBefore(r, before.seq) && r.declared.operation === operation && NON_EXECUTED_STATES[target.family].includes(r.declared.state!)) {
          const readAt = ms(r.at)!;
          if (readAt >= horizonFrom + horizonMs) {
            return { kind: "status_non_executed", seq: r.seq, delivered_seq: r.delivered_seq, recorded_at: recorded, state: r.declared.state!, horizon_from: new Date(horizonFrom).toISOString(), horizon_ms: horizonMs };
          }
        }
      }
    }
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

  const positiveEvidenceBefore = (target: Dispatch, before: Dispatch): PositiveRef | null => {
    // round 5: same observation rule — written back before the dispatch arrived,
    // and recorded by Siton before the arm when the ledger can say
    if (recordedBeforeArm(target.identity, before) !== false) for (const r of requests) {
      if (r.seq >= before.seq) break;
      if (!observedBefore(r, before.seq)) continue;
      if (FAMILY_OF[r.op] === target.family && r.idempotency_key === target.identity && isDeclaredSuccess(r.answered)) {
        return { kind: "exact_success", seq: r.seq, delivered_seq: r.delivered_seq, answered: r.answered };
      }
      if (r.seq > target.seq && usableStatus(r) && r.declared.operation === STATUS_OPERATION_OF[target.family] && EXECUTED_STATES[target.family].includes(r.declared.state!)) {
        return { kind: "status_executed", seq: r.seq, delivered_seq: r.delivered_seq, state: r.declared.state! };
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

  // R9C ROUND 5 — the DB observation rule: when Siton's ledger carries the
  // identity the evidence is about AND the arm instant of D, Siton must have
  // recorded that identity's terminal verdict before arming D. Returns the
  // recorded instant, null when the ledger holds no row for the identity (a
  // synthetic history without rows, or an out-of-band identity), and `false`
  // when a row exists but its verdict was recorded after the arm or never.
  const recordedBeforeArm = (targetIdentity: string, before: Dispatch): string | null | false => {
    const target = rowByIdentity.get(targetIdentity);
    const armedAt = ms(rowByIdentity.get(before.identity)?.dispatched_at ?? null);
    if (!target || armedAt === null) return null;
    const recordedAt = ms(target.resolved_at ?? null);
    if (recordedAt === null || recordedAt > armedAt) return false;
    return new Date(recordedAt).toISOString();
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
