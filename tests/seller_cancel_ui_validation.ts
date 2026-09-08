// LAUNCH POLISH (P2) — SELLER CANCEL: the React caller exists, the server stays
// the authority, and cancel can never silently behave as pause.
//
// Proves (API level, demo-preview seller identities, disposable database):
//   * seller_actions.can_cancel mirrors the canonical DEAL_TRANSITIONS table
//     (Cancelled is reachable from Draft only) and is false once live
//   * allowed cancel: Draft → Cancelled with exactly one deal.cancel audit row
//   * double click / idempotency: the SAME intent key replays the first answer
//     without a second transition; a NEW key after cancellation is a 409
//     STATE_CONFLICT (never a 500)
//   * refused cancel: a live deal answers 409 STATE_CONFLICT with the state
//     untouched — in particular NOT ClosedForJoining (cancel ≠ pause), no audit
//     row, no cancel_refund outbox row
//   * pause vs cancel: pause → ClosedForJoining (manual, reopenable); cancel on a
//     paused deal is refused and the pause stays reopenable
//   * ownership isolation: seller B cannot cancel seller A's draft (404, untouched)
//   * the React product carries the caller (static regression on the sources)

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

process.env.APP_DEPLOYMENT_MODE = process.env.APP_DEPLOYMENT_MODE || "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || `cancel-ui-admin-${randomUUID().slice(0, 8)}`;

