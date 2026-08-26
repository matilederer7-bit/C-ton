import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const enabled = process.env.SITON_HOSTED_GATE === "1";
const hostedUrl = "https://bridge-head-ops.base44.app";
const accessToken = process.env.SITON_HOSTED_ACCESS_TOKEN || "";
const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const forbiddenRaw = ["401", "authentication required", "Request failed with status code", "AxiosError", "stack trace"];

type NetworkEntry = {
  requestId: string;
  method: string;
  url: string;
  postData: string;
  status: number | null;
};

type Cdp = {
  evaluate: (expression: string) => Promise<any>;
  navigate: (url: string) => Promise<void>;
  network: () => NetworkEntry[];
  setViewport: (width: number, height: number) => Promise<void>;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForProcessExit(child: ReturnType<typeof spawn>, timeoutMs: number) {
  if (child.exitCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function openEdge(initialUrl: string) {
  assert.equal(existsSync(edgePath), true, `Microsoft Edge not found: ${edgePath}`);
  const profileDir = await mkdtemp(join(tmpdir(), "siton-hosted-gate-"));
  const port = 37_000 + Math.floor(Math.random() * 2_000);
  const browser = spawn(edgePath, [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-breakpad",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-domain-reliability",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-pings",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    initialUrl
  ], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = await response.json() as Array<{ url?: string; webSocketDebuggerUrl?: string }>;
      const page = pages.find((entry) => entry.url?.startsWith(hostedUrl)) || pages[0];
      if (page?.webSocketDebuggerUrl) return { browser, profileDir, wsUrl: page.webSocketDebuggerUrl };
    } catch {}
    await wait(200);
  }

  browser.kill("SIGKILL");
  await rm(profileDir, { recursive: true, force: true });
  throw new Error("Hosted Edge CDP target did not become available");
}

async function withEdge<T>(initialUrl: string, fn: (cdp: Cdp) => Promise<T>): Promise<T> {
  const page = await openEdge(initialUrl);
  const ws = new WebSocket(page.wsUrl);
  let sequence = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const requests: NetworkEntry[] = [];

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Network.requestWillBeSent") {
      const request = message.params?.request || {};
      requests.push({
        requestId: String(message.params?.requestId || ""),
        method: String(request.method || ""),
        url: String(request.url || ""),
        postData: String(request.postData || ""),
        status: null
      });
    }
    if (message.method === "Network.responseReceived") {
      const requestId = String(message.params?.requestId || "");
      const entry = requests.findLast((candidate) => candidate.requestId === requestId);
      if (entry) entry.status = Number(message.params?.response?.status || 0);
    }
    if (message.method === "Page.javascriptDialogOpening") {
      void send("Page.handleJavaScriptDialog", { accept: true });
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
    }, 20_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); }
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP websocket did not open")), 20_000);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP websocket failed")); }, { once: true });
    });
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Network.enable");

    const evaluate = async (expression: string) => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    };
    return await fn({
      evaluate,
      navigate: async (url) => { await send("Page.navigate", { url }); },
      network: () => requests.map((entry) => ({ ...entry })),
      setViewport: async (width, height) => {
        await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width <= 480 });
      }
    });
  } finally {
    try { await Promise.race([send("Browser.close"), wait(2_000)]); } catch {}
    ws.close();
    if (!(await waitForProcessExit(page.browser, 5_000))) page.browser.kill("SIGKILL");
    await rm(page.profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function waitFor(cdp: Cdp, expression: string, description: string, attempts = 100) {
  let last: any = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await cdp.evaluate(expression).catch(() => null);
    if (last) return last;
    await wait(250);
  }
  const snapshot = await cdp.evaluate(`({url: location.href, text: document.body?.innerText?.slice(0, 3000) || ""})`).catch(() => null);
  throw new Error(`Timed out waiting for ${description}; last=${JSON.stringify(last)} snapshot=${JSON.stringify(snapshot)}`);
}

function assertNoRaw(text: string) {
  for (const value of forbiddenRaw) assert.equal(text.toLowerCase().includes(value.toLowerCase()), false, `raw error leaked: ${value}`);
  assert.equal(/^\s*[\[{].*[\]}]\s*$/s.test(text.trim()), false, "raw JSON must not replace the UI");
}

const setInput = `(selector, value) => {
  const element = document.querySelector(selector);
  if (!element) throw new Error('missing input '+selector);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}`;

async function chooseType(cdp: Cdp, label: string) {
  await cdp.evaluate(`document.querySelector('button[role="combobox"]')?.click()`);
  await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(label)})`, `type option ${label}`);
  await cdp.evaluate(`[...document.querySelectorAll('[role="option"]')].find((node) => node.textContent?.trim() === ${JSON.stringify(label)})?.click()`);
}

async function createDraft(cdp: Cdp, marker: string, type: "physical_product" | "voucher" | "ticket") {
  await cdp.navigate(`${hostedUrl}/app/seller/new`);
  await waitFor(cdp, `document.body.innerText.includes('פתיחת עסקה חדשה') && document.querySelector('#title')`, "seller create form");
  const title = `${marker} ${type}`;
  await cdp.evaluate(`(${setInput})('#title', ${JSON.stringify(title)}); (${setInput})('#price', '12'); (${setInput})('#min', '10'); (${setInput})('#max', '20'); (${setInput})('#deadline', '24')`);
  if (type === "voucher") {
    await chooseType(cdp, "שובר");
    await waitFor(cdp, `document.querySelector('#voucher-value')`, "voucher fields");
    await cdp.evaluate(`(${setInput})('#voucher-value', '20')`);
  }
  if (type === "ticket") {
    await chooseType(cdp, "כרטיס");
    await waitFor(cdp, `document.querySelector('#event-name')`, "ticket fields");
    const starts = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString().slice(0, 16);
    await cdp.evaluate(`(${setInput})('#event-name', 'אירוע בדיקה'); (${setInput})('#event-start', ${JSON.stringify(starts)})`);
  }
  await cdp.evaluate(`document.querySelector('form button[type="submit"]')?.click()`);
  const url = await waitFor(cdp, `location.pathname.includes('/app/seller/deals/') && location.pathname.endsWith('/edit') && location.href`, "created Draft edit route");
  const match = String(url).match(/\/app\/seller\/deals\/([^/]+)\/edit/);
  assert.ok(match?.[1], "created Draft id missing from route");
  const body = String(await cdp.evaluate(`document.body.innerText`));
  assertNoRaw(body);
  return { dealId: decodeURIComponent(match![1]), title };
}

async function publishFromSellerList(cdp: Cdp, dealId: string) {
  await cdp.navigate(`${hostedUrl}/app/seller/new`);
  await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(dealId)})`, `Draft ${dealId} in seller list`);
  const clicked = await cdp.evaluate(`(() => {
    const card = [...document.querySelectorAll('div.p-4')].find((node) => node.textContent?.includes(${JSON.stringify(dealId)}));
    const button = card ? [...card.querySelectorAll('button')].find((node) => node.textContent?.includes('פרסם עסקה')) : null;
    button?.click();
    return Boolean(button);
  })()`);
  assert.equal(clicked, true, `publish button missing for ${dealId}`);
  await waitFor(cdp, `document.body.innerText.includes('העסקה פורסמה: ${dealId}')`, `publish ${dealId}`);
}

