/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildPhaseECatalogue } from '@shardkeep/shared/phaseE';
import { paidStarterRoutePreview, PaidStarterRouteIdSchema } from '@shardkeep/shared/paidStarterExpeditions';
import { applyEquipmentFitting } from '@shardkeep/shared/phaseEOrdinaryEquipment';
import { REALM_SALE_REALMS } from '@shardkeep/shared/realmSaleOfferApi';
import { type PaidStarterExpeditionView } from '@shardkeep/shared/paidStarterExpeditionApi';
import { StarterExpeditionEnvelopeSchema } from '@shardkeep/shared/starterExpeditionApi';
import { authCookies } from '../../auth/authCookieCoordinator';
import { api } from '../../lib/api';
import { useApp } from '../../state/store';
import { useStarterExpedition } from '../../lib/starterExpedition/useStarterExpedition';
import { StarterExpeditionJournalStore, type StarterExpeditionCommand } from '../../lib/starterExpedition/journal';
import { id, identity, now, start, view, deferred } from '../../lib/starterExpedition/fixtures.test-support';
import { funds } from '../../lib/workshop/snapshot.test-support';
import { PaidStarterExpeditionScreen } from './PaidStarterExpeditionScreen';
import { PaidStarterExpeditionEntry } from './PaidStarterExpeditionEntry';
import observation from '../../lib/paidStarterExpeditions/access.fixture.json';

vi.mock('../../lib/starterExpedition/useStarterExpedition', () => ({ useStarterExpedition: vi.fn() }));
let host: HTMLDivElement, root: Root, visible: DocumentVisibilityState, generation: number;
let lifecycle: ReturnType<typeof useStarterExpedition>;
const controller = { beginPaidDeparture: vi.fn(), reviewCommand: vi.fn(), confirm: vi.fn(), open: vi.fn(), abandonDraft: vi.fn(), archiveRefusal: vi.fn(), checkArchived: vi.fn() };
const button = (name: string) => [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === name);
const until = (check: () => void) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); check(); });
const mount = async (enabled = true) => act(async () => root.render(<StrictMode><PaidStarterExpeditionScreen actionsEnabled={enabled} onClose={() => undefined} /></StrictMode>));
const click = async (name: string) => { expect(button(name)?.disabled).toBe(false); await act(async () => button(name)!.click()); };
const select = async (realm: number) => act(async () => { const node = host.querySelector<HTMLSelectElement>('[aria-label="Expedition destination realm"]')!; node.value = String(realm); node.dispatchEvent(new Event('change', { bubbles: true })); });
function paidCommand(realm = 0): StarterExpeditionCommand {
  const route = paidStarterRoutePreview(PaidStarterRouteIdSchema.options[realm]!);
  return { ...start, request: { ...start.request, routeId: route.routeId, routeVersion: route.routeCatalogueVersion, rewardVersion: route.rewardTableVersion }, route } as StarterExpeditionCommand;
}
function selected(realm = 0): PaidStarterExpeditionView {
  return { wallet: identity.wallet, baseId: id(1), realm, serverNow: now, authorization: 'none', acceptingDepartures: true,
    route: paidStarterRoutePreview(PaidStarterRouteIdSchema.options[realm]!), coverage: { status: 'covered', expiresAt: String(Date.parse(now) / 1000 + 3600), observedAt: now } };
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('indexedDB', new IDBFactory());
  visible = 'visible'; generation = 1; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible });
  vi.spyOn(authCookies, 'captureGeneration').mockImplementation(() => generation); vi.spyOn(authCookies, 'current').mockImplementation(n => n === generation);
  useApp.getState().setAuth(identity.wallet, true); useApp.getState().setScreen('bases'); useApp.getState().setSelectedBaseId(id(1), false);
  Object.values(controller).forEach(fn => fn.mockReset().mockResolvedValue(undefined));
  lifecycle = { state: { loaded: true, busy: false, journal: { version: 1, identity, revision: 0, operation: null, archives: [] }, review: null, error: null },
    snapshot: { view: view(), balances: funds, enabled: true }, refreshError: null, run: vi.fn(action => { void action(controller as never); }), refresh: vi.fn(), dismiss: vi.fn(), finish: vi.fn(), actionsAllowed: true };
  vi.mocked(useStarterExpedition).mockImplementation(enabled => ({ ...lifecycle, actionsAllowed: enabled && lifecycle.actionsAllowed }));
  vi.spyOn(api, 'getPrivate').mockImplementation(async path => (path === '/game/phase-e/catalogue' ? buildPhaseECatalogue() : selected(Number(new URL(path, 'https://test.invalid').searchParams.get('realm')))) as never);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(document, 'visibilityState'); useApp.getState().setAuth(null); });

