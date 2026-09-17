# Siton — Senior Skeptical Engineer Adversarial Review

**Reviewer posture:** hostile. The brief was to break the claim that Siton is production-grade, not to confirm it.
**Base SHA:** `f2121f60cc37d742e2bf32d0ca48fe2ec83a807d` (origin/master at task start; master had advanced from the quoted `903175c4` — the later SHA was used).
**Branch:** `claude/senior-adversarial-production-review-cwupc5`
**Constraints honoured:** REAL MONEY = 0 · Grow never called · F13 remains a real-money blocker · no email/SMS/invoice/payment sent · no production data touched.

---

## 1. Executive verdict

**Would a skeptical senior engineer trust this system with real users today? — Qualified yes, for a closed pilot.**
**Would they trust it with real money today? — No, and correctly so: the system itself says no.**

This is not a system that merely looks finished from the outside. Where it matters most — money and state — correctness is enforced by **database invariants, not by TypeScript intentions**. The platform-fee ledger has partial unique indexes making a duplicate charge or duplicate refund row physically impossible; `webhook_events` is keyed `PRIMARY KEY (provider, event_id)`, so a replayed webhook cannot be processed twice — the constraint, not the lookup, is what holds the line (see F-18); the outbox uses `FOR UPDATE SKIP LOCKED` with **lease-generation fencing**, so a worker that resumes after a reclaim discovers it has lost ownership instead of double-acknowledging. Webhook signatures are verified with an HMAC over `timestamp.body`, a five-minute replay window, a length check and a genuine `timingSafeEqual`. The production boot guard fails closed on a long list of unsafe configurations. Migrations run clean from empty, are idempotent on rerun, and are checksum-ledgered with drift detection (61 migrations, 0 drift).

That is a materially higher standard than "AI-generated code that runs."

The defects worth an engineer's attention were not in the money maths. They were in the **layer that is supposed to prove the money maths is deployed correctly** — the gates, the blueprint and the dashboards. The single most important finding is that the deployment path that actually runs in production was never covered by the proof that claimed to cover it.

### Strongest reasons for YES
- Money duplication is prevented by DB constraints, not application checks (`ux_platform_fee_money_charge_once` / `_refund_once`).
- Outbox leases are generation-fenced; a resumed worker cannot double-ack (scenario 5, §9).
- Webhook replay is DB-enforced and signature verification is genuinely correct (scenario 20, §9).
- The production boot guard is extensive and fails closed; it now has zero documented gaps (`runtime_gaps=0`, F-03).
- Migrations are clean, idempotent, checksum-ledgered, drift-free (`ISOLATED_MIGRATION_PROOF_PASS … drift=0`).
- Server-side authorization is real: seller lifecycle routes carry `config.authority` **and** re-check row ownership inside the transaction, answering `404` (not `403`) to avoid an existence oracle (§3).
- The repository is unusually honest: nearly every defect this review confirmed was already written down somewhere as OPEN. That is rare and valuable.

### Strongest reasons for NO
- The hosted worker did not drain on deploy, and the test named for that invariant did not look at the hosted config (**P1, fixed**).
- Six documented startup-config gaps were defended only by a **pre-deploy** gate, while an env var can change in the hosting console at any time afterwards (**P1, fixed**).
- A gate named "architecture truth" certifies a production architecture that, by the manifest's own `publish_performed: false`, was never published (**P2, reported not fixed — F-07**).
- Real money is blocked on an **external provider fact** nobody in this repository can resolve (F13).
- The mission-control security panel is substantially hardcoded (**P2, partially fixed**).

---

## 2. Architecture reviewed

| Layer | Claimed | Verified |
|---|---|---|
| Code source of truth | GitHub | ✅ confirmed |
| Web runtime | Render Docker, Fastify, `node .demo_dist/src/app.js` as PID 1 | ✅ confirmed |
| Worker runtime | Render Docker background worker | ⚠️ **started through npm — PID-1 defect (F-01, fixed)** |
| Persistence | Supabase/Postgres, `siton` schema, least-privilege LOGIN roles adopting NOLOGIN runtime profiles | ✅ confirmed; RLS operation-specific, `anon`/`authenticated` revoked |
| Inventory | canonical Postgres RPC (`public.siton_inventory_rpc`), no external bridge | ✅ confirmed by gate + source read |
| Base44 | declared `production_runtime` in the manifest | ❌ **contradicted by `publish_performed: false` — F-07** |
| Money | mockpay everywhere; Grow disabled on every checked-in target | ✅ confirmed (`REAL_MONEY: BLOCKED`) |

Legacy Render artifacts are quarantined under `legacy/`, no root `Procfile`, no Base44 reference in `render.yaml`. No legacy runtime can mutate current state.

---

## 3. Attack surface reviewed

213 routes, 0 unclassified, 0 unclassified-sensitive. 117 protected · 86 public · 66 admin · 49 seller · 16 buyer-token · 8 deliberate public-write.

**Adversarial cases attempted:** anonymous mutation on every protected namespace · buyer→seller · seller A→seller B resource · buyer→admin · forged seller header · forged/stale resource IDs · enumeration oracles · replay · expired and revoked tracking tokens · malformed auth context.

