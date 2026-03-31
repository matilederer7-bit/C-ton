import type { FastifyInstance, FastifyReply } from "fastify";
import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import type { PaymentProvider } from "./payment_provider.js";

type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

type DealState =
  | "Draft"
  | "PendingTarget"
  | "TargetReached"
  | "ClosedForJoining"
  | "ReadyForCharging"
  | "Charging"
  | "CompletionWindow"
  | "Completed"
  | "Failed"
  | "Cancelled";

type BuyerState =
  | "JoinedAuthorized"
  | "LockedIn"
  | "ChargingAttempt"
  | "ChargedSuccess"
  | "ChargeFailedCompletion"
  | "Recovered"
  | "Dropped"
  | "DealCompleted"
  | "DealFailed";

type MoneyState =
  | "AuthHeld"
  | "AuthLocked"
  | "ChargeAttempt"
  | "ChargedSuccess"
  | "ChargeFailedRecovery"
  | "RecoveredCharge"
  | "AuthReleased"
  | "Refunded";

type OtpSession = {
  sessionId: string;
  phone: string;
  createdAt: number;
  expiresAt: number;
  verified: boolean;
};

const otpSessions = new Map<string, OtpSession>();
const OTP_CODE = "123456";
const OTP_TTL_MS = 10 * 60_000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const frontendDir = join(__dirname, "..", "frontend");

function maskPhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return phone;
  return `${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

function otpSessionId(phone: string) {
  return createHash("sha256")
    .update(`${phone}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 24);
}

function deriveDealAvailability(state: DealState, remainingUnits: number) {
  if (remainingUnits <= 0) {
    return {
      canJoin: false,
      reasonCode: "stock_exhausted",
      badge: "מלאי אזל",
      message: "הכמות המבוקשת בעסקה כבר נתפסה. אפשר לעקוב, אבל כרגע אי אפשר להצטרף."
    };
  }

  if (state === "PendingTarget") {
    return {
      canJoin: true,
      reasonCode: "open",
      badge: "פתוח להצטרפות",
      message: "אפשר להצטרף עכשיו. כרגע תתבצע רק תפיסת מסגרת, לא חיוב."
    };
  }

  if (state === "TargetReached") {
    return {
      canJoin: true,
      reasonCode: "target_reached_still_open",
      badge: "היעד הושג",
      message: "היעד כבר הושג, אבל ההצטרפות עדיין פתוחה עד סגירת החלון."
    };
  }

  if (state === "Draft") {
    return {
      canJoin: false,
      reasonCode: "draft",
      badge: "טיוטה",
      message: "העסקה עדיין לא פורסמה ולכן אינה זמינה להצטרפות."
    };
  }

  if (state === "Cancelled") {
    return {
      canJoin: false,
      reasonCode: "cancelled",
      badge: "בוטלה",
      message: "העסקה בוטלה ואין אפשרות להצטרף אליה."
    };
  }

  if (state === "Failed") {
    return {
      canJoin: false,
      reasonCode: "failed",
      badge: "נכשלה",
      message: "העסקה נכשלה ואין אפשרות להצטרף אליה."
    };
  }

  if (state === "Completed") {
    return {
      canJoin: false,
      reasonCode: "completed",
      badge: "הושלמה",
      message: "העסקה כבר הושלמה בהצלחה ולכן סגורה להצטרפות חדשה."
    };
  }

  if (state === "CompletionWindow") {
    return {
      canJoin: false,
      reasonCode: "completion_window",
      badge: "חלון השלמה",
      message: "העסקה נמצאת בחלון השלמה. לא ניתן להצטרף כרגע, אבל אפשר לעקוב אחרי הסטטוס."
    };
  }

  return {
    canJoin: false,
    reasonCode: "closed",
    badge: "סגורה להצטרפות",
    message: "העסקה כבר עברה לשלב שבו לא ניתן להצטרף."
  };
}

