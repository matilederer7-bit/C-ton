import { createClientFromRequest } from "npm:@base44/sdk";

type InvocationResult = {
  function_name: string;
  ok: boolean;
  status: "completed" | "failed" | "unknown";
  processed: number | null;
  error_code: string | null;
};

const BATCH_FUNCTIONS = [
  "reconcile-payment-jobs",
  "deliver-notifications",
  "reconcile-outbox-projections"
] as const;

function boundedLimit(value: unknown) {
  const parsed = Number(value ?? 20);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(50, parsed)) : 20;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }

  const base44 = createClientFromRequest(req);
  let user: any;
  try {
    user = await base44.auth.me();
  } catch {
    return Response.json({ ok: false, error: "automation_authentication_required" }, { status: 401 });
  }
  if (!user?.id || String(user.role || "") !== "admin") {
    return Response.json({ ok: false, error: "automation_admin_required" }, { status: 403 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const limit = boundedLimit(body.limit);
  const tickId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const results: InvocationResult[] = [];

  for (const functionName of BATCH_FUNCTIONS) {
    try {
      const invocation = await base44.asServiceRole.functions.invoke(functionName, {
        limit,
        worker_tick_id: tickId,
        source: "siton-worker-tick"
      });
      const payload = invocation?.data || invocation || {};
      results.push({
        function_name: functionName,
        ok: payload?.ok === true,
        status: payload?.ok === true ? "completed" : "failed",
        processed: Number.isFinite(Number(payload?.processed)) ? Number(payload.processed) : null,
        error_code: payload?.ok === true ? null : String(payload?.code || payload?.error || "batch_failed")
      });
    } catch (error) {
      results.push({
        function_name: functionName,
        ok: false,
        status: "unknown",
        processed: null,
        error_code: String((error as Error)?.message || "invocation_unknown").slice(0, 200)
      });
    }
  }

  const ok = results.every((result) => result.ok);
  return Response.json({
    ok,
    tick_id: tickId,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    bounded_limit: limit,
    results
  }, { status: ok ? 200 : 503 });
});
