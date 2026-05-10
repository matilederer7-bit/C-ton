# Post E2E Refactor Audit

Status: PASS as a surgical cleanup. The Full E2E Gate from commit `c3f416c` continues to pass. No state machine, money logic, contract or DB schema was changed.

## 1. Goal of this pass

After the Full E2E Gate produced `FULL_E2E_GATE_PASS_READY_FOR_PROVIDER_SANDBOX`, run a careful internal audit and apply only surgical, risk-low cleanup. Do not reopen architecture, do not refactor proven behaviour, and do not weaken any security or money invariant. The bias is: when in doubt, leave it alone.

The aim is to cut a tiny amount of measurable dead surface (an empty backup file in `src/`) and to record, in writing, what was deliberately left untouched and why — so that any future "refactor temptation" against the same area starts from a documented decision instead of a fresh argument.

## 2. What was scanned

- `src/**` source layout, file sizes and function inventory.
- `frontend/app.js` and `frontend/styles.css`.
- `tests/**` harness boilerplate, env-set-before-import contract, port allocation, `DISABLE_OUTBOX_WORKER` usage.
- Centralised security and identity modules: `admin_identity.ts`, `participant_tracking_security.ts`, `payment_attempt_helpers.ts`, `runtime_config.ts`, `payment_provider.ts`, `payout_rail.ts`, `notification_dispatch.ts`, `notification_service.ts`, `notification_templates.ts`.
- Cross-file scan for repeated patterns: cache-control / no-store headers, security headers, admin auth, MFA window, tracking-token validation, seller ownership checks, money formatting, CSV/Excel escaping, Mission Control collectors, readiness verdict shape.
- TODO/FIXME/HACK/LEGACY markers and zero-byte files in `src/`.
- Untracked tree (`git ls-files --others --exclude-standard`) — clean.
- `git status` — clean, branch in sync with `origin/master`.
- Untracked / runtime artefacts (`.tmp_*`, `uploads/`, `.demo_dist/`, `.tmp_edge_profile*`) — all already covered by `.gitignore`. Nothing in the repo working tree leaks runtime state into git.

## 3. What was changed in this pass

Only one file was touched, and it is a deletion:

| Change | File | Why |
|---|---|---|
| `git rm` | `src/app_vscode_backup.ts` | Zero-byte tracked file, no imports anywhere in `src/`, `tests/`, `frontend/`, `scripts/`, `docs/`. Pure leftover from a historical IDE snapshot. Removing it does not change any compiled output. |

That is the entire surgical change set. It produces no diff in compiled JavaScript, removes no behaviour, and changes no contract.

## 4. What was deliberately NOT changed (and why)

The audit identified several refactor temptations. Each one was rejected on risk, even though the aesthetic appeal exists. They are recorded here so a later pass does not re-derive the same temptation without seeing why this pass declined it.

### 4.1 `src/frontend_runtime.ts` (~6960 lines)

Tempting target for splitting into per-surface modules (public deal, seller workspace, admin dashboard, buyer tracking, deal images, …).

**Skipped.** Reasons:
- Multiple test suites assert on substring or regex shape of the source file (cache headers, no-store policy, security headers, ownership checks). A split risks breaking these contracts in invisible ways.
- The Full E2E Gate, frontend browser smoke, mvp completion, mission control, admin control plane, security identity tracking and adversarial resilience suites all currently pass against this layout. There is no proven bug in this file that requires touching it.
- The biggest, single-file shape inside `frontend_runtime.ts` (route registration + render glue + per-surface helpers) is mature and reasonably grouped section-by-section. The win is purely aesthetic.

### 4.2 `src/app.ts` (~3426 lines)

Same reasoning. The cache-control, security-headers, webhook ingestion and admin-permission wiring inside this file is referenced verbatim by the cache-policy and security-hardening tests. A move-only refactor would still risk perturbing import order and Fastify hook registration order.

### 4.3 `frontend/app.js` (~6630 lines)

Tempting target for splitting into per-screen ES modules. Skipped:
- This file is delivered to the browser as a single revalidated asset under the cache policy gated by `tests/cache_policy_validation.ts`.
- A split changes asset count and HTTP semantics. That is exactly the kind of change that should land with a deliberate bundling decision, not as a side effect of a cleanup pass.
- No proven bug, no proven performance issue, no proven readability issue in the audit window.

