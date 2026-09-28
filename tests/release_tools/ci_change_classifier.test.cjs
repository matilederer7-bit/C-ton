const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const { classifyChanges, claimFromPullRequest, TEST_LANES, groupMatrix } = require("../../scripts/ci_change_classifier.cjs");
const { GROUPS, shardAssignments, testInventory, parseShard } = require("../../scripts/run_test_group.cjs");
const { evaluate } = require("../../scripts/ci_verdict.cjs");

const mod = (p, added = [], removed = []) => ({ status: "M", path: p, added, removed });
const add = (p, added = ["x"]) => ({ status: "A", path: p, added, removed: [] });
const del = (p, removed = ["x"]) => ({ status: "D", path: p, added: [], removed });
const ren = (from, to) => ({ status: "R", oldPath: from, path: to, added: [], removed: [] });
const classify = (files, extra = {}) => classifyChanges({ event: "pull_request", files, ...extra });

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

test("a trivial docs change gets FAST", () => {
  const result = classify([mod("docs/CI_TEST_STRATEGY.md", ["better words"], ["old words"]), mod("PROJECT_STATUS.md", ["status"], [])]);
  assert.equal(result.level, "trivial");
  assert.equal(result.profile, "FAST");
  assert.equal(result.lanes.groups.length, 0);
  assert.equal(result.lanes.docker_smoke, false);
  assert.match(result.lanes.skipped.docker_smoke, /^FAST/);
  assert.equal(result.lanes.static, true, "static gates always run");
});

test("visual-only stylesheet and image changes get FAST with the browser suites focused", () => {
  const sources = new Map([
    ["frontend_browser_smoke_validation.ts", "browser"],
    ["visual_brand_consistency_validation.ts", "reads web/src/styles.css"],
    ["api_unrelated_validation.ts", "nothing"]
  ]);
  const result = classify([mod("web/src/styles.css", ["  color: var(--ink);"], ["  color: #333;"]), add("web/public/brand/mark.png", [])], { testSources: sources });
  assert.equal(result.profile, "FAST");
  assert.equal(result.level, "low");
  assert.deepEqual(result.focused_tests, ["frontend_browser_smoke_validation.ts", "visual_brand_consistency_validation.ts"]);
  assert.match(result.lanes.focused, /frontend_browser_smoke_validation\\\.ts/);
});

test("a pure copy change in a dictionary gets FAST and runs the tests asserting the old text", () => {
  const sources = new Map([
    ["landing_copy_validation.ts", "assert.match(html, /איך זה עובד בפועל/)"],
    ["i18n_contract_validation.ts", "contract"],
    ["unrelated_validation.ts", "nothing"]
  ]);
  const result = classify([mod("scripts/i18n/en.json", ['  "landing.how": "How it really works",'], ['  "landing.how": "איך זה עובד בפועל",'])], { testSources: sources });
  assert.equal(result.profile, "FAST");
  assert.ok(result.focused_tests.includes("landing_copy_validation.ts"), "a test that asserts the removed copy must run");
  assert.ok(result.focused_tests.includes("i18n_contract_validation.ts"));
  assert.ok(!result.focused_tests.includes("unrelated_validation.ts"));
});

test("a docs change runs the tests that read that document", () => {
  const sources = new Map([["operational_runbooks_validation.ts", "readFileSync('docs/INCIDENT_RESPONSE_RUNBOOK.md')"], ["other_validation.ts", "x"]]);
  const result = classify([mod("docs/INCIDENT_RESPONSE_RUNBOOK.md", ["step"], ["old step"])], { testSources: sources });
  assert.equal(result.profile, "FAST");
  assert.deepEqual(result.focused_tests, ["operational_runbooks_validation.ts"]);
});

test("an ordinary frontend change gets STANDARD, keeps every test group, and skips only backend-runtime proofs", () => {
  const result = classify([mod("web/src/pages/landing.tsx", ["  <h2 className=\"hero\">{t(\"landing.title\")}</h2>"], ["  <h2>{t(\"landing.title\")}</h2>"])]);
  assert.equal(result.level, "normal");
  assert.equal(result.profile, "STANDARD");
  assert.equal(result.lanes.groups.length, TEST_LANES.length, "all ten groups run");
  assert.equal(result.lanes.web_runtime_core, true);
  assert.equal(result.lanes.docker_release_lab, true, "the Docker image bundles the web app");
  assert.equal(result.lanes.docker_smoke, false);
  assert.equal(result.lanes.web_runtime_resilience, false);
  assert.equal(result.lanes.preflight_database, false);
  assert.match(result.lanes.skipped.preflight_database, /^STANDARD/);
});

