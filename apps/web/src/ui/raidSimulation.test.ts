import { describe, expect, it, vi } from 'vitest';
import { SIM_VERSION } from '@shardkeep/sim';
import { RaidSimulationService, type RaidSimulationInput } from './raidSimulation';
import { computeRaidSimulation } from './raidSimulationCompute';
import { hydrateLiveOrders, type LiveCommand } from './liveRaid';
import frozen from './__fixtures__/stage100-frozen-raid.json';

const input = (): RaidSimulationInput => ({
  simVersion: SIM_VERSION, snapshot: frozen.snapshot as RaidSimulationInput['snapshot'],
  orders: hydrateLiveOrders(frozen.commands as LiveCommand[], frozen.army.heroLevels, frozen.army.heroLoadouts),
  seed: frozen.seed, options: { troopLevels: frozen.army.levels },
});
function fixture() {
  const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null, onmessageerror: null } as unknown as Worker;
  const create = vi.fn(() => worker);
  const service = new RaidSimulationService(create);
  const finish = (id: number, outcome: unknown) => worker.onmessage?.({ data: { id, outcome } } as MessageEvent);
  return { worker, create, service, finish };
}

describe('battle simulation worker presentation boundary', () => {
  it('does not create or run a simulator until requested; only worker results resolve it', async () => {
    const f = fixture(); expect(f.create).not.toHaveBeenCalled();
    const request = input(); const pending = f.service.simulate(request);
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.worker.postMessage).toHaveBeenCalledWith({ id: 1, input: request });
    let resolved = false; void pending.then(() => { resolved = true; });
    await Promise.resolve(); expect(resolved).toBe(false);
    f.finish(1, { stars: 2 }); expect(await pending).toEqual({ stars: 2 });
    f.service.dispose();
  });
  it('coalesces rapid accepted journals without ever displaying an obsolete revision', async () => {
    const f = fixture(); const first = f.service.simulate(input());
    const obsolete = f.service.simulate(input()); const newest = f.service.simulate(input());
    expect(await first).toBeNull(); expect(await obsolete).toBeNull();
    expect(f.worker.postMessage).toHaveBeenCalledTimes(1);
    f.finish(1, { stars: 0 });
    expect(f.worker.postMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.worker.postMessage).mock.calls[1]?.[0]).toMatchObject({ id: 3 });
    f.finish(3, { stars: 2 }); expect(await newest).toEqual({ stars: 2 });
    f.service.dispose();
  });
  it('terminates on identity teardown and cannot publish a late worker result', async () => {
    const f = fixture(); const pending = f.service.simulate(input());
    const queued = f.service.simulate(input()); const late = f.worker.onmessage;
    f.service.dispose(); expect(await pending).toBeNull(); expect(await queued).toBeNull();
    late?.call(f.worker, { data: { id: 1, outcome: { stars: 3 } } } as MessageEvent);
    expect(f.worker.terminate).toHaveBeenCalledOnce();
    expect(await f.service.simulate(input())).toBeNull();
    expect(f.worker.postMessage).toHaveBeenCalledTimes(1);
  });
  it('surfaces worker failure without rerunning simulation or posting game commands', async () => {
    const f = fixture(); const pending = f.service.simulate(input());
    const rejected = expect(pending).rejects.toThrow('failed to load or run');
    f.worker.onerror?.(new Event('error') as ErrorEvent); await rejected;
    await expect(f.service.simulate(input())).rejects.toThrow('failed to load or run');
    expect(f.create).toHaveBeenCalledOnce(); expect(f.worker.postMessage).toHaveBeenCalledTimes(1);
    expect(f.worker.terminate).toHaveBeenCalledOnce();
  });
  it('rejects mismatched worker replies instead of applying another journal', async () => {
    const f = fixture(); const pending = f.service.simulate(input());
    const rejected = expect(pending).rejects.toThrow('unexpected revision');
    f.finish(99, { stars: 3 }); await rejected;
    expect(f.worker.terminate).toHaveBeenCalledOnce();
  });
  it('preserves the exact historical Stage100 snapshot, loadout, levels and seed under SIM15 legacy rules', () => {
    const request = input(); const result = computeRaidSimulation(request);
    expect(result.destructionPct).toBe(frozen.expected.destructionPct);
    expect(result.stars).toBe(frozen.expected.stars);
    expect(result.events).toHaveLength(frozen.expected.events);
    // This proves compatibility of the legacy snapshot branch, not permission
    // to replay a pinned old live raid using a newer simulator.
    expect(() => computeRaidSimulation({ ...request, simVersion: frozen.simVersion }))
      .toThrow('LIVE RAID REQUIRES SIM VERSION');
    // This archived late-game battle is intentionally expensive. Workspace
    // parallelism is not a browser responsiveness benchmark; retain a bounded
    // completion timeout while checking the exact combat result above.
  }, 15_000);
});
