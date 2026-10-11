/** Base-scoped raid protection. A shield follows the deed, not its wallet. */
import { SHIELD, fmtDur } from '@shardkeep/shared';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { bases, plots, shields } from '../db/schema';
import { HttpError } from '../lib/errors';
import { invalidateValley } from '../lib/mapCache';
import { getGameConfig } from './gameConfig';
import { isWarzoneActive } from './warzone';

const HOUR_MS = 60 * 60 * 1_000;
const ORDINARY_SHIELD_SOURCES: Array<'loss' | 'purchase'> = ['loss', 'purchase'];

async function activeBaseShield(db: DbOrTx, baseId: string, now: Date) {
  const [active] = await db.select().from(shields)
    .where(and(eq(shields.baseId, baseId), gt(shields.expiresAt, now)))
    .orderBy(desc(shields.expiresAt)).limit(1);
  return active ?? null;
}

/** Ordinary protection is the only kind the 0.05 SOL shop action may extend.
 * A paid warzone row is a separate product and must remain immutable here. */
async function activeOrdinaryBaseShield(db: DbOrTx, baseId: string, now: Date) {
  const [active] = await db.select().from(shields)
    .where(and(
      eq(shields.baseId, baseId),
      gt(shields.expiresAt, now),
      inArray(shields.source, ORDINARY_SHIELD_SOURCES),
    ))
    .orderBy(desc(shields.expiresAt)).limit(1);
  return active ?? null;
}

type ShieldSource = typeof shields.$inferSelect.source;
type ShieldClockRow = Pick<typeof shields.$inferSelect, 'source' | 'expiresAt'>;

export interface EffectiveShieldStatus {
  /** Effective protection under the rules at this request instant. */
  active: boolean;
  /** Effective row, or the resumable stored row when suppression is true. */
  source: ShieldSource | null;
  expiresAt: Date | null;
  remainingMs: number;
  /** A live ordinary row exists, but the current warzone makes it non-protective. */
  suppressedByWarzone: boolean;
}

/** Pure shield resolver shared by home, parcel and tests. During a warzone the
 * raid gate recognizes only `warzone`; an ordinary row remains visible while its
 * clock continues, but it never becomes attack protection during that window. */
export function resolveEffectiveShieldStatus(
  rows: readonly ShieldClockRow[], now: Date, warzoneActive: boolean,
): EffectiveShieldStatus {
  const live = rows
    .filter((row) => row.expiresAt.getTime() > now.getTime())
    .sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime());
  const effective = warzoneActive
    ? live.find((row) => row.source === 'warzone')
    : live[0];
  if (effective) {
    return {
      active: true,
      source: effective.source,
      expiresAt: effective.expiresAt,
      remainingMs: effective.expiresAt.getTime() - now.getTime(),
      suppressedByWarzone: false,
    };
  }
  const suppressed = warzoneActive ? live[0] : undefined;
  if (suppressed) {
    return {
      active: false,
      source: suppressed.source,
      expiresAt: suppressed.expiresAt,
      remainingMs: suppressed.expiresAt.getTime() - now.getTime(),
      suppressedByWarzone: true,
    };
  }
  return {
    active: false, source: null, expiresAt: null, remainingMs: 0,
    suppressedByWarzone: false,
  };
}

export async function getEffectiveShieldStatus(
  db: DbOrTx, wallet: string, now: Date, warzoneActive: boolean, baseId?: string,
): Promise<EffectiveShieldStatus> {
  const scope = baseId ? eq(shields.baseId, baseId) : eq(shields.playerWallet, wallet);
  const rows = await db.select({ source: shields.source, expiresAt: shields.expiresAt })
    .from(shields).where(and(scope, gt(shields.expiresAt, now)))
    .orderBy(desc(shields.expiresAt));
  return resolveEffectiveShieldStatus(rows, now, warzoneActive);
}

