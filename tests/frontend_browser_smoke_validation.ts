import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
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
const frontendSource = join(repoRoot, "frontend");
const frontendTarget = join(repoRoot, ".tmp_test_dist", "frontend");
const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const compiledAppPath = join(__dirname, "..", "src", "app.js");
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

async function waitForHealth(getServerLog?: () => string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await wait(500);
  }
  const log = getServerLog?.();
  throw new Error(`smoke server did not become healthy in time${log ? `\n${log}` : ""}`);
}

async function dumpDom(path: string, viewport: { width: number; height: number }, label: string) {
  if (!existsSync(edgePath)) {
    throw new Error(`Edge executable not found at ${edgePath}`);
  }

  console.log(`SMOKE_DOM ${label} ${path}`);
  const profileDir = join(tmpdir(), `siton-browser-smoke-${label}-${Date.now()}`);
  await mkdir(profileDir, { recursive: true });
  const dumpFile = join(profileDir, "dump.html");

  // Edge 147+ requires the legacy headless mode for --dump-dom. The new
  // headless backend does not stream the rendered DOM to stdout. Additionally,
  // when launched via Node's child_process.spawn/execFile on Windows, Edge
  // exits with empty output because Chromium does not honor the piped stdout
  // handle the way a regular console process does. Launch Edge through
  // PowerShell's Start-Process with -RedirectStandardOutput, which sets up the
  // standard handle at the Win32 level that Edge actually respects.
  const psEdge = edgePath.replaceAll("\\", "\\\\");
  const psProfile = profileDir.replaceAll("\\", "\\\\");
  const psDump = dumpFile.replaceAll("\\", "\\\\");
  const psUrl = `${baseUrl}${path}`;
  const psCommand = [
    "$ErrorActionPreference='Stop';",
    `Start-Process -FilePath '${psEdge}'`,
    "-ArgumentList",
    [
      "'--headless=old'",
      "'--disable-gpu'",
      "'--no-first-run'",
      "'--no-default-browser-check'",
      `'--user-data-dir=${psProfile}'`,
      `'--window-size=${viewport.width},${viewport.height}'`,
      "'--virtual-time-budget=9000'",
      "'--dump-dom'",
      `'${psUrl}'`
    ].join(","),
    "-NoNewWindow",
    `-RedirectStandardOutput '${psDump}'`,
    "-Wait"
  ].join(" ");

  await new Promise<void>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCommand], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stderrBuf = "";
    child.stderr?.on("data", (chunk) => { stderrBuf += String(chunk); });
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("error", (error) => {
      clearTimeout(killTimer);
      reject(new Error(`Edge dump failed for ${path}: ${stderrBuf || error.message}`));
    });
    child.on("exit", (code) => {
      clearTimeout(killTimer);
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(`Edge dump exited ${code} for ${path}: ${stderrBuf}`));
      }
    });
  });

  let output = "";
  try {
    output = await readFile(dumpFile, "utf8");
  } catch {
    output = "";
  }
  // Cleanup is best-effort. Edge keeps Crashpad handles for a moment after
  // exit, so a forceful rm can race and produce ENOTEMPTY on Windows. Treat
  // cleanup errors as non-fatal so the assertion failure (if any) is the one
  // that surfaces.
  try {
    assert.ok(output.includes("<html"), `expected rendered HTML for ${path}`);
  } finally {
    rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
  return output;
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
    body: JSON.stringify({ seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true })
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
      payer_name: "Smoke Buyer",
      payment_method_id: `pm_browser_smoke_${dealId.replace(/-/g, "").slice(0, 18)}`,
      amount_minor: 1000,
      currency: "ILS"
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

function assertHealthyHebrewDom(dom: string, label: string) {
  const forbiddenPatterns = [
    /×|™|Â|ֲ·|ג€”|ג†/u,
    /(?:׳.){2,}/u
  ];
  for (const pattern of forbiddenPatterns) {
    assert.doesNotMatch(dom, pattern, `${label} contains mojibake-like text`);
  }

  const hebrewMatches = dom.match(/[\u0590-\u05ff]/gu) || [];
  assert.ok(hebrewMatches.length >= 20, `${label} should contain rendered Hebrew text`);
}

async function assertFrontendAssetsHealthy() {
  const checks = [
    { path: "/app", contentType: "text/html", expect: ["charset=utf-8", "/app/assets/app.js", "/app/assets/styles.css"] },
    { path: "/app/assets/app.js", contentType: "application/javascript", expect: ["charset=utf-8", "פתיחת עסקה חדשה", "אזור מוכר"] },
    { path: "/app/assets/styles.css", contentType: "text/css", expect: ["charset=utf-8", "direction"] }
  ];

  for (const check of checks) {
    const response = await fetch(`${baseUrl}${check.path}`);
    const text = await response.text();
    assert.equal(response.status, 200, `${check.path} should load`);
    assert.match(response.headers.get("content-type") || "", new RegExp(check.contentType));
    for (const expected of check.expect) {
      assert.match(`${response.headers.get("content-type") || ""}\n${text}`, new RegExp(escapeRegex(expected)), `${check.path} missing ${expected}`);
    }
    if (check.path !== "/app/assets/styles.css") {
      assertHealthyHebrewDom(text, check.path);
    }
  }
}

async function ensureFrontendAssets() {
  await mkdir(frontendTarget, { recursive: true });
  await cp(frontendSource, frontendTarget, { recursive: true, force: true });
}

async function main() {
  let serverStdout = "";
  let serverStderr = "";
  await ensureFrontendAssets();
  const server = spawn(process.execPath, [compiledAppPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(smokePort),
      HOST: "127.0.0.1",
      DISABLE_OUTBOX_WORKER: "1",
      APP_DEPLOYMENT_MODE: "demo-preview"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout?.on("data", (chunk) => { serverStdout += String(chunk); });
  server.stderr?.on("data", (chunk) => { serverStderr += String(chunk); });

  try {
    await waitForHealth(() => [
      server.exitCode === null ? "server_exit=running" : `server_exit=${server.exitCode}`,
      serverStdout ? `server_stdout:\n${serverStdout}` : "",
      serverStderr ? `server_stderr:\n${serverStderr}` : ""
    ].filter(Boolean).join("\n"));

    await run("frontend shell assets load as UTF-8 without mojibake", assertFrontendAssetsHealthy);

    const created = await createDeal("עסקת smoke לדפדפן");
    await publishDeal(created.deal_id);
    const joined = await createJoinedParticipant(created.deal_id);

    const desktopRoutes: SmokeRoute[] = [
      {
        name: "home",
        path: "/app",
        expect: ["סיטון", "פתיחת עסקה חדשה", "ניהול העסקאות שלי", "אזור מוכר"]
      },
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
        name: "home mobile",
        path: "/app",
        expect: ["סיטון", "פתיחת עסקה חדשה", "ניהול העסקאות שלי"]
      },
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
        assertHealthyHebrewDom(dom, `desktop ${route.name}`);
        for (const text of route.expect) {
          assert.match(dom, new RegExp(escapeRegex(text)));
        }
      }
    });

    await run("mobile smoke routes keep core hierarchy and CTA copy visible", async () => {
      for (const route of mobileRoutes) {
        const dom = await dumpDom(route.path, { width: 390, height: 844 }, `mobile-${route.name.replace(/\s+/g, "-")}`);
        assertHealthyHebrewDom(dom, `mobile ${route.name}`);
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

