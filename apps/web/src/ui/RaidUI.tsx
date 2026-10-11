import { useUserCommand } from './pk/useUserCommand';
import type {BoundCosmeticBaseRead} from '@shardkeep/shared/boundCosmeticVisual';
import { isBattlefieldTileDeployable, occupiedBattlefieldTiles, type BattlefieldContext } from '@shardkeep/shared/battlefield';
import type { BaseVisualContext } from '@shardkeep/shared/baseVisual';
import { raidEntryCostLabel } from './RaidEntryCost';
/**
 * Raid flow (PLAN 5c) — restyled to App parity. Three entry modes via
 * store.raidTarget:
 *   • null / kind:'pvp'  → auto-match (POST /raids) or attack a chosen wallet
 *   • kind:'pve'         → attack a Ruined Keep (POST /raids/pve)
 *   • kind:'replay'      → SPECTATE a saved raid (deploy UI hidden; the scene
 *                          is fed snapshot+events by RaidLog, RaidUI only
 *                          shows the battle HUD + result).
 *
 * Battle HUD (App L908–932): a countdown/elapsed timer, live destruction %,
 * three stars that fill as the sim crosses its thresholds, a second row with
 * live loot accumulators + the three buff pills, and a deploy tray + RALLY
 * skill. Stars/% climb during playback by replaying the resolved event log's
 * `star` events on the same 100ms tick clock the scene uses, snapping to the
 * server's final values at `battle:done` — the server's resolved result is the
 * only source of truth (CLAUDE.md: HUD values never hardcoded).
 *
 * Deploy orders carry buffs (KEEP-costed) and a once-per-raid Rally pulse
 * (Keep-level gated); both are validated and charged server-side in
 * apps/api/src/game/raids.ts. Deploy targeting and army come from the raid's
 * frozen armySnapshot.
 */
import {
  BUFFS, CAMPAIGN, ECONOMY, GRID, HERO_COMBAT, isTrainableTroop, RAID_CAMERA, RAID_ENERGY, RAID_BATTLEFIELD, RAID_RULES, RALLY, TROOP_TYPES, TROOPS,
  type TroopType, type HeroCombatLoadout, type HeroKey,
  type LiveRaidClock, type RaidProtocolVersion,
} from '@shardkeep/shared';
import { SIM_VERSION, type simulateRaid } from '@shardkeep/sim';
import { RaidSimulationService, type RaidSimulationInput } from './raidSimulation';
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { battleHealthContext, footprintOf } from '../game/fx/stats';
import { sceneCleanup } from '../game/sceneCleanup';
import { ApiError, api, baseSelectorAvailable, idemKey, isLandNotOwned } from '../lib/api';
import { playSfx } from '../lib/audio';
import { bus } from '../lib/events';
import { haptic } from '../lib/juice';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, type RaidTarget, useApp } from '../state/store';
import { useMobileBackHandler } from '../lib/mobileBackGuard';
import {
  browserRaidResumeStorage, clearRaidResumePointer, writeRaidResumePointer,
  type RaidResumePhase,
} from '../lib/raidResume';
import { useSolPurchase } from '../auth/useSolPurchase';
import { reloadBase } from '../state/baseSnapshot';
import { DefeatScreen, type RaidResult, VictoryScreen } from './screens/results';
import {
  troopRolloutGate, type DarkAttackerRosterFeature,
} from './troopRollout';
import { TROOP_DISPLAY } from './copy';
import { DeedlessNoTargets, type NoTargetsPool, noTargetsPool } from './raidNoTargets';
import { troopPortrait, UI } from './icons';
import {
  assertLiveRaidSimVersion, clockFromStaleRaidError, hydrateLiveOrders, isNewerRaidClock, liveRaidPath, liveRaidPlayheadMs,
  liveRaidFinishRequest, liveRaidNormalFinishDelayMs, liveRaidSpeedRequest, liveRaidStartRequest,
  playbackPlayheadMs, playbackWallDelayMs,
  type LiveCommand, type LiveRaidControlReceipt, type LiveRaidView,
} from './liveRaid';
import { Btn, COLORS as C, fmtDur, fmtN, fmtT, Icon, Pill, PillSub, PillVal, Sprite } from './primitives';
import { raidBreaksShield, shieldBreakRemainingSec } from './shieldBreak';
import { readGameUiViewport, readGameViewport, subscribeGameViewport } from '../lib/gameViewport';
import { useSafeAreaInsets, useWindowSize, type Insets } from './layout';
import { heroPortrait } from './heroPortrait';
import { MobileBackConfirm } from './MobileBackConfirm';

/** Camera-safe rect from real device cutouts plus the measured deploy tray. */
export function battleCameraInsets(
  hudTopPx: number,
  trayHeightPx: number,
  safe: Insets,
  controlClearance = 0,
): { top: number; bottom: number; left: number; right: number } {
  return {
    top: hudTopPx + safe.top,
    bottom: trayHeightPx + Math.max(0, controlClearance),
    left: safe.left,
    right: safe.right,
  };
}

/** Battle-deck metrics are viewport presentation, never combat numbers. The
 *  compact row protects the canonical 915×311 Seeker webview; portrait and
 *  desktop get the larger two-row deck the roster needs. */
export const RAID_DEPLOY_UI = {
  tap: 48,
  cameraGap: 6,
  cameraEdge: 10,
  portraitCardW: 78,
  portraitCardH: 90,
  portraitArt: 54,
  desktopCardW: 88,
  desktopCardH: 100,
  desktopArt: 62,
  landscapeCardW: 70,
  landscapeCardH: 80,
  landscapeArt: 50,
  actionH: 52,
  landscapeActionH: 48,
} as const;

export interface RaidDeployLayout {
  oneRow: boolean;
  cardWidth: number;
  cardHeight: number;
  artSize: number;
  actionHeight: number;
  trayMaxHeight: number;
}

export function raidDeployLayout(w: number, h: number): RaidDeployLayout {
  const oneRow = w > h * 1.1 && h <= 520;
  if (oneRow) return {
    oneRow: true,
    cardWidth: RAID_DEPLOY_UI.landscapeCardW,
    cardHeight: RAID_DEPLOY_UI.landscapeCardH,
    artSize: RAID_DEPLOY_UI.landscapeArt,
    actionHeight: RAID_DEPLOY_UI.landscapeActionH,
    trayMaxHeight: 112,
  };
  const desktop = w >= 900 && h >= 600;
  return desktop ? {
    oneRow: false,
    cardWidth: RAID_DEPLOY_UI.desktopCardW,
    cardHeight: RAID_DEPLOY_UI.desktopCardH,
    artSize: RAID_DEPLOY_UI.desktopArt,
    actionHeight: RAID_DEPLOY_UI.actionH,
    trayMaxHeight: 182,
  } : {
    oneRow: false,
    cardWidth: RAID_DEPLOY_UI.portraitCardW,
    cardHeight: RAID_DEPLOY_UI.portraitCardH,
    artSize: RAID_DEPLOY_UI.portraitArt,
    actionHeight: RAID_DEPLOY_UI.actionH,
    trayMaxHeight: 172,
  };
}

export interface RaidCameraControlLayout {
  horizontal: boolean;
  top: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
}

/** Places the three camera controls in the clear band between the battle HUD
 * and the measured deploy tray. Short landscape uses one horizontal row: the
 * old 3-high rail needed 144px and necessarily crossed the 96px HUD on a
 * 915×311 Seeker viewport. Portrait keeps the familiar vertical rail. */
export function raidCameraControlLayout(
  viewport: { w: number; h: number },
  deploy: RaidDeployLayout,
  trayHeight: number,
  safe: Insets,
): RaidCameraControlLayout {
  const horizontal = deploy.oneRow;
  const width = horizontal
    ? RAID_DEPLOY_UI.tap * 3 + RAID_DEPLOY_UI.cameraGap * 2
    : RAID_DEPLOY_UI.tap;
  const height = horizontal
    ? RAID_DEPLOY_UI.tap
    : RAID_DEPLOY_UI.tap * 3 + RAID_DEPLOY_UI.cameraGap * 2;
  const trayTop = viewport.h - Math.max(0, trayHeight);
  const portraitBottom = Math.max(0, trayHeight) + RAID_CAMERA.pillGapPx;
  const top = horizontal
    ? Math.max(
      RAID_CAMERA.hudTopPx + safe.top,
      trayTop - RAID_CAMERA.pillGapPx - height,
    )
    : viewport.h - portraitBottom - height;
  const bottom = horizontal ? viewport.h - top - height : portraitBottom;

  return {
    horizontal,
    top,
    bottom,
    right: RAID_DEPLOY_UI.cameraEdge + safe.right,
    width,
    height,
  };
}

interface RaidDto {
  id: string;
  defenderWallet?: string | null;
  attackerBaseId?: string | null;
  defenderBaseId?: string | null;
  pveCampId?: string | null;
  campaignStage?: number | null;
  snapshot: unknown; visualContext?: BaseVisualContext | undefined; boundCosmeticVisual?: BoundCosmeticBaseRead | undefined;
  servicePresentation?: unknown; advancedServicePresentation?: unknown;
  armySnapshot: {
    counts: Record<string, number>; levels: Record<string, number>;
    features?: {
      darkAttackerRoster?: DarkAttackerRosterFeature;
      /** Optional rolling capability. Absent on old APIs and pre-rollout rows. */
      batchOrdersGraceSec?: number;
      /** D-099: the server journals each order of this batch raid as it is
       *  placed and finishes the raid itself when FINISH never arrives. Absent
       *  on old APIs and pre-rollout rows, which keep the whole-list POST. */
      batchCommandJournal?: boolean;
    };
    /** recruited heroes + the LEVELS the player paid KEEP for (server-frozen). */
    heroes?: Array<'vex' | 'theodor'>; heroLevels?: Record<string, number>;
    heroLoadouts?: Partial<Record<HeroKey, HeroCombatLoadout>>;
  };
  ordersDeadlineAt: string;
  seed: number;
  simVersion: number;
  raidProtocolVersion?: RaidProtocolVersion;
  live?: { clock: LiveRaidClock; startedAt: string | null } | null;
  /** True when this pending march owns at least one hero reservation. Present
   * only on GET /raids/pending. */
  heroReserved?: boolean;
}

export function unavailableFrozenHeroes(
  raid: Pick<RaidDto, 'attackerBaseId' | 'armySnapshot'> | null,
  base: ReturnType<typeof useApp.getState>['base'],
): NonNullable<NonNullable<ReturnType<typeof useApp.getState>['base']>['heroes']> {
  if (!raid?.attackerBaseId || raid.attackerBaseId !== base?.baseId) return [];
  const frozen = new Set(raid.armySnapshot.heroes ?? []);
  return (base.heroes ?? []).filter((hero) => !frozen.has(hero.hero));
}

function UnavailableHeroCard({ hero, layout }: {
  hero: NonNullable<NonNullable<ReturnType<typeof useApp.getState>['base']>['heroes']>[number];
  layout: RaidDeployLayout;
}): React.JSX.Element {
  const deadlineMs = hero.recoveryUntil ? Date.parse(hero.recoveryUntil) : 0;
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    if (hero.available || !Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [deadlineMs, hero.available]);
  const remSec = Number.isFinite(deadlineMs)
    ? Math.max(0, Math.ceil((deadlineMs - nowMs) / 1_000)) : 0;
  const recovering = !hero.available;
  return (
    <div aria-disabled="true" title={recovering
      ? `${hero.hero} is recovering and cannot attack or defend`
      : `${hero.hero} became ready after this raid roster was frozen`}
      style={{ position: 'relative', flex: '0 0 auto', width: layout.cardWidth,
        minHeight: layout.cardHeight, boxSizing: 'border-box', background: C.card,
        border: `2px solid ${C.danger}`, padding: '4px 2px 3px', display: 'flex',
        flexDirection: 'column', justifyContent: 'center', alignItems: 'center', opacity: 0.65 }}>
      <Sprite name={heroPortrait(hero.hero, hero.level)} w={layout.artSize} h={layout.artSize} />
      <span style={{ fontSize: 10, color: C.danger, lineHeight: 1, padding: '1px 2px 2px', textAlign: 'center' }}>
        {recovering ? `RECOVERING ${remSec > 0 ? fmtDur(remSec).toUpperCase() : 'VERIFYING'}` : 'READY NEXT RAID'}
      </span>
    </div>
  );
}

function liveResume(raid: RaidDto, nowMs: number): RaidDto | null {
  return raid.simVersion === SIM_VERSION
    && new Date(raid.ordersDeadlineAt).getTime() > nowMs
    ? raid
    : null;
}

export function resumableRaidById(
  raids: readonly RaidDto[], raidId: string, nowMs = Date.now(),
): RaidDto | null {
  const raid = raids.find((candidate) => candidate.id === raidId);
  return raid ? liveResume(raid, nowMs) : null;
}

/** Pick only the still-actionable march named by HERO_ALREADY_COMMITTED. The
 * API exposes a resume payload solely to its attacker; the deadline check keeps
 * a response cached across the expiry boundary from reviving an abandoned raid. */
export function resumableCommittedRaid(
  error: unknown,
  raids: readonly RaidDto[],
  nowMs = Date.now(),
): RaidDto | null {
  if (!(error instanceof ApiError) || error.code !== 'HERO_ALREADY_COMMITTED') return null;
  for (const raid of raids) {
    if (!raid.heroReserved) continue;
    const resume = liveResume(raid, nowMs);
    if (resume) return resume;
  }
  return null;
}

/** Restore the navigation identity of the frozen march as well as its battle
 * payload. Otherwise resuming campaign stage 4 while the player tapped stage 5
 * would make NEXT STAGE and return routing describe the wrong encounter. */
export function targetForResumedRaid(raid: RaidDto): RaidTarget {
  if (raid.campaignStage) return { kind: 'campaign', stage: raid.campaignStage, raidId: raid.id };
  if (raid.pveCampId) return { kind: 'pve', campId: raid.pveCampId, raidId: raid.id };
  return {
    kind: 'pvp',
    raidId: raid.id,
    wallet: raid.defenderWallet ?? undefined,
    defenderBaseId: raid.defenderBaseId ?? undefined,
  };
}

/** Rewatch must preserve the authorization scope chosen by Battle History.
 * A former deed owner has participant authority but no longer has deed
 * authority, so falling back to the legacy route would strand a valid replay. */
export function savedReplayPath(target: Pick<RaidTarget, 'replayPath' | 'replayBaseId'>, raidId: string): string {
  return target.replayPath ?? (target.replayBaseId
    ? `/bases/${encodeURIComponent(target.replayBaseId)}/battles/${encodeURIComponent(raidId)}/replay`
    : `/raids/${encodeURIComponent(raidId)}/replay`);
}

/** Pure request mapper so stable base identity cannot silently disappear from
 * one of the four raid entry modes. Every create is raw because the exact same
 * logical id must survive the one permitted protocol-1 capability fallback. */
export function raidCreateRequest(
  target: RaidTarget | null, attackerBaseId: string | undefined, idempotencyKey: string,
): { path: string; body: Record<string, unknown>; raw: boolean } {
  if (target?.kind === 'campaign' && target.stage) {
    return {
      path: `/campaign/${target.stage}/raid`,
      body: { idempotencyKey, attackerBaseId, raidProtocolVersion: 2 },
      raw: true,
    };
  }
  if (target?.kind === 'pve' && target.campId) {
    return {
      path: '/raids/pve',
      body: { campId: target.campId, idempotencyKey, attackerBaseId, raidProtocolVersion: 2 },
      raw: true,
    };
  }
  return {
    path: '/raids',
    body: target?.kind === 'pvp' && target.wallet
      ? { defenderWallet: target.wallet, defenderBaseId: target.defenderBaseId, attackerBaseId,
        idempotencyKey, raidProtocolVersion: 2 }
      : { attackerBaseId, idempotencyKey, raidProtocolVersion: 2,
        ...(target?.excludeBaseId ? { excludeBaseId: target.excludeBaseId } : {}) },
    raw: true,
  };
}

/** Capability fallback is deliberately narrow: the exact logical create (same
 * idempotency key and target) may retry v1 only when the API says v2 is
 * disabled. Every other failure is preserved. */
export async function createRaidWithProtocolFallback<T>(
  request: ReturnType<typeof raidCreateRequest>,
  send: (path: string, body: Record<string, unknown>) => Promise<T> = api.postRaw,
): Promise<T> {
  try {
    return await send(request.path, request.body);
  } catch (cause) {
    if (!(cause instanceof ApiError) || cause.code !== 'LIVE_RAID_V2_DISABLED') throw cause;
    const { raidProtocolVersion: _protocol, ...v1Body } = request.body;
    return send(request.path, v1Body);
  }
}

function resumePhase(phase: Phase): RaidResumePhase {
  if (phase === 'playing') return 'playing';
  if (phase === 'committing') return 'committing';
  if (phase === 'done') return 'result';
  return 'deploying';
}

export function liveRaidCommandRequest(
  raidId: string,
  clientCommandId: string,
  command: Pick<LiveCommand, 'kind' | 'payload'>,
): { path: string; body: { clientCommandId: string; command: Pick<LiveCommand, 'kind' | 'payload'> } } {
  return {
    path: `/raids/${encodeURIComponent(raidId)}/commands`,
    body: { clientCommandId, command },
  };
}

/** A deploy control exists only when the frozen server snapshot explicitly
 * activates the SIM6 roster. Old servers omit the capability and fail closed;
 * Barrowling remains absent through the shared trainable predicate. */
export function raidDeployTrayTroops(
  snapshot: Pick<RaidDto['armySnapshot'], 'counts' | 'features'>,
): string[] {
  return TROOP_TYPES.filter((troop) =>
    isTrainableTroop(troop)
    && !troopRolloutGate(troop, snapshot.features?.darkAttackerRoster).locked);
}

/** Old API/pre-rollout rows do not promise a server-side finalization tail, so
 * retain the deployed client's conservative 3s playback/transport slack. */
const LEGACY_BATCH_COMMIT_SLACK_MS = 3_000;
/** The old batch client auto-submitted another 2s before its displayed cutoff. */
const LEGACY_BATCH_AUTO_SUBMIT_MARGIN_MS = 2_000;

function supportsBatchOrdersGrace(batchOrdersGraceSec: number | undefined): boolean {
  return batchOrdersGraceSec === RAID_RULES.batchOrdersGraceSec;
}

/** Recover the batch deploy cutoff without changing the deployed meaning of
 * `ordersDeadlineAt`. A new server capability unlocks all 30 seconds; old APIs
 * and pre-rollout pending rows retain the previous conservative cutoff. */
export function batchDeployEndsAtMs(
  ordersDeadlineAt: string,
  batchOrdersGraceSec?: number,
): number {
  return new Date(ordersDeadlineAt).getTime()
    - RAID_RULES.battleDurationSec * 1_000
    - (supportsBatchOrdersGrace(batchOrdersGraceSec) ? 0 : LEGACY_BATCH_COMMIT_SLACK_MS);
}

export function batchAutoSubmitAtMs(
  ordersDeadlineAt: string,
  batchOrdersGraceSec?: number,
): number {
  return batchDeployEndsAtMs(ordersDeadlineAt, batchOrdersGraceSec)
    - (supportsBatchOrdersGrace(batchOrdersGraceSec) ? 0 : LEGACY_BATCH_AUTO_SUBMIT_MARGIN_MS);
}

/** Live first-deploy authority is always exactly 30s; it never depends on the
 * batch replay tail capability. */
export function liveDeployEndsAtMs(ordersDeadlineAt: string): number {
  return new Date(ordersDeadlineAt).getTime() - RAID_RULES.battleDurationSec * 1_000;
}

/** 'committing' = the battle finished and the POST that RESOLVES it is in flight
 *  (or failed and is retryable). It exists so a verdict is never rendered from a
 *  missing server result — that is what turned a won raid into DEFEAT. */
type Phase = 'deploying' | 'submitting' | 'playing' | 'committing' | 'done';
const TICK_MS = 100; // sim playback clock — mirrors BattleScene.TICK_MS
/** D-106: the batch battle clock in wall ms — the sim's MAX_TICKS × TICK_MS.
 *  A batch fight with reserves in the tray stays open until this runs out. */
const BATTLE_CLOCK_MS = RAID_RULES.battleDurationSec * 1_000;
/** How long the 'RESOLVING RAID…' state may wait on the commit POST before it
 *  self-heals from the replay record. Client timing, not a game number. */
const COMMIT_WATCHDOG_MS = 12_000;
/** D-096: the server's 422 for a raid posted after `ordersDeadlineAt` +
 *  RAID_RULES.batchOrdersGraceSec. The row is already `expired` and the energy
 *  refunded, so no retry can ever succeed — the panel says exactly that and
 *  offers only the way home. */
const RAID_EXPIRED_RE = /deploy window expired/i;
const RAID_EXPIRED_COPY = 'BATTLE TIMED OUT — RESULT NOT RECORDED · ENERGY REFUNDED';
/** Backoff between an ambiguous command's canonical reads / exact-ID retries.
 * Transport timing only; the pending card remains reserved throughout. */
const LIVE_COMMAND_RECONCILE_MS = 1_000;

/**
 * Phaser listens for mouse/touch starts on `window`, including events whose
 * target is React chrome above the canvas. Stop starts at one HUD boundary so a
 * long press on a troop card cannot arm hold-to-deploy underneath. Releases
 * deliberately bubble: Phaser's window listener needs them to close a gesture
 * that began on the field and ended over the HUD. With no field-origin start,
 * BattleScene has no gesture to commit. Do not preventDefault on starts: the
 * troop row must retain native pan-x.
 */
const stopHudEvent = (event: { stopPropagation: () => void }): void => event.stopPropagation();
const stopHudDrag = (event: { preventDefault: () => void }): void => event.preventDefault();

export const RAID_HUD_INPUT_PROPS = {
  onMouseDown: stopHudEvent,
  onTouchStart: stopHudEvent,
  onDragStart: stopHudDrag,
  onContextMenu: stopHudDrag,
} as const;

export const RAID_HUD_BOUNDARY_STYLE = {
  pointerEvents: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTouchCallout: 'none',
} satisfies CSSProperties;

export const RAID_TRAY_SCROLL_STYLE = {
  display: 'flex',
  gap: 6,
  alignItems: 'flex-end',
  overflowX: 'auto',
  overflowY: 'hidden',
  overscrollBehaviorX: 'contain',
  touchAction: 'pan-x',
  WebkitOverflowScrolling: 'touch',
  paddingBottom: 2,
} satisfies CSSProperties;

export function RaidHudInputBoundary({ children }: { children: ReactNode }): React.JSX.Element {
  return <div {...RAID_HUD_INPUT_PROPS} style={RAID_HUD_BOUNDARY_STYLE}>{children}</div>;
}

/** Stamp the snapshot's hero levels onto local-sim orders. The server stamps
 *  its own copy authoritatively (raids.ts); this only keeps the LOCAL playback
 *  in step, so the fight the player watches is the fight that gets resolved. */
function withHeroLevels(
  heroes: Array<{ hero: 'vex' | 'theodor'; tx: number; ty: number; tMs: number }>,
  levels: Record<string, number> | undefined,
  loadouts?: Partial<Record<HeroKey, HeroCombatLoadout>>,
): Array<{ hero: 'vex' | 'theodor'; tx: number; ty: number; tMs: number; level: number; loadout?: HeroCombatLoadout }> {
  return heroes.map((h) => ({ ...h, level: levels?.[h.hero] ?? 1,
    ...(loadouts?.[h.hero] ? { loadout: loadouts[h.hero] } : {}),
  }));
}

const toast = (msg: string): void => bus.emit('ui:toast', { msg });

interface SnapBuilding { type: string; tx: number; ty: number }

/** Occupancy is frozen, including traps and buildings destroyed later. */
function occupiedTiles(buildings: SnapBuilding[], geometryVersion?: number): Set<string> {
  return occupiedBattlefieldTiles(buildings.map((b) => {
    const [fw, fh] = footprintOf(b.type, geometryVersion);
    return { ...b, fw, fh };
  }));
}

/**
 * Forgiving deployment (owner 2026-08-15, M23 a1: "too fragile … especially
 * for big bases"). A hidden or invalid tap snaps to the nearest visible VALID
 * tile within one tile of the pointer — at a maxed 26-claim framing a tile is
 * ~15 screen px, far under any finger. Only tiles passing deployValid may be
 * selected, so the sim never sees an invalid deploy and replay parity is
 * untouched. Ties break deterministically (distance, then ty, tx).
 */
