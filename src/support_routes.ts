// SUPPORT — admin support cases, legacy support tickets and the public
// support/contact intake.
//
// Lean Refactor: the nine routes below were moved verbatim out of
// src/frontend_runtime.ts. Nothing about them changed: same methods and paths,
// same admin guards (requireAdminRead / requireAdminMutation "support.manage")
// and public intake protections (honeypot, publicWriteCaps "support_contact",
// DB-backed hourly caps), same validation order, same SQL and transaction
// boundaries, same case events, same status codes and response shapes. The
// runtime hands this module exactly the closures it used before (dependency
// injection); no guard or helper was copied.
import type { FastifyInstance } from "fastify";
import {
  OPEN_OPERATIONAL_CASE_STATUSES,
  OPERATIONAL_CASE_PRIORITIES,
  OPERATIONAL_CASE_STATUSES,
  OPERATIONAL_CASE_TYPES,
  ensureAutomaticOperationalCases,
  ensureOperationalCaseTables,
  isOperationalCasePriority,
  isOperationalCaseStatus,
  isOperationalCaseType,
  operationalCaseEventAction,
  recordOperationalCaseEvent
} from "./operational_cases.js";
import { DEFAULT_SELLER_ID } from "./product_surface_support.js";
import { publicWriteCaps } from "./public_write_caps.js";
import {
  INQUIRY_MESSAGE_MAX,
  INQUIRY_MESSAGE_MIN,
  INQUIRY_NAME_MAX,
  normalizeInquiryEmail,
  normalizeInquiryText
} from "./seller_inquiries.js";
import {
  extractDealReference, isDealScopedSupportCategory, supportCategoryRequiresDeal
} from "./support_deal_context.js";

type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;
type SchemaCheck = () => Promise<unknown>;

export type SupportRouteDeps = {
  withTx: WithTx;
  /** The runtime's admin READ guard. Owns the denial response. */
  requireAdminRead: (req: any, reply: any) => Promise<boolean>;
  /** The runtime's admin MUTATION guard (named session + permission). Returns the admin identity, or a falsy value after it sent the denial. */
  requireAdminMutation: (req: any, reply: any, permission: string, opts?: { recentMfa?: boolean }) => Promise<any>;
  /** The runtime's audit actor reference for an admin identity. */
  adminActorRef: (identity: any, fallback?: string) => string;
  /** The runtime's uuid validator: throws a 400 error for a malformed id. */
  requireUuid: (value: string, fieldName: string) => void;
  /** The runtime's memoized schema checks. */
  ensureProductSurfaces: SchemaCheck;
  ensureInquiryTables: SchemaCheck;
  /** The runtime's canonical customer-inquiry writer (the same one the deal page uses). */
  appendCustomerInquiryMessage: (c: any, args: {
    req: any;
    reply: any;
    dealId: string;
    dealTitle: string;
    sellerId: string;
    thread: any;
    name: string;
    email: string;
    message: string;
    requestId: string;
  }) => Promise<any>;
  /** The runtime's inquiry request-id derivation. */
  inquiryRequestId: (req: any) => string;
};

