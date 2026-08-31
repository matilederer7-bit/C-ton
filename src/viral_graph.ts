// Canonical Siton COMMERCE VIRAL GRAPH (R6).
//
// Every participant can become a distributor of the deal. This module owns:
//   * Join-time attribution resolution (bounded, inside the Join transaction):
//     resolve the last-touch ref -> parent link / parent participant /
//     generation / chain origin, persist one siton.viral_attributions row, and
//     ensure the joining buyer's ONE personal share link exists.
//   * PII-free funnel event recording (deal_view / share_button_click / ...).
//   * The asynchronous 'viral_recompute' worker job that aggregates the deal's
//     viral tree into siton.viral_metrics_cache (deal + seller + platform
//     scopes). Join never recurses over the tree.
//   * Read models: cached metrics, the admin/seller tree explorer, and the
//     participant-facing safe impact summary.
//
// Money truth: "successful" metrics count ONLY participants whose money_state
// is ChargedSuccess or RecoveredCharge — the same closed pair the deal
// finalizer uses. Provisional joined units are always labeled separately.
// Distributor commission is ZERO: nothing here creates or implies payout.

import { randomBytes } from "node:crypto";

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const VIRAL_SUCCESS_MONEY_STATES = ["ChargedSuccess", "RecoveredCharge"] as const;
const SUCCESS_STATES_SQL = `('ChargedSuccess','RecoveredCharge')`;
const ACTIVE_BUYER_STATES_SQL = `NOT IN ('DealFailed','Dropped')`;

// Personal share codes are opaque: they never contain internal ids. 12 base36
// chars (~62 bits) + 'p' prefix keeps them collision-resistant and matched by
// the canonical source_code pattern ^[a-z0-9][a-z0-9_-]{7,63}$.
export function generatePersonalShareCode(): string {
  const raw = randomBytes(10).toString("hex"); // 20 hex chars
  return `p${parseInt(raw.slice(0, 10), 16).toString(36)}${parseInt(raw.slice(10), 16).toString(36)}`.slice(0, 16);
}

function boundedText(value: unknown, max: number): string | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  return s.slice(0, max);
}

function boundedTimestamp(value: unknown): string | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  // Client clocks are hints; clamp into a sane window (past year .. now+5m).
  const now = Date.now();
  if (ms > now + 5 * 60_000 || ms < now - 366 * 24 * 3600_000) return null;
  return new Date(ms).toISOString();
}

export interface ViralJoinInput {
  deal_id: string;
  participant_id: string;
  buyer_id: string;
  qty: number;
  ref: string; // last-touch share code from the request (may be empty)
  first_touch_code?: unknown;
  first_touch_at?: unknown;
  last_touch_code?: unknown;
  last_touch_at?: unknown;
  visitor_id?: unknown;
  session_id?: unknown;
}

export interface ViralJoinResult {
  attributed: boolean;
  generation: number;
  origin_ref_type: string;
  parent_participant_id: string | null;
  personal_share_code: string | null;
  personal_share_created: boolean;
}

