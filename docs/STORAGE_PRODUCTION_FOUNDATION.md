# Storage Production Foundation

Status: the canonical adapter contract and reliable local Docker adapter are implemented. No external object-storage provider has been selected or implemented. Payment Sandbox and any public pilot remain blocked until that provider gate is completed.

## Canonical contract

`src/storage_adapter.ts` is the only storage contract. It provides `put`, `get`, `delete`, `exists`, `listKeys`, readiness metadata, and capability reporting. API responses expose only an image UUID URL; filesystem roots and storage keys are never public.

Stored metadata is distinct from object bytes: PostgreSQL keeps the internal storage key, normalized original filename, verified MIME type, byte size, SHA-256 checksum, creation time, owner deal and provider. The adapter stores only the bytes under the internal key.

## Local test and Docker storage

Local storage is allowed only in test, development and demo-preview. `DEAL_IMAGE_UPLOAD_DIR` is the preferred explicit root; `UPLOAD_DIR` remains a compatibility alias. The Docker image creates `/var/lib/siton/uploads/deal-images`, assigns it to the non-root `appuser`, and the CI compose file mounts a named volume there for restart and two-Web tests.

`put` writes a mode-0600 `.partial-<uuid>` file, flushes it, atomically publishes it with a no-overwrite hard link, and removes the partial file on success or failure. Client filenames never form a storage path. Upload mutations for one deal are serialized in PostgreSQL so two Web instances cannot race the five-image or primary-image constraints.

The safe cross-system order is: authorize and validate; create an internal key; write and verify storage; insert metadata inside the DB transaction; return 201 only after commit. If the DB operation fails after storage succeeds, the route deletes the stored object. If storage fails, no valid DB row is created.

## Security policy

- Maximum size: 5 MiB; empty files are rejected.
- Allowlist: JPEG, PNG and WebP. SVG, HTML and executable formats are rejected.
- Magic bytes must match the declared MIME type.
- Traversal, slash/backslash/NUL filenames and storage keys outside the adapter root are rejected; Unicode filenames are normalized to NFC.
- Existing keys cannot be overwritten, directory listing is not public, internal paths are not returned, and downloads use the database-authorized image UUID with fixed MIME and `Cache-Control: public, max-age=31536000, immutable`.
- Logs do not include file bytes. External antivirus is not currently integrated and must be reviewed before a public upload pilot.

## External storage and production blocker

There is no real external adapter in this repository. `STORAGE_ADAPTER=object` is readiness configuration only; a provider implementation is still required. A local volume or Render `/tmp` is not a production solution. The existing production guard continues to reject `STORAGE_ADAPTER=local`.

No provider-specific secret names can be canonical until a provider is selected. The future adapter will require, at minimum, provider endpoint/region configuration, bucket/container identifier, access identity/credential supplied only through deployment secrets, access policy, lifecycle policy and an authorized/signed-read strategy. No credentials are committed here.

Render demo-preview currently configures `/tmp/uploads`; it is writable but ephemeral. Therefore a restart-safe payment Sandbox and public pilot remain blocked until the external adapter is selected, implemented, contract-tested and configured with deployment secrets.

## Validation

Local gates cover atomic publication, failure cleanup, no overwrite, MIME sniffing, traversal, Unicode, authorization, DB checksum metadata and no pre-commit 201. GitHub Actions runs real HTTP uploads against two non-root Web containers sharing a named volume, cross-instance reads, restart persistence, migrations, Web/Worker smoke, and verifies production-local-storage rejection. The CI image is removed with its test volume after the smoke.