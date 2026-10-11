import { and, desc, eq } from 'drizzle-orm';
import { SKR_FAUCET } from '@shardkeep/shared';
import type { Db, DbOrTx, DbTx } from '../db/client';
import { bases, deedOwnershipObservations } from '../db/schema';
import {
  assertFreshLockedBaseAuthority, deedProofIsFresh, lockActiveBase, requireFreshBaseAuthority,
  resolveActiveBase, type FinalizedDeedReader,
} from '../game/baseOwnership';
import { recordedDeedRefusal } from '../game/recordedDeed';
import { HttpError } from '../lib/errors';
import { utcWindow } from './skrFaucet';

type Base = typeof bases.$inferSelect;
export type SkrDeedReason = 'ok' | 'select_base' | 'deed_required' | 'retired_deed' | 'deed_unavailable';
/** P2's recorded-deed predicate is shared; paid entry alone never grants eligibility. */
async function recordedReason(db: DbOrTx, base: Base): Promise<SkrDeedReason> {
  const reason = await recordedDeedRefusal(db, base);
  // A quarantined legacy mint must remain a retryable authority refusal even
  // if the shared predicate encountered its null deed before this marker.
  if (base.deedMintAssetId?.startsWith('legacy-unknown:')) return 'deed_unavailable';
  if (!base.deedAssetId) return 'deed_required';
  if (reason === 'RETIRED_DEED') return 'retired_deed';
  if (reason === 'LEGACY_UNKNOWN_MINT') return 'deed_unavailable';
  return reason === null ? 'ok' : 'deed_required';
}
export function skrObservationIsFresh(observation: {
  owner: string | null; slot: bigint | null; status: string; checkedAt: Date;
}, wallet: string, now: Date): boolean {
  if (observation.owner !== wallet || observation.status !== 'owned' || observation.slot === null
      || observation.slot < 0n || observation.slot > BigInt(Number.MAX_SAFE_INTEGER)) return false;
  // An 'owned' observation is the shared reader's eligible finalized result.
  // Only its receive timestamp is consumed by deedProofIsFresh; the other
  // fields below do not manufacture a new chain proof or renew this observation.
  return deedProofIsFresh({ owner: wallet, collection: null, frozen: false, delegate: null,
    slot: Number(observation.slot), observedAtMs: observation.checkedAt.getTime() }, now);
}
async function latestFresh(db: DbOrTx, base: Base, wallet: string, at: Date): Promise<boolean> {
  const [row] = await db.select().from(deedOwnershipObservations).where(and(
    eq(deedOwnershipObservations.baseId, base.id), eq(deedOwnershipObservations.assetId, base.deedAssetId!),
  )).orderBy(desc(deedOwnershipObservations.checkedAt)).limit(1);
  return row !== undefined && skrObservationIsFresh(row, wallet, at);
}
function refuse(reason: Exclude<SkrDeedReason, 'ok'>): never {
  throw new HttpError(reason === 'deed_unavailable' ? 503 : 409,
    reason, reason === 'deed_unavailable' ? 'DEED_AUTHORITY_UNAVAILABLE' : 'SKR_FAUCET_DEED_REQUIRED');
}
/** Owner N-045 (6 Oct 2026), QA chain lane ONLY (`DEVNET_SKR_FAUCET_DEEDLESS_OK`, refused by loadConfig under
 * NODE_ENV=production and off devnet): a base with no deed at all may claim. D153.290 is unchanged everywhere else, so
 * `deedlessOk` defaults false. A quarantined mint (deedMintAssetId without deedAssetId) is never "deedless". The grant's
 * deed/day key is then this base-scoped marker (':' is not base58, so it can never equal a real asset id); the
 * wallet/day limit is unchanged. */
