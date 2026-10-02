# Black-Sky Threat Model — Siton (C-ton)

Status: short threat model for combined failures. Written 2026-09-27 on the Black-Sky branch (base `dd378dd`), after the red-team closure (`docs/archive/RED_TEAM_FINAL_REPORT.md`) and the Black-Sky hardening commits (`bc6f906` destructive-target guard + scrubbing serializer, `1c8e687` Grow UNKNOWN classification + keyring, `818408f` availability/auth hardening, `f68c728` migration runner advisory lock + `--clear-running`, `9af222f` worker retries/alerts/watchdog/deadline, `88a946e` payout per-deal lock + forward-only + unknown dispatch, `700c1b9` invariants + rehearsal + off-site backup, `a6f6f28` deadline/threshold money gates + payout DB guards (077), `dd378dd` identity-keyed seller-mutation budget). It says what the system is designed to survive and what it is not. It does not claim more than the cited tests and runbooks prove.

## 1. Assets (what we protect, in priority order)

1. **Money truth**: `participants.money_state`, `payment_attempts`, `platform_fee_money_events`, `payment_authorization_bindings`, `seller_settlements`, `seller_payout_batches/items/attempts`, `seller_payout_reconciliation_cases`. Invariant: one capture per obligation, one refund at most, 8% fee incl. delivery excl. VAT, no distributor commission.
2. **Evidence**: `audit_log`, `operational_recovery_audit` (append-only by trigger), `webhook_events`, `outbox_dlq`, security-event tables.
3. **Availability of the deal lifecycle**: joins, deadline checks, charging, completion window, refunds — driven by the outbox worker.
4. **Identity and secrets**: DB login roles, session secrets, provider credentials, the Grow reference keyring, the off-site age identity (`docs/CREDENTIAL_COMPROMISE_RUNBOOK.md`).
5. **Personal data**: buyer phone/name, seller identity, tracking links (45-day tokens), admin identities.
6. **Restorability**: migration ledger + checksums, grant files, off-site dumps, this documentation.

## 2. Actors

| Actor | Capability assumed | Motive |
|---|---|---|
| Anonymous internet | HTTP at scale, header spoofing, replay, fuzzing | oversell, double-join, brute force OTP/MFA, DoS |
| Buyer | a valid tracking/recovery token, an OTP-verified phone | double charge avoidance/abuse, refund pressure, IDOR on other buyers |
| Seller | seller session, mutation routes | edit locked economics, self-approve, exhaust budgets, leak buyer data |
| Compromised admin cookie / bootstrap key | read-only (`x-admin-key`) or named-admin actions up to SuperAdmin | data exposure, control-flag abuse |
| Compromised runtime credential | `siton_web_runtime` / `siton_worker_runtime` DB access, no DDL | data read/write inside the profile |
| Compromised owner account (Supabase/Render/GitHub) | everything | total loss |
| Payment provider (Grow/Stripe) | ambiguous answers, duplicates, late/out-of-order events, outages | none (failure, not malice) |
| Platform (Supabase, Render, GitHub) | outage, region loss, project deletion, backup failure | none |
| The operator | typos, wrong environment in the shell, restoring the wrong thing | none |
| Coding agents | wide code changes, wrong-branch merges, gate weakening | none, but blast radius is real |

## 3. Detection and fail-closed behaviour we rely on

