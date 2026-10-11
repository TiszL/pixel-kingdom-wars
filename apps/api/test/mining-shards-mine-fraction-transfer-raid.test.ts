/** Source conservation at actual stable-base and raid lifecycle boundaries.
 * All earned buffer/fraction comes from the real capture/reanchor operations;
 * fixture inserts establish only an empty Mine and its initial ownership. */
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMiningQuota, MINING } from '@shardkeep/shared';
import { bases, baseSlots, buildings, mineAccrualStates, players, raids, baseRaidLocks } from '../src/db/schema';
import { captureFullBaseMineAccrual, MINE_DAY_MS, reanchorBaseMineAccrual } from '../src/game/baseMining';
import { transferStableBase } from '../src/game/baseOwnership';
import { releaseDeedRaidLoot, reserveDeedRaidLoot } from '../src/game/raidLoot';
import { capturePhysicalMineSources } from '../src/mining/shardsTaxMineFullCapture';
import { initializeMiningRosterHistory } from '../src/mining/rosterHistory';
import { setMineResolutionRosterClock } from './fixtures/historicalMineResolution';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';

const day = BigInt(MINE_DAY_MS);
const quota = BigInt(getMiningQuota(1, [1], 0, MINING.EPOCH_RATE_BPS));
const anchor = new Date('2035-01-17T00:00:00.000Z');
let conn: ReturnType<typeof resourceClaimsDatabase>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(anchor);
  vi.stubEnv('FREE_ONBOARDING', 'true');
  vi.stubEnv('MULTI_BASE_ENABLED', 'true');
  vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
  conn = resourceClaimsDatabase(); await conn.setup();
  await conn.sql`insert into shards_mine_policy_boundary(id,version,policy_version,tax_table_version,effective_at)
    values(1,1,1,1,'2035-01-16T00:00:00Z')`;
  await setMineResolutionRosterClock(conn, '2035-01-16T00:00:00Z');
}, 120_000);
afterEach(async () => {
  await conn?.close(); vi.unstubAllEnvs(); vi.useRealTimers();
}, 120_000);

async function moveClock(at: Date) {
  vi.setSystemTime(at); await setMineResolutionRosterClock(conn, at.toISOString());
}
async function emptyMine(deeded = false) {
  const wallet = Keypair.generate().publicKey.toBase58();
  const deed = deeded ? Keypair.generate().publicKey.toBase58() : null;
  await conn.db.insert(players).values({ wallet });
  const [base] = await conn.db.insert(bases).values({ ownerWallet: wallet, status: 'active', keepLevel: 1,
    ...(deed ? { deedAssetId: deed, deedMintAssetId: deed, landPaidAt: new Date('2035-01-15T00:00:00Z') } : {}) }).returning();
  if (!base) throw Error('Fixture base missing');
  await conn.db.insert(baseSlots).values({ wallet, slot: 1, baseId: base.id });
  const [mine] = await conn.db.insert(buildings).values({ playerWallet: wallet, baseId: base.id,
    type: 'mine', level: 1, tx: 1, ty: 1 }).returning();
  if (!mine) throw Error('Fixture Mine missing');
  await conn.db.insert(mineAccrualStates).values({ mineBuildingId: mine.id, lastAccrualAt: anchor });
  await initializeMiningRosterHistory(conn.db, wallet);
  return { wallet, baseId: base.id, mineId: mine.id, deed };
}
type Mine = Awaited<ReturnType<typeof emptyMine>>;
async function state(f: Mine) {
  const [row] = await conn.db.select().from(mineAccrualStates).where(eq(mineAccrualStates.mineBuildingId, f.mineId));
  if (!row) throw Error('Fixture state missing'); return row;
}
async function sourceRows(f: Mine) {
  return conn.sql`select id,wallet,source_key,starts_at,ends_at,quota::text,first_unit::text,last_unit::text,
    gross::text,buffer::text,reserved::text,issued::text,discarded::text,resolved::text
    from shards_mine_segments where mine_id=${f.mineId} order by starts_at,id`;
}
async function settle(f: Mine, at: Date, capture = false, wallet = f.wallet) {
  await moveClock(at);
  // These are internal source helpers; take the same actor/base/slot order as
  // their callers. This fixture does not substitute an HTTP ownership proof.
  await conn.db.transaction(async tx => {
    await tx.select().from(players).where(eq(players.wallet, wallet)).for('update');
    const [base] = await tx.select().from(bases).where(eq(bases.id, f.baseId)).for('update');
    if (base?.ownerWallet !== wallet) throw Error('Fixture current owner changed');
    await tx.select().from(baseSlots).where(eq(baseSlots.baseId, f.baseId)).for('update');
    if (capture) await captureFullBaseMineAccrual(tx, f.baseId, at, true);
    else await reanchorBaseMineAccrual(tx, f.baseId, at);
  });
}
async function tracked(f: Mine) {
  const elapsed = (20n * day + 3n * day / 4n) / quota;
  const at = new Date(+anchor + Number(elapsed));
  const gross = quota * elapsed / day, remainder = quota * elapsed % day;
  expect(gross).toBe(20n); expect(remainder).toBeGreaterThan(0n); expect(gross).toBeLessThan(quota);
  await settle(f, at, true);
  expect(await state(f)).toMatchObject({ accruedShards: gross, productionRemainder: remainder, lastAccrualAt: at });
  return { at, gross, remainder };
}
async function reserve(f: Mine, at: Date) {
  const attacker = Keypair.generate().publicKey.toBase58();
  await conn.db.insert(players).values({ wallet: attacker });
  const [base] = await conn.db.insert(bases).values({ ownerWallet: attacker, status: 'active', keepLevel: 1 }).returning();
  if (!base) throw Error('Attacker base missing');
  return conn.db.transaction(async tx => {
    const [raid] = await tx.insert(raids).values({ idempotencyKey: randomUUID(), attackerWallet: attacker,
      attackerBaseId: base.id, defenderWallet: f.wallet, defenderBaseId: f.baseId, seed: 1n,
      snapshot: {}, armySnapshot: {}, simVersion: 9, ordersDeadlineAt: new Date(+at + 120_000) }).returning();
    if (!raid) throw Error('Raid fixture missing');
    await tx.insert(baseRaidLocks).values({ baseId: f.baseId, raidId: raid.id, expiresAt: new Date(+at + 180_000) });
    const frozen = await reserveDeedRaidLoot(tx, { raidId: raid.id, attackerBaseId: base.id, defenderBaseId: f.baseId, now: at });
    return { raidId: raid.id, frozen };
  });
}
async function assertNoIssue(f: Mine) {
  expect(await conn.sql`select a.operation_key from shards_tax_assessments a join shards_mine_segments s on s.id=a.segment_id where s.mine_id=${f.mineId}`).toHaveLength(0);
  expect(await conn.sql`select id from ledger_transactions where type in ('mine.collect','raid.loot.settle')
    and (metadata->>'baseId'=${f.baseId} or metadata->>'defenderBaseId'=${f.baseId})`).toHaveLength(0);
}

