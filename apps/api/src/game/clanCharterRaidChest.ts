/** Prospective original-clan chest adapter only. This private surface does not
 * settle members or authorize Charter signing, sale, transfer or expulsion.
 * K232 submitOrders resolves and asserts the captured posting in its existing transaction. */
import { CLANS, PHASE_E_POLICY } from '@shardkeep/shared';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { phaseECharterEnabled } from '../config';
import type { Db, DbTx } from '../db/client';
import { HttpError } from '../lib/errors';

export interface ClanCharterRaidTitheRule {
  id: string;
  sourceId: string;
  version: 1;
  rateSource: 'CLANS.chestTitheBps';
  titheBps: number;
  basisPoints: number;
  enrolledAt: string;
}
export type ClanCharterRaidChestProof =
  | { status: 'unenrolled' }
  | { status: 'held'; reason: string }
  | { status: 'reconciled'; raidId: string; originalClanId: string | null;
      ruleId: string; terminalStatus: 'resolved' | 'expired'; chestShards: string };
export interface OriginalClanRaidChest {
  history: 'unenrolled' | 'captured';
  clanId: string | null;
  chestCut: bigint;
}
const uuid = z.uuid().transform(value => value.toLowerCase());
const amount = z.string().max(19).regex(/^(0|[1-9][0-9]*)$/)
  .refine(value => BigInt(value) <= 9223372036854775807n);
const ruleSchema = z.object({ id: uuid, sourceId: uuid, version: z.literal(1),
  rateSource: z.literal('CLANS.chestTitheBps'), titheBps: z.number().int().nonnegative(),
  basisPoints: z.number().int().positive(), enrolledAt: z.iso.datetime({ precision: 6 }),
}).strict().refine(value => value.titheBps < value.basisPoints);
const proofSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unenrolled') }).strict(),
  z.object({ status: z.literal('held'), reason: z.string().min(1).max(80) }).strict(),
  z.object({ status: z.literal('reconciled'), raidId: uuid, originalClanId: uuid.nullable(),
    ruleId: uuid, terminalStatus: z.enum(['resolved', 'expired']), chestShards: amount }).strict(),
]);
const routeSchema = z.discriminatedUnion('history', [
  z.object({ history: z.literal('unenrolled'), clanId: uuid.nullable() }).strict(),
  z.object({ history: z.literal('captured'), clanId: uuid.nullable(),
    titheBps: z.number().int().nonnegative(), basisPoints: z.number().int().positive() }).strict(),
]);
const deny = (suffix: string, status = 503): never => {
  throw new HttpError(status, 'Original-clan raid chest proof is temporarily unavailable',
    `CLAN_CHARTER_RAID_CHEST_${suffix}`);
};
function translate(error: unknown): never {
  if (error instanceof HttpError) throw error;
  let item = error;
  for (let depth = 0; depth < 12 && item && typeof item === 'object'; depth++) {
    const e = item as { code?: unknown; message?: unknown; cause?: unknown };
    if (e.code === '55P03') deny('BUSY');
    if (e.message === 'CLAN_CHARTER_RAID_CHEST_OWNER') deny('OWNER');
    if (e.message === 'CLAN_CHARTER_RAID_CHEST_READ_COMMITTED') deny('READ_COMMITTED');
    if (e.message === 'CLAN_CHARTER_RAID_CHEST_PENDING_RAIDS') deny('PENDING_RAIDS', 409);
    item = e.cause;
  }
  return deny('HELD');
}
async function savedRule(tx: DbTx): Promise<ClanCharterRaidTitheRule | null> {
  const [row] = await tx.execute<{ value: unknown }>(sql`select public.shardkeep_clan_charter_raid_chest_rule_read() value`);
  if (row?.value === null) return null;
  const parsed = ruleSchema.safeParse(row?.value);
  return parsed.success ? Object.freeze(parsed.data) : deny('HELD');
}

/** The existing reconciliation reader reuses this within its own snapshot. */
export async function readClanCharterRaidChestInTransaction(tx: DbTx, raidId: string): Promise<ClanCharterRaidChestProof> {
  const [row] = await tx.execute<{ value: unknown }>(sql`
    select public.shardkeep_clan_charter_raid_chest_read(${raidId}::uuid) value`);
  const parsed = proofSchema.safeParse(row?.value);
  return parsed.success ? Object.freeze(parsed.data) : deny('HELD');
}

export function createClanCharterRaidChest(db: Db) {
  if ('rollback' in db) deny('TOP_LEVEL');
  async function initializeRule(): Promise<ClanCharterRaidTitheRule> {
    try {
      return await db.transaction(async tx => {
        const original = await savedRule(tx);
        if (original) return original;
        if (!phaseECharterEnabled()) deny('DISABLED');
        // Version is a storage contract. Actual policy numbers come only from
        // shared constants; SQL retains them without claiming to authenticate JS.
        await tx.execute(sql`select public.shardkeep_clan_charter_raid_chest_rule_initialize(
          ${CLANS.chestTitheBps}::integer,${PHASE_E_POLICY.basisPoints}::integer)`);
        if (!phaseECharterEnabled()) deny('DISABLED');
        return await savedRule(tx) ?? deny('HELD');
      }, { isolationLevel: 'read committed' });
    } catch (error) { return translate(error); }
  }
  async function read(raidId: string): Promise<ClanCharterRaidChestProof> {
    raidId = uuid.parse(raidId);
    try {
      return await db.transaction(tx => readClanCharterRaidChestInTransaction(tx, raidId),
        { isolationLevel: 'repeatable read', accessMode: 'read only' });
    } catch (error) { return translate(error); }
  }
  return Object.freeze({ initializeRule, read });
}

export async function resolveOriginalClanRaidChest(
  tx: DbTx, raidId: string, attacker: string, grossLoot: bigint,
): Promise<OriginalClanRaidChest> {
  raidId = uuid.parse(raidId);
  if (typeof attacker !== 'string' || attacker.length < 1 || attacker.length > 128
    || typeof grossLoot !== 'bigint' || grossLoot < 0n || grossLoot > 9223372036854775807n) deny('HELD');
  try {
    const [row] = await tx.execute<{ value: unknown }>(sql`
      select public.shardkeep_clan_charter_raid_chest_resolve(${raidId}::uuid,${attacker}::text) value`);
    const parsed = routeSchema.safeParse(row?.value);
    if (!parsed.success) return deny('HELD');
    const route = parsed.data;
    const rate = route.history === 'captured' ? route.titheBps : CLANS.chestTitheBps;
    const divisor = route.history === 'captured' ? route.basisPoints : PHASE_E_POLICY.basisPoints;
    if (rate >= divisor) deny('HELD');
    return Object.freeze({ history: route.history, clanId: route.clanId,
      chestCut: route.clanId === null ? 0n : grossLoot * BigInt(rate) / BigInt(divisor) });
  } catch (error) { return translate(error); }
}

export async function assertOriginalClanRaidChestPosting(
  tx: DbTx, raidId: string, ledgerId: string,
): Promise<void> {
  raidId = uuid.parse(raidId); ledgerId = uuid.parse(ledgerId);
  try {
    await tx.execute(sql`select public.shardkeep_clan_charter_raid_chest_assert_posting(${raidId}::uuid,${ledgerId}::uuid)`);
  } catch (error) { translate(error); }
}
