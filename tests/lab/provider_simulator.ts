// FINANCIAL TORTURE LAB — programmable synthetic payment provider.
//
// An in-process HTTP server that speaks the provider-ready contract Siton's
// `payrail-http` adapter expects (POST /capture, /recover, /refund, /release,
// GET /status/:reference?operation=). It is DELIBERATELY not the production
// mock: it lives on the test side, owns its own economic ledger and can be
// scripted per (authorization, operation) to misbehave in every way a real
// acquirer can — the money moves BEFORE the answer is written, and the answer
// may be 200, 503, 429, 408, a timeout, a connection reset, a malformed or
// truncated body, or nothing at all.
//
// The ledger counts EXACT economic effects per authorization reference:
// capture_count, recovery_count, refund_count, release_count (+ amounts).
// Production code only ever talks to this object over HTTP; nothing in
// `src/` can reset or rewrite these counters. Every request is also recorded
// (operation, idempotency key, authorization, behaviour, outcome) so the
// oracle can prove "no automatic repeat while the exact operation is UNKNOWN"
// from the provider's point of view, independently of the database.
//
// Synthetic money only. No network beyond 127.0.0.1. No real provider.

import http from "node:http";
import { randomUUID } from "node:crypto";

export type MoneyOp = "capture" | "recover" | "refund" | "release";

export type Behavior =
  | { kind: "SUCCESS" }
  | { kind: "DECLINED" }
  | { kind: "NO_EFFECT_503" }
  | { kind: "EFFECT_THEN_200" }
  | { kind: "EFFECT_THEN_503" }
  | { kind: "EFFECT_THEN_429" }
  | { kind: "EFFECT_THEN_408" }
  | { kind: "EFFECT_THEN_TIMEOUT"; holdMs?: number }
  | { kind: "EFFECT_THEN_CONNECTION_RESET" }
  | { kind: "EFFECT_THEN_MALFORMED_2XX" }
  | { kind: "EFFECT_THEN_TRUNCATED_BODY" }
  | { kind: "EFFECT_THEN_RESPONSE_LOST"; holdMs?: number }
  | { kind: "EFFECT_THEN_OK_FALSE" }
  | { kind: "DELAYED_EFFECT"; delayMs: number }
  | { kind: "LATE_SUCCESS"; delayMs: number }
  | { kind: "HANG_NO_EFFECT"; holdMs?: number }
  | { kind: "PENDING_NO_EFFECT" }
  // Independent review — a 2xx body that carries an id but NO declared outcome
  // ("legacy shape"); the money may (effect:true) or may not have moved.
  | { kind: "ID_ONLY_2XX"; effect: boolean };

type StatusBehaviorKind =
  | { kind: "TRUTH" }
  | { kind: "STALE_AUTHORIZED"; final: boolean }
  | { kind: "PENDING" }
  | { kind: "UNKNOWN" }
  | { kind: "HTTP_500" }
  | { kind: "TIMEOUT"; holdMs?: number }
  | { kind: "MALFORMED" }
  | { kind: "WRONG_REFERENCE" }
  | { kind: "MISSING_REFERENCE" }
  | { kind: "WRONG_AMOUNT"; amount_minor: number }
  | { kind: "FLAP"; states: Array<"authorized" | "captured" | "refunded" | "released" | "failed" | "pending"> }
  // Independent review — additional adversarial status behaviours.
  // WHILE_SETTLING: while an asynchronous settlement (DELAYED_EFFECT / LATE_SUCCESS)
  //   is still pending the provider answers the scripted (wrong) state; once the
  //   money has landed it answers the truth. Stays armed like FLAP. This is the
  //   "status says failed/authorized final while the capture is still settling"
  //   provider that a settlement horizon must defend against.
  | { kind: "WHILE_SETTLING"; state: "failed" | "authorized" | "pending"; final: boolean }
  // WRONG_CURRENCY: truthful state and amount, wrong currency.
  | { kind: "WRONG_CURRENCY"; currency: string }
  // LIE: the provider CLAIMS a money effect that never happened (or denies one
  // that did) — bypasses the honest() downgrade. Consumed per read.
  | { kind: "LIE"; state: "authorized" | "captured" | "refunded" | "released" | "failed"; final?: boolean; amount_minor?: number | null };
