import {raidAdvancedFields} from './raidAdvancedPresentation';
import {raidStarterFields} from './raidStarterPresentation';
import {boundCosmeticRaidFields} from './boundCosmeticPresentation';
import { assertCurrentRaidInputVersion, canResolveWithCurrentSimulator } from './raidSimVersion';
import { isBattlefieldTileDeployable, occupiedBattlefieldTiles } from '@shardkeep/shared/battlefield';
import { markRaidBaseChanged, raidEventTransaction } from '../lib/raidEventBus';
/**
 * Server-sequenced live raid input and defender reconnect stream.
 *
 * On a 'live' stream clients never submit authoritative timestamps: each
 * accepted command is stamped against the server-owned battle clock. A V1
 * 'batch' journal (D-099) keeps the client's battle offsets; V2 instead stages
 * pre-ATTACK input at zero and server-stamps later input from the same canonical
 * piecewise clock as live PvP. Both are append-only,
 * deduplicated by a caller-generated id, and later converted into the
 * deterministic simulator's RaidOrders, so watching live, replaying later and
 * the worker finishing a raid without its client consume one truthful history.
 */
import { createHash } from 'node:crypto';
import { resolveBaseVisualContext } from '@shardkeep/shared/baseVisual';
import {
  BUFFS, DEFENSES, GRID, HERO_KEYS, LIVE_RAID, RAID_REPLAY_LIMITS, RAID_RULES, RALLY, TRAP_TYPES, TROOP_ABILITIES, TROOP_TYPES,
  isTrainableTroop,
  plotBounds,
  resolveBuildingGeometryVersion,
  type BaseSnapshot,
  type HeroCombatLoadout, type HeroKey, type LiveRaidClock, type LiveRaidClockRate,
  type RaidProtocolVersion, type TroopType,
} from '@shardkeep/shared';
import { MAX_TICKS, SIM_VERSION, type RaidOutcome } from '@shardkeep/sim';
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Db, DbOrTx, DbTx } from '../db/client';
import {
  accounts, baseRaidLocks, bases, deedOwnershipObservations, ledgerEntries,
  ledgerTransactions, players, raidCommands, raidLiveStates, raids,
} from '../db/schema';
import { HttpError } from '../lib/errors';
import { refundPostedSpend, spendGameCurrency } from './spend';
import { InsufficientFundsError } from '../ledger/ledger';
import { footprintOf } from './footprints';
import {
  breakBaseShieldOnAttack, invalidateShieldMapValley, shieldMapValleyId,
} from './baseShields';
import { releaseRaidHeroes } from './heroRaidReservations';
import { releaseDeedRaidLoot } from './raidLoot';
import { consumeArmy } from './army';
import { recordBaseBattle } from './baseBattleHistory';
import { persistReplayTimeline } from './raidReplayArchive';
import { claimRaidSimulationPermit, RaidSimulationBusyError } from './raidSimulationRunner';
import type { RaidSimulationWorkerInput } from './raidSimulationWorker';

/** `tMs` is the client-owned battle offset of a batch journal order; a live
 * stream refuses it because the server clock is the only authority there. */
export type LiveRaidCommand =
  | { kind: 'deploy'; payload: { troop: TroopType; tx: number; ty: number; tMs?: number | undefined } }
  | { kind: 'hero'; payload: { hero: HeroKey; tx: number; ty: number; tMs?: number | undefined } }
  | { kind: 'rally'; payload: { tx: number; ty: number; tMs?: number | undefined } }
  | { kind: 'buff'; payload: { buff: 'warhorn' | 'swiftboots' | 'powdercharge' } };

export type LiveRaidControlCommand =
  | { kind: 'start'; payload: { expectedClockRevision: number; automatic?: boolean | undefined } }
  | { kind: 'speed'; payload: { expectedClockRevision: number; rate: LiveRaidClockRate } }
  | { kind: 'retreat'; payload: Record<string, never> };

type AnyLiveRaidCommand = LiveRaidCommand | LiveRaidControlCommand;
type LiveRaidClockControlCommand = Exclude<LiveRaidControlCommand, { kind: 'retreat' }>;
export type CanonicalLiveRaidClock = LiveRaidClock<Date>;

export interface AcceptedLiveRaidCommand {
  sequence: number;
  clientCommandId: string;
  kind: AnyLiveRaidCommand['kind'];
  payload: AnyLiveRaidCommand['payload'];
  serverOffsetMs: number;
  acceptedAt: Date;
}

export interface LiveRaidCommandReceipt {
  command: AcceptedLiveRaidCommand;
  clock: CanonicalLiveRaidClock;
}

type LiveState = typeof raidLiveStates.$inferSelect;
type StoredClock = LiveRaidClock<string>;
type StoredPayload = Record<string, unknown> & { _clock?: StoredClock; _changed?: boolean };

const raidDurationMs = (): number => RAID_RULES.battleDurationSec * 1_000;
const RESERVED_CLIENT_COMMAND_PREFIX = 'system:';

function validClientCommandId(clientCommandId: string): boolean {
  return clientCommandId.length > 0
    && clientCommandId.length <= LIVE_RAID.clientCommandIdMaxLength
    && !clientCommandId.startsWith(RESERVED_CLIENT_COMMAND_PREFIX);
}

/** Integer, piecewise simulator clock. Wall time before an anchor never rewinds
 * the simulation, and every segment is clamped to the immutable duration. */
export function raidSimAtWallMs(
  wallMs: number,
  anchorWallMs: number,
  anchorSimMs: number,
  rate: LiveRaidClockRate,
  durationMs = raidDurationMs(),
): number {
  return Math.min(durationMs, anchorSimMs + Math.max(0, wallMs - anchorWallMs) * rate);
}

function canonicalClock(live: LiveState, serverNow: Date): CanonicalLiveRaidClock {
  const protocolVersion = live.commandProtocolVersion as RaidProtocolVersion;
  const rate = live.commandProtocolVersion === LIVE_RAID.protocolVersion
    ? live.clockRate as LiveRaidClockRate
    : LIVE_RAID.legacyProtocolVersion;
  const anchorWallAt = live.commandProtocolVersion === LIVE_RAID.protocolVersion
    ? live.clockAnchorWallAt
    : live.startedAt;
  const anchorSimMs = live.commandProtocolVersion === LIVE_RAID.protocolVersion
    ? live.clockAnchorSimMs ?? 0
    : 0;
  return {
    protocolVersion,
    revision: live.commandProtocolVersion === LIVE_RAID.protocolVersion
      ? live.clockRevision : 0,
    rate,
    anchorWallAt,
    anchorSimMs,
    serverNow,
    simNowMs: anchorWallAt
      ? raidSimAtWallMs(serverNow.getTime(), anchorWallAt.getTime(), anchorSimMs, rate)
      : 0,
    battleEndsAt: live.battleEndsAt,
    durationMs: raidDurationMs(),
  };
}

function storedClock(clock: CanonicalLiveRaidClock): StoredClock {
  return {
    ...clock,
    anchorWallAt: clock.anchorWallAt?.toISOString() ?? null,
    serverNow: clock.serverNow.toISOString(),
    battleEndsAt: clock.battleEndsAt?.toISOString() ?? null,
  };
}

function restoredClock(value: StoredClock | undefined): CanonicalLiveRaidClock | null {
  if (!value) return null;
  return {
    ...value,
    anchorWallAt: value.anchorWallAt ? new Date(value.anchorWallAt) : null,
    serverNow: new Date(value.serverNow),
    battleEndsAt: value.battleEndsAt ? new Date(value.battleEndsAt) : null,
  };
}

function publicPayload(payload: unknown): AnyLiveRaidCommand['payload'] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload as AnyLiveRaidCommand['payload'];
  }
  const { _clock: _storedReceipt, _changed: _changedClock, ...publicValue } = payload as StoredPayload;
  return publicValue as AnyLiveRaidCommand['payload'];
}

export async function raidTransactionWallNow(tx: DbTx, explicit?: Date): Promise<Date> {
  if (explicit) return explicit;
  const rows = (await tx.execute(sql`select clock_timestamp() as now`)) as unknown as Array<{ now: Date }>;
  return new Date(rows[0]!.now);
}

/** One database-clock sample for worker candidate discovery. Mutating paths
 * sample again after their canonical rows are locked. */
export function raidDatabaseWallNow(db: Db): Promise<Date> {
  return db.transaction((tx) => raidTransactionWallNow(tx));
}

/** `raid_commands.id` is a bigint database cursor, not part of the replay
 * protocol. Returning a raw Drizzle row commits the command and then makes
 * Fastify fail while JSON-serializing that id. Keep every live-command wire
 * path on this explicit projection so an accepted deploy can always be
 * acknowledged and later hydrated. */