// Runs INSIDE the Join transaction. Bounded work only: a handful of indexed
// single-row lookups and idempotent inserts. Never walks the tree.
export async function recordViralJoinAttribution(c: Queryable, input: ViralJoinInput): Promise<ViralJoinResult> {
  const ref = boundedText(input.ref, 120);
  let parentLinkId: string | null = null;
  let parentParticipantId: string | null = null;
  let originLinkId: string | null = null;
  let originRefType = "none";
  let generation = 0;

  if (ref) {
    const linkRes = await c.query(
      `SELECT link_id, origin_type, origin_participant_id
       FROM siton.affiliate_links
       WHERE source_code=$1 AND deal_id=$2 AND disabled_at IS NULL
       LIMIT 1`,
      [ref, input.deal_id]
    );
    const link = linkRes.rows[0];
    if (link) {
      parentLinkId = String(link.link_id);
      const originType = String(link.origin_type || "distributor");
      if (originType === "participant" && link.origin_participant_id) {
        parentParticipantId = String(link.origin_participant_id);
        originRefType = "participant";
        // Parent generation is one indexed lookup — never recursive.
        const parentAttr = await c.query(
          `SELECT generation, origin_link_id FROM siton.viral_attributions WHERE participant_id=$1`,
          [parentParticipantId]
        );
        const parentGeneration = parentAttr.rows[0] ? Number(parentAttr.rows[0].generation || 0) : 0;
        generation = Math.min(parentGeneration + 1, 500);
        originLinkId = parentAttr.rows[0]?.origin_link_id
          ? String(parentAttr.rows[0].origin_link_id)
          : parentLinkId;
        if (parentParticipantId === input.participant_id) {
          // A participant cannot parent itself (defensive; new ids make this unreachable).
          parentParticipantId = null;
          parentLinkId = null;
          originLinkId = null;
          originRefType = "none";
          generation = 0;
        }
      } else {
        originRefType = originType; // distributor | seller | campaign
        generation = 1;
        originLinkId = parentLinkId;
      }
    } else {
      // Legacy path: a bare affiliate account code (no per-deal link row).
      const accountRes = await c.query(
        `SELECT affiliate_id FROM siton.affiliate_accounts WHERE affiliate_code=$1 LIMIT 1`,
        [ref]
      );
      if (accountRes.rowCount) {
        originRefType = "account";
        generation = 1;
      }
    }
  }

  await c.query(
    `INSERT INTO siton.viral_attributions
       (participant_id, deal_id, parent_link_id, parent_participant_id, origin_link_id,
        origin_ref_type, generation,
        first_touch_code, first_touch_at, last_touch_code, last_touch_at,
        visitor_id, session_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (participant_id) DO NOTHING`,
    [
      input.participant_id,
      input.deal_id,
      parentLinkId,
      parentParticipantId,
      originLinkId,
      originRefType,
      generation,
      boundedText(input.first_touch_code, 120),
      boundedTimestamp(input.first_touch_at),
      boundedText(input.last_touch_code, 120) ?? ref,
      boundedTimestamp(input.last_touch_at),
      boundedText(input.visitor_id, 64),
      boundedText(input.session_id, 64)
    ]
  );

  // Ensure ONE personal share link per (deal, buyer share identity). A repeat
  // purchase by the same buyer reuses the existing link (idempotent insert).
  let personalShareCode: string | null = null;
  let personalShareCreated = false;
  for (let attempt = 0; attempt < 3 && !personalShareCode; attempt++) {
    const candidate = generatePersonalShareCode();
    try {
      const inserted = await c.query(
        `INSERT INTO siton.affiliate_links
           (affiliate_id, deal_id, internal_name, source_code, origin_type, origin_participant_id, origin_buyer_id)
         VALUES (NULL, $1, 'personal', $2, 'participant', $3, $4)
         ON CONFLICT (deal_id, origin_buyer_id) WHERE origin_type = 'participant' DO NOTHING
         RETURNING source_code`,
        [input.deal_id, candidate, input.participant_id, input.buyer_id]
      );
      if (inserted.rowCount) {
        personalShareCode = String(inserted.rows[0].source_code);
        personalShareCreated = true;
        await c.query(
          `INSERT INTO siton.viral_events (event_type, deal_id, ref_code, client_event_id)
           VALUES ('personal_link_created', $1, $2, $3)
           ON CONFLICT (deal_id, event_type, client_event_id) DO NOTHING`,
          [input.deal_id, personalShareCode, `plink-${input.participant_id}`]
        );
      } else {
        const existing = await c.query(
          `SELECT source_code FROM siton.affiliate_links
           WHERE deal_id=$1 AND origin_buyer_id=$2 AND origin_type='participant'
           LIMIT 1`,
          [input.deal_id, input.buyer_id]
        );
        personalShareCode = existing.rows[0] ? String(existing.rows[0].source_code) : null;
        if (personalShareCode) break;
      }
    } catch (error: any) {
      // source_code global-unique collision: retry with a fresh code.
      if (String(error?.code || "") !== "23505") throw error;
    }
  }

  // Debounced async recompute; the partial unique index
  // (event_type, aggregate_id) WHERE pending/processing makes this a no-op
  // when a recompute is already queued for the deal.
  await c.query(
    `INSERT INTO siton.outbox_events(event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
     VALUES ('viral_recompute','deal',$1,$2,'pending',0, now() + interval '20 seconds')
     ON CONFLICT DO NOTHING`,
    [input.deal_id, JSON.stringify({ deal_id: input.deal_id, reason: "join" })]
  );

  return {
    attributed: originRefType !== "none",
    generation,
    origin_ref_type: originRefType,
    parent_participant_id: parentParticipantId,
    personal_share_code: personalShareCode,
    personal_share_created: personalShareCreated
  };
}

export function personalShareUrl(dealId: string, code: string): string {
  return `/preview/?ref=${encodeURIComponent(code)}#/deal/${encodeURIComponent(dealId)}`;
}

