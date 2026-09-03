// P0.7C — ONE bounded read-polling scheduler for public surfaces (pure: no
// React, no DOM — the browser adapter lives in usePoller.ts). Properties the
// product relies on, all provable with injected fakes:
//   • immediate fetch on start (when the document is visible)
//   • never overlapping: the next run is scheduled only after the current one
//     settles (a slow server cannot stack requests)
//   • bounded interval with a product floor (public reads never faster than
//     POLL_MIN_INTERVAL_MS); a task may lengthen its own next interval
//   • pause while the document is hidden; on return: one immediate refresh,
//     then normal cadence
//   • exponential back-off after 429 / server error (capped), reset on success
//   • a task may return "stop" (terminal deal, closed chat, 404): no more runs
//   • stop() is final and cancels everything

export type PollOutcome = "ok" | "rate_limited" | "error" | "stop";
export type PollTaskResult = { outcome: PollOutcome; intervalMs?: number };

export type PollDeps = {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  isVisible(): boolean;
  subscribeVisibility(cb: () => void): () => void;
};

export type PollOptions = {
  intervalMs: number;
  maxBackoffMs?: number;
  /** product floor for public read polling; tests may lower it */
  minIntervalMs?: number;
};

export type PollState = {
  runs: number;
  inFlight: boolean;
  paused: boolean;
  stopped: boolean;
  consecutiveFailures: number;
  nextDelayMs: number | null;
  lastOutcome: PollOutcome | null;
};

export type PollerHandle = {
  start(): void;
  stop(): void;
  /** immediate run if idle and visible (e.g. after the user acted) */
  refresh(): void;
  readonly state: PollState;
};

export const POLL_MIN_INTERVAL_MS = 10_000;
export const POLL_DEFAULT_MAX_BACKOFF_MS = 60_000;

// Public deal page cadence. Old: activity 6s + chat 20s ≈ 13 requests/min per
// tab against a 20/min per-IP bucket. New: 5 + 2 = 7/min per tab, on a
// dedicated read budget, paused while hidden, stopped when the deal is terminal.
export const PUBLIC_DEAL_POLL = Object.freeze({
  activity_open_ms: 12_000,
  activity_settled_ms: 30_000,
  chat_ms: 30_000,
  inquiries_ms: 30_000
});

export const TERMINAL_DEAL_STATES = ["Completed", "Failed", "Cancelled"] as const;

export function backoffDelayMs(baseMs: number, consecutiveFailures: number, maxMs: number): number {
  const exponent = Math.max(0, Math.min(10, consecutiveFailures));
  return Math.min(maxMs, Math.max(baseMs, baseMs * Math.pow(2, exponent)));
}

/** Map an API error to a poll outcome: 429 backs off, gone/forbidden stops, else error. */
export function classifyPollError(error: unknown): PollOutcome {
  const status = Number((error as { status?: unknown } | null)?.status ?? 0);
  if (status === 429) return "rate_limited";
  if (status === 403 || status === 404 || status === 410) return "stop";
  return "error";
}

export function createPoller(task: () => Promise<PollTaskResult>, options: PollOptions, deps: PollDeps): PollerHandle {
  const minInterval = options.minIntervalMs ?? POLL_MIN_INTERVAL_MS;
  const maxBackoff = options.maxBackoffMs ?? POLL_DEFAULT_MAX_BACKOFF_MS;
  const baseInterval = Math.max(minInterval, options.intervalMs);
  const state: PollState = {
    runs: 0, inFlight: false, paused: false, stopped: false, consecutiveFailures: 0, nextDelayMs: null, lastOutcome: null
  };
  let timer: unknown = null;
  let unsubscribe: (() => void) | null = null;
  let currentInterval = baseInterval;

  const clearTimer = () => {
    if (timer !== null) { deps.clearTimer(timer); timer = null; }
    state.nextDelayMs = null;
  };

  const schedule = (ms: number) => {
    clearTimer();
    if (state.stopped || state.paused) return;
    state.nextDelayMs = ms;
    timer = deps.setTimer(() => { timer = null; state.nextDelayMs = null; void tick(); }, ms);
  };

  const tick = async () => {
    if (state.stopped || state.inFlight) return;
    if (!deps.isVisible()) { state.paused = true; clearTimer(); return; }
    state.inFlight = true;
    state.runs += 1;
    let result: PollTaskResult;
    try { result = await task(); }
    catch { result = { outcome: "error" }; }
    finally { state.inFlight = false; }
    state.lastOutcome = result.outcome;
    if (state.stopped) return;
    if (result.outcome === "stop") { stop(); return; }
    if (result.outcome === "ok") {
      state.consecutiveFailures = 0;
      currentInterval = Math.max(minInterval, result.intervalMs ?? baseInterval);
      schedule(currentInterval);
      return;
    }
    state.consecutiveFailures += 1;
    schedule(backoffDelayMs(currentInterval, state.consecutiveFailures, maxBackoff));
  };

  const onVisibility = () => {
    if (state.stopped) return;
    if (deps.isVisible()) {
      if (state.paused) {
        state.paused = false;
        void tick(); // one immediate refresh on return, then normal cadence
      }
      return;
    }
    state.paused = true;
    clearTimer();
  };

  const start = () => {
    if (state.stopped) return;
    if (!unsubscribe) unsubscribe = deps.subscribeVisibility(onVisibility);
    if (deps.isVisible()) void tick();
    else state.paused = true;
  };

  const stop = () => {
    state.stopped = true;
    clearTimer();
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  };

  const refresh = () => {
    if (state.stopped || state.inFlight || !deps.isVisible()) return;
    clearTimer();
    void tick();
  };

  return { start, stop, refresh, state };
}
