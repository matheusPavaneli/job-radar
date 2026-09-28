import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import postgres from 'postgres';
import { runMigrations } from './migrate.ts';

const databaseUrl = process.env.DATABASE_URL;
const vector = `[${Array.from({ length: 384 }, () => '0.1').join(',')}]`;

describe('migrations against Postgres', { skip: databaseUrl ? false : 'DATABASE_URL not set' }, () => {
  const url = databaseUrl ?? '';
  let sql: postgres.Sql;
  const userA = `test_${randomUUID()}`;
  const userB = `test_${randomUUID()}`;

  before(async () => {
    await runMigrations(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`insert into users (id) values (${userA}), (${userB})`;
    await sql`
      insert into resumes (user_id, redacted_text, content_hash, embedding) values
        (${userA}, 'resume a', 'hash-a', ${vector}::halfvec),
        (${userB}, 'resume b', 'hash-b', ${vector}::halfvec)`;
  });

  after(async () => {
    await sql`delete from users where id in (${userA}, ${userB})`;
    await sql.end();
  });

  test('a second run applies nothing and keeps one row per file', async () => {
    assert.deepEqual(await runMigrations(url), []);
    const [row] = await sql<{ total: number; distinct_names: number }[]>`
      select count(*)::int as total, count(distinct name)::int as distinct_names from schema_migrations`;
    assert.ok(row);
    assert.equal(row.total, row.distinct_names);
  });

  test('as job_radar_app, a user reads only their own resume', async () => {
    const owners = await sql.begin(async (tx) => {
      await tx`set local role job_radar_app`;
      await tx`select set_config('app.user_id', ${userA}, true)`;
      return tx<{ user_id: string }[]>`select user_id from resumes`;
    });
    assert.deepEqual(
      owners.map((r) => r.user_id),
      [userA],
    );
  });

  test('as job_radar_app, a user cannot write a row for another user', async () => {
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`set local role job_radar_app`;
        await tx`select set_config('app.user_id', ${userA}, true)`;
        await tx`insert into push_subscriptions (endpoint, user_id, p256dh, auth)
                 values (${`https://push.test/${userB}`}, ${userB}, 'k', 'a')`;
      }),
      /row-level security/,
    );
  });

  test('without app.user_id, job_radar_app sees no per-user rows', async () => {
    const rows = await sql.begin(async (tx) => {
      await tx`set local role job_radar_app`;
      return tx`select 1 from resumes`;
    });
    assert.equal(rows.length, 0);
  });
});
