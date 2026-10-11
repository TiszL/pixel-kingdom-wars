import { existsSync, readFileSync } from 'node:fs';
import {
  BASE_CAMERA, DEFENSES, KEEP_BATTERIES, isRetiredRuntimeSpriteKey,
  v2BuildingFallbackFrameKey,
  v2GloamfangCombatAtlasGroup,
  v2LocomotionAtlasGroup,
  structureDepth,
  WORLD_DEPTH,
} from '@shardkeep/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../lib/events';
import { EmptyTapGesture } from '../input/emptyTap';
import { createPanelSession, type PanelDismissRequest } from '../../ui/pk/panelSession';
import { useApp, type BaseStateDto } from '../../state/store';
import {
  admitAtlasCandidates, BASE_ART_RETRY_DELAYS_MS, basePatrolFirstCandidates,
} from '../world/artBudget';
import { skirtDecor } from '../world/underlay';
import { Occupancy } from '../world/occupancy';
import { v2BldDrawScale } from '../v2/clips';
import { PinchZoom } from '../world/pinch';
import { wareBuildingClipKey } from '../ware/clips';
import { parseMarketArtMetadata, selectMarketAwnings } from '../world/marketArt';
import { EMPTY_STARTER_FLEET_ART, parseStarterFleetMetadata } from '../world/fleetArt';
import { BerthBuildingFx } from '../fx/berthBuilding';
import type { FleetJourneyEvent } from '@shardkeep/shared/fleetJourneyPresentation';
import { BERTH_UNPRESENTED_KEY, EMPTY_ADVANCED_FLEET_ART, parseAdvancedFleetMetadata } from '../world/advancedFleetArt';
vi.mock('../world/sceneVisualGate', () => ({ SceneVisualGate: class {
  loading = vi.fn(); update = vi.fn(); destroy = vi.fn();
} }));

// BaseScene is a Phaser class, but the atlas completion seam only needs scene
// activity plus renderFromStore. Keep this lifecycle regression deterministic
// in Node instead of booting a renderer and a real shared LoaderPlugin.
vi.mock('phaser', () => ({
  default: {
    Scene: class {},
    Display: { Color: class {} },
    Geom: {
      Rectangle: class {
        constructor(
          public x: number, public y: number, public width: number, public height: number,
        ) {}
        get right(): number { return this.x + this.width; }
        get bottom(): number { return this.y + this.height; }
      },
    },
    Math: {
      Clamp: (value: number, min: number, max: number) => Math.max(min, Math.min(max, value)),
      Distance: { Between: (x1: number, y1: number, x2: number, y2: number) => Math.hypot(x2 - x1, y2 - y1) },
    },
    Scale: { Events: { RESIZE: 'resize' } },
    Core: { Events: { BLUR: 'blur', HIDDEN: 'hidden' } },
    Scenes: { Events: { SLEEP: 'sleep', WAKE: 'wake', SHUTDOWN: 'shutdown' } },
  },
}));

const atlas = vi.hoisted(() => ({
  admitOnDemandAtlasCandidates: vi.fn((
    _scene: unknown,
    _bytes: Readonly<Record<string, number>>,
    _candidates: readonly { id: string; groups: readonly string[] }[],
  ) => new Set<string>()),
  ensureV2Atlases: vi.fn(),
  isV2AtlasLoaded: vi.fn(),
  releaseAtlasGroups: vi.fn(),
  releaseAtlasReservations: vi.fn(),
  releaseUnreferencedAtlases: vi.fn(),
  // Default: a hold nobody exercises. The patrol-art case below replaces this
  // with the real counting behaviour so the sweep it drives can honour it.
  retainAtlasGroups: vi.fn((_scene: unknown, _groups: Iterable<string>) => (): void => {}),
}));

vi.mock('../world/atlasLoader', () => ({
  admitOnDemandAtlasCandidates: atlas.admitOnDemandAtlasCandidates,
  ensureTroopLevelAtlases: vi.fn(() => Promise.resolve()),
  ensureV2Atlases: atlas.ensureV2Atlases,
  isTroopLevelAtlasLoaded: vi.fn(() => false),
  isV2AtlasLoaded: atlas.isV2AtlasLoaded,
  releaseAtlasGroups: atlas.releaseAtlasGroups,
  releaseAtlasReservations: atlas.releaseAtlasReservations,
  releaseUnreferencedAtlases: atlas.releaseUnreferencedAtlases,
  releaseUnusedAtlases: vi.fn(),
  retainAtlasGroups: atlas.retainAtlasGroups,
}));

// The move-gesture cases below drive the REAL pointerup, which fires the drop
// juice. Neither the FX layer nor Web Audio has anything to say about which
// tile owns a sprite, and both want a live renderer/AudioContext.
vi.mock('../world/fx', () => ({
  dustPuff: vi.fn(),
  liftShadow: vi.fn(() => ({ setPosition: vi.fn(), destroy: vi.fn() })),
}));
vi.mock('../../lib/audio', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  playSfx: vi.fn(),
}));

it('opts the home base into slower authored building loops without restarting on unchanged snapshots', async () => {
  const { BaseScene } = await import('./BaseScene');
  const proto = BaseScene.prototype as unknown as { syncWareController: (b: unknown, sprite: unknown, job: string | null) => void };
  const sprite = { active: true, setOrigin: () => sprite, setScale: () => sprite };
  const scene = {
    wareGroupForBuilding: () => 'warebld', wareBuildings: new Map(),
    ticker: { unregister: vi.fn() }, wareTicker: { play: vi.fn() },
    waremeta: { clips: { [wareBuildingClipKey('barracks', 1, 'idle')]: {
      frames: 2, rows: 1, cellW: 32, cellH: 32, anchorPx: [16, 16], fps: 12,
    } } },
  };
  atlas.isV2AtlasLoaded.mockReturnValueOnce(true).mockReturnValueOnce(true);
  const building = { id: 'cadence-barracks', type: 'barracks', level: 1 };
  proto.syncWareController.call(scene, building, sprite, null);
  expect(scene.wareTicker.play).toHaveBeenCalledExactlyOnceWith(sprite, expect.objectContaining({ fps: 9, loop: true }));
  proto.syncWareController.call(scene, building, sprite, null);
  expect(scene.wareTicker.play).toHaveBeenCalledOnce();
});

interface Candidate { id: string; groups: readonly string[] }

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type LoadV2Candidates = (
  this: Record<string, unknown>,
  candidates: readonly Candidate[],
) => Promise<void>;

interface RetryState {
  candidateId: string;
  nextDelayIndex: number;
  dueAt: number | null;
  inFlight: boolean;
  exhausted: boolean;
}

interface FakeRetryTimer {
  dueAt: number;
  removed: boolean;
  callback: () => void;
  remove: (dispatchCallback?: boolean) => void;
}

function retryScene(): {
  scene: Record<string, unknown> & {
    renderFromStore: ReturnType<typeof vi.fn>;
    artRetryStates: Map<string, RetryState>;
    artRetryKeyByCandidate: Map<string, string>;
    artRetryTimer: FakeRetryTimer | null;
    artRetryTimerDueAt: number | null;
    time: { now: number; delayedCall: ReturnType<typeof vi.fn> };
  };
  advanceToNextRetry: () => void;
} {
  const timers: FakeRetryTimer[] = [];
  const scene = {
    scene: { isActive: () => true },
    renderFromStore: vi.fn(),
    artRetryStates: new Map<string, RetryState>(),
    artRetryKeyByCandidate: new Map<string, string>(),
    artRetryTimer: null as FakeRetryTimer | null,
    artRetryTimerDueAt: null as number | null,
    time: {
      now: 0,
      delayedCall: vi.fn((delay: number, callback: () => void): FakeRetryTimer => {
        const timer: FakeRetryTimer = {
          dueAt: scene.time.now + delay,
          removed: false,
          callback,
          remove: vi.fn(() => { timer.removed = true; }),
        };
        timers.push(timer);
        return timer;
      }),
    },
  };
  return {
    scene,
    advanceToNextRetry: () => {
      const timer = timers.find((candidate) => !candidate.removed);
      expect(timer, 'a candidate retry should be pending').toBeDefined();
      scene.time.now = timer!.dueAt;
      timer!.removed = true;
      timer!.callback();
    },
  };
}

async function loaderMethod(): Promise<LoadV2Candidates> {
  const { BaseScene } = await import('./BaseScene');
  return (BaseScene.prototype as unknown as {
    loadV2Candidates: (
      candidates: readonly Candidate[],
    ) => Promise<void>;
  }).loadV2Candidates;
}

describe('BaseScene V2 candidate loading', () => {
  const loaded = new Set<string>();
  let load: LoadV2Candidates;

  // Import Phaser/BaseScene once outside the timed lifecycle cases. Under the
  // full 50+ file web run, paying the cold transform/import inside test #1 could
  // exceed Vitest's 5s case timeout; its still-running promise then leaked mock
  // calls into case #2. The behavior assertions themselves are synchronous once
  // this shared seam is available.
  beforeAll(async () => { load = await loaderMethod(); }, 20_000);

  beforeEach(() => {
    vi.clearAllMocks();
    loaded.clear();
    atlas.isV2AtlasLoaded.mockImplementation((_scene, group: string) => loaded.has(group));
  });

  it('adopts a late builder group before sweeping and reserves builders before patrol', () => {
    const source = readFileSync(new URL('./BaseScene.ts', import.meta.url), 'utf8');
    const jobSync = source.indexOf('const completed = this.jobs.sync(');
    const sweep = source.indexOf('releaseUnreferencedAtlases(this);', jobSync);
    expect(jobSync).toBeGreaterThan(-1);
    expect(sweep).toBeGreaterThan(jobSync);

    const builderRequest = source.slice(source.indexOf('const builderCandidates:'), source.indexOf('const enhancementCandidates'));
    expect(builderRequest).toContain('if (base.jobs.length > 0)');
    expect(builderRequest).toContain('requiredBuilderAtlasGroups(this.builderClips)');
    expect(builderRequest).toContain("id: 'builder:workman'");
    expect(builderRequest).not.toMatch(/tunneler|keep\.level|artTierOfLevel/);

    const candidates = source.indexOf('const v2Candidates = [');
    const builder = source.indexOf('...builderCandidates', candidates);
    const patrol = source.indexOf('...basePatrolFirstCandidates', candidates);
    const nest = source.indexOf('residentNestCandidates)', patrol);
    const optional = source.indexOf('enhancementCandidates)', nest);
    expect(candidates).toBeGreaterThan(-1);
    expect(builder).toBeGreaterThan(candidates);
    expect(patrol).toBeGreaterThan(builder);
    expect(nest).toBeGreaterThan(patrol);
    expect(optional).toBeGreaterThan(nest);
  });

  it('does not sleep an already-hidden base again when battle entry arrives', () => {
    // setScreen('battle') reaches PhaserGame's screen subscriber before the
    // battle:enter event on the normal UI path. Phaser warns when the latter
    // blindly sleeps the same scene a second time, hiding real mobile lifecycle
    // warnings in diagnostics.
    const source = readFileSync(new URL('./BaseScene.ts', import.meta.url), 'utf8');
    const enter = source.indexOf("bus.on('battle:enter'");
    const run = source.indexOf("this.scene.run('battle'", enter);
    const lifecycle = source.slice(enter, run);
    expect(enter).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(enter);
    expect(lifecycle).toContain("if (this.scene.isActive('base')) this.scene.sleep('base');");
  });

  it('keeps every Dragon Nest tier resident before dense optional WARE art', () => {
    for (const tier of [1, 2, 3, 4]) {
      const nest = {
        id: `ware:ware_dragonnest_${tier}`,
        groups: [`ware_dragonnest_${tier}`],
      };
      const optional = Array.from({ length: 20 }, (_, index) => ({
        id: `ware:optional-${String(index).padStart(2, '0')}`,
        groups: [`optional-${index}`],
      }));
      const candidates = [
        ...basePatrolFirstCandidates([], [nest]),
        ...basePatrolFirstCandidates([], optional),
      ];
      const bytes = Object.fromEntries(candidates.flatMap((candidate) =>
        candidate.groups.map((group) => [group, 10])));
      const admission = admitAtlasCandidates(bytes, 0, new Set(), new Set(), candidates, 10);
      expect(admission.accepted).toEqual(new Set([nest.id]));
    }
  });

  it('follows selected-base terrain while layout rendering continues from the same store', async () => {
    const proto = await scenePrototype();
    const scene = patrolHarness(proto);
    const ground = { set: vi.fn(), setClaim: vi.fn(), obstacleSprite: vi.fn(() => undefined) };
    Object.assign(scene, { fantasyGround: ground });
    const prior = useApp.getState().base;
    try {
      for (const realmId of ['frostveil', 'sunscar'] as const) {
        const visualContext = { version: 1, realmId, artVersion: 1 } as const;
        useApp.setState({ base: { ...garrisonBase(), visualContext } });
        proto.renderFromStore.call(scene);
        expect(ground.set).toHaveBeenLastCalledWith(visualContext);
        // Revision 5 renders the kingdom/wilderness state from this exact server
        // claim (REALM-KIT-PLAN §3); the scene hands it over on every store pass.
        expect(ground.setClaim).toHaveBeenLastCalledWith({ min: 4, max: 16 });
      }
    } finally { useApp.setState({ base: prior }); }
  });

  it('classifies live T1-T4 Dragon Nests as functional candidates', async () => {
    const proto = await scenePrototype();
    const scene = patrolHarness(proto);
    const prior = useApp.getState().base;
    atlas.admitOnDemandAtlasCandidates.mockImplementation(
      (_scene, _bytes, candidates: readonly Candidate[]) => new Set(candidates.map(({ id }) => id)),
    );
    scene.wareGroupForBuilding.mockImplementation(
      (building?: { level: number }) => building
        ? `ware_dragonnest_${Math.ceil(building.level / 5)}`
        : null,
    );
    useApp.setState({
      base: {
        ...garrisonBase(),
        army: [],
        buildings: [1, 6, 11, 16].map((level, index) => ({
          id: `nest-${index + 1}`, type: 'dragonnest', level,
          tx: 4 + index * 3, ty: 6, underConstruction: false,
        })),
      } as BaseStateDto,
    });
    try {
      proto.renderFromStore.call(scene);
      const candidates = scene.loadV2Candidates.mock.calls[0]![0] as Candidate[];
      expect(candidates.map(({ id }) => id)).toEqual([
        'ware:ware_dragonnest_1', 'ware:ware_dragonnest_2',
        'ware:ware_dragonnest_3', 'ware:ware_dragonnest_4',
      ]);
    } finally {
      useApp.setState({ base: prior });
      atlas.admitOnDemandAtlasCandidates.mockReturnValue(new Set());
    }
  });

  it('reclaims an inactive late success without targeting live towers or shared groups', async () => {
    const late = deferred();
    let active = true;
    const scene = {
      scene: { isActive: () => active },
      renderFromStore: vi.fn(),
    };
    loaded.add('v2bld_cannon_t1');
    loaded.add('v2bld_mortar_t3');
    loaded.add('v2fx');
    atlas.ensureV2Atlases.mockImplementation(async (_scene, groups: Iterable<string>) => {
      await late.promise;
      for (const group of groups) loaded.add(group);
    });

    const completion = load.call(scene, [
      { id: 'cannon', groups: ['v2bld_cannon_t1'] },
      { id: 'mortar', groups: ['v2bld_mortar_t3'] },
      { id: 'patrol', groups: ['v2trp_bowman_t1', 'v2fx'] },
    ]);
    active = false; // BaseScene slept while the patrol sheet was downloading.
    late.resolve();
    await completion;

    expect(scene.renderFromStore).not.toHaveBeenCalled();
    expect(atlas.ensureV2Atlases).toHaveBeenCalledTimes(1);
    expect([...atlas.ensureV2Atlases.mock.calls[0]![1] as Iterable<string>])
      .toEqual(['v2trp_bowman_t1']);
    expect(atlas.releaseAtlasGroups).toHaveBeenCalledWith(
      scene, new Set(['v2trp_bowman_t1']),
    );
    expect(atlas.releaseAtlasReservations).toHaveBeenCalledWith(
      scene, new Set(['v2trp_bowman_t1']),
    );
  });

  it('adopts successful candidates while releasing a failed candidate partial', async () => {
    const lifecycle: string[] = [];
    const scene = {
      scene: { isActive: () => true },
      renderFromStore: vi.fn(() => { lifecycle.push('render'); }),
    };
    atlas.releaseAtlasGroups.mockImplementation(() => { lifecycle.push('evict'); return 0; });
    atlas.releaseAtlasReservations.mockImplementation(() => { lifecycle.push('release'); });
    atlas.ensureV2Atlases.mockImplementation(async (_scene, groups: Iterable<string>) => {
      const requested = [...groups];
      if (requested.includes('v2trp_troll_t1')) {
        // Phaser COMPLETE can register one group while another file in the
        // candidate failed. The partial must remain fallback-only and evictable.
        loaded.add('v2trp_troll_t1');
        loaded.add('v2shared_base');
        throw new Error('troll dependency failed');
      }
      requested.forEach((group) => loaded.add(group));
    });

    await load.call(scene, [
      {
        id: 'troll',
        groups: ['v2trp_troll_t1', 'v2trp_troll_extra_t1', 'v2shared_base'],
      },
      { id: 'bowman', groups: ['v2trp_bowman_t1', 'v2shared_base'] },
    ]);

    // The old aggregate Promise.all catch skipped this render, leaving the
    // successfully loaded bowman on legacy until an unrelated later refresh.
    expect(scene.renderFromStore).toHaveBeenCalledOnce();
    expect(lifecycle).toEqual(['evict', 'release', 'render']);
    expect(atlas.releaseAtlasGroups).toHaveBeenCalledWith(
      scene, new Set(['v2trp_troll_t1', 'v2trp_troll_extra_t1']),
    );
    expect(atlas.releaseAtlasReservations).toHaveBeenCalledWith(
      scene, new Set(['v2trp_troll_t1', 'v2trp_troll_extra_t1']),
    );
    const released = atlas.releaseAtlasGroups.mock.calls[0]![1] as Set<string>;
    expect(released.has('v2trp_bowman_t1')).toBe(false);
    expect(released.has('v2shared_base')).toBe(false);
  });

  it('stops loading an exhausted unchanged current-art signature across rerenders', async () => {
    const { scene, advanceToNextRetry } = retryScene();
    atlas.ensureV2Atlases.mockRejectedValue(new Error('offline'));
    const candidate = [{ id: 'bowman', groups: ['v2trp_bowman_t1'] }];

    await load.call(scene, candidate); // initial request
    for (let retry = 0; retry < BASE_ART_RETRY_DELAYS_MS.length; retry++) {
      expect(scene.time.delayedCall).toHaveBeenNthCalledWith(
        retry + 1, BASE_ART_RETRY_DELAYS_MS[retry], expect.any(Function),
      );
      advanceToNextRetry();
      await load.call(scene, candidate);
    }

    await load.call(scene, candidate);
    await load.call(scene, candidate);
    expect(atlas.ensureV2Atlases).toHaveBeenCalledTimes(4); // initial + three retries
    expect(atlas.releaseAtlasReservations).toHaveBeenCalledTimes(6);
    expect(atlas.releaseAtlasReservations).toHaveBeenNthCalledWith(
      5, scene, new Set(['v2trp_bowman_t1']),
    );
    expect(atlas.releaseAtlasReservations).toHaveBeenNthCalledWith(
      6, scene, new Set(['v2trp_bowman_t1']),
    );
    expect(scene.time.delayedCall).toHaveBeenCalledTimes(BASE_ART_RETRY_DELAYS_MS.length);
    expect(scene.renderFromStore).toHaveBeenCalledTimes(BASE_ART_RETRY_DELAYS_MS.length);
    expect([...scene.artRetryStates.values()]).toEqual([
      expect.objectContaining({ candidateId: 'bowman', exhausted: true }),
    ]);
  });

  it('releases only an exhausted orphan while a live candidate owns the shared dependency', async () => {
    const { scene, advanceToNextRetry } = retryScene();
    atlas.ensureV2Atlases.mockRejectedValue(new Error('offline'));
    const exhausted = [{
      id: 'troop:bowman', groups: ['v2shared_base', 'v2trp_bowman_t1'],
    }];

    await load.call(scene, exhausted);
    for (let retry = 0; retry < BASE_ART_RETRY_DELAYS_MS.length; retry++) {
      advanceToNextRetry();
      await load.call(scene, exhausted);
    }

    const live = deferred();
    atlas.ensureV2Atlases.mockImplementation(async (_scene, groups: Iterable<string>) => {
      await live.promise;
      for (const group of groups) loaded.add(group);
    });
    const completion = load.call(scene, [
      ...exhausted,
      { id: 'troop:troll', groups: ['v2shared_base', 'v2trp_troll_t1'] },
    ]);
    await Promise.resolve();

    expect(atlas.releaseAtlasReservations).toHaveBeenLastCalledWith(
      scene, new Set(['v2trp_bowman_t1']),
    );
    const orphanRelease = atlas.releaseAtlasReservations.mock.calls.at(-1)![1] as Set<string>;
    expect(orphanRelease.has('v2shared_base')).toBe(false);

    live.resolve();
    await completion;
    expect(scene.renderFromStore).toHaveBeenCalled();
  });

  it('resets the bounded sequence when the same candidate requests a new tier/group signature', async () => {
    const { scene, advanceToNextRetry } = retryScene();
    atlas.ensureV2Atlases.mockRejectedValue(new Error('offline'));
    const tierOne = [{
      id: 'troop:bowman', groups: ['v2shared_base', 'v2trp_bowman_t1'],
    }];

    await load.call(scene, tierOne);
    for (let retry = 0; retry < BASE_ART_RETRY_DELAYS_MS.length; retry++) {
      advanceToNextRetry();
      await load.call(scene, tierOne);
    }
    expect(atlas.ensureV2Atlases).toHaveBeenCalledTimes(4);

    // Group order is not a signature change, so it must remain exhausted.
    await load.call(scene, [{
      id: 'troop:bowman', groups: ['v2trp_bowman_t1', 'v2shared_base'],
    }]);
    expect(atlas.ensureV2Atlases).toHaveBeenCalledTimes(4);

    // A real tier change is new current art and starts again immediately.
    await load.call(scene, [{
      id: 'troop:bowman', groups: ['v2shared_base', 'v2trp_bowman_t2'],
    }]);
    expect(atlas.ensureV2Atlases).toHaveBeenCalledTimes(5);
    expect(scene.time.delayedCall).toHaveBeenLastCalledWith(
      BASE_ART_RETRY_DELAYS_MS[0], expect.any(Function),
    );
    expect([...scene.artRetryStates.values()]).toEqual([
      expect.objectContaining({ candidateId: 'troop:bowman', nextDelayIndex: 1 }),
    ]);
  });

  it('keeps mixed candidate due times independent and adopts each success', async () => {
    const { scene } = retryScene();
    const bowman = { id: 'troop:bowman', groups: ['v2trp_bowman_t1'] };
    const troll = { id: 'troop:troll', groups: ['v2trp_troll_t1'] };
    const attempts = new Map<string, number>();
    atlas.ensureV2Atlases.mockImplementation(async (_scene, groups: Iterable<string>) => {
      const [group] = [...groups];
      const attempt = attempts.get(group!) ?? 0;
      attempts.set(group!, attempt + 1);
      if (attempt === 0) throw new Error(`${group} offline once`);
      loaded.add(group!);
    });

    await load.call(scene, [bowman]); // bowman due at 1,000
    scene.time.now = 500;
    await load.call(scene, [bowman, troll]); // troll due at 1,500; bowman stays waiting
    expect(atlas.ensureV2Atlases.mock.calls.map((call) => [...call[1] as Iterable<string>]))
      .toEqual([['v2trp_bowman_t1'], ['v2trp_troll_t1']]);

    scene.time.now = 1_000;
    await load.call(scene, [bowman, troll]);
    expect(loaded.has('v2trp_bowman_t1')).toBe(true);
    expect(loaded.has('v2trp_troll_t1')).toBe(false);
    expect(scene.artRetryTimerDueAt).toBe(1_500);

    scene.time.now = 1_500;
    await load.call(scene, [bowman, troll]);
    expect(atlas.ensureV2Atlases.mock.calls.map((call) => [...call[1] as Iterable<string>]))
      .toEqual([
        ['v2trp_bowman_t1'], ['v2trp_troll_t1'],
        ['v2trp_bowman_t1'], ['v2trp_troll_t1'],
      ]);
    expect(loaded).toEqual(new Set(['v2trp_bowman_t1', 'v2trp_troll_t1']));
    expect(scene.renderFromStore).toHaveBeenCalledTimes(2);
    expect(scene.artRetryStates.size).toBe(0);
  });

  it('serializes rich groups and holds their stitch boundary until pointer-idle', async () => {
    const proto = await scenePrototype();
    const firstArrival = deferred();
    const secondArrival = deferred();
    const started: string[] = [];
    const stitched: string[] = [];
    atlas.ensureV2Atlases.mockImplementation(async (
      _scene: unknown,
      groups: Iterable<string>,
      scheduling?: { beforeTextureInsert?: () => Promise<void> },
    ) => {
      const [group] = [...groups];
      started.push(group!);
      await (group === 'first' ? firstArrival.promise : secondArrival.promise);
      await scheduling?.beforeTextureInsert?.();
      stitched.push(group!);
    });
    const scene = {
      scene: { isActive: () => true },
      pointerOwnerId: 1 as number | null,
      multiPointerGesture: false,
      richArtLoadsStopped: false,
      richArtLoadTail: Promise.resolve(),
      interactionIdleWaiters: new Set<{
        resolve: () => void; reject: (cause: Error) => void;
      }>(),
      pointerInteractionActive: proto.pointerInteractionActive,
      waitForInteractionIdle: proto.waitForInteractionIdle,
    };

    const first = proto.queueV2AtlasLoad.call(scene, ['first']);
    const second = proto.queueV2AtlasLoad.call(scene, ['second']);
    await Promise.resolve();
    expect(started).toEqual([]); // a live press delays even the first request

    scene.pointerOwnerId = null;
    proto.flushInteractionIdleWaiters.call(scene);
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(['first']); // one candidate at a time

    scene.pointerOwnerId = 1; // a new pan began while the PNG was in flight
    firstArrival.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(stitched).toEqual([]); // no addAtlas / upload boundary mid-pan
    expect(started).toEqual(['first']);

    scene.pointerOwnerId = null;
    proto.flushInteractionIdleWaiters.call(scene);
    await first;
    await vi.waitFor(() => expect(started).toEqual(['first', 'second']));
    expect(stitched).toEqual(['first']);

    secondArrival.resolve();
    await second;
    expect(stitched).toEqual(['first', 'second']);
  });
});

type ScenePrototype = {
  holdSettlingMove: (
    pieces: ReadonlyArray<{ id: string; tx: number; ty: number }>, fp: { fw: number; fh: number },
  ) => void;
  reseatSettlingMoves: () => void;
  releaseSettlingMoves: (buildingIds: readonly string[]) => void;
  refreshFootprintHitArea: (
    sprite: Record<string, unknown>, tx: number, ty: number, fp: { fw: number; fh: number },
  ) => void;
  setObjectHitTestsSuppressed: (suppressed: boolean) => void;
  isTouchPointer: (pointer: Record<string, unknown>) => boolean;
  suppressObjectHitTestsForTouchPan: (pointer: Record<string, unknown>) => void;
  pointerInteractionActive: () => boolean;
  waitForInteractionIdle: () => Promise<void>;
  flushInteractionIdleWaiters: () => void;
  queueV2AtlasLoad: (groups: readonly string[]) => Promise<void>;
  positionBuilding: (
    sprite: Record<string, unknown>, tx: number, ty: number, fp: { fw: number; fh: number },
  ) => void;
  positionLiftedBuilding: (
    sprite: Record<string, unknown>, tx: number, ty: number, fp: { fw: number; fh: number },
  ) => void;
  positionedFootprint: (sprite: Record<string, unknown>) => { fw: number; fh: number };
  buildingSeat: (frame: string) => {
    origin: readonly [number, number]; scale: number;
    offsetGamePx: readonly [number, number];
  };
  acceptsObjectGesture: (pointer: Record<string, unknown>) => boolean;
  acceptsGestureRelease: (pointer: Record<string, unknown>) => boolean;
  attachBuildingInput: (sprite: Record<string, unknown>) => void;
  attachObstacleInput: (sprite: Record<string, unknown>, obstacleId: string) => void;
  beginBuildingPress: (sprite: Record<string, unknown>, pointer: Record<string, unknown>) => void;
  beginObstaclePress: (obstacleId: string, pointer: Record<string, unknown>) => void;
  clearWallStroke: () => void;
  clearLayoutWallStroke: () => void;
  cancelPointerGesture: (holdUntilPointersLift?: boolean) => void;
  beginMultiPointerGesture: () => void;
  registerPointerDown: (pointer: Record<string, unknown>) => boolean;
  prunePointerContacts: (pointer?: Record<string, unknown>, endingId?: number) => boolean;
  ownsPointerContact: (pointer: Record<string, unknown>) => boolean;
  commitObstaclePress: (obstacleId: string, pointer: Record<string, unknown>) => void;
  footprintObjectAt: (worldX: number, worldY: number) => Record<string, unknown> | null;
  showSelection: (buildingId: string | null) => void;
  setupCameraInput: () => void;
  rebandCamera: () => void;
  commandCamera: (op: 'in' | 'out' | 'fit') => void;
  onResize: (
    gameSize: { width: number; height: number }, baseSize: unknown, displaySize: unknown,
    previousWidth: number, previousHeight: number,
  ) => void;
  focusObject: (kind: 'building' | 'obstacle', id: string) => void;
  applyInsets: (i: { top: number; bottom: number; left?: number; right?: number }) => void;
  releaseV2DefenseArtForBattle: () => void;
  releaseV2DefenseArtForPatrol: () => boolean;
  releaseDisplayedV2DefenseArt: (hideUntilReload: boolean) => boolean;
  spriteKeyFor: (building: Record<string, unknown>) => string;
  ghostSpriteKey: (type: string) => string;
  startGhost: (type: string) => void;
  endGhost: () => void;
  moveGhost: (tx: number, ty: number) => void;
  footprintOf: (key: string) => { fw: number; fh: number };
  renderFromStore: () => void;
  drawClaimPerimeter: () => void;
  clearClaimPerimeter: () => void;
  styleObstacle: (sprite: Record<string, unknown>, row: { id: string; spriteKey: string; tx: number; ty: number }, clearing: boolean) => void;
  restyleObstacles: () => void;
  syncRemnants: (base: BaseStateDto) => void;
  showLayoutDraft: (command: {
    op: 'show';
    positions: Array<{ buildingId: string; tx: number; ty: number }>;
    trayIds: string[];
    selectedBuildingId: string | null;
    wallPaintLevel: number | null;
  }) => void;
  applyLayoutDraft: () => void;
  syncWallArt: () => void;
  paintLayoutWallTile: (pointer: Record<string, unknown>) => void;
  hideLayoutDraft: () => void;
  releasePatrolArtLease: () => void;
  carriedPieces: () => Array<{ id: string; origTx: number; origTy: number }>;
  reseatCarriedPieces: () => void;
  liftPiece: (
    sprite: Record<string, unknown>, tx: number, ty: number, fp: { fw: number; fh: number },
  ) => void;
  cancelDrag: () => void;
};

async function scenePrototype(): Promise<ScenePrototype> {
  const { BaseScene } = await import('./BaseScene');
  return BaseScene.prototype as unknown as ScenePrototype;
}

