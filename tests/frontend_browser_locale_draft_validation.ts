import assert from "node:assert/strict";
import { launchPage, chromiumPath } from "./helpers/browser_cdp.js";

// ── LANGUAGE SWITCH MUST NEVER DESTROY WHAT THE VISITOR WROTE ──────────────
//
// Switching language remounts every screen on purpose (App.tsx keys the tree on
// the locale so a modal, a memoised label or an error string already in state
// cannot survive in the old language). That guarantee is kept — and it used to
// cost the visitor everything they had typed.
//
// This suite drives the real React app in a real Chromium and proves, for the
// product's own public form:
//   * a filled form survives he -> en AND en -> he, with the UI in the new
//     language and the visitor's words untouched;
//   * the visitor is offered a choice, and BOTH answers work;
//   * the proposal is editable before it is applied;
//   * several switches never overwrite either language's version;
//   * navigating away and back, and a refresh, keep the text;
//   * an EMPTY form raises no dialog at all;
//   * no raw i18n key and no half-translated screen.

process.env.NODE_ENV = "test";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "100000";
process.env.RATE_LIMIT_READ_MAX = "100000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "100000";
const PORT = 3748;
process.env.PORT = String(PORT);

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

if (!chromiumPath()) {
  console.log("SKIP frontend_browser_locale_draft: no Chromium on this machine");
  process.exit(0);
}
{
  const { existsSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "web", "dist", "index.html"),
    join(here, "..", "..", "web", "dist", "index.html")
  ];
  if (!candidates.some((candidate) => existsSync(candidate))) {
    throw new Error("web/dist is missing — run `npm run --prefix web build` before this suite");
  }
}

const { app } = await import("../src/app.js");
await app.listen({ port: PORT, host: "127.0.0.1" });
const base = `http://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const SET_VALUE_FN = `
  function __setValue(el, v) {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }`;

const HE_TEXT = "זו פנייה ארוכה שכתבתי בעברית ואסור שתימחק כשמחליפים שפה";
const EN_TEXT = "This is the English version I wrote myself in the editable box.";

const page = await launchPage(`${base}/preview/#/support`);

async function waitFor(expression: string, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate<boolean>(expression)) return true;
    await wait(120);
  }
  return false;
}

/** Drafts deliberately outlive a reload, so scenarios clear them explicitly. */
async function clearDrafts() {
  await page.evaluate(`(() => { try { sessionStorage.clear(); } catch (e) {} return true; })()`);
}

async function gotoSupport(fresh = true) {
  const url = fresh ? `${base}/preview/?t=${Date.now()}#/support` : `${base}/preview/#/support`;
  await page.goto(url, { waitMs: 500 });
  const ok = await waitFor(`!!document.querySelector("#support-message")`);
  if (!ok) throw new Error("the support form never rendered");
}

const state = () => page.evaluate<any>(`(() => ({
  dir: document.documentElement.dir,
  lang: document.documentElement.lang,
  message: (document.querySelector("#support-message") || {}).value,
  name: (document.querySelector("#support-name") || {}).value,
  prompt: !!document.querySelector('[data-testid="locale-draft-prompt"]'),
  items: document.querySelectorAll('[data-testid="locale-draft-item"]').length,
  originalShown: (document.querySelector('[data-testid="locale-draft-original"]') || {}).value,
  bodyText: document.body.innerText || ""
}))()`);

const setMessage = (text: string) => page.evaluate(`(() => {
  ${SET_VALUE_FN}
  __setValue(document.querySelector("#support-message"), ${JSON.stringify(text)});
  return true;
})()`);

const setName = (text: string) => page.evaluate(`(() => {
  ${SET_VALUE_FN}
  __setValue(document.querySelector("#support-name"), ${JSON.stringify(text)});
  return true;
})()`);

async function switchTo(locale: "he" | "en") {
  await page.evaluate(`document.querySelector('[data-testid="language-switch-${locale}"]').click()`);
  await wait(1600);
}

const clickKeepOriginal = () =>
  page.evaluate(`document.querySelector('[data-testid="locale-draft-keep-original"]').click()`);
const clickUseTranslation = () =>
  page.evaluate(`document.querySelector('[data-testid="locale-draft-use-translation"]').click()`);
const suggestionValue = () =>
  page.evaluate<string | null>(`(() => { const e = document.querySelector('[data-testid="locale-draft-suggestion"]'); return e ? e.value : null; })()`);
