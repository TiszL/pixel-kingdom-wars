// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MapFeatureDestination } from '../../Overlay';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fixture = vi.hoisted(() => ({
  enabled: true,
  state: { wallet: 'wallet-a' as string | null, authed: true, selectedBaseId: 'base-a' as string | null,
    baseSelectionEpoch: 4, screen: 'map', mapTab: 'world' },
  listeners: new Set<() => void>(),
  loads: [] as string[], mounts: [] as string[], unmounts: [] as string[],
  closes: [] as (() => void)[], failLoad: false, failRender: false,
  delay: null as Promise<void> | null,
}));
vi.mock('../../../state/store', () => ({ useApp: {
  getState: () => fixture.state,
  subscribe: (fn: () => void) => { fixture.listeners.add(fn); return () => { fixture.listeners.delete(fn); }; },
} }));
vi.mock('../../phaseE/webHold', () => ({ phaseEWebEnabled: () => fixture.enabled }));
function Screen({ name, actionsEnabled, onClose }: { name: string; actionsEnabled: boolean; onClose: () => void }) {
  useEffect(() => { fixture.mounts.push(name); return () => { fixture.unmounts.push(name); }; }, [name]);
  if (fixture.failRender) throw Error('screen render failed');
  fixture.closes.push(onClose);
  return <button data-screen={name} data-actions={String(actionsEnabled)} onClick={onClose}>{name}</button>;
}
let root: Root;
let Host: typeof import('./MapFeatureHost').MapFeatureHost;
const target = (featureId: MapFeatureDestination['featureId'] = 'map.divineFragments', generation = 1): MapFeatureDestination =>
  ({ featureId, wallet: 'wallet-a', baseId: 'base-a', epoch: 4, generation });
const change = (patch: Partial<typeof fixture.state>) => {
  fixture.state = { ...fixture.state, ...patch };
  fixture.listeners.forEach(fn => fn());
};
async function draw(destination: MapFeatureDestination | null = target(), onClose: (() => void) | undefined = vi.fn(), actionsEnabled = true) {
  await act(async () => {
    root.render(<><div data-world="preserved" /><Host destination={destination} onClose={onClose} actionsEnabled={actionsEnabled} /></>);
  });
}
beforeEach(async () => {
  vi.resetModules();
  fixture.enabled = true;
  fixture.state = { wallet: 'wallet-a', authed: true, selectedBaseId: 'base-a', baseSelectionEpoch: 4, screen: 'map', mapTab: 'world' };
  fixture.listeners.clear(); fixture.loads = []; fixture.mounts = []; fixture.unmounts = []; fixture.closes = [];
  fixture.failLoad = false; fixture.failRender = false; fixture.delay = null;
  vi.doMock('../../phaseE/DivineTrialScreen', async () => {
    fixture.loads.push('trials');
    if (fixture.delay) await fixture.delay;
    if (fixture.failLoad) throw Error('screen import failed');
    return { DivineTrialScreen: (props: { actionsEnabled: boolean; onClose: () => void }) => <Screen name="trials" {...props} /> };
  });
  vi.doMock('../../phaseE/DivineFragmentsScreen', async () => {
    fixture.loads.push('fragments');
    if (fixture.delay) await fixture.delay;
    if (fixture.failLoad) throw Error('screen import failed');
    return { DivineFragmentsScreen: (props: { actionsEnabled: boolean; onClose: () => void }) => <Screen name="fragments" {...props} /> };
  });
  Host = (await import('./MapFeatureHost')).MapFeatureHost;
  const node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  document.body.replaceChildren(); vi.restoreAllMocks();
});

