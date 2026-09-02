// P0.6A — pickup geolocation strategy: deterministic proof of the bounded
// explicit-click flow behind "📍 השתמש במיקום שלי" (web/src/geo.ts).
//
// Proves, with injected fakes (no browser, no timers left running):
//   • success on attempt 1 (normal accuracy) → exactly ONE provider call
//   • Permissions API "denied" → site_denied, ZERO provider calls
//   • PERMISSION_DENIED from the provider → never retried (1 call)
//   • PERMISSION_DENIED while the site is "granted" → os_denied (OS-level block)
//   • TIMEOUT / POSITION_UNAVAILABLE on attempt 1 → ONE high-accuracy fallback
//   • attempt-1 failure → attempt-2 success → success with 2 attempts
//   • two failures → timeout / unavailable, never a third attempt
//   • geolocation API missing → unsupported, no calls
//   • Permissions API missing → the request still runs
//   • insecure context → insecure_context, no calls
//   • watchdog fires when the browser never calls back; late callbacks ignored
//   • invalid coordinates from the browser are treated as unavailable
//   • manual fallback parser accepts valid / rejects invalid coordinates
//   • seller.tsx wiring: component uses the strategy, exposes every failure
//     state, keeps the manual fallback, and requests only from the click
//   • app.ts header keeps geolocation=(self) (the page may ask; nothing else)

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  GEO_ATTEMPT_PLAN,
  GEO_MAX_ATTEMPTS,
  GEO_OUTCOME_COPY,
  GEO_OUTCOME_TEST_ID,
  GEO_PERMISSION_DENIED,
  GEO_POSITION_UNAVAILABLE,
  GEO_PROMPT_GRACE_MS,
  GEO_TIMEOUT,
  GEO_WATCHDOG_GRACE_MS,
  geoDiagnosticLine,
  normalizePermissionState,
  parseManualCoordinates,
  requestPickupLocation,
  type GeoDeps,
  type GeoErrorLike,
  type GeoPermissionState,
  type GeoPositionLike,
  type GeoRequestOptions
} from "../web/src/geo.js";

