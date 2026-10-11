import { wallRowThrough } from '@shardkeep/shared';
/**
 * BaseScene — the home base (HANDOFF §3 world rules, §5 drag&drop contract).
 *
 * Scale: 1 tile = 32 game px rendered at 2× → 64 world px (HANDOFF §2.1).
 * Depth: the WORLD_DEPTH bands (packages/shared) — ground < structures < actors
 * < world UI — with walls/buildings sharing painter's bottom-edge Y order.
 * Camera: live-claim fit–1.6, pan clamped so the shared grass skirt never
 * shows (HANDOFF §5.2); pinch + wheel + drag-on-ground.
 * Drag: 6px (logical) Manhattan threshold, 16px lift (8 game px), brightness
 * lift, green/red footprint tint, auto-revert on invalid (HANDOFF §5).
 * The scene READS server state from the store and emits intents on the bus —
 * it never computes costs or commits moves itself (server-authoritative).
 */
import {
  AMBIENCE, ART_V2, DEFENSES, KEEP_BATTERIES, STRUCTURES, TRAP_TYPES, artTierOfLevel, BASE_CAMERA, GRID,
  eagerAtlasScale, resolveWallFrames, v2BuildingFallbackFrameKey, wareTrapStateAliasKey,
} from '@shardkeep/shared';
import type { BoundCosmeticAwningId } from '@shardkeep/shared/boundCosmeticVisual';
import { resolveBaseVisualContext } from '@shardkeep/shared/baseVisual';
import { HARVESTER_UNPRESENTED_KEY } from '../world/harvesterArt';
import Phaser from 'phaser';
import { playSfx } from '../../lib/audio';
import { EmptyTapGesture } from '../input/emptyTap';
import { bus, type GameEvents } from '../../lib/events';
import { haptic, reduceMotionOn } from '../../lib/juice';
import { requestUserCommand, captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp, type BaseSnapshotGuard, type BaseStateDto } from '../../state/store';
import { AnimTicker } from '../anim';
import {
  buildingSeatY, v2BldSeat, V2_BLD_FOOTPRINT, V2_DRAW_SCALE, type V2Meta, type V2ClipMap,
} from '../v2/clips';
import { V2Ticker } from '../v2/ticker';
import { WareBuildingFx, WareTrapFx } from '../ware/building';
import { MarketBuildingFx } from '../fx/marketBuilding';
import {
  BerthBuildingFx, berthCompositionFor, berthCompositionGroups, journeyDurationMs, journeyOutcomePresence, journeyPlanFor, journeyPlanGroups,
  type BerthComposition, type BerthPresence, type JourneyPlan,
} from '../fx/berthBuilding';
import { fleetJourneyEventKey, type FleetJourneyEvent } from '@shardkeep/shared/fleetJourneyPresentation';
import {
  AWNING_ATLAS_GROUP, EMPTY_MARKET_ART, MARKET_ART_REGISTRY_KEY, MARKET_FRAME_KEY,
  marketArtFamilyOf, marketArtGroup, marketArtTierOfLevel, marketFrameFamily, marketRestFrameKey, marketSeat,
  selectMarketAwnings, type MarketArtChoice, type MarketArtTable,
} from '../world/marketArt';
import {
  EMPTY_STARTER_FLEET_ART, STARTER_FLEET_ART_REGISTRY_KEY, STARTER_FLEET_FRAME_KEY,
  berthRestFrameKey, starterFleetSeat, type StarterFleetArtTable,
} from '../world/fleetArt';
import {
  ADVANCED_FLEET_ART_REGISTRY_KEY, ADVANCED_FLEET_FRAME_KEY, BERTH_UNPRESENTED_KEY, EMPTY_ADVANCED_FLEET_ART,
  advancedBerthFrameKey, advancedFleetSeat, berthKeyGroup, selectCurrentBerths,
  type AdvancedFleetArtTable, type BerthFactsSelection, type BerthInstallation,
} from '../world/advancedFleetArt';
import {
  isWareBuildingUnit, isWareTrapUnit,
  wareBuildingAtlasGroup, wareTrapAtlasGroup, wareSeat, type WareMeta,
} from '../ware/clips';
import { claimPerimeter, claimPerimeterDrawn, skirtDecor } from '../world/underlay';
import { SceneGround } from '../world/sceneGround';
import { SceneVisualGate } from '../world/sceneVisualGate';
import { overlayDepth, structureDepth, type StructureDepthKind } from '../world/depth';
import {
  EMPTY_KEEP_CLOCK_METADATA, KEEP_CLOCK_META_REGISTRY_KEY,
  KeepClockLayer, type KeepClockMetadata,
} from '../world/keepClock';
import { AmbienceLayer } from '../world/ambience';
import {
  admitOnDemandAtlasCandidates, ensureV2Atlases,
  isV2AtlasLoaded, releaseAtlasGroups, releaseAtlasReservations,
  releaseUnreferencedAtlases, releaseUnusedAtlases, retainAtlasGroups,
} from '../world/atlasLoader';
import { frameAlphaAt, frameOpaqueTopRatio } from '../world/atlasTexels';
import { BASE_ART_RETRY_DELAYS_MS, basePatrolFirstCandidates } from '../world/artBudget';
import type { AtlasCandidate } from '../world/artBudget';
import {
  PatrolLayer, requiredV2PatrolAtlasGroups, visibleGarrisonTroops,
} from '../world/patrol';
import { JobLayer, requiredBuilderAtlasGroups } from '../world/jobs';
import { HeroRecoveryLayer } from '../world/heroRecovery';
import { ArmyStatusLayer, armyStatusAnchorY } from '../world/armyStatus';
import { spriteVisualTopY } from '../world/worldChipGeometry';
import { clampPlotPosition, supportedPlotVersion } from '../world/basePlot';
import { isInsidePlot } from '@shardkeep/shared';
import { Occupancy } from '../world/occupancy';
import { dustPuff, liftShadow } from '../world/fx';
import { baseZoomBand, baseRenderBounds, fitBaseCamera, reframeAfterResize } from '../world/camera';
import { PinchZoom } from '../world/pinch';
import { atlasFor, type MetaMap } from './BootScene';
import { wallFrameKey } from '@shardkeep/shared/wallRender';
import { WallLayer, isContextWallFrame, type WallSpriteInput } from '../world/walls';

const T = 64; // world px per tile (32 game px @2x)
const SKIRT = BASE_CAMERA.skirtTiles * T;
const WORLD = GRID.plotTiles * T;
/** Camera bounds: the plot plus its skirt on every side (HANDOFF §5.2). Square,
 *  viewport-independent — a rotation cannot move the world edge. */
const BOUNDS = WORLD + SKIRT * 2;
/** Server obstacle keys mirror the App's OBS_TYPES; two differ from asset names. */
const obstacleDecKey = (spriteKey: string): string => {
  const fix: Record<string, string> = { pine1: 'pine_1', pine2: 'pine_2' };
  return `dec_${fix[spriteKey] ?? spriteKey}`;
};
const LIFT = 16; // 8 game px
/** A carried piece floats above every settled sprite and every walker. */
const LIFT_DEPTH = overlayDepth(2500); // WORLD_DEPTH.overlay — a carried piece rides above the world
const LIFT_ALPHA = 0.95; // lifted-ghost feedback (HANDOFF §5)
const DRAG_THRESHOLD = 12; // 6 logical px @2x
/**
 * HOLD-TO-LIFT (owner 2026-08-01: "you can easily move walls unexpectedly and
 * unintentionally"). A pointerdown on a building used to arm a move immediately,
 * so any pan gesture that HAPPENED TO START on a building dragged it instead of
 * scrolling — and walls line the whole perimeter, making them the likeliest
 * thing under a thumb. Clash-of-Clans rule instead: a quick swipe is always a
 * pan, wherever it starts; holding still on a piece for this long grabs it
 * (haptic + lift cue), and only then does movement drag. Taps are unaffected —
 * selection happens on pointerup below the movement threshold either way.
 */
const HOLD_TO_LIFT_MS = 200;
const VALID_TINT = 0x8cb36e;
const BLOCKED_TINT = 0xc75a2e;

/** Fill gaps between throttled/coalesced pointer samples. Mobile browsers may
 * deliver only the endpoints of a fast swipe; a deterministic tile line keeps
 * wall painting continuous without manufacturing a second undo gesture. */
function tileStrokeLine(
  from: { tx: number; ty: number },
  to: { tx: number; ty: number },
): Array<{ tx: number; ty: number }> {
  const tiles: Array<{ tx: number; ty: number }> = [];
  let tx = from.tx;
  let ty = from.ty;
  const dx = Math.abs(to.tx - tx);
  const sx = tx < to.tx ? 1 : -1;
  const dy = -Math.abs(to.ty - ty);
  const sy = ty < to.ty ? 1 : -1;
  let error = dx + dy;
  for (;;) {
    tiles.push({ tx, ty });
    if (tx === to.tx && ty === to.ty) return tiles;
    const doubled = error * 2;
    if (doubled >= dy) { error += dy; tx += sx; }
    if (doubled <= dx) { error += dx; ty += sy; }
  }
}
/** Wall-selection pulse endpoints: the sprite's own art (white = untinted) breathing
 *  toward the UI gold. Walls are 1 tile, so bracket/outline overlays swamped the piece
 *  they marked — a tint pulse marks it without drawing anything on top. */
const PULSE_FROM = new Phaser.Display.Color(255, 255, 255);
const PULSE_TO = new Phaser.Display.Color(255, 213, 74); // 0xffd54a

interface RangeOverlay {
  frame: string;
  scale: number;
  depth: number;
}

/** The overlay atlas has radius-3/4/7 masters. Scale is derived from the same
 * shared combat values as the sim (D-060 moved cannon to 6 and archer to 7, so
 * both now ride the r7 master scaled by their own DEFENSES range over the
 * laser's 7 — the same idiom the six-tile Air Defence established in M22). */
const RANGE_RING: Record<string, RangeOverlay> = {
  cannon: {
    frame: 'ovl_range_r7',
    scale: DEFENSES.cannon.rangeTiles / DEFENSES.lasertower.rangeTiles,
    depth: 933,
  },
  archertower: {
    frame: 'ovl_range_r7',
    scale: DEFENSES.archertower.rangeTiles / DEFENSES.lasertower.rangeTiles,
    depth: 933,
  },
  mortar: { frame: 'ovl_range_r7', scale: 1, depth: 933 },
  electrictower: { frame: 'ovl_range_r4', scale: 1, depth: 933 },
  magetower: { frame: 'ovl_range_r4', scale: 1, depth: 933 },
  lasertower: { frame: 'ovl_range_r7', scale: 1, depth: 933 },
  dragonnest: { frame: 'ovl_range_r4', scale: 1, depth: 933 },
  airdefence: {
    frame: 'ovl_range_r7',
    scale: DEFENSES.airdefence.rangeTiles / DEFENSES.lasertower.rangeTiles,
    depth: 933,
  },
};

/** The L17 Keep low battery keeps its own pinned 3-tile reach (D-060: the
 * cannon doubling is a Cannon-building buff), so its ring is the r3 master
 * scaled by KEEP_BATTERIES.lowRangeTiles — NOT the cannon ring. */
const KEEP_LOW_BATTERY_RING: RangeOverlay = {
  frame: 'ovl_range_r3',
  scale: KEEP_BATTERIES.lowRangeTiles / 3,
  depth: 933,
};

const MORTAR_DEAD_ZONE: RangeOverlay = {
  frame: 'ovl_deadzone_r2',
  scale: 1,
  depth: 934,
};

/** Selection truth for the level-gated Keep batteries. L15 exposes only the
 * Mortar-shaped high battery and its dead zone; at L17 the Cannon-shaped low
 * battery fills that hole and is shown as a second ring. */
export function selectionRangeOverlays(type: string, level: number): readonly RangeOverlay[] {
  if (type === 'keep') {
    if (level < KEEP_BATTERIES.highRangeUnlockLevel) return [];
    return level >= KEEP_BATTERIES.lowRangeUnlockLevel
      ? [RANGE_RING.mortar!, KEEP_LOW_BATTERY_RING]
      : [RANGE_RING.mortar!, MORTAR_DEAD_ZONE];
  }
  const outer = RANGE_RING[type];
  if (!outer) return [];
  return type === 'mortar' ? [outer, MORTAR_DEAD_ZONE] : [outer];
}

interface Footprint { fw: number; fh: number }

interface SceneLayoutDraft {
  positions: Map<string, { tx: number; ty: number }>;
  trayIds: Set<string>;
  selectedBuildingId: string | null;
  wallPaintLevel: number | null;
}

interface BuildingSeat {
  origin: readonly [number, number];
  scale: number;
  offsetGamePx: readonly [number, number];
}

interface ArtRetryState {
  candidateId: string;
  nextDelayIndex: number;
  dueAt: number | null;
  inFlight: boolean;
  exhausted: boolean;
}

interface InteractionIdleWaiter {
  resolve: () => void;
  reject: (cause: Error) => void;
}

const artRetryKey = (candidate: AtlasCandidate): string => JSON.stringify([
  candidate.id,
  [...new Set(candidate.groups)].sort(),
]);

/** Adjacent canonical footprints share an edge. Phaser.Rectangle.Contains is
 * inclusive on both sides, which gives that edge two owners; use half-open
 * south/east bounds so exactly one sprite wins it. */
const footprintContains = (area: Phaser.Geom.Rectangle, x: number, y: number): boolean =>
  x >= area.x && x < area.right && y >= area.y && y < area.bottom;

/** Visible artwork owns visible pixels, including authored overhang. This is
 * deliberately separate from the canonical-footprint fallback: combining the
 * two in one hit area lets a transparent neighbour footprint steal a visibly
 * rendered tower behind it before Phaser can test that tower's opaque pixel. */
const visibleArtContains = (
  _area: Phaser.Geom.Rectangle,
  x: number,
  y: number,
  gameObject: Phaser.GameObjects.GameObject,
): boolean => {
  const sprite = gameObject as Phaser.GameObjects.Sprite;
  if (!sprite.parentContainer) {
    // Phaser hit-tests unparented sprites with double-precision TransformXY,
    // but renders their transform through a Float32 matrix. A fitted Barracks
    // roof pixel can therefore be y=37.999999999999886 here while the drawn
    // texel is row 38, letting the wall behind it steal the tap. Recover the
    // world point, then sample through the same matrix precision as rendering.
    // Parented objects already use this matrix path in InputManager.hitTest.
    const localX = x - sprite.displayOriginX;
    const localY = y - sprite.displayOriginY;
    const cos = Math.cos(sprite.rotation);
    const sin = Math.sin(sprite.rotation);
    const worldX = sprite.x + cos * sprite.scaleX * localX - sin * sprite.scaleY * localY;
    const worldY = sprite.y + sin * sprite.scaleX * localX + cos * sprite.scaleY * localY;
    const rendered = sprite.getWorldTransformMatrix().applyInverse(worldX, worldY);
    x = rendered.x + sprite.displayOriginX;
    y = rendered.y + sprite.displayOriginY;
  }
  if (x < 0 || y < 0 || x >= sprite.width || y >= sprite.height) return false;
  const alpha = frameAlphaAt(
    sprite.scene, sprite.texture.key, sprite.frame.name, Math.floor(x), Math.floor(y),
  );
  return alpha !== null && alpha > 0;
};

const sceneCommandLifetimes = new WeakMap<Phaser.Scene, { generation: number }>();
function sceneCommandLifetime(scene: Phaser.Scene): { generation: number } {
  let lifetime = sceneCommandLifetimes.get(scene);
  if (!lifetime) {
    lifetime = { generation: 0 }; sceneCommandLifetimes.set(scene, lifetime);
    const current = lifetime;
    const retire = (): void => { ++current.generation; };
    const shutdown = (): void => {
      retire(); sceneCommandLifetimes.delete(scene);
      scene.events?.off(Phaser.Scenes.Events.SLEEP, retire);
      scene.events?.off(Phaser.Scenes.Events.SHUTDOWN, shutdown);
    };
    scene.events?.on(Phaser.Scenes.Events.SLEEP, retire);
    scene.events?.on(Phaser.Scenes.Events.SHUTDOWN, shutdown);
  }
  return lifetime;
}

/** A validated target and scene lifetime, never a pooled Phaser pointer.
 * A refreshed snapshot requires a fresh gesture; original transport owners
 * still enforce current mutation authority when they receive the intent. */
function requestSceneCommand(scene: Phaser.Scene, targets: readonly { kind: 'building' | 'obstacle'; id: string }[],
  command: () => void, stillValid: () => boolean = () => true): void {
  const lifetime = sceneCommandLifetime(scene);
  const generation = lifetime.generation;
  const snapshot = useApp.getState().base;
  const targetRows = targets.map(target => target.kind === 'building'
    ? snapshot?.buildings.find(row => row.id === target.id)
    : snapshot?.obstacles.find(row => row.id === target.id));
  requestUserCommand(command, () => {
    const current = useApp.getState();
    return lifetime.generation === generation && scene.sys?.isActive?.() !== false && current.base === snapshot
      && targetRows.every(row => row !== undefined)
      && targets.every((target, index) => (target.kind === 'building'
        ? current.base?.buildings.find(row => row.id === target.id)
        : current.base?.obstacles.find(row => row.id === target.id)) === targetRows[index])
      && stillValid();
  });
}

export class BaseScene extends Phaser.Scene {
  private meta!: MetaMap;
  private builderClips: V2ClipMap = {};
  /** Rework-v2 clip tables (BootScene registry) — anchors for the v2
   *  cannon/mortar masters, which live in v2Clips rather than meta.sprites. */
  private v2meta: V2Meta = { clips: {}, breathStream: null, atlasBytes: {} };
  /** M22 manifest clips/anchors. Stable aliases are eager; rich state groups
   * are optional and always fall back to those exact-current aliases. */
  private waremeta: WareMeta = { clips: {}, currentArtAliases: {}, atlasBytes: {} };
  /** V2 tower bodies temporarily removed while a Dire battle owns the optional
   * texture budget. They stay hidden—not re-skinned to old art—until their exact
   * current tier reloads on wake. */
  private battleReleasedV2Buildings = new Set<string>();
  private buildingSprites = new Map<string, Phaser.GameObjects.Sprite>();
  /** E-11 remnants (`clearedObstacles[]`), keyed `tx,ty`: plain Images, never in
   * buildingSprites so no hit test, drag, focus or occupancy path can find one. */
  private remnantImages = new Map<string, Phaser.GameObjects.Image>();
  private wareBuildings = new Map<string, WareBuildingFx>();
  private wareTraps = new Map<string, WareTrapFx>();
  /** Phase E Market art (C3): the packed clip tables from BootScene, one
   * controller per Market whose selected family is resident, and the Awning
   * choice per Market taken from the store's server projection each render. */
  private marketArt: MarketArtTable = EMPTY_MARKET_ART;
  private marketBuildings = new Map<string, MarketBuildingFx>();
  private marketAwnings: ReadonlyMap<string, BoundCosmeticAwningId> = new Map();
  private starterFleetArt: StarterFleetArtTable = EMPTY_STARTER_FLEET_ART;
  private berthBuildings = new Map<string, BerthBuildingFx>();
  /** Both current siblings' berth facts (starter v1 + advanced v1) against this base's rows. */
  private berthFacts: BerthFactsSelection = { berths: new Map(), unavailable: false };
  /** C5: root-published journeys (by berth id) waiting, at most for their own live
   *  duration, for every group they draw from; the event keys already honoured once;
   *  and the groups a dropped journey asked residency for, so the NEXT event finds them. */
  private pendingJourneys = new Map<string, { event: FleetJourneyEvent; deadline: number; snapshot: BaseStateDto; guard: BaseSnapshotGuard }>();
  private seenJourneyKeys = new Set<string>();
  private journeyArtWanted = new Map<string, readonly string[]>();
  /** C5: the outcome of a DEPARTURE that played against a snapshot (by berth id). While
   *  that SAME snapshot object is still the store base, its pre-departure presence is
   *  stale and must not resurrect the craft; any newer snapshot controls rest again.
   *  Returns record nothing: their snapshot already states the post-settlement fact. */
  private journeyOutcomes = new Map<string, { snapshot: BaseStateDto; presence: BerthPresence }>();
  private advancedFleetArt: AdvancedFleetArtTable = EMPTY_ADVANCED_FLEET_ART;
  /** Buildings hidden only because their on-demand art is not resident yet;
   * they keep their footprint tap (see footprintObjectAt). */
  private pendingArtIds = new Set<string>();
  private wallArt: WallLayer | undefined;
  /** Seating/store/editor changes invalidate wall inputs; idle frames only drain preparation. */
  private wallArtDirty = true;
  private fantasyGround: SceneGround | undefined;
  private visualGate: SceneVisualGate | undefined;
  private selectCorners: Phaser.GameObjects.Image[] = [];
  private dragTint: Phaser.GameObjects.Rectangle | null = null;
  /** Per-tile buildable/blocked overlay shown only while placing or moving. */
  private placementGrid: Phaser.GameObjects.Graphics | null = null;
  /** Persistent organic read of the authoritative server claim. */
  private claimPerimeterObjects: Phaser.GameObjects.GameObject[] = [];
  /** Retry state is keyed by candidate identity AND its sorted atomic group set.
   * A tier/group change is new current art and gets a fresh bounded sequence. */
  private artRetryStates = new Map<string, ArtRetryState>();
  private artRetryKeyByCandidate = new Map<string, string>();
  private artRetryActiveKeys = new Set<string>();
  private artRetryTimer: Phaser.Time.TimerEvent | null = null;
  private artRetryTimerDueAt: number | null = null;
  /** Optional rich-atlas work is one-at-a-time and crosses the stitch/upload
   * boundary only while no pointer owns the canvas. */
  private richArtLoadTail: Promise<void> = Promise.resolve();
  private interactionIdleWaiters = new Set<InteractionIdleWaiter>();
  private richArtLoadsStopped = false;
  /** Camera + active-feedback invalidation key for the live server claim. */
  private lastClaimKey = '';
  private lastBaseIdentity: string | null = null;
  private unsub: Array<() => void> = [];

