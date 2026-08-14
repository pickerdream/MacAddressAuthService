import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import fs from 'node:fs/promises';

const { Pool } = pg;
const required = ['DATABASE_URL', 'ADMIN_EMAIL', 'ADMIN_PASSWORD'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) throw new Error(`Missing environment values: ${missing.join(', ')}`);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query(await fs.readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
  await pool.query(
    `INSERT INTO users (email, display_name, password_hash, role)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name,
       password_hash = EXCLUDED.password_hash, role = 'admin', active = TRUE, updated_at = NOW()`,
    [process.env.ADMIN_EMAIL.toLowerCase(), process.env.ADMIN_NAME || 'Administrator', passwordHash],
  );
  await pool.query(`INSERT INTO purposes (name) VALUES ('業務端末'), ('検証'), ('来訪者') ON CONFLICT (name) DO NOTHING`);
  console.log('Administrator and initial purposes are ready.');
} finally {
  await pool.end();
}
