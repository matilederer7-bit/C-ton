import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
process.env.NODE_ENV = "test";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "1000000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "1000000";
const uploadRoot = await mkdtemp(join(tmpdir(), "siton-response-loss-"));
process.env.DEAL_IMAGE_UPLOAD_DIR = uploadRoot;
const { app, closeWorkerDatabase } = await import("../src/app.js");
const { armTestFault, resetTestFaults } = await import("../src/fault_injection.js");
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const dealIds: string[] = [];
async function otp(phone: string, loseResponse = false) {
  const start = await app.inject({ method: "POST", url: "/api/otp/start", payload: { phone } });
  assert.equal(start.statusCode, 200, start.body);
  const started = start.json() as any;
  if (loseResponse) armTestFault("http.otp.after_commit_before_response", { kind: "throw", code: "otp_response_lost" });
  const verify = await app.inject({ method: "POST", url: "/api/otp/verify", payload: { otp_session_id: started.otp_session_id, code: started.development_code } });
  return { started, verify };
}
try {
  const lostOtp = await otp(`050${String(Date.now()).slice(-7)}`, true);
  assert.equal(lostOtp.verify.statusCode, 500);
  const otpState = await db.query(`SELECT c.status,(SELECT count(*) FROM siton.otp_proofs p WHERE p.challenge_id=c.challenge_id)::int proofs FROM siton.otp_challenges c WHERE c.challenge_id=$1`, [lostOtp.started.challenge_id]);
  assert.deepEqual({ status: otpState.rows[0].status, proofs: Number(otpState.rows[0].proofs) }, { status: "consumed", proofs: 1 });
  const otpRetry = await app.inject({ method: "POST", url: "/api/otp/verify", payload: { otp_session_id: lostOtp.started.otp_session_id, code: lostOtp.started.development_code } });
  assert.equal(otpRetry.statusCode, 409);
  assert.equal(Number((await db.query(`SELECT count(*) FROM siton.otp_proofs WHERE challenge_id=$1`, [lostOtp.started.challenge_id])).rows[0].count), 1);

  const dealId = String((await db.query(`INSERT INTO siton.deals(title,price_per_unit,min_units,max_units,threshold_units,deadline,seller_id,state,published_at) VALUES ($1,10,1,3,1,now()+interval '3 hours','seller-default','PendingTarget',now()) RETURNING deal_id`, [`fault-join-${randomUUID()}`])).rows[0].deal_id);
  dealIds.push(dealId);
  const joinOtp = await otp(`052${String(Date.now() + 1).slice(-7)}`);
  assert.equal(joinOtp.verify.statusCode, 200, joinOtp.verify.body);
  const proof = joinOtp.verify.json() as any;
  const payload = { buyer_id: proof.buyer_id, qty: 1, payment_disclosure_accepted: true, otp_token: proof.otp_token, otp_challenge_id: proof.challenge_id };
  const headers = { "idempotency-key": `response-loss-${randomUUID()}`, "x-request-id": randomUUID() };
  armTestFault("http.join.after_commit_before_response", { kind: "throw", code: "join_response_lost" });
  const firstJoin = await app.inject({ method: "POST", url: `/deals/${dealId}/join`, payload, headers });
  assert.equal(firstJoin.statusCode, 500, firstJoin.body);
  const retryJoin = await app.inject({ method: "POST", url: `/deals/${dealId}/join`, payload, headers });
  assert.equal(retryJoin.statusCode, 200, retryJoin.body);
  assert.equal(Number((await db.query(`SELECT count(*) FROM siton.participants WHERE deal_id=$1`, [dealId])).rows[0].count), 1);
  assert.equal(Number((await db.query(`SELECT count(*) FROM siton.join_idempotency_results WHERE deal_id=$1`, [dealId])).rows[0].count), 1);

  const draftId = String((await db.query(`INSERT INTO siton.deals(title,price_per_unit,min_units,max_units,threshold_units,deadline,seller_id,state) VALUES ($1,10,1,3,1,now()+interval '3 hours','seller-default','Draft') RETURNING deal_id`, [`fault-upload-${randomUUID()}`])).rows[0].deal_id);
  dealIds.push(draftId);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  armTestFault("http.upload.after_commit_before_response", { kind: "throw", code: "upload_response_lost" });
  const upload = await app.inject({ method: "POST", url: `/api/seller/deals/${draftId}/images`, headers: { "x-seller-id": "seller-default" }, payload: { filename: "fault.png", mime_type: "image/png", image_base64: png } });
  assert.equal(upload.statusCode, 500, upload.body);
  const image = await db.query(`SELECT image_id,storage_key FROM siton.deal_images WHERE deal_id=$1`, [draftId]);
  assert.equal(image.rowCount, 1, "non-idempotent upload remains committed and discoverable after response loss");

  armTestFault("http.delete.after_commit_before_response", { kind: "throw", code: "delete_response_lost" });
  const deletion = await app.inject({ method: "DELETE", url: `/api/seller/deals/${draftId}/images/${image.rows[0].image_id}`, headers: { "x-seller-id": "seller-default" } });
  assert.equal(deletion.statusCode, 500, deletion.body);
  assert.equal(Number((await db.query(`SELECT count(*) FROM siton.deal_images WHERE image_id=$1`, [image.rows[0].image_id])).rows[0].count), 0);
  const deleteRetry = await app.inject({ method: "DELETE", url: `/api/seller/deals/${draftId}/images/${image.rows[0].image_id}`, headers: { "x-seller-id": "seller-default" } });
  assert.equal(deleteRetry.statusCode, 404, "retry exposes canonical already-absent state without a second side effect");
} finally {
  resetTestFaults();
  for (const dealId of dealIds) await db.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [dealId]).catch(() => undefined);
  await db.end();
  await app.close();
  await closeWorkerDatabase();
  await rm(uploadRoot, { recursive: true, force: true });
}
console.log("PASS response loss preserves one Join, one OTP proof, one discoverable upload, and idempotent delete state");