/** The bulk form of getEffectiveShieldStatus for many deeds at once: ONE
 * indexed read (shields_base_expires_idx) for every id, then the same pure
 * resolver per deed, so a map feed can never disagree with the raid gate.
 * Returns only the ids whose protection is effective at `now`. */
export async function getEffectivelyShieldedBaseIds(
  db: DbOrTx, baseIds: readonly string[], now: Date, warzoneActive: boolean,
): Promise<Set<string>> {
  if (baseIds.length === 0) return new Set();
  const rows = await db.select({ baseId: shields.baseId, source: shields.source, expiresAt: shields.expiresAt })
    .from(shields).where(and(inArray(shields.baseId, [...baseIds]), gt(shields.expiresAt, now)));
  const byBase = new Map<string, ShieldClockRow[]>();
  for (const { baseId, ...row } of rows) {
    if (baseId) byBase.set(baseId, [...(byBase.get(baseId) ?? []), row]);
  }
  return new Set([...byBase].filter(([, clocks]) => resolveEffectiveShieldStatus(clocks, now, warzoneActive).active)
    .map(([baseId]) => baseId));
}

export async function invalidateShieldMap(
  db: DbOrTx, wallet: string, baseId?: string,
): Promise<void> {
  invalidateShieldMapValley(await shieldMapValleyId(db, wallet, baseId));
}

/** Resolve the immutable cache target while the owning transaction is open,
 * then call invalidateShieldMapValley only after that transaction commits. */
export async function shieldMapValleyId(
  db: DbOrTx, wallet: string, baseId?: string,
): Promise<string | null> {
  const [plot] = await db.select({ valleyId: plots.valleyId }).from(plots)
    .where(baseId ? eq(plots.baseId, baseId) : eq(plots.playerWallet, wallet)).limit(1);
  return plot?.valleyId ?? null;
}

/** Synchronous by design: resolve the target inside the transaction, then a
 * committed mutation cannot turn into a failed response during cache publish. */
export function invalidateShieldMapValley(valleyId: string | null): void {
  if (valleyId) invalidateValley(valleyId);
}

async function baseOwner(db: DbOrTx, baseId: string): Promise<string> {
  const [base] = await db.select({ ownerWallet: bases.ownerWallet }).from(bases)
    .where(eq(bases.id, baseId));
  if (!base) throw new HttpError(404, 'base not found', 'BASE_NOT_FOUND');
  return base.ownerWallet;
}

export async function getBaseShieldStatus(db: DbOrTx, baseId: string, now = new Date()) {
  const cfg = await getGameConfig(db);
  return getEffectiveShieldStatus(db, '', now, isWarzoneActive(cfg, now), baseId);
}

/** Called exactly when the first deploy/hero command starts a PvP battle. */
export async function breakBaseShieldOnAttack(
  tx: DbOrTx, wallet: string, baseId: string,
  opts: { deferMapInvalidation?: boolean } = {},
): Promise<number> {
  if (await baseOwner(tx, baseId) !== wallet) {
    throw new HttpError(404, 'base not found', 'BASE_NOT_OWNED');
  }
  const removed = await tx.delete(shields).where(eq(shields.baseId, baseId))
    .returning({ id: shields.id });
  // A transaction caller must defer publication until its OUTER commit. If this
  // cache is evicted here, a concurrent miss can reload the still-committed old
  // shield and retain that lie for the full map TTL after the transaction lands.
  if (removed.length > 0 && !opts.deferMapInvalidation) {
    await invalidateShieldMap(tx, wallet, baseId);
  }
  return removed.length;
}

/** One star or better grants 48h to the attacked deed. During a warzone the row
 * is created and counts down but remains ineffective; zero-star attacks never
 * protect the defender. */
