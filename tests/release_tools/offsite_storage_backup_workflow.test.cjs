const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/offsite-storage-backup.yml"), "utf8");

test("source Supabase Storage access is read-only by construction", () => {
  assert.match(workflow, /aws s3api list-objects-v2/);
  assert.match(workflow, /aws s3 sync[^\n]*s3:\/\/\$SOURCE_BUCKET\/[^\n]*\$root\/\$SOURCE_BUCKET\//);
  assert.doesNotMatch(workflow, /aws s3 (?:rm|mv)\b/);
  assert.doesNotMatch(workflow, /--delete\b/);
});

test("source credentials do not survive past the source download step", () => {
  const start = workflow.indexOf("- name: Read source inventory and download bucket");
  const end = workflow.indexOf("- name: Archive and encrypt with owner public key", start);
  assert.ok(start >= 0 && end > start);
  const sourceStep = workflow.slice(start, end);
  assert.match(sourceStep, /SITON_STORAGE_BACKUP_S3_ACCESS_KEY_ID/);
  assert.match(sourceStep, /SITON_STORAGE_BACKUP_S3_SECRET_ACCESS_KEY/);
  const later = workflow.slice(end);
  assert.doesNotMatch(later, /SITON_STORAGE_BACKUP_S3_ACCESS_KEY_ID/);
  assert.doesNotMatch(later, /SITON_STORAGE_BACKUP_S3_SECRET_ACCESS_KEY/);
});

test("backup is secrets-gated, integrity checked, encrypted and download-verified", () => {
  assert.match(workflow, /OFFSITE_STORAGE_BACKUP_SKIPPED missing/);
  assert.match(workflow, /SOURCE_OBJECT_COUNT/);
  assert.match(workflow, /SOURCE_OBJECT_BYTES/);
  assert.match(workflow, /age --encrypt --recipient/);
  assert.match(workflow, /shred -u storage\.tar/);
  assert.match(workflow, /downloaded\.tar\.age/);
  assert.match(workflow, /OFFSITE_STORAGE_BACKUP_PASS/);
  assert.doesNotMatch(workflow, /age --decrypt/);
});

test("source plaintext is destroyed before the off-site upload step", () => {
  const encryptStart = workflow.indexOf("- name: Archive and encrypt with owner public key");
  const uploadStart = workflow.indexOf("- name: Upload encrypted archive to off-site storage", encryptStart);
  assert.ok(encryptStart >= 0 && uploadStart > encryptStart);
  const beforeUpload = workflow.slice(encryptStart, uploadStart);
  assert.match(beforeUpload, /find "\$SOURCE_BUCKET" -type f -exec shred -u/);
  assert.match(beforeUpload, /rm -rf "\$SOURCE_BUCKET"/);
  assert.match(beforeUpload, /shred -u source-inventory\.json/);
  const uploadAndLater = workflow.slice(uploadStart);
  assert.doesNotMatch(uploadAndLater, /source-inventory\.json/);
  assert.doesNotMatch(uploadAndLater, /"\$SOURCE_BUCKET"/);
});

test("workflow has minimal GitHub permissions and no marketplace actions", () => {
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.doesNotMatch(workflow, /^\s*uses:/m);
});
