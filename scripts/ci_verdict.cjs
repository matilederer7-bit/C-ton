#!/usr/bin/env node
// Siton CI verdict: the one check branch protection needs.
//
// Green only when, for the profile the classifier computed:
//   1. the classification job succeeded and no proposed profile tried to go
//      below the computed one;
//   2. every job the profile requires ended in success, and every skipped job
//      is one the classifier declared skipped (with its reason) or a Docker
//      job skipped on a fork pull request;
//   3. the test manifests prove coverage: with the test lanes, every file of
//      the current inventory ran exactly once and passed (no file lost by
//      sharding or lane packing); with the FAST profile, exactly the focused
//      files ran and passed.
//
// Usage: node scripts/ci_verdict.cjs --needs-env NEEDS_JSON --artifacts <dir>
//        [--same-repo true|false] [--summary <file>]

const fs = require("node:fs");
const path = require("node:path");
const { GROUPS, testInventory } = require("./run_test_group.cjs");

// job id -> classification lane key (null: always required)
const JOBS = {
  "static-gates": { lane: null },
  tests: { lane: "groups" },
  "focused-tests": { lane: "focused_job" },
  "web-runtime-core": { lane: "web_runtime_core" },
  "web-runtime-resilience": { lane: "web_runtime_resilience", sameRepoOnly: true },
  "docker-smoke": { lane: "docker_smoke", sameRepoOnly: true },
  "docker-release-lab": { lane: "docker_release_lab", sameRepoOnly: true },
  "preflight-database": { lane: "preflight_database" }
};

function laneEnabled(lanes, key) {
  if (key === null) return true;
  const value = lanes[key];
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.length > 0;
  return value === true;
}

function evaluate({ classification, needs, manifests, inventory, sameRepo = true }) {
  const failures = [];
  const rows = [];
  const classifyResult = needs?.classify?.result;
  if (classifyResult !== "success" || !classification) {
    failures.push(`classify job ${classifyResult || "missing"}: no trustworthy classification`);
    return { ok: false, failures, rows, coverage: null };
  }
  if (!classification.claim || classification.claim.accepted !== true) {
    failures.push(`profile proposal rejected: ${classification.claim?.error || "unknown"}`);
  }

  const lanes = classification.lanes || {};
  for (const [job, spec] of Object.entries(JOBS)) {
    const result = needs?.[job]?.result || "missing";
    const enabled = laneEnabled(lanes, spec.lane);
    const forkSkip = enabled && spec.sameRepoOnly && !sameRepo;
    const required = enabled && !forkSkip;
    let status;
    let why = "";
    if (required) {
      status = result === "success" ? "PASS" : "FAIL";
      if (status === "FAIL") failures.push(`${job}: required by ${classification.profile}, ended ${result}`);
    } else if (result === "skipped") {
      status = "SKIPPED";
      why = forkSkip ? "fork pull request: Docker/compose jobs run only for same-repository branches" : lanes.skipped?.[spec.lane] || "not required by the profile";
    } else if (result === "success") {
      status = "PASS";
    } else {
      status = "FAIL";
      failures.push(`${job}: not required but ended ${result}`);
    }
    rows.push({ job, required, result, status, why });
  }

  const coverage = { groups: {}, focused: null };
  const groupManifests = manifests.filter((item) => item.group !== "focused");
  if (laneEnabled(lanes, "groups")) {
    const expected = new Map();
    for (const item of inventory) {
      if (!expected.has(item.group)) expected.set(item.group, new Set());
      expected.get(item.group).add(item.name);
    }
    const seen = new Map();
    for (const manifest of groupManifests) {
      for (const result of manifest.results || []) {
        const key = result.file;
        if (seen.has(key)) failures.push(`coverage: ${key} ran twice (${seen.get(key)} and ${manifest.group} ${manifest.shard || ""})`);
        seen.set(key, `${manifest.group} ${manifest.shard || ""}`.trim());
        if (result.status !== "pass") failures.push(`coverage: ${key} did not pass (${result.status})`);
      }
    }
    for (const group of GROUPS) {
      const want = expected.get(group) || new Set();
      const ran = [...seen.keys()].filter((name) => want.has(name));
      const missing = [...want].filter((name) => !seen.has(name));
      coverage.groups[group] = { expected: want.size, ran: ran.length, missing };
      if (missing.length) failures.push(`coverage: group ${group} is missing ${missing.length} file(s): ${missing.slice(0, 10).join(", ")}`);
    }
    const unknown = [...seen.keys()].filter((name) => !inventory.some((item) => item.name === name));
    if (unknown.length) failures.push(`coverage: manifests name files outside the inventory: ${unknown.join(", ")}`);
    coverage.total = { expected: inventory.length, ran: seen.size };
  }
  if (laneEnabled(lanes, "focused")) {
    const focusedManifest = manifests.find((item) => item.group === "focused");
    const want = new Set(classification.focused_tests || []);
    if (!focusedManifest) failures.push("coverage: focused-tests manifest missing");
    else {
      const ran = new Map((focusedManifest.results || []).map((item) => [item.file, item.status]));
      const missing = [...want].filter((name) => !ran.has(name));
      const extra = [...ran.keys()].filter((name) => !want.has(name));
      const failed = [...ran.entries()].filter(([, status]) => status !== "pass").map(([name]) => name);
      if (missing.length) failures.push(`coverage: focused tests did not run: ${missing.join(", ")}`);
      if (extra.length) failures.push(`coverage: focused run included unexpected files: ${extra.join(", ")}`);
      if (failed.length) failures.push(`coverage: focused tests failed: ${failed.join(", ")}`);
      coverage.focused = { expected: want.size, ran: ran.size };
    }
  }
  return { ok: failures.length === 0, failures, rows, coverage };
}

