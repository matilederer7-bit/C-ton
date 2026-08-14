import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CANONICAL_INVENTORY_EVIDENCE_SOURCES,
  OperationalRepairError,
  applyOperationalRepair,
  buildOperationalRepairPlan,
  canonicalJson,
  deterministicAuditUuid,
  dryRunOperationalRepair,
  inspectOperationalRepair,
  stableSha256,
  validateOperationalRepairPlan,
  type AppliedRepairRecord,
  type ExistingTransitionAuditRecord,
  type OperationalRepairPlan,
  type OperationalRepairRepository,
  type OperationalRepairRequest,
  type OperationalRepairSnapshot,
  type OperationalRepairTransaction,
  type RepairMutationResult,
  type RepairReservation,
  type TransitionAuditBackfillSnapshot,
  type TransitionAuditInsertRecord
} from "../src/operational_repair.js";

const APPLY_ACTOR = "stage32b-test-operator";
let passed = 0;

async function run(name: string, test: () => void | Promise<void>) {
  await test();
  passed += 1;
  console.log(`PASS ${name}`);
}

function inventorySnapshot(expectedValues: number[] = [1, 1, 1, 1, 1]): OperationalRepairSnapshot {
  return {
    kind: "inventory_overage",
    deal_id: "deal-proof-1",
    max_units: 1,
    current_reserved_units: 2,
    canonical_projections: CANONICAL_INVENTORY_EVIDENCE_SOURCES.map((source, index) => ({
      source,
      expected_reserved_units: expectedValues[index] ?? expectedValues[0] ?? 0,
      evidence_ids: [`${source}:evidence:${index}`]
    }))
  };
}

function leaseSnapshot(overrides: Partial<Extract<OperationalRepairSnapshot, { kind: "expired_lease" }>> = {}): OperationalRepairSnapshot {
  return {
    kind: "expired_lease",
    event_uuid: "outbox-event-951",
    event_type: "deadline_check",
    status: "processing",
    worker_id: "worker-old",
    lease_generation: 7,
    claimed_at: "2026-08-14T08:58:00.000Z",
    lease_expires_at: "2026-08-14T09:00:00.000Z",
    processing_started_at: "2026-08-14T08:58:00.000Z",
    last_heartbeat_at: "2026-08-14T08:59:00.000Z",
    available_at: "2026-08-14T08:57:00.000Z",
    sent: false,
    sent_at: null,
    observed_at: "2026-08-14T09:05:00.000Z",
    owner_activity: "inactive",
    attempt_count: 1,
    max_attempts: 3,
    evidence_ids: ["outbox-row-951", "worker-heartbeat-old"],
    ...overrides
  };
}

function auditSnapshot(): TransitionAuditBackfillSnapshot {
  return {
    kind: "transition_audit_backfill",
    transition: {
      source_transition_id: "deal-902:transition:4",
      expected_audit_id: null,
      entity_type: "deal",
      entity_id: "deal-902",
      deal_id: "deal-902",
      state_type: "deal_state",
      from_state: "PendingTarget",
      to_state: "TargetReached",
      action_name: "deal.target_reached",
      request_id: "historical-request-902",
      idempotency_key: "historical-idempotency-902",
      occurred_at: "2026-08-10T12:00:00.000Z",
      evidence_ids: ["transition-journal:deal-902:4"]
    },
    existing_audits: []
  };
}

function auditEvidence(audit: TransitionAuditInsertRecord): ExistingTransitionAuditRecord {
  const { payload, ...core } = audit;
  return { ...core, payload_hash: stableSha256(payload) };
}

function key(request: OperationalRepairRequest) {
  return `${request.kind}:${request.target_id}`;
}

class MemoryRepository implements OperationalRepairRepository {
  snapshots = new Map<string, OperationalRepairSnapshot>();
  repairs = new Map<string, AppliedRepairRecord>();
  mutationCount = 0;
  transactionCount = 0;
  failAfterReservationOnce = false;
  returnNoopOnce = false;
  returnWrongPostconditionOnce = false;
  returnWrongAuditOnce = false;
  returnStaleLeaseEvidenceOnce = false;
  returnWrongLeaseClockOnce = false;
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(request: OperationalRepairRequest, snapshot: OperationalRepairSnapshot) {
    this.snapshots.set(key(request), structuredClone(snapshot));
  }

