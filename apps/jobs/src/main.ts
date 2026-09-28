import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import postgres from 'postgres';
import { AppModule } from './app.module.ts';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const sql = postgres(requireEnv('DATABASE_URL'), { max: 5, idle_timeout: 20, connect_timeout: 10 });
const app = await NestFactory.create(AppModule.register({ sql, internalAuthSecret: requireEnv('INTERNAL_HMAC_SECRET') }));
await app.listen(Number(process.env['PORT'] ?? 4001));

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`received ${signal}, closing`);
  await app.close();
  await sql.end({ timeout: 5 });
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    shutdown(signal).catch((error: unknown) => {
      console.error('shutdown failed', error);
      process.exitCode = 1;
    });
  });
}
process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection', reason);
  process.exitCode = 1;
});
