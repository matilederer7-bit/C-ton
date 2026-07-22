const { Client } = require("pg");

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO siton.seller_accounts
         (seller_id, display_name, login_email, verification_status, settlement_status,
          business_name, support_email)
       VALUES
         ('seller-alpha','Test Seller','seller-alpha@siton.test','approved','active','Test Seller','support@siton.test'),
         ('seller-default','Default Test Seller','seller-default@siton.test','approved','active','Default Test Seller','support@siton.test')
       ON CONFLICT (seller_id) DO NOTHING`
    );
    await client.query(
      `INSERT INTO siton.affiliate_accounts
         (affiliate_id, affiliate_code, display_name, verification_status)
       VALUES ('a0000000-0000-0000-0000-000000000001','affiliate-demo','Test Affiliate','pending')
       ON CONFLICT (affiliate_id) DO NOTHING`
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