describe('BaseScene claim and outer-world presentation', () => {
  it('starts a legal construction preview near the Keep so the first PLACE needs no camera hunt', async () => {
    const { BaseScene } = await import('./BaseScene');
    const prior = useApp.getState().base;
    useApp.setState({ base: {
      claim: { min: 0, max: 10 }, buildings: [{ id: 'keep', type: 'keep', tx: 6, ty: 6 }],
    } as BaseStateDto });
    const sprite = { setAlpha: vi.fn().mockReturnThis(), setDepth: vi.fn().mockReturnThis() };
    const scene = {
      endGhost: vi.fn(), clearWallLine: vi.fn(), clearWallPulse: vi.fn(),
      ghostSpriteKey: () => 'bld_camp_l1', footprintOf: () => ({ fw: 2, fh: 2 }),
      isValidSpot: (_id: string, tx: number, ty: number) => (tx === 0 && ty === 0) || (tx === 4 && ty === 6),
      add: { sprite: () => sprite }, drawPlacementGrid: vi.fn(), moveGhost: vi.fn(),
      armyStatus: { setSuppressed: vi.fn() },
    };
    try {
      (BaseScene.prototype as unknown as { startGhost(type: string): void }).startGhost.call(scene, 'camp');
      expect(scene.moveGhost).toHaveBeenCalledWith(4, 6);
      expect(scene.armyStatus.setSuppressed).toHaveBeenLastCalledWith(true);
    } finally { useApp.setState({ base: prior }); }
  });

  it.each([false, true])('restores the base army summary after construction placement only outside layout editing (%s)', async (editing) => {
    const scene = {
      ghost: { sprite: { destroy: vi.fn() }, ring: { destroy: vi.fn() } },
      layoutDraft: editing ? { positions: new Map() } : null,
      wallPaint: null, liftShadow: null,
      clearPlacementGrid: vi.fn(), clearFootprintTint: vi.fn(),
      armyStatus: { setSuppressed: vi.fn() },
    };
    (await scenePrototype()).endGhost.call(scene);
    expect(scene.ghost).toBeNull();
    expect(scene.armyStatus.setSuppressed).toHaveBeenLastCalledWith(editing);
  });

  it('keeps idle grass unboxed but exposes the claim grid while choosing or moving; revision 5 draws no perimeter stroke or stones because the terrain ring is the boundary, revisions ≤4 keep them', () => {
    const source = readFileSync(new URL('./BaseScene.ts', import.meta.url), 'utf8');
    const underlayStart = source.indexOf('private drawUnderlay(): void');
    const underlayEnd = source.indexOf('// State → sprites', underlayStart);
    const idleUnderlay = source.slice(underlayStart, underlayEnd);

    // A permanent wash/box turns the owned claim into a hard rectangle even
    // when the player is only looking at the base. Idle may draw the organic
    // broken perimeter, but never resurrect the old filled rectangular plot.
    expect(underlayStart).toBeGreaterThan(-1);
    expect(idleUnderlay).not.toContain('fillRect');
    expect(idleUnderlay).not.toContain('strokeRect');
    expect(idleUnderlay).not.toContain('plotUnderlay');
    // renderFromStore owns the authoritative claim-key invalidation. The
    // delayed decorative underlay must not destroy/recreate the same perimeter.
    expect(idleUnderlay).not.toContain('this.drawClaimPerimeter()');
    // REALM-KIT-PLAN §3 / D-173: on revision 5 the realm kit's corner-Wang edge
    // ring, generated from the same server claim, IS the boundary. The dashed
    // stroke and the eight dec_rock stones are consulted through the shared
    // rule (underlay.claimPerimeterDrawn) BEFORE any object is created, so the
    // painted revisions ≤4 keep their organic perimeter and revision 5 never
    // draws it twice. The underlay also hands the claim to SceneGround.
    const perimeterStart = source.indexOf('private drawClaimPerimeter(): void');
    const perimeterEnd = source.indexOf('private clearClaimPerimeter(): void', perimeterStart);
    const perimeter = source.slice(perimeterStart, perimeterEnd);
    const gate = perimeter.indexOf('if (!claimPerimeterDrawn(base.visualContext)) return;');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(perimeter.indexOf('claimPerimeter(claim, T, {'));
    expect(gate).toBeLessThan(perimeter.indexOf('this.add.graphics()'));
    expect(idleUnderlay).toContain('this.fantasyGround.setClaim(useApp.getState().base?.claim)');

    const gridStart = source.indexOf('private drawPlacementGrid(): void');
    const gridEnd = source.indexOf('private clearPlacementGrid(): void', gridStart);
    const activeGrid = source.slice(gridStart, gridEnd);
    expect(activeGrid).toContain('g.fillRect');
    expect(activeGrid).toContain('g.lineBetween');
    // WHY: legal/blocked cells and their grid carry placement truth; a hard
    // outer stroke recreates the ugly square plot boundary the idle pass removed.
    expect(activeGrid).not.toContain('.strokeRect');
    expect(activeGrid).toContain('free ? 0.09 : 0.30');

    const placementStart = source.indexOf('private startGhost(type: string): void');
    const placementEnd = source.indexOf('private paintWallTile(', placementStart);
    expect(source.slice(placementStart, placementEnd)).toContain('this.drawPlacementGrid()');
    const moveStart = source.indexOf('const firstMove = !d.moved;');
    const moveTint = source.indexOf('this.showFootprintTint(ntx, nty', moveStart);
    const gridOnMove = source.indexOf('if (firstMove) this.drawPlacementGrid();', moveStart);
    expect(moveStart).toBeGreaterThan(-1);
    expect(gridOnMove).toBeGreaterThan(moveStart);
    expect(gridOnMove).toBeLessThan(moveTint);

    // The feedback is transient in both workflows: cancelling a move and
    // ending a placement must destroy it before returning to idle.
    const cancelStart = source.indexOf('private cancelDrag(): void');
    const cancelEnd = source.indexOf('private clearWallStroke(): void', cancelStart);
    expect(source.slice(cancelStart, cancelEnd)).toContain('this.clearPlacementGrid()');
    const endGhostStart = source.indexOf('private endGhost(): void');
    const selectionStart = source.indexOf('private showSelection(', endGhostStart);
    expect(source.slice(endGhostStart, selectionStart)).toContain('this.clearPlacementGrid()');
  });

  it.each([
    ['revision 4 keeps the dashed stroke and eight stones', 4 as const, 1, 8],
    ['revision 5 draws no perimeter stroke or stones because the terrain ring is the boundary', 5 as const, 0, 0],
  ])('%s', async (_name, groundRevision, lines, stones) => {
    const proto = await scenePrototype();
    const graphics = { setDepth: vi.fn().mockReturnThis(), lineStyle: vi.fn().mockReturnThis(), lineBetween: vi.fn(), destroy: vi.fn() };
    const image = { setOrigin: vi.fn().mockReturnThis(), setDepth: vi.fn().mockReturnThis(), setAlpha: vi.fn().mockReturnThis(), destroy: vi.fn() };
    const scene = {
      clearClaimPerimeter: proto.clearClaimPerimeter, claimPerimeterObjects: [] as unknown[],
      meta: {}, add: { graphics: vi.fn(() => graphics), image: vi.fn(() => image) },
    };
    const prior = useApp.getState().base;
    useApp.setState({ base: { ...garrisonBase(), visualContext: { version: 1, artVersion: 2, realmId: 'crownlands', groundRevision } } });
    try {
      proto.drawClaimPerimeter.call(scene);
      expect(scene.add.graphics).toHaveBeenCalledTimes(lines);
      expect(scene.add.image).toHaveBeenCalledTimes(stones);
      expect(scene.claimPerimeterObjects).toHaveLength(lines + stones);
      if (stones) expect(image.setAlpha).toHaveBeenCalledWith(BASE_CAMERA.claimPerimeterStoneAlpha);
    } finally { useApp.setState({ base: prior }); }
  });

  it('draws a server obstacle from the kit sheet only when the ready revision-5 ground maps its spriteKey, else the frozen dec_ master (E-11)', async () => {
    const proto = await scenePrototype();
    const scene = patrolHarness(proto);
    const sprites: Record<string, unknown>[] = [];
    scene.add.sprite = vi.fn(() => { const sprite = stubSprite(); sprite.texture = { key: 'dec' }; sprites.push(sprite); return sprite; });
    const kit = { key: 'realm-kit-1-abc', frame: 0, origin: [0.5, 1] as [number, number], scale: 2 };
    const ground = { set: vi.fn(), setClaim: vi.fn(), obstacleSprite: vi.fn((spriteKey: string) => spriteKey === 'tree_old' ? kit : undefined) };
    Object.assign(scene, { fantasyGround: ground, attachObstacleInput: vi.fn(), styleObstacle: proto.styleObstacle,
      meta: { dec_tree_old: { footprint: [2, 2] }, dec_bush: { footprint: [1, 1] } } });
    const prior = useApp.getState().base;
    useApp.setState({ base: { ...garrisonBase(), obstacles: [
      { id: 'o1', spriteKey: 'tree_old', tx: 8, ty: 8 }, { id: 'o2', spriteKey: 'bush', tx: 10, ty: 10 },
    ], jobs: [{ id: 'j', kind: 'clear', buildingId: null, obstacleId: 'o1', startedAt: '', finishesAt: '' }] } as unknown as BaseStateDto });
    try {
      proto.renderFromStore.call(scene);
      // The lookup carries the row's own tile: an expansion obstacle draws the kit prop seated there.
      expect(ground.obstacleSprite).toHaveBeenCalledWith('tree_old', 'clearing', 8, 8);
      expect(ground.obstacleSprite).toHaveBeenCalledWith('bush', 'intact', 10, 10);
      type Stub = Record<string, (...args: unknown[]) => unknown> & { getData: (key: string) => unknown };
      const byObstacle = (id: string) => sprites.find((sprite) => (sprite as Stub).getData('obstacleId') === id) as Stub;
      const oak = byObstacle('o1'), bush = byObstacle('o2');
      // Mapped: the kit sheet frame with the sheet's own bottom-centre seat at 2× (32 px art → 64 px tiles).
      expect(oak.getData('kitSeat')).toEqual({ origin: [0.5, 1], scale: 2, offsetGamePx: [0, 0] });
      expect(scene.positionBuilding).toHaveBeenCalledWith(oak, 8, 8, { fw: 2, fh: 2 }); // footprint still from dec_ meta
      // Unmapped: the frozen dec_ master, no kit seat, positioned by its own meta.
      expect(bush.getData('kitSeat')).toBeUndefined();
      expect(scene.positionBuilding).toHaveBeenCalledWith(bush, 10, 10, { fw: 1, fh: 1 });
    } finally { useApp.setState({ base: prior }); }
  });

  it('draws a cleared obstacle as the kit remnant twin on its old seat, bare without the kit, hidden once built over (E-11 clearedObstacles)', async () => {
    // WHY: GET /base pays an EXISTS-joined query for clearedObstacles[] on every
    // read; the felled tree's stump is what that buys. Presentation only: the
    // tile is buildable, so the remnant must never be interactive, never block
    // the occupancy grid and must vanish under whatever the player builds there.
    const proto = await scenePrototype();
    const scene = patrolHarness(proto);
    type Image = Record<string, unknown> & { texture: { key: string }; frame: { name: unknown }; visible: boolean; x: number; y: number };
    const images: Image[] = [];
    const image = vi.fn((_x: number, _y: number, key: string, frame: unknown): Image => {
      const stub: Image = {
        texture: { key }, frame: { name: frame }, displayHeight: 64, visible: true, x: 0, y: 0,
        setTexture: vi.fn((nextKey: string, nextFrame: unknown) => { stub.texture = { key: nextKey }; stub.frame = { name: nextFrame }; return stub; }),
        setOrigin: vi.fn(() => stub), setScale: vi.fn(() => stub),
        setPosition: vi.fn((x: number, y: number) => { stub.x = x; stub.y = y; return stub; }),
        setDepth: vi.fn(() => stub), setVisible: vi.fn((visible: boolean) => { stub.visible = visible; return stub; }),
        setInteractive: vi.fn(), destroy: vi.fn(),
      };
      images.push(stub); return stub;
    });
    const stump = { key: 'realm-kit-1-abc', frame: 3, origin: [0.5, 1] as [number, number], scale: 2 };
    const ground = { set: vi.fn(), setClaim: vi.fn(), obstacleSprite: vi.fn((spriteKey: string, state: string) =>
      spriteKey === 'tree_old' && state === 'remnant' ? stump : undefined) };
    const occ = new Occupancy(64);
    Object.assign(scene, { fantasyGround: ground, occ, add: { sprite: scene.add.sprite, image },
      meta: { dec_tree_old: { footprint: [2, 2] }, dec_bush: { footprint: [1, 1] } } });
    const remnants = [
      { spriteKey: 'tree_old', tx: 10, ty: 10, clearedAt: '2026-09-21T00:00:00.000Z' },
      { spriteKey: 'bush', tx: 13, ty: 13, clearedAt: '2026-09-21T00:00:00.000Z' },
    ];
    const prior = useApp.getState().base;
    try {
      useApp.setState({ base: { ...garrisonBase(), clearedObstacles: remnants } as BaseStateDto });
      proto.renderFromStore.call(scene);
      expect(ground.obstacleSprite).toHaveBeenCalledWith('tree_old', 'remnant', 10, 10);
      expect(ground.obstacleSprite).toHaveBeenCalledWith('bush', 'remnant', 13, 13);
      // Only a key the kit maps draws: the frozen dec_ masters have no stump, so the bush tile stays bare.
      expect(image).toHaveBeenCalledTimes(1);
      expect(image).toHaveBeenCalledWith(0, 0, stump.key, stump.frame);
      const [stumpImage] = images as [Image];
      // The intact twin's seat and painter depth: the sheet's own anchor at 2×,
      // bottom-centre on the 2×2 dec_ footprint, structure depth on its south edge.
      expect(stumpImage.setOrigin).toHaveBeenCalledWith(0.5, 1);
      expect(stumpImage.setScale).toHaveBeenCalledWith(2);
      expect(stumpImage.setPosition).toHaveBeenCalledWith(11 * 64, 12 * 64);
      expect(stumpImage.setDepth).toHaveBeenCalledWith(structureDepth('building', 12 * 64));
      expect(stumpImage.visible).toBe(true);
      // Never an object: no hit area, not in the sprite map any gesture searches,
      // and the ground under it stays free for walkers and placement.
      expect(stumpImage.setInteractive).not.toHaveBeenCalled();
      expect(scene.positionBuilding).not.toHaveBeenCalledWith(stumpImage, expect.anything(), expect.anything(), expect.anything());
      expect([...scene.buildingSprites.values()]).not.toContain(stumpImage);
      expect(occ.tileFree(10, 10)).toBe(true);

      // Built over: a 3×3 (footprintOf stub) camp at (11,11) covers the stump's south-east tile.
      useApp.setState({ base: { ...garrisonBase(), clearedObstacles: remnants, buildings: [
        ...garrisonBase().buildings, { id: 'hut', type: 'camp', level: 1, tx: 11, ty: 11, underConstruction: true },
      ] } as BaseStateDto });
      proto.renderFromStore.call(scene);
      expect(image).toHaveBeenCalledTimes(1); // same image, re-seated, not recreated
      expect(stumpImage.visible).toBe(false);
      expect(stumpImage.destroy).not.toHaveBeenCalled();

      // OBSTACLE_REMNANT_DAYS elapsed server-side: the row leaves the list and the image goes with it.
      useApp.setState({ base: { ...garrisonBase(), clearedObstacles: [] } as BaseStateDto });
      proto.renderFromStore.call(scene);
      expect(stumpImage.destroy).toHaveBeenCalledOnce();
      expect(scene.remnantImages.size).toBe(0);

      // The kit ground became ready AFTER the rows were drawn: the restyle pass
      // that re-keys obstacles must also raise the remnants it could not draw before.
      useApp.setState({ base: { ...garrisonBase(), clearedObstacles: remnants } as BaseStateDto });
      Object.assign(scene, { styleObstacle: proto.styleObstacle });
      proto.restyleObstacles.call(scene);
      expect(image).toHaveBeenCalledTimes(2);
      expect(scene.remnantImages.get('10,10')).toBe(images[1]);
    } finally { useApp.setState({ base: prior }); }
  });

  it('plans deterministic irregular clusters with all eight visual-only props', () => {
    const worldPx = 30 * 64;
    const plan = skirtDecor(worldPx, 64);
    expect(plan).toEqual(skirtDecor(worldPx, 64));
    expect(new Set(plan.map(({ key }) => key))).toEqual(new Set([
      'dec_pine_1', 'dec_pine_2', 'dec_bush', 'dec_rock_l',
      'dec_rock_s', 'dec_boulder', 'dec_stump', 'dec_tree_old',
    ]));

    // The prior two-key rows and five-key scatter exposed their repetition at
    // every neighbour. The new plan changes key immediately, varies painter
    // depth substantially and never crosses into the authoritative plot.
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i]!.key).not.toBe(plan[i - 1]!.key);
    }
    expect(new Set(plan.map(({ depth }) => depth)).size).toBeGreaterThan(plan.length / 3);
    expect(new Set(plan.map(({ x, y }) => `${x},${y}`)).size).toBe(plan.length);
    expect(plan.every(({ x, y }) => x < 0 || x > worldPx || y < 0 || y > worldPx))
      .toBe(true);
    expect(plan.every((spec) => Object.keys(spec).sort().join(',') === 'depth,key,x,y'))
      .toBe(true);
  });

  it('restores base-wide army chips when a layout draft closes after save/cancel', async () => {
    const proto = await scenePrototype();
    const scene = {
      cancelPointerGesture: vi.fn(),
      clearWallLine: vi.fn(),
      clearWallPulse: vi.fn(),
      clearLayoutWallStroke: vi.fn(),
      clearPlacementGrid: vi.fn(),
      clearFootprintTint: vi.fn(),
      showSelection: vi.fn(),
      applyLayoutDraft: vi.fn(),
      renderFromStore: vi.fn(),
      armyStatus: { setSuppressed: vi.fn() },
      layoutDraft: null,
      layoutWallStroke: null,
    };

    proto.showLayoutDraft.call(scene, {
      op: 'show', positions: [], trayIds: [], selectedBuildingId: null, wallPaintLevel: null,
    });
    expect(scene.armyStatus.setSuppressed).toHaveBeenCalledWith(true);
    expect(scene.applyLayoutDraft).toHaveBeenCalledOnce();

    proto.hideLayoutDraft.call(scene);
    expect(scene.armyStatus.setSuppressed).toHaveBeenLastCalledWith(false);
    expect(scene.renderFromStore).toHaveBeenCalledOnce();
  });

  it('recomputes connected wall art from draft coordinates before drawing the edit', () => {
    const source = readFileSync(new URL('./BaseScene.ts', import.meta.url), 'utf8');
    const start = source.indexOf('private applyLayoutDraft(): void');
    const end = source.indexOf('/**', start + 10);
    const method = source.slice(start, end);
    expect(method).toContain('this.wallFrames = resolveWallFrames');
    expect(method).toContain('draft.positions.get(building.id)');
    expect(method).toContain('this.positionBuilding(sprite, position.tx, position.ty, fp)');
    expect(source).toContain('this.wallArt.sync(inputs)');
  });

  it('seats every draft wall before the contextual renderer publishes its connections', async () => {
    const proto = await scenePrototype();
    const prior = useApp.getState().base;
    const buildings = [
      { id: 'ware-wall', type: 'wall', level: 1, tx: 1, ty: 1, underConstruction: false },
      { id: 'static-wall', type: 'wall', level: 1, tx: 8, ty: 8, underConstruction: false },
    ];
    useApp.setState({
      base: {
        ...storeBase(null), buildings, obstacles: [],
      } as unknown as BaseStateDto,
    });
    const sprite = () => {
      const value = {
        setVisible: vi.fn(), setAlpha: vi.fn(), setTexture: vi.fn(),
      };
      value.setVisible.mockReturnValue(value);
      value.setAlpha.mockReturnValue(value);
      value.setTexture.mockReturnValue(value);
      return value;
    };
    const wareSprite = sprite();
    const staticSprite = sprite();
    const controller = { setPiece: vi.fn() };
    const scene = {
      wallArtDirty: false,
      layoutDraft: {
        positions: new Map([
          ['ware-wall', { tx: 4, ty: 4 }],
          ['static-wall', { tx: 5, ty: 4 }],
        ]),
        trayIds: new Set<string>(),
        selectedBuildingId: null,
        wallPaintLevel: null,
      },
      wallFrames: new Map<string, string>(),
      buildingSprites: new Map([
        ['ware-wall', wareSprite], ['static-wall', staticSprite],
      ]),
      wareWalls: new Map([['ware-wall', controller]]),
      berthBuildings: new Map(),
      footprintOf: vi.fn(() => ({ fw: 1, fh: 1 })),
      spriteKeyFor: vi.fn(() => 'wall5_t1_straight_intact_f1'),
      positionBuilding: vi.fn(),
      ambience: { hide: vi.fn() },
      heroRecovery: { hide: vi.fn(), destroy: vi.fn() },
      armyStatus: { hide: vi.fn(), setSuppressed: vi.fn() },
      occ: { rebuild: vi.fn() },
      patrol: { destroy: vi.fn() },
      jobs: { destroy: vi.fn() },
      keepClock: { destroy: vi.fn() },
      ambientBusy: true,
      showSelection: vi.fn(),
      drawPlacementGrid: vi.fn(),
      meta: {},
    };
    try {
      proto.applyLayoutDraft.call(scene);
      expect(scene.positionBuilding).toHaveBeenCalledWith(wareSprite, 4, 4, { fw: 1, fh: 1 });
      expect(scene.positionBuilding).toHaveBeenCalledWith(staticSprite, 5, 4, { fw: 1, fh: 1 });
      expect(controller.setPiece).not.toHaveBeenCalled();
      expect(scene.wallFrames).toEqual(new Map([
        ['ware-wall', 'wall5_t1_end_e_intact_f1'],
        ['static-wall', 'wall5_t1_end_w_intact_f1'],
      ]));
      expect(scene.wallArtDirty).toBe(true);
      scene.wallArtDirty = false;
      scene.layoutDraft.trayIds = new Set(['ware-wall', 'static-wall']);
      scene.positionBuilding.mockClear();
      proto.applyLayoutDraft.call(scene);
      // Moving every wall to the tray has no seating calls, yet must still
      // remove every connection on the next frame instead of retaining a grid.
      expect(scene.positionBuilding).not.toHaveBeenCalled();
      expect(scene.wallArtDirty).toBe(true);
      expect(scene.wallFrames.size).toBe(0);
    } finally {
      useApp.setState({ base: prior });
    }
  });

  it('fills skipped pointer samples, skips blocked tiles, and stops at the wall group size', async () => {
    const proto = await scenePrototype();
    const gfx = {
      fillStyle: vi.fn(),
      fillRect: vi.fn(),
    };
    gfx.fillStyle.mockReturnValue(gfx);
    const scene = {
      layoutDraft: { wallPaintLevel: 3 },
      layoutWallStroke: {
        tiles: [] as Array<{ tx: number; ty: number }>,
        set: new Set<string>(),
        gfx,
        lastTile: null as { tx: number; ty: number } | null,
        maxTiles: 4,
      },
      cameras: {
        main: { getWorldPoint: (x: number, y: number) => ({ x, y }) },
      },
      // Tile 3 is occupied. A fast pointer jump must continue beyond it,
      // while never consuming one of the four same-level wall identities.
      isValidSpot: vi.fn((_id: string, tx: number) => tx !== 3),
    };
    proto.paintLayoutWallTile.call(scene, { x: 65, y: 65 });
    proto.paintLayoutWallTile.call(scene, { x: 385, y: 65 });

    expect(scene.layoutWallStroke.tiles).toEqual([
      { tx: 1, ty: 1 }, { tx: 2, ty: 1 }, { tx: 4, ty: 1 }, { tx: 5, ty: 1 },
    ]);
    expect(gfx.fillRect).toHaveBeenCalledTimes(4);
    // Once exhausted, later samples cannot create phantom wall placements.
    proto.paintLayoutWallTile.call(scene, { x: 641, y: 65 });
    expect(scene.layoutWallStroke.tiles).toHaveLength(4);
  });
});

