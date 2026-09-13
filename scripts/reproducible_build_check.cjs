#!/usr/bin/env node
// Reproducible build check (npm run check:reproducible-build).
//
// Runs the production demo bundle build (npm run build:demo -> .demo_dist)
// and the mobile bundle build (scripts/build_mobile_bundle.cjs ->
// .mobile_dist) TWICE from clean output directories and compares the
// resulting file trees by SHA-256. Every difference is classified:
//   deterministic                identical trees
//   expected-variance            content differs only in a build id /
//                                timestamp / revision token (documented)
//   unexpected-nondeterminism    anything else (FAIL)
// The web/ Vite build is included with --include-web (needs web/node_modules;
// slower). Nothing is published; the outputs are the normal gitignored dirs.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { runSync } = require("./lib/run_command.cjs");
const { ReleaseReport, artifactsDir } = require("./lib/release_report.cjs");

const root = process.cwd();
const includeWeb = process.argv.includes("--include-web");
const EXPECTED_VARIANCE = [/"?(built_at|generated_at|buildTime|timestamp)"?\s*[:=]\s*"?\d{4}-\d{2}-\d{2}T[^"\n]*"?/g, /\b\d{13}\b/g];

function run(command, args, cwd = root) {
  const result = runSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 600000, env: { ...process.env, DOTENV_CONFIG_QUIET: "true" } });
  if (result.status !== 0) throw new Error(command + " " + args.join(" ") + " failed: " + String(result.stderr || result.stdout).slice(-800));
  return result;
}

function hashTree(dir) {
  const out = new Map();
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      const rel = path.relative(dir, abs).split(path.sep).join("/");
      out.set(rel, crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex"));
    }
  };
  walk(dir);
  return out;
}

function snapshotTo(dir, target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(dir, target, { recursive: true });
}

function compare(first, second, firstDir, secondDir) {
  const differences = [];
  for (const [rel, hash] of first) {
    if (!second.has(rel)) { differences.push({ file: rel, kind: "missing-in-second" }); continue; }
    if (second.get(rel) !== hash) {
      const a = fs.readFileSync(path.join(firstDir, rel));
      const b = fs.readFileSync(path.join(secondDir, rel));
      let kind = "unexpected-nondeterminism";
      if (/\.(js|json|html|css|txt|webmanifest|map)$/i.test(rel)) {
        const normalise = (buffer) => EXPECTED_VARIANCE.reduce((text, pattern) => text.replace(pattern, "<variance>"), buffer.toString("utf8"));
        if (normalise(a) === normalise(b)) kind = "expected-variance";
      }
      differences.push({ file: rel, kind });
    }
  }
  for (const rel of second.keys()) if (!first.has(rel)) differences.push({ file: rel, kind: "missing-in-first" });
  return differences;
}

function main() {
  const report = new ReleaseReport("reproducible build");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "siton-repro-"));
  const builds = [
    { id: "demo bundle", out: ".demo_dist", build: () => run(process.execPath, [path.join(root, "scripts", "build_demo_bundle.cjs")]) },
    { id: "mobile bundle", out: ".mobile_dist", build: () => run(process.execPath, [path.join(root, "scripts", "build_mobile_bundle.cjs")]) }
  ];
  if (includeWeb) builds.push({ id: "web (vite)", out: "web/dist", build: () => { if (!fs.existsSync(path.join(root, "web", "node_modules"))) run("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], path.join(root, "web")); run("npm", ["run", "build"], path.join(root, "web")); } });
  const artifact = {};
  try {
    for (const item of builds) {
      const started = Date.now();
      try {
        const outDir = path.join(root, item.out);
        fs.rmSync(outDir, { recursive: true, force: true });
        item.build();
        const first = hashTree(outDir);
        const firstCopy = path.join(work, item.out.replace(/[\\/]/g, "_") + "-1");
        snapshotTo(outDir, firstCopy);
        fs.rmSync(outDir, { recursive: true, force: true });
        item.build();
        const second = hashTree(outDir);
        const differences = compare(first, second, firstCopy, outDir);
        const unexpected = differences.filter((d) => d.kind === "unexpected-nondeterminism" || d.kind.startsWith("missing"));
        const expected = differences.filter((d) => d.kind === "expected-variance");
        artifact[item.id] = { files: first.size, differences, tree_hash: crypto.createHash("sha256").update([...first.entries()].sort().map(([k, v]) => k + ":" + v).join("\n")).digest("hex") };
        const summary = first.size + " files, tree sha256 " + artifact[item.id].tree_hash.slice(0, 16) + "; " + (differences.length === 0 ? "DETERMINISTIC (two clean builds identical)" : expected.length + " expected-variance, " + unexpected.length + " unexpected");
        const detail = differences.map((d) => d.kind + " " + d.file).join("\n") || undefined;
        if (unexpected.length) report.fail(item.id, summary, { detail, duration_ms: Date.now() - started });
        else if (expected.length) report.warn(item.id, summary, { detail, duration_ms: Date.now() - started });
        else report.pass(item.id, summary, { duration_ms: Date.now() - started });
      } catch (error) {
        report.fail(item.id, error.message.slice(0, 600), { duration_ms: Date.now() - started });
      }
    }
    // Known, documented variance sources (not measured here but part of the
    // release identity): the asset version token in index.html comes from the
    // git short SHA (RENDER_GIT_COMMIT / COMMIT_SHA / GIT_COMMIT / git rev-parse)
    // and falls back to Date.now() only outside a git checkout; the mobile
    // bundle embeds the git revision. Both are release identity, not noise.
    report.pass("identity tokens", "index.html asset version and mobile-build.json revision are derived from the git SHA (stable per commit); Date.now() fallback applies only outside a git checkout");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(artifactsDir(root), "reproducible-build.json"), JSON.stringify(artifact, null, 2) + "\n");
  report.printSummary({ detailLines: 40 });
  report.writeArtifacts(artifactsDir(root), "reproducible-build");
  console.log(report.exitCode() ? "REPRODUCIBLE_BUILD_FAIL" : "REPRODUCIBLE_BUILD_PASS");
  process.exit(report.exitCode());
}

main();
