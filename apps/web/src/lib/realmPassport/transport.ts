/** Passport reads are authenticated projections, never claim or gameplay authority. */
import {
  RealmPassportExpeditionsQuerySchema, RealmPassportInclusionsQuerySchema,
  RealmPassportExpeditionsResponseSchema, RealmPassportInclusionsResponseSchema,
  RealmPassportCurrentResponseSchema,
  type RealmPassportExpeditionsQuery, type RealmPassportInclusionsQuery,
} from '@shardkeep/shared/realmPassportApi';
import { api } from '../api';
import { AuthChangedError } from '../../auth/authCookieCoordinatorCore';

export type PassportRead = { wallet: string; signal?: AbortSignal; isCurrent: () => boolean };
async function read(input: PassportRead, path: string): Promise<unknown> {
  if (!input.isCurrent()) throw new AuthChangedError();
  const raw = await api.getPrivate(path, { ...(input.signal ? { signal: input.signal } : {}), isCurrent: input.isCurrent });
  if (!input.isCurrent()) throw new AuthChangedError();
  return raw;
}
function actor<T extends { wallet: string }>(input: PassportRead, value: T): T {
  if (value.wallet !== input.wallet) throw Error('This history belongs to another account. Sign in again.');
  return value;
}
export async function readPassportExpeditions(input: PassportRead, query: RealmPassportExpeditionsQuery) {
  const q = RealmPassportExpeditionsQuerySchema.parse(query);
  const params = new URLSearchParams({ kind: q.kind });
  if (q.cursor) params.set('cursor', q.cursor);
  const value = actor(input, RealmPassportExpeditionsResponseSchema.parse(await read(input, '/realm-passport/expeditions?' + params)));
  if (value.state === 'available') {
    if (value.data.kind !== q.kind) throw Error('The expedition filter changed. Refresh your history.');
    let previous = q.cursor ?? '';
    for (const row of value.data.rows) {
      if (row.kind !== q.kind || row.expeditionId <= previous) throw Error('The expedition page could not be verified. Refresh your history.');
      previous = row.expeditionId;
    }
    if (value.data.nextCursor !== null && (!value.data.rows.length || value.data.nextCursor !== previous)) throw Error('The expedition page could not be verified. Refresh your history.');
  }
  return value;
}
export async function readPassportInclusions(input: PassportRead, query: RealmPassportInclusionsQuery = {}) {
  const q = RealmPassportInclusionsQuerySchema.parse(query);
  const value = actor(input, RealmPassportInclusionsResponseSchema.parse(await read(input, '/realm-passport/mining/inclusions' + (q.cursor ? '?cursor=' + encodeURIComponent(q.cursor) : ''))));
  if (value.state === 'available') {
    let previous = BigInt(q.cursor ?? '0');
    for (const row of value.data.rows) {
      if (row.leaf.wallet !== input.wallet || row.leaf.sequence !== row.sequence || BigInt(row.sequence) <= previous) throw Error('The publication page could not be verified. Refresh your history.');
      previous = BigInt(row.sequence);
    }
    if (value.data.nextCursor !== null && (!value.data.rows.length || BigInt(value.data.nextCursor) !== previous)) throw Error('The publication page could not be verified. Refresh your history.');
  }
  return value;
}
export async function readPassportCurrent(input: PassportRead) {
  return actor(input, RealmPassportCurrentResponseSchema.parse(await read(input, '/realm-passport/mining/current')));
}
