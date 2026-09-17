// SELLER DISTRIBUTION HUB — attribution + analytics ONLY.
//
// A seller mints several distribution links for the same deal and measures
// each one separately (entries, unique visitors, joins, joined units, FINAL
// charged units, gross actually collected, conversions, time series).
//
// Everything here reuses the canonical rails instead of creating a parallel
// system:
//   * links            -> siton.affiliate_links (origin_type='seller', no
//                         affiliate account; the seller owns them through the
//                         deal's seller_id)
//   * entries/visitors -> siton.affiliate_link_events (PII-free; opaque
//                         visitor_id only)
//   * join attribution -> siton.viral_attributions.parent_link_id, resolved by
//                         the existing last-touch rule INSIDE the Join
//                         transaction (viral_graph.recordViralJoinAttribution)
//   * money truth      -> participants.money_state (ChargedSuccess /
//                         RecoveredCharge) + platform_fee_money_events gross
//                         actually collected (same source as seller analytics)
//
// ATTRIBUTION RULE (single, documented): a Join is attributed to the LAST
// ELIGIBLE DISTRIBUTION LINK the buyer touched before joining. "Eligible"
// means: a link of the SAME deal that was active (not disabled) at Join time.
// The browser keeps the last touched code across navigation, OTP, login,
// checkout and refresh (localStorage, see web/src/viral.ts) and the server
// resolves it authoritatively at Join. No multi-touch model.
//
// Money: nothing here creates commission, balance, payout, invoice or any
// entitlement. Siton does not compute or manage any settlement between the
// seller and a link holder; if they agree on anything, it is a private,
// external arrangement. Siton's own platform fee is untouched.
//
// External access: the seller MAY hand a link's dashboard to an external
// person. That identity is a scoped, read-only analytics credential: it sees
// aggregated counters of ONE granted link and nothing else — no seller
// surface, no other links, no participants, no PII. Authorization is enforced
// here, in the backend; the frontend is never an authority.

import type { FastifyInstance, FastifyReply } from "fastify";
import { createHash, randomBytes } from "node:crypto";

import { hashSellerAccessSecret, parseCookies, verifySellerAccessSecret } from "./seller_auth.js";
import { isProductionLikeEnv } from "./runtime_config.js";

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };
type WithTx = (fn: (c: any) => Promise<any>) => Promise<any>;

export type DistributionRange = "24h" | "7d" | "30d" | "all";
export const DISTRIBUTION_RANGES: readonly DistributionRange[] = ["24h", "7d", "30d", "all"];

export const LINK_VIEWER_SESSION_COOKIE = "siton_link_viewer_session";
export const LINK_VIEWER_SESSION_TTL_SECONDS = 60 * 60 * 12;
export const LINK_VIEWER_LOGIN_WINDOW_MINUTES = 15;
export const LINK_VIEWER_LOGIN_MAX_ATTEMPTS = 8;
export const LINK_VIEWER_LOGIN_PATH = "/preview/#/link-dashboard";

export const DISTRIBUTION_ATTRIBUTION_RULE = {
  code: "last_eligible_distribution_link_before_join",
  description_he:
    "הצטרפות משויכת ללינק ההפצה האחרון שהקונה נכנס דרכו לפני ההצטרפות, בתנאי שהלינק שייך לאותה עסקה והיה פעיל בזמן ההצטרפות."
} as const;

export const DISTRIBUTION_DISCLAIMER_HE =
  "הנתונים המוצגים הם נתוני מדידה וייחוס בלבד. סיטון אינה מחשבת או מנהלת עמלה או התחשבנות בין המוכר לבעל הלינק.";

const SUCCESS_MONEY_STATES_SQL = `('ChargedSuccess','RecoveredCharge')`;
const LINK_CHANNEL_MAX = 40;
const LINK_NAME_MAX = 80;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── session secret / cookie helpers (same shape as buyer/seller sessions) ───

export function linkViewerSessionSecret(env: NodeJS.ProcessEnv = process.env) {
  const configured = String(
    env.LINK_VIEWER_SESSION_SECRET || env.BUYER_SESSION_SECRET || env.OTP_TOKEN_SECRET || ""
  ).trim();
  if (configured) return configured;
  return isProductionLikeEnv(env) ? "" : "siton-link-viewer-session-local-only";
}

export function linkViewerAuthConfigured(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(linkViewerSessionSecret(env));
}

export function hashLinkViewerSessionToken(token: unknown, env: NodeJS.ProcessEnv = process.env) {
  const raw = String(token || "").trim();
  const secret = linkViewerSessionSecret(env);
  if (!raw || !secret) return null;
  return createHash("sha256").update(`${secret}:${raw}`).digest("hex");
}

export function readLinkViewerSessionToken(req: any) {
  return String(parseCookies(req?.headers?.cookie)[LINK_VIEWER_SESSION_COOKIE] || "").trim();
}

export function serializeLinkViewerSessionCookie(token: string, options?: { secure?: boolean }) {
  return `${LINK_VIEWER_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LINK_VIEWER_SESSION_TTL_SECONDS}${options?.secure ? "; Secure" : ""}`;
}

export function serializeExpiredLinkViewerSessionCookie(options?: { secure?: boolean }) {
  return `${LINK_VIEWER_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${options?.secure ? "; Secure" : ""}`;
}

// ── pure helpers ────────────────────────────────────────────────────────────

export function normalizeDistributionRange(value: unknown): DistributionRange {
  const raw = String(value || "").trim().toLowerCase();
  return (DISTRIBUTION_RANGES as readonly string[]).includes(raw) ? (raw as DistributionRange) : "7d";
}

