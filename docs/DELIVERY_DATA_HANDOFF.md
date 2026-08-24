# Delivery Data Handoff — מסירת נתוני אספקה למוכר

> **V1.1 product-scope notice (2026-08-23):** references that assume no public
> Mall are historical. Siton now supports direct links plus the public Mall;
> delivery and money boundaries in this handoff are unchanged.

## Overview

The Delivery Data Handoff feature collects buyer shipping/pickup preferences at join time and surfaces them to the seller after the deal reaches `Completed` state. **This is data collection and display only — Siton does not manage logistics, shipments, or tracking.**

---

## What This Feature Does

- Buyer selects a delivery option (pickup / delivery / distribution_point) when joining a deal
- For `delivery` (shipping) options, buyer provides: recipient name, street address, city, and optional delivery note (≤200 chars)
- For `pickup` options, no address is required
- After deal reaches `Completed`, seller sees all eligible buyers with their delivery data
- Seller can download a lean Excel file for offline processing

## What This Feature Does NOT Do

- No shipment tracking (`tracking_number`, `shipped_at`, `delivered_at`)
- No delivery status updates (`delivery_status`, `delivery_issue`)
- No logistics management endpoints
- No refund, capture, void, or payout in this flow
- No delivery SMS or email notifications from Siton — communication is seller's responsibility
- No shipping carrier integration
- No marketplace, search, or catalog features

---

## Eligible Buyers

Only buyers with `money_state IN ('ChargedSuccess', 'RecoveredCharge')` appear in the handoff. Uncharged, cancelled, or failed buyers are excluded.

Deal must be in `Completed` state for the handoff to be accessible.

---

## API Endpoints

### GET `/api/seller/deals/:dealId/delivery-handoff`

Returns eligible buyers with delivery data.

**Auth:** requires `x-seller-auth` header (seller auth token)

**Requires:** `deal.state === 'Completed'`; returns 409 otherwise

**Response:**
```json
{
  "deal_id": "string",
  "deal_title": "string",
  "eligible_count": 3,
  "disclaimer": "הנתונים מוצגים לצורך תיאום האספקה בלבד. האספקה באחריות המוכר.",
  "buyers": [
    {
      "participant_id": "string",
      "buyer_id": "string",
      "buyer_name": "string | null",
      "buyer_phone": "string | null",
      "buyer_email": "string | null",
      "qty": 2,
      "delivery_method_type": "pickup | delivery | distribution_point",
      "delivery_method_label": "string",
      "delivery_address": "string | null",
      "delivery_city": "string | null",
      "delivery_notes": "string | null",
      "joined_at": "ISO 8601 timestamp"
    }
  ]
}
```

**Excluded fields:** `authorization_id`, `authorization_provider`, `authorization_correlation_id`, all payment provider refs, all logistics/tracking fields.

---

### GET `/api/seller/deals/:dealId/delivery-handoff/export.xlsx`

Downloads a lean Excel workbook.

**Auth:** requires `x-seller-auth` header

**Requires:** `deal.state === 'Completed'`

**Response:** `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- Filename: `siton-delivery-handoff-{dealId}.xlsx`
- Sheet 1 — "מסירת נתוני אספקה": one row per eligible buyer
- Sheet 2 — "הסבר": human-readable notes about the export

**Columns in Sheet 1:**

| Column | Field | Notes |
|--------|-------|-------|
| מזהה עסקה | deal_id | |
| שם עסקה | deal_title | |
| מזהה משתתף | participant_id | |
| שם קונה | buyer_name | |
| טלפון | buyer_phone | |
| אימייל | buyer_email | |
| כמות | qty | |
| סוג אספקה | delivery_method_type | pickup / delivery |
| תווית אספקה | delivery_method_label | as defined by seller |
| כתובת | delivery_address | null for pickup |
| עיר | delivery_city | null for pickup |
| הערות | delivery_notes | max 200 chars |
| תאריך הצטרפות | joined_at | |

**Not included:** tracking numbers, payment refs, delivery status, shipping carrier info.

---

## Buyer-Side Flow

1. Buyer views deal page and selects a delivery option
2. On the payment page, if `delivery` option is selected:
   - Recipient name field (optional)
   - Street + number (required for shipping)
   - City (required for shipping)
   - Delivery note, max 200 chars (optional)
3. For `pickup` options, no address form is shown
4. Data is submitted with the join request and stored in `participants` table

### Validation Rules

| Field | Rule |
|-------|------|
| `delivery_address` | Required when `delivery_option_type === 'delivery'` |
| `delivery_notes` | Max 200 characters; 400 with `delivery_notes_too_long` if exceeded |
| `delivery_city` | Required when `delivery_option_type === 'delivery'` |

---

## Seller-Side UX

On the Seller Deal Management page, after deal reaches `Completed`:

- "מסירת נתוני אספקה" section appears
- One card per eligible buyer showing: name, delivery method, address (with copy button for shipping addresses), WhatsApp link, email link
- "הורד Excel" button triggers the `.xlsx` download
- Pickup buyers show a "איסוף עצמי" badge without address

---

## Database

All delivery fields are stored on the `participants` table (columns added by migrations 016 and 026):

- `delivery_option_id` — FK to `deal_delivery_options`
- `delivery_method_type` — snapshot of option type
- `delivery_method_label` — snapshot of option label
- `delivery_cost` — snapshot of option cost
- `buyer_name` — name for this purchase
- `delivery_address` — street + number
- `delivery_city` — city
- `delivery_notes` — free-text note, max 200 chars

No new DB migrations are required for this feature.

---

## Test Coverage

| File | What it covers |
|------|----------------|
| `tests/buyer_delivery_data_validation.ts` | Shipping requires address, pickup doesn't, notes max 200, deal state unchanged |
| `tests/seller_delivery_handoff_validation.ts` | Only eligible buyers shown, non-Completed blocked, no internal refs in response |
| `tests/seller_delivery_excel_export_validation.ts` | Excel endpoint exists, required columns present, no internal refs or tracking |
| `tests/seller_delivery_no_logistics_management_validation.ts` | No logistics endpoints, no financial action endpoints, no notification endpoints |
