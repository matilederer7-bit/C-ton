// C-ton brand consistency — Web, PWA, Android, iOS.
//
// 2026-09-25 "Graphite Mint" (owner decision, docs/BRAND_GRAPHITE_MINT.md):
// graphite #0f172a is the brand's dark (text, nav, primary CTA, the logo
// tile), mint #2dd4bf its light (the short dash in the logo — never a dot —
// highlights, selection, live), green #065f46 for success, amber only for
// urgency, on a paper ground #f8fafc. Every raster below is rendered from
// assets/brand/*.svg by scripts/render_brand_assets.cjs (+ `npm run
// mobile:assets` for the native catalogs), so this file checks PIXELS, not
// byte sizes: the right colour in the right place, on every surface the brand
// reaches.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import sharp from "sharp";

const GRAPHITE = "#0f172a", MINT = "#2dd4bf", GREEN = "#065f46", AMBER = "#f59e0b", GROUND = "#f8fafc", BORDER = "#e5e7eb";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const [webCss, webIndex, legacyIndex, manifestRaw, legacyCss, logo, frontendLogo, markSvg, wordSvg, iosIcon, androidIcon, androidFg, splash, splashDark] = await Promise.all([
  readFile("web/src/styles.css", "utf8"),
  readFile("web/index.html", "utf8"),
  readFile("frontend/index.html", "utf8"),
  readFile("frontend/manifest.webmanifest", "utf8"),
  readFile("frontend/styles.css", "utf8"),
  readFile("assets/logo.svg", "utf8"),
  readFile("frontend/icons/logo.svg", "utf8"),
  readFile("assets/brand/c-ton-mark.svg", "utf8"),
  readFile("assets/brand/c-ton-wordmark.svg", "utf8"),
  readFile("ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"),
  readFile("android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png"),
  readFile("android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png"),
  readFile("ios/App/App/Assets.xcassets/Splash.imageset/Default@2x~universal~anyany.png"),
  readFile("ios/App/App/Assets.xcassets/Splash.imageset/Default@2x~universal~anyany-dark.png")
]);

