import 'dotenv/config';
import pg from 'pg';
import fs from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be configured.');
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query(await fs.readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  console.log('Database schema is ready.');
} finally {
  await pool.end();
}
