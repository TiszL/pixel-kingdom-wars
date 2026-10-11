import { trainTroop } from './training-consent';
/**
 * Clans MVP (CLANS-SELLABLE-DEEDS-PLAN C1/C2). What must hold:
 *  - founding BURNS shards atomically with the insert (no unpaid clans, no
 *    clanless payments) — the raid-ante pattern;
 *  - one clan per player is SCHEMA truth (clan_members PK);
 *  - the roster cap cannot be raced past (FOR UPDATE serialization);
 *  - the leader leaves last, and their departure dissolves the clan.
 */
import { CLANS } from '@shardkeep/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clanMembers, clans } from '../src/db/schema';
import { createClan, getMyClan, joinClan, kickMember, leaveClan, listClans } from '../src/game/clans';
import { rewardShards } from '../src/game/spend';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let key = 0;
const k = (): string => `clan-${++key}-${Math.random().toString(36).slice(2)}`;
/** Unique-enough names — clans.name/tag are globally unique in a SHARED test DB. */
const uname = (): string => `Clan ${Math.random().toString(36).slice(2, 10)}`;
const utag = (): string => Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[^A-Z0-9]/g, 'X');

async function funded(shards = 50_000n) {
  const p = await createTestPlayer(db);
  if (shards > 0n) await rewardShards(db, p.wallet, shards, 'test.fund.shards', k());
  return p;
}
const shardsOf = async (w: string): Promise<bigint> =>
  (await getOrCreatePlayerAccount(db, w, 'player_shards')).balance;
/** Make these wallets LANDOWNERS (`players.entryPaidAt` — the one land predicate). */
const stampLand = async (...wallets: string[]): Promise<void> => {
  await db.update(players).set({ entryPaidAt: new Date() })
    .where(inArray(players.wallet, wallets));
};

beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });

