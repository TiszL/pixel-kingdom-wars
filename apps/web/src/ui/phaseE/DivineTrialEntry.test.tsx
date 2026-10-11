/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { useApp } from '../../state/store';
import { DivineTrialEntry } from './DivineTrialEntry';
vi.mock('./DivineTrialScreen', () => ({ DivineTrialScreen: () => <span data-original-trial-screen /> }));
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, prior: ReturnType<typeof useApp.getState>;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); prior = useApp.getState(); useApp.setState({ authed: true, wallet: 'trial-wallet' }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useApp.setState(prior, true); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('keeps the Trial entry on its original kingdom route under 188719c1', async () => {
  useApp.setState({ screen: 'base' });
  await act(async () => root.render(<DivineTrialEntry actionsEnabled={false} />));
  expect(host.textContent).toContain('DIVINE TRIALS'); await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click(); await Promise.resolve(); });
  await vi.waitFor(() => expect(host.querySelector('[data-original-trial-screen]')).not.toBeNull());
  expect(useApp.getState().screen).toBe('base'); expect(host.textContent).not.toContain('Opening trial history…');
});
it('retains the original trial modal without a callback', async () => {
  await act(async () => root.render(<DivineTrialEntry actionsEnabled={false} />));
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
  await vi.waitFor(() => expect(host.querySelector('[data-original-trial-screen]')).not.toBeNull());
});
it('keeps unauthenticated trial entry hidden with the callback present', async () => {
  useApp.setState({ authed: false }); const onOpen = vi.fn();
  await act(async () => root.render(<DivineTrialEntry actionsEnabled onOpen={onOpen} />));
  expect(host.querySelector('button')).toBeNull(); expect(onOpen).not.toHaveBeenCalled();
});
it('keeps the optional trial producer behind R0', async () => {
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0'); const onOpen = vi.fn();
  await act(async () => root.render(<DivineTrialEntry actionsEnabled onOpen={onOpen} />));
  expect(host.querySelector('button')).toBeNull(); expect(onOpen).not.toHaveBeenCalled();
});
