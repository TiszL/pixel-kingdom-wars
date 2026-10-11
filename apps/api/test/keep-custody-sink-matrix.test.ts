/** Twelve real production sink branches after the committed E3a retirement.
 * Exact KEEP is refused; headerless installed clients spend Gems. Existing
 * pre-freeze matrices retain their separate KEEP/fallback coverage. */
import { BUFFS, BuildingType, HEROES, HERO_LEVELING, ITEMS, MINING } from '@shardkeep/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { bases, baseSlots, baseArmy, baseTroopResearch, buildings, builderJobs, heroLevels, playerItems, players, raids } from '../src/db/schema';
import { completeDueJobs, placeBuilding, upgradeBuilding } from '../src/game/base';
import { completeDueTraining, researchSpeedup, researchTroop } from '../src/game/army';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { withClientCurrency, withClientCurrencyContext } from '../src/game/clientCurrency';
import { heroLedgerKey } from '../src/game/heroReceipt';
import { createRaid, getPendingRaidResumes, recoverDueStartedLiveRaids, submitOrders } from '../src/game/raids';
import { rewardShards, spendGameCurrency } from '../src/game/spend';
import { custodySinkMatrixFixture, future, key, type CustodySinkFixture } from './fixtures/custodySinkMatrix';
import { createTestPlayer, fundTestKeep, randomWallet } from './helpers';
import { trainSpeedup, trainTroop } from './training-consent';

let f: CustodySinkFixture;
beforeEach(async () => { f = await custodySinkMatrixFixture(); }, 120_000);
afterEach(async () => { await f?.dispose(); }, 120_000);
type Actor = Awaited<ReturnType<CustodySinkFixture['player']>>;
const keepConsent = { 'x-pkw-currency': 'GEMS', 'x-pkw-expected-currency': 'KEEP' };
const oppositeHeader = { 'x-pkw-currency': 'KEEP' };
const exactKeep = <T>(run: () => T) => withClientCurrencyContext({ currency: 'GEMS', expectedCurrency: 'KEEP' }, run);
async function paused<T>(run: () => Promise<T>) {
  process.env['GEMS_ENABLED'] = 'false';
  try { return await run(); } finally { process.env['GEMS_ENABLED'] = 'true'; }
}
async function refusedHttp(actor: Actor, url: string, payload: object) {
  const before = await f.snapshot(), balances = await f.balances(actor.wallet);
  expect(balances[0]).toBe(0n); expect(balances[1]).toBeGreaterThan(0n);
  const result = await f.app.inject({ method: 'POST', url, cookies: actor.cookies, headers: keepConsent, payload });
  expect(result.statusCode, result.body).toBe(409);
  expect(result.json()).toMatchObject({ error: { code: 'CURRENCY_CONSENT_CHANGED', expectedCurrency: 'KEEP', reason: 'currency_unavailable' } });
  expect(await f.snapshot()).toEqual(before); expect(await f.balances(actor.wallet)).toEqual(balances);
}
async function refusedService(wallet: string, run: () => Promise<unknown>) {
  const before = await f.snapshot(), balances = await f.balances(wallet);
  expect(balances[0]).toBe(0n); expect(balances[1]).toBeGreaterThan(0n);
  await expect(exactKeep(run)).rejects.toMatchObject({ statusCode: 409, code: 'CURRENCY_CONSENT_CHANGED',
    details: { expectedCurrency: 'KEEP', reason: 'currency_unavailable' } });
  expect(await f.snapshot()).toEqual(before); expect(await f.balances(wallet)).toEqual(balances);
}
async function gemsCharge(wallet: string, idempotencyKey: string, cost: bigint, before: bigint[], type: string) {
  expect(cost).toBeGreaterThan(0n);
  const transaction = (await f.txn(idempotencyKey))!;
  expect(transaction).toBeDefined(); expect(transaction.type).toBe(type);
  expect(transaction.metadata).toMatchObject({ currency: 'GEMS' });
  expect(await f.shape(transaction.id)).toEqual([`gems_sink:${cost}`, `player_gems:${-cost}`].sort());
  expect(await f.balances(wallet)).toEqual([0n, before[1]! - cost]);
  return transaction;
}

