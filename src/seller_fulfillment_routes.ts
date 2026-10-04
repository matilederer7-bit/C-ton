// SELLER FULFILLMENT — shipping, delivery handoff, pickup handoff, voucher and
// ticket exports, redemption and the seller deal Excel export.
//
// Lean Refactor: the eleven routes below were moved verbatim out of
// src/frontend_runtime.ts. Nothing about them changed: same methods and paths,
// same seller guard first (resolveRequiredSellerContext, then
// ensureSellerActionAllowed "operate" on the pickup rail), same ownership
// checks, same validation order, same SQL and transaction boundaries, same
// idempotent redemption, same CSV/Excel output, same status codes and response
// shapes. The runtime hands this module exactly the closures it used before
// (dependency injection); no guard or helper was copied. mockMoneyRuntime stays
// in the runtime because the buyer tracking route uses it too.
import type { FastifyInstance } from "fastify";
import ExcelJS from "exceljs";
import {
  ensureDealTypeTables,
  readVoucherTerms,
  readTicketTerms,
  decideFulfillmentIssuance,
  csvSafeCell
} from "./deal_types.js";
import {
  ensurePhysicalOrderCredential,
  findSellerOrderByCode,
  handoffPhysicalOrder,
  listDealPhysicalOrders,
  normalizeOrderCodeInput,
  normalizeSearchQuery,
  searchSellerPhysicalOrders,
  sellerOrderProjection,
  SELLER_NOT_READY_COPY
} from "./physical_fulfillment.js";
import { calculatePlatformFeeMoney } from "./platform_fee_money.js";
import type { SellerAction } from "./seller_enforcement.js";

type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

export type SellerFulfillmentRouteDeps = {
  withTx: WithTx;
  /** The runtime's required seller guard. Owns the denial response; returns the seller context or a falsy value. */
  resolveRequiredSellerContext: (req: any, reply: any, c: any, options?: { autoCreate?: boolean }) => Promise<any>;
  /** The runtime's seller-status enforcement. Owns the 403 response; returns false after sending it. */
  ensureSellerActionAllowed: (c: any, sellerId: string, action: SellerAction, reply: any) => Promise<boolean>;
  /** The runtime's uuid validator: throws a 400 error for a malformed id. */
  requireUuid: (value: string, fieldName: string) => void;
  /** The runtime's memoized product-surface schema check. */
  ensureProductSurfaces: () => Promise<unknown>;
  /** The runtime's mock-money flag (also used by buyer tracking, so it stays there). */
  mockMoneyRuntime: () => boolean;
};

