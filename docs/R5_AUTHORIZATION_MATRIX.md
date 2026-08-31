# R5 authorization matrix

Status: normative target for implementation and test design. It does not describe an already-deployed Supabase authorization layer.

## Actor definitions

| Actor | Canonical R5 identity | Scope source |
|---|---|---|
| Anonymous | No JWT/session | Explicit public-route allowlist only |
| Buyer | Supabase `sub` bound 1:1 to a new canonical buyer account | Buyer account status plus participant/order ownership |
| Seller owner | Supabase `sub` bound to `seller_accounts.auth_user_id` | Seller status plus `deals.seller_id`/seller-owned resource |
| Seller non-owner | Valid seller binding without resource ownership | No cross-seller access |
| Admin | Supabase `sub` bound to active `admin_users.auth_user_id` | Server-side admin role/permission map; AAL2/recent auth where required |
| Distributor | Supabase `sub` bound to verified `affiliate_accounts.auth_user_id` | Own affiliate account/link/attribution only |
| Worker/system | Dedicated PostgreSQL login/runtime role | Queue/job lease and server-side state-machine rules; never a human JWT |

All decisions are made after signature/issuer/audience/time/session validation and a fresh canonical actor lookup. JWT `user_metadata`, request body/header actor IDs, display names, and Base44 roles are not authorization inputs.

## Decision symbols

- **Allow** — capability is directly available to this actor when row/status preconditions pass.
- **Scoped** — only the actor's own row/resource and only the stated projection/action.
- **Approve** — admin may authorize/request a controlled operation, but does not directly perform the worker or money mutation.
- **Deny** — fail closed. Cross-tenant object access should normally use the same not-found envelope as a missing object.
- **Internal** — not exposed as a user capability; invoked by the worker/server control plane.

## Normative R5 capability matrix

