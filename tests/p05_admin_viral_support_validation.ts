// P0.5 — DB-exercised proof:
//  * TRUE propagation tree over the canonical attribution graph, driven by the
//    owner's EXACT example: Source A = 5 direct / 2 propagate (A1→3, A3→2,
//    A1.2→1 → 3 generations, 11 in the branch), Source B = 2/1, Source C = 1/0
//  * every participant appears (propagators AND terminal leaves), ancestry is
//    canonical parent links (never timestamps), seller isolation server-side
//  * support case conversation: admin reply persists, thread survives reload,
//    status becomes the answered state, internal notes stay internal,
//    unauthorized/seller access denied, external email honestly disabled
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

process.env.ADMIN_API_KEY = "p05-admin-key";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.PORT = "3499";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton"
});

const { app } = await import("../src/app.js");
const { establishNamedAdminSession } = await import("./helpers/named_admin_session.js");
const { cookie: ADMIN_COOKIE } = await establishNamedAdminSession(app, pool);

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e.message}`); failed++; }
}

function adminHeaders(extra: Record<string, string> = {}) {
  return { "x-admin-key": "p05-admin-key", "x-admin-user": "p05-admin", cookie: ADMIN_COOKIE, ...extra };
}

const SELLER_ID = `seller-p05-${randomUUID().slice(0, 8)}`;
const OTHER_SELLER = `seller-p05x-${randomUUID().slice(0, 8)}`;

// ── the owner's example, EXACTLY, as a deterministic synthetic fixture ─────
async function seedPropagationFixture() {
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, title, price_per_unit, min_units, max_units, threshold_units, deadline, state, seller_id, published_at)
     VALUES ($1,'עסקת הוכחת הפצה',10,5,50,5,$2,'PendingTarget',$3,now())`,
    [dealId, new Date(Date.now() + 3 * 864e5).toISOString(), SELLER_ID]
  );
  const suffix = randomUUID().slice(0, 8);
  const mkCampaignLink = async (name: string, code: string) => {
    const r = await pool.query(
      `INSERT INTO siton.affiliate_links (deal_id, affiliate_id, internal_name, source_code, origin_type)
       VALUES ($1, NULL, $2, $3, 'campaign') RETURNING link_id`,
      [dealId, name, code]
    );
    return String(r.rows[0].link_id);
  };
  const linkA = await mkCampaignLink("מקור א", `p05-src-a-${suffix}`);
  const linkB = await mkCampaignLink("מקור ב", `p05-src-b-${suffix}`);
  const linkC = await mkCampaignLink("מקור ג", `p05-src-c-${suffix}`);

  const mkParticipant = async (name: string, qty: number) => {
    const r = await pool.query(
      `INSERT INTO siton.participants (deal_id, buyer_id, buyer_name, qty, buyer_state, money_state, delivery_cost)
       VALUES ($1, $2, $3, $4, 'JoinedAuthorized', 'AuthHeld', 0) RETURNING participant_id`,
      [dealId, `p05-buyer-${name}-${suffix}`, name, qty]
    );
    return String(r.rows[0].participant_id);
  };
  const mkPersonalLink = async (participantId: string, name: string) => {
    const r = await pool.query(
      `INSERT INTO siton.affiliate_links (deal_id, affiliate_id, internal_name, source_code, origin_type, origin_participant_id, origin_buyer_id)
       VALUES ($1, NULL, $2, $3, 'participant', $4, $5) RETURNING link_id`,
      [dealId, `קישור ${name}`, `p05-pers-${name.toLowerCase().replace(/[^a-z0-9]/g, "")}-${suffix}`, participantId, `p05-buyer-${name}-${suffix}`]
    );
    return String(r.rows[0].link_id);
  };
  const attach = async (participantId: string, opts: { parent?: string; parentLink?: string; origin: string | null; generation: number }) => {
    await pool.query(
      `INSERT INTO siton.viral_attributions
         (participant_id, deal_id, parent_link_id, parent_participant_id, origin_link_id, origin_ref_type, generation)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [participantId, dealId, opts.parentLink || null, opts.parent || null, opts.origin, opts.origin ? "campaign" : "none", opts.generation]
    );
  };

  // Source A: 5 gen-1 participants
  const A: Record<string, string> = {};
  for (const [name, qty] of [["A1", 2], ["A2", 1], ["A3", 1], ["A4", 1], ["A5", 2]] as const) {
    A[name] = await mkParticipant(name, qty);
    await attach(A[name]!, { origin: linkA, generation: 1 });
  }
  // A1 propagates: 3 children (A1.1, A1.2, A1.3)
  const a1Link = await mkPersonalLink(A.A1!, "A1");
  for (const name of ["A1.1", "A1.2", "A1.3"]) {
    A[name] = await mkParticipant(name, 1);
    await attach(A[name]!, { parent: A.A1!, parentLink: a1Link, origin: linkA, generation: 2 });
  }
  // A3 propagates: 2 children
  const a3Link = await mkPersonalLink(A.A3!, "A3");
  for (const name of ["A3.1", "A3.2"]) {
    A[name] = await mkParticipant(name, 1);
    await attach(A[name]!, { parent: A.A3!, parentLink: a3Link, origin: linkA, generation: 2 });
  }
  // A1.2 propagates: 1 child → third generation
  const a12Link = await mkPersonalLink(A["A1.2"]!, "A1.2");
  A["A1.2.1"] = await mkParticipant("A1.2.1", 1);
  await attach(A["A1.2.1"]!, { parent: A["A1.2"]!, parentLink: a12Link, origin: linkA, generation: 3 });

  // Source B: 2 gen-1, one propagates once
  const B: Record<string, string> = {};
  for (const name of ["B1", "B2"]) {
    B[name] = await mkParticipant(name, 1);
    await attach(B[name]!, { origin: linkB, generation: 1 });
  }
  const b1Link = await mkPersonalLink(B.B1!, "B1");
  B["B1.1"] = await mkParticipant("B1.1", 1);
  await attach(B["B1.1"]!, { parent: B.B1!, parentLink: b1Link, origin: linkB, generation: 2 });

  // Source C: 1 gen-1, no propagation
  const C1 = await mkParticipant("C1", 1);
  await attach(C1, { origin: linkC, generation: 1 });

  return { dealId, linkA, linkB, linkC, A, B, C1 };
}

const fx = await seedPropagationFixture();

await run("VIRAL: sources match the owner's example exactly (A 5/2/11/3, B 2/1/3/2, C 1/0/1/1)", async () => {
  const res = await app.inject({ method: "GET", url: `/api/admin/deals/${fx.dealId}/propagation`, headers: adminHeaders() });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  const byKey = new Map(body.sources.map((s: any) => [String(s.source_key), s]));
  const a = byKey.get(fx.linkA) as any, b = byKey.get(fx.linkB) as any, c = byKey.get(fx.linkC) as any;
  assert.ok(a && b && c, `sources missing: ${body.sources.map((s: any) => s.label).join(",")}`);
  assert.equal(a.direct_joins, 5, "A direct");
  assert.equal(a.propagators, 2, "A propagators");
  assert.equal(a.branch_joins, 11, "A branch total");
  assert.equal(a.max_depth, 3, "A depth");
  assert.equal(String(a.label), "מקור א", `A label: ${a.label}`);
  assert.equal(b.direct_joins, 2, "B direct");
  assert.equal(b.propagators, 1, "B propagators");
  assert.equal(b.branch_joins, 3, "B branch");
  assert.equal(b.max_depth, 2, "B depth");
  assert.equal(c.direct_joins, 1, "C direct");
  assert.equal(c.propagators, 0, "C propagators");
  assert.equal(c.branch_joins, 1, "C branch");
  assert.equal(c.max_depth, 1, "C depth");
});

await run("VIRAL: every participant appears — 5 roots under A incl. terminal leaves; children + grandchildren by canonical ancestry", async () => {
  const roots = await app.inject({ method: "GET", url: `/api/admin/deals/${fx.dealId}/viral-tree?source=${fx.linkA}`, headers: adminHeaders() });
  assert.equal(roots.statusCode, 200, roots.body);
  const rootNodes = (roots.json() as any).nodes;
  assert.equal(rootNodes.length, 5, `A roots: ${rootNodes.length}`);
  const a1 = rootNodes.find((n: any) => n.participant_id === fx.A.A1);
  const a2 = rootNodes.find((n: any) => n.participant_id === fx.A.A2);
  const a3 = rootNodes.find((n: any) => n.participant_id === fx.A.A3);
  assert.equal(a1.direct_children, 3, "A1 brought 3");
  assert.equal(a3.direct_children, 2, "A3 brought 2");
  assert.equal(a2.direct_children, 0, "A2 is a terminal leaf and still appears");
  assert.equal(a1.subtree_joins, 4, "A1 subtree = 3 children + 1 grandchild");

  const a1kids = await app.inject({ method: "GET", url: `/api/admin/deals/${fx.dealId}/viral-tree?parent=${fx.A.A1}`, headers: adminHeaders() });
  const kidNodes = (a1kids.json() as any).nodes;
  assert.equal(kidNodes.length, 3, "A1 children");
  const a12 = kidNodes.find((n: any) => n.participant_id === fx.A["A1.2"]);
  assert.equal(a12.direct_children, 1, "A1.2 continued");
  assert.equal(a12.generation, 2);

  const a12kids = await app.inject({ method: "GET", url: `/api/admin/deals/${fx.dealId}/viral-tree?parent=${fx.A["A1.2"]}`, headers: adminHeaders() });
  const grand = (a12kids.json() as any).nodes;
  assert.equal(grand.length, 1, "A1.2 grandchild");
  assert.equal(grand[0].participant_id, fx.A["A1.2.1"]);
  assert.equal(grand[0].generation, 3, "third generation");
});

await run("VIRAL: seller sees OWN tree; another seller gets 404 (propagation + levels)", async () => {
  const own = await app.inject({ method: "GET", url: `/api/seller/deals/${fx.dealId}/propagation`, headers: { "x-seller-id": SELLER_ID } });
  assert.equal(own.statusCode, 200, own.body);
  assert.equal((own.json() as any).sources.length, 3);
  const foreign = await app.inject({ method: "GET", url: `/api/seller/deals/${fx.dealId}/propagation`, headers: { "x-seller-id": OTHER_SELLER } });
  assert.equal(foreign.statusCode, 404, foreign.body);
  const foreignLevel = await app.inject({ method: "GET", url: `/api/seller/deals/${fx.dealId}/viral-tree?source=${fx.linkA}`, headers: { "x-seller-id": OTHER_SELLER } });
  assert.equal(foreignLevel.statusCode, 404, foreignLevel.body);
});

await run("VIRAL: an empty deal still answers ok with zero sources (feature never disappears)", async () => {
  const emptyDeal = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals (deal_id, title, price_per_unit, min_units, max_units, threshold_units, deadline, state, seller_id, published_at)
     VALUES ($1,'עסקה ריקה',10,5,50,5,$2,'PendingTarget',$3,now())`,
    [emptyDeal, new Date(Date.now() + 864e5).toISOString(), SELLER_ID]
  );
  const res = await app.inject({ method: "GET", url: `/api/admin/deals/${emptyDeal}/propagation`, headers: adminHeaders() });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  assert.equal(body.ok, true);
  assert.equal(body.sources.length, 0);
  assert.equal(String(body.deal.deal_id), emptyDeal);
});

