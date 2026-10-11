/** Permanent deed battle records and replay authorization.
 *
 * The current deed holder inherits the record/replay. Exact monetary values are
 * shown only when that same wallet owned the deed when the battle settled.
 */
import { BATTLE_HISTORY } from '@shardkeep/shared';
import { resolveBaseVisualContext } from '@shardkeep/shared/baseVisual';
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  baseBattleRecords, players, raidReplayTimelines, raids,
} from '../db/schema';
import { HttpError } from '../lib/errors';
import { resolveActiveBase } from './baseOwnership';
import { archivedBuildingHealth } from './raidReplayHealth';
import { decodeReplayTimeline, type ReplayArchiveEnvelope } from './raidReplayArchive';

type BattleRole = 'attacker' | 'defender';
type BattleMode = 'pvp' | 'pve' | 'campaign';
type BattleRecord = typeof baseBattleRecords.$inferSelect;

export interface RecordBaseBattleInput {
  raidId: string;
  attackerBaseId: string;
  /** Absent for PvE/campaign, whose history has no player deed counterparty. */
  defenderBaseId?: string;
  attackerOwnerWallet: string;
  defenderOwnerWallet?: string;
  stars: 0 | 1 | 2 | 3;
  destructionPct: number;
  /** Exact total credited to the attacking deed. */
  lootShards: bigint;
  createdAt?: Date;
}

/** Settlement-side idempotent dual write. The signed deltas make each deed's
 * own economic history self-contained without duplicating the private total. */
export async function recordBaseBattle(
  tx: DbOrTx, input: RecordBaseBattleInput,
): Promise<void> {
  const createdAt = input.createdAt ?? new Date();
  if ((input.defenderBaseId === undefined) !== (input.defenderOwnerWallet === undefined)) {
    throw new Error('base battle record invariant: defender identity must be complete or absent');
  }
  const records: Array<typeof baseBattleRecords.$inferInsert> = [{
    baseId: input.attackerBaseId,
    raidId: input.raidId,
    role: 'attacker',
    ownerWalletAtBattle: input.attackerOwnerWallet,
    counterpartyBaseId: input.defenderBaseId ?? null,
    stars: input.stars,
    destructionPct: input.destructionPct,
    lootDeltaShards: input.lootShards,
    createdAt,
  }];
  if (input.defenderBaseId && input.defenderOwnerWallet) {
    records.push({
      baseId: input.defenderBaseId,
      raidId: input.raidId,
      role: 'defender',
      ownerWalletAtBattle: input.defenderOwnerWallet,
      counterpartyBaseId: input.attackerBaseId,
      stars: input.stars,
      destructionPct: input.destructionPct,
      lootDeltaShards: -input.lootShards,
      createdAt,
    });
  }
  await tx.insert(baseBattleRecords).values(records).onConflictDoNothing();
}

interface HistoryCursor {
  v: number;
  at: string;
  raidId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function encodeCursor(createdAt: Date, raidId: string): string {
  const cursor: HistoryCursor = {
    v: BATTLE_HISTORY.cursorVersion,
    at: createdAt.toISOString(),
    raidId,
  };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): { createdAt: Date; raidId: string } {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<HistoryCursor>;
    const createdAt = typeof parsed.at === 'string' ? new Date(parsed.at) : new Date(Number.NaN);
    if (parsed.v !== BATTLE_HISTORY.cursorVersion || !UUID_RE.test(parsed.raidId ?? '')
      || Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== parsed.at) {
      throw new Error('invalid');
    }
    return { createdAt, raidId: parsed.raidId! };
  } catch {
    throw new HttpError(422, 'bad battle history cursor');
  }
}

function battleResult(role: BattleRole, stars: number): 'victory' | 'defeat' {
  const attackerWon = stars >= 1;
  return role === 'attacker'
    ? (attackerWon ? 'victory' : 'defeat')
    : (attackerWon ? 'defeat' : 'victory');
}

function pageLimit(requested?: number): number {
  return Math.min(
    Math.max(1, requested ?? BATTLE_HISTORY.defaultPageSize),
    BATTLE_HISTORY.maxPageSize,
  );
}

function modeOf(raid: Pick<typeof raids.$inferSelect, 'pveCampId' | 'campaignStage'> | undefined): BattleMode {
  if (raid?.campaignStage !== null && raid?.campaignStage !== undefined) return 'campaign';
  if (raid?.pveCampId !== null && raid?.pveCampId !== undefined) return 'pve';
  return 'pvp';
}

