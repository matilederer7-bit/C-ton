import assert from "node:assert/strict";
import {
  MALL_STATES_BY_STATUS,
  PUBLIC_MALL_DEAL_FIELDS,
  MallQueryError,
  buildMallDiscoveryQuery,
  buildMallListEnvelope,
  encodeMallCursor,
  deriveMallAvailability,
  isMallEligible,
  mallStatusForState,
  parseMallQuery,
  projectMallRow,
  sanitizeMallEvent
} from "../src/mall_read_model.js";

assert.equal(mallStatusForState("Draft"), null);
assert.equal(mallStatusForState("PendingTarget"), "underway");
for (const state of ["TargetReached", "ClosedForJoining", "ReadyForCharging", "Charging", "CompletionWindow"]) {
  assert.equal(mallStatusForState(state), "reached_target");
}
assert.equal(mallStatusForState("Completed"), "succeeded");
assert.equal(mallStatusForState("Failed"), "failed");
assert.equal(mallStatusForState("Cancelled"), "cancelled");
assert.deepEqual(MALL_STATES_BY_STATUS.underway, ["PendingTarget"]);

assert.equal(isMallEligible({ state: "Draft", published_at: "2026-08-01T00:00:00Z" }), false);
assert.equal(isMallEligible({ state: "PendingTarget", published_at: null }), false);
assert.equal(isMallEligible({ state: "PendingTarget", published_at: "2026-08-01T00:00:00Z" }), true);

assert.deepEqual(parseMallQuery({}), {
  deal_type: null,
  status: "all",
  sort: "newest",
  limit: 24,
  page: 1,
  offset: 0,
  cursor: null,
  pagination_mode: "page"
});
assert.deepEqual(parseMallQuery({ type: "voucher", status: "succeeded", sort: "oldest", limit: "48", page: "3" }), {
  deal_type: "voucher",
  status: "succeeded",
  sort: "oldest",
  limit: 48,
  page: 3,
  offset: 96,
  cursor: null,
  pagination_mode: "page"
});
for (const invalid of [
  { type: "anything" },
  { status: "Draft" },
  { sort: "random" },
  { limit: "49" },
  { page: "0" },
  { page: "1 OR 1=1" }
]) {
  assert.throws(() => parseMallQuery(invalid), MallQueryError);
}

const maliciousType = "voucher'); DROP TABLE siton.deals; --";
assert.throws(() => parseMallQuery({ type: maliciousType }), MallQueryError);
const query = parseMallQuery({ type: "ticket", status: "underway", sort: "oldest", page: "2", limit: "10" });
const built = buildMallDiscoveryQuery(query);
assert.equal(built.values[1], "ticket");
assert.equal(built.values[2], 11);
assert.equal(built.values[3], 10);
assert.deepEqual(built.values[0], ["PendingTarget"]);
assert.ok(!built.text.includes("ticket"), "deal type must stay in a bind value");
assert.match(built.text, /LIMIT \$3::int OFFSET \$4::int/);
assert.match(built.text, /ORDER BY d\.published_at ASC, d\.deal_id ASC/);
assert.match(built.text, /d\.published_at IS NOT NULL/);
assert.doesNotMatch(built.text, /SELECT\s+\*/i);
assert.match(built.text, /NULLIF\(btrim\(sa\.business_name\), ''\).*NULLIF\(btrim\(sa\.display_name\), ''\)/);
assert.match(built.text, /participants_count/);
assert.match(built.text, /img\.image_id::text AS primary_image_id/);
assert.match(built.text, /img\.mime_type AS primary_image_mime_type/);
assert.doesNotMatch(built.text, /di\.public_url IS NOT NULL/);

const nextCursor = encodeMallCursor(query, 20);
const cursorQuery = parseMallQuery({
  type: "ticket",
  status: "underway",
  sort: "oldest",
  limit: "10",
  cursor: nextCursor
});
assert.equal(cursorQuery.offset, 20);
assert.equal(cursorQuery.pagination_mode, "cursor");
assert.equal(cursorQuery.cursor, nextCursor);
assert.throws(() => parseMallQuery({ type: "voucher", status: "underway", sort: "oldest", cursor: nextCursor }), MallQueryError);
assert.throws(() => parseMallQuery({ cursor: "not_a_valid_cursor" }), MallQueryError);
const envelope = buildMallListEnvelope(query, Array.from({ length: 11 }, (_, index) => ({ index })));
assert.deepEqual(envelope.filters, { type: "ticket", status: "underway", sort: "oldest" });
assert.equal(envelope.deals.length, 10);
assert.deepEqual(Object.keys(envelope.page), ["limit", "has_more", "next_cursor"]);
assert.equal(envelope.page.has_more, true);
assert.ok(envelope.page.next_cursor);

