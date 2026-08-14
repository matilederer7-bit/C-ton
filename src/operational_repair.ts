import { createHash } from "node:crypto";

export const OPERATIONAL_REPAIR_SCHEMA_VERSION = "stage-32b-operational-repair-v1" as const;

export const CANONICAL_INVENTORY_EVIDENCE_SOURCES = [
  "canonical_availability",
  "canonical_reservations",
  "canonical_commits",
  "canonical_releases",
  "canonical_ledger"
] as const;

export type CanonicalInventoryEvidenceSource = typeof CANONICAL_INVENTORY_EVIDENCE_SOURCES[number];

export type OperationalRepairKind =
  | "inventory_overage"
  | "expired_lease"
  | "transition_audit_backfill";

export type OperationalRepairRequest = {
  kind: OperationalRepairKind;
  target_id: string;
};

export type InventoryProjectionEvidence = {
  source: CanonicalInventoryEvidenceSource;
  expected_reserved_units: number;
  evidence_ids: string[];
};

export type InventoryOverageSnapshot = {
  kind: "inventory_overage";
  deal_id: string;
  max_units: number;
  current_reserved_units: number;
  canonical_projections: InventoryProjectionEvidence[];
};

export type LeaseOwnerActivity = "active" | "inactive" | "unknown";

export type ExpiredLeaseSnapshot = {
  kind: "expired_lease";
  event_uuid: string;
  event_type: string;
  status: string;
  worker_id: string | null;
  lease_generation: number;
  claimed_at: string | null;
  lease_expires_at: string | null;
  processing_started_at: string | null;
  last_heartbeat_at: string | null;
  available_at: string | null;
  sent: boolean;
  sent_at: string | null;
  observed_at: string;
  owner_activity: LeaseOwnerActivity;
  attempt_count: number;
  max_attempts: number;
  evidence_ids: string[];
};

export type TransitionEvidence = {
  source_transition_id: string;
  expected_audit_id: string | null;
  entity_type: "deal" | "participant";
  entity_id: string;
  deal_id: string;
  state_type: "deal_state" | "buyer_state" | "money_state";
  from_state: string;
  to_state: string;
  action_name: string;
  request_id: string;
  idempotency_key: string;
  occurred_at: string;
  evidence_ids: string[];
};

export type ExistingTransitionAuditRecord = {
  audit_id: string;
  entity_type: "deal" | "participant";
  entity_id: string;
  deal_id: string;
  state_type: "deal_state" | "buyer_state" | "money_state";
  from_state: string;
  to_state: string;
  action_name: string;
  request_id: string;
  idempotency_key: string;
  payload_hash: string;
};

export type TransitionAuditInsertRecord = Omit<ExistingTransitionAuditRecord, "payload_hash"> & {
  payload: Record<string, unknown>;
};

export type TransitionAuditBackfillSnapshot = {
  kind: "transition_audit_backfill";
  transition: TransitionEvidence;
  existing_audits: ExistingTransitionAuditRecord[];
};

export type OperationalRepairSnapshot =
  | InventoryOverageSnapshot
  | ExpiredLeaseSnapshot
  | TransitionAuditBackfillSnapshot;

export type InventoryRepairMutation = {
  operation: "inventory_set_reserved_units";
  deal_id: string;
  expected_current_reserved_units: number;
  next_reserved_units: number;
  max_units: number;
  canonical_sources: CanonicalInventoryEvidenceSource[];
};

export type LeaseRepairMutation = {
  operation: "outbox_reclaim_expired_lease";
  event_uuid: string;
  expected_event_type: "deadline_check";
  expected_status: "processing";
  expected_worker_id: string | null;
  expected_lease_generation: number;
  next_lease_generation: number;
  expected_claimed_at: string | null;
  expected_lease_expires_at: string | null;
  expected_available_at: string | null;
  expected_sent: false;
  expected_sent_at: null;
  next_status: "pending";
  next_worker_id: null;
  next_claimed_at: null;
  next_lease_expires_at: null;
  next_processing_started_at: null;
  next_last_heartbeat_at: null;
  next_available_at: "database_now";
  next_sent: false;
  next_sent_at: null;
};

export type AuditBackfillMutation = {
  operation: "audit_backfill_insert";
  source_transition_id: string;
  audit: TransitionAuditInsertRecord;
};

export type OperationalRepairMutation =
  | InventoryRepairMutation
  | LeaseRepairMutation
  | AuditBackfillMutation;

export type RepairPlanStatus = "repairable" | "already_satisfied" | "blocked";
export type OperationalRepairSeverity = "critical" | "high";

export type PlannedRecoveryAuditMetadata = {
  schema_version: typeof OPERATIONAL_REPAIR_SCHEMA_VERSION;
  kind: OperationalRepairKind;
  target_id: string;
  snapshot_hash: string;
  current_state_hash: string;
  expected_state_hash: string;
  proposed_change_hash: string;
  preconditions_hash: string;
};

export type PlannedRecoveryAudit = {
  subject_type: "outbox_event" | "inventory" | "deal_audit";
  subject_id: string;
  action: "repair_inventory" | "repair_lease" | "repair_audit_backfill";
  idempotency_key: string;
  reason_code: "stage32b_controlled_repair";
  actor_id: null;
  actor_required_at_apply: true;
  metadata: PlannedRecoveryAuditMetadata;
};

export type RepairPrecondition = {
  field: string;
  expected: unknown;
};

export type OperationalRepairPlan = {
  schema_version: typeof OPERATIONAL_REPAIR_SCHEMA_VERSION;
  request: OperationalRepairRequest;
  severity: OperationalRepairSeverity;
  status: RepairPlanStatus;
  safe_to_apply: boolean;
  reason_code: string | null;
  snapshot: OperationalRepairSnapshot;
  snapshot_hash: string;
  semantic_fingerprint: string;
  repair_key: string;
  current_state: unknown;
  expected_state: unknown;
  proposed_change: OperationalRepairMutation | null;
  planned_audit: PlannedRecoveryAudit | null;
  preconditions: RepairPrecondition[];
  plan_hash: string;
};

export type OperationalRepairPreview = {
  mode: "inspect" | "dry-run";
  mutated: false;
  plan: OperationalRepairPlan;
};

export type AppliedRepairRecord = {
  repair_key: string;
  plan_hash: string;
  snapshot_hash: string;
  semantic_fingerprint: string;
  kind: OperationalRepairKind;
  target_id: string;
  audit_action: "repair_inventory" | "repair_lease" | "repair_audit_backfill";
  audit_subject_type: "outbox_event" | "inventory" | "deal_audit";
  audit_subject_id: string;
  audit_idempotency_key: string;
  reason_code: "stage32b_controlled_repair";
  actor_id: string;
  metadata: PlannedRecoveryAuditMetadata;
  metadata_hash: string;
};

