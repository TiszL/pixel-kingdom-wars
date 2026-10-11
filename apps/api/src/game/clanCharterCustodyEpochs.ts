/** D-153.154 prospective accepted database custody history. `authority:current`
 * means current accepted DB authority only, never continuous chain ownership,
 * spending, refund, signing or Charter issuance authority. No RPC or money here.
 */
import { BASE_OWNERSHIP } from '@shardkeep/shared';
import { PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { phaseECharterEnabled } from '../config';
import type { Db, DbOrTx } from '../db/client';
import { HttpError } from '../lib/errors';

export interface CharterCustodyEpoch {
  readonly id: string;
  readonly evidenceCommitment: string;
  readonly baseId: string;
  readonly deedAssetId: string;
  readonly ownerWallet: string;
  readonly ordinal: string;
  readonly authority: 'current' | 'unavailable';
}

const uuid = z.uuid();
const address = z.string().min(32).max(44).refine(value => {
  try { const key = new PublicKey(value); return key.toBase58() === value && !key.equals(PublicKey.default); }
  catch { return false; }
});
const snapshot = z.object({
  id: uuid, evidenceCommitment: z.string().length(64).regex(/^[0-9a-f]+$/),
  baseId: uuid, deedAssetId: address, ownerWallet: address,
  ordinal: z.string().min(1).max(19).regex(/^[1-9][0-9]*$/).refine(value => BigInt(value) <= (1n << 63n) - 1n),
  authority: z.enum(['current', 'unavailable']),
}).strict();
const fail = (code: string): never => { throw new HttpError(503, 'Charter custody authority is unavailable', code); };
async function owner(db: DbOrTx) {
  const [row] = await db.execute<{ allowed: boolean }>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.charter_custody_sources'::regclass) allowed`);
  if (!row?.allowed) fail('CLAN_CHARTER_CUSTODY_OWNER');
}
function decode(value: unknown, baseId: string): CharterCustodyEpoch | null {
  if (value === null) return null;
  const parsed = snapshot.safeParse(value);
  if (!parsed.success || parsed.data.baseId !== baseId) return fail('CLAN_CHARTER_CUSTODY_HELD');
  return Object.freeze(parsed.data);
}
function translate(error: unknown): never {
  if (error instanceof HttpError) throw error;
  let cause = error;
  for (let n = 0; n < 8 && cause && typeof cause === 'object'; n++) {
    if ('code' in cause && cause.code === '55P03') fail('CLAN_CHARTER_CUSTODY_BUSY');
    if ('message' in cause && cause.message === 'CLAN_CHARTER_CUSTODY_UNAVAILABLE') fail('CLAN_CHARTER_CUSTODY_UNAVAILABLE');
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return fail('CLAN_CHARTER_CUSTODY_HELD');
}

export function createClanCharterCustodyEpochs(db: Db) {
  if ('rollback' in db) fail('CLAN_CHARTER_CUSTODY_TOP_LEVEL');
  async function read(baseId: string): Promise<CharterCustodyEpoch | null> {
    baseId = uuid.parse(baseId);
    try {
      await owner(db);
      return await db.transaction(async tx => {
        const [row] = await tx.execute<{ value: unknown }>(sql`select public.shardkeep_charter_custody_read(${baseId}::uuid,${BASE_OWNERSHIP.mutationFreshnessMs}::integer) value`);
        return decode(row?.value, baseId);
      }, { isolationLevel: 'read committed' });
    } catch (error) { return translate(error); }
  }
  async function enroll(wallet: string, baseId: string): Promise<CharterCustodyEpoch> {
    wallet = address.parse(wallet); baseId = uuid.parse(baseId);
    try {
      await owner(db);
      return await db.transaction(async tx => {
        // Serialize enrollment before checking whether a paused replay exists.
        await tx.execute(sql`select wallet from public.players where wallet=${wallet} for update`);
        await tx.execute(sql`select id from public.bases where id=${baseId}::uuid for update`);
        const [prior] = await tx.execute<{ present: boolean }>(sql`select exists(select 1 from public.charter_custody_sources where base_id=${baseId}::uuid) present`);
        if (!prior?.present && !phaseECharterEnabled()) fail('CLAN_CHARTER_CUSTODY_DISABLED');
        const [row] = await tx.execute<{ value: unknown }>(sql`select public.shardkeep_charter_custody_enroll(${wallet},${baseId}::uuid,${BASE_OWNERSHIP.mutationFreshnessMs}::integer) value`);
        if (!prior?.present && !phaseECharterEnabled()) fail('CLAN_CHARTER_CUSTODY_DISABLED');
        return decode(row?.value, baseId) ?? fail('CLAN_CHARTER_CUSTODY_HELD');
      }, { isolationLevel: 'read committed' });
    } catch (error) { return translate(error); }
  }
  return Object.freeze({ enroll, read });
}
