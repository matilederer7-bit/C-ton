// BLACK-BOX PAYMENT PROVIDER STUB (R9C production candidate).
//
// A small HTTP provider for the provider-ready rail (PAYMENT_PROVIDER_MODE=
// provider-ready) whose ONLY job is to be a source of externally durable facts:
//
//   * every request that reaches it is logged BEFORE it is answered
//     (op, idempotency key, authorization, amount, position);
//   * money moves the moment the stub applies an effect — whatever the caller
//     sees afterwards (a 503, a dropped socket, a held response) is a separate
//     matter, exactly like a real provider;
//   * the TEST scripts the schedule explicitly (per authorization and
//     operation): declared success / decline, effect-then-transport-failure,
//     effect-then-held-response (released by the test), pending, and the status
//     answers the reconcile / pre-flight seams will read.
//
// Nothing here infers causality, observes the application, or judges legality.
// Assertions are made by the tests from `requests`, `effects` and the database.

import http from "node:http";
import { randomUUID } from "node:crypto";

export type MoneyOp = "capture" | "recover" | "refund" | "release";

export type MoneyBehavior =
  | { kind: "SUCCESS" }
  | { kind: "DECLINE" }
  | { kind: "PENDING" }                                   // 2xx, no declared outcome, no effect
  | { kind: "EFFECT_THEN_HTTP"; status: number }          // money moved, then a 5xx / 429 envelope
  | { kind: "NO_EFFECT_HTTP"; status: number }            // nothing moved, 5xx / 429 envelope
  | { kind: "EFFECT_THEN_DROP" }                          // money moved, socket destroyed before any answer
  | { kind: "EFFECT_THEN_HOLD"; gate: string }            // money moved, the answer waits for release(gate)
  | { kind: "HOLD_THEN_SUCCESS"; gate: string };          // the request waits at the provider's door; the effect lands when released

export type StatusBehavior =
  | { kind: "TRUTH" }                                     // derived from the effects ledger
  | { kind: "ANSWER"; state: string; final: boolean; amount_minor?: number | null; provider_reference?: string; currency?: string }
  | { kind: "MALFORMED" }
  | { kind: "HTTP"; status: number }
  | { kind: "DROP" }
  | { kind: "HOLD"; gate: string };                       // truthful answer, held until release(gate)

export type ProviderRequest = {
  seq: number;
  at: string;
  op: MoneyOp | "status" | "authorize";
  key: string;
  auth: string;
  amount_minor: number | null;
  behavior: string;
  effect_applied: boolean;
  answered: string;
};

export type Effects = { capture: number; recover: number; refund: number; release: number; capture_amount_minor: number; recover_amount_minor: number; refund_amount_minor: number };
const emptyEffects = (): Effects => ({ capture: 0, recover: 0, refund: 0, release: 0, capture_amount_minor: 0, recover_amount_minor: 0, refund_amount_minor: 0 });

export type ProviderStub = Awaited<ReturnType<typeof startProviderStub>>;