it('requires explicit destination and review; covered display never grants a departure or starts a POST', async () => {
  await mount(); expect(api.getPrivate).not.toHaveBeenCalled(); expect(button('REVIEW PAID REALM DEPARTURE')?.disabled).toBe(true);
  expect([...host.querySelectorAll('option')].slice(1).map(n => n.textContent)).toEqual(REALM_SALE_REALMS.map(r => r.name));
  await select(2); await until(() => expect(button('REVIEW PAID REALM DEPARTURE')?.disabled).toBe(false));
  expect(host.textContent).toContain('Coverage was observed'); expect(host.textContent).toContain('checked again at departure');
  expect(host.textContent).toContain('Current kingdom stock'); expect(controller.beginPaidDeparture).not.toHaveBeenCalled(); expect(controller.confirm).not.toHaveBeenCalled();
  await click('REVIEW PAID REALM DEPARTURE'); expect(controller.beginPaidDeparture).toHaveBeenCalledExactlyOnceWith(id(1), 2);
  const command = paidCommand(2); lifecycle.state = { ...lifecycle.state, journal: { ...lifecycle.state.journal!, operation: { command, attemptRevision: null, proof: null, refusal: null } }, review: { command } as never };
  await mount(); const review = host.querySelector('[aria-label="Confirm paid realm departure"]')!.textContent!;
  expect(review).toContain(command.request.baseId); expect(review).toContain(command.installation.installationId);
  expect(review).toContain('including after transfer'); expect(review).toContain('No SOL, KEEP, Gems or SHARDS payment');
  const cargo = host.querySelector('[aria-label="Confirm paid realm departure"] [aria-label="Cargo outcome"]')!;
  expect([...cargo.querySelectorAll('dt')].map(n => n.textContent)).toEqual(['Gross cargo', 'Island pool', 'To kingdom']);
  expect([...cargo.querySelectorAll('dd')].map(n => n.textContent)).toEqual([command.route.grossQuantity, command.route.islandPoolQuantity, command.route.netQuantity].map(n => `${BigInt(n).toLocaleString('en-US')} ${command.route.resourceId.replaceAll('_', ' ')}`));
  expect(document.activeElement).toBe(host.querySelector('[aria-label="Confirm paid realm departure"]'));
  await click('CONFIRM PAID REALM DEPARTURE'); expect(controller.confirm).toHaveBeenCalledOnce();
});

it('an attempted paid request remains GET-only even if obsolete review state exists', async () => {
  const command = paidCommand(); lifecycle.state = { ...lifecycle.state, journal: { ...lifecycle.state.journal!, operation: { command, attemptRevision: 2, proof: null, refusal: null } }, review: { command } as never };
  await mount(); expect(host.textContent).toContain('ORIGINAL OUTCOME UNKNOWN');
  expect(button('REVIEW ORIGINAL REQUEST')).toBeUndefined(); expect(button('CONFIRM PAID REALM DEPARTURE')).toBeUndefined();
  expect(button('ARCHIVE UNUSED DRAFT')).toBeUndefined(); expect(button('ARCHIVE DECLINED REQUEST')).toBeUndefined();
  await click('CHECK ORIGINAL RECEIPT'); expect(controller.open).toHaveBeenCalledOnce(); expect(controller.confirm).not.toHaveBeenCalled(); expect(controller.reviewCommand).not.toHaveBeenCalled();
});

it.each(['home', 'installation', 'lodge', 'flight', 'paused'] as const)('does not offer a departure without the current %s prerequisite', async missing => {
  lifecycle.snapshot!.enabled = false;
  if (missing === 'home') lifecycle.snapshot!.view.home = null;
  if (missing === 'installation') lifecycle.snapshot!.view.installation = null;
  if (missing === 'lodge') lifecycle.snapshot!.view.lodgeCompletedAt = null;
  if (missing === 'paused') lifecycle.snapshot!.view.acceptingDepartures = false;
  if (missing === 'flight') lifecycle.snapshot!.view.flight = { route: start.route } as never;
  await mount(); await select(0); await until(() => expect(host.textContent).toContain('Coverage was observed'));
  expect(button('REVIEW PAID REALM DEPARTURE')?.disabled).toBe(true); expect(controller.beginPaidDeparture).not.toHaveBeenCalled();
});

it.each(['unavailable', 'blocked'] as const)('keeps %s coverage advisory and disabled', async status => {
  vi.mocked(api.getPrivate).mockResolvedValue({ ...selected(), coverage: status === 'blocked' ? { status, reason: 'NO_COVERAGE' } : { status } } as never);
  await mount(); await select(0); await until(() => expect(host.textContent).toContain(status === 'unavailable' ? 'Current coverage is unavailable' : 'No current paid coverage'));
  expect(button('REVIEW PAID REALM DEPARTURE')?.disabled).toBe(true); expect(host.textContent).not.toContain('Coverage was observed');
});