  setSnapshot(request: OperationalRepairRequest, snapshot: OperationalRepairSnapshot) {
    this.snapshots.set(key(request), structuredClone(snapshot));
  }

  async transaction<T>(work: (tx: OperationalRepairTransaction) => Promise<T>): Promise<T> {
    const predecessor = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      this.transactionCount += 1;
      const snapshots = structuredClone(this.snapshots);
      const repairs = structuredClone(this.repairs);
      let mutations = this.mutationCount;
      const tx: OperationalRepairTransaction = {
        findRepairByKey: async (repairKey) => structuredClone(repairs.get(repairKey) ?? null),
        loadSnapshot: async (request) => {
          const snapshot = snapshots.get(key(request));
          if (!snapshot) throw new Error("snapshot_not_found");
          return structuredClone(snapshot);
        },
        reserveRepair: async (record): Promise<RepairReservation> => {
          const existing = repairs.get(record.repair_key);
          if (existing) return { status: "existing", record: structuredClone(existing) };
          repairs.set(record.repair_key, structuredClone(record));
          return { status: "reserved" };
        },
        applyMutation: async (plan: OperationalRepairPlan): Promise<RepairMutationResult> => {
          if (this.failAfterReservationOnce) {
            this.failAfterReservationOnce = false;
            throw new Error("injected_after_reservation_failure");
          }
          const snapshot = snapshots.get(key(plan.request));
          const auditRecord = repairs.get(plan.repair_key);
          if (!snapshot || !plan.proposed_change || !auditRecord) throw new Error("mutation_target_missing");
          const mutation = plan.proposed_change;
          if (this.returnNoopOnce) {
            this.returnNoopOnce = false;
            return {
              status: "applied",
              affected_rows: 0,
              mutation_database_time: null,
              postcondition: structuredClone(snapshot),
              audit_record: structuredClone(auditRecord),
              evidence: { no_op: true }
            } as unknown as RepairMutationResult;
          }
          if (this.returnWrongPostconditionOnce) {
            this.returnWrongPostconditionOnce = false;
            return {
              status: "applied",
              affected_rows: 1,
              mutation_database_time: null,
              postcondition: structuredClone(snapshot),
              audit_record: structuredClone(auditRecord),
              evidence: { wrong_postcondition: true }
            };
          }
          if (mutation.operation === "inventory_set_reserved_units") {
            assert.equal(snapshot.kind, "inventory_overage");
            assert.equal(snapshot.deal_id, mutation.deal_id);
            assert.equal(snapshot.current_reserved_units, mutation.expected_current_reserved_units);
            assert.equal(snapshot.max_units, mutation.max_units);
            snapshot.current_reserved_units = mutation.next_reserved_units;
          } else if (mutation.operation === "outbox_reclaim_expired_lease") {
            assert.equal(snapshot.kind, "expired_lease");
            assert.equal(snapshot.event_uuid, mutation.event_uuid);
            assert.equal(snapshot.event_type, mutation.expected_event_type);
            assert.equal(snapshot.status, mutation.expected_status);
            assert.equal(snapshot.lease_generation, mutation.expected_lease_generation);
            assert.equal(snapshot.worker_id, mutation.expected_worker_id);
            assert.equal(snapshot.claimed_at, mutation.expected_claimed_at);
            assert.equal(snapshot.lease_expires_at, mutation.expected_lease_expires_at);
            assert.equal(snapshot.available_at, mutation.expected_available_at);
            assert.equal(snapshot.sent, mutation.expected_sent);
            assert.equal(snapshot.sent_at, mutation.expected_sent_at);
            snapshot.status = mutation.next_status;
            snapshot.worker_id = mutation.next_worker_id;
            snapshot.lease_generation = mutation.next_lease_generation;
            snapshot.claimed_at = mutation.next_claimed_at;
            snapshot.lease_expires_at = mutation.next_lease_expires_at;
            snapshot.processing_started_at = mutation.next_processing_started_at;
            snapshot.last_heartbeat_at = mutation.next_last_heartbeat_at;
            snapshot.available_at = snapshot.observed_at;
            snapshot.sent = mutation.next_sent;
            snapshot.sent_at = mutation.next_sent_at;
            if (this.returnStaleLeaseEvidenceOnce) {
              this.returnStaleLeaseEvidenceOnce = false;
              snapshot.claimed_at = mutation.expected_claimed_at;
            }
          } else {
            assert.equal(snapshot.kind, "transition_audit_backfill");
            assert.equal(snapshot.existing_audits.some((audit) => audit.audit_id === mutation.audit.audit_id), false);
            snapshot.existing_audits.push(auditEvidence(mutation.audit));
          }
          mutations += 1;
          const resultAudit = structuredClone(auditRecord);
          if (this.returnWrongAuditOnce) {
            this.returnWrongAuditOnce = false;
            resultAudit.metadata_hash = "0".repeat(64);
          }
          let mutationDatabaseTime: string | null = null;
          if (mutation.operation === "outbox_reclaim_expired_lease") {
            if (this.returnWrongLeaseClockOnce) {
              this.returnWrongLeaseClockOnce = false;
              mutationDatabaseTime = "2000-01-01T00:00:00.000Z";
            } else {
              mutationDatabaseTime = snapshot.kind === "expired_lease" ? snapshot.available_at : null;
            }
          }
          return {
            status: "applied",
            affected_rows: 1,
            mutation_database_time: mutationDatabaseTime,
            postcondition: structuredClone(snapshot),
            audit_record: resultAudit,
            evidence: { repair_key: plan.repair_key, operation: mutation.operation }
          };
        }
      };
      const result = await work(tx);
      this.snapshots = snapshots;
      this.repairs = repairs;
      this.mutationCount = mutations;
      return result;
    } finally {
      release();
    }
  }
}

