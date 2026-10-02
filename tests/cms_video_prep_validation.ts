// ── CMS hero video: which files upload as-is and which are converted first ───
// Owner report 2026-10-02: "the video does not upload". A phone hands the CMS
// an iPhone .MOV (video/quicktime) or a clip above 10 MB; the editor refused it
// in the browser, so no request ever reached the server. The editor now uploads
// only a small MP4/WebM as-is and re-encodes every other video in the browser
// (web/src/videoConvert.ts; proven in Chromium by
// tests/frontend_browser_cms_video_convert_validation.ts). This file pins the
// pure policy (web/src/videoPrep.ts) and its wiring into the upload path.
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import {
  DIRECT_VIDEO_TYPES, HERO_VIDEO_MAX_BITRATE, HERO_VIDEO_MAX_EDGE, HERO_VIDEO_MAX_SECONDS,
  heroVideoBitrate, pickRecorderType, planVideoUpload, scaledVideoSize, sniffVideoContainer, videoTypeOf
} from "../web/src/videoPrep.js";
import { CONTENT_VIDEO_MAX_BYTES, CONTENT_VIDEO_MIME_TYPES } from "../src/content_media.js";

async function run(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`PASS ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; }
}

const MB = 1024 * 1024;
const MAX = 10 * MB;

await run("direct upload only for a small MP4/WebM; phone formats and oversize clips are converted", () => {
  assert.equal(planVideoUpload({ type: "video/mp4", name: "a.mp4", size: 3 * MB }, MAX), "direct");
  assert.equal(planVideoUpload({ type: "video/webm", name: "a.webm", size: MAX }, MAX), "direct");
  assert.equal(planVideoUpload({ type: "video/mp4", name: "a.mp4", size: MAX + 1 }, MAX), "convert", "an MP4 over 10 MB is converted, not refused");
  assert.equal(planVideoUpload({ type: "video/quicktime", name: "IMG_0001.MOV", size: 2 * MB }, MAX), "convert", "an iPhone .MOV is converted");
  assert.equal(planVideoUpload({ type: "", name: "IMG_0001.MOV", size: 40 * MB }, MAX), "convert", "a .MOV without a MIME type is recognized by its extension");
  assert.equal(planVideoUpload({ type: "video/3gpp", name: "clip.3gp", size: MB }, MAX), "convert");
  assert.equal(planVideoUpload({ type: "image/jpeg", name: "x.jpg", size: MB }, MAX), "not_video");
  assert.equal(planVideoUpload({ type: "", name: "notes.txt", size: MB }, MAX), "not_video");
  assert.equal(planVideoUpload({ type: "video/mp4", name: "a.mp4", size: 0 }, MAX), "empty");
  assert.equal(videoTypeOf({ type: "VIDEO/MP4" }), "video/mp4");
  assert.equal(videoTypeOf({ type: "", name: "x.M4V" }), "video/mp4");
});

await run("the direct types and the ceiling are exactly what the server accepts", () => {
  assert.deepEqual([...DIRECT_VIDEO_TYPES].sort(), [...CONTENT_VIDEO_MIME_TYPES].sort());
  assert.equal(CONTENT_VIDEO_MAX_BYTES, MAX);
});

await run("bitrate keeps a converted clip under the ceiling; over a minute is refused", () => {
  assert.equal(heroVideoBitrate(10, MAX), HERO_VIDEO_MAX_BITRATE, "a short clip gets the quality cap");
  for (const seconds of [1, 5, 15, 30, 45, HERO_VIDEO_MAX_SECONDS]) {
    const bps = heroVideoBitrate(seconds, MAX);
    assert.ok(bps > 0 && bps <= HERO_VIDEO_MAX_BITRATE, `bitrate for ${seconds}s`);
    assert.ok((bps * seconds) / 8 <= MAX * 0.8 + 1, `${seconds}s at ${bps} bps plans under 80% of the ceiling`);
  }
  assert.equal(heroVideoBitrate(HERO_VIDEO_MAX_SECONDS + 0.5, MAX), 0);
  assert.equal(heroVideoBitrate(0, MAX), 0);
  assert.equal(heroVideoBitrate(Number.NaN, MAX), 0);
});

await run("converted frames are at most 1280 on the long edge, even-sized, aspect kept", () => {
  assert.deepEqual(scaledVideoSize(3840, 2160), { width: 1280, height: 720 });
  assert.deepEqual(scaledVideoSize(1080, 1920), { width: 720, height: 1280 }, "portrait phone video");
  assert.deepEqual(scaledVideoSize(640, 360), { width: 640, height: 360 }, "never upscaled");
  assert.deepEqual(scaledVideoSize(1001, 563), { width: 1000, height: 562 });
  assert.equal(HERO_VIDEO_MAX_EDGE, 1280);
  assert.deepEqual(scaledVideoSize(0, 100), { width: 0, height: 0 });
});

await run("recorder format: MP4 first, WebM fallback, none when the browser records nothing", () => {
  assert.deepEqual(pickRecorderType((t) => t === "video/mp4"), { recorderType: "video/mp4", uploadType: "video/mp4" });
  assert.deepEqual(pickRecorderType((t) => t.startsWith("video/webm")), { recorderType: "video/webm;codecs=vp9", uploadType: "video/webm" });
  assert.equal(pickRecorderType(() => false), null);
  assert.equal(pickRecorderType(() => { throw new Error("probe"); }), null);
});

await run("container sniffing matches the server signatures", () => {
  const mp4 = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f]);
  assert.equal(sniffVideoContainer(mp4), "video/mp4");
  assert.equal(sniffVideoContainer(webm), "video/webm");
  assert.equal(sniffVideoContainer(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])), null);
});

await run("the upload path converts instead of refusing, and the picker offers every video", async () => {
  const assets = await readFile("web/src/contentAssets.ts", "utf8");
  const admin = await readFile("web/src/pages/contentAdmin.tsx", "utf8");
  assert.match(assets, /export const VIDEO_ACCEPT = "video\/\*"/);
  assert.match(assets, /planVideoUpload\(file, VIDEO_MAX_BYTES\)/);
  assert.match(assets, /if \(plan === "convert"\)[\s\S]*convertVideoForHero\(file, \{ maxBytes: VIDEO_MAX_BYTES, onProgress \}\)/);
  assert.doesNotMatch(assets, /file\.size > VIDEO_MAX_BYTES\) throw/, "an oversize clip must be converted, not refused");
  assert.match(admin, /uploadVideoAsset\(file, \(f\) => setProgress\(f\)\)/);
  assert.match(admin, /content_admin\.preparing_video/);
});

console.log("CMS_VIDEO_PREP_PASS");