### 4.4 Participant tracking-token validation (two near-duplicate blocks in `frontend_runtime.ts`)

There are two adjacent blocks (around lines 6036–6054 and 6274–6294) that:
1. Call `extractTrackingToken(req)`.
2. Call `trackingMode()`.
3. If the token is present, call `verifyParticipantTrackingAccess` and throw a 403 on failure.
4. If the token is missing and legacy is not allowed, throw `tracking_token_required` with status 401.

A `requireTrackingTokenAccess(req, c, { participant_id, deal_id, purposes, attachErrorCode })` helper would dedup ~30 lines.

**Skipped (medium risk).** Reasons:
- The two blocks differ in subtle ways: one attaches `err.code = ...` and the other does not. The downstream error handler shape may differ between contexts, and the security-identity-tracking suite asserts on participant tracking access behaviour. Even a "mechanical" extraction could shift one of those contracts unintentionally.
- The duplication cost (≈30 lines) is small relative to the file size, and the unification is reversible later if a third call site appears.
- This is the exact area that the Full E2E Gate covers most strictly (`participant_tracking_requires_valid_token_validation`, `participant_tracking_wrong_token_denied_validation`, `participant_tracking_expired_token_denied_validation`, `participant_tracking_legacy_blocked_in_production_validation`). The principle "do not touch tracking-token cryptographic/storage contract without proven bug" applies.

### 4.5 Test harness `process.env.X = ...` boilerplate before `await import("../src/app.js")`

Roughly 30 test files repeat the same 3–5 lines of env setup followed by a dynamic import. A `createTestAppWithEnv(...)` helper could centralise this.

**Skipped.** Reasons:
- The reason this boilerplate exists in each file is precisely the bug that the FULL E2E pass closed: `preprod_torture` and `full_system_qa` were failing because the harness imported the app **before** disabling the outbox worker. Centralising the setup risks reintroducing exactly that ordering hazard if a future maintainer accidentally evaluates the helper after import time.
- The repetition is loud-on-purpose: a future contributor can see the env contract one screen above the dynamic import every single time. That clarity is worth more than the line count.

### 4.6 Empty filesystem-only directories `src/services/`, `src/routes/`, `src/workers/`

These exist on disk but are not tracked by git (`git ls-files` returns nothing for them). They are local filesystem artefacts only.

**Skipped.** Reasons:
- They never enter the repository, so they cannot mislead a reader of the source.
- Deleting them locally would dirty the working tree without producing any commit. They will disappear when the local checkout is rebuilt.
- `tsconfig.json` and `tsconfig.test.json` glob `src/**/*.ts` — empty directories produce no compile input.

### 4.7 Cache-control / security-header centralisation

Two call sites set `cache-control: no-store` (`src/app.ts:2197`, `src/frontend_runtime.ts:712`). One sets the immutable `cache-control: public, max-age=31536000, immutable` for deal images (`src/app.ts:2360`). One sets `x-content-type-options: nosniff` (`src/app.ts:2154`).

**Skipped.** Reasons:
- `tests/cache_policy_validation.ts` asserts on the literal regex `reply\.header\("cache-control", "no-store"\)` against the source file. Extracting a helper called e.g. `applyNoStoreHeaders(reply)` would silently break the cache-policy contract test.
- `tests/security_hardening_validation.ts` does the same for security headers.
- Tests are doing this on purpose: anti-drift tripwires. Refactoring around them would either need test edits (weakens the gate) or an exotic name pattern (worse than the original).

### 4.8 `app_vscode_backup` — only candidate that survived risk gating

The single change in this pass.

## 5. Why no aggressive refactor is justified right now

- The system passed the Full E2E Gate on `c3f416c`. That gate covers seller, buyer, admin, payment, outbox, webhook, recovery, support, storage, legal/trust, mission control, control plane, security identity tracking, scale, provider readiness and adversarial resilience.
- Many of the apparent "duplications" are not duplications — they are anti-drift assertions, doubled deliberately so that test regexes can pin them in place.
- The next material step is the **Provider Sandbox / Live Money Validation** gate. That gate will exercise real provider credentials, real captures, real refunds, real payouts. The right time to clean provider-adjacent code is **after** that gate is green — when the contracts are concrete instead of inferred.
- Any refactor that perturbs Fastify hook order, import order, or env-set-before-import discipline is a regression vector for already-fixed test isolation bugs.