| Capability | Anonymous | Buyer | Seller owner | Seller non-owner | Admin | Distributor | Worker/system |
|---|---|---|---|---|---|---|---|
| Read public home, mall, published deal, published image | Allow | Allow | Allow | Allow | Allow | Allow | Internal/Allow |
| Read unpublished/draft deal | Deny | Deny | Scoped | Deny | Scoped with support/read permission and audit | Deny | Internal |
| Create seller draft | Deny | Deny | Allow when seller status permits | Allow for own seller account | Deny | Deny | Deny |
| Edit draft content, deal type, delivery options | Deny | Deny | Scoped | Deny | Deny; use controlled support action if added | Deny | Deny |
| Duplicate draft | Deny | Deny | Scoped from owned source | Deny | Deny | Deny | Deny |
| Upload/delete/reorder draft image | Deny | Deny | Scoped | Deny | Deny unless an explicit audited support permission exists | Deny | Deny |
| Publish or close seller deal | Deny | Deny | Scoped and state-machine constrained | Deny | Deny; emergency control action only | Deny | Internal automatic transition only |
| Prepare, charging, cancel lifecycle command | Deny | Deny | Scoped where product state permits | Deny | Approve only through named, permissioned, audited control action | Deny | Internal for leased automatic work |
| Join a published deal | Deny in canonical R5; authentication may be acquired inline | Scoped to authenticated buyer; server derives buyer ID | Deny as seller actor | Deny | Deny | Deny | Internal validation only |
| View own participation/order status | Deny | Scoped | Seller gets limited operational projection for owned deal | Deny | Scoped with support/read permission | Deny | Internal |
| Resume/recover buyer participation | Deny | Scoped after fresh verification | Deny | Deny | Scoped support workflow; cannot impersonate buyer | Deny | Internal |
| Create/read participant tracking credential | Deny | Scoped, short-lived exchange only | Deny | Deny | Deny | Deny | Internal issuance/revocation |
| Read public deal chat | Allow while product keeps chat public | Allow | Allow | Allow | Allow | Allow | Internal |
| Write deal chat | Deny | Scoped; server derives buyer identity/display | Scoped for owned deal; server derives seller identity | Deny | Scoped moderation permission only | Deny | Internal moderation/retention |
| Initiate payment authorization for own join | Deny | Scoped; buyer/order/amount derived server-side | Deny | Deny | Deny | Deny | Internal provider call |
| Read payment status | Deny | Scoped minimal projection for own order | Scoped operational projection for owned deal, no provider secrets | Deny | Scoped support/payment-read permission | Deny | Internal |
| Capture, void, refund, settle money | Deny | Deny | Deny | Deny | Approve/request only under explicit permission, recent AAL2 and second-approval rules | Deny | Internal exclusive executor |
| Read seller operational dashboard | Deny | Deny | Scoped | Deny | Scoped with seller-support/read permission | Deny | Internal |
| Change seller auth/status/KYC | Deny | Deny | Deny | Deny | Scoped permission; named actor, AAL2/recent auth, audit; cannot use bootstrap key | Deny | Internal enforcement |
| Provision/rebind seller Supabase identity | Deny | Deny | Limited self-claim only through separately approved proof flow | Deny | Scoped identity-admin permission, dual control for rebind | Deny | Internal transaction |
| Create affiliate link | Deny | Deny | Deny | Deny | Scoped support/read unless a dedicated admin capability is added | Scoped | Deny |
| Read affiliate attribution analytics | Deny | Deny | Deny | Deny | Scoped support/read | Scoped | Internal aggregation |
| Change deal, seller, payment, commission, payout | Deny | Deny | Seller deal capabilities only as above | Deny | Admin control actions only as above | **Deny** | Internal according to state machine; distributor has no commercial rail |
| Record public affiliate visit/discovery event | Allow with abuse controls and server validation | Allow | Allow | Allow | Allow | Allow | Internal |
| View admin console/read projections | Deny | Deny | Deny | Deny | Scoped by named role/permission | Deny | Internal |
| Mutate support cases/tickets | Deny | Buyer may create/update own permitted intake only | Seller may create/update own permitted intake only | Deny | Scoped by named support permission and audit | Distributor own intake only if product exposes it | Internal automation |
| Execute Admin Action | Deny | Deny | Deny | Deny | Scoped permission; high-trust actions require AAL2, recent auth, idempotency and possibly second approver | Deny | Internal executor where applicable |
| Read security/audit logs | Deny | Deny | Deny | Deny | Scoped security/audit permission; secrets redacted | Deny | Internal append/retention |
| Run worker tick or claim job | Deny | Deny | Deny | Deny | Deny from a human request | Deny | Internal only via dedicated DB identity |
| Access canonical tables/functions directly through browser Data API | Deny | Deny | Deny | Deny | Deny | Deny | Deny; worker uses direct dedicated database connection, not browser API |

## Route-family mapping

This is the implementation inventory that must be reconciled route-by-route before cutover. A route not listed in an allow family remains denied.

| Route/resource family | Current authority | Required R5 authority and delta |
|---|---|---|
| Public mall/home/published deal reads | Public | Keep public; select only published safe projections |
| `/api/deals/:id` and image reads | Mixed public/published and seller draft rules | Public only for published; seller owner or permissioned admin projection for draft |
| Draft create/edit/duplicate/images/delivery options | App-local seller cookie | Supabase seller actor; ignore request actor IDs; require fresh status and ownership |
| Deal close/prepare/charging/cancel | App-local seller cookie plus state machine | Supabase seller owner for user commands; dedicated worker for automatic transitions |
| `/api/otp/*` | Public OTP rail | Keep only as Supabase enrollment/recovery compatibility if still needed; distributed abuse controls; never independently establish a canonical actor |
| `/api/deals/:id/join` | OTP proof plus client `buyer_id` | Supabase buyer actor; derive buyer account and contact server-side; consume one intent exactly once |
| Buyer session/recovery/tracking | Cookie plus long-lived bearer/query token | Supabase buyer ownership; short-lived exchange; query tokens rejected |
| Payment authorization/status | OTP proof/client buyer ID; status public | Buyer-owned order only; amount/order derived server-side; no public provider-reference query |
| Deal chat | Public read/write with caller display | Read may remain public; writes require buyer or owning seller, display derived server-side |
| Seller/distributor login and provision | App-local scrypt credentials and shared admin key | Supabase Auth login; binding/rebind uses permissioned named admin or approved self-claim flow |
| Affiliate overview/link creation | App-local distributor cookie | Supabase distributor actor scoped to its own affiliate account |
| Ordinary `/api/admin/*` | Mostly shared `x-admin-key` | Named Supabase admin actor plus explicit server permission on every route |
| `/api/admin/actions/*` | Named app-local admin, MFA/approval policy | Preserve model with Supabase named identity, AAL2/recent session and canonical permission check |
| Worker processing | Dedicated Render DB login | Preserve; do not accept a human/admin HTTP token as worker authority |
| Base44 seller/mall/worker functions | Base44 `auth.me()`/service role | Compatibility only until their specific cutover; Base44 tokens always invalid at Fastify |

