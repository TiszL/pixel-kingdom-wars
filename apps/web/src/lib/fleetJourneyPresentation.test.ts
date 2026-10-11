/** @vitest-environment happy-dom */
import { StarterExpeditionViewSchema } from '@shardkeep/shared/starterExpeditionApi';
import vector from '../../../../packages/shared/testFixtures/ordinaryEquipment.json';
import { LAND_CHECKOUT_RECOVERY, PHASE_E_VEHICLES } from '@shardkeep/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authCookies } from '../auth/authCookieCoordinator';
import { captureBaseSnapshotGuard, commitBaseSnapshot, useApp, type BaseStateDto } from '../state/store';
import { hydrateBaseSnapshot, reloadCurrentBaseSnapshot, captureBaseSnapshotCommit } from '../state/baseSnapshot';
import { api } from './api';
import { bus } from './events';
import { captureFleetJourneyPublication, publishFleetDeparture } from './fleetJourneyPresentation';
import { id, identity as fixtureIdentity, installation, proof, start, view } from './starterExpedition/fixtures.test-support';
// Wake actor grammar excludes the zero system address used by old starter-only fixtures.
const identity = { ...fixtureIdentity, wallet: vector.starterEnvelope.wallet };
function accepted(returned = false) {
  const value = proof(start, true, returned);
  if (value.status !== 'accepted') throw Error('fixture');
  return { ...value, wallet: identity.wallet, receipt: { ...value.receipt, wallet: identity.wallet } };
}
const p = accepted();
const receipt = p.receipt;
const wake = { state: 'legacy', visual: null } as const;
const event = { version: 1, kind: 'return', returnId: id(7), baseId: id(1), berthId: id(3), installationId: id(5),
  expeditionId: id(2), at: receipt.returnsAt, vehicle: { family: 'starter' }, wake } as const;