const acceptedLiveCommandColumns = {
  sequence: raidCommands.sequence,
  clientCommandId: raidCommands.clientCommandId,
  kind: raidCommands.kind,
  payload: raidCommands.payload,
  serverOffsetMs: raidCommands.serverOffsetMs,
  acceptedAt: raidCommands.acceptedAt,
};

function toAcceptedLiveRaidCommand(row: {
  sequence: number;
  clientCommandId: string;
  kind: string;
  payload: unknown;
  serverOffsetMs: number;
  acceptedAt: Date;
}): AcceptedLiveRaidCommand {
  return {
    sequence: row.sequence,
    clientCommandId: row.clientCommandId,
    kind: row.kind as AnyLiveRaidCommand['kind'],
    payload: publicPayload(row.payload),
    serverOffsetMs: row.serverOffsetMs,
    acceptedAt: row.acceptedAt,
  };
}

/** Raid participant wallets are immutable history, but stable-base mutation
 * authority follows the deed. Internal recovery may finish frozen accepted
 * commands separately; a player-facing command/submit must still own the
 * attacking base and must not have positive finalized ownership-loss evidence. */
export async function assertCurrentRaidAttackerAuthority(
  db: DbOrTx,
  wallet: string,
  raid: { attackerWallet: string; attackerBaseId: string | null },
): Promise<void> {
  if (raid.attackerWallet !== wallet) throw new HttpError(404, 'raid not found');
  if (!raid.attackerBaseId) return;
  const [base] = await db.select({
    ownerWallet: bases.ownerWallet,
    deedAssetId: bases.deedAssetId,
  }).from(bases).where(eq(bases.id, raid.attackerBaseId)).for('update');
  if (!base || base.ownerWallet !== wallet) {
    throw new HttpError(409, 'attacking deed ownership changed', 'DEED_OWNERSHIP_CHANGED');
  }
  if (!base.deedAssetId) return;
  const [latest] = await db.select({
    owner: deedOwnershipObservations.owner,
    status: deedOwnershipObservations.status,
  }).from(deedOwnershipObservations).where(and(
    eq(deedOwnershipObservations.baseId, raid.attackerBaseId),
    eq(deedOwnershipObservations.assetId, base.deedAssetId),
  )).orderBy(desc(deedOwnershipObservations.checkedAt)).limit(1);
  // An unavailable RPC is not evidence that ownership changed and must not
  // interrupt a 90-second live battle. Mismatch/ineligible is positive evidence.
  if (latest && latest.status !== 'unavailable'
    && (latest.status !== 'owned' || latest.owner !== wallet)) {
    throw new HttpError(409, 'attacking deed ownership changed', 'DEED_OWNERSHIP_CHANGED');
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

function commandHash(command: AnyLiveRaidCommand): string {
  return createHash('sha256').update(canonicalJson(command)).digest('hex');
}

function payloadBytes(command: AnyLiveRaidCommand): number {
  return Buffer.byteLength(canonicalJson(command), 'utf8');
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth++) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Called inside createRaid after the PvP row exists and defender base is locked. */
export async function initializeLiveRaid(
  db: DbOrTx,
  raidId: string,
  defenderBaseId: string,
  expiresAt: Date,
  now = new Date(),
  protocolVersion: RaidProtocolVersion = LIVE_RAID.legacyProtocolVersion,
): Promise<void> {
  try {
    await db.insert(baseRaidLocks).values({
      baseId: defenderBaseId,
      raidId,
      expiresAt: new Date(expiresAt.getTime() + LIVE_RAID.recoveryGraceSec * 1_000),
      acquiredAt: now,
      heartbeatAt: now,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    throw new HttpError(
      409,
      'that base is already being raided',
      'BASE_ALREADY_UNDER_RAID',
    );
  }
  markRaidBaseChanged(db, defenderBaseId);
  await db.insert(raidLiveStates).values({
    raidId,
    commandProtocolVersion: protocolVersion,
    updatedAt: now,
  });
}

/** D-099: a PvE, campaign or legacy PvP raid has no defender deed to lock, but
 * it still journals every order as it is placed so the worker can finish the
 * raid when the client never posts its final list. No base_raid_locks row:
 * nothing is reserved, and until the first order arrives the ordinary batch
 * expiry keeps owning the row exactly as before. */
export async function initializeBatchRaidJournal(
  db: DbOrTx,
  raidId: string,
  now = new Date(),
  protocolVersion: RaidProtocolVersion = LIVE_RAID.legacyProtocolVersion,
): Promise<void> {
  await db.insert(raidLiveStates).values({
    raidId,
    mode: 'batch',
    commandProtocolVersion: protocolVersion,
    updatedAt: now,
  });
}

/** Effective server deadline for a batch raid: the stored/wire deadline plus
 * the bounded finalization tail. Kept separate from `raids.ordersDeadlineAt`
 * so pre-rollout rows and old clients remain compatible; a batch journal
 * closes on the same clock so the worker never settles a raid its client
 * could still legally be posting. */
export function batchOrdersSubmitDeadlineAt(ordersDeadlineAt: Date): Date {
  return new Date(ordersDeadlineAt.getTime() + RAID_RULES.batchOrdersGraceSec * 1_000);
}

export async function getActiveBaseRaid(
  db: DbOrTx, baseId: string,
): Promise<{ raidId: string; state: 'reserved' | 'live' | 'releasing' } | null> {
  const [row] = await db.select({ raidId: baseRaidLocks.raidId, state: baseRaidLocks.state })
    .from(baseRaidLocks).where(eq(baseRaidLocks.baseId, baseId));
  return row ?? null;
}

function validateCommandShape(command: LiveRaidCommand): void {
  if (command.kind === 'deploy' && !TROOP_TYPES.includes(command.payload.troop)) {
    throw new HttpError(400, 'unknown troop command');
  }
  if (command.kind === 'hero' && !HERO_KEYS.includes(command.payload.hero)) {
    throw new HttpError(400, 'unknown hero command');
  }
  if ((command.kind === 'deploy' || command.kind === 'hero' || command.kind === 'rally')
    && (!Number.isInteger(command.payload.tx) || !Number.isInteger(command.payload.ty))) {
    throw new HttpError(400, 'raid command coordinates must be integer tiles');
  }
  if (command.kind === 'rally') {
    // Wider deployment/home geometry does not change the existing rally rule.
    const { min, max } = plotBounds();
    if (command.payload.tx < min || command.payload.ty < min
      || command.payload.tx >= max || command.payload.ty >= max) {
      throw new HttpError(400, 'rally must be inside the original base frame');
    }
  }
  if (command.kind === 'buff'
    && !(['warhorn', 'swiftboots', 'powdercharge'] as const).includes(command.payload.buff)) {
    throw new HttpError(400, 'unknown raid buff');
  }
  // A journaled offset is replayed verbatim, so it must already be a legal
  // simulator deploy time: an integer inside the battle, never beyond it.
  if (command.kind !== 'buff' && command.payload.tMs !== undefined
    && (!Number.isInteger(command.payload.tMs) || command.payload.tMs < 0
      || command.payload.tMs > RAID_RULES.battleDurationSec * 1_000)) {
    throw new HttpError(400, 'raid command offset must be inside the battle');
  }
  if (payloadBytes(command) > LIVE_RAID.payloadMaxBytes) {
    throw new HttpError(413, 'raid command payload is too large', 'RAID_COMMAND_TOO_LARGE');
  }
}

export function validateDropPoint(snapshot: BaseSnapshot, tx: number, ty: number): void {
  const geometryVersion = resolveBuildingGeometryVersion(snapshot.geometryVersion);
  const occupied = occupiedBattlefieldTiles(snapshot.buildings.map((building) => ({
    ...building, ...footprintOf(building.type, geometryVersion),
  })));
  if (!isBattlefieldTileDeployable(tx, ty, snapshot, occupied)) {
    throw new HttpError(422, `deploy outside the deploy zone: (${tx},${ty})`);
  }
}

/** Start an armed V2 batch raid at the immutable deploy cutoff. Caller already
 * owns the raids row and then the live-state row, which is the clock lock order. */
async function autoStartLocked(
  tx: DbTx,
  raid: typeof raids.$inferSelect,
  live: LiveState,
  wallNow: Date,
): Promise<LiveState> {
  if (!canResolveWithCurrentSimulator(raid.simVersion)
    || live.commandProtocolVersion !== LIVE_RAID.protocolVersion
    || raid.status !== 'pending_orders' || live.streamClosedAt
    || live.startedAt || !live.armedAt) return live;
  const cutoff = new Date(raid.createdAt.getTime() + RAID_RULES.deployWindowSec * 1_000);
  if (wallNow < cutoff) return live;
  const sequence = live.lastSequence + 1;
  const next: LiveState = {
    ...live,
    lastSequence: sequence,
    clockRevision: live.clockRevision + 1,
    clockRate: 1,
    clockAnchorWallAt: cutoff,
    clockAnchorSimMs: 0,
    startedAt: cutoff,
    battleEndsAt: new Date(cutoff.getTime() + raidDurationMs()),
    updatedAt: wallNow,
  };
  const command: LiveRaidControlCommand = {
    kind: 'start', payload: { expectedClockRevision: live.clockRevision, automatic: true },
  };
  const receiptClock = canonicalClock(next, wallNow);
  await tx.insert(raidCommands).values({
    raidId: raid.id,
    sequence,
    clientCommandId: 'system:auto-start',
    kind: command.kind,
    payload: { ...command.payload, _clock: storedClock(receiptClock) },
    serverOffsetMs: receiptClock.simNowMs,
    payloadHash: commandHash(command),
    acceptedAt: wallNow,
  });
  await tx.update(raidLiveStates).set({
    lastSequence: next.lastSequence,
    clockRevision: next.clockRevision,
    clockRate: next.clockRate,
    clockAnchorWallAt: next.clockAnchorWallAt,
    clockAnchorSimMs: next.clockAnchorSimMs,
    startedAt: next.startedAt,
    battleEndsAt: next.battleEndsAt,
    updatedAt: wallNow,
  }).where(eq(raidLiveStates.raidId, raid.id));
  return next;
}

export async function acceptLiveRaidCommandReceipt(
  db: Db,
  attackerWallet: string,
  raidId: string,
  clientCommandId: string,
  command: LiveRaidCommand,
  now?: Date,
): Promise<LiveRaidCommandReceipt> {
  if (!validClientCommandId(clientCommandId)) {
    throw new HttpError(400, 'invalid client command id');
  }
  validateCommandShape(command);
  const hash = commandHash(command);
  const committed = await raidEventTransaction(db, async (tx) => {
    // Create/expiry can hold an attacker base before examining old raids.
    // Share their player-first mutex so this raid→base path cannot invert
    // those locks when another tab starts a march or refreshes energy.
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, attackerWallet)).for('update');
    if (!player) throw new HttpError(404, 'live raid not found');
    const [raid] = await tx.select().from(raids).where(and(
      eq(raids.id, raidId), eq(raids.attackerWallet, attackerWallet),
    )).for('update');
    if (!raid) throw new HttpError(404, 'live raid not found');
    await assertCurrentRaidAttackerAuthority(tx, attackerWallet, raid);
    let [live] = await tx.select().from(raidLiveStates)
      .where(eq(raidLiveStates.raidId, raidId)).for('update');
    // Only the live stream is bound to both deeds: a batch journal (D-099) has
    // no defender base and, for legacy PvP, no attacking base either.
    const batch = live?.mode === 'batch';
    if (!batch && (!raid.defenderBaseId || !raid.attackerBaseId)) {
      throw new HttpError(404, 'live raid not found');
    }
    if (!live || !([LIVE_RAID.legacyProtocolVersion, LIVE_RAID.protocolVersion] as number[])
      .includes(live.commandProtocolVersion)) {
      throw new HttpError(409, 'live raid protocol is unavailable', 'RAID_PROTOCOL_MISMATCH');
    }
    const clientOffsetMs = command.kind === 'buff' ? undefined : command.payload.tMs;
    if (batch) {
      if (live.commandProtocolVersion === LIVE_RAID.legacyProtocolVersion
        && command.kind !== 'buff' && clientOffsetMs === undefined) {
        throw new HttpError(400, 'batch raid commands carry their battle offset');
      }
      if (live.commandProtocolVersion === LIVE_RAID.protocolVersion
        && clientOffsetMs !== undefined) {
        throw new HttpError(400, 'raid protocol v2 commands are stamped by the server');
      }
    } else if (clientOffsetMs !== undefined) {
      throw new HttpError(400, 'live raid commands are stamped by the server');
    }
    const [duplicate] = await tx.select({
      ...acceptedLiveCommandColumns,
      payloadHash: raidCommands.payloadHash,
    }).from(raidCommands).where(and(
      eq(raidCommands.raidId, raidId),
      eq(raidCommands.clientCommandId, clientCommandId),
    ));
    if (duplicate) {
      if (duplicate.payloadHash !== hash) {
        throw new HttpError(
          409, 'client command id is bound to different input', 'RAID_COMMAND_MISMATCH',
        );
      }
      return {
        receipt: {
          command: toAcceptedLiveRaidCommand(duplicate),
          clock: restoredClock((duplicate.payload as StoredPayload)._clock)
            ?? canonicalClock(live, duplicate.acceptedAt),
        },
        shieldMapValleyId: null,
      };
    }
    assertCurrentRaidInputVersion(raid.simVersion);
    if (raid.status !== 'pending_orders') throw new HttpError(422, 'raid already resolved');
    // Production samples PostgreSQL only after both canonical rows are locked.
    // Explicit clocks exist solely for deterministic tests.
    const wallNow = await raidTransactionWallNow(tx, now);
    live = await autoStartLocked(tx, raid, live, wallNow);
    if (live.streamClosedAt) throw new HttpError(422, 'raid command stream is closed');
    if (live.lastSequence + 1 >= LIVE_RAID.maxCommands) {
      throw new HttpError(422, 'raid command limit reached', 'RAID_COMMAND_LIMIT');
    }
    const acceptedRows = await tx.select({
      kind: raidCommands.kind, payload: raidCommands.payload,
    }).from(raidCommands).where(eq(raidCommands.raidId, raidId));
    const hasAcceptedUnit = acceptedRows.some((row) => (
      row.kind === 'deploy' || row.kind === 'hero'
    ));
    const army = raid.armySnapshot as {
      counts?: Partial<Record<TroopType, number>>;
      heroes?: HeroKey[];
      attackerKeepLevel?: number;
    };
    if (command.kind === 'deploy') {
      validateDropPoint(raid.snapshot as BaseSnapshot, command.payload.tx, command.payload.ty);
      if (!isTrainableTroop(command.payload.troop)) {
        throw new HttpError(422, `${command.payload.troop} cannot be deployed directly`);
      }
      const already = acceptedRows.filter((row) => row.kind === 'deploy'
        && (row.payload as { troop?: unknown }).troop === command.payload.troop).length;
      if (already >= (army.counts?.[command.payload.troop] ?? 0)) {
        throw new HttpError(422, `not enough ${command.payload.troop} in camp`);
      }
    } else if (command.kind === 'hero') {
      validateDropPoint(raid.snapshot as BaseSnapshot, command.payload.tx, command.payload.ty);
      if (!army.heroes?.includes(command.payload.hero)) {
        throw new HttpError(422, `you have not recruited ${command.payload.hero}`);
      }
      if (acceptedRows.some((row) => row.kind === 'hero'
        && (row.payload as { hero?: unknown }).hero === command.payload.hero)) {
        throw new HttpError(422, `${command.payload.hero} is already deployed`);
      }
    } else if (command.kind === 'rally') {
      if ((army.attackerKeepLevel ?? 0) < RALLY.unlockKeepLevel) {
        throw new HttpError(422, `Rally unlocks at Keep ${RALLY.unlockKeepLevel}`);
      }
      if (acceptedRows.some((row) => row.kind === 'rally')) {
        throw new HttpError(422, 'rally is already placed');
      }
    } else if (command.kind === 'buff') {
      if (acceptedRows.some((row) => row.kind === 'buff'
        && (row.payload as { buff?: unknown }).buff === command.payload.buff)) {
        throw new HttpError(422, `${command.payload.buff} is already active`);
      }
      // Buffs are timeless SIM13 inputs. Accepting one after combat began would
      // apply it retroactively from tick zero, despite the player buying it
      // after observing most of an unbuffed fight. Stage it before the first
      // unit or reject it for v2; timed buffs require a future SIM protocol.
      // Existing v1 clients journal their selected buffs at ATTACK, after the
      // prebattle unit rows. Preserve that protocol during rolling deployment.
      if (live.commandProtocolVersion === LIVE_RAID.protocolVersion
        && (live.startedAt || hasAcceptedUnit)) {
        throw new HttpError(422, 'choose buffs before deploying the first unit', 'RAID_BUFF_ALREADY_STARTED');
      }
    }

    let startedAt = live.startedAt;
    let battleEndsAt = live.battleEndsAt;
    let armedAt = live.armedAt;
    let clockRevision = live.clockRevision;
    let clockRate = live.clockRate as LiveRaidClockRate;
    let clockAnchorWallAt = live.clockAnchorWallAt;
    let clockAnchorSimMs = live.clockAnchorSimMs;
    let shieldBroken = false;
    if (!startedAt) {
      // A staged buff neither attacks nor arms the automatic-start cutoff. It
      // is charged durably now, and refunded if the raid expires without any
      // troop/hero ever crossing the deployment boundary.
      if (command.kind === 'buff') {
        // Leave every lifecycle field unchanged.
      } else {
      // Reservation itself is not an attack: only the first actual unit deploy
      // starts the clock and breaks the attacking deed's shield.
      const stagedBatchControl = batch
        && live.commandProtocolVersion === LIVE_RAID.protocolVersion
        && live.armedAt !== null
        && command.kind === 'rally';
      if (command.kind !== 'deploy' && command.kind !== 'hero' && !stagedBatchControl) {
        throw new HttpError(422, 'deploy a unit to start the raid');
      }
      if (batch && live.commandProtocolVersion === LIVE_RAID.protocolVersion) {
        const latestStart = raid.createdAt.getTime() + RAID_RULES.deployWindowSec * 1_000;
        if (wallNow.getTime() > latestStart) throw new HttpError(422, 'deploy window expired');
        // V2 batch raids stage the complete army at t=0. ATTACK (/start), or
        // the 30-second worker cutoff, starts the authoritative wall clock.
        armedAt ??= wallNow;
      } else if (batch) {
        // The batch battle clock runs on the client (every order carries its
        // own offset), so the journal opens at the raid's creation and closes
        // on the same wall-clock deadline the whole-list POST already had. A
        // started journal is never expired or refunded: the worker settles
        // whatever was received once that deadline passes (D-099). Shields
        // and locks are untouched — a batch raid breaks protection at
        // settlement, exactly as its /orders POST always did.
        startedAt = raid.createdAt;
        battleEndsAt = batchOrdersSubmitDeadlineAt(raid.ordersDeadlineAt);
      } else {
        const latestStart = raid.createdAt.getTime() + RAID_RULES.deployWindowSec * 1_000;
        if (wallNow.getTime() > latestStart) throw new HttpError(422, 'deploy window expired');
        startedAt = wallNow;
        battleEndsAt = new Date(wallNow.getTime() + raidDurationMs());
        armedAt = live.commandProtocolVersion === LIVE_RAID.protocolVersion ? wallNow : armedAt;
        if (live.commandProtocolVersion === LIVE_RAID.protocolVersion) {
          clockRevision += 1;
          clockRate = 1;
          clockAnchorWallAt = wallNow;
          clockAnchorSimMs = 0;
        }
        const removed = await breakBaseShieldOnAttack(
          tx, attackerWallet, raid.attackerBaseId!, { deferMapInvalidation: true },
        );
        shieldBroken = removed > 0;
        markRaidBaseChanged(tx, raid.defenderBaseId);
        await tx.update(baseRaidLocks).set({
          state: 'live', heartbeatAt: wallNow,
          expiresAt: new Date(battleEndsAt.getTime() + LIVE_RAID.recoveryGraceSec * 1_000),
        }).where(and(
          eq(baseRaidLocks.baseId, raid.defenderBaseId!),
          eq(baseRaidLocks.raidId, raidId),
        ));
      }
      }
    }
    if (startedAt && (!battleEndsAt || wallNow.getTime() >= battleEndsAt.getTime())) {
      throw new HttpError(422, 'battle clock has ended');
    }
    const sequence = live.lastSequence + 1;
    const clockState: LiveState = {
      ...live,
      lastSequence: sequence,
      armedAt,
      startedAt,
      battleEndsAt,
      clockRevision,
      clockRate,
      clockAnchorWallAt,
      clockAnchorSimMs,
      updatedAt: wallNow,
    };
    const receiptClock = canonicalClock(clockState, wallNow);
    const serverOffsetMs = live.commandProtocolVersion === LIVE_RAID.protocolVersion
      ? (batch && !clockState.startedAt ? 0 : receiptClock.simNowMs)
      : batch
        ? clientOffsetMs ?? 0
        : clockState.startedAt
          ? Math.max(0, wallNow.getTime() - clockState.startedAt.getTime())
          : 0;
    const [accepted] = await tx.insert(raidCommands).values({
      raidId,
      sequence,
      clientCommandId,
      kind: command.kind,
      payload: { ...command.payload, _clock: storedClock(receiptClock) },
      serverOffsetMs,
      payloadHash: hash,
      acceptedAt: wallNow,
    }).returning(acceptedLiveCommandColumns);
    if (command.kind === 'buff') {
      const cost = BigInt(BUFFS[command.payload.buff].costKeep);
      if (cost > 0n) {
        // D-152: charged in ONE currency by the sink shim, inside the command
        // transaction (the reason a per-sink wallet rail could never work here).
        try {
          await spendGameCurrency(
            tx, attackerWallet, cost, 'raid.buffs',
            `raid:${raidId}:live-buff:${command.payload.buff}`,
            { raidId, buff: command.payload.buff, live: true },
          );
        } catch (error) {
          if (error instanceof InsufficientFundsError) {
            throw new HttpError(422, `not enough KEEP for ${command.payload.buff}`, 'INSUFFICIENT_KEEP');
          }
          throw error;
        }
      }
    }
    await tx.update(raidLiveStates).set({
      lastSequence: sequence,
      armedAt,
      startedAt,
      battleEndsAt,
      clockRevision,
      clockRate,
      clockAnchorWallAt,
      clockAnchorSimMs,
      updatedAt: wallNow,
    }).where(eq(raidLiveStates.raidId, raidId));
    if (!batch) {
      await tx.update(baseRaidLocks).set({ heartbeatAt: wallNow }).where(and(
        eq(baseRaidLocks.baseId, raid.defenderBaseId!),
        eq(baseRaidLocks.raidId, raidId),
      ));
    }
    return {
      receipt: { command: toAcceptedLiveRaidCommand(accepted!), clock: receiptClock },
      shieldMapValleyId: shieldBroken
        ? await shieldMapValleyId(tx, attackerWallet, raid.attackerBaseId!)
        : null,
    };
  });
  invalidateShieldMapValley(committed.shieldMapValleyId);
  return committed.receipt;
}

/** Compatibility wrapper for internal callers that only need the accepted SIM
 * command. HTTP uses the receipt variant so every acknowledgement carries the
 * canonical server clock. */
export async function acceptLiveRaidCommand(
  db: Db,
  attackerWallet: string,
  raidId: string,
  clientCommandId: string,
  command: LiveRaidCommand,
  now?: Date,
): Promise<AcceptedLiveRaidCommand> {
  return (await acceptLiveRaidCommandReceipt(
    db, attackerWallet, raidId, clientCommandId, command, now,
  )).command;
}

/** CAS failures are safe client errors but uniquely need reconciliation state. */
export class RaidClockStaleError extends HttpError {
  constructor(readonly clock: CanonicalLiveRaidClock) {
    super(409, 'raid clock revision is stale', 'RAID_CLOCK_STALE');
  }
}

async function acceptControlCommand(
  db: Db,
  attackerWallet: string,
  raidId: string,
  clientCommandId: string,
  command: LiveRaidClockControlCommand,
  opts: { allowSpeedup?: boolean; now?: Date } = {},
): Promise<LiveRaidCommandReceipt> {
  if (!validClientCommandId(clientCommandId)) {
    throw new HttpError(400, 'invalid client command id');
  }
  if (!Number.isInteger(command.payload.expectedClockRevision)
    || command.payload.expectedClockRevision < 0) {
    throw new HttpError(400, 'invalid expected clock revision');
  }
  const hash = commandHash(command);
  const result = await raidEventTransaction(db, async (tx): Promise<
    | { ok: true; receipt: LiveRaidCommandReceipt }
    | { ok: false; clock: CanonicalLiveRaidClock }
  > => {
    // Match troop commands, creation, expiry and retreat: player first.
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, attackerWallet)).for('update');
    if (!player) throw new HttpError(404, 'live raid not found');
    const [raid] = await tx.select().from(raids).where(and(
      eq(raids.id, raidId), eq(raids.attackerWallet, attackerWallet),
    )).for('update');
    if (!raid) throw new HttpError(404, 'live raid not found');
    await assertCurrentRaidAttackerAuthority(tx, attackerWallet, raid);
    let [live] = await tx.select().from(raidLiveStates)
      .where(eq(raidLiveStates.raidId, raidId)).for('update');
    if (!live || live.commandProtocolVersion !== LIVE_RAID.protocolVersion) {
      throw new HttpError(409, 'raid clock controls require protocol v2', 'RAID_PROTOCOL_MISMATCH');
    }
    // Lost-response recovery must beat CAS, deadline and rollout gates. The
    // stored receipt is returned byte-for-byte even after later clock changes.
    const [duplicate] = await tx.select({
      ...acceptedLiveCommandColumns,
      payloadHash: raidCommands.payloadHash,
    }).from(raidCommands).where(and(
      eq(raidCommands.raidId, raidId),
      eq(raidCommands.clientCommandId, clientCommandId),
    ));
    if (duplicate) {
      if (duplicate.payloadHash !== hash) {
        throw new HttpError(
          409, 'client command id is bound to different input', 'RAID_COMMAND_MISMATCH',
        );
      }
      return { ok: true, receipt: {
        command: toAcceptedLiveRaidCommand(duplicate),
        clock: restoredClock((duplicate.payload as StoredPayload)._clock)
          ?? canonicalClock(live, duplicate.acceptedAt),
      } };
    }
    assertCurrentRaidInputVersion(raid.simVersion);
    if (raid.status !== 'pending_orders') throw new HttpError(422, 'raid already resolved');
    const wallNow = await raidTransactionWallNow(tx, opts.now);
    live = await autoStartLocked(tx, raid, live, wallNow);
    const before = canonicalClock(live, wallNow);
    if (command.payload.expectedClockRevision !== live.clockRevision) {
      // Do not throw inside this transaction: autoStartLocked may just have
      // committed the fixed-cutoff start row. Rolling it back while returning
      // its clock would advertise a phantom revision to the client.
      return { ok: false, clock: before };
    }
    if (live.streamClosedAt) throw new HttpError(422, 'raid command stream is closed');
    if (before.simNowMs >= before.durationMs) {
      throw new HttpError(422, 'battle clock has ended');
    }
    if (live.lastSequence + 1 >= LIVE_RAID.maxCommands) {
      throw new HttpError(422, 'raid command limit reached', 'RAID_COMMAND_LIMIT');
    }

    let next: LiveState = { ...live };
    let changed = false;
    if (command.kind === 'start') {
      if (!live.armedAt) throw new HttpError(422, 'deploy a unit before starting the raid');
      if (!live.startedAt) {
        changed = true;
        next = {
          ...next,
          clockRevision: live.clockRevision + 1,
          clockRate: 1,
          clockAnchorWallAt: wallNow,
          clockAnchorSimMs: 0,
          startedAt: wallNow,
          battleEndsAt: new Date(wallNow.getTime() + raidDurationMs()),
        };
      }
    } else if (command.kind === 'speed') {
      if (!live.startedAt) throw new HttpError(422, 'raid has not started');
      const requestedRate = command.payload.rate;
      if (!LIVE_RAID.clockRates.includes(requestedRate)) {
        throw new HttpError(400, 'raid speed must be 1 or 2');
      }
      const currentRate = live.clockRate as LiveRaidClockRate;
      if (requestedRate !== currentRate) {
        if (currentRate === 1 && requestedRate === 2 && opts.allowSpeedup !== true) {
          throw new HttpError(503, 'live raid v2 speed-up is disabled', 'LIVE_RAID_V2_DISABLED');
        }
        const [changes] = await tx.select({ n: sql<number>`count(*)::int` })
          .from(raidCommands).where(and(
            eq(raidCommands.raidId, raidId),
            eq(raidCommands.kind, 'speed'),
            sql`${raidCommands.payload}->>'_changed' = 'true'`,
          ));
        if ((changes?.n ?? 0) >= LIVE_RAID.speedChangeLimit) {
          throw new HttpError(422, 'raid speed change limit reached', 'RAID_SPEED_LIMIT');
        }
        changed = true;
        const remaining = before.durationMs - before.simNowMs;
        next = {
          ...next,
          clockRevision: live.clockRevision + 1,
          clockRate: requestedRate,
          clockAnchorWallAt: wallNow,
          clockAnchorSimMs: before.simNowMs,
          battleEndsAt: new Date(wallNow.getTime() + Math.ceil(remaining / requestedRate)),
        };
      }
    }

    const sequence = next.lastSequence + 1;
    next = { ...next, lastSequence: sequence, updatedAt: wallNow };
    const receiptClock = canonicalClock(next, wallNow);
    const [accepted] = await tx.insert(raidCommands).values({
      raidId,
      sequence,
      clientCommandId,
      kind: command.kind,
      payload: { ...command.payload, _changed: changed, _clock: storedClock(receiptClock) },
      serverOffsetMs: receiptClock.simNowMs,
      payloadHash: hash,
      acceptedAt: wallNow,
    }).returning(acceptedLiveCommandColumns);
    await tx.update(raidLiveStates).set({
      lastSequence: next.lastSequence,
      clockRevision: next.clockRevision,
      clockRate: next.clockRate,
      clockAnchorWallAt: next.clockAnchorWallAt,
      clockAnchorSimMs: next.clockAnchorSimMs,
      startedAt: next.startedAt,
      battleEndsAt: next.battleEndsAt,
      updatedAt: wallNow,
    }).where(eq(raidLiveStates.raidId, raidId));
    if (changed && raid.defenderBaseId) {
      markRaidBaseChanged(tx, raid.defenderBaseId);
      await tx.update(baseRaidLocks).set({
        state: 'live', heartbeatAt: wallNow,
        expiresAt: new Date(receiptClock.battleEndsAt!.getTime()
          + LIVE_RAID.recoveryGraceSec * 1_000),
      }).where(and(
        eq(baseRaidLocks.baseId, raid.defenderBaseId),
        eq(baseRaidLocks.raidId, raidId),
      ));
    }
    return {
      ok: true,
      receipt: { command: toAcceptedLiveRaidCommand(accepted!), clock: receiptClock },
    };
  });
  if (!result.ok) throw new RaidClockStaleError(result.clock);
  return result.receipt;
}

