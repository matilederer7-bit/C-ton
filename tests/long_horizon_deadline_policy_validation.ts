// LONG-HORIZON DEALS (item 8) — the ONE deadline policy, safe foundations.
//  * pure classification: 30 / 180 / 366 days and multiple years under the
//    RUNTIME policy (all refused — the proven hold is 7 days) and under a
//    hypothetical stored-payment-authority policy (accepted, warning > 365 d)
//  * the 365-day warning threshold is deterministic (exactly 365 d → no warning,
//    365 d + 1 ms → warning)
//  * runtime behaviour UNCHANGED: POST /deals still refuses 8 d with
//    deadline_above_maximum / "within 7 days", accepts 6 d
//  * no environment flag can raise the ceiling (source pin)
//  * the React picker and server share the module (source pins)
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PORT = process.env.PORT || "3661";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const {
  DAY_MS, HOUR_MS, DEADLINE_MIN_MS, DEADLINE_DEFAULT_MS, PROVEN_AUTHORIZATION_HOLD_MS, LONG_HORIZON_WARNING_MS, LONG_HORIZON_TECHNICAL_MAX_MS,
  RUNTIME_DEADLINE_POLICY, CURRENT_PROVIDER_DEADLINE_CAPABILITIES, resolveDeadlinePolicy, classifyDeadline, describeDeadlineMax, LONG_HORIZON_WARNING_HE
} = await import("../src/deadline_policy.js");
const { app } = await import("../src/app.js");

let passed = 0, failed = 0;
async function run(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`PASS ${name}`); passed++; } catch (e: any) { console.error(`FAIL ${name}: ${e.stack || e.message}`); failed++; }
}
const NOW = Date.parse("2026-09-09T12:00:00.000Z");

await run("runtime policy = 2 h … the PROVEN authorization hold (7 d), reason proven_authorization_hold, not long-horizon capable, no stored-authority proof", () => {
  assert.equal(DEADLINE_MIN_MS, 2 * HOUR_MS);
  assert.equal(PROVEN_AUTHORIZATION_HOLD_MS, 7 * DAY_MS);
  assert.equal(DEADLINE_DEFAULT_MS, 24 * HOUR_MS);
  assert.deepEqual(RUNTIME_DEADLINE_POLICY, { min_ms: 2 * HOUR_MS, max_ms: 7 * DAY_MS, reason: "proven_authorization_hold", long_horizon_capable: false });
  assert.equal(CURRENT_PROVIDER_DEADLINE_CAPABILITIES.stored_payment_authority_proven, false);
  assert.equal(describeDeadlineMax(RUNTIME_DEADLINE_POLICY), "7 ימים");
  assert.equal(LONG_HORIZON_WARNING_MS, 365 * DAY_MS);
  assert.equal(LONG_HORIZON_TECHNICAL_MAX_MS, 20 * 365 * DAY_MS);
});

await run("classification under the runtime policy: 30 / 180 / 366 days and 2 / 5 years are above_maximum; the warning flag is true only beyond 365 days", () => {
  for (const days of [30, 180]) {
    const v = classifyDeadline(NOW + days * DAY_MS, NOW);
    assert.equal(v.code, "above_maximum", `${days}d`);
    assert.equal(v.days, days);
    assert.equal(v.long_horizon_warning, false, `${days}d has no long-horizon warning`);
    assert.equal(v.message_he, "מועד הסיום יכול להיות עד 7 ימים קדימה");
  }
  for (const days of [366, 2 * 365, 5 * 365]) {
    const v = classifyDeadline(NOW + days * DAY_MS, NOW);
    assert.equal(v.code, "above_maximum", `${days}d`);
    assert.equal(v.long_horizon_warning, true, `${days}d warns`);
  }
  assert.equal(classifyDeadline(NOW + 6 * DAY_MS, NOW).code, "ok");
  assert.equal(classifyDeadline(NOW + 7 * DAY_MS, NOW).code, "ok", "exactly 7 days is still inside");
  assert.equal(classifyDeadline(NOW + 7 * DAY_MS + 1, NOW).code, "above_maximum");
  assert.equal(classifyDeadline(NOW + 2 * HOUR_MS, NOW).code, "ok", "exactly 2 hours is inside");
  assert.equal(classifyDeadline(NOW + 2 * HOUR_MS - 1, NOW).code, "below_minimum");
  assert.equal(classifyDeadline(NOW + HOUR_MS, NOW).message_he, "מועד הסיום חייב להיות לפחות שעתיים מעכשיו");
  assert.equal(classifyDeadline(Number.NaN, NOW).code, "invalid");
  assert.equal(classifyDeadline(NOW + DAY_MS, Number.NaN).code, "invalid");
});

