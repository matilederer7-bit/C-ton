// SPRINT 4 — owner UX cleanup: pure rules + React source pins.
//  A1 pickup navigation truth (Google Maps + Waze, exact pin vs address search)
//  A3 viral tree backstage only (no tree fields on buyer surfaces)
//  A4 legal documents native (one canonical source, JSON projection, hash routes)
//  A5 history-aware scroll restoration (state machine, DOM-free)
//  A6 intent-sensitive buyer search (classification + SQL shape)
//  A7 admin copy "ויראליות"
//  A8 virality time range (server window rules + client Israel-day boundaries)
//  A9 typed quantities (digits only, no steppers, no spinner)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const { parseQuantityInput, quantityDigits, isPositiveIntegerText, QUANTITY_INPUT_ATTRS } = await import("../web/src/quantityInput.js");
const { ScrollMemory, readScrollKey, parsePositions, SCROLL_STATE_FIELD, SCROLL_RESTORE_BUDGET_MS } = await import("../web/src/scrollRestoration.js");
const { growthRangeParams, growthRangeLabel, validateCustomRange, DEFAULT_GROWTH_RANGE } = await import("../web/src/growthRange.js");
const { pickupNavigation, pickupPrecision, pickupWazeUrl, describePickupLocation, PICKUP_PRECISION_COPY } = await import("../src/pickup_location.js");
const { parseLegalBlocks, legalPageProjection, isLegalPageSlug, LEGAL_PAGES, LEGAL_PAGE_ORDER } = await import("../src/legal_pages.js");
const { classifyBuyerSearch, normalizeSearchText, buyerSearchPredicateSql, buyerNameRankSql, escapeLike } = await import("../src/buyer_search_intent.js");
const { resolveGrowthWindow, GROWTH_DEFAULT_DAYS, GROWTH_MAX_PRESET_DAYS } = await import("../src/growth_window.js");
const { getParticipantImpact: _impact, BUYER_SHARE_IDENTITY_KEYS } = await import("../src/viral_graph.js");

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e.message}`); failed++; }
}

// ── A9 quantities ────────────────────────────────────────────────────────────
await run("A9 quantity: digits only, no decimals, no zero/negative, window enforced, leading zeros dropped", () => {
  assert.equal(quantityDigits("abc"), "");
  assert.equal(quantityDigits("2.5"), "25", "the dot cannot be typed — only digits survive");
  assert.equal(quantityDigits("007"), "7");
  assert.equal(quantityDigits("0"), "0");
  assert.equal(quantityDigits("-3"), "3");
  assert.equal(quantityDigits("1e3"), "13");
  assert.deepEqual(parseQuantityInput("", 1, 10), { digits: "", value: null, error: null });
  assert.deepEqual(parseQuantityInput("0", 1, 10), { digits: "0", value: null, error: "הכמות חייבת להיות לפחות יחידה אחת" });
  assert.deepEqual(parseQuantityInput("11", 1, 10), { digits: "11", value: null, error: "ניתן להזמין עד 10 יחידות" });
  assert.deepEqual(parseQuantityInput("7", 1, 10), { digits: "7", value: 7, error: null });
  assert.deepEqual(parseQuantityInput("1000", 1, 1000), { digits: "1000", value: 1000, error: null });
  assert.equal(parseQuantityInput("3", 5, 10).error, "הכמות חייבת להיות לפחות 5");
  assert.equal(parseQuantityInput("999999999999", 1, 1000).digits.length, 9, "bounded length");
  assert.equal(isPositiveIntegerText("12"), true);
  assert.equal(isPositiveIntegerText("2.5"), false);
  assert.equal(isPositiveIntegerText("0"), false);
  assert.equal(isPositiveIntegerText(""), false);
  assert.equal(QUANTITY_INPUT_ATTRS.type, "text");
  assert.equal(QUANTITY_INPUT_ATTRS.inputMode, "numeric");
  assert.equal(QUANTITY_INPUT_ATTRS.pattern, "[0-9]*");
});

await run("A9 source pins: no QtyStepper / +− buttons anywhere; the join qty and the seller min/max are typed numeric fields; browser spinners hidden", () => {
  const components = read("web/src/components.tsx");
  const deal = read("web/src/pages/deal.tsx");
  const seller = read("web/src/pages/seller.tsx");
  const css = read("web/src/styles.css");
  assert.doesNotMatch(components, /QtyStepper|qty-stepper|הוסף יחידה|הפחת יחידה/);
  assert.doesNotMatch(deal, /QtyStepper|qty-stepper/);
  assert.match(components, /export function QtyInput/);
  assert.match(components, /\{\.\.\.QUANTITY_INPUT_ATTRS\}/);
  assert.match(deal, /<QtyInput id="join-qty" testId="join-qty"/);
  assert.equal((seller.match(/data-testid="deal-min" \{\.\.\.QUANTITY_INPUT_ATTRS\}/g) || []).length, 1);
  assert.equal((seller.match(/data-testid="deal-max" \{\.\.\.QUANTITY_INPUT_ATTRS\}/g) || []).length, 1);
  assert.equal((seller.match(/data-testid="edit-deal-min" \{\.\.\.QUANTITY_INPUT_ATTRS\}/g) || []).length, 1);
  assert.equal((seller.match(/data-testid="edit-deal-max" \{\.\.\.QUANTITY_INPUT_ATTRS\}/g) || []).length, 1);
  assert.match(seller, /isPositiveIntegerText\(minUnits\)/);
  assert.match(seller, /isPositiveIntegerText\(maxUnits\)/);
  // no quantity field is a type="number" input any more (money fields may still be)
  assert.doesNotMatch(seller, /id="f-min"[^\n]*type="number"/);
  assert.doesNotMatch(seller, /id="f-max"[^\n]*type="number"/);
  assert.match(css, /input\[type="number"\]::-webkit-inner-spin-button/);
  assert.match(css, /input\[type="number"\] \{ -moz-appearance: textfield; appearance: textfield; \}/);
});

// ── A5 scroll restoration ────────────────────────────────────────────────────
function fakeScrollWorld(opts: { height?: number; inner?: number } = {}) {
  const world = {
    state: null as unknown,
    y: 0,
    height: opts.height ?? 4000,
    inner: opts.inner ?? 800,
    now: 0,
    store: null as string | null,
    frames: [] as Array<() => void>,
    scrolls: [] as number[],
    keys: 0
  };
  const deps = {
    readState: () => world.state,
    replaceState: (s: Record<string, unknown>) => { world.state = s; },
    scrollY: () => world.y,
    scrollTo: (y: number) => { world.y = y; world.scrolls.push(y); },
    scrollHeight: () => world.height,
    innerHeight: () => world.inner,
    now: () => world.now,
    requestFrame: (cb: () => void) => { world.frames.push(cb); },
    readStore: () => world.store,
    writeStore: (v: string) => { world.store = v; },
    newKey: () => `k${++world.keys}`
  };
  const flush = (ms = 16) => { const batch = world.frames.splice(0); world.now += ms; for (const cb of batch) cb(); };
  return { world, deps, flush };
}

await run("A5 scroll: NEW entries start at top, Back restores the exact position, Forward restores its own — per history entry, not per route", () => {
  const { world, deps, flush } = fakeScrollWorld();
  const memory = new ScrollMemory(deps as any);
  const boot = memory.boot();
  assert.equal(boot.kind, "new");
  const keyA = readScrollKey(world.state);
  assert.ok(keyA, "the first entry is stamped with a key in history.state");
  // the buyer reads deep into the deal page
  world.y = 2380; memory.remember();
  // clicks Support (a NEW entry: the browser pushes an entry with null state)
  world.state = null;
  const toSupport = memory.navigated(2380);
  assert.equal(toSupport.kind, "new");
  assert.equal(toSupport.target, 0);
  assert.equal(world.y, 0, "new page starts at the top");
  const keyB = readScrollKey(world.state);
  assert.ok(keyB && keyB !== keyA, "the new entry got its own key");
  world.y = 640; memory.remember();
  // Back: the browser restores the previous entry's state object ({key A})
  world.state = { [SCROLL_STATE_FIELD]: keyA };
  world.height = 500; // the deal page is still loading (BrandLoader) — too short to reach 2380
  const scrollsBefore = world.scrolls.length;
  const back = memory.navigated(640);
  assert.equal(back.kind, "traverse");
  assert.equal(back.target, 2380);
  assert.equal(world.scrolls.length, scrollsBefore, "cannot reach the target yet — no premature jump to a wrong offset");
  // a scroll event fired by the short loader page must NOT overwrite the remembered position
  world.y = 0; memory.remember();
  assert.equal(memory.savedPosition(keyA), 2380, "pending restore keeps the real position");
  world.height = 4000; flush(); // page rendered
  assert.equal(world.y, 2380, "restored to the exact previous position once the page is tall enough");
  // Forward: back to Support's entry, its OWN position
  world.state = { [SCROLL_STATE_FIELD]: keyB };
  const fwd = memory.navigated(2380);
  assert.equal(fwd.kind, "traverse");
  assert.equal(fwd.target, 640);
  assert.equal(world.y, 640);
  assert.equal(memory.savedPosition(keyA), 2380, "A's position survives the round trip");
});

await run("A5 scroll: a restore gives up after the budget (scrolls to the reachable maximum), a newer navigation cancels an older pending restore, reload adopts the stored key", () => {
  const { world, deps, flush } = fakeScrollWorld({ height: 500 });
  const memory = new ScrollMemory(deps as any);
  memory.boot();
  const keyA = readScrollKey(world.state)!;
  world.height = 6000; world.y = 5000; memory.remember();
  world.state = null; memory.navigated(5000); // new entry B
  const keyB = readScrollKey(world.state)!;
  world.state = { [SCROLL_STATE_FIELD]: keyA }; world.height = 500;
  memory.navigated(0); // back to A, page short
  // supersede with another navigation before A renders
  world.state = { [SCROLL_STATE_FIELD]: keyB };
  memory.navigated(0);
  world.height = 6000; flush(); flush();
  assert.equal(world.y, 0, "the older restore (5000) was cancelled by the newer navigation");
  // budget: a page that never grows tall enough ends at its reachable maximum
  world.state = { [SCROLL_STATE_FIELD]: keyA }; world.height = 1200; world.inner = 800;
  memory.navigated(0);
  for (let i = 0; i < 40; i += 1) flush(100);
  assert.ok(world.now >= SCROLL_RESTORE_BUDGET_MS);
  assert.equal(world.y, 400, "after the budget the page rests at its reachable maximum, not at 0");
  // reload: history.state keeps the key and sessionStorage keeps the position
  memory.persist();
  const again = new ScrollMemory({ ...deps, readState: () => ({ [SCROLL_STATE_FIELD]: keyA }) } as any);
  const plan = again.boot();
  assert.equal(plan.kind, "reload");
  assert.equal(plan.target, 5000, "A's remembered position survives a reload through sessionStorage");
  assert.equal(again.savedPosition(keyB), 0);
  assert.deepEqual(Object.keys(parsePositions(world.store)).sort(), [keyA, keyB].sort());
  assert.deepEqual(parsePositions("not json"), {});
});

await run("A5 late layout shifts retain the saved position; explicit user input cancels restoration", () => {
  const { world, deps, flush } = fakeScrollWorld();
  const memory = new ScrollMemory(deps as any);
  memory.boot();
  const key = readScrollKey(world.state)!;
  world.y = 900; memory.remember();
  world.state = null; memory.navigated(900);
  world.state = { [SCROLL_STATE_FIELD]: key }; memory.navigated(0);
  for (let i = 0; i < 30; i++) flush();
  world.y = 962; memory.remember(); flush();
  assert.equal(world.y, 900, "late browser anchoring does not shift the saved position");
  assert.equal(memory.savedPosition(key), 900);
  memory.userInteracted(); world.y = 1100; memory.remember(); flush();
  assert.equal(world.y, 1100, "user scrolling wins");
  assert.equal(memory.savedPosition(key), 1100);
});

await run("A5 source pins: the router no longer forces scrollTo(0,0); restoration is installed on the hashchange path; no global overflow-x band-aid", () => {
  const app = read("web/src/App.tsx");
  const css = read("web/src/styles.css");
  assert.doesNotMatch(app, /window\.scrollTo\(0, 0\)/);
  assert.match(app, /installScrollRestoration\(\)/);
  assert.match(app, /restoration\.onHashChange\(\); setRoute\(parseHash\(\)\);/);
  assert.doesNotMatch(css, /html[^{]*\{[^}]*overflow-x:\s*hidden/);
  assert.doesNotMatch(css, /body[^{]*\{[^}]*overflow-x:\s*hidden/);
});

// ── A1 pickup navigation ─────────────────────────────────────────────────────
await run("A1 navigation: exact coordinates → Google Maps AND Waze carry the SAME coordinates; address text → both do an address search and say so; generic label → nothing", () => {
  const exact = pickupNavigation({ option_type: "pickup", label: "הרצל 12, תל אביב", latitude: 32.0668, longitude: 34.7647 });
  assert.ok(exact && exact.exact && exact.mode === "coordinates");
  assert.equal(exact!.google_maps_url, "https://www.google.com/maps/dir/?api=1&destination=32.0668%2C34.7647");
  assert.equal(exact!.waze_url, "https://waze.com/ul?ll=32.0668%2C34.7647&navigate=yes");
  assert.equal(pickupWazeUrl({ option_type: "pickup", label: "x", latitude: "31.5", longitude: "35" }), "https://waze.com/ul?ll=31.5%2C35&navigate=yes");
  const address = pickupNavigation({ option_type: "distribution_point", label: "  רח׳ הרצל 12, תל אביב  " });
  assert.ok(address && !address.exact && address.mode === "address_search");
  assert.equal(address!.google_maps_url, `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent("רח׳ הרצל 12, תל אביב")}`);
  assert.equal(address!.waze_url, `https://waze.com/ul?q=${encodeURIComponent("רח׳ הרצל 12, תל אביב")}&navigate=yes`);
  assert.equal(pickupNavigation({ option_type: "pickup", label: "איסוף עצמי" }), null, "a generic label is never searched");
  assert.equal(pickupNavigation({ option_type: "delivery", label: "הרצל 12" }), null, "delivery has no pickup navigation");
  assert.equal(pickupNavigation({ option_type: "pickup", label: "הרצל 12", latitude: 999, longitude: 35 })!.mode, "address_search", "an invalid coordinate never becomes an exact pin");
  assert.equal(pickupPrecision({ option_type: "pickup", label: "הרצל 12", latitude: 32, longitude: 34 }), "exact");
  assert.equal(pickupPrecision({ option_type: "pickup", label: "הרצל 12" }), "address");
  assert.equal(pickupPrecision({ option_type: "pickup", label: "איסוף עצמי" }), "none");
  assert.equal(PICKUP_PRECISION_COPY.exact, "מיקום מדויק הוגדר");
  assert.equal(PICKUP_PRECISION_COPY.address, "הוגדרה כתובת בלבד — מומלץ לאמת נקודה מדויקת");
  const described = describePickupLocation({ option_type: "pickup", label: "הרצל 12", latitude: 32, longitude: 34 });
  assert.equal(described.precision, "exact");
  assert.deepEqual(described.navigation, pickupNavigation({ option_type: "pickup", label: "הרצל 12", latitude: 32, longitude: 34 }));
});

