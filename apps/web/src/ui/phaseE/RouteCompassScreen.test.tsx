/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import vector from '../../../../../packages/shared/testFixtures/ordinaryEquipment.json';
import lensVector from '../../../../../packages/shared/testFixtures/surveyLens.json';
import {REALM_IDS} from '@shardkeep/shared/baseVisual';
import {PaidStarterRouteIdSchema,paidStarterRoutePreview} from '@shardkeep/shared/paidStarterExpeditions';
import {applyEquipmentFitting,equipmentFittingQuery} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import type {FleetJourneyEvent} from '@shardkeep/shared/fleetJourneyPresentation';
import { authCookies } from '../../auth/authCookieCoordinator';
import * as apiTransport from '../../lib/api';
import {bus} from '../../lib/events';
import { browserCompassIdentity } from '../../lib/routeCompass/browser';
import {CompassController} from '../../lib/routeCompass/controller';
import { CompassJournalStore, parseCompassCommand, type CompassCommand, type CompassOperation } from '../../lib/routeCompass/journal';
import { useApp } from '../../state/store';
import { RouteCompassScreen } from './RouteCompassScreen';

const wallet = vector.view.wallet, baseId = vector.request.baseId;
const otherBaseId = '00000000-0000-4000-8000-000000000099';
let root: Root, host: HTMLDivElement, acceptingJobs: boolean, accepted: boolean, completed: boolean;
let dropReply: boolean, acceptPost: boolean, failPaidPreview: boolean;
let submitted: { body: unknown; operation: CompassOperation | null }[];