const balances = { shards: '0', keep: '0', keepRate: 1 };
function base(): BaseStateDto {
  return { baseId: id(1), player: { wallet: identity.wallet }, buildings: [{ id: id(3), type: 'berth', level: 1 }],
    servicePresentation: { version: 1, berths: [{ buildingId: id(3), installation: { family: 'starter', presence: 'occupied' } }] },
    jobs: [], obstacles: [], army: [] } as unknown as BaseStateDto;
}
const response = () => ({ ...base(), fleetJourneyEvents: { version: 1 as const, events: [event] } });
const flush = () => new Promise(resolve => setTimeout(resolve, 15));
beforeEach(() => {
  useApp.getState().setAuth(identity.wallet); useApp.getState().setSelectedBaseId(id(1), false);
  useApp.getState().setScreen('base'); useApp.getState().setBase(base());
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => { vi.restoreAllMocks(); useApp.getState().setAuth(null); });
function responses(raw: BaseStateDto = response()) { return vi.spyOn(api, 'get').mockImplementation(async path => path.startsWith('/base?') ? raw : balances as never); }
function original() {
  return { version: 1, kind: 'starter', wallet: identity.wallet, key: id(2), serverNow: p.serverNow, status: 'known', returnedAt: null,
    presentation: { expeditionId: id(2), baseId: id(1), installationId: id(5), homeRealmId: 'frostveil', realmId: receipt.route.realmId,
      departedAt: receipt.departedAt, returnsAt: receipt.returnsAt, wake } };
}
function departureReads(mutate: (o: ReturnType<typeof original>) => void = () => {}) {
  const o = original(); mutate(o);
  const { baseId: _base, ...trip } = original().presentation;
  const flight = { expeditionId: receipt.expeditionId, installationId: receipt.installationId, route: receipt.route,
    departedAt: receipt.departedAt, returnsAt: receipt.returnsAt, termId: receipt.termId, termHash: receipt.termHash };
  const currentView = StarterExpeditionViewSchema.parse({ ...view(), wallet: identity.wallet, installation: installation(), flight });
  return vi.spyOn(api, 'get').mockImplementation(async path => path.includes('/originals/') ? o
    : path.includes('/current?') ? { version: 1, wallet: identity.wallet, baseId: id(1), serverNow: p.serverNow, trips: [{ kind: 'starter', ...trip }] }
      : currentView as never);
}
it('discards cold hydration, strips stored callbacks and publishes a genuinely new warm return only once', async () => {
  const emit = vi.spyOn(bus, 'emit'); responses();
  expect(await hydrateBaseSnapshot(id(1))).toBe(true); await flush();
  expect(emit).not.toHaveBeenCalledWith('fleet:journey', expect.anything());
  expect(useApp.getState().base).not.toHaveProperty('fleetJourneyEvents');
  await reloadCurrentBaseSnapshot(); await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('fleet:journey', event));
  await reloadCurrentBaseSnapshot(); await flush();
  expect(emit.mock.calls.filter(([name]) => name === 'fleet:journey')).toHaveLength(1);
  expect(useApp.getState().base).not.toHaveProperty('fleetJourneyEvents');
});
it('never infers a return from an occupied presence diff or replays history commits', async () => {
  const emit = vi.spyOn(bus, 'emit'); const get = responses(); await hydrateBaseSnapshot(id(1));
  get.mockImplementation(async path => path.startsWith('/base?') ? base() : balances as never);
  await reloadCurrentBaseSnapshot();
  expect(captureBaseSnapshotCommit(id(1))(response(), balances)).toBe(true); await flush();
  expect(emit).not.toHaveBeenCalledWith('fleet:journey', expect.anything());
});
it('discards resume baseline, hidden responses and account or selected-base ABA callbacks', async () => {
  const emit = vi.spyOn(bus, 'emit'); responses(); await hydrateBaseSnapshot(id(1));
  document.dispatchEvent(new Event('resume')); await reloadCurrentBaseSnapshot(); await flush();
  expect(emit).not.toHaveBeenCalledWith('fleet:journey', expect.anything());
  for (const change of [() => { document.dispatchEvent(new Event('visibilitychange')); },
    () => { authCookies.invalidate(); },
    () => { useApp.getState().setSelectedBaseId(id(9), false); useApp.getState().setSelectedBaseId(id(1), false); }]) {
    const commit = captureBaseSnapshotCommit(id(1), undefined, true); change(); commit(response(), balances); await flush();
  }
  expect(emit).not.toHaveBeenCalledWith('fleet:journey', expect.anything());
});
it('drops older/newer-read ordering failures and mismatched current berth family', async () => {
  const emit = vi.spyOn(bus, 'emit'); responses(); await hydrateBaseSnapshot(id(1));
  const old = captureBaseSnapshotCommit(id(1), undefined, true), newer = captureBaseSnapshotCommit(id(1));
  expect(newer(base(), balances)).toBe(true); expect(old(response(), balances)).toBe(false);
  const wrong = response(); wrong.servicePresentation = null;
  expect(captureBaseSnapshotCommit(id(1), undefined, true)(wrong, balances)).toBe(true); await flush();
  expect(emit).not.toHaveBeenCalledWith('fleet:journey', expect.anything());
  const malformed = { ...base(), fleetJourneyEvents: { version: 2, events: [] } } as unknown as BaseStateDto;
  expect(captureBaseSnapshotCommit(id(1), undefined, true)(malformed, balances)).toBe(true); await flush();
  expect(useApp.getState().base).not.toHaveProperty('fleetJourneyEvents');
});
it('binds a fresh starter departure to its frozen sidecar and current trip, deduplicating only that original', async () => {
  const emit = vi.spyOn(bus, 'emit'); const get = departureReads();
  await publishFleetDeparture('starter', identity.wallet, p, () => {}, captureFleetJourneyPublication(id(1)));
  const { returnId: _return, ...departure } = event;
  expect(emit).toHaveBeenCalledWith('fleet:journey', { ...departure, kind: 'departure', at: receipt.departedAt });
  // Strict parsing removes no fields from an invented receipt; the emitted
  // departure has no returnId at all.
  expect((emit.mock.calls.find(([name]) => name === 'fleet:journey')![1] as object)).not.toHaveProperty('returnId');
  await publishFleetDeparture('starter', identity.wallet, p, () => {}, captureFleetJourneyPublication(id(1)));
  expect(emit.mock.calls.filter(([name]) => name === 'fleet:journey')).toHaveLength(1);
  expect(get.mock.calls.every(([path]) => !path.includes('preference'))).toBe(true);
});
it('preserves captured legacy, off and unavailable without substituting the current preference', async () => {
  for (const capture of [wake, { state: 'available', visual: { version: 1, wake: null } }, { state: 'unavailable', visual: null }]) {
    const emit = vi.spyOn(bus, 'emit'); const get = departureReads();
    const originalGet = get.getMockImplementation()!;
    get.mockImplementation(async (...args) => {
      const result = await originalGet(...args) as any;
      if (result.presentation) result.presentation.wake = capture;
      if (result.trips) result.trips[0].wake = capture;
      return result;
    });
    useApp.getState().setSelectedBaseId(id(9), false); useApp.getState().setSelectedBaseId(id(1), false);
    await publishFleetDeparture('starter', identity.wallet, p, () => {}, captureFleetJourneyPublication(id(1)));
    expect(emit).toHaveBeenCalledWith('fleet:journey', expect.objectContaining({ wake: capture }));
    get.mockRestore(); emit.mockRestore();
  }
});
it('refuses returned or mismatched originals and late sidecar results without changing the durable proof', async () => {
  const emit = vi.spyOn(bus, 'emit'); departureReads(o => { o.presentation.installationId = id(99); });
  await publishFleetDeparture('starter', identity.wallet, p, () => {}, captureFleetJourneyPublication(id(1)));
  await publishFleetDeparture('starter', identity.wallet, accepted(true), () => {}, captureFleetJourneyPublication(id(1)));
  const before = structuredClone(p), scope = captureFleetJourneyPublication(id(1));
  useApp.getState().setBase(base()); // newer authoritative snapshot during the binding await
  await publishFleetDeparture('starter', identity.wallet, p, () => {}, scope);
  expect(emit).not.toHaveBeenCalledWith('fleet:journey', expect.anything()); expect(p).toEqual(before);
});

