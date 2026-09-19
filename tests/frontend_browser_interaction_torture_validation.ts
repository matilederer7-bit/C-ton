import assert from "node:assert/strict";
import { launchPage, chromiumPath } from "./helpers/browser_cdp.js";

// RED TEAM §5 — BROWSER TORTURE, in a real Chromium.
//
// The existing browser suites prove the routes RENDER (13 routes x 2 viewports,
// one h1, no overflow, no failed requests) and that the bilingual layer holds.
// What no suite drove is the INTERACTION torture: a double-click on a real
// submit button, a language switch in the middle of a half-filled form, and
// browser back/forward. Those are the shapes that produce duplicate orders and
// lost work in the field, so they are driven here against a real page rather
// than reasoned about from JSX.
//
// The public support form is the target: it is reachable with no session, it
// POSTs, and its submit button carries the same `disabled={busy}` guard (plus
// the matching `if (busy) return` in the handler) that the money-committing
// controls use — so it is a faithful stand-in for the guard pattern the whole
// product relies on.
//
// NOTE ON WHAT "DOUBLE-CLICK" MEANS HERE. Two `.click()` calls in the SAME
// JavaScript task both observe the pre-render `busy === false` closure and both
// submit — but no human can produce that, and a script that wants two
// submissions can simply send two HTTP requests, where a client-side guard is
// irrelevant by definition. The honest question is whether a REAL double-click
// — two separate events a few tens of milliseconds apart, with React's discrete
// -event flush in between — is deduplicated. That is what this suite asserts.

process.env.NODE_ENV = "test";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "100000";
process.env.RATE_LIMIT_READ_MAX = "100000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "100000";
const PORT = 3742;
process.env.PORT = String(PORT);

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

if (!chromiumPath()) {
  console.log("SKIP frontend_browser_interaction_torture: no Chromium on this machine");
  process.exit(0);
}

// Same precondition, and the same clear message, as the other browser suites:
// this one drives the real React app served from web/dist under /preview.
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

// React controls these inputs, so a bare `.value =` is discarded on re-render.
// Go through the native setter and fire the event React listens for.
const SET_VALUE_FN = `
  function __setValue(el, v) {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }`;

const page = await launchPage(`${base}/preview/#/support`);

/** A genuinely fresh support screen: a full document load, then the form. */
async function freshSupportForm() {
  // A cache-busting query forces a real document load, so React state from the
  // previous case (including a "sent" confirmation) cannot leak into this one.
  await page.goto(`${base}/preview/?t=${Date.now()}#/support`, { waitMs: 500 });
  for (let i = 0; i < 80; i++) {
    const ready = await page.evaluate<boolean>(`!!document.querySelector("#support-message")`);
    if (ready) return;
    await wait(150);
  }
  throw new Error("the support form never rendered");
}

async function fillSupportForm() {
  await page.evaluate(`(() => {
    ${SET_VALUE_FN}
    __setValue(document.querySelector("#support-name"), "בודק כפילות");
    __setValue(document.querySelector("#support-email"), "double@example.invalid");
    __setValue(document.querySelector("#support-message"), "הודעת בדיקה לכפילות שליחה");
    return true;
  })()`);
}

async function instrumentSupportPosts() {
  await page.evaluate(`(() => {
    window.__posts = 0;
    if (window.__instrumented) return true;
    window.__instrumented = true;
    const original = window.fetch;
    window.fetch = function (...args) {
      try {
        const url = String((args[0] && args[0].url) || args[0] || "");
        const method = String((args[1] && args[1].method) || (args[0] && args[0].method) || "GET").toUpperCase();
        if (method === "POST" && url.indexOf("/api/support") !== -1) window.__posts++;
      } catch (e) {}
      return original.apply(this, args);
    };
    return true;
  })()`);
}