Result: `ROUTE_AUTHORIZATION_GATE_PASS`, `seller_routes=35` behavioural probes, **"a forged seller header is not authority" PASS**. Seller lifecycle mutations (`/deals/:id/publish|close_joining|reopen_joining|prepare_charging|charging/start|cancel`) all call `requireSellerAuthority` **inside** the transaction and then compare `normalizeSellerId(row.seller_id)` against the authenticated seller, throwing `404` on mismatch. Cross-seller IDOR: **not reproducible**.

### The 8 anonymous mutation routes, classified individually

Deliberately *not* "secure them all" — each judged on its own merits.

| Route | Verdict | Reasoning |
|---|---|---|
| `POST /api/mall/events` | **intended + safe** | discovery analytics; owns no state or money |
| `POST /api/viral/events` | **intended + safe** | growth analytics only; `viral_recompute` never touches deal/buyer/money/notification state |
| `POST /api/deals/:dealId/inquiries` | **intended + safe** | public "contact the seller" entry point; issues its own capability token |
| `POST /api/inquiries/:threadId/messages` | **intended + safe** | *not actually anonymous*: requires a `customer_access_token` verified against a stored hash with real `timingSafeEqual`; missing thread and wrong token both answer an identical `404` (no enumeration oracle); honeypot `website` field; `FOR UPDATE OF t` |
| `POST /api/deals/:dealId/chat` | **intended, ambiguous** | anonymous public chat is a product decision; abuse resistance rests on the in-memory rate limiter, which is per-instance (documented, accepted at pilot scale) |
| `POST /api/deals/:dealId/chat/:messageId/reaction` | **intended + safe** | bounded enum write |
| `POST /api/deals/:dealId/feedback` | **intended, ambiguous** | same rate-limiter dependency |
| `POST /api/support/contact` | **intended, ambiguous** | same; no real mail is sent (`NOTIFICATION_PROVIDER=log-only`) |

Separately, `scripts/protected_route_policy.cjs` allowlists 10 anonymous-by-design routes inside protected namespaces (login/logout/session-probe/MFA-verify/affiliate-visit). This allowlist is **well built**: each entry carries a reason, an executed probe and a body marker, and a bare guard refusal is rejected as evidence — an engineer cannot hide a guarded data route in it. No change needed.

---

## 4. Findings

Severity: **P0** catastrophic · **P1** production blocker · **P2** fix before broad launch · **P3** hardening · **INFO** observation.
Disposition: **A** fixed here · **B** owner/infra · **C** external contract · **D** accepted/documented.

| ID | Sev | Area | Finding | Disp |
|---|---|---|---|---|
| F-01 | **P1** | Deploy/Runtime | Hosted worker started via `npm run start:worker:prod` → npm is PID 1 → SIGTERM never reaches `stopWorker()`; worker SIGKILLed mid-job on every deploy | **A — fixed** |
| F-02 | **P1** | Test quality | The test *named* "start the Node runtime itself as PID 1, never a wrapper" never examined `render.yaml` — it passed while the only deployment that matters violated it | **A — fixed** |
| F-03 | **P1** | Config/Security | Six documented startup-config gaps defended only by the **pre-deploy** release gate, not by the boot guard | **A — fixed** |
| F-04 | **P1** | Security | `OTP_HASH_SALT` falls back to the literal `siton-otp-salt-default`, published in this repository; boot guard did not require it | **A — fixed (prod) / B (staging)** |
| F-05 | **P2** | Security/PII | LOG-1: `recipient_ref` (buyer phone / seller email) logged raw; staging runs `log-only`, so it reached the hosted log store | **A — fixed** |
| F-06 | **P2** | Test quality | The logging gate's runtime probe never exercised the notification provider at all (wrong template key → silent no-op) yet its PASS message claimed it did | **A — fixed** |
| F-07 | **P2** | Architecture truth | `architecture_truth_gate` asserts `production_runtime === "base44"` and prints `production=base44`, while the same manifest says `publish_performed: false` and Render is `legacy_runtime` | **D — reported, not fixed** |
| F-08 | **P2** | Observability | Mission-control `legacy_links_allowed` recomputed from a *second, different* expression than the enforcement; diverged in the dangerous direction | **A — fixed** |
| F-09 | **P2** | Observability | Mission-control security panel returns hardcoded findings and literal `status: "pass"` check rows | **D — documented** |
| F-10 | **P2** | HTTP | GAP-HTTP-1: `/readiness` served without `cache-control: no-store` | **A — fixed** |
| F-11 | **P2** | Supply chain | 4 production-tree **high** advisories (`fast-uri` SSRF/host-confusion, `find-my-way` HTTP/2 DoS, `brace-expansion`, `tmp`) | **A — fixed** |
| F-12 | **P2** | Supply chain | Dockerfile runs `npm ci` without pruning dev deps → the production image ships `vitest` and `tar` (2 criticals) | **B — exact patch given** |
| F-13 | **P1** | Money | Grow live contract unproven outside sandbox transport | **C — external** |
| F-14 | **P3** | Security theatre | `verifyParticipantTrackingAccess` "constant-time" compare compares a value **to itself** | **D — documented** |
| F-15 | **P3** | Maintainability | `frontend_runtime.ts` 11,970 lines; `app.ts` 7,435 lines | **D — documented** |
| F-16 | INFO | Auth | Two divergent definitions of "production": `productionMode()` vs `isProductionLikeEnv()` | **A — narrowed** |
| F-17 | INFO | Enumeration | `/api/participants/:id/tracking` answers 404 vs 401 before the token check | **D — UUID entropy** |
| F-18 | **P3** | Money/robustness | Webhook claim is check-then-insert with no row lock: a **concurrent** duplicate delivery raises a unique violation (5xx) instead of answering `duplicate` | **D — safe but noisy; exact fix given** |