export function deedlessSkrClaimKey(baseId: string): string { return `deedless:${baseId}`; }
function deedless(base: Base, deedlessOk: boolean): boolean {
  return deedlessOk && base.deedAssetId === null && base.deedMintAssetId === null;
}
/** Status reads DB observations only. No wallet, mint, or deed RPC here. */
export async function readSkrDeedEligibility(db: Db, wallet: string, baseId: string | undefined, at: Date, deedlessOk = false) {
  let selected: Awaited<ReturnType<typeof resolveActiveBase>>;
  try { selected = await resolveActiveBase(db, wallet, baseId); }
  catch (error) {
    if (error instanceof HttpError && error.code === 'BASE_ID_REQUIRED') return { reason: 'select_base' as const, deed: null };
    throw error;
  }
  if (!selected) return { reason: 'deed_required' as const, deed: null };
  if (deedless(selected.base, deedlessOk)) return { reason: 'ok' as const, deed: deedlessSkrClaimKey(selected.base.id) };
  const reason = await recordedReason(db, selected.base);
  return { reason: reason !== 'ok' ? reason : await latestFresh(db, selected.base, wallet, at) ? 'ok' as const : 'deed_unavailable' as const,
    deed: selected.base.deedAssetId };
}
/** Run before opening the reservation transaction. */
export async function refreshSkrClaimDeed(db: Db, wallet: string, baseId: string,
  reader: FinalizedDeedReader | null, collection: string | null, now: () => Date, deedlessOk = false): Promise<string> {
  const base = await requireFreshBaseAuthority(db, wallet, baseId, reader, collection, now());
  if (deedless(base, deedlessOk)) return deedlessSkrClaimKey(base.id);
  const reason = await recordedReason(db, base);
  if (reason !== 'ok') refuse(reason);
  if (!base.deedAssetId) refuse('deed_required');
  if (!await latestFresh(db, base, wallet, now())) refuse('deed_unavailable');
  return base.deedAssetId;
}
/** Caller MUST insert its unique wallet/day + deed/day reservation before
 * this same transaction commits. No signing/network call belongs under these locks. */
export async function lockSkrClaimAdmission(tx: DbTx, input: {
  wallet: string; baseId: string; refreshedDeed: string; enteredAt: Date;
}, now: () => Date, deedlessOk = false) {
  await lockActiveBase(tx, input.wallet, input.baseId);
  const admittedAt = now();
  const base = await assertFreshLockedBaseAuthority(tx, input.wallet, input.baseId, admittedAt);
  // Re-decided under the base lock: a deed minted (or a deedless key refreshed) since refreshSkrClaimDeed is a 409 below.
  const isDeedless = deedless(base, deedlessOk);
  if (!isDeedless) { const reason = await recordedReason(tx, base); if (reason !== 'ok') refuse(reason); }
  const deedAssetId = isDeedless ? deedlessSkrClaimKey(base.id) : base.deedAssetId;
  if (!deedAssetId || deedAssetId !== input.refreshedDeed) {
    throw new HttpError(409, 'deed changed during admission', 'DEED_OWNERSHIP_CHANGED');
  }
  if (!isDeedless && !await latestFresh(tx, base, input.wallet, admittedAt)) refuse('deed_unavailable');
  const window = utcWindow(admittedAt);
  if (window.day !== utcWindow(input.enteredAt).day) throw new HttpError(409, 'day_changed', 'SKR_FAUCET_DAY_CHANGED');
  return { baseId: base.id, deedAssetId, admittedAt, ...window };
}

