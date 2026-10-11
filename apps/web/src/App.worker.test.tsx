/** @vitest-environment happy-dom */
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise the real App hook and SW waiter without starting wallet, audio,
// session, or canvas engines. App.test.ts pins the actual canvas/font boundary.
vi.mock('@solana/wallet-adapter-react', () => ({}));
vi.mock('@privy-io/react-auth', () => ({}));
vi.mock('@solana/kit', () => ({}));
vi.mock('@tanstack/react-query', () => ({ QueryClient: class {} }));
vi.mock('./lib/audio', () => ({}));
vi.mock('./lib/events', () => ({}));
vi.mock('./lib/cluster', () => ({ SOLANA_CLUSTER: 'mainnet-beta', SOLANA_WS_URL: 'wss://example.test' }));
vi.mock('./lib/mwa', () => ({}));
vi.mock('./lib/deepLink', () => ({}));
vi.mock('./lib/mobileBackGuard', () => ({}));
vi.mock('./lib/mobileShell', () => ({}));
vi.mock('./lib/pushSubscription', () => ({}));
vi.mock('./lib/platform', () => ({}));
vi.mock('./lib/version', () => ({ BUILD: { gitSha: 'current-build' } }));
vi.mock('./lib/analytics', () => ({}));
vi.mock('./auth/authCookieCoordinator', () => ({}));
vi.mock('./auth/useAuth', () => ({}));
vi.mock('./auth/loginChallenge', () => ({}));
vi.mock('./auth/mobilePhantomAdapter', () => ({}));
vi.mock('./state/assetPackGate', () => ({}));
vi.mock('./state/store', () => ({}));
vi.mock('./ui/Overlay', () => ({}));
vi.mock('./ui/UpdateGate', () => ({}));
vi.mock('./ui/ErrorBoundary', () => ({}));
vi.mock('./ui/GameLoadBoundary', () => ({}));
vi.mock('./ui/primitives', () => ({}));

import { useGameWorkerReady } from './App';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
let root: Root;
let worker: EventTarget & { controller: ServiceWorker | null };
const register = vi.fn();
const renders: string[] = [];
const mounted = vi.fn();
const unmounted = vi.fn();

function Canvas(): React.JSX.Element {
  useEffect(() => { mounted(); return () => { unmounted(); }; }, []);
  return <span>CANVAS</span>;
}
function Harness(): React.JSX.Element {
  const gameWorker = useGameWorkerReady();
  renders.push(gameWorker.state);
  return <>
    <span>LOGIN</span>
    {gameWorker.state === 'ready' && <Canvas />}
    {gameWorker.state === 'error' && <button onClick={gameWorker.retry}>RETRY</button>}
  </>;
}
function takeControl(build: string): void {
  worker.controller = { scriptURL: `${location.origin}/sw.js?v=${build}` } as ServiceWorker;
  worker.dispatchEvent(new Event('controllerchange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('DEV', false);
  register.mockReset().mockResolvedValue({});
  renders.length = 0;
  mounted.mockClear();
  unmounted.mockClear();
  worker = Object.assign(new EventTarget(), {
    controller: { scriptURL: `${location.origin}/sw.js?v=old-build` } as ServiceWorker | null,
    register,
  });
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: worker });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (originalWorker) Object.defineProperty(navigator, 'serviceWorker', originalWorker);
  else Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('App worker readiness lifecycle', () => {
  it('blocks the first render, preserves login, and never unmounts an admitted canvas on a later deploy', async () => {
    await act(async () => { root.render(<Harness />); });
    expect(renders.every((state) => state === 'waiting')).toBe(true);
    expect(document.body.textContent).toBe('LOGIN');
    expect(mounted).not.toHaveBeenCalled();
    await act(async () => { takeControl('current-build'); });
    expect(document.body.textContent).toBe('LOGINCANVAS');
    expect(mounted).toHaveBeenCalledTimes(1);
    await act(async () => { takeControl('next-build'); await vi.advanceTimersByTimeAsync(20_000); });
    expect(document.body.textContent).toBe('LOGINCANVAS');
    expect(unmounted).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps retry explicit and allows a late takeover to finish that retry without reloading', async () => {
    await act(async () => { root.render(<Harness />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(document.body.textContent).toBe('LOGINRETRY');
    const calls = register.mock.calls.length;
    await act(async () => { document.querySelector('button')!.click(); });
    expect(document.body.textContent).toBe('LOGIN');
    expect(register).toHaveBeenCalledTimes(calls + 1);
    await act(async () => { takeControl('current-build'); });
    expect(document.body.textContent).toBe('LOGINCANVAS');
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