// ── Funnel events (public, PII-free, deduplicated) ─────────────────────────
const FUNNEL_EVENT_TYPES = new Set(["deal_view", "share_button_click", "join_started"]);
const SHARE_CHANNELS = new Set(["whatsapp", "telegram", "facebook", "x", "email", "copy", "native", "other"]);

export interface FunnelEventInput {
  event_type: string;
  deal_id: string;
  ref_code?: unknown;
  share_channel?: unknown;
  visitor_id?: unknown;
  session_id?: unknown;
  client_event_id: string;
}

export async function recordViralFunnelEvent(db: Queryable, input: FunnelEventInput): Promise<{ recorded: boolean; reason?: string }> {
  if (!FUNNEL_EVENT_TYPES.has(input.event_type)) return { recorded: false, reason: "unsupported_event_type" };
  const clientEventId = String(input.client_event_id || "").trim();
  if (clientEventId.length < 8 || clientEventId.length > 100) return { recorded: false, reason: "client_event_id_invalid" };
  const channelRaw = boundedText(input.share_channel, 24);
  const channel = channelRaw && SHARE_CHANNELS.has(channelRaw) ? channelRaw : channelRaw ? "other" : null;
  const refCode = boundedText(input.ref_code, 120);

  const dealRow = await db.query(
    `SELECT deal_id FROM siton.deals WHERE deal_id=$1 AND published_at IS NOT NULL LIMIT 1`,
    [input.deal_id]
  );
  if (!dealRow.rowCount) return { recorded: false, reason: "deal_not_found" };

  let linkId: string | null = null;
  if (refCode) {
    const linkRes = await db.query(
      `SELECT link_id FROM siton.affiliate_links WHERE source_code=$1 AND deal_id=$2 AND disabled_at IS NULL LIMIT 1`,
      [refCode, input.deal_id]
    );
    linkId = linkRes.rows[0] ? String(linkRes.rows[0].link_id) : null;
  }

  const inserted = await db.query(
    `INSERT INTO siton.viral_events
       (event_type, deal_id, link_id, ref_code, share_channel, visitor_id, session_id, client_event_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (deal_id, event_type, client_event_id) DO NOTHING
     RETURNING event_id`,
    [
      input.event_type,
      input.deal_id,
      linkId,
      refCode,
      channel,
      boundedText(input.visitor_id, 64),
      boundedText(input.session_id, 64),
      clientEventId
    ]
  );
  return { recorded: Boolean(inserted.rowCount) };
}

// ── Async recompute (worker job) ───────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function maskName(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "משתתף";
  const first = s.split(/\s+/)[0] || "";
  return first.length > 1 ? first : "משתתף";
}

const TREE_NODE_CAP = 800;

