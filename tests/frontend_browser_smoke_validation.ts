import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..");
const frontendSource = join(repoRoot, "frontend");
const frontendTarget = join(repoRoot, ".tmp_test_dist", "frontend");
const browserCandidates = process.platform === "win32"
  ? ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"]
  : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const edgePath = browserCandidates.find((candidate) => existsSync(candidate)) || browserCandidates[0]!;
const compiledAppPath = join(__dirname, "..", "src", "app.js");
const smokePort = 3310;
const cdpPort = 3311;
const baseUrl = `http://127.0.0.1:${smokePort}`;

type SmokeRoute = {
  name: string;
  path: string;
  expect: string[];
};

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

type CdpSession = {
  evaluate: (expression: string) => Promise<any>;
  navigate: (path: string) => Promise<void>;
  setViewport: (viewport: { width: number; height: number }) => Promise<void>;
};

async function captureCanonicalDom(cdp: CdpSession, path: string, viewport: { width: number; height: number }, expected: string[], navigate: boolean) {
  if (navigate) await cdp.navigate(path);
  await cdp.setViewport(viewport);
  let lastSnapshot: any = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const snapshot = await cdp.evaluate(`(() => ({
      href: location.href,
      appChildren: document.querySelector("#app")?.childElementCount || 0,
      html: document.documentElement?.outerHTML || ""
    }))()`);
    lastSnapshot = snapshot;
    const html = String(snapshot?.html || "");
    const rendered = path.startsWith("/legal/") ? html.includes("<main") : snapshot?.appChildren > 0;
    if (rendered && !html.includes("main-frame-error") && expected.every((text) => html.includes(text))) {
      const layout = await cdp.evaluate(`(() => ({
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        direction: document.documentElement.dir || getComputedStyle(document.documentElement).direction
      }))()`);
      assert.equal(layout.viewportWidth, viewport.width, `${path} should render at the requested viewport width`);
      assert.ok(layout.documentWidth <= layout.viewportWidth + 1, `${path} should not create horizontal page overflow: ${JSON.stringify(layout)}`);
      assert.equal(layout.direction, "rtl", `${path} should keep canonical RTL direction`);
      return html;
    }
    await wait(100);
  }
  const finalHtml = String(lastSnapshot?.html || "");
  throw new Error(`frontend route did not reach its canonical DOM state for ${path}: ${JSON.stringify({
    href: lastSnapshot?.href,
    appChildren: lastSnapshot?.appChildren,
    missing: expected.filter((text) => !finalHtml.includes(text)),
    html: finalHtml.slice(0, 1200)
  })}`);
}

async function dumpDom(path: string, viewport: { width: number; height: number }, label: string, expected: string[]) {
  console.log(`SMOKE_DOM ${label} ${path}`);
  await waitForHealth();
  return withCdp(path, (cdp) => captureCanonicalDom(cdp, path, viewport, expected, false));
}

async function dumpDomRoutes(routes: SmokeRoute[], viewport: { width: number; height: number }, prefix: string) {
  if (!routes.length) return [];
  await waitForHealth();
  return withCdp(routes[0]!.path, async (cdp) => {
    const snapshots: string[] = [];
    for (let index = 0; index < routes.length; index += 1) {
      const route = routes[index]!;
      console.log(`SMOKE_DOM ${prefix}-${route.name.replace(/\s+/g, "-")} ${route.path}`);
      snapshots.push(await captureCanonicalDom(cdp, route.path, viewport, route.expect, index > 0));
    }
    return snapshots;
  });
}

async function openCdpPage(path: string) {
  if (!existsSync(edgePath)) {
    throw new Error(`Edge executable not found at ${edgePath}`);
  }
  const profileDir = join(tmpdir(), `siton-cdp-smoke-${Date.now()}`);
  await mkdir(profileDir, { recursive: true });
  const remoteDebuggingPort = 33_500 + Math.floor(Math.random() * 1_000);
  const browser = spawn(edgePath, [
    "--headless=new",
    "--disable-gpu",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${remoteDebuggingPort}`,
    `--user-data-dir=${profileDir}`,
    `${baseUrl}${path}`
  ], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${remoteDebuggingPort}/json/list`);
      const pages = await response.json() as Array<{ url?: string; webSocketDebuggerUrl?: string }>;
      const page = pages.find((item) => item.url?.includes(path));
      if (page?.webSocketDebuggerUrl) {
        return { browser, profileDir, wsUrl: page.webSocketDebuggerUrl };
      }
    } catch {}
    await wait(250);
  }
  browser.kill("SIGKILL");
  await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  throw new Error("Edge CDP page did not become available");
}

