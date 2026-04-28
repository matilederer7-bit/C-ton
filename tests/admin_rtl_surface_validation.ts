import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile("frontend/index.html", "utf8");
const app = await readFile("frontend/app.js", "utf8");
const css = await readFile("frontend/styles.css", "utf8");

assert.match(html, /dir="rtl"/);
assert.match(app, /מרכז שליטה תפעולי/);
assert.match(app, /Omnisearch אדמין/);
assert.match(app, /עסקאות בעייתיות/);
assert.match(app, /Audit & Forensics|יומן ביקורת/);
assert.match(app, /אין כאן שינוי סטייט ידני, חיוב, זיכוי, ביטול חיוב או העברה כספית מתוך הממשק/);
assert.match(css, /mission-control/);

console.log("PASS admin mission control surface is RTL and operationally explicit");
