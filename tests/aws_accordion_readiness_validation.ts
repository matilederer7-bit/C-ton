import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

await runTest("aws_accordion_blueprint_doc_present", async () => {
  const doc = await readFile("docs/AWS_ACCORDION_DEPLOYMENT_BLUEPRINT.md", "utf8");

  // All four tiers documented
  for (const required of [
    "Tier 0",
    "Tier 1",
    "Tier 2",
    "Tier 3",
    "ECS",
    "RDS",
    "S3",
    "CloudFront",
    "WAF",
    "Secrets Manager",
    "Route 53",
    "ACM"
  ]) {
    assert.match(doc, new RegExp(required), `blueprint must mention ${required}`);
  }

  // Cost guardrails section
  for (const guardrail of [
    "AWS Budgets",
    "max tasks",
    "rate-based",
    "rotation"
  ]) {
    assert.match(doc, new RegExp(guardrail, "i"), `blueprint must document ${guardrail}`);
  }

  // Anti-lock-in posture
  assert.match(doc, /not load AWS credentials|portable/i, "blueprint must state app is portable / no AWS credentials in code");
});

await runTest("aws_accordion_storage_sdk_boundary", async () => {
  const packageJson = await readFile("package.json", "utf8");
  const pkg = JSON.parse(packageJson);
  const runtimeDeps = Object.keys(pkg.dependencies || {});
  assert.ok(runtimeDeps.includes("@aws-sdk/client-s3"), "canonical S3-compatible adapter requires the scoped S3 client");
  assert.ok(runtimeDeps.includes("@aws-sdk/s3-request-presigner"), "authorized short-lived reads require the scoped presigner");
  for (const forbidden of ["aws-sdk", "@aws-sdk/client-secrets-manager"]) assert.ok(!runtimeDeps.includes(forbidden), `${forbidden} is outside the storage adapter boundary`);

  const storageAdapter = await readFile("src/storage_adapter.ts", "utf8");
  assert.match(storageAdapter, /@aws-sdk\/client-s3/);
  const appSource = await readFile("src/app.ts", "utf8");
  const imageStorage = await readFile("src/product_image_storage.ts", "utf8");
  assert.doesNotMatch(appSource + imageStorage, /@aws-sdk|S3Client|PutObjectCommand|GetObjectCommand/);
});

await runTest("accordion_scaling_mission_control_validation", async () => {
  const mission = await readFile("src/admin_mission_control.ts", "utf8");

  // Function exists
  assert.match(mission, /function buildAccordionScalingReadiness/, "buildAccordionScalingReadiness must be defined");

  // All required fields appear in the function body
  for (const field of [
    "docker_status",
    "container_smoke_status",
    "external_db_ready",
    "storage_mode",
    "rate_limit_scale_mode",
    "worker_scale_status",
    "load_balancer_readiness",
    "cost_guardrails_status",
    "aws_blueprint_status",
    "estimated_scale_risk",
    "tier_status",
    "blockers",
    "warnings"
  ]) {
    assert.match(mission, new RegExp(field), `accordion_scaling_readiness must report ${field}`);
  }

  // Wired into mission control output
  assert.match(mission, /accordion_scaling_readiness:\s*accordionScalingReadiness/, "mission-control output must include accordion_scaling_readiness");

  // Tier coverage
  for (const tier of ["tier_0_local_demo", "tier_1_small_market_launch", "tier_2_accordion_scale", "tier_3_mature_production"]) {
    assert.match(mission, new RegExp(tier), `accordion_scaling_readiness.tier_status must report ${tier}`);
  }
});

await runTest("readiness_contract_validation", async () => {
  const app = await readFile("src/app.ts", "utf8");
  const frontendRuntime = await readFile("src/frontend_runtime.ts", "utf8");

  // /health must exist and be cheap
  assert.match(app, /app\.get\("\/health"/, "/health endpoint must exist in app.ts");
  assert.match(app, /app\.get\("\/health".*ok:\s*true/s, "/health must return a cheap ok response");

  // /health must NOT touch DB or providers
  const healthHandler = app.match(/app\.get\("\/health"[\s\S]{0,200}\}\)\);/);
  assert.ok(healthHandler, "/health handler must be locatable");
  assert.doesNotMatch(healthHandler[0], /withTx|c\.query|provider/i, "/health must not query DB or providers");

  // Mission control endpoint must be registered (in frontend_runtime.ts where admin routes live)
  assert.match(frontendRuntime, /app\.get\("\/api\/admin\/mission-control"/, "mission-control endpoint must be registered");
});

await runTest("cdn_policy_validation", async () => {
  const app = await readFile("src/app.ts", "utf8");
  const cachePolicy = await readFile("docs/CACHE_POLICY.md", "utf8");

  // API + webhooks no-store
  assert.match(app, /path\.startsWith\("\/api\/"\)/, "no-store rule must apply to /api/*");
  assert.match(app, /path\.startsWith\("\/webhooks\/"\)/, "no-store rule must apply to /webhooks/*");

  // Deal images immutable
  assert.match(app, /isImmutableDealImageRoute/, "deal images must have an immutable cache policy carve-out");
  assert.match(app, /max-age=31536000, immutable/, "deal images must use immutable cache policy");

  // Doc must declare CDN posture
  for (const required of ["no-store", "immutable", "deal-images", "CDN"]) {
    assert.match(cachePolicy, new RegExp(required, "i"), `CACHE_POLICY.md must mention ${required}`);
  }

  // Blueprint reflects same posture
  const blueprint = await readFile("docs/AWS_ACCORDION_DEPLOYMENT_BLUEPRINT.md", "utf8");
  assert.match(blueprint, /CloudFront/i, "blueprint must address CloudFront/CDN");
  assert.match(blueprint, /no-store/i, "blueprint must explain no-store posture for API/admin");
  assert.match(blueprint, /immutable/i, "blueprint must reference immutable assets");
});

await runTest("cost_guardrails_documented", async () => {
  const blueprint = await readFile("docs/AWS_ACCORDION_DEPLOYMENT_BLUEPRINT.md", "utf8");
  for (const required of [
    "AWS Budgets",
    "max tasks",
    "rate-based",
    "5xx",
    "DB",
    "WAF"
  ]) {
    assert.match(blueprint, new RegExp(required, "i"), `cost guardrails must address ${required}`);
  }

  // Mission control reports the posture
  const mission = await readFile("src/admin_mission_control.ts", "utf8");
  assert.match(mission, /cost_guardrails_status/, "mission-control must report cost_guardrails_status");
});

await runTest("aws_accordion_no_state_or_money_logic_change", async () => {
  // Sanity assertions: the readiness pass must not have rewritten the state machine,
  // money logic, or commission calculation.
  const platformFee = await readFile("src/platform_fee_money.ts", "utf8");
  // Spec is 8% with 18% VAT — these constants must remain present
  assert.match(platformFee, /0\.08|8\s*%/, "platform fee constant must remain 8%");

  const runtimeConfig = await readFile("src/runtime_config.ts", "utf8");
  assert.match(runtimeConfig, /SITON_PLATFORM_FEE_VAT_RATE/, "VAT env must remain");

  // No new live-money switch in the readiness pass
  const blueprint = await readFile("docs/AWS_ACCORDION_DEPLOYMENT_BLUEPRINT.md", "utf8");
  assert.match(blueprint, /live_money_ready.*no|live money is a separate gate/i, "blueprint must explicitly NOT enable live money");
});
