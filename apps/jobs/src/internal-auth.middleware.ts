import type { IncomingMessage, ServerResponse } from 'node:http';
import { assertInternalAuthSecret, INTERNAL_AUTH_HEADER, verifyInternalAuth } from '@job-radar/internal-auth';

const UNAUTHORIZED = JSON.stringify({ errors: [{ message: 'Unauthorized', extensions: { code: 'UNAUTHENTICATED' } }] });

export function internalAuthMiddleware(secret: string, nowSeconds: () => number = () => Date.now() / 1000) {
  assertInternalAuthSecret(secret);
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const header = req.headers[INTERNAL_AUTH_HEADER];
    const result = verifyInternalAuth(secret, typeof header === 'string' ? header : undefined, nowSeconds());
    if (!result.ok) {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(UNAUTHORIZED);
      return;
    }
    next();
  };
}
