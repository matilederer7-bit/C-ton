# Frontend Start Gate

## Can Frontend Start Now

כן.

הכרעה
- frontend יכול להתחיל עכשיו על בסיס הבקאנד הנוכחי.
- אין צורך לפתוח מחדש publish, charging, recovery, finalize, rule of 90%, concurrency, או RC.

## Endpoints And Flows Ready For Consumption

- `GET /health`
- `POST /deals`
- `POST /deals/:id/publish`
- `POST /deals/:id/join`
- `POST /deals/:id/close_joining`
- `POST /deals/:id/prepare_charging`
- `POST /deals/:id/charging/start`
- `POST /deals/:id/cancel`
- `GET /debug/deals/:id` כ-debug / ops only, לא כחוזה frontend primary

## Contracts To Be Careful With

- `join` מאפשר multiple joins לאותו buyer; אסור לבנות UI שמניח uniqueness של buyer בתוך deal.
- `max_units` הוא סף הכמות היחיד; אסור לבנות UI שמניח cap על מספר buyers.
- idempotency ו-runtime flow קיימים, אבל frontend עדיין צריך לנהל retries בצורה סבירה ולא להציף requests אקראיים.
- `debug` endpoints אינם חוזה מוצרי ל-frontend.

## Best First Frontend Flow

- flow ראשון מומלץ:
  1. create deal
  2. publish deal
  3. join deal

זהו המסלול הכי נכון להתחיל איתו כי הוא יוצר ערך visible מהר ומבוסס על endpoints שכבר הוכחו היטב.

## What Must Not Be Reopened

- אין מגבלה על מספר buyers
- אין מגבלה על מספר joins לאותו buyer
- אין `UNIQUE (deal_id, buyer_id)`
- `max_units` הוא כלל הקיבולת היחיד
- אין לפתוח מחדש את חבילת QA וה-RC שנסגרו כבר
