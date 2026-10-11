import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { SIM_VERSION, simulateRaid } from '@shardkeep/sim';
import { RAID_RULES } from '@shardkeep/shared';
import { CURRENT_BASE_VISUAL, DEFAULT_BASE_VISUAL, REALM_IDS, currentBaseVisualForRealm, type BaseVisualContext } from '@shardkeep/shared/baseVisual';
import { bases, raids, raidLiveStates, raidCommands, raidReplayTimelines } from '../src/db/schema';
import { initializeBatchRaidJournal, initializeLiveRaid, acceptLiveRaidCommand, getLiveRaidCommands, getRaidClock, retreatLiveRaid, startLiveRaid, setLiveRaidSpeed } from '../src/game/liveRaids';
import { getParticipantBattleReplay, recordBaseBattle } from '../src/game/baseBattleHistory';
import { encodeReplayTimeline, persistReplayTimeline } from '../src/game/raidReplayArchive';
import { getReplay } from '../src/game/raids';
import { loadNativePresentation } from '../src/native/source';
import { registerNativeRoutes } from '../src/native/routes';
import { NativeCapabilitiesSchema, NativePresentationSchema, NativePresentationPageSchema } from '../src/native/contracts';
import { HttpError } from '../src/lib/errors';
import { loadConfig } from '../src/config';
import { buildApp } from '../src/app';
import { connectTestDb, createTestPlayer, insertActiveTestBase, TEST_CONFIG } from './helpers';

const conn = connectTestDb(); const db = conn.db;
const apps: FastifyInstance[] = [];
const previousMultiBase = process.env['MULTI_BASE_ENABLED'];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  if (previousMultiBase === undefined) delete process.env['MULTI_BASE_ENABLED'];
  else process.env['MULTI_BASE_ENABLED'] = previousMultiBase;
});
afterAll(async () => { await conn.sql.end(); });

/** `createdAt` backdates the raid AT INSERTION (default: now). Since D153.235
 * (0284) the starter capture freezes created_at, so a later UPDATE of it is
 * refused as RAID_STARTER_ORIGINAL_SOURCE on every presentation read. */
async function fixture(started = false, batch = false, visualContext?: BaseVisualContext, createdAt = new Date()) {
  const attacker = await createTestPlayer(db); const defender = await createTestPlayer(db);
  const attackBase = await insertActiveTestBase(db, { ownerWallet: attacker.wallet, status: 'active', keepLevel: 5 });
  const defendBase = await insertActiveTestBase(db, { ownerWallet: defender.wallet, status: 'active', keepLevel: 5 });
  const now = createdAt;
  const [raid] = await db.insert(raids).values({
    idempotencyKey: `native-${randomUUID()}`, attackerWallet: attacker.wallet,
    defenderWallet: defender.wallet, attackerBaseId: attackBase!.id, defenderBaseId: defendBase!.id,
    seed: 7n, simVersion: SIM_VERSION, createdAt: now,
    ...(visualContext ? { visualContext } : {}),
    ordersDeadlineAt: new Date(now.getTime() + 120_000),
    snapshot: { keepLevel: 5, claimMin: 8, claimMax: 22, surplusShards: 0,
      buildings: [{ id: 'keep', type: 'keep', level: 5, tx: 14, ty: 14 }] },
    armySnapshot: { counts: { highlander: 3 }, levels: { highlander: 2 }, heroes: [], attackerKeepLevel: 5 },
  }).returning();
  if (batch) await initializeBatchRaidJournal(db, raid!.id, now, 2);
  else await initializeLiveRaid(db, raid!.id, defendBase!.id, raid!.ordersDeadlineAt, now, 2);
  if (started) {
    await acceptLiveRaidCommand(db, attacker.wallet, raid!.id, randomUUID(),
      { kind: 'deploy', payload: { troop: 'highlander', tx: -1, ty: 14 } }, now);
    const { clock } = await getRaidClock(db, raid!.id, now);
    await startLiveRaid(db, attacker.wallet, raid!.id, randomUUID(), clock.revision, now);
  }
  return { attacker, defender, attackBase: attackBase!, defendBase: defendBase!, raid: raid! };
}

