/**
 * Operator tool (owner 2026-08-22: "delete 34 sign in once auto bases from
 * 12/13 burst"): retire the SYNTHETIC accounts created by the scripted
 * 2026-06-12/13 sign-in bursts (K-048).
 *
 * What a target is (every condition re-checked under a row lock on apply):
 *   created on 2026-06-12 or 06-13 · signed in ONCE (at most one session row,
 *   sessions are durable) · never seen again (last_seen_at null) · an active
 *   base but NO land ever (no entry_paid_at, no plot, no deed) · no deposits,
 *   withdrawals, items, referrals, mail, feedback, Seeker link. Points are not
 *   a criterion: 16 of the burst wallets scripted a few actions in their one
 *   session (25–95 points) — still "sign in once, auto-base", per the owner.
 *
 * What "delete" means here (the ledger is append-only and other players'
 * raid history points at these bases, so a hard row delete is neither possible
 * nor honest):
 *   1. the base is abandoned through the supported path (`abandonFreeBase`:
 *      buildings + jobs deleted, terrain tombstoned, audit row written),
 *   2. every remaining balance (legacy dev-grant KEEP, shards) is posted back
 *      to the system pools in a normal double-entry transaction,
 *   3. all game STATE rows are deleted (army, queues, research, unlocks, heroes,
 *      quests, campaign, activity, streaks, mine clock, tutorial, sessions,
 *      OTPs, nonces, tester rows, slots, layouts, shields, base_* state),
 *   4. the `bases` rows become `inactive`, so no "active base" lookup
 *      (matchmaking, map, board) ever returns them again,
 *   5. the `players` row and the ledger/raid HISTORY stay as a tombstone.
 *
 * Default is a DRY RUN. `--apply` retires exactly the printed wallets in one
 * transaction per wallet; any unexpected FK aborts that wallet (nothing partial).
 */
import { pathToFileURL } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { loadConfig } from '../config';
import { createDb, type Db, type DbTx } from './client';
import { bases, baseSlots, players } from './schema';
import { abandonFreeBase } from '../game/baseTransfer';
import { assertLegacyHarvesterBoundarySafe } from '../game/harvesterSettlement';
import { bootstrapSystemAccounts } from '../ledger/accounts';
import { postTransaction } from '../ledger/ledger';

export const SYNTHETIC_BURST_DAYS = ['2026-06-12', '2026-06-13'] as const;

export interface SyntheticCandidate {
  wallet: string;
  createdAt: Date;
  bases: number;
  buildings: number;
  keepBalance: bigint;
  shardsBalance: bigint;
  raidsAsDefender: number;
}

