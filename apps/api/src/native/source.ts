import { createHash } from 'node:crypto';
import { LIVE_RAID, type BaseSnapshot, type HeroCombatLoadout, type HeroKey } from '@shardkeep/shared';
import { SIM_VERSION, type RaidOrders, type SimEvent, type SimOptions } from '@shardkeep/sim';
import type { Db } from '../db/client';
import { multiBaseEnabled } from '../config';
import { getLiveRaidCommands, type AcceptedLiveRaidCommand, type LiveRaidCommand } from '../game/liveRaids';
import { getParticipantBattleReplay } from '../game/baseBattleHistory';
import { getReplay } from '../game/raids';
import { HttpError } from '../lib/errors';
import type { NativeSimulationInput } from './simulation';
import { NATIVE_PRESENTATION_PROTOCOL, NativeArchivedHeroOrdersSchema } from './contracts';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface FrozenArmy {
  levels?: SimOptions['troopLevels'];
  heroLevels?: Record<string, number>;
  heroLoadouts?: Partial<Record<HeroKey, HeroCombatLoadout>>;
}

/** Validate the bounded projection without mutating or truncating its archive.
 * An unknown order must fail visibly, never silently produce incorrect HP. */
export function nativeArchivedHeroOrders(orders: unknown) {
  if (orders === undefined || orders === null) return undefined;
  if (typeof orders !== 'object' || Array.isArray(orders)) {
    throw new HttpError(409, 'archived hero orders are invalid', 'NATIVE_ARCHIVE_ORDERS_INVALID');
  }
  if (!('heroDeploys' in orders)) return undefined;
  const parsed = NativeArchivedHeroOrdersSchema.safeParse({ heroDeploys: orders.heroDeploys });
  if (!parsed.success) throw new HttpError(409, 'archived hero orders are invalid', 'NATIVE_ARCHIVE_ORDERS_INVALID');
  return parsed.data;
}

/** Same contiguous accepted prefix and frozen gear as web hydrateLiveOrders.
 * Control commands acknowledge intent but never become simulator orders. */
export function nativeOrders(commands: readonly AcceptedLiveRaidCommand[], army: FrozenArmy): RaidOrders {
  const result: RaidOrders = { deploys: [], heroDeploys: [] };
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i]!;
    if (command.sequence !== i) throw new HttpError(409, 'raid journal is incomplete', 'NATIVE_JOURNAL_INCOMPLETE');
    switch (command.kind) {
      case 'deploy': {
        const payload = command.payload as Extract<LiveRaidCommand, { kind: 'deploy' }>['payload'];
        result.deploys.push({ ...payload, tMs: command.serverOffsetMs }); break;
      }
      case 'hero': {
        const payload = command.payload as Extract<LiveRaidCommand, { kind: 'hero' }>['payload'];
        const loadout = army.heroLoadouts?.[payload.hero];
        result.heroDeploys!.push({ ...payload, tMs: command.serverOffsetMs,
          level: army.heroLevels?.[payload.hero] ?? 1, ...(loadout ? { loadout } : {}) }); break;
      }
      case 'rally': {
        const payload = command.payload as Extract<LiveRaidCommand, { kind: 'rally' }>['payload'];
        result.rally = { ...payload, tMs: command.serverOffsetMs }; break;
      }
      case 'buff': {
        const payload = command.payload as Extract<LiveRaidCommand, { kind: 'buff' }>['payload'];
        result.buffs = { ...result.buffs, [payload.buff]: true }; break;
      }
    }
  }
  return result;
}