let passed = 0;
async function run(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

type Scripted =
  | { ok: GeoPositionLike }
  | { err: GeoErrorLike }
  | { hang: true };

interface FakeTimer { fn: () => void; ms: number; cleared: boolean }

function fakeDeps(options: {
  secure?: boolean;
  api?: boolean;
  permission?: GeoPermissionState | null;
  permissionAfterError?: GeoPermissionState;
  script?: Scripted[];
  permissionThrows?: boolean;
}) {
  const calls: GeoRequestOptions[] = [];
  const timers: FakeTimer[] = [];
  const trace: Record<string, unknown>[] = [];
  const script = [...(options.script || [])];
  let clock = 1_000;
  let permissionReads = 0;
  const deps: GeoDeps = {
    isSecureContext: options.secure !== false,
    getCurrentPosition: options.api === false
      ? null
      : (ok, err, opts) => {
        calls.push({ ...opts });
        const next = script.shift();
        if (!next) throw new Error("fake provider called more times than scripted");
        if ("hang" in next) return;
        clock += 250;
        if ("ok" in next) ok(next.ok);
        else err(next.err);
      },
    queryPermission: options.permission === null
      ? null
      : async () => {
        permissionReads += 1;
        if (options.permissionThrows) throw new TypeError("geolocation is not a valid permission name");
        if (permissionReads > 1 && options.permissionAfterError) return options.permissionAfterError;
        return options.permission || "prompt";
      },
    setTimer: (fn, ms) => {
      const timer: FakeTimer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => { (handle as FakeTimer).cleared = true; },
    now: () => clock
  };
  return {
    deps,
    calls,
    timers,
    trace,
    hooks: { trace: (event: Record<string, unknown>) => { trace.push(event); } },
    get permissionReads() { return permissionReads; },
    fireWatchdog(index = timers.length - 1) {
      const timer = timers[index];
      assert.ok(timer, "no watchdog timer registered");
      assert.equal(timer.cleared, false, "watchdog already cleared");
      timer.fn();
    }
  };
}

const POS = (lat: number, lng: number, accuracy = 25): GeoPositionLike => ({ coords: { latitude: lat, longitude: lng, accuracy } });
const ERR = (code: number, message = ""): GeoErrorLike => ({ code, message });

await run("attempt plan is bounded: exactly two attempts, normal accuracy first, high accuracy second", () => {
  assert.equal(GEO_MAX_ATTEMPTS, 2);
  assert.equal(GEO_ATTEMPT_PLAN[0]?.enableHighAccuracy, false);
  assert.equal(GEO_ATTEMPT_PLAN[1]?.enableHighAccuracy, true);
  assert.ok((GEO_ATTEMPT_PLAN[0]?.timeout || 0) >= 5_000 && (GEO_ATTEMPT_PLAN[0]?.timeout || 0) <= 15_000, "attempt 1 timeout is reasonable");
  assert.ok((GEO_ATTEMPT_PLAN[1]?.timeout || 0) <= 15_000, "attempt 2 timeout is bounded");
  assert.ok(GEO_WATCHDOG_GRACE_MS < GEO_PROMPT_GRACE_MS);
});

await run("success on attempt 1 → one provider call, normal accuracy, all watchdogs cleared", async () => {
  const f = fakeDeps({ permission: "granted", script: [{ ok: POS(32.0668, 34.7647, 12) }] });
  const attempts: Array<[number, boolean]> = [];
  const out = await requestPickupLocation(f.deps, { ...f.hooks, onAttempt: (n, high) => attempts.push([n, high]) });
  assert.equal(out.kind, "success");
  assert.equal(out.latitude, 32.0668);
  assert.equal(out.longitude, 34.7647);
  assert.equal(out.accuracy, 12);
  assert.equal(out.permission, "granted");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.enableHighAccuracy, false);
  assert.deepEqual(attempts, [[1, false]]);
  assert.equal(out.attempts.length, 1);
  assert.equal(out.attempts[0]?.result, "success");
  assert.ok(f.timers.every((t) => t.cleared), "every watchdog timer was cleared");
});

await run("Permissions API denied → site_denied with ZERO provider calls (no prompt is possible)", async () => {
  const f = fakeDeps({ permission: "denied", script: [{ ok: POS(1, 1) }] });
  const out = await requestPickupLocation(f.deps, f.hooks);
  assert.equal(out.kind, "site_denied");
  assert.equal(f.calls.length, 0);
  assert.equal(out.attempts.length, 0);
  assert.equal(f.timers.length, 0);
});

await run("PERMISSION_DENIED from the provider while permission is 'prompt' → site_denied, NO retry", async () => {
  const f = fakeDeps({ permission: "prompt", permissionAfterError: "denied", script: [{ err: ERR(GEO_PERMISSION_DENIED, "User denied Geolocation") }, { ok: POS(1, 1) }] });
  const out = await requestPickupLocation(f.deps, f.hooks);
  assert.equal(out.kind, "site_denied");
  assert.equal(f.calls.length, 1, "a denial must never be retried");
  assert.equal(out.attempts.length, 1);
  assert.equal(out.attempts[0]?.code, GEO_PERMISSION_DENIED);
  assert.equal(out.permission, "denied");
});

await run("PERMISSION_DENIED while the site is GRANTED → os_denied (OS location service / app permission), NO retry", async () => {
  const f = fakeDeps({ permission: "granted", script: [{ err: ERR(GEO_PERMISSION_DENIED, "User denied Geolocation") }, { ok: POS(1, 1) }] });
  const out = await requestPickupLocation(f.deps, f.hooks);
  assert.equal(out.kind, "os_denied");
  assert.equal(f.calls.length, 1);
  assert.equal(out.permission, "granted");
  assert.match(GEO_OUTCOME_COPY.os_denied.steps.join("\n"), /Windows/);
  assert.match(GEO_OUTCOME_COPY.os_denied.steps.join("\n"), /macOS/);
  assert.match(GEO_OUTCOME_COPY.os_denied.title, /המכשיר חוסם/);
  assert.equal(GEO_OUTCOME_COPY.os_denied.denial, true);
});

await run("PERMISSION_DENIED with no Permissions API at all → site_denied (cannot tell apart), NO retry", async () => {
  const f = fakeDeps({ permission: null, script: [{ err: ERR(GEO_PERMISSION_DENIED) }, { ok: POS(1, 1) }] });
  const out = await requestPickupLocation(f.deps, f.hooks);
  assert.equal(out.kind, "site_denied");
  assert.equal(f.calls.length, 1);
  assert.equal(out.permission, "unknown");
});

await run("TIMEOUT on attempt 1 → ONE high-accuracy fallback → success with 2 attempts", async () => {
  const f = fakeDeps({ permission: "granted", script: [{ err: ERR(GEO_TIMEOUT, "Timeout expired") }, { ok: POS(31.7683, 35.2137, 5) }] });
  const attempts: Array<[number, boolean]> = [];
  const out = await requestPickupLocation(f.deps, { ...f.hooks, onAttempt: (n, high) => attempts.push([n, high]) });
  assert.equal(out.kind, "success");
  assert.equal(out.latitude, 31.7683);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0]?.enableHighAccuracy, false);
  assert.equal(f.calls[1]?.enableHighAccuracy, true);
  assert.deepEqual(attempts, [[1, false], [2, true]]);
  assert.equal(out.attempts.length, 2);
  assert.equal(out.attempts[0]?.code, GEO_TIMEOUT);
  assert.equal(out.attempts[1]?.result, "success");
});