const { app, DEAL_TRANSITIONS } = await import("../src/app.js");
await app.ready();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 4
});

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e?.stack || e?.message || e}`); failed++; }
}

const tag = randomUUID().slice(0, 8);
const sellerA = `seller-cancel-a-${tag}`;
const sellerB = `seller-cancel-b-${tag}`;
const H = (seller: string, extra: Record<string, string> = {}) => ({ "x-seller-id": seller, "content-type": "application/json", ...extra });
const deadline = () => new Date(Date.now() + 3 * 864e5).toISOString();
async function createDeal(seller: string) {
  const res = await app.inject({
    method: "POST", url: "/deals", headers: H(seller, { "idempotency-key": `cancel-ui-${randomUUID().slice(0, 12)}` }),
    payload: {
      title: `עסקת ביטול ${tag}`, description_short: "בדיקת ביטול", price_per_unit: 40, min_units: 4, max_units: 20,
      deadline: deadline(), deal_type: "physical_product",
      delivery_options: [{ option_type: "pickup", label: "הרצל 12, תל אביב", cost: 0, sort_order: 0, latitude: 32.0668, longitude: 34.7647 }]
    }
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  return String(body.deal?.deal_id || body.deal_id);
}
const cancel = (seller: string, dealId: string, key: string) =>
  app.inject({ method: "POST", url: `/api/deals/${dealId}/cancel`, headers: H(seller, { "idempotency-key": key }), payload: {} });
const sellerView = async (seller: string, dealId: string) => {
  const res = await app.inject({ method: "GET", url: `/api/seller/deals/${dealId}`, headers: H(seller) });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as any;
};
const dbState = async (dealId: string) => String((await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [dealId])).rows[0].state);
const cancelAudits = async (dealId: string) =>
  Number((await pool.query(`SELECT COUNT(*)::int AS n FROM siton.audit_log WHERE deal_id=$1 AND action_name='deal.cancel'`, [dealId])).rows[0].n);
const cancelRefunds = async (dealId: string) =>
  Number((await pool.query(`SELECT COUNT(*)::int AS n FROM siton.outbox_events WHERE aggregate_id=$1 AND event_type='cancel_refund'`, [dealId])).rows[0].n);
const publish = (seller: string, dealId: string) => app.inject({
  method: "POST", url: `/deals/${dealId}/publish`, headers: H(seller, { "idempotency-key": `cancel-ui-pub-${randomUUID().slice(0, 8)}` }),
  payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
});
async function readySeller(seller: string) {
  const bp = await app.inject({
    method: "PUT", url: "/api/seller/business-profile", headers: H(seller),
    payload: { business_name: `עסק ${seller}`, business_id_number: "515000002", contact_name: "בודק", contact_phone: "0501234567" }
  });
  assert.equal(bp.statusCode, 200, bp.body);
}

await run("the canonical state machine reaches Cancelled from Draft only, and can_cancel mirrors it", async () => {
  const table = DEAL_TRANSITIONS as Record<string, string[]>;
  const cancellable = Object.keys(table).filter((s) => table[s]!.includes("Cancelled"));
  assert.deepEqual(cancellable, ["Draft"], "financial state machine unchanged: Cancelled only from Draft");
  const dealId = await createDeal(sellerA);
  const view = await sellerView(sellerA, dealId);
  assert.equal(view.seller_actions.can_cancel, table[String(view.deal.state)]!.includes("Cancelled"));
  assert.equal(view.seller_actions.can_cancel, true);
});

let draftId = "";
await run("allowed cancel: Draft → Cancelled, exactly one audit row, seller view refreshes to the final state", async () => {
  draftId = await createDeal(sellerA);
  const key = `intent-${randomUUID()}`;
  const res = await cancel(sellerA, draftId, key);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await dbState(draftId), "Cancelled");
  assert.equal(await cancelAudits(draftId), 1);
  const view = await sellerView(sellerA, draftId);
  assert.equal(view.deal.state, "Cancelled");
  assert.equal(view.seller_actions.can_cancel, false);
  assert.equal(view.seller_actions.can_publish, false);
});

await run("double click / retry: the same intent key replays; a new key after cancellation is a 409, never a 500", async () => {
  const dealId = await createDeal(sellerA);
  const key = `intent-${randomUUID()}`;
  const [r1, r2] = await Promise.all([cancel(sellerA, dealId, key), cancel(sellerA, dealId, key)]);
  const statuses = [r1.statusCode, r2.statusCode].sort();
  assert.ok(statuses.every((s) => s === 200 || s === 409), `double click answered ${statuses}`);
  assert.ok(statuses.includes(200), "one of the two must act");
  const r3 = await cancel(sellerA, dealId, key);
  assert.equal(r3.statusCode, 200, `replay of the same intent: ${r3.body}`);
  assert.equal(await dbState(dealId), "Cancelled");
  assert.equal(await cancelAudits(dealId), 1, "exactly one transition for one intent");
  const fresh = await cancel(sellerA, dealId, `intent-${randomUUID()}`);
  assert.equal(fresh.statusCode, 409, fresh.body);
  assert.equal((fresh.json() as any).code, "STATE_CONFLICT");
  assert.equal(await cancelAudits(dealId), 1);
});

let liveId = "";
await run("refused cancel: a LIVE deal answers 409 STATE_CONFLICT and stays exactly as it was (cancel ≠ pause)", async () => {
  await readySeller(sellerA);
  liveId = await createDeal(sellerA);
  const pub = await publish(sellerA, liveId);
  assert.equal(pub.statusCode, 200, pub.body);
  assert.equal(await dbState(liveId), "PendingTarget");
  const view = await sellerView(sellerA, liveId);
  assert.equal(view.seller_actions.can_cancel, false);
  const res = await cancel(sellerA, liveId, `intent-${randomUUID()}`);
  assert.equal(res.statusCode, 409, res.body);
  const body = res.json() as any;
  assert.equal(body.code, "STATE_CONFLICT");
  assert.equal(body.ok, false);
  assert.equal(await dbState(liveId), "PendingTarget", "a refused cancel must not close, pause or otherwise touch the deal");
  assert.equal(await cancelAudits(liveId), 0);
  assert.equal(await cancelRefunds(liveId), 0);
  const pub2 = await app.inject({ method: "GET", url: `/api/deals/${liveId}/public` });
  assert.equal((pub2.json() as any).deal.state, "PendingTarget");
});

await run("pause vs cancel: pause is reversible and honest; cancel on a paused deal is refused; reopen still works", async () => {
  const pause = await app.inject({ method: "POST", url: `/api/deals/${liveId}/close_joining`, headers: H(sellerA, { "idempotency-key": `pause-${randomUUID()}` }), payload: {} });
  assert.equal(pause.statusCode, 200, pause.body);
  assert.equal(await dbState(liveId), "ClosedForJoining");
  const row = await pool.query(`SELECT close_reason FROM siton.deals WHERE deal_id=$1`, [liveId]);
  assert.equal(row.rows[0].close_reason, "manual");
  const res = await cancel(sellerA, liveId, `intent-${randomUUID()}`);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal((res.json() as any).code, "STATE_CONFLICT");
  assert.equal(await dbState(liveId), "ClosedForJoining", "refused cancel leaves the pause in place");
  assert.equal(await cancelAudits(liveId), 0);
  const reopen = await app.inject({ method: "POST", url: `/api/deals/${liveId}/reopen_joining`, headers: H(sellerA, { "idempotency-key": `reopen-${randomUUID()}` }), payload: {} });
  assert.equal(reopen.statusCode, 200, reopen.body);
  assert.equal(await dbState(liveId), "PendingTarget");
});

await run("ownership isolation: seller B cannot cancel seller A's draft (404, untouched); A still can", async () => {
  const dealId = await createDeal(sellerA);
  const res = await cancel(sellerB, dealId, `intent-${randomUUID()}`);
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(await dbState(dealId), "Draft");
  assert.equal(await cancelAudits(dealId), 0);
  const own = await cancel(sellerA, dealId, `intent-${randomUUID()}`);
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(await dbState(dealId), "Cancelled");
});

await run("the React seller product carries the cancel caller with a confirmation that distinguishes cancel from pause", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..", "..");
  const apiSrc = readFileSync(join(root, "web", "src", "api.ts"), "utf8");
  const sellerSrc = readFileSync(join(root, "web", "src", "pages", "seller.tsx"), "utf8");
  assert.match(apiSrc, /cancelDeal:[\s\S]*?\/api\/deals\/\$\{id\}\/cancel[\s\S]*?idempotency-key/, "api.cancelDeal → POST /api/deals/:id/cancel with an idempotency key");
  assert.match(sellerSrc, /data-testid="deal-cancel-open"/, "cancel entry point");
  assert.match(sellerSrc, /data-testid="deal-cancel-confirm"/, "explicit confirmation");
  assert.match(sellerSrc, /data-testid="cancel-vs-pause"/, "cancel vs pause explained inside the confirmation");
  assert.match(sellerSrc, /data-testid="cancel-refused"/, "server refusal is surfaced, not swallowed");
  assert.match(sellerSrc, /STATE_CONFLICT/, "the refusal code is mapped to actionable Hebrew");
  assert.match(sellerSrc, /await load\(\);\s*\/\/ refresh the seller state immediately after success/, "seller state refreshes after success");
  // the confirmation never claims a payment consequence
  const confirm = sellerSrc.slice(sellerSrc.indexOf("confirmCancel ? ("), sellerSrc.indexOf("<Toast msg={toast} />\n    </>\n  );\n}\n\n// ── business onboarding"));
  assert.ok(confirm.length > 200, "confirmation block located");
  assert.doesNotMatch(confirm, /החזר|זיכוי|refund/i, "no invented financial consequence in the cancel copy");
});

await pool.end();
await app.close();
console.log(`\nSELLER_CANCEL_UI passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
