// Local dry-fit seed for scripts/authenticated_ui_acceptance.cjs --local-dryfit.
//
// LOCAL ONLY. Against a loopback demo-preview server + a loopback database it:
//   1. creates a draft deal under ANOTHER seller context (demo-mode x-seller-id
//      switching) so S7 has a foreign fixture;
//   2. inserts a throwaway local SuperAdmin row and mints its cookie session
//      (the same scrypt cookie path the admin CMS write guard checks) so
//      A5–A7 can exercise save/reload/conflict without Supabase.
// It prints the env lines to feed the harness. It refuses non-loopback targets.
//
// Usage: npx tsx scripts/authenticated_ui_dryfit_seed.ts --base-url=http://127.0.0.1:3719
//        (DATABASE_URL must point at the SAME local database the server uses)
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { issueAdminSession } from "../src/admin_identity.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const BASE = String(args["base-url"] || "http://127.0.0.1:3719").replace(/\/+$/, "");
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

async function main() {
  if (!LOOPBACK.has(new URL(BASE).hostname)) throw new Error(`DRYFIT_SEED_REFUSED non-loopback base ${BASE}`);
  const dbUrl = String(process.env.DATABASE_URL || "");
  if (!dbUrl || !LOOPBACK.has(new URL(dbUrl).hostname)) throw new Error("DRYFIT_SEED_REFUSED DATABASE_URL must be a loopback database");
  const cfg = await fetch(`${BASE}/api/preview/auth-config`).then((r) => r.json());
  if (cfg?.configured !== false) throw new Error("DRYFIT_SEED_REFUSED target has Supabase configured");

  const res = await fetch(`${BASE}/api/deals`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-seller-id": "dryfit-other-seller", "idempotency-key": `dryfit-foreign-${Date.now()}` },
    body: JSON.stringify({
      deal_type: "physical_product", title: "עסקה של מוכר אחר", description_short: "לא שלך",
      description: "עסקה של מוכר אחר לבדיקת הרשאות", price_per_unit: 10, list_price_per_unit: 20,
      min_units: 2, max_units: 10, deadline: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      delivery_options: [{ option_type: "pickup", label: "תל אביב", cost: 0, latitude: 32.08, longitude: 34.78 }]
    })
  });
  const body: any = await res.json();
  const foreign = body.deal_id || body.deal?.deal_id;
  if (!foreign) throw new Error(`foreign draft not created: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  const probe = await fetch(`${BASE}/api/seller/deals/${foreign}`);
  if (probe.status !== 404) throw new Error(`default seller context sees the foreign deal (status ${probe.status})`);

  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  try {
    const admin = (await db.query(
      `INSERT INTO siton.admin_users(email,display_name,role,status,mfa_required,mfa_enabled)
       VALUES($1,'Dryfit Content Admin','SuperAdmin','Active',false,false) RETURNING admin_user_id`,
      [`dryfit-${randomUUID()}@example.invalid`]
    )).rows[0];
    const session = await issueAdminSession(db as any, admin.admin_user_id, { headers: {}, ip: "127.0.0.1" }, true);
    console.log(`DRYFIT_SEED_OK foreign_deal=${foreign} admin_user=${admin.admin_user_id}`);
    console.log(`SITON_ACCEPTANCE_FOREIGN_DEAL_ID=${foreign}`);
    console.log(`SITON_ACCEPTANCE_DRYFIT_ADMIN_COOKIE=${session.token}`);
  } finally { await db.end(); }
}

main().catch((e) => { console.error(`DRYFIT_SEED_FAIL ${e.message}`); process.exit(1); });
