/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApp } from '../../state/store';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), begin: vi.fn(), history: vi.fn(), revision: 0 }));
vi.mock('../../lib/api', async importOriginal => ({ ...await importOriginal<typeof import('../../lib/api')>(), api: { get: mocks.get, post: mocks.post } }));
vi.mock('../../lib/trainingFinish/context', () => ({ useTrainingFinishView: () => ({ begin: mocks.begin, openHistory: mocks.history,
  actionsEnabled: false, state: { loaded: true, busy: false }, snapshotRevision: mocks.revision }) }));
vi.mock('../sheets', () => ({ reloadBase: vi.fn() }));
vi.mock('../../lib/audio', () => ({ playSfx: vi.fn() }));
import { ArmyScreen, ArmyRoster } from './army';
let host: HTMLDivElement, root: Root;
const baseId = '00000000-0000-4000-8000-000000000001';
const roster = (count: number) => ({ counts: { bowman: count }, levels: { bowman: 1 }, research: [], queue: [], rosterPts: 0, campCapacityPts: 0, barracksQueuePts: 0 });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); mocks.get.mockReset().mockResolvedValue(roster(1)); mocks.post.mockReset(); mocks.begin.mockReset(); mocks.history.mockReset(); mocks.revision = 0;
  useApp.setState({ wallet: '11111111111111111111111111111111', base: null, selectedBaseId: baseId, baseSelectionEpoch: 0 });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); useApp.setState({ base: null, wallet: null, selectedBaseId: null }); });
it('Army training history remains reachable with no base, paused actions and a failed roster read', async () => {
  useApp.setState({ selectedBaseId: null }); mocks.get.mockRejectedValue(new Error('No current kingdom'));
  await act(async () => root.render(<ArmyScreen />));
  const button = [...host.querySelectorAll('button')].find(b => b.textContent === 'TRAINING PAYMENTS & RECEIPTS')!;
  expect(button.disabled).toBe(false); await act(async () => button.click());
  expect(mocks.history).toHaveBeenCalledOnce(); expect(mocks.begin).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
});
it('A → B → A stale full roster cannot replace fresh current troops', async () => {
  const old = deferred<ReturnType<typeof roster>>(); mocks.get.mockReturnValueOnce(old.promise).mockResolvedValue(roster(3));
  await act(async () => root.render(<ArmyRoster />));
  await act(async () => useApp.setState({ selectedBaseId: '00000000-0000-4000-8000-000000000002', baseSelectionEpoch: 1 }));
  await act(async () => useApp.setState({ selectedBaseId: baseId, baseSelectionEpoch: 2 }));
  expect(host.textContent).toContain('×3'); await act(async () => old.resolve(roster(9)));
  expect(host.textContent).toContain('×3'); expect(host.textContent).not.toContain('×9');
});
it('payment revision hides prior troop counts until a separate full server roster read succeeds', async () => {
  await act(async () => root.render(<ArmyRoster />)); expect(host.textContent).toContain('×1');
  const current = deferred<ReturnType<typeof roster>>(); mocks.get.mockReturnValueOnce(current.promise); mocks.revision++;
  await act(async () => root.render(<ArmyRoster />));
  expect(host.textContent).not.toContain('×1'); expect(host.textContent).toContain('—');
  await act(async () => current.resolve(roster(2))); expect(host.textContent).toContain('×2'); expect(mocks.post).not.toHaveBeenCalled();
});