try {
  await freshSupportForm();

  await run("VACUITY GUARD: the public support form is really on screen and submittable", async () => {
    const shape = await page.evaluate<any>(`(() => {
      const form = document.querySelector("form");
      return {
        hasForm: !!form,
        hasMessage: !!document.querySelector("#support-message"),
        hasSubmit: !!(form && form.querySelector("button.btn-primary"))
      };
    })()`);
    assert.ok(shape.hasForm, "no support form rendered");
    assert.ok(shape.hasMessage, "no message field rendered");
    assert.ok(shape.hasSubmit, "no submit button rendered");
  });

  await run("VACUITY GUARD: a single click really does submit (one POST)", async () => {
    await freshSupportForm();
    await instrumentSupportPosts();
    await fillSupportForm();
    await page.evaluate(`document.querySelector("form button.btn-primary").click()`);
    await wait(1200);
    const posts = await page.evaluate<number>(`window.__posts`);
    assert.equal(posts, 1, `a single click should send exactly one submission, sent ${posts}`);
  });

  await run("§5 a REAL double-click (two events, 60ms apart) sends at most ONE request", async () => {
    await freshSupportForm();
    await instrumentSupportPosts();
    await fillSupportForm();
    await page.evaluate(`document.querySelector("form button.btn-primary").click()`);
    await wait(60); // a human double-click interval, with React's flush in between
    await page.evaluate(`(() => {
      const btn = document.querySelector("form button.btn-primary");
      if (btn) btn.click();
      return true;
    })()`);
    await wait(1500);
    const posts = await page.evaluate<number>(`window.__posts`);
    assert.ok(
      posts <= 1,
      `a real double-click produced ${posts} support submissions — the busy guard did not hold between events`
    );
  });

  // RECORDED BEHAVIOUR, NOT ASSERTED EITHER WAY (red-team §5).
  //
  // Switching language mid-form DISCARDS everything the user has typed. Proven
  // in this browser: a support enquiry with name "שם בודק" and a long message
  // came back as `name: ""`, `message: ""` after one click on "English", on the
  // same route (`#/support`), with the form still on screen — just empty.
  //
  // This is NOT an oversight and is deliberately not "fixed" here.
  // `web/src/App.tsx` keys the whole tree on the locale
  // (`<AppTree key={locale} …>`) and says why: `t()` alone would re-render, but
  // a modal built before the switch, a memoised label, an error string already
  // in state or a formatted date in a ref would all survive in the previous
  // language — "remounting makes a half-translated screen impossible". Removing
  // the key to save the draft would reintroduce exactly the half-translated
  // screen that guard exists to prevent.
  //
  // So the cost is real (a long enquiry, or a half-built deal in the seller
  // wizard, is lost with no warning) but the trade-off is the owner's to make:
  // keep the remount, or keep it AND persist in-progress drafts across it. This
  // case therefore asserts only what is unambiguously required — the switch
  // works, the direction flips, and the form is still usable afterwards — and
  // deliberately asserts nothing about the draft, so neither outcome is blessed
  // by a passing test.
  await run("§5 switching language mid-form flips direction and leaves a usable form", async () => {
    await freshSupportForm();
    const typed = "טיוטה שהמשתמש כתב לפני החלפת שפה";
    await page.evaluate(`(() => {
      ${SET_VALUE_FN}
      __setValue(document.querySelector("#support-message"), ${JSON.stringify(typed)});
      return true;
    })()`);
    const before = await page.evaluate<string>(`document.querySelector("#support-message").value`);
    assert.equal(before, typed, "the draft did not land in the field");

    const switched = await page.evaluate<boolean>(`(() => {
      const candidates = Array.from(document.querySelectorAll("button, a"));
      const target = candidates.find((el) => /^\\s*(English|אנגלית|EN)\\s*$/i.test(el.textContent || ""));
      if (!target) return false;
      target.click();
      return true;
    })()`);
    assert.ok(switched, "no language control found on the support page");
    await wait(1000);

    const after = await page.evaluate<any>(`(() => ({
      dir: document.documentElement.dir,
      hash: location.hash,
      formPresent: !!document.querySelector("form"),
      messagePresent: !!document.querySelector("#support-message")
    }))()`);
    assert.equal(after.dir, "ltr", "switching to English did not flip direction");
    assert.match(after.hash, /#\/support/, "the language switch navigated away from the form");
    assert.ok(after.formPresent && after.messagePresent, "the form is not usable after the language switch");
  });

  await run("§5 the language choice survives a reload", async () => {
    await page.reload({ waitMs: 1000 });
    for (let i = 0; i < 60; i++) {
      const d = await page.evaluate<string>(`document.documentElement.dir`);
      if (d === "ltr") break;
      await wait(150);
    }
    const dir = await page.evaluate<string>(`document.documentElement.dir`);
    assert.equal(dir, "ltr", "the English choice did not survive a reload");
  });

  await run("§5 browser BACK and FORWARD land on the right screens with no console error", async () => {
    await freshSupportForm();
    page.clearErrors();
    await page.evaluate(`location.hash = "#/mall"`);
    await wait(800);
    await page.evaluate(`history.back()`);
    await wait(800);
    const backHash = await page.evaluate<string>(`location.hash`);
    assert.match(backHash, /#\/support/, `back did not return to the support route (got ${backHash})`);

    await page.evaluate(`history.forward()`);
    await wait(800);
    const fwdHash = await page.evaluate<string>(`location.hash`);
    assert.match(fwdHash, /#\/mall/, `forward did not return to the mall route (got ${fwdHash})`);

    const rendered = await page.evaluate<number>(`document.querySelector("#root")?.childElementCount || 0`);
    assert.ok(rendered > 0, "the app rendered nothing after back/forward");
    const errors = page.errors().filter((e) => !/favicon|fonts\.googleapis|fonts\.gstatic/i.test(e.text));
    assert.deepEqual(errors, [], `back/forward produced errors: ${JSON.stringify(errors)}`);
  });
} finally {
  await page.close().catch(() => undefined);
  await app.close().catch(() => undefined);
}

console.log(`SUMMARY frontend_browser_interaction_torture passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