async function waitForProcessExit(child: ReturnType<typeof spawn>, timeoutMs: number) {
  if (child.exitCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    child.once("exit", onExit);
  });
}
async function withCdp<T>(path: string, fn: (cdp: CdpSession) => Promise<T>): Promise<T> {
  let page: Awaited<ReturnType<typeof openCdpPage>> | undefined;
  let openError: unknown;
  for (let attempt = 0; attempt < 3 && !page; attempt += 1) {
    try {
      page = await openCdpPage(path);
    } catch (error) {
      openError = error;
      await wait(500);
    }
  }
  if (!page) throw openError instanceof Error ? openError : new Error("Edge CDP page did not become available");
  const ws = new WebSocket(page.wsUrl);
  let seq = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const handlers = pending.get(message.id)!;
    pending.delete(message.id);
    if (message.error) handlers.reject(new Error(JSON.stringify(message.error)));
    else handlers.resolve(message.result);
  });
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP command timed out: ${method}`));
    }, 10_000);
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
      const timer = setTimeout(() => reject(new Error("CDP websocket did not open")), 10_000);
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
    return await fn({ evaluate, navigate, setViewport });
  } finally {
    await Promise.race([
      send("Browser.close").catch(() => undefined),
      wait(2_000)
    ]);
    ws.close();
    const closedGracefully = await waitForProcessExit(page.browser, 5_000);
    if (!closedGracefully) {
      page.browser.kill("SIGKILL");
      await waitForProcessExit(page.browser, 5_000);
    }
    await rm(page.profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function randomSuffix(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

async function createDeal(title: string, config: { minUnits?: number; maxUnits?: number } = {}) {
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
      min_units: config.minUnits ?? 8,
      max_units: config.maxUnits ?? 24,
      deadline: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
      delivery_options: [
        { option_type: "pickup", label: "איסוף עצמי", cost: 0, sort_order: 0 },
        { option_type: "delivery", label: "שליח עד הבית", cost: 18, sort_order: 1 },
        {
          option_type: "distribution_point",
          label: "נקודת חלוקה מרכז העיר · רחוב הרצל 10, תל אביב · הוראות: ליד שער B · קישור מיקום: https://maps.google.com/?q=Herzl+10+Tel+Aviv",
          cost: 0,
          sort_order: 2
        }
      ]
    })
  });

  assert.equal(response.status, 200);
  assert.ok(json?.deal_id);
  return json as { deal_id: string };
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

async function createJoinedParticipant(dealId: string, qty = 3) {
  const publicDeal = await fetchJson(`/api/deals/${dealId}/public`);
  assert.equal(publicDeal.response.status, 200);
  const deliveryOptions = Array.isArray(publicDeal.json?.deal?.delivery_options)
    ? publicDeal.json.deal.delivery_options
    : [];
  const deliveryOptionId =
    deliveryOptions.find((option: any) => String(option.option_type || "").toLowerCase() === "delivery")?.option_id ||
    deliveryOptions[0]?.option_id;
  assert.ok(deliveryOptionId, "expected a delivery option for smoke join");

  const buyerPhone = `05${String(Math.floor(Math.random() * 100_000_000)).padStart(8, "0")}`;
  const otpStart = await fetchJson("/api/otp/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone: buyerPhone })
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
      qty,
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

async function closeJoining(dealId: string) {
  const unique = randomSuffix("browser-smoke-close");
  const { response, json } = await fetchJson(`/deals/${dealId}/close_joining`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": unique,
      "idempotency-key": unique,
      "x-seller-id": "seller-default"
    },
    body: JSON.stringify({})
  });
  assert.equal(response.status, 200, `close joining fixture failed: ${JSON.stringify(json)}`);
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
    const match = pattern.exec(dom);
    const at = match?.index ?? -1;
    const context = at >= 0 ? dom.slice(Math.max(0, at - 80), at + 160) : "";
    if (match) assert.fail(`${label} contains mojibake-like text near ${JSON.stringify(context)}`);
  }

  const hebrewMatches = dom.match(/[\u0590-\u05ff]/gu) || [];
  assert.ok(hebrewMatches.length >= 20, `${label} should contain rendered Hebrew text`);
}

function frameworkOwnedDom(dom: string) {
  // Persisted deal/seller/distributor text is user content and may legitimately
  // contain any Unicode sequence (including multiplication or trademark signs).
  // The complete app asset is scanned above; route checks scan the hydrated
  // shell/metadata and separately require each route's canonical main content.
  return dom.replace(/<main\b[^>]*>[\s\S]*?<\/main>/iu, "<main></main>");
}

async function assertFrontendAssetsHealthy() {
  const checks = [
    { path: "/app", contentType: "text/html", expect: ["charset=utf-8", "<title>C-ton | קניון עסקאות קבוצתיות</title>", "/app/assets/app.js", "/app/assets/styles.css"] },
    { path: "/app/assets/app.js", contentType: "application/javascript", expect: ["charset=utf-8", "renderProgressBlock", "הקניון של C-ton", "C-ton"] },
    { path: "/app/assets/styles.css", contentType: "text/css", expect: ["charset=utf-8", "Heebo", "#C65A1E", "#FAF7F2"] }
  ];

  for (const check of checks) {
    const response = await fetch(`${baseUrl}${check.path}`);
    const text = await response.text();
    assert.equal(response.status, 200, `${check.path} should load`);
    assert.match(response.headers.get("content-type") || "", new RegExp(check.contentType));
    for (const expected of check.expect) {
      assert.match(`${response.headers.get("content-type") || ""}\n${text}`, new RegExp(escapeRegex(expected)), `${check.path} missing ${expected}`);
    }
    if (check.path === "/app/assets/styles.css") {
      assert.doesNotMatch(text, /Gisha/);
      assert.doesNotMatch(text, /#0f766e/i);
    }
    if (check.path !== "/app/assets/styles.css") {
      assertHealthyHebrewDom(text, check.path);
    }
  }
}

async function assertSellerCreateUxContract() {
  const source = await readFile(join(frontendSource, "app.js"), "utf8");
  const styles = await readFile(join(frontendSource, "styles.css"), "utf8");
  assert.match(source, /sellerDeliveryPointName5/, "seller create form should support five distribution point slots");
  assert.match(source, /sellerImagesJson/, "seller create form should keep image state for deal previews");
  assert.match(source, /validation-summary/, "form validation errors should render a visible summary");
  assert.match(source, /sellerPublishLegalAccepted/, "seller publish should require the combined legal acceptance checkbox");
  assert.match(source, /buyerPaymentDisclosureAcceptance/, "buyer payment should require legal and payment disclosure acceptance");
  assert.match(source, /\/legal\/terms/, "legal terms page should be linked from frontend surfaces");
  assert.match(source, /\/legal\/privacy/, "legal privacy page should be linked from frontend surfaces");
  assert.match(source, /\/legal\/refunds/, "legal refunds page should be linked from frontend surfaces");
  assert.doesNotMatch(source, /ניווט מהיר|עמודי trust ציבוריים|placeholder פנימי|פתוח להצגה/, "regular legal/main UI must not show internal legal/navigation wording");
  assert.doesNotMatch(source, /package:\s*"▤"|users:\s*"U"/, "home explanation icons must not use generic placeholder glyphs");
  assert.match(source, /link:\s*"🔗"/, "step 1 should use a link-oriented icon");
  assert.match(source, /users:\s*"👥"/, "step 2 should use a people-oriented icon");
  assert.match(source, /תקנון השימוש למוכרים/, "terms approval should include an inline clickable seller terms link");
  assert.match(source, /מדיניות הביטולים וההחזרים/, "terms approval should include an inline refunds link");
  assert.match(source, /קישור מיקום/, "distribution point copy should carry location links");
  assert.match(source, /finalTerms.*state\.form\.sellerFinalTerms/s, "terms checkbox state should be preserved across validation errors");
  assert.match(source, /sellerMinUnits:\s*""/, "seller create minimum units must start empty");
  assert.match(source, /sellerMaxUnits:\s*""/, "seller create maximum units must start empty");
  assert.doesNotMatch(source, /sellerMinUnits:\s*"10"/, "seller create must not default minimum units to 10");
  assert.doesNotMatch(source, /sellerMaxUnits:\s*"20"/, "seller create must not default maximum units to 20");

  const inputHandler = source.slice(
    source.indexOf('document.addEventListener("input"'),
    source.indexOf('document.addEventListener("change"')
  );
  assert.doesNotMatch(inputHandler, /focusCreateDealError|scrollIntoView|window\.scrollTo/, "typing in create deal must not trigger scroll/focus");
  assert.doesNotMatch(inputHandler, /render\(\)/, "typing in create deal must not full-render and reset scroll");
  assert.match(inputHandler, /updateSellerCreatePreviewFromState/, "typing should update only the create preview without a full render");

  assert.match(source, /const CREATE_DEAL_TITLE_FIELDS = \["title", "sellerTitle", "dealTitle", "productName", "name", "deal_name"\]/, "create deal should define one canonical title field contract");
  assert.match(source, /const title = readCreateDealTitle\(formData\)/, "create deal submit should read title through the canonical contract");
  assert.match(source, /const draftPayload = buildCreateDealPayload/, "create deal submit should use one canonical payload builder");
  assert.match(source, /body: json\(draftPayload\)/, "create and edit should send that canonical payload");
  assert.match(source, /name="sellerTitle"/, "visible seller title input should remain the connected user-facing field");
  assert.match(source, /title: String\(title \|\| ""\)\.trim\(\)[\s\S]*price_per_unit/s, "trimmed seller title must be sent to backend payload");
  assert.match(source, /name="sellerImage"[^>]+multiple/, "seller create should allow selecting multiple images");
  assert.match(source, /isPrimary/, "seller create image state should track the primary image");
  assert.match(source, /is_primary: Boolean\(image\.isPrimary\)/, "seller image upload payload should send primary image selection");
  assert.match(source, /יש להזין מינימום יחידות/, "minimum units required error should be short Hebrew copy");
  assert.match(source, /יש להזין מקסימום יחידות/, "maximum units required error should be short Hebrew copy");
  assert.match(source, /id="sellerMinUnits" name="sellerMinUnits"/, "minimum units input must have its own id/name");
  assert.match(source, /id="sellerMaxUnits" name="sellerMaxUnits"/, "maximum units input must have its own id/name");

  assert.match(styles, /\[data-nav\].*cursor:\s*pointer/s, "clickable elements should show pointer cursor");
  assert.match(styles, /:focus-visible[\s\S]*outline:/, "focus-visible should remain visible");
  assert.match(styles, /:active/, "buttons should have an active state");
  assert.match(styles, /:disabled[\s\S]*pointer-events:\s*none/, "disabled buttons should not be clickable");
  assert.match(styles, /product-image-upload-card img[\s\S]*transform:\s*none[\s\S]*animation:\s*none/, "upload image should not zoom or animate");
  assert.match(styles, /product-image-preview img[\s\S]*transform:\s*none[\s\S]*animation:\s*none/, "preview image should not zoom or animate");
}

async function assertSellerCreateTitleSubmissionContract() {
  const unique = randomSuffix("seller-create-title-contract");
  const requestedTitle = "עסקה עם שם תקין";
  const { response, json } = await fetchJson("/deals", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": unique,
      "idempotency-key": unique,
      "x-seller-id": "seller-default"
    },
    body: JSON.stringify({
      title: requestedTitle,
      description: "תיאור תקין לבדיקת smoke",
      price_per_unit: 42,
      min_units: 3,
      max_units: 6,
      deadline: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
      delivery_options: [
        { option_type: "delivery", label: "משלוח", cost: 0, sort_order: 0 }
      ]
    })
  });

  assert.equal(response.status, 200, `seller create with a title should pass title validation: ${JSON.stringify(json)}`);
  assert.ok(json?.deal_id);
  assert.doesNotMatch(JSON.stringify(json), /title_required|צריך שם|חסר שם|שם לעסקה/);

  const legacyUnique = randomSuffix("seller-create-seller-title-contract");
  const legacy = await fetchJson("/deals", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": legacyUnique,
      "idempotency-key": legacyUnique,
      "x-seller-id": "seller-default"
    },
    body: JSON.stringify({
      sellerTitle: "עסקה משדה גלוי",
      description: "תיאור תקין לבדיקת חוזה",
      price_per_unit: 43,
      min_units: 2,
      max_units: 5,
      deadline: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
      delivery_options: [
        { option_type: "delivery", label: "משלוח", cost: 0, sort_order: 0 }
      ]
    })
  });
  assert.equal(legacy.response.status, 200, `sellerTitle fallback should map to backend title: ${JSON.stringify(legacy.json)}`);
  assert.ok(legacy.json?.deal_id);

  const blankUnique = randomSuffix("seller-create-blank-title-contract");
  const blank = await fetchJson("/deals", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": blankUnique,
      "idempotency-key": blankUnique,
      "x-seller-id": "seller-default"
    },
    body: JSON.stringify({
      title: "   ",
      price_per_unit: 42,
      min_units: 3,
      max_units: 6,
      deadline: new Date(Date.now() + 4 * 60 * 60_000).toISOString()
    })
  });
  assert.equal(blank.response.status, 400);
  assert.match(JSON.stringify(blank.json), /title_required|title is required/);
}

async function assertSellerCreateDomFlowContract() {
  await withCdp("/app/seller/new", async ({ evaluate }) => {
    let formReady = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      formReady = Boolean(await evaluate(`document.querySelector('form[data-action="seller-create"]')`));
      if (formReady) break;
      await wait(250);
    }
    assert.equal(formReady, true, `seller create form did not render before timeout: ${String(await evaluate(`document.body.innerText`)).slice(0, 500)}`);
    const setup = await evaluate(`(() => {
      const forms = document.querySelectorAll('form[data-action="seller-create"]').length;
      const submitButtons = document.querySelectorAll('form[data-action="seller-create"] button[type="submit"]').length;
      window.__createDealRequests = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init = {}) => {
        const url = typeof input === "string" ? input : String(input && input.url || "");
        const method = String(init.method || "GET").toUpperCase();
        if ((url === "/deals" || url.endsWith("/deals") || /\\/deals\\/[^/]+\\/publish$/.test(url) || url.includes("/api/seller/deals/")) && method === "POST") {
          let body = init.body || "";
          try { body = JSON.parse(String(body)); } catch {}
          window.__createDealRequests.push({ url, method, body });
        }
        return originalFetch(input, init);
      };
      return { forms, submitButtons };
    })()`);
    assert.equal(setup.forms, 1, "seller create should have one real submit form");
    assert.equal(setup.submitButtons, 1, "seller create should have one real submit button");

    await evaluate(`(() => {
      const input = document.querySelector("#sellerImage");
      const files = new DataTransfer();
      files.items.add(new File([new Uint8Array([137,80,78,71,13,10,26,10,1])], "primary.png", { type: "image/png" }));
      files.items.add(new File([new Uint8Array([137,80,78,71,13,10,26,10,2])], "secondary.png", { type: "image/png" }));
      input.files = files.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await wait(250);
      const imageCount = await evaluate(`document.querySelectorAll(".seller-image-thumb").length`);
      if (imageCount === 2) break;
    }
    await evaluate(`(() => {
      const makePrimary = document.querySelector('[data-inline-action="make-product-image-primary"][data-image-index="1"]');
      if (!makePrimary) throw new Error("missing secondary make-primary button");
      makePrimary.click();
      return true;
    })()`);

    await evaluate(`(() => {
      const setField = (selector, value) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error("missing field " + selector);
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      setField("#sellerTitle", "עסקת DOM מלאה");
      setField("#sellerDescription", "תיאור בעברית דרך המסך");
      setField("#sellerPrice", "42");
      setField("#sellerMinUnits", "3");
      setField("#sellerMaxUnits", "7");
      const terms = document.querySelector('input[name="sellerFinalTerms"]');
      const confirm = document.querySelector('input[name="sellerFinalConfirm"]');
      terms.checked = true;
      confirm.checked = true;
      terms.dispatchEvent(new Event("change", { bubbles: true }));
      confirm.dispatchEvent(new Event("change", { bubbles: true }));
      const deadline = new Date(Date.now() + 4 * 60 * 60 * 1000);
      const pad = (value) => String(value).padStart(2, "0");
      setField("#sellerDeadline", deadline.getFullYear() + "-" + pad(deadline.getMonth() + 1) + "-" + pad(deadline.getDate()) + "T" + pad(deadline.getHours()) + ":" + pad(deadline.getMinutes()));
      return true;
    })()`);

    const preview = await evaluate(`(async () => {
      const button = document.querySelector('[data-inline-action="seller-preview-open"]');
      if (!button) throw new Error("missing full buyer preview button");
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const dialog = document.querySelector('[data-seller-preview-dialog]');
      const result = {
        dialog: Boolean(dialog),
        publicRenderer: Boolean(dialog?.querySelector('.cton-deal-page.seller-public-preview')),
        activeJoinForms: dialog?.querySelectorAll('form[data-action="start-join"]').length || 0,
        disabledCta: Boolean(dialog?.querySelector('button[disabled]')),
        title: dialog?.querySelector('h1')?.textContent || ""
      };
      dialog?.querySelector('[data-inline-action="seller-preview-close"]')?.click();
      return result;
    })()`);
    assert.equal(preview.dialog, true, "seller preview should open as a full dialog");
    assert.equal(preview.publicRenderer, true, "seller preview should reuse the public buyer renderer");
    assert.equal(preview.activeJoinForms, 0, "seller preview must not expose a live join form");
    assert.equal(preview.disabledCta, true, "seller preview should show a disabled buyer CTA");
    assert.equal(preview.title, "עסקת DOM מלאה");

    await evaluate(`(() => {
      document.querySelector('form[data-action="seller-create"] button[type="submit"]').click();
      return true;
    })()`);

    let result: any = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await wait(500);
      result = await evaluate(`(() => ({
        path: location.pathname,
        bodyText: document.body.innerText,
        requests: window.__createDealRequests || []
      }))()`);
      if (String(result.path).includes("/app/seller/deals/") || String(result.bodyText).includes("חסר שם לעסקה")) break;
    }
    const requests = result?.requests || [];
    const createRequest = requests.find((request: any) => request.url === "/deals" || String(request.url).endsWith("/deals"));
    assert.ok(createRequest, `DOM submit did not send /deals request: ${JSON.stringify(result)}`);
    assert.equal(createRequest.body.title, "עסקת DOM מלאה");
    assert.equal(createRequest.body.min_units, 3);
    assert.equal(createRequest.body.max_units, 7);
    assert.notEqual(createRequest.body.min_units, createRequest.body.max_units);
    assert.doesNotMatch(String(result.bodyText), /title_required|חסר שם לעסקה|צריך שם לעסקה/);
    assert.match(String(result.path), /\/app\/seller\/deals\//, `DOM submit did not create a deal: ${JSON.stringify(result)}`);
    const imageRequests = requests.filter((request: any) => String(request.url).includes("/api/seller/deals/") && String(request.url).endsWith("/images"));
    assert.equal(imageRequests.length, 2, `expected two image uploads, got ${JSON.stringify(imageRequests)}`);
    assert.equal(imageRequests[0].body.is_primary, false);
    assert.equal(imageRequests[1].body.is_primary, true);

    const draftState = await evaluate(`(() => ({
      text: document.body.innerText,
      sharePanels: document.querySelectorAll(".share-panel").length,
      copyButtons: document.querySelectorAll('[data-inline-action="copy-link"][data-share-url*="/app/deal/"]').length,
      publishButtons: [...document.querySelectorAll('button')].filter((button) => button.textContent.includes("פרסם עסקה")).length,
      images: document.querySelectorAll(".deal-image-gallery img, .seller-deal-hero-image").length,
      manageLinks: [...document.querySelectorAll('a')].filter((link) => link.textContent.includes("ניהול עסקה")).map((link) => link.getAttribute("href"))
    }))()`);
    assert.match(String(draftState.text), /העסקה נשמרה כטיוטה|עדיין בטיוטה/);
    assert.equal(draftState.sharePanels, 0, "draft seller screen must not render share panel");
    assert.equal(draftState.copyButtons, 0, "draft seller screen must not render public copy-link buttons");
    assert.ok(draftState.publishButtons >= 1, "draft seller screen must show a publish CTA");
    assert.ok(draftState.images >= 2, `draft seller screen should show uploaded images: ${JSON.stringify(draftState)}`);

    await evaluate(`location.reload()`);
    let reloadedDraft: any = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await wait(500);
      reloadedDraft = await evaluate(`(() => ({
        path: location.pathname,
        text: document.body.innerText,
        images: document.querySelectorAll(".deal-image-gallery img, .seller-deal-hero-image").length,
        sharePanels: document.querySelectorAll(".share-panel").length,
        copyButtons: document.querySelectorAll('[data-inline-action="copy-link"][data-share-url*="/app/deal/"]').length,
        publishButtons: [...document.querySelectorAll('button')].filter((button) => button.textContent.includes("פרסם עסקה")).length
      }))()`);
      if (reloadedDraft.images >= 2 && reloadedDraft.publishButtons >= 1) break;
    }
    assert.match(String(reloadedDraft.text), /העסקה נשמרה כטיוטה|עדיין בטיוטה/);
    assert.equal(reloadedDraft.sharePanels, 0, "reloaded draft must not render share panel");
    assert.equal(reloadedDraft.copyButtons, 0, "reloaded draft must not render public copy-link buttons");
    assert.ok(reloadedDraft.images >= 2, `uploaded images must survive draft navigation/reload: ${JSON.stringify(reloadedDraft)}`);

    await evaluate(`(() => {
      window.__createDealRequests = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init = {}) => {
        const url = typeof input === "string" ? input : String(input && input.url || "");
        const method = String(init.method || "GET").toUpperCase();
        if ((/\\/deals\\/[^/]+\\/publish$/.test(url) || url.includes("/api/seller/deals/")) && method === "POST") {
          let body = init.body || "";
          try { body = JSON.parse(String(body)); } catch {}
          window.__createDealRequests.push({ url, method, body });
        }
        return originalFetch(input, init);
      };
      return true;
    })()`);

    await evaluate(`(() => {
      const acceptance = document.querySelector('input[name="sellerPublishLegalAccepted"]');
      if (!acceptance) throw new Error("missing seller publish legal acceptance");
      acceptance.checked = true;
      acceptance.dispatchEvent(new Event("change", { bubbles: true }));
      const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent.includes("פרסם עסקה"));
      if (!button) throw new Error("missing publish button");
      button.click();
      return true;
    })()`);

    let published: any = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await wait(500);
      published = await evaluate(`(async () => {
        const dealId = location.pathname.split("/").pop();
        const apiResponse = await fetch("/api/seller/deals/" + encodeURIComponent(dealId));
        const json = await apiResponse.json();
        return {
          path: location.pathname,
          state: json.deal && json.deal.state,
          imageCount: (json.deal && json.deal.images || []).length,
          primaryCount: (json.deal && json.deal.images || []).filter((image) => image.is_primary).length,
          text: document.body.innerText,
          sharePanels: document.querySelectorAll(".share-panel").length,
          publicLinks: [...document.querySelectorAll('a[href*="/app/deal/"]')].map((link) => link.getAttribute("href")),
          manageLinks: [...document.querySelectorAll('a')].filter((link) => link.textContent.includes("ניהול עסקה")).map((link) => link.getAttribute("href")),
          requests: window.__createDealRequests || []
        };
      })()`);
      if (published.state === "PendingTarget") break;
    }
    assert.equal(published.state, "PendingTarget", `publish CTA did not move deal to PendingTarget: ${JSON.stringify(published)}`);
    assert.ok(published.sharePanels >= 1, "published seller screen should render sharing actions");
    assert.ok(published.publicLinks.some((href: string) => /\/app\/deal\//.test(String(href))), "published seller screen should expose public link");
    assert.ok(published.manageLinks.some((href: string) => /\/app\/seller\/deals\//.test(String(href))), "manage deal link must point to seller deal route");
    assert.equal(published.imageCount, 2);
    assert.equal(published.primaryCount, 1);
    assert.match(String(published.text), /העסקה פורסמה|פתוחה להצטרפות|לינק ציבורי/);
    assert.ok((published.requests || []).some((request: any) => /\/deals\/[^/]+\/publish$/.test(String(request.url))), "real flow should call publish endpoint");

    const publicDeal = await evaluate(`(async () => {
      const publicLink = [...document.querySelectorAll('a[href*="/app/deal/"]')].map((link) => link.getAttribute("href")).find(Boolean);
      if (!publicLink) throw new Error("missing public deal link after publish");
      history.pushState({}, "", publicLink);
      window.dispatchEvent(new PopStateEvent("popstate"));
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const images = document.querySelectorAll(".cton-product-image img, .deal-image-gallery img").length;
        if (location.pathname.includes("/app/deal/") && images >= 2) break;
      }
      return {
        path: location.pathname,
        text: document.body.innerText,
        images: document.querySelectorAll(".cton-product-image img, .deal-image-gallery img").length,
        primaryAlt: document.querySelector(".cton-product-image img")?.getAttribute("alt") || ""
      };
    })()`);
    assert.match(String(publicDeal.path), /\/app\/deal\//, `public deal route did not open: ${JSON.stringify(publicDeal)}`);
    assert.ok(publicDeal.images >= 2, `public deal should display persisted images after publish: ${JSON.stringify(publicDeal)}`);
    assert.match(String(publicDeal.text), /תקנון|מדיניות פרטיות|ביטולים והחזרים/);
  });
}

async function assertBuyerDomFlowAndSafeResume(dealId: string, affiliateRef = "") {
  const initialPath = `/app/deal/${dealId}${affiliateRef ? `?ref=${encodeURIComponent(affiliateRef)}` : ""}`;
  const browserBuyerPhone = `05${String(Math.floor(Math.random() * 100_000_000)).padStart(8, "0")}`;
  return withCdp(initialPath, async ({ evaluate, navigate, setViewport }) => {
    await setViewport({ width: 390, height: 844 });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await evaluate(`Boolean(document.querySelector('form[data-action="start-join"]'))`)) break;
      await wait(250);
    }

    await evaluate(`(() => {
      const qty = document.querySelector('#qty');
      const delivery = document.querySelector('input[name="deliveryOptionId"]');
      if (!qty || !delivery) throw new Error('buyer join controls missing');
      qty.value = '2';
      qty.dispatchEvent(new Event('input', { bubbles: true }));
      delivery.checked = true;
      delivery.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('form[data-action="start-join"]').requestSubmit();
      return true;
    })()`);

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await evaluate(`location.pathname.endsWith('/otp') && Boolean(document.querySelector('form[data-action="otp-start"]'))`)) break;
      await wait(250);
    }
    assert.match(String(await evaluate(`location.pathname`)), /\/otp$/);

    const persisted = await evaluate(`(() => {
      const raw = localStorage.getItem('siton_safe_resume_v1') || '{}';
      sessionStorage.removeItem('siton_flow_v2');
      return raw;
    })()`);
    assert.match(String(persisted), new RegExp(dealId));
    if (affiliateRef) assert.match(String(persisted), new RegExp(escapeRegex(affiliateRef)), "safe resume should retain the non-sensitive attribution source");
    assert.doesNotMatch(String(persisted), /phone|otp|buyerId|participantId|tracking|authorization|payment/i, "safe resume must exclude sensitive/transient buyer data");

    await navigate(`/app/join/${dealId}/otp`);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await evaluate(`Boolean(document.querySelector('form[data-action="otp-start"]'))`)) break;
      await wait(250);
    }
    const resumed = await evaluate(`(() => ({
      qty: JSON.parse(sessionStorage.getItem('siton_flow_v2') || '{}')['${dealId}']?.qty,
      phone: document.querySelector('#phone')?.value || '',
      overflow: document.documentElement.scrollWidth - window.innerWidth
    }))()`);
    assert.equal(resumed.qty, 2, "safe refresh should restore the non-sensitive buyer choice");
    assert.equal(resumed.phone, "", "safe refresh must not restore the phone number");
    assert.ok(resumed.overflow <= 1, `mobile OTP should not overflow horizontally: ${JSON.stringify(resumed)}`);

    await evaluate(`(() => {
      const phone = document.querySelector('#phone');
      phone.value = ${JSON.stringify(browserBuyerPhone)};
      phone.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('form[data-action="otp-start"]').requestSubmit();
      return true;
    })()`);
    let developmentCode = "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await wait(250);
      developmentCode = String(await evaluate(`JSON.parse(sessionStorage.getItem('siton_flow_v2') || '{}')['${dealId}']?.developmentCode || ''`));
      if (developmentCode && await evaluate(`Boolean(document.querySelector('form[data-action="otp-verify"]'))`)) break;
    }
    assert.match(developmentCode, /^\d{6}$/, "demo OTP flow should expose a six-digit development code only inside transient session state");

    await evaluate(`(() => {
      const code = document.querySelector('#code');
      code.value = '${developmentCode}';
      code.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('form[data-action="otp-verify"]').requestSubmit();
      return true;
    })()`);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await evaluate(`location.pathname.endsWith('/payment') && Boolean(document.querySelector('form[data-action="pay"]'))`)) break;
      await wait(250);
    }
    assert.match(String(await evaluate(`location.pathname`)), /\/payment$/);
    const serverResume = await evaluate(`(async () => {
      const response = await fetch('/api/buyer/resume/${dealId}');
      return { status: response.status, text: await response.text() };
    })()`);
    assert.equal(serverResume.status, 200, `authenticated browser flow should persist safe server resume: ${JSON.stringify(serverResume)}`);
    assert.match(String(serverResume.text), /selected_quantity/);
    assert.doesNotMatch(String(serverResume.text), /phone|otp_token|authorization_token|payment_token|tracking_credential|secret/i);

    await evaluate(`(() => {
      const payer = document.querySelector('#payerName');
      payer.value = 'Browser Buyer';
      payer.dispatchEvent(new Event('input', { bubbles: true }));
      const acceptance = document.querySelector('input[name="buyerPaymentDisclosureAcceptance"]');
      acceptance.checked = true;
      acceptance.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('form[data-action="pay"]').requestSubmit();
      return true;
    })()`);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (await evaluate(`location.pathname.endsWith('/confirmation') && Boolean(document.querySelector('.cton-success-card, .success-screen'))`)) break;
      await wait(250);
    }
    const confirmation = await evaluate(`(() => {
      const flow = JSON.parse(sessionStorage.getItem('siton_flow_v2') || '{}')['${dealId}'] || {};
      return {
        path: location.pathname,
        participantId: flow.participantId || '',
        success: Boolean(document.querySelector('.cton-success-card, .success-screen')),
        authorizationId: flow.authorizationId || '',
        body: document.body.innerText
      };
    })()`);
    assert.match(String(confirmation.path), /\/confirmation$/);
    assert.equal(confirmation.success, true);
    assert.match(String(confirmation.participantId), /^[0-9a-f-]{36}$/i);
    assert.ok(confirmation.authorizationId, "buyer confirmation should follow mock authorization");
    assert.match(String(confirmation.body), /לא בוצע חיוב בפועל/);

    await navigate(`/app/track/${confirmation.participantId}`);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await evaluate(`Boolean(document.querySelector('.cton-tracking-page, .tracking-command-center'))`)) break;
      await wait(250);
    }
    const tracking = await evaluate(`(() => ({
      path: location.pathname,
      rendered: Boolean(document.querySelector('.cton-tracking-page, .tracking-command-center')),
      overflow: document.documentElement.scrollWidth - window.innerWidth
    }))()`);
    assert.equal(tracking.rendered, true, "buyer tracking should render after the browser join flow");
    assert.ok(tracking.overflow <= 1, `mobile tracking should not overflow horizontally: ${JSON.stringify(tracking)}`);
    return { participantId: String(confirmation.participantId) };
  });
}

