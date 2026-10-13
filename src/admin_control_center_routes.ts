// ADMIN CONTROL CENTER (R6) — the read-only owner/admin control-center
// reads: the global overview, the deals, sellers and buyers rosters, the
// seller drilldown and the audit tail.
//
// Lean Refactor: the six routes below were moved verbatim out of
// src/frontend_runtime.ts. Nothing about them changed: same methods and paths,
// same admin read guard (requireAdminRead) as the first statement of every
// handler, same schema check, same SQL and transaction boundaries (one
// deps.withTx per request), same status codes and response shapes. The
// runtime hands this module exactly the closures and values it used before
// (dependency injection), including the ledger-aligned platform-fee
// projection, which stays defined in src/frontend_runtime.ts; no guard or
// helper was copied. Every route is a GET: the module performs no write.
import type { FastifyInstance } from "fastify";
import { buyerNameRankSql, buyerSearchPredicateSql, classifyBuyerSearch } from "./buyer_search_intent.js";
import { hashDestination } from "./otp_rail.js";
import { readViralMetricsCache } from "./viral_graph.js";

type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;
type SchemaCheck = () => Promise<unknown>;

export type AdminControlCenterRouteDeps = {
  withTx: WithTx;
  /** The runtime's admin READ guard. Owns the denial response. */
  requireAdminRead: (req: any, reply: any) => Promise<boolean>;
  /** The runtime's memoized product-surface schema check. */
  ensureProductSurfaces: SchemaCheck;
  /** The runtime's ledger-aligned platform-fee projection (Red-team B3); not revenue. */
  projectPlatformFeeTotalForParticipants: (rows: Array<{ product_gross: unknown; delivery_cost: unknown }>) => number;
  /** The runtime's per-participant projection population query (the same one the potential_gross aggregates use). */
  PROJECTION_PARTICIPANT_ROWS_SQL: string;
};