describe.sequential('fractional Mine source transfer and raid conservation', () => {
  it('keeps the base-owned fraction through a real stable transfer without rewriting completed seller units', async () => {
    const f = await emptyMine(true), earned = await tracked(f), original = await sourceRows(f);
    const buyer = Keypair.generate().publicKey.toBase58();
    await conn.db.insert(players).values({ wallet: buyer });
    // Server-observed ownership is injected at the canonical transfer boundary,
    // as in the existing transfer fixtures; no claim of live-chain execution.
    await transferStableBase(conn.db, f.baseId, f.wallet, buyer, f.deed!, {
      owner: buyer, collection: Keypair.generate().publicKey.toBase58(), frozen: false,
      delegate: null, slot: 1001, observedAtMs: +earned.at,
    }, () => new Date(earned.at));
    expect(await sourceRows(f)).toEqual(original);
    expect(await state(f)).toMatchObject({ accruedShards: earned.gross, productionRemainder: earned.remainder, lastAccrualAt: earned.at });
    expect(await conn.sql`select wallet from base_slots where base_id=${f.baseId}`).toEqual([{ wallet: buyer }]);
    const beforeOldCaller = await state(f);
    await expect(capturePhysicalMineSources(conn.db, f.wallet, f.baseId)).rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    expect(await state(f)).toEqual(beforeOldCaller); expect(await sourceRows(f)).toEqual(original);
    const elapsed = (day - earned.remainder + quota - 1n) / quota;
    expect(elapsed * quota).toBeLessThan(day);
    await settle(f, new Date(+earned.at + Number(elapsed)), false, buyer);
    const final = await state(f), rows = await sourceRows(f);
    expect(final.accruedShards).toBe(earned.gross + 1n);
    expect(final.productionRemainder).toBe((earned.remainder + quota * elapsed) % day);
    expect(rows.filter(row => row.wallet === f.wallet)).toEqual(original);
    const buyerRows = rows.filter(row => row.wallet === buyer);
    expect(buyerRows).toHaveLength(1); expect(buyerRows[0]!.gross).toBe('1');
    expect(new Date(buyerRows[0]!.starts_at)).toEqual(final.lastAccrualAt);
    expect(await conn.sql`select admission_id from shards_mine_heads where mine_id=${f.mineId}`).toHaveLength(0);
    // Original unresolved custody/term is retained, never reassigned or issued.
    await assertNoIssue(f);
  });

  it('reserves and restores actual whole raid stock without losing a below-cap earned fraction', async () => {
    const f = await emptyMine(), earned = await tracked(f), originals = await sourceRows(f);
    const raid = await reserve(f, earned.at);
    expect(raid.frozen.mines).toBe(earned.gross);
    expect(await state(f)).toMatchObject({ accruedShards: 0n, productionRemainder: earned.remainder, lastAccrualAt: earned.at });
    expect((await sourceRows(f)).map(row => ({ buffer: row.buffer, reserved: row.reserved })))
      .toEqual([{ buffer: '0', reserved: earned.gross.toString() }]);
    expect(await releaseDeedRaidLoot(conn.db, raid.raidId, earned.at)).toBe(true);
    expect(await state(f)).toMatchObject({ accruedShards: earned.gross, productionRemainder: earned.remainder, lastAccrualAt: earned.at });
    expect(await sourceRows(f)).toEqual(originals);
    expect(await conn.sql`select id from shards_mine_production_settlements where mine_id=${f.mineId} and kind='capacity_discard'`).toHaveLength(0);
    const restored = await state(f);
    expect(await releaseDeedRaidLoot(conn.db, raid.raidId, earned.at)).toBe(true);
    expect(await state(f)).toEqual(restored);
    const elapsed = (day - earned.remainder + quota - 1n) / quota;
    await settle(f, new Date(+earned.at + Number(elapsed)));
    expect(await state(f)).toMatchObject({ accruedShards: earned.gross + 1n,
      productionRemainder: (earned.remainder + quota * elapsed) % day });
    await assertNoIssue(f);
  });

  it('records a paired cap discard on actual raid restoration and cannot resurrect that numerator later', async () => {
    const f = await emptyMine(), earned = await tracked(f), raid = await reserve(f, earned.at);
    // A delayed terminal release can follow real production while the reserved
    // old buffer is detached. No raid timer is used as production authority.
    const target = (quota - earned.gross + 1n) * day + day / 2n;
    const elapsed = (target - earned.remainder) / quota;
    const produced = (earned.remainder + quota * elapsed) / day;
    const beforeReturnRemainder = (earned.remainder + quota * elapsed) % day;
    expect(produced).toBeLessThan(quota); expect(produced + earned.gross).toBeGreaterThan(quota);
    expect(beforeReturnRemainder).toBeGreaterThan(0n);
    const returnedAt = new Date(+earned.at + Number(elapsed));
    await settle(f, returnedAt);
    expect(await state(f)).toMatchObject({ accruedShards: produced, productionRemainder: beforeReturnRemainder });
    expect(await releaseDeedRaidLoot(conn.db, raid.raidId, returnedAt)).toBe(true);
    const capped = await state(f);
    expect(capped.accruedShards).toBe(quota); expect(capped.productionRemainder).toBe(0n);
    const witnesses = await conn.sql`select state_version,previous_gross::text,remainder_before::text,gross::text,
      remainder_after::text,target_buffer::text,anchor_at,target_at,observed_at,applied
      from shards_mine_production_settlements where mine_id=${f.mineId} and kind='capacity_discard'`;
    expect(witnesses).toHaveLength(1);
    expect(witnesses[0]).toMatchObject({ previous_gross: quota.toString(), remainder_before: beforeReturnRemainder.toString(),
      gross: '0', remainder_after: '0', target_buffer: quota.toString(), applied: true });
    expect(witnesses[0]!.state_version + 1).toBe(capped.version);
    for (const field of ['anchor_at', 'target_at', 'observed_at'] as const)
      expect(new Date(witnesses[0]![field])).toEqual(returnedAt);
    const rows = await sourceRows(f);
    expect(rows.reduce((n, row) => n + BigInt(row.buffer), 0n)).toBe(quota);
    expect(rows.reduce((n, row) => n + BigInt(row.discarded), 0n)).toBe(produced + earned.gross - quota);
    expect(rows.reduce((n, row) => n + BigInt(row.gross), 0n)).toBe(produced + earned.gross);
    expect(await releaseDeedRaidLoot(conn.db, raid.raidId, returnedAt)).toBe(true);
    expect(await state(f)).toEqual(capped);
    // A second genuine reservation creates storage room. At the instant at
    // which the discarded r would have completed a unit, new production alone
    // must still be below one: no new whole buffer, segment or financial credit.
    const second = await reserve(f, returnedAt);
    expect(second.frozen.mines).toBe(quota);
    const newElapsed = (day - beforeReturnRemainder + quota - 1n) / quota;
    expect(quota * newElapsed).toBeLessThan(day);
    const before = await sourceRows(f);
    await settle(f, new Date(+returnedAt + Number(newElapsed)));
    expect(await state(f)).toMatchObject({ accruedShards: 0n, productionRemainder: quota * newElapsed });
    expect(await sourceRows(f)).toEqual(before);
    await assertNoIssue(f);
  });
});
