import { randomUUID } from 'node:crypto';
import { BuildingType, HEROES, HERO_KEYS } from '@shardkeep/shared';
import { HeroRecruitmentReceiptSchema, HeroRecruitmentStatusSchema, type HeroRecruitmentRequest } from '@shardkeep/shared/heroRecruitment';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, LOGIN_COOKIE, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import type { Db, DbTx } from '../src/db/client';
import { baseDailyActivity, baseItems, bases, baseSlots, builderJobs, buildings, heroRecruitmentCommands, itemUses, ledgerEntries, ledgerTransactions, obstacles, playerItems, players, sessions } from '../src/db/schema';
import { completeDueJobs, placeBuilding, type StableBaseMutationContext } from '../src/game/base';
import { assertFreshLockedBaseAuthority, transferStableBase } from '../src/game/baseOwnership';
import { getConstructionReceipt } from '../src/game/constructionReceipt';
import { recruitedHeroesOf } from '../src/game/heroes';
import { executeHeroRecruitmentCommand, getHeroRecruitmentCommand, readHeroRecruitmentCommand } from '../src/game/heroRecruitment';
import { spendGameCurrency } from '../src/game/spend';
import { getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep, holdPlayerLock, randomWallet, settlesWithin, TEST_CONFIG } from './helpers';

