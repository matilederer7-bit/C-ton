// FINANCIAL TORTURE LAB — the SITON-SIDE observer (R9C ROUND 6, hardened in
// ROUND 7).
//
// Codex (round 5 final gate) showed that positioning a provider answer by the
// provider's own write (`delivered_seq`) still leaks time: an answer the
// provider has written but a transport hop has not yet handed to the app is
// not the app's knowledge, and an attempt-level `resolved_at` written for an
// EARLIER, unrelated response must not lend observability to it.
//
// Codex (round 6 re-review) then showed that the round-6 observer itself could
// lie in three ways: a restarted process minted the same query id again
// (`WORKER_ID:q1`), a verdict was reported for a statement that changed
// nothing / was rolled back / named a note parameter as an identity, and the
// receipt of a status answer was stamped when the bytes arrived rather than
// when the app had parsed them. This module now honours the OBSERVER
// CONTRACT below; tests/review_observer_integrity_validation.ts (O1–O14) is
// its independent proof and kills the observer mutants OM-A..OM-G.
//
// ── OBSERVER CONTRACT (round 7) ─────────────────────────────────────────────
//
//   QUERY_ID          `<process>:<instance>:q<n>` where <instance> is a UUID
//                     minted when THIS observer incarnation is installed and
//                     <n> a per-incarnation monotonic counter. Globally unique
//                     across process lifetime, restart, worker identity and
//                     concurrency: no two queries — ever, anywhere — share an
//                     id. The provider echoes it (`x-siton-lab-query-id`) so
//                     that ONE answer names ONE query.
//
//   STATUS_RECEIVED   recorded ONLY when (1) the answer's echoed query id is the
//                     id of the query this response object was obtained for
//                     and the envelope is 2xx, (2) the app has PARSED the body
//                     — the observer hooks JSON.parse and recognises the exact
//                     body string it handed to the app from `text()` (`json()`
//                     is text() + JSON.parse here) — and the parse SUCCEEDED,
//                     and (3) the parsed value has the provider's status shape
//                     (a JSON object carrying a string `state`). A parse
//                     failure, a structurally invalid answer, a non-2xx
//                     envelope, a missing / mismatching echo, a body the app
//                     never parsed, or a body handed over by a dead
//                     (uninstalled) incarnation records NOTHING. The receipt is
//                     positioned inside the app's own parse, before the parsed
//                     value is returned to it. One body → at most one receipt;
//                     parsing it again records nothing more.
//
//   DISPATCH_SENT     recorded (and positioned) BEFORE a money request's bytes
//                     leave the process; DISPATCH_RECEIVED when the app parsed
//                     its answer into a JSON object (same parse rule, no echo).
//
//   VERDICT_RECORDED  recorded ONLY for a statement that (1) is a recognised
//                     terminal write — `UPDATE siton.payment_attempts` whose
//                     SET clause assigns `result_class` success / permanent_fail
//                     and whose WHERE clause binds `correlation_id = $n` once
//                     (the identity is THAT parameter; every other parameter —
//                     notes, references, owner uuids — is ignored), or that
//                     carries `RETURNING correlation_id` (identities are the
//                     returned rows) —, (2) actually matched the intended
//                     attempt (`rowCount` exactly 1 for a keyed write, ≥ 1 rows
//                     for RETURNING; 0 rows records nothing), and (3) became
//                     DURABLE: inside a transaction the verdict is STAGED and
//                     published only when the COMMIT statement resolved with
//                     command tag `COMMIT` (a COMMIT of an aborted transaction
//                     answers `ROLLBACK` and publishes nothing; a rejected
//                     COMMIT, a ROLLBACK, or a ROLLBACK TO a savepoint
//                     established before the write discards the stage);
//                     outside a transaction (autocommit) it is published when
//                     the statement resolved with the row count above. The
//                     published class is the class the row durably holds:
//                     taken from the statement when it assigns a parameter or
//                     literal, and READ BACK from the row (locked by the same
//                     transaction) when the statement computes it (CASE … END).
//                     Nothing is guessed from parameter values.
//
// Positions are minted by the provider simulator's single sequencer (so
// provider events and Siton events share ONE order — no wall clocks) and every
// emission of one incarnation is serialised in call order, so a receipt
// recorded inside JSON.parse is positioned before anything the app does next.
//
// Installed in-process by the lab runtime (bootLab) before the app is loaded,
// and by `siton_observer_preload.ts` inside real worker processes (positions
// then come over HTTP from the simulator's /lab/observe seam). It touches no
// production source: it wraps `globalThis.fetch`, `JSON.parse` and
// `pg.Client.prototype.query`.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import pg from "pg";

