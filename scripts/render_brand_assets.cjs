#!/usr/bin/env node
// Renders every raster brand file from the two vector sources.
//
// 2026-09-25 "Graphite Mint": the brand is drawn as vectors in assets/brand/
// (c-ton-mark.svg: a white C on a graphite tile with the short mint dash in
// its opening; c-ton-wordmark.svg: graphite C-ton with the same mint dash).
// Everything below is derived from them, so a change to the mark is one edit,
// then:
//
//   node scripts/render_brand_assets.cjs      # web + PWA icons + native inputs
//   npm run mobile:assets                     # native icon/splash catalogs
//
// Outputs (same file NAMES as before, so no URL, cache rule, manifest entry,
// share-preview path or Xcode/Gradle reference changes):
//   web/public/brand/   c-ton-mark.png, c-ton-mark-180.png, favicon-64.png,
//                       c-ton-wordmark.png, c-ton-logo-1024.jpg, c-ton-logo.png
//   frontend/icons/     icon-{48,72,96,128,192,256,512}.png  (legacy /app PWA;
//                       full-bleed squares because the manifest declares them
//                       "any maskable" and the OS applies its own mask)
//   assets/native/      icon-only.png, icon-foreground.png, icon-background.png,
//                       splash.png, splash-dark.png — the "custom mode" inputs
//                       @capacitor/assets turns into the iOS AppIcon + Splash
//                       catalogs and the Android launcher + splash resources.
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const root = path.resolve(__dirname, "..");
const src = (name) => fs.readFileSync(path.join(root, "assets/brand", name), "utf8");
const out = (dir, name) => { fs.mkdirSync(path.join(root, dir), { recursive: true }); return path.join(root, dir, name); };

// inner markup of an SVG file, for composing the lockup and the splash. The two
// sources keep DISTINCT filter ids (mark-dash-glow / word-dash-glow): when both
// are inlined into one document a shared id would resolve to the first filter,
// and the wordmark's dash would take the mark's much larger blur.
function inner(svg) {
  return svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/<title[\s\S]*?<\/title>|<desc[\s\S]*?<\/desc>/g, "");
}

