// Cross-platform synchronous command runner for release tooling.
//
// Windows needs a shell for npm/npx (.cmd wrappers) but Node 24 warns when
// args are passed together with shell:true. cmd.exe is invoked explicitly
// with the whole command line instead; plain executables (node, git,
// docker, pg_dump) run directly without a shell on every platform.
const { spawnSync } = require("node:child_process");

const WRAPPERS = /^(npm|npx|yarn|pnpm)(\.cmd)?$/i;

function quoteForCmd(value) {
  const text = String(value);
  return /[\s"&|<>^()]/.test(text) ? "\"" + text.replace(/"/g, "\\\"") + "\"" : text;
}

function runSync(command, args = [], options = {}) {
  if (process.platform === "win32" && WRAPPERS.test(command)) {
    const line = [command.replace(/\.cmd$/i, ""), ...args].map(quoteForCmd).join(" ");
    return spawnSync("cmd.exe", ["/d", "/s", "/c", line], { windowsVerbatimArguments: true, ...options });
  }
  return spawnSync(command === "node" ? process.execPath : command, args, options);
}

module.exports = { runSync, WRAPPERS };