async function assertAffiliateDomFlowContract(dealId: string) {
  return withCdp("/app/affiliate", async ({ evaluate, setViewport }) => {
    await setViewport({ width: 390, height: 844 });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await evaluate(`Boolean(document.querySelector('form[data-action="affiliate-link-create"]'))`)) break;
      await wait(250);
    }
    const distributorSession = await evaluate(`(async () => {
      const response = await fetch('/api/distributor/session');
      return { status: response.status, body: await response.json() };
    })()`);
    assert.equal(distributorSession.status, 200, `local browser distributor context must be authenticated: ${JSON.stringify(distributorSession)}`);
    assert.equal(distributorSession.body?.distributor_auth?.authenticated, true);
    assert.equal(distributorSession.body?.distributor_auth?.mode, "demo-context");
    assert.ok(distributorSession.body?.distributor_auth?.distributor_context?.affiliate_id);
    const internalName = `browser-link-${Date.now()}`;
    await evaluate(`(() => {
      const deal = document.querySelector('#affiliateDealId');
      const name = document.querySelector('#affiliateLinkName');
      if (!deal || !name) throw new Error('affiliate link controls missing');
      deal.value = '${dealId}';
      deal.dispatchEvent(new Event('change', { bubbles: true }));
      name.value = '${internalName}';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('form[data-action="affiliate-link-create"]').requestSubmit();
      return true;
    })()`);
    let snapshot: any = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await wait(250);
      snapshot = await evaluate(`(() => ({
        text: document.body.innerText,
        namedLink: [...document.querySelectorAll('.affiliate-link-list h3')].some((node) => node.textContent === '${internalName}'),
        shareActions: document.querySelectorAll('.affiliate-link-list [data-inline-action="copy-link"], .affiliate-link-list [data-inline-action="share-link"]').length,
        performanceRows: document.querySelectorAll('.affiliate-performance-table tbody tr').length,
        assets: document.querySelectorAll('.marketing-asset-card').length,
        boundary: Boolean(document.querySelector('.affiliate-boundary-note')),
        overflow: document.documentElement.scrollWidth - window.innerWidth
      }))()`);
      if (snapshot.namedLink) break;
    }
    assert.equal(snapshot.namedLink, true, `affiliate named link should be created in-browser: ${JSON.stringify(snapshot)}`);
    assert.ok(snapshot.shareActions >= 2, "named links should expose copy and share actions");
    assert.ok(snapshot.performanceRows >= 1, "named links should appear in the performance table");
    assert.ok(snapshot.assets >= 1, "seller-provided marketing assets should render for distributors");
    assert.equal(snapshot.boundary, true, "distributor surface should keep the permanent attribution-only boundary");
    assert.match(String(snapshot.text), /עמלת מפיץ היא 0/);
    assert.doesNotMatch(String(snapshot.text), /יתרה זמינה|משיכת כספים|payout available/i);
    assert.ok(snapshot.overflow <= 1, `mobile affiliate workspace should not overflow horizontally: ${JSON.stringify(snapshot)}`);
    const sourceCode = await evaluate(`(() => {
      const heading = [...document.querySelectorAll('.affiliate-link-list h3')].find((node) => node.textContent === '${internalName}');
      const card = heading?.closest('.summary-item');
      const sharePath = card?.querySelector('[data-share-url]')?.getAttribute('data-share-url') || '';
      return new URL(sharePath, location.origin).searchParams.get('ref') || '';
    })()`);
    assert.match(String(sourceCode), /^[a-z0-9][a-z0-9_-]{7,63}$/);
    return { internalName, sourceCode: String(sourceCode) };
  });
}

