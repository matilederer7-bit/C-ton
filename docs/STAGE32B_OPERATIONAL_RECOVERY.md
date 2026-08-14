# Stage 32B Operational Cleanup and Worker Recovery

Status: Stage 32B engineering complete, live cleanup pending explicit approval.

This stage hardens the existing canonical PostgreSQL Outbox worker and adds a
provider-neutral repair planner. It does not add another worker, change the
state constitution, or activate any external rail.

## Canonical worker design

The only runtime worker remains src/worker.ts. It claims and processes the
Outbox through src/outbox_worker_helpers.ts.

Migration 045 adds:

- lease_generation: a monotonic fencing token incremented on every claim.
- last_heartbeat_at: DB-time evidence for the current lease.
- operational_recovery_audit: an append-only lifecycle log separate from the
  business state-transition audit_log.

The database cutover is enforced independently of worker code. The
`outbox_processing_requires_fenced_lease` `NOT VALID` constraint preserves
pre-existing generation-0 processing rows while rejecting new or updated
unfenced processing rows. The `trg_outbox_fencing_cutover_update` and
`trg_outbox_fencing_cutover_delete` triggers block every old generation-0
acknowledgement, retry, completion, or delete. The only permitted update must
be from and to `deadline_check`, preserve event/aggregate identity, payload,
attempt policy, request/correlation identity and `created_at`, and move to
unsent `pending`, generation 1, with every ownership timestamp and owner
cleared. A matching append-only `operational_recovery_audit` `repair_lease`
record for the event, generation 1, unchanged attempt count,
`processing` to `pending`, and `stage32b_controlled_repair` reason must already
be visible before that update; the controlled adapter inserts it earlier in
the same transaction. The manual planner does not authorize `charge_deal` or
another external rail.

Every ownership mutation uses PostgreSQL time and executes inside one
transaction. The ownership tuple is:

    event_uuid + worker_id + lease_generation + unexpired lease

An old worker cannot heartbeat, complete, retry, fail, or move an event to DLQ
after ownership moves to a newer generation. An update of zero rows is a lease
loss, never a reported success.

## Lease lifecycle

| Step | Preconditions | Atomic result | Audit action |
|---|---|---|---|
| claim | pending, available, attempts below effective maximum | processing, owner, expiry, attempt + 1, generation + 1 | claim |
| heartbeat | current owner and generation, lease still valid | expiry extended using DB time | heartbeat |
| completion | current owner and generation, lease still valid | sent; ownership cleared | completion |
| retry | current owner and generation, lease still valid | pending; DB-time exponential backoff; ownership cleared | failure + retry |
| permanent/exhausted failure | current owner and generation | explicit-column copy to DLQ and source removal in one transaction | failure + dlq |
| automatic reclaim | protocol generation 1+ with a complete expired lease | pending without resetting attempt count; ownership clears; the next claim increments generation | reclaim |
| exhausted reclaim/sweep | protocol generation 1+ with expired processing lease, or eligible pending row at attempt cap | deterministic DLQ | reclaim/failure + dlq |
| automatic quarantine | generation 0 or incomplete lease evidence | no automatic mutation and never `pending` | explicit blocked reason |

Retry delay is deterministic exponential backoff, capped at 15 minutes. The
effective attempt maximum is the lower of the event value and worker policy.
New rows default to four attempts. Pending rows already at the cap are swept to
DLQ instead of becoming unclaimable zombies.

Claims and capped-row archival are isolated with per-event savepoints. A
row-local DLQ/constraint conflict or a non-identical lifecycle-Audit key
collision cannot roll back healthy claims: the affected active row is marked
`failed` with a bounded recovery reason and append-only failure Audit. Exact
Audit replay is a no-op only when all immutable fields match; unknown database
errors abort the enclosing transaction.

## Crash and idempotency contract

The worker is at-least-once. Fencing prevents a stale acknowledgement but
cannot retract an external side effect that completed immediately before a
crash. Every side-effect handler must therefore keep its stable provider or
internal idempotency key and reconcile outcome-unknown results before retry.

The isolated proofs cover:

- crash after claim and before an internal effect;
- crash after a committed idempotent internal effect and before completion;
- replay of that effect without duplication;
- stale completion rejection and completion by the new owner.

No payment, email, SMS, Join, Publish, or external provider is called by these
proofs.

## Operational repair planner

src/operational_repair.ts implements one narrow engine for:

1. inventory overage;
2. expired lease;
3. transition Audit backfill.

All operations require an explicit target identifier. Wildcards and discovery
apply are rejected. Canonical JSON, semantic snapshot and plan-content
SHA-256, immutable repair keys, and a transaction repository interface provide
drift detection and repeat safety. For an expired-lease snapshot, only the
volatile `observed_at` is excluded from both the semantic snapshot fingerprint
and plan integrity digest; it remains visible in inspect/dry-run output.

Modes:

- inspect: validates and classifies evidence; never mutates.
- dry-run: returns the complete proposed mutation and preconditions; never
  mutates.
- apply: validates the content SHA-256 plan hash, rereads the snapshot inside the
  repository transaction, rejects drift, reserves an idempotent repair key,
  applies the conditional mutation, and writes its recovery Audit.

The plan hash is a deterministic content SHA-256 integrity check; it is not a
digital signature and does not establish an actor's identity.

The CLI defaults to inspect:

    npm run ops:repair -- --input sanitized-snapshot.json

Dry-run:

    npm run ops:repair -- --mode dry-run --input sanitized-snapshot.json

Apply is never implicit. It additionally requires all of:

- an apply plan produced from the exact snapshot;
- expected-plan-hash equal to the plan hash;
- confirm-apply STAGE32B_APPLY;
- a non-empty actor-id recorded in the append-only recovery Audit;
- a separately reviewed local repository adapter implementing the
  transaction interface.

No Base44 live adapter is configured in this branch. This is intentional:
Base44 writes and live cleanup were forbidden for Stage 32B engineering. The
apply engine is fully tested through an isolated transactional repository, but
live execution remains blocked pending approval and an approved adapter.

## Repair decision rules

Inventory:

- the exact canonical evidence registry is `canonical_availability`,
  `canonical_reservations`, `canonical_commits`, `canonical_releases`, and
  `canonical_ledger`, with one non-empty evidence set for every source;
- all sources must agree on the expected reserved units;
- the expected result must not itself exceed max_units;
- disagreement or the need to choose a reservation winner fails closed;
- history is never deleted and no quantity is guessed from the latest row.

Lease:

- status must still be processing;
- owner, generation, `claimed_at`, expiry, processing/heartbeat timestamps,
  `available_at`, attempt limits, `sent=false` and `sent_at=null` must match the
  plan;
- the lease must be expired at observation time;
- owner activity must be proven inactive;
- attempts must remain below the maximum;
- the manual repair planner allows only `deadline_check` to become `pending`;
  money or external events such as `charge_deal` fail closed as quarantined;
- any delivered or ambiguous state (`sent=true` or non-null `sent_at`) fails
  closed and cannot be converted to pending;
- generation 0 and incomplete legacy lease evidence are never auto-reclaimed;
- manual apply increments the generation before clearing ownership, including
  the explicit legacy transition from generation 0 to 1;
- the adapter must return the exact database mutation timestamp; postcondition
  validation requires `available_at` to equal that DB time and never accepts a
  JavaScript/client timestamp guess;
- for the generation-0 cutover, the matching `repair_lease` Audit reservation
  is written before the conditional Outbox update in the same transaction, so
  either both commit or both roll back.

This manual-repair restriction is separate from automatic worker reclaim. The
canonical worker may reclaim any canonical event type only when it already has
a complete generation 1+ fenced lease that expires; handler idempotency remains
mandatory. The known live `charge_deal` has no generation field in its legacy
schema and therefore cannot enter that automatic path.

Audit backfill:

- source transition identity, from/to states, original canonical action,
  request ID, idempotency key, non-empty source evidence and the original
  transition `occurred_at` are required;
- entity/state alignment, action and transition must match the canonical
  constitution; entity created/updated times do not substitute for
  transition `occurred_at`;
- the deterministic UUID derives from the source transition identity;
- recovery_backfill is metadata, not a new state action;
- existing Audit evidence is supplied as a payload SHA-256 only; inspect and
  dry-run output never echoes an existing raw payload;
- the historical transition is not edited;
- identical replay is a no-op and any deterministic-ID collision fails closed.

## Operational repair codes

The following plan classification reason codes are the complete set emitted by
`src/operational_repair.ts`:

| Code | Classification |
|---|---|
| `inventory_evidence_source_invalid` | blocked: an evidence source is outside the exact canonical registry |
| `inventory_evidence_source_duplicate` | blocked: a canonical source appears more than once |
| `inventory_evidence_incomplete` | blocked: one or more canonical registry sources are absent |
| `inventory_evidence_missing` | blocked: a source has no evidence identifier |
| `inventory_evidence_ambiguous` | blocked: canonical sources disagree |
| `inventory_canonical_overage_unresolved` | blocked: canonical evidence still exceeds `max_units` |
| `inventory_not_overage_projection_mismatch` | blocked: the row is not over limit but disagrees with the projections |
| `inventory_already_consistent` | already satisfied |
| `lease_event_type_requires_quarantine` | blocked: manual repair accepts only `deadline_check` |
| `lease_delivery_state_ambiguous` | blocked: `sent`/`sent_at` evidence permits no safe pending repair |
| `lease_expiry_missing` | blocked: expiry evidence is incomplete |
| `lease_evidence_missing` | blocked: evidence identifiers are absent |
| `lease_owner_still_active` | blocked: the prior owner is active |
| `lease_owner_activity_unknown` | blocked: prior-owner inactivity is not proven |
| `lease_attempts_exhausted_requires_dlq` | blocked: reclaim is unsafe and DLQ planning is required |
| `lease_generation_exhausted` | blocked: the fencing token cannot be incremented safely |
| `lease_not_processing` | already satisfied: the target is no longer processing |
| `lease_not_expired` | already satisfied: the lease is still valid |
| `audit_source_evidence_missing` | blocked: source evidence is empty |
| `audit_transition_not_canonical` | blocked: entity/action/state transition violates the canonical constitution |
| `audit_backfill_id_collision` | blocked: deterministic Audit ID belongs to different evidence |
| `audit_backfill_idempotency_collision` | blocked: idempotency key belongs to a different Audit |
| `transition_audit_already_present` | already satisfied by an exact matching Audit |