export function startLiveRaid(
  db: Db,
  attackerWallet: string,
  raidId: string,
  clientCommandId: string,
  expectedClockRevision: number,
  now?: Date,
): Promise<LiveRaidCommandReceipt> {
  return acceptControlCommand(db, attackerWallet, raidId, clientCommandId, {
    kind: 'start', payload: { expectedClockRevision },
  }, { ...(now ? { now } : {}) });
}

export function setLiveRaidSpeed(
  db: Db,
  attackerWallet: string,
  raidId: string,
  clientCommandId: string,
  expectedClockRevision: number,
  rate: LiveRaidClockRate,
  allowSpeedup = false,
  now?: Date,
): Promise<LiveRaidCommandReceipt> {
  return acceptControlCommand(db, attackerWallet, raidId, clientCommandId, {
    kind: 'speed', payload: { expectedClockRevision, rate },
  }, { allowSpeedup, ...(now ? { now } : {}) });
}

/** Reverse only committed buff ledger receipts for a raid that never staged a
 * troop or hero. Values come from the immutable double-entry receipt rather
 * than today's mutable constants, and the refund key makes every terminal
 * recovery path safely retryable. */
export async function refundUnstartedLiveBuffs(
  db: DbOrTx, raidId: string, attackerWallet: string,
): Promise<number> {
  const commands = await db.select({
    kind: raidCommands.kind,
    payload: raidCommands.payload,
  }).from(raidCommands).where(eq(raidCommands.raidId, raidId));
  if (commands.some((command) => command.kind === 'deploy' || command.kind === 'hero')) return 0;
  const buffs = [...new Set(commands.filter((command) => command.kind === 'buff').map((command) => (
    (command.payload as { buff?: string }).buff
  )).filter((buff): buff is string => !!buff))];
  let refunded = 0;
  for (const buff of buffs) {
    const originalKey = `raid:${raidId}:live-buff:${buff}`;
    const [charged] = await db.select({
      id: ledgerTransactions.id,
      type: ledgerTransactions.type,
    }).from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, originalKey));
    if (!charged) continue;
    if (charged.type !== 'raid.buffs') {
      throw new Error(`live buff refund invariant: unexpected transaction ${originalKey}`);
    }
    const entries = await db.select({
      accountId: ledgerEntries.accountId,
      delta: ledgerEntries.delta,
      kind: accounts.kind,
      ownerWallet: accounts.ownerWallet,
    }).from(ledgerEntries)
      .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
      .where(eq(ledgerEntries.txnId, charged.id));
    // D-152: the charge was either the legacy KEEP leg (player_keep →
    // emission_pool) or Gems (player_gems → gems_sink). The refund mirrors
    // whichever the receipt shows — reading the currency from the immutable
    // evidence, never from today's flag — and stays bounded by that debit
    // (invariant G-1's allow-listed refund shape; gems_sink is non-negative).
    const playerDebit = entries.find((entry) => (entry.kind === 'player_keep' || entry.kind === 'player_gems')
      && entry.ownerWallet === attackerWallet && entry.delta < 0n);
    const sinkCredit = entries.find((entry) => entry.delta > 0n
      && entry.kind === (playerDebit?.kind === 'player_gems' ? 'gems_sink' : 'emission_pool'));
    if (entries.length !== 2 || !playerDebit || !sinkCredit
      || -playerDebit.delta !== sinkCredit.delta) {
      throw new Error(`live buff refund invariant: malformed receipt ${originalKey}`);
    }
    await refundPostedSpend(db, { entries }, `raid:${raidId}:live-buff-refund:${buff}`, 'raid.buffs.system_refund', {
      raidId, wallet: attackerWallet, buff, originalKey, refundOf: charged.id,
      currency: playerDebit.kind === 'player_gems' ? 'GEMS' : 'KEEP',
    });
    refunded += 1;
  }
  return refunded;
}