test("an ordinary backend change gets STANDARD with every lane on", () => {
  const result = classify([mod("src/deal_chat.ts", ["  const trimmed = text.trim();"], ["  const trimmed = text;"])]);
  assert.equal(result.profile, "STANDARD");
  for (const key of ["web_runtime_core", "web_runtime_resilience", "docker_smoke", "docker_release_lab", "preflight_database"]) assert.equal(result.lanes[key], true, key);
});

for (const [label, file] of [
  ["migration", add("src/migrations/081_new_table.sql", ["CREATE TABLE x (id int);"])],
  ["supabase", mod("supabase/staging/config.toml", ["x"], ["y"])],
  ["payment module", mod("src/payment_service.ts", ["// comment"], [])],
  ["payout module", mod("src/seller_payout_rail.ts", ["// comment"], [])],
  ["auth module", mod("src/seller_auth.ts", ["// comment"], [])],
  ["web session", mod("web/src/session.ts", ["// comment"], [])],
  ["state machine", mod("src/app.ts", ["// comment"], [])],
  ["worker", mod("src/worker.ts", ["// comment"], [])],
  ["CI workflow", mod(".github/workflows/ci.yml", ["# c"], [])],
  ["dependencies", mod("package.json", ['    "left-pad": "1.0.0",'], [])],
  ["web dependencies", mod("web/package-lock.json", ["x"], [])],
  ["Dockerfile", mod("Dockerfile", ["RUN true"], [])],
  ["policy config", mod("config/route-classification.json", ["{}"], [])],
  ["test runner", mod("scripts/run_test_group.cjs", ["// c"], [])],
  ["classifier itself", mod("scripts/ci_change_classifier.cjs", ["// c"], [])],
  ["money gate", mod("scripts/money_tax_invoice_gate.cjs", ["// c"], [])],
  ["shared test helper", mod("tests/helpers/browser_cdp.ts", ["// c"], [])]
]) {
  test(`a ${label} change is forced to FULL`, () => {
    const result = classify([file]);
    assert.equal(result.profile, "FULL", JSON.stringify(result.files));
    assert.ok(["high", "critical"].includes(result.level));
    assert.equal(result.lanes.groups.length, TEST_LANES.length);
    assert.deepEqual(Object.keys(result.lanes.skipped), [], "FULL skips nothing");
  });
}

test("an unclassifiable change is forced to FULL", () => {
  for (const file of [add("Makefile"), add("weird/thing.txt"), add("src/styles.css"), add("docs/tool.cjs"), add("web/src/module.wasm"), mod(".gitignore", ["x"], [])]) {
    const result = classify([file]);
    assert.equal(result.profile, "FULL", file.path);
  }
});

test("an empty or unreadable pull-request diff is FULL", () => {
  assert.equal(classify([]).profile, "FULL");
});

test("pushes, schedules and manual runs are always FULL", () => {
  for (const event of ["push", "schedule", "workflow_dispatch"]) {
    const result = classifyChanges({ event, files: [mod("docs/a.md", ["x"], [])] });
    assert.equal(result.profile, "FULL", event);
  }
});

// ---------------------------------------------------------------------------
// Negative cases: a dangerous change cannot pass as a small one
// ---------------------------------------------------------------------------

test("proposing FAST for a critical change is rejected (and the profile stays FULL)", () => {
  const result = classify([mod("src/payment_service.ts", ["x"], [])], { claim: "FAST" });
  assert.equal(result.profile, "FULL");
  assert.equal(result.claim.accepted, false);
  assert.match(result.claim.error, /below the computed profile FULL/);
});

test("proposing FAST for a normal change is rejected; escalation is accepted", () => {
  const down = classify([mod("src/deal_chat.ts", ["const a = 1;"], [])], { claim: "FAST" });
  assert.equal(down.claim.accepted, false);
  assert.equal(down.profile, "STANDARD");
  const up = classify([mod("docs/a.md", ["x"], [])], { claim: "FULL" });
  assert.equal(up.claim.accepted, true);
  assert.equal(up.profile, "FULL");
  assert.equal(up.computed_profile, "FAST");
  const invalid = classify([mod("docs/a.md", ["x"], [])], { claim: "TINY" });
  assert.equal(invalid.claim.accepted, false);
});

