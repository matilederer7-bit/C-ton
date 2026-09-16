// Distributor visit measurement: the 202 "recorded" answer must not escape
// before the recording transaction has COMMITTED.
//
// Regression for the intermittent stage32c failure (affiliate clicks expected
// 2, actual 1): POST /api/affiliate/links/visit used to call reply.send()
// INSIDE deps.withTx, so the client received its acknowledgement while the
// INSERT was still uncommitted. A caller that immediately read the dashboard
// (the test, or a real browser navigating on) could observe the previous
// count. Contention is reached by construction, not by sleeps: the second
// visit is parked at the db.before_commit block fault, and the suite asserts
// that its HTTP response has NOT been produced while the transaction is open.
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");
const { armTestFault, resetTestFaults } = await import("../src/fault_injection.js");

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms).unref());
}

function timeout<T>(ms: number, message: string): Promise<T> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms).unref());
}

async function createPublishedDeal() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const created = await app.inject({
    method: "POST",
    url: "/deals",
    headers: { "x-request-id": `visit-commit-create-${suffix}`, "idempotency-key": `visit-commit-create-${suffix}` },
    payload: {
      title: "Visit commit ordering",
      description: "Distributor measurement commit-before-response proof.",
      price_per_unit: 40,
      min_units: 2,
      max_units: 10,
      deadline: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
      delivery_options: [{ option_type: "delivery", label: "משלוח עד הבית", cost: 12, sort_order: 0 }]
    }
  });
  assert.equal(created.statusCode, 200, created.body);
  const dealId = (created.json() as any).deal_id as string;
  const published = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/publish`,
    headers: { "x-request-id": `visit-commit-publish-${suffix}`, "idempotency-key": `visit-commit-publish-${suffix}` },
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  });
  assert.equal(published.statusCode, 200, published.body);
  return dealId;
}

function visit(dealId: string, sourceCode: string, clickId: string) {
  return app.inject({
    method: "POST",
    url: "/api/affiliate/links/visit",
    payload: { deal_id: dealId, source_code: sourceCode, click_id: clickId, entry_id: "entry-visit-commit-shared" }
  });
}

async function linkClicks(sourceCode: string) {
  const response = await app.inject({ method: "GET", url: "/api/affiliate/overview" });
  assert.equal(response.statusCode, 200, response.body);
  const link = (response.json() as any).affiliate_surface.links.find((item: any) => item.source_code === sourceCode);
  assert.ok(link, "link missing from distributor overview");
  return Number(link.clicks);
}

async function main() {
  const dealId = await createPublishedDeal();
  const linkResponse = await app.inject({
    method: "POST",
    url: "/api/affiliate/links",
    payload: { deal_id: dealId, internal_name: "commit ordering link" }
  });
  assert.equal(linkResponse.statusCode, 201, linkResponse.body);
  const sourceCode = String((linkResponse.json() as any).link.source_code);

  const first = await visit(dealId, sourceCode, "click-visit-commit-0001");
  assert.equal(first.statusCode, 202, first.body);
  assert.equal((first.json() as any).recorded, true);
  assert.equal(await linkClicks(sourceCode), 1);

  // The visit route runs exactly ONE withTx, so the first db.before_commit hit
  // is the second visit, parked with its click row uncommitted.
  const barrier = armTestFault("db.before_commit", { kind: "block" });
  assert.ok(barrier, "block fault did not return a barrier");
  let released = false;
  const release = () => { if (!released) { released = true; barrier!.release(); } };
  try {
    const held = visit(dealId, sourceCode, "click-visit-commit-0002");
    await Promise.race([
      barrier!.entered,
      held.then((response) => { throw new Error(`held visit answered ${response.statusCode} ${response.body} before reaching the commit point`); }),
      timeout(20_000, "held visit never reached the commit point")
    ]);

    const early = await Promise.race([
      held.then((response) => ({ responded: true as const, status: response.statusCode, body: response.body })),
      delay(750, { responded: false as const })
    ]);
    const clicksWhileOpen = await linkClicks(sourceCode);
    assert.equal(clicksWhileOpen, 1, "uncommitted click leaked into the distributor overview");
    assert.equal(
      early.responded,
      false,
      `visit answered ${early.responded ? `${early.status} ${early.body}` : ""} before its transaction committed; a reader that trusted the acknowledgement saw clicks=${clicksWhileOpen}`
    );
    console.log("PASS visit acknowledgement is withheld until the recording transaction commits");

    release();
    const response = await held;
    assert.equal(response.statusCode, 202, response.body);
    assert.equal((response.json() as any).recorded, true);
    assert.equal(await linkClicks(sourceCode), 2);
    console.log("PASS committed click is visible to the very next read after the acknowledgement");
  } finally {
    release();
    resetTestFaults();
  }
}

main()
  .then(() => app.close())
  .catch(async (error) => {
    console.error(error);
    await app.close().catch(() => undefined);
    process.exit(1);
  });
