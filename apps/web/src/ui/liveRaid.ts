import type {BoundCosmeticBaseRead} from '@shardkeep/shared/boundCosmeticVisual';
import type { BaseVisualContext } from '@shardkeep/shared/baseVisual';
/** Participant live-raid wire contract and deterministic command hydration. */
import type {
  HeroCombatLoadout, HeroKey, LiveRaidClock, LiveRaidClockRate, RaidProtocolVersion, TroopType,
} from '@shardkeep/shared';
import { SIM_VERSION } from '@shardkeep/sim';

/** `tMs` exists only on a batch journal (D-099): that battle clock runs on the
 * client, so each order carries the offset it was placed at. A live stream
 * never sends one — the server stamps `serverOffsetMs` from its own clock. */
export type LiveCommand = {
  sequence: number;
  clientCommandId: string;
  serverOffsetMs: number;
  acceptedAt: string;
} & (
  | { kind: 'deploy'; payload: { troop: TroopType; tx: number; ty: number; tMs?: number } }
  | { kind: 'hero'; payload: { hero: HeroKey; tx: number; ty: number; tMs?: number } }
  | { kind: 'rally'; payload: { tx: number; ty: number; tMs?: number } }
  | { kind: 'buff'; payload: { buff: 'warhorn' | 'swiftboots' | 'powdercharge' } }
  // Control rows share the canonical sequence but never become SIM orders.
  | { kind: 'start'; payload: { expectedClockRevision: number; automatic?: boolean } }
  | { kind: 'speed'; payload: { expectedClockRevision: number; rate: LiveRaidClockRate } }
  | { kind: 'retreat'; payload: Record<string, never> }
);

export interface LiveRaidView {
  /** Frozen berth siblings captured with the raid (P6a): starter v1 and advanced v1,
   *  passed through to battle:enter untouched; absent on legacy originals. */
  servicePresentation?: unknown;
  advancedServicePresentation?: unknown;
  visualContext?: BaseVisualContext | undefined; boundCosmeticVisual?: BoundCosmeticBaseRead | undefined;
  protocolVersion: RaidProtocolVersion;
  clock: LiveRaidClock;
  startedAt: string | null;
  battleEndsAt: string | null;
  streamClosedAt: string | null;
  lastSequence: number;
  snapshot: unknown;
  armySnapshot: {
    counts?: Record<string, number>;
    levels?: Record<string, number>;
    heroLevels?: Record<string, number>;
    heroLoadouts?: Partial<Record<HeroKey, HeroCombatLoadout>>;
  };
  seed: number;
  simVersion: number;
  status: string;
  commands: LiveCommand[];
  hasMore: boolean;
}

export interface HydratedLiveOrders {
  deploys: Array<{ troop: TroopType; tx: number; ty: number; tMs: number }>;
  heroDeploys: Array<{ hero: HeroKey; tx: number; ty: number; tMs: number; level: number; loadout?: HeroCombatLoadout }>;
  buffs?: { warhorn?: boolean; swiftboots?: boolean; powdercharge?: boolean };
  rally?: { tx: number; ty: number; tMs: number };
}

export interface LiveRaidControlReceipt {
  command: LiveCommand;
  clock: LiveRaidClock;
}

export function liveRaidStartRequest(
  raidId: string, clientCommandId: string, expectedClockRevision: number,
): { path: string; body: { clientCommandId: string; expectedClockRevision: number } } {
  return {
    path: `/raids/${encodeURIComponent(raidId)}/start`,
    body: { clientCommandId, expectedClockRevision },
  };
}

export function liveRaidSpeedRequest(
  raidId: string, clientCommandId: string, expectedClockRevision: number, rate: 1 | 2,
): { path: string; body: { clientCommandId: string; expectedClockRevision: number; rate: 1 | 2 } } {
  return {
    path: `/raids/${encodeURIComponent(raidId)}/speed`,
    body: { clientCommandId, expectedClockRevision, rate },
  };
}

export function liveRaidFinishRequest(
  raidId: string, clientCommandId: string,
): { path: string; body: { retreat: true; clientCommandId: string } } {
  return {
    path: `/raids/${encodeURIComponent(raidId)}/finish`,
    body: { retreat: true, clientCommandId },
  };
}

/** A stale CAS is a successful canonical read carried by an error envelope.
 * Validate it structurally before changing presentation state; arbitrary error
 * details must never become a clock. */
export function clockFromStaleRaidError(error: unknown): LiveRaidClock | null {
  if (!error || typeof error !== 'object'
    || (error as { code?: unknown }).code !== 'RAID_CLOCK_STALE') return null;
  const clock = (error as { details?: { clock?: unknown } }).details?.clock;
  if (!clock || typeof clock !== 'object') return null;
  const value = clock as Partial<LiveRaidClock>;
  return (value.protocolVersion === 1 || value.protocolVersion === 2)
    && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0
    && (value.rate === 1 || value.rate === 2)
    && (value.anchorWallAt === null || typeof value.anchorWallAt === 'string')
    && typeof value.anchorSimMs === 'number' && Number.isFinite(value.anchorSimMs)
    && typeof value.serverNow === 'string'
    && typeof value.simNowMs === 'number' && Number.isFinite(value.simNowMs)
    && (value.battleEndsAt === null || typeof value.battleEndsAt === 'string')
    && typeof value.durationMs === 'number' && Number.isFinite(value.durationMs)
    ? value as LiveRaidClock : null;
}

