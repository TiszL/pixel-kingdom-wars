/**
 * Operator tool (owner 2026-08-22: "yes retire them they should not take space
 * on globe"): retire the SCRIPTED deed buyers of the 2026-07-18 burst (K-048) —
 * thirteen unnamed one-session wallets that bought land the day they were
 * created and never returned, plus the K-039 pair (deed minted, zero sessions,
 * no plot) created the same day.
 *
 * Selection (re-checked under row locks on apply): created on 2026-07-18 UTC ·
 * no display name · at most one session · never seen again (last_seen_at null)
 * · owns a `bases` row (active OR already inactive — an inactive base can still
 * hold its parcel) · no feedback, referrals, Seeker link, items · no in-flight
 * withdrawal (terminal withdrawal history is fine) · no in-flight raid against
 * any of their bases · no OUTSTANDING custody (forge positions, league
 * entitlements with unpaid KEEP, hero reservations, open listings). Land/deeds
 * are ALLOWED — that is the point.
 *
 * What "retire" means (the deed NFT stays in their wallet; a Metaplex Core
 * asset cannot be burned server-side):
 *   1. balances back to the pools (player KEEP → emission pool, deed-economy
 *      base shards/forge escrow → burn) as normal double-entry transactions —
 *      the legacy wallet `player_shards` account is 0077-fenced and left alone,
 *   2. the base is emptied the way `abandonFreeBase` does it (jobs + buildings
 *      deleted, terrain tombstoned, audit row) — that function refuses
 *      landowners by design, so the steps are applied here; the legacy
 *      `mine_state` clock is 0077-fenced and NOT re-anchored (the live mine
 *      accrual is base-scoped and goes with the base),
 *   3. every live state row is removed, `bases` → inactive, `base_slots` gone,
 *      so the globe aggregates, matchmaking, map search and the board no longer
 *      see them (the globe lists only ACTIVE bases' parcels),
 *   4. **the parcel row is KEPT**: `plots.earth_cell` + `country_a3` are the
 *      frozen Earth address the minted deed names on-chain, and the UNIQUE cell
 *      is the "no two deeds on one place" guarantee — releasing the cell would
 *      let a second deed be minted for a place an existing deed already names.
 *      The cell stays deeded to the retired wallet (11 of 58,920), invisible on
 *      the globe; re-deeding it is a separate owner decision,
 *   5. `players` row kept as a tombstone (name cleared, Keep 1); `entry_paid_at`
 *      and `deed_asset_id` stay true because they did pay; ledger, deposits,
 *      reservations and raid history stay. The deed's dynamic metadata keeps
 *      resolving to a retired, empty base. Their 30-day KEEP welcome mail
 *      expires back to the pool on its own.
 *
 * Default is a DRY RUN. `--apply` retires exactly the printed wallets, one
 * transaction per wallet; a failing wallet rolls back whole and the rest continue.
 */
import { pathToFileURL } from 'node:url';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { loadConfig } from '../config';
import { createDb, type Db, type DbTx } from './client';
import { baseAbandons, bases, baseSlots, builderJobs, buildings, obstacles, players } from './schema';
import { bootstrapSystemAccounts } from '../ledger/accounts';
import { postTransaction } from '../ledger/ledger';
import { BASE_STATE_TABLES, WALLET_STATE_TABLES } from './purgeSyntheticAccounts';
import { assertLegacyHarvesterBoundarySafe } from '../game/harvesterSettlement';

export const SCRIPTED_DEED_BURST_DAY = '2026-07-18';

export interface DeedRetireCandidate {
  wallet: string; createdAt: Date; sessions: number; bases: number; plots: number;
  deeds: number; buildings: number; keepBalance: bigint; raidsAsDefender: number;
}

