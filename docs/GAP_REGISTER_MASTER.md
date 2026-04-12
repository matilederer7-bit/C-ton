# Gap Register Master

## Executive Summary

This document replaces optimistic readiness wording with a stricter closure map.

- Total real gaps mapped: `14`
- `P0` gaps: `7`
- `P1` gaps: `5`
- `P2` gaps: `2`
- `P3` gaps: `0`

Current conclusion:

- The product is still suitable for controlled demo / preview.
- The product is not ready for open production launch.
- The most serious blockers are seller authentication, live payment rails, OTP / SMS production hardening, invoice/accounting issuance, and internal-surface leakage.

What is intentionally **not** treated as a gap here:

- Stage 1 Hebrew / RTL closure.
- Stage 2 visual closure on the primary buyer and seller surfaces.
- Stage 3 public legal pages and public trust wrapper.
- The isolated hash-based QA hook itself, as long as it remains minimal and test-only.
- The core state-machine / outbox / idempotency runtime, which was already validated and is not the current closure problem.

## Gap List

### GAP-01: No real seller authentication

- Classification: `auth / identity`, `security`, `admin / seller surfaces`
- Severity: `Critical`
- Priority: `P0`
- Production blocker: `Yes`
- Demo / preview blocker: `No`
- What exists today:
  seller context is persisted in `localStorage`, sent via `x-seller-id`, can also come from `seller_id` query params, and seller-scoped routes only check context consistency.
- What is actually missing:
  real login, session issuance, identity proof, tenant isolation, and server-side trust that the caller is the seller they claim to be.
- Evidence:
  `frontend/app.js:2999-3035`, `src/frontend_runtime.ts:130-173`, `src/frontend_runtime.ts:488-511`, `docs/PASS7_SELLER_IDENTITY_MINIMUM_HARDENING_2026-04-10.md`
- Source of truth requiring closure:
  Stage 4 readiness explicitly says seller identity is only minimum context scoping and is not sufficient for open multi-tenant launch; public product operation requires real seller identity.
- Risk if left open:
  seller impersonation, cross-seller workspace access, unauthorized publish / management actions, and no credible production tenancy boundary.
- Likely repair path:
  introduce real seller auth, server-trusted session binding, and ownership enforcement based on authenticated identity rather than caller-selected seller ids.
- Dependencies:
  seller account model, session/auth provider decision, permission model.
- Estimated size:
  `Subproject`

### GAP-02: Payment authorization rail is not truly live

- Classification: `payments`, `ops / deploy / env / flags`
- Severity: `Critical`
- Priority: `P0`
- Production blocker: `Yes`
- Demo / preview blocker: `No`
- What exists today:
  `mock-backed` mode is the active default; `provider-ready` exists as a readiness contract only.
- What is actually missing:
  a real provider HTTP client, real authorization requests, real credentials lifecycle, and live provider error semantics.
- Evidence:
  `src/runtime_config.ts:29-38`, `src/payment_provider.ts:83-159`, `src/payment_provider.ts:162-206`, `src/operational_readiness.ts:60-83`, live `/health/integrations`
- Source of truth requiring closure:
  `docs/REAL_PAYMENT_AND_RECONCILIATION_DECISION.md`, `docs/STAGE4_OPERATIONAL_READINESS_MAP.md`, product/payment readiness requirements.
- Risk if left open:
  the public payment step looks operational but never touches a real commercial payment rail.
- Likely repair path:
  choose one provider, implement real authorization transport in `src/payment_provider.ts`, store provider correlation ids safely, and close env/secret provisioning.
- Dependencies:
  provider selection, credentials, webhook contract, reconciliation mapping.
- Estimated size:
  `Subproject`

### GAP-03: Capture / recovery / refund rails and provider webhook matrix are still incomplete

- Classification: `payments`, `state machine / enforcement`, `observability / health`
- Severity: `Critical`
- Priority: `P0`
- Production blocker: `Yes`
- Demo / preview blocker: `No`
- What exists today:
  the state machine, outbox, payment attempts, webhook persistence, and minimal reconciliation path are real inside the repo.
- What is actually missing:
  live provider-backed capture, recovery, refund, and the full provider-specific webhook event matrix beyond the minimal supported set.
