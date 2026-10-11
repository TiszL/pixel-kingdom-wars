/**
 * Device-local pointer to a server-authoritative raid.
 *
 * This deliberately stores no snapshot, command history, defender state,
 * rewards or result. It is only enough information to find the canonical raid
 * again after Android discards the page. The wallet/base fields are repeated in
 * the value and validated against the storage key so a stale async callback
 * cannot resume or clear another deed's raid.
 */
export const RAID_RESUME_STORAGE_VERSION = 1 as const;
const RAID_RESUME_KEY_PREFIX = `skp_raid_resume_v${RAID_RESUME_STORAGE_VERSION}`;

export type RaidResumeMode = 'pvp' | 'pve' | 'campaign' | 'live';
export type RaidResumeRole = 'attacker' | 'defender' | 'spectator';
export type RaidResumePhase = 'deploying' | 'playing' | 'committing' | 'result';

export interface RaidResumeTarget {
  defenderBaseId?: string;
  campId?: string;
  stage?: number;
  replayBaseId?: string;
}

export interface RaidResumeClockHint {
  revision: number;
  rate: 1 | 2;
}

export interface RaidResumeSpeedRequest {
  clientCommandId: string;
  expectedClockRevision: number;
  rate: 1 | 2;
}

export interface RaidResumePointer {
  version: typeof RAID_RESUME_STORAGE_VERSION;
  wallet: string;
  baseId: string;
  raidId: string;
  mode: RaidResumeMode;
  role: RaidResumeRole;
  phase: RaidResumePhase;
  target: RaidResumeTarget;
  clock: RaidResumeClockHint | null;
  inFlightSpeed: RaidResumeSpeedRequest | null;
}

/** Small selection fields from GET /raids/pending. The full frozen snapshot is
 * intentionally not repeated in the device pointer; RaidUI consumes it only
 * after this canonical response selects the march. */
export interface PendingRaidIdentity {
  id: string;
  attackerBaseId?: string | null;
  defenderWallet?: string | null;
  defenderBaseId?: string | null;
  pveCampId?: string | null;
  campaignStage?: number | null;
  simVersion: number;
}

export interface RaidResumeReplayResult {
  stars: number;
  destructionPct: number;
  keepDestroyed: boolean;
  lootShards: number | null;
  attackerTrophyDelta: number;
  lootRedacted?: boolean;
}

export interface RaidRecoveryTarget {
  kind: RaidResumeMode | 'replay';
  raidId: string;
  wallet?: string;
  defenderBaseId?: string;
  campId?: string;
  stage?: number;
  replayBaseId?: string;
  replayPath?: string;
  result?: RaidResumeReplayResult;
  /** A process-death return whose canonical battle already settled opens the
   * verdict, rather than replaying 90 seconds before revealing known truth. */
  resumeTerminal?: true;
  /** Exact idempotent speed write that may have committed before process death. */
  inFlightSpeed?: RaidResumeSpeedRequest;
}

export type RaidRecoveryDecision<T extends PendingRaidIdentity = PendingRaidIdentity> =
  | { kind: 'none' }
  | { kind: 'offline'; raidId: string; target: RaidRecoveryTarget }
  | { kind: 'resume'; raid: T; target: RaidRecoveryTarget }
  | { kind: 'watch'; target: RaidRecoveryTarget }
  | { kind: 'result'; target: RaidRecoveryTarget }
  | { kind: 'history'; raidIds: string[] };

export interface RaidRecoveryClient {
  get<T>(path: string): Promise<T>;
}

interface RaidResumeLiveStatus {
  status: string;
}

export type PendingRaidRecovery<T extends PendingRaidIdentity> =
  | { kind: 'none' }
  | { kind: 'resume'; raid: T }
  | { kind: 'history'; raidIds: string[] };

type RaidResumeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storageKey(wallet: string, baseId: string): string {
  return `${RAID_RESUME_KEY_PREFIX}:${encodeURIComponent(wallet)}:${encodeURIComponent(baseId)}`;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function clockRate(value: unknown): value is 1 | 2 {
  return value === 1 || value === 2;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validTarget(value: unknown): value is RaidResumeTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  if (target.defenderBaseId !== undefined && !nonEmptyString(target.defenderBaseId)) return false;
  if (target.campId !== undefined && !nonEmptyString(target.campId)) return false;
  if (target.replayBaseId !== undefined && !nonEmptyString(target.replayBaseId)) return false;
  if (target.stage !== undefined && !nonNegativeInteger(target.stage)) return false;
  return Object.keys(target).every((key) => (
    key === 'defenderBaseId' || key === 'campId' || key === 'stage' || key === 'replayBaseId'
  ));
}

function validClock(value: unknown): value is RaidResumeClockHint | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const clock = value as Record<string, unknown>;
  return nonNegativeInteger(clock.revision) && clockRate(clock.rate)
    && Object.keys(clock).every((key) => key === 'revision' || key === 'rate');
}

function validSpeedRequest(value: unknown): value is RaidResumeSpeedRequest | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return nonEmptyString(request.clientCommandId)
    && nonNegativeInteger(request.expectedClockRevision)
    && clockRate(request.rate)
    && Object.keys(request).every((key) => (
      key === 'clientCommandId' || key === 'expectedClockRevision' || key === 'rate'
    ));
}

function validPointer(
  value: unknown,
  wallet: string,
  baseId: string,
): value is RaidResumePointer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pointer = value as Record<string, unknown>;
  return pointer.version === RAID_RESUME_STORAGE_VERSION
    && pointer.wallet === wallet
    && pointer.baseId === baseId
    && nonEmptyString(pointer.raidId)
    && (pointer.mode === 'pvp' || pointer.mode === 'pve'
      || pointer.mode === 'campaign' || pointer.mode === 'live')
    && (pointer.role === 'attacker' || pointer.role === 'defender' || pointer.role === 'spectator')
    && (pointer.phase === 'deploying' || pointer.phase === 'playing'
      || pointer.phase === 'committing' || pointer.phase === 'result')
    && validTarget(pointer.target)
    && (pointer.mode !== 'campaign' || nonNegativeInteger(
      (pointer.target as RaidResumeTarget).stage,
    ))
    && (pointer.mode !== 'pve' || nonEmptyString(
      (pointer.target as RaidResumeTarget).campId,
    ))
    && validClock(pointer.clock)
    && validSpeedRequest(pointer.inFlightSpeed)
    && Object.keys(pointer).every((key) => (
      key === 'version' || key === 'wallet' || key === 'baseId' || key === 'raidId'
      || key === 'mode' || key === 'role' || key === 'phase' || key === 'target'
      || key === 'clock' || key === 'inFlightSpeed'
    ));
}

