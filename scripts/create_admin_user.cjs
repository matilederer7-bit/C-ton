const crypto = require("node:crypto");
const { promisify } = require("node:util");
const pg = require("pg");

const scrypt = promisify(crypto.scrypt);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

async function main() {
  const email = String(process.env.ADMIN_BOOTSTRAP_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.ADMIN_BOOTSTRAP_PASSWORD || "");
  const role = String(process.env.ADMIN_BOOTSTRAP_ROLE || "SuperAdmin").trim();
  const displayName = String(process.env.ADMIN_BOOTSTRAP_DISPLAY_NAME || email).trim();
  if (!email || !password) {
    throw new Error("ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD are required");
  }
  if (!["SuperAdmin", "OpsAdmin", "SupportAdmin", "ReadOnlyAdmin"].includes(role)) {
    throw new Error("ADMIN_BOOTSTRAP_ROLE is invalid");
  }
  if (password.length < 12) {
    throw new Error("ADMIN_BOOTSTRAP_PASSWORD must be at least 12 characters");
  }

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
    max: 1
  });
  try {
    const passwordHash = await hashPassword(password);
    await pool.query(`
      INSERT INTO siton.admin_users (email, display_name, role, status, password_hash, mfa_required, mfa_enabled)
      VALUES ($1,$2,$3,'Active',$4,true,false)
      ON CONFLICT (email) DO UPDATE
      SET display_name=EXCLUDED.display_name,
          role=EXCLUDED.role,
          status='Active',
          password_hash=EXCLUDED.password_hash,
          mfa_required=true,
          updated_at=now()
    `, [email, displayName, role, passwordHash]);
    console.log(`admin_user_upserted email=${email} role=${role}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