it('binds advanced family and tier to the current installed original and drops opaque-screen callbacks', async () => {
  const p = vector.advancedEnvelope, r = p.receipt, baseId = r.request.baseId;
  useApp.getState().setAuth(p.wallet); useApp.getState().setSelectedBaseId(baseId, false);
  useApp.getState().setBase({ ...base(), baseId, player: { ...base().player, wallet: p.wallet } });
  const capture = { expeditionId: r.expeditionId, installationId: r.installationId, homeRealmId: r.route.homeRealmId,
    realmId: r.route.realmId, departedAt: r.departedAt, returnsAt: r.returnsAt, wake };
  const installed = { installationId: r.installationId, berthId: id(30), family: r.route.family, tier: r.route.tier,
    revision: 0, completedTotal: '0', allowanceStart: '0', remainingUses: PHASE_E_VEHICLES.completedUsesPerInstall, away: true, pendingService: false };
  vi.spyOn(api, 'get').mockImplementation(async path => path.includes('/originals/')
    ? { version: 1, kind: 'advanced', wallet: p.wallet, key: r.expeditionId, serverNow: p.serverNow, status: 'known', returnedAt: null, presentation: { ...capture, baseId } }
    : path.includes('/current?') ? { version: 1, wallet: p.wallet, baseId, serverNow: p.serverNow, trips: [{ kind: 'advanced', ...capture }] }
      : { version: 1, wallet: p.wallet, baseId, serverNow: p.serverNow, acceptingNewActions: true, vehicles: [installed] } as never);
  const emit = vi.spyOn(bus, 'emit');
  await publishFleetDeparture('advanced', p.wallet, p, () => {}, captureFleetJourneyPublication(baseId));
  expect(emit).toHaveBeenCalledWith('fleet:journey', expect.objectContaining({ vehicle: { family: r.route.family, tier: r.route.tier }, berthId: id(30) }));
  emit.mockClear(); useApp.getState().setSelectedBaseId(id(90), false); useApp.getState().setSelectedBaseId(baseId, false);
  installed.tier = installed.tier === 1 ? 2 : 1;
  await publishFleetDeparture('advanced', p.wallet, p, () => {}, captureFleetJourneyPublication(baseId));
  useApp.getState().setScreen('starter-expeditions');
  await publishFleetDeparture('advanced', p.wallet, p, () => {}, captureFleetJourneyPublication(baseId));
  expect(emit).not.toHaveBeenCalledWith('fleet:journey', expect.anything());
});

