import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const fromRoot = (relative: string) => path.join(process.cwd(), relative);
const { evaluateSnapshot, scanLegacyReferences, validateRegistry } = require(fromRoot("scripts/base44_canonical_integrity_gate.cjs"));
const registry = require(fromRoot("config/base44-canonical-registry.json"));
const callers = require(fromRoot("config/base44-canonical-callers.json"));
const clean = require(fromRoot("tests/fixtures/base44_integrity_clean_snapshot.json"));

assert.deepEqual(validateRegistry(registry, callers), []);
assert.equal(registry.functions.length, 3);
assert.equal(registry.entities.length, 25);
assert.deepEqual(evaluateSnapshot(clean), []);

function expectCode(mutate: (snapshot: any) => void, code: string) {
  const snapshot = structuredClone(clean);
  mutate(snapshot);
  const findings = evaluateSnapshot(snapshot);
  assert.ok(findings.some((finding: any) => finding.code === code), `${code}: ${JSON.stringify(findings)}`);
}

expectCode((snapshot) => { snapshot.deals[0].reserved_units = 11; }, "reserved_units_exceed_max_units");
expectCode((snapshot) => { snapshot.inventory_projections[0].committed_units = 3; }, "inventory_projection_mismatch");
expectCode((snapshot) => {
  snapshot.outbox_events = [{
    event_uuid: "00000000-0000-4000-8000-000000000031",
    status: "processing",
    lease_expires_at: "2026-08-13T11:59:59.000Z"
  }];
}, "expired_processing_lease");
expectCode((snapshot) => { snapshot.dlq_records = []; }, "dead_letter_without_dlq");
expectCode((snapshot) => { snapshot.audits = []; }, "transition_without_audit");

const badCallers = structuredClone(callers);
badCallers.callers[registry.functions[0].legacy[0]] = ["base44/functions/example/entry.ts"];
assert.ok(validateRegistry(registry, badCallers).some((finding: any) => finding.code === "legacy_caller_target"));

const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "siton-legacy-gate-"));
try {
  const legacyName = registry.functions[0].legacy[0];
  fs.writeFileSync(
    path.join(fixtureDirectory, "caller.ts"),
    "base44.functions." + "invoke(" + JSON.stringify(legacyName) + ", {});\n",
    "utf8"
  );
  const sourceFindings = scanLegacyReferences(registry, [fixtureDirectory]);
  assert.ok(sourceFindings.some((finding: any) => finding.code === "legacy_function_reference" && finding.resource === legacyName));
} finally {
  fs.rmSync(fixtureDirectory, { recursive: true, force: true });
}

console.log("PASS Base44 canonical integrity gate rejects all six P0 drift classes and validates 25 entity pairs");