async function expectOperationalError(action: () => Promise<unknown> | unknown, code: string) {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof OperationalRepairError, `expected OperationalRepairError, got ${String(caught)}`);
  assert.equal(caught.code, code);
}

await run("inspect and dry-run are deterministic, explicit and non-mutating", () => {
  const request = { kind: "inventory_overage", target_id: "deal-proof-1" } as const;
  const snapshot = inventorySnapshot();
  const before = structuredClone(snapshot);
  const inspected = inspectOperationalRepair(request, snapshot);
  const dryRun = dryRunOperationalRepair(request, snapshot);
  assert.equal(inspected.mutated, false);
  assert.equal(dryRun.mutated, false);
  assert.equal(inspected.plan.plan_hash, dryRun.plan.plan_hash);
  assert.equal(inspected.plan.snapshot_hash, dryRun.plan.snapshot_hash);
  assert.equal(inspected.plan.severity, "critical");
  assert.equal(inspected.plan.planned_audit?.action, "repair_inventory");
  assert.equal(inspected.plan.planned_audit?.actor_required_at_apply, true);
  assert.match(inspected.plan.planned_audit?.metadata.proposed_change_hash ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot, before);
});

await run("inventory requires the complete unique five-source allowlist", () => {
  const request = { kind: "inventory_overage", target_id: "deal-proof-1" } as const;
  const plan = buildOperationalRepairPlan(request, inventorySnapshot());
  assert.equal(plan.status, "repairable");
  assert.deepEqual(
    [...(plan.proposed_change?.operation === "inventory_set_reserved_units" ? plan.proposed_change.canonical_sources : [])].sort(),
    [...CANONICAL_INVENTORY_EVIDENCE_SOURCES].sort()
  );

  const missing = structuredClone(inventorySnapshot());
  if (missing.kind !== "inventory_overage") throw new Error("wrong fixture");
  missing.canonical_projections.pop();
  assert.equal(buildOperationalRepairPlan(request, missing).reason_code, "inventory_evidence_incomplete");

  const duplicate = structuredClone(inventorySnapshot());
  if (duplicate.kind !== "inventory_overage") throw new Error("wrong fixture");
  const firstProjection = duplicate.canonical_projections[0];
  if (!firstProjection) throw new Error("missing projection fixture");
  duplicate.canonical_projections[4] = structuredClone(firstProjection);
  assert.equal(buildOperationalRepairPlan(request, duplicate).reason_code, "inventory_evidence_source_duplicate");

  const unknown = structuredClone(inventorySnapshot());
  if (unknown.kind !== "inventory_overage") throw new Error("wrong fixture");
  (unknown.canonical_projections[0] as { source: string }).source = "arbitrary";
  assert.equal(buildOperationalRepairPlan(request, unknown).reason_code, "inventory_evidence_source_invalid");

  const noProof = structuredClone(inventorySnapshot());
  if (noProof.kind !== "inventory_overage") throw new Error("wrong fixture");
  const noProofProjection = noProof.canonical_projections[0];
  if (!noProofProjection) throw new Error("missing projection fixture");
  noProofProjection.evidence_ids = [];
  assert.equal(buildOperationalRepairPlan(request, noProof).reason_code, "inventory_evidence_missing");
});

