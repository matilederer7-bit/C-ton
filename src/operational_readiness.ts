type PaymentSummary = {
  provider: string;
  mode: "mock-backed" | "provider-ready" | "stripe";
  configured: boolean;
  webhook_provider: string;
  mock_backed: boolean;
  api_base_url_configured: boolean;
  api_key_configured: boolean;
  public_key_configured: boolean;
  authorization_path: string;
  capture_path?: string;
  recovery_path?: string;
  refund_path?: string;
  authorization_transport_live: boolean;
  tokenization_transport_live?: boolean;
  capture_transport_live?: boolean;
  recovery_transport_live?: boolean;
  refund_transport_live?: boolean;
  webhook_verification_live?: boolean;
  payment_reconcile_live?: boolean;
  timeout_ms: number;
  supported_modes: string[];
};

type NotificationSummary = {
  provider: string;
  mode: string;
  external_delivery: boolean;
};

type InvoiceSummary = {
  provider: string;
  mode: string;
  provider_mode?: string;
  configured?: boolean;
  api_base_url_configured?: boolean;
  api_key_configured?: boolean;
  bearer_token_configured?: boolean;
  webhook_secret_configured?: boolean;
  create_document_transport_live?: boolean;
  get_document_status_transport_live?: boolean;
  cancel_document_transport_live?: boolean;
  reconcile_document_transport_live?: boolean;
  webhook_verification_live?: boolean;
  external_issuance: boolean;
};

type PayoutSummary = {
  provider: string;
  mode: "internal-truth-only" | "adapter-ready";
  configured: boolean;
  api_base_url_configured: boolean;
  api_key_configured: boolean;
  create_payout_path: string;
  reconcile_payout_path: string;
  create_payout_transport_live: boolean;
  get_payout_status_transport_live: boolean;
  cancel_payout_transport_live: boolean;
  reconcile_payout_transport_live: boolean;
  external_transfer_executed: boolean;
  timeout_ms: number;
  supported_modes: string[];
  supported_methods: string[];
};

