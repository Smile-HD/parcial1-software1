/**
 * Minimal migration runner for @app/api.
 * Applies numbered SQL files from migrations/ directory.
 * Tracks applied migrations in _migrations table.
 */

import { Pool } from 'pg';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  return url;
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      filename   text NOT NULL UNIQUE,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function getAppliedMigrations(pool: Pool): Promise<Set<string>> {
  const result = await pool.query('SELECT filename FROM _migrations ORDER BY id');
  return new Set(result.rows.map(r => r.filename));
}

async function applyMigration(pool: Pool, filename: string): Promise<void> {
  const filepath = join(MIGRATIONS_DIR, filename);
  const sql = readFileSync(filepath, 'utf-8');

  console.log(`Applying migration: ${filename}`);
  await pool.query('BEGIN');
  try {
    await pool.query(sql);
    await pool.query('INSERT INTO _migrations (filename) VALUES ($1)', [filename]);
    await pool.query('COMMIT');
    console.log(`Applied migration: ${filename}`);
  } catch (error) {
    await pool.query('ROLLBACK');
    throw new Error(`Failed to apply migration ${filename}: ${error}`);
  }
}

export async function runMigrations(): Promise<void> {
  const pool = new Pool({ connectionString: getDatabaseUrl(), max: 1 });

  try {
    await ensureMigrationsTable(pool);
    const applied = await getAppliedMigrations(pool);

    const files = readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (!applied.has(file)) {
        await applyMigration(pool, file);
      } else {
        console.log(`Skipping already applied migration: ${file}`);
      }
    }

    console.log('All migrations applied successfully');
  } finally {
    await pool.end();
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}