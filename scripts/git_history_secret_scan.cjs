#!/usr/bin/env node
// Git HISTORY secret scan (npm run scan:secrets-history).
//
// scripts/secret_pii_scan.cjs only sees the working tree: a credential that
// was committed and later deleted stays in every clone's history. This scan
// visits every commit reachable from the repository (all branches and tags,
// oldest first) and, for every file a commit added or modified, scans the
// FULL FILE SNAPSHOT as committed with the FAIL-severity secret detectors of
// the working-tree scanner, reporting commit / file / line for each hit.
//
// Why snapshots and not diff lines: context-dependent detectors (the Twilio
// token detector only fires when the account SID is in the same text) must
// see the file as it existed at that commit. Scanning only the lines a commit
// added misses a credential assembled over several commits (SID committed
// first, token in the next commit, both deleted later) — Codex on PR #97.
// The snapshot of a file at a commit is exactly what a clone of that commit
// would expose, so it is the right unit.
//
// Allow-list: the same config/secret-scan-allowlist.json entries, matched by
// detector + exact match / prefix (the file is not required to match, because
// history paths move). Controls: tests/release_tools/git_history_secret_scan.test.cjs.
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
  "grow-credential",
  "real-card-pan"
]);

// Snapshots above this size are not scanned (lockfiles, bundles, binaries);
// the working-tree scanner has the same class of cap.
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const CAT_FILE_BATCH = 400;

function loadAllowList(root) {
  const file = path.join(root, "config", "secret-scan-allowlist.json");
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, "utf8")).allow || []; } catch { return []; }
}

function allowed(allowList, detectorId, match) {
  return allowList.some((entry) => entry.detector === detectorId && (entry.match ? entry.match === match : match.startsWith(entry.match_prefix)));
}

// Same exclusions as the working-tree scanner: the scanner's own source, its
// allow-list and its control tests (which carry synthetic detector fixtures
// by design).
function excludedPath(file) {
  return /^tests\/release_tools\//.test(file)
    || file === "scripts/secret_pii_scan.cjs"
    || file === "scripts/git_history_secret_scan.cjs"
    || file === "config/secret-scan-allowlist.json";
}

// Parse `git log --format=commit %H --name-only` output into
// { commit, file } pairs, in the order git printed them.
function* touchedFilesFromLog(logText) {
  let commit = "";
  for (const raw of logText.split("\n")) {
    if (raw.startsWith("commit ")) { commit = raw.slice(7, 47); continue; }
    const file = raw.trim();
    if (!commit || !file) continue;
    yield { commit, file };
  }
}

// Fetch the committed content of each (commit, file) through ONE
// `git cat-file --batch` process per chunk. Yields { commit, file, text } for
// text snapshots within the size cap; binary and oversized blobs are skipped.
function* snapshots(root, pairs) {
  for (let start = 0; start < pairs.length; start += CAT_FILE_BATCH) {
    const chunk = pairs.slice(start, start + CAT_FILE_BATCH);
    const input = chunk.map((p) => `${p.commit}:${p.file}`).join("\n") + "\n";
    const out = spawnSync("git", ["cat-file", "--batch"], { cwd: root, input, maxBuffer: 1024 * 1024 * 1024 });
    if (out.status !== 0) throw new Error("git cat-file failed: " + String(out.stderr || "").slice(0, 400));
    const buf = out.stdout;
    let offset = 0;
    for (const pair of chunk) {
      const eol = buf.indexOf(0x0a, offset);
      if (eol < 0) throw new Error("git cat-file: truncated output");
      const header = buf.toString("utf8", offset, eol);
      offset = eol + 1;
      if (header.endsWith(" missing") || header.endsWith(" ambiguous")) continue;
      const parts = header.split(" ");
      const size = Number(parts[2]);
      const body = buf.subarray(offset, offset + size);
      offset += size + 1; // trailing LF after the object body
      if (parts[1] !== "blob" || size > MAX_SNAPSHOT_BYTES) continue;
      if (body.subarray(0, 8000).includes(0)) continue; // binary
      yield { commit: pair.commit, file: pair.file, text: body.toString("utf8") };
    }
  }
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function run(options = {}) {
  const root = options.root || process.cwd();
  const allowList = options.allowList || loadAllowList(root);
  const detectors = DETECTORS.filter((d) => HISTORY_DETECTOR_IDS.has(d.id));
  // Oldest first so a secret is reported at its FIRST appearance; ACMR = the
  // commits that put content INTO a path (a deletion is the fix, not the leak).
  const args = ["log", "--all", "--reverse", "--no-renames", "--diff-filter=ACMR", "--format=commit %H", "--name-only", "--", "."];
  const log = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  if (log.status !== 0) throw new Error("git log failed: " + String(log.stderr || "").slice(0, 400));
  const commitSet = new Set();
  const pairs = [];
  for (const touched of touchedFilesFromLog(log.stdout)) {
    commitSet.add(touched.commit);
    if (excludedPath(touched.file)) continue;
    pairs.push(touched);
  }
  const findings = [];
  const seen = new Set();
  const scannedBlobs = new Set();
  for (const snapshot of snapshots(root, pairs)) {
    for (const detector of detectors) {
      if (detector.scope === "non-test" && snapshot.file.startsWith("tests/")) continue;
      let hits;
      try { hits = detector.run(snapshot.text); } catch { hits = []; }
      for (const hit of hits) {
        if (allowed(allowList, detector.id, hit.match)) continue;
        const key = `${detector.id}|${hit.match}`;
        // Report each distinct secret once, at its first appearance.
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ commit: snapshot.commit, file: snapshot.file, line: lineOf(snapshot.text, hit.index), detector: detector.id, match: hit.match.slice(0, 80), note: hit.note || null });
      }
    }
    scannedBlobs.add(`${snapshot.commit}:${snapshot.file}`);
  }
  return { commits: commitSet.size, snapshots: scannedBlobs.size, findings };
}

if (require.main === module) {
  const result = run();
  for (const finding of result.findings) {
    console.log(`[FAIL] ${finding.commit.slice(0, 12)} ${finding.file}:${finding.line} ${finding.detector} ${finding.match}${finding.note ? " (" + finding.note + ")" : ""}`);
  }
  console.log(`GIT_HISTORY_SECRET_SCAN_SUMMARY commits=${result.commits} snapshots=${result.snapshots} fail=${result.findings.length}`);
  console.log(result.findings.length ? "GIT_HISTORY_SECRET_SCAN_FAIL" : "GIT_HISTORY_SECRET_SCAN_PASS");
  process.exit(result.findings.length ? 1 : 0);
}

module.exports = { run, touchedFilesFromLog, HISTORY_DETECTOR_IDS };