const PRESTART_RETREAT_RESULT = {
  stars: 0 as const,
  destructionPct: 0,
  keepDestroyed: false,
  lootShards: 0,
  attackerTrophyDelta: 0,
  defenderTrophyDelta: 0,
  retreated: true as const,
};

export interface RaidRetreatReceipt extends LiveRaidCommandReceipt {
  retreated: true;
  terminal: boolean;
  result?: typeof PRESTART_RETREAT_RESULT;
  orders?: ClosedLiveRaidOrders;
}

/** Explicit authoritative retreat for protocol V2. This is intentionally a
 * `/finish` mode, not another lifecycle endpoint: the raid becomes terminal,
 * energy, deployed troops, and buffs attached to a staged army remain spent;
 * a buff-only abandoned reservation is refunded. It works before or after
 * ATTACK so Android Back never has to fake a successful local exit while a
 * canonical raid remains active. */
export async function retreatLiveRaid(
  db: Db,
  attackerWallet: string,
  raidId: string,
  clientCommandId: string,
  now?: Date,
): Promise<RaidRetreatReceipt> {
  if (!validClientCommandId(clientCommandId)) {
    throw new HttpError(400, 'invalid client command id');
  }
  const command: LiveRaidControlCommand = { kind: 'retreat', payload: {} };
  const hash = commandHash(command);
  return raidEventTransaction(db, async (tx) => {
    // Canonical settlement order begins with the participant row. Acquiring it
    // before raid/base/live/army prevents retreat from introducing an inverse
    // edge against submitOrders or stale-expiry compensation.
    const [attacker] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, attackerWallet)).for('update');
    if (!attacker) throw new HttpError(404, 'raid not found');
    const [raid] = await tx.select().from(raids).where(and(
      eq(raids.id, raidId), eq(raids.attackerWallet, attackerWallet),
    )).for('update');
    if (!raid) throw new HttpError(404, 'raid not found');
    await assertCurrentRaidAttackerAuthority(tx, attackerWallet, raid);
    const [storedLive] = await tx.select().from(raidLiveStates)
      .where(eq(raidLiveStates.raidId, raidId)).for('update');
    if (!storedLive || storedLive.commandProtocolVersion !== LIVE_RAID.protocolVersion) {
      throw new HttpError(409, 'authoritative retreat requires raid protocol v2', 'RAID_PROTOCOL_MISMATCH');
    }
    let live = storedLive;
    const [duplicate] = await tx.select({
      ...acceptedLiveCommandColumns,
      payloadHash: raidCommands.payloadHash,
    }).from(raidCommands).where(and(
      eq(raidCommands.raidId, raidId),
      eq(raidCommands.clientCommandId, clientCommandId),
    ));
    if (duplicate) {
      if (duplicate.payloadHash !== hash) {
        throw new HttpError(
          409, 'client command id is bound to different input', 'RAID_COMMAND_MISMATCH',
        );
      }
      const duplicateReceipt: RaidRetreatReceipt = {
        retreated: true,
        terminal: raid.status === 'resolved',
        command: toAcceptedLiveRaidCommand(duplicate),
        clock: restoredClock((duplicate.payload as StoredPayload)._clock)
          ?? canonicalClock(live, duplicate.acceptedAt),
      };
      if (raid.status === 'resolved') {
        duplicateReceipt.result = (raid.result ?? PRESTART_RETREAT_RESULT) as typeof PRESTART_RETREAT_RESULT;
      } else {
        const rows = await tx.select().from(raidCommands)
          .where(eq(raidCommands.raidId, raidId)).orderBy(asc(raidCommands.sequence));
        duplicateReceipt.orders = commandRowsToOrders(rows, raidId);
      }
      return duplicateReceipt;
    }
    assertCurrentRaidInputVersion(raid.simVersion);
    if (raid.status !== 'pending_orders') throw new HttpError(422, 'raid already resolved');
    if (live.streamClosedAt) {
      throw new HttpError(
        409,
        'raid stream already closed for settlement',
        'RAID_STREAM_CLOSED',
      );
    }
    const wallNow = await raidTransactionWallNow(tx, now);
    // A delayed worker/read must not let Back retreat through the pre-start
    // shortcut after the immutable batch cutoff. Persist the automatic start
    // under the same locks first, then use the canonical started settlement.
    live = await autoStartLocked(tx, raid, live, wallNow);
    if (live.startedAt && canonicalClock(live, wallNow).simNowMs >= raidDurationMs()) {
      throw new HttpError(422, 'battle clock has ended', 'RAID_CLOCK_ENDED');
    }
    const rows = await tx.select().from(raidCommands)
      .where(eq(raidCommands.raidId, raidId)).orderBy(asc(raidCommands.sequence));
    const orders = commandRowsToOrders(rows, raidId);
    orders.retreated = true;
    const sequence = live.lastSequence + 1;
    const terminalLive: LiveState = {
      ...live, lastSequence: sequence, streamClosedAt: wallNow, updatedAt: wallNow,
    };
    const receiptClock = canonicalClock(terminalLive, wallNow);
    const [accepted] = await tx.insert(raidCommands).values({
      raidId,
      sequence,
      clientCommandId,
      kind: command.kind,
      payload: { _clock: storedClock(receiptClock) },
      serverOffsetMs: 0,
      payloadHash: hash,
      acceptedAt: wallNow,
    }).returning(acceptedLiveCommandColumns);
    await tx.update(raidLiveStates).set({
      lastSequence: sequence,
      streamClosedAt: wallNow,
      updatedAt: wallNow,
    }).where(eq(raidLiveStates.raidId, raidId));
    // A started retreat is durably marked and closed here, then settles through
    // submitOrders' canonical path, scored at this accepted retreat tick
    // (destruction so far, 2026-09-17 — never a zero placeholder), so PvP
    // trophies/history/defender progress cannot be dodged. A crash between the
    // two phases is recovered by the worker from the append-only retreat row.
    if (live.startedAt) {
      return {
        retreated: true,
        terminal: false,
        orders,
        command: toAcceptedLiveRaidCommand(accepted!),
        clock: receiptClock,
      };
    }
    const usedCounts = Object.fromEntries(
      TROOP_TYPES.map((troop) => [troop, 0]),
    ) as Record<TroopType, number>;
    for (const deployed of orders.deploys) usedCounts[deployed.troop] += 1;
    await refundUnstartedLiveBuffs(tx, raidId, attackerWallet);
    await consumeArmy(tx, attackerWallet, usedCounts, raid.attackerBaseId ?? undefined);
    // A staged batch is an accepted attack even before ATTACK is pressed. Its
    // exact retreat record must remain readable through deed/participant history.
    // Live PvP starts on its first deploy, so a pre-start retreat has no defender
    // battle to record. Empty visits remain excluded (D-105).
    if (raid.attackerBaseId && (orders.deploys.length > 0 || orders.heroDeploys.length > 0)) {
      await recordBaseBattle(tx, {
        raidId, attackerBaseId: raid.attackerBaseId, attackerOwnerWallet: attackerWallet,
        stars: 0, destructionPct: 0, lootShards: 0n, createdAt: wallNow,
      });
    }
    // Nothing was simulated before ATTACK. Archive that fact with the original
    // inputs/version, never a fabricated fight or placeholder building HP.
    await persistReplayTimeline(tx, raidId, {
      snapshot: raid.snapshot,
      ...(raid.visualContext ? { visualContext: raid.visualContext } : {}),
      ...await boundCosmeticRaidFields(tx, raid.id),
      ...await raidStarterFields(tx,raid.id,raid.snapshot),
      ...await raidAdvancedFields(tx,raid.id,raid.snapshot),
      armySnapshot: raid.armySnapshot,
      orders, seed: Number(raid.seed), simVersion: raid.simVersion,
      events: [], result: PRESTART_RETREAT_RESULT,
    }, 0);
    await tx.update(raids).set({
      status: 'resolved',
      orders,
      result: PRESTART_RETREAT_RESULT,
      events: [],
      simulationLeaseToken: null,
      simulationLeaseUntil: null,
      simulationSystemAttemptedAt: null,
      resolvedAt: wallNow,
    }).where(and(eq(raids.id, raidId), eq(raids.status, 'pending_orders')));
    await releaseRaidHeroes(tx, [raidId]);
    const releasedLoot = await releaseDeedRaidLoot(tx, raidId, wallNow);
    if (!releasedLoot) {
      await tx.delete(baseRaidLocks).where(eq(baseRaidLocks.raidId, raidId));
      markRaidBaseChanged(tx, raid.defenderBaseId);
    }
    return {
      retreated: true,
      terminal: true,
      result: PRESTART_RETREAT_RESULT,
      command: toAcceptedLiveRaidCommand(accepted!),
      clock: receiptClock,
    };
  });
}

