import assert from "node:assert/strict";
import { readFile, stat, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawnSync } from "node:child_process";

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

await runTest("dockerfile_static_validation", async () => {
  const exists = await fileExists("Dockerfile");
  assert.ok(exists, "Dockerfile must exist at repository root");

  const dockerfile = await readFile("Dockerfile", "utf8");

  // Base image
  assert.match(dockerfile, /^FROM node:/m, "Dockerfile must FROM a node image");

  // Lockfile-pinned install
  assert.match(dockerfile, /npm ci/, "Dockerfile must use npm ci for reproducible installs");

  // Defense-in-depth removal of any .env file that slipped through
  assert.match(
    dockerfile,
    /find .* \\?-name "\.env"/,
    "Dockerfile must explicitly remove .env files as defense-in-depth"
  );

  // No real .env copy
  assert.doesNotMatch(dockerfile, /COPY\s+\.env\b/, "Dockerfile must not COPY a real .env file");
  assert.doesNotMatch(dockerfile, /COPY\s+\.env\.local\b/, "Dockerfile must not COPY .env.local");
  assert.doesNotMatch(dockerfile, /COPY\s+\.env\.production\b/, "Dockerfile must not COPY .env.production");

  // Non-root user
  assert.match(dockerfile, /USER\s+\w+/, "Dockerfile must switch to a non-root user");
  assert.doesNotMatch(dockerfile, /^USER\s+root\s*$/m, "Dockerfile must not end as USER root");

  // Healthcheck
  assert.match(dockerfile, /HEALTHCHECK/i, "Dockerfile must define a HEALTHCHECK");
  assert.match(dockerfile, /\/health/, "Dockerfile HEALTHCHECK must probe /health");

  // Explicit start command
  assert.match(dockerfile, /^CMD\s+\[/m, "Dockerfile must define an explicit CMD");

  // No Windows paths or PowerShell
  assert.doesNotMatch(dockerfile, /[Cc]:[\\\/]/, "Dockerfile must not contain Windows-style paths");
  assert.doesNotMatch(dockerfile, /Lenovo/i, "Dockerfile must not reference local user paths");
  assert.doesNotMatch(dockerfile, /powershell/i, "Dockerfile must not invoke PowerShell");
  assert.doesNotMatch(dockerfile, /msedge\.exe|microsoft-edge/i, "Dockerfile must not depend on local browsers");

  // No literal secrets
  assert.doesNotMatch(dockerfile, /sk_live_|whsec_|pk_live_/, "Dockerfile must not contain provider live keys");
});

await runTest("dockerignore_static_validation", async () => {
  const exists = await fileExists(".dockerignore");
  assert.ok(exists, ".dockerignore must exist");

  const dockerignore = await readFile(".dockerignore", "utf8");

  // Critical exclusions — secrets and large host-only files
  for (const required of [
    "node_modules",
    ".git",
    ".env",
    ".env.*",
    "uploads",
    ".tmp_*",
    ".claude",
    "coverage",
    "logs",
    "*.log"
  ]) {
    assert.match(
      dockerignore,
      new RegExp(`(^|\\n)${required.replace(/\./g, "\\.").replace(/\*/g, "\\*")}(\\s|$)`),
      `.dockerignore must exclude ${required}`
    );
  }

  // Demo example template must NOT be excluded — image should ship it for reference
  assert.match(dockerignore, /!\.env\.demo\.example/, ".dockerignore must keep .env.demo.example as a documented exception");
});

await runTest("docker_compose_static_validation", async () => {
  const exists = await fileExists("docker-compose.yml");
  assert.ok(exists, "docker-compose.yml must exist for local cloud-like runs");

  const compose = await readFile("docker-compose.yml", "utf8");

  // Required services
  assert.match(compose, /^\s*postgres:\s*$/m, "compose must define a postgres service");
  assert.match(compose, /^\s*app:\s*$/m, "compose must define an app service");

  // Healthcheck on postgres + app dependency
  assert.match(compose, /pg_isready/, "postgres service must have a pg_isready healthcheck");
  assert.match(compose, /condition:\s*service_healthy/, "app must depend on postgres being healthy");

  // App health check against /health
  assert.match(compose, /\/health/, "app service must health check /health");

  // No literal real secrets
  assert.doesNotMatch(compose, /sk_live_|whsec_(?!.*demo)|pk_live_/, "compose must not contain live provider keys");

  // Demo defaults are flagged as such
  assert.match(compose, /demo|mock|log-only/i, "compose env must use demo/mock/log-only providers");
});

await runTest("no_windows_path_in_runtime_validation", async () => {
  for (const path of ["src/app.ts", "src/runtime_config.ts", "src/db.ts", "src/admin_mission_control.ts"]) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, /[Cc]:\\\\Users\\\\/, `${path} must not contain Windows user paths`);
    assert.doesNotMatch(source, /Lenovo/i, `${path} must not reference local user`);
  }

  const dockerfile = await readFile("Dockerfile", "utf8");
  assert.doesNotMatch(dockerfile, /[Cc]:[\\\/]/, "Dockerfile must not contain Windows paths");

  const compose = await readFile("docker-compose.yml", "utf8");
  assert.doesNotMatch(compose, /[Cc]:[\\\/]/, "docker-compose must not contain Windows paths");
});