function snapToDeployable(
  tx: number, ty: number, fx: number | undefined, fy: number | undefined,
  occupied: Set<string>, context: BattlefieldContext,
  isVisible?: (destination: { tx: number; ty: number }) => boolean,
): { tx: number; ty: number } | null {
  if (isBattlefieldTileDeployable(tx, ty, context, occupied) && (!isVisible || isVisible({ tx, ty }))) return { tx, ty };
  const px = fx ?? tx + 0.5;
  const py = fy ?? ty + 0.5;
  let best: { tx: number; ty: number } | null = null;
  let bestD = Infinity;
  for (let dy = -RAID_BATTLEFIELD.snapRadiusTiles; dy <= RAID_BATTLEFIELD.snapRadiusTiles; dy++) {
    for (let dx = -RAID_BATTLEFIELD.snapRadiusTiles; dx <= RAID_BATTLEFIELD.snapRadiusTiles; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = tx + dx;
      const ny = ty + dy;
      if (!isBattlefieldTileDeployable(nx, ny, context, occupied)) continue;
      if (isVisible && !isVisible({ tx: nx, ty: ny })) continue;
      const d = (nx + 0.5 - px) ** 2 + (ny + 0.5 - py) ** 2;
      if (d < bestD - 1e-9
        || (Math.abs(d - bestD) <= 1e-9 && best !== null && (ny < best.ty || (ny === best.ty && nx < best.tx)))) {
        best = { tx: nx, ty: ny };
        bestD = d;
      }
    }
  }
  return best;
}

/** Phaser supplies the destinations visible in the playable canvas.
 * Synthetic/legacy emitters omit the list and retain their prior behavior. */
export function snappedDeployIsVisible(
  destination: { tx: number; ty: number },
  visibleTiles?: readonly string[],
  previewVisible?: (
    destination: { tx: number; ty: number }, troop: string, hero?: 'vex' | 'theodor',
  ) => boolean,
  troop?: string,
  hero?: 'vex' | 'theodor',
): boolean {
  if (previewVisible && troop) return previewVisible(destination, troop, hero);
  return !visibleTiles || visibleTiles.includes(`${destination.tx},${destination.ty}`);
}

/** Buff pill metadata (App L922–924 copy/icons; costs from BUFFS constants). */
const BUFF_DEFS = [
  { key: 'warhorn', label: 'WAR HORN', icon: 'warhorn', cost: BUFFS.warhorn.costKeep, toast: 'WAR HORN: +15% DAMAGE THIS RAID' },
  { key: 'swiftboots', label: 'SWIFT BOOTS', icon: 'swiftboots', cost: BUFFS.swiftboots.costKeep, toast: 'SWIFT BOOTS: +20% SPEED THIS RAID' },
  { key: 'powdercharge', label: 'POWDER CHARGE', icon: 'powdercharge', cost: BUFFS.powdercharge.costKeep, toast: 'POWDER CHARGE: +60% VS WALLS' },
] as const;
type BuffKey = (typeof BUFF_DEFS)[number]['key'];

interface LiveCommandSession {
  raidId: string;
  accepted: Map<number, LiveCommand>;
  hydrated: boolean;
  queue: Promise<void>;
  pendingTroops: Record<string, number>;
  pendingHeroes: Set<string>;
  pendingBuffs: Set<BuffKey>;
  pendingRally: boolean;
  markedSequences: Set<number>;
  localMarkedCommandIds: Set<string>;
}

function newLiveCommandSession(raidId: string): LiveCommandSession {
  return {
    raidId,
    accepted: new Map(),
    hydrated: false,
    queue: Promise.resolve(),
    pendingTroops: {},
    pendingHeroes: new Set(),
    pendingBuffs: new Set(),
    pendingRally: false,
    markedSequences: new Set(),
    localMarkedCommandIds: new Set(),
  };
}

/** A transport failure or 5xx may arrive after the server committed the write.
 * Client/input 4xx responses (especially 422) are definite rejections. */
function potentiallyCommittedLiveCommand(cause: unknown): boolean {
  return cause instanceof ApiError && (cause.status === 0 || cause.status >= 500);
}

async function readCanonicalLiveCommands(raidId: string, afterSequence = -1): Promise<{
  commands: Map<number, LiveCommand>; view: LiveRaidView;
}> {
  const commands = new Map<number, LiveCommand>();
  let view: LiveRaidView;
  do {
    view = await api.get<LiveRaidView>(liveRaidPath(raidId, afterSequence));
    for (const command of view.commands) commands.set(command.sequence, command);
    const last = view.commands.at(-1)?.sequence;
    if (last !== undefined) afterSequence = last;
  } while (view.hasMore);
  return { commands, view: view! };
}

/** Live HUD progress derived from the resolved event log during playback.
 *  NOTE: destruction % is NOT in here — it comes from BattleScene's own HP
 *  ledger via 'battle:progress' (see livePct below). */
interface Progress { stars: number; loot: number; keep: number; tick: number }
const ZERO_PROGRESS: Progress = { stars: 0, loot: 0, keep: 0, tick: 0 };
interface ProgressPlan {
  events: Array<{ t: number; e: string; n?: number }>;
  final: RaidResult;
}
interface ReplayClock {
  anchorSimMs: number;
  receivedAtMs: number;
  rate: 1 | 2;
  durationMs: number;
}

/** Every RaidUI branch lives below the same native-event boundary. Keeping the
 * wrapper outside the hook-heavy content makes that guarantee structural: a new
 * loading/result branch cannot accidentally bypass the canvas input guard. */
export function RaidUI(): React.JSX.Element {
  return (
    <RaidHudInputBoundary>
      <RaidUIContent />
    </RaidHudInputBoundary>
  );
}

