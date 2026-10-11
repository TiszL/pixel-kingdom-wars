/**
 * One-shot TOTP secret migration/rotation. It never prints wallets, key ids,
 * ciphertext or plaintext — only aggregate counts.
 *
 * Dry verification:
 *   pnpm --filter @shardkeep/api db:rewrap-twofa
 * Apply after TWOFA_ENCRYPTION_KEYS has the new key first and every old key next:
 *   pnpm --filter @shardkeep/api db:rewrap-twofa --apply
 */
import { rewrapTotpSecrets } from '../auth/twofa';
import { loadConfig } from '../config';
import { createDb } from './client';
import { assertMigrationsCurrent } from './migrate';

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes('--apply');
  const unknown = process.argv.slice(2).filter((arg) => arg !== '--apply');
  if (unknown.length > 0) throw new Error('unknown argument (supported: --apply)');
  const config = loadConfig();
  const { db, sql } = createDb(config.DATABASE_URL, { max: 2 });
  try {
    await assertMigrationsCurrent(db);
    const result = await rewrapTotpSecrets(db, { apply });
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...result }));
    if (apply && result.raced > 0) {
      throw new Error('some TOTP rows changed concurrently; rerun dry-run and apply until needsRewrap is zero');
    }
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : '2FA rewrap failed');
  process.exitCode = 1;
});
