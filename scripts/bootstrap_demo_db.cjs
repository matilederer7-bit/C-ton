const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
require("dotenv").config();

const sqlPath = path.join(process.cwd(), "src", "migrations", "014_demo_preview_bootstrap.sql");
const sql = fs.readFileSync(sqlPath, "utf8");
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("DATABASE_URL is required for demo bootstrap");
  process.exit(1);
}

async function main() {
  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    console.log("Bootstrapping canonical demo schema...");
    await client.query(sql);
    console.log("Canonical demo schema ready.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Demo bootstrap failed");
  console.error(error);
  process.exit(1);
});
