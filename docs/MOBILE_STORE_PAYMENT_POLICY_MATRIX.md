# Mobile store payment policy matrix

Read-only technical classification at base `8ead7c828e6d6233bf7d17bf7f67d1a67ad35767`, reviewed 2026-09-08. No payment code, provider configuration or IAP implementation changed. This is not a legal conclusion or store approval.

| Requested product category | Repository evidence | Apparent consumption / review decision |
| --- | --- | --- |
| Physical | `src/deal_types.ts`: physical_product, physical_delivery; seller UI delivery/pickup | Physical goods consumed outside app. Review as external goods checkout. |
| Voucher | voucher; voucher_code fulfillment; merchant/redemption/validity terms | A code displayed in-app does not itself prove in-app digital consumption. Merchant/offline redemption appears possible; inspect every supported redemption use. Digital credits/content variants require explicit billing-policy review. |
| Ticket | ticket; event_ticket; event terms, admission/external seat choices | Appears oriented toward attendance outside the app. Livestream, recordings or in-app digital access cannot be assumed excluded by free-form event descriptions; review these before sale. |
| Service | No separate service member in canonical DEAL_TYPES (only physical_product/voucher/ticket) | Do not claim an implemented standalone service checkout. Services represented via vouchers require fulfillment review: offline service versus remote/digital in-app consumption. |

Apple distinguishes physical goods/services consumed outside the app from in-app digital purchases in section 3.1. Google similarly distinguishes physical goods/services from digital in-app purchases. Classification must follow the actual offering, delivery and consumption, not its label or presence of a voucher. Country/storefront-specific rules and exceptions require review at submission time. Sources: [Apple App Review Guidelines, section 3.1](https://developer.apple.com/app-store/review/guidelines/#payments), [Google Play Payments policy](https://support.google.com/googleplay/android-developer/answer/9858738).

Before submission: owner supplies representative physical, voucher, ticket and proposed service offers; policy reviewer records where value is consumed, whether digital entitlements unlock in-app, storefronts/countries, refund/support promises and any applicable billing requirement. Escalate digital vouchers, online tickets, memberships, livestreams and mixed bundles. No claim is made that the current external payment architecture is eligible for every future offer. Any provider/backend change belongs to the separate financial track.