await run("POSITION_UNAVAILABLE on attempt 1 → high-accuracy fallback → success", async () => {
  const f = fakeDeps({ permission: "prompt", script: [{ err: ERR(GEO_POSITION_UNAVAILABLE, "Network location provider error") }, { ok: POS(32.1, 34.8) }] });
  const out = await requestPickupLocation(f.deps, f.hooks);
  assert.equal(out.kind, "success");
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]?.enableHighAccuracy, true);
  assert.equal(f.calls[1]?.maximumAge, 0, "fallback asks for a fresh fix");
});

await run("two POSITION_UNAVAILABLE failures → unavailable, exactly 2 calls, never a third", async () => {
  const f = fakeDeps({ permission: "granted", script: [{ err: ERR(GEO_POSITION_UNAVAILABLE) }, { err: ERR(GEO_POSITION_UNAVAILABLE, "Position unavailable") }, { ok: POS(1, 1) }] });
  const out = await requestPickupLocation(f.deps, f.hooks);
  assert.equal(out.kind, "unavailable");
  assert.equal(f.calls.length, 2);
  assert.equal(out.attempts.length, 2);
  assert.match(GEO_OUTCOME_COPY.unavailable.steps.join("\n"), /Windows/);
  assert.equal(GEO_OUTCOME_COPY.unavailable.denial, false);
  assert.equal(GEO_OUTCOME_COPY.unavailable.retryable, true);
});

await run("TIMEOUT then TIMEOUT → timeout outcome, exactly 2 calls", async () => {
  const f = fakeDeps({ permission: "granted", script: [{ err: ERR(GEO_TIMEOUT) }, { err: ERR(GEO_TIMEOUT) }, { ok: POS(1, 1) }] });
  const out = await requestPickupLocation(f.deps, f.hooks);
  assert.equal(out.kind, "timeout");
  assert.equal(f.calls.length, 2);
});

await run("UNAVAILABLE then PERMISSION_DENIED on the fallback → denial wins, no third call", async () => {
  const f = fakeDeps({ permission: "prompt", permissionAfterError: "denied", script: [{ err: ERR(GEO_POSITION_UNAVAILABLE) }, { err: ERR(GEO_PERMISSION_DENIED) }, { ok: POS(1, 1) }] });
  const out = await requestPickupLocation(f.deps, f.hooks);
  assert.equal(out.kind, "site_denied");
  assert.equal(f.calls.length, 2);
});

await run("geolocation API missing → unsupported, no calls, manual fallback copy present", async () => {
  const f = fakeDeps({ api: false, permission: "granted" });
  const out = await requestPickupLocation(f.deps, f.hooks);
  assert.equal(out.kind, "unsupported");
  assert.equal(out.supported, false);
  assert.equal(f.calls.length, 0);
  assert.equal(GEO_OUTCOME_COPY.unsupported.retryable, false);
  assert.match(GEO_OUTCOME_COPY.unsupported.steps.join("\n"), /ידנית/);
});

await run("Permissions API missing → the request still runs and succeeds", async () => {
  const f = fakeDeps({ permission: null, script: [{ ok: POS(32, 34) }] });
  const out = await requestPickupLocation(f.deps, f.hooks);
  assert.equal(out.kind, "success");
  assert.equal(out.permission, "unknown");
  assert.equal(f.calls.length, 1);
});

await run("Permissions API throwing (Safari-style) → treated as unknown, request still runs", async () => {
  const f = fakeDeps({ permission: "granted", permissionThrows: true, script: [{ ok: POS(32, 34) }] });
  const out = await requestPickupLocation(f.deps, f.hooks);
  assert.equal(out.kind, "success");
  assert.equal(out.permission, "unknown");
});