// `persist`: the entry stays armed for every read (like FLAP) instead of being
// consumed — a provider that answers the same wrong thing for ever.
export type StatusBehavior = StatusBehaviorKind & { persist?: boolean };

export type EffectCounters = {
  capture: number;
  recover: number;
  refund: number;
  release: number;
  capture_amount_minor: number;
  recover_amount_minor: number;
  refund_amount_minor: number;
};

export type ProviderRequestRecord = {
  seq: number;
  at: string;
  op: MoneyOp | "status" | "authorize";
  authorization: string;
  idempotency_key: string;
  amount_minor: number | null;
  behavior: string;
  effect_applied: boolean;
  replayed: boolean;
  answered: string;
  /**
   * R9C ROUND 4 — status reads only: what the provider DECLARED in that answer,
   * recorded at answer time so the dispatch-legality oracle can order evidence
   * by provider position without inferring anything from the app's rows.
   *   state / final     the declared settled state and its finality
   *   delivered         false when the answer was held past the client timeout
   *   reference_ok      false when the body names another (or no) reference
   *   amount_ok         false when the body carries a foreign amount / currency
   * A read that is not delivered, not final, mis-referenced or mis-amounted is
   * NOT evidence of anything.
   */
  declared?: { operation: string; state: string | null; final: boolean | null; delivered: boolean; reference_ok: boolean; amount_ok: boolean } | null;
  /**
   * R9C ROUND 5 — OBSERVATION position. `seq`/`at` are assigned when the
   * request ARRIVES (the provider's knowledge). `delivered_seq`/`delivered_at`
   * are assigned — from the SAME monotonic counter — at the instant the
   * provider finished WRITING its answer back to the app: the earliest moment
   * Siton could have observed it. `null` = the answer never left the provider
   * (socket destroyed, truncated, lost, held past the client's timeout).
   * PROVIDER KNOWLEDGE != SITON KNOWLEDGE: the dispatch-legality oracle orders
   * provider evidence by delivered_seq, never by seq.
   */
  delivered_seq: number | null;
  delivered_at: string | null;
};

export type ProviderLedgerSnapshot = {
  effects: Record<string, EffectCounters>;
  requests: ProviderRequestRecord[];
  totals: { capture: number; recover: number; refund: number; release: number; capture_amount_minor: number; recover_amount_minor: number; refund_amount_minor: number };
};

export type SimulatorOptions = {
  /** Provider deduplicates a repeated (operation, idempotency-key) natively. Default true (provider-ready contract). */
  nativeIdempotency?: boolean;
  /** Default behaviour when nothing is scripted. */
  defaultBehavior?: Behavior;
  /** Client-side timeout the app is configured with; used to size holds. */
  clientTimeoutMs?: number;
};

