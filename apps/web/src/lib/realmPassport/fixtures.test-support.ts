import { REALM_PASSPORT_PAGE_SIZE } from '@shardkeep/shared/realmPassportApi';
import type { RealmPassportExpeditionsResponse, RealmPassportInclusionsResponse, RealmPassportCurrentResponse } from '@shardkeep/shared/realmPassportApi';
export const wallet = '11111111111111111111111111111111';
export const otherWallet = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
export const now = '2035-01-03T15:00:00.000Z';
const envelope = { version: 1 as const, wallet, serverNow: now, projection: 'history-only' as const, state: 'available' as const };
export function expeditions(kind: 'starter' | 'advanced' = 'starter', ids = [1], cursor: string | null = null): RealmPassportExpeditionsResponse {
  return { ...envelope, data: { kind, nextCursor: cursor, rows: ids.map(n => ({ kind, expeditionId: id(n), returnId: id(n + 100), originalBaseId: id(900), realmId: 'frostveil', routeId: 'paid_frostveil', routeVersion: kind === 'starter' ? 1 : null, policyVersion: kind === 'advanced' ? 1 : null, departedAt: '2035-01-01T10:00:00.000Z', scheduledReturnAt: '2035-01-01T12:00:00.000Z', returnedAt: '2035-01-01T12:01:00.000Z' })) } };
}
export function inclusions(sequences = ['1'], cursor: string | null = null): RealmPassportInclusionsResponse {
  return { ...envelope, data: { nextCursor: cursor, rows: sequences.map(sequence => ({ sequence, day: '23742', root: 'ab'.repeat(32), sourceHash: 'cd'.repeat(32), publicationSignature: '1'.repeat(64), publicationSlot: 300, genesisHash: wallet, programId: wallet, configAddress: wallet, keepMint: otherWallet, reserveOwner: wallet, totalCumulativeBaseUnits: '2000000000', leaf: { wallet, sequence, cumulativeKeepBaseUnits: '1250000000', cumulativeRenown: '10', cumulativeDays: '12' }, proof: [] })) } };
}
export function current(attested = true): RealmPassportCurrentResponse {
  return { ...envelope, data: { observedSlot: 400, chainUnixTimestamp: '2051452800', publicationSequence: '3', published: { cumulativeRenown: '10', cumulativeDays: '12' }, attested: attested ? { renownTotal: '7', daysAttested: '9', lastSequence: '2' } : null } };
}
export const unavailable = { version: 1 as const, wallet, serverNow: now, projection: 'history-only' as const, state: 'unavailable' as const, reason: 'SOURCE_UNAVAILABLE' as const, data: null };
export function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

export const pageEnd = REALM_PASSPORT_PAGE_SIZE;
export const firstPage = () => expeditions('starter', Array.from({ length: pageEnd }, (_, i) => i + 1), id(pageEnd));