// ── SUPPORT ────────────────────────────────────────────────────────────────
let caseId = "";
await run("SUPPORT: public contact creates a case; admin opens the detail thread", async () => {
  const email = `p05-${randomUUID().slice(0, 8)}@example.com`;
  const created = await app.inject({
    method: "POST", url: "/api/support/contact",
    payload: { name: "פונה בדיקה", email, category: "general", message: "יש לי שאלה חשובה על העסקה, אשמח לתשובה." }
  });
  assert.ok([200, 201].includes(created.statusCode), created.body);
  caseId = String((created.json() as any).case_id || "");
  if (!caseId) {
    const found = await pool.query(
      `SELECT case_id::text FROM siton.operational_cases WHERE buyer_ref=$1 ORDER BY created_at DESC LIMIT 1`,
      [email]
    );
    assert.equal(found.rowCount, 1, "case row created");
    caseId = String(found.rows[0].case_id);
  }

  const detail = await app.inject({ method: "GET", url: `/api/admin/support-cases/${caseId}`, headers: adminHeaders() });
  assert.equal(detail.statusCode, 200, detail.body);
  const body = detail.json() as any;
  assert.ok(String(body.case.description || "").includes("שאלה חשובה"), "original message visible");
  assert.equal(body.messages.length, 0);
  assert.equal(body.email_delivery.enabled, false, "email honestly disabled");
});

