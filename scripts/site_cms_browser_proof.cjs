// SITE CMS — local browser proof of the real React components with deterministic
// API fixtures (same harness as receipt_content_browser_proof.cjs).
//   * public landing renders the PUBLISHED blocks in order, hides a disabled
//     block, shows the persisted FAQ and the CMS hero image, no overflow
//   * preview mode (per-tab flag) shows the DRAFT with the banner; leaving it
//     returns to the published content
//   * the admin editor: page choice, text edit, image replace, FAQ add / delete /
//     reorder, block reorder / hide, draft save, publish, discard, 409 conflict,
//     no horizontal overflow at 320 / 390 / 768 / 1440
// Authorization and persistence are proven separately by
// tests/site_content_cms_validation.ts on a real database.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const { build } = require('../web/node_modules/esbuild');
const EDGE = [process.env.BROWSER_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome', '/opt/pw-browsers/chromium'].filter(Boolean).find(fs.existsSync);
if (!EDGE) throw Error('A Chromium browser is required for the visual proof');
const wait = ms => new Promise(r => setTimeout(r, ms));
const fixture = `
import React from 'react'; import {createRoot} from 'react-dom/client';
import App from './src/App';
import { ContentAdmin } from './src/pages/contentAdmin';
import { PAGE_CONTRACTS, contractFor } from './src/content/cmsTemplates';
const IMG = '/api/content-assets/33333333-3333-4333-8333-333333333333';
const clone = v => JSON.parse(JSON.stringify(v));
const published = { blocks: PAGE_CONTRACTS.home.defaults() };
published.blocks[0].fields.title = 'כותרת מפורסמת';
published.blocks[0].fields.image = IMG;
published.blocks.find(b => b.id === 'trust').enabled = false;
const faq = published.blocks.find(b => b.id === 'faq');
faq.items = [{ q: 'שאלה ראשונה?', a: 'תשובה ראשונה.' }, { q: 'שאלה שנייה?', a: 'תשובה שנייה.' }, { q: 'שאלה שלישית?', a: 'תשובה שלישית.' }];
const draft = clone(published); draft.blocks[0].fields.title = 'כותרת טיוטה';
const state = { home: { label: 'דף הבית', description: '', contract: { locked: PAGE_CONTRACTS.home.locked, addable: PAGE_CONTRACTS.home.addable, maxBlocks: 20 }, published, draft: null, revision: 3, updated_at: null, updated_by: null, draft_updated_at: null, draft_updated_by: null, published_at: '2026-09-16T10:00:00Z' },
  about: { label: 'אודות', description: '', contract: { locked: PAGE_CONTRACTS.about.locked, addable: [], maxBlocks: 1 }, published: { blocks: PAGE_CONTRACTS.about.defaults() }, draft: null, revision: 0 },
  footer: { label: 'תחתית האתר', description: '', contract: { locked: PAGE_CONTRACTS.footer.locked, addable: [], maxBlocks: 1 }, published: { blocks: PAGE_CONTRACTS.footer.defaults() }, draft: null, revision: 0 },
  legal_terms: { label: 'תקנון', description: '', contract: { locked: contractFor('legal_terms').locked, addable: [], maxBlocks: 1 }, published: { blocks: [{ id: 'document', type: 'legal', enabled: true, fields: { title: 'תקנון ותנאי שימוש', body: '# תקנון\\n\\n## מידע לקונים\\n\\nתוכן משפטי בתוך עיצוב האתר\\n\\n- סעיף\\n- סעיף שני' } }] }, draft: null, revision: 0 } };
for (const key of ['deal_page', 'seller_area', 'support_page']) {
  const c = PAGE_CONTRACTS[key];
  state[key] = { label: c.label, description: c.description, contract: { locked: c.locked, addable: c.addable, maxBlocks: c.maxBlocks }, published: { blocks: c.defaults() }, draft: null, revision: 1, updated_at: null, updated_by: null, draft_updated_at: null, draft_updated_by: null, published_at: null };
}
window.cms = { state, published, draft, saved: [], conflictNext: false, adminOk: true };
const publicShape = mode => Object.fromEntries(Object.entries(state).map(([k, s]) => [k, { blocks: (mode === 'preview' && s.draft ? s.draft : s.published).blocks }]));
window.fetch = async (url, init = {}) => {
  const p = String(url); const body = init.body ? JSON.parse(init.body) : {};
  const method = init.method || 'GET';
  let data = { ok: true }, status = 200;
  if (method !== 'GET') window.cms.saved.push({ url: p, body });
  if (p === '/api/preview/meta') data = { ok: true, public_mall_enabled: false, landing_hero_video_enabled: false };
  else if (p === '/api/site-content') data = { ok: true, content: publicShape('published') };
  else if (p === '/api/admin/site-content/preview') { if (!window.cms.adminOk) { status = 401; data = { ok: false, error: 'admin_auth_required' }; } else data = { ok: true, content: publicShape('preview') }; }
  else if (p === '/api/admin/site-content') data = { ok: true, sections: state };
  else if (/^\\/api\\/admin\\/site-content\\/(\\w+)\\/(draft|publish|discard)$/.test(p)) {
    const [, key, action] = p.match(/^\\/api\\/admin\\/site-content\\/(\\w+)\\/(draft|publish|discard)$/);
    const s = state[key];
    if (window.cms.conflictNext || body.revision !== s.revision) { window.cms.conflictNext = false; status = 409; data = { ok: false, error: 'content_changed_reload' }; }
    else { s.revision++; if (action === 'draft') s.draft = body.value; if (action === 'publish') { s.published = s.draft; s.draft = null; s.published_at = new Date().toISOString(); } if (action === 'discard') s.draft = null; data = { ok: true, sections: state }; }
  }
  else if (p === '/api/admin/content-assets') data = { ok: true, asset_id: '44444444-4444-4444-8444-444444444444', url: '/api/content-assets/44444444-4444-4444-8444-444444444444', mime_type: body.mime_type };
  else if (p.startsWith('/api/auth')) data = { ok: true };
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
};
const root = createRoot(document.getElementById('root'));
// the admin shell is a two-column grid (nav + main); the fixture renders the
// same structure so widths and overflow match the real #/admin/content screen
window.show = view => root.render(view === 'admin'
  ? <div className="app"><div className="admin-shell">
      <nav className="admin-nav" aria-label="ניווט ניהול"><div className="admin-nav-title">C-ton · ניהול</div><button className="active">ניהול תוכן האתר</button></nav>
      <main className="admin-main"><ContentAdmin/></main>
    </div></div>
  : <App/>);
window.show('site');
`;
async function main() {
  const built = await build({ stdin: { contents: fixture, resolveDir: path.resolve('web'), loader: 'tsx' }, bundle: true, write: false, format: 'iife', define: { 'import.meta.env': '{}', 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const js = built.outputFiles[0].text;
  const html = '<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/fixture.js"></script></html>';
  const logo = fs.readFileSync('web/public/brand/c-ton-logo-1024.jpg');
  const server = createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u.startsWith('/brand/') || u.startsWith('/api/content-assets/')) { res.setHeader('Content-Type', 'image/jpeg'); return res.end(logo); }
    const type = u === '/fixture.js' ? 'application/javascript' : u === '/style.css' ? 'text/css' : 'text/html';
    res.setHeader('Content-Type', type + '; charset=utf-8'); res.end(u === '/fixture.js' ? js : u === '/style.css' ? Buffer.concat([fs.readFileSync('web/src/styles.css'), fs.readFileSync('web/src/cms.css')]) : html);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const debugPort = 38474;
  const browser = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.resolve('.tmp_cms_browser_profile')}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let ws; let checks = 0;
  try {
    let page;
    for (let i = 0; i < 80; i++) { try { page = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(p => p.type === 'page'); if (page) break; } catch {} await wait(200); }
    if (!page) throw Error('Browser unavailable');
    ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let seq = 0; const pending = new Map(); ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
    const ev = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; };
    const waitFor = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return; await wait(60); } throw Error(`timeout waiting for ${expr}`); };
    const check = (name, ok, detail = '') => { assert.ok(ok, `${name} ${detail}`); checks++; console.log(`PASS ${name}`); };
    const click = sel => ev(`document.querySelector('${sel}').click()`);
    const type = (sel, text) => ev(`(()=>{const el=document.querySelector('${sel}');const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const overflow = () => ev('document.documentElement.scrollWidth>innerWidth');
    await send('Page.enable'); await send('Page.navigate', { url: `http://127.0.0.1:${port}/#/` });
    await waitFor('!!document.querySelector(".landing")');
    // confirm() must never block the headless run
    await ev('window.confirm = () => true');
    for (const width of [320, 390, 768, 1440]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 500 });
      await ev('window.show("site")'); await waitFor('!!document.querySelector(".landing") && document.querySelector(".landing-title").innerText.includes("כותרת מפורסמת")');
      const order = await ev(`[...document.querySelectorAll('[data-testid^="landing-block-"]')].map(e => e.dataset.testid.replace('landing-block-',''))`);
      check(`landing @${width}: published blocks render in stored order`, JSON.stringify(order) === JSON.stringify(['hero', 'how', 'audiences', 'faq', 'contact']), JSON.stringify(order));
      check(`landing @${width}: the disabled block (trust) and the empty-body blocks are absent`, !order.includes('trust') && !order.includes('why') && !order.includes('about'));
      check(`landing @${width}: persisted FAQ (3 questions) and CMS hero image`, await ev(`document.querySelector('[data-testid="landing-faq"]').dataset.faqCount === '3' && document.querySelector('[data-testid="hero-medium"]').dataset.heroFromCms === '1' && document.querySelectorAll('[data-testid="hero-medium"]').length === 1`));
      check(`landing @${width}: footer links from the CMS`, (await ev(`document.querySelectorAll('[data-testid="site-footer"] a').length`)) === 5);
      check(`landing @${width}: no horizontal overflow`, !(await overflow()));
      // preview mode: the draft, banner, and exit
      await ev('sessionStorage.setItem("siton_cms_preview_v1","1"); window.cms.state.home.draft = window.cms.draft; window.dispatchEvent(new Event("siton-cms-preview"))');
      await waitFor('document.querySelector(".landing-title") && document.querySelector(".landing-title").innerText.includes("כותרת טיוטה")');
      check(`preview @${width}: draft title with the preview banner`, await ev(`!!document.querySelector('[data-testid="cms-preview-banner"]') && document.querySelector('[data-testid="cms-preview-banner"]').dataset.preview === '1'`));
      check(`preview @${width}: no overflow with the banner`, !(await overflow()));
      await click('[data-testid="cms-preview-exit"]');
      await waitFor('document.querySelector(".landing-title").innerText.includes("כותרת מפורסמת")');
      check(`preview @${width}: leaving preview restores the published content`, !(await ev('!!document.querySelector(\'[data-testid="cms-preview-banner"]\')')));
      // preview refused (no admin): published content, honest banner
      await ev('sessionStorage.setItem("siton_cms_preview_v1","1"); window.cms.adminOk = false; window.dispatchEvent(new Event("siton-cms-preview"))');
      await waitFor('document.querySelector(\'[data-testid="cms-preview-banner"]\') && document.querySelector(\'[data-testid="cms-preview-banner"]\').dataset.preview === "0"');
      check(`preview @${width}: an unauthenticated preview falls back to the published site`, await ev('document.querySelector(".landing-title").innerText.includes("כותרת מפורסמת")'));
      await ev('window.cms.adminOk = true; sessionStorage.removeItem("siton_cms_preview_v1"); window.cms.state.home.draft = null; window.dispatchEvent(new Event("siton-cms-preview"))');
      await wait(100);
      // legal document through the shell
      await ev('location.hash = "#/content/legal_terms"'); await waitFor('!!document.querySelector(\'[data-testid="content-doc"]\') && document.querySelectorAll(\'[data-testid="content-doc"] h2\').length === 1');
      check(`legal @${width}: document renders title, heading and list from the block`, (await ev(`document.querySelectorAll('[data-testid="content-doc"] li').length`)) === 2 && !(await overflow()));
      await ev('location.hash = "#/"'); await wait(50);
      // admin editor
      await ev('window.show("admin")'); await waitFor('!!document.querySelector(\'[data-testid="cms-block-hero"]\')');
      check(`admin @${width}: pages listed, home blocks shown as cards in order`, JSON.stringify(await ev(`[...document.querySelectorAll('[data-testid^="cms-block-"]')].filter(e=>/^cms-block-[a-z_0-9]+$/.test(e.dataset.testid)).map(e=>e.dataset.testid.replace('cms-block-',''))`)) === JSON.stringify(['hero', 'how', 'why', 'audiences', 'trust', 'about', 'faq', 'contact']) && (await ev(`document.querySelectorAll('[data-testid^="cms-page-"]').length`)) === 7);
      check(`admin @${width}: no horizontal overflow`, !(await overflow()));
      if (width === 390 || width === 1440) { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`.tmp_cms_admin_${width}.png`, Buffer.from(shot.data, 'base64')); }
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await ev('window.show("site")'); await wait(50); await ev('window.show("admin")'); await waitFor('!!document.querySelector(\'[data-testid="cms-block-hero"]\')');
    check('editor: hero is locked (no remove / hide controls) and cannot move', await ev(`!document.querySelector('[data-testid="cms-block-remove-hero"]') && !document.querySelector('[data-testid="cms-block-enabled-hero"]') && document.querySelector('[data-testid="cms-block-up-hero"]').disabled && document.querySelector('[data-testid="cms-block-down-hero"]').disabled`));
    check('editor: publish disabled until something changes; hero title preloaded', await ev(`document.querySelector('[data-testid="cms-publish"]').disabled && document.querySelector('[data-testid="cms-field-hero-title"]').value === 'כותרת מפורסמת'`));
    await type('[data-testid="cms-field-hero-title"]', 'כותרת חדשה מהעורך');
    check('editor: editing marks the page dirty', await ev(`document.querySelector('[data-testid="cms-status"]').dataset.dirty === '1'`));
    // FAQ: add, edit, reorder, delete
    await click('[data-testid="cms-item-add-faq"]'); await wait(30);
    await type('[data-testid="cms-item-faq-3-q"]', 'שאלה רביעית?'); await type('[data-testid="cms-item-faq-3-a"]', 'תשובה רביעית.');
    await click('[data-testid="cms-item-up-faq-3"]'); await wait(30);
    await click('[data-testid="cms-item-remove-faq-0"]'); await wait(30);
    const faqQs = await ev(`[...document.querySelectorAll('[data-testid^="cms-item-faq-"][data-testid$="-q"]')].map(e=>e.value)`);
    check('editor: FAQ add + reorder + delete reflected in the form', JSON.stringify(faqQs) === JSON.stringify(['שאלה שנייה?', 'שאלה רביעית?', 'שאלה שלישית?']), JSON.stringify(faqQs));
    // block reorder + hide + remove
    await click('[data-testid="cms-block-up-faq"]'); await wait(30);
    await ev(`document.querySelector('[data-testid="cms-block-enabled-how"]').click()`); await wait(30);
    await click('[data-testid="cms-block-remove-why"]'); await wait(30);
    // image replace through the real file input (optimizer + upload)
    await ev(`(async()=>{const bytes=await (await fetch('/brand/c-ton-logo-1024.jpg')).blob();const file=new File([bytes],'hero.jpg',{type:'image/jpeg'});const dt=new DataTransfer();dt.items.add(file);const input=document.querySelector('#cms-field-hero-image-file');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(`document.querySelector('[data-testid="cms-field-hero-image-preview"]').getAttribute('src') === '/api/content-assets/44444444-4444-4444-8444-444444444444'`);
    check('editor: image replaced through an admin upload', (await ev(`window.cms.saved.find(s=>s.url==='/api/admin/content-assets').body.mime_type`)).startsWith('image/'));
    // save draft → PUT draft; public untouched
    await click('[data-testid="cms-save-draft"]'); await waitFor(`document.querySelector('[data-testid="cms-message"]').innerText.includes('הטיוטה נשמרה')`);
    const saved = await ev(`window.cms.saved.filter(s=>s.url.endsWith('/draft')).at(-1).body`);
    check('editor: draft saved with the full block page (title, FAQ, order, hidden block, removed block, image)',
      saved.revision === 3 && saved.value.blocks[0].fields.title === 'כותרת חדשה מהעורך' && saved.value.blocks[0].fields.image.endsWith('44444444') &&
      saved.value.blocks.map(b => b.id).join(',') === 'hero,how,audiences,trust,faq,about,contact' &&
      saved.value.blocks.find(b => b.id === 'how').enabled === false && !saved.value.blocks.some(b => b.id === 'why') &&
      saved.value.blocks.find(b => b.id === 'faq').items.map(i => i.q).join('|') === 'שאלה שנייה?|שאלה רביעית?|שאלה שלישית?', JSON.stringify(saved.value.blocks.map(b => b.id)));
    check('editor: public content untouched by the draft', await ev(`window.cms.state.home.published.blocks[0].fields.title === 'כותרת מפורסמת'`));
    // conflict: another admin changed it meanwhile
    await ev('window.cms.conflictNext = true');
    await type('[data-testid="cms-field-hero-title"]', 'עריכה נוספת');
    await click('[data-testid="cms-save-draft"]'); await waitFor(`document.querySelector('[data-testid="cms-message"]').innerText.includes('מנהל אחר')`);
    check('editor: a stale revision is refused and explained, never silently overwritten', await ev(`window.cms.state.home.draft.blocks[0].fields.title === 'כותרת חדשה מהעורך'`));
    // preview opens a new tab with the flag
    await ev('window.__opened=[]; window.open = (u, n) => { window.__opened.push(u); return null; }');
    await click('[data-testid="cms-preview"]'); await waitFor(`window.__opened.length === 1`);
    check('editor: preview opens the site with the per-tab preview flag', (await ev('window.__opened[0]')).endsWith('#/?cms_preview=1'));
    // publish
    await click('[data-testid="cms-publish"]'); await waitFor(`document.querySelector('[data-testid="cms-message"]').innerText.includes('פורסם')`);
    check('editor: publish moved the draft to the public page', await ev(`window.cms.state.home.published.blocks[0].fields.title === 'עריכה נוספת' && window.cms.state.home.draft === null && document.querySelector('[data-testid="cms-publish"]').disabled`));
    await ev('window.show("site")'); await waitFor('document.querySelector(".landing-title") && document.querySelector(".landing-title").innerText.includes("עריכה נוספת")');
    check('landing: shows the newly published content with the hidden and removed blocks gone', JSON.stringify(await ev(`[...document.querySelectorAll('[data-testid^="landing-block-"]')].map(e => e.dataset.testid.replace('landing-block-',''))`)) === JSON.stringify(['hero', 'audiences', 'faq', 'contact']));
    // discard
    await ev('window.show("admin")'); await waitFor('!!document.querySelector(\'[data-testid="cms-block-hero"]\')');
    await type('[data-testid="cms-field-hero-title"]', 'טיוטה לביטול'); await click('[data-testid="cms-save-draft"]'); await waitFor(`document.querySelector('[data-testid="cms-status"]').dataset.hasDraft === '1'`);
    await click('[data-testid="cms-discard"]'); await waitFor(`document.querySelector('[data-testid="cms-status"]').dataset.hasDraft === '0'`);
    check('editor: discard drops the draft and reloads the published page', await ev(`document.querySelector('[data-testid="cms-field-hero-title"]').value === 'עריכה נוספת'`));
    // switching pages: legal editor shows the single locked document block
    await click('[data-testid="cms-page-legal_terms"]'); await waitFor('!!document.querySelector(\'[data-testid="cms-block-document"]\')');
    check('editor: legal page is a single locked document template without an add-block library', await ev(`!document.querySelector('[data-testid="cms-add-block"]') && !document.querySelector('[data-testid="cms-block-remove-document"]') && document.querySelector('[data-testid="cms-field-document-body"]').tagName === 'TEXTAREA'`));
    await click('[data-testid="cms-page-home"]'); await waitFor('!!document.querySelector(\'[data-testid="cms-add-block"]\')');
    await ev(`(()=>{const el=document.querySelector('[data-testid="cms-add-block"] select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,'image_text');el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await click('[data-testid="cms-add-block-confirm"]'); await waitFor('!!document.querySelector(\'[data-testid="cms-block-image_text_1"]\')');
    check('editor: a block from the template library can be added to the home page', await ev(`document.querySelector('[data-testid="cms-block-image_text_1"]').dataset.blockType === 'image_text'`));
    // ── product-copy pages: deal / tracking, seller area, support ───────────
    await ev('window.show("admin")'); await waitFor('!!document.querySelector(\'[data-testid="cms-page-deal_page"]\')');
    check('editor: the product surfaces are offered as content pages',
      await ev(`['deal_page','seller_area','support_page'].every(k => !!document.querySelector('[data-testid="cms-page-'+k+'"]'))`));
    await click('[data-testid="cms-page-deal_page"]'); await waitFor('!!document.querySelector(\'[data-testid="cms-block-deal"]\')');
    check('editor: the deal page shows its locked copy blocks and offers no block library',
      await ev(`['deal','how','track'].every(id => document.querySelector('[data-testid="cms-block-'+id+'"]')) && !document.querySelector('[data-testid="cms-add-block"]')`));
    check('editor: the locked copy blocks cannot be hidden, removed or moved',
      await ev(`['deal','how','track'].every(id => !document.querySelector('[data-testid="cms-block-enabled-'+id+'"]') && document.querySelector('[data-testid="cms-block-up-'+id+'"]').disabled)`));
    check('editor: the fixed sentences are preloaded for editing',
      await ev(`document.querySelector('[data-testid="cms-field-deal-explainer"]').value.includes('קנייה קבוצתית')`));
    // in-editor preview (a deal page has no standalone admin URL)
    await click('[data-testid="cms-preview"]'); await waitFor('!!document.querySelector(\'[data-testid="cms-copy-preview"]\')');
    check('editor: the deal copy previews inside the editor, in context',
      await ev(`document.querySelector('[data-testid="cms-copy-preview"]').innerText.includes('קנייה קבוצתית')`));
    for (const width of [390, 1440]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: width < 500 });
      await wait(120);
      check(`editor @${width}: the product-copy editor has no horizontal overflow`, !(await overflow()));
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(`.tmp_cms_deal_page_${width}.png`, Buffer.from(shot.data, 'base64'));
    }
    // edit → draft → publish
    await type('[data-testid="cms-field-deal-explainer"]', 'הסבר חדש לקונים: משלמים רק אם הקבוצה נסגרת.');
    await click('[data-testid="cms-save-draft"]'); await waitFor(`document.querySelector('[data-testid="cms-status"]').dataset.hasDraft === '1'`);
    check('editor: the deal copy draft is stored without touching the public site',
      await ev(`window.cms.state.deal_page.draft.blocks.find(b=>b.id==='deal').fields.explainer.includes('הסבר חדש') && window.cms.state.deal_page.published.blocks.find(b=>b.id==='deal').fields.explainer.includes('קנייה קבוצתית: המחיר')`));
    await click('[data-testid="cms-publish"]'); await waitFor(`document.querySelector('[data-testid="cms-message"]').innerText.includes('פורסם')`);
    check('editor: publishing the deal copy moves it to the public content',
      await ev(`window.cms.state.deal_page.published.blocks.find(b=>b.id==='deal').fields.explainer.includes('הסבר חדש') && window.cms.state.deal_page.draft === null`));
    // the support page is a real public route: the published copy renders there
    await click('[data-testid="cms-page-support_page"]'); await waitFor('!!document.querySelector(\'[data-testid="cms-block-support"]\')');
    await type('[data-testid="cms-field-support-title"]', 'מוקד התמיכה של C-ton');
    await click('[data-testid="cms-save-draft"]'); await waitFor(`document.querySelector('[data-testid="cms-status"]').dataset.hasDraft === '1'`);
    await click('[data-testid="cms-publish"]'); await waitFor(`document.querySelector('[data-testid="cms-message"]').innerText.includes('פורסם')`);
    // stay in the same document: a reload would rebuild the fixture state and
    // discard the publish this check is about
    await ev('window.location.hash = "#/support"; window.show("site")');
    await waitFor('!!document.querySelector(".panel h2")');
    check('support page: the published CMS title is what the visitor reads',
      await ev(`[...document.querySelectorAll('.panel h2')].some(h => h.innerText.includes('מוקד התמיכה של C-ton'))`));
    check('support page: no horizontal overflow after the content change', !(await overflow()));
    console.log(`SITE_CMS_BROWSER_PROOF_PASS checks=${checks}`);
  } finally { if (ws) ws.close(); browser.kill(); await new Promise(r => server.close(r)); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