- Evidence:
  `src/payment_provider.ts:208-231`, `src/payment_reconciliation.ts:75-123`, `src/frontend_runtime.ts:1229-1240`, `docs/REAL_PAYMENT_AND_RECONCILIATION_DECISION.md:31-45`
- Source of truth requiring closure:
  Stage 4 readiness and real payment / reconciliation decision documents.
- Risk if left open:
  final money movement and failure handling remain simulated or partial, so the system cannot close real-world money states safely.
- Likely repair path:
  wire provider capture/recovery/refund APIs, extend the webhook catalog, and validate reconciliation end to end against provider callbacks.
- Dependencies:
  GAP-02, provider selection, settlement policy.
- Estimated size:
  `Subproject`

### GAP-04: OTP / SMS rail is internal-only and exposes a static development code

- Classification: `auth / identity`, `notifications`, `security`
- Severity: `Critical`
- Priority: `P0`
- Production blocker: `Yes`
- Demo / preview blocker: `No`
- What exists today:
  OTP sessions are stored in-app and verified against a fixed code.
- What is actually missing:
  real SMS delivery, production OTP generation, delivery status, abuse controls, and removal of development secrets from the client-facing API.
- Evidence:
  `src/frontend_runtime.ts:80-81`, `src/frontend_runtime.ts:1662-1692`, `src/frontend_runtime.ts:1718-1731`, `src/operational_readiness.ts:93-99`, live `POST /api/otp/start` returns `development_code: "123456"`
- Source of truth requiring closure:
  product and UX expect OTP as a real supporting trust rail, not a development bypass.
- Risk if left open:
  anyone who knows the static code can pass OTP; this is not a production-grade identity or anti-abuse step.
- Likely repair path:
  connect a real SMS provider, generate per-session OTP codes server-side, remove `development_code` from non-internal environments, and add delivery / retry observability.
- Dependencies:
  SMS provider, runtime mode policy, abuse/rate-limit decisions.
- Estimated size:
  `Medium` to `Subproject`

### GAP-05: No real invoice / accounting issuance rail

- Classification: `receipts / accounting`, `payments`, `drift between docs and code`
- Severity: `Critical`
- Priority: `P0`
- Production blocker: `Yes`
- Demo / preview blocker: `No`
- What exists today:
  seller-facing receipt summaries and internal computed receipt rows.
- What is actually missing:
  legal invoice issuance, numbering authority, accounting/tax integration, and external delivery to buyer / seller.
- Evidence:
  `src/frontend_runtime.ts:770-847`, `src/operational_readiness.ts:107-113`, `docs/STAGE4_OPERATIONAL_READINESS_MAP.md`, live `/health/integrations`
- Source of truth requiring closure:
  Stage 4 readiness explicitly lists real invoice/accounting rail as open.
- Risk if left open:
  financial completion may look finished in-product while legal/accounting issuance is still not real.
- Likely repair path:
  choose invoice/accounting rail, map issuance timing to deal completion states, and add delivery and audit references.
- Dependencies:
  payment completion truth, seller/entity compliance data, accounting provider decision.
- Estimated size:
  `Subproject`

### GAP-06: Internal debug deal surface is exposed without the promised runtime gate

- Classification: `debug leakage`, `security`, `ops / deploy / env / flags`
- Severity: `Critical`
- Priority: `P0`
- Production blocker: `Yes`
- Demo / preview blocker: `No`
- What exists today:
  `/debug/deals/:id` returns deal, participants, outbox, DLQ, and payment attempts directly from `src/app.ts`.
- What is actually missing:
  a real runtime gate on the app server path, or removal from public runtime entirely.
- Evidence:
  `src/app.ts:1219-1254`, live `GET /debug/deals/9e594fc6-7713-4005-8b42-edaf0bc520ed -> 200`, while `docs/STAGE4_OPERATIONAL_READINESS_MAP.md` describes this surface as gated outside demo-preview.
- Source of truth requiring closure:
  Stage 4 readiness and release-readiness docs describe debug as controlled-only.
- Risk if left open:
  operational internals are exposed through a simple public route if the app is reachable.
- Likely repair path:
  apply the same explicit gate at the app-server route, then validate no public live path exposes it unintentionally.