function deriveTrackingCopy(dealState: DealState, buyerState: BuyerState, moneyState: MoneyState) {
  if (dealState === "Completed" && (buyerState === "DealCompleted" || buyerState === "Recovered")) {
    return {
      headline: "העסקה הושלמה",
      subline: "העסקה נסגרה בהצלחה והחיוב בוצע בפועל.",
      tone: "success"
    };
  }

  if (dealState === "Failed" || buyerState === "DealFailed") {
    return {
      headline: "העסקה לא הושלמה",
      subline:
        moneyState === "Refunded"
          ? "העסקה נכשלה והחיוב בוטל או הוחזר."
          : "העסקה נכשלה. המערכת שחררה או תסיים לשחרר את תפיסת המסגרת לפי הסטטוס.",
      tone: "danger"
    };
  }

  if (dealState === "CompletionWindow") {
    return {
      headline: "העסקה בחלון השלמה",
      subline: "תפיסת המסגרת קיימת. החיוב בפועל ייקבע לפי תוצאות חלון ההשלמה.",
      tone: "warning"
    };
  }

  if (moneyState === "AuthHeld" || moneyState === "AuthLocked") {
    return {
      headline: "התפיסה נקלטה",
      subline: "תפיסת המסגרת הושלמה. החיוב בפועל יתבצע רק אם העסקה תיסגר בהצלחה.",
      tone: "info"
    };
  }

  if (moneyState === "ChargedSuccess" || moneyState === "RecoveredCharge") {
    return {
      headline: "החיוב בוצע",
      subline: "העסקה התקדמה לשלב שבו בוצע חיוב בפועל.",
      tone: "success"
    };
  }

  return {
    headline: "ההצטרפות נקלטה",
    subline: "העסקה עדיין בתהליך. אפשר להישאר במסך המעקב ולקבל את הסטטוס המעודכן.",
    tone: "info"
  };
}

async function sendFrontendFile(reply: FastifyReply, filename: string, contentType: string) {
  const content = await readFile(join(frontendDir, filename), "utf8");
  return reply.type(contentType).send(content);
}

