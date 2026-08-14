const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const REGISTRY_PATH = path.join(ROOT, "config", "base44-canonical-registry.json");
const CALLERS_PATH = path.join(ROOT, "config", "base44-canonical-callers.json");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function canonicalResources(registry) {
  return new Set(registry.functions.map((entry) => entry.canonical));
}

function validateRegistry(registry, callers) {
  const findings = [];
  const canonical = [...canonicalResources(registry)];
  if (canonical.length !== 3 || new Set(canonical).size !== 3) {
    findings.push({ code: "invalid_canonical_function_registry", detail: canonical });
  }
  if (registry.entities.length !== 25) {
    findings.push({ code: "invalid_entity_registry_size", detail: registry.entities.length });
  }
  const entityNames = registry.entities.flatMap((entry) => [entry.canonical, entry.legacy]);
  if (new Set(entityNames).size !== 50 || registry.entities.some((entry) => !entry.canonical || !entry.legacy || entry.canonical === entry.legacy)) {
    findings.push({ code: "invalid_entity_registry_classification" });
  }
  for (const target of Object.keys(callers.callers || {})) {
    if (!canonicalResources(registry).has(target)) findings.push({ code: "legacy_caller_target", target });
  }
  return findings;
}

function walk(target) {
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", ".git", ".tmp_test_dist", ".demo_dist", "archive", "dist"].includes(entry.name)) return [];
    return walk(path.join(target, entry.name));
  });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scanLegacyReferences(registry, roots) {
  const findings = [];
  const legacyFunctions = registry.functions.flatMap((entry) => entry.legacy);
  const legacyEntities = registry.entities.map((entry) => entry.legacy);
  const files = roots.flatMap((root) => walk(path.resolve(ROOT, root)))
    .filter((file) => /\.(?:cjs|mjs|js|jsx|ts|tsx|jsonc?)$/.test(file))
    .filter((file) => !file.endsWith("base44_canonical_integrity_gate.cjs"));
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const relative = path.relative(ROOT, file).replace(/\\/g, "/");
    for (const resource of legacyFunctions) {
      const quoted = `["']${escapeRegex(resource)}["']`;
      const invoke = new RegExp(`(?:functions\\.)?invoke\\s*\\(\\s*${quoted}`, "g");
      if (invoke.test(source)) findings.push({ code: "legacy_function_reference", resource, file: relative });
    }
    for (const resource of legacyEntities) {
      const dot = new RegExp(`\\.entities\\.${escapeRegex(resource)}(?:\\W|$)`, "g");
      const bracket = new RegExp(`\\.entities\\s*\\[\\s*["']${escapeRegex(resource)}["']\\s*\\]`, "g");
      if (dot.test(source) || bracket.test(source)) findings.push({ code: "legacy_entity_reference", resource, file: relative });
    }
  }
  return findings;
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sameProjection(deal, projection) {
  if (!projection) return false;
  return asNumber(deal.max_units) === asNumber(projection.max_units)
    && asNumber(deal.min_units) === asNumber(projection.min_units)
    && asNumber(deal.inventory_reserved_units) === asNumber(projection.reserved_units)
    && asNumber(deal.inventory_committed_units) === asNumber(projection.committed_units)
    && asNumber(deal.reserved_units) === asNumber(projection.committed_units)
    && String(deal.state) === String(projection.deal_state);
}

function auditMatches(dealId, transition, audits) {
  return audits.some((audit) => String(audit.deal_id) === String(dealId)
    && ((transition.audit_id && String(audit.audit_id) === String(transition.audit_id))
      || (!transition.audit_id
        && String(audit.from_state) === String(transition.from_state)
        && String(audit.to_state) === String(transition.to_state)
        && String(audit.action_name) === String(transition.action_name)
        && String(audit.idempotency_key) === String(transition.idempotency_key))));
}

function evaluateSnapshot(snapshot) {
  const findings = [];
  const now = Date.parse(snapshot.now || new Date().toISOString());
  const deals = snapshot.deals || [];
  const projections = new Map((snapshot.inventory_projections || []).map((row) => [String(row.deal_id), row]));
  const audits = snapshot.audits || [];
  const dlqIds = new Set((snapshot.dlq_records || []).map((row) => String(row.event_uuid)));
  for (const deal of deals) {
    if (asNumber(deal.reserved_units) > asNumber(deal.max_units)) {
      findings.push({ code: "reserved_units_exceed_max_units", deal_id: deal.deal_id });
    }
    if (["synced", "closed"].includes(String(deal.inventory_sync_status || ""))
      && !sameProjection(deal, projections.get(String(deal.deal_id)))) {
      findings.push({ code: "inventory_projection_mismatch", deal_id: deal.deal_id });
    }
    for (const transition of deal.transition_journal || []) {
      if (!auditMatches(deal.deal_id, transition, audits)) {
        findings.push({ code: "transition_without_audit", deal_id: deal.deal_id, audit_id: transition.audit_id || null });
      }
    }
  }
  for (const event of snapshot.outbox_events || []) {
    if (event.status === "processing" && (!Number.isFinite(Date.parse(event.lease_expires_at || "")) || Date.parse(event.lease_expires_at) <= now)) {
      findings.push({ code: "expired_processing_lease", event_uuid: event.event_uuid });
    }
    if (event.status === "dead_letter" && !dlqIds.has(String(event.event_uuid))) {
      findings.push({ code: "dead_letter_without_dlq", event_uuid: event.event_uuid });
    }
  }
  return findings;
}

function parseArgs(argv) {
  const result = { snapshot: null, roots: ["src", "frontend", "scripts", "tests", ".github", "package.json"] };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--snapshot") result.snapshot = argv[++index];
    else if (argv[index] === "--source-root") result.roots.push(argv[++index]);
  }
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = readJson(REGISTRY_PATH);
  const callers = readJson(CALLERS_PATH);
  const findings = [
    ...validateRegistry(registry, callers),
    ...scanLegacyReferences(registry, args.roots),
    ...(args.snapshot ? evaluateSnapshot(readJson(path.resolve(ROOT, args.snapshot))) : [])
  ];
  const result = { ok: findings.length === 0, gate: "canonical-integrity-stage-32a-v1", findings };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

module.exports = { evaluateSnapshot, scanLegacyReferences, validateRegistry };
if (require.main === module) main();
