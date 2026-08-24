import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ quiet: true });

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..");
const frontendSource = join(repoRoot, "frontend");
const frontendTarget = join(repoRoot, ".tmp_test_dist", "frontend");
const compiledAppPath = join(__dirname, "..", "src", "app.js");
const artifactDir = join(repoRoot, ".ci-artifacts", "v1-1-browser-proof");
const browserCandidates = process.platform === "win32"
  ? ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"]
  : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const browserPath = browserCandidates.find((candidate) => existsSync(candidate)) || browserCandidates[0]!;
const serverPort = 34_000 + (process.pid % 500);
const baseUrl = `http://127.0.0.1:${serverPort}`;
const adminKey = "v11-browser-admin-key";
const sellerId = "seller-v11-browser";
const sellerEmail = "seller-v11-browser@example.test";
const sellerAccessCode = "v11-browser-access-123";
const otherSellerId = "seller-v11-browser-other";
const otherSellerEmail = "seller-v11-browser-other@example.test";
const otherSellerAccessCode = "v11-browser-other-access-123";

type CdpSession = {
  evaluate: (expression: string) => Promise<any>;
  getNetworkLog: () => Array<{ requestId: string; method: string; url: string; postData: string; status: number | null }>;
  navigate: (path: string) => Promise<void>;
  screenshot: (label: string) => Promise<string>;
  setViewport: (viewport: { width: number; height: number }) => Promise<void>;
};

type MallFixture = {
  dealId: string;
  title: string;
  dealType: "physical_product" | "voucher" | "ticket";
  state: "PendingTarget" | "TargetReached" | "Completed" | "Failed";
};

type MallSeed = { fixtures: MallFixture[]; hiddenDraftId: string };

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn();
    console.log(`PASS ${name}`);
    return result;
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function fetchJson(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const raw = await response.text();
  let json: any = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  return { response, json, raw };
}

async function waitForHealth(getServerLog: () => string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await wait(250);
  }
  throw new Error(`V1.1 browser server did not become healthy\n${getServerLog()}`);
}

async function openCdpPage(path: string) {
  if (!existsSync(browserPath)) throw new Error(`browser executable not found at ${browserPath}`);
  const profileDir = await mkdtemp(join(tmpdir(), "siton-v11-browser-"));
  const remoteDebuggingPort = 35_000 + Math.floor(Math.random() * 2_000);
  const browser = spawn(browserPath, [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-breakpad",
    "--disable-component-update",
    "--disable-crash-reporter",
    "--disable-default-apps",
    "--disable-domain-reliability",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-pings",
    `--remote-debugging-port=${remoteDebuggingPort}`,
    `--user-data-dir=${profileDir}`,
    `${baseUrl}${path}`
  ], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${remoteDebuggingPort}/json/list`);
      const pages = await response.json() as Array<{ url?: string; webSocketDebuggerUrl?: string }>;
      const page = pages.find((entry) => entry.url?.startsWith(baseUrl)) || pages[0];
      if (page?.webSocketDebuggerUrl) return { browser, profileDir, wsUrl: page.webSocketDebuggerUrl };
    } catch {}
    await wait(200);
  }

  browser.kill("SIGKILL");
  await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  throw new Error("browser CDP page did not become available");
}

async function waitForProcessExit(child: ReturnType<typeof spawn>, timeoutMs: number) {
  if (child.exitCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function withCdp<T>(path: string, fn: (cdp: CdpSession) => Promise<T>): Promise<T> {
  const page = await openCdpPage(path);
  const ws = new WebSocket(page.wsUrl);
  let sequence = 0;
  const networkLog: Array<{ requestId: string; method: string; url: string; postData: string; status: number | null }> = [];
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Network.requestWillBeSent") {
      const request = message.params?.request || {};
      const url = String(request.url || "");
      if (url.includes("/api/mall/events") || url.includes("/api/seller/session/logout")) {
        networkLog.push({
          requestId: String(message.params?.requestId || ""),
          method: String(request.method || ""),
          url,
          postData: String(request.postData || ""),
          status: null
        });
      }
    }
    if (message.method === "Network.responseReceived") {
      const requestId = String(message.params?.requestId || "");
      const entry = networkLog.find((candidate) => candidate.requestId === requestId);
      if (entry) entry.status = Number(message.params?.response?.status || 0);
    }
    if (!message.id || !pending.has(message.id)) return;
    const handlers = pending.get(message.id)!;
    pending.delete(message.id);
    if (message.error) handlers.reject(new Error(JSON.stringify(message.error)));
    else handlers.resolve(message.result);
  });

  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP command timed out: ${method}`));
    }, 15_000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      }
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP websocket did not open")), 15_000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP websocket failed"));
      }, { once: true });
    });
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Network.enable");

    const evaluate = async (expression: string) => {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true
      });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    };
    const navigate = async (targetPath: string) => {
      await send("Page.navigate", { url: `${baseUrl}${targetPath}` });
    };
    const setViewport = async (viewport: { width: number; height: number }) => {
      await send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.width <= 480
      });
    };
    const screenshot = async (label: string) => {
      await mkdir(artifactDir, { recursive: true });
      const captured = await send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false
      });
      const path = join(artifactDir, `${label.replace(/[^a-z0-9_-]/gi, "-")}.png`);
      await writeFile(path, Buffer.from(String(captured.data || ""), "base64"));
      return path;
    };

    return await fn({
      evaluate,
      getNetworkLog: () => networkLog.map((entry) => ({ ...entry })),
      navigate,
      screenshot,
      setViewport
    });
  } finally {
    await Promise.race([send("Browser.close").catch(() => undefined), wait(2_000)]);
    ws.close();
    const exited = await waitForProcessExit(page.browser, 5_000);
    if (!exited) page.browser.kill("SIGKILL");
    await rm(page.profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function waitForBrowser(cdp: CdpSession, expression: string, description: string, attempts = 80) {
  let lastValue: any = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    lastValue = await cdp.evaluate(expression);
    if (lastValue) return lastValue;
    await wait(200);
  }
  throw new Error(`browser did not reach ${description}; last value=${JSON.stringify(lastValue)}`);
}

async function waitForMallNetworkEvent(cdp: CdpSession, eventType: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const entry = cdp.getNetworkLog().find((candidate) => {
      try {
        return JSON.parse(candidate.postData || "{}").event_type === eventType && candidate.status === 202;
      } catch {
        return false;
      }
    });
    if (entry) return entry;
    await wait(100);
  }
  throw new Error(`POST /api/mall/events did not return 202 for ${eventType}: ${JSON.stringify(cdp.getNetworkLog())}`);
}

async function waitForNetworkResponse(cdp: CdpSession, pathname: string, method: string, status: number) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const entry = cdp.getNetworkLog().find((candidate) =>
      candidate.url.includes(pathname)
      && candidate.method === method
      && candidate.status === status
    );
    if (entry) return entry;
    await wait(100);
  }
  throw new Error(`${method} ${pathname} did not return ${status}: ${JSON.stringify(cdp.getNetworkLog())}`);
}

