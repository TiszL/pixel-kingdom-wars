/**
 * Stamp the deed royalty onto EXISTING deed ASSETS (owner 2026-07-29: "why does
 * it say seller fee 0% ... it should have creator royalty 5%").
 *
 * WHY this exists: the 5% has always been on the COLLECTION, and Metaplex Core
 * lets member assets inherit it. But an explorer, wallet or aggregator that
 * reads only the ASSET finds no Royalties plugin and prints "Seller Fee 0%" with
 * no creators, which a buyer reads as "this NFT pays no royalty". Deeds mint
 * with their own plugin from now on; this backfills the ones minted before that.
 *
 * WHAT "5% ROYALTY" ACTUALLY MEANS HERE: it is MARKETPLACE-HONOURED, not
 * enforced on chain. The rule set is `None`, which makes mpl-core ABSTAIN on
 * transfer — Tensor / Magic Eden pay the creator because they choose to, and a
 * direct wallet-to-wallet transfer pays nothing at all. Enforcement would
 * require a ProgramAllowList rule set, which blocks trading anywhere off the
 * list.
 *
 * Economically a no-op: the plugin written is COPIED FROM THE COLLECTION
 * verbatim (same basis points, same creators, same ruleSet), so the collection
 * stays the single source of truth even though an asset-level plugin REPLACES
 * the collection's for that asset. It only makes the number legible everywhere.
 *
 * SAFETY: this WRITES to assets it does not own — a deed sold on Tensor belongs
 * to a stranger, and the admin's update authority is what still lets us touch
 * it. So it preflights the collection, prints what it is about to stamp, ABORTS
 * on any mismatch with MARKETPLACE.deedRoyaltyBps, and refuses the fleet-wide
 * mode without --confirm. A single --asset run stays immediate (it is the
 * repair-one-deed path and the preflight already gates the numbers).
 *
 *   ADMIN_KEYPAIR_PATH=~/.config/solana/id.json \
 *   pnpm --filter @shardkeep/scripts deed:royalty --confirm [--asset <id>]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { MARKETPLACE } from '@shardkeep/shared';
import { fetchDeedCollectionRoyalties, loadAddresses, setDeedRoyalties } from '@shardkeep/chain';
import postgres from 'postgres';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
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

  // --- PREFLIGHT: read the collection BEFORE writing anything ---------------
  const onChain = await fetchDeedCollectionRoyalties({ rpcUrl, adminSecret, collection });
  console.log('');
  console.log('=== DEED ROYALTY BACKFILL — writes to assets you may no longer own ===');
  console.log(`collection : ${collection}`);
  console.log(`rpc        : ${rpcUrl}`);
  console.log(`on chain   : ${onChain.basisPoints} bps (${onChain.basisPoints / 100}%), ruleSet ${onChain.ruleSet}`);
  console.log(`creators   : ${onChain.creators.map((c) => `${c.address} @${c.percentage}%`).join(', ') || '(none)'}`);
  console.log(`intended   : ${MARKETPLACE.deedRoyaltyBps} bps (MARKETPLACE.deedRoyaltyBps)`);
  console.log(`deeds      : ${assets.length}${only ? ` (single asset ${only})` : ' (EVERY minted deed)'}`);
  console.log('');
  if (onChain.basisPoints !== MARKETPLACE.deedRoyaltyBps) {
    throw new Error(
      `REFUSING TO WRITE: the collection carries ${onChain.basisPoints} bps but `
      + `MARKETPLACE.deedRoyaltyBps is ${MARKETPLACE.deedRoyaltyBps}. Stamping either number now `
      + 'splits the fleet into two royalty rates. Reconcile the constant with the chain first.',
    );
  }
  if (onChain.creators.length === 0) {
    throw new Error('REFUSING TO WRITE: the collection Royalties plugin has no creators — '
      + 'a 0-creator royalty pays nobody.');
  }
  console.log('NOTE: ruleSet None means this royalty is MARKETPLACE-HONOURED, not enforced on');
  console.log('chain. Tensor / Magic Eden pay it by choice; a direct transfer pays nothing.');
  console.log('');
  if (!only && !confirm) {
    console.log('DRY RUN — nothing written. Re-run with --confirm to stamp every deed above.');
    process.exit(1);
  }

  console.log(`[deed-royalty] ${assets.length} deed(s) → ${onChain.basisPoints / 100}% to the collection creator`);
  let failed = 0;
  for (const asset of assets) {
    try {
      const how = await setDeedRoyalties({
        rpcUrl, adminSecret, collection, asset, royaltyBps: MARKETPLACE.deedRoyaltyBps,
      });
      console.log(`  ✓ ${asset} royalties ${how}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${asset}: ${(e as Error).message}`);
    }
  }
  console.log(`done: ${assets.length - failed} ok, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