- Dependencies:
  runtime mode policy, internal-ops access policy.
- Estimated size:
  `Small`

### GAP-07: Webhook secret policy is still demo-grade

- Classification: `security`, `payments`, `ops / deploy / env / flags`
- Severity: `Critical`
- Priority: `P0`
- Production blocker: `Yes`
- Demo / preview blocker: `No`
- What exists today:
  `PAYMENT_WEBHOOK_SECRET` falls back to `mock-webhook-secret`, and tests / docs rely on that default.
- What is actually missing:
  a mandatory production secret policy, secret rotation process, and env validation that refuses unsafe defaults in non-demo environments.
- Evidence:
  `src/runtime_config.ts:36`, tests such as `tests/real_integrations_validation.ts`, `tests/full_system_qa_validation.ts`, live `/health/integrations`
- Source of truth requiring closure:
  real payment/webhook readiness requires production-grade secret handling.
- Risk if left open:
  webhook authenticity is anchored to a known demo default instead of a deployment-specific secret boundary.
- Likely repair path:
  require explicit secrets outside demo-preview, fail startup on unsafe defaults, and document rotation.
- Dependencies:
  deployment mode hardening, provider selection.
- Estimated size:
  `Small` to `Medium`

### GAP-08: Email notifications remain log-only

- Classification: `notifications`, `ops / deploy / env / flags`
- Severity: `High`
- Priority: `P1`
- Production blocker: `Yes`
- Demo / preview blocker: `No`
- What exists today:
  notification events exist, but dispatch only logs.
- What is actually missing:
  actual email provider integration, templates, sender/domain setup, delivery status, and failure handling.
- Evidence:
  `src/notification_service.ts:19-45`, `src/operational_readiness.ts:100-106`, live `/health/integrations`
- Source of truth requiring closure:
  UX defines screen as source of truth, but SMS and email are still required supporting trust rails.
- Risk if left open:
  buyers and sellers receive no actual email support notifications around participation and deal outcomes.
- Likely repair path:
  integrate one email provider, define the minimum required templates, and add delivery status surfaces.
- Dependencies:
  notification event catalog, sender/domain setup.
- Estimated size:
  `Medium`

### GAP-09: Repeat-join behavior is in drift between product truth and live join implementation

- Classification: `DB / schema / migrations`, `drift between docs and code`, `frontend / UX / flow`
- Severity: `High`
- Priority: `P1`
- Production blocker: `Yes`
- Demo / preview blocker: `No`
- What exists today:
  product decisions, canonical bootstrap SQL, and automated tests all say the same buyer may join the same deal multiple times.
- What is actually missing:
  final alignment of the active join mutation path with that decision.
- Evidence:
  `docs/KNOWN_GAPS_AND_DECISIONS.md:5-8`, `scripts/init_db.sql:8`, `tests/full_product_surface_validation.ts:210-230`, but `src/app.ts:1058-1061` still uses `ON CONFLICT (deal_id, buyer_id) DO UPDATE`.
- Source of truth requiring closure:
  product spec and known decisions explicitly reject `UNIQUE (deal_id, buyer_id)` as a product rule.
- Risk if left open:
  repeat purchases can collapse into an update instead of a new participant row, causing product-policy drift and financial ambiguity.
- Likely repair path:
  adjudicate canonical runtime truth, then align schema, mutation SQL, and tests together.
- Dependencies:
  DB constitution decision, migration plan, data backfill strategy if uniqueness exists in any live DB.
- Estimated size:
  `Medium`

### GAP-10: Seller publish flow still lacks the required legal acknowledgment step

- Classification: `frontend / UX / flow`, `drift between docs and code`, `legal / trust continuity`
- Severity: `High`
- Priority: `P1`
- Production blocker: `Yes`
- Demo / preview blocker: `No`
- What exists today:
  seller surfaces explain the legal/trust context and point to public legal pages, but publish itself does not require an explicit acknowledgment action.
- What is actually missing:
  the required "read and confirm" checkpoint before publishing, and a decision on whether that acknowledgment must remain UI-only or be persisted / enforced.
- Evidence:
  `frontend/app.js:1843`, `frontend/app.js:1893`, `src/app.ts:989-1022`, product and UX docs call out pre-publish terms acknowledgment.
