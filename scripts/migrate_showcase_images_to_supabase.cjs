// R7 closure: migrate the 16 synthetic showcase deal images from the retired
// local storage authority to canonical Supabase Storage, through the canonical
// server-side image path (saveDealImage → SupabaseBrokerStorageAdapter →
// storage-broker). The original local bytes are unrecoverable (Render's local
// filesystem was ephemeral; the serving path now 503s), so — and ONLY because
// every one of these 16 is a clearly-synthetic showcase image — we regenerate
// equivalent deterministic showcase art with the same generator the seed used.
//
// Output: JSON mapping image_id → { storage_key, public_url, checksum, size }
// which the caller applies to siton.deal_images via MCP (the DB is reached
// through MCP, not a local connection). Uploads are canonical; no direct
// storage.objects insertion.
//
// Usage: KEYFILE=<broker_key.json> node scripts/migrate_showcase_images_to_supabase.cjs '<rows-json>'
const fs = require("node:fs");
const zlib = require("node:zlib");
const crypto = require("node:crypto");

const { key } = JSON.parse(fs.readFileSync(process.env.KEYFILE, "utf8"));
process.env.STORAGE_ADAPTER = "supabase";
process.env.SUPABASE_URL = "https://hnptacfzuqebfgeshadq.supabase.co";
process.env.SUPABASE_STORAGE_BUCKET = "deal-images";
process.env.OBJECT_STORAGE_PREFIX = "staging";
process.env.SITON_STORAGE_BROKER_KEY = key;

// deterministic PNG generator (identical algorithm to the showcase seed)
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32b(buf) { let crc = -1; for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff]; return (crc ^ -1) >>> 0; }
function pngChunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, "ascii"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32b(body)); return Buffer.concat([len, body, crc]); }
function makePng(width, height, palette, seed) {
  const rnd = (() => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff); })();
  const discs = Array.from({ length: 5 }, () => ({ x: rnd() * width, y: rnd() * height, r: (0.15 + rnd() * 0.3) * width, c: palette[1 + Math.floor(rnd() * (palette.length - 1))], a: 0.25 + rnd() * 0.3 }));
  const [c0, c1] = [palette[0], palette[palette.length - 1]];
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0;
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      let r = c0[0] + (c1[0] - c0[0]) * t, g = c0[1] + (c1[1] - c0[1]) * t, b = c0[2] + (c1[2] - c0[2]) * t;
      for (const d of discs) { const dist = Math.hypot(x - d.x, y - d.y); if (dist < d.r) { const f = d.a * (1 - dist / d.r); r += (d.c[0] - r) * f; g += (d.c[1] - g) * f; b += (d.c[2] - b) * f; } }
      const o = y * (1 + width * 3) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })), pngChunk("IEND", Buffer.alloc(0))]);
}
const PALETTES = [[[87,108,60],[166,187,100],[222,231,176]],[[178,106,20],[235,172,60],[250,227,160]],[[16,84,116],[42,158,180],[176,226,232]],[[110,26,74],[196,64,128],[244,190,216]],[[62,40,24],[140,94,60],[218,190,160]],[[190,84,12],[240,150,40],[252,220,130]],[[30,40,70],[80,110,200],[190,210,250]],[[40,90,80],[120,180,160],[220,240,230]]];

(async () => {
  const { saveDealImage } = await import("../src/product_image_storage.ts");
  const rows = JSON.parse(process.argv[2]);
  const out = [];
  // deal-stable palette + seed derived from deal_id so each deal keeps a
  // distinct, consistent look; the two images per deal differ by sort_order.
  for (const r of rows) {
    const h = crypto.createHash("sha256").update(String(r.deal_id)).digest();
    const palette = PALETTES[h[0] % PALETTES.length];
    const seed = ((h[1] << 8) | h[2]) + Number(r.sort_order) * 7;
    const png = makePng(800, 500, palette, seed);
    const saved = await saveDealImage({ dealId: String(r.deal_id), originalFilename: `showcase-${r.sort_order}.png`, mimeType: "image/png", base64Data: png.toString("base64") });
    out.push({ image_id: r.image_id, deal_id: r.deal_id, storage_provider: saved.storage_provider, storage_key: saved.storage_key, public_url: saved.public_url, checksum_sha256: saved.checksum_sha256, size_bytes: saved.size_bytes });
    process.stderr.write(`migrated ${r.image_id} → ${saved.storage_key} (${saved.size_bytes}B)\n`);
  }
  process.stdout.write(JSON.stringify(out));
})().catch((e) => { process.stderr.write("MIGRATE_ERROR " + String(e && e.message || e) + "\n"); process.exit(1); });
