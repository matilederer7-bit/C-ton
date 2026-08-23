const fs = require("node:fs");
const path = require("node:path");

function assert(condition, message) {
  if (!condition) throw new Error(`ARCHITECTURE_GATE_FAIL ${message}`);
}

assert(fs.existsSync("base44/config.jsonc"), "base44/config.jsonc missing");
assert(fs.existsSync("base44/runtime-manifest.json"), "canonical runtime manifest missing");
assert(fs.existsSync("base44/functions/siton-worker-tick/function.jsonc"), "Base44 scheduled worker missing");
assert(!fs.existsSync("render.yaml"), "root render.yaml must remain quarantined");
assert(!fs.existsSync("Procfile"), "root Procfile must remain quarantined");
assert(fs.existsSync("legacy/render/render.legacy.yaml"), "legacy Render evidence missing");
const requiredClosureDocs = [
  "docs/CANONICAL_ARCHITECTURE_V1.md",
  "docs/FINAL_ZERO_DEVELOPMENT_CLOSURE.md",
  "docs/SYNTHETIC_MONEY_PROOF.md",
  "docs/GROW_PAYMENTS_INTEGRATION_READINESS.md",
  "docs/MOBILE_APP_RELEASE_READINESS.md",
  "docs/EXTERNAL_ACTIVATION_CHECKLIST.md",
];
for (const documentPath of requiredClosureDocs) {
  assert(fs.existsSync(documentPath), `closure document missing: ${documentPath}`);
}
const runtime = JSON.parse(fs.readFileSync("base44/runtime-manifest.json", "utf8"));
assert(runtime.production_runtime === "base44", "production runtime is not Base44");
assert(runtime.scheduled_worker === "siton-worker-tick", "scheduled worker ownership unclear");
const automation = fs.readFileSync("base44/functions/siton-worker-tick/function.jsonc", "utf8");
assert(automation.includes('"cron_expression": "*/5 * * * *"'), "worker automation is not scheduled at the supported five-minute interval");
const forbiddenRoot = fs.readdirSync(".").filter((name) => /^render(?:\.|$)/i.test(name));
assert(forbiddenRoot.length === 0, `Render artifacts left at repository root: ${forbiddenRoot.join(",")}`);
console.log("ARCHITECTURE_GATE_PASS production=base44 worker=siton-worker-tick render=legacy portable_runtime=supporting");