it('bounds optional sidecar waits without changing the accepted receipt or publishing a late effect', async () => {
  vi.useFakeTimers();
  try {
    const emit = vi.spyOn(bus, 'emit'), before = structuredClone(p);
    const get = vi.spyOn(api, 'get').mockImplementation((_path, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(Error('fixture abort')), { once: true });
    }));
    const task = publishFleetDeparture('starter', identity.wallet, p, () => {}, captureFleetJourneyPublication(id(1)));
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(LAND_CHECKOUT_RECOVERY.requestTimeoutMs + 1); await task;
    expect(emit).not.toHaveBeenCalledWith('fleet:journey', expect.anything()); expect(p).toEqual(before);
    expect(get.mock.calls.every(([, options]) => options?.signal?.aborted)).toBe(true);
  } finally { vi.useRealTimers(); }
});
it('retires already-requested sidecar publication on visibility or session change', async () => {
  for (const change of [() => document.dispatchEvent(new Event('visibilitychange')), () => authCookies.invalidate()]) {
    const emit = vi.spyOn(bus, 'emit'), get = departureReads(), normal = get.getMockImplementation()!;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    get.mockImplementation(async (...args) => { await gate; return normal(...args); });
    const task = publishFleetDeparture('starter', identity.wallet, p, () => {}, captureFleetJourneyPublication(id(1)));
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(3)); change(); release(); await task;
    expect(emit).not.toHaveBeenCalledWith('fleet:journey', expect.anything()); get.mockRestore(); emit.mockRestore();
  }
});

// These direct commits deliberately bypass the wrapper read counter, just as
// an independently accepted feature response can replace the same base.
it('retires warm return callbacks when a direct current-base commit intervenes before or between emissions', async () => {
  const emit = vi.spyOn(bus, 'emit'); responses(); await hydrateBaseSnapshot(id(1));
  const newer = base(), commit = captureBaseSnapshotCommit(id(1), undefined, true);
  expect(commit(response(), balances)).toBe(true);
  expect(commitBaseSnapshot(captureBaseSnapshotGuard(), id(1), newer, balances)).toBe(true);
  expect(useApp.getState().base).toBe(newer); await flush();
  expect(emit).not.toHaveBeenCalledWith('fleet:journey', expect.anything());

  const second = { ...event, returnId: id(71), expeditionId: id(72) };
  const raw = { ...base(), fleetJourneyEvents: { version: 1 as const, events: [event, second] } };
  emit.mockImplementation((name) => {
    if (name === 'fleet:journey') commitBaseSnapshot(captureBaseSnapshotGuard(), id(1), base(), balances);
  });
  expect(captureBaseSnapshotCommit(id(1), undefined, true)(raw, balances)).toBe(true); await flush();
  expect(emit.mock.calls.filter(([name]) => name === 'fleet:journey')).toEqual([['fleet:journey', event]]);
});
