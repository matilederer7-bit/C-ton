// P0.7C — deterministic proof of the bounded public read-polling scheduler
// (web/src/polling.ts) with injected timers/visibility, plus the deal page
// wiring (source contract):
//   A. one tab, 2 minutes: ≤ 11 activity runs (1 immediate + 10 @12s), ≤ 5 chat runs
//   B. two tabs: independent schedulers, still ≤ 7 requests/min each
//   C. hidden tab: zero runs while hidden
//   D. visible again: ONE immediate refresh, then normal cadence
//   E. no overlapping runs when the task is slow
//   F. 429 → exponential back-off (capped); success resets it
//   G. terminal outcome stops the loop; stop() is final
//   H. product floor: never faster than POLL_MIN_INTERVAL_MS
//   I. Draft buyer preview: activity + chat pollers disabled
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  POLL_DEFAULT_MAX_BACKOFF_MS, POLL_MIN_INTERVAL_MS, PUBLIC_DEAL_POLL, TERMINAL_DEAL_STATES,
  backoffDelayMs, classifyPollError, createPoller, type PollDeps, type PollTaskResult
} from "../web/src/polling.js";

let passed = 0;
async function run(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

// ── fake clock + visibility ─────────────────────────────────────────────────
class FakeWorld {
  now = 0;
  visible = true;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  private seq = 0;
  private listeners = new Set<() => void>();
  deps(): PollDeps {
    return {
      now: () => this.now,
      setTimer: (fn, ms) => { const id = ++this.seq; this.timers.push({ id, at: this.now + ms, fn }); return id; },
      clearTimer: (handle) => { this.timers = this.timers.filter((t) => t.id !== handle); },
      isVisible: () => this.visible,
      subscribeVisibility: (cb) => { this.listeners.add(cb); return () => this.listeners.delete(cb); }
    };
  }
  setVisible(v: boolean) { this.visible = v; for (const cb of this.listeners) cb(); }
  /** advance the clock, firing due timers in order and letting promises settle */
  async advance(ms: number) {
    const target = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.now = due.at;
      due.fn();
      await settle();
    }
    this.now = target;
    await settle();
  }
  pendingTimers() { return this.timers.length; }
}
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function counterTask(world: FakeWorld, log: number[], outcome: () => PollTaskResult = () => ({ outcome: "ok" })) {
  return async () => { log.push(world.now); return outcome(); };
}
const perMinute = (stamps: number[], minuteIndex: number) => stamps.filter((t) => t >= minuteIndex * 60_000 && t < (minuteIndex + 1) * 60_000).length;

await run("A: one tab for 2 minutes — immediate fetch, then bounded cadence (activity ≤ 6/min, chat ≤ 3/min)", async () => {
  const world = new FakeWorld();
  const activity: number[] = [], chat: number[] = [];
  const a = createPoller(counterTask(world, activity), { intervalMs: PUBLIC_DEAL_POLL.activity_open_ms }, world.deps());
  const c = createPoller(counterTask(world, chat), { intervalMs: PUBLIC_DEAL_POLL.chat_ms }, world.deps());
  a.start(); c.start();
  await settle();
  assert.deepEqual([activity.length, chat.length], [1, 1], "immediate fetch on start");
  await world.advance(120_000);
  assert.ok(activity.length <= 11, `activity runs in 2 min: ${activity.length}`);
  assert.ok(chat.length <= 5, `chat runs in 2 min: ${chat.length}`);
  assert.ok(perMinute(activity, 0) <= 6 && perMinute(activity, 1) <= 5, `activity per minute ${perMinute(activity, 0)}/${perMinute(activity, 1)}`);
  assert.ok(perMinute(chat, 0) <= 3 && perMinute(chat, 1) <= 2, `chat per minute ${perMinute(chat, 0)}/${perMinute(chat, 1)}`);
  // spacing never below the interval
  for (let i = 1; i < activity.length; i++) assert.ok(activity[i]! - activity[i - 1]! >= PUBLIC_DEAL_POLL.activity_open_ms, "activity spacing");
  a.stop(); c.stop();
  assert.equal(world.pendingTimers(), 0, "stop clears timers");
});

await run("B: two tabs on one IP — independent schedulers, combined read load stays far below the read budget", async () => {
  const world = new FakeWorld();
  const tabs = [0, 1].map(() => {
    const act: number[] = [], chat: number[] = [];
    const a = createPoller(counterTask(world, act), { intervalMs: PUBLIC_DEAL_POLL.activity_open_ms }, world.deps());
    const c = createPoller(counterTask(world, chat), { intervalMs: PUBLIC_DEAL_POLL.chat_ms }, world.deps());
    a.start(); c.start();
    return { act, chat, a, c };
  });
  await settle();
  await world.advance(60_000);
  const total = tabs.reduce((s, t) => s + perMinute(t.act, 0) + perMinute(t.chat, 0), 0);
  assert.ok(total <= 18, `two tabs first minute: ${total} requests`);
  assert.ok(total < 20, "below the OLD sensitive bucket even in the burstiest first minute");
  assert.ok(total < 120, "far below the dedicated read budget");
  for (const t of tabs) { t.a.stop(); t.c.stop(); }
});

