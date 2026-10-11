/** Synthetic term fixtures exercise real DB admission/returns, not chain finality. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PHASE_E_POLICY, PHASE_E_STARTER_ROUTES as C } from '@shardkeep/shared';
import { starterRoutePreview, type StarterRouteId } from '@shardkeep/shared/phaseEExpeditions';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { bases, baseSlots, resourceStocks, starterExpeditions, starterExpeditionInflight } from '../src/db/schema';
import { dispatchStarterExpedition, readStarterExpedition, StarterExpeditionCommandSchema } from '../src/game/starterExpeditionDispatch';
import { readStarterExpeditionReturn, settleDueStarterExpeditions } from '../src/game/starterExpeditionReturns';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb(), db = conn.db;
afterAll(() => conn.sql.end());
type Fixture = Awaited<ReturnType<typeof createStarterExpeditionFixture>>;
function choose(f: Fixture, routeId: StarterRouteId) {
  const p = starterRoutePreview('crownlands', routeId);
  f.command = { ...f.command, id: randomUUID(), routeId, routeVersion: p.routeCatalogueVersion, rewardVersion: p.rewardTableVersion };
}
const settle = (f: Fixture, at: Date) => db.transaction(tx => settleDueStarterExpeditions(tx, f.baseId, at));

// SQL is a generated historical projection, never another live tuning source.
it('pins migration0146 to immutable common policy v1, preserving future-policy independence', () => {
  const sql = readFileSync(new URL('../drizzle/0146_starter_common_access.sql', import.meta.url), 'utf8');
  const c = C.commonV1, tax = BigInt(c.grossRaw) * BigInt(PHASE_E_POLICY.taxes.resources.islandPoolBps) / BigInt(PHASE_E_POLICY.basisPoints);
  expect(sql).toContain(`NEW.gross = ${c.grossRaw} AND NEW.net = ${BigInt(c.grossRaw) - tax} AND NEW.tax = ${tax}`);
  expect(sql).toContain(`NEW.returns_at - NEW.departed_at = interval '${c.durationSec} seconds'`);
  for (const [route, realm] of Object.entries(c.routes)) expect(sql).toContain(`WHEN '${route}' THEN '${realm}'`);
});

describe('explicit common starter access preserves original obligations', () => {
  it('obtains every ingredient family of the three accepted kits from one free base without spending inputs', async () => {
    const f = await createStarterExpeditionFixture(db);
    const required = ['common_elderwood', 'common_thornwake', 'common_seeker_reach', 'common_frostveil', 'common_sunscar', 'common_cinderfall'] as const;
    for (const id of required) {
      choose(f, id); const p = await f.dispatch();
      expect(p.homeEvidence).toMatchObject({ source: 'free_assignment', realmId: 'crownlands' });
      expect(p.routeSnapshot).toMatchObject({ routeId: id, access: { kind: 'starter_common', policyVersion: 1 } });
      f.now = p.returnsAt; const [proof] = await settle(f, f.now);
      expect(proof!.entries.reduce((sum, e) => sum + e.delta, 0n)).toBe(0n);
      expect(proof!.expedition.resourceId).toBe(p.resourceId);
    }
    const stocks = await db.select().from(resourceStocks).where(eq(resourceStocks.baseId, f.baseId));
    expect(stocks).toHaveLength(required.length);
    expect(stocks.every(s => s.available > 0n && s.reserved === 0n)).toBe(true);
  });

  it('cannot inject a destination, permit assertion, material or arbitrary resource in the command', async () => {
    const f = await createStarterExpeditionFixture(db);
    choose(f, 'common_frostveil');
    for (const added of [{ realmId: 'elderwood' }, { access: { kind: 'starter_common' } }, { resourceId: 'ember_nodules' }, { permit: true }])
      expect(StarterExpeditionCommandSchema.safeParse({ ...f.command, ...added }).success).toBe(false);
    f.command.routeVersion = 1;
    await expect(f.dispatch()).rejects.toMatchObject({ code: 'EXPEDITION_ROUTE_CHANGED' });
    expect(await db.select().from(starterExpeditions).where(eq(starterExpeditions.baseId, f.baseId))).toEqual([]);
  });

  it('HOME and common routes compete for the same original vehicle', async () => {
    const f = await createStarterExpeditionFixture(db), home = { ...f.command };
    choose(f, 'common_frostveil');
    const results = await Promise.allSettled([f.dispatch(), dispatchStarterExpedition(db, f.wallet, home, f.authority,
      { reader: f.reader, clock: () => f.now })]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(await db.select().from(starterExpeditionInflight).where(eq(starterExpeditionInflight.installationId, f.installationId))).toHaveLength(1);
  });

  it('replays a genuine version1 HOME shape after catalogue bump without re-admission', async () => {
    const f = await createStarterExpeditionFixture(db), current = await f.dispatch();
    await settle(f, current.returnsAt);
    // Append the old immutable shape, never edit a previously accepted receipt.
    const old = { ...current, id: randomUUID(), routeVersion: 1, rewardVersion: 1,
      routeSnapshot: { ...current.routeSnapshot, routeCatalogueVersion: 1, rewardTableVersion: 1 } };
    await db.transaction(async tx => {
      await tx.insert(starterExpeditions).values(old);
      await tx.insert(starterExpeditionInflight).values({ installationId: old.installationId, expeditionId: old.id });
    });
    f.command = { ...f.command, id: old.id, routeVersion: 1, rewardVersion: 1 };
    f.reader.readOperatingTerm = async () => { throw new Error('term changed'); };
    f.authority.assertAuthority = async () => { throw new Error('base sold'); };
    expect(await f.dispatch()).toEqual(old);
    expect(await readStarterExpedition(db, old.id)).toEqual(old);
  });

  it('returns frozen common output after custody and operating-term changes without today\'s access', async () => {
    const f = await createStarterExpeditionFixture(db), buyer = await createTestPlayer(db);
    choose(f, 'common_frostveil'); const p = await f.dispatch();
    // The custody hook has its own integration suites; this pins return independence.
    await db.transaction(async tx => {
      await tx.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
      await tx.update(bases).set({ ownerWallet: buyer.wallet, status: 'inactive' }).where(eq(bases.id, f.baseId));
    });
    f.reader.readOperatingTerm = async () => { throw new Error('unavailable'); };
    const [proof] = await settle(f, new Date(f.snapshot.endsAt));
    expect(proof!.receipt.custodyWallet).toBe(buyer.wallet);
    expect(proof!.expedition).toMatchObject({ id: p.id, actorWallet: f.wallet, termHash: p.termHash, resourceId: p.resourceId });
    expect(await readStarterExpeditionReturn(db, p.id)).toEqual(proof);
    expect(await settle(f, new Date(f.snapshot.endsAt))).toEqual([]);
    expect((await db.select().from(resourceStocks).where(and(eq(resourceStocks.baseId, f.baseId), eq(resourceStocks.resourceId, p.resourceId))))[0]!.available).toBe(p.net);
  });

  it('SQL rejects stripped, forged and overpaid common evidence and never permits history edits', async () => {
    const f = await createStarterExpeditionFixture(db); choose(f, 'common_crownlands');
    const p = await f.dispatch(); await settle(f, p.returnsAt);
    const r = p.routeSnapshot, { access: _, ...stripped } = r as typeof r & { access: unknown };
    const badRows = [
      { routeSnapshot: stripped },
      { routeSnapshot: { ...r, access: { kind: 'starter_common', policyVersion: 2 } } },
      { routeSnapshot: { ...r, access: { kind: 'starter_common', policyVersion: 1, permit: true } } },
      { routeSnapshot: { ...r, realmId: 'frostveil', resourceId: 'frost_quartz' }, resourceId: 'frost_quartz' },
      { routeSnapshot: { ...r, grossQuantity: String(p.gross + 1n), netQuantity: String(p.net + 1n) }, gross: p.gross + 1n, net: p.net + 1n },
      { routeSnapshot: { ...r, durationSec: r.durationSec + 1 }, returnsAt: new Date(p.returnsAt.getTime() + 1_000) },
      { routeSnapshot: { ...r, injected: true } },
      { routeVersion: 3, routeSnapshot: { ...r, routeCatalogueVersion: 3 } },
    ];
    for (const bad of badRows) await expect(db.transaction(async tx => {
      const id = randomUUID();
      await tx.insert(starterExpeditions).values({ ...p, ...bad, id });
      await tx.insert(starterExpeditionInflight).values({ installationId: p.installationId, expeditionId: id });
    })).rejects.toThrow();
    await expect(db.update(starterExpeditions).set({ routeSnapshot: stripped }).where(eq(starterExpeditions.id, p.id))).rejects.toThrow();
    await expect(db.delete(starterExpeditions).where(eq(starterExpeditions.id, p.id))).rejects.toThrow();
    expect(await readStarterExpedition(db, p.id)).toEqual(p);
  });
});
