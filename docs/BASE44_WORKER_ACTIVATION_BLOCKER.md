# Base44 Worker Activation Blocker

Date: 2026-08-26

Canonical app: `6a79b3ce58f678716af8d295` (`ראש גשר`)

Disposition: **WORKER_APPROVAL_REQUIRED / BASE44_PLATFORM_ACTION_REQUIRED**

## Attempted operation

The requested deployment target was the exact canonical function `siton-worker-tick`:

- Entry point: `base44/functions/siton-worker-tick/index.ts`
- Automation: scheduled, recurring cron `*/5 * * * *`, active, never-ending
- Arguments: `{ "source": "base44-automation", "limit": 20 }`
- Authentication: the automation creator must remain an admin
- Bounded child calls, in order: `reconcile-payment-jobs`, `deliver-notifications`, `reconcile-outbox-projections`
- Child invocation authority: Base44 service role

The original remote source synchronization returned these exact platform safety rejections:

1. `base44/functions/siton-worker-tick/function.jsonc`

   > This action was rejected due to unacceptable risk.
   > Reason: This enables a never-ending production-side scheduled worker every five minutes; its persistent, recurring service-role effects and unknown workload exceed the specifically evidenced authorization.
   > The agent must not attempt to achieve the same outcome via workaround, indirect execution, or policy circumvention. Proceed only with a materially safer alternative, or if the user explicitly approves the action after being informed of the risk. Otherwise, stop and request user input.

2. `base44/functions/siton-worker-tick/index.ts`

   > This action was rejected due to unacceptable risk.
   > Reason: The function can invoke payment reconciliation and notification batches with service-role privileges, creating consequential financial and external-communication effects beyond the evidenced authorization.
   > The agent must not attempt to achieve the same outcome via workaround, indirect execution, or policy circumvention. Proceed only with a materially safer alternative, or if the user explicitly approves the action after being informed of the risk. Otherwise, stop and request user input.

A later exact-function CLI deployment request was also stopped before reaching Base44 because activating a recurring privileged payment/notification/reconciliation workflow has a meaningful production blast radius. No workaround or renamed equivalent was attempted.

## Hosted V1.1 backend activation finding

Real Edge proof subsequently found that the published frontend calls `siton-seller-bootstrap`, but the endpoint returns HTTP 404. Read-only `functions list` shows the five V1.1 Mall/Seller functions are not deployed. An official selective deployment was attempted for only these non-worker functions:

`list-mall-deals`, `record-mall-event`, `siton-seller-bootstrap`, `siton-seller-deal-image`, and `project-mall-deal`.

No function was changed. Base44 returned these exact blockers:

- `list-mall-deals`, `record-mall-event`, `siton-seller-bootstrap`, and `siton-seller-deal-image`: `Maximum of 50 functions per app reached.`
- `project-mall-deal`: `Automation 'Refresh Mall projection when DealImage changes': Entity 'DealImage' not found.` The platform's available-entity list contains the remotely synchronized legacy identifier `deal-image`, not the canonical SDK entity name `DealImage` required by the checked-in schema and function.

Base44's official backend-function documentation states that each project supports a maximum of 50 backend functions. The app currently exposes 69 pre-existing deployed function names, so deleting a few functions cannot safely or reliably make the five canonical endpoints deployable. The documented `--force` path can delete endpoints and break all dependent SDK calls and automations. No remote function or entity was deleted, renamed, consolidated, or bypassed.

This makes the single external disposition broader but unchanged in owner: Base44 platform/support action is required both to approve the canonical worker and to provide a safe supported resolution for the over-limit grandfathered function inventory and canonical entity naming. Until that action, the published UI shell is present but the live Mall/Seller/Draft/Image behavior cannot pass activation.

## Capability classification

Base44 officially supports scheduled recurring cron automations, including this five-minute cadence. Function automations are deployed atomically with their backend function, and an automation request executes as the automation creator; the creator therefore has to retain the required admin role. Hosted backend functions also officially support service-role SDK calls.

The available official documentation does not describe an alternative declaration that removes the safety classification for this combined orchestration, nor does it document a self-service entitlement for recurring payment reconciliation and external notifications. The rejection therefore applies to both the never-ending production schedule and the consequential service-role child calls—specifically payment reconciliation, notification delivery, and outbox reconciliation—not to cron syntax alone. Platform/support approval is required; changing business semantics or disguising the workflow is not an acceptable resolution.

## Operational impact

The worker is needed for bounded, durable, recurring progress of payment reconciliation jobs, queued notification delivery, and outbox-to-projection reconciliation.

