import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  APP_DEPLOYMENT_MODE,
  GROW_API_KEY,
  GROW_APPROVE_PATH,
  GROW_CANCEL_URL,
  GROW_CREATE_PATH,
  GROW_NOTIFY_URL,
  GROW_PAGE_CODE,
  GROW_PROCESS_INFO_PATH,
  GROW_REFERENCE_ENCRYPTION_KEY,
  GROW_REFUND_PATH,
  GROW_SETTLE_PATH,
  GROW_SUCCESS_URL,
  GROW_TRANSACTION_INFO_PATH,
  GROW_USER_ID,
  PAYMENT_PROVIDER_BASE_URL,
  PAYMENT_PROVIDER_TIMEOUT_MS
} from "./runtime_config.js";

export type GrowResultClass = "success" | "permanent_fail" | "temporary_fail" | "unknown";
export type GrowTransportRequest = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: URLSearchParams;
  timeout_ms: number;
};
export type GrowTransportResponse = { status: number; body: unknown };
export type GrowTransport = (request: GrowTransportRequest) => Promise<GrowTransportResponse>;

export type GrowConfig = {
  base_url: string;
  user_id: string;
  page_code: string;
  api_key: string;
  reference_encryption_key: string;
  success_url: string;
  cancel_url: string;
  notify_url: string;
  timeout_ms: number;
  paths: {
    create: string;
    process_info: string;
    settle: string;
    refund: string;
    transaction_info: string;
    approve: string;
  };
};

export type GrowStartAuthorizationInput = {
  amount_minor: number;
  payer_name: string;
  payer_phone: string;
  payer_email?: string;
  description: string;
  correlation_id: string;
  success_url?: string;
  cancel_url?: string;
  notify_url?: string;
};

export type GrowProviderReference = {
  process_id: string;
  process_token: string;
  transaction_id?: string;
  transaction_token?: string;
};

function cleanBaseUrl(value: string) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function cleanPath(value: string) {
  const path = String(value || "").trim();
  return path.startsWith("/") ? path : `/${path}`;
}

function productionLike() {
  return ["production", "prod", "commercial-live"].includes(String(APP_DEPLOYMENT_MODE).toLowerCase());
}

function centsToIls(amountMinor: number) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new Error("grow_amount_minor_invalid");
  return (amountMinor / 100).toFixed(2);
}

function safeText(value: unknown, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

function responseData(payload: any): any {
  return payload && typeof payload === "object" && payload.data && typeof payload.data === "object"
    ? payload.data
    : {};
}

function growSucceeded(payload: any) {
  return String(payload?.status ?? "") === "1";
}

function growError(payload: any) {
  const error = payload?.err;
  if (error && typeof error === "object") return safeText(error.message || error.id || "grow_provider_error", 500);
  return safeText(error || "grow_provider_error", 500);
}

export function redactGrowLog(value: unknown): unknown {
  const sensitive = /token|apikey|api_key|userid|user_id|pagecode|page_code|authorization|secret/i;
  if (Array.isArray(value)) return value.map(redactGrowLog);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sensitive.test(key) ? "[REDACTED]" : redactGrowLog(item)]));
  }
  return value;
}

function classifyHttp(status: number): GrowResultClass {
  if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) return "temporary_fail";
  return "permanent_fail";
}

function statusFromData(data: any): {
  state: "authorized" | "captured" | "refunded" | "failed" | "pending" | "unknown";
  final: boolean;
} {
  const code = safeText(data?.statusCode, 20);
  const label = safeText(data?.status, 100).toLowerCase();
  if (code === "11" || label.includes("מושהית") || label.includes("suspended")) return { state: "authorized", final: true };
  if (code === "2" || label.includes("שולם") || label.includes("paid")) return { state: "captured", final: true };
  if (["3", "4", "5", "6", "7"].includes(code) || label.includes("failed") || label.includes("נדחה")) {
    return { state: "failed", final: true };
  }
  return { state: code ? "pending" : "unknown", final: false };
}

function encryptionKey(secret: string) {
  if (String(secret || "").length < 32) throw new Error("grow_reference_encryption_key_missing");
  return createHash("sha256").update(secret).digest();
}

