import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { runMigrations } from '@job-radar/db/migrate';
import { INTERNAL_AUTH_HEADER, signInternalAuth } from '@job-radar/internal-auth';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import postgres from 'postgres';
import { AppModule } from './app.module.ts';
import { JobsRepository } from './jobs.repository.ts';

const databaseUrl = process.env.DATABASE_URL;
const secret = 'integration-test-secret-0000000000000000';

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
}

interface PageData {
  jobs: {
    edges: { cursor: string; node: { id: string; title: string; publishedAt: string; tags: string[] } }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

const PAGE_QUERY = `query ($first: Int, $after: String, $filter: JobFilter) {
  jobs(first: $first, after: $after, filter: $filter) {
    edges { cursor node { id title publishedAt tags } }
    pageInfo { hasNextPage endCursor }
  }
}`;

describe('jobs subgraph over HTTP', { skip: databaseUrl ? false : 'DATABASE_URL not set' }, () => {
  const url = databaseUrl ?? '';
  const source = `test-${randomUUID()}`;
  const tag = `jr4-${randomUUID()}`;
  let sql: postgres.Sql;
  let app: INestApplication;
  let endpoint: string;
  const seeded: { id: string; title: string; publishedAt: string }[] = [];

  async function post<T>(query: string, variables: Record<string, unknown> = {}, header?: string): Promise<{
    status: number;
    body: GraphQLResponse<T>;
  }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const auth = header ?? signInternalAuth(secret, null, Date.now() / 1000);
    if (auth !== '') headers[INTERNAL_AUTH_HEADER] = auth;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(5_000),
    });
    return { status: res.status, body: (await res.json()) as GraphQLResponse<T> };
  }

  before(async () => {
    await runMigrations(url);
    sql = postgres(url, { max: 2, onnotice: () => {} });

    const shared = '2026-09-20T10:00:00.000001Z';
    const rows = [
      { title: 'GraphQL platform engineer', publishedAt: '2026-09-25T12:00:00.000000Z', tags: [tag, 'graphql'] },
      { title: 'Rust compiler engineer', publishedAt: '2026-09-24T12:00:00.000000Z', tags: [tag, 'rust'] },
      { title: 'Staff engineer, API platform', publishedAt: shared, tags: [tag, 'graphql', 'remote'] },
      { title: 'Data engineer', publishedAt: shared, tags: [tag] },
      { title: 'Frontend engineer', publishedAt: '2026-09-18T08:30:00.000000Z', tags: [tag, 'react'] },
    ];
    for (const [index, row] of rows.entries()) {
      const [inserted] = await sql<{ id: string }[]>`
        insert into jobs (source, external_id, content_hash, title, company, url, tags, description, published_at)
        values (${source}, ${String(index)}, ${`hash-${index}`}, ${row.title}, 'Acme', 'https://example.test/job',
                ${row.tags}, 'Remote role building GraphQL APIs and platform tooling', ${row.publishedAt})
        returning id`;
      assert.ok(inserted);
      seeded.push({ id: inserted.id, title: row.title, publishedAt: row.publishedAt });
    }
    seeded.sort((a, b) =>
      a.publishedAt === b.publishedAt ? (a.id < b.id ? 1 : -1) : a.publishedAt < b.publishedAt ? 1 : -1,
    );

    app = await NestFactory.create(AppModule.register({ sql, internalAuthSecret: secret }), { logger: false });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    endpoint = `http://127.0.0.1:${address.port}/graphql`;
  });

  after(async () => {
    await app?.close();
    if (sql) {
      await sql`delete from jobs where source = ${source}`;
      await sql.end();
    }
  });

  test('a request without x-internal-auth is rejected with 401', async () => {
    const { status, body } = await post('{ __typename }', {}, '');
    assert.equal(status, 401);
    assert.equal(body.errors?.[0]?.extensions?.code, 'UNAUTHENTICATED');
  });

  test('a request with a tampered or foreign x-internal-auth is rejected with 401', async () => {
    const now = Date.now() / 1000;
    const foreign = signInternalAuth('some-other-secret-with-enough-entropy', null, now);
    const expired = signInternalAuth(secret, null, now - 120);
    for (const header of [foreign, expired, 'v1.1.x.garbage']) {
      assert.equal((await post('{ __typename }', {}, header)).status, 401, header);
    }
  });

