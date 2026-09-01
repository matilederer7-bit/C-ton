import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [app, css, index, manifestRaw, worker, logo, reference, pwaIcon] = await Promise.all([
  readFile("frontend/app.js", "utf8"),
  readFile("frontend/styles.css", "utf8"),
  readFile("frontend/index.html", "utf8"),
  readFile("frontend/manifest.webmanifest", "utf8"),
  readFile("frontend/service-worker.js", "utf8"),
  readFile("frontend/icons/logo.svg", "utf8"),
  readFile("frontend/icons/c-ton-brand-reference.png"),
  readFile("frontend/icons/icon-512.png")
]);

const manifest = JSON.parse(manifestRaw);
const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

assert.match(css, /color-scheme:\s*dark/);
assert.match(css, /--bg:\s*#101113/);
assert.match(css, /--surface:\s*#1a1c1f/);
assert.match(css, /--primary:\s*#ff6b0b/i);
assert.match(css, /body\[data-surface="admin"\]/);
assert.match(css, /body\[data-surface="seller"\]/);
assert.match(css, /url\('\/app\/icons\/c-ton-brand-reference\.png'\)/);
assert.match(css, /\.brand-loader-mark[^}]*animation:\s*cton-breathe/s);
assert.match(css, /@keyframes\s+cton-breathe/);
assert.match(css, /\.brand-loader-skeleton/);
assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
assert.match(css, /\.cton-mall-card:hover/);
assert.match(css, /body\[data-surface="admin"\][^}]*\.shell/s);
assert.match(css, /table\s*\{[^}]*border-collapse/s);

assert.match(app, /function renderBrandLockup/);
assert.match(app, /function renderBrandedLoader/);
assert.match(app, /function getProductSurface/);
assert.match(app, /document\.body\.dataset\.surface\s*=\s*getProductSurface\(\)/);
assert.match(app, /state\.loading\s*\?\s*renderBrandedLoader/);
assert.match(app, /renderBrandedLoader\("טוען את ביצועי המוכר\.\.\."/);
assert.match(app, /renderBrandLockup\(\{ compact: true \}\)/);
assert.match(app, /absoluteUrl\("\/app\/icons\/c-ton-brand-reference\.png"\)/);

assert.match(index, /meta name="theme-color" content="#111214"/);
assert.match(index, /class="brand-boot"/);
assert.match(index, /class="brand-loader-mark"/);
assert.match(index, /\/app\/icons\/c-ton-brand-reference\.png/);
assert.equal(manifest.name, "C-ton");
assert.equal(manifest.background_color, "#101113");
assert.equal(manifest.theme_color, "#111214");
assert.equal(manifest.icons.every((icon: any) => icon.type === "image/png" && icon.src.endsWith(".png")), true);
assert.match(worker, /siton-shell-v3-dark-brand/);
assert.match(worker, /c-ton-brand-reference\.png/);

assert.match(logo, /Dark graphite C mark with a vivid orange bar/);
assert.match(logo, /#ff8a2a/i);
assert.match(logo, /#0b0c0e/i);
assert.equal(reference.subarray(0, pngMagic.length).equals(pngMagic), true);
assert.equal(pwaIcon.subarray(0, pngMagic.length).equals(pngMagic), true);
assert.doesNotMatch([index, manifestRaw, logo].join("\n"), /#0f766e/i);

console.log("PASS C-ton graphite tokens and orange hierarchy are canonical");
console.log("PASS branded loader, skeleton, reduced motion and surface routing are present");
console.log("PASS public reference art, SVG identity, PWA metadata and PNG icons are aligned");
