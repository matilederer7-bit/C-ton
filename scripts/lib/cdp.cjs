"use strict";
// Shared headless Edge/Chrome launcher for the operator CDP browser proofs
// (no third-party driver). It only starts the browser and returns the page's
// DevTools WebSocket URL; each proof keeps its own cdpSession because their
// navigate/viewport/screenshot/diagnostics semantics differ on purpose.
//
// Not used by the esbuild-component proofs (site_cms, receipt_content,
// ux_polish_round2) or tests/helpers/browser_cdp.ts: those launch with a
// fixed or OS-assigned debug port, a repo-local profile and --no-sandbox, and
// are documented as separate launchers in docs/LEAN_REFACTOR_MAP_2026-09-30.md.

const { spawn } = require("node:child_process");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchCdpBrowser({ executable, profilePrefix, portBase, extraArgs = [], unavailableMessage = "CDP not available" }) {
  const profileDir = join(tmpdir(), `${profilePrefix}-${Date.now()}`);
  const port = portBase + Math.floor(Math.random() * 1000);
  const proc = spawn(executable, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--lang=he", ...extraArgs, `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = await res.json();
      const page = pages.find((p) => p.type === "page");
      if (page?.webSocketDebuggerUrl) return { proc, profileDir, wsUrl: page.webSocketDebuggerUrl };
    } catch { /* retry */ }
    await wait(250);
  }
  proc.kill("SIGKILL");
  throw new Error(unavailableMessage);
}

module.exports = { launchCdpBrowser };