const editSuggestion = (text: string) => page.evaluate(`(() => {
  ${SET_VALUE_FN}
  __setValue(document.querySelector('[data-testid="locale-draft-suggestion"]'), ${JSON.stringify(text)});
  return true;
})()`);

try {
  // ── An empty form must not raise a dialog ────────────────────────────────
  await run("an EMPTY form switches language instantly, with no needless dialog", async () => {
    await clearDrafts();
    await gotoSupport();
    const before = await state();
    assert.equal(before.dir, "rtl", "the support form should start in Hebrew");
    await switchTo("en");
    const after = await state();
    assert.equal(after.dir, "ltr", "the interface did not switch to English");
    assert.equal(after.prompt, false, "an empty form raised a choice dialog it should not have");
    await switchTo("he");
  });

  // ── he -> en with a filled form ──────────────────────────────────────────
  await run("he -> en: the interface changes language and the typed text is NOT lost", async () => {
    await gotoSupport();
    await setName("ישראל ישראלי");
    await setMessage(HE_TEXT);
    await switchTo("en");
    const after = await state();
    assert.equal(after.dir, "ltr", "the interface did not switch to English");
    assert.equal(after.lang, "en", "the document language did not switch");
    assert.equal(after.message, HE_TEXT, "the half-written enquiry was destroyed by the language switch");
    assert.equal(after.name, "ישראל ישראלי", "the name field was destroyed by the language switch");
    assert.equal(after.prompt, true, "no choice was offered for the text the visitor had written");
  });

  await run("the dialog is fully translated: no raw i18n key, no half-translated screen", async () => {
    const after = await state();
    assert.ok(!/locale_draft\./.test(after.bodyText), `a raw i18n key is rendered: ${after.bodyText.slice(0, 200)}`);
    assert.ok(
      after.bodyText.includes("Keep the original text") && after.bodyText.includes("Use the suggested translation"),
      "the dialog is not showing its English copy after switching to English"
    );
    // The visitor's own words are Hebrew and must stay Hebrew — that is content,
    // not interface, and is exactly what must survive. It is shown back in a
    // read-only textarea, whose value innerText never contains.
    assert.equal(after.originalShown, HE_TEXT, "the original text is not shown back to the visitor");
  });

  await run("a person's NAME is never offered for translation, only real prose is", async () => {
    const after = await state();
    assert.equal(after.items, 1, `expected only the message to be offered, got ${after.items} items`);
  });

  // ── Choosing the original ────────────────────────────────────────────────
  await run("choosing KEEP THE ORIGINAL leaves the text exactly as written", async () => {
    await clickKeepOriginal();
    await wait(600);
    const after = await state();
    assert.equal(after.prompt, false, "the dialog stayed open after a choice");
    assert.equal(after.message, HE_TEXT, "keeping the original changed the text");
    assert.equal(after.dir, "ltr", "keeping the original reverted the interface language");
  });

  await run("switching back to Hebrew keeps the text and does not ask again", async () => {
    await switchTo("he");
    const after = await state();
    assert.equal(after.dir, "rtl", "the interface did not switch back to Hebrew");
    assert.equal(after.message, HE_TEXT, "the text was lost switching back");
    assert.equal(after.prompt, false, "the visitor was asked again about a choice already made");
  });

  // ── Editing the proposal, then confirming ────────────────────────────────
  await run("the proposal is EDITABLE and is only applied when the visitor confirms", async () => {
    await clearDrafts();
    await gotoSupport();
    await setMessage(HE_TEXT);
    await switchTo("en");
    assert.equal((await state()).prompt, true, "no dialog for a filled form");
    const prefilled = await suggestionValue();
    assert.equal(prefilled, HE_TEXT, "the proposal should start from the visitor's own words");
    await editSuggestion(EN_TEXT);
    const beforeConfirm = await state();
    assert.equal(beforeConfirm.message, HE_TEXT, "editing the proposal changed the form before confirming");
    await clickUseTranslation();
    await wait(600);
    const after = await state();
    assert.equal(after.prompt, false, "the dialog stayed open after confirming");
    assert.equal(after.message, EN_TEXT, "the edited translation was not applied on confirm");
  });

  // ── Several switches never overwrite either version ──────────────────────
  await run("switching several times never overwrites either language's version", async () => {
    await switchTo("he");
    const inHebrew = await state();
    assert.equal(inHebrew.dir, "rtl");
    assert.equal(inHebrew.message, HE_TEXT, "the Hebrew version was overwritten by the English one");

    await switchTo("en");
    const inEnglish = await state();
    assert.equal(inEnglish.dir, "ltr");
    assert.equal(inEnglish.message, EN_TEXT, "the English version was overwritten by the Hebrew one");

    await switchTo("he");
    const backAgain = await state();
    assert.equal(backAgain.message, HE_TEXT, "a third switch lost the Hebrew version");
  });

  // ── A form filled in ENGLISH, switched to Hebrew ─────────────────────────
  await run("en -> he: a form filled in English survives the switch to Hebrew", async () => {
    await clearDrafts();
    await gotoSupport();
    await switchTo("en");                       // start from an English screen
    assert.equal((await state()).prompt, false, "switching an empty form raised a dialog");
    await setMessage(EN_TEXT);                  // now type in English
    await switchTo("he");
    const after = await state();
    assert.equal(after.dir, "rtl", "the interface did not switch to Hebrew");
    assert.equal(after.message, EN_TEXT, "the English text was destroyed by the switch to Hebrew");
    assert.equal(after.prompt, true, "no choice was offered for the English text");
    assert.equal(after.originalShown, EN_TEXT, "the English original is not shown back");
    await clickKeepOriginal();
    await wait(600);
    assert.equal((await state()).message, EN_TEXT, "keeping the original changed the English text");
  });

  // ── Navigation away and back ─────────────────────────────────────────────
  //
  // SCOPE, stated plainly: a draft is created when the language changes (or
  // when a version is chosen). Text typed into a form with no language switch
  // at all is ordinary component state and is NOT persisted here — doing that
  // would be global form autosave, which would write every buyer's typed name,
  // e-mail and phone into browser storage on every screen. That is a separate
  // product and privacy decision, not something this change should make
  // silently. What this feature owes the visitor is that once their words have
  // been taken into the draft store, nothing afterwards loses them.
  await run("after a switch, leaving the screen and coming back restores the text", async () => {
    await clearDrafts();
    await gotoSupport();
    await setMessage(HE_TEXT);
    await switchTo("en");
    await clickKeepOriginal();
    await wait(600);
    assert.equal((await state()).message, HE_TEXT, "precondition: the text should be on screen");

    await page.evaluate(`location.hash = "#/mall"`);
    await wait(900);
    await page.evaluate(`location.hash = "#/support"`);
    await wait(300);
    const ok = await waitFor(`!!document.querySelector("#support-message")`);
    assert.ok(ok, "the support form did not come back");
    const restored = await waitFor(
      `(document.querySelector("#support-message")||{}).value === ${JSON.stringify(HE_TEXT)}`,
      8000
    );
    assert.ok(restored, `the text was not restored after navigating back: ${JSON.stringify((await state()).message)}`);
  });

  // ── Refresh ──────────────────────────────────────────────────────────────
  await run("after a switch, a refresh keeps the text (the draft outlives a reload)", async () => {
    await page.reload({ waitMs: 1200 });
    const ok = await waitFor(`!!document.querySelector("#support-message")`);
    assert.ok(ok, "the support form did not render after the reload");
    const restored = await waitFor(
      `(document.querySelector("#support-message")||{}).value === ${JSON.stringify(HE_TEXT)}`,
      8000
    );
    assert.ok(restored, `the text did not survive the refresh: ${JSON.stringify((await state()).message)}`);
  });

  // ── Refresh AFTER choosing a version keeps the chosen version ────────────
  await run("a refresh after choosing a version keeps the version that was chosen", async () => {
    // The previous scenario left the interface in English; this one needs a
    // Hebrew starting point for the switch to be a real change.
    await switchTo("he");
    await clearDrafts();
    await gotoSupport();
    await setMessage(HE_TEXT);
    await switchTo("en");
    assert.equal((await state()).prompt, true, "no dialog for a filled form");
    await editSuggestion(EN_TEXT);
    await clickUseTranslation();
    await wait(600);
    assert.equal((await state()).message, EN_TEXT, "the chosen version was not applied");
    await page.reload({ waitMs: 1200 });
    const ok = await waitFor(`!!document.querySelector("#support-message")`);
    assert.ok(ok, "the support form did not render after the reload");
    const kept = await waitFor(
      `(document.querySelector("#support-message")||{}).value === ${JSON.stringify(EN_TEXT)}`,
      8000
    );
    assert.ok(kept, `the chosen version did not survive the refresh: ${JSON.stringify((await state()).message)}`);
  });

} finally {
  await page.close().catch(() => undefined);
  await app.close().catch(() => undefined);
}

console.log(`SUMMARY frontend_browser_locale_draft passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
