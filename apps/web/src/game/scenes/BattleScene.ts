import { battlefieldBounds, isBattlefieldTileDeployable, resolveBattlefieldVersion, type BattlefieldContext } from '@shardkeep/shared/battlefield';
import { resolveBaseVisualContext, type BaseVisualContext } from '@shardkeep/shared/baseVisual';
import { HARVESTER_UNPRESENTED_KEY } from '../world/harvesterArt';
import type { BoundCosmeticAwningId, BoundCosmeticBaseRead } from '@shardkeep/shared/boundCosmeticVisual';
/**
 * BattleScene — deploy targeting + event-log playback (PLAN 5c, GDD §3.3,
 * HANDOFF §4.1). The server's deterministic sim is the only combat authority;
 * this scene renders its event log and the `battle:enter` payload. Every visual
 * is driven ONLY by SimEvents + the payload — nothing is invented here.
 *
 * FEEL parity with the App's battleFX()/diorama combat strip lives in the
 * fx/ modules (troop anims, muzzle/recoil, projectiles, HP bars, damage
 * numbers, building damage states). Playback clock: 1 sim tick = 100ms.
 */
import {
  ART_V2, AUDIO_RUNTIME, BATTLE_BODY_PRESENTATION, BUILDING_GEOMETRY, DEFENSES, TRAP_TYPES, WARE_BUILDING_ART,
  artTierOfLevel, attackRunCycleStarts, attackRunSuffixFromTick,
  eagerAtlasScale, GRID, HERO_SKILLS, RAID_CAMERA, RAID_PLAYBACK, RAID_RULES,
  TROOP_ABILITIES,
  resolveWallFrames, v2DirewyvernFxAtlasGroup, v2TroopFallbackFxAtlasGroups,
  resolveBuildingGeometryVersion,
  v2BuildingFallbackFrameKey, v2TroopFallbackFxBaseKey,
  wareBuildingStateAliasKey, wareTrapStateAliasKey,
  type AttackRunEvent, type BattlefieldVersion, type BuildingGeometryVersion, type TroopType,
  type WareBuildingUnit, type WareTrapUnit, type HeroCombatLoadout, type HeroKey,
} from '@shardkeep/shared';
import Phaser from 'phaser';
import {
  acquireSfxBank, DRAGON_BATTLE_WARM_SFX, LEGACY_PLACEMENT_SFX,
  loadProductionSfxManifest, playSfx, playSfxFamily,
  type SfxBank, type SfxHandle, stopAllLoops,
} from '../../lib/audio';
import {
  attackRunLegacyCueKeys, legacyFallbackBankForPlan, planBattleSfx,
  productionBankWindowsForPlan,
  troopDeploySfxFamily,
} from '../../lib/battleAudio';
import { bus } from '../../lib/events';
import { flash, floatText, haptic, reduceMotionOn, shake } from '../../lib/juice';
import { AnimTicker } from '../anim';
import { sceneCleanup } from '../sceneCleanup';
import { flushRetiredPlaybackTimers, retirePlaybackTimers } from '../playbackTimers';
import { BuildingDamage } from '../fx/buildingdamage';
import { settleDamageText } from '../fx/damagetext';
import { HpBar } from '../fx/hpbars';
import { cancelDefenceFire, clearMuzzleFx, defenceFire, muzzleFlash, muzzleY } from '../fx/muzzle';
import {
  breathCone, burnScorch, clearProjectileFx, explode, laserBeam, launchProjectile,
  quiesceProjectileFx, zapBolt, zapHit,
} from '../fx/projectiles';
import { battleArmyHpBps, battleUnitMaxHp, buildingMaxHp, footprintOf, troopMaxHp } from '../fx/stats';
import { HeroFx, TroopFx } from '../fx/troop';
import {
  buildingSeatY, clipKey, v2BldSeat, V2_DRAW_SCALE, type V2Meta,
} from '../v2/clips';
import { BurnfieldFx } from '../v2/burnfield';
import { V2DefenseFx } from '../v2/defense';
import { combatEffectPool } from '../v2/effects';
import {
  launchV2Projectile, playV2Fx, V2FX_ATLAS, type V2ProjectileArt,
} from '../v2/projectiles';
import { V2Ticker } from '../v2/ticker';
import {
  WareBuildingFx, WareTrapFx, launchWareHatchlingShot, launchWareShot, playWareFx,
  wareEmitterWorld,
} from '../ware/building';
import { MarketBuildingFx, marketStaticFrame } from '../fx/marketBuilding';
import { BerthBuildingFx, berthCompositionFor, berthCompositionGroups, type BerthComposition, type BerthPresence } from '../fx/berthBuilding';
import {
  ADVANCED_FLEET_ART_REGISTRY_KEY, BERTH_UNPRESENTED_KEY, EMPTY_ADVANCED_FLEET_ART, advancedBerthFrameKey, advancedFleetSeat,
  berthKeyGroup, selectFrozenBerths, type AdvancedFleetArtTable, type BerthFactsSelection,
} from '../world/advancedFleetArt';
import { EMPTY_STARTER_FLEET_ART, STARTER_FLEET_ART_REGISTRY_KEY, berthRestFrameKey, starterFleetSeat, type StarterFleetArtTable } from '../world/fleetArt';
import {
  AWNING_ATLAS_GROUP, EMPTY_MARKET_ART, MARKET_ART_REGISTRY_KEY, MARKET_FRAME_KEY,
  marketArtFamilyOf, marketArtGroup, marketArtTierOfLevel, marketRestFrameKey, marketSeat, selectMarketAwnings,
  type MarketArtChoice, type MarketArtTable,
} from '../world/marketArt';
import type { WareHatchlingDeps } from '../ware/hatchling';
import {
  isWareBuildingUnit, isWareTrapUnit, wareAtlasGroupForClip,
  wareBuildingAtlasGroup, wareBuildingClipKey, wareHatchlingClipKey,
  wareSeat, wareTrapAtlasGroup, type WareMeta,
} from '../ware/clips';
import { ensureWareRuinTextures, wareRuinTexture } from '../ware/ruin';
import {
  optionalV2TroopAtlasGroups, requiredV2CompactCombatAtlasGroups,
  requiredV2TroopAtlasGroups,
  v2FallbackSpec, v2TroopProfile,
  type V2TroopDeps, type V2TroopFallbackDeps, type V2TroopUnit,
} from '../v2/troop';
import {
  admitOnDemandAtlasCandidates, ensureV2Atlases,
  isV2AtlasLoaded, releaseAtlasGroups,
  releaseAtlasReservations, releaseUnusedAtlases, retainAtlasGroups,
  ON_DEMAND_ATLAS_LOAD_TIMEOUT_MS,
} from '../world/atlasLoader';
import {
  deployedTroopTypes, prioritizeRequiredWalkers, type AtlasCandidate,
} from '../world/artBudget';
import { fitBattleCamera, tileAtWorld } from '../world/battlecamera';
import { reframeAfterResize } from '../world/camera';
import { SceneGround } from '../world/sceneGround';
import { resolvePlotVersion } from '@shardkeep/shared';
import { SceneVisualGate } from '../world/sceneVisualGate';
import { wallFrameKey } from '@shardkeep/shared/wallRender';
import { WallLayer, isContextWallFrame } from '../world/walls';
import { actorDepth, buildingDepth, overlayDepth, wallDepth } from '../world/depth';
import {
  EMPTY_KEEP_CLOCK_METADATA, KEEP_CLOCK_META_REGISTRY_KEY,
  KeepClockLayer, type KeepClockMetadata,
} from '../world/keepClock';
import { skirtDecor } from '../world/underlay';
import { PinchZoom } from '../world/pinch';
import { atlasFor, type MetaMap } from './BootScene';

const T = 64;
const TICK_MS = 100;
/** First replay protocol with target-aware Troll melee cues. */
const TARGET_AWARE_MELEE_SIM_VERSION = 5;
const SELF_DESCRIBING_MELEE_SIM_VERSION = 7;
/** R5 deploy-zone contract: the 30×30 plot (GRID.plotTiles) is expanded by a
 *  4-tile margin on every side, so troops drop well outside the base.
 *  Coordinates stay plot-relative tiles; negative tiles and tiles ≥ plot are
 *  allowed in the margin. Must match the server's deploy validity (packages/sim)
 *  exactly. */
const DEPLOY_MARGIN = RAID_RULES.deployMarginTiles;
/**
 * Pending actors are presentation, not orders. Several truthful orders may
 * target the same tile; drawing every preview at the tile centre made the
 * first large silhouette completely cover the rest until ATTACK started the
 * staggered replay. Fan them inside that same tile and pair the stack with an
 * exact count badge. The authoritative tx/ty is untouched and onDeploy snaps
 * the promoted actor back to the event-authored position.
 */
const PREVIEW_DIRECTIONS = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
  [-1, -1], [1, -1], [-1, 1], [1, 1],
] as const;

export function deployPreviewOffset(
  index: number,
  total: number,
): { x: number; y: number } {
  if (total <= 1) return { x: 0, y: 0 };
  const direction = PREVIEW_DIRECTIONS[index % PREVIEW_DIRECTIONS.length]!;
  const ring = Math.floor(index / PREVIEW_DIRECTIONS.length);
  const radius = Math.min(26, 10 + ring * 5);
  return { x: direction[0] * radius, y: direction[1] * radius };
}

export interface DeployPreviewBodyBounds {
  x: number;
  y: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** World bounds of the exact pending stack after appending one candidate. The
 * tile itself stays included for its count badge and target affordance; every
 * body is translated to the PREVIEW_DIRECTIONS fan position it will render at. */
export function deployPreviewStackBounds(
  tx: number,
  ty: number,
  actors: readonly DeployPreviewBodyBounds[],
): CanvasInputRect {
  const bounds: CanvasInputRect = {
    left: tx * T, top: ty * T, right: (tx + 1) * T, bottom: (ty + 1) * T,
  };
  const centreX = (tx + 0.5) * T;
  const centreY = (ty + 0.5) * T;
  actors.forEach((actor, index) => {
    const offset = deployPreviewOffset(index, actors.length);
    const dx = centreX + offset.x - actor.x;
    const dy = centreY + offset.y - actor.y;
    bounds.left = Math.min(bounds.left, actor.left + dx);
    bounds.top = Math.min(bounds.top, actor.top + dy);
    bounds.right = Math.max(bounds.right, actor.right + dx);
    bounds.bottom = Math.max(bounds.bottom, actor.bottom + dy);
  });
  return bounds;
}

/** Phaser clamps a camera whose world viewport is wider than its bounds to the
 *  bounds' left/top edge. Grow only that presentation bound around the same
 *  field centre so a short landscape fit shows equal breathing room instead
 *  of parking the battlefield on the left half of the phone. */
export function centeredBattleBounds(
  fieldOrigin: number,
  fieldSize: number,
  viewW: number,
  viewH: number,
  zoom: number,
): { x: number; y: number; width: number; height: number } {
  const safeZoom = Math.max(Number.EPSILON, zoom);
  const width = Math.max(fieldSize, viewW / safeZoom);
  const height = Math.max(fieldSize, viewH / safeZoom);
  const centre = fieldOrigin + fieldSize / 2;
  return {
    x: centre - width / 2,
    y: centre - height / 2,
    width,
    height,
  };
}

export interface CanvasInputRect { left: number; top: number; right: number; bottom: number }

/** Canvas pixels not owned by the measured React HUD/safe-area chrome. */
export function battleCanvasInputRect(
  width: number,
  height: number,
  insets: { top: number; bottom: number; left: number; right: number } | null,
): CanvasInputRect {
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : Number.POSITIVE_INFINITY;
  const safeHeight = Number.isFinite(height) ? Math.max(0, height) : Number.POSITIVE_INFINITY;
  const left = Math.min(safeWidth, Math.max(0, insets?.left ?? 0));
  const top = Math.min(safeHeight, Math.max(0, insets?.top ?? 0));
  return {
    left,
    top,
    right: Math.max(left, safeWidth - Math.min(safeWidth, Math.max(0, insets?.right ?? 0))),
    bottom: Math.max(top, safeHeight - Math.min(safeHeight, Math.max(0, insets?.bottom ?? 0))),
  };
}

/** Measured HUD rectangles frame the camera, but transparent layout gaps are
 * playable canvas. Hit-test the actual ground point against current DOM chrome;
 * retain the conservative rectangle when a headless host cannot hit-test. */
function battleCanvasPointVisible(
  canvas: HTMLCanvasElement | undefined,
  width: number,
  height: number,
  x: number,
  y: number,
  fallback: CanvasInputRect,
): boolean {
  const frame = battleCanvasInputRect(width, height, null);
  if (!Number.isFinite(x) || !Number.isFinite(y)
    || x < frame.left || x >= frame.right || y < frame.top || y >= frame.bottom) return false;
  if (canvas && typeof canvas.ownerDocument.elementFromPoint === 'function') {
    const rect = canvas.getBoundingClientRect();
    if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)
      || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)
      || !Number.isFinite(width) || !Number.isFinite(height)
      || !(rect.width > 0 && rect.height > 0 && width > 0 && height > 0)) return false;
    return canvas.ownerDocument.elementFromPoint(
      rect.left + x * rect.width / width,
      rect.top + y * rect.height / height,
    ) === canvas;
  }
  return x >= fallback.left && x < fallback.right && y >= fallback.top && y < fallback.bottom;
}

export function centeredBattleRenderBounds(
  fieldOrigin: number,
  fieldSize: number,
  viewW: number,
  viewH: number,
  zoom: number,
  actorHeadroom: number,
  insets: { top: number; bottom: number; left: number; right: number } = { top: 0, bottom: 0, left: 0, right: 0 },
): { x: number; y: number; width: number; height: number } {
  const safeZoom = Math.max(Number.EPSILON, zoom);
  // Actors and their stacked fan can overhang every legal field edge. Retain
  // the existing world-space headroom on each side, then add measured screen
  // chrome in world units. None of this expands the authoritative deploy zone.
  const left = actorHeadroom + Math.max(0, insets.left) / safeZoom;
  const right = actorHeadroom + Math.max(0, insets.right) / safeZoom;
  const top = actorHeadroom + Math.max(0, insets.top) / safeZoom;
  const bottom = actorHeadroom + Math.max(0, insets.bottom) / safeZoom;
  const renderWidth = fieldSize + left + right;
  const renderHeight = fieldSize + top + bottom;
  const width = Math.max(renderWidth, viewW / safeZoom);
  const height = Math.max(renderHeight, viewH / safeZoom);
  return {
    x: fieldOrigin - left + renderWidth / 2 - width / 2,
    y: fieldOrigin - top + renderHeight / 2 - height / 2,
    width,
    height,
  };
}
/** Minimum gap between "you cannot deploy there" cues, so a hold-spray parked on
 *  the base core buzzes once instead of eight times a second. Client feel. */
const DENY_FX_COOLDOWN_MS = 260;
/** Throttle for the live destruction-% heartbeat (below one HUD frame). */
const PROGRESS_EMIT_MS = 150;
/**
 * Playback readiness invariant: every event-log actor waits for its measured
 * compact current-art motion attempt. Rich V2/WARE atlases and audio remain
 * optional. The shared atlas loader bounds the attempt; a denied/failed sheet
 * then plays truthfully with exact-position static snaps instead of hanging or
 * sliding a one-frame body while RaidUI's authoritative clock advances.
 */

/** A `pos` record is an endpoint at tick `t`, not a command issued at `t`. */
export function positionPlayback(
  events: readonly Ev[],
  fromTick: number,
): Map<Ev, { startTick: number; durationMs: number; skip?: boolean }> {
  const previous = new Map<number, number>();
  const cadence = new Map<number, number>();
  const previousPosition = new Map<number, Ev>();
  const result = new Map<Ev, { startTick: number; durationMs: number; skip?: boolean }>();
  for (const ev of events) {
    const tick = ev.t as number;
    if (ev.e === 'deploy' || ev.e === 'spawn' || ev.e === 'troopSpawn') {
      const id = ev['id'] as number;
      previous.set(id, tick);
      cadence.set(id, ev.e === 'troopSpawn'
        ? TROOP_ABILITIES.hexbarrow.brood.positionKeyframeTicks
        : RAID_RULES.troopFireVisualTicks);
      continue;
    }
    if (ev.e !== 'pos') continue;
    const id = ev['id'] as number;
    const prior = previous.get(id) ?? tick;
    previous.set(id, tick);
    if (tick < fromTick) continue;
    const priorEvent = previousPosition.get(id);
    if (priorEvent && prior === (priorEvent.t as number) && result.get(priorEvent)?.durationMs === 0) {
      result.set(priorEvent, { ...result.get(priorEvent)!, skip: true });
    }
    previousPosition.set(id, ev);
    const maxSegment = cadence.get(id) ?? RAID_RULES.troopFireVisualTicks;
    // An attack/ability pause creates a keyframe gap. Never smear that whole
    // pause into slow-motion movement; only interpolate the final real cadence.
    const segmentStart = tick - prior > maxSegment ? tick - maxSegment : prior;
    const startTick = Math.max(segmentStart, fromTick);
    result.set(ev, { startTick, durationMs: Math.max(0, tick - startTick) * TICK_MS });
  }
  return result;
}

/** SIM9 includes bounded legacy duplicates for old clients. Match only actors
 * and cycle ticks represented by a run, so defender-only legacy cues (notably
 * the deliberately deferred Wyrmling route) continue to render. */
export { attackRunLegacyCueKeys };

export type DefenseShotVisual =
  'v2' | 'none' | 'cannonball' | 'arrow' | 'shell' | 'beam' | 'zap' | 'orb';

/** Exhaustive presentation route for every current direct-fire defense. */
export function defenseShotVisual(
  type: string,
  projectile: 'cannonball' | 'arrow' | 'shell' | 'beam',
  adoptedV2: boolean,
): DefenseShotVisual {
  if (adoptedV2) return 'v2';
  // The eager Mortar body is current art, but has no attack effect frames. If
  // the atomic body+FX load truly fails, omit that optional cue rather than
  // resurrect the superseded batch-13 muzzle/projectile family.
  if (type === 'mortar') return 'none';
  if (type === 'lasertower') return 'beam';
  if (type === 'electrictower') return 'zap';
  if (type === 'magetower') return 'orb';
  return projectile;
}
/**
 * Ceiling on how far above the ground a building's hit star + damage number pop.
 * They sit at half the sprite's height, which was ~1 tile until batch 13 grew
 * the towers to as much as 4.3 tiles — half of THAT floats up by the roofline,
 * away from the troops actually swinging at the base. 1.5 tiles clears a troop
 * sprite (BATTLE_SCALE.troop) and still lands on the building's body.
 */
const HIT_LIFT_MAX_PX = 96;

interface SnapshotBuilding {
  id: string;
  type: string;
  level: number;
  tx: number;
  ty: number;
  trapSpentAt?: string | null;
}
// claimMin/claimMax are the defender's CENTERED claim bounds, carried on the raid
// snapshot (server-authoritative). The scene READS them and never recomputes a
// claim from GRID — recomputing is exactly what desynced the client from the server
// and produced the "deploy outside the deploy zone" bug on the 30-plot.
interface SnapshotObstacle { id: string; spriteKey: string; tx: number; ty: number }
interface Snapshot {
  defenderHeroes?: Array<{ hero: HeroKey; level: number; loadout?: HeroCombatLoadout }>;
  /** Untrusted persisted wire value: create() resolves and rejects unknowns. */
  geometryVersion?: number;
  battlefieldVersion?: number;
  plotVersion?: number;
  deploymentBlockers?: BattlefieldContext['deploymentBlockers'];
  keepLevel: number;
  buildings: SnapshotBuilding[];
  claimMin?: number;
  claimMax?: number;
  obstacles?: SnapshotObstacle[];
}

/** Decode the frozen wire contract before BattleScene creates any render state. */
export function battleGeometryVersion(
  snapshot: Pick<Snapshot, 'geometryVersion'>,
): BuildingGeometryVersion {
  return resolveBuildingGeometryVersion(snapshot.geometryVersion);
}

type Ev = { t: number; e: string } & Record<string, unknown>;

/** Compare actor histories, not event-array indices: inserting one accepted
 * deploy shifts the log but must not restart every unrelated animation. This
 * runs only on a replacement stream, never in the frame loop. String and
 * numeric IDs intentionally remain distinct (buildings versus troops). */
export function changedPlaybackActors(
  previous: readonly Ev[], next: readonly Ev[], throughTick: number,
): Set<string | number> {
  const histories = (events: readonly Ev[]): Map<string | number, string> => {
    const byActor = new Map<string | number, string>();
    for (const event of events) {
      if (event.t > throughTick) break;
      const ids = event.e === 'chain' ? (Array.isArray(event['targets']) ? event['targets'] : [])
        : [event.e === 'hit' ? event['target'] : event['id']];
      const encoded = JSON.stringify(event);
      for (const id of ids) {
        if (typeof id !== 'string' && typeof id !== 'number') continue;
        byActor.set(id, (byActor.get(id) ?? '') + encoded + '\n');
      }
    }
    return byActor;
  };
  const before = histories(previous);
  const after = histories(next);
  const changed = new Set<string | number>();
  for (const [id, history] of before) if (after.get(id) !== history) changed.add(id);
  for (const [id, history] of after) if (before.get(id) !== history) changed.add(id);
  return changed;
}

function playbackEventForActors(ev: Ev, accept: (id: string | number) => boolean): Ev | null {
  if (ev.e === 'chain') {
    if (!Array.isArray(ev['targets'])) return null;
    const targets: number[] = [], dmg: number[] = [];
    (ev['targets'] as number[]).forEach((id, index) => {
      if (!accept(id)) return;
      targets.push(id);
      dmg.push((ev['dmg'] as number[] | undefined)?.[index] ?? 0);
    });
    return targets.length ? { ...ev, targets, dmg } : null;
  }
  const id = ev.e === 'hit' ? ev['target'] : ev['id'];
  return (typeof id === 'string' || typeof id === 'number') && accept(id) ? ev : null;
}

/** Only phases whose body itself persists use the sim-authored `until` lock.
 * Buff lifetimes such as Degen Awakening still show the same five-tick cast
 * body as uninterrupted playback. Seek and live playback share this window. */
export function heroSkillBodyUntilTick(event: Ev): number {
  const persistent = event['phase'] === 'windup' || event['phase'] === 'fakeDeath';
  const authoredUntil = event['until'];
  if (persistent && typeof authoredUntil === 'number' && Number.isFinite(authoredUntil)
    && authoredUntil > event.t) return authoredUntil;
  return event.t + (event['skill'] === 'cannonball' ? 8 : 5);
}

/** Events whose payload changes the durable field mirror. A verdict jump
 * applies these while suppressing shot/skill/body transients that would be
 * born only to outlive the result overlay. */
const VERDICT_STATE_EVENTS = new Set([
  'deploy', 'spawn', 'troopSpawn', 'pos', 'hit', 'heal', 'troopDeath',
  'destroyed', 'trap', 'chain', 'burrow', 'emerge',
]);

/** API level maps include every research root; only positive counts are
 * deployable in this raid and therefore eligible for entry-time art prewarm. */
export function countedArmyTroopTypes(
  levels: Readonly<Record<string, number>>,
  counts: Readonly<Record<string, number>>,
): string[] {
  return Object.entries(counts)
    .filter(([troop, count]) => Number.isFinite(count) && count > 0
      && Number.isFinite(levels[troop]) && levels[troop]! > 0)
    .map(([troop]) => troop);
}

export function freezeTroopArtFamily(decided: Set<string>, troop: string): void {
  decided.add(troop);
  if (troop === 'hexbarrow' || troop === 'barrowling') {
    decided.add('hexbarrow');
    decided.add('barrowling');
  }
}

/** One failed/stalled request gets one fresh attempt, then the family stays on
 * its exact-current fallback for this scene. Playback never awaits either. */
const BATTLE_ATLAS_FAMILY_MAX_ATTEMPTS = 2;

