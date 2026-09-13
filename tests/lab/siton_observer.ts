// FINANCIAL TORTURE LAB — the SITON-SIDE observer (R9C ROUND 6).
//
// Codex (round 5 final gate) showed that positioning a provider answer by the
// provider's own write (`delivered_seq`) still leaks time: an answer the
// provider has written but a transport hop has not yet handed to the app is
// not the app's knowledge, and an attempt-level `resolved_at` written for an
// EARLIER, unrelated response must not lend observability to it.
//
// This module records what SITON did, at Siton's own process boundary, with
// positions minted by the provider simulator's single sequencer (so provider
// events and Siton events share ONE order — no wall clocks):
//
//   status query        the outgoing request is stamped with a unique
//                       `x-siton-lab-query-id` (the provider echoes it into its
//                       log) — the causal identity of ONE query / ONE answer;
//   status_received     recorded when the app has PARSED the answer's body
//                       (i.e. the moment the app could act on it);
//   dispatch_sent       recorded BEFORE a money request leaves the process;
//   dispatch_received   recorded when the app has parsed the money answer;
//   verdict_recorded    recorded when the app COMMITTED a terminal
//                       result_class on an identity (the `pg` client wrapper
//                       watches UPDATE siton.payment_attempts … result_class
//                       and reports it at the COMMIT that made it durable).
//
// Installed in-process by the lab runtime (bootLab) before the app is loaded,
// and by `siton_observer_preload.ts` inside real worker processes (positions
// then come over HTTP from the simulator's /lab/observe seam). It touches no
// production source: it wraps `globalThis.fetch` and `pg.Client.prototype.query`.

import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

export type ObserveInput = {
  kind: "status_received" | "dispatch_sent" | "dispatch_received" | "verdict_recorded";
  process: string;
  query_id?: string | null;
  op?: string | null;
  key?: string | null;
  identities?: string[];
  result_class?: string | null;
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

const TERMINAL = new Set(["success", "permanent_fail"]);
const MONEY_PATHS: Record<string, string> = { "/capture": "capture", "/recover": "recover", "/refund": "refund", "/release": "release" };

let installed: { uninstall: () => void } | null = null;

export function installSitonObserver(opts: { providerBaseUrl: string; observe: ObserveFn; process: string }): { uninstall: () => void } {
  if (installed) return installed;
  const base = opts.providerBaseUrl.replace(/\/+$/, "");
  const proc = opts.process;
  const realFetch = globalThis.fetch.bind(globalThis);
  let queryCounter = 0;

  const observe = async (entry: Omit<ObserveInput, "process">) => {
    await opts.observe({ ...entry, process: proc, job: entry.job ?? currentJob() });
  };

  // ── body-read hook: fires once, when the app has the parsed body ──────────
  function hookBody(res: Response, onBody: () => Promise<void>): Response {
    let fired: Promise<void> | null = null;
    const fire = () => { if (!fired) fired = onBody(); return fired; };
    for (const method of ["text", "json", "arrayBuffer", "bytes", "blob", "formData"] as const) {
      const original = (res as any)[method];
      if (typeof original !== "function") continue;
      (res as any)[method] = async function (...args: any[]) {
        const value = await original.apply(res, args);
        await fire();
        return value;
      };
    }
    return res;
  }

  const wrappedFetch: typeof fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url || "");
    if (!url.startsWith(base)) return realFetch(input, init);
    const path = new URL(url).pathname;
    if (path.startsWith("/status/")) {
      const query_id = `${proc}:q${++queryCounter}`;
      const headers = new Headers(init?.headers || (typeof input === "object" && input && "headers" in input ? (input as Request).headers : undefined));
      headers.set("x-siton-lab-query-id", query_id);
      const res = await realFetch(input, { ...init, headers });
      return hookBody(res, () => observe({ kind: "status_received", query_id }));
    }
    const op = MONEY_PATHS[path];
    if (op) {
      const headers = new Headers(init?.headers || undefined);
      const key = String(headers.get("idempotency-key") || "");
      // BEFORE the bytes leave the process: the dispatch's own position
      await observe({ kind: "dispatch_sent", op, key });
      const res = await realFetch(input, init);
      return hookBody(res, () => observe({ kind: "dispatch_received", op, key }));
    }
    return realFetch(input, init);
  };
  globalThis.fetch = wrappedFetch as typeof fetch;

  // ── pg client wrapper: durable verdicts, reported at COMMIT ───────────────
  type ClientState = { tx: boolean; pending: Array<{ identities: string[]; result_class: string }> };
  const states = new WeakMap<object, ClientState>();
  const stateOf = (client: object): ClientState => {
    let s = states.get(client);
    if (!s) { s = { tx: false, pending: [] }; states.set(client, s); }
    return s;
  };
  const verdictOf = (text: string, params: unknown[]) => {
    if (!/UPDATE\s+siton\.payment_attempts/i.test(text) || !/result_class/i.test(text)) return null;
    const strings = params.filter((p): p is string => typeof p === "string");
    const result_class = strings.find((p) => TERMINAL.has(p));
    if (!result_class) return null;
    // every string parameter is a candidate identity; the oracle matches by
    // exact equality with the identity it is judging (notes, references and
    // enums never equal a correlation id)
    return { identities: strings.filter((p) => p !== result_class), result_class };
  };
  const proto = (pg as any).Client.prototype;
  const originalQuery = proto.query;
  proto.query = function (this: any, config: any, values?: any, callback?: any) {
    const result = originalQuery.apply(this, arguments as any);
    if (typeof callback === "function" || typeof values === "function" || !result || typeof result.then !== "function") return result;
    const text = String(typeof config === "string" ? config : config?.text || "").trim();
    const params: unknown[] = Array.isArray(values) ? values : Array.isArray(config?.values) ? config.values : [];
    const state = stateOf(this);
    if (/^BEGIN\b/i.test(text)) { state.tx = true; state.pending = []; return result; }
    if (/^ROLLBACK\b/i.test(text)) { state.tx = false; state.pending = []; return result; }
    if (/^COMMIT\b/i.test(text)) {
      const pending = state.pending; state.pending = []; state.tx = false;
      if (!pending.length) return result;
      const job = currentJob();
      return result.then(async (r: unknown) => {
        for (const v of pending) await observe({ kind: "verdict_recorded", identities: v.identities, result_class: v.result_class, job });
        return r;
      });
    }
    const verdict = verdictOf(text, params);
    if (!verdict) return result;
    if (state.tx) { state.pending.push(verdict); return result; }
    const job = currentJob();
    return result.then(async (r: unknown) => {
      // autocommit statement: durable as soon as it returned
      await observe({ kind: "verdict_recorded", identities: verdict.identities, result_class: verdict.result_class, job });
      return r;
    });
  };

  installed = {
    uninstall() {
      globalThis.fetch = realFetch as typeof fetch;
      proto.query = originalQuery;
      installed = null;
    }
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
