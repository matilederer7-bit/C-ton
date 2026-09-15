// OVERNIGHT HARDENING — source-static drift guard between the runtime's
// tracking projection and the canonical React tracking page.
//
// buildTrackingPersonalStatus (src/frontend_runtime.ts) emits
//   { action_required, status, title, detail, cta: { label, href } | null }
// The React page used to read `personal_status.headline` / `.body` — keys the
// server never produced — so the "payment method update required" instruction
// and its CTA were silently never rendered to a buyer whose charge failed.
// This proof pins both sides to the same keys, and pins the deal page's
// treatment of a malformed deal id (400) as "this link does not lead to a deal"
// rather than a generic failure.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const runtime = readFileSync("src/frontend_runtime.ts", "utf8");
const track = readFileSync("web/src/pages/track.tsx", "utf8");
const deal = readFileSync("web/src/pages/deal.tsx", "utf8");

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error: any) { failed += 1; console.error(`FAIL ${name}: ${error?.message || error}`); }
}

check("server personal_status contract: title, detail, cta, action_required, status", () => {
  const start = runtime.indexOf("function buildTrackingPersonalStatus(");
  assert.ok(start > 0, "buildTrackingPersonalStatus exists");
  const body = runtime.slice(start, runtime.indexOf("\nfunction ", start + 10));
  for (const key of ["action_required:", "status:", "title:", "detail:", "cta:"]) assert.ok(body.includes(key), `server emits ${key}`);
  assert.ok(!/\bheadline:|\bbody:/.test(body), "server does not emit headline/body on personal_status");
  assert.ok(body.includes("payment_update_required"), "recovery instruction status exists");
  assert.ok(/href: `\/app\/recovery\//.test(body), "recovery CTA carries an href");
});

check("React tracking page renders the keys the server emits (title, detail, cta)", () => {
  assert.ok(/personal_status\?\.title/.test(track), "reads personal_status.title");
  assert.ok(/personal_status\?\.detail/.test(track), "reads personal_status.detail");
  assert.ok(/personal_status\?\.cta\?\.href/.test(track) && /personal_status\.cta\.label/.test(track), "renders the CTA link + label");
  assert.ok(/data-testid="track-personal-cta"/.test(track), "CTA is addressable for browser proofs");
  const readsOnlyLegacyKeys = /personal_status\?\.headline \|\| t\.headline\}/.test(track) && !/personal_status\?\.title/.test(track);
  assert.equal(readsOnlyLegacyKeys, false, "the legacy headline/body keys are a fallback, never the only read");
});

check("React deal page treats a malformed deal id (400) like a missing deal, never as a generic failure", () => {
  assert.ok(/status === 404 \|\| status === 400 \? "gone"/.test(deal), "400 maps to the gone story");
});

if (failed) {
  console.error(`FAILED ${failed} tracking status contract checks`);
  process.exit(1);
}
console.log("All tracking status contract checks passed.");
