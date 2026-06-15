import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as schema from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let sql: ReturnType<typeof postgres> | null = null;
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!db) {
    const url = process.env.POSTGRES_URL ?? process.env.PERMISSIONS_POSTGRES_URL;
    if (!url) throw new Error('POSTGRES_URL or PERMISSIONS_POSTGRES_URL is required');
    sql = postgres(url, { max: 10 });
    db = drizzle(sql, { schema });
  }
  return db;
}

export async function runMigrations() {
  const url = process.env.POSTGRES_URL ?? process.env.PERMISSIONS_POSTGRES_URL;
  if (!url) return;
  const migrationsDir = join(__dirname, 'migrations');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const client = postgres(url, { max: 1 });
  try {
    for (const file of files) {
      const migrationSql = readFileSync(join(migrationsDir, file), 'utf8');
      await client.unsafe(migrationSql);
    }
  } finally {
    await client.end();
  }
}

export async function closeDb() {
  if (sql) {
    await sql.end();
    sql = null;
    db = null;
  }
}
