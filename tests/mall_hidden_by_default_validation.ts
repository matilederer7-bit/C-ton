import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

// PR E (2026-09-30, constitution §6): the Mall is hidden for the current
// launch. This suite pins the launch default (flag unset) and the enabled
// state, and proves direct deal links never depend on the flag.
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
delete process.env.PUBLIC_MALL_ENABLED;

const { app } = await import("../src/app.js");

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

await run("M1 launch default: /api/mall/deals answers 404 mall_disabled and the site payloads say the Mall is off", async () => {
  const mall = await app.inject({ method: "GET", url: "/api/mall/deals?sort=newest&limit=12" });
  assert.equal(mall.statusCode, 404, mall.body);
  assert.equal(mall.json().code, "mall_disabled");
  const meta = await app.inject({ method: "GET", url: "/api/preview/meta" });
  assert.equal(meta.statusCode, 200, meta.body);
  assert.equal(meta.json().public_mall_enabled, false);
  const home = await app.inject({ method: "GET", url: "/api/site/home" });
  assert.equal(home.statusCode, 200, home.body);
  assert.equal(home.json().site.public_mall_enabled, false);
});

await run("M2 launch default: the legacy /app home stays reachable but advertises no Mall and is not indexed", async () => {
  for (const url of ["/app", "/app/"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 200, `${url}: ${res.statusCode}`);
    assert.match(res.body, /<title>C-ton \| עסקאות קבוצתיות<\/title>/);
    assert.match(res.body, /<meta name="robots" content="noindex,nofollow"/);
    assert.doesNotMatch(res.body, /קניון עסקאות קבוצתיות/);
  }
});

await run("M3 direct deal links never depend on the flag", async () => {
  const dealShell = await app.inject({ method: "GET", url: `/app/deal/${randomUUID()}` });
  assert.equal(dealShell.statusCode, 200, dealShell.body.slice(0, 200));
  assert.match(dealShell.body, /<html lang="he" dir="rtl">/);
  const root = await app.inject({ method: "GET", url: "/" });
  assert.equal(root.statusCode, 302);
  assert.equal(root.headers.location, "/preview/");
});

await run("M4 the legacy shell forwards a hidden-Mall home to /preview/ before ever calling the Mall API", async () => {
  const source = await readFile(new URL("../frontend/app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function loadHome()");
  assert.ok(start >= 0, "loadHome missing");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  const guard = body.indexOf("public_mall_enabled === false");
  const redirect = body.indexOf('location.replace("/preview/")');
  const mallCall = body.indexOf("buildMallDealsUrl(");
  assert.ok(guard >= 0 && redirect > guard, "loadHome must redirect when the site payload says the Mall is off");
  assert.ok(mallCall > redirect, "the Mall API must only be called after the flag check");
});

await run("M5 enabled: the same routes serve the Mall again without a restart", async () => {
  process.env.PUBLIC_MALL_ENABLED = "1";
  try {
    const mall = await app.inject({ method: "GET", url: "/api/mall/deals?sort=newest&limit=12" });
    assert.equal(mall.statusCode, 200, mall.body);
    assert.equal(mall.json().ok, true);
    const home = await app.inject({ method: "GET", url: "/app" });
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /<title>C-ton \| קניון עסקאות קבוצתיות<\/title>/);
    assert.match(home.body, /<meta name="robots" content="index,follow"/);
    const meta = await app.inject({ method: "GET", url: "/api/preview/meta" });
    assert.equal(meta.json().public_mall_enabled, true);
  } finally {
    delete process.env.PUBLIC_MALL_ENABLED;
  }
  const again = await app.inject({ method: "GET", url: "/api/mall/deals" });
  assert.equal(again.statusCode, 404, "unsetting the flag hides the Mall again");
});

await app.close();
console.log("All mall-hidden-by-default tests passed.");