async function assertAffiliateAttributedMetrics(internalName: string, sourceCode: string) {
  await withCdp("/app/affiliate", async ({ evaluate, setViewport }) => {
    await setViewport({ width: 390, height: 844 });
    let snapshot: any = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await wait(250);
      snapshot = await evaluate(`(async () => {
        const response = await fetch('/api/affiliate/overview');
        const payload = await response.json();
        const link = (payload.affiliate_surface?.links || []).find((item) => item.source_code === '${sourceCode}');
        const row = [...document.querySelectorAll('.affiliate-performance-table tbody tr')]
          .find((node) => node.textContent?.includes('${internalName}'));
        return {
          attributedBuyers: Number(link?.attributed_buyers || 0),
          attributedUnits: Number(link?.attributed_units || 0),
          conversionRate: Number(link?.conversion_rate || 0),
          rowVisible: Boolean(row),
          rowText: row?.textContent || '',
          overflow: document.documentElement.scrollWidth - window.innerWidth
        };
      })()`);
      if (snapshot.attributedBuyers >= 1 && snapshot.rowVisible) break;
    }
    assert.equal(snapshot.attributedBuyers, 1, `the named source should receive the browser join attribution: ${JSON.stringify(snapshot)}`);
    assert.equal(snapshot.attributedUnits, 2, "the named source should receive the browser-selected quantity");
    assert.ok(snapshot.conversionRate > 0, "named-link performance should expose a non-zero conversion after the attributed join");
    assert.match(String(snapshot.rowText), new RegExp(escapeRegex(internalName)));
    assert.ok(snapshot.overflow <= 1, `attributed metrics should not overflow on mobile: ${JSON.stringify(snapshot)}`);
  });
}

