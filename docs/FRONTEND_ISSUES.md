# Frontend Issues

## Active Notes

- source `.docx` extraction through XML is noisy in Hebrew encoding, but the required product rules and UX constraints were still recoverable and were resolved by priority:
  1. system specification
  2. product specification
  3. UX
- no blocker found so far from this issue
- `tsx src/app.ts` is not a reliable runtime validation path inside the current sandbox because `esbuild` hits `spawn EPERM`
- runtime validation was completed instead through a stable `npx tsc --outDir .tmp_frontend_dist` plus `node .tmp_frontend_dist/app.js` path

## Resolved During Validation

- initial `publish` validation failed with `Unsupported Media Type` when the request body was omitted
- rerun with `Content-Type: application/json` and `{}` body validated the route correctly
- a `deal not found` check using a non-UUID string produced a database-level `500`; rerun with a valid unknown UUID returned the expected `404`