// Computes and caches the deal's viral metrics. Called ONLY from the worker
// (or tests) — never inside a request path.
export async function recomputeDealViralMetrics(c: Queryable, dealId: string): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const dealRes = await c.query(
    `SELECT deal_id, seller_id, title, state, price_per_unit, min_units, max_units, threshold_units
     FROM siton.deals WHERE deal_id=$1 LIMIT 1`,
    [dealId]
  );
  if (!dealRes.rowCount) throw new Error(`viral_recompute: deal ${dealId} not found`);
  const deal = dealRes.rows[0];
  const price = Number(deal.price_per_unit || 0);

  // One pass over the deal's participants + attribution edges (deal-bounded).
  const rowsRes = await c.query(
    `SELECT p.participant_id, p.qty, p.buyer_state, p.money_state, p.delivery_cost,
            p.buyer_name, p.created_at,
            va.parent_link_id, va.parent_participant_id, va.origin_link_id,
            va.origin_ref_type, va.generation,
            va.first_touch_code, va.last_touch_code, va.visitor_id
     FROM siton.participants p
     LEFT JOIN siton.viral_attributions va ON va.participant_id = p.participant_id
     WHERE p.deal_id=$1
     ORDER BY p.created_at ASC`,
    [dealId]
  );
  const rows = rowsRes.rows as any[];

  const linkRes = await c.query(
    `SELECT l.link_id, l.origin_type, l.source_code, l.internal_name, l.origin_participant_id,
            l.affiliate_id, aa.display_name AS affiliate_name,
            COALESCE(clicks.cnt, 0) AS clicks, COALESCE(entries.cnt, 0) AS entries
     FROM siton.affiliate_links l
     LEFT JOIN siton.affiliate_accounts aa ON aa.affiliate_id = l.affiliate_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS cnt FROM siton.affiliate_link_events e
       WHERE e.link_id = l.link_id AND e.event_type='click'
     ) clicks ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS cnt FROM siton.affiliate_link_events e
       WHERE e.link_id = l.link_id AND e.event_type='entry'
     ) entries ON true
     WHERE l.deal_id=$1`,
    [dealId]
  );

  const funnelRes = await c.query(
    `SELECT event_type, COUNT(*)::int AS cnt, COUNT(DISTINCT visitor_id) AS visitors
     FROM siton.viral_events WHERE deal_id=$1 GROUP BY event_type`,
    [dealId]
  );

  const isSuccess = (r: any) => r.money_state === "ChargedSuccess" || r.money_state === "RecoveredCharge";
  const isActive = (r: any) => r.buyer_state !== "DealFailed" && r.buyer_state !== "Dropped";
  const grossOf = (r: any) => Number(r.qty || 0) * price + Number(r.delivery_cost || 0);

  const byId = new Map<string, any>(rows.map((r) => [String(r.participant_id), r]));
  const children = new Map<string, string[]>();
  for (const r of rows) {
    const parent = r.parent_participant_id ? String(r.parent_participant_id) : null;
    if (parent && byId.has(parent)) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent)!.push(String(r.participant_id));
    }
  }

  // Iterative subtree rollup (children -> parents), bounded by deal size.
  const subtree = new Map<string, { joins: number; units: number; chargedUnits: number; chargedGmv: number; depth: number }>();
  const order = [...rows].sort((a, b) => Number(b.generation || 0) - Number(a.generation || 0));
  for (const r of order) {
    const id = String(r.participant_id);
    const own = subtree.get(id) || { joins: 0, units: 0, chargedUnits: 0, chargedGmv: 0, depth: 0 };
    subtree.set(id, own);
    const parent = r.parent_participant_id ? String(r.parent_participant_id) : null;
    if (parent && byId.has(parent)) {
      const p = subtree.get(parent) || { joins: 0, units: 0, chargedUnits: 0, chargedGmv: 0, depth: 0 };
      p.joins += 1 + own.joins;
      p.units += (isActive(r) ? Number(r.qty || 0) : 0) + own.units;
      p.chargedUnits += (isSuccess(r) ? Number(r.qty || 0) : 0) + own.chargedUnits;
      p.chargedGmv += (isSuccess(r) ? grossOf(r) : 0) + own.chargedGmv;
      p.depth = Math.max(p.depth, own.depth + 1);
      subtree.set(parent, p);
    }
  }

  const totalParticipants = rows.length;
  const activeRows = rows.filter(isActive);
  const chargedRows = rows.filter(isSuccess);
  const attributedRows = rows.filter((r) => r.origin_ref_type && r.origin_ref_type !== "none");
  const attributedCharged = attributedRows.filter(isSuccess);

  const generationDistribution: Record<string, number> = {};
  let maxGeneration = 0;
  for (const r of attributedRows) {
    const g = String(Number(r.generation || 0));
    generationDistribution[g] = (generationDistribution[g] || 0) + 1;
    maxGeneration = Math.max(maxGeneration, Number(r.generation || 0));
  }

  // Time to first child per sharing participant.
  const firstChildDelays: number[] = [];
  for (const [parentId, childIds] of children) {
    const parent = byId.get(parentId);
    if (!parent) continue;
    const parentAt = Date.parse(String(parent.created_at));
    const firstChildAt = Math.min(...childIds.map((id) => Date.parse(String(byId.get(id)?.created_at))));
    if (Number.isFinite(parentAt) && Number.isFinite(firstChildAt) && firstChildAt >= parentAt) {
      firstChildDelays.push(Math.round((firstChildAt - parentAt) / 1000));
    }
  }
  firstChildDelays.sort((a, b) => a - b);
  const medianTimeToFirstChild = firstChildDelays.length
    ? firstChildDelays[Math.floor(firstChildDelays.length / 2)]
    : null;

  const sevenDaysAgo = Date.now() - 7 * 24 * 3600_000;
  const recentViralJoins = attributedRows.filter((r) => Date.parse(String(r.created_at)) >= sevenDaysAgo).length;

  const funnel: Record<string, number> = {};
  for (const f of funnelRes.rows) funnel[String(f.event_type)] = Number(f.cnt || 0);
  const linkRows = linkRes.rows as any[];
  const linkClicks = linkRows.reduce((s, l) => s + Number(l.clicks || 0), 0);
  const linkEntries = linkRows.reduce((s, l) => s + Number(l.entries || 0), 0);

  const directJoinsByLink = new Map<string, any[]>();
  for (const r of attributedRows) {
    if (!r.parent_link_id) continue;
    const key = String(r.parent_link_id);
    if (!directJoinsByLink.has(key)) directJoinsByLink.set(key, []);
    directJoinsByLink.get(key)!.push(r);
  }

  const topSharers = rows
    .filter((r) => (children.get(String(r.participant_id)) || []).length > 0)
    .map((r) => {
      const st = subtree.get(String(r.participant_id))!;
      return {
        participant_id: String(r.participant_id),
        display: maskName(r.buyer_name),
        generation: Number(r.generation || 0),
        direct_children: (children.get(String(r.participant_id)) || []).length,
        subtree_joins: st.joins,
        subtree_units: st.units,
        subtree_charged_units: st.chargedUnits,
        subtree_charged_gmv: Math.round(st.chargedGmv * 100) / 100,
        max_depth: st.depth
      };
    })
    .sort((a, b) => b.subtree_charged_units - a.subtree_charged_units || b.subtree_joins - a.subtree_joins)
    .slice(0, 20);

  const topSources = linkRows
    .map((l) => {
      const direct = directJoinsByLink.get(String(l.link_id)) || [];
      let joins = direct.length;
      let units = 0;
      let chargedUnits = 0;
      let chargedGmv = 0;
      for (const r of direct) {
        if (isActive(r)) units += Number(r.qty || 0);
        if (isSuccess(r)) {
          chargedUnits += Number(r.qty || 0);
          chargedGmv += grossOf(r);
        }
        const st = subtree.get(String(r.participant_id));
        if (st) {
          joins += st.joins;
          units += st.units;
          chargedUnits += st.chargedUnits;
          chargedGmv += st.chargedGmv;
        }
      }
      return {
        link_id: String(l.link_id),
        origin_type: String(l.origin_type || "distributor"),
        source_code: String(l.source_code),
        internal_name: String(l.internal_name || ""),
        owner_display: l.origin_type === "participant"
          ? maskName(byId.get(String(l.origin_participant_id || ""))?.buyer_name)
          : String(l.affiliate_name || l.internal_name || ""),
        clicks: Number(l.clicks || 0),
        entries: Number(l.entries || 0),
        direct_joins: direct.length,
        subtree_joins: joins,
        subtree_units: units,
        subtree_charged_units: chargedUnits,
        subtree_charged_gmv: Math.round(chargedGmv * 100) / 100
      };
    })
    .filter((l) => l.clicks || l.entries || l.direct_joins)
    .sort((a, b) => b.subtree_charged_units - a.subtree_charged_units || b.subtree_joins - a.subtree_joins)
    .slice(0, 30);

  const touchRank = (field: "first_touch_code" | "last_touch_code") => {
    const acc = new Map<string, number>();
    for (const r of rows) {
      const code = r[field] ? String(r[field]) : null;
      if (!code) continue;
      acc.set(code, (acc.get(code) || 0) + 1);
    }
    return [...acc.entries()]
      .map(([code, joins]) => ({ code, joins }))
      .sort((a, b) => b.joins - a.joins)
      .slice(0, 15);
  };

  // Bounded tree snapshot for the explorer UI (generation-first, oldest-first).
  const treeNodes = [...rows]
    .sort((a, b) => Number(a.generation || 0) - Number(b.generation || 0)
      || Date.parse(String(a.created_at)) - Date.parse(String(b.created_at)))
    .slice(0, TREE_NODE_CAP)
    .map((r) => ({
      p: String(r.participant_id),
      parent: r.parent_participant_id ? String(r.parent_participant_id) : null,
      link: r.parent_link_id ? String(r.parent_link_id) : null,
      origin: String(r.origin_ref_type || "none"),
      g: Number(r.generation || 0),
      u: Number(r.qty || 0),
      charged: isSuccess(r),
      active: isActive(r),
      d: maskName(r.buyer_name),
      t: new Date(String(r.created_at)).toISOString()
    }));

  const chargedUnits = chargedRows.reduce((s, r) => s + Number(r.qty || 0), 0);
  const chargedGmv = chargedRows.reduce((s, r) => s + grossOf(r), 0);
  const attributedChargedUnits = attributedCharged.reduce((s, r) => s + Number(r.qty || 0), 0);
  const attributedChargedGmv = attributedCharged.reduce((s, r) => s + grossOf(r), 0);
  const sharingParticipants = children.size;
  const dealViews = funnel["deal_view"] || 0;
  const attributedVisits = linkEntries;

  const metrics: Record<string, unknown> = {
    deal_id: String(deal.deal_id),
    seller_id: String(deal.seller_id || ""),
    deal_title: String(deal.title || ""),
    deal_state: String(deal.state || ""),
    totals: {
      participants: totalParticipants,
      active_participants: activeRows.length,
      units_joined: activeRows.reduce((s, r) => s + Number(r.qty || 0), 0),
      charged_participants: chargedRows.length,
      charged_units: chargedUnits,
      charged_gmv: Math.round(chargedGmv * 100) / 100,
      provisional_gmv: Math.round(activeRows.reduce((s, r) => s + grossOf(r), 0) * 100) / 100
    },
    viral: {
      attributed_participants: attributedRows.length,
      attributed_units: attributedRows.filter(isActive).reduce((s, r) => s + Number(r.qty || 0), 0),
      attributed_charged_participants: attributedCharged.length,
      attributed_charged_units: attributedChargedUnits,
      attributed_charged_gmv: Math.round(attributedChargedGmv * 100) / 100,
      viral_share_of_joins: totalParticipants ? round4(attributedRows.length / totalParticipants) : 0,
      viral_share_of_charged: chargedRows.length ? round4(attributedCharged.length / chargedRows.length) : 0,
      personal_links: linkRows.filter((l) => l.origin_type === "participant").length,
      sharing_participants: sharingParticipants,
      avg_children_per_sharer: sharingParticipants
        ? round4(attributedRows.filter((r) => r.parent_participant_id).length / sharingParticipants)
        : 0,
      direct_viral_coefficient: totalParticipants
        ? round4(attributedRows.filter((r) => r.parent_participant_id).length / totalParticipants)
        : 0,
      charged_viral_coefficient: chargedRows.length
        ? round4(attributedCharged.filter((r) => r.parent_participant_id).length / chargedRows.length)
        : 0,
      max_generation: maxGeneration,
      generation_distribution: generationDistribution,
      time_to_first_child_seconds_median: medianTimeToFirstChild,
      viral_joins_last_7d: recentViralJoins
    },
    funnel: {
      deal_views: dealViews,
      share_clicks: funnel["share_button_click"] || 0,
      join_started: funnel["join_started"] || 0,
      link_clicks: linkClicks,
      link_entries: linkEntries,
      attributed_visits: attributedVisits,
      visit_to_join_rate: attributedVisits ? round4(attributedRows.length / attributedVisits) : 0,
      shared_visit_to_charged_rate: attributedVisits ? round4(attributedCharged.length / attributedVisits) : 0
    },
    top_sharers: topSharers,
    top_sources: topSources,
    first_touch: touchRank("first_touch_code"),
    last_touch: touchRank("last_touch_code"),
    tree: { node_cap: TREE_NODE_CAP, truncated: rows.length > TREE_NODE_CAP, nodes: treeNodes },
    computed_at: new Date().toISOString()
  };

  await c.query(
    `INSERT INTO siton.viral_metrics_cache (scope_type, scope_id, metrics, computed_at, compute_ms)
     VALUES ('deal', $1, $2, now(), $3)
     ON CONFLICT (scope_type, scope_id)
     DO UPDATE SET metrics=EXCLUDED.metrics, computed_at=now(), compute_ms=EXCLUDED.compute_ms`,
    [dealId, JSON.stringify(metrics), Date.now() - startedAt]
  );

  return metrics;
}

