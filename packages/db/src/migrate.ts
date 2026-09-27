// Applies migrations/*.sql in lexical order, each in its own transaction.
// Applied files are recorded by name and checksum; an edited applied migration fails the run.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');

const dir = join(import.meta.dirname, '..', 'migrations');
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

try {
  await sql`
    create table if not exists schema_migrations (
      name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`;
  const applied = new Map(
    (await sql<{ name: string; checksum: string }[]>`select name, checksum from schema_migrations`).map((r) => [
      r.name,
      r.checksum,
    ]),
  );

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const body = await readFile(join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(body).digest('hex');
    const previous = applied.get(file);
    if (previous === checksum) continue;
    if (previous !== undefined) throw new Error(`Migration ${file} changed after being applied`);

    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name, checksum) values (${file}, ${checksum})`;
    });
    console.log(`applied ${file}`);
  }
} finally {
  await sql.end();
}
