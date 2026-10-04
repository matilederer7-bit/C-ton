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

// Owner decision is still open for the two tracking-only legacy requirements
// recorded in docs/LEAN_REFACTOR_MAP_2026-09-30.md §8.2. Keep the old tracking
// renderer until that decision is made; this PR deliberately does not decide it.
assert.match(source, /\bfunction\s+renderTrackingPage\s*\(/);
assert.match(source, /\bfunction\s+renderCtonTrackingPage\s*\(/);

console.log("Dead legacy renderer removal validation passed.");
