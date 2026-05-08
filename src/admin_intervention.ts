// Admin intervention foundation.
//
// These helpers manage `siton.admin_control_flags`. The flags express SuperAdmin
// emergency intent: stop new joins, stop new charging work, freeze payout
// eligibility, hide a piece of content. They are read by request handlers and
// workers as gating predicates. They do NOT mutate deal state, buyer state,
// money state, or amounts. They never move money. They never delete content.

import { randomUUID } from "crypto";

export const ADMIN_FLAG_TYPES = [
  "pause_joining_emergency",
  "pause_charging_emergency",
  "payout_freeze",
  "content_takedown"
] as const;

export type AdminFlagType = (typeof ADMIN_FLAG_TYPES)[number];

export const ADMIN_FLAG_SCOPE_TYPES = [
  "global",
  "deal",
  "seller",
  "participant",
  "payout",
  "content"
] as const;

export type AdminFlagScopeType = (typeof ADMIN_FLAG_SCOPE_TYPES)[number];

export type AdminFlagRow = {
  flag_id: string;
  flag_type: AdminFlagType;
  scope_type: AdminFlagScopeType;
  scope_id: string;
  status: "active" | "released" | "expired";
  reason: string;
  metadata_jsonb: Record<string, unknown>;
  requested_by_admin_id: string | null;
  approved_by_admin_id: string | null;
  admin_action_id: string | null;
  request_id: string | null;
  correlation_id: string | null;
  expires_at: string | null;
  released_at: string | null;
  released_by_admin_id: string | null;
  released_reason: string | null;
  created_at: string;
  updated_at: string;
};

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>;
};

type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

export function isAdminFlagType(value: unknown): value is AdminFlagType {
  return (ADMIN_FLAG_TYPES as readonly string[]).includes(String(value || ""));
}

export function isAdminFlagScopeType(value: unknown): value is AdminFlagScopeType {
  return (ADMIN_FLAG_SCOPE_TYPES as readonly string[]).includes(String(value || ""));
}

let ensurePromise: Promise<void> | null = null;

