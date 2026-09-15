import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const smoke = readFileSync("scripts/hosted_staging_smoke.cjs", "utf8");
const workflow = readFileSync(".github/workflows/staging-hosted-smoke.yml", "utf8");

assert.match(smoke, /method:\s*"GET"/);
assert.match(smoke, /HOSTED_STAGING_SMOKE_BOUNDARY method=GET money=false mutation=false credentials=false/);
for (const route of ["/health", "/readiness", "/api/mall/deals", "/api/site/home", "/health/integrations", "/"]) {
  assert.ok(smoke.includes(`"${route}"`), `hosted smoke must include ${route}`);
}
assert.match(smoke, /live\|production\|real/);
assert.doesNotMatch(smoke, /method:\s*"(?:POST|PUT|PATCH|DELETE)"/);
assert.doesNotMatch(smoke, /authorization|cookie|x-admin-key/i);

assert.match(workflow, /workflows:\s*\["Release readiness"\]/);
assert.match(workflow, /branches:\s*\[master\]/);
assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
assert.match(workflow, /node scripts\/hosted_staging_smoke\.cjs/);
assert.doesNotMatch(workflow, /secrets\./);

console.log("HOSTED_STAGING_SMOKE_CONTRACT_PASS read_only=pass credentials=absent post_merge_gate=release_readiness");
