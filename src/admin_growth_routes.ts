// ADMIN GROWTH — the read-only owner/admin pilot, growth and viral analytics
// reads: pilot metrics, the windowed growth dashboard, and the per-deal viral
// metrics, viral-tree level and propagation-source reads.
//
// Lean Refactor: the five routes below were moved verbatim out of
// src/frontend_runtime.ts. Nothing about them changed: same methods and paths,
// same admin read guard (requireAdminRead) as the first statement of every
// handler, same validation order (uuid and growth-window checks after the
// guard), same schema checks before the transaction, same SQL and transaction
// boundaries (one deps.withTx per request), same status codes and response
// shapes. The runtime hands this module exactly the closures it used before
// (dependency injection), including the canonical viral-tree / propagation
// engine, which stays defined in src/frontend_runtime.ts because the seller
// variants share it; no guard or helper was copied. Every route is a GET: the
// module performs no write.
import type { FastifyInstance } from "fastify";
import { computeGrowthWindowMetrics } from "./growth_metrics.js";
import { resolveGrowthWindow } from "./growth_window.js";
import { readViralMetricsCache } from "./viral_graph.js";

type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;
type SchemaCheck = () => Promise<unknown>;

export type AdminGrowthRouteDeps = {
  withTx: WithTx;
  /** The runtime's admin READ guard. Owns the denial response. */
  requireAdminRead: (req: any, reply: any) => Promise<boolean>;
  /** The runtime's uuid validator: throws a 400 error for a malformed id. */
  requireUuid: (value: string, fieldName: string) => void;
  /** The runtime's memoized schema checks. */
  ensureProductSurfaces: SchemaCheck;
  ensureInquiryTables: SchemaCheck;
  /** The runtime's canonical viral-tree engine (shared with the seller explorer): one level of children per request. */
  queryViralTreeLevel: (c: any, dealId: string, parentId: string | null, limit: number, sourceKey?: string | null) => Promise<any>;
  /** The runtime's canonical propagation-source read (shared with the seller explorer); null when the deal does not exist. */
  queryPropagationSources: (c: any, dealId: string) => Promise<any>;
  /** The runtime's viral-tree query parser (parent / source / limit), shared with the seller explorer. */
  viralTreeQueryParams: (req: any) => { parentId: string | null; sourceKey: string | null; limit: number };
};