// the locked palette (docs/BRAND_GRAPHITE_MINT.md)
const GRAPHITE = "#0f172a", GRAPHITE_DEEP = "#020617", MINT = "#2dd4bf", SAND = "#d6c7a7", GROUND = "#f8fafc";
// the mark's tile (flat graphite) and glyph (white C + mint dash with its glow), separately
const MARK_DEFS = inner(src("c-ton-mark.svg")).match(/<defs>[\s\S]*?<\/defs>/)[0];
const MARK_GLYPH = inner(src("c-ton-mark.svg")).replace(/<defs>[\s\S]*?<\/defs>/, "").replace(/<rect width="1024" height="1024"[^>]*\/>/g, "");
const TILE = (rx) => `<rect width="1024" height="1024" rx="${rx}" fill="${GRAPHITE}"/>`;
const svgDoc = (w, h, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`);

// full-bleed square mark: what an OS masks itself (iOS AppIcon, PWA maskable,
// Android legacy launcher)
const squareMark = () => svgDoc(1024, 1024, `${MARK_DEFS}${TILE(0)}${MARK_GLYPH}`);
// Android adaptive foreground: glyph only, enlarged about the centre so that
// after the launcher's 16.7% inset it still fills the 66% safe zone well
const adaptiveForeground = () => svgDoc(1024, 1024, `${MARK_DEFS}<g transform="translate(512 512) scale(1.28) translate(-512 -512)">${MARK_GLYPH}</g>`);
const adaptiveBackground = () => svgDoc(1024, 1024, `${MARK_DEFS}${TILE(0)}`);

// splash: the rounded mark over the wordmark, centred, inside the middle 40%
// so Android's centre-crop at every aspect ratio keeps it whole
function splash(dark) {
  const S = 2732, cx = S / 2;
  const markSize = 560, wordW = 700, wordH = Math.round(wordW * 140 / 540), gap = 96;
  const total = markSize + gap + wordH, top = (S - total) / 2;
  // on the dark splash the graphite letters turn white; the mint dash stays
  const word = dark ? inner(src("c-ton-wordmark.svg")).replace(/#0f172a/gi, "#ffffff") : inner(src("c-ton-wordmark.svg"));
  const glow = `<radialGradient id="g" cx=".5" cy=".42" r=".5"><stop offset="0" stop-color="${MINT}" stop-opacity="${dark ? ".22" : ".14"}"/><stop offset="1" stop-color="${MINT}" stop-opacity="0"/></radialGradient>`;
  const bg = `<rect width="100%" height="100%" fill="${dark ? GRAPHITE_DEEP : GROUND}"/>${glow}<rect width="100%" height="100%" fill="url(#g)"/>`;
  return svgDoc(S, S, `${bg}
  <svg x="${cx - markSize / 2}" y="${top}" width="${markSize}" height="${markSize}" viewBox="0 0 1024 1024">${inner(src("c-ton-mark.svg"))}</svg>
  <svg x="${cx - wordW / 2}" y="${top + markSize + gap}" width="${wordW}" height="${wordH}" viewBox="-18 0 540 140">${word}</svg>`);
}

// The lockup: the mark over the wordmark on the paper ground, circled by a ring
// of "participants" — some joined (graphite), the newest arriving (mint), the
// rest still open (hairline). It is the group-buying idea without a word.
function lockup(width, height) {
  const cx = width / 2;
  const markSize = Math.round(height * 0.3);
  const ringR = markSize * 0.84;
  const gap = Math.round(height * 0.08);
  const wordW = Math.round(markSize * 2);
  const wordH = Math.round(wordW * 140 / 540);
  const total = 2 * ringR + gap + wordH;
  const ringCy = (height - total) / 2 + ringR;
  const markY = ringCy - markSize / 2;
  const wordY = ringCy + ringR + gap;
  const dots = [];
  const n = 18;
  for (let i = 0; i < n; i++) {
    const a = (-90 + (360 / n) * i) * Math.PI / 180;
    const x = cx + ringR * Math.cos(a);
    const y = ringCy + ringR * Math.sin(a);
    const joined = i < 11;
    const arriving = i === 11 || i === 12;
    const r = arriving ? markSize * 0.045 : markSize * 0.035;
    const fill = joined ? GRAPHITE : arriving ? MINT : "#ffffff";
    const stroke = joined || arriving ? "none" : "#cbd5e1";
    const op = joined ? (0.35 + 0.65 * (i / 10)).toFixed(2) : "1";
    dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${fill}" fill-opacity="${op}" stroke="${stroke}" stroke-width="${(markSize * 0.012).toFixed(1)}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#f1f5f9"/></linearGradient>
    <radialGradient id="glow" cx=".5" cy=".3" r=".55"><stop offset="0" stop-color="${MINT}" stop-opacity=".16"/><stop offset="1" stop-color="${MINT}" stop-opacity="0"/></radialGradient>
    <radialGradient id="warm" cx=".85" cy="1" r=".6"><stop offset="0" stop-color="${SAND}" stop-opacity=".22"/><stop offset="1" stop-color="${SAND}" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect width="100%" height="100%" fill="url(#glow)"/>
  <rect width="100%" height="100%" fill="url(#warm)"/>
  <circle cx="${cx}" cy="${ringCy}" r="${ringR.toFixed(1)}" fill="none" stroke="#e5e7eb" stroke-width="${(markSize * 0.01).toFixed(1)}"/>
  ${dots.join("\n  ")}
  <svg x="${cx - markSize / 2}" y="${markY}" width="${markSize}" height="${markSize}" viewBox="0 0 1024 1024">${inner(src("c-ton-mark.svg"))}</svg>
  <svg x="${cx - wordW / 2}" y="${wordY}" width="${wordW}" height="${wordH}" viewBox="-18 0 540 140">${inner(src("c-ton-wordmark.svg"))}</svg>
</svg>`;
}