function emptyRollup() {
  return {
    deals: 0,
    participants: 0,
    charged_participants: 0,
    charged_units: 0,
    charged_gmv: 0,
    attributed_participants: 0,
    attributed_charged_participants: 0,
    attributed_charged_units: 0,
    attributed_charged_gmv: 0,
    share_clicks: 0,
    link_entries: 0,
    personal_links: 0,
    sharing_participants: 0,
    max_generation: 0,
    generation_distribution: {} as Record<string, number>
  };
}

function foldDealMetrics(acc: ReturnType<typeof emptyRollup>, m: any) {
  acc.deals += 1;
  acc.participants += Number(m?.totals?.participants || 0);
  acc.charged_participants += Number(m?.totals?.charged_participants || 0);
  acc.charged_units += Number(m?.totals?.charged_units || 0);
  acc.charged_gmv += Number(m?.totals?.charged_gmv || 0);
  acc.attributed_participants += Number(m?.viral?.attributed_participants || 0);
  acc.attributed_charged_participants += Number(m?.viral?.attributed_charged_participants || 0);
  acc.attributed_charged_units += Number(m?.viral?.attributed_charged_units || 0);
  acc.attributed_charged_gmv += Number(m?.viral?.attributed_charged_gmv || 0);
  acc.share_clicks += Number(m?.funnel?.share_clicks || 0);
  acc.link_entries += Number(m?.funnel?.link_entries || 0);
  acc.personal_links += Number(m?.viral?.personal_links || 0);
  acc.sharing_participants += Number(m?.viral?.sharing_participants || 0);
  acc.max_generation = Math.max(acc.max_generation, Number(m?.viral?.max_generation || 0));
  const dist = (m?.viral?.generation_distribution || {}) as Record<string, number>;
  for (const [g, n] of Object.entries(dist)) {
    acc.generation_distribution[g] = (acc.generation_distribution[g] || 0) + Number(n || 0);
  }
  return acc;
}

