import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { signInternalAuth, verifyInternalAuth } from './index.ts';

const secret = 'test-secret-with-enough-entropy-000000';
const now = 1_790_000_000;

function flipLast(value: string): string {
  const last = value.at(-1) === 'A' ? 'B' : 'A';
  return value.slice(0, -1) + last;
}

describe('internal auth header', () => {
  test('a freshly signed header verifies and carries the user id', () => {
    const header = signInternalAuth(secret, 'user_2abc', now);
    assert.deepEqual(verifyInternalAuth(secret, header, now), { ok: true, userId: 'user_2abc' });
  });

  test('an anonymous header verifies with a null user id', () => {
    const header = signInternalAuth(secret, null, now);
    assert.deepEqual(verifyInternalAuth(secret, header, now), { ok: true, userId: null });
  });

  test('a header within 60 seconds either way is accepted', () => {
    const header = signInternalAuth(secret, 'user_2abc', now);
    assert.equal(verifyInternalAuth(secret, header, now + 60).ok, true);
    assert.equal(verifyInternalAuth(secret, header, now - 60).ok, true);
  });

  test('a header older or newer than 60 seconds is expired', () => {
    const header = signInternalAuth(secret, 'user_2abc', now);
    assert.deepEqual(verifyInternalAuth(secret, header, now + 61), { ok: false, reason: 'expired' });
    assert.deepEqual(verifyInternalAuth(secret, header, now - 61), { ok: false, reason: 'expired' });
  });

  test('changing the user id breaks the signature', () => {
    const header = signInternalAuth(secret, 'user_2abc', now);
    const tampered = header.replace('user_2abc', 'user_2abd');
    assert.deepEqual(verifyInternalAuth(secret, tampered, now), { ok: false, reason: 'bad-signature' });
  });

  test('moving the timestamp breaks the signature', () => {
    const header = signInternalAuth(secret, 'user_2abc', now);
    const tampered = header.replace(`.${now}.`, `.${now + 1}.`);
    assert.deepEqual(verifyInternalAuth(secret, tampered, now), { ok: false, reason: 'bad-signature' });
  });

  test('an altered signature is rejected', () => {
    const header = signInternalAuth(secret, 'user_2abc', now);
    assert.deepEqual(verifyInternalAuth(secret, flipLast(header), now), { ok: false, reason: 'bad-signature' });
  });

  test('a header signed with another secret is rejected', () => {
    const header = signInternalAuth('another-secret-with-enough-entropy-00', 'user_2abc', now);
    assert.deepEqual(verifyInternalAuth(secret, header, now), { ok: false, reason: 'bad-signature' });
  });

  test('a missing header is reported as missing', () => {
    assert.deepEqual(verifyInternalAuth(secret, undefined, now), { ok: false, reason: 'missing' });
    assert.deepEqual(verifyInternalAuth(secret, '', now), { ok: false, reason: 'missing' });
  });

  test('malformed headers are rejected before any HMAC work', () => {
    const valid = signInternalAuth(secret, 'user_2abc', now);
    for (const header of [
      'Bearer abc',
      valid.replace(/^v1/, 'v2'),
      `${valid}.extra`,
      valid.replace(`.${now}.`, '.soon.'),
      valid.replace('user_2abc', 'user 2abc'),
      'x'.repeat(600),
    ]) {
      assert.deepEqual(verifyInternalAuth(secret, header, now), { ok: false, reason: 'malformed' }, header);
    }
  });

  test('a secret shorter than 32 characters is refused on both sides', () => {
    assert.throws(() => signInternalAuth('', 'user_2abc', now), /at least 32/);
    assert.throws(() => signInternalAuth('changeme', 'user_2abc', now), /at least 32/);
    assert.throws(() => verifyInternalAuth('changeme', 'v1.1..x', now), /at least 32/);
  });

  test('signing refuses a user id the format cannot carry', () => {
    assert.throws(() => signInternalAuth(secret, 'user.2abc', now), /cannot carry/);
  });
});
