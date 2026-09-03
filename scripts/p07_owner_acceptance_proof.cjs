#!/usr/bin/env node
// P0.7 — owner-acceptance real-browser proof (headless Edge/Chrome via CDP).
//
// Drives the REAL public deal page of a published deal and proves, against the
// deployed bundle:
//   S1  public JSON carries NO seller e-mail; pickup option carries the canonical location projection
//   S2  countdown: four units, LABEL above NUMBER, numbers un-padded (1 not 01), one row on desktop
//   S3  self-pickup location visible under the option (+ map link when coordinates exist)
//   S4  the rendered page shows no seller e-mail / mailto anywhere
//   S5  "פנייה למוכר" opens the internal sheet → synthetic inquiry → success copy → "הפניות שלי"
//   S6  reload keeps "הפניות שלי" (per-browser thread token), server thread readable via token
//   S7  mobile 390px: countdown stays one readable row, no horizontal overflow, pickup line visible
//   S8  (optional, --seller-id/--seller-password) seller command center shows the inquiry, reply persists
//
// Synthetic identities only (siton.test domain). Nothing here touches money.
// Usage: node scripts/p07_owner_acceptance_proof.cjs --base-url=https://host --deal=<uuid> [--shots=dir] [--seller-id=.. --seller-password=..]
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const BASE = (args["base-url"] || "").replace(/\/+$/, "");
const DEAL = String(args.deal || "").trim();
const SHOTS = args.shots || "";
if (!BASE || !DEAL) { console.error("--base-url and --deal are required"); process.exit(1); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "/usr/bin/microsoft-edge", "/usr/bin/google-chrome"].find(existsSync);
if (!EDGE) { console.error("Edge/Chrome not found"); process.exit(1); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const findings = {};
async function run(name, fn) { try { await fn(); console.log(`PASS ${name}`); passed++; } catch (e) { console.error(`FAIL ${name}: ${e.message}`); failed++; } }
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

async function openBrowser() {
  const profileDir = join(tmpdir(), `siton-p07-proof-${Date.now()}`);
  const port = 38_000 + Math.floor(Math.random() * 1000);
  const browser = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--lang=he", "--window-size=1280,900", `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  for (let i = 0; i < 80; i++) { try { const res = await fetch(`http://127.0.0.1:${port}/json/list`); const pages = await res.json(); const page = pages.find((p) => p.type === "page"); if (page?.webSocketDebuggerUrl) return { browser, wsUrl: page.webSocketDebuggerUrl }; } catch { /* retry */ } await wait(250); }
  browser.kill("SIGKILL"); throw new Error("CDP not available");
}
function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl); let seq = 0; const pending = new Map();
  ws.addEventListener("message", (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); } });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const ready = new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", () => reject(new Error("ws error"))); });
  return {
    ready, send, close: () => ws.close(),
    async navigate(url) { await send("Page.enable"); await send("Page.navigate", { url }); },
    async evaluate(expression) { const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || res.exceptionDetails.exception?.description || "evaluate failed"); return res.result?.value; },
    async screenshot(file) { if (!SHOTS) return; const res = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(SHOTS, file), Buffer.from(res.data, "base64")); console.log(`SHOT ${join(SHOTS, file)}`); }
  };
}
async function waitFor(cdp, expr, timeoutMs = 25_000, label = "condition") { const deadline = Date.now() + timeoutMs; let last = null; while (Date.now() < deadline) { last = await cdp.evaluate(expr).catch(() => null); if (last) return last; await wait(200); } throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last).slice(0, 200)}`); }
const setInput = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`;
const click = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`;
const exists = (selector) => `Boolean(document.querySelector(${JSON.stringify(selector)}))`;

const COUNTDOWN_PROBE = `(() => {
  const root = document.querySelector('[data-testid="live-countdown"]');
  if (!root) return null;
  const units = [...root.querySelectorAll('.cd-unit')].map((u) => {
    const label = u.querySelector('.cd-label'); const num = u.querySelector('.cd-num');
    const lr = label.getBoundingClientRect(), nr = num.getBoundingClientRect(), ur = u.getBoundingClientRect();
    return { unit: u.dataset.unit, label: label.textContent.trim(), value: num.textContent.trim(), labelTop: lr.top, numTop: nr.top, top: ur.top, left: ur.left, width: ur.width };
  });
  return { units, reached: root.dataset.reached, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth };
})()`;

async function main() {
  const { browser, wsUrl } = await openBrowser();
  const cdp = cdpSession(wsUrl); await cdp.ready;
  let nav = 0;
  const BUYER_EMAIL = `p07-buyer-${Date.now().toString(36)}@siton.test`;
  let sellerDomainEmails = [];
  try {
    await cdp.send("Page.enable");

    await run("S1 public JSON: no seller e-mail; pickup carries the canonical location projection", async () => {
      const res = await fetch(`${BASE}/api/deals/${DEAL}/public`);
      assert(res.ok, `public route ${res.status}`);
      const text = await res.text();
      const body = JSON.parse(text);
      assert(!("support_email" in (body.seller || {})), "seller.support_email present");
      assert(!/support_email/.test(text), "support_email key in JSON");
      const emails = text.match(EMAIL_RE) || [];
      sellerDomainEmails = emails;
      assert(emails.length === 0, `e-mail address in public JSON: ${emails.join(",")}`);
      assert(body.seller?.contact_channel === "siton_inquiry", "contact_channel missing");
      assert(!("support_phone" in body.seller), "support_phone present in public JSON");
      const pickup = (body.deal.delivery_options || []).find((o) => o.option_type === "pickup" || o.option_type === "distribution_point");
      assert(pickup, "no pickup option on the fixture deal");
      assert(pickup.has_location === true && typeof pickup.location_text === "string" && pickup.location_text.length > 3, `pickup projection: ${JSON.stringify(pickup)}`);
      findings.pickup_location_text = pickup.location_text;
      findings.deadline = body.deal.deadline;
    });

    const openDeal = async (suffix) => {
      nav += 1;
      await cdp.navigate(`${BASE}/preview/?p07=${nav}${suffix || ""}#/deal/${DEAL}`);
      await waitFor(cdp, exists('[data-testid="deal-countdown"], [data-testid="fulfillment-summary"], [data-testid="seller-contact-panel"]'), 30_000, "deal page");
    };

    await run("S2 countdown: four units, label ABOVE number, un-padded numbers, one row on desktop", async () => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await openDeal();
      const probe = await waitFor(cdp, COUNTDOWN_PROBE, 25_000, "countdown");
      assert(probe.units.length === 4, `units=${probe.units.length}`);
      assert(probe.units.map((u) => u.label).join(" ") === "ימים שעות דקות שניות", `labels: ${probe.units.map((u) => u.label).join(" ")}`);
      for (const u of probe.units) {
        assert(/^\d+$/.test(u.value), `${u.unit} value not digits: ${u.value}`);
        assert(!/^0\d/.test(u.value), `${u.unit} zero-padded: ${u.value}`);
        assert(u.labelTop < u.numTop, `${u.unit}: label must sit above the number`);
      }
      const tops = new Set(probe.units.map((u) => Math.round(u.top)));
      assert(tops.size === 1, `desktop units not on one row: ${[...tops].join(",")}`);
      // RTL: days is the RIGHT-most cell (first in reading order)
      const byLeft = [...probe.units].sort((a, b) => b.left - a.left).map((u) => u.unit);
      assert(byLeft[0] === "days" && byLeft[3] === "seconds", `RTL order wrong: ${byLeft.join(">")}`);
      findings.countdown_desktop = probe.units.map((u) => `${u.label}=${u.value}`).join(" ");
      await cdp.screenshot("p07-desktop-deal.png");
    });

    await run("S3 self-pickup location is visible under the option (+ map link)", async () => {
      const loc = await waitFor(cdp, `(() => { const el = document.querySelector('[data-testid="pickup-location-text"]'); return el ? el.textContent.trim() : null; })()`, 10_000, "pickup location");
      assert(loc.includes(findings.pickup_location_text), `pickup text mismatch: ${loc}`);
      const fallback = await cdp.evaluate(exists('[data-testid="pickup-location-fallback"]'));
      assert(!fallback, "neutral fallback rendered although a location exists");
      const nav = await cdp.evaluate(`(() => { const a = document.querySelector('[data-testid="pickup-nav"]'); return a ? a.getAttribute('href') : null; })()`);
      findings.pickup_map_link = nav;
      assert(!nav || /google\.com\/maps/.test(nav), `unexpected map link: ${nav}`);
      const optionTitle = await cdp.evaluate(`(() => { const l = document.querySelector('[data-testid="delivery-option"][data-option-type="pickup"], [data-testid="delivery-option"][data-option-type="distribution_point"]'); return l ? l.textContent.trim() : ""; })()`);
      assert(/איסוף עצמי|נקודת חלוקה/.test(optionTitle), `option title: ${optionTitle}`);
    });

    await run("S4 rendered page shows no seller e-mail and no mailto anywhere", async () => {
      const text = await cdp.evaluate(`document.body.innerText`);
      const html = await cdp.evaluate(`document.documentElement.outerHTML`);
      assert(!/mailto:/.test(html), "mailto link rendered");
      assert(!/wa\.me|tel:/.test(html), "phone / WhatsApp link rendered");
      assert(!/support_phone/.test(text), "phone field rendered");
      const emails = (text.match(EMAIL_RE) || []).filter((e) => !e.endsWith("@siton.test"));
      assert(emails.length === 0, `e-mail visible on the page: ${emails.join(",")}`);
      assert(await cdp.evaluate(exists('[data-testid="inquiry-open"]')), "פנייה למוכר button missing");
    });

    if (args["read-only"]) {
      console.log("SKIP S5/S6/S8 (--read-only: no synthetic inquiry is created)");
    }
    if (!args["read-only"]) await run("S5 internal inquiry: sheet → synthetic submission → success copy → הפניות שלי", async () => {
      assert(await cdp.evaluate(click('[data-testid="inquiry-open"]')), "click inquiry-open");
      await waitFor(cdp, exists('[data-testid="inquiry-submit"]'), 10_000, "inquiry sheet");
      await cdp.screenshot("p07-inquiry-sheet.png");
      await cdp.evaluate(setInput('[data-testid="inquiry-name"]', "קונה הדגמה P0.7"));
      await cdp.evaluate(setInput('[data-testid="inquiry-email"]', BUYER_EMAIL));
      await cdp.evaluate(setInput('[data-testid="inquiry-message"]', "היי, האם אפשר לאסוף גם בשעות הערב? (פנייה סינתטית — הוכחת P0.7)"));
      // The public inquiry route sits behind the per-IP sensitive rate bucket
      // (same as join/OTP). Repeated proof runs from ONE machine can hit it, so
      // the harness reads the visible error and retries after the window —
      // a throttled submission is the product working, not a defect.
      let success = null;
      for (let attempt = 1; attempt <= 4 && !success; attempt++) {
        await cdp.evaluate(click('[data-testid="inquiry-submit"]'));
        const outcome = await waitFor(cdp, `(() => {
          const ok = document.querySelector('[data-testid="inquiry-success"]');
          if (ok) return { ok: ok.textContent };
          const err = document.querySelector('[data-testid="inquiry-error"]');
          return err && err.textContent.trim() ? { error: err.textContent.trim() } : null;
        })()`, 25_000, "inquiry outcome");
        if (outcome.ok) { success = outcome.ok; break; }
        assert(/יותר מדי בקשות|יותר מדי פניות/.test(outcome.error), `inquiry failed: ${outcome.error}`);
        console.log(`  throttled by the per-IP sensitive bucket (attempt ${attempt}) — waiting for the window`);
        await wait(65_000);
      }
      assert(success, "inquiry never succeeded within 4 attempts");
      assert(success.includes("הפנייה נשלחה למוכר דרך סיטון"), `success copy: ${success.slice(0, 120)}`);
      assert(!/מייל|email/i.test(success.split("\n")[0] || ""), "primary success line must not claim an e-mail was sent");
      await cdp.screenshot("p07-inquiry-success.png");
      await cdp.evaluate(click('[data-testid="inquiry-done"]'));
      await waitFor(cdp, exists('[data-testid="my-inquiry"]'), 20_000, "my inquiries");
      const stored = await cdp.evaluate(`JSON.parse(localStorage.getItem("siton_inquiries_v1") || "{}")[${JSON.stringify(DEAL)}][0]`);
      assert(stored && stored.thread_id && stored.token, "thread token stored in the browser");
      findings.thread_id = stored.thread_id;
      findings.thread_token = stored.token;
      await cdp.screenshot("p07-my-inquiries.png");
    });

    if (!args["read-only"]) await run("S6 reload keeps הפניות שלי; the server thread is readable ONLY with the token; no seller e-mail in it", async () => {
      await openDeal("&reload=1");
      await waitFor(cdp, exists('[data-testid="my-inquiry"]'), 20_000, "my inquiries after reload");
      const ok = await fetch(`${BASE}/api/inquiries/${findings.thread_id}?t=${encodeURIComponent(findings.thread_token)}`);
      assert(ok.status === 200, `tokenized read ${ok.status}`);
      const text = await ok.text();
      assert(!(text.match(EMAIL_RE) || []).some((e) => !e.endsWith("@siton.test")), "seller e-mail leaked into the customer thread view");
      const bad = await fetch(`${BASE}/api/inquiries/${findings.thread_id}?t=forged`);
      assert(bad.status === 404, `forged token ${bad.status}`);
      const dup = await fetch(`${BASE}/api/deals/${DEAL}/inquiries`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "קונה הדגמה P0.7", email: BUYER_EMAIL, message: "היי, האם אפשר לאסוף גם בשעות הערב? (פנייה סינתטית — הוכחת P0.7)" }) });
      const dupBody = await dup.json();
      assert(dup.status === 200 && dupBody.duplicate === true && dupBody.thread_id === findings.thread_id, `retry not deduped: ${dup.status} ${JSON.stringify(dupBody).slice(0, 160)}`);
    });

    await run("S7 mobile 390px: countdown one readable row, no horizontal overflow, pickup visible", async () => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await openDeal("&m=1");
      const probe = await waitFor(cdp, COUNTDOWN_PROBE, 25_000, "mobile countdown");
      assert(probe.units.length === 4, "mobile units");
      const tops = new Set(probe.units.map((u) => Math.round(u.top)));
      assert(tops.size === 1, `mobile units wrapped: ${[...tops].join(",")}`);
      for (const u of probe.units) { assert(u.labelTop < u.numTop, `${u.unit} label not above`); assert(!/^0\d/.test(u.value), `${u.unit} padded`); assert(u.width >= 60, `${u.unit} too narrow ${u.width}`); }
      assert(probe.scrollWidth <= probe.innerWidth + 1, `horizontal overflow ${probe.scrollWidth}>${probe.innerWidth}`);
      assert(await cdp.evaluate(exists('[data-testid="pickup-location-text"]')), "pickup line missing on mobile");
      findings.countdown_mobile = probe.units.map((u) => `${u.label}=${u.value}`).join(" ");
      await cdp.screenshot("p07-mobile-deal.png");
      await cdp.send("Emulation.clearDeviceMetricsOverride");
    });

    if (args["seller-id"] && args["seller-password"] && !args["read-only"]) {
      await run("S8 seller command center shows the inquiry; reply persists inside the product", async () => {
        const login = await fetch(`${BASE}/api/seller/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: args["seller-id"], password: args["seller-password"] }) });
        assert(login.status === 200, `seller login ${login.status}`);
        const setCookie = login.headers.get("set-cookie") || "";
        const m = setCookie.match(/siton_seller_session=([^;]+)/);
        assert(m, "no seller session cookie");
        const host = new URL(BASE).hostname;
        await cdp.send("Network.enable");
        await cdp.send("Network.setCookie", { name: "siton_seller_session", value: m[1], domain: host, path: "/", secure: BASE.startsWith("https"), httpOnly: true });
        await cdp.navigate(`${BASE}/preview/?p07=seller#/`);
        await waitFor(cdp, `document.readyState === "complete"`, 20_000, "shell");
        await cdp.evaluate(`localStorage.setItem("siton_session_v1", JSON.stringify({ access_token: "p07-cookie-session", refresh_token: "p07-cookie-session", expires_at: Math.floor(Date.now()/1000) + 86400, surfaces: { seller: true, admin: false } })); localStorage.removeItem("siton_guest_mode_v1"); true`);
        nav += 1;
        await cdp.navigate(`${BASE}/preview/?p07=${nav}#/seller`);
        await waitFor(cdp, exists('[data-testid="inquiries-panel"]'), 30_000, "inquiries panel");
        const row = await waitFor(cdp, `(() => { const r = document.querySelector('[data-testid="inquiry-row"][data-thread-id="${findings.thread_id}"]'); return r ? r.textContent : null; })()`, 20_000, "inquiry row");
        assert(row.includes("קונה הדגמה P0.7"), `row text: ${row}`);
        await cdp.screenshot("p07-seller-dashboard.png");
        await cdp.evaluate(click(`[data-testid="inquiry-row"][data-thread-id="${findings.thread_id}"]`));
        await waitFor(cdp, exists('[data-testid="inquiry-reply-body"]'), 20_000, "thread page");
        const masked = await cdp.evaluate(`document.querySelector('[data-testid="inquiry-customer-email"]').textContent`);
        assert(/\*\*\*@/.test(masked), `customer e-mail not masked: ${masked}`);
        await cdp.evaluate(setInput('[data-testid="inquiry-reply-body"]', "כן, איסוף אפשרי עד 20:00 (תשובה סינתטית P0.7)"));
        await cdp.evaluate(click('[data-testid="inquiry-reply-send"]'));
        await waitFor(cdp, exists('[data-testid="inquiry-msg-seller"]'), 20_000, "seller reply rendered");
        const status = await cdp.evaluate(`document.querySelector('[data-testid="inquiry-status"]').textContent`);
        assert(status.includes("נענתה"), `status: ${status}`);
        await cdp.screenshot("p07-seller-thread.png");
        const view = await fetch(`${BASE}/api/inquiries/${findings.thread_id}?t=${encodeURIComponent(findings.thread_token)}`).then((r) => r.json());
        assert(view.messages.some((x) => x.sender_type === "Seller"), "customer view lacks the seller reply");
      });
    } else {
      console.log("SKIP S8 seller command center (pass --seller-id/--seller-password for a disposable synthetic seller)");
    }

    // S9 — Draft BUYER PREVIEW through the seller-authorized route: the same
    // renderer in read-only mode. --draft=<uuid> (a Draft owned by the seller)
    // + seller credentials. Read-only by construction: nothing is created.
    if (args.draft && args["seller-id"] && args["seller-password"]) {
      await run("S9 Draft buyer preview: seller-only, same renderer, countdown + pickup, mutations disabled, public route 404", async () => {
        const draft = String(args.draft);
        const pub = await fetch(`${BASE}/api/deals/${draft}/public`);
        assert(pub.status === 404, `Draft must be undiscoverable publicly, got ${pub.status}`);
        const anon = await fetch(`${BASE}/api/seller/deals/${draft}/preview`);
        assert([401, 403, 404].includes(anon.status), `anonymous preview must be refused, got ${anon.status}`);
        const login = await fetch(`${BASE}/api/seller/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: args["seller-id"], password: args["seller-password"] }) });
        assert(login.status === 200, `seller login ${login.status}`);
        const m = (login.headers.get("set-cookie") || "").match(/siton_seller_session=([^;]+)/);
        assert(m, "no seller session cookie");
        const api = await fetch(`${BASE}/api/seller/deals/${draft}/preview`, { headers: { cookie: `siton_seller_session=${m[1]}` } });
        assert(api.status === 200, `preview route ${api.status}`);
        const body = await api.json();
        assert(body.preview?.mode === "seller_preview" && body.deal?.state === "Draft" && body.deal?.published_at === null, "preview metadata / Draft state");
        assert(!("support_email" in body.seller) && !("support_phone" in body.seller), "contact data in preview JSON");
        const host = new URL(BASE).hostname;
        await cdp.send("Network.enable");
        await cdp.send("Network.setCookie", { name: "siton_seller_session", value: m[1], domain: host, path: "/", secure: BASE.startsWith("https"), httpOnly: true });
        await cdp.navigate(`${BASE}/preview/?p07=draft#/`);
        await waitFor(cdp, `document.readyState === "complete"`, 20_000, "shell");
        await cdp.evaluate(`localStorage.setItem("siton_session_v1", JSON.stringify({ access_token: "p07-cookie-session", refresh_token: "p07-cookie-session", expires_at: Math.floor(Date.now()/1000) + 86400, surfaces: { seller: true, admin: false } })); localStorage.removeItem("siton_guest_mode_v1"); true`);
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        nav += 1;
        await cdp.navigate(`${BASE}/preview/?p07=${nav}#/seller/deal/${draft}/preview`);
        await waitFor(cdp, exists('[data-testid="preview-banner"]'), 30_000, "preview banner");
        const probe = await waitFor(cdp, COUNTDOWN_PROBE, 25_000, "preview countdown");
        assert(probe.units.length === 4 && probe.units.every((u) => /^\d+$/.test(u.value) && !/^0\d/.test(u.value) && u.labelTop < u.numTop), "preview countdown cells");
        const loc = await waitFor(cdp, `(() => { const el = document.querySelector('[data-testid="pickup-location-text"]'); return el ? el.textContent.trim() : null; })()`, 10_000, "preview pickup location");
        assert(loc.includes(body.deal.delivery_options.find((o) => o.option_type === "pickup").location_text), `preview pickup text: ${loc}`);
        const joinDisabled = await cdp.evaluate(`(() => { const b = document.querySelector('[data-testid="join-open"]'); return b ? b.disabled : null; })()`);
        assert(joinDisabled === true, `join must be disabled in preview (got ${joinDisabled})`);
        const inquiryDisabled = await cdp.evaluate(`(() => { const b = document.querySelector('[data-testid="inquiry-open"]'); return b ? b.disabled : null; })()`);
        assert(inquiryDisabled === true, "inquiry must be disabled in preview");
        assert(await cdp.evaluate(exists('[data-testid="share-preview-note"]')), "share actions must be replaced by the preview note");
        const html = await cdp.evaluate(`document.documentElement.outerHTML`);
        assert(!/mailto:|wa\.me|tel:/.test(html), "contact link rendered in preview");
        await cdp.screenshot("p07-draft-preview.png");
        findings.draft_preview_countdown = probe.units.map((u) => `${u.label}=${u.value}`).join(" ");
        const still = await fetch(`${BASE}/api/deals/${draft}/public`);
        assert(still.status === 404, "Draft became public after preview");
      });
    } else {
      console.log("SKIP S9 Draft buyer preview (pass --draft plus seller credentials)");
    }
  } finally {
    cdp.close();
    browser.kill("SIGKILL");
  }
  console.log(`\nP07_HOSTED_PROOF passed=${passed} failed=${failed} findings=${JSON.stringify(findings)}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