## 6. How proven E2E behaviour was preserved

- Only a zero-byte tracked file was removed.
- `tsc --noEmit` and `tsc -p tsconfig.test.json` both pass.
- The 0-byte file had no imports, no exports, and no inclusion side effect under either `tsconfig`.
- After the deletion, the same suites that proved the Full E2E Gate continue to pass (see §7).

## 7. Tests run on this pass

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | PASS |
| `npx tsc -p tsconfig.test.json --noEmit` | PASS |
| `npm run test:cache-policy` | PASS |
| `npm run test:scale-readiness` | PASS |
| `npm run test:provider-live-money-readiness` | PASS |
| `npm run test:security-hardening` | PASS |
| `npm run test:adversarial` | PASS |
| `npm run test:full-e2e-gate` | PASS |
| `npm run test:mvp-completion` | PASS |
| `npm run test:mission-control` | PASS |
| `npm run test:admin-control-plane` | PASS |
| `npm run test:security-identity-tracking` | PASS |
| `npm run test:frontend-browser-smoke` | PASS |
| `npm run test:preprod-torture` | PASS |
| `npm run test:full-system` | PASS |
| `npm run test:seller-onboarding` | PASS |
| `npm run test:storage-readiness` | PASS |
| `npm run test:notifications-readiness` | PASS |
| `npm run test:support-operations` | PASS |
| `npm run test:admin-intervention` | PASS |
| `npm run test:legal-trust` | PASS |
| `npm run test:production-launch-readiness` | PASS |
| `npm audit --omit=dev` | unchanged from prior gate (1 high in `fast-uri`, no new advisory introduced by this pass) |
| `npm audit` | unchanged from prior gate |

No bootstrap was needed because no migration was added.

## 8. Skipped candidates summary

| Candidate | Risk | Decision | Reason |
|---|---|---|---|
| `src/app_vscode_backup.ts` (delete empty file) | low | **done** | 0 bytes, no references |
| `frontend_runtime.ts` split | high | document only | tested by exact regex; central glue file |
| `app.ts` split | high | document only | cache + security headers regex-pinned by tests |
| `frontend/app.js` split | high | document only | bundling/runtime + cache asset semantics |
| Tracking-token validation helper | medium | document only | error-contract differs subtly between call sites; covered by security-identity-tracking gate |
| Test harness env helper | medium | document only | env must be set before dynamic import; centralisation risks regressing fixed test-isolation bug |
| Cache-control / security-header helper | medium | document only | tests assert on literal source patterns as anti-drift tripwires |
| Empty `src/services/`, `src/routes/`, `src/workers/` directories | n/a | document only | not tracked in git, no compile input |

## 9. Recommended follow-ups, but only AFTER Provider Sandbox passes

These are explicitly NOT to be done now. They become reasonable only once Provider Sandbox is green and the live-money provider contract is concrete:

1. Once `payment_provider.ts`, `payout_provider.ts` and webhook ingestion have proven-against-real-sandbox shapes, consider a small `provider_request_helpers.ts` to centralise provider-error masking, correlation id propagation and `provider_request_id`/`provider_event_id` fields.
2. Once provider readiness is real, `provider_live_money_readiness_validation.ts` can be tightened from contract assertions to behavioural assertions, and the duplicated readiness-shape construction can be extracted from `admin_mission_control.ts` if real provider data exposes a clear cleavage.
3. Only after the provider gate is green and live-money is exercised once, consider whether the participant tracking-token validation extraction in §4.4 is worth doing. The provider gate may surface a third call site that justifies it.
4. `frontend_runtime.ts` and `frontend/app.js` size reductions should be paired with a deliberate bundling decision (e.g. ES module split delivered as multiple cached assets) rather than treated as pure code reorganisation. Defer to a frontend pass that is explicitly chartered to do that.

## 10. Verdict

`POST_E2E_REFACTOR_PASS` — surgical cleanup only. No state machine, money logic, identity/MFA/RBAC, tracking-token cryptographic contract, outbox/worker semantics, webhook idempotency, DB schema or live-money behaviour was modified. The system remains ready for Provider Sandbox / Live Money Validation.
