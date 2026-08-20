const COMPUTE_ORDER = ["nano", "micro", "small", "medium", "large", "xl", "2xl", "4xl", "8xl", "12xl", "16xl", "24xl"];

export type ComputeManagementStatus = {
  supported: boolean;
  enabled: boolean;
  action_available: boolean;
  production_only: true;
  current_tier: string | null;
  available_tiers: string[];
  reason: string | null;
  possible_downtime: true;
  estimated_cost: null;
  cost_note_he: "בדוק עלות ב-Supabase";
};

function normalizeTier(value: unknown) {
  const text = String(value || "").trim().toLowerCase().replace(/^ci_/, "");
  return COMPUTE_ORDER.includes(text) ? text : null;
}

function collectComputeObjects(value: unknown, found: any[] = []): any[] {
  if (Array.isArray(value)) {
    for (const item of value) collectComputeObjects(item, found);
  } else if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    const type = String(item.addon_type || item.type || "").toLowerCase();
    const nestedVariant = item.variant && typeof item.variant === "object" ? item.variant as Record<string, unknown> : null;
    const variant = normalizeTier(item.addon_variant || nestedVariant?.id || nestedVariant?.name || item.id || item.identifier || item.name);
    if ((type.includes("compute") || item.addon_variant) && variant) found.push(item);
    for (const child of Object.values(item)) collectComputeObjects(child, found);
  }
  return found;
}

function parseComputeSelection(value: unknown) {
  const body = value && typeof value === "object" ? value as Record<string, any> : {};
  const selected = Array.isArray(body.selected_addons)
    ? body.selected_addons.find((item: any) => String(item?.type || item?.addon_type || "").toLowerCase() === "compute_instance")
    : null;
  const available = Array.isArray(body.available_addons)
    ? body.available_addons.find((item: any) => String(item?.type || item?.addon_type || "").toLowerCase() === "compute_instance")
    : null;
  const selectedTier = normalizeTier(selected?.variant?.id || selected?.variant?.name || selected?.addon_variant);
  const documentedTiers = Array.isArray(available?.variants)
    ? available.variants.map((item: any) => normalizeTier(item?.id || item?.name)).filter(Boolean) as string[]
    : [];
  if (selectedTier || documentedTiers.length) return { currentTier: selectedTier, availableTiers: [...new Set(documentedTiers)] };

  const compute = collectComputeObjects(value);
  const active = compute.find((item) => item.active === true || item.current === true || ["active", "enabled", "provisioned"].includes(String(item.status || "").toLowerCase())) || (compute.length === 1 ? compute[0] : null);
  const currentTier = normalizeTier(active?.addon_variant || active?.variant?.id || active?.variant || active?.id || active?.identifier || active?.name);
  const availableTiers = [...new Set(compute.map((item) => normalizeTier(item.addon_variant || item.variant?.id || item.variant || item.id || item.identifier || item.name)).filter(Boolean))] as string[];
  return { currentTier, availableTiers };
}

export class SupabaseComputeManager {
  private readonly seen = new Map<string, Promise<any>>();
  private changes: number[] = [];
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private config() {
    const token = String(process.env.SUPABASE_MANAGEMENT_API_TOKEN || "").trim();
    const projectRef = String(process.env.SUPABASE_PROJECT_REF || "").trim();
    const enabled = String(process.env.SUPABASE_COMPUTE_MANAGEMENT_ENABLED || "false").toLowerCase() === "true";
    const production = process.env.NODE_ENV === "production" && process.env.APP_DEPLOYMENT_MODE === "production";
    return { token, projectRef, enabled, production };
  }

  private signal() {
    return AbortSignal.timeout(Number(process.env.SUPABASE_MANAGEMENT_TIMEOUT_MS || 5000));
  }

  async describe(): Promise<ComputeManagementStatus> {
    const config = this.config();
    const base: ComputeManagementStatus = {
      supported: true,
      enabled: config.enabled,
      action_available: false,
      production_only: true,
      current_tier: null,
      available_tiers: [],
      reason: null,
      possible_downtime: true,
      estimated_cost: null,
      cost_note_he: "בדוק עלות ב-Supabase"
    };
    if (!config.projectRef) return { ...base, reason: "SUPABASE_PROJECT_REF_missing" };
    if (!config.token) return { ...base, reason: "SUPABASE_MANAGEMENT_API_TOKEN_missing" };
    try {
      const response = await this.fetchImpl(`https://api.supabase.com/v1/projects/${encodeURIComponent(config.projectRef)}/billing/addons`, {
        headers: { authorization: `Bearer ${config.token}`, accept: "application/json" },
        signal: this.signal()
      });
      if (!response.ok) return { ...base, reason: `supabase_billing_addons_http_${response.status}` };
      const body = await response.json();
      const { currentTier, availableTiers } = parseComputeSelection(body);
      return {
        ...base,
        current_tier: currentTier,
        available_tiers: availableTiers,
        action_available: Boolean(config.enabled && config.production && currentTier),
        reason: !config.enabled ? "feature_flag_disabled" : !config.production ? "production_environment_required" : currentTier ? null : "current_compute_tier_unavailable"
      };
    } catch (error) {
      return { ...base, reason: String((error as Error)?.message || "supabase_billing_addons_unavailable").slice(0, 160) };
    }
  }

  async upgrade(input: { current_tier: string; target_tier: string; idempotency_key: string; downtime_acknowledged: boolean }) {
    const existing = this.seen.get(input.idempotency_key);
    if (existing) return existing;
    const operation = this.performUpgrade(input);
    this.seen.set(input.idempotency_key, operation);
    return operation;
  }

  private async performUpgrade(input: { current_tier: string; target_tier: string; idempotency_key: string; downtime_acknowledged: boolean }) {
    const config = this.config();
    if (!config.enabled) throw Object.assign(new Error("compute_management_feature_disabled"), { statusCode: 403 });
    if (!config.production) throw Object.assign(new Error("compute_management_production_only"), { statusCode: 403 });
    if (!config.token || !config.projectRef) throw Object.assign(new Error("compute_management_not_configured"), { statusCode: 503 });
    if (!input.downtime_acknowledged) throw Object.assign(new Error("downtime_acknowledgement_required"), { statusCode: 400 });
    const current = normalizeTier(input.current_tier);
    const target = normalizeTier(input.target_tier);
    if (!current || !target || COMPUTE_ORDER.indexOf(target) !== COMPUTE_ORDER.indexOf(current) + 1) {
      throw Object.assign(new Error("only_next_tier_upgrade_allowed"), { statusCode: 400 });
    }
    const now = Date.now();
    this.changes = this.changes.filter((at) => at >= now - 10 * 60_000);
    if (this.changes.length >= 3) throw Object.assign(new Error("compute_management_rate_limited"), { statusCode: 429 });
    const status = await this.describe();
    if (status.current_tier !== current) throw Object.assign(new Error("compute_current_tier_changed"), { statusCode: 409, actualCurrentTier: status.current_tier });
    this.changes.push(now);
    const response = await this.fetchImpl(`https://api.supabase.com/v1/projects/${encodeURIComponent(config.projectRef)}/billing/addons`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json", "idempotency-key": input.idempotency_key },
      signal: this.signal(),
      body: JSON.stringify({ addon_type: "compute_instance", addon_variant: `ci_${target}` })
    });
    if (!response.ok) throw Object.assign(new Error(`supabase_compute_upgrade_http_${response.status}`), { statusCode: 502 });
    return { ok: true, status: "requested", current_tier: current, target_tier: target, requested_at: new Date().toISOString() };
  }
}
