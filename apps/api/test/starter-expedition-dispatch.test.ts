/** Source tests only: synthetic reader fixtures never enter runtime wiring. */
import { randomUUID } from 'node:crypto';
import { BuildingType } from '@shardkeep/shared';
import { starterRoutePreview, StarterRouteIdSchema } from '@shardkeep/shared/phaseEExpeditions';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { bases, baseSlots, builderJobs, buildings, expeditionFreeHomes, expeditionTermSnapshots,
  starterExpeditions, starterExpeditionInflight } from '../src/db/schema';
import { rewardBaseShards, spendBaseShards } from '../src/game/baseEconomy';
import { dispatchStarterExpedition, readStarterExpedition, StarterExpeditionCommandSchema } from '../src/game/starterExpeditionDispatch';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { connectTestDb } from './helpers';

const conn = connectTestDb(), db = conn.db;
afterAll(() => conn.sql.end());
const fixture = () => createStarterExpeditionFixture(db);
type Fixture = Awaited<ReturnType<typeof fixture>>;
const rows = (f: Fixture) => db.select().from(starterExpeditions).where(eq(starterExpeditions.baseId, f.baseId));
async function noAdmission(f: Fixture) {
  expect(await rows(f)).toEqual([]);
  expect(await db.select().from(expeditionFreeHomes).where(eq(expeditionFreeHomes.baseId, f.baseId))).toEqual([]);
  expect(await db.select().from(expeditionTermSnapshots).where(eq(expeditionTermSnapshots.termId, f.snapshot.termId))).toEqual([]);
}