async function loadAtlasFamily(scene: Phaser.Scene, groups: readonly string[]): Promise<void> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < BATTLE_ATLAS_FAMILY_MAX_ATTEMPTS; attempt++) {
    const missing = groups.filter((group) => !isV2AtlasLoaded(scene, group));
    if (missing.length === 0) return;
    try {
      await ensureV2Atlases(scene, missing);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error(`battle atlas family incomplete: ${groups.join(', ')}`);
}

interface BuildingSeat {
  origin: readonly [number, number];
  scale: number;
  offsetGamePx: readonly [number, number];
}

interface BuildingRec {
  sprite: Phaser.GameObjects.Sprite;
  type: string;
  /** Resting frame key. Legacy defenses hang firing frames off this key; the
   *  protected Mortar remains on its eager current alias until V2 adoption. */
  key: string;
  level: number;
  tx: number;
  ty: number;
  fw: number;
  fh: number;
  hp: number;
  maxHp: number;
  bar: HpBar | null;
  damage: BuildingDamage;
  destroyed: boolean;
  /** Retain the admitted art route even after its collapse destroys the
   * controller, so a canonical correction cannot downgrade a resurrected body. */
  artMode?: 'v2' | 'ware' | 'market' | 'berth';
  /** Rework-v2 controller — set only for a cannon/mortar whose `v2bld` tier
   *  atlas actually loaded (adoptV2Defenses). Absent = the legacy path. */
  v2?: V2DefenseFx;
  /** M22 full building-state controller, granted only after its atomic group. */
  ware?: WareBuildingFx;
  /** M22 attacker-hidden trap controller. */
  wareTrap?: WareTrapFx;
  /** Phase E Market controller (C3): the frozen Awning family or ordinary
   *  tier art, granted once its group is resident (adoptMarketBuildings). */
  market?: MarketBuildingFx;
  /** Phase E berth controller (P6a): the frozen installation's composition
   *  (starter or an advanced family/tier), granted once every group it draws
   *  from is resident (adoptBerthBuildings). */
  berth?: BerthBuildingFx;
  trapSpent: boolean;
}

interface DefenseArtCandidate extends AtlasCandidate {
  kind: 'v2' | 'ware' | 'market' | 'berth';
  bodyGroup: string;
}

interface PendingPlaybackGate {
  fromTick: number;
  /** Wall deadline origin; never rebased by a speed change. */
  requestedAt: number;
  /** Piecewise simulator time accumulated through the last accepted rate. */
  elapsedSimMs: number;
  rateChangedAt: number;
  rate: 1 | 2;
  catchUpMs: number;
  appliedPrefix: boolean;
}

function pendingPlaybackGateSimMs(
  gate: PendingPlaybackGate,
  now: number,
  fallbackRate: 1 | 2,
): number {
  const rateChangedAt = gate.rateChangedAt ?? gate.requestedAt;
  const rate = gate.rate ?? fallbackRate;
  return (gate.elapsedSimMs ?? 0) + Math.max(0, now - rateChangedAt) * rate;
}

function releaseDefenseCandidate(scene: Phaser.Scene, candidate: DefenseArtCandidate): void {
  // Shared FX may be in flight for or resident under a successful sibling.
  // Hatchling sheets are candidate-unique and must be released with the body,
  // or a rejected Nest can neither reclaim its budget nor retry this scene.
  const unique = candidate.groups.filter((group) => group !== 'warefx' && group !== V2FX_ATLAS);
  releaseAtlasGroups(scene, unique);
  releaseAtlasReservations(scene, unique);
}

interface TroopRec {
  fx: TroopFx;
  troop: TroopType;
  hero: boolean;
  hp: number;
  maxHp: number;
  bar: HpBar;
}

interface DeployMark {
  fx: TroopFx;
  sprite: Phaser.GameObjects.Sprite;
  troop: string;
  hero?: 'vex' | 'theodor' | undefined;
  tx: number;
  ty: number;
}

export class BattleScene extends Phaser.Scene {
  private meta!: MetaMap;
  private anim = new AnimTicker();
  /** Per-clip-fps clock for the rework-v2 sprites — the legacy 260ms AnimTicker
   *  stays for everything else (game/v2/ticker.ts explains the split). */
  private v2Ticker = new V2Ticker();
  /** Rework-v2 clip tables from the packed meta (BootScene registry). */
  private v2meta: V2Meta = { clips: {}, breathStream: null, atlasBytes: {} };
  private waremeta: WareMeta = { clips: {}, currentArtAliases: {}, atlasBytes: {} };
  /** Phase E Market art (C3): packed clip tables and this raid's FROZEN Awning
   *  choices, taken from the entry payload's projection against the frozen
   *  snapshot — never from the defender's current preference. */
  private marketArt: MarketArtTable = EMPTY_MARKET_ART;
  /** Frozen defender realm; Harvester art never reads the attacker's home. */
  private serviceVisualContext: BaseVisualContext | undefined;
  private marketAwnings: ReadonlyMap<string, BoundCosmeticAwningId> = new Map();
  private starterFleetArt: StarterFleetArtTable = EMPTY_STARTER_FLEET_ART;
  private advancedFleetArt: AdvancedFleetArtTable = EMPTY_ADVANCED_FLEET_ART;
  /** Frozen berth facts (P6a): both raid-payload siblings against the snapshot. */
  private berthFacts: BerthFactsSelection = { berths: new Map(), unavailable: false };
  /**
   * Full-animation tier per reworked troop. A troop enters
   * only after every atlas group in its authored profile is registered; the map
   * freezes for that family at its first deploy. Absence means the eager/compact current body,
   * never the historical troop family.
   */
  private v2TroopTiers = new Map<string, number>();
  /** Behavior-complete compact current-pack controller grant when richer art is
   * over the optional-art budget. */
  private v2TroopLocomotionTiers = new Map<string, number>();
  /** Shared compact-load promise per actually marked/rendered troop family. */
  private v2TroopLocomotionLoads = new Map<string, Promise<void>>();
  /** Invalidates superseded marker-time compact loads. */
  private v2TroopLocomotionGeneration = new Map<string, number>();
  /** Current projectile/effect aliases admitted with compact bodies. */
  private v2TroopFallbackFxTiers = new Map<string, number>();
  private v2TroopFallbackFxLoads = new Map<string, Promise<void>>();
  /** One shared request per troop type; marker spam cannot multiply callbacks. */
  private v2TroopLoads = new Map<string, Promise<void>>();
  /** Reservations accepted synchronously, before their network load settles. */
  private v2TroopControllerReserved = new Set<string>();
  /** A grant covers future actors/states, even while no sprite uses its sheet. */
  private troopArtLeases = new Map<string, () => void>();
  private v2DireEnhancementLoad: Promise<void> | null = null;
  /** Once a type has deployed its rich-vs-eager-current decision cannot flip. */
  private artDecidedTroops = new Set<string>();
  private armyLevels: Record<string, number> = {};
  /** Frozen hero research levels; old replay bundles legitimately omit them. */
  private heroLevels: Record<string, number> = {};
  private heroLoadouts: Partial<Record<HeroKey, HeroCombatLoadout>> = {};
  private armyHpBps = 0;
  private defenderHeroes: NonNullable<Snapshot['defenderHeroes']> = [];
  /** Background entry-time enhancement loads. Playback never waits for this. */
  private artReady: Promise<void> = Promise.resolve();
  private releaseDefenseFxLease: (() => void) | null = null;
  private releaseWareFxLease: (() => void) | null = null;
  /** Dragon Nest spawn art is a dependency, not an optional body sibling. */
  private wareDependencyLeases = new Map<string, () => void>();
  /** Family requests are finite for one raid; later rolling logs join them. */
  private defenseArtLoads = new Map<string, Promise<void>>();
  /** A defender freezes only when its first fire/spawn/trap event executes. */
  private artDecidedDefenses = new Set<string>();
  /** Shared dependencies may be reserved by a failed family; release those
   * conservative holds when the reusable scene shuts down. */
  private defenseSharedReservations = new Set<string>();
  private buildings = new Map<string, BuildingRec>();
  private snapshotBuildings = new Map<string, SnapshotBuilding>();
  private defenderBounds: { minX: number; minY: number; maxX: number; maxY: number } | undefined;
  private playbackEvents: readonly Ev[] = [];
  private correctingPlayback = false;
  private keepClock!: KeepClockLayer;
  /** Tiles covered by a building footprint ("tx,ty" keys) — deploy occupancy. */
  private occupied = new Set<string>();
  private troops = new Map<number, TroopRec>();
  /** Troop-death removes authoritative actors from `troops` immediately, but
   * their bounded death body may still be visible. Retain those facades until
   * their sprite dies so a hidden-tab verdict can destroy an in-flight corpse. */
  private retiredTroops = new Set<TroopFx>();
  private retiredTroopIds = new Map<number, TroopFx>();
  /** Troll ids governed by the target-aware melee protocol for this playback. */
  private meleeDrivenIds = new Set<number>();
  private marks: DeployMark[] = [];
  /** One readable count per occupied preview tile. The actors remain individual;
   *  this badge is what makes even a 40-unit hold-drop truthful at fit zoom. */
  private markBadges = new Map<string, Phaser.GameObjects.Text>();
  /** Live overlaps are still distinct actors. Key by a member id so a moving
   * stack reuses its text instead of allocating a new texture every frame. */
  private liveTroopBadges = new Map<number, { text: Phaser.GameObjects.Text; count: number }>();
  private timeline: Phaser.Time.TimerEvent[] = [];
  /** Exact-once Dire ground patches, keyed by owner/cast/cell. A replacement
   * replay stream destroys and reconstructs only intervals still live there. */
  private burnfields = new Map<string, BurnfieldFx>();
  private burnfieldCastTicks = new Map<number, number>();
  /** Scene-local one-shots created directly by BattleScene (hero sweeps, hit
   * stars and chain arcs). Their timers/tweens are cancelled separately; this
   * explicit owner destroys the visible objects before verdict or shutdown. */
  private transientFx = new Set<Phaser.GameObjects.GameObject>();
  /** Invalidates callbacks owned by an older replacement playback stream. */
  private playGeneration = 0;
  /** Invalidates an atlas-gated play request before it owns the live timeline. */
  private playRequestGeneration = 0;
  /** Distinguishes a rolling suffix replacement from a fresh scene whose UI
   * wall clock is already mid-battle. `appliedPrefix` is a caller claim; only
   * this scene-local fact proves there is actually a prefix on the canvas. */
  private renderedPlaybackState = false;
  /** Canonical field boundary owned by an in-flight media gate. Superseding
   * streams join this boundary instead of forgetting its wait or pause debt. */
  private pendingPlaybackGate: PendingPlaybackGate | undefined;
  /** Tick/time pair for the field's own rendered timeline. The mirrored scene
   * time advances only from Scene UPDATE deltas (including its active 8x
   * scale), never from RaidUI's wall clock while the game is hidden. */
  private playbackOriginTick = 0;
  private playbackOriginSceneTime = 0;
  private playbackRenderedSceneTime = 0;
  /** D-096 battle clock. Phaser pauses its whole loop while the tab is hidden
   *  and resumes it with the pause length; every timeline delayedCall above
   *  would then land late by exactly that span while RaidUI's wall-clock HUD
   *  and commit ran on. `catchUpMs` is the scene time the pause still owes the
   *  timeline; update() repays it at RAID_PLAYBACK.catchUpTimeScale so the
   *  missed events replay in order at speed and `battle:done` still comes from
   *  the timeline. Only a running playback generation owes anything — the
   *  deploy phase is wall-clock in RaidUI and has nothing to catch up. */
  private catchUpMs = 0;
  /** Ordinary presentation speed. Catch-up may temporarily override this at
   * the absolute 8x cap, then returns here rather than assuming 1x. */
  private playbackRate: 1 | 2 = 1;
  private playbackActive = false;
  /** D-106: RaidUI still holds reserves in the tray, so the current stream's
   *  end is not the fight's end. The done timer then leaves the rendered clock
   *  running (`playbackActive` stays true with no timeline) so the next
   *  reserve's replacement stream is rebased at the tick the field has really
   *  reached, not at the tick the last troop died. */
  private fightOpen = false;
  /** D-099: the timeline's last timer — the `battle:done` one, scheduled 10
   *  ticks after the final event. Its remaining delay is how far the field
   *  still is from the verdict, which decides whether a pause is repaid at
   *  8× (shorter than that) or jumped over (the player is back AFTER the
   *  wall-clock end, where RaidUI's timer has already posted the raid). */
  private playbackEnd: Phaser.Time.TimerEvent | undefined;
  /** True only inside jumpToEnd(): the whole remaining fight lands in one
   *  call stack, so positional moves snap and timeline sfx stay silent. */
  private jumping = false;
  /** Mirrors the 8× span for the HUD ('battle:catchup'); emitted on change. */
  private catchingUp = false;
  /**
   * Art requests belong to one create-to-shutdown scene lifetime, not to one
   * replay schedule. `playGeneration` advances for every rolling replay suffix;
   * using it for atlas loads made ATTACK invalidate the still-healthy preloads
   * started by create(). The separate epoch lets those requests settle for an
   * as-yet-undecided troop while still rejecting work from a stopped/reused
   * BattleScene instance.
   */
  private artLifecycleEpoch = 0;
  private unsub: Array<() => void> = [];
  /** Hold-to-deploy repeat (A1). `holdFired` records that the repeat actually
   *  emitted, so the pointerup handler doesn't add a 41st unit after a hold. */
  private holdTimer: Phaser.Time.TimerEvent | null = null;
  private holdFired = false;
  /** active SFX loops keyed by troop id (keg fuse / burrow) — §3.11. */
  private loops = new Map<number, SfxHandle>();
  /** Rolling-deploy compatibility slice. Production replays add only their
   * exact selected variants without ever loading the complete pack on a phone. */
  private sfxBank: SfxBank | null = null;
  private replayFallbackSfxBank: SfxBank | null = null;
  /** Six approved Dragon breath/contact variants warmed during deployment. A
   * generation protects the reusable scene from a late manifest promise, and
   * the exact replay bank takes ownership before this lease is released. */
  private dragonDeploymentSfxBank: SfxBank | null = null;
  private dragonDeploymentSfxGeneration = 0;
  /** Exact production variants referenced by the active deterministic replay.
   * Kept separate from the rolling-deploy legacy bank so either asset release
   * can load independently and a replaced stream can release only its slice. */
  private productionSfxBanks = new Set<SfxBank>();
  /** Defender claim bounds from the snapshot (server-authoritative). Defaults
   *  mirror the sim's fallback EXACTLY (GRID.deployRingTiles / +claimTiles) so a
   *  bare or pre-claim-field snapshot validates identically on client and sim. */
  private battlefieldVersion: BattlefieldVersion = 1;
  private deploymentBlockers: BattlefieldContext['deploymentBlockers'];
  private get deployMargin(): number { return -battlefieldBounds(this.battlefieldVersion).min; }
  private claimMin: number = GRID.deployRingTiles;
  private claimMax: number = GRID.deployRingTiles + GRID.claimTiles;
  /** Frozen per battle. BaseScene stays on current production geometry. */
  private geometryVersion: BuildingGeometryVersion = BUILDING_GEOMETRY.legacyVersion;
  /** Raid camera (owner 2026-07-29: the raid was unplayable on a phone — the
   *  scene hardcoded zoom 0.5 and registered NO camera input, so 12 of the
   *  battlefield's 38 tile columns were all you could ever see or tap). */
  private pinch!: PinchZoom;
  private zoomMin: number = RAID_CAMERA.minZoom;
  private zoomMax: number = RAID_CAMERA.maxZoom;
  /** The live pointer gesture. It stays 'pending' until it commits: moving past
   *  panThresholdPx makes it a PAN, staying still past holdConfirmMs makes it a
   *  deploy HOLD, and releasing while still pending is a plain TAP. Without this
   *  arbitration a pan would stream troops (the old hold timer's first beat fired
   *  at 120ms, so every drag longer than that silently dropped units). */
  private gesture: { mode: 'pending' | 'pan' | 'hold'; x: number; y: number } | null = null;
  /** Deploy input is wired only for a real raid — a scout gets camera only. */
  private deployEnabled = false;
  /** Tile highlight under the finger while a deploy gesture is live. */
  private hoverG: Phaser.GameObjects.Graphics | null = null;
  private lastDenyAt = Number.NEGATIVE_INFINITY;
  /** Live destruction %, mirroring the sim's HP-weighted accounting. */
  private destructibleMaxHp = 0;
  private lastProgressAt = 0;
  private lastProgressPct = -1;
  private battleCleanedUp = false;

  constructor() {
    super('battle');
  }

  create(data: {
    snapshot: Snapshot;
    visualContext?: BaseVisualContext | undefined;
    /** Frozen Awning projection captured with the raid (C3). Absent on legacy
     *  originals; `unavailable` draws ordinary art without claiming "off". */
    boundCosmeticVisual?: BoundCosmeticBaseRead | undefined;
    /** Frozen berth siblings captured with the raid (D235 starter v1, D238
     *  advanced v1), from the payload only. Absent on legacy originals. */
    servicePresentation?: unknown;
    advancedServicePresentation?: unknown;
    armyLevels?: Record<string, number>;
    armyCounts?: Record<string, number> | undefined;
    heroLevels?: Record<string, number> | undefined;
    scout?: boolean;
  }): void {
    // Scene instances are reused. Old portrait/landscape chrome must not grant
    // deployment before this entry's mounted HUD has measured itself.
    this.insets = null;
    this.battleCleanedUp = false;
    this.wallArt = new WallLayer(this);
    // K-060: resolve the persisted geometry contract BEFORE any scene object,
    // subscription or side effect exists. battleGeometryVersion() deliberately
    // throws on an unknown persisted version; unguarded, that exception aborts
    // create() after the base scene has already gone to sleep, leaving the
    // player with neither view. Refuse the battle and hand control back to the
    // base instead — the resolver's refusal itself stays strict.
    try {
      this.geometryVersion = battleGeometryVersion(data.snapshot);
      resolvePlotVersion(data.snapshot.plotVersion);
      resolveBattlefieldVersion(data.snapshot.battlefieldVersion);
    } catch {
      this.scene.stop();
      this.scene.wake('base');
      bus.emit('base:refresh', undefined);
      return;
    }
    this.visualGate?.destroy();
    this.visualGate = new SceneVisualGate(this, 'battle', () => {
      this.fantasyGround?.retryLoad();
      this.wallArt?.retryPreparation();
    }, () => { this.gesture = null; this.stopHoldDeploy(); this.clearHover(); });
    ++this.artLifecycleEpoch;
    this.meta = this.registry.get('meta') as MetaMap;
    this.marketArt = (this.registry.get(MARKET_ART_REGISTRY_KEY) as MarketArtTable | undefined)
      ?? EMPTY_MARKET_ART;
    this.serviceVisualContext = data.visualContext;
    // Combat snapshots hold completed rows only (raids.ts snapshotDefender), so
    // the frozen projection is matched against them as completed Markets.
    this.marketAwnings = selectMarketAwnings(
      this.marketArt, data.boundCosmeticVisual,
      data.snapshot.buildings.map((b) => ({ id: b.id, type: b.type, level: b.level, underConstruction: false })),
    ).awnings;
    this.starterFleetArt = (this.registry.get(STARTER_FLEET_ART_REGISTRY_KEY) as StarterFleetArtTable | undefined)
      ?? EMPTY_STARTER_FLEET_ART;
    this.advancedFleetArt = (this.registry.get(ADVANCED_FLEET_ART_REGISTRY_KEY) as AdvancedFleetArtTable | undefined)
      ?? EMPTY_ADVANCED_FLEET_ART;
    // Phase E berths (P6a): the frozen siblings alone decide each berth's
    // installation — never a current read, never a clock. Snapshot rows are
    // completed, the closure must equal them sorted by id.
    this.berthFacts = selectFrozenBerths(
      data.servicePresentation, data.advancedServicePresentation,
      data.snapshot.buildings.map((b) => ({ id: b.id, type: b.type, level: b.level })),
    );
    this.armyLevels = { ...(data.armyLevels ?? {}) };
    // Barrowlings inherit their spawning Hexbarrow's research tier. They are
    // never trainable/directly deployed, so no standalone army level exists.
    if (Number.isFinite(this.armyLevels.hexbarrow)) {
      this.armyLevels.barrowling = this.armyLevels.hexbarrow!;
    }
    this.heroLevels = data.heroLevels ?? {};
    this.heroLoadouts = {};
    this.armyHpBps = 0;
    this.defenderHeroes = data.snapshot.defenderHeroes ?? [];
    this.battlefieldVersion = resolveBattlefieldVersion(data.snapshot.battlefieldVersion);
    this.deploymentBlockers = data.snapshot.deploymentBlockers;
    this.claimMin = data.snapshot.claimMin ?? GRID.deployRingTiles;
    this.claimMax = data.snapshot.claimMax ?? this.claimMin + GRID.claimTiles;
    this.defenderBounds = undefined;
    if (this.battlefieldVersion !== 1 && data.snapshot.buildings.length > 0) {
      const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const building of data.snapshot.buildings) {
        const [fw, fh] = footprintOf(building.type, this.geometryVersion);
        bounds.minX = Math.min(bounds.minX, building.tx); bounds.minY = Math.min(bounds.minY, building.ty);
        bounds.maxX = Math.max(bounds.maxX, building.tx + fw); bounds.maxY = Math.max(bounds.maxY, building.ty + fh);
      }
      this.defenderBounds = bounds;
    }
    const scout = data.scout === true;
    this.sfxBank?.release();
    this.sfxBank = scout ? null : acquireSfxBank(LEGACY_PLACEMENT_SFX);
    this.warmDragonDeploymentSfx(
      !scout && Number(data.armyCounts?.dragon ?? 0) > 0,
    );
    this.anim.attach(this);
    this.v2Ticker.attach(this);
    ensureWareRuinTextures(this);
    this.v2meta = (this.registry.get('v2meta') as V2Meta | undefined)
      ?? { clips: {}, breathStream: null, atlasBytes: {} };
    this.waremeta = (this.registry.get('waremeta') as WareMeta | undefined)
      ?? { clips: {}, currentArtAliases: {}, atlasBytes: {} };
    this.keepClock = new KeepClockLayer(
      this,
      (this.registry.get(KEEP_CLOCK_META_REGISTRY_KEY) as KeepClockMetadata | undefined)
        ?? EMPTY_KEEP_CLOCK_METADATA,
    );
    // Reserve behavior-complete compact bodies for deployable counts only.
    // `armyLevels` contains zero-count research roots, so using it as a roster
    // wastes the cold-cache window and can crowd out the Bowman actually used.
    const base = this.scene.get?.('base') as (Phaser.Scene & {
      releaseV2DefenseArtForBattle?: () => void;
    }) | undefined;
    base?.releaseV2DefenseArtForBattle?.();
    // Snapshot-known Nest art reserves before placement can request any rich
    // troop controller. Its load may settle later, but its 3-part budget claim
    // cannot be crowded out by pre-ATTACK marker activity.
    const nestBootLoads = this.requestSnapshotNestArt(data.snapshot.buildings);
    // A Market has no eager still: its family (frozen Awning, else ordinary
    // tier art) is requested with the snapshot so it is visible for playback.
    const marketBootLoads = this.requestSnapshotMarketArt(data.snapshot.buildings);
    // A presented berth likewise has no eager still: its family groups are requested now.
    const berthBootLoads = this.requestSnapshotBerthArt(data.snapshot.buildings);
    const compactBootLoads: Promise<void>[] = [];
    const compactFamilies = new Set<string>();
    for (const troop of countedArmyTroopTypes(this.armyLevels, data.armyCounts ?? {})) {
      if (!v2TroopProfile(troop)) continue;
      const family = troop === 'hexbarrow' || troop === 'barrowling'
        ? ['hexbarrow', 'barrowling']
        : [troop];
      const key = family.join(':');
      if (compactFamilies.has(key)) continue;
      compactFamilies.add(key);
      compactBootLoads.push(this.requestV2TroopLocomotionArt(family));
    }
    // Other defenders are admitted only when the replay proves they function.
    this.artReady = Promise.all([...nestBootLoads, ...marketBootLoads, ...berthBootLoads, ...compactBootLoads]).then(() => undefined);

    this.cameras.main.setBackgroundColor('#567A4B');
    // R5: camera bounds cover the expanded battlefield (plot + a 4-tile margin on
    // every side), so panning can never leave the deployable field.
    const fieldOrigin = -this.deployMargin * T;
    const fieldSize = (GRID.plotTiles + this.deployMargin * 2) * T;
    // On a short landscape phone the safe-height fit can make the whole field
    // narrower than the viewport. Ask Phaser to centre undersized bounds;
    // otherwise its clamp pins the battlefield to the left and leaves the
    // entire right half as empty background after rotation.
    this.cameras.main.setBounds(fieldOrigin, fieldOrigin, fieldSize, fieldSize, true);
    this.setupCameraInput();
    this.fitCamera();

    // The frozen defender realm owns the entire battlefield and its skirt.
    // It never inherits the attacker's selected base or current globe position.
    const GRASS_SKIRT = 10; // tiles beyond the field on every side
    this.fantasyGround?.destroy();
    this.fantasyGround = new SceneGround(
      this, -this.deployMargin - GRASS_SKIRT,
      GRID.plotTiles + (this.deployMargin + GRASS_SKIRT) * 2, T,
      () => this.visualGate?.loading(), () => this.restyleObstacles(),
    );
    this.syncCameraBounds(this.cameras.main.zoom);
    this.fantasyGround.set(data.visualContext);
    // Revision 5 draws the defender's kingdom ring from the raid's stamped
    // claim. Only the snapshot's own claimMin/claimMax count: a legacy snapshot
    // without them leaves the kit ground without a claim, which it reports
    // through diagnostics instead of guessing the GRID default this scene
    // keeps for deploy geometry.
    this.fantasyGround.setClaim(data.snapshot.claimMin !== undefined && data.snapshot.claimMax !== undefined
      ? { min: data.snapshot.claimMin, max: data.snapshot.claimMax } : undefined);
    // The base's pine treeline + rock skirt rings the battlefield too —
    // pure decor at the same depths BaseScene draws it, translated so the
    // ring hugs the expanded field instead of the bare plot.
    {
      const fieldPx = (GRID.plotTiles + this.deployMargin * 2) * T;
      const off = -this.deployMargin * T;
      for (const d of skirtDecor(fieldPx, T)) {
        const [ax, ay] = this.meta[d.key]?.anchor ?? [0.5, 1];
        // Spec depth stays untranslated: it is already clamped 2..899, above
        // the grass (0) and below the field's y-px sprite depths, and the ring
        // never overlaps units, which cannot leave the field.
        const image = this.add.image(d.x + off, d.y + off, atlasFor(d.key), d.key)
          .setOrigin(ax, ay).setDepth(d.depth);
        this.fantasyGround.styleDecor(image, d.key);
      }
    }

    // Read-only scout previews share the home scene's continuous grass plane.
    // Ownership is already legible from the base itself; rectangular apron and
    // claim washes made the same world look boxed only when viewed in scout.

    // The owner pack's 16-piece wall contract requires retiling after every
    // adjacency change, including a destroyed raid segment. The initial map is
    // built here; onDestroyed recomputes the surviving neighbours.
    this.wallFrames = resolveWallFrames(
      data.snapshot.buildings
        .filter((b) => b.type === 'wall')
        .map((b) => ({ id: b.id, tx: b.tx, ty: b.ty, tier: b.level })),
    );
    this.snapshotBuildings = new Map(data.snapshot.buildings.map((b) => [b.id, b]));
    for (const b of data.snapshot.buildings) this.spawnBuilding(b);
    this.retileSurvivingWalls();

    // The target's obstacles render in EVERY battle mode, not only scout
    // (owner 2026-08-15: "I asked the attack field to look like the actual
    // base") — non-interactive decor mirroring BaseScene's obstacle keying:
    // the kit's twin on ready revision-5 ground, else the frozen dec_ master
    // incl. the pine1/pine2 fix (styleObstacle). Purely visual: the sim ignores
    // obstacles, so a deploy on a tree tile stays exactly as legal as it always was.
    this.obstacleDecor = (data.snapshot.obstacles ?? []).map((o) => {
      const sprite = this.add.sprite(0, 0, atlasFor('dec_rock_s'), 'dec_rock_s');
      this.styleObstacle(sprite, o);
      return { sprite, row: o };
    });

    if (scout) {
      // Read-only preview STOPS here — no deploy highlight, tap emitter,
      // marker or playback listeners are wired, so the buggy-prone deploy
      // path is never exercised in a scout.
    } else {
      this.deployEnabled = true;
      // R5: mark the NO-DEPLOY region — a red wash over the base's claim core plus
      // a bold outline of it, and a green outline of the battlefield's outer edge.
      // The old version also washed EVERY deployable tile green (~1400 fills that
      // stayed lit all fight); at the framing a phone actually needs, that painted
      // the whole screen and buried the base. The boundaries carry the same
      // information, and the tile under the finger is highlighted live below.
      this.time.delayedCall(0, () => {
        // WORLD_DEPTH.ground: the deploy wash is PAINT ON THE GRASS. It must
        // stay under buildings, walls and units — the same reason the skirt
        // decor above keeps its 2..899 spec depths.
        const g = this.add.graphics().setDepth(2);
        for (let y = this.claimMin; y < this.claimMax; y++) {
          for (let x = this.claimMin; x < this.claimMax; x++) {
            if (this.isDeployable(x, y)) continue;
            g.fillStyle(0xc75a2e, 0.20); g.fillRect(x * T, y * T, T, T); // NO deploy (base core)
          }
        }
        // bold outline of the no-deploy core so the boundary is obvious at a glance
        if (this.battlefieldVersion === 1) {
          g.lineStyle(3, 0xc75a2e, 0.85)
            .strokeRect(this.claimMin * T, this.claimMin * T,
              (this.claimMax - this.claimMin) * T, (this.claimMax - this.claimMin) * T);
        }
        // outer edge of the deployable battlefield (plot + margin)
        const lo = -this.deployMargin * T;
        const size = (GRID.plotTiles + this.deployMargin * 2) * T;
        g.lineStyle(3, 0x8cb36e, 0.7).strokeRect(lo, lo, size, size);
      });
      this.hoverG = this.add.graphics().setDepth(3); // ground band, over the wash

      // TAP = deploy one. HOLD = keep deploying at the finger's CURRENT tile until
      // you lift (owner 2026-07-26: placing 40 archers must not be 40 taps). DRAG =
      // pan the camera. All three stay available; the hold is a pure input
      // affordance — it emits exactly the deploys a series of taps would, so
      // RaidUI's per-troop remaining count and deployValid gate every unit
      // identically and the sim sees nothing new.
      // A hero drop ends the gesture: RaidUI hands the selection back to a
      // troop, so the remaining 120ms beats would stream real units onto the
      // hero's tile — ~8 for a one-second hold (verify pass 2026-07-29).
      this.unsub.push(bus.on('battle:holdCancel', () => this.stopHoldDeploy()));

      this.unsub.push(bus.on('battle:mark', ({ troop, hero, tx, ty }) => {
        this.addDeployMark({ troop, hero, tx, ty });
        // Marking is the earliest truthful signal that this unit WILL render.
        // Start current compact motion + fallback FX during placement; otherwise
        // the scene-entry allowance commonly expires before ATTACK is pressed.
        if (!hero) {
          // Placement preloads the behavior-complete compact controller. Rich
          // art is an enhancement; attack never expires into movement-only art.
          void this.requestV2TroopLocomotionArt(
            troop === 'hexbarrow' || troop === 'barrowling'
            ? ['hexbarrow', 'barrowling']
            : [troop],
          );
          void this.requestV2TroopArt(troop);
        }
      }));
      this.unsub.push(bus.on('battle:unmark', ({ troop, hero, tx, ty }) => {
        this.removeDeployMark({ troop, hero, tx, ty });
      }));
      this.unsub.push(bus.on('battle:play', ({ events, fromTick, simVersion, appliedPrefix, terminal, fightOpen, heroLoadouts }) => {
        void this.play(
          events as Ev[], fromTick ?? 0, simVersion, appliedPrefix === true, terminal === true,
          fightOpen === true, heroLoadouts,
        );
      }));
      this.unsub.push(bus.on('battle:rate', ({ rate }) => {
        this.adoptPlaybackRate(rate);
        if (this.catchUpMs <= 0) this.setPlaybackTimeScale(rate);
      }));
      this.unsub.push(bus.on('battle:playhead', ({ simMs }) => {
        if (!this.playbackActive || !Number.isFinite(simMs)) return;
        const renderedMs = this.currentRenderedPlaybackTick(0) * TICK_MS;
        const gap = Math.max(0, simMs - renderedMs);
        if (gap > 0) this.catchUpMs = Math.max(this.catchUpMs, gap);
      }));
    }
    this.armPauseCatchUp();
    this.unsub.push(bus.on('battle:exit', () => this.exitBattle()));

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.cleanupBattle());
  }

  /** Stop accepting late art/playback work before releasing any visual. The
   * instance is reused, so shutdown and an explicit HOME share one cleanup. */
  private cleanupBattle(): void {
    if (this.battleCleanedUp) return;
    this.battleCleanedUp = true;
    this.pendingPlaybackGate = undefined;
    this.playbackActive = false;
    this.fightOpen = false;
    sceneCleanup('timeline', () => retirePlaybackTimers(this.time, this.timeline));
    this.timeline = [];
    this.playGeneration++;
    this.playRequestGeneration++;
    this.artLifecycleEpoch++;
    sceneCleanup('hold-deploy', () => this.stopHoldDeploy());
    this.playbackRate = 1;
    sceneCleanup('playback-clocks', () => this.resetPauseCatchUp());
    sceneCleanup('projectiles', () => clearProjectileFx(this));
    sceneCleanup('muzzles', () => clearMuzzleFx(this));
    sceneCleanup('transient-effects', () => this.clearTransientFx());
    sceneCleanup('damage-text', () => settleDamageText(this));
    this.unsub.forEach((u) => sceneCleanup('subscription', u));
    this.unsub = [];
    sceneCleanup('audio-loops', stopAllLoops);
    this.loops.clear();
    sceneCleanup('sfx-bank', () => this.sfxBank?.release());
    this.sfxBank = null;
    sceneCleanup('replay-sfx-bank', () => this.replayFallbackSfxBank?.release());
    this.replayFallbackSfxBank = null;
    sceneCleanup('dragon-sfx-bank', () => this.releaseDragonDeploymentSfxBank());
    sceneCleanup('production-sfx-banks', () => this.releaseProductionSfxBanks());
    this.buildings.forEach((b) => {
      sceneCleanup('building-bar', () => b.bar?.destroy());
      sceneCleanup('building-damage', () => b.damage.destroy());
      sceneCleanup('building-v2', () => b.v2?.destroy());
      sceneCleanup('building-ware', () => b.ware?.destroy());
      sceneCleanup('building-trap', () => b.wareTrap?.destroy());
      sceneCleanup('building-market', () => b.market?.destroy());
      sceneCleanup('building-berth', () => b.berth?.destroy());
    });
    this.marketAwnings = new Map();
    this.troops.forEach((t) => {
      sceneCleanup('troop-bar', () => t.bar.destroy());
      sceneCleanup('troop-fx', () => t.fx.destroy());
    });
    this.retiredTroops.forEach((fx) => sceneCleanup('retired-troop', () => fx.destroy()));
    this.retiredTroops.clear();
    sceneCleanup('burnfields', () => this.clearBurnfields());
    sceneCleanup('keep-clock', () => this.keepClock?.destroy());
    this.wallArt?.destroy();
    this.visualGate?.destroy();
    this.visualGate = undefined;
    this.wallArt = undefined;
    this.fantasyGround?.destroy();
    this.fantasyGround = undefined;
    this.obstacleDecor = [];
    this.buildings.clear();
    this.snapshotBuildings.clear();
    this.playbackEvents = [];
    this.troops.clear();
    this.retiredTroopIds.clear();
    this.meleeDrivenIds.clear();
    this.occupied.clear();
    this.marks.forEach((mark) => sceneCleanup('deploy-mark', () => this.destroyDeployMark(mark)));
    this.marks = [];
    this.markBadges.forEach((badge) => sceneCleanup('deploy-badge', () => badge.destroy()));
    this.markBadges.clear();
    this.liveTroopBadges.forEach(({ text }) => sceneCleanup('live-troop-badge', () => text.destroy()));
    this.liveTroopBadges.clear();
    // The scene INSTANCE is reused across raids, so the next battle must
    // re-decide its art from its own army rather than inherit this one's.
    this.v2TroopTiers.clear();
    this.v2TroopLocomotionTiers.clear();
    this.v2TroopLocomotionLoads.clear();
    this.v2TroopLocomotionGeneration.clear();
    this.v2TroopFallbackFxTiers.clear();
    this.v2TroopFallbackFxLoads.clear();
    this.v2TroopLoads.clear();
    this.v2TroopControllerReserved.clear();
    this.troopArtLeases.forEach((release) => sceneCleanup('troop-art-lease', release));
    this.troopArtLeases.clear();
    this.v2DireEnhancementLoad = null;
    this.artDecidedTroops.clear();
    this.renderedPlaybackState = false;
    this.pendingPlaybackGate = undefined;
    this.playbackOriginTick = 0;
    this.playbackOriginSceneTime = 0;
    this.playbackRenderedSceneTime = 0;
    this.artReady = Promise.resolve();
    this.defenseArtLoads.clear();
    this.artDecidedDefenses.clear();
    sceneCleanup('defense-reservations', () => releaseAtlasReservations(this, this.defenseSharedReservations));
    this.defenseSharedReservations.clear();
    sceneCleanup('defense-lease', () => this.releaseDefenseFxLease?.());
    this.releaseDefenseFxLease = null;
    sceneCleanup('ware-lease', () => this.releaseWareFxLease?.());
    this.releaseWareFxLease = null;
    this.wareDependencyLeases.forEach((release) => sceneCleanup('ware-dependency', release));
    this.wareDependencyLeases.clear();
    this.heroLevels = {};
    this.heroLoadouts = {};
    this.armyHpBps = 0;
    this.defenderHeroes = [];
    // Per-raid camera/gesture state: the scene instance is REUSED across raids
    // (scene.run/stop), so anything left here leaks into the next battle.
    sceneCleanup('hover', () => this.hoverG?.destroy());
    this.hoverG = null;
    this.gesture = null;
    this.deployEnabled = false;
    this.destructibleMaxHp = 0;
    this.lastProgressAt = 0;
    this.lastProgressPct = -1;
    this.lastDenyAt = Number.NEGATIVE_INFINITY;
    // VRAM: the on-demand art this raid pulled in (attacker tiers, v2fx, the
    // defender's cannon/mortar tiers, up to two trpdg levels — as much as
    // ~90MB) is dead the moment this scene stops, and the TextureManager is
    // game-global, so without this a session raiding across tiers grows until
    // the WebView kills it. Everything the sleeping base still draws survives;
    // the frozen art maps above are already cleared, so nothing here can be
    // re-keyed onto an evicted group. LAST in the handler, after this scene's
    // own sprites are gone. See world/atlasLoader.releaseUnusedAtlases.
    sceneCleanup('unused-atlases', () => releaseUnusedAtlases(this));
  }

  private exitBattle(): void {
    sceneCleanup('battle-owned', () => this.cleanupBattle());
    // Phaser's DisplayList shutdown also stops at the first thrown destroy().
    // Drain independently before scene.stop so one bad effect cannot leave
    // the remaining listeners, sprites or the selected home scene stranded.
    for (const child of [...this.children.getChildren()]) {
      sceneCleanup('display-object', () => child.destroy());
      sceneCleanup('display-membership', () => this.children.remove(child));
      sceneCleanup('update-membership', () => this.sys.updateList.remove(child));
    }
    sceneCleanup('battle-stop', () => this.scene.stop());
    sceneCleanup('base-wake', () => this.scene.wake('base'));
    sceneCleanup('base-refresh', () => bus.emit('base:refresh', undefined));
  }

  /** Build one pending deploy marker from the art decision available NOW. */
  private createDeployMark(spec: Omit<DeployMark, 'sprite' | 'fx'>): DeployMark {
    // A HERO mark renders the hero's own art at hero scale; the donor troop is
    // only the sim order channel and must never leak into the preview.
    const skin = spec.hero === 'vex'
      ? 'hero_vex' as const
      : spec.hero === 'theodor' ? 'hero_theo' as const : null;
    const x = (spec.tx + 0.5) * T;
    const y = (spec.ty + 0.5) * T;
    const fx = spec.hero
      ? new HeroFx(this, this.anim, spec.troop as TroopType, spec.hero, x, y, y)
      : new TroopFx(
        this, this.anim, spec.troop as TroopType, x, y, y, undefined, undefined,
        this.v2TroopDepsOf(spec.troop), this.v2TroopFallbackOf(spec.troop),
      );
    fx.setNearestBuildingFn(() => this.nearestBuildingX(fx.sprite.x, fx.sprite.y));
    if (v2TroopProfile(spec.troop)?.melee) fx.setMeleeDriven();
    return { ...spec, fx, sprite: fx.sprite };
  }

  private addDeployMark(spec: Omit<DeployMark, 'sprite' | 'fx'>): void {
    this.marks.push(this.createDeployMark(spec));
    this.refreshDeployStack(spec.tx, spec.ty);
    playSfxFamily(
      troopDeploySfxFamily(spec.troop as TroopType, spec.hero),
      `placement:${spec.troop}:${spec.hero ?? 'troop'}:${spec.tx}:${spec.ty}:${this.marks.length}`,
      spec.hero === 'vex' ? 'sfx_hero_deploy_vex'
        : spec.hero === 'theodor' ? 'sfx_hero_deploy_theo' : 'sfx_deploy_pop',
    );
    haptic('light');
  }

  private destroyDeployMark(mark: DeployMark): void {
    mark.fx.destroy();
  }

  /** Take back the newest pending marker on one tile after the server rejected
   *  that exact deploy. Mirrors onDeploy's consumption key so a stack of
   *  identical marks loses exactly one. A miss is harmless: an accepted deploy
   *  may already have consumed it, or a new raid entry cleared the field. */
  private removeDeployMark(spec: Omit<DeployMark, 'sprite' | 'fx'>): void {
    for (let index = this.marks.length - 1; index >= 0; index--) {
      const mark = this.marks[index]!;
      if (mark.troop !== spec.troop || mark.hero !== spec.hero
        || mark.tx !== spec.tx || mark.ty !== spec.ty) continue;
      this.marks.splice(index, 1);
      this.destroyDeployMark(mark);
      this.refreshDeployStack(spec.tx, spec.ty);
      return;
    }
  }

  /** Re-seat all pending actors for one authoritative tile. Each actor stays
   *  inside that tile; only its pre-ATTACK presentation is fanned. */
  private refreshDeployStack(tx: number, ty: number): void {
    const key = `${tx},${ty}`;
    this.markBadges.get(key)?.destroy();
    this.markBadges.delete(key);
    const stack = this.marks.filter((mark) => mark.tx === tx && mark.ty === ty);
    const centreX = (tx + 0.5) * T;
    const centreY = (ty + 0.5) * T;
    stack.forEach((mark, index) => {
      const offset = deployPreviewOffset(index, stack.length);
      mark.sprite.setPosition(centreX + offset.x, centreY + offset.y)
        .setAlpha(1).setDepth(actorDepth(centreY + offset.y) + index / 100);
    });
    if (stack.length <= 1) return;
    const badge = this.add.text((tx + 1) * T - 4, ty * T + 4, `×${stack.length}`, {
      fontFamily: 'VT323', fontSize: '22px', color: '#f4d77b',
      backgroundColor: '#14121a', padding: { x: 4, y: 1 },
      stroke: '#1a171e', strokeThickness: 3,
    }).setOrigin(1, 0).setDepth(overlayDepth(2705));
    this.markBadges.set(key, badge);
  }

  /** Count only coincident visible bodies, never nearby units or unused
   * reserves. Reading rendered positions also follows interpolation and cold
   * replay seeks without changing a single authoritative actor coordinate. */
  private refreshLiveTroopStacks(): void {
    const badges = this.liveTroopBadges ??= new Map();
    const stacks = new Map<string, { id: number; count: number; x: number; top: number }>();
    for (const [id, troop] of this.troops) {
      const sprite = troop.fx.sprite;
      if (!troop.fx.alive || !sprite.active || !sprite.visible || sprite.alpha <= 0
        || !Number.isFinite(sprite.x) || !Number.isFinite(sprite.y)) continue;
      const x = Math.round(sprite.x), y = Math.round(sprite.y);
      const key = `${x},${y}`;
      const top = sprite.y - sprite.displayHeight;
      const stack = stacks.get(key);
      if (stack) {
        stack.id = Math.min(stack.id, id);
        stack.count++;
        stack.top = Math.min(stack.top, top);
      } else stacks.set(key, { id, count: 1, x, top });
    }
    const visible = new Set<number>();
    for (const stack of stacks.values()) {
      if (stack.count <= 1) continue;
      visible.add(stack.id);
      let badge = badges.get(stack.id);
      if (!badge) {
        badge = { count: stack.count, text: this.add.text(0, 0, `×${stack.count}`, {
          fontFamily: 'VT323', fontSize: '22px', color: '#f4d77b',
          backgroundColor: '#14121a', padding: { x: 4, y: 1 },
          stroke: '#1a171e', strokeThickness: 3,
        }).setOrigin(0.5, 1).setDepth(overlayDepth(2705)) };
        badges.set(stack.id, badge);
      }
      if (badge.count !== stack.count) {
        badge.text.setText(`×${stack.count}`);
        badge.count = stack.count;
      }
      badge.text.setPosition(stack.x, stack.top - 6);
    }
    for (const [id, badge] of badges) {
      if (visible.has(id)) continue;
      badge.text.destroy();
      badges.delete(id);
    }
  }

  /** Re-key eager current-art markers after their bounded full-V2 request lands. */
  private rebuildDeployMarks(troop: string): void {
    if (!this.scene.isActive() || this.artDecidedTroops.has(troop)) return;
    const touchedCells = new Set<string>();
    this.marks = this.marks.map((mark) => {
      if (mark.hero || mark.troop !== troop) return mark;
      touchedCells.add(`${mark.tx},${mark.ty}`);
      this.destroyDeployMark(mark);
      return this.createDeployMark({
        troop: mark.troop, hero: mark.hero, tx: mark.tx, ty: mark.ty,
      });
    });
    touchedCells.forEach((cell) => {
      const [tx, ty] = cell.split(',').map(Number);
      this.refreshDeployStack(tx!, ty!);
    });
  }

  /** Reserve atomic sets against exact generated RGBA sizes, including loads
   * already in flight from a defence or earlier deploy marker. */
  private reserveV2Candidates(candidates: readonly AtlasCandidate[]): Set<string> {
    return admitOnDemandAtlasCandidates(this, this.v2meta.atlasBytes, candidates);
  }

  /** Defender fire art has priority over a sleeping home base's enhancement.
   * Reclaim once and retry the same atomic tower+projectile candidate. */
  private reserveDefenseArt(candidate: AtlasCandidate | DefenseArtCandidate): boolean {
    const reserve = (): boolean => {
      if ('kind' in candidate && candidate.kind === 'ware') {
        return admitOnDemandAtlasCandidates(
          this, this.waremeta.atlasBytes, [candidate],
        ).has(candidate.id);
      }
      return this.reserveV2Candidates([candidate]).has(candidate.id);
    };
    if (reserve()) return true;
    const base = this.scene.get?.('base') as (Phaser.Scene & {
      releaseV2DefenseArtForBattle?: () => void;
    }) | undefined;
    base?.releaseV2DefenseArtForBattle?.();
    return reserve();
  }

  /** Build one atomic current-art candidate per defender family that actually
   * has a fire/spawn/trap event. Each family loads independently, so a broken
   * WARE sibling cannot discard a complete Archer + warefx pair. */
  private requestDefenseArtForEvents(
    events: readonly Ev[], mandatoryNestOnly = false,
  ): Promise<void>[] {
    const functionalIds = new Set<string>();
    for (const event of events) {
      if ((event.e === 'fire' || event.e === 'trap') && typeof event['id'] === 'string') {
        functionalIds.add(event['id']);
      } else if (event.e === 'spawn' && typeof event['from'] === 'string') {
        functionalIds.add(event['from']);
      }
    }

    const byId = new Map<string, DefenseArtCandidate>();
    const add = (
      kind: DefenseArtCandidate['kind'], bodyGroup: string,
      groups: readonly string[],
    ): void => {
      const id = `defense:${kind}:${bodyGroup}`;
      if (!byId.has(id)) byId.set(id, { id, kind, bodyGroup, groups });
    };

    for (const buildingId of functionalIds) {
      // The first functional event freezes this building's presentation.
      // Later events must not reserve or download art that adoption will reject.
      if (this.artDecidedDefenses?.has(buildingId)) continue;
      const building = this.buildings.get(buildingId);
      if (!building) continue;
      if (mandatoryNestOnly && building.type !== 'dragonnest') continue;
      if ((ART_V2.buildings as readonly string[]).includes(building.type)) {
        const body = `v2bld_${building.type}_t${artTierOfLevel(building.level)}`;
        add('v2', body, [body, V2FX_ATLAS]);
        continue;
      }
      if (isWareBuildingUnit(building.type)) {
        const body = wareBuildingAtlasGroup(building.type, building.level);
        const needsFx = building.type === 'keep' || building.type === 'dragonnest'
          || ['archertower', 'electrictower', 'magetower', 'lasertower', 'airdefence']
            .includes(building.type);
        const hatchling = building.type === 'dragonnest'
          ? wareAtlasGroupForClip(wareHatchlingClipKey(building.level, 'hover'))
          : undefined;
        add('ware', body, [body, ...(hatchling ? [hatchling] : []), ...(needsFx ? ['warefx'] : [])]);
        continue;
      }
      if (isWareTrapUnit(building.type)) {
        const body = wareTrapAtlasGroup(building.type, building.level);
        add('ware', body, [body]);
        continue;
      }
    }

    const candidates = [...byId.values()].sort((a, b) => {
      const aNest = a.bodyGroup.startsWith('ware_dragonnest_');
      const bNest = b.bodyGroup.startsWith('ware_dragonnest_');
      return aNest === bNest ? 0 : aNest ? -1 : 1;
    });
    return BattleScene.prototype.requestDefenseArtCandidates.call(this, candidates);
  }

  /** Reserve every snapshot-known Nest dependency before optional placement
   * enhancement. Adoption runs in a promise turn after synchronous building
   * construction completes. */
  private requestSnapshotNestArt(buildings: readonly SnapshotBuilding[]): Promise<void>[] {
    const byId = new Map<string, DefenseArtCandidate>();
    for (const building of buildings) {
      if (building.type !== 'dragonnest') continue;
      const body = wareBuildingAtlasGroup(building.type, building.level);
      const hatchling = wareAtlasGroupForClip(wareHatchlingClipKey(building.level, 'hover'));
      const id = `defense:ware:${body}`;
      byId.set(id, { id, kind: 'ware', bodyGroup: body, groups: [body, hatchling, 'warefx'] });
    }
    return BattleScene.prototype.requestDefenseArtCandidates.call(this, [...byId.values()]);
  }

  /** Phase E Market art (C3): one candidate per resident family a Market may
   * draw — its ordinary tier group and, for a frozen Awning, pe_cosmetics. Two
   * candidates rather than one atomic pair: ordinary art stays the fallback
   * when the cosmetics group is over budget or fails. */
  private requestSnapshotMarketArt(buildings: readonly SnapshotBuilding[]): Promise<void>[] {
    const byId = new Map<string, DefenseArtCandidate>();
    for (const building of buildings) {
      const family = marketArtFamilyOf(building.type);
      if (!family) continue;
      const tier = marketArtTierOfLevel(building.level, family);
      const awning = family === 'market' ? this.marketAwnings.get(building.id) ?? null : null;
      const choices: MarketArtChoice[] = [family === 'harvester' ? this.marketChoiceFor(building) : { family, tier, awning: null }];
      if (awning) choices.push({ family, tier, awning });
      for (const choice of choices) {
        if (!marketRestFrameKey(this.marketArt, choice)) continue;
        const group = marketArtGroup(choice);
        const id = `market:${group}`;
        byId.set(id, { id, kind: 'market', bodyGroup: group, groups: [group] });
      }
    }
    return BattleScene.prototype.requestDefenseArtCandidates.call(this, [...byId.values()]);
  }

  /** The frozen installation a berth row carries, with its composition, or null
   *  for every unpresented state (hidden footprint, D-c). */
  private berthCompositionFor(id: string): { composition: BerthComposition; presence: BerthPresence } | null {
    const installation = this.berthFacts.berths.get(id);
    if (!installation) return null;
    const composition = berthCompositionFor(installation, this.starterFleetArt, this.advancedFleetArt);
    return composition ? { composition, presence: installation.presence } : null;
  }

  /** The family's authored intact cell for a presented berth, else null. */
  private berthRestKeyFor(b: Pick<SnapshotBuilding, 'id'>): string | null {
    const installation = this.berthFacts.berths.get(b.id);
    if (!installation) return null;
    return installation.family === 'starter'
      ? berthRestFrameKey(this.starterFleetArt)
      : advancedBerthFrameKey(this.advancedFleetArt, installation.family);
  }

  private berthArtResident(id: string): boolean {
    const selected = this.berthCompositionFor(id);
    return selected !== null && berthCompositionGroups(selected.composition, selected.presence).every((group) => isV2AtlasLoaded(this, group));
  }

  private requestSnapshotBerthArt(buildings: readonly SnapshotBuilding[]): Promise<void>[] {
    const byId = new Map<string, DefenseArtCandidate>();
    for (const building of buildings) {
      if (building.type !== 'berth') continue;
      const selected = this.berthCompositionFor(building.id);
      if (!selected) continue;
      for (const group of berthCompositionGroups(selected.composition, selected.presence)) {
        const id = `berth:${group}`;
        byId.set(id, { id, kind: 'berth', bodyGroup: group, groups: [group] });
      }
    }
    return BattleScene.prototype.requestDefenseArtCandidates.call(this, [...byId.values()]);
  }

  /** Grant each presented berth its controller once EVERY group its composition
   *  draws from is resident (the berth group, and the vehicle tier group for an
   *  occupied/exhausted berth). A destroyed berth whose art lands late rests on
   *  its destroyed still without a controller; restore re-adopts through it. */
  private adoptBerthBuildings(allowedGroups?: ReadonlySet<string>, restoring?: ReadonlySet<string>): boolean {
    let adopted = false;
    for (const [id, b] of this.buildings) {
      if (restoring && !restoring.has(id)) continue;
      if (b.type !== 'berth') continue;
      const selected = this.berthCompositionFor(id);
      if (!selected) continue;
      const groups = berthCompositionGroups(selected.composition, selected.presence);
      if (b.berth && b.berth.atlas === selected.composition.berthAtlas) continue;
      if (allowedGroups && !groups.some((group) => allowedGroups.has(group))) continue;
      if (!groups.every((group) => isV2AtlasLoaded(this, group))) continue;
      const rest = this.berthRestKeyFor({ id });
      if (!rest) continue;
      if (b.destroyed) {
        if (b.sprite.visible) continue;
        this.applyBerthFallbackState(id, b, 'destroyed');
        b.artMode = 'berth';
        adopted = true;
        continue;
      }
      b.berth?.destroy();
      // Re-seat ABSOLUTELY from the canonical tile before the controller takes
      // the texture (same rule as WARE/Market adoption): offsets never accumulate.
      this.positionBuildingSprite(b.sprite, b, rest);
      this.anim.unregister(b.sprite);
      b.berth = new BerthBuildingFx({
        ticker: this.v2Ticker, composition: selected.composition, presence: selected.presence, reducedMotion: reduceMotionOn(),
        // The vehicle is scene-owned, non-interactive art on its own group.
        addVehicle: (atlas) => this.add.sprite(0, 0, atlas),
      }, b.sprite);
      b.berth.setDamaged(b.maxHp > 0 && b.hp / b.maxHp < 0.5);
      // A cold-loaded berth was hidden until this moment: the controller's rest
      // mirrored that hidden state onto its vehicle, so re-layout AFTER the
      // reveal or an occupied/exhausted berth would stay bare (root delta review).
      b.sprite.setVisible(true);
      b.berth.layout();
      b.artMode = 'berth';
      adopted = true;
    }
    return adopted;
  }

  /** Static berth still for a seek/resume or a body without a controller: the
   *  presented family's damaged or destroyed cell, only once its berth group is
   *  resident (an unpresented berth stays the hidden footprint, D-c). */
  private applyBerthFallbackState(id: string, b: BuildingRec, state: 'damaged' | 'destroyed'): void {
    const selected = this.berthCompositionFor(id);
    if (!selected || !isV2AtlasLoaded(this, selected.composition.berthAtlas)) return;
    // Damaged keeps the vehicle (D-b): without the vehicle group resident a bare
    // damaged berth would read as empty, so it waits for adoption; the destroyed
    // still has no vehicle and needs only the berth group.
    if (state === 'damaged' && !this.berthArtResident(id)) return;
    const clipId = state === 'damaged' ? selected.composition.damagedClip : selected.composition.destroyedClip;
    const frame = selected.composition.clips[clipId]?.frames[0];
    if (!frame) return;
    this.anim.unregister(b.sprite);
    this.v2Ticker.unregister(b.sprite);
    b.sprite.setTexture(selected.composition.berthAtlas, frame);
    this.positionBuildingSprite(b.sprite, b, frame);
    b.sprite.clearTint().setVisible(true);
  }

  private requestDefenseArtCandidates(
    candidates: readonly DefenseArtCandidate[],
  ): Promise<void>[] {
    const artEpoch = this.artLifecycleEpoch;
    const loads: Promise<void>[] = [];
    for (const candidate of candidates) {
      const running = this.defenseArtLoads.get(candidate.id);
      if (running) {
        loads.push(running);
        continue;
      }
      if (!this.reserveDefenseArt(candidate)) continue;
      candidate.groups
        .filter((group) => group === 'warefx' || group === V2FX_ATLAS)
        .forEach((group) => this.defenseSharedReservations.add(group));
      let load: Promise<void>;
      load = loadAtlasFamily(this, candidate.groups)
        .then(() => {
          if (artEpoch !== this.artLifecycleEpoch || !this.scene.isActive()) {
            releaseDefenseCandidate(this, candidate);
            return;
          }
          const allowed = new Set([candidate.bodyGroup]);
          const adopted = candidate.kind === 'v2'
            ? this.adoptV2Defenses(allowed)
            : candidate.kind === 'ware'
              ? this.adoptWareBuildings(allowed)
              : candidate.kind === 'market'
                ? this.adoptMarketBuildings(allowed)
                : this.adoptBerthBuildings(allowed);
          if (adopted && candidate.groups.includes(V2FX_ATLAS)) {
            this.releaseDefenseFxLease ??= retainAtlasGroups(this, [V2FX_ATLAS]);
          }
          if (adopted && candidate.groups.includes('warefx')) {
            this.releaseWareFxLease ??= retainAtlasGroups(this, ['warefx']);
          }
          if (adopted && candidate.kind === 'ware') {
            candidate.groups.filter((group) => group.startsWith('ware_hatchling_'))
              .forEach((group) => {
                if (!this.wareDependencyLeases.has(group)) {
                  this.wareDependencyLeases.set(group, retainAtlasGroups(this, [group]));
                }
              });
          }
          if (adopted) releaseAtlasReservations(this, candidate.groups);
          else releaseDefenseCandidate(this, candidate);
        })
        .catch(() => {
          releaseDefenseCandidate(this, candidate);
          if (this.defenseArtLoads.get(candidate.id) === load) {
            this.defenseArtLoads.delete(candidate.id);
          }
        });
      this.defenseArtLoads.set(candidate.id, load);
      loads.push(load);
    }
    return loads;
  }

  /**
   * Reserve and load one actually requested compact movement family atomically.
   * play() calls the three historically regressed walkers first, then preserves
   * replay order for every remaining family. If an impossible all-roots mix
   * reaches the cap, only later families degrade to eager current stand aliases
   * rather than evicting a live actor.
   */
  private requestV2TroopLocomotionArt(troops: readonly string[]): Promise<void> {
    const artEpoch = this.artLifecycleEpoch;
    const requested = [...new Set(troops)];
    const running = requested
      .map((troop) => this.v2TroopLocomotionLoads.get(troop))
      .filter((load): load is Promise<void> => load !== undefined);
    const wanted = requested
      .filter((troop) => !this.v2TroopLocomotionLoads.has(troop))
      .map((troop) => {
        const tier = artTierOfLevel(this.armyLevels[troop] ?? 1);
        const groups = [
          ...requiredV2CompactCombatAtlasGroups(this.v2meta.clips, troop, tier),
          ...v2TroopFallbackFxAtlasGroups(troop, tier),
        ];
        const generation = this.v2TroopLocomotionGeneration.get(troop) ?? 0;
        return { troop, tier, groups, generation };
      })
      .filter((entry) => entry.groups.length > 0);
    if (wanted.length === 0) return Promise.all(running).then(() => undefined);

    const groups = [...new Set(wanted.flatMap((entry) => entry.groups))];
    const id = `locomotion:${wanted.map((entry) => `${entry.troop}:t${entry.tier}`).join(',')}`;
    const candidate: AtlasCandidate = { id, groups };
    if (!this.reserveV2Candidates([candidate]).has(id)) {
      return Promise.all(running).then(() => undefined);
    }

    const load = loadAtlasFamily(this, groups)
      .then(() => {
        if (artEpoch !== this.artLifecycleEpoch || !this.scene.isActive()) {
          this.releaseUngrantableGroups(groups);
          return;
        }
        for (const entry of wanted) {
          if ((this.v2TroopLocomotionGeneration.get(entry.troop) ?? 0)
            !== entry.generation) {
            this.releaseUngrantableGroups(entry.groups);
            continue;
          }
          const complete = entry.groups.every((group) => isV2AtlasLoaded(this, group));
          if (complete && !this.artDecidedTroops.has(entry.troop)) {
            this.retainTroopArt(entry.groups);
            this.v2TroopLocomotionTiers.set(entry.troop, entry.tier);
            this.v2TroopFallbackFxTiers.set(entry.troop, entry.tier);
            this.rebuildDeployMarks(entry.troop);
          } else {
            this.releaseUngrantableGroups(entry.groups);
          }
        }
      })
      .catch(() => {
        this.releaseUngrantableGroups(groups);
      });
    for (const entry of wanted) this.v2TroopLocomotionLoads.set(entry.troop, load);
    // Keep the settled attempt in the per-scene map. Marker spam or a rolling
    // replay must join the finite result rather than poll a missing atlas.
    return Promise.all([...running, load]).then(() => undefined);
  }

  /**
   * Load one actually requested troop's complete controller atomically. Calls
   * share one promise per unit. A late completion after that unit's playback
   * decision is immediately swept instead of consuming memory while the eager
   * current-art alias renders that actor.
   */
  private requestV2TroopArt(troop: string): Promise<void> {
    const artEpoch = this.artLifecycleEpoch;
    const family = troop === 'hexbarrow' || troop === 'barrowling'
      ? ['hexbarrow', 'barrowling'] as const
      : [troop] as const;
    if (family.every((unit) =>
      this.v2TroopTiers.has(unit) || this.artDecidedTroops.has(unit))) return Promise.resolve();
    const running = family.map((unit) => this.v2TroopLoads.get(unit)).find(Boolean);
    if (running) return running;
    if (family.some((unit) => !v2TroopProfile(unit))) return Promise.resolve();
    const levelRoot = family.length === 2 ? 'hexbarrow' : troop;
    const tier = artTierOfLevel(this.armyLevels[levelRoot] ?? 1);
    const entries = family.map((unit) => ({
      unit,
      tier,
      locomotion: requiredV2CompactCombatAtlasGroups(this.v2meta.clips, unit, tier),
    }));
    const locomotionGroups = [...new Set(entries.flatMap((entry) => entry.locomotion))];
    const locomotionLoad = entries.map((entry) => this.v2TroopLocomotionLoads.get(entry.unit))
      .find(Boolean) ?? this.requestV2TroopLocomotionArt(family);
    // Rich bodies are optional enhancement; compact bodies already cover every
    // currently truthful gameplay verb and local effect route.
    const sharedFx = family.length === 1 && troop === 'direwyvern' ? [] : [V2FX_ATLAS];
    const groups = [...new Set([
      ...sharedFx,
      ...family.flatMap((unit) =>
        requiredV2TroopAtlasGroups(unit as V2TroopUnit, tier)),
    ])];
    const id = family.length === 2 ? `hexbarrow-family:t${tier}` : `${troop}:t${tier}`;
    const candidate: AtlasCandidate = { id, groups };
    const granted = this.reserveV2Candidates([candidate]).has(id);
    if (granted) family.forEach((unit) => this.v2TroopControllerReserved.add(unit));
    const load = (async (): Promise<void> => {
      if (granted) {
        try {
          await loadAtlasFamily(this, groups);
          if (artEpoch !== this.artLifecycleEpoch || !this.scene.isActive()) {
            this.releaseUngrantableGroups(
              groups.filter((group) => !locomotionGroups.includes(group)),
            );
            return;
          }
          const complete = groups.every((group) => isV2AtlasLoaded(this, group));
          if (complete) {
            let adopted = false;
            for (const entry of entries) {
              if (this.artDecidedTroops.has(entry.unit)) continue;
              this.retainTroopArt(groups);
              this.v2TroopTiers.set(entry.unit, tier);
              this.rebuildDeployMarks(entry.unit);
              adopted = true;
            }
            if (!adopted) {
              this.releaseUngrantableGroups(
                groups.filter((group) => !locomotionGroups.includes(group)),
              );
              await locomotionLoad;
              return;
            }

            return;
          }
        } catch {
          // Fall through to the compact current-pack locomotion request.
        }
        if (artEpoch !== this.artLifecycleEpoch || !this.scene.isActive()) {
          this.releaseUngrantableGroups(
            groups.filter((group) => !locomotionGroups.includes(group)),
          );
          return;
        }
        family.forEach((unit) => this.v2TroopControllerReserved.delete(unit));
        // Keep the separately reserved locomotion group alive. Only the richer
        // controller sheets (and its v2fx reservation) are ungrantable here.
        this.releaseUngrantableGroups(groups.filter((group) => !locomotionGroups.includes(group)));
      }
      await locomotionLoad;
    })();
    // Publish both Hex-family promises before the next request can reserve a
    // partial set. A Hex marker therefore always reserves its future brood's
    // complete art atomically, even before troopSpawn exists in the log.
    for (const entry of entries) this.v2TroopLoads.set(entry.unit, load);
    return load;
  }

  /** Lowest-priority Dire enhancement: wait for its functional core, then
   * attempt hover + lifecycle atomically after every current-motion request
   * and ordinary controller has already reserved in deterministic order. */
  private requestV2DireEnhancementArt(coreLoad: Promise<void>): Promise<void> {
    if (this.v2DireEnhancementLoad) return this.v2DireEnhancementLoad;
    const artEpoch = this.artLifecycleEpoch;
    const tier = artTierOfLevel(this.armyLevels.direwyvern ?? 1);
    const enhancement = optionalV2TroopAtlasGroups('direwyvern', tier);
    const load = coreLoad.then(async () => {
      if (artEpoch !== this.artLifecycleEpoch || !this.scene.isActive()
        || this.v2TroopTiers.get('direwyvern') !== tier
        || this.artDecidedTroops.has('direwyvern') || enhancement.length === 0) return;
      const id = `direwyvern-enhancement:t${tier}`;
      if (!this.reserveV2Candidates([{ id, groups: enhancement }]).has(id)) return;
      try {
        await loadAtlasFamily(this, enhancement);
        if (artEpoch !== this.artLifecycleEpoch || !this.scene.isActive()) {
          this.releaseUngrantableGroups(enhancement);
          return;
        }
        const complete = enhancement.every((group) => isV2AtlasLoaded(this, group));
        if (complete && !this.artDecidedTroops.has('direwyvern')) {
          this.retainTroopArt(enhancement);
          this.rebuildDeployMarks('direwyvern');
        } else {
          this.releaseUngrantableGroups(enhancement);
        }
      } catch {
        this.releaseUngrantableGroups(enhancement);
      }
    });
    this.v2DireEnhancementLoad = load;
    return load;
  }

  /** Protect the complete granted family from a sleeping base's refresh or
   * late-load cleanup. Current sprite references cannot protect reserves,
   * spawned brood, or an animation's next sheet. Budget admission stays above. */
  private retainTroopArt(groups: readonly string[]): void {
    for (const group of groups) {
      if (!this.troopArtLeases.has(group)) {
        this.troopArtLeases.set(group, retainAtlasGroups(this, [group]));
      }
    }
  }

  /** Drop unit/building sheets that can no longer be granted. v2fx is shared
   * by already-adopted controllers and is therefore never swept mid-scene. */
  private releaseUngrantableGroups(groups: Iterable<string>): void {
    const requested = [...new Set(groups)];
    const disposable = requested.filter((group) => group !== V2FX_ATLAS);
    releaseAtlasGroups(this, disposable);
    // A shared resident v2fx stays available to adopted controllers, but a
    // failed/nonresident request must never keep consuming the global ledger.
    releaseAtlasReservations(this, requested);
  }

  /**
   * The rich rework-v2 context a troop's TroopFx must be built with, or
   * undefined for its exact-current static/compact fallback. Set only when the
   * unit's required event-capable sheets landed
   * before this troop family's first deploy; optional layers may be admitted too.
   */
  private v2TroopDepsOf(
    troop: string,
    id?: number,
    levelOverride?: number,
    variant?: number,
  ): V2TroopDeps | undefined {
    const richTier = this.v2TroopTiers.get(troop);
    const compactTier = this.v2TroopLocomotionTiers.get(troop);
    const tier = richTier ?? compactTier;
    if (tier === undefined || !v2TroopProfile(troop)) return undefined;
    const expectedTier = artTierOfLevel(levelOverride ?? this.armyLevels[troop] ?? 1);
    if (tier !== expectedTier) return undefined;
    return {
      ticker: this.v2Ticker,
      clips: this.v2meta.clips,
      breath: this.v2meta.breathStream,
      unit: troop as V2TroopUnit,
      tier,
      ...(richTier === undefined ? {
        compact: true,
        fxBaseFor: this.fallbackProjectileArt(troop).baseFor,
      } : {}),
      ...(variant !== undefined ? { variant } : {}),
      ...(id !== undefined && this.meleeDrivenIds.has(id) ? { meleeDriven: true } : {}),
    };
  }

  /** Eager exact-current fallback for a reworked troop at its authoritative
   * research tier. This remains available if compact admission or loading fails. */
  private v2TroopFallbackOf(troop: string, levelOverride?: number): V2TroopFallbackDeps | undefined {
    if (!v2TroopProfile(troop)) return undefined;
    const tier = artTierOfLevel(levelOverride ?? this.armyLevels[troop] ?? 1);
    if (this.v2TroopLocomotionTiers.get(troop) === tier) return undefined;
    const deps: V2TroopFallbackDeps = {
      clips: this.v2meta.clips,
      unit: troop as V2TroopUnit,
      tier,
      ...(this.v2TroopLocomotionTiers.get(troop) === tier ? { ticker: this.v2Ticker } : {}),
    };
    return v2FallbackSpec(deps.clips, deps.unit, deps.tier) ? deps : undefined;
  }

  /** Every defender Wyrmling receives this adapter. Rich lifecycle is optional;
   * the fallback is still an eager exact M22 Hatchling alias, never legacy art. */
  private wareHatchlingDepsOf(level: number): WareHatchlingDeps {
    const hover = wareHatchlingClipKey(level, 'hover');
    return {
      ticker: this.v2Ticker,
      clips: this.waremeta.clips,
      level,
      rich: isV2AtlasLoaded(this, wareAtlasGroupForClip(hover)),
    };
  }

  /**
   * Re-key every cannon/mortar whose `v2bld_<type>_t<n>` atlas has landed to
   * the rework-v2 controller (idle loop @3fps, aim/fire/reload on sim fire
   * events, damaged below half, own collapse). Buildings whose tier atlas
   * failed keep their eager presentation. Mortar then fails closed visually;
   * it never enters the obsolete legacy fire path.
   */
  private adoptV2Defenses(allowedGroups?: ReadonlySet<string>, restoring?: ReadonlySet<string>): boolean {
    let adopted = false;
    for (const [id, b] of this.buildings) {
      if (restoring && !restoring.has(id)) continue;
      if (b.v2 || b.destroyed) continue;
      if (!restoring && this.artDecidedDefenses?.has(id)) continue;
      if (!(ART_V2.buildings as readonly string[]).includes(b.type)) continue;
      const tier = artTierOfLevel(b.level);
      const group = `v2bld_${b.type}_t${tier}`;
      if (allowedGroups && !allowedGroups.has(group)) continue;
      if (!isV2AtlasLoaded(this, group)) continue;
      // RE-SEAT before adopting. Both eager aliases (Cannon joined Mortar in
      // the v2fallback atlas, 2026-08-16) already resolve this exact seat: the
      // tower's drawn bottom edge on the south edge of its footprint, the one
      // rule every family and every renderer now shares (buildingSeatY).
      // Measuring it off the sprite is safe across the adoption below because
      // the eager still is a PIXEL COPY of the rich idle frame — same 112×120
      // cell, same (56,104) anchor, same published fit (pinned in
      // BattleScene.test and v2/clips.test) — so V2DefenseFx re-keying the
      // texture cannot change the drawn height this seat was measured from.
      // Depth stays the south edge, or a tall tower sorts in front of its own
      // wall line.
      const seat = v2BldSeat(this.v2meta.clips, `v2_bld_${b.type}_t${tier}_idle_d0_f1`);
      if (seat) {
        b.sprite.setY(buildingSeatY(b.ty, b.fh, T, b.sprite.originY, b.sprite.displayHeight));
      }
      // Both towers arrive from the eager two-frame AnimTicker idle loop.
      // Remove that owner before V2Ticker takes over the same sprite; otherwise
      // the clocks would race textures during aim/fire/reload.
      this.anim.unregister(b.sprite);
      b.v2 = new V2DefenseFx(this, {
        ticker: this.v2Ticker,
        clips: this.v2meta.clips,
        unit: b.type as 'cannon' | 'mortar',
        tier,
      }, b.sprite);
      b.artMode = 'v2';
      adopted = true;
    }
    return adopted;
  }

  /** Adopt every complete M22 group before playback freezes the visual family.
   * Eager aliases stay in place for rejected groups and are already authored
   * from the same pack, so this is animation enhancement—not correctness. */
  /** The Market family to draw: the frozen Awning while pe_cosmetics is
   * resident, otherwise the ordinary tier art (fallback while/if the cosmetics
   * group is not admitted). The tier is the frozen completed level's. */
  private marketChoiceFor(b: { id: string; level: number; type: string }): MarketArtChoice {
    const family = marketArtFamilyOf(b.type) ?? 'market';
    const tier = marketArtTierOfLevel(b.level, family);
    if (family === 'harvester') return { family, tier, awning: null,
      realm: resolveBaseVisualContext(this.serviceVisualContext).realmId };
    // Awnings are Market-only: a frozen Workshop or Lodge never consults the projection.
    const awning = family === 'market' ? this.marketAwnings.get(b.id) ?? null : null;
    if (awning && isV2AtlasLoaded(this, AWNING_ATLAS_GROUP)
      && marketRestFrameKey(this.marketArt, { family, tier, awning })) {
      return { family, tier, awning };
    }
    return { family, tier, awning: null };
  }

  /** Grant each Market its controller once its selected family is resident.
   * An ordinary controller upgrades to the frozen Awning when pe_cosmetics
   * lands later; the sim's HP mirror re-selects damaged on adoption. */
  private adoptMarketBuildings(allowedGroups?: ReadonlySet<string>, restoring?: ReadonlySet<string>): boolean {
    let adopted = false;
    for (const [id, b] of this.buildings) {
      if (restoring && !restoring.has(id)) continue;
      if (!marketArtFamilyOf(b.type)) continue;
      const choice = this.marketChoiceFor({ id, level: b.level, type: b.type });
      const group = marketArtGroup(choice);
      if (b.market?.atlas === group) continue;
      if (allowedGroups && !allowedGroups.has(group)) continue;
      if (!isV2AtlasLoaded(this, group)) continue;
      const rest = marketRestFrameKey(this.marketArt, choice);
      if (!rest) continue;
      if (b.destroyed) {
        // Destroyed before its family landed: it rests on the pack rubble now
        // (no controller; a resurrecting correction re-adopts through restore).
        if (b.sprite.visible) continue;
        this.applyMarketFallbackState(id, b, 'destroyed');
        b.artMode = 'market';
        adopted = true;
        continue;
      }
      b.market?.destroy();
      // Re-seat ABSOLUTELY from the canonical tile before the controller takes
      // the texture (same rule as WARE adoption): offsets never accumulate.
      this.positionBuildingSprite(b.sprite, b, rest);
      this.anim.unregister(b.sprite);
      b.market = new MarketBuildingFx({
        ticker: this.v2Ticker, art: this.marketArt, choice, reducedMotion: reduceMotionOn(),
      }, b.sprite);
      b.market.setDamaged(b.maxHp > 0 && b.hp / b.maxHp < 0.5);
      b.sprite.setVisible(true);
      b.artMode = 'market';
      adopted = true;
    }
    return adopted;
  }

  private adoptWareBuildings(allowedGroups?: ReadonlySet<string>, restoring?: ReadonlySet<string>): boolean {
    let adopted = false;
    for (const [id, b] of this.buildings) {
      if (restoring && !restoring.has(id)) continue;
      if (b.destroyed) continue;
      if (!restoring && this.artDecidedDefenses?.has(id)) continue;
      if (isWareTrapUnit(b.type)) {
        if (b.wareTrap) continue;
        const group = wareTrapAtlasGroup(b.type, b.level);
        if (allowedGroups && !allowedGroups.has(group)) continue;
        if (!isV2AtlasLoaded(this, group)) continue;
        this.anim.unregister(b.sprite);
        b.wareTrap = new WareTrapFx({
          ticker: this.v2Ticker,
          clips: this.waremeta.clips,
          unit: b.type,
          level: b.level,
        }, b.sprite, false, b.trapSpent);
        b.artMode = 'ware';
        adopted = true;
        continue;
      }
      if (!isWareBuildingUnit(b.type) || b.ware) continue;
      const group = wareBuildingAtlasGroup(b.type, b.level);
      if (allowedGroups && !allowedGroups.has(group)) continue;
      if (!isV2AtlasLoaded(this, group)) continue;
      const idle = wareBuildingClipKey(b.type, b.level, 'idle');
      const first = `${idle}_f1`;
      const clip = this.waremeta.clips[idle];
      if (!clip) continue;
      // Re-seat ABSOLUTELY from the canonical tile before re-keying. Both the
      // eager alias and the rich frame carry the same presentation correction;
      // deriving x/y from tx/ty prevents a Mine offset from being applied twice.
      this.positionBuildingSprite(b.sprite, b, first);
      this.anim.unregister(b.sprite);
      b.ware = new WareBuildingFx({
        ticker: this.v2Ticker,
        clips: this.waremeta.clips,
        unit: b.type,
        level: b.level,
        ruinTexture: () => wareRuinTexture(this, b.type),
        onShot: (release) => {
          let fromX = b.sprite.x;
          let fromY = b.sprite.y - b.sprite.displayHeight * 0.55;
          if (release.kind === 'harpoon') {
            const at = wareEmitterWorld(b.sprite, release, 'tip');
            fromX = at.x;
            fromY = at.y;
          }
          launchWareShot(
            this, this.waremeta.clips, release, fromX, fromY,
            artTierOfLevel(b.level),
          );
        },
      }, b.sprite);
      b.artMode = 'ware';
      adopted = true;
      // The constructor owns the texture now; `first` exists solely as the
      // sidecar/texture agreement guard above.
      void first;
    }
    return adopted;
  }

  /** Per-frame: keep troop attack-facing + all HP bars tracking their entities. */
  update(_time: number, delta: number): void {
    this.wallArt?.update(delta * this.time.timeScale);
    this.visualGate?.update(this.fantasyGround?.diagnostics, this.wallArt?.preparing ?? false,
      this.wallArt?.diagnostics.error);
    if (this.visualGate && !this.visualGate.isReady) return;
    if (this.playbackActive && Number.isFinite(delta) && delta > 0) {
      const scale = Number.isFinite(this.time.timeScale) && this.time.timeScale > 0
        ? this.time.timeScale
        : 1;
      this.playbackRenderedSceneTime += delta * scale;
    }
    this.repayPauseCatchUp(delta);
    this.keepClock?.update();
    for (const t of this.troops.values()) {
      if (!t.fx.sprite.active) continue;
      t.fx.tickAttack();
      const s = t.fx.sprite;
      if (s.visible) {
        const top = s.y - s.displayHeight;
        t.bar.draw(s.x, top, t.hp / t.maxHp);
        t.bar.setVisible(t.hp < t.maxHp);
      } else {
        t.bar.setVisible(false);
      }
    }
    BattleScene.prototype.refreshLiveTroopStacks.call(this);
    for (const b of this.buildings.values()) {
      if (!b.bar || b.destroyed) continue;
      // Still the sprite's TOP edge, deliberately, even though batch 13 moved it
      // ~70px up for an L20 archer tower: the bar has to clear the art it
      // describes, and capping the lift would park it across the tower's face.
      // The level crown is part of the same sprite (a flag on the tower's own
      // pole, no transparent gap), so the top edge is still the building's top.
      // Safe to read every frame: the firing frames are authored at the idle
      // frame's exact size, so a tower's bar does not hop while it shoots.
      // Derived from the SPRITE's own seat rather than from the footprint's
      // south edge: identical for every bottom-anchored building (origin y = 1),
      // and correct for the v2 cannon/mortar, whose anchor is the footprint
      // CENTRE — assuming the south edge parked their bar across the barrel.
      const top = b.sprite.y - b.sprite.originY * b.sprite.displayHeight;
      b.bar.draw((b.tx + b.fw / 2) * T, top, b.hp / b.maxHp);
    }
  }

  /**
   * D-096: hear the game loop resume after a browser pause (hidden tab). Phaser
   * itself handles nothing beyond restarting the loop, so without this the
   * timeline simply finishes late by the pause. The subscription lives on the
   * GAME emitter, not the scene's, so it is released with the other create()
   * subscriptions on SHUTDOWN. Only a running playback generation owes the
   * missed span; a pause during deploy or after the verdict is nobody's debt.
   */
  private armPauseCatchUp(): void {
    const onResume = (pauseDuration: number): void => {
      if (!this.playbackActive || !(pauseDuration > 0)) return;
      const canonicalPause = pauseDuration * (this.playbackRate ?? 1);
      if (this.playbackEnd === undefined) {
        // D-106: an idle open field (reserves remain, stream spent) has no
        // timeline to replay. The rendered clock simply owes the pause, so
        // the next reserve is rebased at its true tick — no 8× span, no pill.
        this.playbackRenderedSceneTime += canonicalPause;
        return;
      }
      // D-099: a pause at least as long as the timeline's remaining span
      // returned AFTER the wall-clock end — the HUD already reads 100 % and
      // RaidUI's timer has posted the raid. Repaying that at 8× put the
      // verdict over a fast-forward; the field jumps to its end instead.
      const remaining = this.playbackEnd.getRemaining();
      if (canonicalPause >= remaining) this.jumpToEnd(remaining);
      else this.catchUpMs += canonicalPause;
    };
    this.game.events.on(Phaser.Core.Events.RESUME, onResume);
    this.unsub.push(() => this.game.events.off(Phaser.Core.Events.RESUME, onResume));
  }

  /**
   * Per-frame repayment of `catchUpMs`. The scene Clock (timeline timers),
   * tween manager and animation manager all consume `delta × scale`. The part
   * beyond `delta × ordinaryRate` repays the missed span. The Clock applies its
   * timeScale on the scene UPDATE
   * event, which runs BEFORE this update(), so a scale set here takes effect on
   * the next frame; the debt is therefore only reduced for a frame whose clock
   * step already ran at speed. `delta` is Phaser's raw frame ms (unscaled).
   */
  private repayPauseCatchUp(delta: number): void {
    if (this.catchUpMs <= 0) return;
    const scale = RAID_PLAYBACK.catchUpTimeScale;
    const baseline = this.playbackRate ?? 1;
    if (this.time.timeScale === scale) this.catchUpMs -= delta * (scale - baseline);
    if (this.catchUpMs > 0) this.setPlaybackTimeScale(scale);
    else {
      // Catch-up ending is not playback ending: retain the authoritative done
      // timer and eligibility for another hidden/resume cycle in this raid.
      this.catchUpMs = 0;
      this.setPlaybackTimeScale(this.playbackRate ?? 1);
    }
  }

  private setPlaybackTimeScale(scale: number): void {
    this.time.timeScale = scale;
    this.tweens.timeScale = scale;
    this.anims.globalTimeScale = scale;
    this.v2Ticker?.setTimeScale(scale);
    combatEffectPool(this).setTimeScale(scale);
    // D-099: the HUD's CATCHING UP… pill tracks the sped-up span exactly. Only
    // a change is reported — the resets at 1× (play(), exit, the verdict)
    // stay silent.
    const catchingUp = scale > (this.playbackRate ?? 1);
    if (catchingUp === this.catchingUp) return;
    this.catchingUp = catchingUp;
    bus.emit('battle:catchup', { active: catchingUp });
  }

  /** Integrate a speed switch while mandatory art has paused the scene clock.
   * The gate has no active Phaser timeline, so multiplying its whole wait by
   * only the final rate would skip or repeat simulator time. */
  private adoptPlaybackRate(rate: 1 | 2): void {
    const gate = this.pendingPlaybackGate;
    if (gate) {
      const now = Date.now();
      gate.elapsedSimMs = pendingPlaybackGateSimMs(gate, now, this.playbackRate ?? 1);
      gate.rateChangedAt = now;
      gate.rate = rate;
    }
    this.playbackRate = rate;
  }

  /** End playback, forget debt and return clocks to the accepted ordinary rate. */
  private resetPauseCatchUp(): void {
    this.catchUpMs = 0;
    this.playbackActive = false;
    this.playbackEnd = undefined; // a spent or replaced timeline has no end to jump to
    this.setPlaybackTimeScale(this.playbackRate ?? 1);
  }

  /**
   * D-099: the pause outlasted the timeline. Step the scene Clock ONCE by the
   * whole remaining span (plus a tick past the done timer's delay) so every
   * outstanding timeline callback fires in insertion order within this call —
   * play() schedules `battle:done` last, so the verdict lands last. The
   * clocks are returned to 1× first: Clock.update scales its delta by
   * timeScale, and a jump that starts mid-catch-up would otherwise step 8×
   * too far. Callbacks that arm their own timers (hero locks, burrow ends)
   * fire on the following real frames, behind the verdict.
   */
  private jumpToEnd(remainingMs: number): void {
    this.jumping = true;
    try {
      this.resetPauseCatchUp();
      // `remainingMs` is scene-timeline time. A canonical 2x baseline must not
      // multiply this one-shot seek and skip past due callbacks.
      this.setPlaybackTimeScale(1);
      // Phaser Clock catches loop TimerEvents up once per missed interval. Stop
      // presentation loops before the large seek or a minute-hidden tab can do
      // hundreds of texture writes/deploy repeats synchronously on foreground.
      BattleScene.prototype.stopHoldDeploy.call(this);
      this.anim?.settle();
      quiesceProjectileFx(this);
      this.clearBurnfields?.();
      // Phaser inserts delayedCall events during PRE_UPDATE. A resume can land
      // before the first rendered frame, so promote the initial timeline before
      // stepping it; otherwise update() sees an empty active list and the whole
      // fight starts behind the verdict on the next frame.
      flushRetiredPlaybackTimers(this.time);
      this.time.preUpdate();
      this.time.update(this.time.now, remainingMs + TICK_MS);
      // Completed callbacks can arm nested timers in Phaser's pending-insertion
      // queue. clearPendingEvents handles those; the two PRE_UPDATE passes first
      // reap completed active events, then synchronously destroy every remaining
      // active timer scheduled beyond this jump.
      ++this.playGeneration;
      ++this.playRequestGeneration;
      ++this.artLifecycleEpoch;
      this.pendingPlaybackGate = undefined;
      retirePlaybackTimers(this.time, this.timeline);
      flushRetiredPlaybackTimers(this.time);
      this.time.clearPendingEvents();
      this.time.preUpdate();
      this.time.removeAllEvents();
      this.time.preUpdate();
      this.timeline = [];

      // Tween targets have mixed ownership (durable actors and pooled Texts as
      // well as disposable FX), so kill without blind target destruction. Each
      // transient owner below settles its own objects deterministically.
      this.tweens.killAll();
      // Legacy addCounter flights (notably mortar shell + shadow) and timer-only
      // scorches do not expose their images through tween.targets.
      clearProjectileFx(this);
      clearMuzzleFx(this);
      BattleScene.prototype.clearTransientFx.call(this);
      settleDamageText(this);
      this.retiredTroops?.forEach((fx) => fx.destroy());
      this.retiredTroops?.clear();
      this.troops?.forEach((troop) => {
        troop.fx.settle();
      });
      this.buildings?.forEach((building) => {
        cancelDefenceFire(building.sprite);
        this.anim?.unregister(building.sprite);
        building.damage.destroy();
        building.v2?.destroy();
        building.ware?.destroy();
        building.wareTrap?.destroy();
      });
      this.v2Ticker?.settle();
      combatEffectPool(this).clear();
      stopAllLoops();
      this.loops?.clear();
      this.releaseProductionSfxBanks?.();
      this.replayFallbackSfxBank?.release();
      this.replayFallbackSfxBank = null;
      this.releaseDragonDeploymentSfxBank?.();
      this.cameras?.main.resetFX();
    } finally {
      this.jumping = false;
    }
    // The scheduled done callback is intentionally silent while jumping so
    // every timer/controller/transient is gone before React shows the verdict.
    bus.emit('battle:done', undefined);
  }

  /** Cancel the hold-to-deploy repeat and reset its latch. Safe to call twice, and
   *  called from every pointer-release path plus scene shutdown — a looping
   *  TimerEvent that outlived the scene would keep emitting deploys into a dead
   *  battle. */
  private stopHoldDeploy(): void {
    this.holdTimer?.remove();
    this.holdTimer = null;
    this.holdFired = false;
  }

  // -------------------------------------------------------------------------
  // Camera + gestures (PRESENTATION ONLY — see RAID_CAMERA in constants.ts).
  // Which events get applied, and which deploys reach the sim, are untouched:
  // every tap still goes out as `battle:tap` and RaidUI's deployValid is still
  // the one gate. Panning changes what you can SEE and REACH, nothing else.
  // -------------------------------------------------------------------------

  /** Re-band the pinch/pill zoom limits for the CURRENT viewport and return the
   *  entry framing. Split out so a resize can re-band without yanking the camera
   *  away from wherever the player has panned it. */
  private rebandCamera(): ReturnType<typeof fitBattleCamera> {
    const cam = this.cameras.main;
    const fit = fitBattleCamera({
      battlefieldVersion: this.battlefieldVersion,
      ...(this.defenderBounds ? { defenderBounds: this.defenderBounds } : {}),
      claimMin: this.claimMin,
      claimMax: this.claimMax,
      marginTiles: DEPLOY_MARGIN,
      fieldSizePx: (GRID.plotTiles + this.deployMargin * 2) * T,
      viewW: cam.width,
      viewH: cam.height,
      tilePx: T,
      // MEASURED chrome from RaidUI (falls back to the constants until the
      // first measurement arrives) — see battlecamera.ts. Landscape moves chrome
      // onto a SIDE (the nav rail sits on the right), so the horizontal insets
      // are read the same way; both default to 0, which is portrait's answer.
      ...(this.insets ? {
        hudTopPx: this.insets.top,
        hudBottomPx: this.insets.bottom,
        hudLeftPx: this.insets.left,
        hudRightPx: this.insets.right,
      } : {}),
    });
    this.zoomMin = fit.zoomMin;
    this.zoomMax = fit.zoomMax;
    this.pinch.setLimits(fit.zoomMin, fit.zoomMax);
    return fit;
  }

  /** Frame the defender's claim + its deploy ring between the HUD and the tray.
   *  Called on entry, and again from the HUD's ⌖ pill. */
  /** Real HUD chrome measured by the React overlay; null until it reports. The
   *  side pair is 0 in portrait and carries the landscape nav rail's width. */
  private insets: { top: number; bottom: number; left: number; right: number } | null = null;
  /** Set once the player pans/zooms, so a late chrome measurement never yanks
   *  the camera out from under them. */
  private userMovedCamera = false;

  private fitCamera(): void {
    const fit = this.rebandCamera();
    this.cameras.main.setZoom(fit.zoom);
    this.syncCameraBounds(fit.zoom);
    this.cameras.main.centerOn(fit.centerX, fit.centerY);
  }

  private setZoom(z: number): void {
    const zoom = Phaser.Math.Clamp(z, this.zoomMin, this.zoomMax);
    this.cameras.main.setZoom(zoom);
    this.syncCameraBounds(zoom);
  }

  private syncCameraBounds(zoom: number): void {
    const fieldOrigin = -this.deployMargin * T;
    const fieldSize = (GRID.plotTiles + this.deployMargin * 2) * T;
    const bounds = centeredBattleRenderBounds(
      fieldOrigin, fieldSize, this.cameras.main.width, this.cameras.main.height, zoom,
      RAID_CAMERA.northHeadroomWorldPx,
      this.insets ?? { top: RAID_CAMERA.hudTopPx, bottom: RAID_CAMERA.hudBottomPx, left: 0, right: 0 },
    );
    // Updating pan limits must not recenter a player-moved view. FIT separately
    // chooses its center; ordinary changes only clamp if the old view no longer fits.
    this.cameras.main.setBounds(bounds.x, bounds.y, bounds.width, bounds.height);
    // A tall phone can reveal terrain beyond the original square skirt even
    // at FIT. Cover every allowed camera position at the viewport's zoom floor;
    // ordinary pan/pinch updates reuse that one rectangular paint surface.
    this.fantasyGround?.setCoverage(centeredBattleRenderBounds(
      fieldOrigin, fieldSize, this.cameras.main.width, this.cameras.main.height, this.zoomMin,
      RAID_CAMERA.northHeadroomWorldPx,
      this.insets ?? { top: RAID_CAMERA.hudTopPx, bottom: RAID_CAMERA.hudBottomPx, left: 0, right: 0 },
    ));
  }

  /** Accept a late/changed React safe-area measurement without stealing a
   * player-moved frame. The limits must still follow the real tray/HUD or a
   * narrow phone can be stranded above the zoom needed to see the field. */
  private applyInsets(i: { top: number; bottom: number; left?: number; right?: number }): void {
    const next = { top: i.top, bottom: i.bottom, left: i.left ?? 0, right: i.right ?? 0 };
    const prior = this.insets;
    const changed = !prior || prior.top !== next.top || prior.bottom !== next.bottom
      || prior.left !== next.left || prior.right !== next.right;
    this.insets = next;
    if (!changed) return;
    if (!this.userMovedCamera) {
      this.fitCamera();
      return;
    }
    this.rebandCamera();
    const zoom = this.cameras.main.zoom;
    if (zoom < this.zoomMin || zoom > this.zoomMax) {
      reframeAfterResize(this.cameras.main, { min: this.zoomMin, max: this.zoomMax });
    }
    this.syncCameraBounds(this.cameras.main.zoom);
  }

  private setupCameraInput(): void {
    const cam = this.cameras.main;
    // The pool belongs to the game, not this scene. Re-entering a raid must not
    // keep allocating slots, and a slot number never identifies a gesture.
    if (!this.input.pointer2) this.input.addPointer(1);
    // The battle HUD has its own pills (bus 'battle:camera'); the base HUD's
    // 'base:camera' pills are not on screen here, so nothing to mirror.
    this.pinch = new PinchZoom(cam, (zoom) => this.syncCameraBounds(zoom),
      { min: this.zoomMin, max: this.zoomMax });

    // Only contacts whose down reached this scene own raid input. Phaser also
    // tracks touches begun on DOM overlays and can retain them across scenes.
    const contacts = new Map<number, Phaser.Input.Pointer>();
    let gesturePointer: number | null = null;
    const endGesture = (): void => {
      contacts.clear();
      gesturePointer = null;
      this.pinch.onUp();
      this.gesture = null;
      this.clearHover();
      this.stopHoldDeploy();
    };
    const pruneContacts = (p: Phaser.Input.Pointer): void => {
      // A lost touchend must not turn every subsequent drag into a pinch. The
      // native list describes contacts still on the document, including HUD.
      const touches = p.wasTouch ? (p.event as TouchEvent | undefined)?.touches : undefined;
      const identifiers = touches ? new Set(Array.from(touches, touch => touch.identifier)) : null;
      let removed = false;
      for (const [id, contact] of contacts) {
        if (!contact.isDown || (contact.wasTouch && identifiers && !identifiers.has(contact.identifier))) {
          contacts.delete(id); removed = true;
        }
      }
      if (removed) {
        gesturePointer = null;
        this.pinch.onUp(); this.gesture = null; this.clearHover(); this.stopHoldDeploy();
      }
    };

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      // Phaser forwards every mouse button. Only button 0 owns a deploy/camera
      // gesture; otherwise a context-click can park for holdConfirmMs and deploy
      // a unit before the browser opens its menu. Touch (and a primary pen event,
      // which Phaser presents as button 0) keeps the existing path.
      if (!p.wasTouch && (p.button !== 0 || !p.primaryDown)) return;
      pruneContacts(p);
      const inputRect = battleCanvasInputRect(cam.width, cam.height, this.insets);
      if (!battleCanvasPointVisible(this.game?.canvas, cam.width, cam.height, p.x, p.y, inputRect)) {
        // Real controls remain protected even if a forwarded/captured event
        // reaches Phaser. Transparent HUD gaps must still permit camera pans.
        // An unowned HUD contact must not interrupt an existing canvas gesture.
        if (contacts.size === 0 && this.deployEnabled && this.time.now - this.lastDenyAt >= DENY_FX_COOLDOWN_MS) {
          this.lastDenyAt = this.time.now;
          bus.emit('ui:toast', { msg: 'PAN TO REVEAL THIS TILE' });
        }
        return;
      }
      this.stopHoldDeploy();
      contacts.set(p.id, p);
      if (contacts.size > 1) {
        gesturePointer = null; this.gesture = null; this.clearHover();
        return; // a second scene-owned contact is a camera gesture, never a deploy
      }
      gesturePointer = p.id;
      this.gesture = { mode: 'pending', x: p.x, y: p.y };
      this.drawHover(p);
      if (!this.deployEnabled) return;
      // The stream starts only once the finger has clearly PARKED. Previously the
      // first repeat beat fired at 120ms, so a pan attempt dropped troops.
      this.holdTimer = this.time.addEvent({
        delay: RAID_CAMERA.holdConfirmMs,
        callback: () => {
          if (!p.isDown || gesturePointer !== p.id || !contacts.has(p.id)
            || this.gesture?.mode !== 'pending' || this.pinch.active()) {
            this.stopHoldDeploy();
            return;
          }
          this.gesture.mode = 'hold';
          this.startSprayDeploy(p);
        },
      });
    });

    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      pruneContacts(p);
      if (!p.isDown || !contacts.has(p.id)) return;
      contacts.set(p.id, p);
      const fingers = [...contacts.values()].filter(contact => contact.wasTouch);
      if (fingers.length > 1 && this.pinch.onMove(fingers[0]!, fingers[1]!)) {
        this.userMovedCamera = true;
        this.stopHoldDeploy(); // two fingers are a camera gesture, never a deploy
        if (this.gesture) this.gesture.mode = 'pan';
        return;
      }
      if (gesturePointer !== p.id || !this.gesture) return;
      if (this.gesture.mode === 'pending') {
        const manhattan = Math.abs(p.x - this.gesture.x) + Math.abs(p.y - this.gesture.y);
        if (manhattan <= RAID_CAMERA.panThresholdPx) { this.drawHover(p); return; }
        this.gesture.mode = 'pan';
        this.stopHoldDeploy();
        this.clearHover();
      }
      if (this.gesture.mode === 'hold') { this.drawHover(p); return; } // spray follows the path
      this.userMovedCamera = true;
      cam.scrollX -= (p.x - p.prevPosition.x) / cam.zoom;
      cam.scrollY -= (p.y - p.prevPosition.y) / cam.zoom;
    });

    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      // Phaser 4.1 routes a native touchcancel through POINTER_UP and marks the
      // Pointer instead of emitting a scene-level `pointercancel`. Treat it as a
      // non-committing end before the normal tap path can deploy a unit.
      // A secondary-button release must not finish a primary gesture that is
      // still down (nor synthesize a deploy of its own).
      if (!p.wasTouch && p.button !== 0) return;
      if (!contacts.has(p.id)) return;
      if (p.wasCanceled) { endGesture(); return; }
      const ownsGesture = gesturePointer === p.id;
      const g = this.gesture;
      const held = this.holdFired;
      endGesture();
      if (!this.deployEnabled) return;
      if (held) return; // the hold already streamed units — don't add one more
      if (!ownsGesture || !g || g.mode !== 'pending') return; // a pan / pinch is not a deploy
      if (p.getDistance() > RAID_CAMERA.panThresholdPx) return;
      this.emitTap(p);
    });

    this.input.on('pointerupoutside', (p: Phaser.Input.Pointer) => {
      // Match pointerup: a secondary release outside the canvas must not cancel
      // a primary gesture whose button is still held.
      if (!p.wasTouch && p.button !== 0) return;
      if (!contacts.has(p.id)) return;
      endGesture();
    });
    this.input.on('gameout', endGesture); // finger left the canvas
    this.game?.events.on(Phaser.Core.Events.BLUR, endGesture);
    this.game?.events.on(Phaser.Core.Events.HIDDEN, endGesture);
    this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => {
      if (dy === 0) return;
      this.userMovedCamera = true;
      this.setZoom(cam.zoom * (dy > 0 ? 1 / RAID_CAMERA.zoomStep : RAID_CAMERA.zoomStep));
    });

    // Re-fit whenever the overlay reports its real chrome: the tray's height
    // changes with its contents, and a stale inset is what pushed the base
    // under the tray and buried the re-frame pill.
    this.unsub.push(bus.on('battle:insets', (i) => {
      this.applyInsets(i);
    }));
    bus.emit('battle:insetsRequest', undefined);
    this.unsub.push(bus.on('battle:camera', ({ op }) => {
      if (op === 'fit') { this.userMovedCamera = false; this.fitCamera(); return; }
      this.userMovedCamera = true;
      this.setZoom(cam.zoom * (op === 'in' ? RAID_CAMERA.zoomStep : 1 / RAID_CAMERA.zoomStep));
    }));
    // Phaser.Scale.RESIZE: an orientation flip changes the viewport, and with it
    // the zoom floor that still holds the whole field — and the framing (onResize).
    this.scale.on(Phaser.Scale.Events.RESIZE, this.onResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      endGesture();
      this.game?.events.off(Phaser.Core.Events.BLUR, endGesture);
      this.game?.events.off(Phaser.Core.Events.HIDDEN, endGesture);
      this.scale.off(Phaser.Scale.Events.RESIZE, this.onResize, this);
    });
  }

  /**
   * A raid lasts 60 seconds and someone WILL rotate the phone during one. The
   * band alone was not enough: a resize leaves scroll untouched, which slides the
   * battlefield half the size change off centre (world/camera.ts) — a 412×915 →
   * 915×412 flip moved it ~4 tiles while troops were walking.
   *
   * Untouched camera → re-fit, because the entry framing depends on the aspect
   * and on chrome that has just moved (portrait's bottom tray becomes a side
   * rail). Once the player has panned or zoomed, that framing is no longer theirs
   * to take back: keep what they were looking at.
   */
  private onResize(): void {
    if (!this.userMovedCamera) { this.fitCamera(); return; }
    this.rebandCamera();
    reframeAfterResize(this.cameras.main, { min: this.zoomMin, max: this.zoomMax });
    this.syncCameraBounds(this.cameras.main.zoom);
  }

  /** Begin the hold-to-deploy stream: one unit now, then a beat every
   *  deployHoldRepeatMs at the finger's CURRENT tile until it lifts. */
  private startSprayDeploy(p: Phaser.Input.Pointer): void {
    this.holdFired = true;
    // Install the repeat BEFORE the immediate beat. A one-shot hero handles that
    // beat synchronously and emits battle:holdCancel; with the old order the
    // cancel removed the already-fired confirmation timer, then this method
    // created a fresh repeat after cancellation and streamed the fallback troop.
    this.holdTimer = this.time.addEvent({
      delay: RAID_RULES.deployHoldRepeatMs,
      loop: true,
      callback: () => {
        if (!p.isDown || this.pinch.active()) { this.stopHoldDeploy(); return; }
        // A beat may only repeat what a real frame saw. After a main-thread
        // stall (a full re-simulation, GC, an atlas upload) the lifted finger's
        // release is still queued behind this frame, so `p.isDown` cannot vouch
        // for it — and Phaser's clock replays every beat the stall "earned"
        // inside this ONE frame. Skip them all; the next real frame beats again
        // if the finger really is still parked.
        if (this.frameStalled()) return;
        this.emitTap(p);
      },
    });
    this.emitTap(p);
  }

  /** True when the frame now running took longer than one hold beat of wall
   *  time. Phaser clamps its game delta, so only the raw loop delta shows a
   *  stall; absent (tests, headless) means no stall. */
  private frameStalled(): boolean {
    return (this.game?.loop?.rawDelta ?? 0) > RAID_RULES.deployHoldRepeatMs;
  }

  /**
   * Screen → tile → `battle:tap`. getWorldPoint accounts for BOTH the camera's
   * scroll and its zoom, which is what keeps a tap landing on the tile you
   * actually touched now that the camera moves at all.
   *
   * The deployability check here is ADDITIVE — it only plays a denial cue. The
   * event is emitted either way, because RaidUI's deployValid must stay the ONE
   * gate on the order list; a second filter here could drift from it.
   */
  private emitTap(p: Phaser.Input.Pointer): void {
    const w = this.cameras.main.getWorldPoint(p.x, p.y);
    const { tx, ty } = tileAtWorld(w.x, w.y, T);
    const input = battleCanvasInputRect(
      this.cameras.main.width, this.cameras.main.height, this.insets,
    );
    const zoom = this.cameras.main.zoom;
    const groundVisible = (candidateX: number, candidateY: number): boolean => battleCanvasPointVisible(
      this.game?.canvas, this.cameras.main.width, this.cameras.main.height,
      p.x + ((candidateX + 0.5) * T - w.x) * zoom,
      p.y + ((candidateY + 0.5) * T - w.y) * zoom,
      input,
    );
    // A partly covered raw tile can snap to a visible legal ground point.
    // Artwork overhang is presentation, never an additional placement rule.
    // Missing geometry is not permission to deploy through the HUD.
    if (!this.insets || !battleCanvasPointVisible(
      this.game?.canvas, this.cameras.main.width, this.cameras.main.height, p.x, p.y, input,
    )) {
      if (this.time.now - this.lastDenyAt >= DENY_FX_COOLDOWN_MS) {
        this.lastDenyAt = this.time.now;
        bus.emit('ui:toast', { msg: 'PAN TO REVEAL THIS TILE' });
      }
      return;
    }
    const visibleTiles: string[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (groundVisible(tx + dx, ty + dy)) visibleTiles.push(`${tx + dx},${ty + dy}`);
      }
    }
    // The denial cue fires only when the tap AND its whole one-tile
    // neighbourhood are invalid — RaidUI snaps to the nearest valid neighbour
    // (M23 a1), so buzzing on a snap-recoverable tap would contradict the
    // deploy that is about to happen. Still ADDITIVE: the event goes out
    // either way and RaidUI's deployValid remains the one gate.
    let recoverable = this.isDeployable(tx, ty);
    for (let dy = -1; !recoverable && dy <= 1; dy++) {
      for (let dx = -1; !recoverable && dx <= 1; dx++) {
        if (this.isDeployable(tx + dx, ty + dy)) recoverable = true;
      }
    }
    if (!recoverable) this.denyFx(tx, ty);
    bus.emit('battle:tap', {
      tx, ty, fx: w.x / T, fy: w.y / T, visibleTiles,
      // RaidUI owns the selected card and the final snap. It calls this
      // synchronously with the final destination so an adjacent snap cannot
      // land behind an actual control or beyond the visible canvas.
      previewVisible: (destination, troop, hero) => this.deployPreviewVisible(
        destination.tx, destination.ty, troop, hero, input, p.x, p.y, w.x, w.y, zoom,
      ),
    });
  }

  private deployPreviewVisible(
    tx: number,
    ty: number,
    _troop: string,
    _hero: 'vex' | 'theodor' | undefined,
    input: CanvasInputRect,
    screenX: number,
    screenY: number,
    worldX: number,
    worldY: number,
    zoom: number,
  ): boolean {
    // All units spawn on the same ground tile. Their authored height and fan
    // offsets must not make an otherwise legal north-edge drop unreachable.
    return battleCanvasPointVisible(
      this.game?.canvas, this.cameras?.main.width ?? input.right, this.cameras?.main.height ?? input.bottom,
      screenX + ((tx + 0.5) * T - worldX) * zoom,
      screenY + ((ty + 0.5) * T - worldY) * zoom,
      input,
    );
  }

  /** "Not there" cue on an invalid tile — previously a tap on the base core did
   *  nothing at all, with no explanation (RaidUI bare-returns). Throttled. */
  private denyFx(tx: number, ty: number): void {
    const now = this.time.now;
    if (now - this.lastDenyAt < DENY_FX_COOLDOWN_MS) return;
    this.lastDenyAt = now;
    const g = BattleScene.prototype.ownTransientFx.call(
      this, this.add.graphics().setDepth(overlayDepth(2695)),
    ) as Phaser.GameObjects.Graphics;
    g.lineStyle(4, 0xc75a2e, 0.95);
    g.strokeRect(tx * T + 4, ty * T + 4, T - 8, T - 8);
    g.lineBetween(tx * T + 10, ty * T + 10, (tx + 1) * T - 10, (ty + 1) * T - 10);
    g.lineBetween((tx + 1) * T - 10, ty * T + 10, tx * T + 10, (ty + 1) * T - 10);
    this.tweens.add({
      targets: g, alpha: 0, duration: 260,
      onComplete: () => BattleScene.prototype.destroyTransientFx.call(this, g),
    });
    playSfx('sfx_error');
    haptic('light');
  }

  /** Highlight the tile under the finger (green = deployable, red = not). On a
   *  phone the finger hides the tile, so this is the only placement feedback. */
  private drawHover(p: Phaser.Input.Pointer): void {
    if (!this.hoverG) return;
    const w = this.cameras.main.getWorldPoint(p.x, p.y);
    const { tx, ty } = tileAtWorld(w.x, w.y, T);
    const cam = this.cameras.main;
    const ok = this.isDeployable(tx, ty) && this.insets !== null && battleCanvasPointVisible(
      this.game?.canvas, cam.width, cam.height,
      p.x + ((tx + 0.5) * T - w.x) * cam.zoom,
      p.y + ((ty + 0.5) * T - w.y) * cam.zoom,
      battleCanvasInputRect(cam.width, cam.height, this.insets),
    );
    this.hoverG.clear();
    this.hoverG.fillStyle(ok ? 0x8cb36e : 0xc75a2e, 0.35);
    this.hoverG.fillRect(tx * T, ty * T, T, T);
    this.hoverG.lineStyle(2, ok ? 0xe6f2c8 : 0xc75a2e, 0.95);
    this.hoverG.strokeRect(tx * T, ty * T, T, T);
  }

  private clearHover(): void {
    this.hoverG?.clear();
  }

  /**
   * Live destruction %, mirroring the sim's accounting EXACTLY: HP-weighted over
   * buildings with countsForDestruction (sim.ts:232 — everything that is not a
   * wall and not a trap), floored, accumulating on DAMAGE rather than on
   * destruction. The scene already tracks every building's hp, so this needs no
   * extra server data. Throttled, and the server's resolved destructionPct still
   * pins the final number in RaidUI.
   */
  private emitProgress(corrected = false): void {
    if (this.correctingPlayback) return;
    if (this.destructibleMaxHp <= 0) return;
    const now = this.time.now;
    if (!corrected && now - this.lastProgressAt < PROGRESS_EMIT_MS) return;
    this.lastProgressAt = now;
    let dealt = 0;
    for (const b of this.buildings.values()) {
      if (b.type === 'wall' || (TRAP_TYPES as readonly string[]).includes(b.type) || b.maxHp <= 0) continue;
      dealt += b.maxHp - b.hp;
    }
    const pct = Math.min(100, Math.floor((dealt * 100) / this.destructibleMaxHp));
    if (!corrected && pct === this.lastProgressPct) return;
    this.lastProgressPct = pct;
    bus.emit('battle:progress', { pct, ...(corrected ? { corrected: true } : {}) });
  }

  private wallFrames = new Map<string, string>();
  private wallArt: WallLayer | undefined;
  private visualGate: SceneVisualGate | undefined;
  private fantasyGround: SceneGround | undefined;
  /** The snapshot's frozen obstacle decor, kept so a kit ground that becomes ready after create() can re-key it. */
  private obstacleDecor: Array<{ sprite: Phaser.GameObjects.Sprite; row: SnapshotObstacle }> = [];

  /** E-11, the battle twin of BaseScene.styleObstacle: the kit sheet frame when
   * the ready revision-5 ground maps this server spriteKey, else the frozen
   * `dec_` master (O-7). A raid snapshot freezes rows as decor, so the state is
   * always `intact`. The tile footprint always comes from the `dec_` meta and
   * the seat is the shared one (buildingSeatY: bottom edge on the footprint's
   * south edge, anchor x on its centre), so the scout/attack field shows the
   * same tree in the same place as the defender's home view and the deed. */
  private styleObstacle(sprite: Phaser.GameObjects.Sprite, o: { spriteKey: string; tx: number; ty: number }): void {
    const fix: Record<string, string> = { pine1: 'pine_1', pine2: 'pine_2' };
    const wanted = `dec_${fix[o.spriteKey] ?? o.spriteKey}`;
    const decKey = this.meta[wanted] ? wanted : 'dec_rock_s';
    const size = this.meta[decKey]?.footprint?.[0] ?? 1;
    const kit = this.fantasyGround?.obstacleSprite(o.spriteKey, 'intact', o.tx, o.ty);
    if (kit) sprite.setTexture(kit.key, kit.frame).setOrigin(kit.origin[0], kit.origin[1]).setScale(kit.scale);
    else {
      const [ax, ay] = this.meta[decKey]?.anchor ?? [0.5, 1];
      sprite.setTexture(atlasFor(decKey), decKey).setOrigin(ax, ay).setScale(1);
    }
    sprite.setPosition((o.tx + size / 2) * T, buildingSeatY(o.ty, size, T, sprite.originY, sprite.displayHeight))
      .setDepth(buildingDepth((o.ty + size) * T));
  }
  /** The kit ground became ready after the rows were drawn: re-key every obstacle. */
  private restyleObstacles(): void {
    for (const { sprite, row } of this.obstacleDecor) this.styleObstacle(sprite, row);
  }

  private spriteKeyFor(b: SnapshotBuilding): string {
    // Walls alone use five visual tiers. The baseline is replaced by the
    // scene's contextual pixels before playback begins.
    if (b.type === 'wall') return this.wallFrames.get(b.id) ?? wallFrameKey(b.level);
    // A battle/scout is always the RAIDER view. Ground traps use the pack's
    // deliberately boring hidden frame; the Air Mine truthfully keeps drift.
    // Already-spent traps persist as sprung until the owner repairs them.
    if (isWareTrapUnit(b.type)) {
      return wareTrapStateAliasKey(b.type, b.level, b.trapSpentAt ? 'spent' : 'hidden');
    }
    // Hero altars ship ONE un-leveled master each (hero levels live on the hero).
    if (b.type === 'heroaltar' || b.type === 'siegestool') return `bld_${b.type}`;
    // Protected v2 towers spawn on their CURRENT-art eager idle still, so a
    // battle whose rich tier atlas is rejected by the texture budget never
    // regresses to the legacy pack (owner 2026-08-16: campaign fights showed
    // the old cannon whenever the defender's tier was not already resident).
    if (b.type === 'mortar' || b.type === 'cannon') {
      return v2BuildingFallbackFrameKey(b.type, artTierOfLevel(b.level), 1);
    }
    // Phase E berth (P6a): the frozen installation's family intact cell (a
    // hidden frameless footprint until resident); every unpresented state is
    // the hidden footprint — the ordinary sheet has no berth cell (D-c).
    if (b.type === 'berth') return this.berthRestKeyFor(b) ?? BERTH_UNPRESENTED_KEY;
    // Phase E Market (C3): the selected family's resting cell (frozen Awning
    // once resident, else ordinary tier art). A legacy sidecar keeps bld_.
    if (marketArtFamilyOf(b.type)) {
      const rest = marketRestFrameKey(this.marketArt, this.marketChoiceFor(b));
      if (rest) return rest;
      if (b.type === 'harvester') return HARVESTER_UNPRESENTED_KEY;
    }
    return `bld_${b.type}_l${Math.min(20, b.level)}`;
  }

  /**
   * One presentation seat across eager @2x aliases, rich @1x controllers and
   * @1x damage/collapse/spent fallbacks. Logical footprint remains separate and
   * comes exclusively from shared gameplay constants via footprintOf().
   */
  private buildingSeat(frame: string): BuildingSeat {
    if (isContextWallFrame(frame)) return { origin: [0.5, 1], scale: 2, offsetGamePx: [0, 0] };
    const seat = v2BldSeat(this.v2meta.clips, frame)
      ?? wareSeat(this.waremeta.clips, frame)
      ?? marketSeat(this.marketArt, frame)
      ?? starterFleetSeat(this.starterFleetArt, frame)
      ?? advancedFleetSeat(this.advancedFleetArt, frame);
    const meta = this.meta[frame];
    const eagerScale = meta?.sourceScale === undefined
      ? 1
      : V2_DRAW_SCALE * meta.sourceScale / eagerAtlasScale(atlasFor(frame));
    const richOffset = seat && 'offsetGamePx' in seat
      ? (seat as { offsetGamePx?: readonly [number, number] }).offsetGamePx
      : undefined;
    return {
      origin: seat?.origin ?? meta?.anchor ?? [0.5, 1],
      scale: seat?.scale ?? eagerScale,
      offsetGamePx: richOffset ?? meta?.offsetGamePx ?? [0, 0],
    };
  }

  /** Absolute seating makes re-keying idempotent: offsets are never accumulated. */
  private positionBuildingSprite(
    sprite: Phaser.GameObjects.Sprite,
    b: Pick<BuildingRec, 'tx' | 'ty' | 'fw' | 'fh'>,
    frame: string,
  ): void {
    // Origin and scale FIRST: the seat is the sprite's drawn bottom edge on the
    // footprint's south edge, so it is measured off the resulting displayHeight.
    const seat = this.buildingSeat(frame);
    sprite.setOrigin(seat.origin[0], seat.origin[1]).setScale(seat.scale);
    sprite.setPosition(
      (b.tx + b.fw / 2) * T + seat.offsetGamePx[0] * V2_DRAW_SCALE,
      buildingSeatY(b.ty, b.fh, T, seat.origin[1], sprite.displayHeight)
        + seat.offsetGamePx[1] * V2_DRAW_SCALE,
    );
  }

  private spawnBuilding(b: SnapshotBuilding): void {
    const key = this.spriteKeyFor(b);
    const [fw, fh] = footprintOf(b.type, this.geometryVersion);
    const seat = this.buildingSeat(key);
    // A Market has no eager still (C3): until its family is resident the body
    // is a frameless hidden sprite, never a missing-frame request. The
    // footprint, HP bar, depth and occupancy below are unaffected.
    const marketPending = key === HARVESTER_UNPRESENTED_KEY || (marketArtFamilyOf(b.type) !== null && MARKET_FRAME_KEY.test(key)
      && !isV2AtlasLoaded(this, atlasFor(key)));
    // A berth likewise (P6a): hidden until every group of its composition is
    // resident, hidden for good when unpresented (never the whole bld sheet).
    const berthPending = b.type === 'berth' && (key === BERTH_UNPRESENTED_KEY || !this.berthArtResident(b.id));
    const pending = marketPending || berthPending;
    const spawnAtlas = b.type === 'berth' ? berthKeyGroup(key) ?? atlasFor(key) : atlasFor(key);
    const s = pending
      ? this.add.sprite((b.tx + fw / 2) * T + seat.offsetGamePx[0] * V2_DRAW_SCALE, 0, spawnAtlas)
      : this.add.sprite(
        (b.tx + fw / 2) * T + seat.offsetGamePx[0] * V2_DRAW_SCALE, 0,
        spawnAtlas, key,
      );
    if (pending) s.setVisible(false);
    const [ax, ay] = seat.origin;
    // WORLD_DEPTH: walls/buildings share the structure painter axis. A building
    // wins an equal south-edge tie; a strictly southern wall may cover it. Both
    // remain below every troop on the field (owner 2026-08-30/31).
    const depth = b.type === 'wall'
      ? wallDepth((b.ty + fh) * T)
      : buildingDepth((b.ty + fh) * T);
    // Origin and scale BEFORE the seat: the sprite's drawn bottom edge is what
    // sits on the south edge, and displayHeight is only true once both are set.
    s.setOrigin(ax, ay).setScale(seat.scale).setDepth(depth);
    s.setY(buildingSeatY(b.ty, fh, T, ay, s.displayHeight)
      + seat.offsetGamePx[1] * V2_DRAW_SCALE);
    if (b.type === 'mortar' || b.type === 'cannon') {
      const tier = artTierOfLevel(b.level);
      this.anim.register(s, atlasFor(key), [
        v2BuildingFallbackFrameKey(b.type, tier, 1),
        v2BuildingFallbackFrameKey(b.type, tier, 2),
      ]);
    }
    for (let dy = 0; dy < fh; dy++) for (let dx = 0; dx < fw; dx++) this.occupied.add(`${b.tx + dx},${b.ty + dy}`);
    const maxHp = buildingMaxHp(b.type, b.level);
    // Denominator of the live destruction % — same filter the sim uses.
    if (b.type !== 'wall' && !(TRAP_TYPES as readonly string[]).includes(b.type)) {
      this.destructibleMaxHp += maxHp;
    }
    // R4: every targetable building (maxHp > 0) gets a persistent HP bar shown
    // at FULL from battle start, so the attacker watches damage land in real
    // time. Untargetable structures (spike traps, maxHp 0) get no bar.
    this.buildings.set(b.id, {
      sprite: s, type: b.type, key, level: b.level, tx: b.tx, ty: b.ty, fw, fh,
      hp: maxHp, maxHp,
      bar: maxHp > 0 ? new HpBar(this, 'building', overlayDepth(2660), 6) : null,
      damage: new BuildingDamage(this, this.anim, b.tx, b.ty, fw, fh, T, depth),
      destroyed: false,
      trapSpent: b.trapSpentAt != null,
    });
    if (b.type === 'keep') this.keepClock?.sync(b.id, s, b.level);
  }

  /** Nearest still-standing building's world-point (troop attack facing —
   *  legacy flipX reads .x only; the v2 8-way facing needs .y too). */
  private nearestBuildingX(fromX: number, fromY: number): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const b of this.buildings.values()) {
      if (b.destroyed) continue;
      const bx = (b.tx + b.fw / 2) * T;
      const by = (b.ty + b.fh) * T;
      const d = (bx - fromX) ** 2 + (by - fromY) ** 2;
      if (d < bestD) { bestD = d; best = { x: bx, y: by }; }
    }
    return best;
  }

  /** Frozen occupancy intentionally survives every destruction event. */
  private isDeployable(tx: number, ty: number): boolean {
    return isBattlefieldTileDeployable(tx, ty, {
      battlefieldVersion: this.battlefieldVersion, claimMin: this.claimMin, claimMax: this.claimMax,
      deploymentBlockers: this.deploymentBlockers,
    }, this.occupied);
  }

  // -------------------------------------------------------------------------
  // Event-log playback
  // -------------------------------------------------------------------------

  /** One full authored Keg Runner prime loop, expressed in sim ticks. The
   * value is derived from packed frame metadata, never a gameplay countdown. */
  private kegPrimeLeadTicks(): number {
    const tier = this.v2TroopTiers.get('kegrunner');
    if (!tier) return 0;
    const clip = this.v2meta.clips[clipKey('trp', 'kegrunner', tier, 'prime')];
    const fps = clip?.fps ?? 0;
    if (!clip || !Number.isFinite(fps) || fps <= 0 || clip.frames <= 0) return 0;
    return Math.max(1, Math.ceil((clip.frames * 1000) / fps / TICK_MS));
  }

  /**
   * Schedule an event stream for playback.
   *
   * `fromTick` supports MID-BATTLE DEPLOY (A3b): when the player commits a troop
   * during the fight, RaidUI re-simulates and re-feeds the stream. Everything
   * before an on-time deployment is byte-identical (the sim's mid-battle
   * invariant). A delayed canonical receipt can instead alter a prefix already
   * drawn: compare actor histories and reconstruct only affected actors before
   * rebasing the suffix. Unchanged damage must never be applied twice.
   *
   * Each event-log actor's behavior-complete compact controller is a mandatory
   * local presentation attempt. Rich controllers, defender fire art and audio
   * still warm against the real event schedule and never hold the authoritative
   * server clock. A family may adopt until its first functional deploy/fire
   * callback; after that it stays frozen on the art that actually rendered.
   */
  private play(
    events: Ev[], fromTick = 0, simVersion?: number, appliedPrefix = false, terminal = false,
    fightOpen = false,
    heroLoadouts?: Partial<Record<HeroKey, HeroCombatLoadout>>,
  ): Promise<void> | void {
    const request = (this.playRequestGeneration ?? 0) + 1;
    this.playRequestGeneration = request;
    if (this.visualGate && !this.visualGate.isReady) {
      const queuedAt = Date.now();
      return this.visualGate.ready().then(() => {
        if (request !== this.playRequestGeneration || !this.scene.isActive()) return;
        // A replay's local playhead waits for its first visible frame. An open
        // raid still belongs to server time; hydrate its elapsed prefix on entry.
        const elapsedTicks = fightOpen && !terminal ? Math.max(0, Date.now() - queuedAt) / TICK_MS : 0;
        return BattleScene.prototype.play.call(this, events, fromTick + elapsedTicks,
          simVersion, appliedPrefix, terminal, fightOpen, heroLoadouts);
      });
    }
    // D-106: the newest request decides whether this stream's end may idle the
    // field open. A terminal (already settled) replay never does.
    this.fightOpen = fightOpen && !terminal;
    const requestedNow = Date.now();
    const pendingGate = this.pendingPlaybackGate;
    const prefixAlreadyRendered = pendingGate?.appliedPrefix
      ?? (appliedPrefix && this.renderedPlaybackState === true);
    const renderedFromTick = pendingGate?.fromTick ?? (prefixAlreadyRendered
      ? BattleScene.prototype.currentRenderedPlaybackTick.call(this, fromTick)
      : fromTick);
    const inheritedCatchUpMs = pendingGate?.catchUpMs
      ?? (prefixAlreadyRendered ? Math.max(0, this.catchUpMs ?? 0) : 0);
    const start = (tick: number, prefix: boolean, renderedTick: number | undefined, catchUpMs: number): void => {
      // A worker-resolved replay is state recovery, including any synchronous
      // tick-zero events. Scope silence to the accepted generation's start;
      // never leave a global mute flag set while an obsolete art load waits.
      const wasJumping = this.jumping;
      if (terminal) this.jumping = true;
      try {
        BattleScene.prototype.startPlayback.call(this, events, tick, simVersion, prefix, renderedTick, catchUpMs, heroLoadouts);
        if (terminal && this.playbackEnd) this.jumpToEnd(this.playbackEnd.getRemaining());
      } finally {
        this.jumping = wasJumping;
      }
    };
    // A spawned Wyrmling has no deploy/troopSpawn record, so reserve the Nest
    // body + Hatchling lifecycle + WARE FX atomically before attacker or
    // optional defender spend. The returned load joins the same bounded gate.
    const mandatoryNestLoads = this.requestDefenseArtForEvents?.(events, true) ?? [];
    if (this.wallArt?.preparing) mandatoryNestLoads.push(this.wallArt.ready());
    const renderedTroops = deployedTroopTypes(events)
      .filter((troop) => v2TroopProfile(troop) !== undefined);
    const compactArtReady = (troop: string): boolean => {
      const tier = artTierOfLevel(this.armyLevels?.[troop] ?? 1);
      return this.v2TroopLocomotionTiers?.get(troop) === tier
        || this.v2TroopTiers?.get(troop) === tier;
    };
    const missing = prioritizeRequiredWalkers(renderedTroops)
      .filter((troop) => !compactArtReady(troop) && !this.artDecidedTroops?.has(troop));
    const requestCompact = this.requestV2TroopLocomotionArt?.bind(this);
    if (mandatoryNestLoads.length === 0 && (missing.length === 0 || !requestCompact)) {
      const waitedTicks = pendingGate
        ? pendingPlaybackGateSimMs(pendingGate, requestedNow, this.playbackRate ?? 1) / TICK_MS
        : 0;
      if (this.pendingPlaybackGate === pendingGate) this.pendingPlaybackGate = undefined;
      start(
        renderedFromTick + waitedTicks, prefixAlreadyRendered,
        pendingGate && prefixAlreadyRendered ? renderedFromTick : undefined,
        inheritedCatchUpMs,
      );
      return;
    }

    const families = new Set<string>();
    const loads: Promise<void>[] = [...mandatoryNestLoads];
    for (const troop of missing) {
      const family = troop === 'hexbarrow' || troop === 'barrowling'
        ? ['hexbarrow', 'barrowling']
        : [troop];
      const key = family.join(':');
      if (families.has(key)) continue;
      families.add(key);
      if (requestCompact) loads.push(requestCompact(family));
    }

    // Freeze the replaced schedule at the exact applied-prefix boundary. If
    // art waits while the prior generation keeps running, newly introduced
    // actors in that elapsed interval can be skipped forever.
    const gate = pendingGate ?? {
      fromTick: renderedFromTick,
      requestedAt: requestedNow,
      elapsedSimMs: 0,
      rateChangedAt: requestedNow,
      rate: this.playbackRate ?? 1,
      catchUpMs: inheritedCatchUpMs,
      appliedPrefix: prefixAlreadyRendered,
    };
    this.pendingPlaybackGate = gate;
    if (!pendingGate) {
      this.playGeneration = (this.playGeneration ?? 0) + 1;
      retirePlaybackTimers(this.time, this.timeline ?? []);
      this.timeline = [];
      this.troops?.forEach((troop) => troop.fx.cancelPrime());
      this.resetPauseCatchUp?.();
    }

    // The loader has the same finite deadline, and this outer bound keeps the
    // battle safe even if a future request wrapper accidentally loses its
    // rejection/settlement path. Neither failure mode may suppress battle:done.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<void>((resolve) => {
      const remaining = Math.max(
        0, ON_DEMAND_ATLAS_LOAD_TIMEOUT_MS - (requestedNow - gate.requestedAt),
      );
      deadline = setTimeout(resolve, remaining);
    });
    return Promise.race([
      Promise.allSettled(loads).then(() => undefined),
      bounded,
    ]).then(() => {
      if (request !== this.playRequestGeneration || !this.scene.isActive()) return;
      const unavailable = renderedTroops.filter((troop) => !compactArtReady(troop));
      if (unavailable.length > 0) {
        console.error(
          `[BattleScene] compact battle motion unavailable; using snap playback: ${unavailable.join(', ')}`,
        );
        bus.emit('ui:toast', { msg: 'BATTLE MOTION UNAVAILABLE — USING SNAP PLAYBACK' });
      }
      const waitedTicks = pendingPlaybackGateSimMs(
        gate, Date.now(), this.playbackRate ?? 1,
      ) / TICK_MS;
      if (this.pendingPlaybackGate === gate) this.pendingPlaybackGate = undefined;
      start(
        gate.fromTick + waitedTicks, gate.appliedPrefix,
        gate.appliedPrefix ? gate.fromTick : undefined, gate.catchUpMs,
      );
    }).finally(() => {
      if (deadline !== undefined) clearTimeout(deadline);
    });
  }

  private startPlayback(
    events: Ev[], fromTick = 0, simVersion?: number, appliedPrefix = false,
    hydrateFromTick?: number, inheritedCatchUpMs = 0,
    heroLoadouts?: Partial<Record<HeroKey, HeroCombatLoadout>>,
  ): void {
    const generation = ++this.playGeneration;
    const appliedThrough = appliedPrefix ? (hydrateFromTick ?? fromTick) : -1;
    const changed = appliedPrefix && this.playbackEvents
      ? changedPlaybackActors(this.playbackEvents, events, appliedThrough)
      : new Set<string | number>();
    const armyHpBps = battleArmyHpBps(heroLoadouts ? { heroLoadouts } : {});
    if (appliedPrefix && armyHpBps !== (this.armyHpBps ?? 0)) {
      // An accepted hero order contributes from tick zero in the simulator,
      // even if the hero will deploy later. Rebuild only affected direct troops
      // so a previously latched damaged body cannot survive an obsolete max HP.
      for (const event of events) if (event.e === 'deploy' && !event['hero']) {
        changed.add(event['id'] as number);
      }
    }
    this.armyHpBps = armyHpBps;
    this.heroLoadouts = heroLoadouts ?? {};
    this.playbackEvents = events;
    const dragonDeploymentSfxGeneration = this.dragonDeploymentSfxGeneration;
    // Replacing a live stream: cancel any synthetic pre-detonation pose before
    // dropping its timer, or the Keg remains movement-locked until a later blast.
    this.troops.forEach((troop) => {
      troop.fx.cancelPrime();
      // Already-started authored actions and scene-pooled projectiles outlive a
      // mid-battle schedule replacement. Only future timers are replaced.
    });
    this.clearBurnfields();
    // Drop the old timers first, or both schedules run.
    retirePlaybackTimers(this.time, this.timeline);
    this.timeline = [];
    // A rolling stream is rebased to the field's rendered clock, not RaidUI's
    // wall clock. Preserve any hidden-tab debt so the replacement continues
    // replaying that ordered suffix at the labelled catch-up scale.
    if (inheritedCatchUpMs > 0) {
      this.playbackActive = false;
      this.playbackEnd = undefined;
    } else {
      this.resetPauseCatchUp();
    }
    this.playbackActive = true;
    this.renderedPlaybackState = true;
    this.playbackOriginTick = fromTick;
    this.playbackOriginSceneTime = this.time.now;
    this.playbackRenderedSceneTime = this.time.now;
    if (inheritedCatchUpMs > 0) {
      this.catchUpMs = inheritedCatchUpMs;
      this.setPlaybackTimeScale(RAID_PLAYBACK.catchUpTimeScale);
    }
    const isCurrent = (): boolean => generation === this.playGeneration && this.scene.isActive();
    const schedule = (delayMs: number, callback: () => void): Phaser.Time.TimerEvent | undefined => {
      if (delayMs <= 0) {
        if (isCurrent()) callback();
        return undefined;
      }
      const timer = this.time.delayedCall(delayMs, () => {
        if (isCurrent()) callback();
      });
      this.timeline.push(timer);
      return timer;
    };
    if (this.productionSfxBanks instanceof Set) {
      this.productionSfxBanks.forEach((bank) => sceneCleanup('production-sfx-bank', () => bank.release()));
      this.productionSfxBanks.clear();
    } else {
      this.productionSfxBanks = new Set<SfxBank>();
    }
    const audioPlan = planBattleSfx(
      events,
      this.buildings instanceof Map
        ? [...this.buildings].map(([id, building]) => ({ id, type: building.type }))
        : [],
    ).filter((cue) => cue.atMs >= fromTick * TICK_MS);
    this.replayFallbackSfxBank?.release();
    const fallbackBank = acquireSfxBank(legacyFallbackBankForPlan(audioPlan));
    this.replayFallbackSfxBank = fallbackBank;
    const productionAudioReady = loadProductionSfxManifest().then(async (loaded) => {
      if (!loaded || !isCurrent()) {
        return { windows: [], initial: [] as Array<{ startMs: number; bank: SfxBank }> };
      }
      const windows = productionBankWindowsForPlan(audioPlan);
      const initialWindows = windows.filter((window) => window.startMs
        <= fromTick * TICK_MS + AUDIO_RUNTIME.battleBankPreloadLeadMs);
      const initial = initialWindows.map((window) => ({
        startMs: window.startMs,
        bank: acquireSfxBank(window.cues),
      }));
      await Promise.all(initial.map(({ bank }) => bank.ready));
      return { windows, initial };
    }).catch(() => ({
      windows: [], initial: [] as Array<{ startMs: number; bank: SfxBank }>,
    }));
    const renderedTroops = deployedTroopTypes(events);
    const undecided = renderedTroops
      .filter((troop) => v2TroopProfile(troop) !== undefined)
      .filter((troop) => !this.artDecidedTroops.has(troop));
    // The event log is the first truthful defender-roster signal. Reserve its
    // fire/spawn/trap families before passive building enhancement, but do not
    // await network media between battle:play and tick zero.
    const defenseLoads = this.requestDefenseArtForEvents?.(events) ?? [];
    // Mandatory behavior-complete compact families reserve first in stable
    // priority order. Rich bodies are optional enhancement and may never crowd
    // out another rendered actor's attacks, abilities or death route.
    const artPriority = prioritizeRequiredWalkers(undecided);
    const compactLoads: Promise<void>[] = [];
    const compactFamilies = new Set<string>();
    const requestCompact = (troop: string): void => {
      const family = troop === 'hexbarrow' || troop === 'barrowling'
        ? ['hexbarrow', 'barrowling']
        : [troop];
      const key = family.join(':');
      if (compactFamilies.has(key)) return;
      compactFamilies.add(key);
      const complete = family.every((unit) => {
        const tier = artTierOfLevel(this.armyLevels?.[unit] ?? 1);
        return this.v2TroopLocomotionTiers?.get(unit) === tier
          || this.v2TroopTiers?.get(unit) === tier;
      });
      if (complete) return;
      compactLoads.push(this.requestV2TroopLocomotionArt(family));
    };
    for (const troop of artPriority) requestCompact(troop);

    const controllerLoads: Promise<void>[] = [];
    const controllerFamilies = new Set<string>();
    for (const troop of artPriority) {
      const key = troop === 'hexbarrow' || troop === 'barrowling'
        ? 'hexbarrow:barrowling'
        : troop;
      if (controllerFamilies.has(key)) continue;
      controllerFamilies.add(key);
      controllerLoads.push(this.requestV2TroopArt(troop));
    }
    const direCore = this.v2TroopLoads.get('direwyvern') ?? Promise.resolve();
    const direEnhancement = undecided.includes('direwyvern')
      ? this.requestV2DireEnhancementArt(direCore)
      : Promise.resolve();
    // These requests may adopt before their own first scheduled event, but this
    // replay is already complete with exact-current eager aliases.
    void Promise.allSettled([
      this.artReady, direCore,
      ...compactLoads, ...controllerLoads, direEnhancement, ...defenseLoads,
    ]);
    void fallbackBank.ready;
    // The entire deterministic log is available before any deploy timer fires.
    // Current logs pre-arm every event-driven melee actor, including spawned
    // brood and actors killed before contact (and thus carrying no attack cue).
    // Older persisted logs retain their auto-swing fallback. Missing protocol
    // metadata keeps the cue-based compatibility path used during transition.
    this.meleeDrivenIds.clear();
    if (simVersion !== undefined && simVersion >= SELF_DESCRIBING_MELEE_SIM_VERSION) {
      for (const ev of events) {
        if ((ev.e === 'deploy' || ev.e === 'troopSpawn') && ev['hero'] === undefined
          && v2TroopProfile(String(ev['troop']))?.melee) {
          this.meleeDrivenIds.add(ev['id'] as number);
        }
      }
    } else if (simVersion !== undefined && simVersion >= TARGET_AWARE_MELEE_SIM_VERSION) {
      for (const ev of events) {
        if (ev.e === 'deploy' && ev['troop'] === 'troll') this.meleeDrivenIds.add(ev['id'] as number);
      }
    } else {
      for (const ev of events) {
        if (ev.e === 'troopAttack') this.meleeDrivenIds.add(ev['id'] as number);
      }
    }
    this.troops.forEach((troop, id) => {
      if (this.meleeDrivenIds.has(id)) troop.fx.setMeleeDriven();
    });
    this.correctingPlayback = changed.size > 0;
    try {
      if (changed.size > 0) {
        BattleScene.prototype.resetPlaybackActors.call(this, changed);
        BattleScene.prototype.applyPlaybackStateRange.call(
          this, events, 0, fromTick, false, (id) => changed.has(id),
        );
      }
      if (fromTick > 0 && (!appliedPrefix || hydrateFromTick !== undefined)) {
        BattleScene.prototype.applyPlaybackStateRange.call(
          this, events, appliedPrefix ? (hydrateFromTick ?? fromTick) : 0, fromTick,
          appliedPrefix, changed.size ? (id) => !changed.has(id) : undefined,
        );
      }
    } finally {
      this.correctingPlayback = false;
    }
    // Mid-battle replacement logs skip earlier events, but a burn interval
    // that began earlier remains visible until its authoritative exclusive
    // `until`. Rebuild it with only the exact remaining duration.
    if (fromTick > 0) {
      for (const ev of events) {
        if (ev.e === 'burnfield' && (ev.t as number) < fromTick
          && (ev['until'] as number) > fromTick) {
          this.onBurnfield(ev, fromTick);
        }
      }
    }
    // Pending placement actors survive ATTACK. Their matching deploy event
    // promotes the same controller below; only unmatched replay actors spawn.
    const maxTick = events.length ? (events[events.length - 1]!.t as number) : 0;
    const deployTicks = new Map<number, number>();
    const positions = positionPlayback(events, fromTick);
    const duplicateLegacyCues = attackRunLegacyCueKeys(events);
    const playbackStartAt = this.time.now;
    void productionAudioReady.then(({ windows, initial }) => {
      if (!isCurrent()) {
        initial.forEach(({ bank }) => bank.release());
        return;
      }
      // The exact replay slice now pins every Dragon variant it can play. Drop
      // the broader deployment lease only while this generation still owns it.
      this.releaseDragonDeploymentSfxBank(dragonDeploymentSfxGeneration);
      const replayNow = fromTick * TICK_MS + Math.max(0, this.time.now - playbackStartAt);
      const initialByStart = new Map(initial.map(({ startMs, bank }) => [startMs, bank]));
      const retainUntil = (bank: SfxBank, releaseAt: number, now: number): void => {
        this.productionSfxBanks.add(bank);
        schedule(Math.max(0, releaseAt - now), () => {
          bank.release();
          this.productionSfxBanks.delete(bank);
        });
      };
      for (const window of windows) {
        const acquireAt = window.startMs - AUDIO_RUNTIME.battleBankPreloadLeadMs;
        const releaseAt = window.startMs + AUDIO_RUNTIME.battleBankWindowMs
          + AUDIO_RUNTIME.battleBankPreloadLeadMs;
        const initialBank = initialByStart.get(window.startMs);
        if (releaseAt <= replayNow) {
          initialBank?.release();
          continue;
        }
        if (initialBank) {
          retainUntil(initialBank, releaseAt, replayNow);
          continue;
        }
        const acquire = (now: number): void => {
          if (generation !== this.playGeneration) return;
          const bank = acquireSfxBank(window.cues);
          void bank.ready;
          retainUntil(bank, releaseAt, now);
        };
        if (acquireAt <= replayNow) acquire(replayNow);
        else schedule(acquireAt - replayNow, () => acquire(acquireAt));
      }
    });
    for (const cue of audioPlan) {
      if (cue.dispatch) continue;
      schedule(cue.atMs - fromTick * TICK_MS, () => {
        if (this.jumping) return; // D-099: a jumped span is silent
        playSfxFamily(cue.family, cue.variantKey, cue.fallback, cue.opts);
      });
    }
    for (const ev of events) {
      if (ev.e === 'deploy') deployTicks.set(ev['id'] as number, ev.t as number);
    }
    for (const sourceEvent of events) {
      let ev = sourceEvent;
      // A replacement's exact boundary already ran on the old Clock. Apply
      // it again only to corrected actors, which were rebuilt strictly before
      // this tick. In particular, an unchanged boundary hit must not land twice.
      if (appliedPrefix && ev.t === appliedThrough && fromTick === appliedThrough) {
        const correctedEvent = playbackEventForActors(ev, (id) => changed.has(id));
        if (!correctedEvent) continue;
        ev = correctedEvent;
      }
      if (ev.e === 'attackRun' && (ev.t as number) < fromTick) {
        try {
          const suffix = attackRunSuffixFromTick(ev as unknown as AttackRunEvent, fromTick);
          if (!suffix) continue;
          ev = suffix as unknown as Ev;
        } catch {
          continue;
        }
      }
      if ((ev.t as number) < fromTick) continue; // hydrated or already applied
      if ((ev.e === 'troopFire' || ev.e === 'troopAttack')
        && duplicateLegacyCues.has(`${ev['id'] as number}:${ev.t as number}:${ev.e}`)) continue;
      if (ev.e === 'detonate') {
        const leadTicks = this.kegPrimeLeadTicks();
        // Never schedule anticipation before this actor exists. When deployment
        // and prime share a tick, insertion order guarantees deploy runs first.
        const deployTick = deployTicks.get(ev['id'] as number) ?? fromTick;
        const primeTick = Math.max(fromTick, deployTick, (ev.t as number) - leadTicks);
        if (leadTicks > 0 && primeTick < (ev.t as number)) {
          schedule((primeTick - fromTick) * TICK_MS, () => {
            this.troops.get(ev['id'] as number)?.fx.onPrime();
            if (this.jumping) return; // D-099: a jumped span is silent
            playSfxFamily(
              'sfx_troop_kegrunner_plant_brace',
              `${String(ev['id'])}:${String(ev.t)}:detonate:prime`,
            );
          });
        }
      }
      const position = positions.get(ev);
      if (position) {
        if (position.skip) continue;
        schedule((position.startTick - fromTick) * TICK_MS, () => {
          this.onPos(ev, position.durationMs);
        });
      } else {
        schedule(((ev.t as number) - fromTick) * TICK_MS, () => this.apply(ev));
      }
    }
    // Scheduled LAST on purpose: the Clock fires due timers in insertion
    // order, so a D-099 jump lands the verdict after every remaining event.
    this.playbackEnd = schedule(
      (Math.max(maxTick - fromTick, 0) + 10) * TICK_MS,
      () => {
        if (this.jumping) return;
        if (this.fightOpen) {
          // D-106: reserves remain, so there is no verdict yet — the field
          // sits idle with the clock still running. Nothing is scheduled, so
          // there is no timeline to jump or repay; only the rendered clock
          // must keep counting for the next reserve's rebase.
          this.catchUpMs = 0;
          this.playbackEnd = undefined;
          this.setPlaybackTimeScale(this.playbackRate ?? 1);
        } else {
          // The timeline is spent: a pause under the verdict owes it nothing.
          this.resetPauseCatchUp();
        }
        bus.emit('battle:done', undefined);
      },
    );
    if (changed.size > 0) this.emitProgress(true);
  }

  /** The next replacement boundary belongs to what the Phaser field rendered.
   * A fresh scene has no such authority and falls back to RaidUI's cold-seek
   * tick. Scene UPDATE deltas are accumulated at the Clock's active scale, so
   * an outstanding hidden-tab debt can never be mistaken for applied events. */
  private currentRenderedPlaybackTick(fallbackTick: number): number {
    if (!this.renderedPlaybackState
      || !Number.isFinite(this.playbackOriginTick)
      || !Number.isFinite(this.playbackOriginSceneTime)
      || !Number.isFinite(this.playbackRenderedSceneTime)) return fallbackTick;
    const elapsedMs = Math.max(
      0, this.playbackRenderedSceneTime - this.playbackOriginSceneTime,
    );
    return Math.max(0, this.playbackOriginTick + elapsedMs / TICK_MS);
  }

  /** A reload/replay may enter after tick zero with an empty scene. Replaying
   * only state-bearing events reconstructs the exact visible prefix without
   * emitting expired attacks, sounds or transient FX. */
  private applyPlaybackStateRange(
    events: readonly Ev[], startTick: number, fromTick: number,
    startAlreadyRendered = false,
    acceptActor?: (id: string | number) => boolean,
  ): void {
    const stateEvents = new Set([
      'deploy', 'spawn', 'troopSpawn', 'pos', 'hit', 'heal', 'troopDeath',
      'destroyed', 'trap', 'chain', 'burrow', 'emerge',
    ]);
    const activeHeroAttacks = new Map<number, Ev>();
    const activeHeroSkills = new Map<number, Ev>();
    const hydratedActorIds = new Set<number>();
    const wasJumping = this.jumping;
    this.jumping = true;
    try {
      for (const sourceEvent of events) {
        const event = acceptActor ? playbackEventForActors(sourceEvent, acceptActor) : sourceEvent;
        if (!event) continue;
        if ((event.t as number) >= fromTick) break;
        if ((event.t as number) < startTick
          || (startAlreadyRendered && (event.t as number) === startTick)) continue;
        if (event.e === 'heroSkill') {
          BattleScene.prototype.applyHeroSkillState.call(this, event);
          const id = event['id'] as number;
          if (heroSkillBodyUntilTick(event) > fromTick) activeHeroSkills.set(id, event);
          else activeHeroSkills.delete(id);
        } else if (event.e === 'heroAttack'
          && (event['recoveryUntil'] as number | undefined) !== undefined
          && (event['recoveryUntil'] as number) > fromTick) {
          activeHeroAttacks.set(event['id'] as number, event);
        } else if (stateEvents.has(event.e)) {
          this.apply(event);
          if (event.e === 'deploy' || event.e === 'spawn' || event.e === 'troopSpawn') {
            hydratedActorIds.add(event['id'] as number);
          }
        }
      }
      for (const id of hydratedActorIds) {
        this.troops?.get(id)?.fx.finishSeek?.();
      }
      for (const event of activeHeroAttacks.values()) {
        this.onHeroAttack({ ...event, t: fromTick } as Ev);
      }
      for (const event of activeHeroSkills.values()) {
        this.resumeHeroSkillPhase(event, fromTick);
      }
    } finally {
      this.jumping = wasJumping;
    }
  }

  /** Backward-compatible focused-test seam for a fresh scene cold seek. */
  private applyColdPlaybackPrefix(events: readonly Ev[], fromTick: number): void {
    BattleScene.prototype.applyPlaybackStateRange.call(this, events, 0, fromTick);
  }

  /** Canonical late commands may change an already-rendered suffix. Rebuild
   * only the actors whose histories differ; terrain, camera, atlas grants and
   * every unchanged controller/animation phase stay alive. HP is then replayed
   * from zero exactly once, rather than applying corrected hits on old damage. */
  private resetPlaybackActors(changed: ReadonlySet<string | number>): void {
    clearProjectileFx(this);
    clearMuzzleFx(this);
    this.clearTransientFx();
    settleDamageText(this);
    const restoreV2 = new Set<string>(), restoreWare = new Set<string>(), restoreMarket = new Set<string>(), restoreBerth = new Set<string>();
    for (const id of changed) {
      if (typeof id === 'number') {
        this.stopLoop(id);
        const troop = this.troops.get(id);
        troop?.bar.destroy();
        troop?.fx.destroy();
        this.troops.delete(id);
        this.retiredTroopIds.get(id)?.destroy();
        this.retiredTroopIds.delete(id);
        continue;
      }
      const original = this.snapshotBuildings.get(id);
      const building = this.buildings.get(id);
      if (!original || !building) continue;
      if (building.artMode === 'v2') restoreV2.add(id);
      if (building.artMode === 'ware') restoreWare.add(id);
      if (building.artMode === 'market') restoreMarket.add(id);
      if (building.artMode === 'berth') restoreBerth.add(id);
      this.keepClock?.remove(id);
      building.bar?.destroy();
      building.damage.destroy();
      building.v2?.destroy();
      building.ware?.destroy();
      building.wareTrap?.destroy();
      building.market?.destroy();
      building.berth?.destroy();
      this.anim.unregister(building.sprite);
      this.v2Ticker.unregister(building.sprite);
      cancelDefenceFire(building.sprite);
      building.sprite.destroy();
      if (building.type !== 'wall' && !(TRAP_TYPES as readonly string[]).includes(building.type)) {
        this.destructibleMaxHp -= building.maxHp;
      }
      this.spawnBuilding(original);
    }
    // Reuse only already-admitted routes, including bodies whose old collapse
    // destroyed their controller. No requests, eviction or art-quality change.
    if (restoreV2.size) this.adoptV2Defenses(undefined, restoreV2);
    if (restoreWare.size) this.adoptWareBuildings(undefined, restoreWare);
    if (restoreMarket.size) this.adoptMarketBuildings(undefined, restoreMarket);
    if (restoreBerth.size) this.adoptBerthBuildings(undefined, restoreBerth);
    this.retileSurvivingWalls();
  }

  /** Restore only a still-authoritative body phase. Historical transient FX,
   * haptics and sound stay expired; the actor receives the exact remaining
   * lock so finishSeek cannot leave a fake-dead or winding-up hero idle. */
  private resumeHeroSkillPhase(event: Ev, fromTick: number): void {
    const actor = this.troops.get(event['id'] as number)?.fx;
    const bodyUntil = heroSkillBodyUntilTick(event);
    if (!actor || bodyUntil <= fromTick) return;
    const remainingMs = Math.max(1, (bodyUntil - fromTick) * TICK_MS);
    const skill = String(event['skill']);
    const phase = typeof event['phase'] === 'string' ? event['phase'] : 'impact';
    actor.onHeroSkill(
      skill, phase, remainingMs,
      Math.max(0, fromTick - (event.t as number)) * TICK_MS,
    );
    if (typeof event['toX'] === 'number' && typeof event['toY'] === 'number'
      && (skill === 'cannonball' || skill === 'crimsonDash')) {
      actor.onHeroTravel(this.ux(event['toX']), this.uy(event['toY']), remainingMs);
    }
  }

  private apply(ev: Ev): void {
    if (this.jumping && !VERDICT_STATE_EVENTS.has(ev.e)) {
      if (ev.e === 'heroSkill') BattleScene.prototype.applyHeroSkillState.call(this, ev);
      return;
    }
    switch (ev.e) {
      case 'deploy': return this.onDeploy(ev);
      case 'spawn': return this.onSpawn(ev);
      case 'pos': return this.onPos(ev);
      case 'fire': return this.onFire(ev);
      case 'troopFire': return this.onTroopFire(ev);
      case 'troopAttack': return this.onTroopAttack(ev);
      case 'attackRun': return this.onAttackRun(ev);
      case 'troopAbility': return this.onTroopAbility(ev);
      case 'troopSpawn': return this.onTroopSpawn(ev);
      case 'burnfield': return this.onBurnfield(ev);
      case 'chain': return this.onChain(ev);
      case 'hit': return this.onHit(ev);
      case 'heal': return this.onHeal(ev);
      case 'troopDeath': return this.onTroopDeath(ev);
      case 'detonate': return this.onDetonate(ev);
      case 'burrow': return this.onBurrow(ev);
      case 'emerge': return this.onEmerge(ev);
      case 'destroyed': return this.onDestroyed(ev);
      case 'trap': return this.onTrap(ev);
      case 'rally': return this.onRally();
      case 'star': return this.onStar(ev);
      case 'heroAttack': return this.onHeroAttack(ev);
      case 'heroSkill': return this.onHeroSkill(ev);
      default: return;
    }
  }

  /** Rally horn (§3.11) — the React HUD still owns the visual banner. */
  private onRally(): void {
    haptic('medium');
  }

  /** Star stingers escalate 1★→3★ + banner-slam haptic (§3.10). */
  private onStar(ev: Ev): void {
    const n = (ev['n'] as 1 | 2 | 3) ?? 1;
    haptic(n >= 3 ? 'heavy' : n === 2 ? 'medium' : 'light');
  }

  private onDeploy(ev: Ev): void {
    const troop = ev['troop'] as TroopType;
    const id = ev['id'] as number;
    if (this.troops.has(id)) return;
    const decided = this.artDecidedTroops ??= new Set<string>();
    // Hexbarrow and its spawn-only Barrowling are one visual family. A late
    // load may never make the brood differ from the parent already deployed.
    freezeTroopArtFamily(decided, troop);
    const x = this.ux(ev['x']);
    const y = this.uy(ev['y']);
    // D4a: a hero drop is tagged on the deploy event — render THE HERO (hero
    // atlas art, larger scale), while the sim fights it as the donor troop.
    const hero = ev['hero'] as 'vex' | 'theodor' | undefined;
    const skin = hero === 'vex' ? 'hero_vex' as const : hero === 'theodor' ? 'hero_theo' as const : undefined;
    // A hero donor keeps hero art. Every other reworked troop gets either its
    // granted full controller or the eager exact-current static alias — no old
    // Dragon/Giant/Tur Rider family is reachable through this construction.
    const tx = Math.floor((ev['x'] as number) / 256);
    const ty = Math.floor((ev['y'] as number) / 256);
    const markIndex = this.marks.findIndex((mark) => mark.troop === troop
      && mark.hero === hero && mark.tx === tx && mark.ty === ty);
    const pending = markIndex >= 0 ? this.marks.splice(markIndex, 1)[0] : undefined;
    if (pending) this.refreshDeployStack(tx, ty);
    const fx = pending?.fx ?? (hero
      ? new HeroFx(this, this.anim, troop, hero, x, y, y)
      : new TroopFx(
        this, this.anim, troop, x, y, y, undefined, undefined,
        this.v2TroopDepsOf(troop, id), this.v2TroopFallbackOf(troop),
      ));
    fx.sprite.setPosition(x, y).setAlpha(1).setDepth(actorDepth(y));
    fx.setNearestBuildingFn(() => this.nearestBuildingX(fx.sprite.x, fx.sprite.y));
    if (this.meleeDrivenIds.has(id)) fx.setMeleeDriven();
    const defender = hero && ev['side'] === 'defender'
      ? this.defenderHeroes?.find((record) => record.hero === hero) : undefined;
    const loadout = defender?.loadout ?? (hero && ev['side'] !== 'defender' ? this.heroLoadouts?.[hero] : undefined);
    const maxHp = battleUnitMaxHp(
      troop,
      this.armyLevels[troop] ?? 1,
      hero,
      hero ? (ev['side'] === 'defender' ? (defender?.level ?? 1) : (this.heroLevels[hero] ?? 1)) : 1,
      { armyHpBps: this.armyHpBps ?? 0, ...(loadout ? { loadout } : {}), defender: ev['side'] === 'defender' },
    );
    this.troops.set(id, {
      fx, troop, hero: hero !== undefined, hp: maxHp, maxHp,
      bar: new HpBar(this, 'troop', overlayDepth(2660), 4),
    });
    // §3.10/§3.11: deploy pop on every drop; heroes announce with their own
    // stinger INSTEAD of the pop (owner 2026-07-28 — stacking both would
    // clash; the stinger is the hero's pop). Keg runner lights its fuse loop
    // (stopped on detonate or death).
    // D-099: a jumped span is silent and still — a burst of pops and buzzes
    // on return would announce a fight already over, and a fuse lit under the
    // verdict has no fight to score.
    if (!pending && !this.jumping) haptic('light');
    if (troop === 'kegrunner' && !this.jumping) {
      this.loops.set(id, playSfxFamily(
        'sfx_troop_kegrunner_fuse_loop',
        `${String(id)}:${String(ev.t)}:deploy:fuse`,
        'sfx_keg_fuse',
        { loop: true, volume: 0.6 },
      ));
    }
  }

  /** A Dragon Nest spawned a DEFENDER wyrmling — render it like a troop (it fights
   *  the raider's army; the sim owns its behavior). Its hp bar + hit/death events
   *  flow through the same troop-id maps as attackers. */
  private onSpawn(ev: Ev): void {
    const troop = ev['troop'] as TroopType;
    const id = ev['id'] as number;
    const x = this.ux(ev['x']);
    const y = this.uy(ev['y']);
    // The Dragon Nest is the one defence that never emits `fire`: it has no
    // direct-fire weapon, so the spawn IS its shot. `from` is the nest that
    // produced this wyrmling (sim.ts) — the cue for its firing art AND for the
    // wyrmling's art level below.
    const nestId = ev['from'] as string;
    (this.artDecidedDefenses ??= new Set<string>()).add(nestId);
    const nest = this.buildings.get(nestId);
    // STAT level stays 1 — the sim spawns troopCombat(_, 1) and the ATTACKER's
    // armyLevels must never leak into a defender's unit. The ART level is the
    // nest's own building level: the spawn event carries no level, but the
    // snapshot gave us the nest's. The eager WARE Hatchling fallback and any
    // admitted rich clip both resolve their authored tier from this level.
    const hatchlingLevel = nest?.level ?? 1;
    const fx = new TroopFx(
      this, this.anim, troop, x, y, y, undefined, hatchlingLevel,
      undefined, undefined, this.wareHatchlingDepsOf(hatchlingLevel),
    );
    fx.setNearestBuildingFn(() => this.nearestBuildingX(fx.sprite.x, fx.sprite.y));
    const maxHp = troopMaxHp(troop, 1);
    this.troops.set(id, {
      fx, troop, hero: false, hp: maxHp, maxHp,
      bar: new HpBar(this, 'troop', overlayDepth(2660), 4),
    });
    if (nest && !nest.destroyed && !this.jumping) {
      if (nest.ware) {
        nest.ware.setWorking(true);
        this.time.delayedCall(BATTLE_BODY_PRESENTATION.dragonNestWorkMs, () => {
          if (nest.sprite.active && !nest.destroyed) nest.ware?.setWorking(false);
        });
      } else if (!isWareBuildingUnit(nest.type)) {
        defenceFire(this, nest.sprite, nest.type, nest.key, this.meta);
      }
    }
  }

  /** Hexbarrow's attacker-side brood event carries every visual fact omitted
   * by direct deploys: inherited level, deterministic variant, and exact hatch
   * coordinate. Duplicate replay delivery is idempotent by actor id. */
  private onTroopSpawn(ev: Ev): void {
    if (ev['troop'] !== 'barrowling') return;
    const id = ev['id'] as number;
    if (this.troops.has(id)) return;
    const troop: TroopType = 'barrowling';
    freezeTroopArtFamily(this.artDecidedTroops ??= new Set<string>(), troop);
    const rawLevel = ev['level'];
    const rawVariant = ev['variant'];
    const level = typeof rawLevel === 'number' && Number.isFinite(rawLevel)
      ? Math.max(1, Math.trunc(rawLevel))
      : 1;
    const variant = typeof rawVariant === 'number' && Number.isFinite(rawVariant)
      ? Math.max(0, Math.trunc(rawVariant))
      : 0;
    const x = this.ux(ev['x']);
    const y = this.uy(ev['y']);
    const fx = new TroopFx(
      this, this.anim, troop, x, y, y, undefined, level,
      this.v2TroopDepsOf(troop, id, level, variant),
      this.v2TroopFallbackOf(troop, level),
    );
    fx.setNearestBuildingFn(() => this.nearestBuildingX(fx.sprite.x, fx.sprite.y));
    const maxHp = troopMaxHp(troop, level);
    this.troops.set(id, {
      fx, troop, hero: false, hp: maxHp, maxHp,
      bar: new HpBar(this, 'troop', overlayDepth(2660), 4),
    });
  }

  private onTroopAbility(ev: Ev): void {
    const troop = this.troops.get(ev['id'] as number);
    if (!troop?.fx.v2) return;
    let ix = typeof ev['ix'] === 'number' ? this.ux(ev['ix']) : undefined;
    let iy = typeof ev['iy'] === 'number' ? this.uy(ev['iy']) : undefined;
    // Firestorm's sim point remains the burnfield coordinate in the event log.
    // The body fan instead aims at the named sprite's visible centre so tall
    // towers and wall segments are struck on-art rather than below their feet.
    if (ev['ability'] === 'firestorm' && typeof ev['targetBuildingId'] === 'string') {
      const target = this.buildings.get(ev['targetBuildingId']);
      if (target && !target.destroyed && target.sprite.visible) {
        const bounds = target.sprite.getBounds();
        ix = bounds.centerX;
        iy = bounds.centerY;
      }
    }
    troop.fx.v2.onAbility(
      ev['ability'] as 'howl' | 'leap' | 'lunge' | 'firestorm' | 'maul' | 'disgorge',
      this.ux(ev['x']),
      this.uy(ev['y']),
      ix,
      iy,
    );
  }

  private onBurnfield(ev: Ev, resumeTick = ev.t as number): void {
    const id = ev['id'] as number;
    const castTick = ev.t as number;
    const until = ev['until'] as number;
    if (!Number.isInteger(until) || until <= resumeTick) return;

    // A new cast replaces this owner's earlier patches. Same-tick events are
    // the authored fan of cells and coexist; repeated keys are exact-once.
    const previousCast = this.burnfieldCastTicks.get(id);
    if (previousCast !== undefined && previousCast !== castTick) {
      for (const [key, fx] of this.burnfields) {
        if (!key.startsWith(`${id}:`)) continue;
        fx.destroy();
        this.burnfields.delete(key);
      }
    }
    this.burnfieldCastTicks.set(id, castTick);
    for (const [key, fx] of this.burnfields) {
      if (fx.active) continue;
      this.burnfields.delete(key);
    }
    const key = `${id}:${castTick}:${ev['x'] as number}:${ev['y'] as number}`;
    if (this.burnfields.has(key)) return;

    const tier = artTierOfLevel(this.armyLevels.direwyvern ?? 1);
    const direShard = isV2AtlasLoaded(this, v2DirewyvernFxAtlasGroup(tier));
    if (!direShard && !isV2AtlasLoaded(this, V2FX_ATLAS)) return;
    const fx = new BurnfieldFx(
      this,
      this.v2meta.clips,
      tier,
      this.ux(ev['x']),
      this.uy(ev['y']),
      (until - resumeTick) * TICK_MS,
      direShard,
    );
    if (fx.active) this.burnfields.set(key, fx);
  }

  /** Stop a troop's looping SFX (keg fuse / burrow), if any. */
  private stopLoop(id: number): void {
    this.loops.get(id)?.stop();
    this.loops.delete(id);
  }

  private warmDragonDeploymentSfx(hasDragon: boolean): void {
    const generation = ++this.dragonDeploymentSfxGeneration;
    this.dragonDeploymentSfxBank?.release();
    this.dragonDeploymentSfxBank = null;
    if (!hasDragon) return;
    void loadProductionSfxManifest().then((loaded) => {
      if (!loaded || generation !== this.dragonDeploymentSfxGeneration
        || !this.scene.isActive()) return;
      const bank = acquireSfxBank(DRAGON_BATTLE_WARM_SFX);
      if (generation !== this.dragonDeploymentSfxGeneration || !this.scene.isActive()) {
        bank.release();
        return;
      }
      this.dragonDeploymentSfxBank = bank;
      void bank.ready;
    });
  }

  /** Optional generation makes a stale playback waiter harmless after this
   * reusable scene has already entered a different raid. */
  private releaseDragonDeploymentSfxBank(generation?: number): void {
    if (generation !== undefined && generation !== this.dragonDeploymentSfxGeneration) return;
    this.dragonDeploymentSfxGeneration++;
    this.dragonDeploymentSfxBank?.release();
    this.dragonDeploymentSfxBank = null;
  }

  private releaseProductionSfxBanks(): void {
    this.productionSfxBanks.forEach((bank) => sceneCleanup('production-sfx-bank', () => bank.release()));
    this.productionSfxBanks.clear();
  }

  private clearBurnfields(): void {
    this.burnfields.forEach((fx) => sceneCleanup('burnfield', () => fx.destroy()));
    this.burnfields.clear();
    this.burnfieldCastTicks.clear();
  }

  private ownTransientFx<T extends Phaser.GameObjects.GameObject>(object: T): T {
    this.transientFx ??= new Set();
    this.transientFx.add(object);
    object.once('destroy', () => this.transientFx?.delete(object));
    return object;
  }

  private destroyTransientFx(object: Phaser.GameObjects.GameObject): void {
    this.transientFx?.delete(object);
    if (object.active) object.destroy();
  }

  private clearTransientFx(): void {
    if (!this.transientFx) return;
    for (const object of this.transientFx) {
      if (object.active) sceneCleanup('transient-effect', () => object.destroy());
    }
    this.transientFx.clear();
  }

  private onPos(ev: Ev, durationMs = 0): void {
    const r = this.troops.get(ev['id'] as number);
    // A D-099 jump lands every keyframe in one call stack: a tween would glide
    // after the verdict, so the move snaps (Phaser clamps 0 to a 0.01 ms tween).
    if (!r) return;
    const x = this.ux(ev['x']);
    const y = this.uy(ev['y']);
    if (this.jumping) r.fx.snapPosition(x, y);
    else r.fx.onPos(x, y, durationMs);
  }

  /**
   * A ranged troop loosing a shot (owner 2026-07-26: bowmen fired with nothing
   * rendered; SIM8 adds defender Wyrmling breath). The sim's `troopFire` carries
   * no projectile
   * kind — which sprite flies is presentation, and the client already knows the
   * troop's type from its `deploy` event, exactly as onFire picks the richer
   * visual by defense type.
   */
  /** D4b: skill casts are pure rendering cues — the sim already applied every
   *  effect. Frame-swept one-shots on the fx atlas, explode()-style. */
  private onHeroSkill(ev: Ev): void {
    BattleScene.prototype.applyHeroSkillState.call(this, ev);
    if (this.jumping) return;
    const skill = ev['skill'] as string;
    const phase = typeof ev['phase'] === 'string' ? ev['phase'] : 'impact';
    const x = this.ux(ev['x']);
    const y = this.uy(ev['y']);
    const actor = this.troops.get(ev['id'] as number)?.fx;
    const lockTicks = Math.max(1, heroSkillBodyUntilTick(ev) - (ev.t as number));
    actor?.onHeroSkill(skill, phase, lockTicks * TICK_MS);
    if (actor && typeof ev['toX'] === 'number' && typeof ev['toY'] === 'number'
      && (skill === 'cannonball' || skill === 'crimsonDash')) {
      actor.onHeroTravel(this.ux(ev['toX']), this.uy(ev['toY']), lockTicks * TICK_MS);
    }
    const sweep = (
      base: string, frames: number, stepMs = 90, scale = 2,
      atX = x, atY = y, lifetimeMs = stepMs * frames + 200,
    ): Phaser.GameObjects.Image => {
      const s = BattleScene.prototype.ownTransientFx.call(
        this,
        this.add.image(atX, atY, 'fx', `${base}_f1`)
          .setDepth(overlayDepth(2684)).setScale(scale),
      ) as Phaser.GameObjects.Image;
      for (let f = 2; f <= frames; f++) {
        this.time.delayedCall(stepMs * (f - 1), () => s.active && s.setTexture('fx', `${base}_f${f}`));
      }
      this.time.delayedCall(lifetimeMs, () => {
        BattleScene.prototype.destroyTransientFx.call(this, s);
      });
      return s;
    };
    const travelSweep = (
      base: string, frames: number,
      fromX: number, fromY: number, toX: number, toY: number,
      durationMs: number, stepMs = 90, scale = 2,
    ): void => {
      const lifetimeMs = Math.max(durationMs, stepMs * frames) + 200;
      const s = sweep(base, frames, stepMs, scale, fromX, fromY, lifetimeMs);
      this.tweens.add({
        targets: s, x: toX, y: toY,
        duration: Math.max(1, durationMs), ease: 'Linear',
      });
    };
    const projectToRange = (
      fromX: number, fromY: number, towardX: number, towardY: number, rangePx: number,
    ): [number, number] => {
      const dx = towardX - fromX;
      const dy = towardY - fromY;
      const length = Math.hypot(dx, dy);
      return length > 0
        ? [fromX + (dx * rangePx) / length, fromY + (dy * rangePx) / length]
        : [towardX, towardY];
    };
    if (skill === 'crimsonDash') {
      const fromX = typeof ev['fromX'] === 'number' ? this.ux(ev['fromX']) : x;
      const fromY = typeof ev['fromY'] === 'number' ? this.uy(ev['fromY']) : y;
      const toX = typeof ev['toX'] === 'number' ? this.ux(ev['toX']) : x;
      const toY = typeof ev['toY'] === 'number' ? this.uy(ev['toY']) : y;
      travelSweep(
        'fx_vex_dashtrail', 3, fromX, fromY, toX, toY, lockTicks * TICK_MS, 80,
      );
    } else if (skill === 'moonsunderWave') {
      const towardX = typeof ev['toX'] === 'number' ? this.ux(ev['toX']) : x;
      const towardY = typeof ev['toY'] === 'number' ? this.uy(ev['toY']) : y;
      const [toX, toY] = projectToRange(
        x, y, towardX, towardY, HERO_SKILLS.vex.moonsunderWave.rangeTiles * T,
      );
      travelSweep(
        'fx_vex_crescent', 3, x, y, toX, toY, lockTicks * TICK_MS, 90,
      );
      // The event identifies only its primary target. Render BLEED when that
      // target is a troop; buildings must never receive a false bleed marker.
      const targetId = ev['target'];
      const victim = typeof targetId === 'number' ? this.troops.get(targetId)?.fx.sprite : undefined;
      if (victim?.active) {
        const center = victim.getCenter();
        sweep('fx_vex_bleed', 2, 120, 2, center.x, center.y);
      }
    } else if (skill === 'omegaShardstorm') {
      sweep('fx_vex_shardnova', 4, 90, 2.5);
      const radius = HERO_SKILLS.vex.moonsunderWave.rangeTiles * T;
      const diagonal = radius / Math.SQRT2;
      const spokes: ReadonlyArray<readonly [number, number]> = [
        [0, -radius], [diagonal, -diagonal], [radius, 0], [diagonal, diagonal],
        [0, radius], [-diagonal, diagonal], [-radius, 0], [-diagonal, -diagonal],
      ];
      const count = HERO_SKILLS.vex.omegaShardstorm.crescents.at(-1) ?? 0;
      for (const [dx, dy] of spokes.slice(0, count)) {
        travelSweep(
          'fx_vex_crescent', 3, x, y, x + dx, y + dy, lockTicks * TICK_MS, 90, 1.7,
        );
      }
    } else if (skill.startsWith('doubleOrNothing')) {
      sweep('fx_vex_coinflip', 4, 100, 1.7);
    } else if (skill === 'cheekQuake') {
      sweep('fx_theo_quake', 5, 100, 2.4);
      shake(this, 150, 0.004); // the spec's slam shake, same budget as mortars
      haptic('medium');
    } else if (skill === 'snotRocket') {
      if (actor?.sprite.active) {
        travelSweep(
          'fx_theo_snot', 4, actor.sprite.x, actor.sprite.y,
          x, y, lockTicks * TICK_MS, 90, 1.7,
        );
      } else {
        sweep('fx_theo_snot', 4, 90, 1.7);
      }
    } else if (skill === 'cannonball') {
      sweep('fx_theo_dust', 3, 90, 2);
    } else if (skill === 'bellyBounce') {
      sweep('fx_theo_bellyring', 3, 90, 2);
    } else if (skill === 'brownNote') {
      if (actor?.sprite.active) {
        travelSweep(
          'fx_theo_gasburst', 4, actor.sprite.x, actor.sprite.y,
          x, y, lockTicks * TICK_MS, 100, 2,
        );
      } else {
        sweep('fx_theo_gasburst', 4, 100, 2);
      }
    } else if (skill === 'rageQuit' && phase === 'fakeDeath') {
      sweep('fx_theo_zzz', 3, 180, 1.5);
    } else if (skill === 'silentButDeadly' && phase === 'impact') {
      sweep('fx_theo_stink', 6, 100, 2.5);
      sweep('fx_theo_stinklinger', 4, 100, 2);
    }
  }

  /** Mirror the two deterministic on-lethal HP resets already encoded by the
   * persisted heroSkill cue. This is presentation state only: server/sim
   * outcomes remain authoritative, and SIM12 logs use the same cue names. */
  private applyHeroSkillState(ev: Ev): void {
    const troop = this.troops.get(ev['id'] as number);
    if (!troop) return;
    const skill = ev['skill'];
    const pct = skill === 'rageQuit' && ev['phase'] === 'fakeDeath'
      ? HERO_SKILLS.theodor.rageQuit.fakeDeathHpPct
      : skill === 'doubleOrNothingHeads'
        ? HERO_SKILLS.vex.doubleOrNothing.reviveHpPct.at(-1)!
        : undefined;
    if (pct === undefined) return;
    troop.hp = Math.floor((troop.maxHp * pct) / 100);
  }

  private onHeroAttack(ev: Ev): void {
    const actor = this.troops.get(ev['id'] as number)?.fx;
    const until = typeof ev['recoveryUntil'] === 'number' ? ev['recoveryUntil'] as number : ev.t as number;
    actor?.onHeroAttack(
      this.ux(ev['ix']), this.uy(ev['iy']),
      Math.max(1, (until - (ev.t as number)) * TICK_MS),
    );
  }

  /** Resolver that can name only this actor's admitted compact-current FX.
   * Returning null is deliberate: missing current art suppresses a cosmetic
   * shot instead of ever selecting the historical projectile atlas. */
  private fallbackProjectileArt(troop: string): V2ProjectileArt {
    const expected = artTierOfLevel(this.armyLevels[troop] ?? 1);
    const admitted = this.v2TroopFallbackFxTiers.get(troop);
    return {
      baseFor: (metaBase) => admitted === expected
        ? v2TroopFallbackFxBaseKey(troop, expected, metaBase)
        : null,
    };
  }

  private playFallbackDragonBreath(
    troop: TroopRec,
    fromY: number,
    ix: number,
    iy: number,
  ): void {
    const tier = artTierOfLevel(this.armyLevels.dragon ?? 1);
    const art = this.fallbackProjectileArt('dragon');
    const breathMeta = `v2_fx_breath_t${tier}`;
    const breathBase = art.baseFor(breathMeta);
    if (!breathBase) return;
    playV2Fx(this, this.v2meta.clips, breathBase, troop.fx.sprite.x, fromY, {
      metaBase: breathMeta,
      rotationDeg: (Math.atan2(iy - fromY, ix - troop.fx.sprite.x) * 180) / Math.PI,
      depth: troop.fx.sprite.depth + 1,
    });
    const impactMeta = `v2_fx_impact_burn_t${tier}`;
    const impactBase = art.baseFor(impactMeta);
    if (impactBase) {
      playV2Fx(this, this.v2meta.clips, impactBase, ix, iy, { metaBase: impactMeta });
    }
  }

  private onTroopFire(ev: Ev): void {
    const t = this.troops.get(ev['id'] as number);
    if (!t) return;
    const ix = this.ux(ev['ix']);
    const iy = this.uy(ev['iy']);
    // Loose from the troop's chest, not its feet, so the arc reads correctly.
    const fromY = t.fx.sprite.y - t.fx.sprite.displayHeight * 0.5;
    // Rework-v2 giant: `proj:'boulder'` is the sim's one tagged troopFire
    // (siege throw vs defenses, owner 2026-08-08). The v2 unit plays its
    // throw clip and lobs the tumbling boulder itself. A rejected rich body
    // uses the tiny current boulder alias; hero donors retain hero-era art.
    if (ev['proj'] === 'boulder' && t.troop === 'giant') {
      if (t.fx.v2) t.fx.v2.onSiegeThrow(ix, iy);
      else if (!t.hero) {
        launchV2Projectile(
          this, this.v2meta.clips, 'boulder',
          artTierOfLevel(this.armyLevels.giant ?? 1),
          t.fx.sprite.x, fromY, ix, iy, undefined,
          this.fallbackProjectileArt('giant'),
          t.fx.artFit,
        );
      } else {
        launchProjectile(this, 'cannonball', t.fx.sprite.x, fromY, ix, iy);
      }
      return;
    }
    // Rich Dragon uses its assembled stream/current one-piece point-blank cue.
    if (t.troop === 'dragon' && t.fx.v2) {
      // No burnScorch here: the stream fires its own impact_burn once at
      // onset — the tip IS the contact effect (meta.breathStream seam rule).
      t.fx.v2.onBreath(ix, iy);
      return;
    }
    if (t.troop === 'dragon' && !t.hero) {
      this.playFallbackDragonBreath(t, fromY, ix, iy);
      return;
    }
    if (t.troop === 'wyrmling') {
      // SIM names the victim; the M22 adapter turns toward it, releases from the
      // authored per-frame maw and uses only direction-baked hatchfire/hit art.
      // Missing optional warefx fails closed—there is no legacy cone fallback.
      t.fx.onRangedAttack(ix, iy, (at) => {
        launchWareHatchlingShot(this, this.waremeta.clips, at.x, at.y, ix, iy);
      });
      return;
    }
    if (t.troop === 'dragon') {
      // Only a hero/donor edge can reach this ordinary Dragon branch; the
      // current attacker Dragon routes above through rich/current art.
      breathCone(this, 'dragon', t.fx.sprite.x, fromY, ix, iy);
      burnScorch(this, ix, iy);
      return;
    }
    // Reworked Bowman/Mage/Hexbarrow: the controller plays the authored
    // release sequence, then fires from the published attachment on fxAt. The
    // scene still owns flight because troopFire is the sim's render cue. A
    // missing v2 travel clip fails closed; current bodies never mix with old FX.
    const rangedProjectile = t.fx.v2?.rangedProjectile;
    if (t.fx.v2 && rangedProjectile) {
      const tier = artTierOfLevel(this.armyLevels[t.troop] ?? 1);
      const art = this.v2TroopTiers.has(t.troop)
        ? undefined : this.fallbackProjectileArt(t.troop);
      t.fx.onRangedAttack(ix, iy, (from) => {
        launchV2Projectile(
          this, this.v2meta.clips, rangedProjectile, tier,
          from.x, from.y, ix, iy, undefined, art,
          // The shot is the size of the shooter (owner 2026-08-30). `from` is
          // already the published attachment placed at this same fit, so the
          // arrow both leaves the hand and is arrow-sized.
          t.fx.artFit,
        );
      });
      return;
    }
    if (!t.hero && (t.troop === 'bowman' || t.troop === 'mage' || t.troop === 'hexbarrow')) {
      const kind = t.troop === 'bowman' ? 'arrow' : t.troop === 'mage' ? 'bolt' : 'hexshot';
      launchV2Projectile(
        this, this.v2meta.clips, kind,
        artTierOfLevel(this.armyLevels[t.troop] ?? 1),
        t.fx.sprite.x, fromY, ix, iy, undefined,
        this.fallbackProjectileArt(t.troop),
        t.fx.artFit,
      );
      return;
    }
    // True legacy/hero ranged art only.
    const kind = t.troop === 'mage' || t.troop === 'hexbarrow' ? 'orb' : 'arrow';
    launchProjectile(this, kind, t.fx.sprite.x, fromY, ix, iy);
  }

  /** Target-aware non-hero attack cue. SIM5 Troll logs omit discriminants;
   * SIM7 events drive every rich-or-compact melee body without inventing damage. */
  private onTroopAttack(ev: Ev): void {
    const troop = this.troops.get(ev['id'] as number);
    if (!troop || troop.hero) return;
    const technique = ev['technique'] as 'strike' | 'slam' | 'rend' | undefined;
    if (!technique && troop.troop !== 'troll') return;
    troop.fx.onMeleeAttack(
      (ev['targetKind'] as 'troop' | 'building' | undefined)
        ?? (typeof ev['target'] === 'number' ? 'troop' : 'building'),
      this.ux(ev['ix']),
      this.uy(ev['iy']),
      technique ?? 'slam',
    );
  }

  /** SIM9 compact authored cycles. Each cycle begins only after the previous
   * authored cadence; the controller owns its release/contact frame and is
   * allowed to finish. Damage remains represented by authoritative hit events. */
  private onAttackRun(ev: Ev): void {
    let starts: number[];
    try { starts = attackRunCycleStarts(ev as unknown as AttackRunEvent); } catch { return; }
    const technique = String(ev['technique'] ?? 'strike');
    const generation = this.playGeneration;
    let next = 0;
    const invoke = (i: number): void => {
      if (this.playGeneration !== generation) return;
      const troop = this.troops.get(ev['id'] as number);
      if (!troop || troop.hero || !troop.fx.alive) return;
      const cue: Ev = { ...ev, t: starts[i]! };
      if (technique === 'firestorm' || technique === 'maul') {
        // These bodies and their follow-on burnfields are already driven by
        // troopAbility/burnfield. The run is the compact timing/accounting
        // record and must not double-start either authored ability.
        return;
      }
      if (technique === 'arrow' || technique === 'boulder' || technique === 'bolt'
        || technique === 'breath' || technique === 'hexshot') {
        if (technique === 'boulder') cue['proj'] = 'boulder';
        this.onTroopFire(cue);
        return;
      }
      if (technique === 'detonate') return;
      this.onTroopAttack({
        ...cue,
        technique: technique === 'rend' ? 'rend' : technique === 'slam' ? 'slam' : 'strike',
      });
    };
    const advance = (elapsedMs: number): void => {
      while (next < starts.length
        && elapsedMs >= (starts[next]! - starts[0]!) * TICK_MS) invoke(next++);
    };
    if (starts.length === 1) advance(0);
    else combatEffectPool(this).add(
      (starts.at(-1)! - starts[0]!) * TICK_MS + 1,
      (elapsedMs) => advance(elapsedMs),
    );
  }

  private onFire(ev: Ev): void {
    const id = ev['id'] as string;
    (this.artDecidedDefenses ??= new Set<string>()).add(id);
    const b = this.buildings.get(id);
    if (!b || b.destroyed) return;
    const proj = ev['proj'] as 'cannonball' | 'arrow' | 'shell' | 'beam';
    const ix = this.ux(ev['ix']);
    const iy = this.uy(ev['iy']);
    if (b.ware) {
      const nearKeep = b.type === 'keep'
        && Math.hypot(ix - b.sprite.x, iy - b.sprite.y)
          <= DEFENSES.mortar.rangeMinTiles * T;
      b.ware.fire(ix, iy, proj, nearKeep);
      return;
    }
    // Every M22 defence's eager body is already exact current art. If its rich
    // atomic group was denied or failed, omit the optional shot cue rather than
    // briefly resurrect a batch-13 fire frame/projectile over the new tower.
    if (isWareBuildingUnit(b.type)
      && (b.type === 'keep'
        || ['archertower', 'electrictower', 'magetower', 'lasertower', 'airdefence']
          .includes(b.type))) return;
    const visual = defenseShotVisual(b.type, proj, b.v2 !== undefined);
    // Rework-v2 cannon/mortar: the controller owns the whole shot — aim rows
    // toward the target, fire clip with the emitter-anchored muzzle FX and
    // heading-row projectile, reload, back to idle. Firing SFX stay the §3.11
    // pairs the legacy path plays.
    if (visual === 'v2') {
      if (!b.v2) return; // impossible unless the building record changed mid-event
      b.v2.fire(ix, iy);
      return;
    }
    if (visual === 'none') {
      return;
    }
    // Per-type now: batch 13 grew the tall towers to 4.3 tiles with a floating
    // level crown, so one flat fraction of displayHeight no longer finds the
    // weapon on all of them (fx/muzzle.ts carries the measurements).
    const my = muzzleY(b.sprite, b.type);
    // The seven reworked defences animate the shot themselves — base frame →
    // their authored `_fire_*` clip → back (clip length read from the packed
    // meta: electric has 4 frames, the rest 2). A no-op for every other
    // building.
    defenceFire(this, b.sprite, b.type, b.key, this.meta);

    // Laser tower: the authored stretchable beam segment, muzzle → target
    // (instant).
    if (visual === 'beam') {
      laserBeam(this, b.sprite.x, my, ix, iy);
      return;
    }

    // The CLIENT picks the richer visual by defense TYPE (the sim keeps proj
    // 'arrow' for the epic towers so golden replays stay byte-stable).
    if (visual === 'zap') {
      // v2: the discharge is BAKED into bld_electrictower_*_fire_f1..4, so no
      // muzzle overlay (the legacy fx_fire_electric flash would double-draw
      // over the authored bolt) and no flip (the Tesla mast is symmetric).
      // The travelling shot is the stretchable fx_zap segment — see zapBolt
      // for why it replaced the fx_bolt_electric sprite — plus its authored
      // hit at the primary target; chain hops render in onChain.
      zapBolt(this, b.sprite.x, my, ix, iy);
      zapHit(this, ix, iy);
      return;
    }
    if (visual === 'orb') {
      muzzleFlash(this, b.sprite, 'magetower', ix);
      // v2 art: the mage bolt is the fx_orb pair; its 3-frame authored hit
      // plays on arrival inside launchProjectile, which supersedes the old
      // mageBurst scale-fade (per-target damage numbers still arrive as
      // ordinary sim hit events).
      launchProjectile(this, 'orb', b.sprite.x, my, ix, iy);
      return;
    }

    // Classic defenses: muzzle flash + flip toward the target (the engine recoil
    // now stands down for the two whose batch-13 art kicks itself — muzzle.ts).
    if (b.type === 'cannon' || b.type === 'archertower' || b.type === 'mortar') {
      muzzleFlash(this, b.sprite, b.type, ix);
    }
    // Launch the projectile from the muzzle toward the impact point.
    launchProjectile(this, visual, b.sprite.x, my, ix, iy);
  }

  /** Electric-tower chain lightning: a forked bolt from the tower through each
   *  chained troop, applying each hop's damage (HP bar + floating number). The
   *  sim reports secondary hops ONLY via this event's parallel `dmg[]` array —
   *  there are no per-hop `hit` events — so without this the chained troops'
   *  bars never drop and no numbers show. */
  private onChain(ev: Ev): void {
    const b = this.buildings.get(ev['id'] as string);
    if (!b) return;
    const targets = ev['targets'] as number[];
    const dmg = (ev['dmg'] as number[]) ?? [];
    // v2: every hop is the same stretchable fx_zap segment the primary
    // discharge fires (zapBolt) — one visual language for the electric
    // tower's lightning, instead of the old hand-drawn Graphics fork.
    // Origin: the crown, the same muzzle point the discharge leaves from —
    // the electric tower IS a batch-13 defence since v2 and 18 of its 20
    // heights changed, so the old half-height guess no longer found the coil.
    let fx = b.sprite.x, fy = b.ware
      ? b.sprite.y - b.sprite.displayHeight * 0.55
      : muzzleY(b.sprite, b.type);
    targets.forEach((tid, i) => {
      const tr = this.troops.get(tid);
      if (!tr) return;
      const s = tr.fx.sprite;
      const d = dmg[i] ?? 0;
      if (this.jumping) {
        if (d > 0 && tr.fx.alive) {
          tr.hp = Math.max(0, tr.hp - d);
          tr.fx.v2?.syncHealth(tr.maxHp > 0 ? tr.hp / tr.maxHp : 0);
        }
        return;
      }
      const tx = s.x, ty = s.y - 10;
      if (b.ware) {
        const arc = BattleScene.prototype.ownTransientFx.call(
          this, this.add.graphics().setDepth(overlayDepth(2680)),
        ) as Phaser.GameObjects.Graphics;
        arc.lineStyle(2, 0xcdfbff, 0.95).lineBetween(fx, fy, tx, ty);
        this.tweens.add({
          targets: arc, alpha: 0, duration: 100,
          onComplete: () => BattleScene.prototype.destroyTransientFx.call(this, arc),
        });
        playWareFx(this, this.waremeta.clips, 'ware_fx_teslahit', tx, ty);
      } else {
        zapBolt(this, fx, fy, tx, ty);
      }
      fx = tx; fy = ty;
      // Apply this hop's damage: deplete the HP bar + pop the number (fix 5).
      if (d > 0 && tr.fx.alive) {
        tr.hp = Math.max(0, tr.hp - d);
        tr.fx.v2?.syncHealth(tr.maxHp > 0 ? tr.hp / tr.maxHp : 0);
        this.hitStar(s.x, s.y - s.displayHeight * 0.6, s);
        floatText(this, s.x, s.y - s.displayHeight * 0.6, d);
      }
    });
  }

  private onHit(ev: Ev): void {
    const target = ev['target'];
    const dmg = (ev['dmg'] as number) ?? 0;
    if (typeof target === 'number') {
      const r = this.troops.get(target);
      if (!r || !r.fx.alive) return;
      r.hp = Math.max(0, r.hp - dmg);
      if (this.jumping) {
        r.fx.v2?.syncHealth(r.maxHp > 0 ? r.hp / r.maxHp : 0);
        return;
      }
      const s = r.fx.sprite;
      this.hitStar(s.x, s.y - s.displayHeight * 0.6, s);
      floatText(this, s.x, s.y - s.displayHeight * 0.6, dmg);
      // Hexbarrow's persistent damaged loop is selected from this same
      // authoritative HP mirror; ordinary reworked troops keep their flinch.
      if (r.fx.v2) r.fx.v2.onHit(r.maxHp > 0 ? r.hp / r.maxHp : 0);
      else r.fx.onHit();
    } else {
      const b = this.buildings.get(target as string);
      if (!b || b.destroyed) return;
      b.hp = Math.max(0, b.hp - dmg);
      const frac = b.maxHp > 0 ? b.hp / b.maxHp : 0;
      if (this.jumping) {
        const ownsM22Damage = b.type === 'wall' || isWareBuildingUnit(b.type) || this.ownsMarketArt(b) || b.type === 'berth';
        if (b.maxHp > 0 && !ownsM22Damage) b.damage.update(frac);
        if (b.maxHp > 0) b.v2?.setDamaged(frac < 0.5);
        if (b.maxHp > 0 && frac < 0.5) {
          if (b.type === 'wall') this.retileSurvivingWalls();
          else if (b.ware) b.ware.setDamaged(true);
          else if (isWareBuildingUnit(b.type)) this.applyWareFallbackState(b, 'damaged');
          else if (b.market) b.market.setDamaged(true);
          else if (this.ownsMarketArt(b)) this.applyMarketFallbackState(target as string, b, 'damaged');
          else if (b.berth) b.berth.setDamaged(true);
          else if (b.type === 'berth') this.applyBerthFallbackState(target as string, b, 'damaged');
        }
        this.emitProgress();
        return;
      }
      const cx = (b.tx + b.fw / 2) * T;
      const cy = (b.ty + b.fh) * T;
      const lift = Math.min(b.sprite.displayHeight * 0.5, HIT_LIFT_MAX_PX);
      this.hitStar(cx, cy - lift, b.sprite);
      floatText(this, cx, cy - lift, dmg);
      const ownsM22Damage = b.type === 'wall' || isWareBuildingUnit(b.type) || this.ownsMarketArt(b) || b.type === 'berth';
      if (b.maxHp > 0 && !ownsM22Damage) b.damage.update(frac);
      // Rework-v2: below half the resting loop becomes the authored damaged
      // 2f state (masonry knocked off) — the HP mirror is the sim's, so this
      // flips exactly when the sim's building crosses 50%.
      if (b.maxHp > 0) b.v2?.setDamaged(frac < 0.5);
      if (b.maxHp > 0 && frac < 0.5) {
        if (b.type === 'wall') this.retileSurvivingWalls();
        else if (b.ware) {
          b.ware.setDamaged(true);
        } else if (isWareBuildingUnit(b.type)) {
          this.applyWareFallbackState(b, 'damaged');
        } else if (b.market) {
          // Same HP mirror as the M22 bodies: the Market's authored damaged cell.
          b.market.setDamaged(true);
        } else if (this.ownsMarketArt(b)) {
          this.applyMarketFallbackState(target as string, b, 'damaged');
        } else if (b.berth) {
          // D-b: the berth body shows its damaged still; the vehicle stays docked.
          b.berth.setDamaged(true);
        } else if (b.type === 'berth') {
          this.applyBerthFallbackState(target as string, b, 'damaged');
        }
      }
      this.emitProgress();
    }
  }

  /** Existing lifesteal replay event: keep the client HP mirror and visible
   * feedback in step with the sim. This handler is intentionally retained as
   * replay compatibility — saved raids play their persisted event arrays. */
  private onHeal(ev: Ev): void {
    const r = this.troops.get(ev['id'] as number);
    const amount = Math.max(0, (ev['amount'] as number) ?? 0);
    if (!r || !r.fx.alive || amount <= 0) return;
    r.hp = Math.min(r.maxHp, r.hp + amount);
    if (this.jumping) return;
    const s = r.fx.sprite;
    floatText(this, s.x, s.y - s.displayHeight * 0.6, amount, { prefix: '+' });
  }

  private hitStar(x: number, y: number, victim: Phaser.GameObjects.Sprite): void {
    const star = BattleScene.prototype.ownTransientFx.call(
      this, this.add.image(x, y, 'fx', 'fx_hit_f1').setDepth(overlayDepth(2690)),
    ) as Phaser.GameObjects.Image;
    this.time.delayedCall(120, () => star.active && star.setTexture('fx', 'fx_hit_f2'));
    this.time.delayedCall(260, () => {
      BattleScene.prototype.destroyTransientFx.call(this, star);
    });
    flash(this, victim); // 1-frame white flash on the victim (GDD §3.10)
  }

  private onTroopDeath(ev: Ev): void {
    const id = ev['id'] as number;
    const r = this.troops.get(id);
    if (!r) return;
    this.stopLoop(id); // a downed keg/tunneler kills its fuse/burrow loop
    if (this.jumping) r.fx.destroy();
    else {
      r.fx.onDeath();
      this.retiredTroops.add(r.fx);
      this.retiredTroopIds ??= new Map();
      this.retiredTroopIds.set(id, r.fx);
      r.fx.sprite.once('destroy', () => {
        this.retiredTroops.delete(r.fx);
        if (this.retiredTroopIds.get(id) === r.fx) this.retiredTroopIds.delete(id);
      });
    }
    r.bar.destroy();
    this.troops.delete(id);
  }

  /** Swap to a one-frame eager state copied from M22. These aliases live in
   * `warefallback` at @1x and resolve through the same fitted world seat as the
   * eager @2x body and rich controller. */
  private applyWareFallbackState(
    b: BuildingRec,
    state: 'damaged' | 'collapse',
  ): void {
    let key: string | null = null;
    if (isWareBuildingUnit(b.type)) {
      key = wareBuildingStateAliasKey(b.type, b.level, state);
    }
    if (!key || !this.meta[key]) return;
    this.anim.unregister(b.sprite);
    this.v2Ticker.unregister(b.sprite);
    b.sprite.setTexture(atlasFor(key), key);
    this.positionBuildingSprite(b.sprite, b, key);
    b.sprite.clearTint();
    // A seek lands on the same rest cell the live collapse ends on
    // (ware/ruin.ts): seat from the alias, then swap the ruin in over it.
    const ruin = state === 'collapse' ? wareRuinTexture(this, b.type) : null;
    if (ruin) b.sprite.setTexture(ruin);
  }

  /** Ownership of the generic M22 damage/collapse visuals (P5 review S1): the
   * Market seam owns a body only while that body is keyed by its family art —
   * adopted (`artMode`) or still the pending frameless cell. A legacy or refused
   * table keys a Market/Workshop/Lodge by the ordinary `bld_` sheet, and the
   * generic overlays keep it exactly as they did before the seam existed. */
  private ownsMarketArt(b: BuildingRec): boolean {
    return b.artMode === 'market' || b.key === HARVESTER_UNPRESENTED_KEY || (marketArtFamilyOf(b.type) !== null && MARKET_FRAME_KEY.test(b.key));
  }

  /** Static Market cell for a seek/resume or a body without a controller:
   * the selected family's damaged or rubble frame, only once that family is
   * resident (a pending Market simply stays hidden). */
  private applyMarketFallbackState(id: string, b: BuildingRec, state: 'damaged' | 'destroyed'): void {
    const still = marketStaticFrame(this.marketArt, this.marketChoiceFor({ id, level: b.level, type: b.type }), state);
    if (!still || !isV2AtlasLoaded(this, still.atlas)) return;
    this.anim.unregister(b.sprite);
    this.v2Ticker.unregister(b.sprite);
    b.sprite.setTexture(still.atlas, still.frame);
    this.positionBuildingSprite(b.sprite, b, still.frame);
    b.sprite.clearTint().setVisible(true);
  }

  private applyWareTrapSpentFallback(b: BuildingRec, unit: WareTrapUnit): void {
    const key = wareTrapStateAliasKey(unit, b.level, 'spent');
    if (!this.meta[key]) return;
    this.anim.unregister(b.sprite);
    this.v2Ticker.unregister(b.sprite);
    b.sprite.setTexture(atlasFor(key), key);
    this.positionBuildingSprite(b.sprite, b, key);
    b.sprite.clearTint();
  }

  /** Dirty only changed eight-neighbor contexts after damage or a breach.
   * The detached collapse retains the exact pre-breach geometry. */
  private retileSurvivingWalls(): void {
    const live = [...this.buildings.entries()]
      .filter(([, building]) => building.type === 'wall' && !building.destroyed);
    this.wallFrames = resolveWallFrames(live.map(([id, building]) => ({
      id, tx: building.tx, ty: building.ty, tier: building.level,
    })));
    this.wallArt?.sync(live.map(([id, building]) => ({
      id, tx: building.tx, ty: building.ty, level: building.level,
      hp: building.hp, maxHp: building.maxHp, sprite: building.sprite,
    })));
  }

  private onDetonate(ev: Ev): void {
    const id = ev['id'] as number;
    this.stopLoop(id); // fuse → boom: stop the loop before the blast
    const r = this.troops.get(id);
    const x = this.ux(ev['x']);
    const y = this.uy(ev['y']);
    if (r) {
      // The event coordinate is authoritative for both V2 and the bounded
      // legacy fallback. Keep the blast and same-tick death body co-located.
      this.tweens.killTweensOf(r.fx.sprite);
      r.fx.sprite.setPosition(x, y).setDepth(actorDepth(y));
    }
    if (r?.fx.usesCurrentV2Art) {
      // `detonate` is the authoritative impact coordinate. Snap the actor there
      // before sampling the authored keg emitter: a detonation can land between
      // the sim's cadenced `pos` keyframes, and older stored event logs have no
      // Keg Runner `pos` events at all. Killing a live position tween prevents
      // it from dragging the dying sprite back toward a stale keyframe.
      // Rich admission owns the authored detonate frame and emitter. A compact
      // current body has no blast shard, so it keeps the feedback only. Neither
      // path may draw the historical explosion on a reworked Keg Runner.
      r.fx.onDetonate(() => {
        shake(this, 150, 0.004);
        haptic('medium');
      });
      return;
    }
    explode(this, x, y);
  }

  private onBurrow(ev: Ev): void {
    const id = ev['id'] as number;
    const troop = this.troops.get(id);
    if (this.jumping) troop?.fx.seekBurrowed();
    else troop?.fx.onBurrow();
    // D-099: a jumped span is silent (see the keg fuse loop in onDeploy).
    if ((troop?.troop === 'tunneler' || troop?.troop === 'bilgewraith') && !this.jumping) {
      this.loops.set(id, playSfxFamily(
        `sfx_troop_${troop.troop}_burrow_loop`,
        `${String(id)}:${String(ev.t)}:burrow`,
        'sfx_burrow_loop',
        { loop: true, volume: 0.5 },
      ));
    }
  }

  private onEmerge(ev: Ev): void {
    const id = ev['id'] as number;
    this.stopLoop(id);
    // v5 carries the exact exit point because its terminal pos and emerge share
    // a tick. Kill/snap that 500 ms interpolation before the surface clip; old
    // persisted logs omit x/y and continue through the legacy fallback.
    const x = typeof ev['x'] === 'number' ? this.ux(ev['x']) : undefined;
    const y = typeof ev['y'] === 'number' ? this.uy(ev['y']) : undefined;
    const fx = this.troops.get(id)?.fx;
    if (this.jumping) fx?.seekEmerged(x, y);
    else fx?.onEmerge(x, y);
  }

  private onDestroyed(ev: Ev): void {
    const b = this.buildings.get(ev['id'] as string);
    if (!b) return;
    this.keepClock?.remove(ev['id'] as string);
    if (b.type === 'wall') this.wallArt?.collapse(ev['id'] as string, this.jumping);
    b.destroyed = true;
    b.hp = 0;
    this.lastProgressAt = 0; // a collapse is worth an immediate HUD beat
    this.emitProgress();
    b.bar?.destroy();
    b.bar = null;
    if (this.jumping) {
      b.damage.destroy();
      b.ware?.destroy();
      delete b.ware;
      b.v2?.destroy();
      delete b.v2;
      b.market?.destroy();
      delete b.market;
      b.berth?.destroy();
      delete b.berth;
      if (b.type === 'wall') {
        this.retileSurvivingWalls();
      } else if (isWareBuildingUnit(b.type)) {
        this.applyWareFallbackState(b, 'collapse');
      } else if (this.ownsMarketArt(b)) {
        // A seek lands on the pack's own rubble cell, never the generic fx_rubble.
        this.applyMarketFallbackState(ev['id'] as string, b, 'destroyed');
      } else if (b.type === 'berth') {
        // A berth seeks onto its family's destroyed still (vehicle gone, D-b).
        this.applyBerthFallbackState(ev['id'] as string, b, 'destroyed');
      } else {
        const rubble = b.fw === 2 && b.fh === 2
          ? 'fx_rubble_2x2' : b.fw === 2 ? 'fx_rubble_2x1' : 'fx_rubble_1x1';
        this.anim.unregister(b.sprite);
        cancelDefenceFire(b.sprite);
        b.sprite.setTexture('fx', rubble);
        const [ax, ay] = this.meta[rubble]?.anchor ?? [0.5, 1];
        b.sprite.setOrigin(ax, ay).clearTint();
      }
      if (b.type === 'wall') this.retileSurvivingWalls();
      return;
    }
    const ownsM22Collapse = b.type === 'wall' || isWareBuildingUnit(b.type) || this.ownsMarketArt(b) || b.type === 'berth';
    if (!ownsM22Collapse) b.damage.collapse();
    haptic('light');
    if (b.type === 'wall') {
      this.retileSurvivingWalls();
      return;
    }
    if (b.ware) {
      b.ware.collapse();
      return;
    }
    if (isWareBuildingUnit(b.type)) {
      this.applyWareFallbackState(b, 'collapse');
      return;
    }
    // Phase E Market (C3): the family's authored collapse one-shot into its own
    // rubble cell; a Market whose art never arrived rests on that cell once it
    // does, and never on the generic fx_rubble.
    if (b.market) {
      b.market.collapse();
      return;
    }
    if (this.ownsMarketArt(b)) {
      this.applyMarketFallbackState(ev['id'] as string, b, 'destroyed');
      return;
    }
    // Phase E berth (P6a): the family's destroyed still, the vehicle leaves
    // with it (D-b); an unpresented berth stays its hidden footprint.
    if (b.berth) {
      b.berth.collapse();
      return;
    }
    if (b.type === 'berth') {
      this.applyBerthFallbackState(ev['id'] as string, b, 'destroyed');
      return;
    }
    // Rework-v2 cannon/mortar fall with their OWN authored collapse clip
    // (single-row, final frame held as the rubble) instead of the generic
    // fx_rubble — exactly these two types; everything else is untouched.
    if (b.v2) {
      b.v2.collapse();
      return;
    }
    const rubbleKey = b.fw === 2 && b.fh === 2 ? 'fx_rubble_2x2' : b.fw === 2 ? 'fx_rubble_2x1' : 'fx_rubble_1x1';
    this.anim.unregister(b.sprite);
    // A shot fired a moment before the collapse still has its return-to-idle
    // frame scheduled; without this it would repaint the rubble as a tower.
    cancelDefenceFire(b.sprite);
    b.sprite.setTexture('fx', rubbleKey);
    const [ax, ay] = this.meta[rubbleKey]?.anchor ?? [0.5, 1];
    b.sprite.setOrigin(ax, ay).clearTint();
  }

  private onTrap(ev: Ev): void {
    const id = ev['id'] as string;
    (this.artDecidedDefenses ??= new Set<string>()).add(id);
    const trap = this.buildings.get(id);
    if (!trap) return;
    if (!this.jumping) haptic('light');
    trap.trapSpent = true;
    trap.destroyed = true;
    if (trap.wareTrap && this.jumping) {
      trap.wareTrap.destroy();
      delete trap.wareTrap;
      if (isWareTrapUnit(trap.type)) this.applyWareTrapSpentFallback(trap, trap.type);
    } else if (trap.wareTrap) trap.wareTrap.trigger();
    else if (isWareTrapUnit(trap.type)) this.applyWareTrapSpentFallback(trap, trap.type);
    if (ev['kind'] === 'pitfall' && !this.jumping) {
      for (const id of (ev['victims'] as number[] | undefined) ?? []) {
        const victim = this.troops.get(id);
        if (victim?.fx.sprite.active) {
          floatText(this, victim.fx.sprite.x, victim.fx.sprite.y - victim.fx.sprite.displayHeight, 0, {
            prefix: 'STUN ',
          });
        }
      }
    }
  }

  private ux(u: unknown): number {
    return ((u as number) / 256) * T; // sim units (1/256 tile) → world px
  }
  private uy(u: unknown): number {
    return ((u as number) / 256) * T;
  }
}