export async function loadNativePresentation(db: Db, wallet: string, raidId: string) {
  let view: Awaited<ReturnType<typeof getLiveRaidCommands>> | null = null;
  try { view = await getLiveRaidCommands(db, wallet, raidId, -1, undefined, { observeOnly: true }); }
  catch (error) {
    if (!(error instanceof HttpError) || error.statusCode !== 404) throw error;
  }
  if (view) {
    const commands = [...view.commands];
    // Revalidate participant authority on every page, including a pre-start
    // retreat whose receipt can follow a full staged army's accepted orders.
    while (view.hasMore) {
      if (commands.length >= LIVE_RAID.maxCommands) {
        throw new HttpError(503, 'raid journal exceeds native capacity', 'NATIVE_PRESENTATION_CAPACITY');
      }
      view = await getLiveRaidCommands(db, wallet, raidId, commands.at(-1)!.sequence, undefined, { observeOnly: true });
      commands.push(...view.commands);
    }
    if (commands.length !== view.lastSequence + 1 || commands.length > LIVE_RAID.maxCommands) {
      throw new HttpError(409, 'raid journal is incomplete', 'NATIVE_JOURNAL_INCOMPLETE');
    }
    view = { ...view, commands };
  }
  if (view?.status === 'resolved' && view.startedAt === null
    && view.commands.some((command) => command.kind === 'retreat')) {
    // Pre-start retreat is a persisted terminal receipt, not a battle archive:
    // the canonical service intentionally creates no battle record/timeline.
    // This narrow fallback requires both the live guard above and immutable
    // participant authorization; it never grants an inherited-loot bypass.
    const receipt = await getReplay(db, wallet, raidId);
    if (Array.isArray(receipt.events) && receipt.events.length === 0
      && receipt.result && typeof receipt.result === 'object'
      && (receipt.result as { retreated?: unknown }).retreated === true) {
      const envelope = {
        protocolVersion: NATIVE_PRESENTATION_PROTOCOL,
        raidId, source: 'live' as const, status: 'resolved', simVersion: receipt.simVersion,
        raidProtocolVersion: view.protocolVersion, clock: view.clock, lastSequence: view.lastSequence,
        snapshot: view.snapshot, armySnapshot: view.armySnapshot, commands: view.commands,
        visualContext: view.visualContext,
        ...(view.servicePresentation===undefined?{}:{servicePresentation:view.servicePresentation}),
        ...(view.advancedServicePresentation===undefined?{}:{advancedServicePresentation:view.advancedServicePresentation}),
        result: receipt.result, replaceFromTick: 0 as const,
      };
      return { envelope, revision: hash({ ...envelope, clock: {
        ...view.clock, serverNow: undefined, simNowMs: undefined,
      } }), simulationKey: null, input: null, events: [] as SimEvent[] };
    }
    throw new HttpError(409, 'terminal raid receipt is unavailable', 'NATIVE_TERMINAL_RECEIPT_UNAVAILABLE');
  }
  if (!view || view.status === 'resolved') {
    // Do not use wallet-only legacy replay under multi-base. Immutable
    // participant records preserve seller history without granting buyer loot.
    // Inherited deed archives retain their existing fresh-authority route.
    const replay = await (multiBaseEnabled()
      ? getParticipantBattleReplay(db, wallet, raidId, true) : getReplay(db, wallet, raidId, true))
      .catch((error: unknown) => {
        // A former defender may retain an immutable resolved archive, but a
        // failed live authority check cannot disclose a still-pending status.
        if (error instanceof HttpError && error.statusCode === 422) throw new HttpError(404, 'replay not found');
        throw error;
      });
    const orders = nativeArchivedHeroOrders(replay.orders);
    const envelope = {
      protocolVersion: NATIVE_PRESENTATION_PROTOCOL,
      raidId, source: 'archive' as const, status: 'resolved', simVersion: replay.simVersion,
      raidProtocolVersion: null, clock: null, lastSequence: -1,
      snapshot: replay.snapshot, armySnapshot: replay.armySnapshot, commands: [],
      ...(orders ? { orders } : {}),
      visualContext: replay.visualContext,
      ...(replay.servicePresentation===undefined?{}:{servicePresentation:replay.servicePresentation}),
      ...(replay.advancedServicePresentation===undefined?{}:{advancedServicePresentation:replay.advancedServicePresentation}),
      result: replay.result, replaceFromTick: 0 as const,
      buildingHealth: replay.buildingHealth,
    };
    return { envelope, revision: hash({ envelope, events: replay.events }),
      simulationKey: null, input: null, events: replay.events as SimEvent[] };
  }
  if (view.simVersion !== SIM_VERSION) {
    throw new HttpError(426, 'live raid simulator is unsupported', 'NATIVE_SIM_UNSUPPORTED');
  }
  if (view.protocolVersion !== LIVE_RAID.protocolVersion) {
    // V1 batch time belongs to its original client, not the database clock.
    // Keep those sessions on their existing recovery surface until the native
    // migration path can prove that start boundary. Archives remain readable.
    throw new HttpError(426, 'native live presentation requires raid protocol 2', 'NATIVE_RAID_PROTOCOL_UNSUPPORTED');
  }
  const commands = [...view.commands];
  const army = view.armySnapshot as FrozenArmy;
  const input: NativeSimulationInput | null = view.startedAt
    && (view.status === 'pending_orders' || view.status === 'resolving') ? {
    snapshot: view.snapshot as BaseSnapshot, orders: nativeOrders(commands, army), seed: view.seed,
    options: { ...(army.levels ? { troopLevels: army.levels } : {}) },
  } : null;
  const simulationKey = input ? hash({ simVersion: view.simVersion, input }) : null;
  const envelope = {
    protocolVersion: NATIVE_PRESENTATION_PROTOCOL,
    raidId, source: 'live' as const, status: view.status, simVersion: view.simVersion,
    raidProtocolVersion: view.protocolVersion, clock: view.clock, lastSequence: view.lastSequence,
    snapshot: view.snapshot, armySnapshot: view.armySnapshot, commands,
    visualContext: view.visualContext,
        ...(view.servicePresentation===undefined?{}:{servicePresentation:view.servicePresentation}),
        ...(view.advancedServicePresentation===undefined?{}:{advancedServicePresentation:view.advancedServicePresentation}),
    result: null, replaceFromTick: 0 as const,
  };
  // Moving wall time is not a journal revision. Clients extrapolate the clock;
  // a speed/start change does change revision without spending another SIM run.
  const revision = hash({ ...envelope, clock: {
    ...view.clock, serverNow: undefined, simNowMs: undefined,
  }, simulationKey });
  return { envelope, revision, simulationKey, input, events: [] as SimEvent[] };
}