const until = (check: () => void | Promise<void>) => vi.waitFor(async () => {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  await check();
});
const button = (name: string) => [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === name);
async function press(node: HTMLButtonElement | undefined) {
  expect(node).toBeDefined(); expect(node!.disabled).toBe(false);
  await act(async () => node!.click());
}
const click = (name: string) => press(button(name));
const review = () => host.querySelector<HTMLElement>('[aria-label="Saved equipment consent"]');
const posts = () => vi.mocked(apiTransport.requestRouteCompassOriginal).mock.calls.filter(([input]) => input.method === 'POST');
const originalReads = () => vi.mocked(apiTransport.requestRouteCompassOriginal).mock.calls.filter(([input]) => input.path.includes('/by-key/'));
async function saved() {
  const store = new CompassJournalStore(browserCompassIdentity(wallet), globalThis.indexedDB, 'pkw-route-compass-v1');
  try { return await store.read(); } finally { await store.close(); }
}
async function mount(actionsEnabled = true, strict = false, onClose: () => void = () => undefined) {
  const screen = <RouteCompassScreen actionsEnabled={actionsEnabled} onClose={onClose} />;
  await act(async () => root.render(strict ? <StrictMode>{screen}</StrictMode> : screen));
  await until(() => expect(button('REFRESH')?.disabled).toBe(false));
}
async function restart(actionsEnabled: boolean) {
  await act(async () => root.render(null));
  await mount(actionsEnabled);
}
async function craft() {
  const card = [...host.querySelectorAll('article')].find(node => node.querySelector('h4')?.textContent === 'Route Compass');
  await press(card?.querySelector('button') ?? undefined);
  await until(() => expect(button('CONFIRM CRAFT')?.disabled).toBe(false));
}
async function openHistory() {
  await click('History (1)');
  await press(host.querySelector<HTMLButtonElement>('[aria-label="Saved equipment history"] button') ?? undefined);
  await until(() => expect(button('Check original outcome')?.disabled).toBe(false));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('indexedDB', new IDBFactory());
  const held = new Set<string>();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (name: string, _options: unknown, run: (lock: object | null) => Promise<unknown>) => {
      if (held.has(name)) return run(null);
      held.add(name); try { return await run({}); } finally { held.delete(name); }
    },
  } });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session');
  vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.getState().setAuth(wallet, true);
  useApp.getState().setScreen('base');
  useApp.getState().setSelectedBaseId(baseId, false);
  acceptingJobs = true; accepted = false; completed = false; dropReply = false; acceptPost = true; failPaidPreview = false; submitted = [];
  // Keep the component, hook, controller, browser guards, schemas and IndexedDB real.
  // Only the API boundary supplies server fixtures or a lost acknowledgement.
  vi.spyOn(apiTransport, 'requestRouteCompassOriginal').mockImplementation(async input => {
    input.isCurrent();
    const url = new URL(input.path, window.location.origin), selectedBase = url.searchParams.get('baseId')!;
    let raw: unknown;
    if (url.pathname === '/ordinary-equipment') {
      raw = { ...lensVector.view, baseId: selectedBase, acceptingJobs, pendingJobs: [],
        craftingStock: lensVector.view.craftingStock.map(item => ({ ...item, available: '100' })),
        equipmentStock: lensVector.view.equipmentStock.map(item => ({ ...item, available: '1', pendingOutput: '0' })),
      };
    } else if (url.pathname === '/starter-expeditions') {
      const starter = url.searchParams.get('fitting') === 'survey_lens' ? lensVector.starterView : vector.starterView;
      raw = { ...starter, baseId: selectedBase, installation: { ...starter.installation, baseId: selectedBase } };
    } else if (url.pathname === '/starter-expeditions/paid-route') {
      if (failPaidPreview) throw new Error('Destination preview unavailable');
      const realm = Number(url.searchParams.get('realm'));
      const route = PaidStarterRouteIdSchema.options.map(id => paidStarterRoutePreview(id)).find(route => route.realmId === REALM_IDS[realm])!;
      const fitting = equipmentFittingQuery({fitting: url.searchParams.get('fitting')!, resourceId: url.searchParams.get('resourceId')!});
      raw = {wallet, baseId: selectedBase, realm, serverNow: vector.view.serverNow, authorization: 'none', acceptingDepartures: true,
        route: applyEquipmentFitting(route, fitting), coverage: {status: 'blocked', reason: 'NO_COVERAGE'}};
    } else if (url.pathname.startsWith('/ordinary-equipment/jobs')) {
      const operation = (await saved()).operation!;
      if (input.method === 'POST') {
        submitted.push({ body: structuredClone(input.body), operation });
        if (acceptPost) accepted = true;
        if (dropReply) throw new Error('Equipment response was lost. Check the original outcome.');
      }
      const key = operation.command.request.idempotencyKey;
      raw = accepted ? { ...vector.envelope, idempotencyKey: key,
        serverNow: completed ? vector.envelope.receipt.readyAt : vector.envelope.serverNow,
        receipt: { ...vector.envelope.receipt, request: operation.command.request, jobId: key },
        completion: completed ? { completedAt: vector.envelope.receipt.readyAt } : null,
      } : { wallet, idempotencyKey: key, serverNow: vector.view.serverNow, status: 'unknown', receipt: null, completion: null };
    } else {
      // A separate fleet preview outage must not disable workshop consent or recovery.
      throw new Error('Advanced fleet preview unavailable');
    }
    const result = await input.observe(200, raw);
    input.isCurrent();
    return result as never;
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'visibilityState'); Reflect.deleteProperty(navigator, 'locks');
  useApp.getState().setAuth(null);
});

it('workshop navigation and StrictMode only read; reviewing a craft saves its exact server recipe without starting it', async () => {
  await mount(true, true);
  const workshop = host.querySelector('[aria-label="Equipment workshop"]')!;
  expect(workshop.textContent).toContain('Route Compass'); expect(workshop.textContent).toContain('Survey Lens');
  expect(workshop.textContent).toContain('2 needed'); expect(workshop.textContent).toContain('100 owned');
  // Route availability belongs with expeditions, not unrelated Workshop tasks.
  expect(host.textContent).not.toContain('Some expedition previews are unavailable');
  await click('expeditions'); expect(host.textContent).toContain('Some expedition previews are unavailable'); expect(host.querySelector('[aria-label="Equipment"]')).not.toBeNull();
  await click('History (0)'); expect(host.textContent).toContain('No saved requests yet');
  await click('workshop'); await craft();
  const operation = (await saved()).operation!;
  expect(operation.command).toMatchObject({ kind: 'craft', request: { ...vector.request, idempotencyKey: expect.any(String) }, quote: vector.view.recipes[0] });
  expect(operation.attemptRevision).toBeNull(); expect(operation.proof).toBeNull();
  expect(review()?.textContent).toContain('2 prismstone lens + 2 crownsteel → 1 route compass');
  expect(review()?.textContent).toContain('5 minutes');
  expect(document.activeElement).toBe(review());
  expect(posts()).toHaveLength(0); expect(originalReads()).toHaveLength(0);
});