function storedRaidLoot(result: unknown): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return '0';
  const value = (result as Record<string, unknown>)['lootShards'];
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) {
    return String(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return value;
  return '0';
}

/** Hydrate one bounded page without widening either authorization scope. PvE
 * KEEP bounty comes from the immutable resolved result; deed SHARDS always use
 * the signed record delta. This distinction is why a PvE row must not pretend
 * its zero SHARD delta means the attacker earned nothing. */
async function hydrateBattleRows(db: DbOrTx, wallet: string, page: BattleRecord[]) {
  const raidIds = page.map((row) => row.raidId);
  const [counterpartRows, raidRows] = raidIds.length === 0
    ? [[], []] as [BattleRecord[], Array<Pick<typeof raids.$inferSelect,
      'id' | 'pveCampId' | 'campaignStage' | 'result'>>]
    : await Promise.all([
      db.select().from(baseBattleRecords).where(inArray(baseBattleRecords.raidId, raidIds)),
      db.select({
        id: raids.id,
        pveCampId: raids.pveCampId,
        campaignStage: raids.campaignStage,
        result: raids.result,
      }).from(raids).where(inArray(raids.id, raidIds)),
    ]);
  const counterpartByRaid = new Map<string, BattleRecord>();
  for (const own of page) {
    const counterpart = counterpartRows.find((candidate) => (
      candidate.raidId === own.raidId && candidate.role !== own.role
    ));
    if (counterpart) counterpartByRaid.set(own.raidId, counterpart);
  }
  const raidById = new Map(raidRows.map((row) => [row.id, row]));
  const opponentWallets = [...new Set(
    [...counterpartByRaid.values()].map((row) => row.ownerWalletAtBattle),
  )];
  const identities = opponentWallets.length === 0 ? [] : await db.select({
    wallet: players.wallet,
    name: players.name,
    seeker: players.seekerVerified,
  }).from(players).where(inArray(players.wallet, opponentWallets));
  const identityByWallet = new Map(identities.map((row) => [row.wallet, row]));

  return page.map((row) => {
    const exactLootVisible = row.ownerWalletAtBattle === wallet;
    const counterparty = counterpartByRaid.get(row.raidId);
    const opponent = counterparty
      ? identityByWallet.get(counterparty.ownerWalletAtBattle)
      : undefined;
    const raid = raidById.get(row.raidId);
    const mode = modeOf(raid);
    const settledAmount = exactLootVisible
      ? (mode === 'pve' ? storedRaidLoot(raid?.result) : row.lootDeltaShards.toString())
      : null;
    return {
      baseId: row.baseId,
      raidId: row.raidId,
      role: row.role,
      mode,
      opponentLabel: mode === 'campaign'
        ? `CAMPAIGN STAGE ${raid?.campaignStage ?? '?'}`
        : mode === 'pve' ? 'PVE CAMP' : null,
      result: battleResult(row.role, row.stars),
      stars: row.stars,
      destructionPct: row.destructionPct,
      lootDeltaShards: exactLootVisible ? row.lootDeltaShards.toString() : null,
      settledAmount,
      settledCurrency: mode === 'pve' ? 'KEEP' as const : 'SHARDS' as const,
      lootRedacted: !exactLootVisible,
      ownerWalletAtBattle: exactLootVisible ? row.ownerWalletAtBattle : null,
      opponent: counterparty ? {
        baseId: row.counterpartyBaseId,
        wallet: counterparty.ownerWalletAtBattle,
        name: opponent?.name ?? '',
        seeker: opponent?.seeker ?? false,
      } : null,
      createdAt: row.createdAt,
    };
  });
}

export async function getBaseBattleHistory(
  db: DbOrTx,
  wallet: string,
  requestedBaseId: string,
  opts: { cursor?: string; limit?: number } = {},
) {
  const selected = await resolveActiveBase(db, wallet, requestedBaseId);
  if (!selected) throw new HttpError(404, 'base not found', 'BASE_NOT_OWNED');
  const limit = pageLimit(opts.limit);
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  const rows = await db.select().from(baseBattleRecords).where(and(
    eq(baseBattleRecords.baseId, selected.base.id),
    ...(cursor ? [or(
      lt(baseBattleRecords.createdAt, cursor.createdAt),
      and(
        eq(baseBattleRecords.createdAt, cursor.createdAt),
        lt(baseBattleRecords.raidId, cursor.raidId),
      ),
    )!] : []),
  )).orderBy(desc(baseBattleRecords.createdAt), desc(baseBattleRecords.raidId))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const items = await hydrateBattleRows(db, wallet, page);
  const last = page.at(-1);
  return {
    baseId: selected.base.id,
    battles: items,
    nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.raidId) : null,
  };
}

/** Immutable participant authorization survives a deed transfer. Unlike the
 * current-deed endpoint, this scope is the wallet frozen into the battle row,
 * so a seller retains their exact outcome while gaining no access to later
 * battles fought by the buyer. */