function findFiles(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findFiles(full, predicate, out);
    else if (predicate(full)) out.push(full);
  }
  return out;
}

function summary(result, classification) {
  const lines = [];
  lines.push(`## CI verdict: ${result.ok ? "PASS" : "FAIL"} — profile ${classification?.profile || "unknown"}`);
  lines.push("");
  lines.push("| job | required | result | note |");
  lines.push("|---|---|---|---|");
  for (const row of result.rows) lines.push(`| ${row.job} | ${row.required ? "yes" : "no"} | ${row.status} (${row.result}) | ${row.why.replace(/\|/g, "/")} |`);
  if (result.coverage) {
    lines.push("");
    if (result.coverage.total) lines.push(`Test files: ${result.coverage.total.ran} ran / ${result.coverage.total.expected} in the inventory`);
    for (const [group, value] of Object.entries(result.coverage.groups || {})) lines.push(`- ${group}: ${value.ran}/${value.expected}${value.missing.length ? ` missing ${value.missing.join(", ")}` : ""}`);
    if (result.coverage.focused) lines.push(`Focused tests: ${result.coverage.focused.ran}/${result.coverage.focused.expected}`);
  }
  if (result.failures.length) { lines.push(""); lines.push("### Failures"); for (const failure of result.failures) lines.push(`- ${failure}`); }
  return lines.join("\n") + "\n";
}

function main(argv) {
  const args = { needsEnv: "NEEDS_JSON", artifacts: ".ci-verdict", sameRepo: "true", summary: null };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--needs-env") args.needsEnv = argv[++index];
    else if (item === "--artifacts") args.artifacts = argv[++index];
    else if (item === "--same-repo") args.sameRepo = argv[++index];
    else if (item === "--summary") args.summary = argv[++index];
    else throw new Error(`unknown argument ${item}`);
  }
  const needs = JSON.parse(process.env[args.needsEnv] || "{}");
  const classificationFile = findFiles(args.artifacts, (file) => path.basename(file) === "classification.json")[0];
  const classification = classificationFile ? JSON.parse(fs.readFileSync(classificationFile, "utf8")) : null;
  const manifests = findFiles(args.artifacts, (file) => /[\\/]manifests[\\/][^\\/]+\.json$/.test(file)).map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
  const result = evaluate({ classification, needs, manifests, inventory: testInventory(), sameRepo: String(args.sameRepo) === "true" });
  const text = summary(result, classification);
  if (args.summary) fs.appendFileSync(args.summary, text);
  console.log(text);
  console.log(`CI_VERDICT ${result.ok ? "PASS" : "FAIL"} profile=${classification?.profile || "unknown"} failures=${result.failures.length}`);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  try { process.exit(main(process.argv.slice(2))); } catch (error) { console.error(`CI_VERDICT_ERROR ${error.stack || error.message}`); process.exit(1); }
}

module.exports = { JOBS, evaluate };
