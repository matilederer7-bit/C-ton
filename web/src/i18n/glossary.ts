// ── SITON TERMINOLOGY GLOSSARY ─────────────────────────────────────────────
// The English surface is a product, not a translation exercise. These terms
// are fixed: a reviewer, a test and a future translator all read the same
// table, so "עסקה" is always a Deal and never an "offer", a "transaction" or
// a "sale".
//
// The financial terms carry the heaviest rule (§1.9): nothing in the English
// UI may suggest that money has moved when it has not. An "authorization" (or
// "hold") is not a charge, and the copy must never blur the two.

export interface GlossaryEntry {
  he: string;
  en: string;
  note: string;
}

export const GLOSSARY: readonly GlossaryEntry[] = [
  { he: "עסקה", en: "Deal", note: "The group-buying unit. Never 'offer'/'sale'/'transaction'." },
  { he: "מוכר", en: "Seller", note: "The business that opens a Deal." },
  { he: "קונה", en: "Buyer", note: "A person who joins a Deal. 'Participant' only where the group role is the point." },
  { he: "משתתף", en: "Participant", note: "A Buyer seen as a member of the group." },
  { he: "יעד", en: "Target", note: "Units needed for the Deal to go ahead." },
  { he: "מינימום", en: "Minimum", note: "The Target expressed as the floor that must be reached." },
  { he: "הצטרפות", en: "Join", note: "The act of entering a Deal. Never 'sign up' (that is account creation)." },
  { he: "מלאי", en: "Stock", note: "Units still available; `max_units` is the Deal's capacity." },
  { he: "מסגרת / הרשאת תשלום", en: "Authorization", note: "A card authorization/hold. NOT a charge. Never render as 'payment' or 'paid'." },
  { he: "החזקה", en: "Hold", note: "The amount reserved on the card. Never 'charged'." },
  { he: "חיוב", en: "Charge", note: "Money actually captured. Only used once capture really happened." },
  { he: "זיכוי / החזר", en: "Refund", note: "Money returned after a charge." },
  { he: "עמלת Siton", en: "Siton fee", note: "The fixed 8% platform fee." },
  { he: "מע\"מ", en: "VAT", note: "Excluded from the fee base." },
  { he: "משלוח", en: "Delivery", note: "Included in the fee base." },
  { he: "איסוף עצמי", en: "Pickup", note: "Collecting in person from the seller." },
  { he: "מועד סיום", en: "Deadline", note: "When the Deal stops accepting joins." },
  { he: "חלון השלמה", en: "Completion Window", note: "The fixed 24-hour recovery window. Capitalised as a product term." },
  { he: "טיוטה", en: "Draft", note: "An unpublished Deal." },
  { he: "פרסום", en: "Publish", note: "Making a Draft public." },
  { he: "מעקב", en: "Tracking", note: "The buyer's own view of a Deal they joined." },
  { he: "שובר", en: "Voucher", note: "Deal type." },
  { he: "כרטיס", en: "Ticket", note: "Deal type." },
  { he: "מנהל", en: "Administrator", note: "Siton staff. The area is the 'Admin' area." },
  { he: "תמיכה", en: "Support", note: "The help/contact surface." },
  { he: "פנייה", en: "Inquiry", note: "A support/seller message thread." },
  { he: "הפצה", en: "Distribution", note: "Seller-created share links. Never implies a distributor ROLE or commission." },
  { he: "פיילוט סגור", en: "Closed pilot", note: "The current operating mode: no real charges." }
];
