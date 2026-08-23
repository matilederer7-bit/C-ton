# AWS Accordion Deployment Blueprint

Status: blueprint only. No live AWS resources are created by this document. No AWS credentials are loaded by the application at runtime.

This document describes the **accordion model** for taking Siton from a local demo to a small-market launch and, if the market responds, to rapid horizontal scale — without rewriting the application, without burning money on idle infrastructure, and with explicit cost guardrails so that abuse cannot trigger an unbounded spend.

## Verdict

- `aws_accordion_blueprint`: documented
- `tier_0_local_demo`: ready
- `tier_1_small_market_launch`: documented (open blockers listed per provider gate)
- `tier_2_accordion_scale`: documented (autoscaling caps required)
- `tier_3_mature_production`: blueprint only — not implemented
- `live_money_ready`: no
- `aws_credentials_in_repo`: no
- `state_machine_changed`: no
- `money_logic_changed`: no

## Principles

1. **Start small.** A single API instance, one managed Postgres, one bucket. No Kubernetes, no service mesh, no ingress controller, no Terraform mountain — until measured demand forces it.
2. **Stay portable.** The application has zero AWS-specific imports. Switching to Render, Railway, Fly, or a managed VPS does not require code changes — only environment changes.
3. **Expand fast.** When the market pulls, add capacity by tier — not by rewrite. Each tier transition is operational, not architectural.
4. **Cap everything.** Every scaling axis (instances, DB class, request rate, bucket egress, provider spend) must have an explicit ceiling. An open ceiling on a public surface is a bill bomb.
5. **Live money is a separate gate.** This blueprint covers packaging and deployment posture. Connecting real payment / payout / invoice providers is gated by [PROVIDER_LIVE_MONEY_READINESS.md](PROVIDER_LIVE_MONEY_READINESS.md).

---

## Tier 0 — Local / Demo

**Use it for:** development, internal demos, sandbox experimentation, recording flows.

### Components

| Component | Implementation |
|---|---|
| App | `Dockerfile` — single container, single process |
| Database | `postgres:16-alpine` via `docker-compose.yml` |
| Storage | Local filesystem (`uploads/`) — single-instance only |
| Providers | Mock (`mockpay`, `internal-ledger`, `log-only`) |
| Worker | In-process outbox worker (`DISABLE_OUTBOX_WORKER` unset) |
| Admin auth | `ADMIN_API_KEY` env, demo value only |
| TLS | None (local HTTP) |
| Logs | `pino` to stdout |

### How to run

See [DOCKER_READINESS.md](DOCKER_READINESS.md). The shortest path is `docker compose up --build`.

### Not suitable for

- Live money.
- Multiple app instances (in-process rate limit, local file storage).
- Real customer traffic (no TLS, no WAF, no rate-based abuse rules).

---

## Tier 1 — Small Market Launch

**Use it for:** first paid customers, sandbox provider validation, early-revenue pilot, controlled invite list. The intent is to **prove the product**, not to scale.

### Recommended AWS shape

| Concern | Service | Notes |
|---|---|---|
| Compute | **ECS Fargate** (1 service, 1 task) **or App Runner** | Fargate for more control, App Runner for less ops. Either is fine for a single instance. |
| Database | **Amazon RDS PostgreSQL** (`db.t4g.micro` / `db.t4g.small`) | Multi-AZ off at this tier — pick when traffic justifies the cost. Backups: 7 days minimum. |
| Object storage | **Amazon S3** (private bucket, default-deny ACL) | Required only when the storage adapter is switched from `local` to `object`. Until then, deal images live on the container's ephemeral filesystem (single-instance only). |
| Logs | **CloudWatch Logs** | Pino JSON → CloudWatch via Fargate log driver / App Runner. |
| Secrets | **AWS Secrets Manager** or **SSM Parameter Store (SecureString)** | Inject as env vars at task start. Never bake into the image. |
| TLS / DNS | **Route 53** + **ACM** | ACM cert at the load balancer / App Runner. |
| Edge / WAF | **Application Load Balancer + AWS WAF** (basic managed rules) | Or Cloudflare in front of App Runner — same posture. |