it('base hero recruitment: exact KEEP refuses, headerless Gems builds one altar, and paused recovery preserves the receipt', async () => {
  const p = await f.player();
  await f.db.update(players).set({ keepLevel: HEROES.vex.unlockKeepLevel, builders: 2 }).where(eq(players.wallet, p.wallet));
  const request = { idempotencyKey: key(), baseId: null, type: HEROES.vex.altar, tx: 17, ty: 17,
    heroContractOnly: false, maxCostKeep: String(HEROES.vex.recruitCostKeep) };
  await f.freeze(); await refusedHttp(p, '/heroes/recruit/v1', request);
  const before = await f.balances(p.wallet), result = await f.app.inject({ method: 'POST', url: '/heroes/recruit/v1', cookies: p.cookies, payload: request });
  expect(result.statusCode, result.body).toBe(201);
  const receipt = result.json<{ funding: { kind: string; amount: string; ledgerTransactionId: string } }>();
  const cost = BigInt(HEROES.vex.recruitCostKeep);
  expect(receipt.funding).toMatchObject({ kind: 'gems', amount: String(cost) });
  expect(await f.shape(receipt.funding.ledgerTransactionId)).toEqual([`gems_sink:${cost}`, `player_gems:${-cost}`].sort());
  expect(await f.balances(p.wallet)).toEqual([0n, before[1]! - cost]);
  const after = await f.snapshot();
  await paused(async () => {
    const retry = await f.app.inject({ method: 'POST', url: '/heroes/recruit/v1', cookies: p.cookies, headers: oppositeHeader, payload: request });
    expect(retry.statusCode, retry.body).toBe(200); expect(retry.json()).toEqual(receipt);
    const read = await f.app.inject({ method: 'GET', url: `/heroes/recruit/v1/${request.idempotencyKey}`, cookies: p.cookies });
    expect(read.statusCode).toBe(200); expect(read.json()).toMatchObject({ receipt });
  });
  expect(await f.snapshot()).toEqual(after);
  expect(await f.db.select().from(buildings).where(and(eq(buildings.playerWallet, p.wallet), eq(buildings.type, HEROES.vex.altar)))).toHaveLength(1);
});

it('extra Mine: a headerless retired purchase uses two Gems legs and its construction receipt survives pause', async () => {
  const p = await f.player();
  await f.db.insert(buildings).values({ playerWallet: p.wallet, type: BuildingType.Mine, level: 1, tx: 11, ty: 8 });
  const request = { idempotencyKey: key(), type: BuildingType.Mine, tx: 17, ty: 14 };
  await f.freeze(); await refusedHttp(p, '/base/buildings', request);
  const before = await f.balances(p.wallet), result = await f.app.inject({ method: 'POST', url: '/base/buildings', cookies: p.cookies, payload: request });
  expect(result.statusCode, result.body).toBe(201); expect(result.json()).toMatchObject({ building: { type: 'mine', tx: 17, ty: 14 } });
  const cost = BigInt(MINING.MINE_BUILD_KEEP[1]!), transaction = await gemsCharge(p.wallet, `build:${p.wallet}:${request.idempotencyKey}`, cost, before, 'build.mine');
  const after = await f.snapshot();
  await paused(async () => {
    const read = await f.app.inject({ method: 'GET', url: `/base/buildings/receipt?idempotencyKey=${request.idempotencyKey}&type=mine&tx=17&ty=14`,
      cookies: p.cookies, headers: oppositeHeader });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ status: 'accepted', receiptId: transaction.id, funding: { currency: 'GEMS', amount: String(cost) } });
  });
  expect(await f.snapshot()).toEqual(after);
});

it('build speedup: retirement changes the paid upgrade sink while completion and spent Gems remain atomic', async () => {
  const p = await f.player(), barracks = await placeBuilding(f.db, p.wallet, BuildingType.Barracks, 17, 17, key());
  await completeDueJobs(f.db, p.wallet, future(120));
  await rewardShards(f.db, p.wallet, 1_000_000n, 'test.fund.shards', key());
  await f.db.update(players).set({ keepLevel: 10 }).where(eq(players.wallet, p.wallet));
  await upgradeBuilding(f.db, p.wallet, barracks.id, key(), future(121));
  const [job] = await f.db.select().from(builderJobs).where(and(eq(builderJobs.playerWallet, p.wallet), isNull(builderJobs.completedAt)));
  expect(job!.kind).toBe('upgrade'); const request = { idempotencyKey: key() }, url = `/base/jobs/${job!.id}/speedup`;
  await f.freeze(); await refusedHttp(p, url, request);
  const before = await f.balances(p.wallet), result = await f.app.inject({ method: 'POST', url, cookies: p.cookies, payload: request });
  expect(result.statusCode, result.body).toBe(200);
  await gemsCharge(p.wallet, `speedup:${p.wallet}:${request.idempotencyKey}`, BigInt(result.json<{ cost: string }>().cost), before, 'build.speedup');
  expect((await f.db.select().from(buildings).where(eq(buildings.id, barracks.id)))[0]!.level).toBe(2);
  expect((await f.db.select().from(builderJobs).where(eq(builderJobs.id, job!.id)))[0]!.completedAt).not.toBeNull();
  const after = await f.snapshot();
  await paused(async () => {
    const retry = await f.app.inject({ method: 'POST', url, cookies: p.cookies, headers: oppositeHeader, payload: request });
    expect(retry.statusCode, retry.body).toBe(404); // legacy paid-upgrade retry has no success-replay DTO
  });
  expect(await f.snapshot()).toEqual(after);
});

