import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("frontend/app.js", "utf8");

const removed = [
  "renderOtpPage",
  "renderPaymentPage",
  "renderConfirmationPage",
  "renderSellerPage"
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

// Deletion-only rule: if removing a legacy renderer exposes a requirement that
// the live renderCton* surface does not yet carry, retain it until that gap is
// handled deliberately. Current retained legacy renderers are pinned below.
for (const retained of [
  "renderHomeLegacy",
  "renderDealPage",
  "renderTrackingPage",
  "renderSellerDealPage"
]) {
  assert.match(source, new RegExp(`\\bfunction\\s+${retained}\\s*\\(`), `${retained} remains pending a separate gap decision/fix`);
}
assert.match(source, /\bfunction\s+renderCtonTrackingPage\s*\(/);

console.log("Dead legacy renderer removal validation passed.");