### Alternative non-AWS shapes (functionally equivalent)

- **Legacy Render evidence** is quarantined under `legacy/render/` and is not a production option. This AWS document is a supporting portability/scale reference only; Base44 + Supabase is canonical for Siton V1.
- **Railway** — Docker service + managed Postgres.
- **Fly.io** — Docker app + Fly Postgres.
- **Managed VPS** (Hetzner, OVH, DO) — single Docker host + managed Postgres add-on.

The application code does not change between these. Choose by ops budget and proximity to customers.

### Environment differences from Tier 0

```
APP_DEPLOYMENT_MODE=production            # or "sandbox" once defined
NODE_ENV=production
DATABASE_URL=<managed postgres connection string>
ADMIN_API_KEY=<rotated, stored in Secrets Manager>
EXPECTED_COMMIT_SHA=<the deployed git sha>
DEBUG_SURFACES_ENABLED=0                  # always 0 in production-like
PAYMENT_PROVIDER=stripe                   # or whichever live adapter is approved
PAYMENT_PROVIDER_API_KEY=<sandbox first, then live>
PAYMENT_WEBHOOK_SECRET=<provider-issued>
INVOICE_PROVIDER=morning                  # only after sandbox gate
INVOICE_PROVIDER_API_KEY=<sandbox first>
NOTIFICATION_PROVIDER=twilio              # or sendgrid — only after sandbox gate
TWILIO_ACCOUNT_SID=<sandbox first>
TWILIO_AUTH_TOKEN=<sandbox first>
TWILIO_FROM=<verified number>
```

### Tier 1 caps

Set these explicitly before opening the URL:

| Cap | Setting | Reason |
|---|---|---|
| ECS / App Runner max tasks | **1** | Tier 1 is single-instance — local rate limit and local storage demand it. |
| RDS max class | `db.t4g.medium` | Prevents a runaway from auto-upsizing to a $100/day instance. |
| RDS storage cap | 50 GB autoscaling cap | |
| WAF rate-based rule | 200 req / 5 min / IP | Tune for your audience — but never leave it open. |
| AWS Budget alarm | $50 / month, hard alert at 80% | |
| CloudWatch alarms | 5xx > 1% over 5min, DB CPU > 80% over 10min, DB connections > 80% of pool | |
| Provider spend caps | per provider, where supported (Twilio, Stripe Radar) | Prevents an SMS-flood DoS from billing you out of business. |

### Tier 1 blockers (per separate gate)

- `payment_provider_not_live_validated` — see [PROVIDER_LIVE_MONEY_READINESS.md](PROVIDER_LIVE_MONEY_READINESS.md).
- `payment_webhook_secret_missing_for_live`.
- `object_storage_required_before_multi_instance` — Tier 1 is single-instance, so local storage is acceptable, but switching to S3 is required before Tier 2.
- `live_security_blocked` until named admins are provisioned and shared-key fallback is retired or strictly contained.
- Reconcile runbook sign-off and explicit business approval.

### Why no Kubernetes

At one container, Kubernetes is a tax with no payoff. ECS Fargate / App Runner / Render handle the same shape — single image, env-driven config, managed updates — with a fraction of the operator surface. Re-evaluate only when there are real reasons (multi-region, complex workloads, in-house Kubernetes expertise).

---

## Tier 2 — Accordion Scale

**Use it for:** the market responds, traffic grows, sellers and buyers multiply. Capacity has to follow demand — but not at the cost of an unbounded bill.

### Component changes from Tier 1