async function runHostedGate() {
  assert.ok(accessToken, "SITON_HOSTED_ACCESS_TOKEN is required for the hosted seller proof");
  const marker = `TEST / בדיקת מערכת G1C ${Date.now()}`;

  await withEdge(`${hostedUrl}/app`, async (cdp) => {
    await cdp.setViewport(1440, 1100);
    await waitFor(cdp, `document.body.innerText.includes('הקניון של סיטון')`, "public Mall");
    await waitFor(cdp, `!document.querySelector('.animate-spin')`, "public Mall request completion");
    const publicProof = await cdp.evaluate(`({
      url: location.href,
      dir: document.querySelector('[dir="rtl"]')?.getAttribute('dir'),
      text: document.body.innerText,
      hasSellerLink: Boolean(document.querySelector('a[href="/app/seller/new"]')),
      filters: [...document.querySelectorAll('button[role="combobox"]')].map((node) => node.getAttribute('aria-label')),
      images: [...document.images].map((image) => ({src: image.currentSrc || image.src, complete: image.complete, width: image.naturalWidth})),
      overflow: document.documentElement.scrollWidth - innerWidth
    })`);
    assert.equal(publicProof.url.startsWith(`${hostedUrl}/app`), true);
    assert.equal(publicProof.dir, "rtl");
    assert.equal(publicProof.hasSellerLink, true);
    assert.deepEqual(publicProof.filters, ["סוג עסקה", "מצב עסקה", "מיון"]);
    assert.ok(publicProof.text.includes("כל סוגי העסקאות"));
    assert.ok(publicProof.text.includes("כל המצבים"));
    assert.ok(publicProof.text.includes("החדשות ביותר"));
    assert.ok(publicProof.overflow <= 1);
    assertNoRaw(publicProof.text);

    await cdp.evaluate(`document.querySelector('a[href="/app/seller/new"]')?.click()`);
    await waitFor(cdp, `location.href !== ${JSON.stringify(`${hostedUrl}/app`)}`, "signed-out auth navigation");
    const signedOut = await cdp.evaluate(`({url: location.href, text: document.body?.innerText || ''})`);
    assert.equal(signedOut.url.includes("/app/seller/new") && signedOut.text.includes("פתיחת עסקה חדשה"), false, "signed-out browser must not enter seller create");
    assertNoRaw(signedOut.text);
    console.log("PASS hosted Mall and signed-out auth entry");
  });

  const tokenUrl = `${hostedUrl}/app/seller/new?access_token=${encodeURIComponent(accessToken)}`;
  await withEdge(tokenUrl, async (cdp) => {
    await cdp.setViewport(1440, 1100);
    await waitFor(cdp, `document.body.innerText.includes('פתיחת עסקה חדשה')`, "signed-in seller flow");
    const signedInText = String(await cdp.evaluate(`document.body.innerText`));
    assertNoRaw(signedInText);

    const physical = await createDraft(cdp, marker, "physical_product");
    await cdp.navigate(`${hostedUrl}/app`);
    await waitFor(cdp, `document.body.innerText.includes('הקניון של סיטון')`, "Mall after Draft create");
    assert.equal(String(await cdp.evaluate(`document.body.innerText`)).includes(physical.title), false, "Draft must not be public");

    await cdp.navigate(`${hostedUrl}/app/seller/deals/${encodeURIComponent(physical.dealId)}/edit`);
    await waitFor(cdp, `document.querySelector('#edit-title')`, "return to same Draft");
    const editedTitle = `${physical.title} ערוך`;
    await cdp.evaluate(`(${setInput})('#edit-title', ${JSON.stringify(editedTitle)}); document.querySelector('form button[type="submit"]')?.click()`);
    await waitFor(cdp, `location.pathname.endsWith(${JSON.stringify(`/seller/deal/${physical.dealId}`)})`, "saved Draft detail route");

    await cdp.navigate(`${hostedUrl}/app/seller/deals/${encodeURIComponent(physical.dealId)}/images`);
    await waitFor(cdp, `document.body.innerText.includes('תמונות עסקה') && document.querySelector('input[type="file"]')`, "hosted image UI");
    await cdp.evaluate(`(() => {
      const decode = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl5sAAAAASUVORK5CYII=')], 'g1c-primary.png', {type:'image/png'}));
      const input = document.querySelector('input[type="file"]');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', {bubbles:true}));
    })()`);
    await waitFor(cdp, `document.querySelectorAll('main img').length === 1 && document.querySelector('main img')?.complete`, "hosted image upload and preview", 160);
    const imageProof = await cdp.evaluate(`({count: document.querySelectorAll('main img').length, src: document.querySelector('main img')?.src || '', text: document.body.innerText})`);
    assert.equal(imageProof.count, 1);
    assert.ok(imageProof.src.startsWith("http"));
    assert.equal(imageProof.text.includes("g1c-primary.png"), true);
    assertNoRaw(imageProof.text);

    const voucher = await createDraft(cdp, marker, "voucher");
    const ticket = await createDraft(cdp, marker, "ticket");

    const foreignId = "31e00000-0000-4000-8000-000000000003";
    await cdp.navigate(`${hostedUrl}/app/seller/deals/${foreignId}/edit`);
    await waitFor(cdp, `document.body.innerText.includes('לא ניתן') || document.body.innerText.includes('לא נמצאה') || document.body.innerText.includes('not_found')`, "foreign Draft hidden");
    const foreignText = String(await cdp.evaluate(`document.body.innerText`));
    assert.equal(foreignText.includes("עסקת בדיקת מחזור חיים Stage 31E"), false);
    assertNoRaw(foreignText);

    await publishFromSellerList(cdp, physical.dealId);
    await publishFromSellerList(cdp, voucher.dealId);
    await publishFromSellerList(cdp, ticket.dealId);

    await cdp.navigate(`${hostedUrl}/app`);
    await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(editedTitle)}) && document.body.innerText.includes(${JSON.stringify(voucher.title)}) && document.body.innerText.includes(${JSON.stringify(ticket.title)})`, "three published deal types in Mall", 200);
    const mall = await cdp.evaluate(`({
      text: document.body.innerText,
      links: [...document.querySelectorAll('a[href^="/deal/"]')].map((node) => node.getAttribute('href')),
      images: [...document.querySelectorAll('a[href^="/deal/"] img')].map((image) => ({src:image.src, complete:image.complete, width:image.naturalWidth})),
      overflow: document.documentElement.scrollWidth - innerWidth
    })`);
    assert.ok(mall.text.includes("מוצר פיזי") && mall.text.includes("שובר") && mall.text.includes("כרטיס"));
    assert.ok(mall.links.some((href: string) => href?.includes(physical.dealId)));
    assert.ok(mall.images.some((image: any) => image.complete && image.width > 0), "primary image must load on Mall card");
    assert.ok(mall.overflow <= 1);
    assertNoRaw(mall.text);

    const publicApi = await cdp.evaluate(`fetch('/functions/list-mall-deals', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({type:'all',status:'all',sort:'newest',limit:24})
    }).then(async (response) => ({status:response.status, body:await response.json()}))`);
    assert.equal(publicApi.status, 200);
    const serializedPublic = JSON.stringify(publicApi.body);
    for (const privateField of ['buyer_email','buyer_phone','buyer_address','provider_payment_id','payment_intent','money_ledger_events','transition_journal','pending_events','join_reservations']) {
      assert.equal(serializedPublic.includes(`\"${privateField}\"`), false, `public Mall leaked ${privateField}`);
    }

    await cdp.evaluate(`document.querySelector('a[href*=${JSON.stringify(physical.dealId)}]')?.click()`);
    await waitFor(cdp, `location.pathname === ${JSON.stringify(`/deal/${physical.dealId}`)}`, "canonical Deal navigation");
    await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(editedTitle)})`, "public Deal page");
    const dealProof = await cdp.evaluate(`({text:document.body.innerText, image:[...document.images].some((image)=>image.complete&&image.naturalWidth>0), overflow:document.documentElement.scrollWidth-innerWidth})`);
    assert.equal(dealProof.image, true);
    assert.ok(dealProof.overflow <= 1);
    assertNoRaw(dealProof.text);

    for (const width of [360, 375, 390, 412]) {
      await cdp.setViewport(width, 844);
      for (const path of ["/app", `/deal/${physical.dealId}`, "/app/seller/new", `/app/seller/deals/${physical.dealId}/images`]) {
        await cdp.navigate(`${hostedUrl}${path}`);
        await waitFor(cdp, `document.body && document.body.innerText.length > 20`, `${width}px ${path}`);
        const responsive = await cdp.evaluate(`({overflow:document.documentElement.scrollWidth-innerWidth, text:document.body.innerText})`);
        assert.ok(responsive.overflow <= 1, `${width}px overflow on ${path}: ${responsive.overflow}`);
        assertNoRaw(responsive.text);
      }
    }

    const sellerCalls = cdp.network().filter((entry) => /create-deal-draft|update-deal-draft|siton-seller-deal-image|publish-deal/.test(entry.url));
    assert.equal(sellerCalls.some((entry) => (entry.status || 0) >= 400), false, `seller call failure: ${JSON.stringify(sellerCalls)}`);
    assert.equal(cdp.network().some((entry) => /grow|stripe|charge|refund|invoice|sms|email/i.test(entry.url)), false, "money/message provider traffic detected");
    console.log(JSON.stringify({
      hosted_url: hostedUrl,
      marker,
      deals: { physical: physical.dealId, voucher: voucher.dealId, ticket: ticket.dealId },
      edge_widths: [360, 375, 390, 412],
      money_firewall: { grow: 0, card_authorization: 0, charge: 0, refund: 0, sms: 0, email: 0, invoice: 0 }
    }, null, 2));
    console.log("PASS hosted signed-in seller, Draft, image, publish, Mall, privacy, and mobile proof");
  });
}

if (!enabled) {
  console.log("SKIP hosted V1.1 activation gate (set SITON_HOSTED_GATE=1 with a temporary app token)");
} else {
  await runHostedGate();
}
