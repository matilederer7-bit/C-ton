# Base44 GitHub Sync Requirement

Date: 2026-08-11
Base44 app: `ראש גשר` (`6a79b3ce58f678716af8d295`)
Migration branch in legacy repo: `base44-migration-spike`

## Current state

The Base44 app is currently stored in Base44 internal git only.

Observed from the live Base44 sandbox:

- `git_remote_source`: `s3`
- git remote: `s3://base44-app-repositories/6a79b3ce58f678716af8d295`
- Base44 app branch: `main`

Therefore Base44 checkpoints/commits are real and restorable inside Base44, but the app source is not currently mirrored to GitHub.

The legacy `matilederer7-bit/C-ton` repository remains separate and must not be overwritten or converted destructively.

## Official Base44 constraint

Base44 2-way GitHub sync must be initiated by the app owner from the Base44 Dashboard. After connection, app changes sync automatically to the connected repository. The documented flow creates a GitHub repository for the app, requires the synchronized main branch to be named `main`, and documents the GitHub connection as permanent.

## Migration decision

Do not attach or overwrite the legacy C-ton repository as part of this step.

Recommended topology:

1. Keep `matilederer7-bit/C-ton` unchanged as the legacy engine, specification reference, test oracle and fallback.
2. Connect the Base44 app to a dedicated new GitHub repository, for example `siton-base44` or `C-ton-base44`.
3. Use that new repository as the canonical source for the Base44 implementation once 2-way sync is enabled.
4. Keep migration/status documentation in the legacy repository until the new Base44 repository is connected and verified.
5. After connection, require the normal Siton workflow on the Base44 repo as well: inspect changes, update project status, clear commit message, push/sync, CI gates.

## Manual owner action required

This specific action cannot be completed by the coding agent because Base44 requires the app owner to authorize the initial GitHub connection in the UI.

When ready:

1. Open Base44 app Dashboard.
2. Open GitHub from the top panel.
3. Choose Connect to GitHub.
4. Authorize Base44 Builder for the desired GitHub account/organization.
5. Create a dedicated repository for the Base44 app.
6. Verify Base44 reports GitHub connected and the repository contains the current app source.
7. Verify a small Base44 code change appears in GitHub automatically before treating the sync as proven.

## Safety

Do not perform this connection while another Base44 AI agent is actively changing the app. Preserve the current Base44 checkpoints before connection. Do not delete the legacy C-ton repository or merge its old Fastify/PostgreSQL runtime into the new Base44 repository merely for cosmetic repository unification.