export async function getParticipantBattleHistory(
  db: DbOrTx,
  wallet: string,
  opts: { cursor?: string; limit?: number } = {},
) {
  const limit = pageLimit(opts.limit);
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  const rows = await db.select().from(baseBattleRecords).where(and(
    eq(baseBattleRecords.ownerWalletAtBattle, wallet),
    ...(cursor ? [or(
      lt(baseBattleRecords.createdAt, cursor.createdAt),
      and(
        eq(baseBattleRecords.createdAt, cursor.createdAt),
        lt(baseBattleRecords.raidId, cursor.raidId),
      ),
    )!] : []),
  )).orderBy(desc(baseBattleRecords.createdAt), desc(baseBattleRecords.raidId))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    battles: await hydrateBattleRows(db, wallet, page),
    nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.raidId) : null,
  };
}

function publicReplayResult(result: unknown, exactLootVisible: boolean): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const copy = { ...(result as Record<string, unknown>) };
  if (!exactLootVisible) {
    for (const key of Object.keys(copy)) {
      if (/loot|reward.*shard|balance.*shard|forge.*shard/i.test(key)) copy[key] = null;
    }
  }
  return { ...copy, lootRedacted: !exactLootVisible };
}

/** Current deed ownership authorizes inherited replay access. Historical exact
 * loot is redacted after sale, while battle/opponent/result metadata remains. */
async function replayForRecord(
  db: DbOrTx, record: BattleRecord, exactLootVisible: boolean, includeNativeHealth = false,
) {
  const raidId = record.raidId;
  const [raid] = await db.select().from(raids).where(eq(raids.id, raidId));
  if (!raid || raid.status !== 'resolved') throw new HttpError(404, 'replay not found');
  const [timeline] = await db.select().from(raidReplayTimelines)
    .where(eq(raidReplayTimelines.raidId, raidId));
  if (!timeline) throw new HttpError(409, 'replay archive is unavailable');
  let archived: ReplayArchiveEnvelope;
  let buildingHealth: ReturnType<typeof archivedBuildingHealth>;
  try {
    archived = decodeReplayTimeline(timeline);
    if (includeNativeHealth) buildingHealth = archivedBuildingHealth(archived);
  } catch {
    throw new HttpError(409, 'replay archive failed its integrity check');
  }
  let snapshot = archived.snapshot;
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    const { surplusShards: _privateSurplus, ...redactedSnapshot } = snapshot as Record<string, unknown>;
    snapshot = redactedSnapshot;
  }
  return {
    id: raid.id,
    baseId: record.baseId,
    role: record.role,
    snapshot,
    visualContext: resolveBaseVisualContext(archived.visualContext),
    ...(archived.boundCosmeticVisual === undefined ? {} : { boundCosmeticVisual: archived.boundCosmeticVisual }),
    ...(archived.servicePresentation===undefined?{}:{servicePresentation:archived.servicePresentation}),
    ...(archived.advancedServicePresentation===undefined?{}:{advancedServicePresentation:archived.advancedServicePresentation}),
    orders: archived.orders,
    seed: archived.seed,
    simVersion: archived.simVersion,
    events: archived.events,
    result: publicReplayResult(archived.result, exactLootVisible),
    armySnapshot: archived.armySnapshot,
    ...(includeNativeHealth ? { buildingHealth } : {}),
    timeline: {
      formatVersion: timeline.formatVersion,
      codec: timeline.codec,
      byteLength: timeline.byteLength,
      eventCount: timeline.eventCount,
      durationMs: timeline.durationMs,
      sha256: timeline.sha256,
      integrityVerified: true,
    },
  };
}

export async function getBaseBattleReplay(
  db: DbOrTx, wallet: string, requestedBaseId: string, raidId: string,
) {
  const selected = await resolveActiveBase(db, wallet, requestedBaseId);
  if (!selected) throw new HttpError(404, 'replay not found');
  const [record] = await db.select().from(baseBattleRecords).where(and(
    eq(baseBattleRecords.baseId, selected.base.id),
    eq(baseBattleRecords.raidId, raidId),
  ));
  if (!record) throw new HttpError(404, 'replay not found');
  return replayForRecord(db, record, record.ownerWalletAtBattle === wallet);
}

/** Prior participants receive the same integrity-verified archive and their
 * exact settled result after a sale. The current buyer is not a participant in
 * the seller's battle and therefore cannot use this route as a redaction bypass. */
export async function getParticipantBattleReplay(db: DbOrTx, wallet: string, raidId: string, includeNativeHealth = false) {
  const [record] = await db.select().from(baseBattleRecords).where(and(
    eq(baseBattleRecords.raidId, raidId),
    eq(baseBattleRecords.ownerWalletAtBattle, wallet),
  ));
  if (!record) throw new HttpError(404, 'replay not found');
  return replayForRecord(db, record, true, includeNativeHealth);
}
