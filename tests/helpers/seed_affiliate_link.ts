import type pg from "pg";

// Distributor identity is gone: share links are analytics-only rows. Tests
// that exercise the anonymous visit recorder seed the affiliate_links row
// directly instead of minting it through a (removed) distributor session.
export async function seedAffiliateLink(
  pool: pg.Pool,
  dealId: string,
  sourceCode: string,
  internalName = "seeded measurement link"
): Promise<{ affiliateId: string; linkId: string }> {
  const account = await pool.query(
    `INSERT INTO siton.affiliate_accounts (affiliate_code, display_name, verification_status)
     VALUES ('affiliate-demo','Demo Distributor','verified')
     ON CONFLICT (affiliate_code) DO UPDATE SET display_name = siton.affiliate_accounts.display_name
     RETURNING affiliate_id::text AS affiliate_id`
  );
  const affiliateId = String(account.rows[0].affiliate_id);
  const link = await pool.query(
    `INSERT INTO siton.affiliate_links (affiliate_id, deal_id, internal_name, source_code)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (source_code) DO UPDATE SET internal_name = EXCLUDED.internal_name
     RETURNING link_id::text AS link_id`,
    [affiliateId, dealId, internalName, sourceCode]
  );
  return { affiliateId, linkId: String(link.rows[0].link_id) };
}

export async function countLinkClicks(pool: pg.Pool, sourceCode: string): Promise<number> {
  const result = await pool.query(
    `SELECT count(*)::int AS clicks
     FROM siton.affiliate_link_events e
     JOIN siton.affiliate_links l ON l.link_id = e.link_id
     WHERE l.source_code = $1 AND e.event_type = 'click'`,
    [sourceCode]
  );
  return Number(result.rows[0]?.clicks || 0);
}
