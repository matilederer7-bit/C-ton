import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageAdapter } from "../src/storage_adapter.js";
import { validateImageFile } from "../src/product_image_storage.js";

const root = await mkdtemp(join(tmpdir(), "siton-storage-atomic-"));
const adapter = new LocalStorageAdapter(root);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
try {
  validateImageFile({ mimeType: "image/png", content: png });
  assert.throws(() => validateImageFile({ mimeType: "image/png", content: Buffer.from("not png") }), (error: any) => error?.code === "image_content_mismatch");
  assert.throws(() => validateImageFile({ mimeType: "image/svg+xml", content: Buffer.from("<svg/>") }), (error: any) => error?.code === "invalid_image_type");

  const outcomes = await Promise.allSettled([
    adapter.put("deal/key.png", png),
    adapter.put("deal/key.png", Buffer.concat([png, Buffer.from("different")]))
  ]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1, "an existing storage key must never be overwritten");
  assert.equal(await adapter.exists("deal/key.png"), true);
  const winningIndex = outcomes.findIndex((result) => result.status === "fulfilled");
  const expected = winningIndex === 0 ? png : Buffer.concat([png, Buffer.from("different")]);
  assert.deepEqual(await adapter.get("deal/key.png"), expected);
  assert.equal((await readdir(join(root, "deal"))).filter((name) => name.includes(".partial-")).length, 0, "partial files must be cleaned");
  await assert.rejects(() => adapter.put("../escape.png", png), (error: any) => error?.code === "invalid_storage_key");
  await adapter.delete("deal/key.png");
  assert.equal(await adapter.exists("deal/key.png"), false);
  console.log("PASS local storage atomic publication, cleanup, MIME sniffing, and traversal protection");
} finally {
  await rm(root, { recursive: true, force: true });
}