  // world layers (game/world/*)
  private ticker = new AnimTicker();
  private wareTicker = new V2Ticker();
  private ambience!: AmbienceLayer;
  private patrol!: PatrolLayer;
  /**
   * Hold on the atlas groups the GRANTED patrol is built from, released only
   * when the grant changes or the patrol goes away.
   *
   * WHY (owner 2026-08-30, "troops swap between two different pictures"): the
   * grant gate below asks `isV2AtlasLoaded` on every render, so a walker's art
   * path is a function of texture residency AT THAT INSTANT — and a few lines
   * later `releaseUnreferencedAtlases` evicts every on-demand group NO SPRITE
   * IS DRAWING. A grant made of more than one group (Gloamfang's `_combat`
   * sheet rides with its `_locomotion` walk) therefore loses the un-drawn half
   * on the very pass that granted it: the next render sees the grant gate fail,
   * the patrol signature flips, and EVERY walker on the base is destroyed and
   * respawned on the eager still. The reload re-grants, and it flips back —
   * measured at ~1.7 flips/second on a played base, which is exactly "swapping
   * between two pictures". Holding the grant's groups makes the sweep's
   * "is anybody using it" answer the truth: the patrol is.
   */
  private patrolArtLease: (() => void) | null = null;
  /** Blocked tiles (buildings, walls, obstacles) shared by the walking actors
   *  so nobody strolls through a footprint (owner 2026-07-29). Rebuilt
   *  from store state in renderFromStore, i.e. from the same rows the sprites
   *  are drawn from — one source of truth for "what is standing here". */
  private occ = new Occupancy(T);
  /** last update() timestamp, for framerate-independent patrol movement. */
  private lastUpdateMs = 0;
  /** G4a ambient work bed: >0 builder jobs running → a soft hammer beat. Set in
   *  renderFromStore; consumed by update(). ms until the next strike. */
  private ambientBusy = false;
  private hammerInMs = 0;
  private jobs!: JobLayer;
  private heroRecovery!: HeroRecoveryLayer;
  private armyStatus!: ArmyStatusLayer;
  private keepClock!: KeepClockLayer;
  private pinch!: PinchZoom;
  /** Live zoom limits for the CURRENT viewport (world/camera.ts). Re-banded on
   *  every resize, and the ONE band the wheel and the pinch both clamp to. */
  private zoomBand!: { min: number; max: number };
  /** Real React chrome measured in screen pixels. Null only before BaseHud's
   * first layout pass, when the canvas uses its raw viewport. */
  private insets: { top: number; bottom: number; left: number; right: number } | null = null;
  /** Late measurements and rotations may update limits, but must not take a
   * player-panned camera away from the building they are aligning. */
  private userMovedCamera = false;
  /** wall id → auto-connected frame, recomputed each render. */
  private wallFrames = new Map<string, string>();
  /** #61: the contiguous wall LINE, moved together. Entered OPT-IN from the small
   *  square button on a selected wall — never straight off a tap (a tap that
   *  silently grabbed the whole row made single walls unselectable). */
  private wallLineIds = new Set<string>();
  /** Sprites currently breathing under the selection pulse, and the ONE tween that
   *  drives them all — a 40-wall row costs exactly what a single wall costs. */
  private pulseIds: string[] = [];
  private pulseTween: Phaser.Tweens.Tween | null = null;
  /** detached lift shadow under the actively dragged/placed piece. */
  private liftShadow: Phaser.GameObjects.Image | null = null;
  /** true while an obstacle press is still a tap candidate. Crossing the drag
   * threshold clears it and promotes that same gesture to camera pan. */
  private panSuppressed = false;
  /** Once a touch is unequivocally a camera pan, all sprite InteractiveObjects
   * are disabled until the whole gesture ends. That removes their per-move
   * alpha reads while retaining the scene-level camera handler. */
  private objectHitTestsSuppressed = false;
  /** obstacle id whose sprite received the *current* pointerdown, with the
   * press origin. An obstacle tap only commits if pointerup lands on the SAME
   * obstacle that the press started on, with sub-threshold movement — mirrors
   * the App's obsDown discipline (read-app §1/§8): pan-release over an obstacle,
   * or a tap that began on a building/empty ground, must NEVER select it. */
  private obstaclePress: { id: string; pointerId: number; x: number; y: number } | null = null;
  /** Pointer that began the current canvas gesture. Window-level releases from
   * React chrome must not commit a scene action that never started here. */
  private pointerOwnerId: number | null = null;
  private emptyTap = new EmptyTapGesture(DRAG_THRESHOLD);
  /** Phaser's reusable global slots can include HUD touches or a lost touchend.
   * Only downs delivered here own input; keep the native identity separately
   * because Phaser mutates the Pointer object when reusing its slot. */
  private pointerContacts = new Map<number, {
    pointer: Phaser.Input.Pointer;
    identifier: number;
    downEvent: Phaser.Input.Pointer['event'];
  }>();
  /** A two-pointer gesture is camera-only until BOTH pointers lift. */
  private multiPointerGesture = false;
  /** Server-layout editing is a scene presentation layer only. Store rows stay
   * authoritative until React completes one atomic save/apply request. */
  private layoutDraft: SceneLayoutDraft | null = null;
  /** One pointer stroke consuming existing trayed wall identities. */
  private layoutWallStroke: {
    tiles: Array<{ tx: number; ty: number }>;
    set: Set<string>;
    gfx: Phaser.GameObjects.Graphics;
    lastTile: { tx: number; ty: number } | null;
    maxTiles: number;
  } | null = null;

  // build-placement ghost (HANDOFF §5.1)
  private ghost: {
    type: string;
    sprite: Phaser.GameObjects.Sprite;
    fp: Footprint;
    tx: number; ty: number;
    valid: boolean;
    ring: Phaser.GameObjects.Image | null;
  } | null = null;

  // Wall SWIPE placement (#59): while a WALL ghost is active, dragging paints the
  // valid tiles under the pointer; releasing commits them all at once (build:paint).
  private wallPaint: {
    tiles: Array<{ tx: number; ty: number }>;
    set: Set<string>;
    gfx: Phaser.GameObjects.Graphics;
  } | null = null;

  // active drag state
  private drag: {
    id: string;
    pointerId: number;
    sprite: Phaser.GameObjects.Sprite;
    startX: number; startY: number;
    origTx: number; origTy: number;
    fp: Footprint;
    moved: boolean;
    curTx: number; curTy: number;
    /** #61: the OTHER walls of a selected line, dragged in lockstep with the primary. */
    line?: Array<{ id: string; sprite: Phaser.GameObjects.Sprite; origTx: number; origTy: number }>;
  } | null = null;

  constructor() {
    super('base');
  }

