# Conditional Deal User Test Plan

Status: required before any real-money pilot. This is a human research plan, not a code readiness claim.

## Goal

Verify that buyers and sellers understand C-ton as a conditional deal room:

- joining is not a normal immediate purchase
- authorization/hold happens before final capture
- capture happens only if the deal succeeds
- the seller, not C-ton, is responsible for product fulfillment
- C-ton does not run logistics, commercial disputes, manual refunds, marketplace discovery, or distributor commission

## Participants

Run with 5 to 10 people:

- 3 to 6 buyer-like participants who have not seen the product before
- 2 to 4 seller-like participants, preferably small business operators or producers
- Avoid explaining the product before the test; give only the public deal link and a short task

Do not use real card data. Use demo/sandbox data only.

## Buyer Test

Give the participant a public deal link and ask them to join as if they were interested.

Questions after they reach confirmation/tracking:

1. What is happening on this page?
2. Is this a regular immediate purchase or a conditional deal?
3. When will you be charged?
4. What happens if not enough buyers join?
5. What happens if your payment/charge fails after the deal succeeds?
6. Who supplies the product?
7. What does C-ton do?
8. What does C-ton not do?
9. What amount do you expect to be held or charged?
10. What would you do if you think you were charged twice?

Observe without prompting:

- whether the participant notices the conditional nature before payment
- whether "hold" versus "charge" is understood
- whether tracking reinforces the same story
- whether delivery responsibility is attributed to the seller

## Seller Test

Ask the seller-like participant to review or draft a simple deal.

Questions:

1. What do minimum and max units mean?
2. What happens if the minimum is not reached?
3. What happens if some buyer charges fail?
4. What fee does C-ton take?
5. Who is responsible for delivery, warranty, and customer service?
6. What does the seller export contain?
7. Does the system appear to manage logistics or only hand off buyer data?
8. What support case would they open for a payment mismatch?

## Pass Criteria

Pass only if a clear majority can explain, without coaching:

- this is a conditional deal
- no final charge happens at join time
- charge/capture happens only after deal success
- failed threshold means no normal successful purchase
- seller is responsible for fulfillment
- C-ton is the deal room and money/state system, not the product supplier or logistics operator

## Fail Criteria

Fail if any repeated pattern appears:

- participants think they bought immediately
- participants cannot tell when they will be charged
- participants think C-ton supplies or ships the product
- participants expect manual commercial refunds from support
- sellers expect C-ton to handle delivery or warranty
- sellers misunderstand fee, net, or max_units

## After The Test

Record:

- participant type, no personal identifiers
- route/screen where confusion happened
- exact confusing text if possible
- severity: P0 money confusion, P1 responsibility confusion, P2 wording polish

Fix only the copy or flow that caused observed confusion. Do not change product rules unless explicitly approved.
