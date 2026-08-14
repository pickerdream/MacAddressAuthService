import 'dotenv/config';
import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be configured.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    // 履歴管理用テーブルの作成
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    
    // 適用済みのマイグレーションを取得
    const { rows } = await client.query(`SELECT version FROM schema_migrations`);
    const applied = new Set(rows.map(r => r.version));

    // マイグレーションファイルの取得とソート
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const migrationsDir = path.join(__dirname, '../db/migrations');
    let files;
    try {
      files = (await fs.readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();
    } catch (e) {
      if (e.code === 'ENOENT') {
        console.log('No migrations directory found.');
        return;
      }
      throw e;
    }

    // 未適用のマイグレーションを順次実行
    for (const file of files) {
      if (!applied.has(file)) {
        console.log(`Applying migration: ${file}`);
        const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [file]);
        await client.query('COMMIT');
        console.log(`Successfully applied: ${file}`);
      }
    }
    console.log('Database migrations are up to date.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    client.release();
  }
}

migrate().finally(() => pool.end());
