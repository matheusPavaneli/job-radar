import { createHmac, timingSafeEqual } from 'node:crypto';

export const INTERNAL_AUTH_HEADER = 'x-internal-auth';
export const MAX_SKEW_SECONDS = 60;
export const MIN_SECRET_LENGTH = 32;

const VERSION = 'v1';
const MAX_HEADER_LENGTH = 512;
const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TIMESTAMP = /^\d{1,12}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

export type VerifyResult =
  | { ok: true; userId: string | null }
  | { ok: false; reason: 'missing' | 'malformed' | 'expired' | 'bad-signature' };

export function assertInternalAuthSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`internal auth secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
}

function digest(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

export function signInternalAuth(secret: string, userId: string | null, nowSeconds: number): string {
  assertInternalAuthSecret(secret);
  if (userId !== null && !USER_ID.test(userId)) throw new Error('userId has characters the header cannot carry');
  const payload = `${VERSION}.${Math.floor(nowSeconds)}.${userId ?? ''}`;
  return `${payload}.${digest(secret, payload).toString('base64url')}`;
}

export function verifyInternalAuth(secret: string, header: string | undefined, nowSeconds: number): VerifyResult {
  assertInternalAuthSecret(secret);
  if (header === undefined || header === '') return { ok: false, reason: 'missing' };
  if (header.length > MAX_HEADER_LENGTH) return { ok: false, reason: 'malformed' };

  const parts = header.split('.');
  if (parts.length !== 4) return { ok: false, reason: 'malformed' };
  const [version, timestamp, userId, signature] = parts as [string, string, string, string];
  if (version !== VERSION || !TIMESTAMP.test(timestamp) || !SIGNATURE.test(signature)) {
    return { ok: false, reason: 'malformed' };
  }
  if (userId !== '' && !USER_ID.test(userId)) return { ok: false, reason: 'malformed' };

  const expected = digest(secret, `${version}.${timestamp}.${userId}`);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad-signature' };
  }
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) return { ok: false, reason: 'expired' };

  return { ok: true, userId: userId === '' ? null : userId };
}