export function registerAdminControlCenterRoutes(app: FastifyInstance, deps: AdminControlCenterRouteDeps) {
  const {
    requireAdminRead,
    ensureProductSurfaces,
    projectPlatformFeeTotalForParticipants,
    PROJECTION_PARTICIPANT_ROWS_SQL
  } = deps;

  // Admin: the R6 global control-center overview — the whole system in one
  // call. Provisional/potential money is NEVER labeled as charged revenue:
  // the two families are returned under separate, explicit keys.
  app.get("/api/admin/r6/overview", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    await ensureProductSurfaces();
    return deps.withTx(async (c) => {
      const dealStates = await c.query(
        `SELECT state::text AS state, COUNT(*)::int AS cnt FROM siton.deals GROUP BY state`
      );
      const sellerStats = await c.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE COALESCE(seller_status,'Active')='Active')::int AS active
         FROM siton.seller_accounts`
      );
      const participantStats = await c.query(
        `SELECT COUNT(*)::int AS participants,
                COUNT(DISTINCT buyer_id)::int AS buyers,
                COALESCE(SUM(qty) FILTER (WHERE buyer_state NOT IN ('NotJoined','DealFailed','Dropped')),0)::int AS units_joined,
                COALESCE(SUM(qty) FILTER (WHERE money_state IN ('ChargedSuccess','RecoveredCharge')),0)::int AS units_charged,
                COUNT(*) FILTER (WHERE money_state='ChargeFailedRecovery')::int AS in_recovery,
                COALESCE(SUM(qty) FILTER (WHERE money_state='ChargeFailedRecovery'),0)::int AS units_in_recovery
         FROM siton.participants`
      );
      const moneyStats = await c.query(
        `SELECT
           COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost)
             FILTER (WHERE p.buyer_state NOT IN ('NotJoined','DealFailed','Dropped')), 0)::numeric(14,2) AS potential_gross,
           COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost)
             FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')), 0)::numeric(14,2) AS charged_gross
         FROM siton.participants p
         JOIN siton.deals d ON d.deal_id = p.deal_id`
      );
      const projectionRows = await c.query(PROJECTION_PARTICIPANT_ROWS_SQL);
      const feeActual = await c.query(
        `SELECT COALESCE(SUM(platform_fee_total_amount),0)::numeric(14,2) AS fee_actual
         FROM siton.platform_fee_money_events`
      );
      const outbox = await c.query(
        `SELECT
           COUNT(*) FILTER (WHERE status='pending')::int AS pending,
           COUNT(*) FILTER (WHERE status='processing')::int AS processing,
           MIN(available_at) FILTER (WHERE status='pending') AS oldest_pending_at
         FROM siton.outbox_events`
      );
      const dlq = await c.query(`SELECT COUNT(*)::int AS cnt FROM siton.outbox_dlq`);
      const worker = await c.query(
        `SELECT worker_id, status, heartbeat_at,
                EXTRACT(EPOCH FROM (now() - heartbeat_at))::int AS age_seconds
         FROM siton.worker_heartbeats ORDER BY heartbeat_at DESC LIMIT 3`
      );
      const notifications = await c.query(
        `SELECT status, COUNT(*)::int AS cnt FROM siton.notification_events GROUP BY status`
      );
      const recentDlq = await c.query(
        `SELECT event_type, aggregate_id, updated_at AS archived_at, last_error
         FROM siton.outbox_dlq ORDER BY updated_at DESC NULLS LAST LIMIT 5`
      );
      const recentPaymentFailures = await c.query(
        `SELECT COUNT(*)::int AS cnt FROM siton.payment_attempts
         WHERE result_class='permanent_fail' AND created_at > now() - interval '24 hours'`
      );
      const openCases = await c.query(
        `SELECT COUNT(*)::int AS cnt FROM siton.operational_cases WHERE status NOT IN ('Resolved','Closed')`
      );
      const openTickets = await c.query(
        `SELECT COUNT(*)::int AS cnt FROM siton.support_tickets WHERE status <> 'resolved'`
      );
      const viralPlatform = await readViralMetricsCache(c, "platform", "global");

      const stateCounts: Record<string, number> = {};
      for (const r of dealStates.rows) stateCounts[String(r.state)] = Number(r.cnt);
      const p = participantStats.rows[0];
      const m = moneyStats.rows[0];
      const potentialGross = Number(m.potential_gross || 0);
      return {
        ok: true,
        generated_at: new Date().toISOString(),
        deals: {
          by_state: stateCounts,
          total: dealStates.rows.reduce((s: number, r: any) => s + Number(r.cnt), 0),
          active: (stateCounts["PendingTarget"] || 0) + (stateCounts["TargetReached"] || 0)
            + (stateCounts["ClosedForJoining"] || 0) + (stateCounts["ReadyForCharging"] || 0)
            + (stateCounts["Charging"] || 0) + (stateCounts["CompletionWindow"] || 0)
        },
        sellers: {
          total: Number(sellerStats.rows[0].total || 0),
          active: Number(sellerStats.rows[0].active || 0)
        },
        participants: {
          total: Number(p.participants || 0),
          distinct_buyers: Number(p.buyers || 0),
          units_joined: Number(p.units_joined || 0),
          units_charged: Number(p.units_charged || 0),
          in_recovery: Number(p.in_recovery || 0),
          units_in_recovery: Number(p.units_in_recovery || 0)
        },
        money: {
          // Provisional: authorized frames only — NOT revenue.
          potential_gross_volume: potentialGross,
          // Red-team B3: the projection follows the authoritative ledger formula
          // (8% of the VAT-exclusive base + VAT on the fee), so it reconciles
          // with platform_fee_actual instead of a flat 8% of gross.
          platform_fee_projection: projectPlatformFeeTotalForParticipants(projectionRows.rows),
          // Actual: successful charges only (ChargedSuccess/RecoveredCharge).
          charged_gross_volume: Number(m.charged_gross || 0),
          platform_fee_actual: Number(feeActual.rows[0].fee_actual || 0)
        },
        operations: {
          outbox_pending: Number(outbox.rows[0].pending || 0),
          outbox_processing: Number(outbox.rows[0].processing || 0),
          oldest_pending_at: outbox.rows[0].oldest_pending_at,
          dlq_size: Number(dlq.rows[0].cnt || 0),
          workers: worker.rows.map((w: any) => ({
            worker_id: String(w.worker_id),
            status: String(w.status),
            heartbeat_age_seconds: Number(w.age_seconds || 0)
          })),
          notifications_by_status: Object.fromEntries(notifications.rows.map((r: any) => [String(r.status), Number(r.cnt)])),
          open_operational_cases: Number(openCases.rows[0].cnt || 0),
          open_support_tickets: Number(openTickets.rows[0].cnt || 0),
          payment_permanent_failures_24h: Number(recentPaymentFailures.rows[0].cnt || 0),
          recent_dlq: recentDlq.rows.map((r: any) => ({
            event_type: String(r.event_type),
            aggregate_id: String(r.aggregate_id),
            archived_at: r.archived_at,
            last_error: String(r.last_error || "").slice(0, 300)
          }))
        },
        viral: viralPlatform
      };
    });
  });

  // Admin: global deals list with money + viral rollups.
  app.get("/api/admin/r6/deals", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const stateFilter = String(req.query?.state || "").trim();
    const q = String(req.query?.q || "").trim().slice(0, 120);
    return deps.withTx(async (c) => {
      const rows = await c.query(
        `SELECT d.deal_id, d.title, d.state::text AS state, d.deal_type, d.seller_id,
                sa.business_name, sa.display_name AS seller_display_name,
                d.price_per_unit, d.min_units, d.max_units, d.threshold_units,
                d.deadline, d.published_at, d.completion_window_until, d.created_at, d.updated_at,
                COALESCE(SUM(p.qty) FILTER (WHERE p.buyer_state NOT IN ('NotJoined','DealFailed','Dropped')),0)::int AS joined_units,
                COALESCE(SUM(p.qty) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::int AS charged_units,
                COUNT(p.participant_id) FILTER (WHERE p.buyer_state NOT IN ('NotJoined','DealFailed','Dropped'))::int AS participants,
                COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost)
                  FILTER (WHERE p.buyer_state NOT IN ('NotJoined','DealFailed','Dropped')),0)::numeric(14,2) AS potential_gross,
                COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost)
                  FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::numeric(14,2) AS charged_gross,
                COUNT(va.participant_id) FILTER (WHERE va.origin_ref_type <> 'none')::int AS viral_joins
         FROM siton.deals d
         LEFT JOIN siton.seller_accounts sa ON sa.seller_id = d.seller_id
         LEFT JOIN siton.participants p ON p.deal_id = d.deal_id
         LEFT JOIN siton.viral_attributions va ON va.participant_id = p.participant_id
         WHERE ($1 = '' OR d.state::text = $1)
           AND ($2 = '' OR d.title ILIKE '%' || $2 || '%' OR d.deal_id::text = $2 OR d.seller_id ILIKE '%' || $2 || '%')
         GROUP BY d.deal_id, sa.business_name, sa.display_name
         ORDER BY d.updated_at DESC
         LIMIT 200`,
        [stateFilter, q]
      );
      return { ok: true, deals: rows.rows };
    });
  });

  // Admin: global sellers list with rollups.
  app.get("/api/admin/r6/sellers", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    return deps.withTx(async (c) => {
      const rows = await c.query(
        `SELECT sa.seller_id, sa.display_name,
                -- LAUNCH POLISH (P4) — a self-registered seller types the business name into the
                -- business profile first; show it in the queue before the account row carries it
                COALESCE(NULLIF(btrim(sa.business_name),''), bp.business_name) AS business_name,
                COALESCE(sa.seller_status,'Active') AS seller_status,
                COALESCE(sa.verification_status,'pending') AS verification_status,
                sa.login_email, sa.auth_enabled, (sa.auth_user_id IS NOT NULL) AS supabase_bound,
                sa.created_at,
                COUNT(DISTINCT d.deal_id)::int AS deals_total,
                COUNT(DISTINCT d.deal_id) FILTER (WHERE d.state IN ('PendingTarget','TargetReached','ClosedForJoining','ReadyForCharging','Charging','CompletionWindow'))::int AS deals_active,
                COUNT(DISTINCT d.deal_id) FILTER (WHERE d.state='Completed')::int AS deals_completed,
                COUNT(DISTINCT d.deal_id) FILTER (WHERE d.state='Failed')::int AS deals_failed,
                COALESCE(SUM(p.qty) FILTER (WHERE p.buyer_state NOT IN ('NotJoined','DealFailed','Dropped')),0)::int AS joined_units,
                COALESCE(SUM(p.qty) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::int AS charged_units,
                COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost)
                  FILTER (WHERE p.buyer_state NOT IN ('NotJoined','DealFailed','Dropped')),0)::numeric(14,2) AS potential_gross,
                COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost)
                  FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::numeric(14,2) AS charged_gross,
                MAX(GREATEST(d.updated_at, p.updated_at)) AS last_activity_at
         FROM siton.seller_accounts sa
         LEFT JOIN siton.seller_business_profiles bp ON bp.seller_id = sa.seller_id
         LEFT JOIN siton.deals d ON d.seller_id = sa.seller_id
         LEFT JOIN siton.participants p ON p.deal_id = d.deal_id
         GROUP BY sa.seller_id, bp.business_name
         ORDER BY last_activity_at DESC NULLS LAST
         LIMIT 200`
      );
      const feeBySeller = await c.query(
        `SELECT seller_id, COALESCE(SUM(platform_fee_total_amount),0)::numeric(14,2) AS fee_actual
         FROM siton.platform_fee_money_events GROUP BY seller_id`
      );
      const feeMap = new Map(feeBySeller.rows.map((r: any) => [String(r.seller_id), Number(r.fee_actual)]));
      const projectionRows = await c.query(PROJECTION_PARTICIPANT_ROWS_SQL);
      const projectionBySeller = new Map<string, Array<{ product_gross: unknown; delivery_cost: unknown }>>();
      for (const row of projectionRows.rows as any[]) {
        const key = String(row.seller_id || "");
        if (!projectionBySeller.has(key)) projectionBySeller.set(key, []);
        projectionBySeller.get(key)!.push(row);
      }
      return {
        ok: true,
        sellers: rows.rows.map((r: any) => ({
          ...r,
          platform_fee_actual: feeMap.get(String(r.seller_id)) || 0,
          // Red-team B3: ledger-aligned projection, computed per participant.
          platform_fee_projection: projectPlatformFeeTotalForParticipants(projectionBySeller.get(String(r.seller_id)) || [])
        }))
      };
    });
  });

  // Admin: full seller drilldown — the complete seller picture.
  app.get("/api/admin/r6/sellers/:sellerId", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const sellerId = String(req.params.sellerId || "").slice(0, 120);
    return deps.withTx(async (c) => {
      const seller = await c.query(
        `SELECT sa.seller_id, sa.display_name,
                COALESCE(NULLIF(btrim(sa.business_name),''), bp.business_name) AS business_name,
                COALESCE(NULLIF(btrim(sa.business_identifier),''), bp.business_id_number) AS business_identifier,
                COALESCE(NULLIF(btrim(sa.contact_name),''), bp.contact_name) AS contact_name,
                COALESCE(NULLIF(btrim(sa.support_phone),''), bp.contact_phone) AS support_phone,
                COALESCE(NULLIF(btrim(sa.support_email),''), bp.contact_email) AS support_email,
                sa.business_description,
                COALESCE(sa.seller_status,'Active') AS seller_status, sa.seller_status_reason,
                sa.login_email, sa.auth_enabled, (sa.auth_user_id IS NOT NULL) AS supabase_bound,
                sa.verification_status, sa.admin_note, sa.created_at, sa.updated_at, sa.last_login_at,
                -- LAUNCH POLISH (P4) — provenance from the append-only audit rail (admin_note is rewritten by decisions)
                EXISTS (SELECT 1 FROM siton.seller_security_events e
                         WHERE e.seller_id = sa.seller_id AND e.event_type = 'seller.self_signup.bound') AS self_signup
         FROM siton.seller_accounts sa
         LEFT JOIN siton.seller_business_profiles bp ON bp.seller_id = sa.seller_id
         WHERE sa.seller_id=$1 LIMIT 1`,
        [sellerId]
      );
      if (!seller.rowCount) {
        const err: any = new Error("seller not found");
        err.statusCode = 404;
        throw err;
      }
      const deals = await c.query(
        `SELECT d.deal_id, d.title, d.state::text AS state, d.deal_type,
                d.price_per_unit, d.min_units, d.max_units, d.threshold_units,
                d.deadline, d.published_at, d.completion_window_until, d.created_at, d.updated_at,
                COALESCE(SUM(p.qty) FILTER (WHERE p.buyer_state NOT IN ('NotJoined','DealFailed','Dropped')),0)::int AS joined_units,
                COALESCE(SUM(p.qty) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::int AS charged_units,
                COUNT(p.participant_id) FILTER (WHERE p.buyer_state NOT IN ('NotJoined','DealFailed','Dropped'))::int AS participants,
                COUNT(p.participant_id) FILTER (WHERE p.money_state='ChargeFailedRecovery')::int AS in_recovery,
                COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost)
                  FILTER (WHERE p.buyer_state NOT IN ('NotJoined','DealFailed','Dropped')),0)::numeric(14,2) AS potential_gross,
                COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost)
                  FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::numeric(14,2) AS charged_gross
         FROM siton.deals d
         LEFT JOIN siton.participants p ON p.deal_id = d.deal_id
         WHERE d.seller_id=$1
         GROUP BY d.deal_id
         ORDER BY d.updated_at DESC
         LIMIT 100`,
        [sellerId]
      );
      const fee = await c.query(
        `SELECT COALESCE(SUM(platform_fee_total_amount),0)::numeric(14,2) AS fee_actual,
                COALESCE(SUM(seller_net_amount),0)::numeric(14,2) AS seller_net
         FROM siton.platform_fee_money_events WHERE seller_id=$1`,
        [sellerId]
      );
      const delivery = await c.query(
        `SELECT COALESCE(fu.status,'') AS delivery_status, COUNT(*)::int AS cnt
         FROM siton.fulfillment_units fu
         JOIN siton.deals d ON d.deal_id = fu.deal_id
         WHERE d.seller_id=$1
         GROUP BY 1`,
        [sellerId]
      ).catch(() => ({ rows: [] as any[] }));
      const tickets = await c.query(
        `SELECT ticket_id, scope_type, scope_key, title, priority, status, created_at
         FROM siton.support_tickets
         WHERE (scope_type='seller' AND scope_key=$1)
            OR (scope_type='deal' AND scope_key IN (SELECT deal_id::text FROM siton.deals WHERE seller_id=$1))
         ORDER BY created_at DESC LIMIT 20`,
        [sellerId]
      );
      const audit = await c.query(
        `SELECT audit_id, entity_type, entity_id, state_type, from_state, to_state, action_name, created_at
         FROM siton.audit_log
         WHERE deal_id IN (SELECT deal_id FROM siton.deals WHERE seller_id=$1)
         ORDER BY created_at DESC LIMIT 25`,
        [sellerId]
      );
      const dlqRelated = await c.query(
        `SELECT event_type, aggregate_id, updated_at AS archived_at
         FROM siton.outbox_dlq
         WHERE aggregate_id::text IN (SELECT deal_id::text FROM siton.deals WHERE seller_id=$1)
         ORDER BY updated_at DESC NULLS LAST LIMIT 10`,
        [sellerId]
      );
      const viral = await readViralMetricsCache(c, "seller", sellerId);
      const warnings: string[] = [];
      for (const d of deals.rows as any[]) {
        if (d.state === "CompletionWindow") warnings.push(`deal_in_completion_window:${d.deal_id}`);
        if (Number(d.in_recovery || 0) > 0) warnings.push(`participants_in_recovery:${d.deal_id}:${d.in_recovery}`);
      }
      if (dlqRelated.rows.length) warnings.push(`dlq_events_related:${dlqRelated.rows.length}`);
      return {
        ok: true,
        seller: seller.rows[0],
        deals: deals.rows,
        money: {
          platform_fee_actual: Number(fee.rows[0].fee_actual || 0),
          seller_net_actual: Number(fee.rows[0].seller_net || 0),
          potential_gross: deals.rows.reduce((s: number, d: any) => s + Number(d.potential_gross || 0), 0),
          charged_gross: deals.rows.reduce((s: number, d: any) => s + Number(d.charged_gross || 0), 0)
        },
        delivery_status_counts: Object.fromEntries((delivery.rows as any[]).map((r) => [r.delivery_status || "unknown", Number(r.cnt)])),
        support_tickets: tickets.rows,
        audit_tail: audit.rows,
        dlq_related: dlqRelated.rows,
        viral,
        warnings
      };
    });
  });

  // Admin: global audit tail (read-only, human-readable projection).
  app.get("/api/admin/r6/audit", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const q = String(req.query?.q || "").trim().slice(0, 120);
    return deps.withTx(async (c) => {
      const rows = await c.query(
        `SELECT a.audit_id, a.entity_type, a.entity_id, a.deal_id, a.state_type,
                a.from_state, a.to_state, a.action_name, a.correlation_id, a.created_at,
                d.title AS deal_title
         FROM siton.audit_log a
         LEFT JOIN siton.deals d ON d.deal_id = a.deal_id
         WHERE ($1 = '' OR a.action_name ILIKE '%' || $1 || '%' OR a.deal_id::text = $1 OR a.entity_id::text = $1 OR a.correlation_id ILIKE '%' || $1 || '%')
         ORDER BY a.created_at DESC
         LIMIT 120`,
        [q]
      );
      return { ok: true, audit: rows.rows };
    });
  });

  // Admin: buyers/participants roster (aggregated by buyer identity).
  // SHELF REINTEGRATION (PR #7 residual slice) — intent-sensitive search
  // (src/buyer_search_intent.ts): letters go to the NAME only, digits to the
  // phone, "@" to the e-mail, CT-… to the order code, a uuid to technical ids.
  // The old roster searched four hidden fields at once and then DISPLAYED a
  // different aggregate value, so typing "ש" could return a buyer whose visible
  // name had no ש. The predicate now runs on the DISPLAYED values of the
  // aggregated row and every hit says why it matched.
  app.get("/api/admin/r6/buyers", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const plan = classifyBuyerSearch(req.query?.q);
    const rank = buyerNameRankSql(plan, "p", 1);
    const predicate = buyerSearchPredicateSql(plan, "agg", 1 + rank.params.length);
    return deps.withTx(async (c) => {
      const rows = await c.query(
        `WITH agg AS (
           SELECT p.buyer_id,
                  (ARRAY_AGG(p.buyer_name ORDER BY (p.buyer_name IS NOT NULL) DESC, ${rank.sql}p.created_at DESC))[1] AS buyer_name,
                  (ARRAY_AGG(p.buyer_phone ORDER BY (p.buyer_phone IS NOT NULL) DESC, p.created_at DESC))[1] AS buyer_phone,
                  (ARRAY_AGG(p.buyer_email ORDER BY (p.buyer_email IS NOT NULL) DESC, p.created_at DESC))[1] AS buyer_email,
                  COUNT(*)::int AS participations,
                  COUNT(DISTINCT p.deal_id)::int AS deals,
                  COALESCE(SUM(p.qty) FILTER (WHERE p.buyer_state NOT IN ('NotJoined','DealFailed','Dropped')),0)::int AS units_joined,
                  COALESCE(SUM(p.qty) FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::int AS units_charged,
                  COALESCE(SUM(p.qty * d.price_per_unit + p.delivery_cost)
                    FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge')),0)::numeric(14,2) AS charged_gross,
                  COUNT(*) FILTER (WHERE p.money_state='ChargeFailedRecovery')::int AS in_recovery,
                  (ARRAY_AGG(p.buyer_state ORDER BY p.updated_at DESC))[1] AS latest_buyer_state,
                  (ARRAY_AGG(p.money_state ORDER BY p.updated_at DESC))[1] AS latest_money_state,
                  MAX(GREATEST(p.created_at, p.updated_at)) AS last_activity_at,
                  MAX(p.created_at) AS last_join_at
           FROM siton.participants p
           JOIN siton.deals d ON d.deal_id = p.deal_id
           GROUP BY p.buyer_id
         )
         SELECT * FROM agg
         WHERE ${predicate.sql}
         ORDER BY last_join_at DESC
         LIMIT 200`,
        [...rank.params, ...predicate.params]
      );
      // Verification is REAL, never fabricated: a contact is verified ONLY if a
      // verified OTP challenge exists for its normalized-destination hash (same
      // hashing as src/otp_rail.ts hashDestination). Hashes computed here (not
      // in SQL) to avoid an extensions.digest grant dependency. With OTP off by
      // default (R5 policy) this is honestly false for guest joins.
      const emailHashes = new Map<string, string>();
      const phoneHashes = new Map<string, string>();
      for (const b of rows.rows) {
        if (b.buyer_email) emailHashes.set(String(b.buyer_id), hashDestination("email", String(b.buyer_email)));
        const phone = b.buyer_phone || b.buyer_id;
        if (phone) phoneHashes.set(String(b.buyer_id), hashDestination("sms", String(phone)));
      }
      const allHashes = [...new Set([...emailHashes.values(), ...phoneHashes.values()])];
      const verified = new Set<string>();
      if (allHashes.length) {
        const vr = await c.query(
          `SELECT DISTINCT channel, destination_hash FROM siton.otp_challenges
           WHERE status='verified' AND destination_hash = ANY($1::text[])`,
          [allHashes]
        );
        for (const row of vr.rows) verified.add(`${row.channel}:${row.destination_hash}`);
      }
      const buyers = rows.rows.map((b: any) => ({
        ...b,
        email_verified: emailHashes.has(String(b.buyer_id)) && verified.has(`email:${emailHashes.get(String(b.buyer_id))}`),
        phone_verified: phoneHashes.has(String(b.buyer_id)) && verified.has(`sms:${phoneHashes.get(String(b.buyer_id))}`),
        match: plan.intent === "empty" ? null : { field: plan.intent, label_he: plan.match_label_he }
      }));
      return {
        ok: true,
        buyers,
        contact_privacy: "admin_only",
        search: { intent: plan.intent, label_he: plan.label_he, normalized: plan.normalized, tokens: plan.tokens }
      };
    });
  });
}
