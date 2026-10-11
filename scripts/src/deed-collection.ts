/**
 * CLI: create the Land Deed Core collection on devnet (Phase 6, one-time).
 * Creates a Metaplex Core collection with a 5% marketplace-honoured royalty to
 * DEED_ROYALTY_CREATOR, falling back to the admin signer when that is unset
 * (ruleSet None — not enforced on chain; enforcement would require a
 * ProgramAllowList rule set, which blocks trading anywhere off the list),
 * then writes the address into infra/devnet.addresses.json (`deedCollection`),
 * where apps/api's deedMinter() picks it up on next boot.
 *
 *   SOLANA_RPC_URL=https://api.devnet.solana.com \
 *   ADMIN_KEYPAIR_PATH=~/.config/solana/id.json \
 *   pnpm --filter @shardkeep/scripts deed:collection -- --uri https://<host>/deed-collection.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { MARKETPLACE } from '@shardkeep/shared';
import { createDeedCollection } from '@shardkeep/chain';

/** One royalty number for the whole deed story (CLAUDE.md: game numbers live
 *  in constants.ts). The collection is the SOURCE OF TRUTH — every mint and the
 *  backfill copy the plugin this creates rather than re-deriving it. */
const ROYALTY_BPS = MARKETPLACE.deedRoyaltyBps;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const rpcUrl = process.env['SOLANA_RPC_URL'] ?? 'https://api.devnet.solana.com';
  const adminPath = process.env['ADMIN_KEYPAIR_PATH'] ?? join(homedir(), '.config', 'solana', 'id.json');
  const uri = arg('uri') ?? 'https://pixelkingdomwars.com/deed-collection.json';

  const adminSecret = Uint8Array.from(JSON.parse(readFileSync(adminPath, 'utf8')) as number[]);
  console.log(`[deed] cluster ${rpcUrl}`);

  // WHERE the 5% is paid is CONFIG, not the signer (owner 2026-07-29). Unset
  // keeps the devnet status quo — the admin key. It can be moved later without
  // re-creating anything: `deed:royalty:creator` repoints the live collection
  // and re-stamps every minted deed.
  const royaltyCreator = process.env['DEED_ROYALTY_CREATOR']?.trim() || undefined;

  const { collection, royaltyCreator: payee } = await createDeedCollection({
    rpcUrl, adminSecret, name: 'Pixel Kingdom Wars — Land Deeds', uri,
    royaltyBps: ROYALTY_BPS, royaltyCreator,
  });

  // Persist into the versioned address book the api reads at boot.
  const addressesPath = resolve(import.meta.dirname, '..', '..', 'infra', 'devnet.addresses.json');
  const addresses = JSON.parse(readFileSync(addressesPath, 'utf8')) as Record<string, unknown>;
  addresses['deedCollection'] = collection;
  addresses['updatedAt'] = new Date().toISOString();
  writeFileSync(addressesPath, `${JSON.stringify(addresses, null, 2)}\n`);

  console.log('\n✅ Land Deed collection created (soulbound deeds mint into it post-entry)');
  console.log(`   collection: ${collection}`);
  console.log(`   royalty:    ${ROYALTY_BPS / 100}% → ${payee}${royaltyCreator ? ' (DEED_ROYALTY_CREATOR)' : ' (admin signer — DEED_ROYALTY_CREATOR unset)'}`);
  console.log(`   written to: ${addressesPath}`);
  console.log('\nRestart the api server to enable deed minting.');
}

main().catch((e) => { console.error(e); process.exit(1); });