function candidateSql(day: string, only?: readonly string[]) {
  return sql`
    select p.wallet, p.created_at,
      (select count(*)::int from sessions s where s.wallet = p.wallet) as sessions,
      (select count(*)::int from bases b where b.owner_wallet = p.wallet) as bases,
      (select count(*)::int from plots pl where pl.player_wallet = p.wallet or pl.base_id in (select b.id from bases b where b.owner_wallet = p.wallet)) as plots,
      (select count(*)::int from bases b where b.owner_wallet = p.wallet and b.deed_asset_id is not null) as deeds,
      (select count(*)::int from buildings bl where bl.player_wallet = p.wallet) as buildings,
      (select coalesce(sum(a.balance), 0)::text from accounts a where a.owner_wallet = p.wallet and a.kind = 'player_keep') as keep_balance,
      (select count(*)::int from raids r where r.defender_wallet = p.wallet) as raids_as_defender
    from players p
    where (p.created_at at time zone 'UTC')::date = ${day}::date
      and p.name = ''
      and p.last_seen_at is null
      ${only ? sql`and p.wallet in (${sql.join(only.map((w) => sql`${w}`), sql`, `)})` : sql``}
      and exists (select 1 from bases b where b.owner_wallet = p.wallet)
      -- something left to retire: an active base, or buildings still standing
      -- (an already-retired wallet has neither and drops out — idempotence)
      and (exists (select 1 from bases b where b.owner_wallet = p.wallet and b.status = 'active')
        or exists (select 1 from buildings bl where bl.player_wallet = p.wallet))
      and (select count(*) from sessions s where s.wallet = p.wallet) <= 1
      and not exists (select 1 from tester_feedback f where f.wallet = p.wallet)
      and not exists (select 1 from referrals r where r.referrer_wallet = p.wallet or r.referee_wallet = p.wallet)
      and not exists (select 1 from seeker_links sl where sl.wallet = p.wallet)
      and not exists (select 1 from player_items i where i.player_wallet = p.wallet)
      -- terminal withdrawal history is fine; an in-flight one is not
      and not exists (select 1 from withdrawals w where w.player_wallet = p.wallet and w.status in ('unbonding', 'processing'))
      and not exists (select 1 from raids r where (r.defender_wallet = p.wallet
          or r.defender_base_id in (select b.id from bases b where b.owner_wallet = p.wallet))
          and r.status in ('pending_orders', 'resolving'))
      and not exists (select 1 from base_raid_locks l where l.base_id in (select b.id from bases b where b.owner_wallet = p.wallet))
      and not exists (select 1 from raid_loot_reservations x where x.state = 'reserved'
          and x.defender_base_id in (select b.id from bases b where b.owner_wallet = p.wallet))
      and not exists (select 1 from raid_mine_loot_reservations ml join raid_loot_reservations x on x.raid_id = ml.raid_id
          where x.state = 'reserved' and ml.mine_building_id in (select bl.id from buildings bl where bl.player_wallet = p.wallet))
      and not exists (select 1 from base_forge_positions fp where fp.base_id in (select b.id from bases b where b.owner_wallet = p.wallet))
      -- a league entitlement only matters while KEEP is still owed on it
      and not exists (select 1 from base_league_entitlements le where le.keep_amount > 0 and le.paid_at is null
          and le.base_id in (select b.id from bases b where b.owner_wallet = p.wallet))
      and not exists (select 1 from hero_raid_reservations hr where hr.player_wallet = p.wallet
          or hr.base_id in (select b.id from bases b where b.owner_wallet = p.wallet))
      and not exists (select 1 from item_listings il where il.seller_wallet = p.wallet and il.buyer_wallet is null)
    order by p.created_at asc`;
}

type Row = { wallet: string; created_at: Date; sessions: number; bases: number; plots: number; deeds: number; buildings: number; keep_balance: string; raids_as_defender: number };

export async function selectScriptedDeedBases(
  db: Db | DbTx, opts: { day?: string; only?: readonly string[] } = {},
): Promise<DeedRetireCandidate[]> {
  const rows = await db.execute<Row>(candidateSql(opts.day ?? SCRIPTED_DEED_BURST_DAY, opts.only));
  return (rows as unknown as Row[]).map((r) => ({
    wallet: r.wallet, createdAt: new Date(r.created_at), sessions: r.sessions, bases: r.bases, plots: r.plots,
    deeds: r.deeds, buildings: r.buildings, keepBalance: BigInt(r.keep_balance), raidsAsDefender: r.raids_as_defender,
  }));
}

