# Morning Handoff - Demo Deployment Execution

> **SUPERSEDED — HISTORICAL (2026-09-30).** This document is tiered ARCHIVE in `docs/DOCUMENTATION_MAP.md`: history, never authority. Its decisions, "canonical" lists and contracts describe an earlier state of the project. Product rules are in `docs/SITON_PRODUCT_CONSTITUTION_2026-09-30.md`, the runtime in `docs/CURRENT_ARCHITECTURE_2026-09-30.md`, current state in `PROJECT_STATUS.md`.

> **Historical product-scope notice (2026-08-23):** this handoff predates the
> Siton V1.1 Mall decision and is not current product-direction canon.

- What was checked:
  - canonical start path
  - canonical build path
  - environment requirements
  - hostability of the artifact
  - compiled runtime startup
  - health, integrations health, preview meta, and app shell

- What was prepared:
  - `build:demo`
  - `start:demo`
  - `start:demo:prod`
  - `tsconfig.demo.json`
  - `scripts/build_demo_bundle.cjs`
  - `Dockerfile`
  - `.dockerignore`
  - `Procfile`
  - `.env.demo.example`

- What was actually deployed:
  - not to an external URL
  - yes to a verified local compiled artifact startup

- Is there a live URL?
  - No. Not from this environment.

- What works on the prepared package:
  - `/health`
  - `/health/integrations`
  - `/api/preview/meta`
  - `/app`
  - full test suite still passes

- What remains demo-only:
  - payment
  - receipts
  - delivery
  - payout
  - KYC
  - notifications

- What remains external-only:
  - payment rail
  - invoice rail
  - shipping rail
  - payout rail
  - KYC provider
  - outbound notification rail

- How to present the system:
  - as a live preview/demo environment
  - not as a commercial marketplace
  - not as a real payment system

- Recommended next morning step:
  - choose one concrete host target
  - copy `.env.demo.example` into host env vars
  - run the package with the canonical demo start path
  - verify the resulting public URL with the same sanity checklist