it('saved Lens departure consent retains both cargo legs when the current fitting and selected kingdom change', async () => {
  await mount(); await click('expeditions');
  await press([...host.querySelectorAll<HTMLButtonElement>('[aria-label="Equipment"] button')].find(node => node.querySelector('strong')?.textContent === 'Survey Lens'));
  await until(() => expect(button('REFRESH')?.disabled).toBe(false));
  await click('REVIEW FITTED DEPARTURE');
  await until(() => expect(button('CONFIRM FITTED DEPARTURE')?.disabled).toBe(false));
  const original = (await saved()).operation!.command;
  expect(original).toMatchObject({ kind: 'starter', request: { baseId, fitting: lensVector.starterView.fitting }, quote: lensVector.starterView.routes[0] });
  const terms = review()!.querySelector('.sk-equipment-terms')!.textContent;
  expect(terms).toContain('16 to stores'); expect(terms).toContain('4 to stores'); expect(terms).toContain('frost quartz');
  await click('expeditions');
  await press([...host.querySelectorAll<HTMLButtonElement>('[aria-label="Equipment"] button')].find(node => node.querySelector('strong')?.textContent === 'Route Compass'));
  await until(() => expect(button('REFRESH')?.disabled).toBe(false)); await openHistory();
  expect(review()!.querySelector('.sk-equipment-terms')!.textContent).toBe(terms);
  await act(async () => useApp.getState().setSelectedBaseId(otherBaseId, false));
  await until(() => expect(button('REFRESH')?.disabled).toBe(false)); await openHistory();
  expect(review()?.textContent).toContain('For the original kingdom');
  expect(review()!.querySelector('.sk-equipment-terms')!.textContent).toBe(terms);
  expect(button('CONFIRM FITTED DEPARTURE')?.disabled).toBe(true);
  expect((await saved()).operation!.command).toEqual(original);
  expect(posts()).toHaveLength(0);
});

it('only explicit confirmation starts crafting and paused restart can recover completion using the original key', async () => {
  await mount(); await craft();
  const command = (await saved()).operation!.command;
  await click('CONFIRM CRAFT');
  await until(() => expect(review()?.textContent).toContain('Accepted.'));
  // Removing the confirmed action must keep keyboard focus inside its receipt.
  expect(document.activeElement).toBe(review());
  expect(submitted).toHaveLength(1); expect(submitted[0]!.body).toEqual(command.request);
  expect(submitted[0]!.operation?.attemptRevision).toBeGreaterThan(0);
  expect(submitted[0]!.operation?.command).toEqual(command);
  expect(originalReads()[0]![0].path).toBe('/ordinary-equipment/jobs/by-key/' + command.request.idempotencyKey);
  acceptingJobs = false; completed = true; await restart(false);
  expect(host.textContent).toContain('New actions are paused'); expect(posts()).toHaveLength(1);
  await openHistory(); expect(review()?.textContent).toContain('Accepted.');
  await click('Check original outcome');
  await until(() => expect(review()?.textContent).toContain('Completed.'));
  expect(button('CONFIRM CRAFT')).toBeUndefined(); expect(button('RETRY SAME SAVED REQUEST')).toBeUndefined();
  expect((await saved()).operation?.command).toEqual(command);
  expect(posts()).toHaveLength(1);
  expect(originalReads().every(([input]) => input.path.endsWith(command.request.idempotencyKey))).toBe(true);
});