**P0 found: 0.** No catastrophic defect was reproducible.

---

## 5–8. Evidence, exploit scenario, fix, remaining risk

### F-01 / F-02 — the hosted worker never drained (P1) ✅ FIXED

**Evidence.** The Dockerfile's own comment documents the failure mode: *"npm forwards the signal to its child shell, then re-sends it to itself, and as PID 1 with no handler left it cannot die from it and exits 1 instead — the release lab measured web=1 / worker=1 on a normal stop."* The lab was then fixed to run `node` directly. But `render.yaml` still carried `dockerCommand: npm run start:worker:prod`, and `docker-compose.yml` / `docker-compose.ci.yml` still used `npm run start:*:prod`.

The proof that was supposed to catch this — `tests/release_tools/runtime_shutdown.test.cjs`, test name *"image and lab start the Node runtime itself as PID 1, never a wrapper"* — asserted against the **Dockerfile** and **docker-compose.release-lab.yml** only. It even asserted `"npm must not be PID 1 in the lab containers"`. It never read `render.yaml`. Worse, `scripts/architecture_truth_gate.cjs` **actively enforced the defect**: `assert(/dockerCommand:\s*npm run start:worker:prod/…)` — correcting the blueprint would have failed the architecture gate.

`docs/DEPLOYMENT_RUNBOOK.md:115` conceded it: *"with npm as PID 1 the worker does not drain on a Render deploy, the outbox lease reclaim covers correctness — OPEN item."*

**Exploit / failure scenario.** Every Render deploy (`autoDeploy: true` on `master`) sends SIGTERM to the worker. npm cannot forward it. After the grace period the worker is SIGKILLed **mid-cycle** — potentially between an external side effect and `markOutboxSent`. The job then sits in `processing` until its 60 s lease expires, is reclaimed, and the handler **re-executes**.

**Assessment of the accepted mitigation.** "Lease reclaim covers correctness" is a real argument, but it is strictly weaker than draining: it converts a clean shutdown into a dependency on *every handler* being idempotent under re-execution. That holds for the fee ledger (DB unique indexes) and for webhook ingestion (`PRIMARY KEY (provider, event_id)`) — it is unproven for every handler, and it costs a duplicate external side effect each time. The drain is **already implemented and already proven** in `src/worker.ts`; it simply was not wired to the deployment.

**Fix applied.**
- `render.yaml` → `dockerCommand: node .demo_dist/src/worker.js`
- `docker-compose.yml`, `docker-compose.ci.yml` → `node` directly for web and worker
- `scripts/architecture_truth_gate.cjs` → now asserts the Node entrypoint **and** `!/npm\s+run\s+start:(web|worker):prod/` across blueprint directives
- `tests/r3_render_web_runtime_validation.ts` → assertion updated
- **New regression test** `"every deployable runtime surface starts Node as PID 1, never npm"` covering `render.yaml` + all three compose files. Both the gate and the test strip full-line YAML comments so an explanatory comment cannot trip the rule.

**Proof.** The new test was written first and **failed** on unmodified master (`render.yaml` named in the failure), then passed after the blueprint change. `ARCHITECTURE_GATE_PASS`.

**Remaining risk.** `render.yaml` is Infrastructure-as-Code; Render applies a blueprint change on **Blueprint sync**, not automatically. → **Owner action O-1.**

---

### F-03 / F-04 / F-16 — boot guard did not fail closed on six documented gaps (P1) ✅ FIXED

**Evidence.** `npm run gate:startup-matrix` on master: `pass=20 fail=0 warning=6`, each warning reading *"runtime: ACCEPTS (documented runtime gap; release gate is the only defence)"*. `config/runtime-environment-policy.json` listed three as `status: "OPEN"` with *"Runtime change deferred to the owner (not implemented on this branch)."*

**Why "the release gate catches it" is not a defence.** The release gate runs **before** a deploy. Environment variables live in the Render console and can be added, changed or copied between services at any time afterwards. The boot guard is the only control that re-evaluates on every process start. A pre-deploy gate cannot defend a post-deploy change.

The six, and what each actually exposed:

1. **`production_demo_deployment_mode_bypass` — the serious one.** Every production control hangs off `productionMode()`, which reads one variable, and the **Dockerfile defaults `APP_DEPLOYMENT_MODE=demo-preview`**. A hosted service whose console never declared it boots as a demo — demo seller context and mock payment routes on the real hostname — with every guard silently off and nothing at runtime saying so.
2. **`production_legacy_tracking_links`** — `TRACKING_LEGACY_COMPAT=1` re-enables anonymous participant tracking links (buyer PII from a bare participant id) in production.
3. **`production_unsafe_admin_key`** — the guard only checked ADMIN_API_KEY *presence*; the published `demo-admin-key-do-not-use-in-production` passed.
4. **`production_debug_surfaces`** — `/debug/*` on the production hostname.
5. **`production_otp_bypass`** — `OTP_TEST_BYPASS_CODE` accepted. `otp_rail.ts` independently ignores it when `isProductionLikeEnv()`, but **"production mode" and "production-like" are two different predicates** (F-16) and a configuration can satisfy one and not the other.
6. **`production_service_role_key_present`** — the full-RLS-bypass Supabase key present in the app process. No code reads it, so it is pure custody risk.

