#!/usr/bin/env node
// Dependency / supply-chain check (npm run check:supply-chain).
//
//   lockfile presence + version (root and web/)
//   non-registry dependencies (git:, http:, file: outside mobile-plugins/)
//   npm audit, normalised: production vs dev, direct vs transitive, fix
//     availability; production critical/high are WARNINGs for the owner
//     upgrade decision (nothing is upgraded here), dev-only findings are
//     listed as INFO in the artifact
//   duplicate major versions of production runtime dependencies
//   Node engine alignment: package.json engines, Dockerfile base image,
//     CI workflow node-version, local Node
// Network: `npm audit` talks to the npm registry advisory endpoint. Offline
// it reports SKIPPED_ENVIRONMENT for the audit step only.
const fs = require("node:fs");
const path = require("node:path");
const { runSync } = require("./lib/run_command.cjs");
const { ReleaseReport, artifactsDir } = require("./lib/release_report.cjs");

const root = process.cwd();

function npm(args, cwd = root) {
  return runSync("npm", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 300000, env: { ...process.env, NODE_ENV: "development" } });
}
function readJson(rel) { return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8")); }

function main() {
  const report = new ReleaseReport("supply chain");
  const artifact = { audit: null, duplicates: null, engines: null };

  for (const [label, dir] of [["root", "."], ["web", "web"]]) {
    const lock = path.join(root, dir, "package-lock.json");
    if (!fs.existsSync(lock)) { report.fail("lockfile " + label, "package-lock.json missing"); continue; }
    const parsed = JSON.parse(fs.readFileSync(lock, "utf8"));
    const packages = parsed.packages || {};
    const nonRegistry = Object.entries(packages).filter(([name, meta]) => name && meta.resolved && /^(git\+|git:|http:|https?:\/\/(?!registry\.npmjs\.org))/.test(meta.resolved));
    const links = Object.entries(packages).filter(([, meta]) => meta.link === true || (meta.resolved && /^file:/.test(meta.resolved)));
    const unexpectedLinks = links.filter(([, meta]) => !/^(file:)?mobile-plugins\//.test(String(meta.resolved || "")));
    if (nonRegistry.length || unexpectedLinks.length) report.fail("lockfile " + label, "non-registry or unexpected linked dependencies", { detail: [...nonRegistry, ...unexpectedLinks].map(([name, meta]) => name + " -> " + meta.resolved).join("\n") });
    else report.pass("lockfile " + label, "lockfileVersion=" + parsed.lockfileVersion + " packages=" + Object.keys(packages).length + " non_registry=0 local_links=" + links.length + (links.length ? " (" + links.map(([name]) => name).join(", ") + ")" : ""));
  }

  const ls = npm(["ls", "--json", "--depth=0"]);
  let lsJson = null;
  try { lsJson = JSON.parse(ls.stdout || "{}"); } catch { lsJson = null; }
  if (!lsJson) report.skip("installed tree", "npm ls produced no JSON (node_modules missing?)");
  else if (lsJson.problems && lsJson.problems.length) report.fail("installed tree", lsJson.problems.length + " problems (missing/invalid/extraneous)", { detail: lsJson.problems.slice(0, 30).join("\n") });
  else report.pass("installed tree", "npm ls: no missing/invalid/extraneous top-level dependencies");

  const audit = npm(["audit", "--json"]);
  let auditJson = null;
  try { auditJson = JSON.parse(audit.stdout || "{}"); } catch { auditJson = null; }
  if (!auditJson || !auditJson.metadata) {
    report.skip("npm audit", "audit unavailable (offline or registry error): " + String(audit.stderr || "").slice(0, 200));
  } else {
    const pkg = readJson("package.json");
    const prodDirect = new Set(Object.keys(pkg.dependencies || {}));
    const prodAudit = npm(["audit", "--json", "--omit=dev"]);
    let prodJson = null;
    try { prodJson = JSON.parse(prodAudit.stdout || "{}"); } catch { prodJson = null; }
    const prodNames = new Set(Object.keys((prodJson && prodJson.vulnerabilities) || {}));
    const rows = Object.entries(auditJson.vulnerabilities || {}).map(([name, vuln]) => ({
      name,
      severity: vuln.severity,
      direct: Boolean(vuln.isDirect),
      production: prodNames.has(name),
      fix_available: vuln.fixAvailable === true ? "yes" : vuln.fixAvailable && typeof vuln.fixAvailable === "object" ? "yes (" + vuln.fixAvailable.name + "@" + vuln.fixAvailable.version + (vuln.fixAvailable.isSemVerMajor ? ", MAJOR" : "") + ")" : "no",
      titles: (vuln.via || []).filter((item) => typeof item === "object").map((item) => item.title).slice(0, 3)
    }));
    artifact.audit = { metadata: auditJson.metadata, rows };
    const prodSevere = rows.filter((row) => row.production && ["critical", "high"].includes(row.severity));
    const prodOther = rows.filter((row) => row.production && !["critical", "high"].includes(row.severity));
    const devOnly = rows.filter((row) => !row.production);
    const counts = auditJson.metadata.vulnerabilities;
    const summary = "total=" + counts.total + " (critical " + counts.critical + ", high " + counts.high + ", moderate " + counts.moderate + ", low " + counts.low + "); production critical/high=" + prodSevere.length + ", production other=" + prodOther.length + ", dev-only=" + devOnly.length;
    const detail = [
      ...prodSevere.map((row) => "PRODUCTION " + row.severity.toUpperCase() + " " + row.name + (row.direct ? " (direct)" : " (transitive)") + " fix=" + row.fix_available + " :: " + row.titles.join(" | ")),
      ...prodOther.map((row) => "production " + row.severity + " " + row.name + (row.direct ? " (direct)" : "") + " fix=" + row.fix_available + " :: " + row.titles.join(" | ")),
      ...devOnly.map((row) => "dev-only " + row.severity + " " + row.name + " fix=" + row.fix_available)
    ].join("\n");
    if (prodSevere.length) report.warn("npm audit", summary + " - OWNER UPGRADE DECISION (nothing upgraded on this branch; see docs/SUPPLY_CHAIN_STATUS.md)", { detail });
    else if (prodOther.length) report.warn("npm audit", summary, { detail });
    else report.pass("npm audit", summary, { detail });
  }

  // Duplicate major versions among production runtime dependencies.
  const all = npm(["ls", "--all", "--json", "--omit=dev"]);
  let allJson = null;
  try { allJson = JSON.parse(all.stdout || "{}"); } catch { allJson = null; }
  if (allJson) {
    const versions = new Map();
    const walk = (deps) => { for (const [name, meta] of Object.entries(deps || {})) { if (meta.version) { const majors = versions.get(name) || new Set(); majors.add(meta.version.split(".")[0]); versions.set(name, majors); } walk(meta.dependencies); } };
    walk(allJson.dependencies);
    const duplicates = [...versions.entries()].filter(([, majors]) => majors.size > 1).map(([name, majors]) => name + " majors=" + [...majors].join(","));
    artifact.duplicates = duplicates;
    (duplicates.length ? report.warn : report.pass).call(report, "duplicate majors (production)", duplicates.length ? duplicates.length + " production packages resolve to more than one major version" : "no production package resolves to more than one major version", { detail: duplicates.join("\n") || undefined });
  } else report.skip("duplicate majors (production)", "npm ls --all unavailable");

  // Engine alignment.
  const pkg = readJson("package.json");
  const engines = String((pkg.engines || {}).node || "");
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const dockerNode = (dockerfile.match(/^FROM\s+node:(\d+)/m) || [])[1] || null;
  const workflowDir = path.join(root, ".github", "workflows");
  const ciNodes = new Set();
  for (const file of fs.existsSync(workflowDir) ? fs.readdirSync(workflowDir) : []) {
    for (const match of fs.readFileSync(path.join(workflowDir, file), "utf8").matchAll(/node-version:\s*["']?(\d+)/g)) ciNodes.add(match[1]);
  }
  const localNode = process.versions.node.split(".")[0];
  artifact.engines = { engines, dockerfile: dockerNode, ci: [...ciNodes], local: localNode };
  const aligned = dockerNode && [...ciNodes].every((v) => v === dockerNode);
  const detail = "package.json engines.node=" + engines + "; Dockerfile node:" + dockerNode + "; CI node-version=" + [...ciNodes].join(",") + "; local node " + localNode + (localNode !== dockerNode ? " (differs from the deployed image; local results are not identical to CI/hosted)" : "");
  (aligned ? report.pass : report.warn).call(report, "node engine alignment", detail);

  report.printSummary({ detailLines: 40 });
  fs.writeFileSync(path.join(artifactsDir(root), "supply-chain.json"), JSON.stringify(artifact, null, 2) + "\n");
  report.writeArtifacts(artifactsDir(root), "supply-chain");
  console.log(report.exitCode() ? "SUPPLY_CHAIN_CHECK_FAIL" : "SUPPLY_CHAIN_CHECK_PASS");
  process.exit(report.exitCode());
}

main();