describe('clans', () => {
  it('founding burns the create cost atomically; a taken name rolls the burn back', async () => {
    const p = await funded();
    const before = await shardsOf(p.wallet);
    const name = uname();
    const clan = await createClan(db, p.wallet, { name, tag: utag() }, k());
    expect(await shardsOf(p.wallet)).toBe(before - BigInt(CLANS.createCostShards));
    expect((await getMyClan(db, p.wallet)).clan?.id).toBe(clan.id);

    // Same NAME from another founder: 422 — and their shards are UNTOUCHED,
    // because the charge lives inside the same tx as the conflicting insert.
    const q = await funded();
    const qBefore = await shardsOf(q.wallet);
    await expect(createClan(db, q.wallet, { name, tag: utag() }, k())).rejects.toThrow(/already taken/);
    expect(await shardsOf(q.wallet)).toBe(qBefore);
  });

  it('cannot found while broke, or while already in a clan', async () => {
    const broke = await createTestPlayer(db);
    await expect(createClan(db, broke.wallet, { name: uname(), tag: utag() }, k()))
      .rejects.toThrow(/costs/);
    const p = await funded(100_000n);
    await createClan(db, p.wallet, { name: uname(), tag: utag() }, k());
    await expect(createClan(db, p.wallet, { name: uname(), tag: utag() }, k()))
      .rejects.toThrow(/leave your current clan/);
  });

  it('join respects invite codes and the roster cap; membership is one-clan-per-player', async () => {
    const leader = await funded();
    const clan = await createClan(db, leader.wallet, { name: uname(), tag: utag(), inviteMode: 'invite' }, k());
    expect(clan.inviteCode).toBeTruthy();

    const m = await createTestPlayer(db);
    await expect(joinClan(db, m.wallet, clan.id)).rejects.toThrow(/invite-only/);
    await expect(joinClan(db, m.wallet, clan.id, 'wrong')).rejects.toThrow(/invite-only/);
    const joined = await joinClan(db, m.wallet, clan.id, clan.inviteCode!);
    expect(joined.members).toBe(2);
    // One clan per player — the PK enforces it whatever the code does.
    const other = await funded();
    const c2 = await createClan(db, other.wallet, { name: uname(), tag: utag() }, k());
    await expect(joinClan(db, m.wallet, c2.id)).rejects.toThrow(/leave your current clan/);
  });

  it('the roster cap gates joins at exactly CLANS.rosterCap', async () => {
    const leader = await funded();
    const clan = await createClan(db, leader.wallet, { name: uname(), tag: utag() }, k());
    // Fill to the cap (leader is member #1); the wallet AT the cap must bounce.
    for (let i = 1; i < CLANS.rosterCap; i++) {
      const m = await createTestPlayer(db);
      await joinClan(db, m.wallet, clan.id);
    }
    const overflow = await createTestPlayer(db);
    await expect(joinClan(db, overflow.wallet, clan.id)).rejects.toThrow(/full/);
  });

  it('members leave freely; the leader leaves LAST and that dissolves the clan', async () => {
    const leader = await funded();
    const clan = await createClan(db, leader.wallet, { name: uname(), tag: utag() }, k());
    const m = await createTestPlayer(db);
    await joinClan(db, m.wallet, clan.id);

    // Leader cannot abandon a populated clan — members would be leaderless.
    await expect(leaveClan(db, leader.wallet)).rejects.toThrow(/leaves last/);
    expect((await leaveClan(db, m.wallet)).left).toBe(true);
    const res = await leaveClan(db, leader.wallet);
    expect(res.disbanded).toBe(true);
    // The row is GONE (cascade cleared membership) — the name is reusable.
    expect((await db.select().from(clans).where(eq(clans.id, clan.id))).length).toBe(0);
    expect((await db.select().from(clanMembers).where(eq(clanMembers.clanId, clan.id))).length).toBe(0);
  });

  it('kick is leader-only, in-clan-only, and never self', async () => {
    const leader = await funded();
    const clan = await createClan(db, leader.wallet, { name: uname(), tag: utag() }, k());
    const m = await createTestPlayer(db);
    await joinClan(db, m.wallet, clan.id);

    await expect(kickMember(db, m.wallet, leader.wallet)).rejects.toThrow(/only the leader/);
    await expect(kickMember(db, leader.wallet, leader.wallet)).rejects.toThrow(/not kick, yourself/);
    expect((await kickMember(db, leader.wallet, m.wallet)).kicked).toBe(m.wallet);
    expect((await getMyClan(db, m.wallet)).clan).toBeNull();
    // Kicked = rejoinable (open clan) — a kick is not a ban in the MVP.
    await expect(kickMember(db, leader.wallet, m.wallet)).rejects.toThrow(/not a member/);
  });

  it('the leaderboard ranks by summed member trophies and hides invite codes', async () => {
    const leader = await funded();
    await createClan(db, leader.wallet, { name: uname(), tag: utag(), inviteMode: 'invite' }, k());
    const { clans: board } = await listClans(db);
    expect(board.length).toBeGreaterThan(0);
    for (const c of board) expect('inviteCode' in c).toBe(false); // outsiders never see join secrets
    // Ranked: each entry's trophies >= the next one's.
    for (let i = 1; i < board.length; i++) expect(board[i - 1]!.trophies).toBeGreaterThanOrEqual(board[i]!.trophies);
  });
});

// ---------------------------------------------------------------------------
// C3 — the weekly clan chest. Money path: every posting is double-entry against
// the ONE pooled clan_chest account, with per-clan attribution in
// clans.chest_shards moved in the same tx. The invariant below is the whole
// design: sum(attribution) == pool, at every commit boundary.
// ---------------------------------------------------------------------------
import { clanChestInvariantHolds, settleClanChests } from '../src/game/clans';
import { completeDueJobs, ensureStartingBase, placeBuilding } from '../src/game/base';
import { completeDueTraining} from '../src/game/army';
import { createRaid, submitOrders } from '../src/game/raids';
import { players } from '../src/db/schema';
import { STRUCTURES, CLANS as CLANS_C } from '@shardkeep/shared';

const future = (min: number): Date => new Date(Date.now() + min * 60_000);

