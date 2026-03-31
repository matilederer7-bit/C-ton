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

type DealListRow = {
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
  commission_rate: number;
  joined_units: number;
  participants_count: number;
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

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function requireUuid(value: string, fieldName: string) {
  if (!isUuid(value)) {
    const err: any = new Error(`${fieldName} must be a valid uuid`);
    err.statusCode = 400;
    throw err;
  }
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

function mapDealListRow(row: DealListRow) {
  const joinedUnits = Number(row.joined_units || 0);
  const participantsCount = Number(row.participants_count || 0);
  const maxUnits = Number(row.max_units || 0);
  const thresholdUnits = Number(row.threshold_units || 0);
  const remainingUnits = Math.max(0, maxUnits - joinedUnits);
  return {
    deal_id: row.deal_id,
    title: row.title,
    state: row.state,
    price_per_unit: Number(row.price_per_unit),
    min_units: Number(row.min_units),
    max_units: maxUnits,
    threshold_units: thresholdUnits,
    deadline: row.deadline,
    published_at: row.published_at,
    completion_window_until: row.completion_window_until,
    created_at: row.created_at,
    commission_rate: Number(row.commission_rate || 0),
    metrics: {
      joined_units: joinedUnits,
      remaining_units: remainingUnits,
      participants_count: participantsCount,
      progress_to_target_pct: Number(Math.min(100, Math.round((joinedUnits / Math.max(1, thresholdUnits)) * 100))),
      progress_to_capacity_pct: Number(Math.min(100, Math.round((joinedUnits / Math.max(1, maxUnits)) * 100)))
    },
    availability: deriveDealAvailability(row.state, remainingUnits)
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
  app.get("/api/marketplace/deals", async (req: any) => {
    const q = String(req.query?.q || "").trim();
    return deps.withTx(async (c) => {
      const result = await c.query(
        `SELECT
           d.deal_id,
           d.title,
           d.state,
           d.price_per_unit,
           d.min_units,
           d.max_units,
           d.threshold_units,
           d.deadline,
           d.published_at,
           d.completion_window_until,
           d.created_at,
           d.commission_rate,
           COALESCE(SUM(p.qty),0) AS joined_units,
           COUNT(p.participant_id)::int AS participants_count
         FROM siton.deals d
         LEFT JOIN siton.participants p ON p.deal_id = d.deal_id
         WHERE d.state <> 'Draft'
           AND ($1 = '' OR d.title ILIKE '%' || $1 || '%' OR d.deal_id::text ILIKE '%' || $1 || '%')
         GROUP BY d.deal_id
         ORDER BY
           CASE
             WHEN d.state IN ('PendingTarget','TargetReached') THEN 0
             WHEN d.state IN ('ClosedForJoining','ReadyForCharging','Charging','CompletionWindow') THEN 1
             ELSE 2
           END,
           COALESCE(d.published_at, d.created_at) DESC
         LIMIT 48`,
        [q]
      );

      return {
        ok: true,
        q,
        deals: (result.rows as DealListRow[]).map(mapDealListRow),
        discovery_mode: "public-marketplace-expansion",
        note: "This searchable marketplace surface is a product expansion beyond the original link-based spec."
      };
    });
  });

  app.get("/api/deals/:id/public", async (req: any) => {
    const dealId = String(req.params.id);
    requireUuid(dealId, "deal_id");

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

  app.get("/api/seller/deals", async () => {
    return deps.withTx(async (c) => {
      const result = await c.query(
        `SELECT
           d.deal_id,
           d.title,
           d.state,
           d.price_per_unit,
           d.min_units,
           d.max_units,
           d.threshold_units,
           d.deadline,
           d.published_at,
           d.completion_window_until,
           d.created_at,
           d.commission_rate,
           COALESCE(SUM(p.qty),0) AS joined_units,
           COUNT(p.participant_id)::int AS participants_count
         FROM siton.deals d
         LEFT JOIN siton.participants p ON p.deal_id = d.deal_id
         GROUP BY d.deal_id
         ORDER BY d.created_at DESC
         LIMIT 100`
      );

      const deals = (result.rows as DealListRow[]).map(mapDealListRow);
      return {
        ok: true,
        seller_surface: {
          deals,
          totals: {
            total_deals: deals.length,
            live_deals: deals.filter((deal) => ["PendingTarget", "TargetReached", "ClosedForJoining", "ReadyForCharging", "Charging", "CompletionWindow"].includes(deal.state)).length,
            completed_deals: deals.filter((deal) => deal.state === "Completed").length,
            failed_or_cancelled: deals.filter((deal) => ["Failed", "Cancelled"].includes(deal.state)).length
          }
        }
      };
    });
  });

  app.get("/api/seller/deals/:id", async (req: any) => {
    const dealId = String(req.params.id);
    requireUuid(dealId, "deal_id");

    return deps.withTx(async (c) => {
      const dealResult = await c.query(
        `SELECT
           d.deal_id,
           d.title,
           d.state,
           d.price_per_unit,
           d.min_units,
           d.max_units,
           d.threshold_units,
           d.deadline,
           d.published_at,
           d.completion_window_until,
           d.created_at,
           d.commission_rate,
           COALESCE(SUM(p.qty),0) AS joined_units,
           COUNT(p.participant_id)::int AS participants_count
         FROM siton.deals d
         LEFT JOIN siton.participants p ON p.deal_id = d.deal_id
         WHERE d.deal_id = $1
         GROUP BY d.deal_id`,
        [dealId]
      );

      if (!dealResult.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }

      const participants = await c.query(
        `SELECT participant_id, buyer_id, qty, buyer_state, money_state, created_at
         FROM siton.participants
         WHERE deal_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [dealId]
      );

      const attempts = await c.query(
        `SELECT attempt_type, correlation_id, result_class, created_at
         FROM siton.payment_attempts
         WHERE deal_id = $1
         ORDER BY created_at DESC
         LIMIT 20`,
        [dealId]
      );

      return {
        ok: true,
        deal: mapDealListRow(dealResult.rows[0] as DealListRow),
        participants: participants.rows,
        payment_attempts: attempts.rows,
        seller_actions: {
          can_publish: (dealResult.rows[0] as DealListRow).state === "Draft",
          edit_locked: (dealResult.rows[0] as DealListRow).state !== "Draft",
          create_similar_supported: true
        }
      };
    });
  });

  app.get("/api/affiliate/overview", async () => {
    return deps.withTx(async (c) => {
      const result = await c.query(
        `SELECT deal_id, title, state, commission_rate, created_at, published_at
         FROM siton.deals
         ORDER BY created_at DESC
         LIMIT 50`
      );

      return {
        ok: true,
        affiliate_surface: {
          attribution_status: "partial",
          payout_status: "not_active",
          verification_status: "not_modeled",
          note: "Affiliate share links can be generated, but attribution and payout persistence are not implemented yet in the backend model.",
          campaigns: result.rows.map((row: any) => ({
            deal_id: row.deal_id,
            title: row.title,
            state: row.state,
            commission_rate: Number(row.commission_rate || 0),
            created_at: row.created_at,
            published_at: row.published_at,
            share_link: `/app/deal/${row.deal_id}?ref=affiliate-demo`
          }))
        }
      };
    });
  });

  app.get("/api/admin/overview", async (req: any) => {
    const q = String(req.query?.q || "").trim();
    return deps.withTx(async (c) => {
      const deals = await c.query(
        `SELECT
           d.deal_id,
           d.title,
           d.state,
           d.price_per_unit,
           d.min_units,
           d.max_units,
           d.threshold_units,
           d.deadline,
           d.published_at,
           d.completion_window_until,
           d.created_at,
           d.commission_rate,
           COALESCE(SUM(p.qty),0) AS joined_units,
           COUNT(p.participant_id)::int AS participants_count
         FROM siton.deals d
         LEFT JOIN siton.participants p ON p.deal_id = d.deal_id
         GROUP BY d.deal_id
         ORDER BY d.created_at DESC
         LIMIT 100`
      );

      const search = q
        ? await c.query(
            `SELECT 'deal' AS entity_type, d.deal_id::text AS entity_id, d.title AS headline, d.state AS state, NULL::text AS detail
             FROM siton.deals d
             WHERE d.deal_id::text ILIKE '%' || $1 || '%' OR d.title ILIKE '%' || $1 || '%'
             UNION ALL
             SELECT 'participant' AS entity_type, p.participant_id::text AS entity_id, p.buyer_id AS headline, p.buyer_state AS state, p.deal_id::text AS detail
             FROM siton.participants p
             WHERE p.participant_id::text ILIKE '%' || $1 || '%' OR p.buyer_id ILIKE '%' || $1 || '%' OR p.deal_id::text ILIKE '%' || $1 || '%'
             ORDER BY entity_type, headline
             LIMIT 30`,
            [q]
          )
        : { rows: [] };

      const rows = deals.rows as DealListRow[];
      return {
        ok: true,
        q,
        admin_surface: {
          totals: {
            deals: rows.length,
            live: rows.filter((row) => ["PendingTarget", "TargetReached", "ClosedForJoining", "ReadyForCharging", "Charging", "CompletionWindow"].includes(row.state)).length,
            exceptional: rows.filter((row) => ["Failed", "Cancelled", "Charging", "CompletionWindow"].includes(row.state)).length,
            draft: rows.filter((row) => row.state === "Draft").length
          },
          deals: rows.map(mapDealListRow).slice(0, 20),
          exceptional_deals: rows.filter((row) => ["Failed", "Cancelled", "Charging", "CompletionWindow"].includes(row.state)).map(mapDealListRow).slice(0, 12),
          search_results: search.rows
        }
      };
    });
  });

  app.get("/api/admin/deals/:id/profile", async (req: any) => {
    const dealId = String(req.params.id);
    requireUuid(dealId, "deal_id");

    return deps.withTx(async (c) => {
      const deal = await c.query(
        `SELECT *
         FROM siton.deals
         WHERE deal_id = $1`,
        [dealId]
      );
      if (!deal.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }

      const participants = await c.query(
        `SELECT participant_id, buyer_id, qty, buyer_state, money_state, created_at
         FROM siton.participants
         WHERE deal_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [dealId]
      );
      const outbox = await c.query(
        `SELECT event_type, status, available_at, created_at
         FROM siton.outbox_events
         WHERE aggregate_id = $1
         ORDER BY created_at DESC
         LIMIT 30`,
        [dealId]
      );
      const attempts = await c.query(
        `SELECT attempt_type, correlation_id, result_class, created_at
         FROM siton.payment_attempts
         WHERE deal_id = $1
         ORDER BY created_at DESC
         LIMIT 30`,
        [dealId]
      );
      const audit = await c.query(
        `SELECT entity_type, state_type, from_state, to_state, action_name, created_at
         FROM siton.audit_log
         WHERE deal_id = $1
         ORDER BY created_at DESC
         LIMIT 30`,
        [dealId]
      );

      return {
        ok: true,
        profile: {
          deal: deal.rows[0],
          participants: participants.rows,
          outbox: outbox.rows,
          payment_attempts: attempts.rows,
          audit: audit.rows
        }
      };
    });
  });

  app.get("/api/admin/users/:buyerId/profile", async (req: any) => {
    const buyerId = String(req.params.buyerId || "").trim();
    if (!buyerId) {
      const err: any = new Error("buyer_id required");
      err.statusCode = 400;
      throw err;
    }

    return deps.withTx(async (c) => {
      const participants = await c.query(
        `SELECT p.participant_id, p.deal_id, p.qty, p.buyer_state, p.money_state, p.created_at, d.title, d.state AS deal_state
         FROM siton.participants p
         JOIN siton.deals d ON d.deal_id = p.deal_id
         WHERE p.buyer_id = $1
         ORDER BY p.created_at DESC
         LIMIT 100`,
        [buyerId]
      );

      return {
        ok: true,
        profile: {
          buyer_id: buyerId,
          joins: participants.rows,
          totals: {
            total_joins: participants.rowCount,
            active_joins: participants.rows.filter((row: any) => !["DealCompleted", "DealFailed", "Dropped"].includes(row.buyer_state)).length
          }
        }
      };
    });
  });

  app.get("/api/participants/:id/tracking", async (req: any) => {
    const participantId = String(req.params.id);
    requireUuid(participantId, "participant_id");

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
    const digits = phone.replace(/\D/g, "");
    if (!digits) {
      const err: any = new Error("phone required");
      err.statusCode = 400;
      throw err;
    }
    if (digits.length < 7 || digits.length > 15) {
      const err: any = new Error("phone must contain 7 to 15 digits");
      err.statusCode = 400;
      throw err;
    }

    const sessionId = otpSessionId(digits);
    const session: OtpSession = {
      sessionId,
      phone: digits,
      createdAt: Date.now(),
      expiresAt: Date.now() + OTP_TTL_MS,
      verified: false
    };
    otpSessions.set(sessionId, session);

    return {
      ok: true,
      otp_session_id: sessionId,
      masked_destination: maskPhone(phone),
      expires_at: new Date(session.expiresAt).toISOString(),
      development_code: OTP_CODE
    };
  });

  app.post("/api/otp/verify", async (req: any) => {
    const sessionId = String(req.body?.otp_session_id || "");
    const code = String(req.body?.code || "");
    if (!sessionId) {
      const err: any = new Error("otp_session_id required");
      err.statusCode = 400;
      throw err;
    }
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
      ok: true,
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
  app.get("/app/marketplace", sendShell);
  app.get("/app/deal/:dealId", sendShell);
  app.get("/app/join/:dealId/otp", sendShell);
  app.get("/app/join/:dealId/payment", sendShell);
  app.get("/app/join/:dealId/confirmation", sendShell);
  app.get("/app/track/:participantId", sendShell);
  app.get("/app/seller", sendShell);
  app.get("/app/seller/new", sendShell);
  app.get("/app/seller/deals/:dealId", sendShell);
  app.get("/app/affiliate", sendShell);
  app.get("/app/admin", sendShell);
  app.get("/app/admin/deals/:dealId", sendShell);
  app.get("/app/admin/users/:buyerId", sendShell);
}