/** Compatibility alias for callers introduced during the first M34 pass. */
export const retreatUnstartedLiveRaid = retreatLiveRaid;

async function requireLiveParticipant(
  db: DbOrTx,
  wallet: string,
  raid: { attackerWallet: string; defenderBaseId: string | null },
) {
  if (raid.attackerWallet === wallet) return;
  if (!raid.defenderBaseId) throw new HttpError(404, 'raid not found');
  const [defender] = await db.select({ owner: bases.ownerWallet }).from(bases)
    .where(and(eq(bases.id, raid.defenderBaseId), eq(bases.ownerWallet, wallet)))
    .for('update');
  if (!defender) throw new HttpError(404, 'raid not found');
}

export async function getLiveRaidCommands(
  db: Db,
  wallet: string,
  raidId: string,
  afterSequence = -1,
  now?: Date,
  options: { observeOnly?: boolean } = {},
) {
  return db.transaction(async (tx) => {
    // A defender read revalidates ownership under its base lock below. Match
    // create/transfer's participant mutex before acquiring raid/live locks.
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'live raid not found');
    const [raid] = await tx.select().from(raids).where(eq(raids.id, raidId)).for('update');
    if (!raid) throw new HttpError(404, 'live raid not found');
    let [live] = await tx.select().from(raidLiveStates)
      .where(eq(raidLiveStates.raidId, raidId)).for('update');
    if (!live) throw new HttpError(404, 'live raid not found');
    // Participant authority is revalidated inside the same locked snapshot as
    // the private army/snapshot read, closing the deed-transfer TOCTOU window.
    await requireLiveParticipant(tx, wallet, raid);
    const wallNow = await raidTransactionWallNow(tx, now);
    // Native presentation observes persisted state without becoming another
    // writer during an ordinary web deployment's drain/backup window. The
    // existing web read/command and worker paths retain automatic-start ownership.
    if (!options.observeOnly) live = await autoStartLocked(tx, raid, live, wallNow);
    const commandRows = await tx.select(acceptedLiveCommandColumns).from(raidCommands).where(and(
      eq(raidCommands.raidId, raidId), gt(raidCommands.sequence, afterSequence),
    )).orderBy(asc(raidCommands.sequence)).limit(LIVE_RAID.reconnectPageSize);
    const commands = commandRows.map(toAcceptedLiveRaidCommand);
    return {
      protocolVersion: live.commandProtocolVersion,
      clock: canonicalClock(live, wallNow),
      startedAt: live.startedAt,
      battleEndsAt: live.battleEndsAt,
      streamClosedAt: live.streamClosedAt,
      lastSequence: live.lastSequence,
      snapshot: raid.snapshot,
      visualContext: resolveBaseVisualContext(raid.visualContext),
      ...await boundCosmeticRaidFields(tx, raid.id),
      ...await raidStarterFields(tx,raid.id,raid.snapshot),
      ...await raidAdvancedFields(tx,raid.id,raid.snapshot),
      armySnapshot: raid.armySnapshot,
      seed: Number(raid.seed),
      simVersion: raid.simVersion,
      status: raid.status,
      commands,
      hasMore: commands.length === LIVE_RAID.reconnectPageSize
        && commands.at(-1)!.sequence < live.lastSequence,
    };
  });
}

