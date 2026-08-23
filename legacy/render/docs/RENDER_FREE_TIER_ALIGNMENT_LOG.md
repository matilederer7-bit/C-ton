# Render Free Tier Alignment Log

## Phase A - Current Render Pricing Cause

- The current `render.yaml` did not pin instance plans explicitly.
- According to Render Blueprint docs, when `plan` is omitted:
  - new web services default to `starter`
  - new databases default to `basic-256mb`
- That exactly explains the paid preview shown in the Render UI:
  - `database siton-demo-db (Basic-256mb)`
  - paid monthly total

## Phase B - Free Tier Alignment

- Chosen path: keep the Blueprint path
- Reason:
  - Render docs explicitly support `plan: free` for web services
  - Render docs explicitly support `plan: free` for Render Postgres
  - This is simpler and cleaner than switching to a manual deploy path

- Applied changes:
  - set `services[0].plan: free`
  - set `databases[0].plan: free`

## Phase C - Practical Free-Tier Notes

- Free web service remains acceptable for preview/demo only
- Free Postgres remains acceptable for preview/demo only
- Relevant Render limits that still apply:
  - only one active free Postgres per workspace
  - free Postgres expires after 30 days
  - free services are not suitable for commercial production

## Phase D - Final Alignment Result

- The Blueprint is now aligned to a free-tier demo path
- No change was made to demo guardrails
- No real external rails were activated