function requestToken(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

async function provisionSeller() {
  for (const seller of [
    { id: sellerId, email: sellerEmail, accessCode: sellerAccessCode, displayName: "מוכר בדיקת V1.1" },
    { id: otherSellerId, email: otherSellerEmail, accessCode: otherSellerAccessCode, displayName: "מוכר אחר בדיקת V1.1" }
  ]) {
    const result = await fetchJson(`/api/admin/seller-auth/${seller.id}/provision`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-key": adminKey,
        "x-request-id": requestToken("v11-provision")
      },
      body: JSON.stringify({
        display_name: seller.displayName,
        login_email: seller.email,
        access_code: seller.accessCode,
        auth_enabled: true
      })
    });
    assert.equal(result.response.status, 200, result.raw);
  }
}

async function loginSellerOverHttp() {
  const result = await fetchJson("/api/seller/session/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: sellerId, access_code: sellerAccessCode })
  });
  assert.equal(result.response.status, 200, result.raw);
  const setCookie = result.response.headers.get("set-cookie") || "";
  const match = /siton_seller_session=([^;]+)/.exec(setCookie);
  assert.ok(match, "seller login should issue the HttpOnly seller session cookie");
  return `siton_seller_session=${match[1]}`;
}

async function completeSellerProfile(cookie: string) {
  const key = requestToken("v11-seller-profile");
  const result = await fetchJson("/api/seller/profile", {
    method: "PUT",
    headers: sellerHeaders(cookie, key),
    body: JSON.stringify({
      business_name: "עסק בדיקת V1.1",
      support_email: sellerEmail,
      business_description: "פרופיל מקומי סינתטי לבדיקת דפדפן בלבד."
    })
  });
  assert.equal(result.response.status, 200, result.raw);
  assert.equal(result.json?.profile?.is_publish_ready, true);
}

function sellerHeaders(cookie: string, key: string) {
  return {
    "content-type": "application/json",
    cookie,
    "x-request-id": key,
    "idempotency-key": key
  };
}

async function createFixtureDeal(cookie: string, fixture: Omit<MallFixture, "dealId">) {
  const key = requestToken(`v11-create-${fixture.dealType}`);
  const common = {
    title: fixture.title,
    description: `תיאור ציבורי אמיתי עבור ${fixture.title}`,
    deal_type: fixture.dealType,
    price_per_unit: fixture.dealType === "voucher" ? 80 : fixture.dealType === "ticket" ? 65 : 45,
    min_units: 4,
    max_units: 20,
    deadline: new Date(Date.now() + 5 * 60 * 60_000).toISOString()
  };
  const typeSpecific = fixture.dealType === "voucher"
    ? {
        voucher_terms: {
          face_value_amount: 100,
          currency: "ILS",
          valid_from: new Date(Date.now() - 60_000).toISOString(),
          valid_until: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          redemption_location: "סניף בדיקת V1.1",
          redemption_instructions: "מציגים את הקוד בקופה.",
          terms: "שימוש חד פעמי.",
          is_single_use: true,
          allow_partial_redemption: false,
          voucher_code_mode: "system_generated"
        }
      }
    : fixture.dealType === "ticket"
      ? {
          ticket_terms: {
            event_name: "אירוע בדיקת V1.1",
            event_starts_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
            event_ends_at: new Date(Date.now() + 14 * 86_400_000 + 2 * 60 * 60_000).toISOString(),
            venue_name: "אולם הבדיקות",
            venue_address: "רחוב הבדיקות 1",
            venue_city: "תל אביב",
            entry_instructions: "הציגו את הכרטיס בכניסה.",
            ticket_type: "general_admission",
            seat_mode: "general_admission",
            transfer_allowed: false
          }
        }
      : {
          delivery_options: [
            { option_type: "delivery", label: "משלוח בדיקת V1.1", cost: 12, sort_order: 0 }
          ]
        };
  const created = await fetchJson("/deals", {
    method: "POST",
    headers: sellerHeaders(cookie, key),
    body: JSON.stringify({ ...common, ...typeSpecific })
  });
  assert.equal(created.response.status, 200, created.raw);
  assert.ok(created.json?.deal_id);

  const imageKey = requestToken(`v11-mall-image-${fixture.dealType}`);
  const uploaded = await fetchJson(`/api/seller/deals/${created.json.deal_id}/images`, {
    method: "POST",
    headers: sellerHeaders(cookie, imageKey),
    body: JSON.stringify({
      image_base64: "iVBORw0KGgoAAAANSUhEUgAAACAAAAAUCAIAAABj86gYAAAAK0lEQVR4nGOQr/KlKWIYtYBUC45FyVGIRi0YtWDUglELKLeA5oXdqAUYCACWmZnfwvSxZQAAAABJRU5ErkJggg==",
      mime_type: "image/png",
      original_filename: "v11-mall-primary.png",
      is_primary: true
    })
  });
  assert.equal(uploaded.response.status, 201, uploaded.raw);
  assert.equal(uploaded.json?.image?.is_primary, true);

  const publishKey = requestToken(`v11-publish-${fixture.dealType}`);
  const published = await fetchJson(`/deals/${created.json.deal_id}/publish`, {
    method: "POST",
    headers: sellerHeaders(cookie, publishKey),
    body: JSON.stringify({
      seller_terms_accepted: true,
      seller_critical_terms_accepted: true,
      seller_threshold_90_accepted: true
    })
  });
  assert.equal(published.response.status, 200, published.raw);

  return { ...fixture, dealId: String(created.json.deal_id) } satisfies MallFixture;
}

async function insertCanonicalMallFixture(
  pool: pg.Pool,
  fixture: Omit<MallFixture, "dealId">,
  publishedAt: string
) {
  assert.ok(["TargetReached", "Completed", "Failed"].includes(fixture.state));
  const inserted = await pool.query(
    `INSERT INTO siton.deals
       (seller_id, title, description, deal_type, state, price_per_unit,
        min_units, max_units, threshold_units, deadline, published_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,4,20,4,now()+interval '5 hours',$7,$7,$7)
     RETURNING deal_id::text`,
    [
      sellerId,
      fixture.title,
      `תיאור ציבורי אמיתי עבור ${fixture.title}`,
      fixture.dealType,
      fixture.state,
      fixture.dealType === "voucher" ? 80 : 65,
      publishedAt
    ]
  );
  const dealId = String(inserted.rows[0].deal_id);
  if (fixture.dealType === "voucher") {
    await pool.query(
      `INSERT INTO siton.deal_voucher_terms
         (deal_id, face_value_amount, currency, valid_from, valid_until,
          redemption_location, redemption_instructions, terms, is_single_use,
          allow_partial_redemption, voucher_code_mode)
       VALUES ($1,100,'ILS',now()-interval '1 minute',now()+interval '30 days',
               'סניף בדיקת V1.1','מציגים את הקוד בקופה.','שימוש חד פעמי.',true,false,'system_generated')`,
      [dealId]
    );
  }
  if (fixture.dealType === "ticket") {
    await pool.query(
      `INSERT INTO siton.deal_ticket_terms
         (deal_id, event_name, event_starts_at, event_ends_at, venue_name,
          venue_address, venue_city, entry_instructions, ticket_type, seat_mode, transfer_allowed)
       VALUES ($1,'אירוע בדיקת V1.1',now()+interval '14 days',now()+interval '14 days 2 hours',
               'אולם הבדיקות','רחוב הבדיקות 1','תל אביב','הציגו את הכרטיס בכניסה.',
               'general_admission','general_admission',false)`,
      [dealId]
    );
  }
  if (fixture.state === "TargetReached" || fixture.state === "Completed") {
    await pool.query(
      `INSERT INTO siton.participants
         (deal_id, buyer_id, qty, buyer_state, money_state, created_at, updated_at)
       VALUES ($1,$2,4,$3,$4,now(),now())`,
      [
        dealId,
        `v11-read-fixture-${dealId}`,
        fixture.state === "Completed" ? "DealCompleted" : "JoinedAuthorized",
        fixture.state === "Completed" ? "ChargedSuccess" : "AuthHeld"
      ]
    );
  }
  return { ...fixture, dealId } satisfies MallFixture;
}

