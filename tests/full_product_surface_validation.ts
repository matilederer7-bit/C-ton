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

async function createDeal(title: string, suffix: string, seller?: { seller_id?: string; display_name?: string }) {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const response = await app.inject({
    method: "POST",
    url: "/deals",
    headers: {
      ...(seller?.seller_id
        ? {
            "x-seller-id": seller.seller_id,
            "x-seller-display-name": seller.display_name || seller.seller_id
          }
        : {}),
      "x-request-id": `product-surface-create-${unique}`,
      "idempotency-key": `product-surface-create-${unique}`
    },
    payload: {
      title,
      price_per_unit: 55,
      min_units: 10,
      max_units: 25,
      deadline: new Date(Date.now() + 45 * 60_000).toISOString(),
      commission_rate: 0.08,
      delivery_options: [
        { option_type: "pickup", label: "Self pickup", cost: 0, sort_order: 0 },
        { option_type: "delivery", label: "Courier", cost: 18, sort_order: 1 }
      ]
    }
  });

  assert.equal(response.statusCode, 200);
  return response.json() as { deal_id: string };
}

async function publishDeal(dealId: string, suffix: string, seller?: { seller_id?: string; display_name?: string }) {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const response = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/publish`,
    headers: {
      ...(seller?.seller_id
        ? {
            "x-seller-id": seller.seller_id,
            "x-seller-display-name": seller.display_name || seller.seller_id
          }
        : {}),
      "x-request-id": `product-surface-publish-${unique}`,
      "idempotency-key": `product-surface-publish-${unique}`
    },
    payload: {}
  });

  assert.equal(response.statusCode, 200);
}

async function joinDeal(dealId: string, buyerId: string, suffix: string, deliveryOptionId?: string) {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  let selectedDeliveryOptionId = deliveryOptionId;
  if (!selectedDeliveryOptionId) {
    const publicResponse = await app.inject({
      method: "GET",
      url: `/api/deals/${dealId}/public`
    });
    assert.equal(publicResponse.statusCode, 200);
    const publicPayload = publicResponse.json() as any;
    selectedDeliveryOptionId = publicPayload.deal.delivery_options[0]?.option_id;
  }
  const response = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/join`,
    headers: {
      "x-request-id": `product-surface-join-${unique}`,
      "idempotency-key": `product-surface-join-${unique}`
    },
    payload: {
      buyer_id: buyerId,
      qty: 3,
      delivery_option_id: selectedDeliveryOptionId
    }
  });

  assert.equal(response.statusCode, 200);
  return response.json() as {
    participant_id: string;
    delivery_method_label?: string;
    delivery_cost?: number;
    hold_total?: number;
  };
}

