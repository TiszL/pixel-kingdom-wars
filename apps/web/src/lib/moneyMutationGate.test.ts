/** @vitest-environment happy-dom */
import type { Connection } from '@solana/web3.js';
import { afterEach, expect, it, vi } from 'vitest';
import { authCookies } from '../auth/authCookieCoordinator';
import { useApp } from '../state/store';
import { api } from './api';
import { mutationGate } from './mutationGate';
import { createWorkshopBrowserPorts, workshopIdentity } from './workshop/browser';
import { createGemsBrowserPorts, gemsIdentity } from './gems/browser';
import { createGemsBuyBrowserPorts, gemsBuyIdentity } from './gemsBuy/browser';
import { createHeroRecruitmentBrowserPorts, heroRecruitmentIdentity } from './heroRecruitment/browser';
import { binding, wallet, connection } from './gemsBuy/fixtures.test-support';

afterEach(() => { vi.restoreAllMocks(); useApp.getState().setAuth(null); });
it('blocks every Phase E money adapter at delayed dispatch while preserving receipt reads and wallet settlement POSTs', async () => {
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  const base = '00000000-0000-4000-8000-000000000004';
  useApp.getState().setAuth(binding.wallet, true); useApp.setState({ selectedBaseId: base, screen: 'build' });
  // React has not rendered the gate yet. A stale enabled button must not bypass it.
  const lifecycle = () => ({ active: true, visible: true, epoch: 0, actionsEnabled: true });
  const workshop = createWorkshopBrowserPorts({ identity: workshopIdentity(binding.wallet), lifecycle });
  const gemsScope = gemsIdentity(binding.wallet), gems = createGemsBrowserPorts(gemsScope, lifecycle, async () => undefined);
  const buy = createGemsBuyBrowserPorts({ identity: gemsBuyIdentity(binding.wallet), lifecycle,
    connection: connection() as unknown as Connection, wallet });
  const hero = createHeroRecruitmentBrowserPorts(heroRecruitmentIdentity(binding.wallet), lifecycle);
  const actions = [
    { post: workshop.post, mutate: workshop.capture(base), recover: workshop.capture() },
    { post: gems.post, mutate: gems.capture(gemsScope, true), recover: gems.capture(gemsScope, false) },
    { post: buy.post, mutate: buy.capture(true), recover: buy.capture(false) },
    { post: hero.post, mutate: hero.capture(true), recover: hero.capture(false) },
  ];
  let release!: () => void; const pending = new Promise<void>(yes => { release = yes; });
  let dispatched = 0;
  vi.spyOn(api, 'postRaw').mockImplementation(async (_path, _body, options) => {
    await pending; options?.isCurrent?.(); dispatched++; return {} as never;
  });
  const sends = actions.map(p => expect(p.post('/original-mutation', {}, p.mutate)).rejects.toThrow());
  mutationGate.close(); release(); await Promise.all(sends); expect(dispatched).toBe(0);
  for (const p of actions) { expect(p.mutate).toThrow(); expect(p.recover).not.toThrow(); }
  vi.spyOn(api, 'get').mockImplementation(async (_path, options) => { options?.isCurrent?.(); return { status: 'unknown' } as never; });
  await expect(workshop.get('/workshop/jobs/by-key/saved', actions[0]!.recover)).resolves.toEqual({ status: 'unknown' });
  await expect(gems.get('/gems/receipt/saved', actions[1]!.recover)).resolves.toEqual({ status: 'unknown' });
  await expect(buy.get('/gems/buy/by-key/saved', actions[2]!.recover)).resolves.toEqual({ status: 'unknown' });
  // The original signature may already have been broadcast. Settlement must not
  // require reopening the mutation gate or authorizing a second wallet payment.
  await expect(buy.post('/deposits/saved/paid', { signature: 'original' }, actions[2]!.recover)).resolves.toEqual({});
  await expect(buy.post('/deposits/saved/verify', {}, actions[2]!.recover)).resolves.toEqual({});
  expect(dispatched).toBe(2);
});
