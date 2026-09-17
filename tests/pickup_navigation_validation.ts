// Pickup navigation truth — Google Maps + Waze to the SAME stored truth.
//
// Ported from the shelf branch claude/launch-ux-cleanup (Sprint 4, A1) onto
// current master. A buyer is never sent to an invented point: explicit
// coordinates → both apps navigate to those coordinates; address text only →
// both apps get an ADDRESS SEARCH of the seller's text and the UI says so; a
// generic label ("איסוף עצמי") never becomes a navigation target.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  PICKUP_NAV_MODE_COPY, PICKUP_PRECISION_COPY, describePickupLocation, pickupNavigation, pickupPrecision, pickupWazeUrl
} from "../src/pickup_location.js";
import { pickupLocationOf } from "../src/physical_fulfillment.js";

async function runTest(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

await runTest("exact coordinates: Google Maps and Waze carry the same pin", () => {
  const option = { option_type: "pickup", label: "חנות הספרים — הרצל 12, תל אביב", latitude: 32.0668, longitude: 34.7647 };
  const nav = pickupNavigation(option);
  assert.deepEqual(nav, {
    exact: true, mode: "coordinates",
    google_maps_url: "https://www.google.com/maps/dir/?api=1&destination=32.0668%2C34.7647",
    waze_url: "https://waze.com/ul?ll=32.0668%2C34.7647&navigate=yes"
  });
  assert.equal(pickupPrecision(option), "exact");
  assert.equal(pickupWazeUrl(option), nav!.waze_url);
  assert.equal(PICKUP_NAV_MODE_COPY[nav!.mode], "נקודה מדויקת");
});

await runTest("address text only: both apps search the seller's real text, never a fabricated pin", () => {
  const option = { option_type: "distribution_point", label: "רח׳ הרצל 12, תל אביב — חנות הקפה", latitude: null, longitude: null };
  const nav = pickupNavigation(option);
  assert.equal(nav?.exact, false);
  assert.equal(nav?.mode, "address_search");
  const q = encodeURIComponent("רח׳ הרצל 12, תל אביב — חנות הקפה");
  assert.equal(nav?.google_maps_url, `https://www.google.com/maps/dir/?api=1&destination=${q}`);
  assert.equal(nav?.waze_url, `https://waze.com/ul?q=${q}&navigate=yes`);
  assert.equal(pickupPrecision(option), "address");
  assert.equal(pickupWazeUrl(option), null, "no coordinate deep link without coordinates");
  assert.match(PICKUP_PRECISION_COPY.address, /כתובת בלבד/);
});

await runTest("generic label or delivery option: no navigation target at all", () => {
  assert.equal(pickupNavigation({ option_type: "pickup", label: "איסוף עצמי" }), null);
  assert.equal(pickupPrecision({ option_type: "pickup", label: "איסוף עצמי" }), "none");
  assert.equal(pickupNavigation({ option_type: "delivery", label: "שליח עד הבית", latitude: 32.1, longitude: 34.8 }), null, "a delivery option never navigates");
  const described = describePickupLocation({ option_type: "pickup", label: "  " });
  assert.equal(described.precision, "none");
  assert.equal(described.navigation, null);
  assert.equal(described.has_location, false);
});

await runTest("public/seller projection and the buyer tracking card share one navigation truth", async () => {
  const option = { option_type: "pickup", label: "מרכז מסחרי, נתניה", latitude: 32.3215, longitude: 34.8532 };
  const described = describePickupLocation(option);
  assert.equal(described.precision, "exact");
  assert.equal(described.navigation?.google_maps_url, "https://www.google.com/maps/dir/?api=1&destination=32.3215%2C34.8532");
  const order: any = {
    participant_id: "p", deal_id: "d", deal_title: "מוצר", seller_id: "s", qty: 1, buyer_name: "קונה", buyer_phone: "0500000000", buyer_email: null,
    buyer_state: "ChargedSuccess", money_state: "ChargedSuccess", deal_state: "Completed", deal_type: "physical_product",
    delivery_method_type: "pickup", delivery_method_label: "איסוף עצמי", delivery_address: null, delivery_city: null, delivery_notes: null,
    pickup_option: option, fulfillment_status: "pending", fulfilled_at: null, fulfilled_by: null, order_code: "AB12CD", order_code_hash: null
  };
  const loc = pickupLocationOf(order);
  assert.equal(loc.navigation?.mode, "coordinates");
  assert.equal(loc.navigation?.waze_url, described.navigation?.waze_url);
  const fulfillment = await readFile("src/physical_fulfillment.ts", "utf8");
  assert.match(fulfillment, /pickup_navigation: method === "pickup" \? location\.navigation : null/, "buyer tracking projects the same navigation (pickup method only)");
  // a generic label still shows as the label but never navigates
  const generic = pickupLocationOf({ ...order, pickup_option: { option_type: "pickup", label: "איסוף עצמי", latitude: null, longitude: null } });
  assert.equal(generic.text, "איסוף עצמי");
  assert.equal(generic.navigation, null);
});

await runTest("React buyer + seller surfaces render the one navigation component", async () => {
  const [dealPage, pickupCard, sellerPage, css] = await Promise.all([
    readFile("web/src/pages/deal.tsx", "utf8"), readFile("web/src/pickupCard.tsx", "utf8"),
    readFile("web/src/pages/seller.tsx", "utf8"), readFile("web/src/styles.css", "utf8")
  ]);
  assert.match(dealPage, /export function PickupNavActions/);
  assert.match(dealPage, /data-testid=\{testIdPrefix\}[^>]*href=\{navigation\.google_maps_url\}/, "Google Maps link keeps the pickup-nav test id");
  assert.match(dealPage, /data-testid=\{`\$\{testIdPrefix\}-waze`\}[^>]*href=\{navigation\.waze_url\}/);
  assert.match(dealPage, /PICKUP_NAV_MODE_COPY\[navigation\.mode\]/, "the mode line is rendered from the shared copy");
  assert.doesNotMatch(dealPage, /פתח במפה/, "the lone 'open in map' button is gone");
  assert.doesNotMatch(dealPage, /pickupDirectionsUrl/, "no second URL builder on the public page");
  assert.match(pickupCard, /<PickupNavActions navigation=\{pickup\.pickup_navigation\} testIdPrefix="track-pickup-nav" \/>/, "tracking card uses the same renderer");
  assert.match(sellerPage, /data-testid=\{`pickup-precision-\$\{pickupPrecision\(o\)\}`\}/, "seller sees exact vs address-only precision");
  assert.match(sellerPage, /PICKUP_PRECISION_COPY\[pickupPrecision\(o\)\]/);
  assert.match(css, /\.pickup-nav-actions \.btn \{ min-height: 44px; \}/, "navigation buttons are touch targets");
});

console.log("PICKUP_NAVIGATION_VALIDATION_PASS");
