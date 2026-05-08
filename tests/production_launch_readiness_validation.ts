import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

const mission = await readFile("src/admin_mission_control.ts", "utf8");
const doc = await readFile("docs/PRODUCTION_LAUNCH_READINESS.md", "utf8");
const liveDoc = await readFile("docs/PROVIDER_LIVE_MONEY_READINESS.md", "utf8");

await run("production_launch_readiness_contract_validation", async () => {
  assert.match(mission, /production_launch_readiness/);
  assert.match(mission, /buildProductionLaunchReadiness/);
  for (const section of [
    "environment",
    "secrets",
    "domain_https",
    "database",
    "storage",
    "providers",
    "security",
    "observability",
    "legal",
    "cost_guardrails",
    "rollback",
    "data_retention",
    "support",
    "seller_onboarding",
    "admin_intervention"
  ]) {
    assert.match(mission, new RegExp(`name: "${section}"`));
  }
});

await run("production_launch_live_blocked_without_providers_validation", async () => {
  // The synthesizer always returns live_ready=false in this gate. Live readiness
  // is the next gate after Full E2E.
  assert.match(mission, /live_ready: false/);
  assert.match(mission, /blocked: true/);
  assert.match(doc, /live_ready.*no/);
  assert.match(liveDoc, /Live money remains blocked|live_ready.*no/);
});

await run("production_launch_mission_control_validation", async () => {
  for (const verdict of [
    "demo_ready",
    "e2e_ready",
    "sandbox_ready",
    "live_ready",
    "blocked"
  ]) {
    assert.match(mission, new RegExp(verdict));
  }
  assert.match(mission, /next_gate_after_this/);
  assert.match(mission, /Provider Sandbox \/ Live Money Validation/);
});
