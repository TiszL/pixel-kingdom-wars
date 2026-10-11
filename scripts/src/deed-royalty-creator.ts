/**
 * Repoint the Land Deed royalty to the CONFIGURED destination
 * (owner 2026-07-29: "5% royalty I want to be flexible so lets add it in env
 * file and I will set address manually there so before mainnet deployment I
 * will add final address there").
 *
 * WHAT IT CHANGES: the address the 5% is paid to. Nothing else — not the rate
 * (MARKETPLACE.deedRoyaltyBps), not the rule set, not ownership, not freeze.
 *
 * WHY IT IS ONE COMMAND AND NOT TWO: in mpl-core an asset-level Royalties
 * plugin REPLACES the collection's for that asset, and every deed carries its
 * own copy (so explorers stop printing "Seller Fee 0%"). Repointing only the
 * collection would therefore move nothing at all for existing deeds. So this
 * script does both halves in the only safe order:
 *   1. repoint the COLLECTION (the source of truth), then
 *   2. re-stamp EVERY minted deed by COPYING the collection verbatim.
 * Step 2 is the existing `deed:royalty` backfill with a destination assertion
 * added, which is what proves each asset copied the NEW address.
 *
 * SAFETY: it writes to assets it does not own (a deed sold on Tensor belongs to
 * a stranger; the admin's update authority is what still permits the write). So
 * it preflights, prints old vs new, and refuses to write without --confirm.
 *
 * NO MULTISIG IS INVOLVED (owner: solo builder). The treasury is moved by
 * setting one env var and running one command; the safety comes from the
 * preflight and the mint-time assertion, not from ceremony.
 *
 * Preflight (writes NOTHING, prints the diff):
 *   DEED_ROYALTY_CREATOR=<address> \
 *   ADMIN_KEYPAIR_PATH=~/.config/solana/id.json \
 *   DATABASE_URL=postgres://... \
 *   pnpm --filter @shardkeep/scripts deed:royalty:creator
 *
 * Apply (add --confirm; optionally --asset <id> to repair a single deed):
 *   ... pnpm --filter @shardkeep/scripts deed:royalty:creator --confirm
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { MARKETPLACE } from '@shardkeep/shared';
import {
  fetchDeedCollectionRoyalties, loadAddresses, setDeedCollectionRoyaltyCreator, setDeedRoyalties,
} from '@shardkeep/chain';
import postgres from 'postgres';

/** Same shape check the api applies at boot (config.ts BASE58_ADDRESS), so a
 *  typo is caught here rather than written on chain. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const creator = process.env['DEED_ROYALTY_CREATOR']?.trim();
  if (!creator) {
    throw new Error(
      'DEED_ROYALTY_CREATOR is not set. This script exists to write THAT address on chain; '
      + 'there is no default worth guessing. Put the final treasury address in .env first.',
    );
  }
  if (!BASE58_ADDRESS.test(creator)) {
    throw new Error(`DEED_ROYALTY_CREATOR="${creator}" is not a base58 Solana address.`);
  }

  const rpcUrl = process.env['SOLANA_RPC_URL'] ?? 'https://api.devnet.solana.com';
  const adminPath = process.env['ADMIN_KEYPAIR_PATH'] ?? join(homedir(), '.config', 'solana', 'id.json');
  const adminSecret = Uint8Array.from(JSON.parse(readFileSync(adminPath, 'utf8')) as number[]);
  const repoRoot = resolve(import.meta.dirname, '..', '..');
  const collection = loadAddresses(repoRoot)?.deedCollection;
  if (!collection) throw new Error('no deedCollection in infra/devnet.addresses.json');

  const only = arg('asset');
  const confirm = process.argv.includes('--confirm');

  let assets: string[];
  if (only) {
    assets = [only];
  } else {
    const url = process.env['DATABASE_URL'];
    if (!url) throw new Error('DATABASE_URL required (the players table is the deed registry)');
    const sql = postgres(url);
    const rows = await sql<Array<{ deed_asset_id: string }>>`
      select deed_asset_id from players where deed_asset_id is not null`;
    assets = rows.map((r) => r.deed_asset_id);
    await sql.end();
  }

  // --- PREFLIGHT: read the LIVE collection before writing anything -----------
  const onChain = await fetchDeedCollectionRoyalties({ rpcUrl, adminSecret, collection });
  const currentCreators = onChain.creators.map((c) => `${c.address} @${c.percentage}%`);
  const alreadyPointed = onChain.creators.length === 1 && onChain.creators[0]?.address === creator;

  console.log('');
  console.log('=== DEED ROYALTY DESTINATION CHANGE ===');
  console.log(`collection : ${collection}`);
  console.log(`rpc        : ${rpcUrl}`);
  console.log(`rate       : ${onChain.basisPoints} bps (${onChain.basisPoints / 100}%), ruleSet ${onChain.ruleSet} — UNCHANGED`);
  console.log('');
  console.log(`OLD payee  : ${currentCreators.join(', ') || '(none)'}`);
  console.log(`NEW payee  : ${creator} @100%   (DEED_ROYALTY_CREATOR)`);
  console.log('');
  console.log(`deeds to re-stamp : ${assets.length}${only ? ` (single asset ${only})` : ' (EVERY minted deed)'}`);
  console.log('');

  if (onChain.basisPoints !== MARKETPLACE.deedRoyaltyBps) {
    throw new Error(
      `REFUSING TO WRITE: the collection carries ${onChain.basisPoints} bps but `
      + `MARKETPLACE.deedRoyaltyBps is ${MARKETPLACE.deedRoyaltyBps}. Reconcile the RATE first — `
      + 'moving the destination while the rate is in dispute splits the fleet twice over.',
    );
  }
  if (alreadyPointed) {
    console.log('NOTE: the collection ALREADY pays this address. Continuing anyway re-stamps the');
    console.log('assets, which is the useful half if a previous run stopped partway through.');
    console.log('');
  }
  console.log('REMINDER: ruleSet None means this royalty is MARKETPLACE-HONOURED, not enforced on');
  console.log('chain. Tensor / Magic Eden pay it by choice; a direct transfer pays nothing.');
  console.log('This writes to deeds that may now belong to other people.');
  console.log('');

  if (!confirm) {
    console.log('DRY RUN — nothing written. Re-run with --confirm to apply the change above.');
    process.exit(1);
  }

  // --- 1. COLLECTION FIRST: it is what every asset copies -------------------
  if (!only) {
    const moved = await setDeedCollectionRoyaltyCreator({
      rpcUrl, adminSecret, collection, creator, royaltyBps: MARKETPLACE.deedRoyaltyBps,
    });
    console.log(`[collection] ${moved.before.join(', ') || '(none)'} → ${moved.after.join(', ')} at ${moved.basisPoints} bps`);
  } else {
    // --asset repairs ONE deed against the collection as it already stands; it
    // must not silently move the fleet's destination as a side effect.
    console.log('[collection] untouched (--asset mode: repairing one deed against the current collection)');
  }

  // --- 2. VERIFY the collection really moved, before touching any asset ------
  const after = await fetchDeedCollectionRoyalties({ rpcUrl, adminSecret, collection });
  const ok = after.creators.length === 1 && after.creators[0]?.address === creator;
  if (!ok) {
    throw new Error(
      `HALTED: the collection now pays [${after.creators.map((c) => c.address).join(', ')}], not ${creator}. `
      + 'No asset was touched. Re-run once the collection is correct.',
    );
  }

  // --- 3. Every asset copies the (now repointed) collection ------------------
  console.log(`[assets] re-stamping ${assets.length} deed(s) from the collection…`);
  let failed = 0;
  for (const asset of assets) {
    try {
      const how = await setDeedRoyalties({
        rpcUrl, adminSecret, collection, asset,
        royaltyBps: MARKETPLACE.deedRoyaltyBps,
        // The destination assertion: each write proves it copied the NEW payee.
        expectedCreator: creator,
      });
      console.log(`  ✓ ${asset} royalties ${how} → ${creator}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${asset}: ${(e as Error).message}`);
    }
  }
  console.log(`done: ${assets.length - failed} ok, ${failed} failed.`);
  if (failed > 0) {
    console.error('');
    console.error('The COLLECTION is repointed but some deeds still carry the old payee. Re-run —');
    console.error('the collection step is idempotent and only the failures need re-stamping.');
    process.exit(1);
  }
  console.log('');
  console.log(`✅ Deed royalty now pays ${creator}. Keep DEED_ROYALTY_CREATOR set to this address:`);
  console.log('   the api asserts it at mint time and refuses to mint if the two ever disagree.');
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