- Source of truth requiring closure:
  product spec and UX require seller-side acknowledgment before publish.
- Risk if left open:
  the seller publish flow is materially weaker than the documented trust/legal requirement.
- Likely repair path:
  first decide whether this is UI evidence only or a backend-enforced contract, then implement at the appropriate layer.
- Dependencies:
  legal/product decision on enforceability.
- Estimated size:
  `Small` to `Medium`

### GAP-11: Runtime defaults and seed assumptions are still demo-oriented

- Classification: `ops / deploy / env / flags`, `preview / demo mode`, `seed data`, `admin / affiliate / seller surfaces`
- Severity: `High`
- Priority: `P1`
- Production blocker: `Yes`
- Demo / preview blocker: `No`
- What exists today:
  default deployment mode is `demo-preview`; seller and affiliate defaults are auto-seeded; seller accounts can auto-create; default payout masks and default seller workspace remain active assumptions.
- What is actually missing:
  a clean production bootstrap path that does not rely on demo defaults or implicit account creation.
- Evidence:
  `src/runtime_config.ts:38-39`, `src/product_surface_support.ts:3-6`, `src/product_surface_support.ts:163-194`, `src/frontend_runtime.ts:130-154`, `src/operational_readiness.ts:127-138`
- Source of truth requiring closure:
  Stage 4 readiness itself marks seed/default behavior as only safe for demo / controlled first-run bootstrap.
- Risk if left open:
  production environments can accidentally retain demo semantics or default identities as real operational assumptions.
- Likely repair path:
  split demo bootstrap from production bootstrap, require explicit deployment mode, and disable seller auto-create / default demo entities in production.
- Dependencies:
  auth model, deployment policy, environment hardening.
- Estimated size:
  `Medium`

### GAP-12: Canonical source-of-truth drift still exists across docs, DB rules, and live code

- Classification: `documentation gaps`, `drift between docs and code`, `DB / schema / migrations`
- Severity: `High`
- Priority: `P1`
- Production blocker: `Yes`
- Demo / preview blocker: `No`
- What exists today:
  several archival and stage documents still frame the system as "mostly ready with non-blocking gaps", while live code still contains contradictions such as ungated debug exposure and repeat-join conflict logic.
- What is actually missing:
  one enforced canonical register that supersedes stale optimism and resolves contradictions across product, UX, DB constitution, and live runtime.
- Evidence:
  `docs/REAL_PAYMENT_AND_RECONCILIATION_DECISION.md:5`, `docs/KNOWN_GAPS_AND_DECISIONS.md:5-8`, `docs/STAGE4_OPERATIONAL_READINESS_MAP.md:109`, `src/app.ts:1219-1254`, `src/app.ts:1058-1061`
- Source of truth requiring closure:
  the current task itself and the readiness mandate to eliminate drift, not mask it.
- Risk if left open:
  teams make launch decisions off mixed truths and may miss real blockers.
- Likely repair path:
  adopt this master register as the current canonical closure map and update the conflicting docs after each real closure.
- Dependencies:
  decision on which docs remain canonical vs archival.
- Estimated size:
  `Medium`

### GAP-13: No dedicated rollout controls or kill switch beyond env toggles and process stop

- Classification: `ops / deploy / env / flags`, `security`
- Severity: `Medium`
- Priority: `P2`
- Production blocker: `No`
- Demo / preview blocker: `No`
- What exists today:
  behavior is mostly env-driven; release docs explicitly say there is no dedicated kill switch and no formal feature-flag service.
- What is actually missing:
  targeted rollout, fast partial disablement, and a first-class emergency stop for product rails.
- Evidence:
  `docs/RELEASE_READINESS_CHECKLIST.md:44-53`, `src/operational_readiness.ts:114-126`
- Source of truth requiring closure:
  operational readiness requirements for scaled launch, not controlled demo.
- Risk if left open:
  rollback remains coarse-grained and operational response options are limited.
- Likely repair path:
  add a minimal runtime kill-switch / rollout layer only after the real external rails are chosen.
- Dependencies:
  real rails activation plan.
- Estimated size:
  `Medium`

