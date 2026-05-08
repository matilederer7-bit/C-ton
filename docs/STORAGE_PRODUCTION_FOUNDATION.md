# Storage Production Foundation

Status: adapter contract added. Local storage adapter shipped. Object storage adapter is intentionally not connected. Multi-instance pilot remains blocked until object storage is wired.

## Adapter Contract

`src/storage_adapter.ts` defines the `StorageAdapter` interface:

- `put(key, content)`
- `get(key)`
- `delete(key)`
- `listKeys(prefix?, limit?)` — read-only, used by the orphan report
- `describeForReadiness()` — masked summary for Mission Control
- `capabilities()` — declares whether the adapter is multi-instance safe

The contract guarantees:

- No path traversal — every key resolves inside the configured root.
- No executable HTML/SVG/JS upload — image uploads enforce a strict MIME allowlist (`image/jpeg`, `image/png`, `image/webp`).
- Size limit `5 MB` enforced before write.
- The orphan report is read-only — it never deletes files.

## LocalStorageAdapter

The shipped adapter is `LocalStorageAdapter`. It reads/writes the `DEAL_IMAGE_UPLOAD_DIR` (default `uploads/deal-images`).

It is single-instance only:

- Cannot share filesystem state across app instances behind a load balancer.
- `capabilities().multi_instance_safe = false`.
- `scale_blocker_for_multi_instance = true`.

## ObjectStorageAdapter

The contract for an object storage adapter is documented but not implemented in this MVP. Activation is a separate provider gate. It requires:

- A live cloud provider (S3 / R2 / GCS / Spaces).
- Credentials in the environment (never committed).
- Bucket policy and lifecycle rules.
- Signed-URL strategy if private content is needed.
- Migration plan for existing local files.

`STORAGE_ADAPTER=object` will be honored only after the implementation lands.

## Mission Control

`mission_control.storage_readiness` reports:

- `adapter` — `local` | `object`
- `storage_provider` — currently `local`
- `multi_instance_safe` — currently `false`
- `scale_status` — currently `partial`
- `object_storage_configured` — env presence boolean
- `object_storage_live_ready` — currently `false`
- `deal_image_max_bytes`, `allowed_mime_types`
- `path_traversal_protection` — `storage_adapter_resolveSafe`
- `public_image_cache_policy` — content-addressed immutable for `GET /api/deal-images/:imageId`
- `active_image_keys_count` — current number of `siton.deal_images` rows
- `last_orphan_report` — most recent persisted summary
- `blockers` — includes `object_storage_required_before_multi_instance`

## Orphan Report

`GET /api/admin/storage/orphan-report` cross-checks DB image keys against keys present in the adapter. It returns:

- `scanned_storage_keys`
- `scanned_db_keys`
- `orphan_keys_sample` — keys present in storage but not in `siton.deal_images`
- `missing_files_sample` — keys present in `siton.deal_images` but missing on disk

The endpoint is read-only and never deletes. A summary row is persisted into `siton.storage_orphan_reports` for audit, without raw keys, so the filesystem layout is not leaked.

## Cache Policy

- `GET /api/deal-images/:imageId` is `Cache-Control: public, max-age=31536000, immutable`. The image id is a content identity surrogate (uuid) and the asset is treated as immutable.
- All other API and webhook surfaces remain `no-store`.

## Validation

- `npm run test:storage-readiness` — adapter contract and Mission Control fields.
- `npm run test:cache-policy` — cache header policy.
- `npm run test:scale-readiness` — scale posture references the storage adapter.
