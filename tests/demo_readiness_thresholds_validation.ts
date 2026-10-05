import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerAdminDemoReadinessRoutes } from "../src/admin_demo_readiness_routes.js";

type Scenario = {
  dlqCount?: number;
  oldestPendingAgeSeconds?: number | null;
  isDemoPreview?: boolean;
};

const ALL_TABLES = [
  "deals",
  "participants",
  "outbox_events",
  "outbox_dlq",
  "idempotency_log",
  "payment_attempts",
  "webhook_events",
  "seller_accounts",
  "audit_log",
  "notification_events",
  "invoice_documents",
  "seller_payout_batches",
  "operational_cases"
];

async function responseFor(scenario: Scenario = {}) {
  let providerCallCount = 0;

  const paymentProvider = {
    providerCode: "threshold-test-payment",
    mode: "mock-backed",
    webhookProvider: "threshold-test-payment",
    configured: false,
    async authorize() { providerCallCount += 1; throw new Error("payment provider must not be called"); },
    async capture() { providerCallCount += 1; throw new Error("payment provider must not be called"); },
    async recover() { providerCallCount += 1; throw new Error("payment provider must not be called"); },
    async refund() { providerCallCount += 1; throw new Error("payment provider must not be called"); },
    async tokenize() { providerCallCount += 1; throw new Error("payment provider must not be called"); },
    async reauthorize() { providerCallCount += 1; throw new Error("payment provider must not be called"); },
    async release() { providerCallCount += 1; throw new Error("payment provider must not be called"); },
    async status() { providerCallCount += 1; throw new Error("payment provider must not be called"); },
    verifyWebhook() { providerCallCount += 1; throw new Error("payment provider must not be called"); },
    parseWebhookEvent() { providerCallCount += 1; throw new Error("payment provider must not be called"); }
  } as any;

  const payoutProvider = {
    providerCode: "threshold-test-payout",
    mode: "internal-truth-only",
    configured: true,
    async createPayout() { providerCallCount += 1; throw new Error("payout provider must not be called"); },
    async getPayoutStatus() { providerCallCount += 1; throw new Error("payout provider must not be called"); },
    async cancelPayout() { providerCallCount += 1; throw new Error("payout provider must not be called"); },
    async reconcilePayout() { providerCallCount += 1; throw new Error("payout provider must not be called"); },
    parsePayoutWebhookEvent() { providerCallCount += 1; throw new Error("payout provider must not be called"); }
  } as any;

  const app = Fastify({ logger: false });

  registerAdminDemoReadinessRoutes(app, {
    requireAdminRead: async () => true,
    deployFreshness: () => ({
      expected_commit_sha: "same-commit",
      runtime_commit_sha: "same-commit",
      is_stale: false,
      evidence: "threshold-test"
    }),
    paymentProvider,
    payoutProvider,
    isDemoPreview: scenario.isDemoPreview ?? false,
    invoiceSummary: {
      provider: "threshold-test-invoice",
      mode: "internal",
      configured: true,
      external_issuance: false
    },
    notificationSummary: {
      provider: "threshold-test-notification",
      mode: "log-only",
      external_delivery: false
    },
    isPublicMallEnabled: () => false,
    withTx: async (fn) => fn({
      async query(sql: string) {
        if (sql.includes("information_schema.schemata")) {
          return { rows: [{ schema_name: "siton" }] };
        }
        if (sql.includes("information_schema.tables")) {
          return { rows: ALL_TABLES.map((table_name) => ({ table_name })) };
        }
        if (sql.includes("FROM siton.outbox_events")) {
          const age = scenario.oldestPendingAgeSeconds ?? null;
          return {
            rows: [{
              pending: age == null ? 0 : 1,
              processing: 0,
              failed: 0,
              oldest_pending_age_s: age
            }]
          };
        }
        if (sql.includes("FROM siton.outbox_dlq")) {
          return { rows: [{ dlq_count: scenario.dlqCount ?? 0 }] };
        }
        if (sql.includes("seller_count")) {
          return {
            rows: [{
              seller_count: 1,
              public_deal_count: 1,
              joinable_count: 1,
              completed_count: 1,
              failed_count: 1
            }]
          };
        }
        throw new Error("unexpected readiness query: " + sql);
      }
    })
  });

  try {
    const res = await app.inject({ method: "GET", url: "/api/admin/demo-readiness" });
    assert.equal(res.statusCode, 200, res.body);
    return { body: res.json() as any, providerCallCount };
  } finally {
    await app.close();
  }
}

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log("PASS " + name);
  } catch (error) {
    console.error("FAIL " + name);
    throw error;
  }
}

await check("DLQ rows are a hard blocker", async () => {
  const { body, providerCallCount } = await responseFor({ dlqCount: 1 });
  assert.equal(body.queues.dlq_count, 1);
  assert.equal(body.verdict, "blocked");
  assert.equal(body.ok, false);
  assert.match(JSON.stringify(body.blockers), /outbox DLQ has 1 unresolved event\(s\)/);
  assert.equal(providerCallCount, 0, "readiness must not execute payment or payout providers");
});

await check("oldest pending outbox event older than one hour is a warning", async () => {
  const { body, providerCallCount } = await responseFor({ oldestPendingAgeSeconds: 3601 });
  assert.equal(body.queues.oldest_pending_age_seconds, 3601);
  assert.equal(body.verdict, "warning");
  assert.equal(body.ok, true);
  assert.match(JSON.stringify(body.warnings), /oldest pending outbox event is 60m old/);
  assert.equal(body.blockers.length, 0);
  assert.equal(providerCallCount, 0, "readiness must remain read-only");
});

await check("exactly one hour old is not over the warning threshold", async () => {
  const { body } = await responseFor({ oldestPendingAgeSeconds: 3600 });
  assert.equal(body.queues.oldest_pending_age_seconds, 3600);
  assert.doesNotMatch(JSON.stringify(body.warnings), /oldest pending outbox event/);
  assert.equal(body.verdict, "ready");
  assert.equal(body.ok, true);
});

await check("demo_preview echoes the injected runtime flag", async () => {
  const enabled = await responseFor({ isDemoPreview: true });
  const disabled = await responseFor({ isDemoPreview: false });
  assert.equal(enabled.body.environment.demo_preview, true);
  assert.equal(disabled.body.environment.demo_preview, false);
});

console.log("DEMO_READINESS_THRESHOLDS_PASS");
