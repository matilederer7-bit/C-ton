const { execFileSync } = require("node:child_process");
const { cpSync, existsSync, mkdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const repoRoot = process.cwd();
const outDir = join(repoRoot, ".demo_dist");
const frontendSrc = join(repoRoot, "frontend");
const frontendDest = join(outDir, "frontend");

if (existsSync(outDir)) {
  rmSync(outDir, { recursive: true, force: true });
}

execFileSync("npx", ["tsc", "-p", "tsconfig.demo.json"], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: true
});

mkdirSync(outDir, { recursive: true });
cpSync(frontendSrc, frontendDest, { recursive: true });

console.log(`Demo bundle ready at ${outDir}`);
