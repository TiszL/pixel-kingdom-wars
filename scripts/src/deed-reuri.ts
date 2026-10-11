/**
 * CLI: repoint EVERY minted deed's on-chain metadata URI at the current public
 * metadata home (R2 bucket, or DEED_METADATA_BASE_URL). One-time fixup for
 * deeds minted while the URI still said localhost (owner 2026-07-26); safe to
 * re-run — updating to the same URI is a harmless no-op write.
 *
 * ALSO the F2 migration (security review 2026-07-29, thaw blocker): deeds
 * minted before the asset-keyed scheme carry `<base>/deed/<WALLET>.json` and a
 * name built from the minting wallet, both of which follow the SELLER after a
 * sale. This repoints every deed at `<base>/deed/asset/<ASSET>.json` and
 * renames it after the asset, so a traded deed describes the base it conveys.
 * Run it BEFORE thawing; new mints already use the asset-keyed identity.
 *
 *   ADMIN_KEYPAIR_PATH=… R2_PUBLIC_BASE_URL=… \
 *   pnpm --filter @shardkeep/scripts deed:reuri
 *
 * Reads deeded wallets straight from Postgres (DATABASE_URL) — the players
 * table is the registry of minted assets (deed_asset_id).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import { deedAssetName, deedJsonUri, updateLandDeedUri } from '@shardkeep/chain';

async function main(): Promise<void> {
  const rpcUrl = process.env['SOLANA_RPC_URL'] ?? 'https://api.devnet.solana.com';
  const adminPath = process.env['ADMIN_KEYPAIR_PATH'] ?? join(homedir(), '.config', 'solana', 'id.json');
  const dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) throw new Error('DATABASE_URL required');
  const base = (process.env['R2_PUBLIC_BASE_URL'] ?? process.env['DEED_METADATA_BASE_URL'])?.replace(/\/$/, '');
  if (!base) throw new Error('R2_PUBLIC_BASE_URL (or DEED_METADATA_BASE_URL) required — the URI must be PUBLIC');

  const addressesPath = resolve(import.meta.dirname, '..', '..', 'infra', 'devnet.addresses.json');
  const collection = (JSON.parse(readFileSync(addressesPath, 'utf8')) as { deedCollection?: string }).deedCollection;
  if (!collection) throw new Error('deedCollection missing from infra/devnet.addresses.json (run deed:collection first)');
  const adminSecret = Uint8Array.from(JSON.parse(readFileSync(adminPath, 'utf8')) as number[]);

  const sql = postgres(dbUrl);
  const rows = await sql<Array<{ wallet: string; deed_asset_id: string }>>`
    select wallet, deed_asset_id from players where deed_asset_id is not null`;
  console.log(`[deed-reuri] ${rows.length} deed(s) → ${base}/deed/asset/<asset>.json`);
  let failed = 0;
  for (const r of rows) {
    const uri = deedJsonUri(base, r.deed_asset_id);
    const name = deedAssetName(r.deed_asset_id);
    try {
      await updateLandDeedUri({ rpcUrl, adminSecret, collection, asset: r.deed_asset_id, uri, name });
      console.log(`  ✓ ${r.deed_asset_id} (held by ${r.wallet.slice(0, 4)}…) → ${uri}`);
    } catch (e) {
      // One burnt/unreadable asset must not leave the rest of the fleet on the
      // wallet-keyed URI — that is the state the thaw is blocked on. Report and
      // continue; the run exits non-zero so a partial migration is never taken
      // for a clean one.
      failed++;
      console.error(`  ✗ ${r.deed_asset_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await sql.end();
  if (failed > 0) throw new Error(`${failed}/${rows.length} deed(s) still on the old URI — re-run before thawing`);
}

main().catch((e) => { console.error(e); process.exit(1); });
