/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { api } from '../../lib/api';
import { miningContributionOriginal } from '../../lib/miningContribution/transport';
import { MiningContributionJournalStore } from '../../lib/miningContribution/journal';
import { miningContributionIdentity } from '../../lib/miningContribution/browser';
import { deferred, id, identity, proof, view } from '../../lib/miningContribution/fixtures.test-support';
import { MiningContributionScreen } from './MiningContributionScreen';
import { MiningContributionEntry } from './MiningContributionEntry';
vi.mock('../../lib/miningContribution/transport', () => ({ miningContributionOriginal: vi.fn() }));
let host: HTMLDivElement, root: Root, accepted: boolean, currentView: ReturnType<typeof view>;
const until = (fn: () => void | Promise<void>) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); await fn(); });
const button = (label: string) => [...host.querySelectorAll('button')].find(row => row.textContent?.trim() === label);
const click = async (label: string) => { expect(button(label)?.disabled).toBe(false); await act(async () => button(label)!.click()); };
const saved = async () => { const store = new MiningContributionJournalStore(miningContributionIdentity(identity.wallet)); try { return await store.read(); } finally { await store.close(); } };
const posts = () => vi.mocked(miningContributionOriginal).mock.calls.filter(([input]) => input.method === 'POST');
const mount = async (strict = false, enabled = true) => {
  const screen = <MiningContributionScreen actionsEnabled={enabled} onClose={() => undefined} />;
  await act(async () => root.render(strict ? <StrictMode>{screen}</StrictMode> : screen));
  await until(() => expect(button('REFRESH STOCK & RECEIPTS')?.disabled).toBe(false));
};
const review = async () => {
  const add = host.querySelector<HTMLButtonElement>('[aria-label="Add one Frost Quartz"]'); expect(add?.disabled).toBe(false);
  await act(async () => add!.click()); await click('REVIEW CONTRIBUTION'); await until(() => expect(button('CONFIRM CONTRIBUTION')).toBeDefined());
};
const consent = async () => { await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('indexedDB', new IDBFactory());
  const held = new Set<string>(); Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (name: string, _options: unknown, run: (lock: object | null) => Promise<unknown>) => {
    if (held.has(name)) return run(null); held.add(name); try { return await run({}); } finally { held.delete(name); }
  } } });
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.getState().setAuth(identity.wallet, true); useApp.getState().setScreen('base'); useApp.getState().setSelectedBaseId(id(1), false);
  accepted = false; currentView = view(); vi.spyOn(api, 'get').mockImplementation(async path => {
    if (path.startsWith('/mining/contributions?')) return currentView as never;
    throw Error(`Unexpected endpoint ${path}`);
  });
  vi.mocked(miningContributionOriginal).mockReset().mockImplementation(async input => {
    input.isCurrent();
    if (input.method === 'POST') { const operation = (await saved()).operation; expect(operation?.attemptRevision).not.toBeNull(); expect(operation?.command.request).toEqual(input.request); accepted = true; }
    const result = proof({ request: input.request }, accepted);
    if (result.status === 'accepted') await input.retainAccepted(result); input.isCurrent(); return result;
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(navigator, 'locks'); useApp.getState().setAuth(null); });
it('StrictMode reads only; all server resources, free cap and conditional irreversible terms precede explicit consent', async () => {
  await mount(true); expect(host.querySelectorAll('.sk-mining-resource')).toHaveLength(currentView.resources.length);
  expect(host.textContent).toContain('across your wallet'); expect(host.textContent).toContain('Days do not have to be consecutive');
  await review(); expect(posts()).toHaveLength(0); expect(button('CONFIRM CONTRIBUTION')?.disabled).toBe(true);
  const terms = host.querySelector('[aria-label="Confirm mining contribution"]')!.textContent;
  expect(terms).toContain('cannot be cancelled'); expect(terms).toContain('whole basket is permanently consumed'); expect(terms).toContain('whole basket is returned');
  await consent(); expect(button('CONFIRM CONTRIBUTION')?.disabled).toBe(false);
  await act(async () => window.dispatchEvent(new Event('focus'))); await until(() => expect(button('CONFIRM CONTRIBUTION')).toBeUndefined()); expect(posts()).toHaveLength(0);
});
it('explicit consent accepts once and archives historical proof without deriving spendable stock from receipt', async () => {
  await mount(); await review(); await consent(); await click('CONFIRM CONTRIBUTION'); await until(() => expect(host.textContent).toContain('CONTRIBUTION ACCEPTED'));
  expect(posts()).toHaveLength(1); expect((await saved()).operation?.proof?.status).toBe('accepted');
  expect(document.activeElement).toBe(host.querySelector('[aria-label="Saved mining contribution"]'));
  await until(() => expect(button('SAVE TO HISTORY')?.disabled).toBe(false)); await click('SAVE TO HISTORY');
  await until(() => expect(host.textContent).toContain('Contribution history (1)'));
  expect(host.querySelector('[aria-label="Frost Quartz quantity"]')?.getAttribute('aria-invalid')).toBe('false');
  expect(currentView.resources.find(row => row.resourceId === 'frost_quartz')!.available).toBe('10000'); expect(posts()).toHaveLength(1);
});
it('lost acknowledgement recovers on remount under paused admission using only original GET', async () => {
  const send = vi.mocked(miningContributionOriginal).getMockImplementation()!;
  vi.mocked(miningContributionOriginal).mockImplementation(async input => { if (input.method === 'POST') { accepted = true; throw Error('lost acknowledgement'); } return send(input); });
  await mount(); await review(); await consent(); await click('CONFIRM CONTRIBUTION'); await until(() => expect(button('CHECK ORIGINAL RECEIPT')?.disabled).toBe(false));
  await act(async () => root.render(null)); currentView.acceptingContributions = false; await mount();
  await until(() => expect(host.textContent).toContain('CONTRIBUTION ACCEPTED')); expect(posts()).toHaveLength(1); expect(host.textContent).toContain('New contributions are paused');
});
it('missing development blocks review and deeds display uncapped server allowance', async () => {
  currentView.developmentReady = false; currentView.pool = 'deed'; currentView.dailyCapValue = null; currentView.remainingValue = null;
  await mount(); const add = host.querySelector<HTMLButtonElement>('[aria-label="Add one Frost Quartz"]')!; await act(async () => add.click());
  expect(button('REVIEW CONTRIBUTION')?.disabled).toBe(true); expect(host.textContent).toContain('minimum mining buildings'); expect(host.textContent).toContain('Uncapped contributions'); expect(posts()).toHaveLength(0);
});
it('a late owned response survives unmount before storage closes and cannot update a new wallet view', async () => {
  const writes = vi.spyOn(MiningContributionJournalStore.prototype, 'compareAndSet'), closes = vi.spyOn(MiningContributionJournalStore.prototype, 'close');
  const entered = deferred(), release = deferred(), send = vi.mocked(miningContributionOriginal).getMockImplementation()!;
  vi.mocked(miningContributionOriginal).mockImplementation(async input => {
    if (input.method !== 'POST') return send(input); input.isCurrent(); entered.resolve(); await release.promise;
    const result = proof({ request: input.request }, true); if (result.status === 'accepted') await input.retainAccepted(result); input.isCurrent(); return result;
  });
  await mount(); await review(); const original = writes.mock.contexts[0]!; await consent(); await click('CONFIRM CONTRIBUTION'); await entered.promise;
  await act(async () => root.render(null)); expect(closes.mock.contexts).not.toContain(original);
  await act(async () => release.resolve()); await until(() => expect(closes.mock.contexts).toContain(original)); expect((await saved()).operation?.proof?.status).toBe('accepted');
});
it('local-only discovery remains hidden without a journal and finds saved baskets without network admission', async () => {
  await act(async () => root.render(<MiningContributionEntry discover={false} />)); await act(async () => new Promise(resolve => setTimeout(resolve, 30)));
  expect(host.textContent).toBe(''); expect(api.get).not.toHaveBeenCalled();
  await act(async () => root.render(null)); await mount(); await review(); await act(async () => root.render(null)); vi.mocked(api.get).mockClear();
  await act(async () => root.render(<MiningContributionEntry discover={false} />)); await until(() => expect(host.textContent).toContain('MINING & SAVED CONTRIBUTIONS'));
  expect(api.get).not.toHaveBeenCalled(); expect(posts()).toHaveLength(0);
});

// R0 changes the default build policy; these retained cases exercise the enabled interface.
import { beforeEach as beforeWebHoldCase, afterEach as afterWebHoldCase, vi as webHoldFixture } from 'vitest';
beforeWebHoldCase(() => { webHoldFixture.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); });
afterWebHoldCase(() => { webHoldFixture.unstubAllEnvs(); });
