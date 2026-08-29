import { assertDatabaseSchema } from "./schema_contract.js";
import { buildInventoryRepository, type InventoryQueryable } from "./inventory_repository.js";

export type RuntimeKind = "web" | "worker";

export function canonicalPostgresRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CANONICAL_POSTGRES_RUNTIME === "1";
}

export function expectedRuntimeRole(kind: RuntimeKind): string {
  return kind === "worker" ? "siton_worker_runtime" : "siton_web_runtime";
}

export async function assertCanonicalRuntimeReady(
  db: InventoryQueryable,
  kind: RuntimeKind,
  env: NodeJS.ProcessEnv = process.env
) {
  await assertDatabaseSchema(db);
  if (!canonicalPostgresRuntimeEnabled(env)) {
    return { ok: true as const, database: "connected", schema: "siton", boundary: "legacy-test" };
  }

  const expectedRole = expectedRuntimeRole(kind);
  const identity = await db.query(
    `SELECT current_user AS effective_role,
            session_user AS session_role,
            pg_has_role(current_user, $1, 'USAGE') AS has_runtime_role`,
    [expectedRole]
  );
  const effectiveRole = String(identity.rows[0]?.effective_role || "");
  const hasRuntimeRole = identity.rows[0]?.has_runtime_role === true;
  if (effectiveRole !== expectedRole || !hasRuntimeRole) {
    throw new Error(`canonical runtime role mismatch: expected ${expectedRole}`);
  }
  if (["postgres", "supabase_admin", "service_role"].includes(effectiveRole)) {
    throw new Error("administrative database role is forbidden for application runtime");
  }

  const probe = await buildInventoryRepository(db).probe();
  if (probe.service !== "siton_inventory_rpc" || probe.schema_version !== "v1") {
    throw new Error("canonical inventory repository is unavailable");
  }

  return {
    ok: true as const,
    database: "connected",
    schema: "siton",
    inventory: "siton_inventory_rpc_v1",
    runtime_role: expectedRole
  };
}