const conn = connectTestDb(); const db = conn.db;
const flags = ['MULTI_BASE_ENABLED', 'FREE_ONBOARDING', 'HERO_RECRUITMENT_ENABLED'] as const;
const old = Object.fromEntries(flags.map(flag => [flag, process.env[flag]]));
beforeEach(() => { process.env['MULTI_BASE_ENABLED'] = 'false'; process.env['FREE_ONBOARDING'] = 'true'; process.env['HERO_RECRUITMENT_ENABLED'] = 'true'; });
afterEach(() => { for (const flag of flags) { if (old[flag] === undefined) delete process.env[flag]; else process.env[flag] = old[flag]; } });
afterAll(async () => { await conn.sql.end(); });
const now = new Date('2034-06-01T00:00:00.000Z');
async function fixture(stable = true, hero: typeof HERO_KEYS[number] = 'vex') {
  const { wallet } = await createTestPlayer(db);
  await db.update(players).set({ keepLevel: HEROES[hero].unlockKeepLevel, builders: 2 }).where(eq(players.wallet, wallet));
  let baseId: string | undefined;
  if (stable) {
    const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active', keepLevel: HEROES[hero].unlockKeepLevel, builders: 2, landPaidAt: now }).returning();
    baseId = base!.id; await db.insert(baseSlots).values({ wallet, baseId, slot: 1 });
  }
  const context: StableBaseMutationContext | undefined = baseId ? { baseId, assertAuthority: async (tx, actor, target) => { await assertFreshLockedBaseAuthority(tx, actor, target); } } : undefined;
  await fundTestKeep(db, wallet, BigInt(HEROES[hero].recruitCostKeep) * 3n, 'test.hero.recruit.fund', randomUUID());
  const request: HeroRecruitmentRequest = { idempotencyKey: randomUUID(), baseId: baseId ?? null, type: HEROES[hero].altar as HeroRecruitmentRequest['type'],
    tx: 8, ty: 9, heroContractOnly: false, maxCostKeep: String(HEROES[hero].recruitCostKeep) };
  return { wallet, baseId, hero, context, request, submit: (r = request) => executeHeroRecruitmentCommand(db, wallet, r, now, context) };
}
async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
  return { keep: (await getOrCreatePlayerAccount(db, f.wallet, 'player_keep')).balance,
    buildings: await db.select().from(buildings).where(eq(buildings.playerWallet, f.wallet)),
    jobs: await db.select().from(builderJobs).where(eq(builderJobs.playerWallet, f.wallet)),
    uses: await db.select().from(itemUses).where(eq(itemUses.playerWallet, f.wallet)),
    walletItems: await db.select().from(playerItems).where(eq(playerItems.playerWallet, f.wallet)),
    baseItems: f.baseId ? await db.select().from(baseItems).where(eq(baseItems.baseId, f.baseId)) : [],
    activity: f.baseId ? await db.select().from(baseDailyActivity).where(eq(baseDailyActivity.baseId, f.baseId)) : [],
  };
}
function failReceipt(mode: 'outage' | 'malformed'): Db {
  return new Proxy(db, { get(target, key) {
    if (key === 'transaction') return (run: (tx: DbTx) => Promise<unknown>) => target.transaction(tx => run(new Proxy(tx, {
      get(t, k) {
        if (k === 'insert') return (table: typeof heroRecruitmentCommands) => {
          if (table !== heroRecruitmentCommands) return t.insert(table);
          if (mode === 'outage') throw new Error('receipt storage outage');
          return { values: (value: typeof heroRecruitmentCommands.$inferInsert) => ({ returning: async () =>
            (await t.insert(table).values(value).returning()).map(row => ({ ...row, receipt: { ...(row.receipt as object), actor: 'invalid' } })),
          }) };
        };
        const value = Reflect.get(t, k); return typeof value === 'function' ? value.bind(t) : value;
      },
    })));
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
async function cookies(wallet: string) {
  const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  return { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
}

describe.sequential('accepted Hero recruitment command recovery', () => {
  for (const setting of [undefined, 'garbage', 'TRUE', 'false', 'true']) {
    it(`fresh v1 recruitment requires exact opt-in (${String(setting)}), while historical HTTP GET/POST survives`, async () => {
      const f = await fixture(); const receipt = await f.submit(); const fresh = await fixture();
      if (setting === undefined) delete process.env['HERO_RECRUITMENT_ENABLED']; else process.env['HERO_RECRUITMENT_ENABLED'] = setting;
      const app = await buildApp(TEST_CONFIG, db); const auth = await cookies(f.wallet); const freshAuth = await cookies(fresh.wallet);
      try {
        const read = await app.inject({ method: 'GET', url: `/heroes/recruit/v1/${f.request.idempotencyKey}`, cookies: auth });
        expect(read.statusCode).toBe(200); expect(HeroRecruitmentStatusSchema.parse(read.json())).toMatchObject({ enabled: setting === 'true', receipt });
        const replay = await app.inject({ method: 'POST', url: '/heroes/recruit/v1', cookies: auth, payload: f.request });
        expect(replay.statusCode).toBe(200); expect(replay.json()).toEqual(receipt);
        const before = await snapshot(fresh);
        const command = await app.inject({ method: 'POST', url: '/heroes/recruit/v1', cookies: freshAuth, payload: fresh.request });
        if (setting === 'true') expect(command.statusCode).toBe(201);
        else {
          expect(command.statusCode).toBe(503); expect(command.json().error.code).toBe('HERO_RECRUITMENT_DISABLED');
          expect(await snapshot(fresh)).toEqual(before);
          expect((await getHeroRecruitmentCommand(db, fresh.wallet, fresh.request.idempotencyKey)).receipt).toBeNull();
        }
        for (const response of [read, replay, command]) expect(response.headers['cache-control']).toBe('private, no-store');
      } finally { await app.close(); }
    });
  }
  for (const hero of HERO_KEYS) for (const mode of ['keep', 'base-contract', 'wallet-fallback', 'legacy-contract'] as const) {
    it(`${hero} ${mode}: concurrent exact retries construct once and retain the actual funding source`, async () => {
      const f = await fixture(mode !== 'legacy-contract', hero); const itemId = HEROES[hero].recruitItemId;
      if (mode === 'base-contract') {
        await db.insert(baseItems).values({ baseId: f.baseId!, itemId, qty: 1 });
        await db.insert(playerItems).values({ playerWallet: f.wallet, itemId, qty: 1 });
      } else if (mode !== 'keep') await db.insert(playerItems).values({ playerWallet: f.wallet, itemId, qty: 1 });
      const before = await snapshot(f);
      const request = mode === 'keep' ? f.request : { ...f.request, heroContractOnly: true, maxCostKeep: '0' };
      const outcomes = await Promise.all(Array.from({ length: 4 }, () => f.submit(request)));
      const receipt = HeroRecruitmentReceiptSchema.parse(outcomes[0]); outcomes.forEach(r => expect(r).toEqual(receipt));
      expect(receipt.request).toEqual(request); expect(receipt.hero).toBe(hero); expect(receipt.building.baseId).toBe(f.baseId ?? null);
      const after = await snapshot(f); expect(after.buildings).toHaveLength(1); expect(after.jobs).toHaveLength(1);
      expect(after.jobs[0]!.id).toBe(receipt.job.id); expect(after.jobs[0]!.completedAt).toBeNull();
      expect(await recruitedHeroesOf(db, f.wallet, f.baseId)).toEqual(new Set());
      if (receipt.funding.kind === 'keep') {
        expect(mode).toBe('keep'); expect(after.keep).toBe(before.keep - BigInt(HEROES[hero].recruitCostKeep)); expect(after.uses).toHaveLength(0);
        const [transaction] = await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.id, receipt.funding.ledgerTransactionId));
        expect(transaction!.type).toBe('hero.recruit');
        expect((await db.select().from(ledgerEntries).where(eq(ledgerEntries.txnId, transaction!.id))).map(r => r.delta).sort())
          .toEqual([-BigInt(receipt.funding.amount), BigInt(receipt.funding.amount)].sort());
      } else if (receipt.funding.kind === 'gems') {
        // D-152: a Gems leg exists on the wire but Gems are DARK in this suite.
        throw new Error('hero recruitment charged Gems while GEMS_ENABLED=false');
      } else {
        expect(mode).not.toBe('keep'); expect(after.keep).toBe(before.keep); expect(after.uses).toHaveLength(1);
        expect(after.uses[0]!.id).toBe(receipt.funding.itemUseId); expect(receipt.funding.itemId).toBe(itemId);
        expect(receipt.funding.sourceBaseId).toBe(mode === 'base-contract' ? f.baseId : null);
        if (mode === 'base-contract') { expect(after.baseItems[0]!.qty).toBe(0); expect(after.walletItems[0]!.qty).toBe(1); }
        else expect(after.walletItems[0]!.qty).toBe(0);
      }
      await completeDueJobs(db, f.wallet, new Date(receipt.job.finishesAt), f.baseId);
      expect(await recruitedHeroesOf(db, f.wallet, f.baseId)).toEqual(new Set([hero]));
      expect((await getHeroRecruitmentCommand(db, f.wallet, request.idempotencyKey)).receipt).toEqual(receipt);
    });
  }
  it('rejects every changed original field before current cap, authority, or price gates', async () => {
    const f = await fixture(); const receipt = await f.submit(); process.env['HERO_RECRUITMENT_ENABLED'] = 'false';
    for (const change of [{ tx: 10 }, { ty: 11 }, { type: 'siegestool' as const }, { baseId: null }, { maxCostKeep: '1' }, { heroContractOnly: true, maxCostKeep: '0' }]) {
      await expect(executeHeroRecruitmentCommand(db, f.wallet, { ...f.request, ...change }, now)).rejects.toMatchObject({ code: 'HERO_RECRUITMENT_MISMATCH' });
    }
    expect(await executeHeroRecruitmentCommand(db, f.wallet, f.request, now)).toEqual(receipt);
  });
  it('serializes conflicting simultaneous consent under one actor/key instead of accepting both', async () => {
    const f = await fixture(); const result = await Promise.allSettled([f.submit(), f.submit({ ...f.request, tx: 12 })]);
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(result.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'HERO_RECRUITMENT_MISMATCH' } });
    expect((await snapshot(f)).buildings).toHaveLength(1);
  });
  it('scopes the same client key independently to each authenticated actor', async () => {
    const a = await fixture(); const b = await fixture();
    const [first, second] = await Promise.all([a.submit(), b.submit({ ...b.request, idempotencyKey: a.request.idempotencyKey })]);
    expect(first.actor).toBe(a.wallet); expect(second.actor).toBe(b.wallet); expect(first.building.id).not.toBe(second.building.id);
    expect((await getHeroRecruitmentCommand(db, a.wallet, a.request.idempotencyKey)).receipt).toEqual(first);
    expect((await getHeroRecruitmentCommand(db, b.wallet, a.request.idempotencyKey)).receipt).toEqual(second);
  });
  it('insufficient custodial KEEP refuses without saving acceptance or exposing an internal account', async () => {
    const f = await fixture(); await spendGameCurrency(db, f.wallet, (await snapshot(f)).keep, 'test.hero.drain', randomUUID());
    const before = await snapshot(f);
    await expect(f.submit()).rejects.toMatchObject({ code: 'INSUFFICIENT_KEEP', message: expect.stringContaining('Not enough KEEP.') });
    expect(await snapshot(f)).toEqual(before); expect((await getHeroRecruitmentCommand(db, f.wallet, f.request.idempotencyKey)).receipt).toBeNull();
  });
  it('enforces the frozen KEEP ceiling before spending and never substitutes KEEP for a missing contract-only fee', async () => {
    const f = await fixture(); const before = await snapshot(f);
    await expect(f.submit({ ...f.request, maxCostKeep: String(HEROES.vex.recruitCostKeep - 1) })).rejects.toMatchObject({ code: 'HERO_RECRUIT_PRICE_CHANGED' });
    await expect(f.submit({ ...f.request, heroContractOnly: true, maxCostKeep: '0' })).rejects.toMatchObject({ code: 'HERO_CONTRACT_UNAVAILABLE' });
    expect(await snapshot(f)).toEqual(before); expect((await getHeroRecruitmentCommand(db, f.wallet, f.request.idempotencyKey)).receipt).toBeNull();
    await db.insert(baseItems).values({ baseId: f.baseId!, itemId: HEROES.vex.recruitItemId, qty: 1 });
    expect((await f.submit({ ...f.request, maxCostKeep: '1' })).funding.kind).toBe('contract');
  });
  for (const mode of ['outage', 'malformed'] as const) for (const contract of [false, true]) {
    it(`${mode} receipt storage rolls back ${contract ? 'contract' : 'KEEP'}, audit, construction, job and activity`, async () => {
      const f = await fixture();
      if (contract) await db.insert(baseItems).values({ baseId: f.baseId!, itemId: HEROES.vex.recruitItemId, qty: 1 });
      const [oldBuilding] = await db.insert(buildings).values({ playerWallet: f.wallet, baseId: f.baseId!, type: 'cannon', tx: 16, ty: 16 }).returning();
      await db.insert(builderJobs).values({ playerWallet: f.wallet, baseId: f.baseId!, kind: 'build', buildingId: oldBuilding!.id,
        startedAt: new Date('2030-01-01T00:00:00.000Z'), finishesAt: new Date('2030-01-01T00:01:00.000Z') });
      const before = await snapshot(f);
      await expect(executeHeroRecruitmentCommand(failReceipt(mode), f.wallet, f.request, now, f.context)).rejects.toThrow();
      expect(await snapshot(f)).toEqual(before); expect((await getHeroRecruitmentCommand(db, f.wallet, f.request.idempotencyKey)).receipt).toBeNull();
      expect((await f.submit()).funding.kind).toBe(contract ? 'contract' : 'keep');
    });
  }
  for (const guard of ['keep-level', 'builder', 'cap', 'overlap', 'obstacle', 'claim-edge', 'foreign-base'] as const) {
    it(`canonical ${guard} refusal has no funding or accepted-receipt effect`, async () => {
      const f = await fixture(); let request = f.request;
      if (guard === 'keep-level') await db.update(bases).set({ keepLevel: HEROES.vex.unlockKeepLevel - 1 }).where(eq(bases.id, f.baseId!));
      if (guard === 'builder') {
        await db.update(bases).set({ builders: 1 }).where(eq(bases.id, f.baseId!));
        const [building] = await db.insert(buildings).values({ playerWallet: f.wallet, baseId: f.baseId!, type: 'cannon', tx: 16, ty: 16 }).returning();
        await db.insert(builderJobs).values({ playerWallet: f.wallet, baseId: f.baseId!, kind: 'build', buildingId: building!.id,
          startedAt: now, finishesAt: new Date('2035-01-01T00:00:00.000Z') });
      }
      if (guard === 'cap' || guard === 'overlap') await db.insert(buildings).values({ playerWallet: f.wallet, baseId: f.baseId!, type: guard === 'cap' ? 'heroaltar' : 'wall', tx: f.request.tx, ty: f.request.ty });
      if (guard === 'obstacle') await db.insert(obstacles).values({ playerWallet: f.wallet, baseId: f.baseId!, spriteKey: 'obs_rock_1', tx: f.request.tx, ty: f.request.ty });
      if (guard === 'claim-edge') request = { ...request, tx: 0 };
      if (guard === 'foreign-base') await db.update(bases).set({ ownerWallet: (await createTestPlayer(db)).wallet }).where(eq(bases.id, f.baseId!));
      const before = await snapshot(f); await expect(f.submit(request)).rejects.toThrow();
      expect(await snapshot(f)).toEqual(before); expect((await getHeroRecruitmentCommand(db, f.wallet, request.idempotencyKey)).receipt).toBeNull();
    });
  }
  it('does not auto-select a deed for original null or accept an absent/mismatched stable authority context', async () => {
    const f = await fixture(); const before = await snapshot(f); process.env['MULTI_BASE_ENABLED'] = 'true';
    await expect(f.submit({ ...f.request, baseId: null })).rejects.toMatchObject({ code: 'BASE_ID_REQUIRED' });
    await expect(executeHeroRecruitmentCommand(db, f.wallet, f.request, now)).rejects.toMatchObject({ code: 'HERO_RECRUITMENT_CONTEXT_MISMATCH' });
    expect(await snapshot(f)).toEqual(before);
  });
  for (const contract of [false, true]) it(`legacy/v1 ${contract ? 'contract' : 'KEEP'} race accepts exactly one construction and never backfills the legacy winner`, async () => {
    const f = await fixture(); if (contract) await db.insert(baseItems).values({ baseId: f.baseId!, itemId: HEROES.vex.recruitItemId, qty: 1 });
    const outcomes = await Promise.allSettled([
      placeBuilding(db, f.wallet, f.request.type as BuildingType, f.request.tx, f.request.ty, f.request.idempotencyKey, now, f.baseId, f.context), f.submit(),
    ]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect((await snapshot(f)).buildings).toHaveLength(1);
    expect((await getHeroRecruitmentCommand(db, f.wallet, f.request.idempotencyKey)).receipt !== null).toBe(outcomes[1]!.status === 'fulfilled');
    if (outcomes[0]!.status === 'fulfilled') expect(Object.keys(outcomes[0]!.value)).toEqual(['id', 'playerWallet', 'baseId', 'type', 'level', 'tx', 'ty', 'trapSpentAt']);
    const legacyQuery = { idempotencyKey: f.request.idempotencyKey, type: f.request.type as BuildingType, tx: f.request.tx, ty: f.request.ty, baseId: f.baseId };
    expect((await getConstructionReceipt(db, f.wallet, legacyQuery)).status).toBe('unknown');
  });
  it('the v1 pause leaves legacy placement unchanged and cannot fabricate a receipt for its accepted build', async () => {
    const f = await fixture(true, 'theodor'); process.env['HERO_RECRUITMENT_ENABLED'] = 'false';
    await expect(f.submit()).rejects.toMatchObject({ code: 'HERO_RECRUITMENT_DISABLED' });
    const building = await placeBuilding(db, f.wallet, f.request.type as BuildingType, f.request.tx, f.request.ty,
      f.request.idempotencyKey, now, f.baseId, f.context);
    expect(building.type).toBe('siegestool'); expect((await getHeroRecruitmentCommand(db, f.wallet, f.request.idempotencyKey)).receipt).toBeNull();
    process.env['HERO_RECRUITMENT_ENABLED'] = 'true';
    await expect(f.submit()).rejects.toThrow(/cap reached/);
    expect((await getHeroRecruitmentCommand(db, f.wallet, f.request.idempotencyKey)).receipt).toBeNull();
  });
  it('survives real deed transfer and later geometry/job changes without conferring buyer receipt access', async () => {
    const f = await fixture(); const receipt = await f.submit(); const buyer = await createTestPlayer(db); const asset = randomWallet();
    await db.update(bases).set({ deedAssetId: asset }).where(eq(bases.id, f.baseId!));
    await transferStableBase(db, f.baseId!, f.wallet, buyer.wallet, asset);
    await db.update(buildings).set({ tx: 12 }).where(eq(buildings.id, receipt.building.id));
    await db.update(builderJobs).set({ completedAt: now }).where(eq(builderJobs.id, receipt.job.id));
    process.env['HERO_RECRUITMENT_ENABLED'] = 'false';
    expect((await getHeroRecruitmentCommand(db, f.wallet, f.request.idempotencyKey)).receipt).toEqual(receipt);
    expect(await executeHeroRecruitmentCommand(db, f.wallet, f.request)).toEqual(receipt);
    expect((await getHeroRecruitmentCommand(db, buyer.wallet, f.request.idempotencyKey)).receipt).toBeNull();
  });
  it('finishes funding and accepted proof before an overlapping transfer can take the same actor and deed', async () => {
    const f = await fixture(); const buyer = await createTestPlayer(db);
    let entered!: () => void; let release!: () => void; let transferEntered!: () => void; let transferPid = 0;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const finish = new Promise<void>(resolve => { release = resolve; });
    const transferStarted = new Promise<void>(resolve => { transferEntered = resolve; });
    const context: StableBaseMutationContext = { baseId: f.baseId!, assertAuthority: async (tx, actor, target) => {
      await f.context!.assertAuthority(tx, actor, target); entered(); await finish;
    } };
    const recruiting = executeHeroRecruitmentCommand(db, f.wallet, f.request, now, context);
    let transferring: Promise<void> | undefined;
    try {
      await inside; expect((await getHeroRecruitmentCommand(db, f.wallet, f.request.idempotencyKey)).receipt).toBeNull();
      transferring = db.transaction(async tx => {
        transferPid = Number((await tx.execute(sql`SELECT pg_backend_pid() AS pid`))[0]!['pid']); transferEntered();
        await tx.select().from(players).where(eq(players.wallet, f.wallet)).for('update');
        await tx.select().from(bases).where(eq(bases.id, f.baseId!)).for('update');
        await tx.update(baseSlots).set({ active: false }).where(eq(baseSlots.baseId, f.baseId!));
        await tx.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, f.baseId!));
      });
      await transferStarted;
      await expect.poll(async () => (await conn.sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${transferPid}`)[0]?.['wait_event_type'], { timeout: 2_000 }).toBe('Lock');
      release(); const receipt = await recruiting; await transferring;
      expect((await getHeroRecruitmentCommand(db, f.wallet, f.request.idempotencyKey)).receipt).toEqual(receipt);
      expect((await getHeroRecruitmentCommand(db, buyer.wallet, f.request.idempotencyKey)).receipt).toBeNull();
    } finally { release(); await recruiting; await transferring; }
  });
  it('retains accepted proof against UPDATE, DELETE and TRUNCATE', async () => {
    const f = await fixture(); const receipt = await f.submit();
    for (const operation of [() => db.update(heroRecruitmentCommands).set({ receipt: {} }), () => db.delete(heroRecruitmentCommands), () => db.execute(sql`TRUNCATE hero_recruitment_commands`)]) {
      await expect(operation()).rejects.toMatchObject({ cause: { code: '23514' } });
    }
    expect((await getHeroRecruitmentCommand(db, f.wallet, f.request.idempotencyKey)).receipt).toEqual(receipt);
  });
  it('HTTP replays historical acceptance before land gates and keeps GET and errors private without completing jobs', async () => {
    const f = await fixture(false); const auth = await cookies(f.wallet); let app = await buildApp(TEST_CONFIG, db);
    try {
      const response = await app.inject({ method: 'POST', url: '/heroes/recruit/v1', cookies: auth, payload: f.request });
      expect(response.statusCode).toBe(201); expect(response.headers['cache-control']).toBe('private, no-store');
      const receipt = HeroRecruitmentReceiptSchema.parse(response.json());
      await db.update(builderJobs).set({ finishesAt: new Date('2020-01-01T00:00:00.000Z') }).where(eq(builderJobs.id, receipt.job.id));
      const before = await snapshot(f); await app.close();
      process.env['HERO_RECRUITMENT_ENABLED'] = 'false'; process.env['FREE_ONBOARDING'] = 'false';
      app = await buildApp(TEST_CONFIG, db);
      const url = `/heroes/recruit/v1/${f.request.idempotencyKey}`;
      const observed = await app.inject({ method: 'GET', url, cookies: auth });
      expect(HeroRecruitmentStatusSchema.parse(observed.json())).toMatchObject({ enabled: false, receipt });
      expect(observed.headers['cache-control']).toBe('private, no-store'); expect(await snapshot(f)).toEqual(before);
      const replay = await app.inject({ method: 'POST', url: '/heroes/recruit/v1', cookies: auth, payload: f.request });
      expect(replay.statusCode).toBe(200); expect(replay.json()).toEqual(receipt);
      const refused = await app.inject({ method: 'POST', url: '/heroes/recruit/v1', cookies: auth, payload: { ...f.request, idempotencyKey: randomUUID() } });
      expect(refused.statusCode).toBe(503); expect(refused.json().error.code).toBe('HERO_RECRUITMENT_DISABLED');
      for (const response of [refused, await app.inject({ method: 'GET', url }),
        await app.inject({ method: 'GET', url: '/heroes/recruit/v1/not-a-key', cookies: auth }),
        await app.inject({ method: 'POST', url: '/heroes/recruit/v1', cookies: auth, payload: { ...f.request, price: '1' } })]) {
        expect(response.statusCode).toBeGreaterThanOrEqual(400); expect(response.headers['cache-control']).toBe('private, no-store');
      }
      expect((await app.inject({ method: 'GET', url, cookies: { ...auth, [LOGIN_COOKIE]: 'pending' } })).statusCode).toBe(403);
    } finally { await app.close(); }
  });
  it('HTTP honors an explicit stable base even with legacy mode off and refuses foreign or stale authority before spending', async () => {
    const f = await fixture(); const auth = await cookies(f.wallet); const app = await buildApp(TEST_CONFIG, db);
    try {
      const unknown = await app.inject({ method: 'POST', url: '/heroes/recruit/v1', cookies: auth, payload: { ...f.request, baseId: randomUUID() } });
      expect(unknown.statusCode).toBe(404);
      await db.update(bases).set({ deedMintAssetId: randomWallet() }).where(eq(bases.id, f.baseId!)); const before = await snapshot(f);
      expect((await app.inject({ method: 'POST', url: '/heroes/recruit/v1', cookies: auth, payload: f.request })).statusCode).toBe(503);
      expect(await snapshot(f)).toEqual(before);
      await db.update(bases).set({ deedMintAssetId: null }).where(eq(bases.id, f.baseId!));
      const response = await app.inject({ method: 'POST', url: '/heroes/recruit/v1', cookies: auth, payload: f.request });
      expect(response.statusCode).toBe(201); expect(HeroRecruitmentReceiptSchema.parse(response.json()).building.baseId).toBe(f.baseId);
    } finally { await app.close(); }
  });
});

// Web and native clients read `receipt: null` from the GET as "this key never
// committed" and may then forget the saved recruitment. The GET must therefore
// wait for a command still holding the wallet lock; the wire shape stays exact.
describe.sequential('Hero recruitment GET never reads past a command in flight', () => {
  it.each(['commit', 'rollback'] as const)('waits for a recruitment still holding the wallet lock (%s)', async outcome => {
    const f = await fixture(); const before = await snapshot(f);
    const finish = await holdPlayerLock(db, f.wallet, tx => executeHeroRecruitmentCommand(tx as unknown as Db, f.wallet, f.request, now, f.context), outcome);
    const reading = readHeroRecruitmentCommand(db, f.wallet, f.request.idempotencyKey);
    let answeredEarly: boolean;
    try { answeredEarly = await settlesWithin(reading, 400); } finally { await finish(); }
    expect(answeredEarly).toBe(false);
    const status = HeroRecruitmentStatusSchema.parse(await reading);
    if (outcome === 'commit') {
      expect(status.receipt).not.toBeNull();
      expect(status.receipt).toEqual((await getHeroRecruitmentCommand(db, f.wallet, f.request.idempotencyKey)).receipt);
    } else { expect(status.receipt).toBeNull(); expect(await snapshot(f)).toEqual(before); }
  });
  it('HTTP answers a never-used key with receipt null in the unchanged exact shape, privately', async () => {
    const f = await fixture(); const app = await buildApp(TEST_CONFIG, db);
    try {
      const response = await app.inject({ method: 'GET', url: `/heroes/recruit/v1/${f.request.idempotencyKey}`, cookies: await cookies(f.wallet) });
      expect(response.statusCode, response.body).toBe(200); expect(response.headers['cache-control']).toBe('private, no-store');
      expect(Object.keys(response.json()).sort()).toEqual(['enabled', 'idempotencyKey', 'receipt', 'version', 'wallet']);
      expect(HeroRecruitmentStatusSchema.parse(response.json())).toMatchObject({ wallet: f.wallet, idempotencyKey: f.request.idempotencyKey, receipt: null });
    } finally { await app.close(); }
  });
});