it('lost successful confirmation survives restart and recovers while paused without another POST', async () => {
  dropReply = true;
  await mount(); await craft(); const command = (await saved()).operation!.command;
  await click('CONFIRM CRAFT'); await until(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('response was lost'));
  expect((await saved()).operation?.attemptRevision).toBeGreaterThan(0);
  expect((await saved()).operation?.proof).toBeNull();
  acceptingJobs = false; await restart(false); await openHistory();
  expect(button('RETRY SAME SAVED REQUEST')?.disabled).toBe(true);
  expect(button('Close unused request')).toBeUndefined();
  await click('Check original outcome'); await until(() => expect(review()?.textContent).toContain('Accepted.'));
  expect((await saved()).operation?.command).toEqual(command);
  expect((await saved()).operation?.proof?.status).toBe('accepted'); expect(posts()).toHaveLength(1);
});

it('an unknown paused outcome keeps its saved request; resuming requires an explicit retry of that same request', async () => {
  dropReply = true; acceptPost = false;
  await mount(); await craft(); const command = (await saved()).operation!.command;
  await click('CONFIRM CRAFT'); await until(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('response was lost'));
  await restart(false); await openHistory(); await click('Check original outcome');
  await until(() => expect(button('Check original outcome')?.disabled).toBe(false));
  expect(button('RETRY SAME SAVED REQUEST')?.disabled).toBe(true); expect(button('Close unused request')).toBeUndefined();
  expect((await saved()).operation?.proof).toBeNull(); expect((await saved()).archives).toHaveLength(0);
  expect(posts()).toHaveLength(1);
  dropReply = false; acceptPost = true; await mount(true); await openHistory();
  expect(posts()).toHaveLength(1); await click('RETRY SAME SAVED REQUEST');
  await until(() => expect(review()?.textContent).toContain('Accepted.'));
  expect(submitted.map(item => item.body)).toEqual([command.request, command.request]);
  expect(submitted.every(item => item.operation?.attemptRevision !== null)).toBe(true);
  expect((await saved()).operation?.command).toEqual(command); expect((await saved()).archives).toHaveLength(0);
});