export function generateDistributionSourceCode(): string {
  // Opaque: never contains seller, deal or link ids. Matches the canonical
  // source_code pattern ^[a-z0-9][a-z0-9_-]{7,63}$.
  return `s${randomBytes(7).toString("hex")}`;
}

export function generateLinkViewerUsername(): string {
  return `lv-${randomBytes(4).toString("hex")}`;
}

export function generateLinkViewerPassword(): string {
  return randomBytes(12).toString("base64url");
}

export function distributionShareUrl(dealId: string, sourceCode: string): string {
  // Same crawler-readable share route the personal links use; the buyer sees
  // exactly the same deal page as a direct visitor (tracking only).
  return `/d/${encodeURIComponent(dealId)}?ref=${encodeURIComponent(sourceCode)}`;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value: unknown): number {
  return Math.round(num(value) * 100) / 100;
}

function ratio(part: number, whole: number): number {
  if (!whole || whole <= 0) return 0;
  return Math.round((part / whole) * 10000) / 10000;
}

function fail(message: string, statusCode: number, code?: string): never {
  const err: any = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  throw err;
}

function requireUuid(value: unknown, field: string): string {
  const raw = String(value || "").trim();
  if (!UUID_RE.test(raw)) fail(`${field} must be a valid uuid`, 400, "invalid_id");
  return raw.toLowerCase();
}

function normalizeLinkName(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, LINK_NAME_MAX);
}

function normalizeChannel(value: unknown): string | null {
  const raw = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, LINK_CHANNEL_MAX);
  return raw || null;
}

function requestClientIp(req: any) {
  return String(req?.ip || req?.headers?.["x-forwarded-for"] || req?.headers?.["x-real-ip"] || "").split(",")[0]!.trim().slice(0, 120);
}

// ── metrics ─────────────────────────────────────────────────────────────────

export interface LinkTotals {
  entries: number;
  unique_visitors: number;
  joins: number;
  joined_units: number;
  charged_participants: number;
  charged_units: number;
  attributed_gross: number;
  conversion_entry_to_join: number;
  conversion_entry_to_final_charge: number;
}

export function emptyTotals(): LinkTotals {
  return {
    entries: 0,
    unique_visitors: 0,
    joins: 0,
    joined_units: 0,
    charged_participants: 0,
    charged_units: 0,
    attributed_gross: 0,
    conversion_entry_to_join: 0,
    conversion_entry_to_final_charge: 0
  };
}

function finishTotals(t: Omit<LinkTotals, "conversion_entry_to_join" | "conversion_entry_to_final_charge">): LinkTotals {
  return {
    ...t,
    conversion_entry_to_join: ratio(t.joins, t.entries),
    conversion_entry_to_final_charge: ratio(t.charged_participants, t.entries)
  };
}

// Aggregated counters for a set of links. `since` (nullable) scopes every
// counter to events at/after that instant: entries by event time, joins by
// participant creation, final charges by the charge time (money event time,
// or the participant's last money-state change when no money event exists).
export async function loadLinkTotals(
  c: Queryable,
  linkIds: string[],
  since: Date | null = null
): Promise<Map<string, LinkTotals>> {
  const out = new Map<string, LinkTotals>();
  if (!linkIds.length) return out;
  const sinceIso = since ? since.toISOString() : null;

  const [entryRes, joinRes] = await Promise.all([
    c.query(
      `SELECT link_id::text AS link_id,
              COUNT(*)::int AS entries,
              COUNT(DISTINCT visitor_id)::int AS unique_visitors
       FROM siton.affiliate_link_events
       WHERE link_id = ANY($1::uuid[]) AND event_type='entry'
         AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
       GROUP BY link_id`,
      [linkIds, sinceIso]
    ),
    c.query(
      `WITH attributed AS (
         SELECT va.parent_link_id::text AS link_id, p.participant_id, p.qty, p.buyer_state, p.money_state,
                p.created_at AS joined_at, p.updated_at,
                (p.qty * d.price_per_unit + COALESCE(p.delivery_cost, 0))::numeric(14,2) AS computed_gross
         FROM siton.viral_attributions va
         JOIN siton.participants p ON p.participant_id = va.participant_id
         JOIN siton.deals d ON d.deal_id = p.deal_id
         WHERE va.parent_link_id = ANY($1::uuid[])
       ),
       charged AS (
         SELECT a.link_id, a.participant_id, a.qty,
                COALESCE(m.gross_sum, a.computed_gross)::numeric(14,2) AS gross,
                COALESCE(m.first_at, a.updated_at) AS charged_at
         FROM attributed a
         LEFT JOIN LATERAL (
           SELECT SUM(gross_amount) AS gross_sum, MIN(created_at) AS first_at
           FROM siton.platform_fee_money_events m
           WHERE m.participant_id = a.participant_id AND m.logical_entry_type = 'charge'
         ) m ON true
         WHERE a.money_state IN ${SUCCESS_MONEY_STATES_SQL}
       )
       SELECT ids.link_id::text AS link_id,
              (SELECT COUNT(*)::int FROM attributed a
                WHERE a.link_id = ids.link_id::text AND a.buyer_state <> 'NotJoined'
                  AND ($2::timestamptz IS NULL OR a.joined_at >= $2::timestamptz)) AS joins,
              (SELECT COALESCE(SUM(a.qty), 0)::int FROM attributed a
                WHERE a.link_id = ids.link_id::text AND a.buyer_state <> 'NotJoined'
                  AND ($2::timestamptz IS NULL OR a.joined_at >= $2::timestamptz)) AS joined_units,
              (SELECT COUNT(*)::int FROM charged ch
                WHERE ch.link_id = ids.link_id::text
                  AND ($2::timestamptz IS NULL OR ch.charged_at >= $2::timestamptz)) AS charged_participants,
              (SELECT COALESCE(SUM(ch.qty), 0)::int FROM charged ch
                WHERE ch.link_id = ids.link_id::text
                  AND ($2::timestamptz IS NULL OR ch.charged_at >= $2::timestamptz)) AS charged_units,
              (SELECT COALESCE(SUM(ch.gross), 0)::numeric(14,2) FROM charged ch
                WHERE ch.link_id = ids.link_id::text
                  AND ($2::timestamptz IS NULL OR ch.charged_at >= $2::timestamptz)) AS attributed_gross
       FROM unnest($1::uuid[]) AS ids(link_id)`,
      [linkIds, sinceIso]
    )
  ]);

  const entriesByLink = new Map<string, any>(entryRes.rows.map((r: any) => [String(r.link_id), r]));
  for (const row of joinRes.rows as any[]) {
    const linkId = String(row.link_id);
    const e = entriesByLink.get(linkId) || {};
    out.set(
      linkId,
      finishTotals({
        entries: num(e.entries),
        unique_visitors: num(e.unique_visitors),
        joins: num(row.joins),
        joined_units: num(row.joined_units),
        charged_participants: num(row.charged_participants),
        charged_units: num(row.charged_units),
        attributed_gross: money(row.attributed_gross)
      })
    );
  }
  for (const id of linkIds) if (!out.has(id)) out.set(id, emptyTotals());
  return out;
}