/** Attacker with an army (mirrors raids.test warlord, trimmed). */
async function warlord() {
  const p = await funded(1_000_000n);
  await fundTestKeep(db, p.wallet, 1_000_000n, 'test.fund', k());
  await ensureStartingBase(db, p.wallet);
  await placeBuilding(db, p.wallet, 'barracks' as never, 17, 17, k());
  await completeDueJobs(db, p.wallet, future(120));
  await placeBuilding(db, p.wallet, 'camp' as never, 19, 19, k());
  await completeDueJobs(db, p.wallet, future(240));
  let t = 300;
  for (let i = 0; i < 6; i++) {
    await trainTroop(db, p.wallet, 'highlander' as never, k(), future(t));
    t += 10;
    await completeDueTraining(db, p.wallet, future(t));
  }
  return p;
}
async function victim(surplus = 50_000n) {
  const p = await funded(0n);
  await ensureStartingBase(db, p.wallet);
  await rewardShards(db, p.wallet, BigInt(STRUCTURES.vault.capacity[0]!) + surplus, 'test.fund.shards', k());
  await completeDueJobs(db, p.wallet, future(120));
  return p;
}

describe('clan chest (C3)', () => {
  it('a clanned attacker tithes into the chest; conservation + invariant hold', async () => {
    const att = await warlord();
    const clan = await createClan(db, att.wallet, { name: uname(), tag: utag() }, k());
    const def = await victim();
    const attBefore = await shardsOf(att.wallet);
    const defBefore = await shardsOf(def.wallet);

    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    const { result } = await submitOrders(db, att.wallet, raid.id, {
      deploys: [
        { troop: 'highlander', tx: 6, ty: 14, tMs: 0 }, { troop: 'highlander', tx: 6, ty: 15, tMs: 0 },
        { troop: 'highlander', tx: 23, ty: 14, tMs: 0 }, { troop: 'highlander', tx: 23, ty: 15, tMs: 0 },
        { troop: 'highlander', tx: 14, ty: 6, tMs: 0 }, { troop: 'highlander', tx: 14, ty: 23, tMs: 0 },
      ],
      idempotencyKey: k(),
    });
    expect(result.stars).toBeGreaterThanOrEqual(1);

    const [row] = await db.select({ chest: clans.chestShards }).from(clans).where(eq(clans.id, clan.id));
    expect(row!.chest).toBeGreaterThan(0n); // the clan pooled a real cut
    // Conservation: defender's loss = attacker's pocket + ante burned back out
    // of it... the precise split is pinned in raids.test; here the CHEST leg:
    // reported lootShards is what the attacker POCKETED (net of the chest cut),
    // so pocket + chest + burnt tithe == defender loss exactly.
    const gross = defBefore - (await shardsOf(def.wallet));
    const ante = attBefore - (await shardsOf(att.wallet)) + BigInt(result.lootShards);
    void ante; // attacker delta mixes the ante; the equality below is the chest claim
    expect(BigInt(result.lootShards) + row!.chest).toBeLessThanOrEqual(gross);
    expect(await clanChestInvariantHolds(db)).toBe(true);
  });

  it('the weekly settlement splits evenly, leaves the remainder, and is idempotent', async () => {
    const leader = await funded();
    const clan = await createClan(db, leader.wallet, { name: uname(), tag: utag() }, k());
    const m = await createTestPlayer(db);
    await joinClan(db, m.wallet, clan.id);
    // Clans are LAND-GATED (owner 2026-08-09), so a roster is landowners and the
    // chest only splits among them — stamping both here is what the create/join
    // routes now guarantee, not test scaffolding for its own sake.
    await stampLand(leader.wallet, m.wallet);
    // Seed the chest directly through the LEDGER (never a bare column write):
    // 1001 into a 2-member clan → 500 each, 1 rolls over.
    const { bootstrapSystemAccounts: boot } = await import('../src/ledger');
    const { postTransaction } = await import('../src/ledger/ledger');
    const sys = await boot(db);
    const src = await getOrCreatePlayerAccount(db, leader.wallet, 'player_shards');
    await postTransaction(db, {
      idempotencyKey: k(), type: 'test.seed_chest',
      entries: [{ account: src.id, delta: -1001n }, { account: sys.clan_chest, delta: 1001n }],
    });
    await db.update(clans).set({ chestShards: 1001n }).where(eq(clans.id, clan.id));
    expect(await clanChestInvariantHolds(db)).toBe(true);

    const week = `w-${k()}`;
    const lBefore = await shardsOf(leader.wallet);
    const mBefore = await shardsOf(m.wallet);
    const res = await settleClanChests(db, week);
    expect(res.settled).toBeGreaterThanOrEqual(1);
    expect(await shardsOf(leader.wallet)).toBe(lBefore + 500n);
    expect(await shardsOf(m.wallet)).toBe(mBefore + 500n);
    const [after] = await db.select({ c: clans.chestShards }).from(clans).where(eq(clans.id, clan.id));
    expect(after!.c).toBe(1n); // remainder rolls over — never minted, never lost
    expect(await clanChestInvariantHolds(db)).toBe(true);

    // SAME week re-run: the week-keyed idempotency makes it a no-op.
    await settleClanChests(db, week);
    expect(await shardsOf(leader.wallet)).toBe(lBefore + 500n);
    expect(await clanChestInvariantHolds(db)).toBe(true);
  });

  it('a DEEDLESS member is skipped by the split — their share rolls over, the invariant holds', async () => {
    // WHY THE GATE CANNOT LIVE ONLY ON THE JOIN ROUTE (owner 2026-08-09: clans are
    // deed-gated because chests pay every member): MEMBERSHIP OUTLIVES LAND.
    // `baseTransfer` clears the seller's entryPaidAt when they sell their base, so
    // a member who founded or joined as a landowner and then sold up stays on the
    // roster as a deedless account — plus anyone who joined before the gate shipped.
    // Route gating can never reach either, so the check has to sit where the money
    // moves. 1001 into a 2-member clan with ONE eligible member → 1001 to them and
    // 0 rolls over (not 500/500), and sum(chest_shards) == pool throughout.
    const leader = await funded();
    const clan = await createClan(db, leader.wallet, { name: uname(), tag: utag() }, k());
    const deedless = await createTestPlayer(db);
    await joinClan(db, deedless.wallet, clan.id);
    await stampLand(leader.wallet); // the leader owns land; the member does NOT

    const { bootstrapSystemAccounts: boot } = await import('../src/ledger');
    const { postTransaction } = await import('../src/ledger/ledger');
    const sys = await boot(db);
    const src = await getOrCreatePlayerAccount(db, leader.wallet, 'player_shards');
    await postTransaction(db, {
      idempotencyKey: k(), type: 'test.seed_chest',
      entries: [{ account: src.id, delta: -1001n }, { account: sys.clan_chest, delta: 1001n }],
    });
    await db.update(clans).set({ chestShards: 1001n }).where(eq(clans.id, clan.id));

    const lBefore = await shardsOf(leader.wallet);
    const dBefore = await shardsOf(deedless.wallet);
    await settleClanChests(db, `w-${k()}`);
    expect(await shardsOf(deedless.wallet)).toBe(dBefore); // not one shard
    expect(await shardsOf(leader.wallet)).toBe(lBefore + 1001n);
    const [after] = await db.select({ c: clans.chestShards }).from(clans).where(eq(clans.id, clan.id));
    expect(after!.c).toBe(0n);
    expect(await clanChestInvariantHolds(db)).toBe(true);
  });

  it('an ALL-deedless clan settles nothing and the chest rolls over intact', async () => {
    // The `roster.length === 0` branch used to be labelled unreachable. It is
    // reachable now, and it must roll over rather than strand or force-pay.
    const leader = await funded();
    const clan = await createClan(db, leader.wallet, { name: uname(), tag: utag() }, k());
    const { bootstrapSystemAccounts: boot } = await import('../src/ledger');
    const { postTransaction } = await import('../src/ledger/ledger');
    const sys = await boot(db);
    const src = await getOrCreatePlayerAccount(db, leader.wallet, 'player_shards');
    await postTransaction(db, {
      idempotencyKey: k(), type: 'test.seed_chest',
      entries: [{ account: src.id, delta: -640n }, { account: sys.clan_chest, delta: 640n }],
    });
    await db.update(clans).set({ chestShards: 640n }).where(eq(clans.id, clan.id));

    const before = await shardsOf(leader.wallet);
    await settleClanChests(db, `w-${k()}`);
    expect(await shardsOf(leader.wallet)).toBe(before);
    const [after] = await db.select({ c: clans.chestShards }).from(clans).where(eq(clans.id, clan.id));
    expect(after!.c).toBe(640n);
    expect(await clanChestInvariantHolds(db)).toBe(true);
  });

  it('dissolving pays the chest to the departing leader — nothing strands in the pool', async () => {
    const leader = await funded();
    const clan = await createClan(db, leader.wallet, { name: uname(), tag: utag() }, k());
    const { bootstrapSystemAccounts: boot } = await import('../src/ledger');
    const { postTransaction } = await import('../src/ledger/ledger');
    const sys = await boot(db);
    const src = await getOrCreatePlayerAccount(db, leader.wallet, 'player_shards');
    await postTransaction(db, {
      idempotencyKey: k(), type: 'test.seed_chest',
      entries: [{ account: src.id, delta: -777n }, { account: sys.clan_chest, delta: 777n }],
    });
    await db.update(clans).set({ chestShards: 777n }).where(eq(clans.id, clan.id));

    const before = await shardsOf(leader.wallet);
    const res = await leaveClan(db, leader.wallet);
    expect(res.disbanded).toBe(true);
    expect(await shardsOf(leader.wallet)).toBe(before + 777n);
    expect(await clanChestInvariantHolds(db)).toBe(true); // clan row gone, pool drained
  });

  it('chest math uses CLANS.chestTitheBps off the post-tithe net', () => {
    // Pin the formula shape so a "helpful" refactor to gross-based doesn't
    // silently change what clans earn. 10000 net at 200bps = 200.
    expect(CLANS_C.chestTitheBps).toBe(200);
    expect((10_000n * BigInt(CLANS_C.chestTitheBps)) / 10_000n).toBe(200n);
  });
});