/** Exact retries return the original receipt. They may arrive after a newer
 * poll or another tab's speed change; never let that receipt rewind our clock.
 * This comparison is raid-local: discard the prior clock when entering a raid. */
export function isNewerRaidClock(current: LiveRaidClock | null, next: LiveRaidClock): boolean {
  return current === null || next.revision > current.revision
    || (next.revision === current.revision
      && Date.parse(next.serverNow) > Date.parse(current.serverNow));
}

/** Advance only presentation from the latest canonical server playhead. The
 * local wall clock measures elapsed time since receipt; it never supplies a
 * timestamp to the server or changes SIM input. A later poll/receipt corrects
 * network delay and tab suspension without compounding drift. */
export function liveRaidPlayheadMs(
  clock: LiveRaidClock,
  receivedAtMs: number,
  nowMs: number,
): number {
  if (clock.anchorWallAt === null) return 0;
  return playbackPlayheadMs(
    clock.simNowMs, receivedAtMs, nowMs, clock.rate, clock.durationMs,
  );
}

/** Advance a presentation-only timeline from an accepted anchor. Completed
 * replays use the same arithmetic as a canonical live clock, but never write
 * their local rate back to the server. */
export function playbackPlayheadMs(
  anchorSimMs: number,
  receivedAtMs: number,
  nowMs: number,
  rate: LiveRaidClockRate,
  durationMs: number,
): number {
  return Math.min(
    durationMs,
    anchorSimMs + Math.max(0, nowMs - receivedAtMs) * rate,
  );
}

/** Convert simulator time to wall time at the accepted presentation rate. */
export function playbackWallDelayMs(simDeltaMs: number, rate: LiveRaidClockRate): number {
  return Math.ceil(Math.max(0, simDeltaMs) / rate);
}

/** Wall delay until the canonical clock reaches full duration. SIM may emit a
 * terminal field event early (wipe/100%), but normal `{}` FINISH is not due
 * until this reaches zero. */
export function liveRaidNormalFinishDelayMs(
  clock: LiveRaidClock, receivedAtMs: number, nowMs: number,
): number | null {
  if (clock.anchorWallAt === null) return null;
  const remainingSimMs = Math.max(
    0, clock.durationMs - liveRaidPlayheadMs(clock, receivedAtMs, nowMs),
  );
  return playbackWallDelayMs(remainingSimMs, clock.rate);
}

export function liveRaidPath(raidId: string, afterSequence: number): string {
  return `/raids/${encodeURIComponent(raidId)}/live?afterSequence=${afterSequence}`;
}

/** Never run a live command stream through a different simulator revision. */
export function assertLiveRaidSimVersion(simVersion: number): void {
  if (simVersion !== SIM_VERSION) {
    throw new Error(`LIVE RAID REQUIRES SIM VERSION ${SIM_VERSION}`);
  }
}

/** Convert the append-only server stream into the exact simulator input used
 * at settlement. Sorting and sequence de-duplication make reconnect pages safe
 * to merge even when a response is retried. */
export function hydrateLiveOrders(
  commands: readonly LiveCommand[], heroLevels: Record<string, number> = {},
  heroLoadouts: Partial<Record<HeroKey, HeroCombatLoadout>> = {},
): HydratedLiveOrders {
  const bySequence = new Map(
    [...commands].sort((a, b) => a.sequence - b.sequence)
      .map((command) => [command.sequence, command]),
  );
  // A live simulation may consume only the contiguous, server-sequenced
  // prefix. A missing page must never let a later accepted command jump ahead.
  const ordered: LiveCommand[] = [];
  for (let sequence = 0; bySequence.has(sequence); sequence++) {
    ordered.push(bySequence.get(sequence)!);
  }
  const result: HydratedLiveOrders = { deploys: [], heroDeploys: [] };
  for (const command of ordered) {
    if (command.kind === 'deploy') {
      result.deploys.push({ ...command.payload, tMs: command.serverOffsetMs });
    } else if (command.kind === 'hero') {
      result.heroDeploys.push({
        ...command.payload,
        tMs: command.serverOffsetMs,
        level: heroLevels[command.payload.hero] ?? 1,
        ...(heroLoadouts[command.payload.hero] ? { loadout: heroLoadouts[command.payload.hero] } : {}),
      });
    } else if (command.kind === 'rally') {
      result.rally = { ...command.payload, tMs: command.serverOffsetMs };
    } else if (command.kind === 'buff') {
      result.buffs = { ...result.buffs, [command.payload.buff]: true };
    }
  }
  return result;
}