export interface SeriesPoint {
  t: string;
  entries: number;
  unique_visitors: number;
  joins: number;
  joined_units: number;
  charged_units: number;
  attributed_gross: number;
}

function rangeSince(range: DistributionRange, linkCreatedAt: Date, now: Date): { since: Date; bucket: "hour" | "day" } {
  if (range === "24h") return { since: new Date(now.getTime() - 24 * 3600_000), bucket: "hour" };
  if (range === "7d") return { since: new Date(now.getTime() - 7 * 24 * 3600_000), bucket: "day" };
  if (range === "30d") return { since: new Date(now.getTime() - 30 * 24 * 3600_000), bucket: "day" };
  return { since: linkCreatedAt, bucket: "day" };
}

function truncate(date: Date, bucket: "hour" | "day"): Date {
  const d = new Date(date.getTime());
  if (bucket === "hour") d.setUTCMinutes(0, 0, 0);
  else d.setUTCHours(0, 0, 0, 0);
  return d;
}

const MAX_SERIES_POINTS = 400;

export async function loadLinkSeries(
  c: Queryable,
  linkId: string,
  range: DistributionRange,
  linkCreatedAt: Date,
  now = new Date()
): Promise<{ bucket: "hour" | "day"; since: string; until: string; points: SeriesPoint[] }> {
  const { since, bucket } = rangeSince(range, linkCreatedAt, now);
  const stepMs = bucket === "hour" ? 3600_000 : 24 * 3600_000;
  let start = truncate(since, bucket);
  const end = truncate(now, bucket);
  // Bound the number of buckets; a very old link in "all" starts later so the
  // response stays small (the totals stay all-time regardless).
  if ((end.getTime() - start.getTime()) / stepMs > MAX_SERIES_POINTS) {
    start = new Date(end.getTime() - MAX_SERIES_POINTS * stepMs);
  }
  const sinceIso = start.toISOString();

  const [entryRes, joinRes, chargeRes] = await Promise.all([
    c.query(
      `SELECT date_trunc($3, created_at) AS t,
              COUNT(*)::int AS entries,
              COUNT(DISTINCT visitor_id)::int AS unique_visitors
       FROM siton.affiliate_link_events
       WHERE link_id=$1 AND event_type='entry' AND created_at >= $2::timestamptz
       GROUP BY 1`,
      [linkId, sinceIso, bucket]
    ),
    c.query(
      `SELECT date_trunc($3, p.created_at) AS t,
              COUNT(*)::int AS joins,
              COALESCE(SUM(p.qty), 0)::int AS joined_units
       FROM siton.viral_attributions va
       JOIN siton.participants p ON p.participant_id = va.participant_id
       WHERE va.parent_link_id=$1 AND p.buyer_state <> 'NotJoined' AND p.created_at >= $2::timestamptz
       GROUP BY 1`,
      [linkId, sinceIso, bucket]
    ),
    c.query(
      `WITH charged AS (
         SELECT p.qty,
                COALESCE(m.gross_sum, (p.qty * d.price_per_unit + COALESCE(p.delivery_cost, 0)))::numeric(14,2) AS gross,
                COALESCE(m.first_at, p.updated_at) AS charged_at
         FROM siton.viral_attributions va
         JOIN siton.participants p ON p.participant_id = va.participant_id
         JOIN siton.deals d ON d.deal_id = p.deal_id
         LEFT JOIN LATERAL (
           SELECT SUM(gross_amount) AS gross_sum, MIN(created_at) AS first_at
           FROM siton.platform_fee_money_events m
           WHERE m.participant_id = p.participant_id AND m.logical_entry_type = 'charge'
         ) m ON true
         WHERE va.parent_link_id=$1 AND p.money_state IN ${SUCCESS_MONEY_STATES_SQL}
       )
       SELECT date_trunc($3, charged_at) AS t,
              COALESCE(SUM(qty), 0)::int AS charged_units,
              COALESCE(SUM(gross), 0)::numeric(14,2) AS attributed_gross
       FROM charged
       WHERE charged_at >= $2::timestamptz
       GROUP BY 1`,
      [linkId, sinceIso, bucket]
    )
  ]);

  const keyOf = (value: unknown) => truncate(new Date(String(value)), bucket).toISOString();
  const byKey = new Map<string, SeriesPoint>();
  for (let t = start.getTime(); t <= end.getTime(); t += stepMs) {
    const iso = new Date(t).toISOString();
    byKey.set(iso, { t: iso, entries: 0, unique_visitors: 0, joins: 0, joined_units: 0, charged_units: 0, attributed_gross: 0 });
  }
  const ensure = (k: string) => {
    let p = byKey.get(k);
    if (!p) {
      p = { t: k, entries: 0, unique_visitors: 0, joins: 0, joined_units: 0, charged_units: 0, attributed_gross: 0 };
      byKey.set(k, p);
    }
    return p;
  };
  for (const r of entryRes.rows as any[]) {
    const p = ensure(keyOf(r.t));
    p.entries = num(r.entries);
    p.unique_visitors = num(r.unique_visitors);
  }
  for (const r of joinRes.rows as any[]) {
    const p = ensure(keyOf(r.t));
    p.joins = num(r.joins);
    p.joined_units = num(r.joined_units);
  }
  for (const r of chargeRes.rows as any[]) {
    const p = ensure(keyOf(r.t));
    p.charged_units = num(r.charged_units);
    p.attributed_gross = money(r.attributed_gross);
  }
  const points = [...byKey.values()].sort((a, b) => a.t.localeCompare(b.t));
  return { bucket, since: start.toISOString(), until: now.toISOString(), points };
}