// Android adaptive-icon layers are 108dp drawables. @capacitor/assets writes
// them at the 48dp launcher sizes (192px at xxxhdpi), which Android then
// upscales; this renders them at their native 108dp sizes instead, so the
// launcher icon stays crisp. `npm run mobile:assets` runs this after the tool.
const ADAPTIVE_DP = 108;
const ANDROID_DENSITIES = { ldpi: 0.75, mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
async function renderAdaptiveLayers() {
  for (const [bucket, scale] of Object.entries(ANDROID_DENSITIES)) {
    const size = Math.round(ADAPTIVE_DP * scale);
    const dir = `android/app/src/main/res/mipmap-${bucket}`;
    if (!fs.existsSync(path.join(root, dir))) continue;
    await sharp(adaptiveForeground(), { density: 144 }).resize(size, size).png({ compressionLevel: 9 }).toFile(out(dir, "ic_launcher_foreground.png"));
    await sharp(adaptiveBackground(), { density: 144 }).resize(size, size).flatten({ background: GRAPHITE }).png({ compressionLevel: 9 }).toFile(out(dir, "ic_launcher_background.png"));
    console.log(`BRAND_ASSET ${dir}/ic_launcher_{foreground,background}.png ${size}x${size}`);
  }
}

async function main() {
  if (process.argv.includes("--native-layers")) return renderAdaptiveLayers();
  const mark = Buffer.from(src("c-ton-mark.svg"));
  const word = Buffer.from(src("c-ton-wordmark.svg"));
  const png = (input, size, density) => sharp(input, { density }).resize(size, size).png({ compressionLevel: 9 });
  const jobs = [
    // web app
    ["web/public/brand", "c-ton-mark.png", png(mark, 512, 144)],
    ["web/public/brand", "c-ton-mark-180.png", png(mark, 180, 72)],
    ["web/public/brand", "favicon-64.png", png(mark, 64, 72)],
    ["web/public/brand", "c-ton-wordmark.png", sharp(word, { density: 288 }).resize(1080, 280).png({ compressionLevel: 9 })],
    ["web/public/brand", "c-ton-logo-1024.jpg", sharp(Buffer.from(lockup(1024, 683))).flatten({ background: "#ffffff" }).jpeg({ quality: 90, chromaSubsampling: "4:4:4" })],
    ["web/public/brand", "c-ton-logo.png", sharp(Buffer.from(lockup(1536, 1024))).png({ compressionLevel: 9 })],
    // legacy /app PWA icon set (manifest: "any maskable")
    ...[48, 72, 96, 128, 192, 256, 512].map((size) => ["frontend/icons", `icon-${size}.png`, png(squareMark(), size, size >= 256 ? 144 : 72)]),
    // @capacitor/assets custom-mode inputs
    ["assets/native", "icon-only.png", sharp(squareMark(), { density: 144 }).resize(1024, 1024).flatten({ background: GRAPHITE }).png({ compressionLevel: 9 })],
    ["assets/native", "icon-foreground.png", png(adaptiveForeground(), 1024, 144)],
    ["assets/native", "icon-background.png", sharp(adaptiveBackground(), { density: 144 }).resize(1024, 1024).flatten({ background: GRAPHITE }).png({ compressionLevel: 9 })],
    ["assets/native", "splash.png", sharp(splash(false), { density: 96 }).resize(2732, 2732).flatten({ background: GROUND }).png({ compressionLevel: 9 })],
    ["assets/native", "splash-dark.png", sharp(splash(true), { density: 96 }).resize(2732, 2732).flatten({ background: GRAPHITE_DEEP }).png({ compressionLevel: 9 })]
  ];
  for (const [dir, name, pipeline] of jobs) {
    const file = out(dir, name);
    await pipeline.toFile(file);
    const meta = await sharp(file).metadata();
    console.log(`BRAND_ASSET ${dir}/${name} ${meta.width}x${meta.height} ${fs.statSync(file).size}B`);
  }
  // the legacy shell's favicon and the logo source of truth are the same vector
  fs.copyFileSync(path.join(root, "assets/brand/c-ton-mark.svg"), path.join(root, "frontend/icons/logo.svg"));
  fs.copyFileSync(path.join(root, "assets/brand/c-ton-mark.svg"), path.join(root, "assets/logo.svg"));
  console.log("BRAND_ASSET frontend/icons/logo.svg + assets/logo.svg = assets/brand/c-ton-mark.svg");
}
main().catch((error) => { console.error(error); process.exit(1); });