it.each(['research', 'training'] as const)('legacy %s finish: exact KEEP cannot switch silently, while headerless retirement spends Gems', async action => {
  const p = await f.player(); await rewardShards(f.db, p.wallet, 1_000_000n, 'test.fund.shards', key());
  await f.db.insert(buildings).values(action === 'research'
    ? [{ playerWallet: p.wallet, type: BuildingType.Forge, level: 2, tx: 11, ty: 8 }]
    : [{ playerWallet: p.wallet, type: BuildingType.Barracks, level: 5, tx: 14, ty: 8 }, { playerWallet: p.wallet, type: BuildingType.Camp, level: 3, tx: 17, ty: 8 }]);
  if (action === 'research') await researchTroop(f.db, p.wallet, 'giant', key());
  else await trainTroop(f.db, p.wallet, 'giant', key());
  const preview = await f.app.inject({ method: 'GET', url: '/army', cookies: p.cookies });
  expect(preview.statusCode).toBe(200);
  const idempotencyKey = key(), request = action === 'research' ? { troop: 'giant', idempotencyKey }
    : { idempotencyKey, consent: preview.json<{ finishAllQuote: unknown }>().finishAllQuote };
  const url = action === 'research' ? '/army/research/speedup' : '/army/train/speedup';
  await f.freeze(); await refusedHttp(p, url, request);
  const before = await f.balances(p.wallet), accepted = await f.app.inject({ method: 'POST', url, cookies: p.cookies, payload: request });
  expect(accepted.statusCode, accepted.body).toBe(200);
  await gemsCharge(p.wallet, `${action === 'research' ? 'rspeedup' : 'tspeedup'}:${p.wallet}:${idempotencyKey}`,
    BigInt(accepted.json<{ cost: string }>().cost), before, action === 'research' ? 'research.speedup' : 'train.speedup');
  const finished = await f.app.inject({ method: 'GET', url: '/army', cookies: p.cookies });
  expect(finished.statusCode).toBe(200);
  expect(finished.json()).toMatchObject(action === 'research' ? { levels: { giant: 2 }, research: [] } : { counts: { giant: 1 }, queue: [] });
  const after = await f.snapshot();
  await paused(async () => {
    const retry = await f.app.inject({ method: 'POST', url, cookies: p.cookies, headers: oppositeHeader, payload: request });
    expect(retry.statusCode, retry.body).toBe(404); // legacy finished episode is already gone
  });
  expect(await f.snapshot()).toEqual(after);
});

