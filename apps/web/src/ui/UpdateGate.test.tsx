/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../lib/events';
import { BUILD, UPDATE_POLL_MS, VERSION_REQUEST_TIMEOUT_MS, type ServerVersion } from '../lib/version';
import { MarketJournalStore } from '../lib/market/journal';
import { identity, purchase } from '../lib/market/fixtures.test-support';
import { useApp } from '../state/store';
import { UpdateGate } from './UpdateGate';

const gate = vi.hoisted(() => ({ allowed: true, close: vi.fn() }));
vi.mock('../lib/mutationGate', () => ({ mutationGate: {
  getSnapshot: () => gate.allowed,
  close: () => { gate.close(); gate.allowed = false; },
} }));

const handlers = vi.hoisted(() => ({ maintenance: null as (() => void) | null, outdated: null as (() => void) | null }));
vi.mock('../lib/api', () => ({ API_URL: '/api',
  setMaintenanceHandler: (handler: () => void) => { handlers.maintenance = handler; },
  setOutdatedHandler: (handler: () => void) => { handlers.outdated = handler; },
}));
vi.mock('../lib/version', async (original) => {
  const actual = await original<typeof import('../lib/version')>();
  const local = { ...actual.BUILD, version: '0.5.8', gitSha: 'old-web-build' };
  return { ...actual, BUILD: local,
    compareVersions: (server: Parameters<typeof actual.compareVersions>[0], web: Parameters<typeof actual.compareVersions>[1]) => actual.compareVersions(server, web, local),
  };
});

let host: HTMLDivElement; let root: Root | null;
const server = (change: Partial<ServerVersion> = {}): ServerVersion => ({ ...BUILD, ...change });
const response = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200 });
const render = async (): Promise<void> => { await act(async () => root!.render(<UpdateGate />)); };
const advance = async (ms: number): Promise<void> => { await act(async () => vi.advanceTimersByTimeAsync(ms)); };

beforeEach(() => {
  gate.allowed = true; gate.close.mockClear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('fetch', vi.fn(async () => response(server())));
  vi.spyOn(window.location, 'reload').mockImplementation(() => {});
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  handlers.maintenance = null; handlers.outdated = null;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host.remove(); useApp.setState({ screen: 'base' });
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('update discovery remains live across incomplete version reads', () => {
  it.each(['api', 'web'])('keeps the successful sibling when the %s endpoint stalls and discards its late reply', async (stalledEndpoint) => {
    let late!: (value: Response) => void; let signal!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
      const endpoint = url === '/version.json' ? 'web' : 'api';
      if (endpoint === stalledEndpoint) {
        signal = options!.signal!;
        return new Promise<Response>((resolve) => { late = resolve; });
      }
      return Promise.resolve(response(endpoint === 'web' ? server({ gitSha: 'replacement-same-version' }) : server({ simVersion: BUILD.simVersion + 1 })));
    }));
    await render(); await advance(VERSION_REQUEST_TIMEOUT_MS - 1);
    expect(host.textContent).toBe(''); expect(window.location.reload).not.toHaveBeenCalled();
    await advance(1);
    const expected = stalledEndpoint === 'api' ? 'NEW VERSION AVAILABLE' : 'UPDATE REQUIRED';
    expect(host.textContent).toContain(expected); expect(signal.aborted).toBe(true);
    expect(gate.allowed).toBe(stalledEndpoint === 'api');
    await act(async () => late(response(server({ simVersion: BUILD.simVersion + 10 }))));
    expect(host.textContent).toContain(expected); expect(window.location.reload).not.toHaveBeenCalled();
  });

  it('retries at the existing cadence after both reads time out, without overlapping rounds', async () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetcher); await render();
    await advance(VERSION_REQUEST_TIMEOUT_MS); expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockImplementation(async () => response(server({ simVersion: BUILD.simVersion + 1 })));
    await advance(UPDATE_POLL_MS - 1); expect(fetcher).toHaveBeenCalledTimes(2);
    await advance(1); expect(fetcher).toHaveBeenCalledTimes(4);
    expect(host.textContent).toContain('UPDATE REQUIRED'); expect(window.location.reload).not.toHaveBeenCalled();
  });

  it('never unlocks a known incompatible simulator after later failed version reads', async () => {
    const fetcher = vi.fn(async () => response(server({ simVersion: BUILD.simVersion + 1 })));
    vi.stubGlobal('fetch', fetcher); await render(); expect(host.textContent).toContain('UPDATE REQUIRED');
    expect(gate.allowed).toBe(false);
    fetcher.mockImplementation(async () => new Response('offline', { status: 503 }));
    await advance(UPDATE_POLL_MS);
    expect(host.textContent).toContain('UPDATE REQUIRED'); expect(window.location.reload).not.toHaveBeenCalled();
  });

  it('unmount cancels both in-flight reads and cannot restart polling from late responses', async () => {
    const requests: { signal: AbortSignal; resolve: (value: Response) => void }[] = [];
    const fetcher = vi.fn((_url: string, options?: RequestInit) => new Promise<Response>((resolve) => {
      requests.push({ signal: options!.signal!, resolve });
    }));
    vi.stubGlobal('fetch', fetcher); await render();
    await act(async () => { root!.unmount(); root = null; });
    expect(requests).toHaveLength(2); expect(requests.every(({ signal }) => signal.aborted)).toBe(true);
    await act(async () => requests.forEach(({ resolve }) => resolve(response(server({ simVersion: BUILD.simVersion + 1 })))));
    await advance(UPDATE_POLL_MS * 2);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    expect(gate.close).not.toHaveBeenCalled(); expect(gate.allowed).toBe(true);
  });
});