await run("inventory agreement is deterministic and ambiguity fails closed", () => {
  const request = { kind: "inventory_overage", target_id: "deal-proof-1" } as const;
  const plan = buildOperationalRepairPlan(request, inventorySnapshot());
  assert.equal(plan.proposed_change?.operation, "inventory_set_reserved_units");
  if (plan.proposed_change?.operation !== "inventory_set_reserved_units") throw new Error("wrong mutation");
  assert.equal(plan.proposed_change.expected_current_reserved_units, 2);
  assert.equal(plan.proposed_change.next_reserved_units, 1);

  const reordered = structuredClone(inventorySnapshot());
  if (reordered.kind !== "inventory_overage") throw new Error("wrong fixture");
  reordered.canonical_projections.reverse();
  const reorderedPlan = buildOperationalRepairPlan(request, reordered);
  assert.equal(reorderedPlan.snapshot_hash, plan.snapshot_hash);
  assert.equal(reorderedPlan.plan_hash, plan.plan_hash);

  const ambiguous = buildOperationalRepairPlan(request, inventorySnapshot([1, 1, 1, 0, 1]));
  assert.equal(ambiguous.status, "blocked");
  assert.equal(ambiguous.reason_code, "inventory_evidence_ambiguous");
});

await run("legacy generation zero is fenced to generation one for an internal deadline event", () => {
  const request = { kind: "expired_lease", target_id: "outbox-event-951" } as const;
  const plan = buildOperationalRepairPlan(request, leaseSnapshot({ lease_generation: 0 }));
  assert.equal(plan.status, "repairable");
  assert.equal(plan.proposed_change?.operation, "outbox_reclaim_expired_lease");
  if (plan.proposed_change?.operation !== "outbox_reclaim_expired_lease") throw new Error("wrong mutation");
  assert.equal(plan.proposed_change.expected_lease_generation, 0);
  assert.equal(plan.proposed_change.next_lease_generation, 1);
  assert.equal(plan.proposed_change.next_worker_id, null);
  assert.equal(plan.proposed_change.next_claimed_at, null);
  assert.equal(plan.proposed_change.next_lease_expires_at, null);
  assert.equal(plan.proposed_change.next_sent, false);
  assert.equal(plan.proposed_change.next_sent_at, null);
});

await run("live charge-like lease is quarantined and never planned back to pending", () => {
  const request = { kind: "expired_lease", target_id: "outbox-event-951" } as const;
  const plan = buildOperationalRepairPlan(request, leaseSnapshot({ event_type: "charge_deal", lease_generation: 0 }));
  assert.equal(plan.status, "blocked");
  assert.equal(plan.safe_to_apply, false);
  assert.equal(plan.reason_code, "lease_event_type_requires_quarantine");
  assert.equal(plan.proposed_change, null);
});