export async function startProviderStub(opts: { clientTimeoutMs?: number; nativeIdempotency?: boolean } = {}) {
  const requests: ProviderRequest[] = [];
  // nativeIdempotency: a repeated idempotency key for the same operation is
  // REPLAYED (the standard provider contract the provider-ready rail assumes,
  // same_identity_repeat_safe): no second effect, the first outcome again — a
  // duplicate that arrives while the first request is still in progress waits
  // for that outcome. Default OFF: every request that reaches the stub moves
  // money, the stricter fact.
  const replays = new Map<string, Promise<{ statusCode: number; body: string | null; dropped: boolean }>>();
  const effects = new Map<string, Effects>();
  const moneyScripts = new Map<string, MoneyBehavior[]>();
  const statusScripts = new Map<string, StatusBehavior[]>();
  const gates = new Map<string, { promise: Promise<void>; release: () => void; entered: number; enteredWaiters: Array<() => void> }>();
  let seq = 0;

  const gate = (name: string) => {
    let g = gates.get(name);
    if (!g) {
      let release!: () => void;
      const promise = new Promise<void>((r) => { release = r; });
      g = { promise, release, entered: 0, enteredWaiters: [] };
      gates.set(name, g);
    }
    return g;
  };
  const enter = async (name: string) => {
    const g = gate(name);
    g.entered += 1;
    for (const w of g.enteredWaiters.splice(0)) w();
    await g.promise;
  };
  const effectsOf = (auth: string) => { let e = effects.get(auth); if (!e) { e = emptyEffects(); effects.set(auth, e); } return e; };
  const applyEffect = (auth: string, op: MoneyOp, amount: number) => {
    const e = effectsOf(auth);
    e[op] += 1;
    if (op === "capture") e.capture_amount_minor += amount;
    if (op === "recover") e.recover_amount_minor += amount;
    if (op === "refund") e.refund_amount_minor += amount;
  };
  const nextMoney = (auth: string, op: MoneyOp): MoneyBehavior => {
    const q = moneyScripts.get(`${op}:${auth}`);
    if (q && q.length) return q.shift()!;
    return { kind: "SUCCESS" };
  };
  const nextStatus = (auth: string): StatusBehavior => {
    const q = statusScripts.get(auth);
    if (q && q.length) return q.shift()!;
    return { kind: "TRUTH" };
  };
  const truthState = (auth: string, operation: string): string => {
    const e = effectsOf(auth);
    if (operation === "refund") return e.refund > 0 ? "refunded" : e.capture + e.recover > 0 ? "captured" : "authorized";
    if (operation === "release") return e.release > 0 ? "released" : e.capture + e.recover > 0 ? "captured" : "authorized";
    return e.refund > 0 ? "refunded" : e.capture + e.recover > 0 ? "captured" : e.release > 0 ? "released" : "authorized";
  };
  const declared = (op: MoneyOp, kind: "success" | "declined" | "pending", auth: string, reference: string) => {
    const status = kind === "success" ? (op === "capture" ? "captured" : op === "recover" ? "recovered" : op === "refund" ? "refunded" : "released") : kind === "declined" ? "declined" : "pending";
    return JSON.stringify({ ok: kind !== "declined", status, provider_reference: `${op === "capture" ? "cap" : op === "recover" ? "rec" : op === "refund" ? "ref" : "rel"}-${auth}`, reference, authorization_id: auth });
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", async () => {
      let body: any = {};
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; } catch { body = {}; }
      const url = new URL(String(req.url), "http://stub");
      res.setHeader("content-type", "application/json");
      const answer = (statusCode: number, payload: string | null) => { res.statusCode = statusCode; res.end(payload ?? ""); };
      const record = (entry: Omit<ProviderRequest, "seq" | "at">) => { seq += 1; const full = { seq, at: new Date().toISOString(), ...entry }; requests.push(full); return full; };

      if (url.pathname === "/authorize") {
        const auth = `auth-${randomUUID().slice(0, 12)}`;
        record({ op: "authorize", key: String(req.headers["idempotency-key"] || ""), auth, amount_minor: Number(body.amount_minor) || null, behavior: "SUCCESS", effect_applied: false, answered: "200" });
        answer(200, JSON.stringify({ ok: true, authorization_id: auth, provider_reference: auth, reference: body.reference }));
        return;
      }
      if (url.pathname.startsWith("/status/")) {
        const reference = decodeURIComponent(url.pathname.slice("/status/".length)).replace(/^(cap|rec|ref|rel)-/, "");
        const operation = url.searchParams.get("operation") || "capture";
        const b = nextStatus(reference);
        const entry = record({ op: "status", key: String(req.headers["x-request-id"] || ""), auth: reference, amount_minor: null, behavior: `${operation}:${b.kind}${b.kind === "ANSWER" ? `(${b.state}/${b.final ? "final" : "open"})` : ""}`, effect_applied: false, answered: "" });
        const e = effectsOf(reference);
        const truthAmount = operation === "refund" ? (e.refund_amount_minor || e.capture_amount_minor) : e.capture_amount_minor + e.recover_amount_minor;
        const base = { provider_reference: reference, currency: "ILS", provider_time: new Date().toISOString() };
        if (b.kind === "DROP") { entry.answered = "dropped"; req.socket.destroy(); return; }
        if (b.kind === "HTTP") { entry.answered = String(b.status); answer(b.status, JSON.stringify({ error: "synthetic_status_unavailable" })); return; }
        if (b.kind === "MALFORMED") { entry.answered = "200-malformed"; answer(200, "{\"state\":\"capt"); return; }
        if (b.kind === "ANSWER") {
          entry.answered = `200-${b.state}`;
          answer(200, JSON.stringify({ ...base, ...(b.provider_reference ? { provider_reference: b.provider_reference } : {}), ...(b.currency ? { currency: b.currency } : {}), amount_minor: b.amount_minor === undefined ? (truthAmount || null) : b.amount_minor, state: b.state, final: b.final }));
          return;
        }
        if (b.kind === "HOLD") await enter(b.gate);
        const state = truthState(reference, operation);
        entry.answered = `200-${state}`;
        answer(200, JSON.stringify({ ...base, amount_minor: truthAmount || null, state, final: true }));
        return;
      }
      const op: MoneyOp | null = url.pathname === "/capture" ? "capture" : url.pathname === "/recover" ? "recover" : url.pathname === "/refund" ? "refund" : url.pathname === "/release" ? "release" : null;
      if (!op) { answer(404, JSON.stringify({ error: "not_found" })); return; }
      const auth = String(body.authorization_id || body.capture_reference || "").replace(/^(cap|rec|ref|rel)-/, "");
      const amount = Number(body.amount_minor) || 0;
      const key = String(req.headers["idempotency-key"] || "");
      const replayKey = `${op}:${auth}:${key}`;
      if (opts.nativeIdempotency && key && replays.has(replayKey)) {
        const entry = record({ op, key, auth, amount_minor: amount, behavior: "REPLAY", effect_applied: false, answered: "" });
        const first = await replays.get(replayKey)!;
        entry.answered = first.dropped ? "replay-of-dropped" : `replay-${first.statusCode}`;
        if (res.destroyed || req.socket.destroyed) return;
        if (first.dropped) { req.socket.destroy(); return; }
        answer(first.statusCode, first.body);
        return;
      }
      const b = nextMoney(auth, op);
      const entry = record({ op, key, auth, amount_minor: amount, behavior: b.kind, effect_applied: false, answered: "" });
      const reference = String(body.reference || key);
      const applied = () => { applyEffect(auth, op, amount); entry.effect_applied = true; };
      let settleOutcome: (o: { statusCode: number; body: string | null; dropped: boolean }) => void = () => undefined;
      if (opts.nativeIdempotency && key) replays.set(replayKey, new Promise((r) => { settleOutcome = r; }));
      const reply = (statusCode: number, payload: string | null) => { settleOutcome({ statusCode, body: payload, dropped: false }); if (res.destroyed || req.socket.destroyed) return; answer(statusCode, payload); };
      const drop = () => { settleOutcome({ statusCode: 0, body: null, dropped: true }); req.socket.destroy(); };
      switch (b.kind) {
        case "SUCCESS": applied(); entry.answered = "200"; reply(200, declared(op, "success", auth, reference)); return;
        case "DECLINE": entry.answered = "200-declined"; reply(200, declared(op, "declined", auth, reference)); return;
        case "PENDING": entry.answered = "200-pending"; reply(200, declared(op, "pending", auth, reference)); return;
        case "EFFECT_THEN_HTTP": applied(); entry.answered = String(b.status); reply(b.status, JSON.stringify({ error: "synthetic_gateway_failure" })); return;
        case "NO_EFFECT_HTTP": entry.answered = String(b.status); reply(b.status, JSON.stringify({ error: "synthetic_gateway_failure" })); return;
        case "EFFECT_THEN_DROP": applied(); entry.answered = "dropped"; drop(); return;
        case "EFFECT_THEN_HOLD": applied(); await enter(b.gate); entry.answered = (res.destroyed || req.socket.destroyed) ? "held-then-lost" : "200-after-hold"; reply(200, declared(op, "success", auth, reference)); return;
        case "HOLD_THEN_SUCCESS": await enter(b.gate); applied(); entry.answered = (res.destroyed || req.socket.destroyed) ? "held-then-lost" : "200-after-hold"; reply(200, declared(op, "success", auth, reference)); return;
      }
    });
  });
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (s) => { sockets.add(s); s.once("close", () => sockets.delete(s)); });
  const base = await new Promise<string>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => { const a = server.address(); if (!a || typeof a === "string") reject(new Error("stub did not bind")); else resolve(`http://127.0.0.1:${a.port}`); }).once("error", reject);
  });

  return {
    base,
    clientTimeoutMs: opts.clientTimeoutMs ?? 4000,
    /** script the next money answers of one operation for one authorization (unscripted = declared SUCCESS) */
    script(auth: string, op: MoneyOp, behaviors: MoneyBehavior[]) { const k = `${op}:${auth}`; moneyScripts.set(k, [...(moneyScripts.get(k) || []), ...behaviors]); },
    /** script the next status answers for one authorization (unscripted = TRUTH from the effects ledger) */
    scriptStatus(auth: string, behaviors: StatusBehavior[]) { statusScripts.set(auth, [...(statusScripts.get(auth) || []), ...behaviors]); },
    /** a money effect that really happened outside this stub's HTTP path (a settlement the provider applied on its own) */
    forceEffect(op: MoneyOp, auth: string, amount: number) { applyEffect(auth, op, amount); },
    /** wait until N requests are parked at `gate`, then release them all */
    async waitEntered(name: string, count = 1, timeoutMs = 5000) {
      const g = gate(name);
      const end = Date.now() + timeoutMs;
      while (g.entered < count) {
        if (Date.now() > end) throw new Error(`gate ${name}: ${g.entered}/${count} entered before timeout`);
        await new Promise<void>((r) => { const t = setTimeout(r, 25); g.enteredWaiters.push(() => { clearTimeout(t); r(); }); });
      }
    },
    release(name: string) { gate(name).release(); },
    entered(name: string) { return gate(name).entered; },
    // ── facts ────────────────────────────────────────────────────────────
    requests: () => requests.map((r) => ({ ...r })),
    requestsOf(auth: string, op?: ProviderRequest["op"]) { return requests.filter((r) => r.auth === auth && (!op || r.op === op)).map((r) => ({ ...r })); },
    moneyRequestsOf(auth: string) { return requests.filter((r) => r.auth === auth && r.op !== "status" && r.op !== "authorize").map((r) => ({ ...r })); },
    effectsOf(auth: string): Effects { return { ...effectsOf(auth) }; },
    totals() { const t = emptyEffects(); for (const e of effects.values()) { t.capture += e.capture; t.recover += e.recover; t.refund += e.refund; t.release += e.release; } return t; },
    async close() { for (const g of gates.values()) g.release(); for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); }
  };
}