it.each(['research', 'training'] as const)('stable-base %s finish exercises its separate retired Gems debit and base-owned effect', async action => {
  process.env['MULTI_BASE_ENABLED'] = 'true';
  const { wallet } = await createTestPlayer(f.db), asset = randomWallet(), now = new Date();
  await fundTestKeep(f.db, wallet, 1_000_000n, 'test.fund', key());
  const [base] = await f.db.insert(bases).values({ ownerWallet: wallet, status: 'active', keepLevel: 8,
    deedAssetId: asset, deedMintAssetId: asset, landPaidAt: now }).returning();
  const baseId = base!.id; await f.db.insert(baseSlots).values({ wallet, slot: 1, baseId });
  await rewardBaseShards(f.db, baseId, 100_000n, 'test.fund.shards', key());
  await f.db.insert(buildings).values([
    { playerWallet: wallet, baseId, type: BuildingType.Keep, level: 8, tx: 14, ty: 14 },
    { playerWallet: wallet, baseId, type: BuildingType.Barracks, level: 5, tx: 8, ty: 8 },
    { playerWallet: wallet, baseId, type: BuildingType.Camp, level: 3, tx: 18, ty: 8 },
    { playerWallet: wallet, baseId, type: BuildingType.Forge, level: 3, tx: 8, ty: 18 },
  ]);
  // Same private authority seam as the existing code25 stable-army fixture;
  // this test exercises currency retirement, not network deed authentication.
  const context = { baseId, assertAuthority: async () => {} };
  if (action === 'research') await researchTroop(f.db, wallet, 'giant', key(), now, context);
  else await trainTroop(f.db, wallet, 'giant', key(), now, context);
  const command = key(), finish = () => action === 'research' ? researchSpeedup(f.db, wallet, 'giant', command, now, context)
    : trainSpeedup(f.db, wallet, command, now, context);
  await f.freeze(); await refusedService(wallet, finish);
  const before = await f.balances(wallet), result = await withClientCurrency(undefined, finish);
  await gemsCharge(wallet, `${action === 'research' ? 'rspeedup' : 'tspeedup'}:${baseId}:${command}`, result.cost, before,
    action === 'research' ? 'research.speedup' : 'train.speedup');
  if (action === 'research') expect((await f.db.select().from(baseTroopResearch).where(eq(baseTroopResearch.baseId, baseId)))[0])
    .toMatchObject({ troop: 'giant', level: 2, researchingToLevel: null });
  else expect(await f.db.select({ troop: baseArmy.troop, count: baseArmy.count }).from(baseArmy).where(eq(baseArmy.baseId, baseId)))
    .toEqual([{ troop: 'giant', count: 1 }]);
  const after = await f.snapshot();
  await paused(async () => { await expect(withClientCurrency('KEEP', finish)).rejects.toMatchObject({ statusCode: 404 }); });
  expect(await f.snapshot()).toEqual(after);
});

it.each(['upgrade', 'recovery'] as const)('hero %s: retired headerless Gems is preserved by opposite-header command and receipt recovery', async action => {
  const p = await f.player(), recoveryUntil = future(120);
  await f.db.insert(buildings).values({ playerWallet: p.wallet, type: HEROES.vex.altar, level: 1, tx: 17, ty: 17 });
  await f.db.insert(heroLevels).values({ playerWallet: p.wallet, hero: 'vex', level: 1, ...(action === 'recovery' ? { recoveryUntil } : {}) });
  const consent = action === 'upgrade' ? { expectedLevel: 1, maxCostKeep: String(HERO_LEVELING.upgradeCostKeep.vex[0]!) }
    : { recoveryUntil: recoveryUntil.toISOString(), maxCostKeep: '1000000' };
  const command = key(), request = { idempotencyKey: command, consent }, url = `/heroes/vex/${action === 'upgrade' ? 'upgrade' : 'recovery/speedup'}`;
  await f.freeze(); await refusedHttp(p, url, request);
  const before = await f.balances(p.wallet), accepted = await f.app.inject({ method: 'POST', url, cookies: p.cookies, payload: request });
  expect(accepted.statusCode, accepted.body).toBe(200);
  const cost = BigInt(accepted.json<{ spentKeep: string }>().spentKeep);
  await gemsCharge(p.wallet, heroLedgerKey(action, p.wallet, 'vex', command), cost, before,
    action === 'upgrade' ? 'hero.upgrade' : 'hero.recovery.speedup');
  const after = await f.snapshot();
  await paused(async () => {
    const retry = await f.app.inject({ method: 'POST', url, cookies: p.cookies, headers: oppositeHeader, payload: request });
    expect(retry.statusCode, retry.body).toBe(200); expect(retry.json()).toMatchObject({ duplicate: true, spentKeep: '0' });
    const query = new URLSearchParams(Object.entries({ idempotencyKey: command, ...consent }).map(([k, value]) => [k, String(value)]));
    const read = await f.app.inject({ method: 'GET', url: `${url}/receipt?${query}`, cookies: p.cookies, headers: oppositeHeader });
    expect(read.statusCode, read.body).toBe(200); expect(read.json()).toMatchObject({ status: 'accepted', funding: { currency: 'GEMS', amount: String(cost) } });
  });
  expect(await f.snapshot()).toEqual(after);
  expect((await f.db.select().from(heroLevels).where(eq(heroLevels.playerWallet, p.wallet)))[0])
    .toMatchObject(action === 'upgrade' ? { level: 2 } : { recoveryUntil: null });
});

