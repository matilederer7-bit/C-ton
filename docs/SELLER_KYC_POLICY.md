# Seller KYC Policy

Written as an initial MVP response; legal validation is recommended later.

A seller cannot publish a real-money deal before basic approval.

## Required Fields

- Full name / business name
- Company number, licensed dealer number or ID by seller type
- Phone
- Email
- Address
- Bank account confirmation
- Ownership or authorization-to-sell declaration

## Statuses

- Pending
- Active
- Rejected
- Suspended

## MVP Gate

Production-like publishing requires approved verification status and an allowed seller_status. Existing code blocks non-ready seller profiles and restricted/suspended/banned statuses before publish. Demo preview remains permissive for local demo data but must not be used as a live-money bypass.