async function assertSellerClosedDealBrowserState(dealId: string) {
  await withCdp("/app/seller", async ({ evaluate, navigate, setViewport }) => {
    await setViewport({ width: 390, height: 844 });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await evaluate(`document.body.innerText.includes('Closed browser fixture')`)) break;
      await wait(250);
    }
    const dashboard = await evaluate(`(() => ({
      titleVisible: document.body.innerText.includes('Closed browser fixture'),
      businessStateVisible: document.body.innerText.includes('חלון ההצטרפות נסגר'),
      overflow: document.documentElement.scrollWidth - window.innerWidth
    }))()`);
    assert.equal(dashboard.titleVisible, true, "seller dashboard should list the closed deal");
    assert.equal(dashboard.businessStateVisible, true, "seller dashboard should use the closed business-state label");
    assert.ok(dashboard.overflow <= 1, `closed seller card should not overflow on mobile: ${JSON.stringify(dashboard)}`);

    await navigate(`/app/seller/deals/${dealId}`);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await evaluate(`Boolean(document.querySelector('.cton-seller-live'))`)) break;
      await wait(250);
    }
    const detail = await evaluate(`(async () => {
      const response = await fetch('/api/seller/deals/${dealId}');
      const payload = await response.json();
      return {
        state: payload.deal?.state,
        titleVisible: document.body.innerText.includes('Closed browser fixture'),
        businessStateVisible: document.body.innerText.includes('חלון ההצטרפות נסגר'),
        overflow: document.documentElement.scrollWidth - window.innerWidth
      };
    })()`);
    assert.equal(detail.state, "ClosedForJoining");
    assert.equal(detail.titleVisible, true, "seller closed-deal detail should render the deal title");
    assert.equal(detail.businessStateVisible, true, "seller closed-deal detail should render the business-state label");
    assert.ok(detail.overflow <= 1, `closed seller detail should not overflow on mobile: ${JSON.stringify(detail)}`);
  });
}

