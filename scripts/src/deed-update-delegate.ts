/**
 * Grant (or rotate) the DEED-OPS UpdateDelegate on the Land Deed collection
 * (owner GO on dynamic deeds, 2026-08-03: the unattended chain loop must stop
 * holding the admin key).
 *
 * WHAT IT CHANGES: the COLLECTION-level UpdateDelegate plugin's
 * additionalDelegates list — REPLACED with exactly [DEED_OPS_PUBKEY]. Nothing
 * else: not royalties, not freeze, not ownership, not any asset.
 *
 * WHY: the deed URI sweep (DEED_CHAIN_SYNC) signs a transaction every few
 * minutes from a long-running process, so its key sits in that box's
 * environment. Today that is the ADMIN key — which also mints KEEP, posts
 * epoch roots and moves the treasury. mpl-core accepts a collection-level
 * additionalDelegate as the update authority for every asset in the
 * collection, so a dedicated ops key can sign the sweep instead. Its blast
 * radius if stolen: rewrite deed URIs/names and authority-managed plugins
 * (and mint into the deed collection — an mpl-core given). It can NOT mint
 * KEEP, post epoch roots, or touch the treasury — that is the point.
 *
 * REPLACED, NOT APPENDED (rotation story): the env names ONE ops key, and a
 * rotation must EVICT the old key in the same write that installs the new one.
 * The plugin itself stays admin-managed, so the ops key cannot rewrite its own
 * grant.
 *
 * Preflight (writes NOTHING, prints current vs proposed):
 *   DEED_OPS_PUBKEY=<address> \
 *   ADMIN_KEYPAIR_PATH=~/.config/solana/id.json \
 *   pnpm --filter @shardkeep/scripts deed:update-delegate
 *
 * Apply (add --confirm; --delegate <address> overrides the env):
 *   ... pnpm --filter @shardkeep/scripts deed:update-delegate --confirm
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { addDeedUpdateDelegate, fetchDeedUpdateDelegates, loadAddresses } from '@shardkeep/chain';

/** Same shape check the api applies at boot (config.ts BASE58_ADDRESS), so a
 *  typo is caught here rather than written on chain. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const delegate = arg('delegate') ?? process.env['DEED_OPS_PUBKEY']?.trim();
  if (!delegate) {
    throw new Error(
      'DEED_OPS_PUBKEY is not set (and no --delegate given). This script exists to write THAT '
      + 'address on chain; there is no default worth guessing. Generate the ops keypair first '
      + '(solana-keygen new -o infra/keys/deed-ops.keypair.json) and put its PUBLIC key in .env.',
    );
  }
  if (!BASE58_ADDRESS.test(delegate)) {
    throw new Error(`delegate "${delegate}" is not a base58 Solana address.`);
  }

  const rpcUrl = process.env['SOLANA_RPC_URL'] ?? 'https://api.devnet.solana.com';
  const adminPath = process.env['ADMIN_KEYPAIR_PATH'] ?? join(homedir(), '.config', 'solana', 'id.json');
  const adminSecret = Uint8Array.from(JSON.parse(readFileSync(adminPath, 'utf8')) as number[]);
  const repoRoot = resolve(import.meta.dirname, '..', '..');
  const collection = loadAddresses(repoRoot)?.deedCollection;
  if (!collection) throw new Error('no deedCollection in infra/devnet.addresses.json');

  // A delegate equal to the admin defeats the purpose: the unattended loop
  // would "hold the ops key" while actually holding the key that mints KEEP
  // and moves the treasury — with the delegation hiding that fact.
  const adminPubkey = Keypair.fromSecretKey(adminSecret).publicKey.toBase58();
  if (delegate === adminPubkey) {
    throw new Error(
      `REFUSING: the proposed delegate IS the admin key (${adminPubkey}). Delegating the admin to `
      + 'itself changes nothing and hides that the loop still runs on the master key. Generate a '
      + 'SEPARATE ops keypair and delegate that.',
    );
  }

  const confirm = process.argv.includes('--confirm');

  // --- PREFLIGHT: read the LIVE collection before writing anything -----------
  const current = await fetchDeedUpdateDelegates({ rpcUrl, adminSecret, collection });

  console.log('');
  console.log('=== DEED-OPS UPDATE DELEGATE ===');
  console.log(`collection : ${collection}`);
  console.log(`rpc        : ${rpcUrl}`);
  console.log(`admin      : ${adminPubkey} (plugin stays managed by this key)`);
  console.log('');
  console.log(`CURRENT delegates : ${current === null ? '(no UpdateDelegate plugin — will be ADDED)' : current.join(', ') || '(plugin present, nobody delegated)'}`);
  console.log(`PROPOSED delegates: ${delegate}   (REPLACES the list — old keys are evicted)`);
  console.log('');
  console.log('REMINDER: this key can rewrite every deed\'s URI/name and authority-managed');
  console.log('plugins, and mint into the deed collection. It cannot mint KEEP, post epoch');
  console.log('roots, or touch the treasury — which is why the unattended loop should hold it.');
  console.log('');

  if (current !== null && current.length === 1 && current[0] === delegate) {
    console.log('Already current — the collection delegates exactly this key. Nothing to do.');
    return;
  }

  if (!confirm) {
    console.log('DRY RUN — nothing written. Re-run with --confirm to apply the change above.');
    process.exit(1);
  }

  const r = await addDeedUpdateDelegate({ rpcUrl, adminSecret, collection, delegate });
  console.log(`[collection] UpdateDelegate ${r.action}: [${r.before.join(', ') || 'none'}] → [${r.after.join(', ')}]`);
  console.log('');
  console.log(`✅ Deed-ops delegate is now ${delegate}. To move the unattended loop off the`);
  console.log('   admin key: fund the ops key with SOL for fees, set DEED_OPS_KEYPAIR_PATH to');
  console.log('   its keypair file in the worker\'s env, and restart the worker.');
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
