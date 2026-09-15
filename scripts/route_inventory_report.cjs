#!/usr/bin/env node
// Release route inventory report (npm run report:routes).
//
// Runs the static route inventory (scripts/web_route_inventory.cjs, which
// already enforces UNGUARDED_PROTECTED_ROUTES = 0 statically) and then
// classifies EVERY route intentionally:
//   total / protected / public / admin / seller / distributor / buyer-token /
//   anonymous-by-design / webhook / public-read / public-write / app-shell /
//   legacy-alias / demo-only / health
// Protected classes come from the policy + route metadata; the rest from
// config/route-classification.json. A route that matches no rule is
// UNCLASSIFIED and FAILS the gate - classify it deliberately before it ships.
// Auth semantics are never changed here; the behavioural gate
// (tests/protected_route_authorization_gate.ts) stays the authority.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ReleaseReport, artifactsDir } = require("./lib/release_report.cjs");

const root = process.cwd();

function main() {
  const report = new ReleaseReport("route inventory");
  const inventory = spawnSync(process.execPath, [path.join(root, "scripts", "web_route_inventory.cjs")], { cwd: root, encoding: "utf8" });
  if (inventory.status !== 0) {
    report.fail("static inventory", "web_route_inventory failed: " + String(inventory.stderr || inventory.stdout).slice(-600));
    return finish(report, null);
  }
  const data = JSON.parse(fs.readFileSync(path.join(root, ".ci-artifacts", "web-route-inventory.json"), "utf8"));
  report.pass("static inventory", "routes=" + data.route_count + " protected=" + data.protected_routes + " anonymous_by_design=" + data.anonymous_by_design_routes.length + " unguarded_protected=" + data.unguarded_protected_routes.length + " duplicates=" + data.duplicate_routes.length);

  const config = JSON.parse(fs.readFileSync(path.join(root, "config", "route-classification.json"), "utf8"));
  const rules = config.rules.map((rule) => ({ ...rule, regex: new RegExp(rule.pattern) }));
  const classified = [];
  const unclassified = [];
  for (const route of data.routes) {
    let klass = null;
    let note = null;
    if (route.authorization_class === "anonymous-by-design") klass = "anonymous-by-design";
    else if (route.authorization_class === "guard-call-present" || route.authorization_class === "no-guard-call") {
      const role = String(route.role || "");
      klass = role.startsWith("admin") || route.path.startsWith("/api/admin/") ? "admin" : role.startsWith("seller") || route.path.startsWith("/api/seller/") ? "seller" : "distributor";
      if (route.authorization_class === "no-guard-call") note = "NO GUARD CALL (static gate failure)";
    } else {
      for (const rule of rules) {
        if (!rule.regex.test(route.path)) continue;
        if (rule.methods && !rule.methods.includes(route.method)) continue;
        klass = rule.override_class || rule.class;
        note = rule.note || null;
        break;
      }
    }
    const entry = { method: route.method, path: route.path, class: klass, note, source: route.source, lifecycle: route.lifecycle };
    if (klass) classified.push(entry);
    else unclassified.push({ ...entry, sensitive: config.sensitive_if_unclassified.prefixes.some((prefix) => route.path.startsWith(prefix)) || route.method !== "GET" });
  }
  const counts = {};
  for (const entry of classified) counts[entry.class] = (counts[entry.class] || 0) + 1;
  const protectedCount = (counts.admin || 0) + (counts.seller || 0) + (counts.distributor || 0);
  const publicCount = classified.length - protectedCount - (counts["anonymous-by-design"] || 0);
  const summary = {
    total_routes: data.route_count,
    protected_routes: protectedCount,
    public_routes: publicCount,
    admin_routes: counts.admin || 0,
    seller_routes: counts.seller || 0,
    distributor_routes: counts.distributor || 0,
    buyer_token_routes: counts["buyer-token"] || 0,
    explicitly_anonymous_routes: counts["anonymous-by-design"] || 0,
    webhook_routes: counts.webhook || 0,
    public_read_routes: counts["public-read"] || 0,
    public_write_routes: counts["public-write"] || 0,
    app_shell_routes: counts["app-shell"] || 0,
    legacy_alias_routes: counts["legacy-alias"] || 0,
    demo_only_routes: counts["demo-only"] || 0,
    health_routes: counts.health || 0,
    unclassified_routes: unclassified.length,
    unclassified_sensitive_routes: unclassified.filter((item) => item.sensitive).length
  };
  const lines = Object.entries(summary).map(([key, value]) => key + "=" + value);
  report.pass("classification counts", lines.join(" "));
  if (unclassified.length) {
    report.fail("unclassified routes", unclassified.length + " routes match no classification rule (" + summary.unclassified_sensitive_routes + " sensitive)", { detail: unclassified.map((item) => (item.sensitive ? "SENSITIVE " : "") + item.method + " " + item.path + " (" + item.source + ")").join("\n") + "\nAdd a rule to config/route-classification.json (and a guard/policy entry if the route needs authority)." });
  } else {
    report.pass("unclassified routes", "every route is intentionally classified");
  }
  const publicWrite = classified.filter((item) => item.class === "public-write");
  report.warn("public-write review", publicWrite.length + " anonymous mutation endpoints are deliberate product decisions; each must stay rate-limited and validated", { detail: publicWrite.map((item) => item.method + " " + item.path).join("\n") });
  const staticFailures = classified.filter((item) => item.note && /NO GUARD CALL/.test(item.note));
  if (staticFailures.length) report.fail("guard calls", staticFailures.length + " protected routes without a guard call", { detail: staticFailures.map((item) => item.method + " " + item.path).join("\n") });

  const markdown = [
    "# Release route inventory",
    "",
    "Generated " + new Date().toISOString() + " from scripts/web_route_inventory.cjs + config/route-classification.json.",
    "",
    "| Metric | Count |", "|---|---|",
    ...Object.entries(summary).map(([key, value]) => "| " + key + " | " + value + " |"),
    "",
    "| Method | Path | Class | Note |", "|---|---|---|---|",
    ...classified.sort((a, b) => a.class.localeCompare(b.class) || a.path.localeCompare(b.path)).map((item) => "| " + item.method + " | `" + item.path + "` | " + item.class + " | " + (item.note || "") + " |"),
    ...(unclassified.length ? ["", "## UNCLASSIFIED", "", ...unclassified.map((item) => "- " + item.method + " " + item.path)] : [])
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(artifactsDir(root), "route-inventory.md"), markdown);
  fs.writeFileSync(path.join(artifactsDir(root), "route-inventory.json"), JSON.stringify({ summary, classified, unclassified }, null, 2) + "\n");
  return finish(report, summary);
}

function finish(report, summary) {
  report.printSummary({ detailLines: 40 });
  report.writeArtifacts(artifactsDir(root), "route-inventory-gate");
  console.log(report.exitCode() ? "ROUTE_INVENTORY_REPORT_FAIL" : "ROUTE_INVENTORY_REPORT_PASS " + (summary ? JSON.stringify(summary) : ""));
  process.exit(report.exitCode());
}

main();