await run("lease owner and evidence safety checks fail closed", () => {
  const request = { kind: "expired_lease", target_id: "outbox-event-951" } as const;
  assert.equal(
    buildOperationalRepairPlan(request, leaseSnapshot({ owner_activity: "active" })).reason_code,
    "lease_owner_still_active"
  );
  assert.equal(
    buildOperationalRepairPlan(request, leaseSnapshot({ evidence_ids: [] })).reason_code,
    "lease_evidence_missing"
  );
  assert.equal(
    buildOperationalRepairPlan(request, leaseSnapshot({ lease_expires_at: null })).reason_code,
    "lease_expiry_missing"
  );
  assert.equal(
    buildOperationalRepairPlan(request, leaseSnapshot({ sent: true })).reason_code,
    "lease_delivery_state_ambiguous"
  );
  assert.equal(
    buildOperationalRepairPlan(request, leaseSnapshot({ sent_at: "2026-08-14T09:01:00.000Z" })).reason_code,
    "lease_delivery_state_ambiguous"
  );
});

await run("audit backfill preserves canonical action, source time, hash and recovery metadata", () => {
  const request = { kind: "transition_audit_backfill", target_id: "deal-902:transition:4" } as const;
  const first = buildOperationalRepairPlan(request, auditSnapshot());
  const reordered = auditSnapshot();
  reordered.transition.evidence_ids.reverse();
  const second = buildOperationalRepairPlan(request, reordered);
  assert.equal(first.plan_hash, second.plan_hash);
  assert.equal(first.severity, "high");
  assert.equal(first.planned_audit?.action, "repair_audit_backfill");
  assert.equal(first.proposed_change?.operation, "audit_backfill_insert");
  if (first.proposed_change?.operation !== "audit_backfill_insert") throw new Error("wrong mutation");
  assert.equal(first.proposed_change.audit.audit_id, deterministicAuditUuid("deal-902:transition:4"));
  assert.equal(first.proposed_change.audit.action_name, "deal.target_reached");
  assert.equal(first.proposed_change.audit.payload.recovery_backfill, true);
  assert.equal(first.proposed_change.audit.payload.source_occurred_at, "2026-08-10T12:00:00.000Z");
  assert.match(String(first.proposed_change.audit.payload.source_evidence_hash), /^[a-f0-9]{64}$/);
});

await run("audit evidence, time, action and entity coherence fail closed", async () => {
  const request = { kind: "transition_audit_backfill", target_id: "deal-902:transition:4" } as const;
  const noEvidence = auditSnapshot();
  noEvidence.transition.evidence_ids = [];
  assert.equal(buildOperationalRepairPlan(request, noEvidence).reason_code, "audit_source_evidence_missing");

  const noTime = auditSnapshot();
  (noTime.transition as { occurred_at: string | null }).occurred_at = null;
  await expectOperationalError(() => buildOperationalRepairPlan(request, noTime), "repair_snapshot_invalid");

  const wrongAction = auditSnapshot();
  wrongAction.transition.action_name = "made.up.action";
  assert.equal(buildOperationalRepairPlan(request, wrongAction).reason_code, "audit_transition_not_canonical");

  const wrongEntity = auditSnapshot();
  wrongEntity.transition.entity_id = "different-deal";
  assert.equal(buildOperationalRepairPlan(request, wrongEntity).reason_code, "audit_transition_not_canonical");
});

await run("audit deterministic ID requires an exact payload hash match", () => {
  const request = { kind: "transition_audit_backfill", target_id: "deal-902:transition:4" } as const;
  const initial = buildOperationalRepairPlan(request, auditSnapshot());
  if (initial.proposed_change?.operation !== "audit_backfill_insert") throw new Error("wrong mutation");

  const exact = auditSnapshot();
  exact.existing_audits.push(auditEvidence(initial.proposed_change.audit));
  assert.equal(buildOperationalRepairPlan(request, exact).status, "already_satisfied");

  const collision = auditSnapshot();
  collision.existing_audits.push({
    ...auditEvidence(initial.proposed_change.audit),
    payload_hash: "0".repeat(64)
  });
  const blocked = buildOperationalRepairPlan(request, collision);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reason_code, "audit_backfill_id_collision");
});