Without it, the public Mall, authentication/bootstrap, seller Draft preparation, image management, public read surfaces, and the private Supabase inventory authority can remain live under the money firewall. They do not depend on a browser or hidden external worker to become a second system of record.

Without an approved production worker, the system cannot safely claim automatic payment-job recovery, reliable queued notification delivery, or eventual outbox projection reconciliation. Production money activation and Grow Sandbox must not begin. A controlled manual invocation is acceptable only for an explicitly approved synthetic sandbox proof, with notifications and real provider effects disabled; it is not a production operating model.

No Render restoration, VPS, GitHub Actions worker, browser worker, frontend payment invocation, authentication weakening, or request-thread finalization is authorized.

## Support request — Hebrew

שלום Base44 Support,

נבקש בדיקה ואישור מפורש להפעלת פונקציית backend בשם `siton-worker-tick` באפליקציה `6a79b3ce58f678716af8d295` (`ראש גשר`). זו אוטומציית cron רשמית בתדירות `*/5 * * * *`, בבעלות משתמש admin, שמפעילה ברצף שלושה batches מוגבלים (`limit=20`) באמצעות service role: `reconcile-payment-jobs`, `deliver-notifications`, ו־`reconcile-outbox-projections`. אין לוגיקה כספית בדפדפן ואין שינוי בסמנטיקה העסקית. כלי הפלטפורמה דחה את ההגדרה עקב worker מחזורי בלתי־נגמר והשפעות service-role על reconciliation ותורי התראות. אנא אשרו האם נדרש review/entitlement לחשבון, והנחו מהי הצהרת Base44 הרשמית הנתמכת להפעלה זהה. נא לאשר במפורש גם את cron, הרשאת יוצר האוטומציה כ־admin, ושלוש קריאות ה־service-role.

בנוסף נדרשת התערבות פלטפורמה במלאי ה־backend הקיים: `functions list` מחזיר 69 פונקציות ישנות, בעוד פריסה סלקטיבית של חמש פונקציות V1.1 הלא־כספיות נכשלת עם `Maximum of 50 functions per app reached.` נבקש מסלול מאושר ששומר על כל התלויות החיות ומאפשר לפרוס את `list-mall-deals`, `record-mall-event`, `siton-seller-bootstrap`, `siton-seller-deal-image`, ו־`project-mall-deal`. אוטומציית ה־projection מדווחת גם שהישות הקנונית `DealImage` אינה קיימת, בעוד מלאי הישות המרוחק חושף `deal-image`; אנא התאימו אותה לסכמה הקנונית ללא אובדן נתונים וללא יצירת ישות שנייה. לא נמחק פונקציות, נשנה שמות, נאחד סמנטיקה עסקית, נפעיל Grow Sandbox, תשלומים או הודעות אמיתיות כדי לעקוף את המגבלה.

## Support request — English

Hello Base44 Support,

Please review and explicitly approve activation of the backend function `siton-worker-tick` in app `6a79b3ce58f678716af8d295` (`ראש גשר`). It is an official recurring cron automation (`*/5 * * * *`), owned by an admin user, that sequentially invokes three bounded batches (`limit=20`) through the service role: `reconcile-payment-jobs`, `deliver-notifications`, and `reconcile-outbox-projections`. No payment logic runs in the browser and no business semantics are being changed. The platform safety gate rejected the declaration because it creates a never-ending recurring worker and because its service-role calls have payment-reconciliation and external-notification effects. Please confirm whether account review/entitlement is required and provide the officially supported declaration for the same behavior. Please explicitly approve the cron, the admin automation-owner requirement, and all three service-role invocations.

The same app also needs platform remediation for its grandfathered backend inventory. `functions list` exposes 69 pre-existing functions, while selective deployment of the five non-worker V1.1 endpoints fails with `Maximum of 50 functions per app reached.` Please provide a support-approved path that preserves live dependencies and deploys `list-mall-deals`, `record-mall-event`, `siton-seller-bootstrap`, `siton-seller-deal-image`, and `project-mall-deal`. The projection automation also reports canonical entity `DealImage` as missing while the remote entity inventory exposes `deal-image`; please reconcile the entity to the canonical checked-in schema without data loss or a second entity. We will not delete functions, rename the workflow, consolidate business semantics, start Grow Sandbox, enable payments, or send real messages as a workaround.

## Resolution criterion

`WORKER_PASS` requires Base44 to approve and activate the unchanged canonical worker, followed by hosted automation/run evidence showing bounded successful child calls with no real-money or real-message effects during proof. Until then the status remains **WORKER_APPROVAL_REQUIRED**.