async function main() {
  await runTest("main site exposes link-first product direction", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/site/home"
    });

    assert.equal(response.statusCode, 200);
    const payload = response.json() as any;
    assert.equal(payload.ok, true);
    assert.equal(payload.site.product_direction, "link-first-group-deals");
    assert.equal(payload.site.seller_entry.create_deal_url, "/app/seller/new");
  });

  await runTest("public marketplace discovery is removed from the current direction", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/marketplace/deals?q=Marketplace"
    });

    assert.equal(response.statusCode, 410);
    const payload = response.json() as any;
    assert.equal(payload.code, "PUBLIC_MARKETPLACE_REMOVED");
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
    assert.equal(draftPayload.delivery_options.length, 2);

    await publishDeal(created.deal_id, "seller");

    const publishedResponse = await app.inject({
      method: "GET",
      url: `/api/seller/deals/${created.deal_id}`
    });
    assert.equal(publishedResponse.statusCode, 200);
    const publishedPayload = publishedResponse.json() as any;
    assert.equal(publishedPayload.seller_actions.can_publish, false);
    assert.equal(publishedPayload.seller_actions.edit_locked, true);
    assert.equal(publishedPayload.seller_profile.direct_link, `/app/deal/${created.deal_id}`);
    assert.equal(publishedPayload.delivery_options[1].label, "Courier");
  });

  await runTest("seller context creates and isolates deals under the active seller identity", async () => {
    const sellerAlpha = { seller_id: "seller-alpha", display_name: "Seller Alpha" };
    const sellerBeta = { seller_id: "seller-beta", display_name: "Seller Beta" };

    const alphaContext = await app.inject({
      method: "POST",
      url: "/api/seller/context",
      payload: sellerAlpha
    });
    assert.equal(alphaContext.statusCode, 200);
    assert.equal((alphaContext.json() as any).seller_context.seller_id, "seller-alpha");

    const alphaDeal = await createDeal("Alpha Owned Deal", "seller-alpha", sellerAlpha);
    const betaDeal = await createDeal("Beta Owned Deal", "seller-beta", sellerBeta);
    await publishDeal(alphaDeal.deal_id, "seller-alpha", sellerAlpha);

    const alphaWorkspace = await app.inject({
      method: "GET",
      url: "/api/seller/deals",
      headers: {
        "x-seller-id": sellerAlpha.seller_id,
        "x-seller-display-name": sellerAlpha.display_name
      }
    });
    assert.equal(alphaWorkspace.statusCode, 200);
    const alphaPayload = alphaWorkspace.json() as any;
    assert.equal(alphaPayload.seller_surface.seller_profile.seller_id, "seller-alpha");
    assert.equal(alphaPayload.seller_surface.seller_profile.display_name, "Seller Alpha");
    assert.ok(alphaPayload.seller_surface.deals.some((row: any) => row.deal_id === alphaDeal.deal_id));
    assert.ok(!alphaPayload.seller_surface.deals.some((row: any) => row.deal_id === betaDeal.deal_id));

    const wrongSellerView = await app.inject({
      method: "GET",
      url: `/api/seller/deals/${alphaDeal.deal_id}`,
      headers: {
        "x-seller-id": sellerBeta.seller_id,
        "x-seller-display-name": sellerBeta.display_name
      }
    });
    assert.equal(wrongSellerView.statusCode, 404);

    const wrongSellerPublish = await app.inject({
      method: "POST",
      url: `/deals/${alphaDeal.deal_id}/publish`,
      headers: {
        "x-seller-id": sellerBeta.seller_id,
        "x-seller-display-name": sellerBeta.display_name,
        "x-request-id": "wrong-seller-publish",
        "idempotency-key": `wrong-seller-publish:${alphaDeal.deal_id}`
      },
      payload: {}
    });
    assert.equal(wrongSellerPublish.statusCode, 404);
  });

  await runTest("same buyer can join the same deal multiple times while inventory is enforced globally", async () => {
    const created = await createDeal("Repeat Join Deal", "repeat");
    await publishDeal(created.deal_id, "repeat");
    const dealPublic = await app.inject({ method: "GET", url: `/api/deals/${created.deal_id}/public` });
    const publicPayload = dealPublic.json() as any;
    const pickupOption = publicPayload.deal.delivery_options.find((row: any) => row.option_type === "pickup");
    const deliveryOption = publicPayload.deal.delivery_options.find((row: any) => row.option_type === "delivery");

    const first = await joinDeal(created.deal_id, "0503334444", "repeat-a", pickupOption.option_id);
    const second = await joinDeal(created.deal_id, "0503334444", "repeat-b", deliveryOption.option_id);
    assert.notEqual(first.participant_id, second.participant_id);

    const userProfile = await app.inject({
      method: "GET",
      url: "/api/admin/users/0503334444/profile"
    });
    assert.equal(userProfile.statusCode, 200);
    const payload = userProfile.json() as any;
    const dealJoins = payload.profile.joins.filter((row: any) => row.deal_id === created.deal_id);
    assert.equal(dealJoins.length, 2);
  });

  await runTest("delivery method persists into public deal, join, tracking, and seller management", async () => {
    const created = await createDeal("Delivery Persistence Deal", "delivery");
    await publishDeal(created.deal_id, "delivery");

    const publicResponse = await app.inject({
      method: "GET",
      url: `/api/deals/${created.deal_id}/public`
    });
    assert.equal(publicResponse.statusCode, 200);
    const publicPayload = publicResponse.json() as any;
    assert.equal(publicPayload.deal.delivery_options.length, 2);
    const courierOption = publicPayload.deal.delivery_options.find((row: any) => row.label === "Courier");
    assert.ok(courierOption);

    const joined = await joinDeal(created.deal_id, "0509991111", "delivery", courierOption.option_id);
    assert.equal(joined.delivery_method_label, "Courier");
    assert.equal(Number(joined.delivery_cost), 18);
    assert.equal(Number(joined.hold_total), 183);

    const tracking = await app.inject({
      method: "GET",
      url: `/api/participants/${joined.participant_id}/tracking`
    });
    assert.equal(tracking.statusCode, 200);
    const trackingPayload = tracking.json() as any;
    assert.equal(trackingPayload.tracking.delivery_method_label, "Courier");
    assert.equal(Number(trackingPayload.tracking.delivery_cost), 18);
    assert.equal(Number(trackingPayload.tracking.estimated_total), 183);

    const sellerView = await app.inject({
      method: "GET",
      url: `/api/seller/deals/${created.deal_id}`
    });
    assert.equal(sellerView.statusCode, 200);
    const sellerPayload = sellerView.json() as any;
    const sellerParticipant = sellerPayload.participants.find((row: any) => row.participant_id === joined.participant_id);
    assert.equal(sellerParticipant.delivery_method_label, "Courier");
    assert.equal(Number(sellerParticipant.delivery_cost), 18);
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
      "/app/terms",
      "/app/privacy",
      "/app/refunds",
      "/app/contact",
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