export function registerAdminGrowthRoutes(app: FastifyInstance, deps: AdminGrowthRouteDeps) {
  const {
    requireAdminRead,
    requireUuid,
    ensureProductSurfaces,
    ensureInquiryTables,
    queryViralTreeLevel,
    queryPropagationSources,
    viralTreeQueryParams
  } = deps;

  // Admin: platform growth/virality dashboard (cached platform scope).
  // LAUNCH MODE — owner pilot metrics: the questions a closed web pilot must
  // answer (how many sellers entered / created / published; how many buyers
  // viewed / tried / joined; conversion; thresholds reached; repeat sellers).
  // Read-only, aggregate, no PII. Window defaults to 30 days.
  app.get("/api/admin/pilot-metrics", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const daysRaw = Number(req.query?.days);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(365, Math.floor(daysRaw)) : 30;
    const since = `now() - ($1::int * interval '1 day')`;
    await ensureProductSurfaces();  // Black-Sky C2: schema check BEFORE taking the transaction's connection
    await ensureInquiryTables();
    return deps.withTx(async (c) => {
      const [sellers, deals, events, joins, inquiries, feedbackByCategory, feedbackRecent, perSeller] = await Promise.all([
        c.query(
          `WITH s AS (
             SELECT sa.seller_id, sa.created_at, COALESCE(sa.verification_status,'pending') AS verification_status,
                    (sa.auth_user_id IS NOT NULL AND sa.seller_id <> 'c-ton-owner') AS self_signup
             FROM siton.seller_accounts sa
           ), d AS (
             SELECT seller_id, COUNT(*)::int AS drafts, COUNT(*) FILTER (WHERE published_at IS NOT NULL)::int AS published
             FROM siton.deals WHERE seller_id IS NOT NULL GROUP BY seller_id
           )
           SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE s.self_signup)::int AS signed_up,
                  COUNT(*) FILTER (WHERE s.self_signup AND s.created_at >= ${since})::int AS signed_up_in_window,
                  COUNT(*) FILTER (WHERE s.verification_status='pending')::int AS pending_approval,
                  COUNT(*) FILTER (WHERE s.verification_status='approved')::int AS approved,
                  COUNT(*) FILTER (WHERE COALESCE(d.drafts,0) > 0)::int AS created_a_deal,
                  COUNT(*) FILTER (WHERE COALESCE(d.published,0) > 0)::int AS published_a_deal,
                  COUNT(*) FILTER (WHERE COALESCE(d.published,0) >= 2)::int AS repeat_publishers
           FROM s LEFT JOIN d ON d.seller_id = s.seller_id`,
          [days]
        ),
        c.query(
          `SELECT COUNT(*)::int AS drafts_created,
                  COUNT(*) FILTER (WHERE published_at IS NOT NULL)::int AS published,
                  COUNT(*) FILTER (WHERE state IN ('PendingTarget','TargetReached','ClosedForJoining'))::int AS open_now,
                  COUNT(*) FILTER (WHERE state IN ('ReadyForCharging','Charging','CompletionWindow'))::int AS settling,
                  COUNT(*) FILTER (WHERE state='Completed')::int AS completed,
                  COUNT(*) FILTER (WHERE state='Failed')::int AS failed,
                  COUNT(*) FILTER (WHERE state='Cancelled')::int AS cancelled,
                  (SELECT COUNT(DISTINCT deal_id) FROM siton.audit_log
                    WHERE action_name='deal.target_reached' AND created_at >= ${since})::int AS reached_threshold
           FROM siton.deals WHERE created_at >= ${since}`,
          [days]
        ),
        c.query(
          `SELECT COUNT(*) FILTER (WHERE event_type='deal_view')::int AS deal_views,
                  COUNT(DISTINCT visitor_id) FILTER (WHERE event_type='deal_view')::int AS unique_visitors,
                  COUNT(*) FILTER (WHERE event_type='share_button_click')::int AS share_clicks,
                  COUNT(*) FILTER (WHERE event_type='join_started')::int AS join_starts,
                  COUNT(*) FILTER (WHERE event_type='join_failed')::int AS join_failures,
                  COUNT(*) FILTER (WHERE event_type='inquiry_started')::int AS inquiry_starts
           FROM siton.viral_events WHERE created_at >= ${since}`,
          [days]
        ),
        c.query(
          `SELECT COUNT(*)::int AS joins,
                  COUNT(DISTINCT buyer_id)::int AS distinct_buyers,
                  COUNT(*) FILTER (WHERE money_state IN ('ChargedSuccess','RecoveredCharge'))::int AS charged
           FROM siton.participants WHERE created_at >= ${since}`,
          [days]
        ),
        c.query(
          `SELECT COUNT(*)::int AS threads,
                  COUNT(*) FILTER (WHERE last_sender_type='Seller' OR status='Answered')::int AS answered
           FROM siton.seller_inquiry_threads WHERE created_at >= ${since}`,
          [days]
        ),
        // LAUNCH POLISH 2 (P6) — buyer feedback aggregate (the category key is
        // the first description line; the optional free text is the last one)
        c.query(
          `SELECT COALESCE(substring(description from '(?:^|\\n)קטגוריה: ([a-z_]+)'), 'unknown') AS category,
                  COUNT(*)::int AS cnt
           FROM siton.operational_cases
           WHERE opened_by = 'buyer_feedback' AND created_at >= ${since}
           GROUP BY 1 ORDER BY cnt DESC`,
          [days]
        ),
        c.query(
          `SELECT COALESCE(substring(description from '(?:^|\\n)קטגוריה: ([a-z_]+)'), 'unknown') AS category,
                  substring(description from '\\nטקסט: (.*)$') AS text,
                  created_at
           FROM siton.operational_cases
           WHERE opened_by = 'buyer_feedback' AND created_at >= ${since}
             AND description LIKE '%טקסט: %'
           ORDER BY created_at DESC LIMIT 12`,
          [days]
        ),
        c.query(
          `SELECT sa.seller_id,
                  COALESCE(NULLIF(btrim(sa.business_name),''), sa.display_name) AS name,
                  COALESCE(sa.verification_status,'pending') AS verification_status,
                  (sa.auth_user_id IS NOT NULL) AS bound,
                  sa.created_at,
                  COUNT(d.deal_id)::int AS drafts,
                  COUNT(d.deal_id) FILTER (WHERE d.published_at IS NOT NULL)::int AS published,
                  COUNT(d.deal_id) FILTER (WHERE d.state='Completed')::int AS completed,
                  COUNT(d.deal_id) FILTER (WHERE d.state='Failed')::int AS failed,
                  MAX(d.published_at) AS last_published_at
           FROM siton.seller_accounts sa
           LEFT JOIN siton.deals d ON d.seller_id = sa.seller_id
           GROUP BY sa.seller_id
           ORDER BY MAX(d.created_at) DESC NULLS LAST, sa.created_at DESC
           LIMIT 100`
        )
      ]);
      const ev = events.rows[0] || {};
      const jn = joins.rows[0] || {};
      const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
      return {
        ok: true,
        window_days: days,
        generated_at: new Date().toISOString(),
        sellers: sellers.rows[0],
        deals: deals.rows[0],
        buyers: {
          ...ev,
          joins: Number(jn.joins || 0),
          distinct_buyers: Number(jn.distinct_buyers || 0),
          charged: Number(jn.charged || 0),
          view_to_join_start_pct: pct(Number(ev.join_starts || 0), Number(ev.deal_views || 0)),
          join_start_to_join_pct: pct(Number(jn.joins || 0), Number(ev.join_starts || 0)),
          view_to_join_pct: pct(Number(jn.joins || 0), Number(ev.deal_views || 0))
        },
        inquiries: inquiries.rows[0],
        feedback: {
          total: feedbackByCategory.rows.reduce((sum: number, r: any) => sum + Number(r.cnt || 0), 0),
          by_category: feedbackByCategory.rows.map((r: any) => ({ category: String(r.category), count: Number(r.cnt || 0) })),
          recent: feedbackRecent.rows.map((r: any) => ({ category: String(r.category), text: String(r.text || "").slice(0, 280), at: r.created_at }))
        },
        per_seller: perSeller.rows
      };
    });
  });

  // SHELF REINTEGRATION (PR #7 residual slice) — the virality dashboard is
  // WINDOWED: default last 7 days, presets 7/30/90, a custom [from,to) range
  // (UTC instants; the UI enters Israel-local days) or all time. The window
  // drives every number in `windowed` (src/growth_metrics.ts computes them
  // live), not just a label. The lifetime rollup stays a separate, explicitly
  // labelled block. The old hardcoded `last_7_days` card is GONE: it mixed a
  // fixed seven-day number into a screen whose other numbers followed the
  // selected range, which is exactly the kind of quiet lie this rewrite exists
  // to remove.
  app.get("/api/admin/growth", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const resolved = resolveGrowthWindow(req.query || {});
    if (!resolved.ok) return reply.code(400).send({ ok: false, error: resolved.error, message: resolved.message_he });
    const window = resolved.window;
    return deps.withTx(async (c) => {
      const platform = await readViralMetricsCache(c, "platform", "global");
      const windowed = await computeGrowthWindowMetrics(c, window);
      return {
        ok: true,
        window,
        windowed,
        lifetime: { ...platform, label_he: "מצטבר מאז ההשקה (כל הזמן)" },
        // kept for older readers of this payload; identical to `lifetime`
        platform
      };
    });
  });

  // Admin: per-deal viral metrics + tree explorer payload.
  app.get("/api/admin/deals/:dealId/viral", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const dealId = String(req.params.dealId || "");
    requireUuid(dealId, "deal_id");
    return deps.withTx(async (c) => {
      const cached = await readViralMetricsCache(c, "deal", dealId);
      return { ok: true, deal_id: dealId, ...cached };
    });
  });

  app.get("/api/admin/deals/:dealId/viral-tree", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const dealId = String(req.params.dealId || "");
    requireUuid(dealId, "deal_id");
    const { parentId, sourceKey, limit } = viralTreeQueryParams(req);
    return deps.withTx(async (c) => queryViralTreeLevel(c, dealId, parentId, limit, sourceKey));
  });

  app.get("/api/admin/deals/:dealId/propagation", async (req: any, reply: any) => {
    if (!(await requireAdminRead(req, reply))) return;
    const dealId = String(req.params.dealId || "");
    requireUuid(dealId, "deal_id");
    return deps.withTx(async (c) => {
      const result = await queryPropagationSources(c, dealId);
      if (!result) return reply.code(404).send({ ok: false, error: "deal not found", code: "deal_not_found" });
      return result;
    });
  });
}
