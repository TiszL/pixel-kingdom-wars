/** Explicit companion entrypoint: no migrations, backfills, chain services,
 * settlement or ordinary API registration. Caddy routes only native paths. */
import { loadNativeServiceConfig } from '../config';
import { createDb } from '../db/client';
import { assertMigrationsCurrent } from '../db/migrate';
import { buildNativePresentationApp } from './app';

async function main(): Promise<void> {
  const config = loadNativeServiceConfig();
  const { db, sql } = createDb(config.DATABASE_URL, { max: config.NATIVE_DB_POOL_MAX });
  let app: Awaited<ReturnType<typeof buildNativePresentationApp>> | undefined;
  try {
    await assertMigrationsCurrent(db);
    app = await buildNativePresentationApp(config, db);
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      try { await app?.close(); } finally { await sql.end(); }
    };
    process.once('SIGINT', () => { void close(); });
    process.once('SIGTERM', () => { void close(); });
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (error) {
    await app?.close().catch(() => undefined); await sql.end(); throw error;
  }
}

void main().catch((error: unknown) => {
  // Config/schema messages name fields only. Runtime failures never print DSNs,
  // cookies, key material, SQL parameters or tester wallets to a launch log.
  console.error(error instanceof Error && error.message.startsWith('Invalid native service configuration:')
    ? error.message : 'Native presentation service failed to start');
  process.exitCode = 1;
});
