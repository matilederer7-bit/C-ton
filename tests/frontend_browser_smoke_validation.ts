import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import dotenv from "dotenv";
import pg from "pg";
import { fileURLToPath } from "node:url";

dotenv.config();

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..");
const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const tsxCliPath = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const smokePort = 3310;
const baseUrl = `http://127.0.0.1:${smokePort}`;
const databaseUrl = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton";

type SmokeRoute = {
  name: string;
  path: string;
  expect: string[];
};

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  return { response, json };
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await wait(500);
  }
  throw new Error("smoke server did not become healthy in time");
}

async function dumpDom(path: string, viewport: { width: number; height: number }, label: string) {
  if (!existsSync(edgePath)) {
    throw new Error(`Edge executable not found at ${edgePath}`);
  }

  console.log(`SMOKE_DOM ${label} ${path}`);
  const profileDir = join(tmpdir(), `siton-browser-smoke-${label}-${Date.now()}`);
  await mkdir(profileDir, { recursive: true });

  try {
    const args = [
      "--headless",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profileDir}`,
      `--window-size=${viewport.width},${viewport.height}`,
      "--virtual-time-budget=9000",
      "--dump-dom",
      `${baseUrl}${path}`
    ];

    const output = await new Promise<string>((resolve, reject) => {
      execFile(edgePath, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 15_000, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Edge dump failed for ${path}: ${stderr || error.message}`));
          return;
        }
        resolve(stdout);
      });
    });

    assert.ok(output.includes("<html"), `expected rendered HTML for ${path}`);
    return output;
  } finally {
    await rm(profileDir, { recursive: true, force: true });
  }
}

function randomSuffix(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

async function seedDeliveryOptions(dealId: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(
      `INSERT INTO siton.deal_delivery_options (deal_id, option_type, label, cost, sort_order)
       VALUES
         ($1, 'pickup', 'איסוף עצמי', 0, 0),
         ($1, 'delivery', 'שליח עד הבית', 18, 1)`,
      [dealId]
    );
  } finally {
    await pool.end();
  }
}

async function createDeal(title: string) {
  const unique = randomSuffix("browser-smoke-create");
  const { response, json } = await fetchJson("/deals", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": unique,
      "idempotency-key": unique,
      "x-seller-id": "seller-default"
    },
    body: JSON.stringify({
      title,
      price_per_unit: 36,
      min_units: 8,
      max_units: 24,
      deadline: new Date(Date.now() + 4 * 60 * 60_000).toISOString()
    })
  });

  assert.equal(response.status, 200);
  assert.ok(json?.deal_id);
  const deal = json as { deal_id: string };
  await seedDeliveryOptions(deal.deal_id);
  return deal;
}

async function publishDeal(dealId: string) {
  const unique = randomSuffix("browser-smoke-publish");
  const { response } = await fetchJson(`/deals/${dealId}/publish`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": unique,
      "idempotency-key": unique,
      "x-seller-id": "seller-default"
    },
    body: JSON.stringify({ seller_terms_accepted: true })
  });

  assert.equal(response.status, 200);
}

