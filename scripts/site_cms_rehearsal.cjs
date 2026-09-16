// SITE CMS — end-to-end rehearsal against a RUNNING service (local stack or staging).
//
//   node scripts/site_cms_rehearsal.cjs --base-url=http://127.0.0.1:3210 --admin-cookie=<siton_admin_session>
//   node scripts/site_cms_rehearsal.cjs --base-url=http://127.0.0.1:3210 --local-admin   (mints a session via DATABASE_URL)
//
// Non-sensitive test content only. Steps: read the public heading → save a draft
// heading → confirm the public API and the public page are unchanged → confirm the
// admin preview (API + browser tab with the preview flag) shows the draft → publish →
// confirm the public page changed → restore the original content → smoke the public
// landing, legal page, admin gate, seller area, deal / tracking routes for crashes and
// horizontal overflow. No financial route is touched. Exit code 1 on any failure.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const BASE = String(args['base-url'] || process.env.BASE_URL || 'http://127.0.0.1:3210').replace(/\/$/, '');
const EDGE = [process.env.BROWSER_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome', '/opt/pw-browsers/chromium'].filter(Boolean).find(fs.existsSync);
const wait = ms => new Promise(r => setTimeout(r, ms));
const REHEARSAL_TITLE = `כותרת חזרה כללית ${new Date().toISOString().slice(11, 19)}`;
let checks = 0;
const ok = (name, cond, detail = '') => { assert.ok(cond, `${name} ${detail}`); checks++; console.log(`PASS ${name}`); };

function mintLocalAdminCookie() {
  const code = `
    import { pool } from "./src/db.ts"; import { issueAdminSession } from "./src/admin_identity.ts"; import { randomUUID } from "node:crypto";
    const admin = (await pool.query("INSERT INTO siton.admin_users(email,display_name,role,status,mfa_required,mfa_enabled) VALUES($1,'Rehearsal Admin','SuperAdmin','Active',false,false) RETURNING admin_user_id", ["rehearsal-" + randomUUID() + "@example.invalid"])).rows[0];
    const s = await issueAdminSession(pool, admin.admin_user_id, { headers: {}, ip: "127.0.0.1" }, true);
    console.log("COOKIE=" + s.token); await pool.end(); process.exit(0);`;
  // an ESM scratch file: top-level await is not available through `tsx -e`
  const file = path.join(process.cwd(), '.tmp_cms_rehearsal_admin.mts');
  fs.writeFileSync(file, code);
  let r;
  try { r = spawnSync(process.execPath, [require.resolve('tsx/cli'), file], { encoding: 'utf8', env: process.env }); }
  finally { fs.rmSync(file, { force: true }); }
  const m = /COOKIE=(\S+)/.exec(r.stdout || '');
  if (!m) throw new Error(`could not mint a local admin session: ${r.stderr}`);
  return m[1];
}

async function main() {
  const cookie = args['admin-cookie'] ? String(args['admin-cookie']) : args['local-admin'] ? mintLocalAdminCookie() : '';
  if (!cookie) throw new Error('an admin session is required (--admin-cookie=… or --local-admin)');
  const adminHeaders = { cookie: `siton_admin_session=${cookie}`, 'content-type': 'application/json' };
  const get = async (p, headers = {}) => { const r = await fetch(BASE + p, { headers }); return { status: r.status, text: await r.text(), headers: r.headers }; };
  const json = async (p, headers = {}) => JSON.parse((await get(p, headers)).text);
  const send = async (method, p, body) => { const r = await fetch(BASE + p, { method, headers: adminHeaders, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

  // ── 1. baseline ──
  const publicBefore = (await json('/api/site-content')).content.home;
  const originalTitle = publicBefore.title;
  const admin = await json('/api/admin/site-content', adminHeaders);
  ok('admin loads the home page contract', admin.ok && admin.sections.home && Array.isArray(admin.sections.home.published.blocks));
  let revision = admin.sections.home.revision;
  const startingDraft = admin.sections.home.draft;
  ok('anonymous caller cannot read the draft preview', [401, 403].includes((await get('/api/admin/site-content/preview')).status));

  // ── 2. draft ──
  const draft = JSON.parse(JSON.stringify(admin.sections.home.draft || admin.sections.home.published));
  draft.blocks[0].fields.title = REHEARSAL_TITLE;
  let r = await send('PUT', '/api/admin/site-content/home/draft', { value: draft, revision });
  ok('draft heading saved', r.status === 200, JSON.stringify(r.body));
  revision = r.body.sections.home.revision;
  ok('public API still serves the original heading after the draft save', (await json('/api/site-content')).content.home.title === originalTitle);
  ok('admin preview API serves the draft heading', (await json('/api/admin/site-content/preview', adminHeaders)).content.home.title === REHEARSAL_TITLE);

  // ── 3. browser: public page unchanged, preview tab shows the draft ──
  let browser, ws;
  const cdp = EDGE ? await (async () => {
    const debugPort = 38475;
    browser = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.resolve('.tmp_cms_rehearsal_profile')}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
    let page; for (let i = 0; i < 80; i++) { try { page = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(p => p.type === 'page'); if (page) break; } catch {} await wait(200); }
    if (!page) throw new Error('browser unavailable');
    ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 0; const pending = new Map(); ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } };
    const sendCdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
    const ev = async expression => { const res = await sendCdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (res.exceptionDetails) throw Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text); return res.result?.value; };
    const waitFor = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(expr)) return; } catch {} await wait(100); } throw Error(`timeout waiting for ${expr}`); };
    await sendCdp('Page.enable'); await sendCdp('Network.enable');
    // url-scoped (a `domain` attribute is refused for IP hosts such as 127.0.0.1)
    const set = await sendCdp('Network.setCookie', { name: 'siton_admin_session', value: cookie, url: `${BASE}/`, path: '/', httpOnly: true, secure: BASE.startsWith('https:') });
    if (!set.success) throw new Error('could not set the admin session cookie in the browser');
    await sendCdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
    // a fresh document each time (a hash-only change would not reboot the app, like a real new tab does)
    const open = async (hash) => { await sendCdp('Page.navigate', { url: `${BASE}/preview/?r=${Date.now()}${hash}` }); };
    return { sendCdp, ev, waitFor, open };
  })() : null;
  if (cdp) {
    await cdp.open('#/'); await cdp.waitFor('!!document.querySelector(".landing-title")');
    ok('browser: public landing shows the ORIGINAL heading while the draft exists', (await cdp.ev('document.querySelector(".landing-title").innerText')) === originalTitle);
    ok('browser: no preview banner on the public site', !(await cdp.ev('!!document.querySelector(\'[data-testid="cms-preview-banner"]\')')));
    await cdp.open('#/?cms_preview=1'); await cdp.waitFor(`document.querySelector(".landing-title") && document.querySelector(".landing-title").innerText === ${JSON.stringify(REHEARSAL_TITLE)}`);
    ok('browser: the preview tab shows the DRAFT heading with the banner', await cdp.ev('document.querySelector(\'[data-testid="cms-preview-banner"]\').dataset.preview === "1"'));
    ok('browser: preview tab has no horizontal overflow at 390px', !(await cdp.ev('document.documentElement.scrollWidth>innerWidth')));
    await cdp.ev('sessionStorage.removeItem("siton_cms_preview_v1")');
  } else console.log('SKIP browser checks (no Chromium found; set BROWSER_PATH)');

  // ── 4. publish ──
  r = await send('POST', '/api/admin/site-content/home/publish', { revision });
  ok('publish succeeded', r.status === 200, JSON.stringify(r.body));
  revision = r.body.sections.home.revision;
  ok('public API serves the published heading', (await json('/api/site-content')).content.home.title === REHEARSAL_TITLE);
  if (cdp) {
    await cdp.open('#/'); await cdp.waitFor(`document.querySelector(".landing-title") && document.querySelector(".landing-title").innerText === ${JSON.stringify(REHEARSAL_TITLE)}`);
    ok('browser: public landing shows the PUBLISHED heading', true);
  }

  // ── 5. restore ──
  const restore = JSON.parse(JSON.stringify(publicBefore.blocks ? { blocks: publicBefore.blocks } : admin.sections.home.published));
  r = await send('PUT', '/api/admin/site-content/home/draft', { value: restore, revision }); ok('restore draft saved', r.status === 200, JSON.stringify(r.body)); revision = r.body.sections.home.revision;
  r = await send('POST', '/api/admin/site-content/home/publish', { revision }); ok('original content republished', r.status === 200, JSON.stringify(r.body)); revision = r.body.sections.home.revision;
  ok('public API serves the original heading again', (await json('/api/site-content')).content.home.title === originalTitle);
  if (startingDraft) { r = await send('PUT', '/api/admin/site-content/home/draft', { value: startingDraft, revision }); ok('pre-existing draft restored', r.status === 200); }

  // ── 6. smoke: hardened UX surfaces still present ──
  ok('GET /preview/ serves the React shell', (await get('/preview/')).status === 200);
  const legal = await get('/legal/terms'); ok('GET /legal/terms renders inside the Siton shell', legal.status === 200 && legal.text.includes('content-doc') && legal.text.includes('legal-nav'));
  ok('GET /api/preview/meta answers', (await json('/api/preview/meta')).ok === true);
  ok('anonymous admin mutation refused', [401, 403].includes((await fetch(BASE + '/api/admin/site-content/home/draft', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: {}, revision: 0 }) })).status));
  if (cdp) {
    const routes = [['#/content/legal_terms', '[data-testid="content-doc"]', 'legal page'], ['#/content/about', '[data-testid="content-doc"]', 'about page'], ['#/seller', 'form, .panel', 'seller area (login)'], ['#/admin', '.app', 'admin gate'], ['#/deal/00000000-0000-4000-8000-000000000000', '.app', 'public deal (missing id)'], ['#/track/00000000-0000-4000-8000-000000000000?t=x', '.app', 'buyer tracking (invalid link)'], ['#/support', '.app', 'support']];
    for (const [hash, sel, label] of routes) {
      await cdp.open(hash); await cdp.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`); await wait(400);
      ok(`browser: ${label} renders without crash or horizontal overflow`, await cdp.ev('!!document.querySelector("#root")?.children.length') && !(await cdp.ev('document.documentElement.scrollWidth>innerWidth')));
    }
    ok('browser: admin route stays behind the password step-up / login (no content editor exposed)', !(await cdp.ev('!!document.querySelector(\'[data-testid="cms-admin"]\')')));
  }
  console.log(`SITE_CMS_REHEARSAL_PASS base=${BASE} checks=${checks}`);
  if (ws) ws.close(); if (browser) browser.kill();
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { try { spawnSync(process.platform === 'win32' ? 'taskkill' : 'pkill', process.platform === 'win32' ? ['/F', '/IM', 'msedge.exe'] : ['-f', '.tmp_cms_rehearsal_profile'], { stdio: 'ignore' }); } catch {} });
