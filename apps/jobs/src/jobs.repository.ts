import type postgres from 'postgres';
import { decodeCursor, encodeCursor, InvalidInputError, isUuid, pageSize } from './cursor.ts';

export const MAX_TEXT_LENGTH = 200;
export const MAX_TAGS = 20;

export interface Job {
  id: string;
  title: string;
  company: string;
  url: string;
  location: string | null;
  tags: string[];
  description: string;
  publishedAt: Date;
}

export interface JobFilter {
  text?: string | null;
  tags?: string[] | null;
}

export interface JobPageArgs {
  first?: number | null;
  after?: string | null;
  filter?: JobFilter | null;
}

export interface JobConnection {
  edges: { cursor: string; node: Job }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface JobRow {
  id: string;
  title: string;
  company: string;
  url: string;
  location: string | null;
  tags: string[];
  description: string;
  published_at: Date;
  published_at_key: string;
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    title: row.title,
    company: row.company,
    url: row.url,
    location: row.location,
    tags: row.tags,
    description: row.description,
    publishedAt: row.published_at,
  };
}

export class JobsRepository {
  readonly #sql: postgres.Sql | postgres.TransactionSql;

  constructor(sql: postgres.Sql | postgres.TransactionSql) {
    this.#sql = sql;
  }

  async findById(id: string): Promise<Job | null> {
    if (!isUuid(id)) return null;
    const [row] = await this.#sql<JobRow[]>`
      select ${this.#columns()} from jobs where id = ${id}`;
    return row ? toJob(row) : null;
  }

  async page(args: JobPageArgs): Promise<JobConnection> {
    const query = this.pageQuery(args);
    const limit = pageSize(args.first);
    const rows = await query;
    const nodes = rows.slice(0, limit);
    const edges = nodes.map((row) => ({
      cursor: encodeCursor({ publishedAt: row.published_at_key, id: row.id }),
      node: toJob(row),
    }));
    return {
      edges,
      pageInfo: { hasNextPage: rows.length > limit, endCursor: edges.at(-1)?.cursor ?? null },
    };
  }

  pageQuery(args: JobPageArgs): postgres.PendingQuery<JobRow[]> {
    const sql = this.#sql;
    const limit = pageSize(args.first);
    const after = args.after ? decodeCursor(args.after) : null;
    const text = args.filter?.text?.trim() || null;
    const tags = args.filter?.tags?.length ? args.filter.tags : null;
    if (text && text.length > MAX_TEXT_LENGTH) {
      throw new InvalidInputError(`filter.text is limited to ${MAX_TEXT_LENGTH} characters`);
    }
    if (tags && tags.length > MAX_TAGS) throw new InvalidInputError(`filter.tags is limited to ${MAX_TAGS} tags`);

    return sql<JobRow[]>`
      select ${this.#columns()}
      from jobs
      where true
        ${after ? sql`and (published_at, id) < (${after.publishedAt}::timestamptz, ${after.id}::uuid)` : sql``}
        ${text ? sql`and search @@ websearch_to_tsquery('english', ${text})` : sql``}
        ${tags ? sql`and tags @> ${tags}::text[]` : sql``}
      order by published_at desc, id desc
      limit ${limit + 1}`;
  }

  #columns(): postgres.PendingQuery<postgres.Row[]> {
    return this.#sql`
      id, title, company, url, location, tags, description, published_at,
      to_char(published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as published_at_key`;
  }
}
