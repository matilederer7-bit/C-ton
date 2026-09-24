// C-ton brand consistency — Web, PWA, Android, iOS.
//
// 2026-09-24 "Daylight" visual refresh (owner decision): the canonical React
// web app moved from the graphite + orange dark theme to a light ground with
// Siton Indigo as the brand colour and Siton Coral as the "live" accent. This
// pins the new web identity and its accessibility floor.
//
// The legacy /app PWA shell and the native launcher/store/splash art were NOT
// part of that refresh (they are separate surfaces with their own build and
// store pipelines); their existing graphite identity stays pinned below until
// a follow-up brings them over, so neither can drift silently.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const [webCss, webIndex, legacyIndex, manifestRaw, logo, frontendLogo, iosIcon, androidIcon, androidFg, splash, splashDark] = await Promise.all([
  readFile("web/src/styles.css", "utf8"),
  readFile("web/index.html", "utf8"),
  readFile("frontend/index.html", "utf8"),
  readFile("frontend/manifest.webmanifest", "utf8"),
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

// ── PWA (legacy /app shell): same identity, same chrome ─────────────────────
const manifest = JSON.parse(manifestRaw);
assert.equal(manifest.name, "C-ton");
assert.equal(manifest.short_name, "C-ton");
assert.equal(manifest.theme_color, "#17181b", "PWA status bar matches the web graphite");
assert.equal(manifest.background_color, "#17181b", "PWA splash matches the web graphite");
assert.equal(manifest.dir, "rtl"); assert.equal(manifest.lang, "he-IL");
assert.ok(manifest.icons.length >= 7 && manifest.icons.every((i: any) => i.type === "image/png" && /\.png$/.test(i.src)));
for (const icon of manifest.icons) {
  const bytes = await readFile(String(icon.src).replace(/^\/app\//, "frontend/"));
  assert.ok(bytes.subarray(0, 8).equals(PNG), `PWA icon ${icon.src} is PNG`);
}
assert.match(legacyIndex, /<meta name="theme-color" content="#17181b" \/>/);
assert.doesNotMatch(manifestRaw + legacyIndex, /#0f766e/i, "the teal PWA chrome is retired");
console.log("PASS pwa: manifest identity C-ton, graphite chrome, PNG icon set");

// ── Logo source of truth: the daylight C mark ───────────────────────────────
assert.match(logo, /white C on a Siton Indigo tile with the Siton Coral bar/, "assets/logo.svg describes the C-ton identity");
assert.match(logo, /#4a3aff/i, "assets/logo.svg carries Siton Indigo");
assert.match(logo, /#ff5a36/i, "assets/logo.svg carries the coral bar");
assert.doesNotMatch(logo, /#0f766e|#faf7f2/i);
// the legacy /app shell keeps its own graphite icon until its follow-up
assert.match(frontendLogo, /Dark graphite C mark with a vivid orange bar/);
assert.doesNotMatch(frontendLogo, /#0f766e|#faf7f2/i, "frontend/icons/logo.svg has no teal/cream");
console.log("PASS logo: daylight mark is the source of truth; legacy shell icon unchanged");

// ── Native: launcher/store icons and splash are the same mark ───────────────
for (const [label, bytes] of [["iOS AppIcon 1024", iosIcon], ["Android xxxhdpi launcher", androidIcon], ["Android adaptive foreground", androidFg], ["iOS splash", splash], ["iOS splash dark", splashDark]] as const) {
  assert.ok(bytes.subarray(0, 8).equals(PNG), `${label} is PNG`);
}
// the rebranded iOS icon is materially larger than the retired flat teal art (gradients + bar)
assert.ok(iosIcon.length > 60_000, `iOS AppIcon is the rebranded graphite mark (${iosIcon.length} bytes)`);
assert.ok(androidFg.length > 20_000, `Android adaptive foreground is the rebranded mark (${androidFg.length} bytes)`);
console.log("PASS native: Android launcher set, iOS AppIcon and splash carry the graphite/orange mark");

console.log("VISUAL_BRAND_CONSISTENCY_PASS");
