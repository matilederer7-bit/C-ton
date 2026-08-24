const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const REGISTRY_PATH = path.join(ROOT, "config", "base44-canonical-registry.json");
const CALLERS_PATH = path.join(ROOT, "config", "base44-canonical-callers.json");
const RUNTIME_MANIFEST_PATH = path.join(ROOT, "base44", "runtime-manifest.json");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function canonicalResources(registry) {
  return new Set(registry.functions.map((entry) => entry.canonical));
}

const EXPECTED_MALL_FUNCTIONS = [
  "list-mall-deals",
  "record-mall-event",
  "siton-seller-bootstrap",
  "siton-seller-deal-image",
  "project-mall-deal"
];
const EXPECTED_MALL_ENTITIES = [
  "MallDealProjection",
  "DiscoveryEvent",
  "DealImage",
  "SellerIdentity"
];

function sameStringSet(actual, expected) {
  return actual.length === expected.length
    && new Set(actual).size === expected.length
    && expected.every((entry) => actual.includes(entry));
}

function validateRuntimeManifest(manifest) {
  const findings = [];
  const discovery = manifest?.public_discovery || {};
  if (manifest?.production_runtime !== "base44"
    || manifest?.canonical_data_store !== "base44_entities"
    || manifest?.legacy_runtime !== "render") {
    findings.push({ code: "invalid_base44_runtime_authority" });
  }
  if (manifest?.seller_identity_function !== "siton-seller-bootstrap"
    || manifest?.seller_image_function !== "siton-seller-deal-image") {
    findings.push({ code: "invalid_base44_seller_runtime" });
  }
  if (discovery.route !== "/app"
    || discovery.projection_entity !== "MallDealProjection"
    || discovery.list_function !== "list-mall-deals"
    || discovery.event_entity !== "DiscoveryEvent"
    || discovery.event_function !== "record-mall-event"
    || discovery.projection_function !== "project-mall-deal"
    || discovery.owns_state_or_money !== false
    || discovery.direct_links_first_class !== true) {
    findings.push({ code: "invalid_base44_mall_runtime" });
  }
  if (manifest?.publish_required !== true || manifest?.publish_performed !== false) {
    findings.push({ code: "invalid_base44_publish_boundary" });
  }
  return findings;
}

function validateMallExtension(registry, callers) {
  const findings = validateRuntimeManifest(readJson(RUNTIME_MANIFEST_PATH));
  const extension = registry.extensions?.mall_v1_1;
  const callerExtension = callers.extensions?.mall_v1_1;
  const functions = extension?.functions || [];
  const entities = extension?.entities || [];
  const functionNames = functions.map((entry) => entry.canonical);
  const entityNames = entities.map((entry) => entry.canonical);
  if (!sameStringSet(functionNames, EXPECTED_MALL_FUNCTIONS)) {
    findings.push({ code: "invalid_mall_function_registry", detail: functionNames });
  }
  if (!sameStringSet(entityNames, EXPECTED_MALL_ENTITIES)) {
    findings.push({ code: "invalid_mall_entity_registry", detail: entityNames });
  }
  if (extension?.authority !== "derived-read-identity-and-owner-media-only"
    || !Array.isArray(extension?.forbidden_authority)
    || !["deal_state", "buyer_state", "money", "payment", "payout", "commission"]
      .every((entry) => extension.forbidden_authority.includes(entry))) {
    findings.push({ code: "invalid_mall_authority_boundary" });
  }

  const classifiedFunctions = [
    ...(callerExtension?.public_entrypoints || []),
    ...(callerExtension?.authenticated_entrypoints || []),
    ...(callerExtension?.admin_projection_functions || [])
  ];
  if (!sameStringSet(classifiedFunctions, EXPECTED_MALL_FUNCTIONS)) {
    findings.push({ code: "invalid_mall_caller_classification", detail: classifiedFunctions });
  }

  for (const entity of entities) {
    const file = typeof entity.file === "string" ? path.resolve(ROOT, entity.file) : "";
    if (!file || !fs.existsSync(file)) {
      findings.push({ code: "missing_mall_entity_schema", entity: entity.canonical, file: entity.file || null });
      continue;
    }
    const schema = readJson(file);
    if (schema.name !== entity.canonical || schema.type !== "object" || !schema.rls) {
      findings.push({ code: "invalid_mall_entity_schema", entity: entity.canonical });
    }
  }
  for (const functionName of functionNames) {
    const configPath = path.join(ROOT, "base44", "functions", functionName, "function.jsonc");
    const entryPath = path.join(ROOT, "base44", "functions", functionName, "index.ts");
    if (!fs.existsSync(configPath) || !fs.existsSync(entryPath)) {
      findings.push({ code: "missing_mall_function_resource", function_name: functionName });
      continue;
    }
    const config = readJson(configPath);
    if (config.name !== functionName || config.entry !== "index.ts") {
      findings.push({ code: "invalid_mall_function_config", function_name: functionName });
    }
    if (functionName === "project-mall-deal") {
      const hooks = Array.isArray(config.automations) ? config.automations : [];
      const hookEntities = hooks.map((hook) => hook.entity_name);
      const exactEvents = hooks.every((hook) => hook.type === "entity"
        && hook.is_active === true
        && sameStringSet(hook.event_types || [], ["create", "update", "delete"]));
      if (!sameStringSet(hookEntities, ["Deal", "DealImage"]) || !exactEvents) {
        findings.push({ code: "invalid_mall_projection_automations", detail: hookEntities });
      }
    }
  }
  return findings;
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
  findings.push(...validateMallExtension(registry, callers));
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
  const forbiddenProjectionFields = new Set([
    "seller_id", "seller_user_id", "buyer_id", "buyer_name", "buyer_phone", "buyer_email",
    "delivery_address", "delivery_notes", "storage_key", "storage_object_ref", "payment_reference",
    "ledger_id", "auth_secret_hash", "payout_details_masked", "admin_note",
    "source_deal_record_id", "source_image_record_id", "published_sort_key"
  ]);
  const mallStatusByState = {
    PendingTarget: "underway",
    TargetReached: "reached_target",
    ClosedForJoining: "reached_target",
    ReadyForCharging: "reached_target",
    Charging: "reached_target",
    CompletionWindow: "reached_target",
    Completed: "succeeded",
    Failed: "failed",
    Cancelled: "cancelled"
  };
  for (const projection of snapshot.mall_projections || []) {
    const leaked = Object.keys(projection).find((field) => forbiddenProjectionFields.has(field));
    if (leaked) findings.push({ code: "mall_projection_private_field", deal_id: projection.deal_id, field: leaked });
    if (projection.visibility === "public"
      && (!projection.published_at || mallStatusByState[projection.canonical_state] !== projection.mall_status)) {
      findings.push({ code: "mall_projection_state_mismatch", deal_id: projection.deal_id });
    }
  }
  const forbiddenTelemetryFields = ["ip", "ip_address", "user_agent", "buyer_id", "email", "phone", "payment_reference"];
  for (const event of snapshot.discovery_events || []) {
    const leaked = forbiddenTelemetryFields.find((field) => Object.hasOwn(event, field));
    if (leaked) findings.push({ code: "discovery_event_pii_field", event_id: event.event_id, field: leaked });
  }
  return findings;
}

function parseArgs(argv) {
  const result = { snapshot: null, roots: ["src", "frontend", "base44", "scripts", "tests", ".github", "package.json"] };
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

module.exports = { evaluateSnapshot, scanLegacyReferences, validateMallExtension, validateRegistry, validateRuntimeManifest };
if (require.main === module) main();