## Ownership invariants

1. A seller identity binding maps an auth user to a seller account. It does not transfer any deal.
2. A seller ownership transfer, if the product ever permits one, is a separate serializable, audited workflow that updates explicit ownership records under dual control.
3. Buyer ownership is derived from `participants.buyer_account_id` (or an equivalent immutable FK), never from submitted email, phone, display name, or legacy `buyer_id` text.
4. Distributor ownership ends at its affiliate account, links, and attribution projections. Attribution never confers seller, order, money, or admin rights.
5. Admin visibility does not imply direct mutation authority. Money and lifecycle state changes use explicit control actions and worker execution.
6. Worker authority never makes the worker a human actor; every internal mutation records the triggering user/action ID when one exists.

## Admin permission baseline

The current closed role-to-permission map in `src/admin_identity.ts` is the starting point, not a reason to authorize from a JWT role claim. Route registration must declare one permission from that server-owned map. At minimum:

| Administrative operation | Required control |
|---|---|
| Read dashboards/search/support projections | Named active admin + corresponding read permission |
| Update support case/ticket | Named active admin + support mutation permission + audit |
| Seller status/KYC decision | Named active admin + seller/KYC permission + AAL2/recent auth |
| Identity bind/rebind/unbind | Dedicated identity-admin permission + AAL2 + immutable before/after audit; rebind requires second approver |
| System configuration or high-trust Admin Action | Existing high-trust policy: AAL2, recent auth, idempotency and approval policy |
| Capture/refund/void | Human can request/approve only; worker/provider adapter executes according to server-side state |
| Bootstrap key | Read-only health/bootstrap diagnostics at most; disabled in normal production; never accepted for mutation |

## Binding ambiguity policy

The implementation must choose and enforce one of these policies before importing users:

- Preferred: one Supabase user may have exactly one SITON actor type. A database registry with unique `auth_user_id` across actor type enforces this.
- If multi-role users are a product requirement: store explicit memberships and require an active actor context chosen server-side, with re-authentication for admin elevation. Never infer a role from which row happens to match first.

Until a policy is approved, any `sub` resolving to zero or more than one allowed binding must fail closed and emit a security audit event.

## Required negative assertions

- Buyer token cannot read or mutate another buyer's participant/order, even when it supplies that buyer's phone/email/legacy ID.
- Seller token cannot see or mutate another seller's draft, images, delivery configuration, or lifecycle.
- Distributor token cannot invoke seller, deal-mutation, payment, commission, payout, admin, or worker capabilities.
- Admin JWT claims or client metadata cannot add a role/permission absent from `admin_users` and the server map.
- Shared bootstrap key cannot authorize any mutation and cannot select an audit actor.
- Deleted/disabled/unbound user, revoked session, stale admin token, wrong AAL, or ambiguous binding is denied.
- Base44 tokens, service-role tokens, anon tokens, wrong-project JWTs, wrong audience, missing `session_id`, and conflicting cookie/bearer identities are denied.
- Direct browser access to canonical schema/tables/functions remains denied for `anon` and `authenticated` roles.