it('Lens destinations explain incompatible primary cargo, avoid its request, and clear stale or failed compatible previews without changing saved consent', async () => {
  await mount(); await click('expeditions');
  await press([...host.querySelectorAll<HTMLButtonElement>('[aria-label="Equipment"] button')].find(node => node.querySelector('strong')?.textContent === 'Survey Lens'));
  await until(() => expect(button('REFRESH')?.disabled).toBe(false));
  await click('REVIEW FITTED DEPARTURE');
  await until(() => expect(button('CONFIRM FITTED DEPARTURE')?.disabled).toBe(false));
  const original = (await saved()).operation!.command;
  await click('expeditions');
  const select = host.querySelector<HTMLSelectElement>('[aria-label="Paid destination"]')!;
  const frostveil = [...select.options].find(option => option.value === String(REALM_IDS.indexOf('frostveil')))!;
  expect(frostveil.disabled).toBe(true); expect(frostveil.textContent).toContain('already carries frost quartz');
  expect(host.textContent).toContain('Choose another destination or second material.');
  // Even a synthetic change event cannot enable a request for a disabled destination.
  await act(async () => { select.value = frostveil.value; select.dispatchEvent(new Event('change', {bubbles: true})); });
  expect(button('CHECK DESTINATION')?.disabled).toBe(true);
  await act(async () => button('CHECK DESTINATION')!.click());
  const paidReads = () => vi.mocked(apiTransport.requestRouteCompassOriginal).mock.calls.filter(([input]) => input.path.startsWith('/starter-expeditions/paid-route'));
  expect(paidReads()).toHaveLength(0);
  const choose = async (realm: typeof REALM_IDS[number]) => act(async () => { select.value = String(REALM_IDS.indexOf(realm)); select.dispatchEvent(new Event('change', {bubbles: true})); });
  await choose('elderwood'); await click('CHECK DESTINATION');
  await until(() => expect(host.textContent).toContain('This destination requires active access.'));
  const quote = applyEquipmentFitting(paidStarterRoutePreview('paid_elderwood'), {itemId: 'survey_lens', policyVersion: 1, resourceId: 'frost_quartz'});
  const card = [...host.querySelectorAll('article')].find(node => node.textContent?.includes('This destination requires active access.'))!;
  expect(card.textContent).toContain(`${quote.netQuantity} to stores`); expect(card.textContent).toContain(`${quote.secondaryOutput!.netQuantity} to stores`);
  expect(card.textContent).toContain('heartwood logs'); expect(card.textContent).toContain('frost quartz');
  expect(paidReads()).toHaveLength(1);
  await choose('sunscar'); expect(host.textContent).not.toContain('This destination requires active access.');
  await click('CHECK DESTINATION'); await until(() => expect(host.textContent).toContain('This destination requires active access.'));
  failPaidPreview = true; await click('CHECK DESTINATION');
  await until(() => expect(host.querySelector('[role="alert"]')?.textContent).toBe('Destination preview unavailable'));
  expect(host.textContent).not.toContain('This destination requires active access.');
  expect((await saved()).operation!.command).toEqual(original); expect(posts()).toHaveLength(0);
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return {promise, resolve}; }
async function starterReview() {
  await click('expeditions'); await click('REVIEW FITTED DEPARTURE');
  await until(() => expect(button('CONFIRM FITTED DEPARTURE')?.disabled).toBe(false));
  const command = (await saved()).operation!.command;
  if (command.kind !== 'starter') throw Error('Expected starter consent');
  return command;
}
function departureEvent(command: Exclude<CompassCommand, {kind: 'craft'}>): FleetJourneyEvent {
  return {version: 1, kind: 'departure', baseId: command.request.baseId,
    installationId: command.request.installationId, expeditionId: command.request.idempotencyKey,
    berthId: vector.starterView.installation.berthId, at: vector.starterEnvelope.receipt.departedAt,
    vehicle: command.kind === 'starter' ? {family: 'starter'} : {family: command.quote.family, tier: command.quote.tier},
    wake: {state: 'legacy', visual: null}};
}
/** UI-only bus boundary: accepted producer provenance is verified separately.
 * Keep the real controller, durable retention and browser guard, holding its
 * final response so the event arrives at the real in-progress UI seam. */
function heldStarterOriginal(acceptedGet = false) {
  const entered = deferred(), release = deferred(), finished = deferred(), original = vi.mocked(apiTransport.requestRouteCompassOriginal).getMockImplementation()!;
  vi.mocked(apiTransport.requestRouteCompassOriginal).mockImplementation(async input => {
    if (!input.path.startsWith('/starter-expeditions/by-key/') && !(input.path === '/starter-expeditions' && input.method === 'POST')) return original(input);
    input.isCurrent(); const command = (await saved()).operation!.command;
    if (command.kind !== 'starter') throw Error('Expected starter original');
    const key = command.request.idempotencyKey;
    const acceptedReply = {...vector.starterEnvelope, idempotencyKey: key,
      receipt: {...vector.starterEnvelope.receipt, expeditionId: key, request: command.request, route: command.quote}};
    const raw = acceptedGet || input.method === 'POST' ? acceptedReply : {wallet, idempotencyKey: key,
      serverNow: vector.starterEnvelope.serverNow, status: 'unknown', receipt: null, return: null};
    // No 201/header marker: this test deliberately supplies only the UI's bus
    // callback, and does not exercise or claim a real departure producer.
    const result = await input.observe(200, raw);
    if (acceptedGet || input.method === 'POST') {
      entered.resolve();
      try { await release.promise; input.isCurrent(); return result as never; }
      finally { finished.resolve(); }
    }
    input.isCurrent(); return result as never;
  });
  return {entered, release, finished};
}
async function emitJourney(event: FleetJourneyEvent) { await act(async () => bus.emit('fleet:journey', event)); }

it('reveals the base once for the exact confirmed departure after durable retention, never unrelated or return events', async () => {
  // Parent closure really unmounts the dialog, as RouteCompassEntry does. Its
  // existing stale-publication guard may retire; durable acceptance must survive.
  const onClose = vi.fn(() => root.render(null)); await mount(true, false, onClose); const command = await starterReview(), event = departureEvent(command);
  await emitJourney(event); expect(onClose).not.toHaveBeenCalled(); // Reviewing alone is not confirmation.
  const held = heldStarterOriginal(); await click('CONFIRM FITTED DEPARTURE'); await held.entered.promise;
  try {
    expect((await saved()).operation?.proof?.status).toBe('accepted');
    for (const other of [{...event, baseId: otherBaseId}, {...event, installationId: otherBaseId},
      {...event, expeditionId: otherBaseId}, {...event, vehicle: {family: 'survey_balloon', tier: 1} as const},
      {...event, kind: 'return' as const, returnId: otherBaseId}]) await emitJourney(other);
    expect(onClose).not.toHaveBeenCalled();
    await emitJourney(event); await emitJourney(event); expect(onClose).toHaveBeenCalledOnce();
    expect((await saved()).operation?.command).toEqual(command);
  } finally { held.release.resolve(); }
  await held.finished.promise; expect(host.querySelector('[role="dialog"]')).toBeNull();
  await emitJourney(event); expect(onClose).toHaveBeenCalledOnce();
  expect(posts()).toHaveLength(1); expect((await saved()).operation?.proof?.status).toBe('accepted');
});

it('binds the armed advanced departure to its reviewed family and tier without closing for another vehicle', async () => {
  // Only the controller's action is held here; no synthetic advanced request is
  // sent. The saved command and actual hook/account guards remain strict.
  const command = parseCompassCommand({kind: 'advanced', request: vector.advancedEnvelope.receipt.request, quote: vector.advancedEnvelope.receipt.route});
  if (command.kind !== 'advanced') throw Error('Expected advanced consent');
  const store = new CompassJournalStore(browserCompassIdentity(wallet));
  try { await store.compareAndSet(0, journal => ({...journal, operation: {command, attemptRevision: null, proof: null, refusal: null}})); }
  finally { await store.close(); }
  const onClose = vi.fn(), entered = deferred(), release = deferred();
  const recover = vi.spyOn(CompassController.prototype, 'recover').mockImplementation(async () => {entered.resolve(); await release.promise;});
  await mount(true, false, onClose); await openHistory(); await click('CONFIRM FITTED DEPARTURE'); await entered.promise;
  try {
    const event = departureEvent(command);
    await emitJourney({...event, vehicle: {family: 'starter'}});
    await emitJourney({...event, vehicle: {family: 'cargo_cutter', tier: 1}});
    await emitJourney({...event, vehicle: {family: 'survey_balloon', tier: 2}});
    expect(onClose).not.toHaveBeenCalled(); await emitJourney(event); expect(onClose).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledWith(command.request.idempotencyKey, true);
    expect(posts()).toHaveLength(0);
  } finally { release.resolve(); }
  await until(() => expect(button('REFRESH')?.disabled).toBe(false));
});

it('does not reveal for a history recovery or a later callback after recovery finishes', async () => {
  const onClose = vi.fn(); await mount(true, false, onClose); const command = await starterReview(), event = departureEvent(command);
  const held = heldStarterOriginal(true); await click('Check original outcome'); await held.entered.promise;
  try { await emitJourney(event); expect(onClose).not.toHaveBeenCalled(); }
  finally { held.release.resolve(); }
  await until(() => expect(review()?.textContent).toContain('Accepted.'));
  await emitJourney(event); expect(onClose).not.toHaveBeenCalled(); expect(posts()).toHaveLength(0);
});

it.each(['hidden', 'account'] as const)('does not reveal a late departure after %s retirement, while keeping the retained original', async change => {
  const onClose = vi.fn(); await mount(true, false, onClose); const command = await starterReview(), event = departureEvent(command);
  const held = heldStarterOriginal(); await click('CONFIRM FITTED DEPARTURE'); await held.entered.promise;
  try {
    if (change === 'hidden') await act(async () => {
      Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    else await act(async () => useApp.getState().setAuth('11111111111111111111111111111113', true));
    await emitJourney(event); expect(onClose).not.toHaveBeenCalled();
    expect((await saved()).operation?.command).toEqual(command);
    expect((await saved()).operation?.proof?.status).toBe('accepted');
  } finally { held.release.resolve(); }
  await until(() => expect(posts()).toHaveLength(1));
});