await run("insecure context → insecure_context, no permission read, no calls", async () => {
  const f = fakeDeps({ secure: false, permission: "granted", script: [{ ok: POS(1, 1) }] });
  const out = await requestPickupLocation(f.deps, f.hooks);
  assert.equal(out.kind, "insecure_context");
  assert.equal(out.secure, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.permissionReads, 0);
  assert.equal(GEO_OUTCOME_COPY.insecure_context.retryable, false);
});

await run("browser never calls back → watchdog resolves attempt 1, fallback runs, late callback is ignored", async () => {
  const f = fakeDeps({ permission: "granted", script: [{ hang: true }, { ok: POS(30, 30) }] });
  const promise = requestPickupLocation(f.deps, f.hooks);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0]?.ms, (GEO_ATTEMPT_PLAN[0]?.timeout || 0) + GEO_WATCHDOG_GRACE_MS, "granted ⇒ tight watchdog");
  f.fireWatchdog(0);
  const out = await promise;
  assert.equal(out.kind, "success");
  assert.equal(f.calls.length, 2);
  assert.equal(out.attempts[0]?.result, "watchdog");
  assert.equal(out.attempts[1]?.result, "success");
});

await run("watchdog while the permission prompt may be open uses the long grace", async () => {
  const f = fakeDeps({ permission: "prompt", script: [{ hang: true }, { hang: true }] });
  const promise = requestPickupLocation(f.deps, f.hooks);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.timers[0]?.ms, (GEO_ATTEMPT_PLAN[0]?.timeout || 0) + GEO_PROMPT_GRACE_MS);
  f.fireWatchdog(0);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.calls.length, 2, "one fallback after the watchdog");
  f.fireWatchdog(1);
  const out = await promise;
  assert.equal(out.kind, "timeout");
  assert.equal(f.calls.length, 2, "never a third attempt");
});

await run("late provider callback after the watchdog is traced and ignored (outcome never changes)", async () => {
  let lateOk: ((p: GeoPositionLike) => void) | null = null;
  const f = fakeDeps({ permission: "granted", script: [] });
  f.deps.getCurrentPosition = (ok, _err, opts) => { f.calls.push({ ...opts }); if (f.calls.length === 1) { lateOk = ok; return; } _err(ERR(GEO_TIMEOUT)); };
  const promise = requestPickupLocation(f.deps, f.hooks);
  await Promise.resolve();
  await Promise.resolve();
  f.fireWatchdog(0);
  const out = await promise;
  assert.equal(out.kind, "timeout");
  assert.ok(lateOk, "attempt-1 callback captured");
  (lateOk as unknown as (p: GeoPositionLike) => void)(POS(9, 9));
  assert.ok(f.trace.some((e) => e.step === "late_callback_ignored"), "late callback traced");
  assert.equal(out.kind, "timeout", "settled outcome is immutable");
});

await run("invalid coordinates from the browser count as unavailable (fallback attempted)", async () => {
  const f = fakeDeps({ permission: "granted", script: [{ ok: { coords: { latitude: Number.NaN, longitude: 200 } } }, { ok: POS(1, 2) }] });
  const out = await requestPickupLocation(f.deps, f.hooks);
  assert.equal(out.kind, "success");
  assert.equal(out.attempts[0]?.code, GEO_POSITION_UNAVAILABLE);
  assert.equal(f.calls.length, 2);
});

await run("provider throwing synchronously is contained (never rejects)", async () => {
  const f = fakeDeps({ permission: "granted", script: [] });
  f.deps.getCurrentPosition = () => { throw new Error("boom"); };
  const out = await requestPickupLocation(f.deps, f.hooks);
  assert.equal(out.kind, "unavailable");
  assert.equal(out.attempts.length, 2);
});