Plus **F-04**: `getOtpHashSalt()` returns `process.env.OTP_HASH_SALT || "siton-otp-salt-default"` in **every mode**, and the guard never required it. A six-digit OTP hashed with a salt published in this repository is recoverable from any read of the challenge table in ~10⁶ HMACs — milliseconds.

**Fix applied — failing proof first.** The six matrix cases were flipped from `runtime_expect: "accept"` to `"reject"`, producing `STARTUP_CONFIG_MATRIX_FAIL … fail=6`, each reading *"runtime guard ACCEPTED an unsafe configuration (expected rejection)"* — proving the gaps against the live guard. `src/production_guards.ts` was then hardened:

- New `hostedPlatformDeployment(env)` (`RENDER` / `RENDER_EXTERNAL_URL` / `RENDER_SERVICE_ID`). On a hosted platform, `APP_DEPLOYMENT_MODE` must be declared and must not be a demo/preview mode.
- In production mode: non-placeholder `ADMIN_API_KEY` ≥ 24 chars; `TRACKING_LEGACY_COMPAT=1`, `DEBUG_SURFACES_ENABLED=1`, `OTP_TEST_BYPASS_CODE`, `SUPABASE_SERVICE_ROLE_KEY` all refused; `OTP_HASH_SALT` required and refused if placeholder or a known public default.

**The hosted-marker choice is deliberate.** Rejecting `demo-preview` purely on `isProductionLikeEnv()` would have broken `docker-compose.yml`, `docker-compose.ci.yml` and the release lab, all of which legitimately run `NODE_ENV=production` + `demo-preview`. Keying on the hosted marker closes exactly the real-world failure — *deployed on Render, forgot the variable* — and cannot affect a local stack.

**Proof — non-regression verified explicitly, not assumed.** Each configuration run through the real guard probe:

| Configuration | Result |
|---|---|
| Real hosted staging **web** (render.yaml env + Render markers) | **ACCEPT** ✅ |
| Real hosted staging **worker** | **ACCEPT** ✅ |
| `docker-compose.yml` demo stack (demo-preview, no marker) | **ACCEPT** ✅ |
| Release-lab worker (demo-preview, no marker) | **ACCEPT** ✅ |
| **Hosted Render host that forgot `APP_DEPLOYMENT_MODE`** | **REJECT** ✅ |

`STARTUP_CONFIG_MATRIX_PASS cases=23 runtime_gaps=0` — from 6 gaps to 0.

**Remaining risk.** Staging still runs on the default OTP salt until `OTP_HASH_SALT` is added to both Render services → **Owner action O-2**.

---

### F-05 / F-06 — buyer PII in hosted logs, behind a vacuous check (P2) ✅ FIXED

**Evidence.** `src/notification_dispatch.ts:92` logged `recipient_ref` raw. Staging runs `NOTIFICATION_PROVIDER=log-only`, so **every** buyer phone number and seller support email reached Render's log store — a different retention and access boundary from the database the value came from.

**F-06 is the more interesting half.** The logging gate had a runtime probe that was supposed to catch this, and its PASS message read *"notification log provider emitted recipient_ref."* Running the probe directly showed it emitted **one line, from the OTP provider only**. The notification arm passed `template_key: "buyer_joined_authorized"` where the real key is `buyer_joined_authorized_he`; `renderNotification()` returned `null`, the provider answered `"skipped"` **without logging**, and the check passed on an empty string. It would have passed whether or not the value was masked, because the code under test never ran.

**Fix applied.** `maskRecipientRef()` added, masking on the **shape** of the value (an `@` means email) rather than on the channel label — a phone number is routinely stored against `whatsapp_link`. The probe now uses the correct template key, sends **two** cases (sms + email) with **distinct sentinels**, and emits an explicit `PROBE_INERT` marker if a send produces no line. The gate fails on a raw sentinel, on `PROBE_INERT`, **and** on absence of the expected masked forms — so the check cannot silently go vacuous again.

**Proof — mutation tested.** Reverting the mask made the gate **FAIL**: *"emitted raw notification recipient_ref (sms), raw notification recipient_ref (email), masked sms recipient_ref absent…"*. Restored → `LOGGING_HYGIENE_GATE_PASS overall=PASS pass=6 fail=0 warning=0` (was `warning=1`).

---

### F-08 — the dashboard contradicted the guard (P2) ✅ FIXED

**Evidence.** Enforcement (`trackingMode()`): `TRACKING_LEGACY_COMPAT === "1" || !isProductionLikeEnv()`. The mission-control panel recomputed the same fact from a **different** expression: `!process.env.RENDER && process.env.NODE_ENV !== "production"`. Measured across five configurations, **three diverge**:

| Scenario | Enforced | Dashboard said | |
|---|---|---|---|
| local dev | true | true | agree |
| Render staging | false | false | agree |
| **production + `TRACKING_LEGACY_COMPAT=1`** | **true** | **false** | **divergent — dangerous direction** |
| `APP_ENV=production` only | false | true | divergent |
| `RENDER_EXTERNAL_URL` only | false | true | divergent |

Row 3 is the one that matters: the runtime **allows** anonymous legacy tracking links while the operator's security panel reports them **blocked**.

