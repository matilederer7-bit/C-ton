// LAUNCH SPRINT 3 — physical pickup credential: pure helpers + React source pins.
//  * the client code normaliser mirrors the server rule exactly (same inputs → same digits)
//  * every scanner outcome has product Hebrew + a test id; a foreign QR is never sent
//  * the QR payload is the locator only; encode → independent decode roundtrip (jsQR)
//    when the web dependencies are installed (skipped with a visible line otherwise)
//  * source pins: the buyer card only renders from tracking.pickup, the seller page
//    always offers typed entry + search, the camera is requested only on a tap,
//    no seller contact on the tracking page, hash-only navigation, camera=(self)
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const { normalizePickupInput, formatPickupDigits, formatPickupTyping, pickupCodeFromScan, classifyCameraError, SCAN_OUTCOME_COPY, SCAN_OUTCOME_TEST_ID } =
  await import("../web/src/pickupCode.js");
const { normalizeOrderCodeInput, formatOrderCode, pickupQrPayload, decidePhysicalFulfillment, BUYER_PICKUP_COPY, SELLER_NOT_READY_COPY } =
  await import("../src/physical_fulfillment.js");

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e.message}`); failed++; }
}

await run("client and server normalise the same inputs to the same digits (typed variants, QR URL, junk)", () => {
  const inputs = ["CT-4839-2175", "ct 4839 2175", "48392175", "4839-2175", " CT-4839-2175 ", pickupQrPayload("https://siton.test", "CT-4839-2175"),
    "https://x/preview/#/seller/pickup?code=CT-4839-2175&x=1", "", "CT-4839", "483921756", "CT-ABCD-EFGH", "<script>", "%00", "x".repeat(600)];
  for (const input of inputs) assert.equal(normalizePickupInput(input), normalizeOrderCodeInput(input), JSON.stringify(input.slice(0, 40)));
  assert.equal(normalizePickupInput("CT-4839-2175"), "48392175");
  assert.equal(formatPickupDigits("48392175"), formatOrderCode("48392175"));
  assert.equal(formatPickupDigits("4839217"), "");
  assert.deepEqual(formatPickupTyping("4839a2175xx"), { digits: "48392175", display: "4839-2175", complete: true });
  assert.deepEqual(formatPickupTyping("483"), { digits: "483", display: "483", complete: false });
  assert.equal(pickupCodeFromScan(pickupQrPayload("https://siton.test", "CT-4839-2175")), "CT-4839-2175");
  assert.equal(pickupCodeFromScan("https://evil.example/?x=1"), null, "a foreign QR is never sent to the server");
  assert.equal(pickupCodeFromScan("WIFI:S:home;;"), null);
});

await run("every scanner outcome has product Hebrew and a stable test id; camera errors map to named outcomes", () => {
  for (const [k, copy] of Object.entries(SCAN_OUTCOME_COPY)) {
    assert.ok(String(copy).length > 8, k);
    assert.match(String(copy), /[֐-׿]/, `${k} must be Hebrew`);
    assert.match((SCAN_OUTCOME_TEST_ID as any)[k], /^pickup-scan-[a-z-]+$/);
  }
  for (const outcome of ["permission_denied", "camera_unavailable", "unsupported"]) assert.match(SCAN_OUTCOME_COPY[outcome as keyof typeof SCAN_OUTCOME_COPY], /הקליד|הקלידו/, `${outcome} names the typed-code fallback`);
  assert.equal(classifyCameraError({ name: "NotAllowedError" }), "permission_denied");
  assert.equal(classifyCameraError({ name: "NotFoundError" }), "camera_unavailable");
  assert.equal(classifyCameraError({ name: "NotReadableError" }), "camera_unavailable");
  assert.equal(classifyCameraError({ name: "TypeError" }), "unsupported");
  assert.equal(classifyCameraError({ name: "Weird" }), "error");
  assert.equal(classifyCameraError(null), "error");
});

await run("the QR payload is a locator only: the seller scanner URL + the code, nothing else", () => {
  const payload = pickupQrPayload("https://siton-staging-web.onrender.com", "CT-4839-2175");
  assert.equal(payload, "https://siton-staging-web.onrender.com/preview/#/seller/pickup?code=CT-4839-2175");
  assert.ok(payload.length < 120);
  assert.equal(pickupQrPayload("https://h/", "CT-1111-2222"), "https://h/preview/#/seller/pickup?code=CT-1111-2222");
});

await run("QR encode → independent decode roundtrip (qrcode-generator → jsQR) yields the exact payload", async () => {
  const qrPath = join(root, "web", "node_modules", "qrcode-generator", "qrcode.js");
  const jsqrPath = join(root, "web", "node_modules", "jsqr", "dist", "jsQR.js");
  if (!existsSync(qrPath) || !existsSync(jsqrPath)) {
    console.log("    QR_ROUNDTRIP=skipped (web dependencies not installed in this environment; the browser proof covers the rendered QR)");
    return;
  }
  const { createRequire } = await import("node:module");
  const requireWeb = createRequire(join(root, "web", "package.json"));
  const qrcode = requireWeb("qrcode-generator");
  const jsQR = requireWeb("jsqr");
  for (const code of ["CT-4839-2175", "CT-0000-0000", "CT-9999-9999"]) {
    const text = pickupQrPayload("https://siton-staging-web.onrender.com", code);
    const qr = qrcode(0, "M"); qr.addData(text); qr.make();
    const n = qr.getModuleCount(); const scale = 4; const quiet = 4; const size = (n + quiet * 2) * scale;
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - quiet; const my = Math.floor(y / scale) - quiet;
      const dark = mx >= 0 && my >= 0 && mx < n && my < n && qr.isDark(my, mx);
      const v = dark ? 0 : 255; const i = (y * size + x) * 4; data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
    const decoded = jsQR(data, size, size);
    assert.ok(decoded && decoded.data === text, `${code}: decoded ${decoded?.data}`);
    assert.equal(pickupCodeFromScan(decoded.data), code);
    assert.ok(n <= 41, `version stays small (modules=${n})`);
  }
});

await run("buyer copy per state exists, is Hebrew, and never promises what the state machine does not do", () => {
  for (const [state, copy] of Object.entries(BUYER_PICKUP_COPY)) {
    assert.match(copy.headline, /[֐-׿]/, state);
    assert.doesNotMatch(copy.headline + copy.subline, /בקרוב|לעולם|תמיד|ערבות|מובטח|ביטוח|דירוג/, state);
  }
  assert.equal(BUYER_PICKUP_COPY.deal_open.headline, "העסקה עדיין לא הושלמה");
  assert.equal(BUYER_PICKUP_COPY.payment_pending.headline, "ההזמנה עדיין לא מוכנה למסירה");
  assert.equal(BUYER_PICKUP_COPY.deal_failed.headline, "העסקה לא הושלמה — אין הזמנה למסירה");
  assert.equal(BUYER_PICKUP_COPY.deal_cancelled.headline, "העסקה בוטלה — אין הזמנה למסירה");
  assert.equal(BUYER_PICKUP_COPY.unavailable.headline, "ההזמנה אינה זמינה למסירה");
  assert.equal(BUYER_PICKUP_COPY.fulfilled.headline, "ההזמנה נמסרה");
  for (const reason of ["payment_incomplete", "deal_not_completed", "deal_failed", "deal_cancelled", "refunded"] as const) assert.match(SELLER_NOT_READY_COPY[reason], /[֐-׿]/);
  // "שולם" only for settled money: the decision function is the single source.
  for (const money of ["AuthHeld", "AuthLocked", "ChargeAttempt", "ChargeFailedRecovery", "AuthReleased", "Refunded"]) {
    const v = decidePhysicalFulfillment({ dealType: "physical_product", dealState: "Completed", buyerState: "DealCompleted", moneyState: money, units: { total: 1, issued: 1, redeemed: 0, voided: 0, redeemed_at: null } });
    assert.equal(v.paid, false, money); assert.notEqual(v.seller_verdict, "ready", money);
  }
});

await run("React source pins — buyer card renders only from tracking.pickup; full-screen mode; no seller contact; hash-only links", () => {
  const card = read("web/src/pickupCard.tsx");
  const track = read("web/src/pages/track.tsx");
  assert.match(track, /<BuyerEntitlement participantId=\{participantId\} token=\{token\} pickup=\{t\.pickup\} \/>/, "the entitlement view receives the authenticated participant and server pickup payload");
  const receipt = read("web/src/receiptContent.tsx");
  assert.match(receipt, /!data\.configured && pickup\?\.applicable \? <PickupCard pickup=\{pickup\} \/>/, "legacy physical deals retain the canonical pickup card; configured methods use entitlement details");
  assert.match(card, /if \(!pickup \|\| !pickup\.applicable\) return null;/);
  assert.match(card, /state !== "ready"/, "non-ready states never show a code");
  assert.match(card, /data-testid="pickup-fullscreen-open"/);
  assert.match(card, /data-testid="pickup-fullscreen"/);
  assert.match(card, /data-testid="pickup-code"/);
  assert.match(card, /<QrCode value=\{String\(pickup\.qr_payload\)\}/, "the QR encodes the server payload verbatim");
  assert.doesNotMatch(card, /mailto:|support_email|support_phone|wa\.me|tel:/, "no seller contact on the buyer card");
  assert.doesNotMatch(card, /ערבות|מובטח|ביטוח|דירוג|⭐/);
  assert.match(card, /dir="ltr"/, "codes are LTR isolates");
  assert.match(read("web/src/buyerCopy.ts"), /PICKUP_SHOW_TO_SELLER_LINE = "הציגו את הקוד למוכר בעת האיסוף\."/);
});

await run("React source pins — seller scanner: camera only on tap, typed + search always present, quantity in the CTA, explicit confirmation copy, already/blocked states", () => {
  const page = read("web/src/pages/sellerPickup.tsx");
  const scan = read("web/src/pickupScan.ts");
  assert.match(page, /data-testid="pickup-camera-start"/);
  assert.match(page, /onClick=\{startCamera\}/, "camera starts on the seller's tap only");
  assert.doesNotMatch(page, /useEffect\(\(\) => \{\s*void startCamera/, "never on load");
  assert.match(scan, /getUserMedia\(\{ video: \{ facingMode: \{ ideal: "environment" \} \}, audio: false \}\)/);
  assert.match(scan, /await import\("jsqr"\)/, "the decoder fallback is a lazy chunk");
  assert.match(scan, /BarcodeDetector/, "native detector preferred");
  assert.match(page, /data-testid="pickup-code-input"/);
  assert.match(page, /inputMode="numeric"/);
  assert.match(page, /data-testid="pickup-search-input"/);
  assert.match(page, /אישור מסירה — \{num\(qty\)\} יחידות/, "the primary CTA names the quantity");
  assert.match(page, /אתם מוסרים עכשיו <b>\{num\(qty\)\} יחידות<\/b> של <b>\{order\.product_title\}<\/b> ל<b>\{order\.buyer_name \|\| "הקונה"\}<\/b>\./);
  assert.match(page, /אישור המסירה מסמן את כל \{num\(qty\)\} היחידות כנמסרו\./);
  assert.match(page, /data-testid="handoff-confirm-back"/);
  assert.match(page, /intentKey\.current = crypto\.randomUUID\(\)/, "one confirmation = one idempotency key");
  assert.match(page, /if \(busy\) return;/, "double taps never stack requests");
  assert.match(page, /green: "מוכן למסירה"/); assert.match(page, /amber: "כבר נמסר"/); assert.match(page, /red: "אין למסור את ההזמנה"/);
  assert.match(page, /data-state=\{tone\}/, "state is carried as data, not colour alone");
  assert.match(read("web/src/pages/seller.tsx"), /sub\[0\] === "pickup"/);
  assert.match(read("web/src/pages/seller.tsx"), /sub\[2\] === "fulfillment"/);
  assert.match(read("web/src/pages/seller.tsx"), /data-testid="dash-pickup-scan"/);
  assert.match(read("web/src/api.ts"), /"idempotency-key": `preview-handoff-\$\{intentKey\}`/);
  // hash-only navigation: every literal navigate/href in the new files starts with # (or is a template with an interpolation)
  for (const file of ["web/src/pages/sellerPickup.tsx", "web/src/pickupCard.tsx"]) {
    const src = read(file);
    for (const m of src.matchAll(/(?:navigate\(|href=)\s*["'`]([^"'`$]+)["'`]/g)) {
      assert.match(m[1]!, /^(#|\/legal\/|https?:|mailto:|tel:)/, `${file}: ${m[1]}`);
    }
  }
});

await run("camera policy: app.ts allows camera for our own page only (self), microphone/payment stay off", () => {
  const appTs = read("src/app.ts");
  const header = appTs.match(/reply\.header\("permissions-policy", "([^"]+)"\)/)?.[1] || "";
  assert.match(header, /camera=\(self\)/);
  assert.match(header, /microphone=\(\)/);
  assert.match(header, /payment=\(\)/);
});

await run("web dependencies: exactly two additions, both zero-dependency, pinned exact (qrcode-generator, jsqr)", () => {
  const pkg = JSON.parse(read("web/package.json"));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["jsqr", "qrcode-generator", "react", "react-dom"]);
  assert.equal(pkg.dependencies["qrcode-generator"], "1.4.4");
  assert.equal(pkg.dependencies.jsqr, "1.4.0");
});

console.log(`\nPICKUP_FRONTEND_FOUNDATION passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
