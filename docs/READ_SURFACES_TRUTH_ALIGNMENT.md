# Read Surfaces Truth Alignment

Last updated: 2026-04-19

## Gaps Found

- Seller receipts surface generated pseudo receipt ids instead of relying on actual `invoice_documents` rows.
- Receipt counts could imply documents existed even when no issued document row was present yet.
- Admin read surfaces showed notification mode and invoice readiness at a high level, but not the live pending / failed / issued truth already available from operational endpoints.
- Support read surfaces still exposed raw internal scope and status codes where a product-facing internal operator label was cleaner.

## What Was Aligned

- Seller receipts now rely on actual `invoice_documents` truth:
  - real `document_id` when a row exists
  - explicit `not_issued` state when no row exists
  - receipt-document counts now reflect only rows with `status='issued'`
- Receipt note copy now states clearly that no document is shown unless an actual row exists.
- Admin overview now loads and surfaces read-only notification and invoice status endpoints, so pending / failed / issued visibility comes from canonical operational data.
- Support scope and support ticket status labels are normalized for operators instead of exposing raw internal codes as-is.

## Real Not-Available Cases That Now Stay Explicit

- No issued invoice document row yet
- Notification still pending or failed
- No open support ticket exists yet
- Completed deal financial summary exists, but external invoice transport still remains inactive

## Still Open For A Later Pass

- Deeper buyer-facing document visibility once a dedicated buyer document surface is opened
- Richer admin notification drill-down by template / participant if we later want a dedicated operations track
- External invoice delivery and external notification delivery remain outside this track