/** The selection predicate, shared by dry run and apply (apply adds row locks). */
function candidateSql(days: readonly string[], only?: readonly string[]) {
  const dayList = sql.join(days.map((d) => sql`${d}::date`), sql`, `);
  return sql`
    select p.wallet, p.created_at,
      (select count(*)::int from bases b where b.owner_wallet = p.wallet) as bases,
      (select count(*)::int from buildings bl where bl.player_wallet = p.wallet) as buildings,
      (select coalesce(sum(a.balance), 0)::text from accounts a where a.owner_wallet = p.wallet and a.kind = 'player_keep') as keep_balance,
      (select coalesce(sum(a.balance), 0)::text from accounts a where (a.owner_wallet = p.wallet and a.kind = 'player_shards')
          or (a.base_id in (select b.id from bases b where b.owner_wallet = p.wallet) and a.kind in ('base_shards', 'base_forge_escrow'))) as shards_balance,
      (select count(*)::int from raids r where r.defender_wallet = p.wallet) as raids_as_defender
    from players p
    where (p.created_at at time zone 'UTC')::date in (${dayList})
      and p.last_seen_at is null
      and p.entry_paid_at is null
      and p.deed_asset_id is null
      ${only ? sql`and p.wallet in (${sql.join(only.map((w) => sql`${w}`), sql`, `)})` : sql``}
      and exists (select 1 from bases b where b.owner_wallet = p.wallet and b.status = 'active')
      and not exists (select 1 from bases b where b.owner_wallet = p.wallet and (b.land_paid_at is not null or b.deed_asset_id is not null))
      and not exists (select 1 from plots pl where pl.player_wallet = p.wallet or pl.base_id in (select b.id from bases b where b.owner_wallet = p.wallet))
      and not exists (select 1 from deposits d where d.player_wallet = p.wallet)
      and not exists (select 1 from withdrawals w where w.player_wallet = p.wallet)
      and not exists (select 1 from player_items i where i.player_wallet = p.wallet)
      and not exists (select 1 from referrals r where r.referrer_wallet = p.wallet or r.referee_wallet = p.wallet)
      and not exists (select 1 from mail_messages m where m.recipient_wallet = p.wallet)
      and not exists (select 1 from tester_feedback f where f.wallet = p.wallet)
      and not exists (select 1 from seeker_links sl where sl.wallet = p.wallet)
      and (select count(*) from sessions s where s.wallet = p.wallet) <= 1
      -- never while a raid is in flight against it (synthetic bases ARE valid
      -- auto-match targets): open raids, live locks, reserved loot, mine loot of
      -- a reserved raid; and never with custody rows (forge positions, league
      -- entitlements, hero reservations) that escrow somebody's KEEP.
      and not exists (select 1 from raids r where (r.defender_wallet = p.wallet
          or r.defender_base_id in (select b.id from bases b where b.owner_wallet = p.wallet))
          and r.status in ('pending_orders', 'resolving'))
      and not exists (select 1 from base_raid_locks l where l.base_id in (select b.id from bases b where b.owner_wallet = p.wallet))
      and not exists (select 1 from raid_loot_reservations x where x.state = 'reserved'
          and x.defender_base_id in (select b.id from bases b where b.owner_wallet = p.wallet))
      and not exists (select 1 from raid_mine_loot_reservations ml join raid_loot_reservations x on x.raid_id = ml.raid_id
          where x.state = 'reserved' and ml.mine_building_id in (select bl.id from buildings bl where bl.player_wallet = p.wallet))
      and not exists (select 1 from base_forge_positions fp where fp.base_id in (select b.id from bases b where b.owner_wallet = p.wallet))
      and not exists (select 1 from base_league_entitlements le where le.base_id in (select b.id from bases b where b.owner_wallet = p.wallet))
      and not exists (select 1 from hero_raid_reservations hr where hr.player_wallet = p.wallet
          or hr.base_id in (select b.id from bases b where b.owner_wallet = p.wallet))
    order by p.created_at asc`;
}

type Row = { wallet: string; created_at: Date; bases: number; buildings: number; keep_balance: string; shards_balance: string; raids_as_defender: number };

export async function selectSyntheticAccounts(
  db: Db | DbTx, opts: { days?: readonly string[]; only?: readonly string[] } = {},
): Promise<SyntheticCandidate[]> {
  const rows = await db.execute<Row>(candidateSql(opts.days ?? SYNTHETIC_BURST_DAYS, opts.only));
  return (rows as unknown as Row[]).map((r) => ({
    wallet: r.wallet, createdAt: new Date(r.created_at), bases: r.bases, buildings: r.buildings,
    keepBalance: BigInt(r.keep_balance), shardsBalance: BigInt(r.shards_balance), raidsAsDefender: r.raids_as_defender,
  }));
}

/** Game-STATE tables cleared per wallet / per base. History tables (raids,
 * base_battle_records, ledger_*, forge_contributions, base_abandons, deposits)
 * are deliberately NOT here — and neither are the LEGACY wallet-scoped
 * gameplay tables frozen by the deed-cutover fence (migration 0077:
 * army, training_queue, troop_research, hero_levels, hero_loadouts,
 * hero_equipment, quest_progress, streaks, mine_state, daily_activity,
 * campaign_progress, player_items, hero_raid_reservations): the fence raises
 * on any write, the rows are inert pre-cutover history, and the live state
 * lives in the base_* tables cleared below. (The first production run
 * learned this: 33 of 49 wallets rolled back on `delete from army`.) */