// ── link rows ───────────────────────────────────────────────────────────────

function linkStatus(row: any): "active" | "disabled" {
  return row.disabled_at ? "disabled" : "active";
}

function mapExternalAccess(row: any) {
  const enabled = Boolean(row?.viewer_id) && Boolean(row?.viewer_enabled) && !row?.viewer_revoked_at;
  return {
    enabled,
    username: enabled ? String(row.viewer_username) : null,
    created_at: enabled && row.viewer_created_at ? new Date(String(row.viewer_created_at)).toISOString() : null,
    last_login_at: enabled && row.viewer_last_login_at ? new Date(String(row.viewer_last_login_at)).toISOString() : null,
    login_path: LINK_VIEWER_LOGIN_PATH
  };
}

type SellerLinkView = ReturnType<typeof mapSellerLinkInner>;
function mapSellerLink(row: any, totals: LinkTotals): SellerLinkView {
  return mapSellerLinkInner(row, totals);
}
function mapSellerLinkInner(row: any, totals: LinkTotals) {
  return {
    link_id: String(row.link_id),
    deal_id: String(row.deal_id),
    internal_name: String(row.internal_name),
    channel: row.channel ? String(row.channel) : null,
    source_code: String(row.source_code),
    share_url: distributionShareUrl(String(row.deal_id), String(row.source_code)),
    status: linkStatus(row),
    created_at: new Date(String(row.created_at)).toISOString(),
    disabled_at: row.disabled_at ? new Date(String(row.disabled_at)).toISOString() : null,
    metrics: totals,
    external_access: mapExternalAccess(row)
  };
}

const SELLER_LINK_SELECT = `
  SELECT l.link_id, l.deal_id, l.internal_name, l.channel, l.source_code, l.created_at, l.disabled_at,
         v.viewer_id, v.username AS viewer_username, v.enabled AS viewer_enabled, v.revoked_at AS viewer_revoked_at,
         v.created_at AS viewer_created_at, v.last_login_at AS viewer_last_login_at
  FROM siton.affiliate_links l
  JOIN siton.deals d ON d.deal_id = l.deal_id
  LEFT JOIN LATERAL (
    SELECT v.viewer_id, v.username, v.enabled, v.revoked_at, v.created_at, v.last_login_at
    FROM siton.distribution_link_viewer_grants g
    JOIN siton.distribution_link_viewers v ON v.viewer_id = g.viewer_id
    WHERE g.link_id = l.link_id AND g.revoked_at IS NULL AND v.revoked_at IS NULL
    ORDER BY g.granted_at DESC
    LIMIT 1
  ) v ON true`;

async function loadSellerDeal(c: Queryable, sellerId: string, dealId: string) {
  const res = await c.query(
    `SELECT deal_id, title, state, published_at, price_per_unit
     FROM siton.deals WHERE deal_id=$1 AND seller_id=$2 LIMIT 1`,
    [dealId, sellerId]
  );
  return res.rows[0] || null;
}

async function loadSellerLinkRow(c: Queryable, sellerId: string, dealId: string, linkId: string) {
  const res = await c.query(
    `${SELLER_LINK_SELECT}
     WHERE l.link_id=$1 AND l.deal_id=$2 AND d.seller_id=$3 AND l.origin_type='seller'
     LIMIT 1`,
    [linkId, dealId, sellerId]
  );
  return res.rows[0] || null;
}

async function revokeViewerSessions(c: Queryable, viewerId: string, reason: string) {
  await c.query(
    `UPDATE siton.distribution_link_viewer_sessions
     SET revoked_at = now(), revoked_reason = $2
     WHERE viewer_id = $1 AND revoked_at IS NULL`,
    [viewerId, reason.slice(0, 120)]
  );
}

// ── link viewer session resolution (backend authority) ──────────────────────

export interface LinkViewerContext {
  viewer_id: string;
  username: string;
  grants: Array<{ link_id: string; link_name: string; deal_title: string; status: "active" | "disabled" }>;
}

