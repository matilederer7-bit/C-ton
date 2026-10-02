// ── CMS hero video conversion, IN A REAL BROWSER ─────────────────────────────
// Owner report 2026-10-02: a phone video "does not upload". The editor now
// re-encodes any video that is not already a small MP4/WebM in the admin's
// browser (web/src/videoConvert.ts). This proves it in Chromium:
//   * a 1920x1080 clip handed over as an iPhone-style `video/quicktime` file is
//     converted to an MP4 or WebM that is <= 10 MB, at most 1280 wide, about
//     as long as the source, playable by a <video> element, and accepted by the
//     server's own validator (src/content_media.ts validateVideoFile);
//   * progress is reported from 0 to 1;
//   * a ceiling the clip cannot fit fails with a clear `too_large`, never a
//     silently oversized upload; a non-video blob fails with `unreadable`.
// The source clip is recorded in the browser itself (canvas + MediaRecorder);
// the converter is the repository module, transpiled as-is and served as an
// ES module. No server, database or network outside 127.0.0.1.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromiumPath, launchPage, type BrowserPage } from "./helpers/browser_cdp.js";
import { validateVideoFile } from "../src/content_media.js";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const MAX = 10 * 1024 * 1024;

async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; }
}

async function moduleSource(file: string): Promise<string> {
  const ts = require("typescript");
  const source = await readFile(join(repoRoot, "web", "src", file), "utf8");
  const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 } }).outputText as string;
  return out.replace(/from "\.\/(video\w+)"/g, 'from "./$1.js"').replace(/import\("mediabunny"\)/g, 'import("./mediabunny.js")');
}

