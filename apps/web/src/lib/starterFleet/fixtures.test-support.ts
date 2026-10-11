import { StarterFleetInstallationSchema, type StarterFleetView } from '@shardkeep/shared/starterFleetApi';
import { parseStarterFleetCommand, starterFleetBerth, type StarterFleetIdentity, type StarterFleetProof } from './journal';
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const identity: StarterFleetIdentity = { origin: 'https://game.test', api: 'https://game.test/api', cluster: 'devnet', wallet: '11111111111111111111111111111111' };
export const now = '2026-09-22T12:00:00.000Z';
export const installation = () => StarterFleetInstallationSchema.parse({ installationId: id(5), baseId: id(1), berthId: id(3), family: 'starter',
  completedBuildJobId: id(4), berthCompletedAt: '2026-09-22T11:00:00.000Z', installedAt: '2026-09-22T11:05:00.000Z' });
export const berth = () => starterFleetBerth(installation());
export function command(existing = false, key = id(2)) {
  return parseStarterFleetCommand({ request: { idempotencyKey: key, baseId: id(1), berthId: id(3) }, berth: berth(), installation: existing ? installation() : null });
}
export const start = command();
export const view = (existing = false): StarterFleetView => ({ wallet: identity.wallet, baseId: id(1), serverNow: now,
  features: { starterFleet: { version: 1, receipts: 1 } }, acceptingInstallations: true, installation: existing ? installation() : null, eligibleBerths: [berth()] });
export function proof(original = start, accepted = false): StarterFleetProof {
  const common = { wallet: identity.wallet, idempotencyKey: original.request.idempotencyKey, serverNow: now };
  return accepted ? { ...common, status: 'accepted', receipt: { wallet: identity.wallet, request: original.request,
    installation: original.installation ?? installation(), acceptedAt: now } } : { ...common, status: 'unknown', receipt: null };
}
export function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