The engine and CLI emit these failure codes:

| Code | Meaning |
|---|---|
| `explicit_target_id_required` | identifier is absent, wildcard, or bulk-like |
| `repair_snapshot_invalid` | a required snapshot field, including transition `occurred_at`, is missing or invalid |
| `repair_target_mismatch` | request and snapshot identify different targets |
| `repair_kind_mismatch` | request and snapshot repair kinds differ |
| `unsupported_repair_kind` | request kind is not one of the three supported repairs |
| `unsupported_repair_snapshot` | snapshot discriminator is unsupported |
| `repair_plan_schema_mismatch` | plan schema version differs |
| `repair_plan_hash_mismatch` | canonical plan integrity content does not match its SHA-256 |
| `repair_plan_semantic_mismatch` | a hash-valid plan does not rebuild to the canonical plan |
| `repair_plan_blocked` | apply was attempted for a blocked plan |
| `repair_plan_not_actionable` | apply was attempted for an already-satisfied or mutation-free plan |
| `repair_plan_required` | apply input contains no plan object |
| `repair_planned_audit_required` | an actionable plan lacks its recovery-Audit preview |
| `repair_precondition_drift` | semantic source state changed after planning |
| `repair_key_collision` | an existing repair key has different immutable content |
| `repair_mutation_row_count_mismatch` | the conditional adapter mutation did not affect exactly one row |
| `repair_postcondition_failed` | adapter post-state does not satisfy the planned mutation |
| `repair_postcondition_mismatch` | reread state differs from the adapter-reported postcondition |
| `repair_audit_mismatch` | returned or stored recovery Audit differs from the planned Audit |
| `explicit_apply_confirmation_required` | the exact apply confirmation token is absent |
| `expected_plan_hash_mismatch` | CLI expected hash differs from the plan hash |
| `apply_actor_id_required` | apply has no explicit operator identity |
| `apply_repository_adapter_required` | no reviewed mutation adapter was supplied |
| `apply_repository_adapter_invalid` | adapter module does not expose the required transaction repository |
| `repair_input_required` | CLI input path is absent |
| `repair_input_invalid` | parsed CLI input is not an object |
| `invalid_repair_mode` | CLI mode is unsupported |
| `unknown_cli_argument` | CLI argument is unknown |
| `non_finite_canonical_number` | canonical input contains a non-finite number |
| `invalid_canonical_date` | canonical input contains an invalid Date object |
| `undefined_canonical_array_value` | canonical array contains `undefined` |
| `undefined_canonical_root` | canonical root serializes as `undefined` |
| `unsupported_canonical_value` | canonical input contains an unsupported value type |
| `operational_repair_failed` | CLI fallback for an unexpected non-domain exception |

The worker separately emits `outbox_lease_lost` when the exact
owner/generation/unexpired-lease tuple no longer authorizes heartbeat,
completion, retry, failure, or DLQ.

## Partial failure and rollback

Worker mutations and lifecycle Audit are in one PostgreSQL transaction. A
failed transaction rolls back both. DLQ copy and Outbox removal are likewise
atomic.

Repair apply is also one repository transaction. Drift or ambiguity causes
zero mutation. Replaying the same repair key produces no second mutation.

Rollback is compensating, never destructive:

- inventory: append a reviewed compensating reserve/release event and recompute
  projections; do not delete a reservation or rewrite historical quantity;
- lease: fence again with a newer generation and place the event in the
  reviewed safe state; do not restore an old owner token;
- Audit backfill: append a corrective recovery record or operational case;
  append-only Audit is not deleted or edited.

## Verification

Focused commands:

    npm run gate:base44-canonical-integrity
    npm run test:base44-canonical-integrity
    npm run test:operational-repair
    npm run test:workers
    npm run test:concurrency
    npm run test:failure

The full repository gate, typecheck, lint, build, migrations, and end-to-end
results are recorded in PROJECT_STATUS.md.

## Preserved invariants

Public Join remains blocked. This stage does not activate payments, email,
SMS, or Publish; does not change secrets; does not modify the state
constitution or the 90 percent rule; and does not change Siton's fee. The fee
remains 8 percent of everything collected from the customer including
delivery and excluding VAT. Distributor commission remains zero.
