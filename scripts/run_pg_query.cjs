const dotenv = require('dotenv');
dotenv.config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const sql = process.argv[2];
  const params = JSON.parse(process.argv[3]);
  const c = await pool.connect();
  try {
    const r = await c.query(sql, params);
    console.log(JSON.stringify(r.rows, null, 2));
  } finally {
    c.release();
    await pool.end();
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
