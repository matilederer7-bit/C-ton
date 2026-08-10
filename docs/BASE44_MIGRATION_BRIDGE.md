# Base44 Migration Bridge

Date: 2026-08-10
Branch: `base44-migration-spike`

## Purpose

Create a reversible migration bridge between canonical Siton and a separate Base44-owned application without moving, deleting, rewriting or re-owning the canonical Siton core.

## Repository topology

The canonical `C-ton` repository remains independent and keeps `master` as its source of truth.

The Base44 editor app must use its own dedicated GitHub repository. We intentionally do not permanently attach the Base44 editor to the canonical `C-ton` repository. Base44's editor GitHub synchronization is permanent and currently synchronizes through a `main` branch, while Siton's canonical repository uses `master`.

The `base44-migration-spike` branch in `C-ton` is therefore a migration laboratory and reference package only. It is not the future Base44 repository and it is not a production ownership transfer.

## Non-negotiable boundaries

- `master` remains untouched by this experiment.
- Canonical runtime files under `src/` remain unchanged in the bridge stage.
- PostgreSQL migrations remain unchanged.
- The standalone Worker remains unchanged.
- Payment, Stripe, webhook, outbox, reconciliation and state-transition behavior remain unchanged.
- No production traffic is routed through Base44 yet.
- No Base44 entity is a source of truth for deal state, buyer state or money state in this stage.
- No code is cut out of Siton before its replacement is separately proven.

## Added reference surfaces in the migration laboratory

- `base44/config.jsonc` — portable Base44 project declaration used to validate the bridge structure.
- `base44/functions/bridge-info/` — read-only readiness function. It performs no Siton mutation and no payment action.
- `bridge/base44-ui/` — isolated React/Vite reference surface used to prove that the Base44-facing layer can build independently.

These files are Copy + Adapt material. They do not make the canonical repository a Base44-owned app.

## Migration rule

Capabilities move by Copy + Adapt, never Move-first.

For each capability:

1. copy or reproduce the existing contract on the Base44 side,
2. verify it against canonical behavior and tests,
3. prove the Base44 implementation independently,
4. route only the selected capability to the new path,
5. keep rollback available,
6. remove legacy ownership only in a later explicit milestone.

## First capability after bridge activation

Read-only connectivity only.

The first real integration must read a harmless Siton Core status/read endpoint. It must not create a deal, join a buyer, change state or perform any financial action.

## Exit criteria for Bridge Stage 0

- Separate Base44 app exists.
- Base44 app is connected by its owner to a dedicated GitHub repository created for that app.
- `C-ton` migration branch remains isolated from `master`.
- Base44 reference bridge site builds.
- Base44 reference bridge function passes its non-mutating gate.
- Existing Siton core files show zero diff.
- Existing canonical test suite remains green.
- A Base44-to-Siton read-only call is proven before any write-path migration starts.

## Rollback

Delete the Base44 migration app/repository and the `base44-migration-spike` branch. The canonical Siton runtime remains exactly as it was before the experiment.
