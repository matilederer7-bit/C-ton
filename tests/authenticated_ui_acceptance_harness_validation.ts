import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// Authenticated UI acceptance harness — credential-boundary self-test.
// No browser, no network, no database: every mode exercised here stops before
// any I/O. It proves the harness fails SAFELY at the credential boundary
// (CREDENTIALS_MISSING, exit 3, authenticated steps reported as SKIP — never
// PASS), never echoes a credential value, and refuses to dry-fit a
// non-loopback host.

const harness = path.join(process.cwd(), "scripts", "authenticated_ui_acceptance.cjs");
const CRED_VARS = ["SITON_ACCEPTANCE_SELLER_EMAIL", "SITON_ACCEPTANCE_SELLER_PASSWORD", "SITON_ACCEPTANCE_ADMIN_EMAIL", "SITON_ACCEPTANCE_ADMIN_PASSWORD"];

let passed = 0;
let failed = 0;
async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}: ${(error as any)?.message || error}`);
    failed += 1;
  }
}

function strippedEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) if (key.startsWith("SITON_ACCEPTANCE_") && !(key in overrides)) delete env[key];
  return env;
}

function invoke(args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [harness, ...args], { env, encoding: "utf8", timeout: 60_000 });
  if (result.error) throw result.error;
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
}

const lines = (out: string) => out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

await runTest("credentials-check without any credential → CREDENTIALS_MISSING, exit 3, all four variables named", async () => {
  const r = invoke(["--credentials-check"], strippedEnv());
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /CREDENTIALS seller=missing admin=missing/);
  assert.match(r.out, /verdict=CREDENTIALS_MISSING/);
  const missing = r.out.match(/MISSING_CREDENTIALS=([^\s]+)/)?.[1] || "";
  assert.deepEqual(missing.split(","), CRED_VARS);
  assert.ok(!/^PASS /m.test(r.out), "no PASS line may be emitted without credentials");
});

await runTest("plan without credentials: every authenticated step is SKIP:CREDENTIALS_MISSING, credential-free checks stay RUN, nothing is PASS", async () => {
  const r = invoke(["--plan"], strippedEnv());
  assert.equal(r.status, 3, r.out);
  const plan = lines(r.out).filter((l) => l.startsWith("PLAN "));
  assert.ok(plan.length >= 20, `plan too short: ${plan.length}`);
  const authenticated = plan.filter((l) => /needs=(seller|admin)/.test(l) && !/disposition=NOT_SUPPORTED/.test(l));
  assert.ok(authenticated.length >= 15, `expected ≥15 authenticated steps, got ${authenticated.length}`);
  for (const l of authenticated) assert.match(l, /disposition=SKIP:CREDENTIALS_MISSING\((seller|admin)(,(seller|admin))?\)/, l);
  const free = plan.filter((l) => /needs=none/.test(l));
  assert.ok(free.length >= 4, "credential-free checks (S0, A0, hygiene) must remain runnable");
  for (const l of free) assert.match(l, /disposition=RUN/, l);
  assert.ok(plan.some((l) => /A8 .*disposition=NOT_SUPPORTED/.test(l)), "restore/revert must be reported NOT_SUPPORTED, not PASS or SKIP");
  assert.ok(!/disposition=PASS|^PASS /m.test(r.out), "no PASS without credentials");
});

await runTest("only seller credentials present → admin steps still SKIP, seller steps RUN, exit 3", async () => {
  const r = invoke(["--plan"], strippedEnv({ SITON_ACCEPTANCE_SELLER_EMAIL: "seller@example.invalid", SITON_ACCEPTANCE_SELLER_PASSWORD: "placeholder-not-a-real-password" }));
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /CREDENTIALS seller=present admin=missing/);
  assert.match(r.out, /MISSING_CREDENTIALS=SITON_ACCEPTANCE_ADMIN_EMAIL,SITON_ACCEPTANCE_ADMIN_PASSWORD/);
  const plan = lines(r.out).filter((l) => l.startsWith("PLAN "));
  for (const l of plan.filter((l) => /needs=seller /.test(l))) assert.match(l, /disposition=RUN/, l);
  for (const l of plan.filter((l) => /needs=admin /.test(l) && !/NOT_SUPPORTED/.test(l))) assert.match(l, /disposition=SKIP:CREDENTIALS_MISSING\(admin\)/, l);
});

await runTest("credential VALUES never reach stdout/stderr", async () => {
  const secret = "placeholder-not-a-real-password-8f3a";
  const email = "owner-placeholder@example.invalid";
  const env = strippedEnv({ SITON_ACCEPTANCE_SELLER_EMAIL: email, SITON_ACCEPTANCE_SELLER_PASSWORD: secret, SITON_ACCEPTANCE_ADMIN_EMAIL: email, SITON_ACCEPTANCE_ADMIN_PASSWORD: secret });
  for (const mode of [["--credentials-check"], ["--plan"]]) {
    const r = invoke(mode, env);
    assert.equal(r.status, 0, r.out);
    assert.ok(!r.out.includes(secret), `password echoed in ${mode}`);
    assert.ok(!r.out.includes(email), `email echoed in ${mode}`);
  }
  const check = invoke(["--credentials-check"], env);
  assert.match(check.out, /CREDENTIALS_PRESENT/);
  assert.ok(!/verdict=PASS/.test(check.out), "presence must never be reported as an acceptance PASS");
});

await runTest("dry-fit refuses a non-loopback host before any browser or network I/O", async () => {
  const r = invoke(["--local-dryfit", "--base-url=https://siton-staging-web.onrender.com"], strippedEnv());
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /DRYFIT_REFUSED non-loopback host/);
  assert.ok(!/^PASS /m.test(r.out));
});

await runTest("harness reads credentials only from the environment (no dotenv, no credential files), and the browser profile is disposable", async () => {
  const source = readFileSync(harness, "utf8");
  assert.ok(!/dotenv/.test(source), "harness must not load .env files");
  assert.ok(!/readFileSync/.test(source), "harness must not read credentials from disk");
  for (const v of CRED_VARS) assert.ok(source.includes(v), `${v} must be the documented source`);
  assert.match(source, /rmSync\(browser\.profileDir/, "the throwaway browser profile (which holds the session) must be deleted");
  assert.match(source, /localStorage\.clear\(\); sessionStorage\.clear\(\)/, "stored sessions must be cleared before the browser closes");
  assert.match(source, /Runtime\.exceptionThrown/);
  assert.match(source, /Network\.loadingFailed/);
  assert.match(source, /notSupported: "master has no restore\/revert route/);
});

console.log(`\nAUTH_UI_ACCEPTANCE_HARNESS_VALIDATION passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
