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

## 4. No distributor role or distributor economics; scoped seller distribution links are allowed

There is no distributor user type in the canonical Siton product and there is no distributor-economics module.

The canonical product roles remain buyer, seller, and administrator. The product must not expose or depend on a distributor balance, payout rail, invoice entitlement, commission calculation, seller-to-distributor settlement, or any other Siton-managed distributor economics.

A seller may create multiple distribution/measurement links for a deal and use them to measure acquisition and conversion performance by source or campaign.

A seller may optionally issue credentials for a read-only external dashboard for one specific distribution link. That external viewer is not a Siton product role and is not a seller account. Its access is strictly scoped to the link for which the credentials were issued.

The scoped external link dashboard may expose aggregate measurement only, including metrics such as visits, attributed joins or purchases, successfully charged units, gross collected amount attributable to that link, and time-series progress where available.

The scoped external link dashboard must not expose buyer personally identifiable information or buyer-level records, including names, email addresses, phone numbers, authentication data, payment details, or any equivalent identifying data. It must not expose seller-wide navigation or data from other links.

Siton does not calculate, accrue, hold, settle, invoice, or pay any commission to an external link holder. Any compensation arrangement between a seller and an external person is outside Siton.

Historical `affiliate_*` or `distributor_*` names may remain as implementation rails where they support ordinary attribution or seller-owned distribution links, but they must not be interpreted as creating a distributor role or distributor economics. Applied migrations must not be rewritten; cleanup or renaming must happen through forward changes where justified.

## 5. Legal text

The current legal material remains as-is for now. This amendment does not initiate a legal rewrite.

## 6. Previously locked deal-duration decision

The earlier owner decision removing the fixed seven-day maximum deal duration remains binding. Older references to a seven-day product deadline are historical and non-canonical. This is separate from unrelated operational controls that may legitimately use seven-day periods.

## Implementation evidence at the time of this amendment

The current staging database already has `siton.deals.max_units` as `NOT NULL`, enforces `max_units >= min_units`, and no longer has `deals.commission_rate`.

The current money implementation already uses the system constant `SITON_PLATFORM_FEE_RATE = 0.08` and includes delivery in the collected gross amount before excluding the customer VAT component from the fee base.

Known implementation cleanup still required after this source-of-truth update:

- remove the runtime override for the Completion Window and hard-lock it to 24 hours;
- preserve the absence of distributor economics while allowing seller-owned distribution attribution and the scoped, read-only, no-PII external link dashboard described above;
- preserve the mandatory finite `max_units` invariant through all create, edit, publish, import, clone, and admin paths;
- keep the separate no-seven-day-cap implementation work coordinated with the already active parallel task;
- do not touch the CMS/content-management scope that is being implemented in parallel.

## Precedence

For these subjects, this file has higher precedence than the 2026-04-18 foundation pack, the 2026-08-23 Mall amendment, older DOCX files, historical migrations, and existing runtime behavior.