export type ObserveInput = {
  kind: "status_received" | "dispatch_sent" | "dispatch_received" | "verdict_recorded";
  process: string;
  /** observer incarnation that recorded the event (UUID minted at install) */
  instance?: string | null;
  query_id?: string | null;
  op?: string | null;
  key?: string | null;
  identities?: string[];
  result_class?: string | null;
  /** verdict_recorded: rows the committed statement matched (never 0) */
  row_count?: number | null;
  /** verdict_recorded: where the published class came from */
  class_source?: "statement" | "returning" | "row_readback" | null;
  job?: string | null;
};
export type ObserveFn = (entry: ObserveInput) => Promise<{ seq: number }> | { seq: number };

/** the outbox job the current async chain belongs to (set by the lab when it drives a job in-process) */
export const jobContext = new AsyncLocalStorage<{ job: string }>();
export function runInJob<T>(job: string, fn: () => Promise<T>): Promise<T> {
  return jobContext.run({ job }, fn);
}
export function currentJob(): string | null {
  return jobContext.getStore()?.job ?? null;
}

export const QUERY_ID_HEADER = "x-siton-lab-query-id";
const TERMINAL = new Set(["success", "permanent_fail"]);
const MONEY_PATHS: Record<string, string> = { "/capture": "capture", "/recover": "recover", "/refund": "refund", "/release": "release" };
const MAX_PENDING_BODIES = 1024;
/** a body handed to the app but not parsed within this window was never acted on by it */
const PENDING_BODY_TTL_MS = 10_000;

export type ObserverStats = {
  instance: string;
  queries: number;
  receipts: number;
  receipts_dropped: { echo_mismatch: number; http_error: number; parse_failed: number; shape_rejected: number; dead_instance: number; unparsed_evicted: number };
  verdicts: number;
  verdicts_discarded: { zero_row: number; multi_row: number; rollback: number; savepoint_rollback: number; aborted_commit: number; commit_failed: number; dead_instance: number; unreadable_class: number };
  /** statements assigning a terminal (or unresolvable) result_class on siton.payment_attempts whose shape binds no identity — a lab alarm, never a verdict */
  terminal_writes_unrecognised: number;
};

export type ObserverHandle = {
  instance: string;
  uninstall: () => void;
  stats: () => ObserverStats;
  /** resolves once every emission requested so far has reached the sequencer */
  drain: () => Promise<void>;
};

// ── terminal-write shape ─────────────────────────────────────────────────────
/** the expression a statement assigns to result_class */
export type ClassExpr = { kind: "param"; index: number } | { kind: "literal"; value: string } | { kind: "case_floor"; index: number };
export type PaymentAttemptWriteShape =
  | { kind: "keyed"; class: ClassExpr; identity_param: number; key_params: Record<string, number> }
  | { kind: "returning"; class: ClassExpr; returns_class: boolean };

const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, " ");

function splitUpdate(sqlText: string): { set: string; where: string; returning: string | null } | null {
  const sql = stripComments(String(sqlText || "")).trim();
  if (!/^UPDATE\s+siton\.payment_attempts\b/i.test(sql)) return null;
  const parts = sql.match(/\bSET\b([\s\S]*?)(?:\bWHERE\b([\s\S]*?))?(?:\bRETURNING\b([\s\S]*))?$/i);
  if (!parts) return null;
  return { set: parts[1] || "", where: parts[2] || "", returning: parts[3] ?? null };
}

/** the assignment TARGET result_class in a SET clause (`SET result_class=…` / `, result_class=…`) — never a WHERE test or a CASE branch */
function assignedClassExpr(setClause: string): ClassExpr | "unresolvable" | null {
  const target = setClause.match(/(?:^|,)\s*result_class\s*=\s*([\s\S]*)$/i);
  if (!target) return null;
  const expr = target[1]!;
  const param = expr.match(/^\$(\d+)\s*(?:,|$)/);
  if (param) return { kind: "param", index: Number(param[1]) };
  const literal = expr.match(/^'([a-z_]+)'\s*(?:,|$)/i);
  if (literal) return { kind: "literal", value: literal[1]!.toLowerCase() };
  const computed = expr.match(/^CASE\b[\s\S]*?\bELSE\s+\$(\d+)\s+END\s*(?:,|$)/i);
  if (computed) return { kind: "case_floor", index: Number(computed[1]) };
  return "unresolvable";
}