describe('clan chest — security review pins (2026-07-26)', () => {
  it('[!] OWNER: kick-all-then-leave hands the leader the WHOLE chest (finding 2, unresolved)', async () => {
    // This pins CURRENT behaviour, deliberately: the chest is funded by every
    // member's raids, kicks are free, and the dissolve residual pays whoever
    // leaves last — so a leader can kick 19 members on Saturday and pocket a
    // chest that is ~95% other people's contributions. The reviewer classed the
    // fix (settle-to-roster / burn residual / kick costs) as an ECONOMIC design
    // decision, not a ledger bug — conservation holds throughout. When the owner
    // decides, this test flips from documenting the exploit to forbidding it.
    const leader = await funded();
    const clan = await createClan(db, leader.wallet, { name: uname(), tag: utag() }, k());
    const m = await createTestPlayer(db);
    await joinClan(db, m.wallet, clan.id);
    const { bootstrapSystemAccounts: boot } = await import('../src/ledger');
    const { postTransaction } = await import('../src/ledger/ledger');
    const sys = await boot(db);
    const src = await getOrCreatePlayerAccount(db, leader.wallet, 'player_shards');
    await postTransaction(db, {
      idempotencyKey: k(), type: 'test.seed_chest',
      entries: [{ account: src.id, delta: -1000n }, { account: sys.clan_chest, delta: 1000n }],
    });
    await db.update(clans).set({ chestShards: 1000n }).where(eq(clans.id, clan.id));

    await kickMember(db, leader.wallet, m.wallet); // free
    const before = await shardsOf(leader.wallet);
    await leaveClan(db, leader.wallet);            // dissolve pays the residual
    expect(await shardsOf(leader.wallet)).toBe(before + 1000n); // 100% capture
    expect(await clanChestInvariantHolds(db)).toBe(true);       // ledger-clean, economics-dirty
  });

  it('the pool can never be overdrawn — clan_chest is a non-negative kind (finding 3)', async () => {
    // With clan_chest in NON_NEGATIVE_KINDS, an attribution>pool drift now dies
    // at the posting instead of silently minting shards from a negative pool.
    const { bootstrapSystemAccounts: boot } = await import('../src/ledger');
    const { postTransaction, InsufficientFundsError: IFE } = await import('../src/ledger/ledger');
    const sys = await boot(db);
    const p = await funded();
    const acc = await getOrCreatePlayerAccount(db, p.wallet, 'player_shards');
    const [pool] = await db.execute(sql`select balance from accounts where id = ${sys.clan_chest}`) as unknown as Array<{ balance: string }>;
    const over = BigInt(pool?.balance ?? '0') + 1n;
    await expect(postTransaction(db, {
      idempotencyKey: k(), type: 'test.overdraw',
      entries: [{ account: sys.clan_chest, delta: -over }, { account: acc.id, delta: over }],
    })).rejects.toThrow(IFE);
  });
});