await run("C+D: hidden tab polls nothing; returning visible refreshes once immediately, then resumes cadence", async () => {
  const world = new FakeWorld();
  const log: number[] = [];
  const p = createPoller(counterTask(world, log), { intervalMs: 12_000 }, world.deps());
  p.start(); await settle();
  await world.advance(30_000);
  const beforeHidden = log.length;
  world.setVisible(false);
  await world.advance(120_000);
  assert.equal(log.length, beforeHidden, "no runs while hidden");
  assert.equal(p.state.paused, true);
  world.setVisible(true);
  await settle();
  assert.equal(log.length, beforeHidden + 1, "exactly one immediate refresh on return");
  assert.equal(log[log.length - 1], world.now, "refresh happened right away");
  await world.advance(12_000);
  assert.equal(log.length, beforeHidden + 2, "cadence resumes after the refresh");
  p.stop();
});

await run("C2: a poller started while hidden waits for visibility (no request until visible)", async () => {
  const world = new FakeWorld();
  world.visible = false;
  const log: number[] = [];
  const p = createPoller(counterTask(world, log), { intervalMs: 12_000 }, world.deps());
  p.start(); await settle();
  await world.advance(60_000);
  assert.equal(log.length, 0);
  world.setVisible(true); await settle();
  assert.equal(log.length, 1);
  p.stop();
});

await run("E: a slow server never gets overlapping requests", async () => {
  const world = new FakeWorld();
  let inFlight = 0, maxInFlight = 0, runs = 0;
  let release: (() => void) | null = null;
  const p = createPoller(async () => {
    runs += 1; inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise<void>((r) => { release = r; });
    inFlight -= 1;
    return { outcome: "ok" };
  }, { intervalMs: 12_000 }, world.deps());
  p.start(); await settle();
  await world.advance(60_000); // interval elapses many times while the first call hangs
  assert.equal(runs, 1, "no second request while the first is in flight");
  p.refresh(); await settle();
  assert.equal(runs, 1, "refresh is ignored while in flight");
  release!(); await settle();
  await world.advance(12_000);
  assert.equal(runs, 2);
  assert.equal(maxInFlight, 1);
  release!(); await settle();
  p.stop();
});

await run("F: 429 backs off exponentially (capped) and a success resets the cadence", async () => {
  const world = new FakeWorld();
  const log: number[] = [];
  let mode: PollTaskResult = { outcome: "rate_limited" };
  const p = createPoller(counterTask(world, log, () => mode), { intervalMs: 12_000, maxBackoffMs: 60_000 }, world.deps());
  p.start(); await settle();
  assert.equal(p.state.nextDelayMs, 24_000, "first back-off doubles");
  await world.advance(24_000);
  assert.equal(p.state.nextDelayMs, 48_000, "second back-off doubles again");
  await world.advance(48_000);
  assert.equal(p.state.nextDelayMs, 60_000, "capped at maxBackoffMs");
  await world.advance(60_000);
  assert.equal(p.state.consecutiveFailures, 4);
  mode = { outcome: "ok" };
  await world.advance(60_000);
  assert.equal(p.state.consecutiveFailures, 0, "success resets");
  assert.equal(p.state.nextDelayMs, 12_000, "back to the base cadence");
  assert.equal(backoffDelayMs(12_000, 0, 60_000), 12_000);
  assert.equal(backoffDelayMs(12_000, 3, 60_000), 60_000);
  assert.equal(classifyPollError({ status: 429 }), "rate_limited");
  assert.equal(classifyPollError({ status: 404 }), "stop");
  assert.equal(classifyPollError({ status: 403 }), "stop");
  assert.equal(classifyPollError({ status: 500 }), "error");
  assert.equal(classifyPollError(new Error("network")), "error");
  p.stop();
});

await run("G: a terminal deal stops polling for good; the task may lengthen its own interval", async () => {
  const world = new FakeWorld();
  const log: number[] = [];
  let state = "PendingTarget";
  const p = createPoller(async () => {
    log.push(world.now);
    if ((TERMINAL_DEAL_STATES as readonly string[]).includes(state)) return { outcome: "stop" };
    return { outcome: "ok", intervalMs: state === "PendingTarget" ? PUBLIC_DEAL_POLL.activity_open_ms : PUBLIC_DEAL_POLL.activity_settled_ms };
  }, { intervalMs: PUBLIC_DEAL_POLL.activity_open_ms }, world.deps());
  p.start(); await settle();
  await world.advance(12_000);
  assert.equal(log.length, 2);
  state = "ClosedForJoining";
  await world.advance(12_000);
  assert.equal(log.length, 3);
  assert.equal(p.state.nextDelayMs, PUBLIC_DEAL_POLL.activity_settled_ms, "settled deal polls slower");
  state = "Completed";
  await world.advance(30_000);
  assert.equal(log.length, 4, "the terminal read happens once");
  assert.equal(p.state.stopped, true, "then the loop stops");
  await world.advance(300_000);
  assert.equal(log.length, 4, "never again");
  assert.equal(world.pendingTimers(), 0);
  p.refresh(); await settle();
  assert.equal(log.length, 4, "refresh after stop is a no-op");
});