**Fix applied.** The panel now calls `trackingMode()` — one source of truth — and raises a blocker when `live_blocked_without_tracking_tokens` is set. Note this is also now defence-in-depth only, since F-03 refuses `TRACKING_LEGACY_COMPAT=1` in production outright.

---

### F-10 — `/readiness` cacheable (P2) ✅ FIXED

`isDynamicNoStoreRoute` listed `/health` and `/health/integrations` but not `/readiness` — the Render health-check path. A cached readiness verdict is a stale verdict: a failing instance keeps receiving traffic, or a recovered one keeps being drained.

**Fix.** `/readiness` added to the no-store list. The smoke test had *excused* `/readiness` from `expectNoStore` and recorded it as a non-failing "documented gap"; it is now a hard assertion. **Mutation tested**: reverting the fix makes the smoke **FAIL** (*"/readiness cache-control is 'absent' (expected no-store)"*). Restored → `HTTP_SECURITY_SMOKE_PASS 11/11`, GAP-HTTP-1 closed.

---

### F-11 / F-12 — dependency advisories (P2) ✅ FIXED / **B**

Deliberately **not** mass-upgraded. Each advisory classified by production-tree membership and reachability.

| Package | Sev | In prod tree | Action |
|---|---|---|---|
| `fastify` | moderate | yes | **5.7.4 → 5.12.4** (same major) |
| `fast-uri` | **high** (SSRF, host confusion, path traversal) | yes — ajv/fastify URI parsing | **pinned `^3.1.8`** (in-major) |
| `find-my-way` | **high** (HTTP/2 DoS) | yes | resolved by the fastify bump |
| `brace-expansion` | **high** (exponential DoS) | yes — exceljs→archiver/glob | **pinned `@1 ^1.1.21`, `@2 ^2.1.7`** (per-major, no parent sees a breaking API) |
| `tmp` | **high** (path traversal) | yes — exceljs | **pinned `^0.2.7`** (in-major) |
| `exceljs` | moderate | yes | **NOT taken** — the only "fix" is a **major downgrade to 3.4.0**; regression risk exceeds the benefit |
| `uuid` | moderate | yes | no fix; the advisory is a `buf` bounds check in v3/v5/v6, not the path exceljs uses — **unreachable** |
| `tar` (**critical**), `vitest` (**critical**), `sharp`, `@xmldom/xmldom`, `@capacitor/*`, `xcode`, `vite`, `postcss`, `nanoid`, `esbuild` | crit/high | **no** | dev/build-only (mobile toolchain, frontend build, test runner) — **not upgraded** |

**Result: 20 advisories → 15. Production-tree HIGH: 4 → 0.** Every remaining critical/high is dev-only. Verified: `npx tsc --noEmit` clean; full suite green.

**F-12 (owner/CI).** The Dockerfile runs `npm ci` **without** `--omit=dev`, so the production image ships the dev toolchain including both criticals. The `web/` stage already does the right thing (`npm prune --omit=dev`); the root stage does not. The fix is *not* a one-liner: `scripts/run_migrations.cjs` and `scripts/bootstrap_demo_db.cjs` both `require("dotenv")`, a **devDependency**, so pruning breaks migrations in the container. **Exact patch:** move `dotenv` to `dependencies`, then add `RUN npm prune --omit=dev` after `npm run build:demo`. Not applied here because Docker is unavailable in this environment and an unverified image change is exactly the kind of speculative fix this review exists to catch. → **Owner action O-3**, verify via the `docker-release-lab` CI job.

---

### F-07 — the architecture gate certifies an unpublished architecture (P2) — **reported, not fixed**

**Evidence.** `scripts/architecture_truth_gate.cjs:50` asserts `runtime.production_runtime === "base44"` and prints, on every CI run:

```
ARCHITECTURE_GATE_PASS production=base44 worker=siton-worker-tick render=r3_staging_web …
```

`base44/runtime-manifest.json` declares `"production_runtime": "base44"`, `"canonical_data_store": "base44_entities"`, `"legacy_runtime": "render"` — and, in the same file, **`"publish_performed": false`**. The gate asserts that too.

So the file simultaneously states that Base44 is the production runtime *and* that it has never been published. Meanwhile `render.yaml` carries `autoDeploy: true` on `master` and hosted staging is live on Render. **The declared production runtime is not running; the runtime that is running is labelled `legacy_runtime`.** Relative to this task's own canonical statement — Render paths are canonical, Supabase/Postgres is the persistence boundary — the manifest is inverted.

**Why this matters at 03:00.** An engineer paged during an incident reads `production=base44` and `canonical_data_store: base44_entities` and looks in entirely the wrong place.

**Why it was not fixed here.** The claim is enforced in **three** places — `architecture_truth_gate.cjs`, `base44_canonical_integrity_gate.cjs` (`validateRuntimeManifest`), and `tests/base44_mall_contract_validation.ts`, which contains an explicit **negative control** asserting that setting `production_runtime = "render"` *must* produce an `invalid_base44_runtime_authority` finding. This is a deliberately maintained invariant, not an oversight. Correcting it means rewriting a gate, its integrity gate, and a test's negative control — and I cannot determine from inside the repository whether the Base44 `/app` mall projection is genuinely still intended to serve. Changing it on inference would be precisely the speculative rewrite this review is meant to prevent. → **Owner decision O-4.**

---

