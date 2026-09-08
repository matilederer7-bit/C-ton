// LAUNCH POLISH (P5) — the React product never sends a pilot user back into
// the legacy vanilla app.
//
// Two frontends exist on the same origin: the canonical React product under
// /preview/ (hash routes) and the legacy app under /app. This regression pins:
//   * no legacy link anywhere in the React sources (web/src, web/index.html)
//   * the server entry points a React user touches — the bare root, the
//     /preview shell, the /d/:id share route — never point at /app
//   * the navigation hints inside React-consumed seller payloads point at the
//     React routes (workspace, create-deal, business profile)
//   * the legacy app itself stays reachable for direct links (not deleted)
//   * the pre-hydration boot loader is present in the served shell (P8)
//
// Deliberately NOT asserted: `seller_auth.return_to` — it is validated by the
// legacy-owned safeSellerReturnTo() contract and read by no React code.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

process.env.APP_DEPLOYMENT_MODE = process.env.APP_DEPLOYMENT_MODE || "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");
await app.ready();

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e?.stack || e?.message || e}`); failed++; }
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const webSrc = join(root, "web", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|css|html)$/.test(entry)) out.push(full);
  }
  return out;
}

// a legacy reference is "/app" as a path: quoted, in a template, after "=", or
// followed by a path/query/hash separator. API paths (/api/…) never match.
const LEGACY_REF = /(["'`=(\s])\/app(?:\/|["'`?#\s)]|$)/;

await run("no legacy /app reference in any React source file", async () => {
  const files = [...walk(webSrc), join(root, "web", "index.html")];
  assert.ok(files.length > 20, `unexpectedly few React sources: ${files.length}`);
  const offenders: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (LEGACY_REF.test(line) && !/\/api\//.test(line.slice(Math.max(0, line.search(LEGACY_REF) - 8)))) {
        offenders.push(`${relative(root, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `legacy references:\n${offenders.join("\n")}`);
});

await run("React navigation is hash-only: every navigate()/href target is #/…, /legal/… or an external/mailto link", async () => {
  const offenders: string[] = [];
  for (const file of walk(webSrc).filter((f) => /\.tsx?$/.test(f))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:navigate\(|href=)\s*["'`]([^"'`$]+)["'`]/g)) {
      const target = String(m[1]);
      if (target.startsWith("#") || target.startsWith("/legal/") || /^(https?:|mailto:|tel:)/.test(target) || target === "#") continue;
      offenders.push(`${relative(root, file)}: ${target}`);
    }
    for (const m of src.matchAll(/location\.(?:href|assign|replace)\s*[=(]\s*["'`]([^"'`]+)["'`]/g)) {
      offenders.push(`${relative(root, file)}: location → ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, [], `non-hash navigation targets:\n${offenders.join("\n")}`);
});

await run("bare root → /preview/ (never /app); legacy /app stays reachable for direct links", async () => {
  const rootRes = await app.inject({ method: "GET", url: "/" });
  assert.equal(rootRes.statusCode, 302, rootRes.body);
  assert.equal(rootRes.headers.location, "/preview/");
  const legacy = await app.inject({ method: "GET", url: "/app" });
  assert.equal(legacy.statusCode, 200, "legacy app must remain reachable (not deleted)");
});

await run("/preview shell: served HTML carries the boot loader and no /app link (or the source shell when dist is absent)", async () => {
  const res = await app.inject({ method: "GET", url: "/preview/" });
  let html: string;
  if (res.statusCode === 200 && /<div id="root">/.test(res.body)) {
    html = res.body;
  } else {
    // a fresh checkout without `vite build`: pin the source shell instead
    const source = join(root, "web", "index.html");
    assert.ok(existsSync(source), "web/index.html missing");
    html = readFileSync(source, "utf8");
    console.log("  (preview bundle not built here — asserting the source shell)");
  }
  assert.match(html, /data-testid="boot-loader"/, "P8 pre-hydration loader present");
  assert.match(html, /C-ton נטען/, "boot loader explains what is happening, in Hebrew");
  assert.doesNotMatch(html, /href="\/app/, "no legacy link in the shell");
});

await run("/d/:id share route forwards humans into the React deal page, never into /app", async () => {
  const id = randomUUID();
  const human = await app.inject({ method: "GET", url: `/d/${id}?ref=POLISH`, headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1" } });
  assert.ok([200, 302, 404].includes(human.statusCode), `share route ${human.statusCode}`);
  const target = human.statusCode === 302 ? String(human.headers.location || "") : human.body.slice(0, 6000);
  if (human.statusCode !== 404) {
    assert.match(target, /preview\/[^"']*#\/deal\//, `share route target: ${target.slice(0, 200)}`);
  }
  assert.doesNotMatch(target, /href="\/app|location(?:\.href)?\s*=\s*["']\/app|\/app\/(?:seller|admin)/, "share route points at the legacy app");
  const bad = await app.inject({ method: "GET", url: "/d/not-a-uuid" });
  assert.equal(bad.statusCode, 302);
  assert.equal(bad.headers.location, "/preview/");
});

await run("React-consumed seller payload hints point at React routes (workspace, create-deal, business profile)", async () => {
  const seller = `seller-legacy-${randomUUID().slice(0, 8)}`;
  const ctx = await app.inject({ method: "GET", url: "/api/seller/context", headers: { "x-seller-id": seller } });
  assert.equal(ctx.statusCode, 200, ctx.body);
  const sc = (ctx.json() as any).seller_context;
  assert.equal(sc.workspace_url, "/preview/#/seller");
  assert.equal(sc.create_deal_url, "/preview/#/seller/new");
  const deals = await app.inject({ method: "GET", url: "/api/seller/deals", headers: { "x-seller-id": seller } });
  assert.equal(deals.statusCode, 200, deals.body);
  const auth = (deals.json() as any).seller_surface.seller_auth;
  assert.equal(auth.onboarding.next_path, "/preview/#/seller/profile");
  // the legacy site-home entry keeps ITS legacy hint (read by the legacy app) — untouched by design
  const home = await app.inject({ method: "GET", url: "/api/site/home" });
  assert.equal(home.statusCode, 200, home.body);
  assert.equal((home.json() as any).site.seller_entry.create_deal_url, "/app/seller/new");
});

await app.close();
console.log(`\nREACT_LEGACY_ROUTE passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