test("PR labels and the CI-Profile body line are parsed; the highest proposal wins", () => {
  assert.equal(claimFromPullRequest({ labels: ["ci:fast"] }), "FAST");
  assert.equal(claimFromPullRequest({ body: "Summary\nCI-Profile: standard\n" }), "STANDARD");
  assert.equal(claimFromPullRequest({ labels: ["ci:fast"], body: "CI-Profile: FULL" }), "FULL");
  assert.equal(claimFromPullRequest({ labels: ["bug"], body: "nothing" }), null);
  assert.match(claimFromPullRequest({ body: "CI-Profile: whatever" }), /^INVALID:/);
});

test("a docs file renamed into a migration is FULL", () => {
  assert.equal(classify([ren("docs/notes.md", "src/migrations/082_x.sql")]).profile, "FULL");
});

test("a migration renamed into docs is still FULL (the riskier end counts)", () => {
  assert.equal(classify([ren("src/migrations/082_x.sql", "docs/old_migration.md")]).profile, "FULL");
});

test("a small change in an ordinary file that touches money, locking, SQL or credentials is FULL", () => {
  for (const line of ["const refundAmount = total - fee;", "await client.query('SELECT * FROM deals FOR UPDATE');", "await db.query('DELETE FROM participants')", "const secret = process.env.X;", "fs.rmSync(dir, { recursive: true })"]) {
    const result = classify([mod("src/deal_chat.ts", [line], [])]);
    assert.equal(result.profile, "FULL", line);
    assert.match(result.files[0].rule, /^content:/);
  }
  const web = classify([mod("web/src/pages/checkout.tsx", ["  <span>{formatAmount(price)}</span>"], [])]);
  assert.equal(web.profile, "FULL");
});

test("removed lines count too: deleting a lock or a check is not small", () => {
  const result = classify([mod("src/deal_chat.ts", [], ["  await client.query('SELECT 1 FROM deals WHERE id=$1 FOR UPDATE', [id]);"])]);
  assert.equal(result.profile, "FULL");
});

test("deleting or renaming any test is FULL; editing a money/security/db/concurrency/failure test is FULL", () => {
  assert.equal(classify([del("tests/deal_images_validation.ts")]).profile, "FULL");
  assert.equal(classify([ren("tests/deal_images_validation.ts", "tests/deal_images2_validation.ts")]).profile, "FULL");
  assert.equal(classify([ren("tests/deal_images_validation.ts", "docs/deal_images_validation.md")]).profile, "FULL");
  for (const name of ["platform_fee_payments_8_percent_validation.ts", "security_hardening_validation.ts", "database_state_validation.ts", "concurrency_join_validation.ts", "failure_injection_validation.ts"]) {
    const result = classify([mod(`tests/${name}`, ["assert.ok(true);"], ["assert.equal(fee, 8);"])]);
    assert.equal(result.profile, "FULL", name);
  }
});

test("a copy dictionary edit that is not only string entries is not FAST", () => {
  const structural = classify([mod("web/src/i18n/dictionaries/en.ts", ['import { x } from "../x";', '  "a.b": "Text",'], [])]);
  assert.notEqual(structural.profile, "FAST");
  const added = classify([add("scripts/i18n/new.json", ['  "a": "b"'])]);
  assert.notEqual(added.profile, "FAST", "a new dictionary file is not a copy tweak");
});

test("a large docs/visual change is not FAST", () => {
  const many = Array.from({ length: 30 }, (_, index) => mod(`docs/page_${index}.md`, ["x"], []));
  assert.equal(classify(many).profile, "STANDARD");
  const bigCss = classify([mod("web/src/styles.css", Array.from({ length: 400 }, (_, index) => `.c${index} { color: red; }`), [])]);
  assert.equal(bigCss.profile, "STANDARD");
});

test("mixing one critical file into a docs change makes the whole change FULL", () => {
  const result = classify([mod("docs/a.md", ["x"], []), mod("docs/b.md", ["x"], []), mod("src/migrations/001_init.sql", ["-- c"], [])]);
  assert.equal(result.profile, "FULL");
});

test("a cross-cutting change across many source files is FULL", () => {
  const files = Array.from({ length: 30 }, (_, index) => mod(`src/module_${index}.ts`, ["const a = 1;"], []));
  assert.equal(classify(files).profile, "FULL");
});

// ---------------------------------------------------------------------------
// Lanes, shards and the verdict
// ---------------------------------------------------------------------------