export interface DeedRetireResult {
  wallet: string; keepReturned: bigint; shardsReturned: bigint; buildingsDeleted: number;
  parcelsKept: number; basesDeactivated: number; rowsDeleted: Record<string, number>;
}

const rowCount = (r: unknown): number => Number((r as { count?: number }).count ?? (r as { rowCount?: number }).rowCount ?? 0);

export async function retireScriptedDeedBase(db: Db, wallet: string, now = new Date()): Promise<DeedRetireResult | null> {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(players).where(eq(players.wallet, wallet)).for('update');
    if (!p) return null;
    await assertLegacyHarvesterBoundarySafe(tx, [wallet]);
    await tx.execute(sql`select 1 from bases where owner_wallet = ${wallet} order by id for update`);
    const [still] = await selectScriptedDeedBases(tx, { only: [wallet] });
    if (!still) return null;
    const baseIds = (await tx.select({ id: bases.id }).from(bases).where(eq(bases.ownerWallet, wallet))).map((b) => b.id);
    const ids = sql.join(baseIds.map((id) => sql`${id}::uuid`), sql`, `);

    // 1. Balances back to the pools (same posting shape as purgeSyntheticAccounts).
    //    The legacy wallet `player_shards` account is 0077-fenced: not touched.
    const sys = await bootstrapSystemAccounts(tx);
    const accounts = await tx.execute<{ id: string; kind: string; balance: string }>(sql`
      select a.id, a.kind, a.balance::text as balance from accounts a
      where (a.owner_wallet = ${wallet} and a.kind = 'player_keep')
         or (a.base_id in (select b.id from bases b where b.owner_wallet = ${wallet}) and a.kind in ('base_shards', 'base_forge_escrow'))
      for update`);
    let keepReturned = 0n; let shardsReturned = 0n;
    for (const a of accounts as unknown as Array<{ id: string; kind: string; balance: string }>) {
      const bal = BigInt(a.balance);
      if (bal <= 0n) continue;
      const isKeep = a.kind === 'player_keep';
      const posted = await postTransaction(tx, {
        idempotencyKey: `retire.scripted-deed:${a.id}`,
        type: 'retire.scripted-deed',
        entries: [{ account: a.id, delta: -bal }, { account: isKeep ? sys.emission_pool : sys.shard_burn, delta: bal }],
        metadata: { wallet, kind: a.kind, reason: 'K-048 scripted deed buyers 2026-07-18 (owner 2026-08-22)' },
      });
      if (posted.duplicate) throw new Error(`retire.scripted-deed:${a.id} already posted but ${bal} remains — refusing`);
      if (isKeep) keepReturned += bal; else shardsReturned += bal;
    }

    // 2. Empty the base the way abandonFreeBase does (it refuses landowners on
    //    purpose, so the same steps are applied here): settled raids' per-Mine
    //    loot detail first (it references the Mine row), then jobs, buildings,
    //    terrain tombstone. No legacy mine_state re-anchor (0077-fenced).
    const mineLoot = await tx.execute(sql`delete from raid_mine_loot_reservations ml
      using raid_loot_reservations x
      where x.raid_id = ml.raid_id and x.state <> 'reserved'
        and ml.mine_building_id in (select bl.id from buildings bl where bl.player_wallet = ${wallet})`);
    const jobs = await tx.delete(builderJobs).where(eq(builderJobs.playerWallet, wallet)).returning({ id: builderJobs.id });
    const bl = await tx.delete(buildings).where(eq(buildings.playerWallet, wallet)).returning({ id: buildings.id });
    const ob = await tx.update(obstacles).set({ clearedAt: now })
      .where(and(eq(obstacles.playerWallet, wallet), isNull(obstacles.clearedAt))).returning({ id: obstacles.id });

    // 3. The parcel row is KEPT (frozen Earth address of a minted deed — see
    //    the header); count it for the log.
    const parcelsKept = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from plots pl
      where pl.player_wallet = ${wallet} ${baseIds.length > 0 ? sql`or pl.base_id in (${ids})` : sql``}`) as unknown as Array<{ n: number }>)[0]?.n ?? 0;

    // 4. Live state rows, base_slots, bases → inactive.
    const rowsDeleted: Record<string, number> = {};
    if (rowCount(mineLoot) > 0) rowsDeleted['raid_mine_loot_reservations'] = rowCount(mineLoot);
    for (const [table, column] of WALLET_STATE_TABLES) {
      const n = rowCount(await tx.execute(sql`delete from ${sql.identifier(table)} where ${sql.identifier(column)} = ${wallet}`));
      if (n > 0) rowsDeleted[table] = (rowsDeleted[table] ?? 0) + n;
    }
    if (baseIds.length > 0) {
      for (const [table, column] of BASE_STATE_TABLES) {
        const n = rowCount(await tx.execute(sql`delete from ${sql.identifier(table)} where ${sql.identifier(column)} in (${ids})`));
        if (n > 0) rowsDeleted[table] = (rowsDeleted[table] ?? 0) + n;
      }
    }
    await tx.delete(baseSlots).where(eq(baseSlots.wallet, wallet));
    const deactivated = await tx.update(bases).set({ status: 'inactive', updatedAt: now })
      .where(and(eq(bases.ownerWallet, wallet), eq(bases.status, 'active'))).returning({ id: bases.id });

    // 5. Tombstone + audit (same shape abandonFreeBase writes).
    await tx.update(players).set({ name: '', nameKey: '', avatarHash: null, trophies: 0, keepLevel: 1, expansions: 0 })
      .where(eq(players.wallet, wallet));
    await tx.insert(baseAbandons).values({
      playerWallet: wallet, priorKeepLevel: p.keepLevel, priorExpansions: p.expansions,
      buildingsDeleted: bl.length, obstaclesTombstoned: ob.length, jobsDeleted: jobs.length,
    });

    return {
      wallet, keepReturned, shardsReturned, buildingsDeleted: bl.length, parcelsKept,
      basesDeactivated: deactivated.length, rowsDeleted,
    };
  });
}

function isMain(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const config = loadConfig();
  const { db, sql: pg } = createDb(config.DATABASE_URL);
  try {
    const candidates = await selectScriptedDeedBases(db);
    console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${candidates.length} scripted deed wallet(s) from the ${SCRIPTED_DEED_BURST_DAY} burst`);
    for (const c of candidates) {
      console.log(`  ${c.wallet}  created=${c.createdAt.toISOString()}  sessions=${c.sessions} bases=${c.bases} deeds=${c.deeds} plots=${c.plots} buildings=${c.buildings} keep=${c.keepBalance} raidsAsDefender=${c.raidsAsDefender}`);
    }
    if (!apply) { if (candidates.length > 0) console.log('re-run with --apply to retire exactly these wallets'); return; }
    let done = 0; let parcels = 0; let keep = 0n; const failed: string[] = [];
    for (const c of candidates) {
      try {
        const r = await retireScriptedDeedBase(db, c.wallet);
        if (!r) { console.log(`  skipped ${c.wallet} — no longer qualifies`); continue; }
        done += 1; parcels += r.parcelsKept; keep += r.keepReturned;
        console.log(`  retired ${c.wallet}: parcels kept (deeded, globe-invisible)=${r.parcelsKept} buildings=${r.buildingsDeleted} bases→inactive=${r.basesDeactivated} keep→pool=${r.keepReturned} rows=${JSON.stringify(r.rowsDeleted)}`);
      } catch (e) {
        failed.push(c.wallet);
        console.error(`  FAILED ${c.wallet} (nothing changed for it): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    console.log(`retired ${done} wallet(s); ${parcels} deeded parcel(s) kept but globe-invisible; ${keep} KEEP returned; ${failed.length} failed${failed.length ? ': ' + failed.join(', ') : ''}`);
    if (failed.length > 0) process.exitCode = 2;
  } finally {
    await pg.end();
  }
}

if (isMain()) main().catch((e) => { console.error(e); process.exit(1); });
