# Deterministic fault boundary map

Stage 5b fault injection is an internal test module. It has no HTTP route, request header, deployment flag, or environment-controlled activation. Arming a fault requires an in-process import, `NODE_ENV=test`, and a non-production deployment mode. State is process-local and reset between isolated test files.

| Boundary | Durable before fault | Reversible action | Intermediate state | Recovery and duplicate guard |
|---|---|---|---|---|
| DB before BEGIN / after BEGIN / before COMMIT | none | transaction rollback | open transaction | rollback; no response and no durable side effect |
| DB after COMMIT | complete transaction | compensating domain operation only | client outcome unknown | retry through existing idempotency key; no rollback after commit |
| Storage before PUT | none | none | no object | retry |
| Local storage after bytes, before publish | temporary partial only | remove partial | final key absent | retry; partial is deleted |
| Object storage after PUT, before HEAD | object bytes | delete object | metadata absent | compensating delete; upload retry remains safe |
| HEAD/checksum | object bytes | delete object | verification unknown/mismatch | fail closed and delete object |
| Image metadata insert | object bytes | delete or one cleanup task | object without DB metadata | immediate delete; durable unique cleanup task if delete fails |
| Storage delete before/after success | metadata already removed | cleanup task / idempotent delete | deletion outcome unknown | retry delete; missing object is success |
| Cleanup after claim | task is `processing` with generation | lease reclaim | unacknowledged claim | expired claim is reclaimed; stale generation cannot ack |
| Cleanup before ack | object deletion may be durable | retry idempotent delete | task processing | retry/reclaim and conditional generation ack |
| Outbox after claim | event is processing with worker lease | lease reclaim | external action not started | expired lease returns to pending |
| Worker before ack | external action may be durable | provider/idempotency reconciliation | event processing | worker ownership and lease guard stale ack; provider idempotency prevents double effect |
| HTTP upload/delete/join/OTP after commit | domain mutation is durable | domain-specific retry | response outcome unknown | canonical idempotency/proof/object identity returns one outcome without duplicate effect |
| Web SIGTERM | committed work remains | open transaction rollback | draining request | Fastify drain then pool close |
| Worker SIGTERM | claimed work has lease | lease reclaim | active cycle drains until timeout | heartbeat transitions and lease-based restart recovery |

Fault actions are deterministic `throw`, explicit `block` barriers, and process `crash`. Tests use barriers rather than sleeps; secret, OTP, proof, credential, and card values are excluded from fault reports.