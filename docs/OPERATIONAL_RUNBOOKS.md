# Operational Runbooks

These runbooks document how to handle common failure modes without taking destructive action. They are advisory: every operator must verify the current state in Mission Control before acting.

A small number of failure drills are exercised by the test suite to make sure Mission Control surfaces the failure (`npm run test:operational-runbooks`). Drills do not run a full E2E.

---

## 1. Outbox Stuck / DLQ Not Empty

Symptoms

- `mission_control.outbox.failed > 0` or `dlq > 0`.
- Anomaly `outbox_failed_jobs`.

Where to look

- `GET /api/admin/mission-control/outbox/:eventId` — single event trace.
- `GET /api/admin/mission-control/correlation/:correlationId` — cross-domain trace.

Forbidden

- Deleting DLQ rows.
- Manually editing `outbox_events.status` outside the `requeue_outbox_event` Safe Action.

Safe action

- `requeue_outbox_event` via `POST /api/admin/actions` with reason and idempotency key.

Escalate when

- DLQ > 5 events of the same type within an hour.
- Same event has been requeued > 3 times.

---

## 2. Payment Unknown

Symptoms

- `mission_control.payments.unknown_count > 0`.
- Participant stuck in `ChargeAttempt`.

Where to look

- `GET /api/admin/mission-control/correlation/:correlationId` for the participant.
- Webhook events for the same `correlation_id` and `provider_reference`.

Forbidden

- Manual capture / refund / state edit.

Safe action

- `trigger_reconcile` opens an operational case. Investigate provider side. No live call is made automatically.

Escalate when

- Unknown payment older than 24 hours.

---

## 3. Webhook Duplicate / Late / Failed

Symptoms

- `mission_control.webhooks.duplicates > 0` or `late_events > 0` or `failed > 0`.

Where to look

- `GET /api/admin/mission-control/webhooks/:provider/:eventId`.

Forbidden

- Deleting webhook rows.
- Mutating terminal deal state because a late webhook arrived.

Safe action

- Investigate, leave the row, write a `WebhookIngestion` support case if reconcile is required.

Escalate when

- A late webhook references a deal already in a terminal state and the operational case shows mismatched evidence.

---

## 4. Invoice Failed

Symptoms

- `mission_control.invoices.failed > 0`.
- Anomaly `invoices_failed_jobs`.

Safe action

- `retry_invoice_failed` for a `failed` document with no `provider_document_id` set. The Safe Action does not duplicate issuance.

Forbidden

- Manually setting `provider_document_id` or marking as issued.

Escalate when

- Invoice failed with `provider_document_id` set — possible duplicate risk.

---

## 5. Notification Failed

Symptoms

- `mission_control.notifications.failed > 0`.
- `notifications_readiness.failed_critical_notifications` non-empty.

Safe action

- `retry_notification` for a `failed` row. Templates and idempotency keys are reused; no duplicate send.

Forbidden

- Editing recipient addresses on an existing `failed` row.

Escalate when

- A recovery / completion / payout notification is `failed` for the same participant repeatedly.

---

## 6. Payout Freeze

Symptoms

- `payout_status` rows in `frozen` or `mission_control.admin_intervention_readiness.payout_freeze_active=true`.

Safe action

- `unfreeze_payouts` (requires SuperAdmin + recent MFA + second approval). Only releases the flag. Does not create a payout.

Forbidden

- Direct DB updates to settlement status.

Escalate when

- A freeze has been active > 7 days without a documented reason in operational cases.

---

## 7. Seller KYC Rejection

Symptoms

- `mission_control.seller_onboarding_readiness.rejected > 0`.

Safe action

- Investigate, communicate with the seller through normal support channels. To re-review, change `verification_status` via `POST /api/admin/kyc/seller/:sellerId/decision` with reason.

Forbidden

- Approving without re-checking the documents.

Escalate when

- A rejected seller appeals.

---