async function assertAdminOmnisearchBrowserFlow(dealId: string) {
  await withCdp("/app/admin", async ({ evaluate, setViewport }) => {
    await setViewport({ width: 1440, height: 1100 });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await evaluate(`Boolean(document.querySelector('#adminMissionQuery'))`)) break;
      await wait(250);
    }
    await evaluate(`(() => {
      const input = document.querySelector('#adminMissionQuery');
      if (!input) throw new Error('admin omnisearch input missing');
      input.value = '${dealId}';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.closest('form').requestSubmit();
      return true;
    })()`);
    let snapshot: any = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await wait(250);
      snapshot = await evaluate(`(() => ({
          result: Boolean(document.querySelector('a[href="/app/admin/deals/${dealId}"]')),
          resultTitle: document.body.innerText.includes('Closed browser fixture'),
          queryValue: document.querySelector('#adminMissionQuery')?.value || document.querySelector('#adminQuery')?.value || '',
          audit: document.body.innerText.includes('Audit & Forensics'),
          system: Boolean(document.querySelector('#admin-system')),
          overflow: document.documentElement.scrollWidth - window.innerWidth
      }))()`);
      if (snapshot.result) break;
    }
    assert.equal(snapshot.result, true, `admin omnisearch should link to the requested deal profile: ${JSON.stringify(snapshot)}`);
    assert.equal(snapshot.resultTitle, true, "admin omnisearch should render the matching deal title");
    assert.equal(snapshot.queryValue, dealId, "admin omnisearch should retain the submitted canonical identifier");
    assert.equal(snapshot.audit, true, "admin dashboard should expose Audit & Forensics");
    assert.equal(snapshot.system, true, "admin dashboard should expose System Status");
    assert.ok(snapshot.overflow <= 1, `admin search results should not overflow horizontally: ${JSON.stringify(snapshot)}`);
  });
}