await run("a hypothetical PROVEN stored-payment-authority policy admits months and years (up to the technical ceiling) and still warns beyond 365 days — deterministic threshold", () => {
  const future = resolveDeadlinePolicy({ authorization_hold_ms: 7 * DAY_MS, stored_payment_authority_proven: true });
  assert.deepEqual(future, { min_ms: 2 * HOUR_MS, max_ms: LONG_HORIZON_TECHNICAL_MAX_MS, reason: "stored_payment_authority", long_horizon_capable: true });
  assert.equal(describeDeadlineMax(future), "20 שנים");
  for (const days of [30, 180, 365]) {
    const v = classifyDeadline(NOW + days * DAY_MS, NOW, future);
    assert.equal(v.code, "ok", `${days}d`);
    assert.equal(v.long_horizon_warning, false, `${days}d — exactly 365 days is NOT beyond one year`);
  }
  assert.equal(classifyDeadline(NOW + 365 * DAY_MS + 1, NOW, future).long_horizon_warning, true, "365 d + 1 ms warns");
  for (const days of [366, 2 * 365, 5 * 365, 19 * 365]) {
    const v = classifyDeadline(NOW + days * DAY_MS, NOW, future);
    assert.equal(v.code, "ok", `${days}d`);
    assert.equal(v.long_horizon_warning, true, `${days}d warns`);
  }
  assert.equal(classifyDeadline(NOW + LONG_HORIZON_TECHNICAL_MAX_MS + DAY_MS, NOW, future).code, "above_maximum", "only the technical ceiling refuses");
  assert.equal(classifyDeadline(NOW + HOUR_MS, NOW, future).code, "below_minimum", "the operational minimum survives");
  // a provider that proves a LONGER hold (no stored authority) raises the ceiling to exactly that hold
  const longerHold = resolveDeadlinePolicy({ authorization_hold_ms: 30 * DAY_MS, stored_payment_authority_proven: false });
  assert.equal(longerHold.max_ms, 30 * DAY_MS);
  assert.equal(longerHold.long_horizon_capable, false);
  // a nonsense hold falls back to the proven 7 days
  assert.equal(resolveDeadlinePolicy({ authorization_hold_ms: Number.NaN, stored_payment_authority_proven: false }).max_ms, 7 * DAY_MS);
  assert.match(LONG_HORIZON_WARNING_HE, /לטווח ארוך/);
  assert.match(LONG_HORIZON_WARNING_HE, /לעדכן אמצעי תשלום/);
});

await run("runtime behaviour unchanged: POST /deals refuses 8 d (deadline_above_maximum, 'within 7 days'), 30 d, 366 d; accepts 6 d; refuses 1 h (deadline_below_minimum)", async () => {
  const seller = `lh-seller-${randomUUID().slice(0, 8)}`;
  const create = (deadlineMs: number) => app.inject({
    method: "POST", url: "/deals", headers: { "x-seller-id": seller, "idempotency-key": `lh-${randomUUID()}` },
    payload: { seller_id: seller, title: "Long horizon probe", description: "policy proof", price_per_unit: 10, min_units: 2, max_units: 10, deadline: new Date(Date.now() + deadlineMs).toISOString() }
  });
  for (const days of [8, 30, 366]) {
    const res = await create(days * DAY_MS);
    assert.equal(res.statusCode, 400, `${days}d → ${res.statusCode} ${res.body}`);
    const body = res.json() as any;
    assert.equal(body.code || body.error_code, "deadline_above_maximum", res.body);
    assert.match(String(body.error || body.message || ""), /within 7 days/i);
  }
  const low = await create(HOUR_MS);
  assert.equal(low.statusCode, 400);
  assert.equal(((low.json() as any).code || (low.json() as any).error_code), "deadline_below_minimum");
  const ok = await create(6 * DAY_MS);
  assert.equal(ok.statusCode, 200, ok.body);
});

await run("source pins: server + React derive their bounds from src/deadline_policy.ts; no environment flag can raise the ceiling; the >1-year warning component exists (dormant)", () => {
  const appTs = read("src/app.ts");
  const seller = read("web/src/pages/seller.tsx");
  const policy = read("src/deadline_policy.ts");
  assert.match(appTs, /const DEADLINE_MIN_MS = RUNTIME_DEADLINE_POLICY\.min_ms;/);
  assert.match(appTs, /const DEADLINE_MAX_MS = RUNTIME_DEADLINE_POLICY\.max_ms;/);
  assert.doesNotMatch(appTs, /const DEADLINE_MAX_MS = 7 \* 24/);
  assert.match(seller, /classifyDeadline\(Date\.parse\(iso\), Date\.now\(\)\)/);
  assert.match(seller, /RUNTIME_DEADLINE_POLICY\.max_ms/);
  assert.doesNotMatch(seller, /7 \* 864e5|7 \* 24 \* 3600_000/, "no duplicated 7-day constant in the picker");
  assert.match(seller, /data-testid="long-horizon-warning"/);
  assert.match(seller, /verdict\?\.long_horizon_warning \? <LongHorizonWarning \/> : null/);
  for (const file of ["src/app.ts", "src/deadline_policy.ts", "src/runtime_config.ts", "src/production_guards.ts"]) {
    assert.doesNotMatch(read(file), /LONG_HORIZON_DEALS_ENABLED|LONG_HORIZON_ENABLED|ALLOW_LONG_DEADLINE/, `${file} carries no ceiling-raising flag`);
  }
  assert.match(policy, /stored_payment_authority_proven: false/);
});

await app.close().catch(() => undefined);
console.log(`\nLONG_HORIZON_DEADLINE_POLICY passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