function RaidUIContent(): React.JSX.Element | null {
  const requestCommand = useUserCommand();
  const safeArea = useSafeAreaInsets();
  const viewport = useWindowSize();
  const deployLayout = raidDeployLayout(viewport.w, viewport.h);
  const screen = useApp((s) => s.screen);
  const setScreen = useApp((s) => s.setScreen);
  const raidTarget = useApp((s) => s.raidTarget);
  const baseDirectory = useApp((s) => s.baseDirectory);
  const homeBase = useApp((s) => s.base);
  const onboardingRaid = useApp((s) => s.onboardingStepCode === 'first_raid');
  const wallet = useApp((s) => s.wallet);
  const selectedBaseId = useApp((s) => s.selectedBaseId);
  const keepLevel = useApp((s) => s.base?.player.keepLevel ?? 0);
  const [raid, setRaid] = useState<RaidDto | null>(null);
  const [liveClock, setLiveClock] = useState<LiveRaidClock | null>(null);
  const liveClockRef = useRef<LiveRaidClock | null>(null);
  const liveClockReceivedAtRef = useRef(Date.now());
  const [clockNowMs, setClockNowMs] = useState(Date.now);
  const [speedPending, setSpeedPending] = useState<{
    clientCommandId: string; expectedClockRevision: number; rate: 1 | 2;
  } | null>(null);
  const speedPendingRef = useRef<typeof speedPending>(null);
  const [replayRate, setReplayRate] = useState<1 | 2>(1);
  const [retreatConfirm, setRetreatConfirm] = useState(false);
  const [retreating, setRetreating] = useState(false);
  const retreatingRef = useRef(false);
  const [nextTargetConfirm, setNextTargetConfirm] = useState(false);
  // An uncertain retreat cannot unlock deployments or turn a retry into a new raid.
  const nextTargetIntentRef = useRef(false);
  const createRequestRef = useRef<{
    target: RaidTarget | null; attackerBaseId: string | undefined;
    request: ReturnType<typeof raidCreateRequest>;
  } | null>(null);
  const retreatAttemptRef = useRef<{
    timedOut: boolean;
    timer: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  const [phase, setPhase] = useState<Phase>('deploying');
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [troop, setTroop] = useState<string>('highlander');
  const [used, setUsed] = useState<Record<string, number>>({});
  /** D-106: the current stream ended (every deployed troop is dead) but the
   *  tray still holds reserves and the clock has time left — the field sits
   *  OPEN, waiting for the next batch. Mirrored on a ref for timers/handlers. */
  const [fightOpen, setFightOpenState] = useState(false);
  const fightOpenRef = useRef(false);
  const setFightOpen = (open: boolean): void => {
    fightOpenRef.current = open;
    setFightOpenState(open);
  };
  /** A live raid keeps its optimistic reservations on the session ref (the
   *  command queue owns them across renders), so a tap changes no React state
   *  by itself. Bump this whenever a reservation is taken or released: the tray
   *  count must drop AT the tap, or a slow round-trip lets a player re-tap a
   *  unit that is already queued and watch three land where one was meant. */
  const [, bumpPending] = useReducer((revision: number) => revision + 1, 0);
  const [orders, setOrders] = useState<Array<{ troop: string; tx: number; ty: number; tMs: number }>>([]);
  /** D4a hero drops — a parallel channel to troop orders (ONE drop per distinct
   *  hero; the tray sources them from armySnapshot.heroes). Selected via the
   *  'hero:<key>' sentinel in the `troop` state. They count as deploys
   *  everywhere: marker, ATTACK gate, auto-commit and the resolve POST. */
  const [heroOrders, setHeroOrders] = useState<Array<{ hero: 'vex' | 'theodor'; tx: number; ty: number; tMs: number }>>([]);
  const [buffs, setBuffs] = useState<Record<BuffKey, boolean>>({ warhorn: false, swiftboots: false, powdercharge: false });
  const [rallyAt, setRallyAt] = useState<{ tx: number; ty: number } | null>(null);
  const [result, setResult] = useState<RaidResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [liveSyncUnavailable, setLiveSyncUnavailable] = useState(false);
  // Out-of-energy gate (ECONOMY.md §4): createRaid returns 422 when the player
  // has no free/purchased raid-energy left → surface a BUY ENERGY · SOL action.
  const [outOfEnergy, setOutOfEnergy] = useState(false);
  /**
   * The auto-match found nobody (`POST /raids` 404) — and WHICH POOL was empty,
   * because there are two and they need different exits (see raidNoTargets.tsx).
   * The panel that surfaces this used to offer BACK TO BASE and nothing else,
   * while the server's own message told the player to "try the world map or PvE" —
   * a dialog naming two places it refused to go. It now routes:
   *   'ladder'   (landowner) → WORLD MAP · CAMPAIGN — unchanged, to the byte;
   *   'deedless' (no land)   → CAMPAIGN · BUY LAND, since a landless keep has no
   *                            map row to pick from and PvE bounties are `owned`.
   */
  const [noTargets, setNoTargets] = useState<NoTargetsPool | null>(null);
  const [buying, setBuying] = useState(false);
  const { purchase: solPurchase, phase: buyPhase, error: buyError } = useSolPurchase();
  const [retry, setRetry] = useState(0);
  const [rewatching, setRewatching] = useState(false);
  const [progress, setProgress] = useState<Progress>(ZERO_PROGRESS);
  /** Live destruction % straight from BattleScene's HP ledger (bus
   *  'battle:progress'). The HUD used to derive this by counting `destroyed`
   *  events — but the sim's destructionPct is HP-WEIGHTED and accumulates on
   *  damage over non-wall/non-trap buildings, so three flattened walls moved the
   *  bar as much as the Keep and chip damage moved it not at all. The server's
   *  resolved destructionPct still pins the final number below. */
  const [livePct, setLivePct] = useState(0);
  /** D-099: BattleScene is repaying a hidden-tab pause at 8× (bus
   *  'battle:catchup') — the HUD's CATCHING UP… pill. Scene-owned; cleared
   *  with the battle on battle:done and exit so a pill never outlives a fight. */
  const [catchingUp, setCatchingUp] = useState(false);
  const [simulationPending, setSimulationPending] = useState(false);
  const [simulationFailed, setSimulationFailed] = useState(false);
  const simulationPendingRef = useRef(false);
  const simulationFailedRef = useRef(false);
  const simulationServiceRef = useRef<RaidSimulationService | null>(null);
  const simulationGeneration = useRef(0);
  const progressTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  /** D-096: the wall-clock commit timer (armWallClockCommit below). Kept apart
   *  from `progressTimers` because a mid-battle re-feed re-arms it for the new
   *  stream's end without re-ramping the HUD. */
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearWallClockCommit = (): void => {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = null;
  };
  const startProgressRef = useRef<(
    events: Array<{ t: number; e: string; n?: number }>, final: RaidResult, fromTick?: number,
  ) => void>(() => undefined);
  const progressPlanRef = useRef<ProgressPlan | null>(null);
  const progressPlayingRef = useRef(false);
  /** Latest `submit` for the auto-commit timer, which is armed above where submit
   *  is defined (and must not re-arm every time submit is re-created). */
  const submitRef = useRef<(() => void) | null>(null);
  /** commitRaid for the battle:done listener, which is registered once. Returns
   *  whether a resolve POST was actually issued (the listener waits for it). */
  const commitRaidRef = useRef<(() => boolean) | null>(null);
  /** Wall-clock ms at which the battle actually started, so a mid-battle deploy
   *  gets its REAL elapsed tMs (A3b). 0 while still in the pre-battle window. */
  const battleStartRef = useRef(0);
  /** Live order list + the raid, for the mid-battle tap handler. Refs because the
   *  handler is registered once and must not go stale between renders. */
  const ordersRef = useRef(orders);
  ordersRef.current = orders;
  const heroOrdersRef = useRef(heroOrders);
  heroOrdersRef.current = heroOrders;
  const raidRef = useRef(raid);
  raidRef.current = raid;
  /** The server result for the once-registered battle:done listener (D-096):
   *  the wall-clock commit may already hold it, or still be waiting on it. */
  const resultRef = useRef(result);
  resultRef.current = result;
  /** The buffs/rally COMMITTED at submit. A mid-battle re-sim must replay with the
   *  same modifiers or its stream diverges from the one the server will resolve. */
  const simModsRef = useRef<{ buffs?: unknown; rally?: unknown }>({});

  const isReplay = raidTarget?.kind === 'replay';
  const isLiveSpectator = raidTarget?.kind === 'live';
  const isSpectator = isReplay || isLiveSpectator;
  const spectatorRef = useRef(isLiveSpectator);
  spectatorRef.current = isLiveSpectator;
  const liveResolvedRef = useRef(false);
  const livePlaybackStartedAtRef = useRef(0);
  const replayRateRef = useRef<1 | 2>(1);
  const replayClockRef = useRef<ReplayClock>({
    anchorSimMs: 0, receivedAtMs: Date.now(), rate: 1, durationMs: 0,
  });
  const replayPlayingRef = useRef(false);
  const rewatchAttemptRef = useRef(0);
  const rewatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Only the reconstructed terminal field may acknowledge a cold result. */
  const terminalReplayReadyRef = useRef<{
    target: RaidTarget; guard: ReturnType<typeof captureBaseSnapshotGuard>;
  } | null>(null);
  const [replayPlaying, setReplayPlaying] = useState(false);
  /** Queue, canonical map and optimistic reservations are one raid-owned object.
   * Replacing the object fences every late promise/callback from the next raid. */
  const liveCommandSessionRef = useRef<LiveCommandSession | null>(null);
  const applyAcceptedBatchRef = useRef<(currentRaid: RaidDto, session: LiveCommandSession) => void>(() => undefined);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      progressTimers.current.forEach(clearTimeout); progressTimers.current = [];
      clearWallClockCommit();
      liveCommandSessionRef.current = null;
      rewatchAttemptRef.current++;
      if (rewatchTimerRef.current) clearTimeout(rewatchTimerRef.current);
      rewatchTimerRef.current = null;
      if (retreatAttemptRef.current?.timer) clearTimeout(retreatAttemptRef.current.timer);
      retreatAttemptRef.current = null;
    };
  }, []);
  const v2BatchModifiersQueuedRef = useRef(false);
  const adoptClock = useCallback((clock: LiveRaidClock): void => {
    if (!isNewerRaidClock(liveClockRef.current, clock)) return;
    const now = Date.now();
    liveClockRef.current = clock;
    liveClockReceivedAtRef.current = now;
    setLiveClock(clock);
    bus.emit('battle:rate', { rate: clock.rate });
    const playheadMs = liveRaidPlayheadMs(clock, now, now);
    bus.emit('battle:playhead', { simMs: playheadMs });
    const plan = progressPlanRef.current;
    if (plan && progressPlayingRef.current && clock.anchorWallAt !== null
      && !simulationPendingRef.current && !simulationFailedRef.current) {
      startProgressRef.current(plan.events, plan.final, Math.floor(playheadMs / TICK_MS));
    }
  }, []);
  useEffect(() => {
    const liveRunning = liveClock?.anchorWallAt != null;
    if (phase === 'done' || (!liveRunning && !(isReplay && replayPlaying))) return;
    const timer = setInterval(() => setClockNowMs(Date.now()), 250);
    return () => clearInterval(timer);
  }, [isReplay, replayPlaying, liveClock?.anchorWallAt, phase]);
  const canonicalPlayheadMs = liveClock
    ? liveRaidPlayheadMs(liveClock, liveClockReceivedAtRef.current, clockNowMs)
    : null;
  const replayPlayheadMs = isReplay && replayPlayingRef.current
    ? playbackPlayheadMs(
      replayClockRef.current.anchorSimMs,
      replayClockRef.current.receivedAtMs,
      clockNowMs,
      replayClockRef.current.rate,
      replayClockRef.current.durationMs,
    )
    : null;
  const stableCommandCapability = baseSelectorAvailable(baseDirectory)
    && baseDirectory!.capabilities.baseScopedMutations;
  const liveCommandMode = stableCommandCapability
    && !!raid?.attackerBaseId && !!raid.defenderBaseId
    && !raid.pveCampId && !raid.campaignStage;
  const liveCommandModeRef = useRef(liveCommandMode);
  liveCommandModeRef.current = liveCommandMode;
  /** D-099 batch journal: a PvE/campaign/legacy raid whose server journals each
   *  order as it is placed and settles the raid itself at the deadline when this
   *  client never posts FINISH. The optimistic local sim stays the view; the
   *  journal is the server's copy of it. Absent on old APIs and pre-rollout
   *  pending rows, which keep the whole-list /orders POST. */
  const batchJournalMode = !liveCommandMode && !isSpectator
    && raid?.armySnapshot.features?.batchCommandJournal === true;
  const batchJournalModeRef = useRef(batchJournalMode);
  batchJournalModeRef.current = batchJournalMode;
  const rallyUnlocked = keepLevel >= RALLY.unlockKeepLevel;
  /** Heroes are FIRST-CLASS deploys: they arm ATTACK, the auto-commit timer and
   *  the end-of-battle POST exactly like troops. Keyed only on `orders.length`,
   *  a hero-only assault could not be launched at all (owner 2026-07-28). */
  const deployCount = orders.length + heroOrders.length;
  const unavailableHomeHeroes = isSpectator ? [] : unavailableFrozenHeroes(raid, homeBase);
  /** D-106 reserve arithmetic: any deployable troop card still above zero, or
   *  a recruited hero not yet dropped. Counted from the order lists (updated
   *  synchronously by every drop), never from render-time state. */
  const reservesRemain = (): boolean => {
    const r = raidRef.current;
    if (!r) return false;
    const placed: Record<string, number> = {};
    for (const order of ordersRef.current) placed[order.troop] = (placed[order.troop] ?? 0) + 1;
    if (raidDeployTrayTroops(r.armySnapshot).some((t) =>
      (r.armySnapshot.counts[t] ?? 0) - (placed[t] ?? 0) > 0)) return true;
    return (r.armySnapshot.heroes ?? []).some((h) => !heroOrdersRef.current.some((o) => o.hero === h));
  };
  /** Stamped on every attacker stream fed to the scene: with reserves in the
   *  tray the scene keeps its field clock running past this stream's end. */
  const fightOpenFlag = (): { fightOpen: true } | Record<string, never> =>
    !spectatorRef.current && reservesRemain() ? { fightOpen: true } : {};
  /**
   * D-106 (ferdblabla 2026-09-04: "after i put some troops and start, when
   * those troops died it immediate end the raid"). The sim only knows the
   * deploys it was given, so its end is the end of THIS batch, not of the
   * fight. A batch fight is still OPEN when its stream ends if (a) reserves
   * remain in the tray, (b) the battle clock has not run out and (c) the base
   * is not already at 100 %. V2 has its own clock-due guard; spectators,
   * replays and settled raids never hold the field.
   */
  const batchFightStillOpen = (): boolean => {
    const r = raidRef.current;
    if (!r || r.raidProtocolVersion === 2 || spectatorRef.current || resultRef.current) return false;
    if (battleStartRef.current === 0) return false;
    if (Date.now() - battleStartRef.current >= BATTLE_CLOCK_MS) return false;
    if ((progressPlanRef.current?.final.destructionPct ?? 0) >= 100) return false;
    return reservesRemain();
  };
  // A complete local stream is only a reason to ask FINISH. The server proves
  // destruction from accepted commands at its own clock before closing it.
  const canRequestEarlyVictory = (): boolean => {
    const plan = progressPlanRef.current;
    const clock = liveClockRef.current;
    if (!plan || plan.final.destructionPct !== 100 || !clock?.anchorWallAt) return false;
    const endMs = (plan.events.at(-1)?.t ?? 0) * TICK_MS;
    return liveRaidPlayheadMs(clock, liveClockReceivedAtRef.current, Date.now()) >= endMs;
  };
  /** End of the pre-battle DEPLOY window. The nested frozen feature is an
   *  additive rolling capability: old web ignores it; new web fails safely when
   *  talking to an old API or resuming a pre-rollout pending row. */
  const batchOrdersGraceSec = raid?.armySnapshot.features?.batchOrdersGraceSec;
  const deployEndsAtMs = raid
    ? liveCommandMode
      ? liveDeployEndsAtMs(raid.ordersDeadlineAt)
      : batchDeployEndsAtMs(raid.ordersDeadlineAt, batchOrdersGraceSec)
    : 0;
  const batchAutoSubmitAt = raid
    ? batchAutoSubmitAtMs(raid.ordersDeadlineAt, batchOrdersGraceSec)
    : 0;

  const persistRaidPointer = useCallback((currentRaid: RaidDto, nextPhase: Phase,
    clock = liveClock, inFlight = speedPendingRef.current
      ?? (useApp.getState().raidTarget?.raidId === currentRaid.id
        ? useApp.getState().raidTarget?.inFlightSpeed ?? null : null)): void => {
    const baseId = currentRaid.attackerBaseId ?? homeBase?.baseId;
    const storage = browserRaidResumeStorage();
    if (!storage || !wallet || !baseId || isReplay) return;
    writeRaidResumePointer(storage, {
      version: 1, wallet, baseId, raidId: currentRaid.id,
      mode: isLiveSpectator ? 'live'
        : currentRaid.campaignStage ? 'campaign'
          : currentRaid.pveCampId ? 'pve' : 'pvp',
      role: isLiveSpectator ? 'defender' : 'attacker',
      phase: resumePhase(nextPhase),
      target: {
        ...(currentRaid.defenderBaseId ? { defenderBaseId: currentRaid.defenderBaseId } : {}),
        ...(currentRaid.pveCampId ? { campId: currentRaid.pveCampId } : {}),
        ...(currentRaid.campaignStage ? { stage: currentRaid.campaignStage } : {}),
      },
      clock: clock ? { revision: clock.revision, rate: clock.rate } : null,
      inFlightSpeed: inFlight,
    });
  }, [homeBase?.baseId, isLiveSpectator, isReplay, liveClock, speedPending, wallet]);

  useEffect(() => {
    if (raid) persistRaidPointer(raid, phase);
  }, [raid, phase, liveClock, speedPending, persistRaidPointer]);

  // R5: building-footprint occupancy from the frozen raid snapshot, so a deploy
  // tap is rejected only on tiles a building actually covers (matches the sim).
  const occupied = useMemo(() => {
    const snapshot = raid?.snapshot as { buildings?: SnapBuilding[]; geometryVersion?: number } | null;
    return occupiedTiles(snapshot?.buildings ?? [], snapshot?.geometryVersion);
  }, [raid]);

  // The frozen snapshot chooses deployment semantics, not the installed client.
  const battlefield = useMemo(() =>
    (raid?.snapshot as BattlefieldContext | null) ?? {}, [raid]);
  // Rally keeps its original centered-claim target and 30×30 target bounds.
  const claim = useMemo(() => {
    const min = battlefield.claimMin ?? GRID.deployRingTiles;
    return { min, max: battlefield.claimMax ?? min + GRID.claimTiles };
  }, [battlefield]);

  useEffect(() => {
    simulationPendingRef.current = false; simulationFailedRef.current = false;
    setSimulationPending(false); setSimulationFailed(false);
    return () => {
      simulationGeneration.current++;
      simulationServiceRef.current?.dispose(); simulationServiceRef.current = null;
      simulationPendingRef.current = false; simulationFailedRef.current = false;
    };
  }, [screen, raid?.id, raidTarget?.raidId, raidTarget?.recoveryEpoch, selectedBaseId, wallet]);

  const cancelPresentation = useCallback((): void => {
    simulationGeneration.current++;
    simulationServiceRef.current?.dispose(); simulationServiceRef.current = null;
    simulationPendingRef.current = false; simulationFailedRef.current = false;
    setSimulationPending(false); setSimulationFailed(false);
  }, []);

  const simulatePresentation = useCallback(async (
    input: RaidSimulationInput, currentRaidId: string,
  ) => {
    // A failed worker requires explicit reload. New polling must not clear the
    // recovery panel or silently retry a permanently failed worker instance.
    if (simulationFailedRef.current) return null;
    const guard = captureBaseSnapshotGuard();
    const generation = ++simulationGeneration.current;
    const current = (): boolean => mountedRef.current && generation === simulationGeneration.current
      && isBaseSnapshotGuardCurrent(guard) && useApp.getState().screen === 'battle'
      && (raidRef.current?.id ?? useApp.getState().raidTarget?.raidId) === currentRaidId
      && phaseRef.current !== 'done' && !(committedRef.current && resultRef.current);
    simulationServiceRef.current ??= new RaidSimulationService();
    simulationPendingRef.current = true; setSimulationPending(true); setSimulationFailed(false); simulationFailedRef.current = false;
    clearWallClockCommit();
    try {
      const outcome = await simulationServiceRef.current.simulate(input);
      return outcome && current() ? { outcome, current, healthContext: battleHealthContext(input.orders) } : null;
    } catch {
      if (current()) {
        simulationFailedRef.current = true; setSimulationFailed(true);
        setErr('BATTLE DISPLAY UNAVAILABLE — RELOAD GAME');
      }
      return null;
    } finally {
      if (generation === simulationGeneration.current) {
        simulationPendingRef.current = false;
        if (mountedRef.current) setSimulationPending(false);
      }
    }
  }, []);

  const applyAcceptedLiveCommands = useCallback(async (
    currentRaid: RaidDto, session: LiveCommandSession,
  ): Promise<void> => {
    const guard = captureBaseSnapshotGuard();
    const isCurrent = (): boolean => mountedRef.current && liveCommandSessionRef.current === session
      && raidRef.current?.id === currentRaid.id && isBaseSnapshotGuardCurrent(guard)
      && useApp.getState().screen === 'battle' && phaseRef.current !== 'done'
      && !(committedRef.current && resultRef.current);
    if (!isCurrent()) return;
    const hydrated = hydrateLiveOrders(
      [...session.accepted.values()], currentRaid.armySnapshot.heroLevels ?? {}, currentRaid.armySnapshot.heroLoadouts,
    );
    const nextOrders = hydrated.deploys.map((order) => ({ ...order, troop: String(order.troop) }));
    const nextHeroes = hydrated.heroDeploys.map(({ level: _level, ...order }) => order);
    const nextUsed: Record<string, number> = {};
    for (const order of nextOrders) nextUsed[order.troop] = (nextUsed[order.troop] ?? 0) + 1;
    const nextBuffs = {
      warhorn: hydrated.buffs?.warhorn === true,
      swiftboots: hydrated.buffs?.swiftboots === true,
      powdercharge: hydrated.buffs?.powdercharge === true,
    };
    ordersRef.current = nextOrders;
    heroOrdersRef.current = nextHeroes;
    setOrders(nextOrders);
    setHeroOrders(nextHeroes);
    setUsed(nextUsed);
    setBuffs(nextBuffs);
    setRallyAt(hydrated.rally ? { tx: hydrated.rally.tx, ty: hydrated.rally.ty } : null);
    simModsRef.current = {
      ...(hydrated.buffs ? { buffs: hydrated.buffs } : {}),
      ...(hydrated.rally ? { rally: hydrated.rally } : {}),
    };
    if (nextOrders.length === 0 && nextHeroes.length === 0) {
      setPhase('deploying');
      return;
    }
    const presentation = await simulatePresentation({
      simVersion: currentRaid.simVersion,
      snapshot: currentRaid.snapshot as Parameters<typeof simulateRaid>[0],
      orders: hydrated as Parameters<typeof simulateRaid>[1], seed: currentRaid.seed,
      options: { troopLevels: currentRaid.armySnapshot.levels as never },
    }, currentRaid.id);
    if (!presentation?.current() || !isCurrent()) return;
    const sim = presentation.outcome;
    const canonicalClock = liveClockRef.current;
    const canonicalMs = canonicalClock
      ? liveRaidPlayheadMs(canonicalClock, liveClockReceivedAtRef.current, Date.now()) : null;
    const fromTick = canonicalMs !== null
      ? Math.floor(canonicalMs / TICK_MS)
      : battleStartRef.current > 0
        ? Math.floor((Date.now() - battleStartRef.current) / TICK_MS)
      : 0;
    if (battleStartRef.current === 0) {
      battleStartRef.current = Date.now() - (canonicalMs ?? 0) / (canonicalClock?.rate ?? 1);
    }
    setPhase('playing');
    startProgressRef.current(
      sim.events as unknown as Array<{ t: number; e: string; n?: number }>,
      {
        stars: sim.stars, destructionPct: sim.destructionPct,
        keepDestroyed: sim.keepDestroyed, lootShards: 0, attackerTrophyDelta: 0,
      },
      fromTick,
    );
    const publish = (): void => {
      if (!isCurrent() || !presentation.current()) return;
      bus.emit('battle:play', {
        ...presentation.healthContext,
        events: sim.events as unknown as Array<{ t: number; e: string; n?: number }>,
        fromTick, appliedPrefix: true, simVersion: currentRaid.simVersion,
        ...fightOpenFlag(),
      });
    };
    if (fromTick > 0) publish();
    else setTimeout(publish, 80);
  }, [simulatePresentation]);

  const queueLiveCommand = useCallback((
    currentRaid: RaidDto,
    command: Pick<LiveCommand, 'kind' | 'payload'>,
    onDone: (accepted: boolean, command?: LiveCommand) => void = () => undefined,
    hasLocalMarker = false,
  ): void => {
    const session = liveCommandSessionRef.current;
    if (!session || session.raidId !== currentRaid.id || raidRef.current?.id !== currentRaid.id) return;
    const request = liveRaidCommandRequest(currentRaid.id, idemKey(), command);
    if (hasLocalMarker) session.localMarkedCommandIds.add(request.body.clientCommandId);
    const isCurrentSession = (): boolean => mountedRef.current && liveCommandSessionRef.current === session
      && raidRef.current?.id === currentRaid.id
      && useApp.getState().screen === 'battle';
    session.queue = session.queue.catch(() => undefined).then(async () => {
      const send = (): Promise<{ command: LiveCommand; clock?: LiveRaidClock }> =>
        api.postRaw<LiveRaidControlReceipt>(request.path, request.body);
      try {
        let response: { command: LiveCommand; clock?: LiveRaidClock };
        try {
          response = await send();
        } catch (firstCause) {
          if (!potentiallyCommittedLiveCommand(firstCause)) throw firstCause;
          // An absent ID in one live read is not rejection: a request whose reply
          // failed may still be committing. Keep the card reserved and alternate
          // the exact same POST with canonical hydration until success, a matching
          // command, a definite 4xx, or this raid session is replaced.
          for (;;) {
            let definiteRetryFailure: unknown = null;
            try {
              response = await send();
              break;
            } catch (cause) {
              if (!potentiallyCommittedLiveCommand(cause)) definiteRetryFailure = cause;
            }
            if (!isCurrentSession()) return;
            session.hydrated = false;
            let canonicalReadSucceeded = false;
            try {
              const canonicalView = await readCanonicalLiveCommands(currentRaid.id);
              const canonical = canonicalView.commands;
              if (!isCurrentSession()) return;
              canonicalReadSucceeded = true;
              for (const [sequence, accepted] of canonical) session.accepted.set(sequence, accepted);
              const committed = [...canonical.values()].find(
                (accepted) => accepted.clientCommandId === request.body.clientCommandId,
              );
              if (committed) {
                session.hydrated = true;
                response = {
                  command: committed,
                  ...(canonicalView.view.clock ? { clock: canonicalView.view.clock } : {}),
                };
                break;
              }
            } catch {
              // The next identical send also doubles as recovery when /live is down.
            }
            // Once one reply was ambiguous, a later 4xx describes only that
            // retry. The original may already have committed before its reply
            // was lost, so release the card only after a successful canonical
            // read proves this exact client id is absent.
            if (definiteRetryFailure && canonicalReadSucceeded) throw definiteRetryFailure;
            if (!isCurrentSession()) return;
            // A batch journal (D-099) keeps fighting locally while it reconciles:
            // the worker settles from the journal either way, so nothing to
            // tell the player until a definite answer.
            if (liveCommandModeRef.current) setErr('COMMAND STATUS UNKNOWN — RECONNECTING');
            await new Promise((resolve) => setTimeout(resolve, LIVE_COMMAND_RECONCILE_MS));
            if (!isCurrentSession()) return;
          }
        }
        if (!isCurrentSession()) return;
        // A terminal response (success above or definite rejection caught below)
        // ends reconciliation and re-opens controls for this still-current raid.
        session.accepted.set(response.command.sequence, response.command);
        const hasAcceptedPrefix = (): boolean => {
          for (let sequence = 0; sequence <= response.command.sequence; sequence++) {
            if (!session.accepted.has(sequence)) return false;
          }
          return true;
        };
        // A second tab may have inserted controls or units since our last read.
        // A successful receipt proves this drop committed, but not that our
        // local map includes its predecessors. Keep it reserved until that
        // prefix is complete; never turn a failed GET into a rejected unit.
        while (!hasAcceptedPrefix()) {
          session.hydrated = false;
          setErr('RESTORING RAID COMMANDS — RECONNECTING');
          try {
            const canonical = await readCanonicalLiveCommands(currentRaid.id);
            if (!isCurrentSession()) return;
            for (const [sequence, command] of canonical.commands) {
              session.accepted.set(sequence, command);
            }
            if (canonical.view.clock) adoptClock(canonical.view.clock);
          } catch {
            // Already accepted: retry only the read, not a new deployment.
          }
          if (!isCurrentSession()) return;
          if (!hasAcceptedPrefix()) {
            await new Promise((resolve) => setTimeout(resolve, LIVE_COMMAND_RECONCILE_MS));
            if (!isCurrentSession()) return;
          }
        }
        session.hydrated = true;
        if (response.clock) adoptClock(response.clock);
        setErr(null);
        // Protocol 2 cannot know a drop's simulator offset until acceptance.
        // Only v1 retains its client-authored optimistic batch presentation.
        if (liveCommandModeRef.current) applyAcceptedLiveCommands(currentRaid, session);
        else if (batchJournalModeRef.current && currentRaid.raidProtocolVersion === 2) {
          applyAcceptedBatchRef.current(currentRaid, session);
        }
        onDone(true, response.command);
      } catch (cause) {
        if (!isCurrentSession()) return;
        session.hydrated = true;
        const message = cause instanceof Error ? cause.message.toUpperCase() : 'LIVE COMMAND REJECTED';
        if (liveCommandModeRef.current) {
          // Reconciliation may have learned canonical commands from another tab
          // before this exact ID received a definite 4xx. Render that server state
          // before releasing the pending card, or the rejection leaves stale counts.
          applyAcceptedLiveCommands(currentRaid, session);
          if (phaseRef.current === 'deploying') setErr(message);
          else {
            // A troop refusal is temporary feedback, not a failed settlement.
            // Clear only this command's reconciliation status: an independent
            // FINISH error still owns the resolving panel and retry controls.
            setErr(current => current === 'COMMAND STATUS UNKNOWN — RECONNECTING'
              || current === 'RESTORING RAID COMMANDS — RECONNECTING' ? null : current);
            toast(message);
          }
        } else if (batchJournalModeRef.current && currentRaid.raidProtocolVersion === 2) {
          applyAcceptedBatchRef.current(currentRaid, session);
          if (phaseRef.current === 'deploying') setErr(message);
          else {
            setErr(current => current === 'COMMAND STATUS UNKNOWN — RECONNECTING'
              || current === 'RESTORING RAID COMMANDS — RECONNECTING' ? null : current);
            toast(message);
          }
        } else {
          // The unit already fought locally; the server settles without it and
          // the verdict says so. A lingering inline error would masquerade as a
          // failed FINISH on the resolving panel, so this one is a toast.
          toast(message);
        }
        playSfx('sfx_error');
        onDone(false);
      }
    });
  }, [applyAcceptedLiveCommands, adoptClock]);

  // Shield-break consent (tester report 2026-09-16: "the attack begins
  // immediately and the shield is removed in the background"). The server
  // deletes the ATTACKER's deed shield on the first accepted PvP deploy
  // (liveRaids.ts / raids.ts, defenderWallet only — see shieldBreak.ts), so a
  // fresh PvP create waits here for PROCEED while the home base still holds
  // one. Campaign/PvE and resumed raids never gate. Reset whenever the battle
  // screen is left or a raid is entered, so every new raid asks anew.
  const [shieldAck, setShieldAck] = useState(false);
  useEffect(() => { if (screen !== 'battle' || raid) setShieldAck(false); }, [screen, raid]);
  const shieldAtStakeSec = raidBreaksShield(raidTarget) ? shieldBreakRemainingSec(homeBase?.shield, Date.now()) : null;
  const shieldGate = shieldAtStakeSec !== null && !shieldAck && !raid && !isSpectator;

  // start a raid when the screen flips to battle (saved/live participant
  // replays are hydrated by their own read-only flows)
  useEffect(() => {
    if (screen !== 'battle' || raid || isSpectator || shieldGate) return;
    const guard = captureBaseSnapshotGuard();
    let disposed = false;
    const current = (): boolean => !disposed && mountedRef.current
      && isBaseSnapshotGuardCurrent(guard) && useApp.getState().screen === 'battle'
      && useApp.getState().raidTarget === raidTarget;
    const cleanup = (): void => { disposed = true; };
    const enterRaid = (r: RaidDto): void => {
      if (!current()) return;
      // Rotate even when a resumed raid happens to have the same id. Session
      // identity, not string equality, owns every async command callback.
      liveCommandSessionRef.current = newLiveCommandSession(r.id);
      progressPlanRef.current = null;
      progressPlayingRef.current = false;
      liveClockRef.current = null;
      if (r.live?.clock) adoptClock(r.live.clock);
      else {
        setLiveClock(null);
        bus.emit('battle:rate', { rate: 1 });
      }
      persistRaidPointer(r, 'deploying', r.live?.clock ?? null, raidTarget?.inFlightSpeed ?? null);
      setRaid(r);
      bus.emit('battle:enter', {
        snapshot: r.snapshot,
        visualContext: r.visualContext, boundCosmeticVisual: r.boundCosmeticVisual,
        servicePresentation: r.servicePresentation, advancedServicePresentation: r.advancedServicePresentation,
        armyLevels: r.armySnapshot.levels,
        armyCounts: r.armySnapshot.counts,
        heroLevels: r.armySnapshot.heroLevels,
      });
    };
    // The Raid Log's CONTINUE action carries only the immutable raid id in
    // navigation state. Re-read the server-owned payload rather than caching a
    // large snapshot in Zustand, then enter it without issuing another create.
    if (raidTarget?.raidId) {
      void api.get<{ raid: RaidDto | null }>(`/raids/pending/${encodeURIComponent(raidTarget.raidId)}`)
        .then(({ raid: pendingRow }) => {
          if (!current()) return;
          const pending = pendingRow ? resumableRaidById([pendingRow], raidTarget.raidId!) : null;
          if (!pending) { setErr('THIS RAID IS NO LONGER AVAILABLE'); return; }
          enterRaid(pending);
          useApp.getState().setRaidTarget({
            ...targetForResumedRaid(pending),
            ...(raidTarget.inFlightSpeed ? { inFlightSpeed: raidTarget.inFlightSpeed } : {}),
          });
        })
        .catch((error: Error) => { if (current()) setErr(error.message); });
      return cleanup;
    }
    const create = (): Promise<{ raid: RaidDto }> => {
      // Device preference is accepted only after GET /bases confirms ownership
      // (store.ts/bases.tsx). Freeze it once for this create request so switching
      // the selector on another screen cannot retarget an in-flight raid.
      const attackerBaseId = useApp.getState().selectedBaseId ?? undefined;
      if (!createRequestRef.current || createRequestRef.current.target !== raidTarget
        || createRequestRef.current.attackerBaseId !== attackerBaseId) {
        createRequestRef.current = {
          target: raidTarget, attackerBaseId,
          request: raidCreateRequest(raidTarget, attackerBaseId, idemKey()),
        };
      }
      return createRaidWithProtocolFallback<{ raid: RaidDto }>(createRequestRef.current.request);
    };
    void create()
      .then(({ raid: r }) => enterRaid(r))
      .catch((e: Error) => {
        if (!current()) return;
        // LAND GATE (402 LAND_NOT_OWNED): a deedless player reached a raid the
        // server will not start — a chosen map target, or a PvE bounty. The global
        // api handler has already raised the buy-land sheet, so the battle screen
        // must get OUT OF ITS WAY rather than stack a full-screen
        // "entry payment required" panel underneath it. Nothing was created, so
        // there is no raid to tear down — just drop the target and go home.
        if (isLandNotOwned(e)) {
          useApp.getState().setRaidTarget(null);
          setScreen('base');
          return;
        }
        // A reload or an intentional trip back to base can lose the create
        // response while the server correctly keeps heroes reserved to that
        // exact unresolved march. Starting a sibling raid must stay forbidden,
        // but showing a dead-end conflict (the owner's screenshot) is not a
        // recovery flow. Fetch the attacker's frozen pending payload and resume
        // it in place; no new energy, ante, raid row, or hero reservation is
        // created. The Raid Log exposes the same source if this fetch fails.
        if (e instanceof ApiError && e.code === 'HERO_ALREADY_COMMITTED') {
          void api.get<{ raids: RaidDto[] }>('/raids/pending')
            .then(({ raids }) => {
              if (!current()) return;
              const pending = resumableCommittedRaid(e, raids);
              if (!pending) { setErr(e.message); return; }
              enterRaid(pending);
              useApp.getState().setRaidTarget(targetForResumedRaid(pending));
              setErr(null);
              toast('RETURNED TO YOUR UNFINISHED RAID');
            })
            .catch(() => { if (current()) setErr(e.message); });
          return;
        }
        // Out of raid-energy (raids.ts createRaid 422) → offer to buy 1 with SOL,
        // then retry. Daily-cap 422s do NOT match, so no buy is offered there.
        if (e instanceof ApiError && e.status === 422 && /out of raid energy/i.test(e.message)) setOutOfEnergy(true);
        // Empty matchmaking pool → route by WHICH pool. The classification (code
        // first, message only as an older-build fallback) lives in raidNoTargets so
        // it is testable without a DOM; matching it HERE by string is what let the
        // deedless code fall through to the dead-end panel.
        const pool = noTargetsPool(e);
        if (pool) setNoTargets(pool);
        setErr(e.message);
      });
    return cleanup;
  }, [screen, raid, isSpectator, raidTarget, retry, adoptClock, persistRaidPointer, shieldGate]);

  // A lost create/command response can reload into an already-started stable
  // PvP raid. Re-read every accepted canonical command before accepting more;
  // local markers/counts are rebuilt only from what the server confirms.
  useEffect(() => {
    if (screen !== 'battle' || !raid || !liveCommandMode) return;
    let disposed = false;
    const session = liveCommandSessionRef.current;
    if (!session || session.raidId !== raid.id) return;
    session.hydrated = false;
    battleStartRef.current = 0;
    const hydrate = async (): Promise<void> => {
      const canonicalRead = await readCanonicalLiveCommands(raid.id);
      const canonical = canonicalRead.commands;
      if (disposed || liveCommandSessionRef.current !== session || raidRef.current?.id !== raid.id) return;
      if (canonicalRead.view.clock) adoptClock(canonicalRead.view.clock);
      for (const [sequence, command] of canonical) session.accepted.set(sequence, command);
      session.hydrated = true;
      applyAcceptedLiveCommands(raid, session);
    };
    void hydrate().catch((cause: Error) => {
      if (!disposed && liveCommandSessionRef.current === session && raidRef.current?.id === raid.id) {
        setErr(cause.message.toUpperCase());
      }
    });
    return () => { disposed = true; };
  }, [screen, raid?.id, liveCommandMode, applyAcceptedLiveCommands,
    raidTarget?.recoveryEpoch, adoptClock]);

  /** D-099 v1 reloads from its journal; M34 v2 also uses it on every accepted
   * command. A v2 drop has no simulator timestamp until the server accepts it,
   * so no ORDER (and so no combat) may be synthesized from an in-flight tap.
   * The tap's pending marker is presentation only: the tap handler places it
   * and the accepted event or a rejection settles it, never this journal. */
  const applyBatchJournal = useCallback(async (
    currentRaid: RaidDto, session: LiveCommandSession,
  ): Promise<void> => {
    const guard = captureBaseSnapshotGuard();
    const isCurrent = (): boolean => mountedRef.current && liveCommandSessionRef.current === session
      && raidRef.current?.id === currentRaid.id && isBaseSnapshotGuardCurrent(guard)
      && useApp.getState().screen === 'battle' && phaseRef.current !== 'done'
      && !(committedRef.current && resultRef.current);
    if (!isCurrent()) return;
    const commands = [...session.accepted.values()];
    // The server sequence did not exist at tap time. Adopt the exact durable
    // command marker, including poll-first/lost-ack replies; same-cell units stay distinct.
    for (const command of commands) {
      if (session.localMarkedCommandIds.has(command.clientCommandId)) session.markedSequences.add(command.sequence);
    }
    const hydrated = hydrateLiveOrders(commands, currentRaid.armySnapshot.heroLevels ?? {}, currentRaid.armySnapshot.heroLoadouts);
    const nextOrders = hydrated.deploys.map((order) => ({ ...order, troop: String(order.troop) }));
    const nextHeroes = hydrated.heroDeploys.map(({ level: _level, ...order }) => order);
    // A staged buff is durable even before the first unit. Restore it without
    // treating that purchase as proof the battle started.
    setBuffs({
      warhorn: hydrated.buffs?.warhorn === true,
      swiftboots: hydrated.buffs?.swiftboots === true,
      powdercharge: hydrated.buffs?.powdercharge === true,
    });
    setRallyAt(hydrated.rally ? { tx: hydrated.rally.tx, ty: hydrated.rally.ty } : null);
    simModsRef.current = {
      ...(hydrated.buffs ? { buffs: hydrated.buffs } : {}),
      ...(hydrated.rally ? { rally: hydrated.rally } : {}),
    };
    if (nextOrders.length === 0 && nextHeroes.length === 0) return;
    const nextUsed: Record<string, number> = {};
    for (const order of nextOrders) nextUsed[order.troop] = (nextUsed[order.troop] ?? 0) + 1;
    ordersRef.current = nextOrders;
    heroOrdersRef.current = nextHeroes;
    setOrders(nextOrders);
    setHeroOrders(nextHeroes);
    setUsed(nextUsed);
    // Rally is journaled by ATTACK and a mid-battle reserve carries a positive
    // offset: either proves the fight had started. Nothing but t=0
    // drops means the reload landed inside the deploy window — put the markers
    // back and let that window (or its auto-start) carry on as before.
    const offsetOf = (command: LiveCommand): number =>
      ('tMs' in command.payload ? command.payload.tMs : undefined) ?? command.serverOffsetMs;
    const canonicalClock = currentRaid.raidProtocolVersion === 2
      ? liveClockRef.current : null;
    // Old v1 clients journaled buffs at ATTACK, after the t=0 drops. Those
    // historical rows remain start evidence; a new pre-unit buff is not.
    const legacyAttackBuff = commands.some((command) => command.kind === 'buff'
      && commands.some((prior) => (prior.kind === 'deploy' || prior.kind === 'hero')
        && prior.sequence < command.sequence));
    const started = canonicalClock
      ? canonicalClock.anchorWallAt !== null
      : legacyAttackBuff || commands.some((command) => command.kind === 'rally' || offsetOf(command) > 0);
    if (!started) {
      // Same 80ms beat as a fresh raid: the scene must finish building the
      // board before anything lands on it.
      setTimeout(() => {
        if (!isCurrent() || phaseRef.current !== 'deploying'
          || (currentRaid.raidProtocolVersion === 2 && liveClockRef.current?.anchorWallAt != null)) return;
        for (const command of commands) {
          if (session.markedSequences.has(command.sequence)) continue;
          if (command.kind === 'deploy') {
            const { troop, tx, ty } = command.payload;
            bus.emit('battle:mark', { troop, tx, ty });
          } else if (command.kind === 'hero') {
            const { hero, tx, ty } = command.payload;
            bus.emit('battle:mark', { troop: HERO_COMBAT[hero].donor, hero, tx, ty });
          }
          session.markedSequences.add(command.sequence);
        }
      }, 80);
      return;
    }
    // V1 owns the batch clock, so reload recovers it from the journal. Protocol
    // 2 always follows the locked server clock (including a start row whose
    // pre-battle deploys all correctly remain at simulator time zero).
    // journal: every order was accepted at (battle start + its offset) and the
    // latest such stamp is the tightest bound — a t=0 drop placed before ATTACK
    // only bounds it from below. Never in the future: a skewed clock must not
    // stamp the next reserve before the fight began.
    const presentation = await simulatePresentation({
      simVersion: currentRaid.simVersion,
      snapshot: currentRaid.snapshot as Parameters<typeof simulateRaid>[0],
      orders: hydrated as Parameters<typeof simulateRaid>[1], seed: currentRaid.seed,
      options: { troopLevels: currentRaid.armySnapshot.levels as never },
    }, currentRaid.id);
    if (!presentation?.current() || !isCurrent()) return;
    const sim = presentation.outcome;
    const now = Date.now();
    const completionClock = currentRaid.raidProtocolVersion === 2 ? liveClockRef.current : null;
    const canonicalMs = completionClock
      ? liveRaidPlayheadMs(completionClock, liveClockReceivedAtRef.current, now) : null;
    const battleStart = canonicalMs !== null
      ? now - canonicalMs / completionClock!.rate
      : Math.min(now, Math.max(...commands.map((command) =>
        Date.parse(command.acceptedAt) - offsetOf(command))));
    const fromTick = Math.floor((canonicalMs ?? now - battleStart) / TICK_MS);
    battleStartRef.current = battleStart;
    setPhase('playing');
    startProgressRef.current(
      sim.events as unknown as Array<{ t: number; e: string; n?: number }>,
      {
        stars: sim.stars, destructionPct: sim.destructionPct,
        keepDestroyed: sim.keepDestroyed, lootShards: 0, attackerTrophyDelta: 0,
      },
      fromTick,
    );
    setTimeout(() => {
      if (!isCurrent() || !presentation.current()) return;
      bus.emit('battle:play', {
        ...presentation.healthContext,
        events: sim.events as unknown as Array<{ t: number; e: string; n?: number }>,
        fromTick, appliedPrefix: true,
        simVersion: currentRaid.simVersion,
        ...fightOpenFlag(),
      });
    }, 80);
  }, [simulatePresentation]);

  applyAcceptedBatchRef.current = applyBatchJournal;

  // D-099: a reload mid-raid re-enters a journaled batch raid through the Raid
  // Log / pending resume. Rebuild every placed order from the server journal
  // before accepting more, so the reserve tapped next lands on the field the
  // player actually has rather than on an empty one.
  useEffect(() => {
    if (screen !== 'battle' || !raid || !batchJournalMode) return;
    const session = liveCommandSessionRef.current;
    if (!session || session.raidId !== raid.id) return;
    // A freshly created raid has nothing journaled yet; only a resumed march
    // (its navigation carries the immutable id) needs the read before a tap.
    if (!useApp.getState().raidTarget?.raidId) { session.hydrated = true; return; }
    let disposed = false;
    session.hydrated = false;
    const hydrate = async (): Promise<void> => {
      const canonicalRead = await readCanonicalLiveCommands(raid.id);
      const canonical = canonicalRead.commands;
      if (disposed || liveCommandSessionRef.current !== session || raidRef.current?.id !== raid.id) return;
      if (canonicalRead.view.clock) adoptClock(canonicalRead.view.clock);
      for (const [sequence, command] of canonical) session.accepted.set(sequence, command);
      session.hydrated = true;
      applyBatchJournal(raid, session);
    };
    void hydrate().catch((cause: Error) => {
      if (!disposed && liveCommandSessionRef.current === session && raidRef.current?.id === raid.id) {
        setErr(cause.message.toUpperCase());
      }
    });
    return () => { disposed = true; };
  }, [screen, raid?.id, batchJournalMode, applyBatchJournal,
    raidTarget?.recoveryEpoch, adoptClock]);

  /** Another attacker tab can start, change speed, deploy, or finish this same
   * raid. Refresh the append-only journal independently of local input; only a
   * new SIM order or the first start re-simulates. The next read starts after
   * completion, never on an interval that can overlap a slow connection. */
  useEffect(() => {
    if (screen !== 'battle' || !raid || raid.raidProtocolVersion !== 2 || isSpectator) return;
    const session = liveCommandSessionRef.current;
    if (!session || session.raidId !== raid.id) return;
    const guard = captureBaseSnapshotGuard();
    let disposed = false, inFlight = false, terminal = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const current = (): boolean => !disposed && mountedRef.current
      && liveCommandSessionRef.current === session && raidRef.current?.id === raid.id
      && isBaseSnapshotGuardCurrent(guard) && useApp.getState().screen === 'battle'
      && phaseRef.current !== 'done';
    const available = (): boolean => current() && document.visibilityState !== 'hidden'
      && navigator.onLine !== false;
    const schedule = (): void => {
      if (available() && !terminal) timer = setTimeout(() => { timer = null; void poll(); }, LIVE_COMMAND_RECONCILE_MS);
    };
    const poll = async (): Promise<void> => {
      if (inFlight || terminal || !available()) return;
      inFlight = true;
      try {
        let afterSequence = -1;
        while (session.accepted.has(afterSequence + 1)) afterSequence++;
        const { commands, view } = await readCanonicalLiveCommands(raid.id, afterSequence);
        if (!available()) return;
        assertLiveRaidSimVersion(view.simVersion);
        let changedOrders = false;
        for (const [sequence, command] of commands) {
          if (!session.accepted.has(sequence)
            && ['deploy', 'hero', 'buff', 'rally'].includes(command.kind)) changedOrders = true;
          session.accepted.set(sequence, command);
        }
        // A POST may have produced a newer receipt while this read was in
        // flight. Merge instead of clearing, and let clock revision ordering
        // reject old samples. Polling cannot release ambiguous reservations.
        adoptClock(view.clock);
        setLiveSyncUnavailable(false);
        if (view.status === 'resolved') {
          const path = raid.attackerBaseId
            ? `/bases/${encodeURIComponent(raid.attackerBaseId)}/battles/${encodeURIComponent(raid.id)}/replay`
            : `/raids/${encodeURIComponent(raid.id)}/replay`;
          const replay = await api.get<{
            result: RaidResult; simVersion: number;
            orders?: Parameters<typeof battleHealthContext>[0];
            armySnapshot?: { heroLoadouts?: Partial<Record<HeroKey, HeroCombatLoadout>> };
            events: Array<{ t: number; e: string; n?: number }>;
          }>(path);
          if (!available()) return;
          assertLiveRaidSimVersion(replay.simVersion);
          terminal = true;
          cancelPresentation();
          committedRef.current = true;
          resultRef.current = replay.result;
          setResult(replay.result);
          setErr(null);
          setPhase('playing');
          clearWallClockCommit();
          progressTimers.current.forEach(clearTimeout);
          progressTimers.current = [];
          progressPlayingRef.current = false;
          bus.emit('battle:play', {
            ...battleHealthContext(replay.orders, replay.armySnapshot?.heroLoadouts),
            events: replay.events, fromTick: Math.floor(view.clock.simNowMs / TICK_MS),
            appliedPrefix: true, simVersion: replay.simVersion, terminal: true,
          });
          return;
        }
        if (changedOrders || (phaseRef.current === 'deploying' && liveClockRef.current?.anchorWallAt != null)) {
          if (liveCommandModeRef.current) applyAcceptedLiveCommands(raid, session);
          else applyBatchJournal(raid, session);
        }
      } catch {
        if (current()) setLiveSyncUnavailable(true);
      } finally {
        inFlight = false;
        schedule();
      }
    };
    const wake = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (navigator.onLine === false && current()) setLiveSyncUnavailable(true);
      if (available()) void poll();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('offline', wake);
    setLiveSyncUnavailable(navigator.onLine === false);
    schedule();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('offline', wake);
    };
  }, [screen, raid?.id, isSpectator, wallet, adoptClock, applyAcceptedLiveCommands, applyBatchJournal]);

  /** Defender live view. The participant endpoint supplies the frozen replay
   * inputs plus append-only, server-timestamped commands. Each new command
   * deterministically re-simulates the same raid and replaces only the future
   * BattleScene schedule, exactly like the attacker's mid-battle deploy path.
   *
   * A late join starts at tick zero instead of fabricating prior scene state;
   * it therefore watches a delayed canonical stream and then follows new
   * commands. This preserves every hit/deploy truthfully with the existing
   * renderer. The endpoint remains the authority for when settlement is final.
   */
  useEffect(() => {
    const raidId = isLiveSpectator ? raidTarget?.raidId : undefined;
    const baseId = isLiveSpectator ? raidTarget?.replayBaseId : undefined;
    if (screen !== 'battle' || !raidId || !baseId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let entered = false;
    let afterSequence = -1;
    let requestedThrough = -1;
    const commands = new Map<number, LiveCommand>();
    // Participant reads are capped at 120/min. One non-overlapping read each
    // second leaves half the allowance for reconnect/page bursts.
    const pollMs = 1_000;
    liveResolvedRef.current = false;
    livePlaybackStartedAtRef.current = 0;
    setErr(null); setResult(null); setProgress(ZERO_PROGRESS); setLivePct(0);
    setPhase('deploying');

    const enter = (view: LiveRaidView): void => {
      if (entered) return;
      entered = true;
      bus.emit('battle:enter', {
        snapshot: view.snapshot,
        visualContext: view.visualContext, boundCosmeticVisual: view.boundCosmeticVisual,
        servicePresentation: view.servicePresentation, advancedServicePresentation: view.advancedServicePresentation,
        armyLevels: view.armySnapshot.levels ?? {},
        armyCounts: view.armySnapshot.counts,
        heroLevels: view.armySnapshot.heroLevels,
      });
    };

    const replayPath = (): string =>
      `/bases/${encodeURIComponent(baseId)}/battles/${encodeURIComponent(raidId)}/replay`;

    const settle = async (view: LiveRaidView): Promise<void> => {
      const replay = await api.get<{
        snapshot: unknown; visualContext?: BaseVisualContext | undefined; boundCosmeticVisual?: BoundCosmeticBaseRead | undefined;
        servicePresentation?: unknown; advancedServicePresentation?: unknown;
        orders?: Parameters<typeof battleHealthContext>[0];
      armySnapshot?: { levels?: Record<string, number>; counts?: Record<string, number>; heroLevels?: Record<string, number>; heroLoadouts?: Partial<Record<HeroKey, HeroCombatLoadout>> };
        simVersion: number;
        events: Array<{ t: number; e: string; n?: number }>;
        result: RaidResult;
      }>(replayPath());
      if (disposed) return;
      cancelPresentation();
      enter({ ...view, snapshot: replay.snapshot, visualContext: replay.visualContext, boundCosmeticVisual: replay.boundCosmeticVisual,
        servicePresentation: replay.servicePresentation, advancedServicePresentation: replay.advancedServicePresentation, armySnapshot: replay.armySnapshot ?? {} });
      setResult(replay.result);
      setPhase('playing');
      liveResolvedRef.current = true;
      const now = Date.now();
      const fromTick = Math.floor(
        liveRaidPlayheadMs(view.clock, liveClockReceivedAtRef.current, now) / TICK_MS,
      );
      if (livePlaybackStartedAtRef.current === 0) {
        livePlaybackStartedAtRef.current = now - fromTick * TICK_MS / view.clock.rate;
      }
      setTimeout(() => {
        if (!disposed) bus.emit('battle:play', {
          ...battleHealthContext(replay.orders, replay.armySnapshot?.heroLoadouts),
          events: replay.events,
          ...(fromTick > 0 ? { fromTick, appliedPrefix: true as const } : {}),
          simVersion: replay.simVersion,
        });
      }, entered && fromTick > 0 ? 0 : 80);
    };

    const poll = async (): Promise<void> => {
      try {
        let view: LiveRaidView;
        do {
          view = await api.get<LiveRaidView>(liveRaidPath(raidId, afterSequence));
          if (disposed) return;
          assertLiveRaidSimVersion(view.simVersion);
          adoptClock(view.clock);
          const storage = browserRaidResumeStorage();
          if (storage && wallet) {
            writeRaidResumePointer(storage, {
              version: 1, wallet, baseId, raidId, mode: 'live', role: 'defender',
              phase: view.status === 'resolved' ? 'result'
                : view.clock.anchorWallAt ? 'playing' : 'deploying',
              target: { replayBaseId: baseId },
              clock: { revision: view.clock.revision, rate: view.clock.rate },
              inFlightSpeed: null,
            });
          }
          enter(view);
          for (const command of view.commands) commands.set(command.sequence, command);
          const last = view.commands.at(-1)?.sequence;
          if (last !== undefined) afterSequence = Math.max(afterSequence, last);
        } while (view.hasMore);

        if (view.status === 'resolved') {
          await settle(view);
          return;
        }
        if (view.startedAt && afterSequence > requestedThrough) {
          setPhase('playing');
          const orders = hydrateLiveOrders(
            [...commands.values()], view.armySnapshot.heroLevels ?? {}, view.armySnapshot.heroLoadouts,
          );
          // Continue canonical reads while presentation calculates. Re-request
          // only a newer accepted prefix, so a slow worker is neither starved
          // by clock-only polls nor allowed to hide a server-settled result.
          requestedThrough = afterSequence;
          void simulatePresentation({
            simVersion: view.simVersion, snapshot: view.snapshot as Parameters<typeof simulateRaid>[0],
            orders: orders as Parameters<typeof simulateRaid>[1], seed: view.seed,
            options: { troopLevels: (view.armySnapshot.levels ?? {}) as never },
          }, raidId).then((presentation) => {
            if (!presentation?.current() || disposed) return;
            const sim = presentation.outcome;
            const now = Date.now();
            const completionClock = liveClockRef.current ?? view.clock;
            const fromTick = Math.floor(
              liveRaidPlayheadMs(completionClock, liveClockReceivedAtRef.current, now) / TICK_MS,
            );
            if (livePlaybackStartedAtRef.current === 0) {
              livePlaybackStartedAtRef.current = now - fromTick * TICK_MS / completionClock.rate;
            }
            setPhase('playing');
            setErr(null);
            setTimeout(() => {
              if (!disposed && presentation.current()) bus.emit('battle:play', {
                ...presentation.healthContext,
                events: sim.events as unknown as Array<{ t: number; e: string; n?: number }>,
                ...(fromTick > 0 ? { fromTick, appliedPrefix: true as const } : {}),
                simVersion: view.simVersion,
              });
            }, fromTick > 0 ? 0 : 80);
          });
        }
      } catch (cause) {
        if (!disposed) setErr(cause instanceof Error ? cause.message.toUpperCase() : 'LIVE RAID UNAVAILABLE');
      }
      if (!disposed) timer = setTimeout(() => { void poll(); }, pollMs);
    };

    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [screen, isLiveSpectator, raidTarget?.raidId, raidTarget?.replayBaseId,
    raidTarget?.recoveryEpoch, adoptClock, wallet, simulatePresentation, cancelPresentation]);

  // field taps place the selected troop (deploy only). R5: deploy anywhere in
  // the expanded battlefield (plot + 4-tile margin) that isn't a building
  // footprint or inside the claim core — the same test the server enforces.
  useEffect(() =>
    bus.on('battle:tap', (tap) => {
      // A3b: taps are accepted during the FIGHT too, not only in the pre-battle
      // window — the owner wants reserves committable mid-raid.
      if (!raid || isSpectator || retreatingRef.current || nextTargetIntentRef.current) return;
      if (raid.raidProtocolVersion === 2 && liveSyncUnavailable) { toast('RAID OFFLINE — RECONNECTING'); return; }
      if (phase !== 'deploying' && phase !== 'playing') return;
      const previewHero = troop.startsWith('hero:')
        ? troop.slice(5) as 'vex' | 'theodor'
        : undefined;
      const previewTroop = previewHero ? HERO_COMBAT[previewHero].donor : troop;
      // Search legal AND visible neighbors together. Picking a hidden legal
      // tile first used to reject the tap despite an exposed neighbor nearby.
      const snapped = snapToDeployable(
        tap.tx, tap.ty, tap.fx, tap.fy, occupied, battlefield,
        (destination) => snappedDeployIsVisible(
          destination, tap.visibleTiles, tap.previewVisible, previewTroop, previewHero,
        ),
      );
      if (!snapped) {
        // Preserve the visibility cue without reserving or consuming anything;
        // an entirely illegal neighborhood keeps its existing invalid-tap path.
        if (snapToDeployable(tap.tx, tap.ty, tap.fx, tap.fy, occupied, battlefield)) {
          toast('PAN TO REVEAL THIS TILE');
        }
        return;
      }
      const { tx, ty } = snapped;
      // Hero drop (D4a): the 'hero:<key>' sentinel routes to the hero channel.
      if (troop.startsWith('hero:')) {
        const hero = troop.slice(5) as 'vex' | 'theodor';
        const session = liveCommandSessionRef.current?.raidId === raid.id
          ? liveCommandSessionRef.current : null;
        // ONE drop per hero — read the REF, never the closed-over state. This
        // effect's deps do not include heroOrders (a hero drop changes nothing
        // else), so the closure's copy stayed [] forever and BattleScene's
        // 120ms hold-repeat streamed three Theodors onto the field (owner
        // 2026-07-28). The ref is re-synced every render AND written below.
        if (heroOrdersRef.current.some((h) => h.hero === hero) || session?.pendingHeroes.has(hero)) return;
        if (liveCommandMode || (batchJournalMode && raid.raidProtocolVersion === 2)) {
          if (!session?.hydrated) { toast('RECONNECTING LIVE RAID…'); return; }
          session.pendingHeroes.add(hero);
          bumpPending();
          // Show the hero where he was dropped NOW. The accepted deploy event
          // consumes this marker at the same tile; a rejection takes it back.
          const donor = HERO_COMBAT[hero].donor;
          bus.emit('battle:mark', { troop: donor, hero, tx, ty });
          queueLiveCommand(raid, { kind: 'hero', payload: { hero, tx, ty } }, (accepted) => {
            session.pendingHeroes.delete(hero);
            if (!accepted) bus.emit('battle:unmark', { troop: donor, hero, tx, ty });
            bumpPending();
          }, true);
          bus.emit('battle:holdCancel', undefined);
          const back = raidDeployTrayTroops(raid.armySnapshot).find((t) =>
            (raid.armySnapshot.counts[t] ?? 0) - (used[t] ?? 0) - (session.pendingTroops[t] ?? 0) > 0);
          if (back) setTroop(back);
          return;
        }
        if (batchJournalMode && !session?.hydrated) { toast('RESTORING YOUR RAID…'); return; }
        haptic('light');
        let placed = false;
        if (phase === 'playing') {
          placed = deployHeroMidBattle(hero, tx, ty);
        } else {
          const next = [...heroOrdersRef.current, { hero, tx, ty, tMs: 0 }];
          heroOrdersRef.current = next; // guard the NEXT hold beat before React re-renders
          setHeroOrders(next);
          // The hero previews on the field like any troop — with HIS art, at hero
          // scale (owner: "deployed heroes not visible before you press attack").
          bus.emit('battle:mark', { troop: HERO_COMBAT[hero].donor, hero, tx, ty });
          placed = true;
          if (batchJournalMode) queueLiveCommand(raid, { kind: 'hero', payload: {
            hero, tx, ty, ...(raid.raidProtocolVersion === 2 ? {} : { tMs: 0 }),
          } });
        }
        // A hero is a ONE-SHOT card: leaving him selected would make every later
        // field tap hit the one-drop guard and do nothing at all. Hand the
        // selection back to a troop the player still has.
        if (placed) {
          // End the gesture BEFORE handing the selection back, or a held finger
          // keeps firing beats — now as the newly selected troop.
          bus.emit('battle:holdCancel', undefined);
          const back = raidDeployTrayTroops(raid.armySnapshot).find((t) =>
            (raid.armySnapshot.counts[t] ?? 0) - (used[t] ?? 0) > 0);
          if (back) setTroop(back);
        }
        return;
      }
      if (troopRolloutGate(
        troop, raid.armySnapshot.features?.darkAttackerRoster,
      ).locked) return;
      const have = raid.armySnapshot.counts[troop] ?? 0;
      const spent = used[troop] ?? 0;
      const session = liveCommandSessionRef.current?.raidId === raid.id
        ? liveCommandSessionRef.current : null;
      const pending = session?.pendingTroops[troop] ?? 0;
      if (spent + pending >= have) return;
      if (liveCommandMode || (batchJournalMode && raid.raidProtocolVersion === 2)) {
        if (!session?.hydrated) { toast('RECONNECTING LIVE RAID…'); return; }
        session.pendingTroops[troop] = pending + 1;
        bumpPending();
        // The player must see the unit they just committed BEFORE the server
        // answers: a round-trip on a phone network is long enough to re-tap
        // "because nothing happened", and every one of those taps is a real
        // command (owner's teammate 2026-09-04: "3-4 Giants instead of two").
        // The marker is presentation only — the accepted deploy event consumes
        // it at this tile and a definite rejection takes it back; SIM input
        // still comes exclusively from the server's accepted stream.
        bus.emit('battle:mark', { troop, tx, ty });
        queueLiveCommand(raid, {
          kind: 'deploy', payload: { troop: troop as TroopType, tx, ty },
        }, (accepted) => {
          session.pendingTroops[troop] = Math.max(0, (session.pendingTroops[troop] ?? 1) - 1);
          if (!accepted) bus.emit('battle:unmark', { troop, tx, ty });
          bumpPending();
        }, true);
        return;
      }
      if (batchJournalMode && !session?.hydrated) { toast('RESTORING YOUR RAID…'); return; }
      setUsed((u) => ({ ...u, [troop]: (u[troop] ?? 0) + 1 }));
      haptic('light');
      if (phase === 'playing') {
        // MID-BATTLE: land the troop at the real elapsed moment, then re-simulate.
        // Everything already played is byte-identical (sim "live mid-battle deploy
        // invariant"), so the scene keeps its state and we re-feed from the current
        // tick rather than replaying the fight from zero.
        deployMidBattle(troop, tx, ty);
        return;
      }
      // PRE-BATTLE: every drop lands at t=0 so the army starts together (D-099,
      // owner 2026-09-02: "when you are deploying troops they do not start attack
      // same time"). The old 150ms-per-drop stagger was client-only — the server
      // never staggered a live raid — and read as units hesitating at the edge.
      setOrders((o) => [...o, { troop, tx, ty, tMs: 0 }]);
      bus.emit('battle:mark', { troop, tx, ty });
      // D-099: journal the drop as it is placed, so the server can settle this
      // exact list itself if FINISH never arrives.
      if (batchJournalMode) {
        queueLiveCommand(raid, { kind: 'deploy', payload: {
          troop: troop as TroopType, tx, ty,
          ...(raid.raidProtocolVersion === 2 ? {} : { tMs: 0 }),
        } });
      }
    }),
  [raid, phase, troop, used, isSpectator, liveCommandMode, batchJournalMode, queueLiveCommand, occupied, battlefield, liveSyncUnavailable]);

  // Ordinary damage is monotonic. A late server-accepted order may replace an
  // already-rendered prefix: then the reconstructed HP ledger owns the value,
  // even if the old incomplete command stream showed more damage.
  useEffect(() => bus.on('battle:progress', ({ pct, corrected }) =>
    setLivePct((p) => corrected ? pct : Math.max(p, pct))), []);
  useEffect(() => bus.on('battle:catchup', ({ active }) => setCatchingUp(active)), []);

  // playback finished → show result (replays end here too)
  useEffect(() => bus.on('battle:done', () => {
    if (simulationPendingRef.current || simulationFailedRef.current) return; // an older stream cannot end a newer accepted plan
    const target = useApp.getState().raidTarget;
    const terminal = terminalReplayReadyRef.current;
    if (target?.resumeTerminal && (terminal?.target !== target
      || !isBaseSnapshotGuardCurrent(terminal.guard))) return;
    setCatchingUp(false); // D-099: the verdict never sits under CATCHING UP…
    progressPlayingRef.current = false;
    replayPlayingRef.current = false;
    setReplayPlaying(false);
    // A partial live command set can already have a deterministic terminal
    // event, but the attacker may still append reserves. Only the server's
    // resolved status turns that provisional end into the spectator verdict.
    if (spectatorRef.current && !liveResolvedRef.current) return;
    // An uncertain retreat owns its confirmation/watchdog. A coincident local
    // animation end cannot hide STAY behind a verdict with no server result.
    if (retreatingRef.current && !resultRef.current) return;
    // A wipe can still accept reserves until the horn. A rendered 100% stream
    // may instead ask the server to prove that the target is already destroyed.
    if (raidRef.current?.raidProtocolVersion === 2 && !resultRef.current) {
      const clock = liveClockRef.current;
      const delay = clock
        ? liveRaidNormalFinishDelayMs(clock, liveClockReceivedAtRef.current, Date.now())
        : null;
      if ((delay === null || delay > 0) && !canRequestEarlyVictory()) return;
    }
    // D-106: a batch fight whose deployed troops all died still has reserves
    // in the tray and time on the clock — hold the field open (clock running,
    // tray and RETREAT live, nothing posted). The next reserve re-feeds the
    // stream; the wall-clock commit, armed at the TRUE clock end while
    // reserves remain, closes the fight if none is ever released.
    if (batchFightStillOpen()) { setFightOpen(true); return; }
    // Commit BEFORE the result screen so its numbers are the server's, not the
    // local sim's (loot/trophies only exist server-side). The verdict now WAITS
    // for that POST: if a request went out we sit in 'committing' until it
    // answers (commitRaid flips to 'done'), and only a raid with nothing to post
    // (a spectated replay, or one already resolved by the submit fallback) goes
    // straight to the result — it already has one.
    if (commitRaidRef.current?.() === true) { setPhase('committing'); return; }
    // D-096: the wall-clock timer in startProgress normally posted this raid
    // already — it fires at the same battle end whether or not the tab was
    // visible. Its reply may still be in flight: wait for it in 'committing'
    // rather than render a verdict off a null result; once it has landed the
    // verdict is ready.
    setPhase(committedRef.current && !resultRef.current ? 'committing' : 'done');
  }), []);

  // A provisional stream may have ended long before the raid clock. There
  // need not be another animation completion to close it; accepted speed
  // changes and reconnect clocks must also move this finish boundary.
  useEffect(() => {
    if (screen !== 'battle' || isSpectator || phase !== 'playing'
      || retreatingRef.current
      || raid?.raidProtocolVersion !== 2 || !liveClock
      || liveClock.anchorWallAt === null || canonicalPlayheadMs === null
      || canonicalPlayheadMs < liveClock.durationMs) return;
    setPhase('committing');
    commitRaidRef.current?.();
  }, [screen, isSpectator, phase, raid?.raidProtocolVersion, liveClock, canonicalPlayheadMs]);

  // WATCHDOG (owner 2026-07-29: stuck on "RESOLVING RAID…" after a win). The
  // committing phase waits on a POST; if that request never settles the player
  // is trapped on a modal with no exit. After COMMIT_WATCHDOG_MS, try to
  // recover the verdict from the resolved raid's replay record, and if even
  // that fails surface the error UI (which has RETRY and BACK TO BASE) rather
  // than spinning forever.
  useEffect(() => {
    if (phase !== 'committing' || err) return;
    const currentRaid = raidRef.current;
    const clock = liveClockRef.current;
    const dueDelay = currentRaid?.raidProtocolVersion === 2 && clock && !canRequestEarlyVictory()
      ? liveRaidNormalFinishDelayMs(clock, liveClockReceivedAtRef.current, Date.now()) ?? 0
      : 0;
    const h = setTimeout(() => {
      const r = raidRef.current;
      if (!r) { setErr('RAID RESOLUTION TIMED OUT'); return; }
      const replayPath = r.attackerBaseId
        ? `/bases/${encodeURIComponent(r.attackerBaseId)}/battles/${encodeURIComponent(r.id)}/replay`
        : `/raids/${encodeURIComponent(r.id)}/replay`;
      void api.get<{ result: RaidResult }>(replayPath)
        .then((rep) => { setResult(rep.result); setErr(null); setPhase('done'); })
        .catch(() => setErr('RAID RESOLUTION TIMED OUT — RETRY OR RETURN TO BASE'));
    // Partial wipes still wait for the horn. A complete destruction sends an
    // actual request now, so its watchdog must also start now.
    }, dueDelay + COMMIT_WATCHDOG_MS);
    return () => clearTimeout(h);
  }, [phase, err, liveClock]);

  // D-096: a commit posted by the wall-clock timer stores its result without
  // touching the phase (the field may still be catching up). When battle:done
  // arrived first we are waiting in 'committing' — the result landing IS the
  // verdict, unless a failure already owns the panel.
  useEffect(() => {
    if (phase === 'committing' && result && !err) setPhase('done');
  }, [phase, result, err]);

  // replays carry their resolved result up-front (from the raid log)
  useEffect(() => {
    if (isReplay && raidTarget?.result) {
      setResult(raidTarget.result);
    }
  }, [isReplay, raidTarget]);

  // Raid Log owns ordinary replay entry. A process-death terminal recovery
  // bypasses it, so the result alone is not enough: reconstruct its canonical
  // field before showing the footer or retiring the durable resume pointer.
  useEffect(() => {
    const target = useApp.getState().raidTarget;
    if (screen !== 'battle' || target?.kind !== 'replay'
      || !target.resumeTerminal || !target.raidId) return;
    const guard = captureBaseSnapshotGuard();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const current = (): boolean => !disposed && mountedRef.current
      && isBaseSnapshotGuardCurrent(guard) && useApp.getState().screen === 'battle'
      && useApp.getState().raidTarget === target;
    terminalReplayReadyRef.current = null;
    resultRef.current = null;
    setResult(null); setErr(null); setPhase('deploying');
    void api.get<{
      snapshot: unknown; visualContext?: BaseVisualContext | undefined; boundCosmeticVisual?: BoundCosmeticBaseRead | undefined;
      servicePresentation?: unknown; advancedServicePresentation?: unknown;
      orders?: Parameters<typeof battleHealthContext>[0];
      armySnapshot?: { levels?: Record<string, number>; counts?: Record<string, number>; heroLevels?: Record<string, number>; heroLoadouts?: Partial<Record<HeroKey, HeroCombatLoadout>> };
      events: Array<{ t: number; e: string; n?: number }>;
      simVersion: number;
      result: RaidResult;
    }>(savedReplayPath(target, target.raidId)).then((replay) => {
      if (!current()) return;
      resultRef.current = replay.result;
      setResult(replay.result);
      setPhase('playing');
      bus.emit('battle:enter', {
        snapshot: replay.snapshot,
        visualContext: replay.visualContext, boundCosmeticVisual: replay.boundCosmeticVisual,
        servicePresentation: replay.servicePresentation, advancedServicePresentation: replay.advancedServicePresentation,
        armyLevels: replay.armySnapshot?.levels ?? {},
        armyCounts: replay.armySnapshot?.counts,
        heroLevels: replay.armySnapshot?.heroLevels,
      });
      // Match normal replay entry's scene-start beat. The terminal mechanism
      // silently applies the complete event stream, then emits battle:done.
      timer = setTimeout(() => {
        timer = null;
        if (!current()) return;
        terminalReplayReadyRef.current = { target, guard };
        bus.emit('battle:play', { ...battleHealthContext(replay.orders, replay.armySnapshot?.heroLoadouts), events: replay.events, simVersion: replay.simVersion, terminal: true });
      }, 80);
    }).catch((cause: unknown) => {
      if (current()) {
        setErr(cause instanceof Error ? cause.message.toUpperCase() : 'REPLAY UNAVAILABLE');
        setPhase('deploying');
      }
    });
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [screen, raidTarget?.kind, raidTarget?.raidId, raidTarget?.replayPath,
    raidTarget?.replayBaseId, raidTarget?.resumeTerminal, raidTarget?.recoveryEpoch, retry]);

  useEffect(() => {
    if (phase !== 'done' || !result || !wallet) return;
    const terminal = terminalReplayReadyRef.current;
    if (raidTarget?.resumeTerminal && (terminal?.target !== raidTarget
      || !isBaseSnapshotGuardCurrent(terminal.guard))) return;
    const raidId = raid?.id ?? raidTarget?.raidId;
    const baseId = raid?.attackerBaseId ?? raidTarget?.replayBaseId ?? homeBase?.baseId;
    const storage = browserRaidResumeStorage();
    if (storage && raidId && baseId) clearRaidResumePointer(storage, wallet, baseId, raidId);
  }, [phase, result, wallet, raid?.id, raid?.attackerBaseId,
    raidTarget?.raidId, raidTarget?.replayBaseId, homeBase?.baseId]);

  // tidy any scheduled progress timers on unmount
  useEffect(() => () => {
    progressTimers.current.forEach(clearTimeout); progressTimers.current = [];
    progressPlanRef.current = null;
    progressPlayingRef.current = false;
    replayPlayingRef.current = false;
    clearWallClockCommit();
  }, []);

  /**
   * A3b — commit a troop WHILE the battle is running.
   *
   * The sim is pure and deterministic and its "live mid-battle deploy invariant"
   * test pins that appending a LATER deploy leaves every earlier event
   * byte-identical. So this can simply: stamp the troop at its real elapsed tMs,
   * re-run the whole sim, and re-feed the stream from the CURRENT tick. No
   * rollback, no reconciliation, and the scene keeps the state it has already
   * built — `fromTick` stops the earlier events being applied a second time.
   *
   * The accumulated list is what gets submitted at the end, so the server's
   * authoritative re-run sees exactly the raid the player actually fought.
   */
  const currentRaidPlayheadMs = (currentRaid: RaidDto): number => {
    const clock = currentRaid.raidProtocolVersion === 2 ? liveClockRef.current : null;
    return clock
      ? liveRaidPlayheadMs(clock, liveClockReceivedAtRef.current, Date.now())
      : Math.max(0, Date.now() - battleStartRef.current);
  };

  const deployMidBattle = (troopKey: string, tx: number, ty: number): void => {
    const r = raidRef.current;
    if (!r) return;
    const elapsed = currentRaidPlayheadMs(r);
    const tick = Math.floor(elapsed / TICK_MS);
    if (tick >= RAID_RULES.battleDurationSec * 1000 / TICK_MS) { toast('TOO LATE — THE BATTLE IS OVER'); return; }
    const next = [...ordersRef.current, { troop: troopKey, tx, ty, tMs: elapsed }];
    ordersRef.current = next; setOrders(next);
    if (batchJournalModeRef.current) queueLiveCommand(r, { kind: 'deploy', payload: {
      troop: troopKey as TroopType, tx, ty, tMs: elapsed,
    } });
    void simulatePresentation({
      simVersion: r.simVersion, snapshot: r.snapshot as Parameters<typeof simulateRaid>[0],
      orders: {
        deploys: next as Parameters<typeof simulateRaid>[1]['deploys'],
        ...(heroOrdersRef.current.length ? { heroDeploys: withHeroLevels(
          heroOrdersRef.current, r.armySnapshot.heroLevels, r.armySnapshot.heroLoadouts,
        ) } : {}),
        ...(simModsRef.current.buffs ? { buffs: simModsRef.current.buffs as never } : {}),
        ...(simModsRef.current.rally ? { rally: simModsRef.current.rally as never } : {}),
      }, seed: r.seed, options: { troopLevels: r.armySnapshot.levels as never },
    }, r.id).then((presentation) => {
      if (!presentation?.current()) return;
      const sim = presentation.outcome;
      const fromTick = Math.floor(currentRaidPlayheadMs(r) / TICK_MS);
      setFightOpen(false);
      progressPlanRef.current = {
        events: sim.events as unknown as Array<{ t: number; e: string; n?: number }>,
        final: { stars: sim.stars, destructionPct: sim.destructionPct,
          keepDestroyed: sim.keepDestroyed, lootShards: 0, attackerTrophyDelta: 0 },
      };
      bus.emit('battle:play', { ...presentation.healthContext, events: sim.events as never, fromTick, appliedPrefix: true,
        simVersion: r.simVersion, ...fightOpenFlag() });
      armWallClockCommit(sim.events.at(-1)?.t ?? fromTick, fromTick);
    });
  };

  /** D4a mid-battle hero drop — same re-sim contract as deployMidBattle: the
   *  prefix invariant covers hero deploys too (pinned in the sim suite). */
  const deployHeroMidBattle = (hero: 'vex' | 'theodor', tx: number, ty: number): boolean => {
    const r = raidRef.current;
    if (!r || battleStartRef.current === 0 || heroOrdersRef.current.some((h) => h.hero === hero)) return false;
    const elapsed = currentRaidPlayheadMs(r);
    const tick = Math.floor(elapsed / TICK_MS);
    if (tick >= RAID_RULES.battleDurationSec * 1000 / TICK_MS) { toast('TOO LATE — THE BATTLE IS OVER'); return false; }
    const nextHeroes = [...heroOrdersRef.current, { hero, tx, ty, tMs: elapsed }];
    heroOrdersRef.current = nextHeroes; setHeroOrders(nextHeroes);
    if (batchJournalModeRef.current) queueLiveCommand(r, { kind: 'hero', payload: { hero, tx, ty, tMs: elapsed } });
    void simulatePresentation({
      simVersion: r.simVersion, snapshot: r.snapshot as Parameters<typeof simulateRaid>[0],
      orders: {
        deploys: ordersRef.current as Parameters<typeof simulateRaid>[1]['deploys'],
        heroDeploys: withHeroLevels(nextHeroes, r.armySnapshot.heroLevels, r.armySnapshot.heroLoadouts),
        ...(simModsRef.current.buffs ? { buffs: simModsRef.current.buffs as never } : {}),
        ...(simModsRef.current.rally ? { rally: simModsRef.current.rally as never } : {}),
      }, seed: r.seed, options: { troopLevels: r.armySnapshot.levels as never },
    }, r.id).then((presentation) => {
      if (!presentation?.current()) return;
      const sim = presentation.outcome;
      const fromTick = Math.floor(currentRaidPlayheadMs(r) / TICK_MS);
      setFightOpen(false);
      progressPlanRef.current = {
        events: sim.events as unknown as Array<{ t: number; e: string; n?: number }>,
        final: { stars: sim.stars, destructionPct: sim.destructionPct,
          keepDestroyed: sim.keepDestroyed, lootShards: 0, attackerTrophyDelta: 0 },
      };
      bus.emit('battle:play', { ...presentation.healthContext, events: sim.events as never, fromTick, appliedPrefix: true,
        simVersion: r.simVersion, ...fightOpenFlag() });
      armWallClockCommit(sim.events.at(-1)?.t ?? fromTick, fromTick);
    });
    return true;
  };

  /**
   * A3c — post the FINISHED raid. Called when playback ends (and on retreat), so
   * the server resolves the raid the player actually fought, reserves included.
   * Guarded by a ref: battle:done and a manual exit must never post twice.
   */
  const committedRef = useRef(false);
  /**
   * POST the finished raid. Returns TRUE when a request was actually issued, so
   * the caller knows whether a server result is coming.
   *
   * `showResult` (battle end) drives the verdict off the SERVER's reply: success
   * → phase 'done' with the result; failure → stay in 'committing' with the
   * error and a RETRY (the raid is still `pending_orders`, so a retry is valid).
   * A failed commit must NEVER fall through to a verdict — rendering
   * `(result?.stars ?? 0) > 0` against a null result is what showed DEFEAT on a
   * won raid (owner 2026-07-28). A retreat commits silently: the player is
   * already leaving, and flipping to 'done' behind them would slam a result
   * screen over the base.
   */
  /** Stable idempotency key for THIS raid's commit, minted on first attempt. */
  const commitKeyRef = useRef<string | null>(null);
  /** MEASURED height of the bottom deploy tray. Drives both the camera-pill
   *  position and the scene's fit inset, so neither can drift when the tray
   *  changes shape (it grew to two rows and buried the ⌖ pill). */
  const trayRef = useRef<HTMLDivElement>(null);
  /** MEASURED top HUD too (M23 a1): the old constant 96px was wrong whenever
   *  the two flexWrap pill rows wrapped taller on a narrow screen, so the fit
   *  under-reserved the top and slid the base beneath the HUD. Measured height
   *  already contains the CSS safe-area padding, so the safe inset is
   *  subtracted before battleCameraInsets adds it back. */
  const battleHudRef = useRef<HTMLDivElement>(null);
  const [trayH, setTrayH] = useState<number>(RAID_CAMERA.hudBottomPx);
  useEffect(() => {
    const tray = trayRef.current;
    const hud = battleHudRef.current;
    if ((!tray && !hud) || typeof ResizeObserver === 'undefined') return;
    const publish = (): void => {
      const measuredTray = Math.round(tray?.getBoundingClientRect().height ?? 0);
      const h = measuredTray > 0 ? measuredTray : RAID_CAMERA.hudBottomPx;
      const hudRect = hud?.getBoundingClientRect();
      const hudTop = hudRect && hudRect.height > 0
        ? Math.max(0, Math.round(hudRect.height - safeArea.top))
        : RAID_CAMERA.hudTopPx;
      setTrayH(h);
      bus.emit('battle:insets', battleCameraInsets(hudTop, h, safeArea, readGameViewport().h - readGameUiViewport().h));
    };
    // Either side may mount first: initial publication serves an existing
    // scene; a later scene asks for a fresh DOM measurement, never cached chrome.
    const offRequest = bus.on('battle:insetsRequest', publish);
    const offViewport = subscribeGameViewport(publish);
    publish();
    const ro = new ResizeObserver(publish);
    if (tray) ro.observe(tray);
    if (hud) ro.observe(hud);
    return () => { offRequest(); offViewport(); ro.disconnect(); };
  // The component mounts once above screen branches. Re-run when the battle HUD
  // or tray first appears, changes phase, or swaps active/spectator shape; a
  // safe-area-only dependency missed the initial base→battle transition.
  }, [safeArea, screen, phase, raid?.id, isSpectator]);
  /** exit() is defined below; the window-expiry effect needs it by ref. */
  const exitRef = useRef<(() => void) | null>(null);
  const commitRaid = (showResult = false, leavingBattle = false): boolean => {
    const r = raidRef.current;
    if (!r || committedRef.current || retreatingRef.current
      || simulationPendingRef.current || simulationFailedRef.current) return false;
    // Heroes COUNT: a hero-only raid must still post, or it silently resolves as
    // nothing (no result → false DEFEAT, energy burned).
    if (ordersRef.current.length === 0 && heroOrdersRef.current.length === 0) return false;
    if (r.raidProtocolVersion === 2) {
      const clock = liveClockRef.current;
      const delay = clock
        ? liveRaidNormalFinishDelayMs(clock, liveClockReceivedAtRef.current, Date.now())
        : null;
      if ((delay === null || delay > 0) && !canRequestEarlyVictory()) {
        clearWallClockCommit();
        commitTimerRef.current = setTimeout(
          () => { commitTimerRef.current = null; commitRaid(showResult); },
          delay === null ? 1_000 : delay + 25,
        );
        return true;
      }
    }
    committedRef.current = true;
    const commitSession = liveCommandSessionRef.current;
    const commitGuard = captureBaseSnapshotGuard();
    const isCurrentCommit = (): boolean => mountedRef.current
      && liveCommandSessionRef.current === commitSession && raidRef.current?.id === r.id
      && isBaseSnapshotGuardCurrent(commitGuard) && useApp.getState().screen === 'battle'
      && phaseRef.current !== 'done';
    // ONE key per raid, not per attempt: a retry after a LOST REPLY must be the
    // same request, or the server 422s 'raid already resolved' forever and the
    // player can never see the verdict of a raid they won (verify 2026-07-29).
    commitKeyRef.current ??= idemKey();
    const body: Record<string, unknown> = { deploys: ordersRef.current, idempotencyKey: commitKeyRef.current };
    if (heroOrdersRef.current.length) body['heroDeploys'] = heroOrdersRef.current;
    if (simModsRef.current.buffs) body['buffs'] = simModsRef.current.buffs;
    if (simModsRef.current.rally) body['rally'] = simModsRef.current.rally;
    // A journaled batch raid (D-099) finishes from its journal like a live
    // stream: the server already holds every order, so the POST carries none.
    const journal = batchJournalModeRef.current;
    const commandStream = liveCommandModeRef.current || journal;
    const finishPath = commandStream
      ? `/raids/${encodeURIComponent(r.id)}/finish`
      : `/raids/${encodeURIComponent(r.id)}/orders`;
    const post = (): Promise<void> => {
      // A confirmed legacy retreat deliberately leaves before its journal
      // drains. Keep that authorized send, but never carry it across identities
      // or base selections. Automatic finishes must still own the current UI.
      if (!(leavingBattle ? isBaseSnapshotGuardCurrent(commitGuard) : isCurrentCommit())
        || (!leavingBattle && resultRef.current)) return Promise.resolve();
      // A queued FINISH can become stale while waiting behind an accepted
      // reserve. Its replacement calculation must own the next normal finish.
      if (simulationPendingRef.current || simulationFailedRef.current) {
        committedRef.current = false;
        return Promise.resolve();
      }
      return api.postRaw<{ result: RaidResult }>(finishPath, commandStream ? {} : body)
      .then((res) => {
        if (!isCurrentCommit()) {
          if (leavingBattle && isBaseSnapshotGuardCurrent(commitGuard)) void reloadBase({ background: true });
          return;
        }
        setResult(res.result);
        if (showResult) { setErr(null); setPhase('done'); }
        void reloadBase({ background: true });
      })
      .catch((e: Error) => {
        if (!isCurrentCommit()) {
          if (leavingBattle && isBaseSnapshotGuardCurrent(commitGuard)) toast(e.message.toUpperCase());
          return;
        }
        if (r.raidProtocolVersion === 2 && e instanceof ApiError
          && e.code === 'RAID_CLOCK_NOT_DUE') {
          // A clock receipt can become stale while this tab sleeps. NOT_DUE is
          // a timing correction, not a failed battle: refresh the canonical
          // clock and let the ordinary due gate schedule the same FINISH again.
          if (!isCurrentCommit()) return;
          committedRef.current = false;
          clearWallClockCommit();
          commitTimerRef.current = setTimeout(() => {
            commitTimerRef.current = null;
            if (!isCurrentCommit()) return;
            void readCanonicalLiveCommands(r.id)
              .then(({ view }) => {
                if (!isCurrentCommit() || !view.clock) return;
                adoptClock(view.clock);
                const clock = liveClockRef.current;
                if (!resultRef.current && clock
                  && liveRaidNormalFinishDelayMs(clock, liveClockReceivedAtRef.current, Date.now()) !== 0) {
                  setErr(null);
                  setPhase('playing');
                }
              })
              .catch(() => undefined)
              .finally(() => { if (isCurrentCommit()) commitRaid(showResult); });
          }, 250);
          return;
        }
        // 'already resolved' means the raid LANDED and only the reply was lost —
        // retrying can never succeed, but the verdict is recoverable from the
        // replay record. Anything else leaves the raid pending and retryable.
        if (/already resolved/i.test(e.message)) {
          const replayPath = r.attackerBaseId
            ? `/bases/${encodeURIComponent(r.attackerBaseId)}/battles/${encodeURIComponent(r.id)}/replay`
            : `/raids/${encodeURIComponent(r.id)}/replay`;
          void api.get<{ result: RaidResult }>(replayPath)
            .then((rep) => {
              setResult(rep.result);
              if (showResult) { setErr(null); setPhase('done'); }
              void reloadBase({ background: true });
            })
            .catch(() => {
              if (showResult) { setErr(e.message.toUpperCase()); setPhase('committing'); }
            });
          return;
        }
        playSfx('sfx_error');
        // D-096: 'deploy window expired' is TERMINAL — the server already flipped
        // the row to expired and refunded the energy, so no retry can succeed.
        // committedRef stays true so neither battle:done, RETRY nor a retreat
        // posts it again. The battle is still on screen when the wall-clock
        // commit hits this, so the panel says what happened; only a retreat
        // that already tore the raid down gets the toast.
        if (RAID_EXPIRED_RE.test(e.message)) {
          if (raidRef.current?.id === r.id) { setErr(RAID_EXPIRED_COPY); setPhase('committing'); }
          else toast(RAID_EXPIRED_COPY);
          return;
        }
        committedRef.current = false; // the raid is still pending_orders — retryable
        if (showResult) { setErr(e.message.toUpperCase()); setPhase('committing'); }
        else toast(e.message.toUpperCase());
      });
    };
    if (journal) {
      // FINISH must never overtake a journal write still in flight: the queue
      // is the order of record and the worker is the backstop, not this POST.
      const session = liveCommandSessionRef.current?.raidId === r.id
        ? liveCommandSessionRef.current : null;
      void (session?.queue ?? Promise.resolve()).finally(() => { void post(); });
    } else {
      void post();
    }
    return true;
  };

  /**
   * D-096 battle clock: post the raid at the WALL-CLOCK battle end — the same
   * (maxTick − fromTick + 10) × TICK_MS BattleScene schedules battle:done at —
   * whether or not the tab is visible. Phaser pauses its loop in a hidden tab,
   * so a battle:done-only commit arrived after the server's orders deadline
   * (+ batchOrdersGraceSec) had expired the raid: the HUD said 100 % and the
   * campaign stage was never written. Silent on purpose — the verdict still
   * waits for battle:done, since the field may be catching up — and commitRaid
   * guards against a second post. Re-armed by every (re)fed stream: a mid-battle
   * reserve can extend the fight past the end the first stream had, and the
   * post must carry every order. Live command streams FINISH from their own
   * queue and spectators have nothing to post.
   */
  /**
   * D-106: the battle clock ran out while the field sat open — no reserve was
   * ever released after the last batch died. Close the fight the way
   * battle:done would have: post, then wait for the verdict in 'committing'.
   */
  const concludeOpenFight = (): void => {
    if (!fightOpenRef.current || simulationPendingRef.current || simulationFailedRef.current) return;
    setFightOpen(false);
    if (commitRaid() === true) { setPhase('committing'); return; }
    setPhase(committedRef.current && !resultRef.current ? 'committing' : 'done');
  };
  const armWallClockCommit = (
    maxTick: number, fromTick: number, rate: 1 | 2 = liveClockRef.current?.rate ?? 1,
  ): void => {
    clearWallClockCommit();
    if (liveCommandModeRef.current || isSpectator || simulationPendingRef.current || simulationFailedRef.current) return;
    const streamEndMs = playbackWallDelayMs((Math.max(maxTick - fromTick, 0) + 10) * TICK_MS, rate);
    // D-106: while reserves remain and the base still stands, this stream's
    // end is not the fight's end. Post at the TRUE clock end (MAX_TICKS plus
    // the same 10-tick tail the scene gives its verdict) and never earlier
    // than the stream's own end. An empty tray or 100 % keeps today's rule:
    // the stream's end is the fight's end.
    const r = raidRef.current;
    const clockEndMs = r && r.raidProtocolVersion !== 2 && battleStartRef.current > 0
      && (progressPlanRef.current?.final.destructionPct ?? 0) < 100 && reservesRemain()
      ? battleStartRef.current + BATTLE_CLOCK_MS + 10 * TICK_MS - Date.now()
      : 0;
    commitTimerRef.current = setTimeout(() => {
      commitTimerRef.current = null;
      if (simulationPendingRef.current || simulationFailedRef.current) return;
      if (fightOpenRef.current) { concludeOpenFight(); return; }
      commitRaid();
    }, Math.max(streamEndMs, clockEndMs));
  };

  // AUTO-START when the pre-battle window lapses (owner 2026-07-26: "player should
  // have 30 seconds to deploy troops before raid starts automatically"). It fires at
  // the end of the DEPLOY window, not at ordersDeadlineAt — the
  // resolve POST happens at battle END; the server's bounded grace then covers
  // the legal SIM9 drain, BattleScene completion and final transport.
  // Nothing deployed when the window closes: the taps stop being accepted, so
  // the player is left staring at a 0:00 timer with a dead ATTACK button and
  // only RETREAT — a hard dead end (reproduced 2026-07-29). Say so and leave.
  useEffect(() => {
    if (phase !== 'deploying' || !raid || isSpectator || deployCount > 0) return;
    if (raid.raidProtocolVersion === 2 && liveClockRef.current?.anchorWallAt != null) return;
    const session = liveCommandSessionRef.current;
    const journal = liveCommandMode || batchJournalMode;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const expireIfEmpty = (): void => {
      timer = null;
      // A reload begins with empty React arrays while its canonical journal is
      // still in flight. Those arrays are not evidence that nothing deployed.
      // Recheck the current session and refs at the deadline, not the closure
      // that armed it before a first accepted drop or a clock-start receipt.
      if (!mountedRef.current || useApp.getState().screen !== 'battle'
        || raidRef.current?.id !== raid.id || phaseRef.current !== 'deploying'
        || liveCommandSessionRef.current !== session) return;
      if (battleStartRef.current > 0 || ordersRef.current.length || heroOrdersRef.current.length
        || (raid.raidProtocolVersion === 2 && liveClockRef.current?.anchorWallAt != null)
        || [...(session?.accepted.values() ?? [])].some((command) =>
          command.kind === 'deploy' || command.kind === 'hero')) return;
      if (journal && (!session?.hydrated || session.pendingHeroes.size > 0
        || Object.values(session.pendingTroops).some((count) => count > 0))) {
        // Hydration and ambiguous writes have their own canonical retry paths.
        // Wait for definite emptiness without issuing a competing request or
        // abandoning the battle; cleanup cancels this bounded recheck.
        timer = setTimeout(expireIfEmpty, LIVE_COMMAND_RECONCILE_MS);
        return;
      }
      toast('DEPLOY WINDOW CLOSED — CHECK YOUR ARMY AT THE BARRACKS, THEN RETRY');
      exitRef.current?.();
    };
    timer = setTimeout(expireIfEmpty, Math.max(0, deployEndsAtMs - Date.now()));
    return () => { if (timer !== null) clearTimeout(timer); };
  }, [phase, raid, isSpectator, deployCount, deployEndsAtMs,
    liveCommandMode, batchJournalMode, liveClock?.anchorWallAt]);

  // Nothing deployed yet → let it expire rather than submitting an empty attack
  // that would resolve as a 0-star loss.
  useEffect(() => {
    if (phase !== 'deploying' || !raid || isSpectator || liveCommandMode || deployCount === 0) return;
    const msLeft = batchAutoSubmitAt - Date.now();
    const id = setTimeout(() => {
      toast('DEPLOY WINDOW CLOSED — ATTACKING');
      submitRef.current?.();
    }, Math.max(0, msLeft));
    return () => clearTimeout(id);
  }, [phase, raid, isSpectator, liveCommandMode, deployCount, batchAutoSubmitAt]);

  // Buy-energy lifecycle: reset the button when the purchase settles, and surface
  // a payment error (wallet declined / intent expired). These MUST stay above the
  // early returns below — they are unconditional hooks. (When they sat after the
  // returns, entering 'battle' rendered more hooks than the prior 'base' render,
  // crashing React — and with no error boundary that unmounted the whole app,
  // black-screening every raid.)
  useEffect(() => { if (buyPhase === 'idle') setBuying(false); }, [buyPhase]);
  useEffect(() => { if (buyError) { playSfx('sfx_error'); toast(buyError); } }, [buyError]);
  useEffect(() => {
    if (!isReplay) return;
    const now = Date.now();
    replayRateRef.current = 1;
    replayClockRef.current = { anchorSimMs: 0, receivedAtMs: now, rate: 1, durationMs: 0 };
    replayPlayingRef.current = false;
    setReplayPlaying(false);
    progressPlanRef.current = null;
    progressPlayingRef.current = false;
    setReplayRate(1);
    setClockNowMs(now);
    bus.emit('battle:rate', { rate: 1 });
  }, [isReplay, raidTarget?.raidId]);
  useEffect(() => {
    if (isReplay) bus.emit('battle:rate', { rate: replayRate });
  }, [isReplay, replayRate]);
  useEffect(() => {
    if (!isReplay) return;
    return bus.on('battle:play', ({ events, fromTick = 0, terminal }) => {
      // The scene's silent seek owns completion; never start a competing HUD
      // timeline or overwrite its synchronous done event with playing.
      if (terminal) return;
      const final = resultRef.current ?? useApp.getState().raidTarget?.result;
      if (!final) return;
      const now = Date.now();
      const maxTick = events.at(-1)?.t ?? 0;
      replayClockRef.current = {
        anchorSimMs: fromTick * TICK_MS,
        receivedAtMs: now,
        rate: replayRateRef.current,
        durationMs: (maxTick + 10) * TICK_MS,
      };
      replayPlayingRef.current = true;
      setReplayPlaying(true);
      setClockNowMs(now);
      setPhase('playing');
      startProgressRef.current(events, final, fromTick);
    });
  }, [isReplay, raidTarget?.raidId]);

  const reconcileSpeedRequest = useCallback((currentRaid: RaidDto, request: {
    clientCommandId: string; expectedClockRevision: number; rate: 1 | 2;
  }): void => {
    if (currentRaid.raidProtocolVersion !== 2 || speedPendingRef.current) return;
    speedPendingRef.current = request;
    setSpeedPending(request);
    persistRaidPointer(currentRaid, phaseRef.current, liveClockRef.current, request);
    const wire = liveRaidSpeedRequest(
      currentRaid.id, request.clientCommandId, request.expectedClockRevision, request.rate,
    );
    const session = liveCommandSessionRef.current;
    const current = (): boolean => mountedRef.current && liveCommandSessionRef.current === session
      && raidRef.current?.id === currentRaid.id
      && useApp.getState().screen === 'battle';
    let definitive = false;
    let ambiguous = false;
    void (async () => {
      for (;;) {
        try {
          const receipt = await api.postRaw<LiveRaidControlReceipt>(wire.path, wire.body);
          if (current()) {
            session?.accepted.set(receipt.command.sequence, receipt.command);
            adoptClock(receipt.clock);
          }
          definitive = true;
          return;
        } catch (cause) {
          const stale = clockFromStaleRaidError(cause);
          if (stale) {
            if (current()) adoptClock(stale);
            definitive = true;
            return;
          }
          const uncertain = potentiallyCommittedLiveCommand(cause);
          if (!uncertain && !ambiguous) {
            definitive = true;
            throw cause;
          }
          ambiguous = true;
          // A lost reply may follow a committed write. Refresh presentation, but
          // only the exact same idempotent POST (or a stale CAS) can decide which
          // write won; never mint a replacement command id.
          let canonicalReadSucceeded = false;
          try {
            const canonical = await readCanonicalLiveCommands(currentRaid.id);
            if (!current()) return;
            canonicalReadSucceeded = true;
            for (const [sequence, command] of canonical.commands) session?.accepted.set(sequence, command);
            adoptClock(canonical.view.clock);
            if ([...canonical.commands.values()].some((command) => command.clientCommandId === request.clientCommandId)) {
              definitive = true;
              return;
            }
          } catch { /* the identical retry below remains authoritative */ }
          // Once a reply is lost, a later 4xx describes that retry only. Keep
          // the durable pointer unless the journal proves the original absent.
          if (!uncertain && canonicalReadSucceeded) {
            definitive = true;
            throw cause;
          }
          if (!current()) return;
          await new Promise((resolve) => setTimeout(resolve, LIVE_COMMAND_RECONCILE_MS));
          if (!current()) return;
        }
      }
    })().catch((cause: unknown) => {
      if (current()) toast(cause instanceof Error
        ? cause.message.toUpperCase() : 'SPEED CHANGE FAILED');
    }).finally(() => {
      if (!definitive || !current()
        || speedPendingRef.current?.clientCommandId !== request.clientCommandId) return;
      speedPendingRef.current = null;
      setSpeedPending(null);
      persistRaidPointer(currentRaid, phaseRef.current, liveClockRef.current, null);
      const target = useApp.getState().raidTarget;
      if (target?.raidId === currentRaid.id && target.inFlightSpeed) {
        useApp.getState().setRaidTarget({ ...target, inFlightSpeed: undefined });
      }
    });
  }, [adoptClock, persistRaidPointer]);

  useEffect(() => {
    const request = raidTarget?.inFlightSpeed;
    if (!raid || !request || raid.raidProtocolVersion !== 2) return;
    reconcileSpeedRequest(raid, request);
  }, [raid, raidTarget?.inFlightSpeed, reconcileSpeedRequest]);

  const changeRate = (rate: 1 | 2): void => {
    if (isReplay) {
      if (!replayPlayingRef.current || replayRateRef.current === rate) return;
      const now = Date.now();
      const clock = replayClockRef.current;
      const playheadMs = playbackPlayheadMs(
        clock.anchorSimMs, clock.receivedAtMs, now, clock.rate, clock.durationMs,
      );
      replayRateRef.current = rate;
      replayClockRef.current = {
        ...clock, anchorSimMs: playheadMs, receivedAtMs: now, rate,
      };
      setReplayRate(rate);
      setClockNowMs(now);
      const plan = progressPlanRef.current;
      if (plan) startProgressRef.current(
        plan.events, plan.final, Math.floor(playheadMs / TICK_MS),
      );
      return;
    }
    const currentRaid = raidRef.current;
    const clock = liveClockRef.current;
    if (!currentRaid || currentRaid.raidProtocolVersion !== 2 || !clock
      || phase !== 'playing' || speedPendingRef.current) return;
    const request = {
      clientCommandId: idemKey(), expectedClockRevision: clock.revision, rate,
    };
    reconcileSpeedRequest(currentRaid, request);
  };

  /** Keep the HUD on the same rate-aware simulator timeline as BattleScene. */
  const startProgress = (
    events: Array<{ t: number; e: string; n?: number }>, final: RaidResult, fromTick = 0,
  ): void => {
    if (simulationPendingRef.current || simulationFailedRef.current) return;
    progressTimers.current.forEach(clearTimeout); progressTimers.current = [];
    progressPlanRef.current = { events, final };
    progressPlayingRef.current = true;
    const rate = isReplay ? replayRateRef.current : liveClockRef.current?.rate ?? 1;
    const finalLoot = final.lootShards ?? 0;
    const maxTick = events.length ? (events[events.length - 1]!.t ?? 0) : 0;
    const destroyEvents = events.filter((ev) => ev.e === 'destroyed').length || 1;
    let destroyedSeen = 0;
    let starsSeen = 0;
    for (const ev of events) {
      if (ev.t >= fromTick) break;
      if (ev.e === 'star') starsSeen = ev.n ?? starsSeen + 1;
      else if (ev.e === 'destroyed') destroyedSeen++;
    }
    const initialRamp = Math.min(1, destroyedSeen / destroyEvents);
    setProgress({
      stars: starsSeen,
      loot: Math.round(finalLoot * initialRamp),
      keep: Math.round(final.attackerTrophyDelta * initialRamp),
      tick: fromTick,
    });
    if (fromTick === 0) setLivePct(0);
    for (const ev of events) {
      if (ev.t < fromTick || (ev.e !== 'star' && ev.e !== 'destroyed')) continue;
      const id = setTimeout(() => {
        if (ev.e === 'star') starsSeen = ev.n ?? starsSeen + 1;
        else destroyedSeen++;
        const ramp = Math.min(1, destroyedSeen / destroyEvents);
        setProgress((p) => ({
          stars: Math.max(p.stars, starsSeen),
          loot: Math.round(finalLoot * ramp),
          keep: Math.round(final.attackerTrophyDelta * ramp),
          tick: ev.t,
        }));
      }, playbackWallDelayMs((ev.t - fromTick) * TICK_MS, rate));
      progressTimers.current.push(id);
    }
    const pin = setTimeout(() => {
      setProgress({
        stars: final.stars,
        loot: finalLoot, keep: final.attackerTrophyDelta, tick: maxTick,
      });
      setLivePct(final.destructionPct);
    }, playbackWallDelayMs(Math.max(0, maxTick - fromTick + 9) * TICK_MS, rate));
    progressTimers.current.push(pin);
    armWallClockCommit(maxTick, fromTick, rate);
  };
  startProgressRef.current = startProgress;

  useMobileBackHandler(() => {
    if (screen !== 'battle') return false;
    if (raidRef.current && !isSpectator && phase !== 'done') setRetreatConfirm(true);
    else exitRef.current?.();
    return true;
  }, screen === 'battle', 140);

  // Result states (victory/defeat) render inside 'battle' via phase — they were
  // never separate screens (dead union members dropped, audit B7).
  if (screen !== 'battle') return null;

  const exit = (): void => {
    rewatchAttemptRef.current++;
    if (rewatchTimerRef.current) clearTimeout(rewatchTimerRef.current);
    rewatchTimerRef.current = null;
    setRewatching(false);
    // Retreating from a STARTED battle still commits it: the energy is already
    // spent and the troops were already thrown, so leaving it unposted would
    // strand the raid pending until it expired.
    if (battleStartRef.current > 0) {
      if (liveCommandModeRef.current) {
        // Never let FINISH overtake a deploy still in flight. The server queue
        // is canonical; resolve only after every locally initiated command has
        // either been accepted or surfaced as rejected.
        const leavingRaid = raidRef.current;
        const leavingSession = leavingRaid && liveCommandSessionRef.current?.raidId === leavingRaid.id
          ? liveCommandSessionRef.current : null;
        if (leavingRaid && !committedRef.current) {
          committedRef.current = true;
          void (leavingSession?.queue ?? Promise.resolve()).finally(() => {
            void api.postRaw<{ result: RaidResult }>(
              `/raids/${encodeURIComponent(leavingRaid.id)}/finish`, {},
            ).then(() => reloadBase()).catch((cause: Error) => {
              // The player already left. Never leak raid A's late finish failure
              // into a newly-entered raid B; its backstop remains server-owned.
              if (liveCommandSessionRef.current === leavingSession) {
                toast(cause.message.toUpperCase());
              }
            });
          });
        }
      } else commitRaid(false, true);
    }
    // Scene teardown is presentation work. A broken effect must not interrupt
    // clearing the React battle state or restoring the selected owned base.
    sceneCleanup('raid-ui-exit', () => bus.emit('battle:exit', undefined));
    progressTimers.current.forEach(clearTimeout); progressTimers.current = [];
    clearWallClockCommit();
    progressPlanRef.current = null;
    progressPlayingRef.current = false;
    replayPlayingRef.current = false;
    setRaid(null); setOrders([]); setHeroOrders([]); setUsed({}); setResult(null); setErr(null); setPhase('deploying');
    setReplayPlaying(false);
    setBuffs({ warhorn: false, swiftboots: false, powdercharge: false }); setRallyAt(null);
    setProgress(ZERO_PROGRESS); setLivePct(0); setCatchingUp(false);
    setFightOpen(false);
    setOutOfEnergy(false); setBuying(false); setNoTargets(null);
    setLiveClock(null); liveClockRef.current = null;
    setSpeedPending(null); speedPendingRef.current = null;
    replayRateRef.current = 1;
    setReplayRate(1); setRetreatConfirm(false); setRetreating(false);
    retreatingRef.current = false;
    nextTargetIntentRef.current = false;
    setNextTargetConfirm(false);
    createRequestRef.current = null;
    v2BatchModifiersQueuedRef.current = false;
    battleStartRef.current = 0; committedRef.current = false; simModsRef.current = {};
    liveCommandSessionRef.current = null;
    commitKeyRef.current = null;
    useApp.getState().setRaidTarget(null);
    const homeGuard = captureBaseSnapshotGuard();
    void reloadBase().catch(() => {
      if (isBaseSnapshotGuardCurrent(homeGuard) && useApp.getState().screen === 'base') {
        toast('BASE REFRESH FAILED — RECONNECT AND TRY AGAIN');
      }
    });
    setScreen('base');
  };
  exitRef.current = exit;

  const trainAfterRaid = (): void => { requestCommand(() => {
    exit();
    const state = useApp.getState();
    const base = state.base;
    state.consumeTrainingRequest();
    if (!base || base.player.wallet !== state.wallet
      || (state.selectedBaseId && state.selectedBaseId !== base.baseId)) {
      toast('BASE IS LOADING — OPEN YOUR BARRACKS WHEN IT IS READY');
      return;
    }
    // An upgrade is not underConstruction, but its action sheet cannot open
    // the training tray. Prefer a Barracks whose training control is usable.
    const barracks = base.buildings.find((building) => building.type === 'barracks'
      && !building.underConstruction && !base.jobs.some((job) => job.buildingId === building.id));
    if (!barracks) {
      const busyBarracks = base.buildings.find((building) => building.type === 'barracks');
      if (busyBarracks) {
        state.select(busyBarracks.id);
        bus.emit('base:focus', { kind: 'building', id: busyBarracks.id });
      }
      toast(busyBarracks ? 'FINISH BARRACKS WORK, THEN OPEN TRAINING' : 'BUILD A BARRACKS TO TRAIN TROOPS');
      return;
    }
    state.select(barracks.id);
    bus.emit('base:focus', { kind: 'building', id: barracks.id });
    state.requestTraining();
  }); };

  const requestExit = (): void => {
    if (!raid || isSpectator || phase === 'done') { exit(); return; }
    setRetreatConfirm(true);
  };

  const canChooseNextTarget = (): boolean => {
    const currentRaid = raidRef.current;
    const session = liveCommandSessionRef.current;
    return !!currentRaid?.defenderBaseId && !currentRaid.pveCampId && !currentRaid.campaignStage
      && currentRaid.raidProtocolVersion === 2 && !isSpectator && liveCommandModeRef.current
      && phaseRef.current === 'deploying' && !liveSyncUnavailable && !retreatingRef.current
      && battleStartRef.current === 0 && liveClockRef.current?.anchorWallAt === null
      && !!session?.hydrated && session.raidId === currentRaid.id && session.accepted.size === 0
      && !ordersRef.current.length && !heroOrdersRef.current.length
      && !Object.values(session.pendingTroops).some((count) => count > 0)
      && !session.pendingHeroes.size && !session.pendingBuffs.size && !session.pendingRally;
  };

  const confirmRetreat = (nextTarget = false): void => {
    const leavingRaid = raidRef.current;
    if (!leavingRaid || retreatingRef.current) return;
    if (nextTarget && !nextTargetIntentRef.current && !canChooseNextTarget()) {
      setNextTargetConfirm(false);
      toast('NEXT TARGET IS AVAILABLE BEFORE DEPLOYING');
      return;
    }
    if (nextTarget) nextTargetIntentRef.current = true;
    if (leavingRaid.raidProtocolVersion !== 2) {
      setRetreatConfirm(false);
      exit();
      return;
    }
    const session = liveCommandSessionRef.current?.raidId === leavingRaid.id
      ? liveCommandSessionRef.current : null;
    const guard = captureBaseSnapshotGuard();
    if (retreatAttemptRef.current?.timer) clearTimeout(retreatAttemptRef.current.timer);
    const attempt = { timedOut: false, timer: null as ReturnType<typeof setTimeout> | null };
    retreatAttemptRef.current = attempt;
    const current = (): boolean => mountedRef.current && retreatAttemptRef.current === attempt
      && liveCommandSessionRef.current === session && raidRef.current?.id === leavingRaid.id
      && isBaseSnapshotGuardCurrent(guard) && useApp.getState().screen === 'battle';
    const unlock = (): void => {
      if (attempt.timer) clearTimeout(attempt.timer);
      attempt.timer = null;
      retreatingRef.current = false;
      setRetreating(false);
    };
    const showResolved = (canonicalResult: RaidResult): void => {
      if (!current()) return;
      unlock();
      committedRef.current = true;
      resultRef.current = canonicalResult;
      setResult(canonicalResult);
      setErr(null);
      setRetreatConfirm(false);
      setNextTargetConfirm(false);
      setPhase('done');
      clearWallClockCommit();
      progressTimers.current.forEach(clearTimeout);
      progressTimers.current = [];
      // The normal terminal-result effect clears only this raid's pointer.
    };
    const reconcile = (): void => {
      const path = leavingRaid.attackerBaseId
        ? `/bases/${encodeURIComponent(leavingRaid.attackerBaseId)}/battles/${encodeURIComponent(leavingRaid.id)}/replay`
        : `/raids/${encodeURIComponent(leavingRaid.id)}/replay`;
      void api.get<{ result: RaidResult }>(path)
        .then((replay) => showResolved(replay.result))
        .catch(() => { /* Keep watching; the existing live poll also reconciles settlement. */ });
    };
    let sent = false;
    retreatingRef.current = true;
    setRetreating(true);
    clearWallClockCommit();
    attempt.timer = setTimeout(() => {
      if (!current()) return;
      attempt.timedOut = true;
      unlock();
      // A slow queued drop must not turn into a late retreat after STAY. Once
      // sent, timeout says nothing about whether the server accepted it: retain
      // the pointer and exact commit key, and read the canonical result only.
      toast(sent ? 'RETREAT NOT CONFIRMED — STAY TO WATCH OR RETRY'
        : 'RETREAT NOT SENT — STAY TO WATCH OR RETRY');
      if (sent) reconcile();
      commitRaid(false);
    }, COMMIT_WATCHDOG_MS);
    void (session?.queue ?? Promise.resolve()).then(async () => {
      if (!current() || attempt.timedOut) return;
      commitKeyRef.current ??= idemKey();
      const wire = liveRaidFinishRequest(leavingRaid.id, commitKeyRef.current);
      sent = true;
      const response = await api.postRaw<{ result: RaidResult }>(wire.path, wire.body);
      if (!current()) return;
      if (attempt.timedOut) { showResolved(response.result); return; }
      unlock();
      committedRef.current = true;
      const storage = browserRaidResumeStorage();
      const baseId = leavingRaid.attackerBaseId ?? homeBase?.baseId;
      if (storage && wallet && baseId) {
        clearRaidResumePointer(storage, wallet, baseId, leavingRaid.id);
      }
      if (nextTarget) {
        // Only a confirmed canonical settlement may release the old reservation.
        // Batch these store updates: no intermediate render can create a random raid.
        exit();
        useApp.getState().setRaidTarget({ kind: 'pvp', excludeBaseId: leavingRaid.defenderBaseId! });
        setScreen('battle');
      } else exitRef.current?.();
    }).catch((cause: unknown) => {
      if (!current()) return;
      unlock();
      setRetreatConfirm(false);
      const message = cause instanceof Error ? cause.message.toUpperCase() : 'RETREAT FAILED';
      setErr(message);
      toast(message);
      if (sent) reconcile();
      commitRaid(false);
    }).finally(() => {
      if (attempt.timer) clearTimeout(attempt.timer);
      attempt.timer = null;
    });
  };

  /**
   * Open a MAP BOARD, on the tab that was asked for.
   *
   * `mapTab` must be set EXPLICITLY every time: it lives in the store so the raid
   * chooser can deep-link CAMPAIGN, which means it persists — a `setScreen('map')`
   * with no tab lands on whatever the player last looked at. That was a real bug at
   * the end of the campaign (see replayAgain), where finishing the last stage
   * dropped the player on the PvP WORLD board instead of the campaign board they
   * had just come from.
   */
  const goToMap = (tab: 'world' | 'campaign'): void => {
    useApp.getState().setMapTab(tab);
    setScreen('map');
  };

  // Buy raid-energy — pay-per-action on-chain (v3): mint an 'energy' (or
  // 'energy_pack', 6 at the per-unit discount) deposit intent, pay via
  // shardkeep-core buy_sink through the wallet, and the grant lands when the
  // payment finalizes. Refilling does not authorize another raid; return home
  // so the player explicitly chooses their next target. The purchase hook drives
  // the wallet tx + verify poll.
  const buyEnergy = (kind: 'energy' | 'energy_pack' = 'energy'): void => {
    const guard = captureBaseSnapshotGuard();
    const target = useApp.getState().raidTarget;
    setBuying(true);
    void solPurchase(kind, {
      onDone: () => {
        if (!mountedRef.current || !isBaseSnapshotGuardCurrent(guard) || useApp.getState().screen !== 'battle'
          || useApp.getState().raidTarget !== target) return;
        playSfx('sfx_confirm'); haptic('light');
        toast(kind === 'energy_pack' ? `${RAID_ENERGY.packSize} ENERGY PURCHASED` : 'ENERGY PURCHASED');
        exit();
      },
    });
  };
  /** Re-run a spectated replay from the top. Re-fetches rather than caching the
   *  event array: raidTarget carries the raidId, the bundle is small, and this
   *  keeps ONE source of the events (the server) instead of two. */
  const watchAgain = (): void => {
    const target = useApp.getState().raidTarget;
    const id = target?.raidId;
    if (!id || rewatching) return;
    const replayPath = savedReplayPath(target, id);
    const guard = captureBaseSnapshotGuard();
    const attempt = ++rewatchAttemptRef.current;
    const current = (): boolean => mountedRef.current && rewatchAttemptRef.current === attempt
      && isBaseSnapshotGuardCurrent(guard) && useApp.getState().screen === 'battle'
      && useApp.getState().raidTarget === target;
    if (rewatchTimerRef.current) clearTimeout(rewatchTimerRef.current);
    rewatchTimerRef.current = null;
    setRewatching(true);
    replayRateRef.current = 1;
    replayPlayingRef.current = false;
    setReplayPlaying(false);
    progressPlayingRef.current = false;
    setReplayRate(1);
    progressTimers.current.forEach(clearTimeout); progressTimers.current = [];
    void api.get<{ snapshot: unknown; visualContext?: BaseVisualContext | undefined; boundCosmeticVisual?: BoundCosmeticBaseRead | undefined; simVersion: number; orders?: Parameters<typeof battleHealthContext>[0];
      armySnapshot?: { levels?: Record<string, number>; counts?: Record<string, number>; heroLevels?: Record<string, number>; heroLoadouts?: Partial<Record<HeroKey, HeroCombatLoadout>> }; events: Array<{ t: number; e: string; n?: number }> }>(replayPath)
      .then((rep) => {
        if (!current()) return;
        setProgress(ZERO_PROGRESS); setLivePct(0);
        setPhase('playing');
        // counts are NOT `?? {}`-coalesced like levels: absent counts must read
        // as "unknown, load every levelled atlas", while {} would read as
        // "zero of everything, load none" (see battle:enter in lib/events.ts).
        bus.emit('battle:enter', {
          snapshot: rep.snapshot,
          visualContext: rep.visualContext, boundCosmeticVisual: rep.boundCosmeticVisual,
          armyLevels: rep.armySnapshot?.levels ?? {},
          armyCounts: rep.armySnapshot?.counts,
          heroLevels: rep.armySnapshot?.heroLevels,
        });
        // Same 80ms beat RaidLog uses: the scene must finish building the board
        // before the event stream starts, or the first ticks play into nothing.
        rewatchTimerRef.current = setTimeout(() => {
          rewatchTimerRef.current = null;
          if (current()) bus.emit('battle:play', { ...battleHealthContext(rep.orders, rep.armySnapshot?.heroLoadouts), events: rep.events, simVersion: rep.simVersion });
        }, 80);
      })
      .catch((e: Error) => { if (current()) { playSfx('sfx_error'); toast(e.message.toUpperCase()); } })
      .finally(() => { if (current()) setRewatching(false); });
  };

  const replayAgain = (): void => {
    // A deliberate new march owns a fresh create key and scene. A null automatic
    // target is otherwise identical to the previous one: reusing its cached key
    // correctly returns the already-settled raid and loops back to Victory.
    // Close the synchronous latch before React renders so a double click cannot
    // advance two stages or open two chargeable create attempts.
    if (phaseRef.current !== 'done' || !resultRef.current) return;
    phaseRef.current = 'deploying';
    const prev = raidTarget;
    exit();
    if (prev?.kind === 'campaign' && prev.stage) {
      const next = prev.stage + 1;
      if (next > CAMPAIGN.tierByStage.length) {
        goToMap('campaign');
        return;
      }
      useApp.getState().setRaidTarget({ kind: 'campaign', stage: next, name: `STAGE ${next}` });
    }
    setScreen('battle');
  };

  if (simulationFailed) return <Panel>
    <div role="alert">BATTLE DISPLAY UNAVAILABLE</div>
    <div style={{ color: C.textDim }}>RELOAD TO RESTORE THE SERVER'S RAID STATE.</div>
    <Btn style={{ minHeight: 44 }} onClick={() => window.location.reload()}>RELOAD GAME</Btn>
  </Panel>;

  // Full-screen blocker ONLY when the raid never got created (nothing to go back
  // to). A submit failure keeps the raid alive — the deploy window is still open
  // for up to 60s, so the error renders INLINE in the deploying tray instead of
  // replacing it with a panel whose only exit abandoned a retryable raid.
  if (!raid && raidTarget?.reconnecting) {
    return (
      <Panel>
        <div role="status">RAID OFFLINE · RECONNECTING</div>
        <div style={{ color: C.textDim }}>YOUR RAID IS SAFE. WE WILL RESUME FROM THE SERVER CLOCK.</div>
        <Btn variant="sec" onClick={() => useApp.getState().setRaidTarget({
          ...raidTarget, recoveryEpoch: Date.now(),
        })}>TRY AGAIN</Btn>
      </Panel>
    );
  }
  if (err && !raid && !(isReplay && raidTarget?.resumeTerminal)) {
    return (
      <Panel>
        {/* The DEEDLESS empty pool is not an error the player made, so it replaces
            the red server line instead of hanging beneath it (see raidNoTargets).
            Every other failure — including the LANDOWNER's empty ladder — renders
            exactly as it always has. */}
        {noTargets === 'deedless'
          ? (
            <DeedlessNoTargets
              entryFeeSol={ECONOMY.entryFeeSol}
              // `exit` first, so the abandoned raid target is cleared and the base
              // reloaded exactly as BACK TO BASE does it — then we route.
              onCampaign={() => { exit(); goToMap('campaign'); }}
              // The same sheet every other land refusal lands in, opened as
              // 'browse': nothing was REFUSED here (the pool is simply empty), and
              // a sheet saying "that needs land you do not own" would be a lie.
              onBuyLand={() => { exit(); useApp.getState().setLandPrompt('browse'); }}
            />
          )
          : <div style={{ color: C.danger }}>{err}</div>}
        {outOfEnergy && (
          <>
            {/* Pack first — it is the intended value buy; the single is the impulse top-up. */}
            <Btn disabled={buying} onClick={() => buyEnergy('energy_pack')}>
              <Icon name="sol" size={20} />BUY {RAID_ENERGY.packSize} ENERGY · {RAID_ENERGY.packLamports / 1e9} SOL
            </Btn>
            <Btn variant="sec" disabled={buying} onClick={() => buyEnergy('energy')}>
              <Icon name="sol" size={20} />BUY 1 · {RAID_ENERGY.solLamportsPerEnergy / 1e9} SOL
            </Btn>
          </>
        )}
        {noTargets === 'ladder' && (
          <>
            {/* The server's own advice was "try the world map or PvE". These are
                those two places. `exit` runs first so the abandoned raid target is
                cleared and the base reloaded exactly as BACK TO BASE does it — then
                the board opens on the tab that was actually named. */}
            <Btn onClick={() => { exit(); goToMap('world'); }}>WORLD MAP</Btn>
            <Btn variant="sec" onClick={() => { exit(); goToMap('campaign'); }}>CAMPAIGN</Btn>
          </>
        )}
        {raidTarget?.excludeBaseId && !noTargets && !outOfEnergy && (
          <Btn onClick={() => { setErr(null); setRetry((value) => value + 1); }}>TRY AGAIN</Btn>
        )}
        <Btn variant="sec" onClick={exit}>BACK TO BASE</Btn>
      </Panel>
    );
  }


  // During playback the HUD reads live progress; at deploy it reads zero; on
  // done it falls back to the server-resolved result. Replays start resolved.
  const hudStars = phase === 'playing' ? progress.stars : (result?.stars ?? 0);
  const hudDestroyed = phase === 'playing' ? livePct : (result?.destructionPct ?? 0);
  const hudLoot = result?.lootRedacted
    ? null
    : phase === 'playing' ? progress.loot : (result?.lootShards ?? 0);
  const hudTrophies = phase === 'playing' ? progress.keep : (result?.attackerTrophyDelta ?? 0);

  // SPECTATOR REPLAY — checked BEFORE the verdict modal on purpose (owner
  // 2026-07-26: "this DEFEAT window does not let you properly watch it and goes to
  // raid log or home straight away"). You are reviewing a raid that already
  // happened, so slamming a VICTORY/DEFEAT verdict over the base the moment
  // playback ends — with both buttons wired to exit — was the wrong shape. The
  // spectator keeps its HUD, and when playback finishes it offers WATCH AGAIN.
  if (isSpectator) {
    return (
      <>
        {raidTarget?.reconnecting && (
          <div role="status" className="interactive" style={{ position: 'absolute', top: 74, left: 12, right: 12, zIndex: 1400, textAlign: 'center', color: C.goldHi }}>
            RAID OFFLINE · RECONNECTING
          </div>
        )}
        {isReplay && raidTarget?.resumeTerminal && phase === 'deploying' && (
          <div role={err ? 'alert' : 'status'} className="interactive" style={{ position: 'absolute', left: 12, right: 12, bottom: 14, zIndex: 1200, padding: 10, textAlign: 'center', color: C.goldHi, background: 'rgba(16,14,20,.92)' }}>
            {err ?? 'RESTORING RAID RESULT…'}
            {err && <Btn variant="sec" fontSize={16} onClick={() => setRetry((value) => value + 1)}>RETRY</Btn>}
          </div>
        )}
        <BattleHud
          stars={hudStars} destroyed={hudDestroyed} loot={hudLoot} trophies={hudTrophies}
          phase={phase} buffs={buffs} timerLabel={isLiveSpectator ? 'LIVE' : 'REPLAY'}
          battleStartMs={isLiveSpectator ? livePlaybackStartedAtRef.current : undefined}
          catchingUp={catchingUp || simulationPending}
          playheadMs={isLiveSpectator
            ? canonicalPlayheadMs ?? undefined
            : replayPlayheadMs ?? undefined}
          rate={isReplay ? replayRate : liveClock?.rate ?? 1}
          onRate={isReplay && phase === 'playing' ? changeRate : undefined}
          onEnd={exit} spectator measureRef={battleHudRef}
        />
        <CameraPills bottom={72 + safeArea.bottom} right={10 + safeArea.right} />
        {isLiveSpectator && phase === 'deploying' && (
          <div className="interactive" style={{ position: 'absolute', left: 12, right: 12, bottom: 14, zIndex: 1200, padding: 10, textAlign: 'center', color: C.goldHi, background: 'rgba(16,14,20,.92)', border: `2px solid ${C.border}` }}>
            ATTACKER IS PREPARING · LIVE STREAM WILL START WITH THE FIRST DEPLOY
          </div>
        )}
        {isLiveSpectator && err && (
          <div role="alert" className="interactive" style={{ position: 'absolute', left: 12, right: 12, bottom: 64, zIndex: 1201, padding: 8, textAlign: 'center', color: C.danger, background: 'rgba(20,14,14,.95)', border: `2px solid ${C.danger}` }}>
            {err} · RETRYING
          </div>
        )}
        {phase === 'done' && (
          <div className="interactive" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 1200, display: 'flex', gap: 10, justifyContent: 'center', padding: 12, background: 'linear-gradient(transparent, rgba(16,14,20,.96) 40%)' }}>
            <span style={{ alignSelf: 'center', fontSize: 15, color: C.textDim }}>
              {isLiveSpectator ? 'LIVE BATTLE SETTLED' : 'REPLAY ENDED'} · {result?.destructionPct ?? 0}% · {result?.stars ?? 0}★
            </span>
            <Btn variant="sec" fontSize={16} disabled={rewatching} onClick={watchAgain}>
              {rewatching ? 'LOADING…' : '↻ WATCH AGAIN'}
            </Btn>
            <Btn fontSize={16} onClick={exit}>CLOSE</Btn>
          </div>
        )}
      </>
    );
  }

  // RESOLVING — the fight is over and the server is deciding it. A verdict is
  // NEVER rendered from a missing result: `won = (result?.stars ?? 0) > 0` reads
  // false for "no answer yet" and for "the POST failed", which is how a won raid
  // showed DEFEAT (owner 2026-07-28). A failed commit is retryable here — the
  // raid is still pending_orders server-side until it resolves.
  if (phase === 'committing' || (phase === 'done' && !result)) {
    // D-096: an expired raid cannot be re-posted — RETRY would only 422 again.
    const retryable = err !== RAID_EXPIRED_COPY;
    return (
      <Panel>
        {err ? <div style={{ color: C.danger }}>{err}</div> : 'RESOLVING RAID…'}
        {err && (
          <>
            {retryable && (
              <Btn fontSize={16} onClick={() => {
                setErr(null);
                setPhase('committing');
                // Live FINISH must remain behind the raid session's command queue,
                // including a command still reconciling an ambiguous response.
                // Calling commitRaid directly here could close the stream while
                // the exact-id retry was between POST attempts.
                commitRaidRef.current?.();
              }}>
                ↻ RETRY
              </Btn>
            )}
            <Btn variant="sec" fontSize={16} onClick={requestExit}>BACK TO BASE</Btn>
          </>
        )}
      </Panel>
    );
  }

  // result screens (victory / defeat) — live raids only; replays returned above.
  if (phase === 'done') {
    const won = (result?.stars ?? 0) > 0;
    return won
      ? <VictoryScreen result={result} onHome={exit} onTrain={trainAfterRaid} onNext={replayAgain} homePrimary={onboardingRaid}
          nextLabel={raidTarget?.kind === 'campaign'
            ? ((raidTarget.stage ?? 0) < CAMPAIGN.tierByStage.length ? 'NEXT STAGE' : 'CAMPAIGN MAP')
            : 'NEXT RAID'} />
      : <DefeatScreen result={result} onHome={exit} onReplay={exit} onTrain={trainAfterRaid} />;
  }

  // Matchmaking in flight. The request has no client timeout (api.ts carries no
  // AbortSignal), so this panel MUST carry its own exit — otherwise a hung
  // request strands the player with no navbar (BaseHud is inBase-gated).
  if (!raid) {
    if (shieldGate) {
      return (
        <Panel>
          <span role="alert" data-shield-break-warning>
            ATTACKING DROPS YOUR SHIELD ({fmtDur(shieldAtStakeSec ?? 0)} REMAINING). PROCEED?
          </span>
          <Btn onClick={() => setShieldAck(true)}>PROCEED · DROP SHIELD</Btn>
          <Btn variant="sec" onClick={exit}>BACK TO BASE</Btn>
        </Panel>
      );
    }
    return (
      <Panel>
        {raidTarget?.kind === 'campaign' ? 'PREPARING THE CAMPAIGN…' : 'FINDING A TARGET…'}
        <Btn variant="sec" onClick={exit}>BACK TO BASE</Btn>
      </Panel>
    );
  }

  const submit = async (): Promise<void> => {
    setErr(null); // a retry starts clean — stale inline errors must not linger
    if (liveCommandMode) {
      // The first accepted deploy already started the authoritative clock and
      // local deterministic playback. There is no batch submit in command mode.
      if (battleStartRef.current === 0) toast('DEPLOY A UNIT TO START THE RAID');
      else setPhase('playing');
      return;
    }
    setPhase('submitting');
    if (!raid) return;
    const journalSession = batchJournalMode && liveCommandSessionRef.current?.raidId === raid.id
      ? liveCommandSessionRef.current : null;
    if (journalSession && journalSession.pendingBuffs.size > 0) {
      // Do not start an unbuffed local fight while its purchase is unresolved.
      // The callback reads the accepted journal below, not a stale render.
      void journalSession.queue.then(() => {
        if (liveCommandSessionRef.current === journalSession
          && raidRef.current?.id === raid.id) submitRef.current?.();
      });
      return;
    }
    if (batchJournalMode && raid.raidProtocolVersion === 2
      && (liveClockRef.current?.anchorWallAt ?? null) === null) {
      const session = liveCommandSessionRef.current?.raidId === raid.id
        ? liveCommandSessionRef.current : null;
      if (!session || !session.hydrated) { setPhase('deploying'); toast('RESTORING YOUR RAID…'); return; }
      if (!v2BatchModifiersQueuedRef.current) {
        v2BatchModifiersQueuedRef.current = true;
        if (rallyAt && rallyUnlocked) {
          queueLiveCommand(raid, { kind: 'rally', payload: { tx: rallyAt.tx, ty: rallyAt.ty } });
        }
      }
      void session.queue.then(async () => {
        let clock = liveClockRef.current;
        if (!clock) {
          const canonical = await readCanonicalLiveCommands(raid.id);
          clock = canonical.view.clock;
          adoptClock(clock);
        }
        try {
          const wire = liveRaidStartRequest(raid.id, idemKey(), clock.revision);
          const receipt = await api.postRaw<LiveRaidControlReceipt>(wire.path, wire.body);
          if (liveCommandSessionRef.current !== session || raidRef.current?.id !== raid.id) return;
          session.accepted.set(receipt.command.sequence, receipt.command);
          adoptClock(receipt.clock);
        } catch (cause) {
          const stale = clockFromStaleRaidError(cause);
          if (!stale || stale.anchorWallAt === null) throw cause;
          adoptClock(stale);
        }
        if (raidRef.current?.id === raid.id) submitRef.current?.();
      }).catch((cause: unknown) => {
        if (raidRef.current?.id !== raid.id) return;
        setPhase('deploying');
        setErr(cause instanceof Error ? cause.message : 'RAID START FAILED');
      });
      return;
    }
    const body: Record<string, unknown> = { deploys: orders, idempotencyKey: idemKey() };
    if (heroOrders.length) body['heroDeploys'] = heroOrders;
    const acceptedBuffs = journalSession
      ? hydrateLiveOrders([...journalSession.accepted.values()]).buffs ?? {} : buffs;
    const chosen = (Object.keys(buffs) as BuffKey[]).filter((k) => acceptedBuffs[k]);
    if (chosen.length > 0) body['buffs'] = Object.fromEntries(chosen.map((k) => [k, true]));
    if (rallyAt && rallyUnlocked) body['rally'] = { tx: rallyAt.tx, ty: rallyAt.ty, tMs: 0 };
    // A3a — START PLAYBACK LOCALLY, don't wait for the server. packages/sim is pure
    // and deterministic and the client holds the SAME four inputs the server will
    // use (snapshot, orders, seed, troopLevels), so the local event stream IS the
    // server's stream. This takes the round-trip off the critical path, and it is
    // the foundation for deploying mid-battle (A3b): the server cannot be consulted
    // while a battle is already running.
    // The server remains AUTHORITATIVE for the RESULT — loot and trophies are
    // economy, not simulation, so they only exist in its reply.
    // The two casts below cross the sim's boundary: RaidUI holds `troop` as a plain
    // string (it comes from TROOP_TYPES, so every value IS a TroopType) and the
    // playback bus speaks a structural {t,e,n?} rather than the SimEvent union.
    type PlaybackEvent = { t: number; e: string; n?: number };
    simModsRef.current = {
      ...(body['buffs'] ? { buffs: body['buffs'] } : {}),
      ...(body['rally'] ? { rally: body['rally'] } : {}),
    };
    // Rally follows the pre-battle drops. Timeless buffs were already accepted
    // before those units and must never be purchased again at ATTACK.
    if (batchJournalMode && !v2BatchModifiersQueuedRef.current) {
      if (rallyAt && rallyUnlocked) {
        queueLiveCommand(raid, { kind: 'rally', payload: {
          tx: rallyAt.tx, ty: rallyAt.ty,
          ...(raid.raidProtocolVersion === 2 ? {} : { tMs: 0 }),
        } });
      }
    }
    const presentation = await simulatePresentation({
      simVersion: raid.simVersion, snapshot: raid.snapshot as Parameters<typeof simulateRaid>[0],
      orders: {
        deploys: orders as Parameters<typeof simulateRaid>[1]['deploys'],
        ...(heroOrders.length ? { heroDeploys: withHeroLevels(
          heroOrders, raid.armySnapshot.heroLevels, raid.armySnapshot.heroLoadouts,
        ) } : {}),
        ...(body['buffs'] ? { buffs: body['buffs'] as never } : {}),
        ...(body['rally'] ? { rally: body['rally'] as never } : {}),
      }, seed: raid.seed, options: { troopLevels: raid.armySnapshot.levels as never },
    }, raid.id);
    if (!presentation?.current()) return; // rendering failure cannot finish, retreat, or redeploy a raid
    const local = presentation.outcome;
    const localEvents = local.events as unknown as PlaybackEvent[];
    const clock = raid.raidProtocolVersion === 2 ? liveClockRef.current : null;
    const now = Date.now();
    const canonicalMs = clock ? liveRaidPlayheadMs(clock, liveClockReceivedAtRef.current, now) : 0;
    const fromTick = Math.floor(canonicalMs / TICK_MS);
    battleStartRef.current = now - canonicalMs / (clock?.rate ?? 1);
    setPhase('playing');
    startProgress(localEvents, { stars: local.stars, destructionPct: local.destructionPct,
      keepDestroyed: local.keepDestroyed, lootShards: 0, attackerTrophyDelta: 0 }, fromTick);
    bus.emit('battle:play', { ...presentation.healthContext, events: localEvents as never, simVersion: raid.simVersion,
      ...(fromTick > 0 ? { fromTick } : {}), ...fightOpenFlag() });
    // The complete accepted order list settles only at the ordinary battle end.
  };

  submitRef.current = submit;
  commitRaidRef.current = () => {
    if (!liveCommandModeRef.current) return commitRaid(true);
    const currentRaid = raidRef.current;
    const session = currentRaid && liveCommandSessionRef.current?.raidId === currentRaid.id
      ? liveCommandSessionRef.current : null;
    if (!currentRaid || !session || committedRef.current) return false;
    // The caller enters the committing state immediately; FINISH is sequenced
    // after the last command so it cannot close the stream ahead of a tap.
    void session.queue.finally(() => {
      if (liveCommandSessionRef.current === session && raidRef.current?.id === currentRaid.id) {
        commitRaid(true);
      }
    });
    return true;
  };

  const toggleBuff = (k: BuffKey): void => {
    if (retreatingRef.current || nextTargetIntentRef.current) return;
    if (liveCommandMode || batchJournalMode) {
      const currentRaid = raidRef.current;
      if (!currentRaid) return;
      const session = liveCommandSessionRef.current?.raidId === currentRaid.id
        ? liveCommandSessionRef.current : null;
      if (!session?.hydrated) { toast('RECONNECTING LIVE RAID…'); return; }
      if (phase !== 'deploying' || ordersRef.current.length || heroOrdersRef.current.length
        || session.pendingHeroes.size || Object.values(session.pendingTroops).some((n) => n > 0)
        || [...session.accepted.values()].some((command) => command.kind === 'deploy' || command.kind === 'hero')) {
        toast('CHOOSE BUFFS BEFORE DEPLOYING YOUR FIRST UNIT');
        return;
      }
      if (buffs[k] || session.pendingBuffs.has(k)
        || [...session.accepted.values()].some((command) => command.kind === 'buff' && command.payload.buff === k)) return;
      session.pendingBuffs.add(k);
      queueLiveCommand(currentRaid, { kind: 'buff', payload: { buff: k } }, (accepted) => {
        session.pendingBuffs.delete(k);
        if (accepted) setBuffs((before) => ({ ...before, [k]: true }));
      });
      return;
    }
    // Toast OUTSIDE the setBuffs updater: React runs updater fns during the
    // render phase, so emitting to ToastHost there triggers a setState-in-render
    // warning. Decide `next` from current state, then commit + toast in the handler.
    const next = !buffs[k];
    if (next) toast(BUFF_DEFS.find((d) => d.key === k)!.toast);
    setBuffs((b) => ({ ...b, [k]: !b[k] }));
  };

  const toggleRally = (): void => {
    if (retreatingRef.current || nextTargetIntentRef.current) return;
    if (!rallyUnlocked) { toast(`RALLY UNLOCKS AT KEEP ${RALLY.unlockKeepLevel}`); return; }
    if (liveCommandMode) {
      const currentRaid = raidRef.current;
      if (!currentRaid || phase !== 'playing') { toast('DEPLOY A UNIT BEFORE SETTING RALLY'); return; }
      const session = liveCommandSessionRef.current?.raidId === currentRaid.id
        ? liveCommandSessionRef.current : null;
      if (!session?.hydrated) { toast('RECONNECTING LIVE RAID…'); return; }
      if (rallyAt || session.pendingRally) return;
      const mid = Math.floor((claim.min + claim.max) / 2);
      session.pendingRally = true;
      queueLiveCommand(currentRaid, { kind: 'rally', payload: { tx: mid, ty: mid } }, () => {
        session.pendingRally = false;
      });
      return;
    }
    if (rallyAt) { setRallyAt(null); toast('RALLY POINT CLEARED'); return; }
    // one pulse per raid, anchored to the defender's claim centre (derived from
    // the snapshot bounds, so it tracks the centered base and any expansion —
    // a hardcoded coord pointed off-base after centering).
    const mid = Math.floor((claim.min + claim.max) / 2);
    setRallyAt({ tx: mid, ty: mid });
    toast('RALLY! TROOPS CONVERGE');
  };

  const buffCost = (Object.keys(buffs) as BuffKey[]).reduce((s, k) => (buffs[k] ? s + BUFF_DEFS.find((d) => d.key === k)!.cost : s), 0);
  const cameraControls = raidCameraControlLayout(viewport, deployLayout, trayH, safeArea);

  return (
    <>
      {(raidTarget?.reconnecting || liveSyncUnavailable) && (
        <div role="status" className="interactive" style={{ position: 'absolute', top: 74, left: 12, right: 12, zIndex: 1400, textAlign: 'center', color: C.goldHi }}>
          RAID OFFLINE · RECONNECTING
        </div>
      )}
      <BattleHud
        stars={hudStars} destroyed={hudDestroyed} loot={hudLoot} trophies={hudTrophies}
        phase={phase} buffs={buffs} timerLabel={undefined}
        deadline={phase === 'deploying' ? new Date(deployEndsAtMs).toISOString() : undefined}
        playTick={phase === 'playing' ? progress.tick : undefined}
        battleStartMs={battleStartRef.current}
        playheadMs={canonicalPlayheadMs ?? undefined}
        catchingUp={catchingUp || simulationPending}
        rate={liveClock?.rate ?? 1}
        onRate={raid.raidProtocolVersion === 2 && phase === 'playing' && !liveSyncUnavailable ? changeRate : undefined}
        ratePending={speedPending !== null}
        rateUnavailableReason={raidSpeedUnavailableReason(raid.raidProtocolVersion, phase, liveSyncUnavailable, speedPending !== null)}
        onToggleBuff={phase === 'deploying' ? toggleBuff : undefined} onEnd={requestExit} targetName={raidTarget?.name}
        liveControls={liveCommandMode} measureRef={battleHudRef}
        deploymentHint={(phase === 'deploying' || phase === 'playing') && (
          <div data-testid="raid-deployment-hint" style={{ alignSelf: 'flex-start', maxWidth: '100%',
            boxSizing: 'border-box', background: 'rgba(20,18,26,.92)', border: `2px solid ${C.border}`,
            padding: '4px 10px', fontSize: 16, color: C.textDim }}>
            {nextTargetIntentRef.current
              ? (retreating ? 'CONFIRMING RETREAT…' : 'RETREAT UNCONFIRMED · RETRY NEXT TARGET')
              : phase === 'playing' ? 'DEPLOY RESERVES' : 'TAP THE FIELD TO DEPLOY'}
            {!nextTargetIntentRef.current && (troop === 'hero:vex' ? ' · VEX, THE SHARDBORN' : troop === 'hero:theodor' ? ' · THEODOR, THE TSIODORA' : TROOP_DISPLAY[troop] ? ` · ${TROOP_DISPLAY[troop]}` : '')}
            {phase === 'deploying' && buffCost > 0 && <span style={{ color: C.goldHi }}> · BUFFS −{buffCost} KEEP</span>}
          </div>
        )}
      />
      {/* submit failed but the raid is still live (deploy window open) — show the
          error where the player can act on it and RETRY/RETREAT, never a dead end */}
      {phase === 'deploying' && err && (
        // pointer-events only on the MESSAGE: an interactive full-width wrapper
        // swallowed deploy taps across its whole band, including the transparent
        // flanks — exactly while telling the player to fix their deploy.
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: trayH + 8, zIndex: 1250, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
          <span className="interactive" style={{ background: 'rgba(20,14,14,.95)', border: `2px solid ${C.danger}`, color: C.danger, padding: '4px 12px', fontSize: 16 }}>
            {err} — FIX & ATTACK AGAIN, OR RETREAT
          </span>
        </div>
      )}
      {/* D-106: the deployed troops fell but the fight is still on — say so
          where the player is looking, or an empty field under a running clock
          reads as a stall. Same band as the deploy error, no pointer capture. */}
      {phase === 'playing' && fightOpen && (
        <div data-testid="raid-fight-open" style={{ position: 'absolute', left: 0, right: 0, bottom: trayH + 8, zIndex: 1250, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
          <span style={{ background: 'rgba(16,14,20,.92)', border: `2px solid ${C.border}`, color: C.goldHi, padding: '4px 12px', fontSize: 14, textAlign: 'center' }}>
            YOUR TROOPS FELL — THE FIGHT IS STILL ON · DEPLOY MORE OR RETREAT
          </span>
        </div>
      )}
      {/* The tray stays up DURING the fight too (A3b) — reserves are useless if you
          cannot reach them once the battle starts. ATTACK/RETREAT swap to a single
          RETREAT once the raid is running. */}
      {(phase === 'deploying' || phase === 'playing') && (
        <div ref={trayRef} className="interactive" style={{
          position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 1200,
          display: 'flex', flexDirection: deployLayout.oneRow ? 'row' : 'column',
          // Wrapped action labels must not shrink the roster and clip its names.
          // The measured complete tray supplies the camera inset below.
          alignItems: 'stretch', gap: 8,
          boxSizing: 'border-box', paddingTop: 8, paddingRight: 8 + safeArea.right,
          paddingBottom: 8 + safeArea.bottom, paddingLeft: 8 + safeArea.left,
          pointerEvents: 'none',
        }}>
          {/* Cards get their OWN full-width, horizontally-scrolling row; the
              actions get a second row. As ONE flex row, 8 troop cards + heroes +
              RALLY + RETREAT + ATTACK came to ~530px on a 390px phone: it wrapped
              into three rows and ate the battlefield the camera work just gave
              back, and the cards were squeezed to ~100px of visible strip. */}
          <div data-testid="raid-deploy-roster" aria-label="DEPLOYMENT ROSTER" style={{
            ...RAID_TRAY_SCROLL_STYLE,
            flex: deployLayout.oneRow ? '1 1 auto' : '0 0 auto', minWidth: 0, alignItems: 'stretch', gap: 8, pointerEvents: 'auto',
          }}>
            {raidDeployTrayTroops(raid.armySnapshot).map((t) => {
              const session = liveCommandSessionRef.current?.raidId === raid.id
                ? liveCommandSessionRef.current : null;
              const have = (raid.armySnapshot.counts[t] ?? 0) - (used[t] ?? 0)
                - (session?.pendingTroops[t] ?? 0);
              const total = raid.armySnapshot.counts[t] ?? 0;
              const depleted = have <= 0;
              const sel = troop === t;
              return (
                <button key={t} type="button" className="interactive"
                  data-testid="raid-troop-card" aria-pressed={sel} aria-disabled={depleted}
                  aria-label={`${TROOP_DISPLAY[t] ?? t}, ${Math.max(0, have)} remaining`}
                  onClick={() => { if (depleted) { toast('NONE LEFT'); return; } setTroop(t); }}
                  style={{ position: 'relative', flex: '0 0 auto', width: deployLayout.cardWidth,
                    minHeight: deployLayout.cardHeight, boxSizing: 'border-box', appearance: 'none',
                    fontFamily: 'inherit', background: sel ? 'rgba(227,174,60,.16)' : C.card,
                    color: C.text, border: `3px solid ${sel ? C.goldHi : C.border}`,
                    boxShadow: sel ? `inset 0 0 0 2px ${C.goldDp}` : `inset 0 -3px 0 ${C.ink}`,
                    padding: '4px 3px 3px', display: 'flex', flexDirection: 'column',
                    justifyContent: 'center', alignItems: 'center', cursor: 'pointer',
                    opacity: total === 0 || depleted ? 0.45 : 1 }}>
                  {/* Frozen armySnapshot.levels is a REAL server level, so the
                      dragon/giant cards show the researched tier's portrait
                      (troopPortrait documents the level rule). */}
                  <Sprite name={troopPortrait(t, raid.armySnapshot.levels[t])}
                    w={deployLayout.artSize} h={deployLayout.artSize} />
                  <span style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap', fontSize: 12, color: sel ? C.goldHi : C.textDim,
                    lineHeight: 1 }}>{TROOP_DISPLAY[t] ?? t.toUpperCase()}</span>
                  <span style={{ position: 'absolute', right: 3, top: 3, minWidth: 24,
                    padding: '1px 3px', fontSize: 18, lineHeight: 1, color: C.goldHi,
                    background: C.ink, border: `1px solid ${sel ? C.goldHi : C.border}` }}>
                    ×{Math.max(0, have)}
                  </span>
                </button>
              );
            })}
            {/* D4a hero cards: recruited heroes from the frozen snapshot; one drop each. */}
            {(raid.armySnapshot.heroes ?? []).map((h) => {
              const key = `hero:${h}`;
              const session = liveCommandSessionRef.current?.raidId === raid.id
                ? liveCommandSessionRef.current : null;
              const dropped = heroOrders.some((o) => o.hero === h) || session?.pendingHeroes.has(h);
              const sel = troop === key;
              return (
                <button key={key} type="button" className="interactive"
                  aria-pressed={sel} aria-disabled={dropped}
                  aria-label={`${h === 'vex' ? 'VEX' : 'THEODOR'} HERO, ${dropped ? 'already fighting' : 'ready'}`}
                  onClick={() => { if (dropped) { toast('ALREADY FIGHTING'); return; } setTroop(key); }}
                  style={{ position: 'relative', flex: '0 0 auto', width: deployLayout.cardWidth,
                    minHeight: deployLayout.cardHeight, boxSizing: 'border-box', appearance: 'none',
                    fontFamily: 'inherit', background: sel ? 'rgba(227,174,60,.16)' : C.card,
                    border: `3px solid ${sel ? C.goldHi : C.goldDp}`, padding: '4px 3px 3px',
                    display: 'flex', flexDirection: 'column', justifyContent: 'center',
                    alignItems: 'center', cursor: 'pointer', opacity: dropped ? 0.45 : 1,
                    boxShadow: sel ? `inset 0 0 0 2px ${C.goldDp}` : `inset 0 -3px 0 ${C.ink}` }}>
                  <Sprite name={heroPortrait(h, raid.armySnapshot.heroLevels?.[h])}
                    w={deployLayout.artSize} h={deployLayout.artSize} />
                  <span style={{ fontSize: 12, color: C.goldHi, lineHeight: 1 }}>
                    {dropped ? 'IN BATTLE' : h.toUpperCase()}
                  </span>
                </button>
              );
            })}
            {unavailableHomeHeroes.map((hero) => (
              <UnavailableHeroCard key={`unavailable:${hero.hero}`} hero={hero} layout={deployLayout} />
            ))}
          </div>
          <div data-testid="raid-deploy-actions" style={{
            display: 'grid', gap: 6, alignItems: 'stretch', flex: '0 0 auto', pointerEvents: 'auto',
            gridTemplateColumns: deployLayout.oneRow
              ? (phase === 'deploying' && !liveCommandMode ? '110px 118px 146px' : '118px 126px')
              : (phase === 'deploying' && !liveCommandMode
                ? 'repeat(3, minmax(0, 1fr))'
                : 'minmax(112px,1fr) minmax(112px,1fr)'),
          }}>
            {/* RALLY skill (App L931): ui_skill_rally + 'RALLY · RDY' / locked */}
            {(canChooseNextTarget() || nextTargetIntentRef.current) ? (
              <Btn variant="sec" fontSize={15} disabled={retreating} onClick={() => setNextTargetConfirm(true)}
                style={{ minWidth: 0, minHeight: deployLayout.actionHeight, padding: '6px 5px 9px' }}>
                {retreating ? 'CONFIRMING…' : nextTargetIntentRef.current ? 'RETRY NEXT TARGET' : 'NEXT TARGET'}
              </Btn>
            ) : <Btn variant={rallyAt ? 'gold' : 'ghost'} fontSize={15} onClick={toggleRally}
              style={{ minWidth: 0, minHeight: deployLayout.actionHeight, boxSizing: 'border-box',
                padding: '6px 5px 9px', opacity: rallyUnlocked ? 1 : 0.55, whiteSpace: 'normal', flexWrap: 'wrap' }}>
              <img src={UI.skillRally} width={24} height={24} alt=""
                style={{ imageRendering: 'pixelated' }} />
              <span>RALLY {rallyUnlocked ? (rallyAt ? 'SET' : 'RDY') : `K${RALLY.unlockKeepLevel}`}</span>
            </Btn>}
            <Btn variant="sec" fontSize={16} onClick={requestExit}
              style={{ minWidth: 0, minHeight: deployLayout.actionHeight,
                boxSizing: 'border-box', padding: '7px 5px 10px', whiteSpace: 'normal', flexWrap: 'wrap' }}>
              ✕ RETREAT
            </Btn>
            {phase === 'deploying' && !liveCommandMode && (
              <Btn fontSize={18} disabled={deployCount === 0} onClick={submit}
                style={{ minWidth: 0, minHeight: deployLayout.actionHeight,
                  boxSizing: 'border-box', padding: '7px 5px 10px', whiteSpace: 'normal', flexWrap: 'wrap' }}>
                <Icon name="attack" size={20} />ATTACK ({deployCount})
              </Btn>
            )}
          </div>
        </div>
      )}
      <CameraPills
        bottom={cameraControls.bottom}
        right={cameraControls.right}
        horizontal={cameraControls.horizontal}
        top={cameraControls.top}
      />
      {nextTargetConfirm && (
        <MobileBackConfirm
          title="FIND ANOTHER TARGET?"
          body={`Next target: ${raidEntryCostLabel(homeBase?.player.keepLevel)}. Your current entry is not refunded. No extra charge if no other target is available.`}
          confirmLabel={retreating ? 'CONFIRMING…' : nextTargetIntentRef.current ? 'RETRY NEXT TARGET' : 'NEXT TARGET'}
          onCancel={() => { if (!retreating) setNextTargetConfirm(false); }}
          onConfirm={() => confirmRetreat(true)}
        />
      )}
      {retreatConfirm && (
        <MobileBackConfirm
          title="RETREAT FROM RAID?"
          body="Deployed troops and raid energy remain spent. Retreat only after the server confirms the battle."
          confirmLabel={retreating ? 'CONFIRMING…' : 'RETREAT'}
          onCancel={() => { if (!retreating) setRetreatConfirm(false); }}
          onConfirm={() => confirmRetreat()}
        />
      )}
    </>
  );
}