// Reservation/attempt persistence. Every attempt mutation takes its grant row
// first. Worker budget/signing transactions additionally share one mint lock;
// submitted bytes commit before the caller is permitted to broadcast them.
import { asc, inArray, or, sql } from 'drizzle-orm';
import { devnetSkrFaucetGrants as grants, devnetSkrFaucetAttempts as attempts } from '../db/schema';
export type SkrGrant = typeof grants.$inferSelect;
export interface SkrSweepCursor { id: string; requestedAt: Date }
export type SkrAttempt = typeof attempts.$inferSelect;
export interface SkrGrantUnit {
  grant: SkrGrant;
  attempts: SkrAttempt[];
  addAttempt(input: typeof attempts.$inferInsert): Promise<SkrAttempt>;
  updateAttempt(id: string, update: Partial<Pick<SkrAttempt, 'phase' | 'playerWire' | 'signature' | 'mutation' | 'faucetWire' | 'landedSignature' | 'settledAt'>>): Promise<SkrAttempt>;
  updateGrant(update: Partial<Pick<SkrGrant, 'status' | 'error' | 'sentAt'>>): Promise<void>;
  tallies(mint: string, day: string): Promise<{ reservedAllRaw: bigint; reservedDayRaw: bigint; sentTodayRaw: bigint }>;
}
/** `deedlessOk`: the N-045 lane switch above, for `reserve` only (the worker never admits a claim). */
export function makeSkrFaucetStore(db: Db, { deedlessOk = false }: { deedlessOk?: boolean } = {}) {
  async function readGrant(id: string, wallet: string) {
    const [grant] = await db.select().from(grants).where(and(eq(grants.id, id), eq(grants.wallet, wallet)));
    if (!grant) throw new HttpError(404, 'grant not owned', 'SKR_FAUCET_NOT_OWNED');
    const rows = await db.select().from(attempts).where(eq(attempts.grantId, id)).orderBy(desc(attempts.attemptNo));
    return { grant, attempts: rows };
  }
  async function withGrant<T>(id: string, wallet: string | null, run: (unit: SkrGrantUnit) => Promise<T>, treasuryMint?: string): Promise<T> {
    return db.transaction(async (tx) => {
      if (treasuryMint) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`devnet-skr-faucet:${treasuryMint}`}, 0))`);
      const [grant] = await tx.select().from(grants).where(and(eq(grants.id, id), ...(wallet ? [eq(grants.wallet, wallet)] : []))).for('update');
      if (!grant) throw new HttpError(404, 'grant not owned', 'SKR_FAUCET_NOT_OWNED');
      const rows = await tx.select().from(attempts).where(eq(attempts.grantId, id)).orderBy(desc(attempts.attemptNo));
      const unit: SkrGrantUnit = {
        grant, attempts: rows,
        addAttempt: async (input) => {
          if (input.grantId !== id) throw new Error('attempt grant mismatch');
          const [row] = await tx.insert(attempts).values(input).returning();
          if (!row) throw new Error('attempt insert failed'); rows.unshift(row); return row;
        },
        updateAttempt: async (attemptId, update) => {
          const at = rows.findIndex((row) => row.id === attemptId);
          if (at < 0) throw new Error('attempt not held');
          const [row] = await tx.update(attempts).set(update).where(and(eq(attempts.id, attemptId), eq(attempts.grantId, id))).returning();
          if (!row) throw new Error('attempt update failed'); rows[at] = row; return row;
        },
        updateGrant: async (update) => { await tx.update(grants).set(update).where(eq(grants.id, id)); Object.assign(grant, update); },
        tallies: async (mint, day) => {
          const reserved = await tx.select({ amountRaw: grants.amountRaw, day: grants.day }).from(grants).innerJoin(attempts, eq(attempts.grantId, grants.id))
            .where(and(eq(grants.mint, mint), eq(attempts.phase, 'submitted')));
          const sent = await tx.select({ amountRaw: grants.amountRaw }).from(grants).where(and(eq(grants.mint, mint), eq(grants.day, day), eq(grants.status, 'sent')));
          return { reservedAllRaw: reserved.reduce((sum, row) => sum + BigInt(row.amountRaw), 0n),
            reservedDayRaw: reserved.filter((row) => row.day === day).reduce((sum, row) => sum + BigInt(row.amountRaw), 0n), sentTodayRaw: sent.reduce((sum, row) => sum + BigInt(row.amountRaw), 0n) };
        },
      };
      return run(unit);
    });
  }
  async function findToday(wallet: string, deed: string | null, day: string) {
    const [grant] = await db.select().from(grants).where(and(eq(grants.day, day), or(eq(grants.wallet, wallet), ...(deed ? [eq(grants.deedAssetId, deed)] : [])))).limit(1);
    if (!grant) return null;
    const [attempt] = await db.select().from(attempts).where(eq(attempts.grantId, grant.id)).orderBy(desc(attempts.attemptNo)).limit(1);
    return { grant, attempt: attempt ?? null };
  }
  return { readGrant, withGrant, findToday,
    // Worker/operator-only non-locking snapshot. Settlement rechecks the exact
    // retained attempt under its grant lock; never use this read to sign.
    readReconciliation: async (id: string) => {
      const [grant] = await db.select().from(grants).where(eq(grants.id, id));
      if (!grant) return null;
      const rows = await db.select().from(attempts).where(eq(attempts.grantId, id)).orderBy(desc(attempts.attemptNo));
      return { grant, attempts: rows };
    },
    // K-night-03: the wallet's own `requested` grants, newest first (requested_at, id), each with its latest attempt.
    // Keyset after one of the wallet's own grant ids (any status), compared in SQL so no timestamp precision is lost.
    // `more` = a row exists past this page. Read-only: never locks, expires or changes a grant.
    ownedRequested: async (wallet: string, after?: string) => {
      const size = SKR_FAUCET.devnet.grantReadPageSize;
      if (after) {
        const [cursor] = await db.select({ id: grants.id }).from(grants).where(and(eq(grants.id, after), eq(grants.wallet, wallet)));
        if (!cursor) throw new HttpError(404, 'grant not owned', 'SKR_FAUCET_NOT_OWNED');
      }
      const rows = await db.select().from(grants).where(and(eq(grants.wallet, wallet), eq(grants.status, 'requested'),
        ...(after ? [sql`(${grants.requestedAt}, ${grants.id}) < (SELECT c.requested_at, c.id FROM devnet_skr_faucet_grants c WHERE c.id = ${after}::uuid)`] : []),
      )).orderBy(desc(grants.requestedAt), desc(grants.id)).limit(size + 1);
      const page = rows.slice(0, size), latest = new Map<string, SkrAttempt>();
      if (page.length) {
        for (const row of await db.select().from(attempts).where(inArray(attempts.grantId, page.map((grant) => grant.id))).orderBy(desc(attempts.attemptNo))) {
          if (!latest.has(row.grantId)) latest.set(row.grantId, row);
        }
      }
      return { rows: page.map((grant) => ({ grant, attempt: latest.get(grant.id) ?? null })), more: rows.length > size };
    },
    readAttemptOwner: async (attemptId: string, wallet: string) => {
      const [row] = await db.select({ grant: grants, attempt: attempts }).from(attempts).innerJoin(grants, eq(grants.id, attempts.grantId))
        .where(and(eq(attempts.id, attemptId), eq(grants.wallet, wallet)));
      if (!row) throw new HttpError(404, 'attempt not owned', 'SKR_FAUCET_NOT_OWNED'); return row;
    },
    reserve: async (input: { wallet: string; baseId: string; refreshedDeed: string; enteredAt: Date; mint: string; decimals: number; amountRaw: string }, now: () => Date) => db.transaction(async (tx) => {
      const admission = await lockSkrClaimAdmission(tx, input, now, deedlessOk);
      const [row] = await tx.insert(grants).values({ wallet: input.wallet, baseId: admission.baseId, deedAssetId: admission.deedAssetId,
        day: admission.day, mint: input.mint, decimals: input.decimals, amountRaw: input.amountRaw, requestedAt: admission.admittedAt }).onConflictDoNothing().returning();
      if (row) return { grant: row, conflict: false as const };
      const [existing] = await tx.select().from(grants).where(and(eq(grants.day, admission.day), or(eq(grants.wallet, input.wallet), eq(grants.deedAssetId, admission.deedAssetId)))).limit(1);
      if (!existing) throw new Error('daily conflict without retained grant'); return { grant: existing, conflict: true as const };
    }),
    // Do not let claim-only reservations occupy every batch. A cursor advances
    // past unknown live transfers and wraps, so each retained attempt is polled.
    pending: async (limit: number, after?: SkrSweepCursor, at = new Date()) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > SKR_FAUCET.devnet.maxGrantsPerSweep) throw new Error('invalid sweep limit');
      return db.select({ id: grants.id, requestedAt: grants.requestedAt }).from(grants).where(and(
        eq(grants.status, 'requested'),
        sql`(${grants.day} < ${utcWindow(at).day}::date OR EXISTS (
          SELECT 1 FROM devnet_skr_faucet_attempts a WHERE a.grant_id=${grants.id}
          AND a.phase IN ('prepared','player_signed','submitted')))` ,
        ...(after ? [sql`(${grants.requestedAt}, ${grants.id}) > (${after.requestedAt.toISOString()}::timestamptz, ${after.id}::uuid)`] : []),
      )).orderBy(asc(grants.requestedAt), asc(grants.id)).limit(limit);
    },
  };
}
export type SkrFaucetStore = ReturnType<typeof makeSkrFaucetStore>;