async function assertUnavailableBuyerStates(soldOutDealId: string, closedDealId: string) {
  await withCdp(`/app/deal/${soldOutDealId}`, async ({ evaluate, navigate, setViewport }) => {
    await setViewport({ width: 390, height: 844 });
    const inspect = async (dealId: string) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (await evaluate(`Boolean(document.querySelector('form[data-action="start-join"] button[disabled]'))`)) break;
        await wait(250);
      }
      return evaluate(`(async () => {
        const response = await fetch('/api/deals/${dealId}/public');
        const payload = await response.json();
        return {
          state: payload.deal?.state,
          reason: payload.availability?.reasonCode,
          disabled: Boolean(document.querySelector('form[data-action="start-join"] button[disabled]')),
          overflow: document.documentElement.scrollWidth - window.innerWidth
        };
      })()`);
    };

    const soldOut = await inspect(soldOutDealId);
    assert.equal(soldOut.reason, "stock_exhausted");
    assert.equal(soldOut.disabled, true, "sold-out deal should disable the join CTA");
    assert.ok(soldOut.overflow <= 1, `sold-out mobile state should not overflow: ${JSON.stringify(soldOut)}`);

    await navigate(`/app/deal/${closedDealId}`);
    const closed = await inspect(closedDealId);
    assert.equal(closed.state, "ClosedForJoining");
    assert.equal(closed.reason, "closed");
    assert.equal(closed.disabled, true, "closed deal should disable the join CTA");
    assert.ok(closed.overflow <= 1, `closed mobile state should not overflow: ${JSON.stringify(closed)}`);
  });
}