await run("diagnostic line is compact, LTR-safe and carries kind/permission/attempt codes", async () => {
  const f = fakeDeps({ permission: "granted", script: [{ err: ERR(GEO_POSITION_UNAVAILABLE, "Position unavailable") }, { err: ERR(GEO_TIMEOUT, "Timeout expired") }] });
  const out = await requestPickupLocation(f.deps, f.hooks);
  const line = geoDiagnosticLine(out);
  assert.match(line, /kind=timeout/);
  assert.match(line, /permission=granted/);
  assert.match(line, /https=yes/);
  assert.match(line, /attempts=2 \[1:lo\/error#2\/\d+ms 2:hi\/error#3\/\d+ms\]/);
  assert.match(line, /msg="Timeout expired"/);
  assert.ok(line.length < 300);
});

await run("normalizePermissionState maps unknown values safely", () => {
  assert.equal(normalizePermissionState("granted"), "granted");
  assert.equal(normalizePermissionState("DENIED"), "denied");
  assert.equal(normalizePermissionState("prompt"), "prompt");
  assert.equal(normalizePermissionState(undefined), "unknown");
  assert.equal(normalizePermissionState("weird"), "unknown");
});

await run("manual fallback parser: accepts valid, rejects out-of-range / empty / NaN", () => {
  const ok = parseManualCoordinates(" 32.0668 ", "34.7647");
  assert.equal(ok.ok, true);
  if (ok.ok) { assert.equal(ok.latitude, 32.0668); assert.equal(ok.longitude, 34.7647); }
  assert.equal(parseManualCoordinates("91", "0").ok, false);
  assert.equal(parseManualCoordinates("0", "181").ok, false);
  assert.equal(parseManualCoordinates("", "34").ok, false);
  assert.equal(parseManualCoordinates("abc", "34").ok, false);
  const bad = parseManualCoordinates("abc", "34");
  if (!bad.ok) assert.match(bad.error, /קואורדינטות לא תקינות/);
});

await run("every failure kind has copy + a stable test id, and the copy always points to the manual fallback or recheck", () => {
  for (const kind of Object.keys(GEO_OUTCOME_TEST_ID) as Array<keyof typeof GEO_OUTCOME_TEST_ID>) {
    const copy = GEO_OUTCOME_COPY[kind];
    assert.ok(copy.title.length > 5, `${kind} title`);
    assert.ok(copy.steps.length >= 1, `${kind} steps`);
    assert.match(GEO_OUTCOME_TEST_ID[kind], /^geo-/);
    const text = `${copy.title}\n${copy.note}\n${copy.steps.join("\n")}`;
    assert.ok(/ידנית|בדיקה מחדש/.test(text), `${kind} copy offers manual fallback or recheck`);
  }
});

// ── wiring proof (source-static): the seller surface really uses the strategy ─
const sellerTsx = await readFile("web/src/pages/seller.tsx", "utf8");
const appTs = await readFile("src/app.ts", "utf8");

await run("seller.tsx LocationCapture delegates to requestPickupLocation(browserGeoDeps()) and never calls the API elsewhere", () => {
  assert.match(sellerTsx, /requestPickupLocation\(browserGeoDeps\(\)/);
  assert.equal((sellerTsx.match(/getCurrentPosition/g) || []).length, 0, "no direct getCurrentPosition in the page");
  assert.equal((sellerTsx.match(/\.watchPosition\(/g) || []).length, 0, "never watchPosition");
  assert.doesNotMatch(sellerTsx, /useEffect\([^)]*requestPickupLocation/, "never requested on mount");
});

await run("seller.tsx exposes explicit-click, pending (attempt-aware), every failure state, recheck/retry, diagnostics and manual fallback", () => {
  assert.match(sellerTsx, /data-testid="use-my-location"/);
  assert.match(sellerTsx, /data-geo-attempt=/);
  assert.match(sellerTsx, /מנסים שוב במצב מדויק/);
  assert.match(sellerTsx, /GEO_OUTCOME_TEST_ID\[outcome\.kind\]/);
  assert.match(sellerTsx, /data-testid=\{copy\.denial \? "geo-recheck" : "geo-retry"\}/);
  assert.match(sellerTsx, /data-testid="geo-diag"/);
  assert.match(sellerTsx, /data-testid="geo-manual-apply"/);
  assert.match(sellerTsx, /data-testid="geo-manual-lat"/);
  assert.match(sellerTsx, /setShowManual\(true\); \/\/ manual fallback is first-class/);
  assert.match(sellerTsx, /הכתובת בשדה התיאור מספיקה תמיד/);
  assert.match(sellerTsx, /if \(inFlight\.current\) return;/, "clicks never stack requests");
});

await run("app.ts security header keeps geolocation=(self) and every other capability off", () => {
  const header = appTs.match(/reply\.header\("permissions-policy", "([^"]+)"\)/)?.[1] || "";
  assert.match(header, /geolocation=\(self\)/);
  assert.match(header, /camera=\(\)/);
  assert.match(header, /microphone=\(\)/);
  assert.match(header, /payment=\(\)/);
});

console.log(`GEOLOCATION_STRATEGY_VALIDATION passed=${passed}`);
