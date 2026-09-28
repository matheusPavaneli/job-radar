// Applies migrations/*.sql in lexical order, each in its own transaction.
// Applied files are recorded by name and checksum; an edited applied migration fails the run.
// A session advisory lock serialises concurrent runners (CI and a manual run).
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { pendingMigrations } from './pending.ts';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');
const LOCK_KEY = 7_411_902; // arbitrary, stable: identifies this runner's advisory lock

export async function runMigrations(databaseUrl: string, dir = MIGRATIONS_DIR): Promise<string[]> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await sql`select pg_advisory_lock(${LOCK_KEY})`;
    await sql`
      create table if not exists schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`;
    const rows = await sql<{ name: string; checksum: string }[]>`select name, checksum from schema_migrations`;
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    const names = (await readdir(dir)).filter((f) => f.endsWith('.sql'));
    const files = await Promise.all(
      names.map(async (name) => {
        const body = await readFile(join(dir, name), 'utf8');
        return { name, body, checksum: createHash('sha256').update(body).digest('hex') };
      }),
    );
    const bodies = new Map(files.map((f) => [f.name, f.body]));

    const done: string[] = [];
    for (const { name, checksum } of pendingMigrations(files, applied)) {
      await sql.begin(async (tx) => {
        await tx.unsafe(bodies.get(name) ?? '');
        await tx`insert into schema_migrations (name, checksum) values (${name}, ${checksum})`;
      });
      done.push(name);
    }
    return done;
  } finally {
    // Closing the only connection also releases the session lock if the unlock never ran.
    await sql`select pg_advisory_unlock(${LOCK_KEY})`.catch(() => {});
    await sql.end();
  }
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  for (const name of await runMigrations(databaseUrl)) console.log(`applied ${name}`);
}
