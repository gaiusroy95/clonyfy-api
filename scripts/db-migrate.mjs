#!/usr/bin/env node
/**
 * Apply Supabase/Postgres schema changes from supabase/migrations/*.sql
 *
 * Requires SUPABASE_DB_URL in .env (Supabase → Project Settings → Database → URI).
 * Use the direct connection or session pooler URI with the postgres password.
 *
 * Usage:
 *   npm run db:migrate              # apply pending migrations
 *   npm run db:migrate -- --status  # list applied / pending
 *   npm run db:migrate -- --schema  # apply full supabase-schema.sql (fresh DB bootstrap)
 */

import 'dotenv/config';
import pg from 'pg';
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const migrationsDir = join(root, 'supabase', 'migrations');
const schemaFile = join(root, 'supabase-schema.sql');

const args = new Set(process.argv.slice(2));
const statusOnly = args.has('--status');
const applySchema = args.has('--schema');

function getDbUrl() {
  return process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '';
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _clonyfy_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function listApplied(client) {
  await ensureMigrationsTable(client);
  const { rows } = await client.query('SELECT name, applied_at FROM _clonyfy_migrations ORDER BY name');
  return rows;
}

async function listMigrationFiles() {
  let files;
  try {
    files = await readdir(migrationsDir);
  } catch {
    return [];
  }
  return files.filter((f) => f.endsWith('.sql')).sort();
}

async function applySql(client, label, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('COMMIT');
    console.log(`  ✓ ${label}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function main() {
  const dbUrl = getDbUrl();
  if (!dbUrl) {
    console.error('Missing SUPABASE_DB_URL (or DATABASE_URL) in .env');
    console.error('Supabase → Project Settings → Database → Connection string → URI');
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: dbUrl,
    ssl: dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1') ? undefined : { rejectUnauthorized: false },
  });

  await client.connect();

  try {
    if (applySchema) {
      console.log('Applying full schema: supabase-schema.sql');
      const sql = await readFile(schemaFile, 'utf8');
      await applySql(client, 'supabase-schema.sql', sql);
      const files = await listMigrationFiles();
      await ensureMigrationsTable(client);
      for (const file of files) {
        await client.query(
          'INSERT INTO _clonyfy_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
          [file],
        );
      }
      console.log(`Marked ${files.length} migration(s) as applied.`);
      return;
    }

    const files = await listMigrationFiles();
    const applied = await listApplied(client);
    const appliedSet = new Set(applied.map((r) => r.name));

    if (statusOnly) {
      console.log('Migration status:\n');
      for (const file of files) {
        const mark = appliedSet.has(file) ? 'applied' : 'pending';
        const row = applied.find((r) => r.name === file);
        const at = row ? ` (${row.applied_at.toISOString()})` : '';
        console.log(`  [${mark}] ${file}${at}`);
      }
      if (!files.length) console.log('  (no migration files in supabase/migrations/)');
      return;
    }

    const pending = files.filter((f) => !appliedSet.has(f));
    if (!pending.length) {
      console.log('Database is up to date (no pending migrations).');
      return;
    }

    console.log(`Applying ${pending.length} migration(s)…`);
    await ensureMigrationsTable(client);

    for (const file of pending) {
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      await applySql(client, file, sql);
      await client.query('INSERT INTO _clonyfy_migrations (name) VALUES ($1)', [file]);
    }

    console.log('Done.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message || err);
  process.exit(1);
});