/**
 * Top battle HUD (App L908–925): timer pill, destruction %, 3 stars, END +
 * a second row with live loot accumulators and the three buff pills (tappable
 * toggles in the deploy phase, static indicators during playback).
 */
export function raidSpeedUnavailableReason(protocol: RaidProtocolVersion | undefined, phase: Phase, disconnected: boolean, pending: boolean): string | undefined {
  if (protocol !== 2) return 'LEGACY RAID · 1× ONLY';
  if (disconnected) return 'SPEED UNAVAILABLE WHILE RECONNECTING';
  if (pending) return 'SAVING SPEED…';
  if (phase !== 'playing') return 'SPEED AVAILABLE AFTER ATTACK';
  return undefined;
}

export function BattleHud({
  stars, destroyed, loot, trophies, phase, buffs, timerLabel, deadline, playTick,
  battleStartMs, catchingUp, onToggleBuff, onEnd, targetName, spectator,
  liveControls, measureRef, playheadMs, rate, onRate, ratePending, rateUnavailableReason, deploymentHint,
}: {
  stars: number; destroyed: number; loot: number | null; trophies: number;
  phase: Phase; buffs: Record<BuffKey, boolean>; timerLabel?: string | undefined;
  deadline?: string | undefined; playTick?: number | undefined;
  battleStartMs?: number | undefined;
  playheadMs?: number | undefined;
  /** D-099: the field is fast-forwarding a hidden-tab pause at 8×. */
  catchingUp?: boolean | undefined;
  onToggleBuff?: ((k: BuffKey) => void) | undefined; onEnd: () => void;
  targetName?: string | undefined; spectator?: boolean | undefined;
  liveControls?: boolean | undefined;
  rate?: 1 | 2 | undefined;
  onRate?: ((rate: 1 | 2) => void) | undefined;
  ratePending?: boolean | undefined;
  rateUnavailableReason?: string | undefined;
  /** Include deployment guidance in the measured chrome: an independent banner
   * at a fixed top offset used to cover valid drops without the camera knowing. */
  deploymentHint?: ReactNode;
  /** M23 a1: RaidUI measures the REAL HUD height for the camera fit — the
   *  96px constant under-reserved whenever the wrap rows grew a third line. */
  measureRef?: React.Ref<HTMLDivElement> | undefined;
}): React.JSX.Element {
  const timer = useTimerLabel(timerLabel, deadline, playTick, phase, battleStartMs, playheadMs);
  const [details, setDetails] = useState(false);
  useMobileBackHandler(() => setDetails(false), details, 180);
  useEffect(() => {
    if (!details) return;
    const close = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); setDetails(false); } };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [details]);
  return (
    <div ref={measureRef} data-testid="battle-hud" style={{
      position: 'absolute', top: 0, left: 0, right: 0,
      paddingTop: 'calc(10px + env(safe-area-inset-top))',
      paddingRight: 'calc(10px + env(safe-area-inset-right))',
      paddingBottom: 10,
      paddingLeft: 'calc(10px + env(safe-area-inset-left))',
      display: 'flex', flexDirection: 'column', gap: 6,
      zIndex: 1000, pointerEvents: 'none',
    }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <Pill aria-label={`Battle timer: ${timer}${phase === 'playing' ? ' elapsed / maximum' : ''}`}>
          <Icon name="timer" size={20} /><PillVal>{timer}</PillVal>
        </Pill>
        {rate && (
          <Pill {...(onRate && !ratePending ? { onClick: () => onRate(rate === 1 ? 2 : 1) } : {})}
            aria-label={`Battle speed ${rate}×${rateUnavailableReason ? ` · ${rateUnavailableReason}` : ''}`}
            style={{ opacity: ratePending ? 0.65 : 1 }}>
            <PillVal color={onRate ? C.goldHi : C.textDim}>{rate}×</PillVal>
          </Pill>
        )}
        {/* D-099: without a label the 8× fast-forward reads as a broken fight. */}
        {catchingUp && <Pill><PillVal color={C.goldHi}>CATCHING UP…</PillVal></Pill>}
        <Pill aria-label={`${destroyed}% destroyed, ${stars} stars`}><PillVal color={C.goldHi}>{destroyed}%</PillVal>
          {[0, 1, 2].map((i) => <Icon key={i} name="star" size={20} style={{ opacity: i < stars ? 1 : 0.25 }} />)}
        </Pill>
        <Pill onClick={() => setDetails((value) => !value)} aria-expanded={details} aria-label="Battle details">
          <Icon name="info" size={20} />
        </Pill>
        <Pill onClick={onEnd}><PillVal color={C.textDim}>{spectator ? 'CLOSE' : 'END'}</PillVal></Pill>
      </div>
      {/* Optional statistics never pause or mutate battle playback. */}
      {details && <div aria-label="Battle details panel" style={{
        position: 'absolute', top: '100%', left: 'calc(8px + env(safe-area-inset-left))',
        width: 'min(480px, calc(100% - 16px - env(safe-area-inset-left) - env(safe-area-inset-right)))',
        maxHeight: 'min(40dvh, 280px)', overflowY: 'auto', overscrollBehavior: 'contain',
        display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: 8,
        background: C.ink, border: `2px solid ${C.borderLt}`, pointerEvents: 'auto',
      }}>
        {rateUnavailableReason && <span role="status" style={{ width: '100%', color: C.textDim, fontSize: 13 }}>{rateUnavailableReason}</span>}
        <Pill><Icon name="shard" size={20} /><PillVal color={loot === null ? C.textFaint : C.goldHi}>{loot === null ? 'REDACTED' : `+${fmtN(loot)}`}</PillVal></Pill>
        <Pill><Icon name="trophy" size={20} /><PillVal color={C.goldHi}>{trophies >= 0 ? '+' : ''}{fmtN(trophies)}</PillVal></Pill>
        {targetName && (
          <Pill><Icon name="attack" size={20} /><PillSub>VS {targetName.length > 8 ? `${targetName.slice(0, 4)}…${targetName.slice(-4)}` : targetName}</PillSub></Pill>
        )}
        <span style={{ flex: 1 }} />
        {BUFF_DEFS.map((d) => {
          const on = buffs[d.key];
          const interactive = (phase === 'deploying' || (liveControls === true && phase === 'playing'))
            && !!onToggleBuff;
          const click = interactive ? { onClick: () => onToggleBuff!(d.key) } : {};
          return (
            <Pill key={d.key} accent={on ? C.gold : undefined} {...click}
              aria-label={`${d.label} · ${on ? 'ACTIVE' : `${d.cost} KEEP`}`}
              style={{ opacity: !interactive && !on ? 0.4 : 1 }}>
              <Icon name={d.icon} size={20} style={{ opacity: on || interactive ? 1 : 0.5 }} />
              <span>{d.label} · {on ? 'ACTIVE' : `${d.cost} KEEP`}</span>
            </Pill>
          );
        })}
      </div>}
      {deploymentHint}
    </div>
  );
}

