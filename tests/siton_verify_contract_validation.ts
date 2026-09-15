import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(
  packageJson.scripts?.["siton:verify"],
  "node scripts/siton_verify.cjs",
  "package.json must expose the canonical npm run siton:verify command"
);

const result = spawnSync(process.execPath, ["scripts/siton_verify.cjs", "--plan"], {
  encoding: "utf8",
  env: process.env
});
assert.equal(result.status, 0, result.stderr || "siton verifier plan must exit 0");

const output = String(result.stdout || "");
for (const id of ["release-static", "migrations-isolated", "route-authorization", "repository-tests"]) {
  assert.match(output, new RegExp(`VERIFY_STEP id=${id}\\b`), `missing canonical verification step ${id}`);
}
assert.match(output, /VERIFY_BOUNDARY docker=false external_provider_calls=false real_money=false production_mutation=false/);
assert.doesNotMatch(output, /ci:docker-smoke|stripe-sandbox-external|release:local-lab/);

const verifier = readFileSync("scripts/siton_verify.cjs", "utf8");
assert.match(verifier, /assertLocalBase/);
assert.match(verifier, /SITON_VERIFY_RESULT PASS/);
assert.match(verifier, /SITON_VERIFY_RESULT FAIL/);
assert.match(verifier, /SITON_VERIFY_RESULT BLOCKED/);

console.log("SITON_VERIFY_CONTRACT_PASS steps=4 local_db_guard=pass external_effects=excluded");
