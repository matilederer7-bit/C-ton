import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

const [indexHtml, stylesCss, appJs] = await Promise.all([
  readFile("frontend/index.html", "utf8"),
  readFile("frontend/styles.css", "utf8"),
  readFile("frontend/app.js", "utf8")
]);

await run("rtl root and skip link are defined", async () => {
  assert.match(indexHtml, /<html[^>]*lang="he"[^>]*dir="rtl"/i);
  assert.match(indexHtml, /class="skip-link"/);
  assert.match(indexHtml, /href="#main-content"/);
});

await run("app shell keeps landmarks and live regions", async () => {
  assert.match(appJs, /id="main-content"/);
  assert.match(appJs, /aria-live="polite"/);
  assert.match(appJs, /aria-label="כותרת האפליקציה"/);
  assert.match(appJs, /aria-label="ניווט ראשי"/);
  assert.match(appJs, /document\.documentElement\.setAttribute\("dir", "rtl"\)/);
});

await run("responsive and accessible css baseline exists", async () => {
  assert.match(stylesCss, /\.app-shell/);
  assert.match(stylesCss, /\.shell-main/);
  assert.match(stylesCss, /\.skip-link/);
  assert.match(stylesCss, /min-height:\s*48px/);
  assert.match(stylesCss, /:focus-visible/);
  assert.match(stylesCss, /@media \(min-width: 901px\)/);
  assert.match(stylesCss, /@media \(max-width: 900px\)/);
});

await run("critical seller admin affiliate copy is no longer visibly internal or english-leaking", async () => {
  assert.doesNotMatch(appJs, /launch-code/);
  assert.doesNotMatch(appJs, /מסך פנימי לייחוס/);
  assert.doesNotMatch(appJs, /מסך הניהול הפנימי/);
  assert.match(appJs, /מרכז הפצה/);
  assert.match(appJs, /מרכז התפעול של סיטון/);
  assert.match(appJs, /כניסה לאזור המוכר/);
});
