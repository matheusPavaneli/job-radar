export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;
export const MAX_CURSOR_LENGTH = 256;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export interface JobCursor {
  publishedAt: string;
  id: string;
}

export class InvalidInputError extends Error {
  override name = 'InvalidInputError';
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export function encodeCursor(cursor: JobCursor): string {
  return Buffer.from(JSON.stringify([cursor.publishedAt, cursor.id])).toString('base64url');
}

export function decodeCursor(value: string): JobCursor {
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH) throw new InvalidInputError('invalid cursor');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch (error) {
    throw new InvalidInputError('invalid cursor', { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw new InvalidInputError('invalid cursor');
  const [publishedAt, id] = parsed as unknown[];
  if (typeof publishedAt !== 'string' || typeof id !== 'string') throw new InvalidInputError('invalid cursor');
  if (!isUuid(id) || !TIMESTAMP.test(publishedAt)) throw new InvalidInputError('invalid cursor');
  return { publishedAt, id };
}

export function pageSize(first: number | null | undefined): number {
  if (first === null || first === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(first) || first < 1) throw new InvalidInputError('first must be a positive integer');
  return Math.min(first, MAX_PAGE_SIZE);
}
