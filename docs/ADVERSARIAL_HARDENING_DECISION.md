# Adversarial Hardening Decision

## Executive Decision

ADVERSARIAL HARDENING PASSED WITH NON-BLOCKING GAPS

## What Was Attacked

- malformed and partial API payloads
- invalid route identifiers
- OTP/session abuse
- broken flow sequencing
- idempotency collisions and conflicting replays
- malformed, unknown, and duplicate webhooks
- direct frontend route misuse
- system observability under weird but controlled states

## What Broke

- deal creation input validation was too soft against malformed date and numeric input
- invalid UUID route parameters were not blocked early enough
- webhook body validation was too permissive
- out-of-sequence state transitions such as `prepare_charging` and `charging/start` could previously surface as `500`

## What Was Fixed

- explicit input validation for numbers, positive integers, datetimes, and UUIDs
- explicit OTP session and phone-shape validation
- explicit webhook shape validation
- controlled `409` handling for broken sequence/state preconditions
- adversarial validation coverage was added and folded into `npm test`

## What Is Still Soft But Non-Blocking

- payment execution is still mock-backed
- notifications are still log-only
- browser automation is still not the primary abuse harness

## What Cannot Be Proven Until External Activation

- live provider-side behavior under real network and provider contracts
- full provider webhook matrix
- real outbound notification delivery and its failure modes

## Recommended Next Step

- keep the current adversarial baseline as the last internal gate
- when external activation begins, reuse the new abuse suite and extend it against the first real provider and notification transport