it('rejects a delayed old selection after realm ABA and does not trust mismatched actor/base responses', async () => {
  const old = deferred(); let calls = 0;
  vi.mocked(api.getPrivate).mockImplementation(async path => { const realm = Number(new URL(path, 'https://test.invalid').searchParams.get('realm')); if (++calls === 1) { await old.promise; return selected(realm) as never; } return { ...selected(realm), baseId: id(9) } as never; });
  await mount(); await select(0); await until(() => expect(calls).toBe(1)); await select(1); await select(0);
  await until(() => expect(host.textContent).toContain('could not be verified')); await act(async () => old.resolve());
  expect(host.textContent).not.toContain('Coverage was observed'); expect(button('REVIEW PAID REALM DEPARTURE')?.disabled).toBe(true);
  vi.mocked(api.getPrivate).mockResolvedValue({ ...selected(0), wallet: '1'.repeat(31) + '2' } as never);
  await click('REFRESH EXPEDITIONS & RECEIPTS'); await until(() => expect(host.textContent).toContain('could not be verified'));
  expect(button('REVIEW PAID REALM DEPARTURE')?.disabled).toBe(true);
});

it('retires pending observations on freeze, cookie changes and selected-base ABA', async () => {
  const old = deferred(); vi.mocked(api.getPrivate).mockImplementation(async () => { await old.promise; return selected() as never; });
  await mount(); await select(0); await until(() => expect(api.getPrivate).toHaveBeenCalled());
  await act(async () => { document.dispatchEvent(new Event('freeze')); generation++; useApp.getState().setSelectedBaseId(id(2), false); useApp.getState().setSelectedBaseId(id(1), false); });
  await act(async () => old.resolve()); expect(host.textContent).not.toContain('Coverage was observed'); expect(button('REVIEW PAID REALM DEPARTURE')?.disabled).toBe(true);
  vi.mocked(api.getPrivate).mockResolvedValue(selected() as never); await act(async () => document.dispatchEvent(new Event('resume')));
  await until(() => expect(button('REVIEW PAID REALM DEPARTURE')?.disabled).toBe(false));
});

it.each(['cookie', 'base', 'hidden'] as const)('does not publish a pending selected response after a %s change', async change => {
  const old = deferred(); let calls = 0;
  vi.mocked(api.getPrivate).mockImplementation(async () => { if (++calls === 1) { await old.promise; return selected() as never; } throw Error('new scope offline'); });
  await mount(); await select(0); await until(() => expect(calls).toBe(1));
  await act(async () => {
    if (change === 'cookie') generation++;
    if (change === 'base') { useApp.getState().setSelectedBaseId(id(2), false); useApp.getState().setSelectedBaseId(id(1), false); }
    if (change === 'hidden') { visible = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); }
    old.resolve();
  });
  expect(host.textContent).not.toContain('Coverage was observed'); expect(button('REVIEW PAID REALM DEPARTURE')?.disabled).toBe(true);
});

it('shows archived paid acceptance and automatic return without making the receipt spendable stock', async () => {
  const command = paidCommand(), departedAt = observation.finality.observedAt;
  useApp.getState().setAuth(observation.wallet, true); lifecycle.state.journal!.identity = { ...identity, wallet: observation.wallet }; lifecycle.snapshot!.view.wallet = observation.wallet;
  const returnsAt = new Date(Date.parse(departedAt) + command.route.durationSec * 1000).toISOString();
  const proof = StarterExpeditionEnvelopeSchema.parse({ wallet: observation.wallet, idempotencyKey: command.request.idempotencyKey, serverNow: returnsAt, status: 'accepted',
    receipt: { wallet: observation.wallet, request: command.request, expeditionId: command.request.idempotencyKey, installationId: command.installation.installationId,
      route: { ...command.route, access: { kind: 'paid_realm', policyVersion: 1, observation } }, departedAt, returnsAt, termId: id(6), termHash: 'a'.repeat(64) },
    return: { returnId: id(7), returnedAt: returnsAt } });
  lifecycle.state.journal!.archives = [{ reason: 'accepted', operation: { command, attemptRevision: 2, proof, refusal: null }, evidence: null }];
  await mount(false); expect(host.textContent).toContain('PAID EXPEDITION HISTORY (1)'); expect(host.textContent).toContain('Automatic return observed:');
  expect(host.textContent).toContain('Historical departure evidence does not grant access to another trip');
  const stocks = [...host.querySelectorAll('[aria-label="Current raw resource stock"] dd')];
  expect(stocks).toHaveLength(lifecycle.snapshot!.view.rawStock.length); expect(stocks.every(node => node.textContent?.includes('0 available · 0 reserved · 0 total'))).toBe(true);
  await click('CHECK AUTOMATIC RETURN'); expect(controller.checkArchived).toHaveBeenCalledExactlyOnceWith(command.request.idempotencyKey);
  expect(controller.confirm).not.toHaveBeenCalled(); expect([...host.querySelectorAll('button')].some(node => /collect/i.test(node.textContent ?? ''))).toBe(false);
});

