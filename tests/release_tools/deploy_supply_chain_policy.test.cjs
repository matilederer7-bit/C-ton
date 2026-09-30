// Black-Sky E8/E9: deploy gating and image supply-chain contracts.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const directives = (text) => text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join("\n");

test("E8: every Render service auto-deploys only after checks pass", () => {
  const blueprint = directives(read("render.yaml"));
  const services = blueprint.split(/\n\s*-\s+type:\s*/).slice(1);
  assert.equal(services.length, 2, "web + worker");
  for (const service of services) {
    const name = (service.match(/name:\s*(\S+)/) || [])[1];
    assert.match(service, /^\s+autoDeployTrigger:\s*checksPass\s*$/m, `${name} must use autoDeployTrigger: checksPass`);
    assert.doesNotMatch(service, /^\s+autoDeploy:\s*true\s*$/m, `${name} must not deploy on push alone`);
  }
});

test("E9: the image base is digest-pinned and the runtime image carries production dependencies only", () => {
  const dockerfile = directives(read("Dockerfile"));
  assert.match(dockerfile, /^FROM node:22-bookworm-slim@sha256:[0-9a-f]{64}\s*$/m, "base image pinned by digest");
  const buildAt = dockerfile.indexOf("npm run build:demo");
  const pruneAt = dockerfile.search(/^RUN npm prune --omit=dev/m);
  const userAt = dockerfile.search(/^USER appuser/m);
  assert.ok(buildAt > -1 && pruneAt > buildAt, "dev dependencies are pruned after the build that needs them");
  assert.ok(userAt > pruneAt, "pruned before the runtime user takes over");
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.dependencies.dotenv, "dotenv is loaded at boot (src/runtime_config.ts) so it must be a runtime dependency");
  assert.ok(!pkg.devDependencies || !pkg.devDependencies.dotenv);
  const lock = JSON.parse(read("package-lock.json"));
  assert.ok(lock.packages[""].dependencies.dotenv);
  assert.notEqual(lock.packages["node_modules/dotenv"].dev, true, "lockfile must not mark dotenv dev-only (npm prune would remove it)");
  // Every bare package the compiled runtime imports must survive the prune.
  const runtimeImports = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "migrations") walk(rel); continue; }
      if (!rel.endsWith(".ts")) continue;
      for (const m of read(rel).matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+"([^".][^"]*)"/gm)) {
        if (m[1].startsWith("node:") || require("node:module").builtinModules.includes(m[1].split("/")[0])) continue;
        const parts = m[1].split("/");
        runtimeImports.add(m[1].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
      }
    }
  };
  walk("src");
  for (const name of runtimeImports) {
    assert.ok(pkg.dependencies[name], `runtime import "${name}" must be a production dependency`);
  }
});

test("E9: CI blocks on production high/critical advisories but not on registry outages; Dependabot covers npm, docker and actions", () => {
  const gates = read(".github/workflows/ci.yml");
  assert.match(gates, /npm audit --omit=dev --audit-level=high --json/);
  assert.match(gates, /::error::npm audit found HIGH\/CRITICAL/);
  assert.match(gates, /::warning::npm audit unavailable/);
  const dependabot = directives(read(".github/dependabot.yml"));
  for (const ecosystem of ["npm", "docker", "github-actions"]) {
    assert.match(dependabot, new RegExp(`package-ecosystem: ${ecosystem}\\n`));
  }
  assert.doesNotMatch(dependabot, /automerge|auto-merge/i);
});