| Change | Why |
|---|---|
| Split into **API service** and **Worker service** (two ECS services, same image, different `CMD` / `DISABLE_OUTBOX_WORKER`) | Workers and API scale on different signals — request rate vs queue depth. Mixing them prevents independent scaling. |
| **ECS service autoscaling** with explicit `min` / `max` tasks | API target: CPU + request count per target. Worker target: CPU + custom CloudWatch metric (outbox lag). |
| **RDS scale-up** (`db.t4g.large` / `db.r6g.large`) and **read replicas** for read-heavy queries | Mission Control / admin reads first, then deal browse if needed. |
| **S3 + CloudFront** for static assets and deal images | CDN hit ratio matters at this tier — see [CACHE_POLICY.md](CACHE_POLICY.md). |
| **AWS WAF rate-based + bot rules** | Real public exposure means real abuse attempts. |
| **CloudWatch dashboards + alarms + SNS → ops channel** | The accordion only works if breach signals page someone. |
| **Secrets Manager rotation** | Annual minimum, faster for high-risk creds. |
| **VPC endpoints** for S3, Secrets Manager, ECR | Less NAT gateway egress, smaller blast radius. |

### Hard caps at Tier 2 (ALL required)

| Axis | Cap | Why |
|---|---|---|
| ECS API service | `min: 2`, `max: 8` | No surprise expansion to 100 tasks. Raise the cap deliberately. |
| ECS worker service | `min: 1`, `max: 4` | |
| RDS class | up to `db.r6g.large` (or one notch above current) | Bigger jumps require explicit operator approval. |
| RDS connections | alarm at 80% of `max_connections` | DB pool exhaustion shows up here first. |
| WAF rate-based | tighten from Tier 1 — by route, not just by IP | Public-deal browsing tolerates higher rates than `/api/admin/*`. |
| AWS Budget | hard alert + email + Slack at 50% / 80% / 100% of monthly cap | The cap is the policy. The alarms enforce it. |
| Provider spend caps | per provider, ratcheted up only when business confirms | Twilio, Stripe Radar, invoice provider quotas. |
| CloudFront request rate | per behavior; off by default for `/api/*`, `/webhooks/*` | See CDN section below. |

### What does NOT change at Tier 2

- The application code.
- The state machine.
- The money / commission logic.
- The provider abstraction.
- The Mission Control / Admin Control Plane contract.

The accordion is operational, not architectural. If a Tier 2 transition starts requiring code changes, that is a blocker — investigate before scaling.

### Tier 2 prerequisites

- Tier 1 sustained for at least one full billing cycle without manual intervention.
- Object storage adapter wired (`STORAGE_ADAPTER=object` honored, S3 bucket configured).
- Outbox worker proven under load (sandbox or pilot).
- Reconcile runbook proven under load.
- Backup/restore drill performed at least once.

---

## Tier 3 — Mature Production

**Not in scope for now.** Documented so future tiers don't re-derive the same shape.

| Component | Service |
|---|---|
| Multi-AZ DB | RDS multi-AZ + read replicas across AZs |
| Backup / restore drills | scheduled monthly, evidence captured |
| Blue / green deploys | CodeDeploy or App Runner deployment configurations |
| Migration lock | advisory `pg_advisory_xact_lock` already in place; add deploy-side gate |
| Centralised logs | CloudWatch Logs → S3 → Athena, retention policy |
| SIEM | when compliance requires |
| Shared rate limit / sessions | Redis (ElastiCache) only when justified by load tests |
| Queue service | SQS or managed queue only when outbox-on-DB starts saturating writes — not before |
| Kubernetes | only with a documented justification (multi-region, complex workloads, existing K8s SRE team) |

Adopting any of these without a load-test or compliance reason is premature.

---

## CDN Readiness

CDN policy is fully documented in [CACHE_POLICY.md](CACHE_POLICY.md). Summary for the accordion:

| Surface | Cache | Place behind CloudFront? |
|---|---|---|
| `GET /app/*` (HTML / JS / CSS) | `no-store` (`index.html`), `no-cache, must-revalidate` (`app.js`, `styles.css`) | Yes, with respect for origin cache headers |
| `GET /api/deal-images/:imageId` | `public, max-age=31536000, immutable` | Yes — biggest CDN win, content-addressed |
| `GET /api/*` | `no-store` | **No** — or only with a behavior that forces `no-store` and disables caching |
| `POST /webhooks/*` | `no-store` | **No** |
| `GET /api/admin/*` | `no-store` | **No** |
| `GET /tracking`, `GET /buyer/*` | `no-store` | **No** |