export function registerSupportRoutes(app: FastifyInstance, deps: SupportRouteDeps) {
  const {
    requireAdminRead,
    requireAdminMutation,
    adminActorRef,
    requireUuid,
    ensureProductSurfaces,
    ensureInquiryTables,
    appendCustomerInquiryMessage,
    inquiryRequestId
  } = deps;

  app.get("/api/admin/support-cases", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    await ensureAutomaticOperationalCases(deps.withTx);
    const filters = {
      status: String(req.query?.status || "").trim(),
      case_type: String(req.query?.case_type || "").trim(),
      priority: String(req.query?.priority || "").trim(),
      deal_id: String(req.query?.deal_id || "").trim(),
      seller_id: String(req.query?.seller_id || "").trim(),
      participant_id: String(req.query?.participant_id || "").trim()
    };
    if (filters.status && !isOperationalCaseStatus(filters.status)) {
      return reply.code(400).send({ ok: false, error: "invalid_case_status", allowed_statuses: OPERATIONAL_CASE_STATUSES });
    }
    if (filters.case_type && !isOperationalCaseType(filters.case_type)) {
      return reply.code(400).send({ ok: false, error: "invalid_case_type", allowed_case_types: OPERATIONAL_CASE_TYPES });
    }
    if (filters.priority && !isOperationalCasePriority(filters.priority)) {
      return reply.code(400).send({ ok: false, error: "invalid_case_priority", allowed_priorities: OPERATIONAL_CASE_PRIORITIES });
    }
    if (filters.deal_id) requireUuid(filters.deal_id, "deal_id");
    if (filters.participant_id) requireUuid(filters.participant_id, "participant_id");

    return deps.withTx(async (c) => {
      const where: string[] = [];
      const values: any[] = [];
      const add = (clause: string, value: any) => {
        values.push(value);
        where.push(clause.replace("?", `$${values.length}`));
      };
      if (filters.status) add("oc.status = ?", filters.status);
      else {
        values.push([...OPEN_OPERATIONAL_CASE_STATUSES]);
        where.push(`oc.status = ANY($${values.length}::text[])`);
      }
      if (filters.case_type) add("oc.case_type = ?", filters.case_type);
      if (filters.priority) add("oc.priority = ?", filters.priority);
      if (filters.deal_id) add("oc.deal_id = ?::uuid", filters.deal_id);
      if (filters.seller_id) add("oc.seller_id = ?", filters.seller_id);
      if (filters.participant_id) add("oc.participant_id = ?::uuid", filters.participant_id);

      const cases = await c.query(
        `SELECT oc.case_id::text, oc.case_type, oc.status, oc.priority, oc.source,
                oc.deal_id::text, oc.seller_id, oc.participant_id::text, oc.buyer_ref,
                oc.opened_by, oc.assigned_to, oc.subject, oc.description, oc.resolution_note,
                oc.created_at, oc.updated_at, oc.closed_at,
                d.title AS deal_title,
                COALESCE(sa.business_name, sa.display_name) AS seller_name
         FROM siton.operational_cases oc
         LEFT JOIN siton.deals d ON d.deal_id = oc.deal_id
         LEFT JOIN siton.seller_accounts sa ON sa.seller_id = oc.seller_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY
           CASE oc.priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Normal' THEN 2 ELSE 3 END,
           oc.created_at ASC
         LIMIT 200`,
        values
      );
      const counts = await c.query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('Open','NeedsSeller','NeedsAdmin','WaitingExternal'))::int AS open_count,
           COUNT(*) FILTER (WHERE status='NeedsAdmin')::int AS needs_admin_count,
           COUNT(*) FILTER (WHERE priority='Urgent' AND status IN ('Open','NeedsSeller','NeedsAdmin','WaitingExternal'))::int AS urgent_count,
           COUNT(*) FILTER (WHERE status IN ('Open','NeedsSeller','NeedsAdmin','WaitingExternal') AND created_at < now() - interval '48 hours')::int AS older_than_48h_count
         FROM siton.operational_cases`
      );
      return {
        ok: true,
        filters: {
          ...filters,
          status: filters.status || OPEN_OPERATIONAL_CASE_STATUSES
        },
        allowed: {
          case_types: OPERATIONAL_CASE_TYPES,
          statuses: OPERATIONAL_CASE_STATUSES,
          priorities: OPERATIONAL_CASE_PRIORITIES
        },
        summary: counts.rows[0] || {},
        cases: cases.rows
      };
    });
  });

  // P0.2 — PUBLIC support/contact intake. Creates a canonical operational
  // case (source='Buyer') that the existing Admin Support screen sees.
  // No outbound email is sent — the notification safety rail is untouched.
  // Abuse protection: the global sensitive per-IP bucket (app.ts) plus a
  // DB-backed per-email and global hourly cap here (multi-instance safe).
  const PUBLIC_CONTACT_CATEGORIES: Record<string, { case_type: string; label: string }> = {
    general: { case_type: "Other", label: "שאלה כללית" },
    deal: { case_type: "BuyerComplaint", label: "בעיה בעסקה" },
    payment: { case_type: "PaymentMismatch", label: "תשלומים וחיובים" },
    report: { case_type: "ContentReport", label: "דיווח על תוכן" },
    seller: { case_type: "Other", label: "שאלת מוכר" }
  };
  // UX CLOSEOUT (Issue #39, item 5) — deal-scoped support is bound to the deal
  // and its seller SERVER-SIDE, and becomes the SAME canonical inquiry thread
  // the in-product "פנייה למוכר" creates, rather than a third support universe:
  //
  //   admin  ← siton.operational_cases (deal_id, seller_id, thread pointer)
  //   seller ← siton.seller_inquiry_threads  (the conversation, PII-masked)
  //
  // One inquiry, two projections. The buyer's e-mail and phone stay on the
  // admin case; the seller surface never maps them out (mapSellerInquiryThreadRow).
  // A general or seller-account question carries no deal binding at all, so it
  // can never surface to an unrelated seller.
  app.post("/api/support/contact", async (req: any, reply: any) => {
    await ensureOperationalCaseTables(deps.withTx);
    await ensureInquiryTables();
    const body = req.body && typeof req.body === "object" ? req.body : {};
    // honeypot: bots fill every field — humans never see this one
    if (String(body.website || "").trim()) {
      return reply.code(200).send({ ok: true, received: true });
    }
    const name = String(body.name || "").trim().slice(0, 120);
    const email = String(body.email || "").trim().toLowerCase().slice(0, 200);
    const phone = String(body.phone || "").trim().slice(0, 40);
    const categoryKey = String(body.category || "general").trim();
    const message = String(body.message || "").trim();
    const category = PUBLIC_CONTACT_CATEGORIES[categoryKey];
    if (!name || name.length < 2) return reply.code(400).send({ ok: false, error: "contact_name_required" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return reply.code(400).send({ ok: false, error: "contact_email_invalid" });
    if (!category) return reply.code(400).send({ ok: false, error: "contact_category_invalid" });
    if (message.length < 10) return reply.code(400).send({ ok: false, error: "contact_message_too_short" });
    if (message.length > 2000) return reply.code(400).send({ ok: false, error: "contact_message_too_long" });

    // The reference is a LOOKUP KEY only — a deal id, a public deal link, a
    // hash route or a tracking link. The seller is read off the resolved DEAL
    // row; nothing in the request can name a seller.
    const dealScoped = isDealScopedSupportCategory(categoryKey);
    const dealReference = dealScoped ? extractDealReference(body.deal_ref ?? body.deal_link ?? body.deal_id) : null;
    if (supportCategoryRequiresDeal(categoryKey) && !dealReference) {
      return reply.code(400).send({ ok: false, error: "contact_deal_reference_required" });
    }
    // Black-Sky C5: per-client budget before the platform-wide 30/h cap.
    if (!publicWriteCaps.consume("support_contact", String(req.ip || "unknown"))) {
      return reply.code(429).send({ ok: false, error: "support contact rate limited", code: "support_rate_limited" });
    }

    const created = await deps.withTx(async (c) => {
      const counts = await c.query(
        `SELECT
           count(*) FILTER (WHERE buyer_ref = $1) AS per_email,
           count(*) AS total
         FROM siton.operational_cases
         WHERE source = 'Buyer' AND opened_by = 'public_contact_form'
           AND created_at > now() - interval '1 hour'`,
        [email]
      );
      const limits = counts.rows[0] || {};
      if (Number(limits.per_email || 0) >= 3 || Number(limits.total || 0) >= 30) {
        throw Object.assign(new Error("support contact rate limited"), { statusCode: 429, code: "support_rate_limited" });
      }
      // Resolve the deal reference to a real PUBLISHED deal, and take the
      // seller from that row. An unknown or unpublished id resolves to nothing.
      let dealContext: { deal_id: string; title: string; seller_id: string } | null = null;
      if (dealReference) {
        const dealRow = await c.query(
          `SELECT d.deal_id, d.title, COALESCE(d.seller_id, $2) AS seller_id
           FROM siton.deals d
           WHERE d.deal_id = $1 AND d.published_at IS NOT NULL
           LIMIT 1`,
          [dealReference, DEFAULT_SELLER_ID]
        );
        if (dealRow.rowCount) {
          dealContext = {
            deal_id: String(dealRow.rows[0].deal_id),
            title: String(dealRow.rows[0].title || ""),
            seller_id: String(dealRow.rows[0].seller_id)
          };
        }
      }
      if (supportCategoryRequiresDeal(categoryKey) && !dealContext) {
        throw Object.assign(new Error("support deal reference unresolved"), {
          statusCode: 404, code: "contact_deal_not_found"
        });
      }

      // The seller's copy IS the canonical inquiry thread, created through the
      // same helper the deal page uses — same rate limits, same retry dedupe,
      // same single pointer notification, same PII masking.
      let inquiry: any = null;
      if (dealContext) {
        const threadName = normalizeInquiryText(name, INQUIRY_NAME_MAX);
        const threadEmail = normalizeInquiryEmail(email);
        const threadBody = normalizeInquiryText(message, INQUIRY_MESSAGE_MAX);
        if (threadName.length >= 2 && threadEmail && threadBody.length >= INQUIRY_MESSAGE_MIN) {
          const appended = await appendCustomerInquiryMessage(c, {
            req, reply,
            dealId: dealContext.deal_id,
            dealTitle: dealContext.title,
            sellerId: dealContext.seller_id,
            thread: null,
            name: threadName,
            email: threadEmail,
            message: threadBody,
            requestId: inquiryRequestId(req)
          });
          if (appended?.rate_limited) {
            throw Object.assign(new Error("support contact rate limited"), { statusCode: 429, code: "support_rate_limited" });
          }
          inquiry = appended;
        }
      }

      const description = [
        message,
        "",
        `— פרטי הפונה —`,
        `שם: ${name}`,
        `אימייל: ${email}`,
        phone ? `טלפון: ${phone}` : null,
        dealContext ? "" : null,
        dealContext ? `— הקשר העסקה —` : null,
        dealContext ? `עסקה: ${dealContext.title} (${dealContext.deal_id})` : null,
        inquiry?.thread_id ? `שיחת מוכר: ${inquiry.thread_id}` : null
      ].filter((line) => line !== null).join("\n");
      const inserted = await c.query(
        `INSERT INTO siton.operational_cases
           (case_type, status, priority, source, buyer_ref, opened_by, subject, description, deal_id, seller_id)
         VALUES ($1,'Open','Normal','Buyer',$2,'public_contact_form',$3,$4,$5,$6)
         RETURNING case_id, status, created_at`,
        [
          category.case_type, email, `${category.label} — ${name}`.slice(0, 200), description,
          dealContext ? dealContext.deal_id : null,
          dealContext ? dealContext.seller_id : null
        ]
      );
      return { ...inserted.rows[0], deal_context: dealContext, inquiry };
    });
    // `appendCustomerInquiryMessage` sets 201 for the thread it created; the
    // support intake owns the final status either way.
    return reply.code(201).send({
      ok: true,
      case_id: created.case_id,
      status: created.status,
      deal_id: created.deal_context ? created.deal_context.deal_id : null,
      // The seller-visible half, when there is one. The access token lets the
      // buyer follow their own thread exactly as the deal-page form does.
      ...(created.inquiry?.thread_id
        ? { thread_id: created.inquiry.thread_id, ...(created.inquiry.access_token ? { access_token: created.inquiry.access_token } : {}) }
        : {})
    });
  });

  app.post("/api/admin/support-cases", async (req: any, reply: any) => {
    const adminIdentity = await requireAdminMutation(req, reply, "support.manage");
    if (!adminIdentity) return;
    await ensureOperationalCaseTables(deps.withTx);
    const body = req.body || {};
    const caseType = String(body.case_type || "").trim();
    const priority = String(body.priority || "").trim();
    const source = String(body.source || "Admin").trim();
    const subject = String(body.subject || "").trim();
    const description = String(body.description || "").trim();
    const dealId = String(body.deal_id || "").trim() || null;
    const sellerId = String(body.seller_id || "").trim() || null;
    const participantId = String(body.participant_id || "").trim() || null;
    const buyerRef = String(body.buyer_ref || "").trim() || null;
    const openedBy = adminActorRef(adminIdentity, String(body.opened_by || "admin"));
    if (!isOperationalCaseType(caseType)) {
      return reply.code(400).send({ ok: false, error: "invalid_case_type", allowed_case_types: OPERATIONAL_CASE_TYPES });
    }
    if (!isOperationalCasePriority(priority)) {
      return reply.code(400).send({ ok: false, error: "invalid_case_priority", allowed_priorities: OPERATIONAL_CASE_PRIORITIES });
    }
    if (!["Admin", "Buyer", "Seller", "System"].includes(source)) {
      return reply.code(400).send({ ok: false, error: "invalid_case_source" });
    }
    if (!subject) {
      return reply.code(400).send({ ok: false, error: "case_subject_required" });
    }
    if (dealId) requireUuid(dealId, "deal_id");
    if (participantId) requireUuid(participantId, "participant_id");
    if (!dealId && !sellerId && !participantId && description.length < 20) {
      return reply.code(400).send({ ok: false, error: "case_reference_or_detailed_description_required" });
    }

    const created = await deps.withTx(async (c) => {
      const inserted = await c.query(
        `INSERT INTO siton.operational_cases
           (case_type, status, priority, source, deal_id, seller_id, participant_id, buyer_ref,
            opened_by, subject, description)
         VALUES ($1,'Open',$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [caseType, priority, source, dealId, sellerId, participantId, buyerRef, openedBy, subject, description || null]
      );
      const row = inserted.rows[0];
      await recordOperationalCaseEvent(c, {
        caseId: String(row.case_id),
        eventType: "case.create",
        actorRef: openedBy,
        requestId: String(req.headers?.["x-request-id"] || ""),
        idempotencyKey: String(req.headers?.["idempotency-key"] || ""),
        payload: { case_type: caseType, source }
      });
      if (caseType === "RefundRequest") {
        await recordOperationalCaseEvent(c, {
          caseId: String(row.case_id),
          eventType: "case.refund_request_marked",
          actorRef: openedBy,
          reason: "Refund request recorded as an operational case only",
          payload: { no_refund_executed_in_request_thread: true }
        });
      }
      return { ok: true, case: row };
    });
    return reply.code(201).send(created);
  });

  app.patch("/api/admin/support-cases/:caseId", async (req: any, reply: any) => {
    const adminIdentity = await requireAdminMutation(req, reply, "support.manage");
    if (!adminIdentity) return;
    await ensureOperationalCaseTables(deps.withTx);
    const caseId = String(req.params.caseId || "").trim();
    requireUuid(caseId, "case_id");
    const body = req.body || {};
    const hasStatus = Object.prototype.hasOwnProperty.call(body, "status");
    const hasPriority = Object.prototype.hasOwnProperty.call(body, "priority");
    const hasAssignedTo = Object.prototype.hasOwnProperty.call(body, "assigned_to");
    const hasResolutionNote = Object.prototype.hasOwnProperty.call(body, "resolution_note");
    const status = hasStatus ? String(body.status || "").trim() : null;
    const priority = hasPriority ? String(body.priority || "").trim() : null;
    const assignedTo = hasAssignedTo ? String(body.assigned_to || "").trim() : null;
    const resolutionNote = hasResolutionNote ? String(body.resolution_note || "").trim() : null;
    const reason = String(body.reason || body.resolution_note || "").trim();
    const actorRef = adminActorRef(adminIdentity);
    if (hasStatus && !isOperationalCaseStatus(status)) {
      return reply.code(400).send({ ok: false, error: "invalid_case_status", allowed_statuses: OPERATIONAL_CASE_STATUSES });
    }
    if (hasPriority && !isOperationalCasePriority(priority)) {
      return reply.code(400).send({ ok: false, error: "invalid_case_priority", allowed_priorities: OPERATIONAL_CASE_PRIORITIES });
    }

    return deps.withTx(async (c) => {
      const current = await c.query(`SELECT * FROM siton.operational_cases WHERE case_id=$1 FOR UPDATE`, [caseId]);
      if (!current.rowCount) return reply.code(404).send({ ok: false, error: "support_case_not_found" });
      const before = current.rows[0];
      const nextStatus = hasStatus ? status : String(before.status);
      const nextPriority = hasPriority ? priority : String(before.priority);
      const nextResolution = hasResolutionNote ? resolutionNote : String(before.resolution_note || "");
      if (["Closed", "Resolved"].includes(String(nextStatus)) && !String(nextResolution || "").trim()) {
        return reply.code(400).send({ ok: false, error: "resolution_note_required_to_close" });
      }
      if (String(before.priority) === "Urgent" && nextPriority !== "Urgent" && !reason) {
        return reply.code(400).send({ ok: false, error: "priority_downgrade_reason_required" });
      }

      const updated = await c.query(
        `UPDATE siton.operational_cases
         SET status=$2,
             priority=$3,
             assigned_to=$4,
             resolution_note=$5,
             updated_at=now(),
             closed_at=CASE WHEN $2 IN ('Closed','Resolved') THEN COALESCE(closed_at, now()) ELSE NULL END
         WHERE case_id=$1
         RETURNING *`,
        [
          caseId,
          nextStatus,
          nextPriority,
          hasAssignedTo ? assignedTo || null : before.assigned_to || null,
          String(nextResolution || "") || null
        ]
      );
      const after = updated.rows[0];
      if (hasStatus && String(before.status) !== String(after.status)) {
        await recordOperationalCaseEvent(c, {
          caseId,
          eventType: ["Closed", "Resolved"].includes(String(after.status)) ? "case.close" : "case.update_status",
          actorRef,
          reason,
          fromStatus: String(before.status),
          toStatus: String(after.status),
          requestId: String(req.headers?.["x-request-id"] || ""),
          idempotencyKey: String(req.headers?.["idempotency-key"] || "")
        });
      }
      if (hasPriority && String(before.priority) !== String(after.priority)) {
        await recordOperationalCaseEvent(c, {
          caseId,
          eventType: String(after.priority) === "Urgent" ? "case.escalate" : operationalCaseEventAction("update_status"),
          actorRef,
          reason,
          fromPriority: String(before.priority),
          toPriority: String(after.priority)
        });
      }
      if (hasAssignedTo && String(before.assigned_to || "") !== String(after.assigned_to || "")) {
        await recordOperationalCaseEvent(c, {
          caseId,
          eventType: "case.assign",
          actorRef,
          reason,
          payload: { assigned_to: after.assigned_to || null }
        });
      }
      return { ok: true, case: after };
    });
  });

  // ── P0.5-3: a support case is a CONVERSATION ──────────────────────────────
  // GET one case + its full thread. The original customer message lives on
  // operational_cases.description (unchanged truth); every later message is a
  // siton.support_case_messages row. Admin-only — sellers and the public have
  // no read path to support threads.
  app.get("/api/admin/support-cases/:caseId", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    await ensureOperationalCaseTables(deps.withTx);
    const caseId = String(req.params.caseId || "").trim();
    requireUuid(caseId, "case_id");
    return deps.withTx(async (c) => {
      const found = await c.query(
        `SELECT oc.case_id::text, oc.case_type, oc.status, oc.priority, oc.source,
                oc.deal_id::text, oc.seller_id, oc.participant_id::text, oc.buyer_ref,
                oc.opened_by, oc.assigned_to, oc.subject, oc.description, oc.resolution_note,
                oc.created_at, oc.updated_at, oc.closed_at,
                d.title AS deal_title,
                COALESCE(sa.business_name, sa.display_name) AS seller_name
         FROM siton.operational_cases oc
         LEFT JOIN siton.deals d ON d.deal_id = oc.deal_id
         LEFT JOIN siton.seller_accounts sa ON sa.seller_id = oc.seller_id
         WHERE oc.case_id = $1`,
        [caseId]
      );
      if (!found.rowCount) return reply.code(404).send({ ok: false, error: "support_case_not_found" });
      const messages = await c.query(
        `SELECT message_id::text, sender_type, sender_ref, body, delivery_status,
                provider_message_id, created_at
         FROM siton.support_case_messages
         WHERE case_id = $1
         ORDER BY created_at ASC
         LIMIT 200`,
        [caseId]
      );
      return {
        ok: true,
        case: found.rows[0],
        messages: messages.rows,
        // truthful delivery reality for the UI — never claim an email was sent
        email_delivery: { enabled: false, note: "external outbound email is disabled in this environment (notification safety rail)" }
      };
    });
  });

  // POST a reply (or internal note) into the case thread. Transactional:
  // message persisted + case status truth updated + case event recorded.
  // Email flow: the approved outbound rail is DISABLED here, so the message
  // stays delivery_status='Saved' and the response says so honestly — the
  // reply is never claimed to have reached the customer's inbox.
  app.post("/api/admin/support-cases/:caseId/reply", async (req: any, reply: any) => {
    const adminIdentity = await requireAdminMutation(req, reply, "support.manage");
    if (!adminIdentity) return;
    await ensureOperationalCaseTables(deps.withTx);
    const caseId = String(req.params.caseId || "").trim();
    requireUuid(caseId, "case_id");
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const text = String(body.body || "").trim();
    const internal = Boolean(body.internal);
    if (text.length < 2) return reply.code(400).send({ ok: false, error: "reply body is required", code: "support_reply_required" });
    if (text.length > 4000) return reply.code(400).send({ ok: false, error: "reply body too long", code: "support_reply_too_long" });
    const actorRef = adminActorRef(adminIdentity);
    const requestId = String(req.headers?.["x-request-id"] || "");

    return deps.withTx(async (c) => {
      const current = await c.query(`SELECT case_id, status FROM siton.operational_cases WHERE case_id=$1 FOR UPDATE`, [caseId]);
      if (!current.rowCount) return reply.code(404).send({ ok: false, error: "support_case_not_found" });
      const beforeStatus = String(current.rows[0].status);

      const inserted = await c.query(
        `INSERT INTO siton.support_case_messages (case_id, sender_type, sender_ref, body, delivery_status, request_id)
         VALUES ($1, $2, $3, $4, 'Saved', $5)
         RETURNING message_id::text, sender_type, sender_ref, body, delivery_status, created_at`,
        [caseId, internal ? "InternalNote" : "Admin", actorRef, text, requestId]
      );
      const message = inserted.rows[0];

      // A customer-facing reply means the ball moved to the customer's court:
      // open-ish states become WaitingExternal (presented as "נענה — ממתין
      // לפונה"). Internal notes never change the case status.
      let afterStatus = beforeStatus;
      if (!internal && ["Open", "NeedsAdmin", "NeedsSeller"].includes(beforeStatus)) {
        afterStatus = "WaitingExternal";
        await c.query(
          `UPDATE siton.operational_cases SET status='WaitingExternal', updated_at=now() WHERE case_id=$1`,
          [caseId]
        );
      } else {
        await c.query(`UPDATE siton.operational_cases SET updated_at=now() WHERE case_id=$1`, [caseId]);
      }

      await recordOperationalCaseEvent(c, {
        caseId,
        eventType: internal ? "case.internal_note" : "case.reply",
        actorRef,
        requestId,
        fromStatus: beforeStatus,
        toStatus: afterStatus,
        payload: { message_id: message.message_id, internal }
      });

      return {
        ok: true,
        message,
        case_status: afterStatus,
        // honest delivery truth: saved, NOT emailed (rail disabled)
        email_delivery: {
          enabled: false,
          attempted: false,
          note_he: "התשובה נשמרה. שליחת מייל חיצונית אינה פעילה כרגע בסביבה זו."
        }
      };
    });
  });

  app.post("/api/admin/support-cases/:caseId/escalate", async (req: any, reply: any) => {
    const adminIdentity = await requireAdminMutation(req, reply, "support.manage");
    if (!adminIdentity) return;
    await ensureOperationalCaseTables(deps.withTx);
    const caseId = String(req.params.caseId || "").trim();
    requireUuid(caseId, "case_id");
    const actorRef = adminActorRef(adminIdentity);
    const reason = String(req.body?.reason || "Escalated by admin").trim();
    return deps.withTx(async (c) => {
      const current = await c.query(`SELECT * FROM siton.operational_cases WHERE case_id=$1 FOR UPDATE`, [caseId]);
      if (!current.rowCount) return reply.code(404).send({ ok: false, error: "support_case_not_found" });
      const before = current.rows[0];
      const updated = await c.query(
        `UPDATE siton.operational_cases
         SET priority='Urgent', updated_at=now()
         WHERE case_id=$1
         RETURNING *`,
        [caseId]
      );
      await recordOperationalCaseEvent(c, {
        caseId,
        eventType: "case.escalate",
        actorRef,
        reason,
        fromPriority: String(before.priority),
        toPriority: "Urgent",
        requestId: String(req.headers?.["x-request-id"] || ""),
        idempotencyKey: String(req.headers?.["idempotency-key"] || ""),
        payload: { no_state_machine_change: true }
      });
      return { ok: true, case: updated.rows[0] };
    });
  });

  app.post("/api/admin/support", async (req: any, reply: any) => {
    if (!(await requireAdminMutation(req, reply, "support.manage"))) return;
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

  app.post("/api/admin/support/:ticketId", async (req: any, reply: any) => {
    if (!(await requireAdminMutation(req, reply, "support.manage"))) return;
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
}
