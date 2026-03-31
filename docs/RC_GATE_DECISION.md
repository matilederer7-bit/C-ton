# RC Gate Decision

## 1. Executive Decision

READY FOR RC NOW

## 2. Proven Closed

- `publish` verified end to end, including `published_at`, threshold consistency, idempotent replay, and post-publish immutability.
- `charging` verified through `CompletionWindow`, including worker processing and `payment_attempts`.
- `recovery` verified for both success and failure paths.
- `finalize` verified for both success and failure paths.
- `90%` rule proven both above and below `ceil(0.9 * min_units)`.
- duplicate event handling verified across `outbox_events`, `payment_attempts`, and `webhook_events`; the one real duplicate-event bug in late `charge_deal` handling was fixed and reverified.
- `DLQ` behavior verified with retained `attempt_count` and `last_error`.
- retry behavior verified as bounded and controlled, without uncontrolled retry storm.
- soak test verified sustained stability under continuous live traffic.
- worker restart under active outbox and live load verified with recovery and no stuck `processing`.
- DB hardening on `deals` verified in runtime behavior.
- legacy documentation gaps mapped; canonical sources are now explicitly defined.

## 3. Must-Haves Before RC

- None.

There are no open blockers and no remaining must-haves that are required before RC based on the evidence currently documented.

## 4. Non-Blocking Follow-Ups

- Verify duplicate handling at the HTTP ingestion layer if and when a real webhook endpoint is activated.
- Run a longer-duration soak in a production-like deployment environment for additional operational confidence.
- Align archival `.docx` and other legacy documents if the team wants a single fully harmonized documentation set.
- Consider adding a dedicated kill switch if operational policy requires one beyond stopping the worker/app process.

## 5. Operational Risks To Watch

- A future webhook ingestion layer could introduce duplicate-handling drift unless it preserves the same event identity contract already proven in persistence/runtime.
- At larger scale than the current test envelope, retry pressure and recovery traffic should still be watched through `outbox`, `DLQ`, and `payment_attempts`.
- Legacy bootstrap assets such as `scripts/init_db.sql` can mislead operators if treated as canonical, especially around the old `UNIQUE (deal_id, buyer_id)` rule.
- There is no dedicated product-level kill switch; current fallback is operational process stop and controlled rollback.

## 6. Recommended Next Sequence

1. Approve the RC gate and treat the current package as the release candidate baseline.
2. Freeze canonical docs for RC review:
   `PROJECT_STATUS.md`,
   `docs/STAGE12_OPERATIONAL_CONFIDENCE_SUMMARY.md`,
   `docs/RELEASE_READINESS_CHECKLIST.md`,
   `docs/OPERATIONAL_RUNBOOK.md`,
   `docs/KNOWN_GAPS_AND_DECISIONS.md`.
3. Execute deployment-readiness checks from the runbook and checklist in the target environment.
4. If a webhook ingestion endpoint is introduced before release, run one focused duplicate-ingestion verification pass there.
5. Track the listed non-blocking follow-ups post-RC as operational hardening, not as RC blockers.

## Open Gap Classification

| Gap | Classification | Why |
| --- | --- | --- |
| No open core QA blocker identified | blocker | None currently open |
| No open pre-RC code or schema fix identified | must-have before RC | None currently required |
| Webhook duplicate verification at future HTTP ingestion layer | non-blocking | Relevant only if/when that endpoint is activated |
| Longer soak in production-like environment | non-blocking | Adds confidence but does not invalidate current RC evidence |
| Dedicated kill switch | later | Operational enhancement, not a current release gate |
| Full alignment of archival `.docx` / legacy docs | later | Documentation cleanup, not release-critical |
| Cleanup or rewrite of `scripts/init_db.sql` legacy bootstrap | later | Important to avoid confusion, but canonical docs already override it |