function token(name: string): string {
  const m = webCss.match(new RegExp(`--${name}:\\s*([^;]+);`));
  assert.ok(m, `token --${name} missing`);
  const value = String(m![1] ?? "").trim();
  // a token that aliases another (--brand: var(--brand-graphite)) resolves to it
  const alias = /^var\(--([a-z0-9-]+)\)$/.exec(value);
  return alias ? token(alias[1]!) : value;
}
function alpha(value: string): number {
  const m = value.match(/rgba\([^)]*,\s*([0-9.]+)\)/);
  assert.ok(m, `no alpha in ${value}`);
  return Number(m![1] ?? "1");
}
// ── WCAG contrast, computed from the tokens themselves ────────────────────
function rgbOf(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  assert.ok(m, `expected a 6-digit hex colour, saw ${hex}`);
  const n = parseInt(m![1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function relativeLuminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(fg: string, bg: string): number {
  const a = relativeLuminance(fg) + 0.05;
  const b = relativeLuminance(bg) + 0.05;
  return Math.round((Math.max(a, b) / Math.min(a, b)) * 100) / 100;
}

// ── pixel sampling (sharp is a dependency: the same renderer that made the files)
async function pixel(file: string | Buffer, x: number, y: number): Promise<[number, number, number, number]> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
}
// graphite #0f172a (15,23,42) — distinct from the deep splash ground #020617 (2,6,23)
const isGraphite = ([r, g, b, a]: number[]) => a! > 250 && r! < 40 && g! < 50 && b! >= 32 && b! < 80;
const isDeep = ([r, g, b, a]: number[]) => a! > 250 && r! < 16 && g! < 20 && b! < 32;
const isWhite = ([r, g, b, a]: number[]) => a! > 250 && r! > 235 && g! > 235 && b! > 235;
// mint #2dd4bf (45,212,191)
const isMint = ([r, g, b, a]: number[]) => a! > 250 && r! < 120 && g! > 180 && b! > 150;
const isPaper = ([r, g, b, a]: number[]) => a! > 250 && r! > 238 && g! > 242 && b! > 244;
const isClear = ([, , , a]: number[]) => a! < 10;
// in the 1024 mark: (300,516) is on the white C, (706,512) on the mint dash,
// (40,40) on the tile — scaled per file size
const at = (size: number, x: number, y: number): [number, number] => [Math.round(x * size / 1024), Math.round(y * size / 1024)];

// ── Web: paper ground, graphite brand, mint accent, one token layer ─────────
assert.equal(token("bg"), GROUND, "paper-white ground");
assert.equal(token("surface"), "#ffffff", "cards and panels are pure white");
assert.equal(token("line"), BORDER, "secondary grey border");
assert.equal(token("brand-graphite"), GRAPHITE); assert.equal(token("brand-mint"), MINT);
assert.equal(token("brand-green"), GREEN); assert.equal(token("brand-amber"), AMBER);
assert.equal(token("brand"), GRAPHITE, "the brand fill is graphite");
assert.equal(token("live"), MINT, "the live accent is mint");
assert.equal(token("success-fill"), GREEN, "success fills are the brand green");
assert.equal(token("saffron-fill"), AMBER, "urgency fills are amber");
assert.equal(token("ink"), GRAPHITE, "primary text is graphite");
assert.match(webCss, /color-scheme:\s*light/);
assert.doesNotMatch(webCss, /color-scheme:\s*dark/, "no dark scheme left in the canonical web app");
assert.ok(relativeLuminance(token("bg")) > 0.85 && relativeLuminance(token("surface")) > 0.85, "the grounds are light");
assert.ok(alpha(token("brand-glow")) <= 0.6, `the decorative mint halo stays restrained (≤0.6), saw ${token("brand-glow")}`);
// keyboard focus is a READABLE ring (WCAG 1.4.11 non-text contrast): mint ink, never plain mint on white
assert.match(token("focus-ring"), /var\(--brand-mint-ink\)/, "the focus ring is drawn in mint ink");
assert.ok(contrast(token("brand-mint-ink"), token("surface")) >= 3 && contrast(token("brand-mint-ink"), token("bg")) >= 3, "the focus ring clears 3:1 on white and on the ground");
assert.ok(alpha(token("brand-tint")) <= 0.2, `the mint selection tint stays soft (≤0.2), saw ${token("brand-tint")}`);
assert.ok(alpha(token("shadow")) <= 0.25 && alpha(token("shadow-soft")) <= 0.2 && alpha(token("shadow-pop")) <= 0.3, "light-theme shadows stay soft");
// the retired identities do not linger anywhere in the stylesheet
const RETIRED = /#4a3aff|#ff5a36|#13142b|#f6f7fb|#3b2bd9|#0f766e|#faf7f2|#C65A1E|#16130f|#17181b|#101114|rgba\(74, ?58, ?255|rgba\(255, ?90, ?54|rgba\(19, ?20, ?43|rgba\(16, ?17, ?20/i;
assert.doesNotMatch(webCss, RETIRED, "no indigo/coral/navy/teal/cream/graphite-room leftovers in the canonical web app");
// amber is never a brand colour: it appears only as the urgency tokens
assert.equal((webCss.match(/#f59e0b/gi) || []).length, 1, "amber is declared once, as --brand-amber, and referenced through tokens");

// Every ink token must be READABLE on every surface it can land on (WCAG AA
// 4.5:1 for normal text) — and so must every coloured TEXT token.
const grounds = ["bg", "bg-deep", "surface", "surface-warm", "brand-tint-solid"];
const tokenOrSolid = (name: string) => name === "brand-tint-solid" ? "#e6faf7" : token(name); // the mint tint over white
for (const ink of ["ink", "ink-soft", "ink-faint", "brand-hi", "brand-mint-ink", "live-ink", "success", "saffron", "pomegranate", "sky"]) {
  for (const surface of grounds) {
    const ratio = contrast(token(ink), tokenOrSolid(surface));
    assert.ok(ratio >= 4.5, `--${ink} on --${surface} is ${ratio}:1 — below the 4.5:1 AA floor for normal text`);
  }
}
// state text on its own tint
for (const [ink, tint] of [["success", "success-tint"], ["saffron", "saffron-tint"], ["pomegranate", "pomegranate-tint"], ["sky", "sky-tint"], ["live-ink", "live-tint"]] as const) {
  const ratio = contrast(token(ink), token(tint));
  assert.ok(ratio >= 4.5, `--${ink} on --${tint} is ${ratio}:1`);
}
// white text on the filled controls; graphite text on the amber urgency fill
for (const fill of ["brand", "brand-graphite-hi", "brand-deep", "success-fill", "brand-green-hi", "pomegranate"]) {
  const ratio = contrast("#ffffff", token(fill));
  assert.ok(ratio >= 4.5, `white on --${fill} is ${ratio}:1`);
}
assert.ok(contrast(token("ink"), token("saffron-fill")) >= 4.5, "graphite on the amber urgency fill");
assert.ok(contrast(token("ink"), token("brand-mint")) >= 4.5, "graphite on a mint fill (chips, dash labels)");
assert.equal(token("on-brand"), "#ffffff");
// and the three inks must stay distinguishable from each other, darkest first
assert.ok(
  relativeLuminance(token("ink")) < relativeLuminance(token("ink-soft"))
  && relativeLuminance(token("ink-soft")) < relativeLuminance(token("ink-faint")),
  "the ink ramp must stay ordered: ink darker than ink-soft darker than ink-faint"
);
console.log("PASS ink, brand and state text tokens clear WCAG AA on every canonical surface");
assert.match(webCss, /@media \(prefers-reduced-motion: reduce\)/, "motion stays optional");
// ordered button states: hover, active, focus, disabled
assert.match(webCss, /\.btn-primary:hover \{[^}]*var\(--brand-graphite-hi\)/, "primary hover lifts to graphite-hi");
assert.match(webCss, /\.btn-primary:active, \.btn-join:active \{ background: var\(--brand-deep\); \}/, "primary active presses to graphite-deep");
assert.match(webCss, /\.btn:disabled, \.btn\[aria-disabled="true"\] \{[^}]*var\(--bg-deep\)[^}]*var\(--ink-faint\)/, "one disabled state for every button");
assert.match(webCss, /button:focus-visible[^{]*\{[^}]*var\(--focus-ring\)/, "focus takes the mint-ink ring");
// one token layer: no scattered brand rgba literals outside :root
assert.doesNotMatch(webCss.slice(webCss.indexOf("--font-display")), /rgba\(45, ?212, ?191|rgba\(15, ?23, ?42/, "brand tints reference the token triplets, not literals");
assert.doesNotMatch(webCss, /\.img-star\.active \{ color: var\(--saffron/, "amber is never a selected state");
// semantics: collecting is mint, reached is green, the completion window is amber, failed is red
assert.match(webCss, /\.status\.PendingTarget \{ background: var\(--live-tint\); color: var\(--live-ink\); \}/);
assert.match(webCss, /\.status\.TargetReached \{ background: var\(--success-tint\); color: var\(--success\); \}/);
assert.match(webCss, /\.status\.CompletionWindow \{ background: var\(--saffron-tint\); color: var\(--saffron\); \}/);
assert.match(webCss, /\.status\.Failed \{ background: var\(--pomegranate-tint\); color: var\(--pomegranate\); \}/);
assert.match(webCss, /\.card-urgency\.hot \{ background: var\(--saffron-fill\); color: var\(--ink\); \}/, "urgency badge is amber with graphite text");
assert.match(webIndex, /<meta name="theme-color" content="#f8fafc" \/>/, "web browser chrome matches the paper ground");
assert.match(webIndex, /html \{ background: #f8fafc; \}/, "pre-hydration paint is the paper ground");
assert.doesNotMatch(webIndex, RETIRED, "no retired colour in the boot page");
console.log("PASS web: graphite/mint tokens, ordered states, semantic colours, no retired leftovers");

// ── Logo source of truth: graphite tile, white C, the short mint DASH ───────
for (const [label, svg] of [["assets/brand/c-ton-mark.svg", markSvg], ["assets/logo.svg", logo], ["frontend/icons/logo.svg", frontendLogo]] as const) {
  assert.match(svg, /white C on a graphite tile with the short mint dash/, `${label} describes the C-ton identity`);
  assert.match(svg, /#0f172a/i, `${label} carries brand graphite`);
  assert.match(svg, /#2dd4bf/i, `${label} carries the mint dash`);
  assert.doesNotMatch(svg, /<circle|<ellipse/, `${label}: the dash is a dash, never a dot`);
  assert.doesNotMatch(svg, RETIRED, `${label} has no retired colour`);
  // the dash: a horizontal bar (wider than 2x its height), a little thinner
  // than the C stroke (147 units), with one soft blurred copy underneath
  const dashes = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"[^>]*fill="#2dd4bf"([^>]*)\/>/gi)];
  assert.equal(dashes.length, 2, `${label}: the dash and its glow copy`);
  for (const d of dashes) {
    const w = Number(d[3]), h = Number(d[4]);
    assert.ok(w >= 2 * h, `${label}: dash ${w}x${h} must read as a bar`);
    assert.ok(h >= 90 && h <= 120, `${label}: dash height ${h} — a little thinner than the 147 stroke, never a hairline`);
  }
  const glow = dashes.find((d) => /filter=/.test(d[5]!));
  assert.ok(glow, `${label}: the glow copy uses the blur filter`);
  assert.ok(Number(/fill-opacity="([0-9.]+)"/.exec(glow![5]!)?.[1]) <= 0.6, `${label}: the glow is soft, not neon`);
  assert.match(svg, /<feGaussianBlur stdDeviation="(1[5-9]|2[0-9]|30)"\/>/, `${label}: a soft blur radius`);
  assert.match(svg, /id="mark-dash-glow"/, `${label}: the mark keeps its own filter id`);
}
{
  // the wordmark: graphite letters, the same mint dash (thinner than the 22 stroke), the same soft glow
  assert.match(wordSvg, /stroke="#0f172a" stroke-width="22"/, "wordmark letters are graphite");
  assert.doesNotMatch(wordSvg, /<circle|<ellipse/, "wordmark: no dot");
  const dashes = [...wordSvg.matchAll(/<rect x="[\d.]+" y="[\d.]+" width="([\d.]+)" height="([\d.]+)"[^>]*fill="#2dd4bf"([^>]*)\/>/gi)];
  assert.equal(dashes.length, 2, "wordmark: the dash and its glow copy");
  for (const d of dashes) {
    const w = Number(d[1]), h = Number(d[2]);
    assert.ok(w >= 2 * h && h >= 14 && h <= 20, `wordmark dash ${w}x${h}: a bar a little thinner than the 22 stroke`);
  }
  assert.ok(Number(/fill-opacity="([0-9.]+)"/.exec(dashes.find((d) => /filter=/.test(d[3]!))![3]!)?.[1]) <= 0.6, "wordmark glow is soft");
  assert.doesNotMatch(wordSvg, RETIRED);
  // distinct filter ids: the renderer inlines both SVGs into one splash/lockup
  // document, and a shared id would give the wordmark the mark's 22-unit blur
  assert.match(wordSvg, /id="word-dash-glow"/); assert.doesNotMatch(wordSvg, /mark-dash-glow/);
}
console.log("PASS logo: the graphite mark with the short mint dash is the one source of truth");

// ── Web rasters: the mark, the favicon and the wordmark carry the dash ──────
for (const [file, size] of [["web/public/brand/c-ton-mark.png", 512], ["web/public/brand/c-ton-mark-180.png", 180], ["web/public/brand/favicon-64.png", 64]] as const) {
  const bytes = await readFile(file);
  const meta = await sharp(bytes).metadata();
  assert.equal(meta.width, size, `${file} is ${size}px`);
  assert.ok(isGraphite(await pixel(bytes, ...at(size, 140, 140))), `${file} tile is graphite`);
  assert.ok(isWhite(await pixel(bytes, ...at(size, 300, 516))), `${file} carries the white C`);
  assert.ok(isMint(await pixel(bytes, ...at(size, 706, 512))), `${file} carries the mint dash`);
  // the dash is still a BAR, not a blob, at favicon size: mint left AND right of centre
  assert.ok(isMint(await pixel(bytes, ...at(size, 620, 512))) && isMint(await pixel(bytes, ...at(size, 790, 512))), `${file}: the dash spans its width`);
  assert.ok(isGraphite(await pixel(bytes, ...at(size, 706, 400))), `${file}: tile above the dash — the dash is thinner than the C`);
}
{
  const bytes = await readFile("web/public/brand/c-ton-wordmark.png");
  const meta = await sharp(bytes).metadata();
  assert.equal(meta.width, 1080); assert.equal(meta.height, 280);
  // viewBox -18 0 540 140 at 2x: dash centre (159, 77) → (354, 154); "t" stem (222, 60) → (480, 120)
  assert.ok(isMint(await pixel(bytes, 354, 154)), "wordmark carries the mint dash");
  assert.ok(isGraphite(await pixel(bytes, 480, 120)), "wordmark letters are graphite");
  assert.ok(isClear(await pixel(bytes, 10, 10)), "wordmark is transparent around the letters");
}
{
  // the hero lockup (also the og:image): just inside where a leaked mark-size
  // blur would paint a box around the wordmark dash (wordmark units (150,50):
  // clear of the C's arm cap and the t crossbar cap → x 652, y 788 in the
  // 1536x1024 render) the ground must match the ground above the letters (y 742)
  const bytes = await readFile("web/public/brand/c-ton-logo.png");
  // two samples: beside the dash (150,50) and below it (170,100); the leaked
  // blur measured 9-10 units of drift there, the clean render 2-3
  const above = await pixel(bytes, 652, 742);
  for (const [x, y] of [[652, 788], [675, 845]] as const) {
    const inBox = await pixel(bytes, x, y);
    const drift = Math.max(...inBox.slice(0, 3).map((v, i) => Math.abs(v - above[i]!)));
    assert.ok(drift <= 6, `lockup: no glow box around the wordmark dash at (${x},${y}) (drift ${drift})`);
  }
  assert.ok(above[0]! > 225, "lockup ground next to the wordmark dash stays light");
}
console.log("PASS web rasters: mark, favicon and wordmark carry the graphite/white/mint identity, no glow box");

// ── Native: launcher/store icons and splash are the same mark ───────────────
for (const [label, bytes] of [["iOS AppIcon 1024", iosIcon], ["Android xxxhdpi launcher", androidIcon], ["Android adaptive foreground", androidFg], ["iOS splash", splash], ["iOS splash dark", splashDark]] as const) {
  assert.ok(bytes.subarray(0, 8).equals(PNG), `${label} is PNG`);
}
// iOS App Store icon: 1024², fully opaque, graphite tile, white C, mint dash
{
  const meta = await sharp(iosIcon).metadata();
  assert.equal(meta.width, 1024); assert.equal(meta.height, 1024);
  assert.ok(isGraphite(await pixel(iosIcon, 40, 40)), "iOS icon corner is the graphite tile (no transparent rounding: iOS rounds it)");
  assert.ok(isWhite(await pixel(iosIcon, 300, 516)), "iOS icon carries the white C");
  assert.ok(isMint(await pixel(iosIcon, 706, 512)), "iOS icon carries the mint dash");
}
// Android legacy launcher (xxxhdpi 192) and adaptive layers (xxxhdpi 432)
{
  const meta = await sharp(androidIcon).metadata();
  assert.equal(meta.width, 192, "xxxhdpi launcher is 192px");
  // the tool rounds the legacy launcher's corners itself, so the tile is read
  // inside the C's counter (the centre), never at a corner
  assert.ok(isGraphite(await pixel(androidIcon, ...at(192, 512, 512))), "Android launcher centre is the graphite tile");
  assert.ok(isWhite(await pixel(androidIcon, ...at(192, 300, 516))), "Android launcher carries the white C");
  const fg = await sharp(androidFg).metadata();
  const fgSize = Number(fg.width);
  assert.ok(fgSize >= 432 && fg.height === fgSize, `adaptive foreground is a square of at least 432px (saw ${fg.width}x${fg.height})`);
  assert.ok(isClear(await pixel(androidFg, 8, 8)), "adaptive foreground is transparent outside the glyph");
  // the enlarged glyph: the C stroke sits left of centre, the dash right of centre
  assert.ok(isWhite(await pixel(androidFg, ...at(fgSize, 250, 516))), "adaptive foreground carries the white C");
  assert.ok(isMint(await pixel(androidFg, ...at(fgSize, 760, 512))), "adaptive foreground carries the mint dash");
  const bg = await readFile("android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_background.png");
  assert.ok(isGraphite(await pixel(bg, 20, 20)), "adaptive background is the graphite tile");
}
// splash screens: light on the paper ground, dark on the deep ground, the mark in the middle
{
  for (const [label, bytes, ground] of [["iOS splash", splash, isPaper], ["iOS splash dark", splashDark, isDeep]] as const) {
    const meta = await sharp(bytes).metadata();
    assert.equal(meta.width, 2732, `${label} is 2732px`);
    assert.ok(ground(await pixel(bytes, 60, 60)), `${label} corner is its ground`);
    assert.ok(isGraphite(await pixel(bytes, 1366 - 250, 1366 - 300)), `${label} carries the graphite mark in the middle`);
    // just inside where a leaked mark-size blur would box the wordmark dash: the ground, not a tinted rectangle
    // (the splash ground carries a wide mint radial wash, so compare with the
    // same ground 95px higher, in the gap between the mark and the wordmark)
    const above = await pixel(bytes, 1234, 1573);
    for (const [x, y] of [[1234, 1668], [1260, 1733]] as const) {
      const inBox = await pixel(bytes, x, y);
      const drift = Math.max(...inBox.slice(0, 3).map((v, i) => Math.abs(v - above[i]!)));
      assert.ok(drift <= 8, `${label}: no glow box around the wordmark dash at (${x},${y}) (drift ${drift})`);
    }
  }
  const androidSplash = await readFile("android/app/src/main/res/drawable-port-xxxhdpi/splash.png");
  assert.ok(isPaper(await pixel(androidSplash, 20, 20)), "Android portrait splash is the paper ground");
  const androidNight = await readFile("android/app/src/main/res/drawable-port-night-xxxhdpi/splash.png");
  assert.ok(isDeep(await pixel(androidNight, 20, 20)), "Android night splash is the deep ground");
}
console.log("PASS native: Android launcher set, iOS AppIcon and splash carry the Graphite Mint mark");

// ── PWA (legacy /app shell): same identity, same chrome ─────────────────────
const manifest = JSON.parse(manifestRaw);
assert.equal(manifest.name, "C-ton");
assert.equal(manifest.short_name, "C-ton");
assert.equal(manifest.theme_color, GROUND, "PWA status bar matches the paper ground");
assert.equal(manifest.background_color, GROUND, "PWA splash matches the paper ground");
assert.equal(manifest.dir, "rtl"); assert.equal(manifest.lang, "he-IL");
assert.ok(manifest.icons.length >= 7 && manifest.icons.every((i: any) => i.type === "image/png" && /\.png$/.test(i.src)));
for (const icon of manifest.icons) {
  const file = String(icon.src).replace(/^\/app\//, "frontend/");
  const bytes = await readFile(file);
  assert.ok(bytes.subarray(0, 8).equals(PNG), `PWA icon ${icon.src} is PNG`);
  const size = Number(String(icon.sizes).split("x")[0]);
  const meta = await sharp(bytes).metadata();
  assert.equal(meta.width, size, `${icon.src} is ${size}px wide`);
  // "any maskable": a full-bleed graphite square (the OS applies the mask), the C in white, the dash in mint
  assert.ok(isGraphite(await pixel(bytes, ...at(size, 40, 40))), `${icon.src} corner is the graphite tile`);
  if (size >= 96) assert.ok(isWhite(await pixel(bytes, ...at(size, 300, 516))), `${icon.src} carries the white C`);
  if (size >= 96) assert.ok(isMint(await pixel(bytes, ...at(size, 706, 512))), `${icon.src} carries the mint dash`);
}
assert.match(legacyIndex, /<meta name="theme-color" content="#f8fafc" \/>/, "legacy shell chrome is the paper ground");
assert.doesNotMatch(manifestRaw + legacyIndex + legacyCss, RETIRED, "no retired colour left in the legacy shell");
assert.match(legacyCss, /--primary:\s*#0f172a;/, "legacy shell brand token is graphite");
assert.match(legacyCss, /--live:\s*#2dd4bf;/, "legacy shell live token is mint");
assert.match(legacyCss, /--bg:\s*#f8fafc;/, "legacy shell ground is paper");
console.log("PASS pwa: manifest identity C-ton, paper chrome, graphite PNG icon set with the mint dash");

console.log("VISUAL_BRAND_CONSISTENCY_PASS");