/**
 * Classify an `UPDATE siton.payment_attempts` statement: which parameter (or
 * RETURNING column) names the attempt it writes, and what it assigns to
 * result_class. Exact SQL shape only — never a guess from parameter values.
 * Returns null for statements that do not assign result_class or whose shape
 * cannot bind ONE identity.
 */
export function classifyPaymentAttemptWrite(sqlText: string): PaymentAttemptWriteShape | null {
  const parts = splitUpdate(sqlText);
  if (!parts) return null;
  const classExpr = assignedClassExpr(parts.set);
  if (!classExpr || classExpr === "unresolvable") return null;
  if (parts.returning !== null) {
    const columns = parts.returning.split(",").map((c) => c.trim().toLowerCase());
    if (!columns.some((c) => c === "correlation_id" || c.endsWith(".correlation_id") || c === "*")) return null;
    return { kind: "returning", class: classExpr, returns_class: columns.some((c) => c === "result_class" || c.endsWith(".result_class") || c === "*") };
  }
  const bindings = [...parts.where.matchAll(/\bcorrelation_id\s*=\s*\$(\d+)/gi)];
  if (bindings.length !== 1) return null;
  if (/\bcorrelation_id\s*(?:IN\b|=\s*ANY\b|<>|!=)/i.test(parts.where)) return null;
  const key_params: Record<string, number> = { correlation_id: Number(bindings[0]![1]) };
  for (const column of ["participant_id", "deal_id", "attempt_type"]) {
    const m = parts.where.match(new RegExp(`\\b${column}\\s*=\\s*\\$(\\d+)`, "i"));
    if (m) key_params[column] = Number(m[1]);
  }
  return { kind: "keyed", class: classExpr, identity_param: key_params.correlation_id!, key_params };
}

/** true when the statement assigns result_class (terminal, or in a way the observer cannot resolve) but classify() binds no identity — the lab must know */
export function isUnboundTerminalWrite(sqlText: string, params: unknown[]): boolean {
  const parts = splitUpdate(sqlText);
  if (!parts) return false;
  const expr = assignedClassExpr(parts.set);
  if (!expr) return false;
  if (classifyPaymentAttemptWrite(sqlText)) return false;
  if (expr === "unresolvable") return true;
  const value = expr.kind === "literal" ? expr.value : params[expr.index - 1];
  return typeof value !== "string" || TERMINAL.has(value);
}

/** the shape of a provider STATUS answer the app can act on */
export function isAcceptedStatusShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.state !== "string") return false;
  if (v.final !== undefined && typeof v.final !== "boolean") return false;
  return true;
}

let installed: ObserverHandle | null = null;