it('item purchase: retired headerless payment grants one shop_gems item and paused opposite-header replay never charges again', async () => {
  const p = await f.player(), request = { itemId: 'powder_charge', idempotencyKey: key() }, cost = BigInt(ITEMS.powder_charge.costKeep);
  await f.freeze(); await refusedHttp(p, '/items/buy', request);
  const before = await f.balances(p.wallet), accepted = await f.app.inject({ method: 'POST', url: '/items/buy', cookies: p.cookies, payload: request });
  expect(accepted.statusCode, accepted.body).toBe(201); expect(accepted.json()).toMatchObject({ currency: 'GEMS', duplicate: false });
  await gemsCharge(p.wallet, `item:${p.wallet}:${request.idempotencyKey}`, cost, before, 'item.buy');
  const after = await f.snapshot();
  await paused(async () => {
    const retry = await f.app.inject({ method: 'POST', url: '/items/buy', cookies: p.cookies, headers: oppositeHeader, payload: request });
    expect(retry.statusCode, retry.body).toBe(201); expect(retry.json()).toMatchObject({ itemId: request.itemId, duplicate: true });
  });
  expect(await f.snapshot()).toEqual(after);
  expect((await f.db.select().from(playerItems).where(and(eq(playerItems.playerWallet, p.wallet), eq(playerItems.itemId, request.itemId))))[0])
    .toMatchObject({ qty: 1, acquiredVia: 'shop_gems' });
});

async function raidWorld() {
  const attacker = await f.player(), defender = await f.player(0n);
  for (const actor of [attacker, defender]) { await f.stampLand(actor.wallet); await rewardShards(f.db, actor.wallet, 1_000_000n, 'test.fund.shards', key()); }
  await placeBuilding(f.db, attacker.wallet, BuildingType.Barracks, 17, 17, key()); await completeDueJobs(f.db, attacker.wallet, future(120));
  await placeBuilding(f.db, attacker.wallet, BuildingType.Camp, 19, 19, key()); await completeDueJobs(f.db, attacker.wallet, future(240));
  for (let i = 0; i < 4; i++) {
    await trainTroop(f.db, attacker.wallet, 'highlander' as never, key(), future(300 + i * 10));
    await completeDueTraining(f.db, attacker.wallet, future(310 + i * 10));
  }
  await f.freeze(); // an active raid cannot be smuggled through retirement's preconditions
  const raid = await createRaid(f.db, attacker.wallet, { defenderWallet: defender.wallet, idempotencyKey: key() });
  return { attacker, raid };
}

it('direct raid buffs: retired headerless submit spends Gems once and settlement has its actual gameplay effect', async () => {
  const { attacker, raid } = await raidWorld(), request = { deploys: [{ troop: 'highlander' as const, tx: 6, ty: 14, tMs: 0 }],
    buffs: { warhorn: true }, idempotencyKey: key() };
  const finish = () => submitOrders(f.db, attacker.wallet, raid.id, request);
  await refusedService(attacker.wallet, finish);
  const before = await f.balances(attacker.wallet), result = await withClientCurrency(undefined, finish);
  expect(result.result.stars).toBeGreaterThanOrEqual(0);
  await gemsCharge(attacker.wallet, `raid:${raid.id}:buffs`, BigInt(BUFFS.warhorn.costKeep), before, 'raid.buffs');
  expect((await f.db.select().from(raids).where(eq(raids.id, raid.id)))[0]!.status).toBe('resolved');
  const after = await f.snapshot();
  await paused(async () => { await expect(withClientCurrency('KEEP', finish)).rejects.toMatchObject({ statusCode: 422 }); });
  expect(await f.snapshot()).toEqual(after);
}, 120_000);

