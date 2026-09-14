/**
 * Ejecutor mínimo de migraciones para @app/api.
 * Aplica archivos SQL numerados desde el directorio migrations/.
 * Registra las migraciones aplicadas en la tabla _migrations.
 */

import { Pool } from 'pg';
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

function getDatabaseUrl(): string {
  try {
    process.loadEnvFile();
  } catch {
    // No hay .env — recurre al valor por defecto o variables de entorno.
  }
  return process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/ai_uml';
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

// Punto de entrada CLI
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMigrations().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}