| Control | Where | Behaviour |
|---|---|---|
| DB-layer money guards | CHECK constraints, `FOR NO KEY UPDATE` on the deal row + advisory xact lock at join, partial-unique charge/refund indexes, CAS transitions, per-row audit/outbox evidence triggers (076), payout forward-only + monotonic amounts (077), charge-cap trigger (3 per 30 min) | an illegal or duplicate money write is rejected regardless of application bugs |
| Provider ambiguity | attempt written `unknown` before I/O; UNKNOWN classification for 5xx/429/timeout/malformed/auth-routing; settlement horizon fence (068); Grow never infers from negative status; payout `dispatch_outcome_unknown` blocks re-dispatch | ambiguous money is never decided by a retry; it waits for evidence or a human |
| Worker | leases + generation fencing, `SKIP LOCKED`, money lane concurrency 1, per-job deadline (`WORKER_EVENT_TIMEOUT_MS`), progress watchdog (exit 1), lane retry budgets (~45 min for money), pushed alerts `dlq_increased`/`oldest_pending_stale`/`stale_leases`/`consecutive_cycle_failures`/`event_deadline_exceeded` | a dead or stuck worker loses no job; the platform restarts it; alerts fire once per window |
| Boot guards | `src/production_guards.ts`: mock provider or demo/sandbox in production, `live` outside production, mock-backed + live, placeholder secrets, missing `ADMIN_API_KEY`/`SELLER_SESSION_SECRET`/webhook secret, `TRUST_PROXY_HOPS` invalid, `COMPLETION_WINDOW_MINUTES` override, `TRACKING_LEGACY_COMPAT`, debug surfaces, `RUNTIME_ROLE` mismatch, missing `CANONICAL_POSTGRES_RUNTIME=1` on hosted | the process refuses to start rather than run with a weakened posture |
| Readiness | `/readiness` = DB + every manifest migration + required tables/triggers + runtime role identity; Render swaps a deploy only on 200 | a database that is BEHIND, or a wrong DB identity, keeps the old build live |
| Auth | Supabase JWT verified against JWKS (asymmetric, iss/aud/exp/nbf, `authenticated` only), 10-min cache, fail closed without cache; admin MFA cap 5/challenge; admin login lockout 10/15 min behind an identical 401; OTP 3-attempt lock; seller/link-viewer per-account lockouts | credential guessing is bounded; an outage never opens a bypass |
| Rate limits | per-IP buckets floored at the sensitive budget; payment authorization shares the join budget (`RATE_LIMIT_JOIN_MAX` 60/min); seller mutations per seller identity (`RATE_LIMIT_SELLER_MUTATION_MAX` 90/min) and per IP (`RATE_LIMIT_SELLER_MUTATION_IP_MAX` 150/min); seller login attempts serialized per account (advisory lock, parallel Black-Sky branch); `TRUST_PROXY_HOPS`=1 so a spoofed `X-Forwarded-For` shares one bucket | budgets cannot be escaped by header rotation or parallel requests |
| Secrets | `scan:secrets` (tree + full history, masked output), logging hygiene gate, scrubbing error serializer, `.env` never in images, service-role key forbidden in app targets | a leaked shape fails CI; logs do not carry values |
| Wrong-environment protection | `scripts/lib/test_db_isolation.cjs` refuses non-local hosts for tests/preflight/rehearsal/cleanup; `destructive_target_guard.cjs` refuses hosted modes/hosts for drop/reseed scripts; doctor/repair need `--allow-hosted`; reseal needs `--allow-hosted --yes`; migration runner advisory lock + lock/statement timeouts | an operator's pasted production URL cannot drop or reseed it with a convenience script; two migration runs cannot race |
| Restorability | ledger checksums, `migrations:doctor`, rehearsal with content hashes + invariants + ACL diff + negative control, off-site encrypted dumps with pre-encryption TOC check | a broken dump is never reported restored; a missing grant is visible |
| Emergency controls | `pause_joining_emergency` (join entry), `pause_charging_emergency` (`charging.start` entry; queued `charge_deal` jobs are not re-checked by the worker), `payout_freeze` (settlement + dispatch hold), worker suspend | bounded, audited, non-destructive |

## 4. Combined-failure scenarios the system is designed to survive

Each row is 2–5 simultaneous failures. "Survive" = no money truth corruption, no evidence loss, and a documented path back to service. The proof column names what actually demonstrates it.

| # | Simultaneous failures | Expected behaviour | Proof / runbook |
|---|---|---|---|
| S1 | Provider timeout on capture **+** worker crash mid-job **+** Render restart | attempt stays `unknown`; lease expires and is reclaimed by the new worker with a new correlation; `payment_reconcile` resolves through status; no second capture | `tests/workers_retry_policy_alerting_validation.ts`, concurrency/failure groups; `PAYMENT_RECONCILIATION_RUNBOOK` §4 |
| S2 | 70-way join storm on the last units **+** a deploy in progress **+** X-Forwarded-For rotation | no oversell, no deadlock (`FOR NO KEY UPDATE`), spoofed IPs share one bucket, old build keeps serving until readiness 200 | `tests/concurrency_proof.ts`, `tests/db_join_lock_order_validation.ts`, `tests/security_trust_proxy_hops_validation.ts` |
| S3 | Migration runner killed after a self-transacting file's COMMIT **+** a second operator starts `db:migrate` **+** worker restarting | ledger row `running`; second runner waits on the advisory lock then refuses with a clear message; worker waits for a migrated DB (30 tries) and exits; `--clear-running` with fingerprint verdict resolves it | `scripts/run_migrations.cjs`, `scripts/migrations_repair.cjs`; `DISASTER_RECOVERY_RUNBOOK` §7 |
| S4 | Full DB loss **+** the operator restores with `--no-privileges` **+** forgets grants | `/readiness` may pass, business queries fail `42501`, PUBLIC EXECUTE returns on 36 functions; the ACL diff step exposes it; the grant re-apply restores an identical ACL | rehearsal steps 7g/7h; `DISASTER_RECOVERY_RUNBOOK` §6 |
| S5 | Refund issued after a payout batch was dispatched **+** provider says the payout is "processing" **+** reconcile runs | batch stays forward-only; `refund_after_payout_dispatch` case; a paid batch is never rewritten; settlement carries `mismatch_amount` | `tests/seller_payout_rail_race_validation.ts`; `PAYMENT_RECONCILIATION_RUNBOOK` §5 |
| S6 | Payout `createPayout` times out **+** worker retries the dispatch event **+** reconcile event fires | second dispatch becomes a lookup under the same correlation id (never a second `createPayout`); reconcile refuses while the unknown case is open | same |
| S7 | Admin password phished **+** MFA brute force with IP rotation **+** parallel logins | 5-guess cap per challenge, prior challenge revoked on new issue, login lockout behind identical 401; no session | `tests/admin_mfa_auth_bruteforce_validation.ts`, `tests/admin_login_auth_lockout_validation.ts` |
| S8 | Webhook secret leaked **+** attacker forges `charge_captured` for a participant not in `ChargeAttempt` **+** replays an old event | state-gated classifier ignores (`not_waiting_for_charge_capture`), `(provider,event_id)` dedupe, timestamp required on production-like | `tests/webhook_hmac_validation.ts`; `CREDENTIAL_COMPROMISE_RUNBOOK` §3.5 |
| S9 | Operator pastes the production `DATABASE_URL` into a dev shell **+** runs `npm test` / the drill / a reseed script | isolation library and destructive guard refuse non-local hosts; doctor/repair refuse without `--allow-hosted` | `scripts/lib/test_db_isolation.cjs`, `scripts/lib/destructive_target_guard.cjs` |
| S10 | Grow key rotated **+** in-flight attempts sealed under the old key **+** a settle is due | keyring opens old seals via `PREVIOUS_KEYS`; reseal tool reports `retire_safe` only when no reference needs the old kid | `tests/grow_payment_reference_keyring_validation.ts`; `CREDENTIAL_COMPROMISE_RUNBOOK` §3.7 |
| S11 | Supabase Auth outage **+** web redeploy (cold JWKS cache) **+** sellers trying to log in | new logins fail closed; buyer OTP joins, webhooks and the worker continue; no bypass | `INCIDENT_RESPONSE_RUNBOOK` §6.6 |
| S12 | Deal paused by the seller below threshold **+** deadline passes **+** worker was down for hours | `deadline_check` defers before the state filter and fails the deal at the deadline on resume (`ClosedForJoining → Failed`); holds released via the release rail; late joins refused by DB clock | `tests/db_deal_deadline_threshold_validation.ts` (077) |
| S13 | Render loss **+** off-site backups never provisioned **+** Supabase healthy | full recovery from `render.yaml` + re-entered secrets; no data loss | `DISASTER_RECOVERY_RUNBOOK` §3 "Render loss" |
| S14 | Corrupted or truncated dump **+** restore attempted | `pg_restore --exit-on-error` fails; rehearsal chain aborts; workflow's pre-encryption `pg_restore --list` refuses to upload a dump without the money tables | rehearsal; workflow `OFFSITE_BACKUP_VERIFY_FAIL` |