function finalizeRollup(acc: ReturnType<typeof emptyRollup>) {
  return {
    ...acc,
    charged_gmv: Math.round(acc.charged_gmv * 100) / 100,
    attributed_charged_gmv: Math.round(acc.attributed_charged_gmv * 100) / 100,
    viral_share_of_joins: acc.participants ? round4(acc.attributed_participants / acc.participants) : 0,
    viral_share_of_charged: acc.charged_participants
      ? round4(acc.attributed_charged_participants / acc.charged_participants)
      : 0,
    viral_coefficient: acc.participants ? round4(acc.attributed_participants / acc.participants) : 0
  };
}

// Aggregates cached deal metrics into seller + platform scopes. Reads only the
// cache (bounded by deal count), never re-walks participant tables.
export async function recomputeAggregateViralMetrics(c: Queryable, sellerId: string | null): Promise<void> {
  const startedAt = Date.now();
  const cacheRes = await c.query(
    `SELECT scope_id, metrics FROM siton.viral_metrics_cache WHERE scope_type='deal' LIMIT 2000`
  );

  const platform = emptyRollup();
  const seller = emptyRollup();
  const topDeals: any[] = [];
  const bySeller = new Map<string, ReturnType<typeof emptyRollup>>();

  for (const row of cacheRes.rows) {
    const m = typeof row.metrics === "string" ? JSON.parse(row.metrics) : row.metrics;
    foldDealMetrics(platform, m);
    const sid = String(m?.seller_id || "");
    if (!bySeller.has(sid)) bySeller.set(sid, emptyRollup());
    foldDealMetrics(bySeller.get(sid)!, m);
    if (sellerId && sid === sellerId) foldDealMetrics(seller, m);
    topDeals.push({
      deal_id: String(m?.deal_id || row.scope_id),
      deal_title: String(m?.deal_title || ""),
      seller_id: sid,
      attributed_charged_units: Number(m?.viral?.attributed_charged_units || 0),
      attributed_charged_gmv: Number(m?.viral?.attributed_charged_gmv || 0),
      attributed_participants: Number(m?.viral?.attributed_participants || 0),
      viral_share_of_joins: Number(m?.viral?.viral_share_of_joins || 0),
      max_generation: Number(m?.viral?.max_generation || 0)
    });
  }

  topDeals.sort((a, b) => b.attributed_charged_gmv - a.attributed_charged_gmv || b.attributed_participants - a.attributed_participants);
  const topSellers = [...bySeller.entries()]
    .map(([sid, acc]) => ({ seller_id: sid, ...finalizeRollup(acc) }))
    .sort((a, b) => b.attributed_charged_gmv - a.attributed_charged_gmv || b.attributed_participants - a.attributed_participants)
    .slice(0, 20);

  const platformMetrics = {
    ...finalizeRollup(platform),
    top_deals: topDeals.slice(0, 20),
    top_sellers: topSellers,
    computed_at: new Date().toISOString()
  };
  await c.query(
    `INSERT INTO siton.viral_metrics_cache (scope_type, scope_id, metrics, computed_at, compute_ms)
     VALUES ('platform', 'global', $1, now(), $2)
     ON CONFLICT (scope_type, scope_id)
     DO UPDATE SET metrics=EXCLUDED.metrics, computed_at=now(), compute_ms=EXCLUDED.compute_ms`,
    [JSON.stringify(platformMetrics), Date.now() - startedAt]
  );

  if (sellerId) {
    const sellerMetrics = {
      seller_id: sellerId,
      ...finalizeRollup(seller),
      top_deals: topDeals.filter((d) => d.seller_id === sellerId).slice(0, 20),
      computed_at: new Date().toISOString()
    };
    await c.query(
      `INSERT INTO siton.viral_metrics_cache (scope_type, scope_id, metrics, computed_at, compute_ms)
       VALUES ('seller', $1, $2, now(), $3)
       ON CONFLICT (scope_type, scope_id)
       DO UPDATE SET metrics=EXCLUDED.metrics, computed_at=now(), compute_ms=EXCLUDED.compute_ms`,
      [sellerId, JSON.stringify(sellerMetrics), Date.now() - startedAt]
    );
  }
}

