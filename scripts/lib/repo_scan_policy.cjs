// Canonical repository-scan file policy.
//
// Every static scanner (compliance, secret, DDL, logging hygiene, whitespace)
// used to invent its own exclusion list. The independent review found that at
// least one of them walked `.worktrees/` and temporary review directories and
// reported false positives from code that is not part of the release.
//
// This module is the single answer to "which files are canonical source for a
// repository scan?". Scanners call `walkRepository()` and never re-implement
// exclusions. The policy is deliberately conservative: it excludes only
// generated, vendored, version-control, temporary and review artefacts, never a
// real source directory. `tests/`, `tests/lab/`, `legacy/`, `supabase/`,
// `scripts/`, `src/`, `web/src` and `frontend/` all remain scanned.
//
// Tests for this policy live in tests/release_tools/repo_scan_policy.test.cjs.
const fs = require("node:fs");
const path = require("node:path");

// Directory NAMES excluded wherever they appear in the tree.
const EXCLUDED_DIR_NAMES = Object.freeze([
  ".git",
  ".worktrees",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".nyc_output",
  ".demo_dist",
  ".mobile_dist",
  ".tmp_test_dist",
  ".ci-artifacts",
  ".release-artifacts",
  ".cache",
  ".claude",
  ".cursor",
  ".vscode",
  ".idea",
  ".sixth",
  "archive",
  "archive_temp",
  "backups",
  "uploads",
  "logs",
  "tmp",
  "temp",
  // Native build output and vendored pods inside the mobile shells.
  "Pods",
  ".gradle",
  "DerivedData"
]);

// Directory name PREFIXES excluded wherever they appear (temporary worktrees,
// temporary QA/review directories, generated scratch directories).
const EXCLUDED_DIR_PREFIXES = Object.freeze([".tmp", ".worktree", ".review", ".scratch"]);

// File name patterns that are never canonical source: logs, review artefacts,
// generated binaries, dumps, local env files.
const EXCLUDED_FILE_PATTERNS = Object.freeze([
  /\.log$/i,
  /^review-.*\.(log|txt|json)$/i,
  /\.(dump|bak|tmp|orig|rej|swp)$/i,
  /\.(png|jpe?g|gif|webp|ico|pdf|docx|xlsx|zip|gz|tgz|7z|jar|aar|apk|ipa|keystore|jks|p12|p8|pfx|mobileprovision)$/i,
  /^\.DS_Store$/,
  /^Thumbs\.db$/i,
  /^desktop\.ini$/i
]);

// Source-like extensions used by most scanners. A scanner may pass its own.
const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|cjs|mjs|sql|html|css|json|jsonc|yml|yaml|md|ps1|sh|toml|env\.example)$/i;
const CODE_EXTENSIONS = /\.(ts|tsx|js|jsx|cjs|mjs|sql|html|css)$/i;

function isExcludedDirName(name) {
  if (EXCLUDED_DIR_NAMES.includes(name)) return true;
  return EXCLUDED_DIR_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isExcludedFileName(name) {
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

// Repository-relative paths are normalised on BOTH separators on every
// platform: a scanner may receive a Windows-shaped path on Linux (CI, a path
// copied from a report) and a backslash-joined ".worktrees\x\src\app.ts" must
// still be recognised as excluded. Splitting only on path.sep left such a
// path as one segment on Linux (first CI runs: "isCanonicalSourcePath agrees
// on both separators" failed there and passed on Windows). Git paths never
// carry a literal backslash, so nothing canonical is lost.
function toPosix(rel) {
  return String(rel).split(/[\\/]+/).join("/").replace(/^\.\//, "");
}

/**
 * True when a repository-relative path lies entirely within canonical source:
 * no path segment is an excluded directory and the file name is not an
 * excluded artefact. Works on either separator.
 */
function isCanonicalSourcePath(rel) {
  const posix = toPosix(rel);
  const segments = posix.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  const fileName = segments[segments.length - 1];
  for (const segment of segments.slice(0, -1)) {
    if (isExcludedDirName(segment)) return false;
  }
  if (isExcludedFileName(fileName)) return false;
  return true;
}

/**
 * Walk the repository (or selected sub-roots) and return canonical source
 * files as `{ rel, abs }` with `rel` in POSIX form relative to `root`.
 *
 * options.roots        - sub-directories to walk (default: the whole root)
 * options.extensions   - RegExp tested against the file name (default: SOURCE_EXTENSIONS)
 * options.includeFile  - optional predicate (rel, abs) => boolean
 * options.extraExcludedDirs - additional directory names excluded for this scan only
 */
function walkRepository(root, options = {}) {
  const extensions = options.extensions || SOURCE_EXTENSIONS;
  const extra = new Set(options.extraExcludedDirs || []);
  const out = [];
  const startDirs = (options.roots && options.roots.length ? options.roots : ["."]).map((dir) => path.join(root, dir));
  const seen = new Set();
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (isExcludedDirName(entry.name) || extra.has(entry.name)) continue;
        visit(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isExcludedFileName(entry.name)) continue;
      if (!extensions.test(entry.name)) continue;
      const rel = toPosix(path.relative(root, abs));
      if (seen.has(rel)) continue;
      if (options.includeFile && !options.includeFile(rel, abs)) continue;
      seen.add(rel);
      out.push({ rel, abs });
    }
  };
  for (const dir of startDirs) {
    if (!fs.existsSync(dir)) continue;
    // A requested root that is itself excluded (e.g. someone passes
    // ".worktrees") is refused rather than silently walked.
    const relRoot = toPosix(path.relative(root, dir));
    if (relRoot && relRoot.split("/").some((segment) => isExcludedDirName(segment))) continue;
    visit(dir);
  }
  out.sort((left, right) => left.rel.localeCompare(right.rel));
  return out;
}

function describePolicy() {
  return {
    excluded_dir_names: [...EXCLUDED_DIR_NAMES],
    excluded_dir_prefixes: [...EXCLUDED_DIR_PREFIXES],
    excluded_file_patterns: EXCLUDED_FILE_PATTERNS.map((pattern) => pattern.source),
    always_scanned_examples: ["src", "tests", "tests/lab", "scripts", "supabase", "legacy", "frontend", "web/src", "config", "docs"]
  };
}

module.exports = {
  EXCLUDED_DIR_NAMES,
  EXCLUDED_DIR_PREFIXES,
  EXCLUDED_FILE_PATTERNS,
  SOURCE_EXTENSIONS,
  CODE_EXTENSIONS,
  isExcludedDirName,
  isExcludedFileName,
  isCanonicalSourcePath,
  walkRepository,
  toPosix,
  describePolicy
};
