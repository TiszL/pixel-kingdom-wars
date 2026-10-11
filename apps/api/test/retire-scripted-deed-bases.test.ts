/**
 * Deed-aware retirement of the 2026-07-18 scripted deed buyers (owner
 * 2026-08-22: "retire them they should not take space on globe"). WHY: the base
 * must leave the globe (inactive — the globe lists only active bases' parcels)
 * while the parcel row — the frozen Earth address a minted deed names — is
 * KEPT, the ledger must stay balanced, a named/returning player on the same
 * day is never selected, and the deed truth (entry_paid_at / deed_asset_id)
 * is kept.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureStartingBase } from '../src/game/base';
import { ensureWalletBaseIdentity } from '../src/game/baseOwnership';
import { accounts, baseAbandons, baseLeagueEntitlements, bases, buildings, players, plotReservations, plots, sessions, deposits } from '../src/db/schema';
import { bootstrapSystemAccounts } from '../src/ledger/accounts';
import { retireScriptedDeedBase, selectScriptedDeedBases } from '../src/db/retireScriptedDeedBases';
import { connectTestDb, createTestPlayer, createTestValley, fundTestKeep, seedPlot } from './helpers';

const conn = connectTestDb();
const db = conn.db;

beforeAll(async () => { process.env['MAIL_DELIVERY_ENABLED'] = 'false'; await bootstrapSystemAccounts(db); });
afterAll(async () => { delete process.env['MAIL_DELIVERY_ENABLED']; await conn.sql.end(); });

async function balance(id: string): Promise<bigint> {
  return (await db.select().from(accounts).where(eq(accounts.id, id)))[0]!.balance;
}
/** A wallet that founded a base, bought land (deed + plot) on the burst day. */
async function scriptedDeedBuyer(valleyId: string, x: number, y: number, opts: { name?: string; sessions?: number; lastSeen?: Date | null } = {}) {
  const p = await createTestPlayer(db);
  const baseId = await ensureWalletBaseIdentity(db, p.wallet, { createEmpty: true });
  await ensureStartingBase(db, p.wallet, baseId ?? undefined);
  const paidAt = new Date('2026-07-18T12:00:00Z');
  await db.update(players).set({
    createdAt: new Date('2026-07-18T11:00:00Z'), lastSeenAt: opts.lastSeen ?? null, name: opts.name ?? '', nameKey: (opts.name ?? '').toLowerCase(),
    entryPaidAt: paidAt, deedAssetId: `Deed${randomUUID().replace(/-/g, '').slice(0, 28)}`,
  }).where(eq(players.wallet, p.wallet));
  await db.update(bases).set({ landPaidAt: paidAt, deedAssetId: `Asset${randomUUID().replace(/-/g, '').slice(0, 27)}` }).where(eq(bases.ownerWallet, p.wallet));
  // Founding may already have seated the base on a parcel (multi-base identity
  // path); otherwise seat it in the test valley at (x, y).
  const existing = (await db.select().from(plots).where(eq(plots.baseId, baseId!)))[0];
  const plot = existing
    ? { valleyId: existing.valleyId, x: existing.x, y: existing.y }
    : (await seedPlot(db, { valleyId, x, y, playerWallet: p.wallet, ...(baseId ? { baseId } : {}) }), { valleyId, x, y });
  for (let i = 0; i < (opts.sessions ?? 1); i += 1) await db.insert(sessions).values({ wallet: p.wallet, expiresAt: new Date(Date.now() + 3_600_000) });
  return { wallet: p.wallet, baseId: baseId!, plot };
}