// 188719c1 retains the two former Trial cases as explicit held-route regressions.
test('held Trials never loads a screen during capability flips and closes its generation once', async () => {
  const destination = target('map.divineTrials'), close = vi.fn();
  await draw(destination, close, true); const world = document.querySelector('[data-world]');
  await draw({ ...destination }, close, false); await draw(destination, close, true);
  expect(close).toHaveBeenCalledTimes(1); expect(fixture.loads).toEqual([]);
  expect(fixture.mounts).toEqual([]); expect(document.querySelector('[data-screen]')).toBeNull();
  expect(document.querySelector('[data-world]')).toBe(world);
});
test('held Trials closes each new generation once without affecting a later Fragments owner', async () => {
  const first = vi.fn(), second = vi.fn(), fragmentClose = vi.fn();
  await draw(target('map.divineTrials'), first); await draw(target('map.divineTrials'), first);
  await draw(target('map.divineTrials', 2), second); await draw(target('map.divineFragments', 3), fragmentClose);
  expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1);
  expect(fragmentClose).not.toHaveBeenCalled(); expect(fixture.loads).toEqual(['fragments']);
  expect(document.querySelector('[data-screen]')).not.toBeNull();
});
test('Fragments forwards true → false → true without remounting the screen or world', async () => {
  const destination = target(), close = vi.fn();
  await draw(destination, close, true);
  const screen = document.querySelector('[data-screen]'), world = document.querySelector('[data-world]');
  expect(screen?.getAttribute('data-actions')).toBe('true');
  await draw({ ...destination }, vi.fn(), false);
  expect(document.querySelector('[data-screen]')).toBe(screen);
  expect(screen?.getAttribute('data-actions')).toBe('false');
  await draw(destination, close, true);
  expect(document.querySelector('[data-screen]')).toBe(screen);
  expect(screen?.getAttribute('data-actions')).toBe('true');
  expect(document.querySelector('[data-world]')).toBe(world);
  expect(fixture.mounts).toHaveLength(1); expect(fixture.unmounts).toHaveLength(0);
  expect(fixture.listeners.size).toBe(1);
});
test('Fragments closes immediately once and ignores the cached old close after replacement', async () => {
  const first = vi.fn(), second = vi.fn(); await draw(target(), first);
  const oldClose = fixture.closes.at(-1)!;
  act(() => { oldClose(); oldClose(); });
  expect(first).toHaveBeenCalledTimes(1); expect(document.querySelector('[data-screen]')).toBeNull();
  expect(fixture.unmounts).toHaveLength(1);
  await draw(target(), first); expect(document.querySelector('[data-screen]')).toBeNull();
  await draw(target('map.divineFragments', 2), second); act(() => oldClose());
  expect(second).not.toHaveBeenCalled(); expect(document.querySelector('[data-screen]')).not.toBeNull();
});

test('fresh onClose arrows for the same generation do not tear down its subscription and use the current callback', async () => {
  const first = vi.fn(), next = vi.fn();
  await draw(target(), first); const subscription = [...fixture.listeners][0];
  await draw(target(), next);
  expect([...fixture.listeners][0]).toBe(subscription);
  act(() => fixture.closes.at(-1)!());
  expect(first).not.toHaveBeenCalled(); expect(next).toHaveBeenCalledTimes(1);
});