export function buildOperationalReadinessSummary(args: {
  deploymentMode: string;
  isDemoPreview: boolean;
  payment: PaymentSummary;
  payout: PayoutSummary;
  invoice: InvoiceSummary;
  notifications: NotificationSummary;
  debugSurfacesEnabled: boolean;
  webhookSecretSafe: boolean;
  webhookSecretIsDefault: boolean;
  sellerAuthMode: "demo-context" | "server-session";
  sellerAuthConfigured: boolean;
}) {
  const payment = args.payment;
  const payout = args.payout;
  const invoice = args.invoice;
  const notifications = args.notifications;
  const paymentStatus =
    payment.mode === "mock-backed"
      ? "mock"
      : payment.mode === "stripe" && payment.configured
        ? "stripe-live-adapter-ready"
        : payment.configured
        ? "partial"
        : "configured-mode-missing-env";

  const paymentActivation =
    payment.mode === "mock-backed"
      ? "cannot-activate-truly-yet"
      : payment.mode === "stripe" && payment.configured
        ? "first-real-adapter-ready"
      : payment.configured
        ? "core-money-rail-ready"
        : "blocked-by-missing-provider-env";

  return {
    runtime_env: {
      state: args.isDemoPreview ? "demo-preview" : "configured-runtime",
      deployment_mode: args.deploymentMode,
      env_driven: true,
      what_is_real: "runtime mode, host binding, port binding, database connection, worker loop, and webhook/idempotency storage",
      what_is_mock: args.isDemoPreview ? "commercial-live positioning is intentionally disabled in demo-preview" : "none in the runtime shell itself",
      what_is_env_driven: [
        "APP_DEPLOYMENT_MODE",
        "DATABASE_URL",
        "HOST",
        "PORT",
        "LOG_LEVEL",
        "OUTBOX_POLL_MS",
        "OUTBOX_MAX_ATTEMPTS"
      ],
      launch_readiness: args.isDemoPreview ? "controlled-demo" : "partial"
    },
    payment_provider: {
      state: paymentStatus,
      activation: paymentActivation,
      what_is_real: payment.mode !== "mock-backed" && payment.configured
        ? "live tokenization, authorization transport, capture transport, recovery transport, release/refund transport, authoritative status query, provider env wiring, webhook verification, and canonical authorization/capture/recovery/release/refund path selection"
        : "none of the external provider transport",
      what_is_mock: payment.mode === "mock-backed"
        ? "authorization, capture, recovery, and refund behavior are simulated inside the app"
        : "none in the core money rail once provider-ready is configured",
      what_is_partial: payment.mode !== "mock-backed"
        ? "webhook truth, duplicate-safe ingestion, late-webhook safety, and capture/recovery/refund reconciliation are live app rails, while invoice/accounting and non-payment external rails remain separate"
        : "none",
      depends_on_env: [
        "PAYMENT_PROVIDER",
        "PAYMENT_PROVIDER_MODE",
        "PAYMENT_ENVIRONMENT",
        "PAYMENT_PROVIDER_BASE_URL",
        "PAYMENT_PROVIDER_AUTH_PATH",
        "PAYMENT_PROVIDER_CAPTURE_PATH",
        "PAYMENT_PROVIDER_RECOVERY_PATH",
        "PAYMENT_PROVIDER_REFUND_PATH",
        "PAYMENT_PROVIDER_RELEASE_PATH",
        "PAYMENT_PROVIDER_STATUS_PATH",
        "PAYMENT_PROVIDER_API_KEY",
        "PAYMENT_PROVIDER_PUBLIC_KEY",
        "PAYMENT_WEBHOOK_PROVIDER",
        "PAYMENT_WEBHOOK_SECRET",
        "STRIPE_WEBHOOK_SECRET",
        "PAYMENT_AUTH_DECLINE_SUFFIX",
        "PAYMENT_PROVIDER_TIMEOUT_MS"
      ],
      can_activate_now: payment.mode !== "mock-backed" && payment.configured ? "partially" : "no"
    },
    payout_rail: {
      state: payout.mode === "internal-truth-only"
        ? "internal-truth-only"
        : payout.configured
          ? "adapter-ready-unwired"
          : "adapter-mode-missing-env",
      activation: payout.mode === "internal-truth-only"
        ? "internal-ledger-active"
        : payout.configured
          ? "future-adapter-contract-ready"
          : "blocked-by-missing-payout-provider-env",
      what_is_real: "seller payout eligibility, payout batches, payout items, payout attempts, reconciliation rows, outbox orchestration, retry semantics, and auditability",
      what_is_mock: payout.mode === "internal-truth-only"
        ? "no external seller transfer is executed yet; dispatch and reconcile close only the internal payout truth rail"
        : "external payout adapter is still not connected in this repository",
      what_is_partial: "future payout-provider execution remains adapter-only work; current batch reconciliation explicitly does not claim bank transfer execution",
      depends_on_env: [
        "PAYOUT_PROVIDER",
        "PAYOUT_PROVIDER_MODE",
        "PAYOUT_PROVIDER_BASE_URL",
        "PAYOUT_PROVIDER_DISPATCH_PATH",
        "PAYOUT_PROVIDER_RECONCILE_PATH",
        "PAYOUT_PROVIDER_API_KEY",
        "PAYOUT_PROVIDER_TIMEOUT_MS"
      ],
      can_activate_now: payout.mode === "internal-truth-only" ? "internally-yes-externally-no" : payout.configured ? "future-adapter-only" : "no"
    },
    authorization_charge_recovery: {
      state: payment.mode === "mock-backed" ? "partially-simulated" : payment.configured ? "authorization-capture-recovery-refund-partial" : "not-ready",
      what_is_real: payment.mode === "provider-ready" && payment.configured
        ? "state machine transitions, outbox scheduling, idempotency, webhook ingestion, webhook reconciliation, payment-attempt persistence, live authorization transport, live capture transport, live recovery transport, and live refund transport"
        : "state machine transitions, outbox scheduling, idempotency, webhook reconciliation, and persistence of payment attempts",
      what_is_mock: payment.mode === "mock-backed"
        ? "authorization, charge capture, recovery, and refund outcomes are generated by mock logic"
        : "none in the core money rail once provider-ready is configured",
      what_is_partial: payment.mode === "provider-ready" && payment.configured
        ? "authorization, capture, recovery, and refund now resolve through webhook truth, but invoice/accounting and broader external-finance coverage are still separate"
        : "webhook ingestion and reconciliation are real app rails, but they currently terminate into mock or placeholder payment execution behavior",
      can_activate_now: payment.mode === "provider-ready" && payment.configured ? "partially" : "no"
    },
    webhook_secret_policy: {
      state: args.webhookSecretSafe ? "safe" : "unsafe-default-or-missing",
      what_is_real: args.webhookSecretSafe
        ? "non-demo runtime has an explicit non-default webhook secret"
        : "none outside controlled demo fallback",
      what_is_mock: args.webhookSecretIsDefault
        ? "runtime is still relying on the known demo/default webhook secret"
        : "none",
      what_is_missing: args.webhookSecretSafe
        ? "rotation policy and secret-management discipline still depend on deployment setup"
        : "explicit non-default webhook secret for non-demo activation",
      can_activate_now: args.webhookSecretSafe ? "yes" : "no"
    },
    sms: {
      state: "not-connected",
      what_is_real: "OTP session storage and verification flow inside the app",
      what_is_mock: "the app verifies OTP internally and does not deliver a real SMS",
      what_is_missing: "external SMS transport, provider integration, delivery observability, and production sender configuration",
      can_activate_now: "no"
    },
    email: {
      state: "not-connected",
      what_is_real: "notification events are emitted inside the app",
      what_is_mock: "dispatch is log-only and no email transport exists",
      what_is_missing: "provider integration, templates, delivery status, and sender/domain setup",
      can_activate_now: "no"
    },
    receipts_invoices: {
      state: invoice.external_issuance && invoice.configured ? "activated-via-env" : "first-real-adapter-ready",
      what_is_real: "invoice document eligibility, canonical invoice_documents rows, invoice attempts, reconciliation cases, outbox-driven issue/reconcile flow, idempotency, correlation IDs, Morning/Green Invoice HTTP adapter, webhook verification, webhook dedupe, and reconcile outbox enqueue",
      what_is_mock: invoice.external_issuance && invoice.configured
        ? "none in the connected invoice transport itself"
        : "internal-truth-only remains available when INVOICE_PROVIDER is not set to the real adapter",
      what_is_missing: invoice.external_issuance && invoice.configured
        ? "deployed provider credentials validation, final tax/legal template approval, and production document delivery policy still depend on the target environment"
        : "live provider credentials, deployed webhook validation, final tax/legal template approval, official numbering/template policy, and production document delivery policy",
      depends_on_env: [
        "INVOICE_PROVIDER",
        "INVOICE_PROVIDER_MODE",
        "INVOICE_PROVIDER_BASE_URL",
        "INVOICE_PROVIDER_API_KEY",
        "INVOICE_PROVIDER_BEARER_TOKEN",
        "INVOICE_WEBHOOK_SECRET",
        "INVOICE_PROVIDER_CREATE_PATH",
        "INVOICE_PROVIDER_STATUS_PATH",
        "INVOICE_PROVIDER_CANCEL_PATH",
        "INVOICE_PROVIDER_TIMEOUT_MS"
      ],
      can_activate_now: invoice.external_issuance && invoice.configured ? "env-ready-awaiting-platform-access" : "yes-with-provider-env"
    },
    feature_flags: {
      state: "env-switches-only",
      what_exists: "behavior is driven by runtime env vars rather than a formal flag service",
      what_is_missing: "targeted rollout, audience segmentation, remote toggles, and audit trail for flag changes",
      can_activate_now: "partially"
    },
    preview_demo_mode: {
      state: args.isDemoPreview ? "active-demo-preview" : "inactive",
      what_is_real: "preview metadata route, public demo strip, and deployment-mode visibility in health/admin surfaces",
      what_is_mock: args.isDemoPreview ? "commercial rails remain explicitly inactive in demo-preview" : "none",
      leakage_risk: args.isDemoPreview ? "acceptable only for controlled demo" : "should stay hidden from public surfaces except explicit internal health/admin views",
      can_activate_now: args.isDemoPreview ? "yes" : "not-applicable"
    },
    seed_data: {
      state: "active-default-seeding",
      what_is_real: "demo bootstrap SQL, automatic seller account creation, automatic default seller backfill, and default affiliate bootstrap",
      what_is_hardcoded: [
        "seller-default",
        "affiliate-demo",
        "***1234 payout mask defaults",
        "bank_transfer payout method defaults"
      ],
      risk: "safe for demo and controlled first-run bootstrap, but not sufficient as a long-term multi-tenant provisioning model",
      can_activate_now: "partially"
    },
    debug_surfaces: {
      state: args.debugSurfacesEnabled ? "enabled" : "disabled",
      what_exists: "deal-level debug payload exposing deal, participants, outbox, DLQ, and payment attempts",
      risk: "should never be public in a live commercial runtime because it exposes internal operational state",
      can_activate_now: args.debugSurfacesEnabled ? "yes-for-controlled-debug-only" : "no"
    },
    seller_identity: {
      state: args.sellerAuthMode === "demo-context" ? "demo-context-scoping" : args.sellerAuthConfigured ? "server-session-controlled-launch" : "server-session-unconfigured",
      frontend_persistence: args.sellerAuthMode === "demo-context" ? "localStorage" : "server-trusted session cookie",
      backend_selector:
        args.sellerAuthMode === "demo-context"
          ? ["x-seller-id header", "seller_id query param", "default seller fallback"]
          : ["server-issued seller session"],
      hardening_boundary:
        args.sellerAuthMode === "demo-context"
          ? "seller-scoped publish and seller-management routes reject mismatched seller context, but there is still no real authentication layer"
          : args.sellerAuthConfigured
            ? "non-demo seller surfaces resolve authority from a server-issued seller session, while demo-preview stays on an explicitly isolated context-switching path"
            : "non-demo seller auth is expected to use server-issued sessions, but runtime secrets or invited-seller credentials are not fully configured",
      context_leakage_risk:
        args.sellerAuthMode === "demo-context"
          ? "high for a true multi-tenant public launch, because a caller can still choose seller context without proving identity; acceptable only for controlled demo, single-tenant operation, or tightly supervised first launch"
          : args.sellerAuthConfigured
            ? "reduced for controlled launch because caller-supplied seller headers are no longer authoritative in non-demo runtime; still not a full multi-tenant account platform"
            : "seller authority is intended to be server-trusted, but the runtime is not fully configured for controlled-launch auth yet",
      launch_readiness:
        args.sellerAuthMode === "demo-context"
          ? "acceptable only for controlled demo / constrained first launch"
          : args.sellerAuthConfigured
            ? "acceptable for controlled seller launch; still not the final open multi-tenant auth model"
            : "not sufficient until seller session secret and invited-seller credentials are configured"
    },
    production_assumptions: {
      state: "not-fully-met",
      what_is_ready: "core runtime, DB-backed state machine, public/seller surfaces, webhook persistence, and operational health views",
      what_blocks_true_production: [
        "real SMS",
        "real email",
        "real invoice/accounting rail",
        "invoice/accounting linkage on top of the live payment rail",
        "real payout-provider adapter / bank-transfer execution",
        "real seller authentication"
      ]
    }
  };
}
