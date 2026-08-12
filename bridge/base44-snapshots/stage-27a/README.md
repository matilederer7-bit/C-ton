# Base44 app snapshot - Stage 27A

This directory is a recoverable, one-way snapshot of the Base44 app "ראש גשר".

- Base44 app id: `6a79b3ce58f678716af8d295`
- Base44 sandbox commit: `a0385098c2c8a45b968da623d8509f2bc7b8aa7f`
- Base44 checkpoint: `6a7c35854b41a04e8aed3304`
- Tracked files: 253
- Archive bytes: 305571
- SHA-256: `819cd064aefbbc5e41e7953db6b2b6962659128dd281353194cfc4fa84a9d607`
- Captured: 2026-08-12

## Restore or inspect

```bash
sha256sum -c SHA256SUMS
tar -xzf base44-app-a0385098.tar.gz
```

The archive expands under `base44-app-stage-27a/`.

## Safety status

This snapshot does not modify the canonical C-ton runtime on `master` and is not a production release. The Base44 app still persists to its internal S3-backed git repository. Build, ESLint and the full JavaScript/JSX typecheck passed at capture time. Join, real money and external providers remain fail-closed or unconnected. The Constitution gate remains red and must not be represented as production-ready.