export function sealGrowReference(reference: GrowProviderReference, secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(reference), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `grow_ref_v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function openGrowReference(value: string, secret: string): GrowProviderReference {
  const [version, ivRaw, tagRaw, ciphertextRaw] = String(value || "").split(".");
  if (version !== "grow_ref_v1" || !ivRaw || !tagRaw || !ciphertextRaw) throw new Error("grow_reference_invalid");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  const clear = Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, "base64url")), decipher.final()]);
  const parsed = JSON.parse(clear.toString("utf8"));
  if (!safeText(parsed?.process_id) || !safeText(parsed?.process_token)) throw new Error("grow_reference_invalid");
  return {
    process_id: safeText(parsed.process_id, 100),
    process_token: safeText(parsed.process_token, 300),
    ...(parsed.transaction_id ? { transaction_id: safeText(parsed.transaction_id, 100) } : {}),
    ...(parsed.transaction_token ? { transaction_token: safeText(parsed.transaction_token, 300) } : {})
  };
}

export function growConfigFromEnv(): GrowConfig {
  return {
    base_url: cleanBaseUrl(PAYMENT_PROVIDER_BASE_URL),
    user_id: GROW_USER_ID,
    page_code: GROW_PAGE_CODE,
    api_key: GROW_API_KEY,
    reference_encryption_key: GROW_REFERENCE_ENCRYPTION_KEY,
    success_url: GROW_SUCCESS_URL,
    cancel_url: GROW_CANCEL_URL,
    notify_url: GROW_NOTIFY_URL,
    timeout_ms: PAYMENT_PROVIDER_TIMEOUT_MS,
    paths: {
      create: cleanPath(GROW_CREATE_PATH),
      process_info: cleanPath(GROW_PROCESS_INFO_PATH),
      settle: cleanPath(GROW_SETTLE_PATH),
      refund: cleanPath(GROW_REFUND_PATH),
      transaction_info: cleanPath(GROW_TRANSACTION_INFO_PATH),
      approve: cleanPath(GROW_APPROVE_PATH)
    }
  };
}

export function assertGrowConfig(config: GrowConfig, requireUrls = true) {
  const missing = [
    ["PAYMENT_PROVIDER_BASE_URL", config.base_url],
    ["GROW_USER_ID", config.user_id],
    ["GROW_PAGE_CODE", config.page_code],
    ["GROW_REFERENCE_ENCRYPTION_KEY", config.reference_encryption_key]
  ].filter(([, value]) => !String(value || "").trim()).map(([name]) => name);
  if (requireUrls) {
    for (const [name, value] of [["GROW_SUCCESS_URL", config.success_url], ["GROW_CANCEL_URL", config.cancel_url], ["GROW_NOTIFY_URL", config.notify_url]]) {
      if (!String(value || "").trim()) missing.push(name);
      else if (!String(value).startsWith("https://")) throw new Error(`${name}_must_use_https`);
    }
  }
  if (String(config.reference_encryption_key || "").length > 0 && String(config.reference_encryption_key).length < 32) {
    throw new Error("GROW_REFERENCE_ENCRYPTION_KEY_must_be_at_least_32_characters");
  }
  if (missing.length) throw new Error(`grow_configuration_missing:${missing.join(",")}`);
}

export const defaultGrowTransport: GrowTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(request.timeout_ms)
  });
  const raw = await response.text();
  let body: unknown = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw_body: raw }; }
  return { status: response.status, body };
};

export function buildGrowPaymentAdapter(options: { config?: GrowConfig; transport?: GrowTransport } = {}) {
  const config = options.config || growConfigFromEnv();
  const transport = options.transport || defaultGrowTransport;
  const configured = (() => { try { assertGrowConfig(config); return true; } catch { return false; } })();

  async function post(path: string, fields: Record<string, string | number | undefined>) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) if (value !== undefined && value !== "") body.set(key, String(value));
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    try {
      const response = await transport({ url: `${config.base_url}${path}`, method: "POST", headers, body, timeout_ms: config.timeout_ms });
      return response;
    } catch (error) {
      return { status: 0, body: { transport_error: safeText((error as Error)?.message || "grow_transport_unknown", 500) } };
    }
  }

  return {
    providerCode: "grow",
    mode: "grow" as const,
    webhookProvider: "grow",
    configured,
    async startSuspendedAuthorization(input: GrowStartAuthorizationInput) {
      assertGrowConfig(config);
      if (!safeText(input.payer_name) || !/^05\d{8}$/.test(safeText(input.payer_phone, 20))) {
        return { result_class: "permanent_fail" as const, retryable: false, error_code: "grow_payer_invalid" };
      }
      const response = await post(config.paths.create, {
        pageCode: config.page_code,
        userId: config.user_id,
        apiKey: config.api_key || undefined,
        chargeType: 2,
        sum: centsToIls(input.amount_minor),
        successUrl: input.success_url || config.success_url,
        cancelUrl: input.cancel_url || config.cancel_url,
        notifyUrl: input.notify_url || config.notify_url,
        paymentNum: 1,
        description: safeText(input.description, 200),
        "pageField[fullName]": safeText(input.payer_name, 100),
        "pageField[phone]": safeText(input.payer_phone, 20),
        "pageField[email]": safeText(input.payer_email, 200) || undefined,
        cField1: safeText(input.correlation_id, 120)
      });
      if (response.status === 0) return { result_class: "unknown" as const, retryable: true, error_code: "grow_start_transport_unknown" };
      const payload: any = response.body;
      if (response.status < 200 || response.status >= 300) return { result_class: classifyHttp(response.status), retryable: classifyHttp(response.status) === "temporary_fail", error_code: growError(payload) };
      if (!growSucceeded(payload)) return { result_class: "permanent_fail" as const, retryable: false, error_code: growError(payload) };
      const data = responseData(payload);
      if (!safeText(data.processId) || !safeText(data.processToken) || !safeText(data.url)) {
        return { result_class: "unknown" as const, retryable: true, error_code: "grow_start_response_incomplete" };
      }
      const reference = { process_id: safeText(data.processId, 100), process_token: safeText(data.processToken, 300) };
      return {
        result_class: "success" as const,
        retryable: false,
        authorization_state: "pending_provider_confirmation" as const,
        payment_url: safeText(data.url, 2000),
        provider_reference: sealGrowReference(reference, config.reference_encryption_key),
        correlation_id: input.correlation_id
      };
    },
    async status(referenceValue: string) {
      assertGrowConfig(config, false);
      let reference: GrowProviderReference;
      try { reference = openGrowReference(referenceValue, config.reference_encryption_key); }
      catch { return { result_class: "permanent_fail" as const, state: "unknown" as const, final: false, error_code: "grow_reference_invalid" }; }
      const response = reference.transaction_id && reference.transaction_token
        ? await post(config.paths.transaction_info, { pageCode: config.page_code, transactionId: reference.transaction_id, transactionToken: reference.transaction_token })
        : await post(config.paths.process_info, { pageCode: config.page_code, processId: reference.process_id, processToken: reference.process_token });
      if (response.status === 0) return { result_class: "unknown" as const, state: "unknown" as const, final: false, error_code: "grow_status_transport_unknown" };
      if (response.status < 200 || response.status >= 300) return { result_class: classifyHttp(response.status), state: "unknown" as const, final: false, error_code: growError(response.body) };
      const payload: any = response.body;
      if (!growSucceeded(payload)) return { result_class: "permanent_fail" as const, state: "failed" as const, final: true, error_code: growError(payload) };
      const data = responseData(payload);
      const status = statusFromData(data);
      const updatedReference: GrowProviderReference = {
        ...reference,
        ...(data.transactionId ? { transaction_id: safeText(data.transactionId, 100) } : {}),
        ...(data.transactionToken ? { transaction_token: safeText(data.transactionToken, 300) } : {})
      };
      return { result_class: "success" as const, ...status, provider_reference: sealGrowReference(updatedReference, config.reference_encryption_key), amount_minor: Number.isFinite(Number(data.sum)) ? Math.round(Number(data.sum) * 100) : null, error_code: null };
    },
    normalizeCallback(input: Record<string, unknown>) {
      const processId = safeText(input.processId || input.process_id, 100);
      const processToken = safeText(input.processToken || input.process_token, 300);
      if (!processId || !processToken) {
        return { valid: false as const, error_code: "grow_callback_reference_missing", requires_authoritative_lookup: true as const };
      }
      const reference: GrowProviderReference = {
        process_id: processId,
        process_token: processToken,
        ...(input.transactionId || input.transaction_id ? { transaction_id: safeText(input.transactionId || input.transaction_id, 100) } : {}),
        ...(input.transactionToken || input.transaction_token ? { transaction_token: safeText(input.transactionToken || input.transaction_token, 300) } : {})
      };
      const statusCode = safeText(input.statusCode || input.status_code, 20);
      return {
        valid: true as const,
        event_id: createHash("sha256").update(`${processId}:${reference.transaction_id || ""}:${statusCode}`).digest("hex"),
        provider_reference: sealGrowReference(reference, config.reference_encryption_key),
        reported_status_code: statusCode || null,
        requires_authoritative_lookup: true as const,
        trusted_money_state: null
      };
    },
    async capture(referenceValue: string, amountMinor: number) {
      assertGrowConfig(config, false);
      const reference = openGrowReference(referenceValue, config.reference_encryption_key);
      const response = await post(config.paths.settle, { pageCode: config.page_code, userId: config.user_id, apiKey: config.api_key || undefined, processId: reference.process_id, processToken: reference.process_token, sum: centsToIls(amountMinor) });
      if (response.status === 0) return { result_class: "unknown" as const, retryable: true, error_code: "grow_capture_transport_unknown" };
      if (response.status < 200 || response.status >= 300) return { result_class: classifyHttp(response.status), retryable: classifyHttp(response.status) === "temporary_fail", error_code: growError(response.body) };
      const payload: any = response.body;
      if (!growSucceeded(payload)) return { result_class: "permanent_fail" as const, retryable: false, error_code: growError(payload) };
      const data = responseData(payload);
      const next = { ...reference, ...(data.transactionId ? { transaction_id: safeText(data.transactionId, 100) } : {}), ...(data.transactionToken ? { transaction_token: safeText(data.transactionToken, 300) } : {}) };
      return { result_class: "success" as const, retryable: false, provider_reference: sealGrowReference(next, config.reference_encryption_key) };
    },
    async refund(referenceValue: string, amountMinor: number) {
      assertGrowConfig(config, false);
      const reference = openGrowReference(referenceValue, config.reference_encryption_key);
      if (!reference.transaction_id || !reference.transaction_token) return { result_class: "permanent_fail" as const, retryable: false, error_code: "grow_refund_transaction_reference_missing" };
      const response = await post(config.paths.refund, { transactionId: reference.transaction_id, transactionToken: reference.transaction_token, refundSum: centsToIls(amountMinor), userId: config.user_id, pageCode: config.page_code, apiKey: config.api_key || undefined });
      if (response.status === 0) return { result_class: "unknown" as const, retryable: true, error_code: "grow_refund_transport_unknown" };
      if (response.status < 200 || response.status >= 300) return { result_class: classifyHttp(response.status), retryable: classifyHttp(response.status) === "temporary_fail", error_code: growError(response.body) };
      const payload: any = response.body;
      return growSucceeded(payload)
        ? { result_class: "success" as const, retryable: false, provider_reference: referenceValue }
        : { result_class: "permanent_fail" as const, retryable: false, error_code: growError(payload) };
    },
    configurationSummary() {
      return { provider: "grow", configured, production_fail_closed: productionLike(), base_url_configured: Boolean(config.base_url), user_id_configured: Boolean(config.user_id), page_code_configured: Boolean(config.page_code), api_key_configured: Boolean(config.api_key), encrypted_reference_configured: config.reference_encryption_key.length >= 32, callback_requires_authoritative_status_query: true, browser_receives_process_credentials: false };
    }
  };
}