## 8. Suspicious Seller

Symptoms

- Multiple buyer complaints, anomaly cases, or payout reconciliation cases against the same seller.

Safe actions

- `freeze_payouts` (seller scope) — second approval required.
- `pause_joining_emergency` (seller scope) — bounded `expires_at`.
- `seller_status='UnderReview'` or `Suspended` via `POST /api/admin/sellers/:sellerId/status` with reason.

Forbidden

- Banning without recording a reason.

---

## 9. Security Alert

Symptoms

- `mission_control.security_hardening_gate.findings` shows a new finding.
- `admin_security_alert` notifications failed.

Safe actions

- Investigate via Mission Control.
- Open a support case (`SecurityIssue` / `SystemException`).
- Notify on `admin_security_alert` channel.

Forbidden

- Sharing raw provider payloads or secrets.

---

## 10. Participant Cannot Access Tracking

Symptoms

- Buyer reports tracking link does not work.

Where to look

- `siton.participant_tracking_tokens` — status, expiry, revocation.
- `GET /api/admin/mission-control/participants/:participantId/trace`.

Safe actions

- Reissue a tracking token via the existing flow. The DB stores hashes only; the new token is returned once.

Forbidden

- Sharing the raw token in admin responses.

---

## 11. Emergency Pause Joining

See `docs/ADMIN_INTERVENTION_RUNBOOK.md` for the full procedure. Always set `expires_at`. Always release with a reason.

---

## 12. Emergency Pause Charging

See `docs/ADMIN_INTERVENTION_RUNBOOK.md`. Second approval required. Always bounded.

---

## 13. Deploy Stale / Wrong Commit

Symptoms

- `mission_control.system_summary.deploy_freshness_status='mismatch'`.

Safe actions

- Trigger a deploy. Verify `EXPECTED_COMMIT_SHA` env vs `COMMIT_SHA` / `RENDER_GIT_COMMIT`.

Forbidden

- Forcing the env to mask the mismatch.

---

## 14. DB Unavailable

Symptoms

- `mission_control.database.connectivity=false`.
- Health endpoint failures.

Safe actions

- Check platform DB status. Open an incident case once stable.

Forbidden

- Restoring from a backup without a documented decision.

---

## 15. Storage Unavailable

Symptoms

- Image GETs return 404 / 5xx.
- `mission_control.storage_readiness.last_orphan_report.missing_files_count > 0`.

Safe actions

- Re-run the orphan report.
- Restore missing files from backup if available.
- Open a `SystemException` case.

Forbidden

- Deleting `siton.deal_images` rows when files are missing.

---

## 16. Operational Diagnostics / Local Recovery

Use Mission Control first. The commands below are read-only diagnostics for an operator who needs lower-level evidence. They do not authorize direct DB state edits, real-money actions, refunds, payouts, or production restore operations.

### Quick health check