test("the test lanes cover every group exactly once, with every shard of a sharded group", () => {
  const seen = new Map();
  for (const lane of groupMatrix()) {
    for (const group of lane.groups.split(" ")) {
      const shard = lane.shard ? parseShard(lane.shard) : { index: 1, count: 1 };
      if (!seen.has(group)) seen.set(group, { count: shard.count, shards: new Set() });
      const entry = seen.get(group);
      assert.equal(entry.count, shard.count, `${group}: inconsistent shard count`);
      assert.ok(!entry.shards.has(shard.index), `${group}: shard ${shard.index} listed twice`);
      entry.shards.add(shard.index);
    }
  }
  assert.deepEqual([...seen.keys()].sort(), [...GROUPS].sort());
  for (const [group, entry] of seen) assert.equal(entry.shards.size, entry.count, `${group}: missing shard`);
});

test("shards are disjoint, complete and deterministic for the real inventory", () => {
  const inventory = testInventory(root);
  for (const group of GROUPS) {
    const names = inventory.filter((item) => item.group === group).map((item) => item.name);
    for (const count of [1, 2, 3, 4]) {
      const first = shardAssignments(names, count);
      const second = shardAssignments([...names].reverse(), count);
      assert.equal(first.size, names.length);
      for (const name of names) {
        assert.ok(first.get(name) >= 1 && first.get(name) <= count);
        assert.equal(first.get(name), second.get(name), `${name}: assignment depends on input order`);
      }
    }
  }
});

function fullNeeds(overrides = {}) {
  const needs = { classify: { result: "success" } };
  for (const job of ["static-gates", "tests", "focused-tests", "web-runtime-core", "web-runtime-resilience", "docker-smoke", "docker-release-lab", "preflight-database"]) needs[job] = { result: "success" };
  needs["focused-tests"] = { result: "skipped" };
  return { ...needs, ...overrides };
}

function manifestsFor(inventory, drop = null) {
  const byGroup = new Map();
  for (const item of inventory) {
    if (item.name === drop) continue;
    if (!byGroup.has(item.group)) byGroup.set(item.group, []);
    byGroup.get(item.group).push({ file: item.name, group: item.group, status: "pass" });
  }
  return [...byGroup].map(([group, results]) => ({ group, shard: null, results }));
}

test("the verdict passes a complete FULL run and fails when any file is missing, failed or duplicated", () => {
  const inventory = testInventory(root);
  const classification = classify([mod("src/app.ts", ["x"], [])]);
  assert.equal(evaluate({ classification, needs: fullNeeds(), manifests: manifestsFor(inventory), inventory }).ok, true);

  const missing = evaluate({ classification, needs: fullNeeds(), manifests: manifestsFor(inventory, inventory[0].name), inventory });
  assert.equal(missing.ok, false);
  assert.match(missing.failures.join("\n"), /missing 1 file/);

  const failed = manifestsFor(inventory);
  failed[0].results[0].status = "fail";
  assert.equal(evaluate({ classification, needs: fullNeeds(), manifests: failed, inventory }).ok, false);

  const duplicated = manifestsFor(inventory);
  duplicated.push({ group: duplicated[0].group, shard: "2/2", results: [duplicated[0].results[0]] });
  assert.match(evaluate({ classification, needs: fullNeeds(), manifests: duplicated, inventory }).failures.join("\n"), /ran twice/);
});

test("the verdict fails a required job that was skipped, cancelled or failed", () => {
  const inventory = testInventory(root);
  const classification = classify([mod("src/app.ts", ["x"], [])]);
  for (const result of ["skipped", "cancelled", "failure"]) {
    const verdict = evaluate({ classification, needs: fullNeeds({ "docker-smoke": { result } }), manifests: manifestsFor(inventory), inventory });
    assert.equal(verdict.ok, false, result);
  }
  assert.equal(evaluate({ classification, needs: fullNeeds({ classify: { result: "failure" } }), manifests: [], inventory }).ok, false);
});