it('offers explicit refusal archival only for its retained first refusal, even while orders are paused', async () => {
  lifecycle.state.journal!.operation = { command: paidCommand(), attemptRevision: 2, proof: null, refusal: { phase: 'first_post', status: 409, code: 'EXPEDITION_ACCESS_EXPIRED' } };
  await mount(false); expect(host.textContent).toContain('ORIGINAL REQUEST DECLINED'); expect(button('REVIEW ORIGINAL REQUEST')).toBeUndefined();
  await click('ARCHIVE DECLINED REQUEST'); expect(controller.archiveRefusal).toHaveBeenCalledOnce(); expect(controller.confirm).not.toHaveBeenCalled();
});

it('discovers paid local history while paused and providerless using the existing starter journal', async () => {
  const command = paidCommand(); lifecycle.state.journal!.operation = { command, attemptRevision: 2, proof: null, refusal: null };
  vi.spyOn(StarterExpeditionJournalStore.prototype, 'read').mockResolvedValue(lifecycle.state.journal!); vi.mocked(api.getPrivate).mockRejectedValue(Error('offline'));
  lifecycle.snapshot = null; await act(async () => root.render(<PaidStarterExpeditionEntry actionsEnabled={false} />));
  await until(() => expect(button('PAID EXPEDITIONS & HISTORY')).toBeDefined()); await click('PAID EXPEDITIONS & HISTORY');
  await until(() => expect(button('CHECK ORIGINAL RECEIPT')?.disabled).toBe(false)); expect(host.textContent).toContain('Game orders are paused');
  expect(host.textContent).toContain('do not show spendable stock'); expect(controller.confirm).not.toHaveBeenCalled();
});

it('catalogue discovery opens the separate overlay without a current provider or automatic mutation', async () => {
  await act(async () => root.render(<PaidStarterExpeditionEntry actionsEnabled />)); await until(() => expect(button('PAID REALM EXPEDITIONS')).toBeDefined());
  await click('PAID REALM EXPEDITIONS'); await until(() => expect(host.querySelector('[aria-label="Expedition destination realm"]')).not.toBeNull());
  expect(controller.beginPaidDeparture).not.toHaveBeenCalled(); expect(controller.confirm).not.toHaveBeenCalled();
});

// A saved Lens review must not silently hide its second cargo leg or retune old quantities.
it('displays both retained survey cargo legs and exact large amounts before deliberate confirmation', async () => {
  const original = paidCommand(REALM_SALE_REALMS.findIndex(realm => realm.id === 'seeker-reach')), fitting = { itemId: 'survey_lens' as const, policyVersion: 1 as const, resourceId: 'heartwood_logs' as const };
  const fitted = applyEquipmentFitting(original.route, fitting);
  const command: StarterExpeditionCommand = { ...original, request: { ...original.request, fitting }, route: { ...fitted, grossQuantity: '9007199254740997', islandPoolQuantity: '6', netQuantity: '9007199254740991' } };
  lifecycle.state = { ...lifecycle.state, journal: { ...lifecycle.state.journal!, operation: { command, attemptRevision: null, proof: null, refusal: null } }, review: { command } as never };
  await mount();
  const review = host.querySelector('[aria-label="Confirm paid realm departure"]')!;
  expect(review.querySelector('[aria-label="Cargo outcome"]')!.textContent).toContain('9,007,199,254,740,991');
  const survey = review.querySelector('[aria-label="Survey cargo outcome"]')!;
  expect([...survey.querySelectorAll('dd')].map(n => n.textContent)).toEqual([fitted.secondaryOutput!.grossQuantity, fitted.secondaryOutput!.islandPoolQuantity, fitted.secondaryOutput!.netQuantity].map(n => `${BigInt(n).toLocaleString('en-US')} heartwood logs`));
  expect(review.textContent).toContain('Fitted equipment: survey lens');
  expect(review.textContent).toContain('Realm expedition · Solana Reach');
  expect(controller.confirm).not.toHaveBeenCalled();
  await click('CONFIRM PAID REALM DEPARTURE'); expect(controller.confirm).toHaveBeenCalledOnce();
});

// R0 changes the default build policy; these retained cases exercise the enabled interface.
import { beforeEach as beforeWebHoldCase, afterEach as afterWebHoldCase, vi as webHoldFixture } from 'vitest';
beforeWebHoldCase(() => { webHoldFixture.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); });
afterWebHoldCase(() => { webHoldFixture.unstubAllEnvs(); });