async function createJoinedParticipant(dealId: string) {
  const publicDeal = await fetchJson(`/api/deals/${dealId}/public`);
  assert.equal(publicDeal.response.status, 200);
  const deliveryOptions = Array.isArray(publicDeal.json?.deal?.delivery_options)
    ? publicDeal.json.deal.delivery_options
    : [];
  const deliveryOptionId =
    deliveryOptions.find((option: any) => String(option.option_type || "").toLowerCase() === "delivery")?.option_id ||
    deliveryOptions[0]?.option_id;
  assert.ok(deliveryOptionId, "expected a delivery option for smoke join");

  const otpStart = await fetchJson("/api/otp/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone: "0501234567" })
  });
  assert.equal(otpStart.response.status, 200);

  const otpVerify = await fetchJson("/api/otp/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      otp_session_id: otpStart.json?.otp_session_id,
      code: otpStart.json?.development_code
    })
  });
  assert.equal(otpVerify.response.status, 200);

  const payment = await fetchJson("/api/payments/authorize-mock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      holder_name: "Smoke Buyer",
      card_number: "4111111111111111",
      expiry: "12/28",
      cvv: "123"
    })
  });
  assert.equal(payment.response.status, 200);

  const joinUnique = randomSuffix("browser-smoke-join");
  const joinResult = await fetchJson(`/deals/${dealId}/join`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": joinUnique,
      "idempotency-key": joinUnique
    },
    body: JSON.stringify({
      buyer_id: otpVerify.json?.buyer_id,
      qty: 3,
      delivery_option_id: deliveryOptionId,
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true,
      otp_token: otpVerify.json?.otp_token,
      otp_challenge_id: otpVerify.json?.challenge_id || otpVerify.json?.otp_session_id,
      delivery_address: "רחוב הדפדפן 10",
      delivery_city: "תל אביב",
      delivery_notes: "קומה 2"
    })
  });
  assert.equal(joinResult.response.status, 200);
  assert.ok(joinResult.json?.participant_id);

  return {
    participantId: String(joinResult.json.participant_id)
  };
}

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function main() {
  const server = spawn(process.execPath, [tsxCliPath, "src/app.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(smokePort),
      HOST: "127.0.0.1",
      DISABLE_OUTBOX_WORKER: "1",
      APP_DEPLOYMENT_MODE: "demo-preview"
    },
    stdio: "ignore"
  });

  try {
    await waitForHealth();

    const created = await createDeal("עסקת smoke לדפדפן");
    await publishDeal(created.deal_id);
    const joined = await createJoinedParticipant(created.deal_id);

    const desktopRoutes: SmokeRoute[] = [
      {
        name: "public deal",
        path: `/app/deal/${created.deal_id}`,
        expect: ["עסקת smoke לדפדפן", "deal-hero-layout", "cta-panel"]
      },
      {
        name: "seller workspace",
        path: "/app/seller",
        expect: ["עסקת smoke לדפדפן", "workspace-focus-grid", "seller-board-section"]
      },
      {
        name: "seller deal",
        path: `/app/seller/deals/${created.deal_id}`,
        expect: ["עסקת smoke לדפדפן", "seller-deal-control-grid", "שליח עד הבית"]
      },
      {
        name: "buyer tracking",
        path: `/app/track/${joined.participantId}`,
        expect: [joined.participantId, "tracking-focus-grid", "journey-step"]
      },
      {
        name: "admin dashboard",
        path: "/app/admin",
        expect: ["מרכז שליטה תפעולי", "Omnisearch אדמין", "admin-urgency-grid", "חיפוש תפעולי"]
      },
      {
        name: "admin deal",
        path: `/app/admin/deals/${created.deal_id}`,
        expect: ["עסקת smoke לדפדפן", "admin-ops-hero-grid", "admin-ops-grid"]
      },
      {
        name: "participant ops",
        path: `/app/admin/participants/${joined.participantId}`,
        expect: [joined.participantId, "התראות למשתתף", "Outbox רלוונטי"]
      }
    ];

    const mobileRoutes: SmokeRoute[] = [
      {
        name: "public deal mobile",
        path: `/app/deal/${created.deal_id}`,
        expect: ["עסקת smoke לדפדפן", "cta-panel"]
      },
      {
        name: "seller workspace mobile",
        path: "/app/seller",
        expect: ["workspace-focus-grid", "seller-board-section"]
      },
      {
        name: "seller deal mobile",
        path: `/app/seller/deals/${created.deal_id}`,
        expect: ["עסקת smoke לדפדפן", "seller-deal-control-grid"]
      },
      {
        name: "buyer tracking mobile",
        path: `/app/track/${joined.participantId}`,
        expect: [joined.participantId, "tracking-focus-grid"]
      },
      {
        name: "admin dashboard mobile",
        path: "/app/admin",
        expect: ["מרכז שליטה תפעולי", "Omnisearch אדמין", "admin-urgency-grid"]
      }
    ];

    const fallbackRoutes: SmokeRoute[] = [
      {
        name: "not found route",
        path: "/app/does-not-exist",
        expect: ["empty-surface", "shell-main"]
      },
      {
        name: "missing tracking route",
        path: "/app/track/00000000-0000-0000-0000-000000000000",
        expect: ["empty-surface", "shell-live-region"]
      },
      {
        name: "missing participant ops route",
        path: "/app/admin/participants/00000000-0000-0000-0000-000000000000",
        expect: ["empty-surface", "shell-live-region"]
      }
    ];

    await run("desktop smoke routes render hydrated browser DOM", async () => {
      for (const route of desktopRoutes) {
        const dom = await dumpDom(route.path, { width: 1440, height: 1100 }, `desktop-${route.name.replace(/\s+/g, "-")}`);
        for (const text of route.expect) {
          assert.match(dom, new RegExp(escapeRegex(text)));
        }
      }
    });

    await run("mobile smoke routes keep core hierarchy and CTA copy visible", async () => {
      for (const route of mobileRoutes) {
        const dom = await dumpDom(route.path, { width: 390, height: 844 }, `mobile-${route.name.replace(/\s+/g, "-")}`);
        for (const text of route.expect) {
          assert.match(dom, new RegExp(escapeRegex(text)));
        }
      }
    });

    await run("browser smoke keeps fallback and missing-data routes sane", async () => {
      for (const route of fallbackRoutes) {
        const dom = await dumpDom(route.path, { width: 1280, height: 900 }, `fallback-${route.name.replace(/\s+/g, "-")}`);
        for (const text of route.expect) {
          assert.match(dom, new RegExp(escapeRegex(text)));
        }
      }
    });
  } finally {
    server.kill("SIGTERM");
    await wait(1000);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