assert.deepEqual(deriveMallAvailability({ state: "PendingTarget", joined_units: 4, max_units: 10 }), {
  joined_units: 4,
  remaining_units: 6,
  is_joinable: true
});
assert.equal(deriveMallAvailability({ state: "ClosedForJoining", joined_units: 4, max_units: 10 }).is_joinable, false);
assert.deepEqual(deriveMallAvailability({ state: "TargetReached", joined_units: 50, max_units: 10 }), {
  joined_units: 10,
  remaining_units: 0,
  is_joinable: false
});

const projected = projectMallRow({
  deal_id: "00000000-0000-4000-8000-000000000001",
  title: "A deal",
  description: "Public summary",
  deal_type: "physical_product",
  state: "TargetReached",
  price_per_unit: "42.50",
  seller_business_name: "Seller",
  seller_id: "must-not-leak",
  buyer_email: "must-not-leak@example.invalid",
  storage_key: "must-not-leak",
  joined_units: 2,
  participants_count: 1,
  threshold_units: 2,
  max_units: 10,
  has_delivery: true,
  deadline: "2026-09-01T00:00:00.000Z",
  published_at: "2026-08-01T00:00:00.000Z",
  source_updated_at: "2026-08-02T00:00:00.000Z"
});
assert.deepEqual(Object.keys(projected), [...PUBLIC_MALL_DEAL_FIELDS]);
assert.equal(projected.mall_status, "reached_target");
assert.equal(projected.is_joinable, true);
assert.equal(projected.remaining_units, 8);
assert.equal(projected.participants_count, 1);
for (const privateField of ["seller_id", "buyer_email", "storage_key", "payment_reference", "ledger_id"]) {
  assert.equal(Object.hasOwn(projected, privateField), false);
}
assert.throws(() => projectMallRow({ state: "Draft", published_at: "2026-08-01T00:00:00Z" }), MallQueryError);
const localImageProjected = projectMallRow({
  deal_id: "00000000-0000-4000-8000-000000000002",
  title: "Local image deal",
  description: "Local image",
  deal_type: "physical_product",
  state: "PendingTarget",
  price_per_unit: 10,
  seller_business_name: "Seller",
  primary_image_id: "00000000-0000-4000-8000-000000000099",
  primary_image_mime_type: "image/webp",
  primary_image_url: null,
  joined_units: 0,
  participants_count: 0,
  threshold_units: 2,
  max_units: 10,
  has_delivery: false,
  deadline: "2026-09-01T00:00:00.000Z",
  published_at: "2026-08-01T00:00:00.000Z",
  source_updated_at: "2026-08-02T00:00:00.000Z"
});
assert.equal(localImageProjected.primary_image_url, "/api/deal-images/00000000-0000-4000-8000-000000000099");
assert.equal(Object.hasOwn(localImageProjected, "primary_image_id"), false);

const event = sanitizeMallEvent({
  event_type: "mall_deal_click",
  client_event_id: "opaque_event_123",
  deal_id: "00000000-0000-4000-8000-000000000001",
  deal_type: "physical_product",
  mall_status: "reached_target",
  email: "ignored@example.invalid",
  user_agent: "ignored"
});
assert.deepEqual(Object.keys(event), ["event_type", "client_event_id", "deal_id", "deal_type", "mall_status", "acquisition_source"]);
assert.equal(event.acquisition_source, "mall");
const sessionAliasEvent = sanitizeMallEvent({
  event_type: "card_impression",
  source: "mall",
  session_id: "00000000-0000-4000-8000-000000000071",
  deal_id: "00000000-0000-4000-8000-000000000001"
});
assert.equal(sessionAliasEvent.client_event_id, "00000000-0000-4000-8000-000000000071");
assert.equal(Object.hasOwn(sessionAliasEvent, "session_id"), false);
assert.throws(() => sanitizeMallEvent({ event_type: "mall_join", client_event_id: "opaque_123" }), MallQueryError);
assert.throws(() => sanitizeMallEvent({ event_type: "mall_session", client_event_id: "email@example.com" }), MallQueryError);

console.log("PASS Mall read model state mapping, bounded query, public allowlist, availability and PII-free event validation");