await run("inspect output hashes existing audit payloads and drops raw payload fields", () => {
  const request = { kind: "transition_audit_backfill", target_id: "deal-902:transition:4" } as const;
  const snapshot = auditSnapshot() as TransitionAuditBackfillSnapshot & {
    existing_audits: Array<ExistingTransitionAuditRecord & { payload?: unknown }>;
  };
  snapshot.existing_audits.push({
    audit_id: "existing-audit",
    entity_type: "deal",
    entity_id: "deal-other",
    deal_id: "deal-other",
    state_type: "deal_state",
    from_state: "Draft",
    to_state: "PendingTarget",
    action_name: "deal.publish",
    request_id: "request-other",
    idempotency_key: "idem-other",
    payload_hash: stableSha256({ redacted: true }),
    payload: { payment_reference: "MUST_NOT_APPEAR" }
  });
  const output = JSON.stringify(inspectOperationalRepair(request, snapshot));
  assert.equal(output.includes("MUST_NOT_APPEAR"), false);
  assert.equal(output.includes("payload_hash"), true);
});

await run("canonical JSON covers __proto__ rather than colliding with an empty object", () => {
  const withPrototypeKey: Record<string, unknown> = {};
  Object.defineProperty(withPrototypeKey, "__proto__", { value: { guarded: true }, enumerable: true });
  assert.notEqual(stableSha256(withPrototypeKey), stableSha256({}));
  assert.equal(canonicalJson(withPrototypeKey), '{"__proto__":{"guarded":true}}');
});

await run("apply is transactional and sequential replay is idempotent with exact audit", async () => {
  const request = { kind: "transition_audit_backfill", target_id: "deal-902:transition:4" } as const;
  const snapshot = auditSnapshot();
  const repository = new MemoryRepository(request, snapshot);
  const plan = dryRunOperationalRepair(request, snapshot).plan;
  const first = await applyOperationalRepair(plan, repository, APPLY_ACTOR);
  const second = await applyOperationalRepair(plan, repository, "second-operator");
  assert.equal(first.status, "applied");
  assert.equal(first.mutated, true);
  assert.equal(second.status, "already_applied");
  assert.equal(second.mutated, false);
  assert.equal(repository.mutationCount, 1);
  const storedAudit = repository.repairs.get(plan.repair_key);
  assert.equal(storedAudit?.actor_id, APPLY_ACTOR);
  assert.equal(storedAudit?.metadata_hash, stableSha256(storedAudit?.metadata));
});

await run("twenty concurrent identical applies produce exactly one mutation", async () => {
  const request = { kind: "transition_audit_backfill", target_id: "deal-902:transition:4" } as const;
  const snapshot = auditSnapshot();
  const repository = new MemoryRepository(request, snapshot);
  const plan = dryRunOperationalRepair(request, snapshot).plan;
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) => applyOperationalRepair(plan, repository, `operator-${index}`))
  );
  assert.equal(results.filter((result) => result.status === "applied").length, 1);
  assert.equal(results.filter((result) => result.status === "already_applied").length, 19);
  assert.equal(repository.mutationCount, 1);
  assert.equal(repository.repairs.size, 1);
});

await run("failure after audit reservation rolls back and retry applies once", async () => {
  const request = { kind: "inventory_overage", target_id: "deal-proof-1" } as const;
  const snapshot = inventorySnapshot();
  const repository = new MemoryRepository(request, snapshot);
  repository.failAfterReservationOnce = true;
  const plan = dryRunOperationalRepair(request, snapshot).plan;
  await assert.rejects(() => applyOperationalRepair(plan, repository, APPLY_ACTOR), /injected_after_reservation_failure/);
  assert.equal(repository.repairs.size, 0);
  assert.equal(repository.mutationCount, 0);
  const retried = await applyOperationalRepair(plan, repository, APPLY_ACTOR);
  assert.equal(retried.status, "applied");
  assert.equal(repository.mutationCount, 1);
});

