/**
 * CLI: THAW Land Deeds — the one-way step that makes deeds actually tradeable
 * (owner decision 2026-07-29: "deed nfts should be tradeable and should have
 * royalty fee"). The 5% royalty is ALREADY on the collection and on each asset
 * (Royalties plugin, creators [admin @100%]) — this script touches ONLY the
 * per-asset PermanentFreezeDelegate.
 *
 * That royalty is MARKETPLACE-HONOURED, not enforced on chain: the rule set is
 * `None`, so mpl-core ABSTAINS on transfer. Tensor / Magic Eden pay it because
 * they choose to; a direct wallet-to-wallet transfer pays nothing. Enforcement
 * would require a ProgramAllowList rule set, which blocks trading anywhere off
 * the list.
 *
 *   API_BASE_URL=https://api.example ADMIN_KEYPAIR_PATH=… DATABASE_URL=… \
 *   pnpm --filter @shardkeep/scripts deed:thaw --confirm [--asset <id>]
 *
 * SAFETY INTERLOCK (the whole reason this is a separate, gated script): a
 * thawed deed can be SOLD, and a sold deed conveys a base ONLY because the
 * buyer can claim it (apps/api /base/claimable + /base/claim, S1-Q pull-based).
 * Thawing while that path is undeployed creates the state we must never allow:
 * the buyer holds an NFT that conveys nothing while the seller keeps the base.
 * So this refuses to run unless (1) --confirm is passed AND (2) the live API at
 * API_BASE_URL actually serves the claim route (probe expects 401 = route
 * exists, auth required; 404 = not deployed → abort).
 *
 * Thawing is admin-authority-only and re-runnable: setting frozen=false on an
 * already-thawed asset is a harmless no-op write.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import { thawLandDeed } from '@shardkeep/chain';

/** Probe the deployed API for the pull-based claim route. 401 = deployed and
 *  authenticated (the only acceptable answer); anything else aborts. */
async function claimPathDeployed(apiBase: string): Promise<{ ok: boolean; detail: string }> {
  const url = `${apiBase.replace(/\/$/, '')}/base/claimable`;
  try {
    const res = await fetch(url, { method: 'GET' });
    if (res.status === 401) return { ok: true, detail: `${url} → 401 (deployed, auth required)` };
    if (res.status === 404) return { ok: false, detail: `${url} → 404 — claim path NOT deployed` };
    return { ok: false, detail: `${url} → ${res.status} — unexpected; expected 401` };
  } catch (e) {
    return { ok: false, detail: `${url} → unreachable (${(e as Error).message})` };
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const confirm = process.argv.includes('--confirm');
  const only = arg('asset');
  const rpcUrl = process.env['SOLANA_RPC_URL'] ?? 'https://api.devnet.solana.com';
  const adminPath = process.env['ADMIN_KEYPAIR_PATH'] ?? join(homedir(), '.config', 'solana', 'id.json');
  const dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) throw new Error('DATABASE_URL required (the players table is the deed registry)');
  const apiBase = process.env['API_BASE_URL'];
  if (!apiBase) throw new Error('API_BASE_URL required — the claim path must be verified before any thaw');

  const addressesPath = resolve(import.meta.dirname, '..', '..', 'infra', 'devnet.addresses.json');
  const collection = (JSON.parse(readFileSync(addressesPath, 'utf8')) as { deedCollection?: string }).deedCollection;
  if (!collection) throw new Error('deedCollection missing from infra/devnet.addresses.json');

  const sql = postgres(dbUrl);
  const rows = only
    ? await sql<Array<{ wallet: string; deed_asset_id: string }>>`
        select wallet, deed_asset_id from players where deed_asset_id = ${only}`
    : await sql<Array<{ wallet: string; deed_asset_id: string }>>`
        select wallet, deed_asset_id from players where deed_asset_id is not null order by wallet`;

  console.log('');
  console.log('=== DEED THAW — IRREVERSIBLE IN PRACTICE, READ THIS ===');
  console.log(`collection : ${collection}`);
  console.log(`rpc        : ${rpcUrl}`);
  console.log(`deeds      : ${rows.length}${only ? ` (single asset ${only})` : ' (every minted deed)'}`);
  console.log('');
  console.log('WHAT BECOMES POSSIBLE THE MOMENT THIS RUNS:');
  console.log('  • every thawed deed becomes TRANSFERABLE — holders can sell it on any');
  console.log('    Metaplex Core marketplace (Tensor / Magic Eden). The 5% creator royalty');
  console.log('    is MARKETPLACE-HONOURED, NOT enforced on chain (ruleSet None — mpl-core');
  console.log('    abstains on transfer): those venues pay it by choice, and a direct');
  console.log('    wallet-to-wallet transfer pays us NOTHING. Enforcement would need a');
  console.log('    ProgramAllowList rule set, which blocks trading anywhere off the list;');
  console.log('  • a deed that changes hands makes the BUYER able to POST /base/claim,');
  console.log('    which moves STRUCTURES + LAND + PROGRESS + the deed off the seller;');
  console.log('  • the SELLER is left a fresh, unpaid base-less account and KEEPS every');
  console.log('    balance, item, trophy and streak (a deed never conveys currency);');
  console.log('  • pending builder jobs and active shields move WITH the base;');
  console.log('  • a buyer who already owns a base CANNOT claim (the transfer parks);');
  console.log('  • deeds are no longer soulbound: this cannot be undone for an asset');
  console.log('    that has already been transferred away.');
  console.log('');

  const probe = await claimPathDeployed(apiBase);
  console.log(`claim path : ${probe.detail}`);
  if (!probe.ok) {
    await sql.end();
    throw new Error('REFUSING TO THAW: the buyer-claim path is not live. Thawing without it '
      + 'means a sold deed conveys NOTHING — the seller keeps the base and the buyer '
      + 'holds a receipt. Deploy apps/api with /base/claimable + /base/claim first.');
  }
  if (!confirm) {
    await sql.end();
    console.log('');
    console.log('DRY RUN — nothing was thawed. Re-run with --confirm to execute.');
    process.exit(1);
  }
  if (rows.length === 0) {
    await sql.end();
    console.log('No deeds to thaw.');
    return;
  }

  console.log(`--confirm given → thawing ${rows.length} deed(s)…`);
  const adminSecret = Uint8Array.from(JSON.parse(readFileSync(adminPath, 'utf8')) as number[]);
  let failed = 0;
  for (const r of rows) {
    try {
      await thawLandDeed({ rpcUrl, adminSecret, collection, asset: r.deed_asset_id });
      console.log(`  ✓ ${r.deed_asset_id} (${r.wallet.slice(0, 4)}…) thawed`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${r.deed_asset_id}: ${(e as Error).message}`);
    }
  }
  await sql.end();
  console.log('');
  console.log(`done: ${rows.length - failed} thawed, ${failed} failed.`);
  console.log('REMINDER: flip MARKETPLACE.tradingEnabled in packages/shared/src/constants.ts');
  console.log('so the in-app collection view stops calling deeds soulbound.');
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
