import { randomBytes } from "node:crypto";
import { decideFulfillmentIssuance, issueFulfillmentUnitsForParticipant } from "./deal_types.js";

export type Db = { query(sql: string, params?: any[]): Promise<any> };
export const RECEIPT_METHODS = ["qr", "code", "name_phone", "digital_link", "instructions"] as const;
export type ReceiptMethod = typeof RECEIPT_METHODS[number];
export const RECEIPT_LABELS: Record<ReceiptMethod, string> = {
  qr: "תקבלו QR אישי וקוד למימוש", code: "תקבלו קוד מימוש אישי",
  name_phone: "המימוש יתבצע באמצעות שם וטלפון", digital_link: "תקבלו קישור אישי",
  instructions: "המוכר יספק הוראות מימוש לאחר השלמת העסקה"
};
export function failure(code: string, statusCode = 400): never { throw Object.assign(new Error(code), { code, statusCode }); }
export function receiptConfig(row: any): { method: ReceiptMethod; instructions: string; url: string } {
  const c = row.receipt_config;
  return c || { method: row.deal_type === "voucher" ? "code" : "qr", instructions: "", url: "" };
}
export function validateReceiptConfig(body: any) {
  if (!body || !RECEIPT_METHODS.includes(body.method)) failure("invalid_receipt_method");
  const instructions = body.instructions ?? "";
  const url = body.url ?? "";
  if (typeof instructions !== "string" || instructions.length > 1000 || typeof url !== "string" || url.length > 2000) failure("invalid_receipt_details");
  if (body.method === "instructions" && !instructions.trim()) failure("receipt_instructions_required");
  if (body.method === "digital_link") {
    let parsed: URL; try { parsed = new URL(url.replaceAll("{code}", "example")); } catch { return failure("invalid_receipt_url"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) failure("invalid_receipt_url");
  }
  return { method: body.method as ReceiptMethod, instructions: instructions.trim(), url: body.method === "digital_link" ? url.trim() : "" };
}
export function eligible(row: any) {
  return decideFulfillmentIssuance({ dealState: row.deal_state, buyerState: row.buyer_state, moneyState: row.money_state }).shouldIssue;
}
export async function loadReceiptOrder(c: Db, participantId: string, lock = false) {
  // Deal before participant follows the transition engine lock order.
  if (lock) {
    await c.query(`SELECT deal_id FROM siton.deals WHERE deal_id=(SELECT deal_id FROM siton.participants WHERE participant_id=$1) FOR UPDATE`, [participantId]);
    await c.query(`SELECT participant_id FROM siton.participants WHERE participant_id=$1 FOR UPDATE`, [participantId]);
  }
  const r = await c.query(`SELECT p.participant_id, p.deal_id, p.qty, p.buyer_state, p.money_state,
    p.buyer_name, p.buyer_phone, p.public_name_opt_in, d.state AS deal_state, d.seller_id, d.deal_type, d.title, d.receipt_config
    FROM siton.participants p JOIN siton.deals d ON d.deal_id=p.deal_id WHERE p.participant_id=$1`, [participantId]);
  return r.rows[0] || null;
}
export async function receiptForOrder(c: Db, row: any) {
  if (!eligible(row)) return null;
  await issueFulfillmentUnitsForParticipant(c, { dealId: row.deal_id, participantId: row.participant_id, qty: row.qty, dealType: row.deal_type });
  let units = (await c.query(`SELECT fulfillment_unit_id, unit_index, status, redeemed_at, metadata_jsonb FROM siton.fulfillment_units WHERE participant_id=$1 ORDER BY unit_index FOR UPDATE`, [row.participant_id])).rows;
  if (units.length !== row.qty || units.some((u: any) => !["Issued", "Sent", "Redeemed"].includes(u.status))) return null;
  let code = units[0]?.metadata_jsonb?.receipt_code;
  if (!code) {
    // 128 random bits, stable across reads; seller authentication is still mandatory.
    code = randomBytes(16).toString("hex").toUpperCase().match(/.{4}/g)!.join("-");
    await c.query(`UPDATE siton.fulfillment_units SET metadata_jsonb=metadata_jsonb || jsonb_build_object('receipt_code',$2::text), updated_at=now() WHERE participant_id=$1`, [row.participant_id, code]);
  }
  const cfg = receiptConfig(row);
  return { entitlement_id: units[0].fulfillment_unit_id, method: cfg.method, title: row.title, quantity: row.qty,
    remaining_quantity: units.filter((u: any) => u.status !== "Redeemed").length,
    status: units.every((u: any) => u.status === "Redeemed") ? "redeemed" : "valid",
    redeemed_at: units.find((u: any) => u.redeemed_at)?.redeemed_at || null,
    code: ["qr", "code"].includes(cfg.method) ? code : null,
    instructions: cfg.instructions,
    url: cfg.method === "digital_link" ? cfg.url.replaceAll("{code}", encodeURIComponent(code)) : null };
}
export async function redeemReceipt(c: Db, sellerId: string, participantId: string, actor: string) {
  const row = await loadReceiptOrder(c, participantId, true);
  if (!row || row.seller_id !== sellerId) failure("receipt_not_found", 404);
  const receipt = await receiptForOrder(c, row);
  if (!receipt) failure("receipt_not_entitled", 409);
  if (receipt.status === "redeemed") return { ok: true, idempotent: true, receipt };
  await c.query(`UPDATE siton.fulfillment_units SET status='Redeemed', redeemed_at=now(), updated_at=now(),
    metadata_jsonb=metadata_jsonb || jsonb_build_object('redeemed_by',$2::text)
    WHERE participant_id=$1 AND status IN ('Issued','Sent')`, [participantId, actor]);
  await c.query(`INSERT INTO siton.seller_security_events
    (seller_id,event_type,from_status,to_status,actor_ref,reason,payload)
    VALUES($1,'fulfillment.redeem','Issued','Redeemed',$2,'seller_confirmation',$3::jsonb)`,
    [sellerId, actor, JSON.stringify({ participant_id: participantId, deal_id: row.deal_id, quantity: row.qty })]);
  return { ok: true, idempotent: false, receipt: await receiptForOrder(c, row) };
}
export function successStats(rows: any[]) {
  const published = rows.filter(r => r.published_at && r.state !== "Draft");
  const finalized = published.filter(r => ["Completed", "Failed", "Cancelled"].includes(r.state));
  const completed = finalized.filter(r => r.state === "Completed").length;
  return { published: published.length, finalized: finalized.length, completed, success_rate: finalized.length ? Math.round(completed / finalized.length * 100) : null };
}
export function safePublicName(value: unknown) {
  // Deliberately only a first name; reject contact-like or arbitrary markup values.
  const name = String(value || "").trim().split(/\s+/)[0] || "";
  return /^[\p{L}\p{M}'’־-]{1,30}$/u.test(name) ? name : "משתתף";
}
export async function publicSeller(c: Db, publicId: string, page = 0, includeHistory = true) {
  const r = await c.query(`SELECT seller_id, public_profile_id, business_name, display_name, business_description, profile_image_id
    FROM siton.seller_accounts WHERE public_profile_id=$1`, [publicId]);
  const s = r.rows[0]; if (!s) return null;
  const counts = (await c.query(`SELECT count(*)::int AS published,
    count(*) FILTER (WHERE state IN ('Completed','Failed','Cancelled'))::int AS finalized,
    count(*) FILTER (WHERE state='Completed')::int AS completed
    FROM siton.deals WHERE seller_id=$1 AND published_at IS NOT NULL AND state <> 'Draft'`, [s.seller_id])).rows[0];
  const deals = includeHistory ? (await c.query(`SELECT deal_id, title, state, published_at, price_per_unit FROM siton.deals
    WHERE seller_id=$1 AND published_at IS NOT NULL AND state <> 'Draft' ORDER BY published_at DESC, deal_id
    LIMIT 24 OFFSET $2`, [s.seller_id, page * 24])).rows : [];
  return { id: s.public_profile_id, name: s.business_name || s.display_name || "המוכר",
    about: s.business_description || "", image: s.profile_image_id ? `/api/content-assets/${s.profile_image_id}` : null,
    stats: { ...counts, success_rate: counts.finalized ? Math.round(counts.completed / counts.finalized * 100) : null },
    deals, page, has_more: (page + 1) * 24 < counts.published };
}