await run("A1 source pins: both buyer surfaces render Google Maps + Waze from the canonical helper; no lone 'פתח במפה'; the seller sees the precision truth and the same two links", () => {
  const deal = read("web/src/pages/deal.tsx");
  const card = read("web/src/pickupCard.tsx");
  const seller = read("web/src/pages/seller.tsx");
  const fulfil = read("src/physical_fulfillment.ts");
  assert.match(deal, /export function PickupNavActions/);
  assert.match(deal, /data-testid=\{`\$\{testIdPrefix\}-google`\}/);
  assert.match(deal, /data-testid=\{`\$\{testIdPrefix\}-waze`\}/);
  assert.match(deal, /PICKUP_NAV_MODE_COPY\[nav\.mode\]/);
  assert.doesNotMatch(deal, /פתח במפה|פתיחה במפה|הצגה במפה/);
  assert.doesNotMatch(card, /פתח במפה|פתיחה במפה|pickup_map_url/);
  assert.match(card, /<PickupNavActions nav=\{pickup\.pickup_navigation as any\} testIdPrefix="track-pickup-nav" \/>/);
  assert.match(fulfil, /pickup_navigation: method === "pickup" \? location\.navigation : null/);
  assert.doesNotMatch(seller, /google\.com\/maps/, "no inline map URL builder on the seller page — one canonical helper");
  assert.match(seller, /data-testid="geo-nav-google"/);
  assert.match(seller, /data-testid="geo-nav-waze"/);
  assert.match(seller, /data-testid="seller-nav-google"/);
  assert.match(seller, /data-testid="seller-nav-waze"/);
  assert.match(seller, /data-testid=\{`pickup-precision-\$\{precision\}`\}/);
  assert.match(seller, /data-testid="pickup-precision-address"/);
  assert.match(seller, /PICKUP_PRECISION_COPY\.exact/);
});

