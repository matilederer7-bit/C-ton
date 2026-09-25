// C-ton brand consistency — Web, PWA, Android, iOS.
//
// 2026-09-24 "Daylight" visual refresh (owner decision): the canonical React
// web app moved from the graphite + orange dark theme to a light ground with
// Siton Indigo as the brand colour and Siton Coral as the "live" accent.
// 2026-09-25: the legacy /app PWA shell and the native launcher/store/splash
// art followed. Every raster below is rendered from assets/brand/*.svg by
// scripts/render_brand_assets.cjs (+ `npm run mobile:assets` for the native
// catalogs), so this file checks PIXELS, not byte sizes: the right colour in
// the right place, on every surface the brand reaches.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import sharp from "sharp";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const [webCss, webIndex, legacyIndex, manifestRaw, legacyCss, logo, frontendLogo, iosIcon, androidIcon, androidFg, splash, splashDark] = await Promise.all([
  readFile("web/src/styles.css", "utf8"),
  readFile("web/index.html", "utf8"),
  readFile("frontend/index.html", "utf8"),
  readFile("frontend/manifest.webmanifest", "utf8"),
  readFile("frontend/styles.css", "utf8"),
  readFile("assets/logo.svg", "utf8"),
  readFile("frontend/icons/logo.svg", "utf8"),
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
  // a token that aliases another (--success: var(--accent-cyan)) resolves to it
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
const isIndigo = ([r, g, b, a]: number[]) => a! > 250 && b! > 170 && r! < 130 && g! < 110;
const isWhite = ([r, g, b, a]: number[]) => a! > 250 && r! > 235 && g! > 235 && b! > 235;
const isCoral = ([r, g, b, a]: number[]) => a! > 250 && r! > 220 && g! < 140 && b! < 110;
const isDaylight = ([r, g, b, a]: number[]) => a! > 250 && r! > 236 && g! > 236 && b! > 240;
const isInk = ([r, g, b, a]: number[]) => a! > 250 && r! < 40 && g! < 40 && b! < 70;
const isClear = ([, , , a]: number[]) => a! < 10;
// in the 1024 mark: (300,516) is on the white C, (706,512) on the coral bar,
// (40,40) on the tile — scaled per file size
const at = (size: number, x: number, y: number): [number, number] => [Math.round(x * size / 1024), Math.round(y * size / 1024)];