## 5. What the system is NOT designed to survive (owner-visible residual risk)

| # | Scenario | Why not | Mitigation available |
|---|---|---|---|
| N1 | Supabase project loss **before** the `OFFSITE_BACKUP_*` secrets are provisioned and with no verified platform backup | there is no copy of the data | OWNER ACTION: `BACKUP_RESTORE_RUNBOOK` §2–§3 today |
| N2 | Loss of the off-site age private identity (both offline copies) | every off-site object is undecryptable by design | two separate offline homes; quarterly availability drill |
| N3 | Compromise of the owner's Supabase/Render/GitHub account with MFA off | full control; backups can be deleted from the same account | owner MFA; separate storage account for the bucket; object lock/versioning |
| N4 | Loss of `auth.users` (sellers/admins) and Storage objects | outside every dump we take | re-invite sellers; imagery re-upload; OPEN tooling |
| N5 | A provider that answers "success" twice for one idempotency key, or captures without an event and without a status | money moved outside our evidence | settlement horizon + manual case; provider contract; never auto-repeat |
| N6 | Sustained volumetric DDoS | app-level limits protect the DB, not bandwidth; no WAF/CDN on the current Render plan | suspend web; owner infra decision |
| N7 | A partially charged deal whose `charge_deal` budget was exhausted during a long provider outage | no re-dispatch path exists; needs an owner-decided procedure | `pause_charging_emergency`, escalate (OPEN) |
| N8 | A bug that writes a wrong-but-schema-valid money row inside a correct transaction (e.g. wrong fee arithmetic) | DB guards check shape, not business arithmetic | daily `db:money-invariants` (detects, does not prevent) |
| N9 | Two workers deliberately started against one DB with `WORKER_MONEY_CONCURRENCY>1` | serialization between capture and reconcile for a participant is removed | never do it; heartbeats show two `ready` rows |
| N9b | An operator pauses charging with `pause_charging_emergency` while `charge_deal` jobs are already queued | the worker does not re-check the flag; queued captures still run | suspend the worker together with the flag (OPEN: worker-side check) |
| N10 | Single-operator unavailability during an S1 | second-approval controls cannot execute; nobody rotates | pre-provisioned second admin identity; written runbooks (this set) |
| N11 | Region loss with no cross-region project | recovery = new project in another region, one working day floor, Auth and Storage not restored | accept, or fund a cross-region copy |
| N12 | Silent hosted backup failure at Supabase | we do not observe it | weekly manifest check covers only layer B |

## 6. How to use this document

- Before real money: every N-row with an OWNER ACTION mitigation must have the action done or explicitly accepted in writing by the owner.
- After every incident: add the observed combination to §4 if it was survived with evidence, or to §5 if it was not.
- After every hardening PR: update the proof column; a row without a test or runbook reference is a claim, not a control.