export type RepairReservation =
  | { status: "reserved" }
  | { status: "existing"; record: AppliedRepairRecord };

export type RepairMutationResult = {
  status: "applied";
  affected_rows: 1;
  /** Exact DB timestamp returned by the conditional mutation; required for lease repair. */
  mutation_database_time: string | null;
  postcondition: OperationalRepairSnapshot;
  audit_record: AppliedRepairRecord;
  evidence: unknown;
};

/**
 * All methods are invoked inside one repository transaction. Implementations
 * must make reserveRepair unique by repair_key and applyMutation conditional on
 * every precondition carried by the plan. applyMutation must report exactly one
 * affected row plus the exact persisted Audit and postcondition snapshot. A
 * thrown error must roll back the reservation, mutation, and Audit together.
 */
export interface OperationalRepairTransaction {
  findRepairByKey(repairKey: string): Promise<AppliedRepairRecord | null>;
  loadSnapshot(request: OperationalRepairRequest): Promise<OperationalRepairSnapshot>;
  reserveRepair(record: AppliedRepairRecord): Promise<RepairReservation>;
  applyMutation(plan: OperationalRepairPlan): Promise<RepairMutationResult>;
}

export interface OperationalRepairRepository {
  transaction<T>(work: (tx: OperationalRepairTransaction) => Promise<T>): Promise<T>;
}

export type OperationalRepairApplyResult = {
  mode: "apply";
  status: "applied" | "already_applied";
  mutated: boolean;
  repair_key: string;
  plan_hash: string;
  evidence_hash: string | null;
};

export class OperationalRepairError extends Error {
  readonly code: string;
  readonly context: Record<string, unknown>;

  constructor(code: string, context: Record<string, unknown> = {}) {
    super(code);
    this.name = "OperationalRepairError";
    this.code = code;
    this.context = context;
  }
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new OperationalRepairError("non_finite_canonical_number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new OperationalRepairError("invalid_canonical_date");
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item === undefined) throw new OperationalRepairError("undefined_canonical_array_value");
      return canonicalValue(item);
    });
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) result[key] = canonicalValue(item);
    }
    return result;
  }
  throw new OperationalRepairError("unsupported_canonical_value", { type: typeof value });
}

export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalValue(value));
  if (serialized === undefined) throw new OperationalRepairError("undefined_canonical_root");
  return serialized;
}

export function stableSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function deterministicAuditUuid(sourceTransitionId: string): string {
  const target = explicitIdentifier(sourceTransitionId, "source_transition_id");
  const hex = createHash("sha256")
    .update(`siton:stage32b:recovery_backfill:v1:${target}`, "utf8")
    .digest("hex");
  const versioned = `${hex.slice(0, 12)}8${hex.slice(13)}`;
  const variant = ((Number.parseInt(versioned[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const uuidHex = `${versioned.slice(0, 16)}${variant}${versioned.slice(17, 32)}`;
  return `${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-${uuidHex.slice(12, 16)}-${uuidHex.slice(16, 20)}-${uuidHex.slice(20, 32)}`;
}

function explicitIdentifier(value: unknown, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized === "*" || /^all$/i.test(normalized) || /[*?]/.test(normalized)) {
    throw new OperationalRepairError("explicit_target_id_required", { field });
  }
  return normalized;
}

export function validateOperationalRepairActorId(value: unknown): string {
  return explicitIdentifier(value, "actor_id");
}

function text(value: unknown, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new OperationalRepairError("repair_snapshot_invalid", { field });
  return normalized;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new OperationalRepairError("repair_snapshot_invalid", { field, value });
  }
  return normalized;
}

function positiveInteger(value: unknown, field: string): number {
  const normalized = nonNegativeInteger(value, field);
  if (normalized === 0) throw new OperationalRepairError("repair_snapshot_invalid", { field, value });
  return normalized;
}

function strictBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new OperationalRepairError("repair_snapshot_invalid", { field });
  }
  return value;
}

function isoInstant(value: unknown, field: string): string {
  const milliseconds = Date.parse(String(value ?? ""));
  if (!Number.isFinite(milliseconds)) throw new OperationalRepairError("repair_snapshot_invalid", { field });
  return new Date(milliseconds).toISOString();
}

function isoInstantOrNull(value: unknown, field: string): string | null {
  return value === null ? null : isoInstant(value, field);
}

function sha256Text(value: unknown, field: string): string {
  const normalized = text(value, field).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new OperationalRepairError("repair_snapshot_invalid", { field });
  }
  return normalized;
}

function evidenceIds(values: unknown, field: string): string[] {
  if (!Array.isArray(values)) throw new OperationalRepairError("repair_snapshot_invalid", { field });
  return [...new Set(values.map((value) => text(value, field)))].sort();
}

