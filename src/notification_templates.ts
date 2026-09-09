export const NOTIFICATION_EVENT_TYPES = [
  "buyer_joined_authorized",
  "buyer_deal_target_reached",
  "buyer_deal_completed",
  "buyer_deal_failed",
  "buyer_recovery_required",
  "buyer_payment_recovered",
  "buyer_voucher_issued",
  "buyer_ticket_issued",
  "seller_deal_published",
  "seller_target_reached",
  "seller_deal_completed",
  "seller_deal_failed",
  "seller_excel_ready",
  "seller_customer_inquiry",
  "seller_kyc_approved",
  "seller_kyc_rejected",
  "seller_payout_frozen",
  "seller_payout_unfrozen",
  "admin_security_alert"
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export const NOTIFICATION_CHANNELS = ["sms", "email", "whatsapp_link", "internal"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_TEMPLATE_KEYS = [
  "buyer_joined_authorized_he",
  "buyer_deal_target_reached_he",
  "buyer_deal_completed_he",
  "buyer_deal_failed_he",
  "buyer_recovery_required_he",
  "buyer_payment_recovered_he",
  "buyer_voucher_issued_he",
  "buyer_ticket_issued_he",
  "seller_deal_published_he",
  "seller_target_reached_he",
  "seller_deal_completed_he",
  "seller_deal_failed_he",
  "seller_excel_ready_he",
  "seller_customer_inquiry_he",
  "seller_kyc_approved_he",
  "seller_kyc_rejected_he",
  "seller_payout_frozen_he",
  "seller_payout_unfrozen_he",
  "admin_security_alert_he"
] as const;

export type NotificationTemplateKey = (typeof NOTIFICATION_TEMPLATE_KEYS)[number];

/** The product name used in every outbound transactional message. */
export const NOTIFICATION_BRAND = "C-ton";

/**
 * Financial truth carried by every buyer-facing money statement.
 *   mock — the pilot runs on the synthetic provider: NO real charge exists and
 *          the copy must say so instead of announcing a payment.
 *   real — a real provider settled the money (post-pilot); the copy may state
 *          the charge that the canonical money state proves.
 * Absent means unknown and is rendered as the conservative (mock) wording.
 */
export type NotificationMoneyMode = "mock" | "real";

export type RenderedNotification = {
  subject?: string;
  body: string;
};

type TemplateDefinition = {
  eventType: NotificationEventType;
  templateKey: NotificationTemplateKey;
  compatibleChannels: readonly NotificationChannel[];
  requiredPayloadFields: readonly string[];
  render: (payload: Record<string, unknown>) => RenderedNotification;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function dealTitle(payload: Record<string, unknown>): string {
  return text(payload.deal_title) || "העסקה";
}

function isMockMoney(payload: Record<string, unknown>): boolean {
  return text(payload.money_mode) !== "real";
}

const MOCK_MONEY_LINE = "סביבת פיילוט: לא בוצע חיוב אמיתי.";

function linkLine(label: string, url: unknown): string {
  const value = text(url).trim();
  return value ? `\n${label}\n${value}` : "";
}

const TRACKING_LABEL = "למעקב אחרי ההזמנה שלך:";
const SELLER_DEAL_LABEL = "לצפייה בעסקה:";

const TEMPLATE_DEFINITIONS: Record<NotificationTemplateKey, TemplateDefinition> = {
  buyer_joined_authorized_he: {
    eventType: "buyer_joined_authorized",
    templateKey: "buyer_joined_authorized_he",
    compatibleChannels: ["sms", "email", "whatsapp_link", "internal"],
    requiredPayloadFields: ["deal_title"],
    render: (p) => ({
      subject: `הצטרפת לעסקה: ${dealTitle(p)}`,
      body: `הצטרפת לעסקה "${dealTitle(p)}" ב-${NOTIFICATION_BRAND}.\n${
        isMockMoney(p)
          ? MOCK_MONEY_LINE
          : "לא בוצע חיוב בפועל. הסכום נתפס כמסגרת אשראי בלבד עד לסגירת העסקה."
      }\nנעדכן אותך כשהעסקה תתקדם.${linkLine(TRACKING_LABEL, p.tracking_url)}`
    })
  },
  buyer_deal_target_reached_he: {
    eventType: "buyer_deal_target_reached",
    templateKey: "buyer_deal_target_reached_he",
    compatibleChannels: ["sms", "email", "whatsapp_link", "internal"],
    requiredPayloadFields: ["deal_title"],
    render: (p) => ({
      subject: `המינימום הושג: ${dealTitle(p)}`,
      body: `המינימום לעסקה "${dealTitle(p)}" הושג. העסקה מתקדמת לסגירה לפי התנאים שהוצגו.${
        isMockMoney(p) ? `\n${MOCK_MONEY_LINE}` : ""
      }${linkLine(TRACKING_LABEL, p.tracking_url)}`
    })
  },
  buyer_deal_completed_he: {
    eventType: "buyer_deal_completed",
    templateKey: "buyer_deal_completed_he",
    compatibleChannels: ["sms", "email", "whatsapp_link", "internal"],
    requiredPayloadFields: ["deal_title"],
    render: (p) => ({
      subject: `העסקה הושלמה: ${dealTitle(p)}`,
      body: `העסקה "${dealTitle(p)}" הושלמה בהצלחה.\n${
        isMockMoney(p) ? MOCK_MONEY_LINE : "החיוב בוצע בהתאם לתנאי העסקה."
      }\nפרטי ההמשך מופיעים במסך המעקב.${linkLine(TRACKING_LABEL, p.tracking_url)}`
    })
  },
  buyer_deal_failed_he: {
    eventType: "buyer_deal_failed",
    templateKey: "buyer_deal_failed_he",
    compatibleChannels: ["sms", "email", "whatsapp_link", "internal"],
    requiredPayloadFields: ["deal_title"],
    render: (p) => ({
      subject: `העסקה לא הושלמה: ${dealTitle(p)}`,
      body: `העסקה "${dealTitle(p)}" לא הושלמה.\n${
        isMockMoney(p)
          ? "לא בוצע חיוב. " + MOCK_MONEY_LINE
          : "אם נתפסה מסגרת אשראי, היא תשוחרר בהתאם למדיניות ספק האשראי."
      }${linkLine(TRACKING_LABEL, p.tracking_url)}`
    })
  },
  buyer_recovery_required_he: {
    eventType: "buyer_recovery_required",
    templateKey: "buyer_recovery_required_he",
    compatibleChannels: ["sms", "email", "whatsapp_link", "internal"],
    requiredPayloadFields: ["deal_title"],
    render: (p) => ({
      subject: `נדרש עדכון תשלום: ${dealTitle(p)}`,
      body: `החיוב עבור העסקה "${dealTitle(p)}" לא עבר.\nיש להשלים אמצעי תשלום בזמן חלון ההשלמה, אחרת ההשתתפות תבוטל.${
        isMockMoney(p) ? `\n${MOCK_MONEY_LINE}` : ""
      }${linkLine("להשלמת התשלום:", p.tracking_url)}`
    })
  },
  buyer_payment_recovered_he: {
    eventType: "buyer_payment_recovered",
    templateKey: "buyer_payment_recovered_he",
    compatibleChannels: ["sms", "email", "whatsapp_link", "internal"],
    requiredPayloadFields: ["deal_title"],
    render: (p) => ({
      subject: `התשלום הושלם: ${dealTitle(p)}`,
      body: `${
        isMockMoney(p)
          ? `אמצעי התשלום עבור העסקה "${dealTitle(p)}" עודכן. ${MOCK_MONEY_LINE}`
          : `התשלום עבור העסקה "${dealTitle(p)}" הושלם בהצלחה.`
      }\nפרטי ההמשך מופיעים במסך המעקב.${linkLine(TRACKING_LABEL, p.tracking_url)}`
    })
  },
  buyer_voucher_issued_he: {
    eventType: "buyer_voucher_issued",
    templateKey: "buyer_voucher_issued_he",
    compatibleChannels: ["sms", "email", "whatsapp_link", "internal"],
    requiredPayloadFields: ["deal_title"],
    render: (p) => ({
      subject: `השובר הונפק: ${dealTitle(p)}`,
      body: `השובר עבור העסקה "${dealTitle(p)}" הונפק.\nקוד השובר ופרטי המימוש (תוקף, מקום מימוש) מוצגים רק במסך המעקב שלך ב-${NOTIFICATION_BRAND}.\nאחריות המימוש על המוכר לפי תנאי השובר שצוינו.${linkLine(TRACKING_LABEL, p.tracking_url)}`
    })
  },
  buyer_ticket_issued_he: {
    eventType: "buyer_ticket_issued",
    templateKey: "buyer_ticket_issued_he",
    compatibleChannels: ["sms", "email", "whatsapp_link", "internal"],
    requiredPayloadFields: ["deal_title"],
    render: (p) => ({
      subject: `הכרטיס הונפק: ${dealTitle(p)}`,
      body: `הכרטיס עבור האירוע "${dealTitle(p)}" הונפק.\nקוד הכרטיס ופרטי הכניסה (תאריך, מקום, תנאים) מוצגים רק במסך המעקב שלך ב-${NOTIFICATION_BRAND}.\nאחריות הכניסה לאירוע על המוכר.${linkLine(TRACKING_LABEL, p.tracking_url)}`
    })
  },
  seller_deal_published_he: {
    eventType: "seller_deal_published",
    templateKey: "seller_deal_published_he",
    compatibleChannels: ["email", "internal"],
    requiredPayloadFields: ["deal_title", "deal_id"],
    render: (p) => ({
      subject: `העסקה פורסמה: ${dealTitle(p)}`,
      body: `העסקה "${dealTitle(p)}" פורסמה ב-${NOTIFICATION_BRAND}. ניתן לשתף את לינק העסקה ממסך המוכר.${linkLine(SELLER_DEAL_LABEL, p.deal_url)}`
    })
  },
  // P0.7 — a POINTER back into the product. The e-mail never carries the
  // customer message: the authoritative conversation stays inside the product.
  seller_customer_inquiry_he: {
    eventType: "seller_customer_inquiry",
    templateKey: "seller_customer_inquiry_he",
    compatibleChannels: ["email", "internal"],
    requiredPayloadFields: ["deal_title", "deal_id", "thread_id", "inquiry_url"],
    render: (p) => ({
      subject: `יש לך פנייה חדשה מלקוח ב-${NOTIFICATION_BRAND}`,
      body: `התקבלה פנייה חדשה מלקוח בנוגע לעסקה שלך "${dealTitle(p)}" ב-${NOTIFICATION_BRAND}.\nכדי לצפות בפנייה ולהשיב, היכנס ל-${NOTIFICATION_BRAND}:\n${text(p.inquiry_url)}\n\nהתשובה נכתבת בתוך ${NOTIFICATION_BRAND} בלבד — אין להשיב למייל זה.`
    })
  },
  seller_target_reached_he: {
    eventType: "seller_target_reached",
    templateKey: "seller_target_reached_he",
    compatibleChannels: ["email", "internal"],
    requiredPayloadFields: ["deal_title", "deal_id"],
    render: (p) => ({
      subject: `המינימום הושג: ${dealTitle(p)}`,
      body: `המינימום לעסקה "${dealTitle(p)}" הושג. העסקה מתקדמת לסגירה לפי התנאים.${linkLine(SELLER_DEAL_LABEL, p.deal_url)}`
    })
  },
  seller_deal_completed_he: {
    eventType: "seller_deal_completed",
    templateKey: "seller_deal_completed_he",
    compatibleChannels: ["email", "internal"],
    requiredPayloadFields: ["deal_title", "deal_id"],
    render: (p) => ({
      subject: `העסקה הושלמה: ${dealTitle(p)}`,
      body: `העסקה "${dealTitle(p)}" הושלמה.\nרשימת הזכאים, הכמויות וקובץ ה-Excel זמינים במסך העסקה.${
        isMockMoney(p) ? `\n${MOCK_MONEY_LINE}` : ""
      }${linkLine(SELLER_DEAL_LABEL, p.deal_url)}`
    })
  },
  seller_deal_failed_he: {
    eventType: "seller_deal_failed",
    templateKey: "seller_deal_failed_he",
    compatibleChannels: ["email", "internal"],
    requiredPayloadFields: ["deal_title", "deal_id"],
    render: (p) => ({
      subject: `העסקה לא הושלמה: ${dealTitle(p)}`,
      body: `העסקה "${dealTitle(p)}" לא הושלמה. ניתן לראות את מצב העסקה במסך המוכר.${linkLine(SELLER_DEAL_LABEL, p.deal_url)}`
    })
  },
  seller_excel_ready_he: {
    eventType: "seller_excel_ready",
    templateKey: "seller_excel_ready_he",
    compatibleChannels: ["email", "internal"],
    requiredPayloadFields: ["deal_title", "deal_id"],
    render: (p) => ({
      subject: `Excel העסקה מוכן: ${dealTitle(p)}`,
      body: `קובץ Excel לעסקה "${dealTitle(p)}" מוכן להורדה ממסך העסקה.${linkLine(SELLER_DEAL_LABEL, p.deal_url)}`
    })
  },
  seller_kyc_approved_he: {
    eventType: "seller_kyc_approved",
    templateKey: "seller_kyc_approved_he",
    compatibleChannels: ["email", "internal", "sms"],
    requiredPayloadFields: ["seller_name"],
    render: (p) => ({
      subject: `חשבון המוכר שלך אושר ב-${NOTIFICATION_BRAND}`,
      body: `שלום ${text(p.seller_name) || "מוכר/ת"},\nחשבונך אושר ועכשיו אפשר לפרסם עסקאות ב-${NOTIFICATION_BRAND}.\nלא בוצעה תנועת כסף בעקבות האישור.${linkLine("לאזור המוכר:", p.workspace_url)}`
    })
  },
  seller_kyc_rejected_he: {
    eventType: "seller_kyc_rejected",
    templateKey: "seller_kyc_rejected_he",
    compatibleChannels: ["email", "internal", "sms"],
    requiredPayloadFields: ["seller_name"],
    render: (p) => ({
      subject: `חשבון המוכר שלך לא אושר ב-${NOTIFICATION_BRAND}`,
      body: `שלום ${text(p.seller_name) || "מוכר/ת"},\nחשבונך לא אושר במצב הנוכחי.${
        text(p.reason).trim() ? `\nסיבה: ${text(p.reason).trim()}.` : ""
      }\nלא בוצעה תנועת כסף בעקבות הדחייה. ניתן ליצור קשר עם התמיכה לקבלת פירוט.`
    })
  },
  seller_payout_frozen_he: {
    eventType: "seller_payout_frozen",
    templateKey: "seller_payout_frozen_he",
    compatibleChannels: ["email", "internal"],
    requiredPayloadFields: ["seller_name", "reason"],
    render: (p) => ({
      subject: `הקפאת זיכוי payout פעילה`,
      body: `שלום ${text(p.seller_name) || "מוכר/ת"},\nהזיכוי שלך הוקפא זמנית מטעמי בקרה.\nסיבה: ${text(p.reason) || "לא צוינה"}.\nלא בוצעה תנועת כסף נוספת. עסקאות שכבר שולמו אינן מושפעות.`
    })
  },
  seller_payout_unfrozen_he: {
    eventType: "seller_payout_unfrozen",
    templateKey: "seller_payout_unfrozen_he",
    compatibleChannels: ["email", "internal"],
    requiredPayloadFields: ["seller_name"],
    render: (p) => ({
      subject: `הקפאת payout שוחררה`,
      body: `שלום ${text(p.seller_name) || "מוכר/ת"},\nההקפאה על הזיכוי שלך שוחררה. payout חדש יוערך לפי המסלול הרגיל בעת השלמת עסקה.`
    })
  },
  admin_security_alert_he: {
    eventType: "admin_security_alert",
    templateKey: "admin_security_alert_he",
    compatibleChannels: ["email", "internal"],
    requiredPayloadFields: ["alert_title"],
    render: (p) => ({
      subject: `התראת אבטחה ${NOTIFICATION_BRAND}: ${text(p.alert_title) || "התראה אדמין"}`,
      body: `התקבלה התראת אבטחה תפעולית.\nכותרת: ${text(p.alert_title) || ""}\nמזהה התראה: ${text(p.alert_ref) || "לא צוין"}\nיש לבדוק את לוח Mission Control לפני נקיטת פעולה.`
    })
  }
};

const EVENT_TO_TEMPLATE = Object.fromEntries(
  Object.values(TEMPLATE_DEFINITIONS).map((definition) => [definition.eventType, definition.templateKey])
) as Record<NotificationEventType, NotificationTemplateKey>;

export function isNotificationEventType(value: string): value is NotificationEventType {
  return (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(value);
}

export function isNotificationChannel(value: string): value is NotificationChannel {
  return (NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}

export function isNotificationTemplateKey(value: string): value is NotificationTemplateKey {
  return (NOTIFICATION_TEMPLATE_KEYS as readonly string[]).includes(value);
}

export function templateKeyForEvent(eventType: NotificationEventType): NotificationTemplateKey {
  return EVENT_TO_TEMPLATE[eventType];
}

export function getTemplateDefinition(templateKey: NotificationTemplateKey): TemplateDefinition {
  return TEMPLATE_DEFINITIONS[templateKey];
}

export function renderNotification(
  eventType: NotificationEventType | string,
  channel: NotificationChannel | "log" | string,
  payload: Record<string, unknown>,
  templateKey?: NotificationTemplateKey
): RenderedNotification | null {
  const normalizedEvent = normalizeEventType(eventType);
  const normalizedChannel = channel === "log" ? "internal" : channel;
  if (!normalizedEvent || !isNotificationChannel(normalizedChannel)) return null;
  const key = templateKey || templateKeyForEvent(normalizedEvent);
  const definition = TEMPLATE_DEFINITIONS[key];
  if (!definition || definition.eventType !== normalizedEvent) return null;
  if (!definition.compatibleChannels.includes(normalizedChannel)) return null;
  return definition.render(payload);
}

export function supportedChannels(eventType: NotificationEventType | string): NotificationChannel[] {
  const normalizedEvent = normalizeEventType(eventType);
  if (!normalizedEvent) return [];
  const definition = TEMPLATE_DEFINITIONS[templateKeyForEvent(normalizedEvent)];
  return [...definition.compatibleChannels];
}

/**
 * Legacy (pre-029) buyer event names accepted by the compatibility adapter.
 * `charge_succeeded` and `refund_issued` were REMOVED: the first rendered the
 * "payment recovered" template for an ordinary capture (untrue), the second
 * re-sent "deal failed" after the deal-failed notification (duplicate intent).
 */
const LEGACY_EVENT_ALIASES: Record<string, NotificationEventType> = {
  join_authorized: "buyer_joined_authorized",
  charge_failed_recovery: "buyer_recovery_required",
  deal_completed: "buyer_deal_completed",
  deal_failed: "buyer_deal_failed",
  deal_cancelled: "buyer_deal_failed"
};

export function normalizeEventType(value: string): NotificationEventType | null {
  if (isNotificationEventType(value)) return value;
  return LEGACY_EVENT_ALIASES[value] || null;
}