/** Current attacker reconciliation state without downloading the command page. */
export async function getRaidClock(
  db: Db,
  raidId: string,
  now?: Date,
): Promise<{ live: LiveState; clock: CanonicalLiveRaidClock }> {
  return db.transaction(async (tx) => {
    const [raid] = await tx.select().from(raids).where(eq(raids.id, raidId)).for('update');
    if (!raid) throw new HttpError(404, 'raid not found');
    let [live] = await tx.select().from(raidLiveStates)
      .where(eq(raidLiveStates.raidId, raidId)).for('update');
    if (!live) throw new HttpError(404, 'live raid not found');
    const wallNow = await raidTransactionWallNow(tx, now);
    live = await autoStartLocked(tx, raid, live, wallNow);
    return { live, clock: canonicalClock(live, wallNow) };
  });
}

/** Worker/lazy-read backstop for a V2 batch whose player armed the army but
 * never delivered ATTACK. The anchor is the fixed 30-second cutoff, not the
 * delayed worker observation time. */
export async function autoStartDueLiveRaids(
  db: Db,
  now?: Date,
  raidId?: string,
  defenderBaseId?: string,
): Promise<{ started: number; raced: number }> {
  const scanNow = now ?? await raidDatabaseWallNow(db);
  const cutoffCreatedAt = new Date(scanNow.getTime() - RAID_RULES.deployWindowSec * 1_000);
  const candidates = await db.select({ raidId: raids.id }).from(raidLiveStates)
    .innerJoin(raids, eq(raids.id, raidLiveStates.raidId)).where(and(
      eq(raids.status, 'pending_orders'),
      eq(raidLiveStates.commandProtocolVersion, LIVE_RAID.protocolVersion),
      isNotNull(raidLiveStates.armedAt),
      isNull(raidLiveStates.startedAt),
      isNull(raidLiveStates.streamClosedAt),
      lte(raids.createdAt, cutoffCreatedAt),
      ...(raidId ? [eq(raids.id, raidId)] : []),
      ...(defenderBaseId ? [eq(raids.defenderBaseId, defenderBaseId)] : []),
    )).orderBy(asc(raids.createdAt)).limit(LIVE_RAID.recoveryBatchSize);
  let started = 0;
  let raced = 0;
  for (const candidate of candidates) {
    try {
      const didStart = await db.transaction(async (tx) => {
        const [raid] = await tx.select().from(raids)
          .where(eq(raids.id, candidate.raidId)).for('update');
        if (!raid || raid.status !== 'pending_orders') return false;
        const [live] = await tx.select().from(raidLiveStates)
          .where(eq(raidLiveStates.raidId, candidate.raidId)).for('update');
        if (!live || live.startedAt || !live.armedAt) return false;
        const wallNow = await raidTransactionWallNow(tx, now);
        const next = await autoStartLocked(tx, raid, live, wallNow);
        return next.startedAt !== null;
      });
      if (didStart) started += 1;
      else raced += 1;
    } catch (error) {
      // A pre-rollout row poisoned with the formerly user-claimable system ID
      // must not prevent later candidates from recovering. Other failures stay
      // loud because silently skipping an unknown worker fault is unsafe.
      if (!isUniqueViolation(error)) throw error;
      raced += 1;
    }
  }
  return { started, raced };
}

