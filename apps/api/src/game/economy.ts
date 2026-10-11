/**
 * Read-only economy transparency derived from the append-only ledger.
 *
 * KEEP and SHARDS have different sources and must never be blended in the
 * dashboard: emission_pool funds the Gold Forge, eligible Ruined Keep KEEP
 * bounties and explicitly budgeted alpha rewards, and receives recycled KEEP
 * sinks. Mining, quests, the daily cache, starter grants and conversion issue
 * SHARDS from shard_genesis. Deposits mirror player-owned KEEP held in custody;
 * they never fund rewards.
 *
 * NOTE (perf): these scan system-account ledger entries. Fine for devnet; a
 * production build can replace them with reconciled roll-up counters.
 */
import { gemsEnabled } from '../config';
import { TOKEN } from '@shardkeep/shared';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { accounts, ledgerEntries, ledgerTransactions, withdrawals } from '../db/schema';
import { utcDay } from './emission';

export async function getEconomyStats(db: DbOrTx, now = new Date()) {
  const dayStart = new Date(`${utcDay(now)}T00:00:00Z`);

  const balRows = await db.select({
      kind: accounts.kind,
      bal: sql<string>`COALESCE(SUM(${accounts.balance}), 0)`,
    })
    .from(accounts)
    .groupBy(accounts.kind);
  const bal: Record<string, bigint> = {};
  for (const r of balRows) bal[r.kind] = BigInt(r.bal);

  // KEEP: emission_pool debits are bounded gameplay emissions; positive entries
  // are either player sinks/conversion recycling or expired allocations returning
  // unused.
  const keepPoolFlows = await db.select({
      type: ledgerTransactions.type,
      sum: sql<string>`COALESCE(SUM(${ledgerEntries.delta}), 0)`,
    })
    .from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.txnId))
    .where(eq(accounts.kind, 'emission_pool'))
    .groupBy(ledgerTransactions.type);
  let emittedTotal = 0n;
  let recycledTotal = 0n;
  let expiredReturnedTotal = 0n;
  for (const f of keepPoolFlows) {
    const amount = BigInt(f.sum);
    if (f.type === 'genesis.play_pool') continue;
    if (amount < 0n) emittedTotal += -amount;
    else if (f.type === 'forge.expire') expiredReturnedTotal += amount;
    else recycledTotal += amount;
  }

  const [emittedTodayRow] = await db.select({
      sum: sql<string>`COALESCE(SUM(${ledgerEntries.delta}), 0)`,
    })
    .from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.txnId))
    .where(and(
      eq(accounts.kind, 'emission_pool'),
      gte(ledgerTransactions.createdAt, dayStart),
      sql`${ledgerEntries.delta} < 0`,
    ));
  const emittedToday = -BigInt(emittedTodayRow?.sum ?? '0');

  // SHARDS: all issuance below is the negative leg on shard_genesis. Exact
  // transaction types keep mine/cache/starter/conversion reporting auditable.
  const shardFlows = await db.select({
      type: ledgerTransactions.type,
      sum: sql<string>`COALESCE(SUM(${ledgerEntries.delta}), 0)`,
    })
    .from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.txnId))
    .where(eq(accounts.kind, 'shard_genesis'))
    .groupBy(ledgerTransactions.type);
  let shardsIssuedTotal = 0n;
  let minedTotal = 0n;
  let cacheTotal = 0n;
  let starterTotal = 0n;
  let convertedTotal = 0n;
  for (const f of shardFlows) {
    const issued = -BigInt(f.sum);
    shardsIssuedTotal += issued;
    if (f.type === 'mine.collect') minedTotal += issued;
    else if (f.type === 'cache.claim') cacheTotal += issued;
    else if (f.type === 'base.starter_grant' || f.type === 'base.starter_topup') starterTotal += issued;
    else if (f.type === 'forge.convert') convertedTotal += issued;
  }
  const otherIssuedTotal = shardsIssuedTotal - minedTotal - cacheTotal - starterTotal - convertedTotal;

  const [minedTodayRow] = await db.select({
      sum: sql<string>`COALESCE(SUM(${ledgerEntries.delta}), 0)`,
    })
    .from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.txnId))
    .where(and(
      eq(accounts.kind, 'shard_genesis'),
      eq(ledgerTransactions.type, 'mine.collect'),
      gte(ledgerTransactions.createdAt, dayStart),
    ));
  const minedToday = -BigInt(minedTodayRow?.sum ?? '0');

  // Withdrawals settled/in-flight (the withdrawals table is the clean source).
  const sentish = sql`${withdrawals.status} IN ('unbonding', 'processing', 'sent')`;
  const [wdTotal] = await db.select({ sum: sql<string>`COALESCE(SUM(${withdrawals.amount}), 0)` })
    .from(withdrawals).where(sentish);
  const [wdToday] = await db.select({ sum: sql<string>`COALESCE(SUM(${withdrawals.amount}), 0)` })
    .from(withdrawals).where(and(sentish, gte(withdrawals.createdAt, dayStart)));

  const emissionPool = bal['emission_pool'] ?? 0n;
  const playPool = BigInt(TOKEN.allocation.playPool);
  const pool = {
    emissionPool: emissionPool.toString(),
    playPoolInitial: playPool.toString(),
    poolPct: playPool > 0n ? Number((emissionPool * 10_000n) / playPool) / 100 : 0,
    circulating: (bal['player_keep'] ?? 0n).toString(),
    withdrawalEscrow: (bal['withdrawal_escrow'] ?? 0n).toString(),
    forgePayoutEscrow: (bal['forge_payout_escrow'] ?? 0n).toString(),
    leagueEntitlementEscrow: (bal['league_entitlement_escrow'] ?? 0n).toString(),
    mailRewardEscrow: (bal['mail_keep_escrow'] ?? 0n).toString(),
  };
  const keepFlows = {
    emittedTotal: emittedTotal.toString(),
    emittedToday: emittedToday.toString(),
    recycledTotal: recycledTotal.toString(),
    expiredReturnedTotal: expiredReturnedTotal.toString(),
  };
  const shardFlowStats = {
    issuedTotal: shardsIssuedTotal.toString(),
    minedTotal: minedTotal.toString(),
    minedToday: minedToday.toString(),
    cacheClaimedTotal: cacheTotal.toString(),
    starterGrantedTotal: starterTotal.toString(),
    convertedTotal: convertedTotal.toString(),
    otherIssuedTotal: otherIssuedTotal.toString(),
  };

  return {
    // Existing pool/onchain fields remain KEEP-denominated and compatible.
    pool,
    keepFlows,
    // D-152: Gems are NOT a KEEP liability (closed, non-withdrawable). minted =
    // −gems_mint (every Gem ever created), sunk = gems_sink (spent or converted
    // to SHARDS), outstanding = Σ player_gems. rewardBudget is KEEP backing grants.
    ...(gemsEnabled() ? { gems: {
      minted: (-(bal['gems_mint'] ?? 0n)).toString(),
      sunk: (bal['gems_sink'] ?? 0n).toString(),
      outstanding: ((bal['player_gems'] ?? 0n) + (bal['player_gems_store'] ?? 0n)).toString(),
      rewardBudgetKeep: (bal['gems_reward_budget'] ?? 0n).toString(),
      liability: false,
    } } : {}),
    shards: {
      circulating: ((bal['player_shards'] ?? 0n) + (bal['base_shards'] ?? 0n)).toString(),
      forgeEscrow: ((bal['forge_escrow'] ?? 0n) + (bal['base_forge_escrow'] ?? 0n)).toString(),
      walletCompatibility: (bal['player_shards'] ?? 0n).toString(),
      deedBalances: (bal['base_shards'] ?? 0n).toString(),
      legacyForgeEscrow: (bal['forge_escrow'] ?? 0n).toString(),
      deedForgeEscrow: (bal['base_forge_escrow'] ?? 0n).toString(),
      mailRewardEscrow: (bal['mail_shards_escrow'] ?? 0n).toString(),
      clanChest: (bal['clan_chest'] ?? 0n).toString(),
      burned: (bal['shard_burn'] ?? 0n).toString(),
      flows: shardFlowStats,
    },
    // Compatibility aliases now point at the correct currency sources. The
    // currencies map prevents consumers from treating this mixed legacy group
    // as one denomination; new clients should use keepFlows + shards.flows.
    flows: {
      minedTotal: shardFlowStats.minedTotal,
      minedToday: shardFlowStats.minedToday,
      recycledTotal: keepFlows.recycledTotal,
      cacheClaimedTotal: shardFlowStats.cacheClaimedTotal,
      starterGrantedTotal: shardFlowStats.starterGrantedTotal,
      currencies: {
        minedTotal: 'SHARDS', minedToday: 'SHARDS', recycledTotal: 'KEEP',
        cacheClaimedTotal: 'SHARDS', starterGrantedTotal: 'SHARDS',
      },
    },
    onchain: {
      withdrawnNet: (bal['onchain_outflow'] ?? 0n).toString(),
      withdrawnTotal: BigInt(wdTotal?.sum ?? '0').toString(),
      withdrawnToday: BigInt(wdToday?.sum ?? '0').toString(),
      feesBurned: (bal['burn'] ?? 0n).toString(),
      deposited: (-(bal['onchain_inflow'] ?? 0n)).toString(),
    },
    health: {
      netEmissionDrain: (emittedTotal - recycledTotal - expiredReturnedTotal).toString(),
    },
  };
}