/**
 * HUD timer (App L912 ui_icon_timer): in deploy, a live countdown to the
 * orders deadline; in playback, elapsed battle time against the shared maximum.
 * The event tick stream is the fallback clock (TICK_MS per tick).
 */
function useTimerLabel(
  label: string | undefined, deadline: string | undefined, playTick: number | undefined, phase: Phase,
  battleStartMs?: number, playheadMs?: number,
): string {
  const [now, setNow] = useState(() => Date.now());
  // The playing clock used to render `playTick`, which only advanced when a
  // `star`/`destroyed` event fired — so a quiet stretch of a 90s raid froze the
  // timer. Drive it off the real battle clock instead; a spectated replay has no
  // wall-clock start, so it keeps the tick fallback below.
  const live = phase === 'playing' ? (battleStartMs ?? 0) > 0 : phase === 'deploying' && !!deadline;
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [live]);
  if (label && phase !== 'playing') return label;
  if (phase === 'playing') {
    const elapsedMs = playheadMs ?? ((battleStartMs ?? 0) > 0 ? now - battleStartMs! : (playTick ?? 0) * TICK_MS);
    const elapsedSec = Math.floor(Math.max(0, Math.min(elapsedMs, BATTLE_CLOCK_MS)) / 1000);
    return `${fmtT(elapsedSec)} / ${fmtT(RAID_RULES.battleDurationSec)}`;
  }
  if (deadline) {
    const secs = Math.max(0, Math.round((new Date(deadline).getTime() - now) / 1000));
    return fmtT(secs);
  }
  return label ?? 'DEPLOY';
}

