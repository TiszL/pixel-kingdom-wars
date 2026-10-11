import { BuildingType, type BaseSnapshot } from '@shardkeep/shared';
import { simulateRaid } from '@shardkeep/sim';
import { describe, expect, it, vi } from 'vitest';
import { executeNativeSimulation, NativeSimulationService, type NativeExecutor, type NativeSimulationInput, type NativeSimulationResult } from '../src/native/simulation';
import { nativeArchivedHeroOrders, nativeOrders } from '../src/native/source';
import { NativeArchivedHeroOrdersSchema } from '../src/native/contracts';
import type { AcceptedLiveRaidCommand } from '../src/game/liveRaids';
import { abortablePresentation } from '../src/native/routes';

const input = (): NativeSimulationInput => ({
  snapshot: { keepLevel: 1, surplusShards: 0,
    buildings: [{ id: 'keep', type: BuildingType.Keep, level: 1, tx: 14, ty: 14 }],
  } satisfies BaseSnapshot,
  orders: { deploys: [{ troop: 'highlander', tx: -1, ty: 14, tMs: 0 }] },
  seed: 7, options: { troopLevels: { highlander: 1 } },
});
const events: NativeSimulationResult = { events: [{ t: 0, e: 'star', n: 1 }] };
const limits = { workers: 1, raids: 2, cacheBytes: 1024 * 1024 };
const beat = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('native archived hero health context', () => {
  const hero = { hero: 'theodor', tx: -1, ty: 0, tMs: 80_000, level: 20,
    loadout: { catalogRevision: 2, version: 6, hash: 'frozen-accepted-order', modifiers: { allied_troop_hp_bps: 600 } } };
  it('preserves historical absence and exact accepted future hero orders without copying the troop list', () => {
    expect(nativeArchivedHeroOrders(undefined)).toBeUndefined();
    expect(nativeArchivedHeroOrders(null)).toBeUndefined();
    expect(nativeArchivedHeroOrders({ deploys: [] })).toBeUndefined();
    const archived = { deploys: [{ troop: 'dragon', tx: -1, ty: 0, tMs: 0 }], heroDeploys: [hero] };
    const original = JSON.stringify(archived);
    expect(nativeArchivedHeroOrders(archived)).toEqual({ heroDeploys: [hero] });
    expect(JSON.stringify(archived)).toBe(original);
    expect(nativeArchivedHeroOrders({ heroDeploys: [] })).toEqual({ heroDeploys: [] });
  });
  it.each([
    { heroDeploys: [hero, hero] },
    { heroDeploys: [hero, { ...hero, hero: 'vex' }, { ...hero, hero: 'future' }] },
    { heroDeploys: [{ ...hero, hero: 'future' }] },
    { heroDeploys: [{ ...hero, tx: 0.5 }] },
    { heroDeploys: [{ ...hero, tMs: -1 }] },
    { heroDeploys: [{ ...hero, loadout: { ...hero.loadout, hash: '' } }] },
    { heroDeploys: [{ ...hero, loadout: { ...hero.loadout, modifiers: { allied_troop_hp_bps: 1.5 } } }] },
    { heroDeploys: 'unbounded' },
  ])('rejects malformed or over-bound archive context instead of truncating it: %j', (orders) => {
    expect(NativeArchivedHeroOrdersSchema.safeParse(orders).success).toBe(false);
    expect(() => nativeArchivedHeroOrders(orders)).toThrow('archived hero orders are invalid');
  });
});