await run("conditional no-op, wrong postcondition and mismatched audit all roll back", async () => {
  const request = { kind: "inventory_overage", target_id: "deal-proof-1" } as const;
  const snapshot = inventorySnapshot();
  const noOpRepository = new MemoryRepository(request, snapshot);
  noOpRepository.returnNoopOnce = true;
  const plan = dryRunOperationalRepair(request, snapshot).plan;
  await expectOperationalError(
    () => applyOperationalRepair(plan, noOpRepository, APPLY_ACTOR),
    "repair_mutation_row_count_mismatch"
  );
  assert.equal(noOpRepository.repairs.size, 0);
  assert.equal(noOpRepository.mutationCount, 0);

  const wrongPostconditionRepository = new MemoryRepository(request, snapshot);
  wrongPostconditionRepository.returnWrongPostconditionOnce = true;
  await expectOperationalError(
    () => applyOperationalRepair(plan, wrongPostconditionRepository, APPLY_ACTOR),
    "repair_postcondition_failed"
  );
  assert.equal(wrongPostconditionRepository.repairs.size, 0);
  assert.equal(wrongPostconditionRepository.mutationCount, 0);

  const wrongAuditRepository = new MemoryRepository(request, snapshot);
  wrongAuditRepository.returnWrongAuditOnce = true;
  await expectOperationalError(
    () => applyOperationalRepair(plan, wrongAuditRepository, APPLY_ACTOR),
    "repair_audit_mismatch"
  );
  assert.equal(wrongAuditRepository.repairs.size, 0);
  assert.equal(wrongAuditRepository.mutationCount, 0);
});

await run("semantic lease fingerprint ignores only a fresh observation timestamp", async () => {
  const request = { kind: "expired_lease", target_id: "outbox-event-951" } as const;
  const original = leaseSnapshot({ lease_generation: 0 });
  const repository = new MemoryRepository(request, original);
  const plan = dryRunOperationalRepair(request, original).plan;
  const refreshedObservation = leaseSnapshot({
    lease_generation: 0,
    observed_at: "2026-08-14T09:06:00.000Z"
  });
  const refreshedPlan = dryRunOperationalRepair(request, refreshedObservation).plan;
  assert.equal(refreshedPlan.snapshot_hash, plan.snapshot_hash);
  assert.equal(refreshedPlan.semantic_fingerprint, plan.semantic_fingerprint);
  assert.equal(refreshedPlan.plan_hash, plan.plan_hash);
  repository.setSnapshot(request, refreshedObservation);
  const result = await applyOperationalRepair(plan, repository, APPLY_ACTOR);
  assert.equal(result.status, "applied");
  const stored = repository.snapshots.get(key(request));
  assert.equal(stored?.kind, "expired_lease");
  if (stored?.kind !== "expired_lease") throw new Error("wrong stored snapshot");
  assert.equal(stored.lease_generation, 1);
  assert.equal(stored.status, "pending");
});

await run("semantic source drift between dry-run and apply blocks before mutation", async () => {
  const request = { kind: "inventory_overage", target_id: "deal-proof-1" } as const;
  const original = inventorySnapshot();
  const repository = new MemoryRepository(request, original);
  const plan = dryRunOperationalRepair(request, original).plan;
  const drifted = structuredClone(original);
  if (drifted.kind !== "inventory_overage") throw new Error("wrong fixture");
  drifted.current_reserved_units = 3;
  repository.setSnapshot(request, drifted);
  await expectOperationalError(
    () => applyOperationalRepair(plan, repository, APPLY_ACTOR),
    "repair_precondition_drift"
  );
  assert.equal(repository.mutationCount, 0);
  assert.equal(repository.repairs.size, 0);
});

