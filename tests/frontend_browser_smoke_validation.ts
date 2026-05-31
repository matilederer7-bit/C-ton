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
const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const compiledAppPath = join(__dirname, "..", "src", "app.js");
const smokePort = 3310;
const cdpPort = 3311;
const baseUrl = `http://127.0.0.1:${smokePort}`;

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

async function openCdpPage(path: string) {
  if (!existsSync(edgePath)) {
    throw new Error(`Edge executable not found at ${edgePath}`);
  }
  const profileDir = join(tmpdir(), `siton-cdp-smoke-${Date.now()}`);
  await mkdir(profileDir, { recursive: true });
  const browser = spawn(edgePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    `${baseUrl}${path}`
  ], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const pages = await response.json() as Array<{ url?: string; webSocketDebuggerUrl?: string }>;
      const page = pages.find((item) => item.url?.includes(path)) || pages[0];
      if (page?.webSocketDebuggerUrl) {
        return { browser, profileDir, wsUrl: page.webSocketDebuggerUrl };
      }
    } catch {}
    await wait(250);
  }
  browser.kill("SIGKILL");
  rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  throw new Error("Edge CDP page did not become available");
}

async function withCdp(path: string, fn: (cdp: { evaluate: (expression: string) => Promise<any> }) => Promise<void>) {
  const page = await openCdpPage(path);
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
    pending.set(id, { resolve, reject });
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
    await fn({ evaluate });
  } finally {
    ws.close();
    page.browser.kill("SIGKILL");
    rm(page.profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function randomSuffix(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
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
    { path: "/app", contentType: "text/html", expect: ["charset=utf-8", "<title>C-ton</title>", "/app/assets/app.js", "/app/assets/styles.css"] },
    { path: "/app/assets/app.js", contentType: "application/javascript", expect: ["charset=utf-8", "renderProgressBlock", "פתחו עסקה חדשה", "C-ton"] },
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
  assert.match(source, /body: json\(buildCreateDealPayload/, "create deal submit should use one canonical payload builder");
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
    await wait(1500);
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
      files.items.add(new File([new Uint8Array([1,2,3,4,5,6])], "primary.png", { type: "image/png" }));
      files.items.add(new File([new Uint8Array([7,8,9,10,11,12])], "secondary.png", { type: "image/png" }));
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
    assert.equal(imageRequests[0].body.is_primary, true);
    assert.equal(imageRequests[1].body.is_primary, false);

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
    await run("seller create UX contract covers validation, terms, images and distribution points", assertSellerCreateUxContract);
    await run("seller create accepts filled title and description without title-required error", assertSellerCreateTitleSubmissionContract);
    await run("CREATE_DEAL_TITLE_FIELD_CONTRACT submits real DOM flow with title, units and primary image", assertSellerCreateDomFlowContract);

    const created = await createDeal("עסקת smoke לדפדפן");
    await publishDeal(created.deal_id);
    const joined = await createJoinedParticipant(created.deal_id);

    const desktopRoutes: SmokeRoute[] = [
      {
        name: "home",
        path: "/app",
        expect: ["C-ton", "קונים יחד. משלמים רק כשזה קורה.", "פתחו עסקה חדשה", "צפו בדמו חי"]
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
        expect: ["C-ton", "קונים יחד. משלמים רק כשזה קורה.", "פתחו עסקה חדשה"]
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

