// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { api } from '../../lib/api';
import { current, deferred, expeditions, inclusions, otherWallet, unavailable, wallet } from '../../lib/realmPassport/fixtures.test-support';
import { RealmPassportEntry } from './RealmPassportEntry';
import { RealmPassportScreen } from './RealmPassportScreen';
let root: Root, host: HTMLDivElement;
const until = (check: () => void) => vi.waitFor(async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); check(); });
const button = (label: string) => [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === label);
const click = async (label: string) => { expect(button(label)).toBeDefined(); await act(async () => button(label)!.click()); };
const mount = async () => { await act(async () => root.render(<RealmPassportScreen onClose={() => undefined} />)); await until(() => expect(host.textContent).toContain('Frostveil')); };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); useApp.getState().setAuth(wallet, true); useApp.getState().setScreen('bases');
  vi.spyOn(api, 'getPrivate').mockImplementation(async path => path.includes('/current') ? current() as never : path.includes('/inclusions') ? inclusions() as never : expeditions(path.includes('advanced') ? 'advanced' : 'starter') as never);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useApp.getState().setAuth(null); });
it('presents completed named journeys with expandable provenance and no gameplay or claim actions', async () => {
  await mount(); expect(host.querySelector('[role=dialog]')?.getAttribute('aria-label')).toBe('Realm Passport');
  expect(host.textContent).toContain('Paid Frostveil'); expect(host.textContent).toContain('Returned');
  expect(host.textContent).toContain('Trips still underway are not included'); expect(host.querySelector('details')?.open).toBe(false);
  expect(host.textContent).not.toContain('CLAIM'); expect(host.textContent).not.toContain('DISPATCH');
  await click('Advanced trips'); await until(() => expect(host.textContent).toContain('Advanced expedition'));
  expect(button('Advanced trips')?.getAttribute('aria-pressed')).toBe('true');
});
it('separates published totals from attested totals and explains carried cumulative records', async () => {
  await mount(); await click('Mining history'); await until(() => expect(host.textContent).toContain('Published participation'));
  const published = host.querySelector('[aria-label="Published participation"]')!, attested = host.querySelector('[aria-label="Attested on-chain"]')!;
  expect(published.textContent).toContain('10'); expect(published.textContent).toContain('12');
  expect(attested.textContent).toContain('7'); expect(attested.textContent).toContain('9');
  expect(host.textContent).toContain('1.25 KEEP'); expect(host.textContent).toContain('does not add a new activity day'); expect(host.textContent).toContain('not a complete lifetime activity score');
  expect(host.querySelector('[aria-label="Mining publication 1"] details')?.hasAttribute('open')).toBe(false);
});
it('absent attestation and unavailable current source never manufacture zeroes or erase publication history', async () => {
  vi.mocked(api.getPrivate).mockImplementation(async path => path.includes('/current') ? current(false) as never : path.includes('/inclusions') ? inclusions() as never : expeditions() as never);
  await mount(); await click('Mining history'); await until(() => expect(host.textContent).toContain('No attested record was found'));
  expect(host.querySelector('[aria-label="Attested on-chain"] dd')).toBeNull();
  vi.mocked(api.getPrivate).mockImplementation(async path => path.includes('/current') ? unavailable as never : inclusions() as never);
  await click('REFRESH'); await until(() => expect(host.textContent).toContain('does not mean your totals are zero'));
  expect(host.querySelector('[aria-label="Mining publication 1"]')).not.toBeNull();
});
it('distinguishes verified empty history from an unavailable or conflicting source and offers retry', async () => {
  vi.mocked(api.getPrivate).mockResolvedValue(expeditions('starter', [])); await act(async () => root.render(<RealmPassportScreen onClose={() => undefined} />));
  await until(() => expect(host.textContent).toContain('No completed trips found'));
  vi.mocked(api.getPrivate).mockResolvedValue({ ...unavailable, reason: 'SOURCE_CONFLICT' }); await click('REFRESH');
  await until(() => expect(host.textContent).toContain('History is unavailable')); expect(host.textContent).not.toContain('No completed trips found'); expect(button('TRY AGAIN')).toBeDefined();
});
it('does not discover a disabled provider but permits a configured unavailable history source', async () => {
  vi.mocked(api.getPrivate).mockRejectedValue(Error('503 disabled')); await act(async () => root.render(<RealmPassportEntry />));
  await until(() => expect(api.getPrivate).toHaveBeenCalled()); expect(button('REALM PASSPORT')).toBeUndefined();
  await act(async () => root.render(null)); vi.mocked(api.getPrivate).mockResolvedValue(unavailable); await act(async () => root.render(<RealmPassportEntry />));
  await until(() => expect(button('REALM PASSPORT')).toBeDefined()); await click('REALM PASSPORT'); await until(() => expect(host.textContent).toContain('History is unavailable'));
});
it('entry rejects late discovery and immediately hides the previous actor dialog on wallet change', async () => {
  await act(async () => root.render(<RealmPassportEntry />)); await until(() => expect(button('REALM PASSPORT')).toBeDefined()); await click('REALM PASSPORT');
  await until(() => expect(host.querySelector('[role=dialog]')).not.toBeNull());
  const pending = deferred<unknown>(); vi.mocked(api.getPrivate).mockReturnValue(pending.promise);
  await act(async () => useApp.getState().setAuth(otherWallet, true)); expect(host.querySelector('[role=dialog]')).toBeNull(); expect(button('REALM PASSPORT')).toBeUndefined();
  await act(async () => pending.resolve(expeditions())); expect(button('REALM PASSPORT')).toBeUndefined();
  const returning = deferred<unknown>(); vi.mocked(api.getPrivate).mockReturnValue(returning.promise);
  await act(async () => useApp.getState().setAuth(wallet, true)); expect(button('REALM PASSPORT')).toBeUndefined();
  await act(async () => returning.resolve(expeditions())); await until(() => expect(button('REALM PASSPORT')).toBeDefined());
  expect(host.querySelector('[role=dialog]')).toBeNull();
});
it('same-wallet cookie generation changes cannot reveal an earlier discovery reply', async () => {
  const pending = deferred<unknown>(); let valid = true; vi.spyOn(authCookies, 'current').mockImplementation(() => valid); vi.mocked(api.getPrivate).mockReturnValue(pending.promise);
  await act(async () => root.render(<RealmPassportEntry />)); valid = false; await act(async () => pending.resolve(expeditions())); expect(button('REALM PASSPORT')).toBeUndefined();
});

// R0 changes the default build policy; these retained cases exercise the enabled interface.
import { beforeEach as beforeWebHoldCase, afterEach as afterWebHoldCase, vi as webHoldFixture } from 'vitest';
beforeWebHoldCase(() => { webHoldFixture.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); });
afterWebHoldCase(() => { webHoldFixture.unstubAllEnvs(); });