Rule of thumb: only cache content-addressed assets. Anything authenticated or provider-callback related stays on the origin.

---

## Cost Guardrails / Anti-Abuse

The user's hard requirement: be ready to scale fast, but never let abuse trigger an unbounded run on a million machines. The guardrails:

1. **Cap every autoscaling axis.** ECS `max` tasks, RDS class ceiling, S3 bucket request quotas, CloudFront per-behavior limits.
2. **AWS Budgets with hard alerts** at multiple thresholds (50%, 80%, 100% of monthly cap). The first alert is the warning; the third is the page.
3. **CloudWatch alarms** on the four signals that matter:
   - 5xx error rate
   - DB CPU and connection count
   - ECS task count approaching `max`
   - WAF blocked requests rate (so a tightened rule doesn't silently DoS legitimate traffic)
4. **WAF rate-based rules** per IP and per route, plus AWS managed rule sets (`AWSManagedRulesCommonRuleSet`, `AWSManagedRulesAmazonIpReputationList`).
5. **Provider spend caps**:
   - Twilio: account balance + max-spend-per-day if available.
   - Stripe: Radar rules + transaction volume alarms.
   - Invoice provider: monthly issuance cap.
6. **Mission Control surface** — `accordion_scaling_readiness` reports `estimated_scale_risk`, `cost_guardrails_status`, `aws_blueprint_status`, `tier_status` — so the operator sees posture at a glance.
7. **No `auto-scale to infinity`** anywhere. Every cap is documented, every cap has an alarm.

The application does not implement cost guardrails inside its code (that would be the wrong layer). It documents the contract and expects the operator to enforce it via the cloud account.

---

## Rollback

| Tier | Rollback |
|---|---|
| 0 / 1 | Re-deploy a prior image tag. Migrations are additive-idempotent (see [PRODUCTION_LAUNCH_READINESS.md](PRODUCTION_LAUNCH_READINESS.md)) — rolling back code does not require rolling back the DB. |
| 2 | Same as Tier 1, plus blue/green deployment so the rollback is a traffic shift, not a re-deploy. |
| 3 | Blue/green + DB read-replica promotion drill if needed. |

The migration policy is `additive_idempotent_only`. A rollback never requires destructive DDL.

---

## What this blueprint deliberately does NOT do

- Does not load AWS credentials into the application.
- Does not bake AWS-specific clients into the application code.
- Does not provision any infrastructure (no Terraform, no CDK, no CloudFormation) — that is the operator's job, with the constraints listed above.
- Does not enable live money.
- Does not enable multi-instance (storage adapter is still local — switch to object first).
- Does not rewrite the state machine, money logic, or commission contract.
- Does not enable Kubernetes.

## Next gate

`Provider Sandbox / Live Money Validation`. Until that gate is green, the accordion can be packaged and rehearsed but not opened to live customer money.

## Cross-references

- [DOCKER_READINESS.md](DOCKER_READINESS.md)
- [ENVIRONMENT_CONTRACT.md](ENVIRONMENT_CONTRACT.md)
- [HORIZONTAL_SCALE_READINESS.md](HORIZONTAL_SCALE_READINESS.md)
- [STORAGE_PRODUCTION_FOUNDATION.md](STORAGE_PRODUCTION_FOUNDATION.md)
- [CACHE_POLICY.md](CACHE_POLICY.md)
- [PROVIDER_LIVE_MONEY_READINESS.md](PROVIDER_LIVE_MONEY_READINESS.md)
- [PRODUCTION_LAUNCH_READINESS.md](PRODUCTION_LAUNCH_READINESS.md)
- [ADMIN_MISSION_CONTROL.md](ADMIN_MISSION_CONTROL.md)