async function assertFailedRecoveryBrowserState() {
  const participantId = "11111111-1111-4111-8111-111111111111";
  await withCdp("/app", async ({ evaluate, navigate, setViewport }) => {
    await setViewport({ width: 390, height: 844 });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await evaluate(`location.origin !== 'null' && Boolean(document.querySelector('#app'))`)) break;
      if (attempt === 5) await navigate("/app");
      await wait(250);
    }
    assert.notEqual(await evaluate(`location.origin`), "null", "recovery fixture should start from the app origin");
    await evaluate(`(() => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : String(input?.url || '');
        const method = String(init.method || 'GET').toUpperCase();
        if (url.includes('/api/participants/${participantId}/tracking')) {
          return new Response(JSON.stringify({ tracking: {
            participant_id: '${participantId}',
            deal_id: '22222222-2222-4222-8222-222222222222',
            deal_title: 'Recovery browser fixture',
            buyer_state: 'ChargeFailedCompletion',
            money_state: 'ChargeFailedRecovery',
            deal_state: 'CompletionWindow',
            completion_window_until: new Date(Date.now() + 3600000).toISOString(),
            qty: 2,
            estimated_total: 72
          }}), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/api/participants/${participantId}/recovery') && method === 'POST') {
          return new Response(JSON.stringify({ error: 'provider_unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
        }
        return originalFetch(input, init);
      };
      history.pushState({}, '', '/app/recovery/${participantId}');
      window.dispatchEvent(new PopStateEvent('popstate'));
      return true;
    })()`);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await evaluate(`Boolean(document.querySelector('.buyer-recovery-flow form[data-action="recovery-submit"] button:not([disabled])'))`)) break;
      await wait(250);
    }
    const ready = await evaluate(`(() => ({
      rendered: Boolean(document.querySelector('.buyer-recovery-flow')),
      enabled: Boolean(document.querySelector('form[data-action="recovery-submit"] button:not([disabled])')),
      overflow: document.documentElement.scrollWidth - window.innerWidth
    }))()`);
    assert.equal(ready.rendered, true, "failed recovery state should render in the browser");
    assert.equal(ready.enabled, true, "open completion window should allow a recovery retry");
    assert.ok(ready.overflow <= 1, `recovery mobile state should not overflow: ${JSON.stringify(ready)}`);

    await evaluate(`document.querySelector('form[data-action="recovery-submit"]').requestSubmit()`);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await evaluate(`document.body.innerText.includes('לא הצלחנו להשלים את התשלום')`)) break;
      await wait(250);
    }
    const failure = await evaluate(`document.body.innerText`);
    assert.match(String(failure), /לא הצלחנו להשלים את התשלום/, "failed recovery retry should show a safe retry message");
  });
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
      APP_DEPLOYMENT_MODE: "demo-preview",
      RATE_LIMIT_MAX: "2000",
      RATE_LIMIT_SENSITIVE_MAX: "200"
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
    await run("seller create UX contract covers validation, terms, images and distribution points", assertSellerCreateUxContract);
    await run("seller create accepts filled title and description without title-required error", assertSellerCreateTitleSubmissionContract);
    await run("CREATE_DEAL_TITLE_FIELD_CONTRACT submits real DOM flow with title, units and primary image", assertSellerCreateDomFlowContract);

    const created = await createDeal("עסקת smoke לדפדפן");
    await publishDeal(created.deal_id);
    const affiliateLink = await run("distributor creates a named attribution link and sees performance/assets at 390px", () => assertAffiliateDomFlowContract(created.deal_id));
    const joined = await run("buyer opens the attributed deal and completes OTP, mock authorization, confirmation, tracking and safe resume at 390px", () => assertBuyerDomFlowAndSafeResume(created.deal_id, affiliateLink.sourceCode));
    await run("distributor sees the browser join attributed to the named link", () => assertAffiliateAttributedMetrics(affiliateLink.internalName, affiliateLink.sourceCode));

    const soldOutDeal = await createDeal("Sold out browser fixture", { minUnits: 1, maxUnits: 1 });
    await publishDeal(soldOutDeal.deal_id);
    await createJoinedParticipant(soldOutDeal.deal_id, 1);
    const closedDeal = await createDeal("Closed browser fixture", { minUnits: 1, maxUnits: 2 });
    await publishDeal(closedDeal.deal_id);
    await createJoinedParticipant(closedDeal.deal_id, 1);
    await closeJoining(closedDeal.deal_id);
    await run("buyer sold-out and closed states disable joining at 390px", () => assertUnavailableBuyerStates(soldOutDeal.deal_id, closedDeal.deal_id));
    await run("seller sees the closed deal and business-state detail at 390px", () => assertSellerClosedDealBrowserState(closedDeal.deal_id));
    await run("admin omnisearch reaches the deal profile and keeps audit/system status visible", () => assertAdminOmnisearchBrowserFlow(closedDeal.deal_id));
    await run("buyer failed-recovery state and safe retry failure render at 390px", assertFailedRecoveryBrowserState);

    const desktopRoutes: SmokeRoute[] = [
      {
        name: "home",
        path: "/app",
        expect: ["C-ton", "הקניון של C-ton", "עסקאות אמיתיות, במקום אחד.", "עסקאות בקניון"]
      },
      {
        name: "public deal",
        path: `/app/deal/${created.deal_id}`,
        expect: ["עסקת smoke לדפדפן", "cton-deal-page", "cton-join-card", "נקודת חלוקה מרכז העיר", "תקנון", "מדיניות פרטיות", "ביטולים והחזרים"]
      },
      {
        name: "legal terms",
        path: "/legal/terms",
        expect: ["תקנון שימוש ותנאי שירות C-ton", "טיוטה אינה ציבורית", "כלל 90 אחוז"]
      },
      {
        name: "legal privacy",
        path: "/legal/privacy",
        expect: ["מדיניות פרטיות C-ton", "C-ton אינה שומרת פרטי אשראי גולמיים"]
      },
      {
        name: "legal refunds",
        path: "/legal/refunds",
        expect: ["מדיניות ביטולים, החזרים ושחרור מסגרת", "כל זכויות הצרכן לפי חוק נשמרות"]
      },
      {
        name: "seller workspace",
        path: "/app/seller",
        expect: ["עסקת smoke לדפדפן", "cton-seller-dashboard", "cton-all-deals"]
      },
      {
        name: "seller create",
        path: "/app/seller/new",
        expect: ["יצירת עסקה חדשה", "תמונת העסקה", "משלוח נבחר", "תקנון השימוש למוכרים"]
      },
      {
        name: "seller deal",
        path: `/app/seller/deals/${created.deal_id}`,
        expect: ["עסקת smoke לדפדפן", "cton-seller-live", "אם זה יסתיים עכשיו"]
      },
      {
        name: "buyer tracking",
        path: `/app/track/${joined.participantId}`,
        expect: ["cton-tracking-page", "ההצטרפות שלך", "לא בוצע חיוב בפועל"]
      },
      {
        name: "distributor workspace",
        path: "/app/affiliate",
        expect: ["affiliate-workspace", "affiliate-links", "affiliate-performance", "affiliate-assets"]
      },
      {
        name: "admin dashboard",
        path: "/app/admin",
        expect: ["מרכז שליטה תפעולי", "Omnisearch אדמין", "admin-urgency-grid", "חיפוש תפעולי"]
      },
      {
        name: "admin support hub",
        path: "/app/admin/support",
        expect: ["Admin Support Hub", "data-action=\"admin-case-filter\"", "data-action=\"admin-case-create\""]
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
        expect: ["C-ton", "הקניון של C-ton", "עסקאות אמיתיות, במקום אחד.", "עסקאות בקניון"]
      },
      {
        name: "public deal mobile",
        path: `/app/deal/${created.deal_id}`,
        expect: ["עסקת smoke לדפדפן", "cton-join-card", "נקודת חלוקה מרכז העיר", "תקנון"]
      },
      {
        name: "legal terms mobile",
        path: "/legal/terms",
        expect: ["תקנון שימוש ותנאי שירות C-ton", "מדיניות פרטיות", "ביטולים והחזרים"]
      },
      {
        name: "seller workspace mobile",
        path: "/app/seller",
        expect: ["cton-seller-dashboard", "cton-all-deals"]
      },
      {
        name: "seller create mobile",
        path: "/app/seller/new",
        expect: ["יצירת עסקה חדשה", "תמונת העסקה", "משלוח נבחר"]
      },
      {
        name: "seller deal mobile",
        path: `/app/seller/deals/${created.deal_id}`,
        expect: ["עסקת smoke לדפדפן", "cton-seller-live"]
      },
      {
        name: "buyer tracking mobile",
        path: `/app/track/${joined.participantId}`,
        expect: ["cton-tracking-page", "ההצטרפות שלך"]
      },
      {
        name: "distributor workspace mobile",
        path: "/app/affiliate",
        expect: ["affiliate-workspace", "affiliate-performance", "marketing-assets-grid"]
      },
      {
        name: "admin dashboard mobile",
        path: "/app/admin",
        expect: ["מרכז שליטה תפעולי", "Omnisearch אדמין", "admin-urgency-grid"]
      },
      {
        name: "admin support hub mobile",
        path: "/app/admin/support",
        expect: ["Admin Support Hub", "data-action=\"admin-case-filter\"", "data-action=\"admin-case-create\""]
      }
    ];

    const fallbackRoutes: SmokeRoute[] = [
      {
        name: "not found route",
        path: "/app/does-not-exist",
        expect: ["empty-surface", "shell-main"]
      },
      {
        name: "missing public deal",
        path: "/app/deal/00000000-0000-0000-0000-000000000000",
        expect: ["empty-surface", "shell-live-region"]
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
      const doms = await dumpDomRoutes(desktopRoutes, { width: 1440, height: 1100 }, "desktop");
      desktopRoutes.forEach((route, index) => {
        const dom = doms[index]!;
        assertHealthyHebrewDom(frameworkOwnedDom(dom), `desktop ${route.name}`);
        for (const text of route.expect) assert.match(dom, new RegExp(escapeRegex(text)));
      });
    });

    await run("mobile smoke routes keep core hierarchy and CTA copy visible", async () => {
      const doms = await dumpDomRoutes(mobileRoutes, { width: 390, height: 844 }, "mobile");
      mobileRoutes.forEach((route, index) => {
        const dom = doms[index]!;
        assertHealthyHebrewDom(frameworkOwnedDom(dom), `mobile ${route.name}`);
        for (const text of route.expect) assert.match(dom, new RegExp(escapeRegex(text)));
      });
    });

    await run("browser smoke keeps fallback and missing-data routes sane", async () => {
      const doms = await dumpDomRoutes(fallbackRoutes, { width: 1280, height: 900 }, "fallback");
      fallbackRoutes.forEach((route, index) => {
        const dom = doms[index]!;
        for (const text of route.expect) assert.match(dom, new RegExp(escapeRegex(text)));
      });
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