// ── A3 viral tree backstage only ─────────────────────────────────────────────
await run("A3 source pins: the buyer tracking page has no propagation counters; the buyer-token payload is share identity only; the join reply carries no generation; the orphan tree canvas is gone", () => {
  const track = read("web/src/pages/track.tsx");
  const deal = read("web/src/pages/deal.tsx");
  const graph = read("src/viral_graph.ts");
  const appTs = read("src/app.ts");
  for (const needle of ["direct_children", "branch_depth", "descendants", "units_joined_via_branch", "דורות", "בענף", "השרשרת שלך", "impact-stats"]) {
    assert.ok(!track.includes(needle), `track.tsx must not contain "${needle}"`);
    assert.ok(!deal.includes(needle), `deal.tsx must not contain "${needle}"`);
  }
  assert.match(track, /data-testid="track-share"/, "the simple share loop stays");
  assert.match(track, /<ShareActions\s*\n?\s*layout="loop"/, "the simple share loop stays");
  assert.deepEqual([...BUYER_SHARE_IDENTITY_KEYS], ["participant_id", "personal_share_code", "personal_share_url"]);
  const impactBody = graph.slice(graph.indexOf("export async function getParticipantImpact"), graph.indexOf("}", graph.indexOf("personal_share_url: link")) + 1);
  assert.doesNotMatch(impactBody, /WITH RECURSIVE|direct_children|descendants|branch_depth/);
  const joinReply = appTs.slice(appTs.indexOf("viral: {", appTs.indexOf("hold_total:")), appTs.indexOf("}", appTs.indexOf("personal_share_url: viralJoin")) + 1);
  assert.doesNotMatch(joinReply, /generation/);
  let vtreeExists = true;
  try { read("web/src/vtree.tsx"); } catch { vtreeExists = false; }
  assert.equal(vtreeExists, false, "web/src/vtree.tsx (orphan buyer-visible tree canvas) is deleted");
  // seller + admin backstage keep the canonical tree
  assert.match(read("web/src/pages/seller.tsx"), /<PropagationTree/);
  assert.match(read("web/src/pages/admin.tsx"), /<PropagationTree/);
  assert.match(read("src/frontend_runtime.ts"), /app\.get\("\/api\/seller\/deals\/:dealId\/propagation"/);
  assert.match(read("src/frontend_runtime.ts"), /app\.get\("\/api\/admin\/deals\/:dealId\/propagation"/);
});

// ── A4 legal ─────────────────────────────────────────────────────────────────
await run("A4 legal: one canonical source, one parser — every document projects to blocks with its title; the React route + footer + consent link stay inside the product", () => {
  const blocks = parseLegalBlocks("# כותרת\n\n## סעיף\n\nפסקה ראשונה\nשורה שנייה\n\n\n\nפסקה שנייה");
  assert.deepEqual(blocks, [
    { type: "h1", text: "כותרת" }, { type: "h2", text: "סעיף" },
    { type: "p", lines: ["פסקה ראשונה", "שורה שנייה"] }, { type: "p", lines: ["פסקה שנייה"] }
  ]);
  for (const slug of LEGAL_PAGE_ORDER) {
    const page = legalPageProjection(slug);
    assert.equal(page.slug, slug);
    assert.equal(page.blocks[0]?.type, "h1");
    assert.equal(page.title, LEGAL_PAGES[slug].title);
    assert.ok(page.blocks.length > 3, `${slug} has sections`);
    assert.ok(page.nav.some((n) => n.slug === slug && n.current), `${slug} is current in its own nav`);
    assert.ok(page.notice.includes("גרסה 0.9"));
  }
  assert.deepEqual(legalPageProjection("terms").nav.map((n) => n.slug), ["terms", "privacy", "refunds"]);
  assert.equal(isLegalPageSlug("terms"), true);
  assert.equal(isLegalPageSlug("constructor"), false);
  assert.equal(isLegalPageSlug("__proto__"), false);
  const app = read("web/src/App.tsx");
  const legal = read("web/src/pages/legal.tsx");
  const deal = read("web/src/pages/deal.tsx");
  const runtime = read("src/frontend_runtime.ts");
  assert.match(app, /\{page === "legal" \? <LegalPage slug=\{route\.seg\[1\] \|\| "terms"\} navigate=\{navigate\} \/> : null\}/);
  assert.match(app, /"support", "legal", "reset-password"\]\.includes\(page\)/);
  for (const slug of ["terms", "privacy", "refunds"]) assert.match(app, new RegExp(`href="#/legal/${slug}" data-testid="footer-legal-${slug}"`));
  assert.doesNotMatch(app, /href="\/legal\//, "no full-page exit from the product for legal links");
  assert.match(deal, /href="#\/legal\/terms" target="_blank"/);
  assert.match(legal, /api\.legal\(slug\)/);
  assert.doesNotMatch(legal, /תקנון שימוש ותנאי שירות|C-ton אינה שומרת/, "no legal text duplicated into the React bundle");
  assert.match(runtime, /app\.get\("\/api\/legal\/:slug"/);
  assert.match(runtime, /redirect\(`\/preview\/#\/legal\/\$\{slug\}`, 302\)/);
  assert.doesNotMatch(runtime, /renderLegalHtmlPage|<!doctype html>\s*\n<html lang="he" dir="rtl">\s*\n<head>\s*\n\s*<meta charset="utf-8">\s*\n\s*<meta name="viewport"[^\n]*\n\s*<title>C-ton \| /, "the standalone legal HTML shell is gone");
});

// ── A6 buyer search ──────────────────────────────────────────────────────────
await run("A6 search intent: letters → name only (tokens, Hebrew-normalized), digits → phone, @ → e-mail, CT-… → order code, UUID → id; LIKE metacharacters are literal", () => {
  assert.equal(classifyBuyerSearch("").intent, "empty");
  assert.equal(classifyBuyerSearch("   ").intent, "empty");
  const shin = classifyBuyerSearch("ש");
  assert.equal(shin.intent, "name");
  assert.deepEqual(shin.tokens, ["ש"]);
  assert.equal(shin.label_he, "חיפוש לפי שם");
  assert.equal(shin.match_label_he, "התאמה בשם");
  const two = classifyBuyerSearch("  שרה   לוי ");
  assert.deepEqual(two.tokens, ["שרה", "לוי"]);
  assert.equal(normalizeSearchText("מִיכָאֵל כץ"), "מיכאל כצ", "niqqud stripped, final letters folded");
  assert.equal(normalizeSearchText("  Moshe   LEVI "), "moshe levi");
  assert.equal(classifyBuyerSearch("shani").intent, "name", "Latin letters are a name query — the e-mail is NOT searched");
  assert.equal(classifyBuyerSearch("052-111 2233").intent, "phone");
  assert.equal(classifyBuyerSearch("052-111 2233").normalized, "0521112233");
  assert.equal(classifyBuyerSearch("+972 52 111 2233").normalized, "972521112233");
  assert.equal(classifyBuyerSearch("5").intent, "phone", "a lone digit is a phone prefix, never a name");
  assert.equal(classifyBuyerSearch("sara@example.com").intent, "email");
  assert.equal(classifyBuyerSearch("SARA@Example.com").normalized, "sara@example.com");
  assert.equal(classifyBuyerSearch("CT-1234-5678").intent, "order_code");
  assert.equal(classifyBuyerSearch("ct 1234 5678").normalized, "CT-1234-5678");
  assert.equal(classifyBuyerSearch("12345678").intent, "phone", "bare 8 digits stay a phone — the order code needs its CT prefix");
  assert.equal(classifyBuyerSearch("9b79d413-a521-4600-80c0-10b781436ed3").intent, "id");
  assert.equal(classifyBuyerSearch("0123456789abcdef0123").intent, "id");
  assert.equal(classifyBuyerSearch("abcdef").intent, "name", "short hex-looking text is still a name");
  assert.equal(escapeLike("50%_x\\"), "50\\%\\_x\\\\");
  const name = buyerSearchPredicateSql(two, "agg", 3);
  assert.match(name.sql, /agg\.buyer_name/);
  assert.doesNotMatch(name.sql, /buyer_email|buyer_phone|buyer_id/, "a name query touches the NAME only");
  assert.equal(name.params.length, 3);
  assert.deepEqual(name.params.slice(1), ["%שרה%", "%לוי%"]);
  assert.match(name.sql, /\$4 ESCAPE '\\' AND .* LIKE \$5 ESCAPE '\\'/);
  const phone = buyerSearchPredicateSql(classifyBuyerSearch("052"), "agg", 1);
  assert.match(phone.sql, /regexp_replace\(COALESCE\(agg\.buyer_phone, agg\.buyer_id, ''\), '\\D', '', 'g'\) LIKE \$1/);
  assert.doesNotMatch(phone.sql, /buyer_name|buyer_email/);
  const email = buyerSearchPredicateSql(classifyBuyerSearch("a@b"), "agg", 1);
  assert.match(email.sql, /lower\(COALESCE\(agg\.buyer_email, ''\)\) LIKE \$1/);
  assert.equal(buyerSearchPredicateSql(classifyBuyerSearch(""), "agg", 1).sql, "TRUE");
  const rank = buyerNameRankSql(two, "p", 1);
  assert.match(rank.sql, /LIKE \$2 ESCAPE '\\'\) DESC, $/);
  assert.equal(buyerNameRankSql(classifyBuyerSearch("052"), "p", 1).sql, "");
});

// ── A7 copy ──────────────────────────────────────────────────────────────────
await run("A7 copy: the admin heading and nav item read 'ויראליות' — 'צמיחה וויראליות' is gone from every user-visible surface; backend route names untouched", () => {
  const admin = read("web/src/pages/admin.tsx");
  assert.doesNotMatch(admin, /צמיחה וויראליות/);
  assert.match(admin, /<h1>ויראליות<\/h1>/);
  assert.match(admin, /\[\["growth", "ויראליות"\]\]/);
  assert.match(read("src/frontend_runtime.ts"), /app\.get\("\/api\/admin\/growth"/, "cosmetic rename only — the route keeps its name");
});

// ── A8 virality window ───────────────────────────────────────────────────────
await run("A8 window (server): default 7 days; presets; custom [from,to) validated (inverted / malformed / too early / future / too long); all time; no tiny cap", () => {
  const now = new Date("2026-09-09T10:00:00.000Z");
  const dflt = resolveGrowthWindow({}, now);
  assert.ok(dflt.ok && dflt.window.kind === "days" && dflt.window.days === GROWTH_DEFAULT_DAYS && GROWTH_DEFAULT_DAYS === 7);
  assert.equal(dflt.ok && dflt.window.from, "2026-09-02T10:00:00.000Z");
  assert.equal(dflt.ok && dflt.window.to, now.toISOString());
  for (const days of [30, 90, 365, 1000]) {
    const r = resolveGrowthWindow({ days: String(days) }, now);
    assert.ok(r.ok && r.window.days === days, `days=${days}`);
  }
  assert.equal((resolveGrowthWindow({ days: "abc" }, now) as any).window.days, 7);
  assert.equal((resolveGrowthWindow({ days: "-5" }, now) as any).window.days, 7);
  assert.equal((resolveGrowthWindow({ days: "99999" }, now) as any).window.days, GROWTH_MAX_PRESET_DAYS);
  const custom = resolveGrowthWindow({ from: "2026-08-31T21:00:00.000Z", to: "2026-09-07T21:00:00.000Z" }, now);
  assert.ok(custom.ok && custom.window.kind === "custom");
  assert.equal(custom.ok && custom.window.from, "2026-08-31T21:00:00.000Z");
  assert.equal(custom.ok && custom.window.to, "2026-09-07T21:00:00.000Z");
  assert.equal((resolveGrowthWindow({ from: "2026-09-07T00:00:00Z", to: "2026-09-01T00:00:00Z" }, now) as any).error, "growth_range_inverted");
  assert.equal((resolveGrowthWindow({ from: "yesterday", to: "today" }, now) as any).error, "growth_range_invalid");
  assert.equal((resolveGrowthWindow({ from: "2019-12-31T00:00:00Z", to: "2026-09-01T00:00:00Z" }, now) as any).error, "growth_range_too_early");
  assert.equal((resolveGrowthWindow({ from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z" }, now) as any).error, "growth_range_future");
  assert.equal((resolveGrowthWindow({ from: "2020-01-01T00:00:00Z", to: "2026-09-09T00:00:00Z" }, now) as any).ok, true, "a six-year custom range is fine — no product cap");
  const openEnd = resolveGrowthWindow({ from: "2026-09-01T00:00:00Z" }, now);
  assert.ok(openEnd.ok && openEnd.window.to === now.toISOString(), "missing `to` means up to now");
  const all = resolveGrowthWindow({ range: "all" }, now);
  assert.ok(all.ok && all.window.kind === "all" && all.window.from === null);
});

await run("A8 range (client): Israel-local days become UTC instants — from = 00:00 Israel of the first day, to = 00:00 Israel of the day AFTER the last day", () => {
  const israel = (d: string, t: string) => {
    // deterministic stand-in for util.israelPartsToUtcIso: September = UTC+3
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d)!; const h = Number(t.split(":")[0]);
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h - 3)).toISOString();
  };
  assert.deepEqual(growthRangeParams({ kind: "days", days: 30 }, israel), { days: "30" });
  assert.deepEqual(growthRangeParams({ kind: "all" }, israel), { range: "all" });
  assert.deepEqual(growthRangeParams({ kind: "custom", from: "2026-09-01", to: "2026-09-08" }, israel), { from: "2026-08-31T21:00:00.000Z", to: "2026-09-08T21:00:00.000Z" });
  assert.deepEqual(growthRangeParams({ kind: "custom", from: "bad", to: "2026-09-08" }, () => null), { days: "7" });
  assert.equal(validateCustomRange("2026-09-08", "2026-09-01"), "תאריך ההתחלה חייב להיות לפני תאריך הסיום");
  assert.equal(validateCustomRange("", "2026-09-01"), "יש לבחור תאריך התחלה ותאריך סיום");
  assert.equal(validateCustomRange("2026-09-01", "2026-09-01"), null, "a single day is a valid range");
  assert.equal(growthRangeLabel({ kind: "days", days: 7 }), "7 הימים האחרונים");
  assert.deepEqual(DEFAULT_GROWTH_RANGE, { kind: "days", days: 7 });
  const admin = read("web/src/pages/admin.tsx");
  assert.match(admin, /useState<GrowthRange>\(DEFAULT_GROWTH_RANGE\)/);
  assert.match(admin, /growthRangeParams\(range, israelPartsToUtcIso\)/);
  assert.match(admin, /data-testid="growth-lifetime"/);
  assert.match(admin, /מצטבר מאז ההשקה \(כל הזמן\)/);
  assert.doesNotMatch(admin, /last_7_days/, "no hidden 7-day card next to lifetime cards");
  assert.match(read("web/src/pages/sellerCommand.tsx"), /הפצה ויראלית \(מצטבר — כל הזמן\)/, "the seller viral panel is labelled lifetime");
});

console.log(`\nSPRINT4_UX_CLEANUP_UNIT passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
