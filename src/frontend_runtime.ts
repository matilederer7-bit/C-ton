import type { FastifyInstance, FastifyReply } from "fastify";
import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { getPaymentProviderSummary, type PaymentProvider } from "./payment_provider.js";
import {
  AFFILIATE_FEE_SHARE_OF_PLATFORM,
  DEFAULT_AFFILIATE_CODE,
  ensureRemainingProductSurfaceTables,
  isChargedMoneyState,
  summarizeMoney
} from "./product_surface_support.js";

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

function receiptEligible(dealState: DealState, moneyState: string) {
  return dealState === "Completed" && isChargedMoneyState(moneyState);
}

function deliveryEligible(dealState: DealState, moneyState: string) {
  return dealState === "Completed" && isChargedMoneyState(moneyState);
}

async function sendFrontendFile(reply: FastifyReply, filename: string, contentType: string) {
  const content = await readFile(join(frontendDir, filename), "utf8");
  return reply.type(contentType).send(content);
}

export function registerFrontendExperience(
  app: FastifyInstance,
  deps: {
    withTx: WithTx;
    paymentProvider: PaymentProvider;
    deploymentMode: string;
    isDemoPreview: boolean;
    notificationSummary: {
      provider: string;
      mode: string;
      external_delivery: boolean;
    };
  }
) {
  const ensureProductSurfaces = () => ensureRemainingProductSurfaceTables(deps.withTx);

  app.get("/api/preview/meta", async () => ({
    ok: true,
    preview: {
      deployment_mode: deps.deploymentMode,
      is_demo_preview: deps.isDemoPreview,
      public_label: deps.isDemoPreview ? "Demo / Preview" : "Internal runtime",
      guardrails: {
        payment_is_real: false,
        invoice_is_real: false,
        shipping_is_real: false,
        payout_is_real: false,
        kyc_is_real: false,
        notifications_are_real: deps.notificationSummary.external_delivery
      },
      notes: [
        "This environment is intended for live showcase and preview only.",
        "Payment, invoice, shipping, payout, and KYC rails remain inactive until external activation starts.",
        deps.notificationSummary.external_delivery
          ? "Notification delivery is externally active."
          : "Notifications remain log-only in this environment."
      ]
    }
  }));

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
    await ensureProductSurfaces();

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

      const attributions = await c.query(
        `SELECT aa.participant_id,
                aa.share_code,
                aa.commission_amount,
                aa.payout_status,
                af.display_name AS affiliate_name,
                af.verification_status
         FROM siton.affiliate_attributions aa
         JOIN siton.affiliate_accounts af ON af.affiliate_id = aa.affiliate_id
         WHERE aa.deal_id = $1`,
        [dealId]
      );

      const deliveries = await c.query(
        `SELECT participant_id, status, tracking_number, issue_note, updated_at
         FROM siton.delivery_records
         WHERE deal_id = $1
         ORDER BY updated_at DESC`,
        [dealId]
      );

      const deal = mapDealListRow(dealResult.rows[0] as DealListRow);
      const attributionByParticipant = new Map(
        attributions.rows.map((row: any) => [String(row.participant_id), row])
      );
      const deliveryByParticipant = new Map(
        deliveries.rows.map((row: any) => [String(row.participant_id), row])
      );

      const fulfilledParticipants = participants.rows
        .filter((row: any) => receiptEligible(deal.state, String(row.money_state)))
        .map((row: any) => {
          const attribution = attributionByParticipant.get(String(row.participant_id)) as any;
          const grossAmount = Number(row.qty) * Number(deal.price_per_unit);
          return {
            participant_id: row.participant_id,
            buyer_id: row.buyer_id,
            qty: Number(row.qty),
            money_state: row.money_state,
            buyer_state: row.buyer_state,
            gross_amount: grossAmount,
            receipt_id: `RCT-${String(deal.deal_id).slice(0, 8)}-${String(row.participant_id).slice(0, 6)}`,
            share_code: attribution?.share_code ?? null,
            affiliate_name: attribution?.affiliate_name ?? null,
            affiliate_fee_amount: Number(attribution?.commission_amount || 0),
            payout_status: attribution?.payout_status ?? "not_attributed"
          };
        });

      const financialSummary = summarizeMoney({
        grossAmount: fulfilledParticipants.reduce(
          (sum: number, row: any) => sum + Number(row.gross_amount || 0),
          0
        ),
        commissionRate: Number(deal.commission_rate || 0),
        affiliateAmount: fulfilledParticipants.reduce(
          (sum: number, row: any) => sum + Number(row.affiliate_fee_amount || 0),
          0
        )
      });

      const deliveryRows = participants.rows
        .filter((row: any) => deliveryEligible(deal.state, String(row.money_state)))
        .map((row: any) => {
          const delivery = deliveryByParticipant.get(String(row.participant_id)) as any;
          return {
            participant_id: row.participant_id,
            buyer_id: row.buyer_id,
            qty: Number(row.qty),
            money_state: row.money_state,
            status: delivery?.status ?? "ready_to_fulfill",
            tracking_number: delivery?.tracking_number ?? null,
            issue_note: delivery?.issue_note ?? "",
            updated_at: delivery?.updated_at ?? null
          };
        });

      return {
        ok: true,
        deal,
        participants: participants.rows,
        payment_attempts: attempts.rows,
        receipts_surface: {
          status:
            deal.state === "Completed"
              ? "ready"
              : ["Failed", "Cancelled"].includes(deal.state)
                ? "not_issued"
                : "waiting_for_completion",
          eligible_money_states: ["ChargedSuccess", "RecoveredCharge"],
          note:
            deal.state === "Completed"
              ? "Receipts are generated only for successfully charged or recovered participants in completed deals. In demo or preview this remains an internal-ready receipt surface, not an external invoice rail."
              : "Receipts stay blocked until the deal reaches Completed. Failed or cancelled deals do not issue seller receipts.",
          summary: {
            ...financialSummary,
            receipt_document_count: fulfilledParticipants.length
          },
          documents: fulfilledParticipants
        },
        delivery_surface: {
          status: deal.state === "Completed" ? "ready" : "blocked_until_completed",
          note:
            deal.state === "Completed"
              ? "Only successfully charged or recovered buyers appear in delivery operations. Demo mode records fulfillment intent and tracking semantics, but does not claim live carrier execution."
              : "Delivery operations become active only after a deal completes successfully.",
          rows: deliveryRows
        },
        seller_actions: {
          can_publish: (dealResult.rows[0] as DealListRow).state === "Draft",
          edit_locked: (dealResult.rows[0] as DealListRow).state !== "Draft",
          create_similar_supported: true,
          can_manage_delivery: deal.state === "Completed"
        }
      };
    });
  });

  app.post("/api/seller/deals/:id/delivery/:participantId", async (req: any) => {
    const dealId = String(req.params.id);
    const participantId = String(req.params.participantId);
    requireUuid(dealId, "deal_id");
    requireUuid(participantId, "participant_id");
    await ensureProductSurfaces();

    const status = String(req.body?.status || "").trim();
    const trackingNumber = String(req.body?.tracking_number || "").trim();
    const issueNote = String(req.body?.issue_note || "").trim();
    const allowedStatuses = new Set(["ready_to_fulfill", "shipped", "delivered", "issue"]);
    if (!allowedStatuses.has(status)) {
      const err: any = new Error("delivery status is invalid");
      err.statusCode = 400;
      throw err;
    }
    if ((status === "shipped" || status === "delivered") && !trackingNumber) {
      const err: any = new Error("tracking number is required for shipped or delivered status");
      err.statusCode = 400;
      throw err;
    }
    if (status === "issue" && !issueNote) {
      const err: any = new Error("issue note is required when delivery status is issue");
      err.statusCode = 400;
      throw err;
    }

    return deps.withTx(async (c) => {
      const participant = await c.query(
        `SELECT p.participant_id, p.buyer_id, p.qty, p.money_state, d.state AS deal_state
         FROM siton.participants p
         JOIN siton.deals d ON d.deal_id = p.deal_id
         WHERE p.participant_id = $1 AND p.deal_id = $2`,
        [participantId, dealId]
      );

      if (!participant.rowCount) {
        const err: any = new Error("participant not found");
        err.statusCode = 404;
        throw err;
      }

      const row = participant.rows[0] as any;
      if (!deliveryEligible(String(row.deal_state) as DealState, String(row.money_state))) {
        const err: any = new Error("delivery update requires completed deal with charged buyer");
        err.statusCode = 409;
        throw err;
      }

      const upserted = await c.query(
        `INSERT INTO siton.delivery_records (
           deal_id, participant_id, status, tracking_number, issue_note
         )
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (participant_id) DO UPDATE
         SET status = EXCLUDED.status,
             tracking_number = EXCLUDED.tracking_number,
             issue_note = EXCLUDED.issue_note,
             updated_at = now()
         RETURNING participant_id, status, tracking_number, issue_note, updated_at`,
        [dealId, participantId, status, trackingNumber || null, issueNote]
      );

      return {
        ok: true,
        delivery: upserted.rows[0]
      };
    });
  });

  app.get("/api/affiliate/overview", async () => {
    await ensureProductSurfaces();
    return deps.withTx(async (c) => {
      const affiliate = await c.query(
        `SELECT affiliate_id, affiliate_code, display_name, verification_status, payout_status,
                payout_method, payout_details_masked, admin_note
         FROM siton.affiliate_accounts
         WHERE affiliate_code = $1
         LIMIT 1`,
        [DEFAULT_AFFILIATE_CODE]
      );
      const profile = affiliate.rows[0] as any;

      const campaigns = await c.query(
        `SELECT d.deal_id,
                d.title,
                d.state,
                d.commission_rate,
                d.created_at,
                d.published_at,
                COUNT(a.participant_id)::int AS attributed_buyers,
                COALESCE(SUM(a.commission_amount),0) AS attributed_commission,
                COALESCE(SUM(CASE WHEN a.payout_status='pending' THEN a.commission_amount ELSE 0 END),0) AS pending_commission,
                COALESCE(SUM(CASE WHEN a.payout_status='approved' THEN a.commission_amount ELSE 0 END),0) AS approved_commission,
                COALESCE(SUM(CASE WHEN a.payout_status='paid' THEN a.commission_amount ELSE 0 END),0) AS paid_commission
         FROM siton.deals d
         LEFT JOIN siton.affiliate_attributions a
           ON a.deal_id = d.deal_id
          AND a.affiliate_id = $1
         GROUP BY d.deal_id
         ORDER BY d.created_at DESC
         LIMIT 50`,
        [profile.affiliate_id]
      );

      const attributionTotals = await c.query(
        `SELECT
           COUNT(*)::int AS total_attributions,
           COALESCE(SUM(commission_amount),0) AS total_commission,
           COALESCE(SUM(CASE WHEN payout_status='pending' THEN commission_amount ELSE 0 END),0) AS pending_commission,
           COALESCE(SUM(CASE WHEN payout_status='approved' THEN commission_amount ELSE 0 END),0) AS approved_commission,
           COALESCE(SUM(CASE WHEN payout_status='paid' THEN commission_amount ELSE 0 END),0) AS paid_commission
         FROM siton.affiliate_attributions
         WHERE affiliate_id = $1`,
        [profile.affiliate_id]
      );
      const totals = attributionTotals.rows[0] as any;

      return {
        ok: true,
        affiliate_surface: {
          attribution_status: totals.total_attributions > 0 ? "active" : "ready_for_attribution",
          payout_status: profile.payout_status,
          verification_status: profile.verification_status,
          payout_method: profile.payout_method,
          payout_details_masked: profile.payout_details_masked || "missing",
          note: "Affiliate attribution is persisted internally. Demo mode shows payout readiness and payout-state semantics, but no live payout rail is active yet.",
          totals: {
            total_attributions: Number(totals.total_attributions || 0),
            total_commission: Number(totals.total_commission || 0),
            pending_commission: Number(totals.pending_commission || 0),
            approved_commission: Number(totals.approved_commission || 0),
            paid_commission: Number(totals.paid_commission || 0)
          },
          verification_surface: {
            status: profile.verification_status,
            admin_note: profile.admin_note || "",
            can_submit_payout_profile: true
          },
          campaigns: campaigns.rows.map((row: any) => ({
            deal_id: row.deal_id,
            title: row.title,
            state: row.state,
            commission_rate: Number(row.commission_rate || 0),
            created_at: row.created_at,
            published_at: row.published_at,
            attributed_buyers: Number(row.attributed_buyers || 0),
            attributed_commission: Number(row.attributed_commission || 0),
            pending_commission: Number(row.pending_commission || 0),
            approved_commission: Number(row.approved_commission || 0),
            paid_commission: Number(row.paid_commission || 0),
            share_link: `/app/deal/${row.deal_id}?ref=${encodeURIComponent(profile.affiliate_code)}`
          }))
        }
      };
    });
  });

  app.post("/api/affiliate/payout-profile", async (req: any) => {
    await ensureProductSurfaces();
    const payoutMethod = String(req.body?.payout_method || "").trim();
    const payoutDetails = String(req.body?.payout_details || "").trim();
    if (!payoutMethod || !payoutDetails) {
      const err: any = new Error("payout_method and payout_details are required");
      err.statusCode = 400;
      throw err;
    }

    return deps.withTx(async (c) => {
      const masked = payoutDetails.length <= 4 ? payoutDetails : `***${payoutDetails.slice(-4)}`;
      const updated = await c.query(
        `UPDATE siton.affiliate_accounts
         SET payout_method = $2,
             payout_details_masked = $3,
             payout_status = CASE
               WHEN verification_status='verified' THEN 'pending_review'
               ELSE 'pending_profile'
             END,
             updated_at = now()
         WHERE affiliate_code = $1
         RETURNING affiliate_code, payout_method, payout_details_masked, payout_status`,
        [DEFAULT_AFFILIATE_CODE, payoutMethod, masked]
      );

      if (!updated.rowCount) {
        const err: any = new Error("affiliate profile not found");
        err.statusCode = 404;
        throw err;
      }

      return {
        ok: true,
        affiliate_profile: updated.rows[0]
      };
    });
  });

  app.get("/api/admin/overview", async (req: any) => {
    const q = String(req.query?.q || "").trim();
    await ensureProductSurfaces();
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

      const kycQueue = await c.query(
        `SELECT 'seller' AS subject_type,
                seller_id AS subject_id,
                display_name,
                verification_status AS status,
                settlement_status AS detail,
                updated_at
         FROM siton.seller_accounts
         UNION ALL
         SELECT 'affiliate' AS subject_type,
                affiliate_id::text AS subject_id,
                display_name,
                verification_status AS status,
                payout_status AS detail,
                updated_at
         FROM siton.affiliate_accounts
         ORDER BY updated_at DESC`
      );

      const support = await c.query(
        `SELECT ticket_id, scope_type, scope_key, title, priority, status, summary, created_at, updated_at
         FROM siton.support_tickets
         ORDER BY updated_at DESC
         LIMIT 30`
      );

      const affiliateSettlements = await c.query(
        `SELECT af.affiliate_id::text AS affiliate_id,
                af.display_name,
                af.verification_status,
                af.payout_status,
                COALESCE(SUM(a.commission_amount),0) AS total_commission,
                COALESCE(SUM(CASE WHEN a.payout_status='pending' THEN a.commission_amount ELSE 0 END),0) AS pending_commission,
                COALESCE(SUM(CASE WHEN a.payout_status='approved' THEN a.commission_amount ELSE 0 END),0) AS approved_commission,
                COALESCE(SUM(CASE WHEN a.payout_status='paid' THEN a.commission_amount ELSE 0 END),0) AS paid_commission
         FROM siton.affiliate_accounts af
         LEFT JOIN siton.affiliate_attributions a ON a.affiliate_id = af.affiliate_id
         GROUP BY af.affiliate_id
         ORDER BY af.display_name`
      );

      const forensics = await c.query(
        `SELECT
           (SELECT COUNT(*)::int FROM siton.outbox_dlq) AS dlq_count,
           (SELECT COUNT(*)::int FROM siton.webhook_events WHERE status='failed') AS failed_webhooks,
           (SELECT COUNT(*)::int FROM siton.webhook_events WHERE status='ignored') AS ignored_webhooks,
           (SELECT COUNT(*)::int FROM siton.webhook_events WHERE status='pending') AS pending_webhooks,
           (SELECT COUNT(*)::int FROM siton.audit_log WHERE created_at > now() - interval '24 hours') AS recent_audit_events`
      );

      const rows = deals.rows as DealListRow[];
      const completedDeals = rows.filter((row) => row.state === "Completed");
      const sellerSettlementGross = completedDeals.reduce(
        (sum, row) => sum + Number(row.price_per_unit || 0) * Number(row.joined_units || 0),
        0
      );
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
          search_results: search.rows,
          kyc_queue: kycQueue.rows,
          settlements: {
            seller_workspace: {
              completed_deals: completedDeals.length,
              gross_amount: sellerSettlementGross,
              platform_fee_amount: Number(
                completedDeals.reduce(
                  (sum, row) => sum + Number(row.price_per_unit || 0) * Number(row.joined_units || 0) * Number(row.commission_rate || 0),
                  0
                ).toFixed(2)
              )
            },
            affiliates: affiliateSettlements.rows
          },
          support_tickets: support.rows,
          forensics: forensics.rows[0]
        }
      };
    });
  });

  app.get("/api/admin/system-status", async () => {
    await ensureProductSurfaces();
    return deps.withTx(async (c) => {
      const counts = await c.query(
        `SELECT
           (SELECT COUNT(*)::int FROM siton.outbox_events WHERE status IN ('pending','processing')) AS active_outbox,
           (SELECT COUNT(*)::int FROM siton.outbox_dlq) AS dlq_count,
           (SELECT COUNT(*)::int FROM siton.webhook_events WHERE status='pending') AS pending_webhooks,
           (SELECT COUNT(*)::int FROM siton.webhook_events WHERE status='failed') AS failed_webhooks,
           (SELECT COUNT(*)::int FROM siton.support_tickets WHERE status <> 'resolved') AS open_support_tickets`
      );

      return {
        ok: true,
        system_status: {
          app_health: {
            ok: true
          },
          deployment: {
            mode: deps.deploymentMode,
            is_demo_preview: deps.isDemoPreview
          },
          integrations: {
            payment: getPaymentProviderSummary(deps.paymentProvider),
            notifications: deps.notificationSummary,
            webhook_ingestion: {
              duplicate_policy: "provider+event_id idempotent accept",
              supported_events: [
                "payment_authorized",
                "payment_failed",
                "charge_captured",
                "charge_failed",
                "recovery_captured",
                "recovery_failed"
              ]
            }
          },
          operational_counts: counts.rows[0],
          notes: [
            deps.isDemoPreview
              ? "This runtime is configured for demo / preview deployment and should not be presented as a live commercial environment."
              : "This runtime is not marked as commercial-live.",
            "Payment remains intentionally mock-backed until external activation starts.",
            "Notifications remain intentionally log-only until external activation starts."
          ]
        }
      };
    });
  });

  app.get("/api/admin/deals/:id/profile", async (req: any) => {
    const dealId = String(req.params.id);
    requireUuid(dealId, "deal_id");
    await ensureProductSurfaces();

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
      const deliveries = await c.query(
        `SELECT participant_id, status, tracking_number, issue_note, updated_at
         FROM siton.delivery_records
         WHERE deal_id = $1
         ORDER BY updated_at DESC`,
        [dealId]
      );
      const attributions = await c.query(
        `SELECT aa.participant_id, aa.share_code, aa.commission_amount, aa.payout_status, af.display_name
         FROM siton.affiliate_attributions aa
         JOIN siton.affiliate_accounts af ON af.affiliate_id = aa.affiliate_id
         WHERE aa.deal_id = $1
         ORDER BY aa.created_at DESC`,
        [dealId]
      );
      const tickets = await c.query(
        `SELECT ticket_id, scope_type, scope_key, title, priority, status, summary, updated_at
         FROM siton.support_tickets
         WHERE (scope_type='deal' AND scope_key=$1) OR (scope_type='system')
         ORDER BY updated_at DESC
         LIMIT 20`,
        [dealId]
      );

      return {
        ok: true,
        profile: {
          deal: deal.rows[0],
          participants: participants.rows,
          outbox: outbox.rows,
          payment_attempts: attempts.rows,
          audit: audit.rows,
          delivery: deliveries.rows,
          affiliate_attributions: attributions.rows,
          support_tickets: tickets.rows
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

  app.post("/api/admin/kyc/:subjectType/:subjectId/decision", async (req: any) => {
    const subjectType = String(req.params.subjectType || "").trim();
    const subjectId = String(req.params.subjectId || "").trim();
    const decision = String(req.body?.decision || "").trim();
    const adminNote = String(req.body?.admin_note || "").trim();
    if (!["seller", "affiliate"].includes(subjectType)) {
      const err: any = new Error("subject_type is invalid");
      err.statusCode = 400;
      throw err;
    }
    if (!["approve", "reject"].includes(decision)) {
      const err: any = new Error("decision is invalid");
      err.statusCode = 400;
      throw err;
    }

    await ensureProductSurfaces();
    return deps.withTx(async (c) => {
      const nextStatus = decision === "approve" ? "approved" : "rejected";
      if (subjectType === "seller") {
        const updated = await c.query(
          `UPDATE siton.seller_accounts
           SET verification_status = $2, admin_note = $3, updated_at = now()
           WHERE seller_id = $1
           RETURNING seller_id AS subject_id, verification_status AS status, admin_note`,
          [subjectId, nextStatus, adminNote]
        );
        if (!updated.rowCount) {
          const err: any = new Error("seller profile not found");
          err.statusCode = 404;
          throw err;
        }
        return { ok: true, subject_type: subjectType, result: updated.rows[0] };
      }

      requireUuid(subjectId, "subject_id");

      const updated = await c.query(
        `UPDATE siton.affiliate_accounts
         SET verification_status = $2,
             payout_status = CASE
               WHEN $2='verified' AND payout_details_masked <> '' THEN 'pending_review'
               WHEN $2='rejected' THEN 'hold'
               ELSE payout_status
             END,
             admin_note = $3,
             updated_at = now()
         WHERE affiliate_id = $1::uuid
         RETURNING affiliate_id::text AS subject_id, verification_status AS status, admin_note, payout_status`,
        [subjectId, decision === "approve" ? "verified" : "rejected", adminNote]
      );
      if (!updated.rowCount) {
        const err: any = new Error("affiliate profile not found");
        err.statusCode = 404;
        throw err;
      }
      return { ok: true, subject_type: subjectType, result: updated.rows[0] };
    });
  });

  app.post("/api/admin/support", async (req: any) => {
    await ensureProductSurfaces();
    const scopeType = String(req.body?.scope_type || "").trim();
    const scopeKey = String(req.body?.scope_key || "").trim();
    const title = String(req.body?.title || "").trim();
    const priority = String(req.body?.priority || "normal").trim();
    const summary = String(req.body?.summary || "").trim();
    if (!scopeType || !scopeKey || !title) {
      const err: any = new Error("scope_type, scope_key, and title are required");
      err.statusCode = 400;
      throw err;
    }
    if (!["deal", "participant", "affiliate", "seller", "system"].includes(scopeType)) {
      const err: any = new Error("support scope_type is invalid");
      err.statusCode = 400;
      throw err;
    }
    if (!["normal", "high"].includes(priority)) {
      const err: any = new Error("support priority is invalid");
      err.statusCode = 400;
      throw err;
    }

    return deps.withTx(async (c) => {
      const inserted = await c.query(
        `INSERT INTO siton.support_tickets (scope_type, scope_key, title, priority, summary)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING ticket_id, scope_type, scope_key, title, priority, status, summary, created_at`,
        [scopeType, scopeKey, title, priority, summary]
      );
      return { ok: true, ticket: inserted.rows[0] };
    });
  });

  app.post("/api/admin/support/:ticketId", async (req: any) => {
    await ensureProductSurfaces();
    const ticketId = String(req.params.ticketId || "");
    requireUuid(ticketId, "ticket_id");
    const status = String(req.body?.status || "").trim();
    const summary = String(req.body?.summary || "").trim();
    if (!["open", "investigating", "resolved"].includes(status)) {
      const err: any = new Error("support status is invalid");
      err.statusCode = 400;
      throw err;
    }

    return deps.withTx(async (c) => {
      const updated = await c.query(
        `UPDATE siton.support_tickets
         SET status = $2,
             summary = CASE WHEN $3 = '' THEN summary ELSE $3 END,
             updated_at = now()
         WHERE ticket_id = $1
         RETURNING ticket_id, status, summary, updated_at`,
        [ticketId, status, summary]
      );
      if (!updated.rowCount) {
        const err: any = new Error("support ticket not found");
        err.statusCode = 404;
        throw err;
      }
      return { ok: true, ticket: updated.rows[0] };
    });
  });

  app.post("/api/admin/affiliate-payouts/:affiliateId", async (req: any) => {
    await ensureProductSurfaces();
    const affiliateId = String(req.params.affiliateId || "");
    requireUuid(affiliateId, "affiliate_id");
    const payoutStatus = String(req.body?.payout_status || "").trim();
    if (!["pending_review", "approved", "paid", "hold"].includes(payoutStatus)) {
      const err: any = new Error("affiliate payout_status is invalid");
      err.statusCode = 400;
      throw err;
    }

    return deps.withTx(async (c) => {
      const current = await c.query(
        `SELECT affiliate_id, verification_status, payout_status, payout_details_masked
         FROM siton.affiliate_accounts
         WHERE affiliate_id = $1`,
        [affiliateId]
      );

      if (!current.rowCount) {
        const err: any = new Error("affiliate profile not found");
        err.statusCode = 404;
        throw err;
      }

      const commissionSummary = await c.query(
        `SELECT COALESCE(SUM(commission_amount),0) AS total_commission
         FROM siton.affiliate_attributions
         WHERE affiliate_id = $1
           AND payout_status IN ('pending','approved')`,
        [affiliateId]
      );

      const currentRow = current.rows[0] as any;
      const verificationStatus = String(currentRow.verification_status || "");
      const hasPayoutProfile = Boolean(String(currentRow.payout_details_masked || "").trim());
      const totalCommission = Number(commissionSummary.rows[0]?.total_commission || 0);

      if ((payoutStatus === "approved" || payoutStatus === "paid") && verificationStatus !== "verified") {
        const err: any = new Error("affiliate payout approval requires verified affiliate");
        err.statusCode = 409;
        throw err;
      }
      if ((payoutStatus === "approved" || payoutStatus === "paid") && !hasPayoutProfile) {
        const err: any = new Error("affiliate payout approval requires payout profile");
        err.statusCode = 409;
        throw err;
      }
      if ((payoutStatus === "approved" || payoutStatus === "paid") && totalCommission <= 0) {
        const err: any = new Error("affiliate payout approval requires pending commission");
        err.statusCode = 409;
        throw err;
      }

      const updated = await c.query(
        `UPDATE siton.affiliate_accounts
         SET payout_status = $2, updated_at = now()
         WHERE affiliate_id = $1
         RETURNING affiliate_id`,
        [affiliateId, payoutStatus]
      );

      if (payoutStatus === "approved" || payoutStatus === "paid") {
        await c.query(
          `UPDATE siton.affiliate_attributions
           SET payout_status = $2, updated_at = now()
           WHERE affiliate_id = $1
             AND payout_status IN ('pending','approved')`,
          [affiliateId, payoutStatus === "paid" ? "paid" : "approved"]
        );
      }

      return { ok: true, affiliate_id: affiliateId, payout_status: payoutStatus };
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