### F-09 — mission-control security panel is largely hardcoded (P2) — documented

`buildSecurityHardening()` returns a **literal** `findings` array and a `checks` array of constant rows (`{ id: "security_headers_validation", status: "pass" }`, …). These are authored constants, not measurements: the panel reports `pass` regardless of reality. It is a design document rendered as a dashboard. F-08 fixed the one field that actively contradicted enforcement; converting the rest into live checks is a real piece of work and out of scope for a review that must not explode. **Do not treat this panel as evidence during an incident** — use the gates (`gate:startup-matrix`, `gate:logging-hygiene`, `smoke:http-security`, `ci:route-authorization`), which do measure.

---

### F-14 — decorative constant-time comparison (P3) — documented

`verifyParticipantTrackingAccess`:

```ts
const storedHash     = Buffer.from(tokenHash, "hex");
const recomputedHash = Buffer.from(hashParticipantTrackingToken(input.token), "hex");
if (storedHash.length !== recomputedHash.length || !timingSafeEqual(storedHash, recomputedHash)) …
```

`tokenHash` **is** `hashParticipantTrackingToken(input.token)` — the value is compared to itself. The branch can never be taken. **Not a vulnerability**: the real lookup is `WHERE token_hash = $1`, an index equality on a SHA-256 of a 256-bit random token, which is sound. But it reads as a rigorous security control and is inert — a reviewer who sees it may believe a timing defence exists where none was needed and none is present. Contrast `verifyCustomerAccessToken` in `src/seller_inquiries.ts`, which does this correctly. Left in place (changing it alters nothing functionally); flagged so it is not mistaken for a control.

---

### F-18 — webhook claim is check-then-insert (P3) — documented, exact fix given

**Evidence.** `src/webhook_ingestion.ts` `claimEvent()` does a bare `SELECT … WHERE provider=$1 AND event_id=$2`, and on no row performs an `INSERT` with **no `ON CONFLICT` clause and no row lock**.

**Failure scenario.** Two *concurrent* deliveries of the same provider event: both transactions read no row, both attempt the `INSERT`, and the second violates `PRIMARY KEY (provider, event_id)` with SQLSTATE `23505`, which propagates as a 5xx instead of the intended `{ duplicate: true, should_process: false }`.

**Why this is P3 and not P1.** The safety-critical property holds, and holds for the right reason: the primary key makes a second row impossible, so the event is never *processed* twice. What breaks is the response — the provider sees a failure and retries, and the retry finds the row and gets the correct duplicate answer. The system converges; it is noisy, not wrong. Sequential replay (the overwhelmingly common case) was already handled correctly.

**Exact fix, if taken:** `INSERT … ON CONFLICT (provider, event_id) DO NOTHING RETURNING …`, and when nothing is returned re-read the row and fall through to the existing duplicate branch. Not applied here: it changes money-path behaviour and deserves its own concurrency test, and the constraint already prevents the outcome that would actually matter.

---

### F-15 — file size (P3) — documented

`src/frontend_runtime.ts` is **11,970** lines and `src/app.ts` **7,435** — together 45% of the TypeScript in the repository, holding route definitions, business logic and rendering. This is the clearest "built by AI" structural signal. It is a real maintainability and merge-conflict risk, and it makes review of any single change harder. It is **not** a correctness defect today, and splitting it is a large, risky, low-reward refactor. Explicitly out of scope per the fix policy; recorded so it is a conscious debt rather than an unnoticed one.

---

## 9. Adversarial scenario matrix

