import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pendingMigrations } from './pending.ts';

const file = (name: string, checksum = `sum-${name}`) => ({ name, checksum });

test('returns only unapplied files, in lexical order', () => {
  const files = [file('0003_c.sql'), file('0001_a.sql'), file('0002_b.sql')];
  const applied = new Map([['0001_a.sql', 'sum-0001_a.sql']]);

  assert.deepEqual(
    pendingMigrations(files, applied).map((f) => f.name),
    ['0002_b.sql', '0003_c.sql'],
  );
});

test('returns nothing when every file is applied unchanged', () => {
  const files = [file('0001_a.sql'), file('0002_b.sql')];
  const applied = new Map(files.map((f) => [f.name, f.checksum]));

  assert.deepEqual(pendingMigrations(files, applied), []);
});

test('throws naming the file when an applied migration changed', () => {
  const files = [file('0001_a.sql', 'edited'), file('0002_b.sql')];
  const applied = new Map([['0001_a.sql', 'original']]);

  assert.throws(() => pendingMigrations(files, applied), /Migration 0001_a\.sql changed after being applied/);
});

test('ignores applied rows whose file no longer exists', () => {
  const applied = new Map([['0000_gone.sql', 'x']]);

  assert.deepEqual(
    pendingMigrations([file('0001_a.sql')], applied).map((f) => f.name),
    ['0001_a.sql'],
  );
});