/** HTTP transport tests inject only identity; the real source performs the
 * database authorization. buildApp tests separately pin real session wiring. */
async function routeApp(wallet: string, enabled = true, allowed = () => true) {
  const app = Fastify(); apps.push(app);
  app.decorateRequest('wallet', '');
  app.decorate('authenticate', async (req) => {
    if (!allowed()) throw new HttpError(401, 'session revoked');
    req.wallet = wallet;
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof HttpError) return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    throw error;
  });
  registerNativeRoutes(app, { ...TEST_CONFIG, NATIVE_PRESENTATION_ENABLED: enabled ? 'true' : 'false', NATIVE_PRESENTATION_OPEN: 'true' }, db);
  await app.ready(); return app;
}

describe('native presentation routes', () => {
  const visualContexts: Array<BaseVisualContext | undefined> = [
    undefined, { ...DEFAULT_BASE_VISUAL },
    { version: 1, realmId: 'crownlands', artVersion: 2 },
    { version: 1, realmId: 'crownlands', artVersion: 2, groundRevision: 1 },
    ...REALM_IDS.map(currentBaseVisualForRealm), { version: 1, realmId: 'elderwood', artVersion: 2 },
    ...REALM_IDS.map((realmId): BaseVisualContext => ({ version: 1, realmId, artVersion: 2, groundRevision: 3 })),
  ];

  it.each(visualContexts)('preserves frozen live ground identity through both native transports: %j', async (context) => {
    const f = await fixture(false, false, context);
    const app = await routeApp(f.attacker.wallet);
    const expected = context ?? DEFAULT_BASE_VISUAL;
    const p1 = NativePresentationSchema.parse((await app.inject(`/raids/${f.raid.id}/presentation`)).json());
    const p2 = NativePresentationPageSchema.parse((await app.inject(`/raids/${f.raid.id}/presentation?protocolVersion=2`)).json());
    expect(p1.visualContext).toEqual(expected);
    expect(p2.state?.visualContext).toEqual(expected);
    expect(p1.snapshot).not.toHaveProperty('visualContext');
    expect(p1.snapshot).not.toHaveProperty('groundRevision');
  });

  it('serves a frozen revision-5 raid as revision 4 to a renderer below the realm-kit contract, unchanged to a current one (E-12)', async () => {
    const kit = { version: 1, realmId: 'thornwake', artVersion: 2, groundRevision: 5 } as const;
    const published = { ...kit, groundRevision: 4 } as const;
    const f = await fixture(false, false, kit);
    const app = await routeApp(f.attacker.wallet);
    const read = async (headers: Record<string, string>) => ({
      p1: NativePresentationSchema.parse((await app.inject({ url: `/raids/${f.raid.id}/presentation`, headers })).json()),
      p2: NativePresentationPageSchema.parse((await app.inject({ url: `/raids/${f.raid.id}/presentation?protocolVersion=2`, headers })).json()),
    });
    const old = await read({ 'x-pkw-client': 'android-native' });
    expect(old.p1.visualContext).toEqual(published);
    expect(old.p2.state?.visualContext).toEqual(published);
    const current = await read({ 'x-pkw-client': 'android-native', 'x-pkw-renderer-contract': '15' });
    expect(current.p1.visualContext).toEqual(kit);
    expect(current.p2.state?.visualContext).toEqual(kit);
    // Presentation only: one journal revision for both renderers, the frozen row untouched.
    expect(old.p1.revision).toBe(current.p1.revision);
    expect((await db.select({ visualContext: raids.visualContext }).from(raids).where(eq(raids.id, f.raid.id)))[0]?.visualContext).toEqual(kit);
    expect(old.p1.snapshot).toEqual(current.p1.snapshot);
  });

  it('changes transport identity for a ground revision without changing simulation input or its cache key', async () => {
    const f = await fixture(true, false, { version: 1, realmId: 'crownlands', artVersion: 2 });
    const before = await loadNativePresentation(db, f.attacker.wallet, f.raid.id);
    await db.update(raids).set({ visualContext: { ...CURRENT_BASE_VISUAL } }).where(eq(raids.id, f.raid.id));
    const after = await loadNativePresentation(db, f.attacker.wallet, f.raid.id);
    expect(after.revision).not.toBe(before.revision);
    expect(after.simulationKey).toBe(before.simulationKey);
    expect(after.input).toEqual(before.input);
  });

  it('serializes canonical live database timestamps before validating transport2 pages', async () => {
    // A resolved archive has no clock/journal Dates; only a real live source
    // catches an early DTO parse rejecting values Fastify would serialize.
    const f = await fixture(true);
    const app = await routeApp(f.attacker.wallet);
    const legacyResponse = await app.inject(`/raids/${f.raid.id}/presentation`);
    expect(legacyResponse.statusCode).toBe(200);
    const legacy = NativePresentationSchema.parse(legacyResponse.json());
    const response = await app.inject(`/raids/${f.raid.id}/presentation?protocolVersion=2`);
    expect(response.statusCode).toBe(200);
    const page = NativePresentationPageSchema.parse(response.json());
    expect(page.state?.clock?.anchorWallAt).toBe(legacy.clock?.anchorWallAt);
    expect(page.state?.clock?.battleEndsAt).toBe(legacy.clock?.battleEndsAt);
    expect(Number.isFinite(Date.parse(page.state!.clock!.serverNow))).toBe(true);
    expect(page.commands).toEqual(legacy.commands);
    expect(page.events).toEqual(legacy.events);
    expect(legacy.buildingHealth?.map(({ id }) => id)).toEqual(['keep']);
    expect(page.state?.buildingHealth).toEqual(legacy.buildingHealth);
    expect(page.state?.commands).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('stays dark by default and retains real session authentication when enabled', async () => {
    process.env['MULTI_BASE_ENABLED'] = 'false';
    const dark = await buildApp(TEST_CONFIG, db); apps.push(dark);
    const capabilities = NativeCapabilitiesSchema.parse((await dark.inject('/native/capabilities')).json());
    expect(capabilities.presentation.enabled).toBe(false);
    // Stable prefixes are an opt-in transport-2 capability; default requests
    // below retain transport 1's complete replacement response.
    expect(capabilities.presentation.supportsStablePrefix).toBe(true);
    expect(capabilities.presentation.protocolVersions).toEqual([1, 2]);
    expect((await dark.inject(`/raids/${randomUUID()}/presentation`)).statusCode).toBe(503);
    const enabled = await buildApp({ ...TEST_CONFIG, NATIVE_PRESENTATION_ENABLED: 'true', NATIVE_PRESENTATION_OPEN: 'true' }, db); apps.push(enabled);
    expect((await enabled.inject(`/raids/${randomUUID()}/presentation`)).statusCode).toBe(401);
  });

  it('checks participants before reading cache and rechecks defender transfer ownership', async () => {
    const f = await fixture();
    const outsider = await createTestPlayer(db);
    await expect(loadNativePresentation(db, outsider.wallet, f.raid.id)).rejects.toMatchObject({ statusCode: 404 });
    expect((await loadNativePresentation(db, f.defender.wallet, f.raid.id)).envelope.source).toBe('live');
    await db.update(bases).set({ ownerWallet: outsider.wallet }).where(eq(bases.id, f.defendBase.id));
    await expect(loadNativePresentation(db, f.defender.wallet, f.raid.id)).rejects.toMatchObject({ statusCode: 404 });
    expect((await loadNativePresentation(db, outsider.wallet, f.raid.id)).envelope.source).toBe('live');
  });

  it('returns schema-valid exact SIM events and no speculative reward, then 204 for unchanged revisions', async () => {
    const f = await fixture(true); const app = await routeApp(f.attacker.wallet);
    const response = await app.inject(`/raids/${f.raid.id}/presentation`);
    expect(response.statusCode).toBe(200);
    const packet = NativePresentationSchema.parse(response.json());
    const source = await loadNativePresentation(db, f.attacker.wallet, f.raid.id);
    const input = source.input!;
    expect(packet.events).toEqual(simulateRaid(input.snapshot, input.orders, input.seed, input.options).events);
    expect(packet.result).toBeNull(); expect(packet.replaceFromTick).toBe(0);
    expect(packet.lastSequence).toBe(1);
    const unchanged = await app.inject(`/raids/${f.raid.id}/presentation?afterRevision=${packet.revision}&waitMs=10`);
    expect(unchanged.statusCode).toBe(204);
    expect(unchanged.body).toBe('');
  });

  it('keeps clock-only controls out of the worker cache key and changes the transport revision', async () => {
    const f = await fixture(true);
    const before = await loadNativePresentation(db, f.attacker.wallet, f.raid.id);
    await setLiveRaidSpeed(db, f.attacker.wallet, f.raid.id, randomUUID(), before.envelope.clock!.revision, 2, true);
    const after = await loadNativePresentation(db, f.attacker.wallet, f.raid.id);
    expect(after.simulationKey).toBe(before.simulationKey);
    expect(after.revision).not.toBe(before.revision);
    expect(after.envelope.clock!.rate).toBe(2);
  });

  it('keeps protocol-2 batch preparation idle until its canonical ATTACK start', async () => {
    const f = await fixture(false, true);
    await acceptLiveRaidCommand(db, f.attacker.wallet, f.raid.id, randomUUID(),
      { kind: 'deploy', payload: { troop: 'highlander', tx: -1, ty: 14 } });
    const staged = await loadNativePresentation(db, f.attacker.wallet, f.raid.id);
    expect(staged.input).toBeNull(); expect(staged.events).toEqual([]);
    expect(staged.envelope.clock!.anchorWallAt).toBeNull();
    await startLiveRaid(db, f.attacker.wallet, f.raid.id, randomUUID(), staged.envelope.clock!.revision);
    const started = await loadNativePresentation(db, f.attacker.wallet, f.raid.id);
    expect(started.input!.orders.deploys).toEqual([{ troop: 'highlander', tx: -1, ty: 14, tMs: 0 }]);
    expect(started.envelope.clock!.anchorWallAt).not.toBeNull();
    expect(started.revision).not.toBe(staged.revision);
  });

  it('observes overdue scheduled starts without becoming a new deployment writer while web reads still reconcile', async () => {
    // Overdue from creation: the raid is inserted already older than the deploy
    // window and its deploy is accepted at creation time, instead of rewriting
    // created_at afterwards (frozen by the D153.235 capture).
    const createdAt = new Date(Date.now() - (RAID_RULES.deployWindowSec + 1) * 1_000);
    const f = await fixture(false, true, undefined, createdAt);
    await acceptLiveRaidCommand(db, f.attacker.wallet, f.raid.id, randomUUID(),
      { kind: 'deploy', payload: { troop: 'highlander', tx: -1, ty: 14 } }, createdAt);
    const persisted = () => Promise.all([
      db.select().from(raids).where(eq(raids.id, f.raid.id)),
      db.select().from(raidLiveStates).where(eq(raidLiveStates.raidId, f.raid.id)),
      db.select().from(raidCommands).where(eq(raidCommands.raidId, f.raid.id)).orderBy(raidCommands.sequence),
    ]);
    const before = await persisted();
    const native = await loadNativePresentation(db, f.attacker.wallet, f.raid.id);
    expect(native.input).toBeNull();
    expect(native.envelope.clock!.anchorWallAt).toBeNull();
    expect(native.envelope.commands.map((command) => command.kind)).toEqual(['deploy']);
    expect(await persisted()).toEqual(before);
    // Native HTTP polling exercises the same observation option on every reread.
    const app = await routeApp(f.attacker.wallet);
    const response = await app.inject(`/raids/${f.raid.id}/presentation?protocolVersion=2`);
    expect(response.statusCode).toBe(200);
    expect(response.json().state.clock.anchorWallAt).toBeNull();
    expect(await persisted()).toEqual(before);
    // The existing web default still owns its established automatic-start behavior.
    const web = await getLiveRaidCommands(db, f.attacker.wallet, f.raid.id);
    expect(web.startedAt).toEqual(new Date(createdAt.getTime() + RAID_RULES.deployWindowSec * 1_000));
    expect(web.commands.at(-1)?.clientCommandId).toBe('system:auto-start');
    expect((await loadNativePresentation(db, f.attacker.wallet, f.raid.id)).input).not.toBeNull();
  });

  it('preserves presentation while the settlement worker holds a resolving raid', async () => {
    const f = await fixture(true);
    const before = await loadNativePresentation(db, f.attacker.wallet, f.raid.id);
    await db.update(raids).set({ status: 'resolving' }).where(eq(raids.id, f.raid.id));
    const resolving = await loadNativePresentation(db, f.attacker.wallet, f.raid.id);
    expect(resolving.envelope.status).toBe('resolving');
    expect(resolving.input).toEqual(before.input);
    expect(resolving.simulationKey).toBe(before.simulationKey);
  });

  it('returns the persisted pre-start retreat receipt without requiring a battle archive', async () => {
    process.env['MULTI_BASE_ENABLED'] = 'true';
    const f = await fixture(false, true, { ...CURRENT_BASE_VISUAL });
    const receipt = await retreatLiveRaid(db, f.attacker.wallet, f.raid.id, randomUUID());
    expect(receipt.terminal).toBe(true);
    const app = await routeApp(f.attacker.wallet);
    const response = await app.inject(`/raids/${f.raid.id}/presentation`);
    expect(response.statusCode).toBe(200);
    const packet = NativePresentationSchema.parse(response.json());
    expect(packet.status).toBe('resolved'); expect(packet.events).toEqual([]);
    expect(packet.result).toEqual(receipt.result);
    expect(packet.visualContext).toEqual(CURRENT_BASE_VISUAL);
    const page = NativePresentationPageSchema.parse((await app.inject(`/raids/${f.raid.id}/presentation?protocolVersion=2`)).json());
    expect(page.state?.visualContext).toEqual(CURRENT_BASE_VISUAL);
    const outsider = await createTestPlayer(db);
    await expect(loadNativePresentation(db, outsider.wallet, f.raid.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('reauthenticates after waiting and releases its per-wallet request slots', async () => {
    const f = await fixture(); let allowed = true;
    let polling = false; let pollAuthChecks = 0;
    let enteredPoll!: () => void;
    const pollEntered = new Promise<void>((resolve) => { enteredPoll = resolve; });
    const app = await routeApp(f.attacker.wallet, true, () => {
      // The pre-handler admits the request; the second check owns a stream slot.
      if (polling && ++pollAuthChecks === 2) enteredPoll();
      return allowed;
    });
    const packet = (await app.inject(`/raids/${f.raid.id}/presentation`)).json();
    // A slow CI database read must not exhaust the deadline before the route
    // waits. Keep real timers, but make the deadline deterministic for this poll.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    polling = true;
    try {
      const pending = Promise.resolve(app.inject(`/raids/${f.raid.id}/presentation?afterRevision=${packet.revision}&waitMs=100`));
      await pollEntered;
      allowed = false;
      expect((await pending).statusCode).toBe(401);
      expect(pollAuthChecks).toBe(3);
    } finally {
      clock.mockRestore();
      polling = false;
    }
    allowed = true;
    expect((await app.inject(`/raids/${f.raid.id}/presentation`)).statusCode).toBe(200);
  });

  it('limits wait/cursor input and refuses mismatched live SIM rows', async () => {
    const f = await fixture(); const app = await routeApp(f.attacker.wallet);
    expect((await app.inject(`/raids/${f.raid.id}/presentation?waitMs=15001`)).statusCode).toBe(400);
    expect((await app.inject(`/raids/${f.raid.id}/presentation?afterRevision=bad`)).statusCode).toBe(400);
    await db.update(raids).set({ simVersion: SIM_VERSION - 1 }).where(eq(raids.id, f.raid.id));
    expect((await app.inject(`/raids/${f.raid.id}/presentation`)).statusCode).toBe(426);
    await db.update(raids).set({ simVersion: SIM_VERSION }).where(eq(raids.id, f.raid.id));
    await db.update(raidLiveStates).set({ commandProtocolVersion: 1 }).where(eq(raidLiveStates.raidId, f.raid.id));
    const legacy = await app.inject(`/raids/${f.raid.id}/presentation`);
    expect(legacy.statusCode).toBe(426);
    expect(legacy.json().error.code).toBe('NATIVE_RAID_PROTOCOL_UNSUPPORTED');
  });

  it('bounds concurrent long polls per wallet and releases slots after timeout', async () => {
    const f = await fixture(); const app = await routeApp(f.attacker.wallet);
    const packet = (await app.inject(`/raids/${f.raid.id}/presentation`)).json();
    const url = `/raids/${f.raid.id}/presentation?afterRevision=${packet.revision}&waitMs=250`;
    const one = Promise.resolve(app.inject(url)); const two = Promise.resolve(app.inject(url));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await app.inject(url)).statusCode).toBe(503);
    expect((await one).statusCode).toBe(204); expect((await two).statusCode).toBe(204);
    expect((await app.inject(`/raids/${f.raid.id}/presentation`)).statusCode).toBe(200);
  });

  it.each(visualContexts)('preserves archived events and frozen ground after a deed sale: %j', async (context) => {
    process.env['MULTI_BASE_ENABLED'] = 'true';
    const f = await fixture(); const buyer = await createTestPlayer(db);
    const archived = {
      snapshot: f.raid.snapshot, armySnapshot: f.raid.armySnapshot,
      ...(context ? { visualContext: context } : {}),
      // The early victory has no hero deploy event, but accepted future hero
      // gear still contributes to troop HP from tick zero in the simulator.
      orders: { deploys: [], heroDeploys: [{ hero: 'theodor', tx: -1, ty: 0, tMs: 80_000 }] },
      seed: Number(f.raid.seed), simVersion: SIM_VERSION - 1,
      events: [{ t: 0, e: 'star' as const, n: 1 as const }], result: { lootShards: '9007199254740993' },
    };
    await db.update(raids).set({ status: 'resolved', resolvedAt: new Date() }).where(eq(raids.id, f.raid.id));
    await recordBaseBattle(db, { raidId: f.raid.id, attackerBaseId: f.attackBase.id,
      attackerOwnerWallet: f.attacker.wallet, stars: 1, destructionPct: 50, lootShards: 0n });
    await persistReplayTimeline(db, f.raid.id, archived, 100);
    await db.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, f.attackBase.id));
    const app = await routeApp(f.attacker.wallet);
    const response = await app.inject(`/raids/${f.raid.id}/presentation`);
    expect(response.statusCode).toBe(200);
    const packet = NativePresentationSchema.parse(response.json());
    expect(packet.events).toEqual(archived.events); expect(packet.simVersion).toBe(SIM_VERSION - 1);
    expect(packet.result).toMatchObject({ lootShards: '9007199254740993' });
    expect(packet.buildingHealth).toBeUndefined();
    expect(packet.orders).toEqual({ heroDeploys: archived.orders.heroDeploys });
    expect(packet.visualContext).toEqual(context ?? DEFAULT_BASE_VISUAL);
    const page = NativePresentationPageSchema.parse((await app.inject(`/raids/${f.raid.id}/presentation?protocolVersion=2`)).json());
    expect(page.state?.visualContext).toEqual(context ?? DEFAULT_BASE_VISUAL);
    expect(page.state?.orders).toEqual(packet.orders);
    expect(packet.snapshot).not.toHaveProperty('surplusShards');
    await expect(loadNativePresentation(db, buyer.wallet, f.raid.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('forwards newly frozen archive health only to authorized native participants without changing web results', async () => {
    process.env['MULTI_BASE_ENABLED'] = 'true';
    const f = await fixture(); const buyer = await createTestPlayer(db);
    // Deliberately unlike current Keep stats: this must use the archived value,
    // not silently recompute history from today's catalogue.
    const health = [{ id: 'keep', initialHp: 987654, maxHp: 987654 }];
    const archived = {
      snapshot: f.raid.snapshot, armySnapshot: f.raid.armySnapshot,
      orders: { deploys: [] }, seed: Number(f.raid.seed), simVersion: SIM_VERSION,
      events: [{ t: 0, e: 'star' as const, n: 1 as const }],
      result: { stars: 1, lootShards: '123' }, buildingHealth: health,
    };
    await db.update(raids).set({ status: 'resolved', resolvedAt: new Date() }).where(eq(raids.id, f.raid.id));
    await recordBaseBattle(db, { raidId: f.raid.id, attackerBaseId: f.attackBase.id,
      attackerOwnerWallet: f.attacker.wallet, stars: 1, destructionPct: 50, lootShards: 0n });
    await persistReplayTimeline(db, f.raid.id, archived, 100);
    await db.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, f.attackBase.id));
    const ordinary = await getParticipantBattleReplay(db, f.attacker.wallet, f.raid.id);
    expect(ordinary).not.toHaveProperty('buildingHealth');
    expect(ordinary.result).toEqual({ ...archived.result, lootRedacted: false });
    const app = await routeApp(f.attacker.wallet);
    const p1 = NativePresentationSchema.parse((await app.inject(`/raids/${f.raid.id}/presentation`)).json());
    const p2 = NativePresentationPageSchema.parse((await app.inject(`/raids/${f.raid.id}/presentation?protocolVersion=2`)).json());
    expect(p1.buildingHealth).toEqual(health);
    expect(p2.state?.buildingHealth).toEqual(health);
    expect(p1.result).toEqual(ordinary.result);
    expect(p1.snapshot).not.toHaveProperty('surplusShards');
    expect(p1.events).toEqual(archived.events);
    await expect(loadNativePresentation(db, buyer.wallet, f.raid.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it.each([
    [{ id: 'keep', initialHp: 1, maxHp: -1 }],
    [{ id: 'keep', initialHp: 1, maxHp: 1 }, { id: 'keep', initialHp: 1, maxHp: 1 }],
  ])('reports malformed frozen archive health as an integrity conflict on both authorized native paths', async (...entries) => {
    process.env['MULTI_BASE_ENABLED'] = 'true';
    const f = await fixture();
    await db.update(raids).set({ status: 'resolved', resolvedAt: new Date() }).where(eq(raids.id, f.raid.id));
    await recordBaseBattle(db, { raidId: f.raid.id, attackerBaseId: f.attackBase.id,
      attackerOwnerWallet: f.attacker.wallet, stars: 0, destructionPct: 0, lootShards: 0n });
    // Correct compressed hash, invalid semantic metadata: this must share the
    // ordinary integrity failure response rather than surface an internal500.
    const encoded = encodeReplayTimeline({ snapshot: f.raid.snapshot, armySnapshot: f.raid.armySnapshot,
      orders: { deploys: [] }, seed: Number(f.raid.seed), simVersion: SIM_VERSION,
      events: [], result: {}, buildingHealth: entries }, 0);
    await db.insert(raidReplayTimelines).values({ raidId: f.raid.id, ...encoded });
    const app = await routeApp(f.attacker.wallet);
    for (const query of ['', '?protocolVersion=2']) {
      const response = await app.inject(`/raids/${f.raid.id}/presentation${query}`);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.message).toBe('replay archive failed its integrity check');
    }
    await expect(getReplay(db, f.attacker.wallet, f.raid.id, true))
      .rejects.toMatchObject({ statusCode: 409, message: 'replay archive failed its integrity check' });
  });

  it('validates capacity config and permits an empty manifest placeholder', () => {
    const required = { DATABASE_URL: TEST_CONFIG.DATABASE_URL, JWT_SECRET: TEST_CONFIG.JWT_SECRET, WEB_ORIGIN: 'http://localhost:5173', NODE_ENV: 'test' };
    expect(loadConfig({ ...required, NATIVE_CONTENT_MANIFEST_URL: '' }).NATIVE_CONTENT_MANIFEST_URL).toBeUndefined();
    expect(() => loadConfig({ ...required, NATIVE_PRESENTATION_WORKERS: '99' })).toThrow();
    expect(() => loadConfig({ ...required, NATIVE_CONTENT_MANIFEST_URL: 'http://example.com/pack.json' })).toThrow();
  });
});