/**
 * Battle camera controls. The scene owns pan + pinch; these give desktop and
 * anyone who cannot pinch the same reach, and ⌖ restores the entry framing
 * (whole base + deploy ring) after the player has panned off somewhere.
 *
 * Deliberately NOT the base HUD's 'base:camera' event: each scene owns a
 * different fit band and only the visible scene should consume its commands.
 */
/** Zoom / re-frame pills. Position is derived from the MEASURED tray height:
 *  hardcoding it put the ⌖ pill underneath the tray the moment the tray grew to
 *  two rows, leaving a 2px sliver and an unreachable button. */
function CameraPills({
  bottom, right, horizontal = false, top,
}: {
  bottom: number; right: number; horizontal?: boolean; top?: number;
}): React.JSX.Element {
  const step = (op: 'in' | 'out' | 'fit') => () => bus.emit('battle:camera', { op });
  const control: CSSProperties = {
    width: RAID_DEPLOY_UI.tap, height: RAID_DEPLOY_UI.tap, boxSizing: 'border-box',
    justifyContent: 'center', padding: 0,
  };
  return (
    <div className="interactive" data-testid="raid-camera-controls" style={{
      position: 'absolute', right, zIndex: 1150, display: 'flex',
      flexDirection: horizontal ? 'row' : 'column', gap: RAID_DEPLOY_UI.cameraGap,
      ...(horizontal ? { top } : { bottom }),
    }}>
      <Pill onClick={step('in')} style={control}><PillVal>+</PillVal></Pill>
      <Pill onClick={step('out')} style={control}><PillVal>−</PillVal></Pill>
      <Pill onClick={step('fit')} style={control}><PillVal>⌖</PillVal></Pill>
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="interactive" style={{ position: 'absolute', left: 32, right: 32, top: '33%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: 16, textAlign: 'center', background: C.surface, border: `2px solid ${C.border}` }}>
      {children}
    </div>
  );
}