  create(): void {
    this.visualGate?.destroy();
    this.visualGate = new SceneVisualGate(this, 'base', () => {
      this.fantasyGround?.retryLoad();
      this.wallArt?.retryPreparation();
    }, () => this.cancelPointerGesture());
    this.wallArt = new WallLayer(this, ({ sprite, tx, ty }) => {
      this.refreshFootprintHitArea(sprite, tx, ty, { fw: 1, fh: 1 });
    });
    this.wallArtDirty = true;
    this.richArtLoadsStopped = false;
    this.richArtLoadTail = Promise.resolve();
    this.interactionIdleWaiters.clear();
    this.objectHitTestsSuppressed = false;
    this.meta = this.registry.get('meta') as MetaMap;
    this.v2meta = (this.registry.get('v2meta') as V2Meta | undefined)
      ?? { clips: {}, breathStream: null, atlasBytes: {} };
    this.builderClips = (this.registry.get('builderClips') as V2ClipMap | undefined) ?? {};
    this.waremeta = (this.registry.get('waremeta') as WareMeta | undefined)
      ?? { clips: {}, currentArtAliases: {}, atlasBytes: {} };
    this.marketArt = (this.registry.get(MARKET_ART_REGISTRY_KEY) as MarketArtTable | undefined)
      ?? EMPTY_MARKET_ART;
    this.starterFleetArt = (this.registry.get(STARTER_FLEET_ART_REGISTRY_KEY) as StarterFleetArtTable | undefined)
      ?? EMPTY_STARTER_FLEET_ART;
    this.advancedFleetArt = (this.registry.get(ADVANCED_FLEET_ART_REGISTRY_KEY) as AdvancedFleetArtTable | undefined)
      ?? EMPTY_ADVANCED_FLEET_ART;
    this.cameras.main.setBackgroundColor('#567A4B');
    this.cameras.main.setBounds(-SKIRT, -SKIRT, BOUNDS, BOUNDS);
    this.cameras.main.centerOn(WORLD / 2, WORLD / 2);

    this.ticker.attach(this);
    this.wareTicker.attach(this);
    this.ambience = new AmbienceLayer(this, this.ticker, this.meta, T, this.v2meta.clips);
    this.jobs = new JobLayer(this, this.ticker, this.wareTicker, this.meta, T);
    this.heroRecovery = new HeroRecoveryLayer(this, T);
    this.armyStatus = new ArmyStatusLayer(this);
    this.armyStatus.setSelected(useApp.getState().selectedBuildingId);
    this.keepClock = new KeepClockLayer(
      this,
      (this.registry.get(KEEP_CLOCK_META_REGISTRY_KEY) as KeepClockMetadata | undefined)
        ?? EMPTY_KEEP_CLOCK_METADATA,
    );
    // The garrison gets the SAME per-clip clock JobLayer above already has:
    // the v2/game-v4 walk sheets publish their own fps and judder on the
    // house 260ms tick (patrol.ts layer law).
    this.patrol = new PatrolLayer(
      this, this.ticker, this.wareTicker, T, this.occ, this.v2meta.clips,
    );
    this.pinch = new PinchZoom(this.cameras.main, () => {
      this.userMovedCamera = true;
      if (this.ghost || this.layoutDraft) this.drawPlacementGrid();
    });
    if (!this.input.pointer2) this.input.addPointer(1); // the pointer pool belongs to the game

    // Deferred one tick: Phaser 4.1 drops Graphics commands recorded during
    // scene create (before the first render pass) — verified empirically.
    this.time.delayedCall(0, () => this.drawUnderlay());
    this.renderFromStore();

    this.unsub.push(bus.on('base:refresh', () => this.renderFromStore()));
    this.unsub.push(bus.on('fleet:journey', (event) => this.onFleetJourney(event)));
    this.attachJourneyLifecycle();
    this.unsub.push(bus.on('base:layoutDraft', (command) => {
      if (command.op === 'hide') this.hideLayoutDraft();
      else this.showLayoutDraft(command);
    }));
    // React resolved a posted move, so the store is authoritative for these
    // buildings again — whether the server took the move or rejected it. Release
    // BEFORE the refresh that follows it, so that refresh seats them from the
    // store rather than from a tile we are no longer entitled to hold.
    this.unsub.push(bus.on('base:moveSettled', ({ buildingIds }) =>
      this.releaseSettlingMoves(buildingIds)));
    // Store-side deselection heals the scene (verification 2026-07-26, wall-ux
    // majors #1/#2): the sheet's ✕ (select(null)), setScreen navigation, and
    // selectObstacle all null selectedBuildingId WITHOUT any scene call — which
    // left the infinite pulse tween breathing on an unselected wall and, worse,
    // kept wallLineIds populated so a later drag on any wall of that stale run
    // silently moved and committed the WHOLE row. One subscription covers every
    // such path, present and future; scene-initiated flows already call these
    // and the repeat is idempotent.
    this.unsub.push(useApp.subscribe((state, prev) => {
      // A building whose sheet is open has the player's attention; its chip yields.
      if (prev.selectedBuildingId !== state.selectedBuildingId) {
        this.armyStatus?.setSelected(state.selectedBuildingId);
      }
      if (prev.selectedBuildingId !== null && state.selectedBuildingId === null) {
        this.clearWallLine();
        this.showSelection(null); // drops brackets + wall pulse
      }
    }));
    // #61: the wall sheet's SELECT WHOLE ROW toggle widens/narrows what the pulse
    // marks — and therefore what a drag carries (attachBuildingInput reads wallLineIds).
    this.unsub.push(bus.on('base:wallRow', ({ on }) => {
      const id = useApp.getState().selectedBuildingId;
      if (!id) return;
      if (on) this.selectWallLine(id); else this.clearWallLine();
      this.showSelection(id);
    }));
    this.unsub.push(bus.on('build:start', ({ type }) => this.startGhost(type)));
    this.unsub.push(bus.on('build:end', () => this.endGhost()));
    this.unsub.push(bus.on('battle:enter', ({
      snapshot, visualContext, boundCosmeticVisual, servicePresentation, advancedServicePresentation, armyLevels, armyCounts, heroLevels, scout,
    }) => {
      // The sleeping base does not draw its patrol during a raid. Destroy those
      // walkers before the sleep and reclaim only their unreferenced on-demand
      // atlases; tower groups still used by base sprites remain live. On return,
      // battle:exit emits base:refresh and the patrol is rebuilt from store.
      this.patrol.destroy();
      // The hold goes with the walkers, or the raid cannot reclaim the
      // garrison's locomotion sheets it was placed to protect.
      this.releasePatrolArtLease();
      releaseUnreferencedAtlases(this);
      // setScreen('battle') can make PhaserGame's opaque-screen subscriber
      // sleep us before this event arrives. Sleeping an already-sleeping scene
      // is harmless but Phaser warns on every raid transition, obscuring real
      // lifecycle faults in mobile diagnostics.
      if (this.scene.isActive('base')) this.scene.sleep('base');
      // Forward troop + hero levels so BattleScene sizes HP bars by the frozen
      // simulator inputs;
      // armyCounts so it skips downloading levelled-troop atlases the army has
      // zero units of; scout=true runs the same scene read-only (no deploy/combat).
      // boundCosmeticVisual is the raid's FROZEN Awning projection (C3): the
      // battle scene applies it to the frozen snapshot, never today's preference.
      // servicePresentation/advancedServicePresentation are the raid's FROZEN
      // berth siblings (P6a): forwarded untouched, never today's /base facts.
      this.scene.run('battle', {
        snapshot, visualContext, boundCosmeticVisual, servicePresentation, advancedServicePresentation, armyLevels, armyCounts, heroLevels, scout,
      });
    }));
    this.setupCameraInput();

    // A screen change MID-DRAG (a second finger on a React nav button — the
    // covers sit above the canvas) sleeps this scene via PhaserGame's
    // CANVAS_SCREENS subscription while the drag finger is still down; its
    // pointerup then lands on the React cover, so no input handler here ever
    // ends the drag. Without this, the lifted sprite AND the ambience hide()
    // (D3) both survive the nap. Sleep is therefore a drag end, and it takes
    // the same non-committing path an OS-cancelled release takes.
    const onSleep = (): void => {
      this.cancelPointerGesture();
      // A hidden base plays no journey: pending and in-flight ones are dropped (C5).
      this.cancelFleetJourneys();
    };
    this.events.on(Phaser.Scenes.Events.SLEEP, onSleep);
    this.unsub.push(() => this.events.off(Phaser.Scenes.Events.SLEEP, onSleep));
    // Generic React screens wake the scene directly (PhaserGame), without the
    // battle:exit `base:refresh` safety net. Rebuild from the authoritative
    // store on EVERY wake so a patrol destroyed before sleep cannot remain
    // absent, and a newly loaded full-V2 group can replace its eager fallback.
    const onWake = (): void => {
      this.renderFromStore();
      this.keepClock.resume();
    };
    this.events.on(Phaser.Scenes.Events.WAKE, onWake);
    this.unsub.push(() => this.events.off(Phaser.Scenes.Events.WAKE, onWake));

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.richArtLoadsStopped = true;
      const stopped = new Error('base scene shut down before rich art became interaction-idle');
      for (const waiter of this.interactionIdleWaiters) waiter.reject(stopped);
      this.interactionIdleWaiters.clear();
      this.unsub.forEach((u) => u());
      this.unsub = [];
      this.ambience?.destroy();
      this.patrol?.destroy();
      this.releasePatrolArtLease();
      this.jobs?.destroy();
      this.heroRecovery?.destroy();
      this.armyStatus?.destroy();
      this.keepClock?.destroy();
      this.wareBuildings.forEach((controller) => controller.destroy());
      this.wareTraps.forEach((controller) => controller.destroy());
      this.marketBuildings.forEach((controller) => controller.destroy());
      this.berthBuildings.forEach((controller) => controller.destroy());
      this.wallArt?.destroy();
      this.visualGate?.destroy();
      this.visualGate = undefined;
      this.wallArt = undefined;
      this.fantasyGround?.destroy();
      this.fantasyGround = undefined;
      this.wareBuildings.clear();
      this.wareTraps.clear();
      this.marketBuildings.clear();
      this.berthBuildings.clear();
      this.pendingJourneys?.clear();
      this.journeyArtWanted?.clear();
      this.journeyOutcomes?.clear();
      this.pendingArtIds.clear();

      this.clearClaimPerimeter();
      this.artRetryTimer?.remove(false);
      this.artRetryTimer = null;
      this.artRetryTimerDueAt = null;
      this.artRetryStates.clear();
      this.artRetryKeyByCandidate.clear();
      this.artRetryActiveKeys.clear();
      this.battleReleasedV2Buildings.clear();
      this.liftShadow?.destroy();
      this.liftShadow = null;
      // This scene only SLEEPS for a raid; a real shutdown means the world view
      // is gone (log-out / teardown), so its garrison + tower tier atlases are
      // no longer drawn by anything and their VRAM goes back. LAST, after the
      // layers above have destroyed the sprites that were holding them.
      releaseUnusedAtlases(this);
    });
  }

  /** Per-frame: drive job timers/bars + the builder walk lerp (read-app §6). */
  update(): void {
    if (this.wallArtDirty) {
      this.wallArtDirty = false;
      this.syncWallArt();
    }
    this.wallArt?.update();
    this.visualGate?.update(this.fantasyGround?.diagnostics, this.wallArt?.preparing ?? false,
      this.wallArt?.diagnostics.error, !!useApp.getState().base);
    // jobs use server epoch timestamps (startedAt/finishesAt) → wall-clock now.
    const now = Date.now();
    this.jobs?.update(now);
    this.heroRecovery?.update(now);
    this.armyStatus?.update(now);
    this.keepClock?.update();
    // Patrol actors walk on real elapsed time so their pace is framerate-independent.
    // Clamped: a backgrounded tab resumes with a huge delta, which would teleport
    // everyone across the base in one frame.
    const dt = this.lastUpdateMs === 0 ? 0 : Math.min(250, now - this.lastUpdateMs);
    this.lastUpdateMs = now;
    const reduceMotion = useApp.getState().reduceMotion;
    // Camp garrison wander + hero patrol share the world-walker seam (owner 2026-07-28).
    this.patrol?.update(dt, reduceMotion);

    // G4a ambient work bed: a soft hammer strike on a jittered beat while any
    // builder job runs. One-shots (playSfx gates on the SOUND FX toggle itself),
    // so nothing can loop unbounded; riding update() means a slept scene
    // (battle) goes silent for free. The dt clamp above also caps catch-up after
    // a backgrounded tab — at most one strike, never a burst.
    if (this.ambientBusy) {
      this.hammerInMs -= dt;
      if (this.hammerInMs <= 0) {
        playSfx('sfx_upgrade_hammer', { volume: AMBIENCE.hammerVolume });
        this.hammerInMs = AMBIENCE.hammerPeriodMs + Math.random() * AMBIENCE.hammerJitterMs;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Underlay: unboxed grass field + decorative outer skirt
  // -------------------------------------------------------------------------

  private drawUnderlay(): void {
    // One world-registered painting spans the plot; the skirt shares its
    // material. Selection/layout edits never modify this visual context.
    this.fantasyGround?.destroy();
    this.fantasyGround = new SceneGround(this, -SKIRT / T, (WORLD + SKIRT * 2) / T, T,
      () => this.visualGate?.loading(), () => this.restyleObstacles());
    this.fantasyGround.set(useApp.getState().base?.visualContext);
    this.fantasyGround.setClaim(useApp.getState().base?.claim);

    // Irregular outer clusters. Images are never interactive, so this remains
    // presentation only and cannot become authoritative obstacle state.
    for (const d of skirtDecor(WORLD, T)) {
      const [ax, ay] = this.meta[d.key]?.anchor ?? [0.5, 1];
      const image = this.add.image(d.x, d.y, atlasFor(d.key), d.key).setOrigin(ax, ay).setDepth(d.depth);
      this.fantasyGround.styleDecor(image, d.key);
    }
  }

  private drawClaimPerimeter(): void {
    this.clearClaimPerimeter();
    const base = useApp.getState().base;
    const claim = base?.claim;
    if (!claim) return;
    // Revision 5 (realm kit, REALM-KIT-PLAN §3): the terrain's own corner-Wang
    // edge ring IS the boundary, drawn by RealmKitGround from the same claim.
    // A dashed stroke and stones on top would double the boundary; revisions
    // ≤4 keep them because their paintings carry no claim.
    if (!claimPerimeterDrawn(base.visualContext)) return;
    const spec = claimPerimeter(claim, T, {
      dashMinTiles: BASE_CAMERA.claimPerimeterDashMinTiles,
      dashJitterTiles: BASE_CAMERA.claimPerimeterDashJitterTiles,
      gapMinTiles: BASE_CAMERA.claimPerimeterGapMinTiles,
      gapJitterTiles: BASE_CAMERA.claimPerimeterGapJitterTiles,
      wobbleTiles: BASE_CAMERA.claimPerimeterWobbleTiles,
      stoneOffsetTiles: BASE_CAMERA.claimPerimeterStoneOffsetTiles,
    });
    const line = this.add.graphics().setDepth(1);
    line.lineStyle(
      BASE_CAMERA.claimPerimeterLinePx,
      BASE_CAMERA.claimPerimeterColor,
      BASE_CAMERA.claimPerimeterAlpha,
    );
    for (const segment of spec.segments) {
      line.lineBetween(segment.x1, segment.y1, segment.x2, segment.y2);
    }
    this.claimPerimeterObjects.push(line);
    for (const stone of spec.stones) {
      const [ax, ay] = this.meta[stone.key]?.anchor ?? [0.5, 1];
      this.claimPerimeterObjects.push(
        this.add.image(stone.x, stone.y, atlasFor(stone.key), stone.key)
          .setOrigin(ax, ay).setDepth(stone.depth)
          .setAlpha(BASE_CAMERA.claimPerimeterStoneAlpha),
      );
    }
  }

  private clearClaimPerimeter(): void {
    this.claimPerimeterObjects.forEach((object) => object.destroy());
    this.claimPerimeterObjects = [];
  }

  // -------------------------------------------------------------------------
  // State → sprites
  // -------------------------------------------------------------------------

  private spriteKeyFor(b: BaseStateDto['buildings'][number]): string {
    if (b.type === 'wall') {
      // The accepted baseline is visible while the contextual neighborhood is
      // prepared; all steady-state walls use the scene's eight-neighbor pixels.
      return this.wallFrames.get(b.id) ?? wallFrameKey(b.level);
    }
    if (isWareTrapUnit(b.type)) {
      const spent = (b as { trapSpentAt?: string | null }).trapSpentAt != null;
      return spent
        ? wareTrapStateAliasKey(b.type, b.level, 'spent')
        : `bld_${b.type}_l${Math.min(20, b.level)}`;
    }
    // Hero altars ship ONE un-leveled master each (hero levels live on the hero).
    if (b.type === 'heroaltar' || b.type === 'siegestool') return `bld_${b.type}`;
    // Rework-v2 cannon/mortar (Phase D): once the tier's on-demand atlas is
    // registered, the building keys by its v2 idle master — the same
    // want-vs-grant gate the garrison art uses, so an in-flight (or failed)
    // load keeps rendering a truthful eager fallback instead of nothing.
    if ((ART_V2.buildings as readonly string[]).includes(b.type)) {
      const tier = artTierOfLevel(b.level);
      if (isV2AtlasLoaded(this, `v2bld_${b.type}_t${tier}`)) {
        return `v2_bld_${b.type}_t${tier}_idle_d0_f1`;
      }
      // Owner 2026-08-13: the superseded batch-13 Mortar may never flash while
      // this optional atlas loads. This eager alias is an exact pixel copy of
      // the protected V2 south-facing idle frame, not another interpretation.
      // Cannon joined on 2026-08-16 (owner: "old cannon loaded in assets in
      // campaign bases map") — its eager alias was still the legacy sprite.
      if (b.type === 'mortar' || b.type === 'cannon') {
        return v2BuildingFallbackFrameKey(b.type, tier, 1);
      }
    }
    // Phase E Market (C3) and the ordinary Workshop/Lodge (P5): keyed by the
    // selected family's resting cell — a Market's applied Awning once pe_cosmetics
    // is resident, else the family's ordinary tier art. The key names the family
    // for footprintOf/positionBuilding; the controller owns the texture itself
    // once its group lands (syncMarketController). A legacy sidecar (empty or
    // refused table) keeps the historical bld_ key below.
    if (marketArtFamilyOf(b.type)) {
      const rest = marketRestFrameKey(this.marketArt, this.marketChoiceFor(b));
      if (rest) return rest;
      // No legacy Harvester cells exist. Pending owner approval or unavailable
      // metadata leaves a tappable footprint, never the entire bld sheet.
      if (b.type === 'harvester') return HARVESTER_UNPRESENTED_KEY;
    }
    // Phase E berth (P4 starter, P6a advanced): a completed berth the server
    // names an installation for keys by its family's authored intact cell — a
    // frameless hidden footprint until that family's groups are resident, then
    // the controller owns the composition (ambient loop, docked/exhausted
    // vehicle). EVERY other berth state — explicit null, legacy, unavailable or
    // malformed facts, construction, a family without admitted art — is the
    // hidden frameless 2×2 footprint with normal selection geometry (D-c): the
    // ordinary sheet has no berth cell, so bld_berth_l<N> would draw the whole
    // packed sheet. An unavailable-art policy, never a vacancy claim.
    if (b.type === 'berth') return this.berthRestKeyFor(b) ?? BERTH_UNPRESENTED_KEY;
    // Every building type now ships L1–20 art (Phase 3 asset merge), so clamp to
    // the L20 art ceiling — the per-type {keep/mine/vault:5} caps + `?? 3` fallback
    // are dead. Clamping keeps any server level >20 on the L20 frame, not a gap.
    const lvl = Math.min(20, b.level);
    // M22's L1–20 Keep silhouette is canonical world art. The legacy L1–5 Keep
    // skins were fully removed from the game (M23 a8, refunded under D-009)
    // after M22 had already stopped rendering them over the rebuilt castle.
    return `bld_${b.type}_l${lvl}`;
  }

  /** Recompute every wall's auto-connected frame from its neighbours. */
  private recomputeWallFrames(buildings: BaseStateDto['buildings']): void {
    const walls = buildings
      .filter((b) => b.type === 'wall')
      .map((b) => ({ id: b.id, tx: b.tx, ty: b.ty, tier: b.level }));
    this.wallFrames = resolveWallFrames(walls);
  }

  /** All wall editing paths share the scene's authoritative/draft seating. The
   * compositor observes these positions without submitting gameplay changes. */
  private syncWallArt(): void {
    if (!this.wallArt) return;
    const base = useApp.getState().base;
    if (!base) return;
    const carried = new Map(this.carriedPieces().map((row) => [row.id, row.sprite]));
    const moving = new Set(carried.keys());
    const positions = new Map(base.buildings.flatMap(building => {
      if (this.layoutDraft?.trayIds.has(building.id)) return [];
      const position = this.layoutDraft
        ? this.layoutDraft.positions.get(building.id)
        : this.settlingMoves.get(building.id) ?? building;
      return position ? [[building.id, position] as const] : [];
    }));
    // Visual occupancy must use the same draft/settling snapshot as pixels.
    // Server-coordinate placement validation remains unchanged; this only
    // separates invalid carried previews from the stationary wall material.
    const invalidCarry = base.buildings.some(building => {
      const lifted = carried.get(building.id);
      if (building.type !== 'wall' || !lifted || !positions.has(building.id)) return false;
      const tx = Math.round(lifted.x / T - 0.5), ty = Math.round((lifted.y + LIFT) / T - 1);
      if (tx < base.claim.min || ty < base.claim.min || tx + 1 > base.claim.max || ty + 1 > base.claim.max) return true;
      const hit = (atx: number, aty: number, width: number, height: number): boolean =>
        tx < atx + width && atx < tx + 1 && ty < aty + height && aty < ty + 1;
      for (const other of base.buildings) {
        if (moving.has(other.id)) continue;
        const at = positions.get(other.id);
        if (!at) continue;
        const fp = other.type === 'wall' ? { fw: 1, fh: 1 } : this.footprintOf(this.spriteKeyFor(other));
        if (hit(at.tx, at.ty, fp.fw, fp.fh)) return true;
      }
      return base.obstacles.some(obstacle => {
        const size = this.meta[`dec_${obstacle.spriteKey}`]?.footprint?.[0] ?? 1;
        return hit(obstacle.tx, obstacle.ty, size, size);
      });
    });
    const inputs: WallSpriteInput[] = [];
    for (const building of base.buildings) {
      if (building.type !== 'wall') continue;
      const sprite = this.buildingSprites.get(building.id);
      const position = positions.get(building.id);
      if (!sprite || !position) continue;
      const lifted = carried.get(building.id);
      const tx = lifted ? Math.round(lifted.x / T - 0.5) : position.tx;
      const ty = lifted ? Math.round((lifted.y + LIFT) / T - 1) : position.ty;
      inputs.push({ id: building.id, tx, ty, level: building.level, sprite,
        ...(lifted && invalidCarry ? { detached: true } : {}),
      });
    }
    const ghost = this.ghost;
    if (ghost?.type === 'wall' && !ghost.valid && isContextWallFrame(ghost.sprite.frame.name)) {
      const frame = wallFrameKey(1);
      ghost.sprite.setTexture(atlasFor(frame), frame);
      this.positionLiftedBuilding(ghost.sprite, ghost.tx, ghost.ty, ghost.fp);
    }
    if (ghost?.type === 'wall' && ghost.valid) {
      inputs.push({ id: '__wall_ghost__', tx: ghost.tx, ty: ghost.ty, level: 1, sprite: ghost.sprite });
    }
    this.wallArt.sync(inputs);
  }

  private footprintOf(key: string): Footprint {
    // Rework-v2 keys are absent from meta.sprites, and the pack's own visual
    // footprint is [2,2] for BOTH units — but the GAME footprint is the sim's
    // (locked owner decision: cannon stays 1×1, the sprite overhangs). The
    // shared table answers so occupancy/placement can never widen a cannon.
    const v2 = /^v2_(?:fallback_)?bld_([a-z]+)_t\d+_/.exec(key);
    if (v2) {
      const fp = V2_BLD_FOOTPRINT[v2[1]!];
      if (fp) return { fw: fp[0], fh: fp[1] };
    }
    // Phase E Market/Awning frames are absent from meta.sprites too; the pack's
    // visual footprint happens to match, but the GAME footprint is the shared
    // table's, so occupancy can never follow an art change.
    const frameFamily = marketFrameFamily(key);
    if (frameFamily) {
      const [fw, fh] = STRUCTURES[frameFamily].footprint;
      return { fw, fh };
    }
    if (STARTER_FLEET_FRAME_KEY.test(key) || ADVANCED_FLEET_FRAME_KEY.test(key) || key === BERTH_UNPRESENTED_KEY) {
      const [fw, fh] = STRUCTURES.berth.footprint;
      return { fw, fh };
    }
    const fp = this.meta[key]?.footprint;
    return fp ? { fw: fp[0], fh: fp[1] } : { fw: 1, fh: 1 };
  }

  /**
   * Logical occupancy belongs to the positioned building, not its current art
   * frame. WARE controllers replace eager aliases with rich animation frames
   * whose names are intentionally absent from meta.sprites; recomputing from
   * one of those frames silently collapses a 2x2 building to the 1x1 fallback.
   */
  private positionedFootprint(sprite: Phaser.GameObjects.Sprite): Footprint {
    const fw = sprite.getData('fw') as number | undefined;
    const fh = sprite.getData('fh') as number | undefined;
    if (Number.isFinite(fw) && Number.isFinite(fh) && fw! > 0 && fh! > 0) {
      return { fw: fw!, fh: fh! };
    }
    // A sprite reaches input/selection only after positionBuilding. Keep a
    // defensive fallback for recovery snapshots, but make that broken ordering
    // visible instead of quietly changing gameplay occupancy.
    console.error('[BaseScene] positioned sprite is missing its logical footprint', {
      buildingId: sprite.getData('buildingId'),
      frame: sprite.frame.name,
    });
    return this.footprintOf(sprite.frame.name);
  }

  /** One seating contract for rest, placement ghosts, and live building drags. */
  private buildingSeat(frame: string): BuildingSeat {
    if (isContextWallFrame(frame)) return { origin: [0.5, 1], scale: 2, offsetGamePx: [0, 0] };
    const seat = v2BldSeat(this.v2meta.clips, frame)
      ?? wareSeat(this.waremeta.clips, frame)
      ?? marketSeat(this.marketArt, frame)
      ?? starterFleetSeat(this.starterFleetArt, frame)
      ?? advancedFleetSeat(this.advancedFleetArt, frame);
    const meta = this.meta[frame];
    // Stable WARE aliases are copied into an eager atlas without resizing.
    // Convert their authored-source factor through that atlas's pixel density;
    // rich @1x clips already publish their complete world scale via wareSeat.
    const eagerScale = meta?.sourceScale === undefined
      ? 1
      : V2_DRAW_SCALE * meta.sourceScale / eagerAtlasScale(atlasFor(frame));
    const seatOffset = (seat as { offsetGamePx?: readonly [number, number] } | null)
      ?.offsetGamePx;
    return {
      origin: seat?.origin ?? meta?.anchor ?? [0.5, 1],
      scale: seat?.scale ?? eagerScale,
      offsetGamePx: seatOffset ?? meta?.offsetGamePx ?? [0, 0],
    };
  }

  private wareGroupForBuilding(b: BaseStateDto['buildings'][number]): string | null {
    if (isWareBuildingUnit(b.type)) return wareBuildingAtlasGroup(b.type, b.level);
    if (isWareTrapUnit(b.type)) return wareTrapAtlasGroup(b.type, b.level);
    return null;
  }

  private destroyWareController(id: string): void {
    this.wareBuildings.get(id)?.destroy();
    this.wareTraps.get(id)?.destroy();
    this.wareBuildings.delete(id);
    this.wareTraps.delete(id);
  }

  /** The Market family to draw: its applied Awning while pe_cosmetics is
   * resident, otherwise the ordinary tier art (the resident-or-not gate keeps
   * ordinary art as the fallback while the cosmetics group loads or is refused).
   * The tier is the COMPLETED level's; a queued upgrade never selects the next. */
  private marketChoiceFor(b: Pick<BaseStateDto['buildings'][number], 'id' | 'level' | 'type'>): MarketArtChoice {
    const family = marketArtFamilyOf(b.type) ?? 'market';
    const tier = marketArtTierOfLevel(b.level, family);
    if (family === 'harvester') return { family, tier, awning: null,
      realm: resolveBaseVisualContext(useApp.getState().base?.visualContext).realmId };
    // Awnings are Market-only: a Workshop or Lodge never consults the projection.
    const awning = family === 'market' ? this.marketAwnings.get(b.id) ?? null : null;
    if (awning && isV2AtlasLoaded(this, AWNING_ATLAS_GROUP)
      && marketRestFrameKey(this.marketArt, { family, tier, awning })) {
      return { family, tier, awning };
    }
    return { family, tier, awning: null };
  }

  /** The authored intact cell of the family the server names for a completed
   *  berth (resident or not — the sprite stays hidden until it is); null for
   *  every unpresented state, which the caller keys as BERTH_UNPRESENTED_KEY. */
  private berthRestKeyFor(b: Pick<BaseStateDto['buildings'][number], 'id' | 'underConstruction'>): string | null {
    const installation = this.berthInstallationFor(b);
    if (!installation) return null;
    return installation.family === 'starter'
      ? berthRestFrameKey(this.starterFleetArt)
      : advancedBerthFrameKey(this.advancedFleetArt, installation.family);
  }

  /** The named installation of a COMPLETED berth, or null (construction never presents). */
  private berthInstallationFor(b: Pick<BaseStateDto['buildings'][number], 'id' | 'underConstruction'>): BerthInstallation | null {
    if (b.underConstruction) return null;
    return this.berthFacts.berths.get(b.id) ?? null;
  }

  /** The composition a berth's installation selects, null when its family (or
   *  tier) has no admitted art — then the berth is unpresented (D-c). */
  private berthCompositionFor(b: Pick<BaseStateDto['buildings'][number], 'id' | 'underConstruction'>): { composition: BerthComposition; presence: BerthPresence } | null {
    const installation = this.berthInstallationFor(b);
    if (!installation) return null;
    const composition = berthCompositionFor(installation, this.starterFleetArt, this.advancedFleetArt);
    return composition ? { composition, presence: installation.presence } : null;
  }

  /** Every group the berth's composition draws from for its presence is resident. */
  private berthArtResident(b: Pick<BaseStateDto['buildings'][number], 'id' | 'underConstruction'>): boolean {
    const selected = this.berthCompositionFor(b);
    return selected !== null && berthCompositionGroups(selected.composition, selected.presence).every((group) => isV2AtlasLoaded(this, group));
  }

  private destroyBerthController(id: string): void {
    this.berthBuildings.get(id)?.destroy();
    this.berthBuildings.delete(id);
  }

  /** Grant a completed berth its presentation controller once every group its
   * composition draws from is resident and the server names an installation
   * for it. Home only: an initial build keeps the hidden footprint; a current
   * upgrade keeps the controller (the Market precedent — a docked vehicle never
   * vanishes into an empty-looking berth); a presence change is handed to the
   * live controller; a family/tier change is a new signature (the refresh loop
   * rebuilt it); nothing is invented from a missing, null or foreign fact. */
  private syncBerthController(
    b: BaseStateDto['buildings'][number],
    sprite: Phaser.GameObjects.Sprite,
  ): void {
    if (b.type !== 'berth') return;
    const selected = this.berthCompositionFor(b);
    if (!selected || !this.berthArtResident(b)) {
      if (!selected) { this.pendingJourneys?.delete(b.id); this.journeyOutcomes?.delete(b.id); } // unpresented: nothing to play (C5)
      this.destroyBerthController(b.id);
      return;
    }
    let controller = this.berthBuildings.get(b.id);
    if (!controller) {
      this.ticker.unregister(sprite);
      controller = new BerthBuildingFx({
        ticker: this.wareTicker,
        composition: selected.composition,
        presence: selected.presence,
        restLoopSpeed: AMBIENCE.baseBuildingLoopSpeed,
        reducedMotion: reduceMotionOn(),
        // The vehicle, gate effect and Wake are scene-owned, non-interactive art on their own groups.
        addVehicle: (atlas) => this.add.sprite(0, 0, atlas),
        addEffect: (atlas) => this.add.sprite(0, 0, atlas),
      }, sprite);
      this.berthBuildings.set(b.id, controller);
    }
    controller.setPresence(this.restPresenceFor(b.id, selected.presence));
    // C5: play the pending journey once EVERY group it draws from is resident;
    // until then it waits (the candidate loop requested those groups).
    const plan = this.pendingJourneyPlanFor(b);
    if (!plan) return;
    if (!journeyPlanGroups(selected.composition, plan).every((group) => isV2AtlasLoaded(this, group))) return;
    const pending = this.pendingJourneys.get(b.id)!;
    this.pendingJourneys.delete(b.id);
    const outcome = journeyOutcomePresence(plan.kind); // departures only; a return's snapshot already carries the post-settlement fact
    if (controller.playJourney(plan) && outcome) {
      (this.journeyOutcomes ??= new Map()).set(b.id, { snapshot: pending.snapshot, presence: outcome });
    }
  }

  /** The presence a berth rests on: the server's, unless the store base is still the
   *  very snapshot a played journey arrived with — that snapshot predates the accepted
   *  event (a departure's still says occupied), so the event's outcome stands until a
   *  genuinely newer snapshot (ordinary refresh, actual return) replaces it. */
  private restPresenceFor(berthId: string, serverPresence: BerthPresence): BerthPresence {
    const outcome = this.journeyOutcomes?.get(berthId);
    if (!outcome) return serverPresence;
    if (useApp.getState().base === outcome.snapshot) return outcome.presence;
    this.journeyOutcomes.delete(berthId); // a newer snapshot controls rest again
    return serverPresence;
  }

  /** C5: root's producer published ONE fresh departure/return. Only THIS base's
   *  events for a complete, presented berth are kept, each key once; nothing is
   *  inferred from presence, receipts or reloads. An event that lands while the
   *  base is off-canvas (an opaque screen, a hidden document) is dropped and never
   *  replayed; it only leaves its art request behind. Otherwise the render pass
   *  admits the art and plays, within the journey's own live duration. */
  private onFleetJourney(event: FleetJourneyEvent): void {
    const base = useApp.getState().base;
    if (!base || !base.baseId || base.baseId !== event.baseId) return;
    const key = fleetJourneyEventKey(event);
    const seen = (this.seenJourneyKeys ??= new Set<string>());
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 256) seen.delete(seen.values().next().value as string);
    const row = base.buildings.find((b) => b.id === event.berthId && b.type === 'berth' && !b.underConstruction);
    if (!row) return;
    const installation = this.berthInstallationFor(row);
    const selected = this.berthCompositionFor(row);
    const plan = installation && selected
      ? journeyPlanFor(event, installation, this.starterFleetArt, this.advancedFleetArt, this.marketArt) : null;
    if (!plan || !selected) return;
    (this.journeyArtWanted ??= new Map<string, readonly string[]>()).set(row.id, journeyPlanGroups(selected.composition, plan));
    if (!this.journeyCanvasVisible()) {
      this.renderFromStore(); // request the art for the next event; this one is gone
      return;
    }
    // The deferred event keeps the exact snapshot/session it arrived with: a newer
    // same-base snapshot, another wallet/selection, a hidden document or an inactive
    // canvas before play drops it (re-checked at consumption, not only here).
    (this.pendingJourneys ??= new Map()).set(row.id, {
      event, deadline: Date.now() + journeyDurationMs(plan), snapshot: base, guard: captureBaseSnapshotGuard(),
    });
    this.renderFromStore();
  }

  /** The base canvas is the active scene of a visible document. */
  private journeyCanvasVisible(): boolean {
    return this.scene.isActive('base')
      && !(typeof document !== 'undefined' && document.visibilityState === 'hidden');
  }

  /** C5 lifecycle (R3): a hidden document, a page transition, the Page Lifecycle
   *  freeze or another session/base scope invalidates pending AND in-flight journeys
   *  (the visibility handlers do not necessarily sleep Phaser). `pagehide` targets
   *  window and does not bubble to document; `visibilitychange`/`freeze` are
   *  document events. Every listener is removed with the scene. */
  private attachJourneyLifecycle(): void {
    if (typeof document !== 'undefined') {
      const onVisibility = (): void => this.onDocumentVisibility();
      const onFreeze = (): void => this.cancelFleetJourneys();
      document.addEventListener('visibilitychange', onVisibility);
      document.addEventListener('freeze', onFreeze);
      this.unsub.push(() => document.removeEventListener('visibilitychange', onVisibility));
      this.unsub.push(() => document.removeEventListener('freeze', onFreeze));
    }
    if (typeof window !== 'undefined') {
      const onPageHide = (): void => this.cancelFleetJourneys();
      window.addEventListener('pagehide', onPageHide);
      this.unsub.push(() => window.removeEventListener('pagehide', onPageHide));
    }
    this.unsub.push(useApp.subscribe((state, prev) => this.onSessionChange(state, prev)));
  }

  /** Document hidden: pending and in-flight journeys end now; showing again replays nothing. */
  private onDocumentVisibility(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') this.cancelFleetJourneys();
  }

  /** Session/base SCOPE changes end pending, in-flight and the art requests: another
   *  wallet, another selected base, a selection epoch advance (a deed switch beginning,
   *  a same-wallet setAuth or clearBaseSnapshot — ordinary reloads reuse the captured
   *  guard and never advance it), or the base cleared. An ordinary same-base snapshot
   *  replacement (the poll: same wallet/selection/epoch, a new non-null base object)
   *  is NOT a scope change — it only drops PENDING events at consumption, while an
   *  already-valid in-flight journey completes on the latest presence. */
  private onSessionChange(
    state: { wallet: string | null; selectedBaseId: string | null; baseSelectionEpoch: number; base: BaseStateDto | null },
    prev: { wallet: string | null; selectedBaseId: string | null; baseSelectionEpoch: number; base: BaseStateDto | null },
  ): void {
    const scopeChanged = state.wallet !== prev.wallet
      || state.selectedBaseId !== prev.selectedBaseId
      || state.baseSelectionEpoch !== prev.baseSelectionEpoch
      || (state.base === null && prev.base !== null);
    if (scopeChanged) this.cancelFleetJourneys(true);
  }

  /** The authored plan the berth's pending journey selects for its CURRENT
   *  installation, or null — an event whose vehicle is not this installation
   *  (family/tier), whose family has no admitted track, whose own live duration
   *  has passed while its art was still loading, or whose snapshot/session/visible
   *  canvas is no longer the one it arrived with, is dropped — never mapped onto
   *  another family's path and never replayed later. */
  private pendingJourneyPlanFor(b: Pick<BaseStateDto['buildings'][number], 'id' | 'underConstruction'>): JourneyPlan | null {
    const pending = this.pendingJourneys?.get(b.id);
    if (!pending) return null;
    // Continuity: the same committed snapshot object, wallet and selection as at
    // receipt, still within the live second, on a visible active canvas.
    const live = useApp.getState().base === pending.snapshot && isBaseSnapshotGuardCurrent(pending.guard)
      && Date.now() <= pending.deadline && this.journeyCanvasVisible();
    const installation = live ? this.berthInstallationFor(b) : null;
    const plan = installation
      ? journeyPlanFor(pending.event, installation, this.starterFleetArt, this.advancedFleetArt, this.marketArt) : null;
    if (!plan) this.pendingJourneys.delete(b.id);
    return plan;
  }

  /** Drop pending and in-flight journeys (sleep, logout, base change); with
   *  `forgetArt` the standing art requests go too. */
  private cancelFleetJourneys(forgetArt = false): void {
    this.pendingJourneys?.clear();
    if (forgetArt) { this.journeyArtWanted?.clear(); this.journeyOutcomes?.clear(); }
    this.berthBuildings?.forEach((controller) => controller.cancelJourney());
  }

  private destroyMarketController(id: string): void {
    this.marketBuildings.get(id)?.destroy();
    this.marketBuildings.delete(id);
  }

  /** Grant a Market its presentation controller once the selected family is
   * resident. Home states only: idle, or the tier's construction scaffold for
   * an initial build / current upgrade. No Market work or readiness is invented. */
  private syncMarketController(
    b: BaseStateDto['buildings'][number],
    sprite: Phaser.GameObjects.Sprite,
    jobKind: string | null,
  ): void {
    if (!marketArtFamilyOf(b.type)) return;
    const choice = this.marketChoiceFor(b);
    if (!isV2AtlasLoaded(this, marketArtGroup(choice))
      || !marketRestFrameKey(this.marketArt, choice)) return;
    let controller = this.marketBuildings.get(b.id);
    if (!controller) {
      this.ticker.unregister(sprite);
      controller = new MarketBuildingFx({
        ticker: this.wareTicker,
        art: this.marketArt,
        choice,
        restLoopSpeed: AMBIENCE.baseBuildingLoopSpeed,
        reducedMotion: reduceMotionOn(),
      }, sprite);
      this.marketBuildings.set(b.id, controller);
    }
    controller.setJob(b.underConstruction ? 'build' : jobKind);
  }

  private syncWareController(
    b: BaseStateDto['buildings'][number],
    sprite: Phaser.GameObjects.Sprite,
    jobKind: string | null,
  ): void {
    // The contextual wall layer owns every tier, connection and damage state.
    if (b.type === 'wall') return;
    const group = this.wareGroupForBuilding(b);
    if (!group || !isV2AtlasLoaded(this, group)) return;
    if (isWareBuildingUnit(b.type)) {
      let controller = this.wareBuildings.get(b.id);
      if (!controller) {
        this.ticker.unregister(sprite);
        controller = new WareBuildingFx({
          ticker: this.wareTicker,
          clips: this.waremeta.clips,
          unit: b.type,
          level: b.level,
          restLoopSpeed: AMBIENCE.baseBuildingLoopSpeed,
        }, sprite);
        this.wareBuildings.set(b.id, controller);
      }
      controller.setJob(jobKind);
      // These are operating resource buildings, matching the always-alive
      // ambience they had before M22; their authored work loop replaces the
      // retired `<legacy>_work_f1` overlay exactly.
      controller.setWorking(jobKind === null
        && (b.type === 'mine' || b.type === 'forge' || b.type === 'goldforge'));
      return;
    }
    if (isWareTrapUnit(b.type)) {
      const spent = (b as { trapSpentAt?: string | null }).trapSpentAt != null;
      let controller = this.wareTraps.get(b.id);
      if (!controller) {
        this.ticker.unregister(sprite);
        controller = new WareTrapFx({
          ticker: this.wareTicker,
          clips: this.waremeta.clips,
          unit: b.type,
          level: b.level,
        }, sprite, true, spent);
        this.wareTraps.set(b.id, controller);
      }
      controller.setSpent(spent);
      return;
    }
  }

  renderFromStore(): void {
    const base = useApp.getState().base;
    if (!base) {
      this.cancelFleetJourneys(true); // logout: no journey survives the session (C5)
      return;
    }
    this.wallArtDirty = true;
    if (!supportedPlotVersion(base.plotVersion)) {
      this.cancelPointerGesture();
      this.visualGate?.update({ state: 'failed' }, false);
      return;
    }
    this.fantasyGround?.set(base.visualContext);
    this.fantasyGround?.setClaim(base.claim);
    const identity = base.baseId ?? base.player.wallet;
    if (this.lastBaseIdentity && this.lastBaseIdentity !== identity) {
      this.userMovedCamera = false;
      this.cancelFleetJourneys(true); // another base: no journey or art request crosses over (C5)
    }
    this.lastBaseIdentity = identity;
    const jobByBuilding = new Map(
      base.jobs.flatMap((job) => job.buildingId ? [[job.buildingId, job] as const] : []),
    );
    const busyIds = new Set(jobByBuilding.keys());
    // Phase E Awnings (C3): the server's current projection alone decides which
    // Market wears one; legacy absence, a verified empty visual and a refused or
    // unavailable read all draw ordinary Market art.
    this.marketAwnings = selectMarketAwnings(this.marketArt, base.boundCosmetics, base.buildings).awnings;
    // Phase E berths (P4 starter, P6a advanced): the server's two current
    // siblings alone decide which berth shows which installation; legacy
    // absence keeps every berth unpresented quietly, a null field, a malformed
    // sibling, an inconsistent closure or two positive installations on one
    // berth refuse the whole presentation (every berth unpresented, flagged).
    this.berthFacts = selectCurrentBerths(base.servicePresentation, base.advancedServicePresentation, base.buildings);
    // C5: a journey waits only for a berth row that still exists and is complete.
    for (const berthId of this.pendingJourneys?.keys() ?? []) {
      if (!base.buildings.some((b) => b.id === berthId && b.type === 'berth' && !b.underConstruction)) this.pendingJourneys.delete(berthId);
    }
    for (const berthId of this.journeyOutcomes?.keys() ?? []) {
      if (!base.buildings.some((b) => b.id === berthId && b.type === 'berth')) this.journeyOutcomes.delete(berthId);
    }
    // Idle ground stays unboxed. A claim change still re-frames the camera and
    // refreshes the transient grid when the player is actively choosing tiles.
    const claimKey = `${identity}:${base.plotVersion ?? 1}:${base.claim.min},${base.claim.max}`;
    if (claimKey !== this.lastClaimKey) {
      this.lastClaimKey = claimKey;
      this.drawClaimPerimeter();
      if (this.ghost || this.drag?.moved || this.layoutDraft) this.drawPlacementGrid();
      if (this.userMovedCamera) this.rebandCamera(); else this.fitCamera();
    }
    this.recomputeWallFrames(base.buildings); // walls auto-connect before keying
    // A live move gesture, not the store, owns where its pieces sit — see
    // reseatCarriedPieces, which restores their seat once this pass is done.
    const carried = new Set(this.carriedPieces().map((w) => w.id));
    for (const id of this.settlingMoves.keys()) carried.add(id);
    const seen = new Set<string>();

    for (const b of base.buildings) {
      const key = this.spriteKeyFor(b);
      seen.add(b.id);
      let sprite = this.buildingSprites.get(b.id);
      const wareGroup = this.wareGroupForBuilding(b);
      const priorWareGroup = sprite?.getData('wareAtlasGroup') as string | undefined;
      if (sprite && priorWareGroup && priorWareGroup !== wareGroup) {
        this.destroyWareController(b.id);
      }
      // A Market's family signature (group + resting cell): a tier change, an
      // Awning applied/removed, or the cosmetics group arriving rebuilds the
      // controller so the texture switches exactly once per pass.
      const marketKey = marketArtFamilyOf(b.type) !== null && (MARKET_FRAME_KEY.test(key) || key === HARVESTER_UNPRESENTED_KEY) ? `${atlasFor(key)}:${key}` : null;
      const priorMarketKey = sprite?.getData('marketArtKey') as string | undefined;
      if (sprite && priorMarketKey !== undefined && priorMarketKey !== marketKey) {
        this.destroyMarketController(b.id);
      }
      // A berth's presentation signature (group + resting cell + family/tier):
      // the art leaving, a family or an applied tier changing rebuilds the
      // controller once; a presence change between refreshes is handed to the
      // live controller (setPresence), never a rebuild. Unpresented berths carry
      // the hidden-footprint signature and never a controller.
      const berthInstallation = b.type === 'berth' ? this.berthInstallationFor(b) : null;
      const berthKey = b.type === 'berth'
        ? `${berthKeyGroup(key)}:${key}:${berthInstallation ? `${berthInstallation.family}:${'tier' in berthInstallation ? berthInstallation.tier : 0}` : 'unpresented'}`
        : null;
      const priorBerthKey = sprite?.getData('berthArtKey') as string | undefined;
      if (sprite && priorBerthKey !== undefined && priorBerthKey !== berthKey) {
        this.destroyBerthController(b.id);
      }
      // A controller owns its sprite's texture; the refresh loop must not re-key it.
      const hasWareController = this.wareBuildings.has(b.id)
        || this.wareTraps.has(b.id)
        || this.marketBuildings.has(b.id)
        || this.berthBuildings.has(b.id);
      // No eager Market/berth still exists: a body whose family is not yet
      // resident (or a berth with no admitted appearance, ever) gets a frameless
      // (hidden) sprite rather than a missing-frame request into a sheet.
      const artResident = key !== HARVESTER_UNPRESENTED_KEY && (marketKey === null || isV2AtlasLoaded(this, atlasFor(key)))
        && (berthKey === null || this.berthArtResident(b));
      // A fleet key names its packed group directly (the table's own), never a routed guess.
      const keyAtlas = berthKey ? berthKeyGroup(key) ?? atlasFor(key) : atlasFor(key);
      if (!sprite) {
        sprite = artResident
          ? this.add.sprite(0, 0, keyAtlas, key)
          : this.add.sprite(0, 0, keyAtlas);
        sprite.setData('buildingId', b.id);
        this.attachBuildingInput(sprite);
        this.buildingSprites.set(b.id, sprite);
      } else if (b.type !== 'wall' && !hasWareController && artResident && sprite.frame.name !== key) {
        sprite.setTexture(keyAtlas, key); // upgrades swap the master (HANDOFF §5.3)
      }
      if (wareGroup) sprite.setData('wareAtlasGroup', wareGroup);
      if (marketKey) sprite.setData('marketArtKey', marketKey);
      if (berthKey) sprite.setData('berthArtKey', berthKey);
      // Structure tie kind, decided ONCE from the authoritative row and carried on
      // the sprite: positionBuilding is also reached from drag/lift/settle paths
      // that only have the sprite, and the frame name stops saying "wall" the
      // moment a WARE controller re-keys the texture.
      sprite.setData('structureKind', b.type === 'wall' ? 'wall' : 'building');
      if ((ART_V2.buildings as readonly string[]).includes(b.type)) {
        const tier = artTierOfLevel(b.level);
        sprite.setData('v2AtlasGroup', `v2bld_${b.type}_t${tier}`);
        // Both protected towers now carry a truthful current-art eager still
        // (Cannon joined the v2fallback atlas 2026-08-16), so releasing rich
        // art for a battle re-keys instead of hiding either of them.
        sprite.setData(
          'v2FallbackFrame',
          v2BuildingFallbackFrameKey(b.type as 'cannon' | 'mortar', tier, 1),
        );
      }
      const waitingForCurrent = this.battleReleasedV2Buildings.has(b.id);
      if (waitingForCurrent && key.startsWith('v2_bld_')) {
        this.battleReleasedV2Buildings.delete(b.id);
        sprite.setVisible(true);
      } else {
        sprite.setVisible(!waitingForCurrent);
      }
      this.syncWareController(b, sprite, jobByBuilding.get(b.id)?.kind ?? null);
      this.syncMarketController(b, sprite, jobByBuilding.get(b.id)?.kind ?? null);
      this.syncBerthController(b, sprite);
      // A Market is visible only through its controller (no eager still); while
      // pending it stays a tappable footprint (footprintObjectAt).
      if (marketKey || berthKey) {
        const resident = marketKey ? this.marketBuildings.has(b.id) : this.berthBuildings.has(b.id);
        sprite.setVisible(resident);
        const pending = (this.pendingArtIds ??= new Set<string>());
        if (resident) pending.delete(b.id); else pending.add(b.id);
      }
      if (!carried.has(b.id)) {
        this.positionBuilding(sprite, b.tx, b.ty, this.footprintOf(key));
        sprite.setAlpha(b.underConstruction ? 0.75 : 1);
      }
      if (b.type === 'keep') this.keepClock?.sync(b.id, sprite, b.level);
    }
    // obstacles render non-interactive (clear flow comes with the action sheets)
    const clearing = new Set(base.jobs.flatMap((job) => job.obstacleId ? [job.obstacleId] : []));
    for (const o of base.obstacles) {
      const id = `obs-${o.id}`;
      seen.add(id);
      const existing = this.buildingSprites.get(id);
      if (existing) {
        this.styleObstacle(existing, o, clearing.has(o.id));
      } else {
        // server keys mirror the App's OBS_TYPES; two differ from asset names
        const key = obstacleDecKey(o.spriteKey);
        const img = this.add.sprite(0, 0, atlasFor(key), this.meta[key] ? key : 'dec_rock_s');
        this.styleObstacle(img, o, clearing.has(o.id));
        img.setData('obstacleId', o.id);
        // tap an obstacle → clear sheet (HANDOFF §3.9). A stationary press
        // suppresses pan; over-threshold movement promotes to camera pan below.
        // The tap only commits if the press STARTED on THIS obstacle and the
        // pointer barely moved — so a camera-pan release that happens to land on
        // an obstacle, or a tap begun on a building/empty ground, never selects
        // it (R2; App obsDown is a pure pointerdown toggle, read-app §1/§8).
        this.attachObstacleInput(img, o.id);
        this.buildingSprites.set(id, img);
      }
    }
    // remove sprites whose rows vanished (cleared obstacles, …)
    for (const [id, s] of this.buildingSprites) {
      if (!seen.has(id)) {
        // A raid or a clear can delete a piece the player is still holding.
        // End the gesture while its sprites are all alive: nothing may carry —
        // or later reseat — a destroyed object, and no move may be committed
        // for a building the server no longer has.
        if (carried.has(id)) this.cancelDrag();
        this.destroyWareController(id);
        this.destroyMarketController(id);
        this.destroyBerthController(id);
        this.pendingArtIds?.delete(id);
        this.keepClock?.remove(id);
        s.destroy();
        this.buildingSprites.delete(id);
        this.battleReleasedV2Buildings.delete(id);
      }
    }

    // decorative ambience (mine work-swap, altar pulse, chimney smoke) +
    // builder job visuals (scaffold, timer chip, walking builder).
    const keyOf = (b: BaseStateDto['buildings'][number]): string => this.spriteKeyFor(b);
    const fpOf = (k: string): Footprint => this.footprintOf(k);
    const keep = base.buildings.find((b) => b.type === 'keep');
    // The ONE height-derived value in this scene, and it has to stay measured off
    // the LIVE SPRITE rather than off the footprint: base art routinely towers
    // over the ground it stands on, and batch 13 pushed that further (an L20
    // archer tower is 137 game px — 4.3 tiles — on a ONE-tile footprint, and the
    // keep's L20 master is 232 on a 2×2). A footprint-derived "top" would put
    // anything floated above a building inside its own art.
    // Everything else the scene places is footprint- or anchor-derived and so
    // needed no retune for the taller towers (verified 2026-08-03): positionBuilding
    // (origin + bottom-edge depth), isValidSpot/wallSpotFreeIgnoring/occ.rebuild,
    // the placement grid, footprint tint, lift shadow, dust puffs, the selection
    // brackets and the range/deadzone rings.
    const topOf = (id: string): number | undefined => {
      const s = this.buildingSprites.get(id);
      return s ? s.y - s.displayHeight : undefined; // bottom-anchored sprite top edge
    };
    // Buildings with work in flight — drives chimney smoke and extra footfall, so
    // "alive" tracks what the player is actually doing (G2a/G1d).
    // G4a: the hammer bed keys off ANY running job (incl. obstacle clears, which
    // have no buildingId) — the sound of work, not of a specific building.
    this.ambientBusy = base.jobs.length > 0;
    if (!this.ambientBusy) this.hammerInMs = 0; // next busy spell strikes promptly
    // What is STANDING on the plot, for the walking layers (owner 2026-07-29:
    // walkers must not path into buildings/walls). Under-construction buildings
    // block too — the scaffold occupies the tile as surely as the finished
    // building does. Derived from the same rows the sprites came from, so the
    // grid can never disagree with what the player sees.
    this.occ.rebuild([
      ...base.buildings.map((b) => {
        const fp = this.footprintOf(this.spriteKeyFor(b));
        return { tx: b.tx, ty: b.ty, fw: fp.fw, fh: fp.fh };
      }),
      ...base.obstacles.map((o) => {
        const size = this.meta[`dec_${o.spriteKey}`]?.footprint?.[0] ?? 1;
        return { tx: o.tx, ty: o.ty, fw: size, fh: size };
      }),
    ], base.plotVersion);
    this.syncRemnants(base);
    this.ambience.sync(base.buildings, fpOf, keyOf, topOf, busyIds);
    this.heroRecovery.sync(
      base.heroes ?? [], base.buildings,
      (building) => this.footprintOf(this.spriteKeyFor(building)),
    );
    this.armyStatus?.sync(base.armyStatus, base.buildings, (building) => {
      const sprite = this.buildingSprites.get(building.id);
      return sprite
        ? {
          x: sprite.x,
          y: armyStatusAnchorY(
            // Seat on the ART, not the family's shared frame cell: a Level 1
            // Camp fills barely a third of it.
            spriteVisualTopY(sprite.y, sprite.originY, sprite.displayHeight)
              + frameOpaqueTopRatio(this, sprite.texture.key, sprite.frame.name) * sprite.displayHeight,
            building.ty * T,
            busyIds.has(building.id),
            T,
          ),
          footprintWidth: this.footprintOf(this.spriteKeyFor(building)).fw * T,
        }
        : undefined;
    });
    const campCount = base.buildings.filter((b) => b.type === 'camp' && !b.underConstruction).length;
    const visibleTroops = visibleGarrisonTroops(base.army, campCount);
    // Resolve the v2 grant ONCE per render — which troop gets its full
    // animation, and the exact groups that grant is made of — then HOLD those
    // groups before the sweep below can reach them (see `patrolArtLease`).
    // Only VISIBLE troops are held: a troop the camps do not field has no
    // walker to protect, and holding its sheets would spend budget on art
    // nobody can see.
    const patrolGrant = new Map<string, { tier: number; groups: readonly string[] }>();
    for (const troop of visibleTroops) {
      const row = base.army.find((a) => a.troop === troop);
      if (!row || row.level === undefined || !Number.isFinite(row.level)) continue;
      if (!(ART_V2.troops as readonly string[]).includes(troop)) continue;
      const tier = artTierOfLevel(row.level);
      const groups = requiredV2PatrolAtlasGroups(this.v2meta.clips, troop, tier);
      if (groups.length > 0 && groups.every((group) => isV2AtlasLoaded(this, group))) {
        patrolGrant.set(troop, { tier, groups });
      }
    }
    // Taken BEFORE the old hold is dropped, so a group carried from the last
    // pass never has a moment at zero holders.
    const nextLease = retainAtlasGroups(
      this, [...patrolGrant.values()].flatMap((grant) => grant.groups),
    );
    this.releasePatrolArtLease();
    this.patrolArtLease = nextLease;
    // Soldiers in motion (owner 2026-07-28): camp garrisons wander their camp
    // ring, the recruited hero patrols the building loop. Sync BEFORE the
    // on-demand budget pass: this immediately replaces any stale batch-13 or
    // historical sprite with the eager exact-current alias, then the sweep can
    // reclaim that obsolete texture before admitting the desired animation.
    this.patrol.sync(
      base.buildings,
      (b) => this.footprintOf(this.spriteKeyFor(b as never)),
      base.army,
      base.player.wallet,
      // Batch-13 Dragon/Giant is no longer a fallback for reworked troops. The
      // eager v2fallback atlas contains the exact winning current-pack frame.
      () => false,
      (troop) => patrolGrant.get(troop)?.tier ?? null,
      base.heroes,
    );
    // Adopt a just-loaded builder atlas before the unreferenced-texture sweep.
    // Patrol follows the same order above; putting jobs after the sweep would
    // evict a completed download before the worker could adopt it.
    const completed = this.jobs.sync(
      base.jobs,
      base.buildings,
      base.obstacles,
      keep,
      fpOf,
      keyOf,
    );
    releaseUnreferencedAtlases(this);

    // On-demand art this base wants: an active Builder Workman, the placed
    // cannon/mortar tier atlases, and each profiled
    // garrison troop's locomotion/stand groups. Same
    // want-then-grant pattern — until a group lands, patrol holds the eager
    // current-art alias and the re-render on arrival re-keys exactly once.
    // (No v2fx here: the builder's work loop uses body frames only.)
    const defenseCandidates: AtlasCandidate[] = [];
    for (const b of base.buildings) {
      if ((ART_V2.buildings as readonly string[]).includes(b.type)) {
        const g = `v2bld_${b.type}_t${artTierOfLevel(b.level)}`;
        defenseCandidates.push({ id: `building:${g}`, groups: [g] });
      }
    }
    const wareCandidates: AtlasCandidate[] = [];
    const residentNestCandidates: AtlasCandidate[] = [];
    const seenWareGroups = new Set<string>();
    for (const b of base.buildings) {
      // Walls are contextual scene textures; they never request WARE sheets.
      if (b.type === 'wall') continue;
      const group = this.wareGroupForBuilding(b);
      if (!group || seenWareGroups.has(group)) continue;
      seenWareGroups.add(group);
      const candidate = { id: `ware:${group}`, groups: [group] };
      // Every Nest tier's idle is prominent functional home motion. Keep it ahead
      // of optional WARE enhancement in a dense base so it cannot regress to a
      // still while less important buildings animate.
      if (b.type === 'dragonnest') {
        residentNestCandidates.push(candidate);
      } else {
        wareCandidates.push(candidate);
      }
    }
    // Phase E Market art (C3): the ordinary tier group is REQUIRED residency —
    // no eager Market still exists, so the body cannot be presented at all until
    // that group is resident; it ranks with the functional patrol/nest art, ahead
    // of optional WARE/tower enhancement, and its ~1.8 MB can never be crowded
    // out. pe_cosmetics for a Market wearing an Awning stays optional enhancement:
    // ordinary art is its fallback while (or if) that group cannot be admitted.
    const marketBodyCandidates: AtlasCandidate[] = [];
    const marketAwningCandidates: AtlasCandidate[] = [];
    const seenMarketGroups = new Set<string>();
    for (const b of base.buildings) {
      const family = marketArtFamilyOf(b.type);
      if (!family) continue;
      const tier = marketArtTierOfLevel(b.level, family);
      const awning = family === 'market' ? this.marketAwnings.get(b.id) ?? null : null;
      const choices: MarketArtChoice[] = [family === 'harvester' ? this.marketChoiceFor(b) : { family, tier, awning: null }];
      if (awning) choices.push({ family, tier, awning });
      for (const choice of choices) {
        const group = marketArtGroup(choice);
        if (seenMarketGroups.has(group) || !marketRestFrameKey(this.marketArt, choice)) continue;
        seenMarketGroups.add(group);
        (choice.awning ? marketAwningCandidates : marketBodyCandidates)
          .push({ id: `market:${group}`, groups: [group] });
      }
    }
    // Phase E starter berth (P4): a completed berth with known starter facts wants
    // the single optional 1x fleet group as REQUIRED residency, like a Market body.
    const berthCandidates: AtlasCandidate[] = [];
    const berthGroups = new Set<string>();
    for (const b of base.buildings) {
      if (b.type !== 'berth') continue;
      const selected = this.berthCompositionFor(b);
      if (!selected) continue;
      // The berth group, plus the vehicle tier group only when a vehicle is shown.
      for (const group of berthCompositionGroups(selected.composition, selected.presence)) berthGroups.add(group);
      // A pending journey also wants its craft, gate effect and Wake groups; a journey
      // dropped for absent art leaves that request behind for the next event (C5).
      const plan = this.pendingJourneyPlanFor(b);
      const wanted = plan ? journeyPlanGroups(selected.composition, plan) : this.journeyArtWanted?.get(b.id) ?? [];
      for (const group of wanted) berthGroups.add(group);
    }
    for (const group of berthGroups) berthCandidates.push({ id: `berth:${group}`, groups: [group] });
    const patrolCandidates: AtlasCandidate[] = [];
    for (const troop of visibleTroops) {
      const a = base.army.find((row) => row.troop === troop);
      if (!a || a.level === undefined || !Number.isFinite(a.level)
        || !(ART_V2.troops as readonly string[]).includes(troop)) continue;
      const tier = artTierOfLevel(a.level);
      const groups = requiredV2PatrolAtlasGroups(this.v2meta.clips, troop, tier);
      if (groups.length > 0) patrolCandidates.push({ id: `troop:${troop}`, groups });
    }
    const builderCandidates: AtlasCandidate[] = [];
    if (base.jobs.length > 0) {
      const groups = requiredBuilderAtlasGroups(this.builderClips);
      if (groups.length > 0) builderCandidates.push({ id: 'builder:workman', groups });
    }
    const enhancementCandidates = [...wareCandidates, ...defenseCandidates, ...marketAwningCandidates];
    // A visible active job is immediate functional motion, so it reserves even
    // before the base patrol. Both still outrank optional tower enhancement.
    const v2Candidates = [
      ...builderCandidates,
      ...basePatrolFirstCandidates(patrolCandidates, residentNestCandidates),
      ...basePatrolFirstCandidates([], [...marketBodyCandidates, ...berthCandidates]),
      ...basePatrolFirstCandidates([], enhancementCandidates),
    ];
    const functionalCandidates = [
      ...builderCandidates, ...patrolCandidates, ...residentNestCandidates, ...marketBodyCandidates, ...berthCandidates,
    ];
    let accepted = admitOnDemandAtlasCandidates(
      this, this.v2meta.atlasBytes, v2Candidates,
    );
    // A resident rich tower is already charged before candidate ordering runs,
    // so "patrol first" cannot pre-empt it. A legal mixed-tier base can retain
    // all eight Cannon/Mortar sheets (~80 MiB), leaving compact walkers rejected
    // even though the complete visible patrol fits under the ceiling by itself.
    // Re-key those tower bodies to their eager presentation before
    // eviction, then repeat admission: functional current-pack locomotion owns
    // the budget; tower animation may spend only what remains.
    if (functionalCandidates.some((candidate) => !accepted.has(candidate.id))) {
      const releasedDisplayedDefense = this.releaseV2DefenseArtForPatrol();
      const residentNestGroups = new Set(
        residentNestCandidates.flatMap((candidate) => candidate.groups),
      );
      const releasedDisplayedWare = this.releaseDisplayedWareArt(residentNestGroups);
      const enhancementGroups = new Set(enhancementCandidates.flatMap((candidate) => candidate.groups));
      // The first admission may also have reserved a not-yet-resident tower. No
      // loader has started yet, so release that speculative enhancement spend
      // before recalculating from the reclaimed residency.
      releaseAtlasReservations(this, enhancementGroups);
      releaseUnreferencedAtlases(this);
      accepted = admitOnDemandAtlasCandidates(
        this, this.v2meta.atlasBytes, v2Candidates,
      );
      // Reclaiming a defense group destroys AmbienceLayer first so no animated
      // copy can pin its texture. Restore every ambience actor immediately;
      // spriteKeyFor now selects the safe fallback for released towers.
      if (releasedDisplayedDefense || releasedDisplayedWare) {
        this.ambience.sync(base.buildings, fpOf, keyOf, topOf, busyIds);
      }
    }
    void this.loadV2Candidates(
      v2Candidates.filter((candidate) => accepted.has(candidate.id)),
    );
    // completion juice (§3.10 "upgrade complete"): dust puff + build-complete
    // chime + medium haptic over each finished job's footprint (§6).
    for (const r of completed) {
      dustPuff(this, r.tx * T, (r.ty + r.fh) * T, r.fw, T);
    }
    if (completed.length > 0) {
      playSfx('sfx_build_complete');
      haptic('medium');
    }
    // LAST: both ambience.sync() passes above and any re-key of a carried piece
    // have run, so this is the one point where the gesture can take its sprites
    // back for good. Same synchronous pass, so nothing renders in between.
    this.reseatCarriedPieces();
    this.reseatSettlingMoves();
    // A heartbeat/store refresh remains free to update art and jobs, but draft
    // coordinates own presentation for the duration of the editor.
    // Optional for the deliberately partial scene harnesses that exercise the
    // pre-editor render contract without constructing layout collaborators.
    this.applyLayoutDraft?.();
  }

  private showLayoutDraft(command: Extract<GameEvents['base:layoutDraft'], { op: 'show' }>): void {
    this.cancelPointerGesture();
    this.clearWallLine();
    this.clearWallPulse();
    this.layoutDraft = {
      positions: new Map(command.positions.map((position) => [
        position.buildingId, { tx: position.tx, ty: position.ty },
      ])),
      trayIds: new Set(command.trayIds),
      selectedBuildingId: command.selectedBuildingId,
      wallPaintLevel: command.wallPaintLevel,
    };
    this.armyStatus?.setSuppressed(true);
    if (command.wallPaintLevel === null) this.clearLayoutWallStroke();
    this.applyLayoutDraft();
  }

  private hideLayoutDraft(): void {
    if (!this.layoutDraft && !this.layoutWallStroke) return;
    this.cancelPointerGesture();
    this.layoutDraft = null;
    this.armyStatus?.setSuppressed(false);
    this.clearLayoutWallStroke?.();
    this.clearPlacementGrid();
    this.clearFootprintTint();
    this.showSelection(null);
    this.renderFromStore();
  }

  /** Re-seat the actual Phaser sprites at draft coordinates. Animated twins,
   * job scaffolds and walkers are suppressed because they are keyed to the
   * unchanged server rows; the editor never fabricates replacement state. */
  private applyLayoutDraft(): void {
    const draft = this.layoutDraft;
    const base = useApp.getState().base;
    if (!draft || !base) return;
    this.wallArtDirty = true;
    this.wallFrames = resolveWallFrames(base.buildings.flatMap((building) => {
      const position = draft.positions.get(building.id);
      return building.type === 'wall' && position && !draft.trayIds.has(building.id)
        ? [{ id: building.id, tx: position.tx, ty: position.ty, tier: building.level }]
        : [];
    }));
    const occupied: Array<{ tx: number; ty: number; fw: number; fh: number }> = [];
    for (const building of base.buildings) {
      const sprite = this.buildingSprites.get(building.id);
      if (!sprite) continue;
      const trayed = draft.trayIds.has(building.id);
      const position = draft.positions.get(building.id);
      if (trayed || !position) {
        sprite.setVisible(false);
        // A trayed berth's docked starter hides with it (layout mirrors visibility).
        this.berthBuildings.get(building.id)?.layout();
      } else {
        const fp = this.footprintOf(this.spriteKeyFor(building));
        // A pending-art body (a Market/berth whose family is not resident, or an
        // unpresented berth's hidden footprint) stays hidden in layout edit too:
        // its frameless sprite would otherwise reveal the whole packed sheet.
        const pendingArt = this.pendingArtIds?.has(building.id) === true;
        sprite.setVisible(!pendingArt).setAlpha(building.underConstruction ? 0.75 : 1);
        this.positionBuilding(sprite, position.tx, position.ty, fp);
        occupied.push({ tx: position.tx, ty: position.ty, fw: fp.fw, fh: fp.fh });
      }
      this.ambience.hide(building.id);
      this.heroRecovery.hide(building.id);
      this.armyStatus?.hide(building.id);
    }
    for (const obstacle of base.obstacles) {
      const size = this.meta[`dec_${obstacle.spriteKey}`]?.footprint?.[0] ?? 1;
      occupied.push({ tx: obstacle.tx, ty: obstacle.ty, fw: size, fh: size });
    }
    this.occ.rebuild(occupied, useApp.getState().base?.plotVersion);
    this.patrol.destroy();
    this.jobs.destroy();
    this.heroRecovery.destroy();
    this.armyStatus?.setSuppressed(true);
    this.keepClock.destroy();
    this.ambientBusy = false;
    this.showSelection(draft.selectedBuildingId && !draft.trayIds.has(draft.selectedBuildingId)
      ? draft.selectedBuildingId : null);
    this.drawPlacementGrid();
  }

  /**
   * Hand the sleeping base's rich Cannon/Mortar textures back to a battle that
   * actually deploys Direwyvern. A t4 home pair plus a different defender pair
   * otherwise consumes enough global RGBA residency to reject Dire's functional
   * core. The base is already asleep when BattleScene calls this seam.
   *
   * Static building sprites are re-keyed off the V2 texture before eviction.
   * Both towers re-key to their truthful v2fallback stills and stay visible
   * (Cannon joined Mortar in the eager current-art atlas 2026-08-16 — before
   * that its only fallback was the legacy sprite, so it had to hide). Animated
   * ambience copies are destroyed and recreated from store on wake.
   */
  releaseV2DefenseArtForBattle(): void {
    this.releaseDisplayedV2DefenseArt(true);
    this.releaseDisplayedWareArt();
  }

  /**
   * Give functional base-patrol locomotion priority over already-resident tower
   * enhancement sheets. Unlike the battle seam, the eager tower presentation
   * remains visible while the admitted patrol and any remainder-funded tower
   * sheets load.
   */
  private releaseV2DefenseArtForPatrol(): boolean {
    return this.releaseDisplayedV2DefenseArt(false);
  }

  /** Drop the hold on the previous pass's granted patrol art (idempotent —
   *  `retainAtlasGroups` returns a release that only counts down once). */
  private releasePatrolArtLease(): void {
    this.patrolArtLease?.();
    this.patrolArtLease = null;
  }

  /** Re-key rich M22 base sprites to their exact-current eager aliases before
   * handing optional texture residency to functional patrol/combat art. */
  private releaseDisplayedWareArt(preserveGroups: ReadonlySet<string> = new Set()): boolean {
    const base = useApp.getState().base;
    if (!base) return false;
    const groups = new Set<string>();
    let released = false;
    for (const b of base.buildings) {
      if (!this.wareBuildings.has(b.id)
        && !this.wareTraps.has(b.id)) continue;
      const sprite = this.buildingSprites.get(b.id);
      const group = this.wareGroupForBuilding(b);
      if (!sprite || !group) continue;
      if (preserveGroups.has(group)) continue;
      groups.add(group);
      released = true;
      this.destroyWareController(b.id);
      const fallback = this.spriteKeyFor(b);
      sprite.setTexture(atlasFor(fallback), fallback).setVisible(true);
      this.positionBuilding(sprite, b.tx, b.ty, this.footprintOf(fallback));
    }
    if (groups.size > 0) {
      releaseAtlasGroups(this, groups);
      releaseAtlasReservations(this, groups);
    }
    return released;
  }

  private releaseDisplayedV2DefenseArt(hideUntilReload: boolean): boolean {
    const groups = new Set<string>();
    for (const [id, sprite] of this.buildingSprites) {
      const group = sprite.getData('v2AtlasGroup') as string | undefined;
      if (!group || !sprite.frame.name.startsWith('v2_bld_')) continue;
      const fallback = sprite.getData('v2FallbackFrame') as string | undefined;
      if (!fallback) continue;
      groups.add(group);
      sprite.setTexture(atlasFor(fallback), fallback);
      const truthfulEager = fallback.startsWith('v2_fallback_bld_');
      if (hideUntilReload && !truthfulEager) {
        sprite.setVisible(false);
        this.battleReleasedV2Buildings.add(id);
      } else {
        this.battleReleasedV2Buildings.delete(id);
        sprite.setVisible(true);
        const tx = sprite.getData('tx') as number | undefined;
        const ty = sprite.getData('ty') as number | undefined;
        if (Number.isFinite(tx) && Number.isFinite(ty)) {
          this.positionBuilding(sprite, tx!, ty!, this.footprintOf(fallback));
        }
      }
    }
    if (groups.size === 0) return false;
    this.ambience.destroy();
    releaseAtlasGroups(this, groups);
    releaseAtlasReservations(this, groups);
    return true;
  }

  /**
   * Load admitted base-view V2 candidates independently. One broken atlas must
   * not suppress adoption of another candidate that landed in the same Phaser
   * loader batch. Conversely, a completion after this scene sleeps cannot be
   * adopted, so its newly requested (and still unreferenced) groups are handed
   * straight back to the global on-demand budget.
   *
   * Cleanup is targeted to groups this call actually requested. Already-live
   * cannon/mortar sheets and pre-existing shared dependencies are therefore
   * never candidates for eviction; releaseAtlasGroups performs the final live
   * display-list check across every scene before removing even a targeted one.
   */
  private async loadV2Candidates(candidates: readonly AtlasCandidate[]): Promise<void> {
    const retryStates = this.artRetryStates ??= new Map<string, ArtRetryState>();
    const retryKeyByCandidate = this.artRetryKeyByCandidate ??= new Map<string, string>();
    const now = (): number => Number.isFinite(this.time?.now) ? this.time.now : Date.now();
    const currentKeys = new Set<string>();
    const exhaustedReservations = new Set<string>();
    const liveReservations = new Set<string>();
    const requests: Array<{
      candidate: AtlasCandidate;
      key: string;
      missing: string[];
      state: ArtRetryState;
    }> = [];

    for (const candidate of candidates) {
      const key = artRetryKey(candidate);
      const previousKey = retryKeyByCandidate.get(candidate.id);
      if (previousKey && previousKey !== key) retryStates.delete(previousKey);
      retryKeyByCandidate.set(candidate.id, key);
      currentKeys.add(key);

      const missing = [...new Set(candidate.groups)]
        .filter((group) => !isV2AtlasLoaded(this, group));
      if (missing.length === 0) {
        retryStates.delete(key);
        continue;
      }

      const state = retryStates.get(key) ?? {
        candidateId: candidate.id,
        nextDelayIndex: 0,
        dueAt: null,
        inFlight: false,
        exhausted: false,
      };
      retryStates.set(key, state);
      if (state.exhausted) {
        missing.forEach((group) => exhaustedReservations.add(group));
        continue;
      }
      // A shared dependency still belongs to a live candidate even when an
      // exhausted sibling names it too. Release only groups that no remaining
      // retry can use, or the global set-based budget would under-count an
      // in-flight sibling.
      missing.forEach((group) => liveReservations.add(group));
      if (state.inFlight || (state.dueAt !== null && state.dueAt > now())) continue;
      state.inFlight = true;
      state.dueAt = null;
      requests.push({ candidate, key, missing, state });
    }
    const orphanedExhausted = new Set(
      [...exhaustedReservations].filter((group) => !liveReservations.has(group)),
    );
    if (orphanedExhausted.size > 0) {
      // renderFromStore re-runs admission before this method. Without this
      // release, an exhausted signature re-reserves its missing groups forever.
      releaseAtlasReservations(this, orphanedExhausted);
    }
    // Store the latest accepted set on the scene. An older in-flight request
    // may settle after a render changed tiers; its cleanup must not cancel the
    // replacement signature's timer.
    this.artRetryActiveKeys = currentKeys;

    const scheduleRetryWake = (): void => {
      let nextDueAt: number | null = null;
      for (const key of this.artRetryActiveKeys) {
        const state = retryStates.get(key);
        if (!state || state.inFlight || state.exhausted || state.dueAt === null) continue;
        nextDueAt = nextDueAt === null ? state.dueAt : Math.min(nextDueAt, state.dueAt);
      }
      if (nextDueAt === null || !this.time?.delayedCall) {
        this.artRetryTimer?.remove(false);
        this.artRetryTimer = null;
        this.artRetryTimerDueAt = null;
        return;
      }
      if (this.artRetryTimer && this.artRetryTimerDueAt === nextDueAt) return;
      this.artRetryTimer?.remove(false);
      this.artRetryTimerDueAt = nextDueAt;
      this.artRetryTimer = this.time.delayedCall(Math.max(0, nextDueAt - now()), () => {
        this.artRetryTimer = null;
        this.artRetryTimerDueAt = null;
        if (this.scene.isActive()) this.renderFromStore();
      });
    };

    // A render before a candidate's own due time may still introduce another
    // candidate. Keep one wake-up for the earliest due signature, but never let
    // that shared timer advance a later candidate's independent history.
    scheduleRetryWake();
    if (requests.length === 0) return;

    // `loadV2Candidates` has narrow prototype-slice tests for retry bookkeeping;
    // real BaseScene instances always own the queue, while those intentionally
    // partial harnesses retain the immediate loader seam they are isolating.
    const queue = typeof this.queueV2AtlasLoad === 'function'
      ? (groups: string[]) => this.queueV2AtlasLoad(groups)
      : (groups: string[]) => ensureV2Atlases(this, groups);
    const settled = await Promise.allSettled(
      requests.map((request) => queue(request.missing)),
    );
    const active = this.scene.isActive();
    const granted = settled.map((result, index) => {
      const request = requests[index]!;
      return active && this.artRetryActiveKeys.has(request.key)
        && retryKeyByCandidate.get(request.candidate.id) === request.key
        && result.status === 'fulfilled'
        && request.candidate.groups.every((group) => isV2AtlasLoaded(this, group));
    });
    const grantedGroups = new Set<string>();
    granted.forEach((didGrant, index) => {
      if (didGrant) {
        retryStates.delete(requests[index]!.key);
        requests[index]!.candidate.groups.forEach((group) => grantedGroups.add(group));
      }
    });

    const ungrantable = new Set<string>();
    requests.forEach((request, index) => {
      if (!granted[index]) {
        request.missing.forEach((group) => {
          if (!grantedGroups.has(group)) ungrantable.add(group);
        });
      }
    });

    if (ungrantable.size > 0) {
      releaseAtlasGroups(this, ungrantable);
      // Missing/failed sheets are not resident, so the eviction call cannot
      // clear their in-flight budget entries; release those explicitly too.
      // Do this before renderFromStore can admit a retry for the same group.
      releaseAtlasReservations(this, ungrantable);
    }
    requests.forEach((request, index) => {
      if (granted[index]) return;
      // A completion for an obsolete tier/signature is cleanup-only. Its
      // replacement already owns a fresh sequence under a different key.
      if (retryKeyByCandidate.get(request.candidate.id) !== request.key
        || retryStates.get(request.key) !== request.state) return;
      request.state.inFlight = false;
      const delay = BASE_ART_RETRY_DELAYS_MS[request.state.nextDelayIndex];
      if (delay === undefined) {
        request.state.exhausted = true;
        request.state.dueAt = null;
        return;
      }
      request.state.nextDelayIndex += 1;
      request.state.dueAt = now() + delay;
    });
    scheduleRetryWake();
    // Successful candidate groups are excluded from cleanup above (including
    // dependencies shared with a failed candidate), so they remain complete
    // and can be adopted without relying on render/sweep ordering for safety.
    if (granted.some(Boolean)) this.renderFromStore();
  }

  /**
   * Serialize optional base art and guard both ends of its async load. Waiting
   * before the request keeps work away from an already-live touch. The opt-in
   * byte-fetch path rechecks idle before decode and before its FIRST texture
   * insertion, closing the race where a request begun idle finishes mid-pan.
   * BattleScene's two-argument loader calls retain their immediate Phaser path.
   */
  private queueV2AtlasLoad(groups: readonly string[]): Promise<void> {
    const requested = [...groups];
    const run = async (): Promise<void> => {
      await this.waitForInteractionIdle();
      if (this.richArtLoadsStopped || !this.scene.isActive()) {
        throw new Error('base scene became inactive before rich art load');
      }
      for (const group of requested) {
        await ensureV2Atlases(this, [group], {
          beforeTextureInsert: async () => {
            await this.waitForInteractionIdle();
            if (this.richArtLoadsStopped || !this.scene.isActive()) {
              throw new Error('base scene became inactive before rich art stitch');
            }
          },
        });
      }
    };
    const pending = this.richArtLoadTail.then(run);
    this.richArtLoadTail = pending.catch(() => undefined);
    return pending;
  }

  private pointerInteractionActive(): boolean {
    return this.pointerOwnerId !== null || this.multiPointerGesture;
  }

  private waitForInteractionIdle(): Promise<void> {
    if (this.richArtLoadsStopped) {
      return Promise.reject(new Error('base scene shut down before interaction became idle'));
    }
    if (!this.pointerInteractionActive()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.interactionIdleWaiters.add({ resolve, reject });
    });
  }

  private flushInteractionIdleWaiters(): void {
    if (this.richArtLoadsStopped || this.pointerInteractionActive()) return;
    const waiters = [...this.interactionIdleWaiters];
    this.interactionIdleWaiters.clear();
    for (const waiter of waiters) waiter.resolve();
  }

  /** World sprites sit bottom-edge on the south edge of their footprint (HANDOFF §3.2). */
  private positionBuilding(s: Phaser.GameObjects.Sprite, tx: number, ty: number, fp: Footprint): void {
    this.wallArtDirty = true;
    // Rework-v2 frames are absent from meta.sprites — their anchor and draw
    // scale come from v2BldSeat, the ONE place that decides how a v2 tower is
    // drawn (ambience.ts's animated copy and the deed renderer mirror it, or
    // the same tower stands in three places).
    //
    // The anchor is the ORIGIN, never the seat: (56,104) is the centre of the
    // art's own ground quad (_src/_cannon2.js / _src/_mortar2.js headers), and
    // seating THAT on the footprint's middle row is what floated every
    // pixel-anchored building above its plot — see v2/clips.ts#buildingSeatY.
    // Order matters: origin and scale first, because the seat is measured off
    // the sprite's resulting displayHeight. DEPTH stays the south edge.
    // A realm-kit obstacle (E-11) carries its sheet seat on the sprite: its frame
    // name is a sheet cell index, which no atlas meta or clip table describes.
    const seat = (s.getData('kitSeat') as BuildingSeat | undefined) ?? this.buildingSeat(s.frame.name);
    const [ax, ay] = seat.origin;
    s.setOrigin(ax, ay);
    s.setScale(seat.scale); // explicit: pooled sprites re-key legacy ⇄ current
    s.setX((tx + fp.fw / 2) * T + seat.offsetGamePx[0] * V2_DRAW_SCALE);
    s.setY(buildingSeatY(ty, fp.fh, T, ay, s.displayHeight)
      + seat.offsetGamePx[1] * V2_DRAW_SCALE);
    // Walls and buildings share the structure painter axis. Only a wall whose
    // footprint ends farther south may cover a building; equal ties favour the
    // building/defence so a northern wall never crosses its roof.
    s.setDepth(structureDepth(
      (s.getData('structureKind') as StructureDepthKind | undefined) ?? 'building',
      (ty + fp.fh) * T,
    ));
    s.setData('tx', tx);
    s.setData('ty', ty);
    this.refreshFootprintHitArea(s, tx, ty, fp);
    // A presented berth's docked starter follows the berth's seat, depth and visibility.
    this.berthBuildings.get(s.getData('buildingId') as string)?.layout();
  }

  /** Position a lifted piece using the exact same authored seat as at rest. */
  private positionLiftedBuilding(
    sprite: Phaser.GameObjects.Sprite, tx: number, ty: number, fp: Footprint,
  ): void {
    this.wallArtDirty = true;
    const seat = this.buildingSeat(sprite.frame.name);
    const [ax, ay] = seat.origin;
    sprite.setOrigin(ax, ay);
    sprite.setScale(seat.scale);
    sprite.setX((tx + fp.fw / 2) * T + seat.offsetGamePx[0] * V2_DRAW_SCALE);
    sprite.setY(buildingSeatY(ty, fp.fh, T, ay, sprite.displayHeight)
      + seat.offsetGamePx[1] * V2_DRAW_SCALE - LIFT);
  }

  /**
   * The sprite's interactive surface is its actually visible (non-transparent)
   * art. This lets an authored roof, dragon nest, or tower overhang be selected
   * where the player can see it, while Phaser's normal depth ordering resolves
   * two genuinely overlapping visible sprites.
   *
   * Empty pixels intentionally do NOT include the footprint here. The scene-level
   * pointerdown performs that fallback only after no visible object handled the
   * press; otherwise a transparent neighbouring footprint could steal visible art.
   * Called after every re-key/position pass so upgraded frame dimensions stay live.
   */
  private refreshFootprintHitArea(
    sprite: Phaser.GameObjects.Sprite, tx: number, ty: number, fp: Footprint,
  ): void {
    const hitArea = new Phaser.Geom.Rectangle(0, 0, sprite.width, sprite.height);
    sprite.setData('tx', tx);
    sprite.setData('ty', ty);
    sprite.setData('fw', fp.fw);
    sprite.setData('fh', fp.fh);
    if (sprite.input) {
      // InputPlugin#setHitArea keeps an existing InteractiveObject's old shape,
      // so replace the live fields after a texture/origin/scale change.
      sprite.input.hitArea = hitArea;
      sprite.input.hitAreaCallback = visibleArtContains;
      sprite.input.customHitArea = true;
      sprite.input.enabled = !this.objectHitTestsSuppressed;
    } else {
      sprite.setInteractive(hitArea, visibleArtContains);
      const input = (sprite as unknown as { input?: { enabled: boolean } }).input;
      if (input) input.enabled = !this.objectHitTestsSuppressed;
    }
  }

  /** Disable only object hit testing; the scene InputPlugin stays enabled so
   * camera deltas, pinch and every release/cancel path continue to arrive. */
  private setObjectHitTestsSuppressed(suppressed: boolean): void {
    if (this.objectHitTestsSuppressed === suppressed) return;
    this.objectHitTestsSuppressed = suppressed;
    for (const sprite of this.buildingSprites.values()) {
      if (sprite.input) sprite.input.enabled = !suppressed;
    }
  }

  private isTouchPointer(pointer: Phaser.Input.Pointer): boolean {
    const pointerType = (pointer.event as { pointerType?: string } | null)?.pointerType;
    return pointer.wasTouch || pointerType === 'touch';
  }

  private suppressObjectHitTestsForTouchPan(pointer: Phaser.Input.Pointer): void {
    if (this.isTouchPointer(pointer)) this.setObjectHitTestsSuppressed(true);
  }

  // -------------------------------------------------------------------------
  // Building input: tap = select, drag = move (HANDOFF §5 contract)
  // -------------------------------------------------------------------------

  private attachBuildingInput(sprite: Phaser.GameObjects.Sprite): void {
    sprite.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (!this.acceptsObjectGesture(pointer)) return;
      this.beginBuildingPress(sprite, pointer);
    });
  }

  /** Shared by an opaque-art hit and the transparent-footprint fallback. */
  private beginBuildingPress(
    sprite: Phaser.GameObjects.Sprite,
    pointer: Phaser.Input.Pointer,
  ): void {
    // GameObject downs run before the scene down; registration is idempotent
    // for that same event and must precede any object gesture decision.
    if (!this.registerPointerDown(pointer)) return;
    if (this.ghost) return; // building drags are disabled while placing (HANDOFF §5.2)
    // Wall-paint mode owns the whole canvas gesture, including a stroke that
    // begins over a visible building. The reducer will skip occupied tiles.
    if (this.layoutDraft?.wallPaintLevel !== null && this.layoutDraft) return;
    if (this.multiPointerGesture || this.pointerContacts.size > 1) {
      this.beginMultiPointerGesture();
      return;
    }
    // A second object press cannot steal an already-armed building/obstacle.
    if (this.drag || this.obstaclePress) return;
    const id = sprite.getData('buildingId') as string;
    // #61: if this wall belongs to a selected LINE, drag the whole line together.
    const line = !this.layoutDraft && this.wallLineIds.has(id) && this.wallLineIds.size > 1
      ? [...this.wallLineIds]
          .filter((wid) => wid !== id)
          .map((wid) => this.buildingSprites.get(wid))
          .filter((sp): sp is Phaser.GameObjects.Sprite => !!sp)
          .map((sp) => ({ id: sp.getData('buildingId') as string, sprite: sp, origTx: sp.getData('tx') as number, origTy: sp.getData('ty') as number }))
      : undefined;
    this.drag = {
      id,
      pointerId: pointer.id,
      sprite,
      startX: pointer.x,
      startY: pointer.y,
      origTx: sprite.getData('tx') as number,
      origTy: sprite.getData('ty') as number,
      fp: this.positionedFootprint(sprite),
      moved: false,
      curTx: sprite.getData('tx') as number,
      curTy: sprite.getData('ty') as number,
      ...(line && line.length ? { line } : {}),
    };
    // The "grabbed" cue: if the pointer is still down on this piece and has not
    // wandered off into a pan when the hold elapses, dim it and buzz so the
    // player knows dragging is now armed. The cue is cosmetic — arming itself
    // is decided in pointermove from the pointer's own hold duration.
    this.time.delayedCall(HOLD_TO_LIFT_MS, () => {
      const d = this.drag;
      const owner = d ? this.pointerContacts.get(d.pointerId)?.pointer : undefined;
      if (d && d.sprite === sprite && owner?.isDown && !d.moved) {
        sprite.setAlpha(0.95);
        haptic('light');
      }
    });
  }

  /** Object gestures are primary-button-only for a mouse. Direct pointers keep
   * their normal semantics: touch and pen do not expose mouse button ownership
   * consistently across browsers and must remain accepted. */
  private acceptsObjectGesture(pointer: Phaser.Input.Pointer): boolean {
    const pointerType = (pointer.event as { pointerType?: string } | null)?.pointerType;
    if (pointer.wasTouch || pointerType === 'touch') return true;
    if (pointerType === 'pen') return pointer.button === 0 && pointer.primaryDown;
    return pointer.button === 0 && pointer.primaryDown;
  }

  /** A release has no `primaryDown` once button 0 lifts, so ownership is the
   * released button plus pointer type. Touch cancel is handled separately. */
  private acceptsGestureRelease(pointer: Phaser.Input.Pointer): boolean {
    const pointerType = (pointer.event as { pointerType?: string } | null)?.pointerType;
    if (pointer.wasTouch || pointerType === 'touch') return true;
    return pointer.button === 0;
  }

  /** E-11 obstacle art: the kit sheet frame when the ready revision-5 ground
   * maps this server spriteKey (intact, or the clearing state while a clear
   * job runs), else the frozen `dec_` master (O-7). The tile footprint always
   * comes from the `dec_` meta so hit areas and occupancy never change with art. */
  private styleObstacle(img: Phaser.GameObjects.Sprite, o: BaseStateDto['obstacles'][number], clearing: boolean): void {
    const decKey = obstacleDecKey(o.spriteKey);
    const size = this.meta[decKey]?.footprint?.[0] ?? 1;
    const kit = this.fantasyGround?.obstacleSprite(o.spriteKey, clearing ? 'clearing' : 'intact', o.tx, o.ty);
    const wantedKey = kit ? kit.key : atlasFor(decKey), wantedFrame = kit ? kit.frame : (this.meta[decKey] ? decKey : 'dec_rock_s');
    const current = img.getData('kitSeat') as BuildingSeat | undefined;
    const rekey = img.texture.key !== wantedKey || String(img.frame.name) !== String(wantedFrame) || !!current !== !!kit;
    if (rekey) {
      img.setTexture(wantedKey, wantedFrame);
      img.setData('kitSeat', kit ? { origin: kit.origin, scale: kit.scale, offsetGamePx: [0, 0] } satisfies BuildingSeat : undefined);
    }
    // Rows never move; only a fresh sprite or a re-keyed one needs its seat.
    if (rekey || img.getData('tx') === undefined) this.positionBuilding(img, o.tx, o.ty, { fw: size, fh: size });
  }
  /** The kit ground became ready after the rows were drawn: re-key every obstacle. */
  private restyleObstacles(): void {
    const base = useApp.getState().base;
    if (!base) return;
    const clearing = new Set(base.jobs.flatMap((job) => job.obstacleId ? [job.obstacleId] : []));
    for (const o of base.obstacles) {
      const sprite = this.buildingSprites.get(`obs-${o.id}`);
      if (sprite) this.styleObstacle(sprite, o, clearing.has(o.id));
    }
    this.syncRemnants(base);
  }
  /** E-11 remnants: the kit's stump/rubble twin on the seat of every obstacle the
   * player felled within OBSTACLE_REMNANT_DAYS (`GET /base` `clearedObstacles[]`).
   * Presentation only — the server already lists the tile as buildable — so a
   * remnant is a plain Image: never interactive, never in buildingSprites or the
   * occupancy grid, never a clear target, and hidden the moment anything stands
   * on its tiles (a stump you built over is gone). Only the kit sheet has remnant
   * twins; without a ready revision-5 ground the tile simply stays bare, because
   * the frozen `dec_` masters have no stump for a felled tree. Seat and depth
   * follow positionBuilding's kit-seat rule so the stump stands where the tree did. */
  private syncRemnants(base: BaseStateDto): void {
    const seen = new Set<string>();
    for (const r of base.clearedObstacles ?? []) {
      const kit = this.fantasyGround?.obstacleSprite(r.spriteKey, 'remnant', r.tx, r.ty);
      if (!kit) continue;
      const id = `${r.tx},${r.ty}`;
      seen.add(id);
      const size = this.meta[obstacleDecKey(r.spriteKey)]?.footprint?.[0] ?? 1;
      let image = this.remnantImages.get(id);
      if (!image) {
        image = this.add.image(0, 0, kit.key, kit.frame);
        this.remnantImages.set(id, image);
      } else if (image.texture.key !== kit.key || String(image.frame.name) !== String(kit.frame)) {
        image.setTexture(kit.key, kit.frame);
      }
      let covered = false;
      for (let ty = r.ty; ty < r.ty + size && !covered; ty++) {
        for (let tx = r.tx; tx < r.tx + size && !covered; tx++) covered = !this.occ.tileFree(tx, ty);
      }
      image.setOrigin(kit.origin[0], kit.origin[1]).setScale(kit.scale);
      image.setPosition((r.tx + size / 2) * T, buildingSeatY(r.ty, size, T, kit.origin[1], image.displayHeight))
        .setDepth(structureDepth('building', (r.ty + size) * T))
        .setVisible(!covered);
    }
    for (const [id, image] of this.remnantImages) {
      if (!seen.has(id)) {
        image.destroy();
        this.remnantImages.delete(id);
      }
    }
  }

  private attachObstacleInput(img: Phaser.GameObjects.Sprite, obstacleId: string): void {
    img.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (!this.acceptsObjectGesture(pointer)) return;
      this.beginObstaclePress(obstacleId, pointer);
    });
    img.on('pointerup', (pointer: Phaser.Input.Pointer) => {
      if (pointer.wasCanceled || !this.acceptsGestureRelease(pointer) || this.multiPointerGesture) return;
      if (!this.ownsPointerContact(pointer)) return;
      this.prunePointerContacts(pointer, pointer.id);
      this.commitObstaclePress(obstacleId, pointer);
    });
  }

  private beginObstaclePress(obstacleId: string, pointer: Phaser.Input.Pointer): void {
    if (!this.registerPointerDown(pointer)) return;
    if (this.drag || this.ghost) return; // mid-drag / placing: ignore
    // Obstacles are immutable blockers in the layout editor; a touch on one is
    // either a pan or a wall-paint stroke, never the ordinary clear sheet.
    if (this.layoutDraft) return;
    if (this.multiPointerGesture || this.pointerContacts.size > 1) {
      this.beginMultiPointerGesture();
      return;
    }
    if (this.obstaclePress) return;
    this.panSuppressed = true;
    this.obstaclePress = { id: obstacleId, pointerId: pointer.id, x: pointer.x, y: pointer.y };
  }

  private commitObstaclePress(obstacleId: string, pointer: Phaser.Input.Pointer): void {
    const press = this.obstaclePress;
    if (!press || press.id !== obstacleId || press.pointerId !== pointer.id
      || this.pointerOwnerId !== pointer.id) return;
    this.obstaclePress = null;
    if (Math.abs(pointer.x - press.x) + Math.abs(pointer.y - press.y) > DRAG_THRESHOLD) return;
    // Mutually exclusive with building selection: clear brackets + store
    // (selectObstacle nulls selectedBuildingId, R2).
    requestSceneCommand(this, [{ kind: 'obstacle', id: obstacleId }], () => {
      this.showSelection(null);
      useApp.getState().selectObstacle(obstacleId);
      bus.emit('base:select', { buildingId: null });
      bus.emit('base:selectObstacle', { obstacleId });
    });
  }

  /**
   * The pieces a live move gesture is carrying: the pressed building plus, for a
   * #61 wall line, the walls dragged in lockstep with it. Empty until the piece
   * is actually lifted — an armed-but-unmoved press still sits on its store tile
   * and must keep taking its position from there.
   */
  private carriedPieces(): Array<{
    id: string; sprite: Phaser.GameObjects.Sprite; origTx: number; origTy: number;
  }> {
    const d = this.drag;
    if (!d?.moved) return [];
    return [{ id: d.id, sprite: d.sprite, origTx: d.origTx, origTy: d.origTy }, ...(d.line ?? [])];
  }

  /**
   * Tiles a DROPPED move is holding until React reports the PATCH resolved.
   *
   * carriedPieces covers the gesture; this covers the gap after it. Between the
   * drop and the move's own refresh the store still says the OLD tile, so a
   * heartbeat landing in that window repainted the building back once — the same
   * prod-#3 flicker, just one frame instead of a strobe. React owns the outcome,
   * so it tells us when to let go: 'base:moveSettled'. Unlike a carried piece
   * this seats NORMALLY (no lift, no alpha) — it has been put down.
   */
  private settlingMoves = new Map<string, { tx: number; ty: number; fp: Footprint }>();

  /** Hold the dropped tiles for `ids` until base:moveSettled clears them. */
  private holdSettlingMove(
    pieces: ReadonlyArray<{ id: string; tx: number; ty: number }>, fp: Footprint,
  ): void {
    this.wallArtDirty = true;
    for (const p of pieces) this.settlingMoves.set(p.id, { tx: p.tx, ty: p.ty, fp });
  }

  /** Stop holding these tiles: the store is authoritative for them again. */
  private releaseSettlingMoves(buildingIds: readonly string[]): void {
    this.wallArtDirty = true;
    for (const id of buildingIds) this.settlingMoves.delete(id);
  }

  /** Re-apply held tiles after a store rebuild that still predates the move. */
  private reseatSettlingMoves(): void {
    for (const [id, at] of this.settlingMoves) {
      const sprite = this.buildingSprites.get(id);
      if (!sprite) { this.settlingMoves.delete(id); continue; }
      this.positionBuilding(sprite, at.tx, at.ty, at.fp);
    }
  }

  /** The lifted look for one carried piece (HANDOFF §5: 8px lift + brighten). */
  private liftPiece(
    sprite: Phaser.GameObjects.Sprite, tx: number, ty: number, fp: Footprint,
  ): void {
    this.positionLiftedBuilding(sprite, tx, ty, fp);
    sprite.setDepth(LIFT_DEPTH).setAlpha(LIFT_ALPHA);
    // A presented berth's docked starter rides with the lifted look (seat, depth, alpha).
    this.berthBuildings.get(sprite.getData('buildingId') as string)?.layout();
  }

  /**
   * Hand the carried pieces back their gesture seat after a store rebuild.
   *
   * renderFromStore reseats every sprite from its store row, and until a move
   * commits that row still holds the tile the building has NOT left yet. So a
   * refresh landing mid-gesture dropped the lifted sprite back on its old tile
   * and the next pointermove lifted it again: holding a building over a new tile
   * made it strobe between the two (prod feedback #3, Android + PC — the base
   * auto-refetch heartbeat re-polls every 2s while a job deadline is elapsed, so
   * it repeated for as long as the player held). The gesture owns these
   * transforms until it resolves; refreshes keep flowing for everything else.
   */
  private reseatCarriedPieces(): void {
    const d = this.drag;
    if (!d?.moved) return;
    const dtx = d.curTx - d.origTx;
    const dty = d.curTy - d.origTy;
    for (const w of this.carriedPieces()) {
      this.liftPiece(w.sprite, w.origTx + dtx, w.origTy + dty, d.fp);
      // ambience.sync() reveals every pooled copy, which undoes the lift-time
      // hide() that keeps the animated twin off the tile the piece has left.
      this.ambience.hide(w.id);
      this.heroRecovery.hide(w.id);
      this.armyStatus?.hide(w.id);
    }
  }

  /**
   * End a live drag as if it never started: revert every lifted piece to its
   * origin tile, drop the drag visuals, and bring back the ambience copy that
   * hide() took on lift (D3). Cancel-style ends get NO base:refresh, so
   * nothing else would heal either half. Shared by cancelled releases and the
   * scene SLEEP hook (screen change mid-drag) — one cleanup path, so a new
   * way for a drag to die can't forget the ambience again.
   */
  private cancelDrag(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.clearPlacementGrid();
    this.clearFootprintTint();
    this.liftShadow?.destroy();
    this.liftShadow = null;
    // Line members share the primary's footprint (a line is always walls, §61),
    // matching the pointerup revert path exactly.
    for (const w of [{ sprite: d.sprite, origTx: d.origTx, origTy: d.origTy }, ...(d.line ?? [])]) {
      w.sprite.clearTint();
      w.sprite.setAlpha(1);
      this.positionBuilding(w.sprite, w.origTx, w.origTy, d.fp);
    }
    this.ambience.show(d.id);
    this.heroRecovery.show(d.id);
    this.armyStatus?.show(d.id);
    if (this.layoutDraft) this.drawPlacementGrid();
  }

  /** Discard only the current wall swipe; placement mode itself stays active so
   * the player can try again after a cancelled/outside/multi-touch gesture. */
  private clearWallStroke(): void {
    if (!this.wallPaint) return;
    this.wallPaint.tiles = [];
    this.wallPaint.set.clear();
    this.wallPaint.gfx.clear();
  }

  private clearLayoutWallStroke(): void {
    this.layoutWallStroke?.gfx.destroy();
    this.layoutWallStroke = null;
  }

  private beginLayoutWallStroke(pointer: Phaser.Input.Pointer): void {
    if (this.layoutDraft?.wallPaintLevel === null || !this.layoutDraft) return;
    this.clearLayoutWallStroke?.();
    const base = useApp.getState().base;
    const level = this.layoutDraft.wallPaintLevel;
    const maxTiles = base?.buildings.filter((building) =>
      this.layoutDraft!.trayIds.has(building.id)
      && building.type === 'wall'
      && building.level === level).length ?? 0;
    if (maxTiles === 0) return;
    this.layoutWallStroke = {
      tiles: [], set: new Set(),
      gfx: this.add.graphics().setDepth(overlayDepth(2400)),
      lastTile: null,
      maxTiles,
    };
    this.paintLayoutWallTile(pointer);
  }

  private paintLayoutWallTile(pointer: Phaser.Input.Pointer): void {
    const stroke = this.layoutWallStroke;
    const draft = this.layoutDraft;
    if (!stroke || !draft) return;
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const target = { tx: Math.floor(world.x / T), ty: Math.floor(world.y / T) };
    const samples = stroke.lastTile
      ? tileStrokeLine(stroke.lastTile, target).slice(1)
      : [target];
    stroke.lastTile = target;
    for (const { tx, ty } of samples) {
      if (stroke.tiles.length >= stroke.maxTiles) break;
      const key = `${tx},${ty}`;
      if (stroke.set.has(key)
        || !this.isValidSpot('__layout_wall__', tx, ty, { fw: 1, fh: 1 })) continue;
      stroke.set.add(key);
      stroke.tiles.push({ tx, ty });
      stroke.gfx.fillStyle(VALID_TINT, 0.5).fillRect(tx * T, ty * T, T, T);
    }
  }

  private commitLayoutWallStroke(pointer: Phaser.Input.Pointer): boolean {
    if (!this.layoutWallStroke) return false;
    if (this.layoutWallStroke.tiles.length === 0) this.paintLayoutWallTile(pointer);
    const tiles = this.layoutWallStroke.tiles.slice();
    this.clearLayoutWallStroke?.();
    const level = this.layoutDraft?.wallPaintLevel;
    if (tiles.length > 0 && level !== null && level !== undefined) {
      bus.emit('base:layoutEdit', { kind: 'paintWalls', level, tiles });
    }
    return true;
  }

  /** Full non-committing gesture end, shared by sleep, OS cancellation,
   * outside release and gameout. */
  private cancelPointerGesture(holdUntilPointersLift = false): void {
    this.emptyTap.cancel();
    if (!holdUntilPointersLift) this.pointerContacts.clear();
    this.pinch?.onUp();
    this.pointerOwnerId = null;
    this.panSuppressed = false;
    this.obstaclePress = null;
    this.clearWallStroke();
    this.clearLayoutWallStroke?.();
    this.liftShadow?.destroy();
    this.liftShadow = null;
    this.cancelDrag();
    this.multiPointerGesture = holdUntilPointersLift;
    this.setObjectHitTestsSuppressed(holdUntilPointersLift);
    if (!holdUntilPointersLift) this.flushInteractionIdleWaiters();
  }

  private ownsPointerContact(pointer: Phaser.Input.Pointer): boolean {
    const contact = this.pointerContacts.get(pointer.id);
    return !!contact && contact.identifier === pointer.identifier;
  }

  /** The document touch list repairs a lost end without adopting HUD fingers.
   * Ignore the just-released contact until its normal owner commits or cancels. */
  private prunePointerContacts(pointer?: Phaser.Input.Pointer, endingId?: number): boolean {
    const touches = pointer && this.isTouchPointer(pointer)
      ? (pointer.event as TouchEvent | undefined)?.touches : undefined;
    const identifiers = touches ? new Set(Array.from(touches, (touch) => touch.identifier)) : null;
    let removed = false;
    for (const [id, contact] of this.pointerContacts) {
      if (id === endingId) continue;
      if (!contact.pointer.isDown || contact.pointer.identifier !== contact.identifier
        || (this.isTouchPointer(contact.pointer) && identifiers && !identifiers.has(contact.identifier))) {
        this.pointerContacts.delete(id);
        removed = true;
      }
    }
    if (removed) this.cancelPointerGesture(this.pointerContacts.size > 0);
    return removed;
  }

  private registerPointerDown(pointer: Phaser.Input.Pointer): boolean {
    // Phaser forwards window touchstarts through object hit testing before it
    // emits pointerdownoutside. A DOM/HUD down must never own the object below.
    if (this.game?.canvas && pointer.downElement !== this.game.canvas) return false;
    this.prunePointerContacts(pointer);
    const previous = this.pointerContacts.get(pointer.id);
    if (previous && previous.downEvent === pointer.event) return true; // opaque object, then scene down
    if (previous) {
      // A fresh down in the same pooled slot is a new lifetime, never the
      // release/continuation of its previous building or paint gesture.
      this.pointerContacts.delete(pointer.id);
      this.cancelPointerGesture(this.pointerContacts.size > 0);
    }
    this.pointerContacts.set(pointer.id, { pointer, identifier: pointer.identifier, downEvent: pointer.event });
    return true;
  }

  /** Pinch onset cancels every object/paint candidate but deliberately leaves
   * PinchZoom active and the placement ghost visible. */
  private beginMultiPointerGesture(): void {
    this.emptyTap.cancel();
    this.multiPointerGesture = true;
    this.pointerOwnerId = null;
    this.panSuppressed = false;
    this.obstaclePress = null;
    this.clearWallStroke();
    this.clearLayoutWallStroke?.();
    this.cancelDrag();
    this.setObjectHitTestsSuppressed(true);
  }

  /** Re-band the zoom limits for the CURRENT viewport (world/camera.ts) and hand
   *  them to the pinch controller, which is banded at construction otherwise. */
  private rebandCamera(): void {
    const cam = this.cameras.main;
    const claim = useApp.getState().base?.claim;
    const claimTiles = claim ? claim.max - claim.min : GRID.claimTiles;
    this.zoomBand = baseZoomBand(
      cam.width, cam.height, BOUNDS, claimTiles, T, this.insets ?? undefined,
      useApp.getState().base?.plotVersion === 2,
    );
    this.pinch.setLimits(this.zoomBand.min, this.zoomBand.max);
    if (useApp.getState().base?.plotVersion === 2) {
      const bounds = baseRenderBounds(cam.width, cam.height, this.zoomBand.min, -SKIRT, BOUNDS, this.insets ?? undefined);
      cam.setBounds(bounds.x, bounds.y, bounds.width, bounds.height, false);
      this.fantasyGround?.setCoverage(bounds);
    }
  }

  /** Frame the live server claim inside the unobstructed React HUD rectangle. */
  private fitCamera(): void {
    const cam = this.cameras.main;
    const claim = useApp.getState().base?.claim ?? {
      min: (GRID.plotTiles - GRID.claimTiles) / 2,
      max: (GRID.plotTiles + GRID.claimTiles) / 2,
    };
    const frame = fitBaseCamera(
      cam.width, cam.height, BOUNDS, claim, T, this.insets ?? undefined,
      useApp.getState().base?.plotVersion === 2,
    );
    this.zoomBand = { min: frame.min, max: frame.max };
    this.pinch.setLimits(frame.min, frame.max);
    if (useApp.getState().base?.plotVersion === 2) {
      const bounds = baseRenderBounds(cam.width, cam.height, frame.min, -SKIRT, BOUNDS, this.insets ?? undefined);
      cam.setBounds(bounds.x, bounds.y, bounds.width, bounds.height, true);
      this.fantasyGround?.setCoverage(bounds);
    } else cam.setBounds(-SKIRT, -SKIRT, BOUNDS, BOUNDS, true);
    cam.setZoom(frame.zoom);
    cam.centerOn(frame.centerX, frame.centerY);
  }

  /** Apply a React camera command exactly once. Pinch/wheel update the camera
   * directly and never emit this command, which prevents multiplier feedback.
   * FIT is the only command left — M23 a10 removed the HUD +/- pills. */
  private commandCamera(op: 'fit'): void {
    void op;
    this.userMovedCamera = false;
    this.fitCamera();
    if (this.ghost || this.layoutDraft) this.drawPlacementGrid();
  }

  /** Reveal and select the real object represented by a HUD queue row. The
   * camera targets the centre of the unobstructed rectangle rather than the
   * physical canvas centre, so a short-landscape navigation rail cannot cover
   * the object the player just asked to see. */
  private focusObject(kind: 'building' | 'obstacle', id: string): void {
    const sprite = this.buildingSprites.get(kind === 'obstacle' ? `obs-${id}` : id);
    if (!sprite) return;
    requestSceneCommand(this, [{ kind, id }], () => {
      const tx = sprite.getData('tx') as number | undefined;
      const ty = sprite.getData('ty') as number | undefined;
      if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;
      const fp = this.positionedFootprint(sprite);
      const targetX = (tx! + fp.fw / 2) * T;
      const targetY = (ty! + fp.fh / 2) * T;
      const cam = this.cameras.main;
      const insets = this.insets ?? { top: 0, right: 0, bottom: 0, left: 0 };
      cam.centerOn(
        targetX + (insets.right - insets.left) / (2 * cam.zoom),
        targetY + (insets.bottom - insets.top) / (2 * cam.zoom),
      );
      this.userMovedCamera = true;

      if (kind === 'building') {
        this.clearWallLine();
        useApp.getState().select(id);
        this.showSelection(id);
        bus.emit('base:selectObstacle', { obstacleId: null });
        bus.emit('base:select', { buildingId: id });
      } else {
        this.clearWallLine();
        this.showSelection(null);
        useApp.getState().selectObstacle(id);
        bus.emit('base:select', { buildingId: null });
        bus.emit('base:selectObstacle', { obstacleId: id });
      }
    }, () => this.buildingSprites.get(kind === 'obstacle' ? 'obs-' + id : id) === sprite && sprite.active !== false);
  }

  /**
   * Phaser.Scale.RESIZE — an orientation flip. The camera keeps its scroll, which
   * slides the view half the size change off whatever the player was looking at
   * (world/camera.ts), so re-band for the new viewport and put the same world
   * point back under the screen centre. Runs while the scene is ASLEEP too (a
   * rotation mid-raid), which is what makes the base look untouched on return.
   */
  private onResize(
    gameSize: Phaser.Structs.Size, _baseSize: Phaser.Structs.Size, _displaySize: Phaser.Structs.Size,
    previousWidth: number, previousHeight: number,
  ): void {
    // RESIZE also fires on same-size refreshes. Only changed geometry invalidates
    // the in-flight swipe; its old coordinates must never commit on finger-up.
    if ((gameSize.width !== previousWidth || gameSize.height !== previousHeight)
      && (this.layoutWallStroke || (this.wallPaint
        && (this.pointerOwnerId !== null || this.wallPaint.tiles.length > 0)))) {
      if (!this.prunePointerContacts()) this.cancelPointerGesture(this.pointerContacts.size > 0);
    }
    if (!this.userMovedCamera) {
      this.fitCamera();
      if (this.ghost || this.layoutDraft) this.drawPlacementGrid();
      return;
    }
    this.rebandCamera();
    reframeAfterResize(this.cameras.main, this.zoomBand);
    if (this.ghost || this.layoutDraft) this.drawPlacementGrid();
  }

  /** A changed safe rectangle re-fits only an untouched camera. Once the player
   * has moved, preserve their view and clamp solely when the new band requires. */
  private applyInsets(i: { top: number; bottom: number; left?: number; right?: number }): void {
    const next = { top: i.top, bottom: i.bottom, left: i.left ?? 0, right: i.right ?? 0 };
    const prior = this.insets;
    const changed = !prior || prior.top !== next.top || prior.bottom !== next.bottom
      || prior.left !== next.left || prior.right !== next.right;
    this.insets = next;
    if (!changed) return;
    if (this.layoutWallStroke || (this.wallPaint
      && (this.pointerOwnerId !== null || this.wallPaint.tiles.length > 0))) {
      if (!this.prunePointerContacts()) this.cancelPointerGesture(this.pointerContacts.size > 0);
    }
    if (!this.userMovedCamera) {
      this.fitCamera();
      if (this.ghost || this.layoutDraft) this.drawPlacementGrid();
      return;
    }
    this.rebandCamera();
    const zoom = this.cameras.main.zoom;
    if (zoom < this.zoomBand.min || zoom > this.zoomBand.max) {
      reframeAfterResize(this.cameras.main, this.zoomBand);
    }
  }

  /**
   * Reliable fallback for transparent pixels inside an object's occupied tiles.
   * Visible pixels are handled first by Phaser's depth-sorted object hit test;
   * this runs only when no object press was armed. Occupancy normally makes the
   * result unique, but the stable depth/id tie-break keeps corrupt/transitioning
   * snapshots deterministic rather than selecting by Map insertion order.
   */
  private footprintObjectAt(
    worldX: number,
    worldY: number,
  ): Phaser.GameObjects.Sprite | null {
    const matches = [...this.buildingSprites.entries()]
      .filter(([id, sprite]) => {
        // A Market whose art is still pending is hidden but stays a real,
        // tappable building (C3): the sheet, move and upgrade must not wait on
        // an optional texture. Decided from the scene's own set, never from the
        // hidden sprite's data (a trayed sprite still owns nothing).
        const pendingArt = this.pendingArtIds?.has(id) === true && this.layoutDraft?.trayIds.has(id) !== true;
        if (sprite.visible === false && !pendingArt) return false;
        const tx = sprite.getData('tx') as number | undefined;
        const ty = sprite.getData('ty') as number | undefined;
        const fw = sprite.getData('fw') as number | undefined;
        const fh = sprite.getData('fh') as number | undefined;
        return Number.isFinite(tx) && Number.isFinite(ty) && Number.isFinite(fw) && Number.isFinite(fh)
          && worldX >= tx! * T && worldX < (tx! + fw!) * T
          && worldY >= ty! * T && worldY < (ty! + fh!) * T;
      })
      .sort(([aId, a], [bId, b]) => b.depth - a.depth || aId.localeCompare(bId));
    return matches[0]?.[1] ?? null;
  }

  private setupCameraInput(): void {
    const cam = this.cameras.main;
    this.rebandCamera();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.onResize, this);
    this.unsub.push(() => this.scale.off(Phaser.Scale.Events.RESIZE, this.onResize, this));
    this.unsub.push(bus.on('base:camera', ({ op }) => this.commandCamera(op)));
    this.unsub.push(bus.on('base:focus', ({ kind, id }) => this.focusObject(kind, id)));
    this.unsub.push(bus.on('base:insets', (i) => this.applyInsets(i)));

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (!this.acceptsObjectGesture(pointer)) return;
      if (!this.registerPointerDown(pointer)) return;
      if (this.multiPointerGesture || this.pointerContacts.size > 1) {
        this.beginMultiPointerGesture();
        return;
      }
      // An opaque visible-art hit has already armed drag/obstacle state through
      // its GameObject handler (which Phaser emits before this scene event). If
      // it did not, preserve the canonical logical tile surface. Never use the
      // full frame rectangle here: WARE cells contain large transparent gutters
      // that extend into neighbouring tiles and would steal their mobile taps.
      if (!this.drag && !this.obstaclePress && !this.ghost) {
        const world = cam.getWorldPoint(pointer.x, pointer.y);
        const fallback = this.footprintObjectAt(world.x, world.y);
        const buildingId = fallback?.getData('buildingId') as string | undefined;
        const obstacleId = fallback?.getData('obstacleId') as string | undefined;
        if (fallback && buildingId) this.beginBuildingPress(fallback, pointer);
        else if (obstacleId) this.beginObstaclePress(obstacleId, pointer);
      }
      if (this.layoutDraft && this.layoutDraft.wallPaintLevel !== null && !this.drag) {
        this.beginLayoutWallStroke(pointer);
      }
      if (!this.multiPointerGesture && this.pointerOwnerId === null) {
        this.pointerOwnerId = pointer.id;
      }
      const point = cam.getWorldPoint(pointer.x, pointer.y);
      this.emptyTap.begin(pointer.id, pointer.x, pointer.y,
        !this.drag && !this.obstaclePress && !this.ghost && !this.layoutDraft
        && !this.footprintObjectAt(point.x, point.y));
    });

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      this.prunePointerContacts(pointer);
      if (!pointer.isDown || !this.ownsPointerContact(pointer)) return;
      this.pointerContacts.get(pointer.id)!.pointer = pointer;
      this.emptyTap.move(pointer.id, pointer.x, pointer.y);
      // Two fingers down → camera-only until BOTH lift. Cancel any object or
      // wall-stroke candidate before PinchZoom consumes the move.
      const fingers = [...this.pointerContacts.values()].map((contact) => contact.pointer)
        .filter((contact) => this.isTouchPointer(contact));
      if (fingers.length > 1) {
        this.beginMultiPointerGesture();
        this.pinch.onMove(fingers[0]!, fingers[1]!);
        return;
      }
      if (this.multiPointerGesture || !pointer.isDown || this.pointerOwnerId !== pointer.id) return;
      // Empty-ground pan is primary-contact-only too. A right/middle drag must
      // neither move the camera nor inherit the preceding left gesture.
      const pointerType = (pointer.event as { pointerType?: string } | null)?.pointerType;
      if (!pointer.wasTouch && pointerType !== 'touch' && !pointer.primaryDown) return;
      if (this.layoutWallStroke) {
        this.paintLayoutWallTile(pointer);
        return;
      }
      // An obstacle owns a stationary tap, not the swipe that merely began on
      // its footprint. Promote over-threshold motion to the ordinary camera pan
      // and let this SAME move supply its delta so the view never hitches.
      const obstaclePress = this.obstaclePress;
      if (obstaclePress && obstaclePress.pointerId === pointer.id &&
          Math.abs(pointer.x - obstaclePress.x) + Math.abs(pointer.y - obstaclePress.y) > DRAG_THRESHOLD) {
        this.obstaclePress = null;
        this.panSuppressed = false;
        this.suppressObjectHitTestsForTouchPan(pointer);
      }
      if (this.drag) {
        const d = this.drag;
        if (d.pointerId !== pointer.id) return;
        const manhattan = Math.abs(pointer.x - d.startX) + Math.abs(pointer.y - d.startY);
        if (!d.moved && manhattan <= DRAG_THRESHOLD) return;
        // HOLD-TO-LIFT: crossing the movement threshold BEFORE the hold elapsed
        // means this was a pan that happened to start on a building. Convert it:
        // drop the drag, un-suppress panning, and fall through to the camera
        // branch below so the same gesture scrolls without a hitch.
        if (!d.moved && pointer.getDuration() < HOLD_TO_LIFT_MS) {
          d.sprite.setAlpha(1);
          this.drag = null;
          this.panSuppressed = false;
          this.suppressObjectHitTestsForTouchPan(pointer);
        } else {
        const firstMove = !d.moved;
        d.moved = true;
        if (firstMove) this.drawPlacementGrid();
        // D3 (batch-13 review: "pre-existing defect, amplified"; owner hit it
        // live 2026-08-03 and read it as server lag): the static sprite follows
        // the finger, but the AmbienceLayer's ANIMATED copy only repositions on
        // refresh — hide it for the drag or it ghosts on the old tile. Cheap and
        // idempotent, so it stays on every move; a refresh landing mid-gesture
        // re-hides it (and re-seats this sprite) in reseatCarriedPieces.
        this.ambience.hide(d.id);
        this.heroRecovery.hide(d.id);
        this.armyStatus?.hide(d.id);
        const world = cam.getWorldPoint(pointer.x, pointer.y);
        const { tx: ntx, ty: nty } = clampPlotPosition(
          Math.round(world.x / T - d.fp.fw / 2), Math.round(world.y / T - d.fp.fh / 2),
          d.fp.fw, d.fp.fh, useApp.getState().base?.plotVersion);
        d.curTx = ntx;
        d.curTy = nty;
        this.liftPiece(d.sprite, ntx, nty, d.fp);
        // detached lift shadow stays at ground level under the piece (§5)
        const groundY = (nty + d.fp.fh) * T;
        if (!this.liftShadow) {
          this.liftShadow = liftShadow(this, ntx * T, groundY, d.fp.fw, d.fp.fh, T);
        } else {
          this.liftShadow.setPosition(
            ntx * T + (d.fp.fw * T) / 2,
            groundY - (d.fp.fh > 1 ? T : T / 2) / 2,
          );
        }
        this.showFootprintTint(ntx, nty, d.fp, this.isValidSpot(d.id, ntx, nty, d.fp));
        // #61: drag the rest of the selected wall line in lockstep, by the same delta.
        if (d.line) {
          const dtx = ntx - d.origTx;
          const dty = nty - d.origTy;
          for (const w of d.line) {
            this.liftPiece(w.sprite, w.origTx + dtx, w.origTy + dty, d.fp);
          }
        }
        return;
        }
      }
      // Wall SWIPE paint (#59): a WALL ghost paints the valid tile under the pointer
      // as you drag, queuing a whole run to place on release. The ghost follows too.
      if (this.ghost?.type === 'wall' && this.wallPaint) {
        const world = cam.getWorldPoint(pointer.x, pointer.y);
        const tx = Math.round(world.x / T - this.ghost.fp.fw / 2);
        const ty = Math.round(world.y / T - this.ghost.fp.fh / 2);
        this.moveGhost(tx, ty);
        this.paintWallTile(tx, ty);
        return;
      }
      // camera pan on empty ground — never while pinching, placing a ghost, or
      // when the press started on an interactive object (HANDOFF §5.2).
      if (this.pinch.active() || this.ghost || this.panSuppressed) return;
      if (pointer.getDistance() > DRAG_THRESHOLD) {
        this.suppressObjectHitTestsForTouchPan(pointer);
      }
      if (pointer.x !== pointer.prevPosition.x || pointer.y !== pointer.prevPosition.y) {
        this.userMovedCamera = true;
      }
      cam.scrollX -= (pointer.x - pointer.prevPosition.x) / cam.zoom;
      cam.scrollY -= (pointer.y - pointer.prevPosition.y) / cam.zoom;
    });

    this.input.on('pointerup', (pointer: Phaser.Input.Pointer) => {
      if (!this.acceptsGestureRelease(pointer)) return;
      if (!this.ownsPointerContact(pointer)) { this.prunePointerContacts(pointer); return; }
      this.pointerContacts.delete(pointer.id);
      this.prunePointerContacts(pointer);
      if (pointer.wasCanceled) {
        this.cancelPointerGesture(this.pointerContacts.size > 0);
        return;
      }
      this.pinch.onUp();
      if (this.multiPointerGesture) {
        this.pointerOwnerId = null;
        this.multiPointerGesture = this.pointerContacts.size > 0;
        if (!this.multiPointerGesture) {
          this.setObjectHitTestsSuppressed(false);
          this.flushInteractionIdleWaiters();
        }
        return;
      }
      if (this.pointerOwnerId !== pointer.id) return;
      const point = cam.getWorldPoint(pointer.x, pointer.y);
      const emptyGroundTap = this.emptyTap.end(pointer.id, pointer.x, pointer.y,
        !this.drag && !this.obstaclePress && !this.ghost && !this.layoutDraft
        && !this.footprintObjectAt(point.x, point.y));
      if (this.layoutWallStroke) {
        this.pointerOwnerId = null;
        this.panSuppressed = false;
        this.setObjectHitTestsSuppressed(false);
        this.flushInteractionIdleWaiters();
        this.commitLayoutWallStroke(pointer);
        return;
      }
      // The GameObject pointerup already commits when the release is still over
      // an opaque pixel. A small natural finger drift may end on a transparent
      // pixel inside the SAME obstacle's occupied tiles, so allow that canonical
      // footprint fallback. Never feed the stored press id back into the validator:
      // doing so made down-on-A/up-on-neighbour look like a same-obstacle release.
      if (this.obstaclePress?.pointerId === pointer.id) {
        const world = cam.getWorldPoint(pointer.x, pointer.y);
        // Release validation belongs to the armed obstacle's canonical tile.
        // A neighbouring WARE body may visually overlap it and must not suppress
        // the exact same-obstacle footprint lookup.
        const released = this.footprintObjectAt(world.x, world.y);
        const releasedObstacleId = released?.getData('obstacleId') as string | undefined;
        if (releasedObstacleId) this.commitObstaclePress(releasedObstacleId, pointer);
      }
      this.pointerOwnerId = null;
      this.panSuppressed = false;
      this.setObjectHitTestsSuppressed(false);
      this.flushInteractionIdleWaiters();
      // Drop a promoted/cancelled obstacle candidate so it cannot leak into the
      // next gesture. Successful taps were consumed by the helper just above.
      this.obstaclePress = null;
      // a finger lifting always drops the lift shadow (HANDOFF §5)
      this.liftShadow?.destroy();
      this.liftShadow = null;
      // Wall SWIPE (#59): a wall ghost commits its painted run on release (a pure
      // tap paints just the tile under the pointer). Batch-place, then end the ghost.
      if (this.ghost?.type === 'wall' && this.wallPaint) {
        if (this.wallPaint.tiles.length === 0) {
          const world = cam.getWorldPoint(pointer.x, pointer.y);
          this.paintWallTile(
            Math.round(world.x / T - this.ghost.fp.fw / 2),
            Math.round(world.y / T - this.ghost.fp.fh / 2),
          );
        }
        if (this.wallPaint.tiles.length > 0) bus.emit('build:paint', { tiles: this.wallPaint.tiles.slice() });
        this.endGhost();
        return;
      }
      // placement mode: a tap anywhere jumps the ghost there (HANDOFF §5.1)
      if (this.ghost && !this.drag && pointer.getDistance() <= DRAG_THRESHOLD) {
        const world = cam.getWorldPoint(pointer.x, pointer.y);
        this.moveGhost(
          Math.round(world.x / T - this.ghost.fp.fw / 2),
          Math.round(world.y / T - this.ghost.fp.fh / 2),
        );
        return;
      }
      // A trayed identity has no visible sprite to grab. Selecting its tray
      // chip makes the next plot tap its placement gesture; React validates the
      // footprint and either accepts it or leaves the item in the tray.
      const trayedId = this.layoutDraft?.selectedBuildingId;
      if (!this.drag && trayedId && this.layoutDraft?.trayIds.has(trayedId)
        && pointer.getDistance() <= DRAG_THRESHOLD) {
        const building = useApp.getState().base?.buildings.find((row) => row.id === trayedId);
        if (building) {
          const fp = this.footprintOf(this.spriteKeyFor(building));
          const world = cam.getWorldPoint(pointer.x, pointer.y);
          bus.emit('base:layoutEdit', {
            kind: 'move', buildingId: trayedId,
            ...clampPlotPosition(Math.round(world.x / T - fp.fw / 2),
              Math.round(world.y / T - fp.fh / 2), fp.fw, fp.fh, useApp.getState().base?.plotVersion),
          });
        }
        return;
      }
      if (!this.drag) {
        if (emptyGroundTap) bus.emit('base:emptyTap', undefined);
        return;
      }
      const d = this.drag;
      this.drag = null;
      this.clearPlacementGrid();
      this.clearFootprintTint();
      d.sprite.clearTint();
      d.sprite.setAlpha(1);
      if (!d.moved) {
        // #61: a tap selects the ONE building it landed on — walls included. A
        // selected wall then offers a square button to widen the selection to its
        // whole run (showLineBtn); tapping any wall again collapses back to one.
        // Grabbing the run straight off the tap made a single wall impossible to
        // select, so the wall ActionSheet (TIER upgrade) was unreachable.
        if (this.layoutDraft) {
          this.clearWallLine();
          const next = this.layoutDraft.selectedBuildingId === d.id ? null : d.id;
          this.layoutDraft.selectedBuildingId = next;
          this.showSelection(next);
          this.positionBuilding(d.sprite, d.origTx, d.origTy, d.fp);
          this.drawPlacementGrid();
          bus.emit('base:layoutEdit', { kind: 'select', buildingId: next });
          return;
        }
        // tap = toggle select (HANDOFF §5)
        const selected = useApp.getState().selectedBuildingId;
        const next = selected === d.id ? null : d.id;
        requestSceneCommand(this, [{ kind: 'building', id: d.id }], () => {
          this.clearWallLine();
          useApp.getState().select(next);
          this.showSelection(next);
          bus.emit('base:select', { buildingId: next });
          this.positionBuilding(d.sprite, d.origTx, d.origTy, d.fp);
        }, () => this.buildingSprites.get(d.id) === d.sprite && d.sprite.active !== false
          && useApp.getState().selectedBuildingId === selected);
        return;
      }
      if (this.layoutDraft) {
        bus.emit('base:layoutEdit', {
          kind: 'move', buildingId: d.id, tx: d.curTx, ty: d.curTy,
        });
        // React may reject this tile. Reapply the last accepted draft now; an
        // accepted reducer update follows synchronously through the bus/effect.
        this.applyLayoutDraft();
        return;
      }
      // #61: a wall LINE drag commits ALL its walls together — or reverts them all if
      // any target tile is blocked (the line stays rigid).
      if (d.line) {
        const dtx = d.curTx - d.origTx;
        const dty = d.curTy - d.origTy;
        const all = [{ id: d.id, sprite: d.sprite, origTx: d.origTx, origTy: d.origTy }, ...d.line];
        const moving = new Set(all.map((w) => w.id));
        const ok = all.every((w) => this.wallSpotFreeIgnoring(w.origTx + dtx, w.origTy + dty, moving));
        // Drag visuals (alpha 0.95 lift) were applied to EVERY line member in
        // pointermove — reset them all on BOTH outcomes. The revert path gets no
        // server round-trip, so renderFromStore never runs to heal a missed one.
        for (const w of all) w.sprite.clearTint().setAlpha(1);
        if (ok) {
          // Retire the preview at its original seats while the draft decides.
          for (const w of all) this.positionBuilding(w.sprite, w.origTx, w.origTy, d.fp);
          requestSceneCommand(this, all.map(w => ({ kind: 'building' as const, id: w.id })), () => {
            for (const w of all) this.positionBuilding(w.sprite, w.origTx + dtx, w.origTy + dty, d.fp);
            // A committed row move drops the whole selection — pulse, row flag and the
            // wall sheet — so nothing keeps breathing at the tiles it just left.
            this.clearWallLine();
            useApp.getState().select(null);
            this.showSelection(null);
            bus.emit('base:select', { buildingId: null });
            playSfx('sfx_wall_clink'); haptic('light');
            const lineMoves = all.map((w) => ({ id: w.id, tx: w.origTx + dtx, ty: w.origTy + dty }));
            this.holdSettlingMove(lineMoves, d.fp);
            bus.emit('base:moveLine', { moves: lineMoves });
          }, () => all.every(w => this.buildingSprites.get(w.id) === w.sprite && w.sprite.active !== false
            && this.wallSpotFreeIgnoring(w.origTx + dtx, w.origTy + dty, moving)));
        } else {
          for (const w of all) this.positionBuilding(w.sprite, w.origTx, w.origTy, d.fp); // revert all
          // D3 invariant: every drag end that gets NO base:refresh shows the
          // ambience copy again. Walls keep no ambience today, so this is a
          // guard for the invariant, not a visible change.
          this.ambience.show(d.id);
          this.heroRecovery.show(d.id);
          this.armyStatus?.show(d.id);
        }
        return;
      }
      if (this.isValidSpot(d.id, d.curTx, d.curTy, d.fp)) {
        this.positionBuilding(d.sprite, d.origTx, d.origTy, d.fp);
        requestSceneCommand(this, [{ kind: 'building', id: d.id }], () => {
          this.positionBuilding(d.sprite, d.curTx, d.curTy, d.fp);
          // A committed move clears ALL transient drag state — selection brackets,
          // lift tint/alpha (already reset above), lift shadow (dropped on
          // pointerup) — so no gold bracket can linger on empty ground at the old
          // tile (R3; App endDrag valid branch: S.sel=null; render()).
          this.showSelection(null);
          useApp.getState().select(null);
          bus.emit('base:select', { buildingId: null });
          // dust puff + settle thump on the valid drop (§3.10 "building placed":
          // dust + thump; walls clink). read-app §1 dustAt.
          dustPuff(this, d.curTx * T, (d.curTy + d.fp.fh) * T, d.fp.fw, T);
          const isWall = useApp.getState().base?.buildings.find((b) => b.id === d.id)?.type === 'wall';
          playSfx(isWall ? 'sfx_wall_clink' : 'sfx_place_thump');
          haptic('light');
          this.holdSettlingMove([{ id: d.id, tx: d.curTx, ty: d.curTy }], d.fp);
          bus.emit('base:move', { buildingId: d.id, tx: d.curTx, ty: d.curTy });
          // D3: deliberately NO ambience.show() here. The store row still holds
          // the OLD tile until this move's base:refresh lands, so showing now
          // would repaint the animated copy there for the whole server round
          // trip — the exact ghost being fixed. ambience.sync() repositions AND
          // reveals it at the new tile in one pass when the refresh arrives.
        }, () => this.buildingSprites.get(d.id) === d.sprite && d.sprite.active !== false
          && this.isValidSpot(d.id, d.curTx, d.curTy, d.fp));
      } else {
        this.positionBuilding(d.sprite, d.origTx, d.origTy, d.fp); // auto-revert
        // D3: a rejected drop gets NO refresh (nothing moved server-side), so
        // the hidden copy must come back right here, at the origin tile the
        // sprite just snapped back to — waiting on a refresh that may never
        // come would leave the building frozen un-animated.
        this.ambience.show(d.id);
        this.heroRecovery.show(d.id);
        this.armyStatus?.show(d.id);
      }
    });

    this.input.on('pointerupoutside', (pointer: Phaser.Input.Pointer) => {
      if (!this.acceptsGestureRelease(pointer)) return;
      if (!this.ownsPointerContact(pointer)) { this.prunePointerContacts(pointer); return; }
      this.pointerContacts.delete(pointer.id);
      this.prunePointerContacts(pointer);
      if (pointer.wasCanceled) {
        this.cancelPointerGesture(this.pointerContacts.size > 0);
        return;
      }
      if (this.multiPointerGesture) {
        this.pinch.onUp();
        this.pointerOwnerId = null;
        this.multiPointerGesture = this.pointerContacts.size > 0;
        if (!this.multiPointerGesture) {
          this.setObjectHitTestsSuppressed(false);
          this.flushInteractionIdleWaiters();
        }
        if (!this.multiPointerGesture && (this.ghost || this.layoutDraft)) this.drawPlacementGrid();
        return;
      }
      if (this.pointerOwnerId !== pointer.id) return;
      this.cancelPointerGesture();
    });
    const endGesture = (): void => this.cancelPointerGesture();
    this.input.on('gameout', endGesture);
    this.input.on('pointercancel', endGesture);
    this.game?.events.on(Phaser.Core.Events.BLUR, endGesture);
    this.game?.events.on(Phaser.Core.Events.HIDDEN, endGesture);
    this.unsub.push(() => {
      this.game?.events.off(Phaser.Core.Events.BLUR, endGesture);
      this.game?.events.off(Phaser.Core.Events.HIDDEN, endGesture);
    });

    this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => {
      if (dy === 0) return;
      this.userMovedCamera = true;
      const z = Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.93 : 1.08), this.zoomBand.min, this.zoomBand.max);
      cam.setZoom(z);
      if (this.ghost || this.layoutDraft) this.drawPlacementGrid();
    });
  }

  /** Client-side mirror of the server's geometry check (server re-validates). */
  private isValidSpot(id: string, tx: number, ty: number, fp: Footprint): boolean {
    const base = useApp.getState().base;
    if (!base || !supportedPlotVersion(base.plotVersion)) return false;
    const { min, max } = base.claim;
    if (!isInsidePlot({ tx, ty, ...fp }, base.plotVersion)
      || tx < min || ty < min || tx + fp.fw > max || ty + fp.fh > max) return false;
    const overlaps = (atx: number, aty: number, afw: number, afh: number): boolean =>
      tx < atx + afw && atx < tx + fp.fw && ty < aty + afh && aty < ty + fp.fh;
    for (const b of base.buildings) {
      if (b.id === id) continue;
      if (this.layoutDraft?.trayIds.has(b.id)) continue;
      const draftPosition = this.layoutDraft?.positions.get(b.id);
      if (this.layoutDraft && !draftPosition) continue;
      const ofp = this.footprintOf(this.spriteKeyFor(b));
      if (overlaps(draftPosition?.tx ?? b.tx, draftPosition?.ty ?? b.ty, ofp.fw, ofp.fh)) return false;
    }
    for (const o of base.obstacles) {
      const size = this.meta[`dec_${o.spriteKey}`]?.footprint?.[0] ?? 1;
      if (overlaps(o.tx, o.ty, size, size)) return false;
    }
    return true;
  }

  /** #61: is a 1×1 wall tile free, IGNORING a set of ids (the moving line, which
   *  vacates its old tiles)? Mirrors isValidSpot for a wall footprint. */
  private wallSpotFreeIgnoring(tx: number, ty: number, ignore: Set<string>): boolean {
    const base = useApp.getState().base;
    if (!base || !supportedPlotVersion(base.plotVersion)) return false;
    const { min, max } = base.claim;
    if (!isInsidePlot({ tx, ty, fw: 1, fh: 1 }, base.plotVersion)
      || tx < min || ty < min || tx + 1 > max || ty + 1 > max) return false;
    const hit = (atx: number, aty: number, afw: number, afh: number): boolean =>
      tx < atx + afw && atx < tx + 1 && ty < aty + afh && aty < ty + 1;
    for (const b of base.buildings) {
      if (ignore.has(b.id)) continue;
      const ofp = this.footprintOf(this.spriteKeyFor(b));
      if (hit(b.tx, b.ty, ofp.fw, ofp.fh)) return false;
    }
    for (const o of base.obstacles) {
      const size = this.meta[`dec_${o.spriteKey}`]?.footprint?.[0] ?? 1;
      if (hit(o.tx, o.ty, size, size)) return false;
    }
    return true;
  }

  private showFootprintTint(tx: number, ty: number, fp: Footprint, valid: boolean): void {
    this.clearFootprintTint();
    this.dragTint = this.add
      .rectangle(tx * T, ty * T, fp.fw * T, fp.fh * T, valid ? VALID_TINT : BLOCKED_TINT, valid ? 0.45 : 0.5)
      .setOrigin(0, 0)
      .setStrokeStyle(BASE_CAMERA.placementFootprintPx / this.cameras.main.zoom,
        valid ? VALID_TINT : BLOCKED_TINT)
      .setDepth(overlayDepth(2350));
  }

  private clearFootprintTint(): void {
    this.dragTint?.destroy();
    this.dragTint = null;
  }

  /** While placing or moving, tint EVERY claim tile so the player sees exactly
   *  where a building can land: green = free, red = blocked. Idle view never
   *  creates this Graphics object; the ghost/drag footprint carries local truth. */
  private drawPlacementGrid(): void {
    this.clearPlacementGrid();
    const base = useApp.getState().base;
    if (!base) return;
    const { min, max } = base.claim;
    const g = this.add.graphics().setDepth(overlayDepth(2340)); // above underlay, below the ghost/tint
    for (let ty = min; ty < max; ty++) {
      for (let tx = min; tx < max; tx++) {
        const free = this.isValidSpot('__grid__', tx, ty, { fw: 1, fh: 1 });
        g.fillStyle(free ? VALID_TINT : BLOCKED_TINT, free ? 0.09 : 0.30);
        g.fillRect(tx * T, ty * T, T, T);
      }
    }
    // The tile fills and grid exist only inside the live claim, so they already
    // define its extent. A second outer stroke made placement read as a bright
    // square wall laid over the organic world.
    g.lineStyle(BASE_CAMERA.placementGridLinePx / this.cameras.main.zoom, 0xffffff, 0.10);
    for (let t = min; t <= max; t++) {
      g.lineBetween(min * T, t * T, max * T, t * T);
      g.lineBetween(t * T, min * T, t * T, max * T);
    }
    this.placementGrid = g;
  }

  private clearPlacementGrid(): void {
    this.placementGrid?.destroy();
    this.placementGrid = null;
  }

  /** #61: the contiguous straight run of walls through `startId` — the LONGER of the
   *  horizontal (same ty) or vertical (same tx) run, so a tapped wall selects its
   *  whole line. Returns each wall's id + current tile. */
  private wallLine(startId: string): Array<{ id: string; tx: number; ty: number }> {
    const base = useApp.getState().base;
    if (!base) return [];
    return wallRowThrough(base.buildings.filter((b) => b.type === 'wall'), startId)
      .map((wall) => ({ id: wall.id, tx: wall.tx, ty: wall.ty }));
  }

  /** Widen the selection to the whole wall run through `id` (#61). Purely a state
   *  change now — the run is marked by pulsing its sprites, not by drawing anything
   *  over them. Driven from the ActionSheet's SELECT WHOLE ROW button. */
  private selectWallLine(id: string): void {
    const line = this.wallLine(id);
    if (line.length < 2) { this.wallLineIds.clear(); return; }
    this.wallLineIds = new Set(line.map((w) => w.id));
  }

  private clearWallLine(): void {
    this.wallLineIds.clear();
  }

  /** Breathe the tint of every selected wall from its own art toward the UI gold.
   *  ONE tween drives the whole set, so selecting a 40-tile run costs the same as
   *  selecting one wall — and nothing is drawn on top of the pieces. */
  private setWallPulse(ids: string[]): void {
    this.clearWallPulse();
    if (ids.length === 0) return;
    this.pulseIds = ids;
    const phase = { t: 0 };
    this.pulseTween = this.tweens.add({
      targets: phase,
      t: 1,
      duration: 620,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
      onUpdate: () => {
        const c = Phaser.Display.Color.Interpolate.ColorWithColor(
          PULSE_FROM, PULSE_TO, 100, Math.round(phase.t * 100),
        );
        const tint = Phaser.Display.Color.GetColor(c.r, c.g, c.b);
        for (const id of this.pulseIds) this.buildingSprites.get(id)?.setTint(tint);
      },
    });
  }

  private clearWallPulse(): void {
    this.pulseTween?.remove();
    this.pulseTween = null;
    for (const id of this.pulseIds) this.buildingSprites.get(id)?.clearTint();
    this.pulseIds = [];
  }

  // -------------------------------------------------------------------------
  // Build-placement ghost (HANDOFF §5.1): spawn near the Keep, tap to
  // jump, live green/red tint + range ring; React's bar confirms/cancels.
  // -------------------------------------------------------------------------

  private ghostSpriteKey(type: string): string {
    if (type === 'wall') return wallFrameKey(1);
    if (type === 'spiketrap') return 'bld_spiketrap_armed';
    // Hero altars ship ONE un-leveled master (owner bug 2026-07-28: the ghost
    // asked for bld_siegestool_l1 — a frame that doesn't exist — and Phaser's
    // missing-frame fallback rendered the KEEP tower as the placement ghost).
    if (type === 'heroaltar' || type === 'siegestool') return `bld_${type}`;
    // Rework-v2 cannon/mortar: the ghost keys exactly like a freshly placed L1
    // building (spriteKeyFor) — the tier-1 v2 idle master when its atlas is in,
    // otherwise the eager fallback alias, an exact copy of that frame. The old
    // `bld_cannon_l1` ghost was the retired legacy sprite (owner 2026-09-17:
    // "old retired art appeared … once you press place it's correct").
    if ((ART_V2.buildings as readonly string[]).includes(type)) {
      return isV2AtlasLoaded(this, `v2bld_${type}_t1`) ? `v2_bld_${type}_t1_idle_d0_f1` : v2BuildingFallbackFrameKey(type as 'cannon' | 'mortar', 1, 1);
    }
    return `bld_${type}_l1`;
  }

  private startGhost(type: string): void {
    if (!supportedPlotVersion(useApp.getState().base?.plotVersion)) return;
    this.endGhost();
    this.clearWallLine(); // #61: drop any wall-line selection when entering placement
    this.clearWallPulse();
    const key = this.ghostSpriteKey(type);
    const fp = this.footprintOf(key);
    // A novice can place immediately without hunting for a ghost in the far
    // corner. Prefer the closest legal tile to the Keep; row order breaks ties.
    const base = useApp.getState().base;
    const claim = base?.claim ?? {
      min: (GRID.plotTiles - GRID.claimTiles) / 2,
      max: (GRID.plotTiles + GRID.claimTiles) / 2,
    };
    const keep = base?.buildings.find((b) => b.type === 'keep');
    let spot = { tx: claim.min, ty: claim.min };
    let bestDistance = Infinity;
    for (let ty = claim.min; ty <= claim.max - fp.fh; ty++) {
      for (let tx = claim.min; tx <= claim.max - fp.fw; tx++) {
        if (!this.isValidSpot('__ghost__', tx, ty, fp)) continue;
        const distance = keep ? (tx - keep.tx) ** 2 + (ty - keep.ty) ** 2 : 0;
        if (distance < bestDistance) { spot = { tx, ty }; bestDistance = distance; }
      }
    }
    const sprite = this.add.sprite(0, 0, atlasFor(key), key).setAlpha(0.9).setDepth(LIFT_DEPTH);
    this.ghost = { type, sprite, fp, tx: spot.tx, ty: spot.ty, valid: true, ring: null };
    // The base-wide army annotation must not cover the tiles being chosen.
    // Keep its live data intact and reveal it again when placement finishes.
    this.armyStatus?.setSuppressed(true);
    // Walls enter SWIPE-paint mode (#59): drag to queue a run, release to place it.
    if (type === 'wall') {
      this.wallPaint = { tiles: [], set: new Set(), gfx: this.add.graphics().setDepth(overlayDepth(2400)) };
    }
    this.drawPlacementGrid(); // show every buildable/blocked tile for the whole claim
    this.moveGhost(spot.tx, spot.ty);
  }

  /** Add one wall tile to the current swipe-paint set (valid + not already queued),
   *  painting it green. No-op off wall-paint mode. */
  private paintWallTile(rawTx: number, rawTy: number): void {
    if (!this.wallPaint || !this.ghost) return;
    const g = this.ghost;
    const { tx, ty } = clampPlotPosition(rawTx, rawTy, g.fp.fw, g.fp.fh, useApp.getState().base?.plotVersion);
    const key = `${tx},${ty}`;
    if (this.wallPaint.set.has(key)) return;
    if (!this.isValidSpot('__ghost__', tx, ty, g.fp)) return; // skip blocked tiles
    this.wallPaint.set.add(key);
    this.wallPaint.tiles.push({ tx, ty });
    this.wallPaint.gfx.fillStyle(0x5fe36a, 0.5).fillRect(tx * T, ty * T, T, T);
  }

  private moveGhost(tx: number, ty: number): void {
    if (!this.ghost) return;
    const g = this.ghost;
    Object.assign(g, clampPlotPosition(tx, ty, g.fp.fw, g.fp.fh, useApp.getState().base?.plotVersion));
    g.valid = this.isValidSpot('__ghost__', g.tx, g.ty, g.fp);
    this.positionLiftedBuilding(g.sprite, g.tx, g.ty, g.fp);
    this.showFootprintTint(g.tx, g.ty, g.fp, g.valid);
    // detached lift shadow under the placing ghost, at ground level (§5)
    const groundY = (g.ty + g.fp.fh) * T;
    if (!this.liftShadow) {
      this.liftShadow = liftShadow(this, g.tx * T, groundY, g.fp.fw, g.fp.fh, T);
    } else {
      this.liftShadow.setPosition(
        g.tx * T + (g.fp.fw * T) / 2,
        groundY - (g.fp.fh > 1 ? T : T / 2) / 2,
      );
    }
    // live range ring on defense ghosts (HANDOFF §5.1)
    const ring = RANGE_RING[g.type];
    if (ring) {
      const cx = (g.tx + g.fp.fw / 2) * T;
      const cy = (g.ty + g.fp.fh / 2) * T;
      if (!g.ring) {
        g.ring = this.add.image(cx, cy, 'ovl', ring.frame)
          .setDepth(ring.depth).setAlpha(0.8);
        if (ring.scale !== 1) g.ring.setScale(ring.scale);
      } else g.ring.setPosition(cx, cy);
    }
    bus.emit('build:spot', { tx: g.tx, ty: g.ty, valid: g.valid });
  }

  private endGhost(): void {
    this.liftShadow?.destroy();
    this.liftShadow = null;
    this.clearPlacementGrid();
    if (this.wallPaint) { this.wallPaint.gfx.destroy(); this.wallPaint = null; }
    if (!this.ghost) return;
    this.wallArtDirty = true;
    this.ghost.sprite.destroy();
    this.ghost.ring?.destroy();
    this.ghost = null;
    this.armyStatus?.setSuppressed(this.layoutDraft !== null);
    this.clearFootprintTint();
  }

  /** Four compact gold corners, tight to the canonical occupied tiles. */
  private showSelection(buildingId: string | null): void {
    this.selectCorners.forEach((c) => c.destroy());
    this.selectCorners = [];
    if (!buildingId) { this.clearWallPulse(); return; }
    const sprite = this.buildingSprites.get(buildingId);
    if (!sprite) { this.clearWallPulse(); return; }
    const selected = useApp.getState().base?.buildings.find((b) => b.id === buildingId);
    // A wall is one tile: bracket corners and an outline swamp the piece they mark.
    // Walls get the pulse instead — over the whole run when the row is selected.
    if (selected?.type === 'wall') {
      this.setWallPulse(this.wallLineIds.size > 1 ? [...this.wallLineIds] : [buildingId]);
      return;
    }
    this.clearWallPulse();
    const tx = sprite.getData('tx') as number;
    const ty = sprite.getData('ty') as number;
    const fp = this.positionedFootprint(sprite);
    const pts: Array<[number, number, number]> = [
      [tx * T, ty * T, 0],
      [(tx + fp.fw) * T, ty * T, 90],
      [(tx + fp.fw) * T, (ty + fp.fh) * T, 180],
      [tx * T, (ty + fp.fh) * T, 270],
    ];
    for (const [x, y, angle] of pts) {
      this.selectCorners.push(
        this.add.image(x, y, 'ovl', 'ovl_select_corner').setAngle(angle).setDepth(overlayDepth(2300)),
      );
    }
    // defenses show their range ring automatically on select (HANDOFF §5.3)
    const overlays = selected ? selectionRangeOverlays(selected.type, selected.level) : [];
    if (overlays.length > 0) {
      const cx = (tx + fp.fw / 2) * T;
      const cy = (ty + fp.fh / 2) * T;
      for (const overlay of overlays) {
        const image = this.add.image(cx, cy, 'ovl', overlay.frame)
          .setDepth(overlay.depth).setAlpha(0.8);
        if (overlay.scale !== 1) image.setScale(overlay.scale);
        this.selectCorners.push(image);
      }
    }
  }
}
