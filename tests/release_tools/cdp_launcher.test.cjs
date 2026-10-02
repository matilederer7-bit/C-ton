"use strict";
// scripts/lib/cdp.cjs — the shared operator-proof browser launcher.
// A fake executable records its argv and serves /json/list, so the exact
// flags, profile/port shape and return value are pinned without a browser;
// a real Chromium smoke runs when one is installed.
const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const root = resolve(__dirname, "..", "..");
const { launchCdpBrowser } = require(join(root, "scripts", "lib", "cdp.cjs"));

function fakeBrowser(dir, { serve }) {
  const file = join(dir, "fake-browser.cjs");
  writeFileSync(file, `#!${process.execPath}
const { writeFileSync } = require("node:fs");
const { createServer } = require("node:http");
writeFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));
const port = Number(process.argv.find((a) => a.startsWith("--remote-debugging-port=")).split("=")[1]);
if (${serve ? "true" : "false"}) {
  createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/json/list" ? [{ type: "service_worker" }, { type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:" + port + "/devtools/page/FAKE" }] : []));
  }).listen(port, "127.0.0.1");
}
setInterval(() => {}, 1000);
`);
  chmodSync(file, 0o755);
  return file;
}

test("launchCdpBrowser spawns the shared flag set and returns { proc, profileDir, wsUrl }", { skip: process.platform === "win32" && "shebang executable" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cdp-launcher-"));
  try {
    const executable = fakeBrowser(dir, { serve: true });
    const browser = await launchCdpBrowser({ executable, profilePrefix: "siton-test-proof", portBase: 38_000, extraArgs: ["--extra-a", "--extra-b"] });
    try {
      const argv = JSON.parse(readFileSync(join(dir, "argv.json"), "utf8"));
      const port = Number(argv.find((a) => a.startsWith("--remote-debugging-port=")).split("=")[1]);
      assert.ok(port >= 38_000 && port < 39_000, `port ${port} within portBase..portBase+999`);
      assert.match(browser.profileDir, /siton-test-proof-\d+$/);
      assert.ok(browser.profileDir.startsWith(tmpdir()), "profile lives under the OS temp dir");
      assert.deepEqual(argv, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--lang=he", "--extra-a", "--extra-b", `--remote-debugging-port=${port}`, `--user-data-dir=${browser.profileDir}`, "about:blank"]);
      assert.equal(browser.wsUrl, `ws://127.0.0.1:${port}/devtools/page/FAKE`, "the first page target's DevTools URL");
      assert.equal(typeof browser.proc.kill, "function");
    } finally { browser.proc.kill("SIGKILL"); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("launchCdpBrowser kills the process and throws the caller's message when CDP never answers", { skip: process.platform === "win32" && "shebang executable", timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cdp-launcher-"));
  try {
    const executable = fakeBrowser(dir, { serve: false });
    let spawned = null;
    const childProcess = require("node:child_process");
    const realSpawn = childProcess.spawn;
    // observe the spawned child without changing what the launcher does
    childProcess.spawn = (...args) => (spawned = realSpawn(...args));
    delete require.cache[require.resolve(join(root, "scripts", "lib", "cdp.cjs"))];
    const fresh = require(join(root, "scripts", "lib", "cdp.cjs"));
    childProcess.spawn = realSpawn;
    await assert.rejects(fresh.launchCdpBrowser({ executable, profilePrefix: "siton-test-proof", portBase: 38_000, unavailableMessage: "CDP endpoint not available" }), /^Error: CDP endpoint not available$/);
    assert.ok(spawned, "a browser process was spawned");
    assert.equal(spawned.signalCode === "SIGKILL" || spawned.killed, true, "the stuck process is killed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the operator proofs launch through scripts/lib/cdp.cjs instead of a private copy", () => {
  for (const name of ["authenticated_ui_acceptance", "buyer_polish_browser_proof", "launch_polish_browser_proof", "p0_browser_proof", "pickup_fulfillment_browser_proof", "r7r8_browser_proof"]) {
    const source = readFileSync(join(root, "scripts", `${name}.cjs`), "utf8");
    assert.match(source, /require\("\.\/lib\/cdp\.cjs"\)/, `${name} requires the shared launcher`);
    assert.match(source, /await launchCdpBrowser\(\{|return launchCdpBrowser\(\{/, `${name} launches through launchCdpBrowser`);
    assert.doesNotMatch(source, /--remote-debugging-port/, `${name} must not carry its own launcher copy`);
  }
});

const CHROMIUM = [process.env.SITON_ACCEPTANCE_BROWSER, "/opt/pw-browsers/chromium", "/opt/pw-browsers/chromium/chrome-linux/chrome", "/usr/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"].filter(Boolean).find(existsSync);

test("launchCdpBrowser opens a real headless Chromium page target", { skip: !CHROMIUM && "no Chromium installed", timeout: 60_000 }, async () => {
  const extraArgs = typeof process.getuid === "function" && process.getuid() === 0 ? ["--no-sandbox"] : [];
  const browser = await launchCdpBrowser({ executable: CHROMIUM, profilePrefix: "siton-cdp-launcher-smoke", portBase: 39_000, extraArgs });
  try {
    assert.match(browser.wsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/page\//);
  } finally {
    browser.proc.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    rmSync(browser.profileDir, { recursive: true, force: true });
  }
});
