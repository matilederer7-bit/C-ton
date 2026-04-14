/**
 * Notification Templates
 *
 * Maps (notification_event_type, channel) → rendered message.
 * Templates are in Hebrew (product language).
 * Interpolation: {{key}} placeholders, all values are strings.
 */

export type NotificationEventType =
  | "join_authorized"
  | "charge_succeeded"
  | "charge_failed_recovery"
  | "deal_completed"
  | "deal_failed"
  | "refund_issued"
  | "deal_cancelled";

export type NotificationChannel = "sms" | "email" | "log";

export type RenderedNotification = {
  subject?: string; // email only
  body: string;
};

// Template definitions: eventType → channel → template function
const TEMPLATES: Record<
  NotificationEventType,
  Partial<Record<NotificationChannel, (params: Record<string, string>) => RenderedNotification>>
> = {
  join_authorized: {
    sms: (p) => ({
      body: `סיטון: הצטרפת לעסקה "${p.deal_title || ""}". קיבלנו את אישור התשלום. נעדכן אותך ברגע שהעסקה תצא לפועל.`
    }),
    email: (p) => ({
      subject: `הצטרפת לעסקה: ${p.deal_title || ""}`,
      body: `שלום,\n\nהצטרפת לעסקה "${p.deal_title || ""}" בהצלחה.\nאישור התשלום התקבל. נשלח עדכון כשהעסקה תסגר.\n\nסיטון`
    }),
    log: (p) => ({ body: `[join_authorized] deal=${p.deal_id} participant=${p.participant_id}` })
  },

  charge_succeeded: {
    sms: (p) => ({
      body: `סיטון: חיוב עסקה "${p.deal_title || ""}" בוצע בהצלחה. נעדכן אותך ברגע שהעסקה תושלם.`
    }),
    email: (p) => ({
      subject: `חיוב בוצע: ${p.deal_title || ""}`,
      body: `שלום,\n\nהחיוב עבור עסקה "${p.deal_title || ""}" בוצע בהצלחה.\n\nסיטון`
    }),
    log: (p) => ({ body: `[charge_succeeded] deal=${p.deal_id} participant=${p.participant_id}` })
  },

  charge_failed_recovery: {
    sms: (p) => ({
      body: `סיטון: חיוב עסקה "${p.deal_title || ""}" נכשל. ננסה שוב בקרוב ונשלח עדכון.`
    }),
    email: (p) => ({
      subject: `בעיה בחיוב: ${p.deal_title || ""}`,
      body: `שלום,\n\nחיוב עבור עסקה "${p.deal_title || ""}" נכשל. ננסה לחייב שוב בקרוב.\n\nסיטון`
    }),
    log: (p) => ({ body: `[charge_failed_recovery] deal=${p.deal_id} participant=${p.participant_id}` })
  },

  deal_completed: {
    sms: (p) => ({
      body: `סיטון: העסקה "${p.deal_title || ""}" הושלמה! ההזמנה שלך בדרך. תודה שהצטרפת.`
    }),
    email: (p) => ({
      subject: `העסקה הושלמה: ${p.deal_title || ""}`,
      body: `שלום,\n\nהעסקה "${p.deal_title || ""}" הושלמה בהצלחה.\nההזמנה שלך נמצאת בטיפול המוכר.\n\nתודה,\nסיטון`
    }),
    log: (p) => ({ body: `[deal_completed] deal=${p.deal_id} participant=${p.participant_id}` })
  },

  deal_failed: {
    sms: (p) => ({
      body: `סיטון: מצטערים, העסקה "${p.deal_title || ""}" לא הצליחה להגיע ליעד. אם חויבת — תקבל החזר מלא.`
    }),
    email: (p) => ({
      subject: `העסקה לא הושלמה: ${p.deal_title || ""}`,
      body: `שלום,\n\nמצטערים, העסקה "${p.deal_title || ""}" לא הגיעה ליעד הנדרש.\nאם חויבת — יבוצע החזר מלא לחשבונך.\n\nסיטון`
    }),
    log: (p) => ({ body: `[deal_failed] deal=${p.deal_id} participant=${p.participant_id}` })
  },

  refund_issued: {
    sms: (p) => ({
      body: `סיטון: בוצע החזר עבור עסקה "${p.deal_title || ""}". הכסף יחזור לחשבונך תוך מספר ימי עסקים.`
    }),
    email: (p) => ({
      subject: `ביצענו החזר: ${p.deal_title || ""}`,
      body: `שלום,\n\nבוצע החזר עבור עסקה "${p.deal_title || ""}".\nהכסף יחזור לחשבונך תוך מספר ימי עסקים.\n\nסיטון`
    }),
    log: (p) => ({ body: `[refund_issued] deal=${p.deal_id} participant=${p.participant_id}` })
  },

  deal_cancelled: {
    sms: (p) => ({
      body: `סיטון: העסקה "${p.deal_title || ""}" בוטלה. אם חויבת — תקבל החזר מלא.`
    }),
    email: (p) => ({
      subject: `העסקה בוטלה: ${p.deal_title || ""}`,
      body: `שלום,\n\nהעסקה "${p.deal_title || ""}" בוטלה.\nאם חויבת — יבוצע החזר מלא.\n\nסיטון`
    }),
    log: (p) => ({ body: `[deal_cancelled] deal=${p.deal_id} participant=${p.participant_id}` })
  }
};

/**
 * Render a notification for a given event type and channel.
 * Returns null if no template is defined for the combination.
 */
export function renderNotification(
  eventType: NotificationEventType,
  channel: NotificationChannel,
  params: Record<string, string>
): RenderedNotification | null {
  const channelTemplates = TEMPLATES[eventType];
  if (!channelTemplates) return null;
  const fn = channelTemplates[channel];
  if (!fn) return null;
  return fn(params);
}

/**
 * Returns the template_id string for storage (used to identify template in the DB row).
 */
export function templateId(eventType: NotificationEventType, channel: NotificationChannel): string {
  return `${eventType}/${channel}/v1`;
}

/**
 * Returns all channels that have a template for a given event type.
 */
export function supportedChannels(eventType: NotificationEventType): NotificationChannel[] {
  const channelTemplates = TEMPLATES[eventType];
  if (!channelTemplates) return [];
  return Object.keys(channelTemplates) as NotificationChannel[];
}
