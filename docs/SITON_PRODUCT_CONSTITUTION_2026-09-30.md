# Siton Product Constitution — 2026-09-30

Status: **BINDING. Highest-precedence product document.** Owner decisions of 2026-09-30.

This document overrides every older product statement in the repository where they
conflict: foundation pack, amendments, UX notes, DOCX files, migration comments,
delivery reports, tests and existing code. Older documents keep their history value
only. When a document, test or code path contradicts this page, the page wins and the
contradiction is drift to be fixed forward.

Precedence: owner's explicit current decision → this constitution →
`docs/CANONICAL_PRODUCT_POLICY_AMENDMENT_2026-09-16.md` → `docs/CURRENT_ARCHITECTURE_2026-09-30.md`
→ `PROJECT_STATUS.md` → current implementation and passing tests → everything older.

## תקציר לבעלים (Hebrew summary)

- סיטון היא פלטפורמת עסקאות קבוצתיות: מוכר יוצר עסקה, קונים תופסים מסגרת, העסקה ננעלת ביעד, ורק אז מתבצעים חיובים.
- שלושה תפקידים בלבד: קונה, מוכר, מנהל. אין "מפיץ" כמשתמש עסקי.
- הצלחה סופית רק אם לפחות 90% מכמות המינימום חויבו בפועל.
- עמלת סיטון 8% על כל מה שנגבה מהלקוח (כולל משלוח), למעט המע"מ של הלקוח. אין עמלה שונה לעסקה.
- כל עסקה שמתפרסמת חייבת מקסימום יחידות סופי. אין מגבלת 7 ימים. חלון השלמה 24 שעות קבועות, רק לשחזור חיוב שנכשל.
- המול קיים אך מוסתר להשקה הנוכחית. לינק ישיר לעסקה תמיד עובד.
- אין ספריית מוצרים (Product Library). מוסר מהמוצר.
- לינקי הפצה של המוכר הם מדידה בלבד: ביקורים, הצטרפויות, יחידות שחויבו, סכומים. סיטון לא מחשבת, לא צוברת ולא משלמת עמלה לאף אחד מחוץ לה.
- כסף אמיתי, החזרים, תשלומים למוכרים, הודעות אמיתיות ו־Grow בפרודקשן חסומים עד אישור מפורש של הבעלים.

## 1. What Siton is

Siton is a group-deal platform. A seller publishes a deal with a minimum quantity, a
maximum quantity and a deadline. Buyers join by authorizing a payment frame. Nobody is
charged while the deal is open. When the deal reaches its target it locks, and only then
are the frames charged. If too few charges succeed, the deal fails and nobody pays.

## 2. Roles

Exactly three canonical roles:

| Role | Does |
|---|---|
| Buyer | opens a deal link, joins by authorizing a payment frame, tracks the deal, receives receipt/pickup/delivery |
| Seller | creates, publishes and fulfils deals; creates distribution links; sees analytics; handles inquiries |
| Administrator | operates the platform: support, admin controls, audit, recovery, CMS |

There is **no distributor or affiliate role**. A person who receives a distribution link
from a seller is not a Siton user type. A scoped, read-only, no-PII external dashboard for
one link is a seller-issued convenience, not a role.

## 3. The core flow (unchanged safety boundary)

1. Seller creates a deal (Draft).
2. Seller publishes it. Publishing requires a finite positive `max_units`.
3. Buyer reaches the deal (direct link, share, distribution link, or the Mall when it is enabled).
4. Buyer joins **only by capturing a payment frame** (authorization). No charge yet.
5. The deal reaches its target and locks. Joining stops.
6. **Only now** do real charges begin, against the captured frames.
7. Final success only if **at least 90% of the minimum quantity was actually charged**.
   Otherwise the deal fails and authorizations are released.

The existing state machine, idempotency, atomicity, audit, outbox, inventory, security and
90% rules are safety boundaries. They may be hardened, never weakened.

## 4. Money rules

- **Siton fee: 8%.** Applied to the full amount actually collected from the customer,
  including shipping and every other purchase component collected through Siton,
  **excluding the customer's VAT component**. It is a system constant. There is no
  per-deal commission override and no `commission_rate` on a deal.
- **Authorization before charge.** A buyer is never charged before the deal locks.
- **Completion Window: exactly 24 hours.** Not configurable, not a seller setting. It
  exists only so buyers whose initial charge failed can recover their payment. Nothing
  else happens in that window.
- **Real money is blocked.** Real customer charging, refunds, payouts, real notification
  providers, Grow production, credential rotation and destructive production changes need a
  new, explicit owner authorization for that specific action.

## 5. Deal rules

- **Mandatory `max_units`.** Every publishable deal has a finite positive maximum, at least
  the minimum. `NULL` or "unlimited" is never publishable.
- **No seven-day cap.** A deal may run for any horizon the seller supports, above the
  technical minimum. Any 7-day limit, validation, UX hint or test that enforces one is
  drift. The only ceiling is a non-business technical sanity bound.
- **Three deal types, all kept:** physical product, voucher, ticket.

## 6. Discovery surfaces

- **Direct deal links always work.** They are the primary entry path today.
- **The Mall exists but is hidden for the current launch.** The code, read model, tests
  and feature flag stay. The flag (`PUBLIC_MALL_ENABLED`) is OFF by default and the Mall
  must not become the main entry experience now. The Mall is part of the future product;
  it must not be deleted in a refactor.

## 7. No Product Library

Siton has **no Product Library / Product Catalog**. There is no "save deal as product",
no "create deal from product", no seller products page, no product revisions, no
`/api/seller/products`. The module is being removed from UI, API and product workflow
first; schema objects are removed later only after a data-safety proof. Existing deals
must keep working and historical deal data must not be lost.

## 8. Distribution links: analytics and attribution only

A seller may create several distribution links per deal. Siton measures per link:
visits, attributed joins, conversion, charged units, gross attributable amount, and
time series. A seller may issue read-only, link-scoped credentials for an external
aggregate dashboard. That dashboard never shows buyer PII or other links.

Siton does **not**: define a distributor commission, calculate one, accrue a balance,
hold money for anyone, pay anyone, issue them an invoice, or manage any agreement
between a seller and an external person. Whatever the seller does with a link outside
Siton is outside Siton.

Legacy names such as `affiliate_links` may remain at the database level while renaming
adds risk. Product terminology and UX must not present a "distributor" as a Siton
business entity.

## 9. Capabilities that are part of the product (never removed for "simplicity")

Three deal types · CMS · seller distribution links · analytics · scoped external link
dashboard · support · seller and customer inquiries · pickup · receipts · mobile ·
advanced admin · notifications architecture · tracking · security · audit ·
worker/outbox · payment and state-machine safety · inventory · observability · relevant
recovery runbooks.

A lean refactor removes duplication, dead code and legacy, not these.

## 10. Runtime

Render web + Render worker + Supabase Postgres. Base44 is historical, not a runtime.
See `docs/CURRENT_ARCHITECTURE_2026-09-30.md`.
