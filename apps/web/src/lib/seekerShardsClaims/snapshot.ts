import { captureBaseSnapshotCommit } from '../../state/baseSnapshot';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, type BaseStateDto, type BalancesDto } from '../../state/store';
import { same, type SeekerShardsClaimsIdentity } from './journal';
import type { SeekerShardsClaimsPorts } from './controller';
const object = (r: unknown): Record<string, unknown> => { if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('SHARDS claims refresh is incomplete.'); return r as Record<string, unknown>; };
const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
const amount = (n: unknown) => typeof n === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(n) && BigInt(n) <= 9223372036854775807n;
function ownership(raw: unknown): { enabled: boolean; readable: boolean; owned: string[] } {
  const r = object(raw), capabilities = object(r.capabilities);
  if (typeof r.enabled !== 'boolean' || typeof capabilities.baseScopedReads !== 'boolean' || !Array.isArray(r.bases)) throw new Error('Base ownership did not refresh.');
  const bases = r.bases.map(object);
  if (bases.some(b => typeof b.id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(b.id) || !['active', 'inactive'].includes(String(b.status)) || !(b.slot === null || count(b.slot) && (b.slot as number) > 0))
    || new Set(bases.map(b => b.id)).size !== bases.length) throw new Error('Base ownership did not refresh.');
  return { enabled: r.enabled, readable: capabilities.baseScopedReads, owned: bases.filter(b => b.status === 'active' && b.slot !== null).map(b => b.id as string).sort() };
}
export type SeekerShardsClaimsSnapshot = { balances: BalancesDto; enabled: boolean };
/** Historical receipts never enter this path. All balances come from
 * fresh selected-base responses bracketed by authenticated ownership reads. */
export async function refreshSeekerShardsClaimsSnapshot(identity: SeekerShardsClaimsIdentity, ports: SeekerShardsClaimsPorts, publicationGuard: () => void = () => undefined, originalBaseId?: string): Promise<SeekerShardsClaimsSnapshot | null> {
  const scope = captureBaseSnapshotGuard(), session = ports.capture();
  const guard = () => { publicationGuard(); session(); if (scope.wallet !== identity.wallet || !isBaseSnapshotGuardCurrent(scope)) throw new Error('The SHARDS claims account or selected base changed.'); };
  const read = async (path: string) => { guard(); const result = await ports.get(path, guard); guard(); return result; };
  const me = object(await read('/me')); if (me.wallet !== identity.wallet) throw new Error('SHARDS claims account did not refresh.');
  const before = ownership(await read('/bases')), baseId = scope.selectedBaseId;
  if (originalBaseId && (!before.enabled || !before.readable)) throw new Error('Original kingdom authority cannot be established yet.');
  if (originalBaseId && before.owned.includes(originalBaseId) && originalBaseId !== baseId) throw new Error('Select the original kingdom to refresh its SHARDS balance before saving this receipt.');
  if (!baseId || !before.enabled || !before.readable || !before.owned.includes(baseId) || originalBaseId && originalBaseId !== baseId) return null;
  const commit = captureBaseSnapshotCommit(baseId, scope), suffix = `?baseId=${encodeURIComponent(baseId)}`;
  const rawBase = object(await read(`/base${suffix}`)), player = object(rawBase.player);
  if (rawBase.baseId !== baseId || player.wallet !== identity.wallet || !count(player.keepLevel) || !Array.isArray(rawBase.buildings)
    || !Array.isArray(rawBase.jobs) || !Array.isArray(rawBase.obstacles) || !Array.isArray(rawBase.army)) throw new Error('SHARDS claims base did not refresh.');
  const balances = object(await read(`/balances${suffix}`));
  if (!amount(balances.keep) || !amount(balances.shards) || balances.gems !== undefined && !amount(balances.gems) || !count(balances.keepRate) || balances.keepRate === 0) throw new Error('SHARDS claims balances did not refresh.');
  if (object(await read('/me')).wallet !== identity.wallet || !same(before, ownership(await read('/bases')))) throw new Error('SHARDS claims ownership changed during refresh.');
  guard(); if (!commit(rawBase as unknown as BaseStateDto, balances as unknown as BalancesDto)) throw new Error('A newer base refresh replaced this SHARDS view. Refresh again.');
  return { balances: balances as unknown as BalancesDto, enabled: true };
}
