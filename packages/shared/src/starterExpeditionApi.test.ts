import { describe, expect, it } from 'vitest';
import { starterRoutePreview, StarterRouteIdSchema } from './phaseEExpeditions';
import { PHASE_E_RAW_RESOURCE_IDS } from './phaseEResources';
import { matchStarterExpeditionEnvelope, StarterExpeditionEnvelopeSchema, StarterExpeditionRequestSchema, StarterExpeditionViewSchema } from './starterExpeditionApi';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const wallet = '11111111111111111111111111111111', at = '2026-09-22T12:00:00.000Z';
const route = starterRoutePreview('crownlands', 'common_frostveil');
const request = { idempotencyKey: id(1), baseId: id(2), installationId: id(3), routeId: route.routeId,
  routeVersion: route.routeCatalogueVersion, rewardVersion: route.rewardTableVersion };
const receipt = { wallet, request, expeditionId: id(1), installationId: id(3), route, departedAt: at,
  returnsAt: new Date(Date.parse(at) + route.durationSec * 1_000).toISOString(), termId: id(4), termHash: 'ab'.repeat(32) };
const proof = { wallet, idempotencyKey: id(1), serverNow: at, status: 'accepted', receipt, return: null };
describe('starter departure public contract', () => {
  it('accepts only canonical request scalars and never client authority', () => {
    expect(StarterExpeditionRequestSchema.parse(request)).toEqual(request);
    for (const change of [{ wallet }, { finality: {} }, { home: 'frostveil' }, { routeVersion: '2' },
      { rewardVersion: 1.5 }, { installationId: 'ABCDEF00-0000-4000-8000-000000000003' }])
      expect(StarterExpeditionRequestSchema.safeParse({ ...request, ...change }).success).toBe(false);
  });
  it('binds original actor and exact body and preserves the common access marker', () => {
    expect(matchStarterExpeditionEnvelope(proof, wallet, request)).toEqual(proof);
    for (const change of [{ baseId: id(7) }, { installationId: id(7) }, { routeVersion: 99 }, { idempotencyKey: id(7) }])
      expect(() => matchStarterExpeditionEnvelope(proof, wallet, { ...request, ...change })).toThrow();
    expect(() => matchStarterExpeditionEnvelope(proof, `${wallet}1`, request)).toThrow();
    const { access: _access, ...stripped } = route;
    expect(StarterExpeditionEnvelopeSchema.safeParse({ ...proof, receipt: { ...receipt, route: stripped } }).success).toBe(false);
    expect(StarterExpeditionEnvelopeSchema.safeParse({ ...proof, receipt: { ...receipt, custodyWallet: wallet } }).success).toBe(false);
  });
  it('retains historical amounts but rejects imbalanced quantities and premature return', () => {
    const old = { ...receipt, route: { ...route, grossQuantity: '100', netQuantity: '70', islandPoolQuantity: '30' } };
    expect(StarterExpeditionEnvelopeSchema.safeParse({ ...proof, receipt: old }).success).toBe(true);
    expect(StarterExpeditionEnvelopeSchema.safeParse({ ...proof, receipt: { ...old, route: { ...old.route, netQuantity: '71' } } }).success).toBe(false);
    expect(StarterExpeditionEnvelopeSchema.safeParse({ ...proof, return: { returnId: id(6), returnedAt: at } }).success).toBe(false);
    expect(StarterExpeditionEnvelopeSchema.safeParse({ ...proof, return: { returnId: id(6), returnedAt: receipt.returnsAt } }).success).toBe(true);
    expect(StarterExpeditionEnvelopeSchema.safeParse({ ...proof, status: 'unknown', receipt: null, return: null }).success).toBe(true);
    expect(StarterExpeditionEnvelopeSchema.safeParse({ ...proof, status: 'unknown', receipt: null, return: { returnId: id(6), returnedAt: receipt.returnsAt } }).success).toBe(false);
  });
  it('requires complete current routes/raw stock and exact base/vehicle flight binding', () => {
    const view = { wallet, baseId: id(2), serverNow: at, features: { starterExpeditions: { version: 1, receipts: 1 } },
      acceptingDepartures: false, home: { source: 'free_policy_preview', version: 1, realmId: 'crownlands' },
      routes: StarterRouteIdSchema.options.map(r => starterRoutePreview('crownlands', r)), installation: null, flight: null,
      lodgeCompletedAt: null, rawStock: PHASE_E_RAW_RESOURCE_IDS.map(resourceId => ({ resourceId, available: '0', reserved: '0', total: '0' })) };
    expect(StarterExpeditionViewSchema.safeParse(view).success).toBe(true);
    for (const change of [{ routes: view.routes.slice(1) }, { home: null }, { rawStock: view.rawStock.slice(1) }, { flight: receipt },
      { lodgeCompletedAt: receipt.returnsAt }]) expect(StarterExpeditionViewSchema.safeParse({ ...view, ...change }).success).toBe(false);
    expect(StarterExpeditionViewSchema.safeParse({ ...view, home: null, routes: [] }).success).toBe(true);
  });
});