export function registerFrontendExperience(
  app: FastifyInstance,
  deps: { withTx: WithTx; paymentProvider: PaymentProvider }
) {
  app.get("/api/deals/:id/public", async (req: any) => {
    const dealId = String(req.params.id);

    return deps.withTx(async (c) => {
      const dealResult = await c.query(
        `SELECT deal_id, title, state, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, completion_window_until, created_at
         FROM siton.deals
         WHERE deal_id=$1`,
        [dealId]
      );

      if (!dealResult.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }

      const aggregate = await c.query(
        `SELECT COALESCE(SUM(qty),0) AS joined_units, COUNT(*)::int AS participants_count
         FROM siton.participants
         WHERE deal_id=$1`,
        [dealId]
      );

      const deal = dealResult.rows[0] as {
        deal_id: string;
        title: string;
        state: DealState;
        price_per_unit: number;
        min_units: number;
        max_units: number;
        threshold_units: number;
        deadline: string;
        published_at: string | null;
        completion_window_until: string | null;
        created_at: string;
      };

      const joinedUnits = Number(aggregate.rows[0].joined_units || 0);
      const participantsCount = Number(aggregate.rows[0].participants_count || 0);
      const remainingUnits = Math.max(0, Number(deal.max_units) - joinedUnits);
      const availability = deriveDealAvailability(deal.state, remainingUnits);

      return {
        ok: true,
        deal: {
          deal_id: deal.deal_id,
          title: deal.title,
          state: deal.state,
          price_per_unit: Number(deal.price_per_unit),
          min_units: Number(deal.min_units),
          max_units: Number(deal.max_units),
          threshold_units: Number(deal.threshold_units),
          deadline: deal.deadline,
          published_at: deal.published_at,
          completion_window_until: deal.completion_window_until,
          created_at: deal.created_at
        },
        metrics: {
          joined_units: joinedUnits,
          remaining_units: remainingUnits,
          participants_count: participantsCount,
          progress_to_target_pct: Number(
            Math.min(100, Math.round((joinedUnits / Math.max(1, Number(deal.threshold_units))) * 100))
          ),
          progress_to_capacity_pct: Number(
            Math.min(100, Math.round((joinedUnits / Math.max(1, Number(deal.max_units))) * 100))
          )
        },
        availability
      };
    });
  });

  app.get("/api/participants/:id/tracking", async (req: any) => {
    const participantId = String(req.params.id);

    return deps.withTx(async (c) => {
      const participantResult = await c.query(
        `SELECT
           p.participant_id,
           p.deal_id,
           p.buyer_id,
           p.qty,
           p.buyer_state,
           p.money_state,
           p.created_at,
           d.title,
           d.state AS deal_state,
           d.price_per_unit,
           d.deadline,
           d.completion_window_until
         FROM siton.participants p
         JOIN siton.deals d ON d.deal_id = p.deal_id
         WHERE p.participant_id=$1`,
        [participantId]
      );

      if (!participantResult.rowCount) {
        const err: any = new Error("participant not found");
        err.statusCode = 404;
        throw err;
      }

      const row = participantResult.rows[0] as {
        participant_id: string;
        deal_id: string;
        buyer_id: string;
        qty: number;
        buyer_state: BuyerState;
        money_state: MoneyState;
        created_at: string;
        title: string;
        deal_state: DealState;
        price_per_unit: number;
        deadline: string;
        completion_window_until: string | null;
      };

      const copy = deriveTrackingCopy(row.deal_state, row.buyer_state, row.money_state);

      return {
        ok: true,
        tracking: {
          participant_id: row.participant_id,
          deal_id: row.deal_id,
          buyer_id: row.buyer_id,
          qty: Number(row.qty),
          estimated_total: Number(row.qty) * Number(row.price_per_unit),
          buyer_state: row.buyer_state,
          money_state: row.money_state,
          deal_state: row.deal_state,
          deal_title: row.title,
          price_per_unit: Number(row.price_per_unit),
          deadline: row.deadline,
          completion_window_until: row.completion_window_until,
          created_at: row.created_at,
          headline: copy.headline,
          subline: copy.subline,
          tone: copy.tone
        }
      };
    });
  });

  app.post("/api/otp/start", async (req: any) => {
    const phone = String(req.body?.phone || "").trim();
    if (!phone) {
      const err: any = new Error("phone required");
      err.statusCode = 400;
      throw err;
    }

    const sessionId = otpSessionId(phone);
    const session: OtpSession = {
      sessionId,
      phone,
      createdAt: Date.now(),
      expiresAt: Date.now() + OTP_TTL_MS,
      verified: false
    };
    otpSessions.set(sessionId, session);

    return {
      
      otp_session_id: sessionId,
      masked_destination: maskPhone(phone),
      expires_at: new Date(session.expiresAt).toISOString(),
      development_code: OTP_CODE
    };
  });

  app.post("/api/otp/verify", async (req: any) => {
    const sessionId = String(req.body?.otp_session_id || "");
    const code = String(req.body?.code || "");
    const session = otpSessions.get(sessionId);

    if (!session) {
      const err: any = new Error("otp session not found");
      err.statusCode = 404;
      throw err;
    }

    if (Date.now() > session.expiresAt) {
      otpSessions.delete(sessionId);
      const err: any = new Error("otp expired");
      err.statusCode = 400;
      throw err;
    }

    if (code !== OTP_CODE) {
      const err: any = new Error("invalid otp");
      err.statusCode = 400;
      throw err;
    }

    session.verified = true;
    otpSessions.set(sessionId, session);

    return {
      
      otp_session_id: sessionId,
      verified: true,
      buyer_id: session.phone
    };
  });

  app.post("/api/payments/authorize-mock", async (req: any, reply: any) => {
    const result = await deps.paymentProvider.authorize({
      holder_name: String(req.body?.holder_name || ""),
      card_number: String(req.body?.card_number || ""),
      expiry: String(req.body?.expiry || ""),
      cvv: String(req.body?.cvv || "")
    });

    if (!result.ok) {
      return reply.code(result.statusCode).send(result);
    }

    return result;

    

    return {
      ok: true,
      
      
      hold_message: "בוצעה תפיסת מסגרת מדומה. החיוב בפועל יתבצע רק אם העסקה תושלם."
    };
  });

  app.get("/app/assets/styles.css", async (_req, reply) =>
    sendFrontendFile(reply, "styles.css", "text/css; charset=utf-8")
  );
  app.get("/app/assets/app.js", async (_req, reply) =>
    sendFrontendFile(reply, "app.js", "application/javascript; charset=utf-8")
  );

  const sendShell = async (_req: any, reply: FastifyReply) =>
    sendFrontendFile(reply, "index.html", "text/html; charset=utf-8");

  app.get("/app", sendShell);
  app.get("/app/", sendShell);
  app.get("/app/deal/:dealId", sendShell);
  app.get("/app/join/:dealId/otp", sendShell);
  app.get("/app/join/:dealId/payment", sendShell);
  app.get("/app/join/:dealId/confirmation", sendShell);
  app.get("/app/track/:participantId", sendShell);
}