it('live buffs: paused worker recovery consumes the prepaid retired Gems buff without a second debit', async () => {
  const { attacker, raid } = await raidWorld(), request = { clientCommandId: key(), command: { kind: 'buff', payload: { buff: 'warhorn' } } };
  const url = `/raids/${raid.id}/commands`; await refusedHttp(attacker, url, request);
  const before = await f.balances(attacker.wallet), accepted = await f.app.inject({ method: 'POST', url, cookies: attacker.cookies, payload: request });
  expect(accepted.statusCode, accepted.body).toBe(200);
  const charge = await gemsCharge(attacker.wallet, `raid:${raid.id}:live-buff:warhorn`, BigInt(BUFFS.warhorn.costKeep), before, 'raid.buffs');
  const paid = await f.balances(attacker.wallet);
  await paused(async () => {
    const retry = await f.app.inject({ method: 'POST', url, cookies: attacker.cookies, headers: oppositeHeader, payload: request });
    expect(retry.statusCode, retry.body).toBe(200); expect(await f.balances(attacker.wallet)).toEqual(paid);
    const deploy = await f.app.inject({ method: 'POST', url, cookies: attacker.cookies,
      payload: { clientCommandId: key(), command: { kind: 'deploy', payload: { troop: 'highlander', tx: 6, ty: 14, tMs: 0 } } } });
    expect(deploy.statusCode, deploy.body).toBe(200);
    const recoveredAt = new Date(Date.now() + 200_000);
    await withClientCurrency(undefined, () => getPendingRaidResumes(f.db, attacker.wallet, recoveredAt));
    expect(await withClientCurrency('KEEP', () => recoverDueStartedLiveRaids(f.db, recoveredAt, undefined, raid.id))).toEqual({ resolved: 1, raced: 0 });
    expect(await withClientCurrency('KEEP', () => recoverDueStartedLiveRaids(f.db, recoveredAt, undefined, raid.id))).toEqual({ resolved: 0, raced: 0 });
  });
  expect(await f.txn(`raid:${raid.id}:buffs`)).toBeUndefined();
  expect(await f.txn(`raid:${raid.id}:live-buff:warhorn`)).toEqual(charge);
  expect(await f.balances(attacker.wallet)).toEqual(paid);
  expect((await f.db.select().from(raids).where(eq(raids.id, raid.id)))[0]!.status).toBe('resolved');
}, 120_000);

it('retired item shortfall and a trailing grant failure preserve money and leave the original request retryable', async () => {
  const poor = await f.player(0n), rich = await f.player(), cost = BigInt(ITEMS.powder_charge.costKeep);
  await f.freeze();
  const available = (await f.balances(poor.wallet))[1]!;
  if (available >= cost) await withClientCurrency('GEMS', () => spendGameCurrency(f.db, poor.wallet, available - cost + 1n, 'test.other-gems-spend', key()));
  const poorBefore = await f.snapshot(), poorRequest = { itemId: 'powder_charge', idempotencyKey: key() };
  const short = await f.app.inject({ method: 'POST', url: '/items/buy', cookies: poor.cookies, payload: poorRequest });
  expect(short.statusCode, short.body).toBe(422); expect(short.json()).toMatchObject({ error: { code: 'INSUFFICIENT_GEMS' } });
  expect(await f.snapshot()).toEqual(poorBefore);
  const request = { itemId: 'powder_charge', idempotencyKey: key() }, before = await f.snapshot();
  await f.sql`create sequence public.sink_matrix_grant_reached`;
  await f.sql.unsafe(`create function public.sink_matrix_grant_fault() returns trigger language plpgsql as $$begin
    if NEW.player_wallet='${rich.wallet}' then
      if not exists(select 1 from ledger_transactions t join ledger_entries e on e.txn_id=t.id join accounts a on a.id=e.account_id
        where t.idempotency_key='item:${rich.wallet}:${request.idempotencyKey}' and a.kind='player_gems' and e.delta<0)
        then raise exception 'FIXTURE_EXPECTED_ACTUAL_GEMS_DEBIT';end if;
      perform nextval('public.sink_matrix_grant_reached');raise exception 'FIXTURE_GRANT_ROLLBACK';
    end if;return NEW;end$$;
    create trigger zzz_sink_matrix_grant_fault after insert on player_items for each row execute function public.sink_matrix_grant_fault();`);
  try {
    const failed = await f.app.inject({ method: 'POST', url: '/items/buy', cookies: rich.cookies, payload: request });
    expect(failed.statusCode).toBe(500);
  } finally { await f.sql`drop trigger zzz_sink_matrix_grant_fault on player_items`; }
  expect((await f.sql`select is_called from public.sink_matrix_grant_reached`)[0]!.is_called).toBe(true);
  expect(await f.snapshot()).toEqual(before);
  const balances = await f.balances(rich.wallet), retried = await f.app.inject({ method: 'POST', url: '/items/buy', cookies: rich.cookies, payload: request });
  expect(retried.statusCode, retried.body).toBe(201);
  await gemsCharge(rich.wallet, `item:${rich.wallet}:${request.idempotencyKey}`, cost, balances, 'item.buy');
});
