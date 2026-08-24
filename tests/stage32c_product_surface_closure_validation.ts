import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.ADMIN_API_KEY = "stage32c-product-surface-admin-key";

const ADMIN_HEADERS = { "x-admin-key": "stage32c-product-surface-admin-key" };
const { app } = await import("../src/app.js");

async function run(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function createPublishedDeal() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const created = await app.inject({
    method: "POST",
    url: "/deals",
    headers: {
      "x-request-id": `stage32c-create-${suffix}`,
      "idempotency-key": `stage32c-create-${suffix}`
    },
    payload: {
      title: "Stage 32C attribution surface",
      description: "Seller-provided marketing copy for the distributor asset surface.",
      price_per_unit: 75,
      min_units: 4,
      max_units: 12,
      deadline: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
      delivery_options: [{ option_type: "delivery", label: "משלוח עד הבית", cost: 15, sort_order: 0 }]
    }
  });
  assert.equal(created.statusCode, 200, created.body);
  const dealId = (created.json() as any).deal_id as string;
  const published = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/publish`,
    headers: {
      "x-request-id": `stage32c-publish-${suffix}`,
      "idempotency-key": `stage32c-publish-${suffix}`
    },
    payload: {
      seller_terms_accepted: true,
      seller_critical_terms_accepted: true,
      seller_threshold_90_accepted: true
    }
  });
  assert.equal(published.statusCode, 200, published.body);
  return dealId;
}

function collectKeys(value: unknown, into = new Set<string>()) {
  if (!value || typeof value !== "object") return into;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return into;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    into.add(key);
    collectKeys(child, into);
  }
  return into;
}

async function main() {
  const frontend = await readFile(join(process.cwd(), "frontend", "app.js"), "utf8");
  const styles = await readFile(join(process.cwd(), "frontend", "styles.css"), "utf8");
  const runtime = await readFile(join(process.cwd(), "src", "frontend_runtime.ts"), "utf8");
  const migration = await readFile(join(process.cwd(), "src", "migrations", "046_distributor_measurement_surfaces.sql"), "utf8");

  await run("buyer safe resume persists only non-sensitive journey context", () => {
    const start = frontend.indexOf("function safeResumeProjection");
    const end = frontend.indexOf("function writeSafeResume", start);
    assert.ok(start >= 0 && end > start);
    const projection = frontend.slice(start, end);
    assert.match(projection, /dealTitle.*qty.*deliveryOptionId/s);
    assert.doesNotMatch(projection, /phone|otpToken|otpSessionId|developmentCode|trackingAccessToken|payment_method|authorizationId|buyerId|participantId/i);
    assert.match(frontend, /readSafeResume\(dealId\)/);
    assert.match(frontend, /SAFE_RESUME_TTL_MS/);
  });

  await run("seller full preview reuses the public renderer with all side effects disabled", () => {
    assert.match(frontend, /function renderCtonDealPage\(\)[\s\S]*renderCtonDealPageView\(\)/);
    assert.match(frontend, /renderCtonDealPageView\(buildSellerPreviewPayload\(\), \{ preview: true \}\)/);
    assert.match(frontend, /אותו renderer ציבורי/);
    assert.match(frontend, /preview \|\| !availability\.canJoin \? "disabled"/);
    assert.match(frontend, /לא נוצרה עסקה, לא בוצע פרסום/);
    assert.match(styles, /\.seller-preview-dialog/);
  });

  await run("distributor persistence is measurement-only and contains no money entitlement", () => {
    assert.match(migration, /CREATE TABLE IF NOT EXISTS siton\.affiliate_links/);
    assert.match(migration, /CREATE TABLE IF NOT EXISTS siton\.affiliate_link_events/);
    assert.match(migration, /event_type IN \('click','entry'\)/);
    const ddlWithoutComments = migration.replace(/--.*$/gm, "");
    assert.doesNotMatch(ddlWithoutComments, /commission|wallet|withdrawal|payout|balance|invoice/i);
    assert.match(runtime, /app\.post\("\/api\/affiliate\/links"/);
    assert.match(runtime, /app\.post\("\/api\/affiliate\/links\/visit"/);
    assert.match(runtime, /resolveDistributorContext\(req, c, deps\.isDemoPreview\)/);
    assert.match(runtime, /client_distributor_identity_forbidden/);
    assert.match(runtime, /distributor_auth_required/);
    assert.match(frontend, /payload\.capabilities\?\.named_link_creation/);
  });

  const dealId = await createPublishedDeal();
  let sourceCode = "";

  await run("distributor can create a named unique link for an allowed deal", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/affiliate/links",
      payload: { deal_id: dealId, internal_name: "קבוצת בדיקת Stage 32C" }
    });
    assert.equal(response.statusCode, 201, response.body);
    const body = response.json() as any;
    sourceCode = String(body.link.source_code);
    assert.ok(sourceCode.length >= 8);
    assert.match(body.link.share_link, new RegExp(`/app/deal/${dealId}\\?ref=`));
  });

  await run("anonymous visit measurement deduplicates entries without collecting PII", async () => {
    for (const clickId of ["click-stage32c-0001", "click-stage32c-0002"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/affiliate/links/visit",
        payload: {
          deal_id: dealId,
          source_code: sourceCode,
          click_id: clickId,
          entry_id: "entry-stage32c-shared"
        }
      });
      assert.equal(response.statusCode, 202, response.body);
      assert.equal((response.json() as any).recorded, true);
    }
  });

  await run("distributor dashboard returns all four product areas and no financial entitlement keys", async () => {
    const response = await app.inject({ method: "GET", url: "/api/affiliate/overview" });
    assert.equal(response.statusCode, 200, response.body);
    const surface = (response.json() as any).affiliate_surface;
    const link = surface.links.find((item: any) => item.source_code === sourceCode);
    const campaign = surface.campaigns.find((item: any) => item.deal_id === dealId);
    assert.equal(link.clicks, 2);
    assert.equal(link.entries, 1);
    assert.equal(link.conversion_rate, 0);
    assert.equal(typeof surface.totals.attributed_gross, "number");
    assert.equal(campaign.description, "Seller-provided marketing copy for the distributor asset surface.");
    assert.deepEqual(campaign.delivery_labels, ["משלוח עד הבית"]);
    const keys = collectKeys(surface);
    for (const forbidden of ["commission", "balance", "wallet", "withdrawal", "payout", "invoice", "financial_entitlement"]) {
      assert.equal(keys.has(forbidden), false, `forbidden distributor key present: ${forbidden}`);
    }
  });

  await run("admin overview omnisearch keeps heterogeneous states text-safe", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/admin/overview?q=${encodeURIComponent(dealId)}`,
      headers: ADMIN_HEADERS
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as any;
    assert.equal(body.q, dealId);
    assert.ok(body.admin_surface.search_results.some((item: any) => item.entity_type === "deal" && item.entity_id === dealId));
  });

  await run("frontend closes distributor navigation, performance, assets and admin hierarchy", () => {
    for (const marker of ["affiliate-dashboard", "affiliate-links", "affiliate-performance", "affiliate-assets", "marketing-assets-grid"]) {
      assert.match(frontend, new RegExp(marker));
    }
    for (const marker of ["admin-urgent", "admin-search", "admin-kyc", "admin-support", "admin-system"]) {
      assert.match(frontend, new RegExp(marker));
    }
    assert.match(styles, /@media \(max-width: 768px\)/);
    assert.match(frontend, /\/api\/mall\/deals/);
    assert.doesNotMatch(frontend, /\/app\/(marketplace|mall|catalog|discover)/);
  });
}

main()
  .then(() => app.close())
  .catch(async (error) => {
    console.error(error);
    await app.close().catch(() => undefined);
    process.exit(1);
  });