describe('native isolated presentation', () => {
  it('produces the exact canonical event bytes outside the API event loop', async () => {
    const value = input();
    let heartbeat = false;
    const pending = executeNativeSimulation(value, new AbortController().signal);
    await beat(); heartbeat = true;
    expect(heartbeat).toBe(true);
    const actual = await pending;
    const canonical = simulateRaid(value.snapshot, value.orders, value.seed, value.options);
    expect(actual.events).toEqual(canonical.events);
    expect(actual.buildingHealth).toEqual(canonical.buildings.map(({ id, maxHp }) => ({ id, initialHp: maxHp, maxHp })));
  });

  it('shares same-revision work and cached results without another worker', async () => {
    let finish!: (value: NativeSimulationResult) => void;
    const run = vi.fn<NativeExecutor>(() => new Promise((resolve) => { finish = resolve; }));
    const service = new NativeSimulationService(limits, run);
    const one = service.simulate('a', 'v1', input());
    expect(service.simulate('a', 'v1', input())).toBe(one);
    await beat(); finish(events);
    expect(await one).toEqual(events);
    expect(await service.simulate('a', 'v1', input())).toEqual(events);
    expect(run).toHaveBeenCalledTimes(1); await service.close();
  });

  it('coalesces obsolete revisions and never publishes their stale completion', async () => {
    const finish: Array<(value: NativeSimulationResult) => void> = [];
    const run = vi.fn<NativeExecutor>(() => new Promise((resolve) => { finish.push(resolve); }));
    const service = new NativeSimulationService(limits, run);
    const first = service.simulate('a', 'v1', input());
    await beat();
    const second = service.simulate('a', 'v2', input());
    const latest = service.simulate('a', 'v3', input());
    expect(await first).toBeNull(); expect(await second).toBeNull();
    expect(run.mock.calls[0]![1].aborted).toBe(true);
    expect(run).toHaveBeenCalledTimes(1); // Cancellation cannot free a still-terminating worker slot.
    finish[0]!(events); await beat();
    expect(run).toHaveBeenCalledTimes(2);
    const newer: NativeSimulationResult = { events: [{ t: 4, e: 'star', n: 2 }] };
    finish[1]!(newer);
    expect(await latest).toEqual(newer);
    expect(await service.simulate('a', 'v3', input())).toEqual(newer);
    await service.close();
  });

  it('bounds distinct queued raids and aborts outstanding work on close', async () => {
    let signal!: AbortSignal;
    let terminated!: () => void;
    const run: NativeExecutor = (_value, nextSignal) => {
      signal = nextSignal;
      return new Promise((_resolve, reject) => { terminated = () => reject(new Error('terminated')); });
    };
    const service = new NativeSimulationService(limits, run);
    const first = service.simulate('a', 'v1', input());
    const second = service.simulate('b', 'v1', input());
    await expect(service.simulate('c', 'v1', input())).rejects.toMatchObject({ code: 'NATIVE_PRESENTATION_BUSY' });
    await beat();
    let closed = false;
    const closing = service.close().then(() => { closed = true; });
    expect(signal.aborted).toBe(true);
    expect(await first).toBeNull(); expect(await second).toBeNull();
    await beat(); expect(closed).toBe(false);
    terminated(); await closing; expect(closed).toBe(true);
    await expect(service.simulate('a', 'v2', input())).rejects.toThrow('closed');
  });

  it('admits another queued raid before a repeatedly superseded raid can claim the worker again', async () => {
    const finish: Array<(value: NativeSimulationResult) => void> = [];
    const run = vi.fn<NativeExecutor>(() => new Promise((resolve) => { finish.push(resolve); }));
    const service = new NativeSimulationService(limits, run);
    const first = service.simulate('a', 'v1', { ...input(), seed: 1 });
    await beat();
    const waiting = service.simulate('b', 'v1', { ...input(), seed: 2 });
    const superseded = service.simulate('a', 'v2', { ...input(), seed: 3 });
    const latest = service.simulate('a', 'v3', { ...input(), seed: 4 });
    expect(await first).toBeNull(); expect(await superseded).toBeNull();
    expect(run.mock.calls[0]![1].aborted).toBe(true);
    finish[0]!(events); await beat();
    expect(run.mock.calls.map(([value]) => value.seed)).toEqual([1, 2]);
    finish[1]!(events); expect(await waiting).toEqual(events); await beat();
    expect(run.mock.calls.map(([value]) => value.seed)).toEqual([1, 2, 4]);
    finish[2]!(events); expect(await latest).toEqual(events);
    await service.close();
  });

  it('evicts by byte budget and releases capacity after worker failures', async () => {
    const run = vi.fn<NativeExecutor>().mockRejectedValueOnce(new Error('worker failed')).mockResolvedValue(events);
    const service = new NativeSimulationService({ ...limits, cacheBytes: JSON.stringify(events).length }, run);
    await expect(service.simulate('a', 'v1', input())).rejects.toThrow('worker failed');
    await beat();
    await service.simulate('a', 'v1', input()); await beat();
    await service.simulate('b', 'v1', input()); await beat();
    await service.simulate('a', 'v1', input());
    expect(run).toHaveBeenCalledTimes(4); await service.close();
  });

  it('rejects oversize output instead of retaining an unbounded response', async () => {
    const service = new NativeSimulationService({ ...limits, cacheBytes: 1 }, async () => events);
    await expect(service.simulate('a', 'v1', input())).rejects.toMatchObject({ code: 'NATIVE_PRESENTATION_CAPACITY' });
    await service.close();
  });

  it('includes display health in the cache byte budget', async () => {
    const result = { ...events, buildingHealth: [{ id: 'wall', initialHp: 100, maxHp: 100 }] };
    const service = new NativeSimulationService({ ...limits, cacheBytes: Buffer.byteLength(JSON.stringify(events)) }, async () => result);
    await expect(service.simulate('a', 'v1', input())).rejects.toMatchObject({ code: 'NATIVE_PRESENTATION_CAPACITY' });
    await service.close();
  });

  it('keeps a shared worker alive until its last HTTP viewer disconnects', async () => {
    const finish: Array<(value: NativeSimulationResult) => void> = [];
    const run = vi.fn<NativeExecutor>(() => new Promise((resolve) => { finish.push(resolve); }));
    const service = new NativeSimulationService(limits, run);
    const first = new AbortController(); const second = new AbortController();
    const one = service.simulate('a', 'v1', input(), first.signal);
    const two = service.simulate('a', 'v1', input(), second.signal);
    await beat(); expect(run).toHaveBeenCalledTimes(1);
    first.abort(); await expect(one).rejects.toMatchObject({ statusCode: 499 });
    expect(run.mock.calls[0]![1].aborted).toBe(false);
    second.abort(); await expect(two).rejects.toMatchObject({ statusCode: 499 });
    expect(run.mock.calls[0]![1].aborted).toBe(true);
    const next = service.simulate('a', 'v1', input());
    await beat(); expect(run).toHaveBeenCalledTimes(1);
    // Even an executor that incorrectly completes after abort cannot cache a stale result.
    finish[0]!(events); await beat(); expect(run).toHaveBeenCalledTimes(2);
    const current: NativeSimulationResult = { events: [{ t: 8, e: 'star', n: 2 }] };
    finish[1]!(current); expect(await next).toEqual(current);
    expect(await service.simulate('a', 'v1', input())).toEqual(current);
    await service.close();
  });

  it('does not cancel another viewer when one disconnects, and caches their completed result', async () => {
    let finish!: (value: NativeSimulationResult) => void;
    const run = vi.fn<NativeExecutor>(() => new Promise((resolve) => { finish = resolve; }));
    const service = new NativeSimulationService(limits, run);
    const first = new AbortController(); const second = new AbortController();
    const one = service.simulate('a', 'v1', input(), first.signal);
    const two = service.simulate('a', 'v1', input(), second.signal);
    await beat(); first.abort(); await expect(one).rejects.toMatchObject({ statusCode: 499 });
    finish(events); expect(await two).toEqual(events);
    second.abort(); expect(run.mock.calls[0]![1].aborted).toBe(false);
    expect(await service.simulate('a', 'v1', input())).toEqual(events);
    expect(run).toHaveBeenCalledTimes(1); await service.close();
  });

  it('reclaims a disconnected queued raid without admitting it or exceeding worker bounds', async () => {
    let finish!: (value: NativeSimulationResult) => void;
    const run = vi.fn<NativeExecutor>(() => new Promise((resolve) => { finish = resolve; }));
    const service = new NativeSimulationService(limits, run);
    const active = service.simulate('a', 'v1', input());
    const controller = new AbortController();
    const queued = service.simulate('b', 'v1', input(), controller.signal);
    await beat(); controller.abort(); await expect(queued).rejects.toMatchObject({ statusCode: 499 });
    const next = service.simulate('c', 'v1', input());
    expect(run).toHaveBeenCalledTimes(1);
    finish(events); await active; await beat(); expect(run).toHaveBeenCalledTimes(2);
    finish(events); await next; await service.close();
  });

  it('refuses already-disconnected viewers before admission or a cache hit', async () => {
    const run = vi.fn<NativeExecutor>().mockResolvedValue(events);
    const service = new NativeSimulationService(limits, run);
    const controller = new AbortController(); controller.abort();
    await expect(service.simulate('a', 'v1', input(), controller.signal)).rejects.toMatchObject({ statusCode: 499 });
    expect(run).not.toHaveBeenCalled();
    await service.simulate('a', 'v1', input());
    await expect(service.simulate('a', 'v1', input(), controller.signal)).rejects.toMatchObject({ statusCode: 499 });
    expect(run).toHaveBeenCalledTimes(1); await service.close();
  });

  it('cancels a real worker without moving any raid state', async () => {
    const controller = new AbortController();
    const promise = executeNativeSimulation(input(), controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow('cancelled');
  });

  it('releases an aborted viewer without waiting for shared computation', async () => {
    const controller = new AbortController();
    let finish!: (value: number) => void;
    const shared = new Promise<number>((resolve) => { finish = resolve; });
    const viewer = abortablePresentation(shared, controller.signal);
    controller.abort();
    await expect(viewer).rejects.toMatchObject({ statusCode: 499 });
    finish(42); expect(await shared).toBe(42);
  });
});

describe('native journal hydration', () => {
  it('uses server offsets and frozen hero level while keeping controls out of SIM', () => {
    const at = new Date();
    const commands: AcceptedLiveRaidCommand[] = [
      { sequence: 0, kind: 'deploy', payload: { troop: 'highlander', tx: -1, ty: 0, tMs: 999 }, serverOffsetMs: 0, clientCommandId: 'a', acceptedAt: at },
      { sequence: 1, kind: 'start', payload: { expectedClockRevision: 0 }, serverOffsetMs: 0, clientCommandId: 'b', acceptedAt: at },
      { sequence: 2, kind: 'hero', payload: { hero: 'vex', tx: -1, ty: 1 }, serverOffsetMs: 500, clientCommandId: 'c', acceptedAt: at },
      { sequence: 3, kind: 'speed', payload: { rate: 2, expectedClockRevision: 1 }, serverOffsetMs: 700, clientCommandId: 'd', acceptedAt: at },
    ];
    const orders = nativeOrders(commands, { heroLevels: { vex: 4 } });
    expect(orders.deploys).toEqual([{ troop: 'highlander', tx: -1, ty: 0, tMs: 0 }]);
    expect(orders.heroDeploys).toEqual([{ hero: 'vex', tx: -1, ty: 1, tMs: 500, level: 4 }]);
    expect(() => nativeOrders([commands[2]!], {})).toThrow('incomplete');
  });
});
