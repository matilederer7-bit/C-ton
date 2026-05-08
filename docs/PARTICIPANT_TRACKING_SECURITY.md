# Participant Tracking Security

Status: token foundation implemented; demo compatibility remains, production-like environments require tokenized access.

## Problem

The previous buyer tracking contract was a bearer link based only on `participant_id`. That is useful for demo UX, but anyone holding the link could view the tracking surface.

## Token Model

`siton.participant_tracking_tokens` stores:

- `participant_id`
- `deal_id`
- `token_hash`
- `purpose`
- `status`
- `expires_at`
- `last_used_at`
- `revoked_at`
- `issued_via`
- `correlation_id`

Raw token is returned only once when issued. The DB stores hash only.

Purposes:

- `tracking`
- `recovery`
- `receipt`
- `support`

## Access Policy

Tracking and recovery endpoints accept:

- `Authorization: Bearer <token>`
- `?t=<token>` for SMS/link UX

Production-like environments block legacy participant-id-only access. Local/demo compatibility may still allow legacy links for existing tests and demo flows.

## Expiry And Revocation

Tokens expire after a bounded TTL. Revocation support exists through helper functions and DB status fields. A full admin UI for rotation/reissue can be added later without changing the storage contract.

## Recovery Flow

Recovery accepts a valid `recovery` or `tracking` token, or legacy demo compatibility outside production-like mode. It still rejects raw card data and does not change the money state in the request thread.

## Live Blocking Rules

Live/security verdict remains blocked if:

- production-like tracking lacks tokenized access,
- legacy bare links are allowed in live mode,
- token issuance/rotation/revocation operational policy is missing,
- recovery links are sent without a valid token.
