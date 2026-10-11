/**
 * Devnet bootstrap runner (PLAN.md Phase 3; see the /devnet-deploy skill).
 *   pnpm bootstrap:devnet            — mint + buckets + revoke + config + addresses
 *   pnpm bootstrap:devnet -- --smoke — also run the pay_entry split smoke test
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Connection, Keypair } from '@solana/web3.js';
import { loadAddresses, runBootstrap, smokeTestPayEntry } from '@shardkeep/chain';

const ROOT = resolve(import.meta.dirname, '..', '..');
const RPC = process.env['SOLANA_RPC_URL'] ?? 'https://api.devnet.solana.com';
const ADMIN_PATH = process.env['ADMIN_KEYPAIR_PATH'] ?? join(homedir(), '.config', 'solana', 'id.json');

async function main(): Promise<void> {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(ADMIN_PATH, 'utf8'))));
  const connection = new Connection(RPC, 'confirmed');
  console.log(`[bootstrap] cluster ${RPC}`);
  console.log(`[bootstrap] admin ${admin.publicKey.toBase58()}`);

  const addresses = await runBootstrap({
    connection,
    admin,
    paths: { root: ROOT },
    now: new Date().toISOString(),
  });

  if (process.argv.includes('--smoke')) {
    await smokeTestPayEntry({ connection, admin, addresses: loadAddresses(ROOT) ?? addresses });
  }
  console.log('[bootstrap] done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