await run("H: product floor — public reads never faster than POLL_MIN_INTERVAL_MS; cadence constants are sane", async () => {
  const world = new FakeWorld();
  const log: number[] = [];
  const p = createPoller(counterTask(world, log), { intervalMs: 1_000 }, world.deps());
  p.start(); await settle();
  assert.equal(p.state.nextDelayMs, POLL_MIN_INTERVAL_MS, "1s requested → floored to 10s");
  p.stop();
  assert.equal(POLL_MIN_INTERVAL_MS, 10_000);
  assert.ok(PUBLIC_DEAL_POLL.activity_open_ms >= 10_000 && PUBLIC_DEAL_POLL.activity_open_ms <= 15_000, "activity 10–15s");
  assert.ok(PUBLIC_DEAL_POLL.chat_ms >= 20_000 && PUBLIC_DEAL_POLL.inquiries_ms >= 20_000);
  assert.ok(PUBLIC_DEAL_POLL.activity_settled_ms > PUBLIC_DEAL_POLL.activity_open_ms);
  assert.equal(POLL_DEFAULT_MAX_BACKOFF_MS, 60_000);
  const perMinuteNew = 60_000 / PUBLIC_DEAL_POLL.activity_open_ms + 60_000 / PUBLIC_DEAL_POLL.chat_ms;
  assert.ok(perMinuteNew <= 7, `new steady-state requests/min per tab: ${perMinuteNew}`);
});

const [dealPage, usePollerSrc, appTs, sellerPage] = await Promise.all([
  readFile("web/src/pages/deal.tsx", "utf8"),
  readFile("web/src/usePoller.ts", "utf8"),
  readFile("src/app.ts", "utf8"),
  readFile("web/src/pages/seller.tsx", "utf8")
]);

await run("I: deal page wiring — activity/chat/inquiries use the bounded poller; no bare intervals; preview disables polling", () => {
  assert.doesNotMatch(dealPage, /setInterval\(/, "no bare setInterval left on the deal page");
  assert.match(dealPage, /usePoller\(async \(\) => \{\s*\n\s*try \{\s*\n\s*const a = await api\.activity\(dealId\);/);
  assert.match(dealPage, /intervalMs: PUBLIC_DEAL_POLL\.activity_open_ms, enabled: !preview \}, \[dealId\]\)/);
  assert.match(dealPage, /intervalMs: PUBLIC_DEAL_POLL\.chat_ms, enabled: !preview \}, \[dealId\]\)/);
  assert.match(dealPage, /intervalMs: PUBLIC_DEAL_POLL\.inquiries_ms \}, \[dealId, refreshKey\]\)/);
  assert.match(dealPage, /TERMINAL_DEAL_STATES as readonly string\[\]\)\.includes\(s\)\) return \{ outcome: "stop" \}/);
  assert.match(dealPage, /return \{ outcome: classifyPollError\(err\) \}/);
  assert.match(dealPage, /if \(!preview\) \{\s*\n\s*\/\/ real public traffic only/);
  assert.match(usePollerSrc, /document\.visibilityState === "visible"/);
  assert.match(usePollerSrc, /addEventListener\("visibilitychange", cb\)/);
  assert.match(usePollerSrc, /return \(\) => poller\.stop\(\);/);
  assert.match(sellerPage, /<DealPage dealId=\{sub\[1\]\} navigate=\{navigate\} preview \/>/);
});

await run("server: read-only requests on the sensitive prefixes get their own bounded budget; mutations keep the strict bucket", () => {
  assert.match(appTs, /const RATE_LIMIT_READ_MAX_CONFIGURED = Number\(process\.env\.RATE_LIMIT_READ_MAX \?\? 120\);/);
  assert.match(appTs, /Math\.max\(RATE_LIMIT_READ_MAX_CONFIGURED, RATE_LIMIT_SENSITIVE_MAX\)/, "read budget is never stricter than the mutation budget");
  assert.match(appTs, /export function rateLimitBucketFor\(method: string, url: string\): "sensitive" \| "read" \| "none"/);
  assert.match(appTs, /READ_ONLY_METHODS\.has\(String\(method \|\| ""\)\.toUpperCase\(\)\) \? "read" : "sensitive"/);
  assert.match(appTs, /const readKey = `r:\$\{ip\}`;/);
  assert.match(appTs, /const sensitiveKey = `s:\$\{ip\}`;/);
  assert.match(appTs, /const SENSITIVE_PATHS = \["\/api\/otp", "\/api\/deals\/join", "\/api\/deals", "\/api\/support"\];/, "sensitive prefixes unchanged");
  assert.match(appTs, /const RATE_LIMIT_SENSITIVE_MAX = Number\(process\.env\.RATE_LIMIT_SENSITIVE_MAX \?\? 20\);/, "mutation budget unchanged");
});

console.log(`\nP07C_POLLING_RESULT passed=${passed}`);