export async function resolveLinkViewerContext(req: any, c: Queryable): Promise<LinkViewerContext | null> {
  if (!linkViewerAuthConfigured()) return null;
  const tokenHash = hashLinkViewerSessionToken(readLinkViewerSessionToken(req));
  if (!tokenHash) return null;
  const session = await c.query(
    `SELECT s.session_id, v.viewer_id, v.username
     FROM siton.distribution_link_viewer_sessions s
     JOIN siton.distribution_link_viewers v ON v.viewer_id = s.viewer_id
     WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now()
       AND v.enabled = true AND v.revoked_at IS NULL
     LIMIT 1`,
    [tokenHash]
  );
  const row = session.rows[0];
  if (!row) return null;
  const grants = await c.query(
    `SELECT l.link_id, l.internal_name, l.disabled_at, d.title AS deal_title
     FROM siton.distribution_link_viewer_grants g
     JOIN siton.affiliate_links l ON l.link_id = g.link_id
     JOIN siton.deals d ON d.deal_id = l.deal_id
     WHERE g.viewer_id=$1 AND g.revoked_at IS NULL
     ORDER BY g.granted_at ASC`,
    [row.viewer_id]
  );
  if (!grants.rowCount) return null;
  await c.query(`UPDATE siton.distribution_link_viewer_sessions SET last_seen_at = now() WHERE session_id=$1`, [row.session_id]);
  return {
    viewer_id: String(row.viewer_id),
    username: String(row.username),
    grants: grants.rows.map((g: any) => ({
      link_id: String(g.link_id),
      link_name: String(g.internal_name),
      deal_title: String(g.deal_title || ""),
      status: g.disabled_at ? "disabled" : "active"
    }))
  };
}

// ── route registration ──────────────────────────────────────────────────────

type Deps = {
  withTx: WithTx;
  /** Refusing guard: sends the seller-auth refusal itself and returns null. */
  requireSeller: (req: any, reply: any, c: any) => Promise<any>;
  /** Refusing guard for mutations (seller enforcement applied). */
  requireSellerOperate: (req: any, reply: any, c: any) => Promise<any>;
};

