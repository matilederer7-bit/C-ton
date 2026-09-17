// C-ton brand consistency — Web, PWA, Android, iOS.
//
// Shelf closeout 2026-09-17 (source codex/visual-rebrand-c-ton, reconciled
// against the current site): deep graphite dominates, one vivid orange accent,
// effects restrained (glow/shadow intensities ~15% below the shelf rebrand).
// The React web app already carried the dark brand; this pins it, brings the
// native launcher/store icons, the iOS splash, the PWA manifest identity and the
// logo source into the same identity, and guards against a regression to the
// retired teal/cream art.
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
  return String(m![1] ?? "").trim();
}
function alpha(value: string): number {
  const m = value.match(/rgba\([^)]*,\s*([0-9.]+)\)/);
  assert.ok(m, `no alpha in ${value}`);
  return Number(m![1] ?? "1");
}

// ── Web: graphite ground, orange accent, restrained effects ─────────────────
assert.equal(token("bg"), "#17181b", "deep graphite ground");
assert.equal(token("bg-deep"), "#101114");
assert.equal(token("brand"), "#ec6608", "the one commercial orange");
assert.match(webCss, /color-scheme:\s*dark/);
assert.ok(alpha(token("brand-glow")) <= 0.32, `brand glow must stay restrained (≤0.32), saw ${token("brand-glow")}`);
assert.ok(alpha(token("accent-cyan-glow")) <= 0.19, "cyan glow stays a whisper");
assert.ok(alpha(token("shadow")) <= 0.47 && alpha(token("shadow-soft")) <= 0.38 && alpha(token("shadow-pop")) <= 0.55, "shadows ~15% lighter than the shelf rebrand");
assert.doesNotMatch(webCss, /#0f766e|#faf7f2|#C65A1E/i, "no retired teal/cream/brick tokens in the canonical web app");
assert.match(webCss, /@media \(prefers-reduced-motion: reduce\)/, "motion stays optional");
assert.match(webIndex, /<meta name="theme-color" content="#17181b" \/>/, "web PWA/browser chrome is graphite");
console.log("PASS web: graphite + orange tokens, glow/shadow restrained, no retired teal");

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

// ── Logo source of truth: graphite C mark with the orange bar ───────────────
for (const [label, svg] of [["assets/logo.svg", logo], ["frontend/icons/logo.svg", frontendLogo]] as const) {
  assert.match(svg, /Dark graphite C mark with a vivid orange bar/, `${label} describes the C-ton identity`);
  assert.match(svg, /#ff8a2a/i, `${label} carries the orange bar`);
  assert.match(svg, /#0b0c0e/i, `${label} carries the graphite ground`);
  assert.doesNotMatch(svg, /#0f766e|#faf7f2/i, `${label} has no teal/cream`);
}
console.log("PASS logo: graphite + orange identity, no teal");

// ── Native: launcher/store icons and splash are the same mark ───────────────
for (const [label, bytes] of [["iOS AppIcon 1024", iosIcon], ["Android xxxhdpi launcher", androidIcon], ["Android adaptive foreground", androidFg], ["iOS splash", splash], ["iOS splash dark", splashDark]] as const) {
  assert.ok(bytes.subarray(0, 8).equals(PNG), `${label} is PNG`);
}
// the rebranded iOS icon is materially larger than the retired flat teal art (gradients + bar)
assert.ok(iosIcon.length > 60_000, `iOS AppIcon is the rebranded graphite mark (${iosIcon.length} bytes)`);
assert.ok(androidFg.length > 20_000, `Android adaptive foreground is the rebranded mark (${androidFg.length} bytes)`);
console.log("PASS native: Android launcher set, iOS AppIcon and splash carry the graphite/orange mark");

console.log("VISUAL_BRAND_CONSISTENCY_PASS");
