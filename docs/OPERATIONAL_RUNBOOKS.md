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