describe('maintenance recovery waits for the player', () => {
  it('closes on a forced callback and remains closed after unmount', async () => {
    await render(); expect(gate.allowed).toBe(true);
    await act(async () => handlers.outdated!());
    expect(gate.allowed).toBe(false); expect(host.textContent).toContain('UPDATE REQUIRED');
    await act(async () => { root!.unmount(); root = null; });
    expect(gate.allowed).toBe(false);
  });

  it('recovers after a stalled probe at the existing ten-second watch cadence', async () => {
    await render();
    let signal!: AbortSignal;
    const probe = vi.fn((_url: string, options?: RequestInit): Promise<Response> => {
      signal = options!.signal!; return new Promise(() => {});
    });
    vi.stubGlobal('fetch', probe);
    await act(async () => handlers.maintenance!());
    expect(host.textContent).toContain('RAISING THE DRAWBRIDGE');
    expect(gate.allowed).toBe(false);
    await advance(VERSION_REQUEST_TIMEOUT_MS); expect(signal.aborted).toBe(true);
    probe.mockImplementation(async () => response(server()));
    await advance(9_999); expect(probe).toHaveBeenCalledOnce();
    await advance(1); expect(probe).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('THE KINGDOM IS READY'); expect(host.textContent).toContain('RELOAD GAME');
    expect(gate.allowed).toBe(false);
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it.each(['battle', 'market'] as const)('never auto-reloads the %s screen and preserves payment evidence on explicit reload', async (screen) => {
    useApp.setState({ screen });
    const journal = new MarketJournalStore(identity);
    const original = { ...purchase(), attempted: true, signature: '2'.repeat(88) };
    await journal.compareAndSet(0, (old) => ({ ...old, activated: true, purchase: original }));
    const before = await journal.read();
    const unregister = vi.fn().mockResolvedValue(true);
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistrations: async () => [{ unregister }] } });
    const deleteCache = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', { keys: async () => ['pkw-shell-old', 'pkw-asset-pack-v1', 'pkw-push-session-v1'], delete: deleteCache });
    try {
      await render(); await act(async () => handlers.maintenance!());
      expect(host.textContent).toContain('RELOAD GAME');
      await advance(UPDATE_POLL_MS * 2);
      expect(window.location.reload).not.toHaveBeenCalled(); expect(unregister).not.toHaveBeenCalled();
      expect(await journal.read()).toEqual(before);
      await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
      expect(window.location.reload).toHaveBeenCalledOnce(); expect(unregister).toHaveBeenCalledOnce();
      expect(deleteCache.mock.calls).toEqual([['pkw-shell-old']]);
      expect(await journal.read()).toEqual(before);
      expect(host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
    } finally { await journal.close(); Reflect.deleteProperty(navigator, 'serviceWorker'); }
  });

  it('unmount aborts a maintenance probe without reloading or scheduling another watch', async () => {
    await render(); let signal!: AbortSignal; let late!: (value: Response) => void;
    const fetcher = vi.fn((_url: string, options?: RequestInit) => {
      signal = options!.signal!; return new Promise<Response>((resolve) => { late = resolve; });
    });
    vi.stubGlobal('fetch', fetcher); await act(async () => handlers.maintenance!());
    await act(async () => { root!.unmount(); root = null; }); expect(signal.aborted).toBe(true);
    await act(async () => late(response(server()))); await advance(UPDATE_POLL_MS);
    expect(fetcher).toHaveBeenCalledOnce(); expect(window.location.reload).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('a ground revision this bundle cannot draw asks for a reload, never over a battle', () => {
  // WHY: after the revision-5 flip (2026-09-26) a tab on an older bundle painted the frozen
  // legacy ground and the owner saw "old realms" on web while the dismissible banner could be
  // waved away. The scene reports the newer revision through the bus; the gate answers with a
  // prompt the player cannot dismiss, but it must not lock raiding (the simulator agrees) and
  // must never land on top of a fight in progress.
  const outdated = async (groundRevision = 6): Promise<void> => {
    await act(async () => bus.emit('scene:artworkOutdated', { groundRevision }));
  };
  beforeEach(() => { vi.stubEnv('DEV', false); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('shows a non-dismissible RELOAD on the base screen and leaves raiding open', async () => {
    useApp.setState({ screen: 'base' }); await render();
    await outdated();
    expect(host.textContent).toContain('NEW REALM ARTWORK IS LIVE');
    // Revisions are per realm and the trigger may be ANOTHER realm's base (a scout, a raid, a
    // replay), so the copy never claims the player's own realm was redrawn.
    expect(host.textContent).toContain('New realm artwork is live. Reload to see it.');
    expect(host.textContent).not.toContain('Your kingdom');
    expect(host.textContent).toContain('Nothing is lost');
    expect(host.textContent).not.toContain('✕');
    expect(gate.close).not.toHaveBeenCalled(); expect(gate.allowed).toBe(true);
    // A later same-simulator poll (soft or current) never quietly clears old ground.
    vi.mocked(fetch).mockImplementation(async () => response(server({ gitSha: 'newer-web-build' })));
    await advance(UPDATE_POLL_MS);
    expect(host.textContent).toContain('NEW REALM ARTWORK IS LIVE'); expect(host.textContent).not.toContain('NEW VERSION AVAILABLE');
    expect(window.location.reload).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(window.location.reload).toHaveBeenCalledOnce();
  });

  it.each(['battle', 'scout'] as const)('defers the prompt through a %s and shows it back on the base screen', async (screen) => {
    useApp.setState({ screen }); await render();
    await outdated();
    expect(host.textContent).toBe('');
    await advance(UPDATE_POLL_MS);
    expect(host.textContent).toBe(''); expect(window.location.reload).not.toHaveBeenCalled();
    await act(async () => useApp.setState({ screen: 'base' }));
    expect(host.textContent).toContain('NEW REALM ARTWORK IS LIVE');
  });

  it('yields to a simulator mismatch, which still locks raiding', async () => {
    useApp.setState({ screen: 'base' }); await render();
    await outdated();
    await act(async () => handlers.outdated!());
    expect(host.textContent).toContain('UPDATE REQUIRED'); expect(gate.allowed).toBe(false);
    await outdated(7);
    expect(host.textContent).toContain('UPDATE REQUIRED');
  });

  it('is silent in a dev build, which draws whatever its local server stamps', async () => {
    useApp.setState({ screen: 'base' }); await render();
    vi.stubEnv('DEV', true); await outdated();
    expect(host.textContent).toBe('');
    vi.stubEnv('DEV', false);
    const local = BUILD as { gitSha: string }; const sha = local.gitSha; local.gitSha = 'dev';
    try { await outdated(); expect(host.textContent).toBe(''); } finally { local.gitSha = sha; }
    await outdated();
    expect(host.textContent).toContain('NEW REALM ARTWORK IS LIVE');
  });
});