Local/dev PowerShell:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/health | Select-Object -ExpandProperty Content
```

Expected:

```json
{"ok":true}
```

For a deployed environment, use that environment's canonical `/health` and `/readiness` endpoints rather than a local address.

### Stuck outbox

This catches both old `processing` rows whose `processing_started_at` is null and genuinely stale processing rows older than 30 seconds.

```powershell
node scripts/run_pg_query.cjs "select event_uuid, event_type, aggregate_id, status, attempt_count, processing_started_at, updated_at from siton.outbox_events where status='processing' and (processing_started_at is null or processing_started_at < now() - interval '30 seconds') order by updated_at asc" "[]"
```

Healthy expectation: empty result. Do not repair the row by direct SQL; use the Safe Action and escalation rules in section 1.

### DLQ and retry pressure

```powershell
node scripts/run_pg_query.cjs "select event_uuid, event_type, aggregate_id, attempt_count, last_error, created_at from siton.outbox_dlq order by created_at desc limit 20" "[]"
```

```powershell
node scripts/run_pg_query.cjs "select event_type, status, count(*)::int as cnt, max(attempt_count)::int as max_attempt from siton.outbox_events group by event_type, status order by event_type, status" "[]"
```

Investigate repeated retry growth, repeated errors and fresh DLQ entries. Never delete DLQ rows to make the dashboard green.

### Deal / event correlation investigation

Replace `<DEAL_ID>` with the relevant deal UUID.

```powershell
node scripts/run_pg_query.cjs "select event_uuid, event_type, status, attempt_count, last_error, created_at from siton.outbox_events where aggregate_id = $1 order by created_at asc" "[\"<DEAL_ID>\"]"
```

```powershell
node scripts/run_pg_query.cjs "select event_uuid, event_type, attempt_count, last_error, created_at from siton.outbox_dlq where aggregate_id = $1 order by created_at asc" "[\"<DEAL_ID>\"]"
```

```powershell
node scripts/run_pg_query.cjs "select audit_id, entity_type, entity_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, created_at from siton.audit_log where deal_id = $1 order by created_at asc" "[\"<DEAL_ID>\"]"
```

```powershell
node scripts/run_pg_query.cjs "select attempt_id, participant_id, attempt_type, result_class, correlation_id, created_at from siton.payment_attempts where deal_id = $1 order by created_at asc" "[\"<DEAL_ID>\"]"
```

For the canonical application-level trace, use the authenticated Mission Control surface `GET /api/admin/mission-control/deals/:dealId/trace`. The retired `/debug/deals/:id` surface is not a current inspection path.

### Charging failure / completion-window evidence

```powershell
node scripts/run_pg_query.cjs "select participant_id, buyer_state, money_state from siton.participants where buyer_state='ChargeFailedCompletion' and money_state='ChargeFailedRecovery' order by created_at asc" "[]"
```

```powershell
node scripts/run_pg_query.cjs "select attempt_id, participant_id, deal_id, result_class, correlation_id, created_at from siton.payment_attempts where attempt_type='charge_start' order by created_at desc limit 20" "[]"
```

```powershell
node scripts/run_pg_query.cjs "select event_uuid, aggregate_id, status, attempt_count, available_at from siton.outbox_events where event_type='recovery_deal' order by created_at desc limit 20" "[]"
```

For one deal:

```powershell
node scripts/run_pg_query.cjs "select deal_id, state, completion_window_until from siton.deals where deal_id = $1" "[\"<DEAL_ID>\"]"
```

```powershell
node scripts/run_pg_query.cjs "select event_uuid, event_type, status, available_at from siton.outbox_events where aggregate_id = $1 and event_type in ('recovery_deal','finalize_deal') order by created_at asc" "[\"<DEAL_ID>\"]"
```

These queries are evidence only. Never manually capture, refund, settle or force a deal/participant state from SQL.

### Local worker/server restart

Local/dev only:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restart_server_tsnode_clean.ps1
```

Expected: the old local port-3000 process stops, the app starts again, and `/health` returns `{"ok":true}`. A staging/production service restart or deploy follows the platform runbook and must not be simulated with this local script.

### Safe rollback

1. Prefer redeploying the previous known-good runtime SHA.
2. Re-check `/health`, `/readiness`, Mission Control, stuck outbox and DLQ evidence.
3. Do **not** restore a database, mutate production state, rotate credentials, refund, capture or pay out money without the explicit approval required by the production runbooks and owner policy.
4. If a database restore is genuinely required, follow the disaster-recovery procedure and its approval/evidence requirements; never improvise a restore from this runbook.

### Minimum release-candidate sanity

1. `GET /health` is 200 and returns `{"ok":true}`.
2. `GET /readiness` is 200 with the expected readiness contract.
3. The stuck-outbox query is empty.
4. DLQ has no fresh unexpected entries.
5. One known deal is internally consistent in Mission Control via `/api/admin/mission-control/deals/:dealId/trace`.

