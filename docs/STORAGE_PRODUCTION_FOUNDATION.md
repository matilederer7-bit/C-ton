# Storage Production Foundation

Status: Stage 5a implements a provider-neutral, private S3-compatible object-storage adapter behind the canonical contract in `src/storage_adapter.ts`. Local storage remains available only for development, tests and demo use. Activation against an authorized external Sandbox/Production account is still an operational gate; no real credentials are stored in this repository.

## Canonical contract and object model

The contract provides `put`, `head`/metadata, `get`, idempotent `delete`, `exists`, prefix listing, short-lived signed reads, readiness/capability reporting, timeouts and abort signals. Provider failures map to stable application codes for missing objects/buckets, denied access, timeouts, collisions and verification failures. AWS SDK imports are confined to the adapter boundary.

Object keys are server-generated and never use the client filename: `<environment>/deals/<deal UUID>/images/<random UUID>.<verified extension>`. The bucket must be private. Authorized application downloads retain `Cache-Control: public, max-age=31536000, immutable` for immutable UUID resources. Public API responses contain an authorized application URL by image UUID; the application resolves the internal key from PostgreSQL. The adapter can also create a short-lived signed GET URL for authorized internal use.

PostgreSQL remains the metadata source of truth: provider code, internal key, normalized original filename, verified MIME type, size and SHA-256. Object bytes are stored only in object storage.

## Safe write and cleanup order

The upload order is validate and authorize, generate key, upload privately with no-overwrite semantics, HEAD-verify size and SHA-256, write DB metadata in the transaction, commit, then return 201. A storage failure creates no DB row. If the DB write fails, the Web process immediately deletes the object. If that delete fails, migration `044_storage_cleanup_tasks.sql` provides an idempotent retry queue processed by the separate worker with bounded exponential retry and redacted error codes.

## Runtime configuration

Set these only through the deployment environment/secret manager for both Web and Worker:

- `STORAGE_ADAPTER=object`
- `OBJECT_STORAGE_ENDPOINT` — optional for AWS S3; required for a compatible custom endpoint
- `OBJECT_STORAGE_REGION`
- `OBJECT_STORAGE_BUCKET`
- `OBJECT_STORAGE_ACCESS_KEY_ID`
- `OBJECT_STORAGE_SECRET_ACCESS_KEY`
- `OBJECT_STORAGE_FORCE_PATH_STYLE=1` only where required (MinIO uses it)
- `OBJECT_STORAGE_PREFIX=sandbox` or `production`
- `OBJECT_STORAGE_TIMEOUT_MS=5000`
- `OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS=300`

Object mode fails closed when required configuration is absent or placeholder-like. Production also refuses local storage. Use distinct least-privilege credentials per environment, a private bucket, encryption at rest, provider access logging, restricted CORS, and a lifecycle rule for provider-side abandoned multipart uploads. Rotation is performed in the provider/secret manager and followed by a Web/Worker restart; no credential belongs in Git, logs, images, CI artifacts or client code.

## Local and CI validation

Local unit tests use the filesystem adapter and an in-memory S3 protocol double. Docker CI uses a real MinIO server, private persistent bucket, PostgreSQL, two Web instances and the Worker. It tests upload, HEAD metadata, checksum, listing, download, delete/re-delete, no overwrite, signed reads and expiry, anonymous denial, bad credentials, missing bucket, read-only/write-only permissions, endpoint outage, cross-Web reads, service restart persistence, same client filename isolation, DB metadata and cleanup retry. The Docker named local upload volume is deliberately absent in object-mode smoke tests.

An authorized real provider account was not supplied. Therefore provider-console checks for encryption, lifecycle, access logs, IAM policy, rotation and real external restart persistence remain explicitly blocked until credentials and an approved Sandbox bucket are provided. This does not permit Stage 5b or live payment activation.