export function readRaidResumePointer(
  storage: RaidResumeStorage,
  wallet: string,
  baseId: string,
): RaidResumePointer | null {
  try {
    const raw = storage.getItem(storageKey(wallet, baseId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (validPointer(parsed, wallet, baseId)) return parsed;
    storage.removeItem(storageKey(wallet, baseId));
    return null;
  } catch {
    // Storage denial/corruption must never stop canonical server recovery.
    return null;
  }
}

export function writeRaidResumePointer(
  storage: RaidResumeStorage,
  pointer: RaidResumePointer,
): void {
  if (!validPointer(pointer, pointer.wallet, pointer.baseId)) return;
  try {
    storage.setItem(storageKey(pointer.wallet, pointer.baseId), JSON.stringify(pointer));
  } catch {
    // The server's pending-raid endpoint remains the fallback in private mode.
  }
}

/** Clear only the raid the caller actually finished. A late completion from
 * raid A must not erase raid B's newer pointer for the same deed. */
export function clearRaidResumePointer(
  storage: RaidResumeStorage,
  wallet: string,
  baseId: string,
  expectedRaidId: string,
): boolean {
  const current = readRaidResumePointer(storage, wallet, baseId);
  if (!current || current.raidId !== expectedRaidId) return false;
  try {
    storage.removeItem(storageKey(wallet, baseId));
    return true;
  } catch {
    return false;
  }
}

export function browserRaidResumeStorage(): RaidResumeStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Select the wallet's canonical marches. One resumes automatically after its
 * owning deed is hydrated; more than one is handed to RAID HISTORY so the
 * client never guesses which energy-bearing action the player meant. */
export function choosePendingRaidRecovery<T extends PendingRaidIdentity>(
  raids: readonly T[],
  _selectedBaseId: string | null,
  simVersion: number,
): PendingRaidRecovery<T> {
  const eligible = raids.filter((raid) => raid.simVersion === simVersion);
  if (eligible.length === 0) return { kind: 'none' };
  if (eligible.length === 1) {
    return { kind: 'resume', raid: eligible[0]! };
  }
  return { kind: 'history', raidIds: eligible.map((raid) => raid.id) };
}

export function targetForPendingRaid(raid: PendingRaidIdentity): RaidRecoveryTarget {
  if (raid.campaignStage) {
    return { kind: 'campaign', stage: raid.campaignStage, raidId: raid.id };
  }
  if (raid.pveCampId) return { kind: 'pve', campId: raid.pveCampId, raidId: raid.id };
  return {
    kind: 'pvp', raidId: raid.id,
    ...(raid.defenderWallet ? { wallet: raid.defenderWallet } : {}),
    ...(raid.defenderBaseId ? { defenderBaseId: raid.defenderBaseId } : {}),
  };
}

function targetForPointer(pointer: RaidResumePointer): RaidRecoveryTarget {
  const speed = pointer.inFlightSpeed
    ? { inFlightSpeed: pointer.inFlightSpeed } : {};
  if (pointer.role !== 'attacker') {
    return { kind: 'live', raidId: pointer.raidId, replayBaseId: pointer.baseId, ...speed };
  }
  if (pointer.mode === 'campaign') {
    return { kind: 'campaign', raidId: pointer.raidId, stage: pointer.target.stage!, ...speed };
  }
  if (pointer.mode === 'pve') {
    return { kind: 'pve', raidId: pointer.raidId, campId: pointer.target.campId!, ...speed };
  }
  return {
    kind: 'pvp', raidId: pointer.raidId,
    ...(pointer.target.defenderBaseId
      ? { defenderBaseId: pointer.target.defenderBaseId } : {}),
    ...speed,
  };
}

function isNetworkFailure(reason: unknown): boolean {
  return !!reason && typeof reason === 'object'
    && ((reason as { status?: unknown }).status === 0
      || (reason as { code?: unknown }).code === 'NETWORK_UNAVAILABLE');
}

/** Reconcile the tiny device pointer with three independent authoritative
 * sources. Reads start together; selection remains ordered: active `/live`,
 * attacker pending payload, then immutable participant replay. A failed read
 * never deletes the pointer because absence is not an authoritative retreat. */
export async function reconcileRaidResume<T extends PendingRaidIdentity>(args: {
  client: RaidRecoveryClient;
  storage: RaidResumeStorage | null;
  wallet: string;
  baseId: string;
  simVersion: number;
}): Promise<RaidRecoveryDecision<T>> {
  const globalPending = async (): Promise<RaidRecoveryDecision<T>> => {
    const { raids } = await args.client.get<{ raids: T[] }>('/raids/pending');
    const decision = choosePendingRaidRecovery(raids, args.baseId, args.simVersion);
    if (decision.kind === 'resume') {
      const saved = args.storage && decision.raid.attackerBaseId
        ? readRaidResumePointer(args.storage, args.wallet, decision.raid.attackerBaseId) : null;
      return { ...decision, target: {
        ...targetForPendingRaid(decision.raid),
        ...(saved?.raidId === decision.raid.id && saved.inFlightSpeed
          ? { inFlightSpeed: saved.inFlightSpeed } : {}),
      } };
    }
    return decision;
  };
  const pointer = args.storage
    ? readRaidResumePointer(args.storage, args.wallet, args.baseId) : null;
  if (!pointer) return globalPending();

  const livePath = `/raids/${encodeURIComponent(pointer.raidId)}/live?afterSequence=-1`;
  const pendingPath = `/raids/pending/${encodeURIComponent(pointer.raidId)}`;
  const replayPath = `/battles/participated/${encodeURIComponent(pointer.raidId)}/replay`;
  const [live, pending, replay] = await Promise.allSettled([
    args.client.get<RaidResumeLiveStatus>(livePath),
    args.client.get<{ raid: T | null }>(pendingPath),
    args.client.get<{ result: RaidResumeReplayResult }>(replayPath),
  ]);

  if (live.status === 'fulfilled' && live.value.status === 'pending_orders') {
    if (pointer.role !== 'attacker') return { kind: 'watch', target: targetForPointer(pointer) };
    if (pending.status === 'fulfilled' && pending.value.raid) {
      return {
        kind: 'resume', raid: pending.value.raid,
        target: { ...targetForPendingRaid(pending.value.raid),
          ...(pointer.inFlightSpeed ? { inFlightSpeed: pointer.inFlightSpeed } : {}) },
      };
    }
    return { kind: 'watch', target: targetForPointer(pointer) };
  }
  if (pending.status === 'fulfilled' && pending.value.raid) {
    return {
      kind: 'resume', raid: pending.value.raid,
      target: { ...targetForPendingRaid(pending.value.raid),
        ...(pointer.inFlightSpeed ? { inFlightSpeed: pointer.inFlightSpeed } : {}) },
    };
  }
  if (replay.status === 'fulfilled') {
    return {
      kind: 'result',
      target: {
        kind: 'replay', raidId: pointer.raidId, replayPath,
        replayBaseId: pointer.baseId, result: replay.value.result, resumeTerminal: true,
      },
    };
  }
  if ([live, pending, replay].some((result) =>
    result.status === 'rejected' && isNetworkFailure(result.reason))) {
    return { kind: 'offline', raidId: pointer.raidId, target: targetForPointer(pointer) };
  }
  // The deed-scoped pointer can be stale while another current-SIM march is
  // still authoritative. Its absence is not permission to skip the wallet-wide
  // pending source.
  return globalPending();
}

let reconcileFlight: Promise<unknown> | null = null;
let reconcileFlightKey: string | null = null;

/** Page-show, visibility and online can fire in one browser turn. They share
 * one canonical read-and-hydration transaction for a wallet/base identity. */
export function reconcileRaidResumeSingleFlight<T>(
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  if (reconcileFlight && reconcileFlightKey === key) {
    return reconcileFlight as Promise<T>;
  }
  const flight = run();
  reconcileFlightKey = key;
  reconcileFlight = flight;
  const clear = (): void => {
    if (reconcileFlight === flight) {
      reconcileFlight = null;
      reconcileFlightKey = null;
    }
  };
  void flight.then(clear, clear);
  return flight;
}

export function installRaidRecoveryLifecycle(args: {
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  reconcile(): void;
}): () => void {
  const run = (): void => args.reconcile();
  const visible = (): void => { if (args.doc.visibilityState === 'visible') run(); };
  args.win.addEventListener('pageshow', run);
  args.win.addEventListener('online', run);
  args.doc.addEventListener('visibilitychange', visible);
  return () => {
    args.win.removeEventListener('pageshow', run);
    args.win.removeEventListener('online', run);
    args.doc.removeEventListener('visibilitychange', visible);
  };
}
