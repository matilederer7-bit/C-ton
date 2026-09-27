#!/usr/bin/env node
// Git HISTORY secret scan (npm run scan:secrets-history).
//
// scripts/secret_pii_scan.cjs only sees the working tree: a credential that
// was committed and later deleted stays in every clone's history. This scan
// walks the ADDED lines of every commit reachable from the repository (all
// branches and tags) with the FAIL-severity secret detectors of the
// working-tree scanner and reports commit / file / line for each hit.
//
// Scope: added lines only ("+" side of each diff; a removal is the fix, not
// the leak), scanned per commit+file as ONE block so context-dependent
// detectors (the Twilio token detector needs the account SID in the same
// text) see adjacent lines together. Allow-list: the same config/secret-scan-allowlist.json entries,
// matched by detector + exact match / prefix (the file is not required to
// match, because history paths move). Controls:
// tests/release_tools/git_history_secret_scan.test.cjs.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DETECTORS } = require("./secret_pii_scan.cjs");

const HISTORY_DETECTOR_IDS = new Set([
  "private-key",
  "aws-access-key",
  "github-token",
  "slack-token",
  "google-api-key",
  "stripe-secret-key",
  "stripe-webhook-secret",
  "supabase-secret-key",
  "render-api-key",
  "twilio-auth-token",
  "supabase-service-role-jwt",
  "database-url-credential",
  "grow-credential"
]);

function loadAllowList(root) {
  const file = path.join(root, "config", "secret-scan-allowlist.json");
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, "utf8")).allow || []; } catch { return []; }
}

function allowed(allowList, detectorId, match) {
  return allowList.some((entry) => entry.detector === detectorId && (entry.match ? entry.match === match : match.startsWith(entry.match_prefix)));
}

// Parse `git log -p` output into { commit, file, addedLines: [{ line, text }] }.
function* addedLinesFromLog(logText) {
  let commit = "";
  let file = "";
  let newLine = 0;
  for (const raw of logText.split("\n")) {
    if (raw.startsWith("commit ")) { commit = raw.slice(7, 47); continue; }
    if (raw.startsWith("+++ b/")) { file = raw.slice(6); continue; }
    if (raw.startsWith("+++ ")) { file = ""; continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { newLine = Number(hunk[1]); continue; }
    if (!file) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      yield { commit, file, line: newLine, text: raw.slice(1) };
      newLine += 1;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      // removed line: new-file line counter does not advance
    } else if (raw.startsWith(" ") || raw === "") {
      newLine += 1;
    }
  }
}

function run(options = {}) {
  const root = options.root || process.cwd();
  const allowList = options.allowList || loadAllowList(root);
  const detectors = DETECTORS.filter((d) => HISTORY_DETECTOR_IDS.has(d.id));
  const args = ["log", "-p", "--all", "--no-color", "--no-renames", "--diff-filter=ACMR", "--format=commit %H", "--", "."];
  const log = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  if (log.status !== 0) throw new Error("git log failed: " + String(log.stderr || "").slice(0, 400));
  const findings = [];
  const seen = new Set();
  let commits = 0;
  const commitSet = new Set();
  const excluded = (file) => /^tests\/release_tools\//.test(file) || file === "scripts/secret_pii_scan.cjs" || file === "scripts/git_history_secret_scan.cjs" || file === "config/secret-scan-allowlist.json";
  // Group the added lines of each (commit, file) into one text block so
  // detectors that need context across adjacent lines still fire.
  const blocks = new Map();
  for (const added of addedLinesFromLog(log.stdout)) {
    if (!commitSet.has(added.commit)) { commitSet.add(added.commit); commits += 1; }
    // Same exclusions as the working-tree scanner: the scanner's own source,
    // its allow-list and its control tests (which carry synthetic detector
    // fixtures by design).
    if (excluded(added.file)) continue;
    if (added.text.length > 20000) continue;
    const key = `${added.commit}\u0000${added.file}`;
    let block = blocks.get(key);
    if (!block) { block = { commit: added.commit, file: added.file, lines: [], numbers: [] }; blocks.set(key, block); }
    block.lines.push(added.text);
    block.numbers.push(added.line);
  }
  for (const block of blocks.values()) {
    const text = block.lines.join("\n");
    const lineAt = (index) => { let n = 0; for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1; return block.numbers[n] ?? block.numbers[block.numbers.length - 1] ?? 0; };
    for (const detector of detectors) {
      if (detector.scope === "non-test" && block.file.startsWith("tests/")) continue;
      let hits;
      try { hits = detector.run(text); } catch { hits = []; }
      for (const hit of hits) {
        if (allowed(allowList, detector.id, hit.match)) continue;
        const key = `${detector.id}|${hit.match}`;
        // Report each distinct secret once, at its FIRST appearance.
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ commit: block.commit, file: block.file, line: lineAt(hit.index), detector: detector.id, match: hit.match.slice(0, 80), note: hit.note || null });
      }
    }
  }
  return { commits, findings };
}

if (require.main === module) {
  const result = run();
  for (const finding of result.findings) {
    console.log(`[FAIL] ${finding.commit.slice(0, 12)} ${finding.file}:${finding.line} ${finding.detector} ${finding.match}${finding.note ? " (" + finding.note + ")" : ""}`);
  }
  console.log(`GIT_HISTORY_SECRET_SCAN_SUMMARY commits=${result.commits} fail=${result.findings.length}`);
  console.log(result.findings.length ? "GIT_HISTORY_SECRET_SCAN_FAIL" : "GIT_HISTORY_SECRET_SCAN_PASS");
  process.exit(result.findings.length ? 1 : 0);
}

module.exports = { run, addedLinesFromLog, HISTORY_DETECTOR_IDS };
