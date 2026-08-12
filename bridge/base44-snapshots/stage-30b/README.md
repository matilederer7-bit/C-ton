# Base44 Stage 30B snapshot

This directory is a one-way recovery snapshot of the Base44 app after Stage 30B.

- App: ראש גשר
- App id: `6a79b3ce58f678716af8d295`
- Final Base44 checkpoint: `6a7c5ba48c241a98d42a7a2d`
- Sandbox commit: `52a7a3956f08d5b45cb5a25b69948e5c63fe8c1f`
- Tracked files: 255
- Archive: `base44-app-52a7a395.tar.gz`
- SHA-256: `2a1f4720a91013590e91051fadb74351681403cbed54a11b8db8ed5f6782e819`

The active app remains in Base44 internal git. This snapshot does not establish two-way GitHub sync and does not enable Join, payments, production traffic or any external provider.

## Verify

```bash
sha256sum -c SHA256SUMS
tar -tzf base44-app-52a7a395.tar.gz >/dev/null
```

## Restore to a new directory

```bash
mkdir restored-base44-stage-30b
tar -xzf base44-app-52a7a395.tar.gz -C restored-base44-stage-30b
```

`TRACKED_FILES.txt` is the ordered manifest used to create the archive. `PROJECT_STATUS.md` records the milestone, proofs, open blockers and 99% code-migration estimate.