describe('BaseScene visible-art and footprint input', () => {
  it('draws eager WARE aliases once from their already-2× bld atlas', async () => {
    const prototype = await scenePrototype();
    const sprite = {
      frame: { name: 'bld_keep_l1' },
      // The drawn height IS the seat input: a building sits on the south edge
      // of its footprint by its BOTTOM EDGE, so a fake that does not model
      // displayHeight cannot be seated (and would silently seat at NaN).
      displayHeight: 272,
      setOrigin: vi.fn().mockReturnThis(),
      setScale: vi.fn().mockReturnThis(),
      setX: vi.fn().mockReturnThis(),
      setY: vi.fn().mockReturnThis(),
      setDepth: vi.fn().mockReturnThis(),
      setData: vi.fn().mockReturnThis(),
      getData: vi.fn(() => undefined),
    };
    const scene = {
      v2meta: { clips: {} },
      waremeta: { clips: {} },
      meta: { bld_keep_l1: { anchor: [0.5, 0.5], anchorAtFootprintCentre: true } },
      buildingSeat: prototype.buildingSeat,
      refreshFootprintHitArea: vi.fn(),
      berthBuildings: new Map(),
    };

    prototype.positionBuilding.call(scene, sprite, 4, 6, { fw: 3, fh: 3 });

    expect(sprite.setScale).toHaveBeenCalledWith(1);
    // Bottom edge on the south edge: the anchor lifts the sprite off that edge
    // by the half of the cell BELOW it, never by half the footprint.
    expect(sprite.setY).toHaveBeenCalledWith((6 + 3) * 64 - (1 - 0.5) * 272);
  });

  it('uses exact-current Mortar art on startup and placement before rich atlases land', async () => {
    vi.clearAllMocks();
    atlas.isV2AtlasLoaded.mockReturnValue(false);
    const prototype = await scenePrototype();
    const scene = { wallFrames: new Map<string, string>() };

    for (const [tier, level] of [1, 6, 11, 16].entries()) {
      const expected = v2BuildingFallbackFrameKey('mortar', tier + 1, 1);
      expect(prototype.spriteKeyFor.call(scene, {
        id: `mortar-${tier + 1}`, type: 'mortar', level, tx: 0, ty: 0,
      })).toBe(expected);
      expect(expected).not.toMatch(/^bld_mortar_/);
    }
    atlas.isV2AtlasLoaded.mockReturnValue(true);
    for (const [tier, level] of [1, 6, 11, 16].entries()) {
      const key = prototype.spriteKeyFor.call(scene, {
        id: `loaded-mortar-${tier + 1}`, type: 'mortar', level, tx: 0, ty: 0,
      });
      expect(key).toBe(`v2_bld_mortar_t${tier + 1}_idle_d0_f1`);
      expect(key).not.toMatch(/^bld_mortar_/);
    }
    // The placement ghost keys exactly like a freshly placed L1 building: the
    // tier-1 v2 idle master once its atlas is in, else the eager alias. Cannon
    // joined mortar on 2026-09-17 (owner, iPhone: the ghost showed the retired
    // legacy sprite until PLACE swapped in the current art).
    for (const type of ['mortar', 'cannon'] as const) {
      expect(prototype.ghostSpriteKey(type)).toBe(`v2_bld_${type}_t1_idle_d0_f1`);
    }
    atlas.isV2AtlasLoaded.mockReturnValue(false);
    for (const type of ['mortar', 'cannon'] as const) {
      expect(prototype.ghostSpriteKey(type)).toBe(v2BuildingFallbackFrameKey(type, 1, 1));
      expect(prototype.ghostSpriteKey(type)).not.toMatch(new RegExp(`^bld_${type}_`));
    }
    expect(prototype.footprintOf.call({ meta: {} }, prototype.ghostSpriteKey('mortar')))
      .toEqual({ fw: 2, fh: 2 });
    // The sim's cannon footprint stays 1×1 even though the v2 sprite overhangs.
    expect(prototype.footprintOf.call({ meta: {} }, prototype.ghostSpriteKey('cannon')))
      .toEqual({ fw: 1, fh: 1 });
  });

  it('never writes legacy art across a same-ID Mortar tier upgrade and stale completion', async () => {
    // WHY: an upgrade preserves the building id while its desired optional
    // atlas changes. The visible sequence must be rich old tier → exact-current
    // next-tier fallback → rich next tier. A late completion for the old tier
    // must not re-key the same sprite back to its superseded body.
    vi.clearAllMocks();
    const prototype = await scenePrototype();
    const loaded = new Set(['v2bld_mortar_t3']);
    atlas.isV2AtlasLoaded.mockImplementation((_scene, group: string) => loaded.has(group));
    const scene = { wallFrames: new Map<string, string>() };
    const building = {
      id: 'same-mortar-id', type: 'mortar', level: 11, tx: 4, ty: 6,
      underConstruction: false,
    };
    const writes: Array<[string, string]> = [];
    const sprite = {
      frame: { name: 'v2_bld_mortar_t3_idle_d0_f1' },
      setTexture(atlasName: string, frame: string) {
        writes.push([atlasName, frame]);
        this.frame.name = frame;
        return this;
      },
    };
    const renderKey = (): void => {
      const key = prototype.spriteKeyFor.call(scene, building);
      if (sprite.frame.name !== key) sprite.setTexture(
        key.startsWith('v2_fallback_') ? 'v2fallback' : `v2bld_mortar_t4`, key,
      );
    };

    renderKey(); // existing rich t3 remains stable
    building.level = 16;
    building.underConstruction = true;
    loaded.delete('v2bld_mortar_t3');
    renderKey(); // desired t4 is not resident: swap directly to exact-current t4
    loaded.add('v2bld_mortar_t3');
    renderKey(); // stale old-tier completion cannot influence the desired key
    loaded.add('v2bld_mortar_t4');
    building.underConstruction = false;
    renderKey();

    expect(writes).toEqual([
      ['v2fallback', v2BuildingFallbackFrameKey('mortar', 4, 1)],
      ['v2bld_mortar_t4', 'v2_bld_mortar_t4_idle_d0_f1'],
    ]);
    expect(writes.every(([, frame]) => !isRetiredRuntimeSpriteKey(frame))).toBe(true);
    atlas.isV2AtlasLoaded.mockReturnValue(false);
  });

  it('seats and scales the current Mortar placement ghost exactly like the real tower', async () => {
    vi.clearAllMocks();
    const prototype = await scenePrototype();
    const frame = v2BuildingFallbackFrameKey('mortar', 1, 1);
    const sprite = {
      frame: { name: frame },
      displayHeight: 120 * v2BldDrawScale('mortar'), // the 120-px cell, fitted
      setOrigin: vi.fn(),
      setScale: vi.fn(),
      setX: vi.fn(),
      setY: vi.fn(),
      getData: vi.fn(() => undefined),
    };
    const ring = { setPosition: vi.fn() };
    const lift = { setPosition: vi.fn() };
    const scene = {
      ghost: {
        type: 'mortar', sprite, fp: { fw: 2, fh: 2 }, tx: 0, ty: 0,
        valid: true, ring,
      },
      v2meta: { clips: {
        v2_bld_mortar_t1_idle: {
          cellW: 112, cellH: 120, anchorPx: [56, 104],
        },
      } },
      waremeta: { clips: {} },
      meta: {},
      buildingSeat: prototype.buildingSeat,
      positionLiftedBuilding: prototype.positionLiftedBuilding,
      isValidSpot: vi.fn(() => true),
      showFootprintTint: vi.fn(),
      liftShadow: lift,
      berthBuildings: new Map(),
    };

    prototype.moveGhost.call(scene, 3, 5);

    expect(sprite.setOrigin).toHaveBeenCalledWith(0.5, 104 / 120);
    // The ghost takes the tower's PUBLISHED world fit, not the bare pack
    // conversion it used to take. What you drag has to be what you get: after
    // the Mortar was refitted under the Keep (owner 2026-08-30) a ×2 ghost
    // would promise a tower half again the size of the one that lands.
    expect(sprite.setScale).toHaveBeenCalledWith(v2BldDrawScale('mortar'));
    expect(sprite.setX).toHaveBeenCalledWith((3 + 1) * 64);
    // What you drag is where it lands: the ghost's bottom edge on the south
    // edge of the 2×2 it would occupy — (5+2)×64 — less the 16 authored px of
    // cell below the (56,104) anchor at the tower's fit, and 16 px of lift.
    expect(sprite.setY).toHaveBeenCalledWith(
      (5 + 2) * 64 - (120 - 104) * v2BldDrawScale('mortar') - 16,
    );
    expect(ring.setPosition).toHaveBeenCalledWith((3 + 1) * 64, (5 + 1) * 64);
    expect(lift.setPosition).toHaveBeenCalled();
  });

  it('reclaims sleeping V2 Cannon textures onto the truthful eager still, staying visible', async () => {
    // NEW RULE (2026-08-16): Cannon carries a truthful current-art still in the
    // eager v2fallback atlas (the owner saw the OLD cannon whenever the rich
    // atlas was not resident), so lending its rich texture to a battle re-keys
    // it — it must never hide, and it must never fall back to `bld_cannon_l*`.
    vi.clearAllMocks();
    const prototype = await scenePrototype();
    const release = prototype.releaseV2DefenseArtForBattle;
    const fallback = v2BuildingFallbackFrameKey('cannon', 4, 1);
    const data = new Map<string, unknown>([
      ['v2AtlasGroup', 'v2bld_cannon_t4'],
      ['v2FallbackFrame', fallback],
      ['tx', 5],
      ['ty', 6],
    ]);
    const sprite = {
      frame: { name: 'v2_bld_cannon_t4_idle_d0_f1' },
      getData: vi.fn((key: string) => data.get(key)),
      setTexture: vi.fn((_atlas: string, frame: string) => {
        sprite.frame.name = frame;
        return sprite;
      }),
      setVisible: vi.fn(() => sprite),
    };
    const scene = {
      buildingSprites: new Map([['cannon-id', sprite]]),
      battleReleasedV2Buildings: new Set<string>(),
      ambience: { destroy: vi.fn() },
      footprintOf: vi.fn(() => ({ fw: 1, fh: 1 })),
      positionBuilding: vi.fn(),
      releaseDisplayedV2DefenseArt: prototype.releaseDisplayedV2DefenseArt,
      releaseDisplayedWareArt: vi.fn(),
    };

    release.call(scene);

    expect(sprite.setTexture).toHaveBeenCalledWith('v2fallback', fallback);
    expect(sprite.setVisible).toHaveBeenCalledWith(true);
    expect(scene.positionBuilding).toHaveBeenCalledWith(sprite, 5, 6, { fw: 1, fh: 1 });
    expect(scene.battleReleasedV2Buildings).toEqual(new Set());
    expect(scene.ambience.destroy).toHaveBeenCalledOnce();
    expect(atlas.releaseAtlasGroups).toHaveBeenCalledWith(
      scene, new Set(['v2bld_cannon_t4']),
    );
    expect(atlas.releaseAtlasReservations).toHaveBeenCalledWith(
      scene, new Set(['v2bld_cannon_t4']),
    );
  });

  it('keeps exact-current Mortar fallback visible while lending its rich atlas to battle', async () => {
    vi.clearAllMocks();
    const prototype = await scenePrototype();
    const fallback = v2BuildingFallbackFrameKey('mortar', 4, 1);
    const data = new Map<string, unknown>([
      ['v2AtlasGroup', 'v2bld_mortar_t4'],
      ['v2FallbackFrame', fallback],
      ['tx', 7],
      ['ty', 9],
    ]);
    const sprite = {
      frame: { name: 'v2_bld_mortar_t4_idle_d0_f1' },
      getData: vi.fn((key: string) => data.get(key)),
      setTexture: vi.fn((_atlas: string, frame: string) => {
        sprite.frame.name = frame;
        return sprite;
      }),
      setVisible: vi.fn(() => sprite),
    };
    const scene = {
      buildingSprites: new Map([['mortar-id', sprite]]),
      battleReleasedV2Buildings: new Set(['mortar-id']),
      ambience: { destroy: vi.fn() },
      footprintOf: vi.fn(() => ({ fw: 2, fh: 2 })),
      positionBuilding: vi.fn(),
      releaseDisplayedV2DefenseArt: prototype.releaseDisplayedV2DefenseArt,
      releaseDisplayedWareArt: vi.fn(),
    };

    prototype.releaseV2DefenseArtForBattle.call(scene);

    expect(sprite.setTexture).toHaveBeenCalledWith('v2fallback', fallback);
    expect(sprite.setVisible).toHaveBeenCalledWith(true);
    expect(scene.positionBuilding).toHaveBeenCalledWith(sprite, 7, 9, { fw: 2, fh: 2 });
    expect(scene.battleReleasedV2Buildings).toEqual(new Set());
  });

  it('reclaims visible mixed-tier towers before patrol admission without leaving malformed sprites', async () => {
    vi.clearAllMocks();
    const prototype = await scenePrototype();
    const makeTower = (type: 'cannon' | 'mortar', tier: number, _level: number) => {
      const fallback = v2BuildingFallbackFrameKey(type, tier, 1);
      const data = new Map<string, unknown>([
        ['v2AtlasGroup', `v2bld_${type}_t${tier}`],
        ['v2FallbackFrame', fallback],
        ['tx', tier * 2],
        ['ty', tier * 3],
      ]);
      const sprite = {
        frame: { name: `v2_bld_${type}_t${tier}_idle_d0_f1` },
        getData: vi.fn((key: string) => data.get(key)),
        setTexture: vi.fn((_atlas: string, frame: string) => {
          sprite.frame.name = frame;
          return sprite;
        }),
        setVisible: vi.fn((_visible: boolean) => sprite),
      };
      return sprite;
    };
    const towers = [1, 2, 3, 4].flatMap((tier) => [
      makeTower('cannon', tier, tier * 5),
      makeTower('mortar', tier, tier * 5),
    ]);
    const scene = {
      buildingSprites: new Map(towers.map((sprite, index) => [`tower-${index}`, sprite])),
      battleReleasedV2Buildings: new Set<string>(),
      ambience: { destroy: vi.fn() },
      footprintOf: vi.fn(() => ({ fw: 1, fh: 1 })),
      positionBuilding: vi.fn(),
      releaseDisplayedV2DefenseArt: prototype.releaseDisplayedV2DefenseArt,
    };

    expect(prototype.releaseV2DefenseArtForPatrol.call(scene)).toBe(true);

    const cannonTowers = towers.filter((_sprite, index) => index % 2 === 0);
    const mortarTowers = towers.filter((_sprite, index) => index % 2 === 1);
    expect(cannonTowers.map((sprite) => sprite.frame.name)).toEqual(
      [1, 2, 3, 4].map((tier) => v2BuildingFallbackFrameKey('cannon', tier, 1)),
    );
    expect(mortarTowers.map((sprite) => sprite.frame.name)).toEqual(
      [1, 2, 3, 4].map((tier) => v2BuildingFallbackFrameKey('mortar', tier, 1)),
    );
    expect(towers.every((sprite) => !/^bld_(cannon|mortar)_/.test(sprite.frame.name))).toBe(true);
    expect(towers.every((sprite) => sprite.setVisible.mock.calls.at(-1)?.[0] === true)).toBe(true);
    expect(scene.positionBuilding).toHaveBeenCalledTimes(8);
    expect(scene.battleReleasedV2Buildings).toEqual(new Set());
    expect(scene.ambience.destroy).toHaveBeenCalledOnce();
    const groups = new Set([1, 2, 3, 4].flatMap((tier) => [
      `v2bld_cannon_t${tier}`, `v2bld_mortar_t${tier}`,
    ]));
    expect(atlas.releaseAtlasGroups).toHaveBeenCalledWith(scene, groups);
    expect(atlas.releaseAtlasReservations).toHaveBeenCalledWith(scene, groups);
  });

  it('real packed sizes admit every legal trainable patrol after mixed-tier tower reclamation', () => {
    const packed = JSON.parse(readFileSync(
      new URL('../../../public/atlas/meta.json', import.meta.url),
      'utf8',
    )) as { atlasBytes: Record<string, number> };
    const units = [
      'highlander', 'bowman', 'kegrunner', 'tunneler', 'turrider', 'plunderer',
      'giant', 'troll', 'dragon', 'mage', 'bilgewraith',
      'gloamfang', 'direwyvern', 'hexbarrow',
    ] as const;
    const towerGroups = new Set([1, 2, 3, 4].flatMap((tier) => [
      `v2bld_cannon_t${tier}`, `v2bld_mortar_t${tier}`,
    ]));
    const highlander = v2LocomotionAtlasGroup('highlander', 1);
    const patrol = units.map((unit) => ({
      id: `troop:${unit}`,
      groups: [v2LocomotionAtlasGroup(unit, 1)],
    }));
    const towers = [...towerGroups].map((group) => ({ id: `building:${group}`, groups: [group] }));
    const candidates = basePatrolFirstCandidates(patrol, towers);
    const residentWithTowers = new Set([highlander, ...towerGroups]);
    const bytesWithTowers = [...residentWithTowers]
      .reduce((sum, group) => sum + packed.atlasBytes[group]!, 0);
    const blocked = admitAtlasCandidates(
      packed.atlasBytes, bytesWithTowers, residentWithTowers, new Set(), candidates,
    );
    expect(units.some((unit) => !blocked.accepted.has(`troop:${unit}`))).toBe(true);

    const reclaimed = admitAtlasCandidates(
      packed.atlasBytes, packed.atlasBytes[highlander]!, new Set([highlander]), new Set(), candidates,
    );
    expect(units.every((unit) => reclaimed.accepted.has(`troop:${unit}`))).toBe(true);
  });

  it('makes opaque authored overhang selectable while transparent art stays click-through', async () => {
    const refresh = (await scenePrototype()).refreshFootprintHitArea;
    type Area = { x: number; y: number; width: number; height: number; right: number; bottom: number };
    type Contains = (area: Area, x: number, y: number, sprite: unknown) => boolean;
    let area!: Area;
    let contains!: Contains;
    const getPixelAlpha = vi.fn((x: number, y: number) => (x === 12 && y === 7 ? 255 : 0));
    const data = new Map<string, unknown>();
    const sprite = {
      x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1,
      displayOriginX: 0, displayOriginY: 0,
      getWorldTransformMatrix: () => ({ applyInverse: (x: number, y: number) => ({ x, y }) }),
      width: 128, height: 192,
      texture: { key: 'bld' }, frame: { name: 'bld_tower_l1' },
      scene: { textures: { getPixelAlpha } },
      input: null as null | { hitArea: Area; hitAreaCallback: Contains; customHitArea: boolean },
      setData: vi.fn((key: string, value: unknown) => { data.set(key, value); return sprite; }),
      setInteractive: vi.fn((nextArea: Area, nextContains: Contains) => {
        area = nextArea;
        contains = nextContains;
        sprite.input = { hitArea: nextArea, hitAreaCallback: nextContains, customHitArea: true };
        return sprite;
      }),
    };
    refresh.call({}, sprite, 2, 3, { fw: 1, fh: 1 });

    expect(area).toMatchObject({ x: 0, y: 0, width: 128, height: 192 });
    expect(contains(area, 12, 7, sprite)).toBe(true);
    expect(contains(area, 13, 7, sprite)).toBe(false);
    expect(contains(area, -1, 7, sprite)).toBe(false);
    expect(getPixelAlpha).toHaveBeenCalledWith(12, 7, 'bld', 'bld_tower_l1');
    expect(Object.fromEntries(data)).toMatchObject({ tx: 2, ty: 3, fw: 1, fh: 1 });
  });

  it('hits the rendered Barracks roof texel instead of the wall behind its rounded boundary', async () => {
    const refresh = (await scenePrototype()).refreshFootprintHitArea;
    type Contains = (area: unknown, x: number, y: number, sprite: unknown) => boolean;
    let contains!: Contains;
    // Real Suga layout/frame: scale 1.55, seat (960, 1447.2), origin (48, 72).
    // Atlas (32,37) is transparent; (32,38) is opaque over the north wall.
    const getPixelAlpha = vi.fn((x: number, y: number) => x === 32 && y === 38 ? 255 : 0);
    const sprite = {
      x: 960, y: 1447.2, rotation: 0, scaleX: 1.55, scaleY: 1.55,
      displayOriginX: 48, displayOriginY: 72, width: 96, height: 88,
      texture: { key: 'ware_barracks_1' }, frame: { name: 'ware_bld_barracks_t1_idle_f2' },
      scene: { textures: { getPixelAlpha } },
      getWorldTransformMatrix: () => ({
        applyInverse: (x: number, y: number) => ({
          x: (x - Math.fround(960)) / Math.fround(1.55),
          y: (y - Math.fround(1447.2)) / Math.fround(1.55),
        }),
      }),
      setData: vi.fn(),
      setInteractive: vi.fn((_area: unknown, next: Contains) => { contains = next; }),
    };
    refresh.call({}, sprite, 14, 22, { fw: 2, fh: 1 });

    expect(contains(null, 32.19354838709671, 37.999999999999886, sprite)).toBe(true);
    // Actual zoom/pan camera inversion introduces another small rounding delta.
    expect(contains(null, 32.193559082284896, 37.999991515952, sprite)).toBe(true);
    expect(contains(null, 32.19354838709671, 37.99, sprite),
      'the neighbouring transparent texel still lets a genuine wall tap through').toBe(false);
    expect(getPixelAlpha.mock.calls.map((call) => call.slice(0, 2)))
      .toEqual([[32, 38], [32, 38], [32, 37]]);
  });

  it('keeps parented hit coordinates that Phaser already converted with the render matrix', async () => {
    const refresh = (await scenePrototype()).refreshFootprintHitArea;
    let contains!: (area: unknown, x: number, y: number, sprite: unknown) => boolean;
    const getPixelAlpha = vi.fn(() => 255);
    const getWorldTransformMatrix = vi.fn();
    const sprite = {
      parentContainer: {}, width: 64, height: 80,
      texture: { key: 'wall5' }, frame: { name: 'wall5_t1_straight_intact_f1' },
      scene: { textures: { getPixelAlpha } }, getWorldTransformMatrix,
      setData: vi.fn(),
      setInteractive: vi.fn((_area: unknown, next: typeof contains) => { contains = next; }),
    };
    refresh.call({}, sprite, 14, 21, { fw: 1, fh: 1 });
    expect(contains(null, 39.5, 66.5, sprite)).toBe(true);
    expect(getPixelAlpha).toHaveBeenCalledWith(39, 66, 'wall5', 'wall5_t1_straight_intact_f1');
    expect(getWorldTransformMatrix).not.toHaveBeenCalled();
  });

  it('replaces an existing interactive shape after origin/scale re-keying', async () => {
    const refresh = (await scenePrototype()).refreshFootprintHitArea;
    const oldArea = { x: 0, y: 0, width: 999, height: 999, right: 999, bottom: 999 };
    const oldContains = vi.fn(() => true);
    const sprite = {
      x: 320, y: 448,
      width: 144, height: 210,
      scaleX: 0.5, scaleY: 0.5,
      displayOriginX: 140, displayOriginY: 210,
      texture: { key: 'bld' }, frame: { name: 'bld_keep_l1' },
      scene: { textures: { getPixelAlpha: vi.fn() } },
      setData: vi.fn().mockReturnThis(),
      input: { hitArea: oldArea, hitAreaCallback: oldContains, customHitArea: false, enabled: false },
      setInteractive: vi.fn(),
    };

    refresh.call({}, sprite, 4, 6, { fw: 2, fh: 1 });

    expect(sprite.setInteractive).not.toHaveBeenCalled();
    expect(sprite.input.hitArea).not.toBe(oldArea);
    expect(sprite.input.hitArea).toMatchObject({ width: 144, height: 210 });
    expect(sprite.input.hitAreaCallback).not.toBe(oldContains);
    expect(sprite.input.customHitArea).toBe(true);
    expect(sprite.input.enabled).toBe(true);

    // A heartbeat may re-key/reseat a sprite during a live touch pan. Refresh
    // must update geometry without silently restoring its expensive pixel hit.
    sprite.input.enabled = true;
    refresh.call({ objectHitTestsSuppressed: true }, sprite, 4, 6, { fw: 2, fh: 1 });
    expect(sprite.input.enabled).toBe(false);
  });

  it('uses exact half-open occupied tiles only after visible-art hit testing missed', async () => {
    const at = (await scenePrototype()).footprintObjectAt;
    const sprite = (id: string, tx: number, depth: number) => ({
      depth,
      getData: vi.fn((key: string) => ({ tx, ty: 3, fw: 1, fh: 1, buildingId: id })[key as 'tx']),
    });
    const west = sprite('west', 2, 192);
    const east = sprite('east', 3, 256);
    const scene = { buildingSprites: new Map([['west', west], ['east', east]]) };

    expect(at.call(scene, 191.999, 224)).toBe(west);
    expect(at.call(scene, 192, 224)).toBe(east);
    expect(at.call(scene, 256, 224)).toBeNull();
  });

  it('never lets an invisible trayed sprite own its stale footprint', async () => {
    const at = (await scenePrototype()).footprintObjectAt;
    const hidden = {
      visible: false,
      depth: 999,
      getData: vi.fn((key: string) => ({ tx: 2, ty: 3, fw: 1, fh: 1 })[key as 'tx']),
    };
    expect(at.call({ buildingSprites: new Map([['trayed', hidden]]) }, 160, 224)).toBeNull();
    expect(hidden.getData).not.toHaveBeenCalled();
  });

  it('never lets transparent atlas-cell gutters own a neighbouring tile', async () => {
    const at = (await scenePrototype()).footprintObjectAt;
    const getBounds = vi.fn(() => ({ x: 64, y: 64, right: 320, bottom: 320 }));
    const keep = {
      depth: 400,
      getBounds,
      getData: vi.fn((key: string) => ({ tx: 2, ty: 2, fw: 2, fh: 2 })[key as 'tx']),
    };
    const scene = { buildingSprites: new Map([['keep', keep]]) };

    expect(at.call(scene, 255.999, 192)).toBe(keep);
    expect(at.call(scene, 256, 192)).toBeNull();
    expect(getBounds, 'fallback ownership comes from gameplay tiles, never transparent frame bounds')
      .not.toHaveBeenCalled();
  });

  it('refreshes the footprint hit area after each positioning pass', async () => {
    const position = (await scenePrototype()).positionBuilding;
    const refreshed = vi.fn();
    const sprite = {
      frame: { name: 'bld_test_l1' },
      displayHeight: 128,
      setOrigin: vi.fn().mockReturnThis(),
      setScale: vi.fn().mockReturnThis(),
      setX: vi.fn().mockReturnThis(),
      setY: vi.fn().mockReturnThis(),
      setDepth: vi.fn().mockReturnThis(),
      setData: vi.fn().mockReturnThis(),
      getData: vi.fn(() => undefined),
    };
    const scene = {
      v2meta: { clips: {} },
      waremeta: { clips: {} },
      meta: { bld_test_l1: { anchor: [0.25, 0.75] } },
      buildingSeat: (await scenePrototype()).buildingSeat,
      refreshFootprintHitArea: refreshed,
      berthBuildings: new Map(),
    };

    position.call(scene, sprite, 4, 6, { fw: 2, fh: 1 });

    expect(sprite.setOrigin).toHaveBeenCalledWith(0.25, 0.75);
    expect(sprite.setX).toHaveBeenCalledWith(320);
    expect(sprite.setY).toHaveBeenCalledWith((6 + 1) * 64 - (1 - 0.75) * 128);
    expect(refreshed).toHaveBeenCalledWith(sprite, 4, 6, { fw: 2, fh: 1 });
    expect(refreshed.mock.invocationCallOrder[0])
      .toBeGreaterThan(sprite.setData.mock.invocationCallOrder.at(-1)!);
  });

  it('stands a WARE Keep on its south edge, and lifts it 16 px off that seat', async () => {
    const proto = await scenePrototype();
    const sprite = {
      frame: { name: 'ware_bld_keep_l20_idle_f1' },
      displayHeight: 136 * 1.25, // the 136-px cell at the Keep's published fit
      setOrigin: vi.fn().mockReturnThis(),
      setScale: vi.fn().mockReturnThis(),
      setX: vi.fn().mockReturnThis(),
      setY: vi.fn().mockReturnThis(),
      setDepth: vi.fn().mockReturnThis(),
      setData: vi.fn().mockReturnThis(),
      getData: vi.fn(() => undefined), // no kind stored → building tie lane
    };
    const scene = {
      v2meta: { clips: {} },
      waremeta: { clips: {
        ware_bld_keep_l20_idle: {
          unit: 'keep', cellW: 144, cellH: 136, anchorPx: [72, 116],
        },
      } },
      meta: {},
      buildingSeat: proto.buildingSeat,
      refreshFootprintHitArea: vi.fn(),
      berthBuildings: new Map(),
    };

    proto.positionBuilding.call(scene, sprite, 4, 6, { fw: 2, fh: 2 });
    proto.positionLiftedBuilding.call(scene, sprite, 4, 6, { fw: 2, fh: 2 });

    // The Keep's cell bottom lands on the footprint's south edge — (6+2)×64 —
    // less the 20 authored px of cell BELOW its (72,116) anchor, at ×1.25. Its
    // old seat was the footprint's middle row, 39 world px higher, which is the
    // float the owner read off the selection box. Lift is 16 px above the seat.
    expect(sprite.setY.mock.calls.map(([y]) => y))
      .toEqual([512 - (136 - 116) * 1.25, 512 - (136 - 116) * 1.25 - 16]);
    expect(sprite.setX).toHaveBeenLastCalledWith(320);
    expect(sprite.setScale.mock.calls.map(([scale]) => scale)).toEqual([1.25, 1.25]);
  });

  it('keeps eager and rich WARE sizes identical and recentres the 1x1 Mine', async () => {
    const proto = await scenePrototype();
    const scene = {
      v2meta: { clips: {} },
      waremeta: { clips: {} },
      meta: {
        bld_keep_l20: {
          anchor: [0.5, 116 / 136], anchorAtFootprintCentre: true,
          sourceScale: 0.625, offsetGamePx: [0, 0],
        },
        bld_mine_l1: {
          anchor: [0.5, 70 / 88], anchorAtFootprintCentre: true,
          sourceScale: 0.45, offsetGamePx: [1, 0],
        },
        bld_mine_l1_damaged: {
          anchor: [0.5, 70 / 88], anchorAtFootprintCentre: true,
          sourceScale: 0.45, offsetGamePx: [1, 0],
        },
      },
      buildingSeat: proto.buildingSeat,
      refreshFootprintHitArea: vi.fn(),
      berthBuildings: new Map(),
    };

    expect(proto.buildingSeat.call(scene, 'bld_keep_l20')).toMatchObject({
      scale: 0.625, offsetGamePx: [0, 0],
    });
    expect(proto.buildingSeat.call(scene, 'bld_mine_l1')).toMatchObject({
      scale: 0.45, offsetGamePx: [1, 0],
    });
    // Damaged aliases live in warefallback@1x, so they draw at 2f and remain
    // the same world size as the eager @2x body.
    expect(proto.buildingSeat.call(scene, 'bld_mine_l1_damaged')).toMatchObject({
      scale: 0.9, offsetGamePx: [1, 0],
    });

    const mine = {
      frame: { name: 'bld_mine_l1' },
      displayHeight: 88 * 0.9,
      setOrigin: vi.fn().mockReturnThis(), setScale: vi.fn().mockReturnThis(),
      setX: vi.fn().mockReturnThis(), setY: vi.fn().mockReturnThis(),
      setDepth: vi.fn().mockReturnThis(), setData: vi.fn().mockReturnThis(),
      getData: vi.fn(() => undefined), // no kind stored → building tie lane
    };
    proto.positionBuilding.call(scene, mine, 4, 6, { fw: 1, fh: 1 });
    expect(mine.setScale).toHaveBeenCalledWith(0.45);
    expect(mine.setX).toHaveBeenCalledWith(290); // tile centre 288 + 2 world px
  });

  it('keeps stored logical occupancy after a WARE animation re-keys the frame', async () => {
    const proto = await scenePrototype();
    const footprintOf = vi.fn(() => ({ fw: 1, fh: 1 }));
    const sprite = {
      frame: { name: 'ware_bld_dragonnest_t3_attack_d2_f4' },
      getData: vi.fn((key: string) => ({
        buildingId: 'nest', tx: 7, ty: 8, fw: 2, fh: 2,
      })[key as 'buildingId']),
    };
    const scene = {
      ...pointerContactHarness(proto, []),
      positionedFootprint: proto.positionedFootprint,
      footprintOf,
      ghost: null,
      drag: null,
      obstaclePress: null,
      multiPointerGesture: false,
      input: { pointer1: { isDown: false }, pointer2: { isDown: false }, activePointer: null },
      beginMultiPointerGesture: vi.fn(),
      wallLineIds: new Set<string>(),
      buildingSprites: new Map(),
      time: { delayedCall: vi.fn() },
    };

    proto.beginBuildingPress.call(scene, sprite, { id: 1, x: 10, y: 20 });

    expect(scene.drag).toMatchObject({ fp: { fw: 2, fh: 2 }, origTx: 7, origTy: 8 });
    expect(footprintOf).not.toHaveBeenCalled();
  });

  it('fails loudly before falling back when a sprite was never positioned', async () => {
    const positioned = (await scenePrototype()).positionedFootprint;
    const footprintOf = vi.fn(() => ({ fw: 2, fh: 1 }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sprite = {
      frame: { name: 'bld_barracks_l1' },
      getData: vi.fn((key: string) => key === 'buildingId' ? 'barracks' : undefined),
    };

    try {
      expect(positioned.call({ footprintOf }, sprite)).toEqual({ fw: 2, fh: 1 });
      expect(error).toHaveBeenCalledWith(
        '[BaseScene] positioned sprite is missing its logical footprint',
        { buildingId: 'barracks', frame: 'bld_barracks_l1' },
      );
      expect(footprintOf).toHaveBeenCalledWith('bld_barracks_l1');
    } finally {
      error.mockRestore();
    }
  });

  it('draws native-size selection corners from stored occupancy after a rich re-key', async () => {
    const show = (await scenePrototype()).showSelection;
    const made: Array<Record<string, unknown>> = [];
    const image = (x: number, y: number, _atlas: string, frame: string) => {
      const item = {
        x, y, frame,
        setAngle: vi.fn().mockReturnThis(),
        setDepth: vi.fn().mockReturnThis(),
        setScale: vi.fn().mockReturnThis(),
      };
      made.push(item);
      return item;
    };
    const sprite = {
      frame: { name: 'ware_bld_keep_t4_idle_d0_f3' },
      getData: vi.fn((key: string) => ({ tx: 4, ty: 6, fw: 2, fh: 2 })[key as 'tx']),
    };
    const footprintOf = vi.fn(() => ({ fw: 1, fh: 1 }));
    const scene = {
      selectCorners: [] as Array<Record<string, unknown>>,
      buildingSprites: new Map([['keep', sprite]]),
      positionedFootprint: (await scenePrototype()).positionedFootprint,
      footprintOf,
      clearWallPulse: vi.fn(),
      add: { image: vi.fn(image) },
    };

    show.call(scene, 'keep');

    expect(made.map(({ x, y }) => [x, y])).toEqual([
      [256, 384], [384, 384], [384, 512], [256, 512],
    ]);
    expect(made).toHaveLength(4);
    expect(footprintOf).not.toHaveBeenCalled();
    for (const corner of made) {
      expect(corner['frame']).toBe('ovl_select_corner');
      // The old 2x scale was the oversized selection box reported by the owner.
      expect(corner['setScale']).not.toHaveBeenCalled();
    }
  });

  it('renders Air Defence selection at its exact six-tile shared range', async () => {
    const show = (await scenePrototype()).showSelection;
    const priorBase = useApp.getState().base;
    const made: Array<{
      frame: string;
      setScale: ReturnType<typeof vi.fn>;
    }> = [];
    const image = (_x: number, _y: number, _atlas: string, frame: string) => {
      const item = {
        frame,
        setAngle: vi.fn().mockReturnThis(),
        setDepth: vi.fn().mockReturnThis(),
        setAlpha: vi.fn().mockReturnThis(),
        setScale: vi.fn().mockReturnThis(),
      };
      made.push(item);
      return item;
    };
    const sprite = {
      frame: { name: 'bld_airdefence_l1' },
      getData: vi.fn((key: string) => ({ tx: 4, ty: 6, fw: 2, fh: 2 })[key as 'tx']),
    };
    const scene = {
      selectCorners: [] as Array<Record<string, unknown>>,
      buildingSprites: new Map([['air', sprite]]),
      positionedFootprint: (await scenePrototype()).positionedFootprint,
      footprintOf: vi.fn(() => ({ fw: 2, fh: 2 })),
      clearWallPulse: vi.fn(),
      add: { image: vi.fn(image) },
    };
    useApp.setState({
      base: {
        buildings: [{
          id: 'air', type: 'airdefence', level: 1, tx: 4, ty: 6,
          underConstruction: false,
        }],
      } as BaseStateDto,
    });

    try {
      show.call(scene, 'air');
      const ring = made.find(({ frame }) => frame === 'ovl_range_r7');
      expect(ring?.setScale).toHaveBeenCalledWith(
        DEFENSES.airdefence.rangeTiles / DEFENSES.lasertower.rangeTiles,
      );
    } finally {
      useApp.setState({ base: priorBase });
    }
  });

  it('shows the Keep high-battery dead zone until the low battery unlock fills it', async () => {
    const { selectionRangeOverlays } = await import('./BaseScene');

    expect(selectionRangeOverlays(
      'keep', KEEP_BATTERIES.highRangeUnlockLevel - 1,
    )).toEqual([]);
    expect(selectionRangeOverlays(
      'keep', KEEP_BATTERIES.highRangeUnlockLevel,
    ).map(({ frame }) => frame)).toEqual(['ovl_range_r7', 'ovl_deadzone_r2']);
    const withLow = selectionRangeOverlays('keep', KEEP_BATTERIES.lowRangeUnlockLevel);
    expect(withLow.map(({ frame }) => frame)).toEqual(['ovl_range_r7', 'ovl_range_r3']);
    // D-060: the Keep's low battery ring stays pinned to its own 3-tile reach —
    // it must NOT inherit the doubled cannon ring.
    expect(withLow[1]!.scale).toBe(KEEP_BATTERIES.lowRangeTiles / 3);
  });

  it('scales the D-060 cannon and archer rings from the shared combat ranges', async () => {
    // The overlay atlas has r3/r4/r7 masters; the doubled 6-tile cannon and the
    // 7-tile archer both ride the r7 master scaled by DEFENSES — so a future
    // range retune in shared constants moves the rings with it, no art edit.
    const { selectionRangeOverlays } = await import('./BaseScene');
    const [cannon] = selectionRangeOverlays('cannon', 1);
    expect(cannon).toMatchObject({
      frame: 'ovl_range_r7',
      scale: DEFENSES.cannon.rangeTiles / DEFENSES.lasertower.rangeTiles,
    });
    const [archer] = selectionRangeOverlays('archertower', 1);
    expect(archer).toMatchObject({
      frame: 'ovl_range_r7',
      scale: DEFENSES.archertower.rangeTiles / DEFENSES.lasertower.rangeTiles,
    });
  });
});

describe('BaseScene object-pointer hygiene', () => {
  const mouse = (button: number, primaryDown: boolean) => ({
    wasTouch: false, isDown: true, event: { pointerType: 'mouse' }, button, primaryDown,
  });

  it('accepts primary mouse/touch/pen starts while rejecting every secondary contact', async () => {
    const accepts = (await scenePrototype()).acceptsObjectGesture;
    expect(accepts.call({}, mouse(0, true))).toBe(true);
    expect(accepts.call({}, mouse(1, false))).toBe(false);
    expect(accepts.call({}, mouse(2, false))).toBe(false);
    expect(accepts.call({}, {
      ...mouse(0, true), wasTouch: true, event: { pointerType: 'touch' },
    })).toBe(true);
    expect(accepts.call({}, {
      ...mouse(0, true), event: { pointerType: 'pen' },
    })).toBe(true);
    expect(accepts.call({}, {
      ...mouse(2, false), event: { pointerType: 'pen' },
    })).toBe(false);
  });

  it('does not arm building or obstacle gestures from a secondary mouse/pen press', async () => {
    const proto = await scenePrototype();
    const accepts = proto.acceptsObjectGesture.bind({});
    const buildingHandlers = new Map<string, (pointer: Record<string, unknown>) => void>();
    const building = {
      frame: { name: 'bld_keep_l1' },
      on: vi.fn((event: string, handler: (pointer: Record<string, unknown>) => void) => {
        buildingHandlers.set(event, handler);
        return building;
      }),
      getData: vi.fn((key: string) => ({
        buildingId: 'keep', tx: 2, ty: 3, fw: 2, fh: 2,
      })[key as 'buildingId']),
    };
    const buildingScene = {
      ...pointerContactHarness(proto, []),
      acceptsObjectGesture: accepts,
      beginBuildingPress: proto.beginBuildingPress,
      positionedFootprint: proto.positionedFootprint,
      ghost: null,
      drag: null,
      obstaclePress: null,
      multiPointerGesture: false,
      input: { pointer1: { isDown: false }, pointer2: { isDown: false }, activePointer: null },
      beginMultiPointerGesture: vi.fn(),
      wallLineIds: new Set<string>(),
      buildingSprites: new Map(),
      footprintOf: vi.fn(() => ({ fw: 2, fh: 2 })),
      time: { delayedCall: vi.fn() },
    };
    proto.attachBuildingInput.call(buildingScene, building);
    buildingHandlers.get('pointerdown')!({ ...mouse(2, false), id: 1, x: 10, y: 20 });
    expect(buildingScene.drag).toBeNull();
    buildingHandlers.get('pointerdown')!({ ...mouse(0, true), id: 1, x: 10, y: 20 });
    expect(buildingScene.drag).toMatchObject({
      id: 'keep', pointerId: 1, startX: 10, startY: 20,
    });
    const firstDrag = buildingScene.drag;
    buildingScene.input.pointer1.isDown = true;
    buildingScene.input.pointer2.isDown = true;
    buildingHandlers.get('pointerdown')!({
      ...mouse(0, true),
      wasTouch: true,
      event: { pointerType: 'touch' },
      id: 2,
      x: 12,
      y: 22,
    });
    expect(buildingScene.beginMultiPointerGesture).toHaveBeenCalledOnce();
    expect(buildingScene.drag).toBe(firstDrag); // object #2 never steals owner #1

    const obstacleHandlers = new Map<string, (pointer: Record<string, unknown>) => void>();
    const obstacle = {
      on: vi.fn((event: string, handler: (pointer: Record<string, unknown>) => void) => {
        obstacleHandlers.set(event, handler);
        return obstacle;
      }),
    };
    const obstacleScene = {
      ...pointerContactHarness(proto, []),
      acceptsObjectGesture: accepts,
      acceptsGestureRelease: proto.acceptsGestureRelease.bind({}),
      beginObstaclePress: proto.beginObstaclePress,
      drag: null,
      ghost: null,
      multiPointerGesture: false,
      input: { pointer1: { isDown: false }, pointer2: { isDown: false } },
      beginMultiPointerGesture: vi.fn(),
      panSuppressed: false,
      obstaclePress: null,
      pointerOwnerId: 7,
      showSelection: vi.fn(),
    };
    proto.attachObstacleInput.call(obstacleScene, obstacle, 'oak');
    obstacleHandlers.get('pointerdown')!({ ...mouse(1, false), id: 1, x: 30, y: 40 });
    expect(obstacleScene.obstaclePress).toBeNull();
    obstacleHandlers.get('pointerdown')!({
      ...mouse(2, false), event: { pointerType: 'pen' }, id: 7, x: 30, y: 40,
    });
    expect(obstacleScene.obstaclePress).toBeNull();
    obstacleHandlers.get('pointerdown')!({
      ...mouse(0, true), event: { pointerType: 'pen' }, id: 7, x: 30, y: 40,
    });
    expect(obstacleScene).toMatchObject({
      panSuppressed: true,
      obstaclePress: { id: 'oak', pointerId: 7, x: 30, y: 40 },
    });
    // Phaser emits GAMEOBJECT_POINTER_UP before the scene-level POINTER_UP for
    // TOUCH_CANCEL, so the object callback itself must refuse the commit.
    obstacleHandlers.get('pointerup')!({
      ...mouse(0, false),
      wasTouch: true,
      wasCanceled: true,
      event: { pointerType: 'touch' },
      id: 7,
      x: 30,
      y: 40,
    });
    expect(obstacleScene.showSelection).not.toHaveBeenCalled();

    const mismatchScene = {
      obstaclePress: { id: 'oak', pointerId: 7, x: 30, y: 40 },
      pointerOwnerId: 7,
      showSelection: vi.fn(),
    };
    proto.commitObstaclePress.call(mismatchScene, 'rock', {
      id: 7, x: 30, y: 40,
    });
    expect(mismatchScene.showSelection).not.toHaveBeenCalled();
    expect(mismatchScene.obstaclePress).toMatchObject({ id: 'oak' });
  });
});

interface BasePointer {
  id: number;
  identifier: number;
  downElement?: unknown;
  wasTouch: boolean;
  wasCanceled: boolean;
  button: number;
  primaryDown: boolean;
  isDown: boolean;
  x: number;
  y: number;
  prevPosition: { x: number; y: number };
  event: { pointerType: string; touches?: Array<{ identifier: number }> };
  getDuration: () => number;
  getDistance: () => number;
}

const basePointer = (overrides: Partial<BasePointer> = {}): BasePointer => ({
  id: 1,
  identifier: 1,
  wasTouch: false,
  wasCanceled: false,
  button: 0,
  primaryDown: true,
  isDown: true,
  x: 20,
  y: 10,
  prevPosition: { x: 15, y: 10 },
  event: { pointerType: 'mouse' },
  getDuration: () => 0,
  getDistance: () => 0,
  ...overrides,
});

/** Existing drag/paint fixtures begin after a canvas down. Seed the same owned
 * contact the real handler recorded; global Phaser slots alone confer no input. */
function pointerContactHarness(proto: ScenePrototype, pointers = [basePointer()]) {
  return {
    emptyTap: new EmptyTapGesture(8),
    pointerContacts: new Map(pointers.map((pointer) => [pointer.id, {
      pointer, identifier: pointer.identifier, downEvent: pointer.event,
    }])),
    registerPointerDown: proto.registerPointerDown,
    prunePointerContacts: proto.prunePointerContacts,
    ownsPointerContact: proto.ownsPointerContact,
    isTouchPointer: proto.isTouchPointer,
  };
}

function cameraHarness(proto: ScenePrototype) {
  const handlers = new Map<string, (pointer?: BasePointer) => void>();
  const gameHandlers = new Map<string, () => void>();
  const camera = {
    width: 800, height: 600, zoom: 2, scrollX: 100, scrollY: 100,
    midPoint: { x: 300, y: 250 },
    getWorldPoint: vi.fn((x: number, y: number) => ({ x, y })),
    setZoom: vi.fn((zoom: number) => { camera.zoom = zoom; }),
    centerOn: vi.fn(),
  };
  const pointer1 = basePointer({ x: 10, y: 10 });
  const pointer2 = basePointer({ id: 2, identifier: 2, isDown: false, x: 20, y: 20 });
  const wallGfx = { clear: vi.fn() };
  const scene = {
    ...pointerContactHarness(proto, [pointer1]),
    game: { events: {
      on: vi.fn((event: string, handler: () => void) => { gameHandlers.set(event, handler); }),
      off: vi.fn(),
    } },
    cameras: { main: camera },
    rebandCamera: vi.fn(),
    scale: { on: vi.fn(), off: vi.fn() },
    onResize: vi.fn(),
    unsub: [] as Array<() => void>,
    input: {
      on: vi.fn((event: string, handler: (pointer?: BasePointer) => void) => {
        handlers.set(event, handler);
      }),
      pointer1,
      pointer2,
    },
    pinch: { onMove: vi.fn((_p1: BasePointer, _p2: BasePointer) => false), active: vi.fn(() => false), onUp: vi.fn() },
    zoomBand: { min: 0.5, max: 1.5 },
    drag: null as Record<string, unknown> | null,
    ghost: null as { type: string } | null,
    wallPaint: {
      tiles: [{ tx: 4, ty: 5 }],
      set: new Set(['4,5']),
      gfx: wallGfx,
    } as { tiles: Array<{ tx: number; ty: number }>; set: Set<string>; gfx: { clear: () => void } } | null,
    panSuppressed: true,
    obstaclePress: { id: 'oak', pointerId: 1, x: 10, y: 10 } as {
      id: string; pointerId: number; x: number; y: number;
    } | null,
    liftShadow: null as { destroy: () => void } | null,
    pointerOwnerId: 1 as number | null,
    multiPointerGesture: false,
    objectHitTestsSuppressed: false,
    buildingSprites: new Map<string, { input: { enabled: boolean } | null }>(),
    interactionIdleWaiters: new Set<{ resolve: () => void; reject: (cause: Error) => void }>(),
    richArtLoadsStopped: false,
    cancelDrag: vi.fn(),
    endGhost: vi.fn(),
    acceptsObjectGesture: proto.acceptsObjectGesture,
    acceptsGestureRelease: proto.acceptsGestureRelease,
    clearWallStroke: proto.clearWallStroke,
    cancelPointerGesture: proto.cancelPointerGesture,
    beginMultiPointerGesture: proto.beginMultiPointerGesture,
    setObjectHitTestsSuppressed: proto.setObjectHitTestsSuppressed,
    isTouchPointer: proto.isTouchPointer,
    suppressObjectHitTestsForTouchPan: proto.suppressObjectHitTestsForTouchPan,
    pointerInteractionActive: proto.pointerInteractionActive,
    flushInteractionIdleWaiters: proto.flushInteractionIdleWaiters,
    footprintObjectAt: vi.fn((): Record<string, unknown> | null => null),
    beginBuildingPress: vi.fn(),
    beginObstaclePress: vi.fn(),
    commitObstaclePress: vi.fn(),
    drawPlacementGrid: vi.fn(),
    fitCamera: vi.fn(() => {
      camera.setZoom(scene.zoomBand.min);
      camera.centerOn(960, 960);
    }),
  };
  scene.cancelDrag.mockImplementation(() => { scene.drag = null; });
  return { scene, camera, handlers, gameHandlers };
}

describe('BaseScene camera gesture cleanup', () => {
  it.each(['resize', 'insets'] as const)('cancels a pointer-owned empty direct wall stroke on %s', async (change) => {
    const proto = await scenePrototype();
    const { scene, camera, handlers } = cameraHarness(proto);
    const paintMode = scene.wallPaint!;
    paintMode.tiles.length = 0;
    scene.ghost = { type: 'wall' };
    const paintWallTile = vi.fn();
    Object.assign(scene, { paintWallTile });
    proto.setupCameraInput.call(scene);
    if (change === 'resize') {
      camera.width = 600;
      camera.height = 800;
      proto.onResize.call(scene, camera, undefined, undefined, 800, 600);
    } else {
      proto.applyInsets.call(scene, { top: 132, bottom: 140 });
    }
    // Direct placement samples its first tile on move/up, not down. Rotation
    // before that sample must still invalidate the owned pointer coordinates.
    expect(scene.pointerOwnerId).toBeNull();
    expect(scene.multiPointerGesture).toBe(true);
    scene.input.pointer1.isDown = false;
    handlers.get('pointerup')!(basePointer({ wasTouch: true, primaryDown: false, isDown: false }));
    expect(paintWallTile).not.toHaveBeenCalled();
    expect(scene.wallPaint).toBe(paintMode);
    expect(paintMode.tiles).toEqual([]);
    expect(scene.endGhost).not.toHaveBeenCalled();
  });

  it('keeps idle direct wall placement mode through rotation without cancelling another gesture', async () => {
    const proto = await scenePrototype();
    const { scene, camera } = cameraHarness(proto);
    const paintMode = scene.wallPaint!;
    paintMode.tiles.length = 0;
    scene.pointerOwnerId = null;
    scene.input.pointer1.isDown = false;
    camera.width = 600;
    camera.height = 800;
    proto.onResize.call(scene, camera, undefined, undefined, 800, 600);
    expect(scene.cancelDrag).not.toHaveBeenCalled();
    expect(scene.pinch.onUp).not.toHaveBeenCalled();
    expect(scene.wallPaint).toBe(paintMode);
    expect(scene.multiPointerGesture).toBe(false);
  });

  it.each([false, true])('rotation cancels only the unfinished wall stroke (camera moved: %s)', async (userMovedCamera) => {
    const proto = await scenePrototype();
    const { scene, camera, handlers } = cameraHarness(proto);
    const draft = { positions: new Map([['placed-wall', { tx: 12, ty: 18 }]]),
      trayIds: new Set(['trayed-wall']), wallPaintLevel: 1 };
    const destroy = vi.fn();
    const resizing = Object.assign(scene, {
      userMovedCamera, layoutDraft: draft,
      layoutWallStroke: { tiles: [{ tx: 12, ty: 19 }], gfx: { destroy } } as {
        tiles: Array<{ tx: number; ty: number }>; gfx: { destroy: () => void };
      } | null,
      clearLayoutWallStroke: proto.clearLayoutWallStroke,
      commitLayoutWallStroke: vi.fn(),
    });
    scene.wallPaint = null;
    proto.setupCameraInput.call(resizing);
    camera.width = 600;
    camera.height = 800;

    proto.onResize.call(resizing, camera, undefined, undefined, 800, 600);

    // The old pointer coordinates cannot own a placement after rotation. Only
    // its candidate is lost: previous strokes, tray IDs and selected level stay.
    expect(resizing.layoutWallStroke).toBeNull();
    expect(destroy).toHaveBeenCalledOnce();
    expect(resizing.layoutDraft).toBe(draft);
    expect([...draft.positions]).toEqual([['placed-wall', { tx: 12, ty: 18 }]]);
    expect([...draft.trayIds]).toEqual(['trayed-wall']);
    expect(draft.wallPaintLevel).toBe(1);
    expect(scene.pointerOwnerId).toBeNull();
    expect(scene.multiPointerGesture).toBe(true);
    scene.input.pointer1.isDown = false;
    handlers.get('pointerup')!(basePointer({ wasTouch: true, primaryDown: false, isDown: false }));
    expect(resizing.commitLayoutWallStroke).not.toHaveBeenCalled();
    expect(scene.multiPointerGesture).toBe(false);
    expect(scene.endGhost).not.toHaveBeenCalled();
    expect(scene.drawPlacementGrid).toHaveBeenCalledOnce();
  });

  it('keeps a wall stroke on same-size RESIZE refreshes and unchanged HUD measurements', async () => {
    const proto = await scenePrototype();
    const { scene, camera } = cameraHarness(proto);
    const stroke = { tiles: [{ tx: 12, ty: 19 }], gfx: { destroy: vi.fn() } };
    const resizing = Object.assign(scene, {
      userMovedCamera: true, layoutDraft: { wallPaintLevel: 1 }, layoutWallStroke: stroke,
      insets: { top: 132, bottom: 102, left: 0, right: 0 },
      clearLayoutWallStroke: proto.clearLayoutWallStroke,
    });
    camera.zoom = 1;

    proto.onResize.call(resizing, camera, undefined, undefined, 800, 600);
    proto.applyInsets.call(resizing, { top: 132, bottom: 102 });

    expect(resizing.layoutWallStroke).toBe(stroke);
    expect(stroke.gfx.destroy).not.toHaveBeenCalled();
    expect(scene.pointerOwnerId).toBe(1);
    expect(scene.cancelDrag).not.toHaveBeenCalled();
  });

  it('cancels a wall candidate when the unobstructed HUD rectangle really changes', async () => {
    const proto = await scenePrototype();
    const { scene, camera } = cameraHarness(proto);
    const resizing = Object.assign(scene, {
      userMovedCamera: true, layoutDraft: { wallPaintLevel: 2 },
      layoutWallStroke: { tiles: [{ tx: 12, ty: 19 }], gfx: { destroy: vi.fn() } },
      insets: { top: 132, bottom: 102, left: 0, right: 0 },
      clearLayoutWallStroke: proto.clearLayoutWallStroke,
    });
    camera.zoom = 1;

    proto.applyInsets.call(resizing, { top: 132, bottom: 140 });

    expect(resizing.layoutWallStroke).toBeNull();
    expect(resizing.layoutDraft.wallPaintLevel).toBe(2);
    expect(scene.pointerOwnerId).toBeNull();
    expect(scene.multiPointerGesture).toBe(true);
    expect(camera.setZoom).not.toHaveBeenCalled();
    expect(camera.centerOn).not.toHaveBeenCalled();
  });

  it('leaves ordinary pan ownership alone during a viewport resize', async () => {
    const proto = await scenePrototype();
    const { scene, camera } = cameraHarness(proto);
    scene.wallPaint = null;
    const resizing = Object.assign(scene, { userMovedCamera: true, layoutWallStroke: null });
    camera.width = 600;
    camera.height = 800;

    proto.onResize.call(resizing, camera, undefined, undefined, 800, 600);

    expect(scene.pointerOwnerId).toBe(1);
    expect(scene.pinch.onUp).not.toHaveBeenCalled();
    expect(scene.cancelDrag).not.toHaveBeenCalled();
    expect(scene.rebandCamera).toHaveBeenCalledOnce();
    expect(camera.setZoom).toHaveBeenCalled();
  });

  it('drops an unfinished direct-build wall swipe without leaving placement mode', async () => {
    const proto = await scenePrototype();
    const { scene, camera } = cameraHarness(proto);
    const paintMode = scene.wallPaint;
    scene.ghost = { type: 'wall' };
    scene.input.pointer1.isDown = false; // resize may follow an OS touch cancellation
    camera.width = 600;
    camera.height = 800;

    proto.onResize.call(scene, camera, undefined, undefined, 800, 600);

    expect(scene.wallPaint).toBe(paintMode);
    expect(paintMode?.tiles).toEqual([]);
    expect(paintMode?.set.size).toBe(0);
    expect(paintMode?.gfx.clear).toHaveBeenCalledOnce();
    expect(scene.pointerOwnerId).toBeNull();
    expect(scene.multiPointerGesture).toBe(false);
    expect(scene.endGhost).not.toHaveBeenCalled();
  });

  it('centres a queue target in the unobstructed viewport and selects its real identity', async () => {
    const proto = await scenePrototype();
    const sprite = {
      getData: vi.fn((key: string) => ({ tx: 10, ty: 20 } as Record<string, number>)[key]),
    };
    const camera = { zoom: 2, centerOn: vi.fn() };
    const scene = {
      buildingSprites: new Map([['keep-1', sprite]]),
      cameras: { main: camera },
      insets: { top: 100, right: 76, bottom: 20, left: 0 },
      positionedFootprint: vi.fn(() => ({ fw: 2, fh: 1 })),
      clearWallLine: vi.fn(),
      showSelection: vi.fn(),
      userMovedCamera: false,
    };

    const previousBase = useApp.getState().base;
    useApp.setState({ base: { ...storeBase(null), buildings: [
      { id: 'keep-1', type: 'keep', level: 1, tx: 10, ty: 20, underConstruction: false },
    ] } });
    proto.focusObject.call(scene, 'building', 'keep-1');

    // Target centre = (11,20.5) tiles. The right rail shifts the camera centre
    // 19 world px right; the taller top chrome shifts it 20 world px up.
    expect(camera.centerOn).toHaveBeenCalledWith(723, 1292);
    expect(useApp.getState().selectedBuildingId).toBe('keep-1');
    expect(scene.showSelection).toHaveBeenCalledWith('keep-1');
    expect(scene.userMovedCamera).toBe(true);
    useApp.getState().select(null); useApp.setState({ base: previousBase });
  });

  it('never multiplies zoom from a HUD command — stale in/out ops reframe instead', async () => {
    // M23 a10 removed the +/- pills; FIT is the only HUD camera command. A
    // stale caller (an old cached bundle emitting 'in'/'out') must get a safe
    // reframe, never a zoom multiplier — the multiplier back door is what the
    // owner asked to close.
    const proto = await scenePrototype();
    const { scene, camera } = cameraHarness(proto);
    scene.zoomBand = { min: 0.42, max: 1.5 };
    camera.zoom = 1;

    proto.commandCamera.call(scene, 'in' as never);
    expect(camera.setZoom).toHaveBeenCalledWith(0.42); // the fit, not 1×step
    expect(camera.centerOn).toHaveBeenCalled();
  });

  it('restores the live claim fit with one accessible HUD command', async () => {
    const proto = await scenePrototype();
    const { scene, camera } = cameraHarness(proto);
    scene.zoomBand = { min: 0.42, max: 1.5 };
    camera.zoom = 1;

    proto.commandCamera.call(scene, 'fit');

    expect(camera.setZoom).toHaveBeenCalledWith(0.42);
    expect(camera.centerOn).toHaveBeenCalled();
  });

  it('updates extended HOME bounds without recentering a deliberate pan', async () => {
    const proto = await scenePrototype();
    const prior = useApp.getState().base;
    useApp.setState({ base: { ...prior, claim: { min: -10, max: 40 }, plotVersion: 2 } as BaseStateDto });
    try {
      const camera = { width: 2400, height: 1080, center: { x: 1050, y: 700 },
        setBounds: vi.fn((_x: number, _y: number, _width: number, _height: number, centerOn: boolean) => {
          if (centerOn) camera.center = { x: 960, y: 960 };
        }) };
      const scene = { cameras: { main: camera }, insets: { top: 180, bottom: 24, left: 0, right: 72 },
        pinch: { setLimits: vi.fn() }, fantasyGround: { setCoverage: vi.fn() } };
      proto.rebandCamera.call(scene);
      expect(camera.setBounds).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number), false);
      expect(camera.center).toEqual({ x: 1050, y: 700 });
      expect(scene.fantasyGround.setCoverage).toHaveBeenCalledOnce();
    } finally { useApp.setState({ base: prior }); }
  });

  it('accepts late HUD measurements without yanking a player-moved camera', async () => {
    const proto = await scenePrototype();
    const { scene, camera } = cameraHarness(proto);
    const measured = scene as typeof scene & {
      userMovedCamera: boolean;
      insets: { top: number; bottom: number; left: number; right: number } | null;
    };
    measured.userMovedCamera = true;
    measured.insets = null;
    camera.zoom = 1;

    proto.applyInsets.call(scene, { top: 132, bottom: 102, left: 3, right: 4 });

    expect(scene.rebandCamera).toHaveBeenCalledOnce();
    expect(scene.fitCamera).not.toHaveBeenCalled();
    expect(camera.setZoom).not.toHaveBeenCalled();
    expect(camera.centerOn).not.toHaveBeenCalled();
  });

  it('uses the canonical footprint when no opaque art handler won', async () => {
    const proto = await scenePrototype();
    const { scene, handlers } = cameraHarness(proto);
    scene.obstaclePress = null;
    scene.panSuppressed = false;
    scene.pointerOwnerId = null;
    const footprint = { getData: vi.fn((key: string) => key === 'buildingId' ? 'keep' : undefined) };
    scene.footprintObjectAt.mockReturnValue(footprint);
    proto.setupCameraInput.call(scene);

    const down = basePointer({ x: 150, y: 220 });
    handlers.get('pointerdown')!(down);
    expect(scene.footprintObjectAt).toHaveBeenCalledWith(150, 220);
    expect(scene.beginBuildingPress).toHaveBeenCalledWith(footprint, down);
    expect(scene.pointerOwnerId).toBe(1);

    scene.drag = { pointerId: 1 }; // visible GameObject handler already won
    scene.footprintObjectAt.mockClear();
    handlers.get('pointerdown')!(down);
    expect(scene.footprintObjectAt).not.toHaveBeenCalled();
  });

  it('promotes over-threshold obstacle motion into camera pan on the same move', async () => {
    const proto = await scenePrototype();
    const { scene, camera, handlers } = cameraHarness(proto);
    scene.wallPaint = null;
    const setup = proto.setupCameraInput;
    setup.call(scene);
    const move = handlers.get('pointermove')!;

    move(basePointer());
    expect(camera.scrollX).toBe(100); // still an obstacle tap below threshold
    expect(scene.panSuppressed).toBe(true);

    move(basePointer({ x: 30, prevPosition: { x: 20, y: 10 } }));
    expect(scene.obstaclePress).toBeNull();
    expect(scene.panSuppressed).toBe(false);
    expect(camera.scrollX).toBe(95); // same 10px move pans at zoom 2
  });

  it('stops per-object pixel hit testing after a touch becomes a pan, then restores every exit', async () => {
    const proto = await scenePrototype();
    const { scene, handlers } = cameraHarness(proto);
    scene.wallPaint = null;
    scene.obstaclePress = null;
    scene.panSuppressed = false;
    const keep = { input: { enabled: true } };
    const wall = { input: { enabled: true } };
    scene.buildingSprites.set('keep', keep);
    scene.buildingSprites.set('wall', wall);
    proto.setupCameraInput.call(scene);

    handlers.get('pointermove')!(basePointer({
      wasTouch: true,
      event: { pointerType: 'touch' },
      x: 40,
      prevPosition: { x: 20, y: 10 },
      getDistance: () => 30,
    }));
    expect(scene.objectHitTestsSuppressed).toBe(true);
    expect([keep.input.enabled, wall.input.enabled]).toEqual([false, false]);

    // Phaser marks the Pointer up before dispatch. The scene-level listener is
    // still alive while object inputs are disabled and re-arms the NEXT tap.
    handlers.get('pointerup')!(basePointer({
      wasTouch: true,
      event: { pointerType: 'touch' },
      primaryDown: false,
      isDown: false,
    }));
    expect(scene.objectHitTestsSuppressed).toBe(false);
    expect([keep.input.enabled, wall.input.enabled]).toEqual([true, true]);

    // Cancellation/outside paths share the same cleanup and cannot strand a
    // base with untappable buildings.
    proto.setObjectHitTestsSuppressed.call(scene, true);
    handlers.get('gameout')!();
    expect([keep.input.enabled, wall.input.enabled]).toEqual([true, true]);
  });

  it('rewrites object input only when touch-pan suppression changes state', async () => {
    // WHY: a dense-base pan emits many pointer samples after crossing the drag
    // threshold. Rewalking every object on each sample creates avoidable main-
    // thread work on Solana Mobile even though suppression is already active.
    const proto = await scenePrototype();
    const { scene } = cameraHarness(proto);
    let enabled = true;
    const writes: boolean[] = [];
    const input = Object.defineProperty({}, 'enabled', {
      get: () => enabled,
      set: (next: boolean) => { enabled = next; writes.push(next); },
    }) as { enabled: boolean };
    scene.buildingSprites.set('keep', { input });

    proto.setObjectHitTestsSuppressed.call(scene, true);
    proto.setObjectHitTestsSuppressed.call(scene, true);
    proto.setObjectHitTestsSuppressed.call(scene, false);
    proto.setObjectHitTestsSuppressed.call(scene, false);

    expect(writes).toEqual([false, true]);
  });

  it('validates a transparent-footprint obstacle release against the object under pointerup', async () => {
    const proto = await scenePrototype();
    const releaseObject = (obstacleId: string) => ({
      getData: vi.fn((key: string) => key === 'obstacleId' ? obstacleId : undefined),
    });

    for (const releasedId of ['oak', 'rock'] as const) {
      const { scene, handlers } = cameraHarness(proto);
      scene.wallPaint = null;
      scene.footprintObjectAt.mockReturnValue(releaseObject(releasedId));
      proto.setupCameraInput.call(scene);

      handlers.get('pointerup')!(basePointer({ primaryDown: false, isDown: false }));

      // commitObstaclePress compares this release id with the stored down id.
      // Passing `rock` here (rather than blindly recycling stored `oak`) is the
      // production distinction that makes a neighbouring release fail closed.
      expect(scene.commitObstaclePress).toHaveBeenCalledWith(releasedId, expect.anything());
      expect(scene.obstaclePress).toBeNull();
      expect(scene.pointerOwnerId).toBeNull();
    }
  });

  it('does not pan from a secondary mouse drag even when that Pointer is down', async () => {
    const proto = await scenePrototype();
    const { scene, camera, handlers } = cameraHarness(proto);
    scene.wallPaint = null;
    scene.obstaclePress = null;
    scene.panSuppressed = false;
    proto.setupCameraInput.call(scene);

    handlers.get('pointermove')!(basePointer({
      button: 2, primaryDown: false, x: 40, prevPosition: { x: 20, y: 10 },
    }));

    expect(camera.scrollX).toBe(100);
    expect(camera.scrollY).toBe(100);
  });

  it('does not let a secondary mouse release finish the primary building gesture', async () => {
    const proto = await scenePrototype();
    const { scene, handlers } = cameraHarness(proto);
    const drag = { pointerId: 1 };
    scene.drag = drag;
    proto.setupCameraInput.call(scene);

    handlers.get('pointerup')!(basePointer({
      button: 2,
      primaryDown: true, // left is still held when button 2 releases
      isDown: true,
    }));

    expect(scene.pointerOwnerId).toBe(1);
    expect(scene.drag).toBe(drag);
    expect(scene.cancelDrag).not.toHaveBeenCalled();
    expect(scene.endGhost).not.toHaveBeenCalled();
  });

  it('routes Phaser TOUCH_CANCEL through the real pointerup path without committing', async () => {
    const proto = await scenePrototype();
    const { scene, handlers } = cameraHarness(proto);
    const destroy = vi.fn();
    scene.liftShadow = { destroy };
    scene.input.pointer1.isDown = false; // Phaser updates Pointer state before dispatch.
    proto.setupCameraInput.call(scene);

    handlers.get('pointerup')!(basePointer({
      wasTouch: true,
      wasCanceled: true,
      primaryDown: false,
      isDown: false,
      event: { pointerType: 'touch' },
    }));

    expect(scene.pinch.onUp).toHaveBeenCalledOnce();
    expect(scene.pointerOwnerId).toBeNull();
    expect(scene.obstaclePress).toBeNull();
    expect(scene.panSuppressed).toBe(false);
    expect(scene.wallPaint?.tiles).toEqual([]);
    expect(scene.wallPaint?.set.size).toBe(0);
    expect(scene.wallPaint?.gfx.clear).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(scene.cancelDrag).toHaveBeenCalledOnce();
    expect(scene.endGhost).not.toHaveBeenCalled();
  });

  it.each(['pointerupoutside', 'gameout'] as const)('%s discards every armed object and wall gesture', async (event) => {
    const proto = await scenePrototype();
    const { scene, handlers } = cameraHarness(proto);
    proto.setupCameraInput.call(scene);
    const destroy = vi.fn();
    scene.liftShadow = { destroy };

    if (event === 'pointerupoutside') {
      handlers.get(event)!(basePointer({ primaryDown: false, isDown: false }));
    } else {
      handlers.get(event)!();
    }

    expect(scene.pinch.onUp).toHaveBeenCalledOnce();
    expect(scene.panSuppressed).toBe(false);
    expect(scene.obstaclePress).toBeNull();
    expect(scene.wallPaint?.tiles).toEqual([]);
    expect(scene.wallPaint?.set.size).toBe(0);
    expect(scene.wallPaint?.gfx.clear).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(scene.liftShadow).toBeNull();
    expect(scene.cancelDrag).toHaveBeenCalledOnce();
  });

  it('cancels object/paint ownership at two-finger onset and suppresses both releases', async () => {
    const proto = await scenePrototype();
    const { scene, handlers } = cameraHarness(proto);
    scene.drag = { pointerId: 1 };
    scene.ghost = { type: 'wall' };
    scene.input.pointer2.isDown = true;
    proto.setupCameraInput.call(scene);

    handlers.get('pointerdown')!(basePointer({
      id: 2,
      wasTouch: true,
      event: { pointerType: 'touch' },
    }));

    expect(scene.multiPointerGesture).toBe(true);
    expect(scene.pointerOwnerId).toBeNull();
    expect(scene.cancelDrag).toHaveBeenCalledOnce();
    expect(scene.obstaclePress).toBeNull();
    expect(scene.wallPaint?.tiles).toEqual([]);

    scene.input.pointer2.isDown = false;
    handlers.get('pointerup')!(basePointer({
      id: 2,
      wasTouch: true,
      primaryDown: false,
      isDown: false,
      event: { pointerType: 'touch' },
    }));
    expect(scene.multiPointerGesture).toBe(true); // touch 1 still owns the surface

    scene.input.pointer1.isDown = false;
    handlers.get('pointerup')!(basePointer({
      wasTouch: true,
      primaryDown: false,
      isDown: false,
      event: { pointerType: 'touch' },
    }));
    expect(scene.multiPointerGesture).toBe(false);
    expect(scene.endGhost).not.toHaveBeenCalled();
  });
});

