#!/usr/bin/env node
// Siton CI change classifier.
//
// Decides, from the real diff (paths, change kind and changed lines), which
// CI profile a pull request needs:
//
//   FAST      trivial / low   docs, copy dictionaries, visual-only assets
//   STANDARD  normal          ordinary frontend/backend functional change
//   FULL      high / critical DB, migrations, money, auth/security, state
//                             machine, concurrency, destructive operations,
//                             CI/test infrastructure, dependencies, cross-
//                             cutting changes, and anything unclassified
//
// The rules are an allowlist: a path is FAST or STANDARD only when a rule
// says so; everything else is FULL. A proposed profile (PR label `ci:fast`,
// `ci:standard`, `ci:full`, or a `CI-Profile: FAST` line in the PR body) can
// only escalate; a proposal below the computed profile is rejected and turns
// the CI verdict red. Pushes to master, schedules and manual runs are FULL.
//
// Usage:
//   node scripts/ci_change_classifier.cjs --base <sha> --head <sha>
//        [--event pull_request] [--claim FAST] [--github-output <file>]
//        [--summary <file>] [--json <file>]
//
// The decision logic is pure (classifyChanges) and unit-tested in
// tests/release_tools/ci_change_classifier.test.cjs, including negative cases
// proving a risky change cannot pass as a small one.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { riskFamilies } = require("./team_plan_check.cjs");
const { GROUPS, classify: testGroupOf } = require("./run_test_group.cjs");

const LEVELS = ["trivial", "low", "normal", "high", "critical"];
const PROFILES = ["FAST", "STANDARD", "FULL"];
const PROFILE_OF_LEVEL = { trivial: "FAST", low: "FAST", normal: "STANDARD", high: "FULL", critical: "FULL" };

// Test groups whose files guard money, database, security, concurrency and
// failure behaviour. Editing or deleting one of their tests is never small.
const CRITICAL_TEST_GROUPS = new Set(["payments", "security", "db", "concurrency", "failure"]);

// FAST limits: a larger change is not "small" whatever its paths say.
const FAST_MAX_FILES = 25;
const FAST_MAX_CODE_LINES = 300; // changed lines outside docs
// More top-level backend/web areas than this in one diff is cross-cutting.
const CROSS_CUTTING_SRC_FILES = 25;

// Changed-line vocabulary that makes any code file critical: destructive SQL,
// transactions and locking, money, and credentials/sessions.
const CRITICAL_CONTENT = [
  { id: "destructive-sql", pattern: /\b(DROP\s+(TABLE|DATABASE|SCHEMA|COLUMN|INDEX|CONSTRAINT)|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE)\b/i },
  { id: "transaction-locking", pattern: /\b(FOR\s+UPDATE|SKIP\s+LOCKED|NOWAIT|pg_advisory\w*|SERIALIZABLE|REPEATABLE\s+READ|withTransaction|BEGIN\b|COMMIT\b|ROLLBACK\b|SAVEPOINT)/ },
  { id: "money", pattern: /(refund|payout|charge|capture|settle|agorot|platform_?fee|commission|vat\b|invoice|ledger|price_?cents|amount)/i },
  { id: "credentials", pattern: /(password|secret|api_?key|bearer|jwt|otp|mfa|csrf|cookie|signature|hmac|bcrypt|scrypt|createHash|timingSafeEqual|service_?role)/i },
  { id: "destructive-fs", pattern: /(rmSync|rimraf|rm\s+-rf|unlinkSync|dropDatabase|DROP DATABASE)/ }
];

const CODE_EXTENSIONS = /\.(c?js|mjs|tsx?|sql|sh|ya?ml|json)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|ico|svg)$/i;