// ── Web: daylight ground, indigo brand, coral live accent ───────────────────
assert.equal(token("bg"), "#f6f7fb", "cool paper-white ground");
assert.equal(token("surface"), "#ffffff", "cards and panels are pure white");
assert.equal(token("brand"), "#4a3aff", "Siton Indigo is the brand colour");
assert.equal(token("live"), "#ff5a36", "Siton Coral is the live accent");
assert.match(webCss, /color-scheme:\s*light/);
assert.doesNotMatch(webCss, /color-scheme:\s*dark/, "no dark scheme left in the canonical web app");
assert.ok(relativeLuminance(token("bg")) > 0.85 && relativeLuminance(token("surface")) > 0.85, "the grounds are light");
assert.ok(alpha(token("brand-glow")) <= 0.32, `brand glow must stay restrained (≤0.32), saw ${token("brand-glow")}`);
assert.ok(alpha(token("shadow")) <= 0.25 && alpha(token("shadow-soft")) <= 0.2 && alpha(token("shadow-pop")) <= 0.3, "light-theme shadows stay soft");
assert.doesNotMatch(webCss, /#0f766e|#faf7f2|#C65A1E/i, "no retired teal/cream/brick tokens in the canonical web app");
// the retired dark theme does not linger as hard-coded values
assert.doesNotMatch(webCss, /#16130f|#17181b|#101114|rgba\(16, ?17, ?20/i, "no graphite leftovers outside the token layer");

// Every ink token must be READABLE on every surface it can land on (WCAG AA
// 4.5:1 for normal text) — and so must every coloured TEXT token.
const grounds = ["bg", "bg-deep", "surface", "surface-warm"];
for (const ink of ["ink", "ink-soft", "ink-faint", "brand-hi", "live-ink", "success", "saffron", "pomegranate", "sky"]) {
  for (const surface of grounds) {
    const ratio = contrast(token(ink), token(surface));
    assert.ok(ratio >= 4.5, `--${ink} on --${surface} is ${ratio}:1 — below the 4.5:1 AA floor for normal text`);
  }
}
// state text on its own tint
for (const [ink, tint] of [["success", "success-tint"], ["saffron", "saffron-tint"], ["pomegranate", "pomegranate-tint"], ["sky", "sky-tint"], ["live-ink", "live-tint"]] as const) {
  const ratio = contrast(token(ink), token(tint));
  assert.ok(ratio >= 4.5, `--${ink} on --${tint} is ${ratio}:1`);
}
// white text on the filled controls
for (const fill of ["brand", "brand-hi", "brand-deep", "live-strong", "pomegranate"]) {
  const ratio = contrast("#ffffff", token(fill));
  assert.ok(ratio >= 4.5, `white on --${fill} is ${ratio}:1`);
}
assert.equal(token("on-brand"), "#ffffff");
// and the three inks must stay distinguishable from each other, darkest first
assert.ok(
  relativeLuminance(token("ink")) < relativeLuminance(token("ink-soft"))
  && relativeLuminance(token("ink-soft")) < relativeLuminance(token("ink-faint")),
  "the ink ramp must stay ordered: ink darker than ink-soft darker than ink-faint"
);
console.log("PASS ink, brand and state text tokens clear WCAG AA on every canonical surface");
assert.match(webCss, /@media \(prefers-reduced-motion: reduce\)/, "motion stays optional");
assert.match(webIndex, /<meta name="theme-color" content="#f6f7fb" \/>/, "web browser chrome matches the daylight ground");
assert.match(webIndex, /html \{ background: #f6f7fb; \}/, "pre-hydration paint is the daylight ground");
console.log("PASS web: daylight + indigo/coral tokens, soft effects, no graphite leftovers");

// ── PWA (legacy /app shell): same daylight identity, same chrome ────────────
const manifest = JSON.parse(manifestRaw);
assert.equal(manifest.name, "C-ton");
assert.equal(manifest.short_name, "C-ton");
assert.equal(manifest.theme_color, "#f6f7fb", "PWA status bar matches the daylight ground");
assert.equal(manifest.background_color, "#f6f7fb", "PWA splash matches the daylight ground");
assert.equal(manifest.dir, "rtl"); assert.equal(manifest.lang, "he-IL");
assert.ok(manifest.icons.length >= 7 && manifest.icons.every((i: any) => i.type === "image/png" && /\.png$/.test(i.src)));
for (const icon of manifest.icons) {
  const file = String(icon.src).replace(/^\/app\//, "frontend/");
  const bytes = await readFile(file);
  assert.ok(bytes.subarray(0, 8).equals(PNG), `PWA icon ${icon.src} is PNG`);
  const size = Number(String(icon.sizes).split("x")[0]);
  const meta = await sharp(bytes).metadata();
  assert.equal(meta.width, size, `${icon.src} is ${size}px wide`);
  // "any maskable": a full-bleed indigo square (the OS applies the mask), the C in white
  assert.ok(isIndigo(await pixel(bytes, ...at(size, 40, 40))), `${icon.src} corner is the indigo tile`);
  if (size >= 96) assert.ok(isWhite(await pixel(bytes, ...at(size, 300, 516))), `${icon.src} carries the white C`);
}
assert.match(legacyIndex, /<meta name="theme-color" content="#f6f7fb" \/>/, "legacy shell chrome is the daylight ground");
assert.doesNotMatch(manifestRaw + legacyIndex + legacyCss, /#0f766e|#faf7f2|#17181b|#C65A1E|#2F3237/i, "no teal/cream/graphite/brick left in the legacy shell");
assert.match(legacyCss, /--primary:\s*#4a3aff;/, "legacy shell brand token is Siton Indigo");
assert.match(legacyCss, /--bg:\s*#f6f7fb;/, "legacy shell ground is daylight");
console.log("PASS pwa: manifest identity C-ton, daylight chrome, indigo PNG icon set");

// ── Logo source of truth: the daylight C mark, everywhere ───────────────────
for (const [label, svg] of [["assets/logo.svg", logo], ["frontend/icons/logo.svg", frontendLogo]] as const) {
  assert.match(svg, /white C on a Siton Indigo tile with the Siton Coral bar/, `${label} describes the C-ton identity`);
  assert.match(svg, /#4a3aff/i, `${label} carries Siton Indigo`);
  assert.match(svg, /#ff5a36/i, `${label} carries the coral bar`);
  assert.doesNotMatch(svg, /#0f766e|#faf7f2|#0b0c0e/i, `${label} has no teal/cream/graphite`);
}
console.log("PASS logo: the daylight mark is the one source of truth");

// ── Native: launcher/store icons and splash are the same mark ───────────────
for (const [label, bytes] of [["iOS AppIcon 1024", iosIcon], ["Android xxxhdpi launcher", androidIcon], ["Android adaptive foreground", androidFg], ["iOS splash", splash], ["iOS splash dark", splashDark]] as const) {
  assert.ok(bytes.subarray(0, 8).equals(PNG), `${label} is PNG`);
}
// iOS App Store icon: 1024², fully opaque, indigo tile, white C, coral bar
{
  const meta = await sharp(iosIcon).metadata();
  assert.equal(meta.width, 1024); assert.equal(meta.height, 1024);
  assert.ok(isIndigo(await pixel(iosIcon, 40, 40)), "iOS icon corner is the indigo tile (no transparent rounding: iOS rounds it)");
  assert.ok(isWhite(await pixel(iosIcon, 300, 516)), "iOS icon carries the white C");
  assert.ok(isCoral(await pixel(iosIcon, 706, 512)), "iOS icon carries the coral bar");
}
// Android legacy launcher (xxxhdpi 192) and adaptive layers (xxxhdpi 432)
{
  const meta = await sharp(androidIcon).metadata();
  assert.equal(meta.width, 192, "xxxhdpi launcher is 192px");
  // the tool rounds the legacy launcher's corners itself, so the tile is read
  // inside the C's counter (the centre), never at a corner
  assert.ok(isIndigo(await pixel(androidIcon, ...at(192, 512, 512))), "Android launcher centre is the indigo tile");
  assert.ok(isWhite(await pixel(androidIcon, ...at(192, 300, 516))), "Android launcher carries the white C");
  const fg = await sharp(androidFg).metadata();
  const fgSize = Number(fg.width);
  assert.ok(fgSize >= 432 && fg.height === fgSize, `adaptive foreground is a square of at least 432px (saw ${fg.width}x${fg.height})`);
  assert.ok(isClear(await pixel(androidFg, 8, 8)), "adaptive foreground is transparent outside the glyph");
  // the enlarged glyph: the C stroke sits left of centre, the bar right of centre
  assert.ok(isWhite(await pixel(androidFg, ...at(fgSize, 250, 516))), "adaptive foreground carries the white C");
  assert.ok(isCoral(await pixel(androidFg, ...at(fgSize, 760, 512))), "adaptive foreground carries the coral bar");
  const bg = await readFile("android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_background.png");
  assert.ok(isIndigo(await pixel(bg, 20, 20)), "adaptive background is the indigo tile");
}
// splash screens: light on the daylight ground, dark on ink, the mark in the middle
{
  for (const [label, bytes, ground] of [["iOS splash", splash, isDaylight], ["iOS splash dark", splashDark, isInk]] as const) {
    const meta = await sharp(bytes).metadata();
    assert.equal(meta.width, 2732, `${label} is 2732px`);
    assert.ok(ground(await pixel(bytes, 60, 60)), `${label} corner is its ground`);
    assert.ok(isIndigo(await pixel(bytes, 1366 - 250, 1366 - 300)), `${label} carries the indigo mark in the middle`);
  }
  const androidSplash = await readFile("android/app/src/main/res/drawable-port-xxxhdpi/splash.png");
  assert.ok(isDaylight(await pixel(androidSplash, 20, 20)), "Android portrait splash is the daylight ground");
  const androidNight = await readFile("android/app/src/main/res/drawable-port-night-xxxhdpi/splash.png");
  assert.ok(isInk(await pixel(androidNight, 20, 20)), "Android night splash is the ink ground");
}
console.log("PASS native: Android launcher set, iOS AppIcon and splash carry the daylight mark");

console.log("VISUAL_BRAND_CONSISTENCY_PASS");