function emptyCounters(): EffectCounters {
  return { capture: 0, recover: 0, refund: 0, release: 0, capture_amount_minor: 0, recover_amount_minor: 0, refund_amount_minor: 0 };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function startProviderSimulator(options: SimulatorOptions = {}) {
  const nativeIdempotency = options.nativeIdempotency !== false;
  const defaultBehavior: Behavior = options.defaultBehavior || { kind: "SUCCESS" };
  const clientTimeoutMs = options.clientTimeoutMs || 250;

  // ── private economic truth ────────────────────────────────────────────────
  const effects = new Map<string, EffectCounters>();
  const requests: ProviderRequestRecord[] = [];
  const idempotency = new Map<string, { status: number; body: string | null; behavior: string; effect_applied: boolean }>();
  const scripts = new Map<string, Behavior[]>();          // `${op}:${auth}`
  const statusScripts = new Map<string, StatusBehavior[]>(); // auth
  const flapCursor = new Map<string, number>();
  const declaredFailures = new Set<string>();             // `${op}:${auth}` declined
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const pendingEffects = new Map<string, number>(); // async settlements not yet landed, per auth
  const openSockets = new Set<import("node:net").Socket>();

  function scheduleEffect(op: MoneyOp, auth: string, amountMinor: number | null, delayMs: number) {
    pendingEffects.set(auth, (pendingEffects.get(auth) || 0) + 1);
    const t = setTimeout(() => {
      pendingTimers.delete(t);
      pendingEffects.set(auth, Math.max(0, (pendingEffects.get(auth) || 1) - 1));
      if (!closed) applyEffect(op, auth, amountMinor);
    }, delayMs);
    pendingTimers.add(t);
  }
  let seq = 0;
  let closed = false;

  function counters(auth: string) {
    let row = effects.get(auth);
    if (!row) { row = emptyCounters(); effects.set(auth, row); }
    return row;
  }

  function applyEffect(op: MoneyOp, auth: string, amountMinor: number | null) {
    const row = counters(auth);
    row[op] += 1;
    if (op === "capture") row.capture_amount_minor += Number(amountMinor || 0);
    if (op === "recover") row.recover_amount_minor += Number(amountMinor || 0);
    if (op === "refund") row.refund_amount_minor += Number(amountMinor || 0);
  }

  function truthState(auth: string): "authorized" | "captured" | "refunded" | "released" | "failed" {
    const row = effects.get(auth);
    if (!row) return "authorized";
    if (row.refund > 0) return "refunded";
    if (row.capture + row.recover > 0) return "captured";
    if (row.release > 0) return "released";
    return "authorized";
  }

  function nextBehavior(op: MoneyOp, auth: string): Behavior {
    const queue = scripts.get(`${op}:${auth}`);
    if (queue && queue.length) return queue.shift() as Behavior;
    return defaultBehavior;
  }

  function nextStatusBehavior(auth: string): StatusBehavior {
    const queue = statusScripts.get(auth);
    if (queue && queue.length) {
      const next = queue[0] as StatusBehavior;
      // FLAP / WHILE_SETTLING / persist entries stay armed; everything else is consumed.
      if (next.kind !== "FLAP" && next.kind !== "WHILE_SETTLING" && !next.persist) queue.shift();
      return next;
    }
    return { kind: "TRUTH" };
  }

  function record(entry: Omit<ProviderRequestRecord, "seq" | "at" | "delivered_seq" | "delivered_at">) {
    seq += 1;
    const full: ProviderRequestRecord = { seq, at: new Date().toISOString(), delivered_seq: null, delivered_at: null, ...entry };
    requests.push(full);
    return full;
  }
  // R9C ROUND 5 — the answer is being written back to the app NOW: take the
  // next position of the same counter. A request whose answer is never written
  // (socket destroyed / truncated / lost) keeps delivered_seq = null.
  function deliver(entry: ProviderRequestRecord | null | undefined) {
    if (!entry || entry.delivered_seq !== null) return;
    seq += 1;
    entry.delivered_seq = seq;
    entry.delivered_at = new Date().toISOString();
  }

  function successBody(op: MoneyOp, auth: string, reference: string | undefined) {
    const status = op === "capture" ? "captured" : op === "recover" ? "recovered" : op === "refund" ? "refunded" : "released";
    const idKey = op === "capture" ? "capture_id" : op === "recover" ? "recovery_id" : op === "refund" ? "refund_id" : "authorization_id";
    const ref = `${op.slice(0, 3)}-${auth}`;
    return JSON.stringify({ ok: true, status, [idKey]: ref, provider_reference: ref, reference });
  }

  function statusFor(auth: string, operation: string): { statusCode: number; body: string | null; behavior: string; hold?: number; destroy?: boolean } {
    const behavior = nextStatusBehavior(auth);
    const truth = truthState(auth);
    const row = effects.get(auth) || emptyCounters();
    const amount = operation === "refund" ? row.refund_amount_minor || row.capture_amount_minor : row.capture_amount_minor + row.recover_amount_minor;
    const base = { provider_reference: auth, correlation_id: undefined as string | undefined, amount_minor: amount || null, currency: "ILS", provider_time: new Date().toISOString() };
    const operationState = (): string => {
      if (operation === "refund") return row.refund > 0 ? "refunded" : row.capture + row.recover > 0 ? "captured" : "authorized";
      if (operation === "release") return row.release > 0 ? "released" : row.capture + row.recover > 0 ? "captured" : "authorized";
      return truth;
    };
    // An honest provider with an asynchronous settlement still in progress
    // reports pending / non-final — it never declares "authorized, final".
    const settling = (pendingEffects.get(auth) || 0) > 0;
    // Even a flapping / stale provider never CLAIMS money moved when it did not:
    // a scripted "captured" / "refunded" / "released" without the matching
    // effect is downgraded to the truthful state (the lie direction that no
    // reconciler could defend against is deliberately not simulated here).
    const honest = (state: string): string => {
      if (state === "captured" && row.capture + row.recover === 0) return truth;
      if (state === "refunded" && row.refund === 0) return truth;
      if (state === "released" && row.release === 0) return truth;
      return state;
    };
    switch (behavior.kind) {
      case "TRUTH":
        if (settling) return { statusCode: 200, body: JSON.stringify({ ...base, state: "pending", final: false }), behavior: "TRUTH(pending-settlement)" };
        return { statusCode: 200, body: JSON.stringify({ ...base, state: operationState(), final: true }), behavior: "TRUTH" };
      case "STALE_AUTHORIZED": return { statusCode: 200, body: JSON.stringify({ ...base, state: "authorized", final: behavior.final }), behavior: `STALE_AUTHORIZED(final=${behavior.final})` };
      case "PENDING": return { statusCode: 200, body: JSON.stringify({ ...base, state: "pending", final: false }), behavior: "PENDING" };
      case "UNKNOWN": return { statusCode: 200, body: JSON.stringify({ ...base, state: "unknown", final: false, error_code: "synthetic_unknown" }), behavior: "UNKNOWN" };
      case "HTTP_500": return { statusCode: 500, body: JSON.stringify({ error: "synthetic_status_unavailable" }), behavior: "HTTP_500" };
      case "TIMEOUT": return { statusCode: 200, body: JSON.stringify({ ...base, state: operationState(), final: true }), behavior: "TIMEOUT", hold: behavior.holdMs ?? clientTimeoutMs + 150 };
      case "MALFORMED": return { statusCode: 200, body: "{\"state\":\"capt", behavior: "MALFORMED" };
      case "WRONG_REFERENCE": return { statusCode: 200, body: JSON.stringify({ ...base, provider_reference: `other-${randomUUID().slice(0, 8)}`, state: operationState(), final: true }), behavior: "WRONG_REFERENCE" };
      case "MISSING_REFERENCE": { const b: any = { ...base, state: operationState(), final: true }; delete b.provider_reference; return { statusCode: 200, body: JSON.stringify(b), behavior: "MISSING_REFERENCE" }; }
      case "WRONG_AMOUNT": return { statusCode: 200, body: JSON.stringify({ ...base, amount_minor: behavior.amount_minor, state: operationState(), final: true }), behavior: `WRONG_AMOUNT(${behavior.amount_minor})` };
      case "WHILE_SETTLING": {
        if (settling) return { statusCode: 200, body: JSON.stringify({ ...base, state: behavior.state, final: behavior.final }), behavior: `WHILE_SETTLING(${behavior.state}/${behavior.final ? "final" : "open"})` };
        return { statusCode: 200, body: JSON.stringify({ ...base, state: operationState(), final: true }), behavior: "WHILE_SETTLING(truth)" };
      }
      case "WRONG_CURRENCY": return { statusCode: 200, body: JSON.stringify({ ...base, currency: behavior.currency, state: operationState(), final: true }), behavior: `WRONG_CURRENCY(${behavior.currency})` };
      case "LIE": return { statusCode: 200, body: JSON.stringify({ ...base, ...(behavior.amount_minor !== undefined ? { amount_minor: behavior.amount_minor } : {}), state: behavior.state, final: behavior.final ?? true }), behavior: `LIE(${behavior.state})` };
      case "FLAP": {
        const i = flapCursor.get(auth) || 0;
        flapCursor.set(auth, i + 1);
        const state = honest(behavior.states[i % behavior.states.length] as string);
        return { statusCode: 200, body: JSON.stringify({ ...base, state, final: true }), behavior: `FLAP(${state})` };
      }
    }
  }

  const server = http.createServer((req, res) => {
    const socket = req.socket;
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", async () => {
      try {
        const url = new URL(String(req.url), "http://simulator");
        const raw = chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
        let body: any = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }

        // ── status seam ────────────────────────────────────────────────────
        if (url.pathname.startsWith("/status/")) {
          const reference = decodeURIComponent(url.pathname.slice("/status/".length)).replace(/^(cap|rec|ref|rel)-/, "");
          const operation = url.searchParams.get("operation") || "capture";
          const answer = statusFor(reference, operation);
          // R9C ROUND 4 — record what this answer DECLARES (state, finality) and
          // whether the app could even use it, so the oracle orders status
          // evidence by provider position instead of trusting app rows.
          let declaredBody: any = null;
          try { declaredBody = answer.body ? JSON.parse(answer.body) : null; } catch { declaredBody = null; }
          const truthAmount = (effects.get(reference) || emptyCounters());
          const expectedAmount = operation === "refund" ? (truthAmount.refund_amount_minor || truthAmount.capture_amount_minor) : truthAmount.capture_amount_minor + truthAmount.recover_amount_minor;
          const declared = {
            operation,
            state: declaredBody && typeof declaredBody.state === "string" ? declaredBody.state : null,
            final: declaredBody && typeof declaredBody.final === "boolean" ? declaredBody.final : null,
            delivered: answer.statusCode === 200 && declaredBody !== null && !(answer.hold && answer.hold > clientTimeoutMs),
            reference_ok: Boolean(declaredBody && declaredBody.provider_reference === reference),
            amount_ok: Boolean(declaredBody && (declaredBody.amount_minor === null || declaredBody.amount_minor === undefined || declaredBody.amount_minor === expectedAmount) && (declaredBody.currency === undefined || declaredBody.currency === "ILS"))
          };
          const statusEntry = record({ op: "status", authorization: reference, idempotency_key: String(req.headers["x-request-id"] || ""), amount_minor: null, behavior: `${operation}:${answer.behavior}`, effect_applied: false, replayed: false, answered: String(answer.statusCode), declared });
          if (answer.hold) await sleep(answer.hold);
          if (res.destroyed || socket.destroyed) return;
          res.statusCode = answer.statusCode;
          res.setHeader("content-type", "application/json");
          deliver(statusEntry);
          res.end(answer.body ?? "");
          return;
        }

        // ── authorize (join-time; never money) ─────────────────────────────
        if (url.pathname === "/authorize") {
          const reference = `auth-${randomUUID().slice(0, 12)}`;
          const authorizeEntry = record({ op: "authorize", authorization: reference, idempotency_key: String(req.headers["idempotency-key"] || ""), amount_minor: Number(body.amount_minor) || null, behavior: "SUCCESS", effect_applied: false, replayed: false, answered: "200" });
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          deliver(authorizeEntry);
          res.end(JSON.stringify({ ok: true, authorization_id: reference, provider_reference: reference, reference: body.reference }));
          return;
        }

        const op: MoneyOp | null = url.pathname === "/capture" ? "capture" : url.pathname === "/recover" ? "recover" : url.pathname === "/refund" ? "refund" : url.pathname === "/release" ? "release" : null;
        if (!op) { res.statusCode = 404; res.end(); return; }

        const auth = String(body.authorization_id || body.capture_reference || "").replace(/^(cap|rec|ref|rel)-/, "");
        const key = String(req.headers["idempotency-key"] || "");
        const amountMinor = Number.isInteger(body.amount_minor) ? Number(body.amount_minor) : null;
        const idemKey = `${op}:${key}`;

        // Native idempotency: a repeated identity replays the FIRST answer and
        // never moves money again (this is the provider-ready contract).
        if (nativeIdempotency && key && idempotency.has(idemKey)) {
          const prior = idempotency.get(idemKey)!;
          const replayEntry = record({ op, authorization: auth, idempotency_key: key, amount_minor: amountMinor, behavior: `REPLAY(${prior.behavior})`, effect_applied: false, replayed: true, answered: String(prior.status) });
          res.statusCode = prior.status;
          res.setHeader("content-type", "application/json");
          deliver(replayEntry);
          res.end(prior.body ?? successBody(op, auth, body.reference));
          return;
        }

        // Provider-side state machine (what any real acquirer enforces): a hold
        // that was captured cannot be released, a released hold cannot be
        // captured, and nothing can be refunded that was never captured. Such a
        // request is DECLINED by the provider regardless of the scripted
        // behaviour — unless the script says otherwise explicitly.
        const truthRow = effects.get(auth);
        const scripted = (scripts.get(`${op}:${auth}`) || []).length > 0;
        const impossible = truthRow && !scripted && (
          (op === "release" && truthRow.capture + truthRow.recover > 0) ||
          ((op === "capture" || op === "recover") && truthRow.release > 0) ||
          (op === "refund" && truthRow.capture + truthRow.recover === 0) ||
          (op === "refund" && truthRow.refund > 0)
        );
        const behavior = impossible ? ({ kind: "DECLINED" } as Behavior) : nextBehavior(op, auth);
        const remember = (status: number, respBody: string | null, effectApplied: boolean) => {
          if (nativeIdempotency && key) idempotency.set(idemKey, { status, body: respBody, behavior: behavior.kind, effect_applied: effectApplied });
        };
        let logged: ProviderRequestRecord | null = null;
        const answerJson = (status: number, respBody: string) => {
          if (res.destroyed || socket.destroyed) return;
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          deliver(logged);
          res.end(respBody);
        };
        const effectNow = () => applyEffect(op, auth, amountMinor);
        const log = (effectApplied: boolean, answered: string) =>
          (logged = record({ op, authorization: auth, idempotency_key: key, amount_minor: amountMinor, behavior: behavior.kind, effect_applied: effectApplied, replayed: false, answered }));

        switch (behavior.kind) {
          case "SUCCESS":
          case "EFFECT_THEN_200": {
            effectNow();
            const b = successBody(op, auth, body.reference);
            remember(200, b, true); log(true, "200"); answerJson(200, b); return;
          }
          case "DECLINED": {
            declaredFailures.add(`${op}:${auth}`);
            const b = JSON.stringify({ ok: false, status: op === "capture" ? "charge_failed" : op === "recover" ? "recovery_failed" : "declined", error: "synthetic_declined", provider_reference: auth });
            remember(402, b, false); log(false, "402"); answerJson(402, b); return;
          }
          case "NO_EFFECT_503": {
            const b = JSON.stringify({ error: "synthetic_unavailable_before_effect" });
            remember(503, b, false); log(false, "503"); answerJson(503, b); return;
          }
          case "EFFECT_THEN_503":
          case "EFFECT_THEN_429":
          case "EFFECT_THEN_408": {
            effectNow();
            const code = behavior.kind === "EFFECT_THEN_503" ? 503 : behavior.kind === "EFFECT_THEN_429" ? 429 : 408;
            const b = JSON.stringify({ error: `after_effect_${code}`, provider_reference: auth });
            // A replay of the same key must answer the TRUTH (executed).
            remember(200, successBody(op, auth, body.reference), true); log(true, String(code)); answerJson(code, b); return;
          }
          case "EFFECT_THEN_TIMEOUT": {
            effectNow();
            remember(200, successBody(op, auth, body.reference), true); log(true, "late-200");
            await sleep(behavior.holdMs ?? clientTimeoutMs + 150);
            answerJson(200, successBody(op, auth, body.reference)); return;
          }
          case "EFFECT_THEN_CONNECTION_RESET": {
            effectNow();
            remember(200, successBody(op, auth, body.reference), true); log(true, "reset");
            socket.destroy(); return;
          }
          case "EFFECT_THEN_MALFORMED_2XX": {
            effectNow();
            remember(200, successBody(op, auth, body.reference), true); log(true, "200-malformed");
            if (res.destroyed) return;
            res.statusCode = 200; res.setHeader("content-type", "application/json"); deliver(logged); res.end("<<not json>>"); return;
          }
          case "EFFECT_THEN_TRUNCATED_BODY": {
            effectNow();
            remember(200, successBody(op, auth, body.reference), true); log(true, "200-truncated");
            if (res.destroyed) return;
            const full = successBody(op, auth, body.reference);
            res.statusCode = 200; res.setHeader("content-type", "application/json"); res.setHeader("content-length", String(Buffer.byteLength(full)));
            res.write(full.slice(0, Math.floor(full.length / 2)));
            socket.destroy(); return;
          }
          case "EFFECT_THEN_RESPONSE_LOST": {
            effectNow();
            remember(200, successBody(op, auth, body.reference), true); log(true, "lost");
            await sleep(behavior.holdMs ?? clientTimeoutMs + 400);
            if (!socket.destroyed) socket.destroy(); return;
          }
          case "EFFECT_THEN_OK_FALSE": {
            effectNow();
            const b = JSON.stringify({ ok: false, status: "declined", error: "synthetic_contradiction", provider_reference: auth });
            remember(200, b, true); log(true, "200-ok-false"); answerJson(200, b); return;
          }
          case "DELAYED_EFFECT": {
            scheduleEffect(op, auth, amountMinor, behavior.delayMs);
            const b = JSON.stringify({ ok: true, status: "pending", provider_reference: auth, reference: body.reference });
            remember(200, b, false); log(false, "200-pending"); answerJson(200, b); return;
          }
          case "LATE_SUCCESS": {
            remember(200, successBody(op, auth, body.reference), true); log(true, "late-effect");
            scheduleEffect(op, auth, amountMinor, behavior.delayMs);
            await sleep(behavior.delayMs + 20);
            answerJson(200, successBody(op, auth, body.reference)); return;
          }
          case "HANG_NO_EFFECT": {
            log(false, "hang");
            await sleep(behavior.holdMs ?? clientTimeoutMs + 150);
            if (!socket.destroyed) socket.destroy(); return;
          }
          case "PENDING_NO_EFFECT": {
            const b = JSON.stringify({ ok: true, status: "pending", provider_reference: auth, reference: body.reference });
            remember(200, b, false); log(false, "200-pending"); answerJson(200, b); return;
          }
          case "ID_ONLY_2XX": {
            if (behavior.effect) effectNow();
            const idKey = op === "capture" ? "capture_id" : op === "recover" ? "recovery_id" : op === "refund" ? "refund_id" : "authorization_id";
            const b = JSON.stringify({ ok: true, [idKey]: `${op.slice(0, 3)}-${auth}`, provider_reference: `${op.slice(0, 3)}-${auth}`, reference: body.reference });
            remember(200, behavior.effect ? successBody(op, auth, body.reference) : b, behavior.effect); log(behavior.effect, "200-id-only"); answerJson(200, b); return;
          }
        }
      } catch (error) {
        if (!res.destroyed) { res.statusCode = 500; res.end(JSON.stringify({ error: "simulator_internal", message: String((error as Error)?.message || error) })); }
      }
    });
  });

  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
  });

  const ready = new Promise<string>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { reject(new Error("simulator did not bind")); return; }
      resolve(`http://127.0.0.1:${address.port}`);
    }).once("error", reject);
  });

  return {
    ready,
    /** Script the next answers of one operation for one authorization. */
    script(auth: string, op: MoneyOp, behaviors: Behavior[]) {
      const key = `${op}:${auth}`;
      scripts.set(key, [...(scripts.get(key) || []), ...behaviors]);
    },
    /** Script the next status answers for one authorization (FLAP stays armed). */
    scriptStatus(auth: string, behaviors: StatusBehavior[]) {
      statusScripts.set(auth, [...(statusScripts.get(auth) || []), ...behaviors]);
    },
    clearStatusScript(auth: string) { statusScripts.delete(auth); flapCursor.delete(auth); },
    /** Number of asynchronous settlements still pending for an authorization (review instrument). */
    pendingEffectsOf(auth: string) { return pendingEffects.get(auth) || 0; },
    /** Force the economic truth directly (e.g. an out-of-band capture the app never asked for). */
    forceEffect(op: MoneyOp, auth: string, amountMinor: number | null) { applyEffect(op, auth, amountMinor); },
    effectsOf(auth: string): EffectCounters { return { ...(effects.get(auth) || emptyCounters()) }; },
    moneyEffects(auth: string) { const r = effects.get(auth); return r ? r.capture + r.recover + r.refund + r.release : 0; },
    requestsOf(auth: string, op?: MoneyOp | "status") { return requests.filter((r) => r.authorization === auth && (!op || r.op === op)); },
    distinctKeys(auth: string, op: MoneyOp) { return [...new Set(requests.filter((r) => r.authorization === auth && r.op === op && !r.replayed).map((r) => r.idempotency_key))]; },
    truthState,
    snapshot(): ProviderLedgerSnapshot {
      const out: Record<string, EffectCounters> = {};
      const totals = { capture: 0, recover: 0, refund: 0, release: 0, capture_amount_minor: 0, recover_amount_minor: 0, refund_amount_minor: 0 };
      for (const [auth, row] of effects) {
        out[auth] = { ...row };
        totals.capture += row.capture; totals.recover += row.recover; totals.refund += row.refund; totals.release += row.release;
        totals.capture_amount_minor += row.capture_amount_minor; totals.recover_amount_minor += row.recover_amount_minor; totals.refund_amount_minor += row.refund_amount_minor;
      }
      return { effects: out, requests: requests.map((r) => ({ ...r })), totals };
    },
    async close() {
      closed = true;
      for (const t of pendingTimers) clearTimeout(t);
      for (const s of openSockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

export type ProviderSimulator = ReturnType<typeof startProviderSimulator>;