export interface CachedViralMetrics {
  metrics: Record<string, unknown> | null;
  computed_at: string | null;
  stale: boolean;
}

const CACHE_FRESH_MS = 5 * 60_000;

export async function readViralMetricsCache(db: Queryable, scopeType: "platform" | "deal" | "seller", scopeId: string): Promise<CachedViralMetrics> {
  const res = await db.query(
    `SELECT metrics, computed_at FROM siton.viral_metrics_cache WHERE scope_type=$1 AND scope_id=$2 LIMIT 1`,
    [scopeType, scopeId]
  );
  if (!res.rowCount) return { metrics: null, computed_at: null, stale: true };
  const row = res.rows[0];
  const computedAt = new Date(String(row.computed_at)).toISOString();
  return {
    metrics: typeof row.metrics === "string" ? JSON.parse(row.metrics) : row.metrics,
    computed_at: computedAt,
    stale: Date.now() - Date.parse(computedAt) > CACHE_FRESH_MS
  };
}

export async function enqueueViralRecompute(db: Queryable, dealId: string, reason: string): Promise<void> {
  await db.query(
    `INSERT INTO siton.outbox_events(event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
     VALUES ('viral_recompute','deal',$1,$2,'pending',0, now())
     ON CONFLICT DO NOTHING`,
    [dealId, JSON.stringify({ deal_id: dealId, reason })]
  );
}

