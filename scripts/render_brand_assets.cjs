#!/usr/bin/env node
// Renders the C-ton raster brand files from their vector sources.
//
// 2026-09-24 visual refresh ("Daylight"): the brand is now drawn as vectors in
// assets/brand/ (c-ton-mark.svg, c-ton-wordmark.svg). The web app still loads
// the same raster file NAMES under web/public/brand/, so no code path, cache
// rule or share-preview URL changed — only the pixels. Re-run after editing an
// SVG source:   node scripts/render_brand_assets.cjs
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const root = path.resolve(__dirname, "..");
const src = (name) => fs.readFileSync(path.join(root, "assets/brand", name), "utf8");
const out = (name) => path.join(root, "web/public/brand", name);

// inner markup of an SVG file, for composing the lockup
function inner(svg) {
  return svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/<title[\s\S]*?<\/title>|<desc[\s\S]*?<\/desc>/g, "");
}

// The lockup: the mark over the wordmark on a daylight card, circled by a ring
// of "participants" — some joined (indigo), the newest arriving (coral), the
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
    const fill = joined ? "#4a3aff" : arriving ? "#ff5a36" : "#ffffff";
    const stroke = joined || arriving ? "none" : "#cdd2df";
    const op = joined ? (0.35 + 0.65 * (i / 10)).toFixed(2) : "1";
    dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${fill}" fill-opacity="${op}" stroke="${stroke}" stroke-width="${(markSize * 0.012).toFixed(1)}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#f1f2fb"/></linearGradient>
    <radialGradient id="glow" cx=".5" cy=".3" r=".55"><stop offset="0" stop-color="#4a3aff" stop-opacity=".16"/><stop offset="1" stop-color="#4a3aff" stop-opacity="0"/></radialGradient>
    <radialGradient id="warm" cx=".85" cy="1" r=".6"><stop offset="0" stop-color="#ff5a36" stop-opacity=".10"/><stop offset="1" stop-color="#ff5a36" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect width="100%" height="100%" fill="url(#glow)"/>
  <rect width="100%" height="100%" fill="url(#warm)"/>
  <circle cx="${cx}" cy="${ringCy}" r="${ringR.toFixed(1)}" fill="none" stroke="#e3e6ef" stroke-width="${(markSize * 0.01).toFixed(1)}"/>
  ${dots.join("\n  ")}
  <svg x="${cx - markSize / 2}" y="${markY}" width="${markSize}" height="${markSize}" viewBox="0 0 1024 1024">${inner(src("c-ton-mark.svg"))}</svg>
  <svg x="${cx - wordW / 2}" y="${wordY}" width="${wordW}" height="${wordH}" viewBox="-18 0 540 140">${inner(src("c-ton-wordmark.svg"))}</svg>
</svg>`;
}

async function main() {
  const mark = Buffer.from(src("c-ton-mark.svg"));
  const word = Buffer.from(src("c-ton-wordmark.svg"));
  const jobs = [
    ["c-ton-mark.png", sharp(mark, { density: 144 }).resize(512, 512).png({ compressionLevel: 9 })],
    ["c-ton-mark-180.png", sharp(mark, { density: 72 }).resize(180, 180).png({ compressionLevel: 9 })],
    ["favicon-64.png", sharp(mark, { density: 72 }).resize(64, 64).png({ compressionLevel: 9 })],
    ["c-ton-wordmark.png", sharp(word, { density: 144 }).resize(540, 140).png({ compressionLevel: 9 })],
    ["c-ton-logo-1024.jpg", sharp(Buffer.from(lockup(1024, 683))).flatten({ background: "#ffffff" }).jpeg({ quality: 90, chromaSubsampling: "4:4:4" })],
    ["c-ton-logo.png", sharp(Buffer.from(lockup(1536, 1024))).png({ compressionLevel: 9 })]
  ];
  for (const [name, pipeline] of jobs) {
    await pipeline.toFile(out(name));
    const meta = await sharp(out(name)).metadata();
    console.log(`BRAND_ASSET ${name} ${meta.width}x${meta.height} ${fs.statSync(out(name)).size}B`);
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