### GAP-14: Test and observability coverage are still centered on mock/demo rails, not real-provider activation

- Classification: `testing gaps`, `observability / health`
- Severity: `Medium`
- Priority: `P2`
- Production blocker: `No`
- Demo / preview blocker: `No`
- What exists today:
  health/admin/readiness surfaces are strong for internal state; automated tests validate mock-backed and provider-ready contracts inside the repo.
- What is actually missing:
  real-provider integration tests, delivery-provider monitoring, invoice-provider reconciliation checks, and launch-grade external operational dashboards.
- Evidence:
  `tests/real_integrations_validation.ts`, `tests/demo_preview_deployment_validation.ts`, `docs/RELEASE_READINESS_CHECKLIST.md:31-34`, `docs/STAGE4_OPERATIONAL_READINESS_MAP.md`
- Source of truth requiring closure:
  once real external rails are activated, mock-centered validation is no longer enough.
- Risk if left open:
  the team may activate real providers without matching operational proof and alerting.
- Likely repair path:
  add provider-specific smoke tests and delivery/accounting observability after GAP-02 through GAP-05 begin closing.
- Dependencies:
  real provider selection and implementation.
- Estimated size:
  `Medium`

## Severity And Priority Table

| Gap ID | Title | Severity | Priority | Production Blocker | Demo / Preview Blocker | Estimated Size |
|---|---|---|---|---|---|---|
| GAP-01 | No real seller authentication | Critical | P0 | Yes | No | Subproject |
| GAP-02 | Payment authorization rail is not truly live | Critical | P0 | Yes | No | Subproject |
| GAP-03 | Capture / recovery / refund rails incomplete | Critical | P0 | Yes | No | Subproject |
| GAP-04 | OTP / SMS rail is internal-only with static code | Critical | P0 | Yes | No | Medium to Subproject |
| GAP-05 | No real invoice / accounting issuance rail | Critical | P0 | Yes | No | Subproject |
| GAP-06 | Debug deal surface exposed without runtime gate | Critical | P0 | Yes | No | Small |
| GAP-07 | Webhook secret policy is still demo-grade | Critical | P0 | Yes | No | Small to Medium |
| GAP-08 | Email notifications remain log-only | High | P1 | Yes | No | Medium |
| GAP-09 | Repeat-join drift between truth sources and live join path | High | P1 | Yes | No | Medium |
| GAP-10 | Seller publish flow lacks legal acknowledgment | High | P1 | Yes | No | Small to Medium |
| GAP-11 | Runtime defaults and seed assumptions are still demo-oriented | High | P1 | Yes | No | Medium |
| GAP-12 | Canonical source-of-truth drift still exists | High | P1 | Yes | No | Medium |
| GAP-13 | No dedicated rollout controls / kill switch | Medium | P2 | No | No | Medium |
| GAP-14 | Tests and observability remain mock-centered | Medium | P2 | No | No | Medium |

## Drift And Decisions Required

### DRIFT-01: Repeat joins vs DB/runtime behavior

- Conflict:
  product decisions and tests allow multiple joins by the same buyer in the same deal, but the live join SQL still has an `ON CONFLICT (deal_id, buyer_id)` path.
- Required decision:
  confirm the canonical runtime rule is indeed "multiple joins allowed", then align live mutation logic and any DB constraints or legacy docs.
- Why it matters:
  this is not copy drift; it changes participant identity and money semantics.

### DRIFT-02: Seller publish acknowledgment

- Conflict:
  product/UX require explicit acknowledgment before publish, while the current product only shows trust/legal framing and no blocking confirmation step.
- Required decision:
  determine whether acknowledgment is UI evidence only or a persisted/enforced contract.
- Why it matters:
  this affects whether the fix is a small frontend patch or a broader backend/state change.

### DRIFT-03: OTP scope and modality

- Conflict:
  current runtime is phone-only with a static dev code, while UX/product language treats OTP and supporting notifications as real trust rails.
- Required decision:
  confirm the MVP target channel set, and confirm that no environment outside internal demo may ever expose a development code.
- Why it matters:
  this sits on the boundary between auth, trust, and operational launch readiness.

### DRIFT-04: Debug gating truth

