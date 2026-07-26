const fs = require("node:fs");
const yaml = fs.readFileSync("render.yaml", "utf8");
const failures = [];
function requirePattern(pattern, message) { if (!pattern.test(yaml)) failures.push(message); }
function rejectPattern(pattern, message) { if (pattern.test(yaml)) failures.push(message); }

requirePattern(/- type: web[\s\S]*?dockerCommand: npm run start:web:prod/, "web service must use start:web:prod");
requirePattern(/- type: worker[\s\S]*?dockerCommand: npm run start:worker:prod/, "worker service must use start:worker:prod");
requirePattern(/preDeployCommand: npm run db:migrate/, "canonical migration pre-deploy command is required");
requirePattern(/autoDeployTrigger: checksPass/, "deploys must wait for CI checks");
requirePattern(/RUNTIME_ROLE[\s\S]*?value: web/, "web runtime role is required");
requirePattern(/RUNTIME_ROLE[\s\S]*?value: worker/, "worker runtime role is required");
requirePattern(/DISABLE_OUTBOX_WORKER[\s\S]*?value: "1"/, "web must disable embedded worker execution");
requirePattern(/key:\s*STORAGE_ADAPTER\r?\n\s+sync:\s*false/, "storage adapter must be deployment-configured");
for (const key of ["OBJECT_STORAGE_REGION", "OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_ACCESS_KEY_ID", "OBJECT_STORAGE_SECRET_ACCESS_KEY"]) requirePattern(new RegExp(`key:\\s*${key}\\r?\\n\\s+sync:\\s*false`), `${key} must be injected by Render`);
rejectPattern(/key:\s*PAYMENT_PROVIDER\r?\n\s+value:\s*(?:mock|mockpay)/i, "render services must not hard-code a mock payment provider");
rejectPattern(/key:\s*PAYMENT_PROVIDER_MODE\r?\n\s+value:\s*mock-backed/i, "render services must not hard-code mock-backed mode");
rejectPattern(/(?:sk_live_|pk_live_|whsec_[A-Za-z0-9]{16,})/, "render.yaml contains a credential-like literal");

if (failures.length) {
  console.error("RENDER_CONFIG_GATE_FAIL");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log("RENDER_CONFIG_GATE_PASS");
