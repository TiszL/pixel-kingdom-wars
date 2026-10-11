/** Visual realm is persisted independently of simulator snapshots and frozen
 * from the defender, including reconnect/replay after a later location change. */
import { CURRENT_BASE_VISUAL, DEFAULT_BASE_VISUAL, REALM_IDS, currentBaseVisualForRealm, type RealmId, baseGroundPath, renderGroundPixels } from '@shardkeep/shared/baseVisual';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import Fastify from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { baseArmy, bases, players, raids } from '../src/db/schema';
import { ensureStartingBase, getBaseState } from '../src/game/base';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { renderBaseGroundPng } from '../src/game/baseRender';
import { resolveBaseVisual } from '../src/game/baseVisual';
import { getLiveRaidCommands } from '../src/game/liveRaids';
import { createCampaignRaid, createRaid, getPendingRaidResume, getReplay } from '../src/game/raids';
import { registerGameRoutes } from '../src/game/routes';
import { bootstrapSystemAccounts } from '../src/ledger';
import { fantasyBaseFixture } from './fantasy-fixtures';
import { isolatedFantasyTestDb } from './fantasy-test-db';
import { SEAL_BOUND_SHARED_DB_CASE_MS } from './sealLatencyBudgets';

// The native allocator has its own integration suite and immutable tile guards.
// Inject its read result to exercise every consumer without inventing a deed
// relocation operation or weakening those guards in this rendering test.
const realms = vi.hoisted(() => new Map<string, RealmId>());
vi.mock('../src/game/baseVisual', async importOriginal => {
  const original = await importOriginal<typeof import('../src/game/baseVisual')>();
  return { ...original, resolveBaseVisual: async (database: Parameters<typeof original.resolveBaseVisual>[0], baseId?: string | null) =>
    baseId && realms.has(baseId) ? currentBaseVisualForRealm(realms.get(baseId)!)
      : original.resolveBaseVisual(database, baseId) };
});

const conn = isolatedFantasyTestDb();
const db = conn.db;
const priorMulti = process.env['MULTI_BASE_ENABLED'];
const authority = async () => {};
beforeAll(async () => { await conn.prepare(); await bootstrapSystemAccounts(db); process.env['MULTI_BASE_ENABLED'] = 'true'; });
afterAll(async () => {
  if (priorMulti === undefined) delete process.env['MULTI_BASE_ENABLED'];
  else process.env['MULTI_BASE_ENABLED'] = priorMulti;
  await conn.dispose();
});
async function readyBase(realmId: RealmId) {
  const p = await fantasyBaseFixture(db, { installClaim: true });
  await db.update(players).set({ entryPaidAt: p.now, keepLevel: 5 }).where(eq(players.wallet, p.wallet));
  await db.update(bases).set({ keepLevel: 5 }).where(eq(bases.id, p.baseId));
  await ensureStartingBase(db, p.wallet, p.baseId);
  realms.set(p.baseId, realmId);
  await db.insert(baseArmy).values({ baseId: p.baseId, troop: 'plunderer', count: 1 });
  return p;
}

