# Base44 Stage 30A recovery snapshot

This directory contains a complete one-way recovery snapshot of the Base44 app at sandbox commit `dc5a6b436e4e01b8529e4008dc01ee1c7381e880`.

- Base44 checkpoint: `6a7c47c5ad5a1f70c7bf3d37`
- tracked files: 254
- archive: `base44-app-dc5a6b43.tar.gz`
- SHA-256: `b959705a4f777de198cca5086d0c473dadb6478b9fdcc54926ef8ef05fb16d61`
- overall Siton-to-Base44 code migration: 98%
- production readiness: not measured and not ready

Verify:

```bash
sha256sum -c SHA256SUMS
```

Extract into an empty directory:

```bash
tar -xzf base44-app-dc5a6b43.tar.gz
```

This is a recovery snapshot, not a two-way Base44/GitHub integration. The active Base44 code remains in Base44's internal repository. Draft PRs remain unmerged.