export const WALLET_STATE_TABLES: ReadonlyArray<[table: string, column: string]> = [
  ['troop_unlocks', 'player_wallet'], ['tutorial_progress', 'player_wallet'],
  ['shields', 'player_wallet'], ['layouts', 'player_wallet'], ['item_uses', 'player_wallet'],
  ['clan_members', 'player_wallet'], ['email_otps', 'player_wallet'], ['sessions', 'wallet'],
  ['auth_nonces', 'wallet'], ['tester_milestones', 'wallet'], ['tester_daily_points', 'wallet'],
  ['tester_board_hidden', 'wallet'], ['base_slots', 'wallet'],
];
export const BASE_STATE_TABLES: ReadonlyArray<[table: string, column: string]> = [
  ['base_army', 'base_id'], ['base_training_queue', 'base_id'], ['base_troop_research', 'base_id'],
  ['base_hero_loadouts', 'base_id'], ['base_hero_progress', 'base_id'], ['base_items', 'base_id'],
  ['base_profiles', 'base_id'], ['base_quest_progress', 'base_id'], ['base_campaign_progress', 'base_id'],
  ['base_daily_activity', 'base_id'], ['base_streaks', 'base_id'], ['base_raid_locks', 'base_id'],
  ['forge_base_daily_usage', 'base_id'], ['builder_jobs', 'base_id'], ['shields', 'base_id'], ['layouts', 'base_id'],
  // NOT here on purpose: base_forge_positions / base_league_entitlements /
  // hero_raid_reservations are custody rows — the selection refuses wallets
  // that have any, instead of deleting them.
];

export interface PurgeResult {
  wallet: string;
  keepReturned: bigint;
  shardsReturned: bigint;
  buildingsDeleted: number;
  basesDeactivated: number;
  rowsDeleted: Record<string, number>;
}

/** Retire ONE wallet. Every precondition is re-checked inside the transaction
 * under a row lock; a wallet that stopped qualifying is skipped (returns null). */