describe.sequential('persisted and frozen base terrain', () => {
  it.each(['frostveil', 'crownlands'] as const)('defaults unassigned land and freezes %s across reconnect and replay', async realmId => {
    const unplotted = await fantasyBaseFixture(db);
    expect(await resolveBaseVisual(db, unplotted.baseId)).toEqual(CURRENT_BASE_VISUAL);
    const attacker = await readyBase('sunscar');
    const defender = await readyBase(realmId);
    const frost = currentBaseVisualForRealm(realmId);
    expect((await getBaseState(db, attacker.wallet, new Date(), attacker.baseId)).visualContext.realmId).toBe('sunscar');
    expect((await getBaseState(db, defender.wallet, new Date(), defender.baseId)).visualContext).toEqual(frost);
    await rewardBaseShards(db, attacker.baseId, 100_000n, 'test.visual-budget', randomUUID());
    const raid = await createRaid(db, attacker.wallet, {
      attackerBaseId: attacker.baseId, defenderBaseId: defender.baseId,
      defenderWallet: defender.wallet, idempotencyKey: randomUUID(),
      authorizeAttackerBase: authority, authorizeDefenderBase: authority,
      raidProtocolVersion: 2, allowRaidProtocolV2: true,
    });
    expect(raid.visualContext).toEqual(frost);
    const originalSnapshot = JSON.stringify(raid.snapshot);
    expect(raid.snapshot).not.toHaveProperty('visualContext');
    // Test-only location change: the same battle must not repaint to today's
    // deed location when resuming or viewing it later.
    realms.set(defender.baseId, 'elderwood');
    expect((await resolveBaseVisual(db, defender.baseId)).realmId).toBe('elderwood');
    const resume = await getPendingRaidResume(db, attacker.wallet, raid.id);
    const live = await getLiveRaidCommands(db, attacker.wallet, raid.id);
    expect(resume?.visualContext).toEqual(frost);
    expect(live.visualContext).toEqual(frost);
    expect(JSON.stringify(resume?.snapshot)).toBe(originalSnapshot);
    await db.update(raids).set({ status: 'resolved' }).where(eq(raids.id, raid.id));
    expect((await getReplay(db, attacker.wallet, raid.id)).visualContext).toEqual(frost);
    const frozenV1 = { ...DEFAULT_BASE_VISUAL, realmId: 'frostveil' as const };
    await db.update(raids).set({ visualContext: frozenV1 }).where(eq(raids.id, raid.id));
    expect((await getReplay(db, attacker.wallet, raid.id)).visualContext).toEqual(frozenV1);
    // The additive constraint accepts both known art versions, while malformed
    // or future contexts cannot silently enter permanent replay history.
    for (const bad of [{ ...frost, artVersion: 3 }, { ...frost, artVersion: '2' },
      { ...frost, version: 2 }, { ...frost, realmId: 'unknown' }, { version: 1 }, []]) {
      await expect(db.execute(sql`UPDATE raids SET visual_context = ${JSON.stringify(bad)}::jsonb WHERE id = ${raid.id}`))
        .rejects.toThrow();
    }
    expect((await getReplay(db, attacker.wallet, raid.id)).visualContext).toEqual(frozenV1);
    await db.update(raids).set({ visualContext: null }).where(eq(raids.id, raid.id));
    const historical = await getReplay(db, attacker.wallet, raid.id);
    expect(historical.visualContext).toEqual(DEFAULT_BASE_VISUAL);
    expect(JSON.stringify(historical.snapshot)).toBe(originalSnapshot);
  }, SEAL_BOUND_SHARED_DB_CASE_MS);

  it('previews only unlocked campaign stages without creating a raid and freezes chapter terrain', async () => {
    const attacker = await readyBase('frostveil');
    const app = Fastify();
    app.decorate('authenticate', async (req: { wallet: string }) => { req.wallet = attacker.wallet; });
    app.decorate('authenticateLoginRecovery', app.authenticate);
    app.decorate('requireLandOwned', async () => undefined);
    app.decorateRequest('wallet', '');
    registerGameRoutes(app as never, db);
    await app.ready();
    const before = await db.select().from(raids).where(eq(raids.attackerWallet, attacker.wallet));
    // The selected-base guard is retained; only the ownership checker is injected
    // for the test wallet, as in the existing stable-base raid service tests.
    process.env['MULTI_BASE_ENABLED'] = 'false';
    try {
      const preview = await app.inject({ method: 'GET', url: '/campaign/1/preview' });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json()).toMatchObject({ stage: 1, visualContext: CURRENT_BASE_VISUAL });
      expect(preview.json().snapshot).not.toHaveProperty('visualContext');
      expect((await app.inject({ method: 'GET', url: '/campaign/2/preview' })).statusCode).toBe(422);
      expect((await app.inject({ method: 'GET', url: '/campaign/101/preview' })).statusCode).toBe(404);
      expect(await db.select().from(raids).where(eq(raids.attackerWallet, attacker.wallet))).toEqual(before);
    } finally { process.env['MULTI_BASE_ENABLED'] = 'true'; await app.close(); }
    const raid = await createCampaignRaid(db, attacker.wallet, 1, randomUUID(), new Date(), {
      attackerBaseId: attacker.baseId, authorizeAttackerBase: authority,
    });
    expect(raid.visualContext).toEqual(CURRENT_BASE_VISUAL);
    expect(raid.snapshot).not.toHaveProperty('visualContext');
  });

  it('preserves every historical painted realm and Crownlands correction on Phaser and deed crops', async () => {
    const contexts = [1, 2].flatMap(artVersion => REALM_IDS.map(realmId => ({
      version: 1 as const, realmId, artVersion: artVersion as 1 | 2,
    })));
    const frozenClearing = { version: 1, realmId: 'crownlands', artVersion: 2, groundRevision: 1 } as const;
    for (const context of [...contexts, frozenClearing]) {
      const realmId = context.realmId;
      const filename = path.join(process.cwd(), '../../apps/web/public', baseGroundPath(context));
      const { data, info } = await sharp(await readFile(filename)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      // Include the corrected Crownlands region; this is also the source used by the
      // scene canvas, so a different server sampling/offset fails visibly here.
      const source = { data, width: info.width, height: info.height };
      for (const [originX, originY] of [[-24, -12], [600, 240]] as const) {
        const expected = renderGroundPixels(source, context, 144, 144, originX, originY);
        const actual = await sharp(await renderBaseGroundPng(context, 144, originX, originY)).raw().toBuffer();
        expect(actual.equals(Buffer.from(expected)), realmId).toBe(true);
      }
    }
  });
});
