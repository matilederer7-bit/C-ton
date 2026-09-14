# Reproducible build

Command: `npm run check:reproducible-build` (`scripts/reproducible_build_check.cjs`), `--include-web` for the Vite build. Two clean builds per artefact, trees compared by SHA-256, every difference classified as `deterministic`, `expected-variance` (build id / timestamp token only) or `unexpected-nondeterminism` (FAIL).

## Result (2026-09-14, Node 24.13.1 locally; CI uses Node 22)

| Artefact | Files | Tree sha256 (prefix) | Verdict |
|---|---|---|---|
| demo bundle (`npm run build:demo` -> `.demo_dist`) | 82 | `a7796d28dc4b1fea` | DETERMINISTIC |
| mobile bundle (`scripts/build_mobile_bundle.cjs` -> `.mobile_dist`) | 17 | `c29b38e7f196a16d` | DETERMINISTIC |
| web (Vite, `web/dist`) | 10 | `b0b98e61a8d94cfb` | DETERMINISTIC |

## Identity tokens (release identity, not noise)

- `frontend/index.html` asset version comes from `RENDER_GIT_COMMIT` / `COMMIT_SHA` / `GIT_COMMIT` / `git rev-parse --short HEAD`; it falls back to `Date.now()` only outside a git checkout. Stable per commit.
- `.mobile_dist/mobile-build.json` embeds the git revision. Stable per commit.
- The Docker image adds the base image digest and `npm ci` output; the image itself is not bit-reproducible (layer timestamps), but its contents are the deterministic bundles above plus the lockfile-pinned `node_modules`.

## Meaningful nondeterminism to know about

- Node major differs between local (24) and CI/Docker (22). The TypeScript output is identical across these majors for this project (same `typescript` version drives emission), but native module builds or `npm ci` optional dependencies can differ. Release identity is therefore the git SHA plus the CI-built image, not a local build.
- `npm ci` writes no artefact into the trees compared here.

The manifest (`npm run release:manifest`) records the three tree hashes so a deployed artefact can be matched back to a SHA.