describe('internal automatic starter dispatch', () => {
  it('freezes authoritative home, current route split and the exact single-reader finality', async () => {
    const f = await fixture(), original = f.reader.readOperatingTerm.bind(f.reader);
    f.reader.readOperatingTerm = vi.fn(original);
    const p = await f.dispatch(), route = starterRoutePreview('crownlands', 'introduction');
    expect(p).toMatchObject({ ...f.command, actorWallet: f.wallet, routeSnapshot: route,
      resourceId: route.resourceId, gross: BigInt(route.grossQuantity), net: BigInt(route.netQuantity), tax: BigInt(route.islandPoolQuantity),
      finality: { commitment: 'finalized', observedAt: f.now.toISOString(), contextSlot: '200' } });
    expect(p.gross).toBe(p.net + p.tax); expect(p.returnsAt.getTime() - p.departedAt.getTime()).toBe(route.durationSec * 1_000);
    expect(f.reader.readOperatingTerm).toHaveBeenCalledTimes(1);
    expect(await readStarterExpedition(db, p.id.toUpperCase())).toEqual(p);
    expect(await db.select().from(starterExpeditionInflight).where(eq(starterExpeditionInflight.installationId, f.installationId)))
      .toEqual([{ installationId: f.installationId, expeditionId: p.id }]);
  });

  it('serializes identical concurrent dispatch to one source and reservation', async () => {
    const f = await fixture(), all = await Promise.all(Array.from({ length: 4 }, () => f.dispatch()));
    expect(all.every(p => p.id === f.command.id)).toBe(true); expect(await rows(f)).toHaveLength(1);
  });

  it('different concurrent keys cannot put the same installed starter on two trips', async () => {
    const f = await fixture();
    const all = await Promise.allSettled([f.dispatch(), dispatchStarterExpedition(db, f.wallet,
      { ...f.command, id: randomUUID() }, f.authority, { reader: f.reader, clock: () => f.now })]);
    expect(all.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(all.filter(r => r.status === 'rejected')).toHaveLength(1); expect(await rows(f)).toHaveLength(1);
  });

  it('replays original acceptance despite later inactive base, missing slot, expiry and unavailable authority/reader', async () => {
    const f = await fixture(), original = await f.dispatch();
    await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    await db.update(bases).set({ status: 'inactive' }).where(eq(bases.id, f.baseId));
    f.now = new Date(f.snapshot.endsAt);
    f.reader.readOperatingTerm = async () => { throw new Error('outage'); };
    f.authority.assertAuthority = async () => { throw new Error('ownership no longer available'); };
    expect(await f.dispatch()).toEqual(original); expect(await rows(f)).toHaveLength(1);
  });

  it.each(['baseId', 'installationId', 'routeId', 'routeVersion', 'rewardVersion'] as const)('same key with changed %s is refused before new authority/provider work', async field => {
    const f = await fixture(); await f.dispatch();
    const command = { ...f.command, [field]: field.endsWith('Version') ? 99 : field === 'routeId' ? 'retired_route' : randomUUID() };
    await expect(dispatchStarterExpedition(db, f.wallet, command, f.authority)).rejects.toMatchObject({ code: 'IDEMPOTENCY_BODY_MISMATCH' });
    expect(await rows(f)).toHaveLength(1);
  });

  it('global UUID is private to the original actor even if another wallet owns a starter', async () => {
    const a = await fixture(), b = await fixture(); await a.dispatch(); b.command.id = a.command.id;
    await expect(b.dispatch()).rejects.toMatchObject({ code: 'IDEMPOTENCY_BODY_MISMATCH' }); await noAdmission(b);
  });

  it('missing/null/error reader fails closed and rolls back lazily assigned home', async () => {
    for (const mode of ['missing', 'null', 'error']) {
      const f = await fixture();
      await expect(dispatchStarterExpedition(db, f.wallet, f.command, f.authority, { clock: () => f.now,
        ...(mode === 'missing' ? {} : { reader: { async readOperatingTerm() { if (mode === 'error') throw new Error('RPC'); return null; } } }),
      })).rejects.toThrow(); await noAdmission(f);
    }
  });

  it('a cold finalized response observed after locked dispatch time is never backdated', async () => {
    const f = await fixture(); f.reader = { async readOperatingTerm() { return { snapshot: f.snapshot,
      finality: { commitment: 'finalized', contextSlot: '200', observedAt: new Date(f.now.getTime() + 1).toISOString() } }; } };
    await expect(f.dispatch()).rejects.toThrow('not observed'); await noAdmission(f);
  });

  it.each(['no-proof', 'unfinished', 'cancelled', 'wrong-type'] as const)('requires positive Lodge completion, rejecting %s without completing jobs', async bad => {
    const f = await fixture();
    if (bad === 'no-proof') await db.delete(builderJobs).where(eq(builderJobs.id, f.lodgeJobId));
    if (bad === 'unfinished') await db.update(builderJobs).set({ completedAt: null }).where(eq(builderJobs.id, f.lodgeJobId));
    if (bad === 'cancelled') {
      // Initial builds cannot be cancelled. A lawful cancelled upgrade has a
      // terminal timestamp, but still cannot stand in for completed construction.
      await expect(db.update(builderJobs).set({ cancelledAt: f.now }).where(eq(builderJobs.id, f.lodgeJobId))).rejects.toThrow();
      await rewardBaseShards(db, f.baseId, 1n, 'test.cancel.seed', randomUUID());
      const debit = await spendBaseShards(db, f.baseId, 1n, 'test.cancel.debit', randomUUID(), undefined, { progressQuests: false });
      const refund = await rewardBaseShards(db, f.baseId, 1n, 'test.cancel.refund', randomUUID());
      await db.update(builderJobs).set({ kind: 'upgrade', cancelledAt: f.now, paidShardCost: 1n,
        debitLedgerTxnId: debit.transaction.id, refundLedgerTxnId: refund.transaction.id, cancelIdempotencyKey: randomUUID() })
        .where(eq(builderJobs.id, f.lodgeJobId));
    }
    if (bad === 'wrong-type') await db.update(buildings).set({ type: BuildingType.Camp }).where(eq(buildings.id, f.lodgeId));
    await expect(f.dispatch()).rejects.toMatchObject({ code: 'EXPEDITION_LODGE_UNAVAILABLE' }); await noAdmission(f);
  });

  it('never borrows a Lodge or starter from another base', async () => {
    const f = await fixture(), other = await fixture();
    await db.update(buildings).set({ baseId: other.baseId }).where(eq(buildings.id, f.lodgeId));
    await expect(f.dispatch()).rejects.toMatchObject({ code: 'EXPEDITION_LODGE_UNAVAILABLE' });
    f.command.installationId = other.installationId;
    await expect(f.dispatch()).rejects.toMatchObject({ code: 'STARTER_FLEET_UNAVAILABLE' }); await noAdmission(f);
  });

  it('failed current authority cannot create free home, term or trip', async () => {
    const f = await fixture(); f.authority.assertAuthority = async () => { throw new Error('finality unavailable'); };
    await expect(f.dispatch()).rejects.toThrow('finality unavailable'); await noAdmission(f);
  });

  it('refuses changed route versions without committing home or requesting a term', async () => {
    const f = await fixture(); f.command.rewardVersion += 1; f.reader.readOperatingTerm = vi.fn();
    await expect(f.dispatch()).rejects.toMatchObject({ code: 'EXPEDITION_ROUTE_CHANGED' });
    expect(f.reader.readOperatingTerm).not.toHaveBeenCalled(); await noAdmission(f);
  });

  it('samples server time after authority/base locks and validates that exact time', async () => {
    const f = await fixture(); let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
    const original = f.authority.assertAuthority; let first = true;
    f.authority.assertAuthority = async (...args) => { await original(...args); if (first) { first = false; entered(); await gate; } };
    const clock = vi.fn(() => f.now);
    const dispatch = dispatchStarterExpedition(db, f.wallet, f.command, f.authority, { reader: f.reader, clock });
    await waiting; expect(clock).not.toHaveBeenCalled(); f.now = new Date(f.now.getTime() + 1_000); release();
    // Admission samples after the base locks and again after term pinning can wait.
    expect((await dispatch).departedAt).toEqual(f.now); expect(clock).toHaveBeenCalledTimes(2);
  });

  it('term end is exclusive and rolls back all admission writes', async () => {
    const f = await fixture(); f.now = new Date(f.snapshot.endsAt);
    await expect(f.dispatch()).rejects.toThrow('not current'); await noAdmission(f);
  });

  it('outer failure rolls back home, pinned term, accepted source and active flight together', async () => {
    const f = await fixture();
    await expect(db.transaction(async tx => { await dispatchStarterExpedition(tx, f.wallet, f.command, f.authority,
      { reader: f.reader, clock: () => f.now }); throw new Error('downstream failed'); })).rejects.toThrow('downstream failed');
    await noAdmission(f); expect(await db.select().from(starterExpeditionInflight).where(eq(starterExpeditionInflight.installationId, f.installationId))).toEqual([]);
  });

  it('SQL forbids releasing the vehicle without a complete terminal return', async () => {
    const f = await fixture(); await f.dispatch();
    await expect(db.transaction(async tx => { await tx.delete(starterExpeditionInflight).where(eq(starterExpeditionInflight.installationId, f.installationId)); }))
      .rejects.toThrow(); expect(await rows(f)).toHaveLength(1);
  });

  it('historical replay does not parse the current route catalogue after an old route is withdrawn', async () => {
    const f = await fixture(), p = await f.dispatch();
    const parser = vi.spyOn(StarterRouteIdSchema, 'parse').mockImplementation(() => { throw new Error('route withdrawn'); });
    try {
      expect(await readStarterExpedition(db, p.id)).toEqual(p);
      expect(await f.dispatch()).toEqual(p);
    } finally { parser.mockRestore(); }
  });

  it('SQL makes source history immutable, and strict command parsing rejects caller economics', async () => {
    const f = await fixture(), p = await f.dispatch();
    await expect(db.update(starterExpeditions).set({ gross: p.gross + 1n }).where(eq(starterExpeditions.id, p.id))).rejects.toThrow();
    await expect(db.delete(starterExpeditions).where(eq(starterExpeditions.id, p.id))).rejects.toThrow();
    expect(StarterExpeditionCommandSchema.safeParse({ ...f.command, gross: '100000' }).success).toBe(false);
    expect(StarterExpeditionCommandSchema.safeParse({ ...f.command, termId: f.snapshot.termId }).success).toBe(false);
    expect(await readStarterExpedition(db, p.id)).toEqual(p);
  });
});