async function seedMallFixtures(pool: pg.Pool, cookie: string) {
  const stamp = Date.now();
  // Historical/reached outcomes and their matching participant projections are
  // immutable synthetic read fixtures in the disposable test DB. They never
  // call a provider, payment endpoint, money action, or transition API.
  const ticket = await insertCanonicalMallFixture(pool, {
    title: `V1.1 כרטיס שלא הצליח ${stamp}`,
    dealType: "ticket",
    state: "Failed"
  }, new Date(Date.now() - 3_000).toISOString());
  const voucher = await insertCanonicalMallFixture(pool, {
    title: `V1.1 שובר שהושלם ${stamp}`,
    dealType: "voucher",
    state: "Completed"
  }, new Date(Date.now() - 2_000).toISOString());
  const reached = await insertCanonicalMallFixture(pool, {
    title: `V1.1 \u05de\u05d5\u05e6\u05e8 \u05e9\u05d4\u05d2\u05d9\u05e2 \u05dc\u05d9\u05e2\u05d3 ${stamp}`,
    dealType: "physical_product",
    state: "TargetReached"
  }, new Date(Date.now() - 1_000).toISOString());
  const product = await createFixtureDeal(cookie, {
    title: `V1.1 מוצר חדש ${stamp}`,
    dealType: "physical_product",
    state: "PendingTarget"
  });
  const hiddenDraft = await pool.query(
    `INSERT INTO siton.deals
       (seller_id, title, description, deal_type, state, price_per_unit,
        min_units, max_units, threshold_units, deadline, published_at, created_at, updated_at)
     VALUES ($1,$2,'Draft hidden from Mall browser proof','physical_product','Draft',45,
             4,20,4,now()+interval '5 hours',NULL,now(),now())
     RETURNING deal_id::text`,
    [sellerId, `V1.1 \u05d8\u05d9\u05d5\u05d8\u05d4 \u05de\u05d5\u05e1\u05ea\u05e8\u05ea ${stamp}`]
  );
  const hiddenDraftId = String(hiddenDraft.rows[0].deal_id);
  const fixtures: MallFixture[] = [product, reached, voucher, ticket];

  const response = await fetchJson("/api/mall/deals?sort=newest&limit=48");
  assert.equal(response.response.status, 200, response.raw);
  assert.equal(response.json?.ok, true);
  const fixtureIds = new Set(fixtures.map((fixture) => fixture.dealId));
  const fixtureRows = response.json.deals.filter((deal: any) => fixtureIds.has(String(deal.deal_id)));
  assert.deepEqual(
    fixtureRows.map((deal: any) => deal.deal_id),
    fixtures.map((fixture) => fixture.dealId),
    "Mall API should expose this run's synthetic canonical deals in relative newest order even when prior fixtures exist"
  );
  assert.deepEqual(
    new Set(fixtureRows.map((deal: any) => deal.deal_type)),
    new Set(["physical_product", "voucher", "ticket"])
  );
  assert.deepEqual(
    new Set(fixtureRows.map((deal: any) => deal.mall_status)),
    new Set(["underway", "reached_target", "succeeded", "failed"])
  );
  assert.ok(!response.json.deals.some((deal: any) => String(deal.deal_id) === hiddenDraftId));
  return { fixtures, hiddenDraftId } satisfies MallSeed;
}