function lexicalCompare(left: unknown, right: unknown): number {
  const leftJson = canonicalJson(left);
  const rightJson = canonicalJson(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

function normalizeRequest(request: OperationalRepairRequest): OperationalRepairRequest {
  if (!["inventory_overage", "expired_lease", "transition_audit_backfill"].includes(request.kind)) {
    throw new OperationalRepairError("unsupported_repair_kind", { kind: request.kind });
  }
  return { kind: request.kind, target_id: explicitIdentifier(request.target_id, "target_id") };
}

function canonicalTransitionKey(
  actionName: string,
  entityType: "deal" | "participant",
  stateType: "deal_state" | "buyer_state" | "money_state",
  fromState: string,
  toState: string
): string {
  return [actionName, entityType, stateType, fromState, toState].join("|");
}

const CANONICAL_ACTION_TRANSITIONS = new Set([
  canonicalTransitionKey("participant.join_authorize", "participant", "buyer_state", "NotJoined", "JoinedAuthorized"),
  canonicalTransitionKey("participant.join_authorize", "participant", "money_state", "NoFinancial", "AuthHeld"),
  canonicalTransitionKey("deal.publish", "deal", "deal_state", "Draft", "PendingTarget"),
  canonicalTransitionKey("deal.target_reached", "deal", "deal_state", "PendingTarget", "TargetReached"),
  canonicalTransitionKey("deal.close_joining", "deal", "deal_state", "TargetReached", "ClosedForJoining"),
  canonicalTransitionKey("deal.prepare_charging", "deal", "deal_state", "ClosedForJoining", "ReadyForCharging"),
  canonicalTransitionKey("deal.prepare_charging", "participant", "buyer_state", "JoinedAuthorized", "LockedIn"),
  canonicalTransitionKey("deal.prepare_charging", "participant", "money_state", "AuthHeld", "AuthLocked"),
  canonicalTransitionKey("charging.start", "deal", "deal_state", "ReadyForCharging", "Charging"),
  canonicalTransitionKey("charging.start", "participant", "buyer_state", "LockedIn", "ChargingAttempt"),
  canonicalTransitionKey("charging.start", "participant", "money_state", "AuthLocked", "ChargeAttempt"),
  canonicalTransitionKey("charging.capture_success", "participant", "buyer_state", "ChargingAttempt", "ChargedSuccess"),
  canonicalTransitionKey("charging.capture_success", "participant", "money_state", "ChargeAttempt", "ChargedSuccess"),
  canonicalTransitionKey("charging.capture_failed", "participant", "buyer_state", "ChargingAttempt", "ChargeFailedCompletion"),
  canonicalTransitionKey("charging.capture_failed", "participant", "money_state", "ChargeAttempt", "ChargeFailedRecovery"),
  canonicalTransitionKey("charging.recovery_success", "participant", "buyer_state", "ChargeFailedCompletion", "Recovered"),
  canonicalTransitionKey("charging.recovery_success", "participant", "money_state", "ChargeFailedRecovery", "RecoveredCharge"),
  canonicalTransitionKey("charging.recovery_failed", "participant", "buyer_state", "ChargeFailedCompletion", "Dropped"),
  canonicalTransitionKey("charging.recovery_failed", "participant", "money_state", "ChargeFailedRecovery", "AuthReleased"),
  canonicalTransitionKey("charging.to_completion_window", "deal", "deal_state", "Charging", "CompletionWindow"),
  canonicalTransitionKey("charging.finalize_completed", "deal", "deal_state", "CompletionWindow", "Completed"),
  canonicalTransitionKey("charging.finalize_failed", "deal", "deal_state", "CompletionWindow", "Failed"),
  canonicalTransitionKey("deal.complete_participant", "participant", "buyer_state", "ChargedSuccess", "DealCompleted"),
  canonicalTransitionKey("deal.complete_participant", "participant", "buyer_state", "Recovered", "DealCompleted"),
  canonicalTransitionKey("deal.deadline_check", "deal", "deal_state", "PendingTarget", "Failed"),
  canonicalTransitionKey("deal.cancel", "deal", "deal_state", "Draft", "Cancelled"),
  canonicalTransitionKey("refund.issue", "participant", "money_state", "ChargedSuccess", "Refunded"),
  canonicalTransitionKey("refund.issue", "participant", "money_state", "RecoveredCharge", "Refunded")
]);

for (const actionName of ["deal.fail_participant", "deal.fail_participant_after_completed"]) {
  for (const fromState of [
    "NotJoined",
    "JoinedAuthorized",
    "LockedIn",
    "ChargingAttempt",
    "ChargeFailedCompletion",
    "ChargedSuccess",
    "Recovered",
    "Dropped"
  ]) {
    CANONICAL_ACTION_TRANSITIONS.add(
      canonicalTransitionKey(actionName, "participant", "buyer_state", fromState, "DealFailed")
    );
  }
}

function isCanonicalActionTransition(transition: TransitionEvidence): boolean {
  if (transition.entity_type === "deal" && transition.entity_id !== transition.deal_id) return false;
  return CANONICAL_ACTION_TRANSITIONS.has(canonicalTransitionKey(
    transition.action_name,
    transition.entity_type,
    transition.state_type,
    transition.from_state,
    transition.to_state
  ));
}

function normalizeInventorySnapshot(snapshot: InventoryOverageSnapshot): InventoryOverageSnapshot {
  const projections = snapshot.canonical_projections.map((projection) => ({
    source: text(projection.source, "canonical_projections.source") as CanonicalInventoryEvidenceSource,
    expected_reserved_units: nonNegativeInteger(
      projection.expected_reserved_units,
      "canonical_projections.expected_reserved_units"
    ),
    evidence_ids: evidenceIds(projection.evidence_ids, "canonical_projections.evidence_ids")
  })).sort(lexicalCompare);
  return {
    kind: "inventory_overage",
    deal_id: explicitIdentifier(snapshot.deal_id, "deal_id"),
    max_units: nonNegativeInteger(snapshot.max_units, "max_units"),
    current_reserved_units: nonNegativeInteger(snapshot.current_reserved_units, "current_reserved_units"),
    canonical_projections: projections
  };
}

function normalizeLeaseSnapshot(snapshot: ExpiredLeaseSnapshot): ExpiredLeaseSnapshot {
  if (!["active", "inactive", "unknown"].includes(snapshot.owner_activity)) {
    throw new OperationalRepairError("repair_snapshot_invalid", { field: "owner_activity" });
  }
  return {
    kind: "expired_lease",
    event_uuid: explicitIdentifier(snapshot.event_uuid, "event_uuid"),
    event_type: text(snapshot.event_type, "event_type"),
    status: text(snapshot.status, "status"),
    worker_id: snapshot.worker_id === null ? null : text(snapshot.worker_id, "worker_id"),
    lease_generation: nonNegativeInteger(snapshot.lease_generation, "lease_generation"),
    claimed_at: isoInstantOrNull(snapshot.claimed_at, "claimed_at"),
    lease_expires_at: isoInstantOrNull(snapshot.lease_expires_at, "lease_expires_at"),
    processing_started_at: isoInstantOrNull(snapshot.processing_started_at, "processing_started_at"),
    last_heartbeat_at: isoInstantOrNull(snapshot.last_heartbeat_at, "last_heartbeat_at"),
    available_at: isoInstantOrNull(snapshot.available_at, "available_at"),
    sent: strictBoolean(snapshot.sent, "sent"),
    sent_at: isoInstantOrNull(snapshot.sent_at, "sent_at"),
    observed_at: isoInstant(snapshot.observed_at, "observed_at"),
    owner_activity: snapshot.owner_activity,
    attempt_count: nonNegativeInteger(snapshot.attempt_count, "attempt_count"),
    max_attempts: positiveInteger(snapshot.max_attempts, "max_attempts"),
    evidence_ids: evidenceIds(snapshot.evidence_ids, "evidence_ids")
  };
}

function normalizeTransition(transition: TransitionEvidence): TransitionEvidence {
  if (!["deal", "participant"].includes(String(transition.entity_type))) {
    throw new OperationalRepairError("repair_snapshot_invalid", { field: "entity_type" });
  }
  if (!["deal_state", "buyer_state", "money_state"].includes(String(transition.state_type))) {
    throw new OperationalRepairError("repair_snapshot_invalid", { field: "state_type" });
  }
  if (transition.entity_type === "deal" && transition.state_type !== "deal_state") {
    throw new OperationalRepairError("repair_snapshot_invalid", { field: "state_type" });
  }
  if (transition.entity_type === "participant" && !["buyer_state", "money_state"].includes(transition.state_type)) {
    throw new OperationalRepairError("repair_snapshot_invalid", { field: "state_type" });
  }
  const fromState = text(transition.from_state, "from_state");
  const toState = text(transition.to_state, "to_state");
  if (fromState === toState) throw new OperationalRepairError("repair_snapshot_invalid", { field: "transition" });
  return {
    source_transition_id: explicitIdentifier(transition.source_transition_id, "source_transition_id"),
    expected_audit_id: transition.expected_audit_id === null
      ? null
      : explicitIdentifier(transition.expected_audit_id, "expected_audit_id"),
    entity_type: transition.entity_type,
    entity_id: explicitIdentifier(transition.entity_id, "entity_id"),
    deal_id: explicitIdentifier(transition.deal_id, "deal_id"),
    state_type: transition.state_type,
    from_state: fromState,
    to_state: toState,
    action_name: text(transition.action_name, "action_name"),
    request_id: text(transition.request_id, "request_id"),
    idempotency_key: text(transition.idempotency_key, "idempotency_key"),
    occurred_at: isoInstant(transition.occurred_at, "occurred_at"),
    evidence_ids: evidenceIds(transition.evidence_ids, "transition.evidence_ids")
  };
}

function normalizeAudit(audit: ExistingTransitionAuditRecord): ExistingTransitionAuditRecord {
  return {
    audit_id: explicitIdentifier(audit.audit_id, "audit_id"),
    entity_type: audit.entity_type,
    entity_id: explicitIdentifier(audit.entity_id, "audit.entity_id"),
    deal_id: explicitIdentifier(audit.deal_id, "audit.deal_id"),
    state_type: audit.state_type,
    from_state: text(audit.from_state, "audit.from_state"),
    to_state: text(audit.to_state, "audit.to_state"),
    action_name: text(audit.action_name, "audit.action_name"),
    request_id: text(audit.request_id, "audit.request_id"),
    idempotency_key: text(audit.idempotency_key, "audit.idempotency_key"),
    payload_hash: sha256Text(audit.payload_hash, "audit.payload_hash")
  };
}

function normalizeAuditSnapshot(snapshot: TransitionAuditBackfillSnapshot): TransitionAuditBackfillSnapshot {
  return {
    kind: "transition_audit_backfill",
    transition: normalizeTransition(snapshot.transition),
    existing_audits: snapshot.existing_audits
      .map(normalizeAudit)
      .sort(lexicalCompare)
  };
}

function normalizeSnapshot(snapshot: OperationalRepairSnapshot): OperationalRepairSnapshot {
  if (snapshot.kind === "inventory_overage") return normalizeInventorySnapshot(snapshot);
  if (snapshot.kind === "expired_lease") return normalizeLeaseSnapshot(snapshot);
  if (snapshot.kind === "transition_audit_backfill") return normalizeAuditSnapshot(snapshot);
  throw new OperationalRepairError("unsupported_repair_snapshot");
}

function planWithoutHash(plan: OperationalRepairPlan): Omit<OperationalRepairPlan, "plan_hash"> {
  const { plan_hash: _ignored, ...unsigned } = plan;
  return unsigned;
}

function semanticSnapshotValue(snapshot: OperationalRepairSnapshot): unknown {
  if (snapshot.kind !== "expired_lease") return snapshot;
  const { observed_at: _observationTime, ...semanticLease } = snapshot;
  return semanticLease;
}

function planIntegrityValue(plan: Omit<OperationalRepairPlan, "plan_hash">): unknown {
  return {
    ...plan,
    snapshot: semanticSnapshotValue(plan.snapshot)
  };
}

function severityForKind(kind: OperationalRepairKind): OperationalRepairSeverity {
  return kind === "transition_audit_backfill" ? "high" : "critical";
}

function recoveryAuditIdentity(kind: OperationalRepairKind): Pick<PlannedRecoveryAudit, "subject_type" | "action"> {
  if (kind === "inventory_overage") return { subject_type: "inventory", action: "repair_inventory" };
  if (kind === "expired_lease") return { subject_type: "outbox_event", action: "repair_lease" };
  return { subject_type: "deal_audit", action: "repair_audit_backfill" };
}

function finishPlan(args: {
  request: OperationalRepairRequest;
  snapshot: OperationalRepairSnapshot;
  status: RepairPlanStatus;
  reasonCode: string | null;
  currentState: unknown;
  expectedState: unknown;
  proposedChange: OperationalRepairMutation | null;
  preconditions: RepairPrecondition[];
}): OperationalRepairPlan {
  const snapshotHash = stableSha256(semanticSnapshotValue(args.snapshot));
  const actionHash = stableSha256({
    schema_version: OPERATIONAL_REPAIR_SCHEMA_VERSION,
    request: args.request,
    snapshot_hash: snapshotHash,
    status: args.status,
    reason_code: args.reasonCode,
    proposed_change: args.proposedChange
  });
  const repairKey = `stage32b:${args.request.kind}:${args.request.target_id}:${actionHash.slice(0, 32)}`;
  const auditIdentity = recoveryAuditIdentity(args.request.kind);
  const plannedAudit: PlannedRecoveryAudit | null = args.status === "repairable" && args.proposedChange
    ? {
        subject_type: auditIdentity.subject_type,
        subject_id: args.request.target_id,
        action: auditIdentity.action,
        idempotency_key: repairKey,
        reason_code: "stage32b_controlled_repair",
        actor_id: null,
        actor_required_at_apply: true,
        metadata: {
          schema_version: OPERATIONAL_REPAIR_SCHEMA_VERSION,
          kind: args.request.kind,
          target_id: args.request.target_id,
          snapshot_hash: snapshotHash,
          current_state_hash: stableSha256(args.currentState),
          expected_state_hash: stableSha256(args.expectedState),
          proposed_change_hash: stableSha256(args.proposedChange),
          preconditions_hash: stableSha256(args.preconditions)
        }
      }
    : null;
  const semanticFingerprint = stableSha256({
    schema_version: OPERATIONAL_REPAIR_SCHEMA_VERSION,
    request: args.request,
    severity: severityForKind(args.request.kind),
    status: args.status,
    reason_code: args.reasonCode,
    snapshot_hash: snapshotHash,
    repair_key: repairKey,
    current_state: args.currentState,
    expected_state: args.expectedState,
    proposed_change: args.proposedChange,
    preconditions: args.preconditions,
    planned_audit: plannedAudit
  });
  const unsigned: Omit<OperationalRepairPlan, "plan_hash"> = {
    schema_version: OPERATIONAL_REPAIR_SCHEMA_VERSION,
    request: args.request,
    severity: severityForKind(args.request.kind),
    status: args.status,
    safe_to_apply: args.status === "repairable",
    reason_code: args.reasonCode,
    snapshot: args.snapshot,
    snapshot_hash: snapshotHash,
    semantic_fingerprint: semanticFingerprint,
    repair_key: repairKey,
    current_state: canonicalValue(args.currentState),
    expected_state: canonicalValue(args.expectedState),
    proposed_change: args.proposedChange,
    planned_audit: plannedAudit,
    preconditions: args.preconditions
  };
  return { ...unsigned, plan_hash: stableSha256(planIntegrityValue(unsigned)) };
}

function inventoryPlan(request: OperationalRepairRequest, raw: InventoryOverageSnapshot): OperationalRepairPlan {
  const snapshot = normalizeInventorySnapshot(raw);
  if (snapshot.deal_id !== request.target_id) {
    throw new OperationalRepairError("repair_target_mismatch", { target_id: request.target_id, snapshot_id: snapshot.deal_id });
  }
  const current = { reserved_units: snapshot.current_reserved_units, max_units: snapshot.max_units };
  const allowedSources = new Set<string>(CANONICAL_INVENTORY_EVIDENCE_SOURCES);
  const actualSources = snapshot.canonical_projections.map((projection) => String(projection.source));
  if (actualSources.some((source) => !allowedSources.has(source))) {
    return finishPlan({
      request, snapshot, status: "blocked", reasonCode: "inventory_evidence_source_invalid", currentState: current,
      expectedState: { required_sources: CANONICAL_INVENTORY_EVIDENCE_SOURCES }, proposedChange: null, preconditions: []
    });
  }
  if (new Set(actualSources).size !== actualSources.length) {
    return finishPlan({
      request, snapshot, status: "blocked", reasonCode: "inventory_evidence_source_duplicate", currentState: current,
      expectedState: { required_sources: CANONICAL_INVENTORY_EVIDENCE_SOURCES }, proposedChange: null, preconditions: []
    });
  }
  const missingSources = CANONICAL_INVENTORY_EVIDENCE_SOURCES.filter((source) => !actualSources.includes(source));
  if (missingSources.length > 0 || actualSources.length !== CANONICAL_INVENTORY_EVIDENCE_SOURCES.length) {
    return finishPlan({
      request, snapshot, status: "blocked", reasonCode: "inventory_evidence_incomplete", currentState: current,
      expectedState: { required_sources: CANONICAL_INVENTORY_EVIDENCE_SOURCES, missing_sources: missingSources },
      proposedChange: null, preconditions: []
    });
  }
  if (snapshot.canonical_projections.some((projection) => projection.evidence_ids.length === 0)) {
    return finishPlan({
      request, snapshot, status: "blocked", reasonCode: "inventory_evidence_missing", currentState: current,
      expectedState: null, proposedChange: null, preconditions: []
    });
  }
  const expectedValues = [...new Set(snapshot.canonical_projections.map((item) => item.expected_reserved_units))];
  if (expectedValues.length !== 1) {
    return finishPlan({
      request, snapshot, status: "blocked", reasonCode: "inventory_evidence_ambiguous", currentState: current,
      expectedState: { projections: snapshot.canonical_projections }, proposedChange: null, preconditions: []
    });
  }
  const expected = expectedValues[0] as number;
  if (expected > snapshot.max_units) {
    return finishPlan({
      request, snapshot, status: "blocked", reasonCode: "inventory_canonical_overage_unresolved", currentState: current,
      expectedState: { reserved_units: expected, max_units: snapshot.max_units }, proposedChange: null, preconditions: []
    });
  }
  if (snapshot.current_reserved_units <= snapshot.max_units) {
    const aligned = snapshot.current_reserved_units === expected;
    return finishPlan({
      request,
      snapshot,
      status: aligned ? "already_satisfied" : "blocked",
      reasonCode: aligned ? "inventory_already_consistent" : "inventory_not_overage_projection_mismatch",
      currentState: current,
      expectedState: { reserved_units: expected, max_units: snapshot.max_units },
      proposedChange: null,
      preconditions: []
    });
  }
  const mutation: InventoryRepairMutation = {
    operation: "inventory_set_reserved_units",
    deal_id: snapshot.deal_id,
    expected_current_reserved_units: snapshot.current_reserved_units,
    next_reserved_units: expected,
    max_units: snapshot.max_units,
    canonical_sources: snapshot.canonical_projections.map((item) => item.source)
  };
  return finishPlan({
    request,
    snapshot,
    status: "repairable",
    reasonCode: null,
    currentState: current,
    expectedState: { reserved_units: expected, max_units: snapshot.max_units },
    proposedChange: mutation,
    preconditions: [
      { field: "deal_id", expected: snapshot.deal_id },
      { field: "reserved_units", expected: snapshot.current_reserved_units },
      { field: "max_units", expected: snapshot.max_units },
      { field: "canonical_projection_hash", expected: stableSha256(snapshot.canonical_projections) }
    ]
  });
}

function leasePlan(request: OperationalRepairRequest, raw: ExpiredLeaseSnapshot): OperationalRepairPlan {
  const snapshot = normalizeLeaseSnapshot(raw);
  if (snapshot.event_uuid !== request.target_id) {
    throw new OperationalRepairError("repair_target_mismatch", { target_id: request.target_id, snapshot_id: snapshot.event_uuid });
  }
  const current = {
    event_type: snapshot.event_type,
    status: snapshot.status,
    worker_id: snapshot.worker_id,
    lease_generation: snapshot.lease_generation,
    claimed_at: snapshot.claimed_at,
    lease_expires_at: snapshot.lease_expires_at,
    processing_started_at: snapshot.processing_started_at,
    last_heartbeat_at: snapshot.last_heartbeat_at,
    available_at: snapshot.available_at,
    sent: snapshot.sent,
    sent_at: snapshot.sent_at,
    attempt_count: snapshot.attempt_count
  };
  if (snapshot.status !== "processing") {
    return finishPlan({
      request, snapshot, status: "already_satisfied", reasonCode: "lease_not_processing", currentState: current,
      expectedState: current, proposedChange: null, preconditions: []
    });
  }
  if (snapshot.event_type !== "deadline_check") {
    return finishPlan({
      request,
      snapshot,
      status: "blocked",
      reasonCode: "lease_event_type_requires_quarantine",
      currentState: current,
      expectedState: { quarantine_required: true, event_type: snapshot.event_type },
      proposedChange: null,
      preconditions: []
    });
  }
  if (snapshot.sent || snapshot.sent_at !== null) {
    return finishPlan({
      request,
      snapshot,
      status: "blocked",
      reasonCode: "lease_delivery_state_ambiguous",
      currentState: current,
      expectedState: { quarantine_required: true, sent: snapshot.sent, sent_at: snapshot.sent_at },
      proposedChange: null,
      preconditions: []
    });
  }
  if (snapshot.lease_expires_at === null) {
    return finishPlan({
      request, snapshot, status: "blocked", reasonCode: "lease_expiry_missing", currentState: current,
      expectedState: null, proposedChange: null, preconditions: []
    });
  }
  if (Date.parse(snapshot.lease_expires_at) > Date.parse(snapshot.observed_at)) {
    return finishPlan({
      request, snapshot, status: "already_satisfied", reasonCode: "lease_not_expired", currentState: current,
      expectedState: current, proposedChange: null, preconditions: []
    });
  }
  if (snapshot.evidence_ids.length === 0) {
    return finishPlan({
      request, snapshot, status: "blocked", reasonCode: "lease_evidence_missing", currentState: current,
      expectedState: null, proposedChange: null, preconditions: []
    });
  }
  if (snapshot.owner_activity !== "inactive") {
    return finishPlan({
      request,
      snapshot,
      status: "blocked",
      reasonCode: snapshot.owner_activity === "active" ? "lease_owner_still_active" : "lease_owner_activity_unknown",
      currentState: current,
      expectedState: null,
      proposedChange: null,
      preconditions: []
    });
  }
  if (snapshot.attempt_count >= snapshot.max_attempts) {
    return finishPlan({
      request, snapshot, status: "blocked", reasonCode: "lease_attempts_exhausted_requires_dlq", currentState: current,
      expectedState: null, proposedChange: null, preconditions: []
    });
  }
  if (snapshot.lease_generation === Number.MAX_SAFE_INTEGER) {
    return finishPlan({
      request, snapshot, status: "blocked", reasonCode: "lease_generation_exhausted", currentState: current,
      expectedState: null, proposedChange: null, preconditions: []
    });
  }
  const mutation: LeaseRepairMutation = {
    operation: "outbox_reclaim_expired_lease",
    event_uuid: snapshot.event_uuid,
    expected_event_type: "deadline_check",
    expected_status: "processing",
    expected_worker_id: snapshot.worker_id,
    expected_lease_generation: snapshot.lease_generation,
    next_lease_generation: snapshot.lease_generation + 1,
    expected_claimed_at: snapshot.claimed_at,
    expected_lease_expires_at: snapshot.lease_expires_at,
    expected_available_at: snapshot.available_at,
    expected_sent: false,
    expected_sent_at: null,
    next_status: "pending",
    next_worker_id: null,
    next_claimed_at: null,
    next_lease_expires_at: null,
    next_processing_started_at: null,
    next_last_heartbeat_at: null,
    next_available_at: "database_now",
    next_sent: false,
    next_sent_at: null
  };
  return finishPlan({
    request,
    snapshot,
    status: "repairable",
    reasonCode: null,
    currentState: current,
    expectedState: {
      status: "pending",
      worker_id: null,
      lease_generation: snapshot.lease_generation + 1,
      claimed_at: null,
      lease_expires_at: null,
      processing_started_at: null,
      last_heartbeat_at: null,
      available_at: "database_now",
      sent: false,
      sent_at: null
    },
    proposedChange: mutation,
    preconditions: [
      { field: "event_uuid", expected: snapshot.event_uuid },
      { field: "event_type", expected: "deadline_check" },
      { field: "status", expected: "processing" },
      { field: "worker_id", expected: snapshot.worker_id },
      { field: "lease_generation", expected: snapshot.lease_generation },
      { field: "claimed_at", expected: snapshot.claimed_at },
      { field: "lease_expires_at", expected: snapshot.lease_expires_at },
      { field: "processing_started_at", expected: snapshot.processing_started_at },
      { field: "last_heartbeat_at", expected: snapshot.last_heartbeat_at },
      { field: "available_at", expected: snapshot.available_at },
      { field: "sent", expected: false },
      { field: "sent_at", expected: null },
      { field: "attempt_count", expected: snapshot.attempt_count },
      { field: "max_attempts", expected: snapshot.max_attempts },
      { field: "owner_activity", expected: "inactive" }
    ]
  });
}

function auditCoreMatches(audit: ExistingTransitionAuditRecord, transition: TransitionEvidence): boolean {
  return audit.entity_type === transition.entity_type
    && audit.entity_id === transition.entity_id
    && audit.deal_id === transition.deal_id
    && audit.state_type === transition.state_type
    && audit.from_state === transition.from_state
    && audit.to_state === transition.to_state
    && audit.action_name === transition.action_name
    && audit.request_id === transition.request_id
    && audit.idempotency_key === transition.idempotency_key;
}

function desiredBackfillAudit(transition: TransitionEvidence): TransitionAuditInsertRecord {
  const sourceEvidenceHash = stableSha256(transition);
  const auditId = transition.expected_audit_id ?? deterministicAuditUuid(transition.source_transition_id);
  return {
    audit_id: auditId,
    entity_type: transition.entity_type,
    entity_id: transition.entity_id,
    deal_id: transition.deal_id,
    state_type: transition.state_type,
    from_state: transition.from_state,
    to_state: transition.to_state,
    action_name: transition.action_name,
    request_id: transition.request_id,
    idempotency_key: transition.idempotency_key,
    payload: {
      recovery_backfill: true,
      recovery_reason: "transition_without_audit",
      source_transition_id: transition.source_transition_id,
      source_occurred_at: transition.occurred_at,
      source_evidence_hash: sourceEvidenceHash,
      source_evidence_ids: transition.evidence_ids
    }
  };
}

function auditEvidenceRecord(audit: TransitionAuditInsertRecord): ExistingTransitionAuditRecord {
  const { payload, ...core } = audit;
  return { ...core, payload_hash: stableSha256(payload) };
}

function auditPlan(request: OperationalRepairRequest, raw: TransitionAuditBackfillSnapshot): OperationalRepairPlan {
  const snapshot = normalizeAuditSnapshot(raw);
  const transition = snapshot.transition;
  if (transition.source_transition_id !== request.target_id) {
    throw new OperationalRepairError("repair_target_mismatch", {
      target_id: request.target_id,
      snapshot_id: transition.source_transition_id
    });
  }
  if (transition.evidence_ids.length === 0) {
    return finishPlan({
      request,
      snapshot,
      status: "blocked",
      reasonCode: "audit_source_evidence_missing",
      currentState: { transition },
      expectedState: null,
      proposedChange: null,
      preconditions: []
    });
  }
  if (!isCanonicalActionTransition(transition)) {
    return finishPlan({
      request,
      snapshot,
      status: "blocked",
      reasonCode: "audit_transition_not_canonical",
      currentState: { transition },
      expectedState: null,
      proposedChange: null,
      preconditions: []
    });
  }
  const desired = desiredBackfillAudit(transition);
  const desiredEvidence = auditEvidenceRecord(desired);
  const sameId = snapshot.existing_audits.find((audit) => audit.audit_id === desired.audit_id);
  if (sameId) {
    const exact = canonicalJson(sameId) === canonicalJson(desiredEvidence);
    if (exact) {
      return finishPlan({
        request, snapshot, status: "already_satisfied", reasonCode: "transition_audit_already_present",
        currentState: sameId, expectedState: desiredEvidence, proposedChange: null, preconditions: []
      });
    }
    return finishPlan({
      request, snapshot, status: "blocked", reasonCode: "audit_backfill_id_collision", currentState: sameId,
      expectedState: desiredEvidence, proposedChange: null, preconditions: []
    });
  }
  const sameIdempotencyIdentity = snapshot.existing_audits.find((audit) =>
    audit.entity_type === desired.entity_type
      && audit.entity_id === desired.entity_id
      && audit.action_name === desired.action_name
      && audit.idempotency_key === desired.idempotency_key
  );
  if (sameIdempotencyIdentity && !auditCoreMatches(sameIdempotencyIdentity, transition)) {
    return finishPlan({
      request,
      snapshot,
      status: "blocked",
      reasonCode: "audit_backfill_idempotency_collision",
      currentState: sameIdempotencyIdentity,
      expectedState: desiredEvidence,
      proposedChange: null,
      preconditions: []
    });
  }
  const matchingAudit = snapshot.existing_audits.find((audit) => auditCoreMatches(audit, transition));
  if (matchingAudit) {
    return finishPlan({
      request, snapshot, status: "already_satisfied", reasonCode: "transition_audit_already_present",
      currentState: matchingAudit, expectedState: desired, proposedChange: null, preconditions: []
    });
  }
  const mutation: AuditBackfillMutation = {
    operation: "audit_backfill_insert",
    source_transition_id: transition.source_transition_id,
    audit: desired
  };
  return finishPlan({
    request,
    snapshot,
    status: "repairable",
    reasonCode: null,
    currentState: { transition, matching_audit: null },
    expectedState: { transition, audit: desired },
    proposedChange: mutation,
    preconditions: [
      { field: "source_transition_hash", expected: stableSha256(transition) },
      { field: "matching_audit", expected: null },
      { field: "audit_id_absent", expected: desired.audit_id }
    ]
  });
}

export function buildOperationalRepairPlan(
  rawRequest: OperationalRepairRequest,
  rawSnapshot: OperationalRepairSnapshot
): OperationalRepairPlan {
  const request = normalizeRequest(rawRequest);
  const snapshot = normalizeSnapshot(rawSnapshot);
  if (request.kind !== snapshot.kind) {
    throw new OperationalRepairError("repair_kind_mismatch", { request_kind: request.kind, snapshot_kind: snapshot.kind });
  }
  if (snapshot.kind === "inventory_overage") return inventoryPlan(request, snapshot);
  if (snapshot.kind === "expired_lease") return leasePlan(request, snapshot);
  return auditPlan(request, snapshot);
}

export function inspectOperationalRepair(
  request: OperationalRepairRequest,
  snapshot: OperationalRepairSnapshot
): OperationalRepairPreview {
  return { mode: "inspect", mutated: false, plan: buildOperationalRepairPlan(request, snapshot) };
}

export function dryRunOperationalRepair(
  request: OperationalRepairRequest,
  snapshot: OperationalRepairSnapshot
): OperationalRepairPreview {
  return { mode: "dry-run", mutated: false, plan: buildOperationalRepairPlan(request, snapshot) };
}

export function validateOperationalRepairPlan(plan: OperationalRepairPlan): void {
  if (plan.schema_version !== OPERATIONAL_REPAIR_SCHEMA_VERSION) {
    throw new OperationalRepairError("repair_plan_schema_mismatch");
  }
  const expectedHash = stableSha256(planIntegrityValue(planWithoutHash(plan)));
  if (expectedHash !== plan.plan_hash) {
    throw new OperationalRepairError("repair_plan_hash_mismatch", { expected: expectedHash, actual: plan.plan_hash });
  }
  const rebuilt = buildOperationalRepairPlan(plan.request, plan.snapshot);
  if (canonicalJson(rebuilt) !== canonicalJson(plan)) {
    throw new OperationalRepairError("repair_plan_semantic_mismatch");
  }
}

function buildAppliedRepairRecord(
  plan: OperationalRepairPlan,
  rawActorId: string
): AppliedRepairRecord {
  const actorId = validateOperationalRepairActorId(rawActorId);
  if (!plan.planned_audit) throw new OperationalRepairError("repair_planned_audit_required");
  return {
    repair_key: plan.repair_key,
    plan_hash: plan.plan_hash,
    snapshot_hash: plan.snapshot_hash,
    semantic_fingerprint: plan.semantic_fingerprint,
    kind: plan.request.kind,
    target_id: plan.request.target_id,
    audit_action: plan.planned_audit.action,
    audit_subject_type: plan.planned_audit.subject_type,
    audit_subject_id: plan.planned_audit.subject_id,
    audit_idempotency_key: plan.planned_audit.idempotency_key,
    reason_code: plan.planned_audit.reason_code,
    actor_id: actorId,
    metadata: plan.planned_audit.metadata,
    metadata_hash: stableSha256(plan.planned_audit.metadata)
  };
}

function assertSameAppliedRecord(record: AppliedRepairRecord, plan: OperationalRepairPlan): void {
  let expected: AppliedRepairRecord;
  try {
    expected = buildAppliedRepairRecord(plan, record.actor_id);
  } catch {
    throw new OperationalRepairError("repair_key_collision", { repair_key: plan.repair_key });
  }
  if (canonicalJson(record) !== canonicalJson(expected)) {
    throw new OperationalRepairError("repair_key_collision", { repair_key: plan.repair_key });
  }
}

function assertRepairPostcondition(
  plan: OperationalRepairPlan,
  rawSnapshot: OperationalRepairSnapshot,
  expectedLeaseAvailableAt: string | null = null
): void {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const mutation = plan.proposed_change;
  if (!mutation || snapshot.kind !== plan.request.kind) {
    throw new OperationalRepairError("repair_postcondition_failed", { field: "kind" });
  }
  if (mutation.operation === "inventory_set_reserved_units") {
    if (snapshot.kind !== "inventory_overage"
      || plan.snapshot.kind !== "inventory_overage"
      || snapshot.deal_id !== mutation.deal_id
      || snapshot.current_reserved_units !== mutation.next_reserved_units
      || snapshot.max_units !== mutation.max_units
      || stableSha256(snapshot.canonical_projections) !== stableSha256(plan.snapshot.canonical_projections)) {
      throw new OperationalRepairError("repair_postcondition_failed", { field: "inventory" });
    }
    return;
  }
  if (mutation.operation === "outbox_reclaim_expired_lease") {
    if (snapshot.kind !== "expired_lease"
      || plan.snapshot.kind !== "expired_lease"
      || snapshot.event_uuid !== mutation.event_uuid
      || snapshot.event_type !== mutation.expected_event_type
      || snapshot.status !== mutation.next_status
      || snapshot.worker_id !== null
      || snapshot.lease_generation !== mutation.next_lease_generation
      || snapshot.claimed_at !== null
      || snapshot.lease_expires_at !== null
      || snapshot.processing_started_at !== null
      || snapshot.last_heartbeat_at !== null
      || expectedLeaseAvailableAt === null
      || snapshot.available_at !== expectedLeaseAvailableAt
      || snapshot.sent !== false
      || snapshot.sent_at !== null
      || snapshot.attempt_count !== plan.snapshot.attempt_count
      || snapshot.max_attempts !== plan.snapshot.max_attempts) {
      throw new OperationalRepairError("repair_postcondition_failed", { field: "lease" });
    }
    return;
  }
  if (snapshot.kind !== "transition_audit_backfill" || plan.snapshot.kind !== "transition_audit_backfill") {
    throw new OperationalRepairError("repair_postcondition_failed", { field: "audit_kind" });
  }
  const expectedAudit = auditEvidenceRecord(mutation.audit);
  const exactMatches = snapshot.existing_audits.filter((audit) => canonicalJson(audit) === canonicalJson(expectedAudit));
  if (exactMatches.length !== 1
    || stableSha256(snapshot.transition) !== stableSha256(plan.snapshot.transition)) {
    throw new OperationalRepairError("repair_postcondition_failed", { field: "audit_exact" });
  }
}

export async function applyOperationalRepair(
  plan: OperationalRepairPlan,
  repository: OperationalRepairRepository,
  actorId: string
): Promise<OperationalRepairApplyResult> {
  validateOperationalRepairPlan(plan);
  const normalizedActorId = validateOperationalRepairActorId(actorId);
  if (plan.status === "blocked") {
    throw new OperationalRepairError("repair_plan_blocked", { reason_code: plan.reason_code });
  }
  if (plan.status !== "repairable" || !plan.proposed_change) {
    throw new OperationalRepairError("repair_plan_not_actionable", { reason_code: plan.reason_code });
  }
  return repository.transaction(async (tx) => {
    const prior = await tx.findRepairByKey(plan.repair_key);
    if (prior) {
      assertSameAppliedRecord(prior, plan);
      return {
        mode: "apply",
        status: "already_applied",
        mutated: false,
        repair_key: plan.repair_key,
        plan_hash: plan.plan_hash,
        evidence_hash: null
      };
    }

    const currentSnapshot = await tx.loadSnapshot(plan.request);
    const currentPlan = buildOperationalRepairPlan(plan.request, currentSnapshot);
    if (currentPlan.snapshot_hash !== plan.snapshot_hash
      || currentPlan.semantic_fingerprint !== plan.semantic_fingerprint
      || currentPlan.repair_key !== plan.repair_key) {
      throw new OperationalRepairError("repair_precondition_drift", {
        planned_snapshot_hash: plan.snapshot_hash,
        current_snapshot_hash: currentPlan.snapshot_hash
      });
    }

    const record = buildAppliedRepairRecord(plan, normalizedActorId);
    const reservation = await tx.reserveRepair(record);
    if (reservation.status === "existing") {
      assertSameAppliedRecord(reservation.record, plan);
      return {
        mode: "apply",
        status: "already_applied",
        mutated: false,
        repair_key: plan.repair_key,
        plan_hash: plan.plan_hash,
        evidence_hash: null
      };
    }

    const mutation = await tx.applyMutation(plan);
    if (mutation.status !== "applied" || mutation.affected_rows !== 1) {
      throw new OperationalRepairError("repair_mutation_row_count_mismatch", {
        affected_rows: mutation.affected_rows
      });
    }
    if (canonicalJson(mutation.audit_record) !== canonicalJson(record)) {
      throw new OperationalRepairError("repair_audit_mismatch", { repair_key: plan.repair_key });
    }
    let expectedLeaseAvailableAt: string | null = null;
    if (plan.proposed_change?.operation === "outbox_reclaim_expired_lease") {
      try {
        expectedLeaseAvailableAt = isoInstant(mutation.mutation_database_time, "mutation_database_time");
      } catch {
        throw new OperationalRepairError("repair_postcondition_failed", { field: "mutation_database_time" });
      }
    }
    assertRepairPostcondition(plan, mutation.postcondition, expectedLeaseAvailableAt);

    const storedAudit = await tx.findRepairByKey(plan.repair_key);
    if (!storedAudit || canonicalJson(storedAudit) !== canonicalJson(record)) {
      throw new OperationalRepairError("repair_audit_mismatch", { repair_key: plan.repair_key });
    }
    const storedPostcondition = await tx.loadSnapshot(plan.request);
    assertRepairPostcondition(plan, storedPostcondition, expectedLeaseAvailableAt);
    if (stableSha256(semanticSnapshotValue(normalizeSnapshot(storedPostcondition)))
      !== stableSha256(semanticSnapshotValue(normalizeSnapshot(mutation.postcondition)))) {
      throw new OperationalRepairError("repair_postcondition_mismatch");
    }
    return {
      mode: "apply",
      status: "applied",
      mutated: true,
      repair_key: plan.repair_key,
      plan_hash: plan.plan_hash,
      evidence_hash: stableSha256(mutation.evidence)
    };
  });
}
