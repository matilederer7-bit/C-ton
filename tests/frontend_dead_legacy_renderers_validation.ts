import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("frontend/app.js", "utf8");

const removed = [
  "renderHomeLegacy",
  "renderDealPage",
  "renderOtpPage",
  "renderPaymentPage",
  "renderConfirmationPage",
  "renderSellerPage",
  "renderSellerDealPage"
];

for (const name of removed) {
  assert.doesNotMatch(
    source,
    new RegExp(`\\bfunction\\s+${name}\\s*\\(`),
    `${name} is superseded dead code and must not return`
  );
}

for (const live of [
  "renderCtonHome",
  "renderCtonDealPage",
  "renderCtonOtpPage",
  "renderCtonPaymentPage",
  "renderCtonConfirmationPage",
  "renderCtonSellerPage",
  "renderCtonSellerDealPage"
]) {
  assert.match(source, new RegExp(`\\bfunction\\s+${live}\\s*\\(`), `${live} must remain`);
}

// Tracking remains deliberately until the owner resolves the two §8.2 gaps:
assert.match(source, /\bfunction\s+renderTrackingPage\s*\(/);
assert.match(source, /\bfunction\s+renderCtonTrackingPage\s*\(/);

console.log("Dead legacy renderer removal validation passed.");