for (const [key, bad] of [['wallet', 'wallet-b'], ['authed', false], ['selectedBaseId', 'base-b'],
  ['baseSelectionEpoch', 5], ['screen', 'base'], ['mapTab', 'campaign']] as const) {
  test(`scope ${key} A → B → A in one batch permanently retires the generation`, async () => {
    const close = vi.fn(); await draw(target(), close);
    const before = { ...fixture.state };
    act(() => { change({ [key]: bad }); change(before); });
    await draw(target(), close);
    expect(document.querySelector('[data-screen]')).toBeNull();
    expect(close).toHaveBeenCalledTimes(1); expect(fixture.unmounts).toHaveLength(1);
    await draw(target('map.divineFragments', 2), vi.fn());
    expect(document.querySelector('[data-screen]')).not.toBeNull();
  });
}
for (const absent of ['destination', 'onClose', 'hold', 'campaign', 'wallet', 'auth', 'base', 'epoch'] as const) {
  test(`does not import a feature when ${absent} is unavailable`, async () => {
    if (absent === 'hold') fixture.enabled = false;
    if (absent === 'campaign') fixture.state.mapTab = 'campaign';
    if (absent === 'wallet') fixture.state.wallet = null;
    if (absent === 'auth') fixture.state.authed = false;
    if (absent === 'base') fixture.state.selectedBaseId = 'base-b';
    if (absent === 'epoch') fixture.state.baseSelectionEpoch++;
    if (absent === 'onClose') {
      await act(async () => root.render(<Host destination={target()} actionsEnabled={true} />));
    } else await draw(absent === 'destination' ? null : target());
    expect(fixture.loads).toEqual([]); expect(fixture.mounts).toEqual([]);
  });
}
test('null base is an exact scope value, not permission to borrow the selected base', async () => {
  fixture.state.selectedBaseId = null;
  await draw({ ...target(), baseId: null });
  expect(document.querySelector('[data-screen]')).not.toBeNull();
  act(() => change({ selectedBaseId: 'base-a' }));
  expect(document.querySelector('[data-screen]')).toBeNull();
});
test('hold becoming false unmounts immediately and cannot resurrect the same generation', async () => {
  const close = vi.fn(); await draw(target(), close);
  fixture.enabled = false; await draw(target(), close);
  expect(document.querySelector('[data-screen]')).toBeNull(); expect(close).toHaveBeenCalledTimes(1);
  fixture.enabled = true; await draw(target(), close);
  expect(document.querySelector('[data-screen]')).toBeNull();
});
for (const failure of ['load', 'render'] as const) test(`${failure} failure closes locally once and preserves the world`, async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await draw(null); const world = document.querySelector('[data-world]'), close = vi.fn();
  fixture.failLoad = failure === 'load'; fixture.failRender = failure === 'render';
  await draw(target(), close);
  expect(close).toHaveBeenCalledTimes(1); expect(document.querySelector('[data-screen]')).toBeNull();
  expect(document.querySelector('[data-world]')).toBe(world);
  fixture.failLoad = false; fixture.failRender = false;
  // A new generation gets a fresh boundary. A rejected import remains rejected
  // in React.lazy's cache, so that generation must also close rather than hang.
  const nextClose = vi.fn(); await draw(target('map.divineFragments', 2), nextClose);
  if (failure === 'load') expect(nextClose).toHaveBeenCalledTimes(1);
  else expect(document.querySelector('[data-screen]')?.getAttribute('data-screen')).toBe('fragments');
});
test('late lazy resolution cannot mount after the destination was retired', async () => {
  let resolve!: () => void; fixture.delay = new Promise<void>(done => { resolve = done; });
  const close = vi.fn(); await draw(target(), close);
  act(() => change({ screen: 'base' }));
  await act(async () => { resolve(); await fixture.delay; });
  expect(fixture.mounts).toEqual([]); expect(close).toHaveBeenCalledTimes(1);
});
test('unmount unsubscribes and makes saved close callbacks inert', async () => {
  const close = vi.fn(); await draw(target(), close); const cached = fixture.closes.at(-1)!;
  await draw(null); act(() => cached());
  expect(fixture.listeners.size).toBe(0); expect(close).not.toHaveBeenCalled();
});

test('a previously loaded screen failing on a fresh generation closes even before the owner layout effect', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await draw(target()); await draw(null);
  fixture.failRender = true; const close = vi.fn();
  await draw(target('map.divineFragments', 2), close);
  expect(close).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[data-screen]')).toBeNull();
});

test('direct replacement retires the old close without touching the new generation', async () => {
  const first = vi.fn(), second = vi.fn(); await draw(target(), first);
  const cached = fixture.closes.at(-1)!;
  await draw(target('map.divineFragments', 2), second);
  const screen = document.querySelector('[data-screen]');
  act(() => cached());
  expect(first).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled();
  expect(document.querySelector('[data-screen]')).toBe(screen);
  expect(fixture.mounts).toHaveLength(2); expect(fixture.unmounts).toHaveLength(1);
});
test('late Fragments import rejection cannot re-close a replacement held Trial generation', async () => {
  let reject!: (reason: Error) => void;
  const delayed = new Promise<void>((_resolve, fail) => { reject = fail; }); fixture.delay = delayed;
  const first = vi.fn(), second = vi.fn(); await draw(target(), first);
  fixture.delay = null;
  await draw(target('map.divineTrials', 2), second);
  const world = document.querySelector('[data-world]');
  expect(second).toHaveBeenCalledTimes(1);
  await act(async () => { reject(Error('old import failed')); await delayed.catch(() => {}); });
  expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[data-world]')).toBe(world); expect(document.querySelector('[data-screen]')).toBeNull();
});
