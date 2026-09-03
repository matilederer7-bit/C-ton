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
  PAYMENT_ENVIRONMENT,
  PAYMENT_PROVIDER_BASE_URL,
  PAYMENT_PROVIDER_TIMEOUT_MS
} from "./runtime_config.js";

// ---------------------------------------------------------------------------
// Grow (formerly Meshulam) J4/J5 sandbox adapter — OFFICIAL CONTRACT (verified
// against https://developers.grow.business/ on 2026-09-01):
//
// - createPaymentProcess       POST form  {pageCode,userId,sum,chargeType,...}
//   chargeType=2 is the documented "Suspended Charge" (J5 authorization; the
//   J5 hold is documented as valid for up to 7 days, auto-released after ~10
//   days when no J4 is performed).
// - getPaymentProcessInfo      POST form  {pageCode,processId,processToken}
//   Response nests transactions under data.transactions[] (array).
// - getTransactionInfo         POST form  {pageCode,transactionId,transactionToken}
// - settleSuspendedTransaction POST form  {userId,transactionId,transactionToken,sum}
//   (J4 capture — identified by TRANSACTION credentials, not process ones.)
// - refundTransaction          POST form  {userId,transactionId,transactionToken,refundSum[,pageCode]}
// - approveTransaction         MUST NOT be sent for delayed (J4/J5)
//   transactions. Official quote: "Do not send this request in the case of
//   token transactions ... or delayed transactions (J4J5)". This adapter
//   therefore NEVER calls the approve endpoint; the configured path exists
//   only for potential future non-J4J5 flows.
// - notifyUrl callback: plain form POST, NO documented signature/HMAC. The
//   callback is a hint only; canonical money truth always requires the
//   server-side authoritative status lookup above.
// - GROW_API_KEY: the official endpoint references above document NO apiKey
//   parameter for these methods; the adapter does not transmit it. The env
//   var remains accepted so Grow-support-instructed credentials can be staged
//   without a code change (documented decision, R9B).
// ---------------------------------------------------------------------------

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
  environment: string;
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

const GROW_SANDBOX_HOST = "sandbox.meshulam.co.il";