  test('walking jobs two at a time visits every job once, newest first, ties broken by id', async () => {
    const visited: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const { body }: { body: GraphQLResponse<PageData> } = await post<PageData>(PAGE_QUERY, {
        first: 2,
        after,
        filter: { tags: [tag] },
      });
      assert.equal(body.errors, undefined);
      assert.ok(body.data);
      visited.push(...body.data.jobs.edges.map((edge) => edge.node.id));
      if (!body.data.jobs.pageInfo.hasNextPage) break;
      after = body.data.jobs.pageInfo.endCursor;
    }
    assert.deepEqual(
      visited,
      seeded.map((job) => job.id),
    );
  });

  test('text search matches title words and tags narrow to jobs carrying every tag', async () => {
    const search = await post<PageData>(PAGE_QUERY, { filter: { tags: [tag], text: 'rust compiler' } });
    assert.deepEqual(
      search.body.data?.jobs.edges.map((edge) => edge.node.title),
      ['Rust compiler engineer'],
    );

    const tagged = await post<PageData>(PAGE_QUERY, { filter: { tags: [tag, 'graphql'] } });
    assert.deepEqual(
      tagged.body.data?.jobs.edges.map((edge) => edge.node.title),
      ['GraphQL platform engineer', 'Staff engineer, API platform'],
    );
  });

  test('first above 50 is capped and a forged cursor is a user input error', async () => {
    const capped = await post<PageData>(PAGE_QUERY, { first: 500, filter: { tags: [tag] } });
    assert.equal(capped.body.errors, undefined);
    assert.equal(capped.body.data?.jobs.edges.length, seeded.length);

    const forged = await post<PageData>(PAGE_QUERY, { after: 'bm90LWEtY3Vyc29y' });
    assert.equal(forged.body.errors?.[0]?.extensions?.code, 'BAD_USER_INPUT');
  });

  test('job(id) returns the job and null for an unknown or malformed id', async () => {
    const [first] = seeded;
    assert.ok(first);
    const query = 'query ($id: ID!) { job(id: $id) { id title publishedAt } }';
    const found = await post<{ job: { id: string; title: string; publishedAt: string } | null }>(query, { id: first.id });
    assert.deepEqual(found.body.data?.job, {
      id: first.id,
      title: first.title,
      publishedAt: new Date(first.publishedAt).toISOString(),
    });
    for (const id of [randomUUID(), 'not-a-uuid']) {
      const missing = await post<{ job: null }>(query, { id });
      assert.equal(missing.body.errors, undefined);
      assert.equal(missing.body.data?.job, null);
    }
  });

  test('the gateway can resolve a Job reference by id through _entities', async () => {
    const [first] = seeded;
    assert.ok(first);
    const { body } = await post<{ _entities: ({ title: string } | null)[] }>(
      'query ($r: [_Any!]!) { _entities(representations: $r) { ... on Job { title } } }',
      { r: [{ __typename: 'Job', id: first.id }] },
    );
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data?._entities, [{ title: first.title }]);
  });

  test('EXPLAIN of the page query walks jobs_published_at_idx, first page and after a cursor', async () => {
    const [first] = seeded;
    assert.ok(first);
    const cursorPage = await post<PageData>(PAGE_QUERY, { first: 1 });
    const cursor = cursorPage.body.data?.jobs.pageInfo.endCursor ?? null;
    assert.ok(cursor);

    for (const args of [{ first: 20 }, { first: 20, after: cursor }]) {
      const plan = await sql.begin(async (tx) => {
        await tx`set local enable_seqscan = off`;
        const query = new JobsRepository(tx).pageQuery(args);
        return tx<{ 'QUERY PLAN': string }[]>`explain ${query}`;
      });
      const text = plan.map((row) => row['QUERY PLAN']).join('\n');
      assert.match(text, /Index (Only )?Scan using jobs_published_at_idx/, text);
      assert.doesNotMatch(text, /Sort/, text);
    }
  });
});