export async function ensureAdminInterventionTables(withTx: WithTx) {
  if (ensurePromise) return ensurePromise;
  ensurePromise = withTx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('siton_admin_intervention_ddl'))`);
    await c.query(`
      CREATE TABLE IF NOT EXISTS siton.admin_control_flags (
        flag_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        flag_type TEXT NOT NULL CHECK (flag_type IN (
          'pause_joining_emergency',
          'pause_charging_emergency',
          'payout_freeze',
          'content_takedown'
        )),
        scope_type TEXT NOT NULL CHECK (scope_type IN (
          'global','deal','seller','participant','payout','content'
        )),
        scope_id TEXT NOT NULL DEFAULT 'global',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','expired')),
        reason TEXT NOT NULL,
        metadata_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
        requested_by_admin_id TEXT NULL,
        approved_by_admin_id TEXT NULL,
        admin_action_id UUID NULL,
        request_id TEXT NULL,
        correlation_id TEXT NULL,
        expires_at TIMESTAMPTZ NULL,
        released_at TIMESTAMPTZ NULL,
        released_by_admin_id TEXT NULL,
        released_reason TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_admin_control_flags_active
      ON siton.admin_control_flags (flag_type, scope_type, scope_id, status)
      WHERE status='active'`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_admin_control_flags_scope
      ON siton.admin_control_flags (scope_type, scope_id, status, created_at DESC)`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_admin_control_flags_expires
      ON siton.admin_control_flags (expires_at)
      WHERE expires_at IS NOT NULL AND status='active'`);

    await c.query(`
      CREATE TABLE IF NOT EXISTS siton.admin_control_flag_events (
        event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        flag_id UUID NOT NULL REFERENCES siton.admin_control_flags(flag_id) ON DELETE CASCADE,
        event_type TEXT NOT NULL CHECK (event_type IN ('flag.create','flag.release','flag.expire','flag.extend')),
        actor_ref TEXT NOT NULL DEFAULT 'admin',
        reason TEXT NOT NULL DEFAULT '',
        request_id TEXT NULL,
        correlation_id TEXT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_admin_control_flag_events_flag
      ON siton.admin_control_flag_events (flag_id, created_at DESC)`);

    await c.query(`
      CREATE TABLE IF NOT EXISTS siton.storage_orphan_reports (
        report_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        generated_by_admin_id TEXT NULL,
        storage_provider TEXT NOT NULL DEFAULT 'local',
        scanned_keys_count INTEGER NOT NULL DEFAULT 0,
        orphan_keys_count INTEGER NOT NULL DEFAULT 0,
        missing_files_count INTEGER NOT NULL DEFAULT 0,
        notes TEXT NULL,
        metadata_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_storage_orphan_reports_generated
      ON siton.storage_orphan_reports (generated_at DESC)`);
  });
  return ensurePromise;
}

export type CreateAdminFlagInput = {
  flag_type: AdminFlagType;
  scope_type: AdminFlagScopeType;
  scope_id?: string | null;
  reason: string;
  expires_at?: Date | string | null;
  metadata?: Record<string, unknown>;
  requested_by_admin_id?: string | null;
  approved_by_admin_id?: string | null;
  admin_action_id?: string | null;
  request_id?: string | null;
  correlation_id?: string | null;
};

export async function createAdminControlFlag(c: Queryable, input: CreateAdminFlagInput): Promise<AdminFlagRow> {
  const scopeId = String(input.scope_id || (input.scope_type === "global" ? "global" : "")).trim();
  if (!scopeId) {
    const err: any = new Error("admin_control_flag_scope_id_required");
    err.statusCode = 400;
    err.code = "admin_control_flag_scope_id_required";
    throw err;
  }
  if (!input.reason || !String(input.reason).trim()) {
    const err: any = new Error("admin_control_flag_reason_required");
    err.statusCode = 400;
    err.code = "admin_control_flag_reason_required";
    throw err;
  }
  // Pause/freeze emergencies must always be bounded in time. Operators must
  // explicitly extend if needed; an unbounded emergency pause is a footgun.
  if (input.flag_type === "pause_joining_emergency" || input.flag_type === "pause_charging_emergency") {
    if (!input.expires_at) {
      const err: any = new Error("admin_control_flag_expires_at_required_for_emergency_pause");
      err.statusCode = 400;
      err.code = "admin_control_flag_expires_at_required_for_emergency_pause";
      throw err;
    }
  }
  const expiresAtIso = input.expires_at ? new Date(input.expires_at).toISOString() : null;
  const inserted = await c.query(
    `INSERT INTO siton.admin_control_flags
       (flag_type, scope_type, scope_id, status, reason, metadata_jsonb,
        requested_by_admin_id, approved_by_admin_id, admin_action_id,
        request_id, correlation_id, expires_at)
     VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      input.flag_type,
      input.scope_type,
      scopeId,
      String(input.reason).trim(),
      JSON.stringify(input.metadata || {}),
      input.requested_by_admin_id || null,
      input.approved_by_admin_id || null,
      input.admin_action_id || null,
      input.request_id || null,
      input.correlation_id || null,
      expiresAtIso
    ]
  );
  const row = inserted.rows[0] as AdminFlagRow;
  await c.query(
    `INSERT INTO siton.admin_control_flag_events
       (flag_id, event_type, actor_ref, reason, request_id, correlation_id, payload)
     VALUES ($1,'flag.create',$2,$3,$4,$5,$6)`,
    [
      row.flag_id,
      input.requested_by_admin_id || "admin",
      String(input.reason).trim(),
      input.request_id || null,
      input.correlation_id || null,
      JSON.stringify({ scope_type: input.scope_type, scope_id: scopeId, expires_at: expiresAtIso })
    ]
  );
  return row;
}

export async function releaseAdminControlFlag(
  c: Queryable,
  flagId: string,
  args: {
    released_by_admin_id?: string | null;
    released_reason?: string | null;
    request_id?: string | null;
    correlation_id?: string | null;
  } = {}
) {
  const result = await c.query(
    `UPDATE siton.admin_control_flags
     SET status='released',
         released_at=now(),
         released_by_admin_id=$2,
         released_reason=$3,
         updated_at=now()
     WHERE flag_id=$1 AND status='active'
     RETURNING *`,
    [flagId, args.released_by_admin_id || null, args.released_reason || ""]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0] as AdminFlagRow;
  await c.query(
    `INSERT INTO siton.admin_control_flag_events
       (flag_id, event_type, actor_ref, reason, request_id, correlation_id, payload)
     VALUES ($1,'flag.release',$2,$3,$4,$5,$6)`,
    [
      row.flag_id,
      args.released_by_admin_id || "admin",
      String(args.released_reason || "").trim(),
      args.request_id || null,
      args.correlation_id || null,
      JSON.stringify({})
    ]
  );
  return row;
}