function baseUrlHost(baseUrl: string): string {
  try {
    return new URL(String(baseUrl || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function centsToIls(amountMinor: number) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new Error("grow_amount_minor_invalid");
  return (amountMinor / 100).toFixed(2);
}

function ilsToCents(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
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
  const sensitive = /token|apikey|api_key|userid|user_id|pagecode|page_code|authorization|secret|cardsuffix|card_suffix|cardexp|payerphone|payer_phone|payeremail|payer_email|fullname|full_name/i;
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

type GrowTransactionState = {
  state: "authorized" | "captured" | "refunded" | "failed" | "pending" | "unknown";
  final: boolean;
};

function stateFromStatusCode(code: string, label: string): GrowTransactionState {
  // Official status vocabulary (verified): statusCode "11" = עסקה מושהית
  // (suspended / J5 authorized), statusCode "2" = שולם (paid / captured).
  // Failure-family codes observed in the documented taxonomy map to failed.
  // Anything undocumented remains honestly pending/unknown — never guessed.
  if (code === "11" || label.includes("מושהית") || label.includes("suspended")) return { state: "authorized", final: true };
  if (code === "2" || label.includes("שולם") || label.includes("paid")) return { state: "captured", final: true };
  if (label.includes("זוכתה") || label.includes("refund")) return { state: "refunded", final: true };
  if (["3", "4", "5", "6", "7"].includes(code) || label.includes("failed") || label.includes("נדחה") || label.includes("נכשל")) {
    return { state: "failed", final: true };
  }
  return { state: code ? "pending" : "unknown", final: false };
}

type GrowTransactionRecord = {
  transaction_id: string;
  transaction_token: string;
  status: GrowTransactionState;
  amount_minor: number | null;
};

function readTransactionRecord(raw: any): GrowTransactionRecord {
  return {
    transaction_id: safeText(raw?.transactionId, 100),
    transaction_token: safeText(raw?.transactionToken, 300),
    status: stateFromStatusCode(safeText(raw?.statusCode, 20), safeText(raw?.status, 100).toLowerCase()),
    amount_minor: ilsToCents(raw?.sum)
  };
}

/**
 * getPaymentProcessInfo nests transactions as data.transactions[] (official
 * response shape); getTransactionInfo reports the transaction flat under
 * data. Normalize both, then pick the authoritative record: captured proof
 * dominates, then an active suspended authorization, then a declared
 * failure — never an optimistic guess.
 */
function selectAuthoritativeTransaction(data: any): GrowTransactionRecord | null {
  const list: GrowTransactionRecord[] = Array.isArray(data?.transactions)
    ? data.transactions.map(readTransactionRecord)
    : [];
  if (!list.length && (safeText(data?.statusCode, 20) || safeText(data?.transactionId, 100))) {
    list.push(readTransactionRecord(data));
  }
  if (!list.length) return null;
  const byState = (state: GrowTransactionState["state"]) => list.find((item) => item.status.state === state);
  return byState("captured") || byState("refunded") || byState("authorized") || byState("failed") || list[list.length - 1] || null;
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
    environment: String(PAYMENT_ENVIRONMENT || "").trim().toLowerCase(),
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
  // Sandbox/live separation is fail-closed in BOTH directions: a declared
  // sandbox environment may only call the official Grow sandbox host, and a
  // live environment must never call it. Credentials for one environment can
  // therefore never operate against the other's endpoints.
  const host = baseUrlHost(config.base_url);
  const environment = String(config.environment || "").trim().toLowerCase();
  if (config.base_url) {
    if (environment === "sandbox" && host !== GROW_SANDBOX_HOST) {
      throw new Error("grow_sandbox_environment_requires_sandbox_meshulam_base_url");
    }
    if (environment === "live" && host === GROW_SANDBOX_HOST) {
      throw new Error("grow_live_environment_cannot_use_sandbox_base_url");
    }
  }
  if (missing.length) throw new Error(`grow_configuration_missing:${missing.join(",")}`);
}

export const defaultGrowFetchTransport: GrowTransport = async (request) => {
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

/**
 * Application transport boundary. Non-production test suites may install
 * `globalThis.__SITON_GROW_TEST_TRANSPORT__` to prove UNKNOWN/transport-loss
 * behavior end-to-end without any network; production-like deployments
 * refuse the override so no test seam can ever intercept real money I/O.
 */
export const defaultGrowTransport: GrowTransport = async (request) => {
  const override = (globalThis as Record<string, unknown>).__SITON_GROW_TEST_TRANSPORT__;
  if (typeof override === "function" && !productionLike()) {
    return (override as GrowTransport)(request);
  }
  return defaultGrowFetchTransport(request);
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

  /**
   * Read-only authoritative lookup for a reference. Used by status() and by
   * capture() to resolve TRANSACTION credentials before settle (the official
   * settleSuspendedTransaction contract identifies the money by
   * transactionId/transactionToken, which only exist after the customer
   * completed the hosted J5 flow). Never a money movement.
   */
  async function lookup(reference: GrowProviderReference): Promise<
    | { ok: true; transaction: GrowTransactionRecord | null; reference: GrowProviderReference }
    | { ok: false; result_class: GrowResultClass; error_code: string }
  > {
    const response = reference.transaction_id && reference.transaction_token
      ? await post(config.paths.transaction_info, { pageCode: config.page_code, transactionId: reference.transaction_id, transactionToken: reference.transaction_token })
      : await post(config.paths.process_info, { pageCode: config.page_code, processId: reference.process_id, processToken: reference.process_token });
    if (response.status === 0) return { ok: false, result_class: "unknown", error_code: "grow_status_transport_unknown" };
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, result_class: classifyHttp(response.status), error_code: growError(response.body) };
    }
    const payload: any = response.body;
    if (!growSucceeded(payload)) return { ok: false, result_class: "permanent_fail", error_code: growError(payload) };
    const transaction = selectAuthoritativeTransaction(responseData(payload));
    const updated: GrowProviderReference = {
      ...reference,
      ...(transaction?.transaction_id ? { transaction_id: transaction.transaction_id } : {}),
      ...(transaction?.transaction_token ? { transaction_token: transaction.transaction_token } : {})
    };
    return { ok: true, transaction, reference: updated };
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
        // chargeType=2 — official "Suspended Charge" (J5). The customer's
        // hosted completion establishes the authorization; capture happens
        // ONLY through the server-side J4 settle with Siton's canonical
        // amount. approveTransaction is intentionally never sent (official
        // J4/J5 instruction).
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
      const looked = await lookup(reference);
      if (!looked.ok) {
        if (looked.result_class === "permanent_fail" && looked.error_code !== "grow_status_transport_unknown") {
          // Grow authoritatively rejected the lookup (e.g. unknown process):
          // report failed truthfully, never a guessed money state.
          return { result_class: "permanent_fail" as const, state: "failed" as const, final: true, error_code: looked.error_code };
        }
        return { result_class: looked.result_class, state: "unknown" as const, final: false, error_code: looked.error_code };
      }
      const status: GrowTransactionState = looked.transaction?.status || { state: "pending", final: false };
      return {
        result_class: "success" as const,
        ...status,
        provider_reference: sealGrowReference(looked.reference, config.reference_encryption_key),
        amount_minor: looked.transaction?.amount_minor ?? null,
        error_code: null
      };
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
      const customFields = input.customFields && typeof input.customFields === "object" ? input.customFields as Record<string, unknown> : {};
      const correlationId = safeText(input.cField1 ?? customFields.cField1, 120) || null;
      return {
        valid: true as const,
        event_id: createHash("sha256").update(`${processId}:${reference.transaction_id || ""}:${statusCode}`).digest("hex"),
        provider_reference: sealGrowReference(reference, config.reference_encryption_key),
        reported_status_code: statusCode || null,
        reported_amount_minor: ilsToCents(input.sum),
        correlation_id: correlationId,
        // The official Grow callback carries no signature: it can NEVER be
        // financial truth on its own. It only points reconciliation at the
        // authoritative server-side status lookup.
        requires_authoritative_lookup: true as const,
        trusted_money_state: null
      };
    },
    async capture(referenceValue: string, amountMinor: number) {
      assertGrowConfig(config, false);
      let reference = openGrowReference(referenceValue, config.reference_encryption_key);
      if (!reference.transaction_id || !reference.transaction_token) {
        // Official settle identifies money by transaction credentials. Resolve
        // them with a READ-ONLY authoritative lookup first (never money I/O);
        // an unresolvable reference is a safe bounded retry — no money moved.
        const looked = await lookup(reference);
        if (!looked.ok) {
          // READ-ONLY lookup failed: no settle request exists yet — a definite
          // pre-dispatch failure, safe to retry with the SAME identity.
          return { result_class: looked.result_class === "unknown" ? "temporary_fail" as const : looked.result_class, retryable: looked.result_class !== "permanent_fail", dispatched: false as const, error_code: looked.error_code };
        }
        reference = looked.reference;
        if (!reference.transaction_id || !reference.transaction_token) {
          return { result_class: "temporary_fail" as const, retryable: true, dispatched: false as const, error_code: "grow_capture_transaction_reference_missing" };
        }
      }
      const response = await post(config.paths.settle, {
        userId: config.user_id,
        transactionId: reference.transaction_id,
        transactionToken: reference.transaction_token,
        sum: centsToIls(amountMinor)
      });
      // R9C C2 — from here on the settle request MAY have reached Grow. The
      // official contract carries no per-operation idempotency key and never
      // states that a non-2xx/transport failure means "not executed", so every
      // non-success that is not an explicit Grow rejection is UNKNOWN (never a
      // retryable temporary failure that could mint a second settle).
      if (response.status === 0) return { result_class: "unknown" as const, retryable: false, dispatched: true as const, error_code: "grow_capture_transport_unknown" };
      if (response.status < 200 || response.status >= 300) return { result_class: "unknown" as const, retryable: false, dispatched: true as const, error_code: `grow_settle_http_${response.status}_ambiguous` };
      const payload: any = response.body;
      if (!growSucceeded(payload)) return { result_class: "permanent_fail" as const, retryable: false, dispatched: true as const, error_code: growError(payload) };
      const data = responseData(payload);
      const next = { ...reference, ...(data.transactionId ? { transaction_id: safeText(data.transactionId, 100) } : {}), ...(data.transactionToken ? { transaction_token: safeText(data.transactionToken, 300) } : {}) };
      return { result_class: "success" as const, retryable: false, dispatched: true as const, provider_reference: sealGrowReference(next, config.reference_encryption_key) };
    },
    async refund(referenceValue: string, amountMinor: number) {
      assertGrowConfig(config, false);
      const reference = openGrowReference(referenceValue, config.reference_encryption_key);
      if (!reference.transaction_id || !reference.transaction_token) return { result_class: "permanent_fail" as const, retryable: false, dispatched: false as const, error_code: "grow_refund_transaction_reference_missing" };
      const response = await post(config.paths.refund, {
        userId: config.user_id,
        transactionId: reference.transaction_id,
        transactionToken: reference.transaction_token,
        refundSum: centsToIls(amountMinor),
        pageCode: config.page_code
      });
      // R9C C2 — same rule as settle: after dispatch, only an explicit Grow
      // answer is a declared outcome; everything else is UNKNOWN.
      if (response.status === 0) return { result_class: "unknown" as const, retryable: false, dispatched: true as const, error_code: "grow_refund_transport_unknown" };
      if (response.status < 200 || response.status >= 300) return { result_class: "unknown" as const, retryable: false, dispatched: true as const, error_code: `grow_refund_http_${response.status}_ambiguous` };
      const payload: any = response.body;
      return growSucceeded(payload)
        ? { result_class: "success" as const, retryable: false, dispatched: true as const, provider_reference: referenceValue }
        : { result_class: "permanent_fail" as const, retryable: false, dispatched: true as const, error_code: growError(payload) };
    },
    /**
     * Release honesty (official contract): Grow documents NO native void for
     * a J5 hold — "if no J4 transaction is made, J5 will automatically
     * release after 10 days" (the J5 authorization itself is documented as up
     * to 7 days). The documented manual alternative (J4 followed by an
     * immediate refund) MOVES REAL MONEY and is therefore NOT implemented as
     * an automatic release strategy. This method only OBSERVES authoritative
     * provider truth; it never fabricates a release.
     */
    async observeRelease(referenceValue: string) {
      assertGrowConfig(config, false);
      let reference: GrowProviderReference;
      try { reference = openGrowReference(referenceValue, config.reference_encryption_key); }
      catch { return { result_class: "permanent_fail" as const, released: false, error_code: "grow_reference_invalid" }; }
      const looked = await lookup(reference);
      if (!looked.ok) return { result_class: looked.result_class, released: false, error_code: looked.error_code };
      const state = looked.transaction?.status.state || "pending";
      if (state === "failed" || state === "refunded") {
        // Provider-declared: no active hold remains. This is authoritative
        // proof that no money is held.
        return { result_class: "success" as const, released: true, error_code: null, provider_reference: sealGrowReference(looked.reference, config.reference_encryption_key) };
      }
      if (state === "captured") {
        return { result_class: "permanent_fail" as const, released: false, error_code: "grow_release_hold_already_captured" };
      }
      if (state === "authorized") {
        // The hold is still active and Grow exposes no native void: the only
        // safe path is the documented automatic expiry, observed via later
        // reconciliation. Reported honestly — never a fake AuthReleased.
        return { result_class: "permanent_fail" as const, released: false, error_code: "grow_release_pending_automatic_expiry" };
      }
      return { result_class: "unknown" as const, released: false, error_code: "grow_release_state_ambiguous" };
    },
    configurationSummary() {
      const environment = String(config.environment || "").trim().toLowerCase();
      return {
        provider: "grow",
        configured,
        environment,
        sandbox: environment === "sandbox",
        sandbox_host_enforced: environment !== "sandbox" || baseUrlHost(config.base_url) === GROW_SANDBOX_HOST,
        production_fail_closed: productionLike(),
        base_url_configured: Boolean(config.base_url),
        user_id_configured: Boolean(config.user_id),
        page_code_configured: Boolean(config.page_code),
        api_key_configured: Boolean(config.api_key),
        api_key_transmitted: false,
        encrypted_reference_configured: config.reference_encryption_key.length >= 32,
        callback_requires_authoritative_status_query: true,
        callback_native_authentication: "none_documented",
        approve_transaction_policy: "never_sent_for_j4j5",
        release_strategy: "automatic_expiry_observed_via_status_reconciliation",
        native_void_endpoint: false,
        settle_identifier: "transactionId+transactionToken",
        browser_receives_process_credentials: false,
        // R9C H1 — settle/refund transmit no Siton operation key; repeat
        // semantics are UNPROVEN, so ambiguous outcomes never auto-repeat.
        operation_idempotency_key_transmitted: false,
        repeat_settle_idempotent: "unproven",
        repeat_refund_idempotent: "unproven",
        ambiguous_settle_or_refund_policy: "unknown_then_status_lookup_then_manual_case_no_automatic_repeat"
      };
    }
  };
}
