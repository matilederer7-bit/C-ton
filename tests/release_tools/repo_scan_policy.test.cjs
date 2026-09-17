// Controls for the canonical repository-scan file policy.
//
//   real violation in canonical source      => detected
//   same text under .worktrees              => ignored
//   same text under temp/review artefacts   => ignored
//   nested canonical source                 => still detected
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTempDir } = require("./support/fixture_repo.cjs");
const policy = require("../../scripts/lib/repo_scan_policy.cjs");

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
}

test("walkRepository excludes worktrees, temp and generated directories but keeps nested canonical source", () => {
  const root = makeTempDir("siton-scan-policy-");
  try {
    writeTree(root, {
      "src/app.ts": "const violation = 1;",
      "src/nested/deeper/module.ts": "const violation = 2;",
      "tests/lab/proof.ts": "const violation = 3;",
      "scripts/lib/helper.cjs": "const violation = 4;",
      "web/src/page.tsx": "const violation = 5;",
      ".worktrees/review/src/app.ts": "const violation = 6;",
      ".tmp_review_2026/src/app.ts": "const violation = 7;",
      ".tmp_test_dist/src/app.js": "const violation = 8;",
      "node_modules/pkg/index.js": "const violation = 9;",
      ".demo_dist/src/app.js": "const violation = 10;",
      "web/dist/assets/app.js": "const violation = 11;",
      "coverage/lcov-report/app.js": "const violation = 12;",
      "src/review-independent-case.log": "violation 13",
      ".ci-artifacts/report.json": "{\"violation\": 14}",
      "archive/old/app.ts": "const violation = 15;",
      ".git/hooks/pre-commit.js": "const violation = 16;"
    });
    const rels = policy.walkRepository(root).map((file) => file.rel);
    assert.deepEqual(rels, [
      "scripts/lib/helper.cjs",
      "src/app.ts",
      "src/nested/deeper/module.ts",
      "tests/lab/proof.ts",
      "web/src/page.tsx"
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("roots option scopes the walk and refuses an excluded root", () => {
  const root = makeTempDir("siton-scan-policy-roots-");
  try {
    writeTree(root, { "src/a.ts": "", "scripts/b.cjs": "", ".worktrees/x/src/c.ts": "" });
    assert.deepEqual(policy.walkRepository(root, { roots: ["src"] }).map((f) => f.rel), ["src/a.ts"]);
    assert.deepEqual(policy.walkRepository(root, { roots: [".worktrees"] }).map((f) => f.rel), []);
    assert.deepEqual(policy.walkRepository(root, { roots: [".worktrees/x/src"] }).map((f) => f.rel), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("isCanonicalSourcePath agrees on both separators", () => {
  assert.equal(policy.isCanonicalSourcePath("src/app.ts"), true);
  assert.equal(policy.isCanonicalSourcePath("src\\deep\\app.ts"), true);
  assert.equal(policy.isCanonicalSourcePath(".worktrees/x/src/app.ts"), false);
  assert.equal(policy.isCanonicalSourcePath(".worktrees\\x\\src\\app.ts"), false);
  assert.equal(policy.isCanonicalSourcePath("tests/lab/oracle.ts"), true);
  assert.equal(policy.isCanonicalSourcePath("src/.tmp_probe/app.ts"), false);
  assert.equal(policy.isCanonicalSourcePath("src/review-run.log"), false);
  assert.equal(policy.isCanonicalSourcePath("legacy/render/render_config_gate.legacy.cjs"), true);
  assert.equal(policy.isCanonicalSourcePath("supabase/functions/storage-broker/index.ts"), true);
});

test("Capacitor-synced native web bundles are generated output, not canonical source", () => {
  // `mobile:sync` copies the built web bundle into the native shells. Before
  // this exclusion the payment scan walked those copies and matched the
  // raw-card term "pan" inside a minified `zoomAndPan` identifier, so the scan
  // passed or failed depending on whether a mobile build had run first.
  assert.equal(
    policy.isCanonicalSourcePath("android/app/src/main/assets/public/preview/assets/index-b3sXOwUn.js"),
    false
  );
  assert.equal(policy.isCanonicalSourcePath("ios/App/App/public/preview/assets/index-b3sXOwUn.js"), false);
  assert.equal(policy.isCanonicalSourcePath("android\\app\\src\\main\\assets\\public\\app.js"), false);

  // The real sources behind those copies, and anything else under the native
  // shells, stay scanned.
  assert.equal(policy.isCanonicalSourcePath("web/src/app.tsx"), true);
  assert.equal(policy.isCanonicalSourcePath("web/public/manifest.json"), true);
  assert.equal(policy.isCanonicalSourcePath("android/app/src/main/java/com/cton/MainActivity.java"), true);
  assert.equal(policy.isCanonicalSourcePath("ios/App/App/AppDelegate.swift"), true);
  assert.equal(policy.isCanonicalSourcePath("src/public/handler.ts"), true);
});

test("walkRepository does not descend into the Capacitor-synced native bundles", () => {
  const root = makeTempDir("siton-scan-policy-");
  try {
    const files = {
      "web/src/app.ts": "export const a = 1;\n",
      "android/app/src/main/assets/public/preview/assets/index-b3sXOwUn.js": "const zoomAndPan = 1;\n",
      "ios/App/App/public/preview/assets/index-b3sXOwUn.js": "const zoomAndPan = 1;\n",
      "android/app/src/main/java/App.java": "class App {}\n"
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    const walked = policy.walkRepository(root).map((entry) => entry.rel);
    assert.deepEqual(walked, ["web/src/app.ts"]);

    // Asking for the generated tree by name is refused rather than walked.
    assert.deepEqual(policy.walkRepository(root, { roots: ["android/app/src/main/assets/public"] }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("describePolicy lists what the scanners rely on", () => {
  const described = policy.describePolicy();
  for (const name of [".git", ".worktrees", "node_modules", "dist", "build", "coverage", ".demo_dist", ".tmp_test_dist"]) assert.ok(described.excluded_dir_names.includes(name), name);
  assert.ok(described.excluded_dir_prefixes.includes(".tmp"));
  assert.ok(described.always_scanned_examples.includes("tests/lab"));
});

test("every static scanner imports the shared policy instead of inventing exclusions", () => {
  const scanners = [
    "scripts/compliance_payment_scan.cjs",
    "scripts/backend_enforcement_scan.cjs",
    "scripts/runtime_ddl_scan.cjs",
    "scripts/money_tax_invoice_gate.cjs",
    "scripts/secret_pii_scan.cjs",
    "scripts/logging_hygiene_gate.cjs"
  ];
  const repoRoot = path.resolve(__dirname, "..", "..");
  for (const rel of scanners) {
    const file = path.join(repoRoot, rel);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /repo_scan_policy\.cjs/, rel + " must use the shared scan policy");
    assert.doesNotMatch(source, /new Set\(\[\s*"\.git"/, rel + " must not carry a private exclusion set");
  }
});
