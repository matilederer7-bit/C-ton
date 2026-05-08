# Admin Intervention Runbook

Status: SuperAdmin emergency controls implemented as bounded internal flags. No money is moved by these controls. No state machine value is changed. No content is deleted.

## Control Flags

`siton.admin_control_flags` carries the bounded intent of an admin emergency action:

- `pause_joining_emergency`
- `pause_charging_emergency`
- `payout_freeze`
- `content_takedown`

Each flag has a `scope_type` (`global`, `deal`, `seller`, `participant`, `payout`, `content`) and a `scope_id`. Audit lives in `siton.admin_control_flag_events`.

## Required Controls

| Action | Permission | Recent MFA | Second Approval | expires_at |
|--------|-----------|------------|-----------------|-----------|
| `pause_joining_emergency` | `emergency.pause` (SuperAdmin) | yes | no | required |
| `pause_charging_emergency` | `emergency.pause` (SuperAdmin) | yes | yes | required |
| `freeze_payouts` | `payout.freeze` (SuperAdmin) | yes | yes (when scope is payout/seller/deal) | optional |
| `unfreeze_payouts` | `payout.freeze` (SuperAdmin) | yes | yes | optional |
| `content_takedown_request` | `admin_actions.execute` | yes | no | optional |
| `trigger_reconcile` | `admin_actions.execute` | yes | no | n/a |

A `reason` is always required. Self-approval is blocked.

## Effects (What These Flags Actually Do)

- `pause_joining_emergency` — `POST /deals/:id/join` returns `423 joining_paused_by_admin` when an active flag matches the deal, the seller, or the global scope. Existing buyers are not touched. Deal state is not changed.
- `pause_charging_emergency` — `POST /deals/:id/charging/start` returns `423 charging_paused_by_admin` when the flag matches. Workers consult the same predicate before issuing money operations. Deal state is not changed.
- `payout_freeze` — `calculateSellerSettlementForDealInTx` adds `payout_freeze_admin_flag_active` to the blocking reasons, so new settlements stay `pending`. Already-paid settlements are not reversed. The flag never moves money.
- `content_takedown` — content surfaces (deal page / images / chat) consult the flag and render a placeholder. Files and rows are not deleted. CDN purge is a separate provider gate.
- `trigger_reconcile` — opens or reuses a `PaymentMismatch` operational case for follow-up. No live provider call is performed.

## Endpoints

- `POST /api/admin/actions` — request a Safe Action with `action_type`, `target_type`, `target_id`, `reason`, `idempotency_key`. For pause actions, include `metadata.expires_at`.
- `POST /api/admin/actions/:adminActionId/approve` — for actions that require a second approver.
- `POST /api/admin/actions/:adminActionId/reject` — for actions that require a second approver.
- `POST /api/admin/actions/:adminActionId/execute` — runs the bounded effect.
- `GET /api/admin/control-flags` — list active flags filtered by `flag_type` / `scope_type` / `scope_id`.
- `POST /api/admin/control-flags/:flagId/release` — release an active flag (requires recent MFA, `emergency.pause` permission, reason).

## Non-Destructive Guarantees

The intervention runbook never deletes audit, outbox, webhook rows, money records, content files, or buyer/seller state. Flags are bounded intent only.

## When NOT To Use

- Refunding a buyer — there is no admin refund. Use the operational case workflow and the existing money rail.
- "Fixing" a state machine — admin actions never edit state. If state is wrong, open a support case and trace via Mission Control.
- Deleting evidence — admin actions never delete audit, outbox, or webhook rows.
- Bypassing seller payouts — the unfreeze action only releases the flag; it does not create a payout.

## Operator Steps For Each Scenario

### Suspected runaway joining

1. Open Mission Control and identify the deal.
2. `POST /api/admin/actions` with `action_type=pause_joining_emergency`, `target_type=deal`, `target_id=<deal>`, `reason=<incident>`, `metadata={"expires_at":"<ISO date within 24h>"}`.
3. `execute`.
4. Investigate in trace. Open or escalate a support case.
5. After resolution, `POST /api/admin/control-flags/:flagId/release` with reason.

### Suspected charging fault

1. Same as above but `action_type=pause_charging_emergency`. Second approval required.
2. Workers stop scheduling new charging until flag is released.

### Payout freeze for a seller

1. `POST /api/admin/actions` with `action_type=freeze_payouts`, `target_type=seller`, `target_id=<seller>`, `reason=<reason>`. Second approval required.
2. `approve`, then `execute`.
3. Existing settlements remain. New settlements stay `pending`.

### Content takedown

1. `POST /api/admin/actions` with `action_type=content_takedown_request`, `target_type=deal|content|seller`, `target_id=<id>`, `reason=<reason>`.
2. `execute`. The flag is recorded; consumers render placeholders.

## Live Pilot Open Items

- Worker-side enforcement of `pause_charging_emergency` inside the charging worker / outbox processor (current MVP enforces at the request entry point; a worker pre-flight check is a follow-up).
- Operator runbooks for releasing flags after incidents.
- CDN purge contract for content takedowns.