// ── Participant impact (safe aggregates only, no descendant PII) ───────────
export async function getParticipantImpact(db: Queryable, participantId: string): Promise<Record<string, unknown>> {
  const res = await db.query(
    `WITH RECURSIVE branch AS (
       SELECT va.participant_id, va.generation, 0 AS rel_depth
       FROM siton.viral_attributions va
       WHERE va.parent_participant_id = $1
       UNION ALL
       SELECT va.participant_id, va.generation, b.rel_depth + 1
       FROM siton.viral_attributions va
       JOIN branch b ON va.parent_participant_id = b.participant_id
       WHERE b.rel_depth < 30
     )
     SELECT
       COUNT(*)::int AS descendants,
       COUNT(*) FILTER (WHERE rel_depth = 0)::int AS direct_children,
       COALESCE(MAX(rel_depth) + 1, 0)::int AS branch_depth,
       COALESCE(SUM(p.qty) FILTER (WHERE p.buyer_state NOT IN ('DealFailed','Dropped')), 0)::int AS units_joined,
       COALESCE(SUM(p.qty) FILTER (WHERE p.money_state IN ${SUCCESS_STATES_SQL}), 0)::int AS units_charged
     FROM branch
     JOIN siton.participants p ON p.participant_id = branch.participant_id`,
    [participantId]
  );
  const row = res.rows[0] || {};
  const linkRes = await db.query(
    `SELECT l.source_code, l.deal_id
     FROM siton.affiliate_links l
     JOIN siton.participants p ON p.participant_id = $1
     WHERE l.origin_type='participant' AND l.deal_id = p.deal_id AND l.origin_buyer_id = p.buyer_id
     LIMIT 1`,
    [participantId]
  );
  const link = linkRes.rows[0] || null;
  return {
    participant_id: participantId,
    direct_children: Number(row.direct_children || 0),
    descendants: Number(row.descendants || 0),
    branch_depth: Number(row.branch_depth || 0),
    units_joined_via_branch: Number(row.units_joined || 0),
    units_charged_via_branch: Number(row.units_charged || 0),
    personal_share_code: link ? String(link.source_code) : null,
    personal_share_url: link ? personalShareUrl(String(link.deal_id), String(link.source_code)) : null
  };
}
