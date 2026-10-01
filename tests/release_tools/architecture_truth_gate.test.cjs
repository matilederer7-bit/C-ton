// Architecture truth gate — mutation tests.
//
// The gate must PASS on the repository as committed and FAIL, with the named
// reason, on every architectural drift it exists to catch. Each case copies the
// gate's exact input surface into a scratch repository, applies one mutation
// and runs the gate against that root, so a regression in the gate (an
// assertion silently dropped or loosened) shows up here as a test failure.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const gate = require(path.join(ROOT, "scripts", "architecture_truth_gate.cjs"));

function migrationFiles() {
  const manifest = fs.readFileSync(path.join(ROOT, "scripts", "migration_manifest.cjs"), "utf8");
  return [...manifest.matchAll(/\["([^"]+)",\s*"([^"]+)"\]/g)].map((m) => `src/migrations/${m[2]}`);
}

function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "siton-arch-gate-"));
  for (const relative of [...gate.GATE_INPUT_FILES, ...migrationFiles()]) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), target);
  }
  return {
    dir,
    read: (relative) => fs.readFileSync(path.join(dir, relative), "utf8"),
    write: (relative, content) => { fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true }); fs.writeFileSync(path.join(dir, relative), content); },
    // `edit` rewrites the FIRST occurrence (one service block of two);
    // `editAll` rewrites every occurrence, for phrases a document may repeat.
    edit: (relative, from, to) => {
      const before = fs.readFileSync(path.join(dir, relative), "utf8");
      assert.ok(before.includes(from), `fixture ${relative} does not contain ${JSON.stringify(from)}`);
      fs.writeFileSync(path.join(dir, relative), before.replace(from, to));
    },
    editAll: (relative, from, to) => {
      const before = fs.readFileSync(path.join(dir, relative), "utf8");
      assert.ok(before.includes(from), `fixture ${relative} does not contain ${JSON.stringify(from)}`);
      fs.writeFileSync(path.join(dir, relative), before.split(from).join(to));
    },
    remove: (relative) => fs.rmSync(path.join(dir, relative), { recursive: true, force: true }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

function expectFail(mutate, reason) {
  const repo = scratchRepo();
  try {
    assert.doesNotThrow(() => gate.runArchitectureGate(repo.dir), "the untouched fixture must pass before mutation");
    mutate(repo);
    assert.throws(() => gate.runArchitectureGate(repo.dir), (error) => {
      assert.match(error.message, /^ARCHITECTURE_GATE_FAIL /);
      assert.match(error.message, reason);
      return true;
    }, `the gate must reject the mutation (expected reason ${reason})`);
  } finally {
    repo.cleanup();
  }
}

test("gate: passes on the repository and names the real runtime", () => {
  const { banner } = gate.runArchitectureGate(ROOT);
  assert.match(banner, /^ARCHITECTURE_GATE_PASS runtime=render_web\+render_worker\+supabase_postgres web=siton-staging-web worker=siton-staging-worker deploy=checksPass target_inventory=canonical_postgres migrations=\d+$/);
  assert.doesNotMatch(banner, /base44/i);
});

test("gate: the active shell pages and PowerShell tooling are inside the Base44 scan surface", () => {
  const scanned = gate.listBase44ScanFiles(ROOT).map((file) => path.relative(ROOT, file).replace(/\\/g, "/"));
  for (const live of ["frontend/index.html", "frontend/offline.html", "scripts/restart_server_clean.ps1", "scripts/restart_server_tsnode_clean.ps1", "web/index.html", "web/vite.config.ts", "package.json", "Dockerfile", ".github/workflows/ci.yml"]) {
    assert.ok(scanned.includes(live), `${live} must be scanned for the Base44 token`);
  }
});

test("gate: the blueprint parser reads both canonical services with their env entries", () => {
  const services = gate.parseBlueprintServices(fs.readFileSync(path.join(ROOT, "render.yaml"), "utf8"));
  assert.deepEqual(services.map((s) => [s.type, s.name]), [["web", gate.CANONICAL_WEB], ["worker", gate.CANONICAL_WORKER]]);
  const web = services[0];
  assert.deepEqual(web.$env.find((e) => e.key === "DATABASE_URL"), { key: "DATABASE_URL", sync: "false" });
  assert.deepEqual(web.$env.find((e) => e.key === "RUNTIME_ROLE"), { key: "RUNTIME_ROLE", value: "web" });
  assert.deepEqual(web.$env.find((e) => e.key === "ADMIN_API_KEY"), { key: "ADMIN_API_KEY", generateValue: "true" });
});

// ── Render topology ───────────────────────────────────────────────────────
test("drift: a second web service in the blueprint", () => {
  expectFail((repo) => {
    const blueprint = repo.read("render.yaml");
    const webBlock = blueprint.slice(blueprint.indexOf("  - type: web"), blueprint.indexOf("  - type: worker"));
    repo.write("render.yaml", blueprint + "\n" + webBlock.replace("name: siton-staging-web", "name: siton-staging-web-atp1"));
  }, /exactly two services|exactly one web service/);
});

test("drift: a second background worker", () => {
  expectFail((repo) => {
    const blueprint = repo.read("render.yaml");
    const workerBlock = blueprint.slice(blueprint.indexOf("  - type: worker"));
    repo.write("render.yaml", blueprint + "\n" + workerBlock.replace("name: siton-staging-worker", "name: siton-staging-worker-2"));
  }, /exactly one Background Worker/);
});

test("drift: a third service written in a layout the parser does not recognise", () => {
  expectFail((repo) => repo.write("render.yaml", repo.read("render.yaml") + "\n  -   type: web\n      name: siton-shadow-web\n      runtime: docker\n      dockerfilePath: ./Dockerfile\n"), /exactly two services, web \+ worker \(found 3 type: directives\)/);
  expectFail((repo) => repo.write("render.yaml", repo.read("render.yaml") + "\n  - {type: web, name: siton-shadow-web}\n"), /exactly two services|unrecognised blueprint line/);
});

test("drift: a second top-level block (a Render-managed database)", () => {
  expectFail((repo) => repo.write("render.yaml", repo.read("render.yaml") + "\ndatabases:\n  - name: siton-db\n    plan: free\n"), /only the services: block/);
});

test("drift: the worker scaled to several instances", () => {
  expectFail((repo) => repo.edit("render.yaml", "    dockerCommand: node .demo_dist/src/worker.js\n", "    dockerCommand: node .demo_dist/src/worker.js\n    numInstances: 3\n"), /must stay a single instance/);
});

test("drift: a second envVars block or Render's legacy env: alias", () => {
  expectFail((repo) => repo.edit("render.yaml", "      - key: SENTRY_DSN\n        sync: false\n\n", "      - key: SENTRY_DSN\n        sync: false\n    envVars:\n      - key: FOO\n        value: bar\n\n"), /duplicate envVars block/);
  expectFail((repo) => repo.edit("render.yaml", "    runtime: docker\n", "    env: docker\n"), /legacy env: alias is not accepted/);
});

test("drift: real payouts switched on through the blueprint", () => {
  expectFail((repo) => repo.edit("render.yaml", "      - key: PAYOUT_PROVIDER\n        value: internal-ledger\n", "      - key: PAYOUT_PROVIDER\n        value: internal-ledger\n      - key: PAYOUT_PROVIDER_MODE\n        value: provider-live\n"), /PAYOUT_PROVIDER_MODE/);
  expectFail((repo) => repo.edit("render.yaml", "      - key: PAYOUT_PROVIDER\n        value: internal-ledger\n", "      - key: PAYOUT_PROVIDER\n        value: internal-ledger\n      - key: PAYOUT_PROVIDER_API_KEY\n        sync: false\n"), /must not carry PAYOUT_PROVIDER_API_KEY/);
  expectFail((repo) => repo.edit("render.yaml", "      - key: PAYOUT_PROVIDER\n        value: internal-ledger\n", "      - key: PAYOUT_PROVIDER\n        value: grow-payouts\n"), /PAYOUT_PROVIDER=internal-ledger/);
  expectFail((repo) => repo.edit("render.yaml", "      - key: PAYOUT_PROVIDER\n        value: internal-ledger\n", ""), /PAYOUT_PROVIDER=internal-ledger/);
  expectFail((repo) => repo.edit("render.yaml", "      - key: PAYOUT_PROVIDER\n        value: internal-ledger\n", "      - key: PAYOUT_PROVIDER\n        value: internal-ledger\n      - key: PAYOUT_PROVIDER_MODE\n        value: adapter-ready\n"), /PAYOUT_PROVIDER_MODE/);
  expectFail((repo) => repo.edit("render.yaml", "      - key: PAYOUT_PROVIDER\n        value: internal-ledger\n", "      - key: PAYOUT_PROVIDER\n        value: internal-ledger\n      - key: PAYOUT_PROVIDER_BASE_URL\n        value: https://payouts.example.test\n"), /must not carry PAYOUT_PROVIDER_BASE_URL/);
});

test("drift: the web service renamed", () => {
  expectFail((repo) => repo.edit("render.yaml", "name: siton-staging-web\n", "name: siton-demo-preview\n"), /must be named siton-staging-web/);
});

test("drift: deploy on push instead of after the checks pass", () => {
  expectFail((repo) => repo.edit("render.yaml", "autoDeployTrigger: checksPass\n", "autoDeployTrigger: commit\n"), /autoDeployTrigger: checksPass/);
});

test("drift: a service deploying another branch", () => {
  expectFail((repo) => repo.edit("render.yaml", "    branch: master\n", "    branch: develop\n"), /must deploy branch master/);
});

test("drift: the worker started through npm (npm as PID 1)", () => {
  expectFail((repo) => repo.edit("render.yaml", "dockerCommand: node .demo_dist/src/worker.js", "dockerCommand: npm run start:worker:prod"), /Background Worker must start|never start a runtime through npm/);
});

test("drift: the worker losing RUNTIME_ROLE=worker", () => {
  expectFail((repo) => repo.edit("render.yaml", "      - key: RUNTIME_ROLE\n        value: worker\n", ""), /RUNTIME_ROLE=worker/);
});

test("drift: the web service losing RUNTIME_ROLE=web", () => {
  expectFail((repo) => repo.edit("render.yaml", "      - key: RUNTIME_ROLE\n        value: web\n", ""), /RUNTIME_ROLE=web/);
});

test("drift: the web service running the outbox worker too", () => {
  expectFail((repo) => repo.edit("render.yaml", "      - key: DISABLE_OUTBOX_WORKER\n        value: \"1\"\n", ""), /DISABLE_OUTBOX_WORKER=1/);
});

test("drift: the worker disabling the outbox worker", () => {
  expectFail((repo) => repo.edit("render.yaml", "      - key: RUNTIME_ROLE\n        value: worker\n", "      - key: RUNTIME_ROLE\n        value: worker\n      - key: DISABLE_OUTBOX_WORKER\n        value: \"1\"\n"), /worker service must not disable the outbox worker/);
});

test("drift: the web health check moved off /readiness", () => {
  expectFail((repo) => repo.edit("render.yaml", "healthCheckPath: /readiness", "healthCheckPath: /health"), /health-check \/readiness|health check must be \/readiness/);
});

// ── Secrets and money through the blueprint ───────────────────────────────
test("drift: DATABASE_URL inline in the blueprint", () => {
  expectFail((repo) => repo.edit("render.yaml", "      - key: DATABASE_URL\n        sync: false\n", "      - key: DATABASE_URL\n        value: postgresql://siton_web_login:hunter2@db.example.supabase.co:5432/postgres\n"), /must not embed a database credential/);
});

test("drift: the web DATABASE_URL no longer an external secret while the worker's still is", () => {
  // The worker's entry keeps the blueprint-wide `DATABASE_URL / sync: false`
  // regex satisfied, so only the per-service assertion can catch this.
  expectFail((repo) => repo.edit("render.yaml", "      - key: DATABASE_URL\n        sync: false\n", "      - key: DATABASE_URL\n        value: \"\"\n"), /web siton-staging-web DATABASE_URL must be an external secret/);
});

test("drift: a DATABASE_URL sourced from a Render-managed database", () => {
  expectFail((repo) => repo.edit("render.yaml", "      - key: DATABASE_URL\n        sync: false\n", "      - key: DATABASE_URL\n        fromDatabase:\n          name: siton-db\n          property: connectionString\n"), /env source fromDatabase is not accepted/);
});

test("drift: a secret-like key carried inline", () => {
  expectFail((repo) => repo.edit("render.yaml", "      - key: SITON_STORAGE_BROKER_KEY\n        sync: false\n", "      - key: SITON_STORAGE_BROKER_KEY\n        value: brk_live_0123456789\n"), /must never carry SITON_STORAGE_BROKER_KEY inline/);
});

test("drift: real money activated through the blueprint", () => {
  expectFail((repo) => repo.edit("render.yaml", "      - key: PAYMENT_ENVIRONMENT\n        value: demo\n", "      - key: PAYMENT_ENVIRONMENT\n        value: live\n"), /PAYMENT_ENVIRONMENT=demo/);
  expectFail((repo) => repo.edit("render.yaml", "      - key: PAYMENT_ENVIRONMENT\n        value: demo\n", "      - key: PAYMENT_ENVIRONMENT\n        value: live # temporary\n"), /PAYMENT_ENVIRONMENT=demo/);
  expectFail((repo) => repo.edit("render.yaml", "      - key: PAYMENT_ENVIRONMENT\n        value: demo\n", "      - key: PAYMENT_ENVIRONMENT\n        value: 'live'\n"), /PAYMENT_ENVIRONMENT=demo/);
  expectFail((repo) => repo.edit("render.yaml", "      - key: PAYMENT_ENVIRONMENT\n        value: demo\n", "      - key: PAYMENT_ENVIRONMENT\n        value: sandbox\n"), /PAYMENT_ENVIRONMENT=demo/);
});

test("drift: a duplicated env key overriding the provider later in the list", () => {
  expectFail((repo) => repo.edit("render.yaml", "      - key: SENTRY_DSN\n        sync: false\n", "      - key: SENTRY_DSN\n        sync: false\n      - key: PAYMENT_PROVIDER\n        value: grow\n"), /duplicate env key PAYMENT_PROVIDER/);
});

test("drift: a flow-style env entry smuggling a credential", () => {
  expectFail((repo) => repo.edit("render.yaml", "      - key: SENTRY_DSN\n        sync: false\n", "      - key: SENTRY_DSN\n        sync: false\n      - {key: GROW_API_KEY, value: sk_live_x}\n"), /unrecognised blueprint line/);
});

test("drift: a real payment provider in the checked-in blueprint", () => {
  expectFail((repo) => repo.edit("render.yaml", "      - key: PAYMENT_PROVIDER\n        value: mockpay\n", "      - key: PAYMENT_PROVIDER\n        value: grow\n"), /mock payment provider/);
});

test("drift: a demo deployment mode on a hosted service", () => {
  expectFail((repo) => repo.edit("render.yaml", "      - key: APP_DEPLOYMENT_MODE\n        value: staging\n", "      - key: APP_DEPLOYMENT_MODE\n        value: demo\n"), /APP_DEPLOYMENT_MODE/);
});

// ── Base44 / legacy runtime regressions ───────────────────────────────────
test("drift: the blueprint referencing Base44", () => {
  expectFail((repo) => repo.edit("render.yaml", "      - key: STORAGE_ADAPTER\n        value: supabase\n", "      - key: STORAGE_ADAPTER\n        value: base44\n"), /must not reference Base44/);
});

test("drift: the inventory repository bridging to an external HTTP service", () => {
  expectFail((repo) => repo.write("src/inventory_repository.ts", repo.read("src/inventory_repository.ts") + "\nconst bridge = fetch(\"https://bridge.example.base44.app/inventory\");\n"), /external bridge/);
});

test("drift: a Base44 SDK call or token coming back in a code tree", () => {
  // The planted strings are assembled at runtime so this test file itself
  // never contains them.
  const sdkCall = ["create", "Client", "FromRequest"].join("");
  const entityCall = ["base44", ".entities.", "Deal", ".filter("].join("");
  const token = ["Base", "44"].join("");
  expectFail((repo) => repo.write("frontend/planted.js", `const client = ${sdkCall}(req);\n`), /Base44 SDK usage in frontend\/planted\.js/);
  expectFail((repo) => repo.write("scripts/planted_tool.cjs", `module.exports = async () => ${entityCall}{ id: 1 });\n`), /Base44 SDK usage in scripts\/planted_tool\.cjs/);
  expectFail((repo) => repo.write("tests/planted_validation.ts", `const rows = await ${entityCall}{});\n`), /Base44 SDK usage in tests\/planted_validation\.ts/);
  expectFail((repo) => repo.write("web/src/planted.ts", `export const runtime = "${token}";\n`), /Base44 reference in web\/src\/planted\.ts/);
  expectFail((repo) => repo.write(".github/workflows/planted.yml", `name: ${token} sync\non: push\n`), /Base44 reference in \.github\/workflows\/planted\.yml/);
  expectFail((repo) => repo.write("src/planted.ts", `export const BRIDGE = "${token.toLowerCase()}-bridge";\n`), /Base44 reference in src\/planted\.ts/);
  expectFail((repo) => repo.write("web/vite.config.ts", `import plugin from "@${token.toLowerCase()}/vite-plugin";\n`), /Base44 SDK usage in web\/vite\.config\.ts/);
  expectFail((repo) => repo.write("web/index.html", `<script src="https://cdn.${token.toLowerCase()}.app/sdk.js"></script>\n`), /Base44 reference in web\/index\.html/);
  expectFail((repo) => repo.write("frontend/planted.html", `<meta name="runtime" content="${token}">\n`), /Base44 reference in frontend\/planted\.html/);
  expectFail((repo) => repo.write("scripts/planted.sh", `#!/bin/sh\necho deploying to ${token}\n`), /Base44 reference in scripts\/planted\.sh/);
  expectFail((repo) => repo.write("scripts/planted_restart.ps1", `# restart helper\n$runtime = "${token}"\nStart-Process node\n`), /Base44 reference in scripts\/planted_restart\.ps1/);
  expectFail((repo) => repo.write("frontend/offline.html", `<!doctype html><title>offline</title><script src="https://cdn.${token.toLowerCase()}.app/sdk.js"></script>\n`), /Base44 reference in frontend\/offline\.html/);
  expectFail((repo) => repo.write("tests/planted_entity_validation.ts", `const row = await client${[".entities[", "\"Deal\"", "]"].join("")}.get("x");\n`), /Base44 SDK usage in tests\/planted_entity_validation\.ts/);
  expectFail((repo) => repo.write("tests/planted_get_validation.ts", `const row = await client${[".entities.", "Deal", ".get("].join("")}"x");\n`), /Base44 SDK usage in tests\/planted_get_validation\.ts/);
  expectFail((repo) => {
    const pkg = JSON.parse(repo.read("package.json"));
    pkg.scripts["deploy:legacy"] = `${token.toLowerCase()} deploy`;
    repo.write("package.json", JSON.stringify(pkg));
  }, /Base44 reference in package\.json/);
});

test("control: the canonical Supabase Edge Function call is not mistaken for the legacy SDK", () => {
  const repo = scratchRepo();
  try {
    repo.write("web/src/broker.ts", "export const call = () => supabase.functions.invoke(\"storage-broker\", { body: {} });\n");
    assert.doesNotThrow(() => gate.runArchitectureGate(repo.dir));
  } finally {
    repo.cleanup();
  }
});

test("drift: a root Procfile or a second Render blueprint", () => {
  expectFail((repo) => repo.write("Procfile", "web: npm start\n"), /Procfile/);
  expectFail((repo) => repo.write("render.legacy.yaml", "services: []\n"), /Render artifacts left at repository root/);
});

test("drift: the architecture SoT certifying Base44 as the production runtime", () => {
  expectFail((repo) => repo.editAll("docs/CURRENT_ARCHITECTURE_2026-09-30.md", "**Base44** is historical.", "**Base44** is historical. production_runtime: base44"), /never certify Base44/);
  expectFail((repo) => repo.editAll("docs/CURRENT_ARCHITECTURE_2026-09-30.md", "**Base44** is historical.", "**Base44** is the authority."), /Base44 is historical/);
});

test("drift: the architecture SoT no longer naming the real runtime", () => {
  expectFail((repo) => repo.editAll("docs/CURRENT_ARCHITECTURE_2026-09-30.md", "Render web + Render worker + Supabase PostgreSQL", "Render web + Supabase PostgreSQL"), /Render web \+ Render worker \+ Supabase PostgreSQL/);
});

// ── Image / package / src role separation ─────────────────────────────────
test("drift: npm as PID 1 in the image", () => {
  expectFail((repo) => repo.edit("Dockerfile", 'CMD ["node", ".demo_dist/src/app.js"]', 'CMD ["npm", "run", "start:web:prod"]'), /image CMD|npm must not be PID 1/);
});

test("drift: package start scripts diverging from the image and blueprint entrypoints", () => {
  expectFail((repo) => {
    const pkg = JSON.parse(repo.read("package.json"));
    pkg.scripts["start:worker:prod"] = "npm run start:worker";
    repo.write("package.json", JSON.stringify(pkg));
  }, /start:worker:prod/);
});

test("drift: the production guards no longer requiring RUNTIME_ROLE", () => {
  expectFail((repo) => repo.edit("src/production_guards.ts", "RUNTIME_ROLE is required in production", "RUNTIME_ROLE is optional"), /must require RUNTIME_ROLE/);
});

test("drift: the production guards letting the web process run the outbox worker", () => {
  expectFail((repo) => repo.edit("src/production_guards.ts", "production web requires DISABLE_OUTBOX_WORKER=1", "production web may run the outbox worker"), /outbox worker off the web process/);
});

test("drift: the worker losing its explicit database boundary", () => {
  expectFail((repo) => repo.edit("src/worker.ts", 'createRuntimePool("worker", 2)', 'createRuntimePool("web", 2)'), /Worker database boundary/);
});

// ── Supabase PostgreSQL contracts ─────────────────────────────────────────
test("drift: a migration in REQUIRED_MIGRATION_IDS that the manifest does not declare", () => {
  expectFail((repo) => repo.edit("src/schema_contract.ts", '"081"', '"081", "099"'), /REQUIRED_MIGRATION_IDS names 099/);
});

test("drift: the newest manifest migration missing from the schema contract", () => {
  expectFail((repo) => {
    repo.write("src/migrations/099_future.sql", "SELECT 1;\n");
    repo.edit("scripts/migration_manifest.cjs", '["081", "081_outbox_enqueue_evidence_rls.sql"]', '["081", "081_outbox_enqueue_evidence_rls.sql"],\n  ["099", "099_future.sql"]');
  }, /newest migration \(099\) must be in REQUIRED_MIGRATION_IDS/);
});

test("drift: a manifest entry whose file is gone", () => {
  expectFail((repo) => repo.remove("src/migrations/081_outbox_enqueue_evidence_rls.sql"), /missing file: 081_outbox_enqueue_evidence_rls\.sql/);
});

test("drift: the web runtime profile becoming a LOGIN role", () => {
  expectFail((repo) => repo.edit("supabase/staging/006_canonical_postgres_runtime_boundary.sql", "CREATE ROLE siton_web_runtime NOLOGIN NOINHERIT", "CREATE ROLE siton_web_runtime LOGIN NOINHERIT"), /Web access profile is not NOLOGIN/);
});

test("drift: a password literal in the worker login provisioning", () => {
  expectFail((repo) => repo.write("supabase/staging/011_r4_worker_login_provisioning.sql", repo.read("supabase/staging/011_r4_worker_login_provisioning.sql") + "\nALTER ROLE siton_worker_login PASSWORD 'hunter2';\n"), /password literal/);
});

test("drift: browser roles regaining schema access", () => {
  expectFail((repo) => repo.edit("supabase/staging/006_canonical_postgres_runtime_boundary.sql", "REVOKE ALL ON SCHEMA siton, siton_inventory FROM anon, authenticated", "GRANT USAGE ON SCHEMA siton, siton_inventory TO anon, authenticated"), /browser schema access is not fail-closed/);
});