export async function grantBaseDefenseShield(
  tx: DbOrTx,
  defenderWallet: string,
  defenderBaseId: string,
  stars: 0 | 1 | 2 | 3,
  now = new Date(),
  opts: { deferMapInvalidation?: boolean } = {},
): Promise<{ expiresAt: Date | null }> {
  if (stars < 1) return { expiresAt: null };
  const currentOwner = await baseOwner(tx, defenderBaseId);
  const expiresAt = new Date(now.getTime() + SHIELD.hoursOnLoss * HOUR_MS);
  const active = await activeBaseShield(tx, defenderBaseId, now);
  if (active && active.expiresAt >= expiresAt) return { expiresAt: active.expiresAt };
  await tx.insert(shields).values({
    // `playerWallet` is a legacy compatibility shadow. Stable protection and
    // authority follow baseId, including a deed sold while its raid was live.
    playerWallet: currentOwner,
    baseId: defenderBaseId,
    source: 'loss',
    expiresAt,
    createdAt: now,
  });
  if (!opts.deferMapInvalidation) {
    await invalidateShieldMap(tx, defenderWallet, defenderBaseId);
  }
  return { expiresAt };
}

/** A paid +12h quote is legal at exactly 36h remaining, never above it. */
export async function assertBaseShieldExtendable(
  db: DbOrTx, wallet: string, baseId: string, now = new Date(),
): Promise<void> {
  if (await baseOwner(db, baseId) !== wallet) {
    throw new HttpError(404, 'base not found', 'BASE_NOT_OWNED');
  }
  const active = await activeOrdinaryBaseShield(db, baseId, now);
  if (!active) {
    throw new HttpError(422, 'no active shield to extend');
  }
  const remainingMs = active.expiresAt.getTime() - now.getTime();
  if (remainingMs > SHIELD.extendPurchaseMaxRemainingHours * HOUR_MS) {
    throw new HttpError(
      422,
      `shield may be extended only at ${fmtDur(SHIELD.extendPurchaseMaxRemainingHours * 3_600)} remaining or less`,
    );
  }
}

/** Credit-time recheck. No active shield means the player attacked after paying,
 * so the payment must not mint replacement protection. A concurrent extension
 * that pushed the deed back over 36h likewise makes this grant a safe no-op. */
export async function grantBaseShieldExtension(
  tx: DbOrTx, wallet: string, baseId: string, now = new Date(),
  opts: { deferMapInvalidation?: boolean } = {},
): Promise<{ expiresAt: Date | null; granted: boolean }> {
  const currentOwner = await baseOwner(tx, baseId);
  const active = await activeOrdinaryBaseShield(tx, baseId, now);
  if (!active) return { expiresAt: null, granted: false };
  const remainingMs = active.expiresAt.getTime() - now.getTime();
  if (remainingMs > SHIELD.extendPurchaseMaxRemainingHours * HOUR_MS) {
    return { expiresAt: active.expiresAt, granted: false };
  }
  const maxExpiryMs = now.getTime() + SHIELD.maxHours * HOUR_MS;
  const newExpiry = new Date(Math.min(
    active.expiresAt.getTime() + SHIELD.extendHours * HOUR_MS,
    maxExpiryMs,
  ));
  const [updated] = await tx.update(shields)
    .set({ expiresAt: newExpiry, playerWallet: currentOwner })
    .where(and(
      eq(shields.id, active.id),
      eq(shields.expiresAt, active.expiresAt),
      gt(shields.expiresAt, now),
      inArray(shields.source, ORDINARY_SHIELD_SOURCES),
    ))
    .returning({ expiresAt: shields.expiresAt });
  // Credit can race a shield break, expiry, or another finalized extension.
  // Losing that compare-and-set is deliberately a no-op: never recreate or
  // overwrite protection from the stale pre-credit snapshot.
  if (!updated) {
    const current = await activeOrdinaryBaseShield(tx, baseId, now);
    return { expiresAt: current?.expiresAt ?? null, granted: false };
  }
  if (!opts.deferMapInvalidation) await invalidateShieldMap(tx, wallet, baseId);
  return { expiresAt: updated.expiresAt, granted: true };
}
