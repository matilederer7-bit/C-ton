# Stage 11 Runtime Verification - 2026-03-29

מטרת המסמך

לרכז במקום אחד את כל הממצאים המאומתים של סבב ה-QA וההקשחה שבוצע אחרי הקשחת `deals`, בלי להסתמך רק על יומן העבודה ב-`PROJECT_STATUS.md`.

מקור אמת

מקור האמת נשאר הקוד החי:
- `src/app.ts`
- `src/outbox_worker_helpers.ts`
- `src/payment_attempt_helpers.ts`

המסמך הזה הוא מסמך ייחוס תיעודי מאומת לריצה שבוצעה ב-2026-03-29.

## Publish

נבדק על הדיל:
- `0272459e-c214-4db3-81d8-0b7258975c40`

מה הוכח
- `Draft -> PendingTarget`
- `published_at` נקבע בפועל
- `threshold_units` נשאר `9` עבור `min_units = 10`
- נוצר `deadline_check` ב-`outbox_events`
- replay עם אותו `idempotency-key` מחזיר `replay = true`
- שינוי ישיר של `price_per_unit` אחרי publish נחסם

סדק שזוהה ונסגר
- סדר הפעולות ב-`atomicMultiTransition` היה עלול להפיל publish מול constraint של `published_at`
- בוצע תיקון נקודתי כך ש-`insideTx` ירוץ לפני עדכון ה-state

## Charging

מה הוכח על אותו deal
- `PendingTarget -> TargetReached -> ClosedForJoining -> ReadyForCharging -> Charging -> CompletionWindow`
- participant עבר:
  `JoinedAuthorized/AuthHeld -> LockedIn/AuthLocked -> ChargingAttempt/ChargeAttempt -> ChargedSuccess/ChargedSuccess`
- נרשמה רשומת `payment_attempts` מסוג `charge_start`
- `charge_deal` סומן `sent`
- נוצר `finalize_deal`

אכיפה מאומתת
- `completion_window_until` חסין לשינוי אחרי שנקבע

## Recovery

Recovery success
- deal: `baefe692-cca7-43c9-a2d6-cbb95d0a931c`
- participant:
  `ChargeFailedCompletion/ChargeFailedRecovery -> Recovered/RecoveredCharge`
- נרשמה רשומת `payment_attempts` מסוג `recovery` עם `success`

Recovery failure
- deal: `f0bb4f81-91fb-4aa1-aaa8-b91343827220`
- participant:
  `ChargeFailedCompletion/ChargeFailedRecovery -> Dropped/AuthReleased`
- נרשמה רשומת `payment_attempts` מסוג `recovery` עם `permanent_fail`

## Finalize and 90 Percent Rule

Finalize success
- deal: `f1c53472-2bba-4cd4-b36b-c2dd3627dae1`
- `min_units = 10`
- `captured = 9`
- `ceil(0.9 * 10) = 9`
- result:
  `CompletionWindow -> Completed`
  participant `ChargedSuccess -> DealCompleted`

Finalize failure
- deal: `8b4d63c7-c967-4160-a0ca-95d6afe6a502`
- `min_units = 10`
- `captured = 8`
- threshold remains `9`
- result:
  `CompletionWindow -> Failed`
  נוצר `refund_issue`
  participant `ChargedSuccess -> DealFailed`
  `money_state -> Refunded`

פסק דין
- כאשר `captured >= ceil(0.9 * min_units)` הדיל מושלם
- כאשר `captured < ceil(0.9 * min_units)` הדיל נכשל ונפתח refund

## DLQ and Retry Storm

DLQ end-to-end
- event: `04015fc0-bc29-4782-a315-0ac5ef347ede`
- event type: `charge_deal`
- aggregate_id לא קיים בכוונה

מה הוכח
- ה-event חזר ל-`pending` עם `attempt_count` עולה
- נשמר `last_error = deal not found`
- לאחר מיצוי סף הניסיונות ה-event עבר ל-`outbox_dlq`
- `attempt_count` הסופי ב-DLQ היה `4`

Retry storm
- event: `6a4276b7-6864-4fae-aa9c-aa45564a8fce`

מה הוכח
- גם באירוע חוזר נוסף לא נצפתה תקיעה על `processing`
- לא נצפתה כפילות ב-DLQ
- מסלול ה-retry נשאר יציב ודטרמיניסטי

## Volume / Soak

בדיקת volume עדכנית בוצעה דרך ה-API החי ולא דרך סקריפט legacy שיוצר deals ישירות עם schema ישן.

deal:
- `f8847043-3ea9-455a-b53a-8cc4d2c2aa57`

פרמטרים
- `min_units = 500`
- `max_units = 600`
- `threshold_units = 450`
- `900` בקשות join כמעט במקביל

תוצאה
- `600` הצלחות
- `300` דחיות עם `409`
- `0` סטטוסים אחרים
- `total_qty = 600`
- `participants_count = 600`
- אין חריגה מעל `max_units`
- הדיל נשאר `TargetReached`

## סיכום

נכון ל-2026-03-29:
- publish תקני הוכח
- charging הוכח
- recovery success ו-failure הוכחו
- finalize success ו-failure הוכחו
- כלל 90 האחוז הוכח לשני הכיוונים
- DLQ behavior הוכח
- retry storm בסיסי הוכח
- volume QA עדכני הוכח

אין blocker פתוח בחבילת ה-QA וההקשחה שנבדקה כאן.
