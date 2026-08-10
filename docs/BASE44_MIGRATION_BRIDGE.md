# Base44 Migration Bridge

Date: 2026-08-10
Branch: `base44-migration-spike`

## Purpose

Create an isolated Base44 foothold inside the Siton repository without moving, deleting, rewriting or re-owning the canonical Siton core.

## Non-negotiable boundaries

- `master` remains untouched by this experiment.
- Canonical runtime files under `src/` remain unchanged in the bridge stage.
- PostgreSQL migrations remain unchanged.
- The standalone Worker remains unchanged.
- Payment, Stripe, webhook, outbox, reconciliation and state-transition behavior remain unchanged.
- No production traffic is routed through Base44 yet.
- No Base44 entity is a source of truth for deal state, buyer state or money state in this stage.

## Added surfaces

- `base44/config.jsonc` — Base44 project declaration for the migration bridge.
- `base44/functions/bridge-info/` — read-only readiness function. It performs no Siton mutation and no payment action.
- `bridge/base44-ui/` — isolated React/Vite surface intended to become the first Base44-hosted Siton UI.

## Migration rule

Capabilities move by Copy + Adapt, never Move-first.

For each capability:

1. reproduce the existing contract in the Base44 side,
2. verify it against the canonical behavior and tests,
3. route only the selected capability to the new path,
4. keep rollback available,
5. remove legacy ownership only in a later explicit milestone.

## First capability after bridge activation

Read-only connectivity only.

The first real integration must read a harmless Siton Core status/read endpoint. It must not create a deal, join a buyer, change state or perform any financial action.

## Exit criteria for Bridge Stage 0

- Base44 app exists.
- GitHub branch is isolated from `master`.
- Base44 bridge site builds.
- Base44 bridge function deploys.
- Existing Siton core files show zero diff.
- Existing canonical test suite remains green.
- A Base44-to-Siton read-only call is proven before any write-path migration starts.

## Rollback

Delete the Base44 migration branch/app. The canonical Siton runtime remains exactly as it was before the experiment.