// Ordered path rules. The first matching rule gives the file's level.
// Anything that no rule matches is critical ("unclassified").
const PATH_RULES = [
  // --- critical: CI, test infrastructure, dependencies, runtime/infra ---
  { level: "critical", id: "ci-infrastructure", test: (p) => /^\.github\//.test(p) },
  { level: "critical", id: "classifier-or-test-runner", test: (p) => /^scripts\/(ci_change_classifier|ci_verdict|run_test_group|release_preflight|team_plan_check)\.cjs$/.test(p) || p === "config/release-preflight-gates.json" || /^tests\/release_tools\/ci_(change_classifier|verdict)/.test(p) },
  { level: "critical", id: "dependencies", test: (p) => /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|\.npmrc)$/.test(p) },
  { level: "critical", id: "runtime-infrastructure", test: (p) => /^(Dockerfile|\.dockerignore|docker-compose[^/]*\.ya?ml|render\.yaml|capacitor\.config\.ts|tsconfig[^/]*\.json|\.env[^/]*|\.gitattributes|\.gitignore)$/.test(p) },
  { level: "critical", id: "database", test: (p) => /^(src\/migrations\/|supabase\/)|\.sql$/i.test(p) || /^(scripts|tests\/release_tools)\/[^/]*(migrat|schema|db_|_db|database|backup|restore)[^/]*$/i.test(p) },
  { level: "critical", id: "money-or-security-tooling", test: (p) => /^(scripts|tests\/release_tools)\/[^/]*(money|payment|refund|payout|secret|real_money|route_auth|protected_route|security|compliance|legal|tax|destructive|runtime_env|startup)[^/]*$/i.test(p) },
  { level: "critical", id: "policy-config", test: (p) => /^config\//.test(p) },
  { level: "critical", id: "legacy-excluded-surfaces", test: (p) => /^(base44|legacy)\//.test(p) },
  { level: "critical", id: "high-risk-family", test: (p) => riskFamilies([p]).length > 0 },

  // --- normal: copy sources of the bilingual dictionaries (before the
  // scripts/ rule below; copyOnly() may lower them to low) ---
  { level: "normal", id: "i18n-dictionary", test: (p) => /^scripts\/i18n\/[^/]+\.json$/.test(p) },

  // --- high: shared test infrastructure and gates/tooling ---
  { level: "high", id: "shared-test-infrastructure", test: (p) => /^tests\/(helpers|support|fixtures|blackbox)\//.test(p) },
  { level: "high", id: "gate-or-tooling-script", test: (p) => /^scripts\//.test(p) },
  { level: "high", id: "external-tests", test: (p) => /^external-tests\//.test(p) },

  // --- normal: product code and tests (with content escalation below) ---
  { level: "normal", id: "tests", test: (p) => /^tests\/[^/]+\.ts$/.test(p) },
  { level: "normal", id: "release-tool-tests", test: (p) => /^tests\/release_tools\//.test(p) },
  { level: "normal", id: "backend", test: (p) => /^src\/.+\.(ts|js|json)$/.test(p) },
  { level: "normal", id: "web-app", test: (p) => /^web\/(src\/.+\.(tsx?|css)|index\.html|vite\.config\.ts|public\/.+)$/.test(p) },
  { level: "normal", id: "legacy-frontend", test: (p) => /^frontend\//.test(p) },
  { level: "normal", id: "mobile", test: (p) => /^(mobile|mobile-plugins|android|ios)\//.test(p) },
  { level: "normal", id: "i18n-regen", test: (p) => /^\.i18n-regen\//.test(p) },
  { level: "normal", id: "assets", test: (p) => /^assets\//.test(p) },

  // --- trivial: prose that no runtime reads ---
  { level: "trivial", id: "docs", test: (p) => /\.(md|txt)$/i.test(p) && (/^docs\//.test(p) || !p.includes("/")) },
  { level: "trivial", id: "docs-documents", test: (p) => /^docs\/.+\.(docx|pdf|png|jpe?g|svg|json)$/i.test(p) }
];

// Low-risk refinements of a "normal" web/asset path: pure styling, images and
// copy dictionaries whose changed lines are only string entries.
function lowRiskRefinement(file) {
  const p = file.path;
  if (/^web\/src\/.+\.css$/.test(p)) return "visual-stylesheet";
  if (IMAGE.test(p) && /^(web\/public|assets|frontend\/icons)\//.test(p)) return "visual-image";
  if (/^(scripts\/i18n\/[^/]+\.json|web\/src\/i18n\/dictionaries\/[^/]+\.ts)$/.test(p) && file.status === "M" && copyOnly(file)) return "copy-dictionary";
  return null;
}

// Every changed line of a dictionary is `"key": "text",` (JSON or TS object
// literal). Structural edits (imports, code, brackets) are not copy.
function copyOnly(file) {
  const lines = [...(file.added || []), ...(file.removed || [])].filter((line) => line.trim() !== "");
  if (!lines.length) return false;
  const entry = /^\s*("(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$]*)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`$]*`)\s*,?\s*$/;
  return lines.every((line) => entry.test(line));
}

function rank(list, value) {
  const index = list.indexOf(value);
  if (index < 0) throw new Error(`unknown value ${value}`);
  return index;
}

function maxLevel(a, b) {
  return rank(LEVELS, a) >= rank(LEVELS, b) ? a : b;
}

function normalizeClaim(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim().toUpperCase();
  if (!text) return null;
  return PROFILES.includes(text) ? text : `INVALID:${text}`;
}

// Parse a profile proposal from PR labels (ci:fast / ci:standard / ci:full)
// and a `CI-Profile: <name>` line in the PR body. Several proposals: the
// highest wins (a proposal can only escalate).
function claimFromPullRequest({ labels = [], body = "" } = {}) {
  const found = [];
  for (const label of labels) {
    const match = /^ci:(fast|standard|full)$/i.exec(String(label).trim());
    if (match) found.push(match[1].toUpperCase());
  }
  const bodyMatch = /^\s*CI-Profile:\s*([A-Za-z]+)\s*$/im.exec(String(body || ""));
  if (bodyMatch) found.push(normalizeClaim(bodyMatch[1]));
  if (!found.length) return null;
  const invalid = found.find((item) => item.startsWith("INVALID:"));
  if (invalid) return invalid;
  return found.sort((a, b) => rank(PROFILES, b) - rank(PROFILES, a))[0];
}

// Tests that name a changed path, and tests that assert a string a copy change
// removes: the focused set a FAST run executes.
function focusedTests(files, testSources) {
  const selected = new Set();
  const reasons = {};
  const add = (name, why) => { selected.add(name); (reasons[name] ||= []).push(why); };
  for (const file of files) {
    const base = path.basename(file.path);
    const stem = base.replace(/\.[^.]+$/, "");
    const needles = [file.path];
    // A distinctive basename (not index.ts / README.md) is also a reference.
    if (stem.length >= 6 && !/^(index|readme|styles?|main|app|config|types?)$/i.test(stem)) needles.push(base);
    for (const [name, source] of testSources) {
      if (needles.some((needle) => source.includes(needle))) add(name, `references ${file.path}`);
    }
    // Copy sources only: prose documents quote identifiers that many tests
    // also mention, which would turn every docs edit into a broad run.
    if (!COPY_SOURCE.test(file.path)) continue;
    for (const literal of removedLiterals(file)) {
      for (const [name, source] of testSources) if (source.includes(literal)) add(name, `asserts copy removed from ${file.path}`);
    }
  }
  return { files: [...selected].sort(), reasons };
}

const COPY_SOURCE = /^(scripts\/i18n\/[^/]+\.json|web\/src\/i18n\/dictionaries\/[^/]+\.ts)$/;

function removedLiterals(file) {
  const out = new Set();
  for (const line of file.removed || []) {
    for (const match of line.matchAll(/"((?:[^"\\]|\\.){4,})"|'((?:[^'\\]|\\.){4,})'/g)) {
      const value = (match[1] || match[2] || "").trim();
      if (value.length >= 4 && !/^[\w.-]+$/.test(value)) out.add(value); // keys are identifiers; copy has spaces/punctuation/Hebrew
      else if (value.length >= 8) out.add(value);
    }
  }
  return [...out];
}

// Tests that exercise the rendered web app in a real browser. Visual and copy
// changes always run them in addition to the path-referencing tests.
function browserTests(testNames) {
  return testNames.filter((name) => /^frontend_browser_.+\.ts$/.test(name) || /^visual_brand_consistency_validation\.ts$/.test(name) || /^i18n_.+_validation\.ts$/.test(name));
}

function classifyChanges({ event = "pull_request", files = [], claim = null, testSources = new Map() } = {}) {
  const reasons = [];
  const perFile = [];
  const subsystems = new Set();
  const normalizedClaim = normalizeClaim(claim);
  const forcedFull = event !== "pull_request";

  if (forcedFull) reasons.push(`event ${event}: master, scheduled and manual runs are always FULL`);
  if (!forcedFull && !files.length) reasons.push("empty or unreadable diff: cannot prove the change is small");

  let level = files.length || forcedFull ? "trivial" : "critical";
  let codeLines = 0;
  let srcFiles = 0;

  for (const file of files) {
    const p = String(file.path || "").replace(/\\/g, "/");
    const record = { path: p, status: file.status, level: "critical", rule: "unclassified" };
    const rule = PATH_RULES.find((candidate) => candidate.test(p));
    if (rule) { record.level = rule.level; record.rule = rule.id; }
    const oldPath = file.oldPath ? String(file.oldPath).replace(/\\/g, "/") : null;
    if (oldPath && oldPath !== p) {
      // A rename is as risky as the riskier of its two ends.
      const oldRule = PATH_RULES.find((candidate) => candidate.test(oldPath));
      const oldLevel = oldRule ? oldRule.level : "critical";
      if (rank(LEVELS, oldLevel) > rank(LEVELS, record.level)) { record.level = oldLevel; record.rule = `renamed-from:${oldRule ? oldRule.id : "unclassified"}`; }
    }

    const isTest = /^tests\/[^/]+\.ts$/.test(p) || (oldPath && /^tests\/[^/]+\.ts$/.test(oldPath));
    if (isTest) {
      const testName = path.basename(file.status === "D" || !p.startsWith("tests/") ? oldPath || p : p);
      const group = testGroupOf(testName.replace(/\.ts$/, ""));
      record.test_group = group;
      if (file.status === "D" || (file.status === "R" && oldPath && !/^tests\/[^/]+\.ts$/.test(p))) {
        record.level = "critical"; record.rule = "test-removed";
      } else if (file.status === "R") {
        record.level = "critical"; record.rule = "test-renamed";
      } else if (CRITICAL_TEST_GROUPS.has(group)) {
        record.level = "critical"; record.rule = `critical-test-group:${group}`;
      }
    }

    if (record.level === "normal") {
      const refinement = lowRiskRefinement({ ...file, path: p });
      if (refinement) { record.level = "low"; record.rule = refinement; }
    }

    // Content escalation for code (tests are judged by their group above).
    if (CODE_EXTENSIONS.test(p) && !isTest && record.level !== "critical" && record.rule !== "copy-dictionary") {
      const changed = [...(file.added || []), ...(file.removed || [])];
      for (const { id, pattern } of CRITICAL_CONTENT) {
        const hit = changed.find((line) => pattern.test(line));
        if (hit) { record.level = "critical"; record.rule = `content:${id}`; record.evidence = hit.trim().slice(0, 160); break; }
      }
    }

    // Symlinks (120000), submodules (160000), file-type changes and new
    // executable bits can redirect what a harmless-looking path means.
    const modes = [file.oldMode, file.newMode].filter(Boolean);
    if (file.status === "T" || modes.some((mode) => /^1[26]0000$/.test(mode)) || (file.newMode === "100755" && file.oldMode !== "100755" && !/^scripts\//.test(p))) {
      record.level = "critical"; record.rule = "special-file-mode";
    }

    if (file.binary && !IMAGE.test(p) && record.level !== "critical" && !/^docs\//.test(p)) {
      record.level = "critical"; record.rule = "unknown-binary";
    }

    if (!/\.(md|txt|docx|pdf)$/i.test(p) && !/^docs\//.test(p)) codeLines += (file.added || []).length + (file.removed || []).length;
    if (/^(src|web\/src)\//.test(p)) srcFiles += 1;
    subsystems.add(subsystemOf(p, record));
    perFile.push(record);
    level = maxLevel(level, record.level);
  }

  if (!forcedFull && rank(LEVELS, level) <= rank(LEVELS, "low")) {
    if (files.length > FAST_MAX_FILES) { level = "normal"; reasons.push(`${files.length} files exceeds the FAST limit of ${FAST_MAX_FILES}`); }
    else if (codeLines > FAST_MAX_CODE_LINES) { level = "normal"; reasons.push(`${codeLines} changed non-doc lines exceeds the FAST limit of ${FAST_MAX_CODE_LINES}`); }
  }
  if (srcFiles > CROSS_CUTTING_SRC_FILES) { level = maxLevel(level, "high"); reasons.push(`${srcFiles} backend/web source files changed: cross-cutting`); }

  for (const record of perFile) {
    if (rank(LEVELS, record.level) >= rank(LEVELS, "high")) reasons.push(`${record.path}: ${record.level} (${record.rule}${record.evidence ? `: "${record.evidence}"` : ""})`);
  }

  let computed = forcedFull ? "FULL" : PROFILE_OF_LEVEL[level];
  if (forcedFull) level = maxLevel(level, "high");

  // Claim handling: escalate freely, never downgrade.
  const claimResult = { value: normalizedClaim, accepted: true, error: null };
  let profile = computed;
  if (normalizedClaim && normalizedClaim.startsWith("INVALID:")) {
    claimResult.accepted = false;
    claimResult.error = `unknown CI profile proposal "${normalizedClaim.slice(8)}"; use FAST, STANDARD or FULL`;
  } else if (normalizedClaim) {
    if (rank(PROFILES, normalizedClaim) < rank(PROFILES, computed)) {
      claimResult.accepted = false;
      claimResult.error = `proposed profile ${normalizedClaim} is below the computed profile ${computed}; a proposal can only escalate`;
    } else if (rank(PROFILES, normalizedClaim) > rank(PROFILES, computed)) {
      profile = normalizedClaim;
      reasons.push(`escalated from ${computed} to ${normalizedClaim} by the proposed profile`);
    }
  }

  const testNames = [...testSources.keys()];
  let focused = { files: [], reasons: {} };
  if (profile === "FAST") {
    focused = focusedTests(files.map((file) => ({ ...file, path: String(file.path).replace(/\\/g, "/") })), testSources);
    const needsBrowser = perFile.some((record) => /^(visual-|copy-)/.test(record.rule));
    if (needsBrowser) for (const name of browserTests(testNames)) { if (!focused.files.includes(name)) focused.files.push(name); (focused.reasons[name] ||= []).push("visual/copy change: browser and i18n suites"); }
    focused.files.sort();
  }

  return {
    event,
    level,
    computed_profile: computed,
    profile,
    claim: claimResult,
    subsystems: [...subsystems].filter(Boolean).sort(),
    reasons,
    files: perFile,
    focused_tests: focused.files,
    focused_reasons: focused.reasons,
    lanes: lanesFor(profile, perFile, focused.files)
  };
}

function subsystemOf(p, record) {
  if (/^high-risk-family$/.test(record.rule)) return riskFamilies([p]).join("+");
  if (/^content:/.test(record.rule)) return record.rule.replace("content:", "");
  if (record.rule.startsWith("critical-test-group:")) return `tests:${record.rule.split(":")[1]}`;
  return record.rule;
}

// Test lanes: the ten groups packed into parallel jobs by measured duration
// (CI step times of run 36463288440, 2026-09-28: unit 17s, integration 52s,
// db 38s, api 102s, workers 41s, payments 102s, security 180s, concurrency
// 77s, failure 52s, e2e 260s). Security and E2E are split into shards; the
// small groups share a lane. Every group appears exactly once, and every shard
// of a sharded group is present (checked by the classifier tests and, from the
// real manifests, by the CI verdict).
const TEST_LANES = [
  { lane: "unit-db-workers", groups: "unit db workers", shard: "", extras: "migrations" },
  { lane: "integration-failure", groups: "integration failure", shard: "", extras: "fault-report" },
  { lane: "api", groups: "api", shard: "", extras: "" },
  { lane: "payments", groups: "payments", shard: "", extras: "" },
  { lane: "security-1of2", groups: "security", shard: "1/2", extras: "route-authorization" },
  { lane: "security-2of2", groups: "security", shard: "2/2", extras: "" },
  { lane: "concurrency", groups: "concurrency", shard: "", extras: "" },
  { lane: "e2e-1of3", groups: "e2e", shard: "1/3", extras: "" },
  { lane: "e2e-2of3", groups: "e2e", shard: "2/3", extras: "" },
  { lane: "e2e-3of3", groups: "e2e", shard: "3/3", extras: "" }
];

function groupMatrix() {
  return TEST_LANES.map((lane) => ({ ...lane }));
}

// Paths whose change can affect the backend runtime, Docker image, database
// or process model (the inputs of the resilience/Docker/migration proofs).
function touchesBackendRuntime(records) {
  const webOnly = new Set(["web-app", "legacy-frontend", "mobile", "i18n-regen", "i18n-dictionary", "assets", "docs", "docs-documents", "tests", "visual-stylesheet", "visual-image", "copy-dictionary"]);
  return records.some((record) => !webOnly.has(record.rule));
}

function lanesFor(profile, records, focused) {
  const skipped = {};
  const lanes = {
    static: true,
    groups: [],
    focused: "",
    web_runtime_core: true,
    web_runtime_resilience: true,
    docker_smoke: true,
    docker_release_lab: true,
    preflight_database: true,
    skipped
  };
  if (profile === "FULL") {
    lanes.groups = groupMatrix();
    return lanes;
  }
  if (profile === "STANDARD") {
    lanes.groups = groupMatrix();
    if (!touchesBackendRuntime(records)) {
      for (const key of ["web_runtime_resilience", "docker_smoke", "preflight_database"]) {
        lanes[key] = false;
        skipped[key] = "STANDARD: the diff touches only the web bundle, mobile shell, assets, docs or non-critical tests; this job proves backend runtime, database and process behaviour that those files cannot change (the web bundle is still proven by all ten test groups, web-runtime-core and the Docker release lab)";
      }
    }
    return lanes;
  }
  // FAST: static gates plus the focused tests only.
  for (const key of ["web_runtime_core", "web_runtime_resilience", "docker_smoke", "docker_release_lab", "preflight_database"]) {
    lanes[key] = false;
    skipped[key] = "FAST: docs/copy/visual-only change proven by the classifier; no runtime, database or Docker input changed";
  }
  skipped.groups = "FAST: only the focused tests that reference the changed files (or assert changed copy) run";
  if (focused.length) lanes.focused = `^(${focused.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`;
  else skipped.focused = "FAST: no test references the changed files";
  return lanes;
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr || "").trim()}`);
  return result.stdout;
}

// NUL-separated plumbing output, so no path is ever quoted or mangled
// (spaces, tabs, non-ASCII names). Modes come from --raw: symlinks,
// submodules and file-type changes are recorded and treated as critical.
function readDiff(base, head, cwd) {
  const range = `${base}...${head}`;
  const files = [];
  const byPath = new Map();
  const raw = git(["-c", "core.quotePath=false", "diff", "--raw", "-z", "-M", "--no-color", "--no-abbrev", range], cwd).split("\0");
  for (let index = 0; index < raw.length; index += 1) {
    const header = raw[index];
    if (!header || !header.startsWith(":")) continue;
    const [oldMode, newMode, , , statusField] = header.slice(1).split(" ");
    const status = statusField[0];
    const record = { status, path: null, added: [], removed: [], binary: false, oldMode, newMode };
    if (status === "R" || status === "C") { record.oldPath = raw[++index]; record.path = raw[++index]; }
    else record.path = raw[++index];
    files.push(record);
    byPath.set(record.path, record);
  }
  const numstat = git(["-c", "core.quotePath=false", "diff", "--numstat", "-z", "-M", "--no-color", range], cwd).split("\0");
  for (let index = 0; index < numstat.length; index += 1) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(numstat[index]);
    if (!match) continue;
    let target = match[3];
    if (target === "") { index += 1; target = numstat[++index]; } // rename: "\0old\0new"
    const record = byPath.get(target);
    if (record && match[1] === "-") record.binary = true;
  }
  let current = null;
  for (const line of git(["-c", "core.quotePath=false", "diff", "-U0", "-M", "--no-color", "--no-ext-diff", "--no-textconv", range], cwd).split("\n")) {
    if (line.startsWith("diff --git ")) { current = null; continue; }
    if (line.startsWith("--- ")) { const name = line.slice(4).replace(/^a\//, ""); current = files.find((item) => (item.status === "D" && item.path === name)) || null; continue; }
    if (line.startsWith("+++ ")) { const name = line.slice(4); if (name !== "/dev/null") current = byPath.get(name.replace(/^b\//, "")) || null; continue; }
    if (!current) continue;
    if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
  }
  return files;
}

function readTestSources(root) {
  const dir = path.join(root, "tests");
  const map = new Map();
  if (!fs.existsSync(dir)) return map;
  for (const name of fs.readdirSync(dir).filter((item) => item.endsWith(".ts")).sort()) {
    map.set(name, fs.readFileSync(path.join(dir, name), "utf8"));
  }
  return map;
}

function summaryMarkdown(result) {
  const lines = [];
  lines.push(`## CI classification: **${result.profile}** (level ${result.level})`);
  lines.push("");
  lines.push(`- computed profile: ${result.computed_profile}`);
  lines.push(`- proposed profile: ${result.claim.value || "none"}${result.claim.error ? ` — **REJECTED**: ${result.claim.error}` : ""}`);
  lines.push(`- subsystems: ${result.subsystems.join(", ") || "none"}`);
  lines.push(`- files: ${result.files.length}`);
  if (result.reasons.length) { lines.push(""); lines.push("### Why"); for (const reason of result.reasons.slice(0, 60)) lines.push(`- ${reason}`); }
  const skipped = Object.entries(result.lanes.skipped);
  if (skipped.length) { lines.push(""); lines.push("### Skipped jobs"); for (const [job, why] of skipped) lines.push(`- \`${job}\`: ${why}`); }
  if (result.profile === "FAST") { lines.push(""); lines.push(`### Focused tests (${result.focused_tests.length})`); for (const name of result.focused_tests) lines.push(`- ${name}: ${(result.focused_reasons[name] || []).join("; ")}`); }
  lines.push("");
  lines.push("<details><summary>Per-file classification</summary>");
  lines.push("");
  for (const record of result.files) lines.push(`- \`${record.path}\` ${record.status}: ${record.level} (${record.rule})`);
  lines.push("</details>");
  return lines.join("\n") + "\n";
}

function parseArgs(argv) {
  const args = { event: "pull_request", claim: null, base: null, head: "HEAD", githubOutput: null, summary: null, json: null, labels: null, body: null };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const next = () => argv[++index];
    if (item === "--base") args.base = next();
    else if (item === "--head") args.head = next();
    else if (item === "--event") args.event = next();
    else if (item === "--claim") args.claim = next();
    else if (item === "--labels-json") args.labels = next();
    else if (item === "--body-file") args.body = next();
    else if (item === "--github-output") args.githubOutput = next();
    else if (item === "--summary") args.summary = next();
    else if (item === "--json") args.json = next();
    else throw new Error(`unknown argument ${item}`);
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const root = process.cwd();
  let files = [];
  let diffError = null;
  if (args.event === "pull_request") {
    if (!args.base) diffError = "--base is required for pull_request";
    else {
      try { files = readDiff(args.base, args.head, root); } catch (error) { diffError = error.message; }
    }
  }
  let claim = args.claim;
  if (!claim && (args.labels || args.body)) {
    const labels = args.labels ? JSON.parse(args.labels).map((item) => (typeof item === "string" ? item : item.name)) : [];
    const body = args.body && fs.existsSync(args.body) ? fs.readFileSync(args.body, "utf8") : "";
    claim = claimFromPullRequest({ labels, body });
  }
  const result = classifyChanges({ event: args.event, files, claim, testSources: readTestSources(root) });
  if (diffError) { result.reasons.unshift(`diff unreadable (${diffError}): FULL`); result.level = "critical"; result.computed_profile = "FULL"; result.profile = "FULL"; result.lanes = lanesFor("FULL", result.files, []); }

  const json = JSON.stringify(result, null, 2);
  if (args.json) fs.writeFileSync(args.json, json + "\n");
  if (args.summary) fs.appendFileSync(args.summary, summaryMarkdown(result));
  if (args.githubOutput) {
    const out = [
      `profile=${result.profile}`,
      `computed_profile=${result.computed_profile}`,
      `level=${result.level}`,
      `claim_ok=${result.claim.accepted ? "true" : "false"}`,
      `claim_error=${(result.claim.error || "").replace(/\n/g, " ")}`,
      `groups=${JSON.stringify({ include: result.lanes.groups.length ? result.lanes.groups : [{ lane: "none", groups: "", shard: "", extras: "" }] })}`,
      `run_groups=${result.lanes.groups.length ? "true" : "false"}`,
      `focused=${result.lanes.focused}`
    ];
    for (const key of ["web_runtime_core", "web_runtime_resilience", "docker_smoke", "docker_release_lab", "preflight_database"]) out.push(`${key}=${result.lanes[key] ? "true" : "false"}`);
    fs.appendFileSync(args.githubOutput, out.join("\n") + "\n");
  }
  console.log(`CI_CLASSIFICATION profile=${result.profile} computed=${result.computed_profile} level=${result.level} files=${result.files.length} claim=${result.claim.value || "none"} claim_ok=${result.claim.accepted}`);
  for (const reason of result.reasons.slice(0, 40)) console.log(`  - ${reason}`);
  if (result.profile === "FAST") console.log(`  focused tests: ${result.focused_tests.join(", ") || "none"}`);
  return 0;
}

if (require.main === module) {
  try { process.exit(main(process.argv.slice(2))); } catch (error) { console.error(`CI_CLASSIFIER_ERROR ${error.stack || error.message}`); process.exit(1); }
}

module.exports = { LEVELS, PROFILES, PATH_RULES, TEST_LANES, CRITICAL_CONTENT, classifyChanges, claimFromPullRequest, copyOnly, focusedTests, groupMatrix, lanesFor, readDiff, summaryMarkdown };