test("the verdict accepts declared FAST skips and fork-only Docker skips, and rejects a downgrade proposal", () => {
  const inventory = testInventory(root);
  const fast = classify([mod("docs/a.md", ["x"], [])]);
  const skippedAll = { classify: { result: "success" }, "static-gates": { result: "success" } };
  for (const job of ["tests", "focused-tests", "web-runtime-core", "web-runtime-resilience", "docker-smoke", "docker-release-lab", "preflight-database"]) skippedAll[job] = { result: "skipped" };
  assert.equal(evaluate({ classification: fast, needs: skippedAll, manifests: [], inventory }).ok, true);
  assert.equal(evaluate({ classification: fast, needs: { ...skippedAll, "static-gates": { result: "failure" } }, manifests: [], inventory }).ok, false);

  const full = classify([mod("src/app.ts", ["x"], [])]);
  const forkNeeds = fullNeeds({ "docker-smoke": { result: "skipped" }, "docker-release-lab": { result: "skipped" }, "web-runtime-resilience": { result: "skipped" } });
  assert.equal(evaluate({ classification: full, needs: forkNeeds, manifests: manifestsFor(inventory), inventory, sameRepo: false }).ok, true);
  assert.equal(evaluate({ classification: full, needs: forkNeeds, manifests: manifestsFor(inventory), inventory, sameRepo: true }).ok, false);

  const downgraded = classify([mod("src/payment_service.ts", ["x"], [])], { claim: "FAST" });
  const verdict = evaluate({ classification: downgraded, needs: fullNeeds(), manifests: manifestsFor(inventory), inventory });
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures.join("\n"), /profile proposal rejected/);
});

test("the verdict checks that exactly the focused files ran in a FAST run", () => {
  const inventory = testInventory(root);
  const sources = new Map([["operational_runbooks_validation.ts", "docs/RUNBOOK_X.md"]]);
  const fast = classify([mod("docs/RUNBOOK_X.md", ["x"], [])], { testSources: sources });
  const needs = { classify: { result: "success" }, "static-gates": { result: "success" }, "focused-tests": { result: "success" } };
  for (const job of ["tests", "web-runtime-core", "web-runtime-resilience", "docker-smoke", "docker-release-lab", "preflight-database"]) needs[job] = { result: "skipped" };
  const ok = evaluate({ classification: fast, needs, manifests: [{ group: "focused", results: [{ file: "operational_runbooks_validation.ts", status: "pass" }] }], inventory });
  assert.equal(ok.ok, true, ok.failures.join("\n"));
  assert.equal(evaluate({ classification: fast, needs, manifests: [{ group: "focused", results: [] }], inventory }).ok, false);
  assert.equal(evaluate({ classification: fast, needs, manifests: [], inventory }).ok, false);
});

// ---------------------------------------------------------------------------
// End to end on a real git repository (paths, renames, deletions, content)
// ---------------------------------------------------------------------------

test("the CLI classifies a real git diff and writes GitHub outputs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "siton-classifier-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "ci@example.invalid");
    git("config", "user.name", "ci");
    fs.mkdirSync(path.join(dir, "docs"));
    fs.mkdirSync(path.join(dir, "tests"));
    fs.mkdirSync(path.join(dir, "src", "migrations"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs", "guide.md"), "hello\n");
    fs.writeFileSync(path.join(dir, "tests", "guide_validation.ts"), "readFileSync('docs/guide.md')\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");

    fs.writeFileSync(path.join(dir, "docs", "guide.md"), "hello world\n");
    git("commit", "-qam", "docs");
    const docsHead = git("rev-parse", "HEAD");
    const outFile = path.join(dir, "out.txt");
    const run = (head, extra = []) => spawnSync(process.execPath, [path.join(root, "scripts", "ci_change_classifier.cjs"), "--base", base, "--head", head, "--github-output", outFile, "--json", path.join(dir, "c.json"), ...extra], { cwd: dir, encoding: "utf8" });
    let result = run(docsHead);
    assert.equal(result.status, 0, result.stderr);
    let json = JSON.parse(fs.readFileSync(path.join(dir, "c.json"), "utf8"));
    assert.equal(json.profile, "FAST");
    assert.deepEqual(json.focused_tests, ["guide_validation.ts"]);
    assert.match(fs.readFileSync(outFile, "utf8"), /^profile=FAST$/m);

    git("mv", "docs/guide.md", "src/migrations/090_guide.sql");
    git("commit", "-qm", "sneaky rename");
    result = run(git("rev-parse", "HEAD"), ["--claim", "FAST"]);
    assert.equal(result.status, 0, result.stderr);
    json = JSON.parse(fs.readFileSync(path.join(dir, "c.json"), "utf8"));
    assert.equal(json.profile, "FULL");
    assert.equal(json.claim.accepted, false);

    git("rm", "-q", "tests/guide_validation.ts");
    git("commit", "-qm", "drop a test");
    result = run(git("rev-parse", "HEAD"));
    assert.equal(result.status, 0, result.stderr);
    json = JSON.parse(fs.readFileSync(path.join(dir, "c.json"), "utf8"));
    assert.equal(json.profile, "FULL");
    assert.ok(json.files.some((file) => file.rule === "test-removed"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
