/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApp } from '../../state/store';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), begin: vi.fn(), history: vi.fn(), revision: 0 }));
vi.mock('../../lib/api', async importOriginal => ({ ...await importOriginal<typeof import('../../lib/api')>(), api: { get: mocks.get, post: mocks.post } }));
vi.mock('../../lib/researchSpeedup/context', () => ({ useResearchSpeedupView: () => ({ begin: mocks.begin, openHistory: mocks.history,
  actionsEnabled: false, state: { loaded: true, busy: false }, snapshotRevision: mocks.revision }) }));
vi.mock('../sheets', () => ({ reloadBase: vi.fn() }));
vi.mock('../../lib/audio', () => ({ playSfx: vi.fn() }));
import { ArmyScreen, ResearchTray } from './army';
let host: HTMLDivElement, root: Root;
const baseId = '00000000-0000-4000-8000-000000000001';
const roster = (level: number) => ({ counts: {}, levels: { giant: level }, research: [], queue: [], rosterPts: 0, campCapacityPts: 0, barracksQueuePts: 0 });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); mocks.get.mockReset().mockResolvedValue(roster(1)); mocks.post.mockReset(); mocks.begin.mockReset(); mocks.history.mockReset(); mocks.revision = 0;
  useApp.setState({ wallet: '11111111111111111111111111111111', base: null, selectedBaseId: baseId, baseSelectionEpoch: 0 });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); useApp.setState({ base: null, wallet: null, selectedBaseId: null }); });
it('Army history stays reachable with admissions paused, no owned base and a failed roster read', async () => {
  useApp.setState({ selectedBaseId: null }); mocks.get.mockRejectedValue(new Error('No current kingdom'));
  await act(async () => root.render(<ArmyScreen />));
  const button = [...host.querySelectorAll('button')].find(b => b.textContent === 'RESEARCH PAYMENTS & RECEIPTS')!;
  expect(button).toBeDefined(); expect(button.disabled).toBe(false);
  await act(async () => button.click()); expect(mocks.history).toHaveBeenCalledOnce(); expect(mocks.begin).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
});
it('an A → B → A stale roster cannot replace the new current research levels', async () => {
  const first = deferred<ReturnType<typeof roster>>(); mocks.get.mockReturnValueOnce(first.promise).mockResolvedValue(roster(3));
  await act(async () => root.render(<ResearchTray />));
  await act(async () => useApp.setState({ selectedBaseId: '00000000-0000-4000-8000-000000000002', baseSelectionEpoch: 1 }));
  await act(async () => useApp.setState({ selectedBaseId: baseId, baseSelectionEpoch: 2 }));
  expect(host.textContent).toContain('L3');
  await act(async () => first.resolve(roster(9)));
  expect(host.textContent).toContain('L3'); expect(host.textContent).not.toContain('L9'); expect(mocks.post).not.toHaveBeenCalled();
});
it('payment refresh hides old levels until a separate full roster read succeeds', async () => {
  await act(async () => root.render(<ResearchTray />)); expect(host.textContent).toContain('L1');
  const current = deferred<ReturnType<typeof roster>>(); mocks.get.mockReturnValueOnce(current.promise); mocks.revision++;
  await act(async () => root.render(<ResearchTray />));
  // Portrait/level badges cannot invent the previous level while this read waits.
  expect(host.querySelector('[data-research-level="giant"]')?.textContent).toBe('—');
  await act(async () => current.resolve(roster(2)));
  expect(host.querySelector('[data-research-level="giant"]')?.textContent).toBe('L2'); expect(mocks.post).not.toHaveBeenCalled();
});
