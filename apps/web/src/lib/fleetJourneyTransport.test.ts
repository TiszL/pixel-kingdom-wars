import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { paidStarterRoutePreview } from '@shardkeep/shared/paidStarterExpeditions';
import observation from './paidStarterExpeditions/access.fixture.json';
import vector from '../../../../packages/shared/testFixtures/ordinaryEquipment.json';
import { identity, proof, start } from './starterExpedition/fixtures.test-support';
const presentation = vi.hoisted(() => ({ publish: vi.fn(async () => {}), capture: vi.fn((_base: string, guard: () => void) => ({ current: () => { guard(); return true; } })) }));
vi.mock('./fleetJourneyPresentation', () => ({ captureFleetJourneyPublication: presentation.capture, publishFleetDeparture: presentation.publish }));
beforeEach(() => { vi.resetModules(); presentation.publish.mockClear(); vi.stubGlobal('navigator', { locks: { request: async (_n: unknown, _o: unknown, run: () => Promise<unknown>) => run() } }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const families = ['plain-starter', 'paid-unfitted-starter', 'fitted-starter', 'fitted-advanced', 'plain-advanced'] as const;
async function input(family: typeof families[number], guard: () => void, retain: (raw: unknown) => Promise<void>) {
  if (family === 'plain-starter' || family === 'paid-unfitted-starter') {
    const { unpaidOriginal } = await import('./unpaidResources/transport');
    const route = paidStarterRoutePreview('paid_frostveil'), request = { ...start.request, routeId: route.routeId, routeVersion: route.routeCatalogueVersion, rewardVersion: route.rewardTableVersion };
    const at = observation.finality.observedAt;
    const value = family === 'plain-starter' ? proof(start, true) : { wallet: observation.wallet, idempotencyKey: request.idempotencyKey, serverNow: at, status: 'accepted', return: null, receipt: { wallet: observation.wallet, request, expeditionId: request.idempotencyKey, installationId: request.installationId, route: { ...route, access: { kind: 'paid_realm', policyVersion: 1, observation } }, departedAt: at, returnsAt: new Date(Date.parse(at) + route.durationSec * 1000).toISOString(), termId: '00000000-0000-4000-8000-000000000006', termHash: 'ab'.repeat(32) } };
    return { value, run: (method: 'GET' | 'POST') => unpaidOriginal({ wallet: value.wallet, command: { kind: 'expedition', request: family === 'plain-starter' ? start.request : request },
      method, firstAttempt: method === 'POST', isCurrent: () => { guard(); return true; }, retainAccepted: retain, retainRefusal: async () => {} }) };
  }
  const kind = family === 'fitted-starter' ? 'starter' : 'advanced';
  const value = kind === 'starter' ? vector.starterEnvelope : vector.advancedEnvelope;
  if (family === 'plain-advanced') {
    const { requestVehicle } = await import('./vehicles/transport');
    return { value, run: (method: 'GET' | 'POST') => requestVehicle({ actor: value.wallet, isCurrent: () => { guard(); return true; }, retain,
      request: method === 'POST' ? { kind: 'expedition', action: 'create', body: value.receipt.request } : { kind: 'expedition', action: 'by-key', key: value.idempotencyKey } }) };
  }
  const { compassOriginal } = await import('./routeCompass/transport');
  const { parseCompassCommand } = await import('./routeCompass/journal');
  const command = parseCompassCommand({ kind, request: value.receipt.request, quote: value.receipt.route });
  return { value, run: (method: 'GET' | 'POST') => compassOriginal({ identity: { ...identity, wallet: value.wallet }, command,
    method, firstAttempt: method === 'POST', guard, retain, refused: async () => {} }) };
}
it.each(families)('%s requires both fresh markers after durable retention and never emits from recovery', async family => {
  let retained = false, status = 200, marker = false;
  const retain = vi.fn(async () => { retained = true; });
  const f = await input(family, () => {}, retain);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(f.value), { status, headers: marker ? { 'x-pkw-journey-created': '1' } : {} })));
  presentation.publish.mockImplementation(async () => { expect(retained).toBe(true); });
  for (const state of [[200, true], [201, false]] as const) { [status, marker] = state; await f.run('POST'); }
  status = 201; marker = true; await f.run('GET');
  expect(presentation.publish).not.toHaveBeenCalled();
  retained = false; await f.run('POST'); expect(presentation.publish).toHaveBeenCalledOnce(); expect(retain).toHaveBeenCalledTimes(4);
});
it.each(families)('%s retains late complete201 proof but rejects stale publication and sends only once', async family => {
  let current = true, resolve!: (value: Response) => void;
  const retain = vi.fn(async () => {}), f = await input(family, () => { if (!current) throw Error('stale journey'); }, retain);
  const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(done => { resolve = done; })); vi.stubGlobal('fetch', fetch);
  const result = f.run('POST').catch(error => error);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce()); current = false;
  resolve(new Response(JSON.stringify(f.value), { status: 201, headers: { 'x-pkw-journey-created': '1' } }));
  expect(await result).toMatchObject({ message: 'stale journey' }); expect(retain).toHaveBeenCalledOnce();
  expect(presentation.publish).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
});
it('does not let a marker bypass durable storage failure or a failed transaction response', async () => {
  const f = await input('plain-starter', () => {}, async () => { throw Error('disk full'); });
  const fetch = vi.fn(async () => new Response(JSON.stringify(f.value), { status: 201, headers: { 'x-pkw-journey-created': '1' } })); vi.stubGlobal('fetch', fetch);
  await expect(f.run('POST')).rejects.toThrow('disk full');
  fetch.mockImplementation(async () => new Response(JSON.stringify({ error: { code: 'ROLLBACK', message: 'Transaction rolled back' } }), { status: 500, headers: { 'x-pkw-journey-created': '1' } }));
  await expect(f.run('POST')).rejects.toThrow(); expect(presentation.publish).not.toHaveBeenCalled();
});