export interface ClosedLiveRaidOrders {
  deploys: Array<{ troop: TroopType; tx: number; ty: number; tMs: number }>;
  heroDeploys: Array<{ hero: HeroKey; tx: number; ty: number; tMs: number }>;
  buffs?: { warhorn?: boolean; swiftboots?: boolean; powdercharge?: boolean };
  rally?: { tx: number; ty: number; tMs: number };
  /** Internal-only terminal control; never accepted from a public orders body. */
  retreated?: true;
  idempotencyKey: string;
}

function commandRowsToOrders(
  rows: ReadonlyArray<typeof raidCommands.$inferSelect>,
  raidId: string,
): ClosedLiveRaidOrders {
  const orders: ClosedLiveRaidOrders = {
    deploys: [], heroDeploys: [], idempotencyKey: `live-finish:${raidId}`,
  };
  for (const row of rows) {
    if (row.kind === 'deploy') {
      const payload = publicPayload(row.payload) as { troop: TroopType; tx: number; ty: number };
      orders.deploys.push({ ...payload, tMs: row.serverOffsetMs });
    } else if (row.kind === 'hero') {
      const payload = publicPayload(row.payload) as { hero: HeroKey; tx: number; ty: number };
      orders.heroDeploys.push({ ...payload, tMs: row.serverOffsetMs });
    } else if (row.kind === 'rally') {
      const payload = publicPayload(row.payload) as { tx: number; ty: number };
      orders.rally = { ...payload, tMs: row.serverOffsetMs };
    } else if (row.kind === 'buff') {
      const { buff } = publicPayload(row.payload) as {
        buff: 'warhorn' | 'swiftboots' | 'powdercharge';
      };
      orders.buffs = { ...orders.buffs, [buff]: true };
    } else if (row.kind === 'retreat') {
      orders.retreated = true;
    }
  }
  return orders;
}