export function registerSellerFulfillmentRoutes(app: FastifyInstance, deps: SellerFulfillmentRouteDeps) {
  const {
    resolveRequiredSellerContext,
    ensureSellerActionAllowed,
    requireUuid,
    ensureProductSurfaces,
    mockMoneyRuntime
  } = deps;

  app.get("/api/seller/deals/:dealId/shipping-export", async (req: any, reply: any) => {
    const dealId = String(req.params.dealId);
    await ensureProductSurfaces();

    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      requireUuid(dealId, "deal_id"); // after the guard: authorization precedes observation
      const sellerId = sellerContext.seller_id;

      const dealResult = await c.query(
        `SELECT deal_id, COALESCE(seller_id, $2) AS effective_seller_id, title, state, price_per_unit
         FROM siton.deals
         WHERE deal_id = $1`,
        [dealId, sellerId]
      );

      if (!dealResult.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }

      const deal = dealResult.rows[0] as any;

      // A deal owned by another seller answers EXACTLY like a deal that does not
      // exist. A 403-here/404-there split lets any authenticated seller enumerate
      // which deal ids are real, Drafts included, which are not public. Same
      // convention as the seller-authorized Draft buyer preview (P0.7 polish).
      if (String(deal.effective_seller_id) !== sellerId) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }

      if (String(deal.state) !== "Completed") {
        const err: any = new Error("deal is not completed");
        err.statusCode = 409;
        err.code = "deal_not_completed";
        throw err;
      }

      const participantsResult = await c.query(
        `SELECT
           p.participant_id,
           p.buyer_id,
           p.buyer_name,
           p.buyer_phone,
           p.buyer_email,
           p.qty,
           p.buyer_state,
           p.money_state,
           p.delivery_method_type,
           p.delivery_method_label,
           p.delivery_cost,
           p.delivery_address,
           p.delivery_city,
           p.delivery_notes,
           p.created_at
         FROM siton.participants p
         WHERE p.deal_id = $1
           AND (p.money_state IN ('ChargedSuccess', 'RecoveredCharge') OR p.buyer_state = 'DealCompleted')
         ORDER BY p.created_at ASC`,
        [dealId]
      );

      function csvCell(value: string | number | null | undefined): string {
        if (value === null || value === undefined) return "";
        const str = String(value);
        if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
          return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
      }

      const headers = [
        "deal_id",
        "deal_title",
        "participant_id",
        "buyer_id",
        "buyer_name",
        "buyer_phone",
        "buyer_email",
        "qty",
        "delivery_method",
        "delivery_method_label",
        "delivery_address",
        "delivery_city",
        "delivery_notes",
        "charged_amount",
        "created_at"
      ];

      const lines: string[] = [headers.join(",")];

      for (const row of participantsResult.rows as any[]) {
        const chargedAmount = (
          Number(deal.price_per_unit || 0) * Number(row.qty || 0) +
          Number(row.delivery_cost || 0)
        ).toFixed(2);

        lines.push(
          [
            deal.deal_id,
            deal.title,
            row.participant_id,
            row.buyer_id,
            row.buyer_name,
            row.buyer_phone,
            row.buyer_email,
            String(row.qty),
            String(row.delivery_method_label || row.delivery_method_type || ""),
            row.delivery_method_label,
            row.delivery_address,
            row.delivery_city,
            row.delivery_notes,
            chargedAmount,
            row.created_at ? new Date(row.created_at).toISOString() : ""
          ]
            .map(csvCell)
            .join(",")
        );
      }

      // UTF-8 BOM ensures Hebrew characters render correctly in Excel
      const csvContent = "﻿" + lines.join("\r\n");

      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="siton-shipping-${dealId}.csv"`)
        .send(csvContent);
    });
  });

  // ── Delivery Data Handoff (JSON) ─────────────────────────────────────────
  // Returns only eligible buyers (ChargedSuccess / RecoveredCharge) with their
  // delivery fields. No shipping status, tracking numbers, or payment refs.
  app.get("/api/seller/deals/:dealId/delivery-handoff", async (req: any, reply: any) => {
    const dealId = String(req.params.dealId);
    await ensureProductSurfaces();

    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      requireUuid(dealId, "deal_id"); // after the guard: authorization precedes observation
      const sellerId = sellerContext.seller_id;

      const dealResult = await c.query(
        `SELECT deal_id, COALESCE(seller_id, $2) AS effective_seller_id, title, state
         FROM siton.deals WHERE deal_id = $1`,
        [dealId, sellerId]
      );
      if (!dealResult.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }
      const deal = dealResult.rows[0] as any;
      // A deal owned by another seller answers EXACTLY like a deal that does not
      // exist. A 403-here/404-there split lets any authenticated seller enumerate
      // which deal ids are real, Drafts included, which are not public. Same
      // convention as the seller-authorized Draft buyer preview (P0.7 polish).
      if (String(deal.effective_seller_id) !== sellerId) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }
      if (String(deal.state) !== "Completed") {
        const err: any = new Error("delivery handoff requires a completed deal");
        err.statusCode = 409;
        err.code = "deal_not_completed";
        throw err;
      }

      const result = await c.query(
        `SELECT p.participant_id, p.buyer_id, p.buyer_name, p.buyer_phone, p.buyer_email,
                p.qty, p.delivery_method_type, p.delivery_method_label, p.delivery_cost,
                p.delivery_address, p.delivery_city, p.delivery_notes, p.created_at
         FROM siton.participants p
         WHERE p.deal_id = $1
           AND p.money_state IN ('ChargedSuccess','RecoveredCharge')
         ORDER BY p.created_at ASC`,
        [dealId]
      );

      return {
        deal_id: dealId,
        deal_title: String(deal.title),
        eligible_count: result.rowCount,
        disclaimer: "האספקה מתבצעת באחריות המוכר ומחוץ למערכת סיטון.",
        buyers: (result.rows as any[]).map((p) => ({
          participant_id: p.participant_id,
          buyer_id: p.buyer_id,
          buyer_name: p.buyer_name || null,
          buyer_phone: p.buyer_phone || null,
          buyer_email: p.buyer_email || null,
          qty: Number(p.qty || 0),
          delivery_method_type: p.delivery_method_type || null,
          delivery_method_label: p.delivery_method_label || null,
          delivery_address: p.delivery_address || null,
          delivery_city: p.delivery_city || null,
          delivery_notes: p.delivery_notes || null,
          joined_at: p.created_at ? new Date(p.created_at).toISOString() : null
        }))
      };
    });
  });

  // ── Delivery Data Handoff Excel Export ───────────────────────────────────
  // Lean sheet: only eligible buyers + delivery fields. No tracking, status,
  // payment provider refs, or internal audit data.
  app.get("/api/seller/deals/:dealId/delivery-handoff/export.xlsx", async (req: any, reply: any) => {
    const dealId = String(req.params.dealId);
    await ensureProductSurfaces();

    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      requireUuid(dealId, "deal_id"); // after the guard: authorization precedes observation
      const sellerId = sellerContext.seller_id;

      const dealResult = await c.query(
        `SELECT deal_id, COALESCE(seller_id, $2) AS effective_seller_id, title, state
         FROM siton.deals WHERE deal_id = $1`,
        [dealId, sellerId]
      );
      if (!dealResult.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }
      const deal = dealResult.rows[0] as any;
      // A deal owned by another seller answers EXACTLY like a deal that does not
      // exist. A 403-here/404-there split lets any authenticated seller enumerate
      // which deal ids are real, Drafts included, which are not public. Same
      // convention as the seller-authorized Draft buyer preview (P0.7 polish).
      if (String(deal.effective_seller_id) !== sellerId) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }
      if (String(deal.state) !== "Completed") {
        const err: any = new Error("delivery handoff requires a completed deal");
        err.statusCode = 409;
        err.code = "deal_not_completed";
        throw err;
      }

      const participantsResult = await c.query(
        `SELECT p.participant_id, p.buyer_id, p.buyer_name, p.buyer_phone, p.buyer_email,
                p.qty, p.delivery_method_type, p.delivery_method_label,
                p.delivery_address, p.delivery_city, p.delivery_notes, p.created_at
         FROM siton.participants p
         WHERE p.deal_id = $1
           AND p.money_state IN ('ChargedSuccess','RecoveredCharge')
         ORDER BY p.created_at ASC`,
        [dealId]
      );

      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      wb.creator = "Siton";
      wb.created = new Date();

      function safeTextDH(v: any) {
        const s = v == null ? "" : String(v);
        return /^[=+\-@]/.test(s) ? `'${s}` : s;
      }
      function fmtDateDH(v: any) {
        if (!v) return "";
        try { return new Date(v).toISOString().slice(0, 10); } catch { return ""; }
      }

      // LAUNCH SPRINT 3 — the order code + handoff state per settled order come
      // from the canonical fulfillment_units rows (physical only). Rows without
      // units yet show an empty code and "ממתין למסירה".
      const unitRows = await c.query(
        `SELECT participant_id, status, redeemed_at, metadata_jsonb->>'order_code' AS order_code
           FROM siton.fulfillment_units
          WHERE deal_id = $1 AND deal_type = 'physical_product'`,
        [dealId]
      );
      const fulfillmentByParticipant = new Map<string, { code: string; open: number; redeemed: number; redeemed_at: string }>();
      for (const u of unitRows.rows as any[]) {
        const key = String(u.participant_id);
        const entry = fulfillmentByParticipant.get(key) || { code: "", open: 0, redeemed: 0, redeemed_at: "" };
        if (u.order_code && !entry.code) entry.code = String(u.order_code);
        if (String(u.status) === "Redeemed") {
          entry.redeemed += 1;
          const at = u.redeemed_at ? new Date(u.redeemed_at).toISOString() : "";
          if (at > entry.redeemed_at) entry.redeemed_at = at;
        } else entry.open += 1;
        fulfillmentByParticipant.set(key, entry);
      }

      const ws = wb.addWorksheet("מסירת נתוני אספקה");
      ws.columns = [
        { header: "קוד הזמנה", key: "order_code", width: 16 },
        { header: "מזהה עסקה", key: "deal_id", width: 38 },
        { header: "שם עסקה", key: "deal_title", width: 30 },
        { header: "מזהה השתתפות", key: "participant_id", width: 38 },
        { header: "שם מקבל", key: "buyer_name", width: 22 },
        { header: "טלפון", key: "buyer_phone", width: 18 },
        { header: "אימייל", key: "buyer_email", width: 28 },
        { header: "כמות", key: "qty", width: 8 },
        { header: "אופן קבלה", key: "delivery_method", width: 20 },
        { header: "תווית אופן קבלה", key: "delivery_method_label", width: 24 },
        { header: "כתובת", key: "delivery_address", width: 32 },
        { header: "עיר", key: "delivery_city", width: 18 },
        { header: "הערת משלוח", key: "delivery_notes", width: 26 },
        { header: "מצב תשלום", key: "payment_status", width: 14 },
        { header: "מצב מסירה", key: "fulfillment_status", width: 16 },
        { header: "תאריך מסירה", key: "fulfilled_at", width: 22 },
        { header: "תאריך הצטרפות", key: "joined_at", width: 22 }
      ];

      const headerRow = ws.getRow(1);
      headerRow.font = { bold: true };
      headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9EAD3" } };
      headerRow.commit();

      for (const p of participantsResult.rows as any[]) {
        const f = fulfillmentByParticipant.get(String(p.participant_id));
        const handedOver = Boolean(f && f.open === 0 && f.redeemed > 0);
        ws.addRow([
          safeTextDH(f?.code || ""),
          safeTextDH(dealId),
          safeTextDH(deal.title),
          safeTextDH(p.participant_id),
          safeTextDH(p.buyer_name),
          safeTextDH(p.buyer_phone),
          safeTextDH(p.buyer_email),
          Number(p.qty || 0),
          safeTextDH(p.delivery_method_type),
          safeTextDH(p.delivery_method_label),
          safeTextDH(p.delivery_address),
          safeTextDH(p.delivery_city),
          safeTextDH(p.delivery_notes),
          "שולם",
          handedOver ? "נמסר" : "ממתין למסירה",
          handedOver ? fmtDateDH(f?.redeemed_at) : "",
          fmtDateDH(p.created_at)
        ]);
      }

      const wsNotes = wb.addWorksheet("הסבר");
      wsNotes.addRow(["מסירת נתוני אספקה — סיטון"]);
      wsNotes.addRow([""]);
      wsNotes.addRow(["סיטון מוסרת כאן את פרטי הקונים שחויבו בפועל וזכאים למוצר."]);
      wsNotes.addRow(["האספקה עצמה מתבצעת באחריות המוכר בלבד ומחוץ למערכת סיטון."]);
      wsNotes.addRow(["קוד ההזמנה הוא מזהה לזיהוי הקונה בעת המסירה; מצב המסירה מתעדכן כשהמוכר מאשר מסירה בסיטון."]);
      wsNotes.addRow([""]);
      wsNotes.addRow(["הקובץ לא כולל מספרי מעקב של חברות שילוח או נתוני סליקה פנימיים."]);
      wsNotes.addRow([`הופק: ${new Date().toISOString().slice(0, 10)}`]);

      const buf = await wb.xlsx.writeBuffer();
      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="siton-delivery-handoff-${dealId}.xlsx"`)
        .send(buf);
    });
  });

  // ── LAUNCH SPRINT 3 — physical pickup credential + seller handoff ────────
  // Extends the canonical fulfillment_units rail (docs/PHYSICAL_FULFILLMENT_PICKUP.md).
  // Every route: seller guard FIRST (authorization precedes observation), then
  // input parsing. An unknown code, another seller's code and a non-physical
  // unit all answer ONE identical 404 (no enumeration). Money is never touched.
  function pickupCodeNotFound(reply: any) {
    return reply.code(404).send({ ok: false, error: "pickup code not found", code: "pickup_code_not_found", message: "הקוד אינו תקין" });
  }
  function handoffActorRef(sellerContext: any) {
    return `seller:${String(sellerContext.seller_id)}:${String(sellerContext.context_source || "session")}`;
  }

  // Resolve a scanned / typed order code inside the seller's own deals.
  app.get("/api/seller/fulfillment/resolve", async (req: any, reply: any) => {
    await ensureDealTypeTables(deps.withTx);
    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      if (!(await ensureSellerActionAllowed(c, sellerContext.seller_id, "operate", reply))) return reply;
      const digits = normalizeOrderCodeInput(req.query?.code); // after the guard
      if (!digits) return pickupCodeNotFound(reply);
      const found = await findSellerOrderByCode(c, { sellerId: sellerContext.seller_id, digits });
      if (found.ambiguous) {
        return reply.code(409).send({ ok: false, error: "pickup code ambiguous", code: "pickup_code_ambiguous", message: "הקוד אינו חד-משמעי — חפשו לפי שם או טלפון" });
      }
      if (!found.order) return pickupCodeNotFound(reply);
      const order = await ensurePhysicalOrderCredential(c, found.order);
      return { ok: true, order: sellerOrderProjection(order, { revealPhone: true }), mock_money: mockMoneyRuntime() };
    });
  });

  // Fallback identification: phone / buyer name across the seller's completed
  // physical deals. A code typed here is routed to the code resolver.
  app.get("/api/seller/fulfillment/search", async (req: any, reply: any) => {
    await ensureDealTypeTables(deps.withTx);
    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      if (!(await ensureSellerActionAllowed(c, sellerContext.seller_id, "operate", reply))) return reply;
      const raw = req.query?.q; // after the guard
      const digits = normalizeOrderCodeInput(raw);
      if (digits) {
        const found = await findSellerOrderByCode(c, { sellerId: sellerContext.seller_id, digits });
        const order = found.order ? await ensurePhysicalOrderCredential(c, found.order) : null;
        return {
          ok: true,
          mode: "code",
          ambiguous: found.ambiguous,
          orders: order ? [sellerOrderProjection(order, { revealPhone: true })] : [],
          mock_money: mockMoneyRuntime()
        };
      }
      const query = normalizeSearchQuery(raw);
      if (!query) return { ok: true, mode: "search", ambiguous: false, orders: [], mock_money: mockMoneyRuntime() };
      const orders = await searchSellerPhysicalOrders(c, { sellerId: sellerContext.seller_id, query, limit: 20 });
      return {
        ok: true,
        mode: "search",
        ambiguous: false,
        orders: orders.map((order) => sellerOrderProjection(order, { revealPhone: true })),
        mock_money: mockMoneyRuntime()
      };
    });
  });

  // The handoff mutation: whole order, exactly once, seller-owned, audited.
  // The reply is sent only AFTER withTx has committed.
  app.post("/api/seller/fulfillment/handoff", async (req: any, reply: any) => {
    await ensureDealTypeTables(deps.withTx);
    const result = await deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return null;
      if (!(await ensureSellerActionAllowed(c, sellerContext.seller_id, "operate", reply))) return null;
      const body = req.body && typeof req.body === "object" ? req.body : {}; // after the guard
      const participantId = String(body.participant_id || "").trim();
      requireUuid(participantId, "participant_id");
      const orderCodeDigits = body.order_code === undefined || body.order_code === null || body.order_code === ""
        ? null
        : normalizeOrderCodeInput(body.order_code);
      if (body.order_code && !orderCodeDigits) {
        return { status: 404, body: { ok: false, error: "pickup code not found", code: "pickup_code_not_found", message: "הקוד אינו תקין" } };
      }
      const expectedQtyRaw = body.expected_qty;
      const expectedQty = expectedQtyRaw === undefined || expectedQtyRaw === null || expectedQtyRaw === "" ? null : Number(expectedQtyRaw);
      if (expectedQty !== null && (!Number.isInteger(expectedQty) || expectedQty < 1)) {
        return { status: 400, body: { ok: false, error: "expected_qty invalid", code: "fulfillment_expected_qty_invalid" } };
      }
      const sourceRaw = String(body.source || "").trim();
      const source = ["scan", "manual", "search", "list"].includes(sourceRaw) ? sourceRaw : "unknown";
      const idempotencyKey = String(req.headers?.["idempotency-key"] || body.idempotency_key || `handoff:${participantId}`).trim().slice(0, 200);
      const requestId = String(req.headers?.["x-request-id"] || req.id || `handoff:${participantId}:${Date.now()}`).slice(0, 200);
      const outcome = await handoffPhysicalOrder(c, {
        sellerId: sellerContext.seller_id,
        participantId,
        orderCodeDigits,
        expectedQty,
        source,
        actorRef: handoffActorRef(sellerContext),
        requestId,
        idempotencyKey
      });
      if (!outcome.ok) {
        const failure = outcome.failure;
        if (failure.kind === "not_found" || failure.kind === "ambiguous") {
          return { status: 404, body: { ok: false, error: "pickup order not found", code: "pickup_code_not_found", message: "הקוד אינו תקין" } };
        }
        if (failure.kind === "qty_mismatch") {
          return {
            status: 409,
            body: {
              ok: false,
              error: "quantity changed",
              code: "fulfillment_qty_mismatch",
              message: `הכמות בהזמנה היא ${failure.actual} יחידות (ולא ${failure.expected}). בדקו שוב לפני המסירה.`,
              order: sellerOrderProjection(failure.order, { revealPhone: true })
            }
          };
        }
        return {
          status: 409,
          body: {
            ok: false,
            error: "order not ready for handoff",
            code: "fulfillment_not_ready",
            reason: failure.reason,
            message: SELLER_NOT_READY_COPY[failure.reason],
            order: sellerOrderProjection(failure.order, { revealPhone: true })
          }
        };
      }
      return {
        status: 200,
        body: {
          ok: true,
          idempotent: outcome.idempotent,
          replay: outcome.replay,
          already_fulfilled: outcome.idempotent,
          units_marked: outcome.units_marked,
          fulfilled_at: outcome.fulfilled_at,
          message: outcome.idempotent ? "כבר סומן כנמסר" : "המסירה נרשמה",
          order: sellerOrderProjection(outcome.order, { revealPhone: true }),
          mock_money: mockMoneyRuntime()
        }
      };
    });
    if (!result) return reply;
    return reply.code(result.status).send(result.body);
  });

  // Operational list for ONE completed physical deal: every settled order with
  // its order code, buyer, phone, quantity, method, payment eligibility and
  // fulfillment state. Filters: status=pending|fulfilled|all, q=code|phone|name.
  app.get("/api/seller/deals/:dealId/fulfillment", async (req: any, reply: any) => {
    const dealId = String(req.params.dealId || "");
    await ensureDealTypeTables(deps.withTx);
    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      requireUuid(dealId, "deal_id"); // after the guard: authorization precedes observation
      const sellerId = sellerContext.seller_id;
      const dealResult = await c.query(
        `SELECT deal_id, COALESCE(seller_id, $2) AS effective_seller_id, title, state, deal_type
         FROM siton.deals WHERE deal_id = $1`,
        [dealId, sellerId]
      );
      // Another seller's deal answers exactly like a deal that does not exist.
      if (!dealResult.rowCount || String(dealResult.rows[0].effective_seller_id) !== sellerId) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }
      const deal = dealResult.rows[0] as any;
      if (String(deal.deal_type || "physical_product") !== "physical_product") {
        const err: any = new Error("fulfillment list is for physical deals");
        err.statusCode = 409;
        err.code = "fulfillment_not_physical";
        throw err;
      }
      if (String(deal.state) !== "Completed") {
        const err: any = new Error("fulfillment requires a completed deal");
        err.statusCode = 409;
        err.code = "deal_not_completed";
        throw err;
      }
      const orders = (await listDealPhysicalOrders(c, { sellerId, dealId }))
        .map((order) => sellerOrderProjection(order, { revealPhone: true }));
      const statusFilter = ["pending", "fulfilled", "all"].includes(String(req.query?.status || "")) ? String(req.query.status) : "all";
      const qDigits = normalizeOrderCodeInput(req.query?.q);
      const qSearch = qDigits ? null : normalizeSearchQuery(req.query?.q);
      const filtered = orders.filter((order) => {
        if (statusFilter === "pending" && order.fulfillment_status !== "awaiting") return false;
        if (statusFilter === "fulfilled" && order.fulfillment_status !== "fulfilled") return false;
        if (qDigits) return order.order_code === `CT-${qDigits.slice(0, 4)}-${qDigits.slice(4)}`;
        if (qSearch) {
          const phoneDigits = String(order.buyer_phone || "").replace(/\D/g, "");
          const name = String(order.buyer_name || "").toLowerCase();
          const codeDigits = String(order.order_code || "").replace(/\D/g, "");
          if (qSearch.digits && (phoneDigits.includes(qSearch.digits) || codeDigits.includes(qSearch.digits))) return true;
          if (qSearch.text && name.includes(qSearch.text.toLowerCase())) return true;
          return false;
        }
        return true;
      });
      return {
        ok: true,
        deal: { deal_id: dealId, title: String(deal.title || ""), state: String(deal.state) },
        counts: {
          awaiting: orders.filter((order) => order.fulfillment_status === "awaiting").length,
          fulfilled: orders.filter((order) => order.fulfillment_status === "fulfilled").length,
          blocked: orders.filter((order) => order.fulfillment_status === "blocked").length,
          total: orders.length
        },
        filter: { status: statusFilter, q: String(req.query?.q || "").slice(0, 80) },
        orders: filtered,
        disclaimer: "האספקה מתבצעת באחריות המוכר ומחוץ למערכת סיטון.",
        mock_money: mockMoneyRuntime()
      };
    });
  });

  // ── Voucher Fulfillment Export (CSV) ─────────────────────────────────────
  // Lists eligible buyers + voucher fulfillment unit metadata. Plaintext
  // voucher codes are NEVER persisted (we keep only SHA-256 hash + last4),
  // so the export shows fulfillment_unit_id and last4 only — by design, not
  // by accident. Sellers redeem via POST /api/seller/fulfillment/:unitId/redeem.
  app.get("/api/seller/deals/:dealId/voucher-export", async (req: any, reply: any) => {
    const dealId = String(req.params.dealId);
    await ensureProductSurfaces();
    await ensureDealTypeTables(deps.withTx);

    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      requireUuid(dealId, "deal_id"); // after the guard: authorization precedes observation
      const sellerId = sellerContext.seller_id;

      const dealResult = await c.query(
        `SELECT deal_id, COALESCE(seller_id, $2) AS effective_seller_id, title, state, deal_type
           FROM siton.deals WHERE deal_id = $1`,
        [dealId, sellerId]
      );
      if (!dealResult.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }
      const deal = dealResult.rows[0] as any;
      // A deal owned by another seller answers EXACTLY like a deal that does not
      // exist. A 403-here/404-there split lets any authenticated seller enumerate
      // which deal ids are real, Drafts included, which are not public. Same
      // convention as the seller-authorized Draft buyer preview (P0.7 polish).
      if (String(deal.effective_seller_id) !== sellerId) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }
      if (String(deal.deal_type) !== "voucher") {
        const err: any = new Error("voucher export is only available for voucher deals");
        err.statusCode = 409;
        err.code = "deal_type_not_voucher";
        throw err;
      }
      if (String(deal.state) !== "Completed") {
        const err: any = new Error("voucher export requires a completed deal");
        err.statusCode = 409;
        err.code = "deal_not_completed";
        throw err;
      }

      const voucherTermsRow = await readVoucherTerms(c, dealId);
      const result = await c.query(
        `SELECT p.participant_id, p.buyer_id, p.buyer_name, p.buyer_phone, p.buyer_email,
                p.qty, p.money_state, p.buyer_state,
                f.fulfillment_unit_id, f.unit_index, f.code_display_last4,
                f.status AS fulfillment_status, f.issued_at, f.redeemed_at, f.expires_at
           FROM siton.participants p
           LEFT JOIN siton.fulfillment_units f
                  ON f.participant_id = p.participant_id
           WHERE p.deal_id = $1
             AND p.money_state IN ('ChargedSuccess','RecoveredCharge')
             AND p.buyer_state = 'DealCompleted'
           ORDER BY p.created_at ASC, f.unit_index ASC`,
        [dealId]
      );

      const headers = [
        "deal_id",
        "deal_title",
        "participant_id",
        "buyer_name",
        "buyer_phone",
        "buyer_email",
        "qty",
        "fulfillment_unit_id",
        "unit_index",
        "voucher_code_last4",
        "face_value_amount",
        "currency",
        "valid_from",
        "valid_until",
        "fulfillment_status",
        "issued_at",
        "redeemed_at",
        "expires_at"
      ];
      const lines: string[] = [headers.join(",")];
      for (const row of result.rows as any[]) {
        lines.push(
          [
            deal.deal_id,
            deal.title,
            row.participant_id,
            row.buyer_name,
            row.buyer_phone,
            row.buyer_email,
            String(row.qty),
            row.fulfillment_unit_id || "",
            row.unit_index !== null && row.unit_index !== undefined ? String(row.unit_index) : "",
            row.code_display_last4 || "",
            voucherTermsRow ? Number(voucherTermsRow.face_value_amount).toFixed(2) : "",
            voucherTermsRow?.currency || "",
            voucherTermsRow?.valid_from ? new Date(voucherTermsRow.valid_from).toISOString() : "",
            voucherTermsRow?.valid_until ? new Date(voucherTermsRow.valid_until).toISOString() : "",
            row.fulfillment_status || "",
            row.issued_at ? new Date(row.issued_at).toISOString() : "",
            row.redeemed_at ? new Date(row.redeemed_at).toISOString() : "",
            row.expires_at ? new Date(row.expires_at).toISOString() : ""
          ]
            .map(csvSafeCell)
            .join(",")
        );
      }
      const csvContent = "﻿" + lines.join("\r\n");
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="siton-voucher-${dealId}.csv"`)
        .send(csvContent);
    });
  });

  // ── Ticket Attendee Export (CSV) ─────────────────────────────────────────
  app.get("/api/seller/deals/:dealId/ticket-export", async (req: any, reply: any) => {
    const dealId = String(req.params.dealId);
    await ensureProductSurfaces();
    await ensureDealTypeTables(deps.withTx);

    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      requireUuid(dealId, "deal_id"); // after the guard: authorization precedes observation
      const sellerId = sellerContext.seller_id;

      const dealResult = await c.query(
        `SELECT deal_id, COALESCE(seller_id, $2) AS effective_seller_id, title, state, deal_type
           FROM siton.deals WHERE deal_id = $1`,
        [dealId, sellerId]
      );
      if (!dealResult.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }
      const deal = dealResult.rows[0] as any;
      // A deal owned by another seller answers EXACTLY like a deal that does not
      // exist. A 403-here/404-there split lets any authenticated seller enumerate
      // which deal ids are real, Drafts included, which are not public. Same
      // convention as the seller-authorized Draft buyer preview (P0.7 polish).
      if (String(deal.effective_seller_id) !== sellerId) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }
      if (String(deal.deal_type) !== "ticket") {
        const err: any = new Error("ticket export is only available for ticket deals");
        err.statusCode = 409;
        err.code = "deal_type_not_ticket";
        throw err;
      }
      if (String(deal.state) !== "Completed") {
        const err: any = new Error("ticket export requires a completed deal");
        err.statusCode = 409;
        err.code = "deal_not_completed";
        throw err;
      }

      const ticketTermsRow = await readTicketTerms(c, dealId);
      const result = await c.query(
        `SELECT p.participant_id, p.buyer_id, p.buyer_name, p.buyer_phone, p.buyer_email,
                p.qty, p.money_state, p.buyer_state,
                f.fulfillment_unit_id, f.unit_index, f.code_display_last4,
                f.status AS fulfillment_status, f.issued_at, f.redeemed_at
           FROM siton.participants p
           LEFT JOIN siton.fulfillment_units f
                  ON f.participant_id = p.participant_id
           WHERE p.deal_id = $1
             AND p.money_state IN ('ChargedSuccess','RecoveredCharge')
             AND p.buyer_state = 'DealCompleted'
           ORDER BY p.created_at ASC, f.unit_index ASC`,
        [dealId]
      );

      const headers = [
        "deal_id",
        "deal_title",
        "participant_id",
        "attendee_name",
        "attendee_phone",
        "attendee_email",
        "qty",
        "fulfillment_unit_id",
        "unit_index",
        "ticket_code_last4",
        "event_name",
        "event_starts_at",
        "venue_name",
        "venue_city",
        "ticket_type",
        "fulfillment_status",
        "issued_at",
        "checked_in_at"
      ];
      const lines: string[] = [headers.join(",")];
      for (const row of result.rows as any[]) {
        lines.push(
          [
            deal.deal_id,
            deal.title,
            row.participant_id,
            row.buyer_name,
            row.buyer_phone,
            row.buyer_email,
            String(row.qty),
            row.fulfillment_unit_id || "",
            row.unit_index !== null && row.unit_index !== undefined ? String(row.unit_index) : "",
            row.code_display_last4 || "",
            ticketTermsRow?.event_name || "",
            ticketTermsRow?.event_starts_at ? new Date(ticketTermsRow.event_starts_at).toISOString() : "",
            ticketTermsRow?.venue_name || "",
            ticketTermsRow?.venue_city || "",
            ticketTermsRow?.ticket_type || "",
            row.fulfillment_status || "",
            row.issued_at ? new Date(row.issued_at).toISOString() : "",
            row.redeemed_at ? new Date(row.redeemed_at).toISOString() : ""
          ]
            .map(csvSafeCell)
            .join(",")
        );
      }
      const csvContent = "﻿" + lines.join("\r\n");
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="siton-tickets-${dealId}.csv"`)
        .send(csvContent);
    });
  });

  // ── Seller Redemption / Check-in Foundation ──────────────────────────────
  // Marks a fulfillment_unit as Redeemed. Strict guarantees:
  //   • Seller ownership: caller must own the deal.
  //   • Unit must already be Issued or Sent (cannot redeem Pending/Failed).
  //   • Idempotent on already-Redeemed units (returns ok=true, idempotent=true).
  //   • Money/state machine and refund policy are not touched.
  app.post("/api/seller/fulfillment/:unitId/redeem", async (req: any, reply: any) => {
    const unitId = String(req.params.unitId || "");
    await ensureDealTypeTables(deps.withTx);

    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      requireUuid(unitId, "fulfillment_unit_id"); // after the guard: authorization precedes observation
      const sellerId = sellerContext.seller_id;

      const lookup = await c.query(
        `SELECT f.fulfillment_unit_id, f.deal_id, f.participant_id, f.status,
                f.fulfillment_kind, f.deal_type,
                COALESCE(d.seller_id, '') AS seller_id, d.state AS deal_state, p.buyer_state, p.money_state
           FROM siton.fulfillment_units f
           JOIN siton.deals d ON d.deal_id = f.deal_id
           JOIN siton.participants p ON p.participant_id = f.participant_id
          WHERE f.fulfillment_unit_id = $1
          FOR UPDATE`,
        [unitId]
      );
      if (!lookup.rowCount) {
        const err: any = new Error("fulfillment unit not found");
        err.statusCode = 404;
        err.code = "fulfillment_unit_not_found";
        throw err;
      }
      const unit = lookup.rows[0] as any;
      if (String(unit.seller_id) !== sellerId) {
        const err: any = new Error("seller does not own this fulfillment unit");
        err.statusCode = 403;
        err.code = "fulfillment_unit_forbidden";
        throw err;
      }
      if (String(unit.deal_state) !== "Completed") {
        const err: any = new Error("cannot redeem before deal is Completed");
        err.statusCode = 409;
        err.code = "deal_not_completed";
        throw err;
      }
      if (!decideFulfillmentIssuance({ dealState: unit.deal_state, buyerState: unit.buyer_state, moneyState: unit.money_state }).shouldIssue) {
        throw Object.assign(new Error("fulfillment_unit_not_entitled"), { statusCode: 409, code: "fulfillment_unit_not_entitled" });
      }
      if (String(unit.status) === "Redeemed") {
        return {
          ok: true,
          idempotent: true,
          fulfillment_unit_id: unit.fulfillment_unit_id,
          status: "Redeemed"
        };
      }
      if (!["Issued", "Sent"].includes(String(unit.status))) {
        const err: any = new Error(`cannot redeem unit in status ${unit.status}`);
        err.statusCode = 409;
        err.code = "fulfillment_unit_not_redeemable";
        throw err;
      }
      const updated = await c.query(
        `UPDATE siton.fulfillment_units
            SET status = 'Redeemed',
                redeemed_at = now(),
                updated_at = now()
          WHERE fulfillment_unit_id = $1
            AND status IN ('Issued','Sent')
          RETURNING fulfillment_unit_id, status, redeemed_at`,
        [unitId]
      );
      if (!updated.rowCount) {
        const err: any = new Error("redemption update lost a race");
        err.statusCode = 409;
        err.code = "fulfillment_unit_race";
        throw err;
      }
      return {
        ok: true,
        idempotent: false,
        fulfillment_unit_id: updated.rows[0].fulfillment_unit_id,
        status: updated.rows[0].status,
        redeemed_at: updated.rows[0].redeemed_at
          ? new Date(updated.rows[0].redeemed_at).toISOString()
          : null
      };
    });
  });

  // ── Seller Deal Excel Export ─────────────────────────────────────────────
  app.get("/api/seller/deals/:dealId/export.xlsx", async (req: any, reply: any) => {
    const dealId = String(req.params.dealId);
    await ensureProductSurfaces();

    return deps.withTx(async (c) => {
      const sellerContext = await resolveRequiredSellerContext(req, reply, c, { autoCreate: true });
      if (!sellerContext) return reply;
      requireUuid(dealId, "deal_id"); // after the guard: authorization precedes observation
      const sellerId = sellerContext.seller_id;

      const dealResult = await c.query(
        `SELECT deal_id, COALESCE(seller_id, $2) AS effective_seller_id, title, state,
                price_per_unit, min_units, max_units, threshold_units,
                deadline, published_at, created_at, completion_window_until
         FROM siton.deals WHERE deal_id = $1`,
        [dealId, sellerId]
      );

      if (!dealResult.rowCount) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }
      const deal = dealResult.rows[0] as any;

      // A deal owned by another seller answers EXACTLY like a deal that does not
      // exist. A 403-here/404-there split lets any authenticated seller enumerate
      // which deal ids are real, Drafts included, which are not public. Same
      // convention as the seller-authorized Draft buyer preview (P0.7 polish).
      if (String(deal.effective_seller_id) !== sellerId) {
        const err: any = new Error("deal not found");
        err.statusCode = 404;
        throw err;
      }

      if (String(deal.state) !== "Completed") {
        const err: any = new Error("deal is not completed");
        err.statusCode = 409;
        err.code = "deal_not_completed";
        throw err;
      }

      // All participants
      const allParticipantsResult = await c.query(
        `SELECT p.participant_id, p.buyer_id, p.buyer_name, p.buyer_phone, p.buyer_email,
                p.qty, p.buyer_state, p.money_state,
                p.delivery_method_type, p.delivery_method_label, p.delivery_cost,
                p.delivery_address, p.delivery_city, p.delivery_notes,
                p.created_at, p.updated_at
         FROM siton.participants p
         WHERE p.deal_id = $1
         ORDER BY p.created_at ASC`,
        [dealId]
      );
      const allParticipants = allParticipantsResult.rows as any[];

      const pricePerUnit = Number(deal.price_per_unit || 0);

      function isEligible(p: any): boolean {
        return (
          p.money_state === "ChargedSuccess" ||
          p.money_state === "RecoveredCharge" ||
          p.buyer_state === "DealCompleted"
        );
      }

      const eligibleParticipants = allParticipants.filter(isEligible);
      const droppedCount = allParticipants.filter((p) => p.buyer_state === "Dropped").length;

      // Row-level money for each eligible participant
      function rowMoney(p: any) {
        const gross = (pricePerUnit * Number(p.qty || 0)) + Number(p.delivery_cost || 0);
        return calculatePlatformFeeMoney({ grossAmount: gross });
      }

      // Deal-level money totals
      let dealGross = 0;
      let dealProductsTotal = 0;
      let dealDeliveryTotal = 0;
      let dealFinalUnits = 0;
      for (const p of eligibleParticipants) {
        const qty = Number(p.qty || 0);
        const delivery = Number(p.delivery_cost || 0);
        dealGross += (pricePerUnit * qty) + delivery;
        dealProductsTotal += pricePerUnit * qty;
        dealDeliveryTotal += delivery;
        dealFinalUnits += qty;
      }
      const dealMoney = calculatePlatformFeeMoney({ grossAmount: dealGross });

      // Attribution data
      const attributionResult = await c.query(
        `SELECT aa.share_code, af.display_name AS affiliate_name,
                COUNT(aa.participant_id)::int AS joins_attributed,
                COALESCE(SUM(p.qty), 0) AS units_attributed
         FROM siton.affiliate_attributions aa
         JOIN siton.affiliate_accounts af ON af.affiliate_id = aa.affiliate_id
         LEFT JOIN siton.participants p ON p.participant_id = aa.participant_id
         WHERE aa.deal_id = $1
         GROUP BY aa.share_code, af.display_name
         ORDER BY joins_attributed DESC`,
        [dealId]
      );
      const attributions = attributionResult.rows as any[];

      // ── ExcelJS workbook ────────────────────────────────────────────────────

      function safeText(val: string | number | null | undefined): string {
        if (val === null || val === undefined) return "";
        const s = String(val);
        // Prevent formula injection
        if (/^[=\-+@*]/.test(s)) return "'" + s;
        return s;
      }

      function fmtDate(val: string | Date | null | undefined): string {
        if (!val) return "";
        try { return new Date(val as string).toISOString().replace("T", " ").slice(0, 19); }
        catch { return ""; }
      }

      function applySheetStyle(ws: ExcelJS.Worksheet, colCount: number) {
        ws.views = [{ state: "frozen", ySplit: 1 }];
        ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: colCount } };
        ws.getRow(1).font = { bold: true };
      }

      const wb = new ExcelJS.Workbook();
      wb.creator = "Siton";
      wb.created = new Date();

      // ── Sheet 1: Deal Summary ───────────────────────────────────────────────
      const ws1 = wb.addWorksheet("Deal Summary");
      ws1.columns = [
        { header: "Field", key: "field", width: 32 },
        { header: "Value", key: "value", width: 40 }
      ];
      applySheetStyle(ws1, 2);
      const summaryRows: [string, string | number][] = [
        ["deal_id", safeText(deal.deal_id)],
        ["deal_title", safeText(deal.title)],
        ["seller_id", safeText(sellerId)],
        ["deal_state", safeText(deal.state)],
        ["currency", "ILS"],
        ["created_at", fmtDate(deal.created_at)],
        ["published_at", fmtDate(deal.published_at)],
        ["deadline", fmtDate(deal.deadline)],
        ["min_units", Number(deal.min_units || 0)],
        ["max_units", Number(deal.max_units || 0)],
        ["threshold_units", Number(deal.threshold_units || 0)],
        ["final_units_charged", dealFinalUnits],
        ["total_participants", allParticipants.length],
        ["eligible_buyers_count", eligibleParticipants.length],
        ["dropped_buyers_count", droppedCount],
        ["gross_collected_total", dealGross],
        ["products_total", dealProductsTotal],
        ["delivery_total", dealDeliveryTotal],
        ["platform_fee_base_amount", dealMoney.platform_fee_base_amount],
        ["platform_fee_vat_amount", dealMoney.platform_fee_vat_amount],
        ["platform_fee_total_amount", dealMoney.platform_fee_total_amount],
        ["seller_net_amount", dealMoney.seller_net_amount]
      ];
      for (const [field, value] of summaryRows) {
        const row = ws1.addRow([field, value]);
        if (typeof value === "number") {
          row.getCell(2).numFmt = "#,##0.00";
        }
      }

      // ── Sheet 2: Eligible Buyers ────────────────────────────────────────────
      const ws2 = wb.addWorksheet("Eligible Buyers");
      ws2.columns = [
        { header: "deal_id", key: "deal_id", width: 38 },
        { header: "participant_id", key: "participant_id", width: 38 },
        { header: "buyer_id", key: "buyer_id", width: 18 },
        { header: "buyer_name", key: "buyer_name", width: 20 },
        { header: "buyer_phone", key: "buyer_phone", width: 18 },
        { header: "buyer_email", key: "buyer_email", width: 26 },
        { header: "qty", key: "qty", width: 8 },
        { header: "unit_price", key: "unit_price", width: 12 },
        { header: "products_amount", key: "products_amount", width: 16 },
        { header: "delivery_method", key: "delivery_method", width: 20 },
        { header: "delivery_method_label", key: "delivery_method_label", width: 24 },
        { header: "delivery_cost", key: "delivery_cost", width: 14 },
        { header: "delivery_address", key: "delivery_address", width: 30 },
        { header: "delivery_city", key: "delivery_city", width: 18 },
        { header: "delivery_notes", key: "delivery_notes", width: 24 },
        { header: "row_gross_amount", key: "row_gross_amount", width: 16 },
        { header: "row_platform_fee_base_amount", key: "row_platform_fee_base_amount", width: 26 },
        { header: "row_platform_fee_vat_amount", key: "row_platform_fee_vat_amount", width: 26 },
        { header: "row_platform_fee_total_amount", key: "row_platform_fee_total_amount", width: 28 },
        { header: "row_seller_net_amount", key: "row_seller_net_amount", width: 22 },
        { header: "buyer_state", key: "buyer_state", width: 18 },
        { header: "money_state", key: "money_state", width: 18 },
        { header: "joined_at", key: "joined_at", width: 22 }
      ];
      applySheetStyle(ws2, ws2.columns.length);
      const moneyColsWs2 = [8, 9, 12, 16, 17, 18, 19, 20]; // 1-based
      for (const p of eligibleParticipants) {
        const qty = Number(p.qty || 0);
        const productsAmt = pricePerUnit * qty;
        const fm = rowMoney(p);
        const dataRow = ws2.addRow([
          safeText(deal.deal_id),
          safeText(p.participant_id),
          safeText(p.buyer_id),
          safeText(p.buyer_name),
          safeText(p.buyer_phone),
          safeText(p.buyer_email),
          qty,
          pricePerUnit,
          productsAmt,
          safeText(p.delivery_method_type),
          safeText(p.delivery_method_label),
          Number(p.delivery_cost || 0),
          safeText(p.delivery_address),
          safeText(p.delivery_city),
          safeText(p.delivery_notes),
          fm.gross_amount,
          fm.platform_fee_base_amount,
          fm.platform_fee_vat_amount,
          fm.platform_fee_total_amount,
          fm.seller_net_amount,
          safeText(p.buyer_state),
          safeText(p.money_state),
          fmtDate(p.created_at)
        ]);
        for (const col of moneyColsWs2) {
          dataRow.getCell(col).numFmt = "#,##0.00";
        }
      }

      // ── Sheet 3: All Participants ───────────────────────────────────────────
      const ws3 = wb.addWorksheet("All Participants");
      ws3.columns = [
        { header: "deal_id", key: "deal_id", width: 38 },
        { header: "participant_id", key: "participant_id", width: 38 },
        { header: "buyer_id", key: "buyer_id", width: 18 },
        { header: "buyer_name", key: "buyer_name", width: 20 },
        { header: "buyer_phone", key: "buyer_phone", width: 18 },
        { header: "buyer_email", key: "buyer_email", width: 26 },
        { header: "qty", key: "qty", width: 8 },
        { header: "delivery_method", key: "delivery_method", width: 20 },
        { header: "delivery_method_label", key: "delivery_method_label", width: 24 },
        { header: "delivery_address", key: "delivery_address", width: 30 },
        { header: "delivery_city", key: "delivery_city", width: 18 },
        { header: "buyer_state", key: "buyer_state", width: 18 },
        { header: "money_state", key: "money_state", width: 18 },
        { header: "is_eligible_for_fulfillment", key: "is_eligible_for_fulfillment", width: 26 },
        { header: "is_charged_successfully", key: "is_charged_successfully", width: 24 },
        { header: "is_dropped", key: "is_dropped", width: 12 },
        { header: "created_at", key: "created_at", width: 22 },
        { header: "updated_at", key: "updated_at", width: 22 }
      ];
      applySheetStyle(ws3, ws3.columns.length);
      for (const p of allParticipants) {
        ws3.addRow([
          safeText(deal.deal_id),
          safeText(p.participant_id),
          safeText(p.buyer_id),
          safeText(p.buyer_name),
          safeText(p.buyer_phone),
          safeText(p.buyer_email),
          Number(p.qty || 0),
          safeText(p.delivery_method_type),
          safeText(p.delivery_method_label),
          safeText(p.delivery_address),
          safeText(p.delivery_city),
          safeText(p.buyer_state),
          safeText(p.money_state),
          isEligible(p) ? "YES" : "NO",
          (p.money_state === "ChargedSuccess" || p.money_state === "RecoveredCharge") ? "YES" : "NO",
          p.buyer_state === "Dropped" ? "YES" : "NO",
          fmtDate(p.created_at),
          fmtDate(p.updated_at)
        ]);
      }

      // ── Sheet 4: Money Breakdown ────────────────────────────────────────────
      const ws4 = wb.addWorksheet("Money Breakdown");
      ws4.columns = [
        { header: "participant_id", key: "participant_id", width: 38 },
        { header: "buyer_name", key: "buyer_name", width: 20 },
        { header: "qty", key: "qty", width: 8 },
        { header: "products_amount", key: "products_amount", width: 16 },
        { header: "delivery_cost", key: "delivery_cost", width: 14 },
        { header: "gross_amount", key: "gross_amount", width: 14 },
        { header: "platform_fee_base_amount", key: "platform_fee_base_amount", width: 24 },
        { header: "platform_fee_vat_amount", key: "platform_fee_vat_amount", width: 22 },
        { header: "platform_fee_total_amount", key: "platform_fee_total_amount", width: 24 },
        { header: "seller_net_amount", key: "seller_net_amount", width: 18 },
        { header: "money_state", key: "money_state", width: 18 }
      ];
      applySheetStyle(ws4, ws4.columns.length);
      const moneyColsWs4 = [4, 5, 6, 7, 8, 9, 10];
      for (const p of eligibleParticipants) {
        const qty = Number(p.qty || 0);
        const fm = rowMoney(p);
        const dr = ws4.addRow([
          safeText(p.participant_id),
          safeText(p.buyer_name),
          qty,
          pricePerUnit * qty,
          Number(p.delivery_cost || 0),
          fm.gross_amount,
          fm.platform_fee_base_amount,
          fm.platform_fee_vat_amount,
          fm.platform_fee_total_amount,
          fm.seller_net_amount,
          safeText(p.money_state)
        ]);
        for (const col of moneyColsWs4) {
          dr.getCell(col).numFmt = "#,##0.00";
        }
      }
      // Total row
      const totalRow = ws4.addRow([
        "TOTAL",
        "",
        dealFinalUnits,
        dealProductsTotal,
        dealDeliveryTotal,
        dealMoney.gross_amount,
        dealMoney.platform_fee_base_amount,
        dealMoney.platform_fee_vat_amount,
        dealMoney.platform_fee_total_amount,
        dealMoney.seller_net_amount,
        ""
      ]);
      totalRow.font = { bold: true };
      for (const col of moneyColsWs4) {
        totalRow.getCell(col).numFmt = "#,##0.00";
      }

      // ── Sheet 5: Attribution (only if data exists) ──────────────────────────
      if (attributions.length > 0) {
        const ws5 = wb.addWorksheet("Attribution");
        ws5.addRow(["נתוני ייחוס בלבד. אין בסיטון מנגנון עמלה או תשלום לגורם חיצוני בגין הפצה."]);
        ws5.getRow(1).font = { italic: true };
        ws5.addRow([]);
        ws5.columns = [
          { header: "attribution_label", key: "attribution_label", width: 30 },
          { header: "affiliate_name", key: "affiliate_name", width: 24 },
          { header: "joins_attributed", key: "joins_attributed", width: 18 },
          { header: "units_attributed", key: "units_attributed", width: 18 }
        ];
        const headerRow = ws5.addRow(["attribution_label", "affiliate_name", "joins_attributed", "units_attributed"]);
        headerRow.font = { bold: true };
        ws5.views = [{ state: "frozen", ySplit: 3 }];
        ws5.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: 4 } };
        for (const a of attributions) {
          ws5.addRow([
            safeText(a.share_code),
            safeText(a.affiliate_name),
            Number(a.joins_attributed || 0),
            Number(a.units_attributed || 0)
          ]);
        }
      }

      // ── Sheet 6: Notes ──────────────────────────────────────────────────────
      const wsNotes = wb.addWorksheet("Notes");
      wsNotes.columns = [{ header: "", key: "note", width: 80 }];
      const notesText = [
        "קובץ זה הוא מסירת נתוני עסקה למוכר לאחר השלמת העסקה.",
        "סיטון מספקת רשימת זכאים ונתוני גבייה לפי המידע במערכת.",
        "האחריות לאספקת המוצר, טיפול בכתובות, זמני משלוח ושירות לקוחות לאחר המכירה היא של המוכר.",
        "נתוני לינקי הפצה הם נתוני ייחוס בלבד ואינם מהווים עמלה או התחייבות תשלום מצד סיטון לגורם חיצוני."
      ];
      for (const line of notesText) {
        const nr = wsNotes.addRow([line]);
        nr.getCell(1).alignment = { wrapText: true };
      }

      // ── Serialize and send ──────────────────────────────────────────────────
      const buffer = await wb.xlsx.writeBuffer();

      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="siton-deal-export-${dealId}.xlsx"`)
        .send(Buffer.from(buffer));
    });
  });
}