export async function listActiveAdminControlFlags(
  c: Queryable,
  filters: { flag_type?: AdminFlagType; scope_type?: AdminFlagScopeType; scope_id?: string } = {}
): Promise<AdminFlagRow[]> {
  const where: string[] = ["status='active'", "(expires_at IS NULL OR expires_at > now())"];
  const params: unknown[] = [];
  if (filters.flag_type) {
    params.push(filters.flag_type);
    where.push(`flag_type=$${params.length}`);
  }
  if (filters.scope_type) {
    params.push(filters.scope_type);
    where.push(`scope_type=$${params.length}`);
  }
  if (filters.scope_id) {
    params.push(filters.scope_id);
    where.push(`scope_id=$${params.length}`);
  }
  const sql = `SELECT * FROM siton.admin_control_flags WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 200`;
  const result = await c.query(sql, params);
  return result.rows as AdminFlagRow[];
}

export async function isFlagActive(
  c: Queryable,
  flagType: AdminFlagType,
  scopeType: AdminFlagScopeType,
  scopeId: string
): Promise<boolean> {
  // A flag matches if it is active, not expired, and either targets the exact
  // scope, or targets the global scope of the same flag type.
  const result = await c.query(
    `SELECT 1
     FROM siton.admin_control_flags
     WHERE flag_type=$1
       AND status='active'
       AND (expires_at IS NULL OR expires_at > now())
       AND (
         (scope_type='global' AND scope_id='global')
         OR (scope_type=$2 AND scope_id=$3)
       )
     LIMIT 1`,
    [flagType, scopeType, scopeId]
  );
  return Boolean(result.rowCount);
}

export async function expireDueAdminControlFlags(c: Queryable): Promise<number> {
  const result = await c.query(
    `UPDATE siton.admin_control_flags
     SET status='expired', updated_at=now()
     WHERE status='active' AND expires_at IS NOT NULL AND expires_at <= now()
     RETURNING flag_id`
  );
  for (const row of result.rows) {
    await c.query(
      `INSERT INTO siton.admin_control_flag_events (flag_id, event_type, actor_ref, reason, payload)
       VALUES ($1,'flag.expire','system','expires_at_reached','{}'::jsonb)`,
      [row.flag_id]
    ).catch(() => undefined);
  }
  return result.rowCount ?? 0;
}

export async function getAdminControlFlagsSummary(c: Queryable) {
  await expireDueAdminControlFlags(c).catch(() => undefined);
  const counts = await c.query(
    `SELECT flag_type, COUNT(*)::int AS active_count
     FROM siton.admin_control_flags
     WHERE status='active' AND (expires_at IS NULL OR expires_at > now())
     GROUP BY flag_type`
  );
  const summary: Record<AdminFlagType, number> = {
    pause_joining_emergency: 0,
    pause_charging_emergency: 0,
    payout_freeze: 0,
    content_takedown: 0
  };
  for (const row of counts.rows) {
    const flagType = String(row.flag_type || "");
    if (isAdminFlagType(flagType)) {
      summary[flagType as AdminFlagType] = Number(row.active_count) || 0;
    }
  }
  const expiringSoon = await c.query(
    `SELECT flag_id, flag_type, scope_type, scope_id, expires_at
     FROM siton.admin_control_flags
     WHERE status='active' AND expires_at IS NOT NULL
       AND expires_at > now() AND expires_at <= now() + interval '24 hours'
     ORDER BY expires_at ASC LIMIT 20`
  );
  return {
    active_counts: summary,
    expiring_within_24h: expiringSoon.rows,
    payout_freeze_active: summary.payout_freeze > 0,
    pause_joining_active: summary.pause_joining_emergency > 0,
    pause_charging_active: summary.pause_charging_emergency > 0,
    content_takedown_active: summary.content_takedown > 0
  };
}

export function adminControlFlagIdempotencyKey(input: { admin_action_id?: string | null; flag_type: string; scope_type: string; scope_id: string }): string {
  if (input.admin_action_id) return String(input.admin_action_id);
  return `${input.flag_type}:${input.scope_type}:${input.scope_id}:${randomUUID()}`;
}