await run("SUPPORT: admin reply persists, moves the case to the answered state, is audited, and claims NO email", async () => {
  const replied = await app.inject({
    method: "POST", url: `/api/admin/support-cases/${caseId}/reply`,
    headers: adminHeaders({ "x-request-id": `p05-reply-${Date.now()}` }),
    payload: { body: "קיבלנו את פנייתך, הנושא בבדיקה." }
  });
  assert.equal(replied.statusCode, 200, replied.body);
  const rb = replied.json() as any;
  assert.equal(rb.message.sender_type, "Admin");
  assert.equal(rb.message.delivery_status, "Saved", "saved is NOT sent");
  assert.equal(rb.case_status, "WaitingExternal");
  assert.equal(rb.email_delivery.enabled, false);
  assert.ok(String(rb.email_delivery.note_he).includes("אינה פעילה"), "honest Hebrew email note");

  // reload keeps the thread + status
  const detail = await app.inject({ method: "GET", url: `/api/admin/support-cases/${caseId}`, headers: adminHeaders() });
  const body = detail.json() as any;
  assert.equal(body.case.status, "WaitingExternal");
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].body, "קיבלנו את פנייתך, הנושא בבדיקה.");
  assert.ok(body.messages[0].created_at, "timestamp present");

  const audit = await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.operational_case_events WHERE case_id=$1 AND event_type='case.reply'`,
    [caseId]
  );
  assert.equal(Number(audit.rows[0].n), 1, "reply audited");
});

await run("SUPPORT: internal note stays internal (no status change) and is distinguishable", async () => {
  const noted = await app.inject({
    method: "POST", url: `/api/admin/support-cases/${caseId}/reply`,
    headers: adminHeaders(),
    payload: { body: "הערה פנימית: לבדוק מול המוכר.", internal: true }
  });
  assert.equal(noted.statusCode, 200, noted.body);
  assert.equal((noted.json() as any).message.sender_type, "InternalNote");
  assert.equal((noted.json() as any).case_status, "WaitingExternal", "internal note must not change status");
  const audit = await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.operational_case_events WHERE case_id=$1 AND event_type='case.internal_note'`,
    [caseId]
  );
  assert.equal(Number(audit.rows[0].n), 1);
});

