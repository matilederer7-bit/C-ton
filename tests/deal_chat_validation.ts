import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton";
const pool = new Pool({ connectionString: DATABASE_URL });

async function runTest(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function createDeal(suffix: string, publish = true) {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const create = await app.inject({
    method: "POST",
    url: "/deals",
    headers: {
      "x-request-id": `deal-chat-create-${unique}`,
      "idempotency-key": `deal-chat-create-${unique}`
    },
    payload: {
      title: `Deal chat ${unique}`,
      price_per_unit: 35,
      min_units: 3,
      max_units: 12,
      deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      delivery_options: [{ option_type: "pickup", label: "Pickup", cost: 0 }]
    }
  });
  assert.equal(create.statusCode, 200);
  const dealId = (create.json() as any).deal_id;

  if (publish) {
    const publishResponse = await app.inject({
      method: "POST",
      url: `/deals/${dealId}/publish`,
      headers: {
        "x-request-id": `deal-chat-publish-${unique}`,
        "idempotency-key": `deal-chat-publish-${unique}`
      },
      payload: { seller_terms_accepted: true }
    });
    assert.equal(publishResponse.statusCode, 200);
  }

  return dealId as string;
}

async function forceDealState(dealId: string, state: string) {
  const paths: Record<string, Array<{ to: string; action: string }>> = {
    Completed: [
      { to: "TargetReached", action: "deal.target_reached" },
      { to: "ClosedForJoining", action: "deal.close_joining" },
      { to: "ReadyForCharging", action: "deal.prepare_charging" },
      { to: "Charging", action: "charging.start" },
      { to: "CompletionWindow", action: "charging.to_completion_window" },
      { to: "Completed", action: "charging.finalize_completed" }
    ],
    Failed: [{ to: "Failed", action: "deal.deadline_check" }],
    Cancelled: [{ to: "Cancelled", action: "deal.cancel" }]
  };
  const path = paths[state];
  assert.ok(path, `unsupported forced state ${state}`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('siton.in_atomic', 'true', true)`);
    await client.query(`SELECT set_config('siton.audit_written', '1', true)`);
    await client.query(`SELECT set_config('siton.outbox_written', '1', true)`);
    for (const step of path) {
      await client.query(`SELECT set_config('siton.action_name', $1, true)`, [step.action]);
      await client.query(`UPDATE siton.deals SET state=$2 WHERE deal_id=$1`, [dealId, step.to]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const dealA = await createDeal("a");
  const dealB = await createDeal("b");

  await runTest("GET chat for existing deal returns messages array", async () => {
    const response = await app.inject({ method: "GET", url: `/api/deals/${dealA}/chat` });
    assert.equal(response.statusCode, 200);
    const body = response.json() as any;
    assert.deepEqual(body.messages, []);
    assert.ok(body.generated_at);
  });

  await runTest("GET chat for missing deal returns 404", async () => {
    const response = await app.inject({ method: "GET", url: "/api/deals/00000000-0000-0000-0000-000000000000/chat" });
    assert.equal(response.statusCode, 404);
  });

  await runTest("POST chat creates a valid visible message", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/deals/${dealA}/chat`,
      payload: { display_name: "Mati", body: "Is pickup possible?" }
    });
    assert.equal(response.statusCode, 201);
    const body = response.json() as any;
    assert.equal(body.message.deal_id, dealA);
    assert.equal(body.message.display_name, "Mati");
    assert.equal(body.message.body, "Is pickup possible?");
  });

  await runTest("POST chat rejects empty body", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/deals/${dealA}/chat`,
      payload: { display_name: "Mati", body: "   " }
    });
    assert.equal(response.statusCode, 400);
  });

  await runTest("POST chat rejects body above 500 characters", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/deals/${dealA}/chat`,
      payload: { display_name: "Mati", body: "x".repeat(501) }
    });
    assert.equal(response.statusCode, 400);
  });

  await runTest("POST chat does not return dangerous HTML", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/deals/${dealA}/chat`,
      payload: { display_name: "<b>Mati</b>", body: "<script>alert(1)</script>" }
    });
    assert.equal(response.statusCode, 201);
    const message = (response.json() as any).message;
    assert.doesNotMatch(message.display_name, /[<>]/);
    assert.doesNotMatch(message.body, /[<>]/);
  });

  await runTest("hidden messages are not returned by GET", async () => {
    await pool.query(
      `INSERT INTO siton.deal_chat_messages (deal_id, display_name, body, status)
       VALUES ($1,$2,$3,'hidden')`,
      [dealA, "Hidden", "This should stay hidden"]
    );
    const response = await app.inject({ method: "GET", url: `/api/deals/${dealA}/chat` });
    assert.equal(response.statusCode, 200);
    const bodies = (response.json() as any).messages.map((message: any) => message.body);
    assert.ok(!bodies.includes("This should stay hidden"));
  });

  await runTest("Draft does not allow public chat", async () => {
    const draftDeal = await createDeal("draft", false);
    const getResponse = await app.inject({ method: "GET", url: `/api/deals/${draftDeal}/chat` });
    assert.equal(getResponse.statusCode, 403);
    const postResponse = await app.inject({
      method: "POST",
      url: `/api/deals/${draftDeal}/chat`,
      payload: { display_name: "Mati", body: "Hello" }
    });
    assert.equal(postResponse.statusCode, 403);
  });

  await runTest("Completed, Failed, and Cancelled do not allow writing", async () => {
    for (const state of ["Completed", "Failed", "Cancelled"]) {
      const dealId = await createDeal(`closed-${state}`, state !== "Cancelled");
      await forceDealState(dealId, state);
      const response = await app.inject({
        method: "POST",
        url: `/api/deals/${dealId}/chat`,
        payload: { display_name: "Mati", body: `Hello ${state}` }
      });
      assert.equal(response.statusCode, 403);
    }
  });

  await runTest("messages from one deal do not appear in another deal", async () => {
    await app.inject({
      method: "POST",
      url: `/api/deals/${dealB}/chat`,
      payload: { display_name: "Other", body: "Only deal B" }
    });
    const response = await app.inject({ method: "GET", url: `/api/deals/${dealA}/chat` });
    assert.equal(response.statusCode, 200);
    const bodies = (response.json() as any).messages.map((message: any) => message.body);
    assert.ok(!bodies.includes("Only deal B"));
  });

  await runTest("frontend renders chat empty state and escapes message body", async () => {
    const frontend = await readFile(join(process.cwd(), "frontend", "app.js"), "utf8");
    assert.match(frontend, /עדיין אין הודעות בעסקה הזאת/);
    assert.match(frontend, /כתבו שאלה או עדכון קצר/);
    assert.match(frontend, /function renderDealChatMessage/);
    assert.match(frontend, /<p>\$\{esc\(message\.body \|\| ""\)\}<\/p>/);
    assert.doesNotMatch(frontend, /message\.body[^;\n]*innerHTML/);
  });
}

try {
  await main();
} finally {
  await pool.end();
  await app.close();
}
