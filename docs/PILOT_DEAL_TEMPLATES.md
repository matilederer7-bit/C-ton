# Pilot Deal Templates — first 5 sellers (manual onboarding aid)

Purpose: help the owner recruit the first 5–10 sellers quickly by walking into a
conversation with a concrete, fillable deal structure. These are **templates**,
not data — nothing here is seeded anywhere. Every number is a placeholder the
seller confirms.

Platform constraints every template respects (as enforced by the code today):

| Rule | Value | Where enforced |
|---|---|---|
| Deadline | 2 hours … **7 days** from publish | `POST /deals` (`deadline_below_minimum` / `deadline_above_maximum`) |
| Success threshold | **90 % of minimum units**, auto-derived, not editable | `threshold_units = ceil(0.9 × min_units)` |
| Charge timing | Authorization only at join; charge only when the deal closes at/above threshold | mock in staging, real money 0 |
| Self-pickup | Every pickup / distribution-point option needs an address text or coordinates | publish gate `pickup_location_required` |
| Regular price | Optional; must be **above** the group price; shown to buyers as "% saving" | migration 065 / `list_price_invalid` |
| Platform fee | 8 % (+VAT) of charged gross — shown to the seller in the publish summary | constitution |
| Images | ≥ 1 (client checklist); up to 12 | wizard |
| Seller before publish | business name + support e-mail or phone + owner approval (`verification_status = approved`) | publish route |

The pitch line that works for every template: **"אתם קובעים מחיר קבוצתי ומינימום. אם הקבוצה לא נסגרת — אף אחד לא משלם ואתם לא מתחייבים למלאי."**

---

## 1 · Physical product — local producer (honey / olive oil / coffee)

| Field | Template value | Why |
|---|---|---|
| Deal type | `physical_product` | |
| Seller offer | "מארז דבש פרחי בר 1 ק״ג ישירות מהמכוורת" | one concrete SKU, not a catalog |
| Regular price | ₪75 / unit | what the seller sells for today (farm gate / shop) |
| Siton price | ₪55 / unit (≈ 27 % saving) | deep enough to be shareable, still above cost |
| Minimum units | 15 (threshold auto = 14) | one production/packing batch |
| Maximum units | 60 | stock the seller can actually pack in the window |
| Deadline | 5 days, 20:00 Israel time | one weekend of sharing |
| Fulfilment | Pickup: full street address (e.g. "הרצל 12, תל אביב") + "משלוח עד הבית ₪15" | pickup needs a real address; delivery unlocks buyers outside the neighbourhood |
| Seller rationale | Guaranteed volume in one packing run, no leftover stock, buyers do the marketing via personal links. | |

## 2 · Voucher — restaurant / café

| Field | Template value | Why |
|---|---|---|
| Deal type | `voucher` | |
| Seller offer | "שובר ארוחה זוגית — מנה עיקרית ×2 + קינוח" | fixed content, no menu surprises |
| Regular price | ₪240 (face value of the meal) | `voucher_terms.face_value_amount` |
| Siton price | ₪169 (≈ 30 % saving) | |
| Minimum units | 20 (threshold auto = 18) | fills quiet weekday evenings |
| Maximum units | 80 | seating capacity over the validity window |
| Deadline | 4 days | |
| Redemption | Location: restaurant address; Valid until: 60 days after close; Instructions: "להציג את קוד השובר בהזמנה, בימים א׳–ה׳"; single-use | all required voucher fields |
| Seller rationale | Cash up front for a slow period, new customers who arrive with friends (viral link). | |

## 3 · Ticket — workshop / small event

| Field | Template value | Why |
|---|---|---|
| Deal type | `ticket` | |
| Seller offer | "סדנת קפה + טעימות — 2 שעות, קבוצה של עד 25" | event only happens if the group closes — exactly the Siton mechanic |
| Regular price | ₪180 | |
| Siton price | ₪120 (≈ 33 % saving) | |
| Minimum units | 12 (threshold auto = 11) | the room's break-even |
| Maximum units | 25 | room capacity |
| Deadline | 6 days, at least 48 h before the event | seller needs time to prepare once closed |
| Ticket terms | Event name, start (future), venue name + city, entry instructions ("להציג את הכרטיס בכניסה"), general admission, not transferable | all required ticket fields |
| Seller rationale | Zero risk of running a half-empty workshop; the deadline creates urgency for the group. | |

## 4 · Service — local business (car wash / cleaning / grooming)

| Field | Template value | Why |
|---|---|---|
| Deal type | `voucher` (a service is sold as a redeemable voucher) | |
| Seller offer | "שטיפה חיצונית + פנימית מלאה" | one clearly bounded service |
| Regular price | ₪150 | |
| Siton price | ₪99 (≈ 34 % saving) | |
| Minimum units | 25 (threshold auto = 23) | a full booked week |
| Maximum units | 100 | what the team can schedule in the validity window |
| Deadline | 7 days | |
| Redemption | Location: business address; valid 45 days; "לתאם תור בטלפון ולציין את קוד השובר" | |
| Seller rationale | Predictable bookings, buyers pre-commit (authorization held), marketing done by the buyers' links. | |

## 5 · Neighbourhood group purchase — bulk import / wholesale split

| Field | Template value | Why |
|---|---|---|
| Deal type | `physical_product` | |
| Seller offer | "אוזניות אלחוטיות ANC — יבוא קבוצתי, אחריות יבואן" | high perceived saving, one SKU |
| Regular price | ₪349 (street price) | |
| Siton price | ₪249 (≈ 29 % saving) | |
| Minimum units | 30 (threshold auto = 27) | the importer's carton size / MOQ |
| Maximum units | 120 | shipment size |
| Deadline | 7 days | |
| Fulfilment | Distribution point with full address + "משלוח ₪25" | |
| Seller rationale | The MOQ is only ordered when the group closes; no inventory risk; the "אף אחד לא משלם" promise removes buyer hesitation. | |

---

## How to fill a template with a seller (5 minutes)

1. Pick the template closest to the business; confirm the **one** product/voucher/ticket.
2. Ask: "What do you sell it for today?" → regular price. "What price would you give a group of N?" → Siton price (must be lower).
3. Ask: "What's the smallest quantity that makes it worth it?" → minimum. "What's the most you can deliver in a week?" → maximum.
4. Pick the deadline (≤ 7 days). Prefer an evening hour (20:00) after a weekend.
5. For pickup: get the **full address** now (the publish button is blocked without it).
6. Get 1–3 real photos on WhatsApp before you leave.
7. Create the deal together in the wizard (or from the seller's phone), preview it as a buyer, publish, and share the `/d/<id>` link in the seller's own WhatsApp groups first.
