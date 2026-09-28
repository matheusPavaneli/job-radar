import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { decodeCursor, encodeCursor, InvalidInputError, pageSize } from './cursor.ts';

const id = '0b6f2f7e-3f1c-4c2a-9a55-7f1d2c3b4a59';
const publishedAt = '2026-09-27T14:03:21.123456Z';

function raw(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe('cursor', () => {
  test('decodes back to the same published_at, microseconds included, and id', () => {
    assert.deepEqual(decodeCursor(encodeCursor({ publishedAt, id })), { publishedAt, id });
  });

  test('rejects cursors that are not what encodeCursor produces', () => {
    for (const cursor of [
      '',
      'not base64 !!',
      raw({ publishedAt, id }),
      raw([publishedAt]),
      raw([publishedAt, id, 'extra']),
      raw([publishedAt, 42]),
      raw([publishedAt, 'not-a-uuid']),
      raw(['yesterday-ish', id]),
      raw(['2026-09-27T14:03:21Z', id]),
      'A'.repeat(300),
    ]) {
      assert.throws(() => decodeCursor(cursor), InvalidInputError, cursor);
    }
  });
});

describe('pageSize', () => {
  test('defaults to 20', () => {
    assert.equal(pageSize(undefined), 20);
    assert.equal(pageSize(null), 20);
  });

  test('caps first at 50', () => {
    assert.equal(pageSize(50), 50);
    assert.equal(pageSize(51), 50);
    assert.equal(pageSize(10_000), 50);
  });

  test('rejects zero and negative values', () => {
    assert.throws(() => pageSize(0), InvalidInputError);
    assert.throws(() => pageSize(-5), InvalidInputError);
  });
});