describe('BaseScene owns native contacts instead of pooled pointer slots', () => {
  const touch = (id: number, identifier: number, x: number, identifiers = [identifier]) => basePointer({
    id, identifier, x, y: 100, wasTouch: true,
    event: { pointerType: 'touch', touches: identifiers.map((value) => ({ identifier: value })) },
  });
  async function harness() {
    const proto = await scenePrototype();
    const h = cameraHarness(proto);
    h.scene.pointerContacts.clear(); h.scene.pointerOwnerId = null;
    h.scene.obstaclePress = null; h.scene.panSuppressed = false; h.scene.wallPaint = null;
    // Exercise the actual distance-ratio zoom, not just a call to a mocked pinch.
    const pinch = new PinchZoom(h.camera as never, () => {}, { min: 0.1, max: 8 });
    h.scene.pinch.onMove.mockImplementation((a, b) => pinch.onMove(a as never, b as never));
    h.scene.pinch.onUp.mockImplementation(() => pinch.onUp());
    h.scene.pinch.active.mockImplementation(() => pinch.active());
    proto.setupCameraInput.call(h.scene);
    const down = (p: BasePointer) => h.handlers.get('pointerdown')!(p);
    const move = (p: BasePointer, x: number, identifiers: number[]) => {
      p.prevPosition = { x: p.x, y: p.y }; p.x = x;
      p.event = { pointerType: 'touch', touches: identifiers.map((identifier) => ({ identifier })) };
      h.handlers.get('pointermove')!(p);
    };
    const up = (p: BasePointer, identifiers: number[]) => {
      p.isDown = false; p.primaryDown = false;
      p.event = { pointerType: 'touch', touches: identifiers.map((identifier) => ({ identifier })) };
      h.handlers.get('pointerup')!(p);
    };
    return { ...h, proto, down, move, up };
  }

  it('pans one actual finger even when the global second slot remains down', async () => {
    const h = await harness();
    h.scene.input.pointer2.isDown = true;
    const finger = touch(1, 101, 100);
    h.down(finger); h.move(finger, 120, [101]);
    expect(h.camera.scrollX).toBe(90);
    expect(h.camera.zoom).toBe(2);
    expect(h.scene.pinch.onMove).not.toHaveBeenCalled();
  });

  it('rejects a HUD down even when Phaser dispatches an object hit below the DOM control', async () => {
    const h = await harness();
    const canvas = {}; Object.assign(h.scene.game, { canvas });
    const hud = { ...touch(2, 202, 200, [101, 202]), downElement: {} };
    const finger = { ...touch(1, 101, 100), downElement: canvas };
    h.down(finger);
    h.proto.beginBuildingPress.call(h.scene, {}, hud);
    h.proto.beginObstaclePress.call(h.scene, 'oak', hud);
    h.down(hud); // captured/forwarded scene event is refused too
    expect(h.scene.pointerContacts.size).toBe(1);
    expect(h.scene.drag).toBeNull(); expect(h.scene.obstaclePress).toBeNull();
    h.move(finger, 120, [101, 202]);
    expect(h.camera.scrollX).toBe(90);
    expect(h.scene.pinch.onMove).not.toHaveBeenCalled();
  });

  it.each(['gameout', 'pointercancel', 'blur', 'hidden', 'sleep'] as const)(
    '%s retires contacts so pooled down slots cannot resurrect the pinch', async (event) => {
      const h = await harness();
      const first = touch(1, 101, 100); const second = touch(2, 202, 200, [101, 202]);
      h.down(first); h.down(second); h.move(second, 200, [101, 202]);
      h.scene.input.pointer1 = first; h.scene.input.pointer2 = second;
      if (event === 'blur' || event === 'hidden') h.gameHandlers.get(event)!();
      else if (event === 'sleep') h.proto.cancelPointerGesture.call(h.scene); // same scene SLEEP handler
      else h.handlers.get(event)!();
      expect(h.scene.pointerContacts.size).toBe(0);
      const zoom = h.camera.zoom;
      h.move(first, 130, [101, 202]);
      expect(h.camera.zoom).toBe(zoom); expect(h.camera.scrollX).toBe(100);
      // A later real down, even in the reused slot, owns a fresh one-finger pan.
      const fresh = touch(1, 303, 100); h.down(fresh); h.move(fresh, 120, [303]);
      expect(h.camera.zoom).toBe(zoom); expect(h.camera.scrollX).toBe(90);
      expect(h.scene.multiPointerGesture).toBe(false);
    },
  );

  it('repairs a lost touchend from native touches and permits the next real pinch', async () => {
    const h = await harness();
    const first = touch(1, 101, 100); const second = touch(2, 202, 200, [101, 202]);
    h.down(first); h.down(second); h.move(second, 200, [101, 202]);
    // The platform forgot the up callback; the old pooled object still says down.
    h.move(second, 220, [202]);
    expect(first.isDown).toBe(true);
    expect([...h.scene.pointerContacts.keys()]).toEqual([2]);
    expect(h.camera.zoom).toBe(2);
    const replacement = touch(1, 303, 100, [202, 303]);
    h.down(replacement); h.move(second, 220, [202, 303]); h.move(second, 280, [202, 303]);
    expect(h.camera.zoom).toBe(3);
    expect(h.scene.commitObstaclePress).not.toHaveBeenCalled();
  });

  it('rejects a pooled object reassigned to another native finger without a canvas down', async () => {
    const h = await harness();
    const pooled = touch(1, 101, 100); h.down(pooled);
    pooled.identifier = 202; // same JavaScript object; a new physical contact on a HUD control
    h.move(pooled, 160, [202]); h.up(pooled, []);
    expect(h.scene.pointerContacts.size).toBe(0);
    expect(h.camera.scrollX).toBe(100); expect(h.camera.zoom).toBe(2);
    expect(h.scene.commitObstaclePress).not.toHaveBeenCalled();
  });

  it.each(['pointerup', 'pointerupoutside'] as const)('a reused slot %s retires the missing old contact without committing it', async (event) => {
    const h = await harness();
    const pooled = touch(1, 101, 100); h.down(pooled);
    // No move arrives between the missing old end and this different finger's release.
    pooled.identifier = 202; pooled.isDown = false; pooled.primaryDown = false;
    pooled.event = { pointerType: 'touch', touches: [] };
    h.handlers.get(event)!(pooled);
    expect(h.scene.pointerContacts.size).toBe(0);
    expect(h.scene.pointerOwnerId).toBeNull();
    expect(h.scene.commitObstaclePress).not.toHaveBeenCalled();
    expect(h.scene.endGhost).not.toHaveBeenCalled();
  });

  it('repeated pinch then fresh pan never zooms or commits from the residual finger', async () => {
    const h = await harness();
    h.camera.zoom = 1;
    for (let cycle = 0; cycle < 3; cycle++) {
      const a = 100 + cycle * 3; const b = a + 1;
      const first = touch(1, a, 100); const second = touch(2, b, 200, [a, b]);
      h.down(first); h.down(second); h.move(second, 200, [a, b]); h.move(second, 250, [a, b]);
      const zoom = h.camera.zoom; const scroll = h.camera.scrollX;
      h.up(second, [a]); h.move(first, 140, [a]); h.up(first, []);
      expect(h.camera.zoom).toBe(zoom); expect(h.camera.scrollX).toBe(scroll);
      expect(h.scene.multiPointerGesture).toBe(false);
      const next = touch(1, a + 2, 100); h.down(next); h.move(next, 130, [a + 2]); h.up(next, []);
      expect(h.camera.scrollX).toBeCloseTo(scroll - 30 / zoom);
      expect(h.camera.zoom).toBe(zoom);
      expect(h.scene.pointerContacts.size).toBe(0);
    }
    expect(h.scene.commitObstaclePress).not.toHaveBeenCalled();
    expect(h.scene.endGhost).not.toHaveBeenCalled();
  });

  it('registers object then scene down once and cancels the first object before a second can steal it', async () => {
    const proto = await scenePrototype();
    const { scene, handlers, carried } = gestureHarness(proto);
    const first = touch(1, 101, 100); const second = touch(2, 202, 200, [101, 202]);
    proto.beginBuildingPress.call(scene, carried as unknown as Record<string, unknown>, first as unknown as Record<string, unknown>);
    handlers.get('pointerdown')!(first);
    expect(scene.pointerContacts.size).toBe(1); expect(scene.drag?.pointerId).toBe(1);
    proto.beginBuildingPress.call(scene, carried as unknown as Record<string, unknown>, second as unknown as Record<string, unknown>);
    expect(scene.drag).toBeNull(); expect(scene.multiPointerGesture).toBe(true);
    handlers.get('pointerdown')!(second);
    expect(scene.pointerContacts.size).toBe(2); expect(scene.pointerOwnerId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Move-gesture ownership (production feedback #3, Android + PC)
// ---------------------------------------------------------------------------

interface MovableSprite {
  frame: { name: string };
  /** Drawn height — the seat measures the sprite's BOTTOM EDGE from it. */
  displayHeight: number;
  at: { x: number; y: number; depth: number; alpha: number; destroyed: boolean };
  getData: (key: string) => unknown;
  setData: (key: string, value: unknown) => MovableSprite;
  setOrigin: (x: number, y: number) => MovableSprite;
  setScale: (scale: number) => MovableSprite;
  setX: (x: number) => MovableSprite;
  setY: (y: number) => MovableSprite;
  setDepth: (depth: number) => MovableSprite;
  setAlpha: (alpha: number) => MovableSprite;
  setVisible: (visible: boolean) => MovableSprite;
  setTexture: (atlas: string, frame: string) => MovableSprite;
  clearTint: () => MovableSprite;
  destroy: () => void;
  on: (event: string, handler: unknown) => MovableSprite;
}

/** A building sprite that remembers where it was last put, so a test can ask
 *  "did anything move it?" rather than trusting a call count. */
function movableSprite(id: string, tx: number, ty: number, frame: string): MovableSprite {
  const data = new Map<string, unknown>([
    ['buildingId', id], ['tx', tx], ['ty', ty], ['fw', 1], ['fh', 1],
  ]);
  const at = { x: 0, y: 0, depth: 0, alpha: 1, destroyed: false };
  const sprite: MovableSprite = {
    frame: { name: frame },
    displayHeight: 64,
    at,
    getData: (key) => data.get(key),
    setData: (key, value) => { data.set(key, value); return sprite; },
    setOrigin: () => sprite,
    setScale: () => sprite,
    setX: (x) => { at.x = x; return sprite; },
    setY: (y) => { at.y = y; return sprite; },
    setDepth: (depth) => { at.depth = depth; return sprite; },
    setAlpha: (alpha) => { at.alpha = alpha; return sprite; },
    setVisible: () => sprite,
    setTexture: (_atlas, next) => { sprite.frame.name = next; return sprite; },
    clearTint: () => sprite,
    destroy: () => { at.destroyed = true; },
    on: () => sprite,
  };
  return sprite;
}

/** The store snapshot BaseScene renders from. `movedTo` is the only knob: the
 *  server row for the carried building, which stays put until a move commits. */
function storeBase(movedTo: { tx: number; ty: number } | null): BaseStateDto {
  return {
    buildings: [
      ...(movedTo === null ? [] : [{
        id: 'barracks', type: 'barracks', level: 1, ...movedTo, underConstruction: false,
      }]),
      { id: 'lab', type: 'lab', level: 1, tx: 9, ty: 9, underConstruction: false },
    ],
    obstacles: [],
    jobs: [],
    heroes: [],
    army: [],
    armyStatus: {
      readyTroopCount: 0, readyPts: 0, campCapacityPts: 0,
      trainingTroopCount: 0, trainingPts: 0, barracksQueuePts: 0,
      nextReadyAt: null, allReadyAt: null,
    },
    player: { wallet: 'wallet' },
    claim: { min: 4, max: 16 },
  } as unknown as BaseStateDto;
}

function gestureHarness(proto: ScenePrototype) {
  const handlers = new Map<string, (pointer?: BasePointer) => void>();
  const carried = movableSprite('barracks', 6, 6, 'bld_barracks_l1');
  const other = movableSprite('lab', 9, 9, 'bld_lab_l1');
  const camera = {
    width: 800, height: 600, zoom: 1, scrollX: 0, scrollY: 0,
    getWorldPoint: vi.fn((x: number, y: number) => ({ x, y })),
    setZoom: vi.fn(),
    centerOn: vi.fn(),
  };
  const scene = {
    ...pointerContactHarness(proto, []),
    // --- the seam under test, real ---
    renderFromStore: proto.renderFromStore,
    syncRemnants: proto.syncRemnants,
    carriedPieces: proto.carriedPieces,
    reseatCarriedPieces: proto.reseatCarriedPieces,
    liftPiece: proto.liftPiece,
    // The post-drop hold: a class FIELD on the real scene, so the stub has to
    // seed it or renderFromStore reads `undefined.keys()`.
    settlingMoves: new Map<string, { tx: number; ty: number; fp: { fw: number; fh: number } }>(),
    holdSettlingMove: proto.holdSettlingMove,
    reseatSettlingMoves: proto.reseatSettlingMoves,
    releaseSettlingMoves: proto.releaseSettlingMoves,
    cancelDrag: proto.cancelDrag,
    cancelPointerGesture: proto.cancelPointerGesture,
    clearWallStroke: proto.clearWallStroke,
    beginMultiPointerGesture: proto.beginMultiPointerGesture,
    setObjectHitTestsSuppressed: proto.setObjectHitTestsSuppressed,
    isTouchPointer: proto.isTouchPointer,
    suppressObjectHitTestsForTouchPan: proto.suppressObjectHitTestsForTouchPan,
    pointerInteractionActive: proto.pointerInteractionActive,
    flushInteractionIdleWaiters: proto.flushInteractionIdleWaiters,
    beginBuildingPress: proto.beginBuildingPress,
    positionBuilding: vi.fn(proto.positionBuilding),
    positionLiftedBuilding: proto.positionLiftedBuilding,
    positionedFootprint: proto.positionedFootprint,
    buildingSeat: proto.buildingSeat,
    acceptsObjectGesture: proto.acceptsObjectGesture,
    acceptsGestureRelease: proto.acceptsGestureRelease,
    setupCameraInput: proto.setupCameraInput,
    // --- seat inputs: no v2/WARE clips, so every seat is the plain [0.5, 1] ---
    meta: {} as Record<string, unknown>,
    v2meta: { clips: {}, atlasBytes: {} },
    waremeta: { clips: {} },
    // --- scene plumbing ---
    cameras: { main: camera },
    scale: { on: vi.fn(), off: vi.fn() },
    onResize: vi.fn(),
    unsub: [] as Array<() => void>,
    input: {
      on: vi.fn((event: string, handler: (pointer?: BasePointer) => void) => {
        handlers.set(event, handler);
      }),
      pointer1: { id: 1, isDown: true, x: 0, y: 0 },
      pointer2: { id: 2, isDown: false, x: 0, y: 0 },
      activePointer: { id: 1, isDown: true },
    },
    time: { delayedCall: vi.fn() },
    pinch: { onMove: vi.fn(), active: vi.fn(() => false), onUp: vi.fn(), setLimits: vi.fn() },
    zoomBand: { min: 0.5, max: 1.5 },
    rebandCamera: vi.fn(),
    fitCamera: vi.fn(),
    userMovedCamera: true,
    lastClaimKey: 'wallet:1:4,16',
    drag: null as Record<string, unknown> | null,
    ghost: null,
    wallPaint: null,
    wallLineIds: new Set<string>(),
    obstaclePress: null,
    panSuppressed: false,
    pointerOwnerId: 1 as number | null,
    multiPointerGesture: false,
    objectHitTestsSuppressed: false,
    interactionIdleWaiters: new Set<{ resolve: () => void; reject: (cause: Error) => void }>(),
    richArtLoadsStopped: false,
    liftShadow: { setPosition: vi.fn(), destroy: vi.fn() } as { destroy: () => void } | null,
    // --- everything renderFromStore drives that this seam does not decide ---
    buildingSprites: new Map<string, MovableSprite>([['barracks', carried], ['lab', other]]),
    remnantImages: new Map(),
    wareBuildings: new Map(), wareTraps: new Map(), wareWalls: new Map(),
    marketBuildings: new Map(), marketAwnings: new Map(),
    berthBuildings: new Map(), starterBerths: new Map(), starterFleetArt: EMPTY_STARTER_FLEET_ART,
    battleReleasedV2Buildings: new Set<string>(),
    recomputeWallFrames: vi.fn(),
    spriteKeyFor: vi.fn((b: { type: string }) => `bld_${b.type}_l1`),
    footprintOf: vi.fn(() => ({ fw: 1, fh: 1 })),
    wareGroupForBuilding: vi.fn((_building?: { level: number }): string | null => null),
    syncWareController: vi.fn(),
    destroyWareController: vi.fn(),
    syncMarketController: vi.fn(),
    destroyMarketController: vi.fn(),
    syncBerthController: vi.fn(),
    destroyBerthController: vi.fn(),
    attachBuildingInput: vi.fn(),
    refreshFootprintHitArea: vi.fn(),
    keepClock: { sync: vi.fn(), remove: vi.fn() },
    occ: { rebuild: vi.fn() },
    ambience: { sync: vi.fn(), hide: vi.fn(), show: vi.fn() },
    heroRecovery: { sync: vi.fn(), hide: vi.fn(), show: vi.fn() },
    armyStatus: {
      sync: vi.fn(), hide: vi.fn(), show: vi.fn(), setSuppressed: vi.fn(),
    },
    patrol: { sync: vi.fn() },
    jobs: { sync: vi.fn(() => []) },
    ambientBusy: false,
    hammerInMs: 0,
    releaseV2DefenseArtForPatrol: vi.fn(() => false),
    releaseDisplayedWareArt: vi.fn(() => false),
    // The hold renderFromStore takes on the granted patrol's atlas groups
    // (BaseScene.patrolArtLease) — a class field + method on the real scene.
    patrolArtLease: null as (() => void) | null,
    releasePatrolArtLease: proto.releasePatrolArtLease,
    loadV2Candidates: vi.fn((_candidates: readonly Candidate[]) => Promise.resolve()),
    drawPlacementGrid: vi.fn(),
    clearPlacementGrid: vi.fn(),
    showFootprintTint: vi.fn(),
    clearFootprintTint: vi.fn(),
    isValidSpot: vi.fn(() => true),
    showSelection: vi.fn(),
    clearWallLine: vi.fn(),
    endGhost: vi.fn(),
    footprintObjectAt: vi.fn(() => null),
    beginObstaclePress: vi.fn(),
    commitObstaclePress: vi.fn(),
    add: { sprite: vi.fn() },
  };
  proto.setupCameraInput.call(scene);
  return { scene, camera, handlers, carried, other };
}

// (6, 6) is the store tile; the gesture carries the piece to (9, 11). Seats are
// the plain bottom-edge contract: x = (tx + fw/2) * T, y = (ty + fh) * T, and a
// lifted piece sits LIFT (16) above that.
/** BaseScene's LIFT_DEPTH: a carried piece rides in WORLD_DEPTH.overlay, above
 *  the world it is being dragged across. Named here so this file cannot drift
 *  back to a bare 2500 that would now sort UNDER every building. */
const LIFT_DEPTH = WORLD_DEPTH.overlay + 2500;
const HELD_X = (9 + 0.5) * 64;
const HELD_Y = (11 + 1) * 64 - 16;

/** Press the carried building, then drag it past the threshold after the
 *  hold — the same two events Phaser dispatches for a finger or a mouse. */
function liftCarried(
  scene: Record<string, unknown>,
  handlers: Map<string, (pointer?: BasePointer) => void>,
  carried: MovableSprite,
  pointerKind: 'mouse' | 'touch',
): void {
  const touch = pointerKind === 'touch';
  const traits = { wasTouch: touch, event: { pointerType: pointerKind } };
  const down = basePointer({ ...traits, x: 608, y: 608 });
  (scene['beginBuildingPress'] as (s: unknown, p: unknown) => void).call(
    scene, carried, down,
  );
  handlers.get('pointerdown')!(down); // Phaser dispatches object down before scene down.
  handlers.get('pointermove')!(basePointer({
    ...traits, x: 608, y: 736, prevPosition: { x: 608, y: 608 }, getDuration: () => 300,
  }));
}

describe('BaseScene move-gesture ownership', () => {
  let priorBase: BaseStateDto | null = null;
  let priorSelected: string | null = null;

  beforeEach(() => {
    priorBase = useApp.getState().base;
    priorSelected = useApp.getState().selectedBuildingId;
  });
  afterEach(() => {
    useApp.setState({ base: priorBase, selectedBuildingId: priorSelected });
  });

  it.each(['mouse', 'touch'] as const)(
    'never lets a mid-gesture refresh reseat the piece a %s is still holding',
    async (pointerKind) => {
      // The reported defect (Android + PC): the base auto-refetch heartbeat
      // re-polls /base while the player holds a building over its new tile. Its
      // row still has the OLD tile, so renderFromStore dropped the lifted sprite
      // back there; the next pointermove lifted it again, and the piece strobed
      // between the two tiles for as long as the hold lasted.
      const proto = await scenePrototype();
      const { scene, handlers, carried, other } = gestureHarness(proto);
      useApp.setState({ base: storeBase({ tx: 6, ty: 6 }) });

      liftCarried(scene, handlers, carried, pointerKind);
      expect(scene.drag).toMatchObject({ id: 'barracks', moved: true, curTx: 9, curTy: 11 });
      expect(carried.at).toMatchObject({ x: HELD_X, y: HELD_Y, depth: LIFT_DEPTH, alpha: 0.95 });

      // Two refreshes: the heartbeat repeats every 2s while a job deadline is
      // elapsed, and the bug was visible on every single one.
      proto.renderFromStore.call(scene);
      proto.renderFromStore.call(scene);

      expect(carried.at).toMatchObject({ x: HELD_X, y: HELD_Y, depth: LIFT_DEPTH, alpha: 0.95 });
      expect(scene.positionBuilding.mock.calls.map(([sprite]) => sprite))
        .not.toContain(carried);
      // The animated twin must stay off the tile the piece left: ambience.sync()
      // reveals every pooled copy, so the hide has to be re-asserted per refresh.
      expect(scene.ambience.hide).toHaveBeenCalledWith('barracks');
      expect(scene.ambience.hide).toHaveBeenCalledTimes(3); // lift + two refreshes
      expect(scene.armyStatus.hide).toHaveBeenCalledWith('barracks');
      expect(scene.armyStatus.hide).toHaveBeenCalledTimes(3);
      expect(scene.armyStatus.sync).toHaveBeenCalledTimes(2);
      expect(scene.armyStatus.sync.mock.calls[0]?.[0]).toEqual(
        useApp.getState().base?.armyStatus,
      );
      // Refreshes still flow for everything else — this is not a global freeze.
      expect(scene.positionBuilding).toHaveBeenCalledWith(other, 9, 9, { fw: 1, fh: 1 });
      expect(scene.patrol.sync).toHaveBeenCalledTimes(2);
      expect(scene.jobs.sync).toHaveBeenCalledTimes(2);
    },
  );

  it('hands a confirmed drop back to the store, at the tile the server now holds', async () => {
    const proto = await scenePrototype();
    const { scene, handlers, carried } = gestureHarness(proto);
    useApp.setState({ base: storeBase({ tx: 6, ty: 6 }) });
    liftCarried(scene, handlers, carried, 'mouse');

    handlers.get('pointerup')!(basePointer({
      x: 608, y: 736, primaryDown: false, isDown: false,
    }));

    expect(scene.drag).toBeNull();
    expect(scene.positionBuilding).toHaveBeenCalledWith(carried, 9, 11, { fw: 1, fh: 1 });
    expect(carried.at).toMatchObject({ y: (11 + 1) * 64, alpha: 1 }); // settled, not lifted
    // The move's own refresh: the row finally agrees, and the store is in charge
    // again — no lift may survive the gesture that ended.
    useApp.setState({ base: storeBase({ tx: 9, ty: 11 }) });
    proto.renderFromStore.call(scene);
    // Back on the ground = back in the BUILDING band on its own south edge —
    // not the bare Y it used to take, which is what let it out-sort troops.
    expect(carried.at).toMatchObject({
      x: HELD_X, y: (11 + 1) * 64, depth: structureDepth('building', (11 + 1) * 64),
    });
  });

  it('holds the dropped tile until React reports the move settled', async () => {
    // The gap the gesture fix deliberately left open: between pointerup (which
    // nulls scene.drag and posts the move) and that move's own refresh, the
    // store STILL says the old tile. A 2s heartbeat landing in that window
    // repainted the building back to where it came from — one frame of the same
    // prod-#3 flicker, after the player had already put it down.
    const proto = await scenePrototype();
    const { scene, handlers, carried } = gestureHarness(proto);
    useApp.setState({ base: storeBase({ tx: 6, ty: 6 }) });
    liftCarried(scene, handlers, carried, 'mouse');

    handlers.get('pointerup')!(basePointer({ x: 608, y: 736, primaryDown: false, isDown: false }));
    expect(scene.drag).toBeNull();

    // Heartbeat arrives BEFORE the PATCH resolves: the row is still (6,6).
    proto.renderFromStore.call(scene);
    expect(carried.at).toMatchObject({ y: (11 + 1) * 64, alpha: 1 }); // stayed put

    // React resolves the move, then refreshes with the agreeing row.
    proto.releaseSettlingMoves.call(scene, ['barracks']); // what base:moveSettled runs
    useApp.setState({ base: storeBase({ tx: 9, ty: 11 }) });
    proto.renderFromStore.call(scene);
    expect(carried.at).toMatchObject({ x: HELD_X, y: (11 + 1) * 64 });
  });

  it('lets the store win again once a rejected move settles', async () => {
    // ok:false means the server refused it; by then the store carries that
    // rejection, so holding our optimistic tile any longer would show the
    // player a move that did not happen.
    const proto = await scenePrototype();
    const { scene, handlers, carried } = gestureHarness(proto);
    useApp.setState({ base: storeBase({ tx: 6, ty: 6 }) });
    liftCarried(scene, handlers, carried, 'mouse');
    handlers.get('pointerup')!(basePointer({ x: 608, y: 736, primaryDown: false, isDown: false }));

    proto.releaseSettlingMoves.call(scene, ['barracks']); // ok:false releases identically
    proto.renderFromStore.call(scene); // store still says (6,6) — the refusal
    expect(carried.at).toMatchObject({ y: (6 + 1) * 64 });
  });

  it('reverts a rejected drop and leaves the store owning the sprite again', async () => {
    const proto = await scenePrototype();
    const { scene, handlers, carried } = gestureHarness(proto);
    useApp.setState({ base: storeBase({ tx: 6, ty: 6 }) });
    liftCarried(scene, handlers, carried, 'touch');
    scene.isValidSpot.mockReturnValue(false); // dragged outside the buildable claim

    handlers.get('pointerup')!(basePointer({
      wasTouch: true, event: { pointerType: 'touch' },
      x: 608, y: 736, primaryDown: false, isDown: false,
    }));

    expect(scene.drag).toBeNull();
    expect(carried.at).toMatchObject({ x: (6 + 0.5) * 64, y: (6 + 1) * 64, alpha: 1 });
    // A rejected drop gets no server round trip, so the hidden animated copy has
    // to come back here or the building stays frozen at its origin tile.
    expect(scene.ambience.show).toHaveBeenCalledWith('barracks');
    expect(scene.armyStatus.show).toHaveBeenCalledWith('barracks');
    scene.ambience.hide.mockClear();
    proto.renderFromStore.call(scene);
    expect(carried.at).toMatchObject({ x: (6 + 0.5) * 64, y: (6 + 1) * 64 });
    expect(scene.ambience.hide).not.toHaveBeenCalled();
  });

  it('releases ownership when the gesture is cancelled outside the canvas', async () => {
    const proto = await scenePrototype();
    const { scene, handlers, carried } = gestureHarness(proto);
    useApp.setState({ base: storeBase({ tx: 6, ty: 6 }) });
    liftCarried(scene, handlers, carried, 'touch');

    handlers.get('pointerupoutside')!(basePointer({
      wasTouch: true, event: { pointerType: 'touch' }, primaryDown: false, isDown: false,
    }));

    expect(scene.drag).toBeNull();
    expect(carried.at).toMatchObject({ x: (6 + 0.5) * 64, y: (6 + 1) * 64, alpha: 1 });
    scene.ambience.hide.mockClear();
    proto.renderFromStore.call(scene);
    expect(carried.at).toMatchObject({ x: (6 + 0.5) * 64, y: (6 + 1) * 64 });
    expect(scene.ambience.hide).not.toHaveBeenCalled();
  });

  it('ends the gesture when a refresh deletes the building being carried', async () => {
    // A raid or an obstacle clear can retire the row mid-hold. Nothing may keep
    // carrying — or later reseat — a destroyed sprite, and no move may be
    // committed for a building the server no longer has.
    const proto = await scenePrototype();
    const { scene, handlers, carried } = gestureHarness(proto);
    useApp.setState({ base: storeBase({ tx: 6, ty: 6 }) });
    liftCarried(scene, handlers, carried, 'mouse');

    useApp.setState({ base: storeBase(null) });
    proto.renderFromStore.call(scene);

    expect(scene.drag).toBeNull();
    expect(carried.at.destroyed).toBe(true);
    expect(scene.buildingSprites.has('barracks')).toBe(false);
    expect(carried.at.depth).not.toBe(2500);
  });

  it('leaves an armed press that never moved seated on its store row', async () => {
    // Hold-to-lift arms a drag on pointerdown, but until the piece is actually
    // carried the store is still right about where it belongs — the guard must
    // key on the lift, not on the press.
    const proto = await scenePrototype();
    const { scene, carried } = gestureHarness(proto);
    useApp.setState({ base: storeBase({ tx: 6, ty: 6 }) });
    proto.beginBuildingPress.call(
      scene,
      carried as unknown as Record<string, unknown>,
      basePointer({ x: 608, y: 608 }) as unknown as Record<string, unknown>,
    );

    expect(scene.drag).toMatchObject({ id: 'barracks', moved: false });
    expect(proto.carriedPieces.call(scene)).toEqual([]);
    proto.renderFromStore.call(scene);
    expect(scene.positionBuilding).toHaveBeenCalledWith(carried, 6, 6, { fw: 1, fh: 1 });
    expect(carried.at).toMatchObject({ x: (6 + 0.5) * 64, y: (6 + 1) * 64 });
  });
});

// ---------------------------------------------------------------------------
// Patrol art ownership (owner 2026-08-30: troops "swap between two different
// pictures" on the base view)
// ---------------------------------------------------------------------------

/**
 * The base a garrison walks: one camp, one Gloamfang stack. Gloamfang is the
 * case because its patrol grant is the only one made of TWO atlas groups — the
 * `_locomotion` sheet a walker draws, and the `_combat` sheet that rides with
 * it and that no base sprite ever draws.
 */
function garrisonBase(): BaseStateDto {
  return {
    buildings: [{ id: 'camp', type: 'camp', level: 20, tx: 6, ty: 6, underConstruction: false }],
    obstacles: [],
    jobs: [],
    heroes: [],
    army: [{ troop: 'gloamfang', count: 4, level: 20 }],
    player: { wallet: 'wallet' },
    claim: { min: 4, max: 16 },
  } as unknown as BaseStateDto;
}

/** Just enough packed metadata for Gloamfang's grant to resolve: `prowl` is
 *  both his move and his stand verb (V2_TROOP_PROFILES), and the combat group
 *  is derived from the `rend` key, which needs no clip of its own. */
const GLOAMFANG_CLIPS = Object.fromEntries([1, 2, 3, 4].map((tier) => [
  `v2_trp_gloamfang_t${tier}_prowl`,
  {
    frames: 8, rows: 8, cellW: 96, cellH: 96,
    rowOrder: ['s', 'sw', 'w', 'nw', 'n', 'ne', 'e', 'se'] as const,
    anchorPx: [48, 86] as const, fps: 10, loop: true,
  },
]));

function patrolHarness(proto: ScenePrototype) {
  const scene = {
    renderFromStore: proto.renderFromStore,
    syncRemnants: proto.syncRemnants,
    carriedPieces: proto.carriedPieces,
    reseatCarriedPieces: proto.reseatCarriedPieces,
    reseatSettlingMoves: proto.reseatSettlingMoves,
    releasePatrolArtLease: proto.releasePatrolArtLease,
    patrolArtLease: null as (() => void) | null,
    settlingMoves: new Map(),
    drag: null,
    ghost: null,
    meta: {} as Record<string, unknown>,
    v2meta: { clips: GLOAMFANG_CLIPS, atlasBytes: {} },
    waremeta: { clips: {} },
    cameras: { main: { width: 800, height: 600, zoom: 1, scrollX: 0, scrollY: 0 } },
    lastClaimKey: 'wallet:1:4,16',
    buildingSprites: new Map(),
    remnantImages: new Map(),
    wareBuildings: new Map(), wareTraps: new Map(), wareWalls: new Map(),
    marketBuildings: new Map(), marketAwnings: new Map(),
    berthBuildings: new Map(), starterBerths: new Map(), starterFleetArt: EMPTY_STARTER_FLEET_ART,
    battleReleasedV2Buildings: new Set<string>(),
    recomputeWallFrames: vi.fn(),
    spriteKeyFor: vi.fn((b: { type: string }) => `bld_${b.type}_l1`),
    footprintOf: vi.fn(() => ({ fw: 3, fh: 3 })),
    positionBuilding: vi.fn(),
    wareGroupForBuilding: vi.fn((_building?: { level: number }): string | null => null),
    syncWareController: vi.fn(),
    destroyWareController: vi.fn(),
    syncMarketController: vi.fn(),
    destroyMarketController: vi.fn(),
    syncBerthController: vi.fn(),
    destroyBerthController: vi.fn(),
    attachBuildingInput: vi.fn(),
    refreshFootprintHitArea: vi.fn(),
    keepClock: { sync: vi.fn(), remove: vi.fn() },
    occ: { rebuild: vi.fn() },
    ambience: { sync: vi.fn() },
    heroRecovery: { sync: vi.fn() },
    patrol: { sync: vi.fn() },
    jobs: { sync: vi.fn(() => []) },
    ambientBusy: false,
    hammerInMs: 0,
    releaseV2DefenseArtForPatrol: vi.fn(() => false),
    releaseDisplayedWareArt: vi.fn(() => false),
    loadV2Candidates: vi.fn((_candidates: readonly Candidate[]) => Promise.resolve()),
    drawPlacementGrid: vi.fn(),
    clearPlacementGrid: vi.fn(),
    add: { sprite: vi.fn(() => stubSprite()) },
  };
  return scene;
}

/** Just enough Phaser Sprite for renderFromStore's building pass — this suite
 *  is about the patrol's atlas holds, not about where a camp is drawn. */
function stubSprite(): Record<string, unknown> {
  const data = new Map<string, unknown>();
  const sprite: Record<string, unknown> = {
    frame: { name: 'bld_camp_l1' },
    getData: (key: string) => data.get(key),
    setData: (key: string, value: unknown) => { data.set(key, value); return sprite; },
    setTexture: () => sprite, setOrigin: () => sprite, setScale: () => sprite,
    setVisible: () => sprite, setDepth: () => sprite, setAlpha: () => sprite,
    clearTint: () => sprite, destroy: () => {}, on: () => sprite,
  };
  return sprite;
}

describe('BaseScene patrol art ownership', () => {
  let protoRef: ScenePrototype;
  const LOCOMOTION = v2LocomotionAtlasGroup('gloamfang', 4);
  const COMBAT = v2GloamfangCombatAtlasGroup(4);
  /** Groups the on-demand loader has registered, and what each is held by. */
  let resident: Set<string>;
  let holds: Map<string, number>;
  let priorBase: BaseStateDto | null = null;

  beforeEach(async () => {
    protoRef = await scenePrototype();
    priorBase = useApp.getState().base;
    resident = new Set([LOCOMOTION, COMBAT]);
    holds = new Map();
    atlas.isV2AtlasLoaded.mockImplementation(
      (_scene: unknown, group: string) => resident.has(group),
    );
    atlas.retainAtlasGroups.mockImplementation((_scene: unknown, groups: Iterable<string>) => {
      const held = [...new Set(groups)];
      for (const g of held) holds.set(g, (holds.get(g) ?? 0) + 1);
      return () => {
        for (const g of held) {
          const next = (holds.get(g) ?? 1) - 1;
          if (next > 0) holds.set(g, next); else holds.delete(g);
        }
      };
    });
    // The real sweep's predicate: drop every on-demand group no sprite draws
    // and nothing holds. NO base sprite ever draws Gloamfang's combat sheet, so
    // without a hold this takes it on the pass that granted it.
    atlas.releaseUnreferencedAtlases.mockImplementation(() => {
      for (const group of [...resident]) {
        if (group === LOCOMOTION) continue; // a walker is drawing it
        if ((holds.get(group) ?? 0) > 0) continue;
        resident.delete(group);
      }
      return 0;
    });
  });
  afterEach(() => {
    useApp.setState({ base: priorBase });
    atlas.isV2AtlasLoaded.mockReset();
    atlas.retainAtlasGroups.mockReset().mockImplementation(() => (): void => {});
    atlas.releaseUnreferencedAtlases.mockReset();
  });

  /** The v2 tier the patrol layer was told to draw this troop at, or null. */
  const grantedTier = (scene: { patrol: { sync: ReturnType<typeof vi.fn> } }): number | null => {
    const calls = scene.patrol.sync.mock.calls;
    const v2TierOf = calls[calls.length - 1]![5] as (t: string, l?: number) => number | null;
    return v2TierOf('gloamfang', 20);
  };

  it('keeps a granted walker on the same art across renders, sweep after sweep', () => {
    const scene = patrolHarness(protoRef);
    useApp.setState({ base: garrisonBase() });

    protoRef.renderFromStore.call(scene);
    expect(grantedTier(scene), 'both groups resident ⇒ full v2 art').toBe(4);
    expect(holds.get(COMBAT), 'the grant holds the sheet nothing draws').toBe(1);

    // THE REGRESSION. renderFromStore sweeps unreferenced textures a few lines
    // after it resolves the grant. Before the hold, that sweep took the combat
    // sheet on the very pass that granted it, so the NEXT render resolved null,
    // the patrol signature flipped and every walker on the base was destroyed
    // and respawned on the eager still — measured at 69 flips in 40s on a
    // played base, i.e. the owner's "swapping between two pictures". The art a
    // walker shows must not be a function of transient atlas residency.
    for (let render = 0; render < 5; render++) {
      protoRef.renderFromStore.call(scene);
      expect(resident.has(COMBAT), `combat sheet survives sweep ${render}`).toBe(true);
      expect(grantedTier(scene), `tier stable across render ${render}`).toBe(4);
    }
    // One hold at a time: each render re-takes it and drops the previous one,
    // so a base left open for an hour is not leaking holders.
    expect(holds.get(COMBAT)).toBe(1);
    expect(holds.get(LOCOMOTION)).toBe(1);
  });

  it('hands the art back when the patrol is torn down, so a raid can reclaim it', () => {
    const scene = patrolHarness(protoRef);
    useApp.setState({ base: garrisonBase() });
    protoRef.renderFromStore.call(scene);
    expect(holds.get(LOCOMOTION)).toBe(1);

    // battle:enter destroys the walkers and drops the hold before sweeping;
    // a hold that outlived its walkers would pin the whole garrison's sheets
    // for the entire raid — the leak this mechanism exists to bound.
    (scene.releasePatrolArtLease as () => void).call(scene);
    atlas.releaseUnreferencedAtlases();
    expect(holds.has(LOCOMOTION)).toBe(false);
    expect(resident.has(COMBAT)).toBe(false);
  });

  it('never holds art for a troop it did not grant', () => {
    const scene = patrolHarness(protoRef);
    useApp.setState({ base: garrisonBase() });
    resident.delete(COMBAT); // still downloading — the grant fails closed

    protoRef.renderFromStore.call(scene);
    expect(grantedTier(scene), 'incomplete grant ⇒ eager fallback still').toBeNull();
    expect(holds.size, 'nothing granted, nothing held').toBe(0);
  });
});

/**
 * THE SEAT, against the REAL shipped manifest rather than a fixture.
 *
 * A building stands on the SOUTH EDGE of its footprint: the yellow selection
 * box the player sees is `[tx,ty] → [tx+fw, ty+fh]`, and the art's bottom edge
 * belongs on the bottom of that box. Every family had drifted off it in a
 * different direction, because the seat was composed from `footprintFrac` — 0.5
 * whenever a pack published a pixel anchor. Measured in world px against the
 * box, before this rule: the L15 Keep floated 49 above its south edge while
 * overhanging the box top by 62, the Mortar floated 66, the Air Defence 56, the
 * Cannon 21, the Hero Altar 22 — which is exactly the owner's 2026-08-30 report
 * ("this defences and building need to fit into its tiles… not even making it
 * smaller is needed", "cannon art still too big and does not fit into the box",
 * "vex altar also big"). The art was never oversized: the L15 Keep's ink is
 * 134×141 against a 128×128 box. It was seated a row too high.
 *
 * Fixture-only coverage is what let that ship: every seat test in this file
 * hand-wrote a cell and an anchor, so all of them agreed with a formula none of
 * them measured against the pack. This case therefore spans BOTH packs (WARE
 * and rework-v2), the legacy sprites, both art paths (rich @1x clip and eager
 * @2x alias) and all three footprint shapes — 1×1, 2×1, 2×2 — and reads every
 * cell, anchor and fit out of the built meta.json.
 */
describe('building seat against the shipped manifest', () => {
  const atlasDir = new URL('../../../public/atlas/', import.meta.url);
  const metaUrl = new URL('meta.json', atlasDir);
  if (!existsSync(metaUrl)) {
    throw new Error(
      'apps/web/public/atlas/meta.json is not built — run `pnpm assets` first. ' +
      'The seat is derived from the pack cells and anchors in that file, so ' +
      'this case refuses to pass without it (deliberately loud, not skipped).',
    );
  }
  type Clip = { cellW: number; cellH: number; anchorPx?: [number, number]; unit?: string };
  const meta = JSON.parse(readFileSync(metaUrl, 'utf8')) as {
    sprites: Record<string, { anchor: [number, number] }>;
    wareClips: Record<string, Clip>;
    v2Clips: Record<string, Clip>;
  };
  /** Native frame height of an EAGER alias — the packed @2x cell. */
  const eagerFrames = JSON.parse(readFileSync(new URL('bld@2x.json', atlasDir), 'utf8')) as {
    textures: Array<{ frames: Array<{ filename: string; frame: { h: number } }> }>;
  };
  const eagerHeight = (key: string): number => {
    const frame = eagerFrames.textures[0]!.frames.find((f) => f.filename === key);
    if (!frame) throw new Error(`no eager @2x frame for ${key}`);
    return frame.frame.h;
  };

  const wallFrames = JSON.parse(readFileSync(new URL('wall5@1x.json', atlasDir), 'utf8')) as {
    textures: Array<{ frames: Array<{ filename: string; frame: { h: number } }> }>;
  };
  const wallHeight = (tier: number): number => {
    const key = `wall5_t${tier}_straight_intact_f1`;
    const frame = wallFrames.textures[0]!.frames.find(frame => frame.filename === key);
    if (!frame) throw new Error(`no accepted @1x wall frame for ${key}`);
    return frame.frame.h;
  };
  const T = 64;
  // label, frame the scene draws, footprint, native frame height.
  const cases: Array<[string, string, { fw: number; fh: number }, number]> = [
    ['WARE Keep L15, rich 2×2', 'ware_bld_keep_l15_idle_f1', { fw: 2, fh: 2 },
      meta.wareClips['ware_bld_keep_l15_idle']!.cellH],
    ['WARE Keep L15, eager 2×2', 'bld_keep_l15', { fw: 2, fh: 2 }, eagerHeight('bld_keep_l15')],
    ['WARE Barracks T1, 2×1', 'ware_bld_barracks_t1_idle_f1', { fw: 2, fh: 1 },
      meta.wareClips['ware_bld_barracks_t1_idle']!.cellH],
    ['WARE Vault T1, 1×1', 'ware_bld_vault_t1_idle_f1', { fw: 1, fh: 1 },
      meta.wareClips['ware_bld_vault_t1_idle']!.cellH],
    ['WARE Air Defence T1, 2×2', 'ware_bld_airdefence_t1_idle_d0_f1', { fw: 2, fh: 2 },
      meta.wareClips['ware_bld_airdefence_t1_idle']!.cellH],
    ['v2 Cannon T1, 1×1', 'v2_bld_cannon_t1_idle_d0_f1', { fw: 1, fh: 1 },
      meta.v2Clips['v2_bld_cannon_t1_idle']!.cellH],
    ['v2 Mortar T1, 2×2', 'v2_bld_mortar_t1_idle_d0_f1', { fw: 2, fh: 2 },
      meta.v2Clips['v2_bld_mortar_t1_idle']!.cellH],
    ['legacy Hero Altar, 2×2', 'bld_heroaltar', { fw: 2, fh: 2 }, eagerHeight('bld_heroaltar')],
    ['Timber Wall T1, @1x 1×1', 'wall5_t1_straight_intact_f1', { fw: 1, fh: 1 }, wallHeight(1)],
    ['Shard Wall T5, @1x 1×1', 'wall5_t5_straight_intact_f1', { fw: 1, fh: 1 }, wallHeight(5)],
    ['Mixed wall context, @1x 1×1', 'wallctx_fixture', { fw: 1, fh: 1 }, 60],
  ];

  it.each(cases)('%s stands on its south edge', async (_label, frame, fp, nativeHeight) => {
    const proto = await scenePrototype();
    const scene = {
      v2meta: { clips: meta.v2Clips },
      waremeta: { clips: meta.wareClips },
      meta: meta.sprites,
      buildingSeat: proto.buildingSeat,
      refreshFootprintHitArea: vi.fn(),
      berthBuildings: new Map(),
    };
    const seat = proto.buildingSeat.call(scene, frame);
    const displayHeight = nativeHeight * seat.scale;
    const sprite = {
      frame: { name: frame },
      displayHeight,
      setOrigin: vi.fn().mockReturnThis(),
      setScale: vi.fn().mockReturnThis(),
      setX: vi.fn().mockReturnThis(),
      setY: vi.fn().mockReturnThis(),
      setDepth: vi.fn().mockReturnThis(),
      setData: vi.fn().mockReturnThis(),
      getData: vi.fn((key: string) => key === 'structureKind' && (frame.startsWith('wall5_') || frame.startsWith('wallctx_'))
        ? 'wall' : undefined),
    };
    const [tx, ty] = [4, 6];

    proto.positionBuilding.call(scene, sprite, tx, ty, fp);

    const y = sprite.setY.mock.calls[0]![0] as number;
    const southEdge = (ty + fp.fh) * T;
    // THE INVARIANT: bottom edge of the drawn art on the south edge of the box.
    expect(y + (1 - seat.origin[1]) * displayHeight, 'drawn bottom vs south edge')
      .toBeCloseTo(southEdge, 6);
    // Never vacuous, two ways. The art really does rise ABOVE the box's top —
    // so "on the south edge" is a seat, not a coincidence of a short sprite…
    expect(y - seat.origin[1] * displayHeight).toBeLessThan(ty * T);
    // …and the depth key is the south edge unscaled, lifted into the building
    // BAND (WORLD_DEPTH). Two halves, both load-bearing: the unscaled south
    // edge is what stops a tall building sorting in front of the wall line it
    // stands behind, and the band is what stops it sorting in front of the
    // troops (owner 2026-08-30: "defences and building should not be rendered
    // top of troops"). A bare `southEdge` here would be the old one-axis rule.
    const kind = (frame.startsWith('wall5_') || frame.startsWith('wallctx_')) ? 'wall' : 'building';
    expect(sprite.setDepth).toHaveBeenCalledWith(structureDepth(kind, southEdge));
    expect(structureDepth(kind, southEdge)).toBeLessThan(WORLD_DEPTH.actor);
  });

  /**
   * The half of the pack contract the seat no longer reads. The pixel anchor is
   * the SPRITE ORIGIN — `emitterWorld` measures every muzzle as (emitter −
   * anchor) — and it sits above the cell's bottom, so seating it directly on the
   * south edge would bury the building and seating it on the footprint's middle
   * row (what shipped) floats it. Both mistakes look like a size bug in game.
   */
  it('keeps the published pixel anchor as the origin, off the cell bottom', async () => {
    const proto = await scenePrototype();
    const scene = {
      v2meta: { clips: meta.v2Clips },
      waremeta: { clips: meta.wareClips },
      meta: meta.sprites,
      buildingSeat: proto.buildingSeat,
    };
    for (const [frame, clip] of [
      ['ware_bld_keep_l15_idle_f1', meta.wareClips['ware_bld_keep_l15_idle']!],
      ['v2_bld_cannon_t1_idle_d0_f1', meta.v2Clips['v2_bld_cannon_t1_idle']!],
    ] as const) {
      const seat = proto.buildingSeat.call(scene, frame);
      expect(seat.origin[1], `${frame} origin`).toBeCloseTo(clip.anchorPx![1] / clip.cellH, 6);
      expect(seat.origin[1], `${frame} anchor is not the cell bottom`).toBeLessThan(1);
    }
  });
});


describe('BaseScene five-tier wall integration', () => {
  it('maps every authoritative level and L16→17 through the wall-only progression', async () => {
    const proto = await scenePrototype();
    const scene = { wallFrames: new Map() };
    for (let level = 1; level <= 20; level++) {
      expect(proto.spriteKeyFor.call(scene, { id: 'wall', type: 'wall', level }))
        .toBe(`wall5_t${Math.ceil(level / 4)}_post_intact_f1`);
    }
    expect(proto.ghostSpriteKey('wall')).toBe('wall5_t1_post_intact_f1');
    expect(proto.spriteKeyFor.call(scene, { id: 'keep', type: 'keep', level: 17 }))
      .toBe('bld_keep_l17');
  });

  it('uses draft and settling coordinates without changing server rows or trayed walls', async () => {
    const proto = await scenePrototype();
    const prior = useApp.getState().base;
    const buildings = [
      { id: 'wood', type: 'wall', level: 1, tx: 1, ty: 1 },
      { id: 'crown', type: 'wall', level: 17, tx: 8, ty: 8 },
      { id: 'tray', type: 'wall', level: 5, tx: 9, ty: 9 },
    ];
    useApp.setState({ base: { ...storeBase(null), buildings } as unknown as BaseStateDto });
    const sprites = buildings.map(() => ({}));
    const scene = {
      wallArt: { sync: vi.fn() }, carriedPieces: () => [],
      buildingSprites: new Map(buildings.map((building, i) => [building.id, sprites[i]])),
      layoutDraft: { positions: new Map([['wood', { tx: 4, ty: 4 }], ['crown', { tx: 5, ty: 4 }]]), trayIds: new Set(['tray']) },
      settlingMoves: new Map([['crown', { tx: 5, ty: 4 }]]), ghost: null,
    };
    try {
      proto.syncWallArt.call(scene);
      expect(scene.wallArt.sync).toHaveBeenCalledWith([
        { id: 'wood', tx: 4, ty: 4, level: 1, sprite: sprites[0] },
        { id: 'crown', tx: 5, ty: 4, level: 17, sprite: sprites[1] },
      ]);
      expect(buildings[0]).toMatchObject({ tx: 1, ty: 1, level: 1 });
    } finally { useApp.setState({ base: prior }); }
  });

  it('includes the lifted wall and valid placement ghost in their current mating context', async () => {
    const proto = await scenePrototype();
    const prior = useApp.getState().base;
    useApp.setState({ base: { ...storeBase(null), buildings: [
      { id: 'wall', type: 'wall', level: 16, tx: 1, ty: 1 },
    ] } as unknown as BaseStateDto });
    const sprite = { x: 4.5 * 64, y: 5 * 64 - 16 };
    const ghostSprite = {};
    const scene = {
      wallArt: { sync: vi.fn() }, carriedPieces: () => [{ id: 'wall', sprite }],
      buildingSprites: new Map([['wall', sprite]]), layoutDraft: null, settlingMoves: new Map(),
      ghost: { type: 'wall', valid: true, tx: 5, ty: 4, sprite: ghostSprite },
    };
    try {
      proto.syncWallArt.call(scene);
      expect(scene.wallArt.sync).toHaveBeenCalledWith([
        { id: 'wall', tx: 4, ty: 4, level: 16, sprite },
        { id: '__wall_ghost__', tx: 5, ty: 4, level: 1, sprite: ghostSprite },
      ]);
      sprite.x = 3.5 * 64; // Outside the actual claim, without mocking placement validation.
      proto.syncWallArt.call(scene);
      expect(scene.wallArt.sync).toHaveBeenLastCalledWith([
        { id: 'wall', tx: 3, ty: 4, level: 16, sprite, detached: true },
        { id: '__wall_ghost__', tx: 5, ty: 4, level: 1, sprite: ghostSprite },
      ]);
    } finally { useApp.setState({ base: prior }); }
  });

  it('uses real draft and settling occupancy for an invalid mixed-tier carry, excluding tray occupants', async () => {
    const proto = await scenePrototype();
    const prior = useApp.getState().base;
    const buildings = [
      { id: 'wood', type: 'wall', level: 1, tx: 4, ty: 4 },
      { id: 'crown', type: 'wall', level: 17, tx: 15, ty: 15 },
    ];
    useApp.setState({ base: { ...storeBase(null), buildings } as unknown as BaseStateDto });
    const wood = { x: 12.5 * 64, y: 13 * 64 - 16 }, crown = {};
    const draft = { positions: new Map([['wood', { tx: 4, ty: 4 }], ['crown', { tx: 12, ty: 12 }]]), trayIds: new Set<string>() };
    const scene = {
      wallArt: { sync: vi.fn() }, carriedPieces: () => [{ id: 'wood', sprite: wood }],
      buildingSprites: new Map<string, unknown>([['wood', wood], ['crown', crown]]),
      layoutDraft: draft as typeof draft | null,
      settlingMoves: new Map<string, { tx: number; ty: number }>(), ghost: null,
    };
    const assertCarried = (detached: boolean) => {
      proto.syncWallArt.call(scene);
      const inputs = scene.wallArt.sync.mock.calls.at(-1)![0] as Array<{ id: string; tx: number; ty: number; detached?: boolean }>;
      expect(inputs.find(input => input.id === 'wood')).toEqual({
        id: 'wood', tx: 12, ty: 12, level: 1, sprite: wood, ...(detached ? { detached: true } : {}),
      });
      return inputs;
    };
    try {
      expect(assertCarried(true).find(input => input.id === 'crown')).toMatchObject({ tx: 12, ty: 12 });
      draft.trayIds.add('crown');
      expect(assertCarried(false).some(input => input.id === 'crown')).toBe(false);
      draft.trayIds.clear(); draft.positions.delete('crown');
      expect(assertCarried(false).some(input => input.id === 'crown')).toBe(false);
      scene.layoutDraft = null;
      scene.settlingMoves.set('crown', { tx: 12, ty: 12 });
      expect(assertCarried(true).find(input => input.id === 'crown')).toMatchObject({ tx: 12, ty: 12 });
      scene.settlingMoves.clear();
      expect(assertCarried(false).find(input => input.id === 'crown')).toMatchObject({ tx: 15, ty: 15 });
      expect(buildings[1]).toMatchObject({ tx: 15, ty: 15, level: 17 });
    } finally { useApp.setState({ base: prior }); }
  });

});

describe('BaseScene Phase E Market art (C3)', () => {
  const evidence = (name: string): unknown => JSON.parse(readFileSync(
    new URL(`../../../../../docs/evidence/2026-09-30-bound-cosmetic-visuals/${name}`, import.meta.url), 'utf8',
  ));
  const marketArt = parseMarketArtMetadata(evidence('pe_market.manifest.json'), evidence('pe_cosmetics.manifest.json'));
  const presentation = evidence('actual-presentation.fixture.json') as {
    currentBase: {
      boundCosmetics: { state: 'available'; visual: { version: 1; marketAwnings: Array<{ buildingId: string; appearance: Record<string, unknown> }> } };
      buildings: Array<{ id: string; type: string; level: number; tx: number; ty: number; underConstruction: boolean }>;
    };
  };
  const MARKET = presentation.currentBase.buildings.find((b) => b.type === 'market')!;
  const awningOn = presentation.currentBase.boundCosmetics;
  const awningOff = { state: 'available', visual: { version: 1, marketAwnings: [] } } as const;
  const unavailable = { state: 'unavailable', visual: null } as const;

  function marketBase(boundCosmetics: unknown, overrides: Partial<{ level: number; underConstruction: boolean; jobs: unknown[] }> = {}): BaseStateDto {
    return {
      ...garrisonBase(),
      army: [],
      buildings: [{ ...MARKET, level: overrides.level ?? MARKET.level, underConstruction: overrides.underConstruction ?? false }],
      jobs: overrides.jobs ?? [],
      boundCosmetics,
    } as unknown as BaseStateDto;
  }

  /** The patrol harness plus the REAL Market seams: key, footprint, seat, sync. */
  function marketHarness(proto: ScenePrototype, resident: Set<string>) {
    const sprites: Array<Record<string, unknown> & { created: unknown[] }> = [];
    const scene = Object.assign(patrolHarness(proto), {
      marketArt, meta: {},
      spriteKeyFor: proto.spriteKeyFor,
      footprintOf: proto.footprintOf,
      buildingSeat: proto.buildingSeat,
      marketChoiceFor: (proto as unknown as { marketChoiceFor: unknown }).marketChoiceFor,
      syncMarketController: (proto as unknown as { syncMarketController: unknown }).syncMarketController,
      destroyMarketController: (proto as unknown as { destroyMarketController: unknown }).destroyMarketController,
      wareTicker: { play: vi.fn(), unregister: vi.fn() },
      ticker: { unregister: vi.fn() },
      add: { sprite: vi.fn((...created: unknown[]) => {
        const sprite = Object.assign(stubSprite(), { created, active: true, setVisible: vi.fn(), setTexture: vi.fn() });
        sprite['frame'] = { name: typeof created[3] === 'string' ? created[3] : '__BASE' };
        sprite['setVisible'] = vi.fn().mockReturnValue(sprite);
        sprite['setTexture'] = vi.fn().mockReturnValue(sprite);
        sprites.push(sprite as never);
        return sprite;
      }) },
    });
    atlas.isV2AtlasLoaded.mockImplementation((_scene: unknown, group: string) => resident.has(group));
    return { scene, sprites };
  }

  let priorBase: BaseStateDto | null = null;
  beforeEach(() => { priorBase = useApp.getState().base; });
  afterEach(() => { useApp.setState({ base: priorBase }); atlas.isV2AtlasLoaded.mockReset(); atlas.admitOnDemandAtlasCandidates.mockReset(); atlas.admitOnDemandAtlasCandidates.mockImplementation(() => new Set()); });

  it('keys a Market by its ordinary tier cell, keeps the shared 2×2 footprint and the full-cell seat at world scale 1', async () => {
    const proto = await scenePrototype();
    const { scene } = marketHarness(proto, new Set());
    expect(proto.spriteKeyFor.call(scene, { ...MARKET, level: 1 })).toBe('pe_market_t1_idle_f1');
    expect(proto.spriteKeyFor.call(scene, { ...MARKET, level: 6 })).toBe('pe_market_t2_idle_f1');
    expect(proto.spriteKeyFor.call(scene, { ...MARKET, level: 20 })).toBe('pe_market_t4_idle_f1');
    expect(proto.footprintOf.call(scene, 'pe_market_t1_idle_f1')).toEqual({ fw: 2, fh: 2 });
    expect(proto.footprintOf.call(scene, 'pe_cos_market_t4_collapse_f9')).toEqual({ fw: 2, fh: 2 });
    expect(proto.buildingSeat.call(scene, 'pe_cos_market_t1_idle_f1')).toEqual({ origin: [0.5, 1], scale: 1, offsetGamePx: [0, 0] });
    // A legacy sidecar (empty table) keeps the historical key.
    expect(proto.spriteKeyFor.call({ ...scene, marketArt: parseMarketArtMetadata(undefined, undefined) }, MARKET)).toBe('bld_market_l1');
  });

  it('hides a Market until its family is resident, requests the ordinary group as REQUIRED art ahead of optional WARE enhancement, and seats it as 2×2', async () => {
    const proto = await scenePrototype();
    const { scene, sprites } = marketHarness(proto, new Set());
    // A WARE Mine competes as optional enhancement art; a Market with a frozen
    // Awning also wants the optional cosmetics group.
    scene.wareGroupForBuilding.mockImplementation((b) => ((b as { type?: string } | undefined)?.type === 'mine' ? 'ware_mine_1' : null));
    const base = marketBase(awningOn);
    base.buildings.push({ id: 'mine-1', type: 'mine', level: 1, tx: 2, ty: 2, underConstruction: false } as never);
    useApp.setState({ base });
    proto.renderFromStore.call(scene);
    const marketSprite = sprites.find((s) => Array.isArray(s['created']) && (s['created'] as unknown[])[2] === 'pe_market_t1')!;
    expect(scene.add.sprite).toHaveBeenCalledWith(0, 0, 'pe_market_t1');
    expect(marketSprite['setVisible']).toHaveBeenLastCalledWith(false);
    expect(marketSprite['setTexture'], 'no missing-frame request while the group is absent').not.toHaveBeenCalled();
    expect(scene.marketBuildings.size).toBe(0);
    expect(scene.positionBuilding).toHaveBeenCalledWith(marketSprite, MARKET.tx, MARKET.ty, { fw: 2, fh: 2 });
    const admitted = (atlas.admitOnDemandAtlasCandidates.mock.calls.at(-1)![2] as readonly Candidate[]).map((c) => c.id);
    // The body group is required residency (functional class, after builder/patrol/nest,
    // before every optional group); the Awning group is optional enhancement.
    expect(admitted.indexOf('market:pe_market_t1')).toBeGreaterThanOrEqual(0);
    expect(admitted.indexOf('market:pe_market_t1')).toBeLessThan(admitted.indexOf('ware:ware_mine_1'));
    expect(admitted.indexOf('market:pe_market_t1')).toBeLessThan(admitted.indexOf('market:pe_cosmetics'));
    // An unadmitted body group triggers the same reclaim-and-retry pass the
    // patrol uses: optional displayed art is released before a second admission.
    expect(scene.releaseDisplayedWareArt).toHaveBeenCalled();
    expect(atlas.admitOnDemandAtlasCandidates).toHaveBeenCalledTimes(2);
    expect(scene.loadV2Candidates.mock.calls.at(-1)![0]).toEqual([]);
    // Without an Awning there is no cosmetics request at all.
    atlas.admitOnDemandAtlasCandidates.mockClear();
    useApp.setState({ base: marketBase(undefined) });
    proto.renderFromStore.call(scene);
    const plain = (atlas.admitOnDemandAtlasCandidates.mock.calls.at(-1)![2] as readonly Candidate[]).map((c) => c.id);
    expect(plain).toContain('market:pe_market_t1');
    expect(plain).not.toContain('market:pe_cosmetics');
  });

  it('grants the controller once the ordinary group is resident and never re-keys its sprite on later refreshes', async () => {
    const proto = await scenePrototype();
    const { scene, sprites } = marketHarness(proto, new Set(['pe_market_t1']));
    useApp.setState({ base: marketBase(awningOff) });
    proto.renderFromStore.call(scene);
    expect(scene.add.sprite).toHaveBeenCalledExactlyOnceWith(0, 0, 'pe_market_t1', 'pe_market_t1_idle_f1');
    expect(scene.marketBuildings.size).toBe(1);
    expect(scene.wareTicker.play).toHaveBeenCalledExactlyOnceWith(sprites[0], expect.objectContaining({ base: 'pe_market_t1_idle', atlas: 'pe_market_t1' }));
    expect(sprites[0]!['setVisible']).toHaveBeenLastCalledWith(true);
    const controller = scene.marketBuildings.get(MARKET.id);
    sprites[0]!['frame'] = { name: 'pe_market_t1_idle_f1' };
    proto.renderFromStore.call(scene);
    proto.renderFromStore.call(scene);
    expect(scene.marketBuildings.get(MARKET.id)).toBe(controller);
    expect(scene.wareTicker.play).toHaveBeenCalledOnce();
    expect(sprites[0]!['setTexture'], 'the controller owns the texture').not.toHaveBeenCalled();
  });

  it('applies the fixture Awning only while pe_cosmetics is resident, falls back to ordinary art meanwhile, and rebuilds on off/unavailable', async () => {
    const proto = await scenePrototype();
    const resident = new Set(['pe_market_t1']);
    const { scene, sprites } = marketHarness(proto, resident);
    useApp.setState({ base: marketBase(awningOn) });
    proto.renderFromStore.call(scene);
    const admitted = atlas.admitOnDemandAtlasCandidates.mock.calls.at(-1)![2] as readonly Candidate[];
    expect(admitted).toContainEqual({ id: 'market:pe_market_t1', groups: ['pe_market_t1'] });
    expect(admitted).toContainEqual({ id: 'market:pe_cosmetics', groups: ['pe_cosmetics'] });
    expect(scene.wareTicker.play).toHaveBeenLastCalledWith(sprites[0], expect.objectContaining({ base: 'pe_market_t1_idle' }));
    const ordinary = scene.marketBuildings.get(MARKET.id)!;
    const ordinaryDestroy = vi.spyOn(ordinary, 'destroy');
    // The cosmetics group lands: the family signature changes, the controller is rebuilt on the Awning.
    resident.add('pe_cosmetics');
    sprites[0]!['frame'] = { name: 'pe_market_t1_idle_f1' };
    proto.renderFromStore.call(scene);
    expect(ordinaryDestroy).toHaveBeenCalledOnce();
    expect(scene.wareTicker.play).toHaveBeenLastCalledWith(sprites[0], expect.objectContaining({ base: 'pe_cos_market_t1_idle', atlas: 'pe_cosmetics' }));
    expect(scene.marketBuildings.get(MARKET.id)).not.toBe(ordinary);
    // The player turns the Awning off: ordinary art again, one rebuild.
    const awning = scene.marketBuildings.get(MARKET.id)!;
    useApp.setState({ base: marketBase(awningOff) });
    proto.renderFromStore.call(scene);
    expect(scene.marketBuildings.get(MARKET.id)).not.toBe(awning);
    expect(scene.wareTicker.play).toHaveBeenLastCalledWith(sprites[0], expect.objectContaining({ base: 'pe_market_t1_idle' }));
    // An unavailable read draws ordinary art too, without claiming it is off.
    const off = scene.marketBuildings.get(MARKET.id)!;
    useApp.setState({ base: marketBase(unavailable) });
    proto.renderFromStore.call(scene);
    expect(scene.marketBuildings.get(MARKET.id), 'same family ⇒ no rebuild').toBe(off);
    expect(selectMarketAwnings(marketArt, unavailable, [MARKET])).toEqual({ awnings: new Map(), unavailable: true });
  });

  it('refuses an unowned next-tier Awning and a queued upgrade never selects next-tier art', async () => {
    const proto = await scenePrototype();
    const { scene, sprites } = marketHarness(proto, new Set(['pe_market_t1', 'pe_cosmetics', 'pe_market_t2']));
    const nextTier = JSON.parse(JSON.stringify(awningOn)) as typeof awningOn;
    nextTier.visual.marketAwnings[0]!.appearance['outputId'] = 'artisan_market_awning_t2';
    useApp.setState({ base: marketBase(nextTier, { jobs: [{ id: 'job', buildingId: MARKET.id, kind: 'upgrade' }] }) });
    proto.renderFromStore.call(scene);
    expect(scene.marketBuildings.size).toBe(1);
    // Ordinary tier-1 family, showing the tier-1 construction scaffold for the current upgrade.
    expect(scene.wareTicker.play).toHaveBeenLastCalledWith(sprites[0], expect.objectContaining({ base: 'pe_market_t1_construction', loop: false }));
    expect(scene.wareTicker.play).not.toHaveBeenCalledWith(sprites[0], expect.objectContaining({ base: expect.stringContaining('t2') }));
    // Initial construction shows the same scaffold; completion returns to idle.
    useApp.setState({ base: marketBase(awningOff, { underConstruction: true }) });
    proto.renderFromStore.call(scene);
    expect(scene.wareTicker.play).toHaveBeenLastCalledWith(sprites[0], expect.objectContaining({ base: 'pe_market_t1_construction' }));
    useApp.setState({ base: marketBase(awningOff) });
    proto.renderFromStore.call(scene);
    expect(scene.wareTicker.play).toHaveBeenLastCalledWith(sprites[0], expect.objectContaining({ base: 'pe_market_t1_idle' }));
  });

  it('keeps a pending (hidden) Market tappable through the footprint fallback', async () => {
    const proto = await scenePrototype();
    const { scene, sprites } = marketHarness(proto, new Set());
    useApp.setState({ base: marketBase(awningOff) });
    proto.renderFromStore.call(scene);
    const sprite = sprites[0]!;
    expect(sprite['setVisible']).toHaveBeenLastCalledWith(false);
    const pendingArtIds = (scene as unknown as { pendingArtIds: Set<string> }).pendingArtIds;
    expect(pendingArtIds.has(MARKET.id)).toBe(true);
    // The footprint fallback sees a hidden-but-pending Market, never a merely
    // hidden sprite, and never a trayed one; the hidden sprite's data is not consulted.
    const data = { tx: MARKET.tx, ty: MARKET.ty, fw: 2, fh: 2 };
    const probe = (visible: boolean, pending: boolean, trayed = false) => {
      const s = { visible, depth: 1, getData: vi.fn((k: string) => (data as Record<string, number>)[k]) };
      const found = (proto as unknown as { footprintObjectAt: (x: number, y: number) => unknown }).footprintObjectAt
        .call({
          buildingSprites: new Map([[MARKET.id, s]]),
          pendingArtIds: new Set(pending ? [MARKET.id] : []),
          layoutDraft: trayed ? { trayIds: new Set([MARKET.id]) } : null,
        }, (MARKET.tx + 1) * 64, (MARKET.ty + 1) * 64);
      return { found: found === s, consulted: s.getData.mock.calls.length > 0 };
    };
    expect(probe(false, true)).toEqual({ found: true, consulted: true });
    expect(probe(false, false)).toEqual({ found: false, consulted: false });
    expect(probe(false, true, true)).toEqual({ found: false, consulted: false });
    expect(probe(true, false).found).toBe(true);
    // Once resident the pending mark clears with the visibility.
    atlas.isV2AtlasLoaded.mockImplementation((_scene: unknown, group: string) => group === 'pe_market_t1');
    proto.renderFromStore.call(scene);
    expect(sprite['setVisible']).toHaveBeenLastCalledWith(true);
    expect(pendingArtIds.has(MARKET.id)).toBe(false);
  });

  it('destroys the controller with its sprite when the Market row vanishes', async () => {
    const proto = await scenePrototype();
    const { scene } = marketHarness(proto, new Set(['pe_market_t1']));
    useApp.setState({ base: marketBase(awningOff) });
    proto.renderFromStore.call(scene);
    const controller = scene.marketBuildings.get(MARKET.id)!;
    const destroy = vi.spyOn(controller, 'destroy');
    useApp.setState({ base: { ...marketBase(awningOff), buildings: [] } as BaseStateDto });
    proto.renderFromStore.call(scene);
    expect(destroy).toHaveBeenCalledOnce();
    expect(scene.marketBuildings.size).toBe(0);
    expect(scene.wareTicker.unregister).toHaveBeenCalled();
  });

  it('forwards the frozen Awning projection from battle:enter into the battle scene', () => {
    const source = readFileSync(new URL('./BaseScene.ts', import.meta.url), 'utf8');
    const enter = source.indexOf("bus.on('battle:enter'");
    const run = source.indexOf("this.scene.run('battle'", enter);
    const runEnd = source.indexOf('});', run);
    expect(source.slice(enter, run)).toContain('boundCosmeticVisual');
    expect(source.slice(run, runEnd)).toContain('boundCosmeticVisual');
  });
});

describe('BaseScene Phase E berths (P4 starter, P6a advanced, C5 journeys)', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../../testFixtures/pe_fleet_starter.manifest.json', import.meta.url), 'utf8')) as Record<string, unknown> & { clips: unknown; tracks: unknown };
  const { clips: fleetClips, tracks: fleetTracks, ...fleetIdentity } = manifest;
  const starterFleetArt = parseStarterFleetMetadata(fleetIdentity, fleetClips, fleetTracks);
  const advancedFleetArt = parseAdvancedFleetMetadata(JSON.parse(readFileSync(new URL('../../../testFixtures/pe_advanced_fleet.manifest.json', import.meta.url), 'utf8')));
  const BERTH = { id: 'berth-1', type: 'berth', level: 1, tx: 10, ty: 8, underConstruction: false };
  const SCAFFOLD = { id: 'berth-0', type: 'berth', level: 0, tx: 14, ty: 8, underConstruction: true };
  const EMPTY = { id: 'berth-2', type: 'berth', level: 1, tx: 18, ty: 8, underConstruction: false };
  const BALLOON = { family: 'survey_balloon', tier: 1, presence: 'occupied' };
  /** The real current closure shape (D242): every berth row, null for the scaffold and the empty berth. */
  const facts = (installation: unknown, extra: Array<{ buildingId: string; installation: unknown }> = [{ buildingId: SCAFFOLD.id, installation: null }, { buildingId: EMPTY.id, installation: null }]) =>
    ({ version: 1, berths: [{ buildingId: BERTH.id, installation }, ...extra] });
  const starterFacts = (presence: 'occupied' | 'away' | null, extra?: Array<{ buildingId: string; installation: unknown }>) => facts(presence ? { family: 'starter', presence } : null, extra);
  const selection = (installation: Record<string, unknown> | null) => ({ berths: new Map(installation ? [[BERTH.id, installation]] : []), unavailable: false });

  function berthBase(servicePresentation: unknown, overrides: Partial<{ underConstruction: boolean; jobs: unknown[]; advancedServicePresentation: unknown; single: boolean }> = {}): BaseStateDto {
    return {
      ...garrisonBase(),
      army: [],
      buildings: overrides.single ? [{ ...BERTH, underConstruction: overrides.underConstruction ?? false }] : [{ ...BERTH, underConstruction: overrides.underConstruction ?? false }, { ...SCAFFOLD }, { ...EMPTY }],
      jobs: overrides.jobs ?? [],
      ...(servicePresentation === undefined ? {} : { servicePresentation }),
      ...(overrides.advancedServicePresentation === undefined ? {} : { advancedServicePresentation: overrides.advancedServicePresentation }),
    } as unknown as BaseStateDto;
  }

  /** The patrol harness plus the REAL berth seams: key, footprint, seat, facts, composition, residency, sync. */
  function berthHarness(proto: ScenePrototype, resident: Set<string>, tables: { starter?: typeof starterFleetArt; advanced?: typeof advancedFleetArt } = {}) {
    const sprites: Array<Record<string, unknown> & { created: unknown[] }> = [];
    const scene = Object.assign(patrolHarness(proto), {
      marketArt: parseMarketArtMetadata(undefined, undefined), starterFleetArt: tables.starter ?? starterFleetArt, advancedFleetArt: tables.advanced ?? advancedFleetArt, meta: {},
      berthFacts: { berths: new Map(), unavailable: false }, pendingArtIds: new Set<string>(),
      // C5 journey seams: the REAL methods against harness-owned state and an active canvas.
      pendingJourneys: new Map(), seenJourneyKeys: new Set<string>(), journeyArtWanted: new Map(),
      onFleetJourney: (proto as unknown as { onFleetJourney: unknown }).onFleetJourney,
      pendingJourneyPlanFor: (proto as unknown as { pendingJourneyPlanFor: unknown }).pendingJourneyPlanFor,
      cancelFleetJourneys: (proto as unknown as { cancelFleetJourneys: unknown }).cancelFleetJourneys,
      restPresenceFor: (proto as unknown as { restPresenceFor: unknown }).restPresenceFor, journeyOutcomes: new Map(),
      scene: { isActive: () => true },
      spriteKeyFor: proto.spriteKeyFor,
      footprintOf: proto.footprintOf,
      buildingSeat: proto.buildingSeat,
      marketChoiceFor: (proto as unknown as { marketChoiceFor: unknown }).marketChoiceFor,
      syncMarketController: (proto as unknown as { syncMarketController: unknown }).syncMarketController,
      destroyMarketController: (proto as unknown as { destroyMarketController: unknown }).destroyMarketController,
      berthRestKeyFor: (proto as unknown as { berthRestKeyFor: unknown }).berthRestKeyFor,
      berthInstallationFor: (proto as unknown as { berthInstallationFor: unknown }).berthInstallationFor,
      berthCompositionFor: (proto as unknown as { berthCompositionFor: unknown }).berthCompositionFor,
      berthArtResident: (proto as unknown as { berthArtResident: unknown }).berthArtResident,
      liftPiece: proto.liftPiece,
      positionLiftedBuilding: vi.fn(),
      syncBerthController: (proto as unknown as { syncBerthController: unknown }).syncBerthController,
      destroyBerthController: (proto as unknown as { destroyBerthController: unknown }).destroyBerthController,
      wareTicker: { play: vi.fn(), unregister: vi.fn() },
      ticker: { unregister: vi.fn() },
      add: { sprite: vi.fn((...created: unknown[]) => {
        const sprite = Object.assign(stubSprite(), { created, active: true, x: 0, y: 0, depth: 0, scaleX: 1, scaleY: 1, visible: true, alpha: 1 });
        sprite['frame'] = { name: typeof created[3] === 'string' ? created[3] : '__BASE' };
        for (const method of ['setOrigin', 'setScale', 'setPosition']) sprite[method] = vi.fn().mockReturnValue(sprite);
        sprite['setTexture'] = vi.fn((_atlas: string, frame?: string) => { sprite['frame'] = { name: frame ?? '__BASE' }; return sprite; });
        sprite['setVisible'] = vi.fn((visible: boolean) => { sprite['visible'] = visible; return sprite; });
        sprite['setDepth'] = vi.fn((depth: number) => { sprite['depth'] = depth; return sprite; });
        sprite['setAlpha'] = vi.fn((alpha: number) => { sprite['alpha'] = alpha; return sprite; });
        sprite['destroy'] = vi.fn();
        sprites.push(sprite as never);
        return sprite;
      }) },
    });
    atlas.isV2AtlasLoaded.mockImplementation((_scene: unknown, group: string) => resident.has(group));
    return { scene, sprites };
  }
  const berthSprite = (sprites: Array<Record<string, unknown> & { created: unknown[] }>, group: string) => sprites.find((s) => s.created[2] === group && s.created.length === 4 || s.created[2] === group)!;

  let priorBase: BaseStateDto | null = null;
  beforeEach(() => { priorBase = useApp.getState().base; });
  afterEach(() => { useApp.setState({ base: priorBase }); atlas.isV2AtlasLoaded.mockReset(); atlas.admitOnDemandAtlasCandidates.mockReset(); atlas.admitOnDemandAtlasCandidates.mockImplementation(() => new Set()); });

  it('keys a presented berth by its family intact cell (resident or not), every unpresented state by the hidden footprint key, keeps the shared 2×2 footprint and seats each fleet frame on its own anchor', async () => {
    const proto = await scenePrototype();
    const { scene } = berthHarness(proto, new Set(['pe_fleet_starter']));
    scene.berthFacts = selection({ family: 'starter', presence: 'occupied' });
    expect(proto.spriteKeyFor.call(scene, BERTH)).toBe('pe_berth_starter_intact_f1');
    // Construction never presents; no facts, a null installation or an unavailable
    // presentation are the hidden footprint — never bld_berth_l1 (D-c).
    expect(proto.spriteKeyFor.call(scene, { ...BERTH, underConstruction: true })).toBe(BERTH_UNPRESENTED_KEY);
    scene.berthFacts = selection(null);
    expect(proto.spriteKeyFor.call(scene, BERTH)).toBe(BERTH_UNPRESENTED_KEY);
    // Not resident yet: the SAME intact key (the sprite stays a hidden frameless footprint until the group lands).
    const { scene: absent } = berthHarness(proto, new Set());
    absent.berthFacts = selection({ family: 'starter', presence: 'away' });
    expect(proto.spriteKeyFor.call(absent, BERTH)).toBe('pe_berth_starter_intact_f1');
    absent.berthFacts = selection(BALLOON);
    expect(proto.spriteKeyFor.call(absent, BERTH)).toBe('pe_berth_survey_balloon_intact_f1');
    absent.berthFacts = selection({ ...BALLOON, family: 'expedition_barge', tier: 4 });
    expect(proto.spriteKeyFor.call(absent, BERTH)).toBe('pe_berth_expedition_barge_intact_f1');
    // A legacy/empty table has no admitted appearance for the named family: hidden footprint, never the ordinary key.
    const { scene: legacy } = berthHarness(proto, new Set(['pe_fleet_starter', 'pe_berth_survey_balloon']), { starter: EMPTY_STARTER_FLEET_ART, advanced: EMPTY_ADVANCED_FLEET_ART });
    legacy.berthFacts = selection({ family: 'starter', presence: 'occupied' });
    expect(proto.spriteKeyFor.call(legacy, BERTH)).toBe(BERTH_UNPRESENTED_KEY);
    legacy.berthFacts = selection(BALLOON);
    expect(proto.spriteKeyFor.call(legacy, BERTH)).toBe(BERTH_UNPRESENTED_KEY);
    for (const key of ['pe_berth_starter_intact_f1', 'pe_veh_starter_docked_f3', 'pe_berth_survey_balloon_intact_f1', 'pe_veh_cargo_cutter_t2_exhausted_f1', BERTH_UNPRESENTED_KEY]) {
      expect(proto.footprintOf.call(scene, key), key).toEqual({ fw: 2, fh: 2 });
    }
    expect(proto.buildingSeat.call(scene, 'pe_berth_starter_ambient_f4')).toEqual({ origin: [0.5, 1], scale: 1, offsetGamePx: [0, 0] });
    expect(proto.buildingSeat.call(scene, 'pe_veh_starter_docked_f1')).toEqual({ origin: [0.5, 105 / 112], scale: 1, offsetGamePx: [0, 0] });
    expect(proto.buildingSeat.call(scene, 'pe_berth_courier_airship_ambient_f2')).toEqual({ origin: [0.5, 1], scale: 1, offsetGamePx: [0, 0] });
    expect(proto.buildingSeat.call(scene, 'pe_veh_survey_balloon_t1_docked_f1')).toEqual({ origin: [0.5, 110 / 112], scale: 1, offsetGamePx: [0, 0] });
  });

  it('requests exactly the groups each presented berth draws from (the berth group, the vehicle tier group only when a vehicle shows) and nothing for unpresented berths, which are hidden frameless footprints — never the whole sheet', async () => {
    const proto = await scenePrototype();
    const { scene, sprites } = berthHarness(proto, new Set());
    scene.wareGroupForBuilding.mockImplementation((b) => ((b as { type?: string } | undefined)?.type === 'mine' ? 'ware_mine_1' : null));
    const base = berthBase(starterFacts(null), { advancedServicePresentation: facts(BALLOON) });
    base.buildings.push({ id: 'mine-1', type: 'mine', level: 1, tx: 2, ty: 2, underConstruction: false } as never);
    useApp.setState({ base });
    proto.renderFromStore.call(scene);
    expect(scene.berthFacts.berths.get(BERTH.id)).toEqual(BALLOON);
    expect(scene.berthFacts.unavailable).toBe(false);
    const admitted = (atlas.admitOnDemandAtlasCandidates.mock.calls.at(-1)![2] as readonly Candidate[]).map((c) => c.id);
    expect(admitted.indexOf('berth:pe_berth_survey_balloon')).toBeGreaterThanOrEqual(0);
    expect(admitted).toContain('berth:pe_veh_survey_balloon_t1');
    expect(admitted.indexOf('berth:pe_berth_survey_balloon')).toBeLessThan(admitted.indexOf('ware:ware_mine_1'));
    expect(admitted).not.toContain('berth:pe_fleet_starter');
    // While the groups are absent the presented berth is a hidden frameless sprite on its berth group; no controller.
    expect(scene.add.sprite).toHaveBeenCalledWith(0, 0, 'pe_berth_survey_balloon');
    expect(berthSprite(sprites, 'pe_berth_survey_balloon')['setVisible']).toHaveBeenLastCalledWith(false);
    expect(scene.berthBuildings.size).toBe(0);
    // The scaffold and the empty berth are hidden footprints on the always-loaded sheet, frameless.
    expect(scene.add.sprite).toHaveBeenCalledWith(0, 0, 'bld');
    expect(scene.add.sprite).not.toHaveBeenCalledWith(0, 0, 'bld', 'bld_berth_l1');
    expect(scene.add.sprite).not.toHaveBeenCalledWith(0, 0, 'bld', 'bld_berth_l0');
    for (const s of sprites.filter((x) => x.created[2] === 'bld' && x.created.length === 3)) expect(s['setVisible']).toHaveBeenLastCalledWith(false);
    expect(sprites.filter((x) => x.created[2] === 'bld' && x.created.length === 3)).toHaveLength(2);
    expect(scene.pendingArtIds.has(SCAFFOLD.id) && scene.pendingArtIds.has(EMPTY.id) && scene.pendingArtIds.has(BERTH.id)).toBe(true);
    // Away loads only the berth group; exhausted loads both.
    for (const [presence, expected] of [['away', ['berth:pe_berth_survey_balloon']], ['exhausted', ['berth:pe_berth_survey_balloon', 'berth:pe_veh_survey_balloon_t1']]] as const) {
      atlas.admitOnDemandAtlasCandidates.mockClear();
      useApp.setState({ base: berthBase(starterFacts(null), { advancedServicePresentation: facts({ ...BALLOON, presence }) }) });
      proto.renderFromStore.call(scene);
      const ids = (atlas.admitOnDemandAtlasCandidates.mock.calls.at(-1)![2] as readonly Candidate[]).map((c) => c.id).filter((id) => id.startsWith('berth:'));
      expect(ids, presence).toEqual(expected);
    }
    for (const [label, starter, advanced, overrides] of [
      ['legacy', undefined, undefined, {}], ['null advanced', starterFacts(null), null, {}], ['null starter', null, facts(BALLOON), {}],
      ['foreign family', starterFacts(null), facts({ ...BALLOON, family: 'zeppelin' }), {}],
      ['no installation anywhere', starterFacts(null), facts(null), {}],
      ['construction', starterFacts(null), facts(BALLOON), { underConstruction: true }],
      ['conflict: both siblings positive on one berth', starterFacts('occupied'), facts(BALLOON), {}],
      ['closure missing a berth', starterFacts(null), facts(BALLOON, []), {}],
    ] as const) {
      atlas.admitOnDemandAtlasCandidates.mockClear();
      useApp.setState({ base: berthBase(starter, { ...overrides, ...(advanced === undefined ? {} : { advancedServicePresentation: advanced }) } as never) });
      proto.renderFromStore.call(scene);
      const ids = (atlas.admitOnDemandAtlasCandidates.mock.calls.at(-1)![2] as readonly Candidate[]).map((c) => c.id);
      expect(ids.some((id) => id.startsWith('berth:')), label).toBe(false);
      expect(scene.berthBuildings.size, label).toBe(0);
      expect(berthSprite(sprites, 'pe_berth_survey_balloon')['visible'], label).toBe(false);
    }
    expect(scene.berthFacts.unavailable, 'a conflict flags the whole presentation').toBe(true);
  });

  it('grants the starter controller once pe_fleet_starter is resident (P4, byte-exact): away rests the ambient loop alone, occupied adds the docked starter as a scene-owned sprite that follows positioning', async () => {
    const proto = await scenePrototype();
    const { scene, sprites } = berthHarness(proto, new Set(['pe_fleet_starter']));
    useApp.setState({ base: berthBase(starterFacts('away', []), { single: true }) });
    proto.renderFromStore.call(scene);
    expect(scene.add.sprite).toHaveBeenCalledExactlyOnceWith(0, 0, 'pe_fleet_starter', 'pe_berth_starter_intact_f1');
    expect(scene.berthBuildings.size).toBe(1);
    expect(scene.wareTicker.play).toHaveBeenCalledExactlyOnceWith(sprites[0], expect.objectContaining({ base: 'pe_berth_starter_ambient', atlas: 'pe_fleet_starter', loop: true }));
    expect(scene.positionBuilding).toHaveBeenCalledWith(sprites[0], BERTH.tx, BERTH.ty, { fw: 2, fh: 2 });
    expect(sprites[0]!['visible']).toBe(true);
    const controller = scene.berthBuildings.get(BERTH.id)!;
    // The server now reports the starter home: the same controller re-rests with a docked sprite.
    scene.wareTicker.play.mockClear();
    useApp.setState({ base: berthBase(starterFacts('occupied', []), { single: true }) });
    proto.renderFromStore.call(scene);
    expect(scene.berthBuildings.get(BERTH.id)).toBe(controller);
    expect(scene.add.sprite).toHaveBeenCalledTimes(2);
    expect(scene.add.sprite).toHaveBeenLastCalledWith(0, 0, 'pe_fleet_starter');
    expect(scene.wareTicker.play.mock.calls.map(([, p]) => (p as { base: string }).base)).toEqual(['pe_berth_starter_ambient', 'pe_veh_starter_docked']);
    const vehicle = sprites[1]!;
    expect(vehicle['setOrigin']).toHaveBeenCalledWith(0.5, 105 / 112);
    // The docked starter sits at the ONE authored dock translation from the berth's seat.
    Object.assign(sprites[0]!, { x: 704, y: 640, depth: 640 });
    controller.layout();
    expect(vehicle['setPosition']).toHaveBeenLastCalledWith(704, 640 - 34);
    expect(vehicle['setDepth']).toHaveBeenLastCalledWith(640.5);
    // Back to away: the starter sprite is destroyed; the berth sprite is never re-keyed by the refresh loop.
    useApp.setState({ base: berthBase(starterFacts('away', []), { single: true }) });
    proto.renderFromStore.call(scene);
    expect(vehicle['destroy']).toHaveBeenCalledOnce();
    expect(sprites[0]!['setTexture']).not.toHaveBeenCalled();
    // A current upgrade keeps the controller and its docked starter (the Market precedent;
    // an occupied berth never shows as an empty berth while a job runs).
    useApp.setState({ base: berthBase(starterFacts('occupied', []), { single: true, jobs: [{ id: 'j1', kind: 'upgrade', buildingId: BERTH.id }] }) });
    proto.renderFromStore.call(scene);
    expect(scene.berthBuildings.get(BERTH.id)).toBe(controller);
    expect(sprites[2]!['destroy']).not.toHaveBeenCalled();
    // A layout draft that trays the berth hides its docked starter with it (layout mirrors visibility).
    const trayed = Object.assign(scene, {
      layoutDraft: { positions: new Map(), trayIds: new Set([BERTH.id]), selectedBuildingId: null, wallPaintLevel: null },
      wallFrames: new Map<string, string>(), wareWalls: new Map(), occ: { rebuild: vi.fn() },
      ambience: { hide: vi.fn(), sync: vi.fn() }, heroRecovery: { hide: vi.fn(), destroy: vi.fn() }, armyStatus: { hide: vi.fn(), setSuppressed: vi.fn() },
      showSelection: vi.fn(), drawPlacementGrid: vi.fn(), applyLayoutDraft: proto.applyLayoutDraft,
      patrol: { destroy: vi.fn() }, jobs: { destroy: vi.fn() }, keepClock: { destroy: vi.fn() },
    });
    (sprites[2]!['setVisible'] as ReturnType<typeof vi.fn>).mockClear();
    proto.applyLayoutDraft.call(trayed);
    expect(sprites[0]!['setVisible']).toHaveBeenLastCalledWith(false);
    expect(sprites[2]!['setVisible']).toHaveBeenLastCalledWith(false);
    // Lifting the berth carries its docked starter with the lifted look: depth and alpha follow the berth AFTER the lift is applied.
    proto.liftPiece.call(scene, sprites[0]!, BERTH.tx, BERTH.ty, { fw: 2, fh: 2 });
    expect(sprites[2]!['setDepth']).toHaveBeenLastCalledWith((sprites[0]!['depth'] as number) + 0.5);
    expect(sprites[2]!['setAlpha']).toHaveBeenLastCalledWith(sprites[0]!['alpha']);
    expect(sprites[0]!['depth']).toBeGreaterThan(640.5);
  });

  it('P6a: grants an advanced berth its controller only once BOTH its groups are resident, hands presence changes to it, rebuilds on an applied tier change, and clears everything when the positive fact goes', async () => {
    const proto = await scenePrototype();
    const resident = new Set(['pe_berth_survey_balloon']);
    const { scene, sprites } = berthHarness(proto, resident);
    useApp.setState({ base: berthBase(starterFacts(null, []), { single: true, advancedServicePresentation: facts(BALLOON, []) }) });
    proto.renderFromStore.call(scene);
    // Berth group resident, vehicle tier group not: still pending (an occupied berth never shows as empty).
    expect(scene.berthBuildings.size).toBe(0);
    expect(sprites[0]!['visible']).toBe(false);
    resident.add('pe_veh_survey_balloon_t1');
    proto.renderFromStore.call(scene);
    expect(sprites[0]!['setTexture']).toHaveBeenCalledWith('pe_berth_survey_balloon', 'pe_berth_survey_balloon_intact_f1');
    expect(scene.berthBuildings.size).toBe(1);
    expect(sprites[0]!['visible']).toBe(true);
    expect(scene.add.sprite).toHaveBeenLastCalledWith(0, 0, 'pe_veh_survey_balloon_t1');
    const plays = () => scene.wareTicker.play.mock.calls.map(([, p]) => (p as { atlas: string; base: string }).base);
    expect(plays()).toEqual(['pe_berth_survey_balloon_ambient', 'pe_veh_survey_balloon_t1_docked']);
    const vehicle = sprites[1]!;
    expect(vehicle['setOrigin']).toHaveBeenCalledWith(0.5, 110 / 112);
    Object.assign(sprites[0]!, { x: 704, y: 640, depth: 640 });
    const controller = scene.berthBuildings.get(BERTH.id)!;
    controller.layout();
    expect(vehicle['setPosition']).toHaveBeenLastCalledWith(704, 640 - 56);
    // Exhausted: the same controller rests the vehicle on the authored still at the same seat (D-a).
    useApp.setState({ base: berthBase(starterFacts(null, []), { single: true, advancedServicePresentation: facts({ ...BALLOON, presence: 'exhausted' }, []) }) });
    proto.renderFromStore.call(scene);
    expect(scene.berthBuildings.get(BERTH.id)).toBe(controller);
    expect(plays().at(-1)).toBe('pe_veh_survey_balloon_t1_exhausted');
    expect(vehicle['destroy']).not.toHaveBeenCalled();
    // An applied tier change is a new composition: the controller is rebuilt once the new tier group is resident (pending meanwhile).
    useApp.setState({ base: berthBase(starterFacts(null, []), { single: true, advancedServicePresentation: facts({ ...BALLOON, tier: 2 }, []) }) });
    proto.renderFromStore.call(scene);
    expect(scene.berthBuildings.size).toBe(0);
    expect(vehicle['destroy']).toHaveBeenCalledOnce();
    expect(sprites[0]!['visible']).toBe(false);
    expect((atlas.admitOnDemandAtlasCandidates.mock.calls.at(-1)![2] as readonly Candidate[]).map((c) => c.id)).toContain('berth:pe_veh_survey_balloon_t2');
    resident.add('pe_veh_survey_balloon_t2');
    proto.renderFromStore.call(scene);
    expect(scene.berthBuildings.size).toBe(1);
    expect(scene.berthBuildings.get(BERTH.id)).not.toBe(controller);
    expect(scene.add.sprite).toHaveBeenLastCalledWith(0, 0, 'pe_veh_survey_balloon_t2');
    // The positive fact goes (per-berth null): sprites/controllers are removed and the berth is a hidden footprint again.
    useApp.setState({ base: berthBase(starterFacts(null, []), { single: true, advancedServicePresentation: facts(null, []) }) });
    proto.renderFromStore.call(scene);
    expect(scene.berthBuildings.size).toBe(0);
    expect(sprites.at(-1)!['destroy']).toHaveBeenCalledOnce();
    expect(sprites[0]!['visible']).toBe(false);
    expect(scene.pendingArtIds.has(BERTH.id)).toBe(true);
    expect(proto.spriteKeyFor.call(scene, BERTH)).toBe(BERTH_UNPRESENTED_KEY);
  });

  it('P6a: battle entry forwards BOTH frozen berth siblings from the payload to the battle scene (a dropped field would silently show every frozen berth as unpresented)', () => {
    const source = readFileSync(new URL('./BaseScene.ts', import.meta.url), 'utf8');
    const enter = source.indexOf("bus.on('battle:enter'");
    const run = source.indexOf("this.scene.run('battle'", enter);
    const runEnd = source.indexOf('});', run);
    expect(enter).toBeGreaterThan(-1); expect(run).toBeGreaterThan(enter); expect(runEnd).toBeGreaterThan(run);
    const handlerHead = source.slice(enter, source.indexOf('=>', enter));
    const runArgs = source.slice(run, runEnd);
    for (const field of ['servicePresentation', 'advancedServicePresentation', 'boundCosmeticVisual', 'snapshot']) {
      expect(handlerHead, `destructures ${field}`).toContain(field);
      expect(runArgs, `forwards ${field}`).toContain(field);
    }
  });

  it('P6a (review M1): layout edit never reveals a pending-art berth — an unpresented footprint and a not-yet-resident presented berth stay hidden while a resident one shows', async () => {
    const proto = await scenePrototype();
    const resident = new Set(['pe_fleet_starter']);
    const { scene, sprites } = berthHarness(proto, resident);
    // Three berths: starter resident (visible), balloon not resident (pending), empty (unpresented).
    useApp.setState({ base: berthBase(starterFacts('occupied'), { advancedServicePresentation: facts(null, [{ buildingId: SCAFFOLD.id, installation: { family: 'survey_balloon', tier: 1, presence: 'occupied' } }, { buildingId: EMPTY.id, installation: null }]) }) });
    (scene as unknown as { base: unknown }).base = useApp.getState().base;
    useApp.setState({ base: { ...useApp.getState().base!, buildings: useApp.getState().base!.buildings.map((b) => (b.id === SCAFFOLD.id ? { ...b, level: 1, underConstruction: false } : b)) } as never });
    proto.renderFromStore.call(scene);
    const starter = sprites.find((s) => s.created[2] === 'pe_fleet_starter')!, balloon = sprites.find((s) => s.created[2] === 'pe_berth_survey_balloon')!, empty = sprites.find((s) => s.created[2] === 'bld' && s.created.length === 3)!;
    expect(starter['visible']).toBe(true); expect(balloon['visible']).toBe(false); expect(empty['visible']).toBe(false);
    const positions = new Map([[BERTH.id, { tx: BERTH.tx, ty: BERTH.ty }], [SCAFFOLD.id, { tx: SCAFFOLD.tx, ty: SCAFFOLD.ty }], [EMPTY.id, { tx: EMPTY.tx, ty: EMPTY.ty }]]);
    const editing = Object.assign(scene, {
      layoutDraft: { positions, trayIds: new Set<string>(), selectedBuildingId: null, wallPaintLevel: null },
      wallFrames: new Map<string, string>(), wareWalls: new Map(), occ: { rebuild: vi.fn() },
      ambience: { hide: vi.fn(), sync: vi.fn() }, heroRecovery: { hide: vi.fn(), destroy: vi.fn() }, armyStatus: { hide: vi.fn(), setSuppressed: vi.fn() },
      showSelection: vi.fn(), drawPlacementGrid: vi.fn(), applyLayoutDraft: proto.applyLayoutDraft,
      patrol: { destroy: vi.fn() }, jobs: { destroy: vi.fn() }, keepClock: { destroy: vi.fn() },
    });
    proto.applyLayoutDraft.call(editing);
    expect(starter['setVisible']).toHaveBeenLastCalledWith(true);
    expect(balloon['setVisible'], 'a presented berth whose groups are not resident stays a hidden footprint in layout edit').toHaveBeenLastCalledWith(false);
    expect(empty['setVisible'], 'an unpresented berth never shows the whole packed sheet in layout edit').toHaveBeenLastCalledWith(false);
    expect(scene.positionBuilding).toHaveBeenCalledWith(empty, EMPTY.tx, EMPTY.ty, { fw: 2, fh: 2 });
  });
  // ---- C5: root-published fleet journeys ----
  const BASE_ID = '00000001-0000-4000-8000-000000000000';
  const juuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const peCosmetics = JSON.parse(readFileSync(new URL('../../../../../docs/evidence/2026-09-30-bound-cosmetic-visuals/pe_cosmetics.manifest.json', import.meta.url), 'utf8')) as unknown;
  const cosmetics = parseMarketArtMetadata(undefined, peCosmetics);
  const AURORA = (() => {
    const b = cosmetics.bindings['aurora_wake']!;
    return { state: 'available', visual: { version: 1, wake: { version: 1, outputId: 'aurora_wake', sourceId: 'auroraWake', sourceManifestSha256: b.sourceManifestSha256, sourceIndexSha256: b.sourceIndexSha256, bindingSha256: b.sha256 } } } as unknown as FleetJourneyEvent['wake'];
  })();
  const journey = (over: Partial<FleetJourneyEvent> & { n?: number } = {}): FleetJourneyEvent => {
    const { n = 4, ...rest } = over;
    return { version: 1, kind: 'departure', baseId: BASE_ID, berthId: BERTH.id, installationId: juuid(3), expeditionId: juuid(n),
      at: '2026-10-01T04:00:00.000Z', vehicle: { family: 'starter' }, wake: { state: 'legacy', visual: null }, ...rest } as FleetJourneyEvent;
  };
  const withBaseId = (base: BaseStateDto): BaseStateDto => ({ ...base, baseId: BASE_ID } as BaseStateDto);
  const candidateIds = () => (atlas.admitOnDemandAtlasCandidates.mock.calls.at(-1)![2] as readonly Candidate[]).map((c) => c.id);
  type JourneyScene = ReturnType<typeof berthHarness>['scene'] & {
    onFleetJourney: (e: FleetJourneyEvent) => void; cancelFleetJourneys: (forgetArt?: boolean) => void; onDocumentVisibility: () => void;
    onSessionChange: (state: { wallet: string | null; selectedBaseId: string | null; baseSelectionEpoch: number; base: BaseStateDto | null }, prev: { wallet: string | null; selectedBaseId: string | null; baseSelectionEpoch: number; base: BaseStateDto | null }) => void;
    attachJourneyLifecycle: () => void; unsub: Array<() => void>;
    pendingJourneys: Map<string, unknown>; journeyArtWanted: Map<string, readonly string[]>; journeyOutcomes: Map<string, unknown>; marketArt: unknown;
  };
  /** The berth harness plus the claim/camera stubs a base IDENTITY change reaches (the journey tests carry a real baseId). */
  function journeyHarness(proto: ScenePrototype, resident: Set<string>) {
    const { scene } = berthHarness(proto, resident);
    return Object.assign(scene, {
      drawClaimPerimeter: vi.fn(), drawPlacementGrid: vi.fn(), rebandCamera: vi.fn(), fitCamera: vi.fn(), userMovedCamera: false,
      journeyCanvasVisible: (proto as unknown as { journeyCanvasVisible: unknown }).journeyCanvasVisible,
      onDocumentVisibility: (proto as unknown as { onDocumentVisibility: unknown }).onDocumentVisibility,
      onSessionChange: (proto as unknown as { onSessionChange: unknown }).onSessionChange,
      attachJourneyLifecycle: (proto as unknown as { attachJourneyLifecycle: unknown }).attachJourneyLifecycle,
      unsub: [] as Array<() => void>,
    }) as unknown as JourneyScene;
  }
  let playJourney: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { playJourney = vi.spyOn(BerthBuildingFx.prototype, 'playJourney'); });
  afterEach(() => { playJourney.mockRestore(); vi.restoreAllMocks(); });

  it('C5: a root event is honoured ONCE for this base and a complete presented berth — it plays the installation\'s plan when every journey group is resident; foreign bases, unknown berths, scaffolds and repeated keys play nothing', async () => {
    const proto = await scenePrototype();
    const scene = journeyHarness(proto, new Set(['pe_fleet_starter', 'pe_cosmetics']));
    scene.marketArt = cosmetics;
    useApp.setState({ base: withBaseId(berthBase(starterFacts('away'))) });
    proto.renderFromStore.call(scene);
    expect(scene.berthBuildings.size).toBe(1);
    scene.onFleetJourney(journey({ n: 41, baseId: juuid(9) }));
    scene.onFleetJourney(journey({ n: 42, berthId: SCAFFOLD.id }));
    scene.onFleetJourney(journey({ n: 43, berthId: EMPTY.id }));
    scene.onFleetJourney(journey({ n: 44, berthId: 'not-a-berth' }));
    expect(playJourney).not.toHaveBeenCalled();
    expect(scene.pendingJourneys.size).toBe(0);
    scene.onFleetJourney(journey({ wake: AURORA }));
    expect(playJourney).toHaveBeenCalledOnce();
    const plan = playJourney.mock.calls[0]![0] as { kind: string; steps: readonly unknown[]; fx: { clipId: string } | null; wake: { atlas: string } | null };
    expect(plan).toMatchObject({ kind: 'departure', fx: { clipId: 'pe_fx_departure' }, wake: { atlas: 'pe_cosmetics' } });
    expect(plan.steps).toHaveLength(8);
    expect(scene.pendingJourneys.size, 'nothing is queued once played').toBe(0);
    // The same key again (a re-read, a replay) is dropped; a different kind/receipt for the same original is its own event.
    scene.onFleetJourney(journey({ wake: AURORA }));
    scene.onFleetJourney(journey());
    expect(playJourney).toHaveBeenCalledOnce();
    scene.onFleetJourney(journey({ kind: 'return', returnId: juuid(7) } as Partial<FleetJourneyEvent>));
    expect(playJourney).toHaveBeenCalledTimes(2);
    expect((playJourney.mock.calls[1]![0] as { kind: string; fx: { clipId: string } }).fx.clipId).toBe('pe_fx_return');
    // Same command UUID in the OTHER family's identity domain is not a duplicate (kind:family:id).
    useApp.setState({ base: withBaseId(berthBase(starterFacts(null), { advancedServicePresentation: facts({ ...BALLOON, presence: 'away' }) })) });
    atlas.isV2AtlasLoaded.mockImplementation(() => true);
    proto.renderFromStore.call(scene);
    scene.onFleetJourney(journey({ vehicle: { family: 'survey_balloon', tier: 1 } }));
    expect(playJourney).toHaveBeenCalledTimes(3);
    const balloon = playJourney.mock.calls[2]![0] as { steps: ReadonlyArray<{ offsetPx: readonly [number, number] }>; fx: unknown };
    expect(balloon.fx).toBeNull(); expect(balloon.steps[7]!.offsetPx).toEqual([0, -78]);
  });

  it('C5: an event whose vehicle is not the berth\'s current installation (family or tier) is dropped, never mapped onto another family\'s track', async () => {
    const proto = await scenePrototype();
    const scene = journeyHarness(proto, new Set(['pe_fleet_starter', 'pe_berth_survey_balloon', 'pe_veh_survey_balloon_t1']));
    useApp.setState({ base: withBaseId(berthBase(starterFacts(null), { advancedServicePresentation: facts(BALLOON) })) });
    proto.renderFromStore.call(scene);
    scene.onFleetJourney(journey({ n: 11 }));
    scene.onFleetJourney(journey({ n: 12, vehicle: { family: 'survey_balloon', tier: 2 } }));
    scene.onFleetJourney(journey({ n: 13, vehicle: { family: 'cargo_cutter', tier: 1 } }));
    expect(playJourney).not.toHaveBeenCalled();
    expect(scene.pendingJourneys.size).toBe(0);
    expect(scene.journeyArtWanted.size, 'a foreign event requests no art').toBe(0);
    scene.onFleetJourney(journey({ n: 14, vehicle: { family: 'survey_balloon', tier: 1 } }));
    expect(playJourney).toHaveBeenCalledOnce();
  });

  it('C5: absent art defers a journey only for its own live second — it requests the groups, then expires without replaying, and the request stays for the next event', async () => {
    const proto = await scenePrototype();
    const resident = new Set<string>();
    const scene = journeyHarness(proto, resident);
    scene.marketArt = cosmetics;
    useApp.setState({ base: withBaseId(berthBase(starterFacts('away'))) });
    proto.renderFromStore.call(scene);
    expect(scene.berthBuildings.size).toBe(0);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    scene.onFleetJourney(journey({ wake: AURORA }));
    expect(playJourney).not.toHaveBeenCalled();
    expect(scene.pendingJourneys.size).toBe(1);
    expect(candidateIds()).toEqual(expect.arrayContaining(['berth:pe_fleet_starter', 'berth:pe_cosmetics']));
    // Still within the live second and still absent: waiting, requesting.
    now.mockReturnValue(1_000_900);
    proto.renderFromStore.call(scene);
    expect(playJourney).not.toHaveBeenCalled(); expect(scene.pendingJourneys.size).toBe(1);
    // The art lands after the live second: the stale journey is dropped, never played; its art request remains.
    now.mockReturnValue(1_001_001);
    resident.add('pe_fleet_starter'); resident.add('pe_cosmetics');
    proto.renderFromStore.call(scene);
    expect(scene.berthBuildings.size).toBe(1);
    expect(playJourney).not.toHaveBeenCalled();
    expect(scene.pendingJourneys.size).toBe(0);
    expect(scene.journeyArtWanted.get(BERTH.id)).toEqual(['pe_fleet_starter', 'pe_cosmetics']);
    expect(candidateIds()).toEqual(expect.arrayContaining(['berth:pe_fleet_starter', 'berth:pe_cosmetics']));
    // The next real event finds the art resident and plays at once.
    scene.onFleetJourney(journey({ n: 21, wake: AURORA }));
    expect(playJourney).toHaveBeenCalledOnce();
    // Art within the live second plays (deferral is bounded, not forbidden).
    resident.clear();
    now.mockReturnValue(2_000_000);
    scene.onFleetJourney(journey({ n: 22 }));
    expect(playJourney).toHaveBeenCalledOnce();
    now.mockReturnValue(2_000_500);
    resident.add('pe_fleet_starter');
    proto.renderFromStore.call(scene);
    expect(playJourney).toHaveBeenCalledTimes(2);
  });

  it('C5: off-canvas events (opaque screen) are dropped and never replayed, leaving only their art request; sleep cancels pending and in-flight journeys; logout or another base forgets everything', async () => {
    const proto = await scenePrototype();
    const resident = new Set<string>(['pe_fleet_starter']);
    const scene = journeyHarness(proto, resident);
    useApp.setState({ base: withBaseId(berthBase(starterFacts('away'))) });
    proto.renderFromStore.call(scene);
    let active = false;
    (scene as { scene: unknown }).scene = { isActive: () => active };
    scene.onFleetJourney(journey({ n: 31 }));
    expect(playJourney).not.toHaveBeenCalled();
    expect(scene.pendingJourneys.size).toBe(0);
    expect(scene.journeyArtWanted.get(BERTH.id)).toEqual(['pe_fleet_starter']);
    active = true;
    proto.renderFromStore.call(scene);
    expect(playJourney, 'returning to the canvas replays nothing').not.toHaveBeenCalled();
    // In flight on an active canvas, then the scene sleeps: the controller abandons the journey.
    const cancel = vi.spyOn(BerthBuildingFx.prototype, 'cancelJourney');
    scene.onFleetJourney(journey({ n: 32 }));
    expect(playJourney).toHaveBeenCalledOnce();
    scene.cancelFleetJourneys();
    expect(cancel).toHaveBeenCalled();
    expect(scene.journeyArtWanted.size, 'sleep keeps the art request').toBe(1);
    // Another base: pending and requests go; the other base's event is not this base's.
    resident.clear();
    scene.onFleetJourney(journey({ n: 33 }));
    expect(scene.pendingJourneys.size).toBe(1);
    useApp.setState({ base: { ...withBaseId(berthBase(starterFacts('away'))), baseId: juuid(99), player: { wallet: 'other' } } as unknown as BaseStateDto });
    proto.renderFromStore.call(scene);
    expect(scene.pendingJourneys.size).toBe(0); expect(scene.journeyArtWanted.size).toBe(0);
    // Logout clears as well.
    useApp.setState({ base: withBaseId(berthBase(starterFacts('away'))) });
    proto.renderFromStore.call(scene);
    scene.onFleetJourney(journey({ n: 34 }));
    expect(scene.pendingJourneys.size).toBe(1);
    useApp.setState({ base: null });
    proto.renderFromStore.call(scene);
    expect(scene.pendingJourneys.size).toBe(0); expect(scene.journeyArtWanted.size).toBe(0);
  });

  it('C5 lifecycle: a deferred event keeps the exact snapshot, session and visible canvas it arrived with — a hidden document (also hide→show within its second), a newer same-base snapshot or another wallet drops it before play; an already-valid in-flight journey survives a replaced snapshot and ends on the latest presence', async () => {
    const proto = await scenePrototype();
    const resident = new Set<string>();
    const scene = journeyHarness(proto, resident);
    const priorWallet = useApp.getState().wallet;
    const doc = { visibilityState: 'visible' as 'visible' | 'hidden' };
    vi.stubGlobal('document', doc);
    try {
      useApp.setState({ wallet: 'journey-wallet', base: withBaseId(berthBase(starterFacts('away'))) });
      proto.renderFromStore.call(scene);
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      // (1) Hidden deferred load: the art lands within the second but the document is hidden → dropped, never played.
      scene.onFleetJourney(journey({ n: 51 }));
      expect(scene.pendingJourneys.size).toBe(1);
      doc.visibilityState = 'hidden';
      resident.add('pe_fleet_starter');
      now.mockReturnValue(1_000_300);
      proto.renderFromStore.call(scene);
      expect(playJourney).not.toHaveBeenCalled(); expect(scene.pendingJourneys.size).toBe(0);
      // (2) Hide → show within the second: the visibility handler ends the pending event; showing again replays nothing.
      doc.visibilityState = 'visible'; resident.clear();
      scene.onFleetJourney(journey({ n: 52 }));
      expect(scene.pendingJourneys.size).toBe(1);
      doc.visibilityState = 'hidden'; scene.onDocumentVisibility();
      expect(scene.pendingJourneys.size).toBe(0);
      doc.visibilityState = 'visible'; resident.add('pe_fleet_starter');
      proto.renderFromStore.call(scene);
      expect(playJourney).not.toHaveBeenCalled();
      expect(scene.journeyArtWanted.get(BERTH.id), 'the art request survives a hide').toEqual(['pe_fleet_starter']);
      // (3) A newer same-base snapshot before play: the deferred event belonged to the response it came with → dropped.
      resident.clear();
      scene.onFleetJourney(journey({ n: 53 }));
      expect(scene.pendingJourneys.size).toBe(1);
      useApp.setState({ base: { ...useApp.getState().base! } });
      resident.add('pe_fleet_starter');
      proto.renderFromStore.call(scene);
      expect(playJourney).not.toHaveBeenCalled(); expect(scene.pendingJourneys.size).toBe(0);
      // An in-flight journey is NOT yanked by a replaced snapshot (ordinary polling): it completes on the latest presence.
      // (playJourney itself calls cancelJourney once to clear any earlier flight, so count from after the play.)
      const cancel = vi.spyOn(BerthBuildingFx.prototype, 'cancelJourney');
      scene.onFleetJourney(journey({ n: 54 }));
      expect(playJourney).toHaveBeenCalledOnce();
      const cancelsAfterPlay = cancel.mock.calls.length;
      useApp.setState({ base: { ...useApp.getState().base! } });
      proto.renderFromStore.call(scene);
      expect(cancel.mock.calls.length).toBe(cancelsAfterPlay); expect(playJourney).toHaveBeenCalledOnce();
      // (4) Another wallet before play: dropped at consumption; the session subscription also cancels in flight and forgets the art requests.
      resident.clear();
      scene.onFleetJourney(journey({ n: 55 }));
      expect(scene.pendingJourneys.size).toBe(1);
      useApp.setState({ wallet: 'another-wallet' });
      resident.add('pe_fleet_starter');
      proto.renderFromStore.call(scene);
      expect(playJourney).toHaveBeenCalledOnce(); expect(scene.pendingJourneys.size).toBe(0);
      const scope = (wallet: string, selectedBaseId: string | null = BASE_ID, base: BaseStateDto | null = useApp.getState().base) => ({ wallet, selectedBaseId, baseSelectionEpoch: 1, base });
      scene.onSessionChange(scope('another-wallet'), scope('journey-wallet'));
      expect(cancel.mock.calls.length, 'the one live controller is cancelled').toBe(cancelsAfterPlay + 1); expect(scene.journeyArtWanted.size).toBe(0);
      scene.onSessionChange(scope('another-wallet'), scope('another-wallet'));
      expect(cancel.mock.calls.length, 'an unchanged wallet cancels nothing').toBe(cancelsAfterPlay + 1);
      // create() attaches the lifecycle (the harness exercises attachJourneyLifecycle itself below).
      expect(readFileSync(new URL('./BaseScene.ts', import.meta.url), 'utf8')).toContain('    this.attachJourneyLifecycle();\n');
    } finally {
      vi.unstubAllGlobals();
      useApp.setState({ wallet: priorWallet });
    }
  });

  it('C5 lifecycle (R3 residuals): pagehide is a WINDOW event and visibilitychange/freeze are DOCUMENT events — each exercised target retires an in-flight journey and every listener is removed with the scene; a same-wallet scope change (base cleared / another selected base) cancels in flight while an ordinary same-base replacement does not', async () => {
    const proto = await scenePrototype();
    const scene = journeyHarness(proto, new Set(['pe_fleet_starter']));
    const priorWallet = useApp.getState().wallet;
    type Recorder = { visibilityState: 'visible' | 'hidden'; listeners: Map<string, Set<() => void>>; addEventListener: (type: string, fn: () => void) => void; removeEventListener: (type: string, fn: () => void) => void; fire: (type: string) => void };
    const recorder = (): Recorder => {
      const listeners = new Map<string, Set<() => void>>();
      return {
        visibilityState: 'visible', listeners,
        addEventListener: (type, fn) => { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn); },
        removeEventListener: (type, fn) => { listeners.get(type)?.delete(fn); },
        fire: (type) => { for (const fn of listeners.get(type) ?? []) fn(); },
      };
    };
    const doc = recorder(); const win = recorder();
    vi.stubGlobal('document', doc); vi.stubGlobal('window', win);
    try {
      useApp.setState({ wallet: 'journey-wallet', base: withBaseId(berthBase(starterFacts('away'))) });
      proto.renderFromStore.call(scene);
      scene.attachJourneyLifecycle();
      expect([...doc.listeners.keys()].sort()).toEqual(['freeze', 'visibilitychange']);
      expect([...win.listeners.keys()]).toEqual(['pagehide']);
      expect(doc.listeners.has('pagehide'), 'pagehide does not bubble to document; it is never registered there').toBe(false);
      const cancel = vi.spyOn(BerthBuildingFx.prototype, 'cancelJourney');
      const cancels = () => cancel.mock.calls.length;
      let n = 60;
      const inFlight = () => { scene.onFleetJourney(journey({ n: n++ })); };
      inFlight(); const base1 = cancels();
      win.fire('pagehide');
      expect(cancels(), 'window pagehide retires the in-flight journey').toBe(base1 + 1);
      inFlight(); const base2 = cancels();
      doc.fire('visibilitychange');
      expect(cancels(), 'a visibilitychange that is still visible retires nothing').toBe(base2);
      doc.visibilityState = 'hidden'; doc.fire('visibilitychange');
      expect(cancels(), 'document hidden retires it').toBe(base2 + 1);
      doc.visibilityState = 'visible';
      inFlight(); const base3 = cancels();
      doc.fire('freeze');
      expect(cancels(), 'document freeze retires it').toBe(base3 + 1);
      // Session/base SCOPE through the store subscription: ordinary same-base replacement keeps the flight…
      inFlight(); const base4 = cancels();
      useApp.setState({ base: { ...useApp.getState().base! } });
      expect(cancels(), 'an ordinary same-base snapshot replacement is not a scope change').toBe(base4);
      // …a selection epoch advance (a deed switch beginning via beginBaseSelectionGuard; ordinary reloads reuse the captured guard) ends it…
      useApp.setState({ baseSelectionEpoch: useApp.getState().baseSelectionEpoch + 1 });
      expect(cancels(), 'a selection epoch advance cancels in flight').toBe(base4 + 1);
      // …a same-wallet setAuth-shaped change (base cleared, selection cleared, epoch bumped) ends it and forgets the art…
      proto.renderFromStore.call(scene);
      inFlight(); const base4b = cancels();
      expect(scene.journeyArtWanted.size).toBe(1);
      useApp.setState((state) => ({ base: null, selectedBaseId: null, baseSelectionEpoch: state.baseSelectionEpoch + 1 }));
      expect(cancels(), 'same-wallet base/selection invalidation cancels in flight').toBe(base4b + 1);
      expect(scene.journeyArtWanted.size).toBe(0);
      // …and so does another selected base with the same wallet.
      useApp.setState({ base: withBaseId(berthBase(starterFacts('away'))), selectedBaseId: BASE_ID });
      proto.renderFromStore.call(scene);
      inFlight(); const base5 = cancels();
      useApp.setState({ selectedBaseId: juuid(77) });
      expect(cancels(), 'another selected base cancels in flight').toBe(base5 + 1);
      // Scene teardown removes every listener and the subscription.
      scene.unsub.forEach((u) => u()); scene.unsub.length = 0;
      expect([...doc.listeners.values()].every((set) => set.size === 0)).toBe(true);
      expect([...win.listeners.values()].every((set) => set.size === 0)).toBe(true);
      const after = cancels();
      useApp.setState({ selectedBaseId: juuid(78) });
      expect(cancels(), 'no subscription survives teardown').toBe(after);
    } finally {
      vi.unstubAllGlobals();
      useApp.setState({ wallet: priorWallet, selectedBaseId: null });
    }
  });

  it('C5 stale dock: after an accepted departure the SAME originating snapshot (still "occupied") never re-docks the craft — the scene rests it on the event outcome until a genuinely newer snapshot (ordinary refresh, actual return) controls rest again; scope changes forget the outcome', async () => {
    const proto = await scenePrototype();
    const scene = journeyHarness(proto, new Set(['pe_fleet_starter']));
    const setPresence = vi.spyOn(BerthBuildingFx.prototype, 'setPresence');
    const origin = withBaseId(berthBase(starterFacts('occupied')));
    useApp.setState({ base: origin });
    proto.renderFromStore.call(scene);
    expect(setPresence).toHaveBeenLastCalledWith('occupied');
    scene.onFleetJourney(journey({ n: 71 }));
    expect(playJourney).toHaveBeenCalledOnce();
    expect(scene.journeyOutcomes.get(BERTH.id)).toEqual({ snapshot: origin, presence: 'away' });
    // The base timer re-renders the very same (stale) snapshot ~12 s later: the craft stays away.
    setPresence.mockClear();
    proto.renderFromStore.call(scene);
    expect(setPresence).toHaveBeenLastCalledWith('away');
    expect(useApp.getState().base).toBe(origin);
    // A genuinely newer snapshot controls rest again — whatever it says.
    useApp.setState({ base: withBaseId(berthBase(starterFacts('away'))) });
    proto.renderFromStore.call(scene);
    expect(setPresence).toHaveBeenLastCalledWith('away');
    expect(scene.journeyOutcomes.size).toBe(0);
    useApp.setState({ base: withBaseId(berthBase(starterFacts('occupied'))) });
    proto.renderFromStore.call(scene);
    expect(setPresence, 'the server is still authoritative once it has spoken anew').toHaveBeenLastCalledWith('occupied');
    // A return records NO outcome: the snapshot carrying it already states the post-settlement
    // fact. An advanced last-use return's CURRENT sibling says exhausted, and the same snapshot
    // re-rendered keeps exhausted — never a pinned occupied.
    const spentReturn = withBaseId(berthBase(starterFacts(null), { advancedServicePresentation: facts({ ...BALLOON, presence: 'exhausted' }) }));
    useApp.setState({ base: spentReturn });
    atlas.isV2AtlasLoaded.mockImplementation(() => true);
    proto.renderFromStore.call(scene);
    expect(setPresence).toHaveBeenLastCalledWith('exhausted');
    scene.onFleetJourney(journey({ n: 72, kind: 'return', returnId: juuid(73), vehicle: { family: 'survey_balloon', tier: 1 } } as Partial<FleetJourneyEvent>));
    expect(playJourney).toHaveBeenCalledTimes(2);
    expect(scene.journeyOutcomes.has(BERTH.id)).toBe(false);
    setPresence.mockClear();
    proto.renderFromStore.call(scene);
    expect(useApp.getState().base).toBe(spentReturn);
    expect(setPresence, 'the same snapshot keeps the authoritative exhausted fact').toHaveBeenLastCalledWith('exhausted');
    // Session/base scope changes forget departure outcomes with everything else.
    useApp.setState({ base: origin }); proto.renderFromStore.call(scene);
    scene.onFleetJourney(journey({ n: 74 }));
    expect(scene.journeyOutcomes.size).toBe(1);
    scene.cancelFleetJourneys(true);
    expect(scene.journeyOutcomes.size).toBe(0);
    setPresence.mockRestore();
  });
});

describe('BaseScene Phase E ordinary Workshop/Lodge art (P5)', () => {
  const evidence = (name: string): unknown => JSON.parse(readFileSync(
    new URL(`../../../../../docs/evidence/2026-09-30-bound-cosmetic-visuals/${name}`, import.meta.url), 'utf8',
  ));
  const service = JSON.parse(readFileSync(new URL('../../../testFixtures/pe_service_buildings.manifest.json', import.meta.url), 'utf8')) as unknown;
  const serviceArt = parseMarketArtMetadata(evidence('pe_market.manifest.json'), evidence('pe_cosmetics.manifest.json'), service);
  const marketOnly = parseMarketArtMetadata(evidence('pe_market.manifest.json'), evidence('pe_cosmetics.manifest.json'));
  const WORKSHOP = { id: 'ws-1', type: 'workshop', level: 1, tx: 4, ty: 4, underConstruction: false };
  const LODGE = { id: 'lodge-1', type: 'lodge', level: 6, tx: 10, ty: 4, underConstruction: false };

  function serviceBase(overrides: Partial<{ underConstruction: boolean; jobs: unknown[] }> = {}): BaseStateDto {
    return {
      ...garrisonBase(), army: [],
      buildings: [{ ...WORKSHOP, underConstruction: overrides.underConstruction ?? false }, { ...LODGE }],
      jobs: overrides.jobs ?? [],
    } as unknown as BaseStateDto;
  }

  function serviceHarness(proto: ScenePrototype, resident: Set<string>, table = serviceArt) {
    const sprites: Array<Record<string, unknown> & { created: unknown[] }> = [];
    const scene = Object.assign(patrolHarness(proto), {
      marketArt: table, meta: {}, starterFleetArt: EMPTY_STARTER_FLEET_ART, advancedFleetArt: EMPTY_ADVANCED_FLEET_ART, berthFacts: { berths: new Map(), unavailable: false }, berthBuildings: new Map(),
      spriteKeyFor: proto.spriteKeyFor, footprintOf: proto.footprintOf, buildingSeat: proto.buildingSeat,
      marketChoiceFor: (proto as unknown as { marketChoiceFor: unknown }).marketChoiceFor,
      syncMarketController: (proto as unknown as { syncMarketController: unknown }).syncMarketController,
      destroyMarketController: (proto as unknown as { destroyMarketController: unknown }).destroyMarketController,
      berthRestKeyFor: (proto as unknown as { berthRestKeyFor: unknown }).berthRestKeyFor,
      syncBerthController: vi.fn(), destroyBerthController: vi.fn(),
      wareTicker: { play: vi.fn(), unregister: vi.fn() }, ticker: { unregister: vi.fn() },
      add: { sprite: vi.fn((...created: unknown[]) => {
        const sprite = Object.assign(stubSprite(), { created, active: true });
        sprite['frame'] = { name: typeof created[3] === 'string' ? created[3] : '__BASE' };
        sprite['setVisible'] = vi.fn().mockReturnValue(sprite); sprite['setTexture'] = vi.fn().mockReturnValue(sprite);
        sprites.push(sprite as never);
        return sprite;
      }) },
    });
    atlas.isV2AtlasLoaded.mockImplementation((_scene: unknown, group: string) => resident.has(group));
    return { scene, sprites };
  }

  let priorBase: BaseStateDto | null = null;
  beforeEach(() => { priorBase = useApp.getState().base; });
  afterEach(() => { useApp.setState({ base: priorBase }); atlas.isV2AtlasLoaded.mockReset(); atlas.admitOnDemandAtlasCandidates.mockReset(); atlas.admitOnDemandAtlasCandidates.mockImplementation(() => new Set()); });

  it('keys a Workshop/Lodge by its family tier cell, keeps the shared 2×2 footprint and the full-cell seat; a stray Awning never applies; a Market-only table keeps the historical key', async () => {
    const proto = await scenePrototype();
    const { scene } = serviceHarness(proto, new Set());
    expect(proto.spriteKeyFor.call(scene, WORKSHOP)).toBe('pe_workshop_t1_idle_f1');
    expect(proto.spriteKeyFor.call(scene, LODGE)).toBe('pe_lodge_t2_idle_f1');
    expect(proto.spriteKeyFor.call(scene, { ...LODGE, level: 20 })).toBe('pe_lodge_t4_idle_f1');
    expect(proto.footprintOf.call(scene, 'pe_workshop_t1_idle_f1')).toEqual({ fw: 2, fh: 2 });
    expect(proto.footprintOf.call(scene, 'pe_lodge_t4_collapse_f9')).toEqual({ fw: 2, fh: 2 });
    expect(proto.buildingSeat.call(scene, 'pe_lodge_t2_idle_f1')).toEqual({ origin: [0.5, 1], scale: 1, offsetGamePx: [0, 0] });
    scene.marketAwnings = new Map([[WORKSHOP.id, 'artisan_market_awning_t1']]);
    atlas.isV2AtlasLoaded.mockImplementation(() => true);
    expect((scene.marketChoiceFor as (b: unknown) => unknown).call(scene, WORKSHOP)).toEqual({ family: 'workshop', tier: 1, awning: null });
    const { scene: legacy } = serviceHarness(proto, new Set(), marketOnly);
    expect(proto.spriteKeyFor.call(legacy, WORKSHOP)).toBe('bld_workshop_l1');
  });

  it('hides a Workshop/Lodge frameless until its group is resident (never the whole-sheet fallback) and requests each family group as REQUIRED residency', async () => {
    const proto = await scenePrototype();
    const { scene, sprites } = serviceHarness(proto, new Set());
    scene.wareGroupForBuilding.mockImplementation((b) => ((b as { type?: string } | undefined)?.type === 'mine' ? 'ware_mine_1' : null));
    const base = serviceBase();
    base.buildings.push({ id: 'mine-1', type: 'mine', level: 1, tx: 2, ty: 2, underConstruction: false } as never);
    useApp.setState({ base });
    proto.renderFromStore.call(scene);
    expect(scene.add.sprite).toHaveBeenCalledWith(0, 0, 'pe_workshop_t1');
    expect(scene.add.sprite).toHaveBeenCalledWith(0, 0, 'pe_lodge_t2');
    expect(scene.add.sprite).not.toHaveBeenCalledWith(0, 0, 'bld', 'bld_workshop_l1');
    for (const s of sprites.filter((x) => (x['created'] as unknown[])[2] !== 'bld')) {
      expect(s['setVisible']).toHaveBeenLastCalledWith(false);
      expect(s['setTexture'], 'no missing-frame request while the group is absent').not.toHaveBeenCalled();
    }
    expect(scene.marketBuildings.size).toBe(0);
    const admitted = (atlas.admitOnDemandAtlasCandidates.mock.calls.at(-1)![2] as readonly Candidate[]).map((c) => c.id);
    expect(admitted).toContain('market:pe_workshop_t1');
    expect(admitted).toContain('market:pe_lodge_t2');
    expect(admitted.indexOf('market:pe_workshop_t1')).toBeLessThan(admitted.indexOf('ware:ware_mine_1'));
    expect(admitted).not.toContain('market:pe_cosmetics');
  });

  it('grants each family its controller once resident: idle at rest, the nine-cell construction one-shot for a build, never a working or ready state', async () => {
    const proto = await scenePrototype();
    const { scene, sprites } = serviceHarness(proto, new Set(['pe_workshop_t1', 'pe_lodge_t2']));
    useApp.setState({ base: serviceBase({ jobs: [{ id: 'j1', kind: 'build', buildingId: WORKSHOP.id }], underConstruction: true }) });
    proto.renderFromStore.call(scene);
    expect(scene.add.sprite).toHaveBeenCalledWith(0, 0, 'pe_workshop_t1', 'pe_workshop_t1_idle_f1');
    expect(scene.add.sprite).toHaveBeenCalledWith(0, 0, 'pe_lodge_t2', 'pe_lodge_t2_idle_f1');
    expect(scene.marketBuildings.size).toBe(2);
    const plays = scene.wareTicker.play.mock.calls.map(([, p]) => p as { base: string; seq: string[]; loop: boolean });
    const construction = plays.find((p) => p.base === 'pe_workshop_t1_construction')!;
    expect(construction.seq).toHaveLength(9); expect(construction.loop).toBe(false);
    expect(plays.find((p) => p.base === 'pe_lodge_t2_idle')).toMatchObject({ seq: ['pe_lodge_t2_idle_f1'] });
    expect(plays.map((p) => p.base)).not.toContain('pe_workshop_t1_working');
    expect(plays.map((p) => p.base)).not.toContain('pe_lodge_t2_ready');
    for (const s of sprites) expect(s['setVisible']).toHaveBeenLastCalledWith(true);
  });
});

// Real handlers under a mounted draft policy; no copied production callbacks.
describe('BaseScene whole user commands', () => {
  function hold() {
    const prior = useApp.getState();
    const panel = { kind: 'hub' as const, featureId: 'hub.draft' };
    useApp.setState({ screen: 'base', basePanel: panel, selectedBuildingId: null, selectedObstacleId: null,
      base: { ...storeBase({ tx: 6, ty: 6 }), obstacles: [{ id: 'oak', type: 'tree', tx: 4, ty: 4 }] } as never });
    const pending: PanelDismissRequest[] = [];
    const session = createPanelSession({ panel, controlled: true, isCurrent: () => useApp.getState().basePanel === panel,
      canMutate: () => false, canRecover: () => false });
    const off = session.mount(); session.setDismissPolicy(request => { pending.push(request); });
    return { pending, finish: () => { off(); useApp.setState(prior, true); } };
  }
  for (const producer of ['building-tap', 'obstacle-tap', 'focus'] as const) {
    it.each(['confirm', 'wallet', 'target-removed'] as const)(producer + ' holds scene/store/bus together: %s', async change => {
      const proto = await scenePrototype(); const h = hold(); const g = gestureHarness(proto);
      const events: string[] = [];
      const offBuilding = bus.on('base:select', () => events.push('building'));
      const offObstacle = bus.on('base:selectObstacle', () => events.push('obstacle'));
      const pointer = basePointer({ x: 608, y: 608 });
      try {
        if (producer === 'building-tap') {
          proto.beginBuildingPress.call(g.scene, g.carried as unknown as Record<string, unknown>, pointer as unknown as Record<string, unknown>);
          g.handlers.get('pointerdown')!(pointer);
          g.handlers.get('pointerup')!({ ...pointer, isDown: false, primaryDown: false });
        } else if (producer === 'obstacle-tap') {
          const obstacleScene = { ...g.scene, obstaclePress: { id: 'oak', pointerId: 1, x: 608, y: 608 }, pointerOwnerId: 1 };
          proto.commitObstaclePress.call(obstacleScene, 'oak', pointer as unknown as Record<string, unknown>);
        } else proto.focusObject.call(g.scene, 'building', 'barracks');
        expect(h.pending).toHaveLength(1); expect(events).toEqual([]);
        expect(useApp.getState().selectedBuildingId).toBeNull(); expect(useApp.getState().selectedObstacleId).toBeNull();
        expect(g.scene.showSelection).not.toHaveBeenCalled(); expect(g.camera.centerOn).not.toHaveBeenCalled();
        // Phaser pools pointers: confirmation must use the validated target ID,
        // not the coordinates or identity currently in that pooled slot.
        pointer.x = 9999; pointer.y = 9999; pointer.identifier = 42;
        if (change === 'wallet') useApp.getState().setAuth('different-wallet');
        if (change === 'target-removed') useApp.setState({ base: { ...storeBase(null), obstacles: [] } as never });
        expect(h.pending[0]?.proceed()).toBe(change === 'confirm');
        expect(h.pending[0]?.proceed()).toBe(false);
        if (change === 'confirm') {
          expect(events).toEqual(producer === 'building-tap' ? ['building'] : producer === 'focus' ? ['obstacle', 'building'] : ['building', 'obstacle']);
          expect(g.scene.showSelection).toHaveBeenCalledTimes(1);
          if (producer === 'obstacle-tap') expect(useApp.getState().selectedObstacleId).toBe('oak');
          else expect(useApp.getState().selectedBuildingId).toBe('barracks');
          expect(g.camera.centerOn).toHaveBeenCalledTimes(producer === 'focus' ? 1 : 0);
        } else {
          expect(events).toEqual([]); expect(g.scene.showSelection).not.toHaveBeenCalled();
          expect(g.camera.centerOn).not.toHaveBeenCalled();
        }
      } finally { offBuilding(); offObstacle(); g.scene.unsub.forEach(off => off()); h.finish(); }
    });
  }
  it.each(['confirm', 'wallet', 'target-removed'] as const)('the actual drag release holds the transport effect: %s', async change => {
    const proto = await scenePrototype(); const h = hold(); const g = gestureHarness(proto); const moves: unknown[] = [];
    const off = bus.on('base:move', move => moves.push(move));
    try {
      liftCarried(g.scene, g.handlers, g.carried, 'mouse');
      g.handlers.get('pointerup')!(basePointer({ x: 608, y: 736, primaryDown: false, isDown: false }));
      expect(h.pending).toHaveLength(1); expect(moves).toEqual([]);
      if (change === 'wallet') useApp.getState().setAuth('different-wallet');
      if (change === 'target-removed') useApp.setState({ base: storeBase(null) });
      expect(h.pending[0]?.proceed()).toBe(change === 'confirm'); expect(h.pending[0]?.proceed()).toBe(false);
      expect(moves).toHaveLength(change === 'confirm' ? 1 : 0);
    } finally { off(); g.scene.unsub.forEach(off => off()); h.finish(); }
  });
  it.each(['tap', 'pan', 'pinch'] as const)('the real scene emits emptyTap only for an owned empty %s', async gesture => {
    const proto = await scenePrototype(); const { scene, handlers } = cameraHarness(proto);
    scene.obstaclePress = null; scene.wallPaint = null; scene.pointerContacts.clear(); scene.pointerOwnerId = null;
    const events: unknown[] = []; const off = bus.on('base:emptyTap', event => events.push(event));
    proto.setupCameraInput.call(scene);
    const down = basePointer({ x: 10, y: 10 });
    try {
      handlers.get('pointerdown')!(down);
      if (gesture === 'pan') handlers.get('pointermove')!({ ...down, x: 80, getDistance: () => 70 });
      if (gesture === 'pinch') proto.beginMultiPointerGesture.call(scene);
      handlers.get('pointerup')!({ ...down, x: gesture === 'pan' ? 80 : 10, isDown: false, primaryDown: false });
      expect(events).toHaveLength(gesture === 'tap' ? 1 : 0);
      expect(scene.emptyTap.end(1, 10, 10, true)).toBe(false);
    } finally { off(); scene.unsub.forEach(off => off()); }
  });
  it('a scene sleep/wake invalidates a retained focus command even when the UI panel survives', async () => {
    const proto = await scenePrototype(); const h = hold(); const g = gestureHarness(proto);
    const listeners = new Map<string, () => void>();
    Object.assign(g.scene, { events: { on: (event: string, callback: () => void) => { listeners.set(event, callback); },
      off: vi.fn() }, sys: { isActive: () => true } });
    try {
      proto.focusObject.call(g.scene, 'building', 'barracks');
      expect(h.pending).toHaveLength(1); expect(g.camera.centerOn).not.toHaveBeenCalled();
      expect(listeners.has('sleep')).toBe(true);
      listeners.get('sleep')!();
      expect(h.pending[0]?.proceed()).toBe(false); expect(g.camera.centerOn).not.toHaveBeenCalled();
    } finally { g.scene.unsub.forEach(off => off()); h.finish(); }
  });
  it.each(['confirm', 'wallet', 'target-removed'] as const)('the actual wall-line release holds its batch move: %s', async change => {
    const proto = await scenePrototype(); const h = hold(); const g = gestureHarness(proto); const moves: unknown[] = [];
    Object.assign(g.scene, { wallSpotFreeIgnoring: () => true });
    const off = bus.on('base:moveLine', move => moves.push(move));
    try {
      liftCarried(g.scene, g.handlers, g.carried, 'mouse');
      expect(g.scene.drag).not.toBeNull();
      g.scene.drag!['line'] = [{ id: 'lab', sprite: g.other, origTx: 9, origTy: 9 }];
      g.handlers.get('pointerup')!(basePointer({ x: 608, y: 736, primaryDown: false, isDown: false }));
      expect(h.pending).toHaveLength(1); expect(moves).toEqual([]);
      if (change === 'wallet') useApp.getState().setAuth('different-wallet');
      if (change === 'target-removed') useApp.setState({ base: storeBase(null) });
      expect(h.pending[0]?.proceed()).toBe(change === 'confirm'); expect(h.pending[0]?.proceed()).toBe(false);
      expect(moves).toHaveLength(change === 'confirm' ? 1 : 0);
    } finally { off(); g.scene.unsub.forEach(off => off()); h.finish(); }
  });

});
