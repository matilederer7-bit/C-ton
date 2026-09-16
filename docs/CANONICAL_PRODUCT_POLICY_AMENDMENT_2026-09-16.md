# Siton Canonical Product Policy Amendment — 2026-09-16

Status: BINDING

This amendment records the owner's current product decisions and overrides every older repository document, binary specification, UX note, migration comment, implementation assumption, or test expectation where they conflict.

## 1. Mandatory upper quantity limit

Every publishable deal must have a finite upper quantity limit.

- `max_units` is mandatory and may never represent unlimited capacity.
- `max_units` must be a positive integer and must be greater than or equal to `min_units`.
- The database contract is `NOT NULL`.
- The seller UX must require the seller to choose or explicitly confirm the upper limit before publish.
- A Draft may carry a temporary finite default for safe creation, but publish must never permit `NULL`, infinity, or an unconfirmed unlimited state.

## 2. Completion Window is exactly 24 hours

The Completion Window is not a seller setting and is not environment-configurable product policy.

- Duration is exactly 24 hours.
- The shared deal window opens after the initial charging run when the deal moves from `Charging` into `CompletionWindow`.
- It exists only to let buyers whose initial charge failed recover their payment.
- Only participants in `ChargeFailedCompletion` are eligible for recovery during the window, with the corresponding money recovery state enforced by the state machine.
- Normal joining, new authorization, quantity changes, and unrelated payment operations are forbidden in this window.
- Per-deal fields such as `completion_window_hours`, runtime overrides such as `COMPLETION_WINDOW_MINUTES`, or any other variable duration are non-canonical.

## 3. Siton fee is fixed at 8%

Siton's fee is a system constant of 8%.

- The 8% applies to the full customer amount actually collected as part of the purchase, including product/service value, shipping or delivery, and any other purchase amount collected through Siton.
- The customer's VAT component is excluded from the 8% fee base.
- VAT applicable to Siton's own fee is accounted for separately according to the applicable accounting/legal treatment. It is not a second Siton commission rate.
- There is no per-deal fee override and no canonical `commission_rate` field on a deal.

## 4. No distributor role or distributor product module

There is no distributor user type in the canonical Siton product.

The canonical roles are buyer, seller, and administrator. Therefore the product must not expose or depend on a distributor/affiliate identity, login, session, dashboard, seller-to-distributor relationship, distributor balance, payout, invoice entitlement, distributor-specific link product, or distributor-specific attribution surface.

Ordinary sharing remains a standard deal-sharing capability. Role-neutral viral or acquisition analytics may exist only if they do not create a distributor entity, distributor permissions, or distributor economics.

Historical `affiliate_*` or `distributor_*` tables, routes, code, UX, tests, and migrations are legacy implementation artifacts. Applied migrations must not be rewritten. Their removal must happen through forward code cleanup and, where needed, forward migrations after all runtime dependencies are removed.

## 5. Legal text

The current legal material remains as-is for now. This amendment does not initiate a legal rewrite.

## 6. Previously locked deal-duration decision

The earlier owner decision removing the fixed seven-day maximum deal duration remains binding. Older references to a seven-day product deadline are historical and non-canonical. This is separate from unrelated operational controls that may legitimately use seven-day periods.

## Implementation evidence at the time of this amendment

The current staging database already has `siton.deals.max_units` as `NOT NULL`, enforces `max_units >= min_units`, and no longer has `deals.commission_rate`.

The current money implementation already uses the system constant `SITON_PLATFORM_FEE_RATE = 0.08` and includes delivery in the collected gross amount before excluding the customer VAT component from the fee base.

Known implementation cleanup still required after this source-of-truth update:

- remove the runtime override for the Completion Window and hard-lock it to 24 hours;
- remove remaining distributor/affiliate role, session, route, UI, schema-contract, environment, and test surfaces without removing ordinary sharing or role-neutral viral analytics;
- preserve the mandatory finite `max_units` invariant through all create, edit, publish, import, clone, and admin paths;
- keep the separate no-seven-day-cap implementation work coordinated with the already active parallel task;
- do not touch the CMS/content-management scope that is being implemented in parallel.

## Precedence

For these subjects, this file has higher precedence than the 2026-04-18 foundation pack, the 2026-08-23 Mall amendment, older DOCX files, historical migrations, and existing runtime behavior.
