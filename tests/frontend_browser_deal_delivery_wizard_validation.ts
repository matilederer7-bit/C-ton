// ── DEAL WIZARD DELIVERY OPTIONS, IN A REAL BROWSER ──────────────────────────
//
// Owner-found bug (2026-09-28): a seller picked TWO delivery methods in the
// create-deal wizard and was still blocked with "add at least one delivery
// option". A delivery method was only counted when its free-text description
// field was filled — choosing the METHOD (משלוח / איסוף עצמי / נקודת חלוקה)
// did not count, and label-less rows were silently dropped from the payload
// and by the server. No suite drove the delivery step of the React wizard the
// way a seller does: every existing check typed a description into row 0.
//
// This suite drives the REAL server and the REAL React bundle over CDP:
//   - two methods chosen by type only (משלוח + איסוף עצמי with a pinned
//     location, no typed text) reach the summary, save, and BOTH are stored;
//   - back/forward through the wizard keeps both;
//   - the saved Draft reloads both into the delivery editor and saves again;
//   - one method passes; three methods pass and all three are stored;
//   - a pickup with no location at all is blocked with the precise
//     "needs an address" error — never the generic "add at least one option".
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromiumPath, launchPage, type BrowserPage } from "./helpers/browser_cdp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const compiledAppPath = join(__dirname, "..", "src", "app.js");
const port = 3394;
const baseUrl = `http://127.0.0.1:${port}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; }
}

async function waitForHealth() {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch { /* booting */ }
    await wait(500);
  }
  throw new Error("server did not become healthy");
}

// React-controlled inputs need the native setter + an input/change event.
const SET_VALUE = `(sel, value, ev) => {
  const el = document.querySelector(sel);
  if (!el) throw new Error('missing ' + sel);
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event(ev || (el.tagName === 'SELECT' ? 'change' : 'input'), { bubbles: true }));
  return true;
}`;

async function set(page: BrowserPage, selector: string, value: string) {
  await page.evaluate(`(${SET_VALUE})(${JSON.stringify(selector)}, ${JSON.stringify(value)})`);
  await wait(60);
}
async function click(page: BrowserPage, selector: string) {
  await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing ${selector.replace(/'/g, "")}'); el.click(); return true; })()`);
  await wait(250);
}
async function waitFor(page: BrowserPage, expression: string, label: string, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    if (await page.evaluate<boolean>(`Boolean(${expression})`)) return;
    await wait(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}
const stepHeading = (page: BrowserPage) => page.evaluate<string>(`(document.querySelector('.wizard-steps .active, .steps .active, [aria-current="step"]') || {}).textContent || ''`);
const visibleErrors = (page: BrowserPage) => page.evaluate<string[]>(`[...document.querySelectorAll('.field-error, [aria-invalid="true"]')].map(e => (e.textContent || e.getAttribute('data-testid') || e.id || '').trim()).filter(Boolean)`);
const onDeliveryStep = (page: BrowserPage) => page.evaluate<boolean>(`Boolean(document.querySelector('[data-testid="delivery-required-notice"]'))`);
const onSummaryStep = (page: BrowserPage) => page.evaluate<boolean>(`Boolean(document.querySelector('[data-testid="wizard-save"]'))`);

// the deadline step (between delivery and the summary) — three days ahead
async function fillDeadlineAndContinue(page: BrowserPage) {
  await waitFor(page, `document.querySelector('input[type="date"][id$="-date"]')`, "deadline step");
  const d = new Date(Date.now() + 3 * 86400_000);
  const iso = d.toISOString().slice(0, 10);
  await page.evaluate(`(() => { const setv = ${SET_VALUE};
    const date = document.querySelector('input[type="date"][id$="-date"]'); const time = document.querySelector('input[type="time"][id$="-time"]');
    setv('#' + date.id, ${JSON.stringify(iso)}); setv('#' + time.id, '18:00'); return true; })()`);
  await wait(150);
  await click(page, '[data-testid="wizard-next"]');
}

async function openWizardAtDelivery(page: BrowserPage, title: string) {
  // a fresh document per scenario: re-navigating to the same hash would keep the previous wizard mounted
  await page.goto(`${baseUrl}/preview/?fresh=${Date.now()}#/seller/new`, { waitMs: 800 });
  await waitFor(page, `document.querySelector('[data-testid="deal-title"]')`, "wizard step 0");
  await set(page, '[data-testid="deal-title"]', title);
  await set(page, '[data-testid="deal-short"]', "מארז לבדיקת אפשרויות אספקה");
  await set(page, '[data-testid="deal-price"]', "89");
  // a real PNG through the real file input
  await page.evaluate(`(async () => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const g = c.getContext('2d'); g.fillStyle = '#0f766e'; g.fillRect(0, 0, 64, 64);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const file = new File([blob], 'deal.png', { type: 'image/png' });
    const input = document.querySelector('input[type="file"]');
    const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitFor(page, `document.querySelectorAll('.img-strip img, .image-manager img, img[src^="blob:"]').length > 0`, "image preview");
  await click(page, '[data-testid="wizard-next"]');
  await waitFor(page, `document.querySelector('[data-testid="deal-min"]')`, "quantities step");
  await click(page, '[data-testid="wizard-next"]');
  await waitFor(page, `document.querySelector('[data-testid="delivery-required-notice"]')`, "delivery step");
}

async function pinLocation(page: BrowserPage, rowIndex: number, lat: string, lng: string) {
  // LocationCapture is rendered once per pickup-type row, in row order
  await page.evaluate(`(() => { const b = document.querySelectorAll('[data-testid="geo-manual-toggle"]')[${rowIndex}]; if (!b) throw new Error('no manual location toggle for pickup row ${rowIndex}'); b.click(); return true; })()`);
  await wait(200);
  await page.evaluate(`(() => {
    const setv = ${SET_VALUE};
    const box = document.querySelectorAll('[data-testid="geo-manual"]')[0];
    const lat = box.querySelector('[data-testid="geo-manual-lat"]'); lat.id = lat.id || 'geo-lat-tmp';
    const lng = box.querySelector('[data-testid="geo-manual-lng"]'); lng.id = lng.id || 'geo-lng-tmp';
    setv('#' + lat.id, ${JSON.stringify(lat)}); setv('#' + lng.id, ${JSON.stringify(lng)});
    box.querySelector('[data-testid="geo-manual-apply"]').click();
    return true;
  })()`);
  await wait(250);
}

async function createdDealId(page: BrowserPage): Promise<string> {
  await waitFor(page, `/#\\/seller\\/deal\\/[0-9a-f-]{36}/.test(location.hash)`, "navigation to the saved draft", 160);
  return String(await page.evaluate(`location.hash.match(/deal\\/([0-9a-f-]{36})/)[1]`));
}

async function storedOptions(dealId: string) {
  const res = await fetch(`${baseUrl}/api/seller/deals/${dealId}`, { headers: { "x-seller-id": "seller-default" } });
  const body: any = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
  return (body.delivery_options || []) as any[];
}

async function main() {
  if (!chromiumPath()) {
    if (process.env.CI) throw new Error("no Chromium available — the delivery wizard browser gate cannot be skipped in CI");
    console.log("DELIVERY_WIZARD_BROWSER SKIP — no Chromium available in this environment");
    return;
  }
  if (!existsSync(join(repoRoot, "web", "dist", "index.html"))) {
    throw new Error("web/dist is missing — run `npm run --prefix web build` before this suite");
  }
  const server = spawn(process.execPath, [compiledAppPath], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DISABLE_OUTBOX_WORKER: "1", APP_DEPLOYMENT_MODE: "demo-preview", RATE_LIMIT_MAX: "5000", RATE_LIMIT_SENSITIVE_MAX: "500" },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let serverStderr = "";
  server.stderr?.on("data", (chunk) => { serverStderr += String(chunk); });
  let page: BrowserPage | null = null;
  try {
    await waitForHealth();
    page = await launchPage(`${baseUrl}/preview/`);
    await page.setViewport({ width: 1280, height: 900 });
    // a demo-preview seller surface (the server resolves the demo seller)
    await page.evaluate(`localStorage.setItem('siton_session_v1', JSON.stringify({ access_token: 'demo-preview-seller', refresh_token: 'demo', expires_at: Math.floor(Date.now() / 1000) + 86400, surfaces: { seller: true, admin: false } }))`);

    let twoOptionDealId = "";
    await run("two methods chosen by TYPE only (משלוח + איסוף עצמי with a pinned location) reach the summary", async () => {
      await openWizardAtDelivery(page!, "שתי אפשרויות אספקה");
      await set(page!, '[data-testid="delivery-type-0"]', "delivery");
      await set(page!, '[data-testid="delivery-cost-0"]', "25");
      await click(page!, '[data-testid="delivery-add"]');
      await set(page!, '[data-testid="delivery-type-1"]', "pickup");
      await pinLocation(page!, 0, "32.0668", "34.7647");
      await click(page!, '[data-testid="wizard-next"]');
      assert.equal(await onDeliveryStep(page!), false, `still blocked on the delivery step: ${JSON.stringify(await visibleErrors(page!))}`);
      await fillDeadlineAndContinue(page!);
      assert.equal(await onSummaryStep(page!), true, `did not reach the summary: ${JSON.stringify(await visibleErrors(page!))} ${await stepHeading(page!)}`);
    });

    await run("back and forward through the wizard keeps both methods", async () => {
      await page!.evaluate(`[...document.querySelectorAll('.wizard-nav .btn-ghost')].pop().click()`); await wait(200);
      await page!.evaluate(`[...document.querySelectorAll('.wizard-nav .btn-ghost')].pop().click()`); await wait(250);
      assert.equal(await onDeliveryStep(page!), true, "back did not return to the delivery step");
      assert.equal(await page!.evaluate<number>(`document.querySelectorAll('[data-testid^="delivery-type-"]').length`), 2, "a method was lost going back");
      await click(page!, '[data-testid="wizard-next"]');
      await click(page!, '[data-testid="wizard-next"]');
      assert.equal(await onSummaryStep(page!), true, `forward again did not reach the summary: ${JSON.stringify(await visibleErrors(page!))}`);
    });

    await run("saving stores BOTH methods on the server", async () => {
      await click(page!, '[data-testid="wizard-save"]');
      twoOptionDealId = await createdDealId(page!);
      const options = await storedOptions(twoOptionDealId);
      assert.deepEqual(options.map((o) => o.option_type).sort(), ["delivery", "pickup"], JSON.stringify(options));
      const delivery = options.find((o) => o.option_type === "delivery");
      const pickup = options.find((o) => o.option_type === "pickup");
      assert.equal(Number(delivery.cost), 25, "the delivery cost was not kept");
      assert.equal(Number(pickup.latitude), 32.0668, "the pinned pickup location was not kept");
    });

    await run("the saved Draft reloads both methods into the delivery editor and saves them again", async () => {
      await page!.goto(`${baseUrl}/preview/#/seller/deal/${twoOptionDealId}`, { waitMs: 800 });
      await waitFor(page!, `document.querySelector('[data-testid="delivery-edit-open"]')`, "delivery editor button");
      await click(page!, '[data-testid="delivery-edit-open"]');
      assert.equal(await page!.evaluate<number>(`document.querySelectorAll('[data-testid^="delivery-type-"]').length`), 2, "the editor did not reload both methods");
      await click(page!, '[data-testid="delivery-save"]');
      await waitFor(page!, `!document.querySelector('[data-testid="delivery-save"]')`, "delivery editor to close after save");
      assert.equal((await storedOptions(twoOptionDealId)).length, 2, "re-saving the Draft lost a method");
    });

    await run("one method (משלוח, type only) passes", async () => {
      await openWizardAtDelivery(page!, "אפשרות אספקה אחת");
      await set(page!, '[data-testid="delivery-type-0"]', "delivery");
      await click(page!, '[data-testid="wizard-next"]');
      assert.equal(await onDeliveryStep(page!), false, `one method was blocked: ${JSON.stringify(await visibleErrors(page!))}`);
    });

    await run("three methods pass and all three are stored", async () => {
      await openWizardAtDelivery(page!, "שלוש אפשרויות אספקה");
      await set(page!, '[data-testid="delivery-type-0"]', "delivery");
      await click(page!, '[data-testid="delivery-add"]');
      await set(page!, '[data-testid="delivery-type-1"]', "pickup");
      await set(page!, '[data-testid="delivery-label-1"]', "הרצל 12, תל אביב");
      await click(page!, '[data-testid="delivery-add"]');
      await set(page!, '[data-testid="delivery-type-2"]', "distribution_point");
      await pinLocation(page!, 1, "31.7683", "35.2137");
      await click(page!, '[data-testid="wizard-next"]');
      assert.equal(await onDeliveryStep(page!), false, `three methods were blocked: ${JSON.stringify(await visibleErrors(page!))}`);
      await fillDeadlineAndContinue(page!);
      assert.equal(await onSummaryStep(page!), true, `three methods did not reach the summary: ${JSON.stringify(await visibleErrors(page!))}`);
      await click(page!, '[data-testid="wizard-save"]');
      const options = await storedOptions(await createdDealId(page!));
      assert.deepEqual(options.map((o) => o.option_type).sort(), ["delivery", "distribution_point", "pickup"], JSON.stringify(options));
    });

    await run("a pickup with NO location is blocked with the precise address error, not 'add at least one option'", async () => {
      await openWizardAtDelivery(page!, "איסוף ללא כתובת");
      await set(page!, '[data-testid="delivery-type-0"]', "pickup");
      await click(page!, '[data-testid="wizard-next"]');
      assert.equal(await onDeliveryStep(page!), true, "a pickup without any location must not pass");
      const text = await page!.evaluate<string>(`[...document.querySelectorAll('.field-error')].map(e => e.textContent).join(' | ')`);
      assert.ok(!/לפחות אפשרות אספקה אחת/.test(text), `the generic 'at least one option' error is shown for a chosen method: ${text}`);
      assert.ok(/כתובת|מיקום/.test(text), `no precise pickup-address error: ${text}`);
    });

    // the web-font stylesheet is third-party (Google Fonts); a sandbox without
    // that egress reports it as a failed Stylesheet request — not an app error
    // (and a sandbox TLS-intercepting proxy reports its third-party font files
    // as ERR_CERT_AUTHORITY_INVALID; the app itself is served over local HTTP)
    const errors = page.errors().filter((e) => !/favicon/.test(e.text) && !(e.kind === "request" && /^Stylesheet /.test(e.text))
      && !(e.kind === "request" && /ERR_CERT_AUTHORITY_INVALID/.test(e.text)));
    assert.deepEqual(errors, [], `browser errors: ${JSON.stringify(errors.slice(0, 3))}`);
    console.log("DEAL_DELIVERY_WIZARD_BROWSER_PASS");
  } catch (error) {
    if (serverStderr) console.error(serverStderr.slice(-3000));
    throw error;
  } finally {
    await page?.close().catch(() => undefined);
    server.kill("SIGTERM");
  }
}

await main();