await run("lease apply rejects stale claim evidence and a non-exact DB mutation time", async () => {
  const request = { kind: "expired_lease", target_id: "outbox-event-951" } as const;
  const snapshot = leaseSnapshot({ lease_generation: 0 });
  const plan = dryRunOperationalRepair(request, snapshot).plan;

  const staleEvidence = new MemoryRepository(request, snapshot);
  staleEvidence.returnStaleLeaseEvidenceOnce = true;
  await expectOperationalError(
    () => applyOperationalRepair(plan, staleEvidence, APPLY_ACTOR),
    "repair_postcondition_failed"
  );
  assert.equal(staleEvidence.repairs.size, 0);
  assert.equal(staleEvidence.mutationCount, 0);

  const wrongClock = new MemoryRepository(request, snapshot);
  wrongClock.returnWrongLeaseClockOnce = true;
  await expectOperationalError(
    () => applyOperationalRepair(plan, wrongClock, APPLY_ACTOR),
    "repair_postcondition_failed"
  );
  assert.equal(wrongClock.repairs.size, 0);
  assert.equal(wrongClock.mutationCount, 0);
});

await run("tampered plans fail validation before a repository transaction", async () => {
  const request = { kind: "inventory_overage", target_id: "deal-proof-1" } as const;
  const snapshot = inventorySnapshot();
  const repository = new MemoryRepository(request, snapshot);
  const plan = dryRunOperationalRepair(request, snapshot).plan;
  const hashTampered = structuredClone(plan);
  hashTampered.expected_state = { reserved_units: 0 };
  await expectOperationalError(
    () => applyOperationalRepair(hashTampered, repository, APPLY_ACTOR),
    "repair_plan_hash_mismatch"
  );

  const selfHashedTamper = structuredClone(plan);
  selfHashedTamper.expected_state = { reserved_units: 0 };
  const { plan_hash: _oldHash, ...unsigned } = selfHashedTamper;
  selfHashedTamper.plan_hash = stableSha256(unsigned);
  await expectOperationalError(
    () => validateOperationalRepairPlan(selfHashedTamper),
    "repair_plan_semantic_mismatch"
  );
  assert.equal(repository.mutationCount, 0);
  assert.equal(repository.repairs.size, 0);
  assert.equal(repository.transactionCount, 0);
});

await run("CLI rejects blocked or non-actionable plans before loading adapter code", () => {
  const cliSource = readFileSync("src/operational_repair_cli.ts", "utf8");
  const validation = cliSource.indexOf("validateOperationalRepairPlan(plan)");
  const blockedGuard = cliSource.indexOf('if (plan.status === "blocked")');
  const actionableGuard = cliSource.indexOf('if (plan.status !== "repairable" || !plan.proposed_change)');
  const adapterLoad = cliSource.indexOf("const repository = await loadRepository(args.repositoryModule)");
  assert.ok(validation >= 0);
  assert.ok(blockedGuard > validation);
  assert.ok(actionableGuard > blockedGuard);
  assert.ok(adapterLoad > actionableGuard);
});

await run("wildcard, mismatched targets and missing actor are rejected", async () => {
  await expectOperationalError(
    () => buildOperationalRepairPlan({ kind: "inventory_overage", target_id: "*" }, inventorySnapshot()),
    "explicit_target_id_required"
  );
  await expectOperationalError(
    () => buildOperationalRepairPlan({ kind: "inventory_overage", target_id: "different-deal" }, inventorySnapshot()),
    "repair_target_mismatch"
  );
  const request = { kind: "inventory_overage", target_id: "deal-proof-1" } as const;
  const snapshot = inventorySnapshot();
  const repository = new MemoryRepository(request, snapshot);
  const plan = dryRunOperationalRepair(request, snapshot).plan;
  await expectOperationalError(() => applyOperationalRepair(plan, repository, ""), "explicit_target_id_required");
  assert.equal(repository.mutationCount, 0);
});

console.log(`PASS operational repair validation ${passed}/${passed}`);