- Conflict:
  Stage 4 readiness says debug is gated outside demo-preview, but `src/app.ts` still serves `/debug/deals/:id` directly.
- Required decision:
  the code, not the document, currently wins; the document must not stay more optimistic than the runtime.
- Why it matters:
  this is a direct internal-state exposure issue.

### DRIFT-05: "Mostly ready" language vs true production blockers

- Conflict:
  some earlier decision docs still use optimistic closure language even though real seller auth, live payment, real notifications, invoice/accounting, and security hardening are still open.
- Required decision:
  this master register should supersede optimistic launch wording until the blockers are actually closed.
- Why it matters:
  launch risk rises when archival confidence is mistaken for current truth.

## Production Blockers

The current production blockers are:

- GAP-01 `No real seller authentication`
- GAP-02 `Payment authorization rail is not truly live`
- GAP-03 `Capture / recovery / refund rails incomplete`
- GAP-04 `OTP / SMS rail is internal-only with static code`
- GAP-05 `No real invoice / accounting issuance rail`
- GAP-06 `Debug deal surface exposed without runtime gate`
- GAP-07 `Webhook secret policy is still demo-grade`
- GAP-08 `Email notifications remain log-only`
- GAP-09 `Repeat-join drift between truth sources and live join path`
- GAP-10 `Seller publish flow lacks legal acknowledgment`
- GAP-11 `Runtime defaults and seed assumptions are still demo-oriented`
- GAP-12 `Canonical source-of-truth drift still exists`

Production launch should not be described as ready until these blockers are closed or explicitly re-scoped by product and operations leadership.

## Demo-Safe Gaps

These gaps are acceptable only for controlled demo / preview and should not be mistaken for production closure:

- GAP-02 `Payment authorization rail is not truly live`
- GAP-03 `Capture / recovery / refund rails incomplete`
- GAP-04 `OTP / SMS rail is internal-only with static code`
- GAP-05 `No real invoice / accounting issuance rail`
- GAP-08 `Email notifications remain log-only`
- GAP-11 `Runtime defaults and seed assumptions are still demo-oriented`
- GAP-13 `No dedicated rollout controls / kill switch`
- GAP-14 `Tests and observability remain mock-centered`

Important note:

- GAP-06 `Debug deal surface exposed without runtime gate` is not a demo blocker in a tightly controlled internal environment, but it is still unsafe enough to remain `P0` for any real exposure.

## Recommended Repair Roadmap

### Wave 1: Close the security and identity floor

1. GAP-06 `Debug deal surface exposed without runtime gate`
2. GAP-07 `Webhook secret policy is still demo-grade`
3. GAP-01 `No real seller authentication`
4. GAP-04 `OTP / SMS rail is internal-only with static code`

Why first:

- These are the fastest path to reducing direct exposure and false identity trust.

### Wave 2: Close the money floor

1. GAP-02 `Payment authorization rail is not truly live`
2. GAP-03 `Capture / recovery / refund rails incomplete`
3. GAP-05 `No real invoice / accounting issuance rail`
4. GAP-08 `Email notifications remain log-only`

Why second:

- Once identity and surface exposure are contained, the next biggest business risk is fake or partial money movement.

### Wave 3: Resolve product/runtime drift

1. GAP-09 `Repeat-join drift`
2. GAP-10 `Seller publish flow lacks legal acknowledgment`
3. GAP-12 `Canonical source-of-truth drift still exists`
4. GAP-11 `Runtime defaults and seed assumptions are still demo-oriented`

Why third:

- These are essential for trustworthy launch semantics, but several of them depend on product decisions that should not be guessed in code.

### Wave 4: Operational maturity after real rails exist

1. GAP-13 `No dedicated rollout controls / kill switch`
2. GAP-14 `Tests and observability remain mock-centered`

Why fourth:

- These should be shaped around the actual providers and launch model, not around today's mock rails.

## Recommended Order To Start From

If the goal is the fastest honest path toward launch readiness, start in this exact order:

1. lock down internal exposure and unsafe defaults
2. choose and wire real auth + OTP ownership boundaries
3. choose and wire one real payment provider
4. close invoice/accounting and notification completion rails
5. resolve repeat-join and publish-acknowledgment drift
6. only then add rollout controls and real-provider observability
