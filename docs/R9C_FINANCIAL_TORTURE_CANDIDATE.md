# R9C — FINANCIAL TORTURE CANDIDATE (R9C payment lifecycle refreshed onto the latest master)

**Status: CANDIDATE ONLY. `SAFE_TO_MERGE_TO_MASTER = NO`. `SAFE_FOR_REAL_MONEY = NO`. `READY_FOR_R10 = NO`.**
Real money 0 · real Grow calls 0 · real capture / settle / refund / release / recovery 0 · real SMS 0 · real business
e-mail 0 · real invoices 0 · no deployment · canonical staging untouched · migration 063 never applied to staging.

| | |
|---|---|
| Master at program start | `60ebf6d64fb0d5909ae98fa335a4a27ad45c9172` (verified against `origin/master`, worktree clean) |
| Pre-financial resilience branch | `claude/pre-financial-resilience` @ `82f9171` = master + `b2d67ff` (deal.cancel `serializeOnEntity`; pg checked-out client error guard) + status record |
| R9C source | `claude/r9c-integration-candidate` @ `3f00edb5fd0a19b38c6da31ef48aeb65f3365bec` (itself the R9C red-team ancestry `196869c…f025d3f` ported onto `123bbf9` + SR-1/SR-2) |
| This branch | `claude/r9c-financial-torture-candidate`, created from `82f9171`; R9C commits cherry-picked with `-x` in their original order |
| Worktree | `C:\Users\Lenovo\Documents\C-ton-financial-torture` (own `node_modules`, own `.env`; disposable databases only) |
| Master left untouched | YES — never committed to, reset or pushed |

---

## 1. What was ported (and how it was proven complete)

The ten commits `git rev-list --reverse 123bbf9..3f00edb` were cherry-picked one by one:

| # | Source | Subject | Result |
|---|---|---|---|
| 1 | `58c60e3` | fix(r9c): ONE durable provider-operation identity per money attempt + reconcile-before-new-operation + pre-I/O lease fence | clean |
| 2 | `89ac666` | test(r9c): terminal-state late-event safety + financial constitution boundary/rounding sweep | clean |
| 3 | `b9785f6` | fix(r9c): money state + fee-ledger truth commit atomically | clean |
| 4 | `46aee6d` | docs(r9c): system red-team report + PROJECT_STATUS section | `PROJECT_STATUS.md` conflict → master's file kept (see §2) |
| 5 | `b5fea96` | fix(r9c): durable money-operation lifecycle (063) — C1 race + C2 post-dispatch 503/429 | clean |
| 6 | `5aa7bca` | test(r9c): Codex C1/C2 counterexamples, full-rail ambiguity matrix, Grow fail-closed proofs | clean |
| 7 | `307f7fa` | docs(r9c): independent review outcome and remediation | `PROJECT_STATUS.md` conflict → master's file kept |
| 8 | `7dd2b1c` | fix(r9c-integration): owner-fenced money settlement closes a stale-owner double capture (SR-1) | clean |
| 9 | `e5cad0c` | test(r9c-integration): stale-owner counterexample (SR-1) | clean |
| 10 | `3f00edb` | docs(r9c-integration): integration candidate record | `PROJECT_STATUS.md` conflict → master's file kept |

**Equivalence proof (both directions, normalised patch text — index lines and hunk offsets stripped):**

* `git diff 3f00edb <candidate> -- . ':!PROJECT_STATUS.md'` **≡** `git diff 123bbf9 82f9171 -- . ':!PROJECT_STATUS.md'`
  (what changed between the old candidate and the new one is exactly master's hardening + publish fix + Phase 1);
* `git diff 82f9171 <candidate> -- . ':!PROJECT_STATUS.md'` **≡** `git diff 123bbf9 3f00edb -- . ':!PROJECT_STATUS.md'`
  (what R9C adds to the new base is exactly what it added to the old base).

Both comparisons were `IDENTICAL` (10 208 and 6 352 normalised patch lines respectively). Nothing of R9C was lost and
nothing of master's newer behaviour was rolled back.

## 2. Conflict log

Only `PROJECT_STATUS.md` conflicted (three docs commits). Resolution: master's `PROJECT_STATUS.md` is authoritative
for product status and was kept verbatim; the R9C narrative arrives through `docs/R9C_CLAUDE_SYSTEM_RED_TEAM.md` and
`docs/R9C_INTEGRATION_CANDIDATE.md` (both ported unchanged) and this program's status is recorded in its own section
of `PROJECT_STATUS.md` (financial torture program). No code or migration conflicts.

## 3. Migrations

| Migration | State |
|---|---|
| `061_seller_customer_inquiries.sql` (P0.7) | PRESERVED |
| `062` | RESERVED for the Codex Amazon product branch — not consumed, not present, manifest comment intact |
| `063_payment_operation_lifecycle.sql` (R9C) | PRESERVED |

`npm run test:migrations-isolated` on a fresh disposable database: `CI_MIGRATION_REPORT_PASS expected_migrations=58 total=58
succeeded=58 rerun=pass`, `ISOLATED_MIGRATION_PROOF_PASS fresh_install=pass repeat=pass checksum_ledger=pass drift=0
production_changes=0`.

## 4. What must survive (and did)

| Requirement | Proof on the candidate |
|---|---|
| master hardening | security/route gates unchanged; `npm run lint`, `scan:backend`, `scan:payment`, `scan:runtime-ddl`, `gate:architecture` PASS |
| concurrent publish fix | `publish_outbox_concurrency_validation.ts` 21/21 inside concurrency 6/6 |
| Phase 1 resilience | `cancel_outbox_concurrency_validation.ts` 22/22, `db_client_error_process_survival_validation.ts` 10/10 |
| R9C lifecycle | payments group 37/37 (36 R9C + SR-1 proof) before the lab was added |
| no P0.7 regression | unit 12/12, db 7/7 (P0.7 proofs live in unit/api; full suite in the final regression) |
| payment constitution | `platform_fee_boundary_rounding_validation.ts`, `platform_fee_payments_8_percent_validation.ts` PASS; lab economics under explicit VAT |

## 5. Changes made on this branch beyond the port

See `docs/FINANCIAL_TORTURE_LAB.md` §3: **F-1** recovery pre-flight (`verifyOriginalCaptureBeforeRecovery`),
**F-2** finalize guard for unresolved captures, **F-3** HTTP webhook late-effect parity — each with a deterministic
regression in the lab. No migration was added or renumbered; no economics constant moved.

## 6. Reviews still owed

1. Fresh independent adversarial review of the exact candidate SHA (separate conversation and worktree).
2. Codex independent re-review including F-1/F-2/F-3, which Codex has never seen.
3. Grow sandbox proof of settle/refund idempotency and exact-operation status.
4. Owner decision on merge order: `claude/ci-request-id-flake-repair` (CI stability) and
   `claude/pre-financial-resilience` are independent of the financial work and can be reviewed first.