export async function purgeSyntheticAccount(db: Db, wallet: string, now = new Date()): Promise<PurgeResult | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from players where wallet = ${wallet} for update`);
    await assertLegacyHarvesterBoundarySafe(tx, [wallet]);
    // Same row lock createRaid takes on a target base, so a raid cannot start
    // against this base while it is being retired (and vice versa).
    await tx.execute(sql`select 1 from bases where owner_wallet = ${wallet} order by id for update`);
    const [still] = await selectSyntheticAccounts(tx, { only: [wallet] });
    if (!still) return null;

    // 0. Settled/released raids keep a per-Mine loot breakdown that references
    //    the Mine building row; for a synthetic base that detail is dropped so
    //    the supported abandon path can delete the building (the raid and its
    //    loot reservation rows — the history — stay).
    const mineLoot = await tx.execute(sql`delete from raid_mine_loot_reservations ml
      using raid_loot_reservations x
      where x.raid_id = ml.raid_id and x.state <> 'reserved'
        and ml.mine_building_id in (select bl.id from buildings bl where bl.player_wallet = ${wallet})`);
    const mineLootDeleted = Number((mineLoot as unknown as { count?: number }).count ?? (mineLoot as unknown as { rowCount?: number }).rowCount ?? 0);

    // 1. The supported destructive path for a free base (buildings, jobs,
    //    terrain tombstone, audit row, mine clock re-anchored).
    const abandoned = await abandonFreeBase(tx as unknown as Db, wallet, now);

    // 2. Balances back to the pools — a normal double-entry posting, never a
    //    deleted entry. KEEP → emission_pool (the cohort's KEEP was `dev.fund`
    //    from the since-retired quest bucket, which the 0087 trigger no longer
    //    lets us credit; the emission pool is where that allocation was unified
    //    into); shards → shard_burn.
    const sys = await bootstrapSystemAccounts(tx);
    const accounts = await tx.execute<{ id: string; kind: string; balance: string }>(sql`
      select a.id, a.kind, a.balance::text as balance from accounts a
      where (a.owner_wallet = ${wallet} and a.kind in ('player_keep', 'player_shards'))
         or (a.base_id in (select b.id from bases b where b.owner_wallet = ${wallet}) and a.kind in ('base_shards', 'base_forge_escrow'))
      for update`);
    let keepReturned = 0n; let shardsReturned = 0n;
    for (const a of accounts as unknown as Array<{ id: string; kind: string; balance: string }>) {
      const bal = BigInt(a.balance);
      if (bal <= 0n) continue;
      const isKeep = a.kind === 'player_keep';
      const posted = await postTransaction(tx, {
        idempotencyKey: `purge.synthetic:${a.id}`,
        type: 'purge.synthetic',
        entries: [{ account: a.id, delta: -bal }, { account: isKeep ? sys.emission_pool : sys.shard_burn, delta: bal }],
        metadata: { wallet, kind: a.kind, reason: 'K-048 synthetic sign-in burst 2026-06-12/13 (owner 2026-08-22)' },
      });
      if (posted.duplicate) throw new Error(`purge.synthetic:${a.id} was already posted but the account still holds ${bal} — refusing to continue`);
      if (isKeep) keepReturned += bal; else shardsReturned += bal;
    }

    // 3. Game state rows.
    const baseIds = (await tx.select({ id: bases.id }).from(bases).where(eq(bases.ownerWallet, wallet))).map((b) => b.id);
    const rowsDeleted: Record<string, number> = {};
    for (const [table, column] of WALLET_STATE_TABLES) {
      const r = await tx.execute(sql`delete from ${sql.identifier(table)} where ${sql.identifier(column)} = ${wallet}`);
      const n = Number((r as unknown as { count?: number }).count ?? (r as unknown as { rowCount?: number }).rowCount ?? 0);
      if (n > 0) rowsDeleted[table] = (rowsDeleted[table] ?? 0) + n;
    }
    if (baseIds.length > 0) {
      const ids = sql.join(baseIds.map((id) => sql`${id}::uuid`), sql`, `);
      for (const [table, column] of BASE_STATE_TABLES) {
        const r = await tx.execute(sql`delete from ${sql.identifier(table)} where ${sql.identifier(column)} in (${ids})`);
        const n = Number((r as unknown as { count?: number }).count ?? (r as unknown as { rowCount?: number }).rowCount ?? 0);
        if (n > 0) rowsDeleted[table] = (rowsDeleted[table] ?? 0) + n;
      }
      await tx.delete(baseSlots).where(eq(baseSlots.wallet, wallet));
    }

    // 4. The base rows stay (raid history points at them) but are no longer
    //    "active" anywhere: matchmaking, map, board, slot resolution.
    const deactivated = await tx.update(bases).set({ status: 'inactive', updatedAt: now })
      .where(and(eq(bases.ownerWallet, wallet), eq(bases.status, 'active'))).returning({ id: bases.id });
    // 5. Tombstone the player row (name/avatar cleared; identity kept for history).
    await tx.update(players).set({ name: '', nameKey: '', avatarHash: null, trophies: 0 }).where(eq(players.wallet, wallet));

    if (mineLootDeleted > 0) rowsDeleted['raid_mine_loot_reservations'] = mineLootDeleted;
    return { wallet, keepReturned, shardsReturned, buildingsDeleted: abandoned.buildings, basesDeactivated: deactivated.length, rowsDeleted };
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
    const candidates = await selectSyntheticAccounts(db);
    console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${candidates.length} synthetic account(s) from the ${SYNTHETIC_BURST_DAYS.join('/')} bursts`);
    for (const c of candidates) {
      console.log(`  ${c.wallet}  created=${c.createdAt.toISOString()}  bases=${c.bases} buildings=${c.buildings} keep=${c.keepBalance} shards=${c.shardsBalance} raidsAsDefender=${c.raidsAsDefender}`);
    }
    if (!apply) { if (candidates.length > 0) console.log('re-run with --apply to retire exactly these wallets'); return; }
    let done = 0; let keep = 0n; const failed: string[] = [];
    for (const c of candidates) {
      try {
        const r = await purgeSyntheticAccount(db, c.wallet);
        if (!r) { console.log(`  skipped ${c.wallet} — no longer qualifies`); continue; }
        done += 1; keep += r.keepReturned;
        console.log(`  retired ${c.wallet}: buildings=${r.buildingsDeleted} bases→inactive=${r.basesDeactivated} keep→pool=${r.keepReturned} shards→burn=${r.shardsReturned} rows=${JSON.stringify(r.rowsDeleted)}`);
      } catch (e) {
        // One wallet's surprise must not stop the others; its transaction rolled back whole.
        failed.push(c.wallet);
        console.error(`  FAILED ${c.wallet} (nothing changed for it): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    console.log(`retired ${done} wallet(s); ${keep} KEEP returned to the emission pool; ${failed.length} failed${failed.length ? ': ' + failed.join(', ') : ''}`);
    if (failed.length > 0) process.exitCode = 2;
  } finally {
    await pg.end();
  }
}

if (isMain()) main().catch((e) => { console.error(e); process.exit(1); });
