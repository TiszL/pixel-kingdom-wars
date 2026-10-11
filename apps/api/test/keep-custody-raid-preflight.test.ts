import { BuildingType } from '@shardkeep/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { completeDueTraining } from '../src/game/army';
import { completeDueJobs, placeBuilding } from '../src/game/base';
import { withClientCurrency, withClientCurrencyContext } from '../src/game/clientCurrency';
import * as simulationRunner from '../src/game/raidSimulationRunner';
import { createRaid, submitOrders } from '../src/game/raids';
import { rewardShards } from '../src/game/spend';
import { custodySinkMatrixFixture, future, key, type CustodySinkFixture } from './fixtures/custodySinkMatrix';
import { trainTroop } from './training-consent';

let f: CustodySinkFixture;
beforeEach(async () => { f = await custodySinkMatrixFixture(); }, 120_000);
afterEach(async () => { vi.restoreAllMocks(); await f?.dispose(); }, 120_000);

async function pendingRaid(keep: bigint) {
  const attacker = await f.player(keep), defender = await f.player(0n);
  for (const actor of [attacker, defender]) {
    await f.stampLand(actor.wallet);
    await rewardShards(f.db, actor.wallet, 1_000_000n, 'test.fund.shards', key());
  }
  await placeBuilding(f.db, attacker.wallet, BuildingType.Barracks, 17, 17, key());
  await completeDueJobs(f.db, attacker.wallet, future(120));
  await placeBuilding(f.db, attacker.wallet, BuildingType.Camp, 19, 19, key());
  await completeDueJobs(f.db, attacker.wallet, future(240));
  for (let i = 0; i < 4; i++) {
    await trainTroop(f.db, attacker.wallet, 'highlander' as never, key(), future(300 + i * 10));
    await completeDueTraining(f.db, attacker.wallet, future(310 + i * 10));
  }
  // The actual retirement preconditions run before new raid admission. No raid
  // lock or outstanding obligation is bypassed to manufacture a frozen state.
  await f.freeze();
  const raid = await createRaid(f.db, attacker.wallet, { defenderWallet: defender.wallet, idempotencyKey: key() });
  const body = { deploys: [{ troop: 'highlander' as const, tx: 6, ty: 14, tMs: 0 }],
    buffs: { warhorn: true }, idempotencyKey: key() };
  return { attacker, raid, finish: () => submitOrders(f.db, attacker.wallet, raid.id, body) };
}

it('routes a headerless retired-player shortfall to Gems before simulation, with no raid or money changes', async () => {
  const p = await pendingRaid(0n), before = await f.snapshot();
  const simulation = vi.spyOn(simulationRunner, 'claimRaidSimulationPermit');
  await expect(withClientCurrency(undefined, p.finish)).rejects.toMatchObject({ statusCode: 422, code: 'INSUFFICIENT_GEMS' });
  expect(simulation).not.toHaveBeenCalled();
  expect(await f.snapshot()).toEqual(before);
}, 120_000);

it('rejects retired exact KEEP as unavailable even when the new Gems balance covers the price', async () => {
  const p = await pendingRaid(1_000_000n), before = await f.snapshot();
  const simulation = vi.spyOn(simulationRunner, 'claimRaidSimulationPermit');
  await expect(withClientCurrencyContext({ currency: 'GEMS', expectedCurrency: 'KEEP' }, p.finish))
    .rejects.toMatchObject({ statusCode: 409, code: 'CURRENCY_CONSENT_CHANGED',
      details: { expectedCurrency: 'KEEP', reason: 'currency_unavailable' } });
  expect(simulation).not.toHaveBeenCalled();
  expect(await f.snapshot()).toEqual(before);
}, 120_000);

it('reports the retired custody hold when Gems spending is paused, preserving the retryable raid', async () => {
  const p = await pendingRaid(1_000_000n), before = await f.snapshot();
  process.env['GEMS_ENABLED'] = 'false';
  const simulation = vi.spyOn(simulationRunner, 'claimRaidSimulationPermit');
  await expect(withClientCurrency(undefined, p.finish)).rejects.toMatchObject({ statusCode: 423, code: 'KEEP_CUSTODY_FROZEN' });
  expect(simulation).not.toHaveBeenCalled();
  expect(await f.snapshot()).toEqual(before);
}, 120_000);
