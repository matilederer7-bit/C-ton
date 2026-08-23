const { execFileSync } = require("node:child_process");
const { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const repoRoot = process.cwd();
const outDir = join(repoRoot, ".demo_dist");
const frontendSrc = join(repoRoot, "frontend");
const frontendDest = join(outDir, "frontend");

if (existsSync(outDir)) {
  rmSync(outDir, { recursive: true, force: true });
}

execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.demo.json"], {
  cwd: repoRoot,
  stdio: "inherit"
});

mkdirSync(outDir, { recursive: true });
cpSync(frontendSrc, frontendDest, { recursive: true });

const assetVersion =
  process.env.RENDER_GIT_COMMIT ||
  process.env.COMMIT_SHA ||
  process.env.GIT_COMMIT ||
  (() => {
    try {
      return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
    } catch {
      return String(Date.now());
    }
  })();

const indexPath = join(frontendDest, "index.html");
const apiBaseUrl = process.env.SITON_API_BASE_URL || "";
const appLinkHost = process.env.SITON_APP_LINK_HOST || "";
const indexHtml = readFileSync(indexPath, "utf8")
  .replaceAll("__C_TON_ASSET_VERSION__", assetVersion)
  .replaceAll("__SITON_API_BASE_URL__", apiBaseUrl)
  .replaceAll("__SITON_APP_LINK_HOST__", appLinkHost);
writeFileSync(indexPath, indexHtml);

console.log(`Demo bundle ready at ${outDir}`);
