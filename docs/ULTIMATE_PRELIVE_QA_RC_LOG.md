# Ultimate Pre-Live QA and RC Log

Last updated: 2026-03-31

## Phase A - Ultimate Test Matrix and Risk Map

| Area | Risk | What Is Attacked | Pass Condition | Blocker Condition | External-Only Boundary |
| --- | --- | --- | --- | --- | --- |
| DB schema and init assumptions | HIGH-RISK | Canonical indexes, no forbidden `(deal_id, buyer_id)` unique, webhook/delivery/affiliate persistence, bootstrap alignment | Schema and init assumptions match runtime product rules | Drift between runtime expectations and canonical schema/init | Live migration rehearsal against external staging DB |
| State machine and runtime contracts | HIGH-RISK | Wrong-state publish/join/prepare/charging/cancel, idempotency abuse, replay after terminal states | Controlled 4xx/409 responses and no corruption | Silent state corruption or ambiguous success | None |
| Buyer flow misuse | HIGH-RISK | Direct late-route entry, stale/missing session, OTP misuse, retry after failure, stale UI vs backend truth | No illusion of success and clear recovery paths | False success or broken tracking semantics | Real browser/device behavior outside local harness |
| Seller / affiliate / admin surfaces | HIGH-RISK | Missing objects, wrong-state actions, delivery misuse, payout/KYC/support misuse, cross-role semantics | Surfaces reject misuse cleanly and stay consistent | 200 success on missing targets or cross-role semantic contradiction | External KYC/payout execution |
| Webhook and reconciliation weirdness | HIGH-RISK | Duplicate, replay, wrong secret, malformed event, late/out-of-order domain mutations | Duplicate-safe, replay-safe, no double mutation | Double mutation or terminal-state corruption | Real provider event catalog |
| Payment/provider boundary | MEDIUM-RISK | Mode summary, mock-backed vs provider-ready semantics, malformed provider-like paths | Boundary remains crisp and explicit | Undefined provider mode or misleading success | Live provider HTTP behavior |
| Mixed load / soak / RC under pressure | HIGH-RISK | Burst, soak, mixed reads/writes, restart-adjacent weirdness, health under pressure | Tests remain green and no hidden drift shows up | Stuck processing, unexplained DLQ growth, coherence loss | Process-manager/staging orchestration |
| Observability and RC gate clarity | MEDIUM-RISK | `/health`, `/health/integrations`, debug/admin surfaces, canonical docs/status | Clear go/no-go signal and canonical truth | Contradictory docs/status or opaque failure surface | External monitoring stack |

## Phase B/C/D/E/F/G/H/I Summary

### Phase B - Database and Data Integrity Pass

- Re-verified the canonical schema assumptions directly against Postgres indexes and constraints.
- Proved that no forbidden unique constraint exists on `(deal_id, buyer_id)`.
- Re-verified persistence guarantees for:
  - `webhook_events(provider,event_id)` idempotency
  - `delivery_records(participant_id)` uniqueness
  - `affiliate_attributions(participant_id)` uniqueness
- Re-verified bootstrap alignment in `scripts/init_db.sql` without treating it as a stricter canonical source than runtime migrations.

Result:
- `PASS`

### Phase C - Backend Runtime, State Machine, and Contract Torture

- Reused the hardened backend suite through `npm test`.
- Added focused ultimate checks for missing-target and malformed admin mutation paths.
- Found one real crack:
  - admin mutation endpoints could return `200` with an empty result when the target seller / affiliate / support ticket did not exist.
- Fixed the crack by turning those paths into explicit `404`, and by adding UUID validation for affiliate KYC mutation targets.

Result:
- `PASS` after fix

### Phase D - Frontend, UX, Session, and Flow Torture

- Revalidated the buyer shell, tracking, OTP, payment/auth mock boundary, and route shells through the existing frontend/full-system/adversarial/preprod suites.
- Re-checked `node --check frontend/app.js`.
- Verified that no false success path was introduced by the admin/seller/affiliate fixes.

Result:
- `PASS`

### Phase E - Seller / Affiliate / Admin Surface Torture

- Attacked seller completed surface, delivery ops, affiliate overview, payout profile, admin KYC, affiliate payout mutation, support updates, admin deal profile, and user profile.
- Found and fixed the main role-surface issue:
  - missing targets were not rejected consistently.
- Revalidated that completed seller/affiliate/admin surfaces still expose coherent state after the fix.

Result:
- `PASS` after fix

### Phase F - Integration Boundary, Webhook, Reconciliation, and Payment Torture

- Revalidated:
  - `/health/integrations`
  - provider boundary summary
  - duplicate/replay-safe webhook semantics
  - notification hook behavior under internal mode
- Confirmed unsupported/duplicate events stay safe and no double mutation was introduced by the latest changes.

Result:
- `PASS`

### Phase G - Load, Soak, Mixed Traffic, Restart, and Recovery Pass

- Re-ran the full multi-suite harness through `npm test`, which already includes:
  - mixed load
  - soak-like repeated reads/tracking
  - recovery/restart-adjacent ordering abuse
  - seller/admin/product surfaces
- Observed no newly introduced DLQ drift, stuck processing, or unexplained state mismatch.
- Cleared `.tmp_test_dist` after validation and ensured no lingering `node` process remained.

Result:
- `PASS`

### Phase H - Ultimate RC Drill

Gate classification after the pass:

| Item | Result | Note |
| --- | --- | --- |
| `/health` | PASS | Healthy |
| `/health/integrations` | PASS | Honest mock-backed/log-only reporting |
| buyer critical routes | PASS | Revalidated in full-system and frontend suites |
| seller critical routes | PASS | Revalidated in product surface and ultimate suite |
| affiliate critical routes | PASS | Revalidated in remaining-surface and ultimate suite |
| admin critical routes | PASS | Revalidated with missing-target hardening |
| receipts / delivery surfaces | PASS | Completed-deal semantics proven |
| KYC / settlement / support surfaces | PASS | Internal semantics proven; external rails still inactive |
| webhook sanity | PASS | Duplicate-safe and malformed-safe |
| outbox sanity | PASS | No new drift observed in full suite |
| test suite | PASS | `npm test` green |
| type check | PASS | `npx tsc --noEmit` green |
| canonical status | PASS | Root `PROJECT_STATUS.md` remains canonical |
| temporary residue | PASS | `.tmp_test_dist` cleaned |
| live external rails | EXTERNAL-ONLY | Still intentionally inactive |

### Phase I - Final Revalidation

- `node --check frontend/app.js` passed
- `npx tsc --noEmit` passed
- `npm run test:ultimate-prelive` passed
- `npm test` passed
- `.tmp_test_dist` removed after the run
- no lingering `node` process remained

Final internal conclusion:
- The remaining meaningful softness is external-only:
  - live payment provider
  - live invoice / shipping / payout / KYC / support rails
