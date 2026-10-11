/** One internal-identity boundary for public figures and campaign eligibility. */
import { and, sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { playtestInternalWallets, playtestMintEvidence } from '../db/playtestCampaignSchema';

export function notInternalPlaytestWallet(wallet: SQL, configured: readonly string[]): SQL {
  const env = configured.length
    ? sql`and ${wallet} not in (${sql.join(configured.map(w => sql`${w}`), sql`, `)})` : sql``;
  return sql`not exists(select 1 from playtest_internal_wallets i where i.wallet=${wallet}) ${env}`;
}

export async function internalPlaytestWallets(db: DbOrTx, configured: readonly string[]): Promise<Set<string>> {
  const durable = await db.select({ wallet: playtestInternalWallets.wallet }).from(playtestInternalWallets);
  return new Set([...configured, ...durable.map(w => w.wallet)]);
}

/** Full sessions are retained audit records: expiry/logout never removes the
 * proof of sign-in. Use original mint ownership and historical game links, so
 * selling the deed cannot revoke a guaranteed place. A credited deposit is
 * deliberately not required: legacy genuine purchases predate that ledger.
 * Candidates cannot outrun the completed collection inventory: a newer verified
 * asset alone does not prove that all earlier original mints were reconciled.
 * Display-only tester_board_hidden must not revoke an original minter's right. */
export async function foundingMintCandidates(db: DbOrTx, configured: readonly string[]) {
  const m = playtestMintEvidence;
  return db.select().from(m).where(and(
    sql`${m.verifiedAt} is not null`,
    sql`${m.slot}::numeric <= (select through_slot::numeric from playtest_mint_inventory where id='land-deeds')`,
    notInternalPlaytestWallet(sql`${m.originalWallet}`, configured),
    sql`exists(select 1 from players p join sessions s on s.wallet=p.wallet
      where p.wallet=${m.originalWallet} and s.scope='full')`,
    sql`(exists(select 1 from bases b where b.deed_asset_id=${m.assetId})
      or exists(select 1 from players p where p.deed_asset_id=${m.assetId})
      or exists(select 1 from base_transfers t where t.deed_asset_id=${m.assetId}))`,
  )).then(rows => rows.sort((a, b) => {
    const sa = BigInt(a.slot!); const sb = BigInt(b.slot!);
    return sa < sb ? -1 : sa > sb ? 1 : a.transactionIndex! - b.transactionIndex! || a.assetId.localeCompare(b.assetId);
  }).filter((m, i, ordered) => ordered.findIndex(other => other.originalWallet === m.originalWallet) === i));
}
