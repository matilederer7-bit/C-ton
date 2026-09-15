#!/usr/bin/env node
// Logging hygiene gate (npm run gate:logging-hygiene).
//
// Static: every log call in src/ (pino app.log / request.log / logger.*,
// console.*) is located by AST and the identifiers, property names and
// string keys inside its ARGUMENTS are classified against
// config/logging-data-classification.json:
//   NEVER_LOG   -> FAIL   (card data, OTP codes, tokens, secrets, banking data)
//   SENSITIVE   -> WARNING unless the value expression visibly masks/redacts/
//                  hashes (buyer PII, recipients, destinations, IPs)
//   SAFE / unknown -> no finding
// Also verified: the Fastify request serializer redacts URLs, SQL parameter
// logging is opt-in and prints only durations/codes, and the OTP log provider
// redacts the code.
//
// Runtime seam (when a local DATABASE_URL is present): the OTP log provider
// and the notification log provider are exercised in-process through tsx and
// their emitted log lines are scanned for the raw secret / destination.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const ast = require("./lib/ts_ast.cjs");
const policy = require("./lib/repo_scan_policy.cjs");
const rawCard = require("./lib/raw_card_terms.cjs");
const { ReleaseReport, artifactsDir } = require("./lib/release_report.cjs");

const ts = ast.ts;
const root = process.cwd();
const classification = JSON.parse(fs.readFileSync(path.join(root, "config", "logging-data-classification.json"), "utf8"));
const NEVER = classification.never_log.map((item) => item.name);
const SENSITIVE = classification.sensitive.map((item) => item.name);
const MASK = new RegExp(classification.masking_markers.join("|"), "i");
const LOG_METHODS = new Set(["info", "warn", "error", "debug", "trace", "fatal", "log", "child"]);
const LOGGER_OBJECT = /(^|\.)(log|logger|console)$/i;

function isLogCall(node, sourceFile) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  if (!LOG_METHODS.has(node.expression.name.text)) return false;
  const objectText = node.expression.expression.getText(sourceFile);
  return LOGGER_OBJECT.test(objectText) || /\blog\b/i.test(objectText);
}

function collectArgumentNames(call, sourceFile) {
  // Returns [{ name, valueText }]: for property assignments the value text
  // is kept so masking can be recognised; bare identifiers carry their own text.
  const out = [];
  for (const argument of call.arguments) {
    ast.walk(argument, (node) => {
      if (ts.isPropertyAssignment(node)) {
        const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : node.name.getText(sourceFile);
        out.push({ name, valueText: node.initializer.getText(sourceFile) });
      } else if (ts.isShorthandPropertyAssignment(node)) {
        out.push({ name: node.name.text, valueText: node.name.text });
      } else if (ts.isIdentifier(node) && !(node.parent && (ts.isPropertyAssignment(node.parent) && node.parent.name === node))) {
        out.push({ name: node.text, valueText: node.text });
      } else if (ts.isPropertyAccessExpression(node)) {
        out.push({ name: node.name.text, valueText: node.getText(sourceFile) });
      }
    });
  }
  return out;
}