await runTest("env_contract_validation", async () => {
  const example = await readFile(".env.demo.example", "utf8");

  // Required envs are mentioned in the demo example
  for (const required of [
    "DATABASE_URL",
    "PORT",
    "HOST",
    "APP_DEPLOYMENT_MODE",
    "PAYMENT_PROVIDER",
    "NOTIFICATION_PROVIDER"
  ]) {
    assert.match(example, new RegExp(`(^|\\n)#?\\s*${required}=`), `.env.demo.example must reference ${required}`);
  }

  // Demo example must not contain real-looking secrets — placeholders like
  // "whsec_xxx" or "sk_live_or_test_xxx" are documentation hints and allowed.
  // Real keys have long alphanumeric tails.
  assert.doesNotMatch(example, /sk_live_[A-Za-z0-9]{16,}/, ".env.demo.example must not contain a real Stripe live secret key");
  assert.doesNotMatch(example, /pk_live_[A-Za-z0-9]{16,}/, ".env.demo.example must not contain a real Stripe live publishable key");
  assert.doesNotMatch(example, /whsec_[A-Za-z0-9]{16,}/, ".env.demo.example must not contain a real webhook signing secret");

  // Environment contract doc must exist and cover modes
  const contract = await readFile("docs/ENVIRONMENT_CONTRACT.md", "utf8");
  for (const required of [
    "DATABASE_URL",
    "ADMIN_API_KEY",
    "PAYMENT_PROVIDER",
    "PAYMENT_WEBHOOK_SECRET",
    "demo",
    "sandbox",
    "live"
  ]) {
    assert.match(contract, new RegExp(required), `ENVIRONMENT_CONTRACT.md must mention ${required}`);
  }
});

await runTest("docker_readiness_doc_validation", async () => {
  const doc = await readFile("docs/DOCKER_READINESS.md", "utf8");
  for (const required of [
    "Dockerfile",
    ".dockerignore",
    "docker compose",
    "/health",
    "ADMIN_API_KEY",
    "DATABASE_URL"
  ]) {
    assert.match(doc, new RegExp(required.replace(/\./g, "\\.").replace(/\//g, "\\/")), `DOCKER_READINESS.md must mention ${required}`);
  }
});

await runTest("container_build_smoke", async () => {
  const dockerCheck = spawnSync("docker", ["--version"], { stdio: "pipe" });
  if (dockerCheck.status !== 0) {
    console.log("SKIP container_build_smoke — Docker engine unavailable in this environment (static validation only)");
    return;
  }
  const build = spawnSync("docker", ["build", "-t", "siton-app:readiness-test", "."], { stdio: "inherit" });
  assert.equal(build.status, 0, "docker build must succeed when Docker is available");
});

await runTest("compose_smoke", async () => {
  const dockerCheck = spawnSync("docker", ["--version"], { stdio: "pipe" });
  if (dockerCheck.status !== 0) {
    console.log("SKIP compose_smoke — Docker engine unavailable in this environment (static validation only)");
    return;
  }
  const composeCheck = spawnSync("docker", ["compose", "config", "--quiet"], { stdio: "pipe" });
  assert.equal(composeCheck.status, 0, "docker compose config must validate the compose file");
});