describe.sequential('retireScriptedDeedBases', () => {
  it('selects only unnamed one-session 07-18 wallets, releases their parcels and keeps the ledger + deed truth', async () => {
    const sys = await bootstrapSystemAccounts(db);
    const valley = await createTestValley(db, { name: `retire-${randomUUID().slice(0, 8)}` });
    const bot = await scriptedDeedBuyer(valley.id, 3, 3);
    await fundTestKeep(db, bot.wallet, 12_345n, 'test.dev-grant', `retire-test:${bot.wallet}`);
    // a converted reservation like a real purchase leaves behind
    const [dep] = await db.insert(deposits).values({ playerWallet: bot.wallet, kind: 'entry', reference: `ref-${randomUUID()}`, status: 'credited', amount: 200_000_000n } as never).returning({ id: deposits.id });
    await db.insert(plotReservations).values({ depositId: dep!.id, baseId: bot.baseId, earthCell: 1, countryA3: 'GEO', siteId: valley.siteId, x: 3, y: 3, state: 'converted', expiresAt: new Date(Date.now() + 3_600_000) });
    // A settled, zero-KEEP league entitlement (every base gets one weekly) must not block retirement.
    await db.insert(baseLeagueEntitlements).values({ week: '2026-08-17', baseId: bot.baseId, tier: 'bronze', trophies: 0, keepAmount: 0n, paidAt: new Date('2026-08-17T00:15:00Z') });
    const named = await scriptedDeedBuyer(valley.id, 4, 4, { name: 'RealBuyer' });
    const returned = await scriptedDeedBuyer(valley.id, 5, 5, { lastSeen: new Date('2026-08-01T00:00:00Z') });
    const twoSessions = await scriptedDeedBuyer(valley.id, 6, 6, { sessions: 2 });
    // An already-inactive base still holding its parcel is selected too (the parcel is what matters).
    const dormant = await scriptedDeedBuyer(valley.id, 7, 7);
    await db.update(bases).set({ status: 'inactive' }).where(eq(bases.ownerWallet, dormant.wallet));

    const only = [bot.wallet, named.wallet, returned.wallet, twoSessions.wallet, dormant.wallet];
    const selected = await selectScriptedDeedBases(db, { only });
    expect(selected.map((c) => c.wallet).sort()).toEqual([bot.wallet, dormant.wallet].sort());
    expect(selected.find((c) => c.wallet === bot.wallet)).toMatchObject({ plots: 1, deeds: 1, keepBalance: 12_345n });

    const pool0 = await balance(sys.emission_pool);
    const r = await retireScriptedDeedBase(db, bot.wallet);
    expect(r).not.toBeNull();
    expect(r).toMatchObject({ keepReturned: 12_345n, parcelsKept: 1 });
    expect(r!.buildingsDeleted).toBeGreaterThan(0);
    expect(r!.basesDeactivated).toBe(1);
    // The parcel row (frozen Earth address of the deed) and the purchase
    // reservation history are KEPT; the base is simply no longer active.
    expect(await db.select().from(plots).where(eq(plots.playerWallet, bot.wallet))).toHaveLength(1);
    expect((await db.select().from(plotReservations).where(eq(plotReservations.baseId, bot.baseId)))[0]!.state).toBe('converted');
    // Ledger: KEEP returned to the pool, transactions balance, entries kept.
    expect(await balance(sys.emission_pool)).toBe(pool0 + 12_345n);
    const unbalanced = (await db.execute<{ n: number }>(sql`select count(*)::int as n from (
      select t.id from ledger_transactions t join ledger_entries e on e.txn_id = t.id
      where t.type = 'retire.scripted-deed' group by t.id having sum(e.delta) <> 0) x`) as unknown as Array<{ n: number }>)[0]!.n;
    expect(unbalanced).toBe(0);
    // Base emptied + inactive, audit row written, deed truth kept on the tombstone.
    expect(await db.select().from(buildings).where(eq(buildings.playerWallet, bot.wallet))).toHaveLength(0);
    expect((await db.select().from(bases).where(eq(bases.ownerWallet, bot.wallet)))[0]!.status).toBe('inactive');
    expect(await db.select().from(baseAbandons).where(eq(baseAbandons.playerWallet, bot.wallet))).toHaveLength(1);
    const tomb = (await db.select().from(players).where(eq(players.wallet, bot.wallet)))[0]!;
    expect(tomb.entryPaidAt).not.toBeNull();
    expect(tomb.deedAssetId).not.toBeNull();
    expect(tomb.keepLevel).toBe(1);
    // The dormant (already inactive) base: emptied, nothing to deactivate, parcel kept.
    const d = await retireScriptedDeedBase(db, dormant.wallet);
    expect(d).toMatchObject({ parcelsKept: 1, basesDeactivated: 0 });
    expect(await db.select().from(buildings).where(eq(buildings.playerWallet, dormant.wallet))).toHaveLength(0);
    // Idempotent; the others are untouched.
    expect(await retireScriptedDeedBase(db, bot.wallet)).toBeNull();
    for (const w of [named.wallet, returned.wallet, twoSessions.wallet]) {
      expect((await db.select().from(bases).where(eq(bases.ownerWallet, w)))[0]!.status).toBe('active');
      expect((await db.select().from(buildings).where(eq(buildings.playerWallet, w))).length).toBeGreaterThan(0);
    }
  });
});