async function provePublicMetadata(seed: MallSeed) {
  const product = seed.fixtures.find((fixture) => fixture.dealType === "physical_product" && fixture.state === "PendingTarget")!;
  const response = await fetch(`${baseUrl}/app/deal/${product.dealId}`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-robots-tag"), "index,follow");
  assert.ok(html.includes(`<title>${product.title} | C-ton</title>`), "public Deal metadata must use the canonical title and brand");
  assert.ok(html.includes(`<link rel="canonical" href="/app/deal/${product.dealId}" />`), "public Deal metadata must use its canonical URL");
  assert.match(html, /<meta property="og:description" content="[^"]+" \/>/);
  assert.match(html, /<meta property="og:image" content="\/api\/deal-images\/[0-9a-f-]{36}" \/>/i);
  assert.doesNotMatch(html, /storage_key|storage_object_ref|payment_reference|buyer_email|buyer_phone/i);
}

function assertSafeVisibleAuthText(text: string) {
  assert.doesNotMatch(text, /\b401\b/i, "seller auth UI must not expose raw HTTP 401");
  assert.doesNotMatch(text, /request failed with status code/i, "seller auth UI must not expose Axios-style failures");
  assert.doesNotMatch(text, /authentication[_ -]?required/i, "seller auth UI must not expose backend auth tokens");
  assert.doesNotMatch(text, /axios(?:error)?/i, "seller auth UI must not expose Axios implementation details");
}

function assertNoRawSellerTransportText(text: string) {
  assertSafeVisibleAuthText(text);
  assert.doesNotMatch(text, /\bHTTP\s*(?:401|403|404)\b/i, "seller UI must not expose raw HTTP status text");
  assert.doesNotMatch(text, /deal[_ ]not[_ ]found/i, "seller UI must not expose ownership-hiding backend codes");
  assert.doesNotMatch(text, /access[_ ]forbidden/i, "seller UI must not expose forbidden transport tokens");
  assert.doesNotMatch(text, /statusCode/i, "seller UI must not expose serialized transport errors");
}

async function proveMallBrowser(seed: MallSeed) {
  const { fixtures, hiddenDraftId } = seed;
  const product = fixtures.find((fixture) => fixture.dealType === "physical_product" && fixture.state === "PendingTarget")!;
  const reached = fixtures.find((fixture) => fixture.state === "TargetReached")!;
  const voucher = fixtures.find((fixture) => fixture.dealType === "voucher")!;
  const ticket = fixtures.find((fixture) => fixture.dealType === "ticket")!;

  await withCdp("/app/does-not-exist", async (cdp) => {
    await cdp.setViewport({ width: 1440, height: 1100 });
    await cdp.navigate("/app");
    await waitForBrowser(cdp, `document.querySelectorAll('[data-mall-card]').length >= 4`, "four Mall outcome cards");
    const newest = await cdp.evaluate(`(() => ({
      cards: [...document.querySelectorAll('[data-mall-card]')].map((card) => ({
        id: card.dataset.mallDealId,
        type: card.dataset.mallDealType,
        status: card.dataset.mallStatus
      })),
      mall: Boolean(document.querySelector('#mall-deals')),
      filters: document.querySelectorAll('[data-inline-action="mall-filter"]').length,
      direction: document.documentElement.dir || getComputedStyle(document.documentElement).direction,
      overflow: document.documentElement.scrollWidth - window.innerWidth
    }))()`);
    const targetIds = new Set(fixtures.map((fixture) => fixture.dealId));
    const targetCards = newest.cards.filter((card: any) => targetIds.has(String(card.id)));
    assert.deepEqual(targetCards.map((card: any) => card.id), fixtures.map((fixture) => fixture.dealId));
    assert.deepEqual(new Set(targetCards.map((card: any) => card.type)), new Set(["physical_product", "voucher", "ticket"]));
    assert.deepEqual(new Set(targetCards.map((card: any) => card.status)), new Set(["underway", "reached_target", "succeeded", "failed"]));
    assert.ok(!newest.cards.some((card: any) => String(card.id) === hiddenDraftId), "Draft must stay hidden from the browser Mall");
    assert.equal(newest.mall, true);
    assert.ok(newest.filters >= 10, `Mall should render bounded type/status/sort controls: ${JSON.stringify(newest)}`);
    assert.equal(newest.direction, "rtl");
    assert.ok(newest.overflow <= 1, `desktop Mall should not overflow: ${JSON.stringify(newest)}`);
    await waitForBrowser(cdp, `(() => {
      const image = document.querySelector('[data-mall-card][data-mall-deal-id="${product.dealId}"] img');
      return Boolean(image?.complete && image?.naturalWidth > 0);
    })()`, "published Mall primary image load");
    const imageProof = await cdp.evaluate(`(() => {
      const productImage = document.querySelector('[data-mall-card][data-mall-deal-id="${product.dealId}"] img');
      return {
      productImage: Boolean(productImage),
      productImageLoaded: Boolean(productImage?.complete && productImage?.naturalWidth > 0),
      ticketPlaceholder: Boolean(document.querySelector('[data-mall-card][data-mall-deal-id="${ticket.dealId}"] .cton-mall-placeholder'))
    }; })()`);
    assert.equal(imageProof.productImage, true, "published primary image must appear on the Mall card");
    assert.equal(imageProof.productImageLoaded, true, "published primary image must load successfully on the Mall card");
    assert.equal(imageProof.ticketPlaceholder, true, "deal without an image must show the intentional Siton placeholder");
    await cdp.evaluate(`document.querySelector('[data-mall-card]')?.scrollIntoView({ block: 'center' })`);
    const impressionRequest = await waitForMallNetworkEvent(cdp, "card_impression");
    console.log(`MALL_NETWORK_EVIDENCE event=card_impression method=${impressionRequest.method} status=${impressionRequest.status}`);
    console.log(`SCREENSHOT ${await cdp.screenshot("mall-desktop-1440")}`);

    await cdp.evaluate(`document.querySelector('[data-mall-filter="status"][data-mall-value="succeeded"]').click()`);
    await waitForBrowser(cdp, `
      location.search.includes('status=succeeded')
      && Boolean(document.querySelector('[data-mall-card][data-mall-deal-id="${voucher.dealId}"]'))
      && [...document.querySelectorAll('[data-mall-card]')].every((card) => card.dataset.mallStatus === 'succeeded')
    `, "succeeded Mall filter");
    const succeeded = await cdp.evaluate(`(() => ({
      href: location.pathname + location.search,
      ids: [...document.querySelectorAll('[data-mall-card]')].map((card) => card.dataset.mallDealId),
      statuses: [...document.querySelectorAll('[data-mall-card]')].map((card) => card.dataset.mallStatus)
    }))()`);
    assert.ok(succeeded.ids.includes(voucher.dealId));
    assert.ok(succeeded.statuses.length > 0 && succeeded.statuses.every((status: string) => status === "succeeded"));

    for (const statusCase of [
      { value: "underway", dealId: product.dealId },
      { value: "reached_target", dealId: reached.dealId },
      { value: "failed", dealId: ticket.dealId }
    ]) {
      await cdp.navigate(`/app?status=${statusCase.value}`);
      await waitForBrowser(cdp, `
        location.search.includes('status=${statusCase.value}')
        && Boolean(document.querySelector('[data-mall-card][data-mall-deal-id="${statusCase.dealId}"]'))
        && [...document.querySelectorAll('[data-mall-card]')].every((card) => card.dataset.mallStatus === '${statusCase.value}')
      `, `${statusCase.value} Mall filter`);
    }

    await cdp.evaluate(`document.querySelector('[data-mall-filter="status"][data-mall-value=""]').click()`);
    await waitForBrowser(cdp, `!location.search.includes('status=') && document.querySelectorAll('[data-mall-card]').length >= 4`, "cleared Mall status filter");
    await cdp.evaluate(`document.querySelector('[data-mall-filter="type"][data-mall-value="ticket"]').click()`);
    await waitForBrowser(cdp, `
      location.search.includes('type=ticket')
      && Boolean(document.querySelector('[data-mall-card][data-mall-deal-id="${ticket.dealId}"]'))
      && [...document.querySelectorAll('[data-mall-card]')].every((card) => card.dataset.mallDealType === 'ticket')
    `, "ticket Mall filter");
    const tickets = await cdp.evaluate(`([...document.querySelectorAll('[data-mall-card]')].map((card) => ({ id: card.dataset.mallDealId, type: card.dataset.mallDealType })))`);
    assert.ok(tickets.some((item: any) => item.id === ticket.dealId));
    assert.ok(tickets.length > 0 && tickets.every((item: any) => item.type === "ticket"));

    for (const typeCase of [
      { value: "physical_product", dealId: product.dealId },
      { value: "voucher", dealId: voucher.dealId }
    ]) {
      await cdp.navigate(`/app?type=${typeCase.value}`);
      await waitForBrowser(cdp, `
        location.search.includes('type=${typeCase.value}')
        && Boolean(document.querySelector('[data-mall-card][data-mall-deal-id="${typeCase.dealId}"]'))
        && [...document.querySelectorAll('[data-mall-card]')].every((card) => card.dataset.mallDealType === '${typeCase.value}')
      `, `${typeCase.value} Mall filter`);
    }

    await cdp.navigate("/app?sort=oldest");
    await waitForBrowser(cdp, `location.search.includes('sort=oldest') && document.querySelectorAll('[data-mall-card]').length >= 4`, "oldest Mall order");
    const oldest = await cdp.evaluate(`(async () => {
      const response = await fetch('/api/mall/deals?sort=oldest&limit=24');
      const payload = await response.json();
      return {
        browserIds: [...document.querySelectorAll('[data-mall-card]')].map((card) => card.dataset.mallDealId),
        apiIds: (payload.deals || []).map((deal) => deal.deal_id)
      };
    })()`);
    assert.deepEqual(
      oldest.browserIds,
      oldest.apiIds.slice(0, oldest.browserIds.length),
      "the browser must preserve the canonical oldest-first API order even when the local DB contains earlier test fixtures"
    );

    await cdp.navigate("/app");
    await waitForBrowser(cdp, `document.querySelector('[data-mall-card][data-mall-deal-id="${product.dealId}"] a[data-mall-deal]')`, "canonical product Mall card");
    await cdp.evaluate(`document.querySelector('[data-mall-card][data-mall-deal-id="${product.dealId}"] a[data-mall-deal]').click()`);
    await waitForBrowser(cdp, `location.pathname === '/app/deal/${product.dealId}' && document.body.innerText.includes(${JSON.stringify(product.title)})`, "Mall card canonical deal page");
    const clickRequest = await waitForMallNetworkEvent(cdp, "mall_deal_click");
    console.log(`MALL_NETWORK_EVIDENCE event=mall_deal_click method=${clickRequest.method} status=${clickRequest.status}`);
    const canonicalDetail = await cdp.evaluate(`(async () => {
      const response = await fetch('/api/deals/${product.dealId}/public');
      const payload = await response.json();
      return {
        path: location.pathname,
        source: new URLSearchParams(location.search).get('source'),
        dealId: payload.deal?.deal_id,
        title: payload.deal?.title,
        sourceBadge: document.body.innerText.includes('נמצא בקניון'),
        overflow: document.documentElement.scrollWidth - window.innerWidth
      };
    })()`);
    assert.equal(canonicalDetail.path, `/app/deal/${product.dealId}`);
    assert.equal(canonicalDetail.source, "mall");
    assert.equal(canonicalDetail.dealId, product.dealId);
    assert.equal(canonicalDetail.title, product.title);
    assert.equal(canonicalDetail.sourceBadge, true);
    assert.ok(canonicalDetail.overflow <= 1);

    for (const width of [390, 375, 360, 412]) {
      await cdp.setViewport({ width, height: 844 });
      await cdp.navigate("/app");
      await waitForBrowser(cdp, `window.innerWidth === ${width} && document.querySelectorAll('[data-mall-card]').length >= 4`, `Mall at ${width}px`);
      const layout = await cdp.evaluate(`(() => ({
        width: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        cards: document.querySelectorAll('[data-mall-card]').length,
        hero: Boolean(document.querySelector('.cton-mall-hero')),
        filters: Boolean(document.querySelector('.cton-mall-filters')),
        direction: document.documentElement.dir || getComputedStyle(document.documentElement).direction
      }))()`);
      assert.equal(layout.width, width);
      assert.ok(layout.documentWidth <= width + 1, `Mall should not overflow at ${width}px: ${JSON.stringify(layout)}`);
      assert.ok(layout.cards >= 4);
      assert.equal(layout.hero, true);
      assert.equal(layout.filters, true);
      assert.equal(layout.direction, "rtl");
      if (width === 390) {
        await cdp.evaluate(`document.querySelector('#mall-deals')?.scrollIntoView({ block: 'start' })`);
        await wait(150);
        console.log(`SCREENSHOT ${await cdp.screenshot("mall-mobile-390")}`);
      }
    }
  });
}

async function proveSellerBrowser(pool: pg.Pool) {
  return withCdp("/app/seller/new", async (cdp) => {
    await cdp.setViewport({ width: 390, height: 844 });
    await waitForBrowser(cdp, `Boolean(document.querySelector('form[data-action="seller-login"]'))`, "signed-out seller auth gate");
    const signedOut = await cdp.evaluate(`(() => ({
      text: document.body.innerText,
      loginForm: Boolean(document.querySelector('form[data-action="seller-login"]')),
      createForm: Boolean(document.querySelector('form[data-action="seller-create"]')),
      direction: document.documentElement.dir || getComputedStyle(document.documentElement).direction,
      overflow: document.documentElement.scrollWidth - window.innerWidth
    }))()`);
    assert.equal(signedOut.loginForm, true);
    assert.equal(signedOut.createForm, false, "seller create must stay gated before authentication");
    assert.equal(signedOut.direction, "rtl");
    assert.ok(signedOut.overflow <= 1, `seller auth gate should not overflow at 390px: ${JSON.stringify(signedOut)}`);
    assertSafeVisibleAuthText(String(signedOut.text));
    await cdp.evaluate(`document.querySelector('form[data-action="seller-login"]')?.scrollIntoView({ block: 'center' })`);
    await wait(150);
    console.log(`SCREENSHOT ${await cdp.screenshot("seller-auth-mobile-390")}`);

    await cdp.evaluate(`(() => {
      const setField = (selector, value) => {
        const input = document.querySelector(selector);
        if (!input) throw new Error('missing auth input ' + selector);
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setField('#sellerContextId', ${JSON.stringify(sellerId)});
      setField('#sellerAccessCode', ${JSON.stringify(sellerAccessCode)});
      document.querySelector('form[data-action="seller-login"]').requestSubmit();
      return true;
    })()`);
    await waitForBrowser(cdp, `Boolean(document.querySelector('form[data-action="seller-create"]'))`, "authenticated seller create form");
    const authenticated = await cdp.evaluate(`(() => ({
      path: location.pathname,
      createForm: Boolean(document.querySelector('form[data-action="seller-create"]')),
      text: document.body.innerText,
      overflow: document.documentElement.scrollWidth - window.innerWidth
    }))()`);
    assert.equal(authenticated.path, "/app/seller/new");
    assert.equal(authenticated.createForm, true);
    assertSafeVisibleAuthText(String(authenticated.text));
    assert.ok(authenticated.overflow <= 1);

    await cdp.setViewport({ width: 1440, height: 1100 });
    await cdp.evaluate(`(() => {
      const decode = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
      const files = new DataTransfer();
      files.items.add(new File([decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl5sAAAAASUVORK5CYII=')], 'v11-primary.png', { type: 'image/png' }));
      files.items.add(new File([decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')], 'v11-secondary.png', { type: 'image/png' }));
      const input = document.querySelector('#sellerImage');
      input.files = files.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitForBrowser(cdp, `document.querySelectorAll('.seller-image-thumb').length === 2`, "two visible seller image previews");
    const beforeReorder = await cdp.evaluate(`(() => ({
      primaryIndex: [...document.querySelectorAll('.seller-image-thumb')].findIndex((item) => item.classList.contains('is-primary')),
      secondImage: document.querySelectorAll('.seller-image-thumb img')[1]?.src || '',
      moveControls: document.querySelectorAll('[data-inline-action="move-product-image"]').length,
      primaryControls: document.querySelectorAll('[data-inline-action="make-product-image-primary"]').length
    }))()`);
    assert.equal(beforeReorder.primaryIndex, 0);
    assert.equal(beforeReorder.moveControls, 4);
    assert.equal(beforeReorder.primaryControls, 1);

    await cdp.evaluate(`document.querySelector('[data-inline-action="make-product-image-primary"][data-image-index="1"]').click()`);
    await waitForBrowser(cdp, `[...document.querySelectorAll('.seller-image-thumb')].findIndex((item) => item.classList.contains('is-primary')) === 1`, "secondary image marked primary");
    await cdp.evaluate(`document.querySelector('.seller-image-thumb.is-primary [data-inline-action="move-product-image"][data-image-delta="-1"]').click()`);
    await waitForBrowser(cdp, `document.querySelector('.seller-image-thumb:first-child')?.classList.contains('is-primary')`, "primary image reordered first");
    const reordered = await cdp.evaluate(`(() => ({
      firstImage: document.querySelector('.seller-image-thumb:first-child img')?.src || '',
      primaryCount: document.querySelectorAll('.seller-image-thumb.is-primary').length,
      previews: document.querySelectorAll('.seller-image-thumb img').length,
      overflow: document.documentElement.scrollWidth - window.innerWidth
    }))()`);
    assert.equal(reordered.firstImage, beforeReorder.secondImage, "reorder control should visibly move the selected image");
    assert.equal(reordered.primaryCount, 1);
    assert.equal(reordered.previews, 2);
    assert.ok(reordered.overflow <= 1, `seller image editor should not overflow: ${JSON.stringify(reordered)}`);
    await cdp.evaluate(`document.querySelector('[data-image-dropzone]')?.scrollIntoView({ block: 'center' })`);
    await wait(150);
    console.log(`SCREENSHOT ${await cdp.screenshot("seller-images-desktop")}`);

    const draftTitle = `V1.1 טיוטת דפדפן ${Date.now()}`;
    await cdp.evaluate(`(() => {
      const setField = (selector, value) => {
        const input = document.querySelector(selector);
        if (!input) throw new Error('missing seller field ' + selector);
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const deadline = new Date(Date.now() + 4 * 60 * 60 * 1000);
      const pad = (value) => String(value).padStart(2, '0');
      setField('#sellerTitle', ${JSON.stringify(draftTitle)});
      setField('#sellerDescription', 'טיוטה שנוצרה דרך Edge אמיתי עם שתי תמונות.');
      setField('#sellerPrice', '49');
      setField('#sellerMinUnits', '4');
      setField('#sellerMaxUnits', '12');
      setField('#sellerDeadline', deadline.getFullYear() + '-' + pad(deadline.getMonth() + 1) + '-' + pad(deadline.getDate()) + 'T' + pad(deadline.getHours()) + ':' + pad(deadline.getMinutes()));
      for (const name of ['sellerFinalTerms', 'sellerFinalConfirm']) {
        const checkbox = document.querySelector('input[name="' + name + '"]');
        if (!checkbox) throw new Error('missing seller acceptance ' + name);
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
      document.querySelector('form[data-action="seller-create"] button[type="submit"]').click();
      return true;
    })()`);
    await waitForBrowser(cdp, `/^\\/app\\/seller\\/deals\\/[0-9a-f-]+$/i.test(location.pathname)`, "seller Draft detail after create", 120);
    const draft = await cdp.evaluate(`(async () => {
      const dealId = location.pathname.split('/').pop();
      const response = await fetch('/api/seller/deals/' + encodeURIComponent(dealId));
      const payload = await response.json();
      return {
        dealId,
        status: response.status,
        state: payload.deal?.state,
        title: payload.deal?.title,
        imageCount: (payload.deal?.images || []).length,
        primaryCount: (payload.deal?.images || []).filter((image) => image.is_primary).length,
        firstIsPrimary: Boolean((payload.deal?.images || [])[0]?.is_primary),
        visibleImages: document.querySelectorAll('.deal-image-gallery img, .seller-deal-hero-image').length,
        sharePanels: document.querySelectorAll('.share-panel').length,
        text: document.body.innerText,
        overflow: document.documentElement.scrollWidth - window.innerWidth
      };
    })()`);
    assert.equal(draft.status, 200);
    assert.equal(draft.state, "Draft");
    assert.equal(draft.title, draftTitle);
    assert.equal(draft.imageCount, 2);
    assert.equal(draft.primaryCount, 1);
    assert.equal(draft.firstIsPrimary, true, "persisted image order should keep the selected primary image first");
    assert.ok(draft.visibleImages >= 2, `Draft detail should visibly render both images: ${JSON.stringify(draft)}`);
    assert.equal(draft.sharePanels, 0, "Draft must not expose public sharing controls");
    assertNoRawSellerTransportText(String(draft.text));
    assert.ok(draft.overflow <= 1, `seller Draft detail should not overflow: ${JSON.stringify(draft)}`);
    console.log(`SCREENSHOT ${await cdp.screenshot("seller-draft-desktop")}`);

    // Persist a fresh create-form context, expire the HttpOnly server session,
    // and prove that reauthentication returns to the intended route without
    // losing safe fields. Legal acceptance is intentionally not restored.
    await cdp.navigate("/app/seller/new");
    await waitForBrowser(cdp, `Boolean(document.querySelector('form[data-action="seller-create"]'))`, "fresh authenticated seller create route");
    const resumableTitle = `V1.1 הקשר נשמר ${Date.now()}`;
    const resumableDescription = "הטקסט הבטוח הזה צריך לשרוד תפוגת סשן וכניסה מחדש.";
    await cdp.evaluate(`(() => {
      const setField = (selector, value) => {
        const input = document.querySelector(selector);
        if (!input) throw new Error('missing resumable field ' + selector);
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const deadline = new Date(Date.now() + 4 * 60 * 60 * 1000);
      const pad = (value) => String(value).padStart(2, '0');
      setField('#sellerTitle', ${JSON.stringify(resumableTitle)});
      setField('#sellerDescription', ${JSON.stringify(resumableDescription)});
      setField('#sellerPrice', '57');
      setField('#sellerMinUnits', '5');
      setField('#sellerMaxUnits', '15');
      setField('#sellerDeadline', deadline.getFullYear() + '-' + pad(deadline.getMonth() + 1) + '-' + pad(deadline.getDate()) + 'T' + pad(deadline.getHours()) + ':' + pad(deadline.getMinutes()));
      for (const name of ['sellerFinalTerms', 'sellerFinalConfirm']) {
        const checkbox = document.querySelector('input[name="' + name + '"]');
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    })()`);
    const resumeBeforeExpiry = await cdp.evaluate(`JSON.parse(localStorage.getItem('siton_seller_create_resume_v1') || 'null')`);
    assert.equal(resumeBeforeExpiry?.fields?.sellerTitle, resumableTitle);
    assert.equal(resumeBeforeExpiry?.fields?.sellerDescription, resumableDescription);
    assert.equal(resumeBeforeExpiry?.fields?.sellerPrice, "57");
    assert.equal(resumeBeforeExpiry?.draft_id, "");

    const expiredSessions = await pool.query(
      `UPDATE siton.seller_sessions
          SET expires_at=now()-interval '1 minute'
        WHERE seller_id=$1 AND revoked_at IS NULL
        RETURNING session_id`,
      [sellerId]
    );
    assert.ok((expiredSessions.rowCount || 0) >= 1, "at least the active Edge seller session should be expired");
    await cdp.evaluate(`document.querySelector('form[data-action="seller-create"] button[type="submit"]').click()`);
    await waitForBrowser(cdp, `Boolean(document.querySelector('form[data-action="seller-login"]')) && document.body.innerText.includes('החיבור שלך פג')`, "friendly expired-session reauth gate", 120);
    const expiredGate = await cdp.evaluate(`(() => ({
      path: location.pathname,
      text: document.body.innerText,
      loginForm: Boolean(document.querySelector('form[data-action="seller-login"]')),
      createForm: Boolean(document.querySelector('form[data-action="seller-create"]')),
      returnTo: sessionStorage.getItem('siton_seller_return_to_v1'),
      resume: JSON.parse(localStorage.getItem('siton_seller_create_resume_v1') || 'null'),
      overflow: document.documentElement.scrollWidth - window.innerWidth
    }))()`);
    assert.equal(expiredGate.path, "/app/seller/new");
    assert.equal(expiredGate.loginForm, true);
    assert.equal(expiredGate.createForm, false);
    assert.equal(expiredGate.returnTo, "/app/seller/new");
    assert.equal(expiredGate.resume?.fields?.sellerTitle, resumableTitle);
    assert.equal(expiredGate.resume?.fields?.sellerDescription, resumableDescription);
    assert.match(String(expiredGate.text), /החיבור שלך פג/);
    assert.match(String(expiredGate.text), /הפרטים הבטוחים של הטיוטה נשמרו/);
    assertNoRawSellerTransportText(String(expiredGate.text));
    assert.ok(expiredGate.overflow <= 1);
    await cdp.setViewport({ width: 390, height: 844 });
    await cdp.evaluate(`document.querySelector('form[data-action="seller-login"]')?.scrollIntoView({ block: 'center' })`);
    console.log(`SCREENSHOT ${await cdp.screenshot("seller-session-expired-mobile-390")}`);

    // A full reload proves the resume record, not just in-memory form state,
    // carries the safe context across the expired session boundary.
    await cdp.navigate("/app/seller/new");
    await waitForBrowser(cdp, `Boolean(document.querySelector('form[data-action="seller-login"]'))`, "reauth gate after full reload");
    const durableResume = await cdp.evaluate(`JSON.parse(localStorage.getItem('siton_seller_create_resume_v1') || 'null')`);
    assert.equal(durableResume?.fields?.sellerTitle, resumableTitle);
    assert.equal(durableResume?.fields?.sellerDescription, resumableDescription);
    await cdp.evaluate(`(() => {
      const setField = (selector, value) => {
        const input = document.querySelector(selector);
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setField('#sellerContextId', ${JSON.stringify(sellerId)});
      setField('#sellerAccessCode', ${JSON.stringify(sellerAccessCode)});
      document.querySelector('form[data-action="seller-login"]').requestSubmit();
      return true;
    })()`);
    await waitForBrowser(cdp, `
      location.pathname === '/app/seller/new'
      && Boolean(document.querySelector('form[data-action="seller-create"]'))
      && !document.querySelector('form[data-action="seller-login"]')
      && document.querySelector('#sellerTitle')?.value === ${JSON.stringify(resumableTitle)}
    `, "return to preserved seller create context", 120);
    const resumed = await cdp.evaluate(`(async () => {
      const sessionResponse = await fetch('/api/seller/session');
      const session = await sessionResponse.json();
      return {
        path: location.pathname,
        sellerId: session.seller_auth?.seller_context?.seller_id,
        title: document.querySelector('#sellerTitle')?.value,
        description: document.querySelector('#sellerDescription')?.value,
        price: document.querySelector('#sellerPrice')?.value,
        minUnits: document.querySelector('#sellerMinUnits')?.value,
        maxUnits: document.querySelector('#sellerMaxUnits')?.value,
        termsAccepted: Boolean(document.querySelector('input[name="sellerFinalTerms"]')?.checked),
        confirmAccepted: Boolean(document.querySelector('input[name="sellerFinalConfirm"]')?.checked),
        text: document.body.innerText
      };
    })()`);
    assert.equal(resumed.sellerId, sellerId);
    assert.equal(resumed.path, "/app/seller/new");
    assert.equal(resumed.title, resumableTitle);
    assert.equal(resumed.description, resumableDescription);
    assert.equal(resumed.price, "57");
    assert.equal(resumed.minUnits, "5");
    assert.equal(resumed.maxUnits, "15");
    assert.equal(resumed.termsAccepted, false, "legal acceptance should require explicit reconfirmation after reload");
    assert.equal(resumed.confirmAccepted, false, "critical confirmation should require explicit reconfirmation after reload");
    assertNoRawSellerTransportText(String(resumed.text));

    // Use the real visible logout action before switching identities, then
    // prove the original Draft is ownership-hidden for read and mutation.
    await cdp.evaluate(`localStorage.removeItem('siton_seller_create_resume_v1')`);
    await cdp.navigate("/app/seller");
    await waitForBrowser(cdp, `Boolean(document.querySelector('form[data-action="seller-logout"]'))`, "visible seller logout action");
    await cdp.evaluate(`(() => {
      document.querySelector('form[data-action="seller-logout"]').requestSubmit();
      return true;
    })()`);
    const logoutRequest = await waitForNetworkResponse(cdp, "/api/seller/session/logout", "POST", 200);
    await waitForBrowser(cdp, `
      location.pathname === '/app/seller'
      && Boolean(document.querySelector('form[data-action="seller-login"]'))
      && document.body.innerText.includes('הגישה של המוכר נסגרה')
    `, "friendly signed-out state after visible logout", 120);
    const logoutState = await cdp.evaluate(`(async () => {
      const sessionResponse = await fetch('/api/seller/session');
      const sessionPayload = await sessionResponse.json();
      return {
        path: location.pathname,
        sessionStatus: sessionResponse.status,
        sessionAuthenticated: Boolean(sessionPayload.seller_auth?.authenticated),
        loginGateVisible: Boolean(document.querySelector('form[data-action="seller-login"]')),
        successBannerVisible: document.body.innerText.includes('הגישה של המוכר נסגרה'),
        text: document.body.innerText
      };
    })()`);
    assert.equal(logoutState.path, "/app/seller");
    assert.equal(logoutState.sessionStatus, 200);
    assert.equal(logoutState.sessionAuthenticated, false);
    assert.equal(logoutState.loginGateVisible, true);
    assert.equal(logoutState.successBannerVisible, true);
    assertNoRawSellerTransportText(String(logoutState.text));
    console.log(`SELLER_LOGOUT_EVIDENCE action=visible-form method=${logoutRequest.method} status=${logoutRequest.status} authenticated=${logoutState.sessionAuthenticated}`);
    await cdp.navigate("/app/seller/new?identity=other");
    await waitForBrowser(cdp, `Boolean(document.querySelector('form[data-action="seller-login"]'))`, "other-seller login gate");
    await cdp.evaluate(`(() => {
      const setField = (selector, value) => {
        const input = document.querySelector(selector);
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setField('#sellerContextId', ${JSON.stringify(otherSellerId)});
      setField('#sellerAccessCode', ${JSON.stringify(otherSellerAccessCode)});
      document.querySelector('form[data-action="seller-login"]').requestSubmit();
      return true;
    })()`);
    await waitForBrowser(cdp, `Boolean(document.querySelector('form[data-action="seller-create"]'))`, "authenticated other seller");
    const otherIdentity = await cdp.evaluate(`fetch('/api/seller/session').then((response) => response.json()).then((payload) => payload.seller_auth?.seller_context?.seller_id)`);
    assert.equal(otherIdentity, otherSellerId);

    await cdp.navigate(`/app/seller/deals/${draft.dealId}/edit`);
    await waitForBrowser(cdp, `document.body.innerText.includes('העסקה לא נמצאה')`, "ownership-hiding Draft editor result", 120);
    const idor = await cdp.evaluate(`(async () => {
      const readResponse = await fetch('/api/seller/deals/${draft.dealId}/draft');
      const readBody = await readResponse.json();
      const patchResponse = await fetch('/api/seller/deals/${draft.dealId}/draft', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'IDOR mutation must never persist' })
      });
      const patchBody = await patchResponse.json();
      return {
        path: location.pathname,
        readStatus: readResponse.status,
        readCode: readBody.code,
        patchStatus: patchResponse.status,
        patchCode: patchBody.code,
        targetTitleVisible: document.body.innerText.includes(${JSON.stringify(draftTitle)}),
        text: document.body.innerText,
        overflow: document.documentElement.scrollWidth - window.innerWidth
      };
    })()`);
    assert.equal(idor.path, `/app/seller/deals/${draft.dealId}/edit`);
    assert.equal(idor.readStatus, 404);
    assert.equal(idor.readCode, "deal_not_found");
    assert.equal(idor.patchStatus, 404);
    assert.equal(idor.patchCode, "deal_not_found");
    assert.equal(idor.targetTitleVisible, false, "wrong seller must not receive the owner Draft title");
    assert.match(String(idor.text), /העסקה לא נמצאה/);
    assertNoRawSellerTransportText(String(idor.text));
    assert.ok(idor.overflow <= 1);
    await cdp.evaluate(`document.querySelector('.error-card')?.scrollIntoView({ block: 'center' })`);
    console.log(`SCREENSHOT ${await cdp.screenshot("seller-idor-hidden-mobile-390")}`);

    const unchangedAfterIdor = await pool.query(`SELECT title, seller_id, state::text AS state FROM siton.deals WHERE deal_id=$1`, [draft.dealId]);
    assert.deepEqual(unchangedAfterIdor.rows[0], { title: draftTitle, seller_id: sellerId, state: "Draft" });
    console.log(`SELLER_AUTH_EVIDENCE expired_sessions=${expiredSessions.rowCount} resumed_route=/app/seller/new idor_read=${idor.readStatus} idor_patch=${idor.patchStatus}`);
    return { dealId: String(draft.dealId), draftTitle, resumableTitle };
  });
}

async function ensureFrontendAssets() {
  await mkdir(frontendTarget, { recursive: true });
  await cp(frontendSource, frontendTarget, { recursive: true, force: true });
}

async function main() {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for the isolated V1.1 browser proof");
  await ensureFrontendAssets();
  await mkdir(artifactDir, { recursive: true });
  const uploadDir = await mkdtemp(join(tmpdir(), "siton-v11-browser-images-"));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let serverStdout = "";
  let serverStderr = "";
  const server = spawn(process.execPath, [compiledAppPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(serverPort),
      HOST: "127.0.0.1",
      APP_DEPLOYMENT_MODE: "internal-runtime",
      SELLER_SESSION_SECRET: "v11-browser-session-secret-not-production",
      ADMIN_API_KEY: adminKey,
      DEAL_IMAGE_UPLOAD_DIR: uploadDir,
      DISABLE_OUTBOX_WORKER: "1",
      RATE_LIMIT_MAX: "3000",
      RATE_LIMIT_SENSITIVE_MAX: "500"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout?.on("data", (chunk) => { serverStdout += String(chunk); });
  server.stderr?.on("data", (chunk) => { serverStderr += String(chunk); });

  try {
    await waitForHealth(() => [serverStdout, serverStderr].filter(Boolean).join("\n"));
    await run("V1.1 local seller identities can be provisioned without exposing credentials", provisionSeller);
    const cookie = await run("V1.1 local seller session succeeds over the server authority", loginSellerOverHttp);
    await run("V1.1 local seller profile is publish-ready for synthetic Mall fixtures", () => completeSellerProfile(cookie));
    const mallSeed = await run("Mall fixtures cover Draft exclusion, three real deal types and four canonical outcomes", () => seedMallFixtures(pool, cookie));
    await run("public Deal HTML exposes canonical title, description, URL and safe primary OG image", () => provePublicMetadata(mallSeed));
    await run("real Edge proves Mall filters, ordering, images, canonical detail and responsive widths", () => proveMallBrowser(mallSeed));
    const draft = await run("real Edge proves seller auth, resumable reauth, ownership isolation and a two-image Draft", () => proveSellerBrowser(pool));

    const storedDraft = await pool.query(
      `SELECT d.deal_id::text, d.title, d.state::text AS state, d.seller_id,
              COUNT(di.image_id)::int AS image_count,
              COUNT(di.image_id) FILTER (WHERE di.is_primary)::int AS primary_count
         FROM siton.deals d
         LEFT JOIN siton.deal_images di ON di.deal_id=d.deal_id
        WHERE d.deal_id=$1
        GROUP BY d.deal_id, d.title, d.state, d.seller_id`,
      [draft.dealId]
    );
    assert.equal(storedDraft.rowCount, 1);
    assert.deepEqual(storedDraft.rows[0], {
      deal_id: draft.dealId,
      title: draft.draftTitle,
      state: "Draft",
      seller_id: sellerId,
      image_count: 2,
      primary_count: 1
    });

    let eventEvidence = await pool.query(
      `SELECT event_type, COUNT(*)::int AS event_count
         FROM siton.discovery_events
        GROUP BY event_type
        ORDER BY event_type`
    );
    for (let attempt = 0; attempt < 20 && eventEvidence.rows.length < 3; attempt += 1) {
      await wait(100);
      eventEvidence = await pool.query(
        `SELECT event_type, COUNT(*)::int AS event_count
           FROM siton.discovery_events
          GROUP BY event_type
          ORDER BY event_type`
      );
    }
    console.log(`MALL_DB_EVIDENCE ${JSON.stringify(eventEvidence.rows)}`);
    assert.ok(eventEvidence.rows.some((row) => row.event_type === "mall_session" && Number(row.event_count) >= 1));
    assert.ok(eventEvidence.rows.some((row) => row.event_type === "card_impression" && Number(row.event_count) >= 1));
    assert.ok(eventEvidence.rows.some((row) => row.event_type === "mall_deal_click" && Number(row.event_count) >= 1));

    const artifactNames = (await Promise.all([
      "mall-desktop-1440.png",
      "mall-mobile-390.png",
      "seller-auth-mobile-390.png",
      "seller-images-desktop.png",
      "seller-draft-desktop.png",
      "seller-session-expired-mobile-390.png",
      "seller-idor-hidden-mobile-390.png"
    ].map(async (name) => ({ name, exists: Boolean(await readFile(join(artifactDir, name)).catch(() => null)) })))).filter((item) => item.exists);
    assert.equal(artifactNames.length, 7, `expected seven ignored browser screenshots: ${JSON.stringify(artifactNames)}`);
    console.log(`PASS V1.1_BROWSER_EVIDENCE mall_deals=${mallSeed.fixtures.length} hidden_draft=${mallSeed.hiddenDraftId} seller_draft=${draft.dealId} screenshots=${artifactNames.map((item) => item.name).join(",")}`);
  } finally {
    server.kill("SIGTERM");
    await waitForProcessExit(server, 10_000);
    await pool.end();
    await rm(uploadDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
