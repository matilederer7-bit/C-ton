# Off-site Storage Backup Runbook — Siton

Status: PR-8a implementation guide for the canonical Supabase Storage bucket `deal-images`. This lane is secrets-gated; its existence does not prove a backup currently exists.

## Why this exists

Supabase database backups contain Storage metadata but not Storage object bytes. Read-only census on 2026-10-04 found 49 objects totaling 19,003,844 bytes in `deal-images`. Those bytes need a separate off-site copy.

## Security boundary

Supabase documents generated S3 access keys as server-side credentials with full Storage S3 access across project buckets that bypass RLS. Therefore:

- store the source S3 key pair only in GitHub Actions Secrets;
- never copy it to Render, frontend code, repo files, tickets or chat;
- the workflow exposes it only to the list/download step;
- the source step performs list + download only and never uses `--delete`;
- do not rotate credentials automatically; rotation requires owner approval;
- CI gets only the age public recipient. The age private identity stays offline with the owner.

## Required GitHub Actions secrets

Source Supabase Storage:
- `SITON_STORAGE_BACKUP_S3_ACCESS_KEY_ID`
- `SITON_STORAGE_BACKUP_S3_SECRET_ACCESS_KEY`
- `SITON_STORAGE_BACKUP_S3_ENDPOINT`
- `SITON_STORAGE_BACKUP_S3_REGION`

Existing off-site destination/encryption:
- `OFFSITE_BACKUP_ENCRYPTION_PUBLIC_KEY`
- `OFFSITE_BACKUP_S3_BUCKET`
- `OFFSITE_BACKUP_S3_ACCESS_KEY_ID`
- `OFFSITE_BACKUP_S3_SECRET_ACCESS_KEY`

Optional destination:
- `OFFSITE_BACKUP_S3_ENDPOINT`
- `OFFSITE_BACKUP_S3_REGION`
- `OFFSITE_STORAGE_S3_PREFIX`

Never put any secret value in this document.

## What a successful run proves

A run ending with `OFFSITE_STORAGE_BACKUP_PASS` proves that the workflow:

1. listed the source bucket;
2. downloaded source object bytes;
3. matched source and local object count + total bytes;
4. created an archive and hashed it;
5. encrypted the archive with the owner public age key;
6. shredded the plaintext archive;
7. uploaded the encrypted object and manifest to off-site storage;
8. downloaded the encrypted object back and verified its sha256.

It does not prove disaster recovery. PR-8 remains OPEN until a real stored archive is decrypted with the owner-held private identity and restored into a disposable Supabase project/bucket.

## Restore drill — owner machine only

Prerequisites: off-site read credentials, age private identity, AWS CLI, age, tar, and S3 credentials for a disposable Supabase project.

1. Download the `.tar.age` object and its manifest.
2. Verify encrypted sha256 against the manifest.
3. Decrypt locally with the offline age identity.
4. Verify plaintext archive sha256.
5. Extract the archive.
6. Verify local object count and bytes against the manifest.
7. Sync `deal-images/` into a disposable Supabase Storage bucket.
8. List the disposable bucket and re-check count and bytes.
9. Fetch representative JPEG/PNG/WebP objects and confirm they render.
10. Shred the plaintext archive and extracted copy after evidence is recorded.

Never restore into the live bucket as a drill.