export function registerDistributionHubRoutes(app: FastifyInstance, deps: Deps) {
  const secureCookie = () => isProductionLikeEnv();

  // Refusing guard for the external link viewer surface. It answers BEFORE any
  // input or server state is observed, so a wrong link id, a malformed query
  // or a missing link all look identical to an anonymous caller.
  async function requireLinkViewer(req: any, reply: FastifyReply, c: Queryable): Promise<LinkViewerContext | null> {
    reply.header("cache-control", "no-store");
    if (!linkViewerAuthConfigured()) {
      reply.code(503).send({ ok: false, error: "link_viewer_auth_unavailable", link_viewer: { authenticated: false } });
      return null;
    }
    const context = await resolveLinkViewerContext(req, c);
    if (!context) {
      reply.code(401).send({ ok: false, error: "link_viewer_auth_required", link_viewer: { authenticated: false } });
      return null;
    }
    return context;
  }

  function publicViewerSummary(context: LinkViewerContext) {
    return {
      authenticated: true as const,
      username: context.username,
      links: context.grants.map((g) => ({ link_id: g.link_id, link_name: g.link_name, deal_title: g.deal_title, status: g.status }))
    };
  }

  // ═══ seller surface ═══════════════════════════════════════════════════════

  app.get("/api/seller/deals/:dealId/distribution", async (req: any, reply: any) =>
    deps.withTx(async (c) => {
      const seller = await deps.requireSeller(req, reply, c);
      if (!seller) return reply;
      const dealId = requireUuid(req.params?.dealId, "deal_id");
      const deal = await loadSellerDeal(c, seller.seller_id, dealId);
      if (!deal) fail("deal not found", 404, "deal_not_found");
      const links = await c.query(
        `${SELLER_LINK_SELECT}
         WHERE l.deal_id=$1 AND d.seller_id=$2 AND l.origin_type='seller'
         ORDER BY l.created_at DESC`,
        [dealId, seller.seller_id]
      );
      const totals = await loadLinkTotals(c, links.rows.map((r: any) => String(r.link_id)));
      const mapped: SellerLinkView[] = links.rows.map((r: any) => mapSellerLink(r, totals.get(String(r.link_id)) || emptyTotals()));
      const sum = mapped.reduce(
        (acc: Omit<LinkTotals, "conversion_entry_to_join" | "conversion_entry_to_final_charge">, l: SellerLinkView) => {
          acc.entries += l.metrics.entries;
          acc.unique_visitors += l.metrics.unique_visitors;
          acc.joins += l.metrics.joins;
          acc.joined_units += l.metrics.joined_units;
          acc.charged_participants += l.metrics.charged_participants;
          acc.charged_units += l.metrics.charged_units;
          acc.attributed_gross = money(acc.attributed_gross + l.metrics.attributed_gross);
          return acc;
        },
        { entries: 0, unique_visitors: 0, joins: 0, joined_units: 0, charged_participants: 0, charged_units: 0, attributed_gross: 0 }
      );
      return {
        ok: true,
        deal: { deal_id: String(deal.deal_id), title: String(deal.title || ""), state: String(deal.state), published: Boolean(deal.published_at) },
        links: mapped,
        totals: finishTotals(sum),
        attribution_rule: DISTRIBUTION_ATTRIBUTION_RULE,
        disclaimer_he: DISTRIBUTION_DISCLAIMER_HE,
        login_path: LINK_VIEWER_LOGIN_PATH
      };
    })
  );

  app.post("/api/seller/deals/:dealId/distribution/links", async (req: any, reply: any) => {
    const result = await deps.withTx(async (c) => {
      const seller = await deps.requireSellerOperate(req, reply, c);
      if (!seller) return null;
      const dealId = requireUuid(req.params?.dealId, "deal_id");
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const internalName = normalizeLinkName(body.internal_name);
      if (!internalName) fail("internal_name is required", 400, "distribution_link_name_invalid");
      const channel = normalizeChannel(body.channel);
      const deal = await loadSellerDeal(c, seller.seller_id, dealId);
      if (!deal) fail("deal not found", 404, "deal_not_found");
      if (!deal.published_at || !["PendingTarget", "TargetReached"].includes(String(deal.state))) {
        fail("distribution links can be created only for a published deal that is open for joining", 409, "distribution_link_deal_not_open");
      }
      for (let attempt = 0; attempt < 4; attempt++) {
        const sourceCode = generateDistributionSourceCode();
        try {
          const inserted = await c.query(
            `INSERT INTO siton.affiliate_links
               (affiliate_id, deal_id, internal_name, source_code, origin_type, channel)
             VALUES (NULL, $1, $2, $3, 'seller', $4)
             RETURNING link_id`,
            [dealId, internalName, sourceCode, channel]
          );
          const row = await loadSellerLinkRow(c, seller.seller_id, dealId, String(inserted.rows[0].link_id));
          return { status: 201, body: { ok: true, link: mapSellerLink(row, emptyTotals()) } };
        } catch (error: any) {
          if (String(error?.code || "") !== "23505") throw error;
          if (String(error?.constraint || "") === "ux_affiliate_links_seller_deal_name") {
            fail("a distribution link with this name already exists for this deal", 409, "distribution_link_name_exists");
          }
          // source_code collision: retry with a fresh code
        }
      }
      fail("could not allocate a unique link code", 500, "distribution_link_code_allocation_failed");
    });
    if (!result) return reply;
    return reply.code(result.status).send(result.body);
  });

  app.patch("/api/seller/deals/:dealId/distribution/links/:linkId", async (req: any, reply: any) =>
    deps.withTx(async (c) => {
      const seller = await deps.requireSellerOperate(req, reply, c);
      if (!seller) return reply;
      const dealId = requireUuid(req.params?.dealId, "deal_id");
      const linkId = requireUuid(req.params?.linkId, "link_id");
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const allowed = new Set(["internal_name", "channel", "status"]);
      if (Object.keys(body).some((key) => !allowed.has(key))) fail("unsupported field", 400, "distribution_link_field_unsupported");
      const existing = await loadSellerLinkRow(c, seller.seller_id, dealId, linkId);
      if (!existing) fail("distribution link not found", 404, "distribution_link_not_found");

      if (body.internal_name !== undefined) {
        const internalName = normalizeLinkName(body.internal_name);
        if (!internalName) fail("internal_name is required", 400, "distribution_link_name_invalid");
        try {
          await c.query(`UPDATE siton.affiliate_links SET internal_name=$2 WHERE link_id=$1`, [linkId, internalName]);
        } catch (error: any) {
          if (String(error?.code || "") === "23505") fail("a distribution link with this name already exists for this deal", 409, "distribution_link_name_exists");
          throw error;
        }
      }
      if (body.channel !== undefined) {
        await c.query(`UPDATE siton.affiliate_links SET channel=$2 WHERE link_id=$1`, [linkId, normalizeChannel(body.channel)]);
      }
      if (body.status !== undefined) {
        const status = String(body.status || "").trim();
        if (status !== "active" && status !== "disabled") fail("status must be active or disabled", 400, "distribution_link_status_invalid");
        // Disabling never deletes history: events and attributions stay; the
        // code simply stops being eligible for new visits and joins.
        await c.query(
          status === "disabled"
            ? `UPDATE siton.affiliate_links SET disabled_at = COALESCE(disabled_at, now()) WHERE link_id=$1`
            : `UPDATE siton.affiliate_links SET disabled_at = NULL WHERE link_id=$1`,
          [linkId]
        );
      }
      const row = await loadSellerLinkRow(c, seller.seller_id, dealId, linkId);
      const totals = await loadLinkTotals(c, [linkId]);
      return { ok: true, link: mapSellerLink(row, totals.get(linkId) || emptyTotals()) };
    })
  );

  app.get("/api/seller/deals/:dealId/distribution/links/:linkId", async (req: any, reply: any) =>
    deps.withTx(async (c) => {
      const seller = await deps.requireSeller(req, reply, c);
      if (!seller) return reply;
      const dealId = requireUuid(req.params?.dealId, "deal_id");
      const linkId = requireUuid(req.params?.linkId, "link_id");
      const range = normalizeDistributionRange(req.query?.range);
      const row = await loadSellerLinkRow(c, seller.seller_id, dealId, linkId);
      if (!row) fail("distribution link not found", 404, "distribution_link_not_found");
      const deal = await loadSellerDeal(c, seller.seller_id, dealId);
      const now = new Date();
      const createdAt = new Date(String(row.created_at));
      const [allTime, windowed, series] = await Promise.all([
        loadLinkTotals(c, [linkId]),
        loadLinkTotals(c, [linkId], rangeSince(range, createdAt, now).since),
        loadLinkSeries(c, linkId, range, createdAt, now)
      ]);
      return {
        ok: true,
        deal: { deal_id: dealId, title: String(deal?.title || ""), state: String(deal?.state || "") },
        link: mapSellerLink(row, allTime.get(linkId) || emptyTotals()),
        range,
        window: windowed.get(linkId) || emptyTotals(),
        series,
        attribution_rule: DISTRIBUTION_ATTRIBUTION_RULE,
        disclaimer_he: DISTRIBUTION_DISCLAIMER_HE,
        computed_at: now.toISOString()
      };
    })
  );

  app.post("/api/seller/deals/:dealId/distribution/links/:linkId/external-access", async (req: any, reply: any) =>
    deps.withTx(async (c) => {
      const seller = await deps.requireSellerOperate(req, reply, c);
      if (!seller) return reply;
      const dealId = requireUuid(req.params?.dealId, "deal_id");
      const linkId = requireUuid(req.params?.linkId, "link_id");
      const action = String(req.body?.action || "").trim();
      if (!["enable", "disable", "reset_password"].includes(action)) fail("action must be enable, disable or reset_password", 400, "external_access_action_invalid");
      const existing = await loadSellerLinkRow(c, seller.seller_id, dealId, linkId);
      if (!existing) fail("distribution link not found", 404, "distribution_link_not_found");
      const activeViewerId = existing.viewer_id && existing.viewer_enabled && !existing.viewer_revoked_at ? String(existing.viewer_id) : null;

      let credentials: { username: string; password: string; login_path: string } | null = null;
      if (action === "enable") {
        if (activeViewerId) fail("external access is already enabled for this link", 409, "external_access_already_enabled");
        const password = generateLinkViewerPassword();
        const secretHash = hashSellerAccessSecret(password);
        let viewerId = "";
        for (let attempt = 0; attempt < 4 && !viewerId; attempt++) {
          const username = generateLinkViewerUsername();
          try {
            const inserted = await c.query(
              `INSERT INTO siton.distribution_link_viewers (username, secret_hash, created_by_seller_id)
               VALUES ($1, $2, $3) RETURNING viewer_id, username`,
              [username, secretHash, String(seller.seller_id).slice(0, 64)]
            );
            viewerId = String(inserted.rows[0].viewer_id);
            credentials = { username: String(inserted.rows[0].username), password, login_path: LINK_VIEWER_LOGIN_PATH };
          } catch (error: any) {
            if (String(error?.code || "") !== "23505") throw error;
          }
        }
        if (!viewerId) fail("could not allocate a viewer username", 500, "external_access_username_allocation_failed");
        await c.query(
          `INSERT INTO siton.distribution_link_viewer_grants (viewer_id, link_id) VALUES ($1, $2)
           ON CONFLICT (viewer_id, link_id) DO UPDATE SET revoked_at = NULL, granted_at = now()`,
          [viewerId, linkId]
        );
      } else if (action === "disable") {
        if (activeViewerId) {
          // Revoking removes ONLY the external viewing right. The link and its
          // analytics are untouched; live sessions are invalidated.
          await c.query(`UPDATE siton.distribution_link_viewer_grants SET revoked_at = now() WHERE viewer_id=$1 AND revoked_at IS NULL`, [activeViewerId]);
          await c.query(`UPDATE siton.distribution_link_viewers SET enabled=false, revoked_at=now(), updated_at=now() WHERE viewer_id=$1`, [activeViewerId]);
          await revokeViewerSessions(c, activeViewerId, "external_access_disabled");
        }
      } else {
        if (!activeViewerId) fail("external access is not enabled for this link", 409, "external_access_not_enabled");
        const password = generateLinkViewerPassword();
        await c.query(
          `UPDATE siton.distribution_link_viewers SET secret_hash=$2, secret_updated_at=now(), updated_at=now() WHERE viewer_id=$1`,
          [activeViewerId, hashSellerAccessSecret(password)]
        );
        await revokeViewerSessions(c, activeViewerId, "password_reset");
        credentials = { username: String(existing.viewer_username), password, login_path: LINK_VIEWER_LOGIN_PATH };
      }

      const row = await loadSellerLinkRow(c, seller.seller_id, dealId, linkId);
      return {
        ok: true,
        action,
        external_access: mapExternalAccess(row),
        // The raw password is returned ONCE, never stored, never shown again.
        credentials
      };
    })
  );

  // ═══ external link viewer surface (scoped, read-only, aggregates only) ════

  app.get("/api/link-viewer/session", async (req: any, reply: any) =>
    deps.withTx(async (c) => {
      const context = await requireLinkViewer(req, reply, c);
      if (!context) return reply;
      return { ok: true, link_viewer: publicViewerSummary(context) };
    })
  );

  app.post("/api/link-viewer/session/login", async (req: any, reply: any) => {
    reply.header("cache-control", "no-store");
    if (!linkViewerAuthConfigured()) {
      return reply.code(503).send({ ok: false, error: "link_viewer_auth_unavailable" });
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const username = String(body.username || "").trim().toLowerCase().slice(0, 64);
    const password = String(body.password || "");
    if (!username || !password) {
      return reply.code(400).send({ ok: false, error: "link_viewer_credentials_required", message: "username and password are required" });
    }
    const ip = requestClientIp(req) || "unknown";
    const keys = [`ip:${ip}`, `user:${username}`];
    const outcome = await deps.withTx(async (c) => {
      const counts = await c.query(
        `SELECT attempt_key, COUNT(*)::int AS cnt
         FROM siton.distribution_link_viewer_login_attempts
         WHERE attempt_key = ANY($1::text[]) AND succeeded = false
           AND created_at > now() - ($2::int * interval '1 minute')
         GROUP BY attempt_key`,
        [keys, LINK_VIEWER_LOGIN_WINDOW_MINUTES]
      );
      if (counts.rows.some((r: any) => num(r.cnt) >= LINK_VIEWER_LOGIN_MAX_ATTEMPTS)) {
        return { status: 429, body: { ok: false, error: "link_viewer_login_rate_limited" } };
      }
      const viewer = await c.query(
        `SELECT viewer_id, username, secret_hash, enabled, revoked_at
         FROM siton.distribution_link_viewers WHERE lower(username)=$1 LIMIT 1`,
        [username]
      );
      const row = viewer.rows[0];
      const valid = Boolean(row) && verifySellerAccessSecret(password, row.secret_hash);
      if (!valid) {
        await c.query(
          `INSERT INTO siton.distribution_link_viewer_login_attempts (attempt_key, succeeded)
           SELECT unnest($1::text[]), false`,
          [keys]
        );
        // Unknown user and wrong password answer identically (no account oracle).
        return { status: 401, body: { ok: false, error: "link_viewer_auth_invalid_credentials" } };
      }
      if (!row.enabled || row.revoked_at) {
        return { status: 403, body: { ok: false, error: "link_viewer_access_revoked" } };
      }
      const grants = await c.query(
        `SELECT 1 FROM siton.distribution_link_viewer_grants WHERE viewer_id=$1 AND revoked_at IS NULL LIMIT 1`,
        [row.viewer_id]
      );
      if (!grants.rowCount) return { status: 403, body: { ok: false, error: "link_viewer_access_revoked" } };

      const token = randomBytes(32).toString("base64url");
      const tokenHash = hashLinkViewerSessionToken(token);
      if (!tokenHash) return { status: 503, body: { ok: false, error: "link_viewer_auth_unavailable" } };
      await c.query(
        `INSERT INTO siton.distribution_link_viewer_sessions (viewer_id, token_hash, expires_at)
         VALUES ($1, $2, now() + ($3::int * interval '1 second'))`,
        [row.viewer_id, tokenHash, LINK_VIEWER_SESSION_TTL_SECONDS]
      );
      await c.query(`UPDATE siton.distribution_link_viewers SET last_login_at=now() WHERE viewer_id=$1`, [row.viewer_id]);
      await c.query(
        `INSERT INTO siton.distribution_link_viewer_login_attempts (attempt_key, succeeded)
         SELECT unnest($1::text[]), true`,
        [keys]
      );
      return { status: 200, token };
    });
    if (outcome.status !== 200) return reply.code(outcome.status).send(outcome.body);
    reply.header("set-cookie", serializeLinkViewerSessionCookie(outcome.token, { secure: secureCookie() }));
    const context = await deps.withTx(async (c) => {
      const fake = { headers: { cookie: `${LINK_VIEWER_SESSION_COOKIE}=${encodeURIComponent(outcome.token)}` } };
      return resolveLinkViewerContext(fake, c);
    });
    if (!context) return reply.code(403).send({ ok: false, error: "link_viewer_access_revoked" });
    return reply.send({ ok: true, link_viewer: publicViewerSummary(context) });
  });

  app.post("/api/link-viewer/session/logout", async (req: any, reply: any) => {
    reply.header("cache-control", "no-store");
    const tokenHash = hashLinkViewerSessionToken(readLinkViewerSessionToken(req));
    if (tokenHash) {
      await deps.withTx(async (c) =>
        c.query(
          `UPDATE siton.distribution_link_viewer_sessions SET revoked_at=now(), revoked_reason='logout'
           WHERE token_hash=$1 AND revoked_at IS NULL`,
          [tokenHash]
        )
      );
    }
    reply.header("set-cookie", serializeExpiredLinkViewerSessionCookie({ secure: secureCookie() }));
    return { ok: true, link_viewer: { authenticated: false } };
  });

  // The dashboard is resolved from the SESSION's grants. A link id in the
  // query is only a selector among the viewer's own grants; anything else is
  // refused (no IDOR: the id is never used as authority).
  app.get("/api/link-viewer/dashboard", async (req: any, reply: any) =>
    deps.withTx(async (c) => {
      const context = await requireLinkViewer(req, reply, c);
      if (!context) return reply;
      const requested = String(req.query?.link || req.query?.link_id || "").trim().toLowerCase();
      let grant = context.grants[0];
      if (requested) {
        const match = context.grants.find((g) => g.link_id === requested);
        if (!match) {
          reply.code(403).send({ ok: false, error: "link_viewer_forbidden", message: "this credential is not granted that link" });
          return reply;
        }
        grant = match;
      } else if (context.grants.length !== 1) {
        reply.code(400).send({ ok: false, error: "link_selection_required", link_viewer: publicViewerSummary(context) });
        return reply;
      }
      const range = normalizeDistributionRange(req.query?.range);
      const link = await c.query(
        `SELECT l.link_id, l.internal_name, l.created_at, l.disabled_at, d.title AS deal_title, d.state AS deal_state
         FROM siton.affiliate_links l JOIN siton.deals d ON d.deal_id = l.deal_id
         WHERE l.link_id=$1 LIMIT 1`,
        [grant!.link_id]
      );
      const row = link.rows[0];
      if (!row) {
        reply.code(403).send({ ok: false, error: "link_viewer_forbidden" });
        return reply;
      }
      const now = new Date();
      const createdAt = new Date(String(row.created_at));
      const linkId = String(row.link_id);
      const [allTime, windowed, series] = await Promise.all([
        loadLinkTotals(c, [linkId]),
        loadLinkTotals(c, [linkId], rangeSince(range, createdAt, now).since),
        loadLinkSeries(c, linkId, range, createdAt, now)
      ]);
      // Aggregates ONLY. No participant rows, no names, phones, emails,
      // addresses, payment references, ids or documents ever enter this payload.
      return {
        ok: true,
        viewer: { username: context.username },
        deal: { title: String(row.deal_title || ""), state: String(row.deal_state || "") },
        link: {
          link_id: linkId,
          link_name: String(row.internal_name),
          status: row.disabled_at ? "disabled" : "active",
          created_at: createdAt.toISOString()
        },
        range,
        totals: allTime.get(linkId) || emptyTotals(),
        window: windowed.get(linkId) || emptyTotals(),
        series,
        attribution_rule: DISTRIBUTION_ATTRIBUTION_RULE,
        disclaimer_he: DISTRIBUTION_DISCLAIMER_HE,
        computed_at: now.toISOString()
      };
    })
  );
}
