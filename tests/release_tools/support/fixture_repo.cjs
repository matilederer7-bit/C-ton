// Builds a disposable fixture repository for release-tool tests.
//
// Copies a selected subset of the real repository into a temporary directory
// (so a test can MUTATE a source file and prove a gate catches it) and links
// node_modules with a junction so tsx / typescript resolve without a second
// install. Every fixture is removed on cleanup.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function copyInto(fixtureRoot, relFiles) {
  for (const rel of relFiles) {
    const src = path.join(REPO_ROOT, rel);
    const dest = path.join(fixtureRoot, rel);
    if (!fs.existsSync(src)) throw new Error("fixture source missing: " + rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, dest, { recursive: true });
    else fs.copyFileSync(src, dest);
  }
}

function linkNodeModules(fixtureRoot) {
  const target = path.join(REPO_ROOT, "node_modules");
  const link = path.join(fixtureRoot, "node_modules");
  if (fs.existsSync(link)) return;
  try {
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    throw new Error("could not link node_modules into fixture: " + error.message);
  }
}

function createFixtureRepo(relFiles, options = {}) {
  const fixtureRoot = makeTempDir(options.prefix || "siton-release-fixture-");
  copyInto(fixtureRoot, relFiles);
  if (options.nodeModules !== false) linkNodeModules(fixtureRoot);
  return {
    root: fixtureRoot,
    write(rel, content) {
      const dest = path.join(fixtureRoot, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
    },
    read(rel) { return fs.readFileSync(path.join(fixtureRoot, rel), "utf8"); },
    // Line endings: a Windows checkout (core.autocrlf=true) carries CRLF, the
    // anchors in tests are written with LF. Match on LF-normalised text and
    // write back with the file's original ending so the mutation is the only
    // change. `all: true` replaces every occurrence.
    mutate(rel, from, to, options = {}) {
      const raw = this.read(rel);
      const eol = raw.includes("\r\n") ? "\r\n" : "\n";
      const current = raw.replace(/\r\n/g, "\n");
      const anchor = from.replace(/\r\n/g, "\n");
      if (!current.includes(anchor)) throw new Error("mutation anchor not found in " + rel + ": " + anchor.slice(0, 80));
      const replacement = to.replace(/\r\n/g, "\n");
      const next = options.all ? current.split(anchor).join(replacement) : current.replace(anchor, replacement);
      this.write(rel, next.replace(/\n/g, eol));
    },
    run(scriptRel, args = [], env = {}) {
      return spawnSync(process.execPath, [path.join(fixtureRoot, scriptRel), ...args], {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: { ...process.env, DOTENV_CONFIG_QUIET: "true", NODE_ENV: "test", ...env },
        timeout: 120000
      });
    },
    cleanup() {
      // Remove the junction first so the real node_modules is never deleted.
      const link = path.join(fixtureRoot, "node_modules");
      try { if (fs.existsSync(link)) fs.rmSync(link, { recursive: false, force: true }); } catch { /* junction removal best effort */ }
      try { fs.rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };
}

module.exports = { REPO_ROOT, createFixtureRepo, makeTempDir };
