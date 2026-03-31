import assert from "node:assert/strict";
import { app } from "../src/app.js";

async function runTest(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function createDeal(title: string, suffix: string) {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const response = await app.inject({
    method: "POST",
    url: "/deals",
    headers: {
      "x-request-id": `product-surface-create-${unique}`,
      "idempotency-key": `product-surface-create-${unique}`
    },
    payload: {
      title,
      price_per_unit: 55,
      min_units: 10,
      max_units: 25,
      deadline: new Date(Date.now() + 45 * 60_000).toISOString(),
      commission_rate: 0.08
    }
  });

  assert.equal(response.statusCode, 200);
  return response.json() as { deal_id: string };
}

async function publishDeal(dealId: string, suffix: string) {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const response = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/publish`,
    headers: {
      "x-request-id": `product-surface-publish-${unique}`,
      "idempotency-key": `product-surface-publish-${unique}`
    },
    payload: {}
  });

  assert.equal(response.statusCode, 200);
}

async function joinDeal(dealId: string, buyerId: string, suffix: string) {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const response = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/join`,
    headers: {
      "x-request-id": `product-surface-join-${unique}`,
      "idempotency-key": `product-surface-join-${unique}`
    },
    payload: {
      buyer_id: buyerId,
      qty: 3
    }
  });

  assert.equal(response.statusCode, 200);
  return response.json() as { participant_id: string };
}

async function main() {
  await runTest("public marketplace discovery is exposed", async () => {
    const created = await createDeal("Marketplace Surface Deal", "market");
    await publishDeal(created.deal_id, "market");

    const response = await app.inject({
      method: "GET",
      url: "/api/marketplace/deals?q=Marketplace"
    });

    assert.equal(response.statusCode, 200);
    const payload = response.json() as any;
    assert.equal(payload.ok, true);
    assert.equal(payload.discovery_mode, "public-marketplace-expansion");
    assert.ok(payload.deals.some((deal: any) => deal.deal_id === created.deal_id));
  });

  await runTest("seller surface exposes draft and publish behavior", async () => {
    const created = await createDeal("Seller Surface Draft", "seller");

    const draftResponse = await app.inject({
      method: "GET",
      url: `/api/seller/deals/${created.deal_id}`
    });
    assert.equal(draftResponse.statusCode, 200);
    const draftPayload = draftResponse.json() as any;
    assert.equal(draftPayload.seller_actions.can_publish, true);
    assert.equal(draftPayload.seller_actions.edit_locked, false);

    await publishDeal(created.deal_id, "seller");

    const publishedResponse = await app.inject({
      method: "GET",
      url: `/api/seller/deals/${created.deal_id}`
    });
    assert.equal(publishedResponse.statusCode, 200);
    const publishedPayload = publishedResponse.json() as any;
    assert.equal(publishedPayload.seller_actions.can_publish, false);
    assert.equal(publishedPayload.seller_actions.edit_locked, true);
  });

  await runTest("affiliate and admin surfaces are reachable", async () => {
    const affiliate = await app.inject({ method: "GET", url: "/api/affiliate/overview" });
    assert.equal(affiliate.statusCode, 200);
    assert.ok(["ready_for_attribution", "active"].includes((affiliate.json() as any).affiliate_surface.attribution_status));

    const admin = await app.inject({ method: "GET", url: "/api/admin/overview?q=" });
    assert.equal(admin.statusCode, 200);
    assert.equal((admin.json() as any).ok, true);
  });

  await runTest("admin deal and user profiles align with stored buyer flow", async () => {
    const created = await createDeal("Admin Surface Deal", "admin");
    await publishDeal(created.deal_id, "admin");
    const joined = await joinDeal(created.deal_id, "0501112222", "admin");

    const dealProfile = await app.inject({
      method: "GET",
      url: `/api/admin/deals/${created.deal_id}/profile`
    });
    assert.equal(dealProfile.statusCode, 200);
    const dealPayload = dealProfile.json() as any;
    assert.equal(dealPayload.profile.deal.deal_id, created.deal_id);
    assert.ok(dealPayload.profile.participants.some((row: any) => row.participant_id === joined.participant_id));

    const userProfile = await app.inject({
      method: "GET",
      url: "/api/admin/users/0501112222/profile"
    });
    assert.equal(userProfile.statusCode, 200);
    const userPayload = userProfile.json() as any;
    assert.ok(userPayload.profile.joins.some((row: any) => row.participant_id === joined.participant_id));
  });

  await runTest("surface routes are delivered by the frontend shell", async () => {
    const urls = [
      "/app",
      "/app/seller",
      "/app/seller/new",
      "/app/affiliate",
      "/app/admin"
    ];

    for (const url of urls) {
      const response = await app.inject({ method: "GET", url });
      assert.equal(response.statusCode, 200, url);
      assert.match(response.body, /\/app\/assets\/app\.js/);
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
