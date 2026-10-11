import { StarterExpeditionRouteSnapshotSchema, StarterExpeditionViewSchema, type StarterExpeditionView } from '@shardkeep/shared/starterExpeditionApi';
import { StarterRouteIdSchema, starterRoutePreview, type StarterRouteId } from '@shardkeep/shared/phaseEExpeditions';
import { PHASE_E_RAW_RESOURCE_IDS } from '@shardkeep/shared/phaseEResources';
import { installation } from '../starterFleet/fixtures.test-support';
import { parseStarterExpeditionCommand, type StarterExpeditionIdentity, type StarterExpeditionProof } from './journal';
export { installation };
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const identity: StarterExpeditionIdentity = { origin: 'https://game.test', api: 'https://game.test/api', cluster: 'devnet', wallet: '11111111111111111111111111111111' };
export const now = '2026-09-22T12:00:00.000Z';
export function command(routeId: StarterRouteId = 'introduction', key = id(2)) {
  const route = starterRoutePreview('frostveil', routeId), installed = installation();
  return parseStarterExpeditionCommand({ request: { idempotencyKey: key, baseId: installed.baseId, installationId: installed.installationId,
    routeId, routeVersion: route.routeCatalogueVersion, rewardVersion: route.rewardTableVersion }, route, installation: installed });
}
export const start = command();
export const view = (): StarterExpeditionView => StarterExpeditionViewSchema.parse({ wallet: identity.wallet, baseId: id(1), serverNow: now,
  features: { starterExpeditions: { version: 1, receipts: 1 } }, acceptingDepartures: true,
  home: { source: 'free_policy_preview', version: 1, realmId: 'frostveil' }, routes: StarterRouteIdSchema.options.map(routeId => starterRoutePreview('frostveil', routeId)),
  installation: installation(), flight: null, lodgeCompletedAt: '2026-09-22T11:30:00.000Z',
  rawStock: PHASE_E_RAW_RESOURCE_IDS.map(resourceId => ({ resourceId, available: '0', reserved: '0', total: '0' })) });
/** Synthetic protocol fixture only; this term identity is never genuine chain admission. */
export function proof(original = start, accepted = false, returned = false): StarterExpeditionProof {
  const returnsAt = new Date(Date.parse(now) + original.route.durationSec * 1_000).toISOString();
  const common = { wallet: identity.wallet, idempotencyKey: original.request.idempotencyKey, serverNow: returned ? returnsAt : now };
  return accepted ? { ...common, status: 'accepted', receipt: { wallet: identity.wallet, request: original.request, expeditionId: original.request.idempotencyKey,
    installationId: original.request.installationId, route: StarterExpeditionRouteSnapshotSchema.parse(original.route), departedAt: now, returnsAt, termId: id(6), termHash: 'a'.repeat(64) },
    return: returned ? { returnId: id(7), returnedAt: returnsAt } : null } : { ...common, status: 'unknown', receipt: null, return: null };
}
export function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