/** Same CPU admission bound for terminal settlement and an early proof. */
export function raidSimulationActorBound(snapshot: BaseSnapshot, orders: {
  deploys: ReadonlyArray<{ troop: TroopType }>; heroDeploys?: ReadonlyArray<unknown>;
}): number {
  const brood = TROOP_ABILITIES.hexbarrow.brood;
  const lastTick = MAX_TICKS - 1;
  const ticksPerSec = MAX_TICKS / RAID_RULES.battleDurationSec;
  const cohorts = 1 + Math.floor((lastTick - brood.firstDelaySec * ticksPerSec)
    / (brood.intervalSec * ticksPerSec));
  const broodPerCohort = brood.spawnCounts.reduce((sum, count) => sum + count, 0);
  const nestActors = snapshot.buildings.filter((building) => building.type === 'dragonnest').length
    * Math.floor(lastTick / (DEFENSES.dragonnest.spawnIntervalSec * ticksPerSec));
  return orders.deploys.length + (orders.heroDeploys?.length ?? 0)
    + (snapshot.defenderHeroes?.length ?? 0) + nestActors
    + orders.deploys.filter((order) => order.troop === 'hexbarrow').length * cohorts * broodPerCohort;
}

/** Caller owns player→raid locks/transaction. False never queues CPU work. */
export async function admitHeavyRaidSimulation(tx: DbOrTx, wallet: string): Promise<boolean> {
  const [admitted] = await tx.update(players).set({ raidSimulationAdmittedAt: sql`NOW()` })
    .where(and(eq(players.wallet, wallet), or(isNull(players.raidSimulationAdmittedAt),
      lt(players.raidSimulationAdmittedAt,
        sql`NOW() - (${RAID_REPLAY_LIMITS.simulationWalletCooldownSec} * INTERVAL '1 second')`))))
    .returning({ wallet: players.wallet });
  return !!admitted;
}

// Only the exact in-process orders object returned by a successful locked
// close can carry this proof. Public JSON, a retry or another process cannot
// manufacture it. Normal settlement still runs every authorization and lease
// check; it reuses this identical input's outcome instead of buying CPU twice.
const earlyOutcomes = new WeakMap<object, { raidId: string; input: string; outcome: RaidOutcome }>();
export function takeEarlyLiveRaidOutcome(
  orders: object, raidId: string, input: RaidSimulationWorkerInput,
): RaidOutcome | null {
  const proof = earlyOutcomes.get(orders);
  earlyOutcomes.delete(orders);
  return proof?.raidId === raidId && proof.input === canonicalJson(input) ? proof.outcome : null;
}

/** A completed prediction is not proof that combat has happened yet. Compare
 * its final tick with the locked server clock; only an actually destroyed base
 * can close early. Wipes, empty targets and future victories keep accepting input.
 * Reuse the bounded, fail-fast worker so FINISH cannot run SIM on the API thread.
 */
async function fullDestructionAlreadyReached(
  tx: DbOrTx, raid: typeof raids.$inferSelect, orders: ClosedLiveRaidOrders, simNowMs: number,
): Promise<boolean> {
  if (raid.simVersion !== SIM_VERSION || simNowMs <= 0) return false;
  const snapshot = raid.snapshot as BaseSnapshot;
  if (!snapshot.buildings.some((building) => building.type !== 'wall'
    && !(TRAP_TYPES as readonly string[]).includes(building.type))) return false;
  const army = raid.armySnapshot as {
    levels: Partial<Record<TroopType, number>>;
    heroLevels?: Record<string, number>;
    heroLoadouts?: Partial<Record<HeroKey, HeroCombatLoadout>>;
  };
  let permit: ReturnType<typeof claimRaidSimulationPermit>;
  try { permit = claimRaidSimulationPermit(); }
  catch (error) {
    if (error instanceof RaidSimulationBusyError) {
      throw new HttpError(503, error.message, 'RAID_SIMULATION_BUSY');
    }
    throw error;
  }
  try {
    if (raidSimulationActorBound(snapshot, orders) > RAID_REPLAY_LIMITS.heavySimulationAboveActors
      && !await admitHeavyRaidSimulation(tx, raid.attackerWallet)) {
      throw new HttpError(429, 'raid simulator cooldown; retry shortly', 'RAID_SIMULATION_COOLDOWN');
    }
    const heroDeploys = orders.heroDeploys.map((hero) => ({ ...hero,
      level: army.heroLevels?.[hero.hero] ?? 1,
      ...(army.heroLoadouts?.[hero.hero] ? { loadout: army.heroLoadouts[hero.hero] } : {}),
    }));
    const input: RaidSimulationWorkerInput = {
      snapshot, seed: Number(raid.seed), options: { troopLevels: army.levels },
      orders: {
        deploys: orders.deploys,
        ...(heroDeploys.length ? { heroDeploys } : {}),
        ...(orders.buffs ? { buffs: orders.buffs } : {}),
        ...(orders.rally ? { rally: orders.rally } : {}),
      },
    };
    const outcome = await permit.run(input);
    const reached = outcome.destructionPct === 100
      && outcome.ticks * (raidDurationMs() / MAX_TICKS) <= simNowMs;
    if (reached) earlyOutcomes.set(orders, { raidId: raid.id, input: canonicalJson(input), outcome });
    return reached;
  } finally { await permit.release(); }
}

/** Close is retry-safe. Resolution remains in raids.submitOrders. */
export async function closeLiveRaidStream(
  db: Db,
  attackerWallet: string,
  raidId: string,
  now?: Date,
  systemRecovery = false,
): Promise<ClosedLiveRaidOrders> {
  const closed = await db.transaction(async (tx) => {
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, attackerWallet)).for('update');
    if (!player) throw new HttpError(404, 'raid not found');
    const [raid] = await tx.select().from(raids).where(and(
      eq(raids.id, raidId), eq(raids.attackerWallet, attackerWallet),
    )).for('update');
    if (!raid) throw new HttpError(404, 'raid not found');
    if (!systemRecovery) await assertCurrentRaidAttackerAuthority(tx, attackerWallet, raid);
    const [live] = await tx.select().from(raidLiveStates)
      .where(eq(raidLiveStates.raidId, raidId)).for('update');
    if (!live?.startedAt) throw new HttpError(422, 'raid has not started');
    const settledAt = await raidTransactionWallNow(tx, now);
    // A due-list read can race a speed change. Recompute the V2 simulator clock
    // only after both canonical rows are locked; stale wall deadlines never win.
    const rows = await tx.select().from(raidCommands)
      .where(eq(raidCommands.raidId, raidId)).orderBy(asc(raidCommands.sequence));
    const orders = commandRowsToOrders(rows, raidId);
    const simNowMs = canonicalClock(live, settledAt).simNowMs;
    if (!live.streamClosedAt && live.commandProtocolVersion === LIVE_RAID.protocolVersion
      && simNowMs < raidDurationMs() && orders.retreated !== true) {
      try {
        if (!await fullDestructionAlreadyReached(tx, raid, orders, simNowMs)) {
          return { error: new HttpError(409, 'raid clock is not due', 'RAID_CLOCK_NOT_DUE') };
        }
      } catch (error) {
        // Commit CPU admission even on a failed proof. Throwing inside this
        // transaction would roll back the durable cooldown and permit spam.
        return { error };
      }
    }
    if (!live.streamClosedAt) {
      await tx.update(raidLiveStates).set({ streamClosedAt: settledAt, updatedAt: settledAt })
        .where(eq(raidLiveStates.raidId, raidId));
    }
    return { orders };
  });
  if ('error' in closed) throw closed.error;
  return closed.orders;
}