export function installSitonObserver(opts: { providerBaseUrl: string; observe: ObserveFn; process: string }): ObserverHandle {
  if (installed) return installed;
  const base = opts.providerBaseUrl.replace(/\/+$/, "");
  const proc = opts.process;
  const instance = randomUUID();
  let alive = true;
  let queryCounter = 0;
  const stats: ObserverStats = {
    instance, queries: 0, receipts: 0,
    receipts_dropped: { echo_mismatch: 0, http_error: 0, parse_failed: 0, shape_rejected: 0, dead_instance: 0, unparsed_evicted: 0 },
    verdicts: 0,
    verdicts_discarded: { zero_row: 0, multi_row: 0, rollback: 0, savepoint_rollback: 0, aborted_commit: 0, commit_failed: 0, dead_instance: 0, unreadable_class: 0 },
    terminal_writes_unrecognised: 0
  };

  // ── serialised emission: one incarnation's events reach the sequencer in call order ──
  let chain: Promise<unknown> = Promise.resolve();
  const observe = (entry: Omit<ObserveInput, "process" | "instance">): Promise<void> => {
    const job = entry.job ?? currentJob();
    const next = chain.then(async () => {
      if (!alive) return;                                                   // a dead incarnation records nothing
      await opts.observe({ ...entry, process: proc, instance, job });
    });
    chain = next.catch(() => undefined);
    return next;
  };

  // ── answers: an event only inside the app's own successful parse of the body ─
  const realFetch = globalThis.fetch.bind(globalThis);
  const realParse = JSON.parse;
  type PendingBody = { body: string; registered_at: number; onParsed: (value: unknown) => void };
  const pending: PendingBody[] = [];
  const registerBody = (body: string, onParsed: (value: unknown) => void) => {
    if (!alive) { stats.receipts_dropped.dead_instance += 1; return; }
    pending.push({ body, registered_at: Date.now(), onParsed });
    while (pending.length > MAX_PENDING_BODIES) { pending.shift(); stats.receipts_dropped.unparsed_evicted += 1; }
  };
  const takeBody = (text: string): PendingBody | null => {
    const now = Date.now();
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      if (now - pending[i]!.registered_at > PENDING_BODY_TTL_MS) { pending.splice(i, 1); stats.receipts_dropped.unparsed_evicted += 1; }
    }
    const index = pending.findIndex((p) => p.body === text);               // oldest registration of this exact body
    if (index < 0) return null;
    return pending.splice(index, 1)[0]!;
  };
  const hookedParse = function (this: unknown, text: unknown, reviver?: (this: any, key: string, value: any) => any) {
    const record = typeof text === "string" && pending.length ? takeBody(text) : null;
    if (!record) return realParse.call(JSON, text as string, reviver);
    let value: unknown;
    try {
      value = realParse.call(JSON, text as string, reviver);
    } catch (error) {
      stats.receipts_dropped.parse_failed += 1;                             // the app cannot act on this body
      throw error;
    }
    if (!alive) { stats.receipts_dropped.dead_instance += 1; return value; }
    record.onParsed(value);                                                 // positioned now, before the value reaches the app
    return value;
  };
  JSON.parse = hookedParse as typeof JSON.parse;

  /** the body hooks of ONE response: text() registers the exact string handed to the app; json() is text() + JSON.parse */
  function hookBody(res: Response, onParsed: (value: unknown) => void): Response {
    const originalText = res.text.bind(res);
    (res as any).text = async () => {
      const body = await originalText();
      registerBody(body, onParsed);
      return body;
    };
    (res as any).json = async () => JSON.parse(await res.text());
    return res;
  }

  const wrappedFetch: typeof fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url || "");
    if (!url.startsWith(base)) return realFetch(input, init);
    const path = new URL(url).pathname;
    if (path.startsWith("/status/")) {
      const query_id = `${proc}:${instance}:q${++queryCounter}`;
      stats.queries += 1;
      const headers = new Headers(init?.headers || (typeof input === "object" && input && "headers" in input ? (input as Request).headers : undefined));
      headers.set(QUERY_ID_HEADER, query_id);
      const res = await realFetch(input, { ...init, headers });
      // the answer must NAME the query it answers: no echo / another id → not evidence
      if (res.headers.get(QUERY_ID_HEADER) !== query_id) { stats.receipts_dropped.echo_mismatch += 1; return res; }
      if (!res.ok) { stats.receipts_dropped.http_error += 1; return res; }
      return hookBody(res, (value) => {
        if (!isAcceptedStatusShape(value)) { stats.receipts_dropped.shape_rejected += 1; return; }
        stats.receipts += 1;
        void observe({ kind: "status_received", query_id }).catch(() => undefined);
      });
    }
    const op = MONEY_PATHS[path];
    if (op) {
      const headers = new Headers(init?.headers || undefined);
      const key = String(headers.get("idempotency-key") || "");
      // BEFORE the bytes leave the process: the dispatch's own position
      await observe({ kind: "dispatch_sent", op, key });
      const res = await realFetch(input, init);
      return hookBody(res, (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        void observe({ kind: "dispatch_received", op, key }).catch(() => undefined);
      });
    }
    return realFetch(input, init);
  };
  globalThis.fetch = wrappedFetch as typeof fetch;

  // ── pg client wrapper: durable verdicts, published at a real COMMIT ─────────
  type Verdict = { identities: string[]; result_class: string; row_count: number; class_source: NonNullable<ObserveInput["class_source"]> };
  type Staged = Verdict & { depth: number };
  type ClientState = { tx: boolean; staged: Staged[]; savepoints: string[] };
  const states = new WeakMap<object, ClientState>();
  const stateOf = (client: object): ClientState => {
    let s = states.get(client);
    if (!s) { s = { tx: false, staged: [], savepoints: [] }; states.set(client, s); }
    return s;
  };
  const proto = (pg as any).Client.prototype;
  const originalQuery = proto.query;

  const classOf = (expr: ClassExpr, params: unknown[]): string | null => {
    if (expr.kind === "literal") return expr.value;
    const value = params[expr.index - 1];
    return typeof value === "string" ? value : null;
  };
  const publish = async (v: Verdict, job: string | null) => {
    if (!alive) { stats.verdicts_discarded.dead_instance += 1; return; }
    stats.verdicts += 1;
    await observe({ kind: "verdict_recorded", identities: v.identities, result_class: v.result_class, row_count: v.row_count, class_source: v.class_source, job });
  };
  /** the verdict(s) a resolved terminal statement made (none: the reason is counted in stats) */
  const settle = async (client: any, shape: PaymentAttemptWriteShape, params: unknown[], result: any, inTx: boolean): Promise<Verdict[]> => {
    const rowCount = Number(result?.rowCount || 0);
    if (shape.kind === "returning") {
      const rows: any[] = Array.isArray(result?.rows) ? result.rows : [];
      if (!rows.length) { stats.verdicts_discarded.zero_row += 1; return []; }
      const floor = classOf(shape.class, params);
      const out: Verdict[] = [];
      for (const row of rows) {
        const identity = String(row.correlation_id ?? "");
        const cls = shape.returns_class ? String(row.result_class ?? "") : shape.class.kind === "case_floor" ? null : floor;
        if (!identity || !cls || !TERMINAL.has(cls)) continue;
        out.push({ identities: [identity], result_class: cls, row_count: rows.length, class_source: shape.returns_class ? "returning" : "statement" });
      }
      return out;
    }
    if (rowCount === 0) { stats.verdicts_discarded.zero_row += 1; return []; }
    if (rowCount !== 1) { stats.verdicts_discarded.multi_row += 1; return []; }
    const identity = params[shape.identity_param - 1];
    if (typeof identity !== "string" || !identity) { stats.terminal_writes_unrecognised += 1; return []; }
    if (shape.class.kind !== "case_floor") {
      const cls = classOf(shape.class, params);
      if (!cls || !TERMINAL.has(cls)) return [];                             // a non-terminal write is not a verdict
      return [{ identities: [identity], result_class: cls, row_count: 1, class_source: "statement" }];
    }
    // computed class (CASE … ELSE $n END): the row is locked by this transaction,
    // so what it holds NOW is what the COMMIT makes durable — read it back
    const floor = classOf(shape.class, params);
    if (!floor || !TERMINAL.has(floor)) return [];
    if (!inTx) { stats.verdicts_discarded.unreadable_class += 1; return []; }
    const columns = Object.keys(shape.key_params);
    const where = columns.map((c, i) => `${c}=$${i + 1}`).join(" AND ");
    const values = columns.map((c) => params[shape.key_params[c]! - 1]);
    let rows: any[] = [];
    try {
      const read = await originalQuery.call(client, `SELECT result_class FROM siton.payment_attempts WHERE ${where}`, values);
      rows = Array.isArray(read?.rows) ? read.rows : [];
    } catch {
      stats.verdicts_discarded.unreadable_class += 1;
      return [];
    }
    if (rows.length !== 1) { stats.verdicts_discarded.multi_row += 1; return []; }
    const cls = String(rows[0].result_class ?? "");
    if (!TERMINAL.has(cls)) return [];
    return [{ identities: [identity], result_class: cls, row_count: 1, class_source: "row_readback" }];
  };

  proto.query = function (this: any, config: any, values?: any, callback?: any) {
    // normalise pg's call shapes: (text|config, values?, cb?) / (text|config, cb)
    const cb = typeof callback === "function" ? callback : typeof values === "function" ? values : null;
    const text = String(typeof config === "string" ? config : config?.text || "").trim();
    const params: unknown[] = Array.isArray(values) ? values : Array.isArray(config?.values) ? config.values : [];
    const state = stateOf(this);
    const client = this;
    const job = currentJob();

    let onResolved: ((r: any) => Promise<any>) | null = null;
    let onRejected: ((e: unknown) => void) | null = null;

    if (/^(BEGIN|START\s+TRANSACTION)\b/i.test(text)) {
      state.tx = true; state.staged = []; state.savepoints = [];
    } else if (/^SAVEPOINT\s+/i.test(text)) {
      const name = text.replace(/^SAVEPOINT\s+/i, "").replace(/[;\s][\s\S]*$/, "");
      if (state.tx) state.savepoints.push(name);
    } else if (/^RELEASE\s+/i.test(text)) {
      const name = text.replace(/^RELEASE\s+(?:SAVEPOINT\s+)?/i, "").replace(/[;\s][\s\S]*$/, "");
      const index = state.savepoints.lastIndexOf(name);
      if (index >= 0) {
        state.savepoints.length = index;                                     // the savepoint and everything after it are gone; writes stay staged
        for (const s of state.staged) if (s.depth > index) s.depth = index;
      }
    } else if (/^ROLLBACK\s+TO\b/i.test(text)) {
      const name = text.replace(/^ROLLBACK\s+TO\s+(?:SAVEPOINT\s+)?/i, "").replace(/[;\s][\s\S]*$/, "");
      const index = state.savepoints.lastIndexOf(name);
      if (index >= 0) {
        const kept = state.staged.filter((s) => s.depth <= index);
        stats.verdicts_discarded.savepoint_rollback += state.staged.length - kept.length;
        state.staged = kept;
        state.savepoints.length = index + 1;                                 // the savepoint itself survives
      } else {
        stats.verdicts_discarded.savepoint_rollback += state.staged.length;
        state.staged = [];                                                   // unknown savepoint: nothing staged can be trusted
      }
    } else if (/^(ROLLBACK|ABORT)\b/i.test(text)) {
      stats.verdicts_discarded.rollback += state.staged.length;
      state.tx = false; state.staged = []; state.savepoints = [];
    } else if (/^(COMMIT|END)\b/i.test(text)) {
      const staged = state.staged; state.staged = []; state.savepoints = []; state.tx = false;
      if (staged.length) {
        onResolved = async (r: any) => {
          const command = String(r?.command || "").toUpperCase();
          if (command !== "COMMIT") { stats.verdicts_discarded.aborted_commit += staged.length; return r; }   // an aborted transaction answers ROLLBACK
          for (const v of staged) await publish(v, job);
          return r;
        };
        onRejected = () => { stats.verdicts_discarded.commit_failed += staged.length; };
      }
    } else {
      const shape = classifyPaymentAttemptWrite(text);
      if (shape) {
        const inTx = state.tx;
        const depth = state.savepoints.length;
        onResolved = async (r: any) => {
          const verdicts = await settle(client, shape, params, r, inTx);
          if (inTx) for (const v of verdicts) state.staged.push({ ...v, depth });
          else for (const v of verdicts) await publish(v, job);              // autocommit: durable as soon as it returned
          return r;
        };
      } else if (isUnboundTerminalWrite(text, params)) {
        stats.terminal_writes_unrecognised += 1;
      }
    }

    if (!onResolved && !onRejected) return originalQuery.apply(this, arguments as any);
    if (cb) {
      const wrappedCb = (err: unknown, res: any) => {
        if (err) { onRejected?.(err); cb(err, res); return; }
        Promise.resolve(onResolved ? onResolved(res) : res).then((value) => cb(null, value), (e) => cb(e, undefined));
      };
      if (typeof callback === "function") return originalQuery.call(this, config, values, wrappedCb);
      return originalQuery.call(this, config, wrappedCb);
    }
    const result = originalQuery.apply(this, arguments as any);
    if (!result || typeof result.then !== "function") return result;
    return result.then(
      (r: any) => (onResolved ? onResolved(r) : r),
      (e: unknown) => { onRejected?.(e); throw e; }
    );
  };

  installed = {
    instance,
    uninstall() {
      alive = false;
      globalThis.fetch = realFetch as typeof fetch;
      JSON.parse = realParse;
      proto.query = originalQuery;
      pending.length = 0;
      installed = null;
    },
    stats: () => realParse(JSON.stringify(stats)) as ObserverStats,
    drain: () => Promise.resolve(chain).then(() => undefined)
  };
  return installed;
}

/** observe() implementation for observers in OTHER processes: positions come from the simulator over HTTP */
export function httpObserver(simulatorBaseUrl: string): ObserveFn {
  const realFetch = globalThis.fetch.bind(globalThis);
  const url = `${simulatorBaseUrl.replace(/\/+$/, "")}/lab/observe`;
  return async (entry) => {
    const res = await realFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(entry) });
    const body: any = await res.json();
    return { seq: Number(body?.seq) };
  };
}