async function serve(port: number): Promise<Server> {
  const files: Record<string, [string, string]> = {
    // every MediaRecorder the converter creates is tracked, so a failure path that leaves one recording is caught
    "/": ["text/html", "<!doctype html><meta charset=utf-8><title>video convert</title><body><script>window.__recorders = []; const R = window.MediaRecorder; window.MediaRecorder = class extends R { constructor(...a) { super(...a); window.__recorders.push(this); } };</script><script type=module>import * as m from './videoConvert.js'; import * as x from './videoTranscode.js'; window.__convert = m; window.__tx = x;</script></body>"],
    "/videoConvert.js": ["text/javascript", await moduleSource("videoConvert.ts")],
    "/videoPrep.js": ["text/javascript", await moduleSource("videoPrep.ts")],
    "/videoErrors.js": ["text/javascript", await moduleSource("videoErrors.ts")],
    "/videoTranscode.js": ["text/javascript", await moduleSource("videoTranscode.ts")],
    // the same library build the web bundle uses, served as one ES module
    "/mediabunny.js": ["text/javascript", await readFile(join(repoRoot, "web", "node_modules", "mediabunny", "dist", "bundles", "mediabunny.min.mjs"), "utf8")]
  };
  const server = createServer((req, res) => {
    const hit = files[String(req.url || "/").split("?")[0] ?? "/"];
    if (!hit) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": hit[0], "cache-control": "no-store" }).end(hit[1]);
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

// Records a `seconds`-long 1920x1080 clip in the page and keeps it as window.__source.
const RECORD_SOURCE = (seconds: number) => `(async () => {
  const c = document.createElement('canvas'); c.width = 1920; c.height = 1080;
  const g = c.getContext('2d'); const stream = c.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm', videoBitsPerSecond: 8000000 }); const parts = [];
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  const done = new Promise((r) => { rec.onstop = r; });
  rec.start(250); const t0 = performance.now();
  await new Promise((resolve) => { const tick = () => { const t = (performance.now() - t0) / 1000;
    g.fillStyle = 'hsl(' + Math.floor(t * 90) % 360 + ',70%,50%)'; g.fillRect(0, 0, 1920, 1080);
    for (let i = 0; i < 40; i += 1) { g.fillStyle = 'hsl(' + (i * 37 + t * 200) % 360 + ',80%,60%)'; g.fillRect((i * 97 + t * 400) % 1920, (i * 53) % 1080, 120, 120); }
    if (t < ${seconds}) requestAnimationFrame(tick); else resolve(); }; tick(); });
  rec.stop(); await done;
  window.__source = new File(parts, 'IMG_0420.MOV', { type: 'video/quicktime' });
  return window.__source.size;
})()`;

async function main() {
  if (!chromiumPath()) {
    if (process.env.CI) throw new Error("no Chromium available — the CMS video conversion browser gate cannot be skipped in CI");
    console.log("CMS_VIDEO_CONVERT_BROWSER SKIP — no Chromium available");
    return;
  }
  const port = 3397;
  const server = await serve(port);
  let page: BrowserPage | null = null;
  try {
    page = await launchPage(`http://127.0.0.1:${port}/`);
    for (let i = 0; i < 40 && !(await page.evaluate<boolean>("!!window.__convert")); i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.equal(await page.evaluate<boolean>("!!window.__convert"), true, "the converter module did not load");
    const sourceBytes = await page.evaluate<number>(RECORD_SOURCE(4));
    assert.ok(sourceBytes > 0, "the source clip was not recorded");

    await run("the WebCodecs engine handles the clip on its own (no fallback)", async () => {
      const r = await page!.evaluate<any>(`window.__tx.transcodeWithWebCodecs(window.__source, { maxBytes: ${MAX} }).then((o) => ({ ok: true, size: o.blob.size }), (e) => ({ ok: false, code: e.code, detail: e.detail || String(e) }))`);
      assert.equal(r.ok, true, `WebCodecs engine failed: ${JSON.stringify(r)}`);
    });

    await run("an iPhone-style .MOV clip becomes a playable, bounded MP4/WebM the server accepts", async () => {
      const r = await page!.evaluate<any>(`(async () => {
        const progress = []; const recordersBefore = window.__recorders.length;
        const out = await window.__convert.convertVideoForHero(window.__source, { maxBytes: ${MAX}, onProgress: (f) => progress.push(f) });
        const usedRecorder = window.__recorders.length !== recordersBefore;
        const url = URL.createObjectURL(out.blob); const v = document.createElement('video'); v.muted = true; v.src = url;
        await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('converted video does not load')); });
        // MediaRecorder output may report Infinity until seeked to the end
        if (!Number.isFinite(v.duration)) { v.currentTime = 1e6; await new Promise((res) => { v.ondurationchange = res; setTimeout(res, 2000); }); }
        const bytes = new Uint8Array(await out.blob.arrayBuffer());
        let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return { mime: out.mime, type: out.blob.type, size: out.blob.size, w: v.videoWidth, h: v.videoHeight, duration: v.duration,
                 first: progress[0], last: progress[progress.length - 1], steps: progress.length, b64: btoa(bin), usedRecorder };
      })()`);
      console.log(`converted ${r.mime} ${r.size} bytes ${r.w}x${r.h} ${r.duration.toFixed(2)}s (source ${sourceBytes} bytes)`);
      assert.ok(["video/mp4", "video/webm"].includes(r.mime), r.mime);
      assert.equal(r.type, r.mime);
      assert.ok(r.size > 0 && r.size <= MAX, `converted size ${r.size}`);
      assert.ok(r.w > 0 && r.w <= 1280 && r.h <= 720, `converted frame ${r.w}x${r.h}`);
      assert.ok(Number.isFinite(r.duration) && r.duration > 2.5 && r.duration < 6, `converted duration ${r.duration}`);
      assert.ok(r.steps > 3 && r.first < 0.5 && r.last === 1, `progress ${JSON.stringify({ first: r.first, last: r.last, steps: r.steps })}`);
      assert.equal(validateVideoFile({ mimeType: r.mime, content: Buffer.from(r.b64, "base64") }), r.mime, "the server validator refused the converted video");
      assert.equal(r.usedRecorder, false, "the WebCodecs engine must not fall back to real-time recording in Chromium");
    });

    await run("a portrait phone MP4 (1080x1920, like the owner's 27 s clip, shortened) converts with WebCodecs to 720x1280, frame by frame", async () => {
      // The source MP4 is built frame by frame with the same library (H.264 where this
      // browser can encode it, else VP9 in MP4) — no real-time recording involved.
      const r = await page!.evaluate<any>(`(async () => {
        const mb = await import('./mediabunny.js');
        let srcCodec = null; for (const c of ['avc', 'vp9', 'av1']) { if (await mb.canEncodeVideo(c, { width: 1080, height: 1920, quality: new mb.Quality({ bitrate: 8000000 }) })) { srcCodec = c; break; } }
        const c = document.createElement('canvas'); c.width = 1080; c.height = 1920; const g = c.getContext('2d');
        const target = new mb.BufferTarget(); const out = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target });
        const vs = new mb.CanvasSource(c, { codec: srcCodec, quality: new mb.Quality({ bitrate: 8000000 }) });
        out.addVideoTrack(vs, { frameRate: 30 }); await out.start();
        for (let i = 0; i < 90; i += 1) { const t = i / 30;
          g.fillStyle = 'hsl(' + Math.floor(t * 120) % 360 + ',70%,45%)'; g.fillRect(0, 0, 1080, 1920);
          for (let k = 0; k < 30; k += 1) { g.fillStyle = 'hsl(' + (k * 41 + t * 160) % 360 + ',80%,60%)'; g.fillRect((k * 71 + t * 300) % 1080, (k * 113 + t * 200) % 1920, 140, 140); }
          await vs.add(t, 1 / 30); }
        await out.finalize();
        const source = new File([target.buffer], 'VID_20261002.mp4', { type: 'video/mp4' });
        const before = window.__recorders.length; const progress = []; const t0 = performance.now();
        const res = await window.__convert.convertVideoForHero(source, { maxBytes: ${MAX}, onProgress: (f) => progress.push(f) });
        const ms = Math.round(performance.now() - t0);
        const v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(res.blob);
        await new Promise((ok, no) => { v.onloadedmetadata = ok; v.onerror = () => no(new Error('converted video does not load')); });
        const head = new Uint8Array(await res.blob.slice(0, 12).arrayBuffer());
        return { srcCodec, mime: res.mime, size: res.blob.size, w: v.videoWidth, h: v.videoHeight, duration: v.duration, sourceBytes: source.size,
                 sig: head[0] === 0x1a ? 'ebml' : String.fromCharCode(head[4], head[5], head[6], head[7]), recorders: window.__recorders.length - before,
                 steps: progress.length, last: progress[progress.length - 1], ms };
      })()`);
      console.log(`portrait ${r.srcCodec}/mp4 ${r.sourceBytes} -> ${r.mime} ${r.size} bytes ${r.w}x${r.h} ${Number(r.duration).toFixed(2)}s in ${r.ms} ms`);
      assert.ok(r.srcCodec, "this browser could not build the source clip");
      assert.equal(r.recorders, 0, "the conversion fell back to real-time recording");
      assert.ok(["video/mp4", "video/webm"].includes(r.mime), r.mime);
      assert.equal(r.sig, r.mime === "video/mp4" ? "ftyp" : "ebml", "container signature does not match the type");
      assert.deepEqual([r.w, r.h], [720, 1280], "portrait orientation and the 1280 long edge");
      assert.ok(r.duration > 2.5 && r.duration < 3.6, `duration ${r.duration}`);
      assert.ok(r.size > 0 && r.size <= MAX, `size ${r.size}`);
      assert.ok(r.steps > 1 && r.last === 1, `progress ${JSON.stringify({ steps: r.steps, last: r.last })}`);
    });

    await run("a ceiling the clip cannot fit fails with too_large, never an oversized upload", async () => {
      const code = await page!.evaluate<string>(`window.__convert.convertVideoForHero(window.__source, { maxBytes: 4096 }).then(() => 'resolved', (e) => e.code || String(e))`);
      assert.equal(code, "too_large");
    });

    await run("a file that is not a playable video fails with unreadable", async () => {
      const code = await page!.evaluate<string>(`window.__convert.convertVideoForHero(new File([new Uint8Array(2048).fill(7)], 'x.mov', { type: 'video/quicktime' }), { maxBytes: ${MAX} }).then(() => 'resolved', (e) => e.code || String(e))`);
      assert.equal(code, "unreadable");
    });

    await run("leaving the page mid-conversion stops at once with interrupted, never a frozen clip", async () => {
      const code = await page!.evaluate<string>(`(async () => {
        const p = window.__convert.convertRealtime(window.__source, { maxBytes: ${MAX} });
        await new Promise((r) => setTimeout(r, 1200));
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
        try { await p; return 'resolved'; } catch (e) { return e.code || String(e); } finally { delete document.hidden; }
      })()`);
      assert.equal(code, "interrupted");
    });

    await run("the clip being prepared is a visible preview (Android browsers pause invisible muted video)", async () => {
      const seen = await page!.evaluate<any>(`(async () => {
        const p = window.__convert.convertRealtime(window.__source, { maxBytes: ${MAX} });
        await new Promise((r) => setTimeout(r, 1200));
        const v = document.querySelector('[data-testid="hero-video-converting"]');
        const r = v ? v.getBoundingClientRect() : null; const cs = v ? getComputedStyle(v) : null;
        const snap = v ? { w: r.width, h: r.height, inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, opacity: cs.opacity, display: cs.display, visibility: cs.visibility, playing: !v.paused } : null;
        await p; return snap;
      })()`);
      assert.ok(seen, "no preview element during conversion");
      assert.ok(seen.w >= 100 && seen.h >= 40, `preview too small to count as visible: ${JSON.stringify(seen)}`);
      assert.equal(seen.inView, true, "preview is outside the viewport");
      assert.notEqual(seen.display, "none");
      assert.deepEqual([seen.opacity, seen.visibility, seen.playing], ["1", "visible", true]);
    });

    await run("a browser that pauses the clip mid-way is resumed and the conversion still completes", async () => {
      const r = await page!.evaluate<any>(`(async () => {
        const p = window.__convert.convertRealtime(window.__source, { maxBytes: ${MAX} });
        await new Promise((r) => setTimeout(r, 1500));
        document.querySelector('[data-testid="hero-video-converting"]').pause();
        const out = await p; return { mime: out.mime, size: out.blob.size };
      })()`);
      assert.ok(["video/mp4", "video/webm"].includes(r.mime) && r.size > 0, JSON.stringify(r));
    });

    await run("a clip that stops advancing fails with stalled and a diagnostic detail, not an endless spinner", async () => {
      const r = await page!.evaluate<any>(`(async () => {
        const p = window.__convert.convertRealtime(window.__source, { maxBytes: ${MAX} });
        await new Promise((r) => setTimeout(r, 1500));
        document.querySelector('[data-testid="hero-video-converting"]').playbackRate = 0;
        const t0 = performance.now();
        try { await p; return { code: 'resolved' }; } catch (e) { return { code: e.code, detail: e.detail, waited: performance.now() - t0 }; }
      })()`);
      assert.equal(r.code, "stalled", JSON.stringify(r));
      assert.ok(r.waited < 15000, `took ${r.waited} ms to give up`);
      assert.match(r.detail, /^engine=realtime stage=record t=\d+\.\d\/\d+\.\d ready=\d net=\d paused=(true|false) frame=1920x1080 src=video\/quicktime mb=\d+\.\d rec=video\/\S+ browser=\S/);
    });

    await run("no failure path leaves a recorder running or a hidden video behind", async () => {
      await new Promise((r) => setTimeout(r, 300));
      const left = await page!.evaluate<any>(`({ recorders: window.__recorders.length, active: window.__recorders.filter((r) => r.state !== 'inactive').length, videos: document.querySelectorAll('video').length })`);
      assert.ok(left.recorders >= 2, `expected the conversions above to create recorders: ${JSON.stringify(left)}`);
      assert.equal(left.active, 0, `a recorder is still running: ${JSON.stringify(left)}`);
      assert.equal(left.videos, 0, "a hidden <video> was left in the document");
    });

    const errors = page.errors().filter((e) => !/favicon/.test(e.text));
    assert.deepEqual(errors, [], "browser errors during conversion");
    console.log("CMS_VIDEO_CONVERT_BROWSER_PASS");
  } finally {
    await page?.close().catch(() => undefined);
    server.close();
  }
}

await main();