| # | Scenario | Result |
|---|---|---|
| 1 | Two buyers claim the final capacity simultaneously | **Safe** — `SELECT … FROM deals WHERE deal_id=$1 FOR UPDATE` before the capacity count serializes joins per deal |
| 2 | Same join request sent repeatedly | **Safe** — `pg_advisory_xact_lock` on `(deal,buyer,idem)` + `join_idempotency_results`; a replay with a *different* payload is rejected `409 idempotency_payload_mismatch` rather than silently replayed |
| 3 | Worker processes the same money job twice | **Safe** — lease-generation fencing; `markOutboxSent` is generation-guarded |
| 4 | Worker dies after side effect, before ack | **Was a real exposure on deploy (F-01) — fixed.** Residual coverage: lease reclaim + DB unique indexes |
| 5 | Recovery worker reclaims while the original resumes | **Safe** — the original observes `ownershipLost` and returns `lease_lost` instead of acking |
| 6 | Duplicate / concurrent redemption | **Safe** — DB-enforced; covered by `deal_types` suites |
| 7 | Seller A mutates seller B's deal | **Safe** — in-transaction ownership check, `404` (no existence oracle) |
| 8 | Buyer calls seller/admin APIs directly | **Safe** — `ROUTE_AUTHORIZATION_GATE_PASS` |
| 9 | Anonymous caller hits every mutation route | **Safe** — 117 protected routes refuse; the 10 allowlisted entries each prove intentional anonymous behaviour |
| 10 | Stale / invalid / wrong-role / forged credential | **Safe** — "a forged seller header is not authority" PASS |
| 11 | DB drops during a critical transition | **Safe** — `/health` 200, `/readiness` 503 (negative control in the health contract) |
| 12 | Deploy while jobs are active | **Was unsafe (F-01) — fixed** |
| 13 | SIGTERM during worker work | **Was unsafe (F-01) — fixed**; drain proven to exit 0 and record `status=stopped` |
| 14 | Migration applied while an old web instance is alive | Additive migrations + checksum ledger; rollback documented |
| 15 | Malformed queue payload / poison job | **Safe** — `PermanentFailError`, DLQ, quarantine savepoints |
| 16 | Logs from sensitive workflows | **Was leaking (F-05) — fixed** |
| 17 | Fulfillment secret searched across persistence + API | **Safe** — deterministic confidentiality proof (PR #12) |
| 18 | Provider success + internal persistence failure | **Safe** — *"capture → 429/drop after the money moved → UNKNOWN on the SAME identity, reconciliation proves it, ONE provider effect"* (observed passing) |
| 19 | Notification retry after a successful financial transition | **Safe** — notification retry is outbox-scoped; the ledger entry is separately unique-indexed |
| 20 | Replay of a previously successful request | **Safe** — webhook `PRIMARY KEY (provider,event_id)`; join idempotency; 5-minute signature window. *Sequential* replay answers cleanly; a **concurrent** duplicate 5xxs and is retried (F-18) — never double-processed |

---

## 10. Owner / infra actions

| ID | Action | Why |
|---|---|---|
| **O-1** | **Render Blueprint sync** so the worker's start command becomes `node .demo_dist/src/worker.js` | A `render.yaml` change is not applied automatically. Until synced, the hosted worker still does not drain (F-01) |
| **O-2** | Add `OTP_HASH_SALT` (`generateValue`) to **both** Render services | Staging still hashes OTP codes with a salt published in this repository (F-04). Production now refuses to boot without it |
| **O-3** | Move `dotenv` to `dependencies`, add `RUN npm prune --omit=dev` after `npm run build:demo`; verify via `docker-release-lab` | Removes 2 criticals + several highs from the production image (F-12). Not applied unverified |
| **O-4** | Decide whether Base44 is still an intended runtime; correct or retire the manifest + its three gates | The architecture gate certifies an unpublished production runtime (F-07) |
| **O-5** | Run the Docker release lab and the hosted staging proof on this branch | Docker is unavailable in this environment |
| **O-6** | Owner's call whether the `ADVERSARIAL_REVIEW_NOT_PERFORMED` real-money blocker is satisfied by this review | Deliberately **not** cleared here — an agent should not mark its own homework, and real money must stay blocked |

---

## 11. External / provider blockers

**F13 — `F13_PROVIDER_CONTRACT_UNRESOLVED` remains a hard REAL_MONEY blocker, untouched and unweakened.**

The R9C rails exist on master (durable operation lifecycle, settlement horizon, dispatch legality). What is unproven is **provider-side fact**: settle/status semantics against the live Grow API and provider-side idempotency. No amount of repository work can resolve it, and this review did **not** research Grow, call Grow, or infer its contract.

Co-blockers, all external or owner-owned: `GROW_LIVE_VERIFICATION_NOT_PERFORMED` (sandbox `userId`/`pageCode` still with Grow support), `PRODUCTION_PAYMENT_ACTIVATION_NOT_APPROVED`, `ADVERSARIAL_REVIEW_NOT_PERFORMED` (see O-6).

`npm run proof:no-real-money` → **`REAL_MONEY: BLOCKED`**, `NO_REAL_MONEY_PROOF_PASS 16/16`. `git diff` against `src/grow_payment_adapter.ts`, `src/payment_provider.ts`, `src/payout_rail.ts`, `src/platform_fee_money.ts`, `src/vat_authority.ts`, `config/real-money-release-policy.json`: **empty**.

### [OBSOLETE — HISTORICAL] LONG_HORIZON_DEALS — a second, separate provider-blocked item (not a review finding)

> **OBSOLETE / HISTORICAL — do not act on this subsection.** The seven-day
> deadline cap that the bullets below describe as *enforced* was **REMOVED** by
> the owner decision of 2026-09-16 (LONG_HORIZON_DEALS) and is gone from every
> active surface. There is **no fixed maximum deal duration**: `src/app.ts` no
> longer defines `DEADLINE_MAX_MS`, and `src/deadline_policy.ts` is the single
> source of truth (2-hour minimum, a 20-year technical sanity ceiling, and an
> advisory notice above one year that never blocks). The bullets are preserved
> verbatim as the record of what was true at this review's base SHA. See the
> RESOLUTION NOTE at the end of this subsection and
> `docs/CANONICAL_PRODUCT_POLICY_AMENDMENT_2026-09-16.md`.

Recorded here so it is not mistaken for closed by this review or by any green suite. It is owner-stated and outside the review's scope; no fix was attempted and none may be attempted in repository code.

- The runtime **7-day limitation is NOT solved**. It is *enforced* (`src/app.ts:133` `DEADLINE_MAX_MS = 7 * 24 * 60 * 60 * 1000`; an 8-day deadline is rejected 400), which is a product boundary, not a solution.
- Previous long-horizon design work exists but was **never merged**. It is not on master and must not be treated as available or partially in effect.
- **A long-lived authorization cannot survive for months or years.** A card authorization is a short-lived hold, not a durable claim on funds. Any artefact implying otherwise is wrong and must be corrected, not carried forward.
- A future architecture needs a **proven future-charge mechanism** — a stored provider-side payment instrument or a mandate — where "proven" means demonstrated against the provider's real contract, not inferred from documentation or from sandbox transport.
- **Blocked on F13 / provider semantics and must not be guessed in repository code.** Encoding an assumed future-charge, mandate or token-reuse behaviour would create precisely the defect class this review exists to catch: something that looks implemented and passes its own tests while resting on an unverified external fact.
- Migration `068`'s settlement horizon is a **different** problem (finality for money already in flight) and does **not** extend how long an authorization can be held.

> **RESOLUTION NOTE (2026-09-16, `docs/LONG_HORIZON_AUTHORIZATION_ARCHITECTURE.md`).** The
> repository-side blocker above is closed by decoupling deal lifetime from
> authorization lifetime rather than by stretching a hold: the 7-day cap is
> removed (`src/deadline_policy.ts`), the current authorization is a
> replaceable instrument (migration 071, `reauthorize` identities through the
> 067/068 lifecycle), and the worker re-establishes it at the charging boundary
> through `PaymentProvider.reauthorize`. Nothing about a provider's future-charge
> behaviour is guessed: Grow and Stripe adapters do NOT implement `reauthorize`
> (documented gap, §7 of the architecture); for them the capture is dispatched
> on the original authorization and the provider decides. The review text above
> is kept verbatim as the historical record.

---

**Canonical fee invariant independently re-verified** (not merely trusted from the existing suite):

| Case | gross | VAT | fee base | 8% fee | |
|---|---|---|---|---|---|
| product only | 100 | 0 | 100 | 8.00 | ✅ |
| product + shipping | 125 | 0 | **125** (shipping included) | 10.00 | ✅ |
| product + shipping, 18% VAT | 118 | 18 | **100** (VAT excluded) | 8.00 | ✅ |
| awkward rounding | 333.33 | 50.85 | 282.48 | 22.60 | ✅ |
| refund reversal | −118 | −18 | −100 | −8.00 | ✅ |

`SITON_PLATFORM_FEE_RATE = 0.08` · **FEE_INVARIANT_HOLDS** · distributor commission 0 unchanged · VAT authority unchanged.

---

## 12. Production readiness judgment

### What can still cause money loss?
Nothing reachable in the repository. Real money is 0, Grow is never called, and the fee ledger is protected by partial unique indexes. The residual is entirely **F13** — unproven live-provider semantics — which is exactly why it must stay a blocker.

### What can still cause duplicate fulfillment?
Before this branch: a Render deploy could SIGKILL a worker between an external side effect and its outbox ack (F-01). **Fixed in the repository; requires O-1 to take effect on the hosted service.** Below that, duplicate issuance is prevented by DB constraints and the deterministic confidentiality proof from PR #12.

### What can still cause unauthorized mutation?
Nothing reproducible. Cross-seller IDOR, forged headers, anonymous mutation and role mismatch were all attempted and all refused server-side. The residual is F-09: **do not trust the mission-control panel as evidence** that these controls are on — trust the gates.

### What can still cause unrecoverable data corruption?
No path found. Money and state truth live in CHECK-constrained columns and state-machine triggers; JSONB is confined to evidence, job envelopes and metadata; 73 foreign keys, 376 constraints, 61 drift-free migrations.

### What can still make deployment unsafe?
**O-1** (blueprint not yet synced) and **O-3** (dev toolchain in the production image). Both are hosted/CI actions with exact instructions.

### Which tests provide real confidence?
The DB-backed ones. The payment fault suite in particular (*"capture → 429 after the money moved → UNKNOWN on the SAME identity, reconciliation proves it, ONE provider effect"*) is the kind of test most systems do not have. The isolated migration proof, the startup-config matrix (it runs the **real** guard, not a mock), the route-authorization gate's behavioural probes, and the runtime-shutdown test's negative controls are all genuine.

### Which tests were misleading?
Three, all now fixed:
1. **`"…start the Node runtime itself as PID 1, never a wrapper"`** — passed while the only deployment that mattered violated it (F-02).
2. **The logging gate's notification probe** — used the wrong template key, emitted nothing, and its PASS message asserted something that never happened (F-06).
3. **The HTTP smoke's `/readiness` check** — deliberately excused from `expectNoStore` and downgraded to a non-failing note (F-10).

The pattern is consistent and worth naming: **the gates were strong where they measured, and silently weak where they described.** Every one of these has been converted from a description into a measurement, and each was **mutation-tested** — the fix reverted, the gate confirmed to fail, then restored.

### Final judgment

| Dimension | % | Basis |
|---|---|---|
| **Technical production readiness** | **88%** | Suite green; 6 startup gaps → 0; production-tree highs 4 → 0; PID-1 closed. Held back by F-07 (architecture truth), F-09 (dashboard), F-12 (image), and O-1/O-3 being hosted actions |
| **Closed pilot readiness** | **92%** | Authorization, concurrency, recovery and fulfillment confidentiality all hold under attack. Rate limiting is single-instance (fine at pilot scale); O-1 and O-2 should land first |
| **Real-money readiness** | **35%** | Deliberately low and **not** inflated. The rails are built and the fee invariant is exact, but F13 is unresolved **provider-side**, Grow live verification has not happened, and the owner has not approved activation. No repository work can move this number |

**Merge recommendation: yes.** Every change is minimal, evidence-backed, mutation-tested where practical, and verified not to regress the live staging configuration or any local lab. **Deployment recommendation: land O-1 and O-2 before the next pilot deploy.** **Real money: remains blocked, correctly.**