await run("SUPPORT: unauthorized reply denied; sellers/public cannot read threads", async () => {
  const anon = await app.inject({ method: "POST", url: `/api/admin/support-cases/${caseId}/reply`, payload: { body: "פריצה" } });
  assert.ok([401, 403].includes(anon.statusCode), `anon reply: ${anon.statusCode}`);
  const sellerRead = await app.inject({ method: "GET", url: `/api/admin/support-cases/${caseId}`, headers: { "x-seller-id": SELLER_ID } });
  assert.ok([401, 403].includes(sellerRead.statusCode), `seller read: ${sellerRead.statusCode}`);
  const sellerReply = await app.inject({ method: "POST", url: `/api/admin/support-cases/${caseId}/reply`, headers: { "x-seller-id": SELLER_ID }, payload: { body: "מוכר מנסה" } });
  assert.ok([401, 403].includes(sellerReply.statusCode), `seller reply: ${sellerReply.statusCode}`);
});

await run("SUPPORT: no real business email was dispatched (notification safety intact)", async () => {
  const sent = await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.support_case_messages WHERE case_id=$1 AND delivery_status IN ('Queued','Sent')`,
    [caseId]
  );
  assert.equal(Number(sent.rows[0].n), 0, "nothing queued/sent externally");
});

await pool.end().catch(() => undefined);
console.log(`\nP05_VALIDATION ${failed === 0 ? "PASS" : "FAIL"} passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