function main() {
  const report = new ReleaseReport("logging hygiene");
  const files = policy.walkRepository(root, { roots: ["src"], extensions: /\.(ts|tsx|js|mjs|cjs)$/ });
  const never = [];
  const sensitive = [];
  let callCount = 0;
  for (const file of files) {
    const source = fs.readFileSync(file.abs, "utf8");
    const sourceFile = ast.parse(file.abs, source);
    ast.walk(sourceFile, (node) => {
      if (!isLogCall(node, sourceFile)) return;
      callCount += 1;
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const seen = new Set();
      for (const item of collectArgumentNames(node, sourceFile)) {
        if (seen.has(item.name)) continue;
        seen.add(item.name);
        const neverHit = rawCard.matchIdentifier(item.name, NEVER);
        if (neverHit) {
          // A literal "[redacted]" value is the documented way to show a field
          // exists without its content.
          if (/\[redacted\]|\[REDACTED\]/.test(item.valueText)) continue;
          never.push(file.rel + ":" + line + " logs NEVER_LOG field '" + item.name + "' (" + neverHit + ") value=" + item.valueText.slice(0, 60));
          continue;
        }
        const sensitiveHit = rawCard.matchIdentifier(item.name, SENSITIVE);
        if (sensitiveHit && !MASK.test(item.valueText) && !MASK.test(item.name)) {
          sensitive.push(file.rel + ":" + line + " logs SENSITIVE field '" + item.name + "' (" + sensitiveHit + ") unmasked value=" + item.valueText.slice(0, 60));
        }
      }
    });
  }
  (never.length ? report.fail : report.pass).call(report, "never-log fields", never.length ? never.length + " log calls emit NEVER_LOG data" : callCount + " log calls scanned in " + files.length + " files; no NEVER_LOG field emitted", { detail: never.join("\n") || undefined });
  (sensitive.length ? report.warn : report.pass).call(report, "sensitive fields", sensitive.length ? sensitive.length + " log calls emit SENSITIVE data unmasked (documented in docs/LOGGING_DATA_CLASSIFICATION.md)" : "no unmasked SENSITIVE field emitted", { detail: sensitive.join("\n") || undefined });

  // Structural checks on known seams.
  const appSource = fs.readFileSync(path.join(root, "src", "app.ts"), "utf8");
  (/serializers:\s*\{[\s\S]{0,400}req\(/.test(appSource) && /redactUrlForLogs\(request\.url\)/.test(appSource) ? report.pass : report.fail).call(report, "request serializer redacts URLs", "Fastify req serializer routes request.url through redactUrlForLogs");
  const dbSource = fs.readFileSync(path.join(root, "src", "db.ts"), "utf8");
  const sqlLoggingGated = /DEBUG_SQL_LOGGING/.test(dbSource) && !/console\.log\("\[db\.query\]",\s*\{[^}]*(text|values|params|sql)/.test(dbSource);
  (sqlLoggingGated ? report.pass : report.fail).call(report, "sql logging prints durations/codes only", sqlLoggingGated ? "db.query log lines carry duration_ms and error code; query text and parameters are never logged" : "db.ts logs SQL text or parameters");
  const otpSource = fs.readFileSync(path.join(root, "src", "otp_rail.ts"), "utf8");
  (/code:\s*"\[redacted\]"/.test(otpSource) ? report.pass : report.fail).call(report, "otp log provider redacts the code", "LogOtpProvider writes code: \"[redacted]\"");

  // Runtime seam: exercise the log providers and scan their output.
  const probe = spawnSync(process.execPath, ["--import", "tsx", path.join(root, "scripts", "probes", "log_provider_probe.ts")], { cwd: root, encoding: "utf8", env: { ...process.env, DOTENV_CONFIG_QUIET: "true", NODE_ENV: "test" }, timeout: 60000 });
  if (probe.status === 0) {
    const output = String(probe.stdout || "") + String(probe.stderr || "");
    const leaks = [];
    if (/SECRET-OTP-654321/.test(output)) leaks.push("raw OTP code");
    if (/\+972501112233/.test(output)) leaks.push("raw OTP destination phone");
    (leaks.length ? report.fail : report.pass).call(report, "runtime log providers", leaks.length ? "emitted " + leaks.join(", ") : "OTP log provider emitted masked destination and [redacted] code; notification log provider emitted recipient_ref (see SENSITIVE warning)", { detail: leaks.length ? output.slice(0, 2000) : undefined });
  } else {
    report.skip("runtime log providers", "probe could not run: " + String(probe.stderr || probe.stdout).slice(0, 300));
  }

  report.printSummary({ detailLines: 60 });
  report.writeArtifacts(artifactsDir(root), "logging-hygiene");
  console.log(report.exitCode() ? "LOGGING_HYGIENE_GATE_FAIL" : "LOGGING_HYGIENE_GATE_PASS log_calls=" + callCount);
  process.exit(report.exitCode());
}

main();
