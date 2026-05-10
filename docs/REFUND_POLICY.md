# Refund Policy

Status: `REFUND_POLICY_ALIGNMENT_PASS` for the demo / pre-provider-sandbox build.
No live money was performed. No provider refund was executed.

## Canonical Rule

Refunds in Siton are system-mandated only.
No seller, admin, or support user can initiate a manual commercial refund through the system.
Refund execution is allowed only as an automatic consequence of a deal-level failure under the Siton constitution, including failure to satisfy the 90% minimum success threshold after actual charges were attempted.

## Forbidden

- No seller refund.
- No admin refund.
- No support refund.
- No manual refund.
- No merchant-initiated refund.
- No partial commercial refund.
- No manual credit.
- No manual void as a commercial support tool.
- No refund because a buyer is disappointed.
- No refund because of a seller-buyer dispute.
- No Admin Action may be used to disguise a refund.

Seller-buyer disputes may be documented as support cases only. Support can record evidence, delivery issues, buyer complaints, commercial disputes, chargeback evidence, or payment mismatches. Support cannot move money.

`RefundRequest` is a legacy internal support-case alias only. It means commercial dispute / buyer complaint evidence, not refund eligibility and not refund approval.

## Allowed System Path

A refund is required only when the system determines that the entire deal failed under the Siton constitution after actual charges were attempted.

Example:

1. A deal enters charging / completion processing.
2. Actual charges or recovered charges exist for one or more participants.
3. After the completion window, captured units are below the stored 90% threshold (`threshold_units`).
4. The deal transitions from `CompletionWindow` to `Failed`.
5. The system enqueues `refund_issue`.
6. The refund worker refunds only participants whose rigid `money_state` is `ChargedSuccess` or `RecoveredCharge`.

This path is not merchant-initiated, not admin-initiated, and not customer-service-initiated.

## Truth Sources

JSONB is not a refund eligibility source.

Refund eligibility is determined only by:

- `siton.deal_state`
- `siton.buyer_state`
- `siton.money_state`
- rigid money columns such as `gross_amount`, `platform_fee_total_amount`, `seller_net_amount`, `siton_fee_amount`, and `amount_minor`
- state transition rules and DB-level transition triggers
- the stored 90% threshold rule (`threshold_units`)

JSONB / JSON payloads may contain provider evidence, outbox job envelopes, audit payloads, or metadata. They cannot grant refund eligibility, set refund amount, approve a refund, or override state.

## Provider Sandbox Scope

Future provider validation must test only `system_mandated_refund_on_deal_failed`.

Provider Sandbox must prove that the automatic failed-deal path can refund or void actual charges safely with provider request IDs and webhook event IDs. It must not introduce an admin manual refund operation, seller refund button, support refund flow, or partial commercial refund.

## Mission Control Contract

Mission Control exposes `refund_policy_readiness` with:

- `manual_refund_allowed: false`
- `seller_refund_allowed: false`
- `admin_commercial_refund_allowed: false`
- `support_refund_allowed: false`
- `partial_commercial_refund_allowed: false`
- `system_refund_on_failed_deal_required: true`
- `json_boundary_respected: true`
- `provider_sandbox_required: true`

## Voucher / Ticket Fulfillment Relation

The Deal Type Expansion (physical_product / voucher / ticket) does **not** open
any new refund pathway. Vouchers and tickets are issued strictly after a deal
reaches `Completed` and only for participants whose `money_state` is
`ChargedSuccess` or `RecoveredCharge`. There is no manual issuance, no manual
voiding for "good will," and no manual refund tied to voucher non-redemption or
ticket no-show. If a deal ends in `Failed`, no fulfillment unit is issued and
the existing system-mandated refund path on `charging.finalize_failed` is the
only money-return mechanism. See `docs/DEAL_TYPES_PHYSICAL_VOUCHER_TICKET.md`.

## Verdict

`REFUND_POLICY_ALIGNMENT_PASS`
