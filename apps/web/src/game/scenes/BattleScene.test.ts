import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type Phaser from 'phaser';
import {
  HERO_COMBAT, v2BuildingFallbackFrameKey, WARE_WORLD_PRESENTATION, wareBuildingStateAliasKey,
  structureDepth, WORLD_DEPTH,
} from '@shardkeep/shared';
import { describe, expect, it, vi } from 'vitest';
import { advanceCombatEffects, combatEffectCount, combatEffectPool } from '../v2/effects';
import { v2BldDrawScale } from '../v2/clips';
import { footprintOf, troopMaxHp } from '../fx/stats';
import * as atlasLoader from '../world/atlasLoader';
import { SceneGround } from '../world/sceneGround';
import * as audio from '../../lib/audio';
import { bus } from '../../lib/events';
import frozenRaid from '../../ui/__fixtures__/stage100-frozen-raid.json';
import { parseMarketArtMetadata } from '../world/marketArt';
import { BERTH_UNPRESENTED_KEY, parseAdvancedFleetMetadata, selectFrozenBerths, type BerthFactsSelection } from '../world/advancedFleetArt';
import { parseStarterFleetMetadata } from '../world/fleetArt';

// Playback tests own no GPU/DOM. Exercise scene context forwarding here while
// the dedicated fantasyGround suite tests texture and request ownership.
const terrain = vi.hoisted(() => ({ set: vi.fn(), destroy: vi.fn() }));
vi.mock('../world/fantasyGround', () => ({ FantasyGround: class {
  set = terrain.set;
  styleDecor = vi.fn();
  setCoverage = vi.fn();
  destroy = terrain.destroy;
} }));
vi.mock('../world/sceneVisualGate', () => ({ SceneVisualGate: class {
  isReady = true; ready = () => Promise.resolve(); loading = vi.fn(); update = vi.fn(); destroy = vi.fn();
} }));

// BattleScene is a Phaser class, but play() only needs the small seam below.
// Mocking the base class keeps this lifecycle regression deterministic in Node.
vi.mock('phaser', () => ({
  default: {
    Scene: class {},
    Core: { Events: { RESUME: 'resume', BLUR: 'blur', HIDDEN: 'hidden' } },
    Scenes: { Events: { SHUTDOWN: 'shutdown' } },
    Scale: { Events: { RESIZE: 'resize' } },
    Math: {
      Clamp: (n: number, min: number, max: number) => Math.max(min, Math.min(max, n)),
      Distance: { Between: (x1: number, y1: number, x2: number, y2: number) => Math.hypot(x2 - x1, y2 - y1) },
    },
  },
}));

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const bowmanCompactClips = (): Record<string, {
  frames: number; rows: number; cellW: number; cellH: number;
}> => Object.fromEntries(
  ['walk', 'idle', 'draw', 'loose', 'spawn', 'hit', 'death'].map((state) => [
    `v2_trp_bowman_t1_${state}`,
    { frames: 2, rows: 8, cellW: 96, cellH: 96 },
  ]),
);

describe('battlefield ground presentation', () => {
  it.each([false, true])('waits to schedule unseen playback while preserving open-server time (live: %s)', async (fightOpen) => {
    const { BattleScene } = await import('./BattleScene');
    const prototype = BattleScene.prototype as unknown as { play: (...args: unknown[]) => Promise<void> | void };
    const original = prototype.play;
    const started = vi.spyOn(prototype, 'play').mockImplementation(() => undefined);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const ready = deferred();
    const scene = { visualGate: { isReady: false, ready: () => ready.promise }, playRequestGeneration: 0,
      scene: { isActive: () => true } };
    const events: unknown[] = [];
    try {
      const pending = original.call(scene, events, 10, 9, false, false, fightOpen);
      expect(started).not.toHaveBeenCalled();
      now.mockReturnValue(2000);
      scene.visualGate.isReady = true; ready.resolve(); await pending;
      expect(started).toHaveBeenCalledExactlyOnceWith(events, fightOpen ? 20 : 10, 9, false, false, fightOpen, undefined);
    } finally { started.mockRestore(); now.mockRestore(); }
  });

  it('drops a stale playback request when scene readiness settles after its replacement', async () => {
    const { BattleScene } = await import('./BattleScene');
    const prototype = BattleScene.prototype as unknown as { play: (...args: unknown[]) => Promise<void> | void };
    const original = prototype.play;
    const started = vi.spyOn(prototype, 'play').mockImplementation(() => undefined);
    const ready = deferred();
    const scene = { visualGate: { isReady: false, ready: () => ready.promise }, playRequestGeneration: 0,
      scene: { isActive: () => true } };
    try {
      const pending = original.call(scene, [], 0);
      scene.playRequestGeneration++;
      ready.resolve(); await pending;
      expect(started).not.toHaveBeenCalled();
    } finally { started.mockRestore(); }
  });

  it('draws a snapshot obstacle from the kit sheet once the revision-5 ground is ready, else the frozen dec_ master (E-11)', async () => {
    // WHY: the attack/scout field must "look like the actual base" (owner
    // 2026-08-15). BaseScene re-keys every server obstacle row to the kit's
    // obstacleSprites on revision-5 ground; a battle that kept dec_pine_1 showed
    // the raider a different tree than the defender sees at home and on the deed.
    const { BattleScene } = await import('./BattleScene');
    const proto = BattleScene.prototype as unknown as {
      styleObstacle: (sprite: unknown, row: { spriteKey: string; tx: number; ty: number }) => void;
      restyleObstacles: () => void;
    };
    const T = 64;
    const stubSprite = (frameHeight: number) => ({
      texture: '', frame: '' as string | number, originX: 0, originY: 0, scale: 1, x: 0, y: 0, depth: 0,
      get displayHeight() { return frameHeight * this.scale; },
      setTexture(key: string, frame: string | number) { this.texture = key; this.frame = frame; return this; },
      setOrigin(x: number, y: number) { this.originX = x; this.originY = y; return this; },
      setScale(n: number) { this.scale = n; return this; },
      setPosition(x: number, y: number) { this.x = x; this.y = y; return this; },
      setDepth(d: number) { this.depth = d; return this; },
    });
    const kit = { key: 'realm-kit-1-abc', frame: 0, origin: [0.5, 1] as [number, number], scale: 2 };
    let ready = false;
    const ground = { obstacleSprite: vi.fn((spriteKey: string) => ready && spriteKey === 'tree_old' ? kit : undefined) };
    const oak = stubSprite(48), bush = stubSprite(20);
    const rows = { oak: { spriteKey: 'tree_old', tx: 8, ty: 8 }, bush: { spriteKey: 'bush', tx: 10, ty: 10 } };
    const scene = {
      fantasyGround: ground, styleObstacle: proto.styleObstacle,
      meta: { dec_tree_old: { footprint: [2, 2], anchor: [0.5, 1] }, dec_bush: { anchor: [0.5, 1] } },
      obstacleDecor: [{ sprite: oak, row: rows.oak }, { sprite: bush, row: rows.bush }],
    };
    // Kit not ready yet (create() runs before the ground swaps in): both rows keep the dec_ master.
    proto.styleObstacle.call(scene, oak, rows.oak);
    proto.styleObstacle.call(scene, bush, rows.bush);
    expect(ground.obstacleSprite).toHaveBeenCalledWith('tree_old', 'intact', 8, 8); // frozen decor: never 'clearing'; the row's tile seats a kit prop's own still
    expect([oak.texture, oak.frame, oak.scale]).toEqual(['dec', 'dec_tree_old', 1]);
    expect([oak.x, oak.y]).toEqual([(8 + 1) * T, (8 + 2) * T]); // 2×2 footprint from dec_ meta, bottom on the south edge
    expect(oak.depth).toBe(structureDepth('building', 10 * T));
    // The kit ground became ready: the mapped row re-keys to the sheet's still at
    // its bottom-centre seat ×2, the unmapped row keeps its master. Same seat.
    ready = true;
    proto.restyleObstacles.call(scene);
    expect([oak.texture, oak.frame, oak.originX, oak.originY, oak.scale]).toEqual([kit.key, 0, 0.5, 1, 2]);
    expect([oak.x, oak.y, oak.depth]).toEqual([(8 + 1) * T, (8 + 2) * T, structureDepth('building', 10 * T)]);
    expect([bush.texture, bush.frame, bush.scale]).toEqual(['dec', 'dec_bush', 1]);
    expect([bush.x, bush.y]).toEqual([(10 + 0.5) * T, (10 + 1) * T]);
  });

  it('keeps the read-only scout base on continuous unboxed grass', () => {
    const source = readFileSync(new URL('./BattleScene.ts', import.meta.url), 'utf8');
    const start = source.indexOf('// Read-only scout previews share');
    const end = source.indexOf('// The owner pack', start);
    const scoutGround = source.slice(start, end);

    // WHY: scout is a view of the same base, not a planning/deploy mode. A
    // rectangular wash reintroduced the square plot border removed from home.
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(scoutGround).not.toContain('fillRect');
    expect(scoutGround).not.toContain('strokeRect');
  });
});

describe('replay position timing', () => {
  it('never downgrades a >100 actor endpoint into a multi-second visual freeze', async () => {
    // WHY: visual population must not change locomotion cadence on mobile.
    const { positionPlayback } = await import('./BattleScene');
    const army = Array.from({ length: 101 }, (_, id) => (
      { e: 'deploy', t: 0, id, troop: 'bowman', x: 0, y: 0 }
    ));
    const endpoint = { e: 'pos', t: 30, id: 7, x: 300, y: 0 };
    expect(positionPlayback([...army, endpoint], 0).get(endpoint)).toEqual({
      startTick: 25,
      durationMs: 500,
    });
  });

  it('resumes an in-flight segment immediately from a replacement tick', async () => {
    const { positionPlayback } = await import('./BattleScene');
    const army = Array.from({ length: 101 }, (_, id) => (
      { e: 'deploy', t: 0, id, troop: 'bowman', x: 0, y: 0 }
    ));
    const prior = { e: 'pos', t: 30, id: 7, x: 300, y: 0 };
    const endpoint = { e: 'pos', t: 60, id: 7, x: 600, y: 0 };
    expect(positionPlayback([...army, prior, endpoint], 45).get(endpoint)).toEqual({
      startTick: 55,
      durationMs: 500,
    });
  });

  it('suppresses only SIM9 legacy cues represented by bounded attack runs', async () => {
    const { attackRunLegacyCueKeys } = await import('./BattleScene');
    const events = [{
      e: 'attackRun', t: 10, id: 7, side: 'attacker', troop: 'mage',
      targetKind: 'building', target: 'keep', ix: 100, iy: 200,
      mode: 'projectile', technique: 'bolt', cycleMs: 600, releaseOffsetMs: 200,
      cycleTicks: 6, releaseOffsetTicks: 2, impactOffsetsTicks: [4],
      cadenceTicks: 6, count: 3,
    }];
    expect([...attackRunLegacyCueKeys(events)]).toEqual([
      '7:10:troopFire', '7:16:troopFire', '7:22:troopFire',
    ]);
  });

  it('does not smear a long attack pause into slow-motion movement', async () => {
    const { positionPlayback } = await import('./BattleScene');
    const deploy = { e: 'deploy', t: 0, id: 7, troop: 'bowman', x: 0, y: 0 };
    const prior = { e: 'pos', t: 5, id: 7, x: 50, y: 0 };
    const endpoint = { e: 'pos', t: 100, id: 7, x: 100, y: 0 };
    expect(positionPlayback([deploy, prior, endpoint], 0).get(endpoint)).toEqual({
      startTick: 95,
      durationMs: 500,
    });
  });

  it('folds a same-tick deploy keyframe into the following segment', async () => {
    const { positionPlayback } = await import('./BattleScene');
    const deploy = { e: 'deploy', t: 0, id: 7, troop: 'bowman', x: 0, y: 0 };
    const immediate = { e: 'pos', t: 0, id: 7, x: 10, y: 0 };
    const endpoint = { e: 'pos', t: 5, id: 7, x: 60, y: 0 };
    expect(positionPlayback([deploy, immediate, endpoint], 0).get(immediate)?.skip).toBe(true);
    expect(positionPlayback([deploy, immediate, endpoint], 0).get(endpoint)).toEqual({
      startTick: 0,
      durationMs: 500,
    });
  });
});

describe('SIM9 attack-run playback', () => {
  it('expands a bounded run on one absolute-time pool entry, not one timer per cycle', async () => {
    const { BattleScene } = await import('./BattleScene');
    const onTroopFire = vi.fn();
    const scene = {
      troops: new Map([[7, { hero: false, fx: { alive: true } }]]),
      onTroopFire,
    };
    const run = (BattleScene.prototype as unknown as {
      onAttackRun: (ev: Record<string, unknown>) => void;
    }).onAttackRun;
    run.call(scene, {
      e: 'attackRun', t: 10, id: 7, side: 'attacker', troop: 'mage',
      targetKind: 'building', target: 'keep', ix: 100, iy: 200,
      mode: 'projectile', technique: 'bolt', cycleMs: 600, releaseOffsetMs: 200,
      cycleTicks: 6, releaseOffsetTicks: 2, impactOffsetsTicks: [4],
      cadenceTicks: 6, count: 3,
    });
    expect(onTroopFire).toHaveBeenCalledTimes(1);
    expect(combatEffectCount(scene as never)).toBe(1);
    combatEffectPool(scene as never).setTimeScale(8);
    advanceCombatEffects(scene as never, 74);
    expect(onTroopFire).toHaveBeenCalledTimes(1);
    advanceCombatEffects(scene as never, 1);
    expect(onTroopFire).toHaveBeenCalledTimes(2);
    combatEffectPool(scene as never).setTimeScale(1);
    advanceCombatEffects(scene as never, 600);
    expect(onTroopFire).toHaveBeenCalledTimes(3);
    advanceCombatEffects(scene as never, 1);
    expect(combatEffectCount(scene as never)).toBe(0);
  });

  it('retains future cycles when live playback replaces a run mid-cycle', async () => {
    const { attackRunCycleStarts, attackRunSuffixFromTick } = await import('@shardkeep/shared');
    const run = {
      e: 'attackRun' as const, t: 10, id: 7, side: 'attacker' as const, troop: 'mage' as const,
      targetKind: 'building' as const, target: 'keep', ix: 100, iy: 200,
      mode: 'projectile' as const, technique: 'bolt' as const,
      cycleMs: 600, releaseOffsetMs: 200, cycleTicks: 6,
      releaseOffsetTicks: 2, impactOffsetsTicks: [4], cadenceTicks: 6, count: 3,
    };
    // Tick 13 is inside the first body. That body/projectile survives; only the
    // removed future starts at 16 and 22 must be recreated.
    expect(attackRunCycleStarts(attackRunSuffixFromTick(run, 13)!)).toEqual([16, 22]);
  });
});

interface FakeTimer {
  remove: () => void;
}

function playbackHarness(firstArt: Promise<void>): Record<string, unknown> {
  return {
    playGeneration: 0,
    renderedPlaybackState: false,
    timeline: [] as FakeTimer[],
    artReady: firstArt,
    artGateDeadlineAt: Number.POSITIVE_INFINITY,
    artDecidedTroops: new Set<string>(),
    artLocked: false,
    apply: vi.fn(),
    marks: [],
    troops: new Map(),
    v2TroopLoads: new Map(),
    v2TroopLocomotionTiers: new Map(),
    burnfields: new Map(),
    burnfieldCastTicks: new Map(),
    clearBurnfields: vi.fn(function (this: {
      burnfields: Map<string, { destroy: () => void }>;
      burnfieldCastTicks: Map<number, number>;
    }) {
      this.burnfields.forEach((fx) => fx.destroy());
      this.burnfields.clear();
      this.burnfieldCastTicks.clear();
    }),
    meleeDrivenIds: new Set<number>(),
    time: {
      now: 0,
      delayedCall: () => ({ remove: vi.fn() }),
    },
    scene: { isActive: () => true },
    releaseDragonDeploymentSfxBank: vi.fn(),
    // D-096: play() returns every playback clock to 1× before scheduling. The
    // hidden-tab catch-up test binds the real method; playback tests stub it.
    resetPauseCatchUp: vi.fn(),
  };
}

describe('late canonical raid-prefix correction (M34)', () => {
  it('rebuilds direct troop health when accepted hero gear changes without respawning summoned brood', async () => {
    const { BattleScene } = await import('./BattleScene');
    const prototype = BattleScene.prototype as unknown as {
      startPlayback: (...args: unknown[]) => void;
      resetPlaybackActors: (actors: ReadonlySet<string | number>) => void;
      applyPlaybackStateRange: (...args: unknown[]) => void;
    };
    const reset = vi.spyOn(prototype, 'resetPlaybackActors').mockImplementation(() => undefined);
    const hydrate = vi.spyOn(prototype, 'applyPlaybackStateRange').mockImplementation(() => undefined);
    const events = [
      { e: 'deploy', t: 0, id: 0, troop: 'hexbarrow', x: 0, y: 0 },
      { e: 'troopSpawn', t: 1, id: 1, troop: 'barrowling', from: 0, level: 20, variant: 0, x: 0, y: 0 },
      { e: 'hit', t: 2, target: 0, dmg: 50 },
    ];
    const scene = { ...playbackHarness(Promise.resolve()), playbackEvents: events,
      artDecidedTroops: new Set(['hexbarrow', 'barrowling']),
      armyHpBps: 0, emitProgress: vi.fn(), buildings: new Map(), time: { now: 1000, delayedCall: () => ({ remove: vi.fn() }) } };
    try {
      prototype.startPlayback.call(scene, events, 5, undefined, true, undefined, 0, frozenRaid.army.heroLoadouts);
      expect(reset).toHaveBeenCalledExactlyOnceWith(new Set([0]));
      expect(hydrate).toHaveBeenCalledOnce();
      expect(scene.armyHpBps).toBe(600);
      reset.mockClear(); hydrate.mockClear();
      prototype.startPlayback.call(scene, events, 5, undefined, true, undefined, 0, frozenRaid.army.heroLoadouts);
      expect(reset).not.toHaveBeenCalled();
      expect(hydrate).not.toHaveBeenCalled();
    } finally { reset.mockRestore(); hydrate.mockRestore(); }
  });

  it('restores an already-collapsed rich building without changing an unrelated controller', async () => {
    const { BattleScene } = await import('./BattleScene');
    const prototype = BattleScene.prototype as unknown as {
      play: (events: Array<Record<string, unknown>>, tick: number, version: number | undefined, prefix: boolean) => void;
      onHit: (event: Record<string, unknown>) => void;
      adoptWareBuildings: (groups?: ReadonlySet<string>, restoring?: ReadonlySet<string>) => boolean;
    };
    const sprite = () => ({
      active: true, destroy: vi.fn(),
      setOrigin: vi.fn().mockReturnThis(), setScale: vi.fn().mockReturnThis(),
      setTexture: vi.fn().mockReturnThis(),
    });
    const building = (destroyed: boolean) => ({
      type: 'archertower', level: 1, destroyed, hp: destroyed ? 0 : 100, maxHp: 100,
      artMode: 'ware', ware: undefined as unknown,
      sprite: sprite(), key: 'bld_archertower_l1', tx: 1, ty: 1, fw: 1, fh: 1,
      damage: { destroy: vi.fn(), update: vi.fn() }, bar: { destroy: vi.fn() },
    });
    const collapsed = building(true);
    const unchanged = building(false);
    const unchangedController = { destroy: vi.fn(), setDamaged: vi.fn() };
    unchanged.ware = unchangedController;
    const original = { id: 'archer', type: 'archertower', level: 1, tx: 1, ty: 1 };
    const old = [{ e: 'hit', t: 1, target: 'archer', dmg: 100 }, { e: 'destroyed', t: 2, id: 'archer' }];
    const scene = {
      ...playbackHarness(Promise.resolve()),
      playbackEvents: old, renderedPlaybackState: true,
      playbackOriginTick: 0, playbackOriginSceneTime: 0, playbackRenderedSceneTime: 500,
      time: { now: 500, delayedCall: () => ({ remove: vi.fn() }) },
      buildings: new Map([['archer', collapsed], ['other', unchanged]]),
      snapshotBuildings: new Map([['archer', original]]), destructibleMaxHp: 200,
      retiredTroopIds: new Map(), artDecidedDefenses: new Set(['archer', 'other']),
      textures: { exists: (group: string) => group === 'ware_archer_1' },
      waremeta: { clips: {
        ware_bld_archer_t1_idle: {
          frames: 2, rows: 1, cellW: 96, cellH: 96,
          anchorPx: [48, 86], fps: 6, unit: 'archer',
        },
      } },
      anim: { unregister: vi.fn() }, v2Ticker: { unregister: vi.fn(), play: vi.fn() },
      keepClock: { remove: vi.fn() }, positionBuildingSprite: vi.fn(),
      clearTransientFx: vi.fn(), retileSurvivingWalls: vi.fn(), emitProgress: vi.fn(),
      adoptWareBuildings: prototype.adoptWareBuildings,
      spawnBuilding: vi.fn(function (this: { buildings: Map<string, ReturnType<typeof building>>; destructibleMaxHp: number }) {
        this.buildings.set('archer', building(false)); this.destructibleMaxHp += 100;
      }),
      apply(event: Record<string, unknown>) { if (event.e === 'hit') prototype.onHit.call(this, event); },
    };
    const ensure = vi.spyOn(atlasLoader, 'ensureV2Atlases');
    try {
      prototype.play.call(scene, [{ e: 'hit', t: 1, target: 'archer', dmg: 30 }], 5, undefined, true);
      const restored = scene.buildings.get('archer')!;
      expect(scene.spawnBuilding).toHaveBeenCalledExactlyOnceWith(original);
      expect(restored).not.toBe(collapsed);
      expect(restored.hp).toBe(70);
      expect(restored.destroyed).toBe(false);
      expect(restored.ware, 'the admitted rich route survives even though collapse destroyed its old controller').toBeDefined();
      expect(restored.artMode).toBe('ware');
      expect(collapsed.sprite.destroy).toHaveBeenCalledOnce();
      expect(scene.destructibleMaxHp).toBe(200);
      expect(scene.buildings.get('other')).toBe(unchanged);
      expect(unchanged.ware).toBe(unchangedController);
      expect(unchangedController.destroy).not.toHaveBeenCalled();
      expect(ensure, 'restoration reuses the existing admitted atlas, never refetches').not.toHaveBeenCalled();
    } finally { ensure.mockRestore(); }
  });

  it('compares actor histories without treating an inserted event as changes to every later actor', async () => {
    const { changedPlaybackActors } = await import('./BattleScene');
    const old = [
      { e: 'deploy', t: 0, id: 1, troop: 'highlander' },
      { e: 'hit', t: 2, target: 'keep', dmg: 30 },
      { e: 'pos', t: 4, id: 1, x: 10, y: 20 },
      { e: 'hit', t: 8, target: 'keep', dmg: 50 },
    ];
    expect(changedPlaybackActors(old, [
      old[0]!, { e: 'deploy', t: 1, id: 2, troop: 'bowman' }, ...old.slice(1),
    ], 5)).toEqual(new Set([2]));
    expect(changedPlaybackActors(old, [
      ...old.slice(0, 1), { e: 'hit', t: 2, target: 'keep', dmg: 20 }, ...old.slice(2),
    ], 5)).toEqual(new Set(['keep']));
    expect(changedPlaybackActors(old, old.map((event) => ({ ...event })), 5)).toEqual(new Set());
    expect(changedPlaybackActors([
      { e: 'chain', t: 1, id: 'tesla', targets: [1, 2], dmg: [10, 20] },
    ], [{ e: 'chain', t: 1, id: 'tesla', targets: [1, 3], dmg: [10, 20] }], 1))
      .toEqual(new Set([1, 2, 3]));
  });

  it('rebuilds changed HP and late troops once, preserving unrelated actors and exact-boundary hits', async () => {
    const { BattleScene } = await import('./BattleScene');
    const prototype = BattleScene.prototype as unknown as {
      play: (events: Array<Record<string, unknown>>, tick: number, version: number | undefined, prefix: boolean) => void;
      onHit: (event: Record<string, unknown>) => void;
    };
    const actor = (hp: number) => ({
      hp, maxHp: 100, troop: 'highlander', hero: false,
      fx: { alive: true, destroy: vi.fn(), cancelPrime: vi.fn(), finishSeek: vi.fn() },
      bar: { destroy: vi.fn() },
    });
    const changedActor = actor(50), unchangedActor = actor(60);
    const old = [
      { e: 'deploy', t: 0, id: 1, troop: 'highlander', x: 0, y: 0 },
      { e: 'deploy', t: 0, id: 2, troop: 'highlander', x: 0, y: 0 },
      { e: 'hit', t: 2, target: 1, dmg: 50 },
      { e: 'hit', t: 5, target: 2, dmg: 40 },
    ];
    const next = [
      ...old.slice(0, 2),
      { e: 'hit', t: 2, target: 1, dmg: 30 },
      { e: 'deploy', t: 4, id: 3, troop: 'highlander', x: 0, y: 0 },
      old[3]!,
    ];
    const applied: unknown[] = [];
    const scene = {
      ...playbackHarness(Promise.resolve()),
      playbackEvents: old,
      renderedPlaybackState: true,
      playbackOriginTick: 0, playbackOriginSceneTime: 0, playbackRenderedSceneTime: 500,
      time: { now: 500, delayedCall: () => ({ remove: vi.fn() }) },
      troops: new Map([[1, changedActor], [2, unchangedActor]]),
      buildings: new Map(), snapshotBuildings: new Map(), retiredTroopIds: new Map(),
      artDecidedTroops: new Set(['highlander']),
      stopLoop: vi.fn(), clearTransientFx: vi.fn(), retileSurvivingWalls: vi.fn(),
      emitProgress: vi.fn(),
      apply(event: Record<string, unknown>) {
        applied.push(event);
        if (event.e === 'deploy') this.troops.set(Number(event.id), actor(100));
        if (event.e === 'hit') prototype.onHit.call(this, event);
      },
    };
    prototype.play.call(scene, next, 5, undefined, true);
    expect(scene.troops.get(1)?.hp, 'corrected hits apply from full HP, never on top of old damage').toBe(70);
    expect(scene.troops.get(2)).toBe(unchangedActor);
    expect(unchangedActor.hp, 'a boundary hit already drawn must not land twice').toBe(60);
    expect(unchangedActor.fx.destroy, 'unaffected animation phase remains owned by the same controller').not.toHaveBeenCalled();
    expect(changedActor.fx.destroy).toHaveBeenCalledOnce();
    expect(scene.troops.get(3)?.hp, 'the late accepted deployment is materialized, not skipped').toBe(100);
    expect(scene.emitProgress).toHaveBeenCalledWith(true);
    const appliedOnce = applied.length;
    prototype.play.call(scene, next, 5, undefined, true);
    expect(applied).toHaveLength(appliedOnce);
    expect(scene.troops.get(1)?.hp).toBe(70);
    expect(unchangedActor.hp).toBe(60);
  });

  it('filters chain damage during a partial actor seek instead of hurting an unchanged target again', async () => {
    const { BattleScene } = await import('./BattleScene');
    const prototype = BattleScene.prototype as unknown as {
      applyPlaybackStateRange: (events: Array<Record<string, unknown>>, start: number, end: number,
        rendered: boolean, accept: (id: string | number) => boolean) => void;
    };
    const apply = vi.fn();
    prototype.applyPlaybackStateRange.call({ apply }, [
      { e: 'chain', t: 1, id: 'tesla', targets: [1, 2], dmg: [10, 20] },
      { e: 'hit', t: 2, target: 2, dmg: 5 },
    ], 0, 5, false, (id) => id === 1);
    expect(apply).toHaveBeenCalledExactlyOnceWith({
      e: 'chain', t: 1, id: 'tesla', targets: [1], dmg: [10],
    });
  });

  it.each([undefined, null, {}])('ignores malformed chain targets during actor comparison and seek (%j)', async (targets) => {
    const { BattleScene, changedPlaybackActors } = await import('./BattleScene');
    const event = { e: 'chain', t: 1, targets, dmg: [] };
    expect(changedPlaybackActors([event], [], 5)).toEqual(new Set());
    const prototype = BattleScene.prototype as unknown as {
      applyPlaybackStateRange: (events: Array<Record<string, unknown>>, start: number, end: number,
        rendered: boolean, accept: (id: string | number) => boolean) => void;
    };
    const apply = vi.fn();
    prototype.applyPlaybackStateRange.call({ apply }, [event], 0, 5, false, () => true);
    expect(apply, 'a malformed replay cue must not crash reconstruction or invent damage').not.toHaveBeenCalled();
  });
});

describe('a hero dropped after ATTACK spawns on the field (tester Suga, build cee3869)', () => {
  // WHY: RaidUI stamps a mid-battle hero at floor(elapsed / TICK_MS) — an
  // INTEGER sim tick — while the scene's rendered clock is fractional and
  // usually a little ahead of it. The tester's build skipped every re-fed
  // event with t < the rendered tick as "already applied" without hydrating
  // a NEW actor, so the hero read IN BATTLE on the bar and never drew. The
  // deploy must materialize whether the hero's tick lands behind, exactly on,
  // or ahead of the rendered clock; the troop already fighting keeps its
  // controller either way.
  const donor = HERO_COMBAT.vex.donor;
  it.each([
    ['behind the rendered clock', 5_730, 0],
    ['exactly on the rendered tick', 5_700, 0],
    ['ahead of the rendered clock', 5_650, 50],
  ])('materializes a hero deploy landing %s', async (_geometry, renderedSceneMs, dueWithinMs) => {
    const { BattleScene } = await import('./BattleScene');
    const prototype = BattleScene.prototype as unknown as {
      play: (events: Array<Record<string, unknown>>, tick: number, version: number | undefined, prefix: boolean) => void;
    };
    const actor = (hero: boolean) => ({
      hp: 100, maxHp: 100, troop: hero ? donor : 'highlander', hero,
      fx: { alive: true, destroy: vi.fn(), cancelPrime: vi.fn(), finishSeek: vi.fn() },
      bar: { destroy: vi.fn() },
    });
    const veteran = actor(false);
    const old = [
      { e: 'deploy', t: 0, id: 0, troop: 'highlander', x: 128, y: 128 },
      { e: 'pos', t: 55, id: 0, x: 640, y: 640 },
      { e: 'hit', t: 80, target: 'keep', dmg: 30 },
    ];
    const heroDeploy = { e: 'deploy', t: 57, id: 1, troop: donor, hero: 'vex', x: 384, y: 384 };
    const next = [...old.slice(0, 2), heroDeploy, { e: 'pos', t: 60, id: 1, x: 512, y: 512 }, old[2]!];
    const applied: Array<Record<string, unknown>> = [];
    const timers: Array<{ delay: number; callback: () => void }> = [];
    const scene = {
      ...playbackHarness(Promise.resolve()),
      playbackEvents: old,
      renderedPlaybackState: true,
      playbackOriginTick: 0, playbackOriginSceneTime: 0, playbackRenderedSceneTime: renderedSceneMs,
      time: {
        now: renderedSceneMs,
        delayedCall: (delay: number, callback: () => void) => {
          timers.push({ delay, callback });
          return { remove: vi.fn() };
        },
      },
      troops: new Map([[0, veteran]]),
      buildings: new Map(), snapshotBuildings: new Map(), retiredTroopIds: new Map(),
      artDecidedTroops: new Set(['highlander']),
      stopLoop: vi.fn(), clearTransientFx: vi.fn(), retileSurvivingWalls: vi.fn(),
      emitProgress: vi.fn(), onPos: vi.fn(),
      apply(event: Record<string, unknown>) {
        applied.push(event);
        if (event.e === 'deploy') this.troops.set(Number(event.id), actor(event.hero !== undefined));
      },
    };
    // RaidUI's re-feed: fromTick = floor(elapsed / TICK_MS) = the hero's own tick.
    prototype.play.call(scene, next, 57, undefined, true);
    timers.filter((timer) => timer.delay <= dueWithinMs).forEach((timer) => timer.callback());
    expect(applied.filter((event) => event.e === 'deploy'), 'the hero is drawn exactly once').toEqual([heroDeploy]);
    expect(scene.troops.get(1)?.hero, 'the field holds a HERO actor for the bar\'s IN BATTLE card').toBe(true);
    expect(scene.troops.get(0), 'the troop already fighting keeps its controller').toBe(veteran);
    expect(veteran.fx.destroy).not.toHaveBeenCalled();
  });
});

interface GesturePointer {
  id: number;
  wasTouch: boolean;
  wasCanceled: boolean;
  button: number;
  primaryDown: boolean;
  isDown: boolean;
  x: number;
  y: number;
  prevPosition: { x: number; y: number };
  getDistance: () => number;
}

async function gestureHarness(camera?: Phaser.Cameras.Scene2D.BaseCamera): Promise<{
  scene: Record<string, unknown>;
  handlers: Map<string, unknown>;
  addEvent: ReturnType<typeof vi.fn>;
  emitTap: ReturnType<typeof vi.fn>;
}> {
  const { BattleScene } = await import('./BattleScene');
  const handlers = new Map<string, unknown>();
  const addEvent = vi.fn(() => ({ remove: vi.fn() }));
  const emitTap = vi.fn();
  const scene: Record<string, unknown> = {
    cameras: { main: camera ?? { zoom: 0.5, scrollX: 0, scrollY: 0, setZoom: vi.fn() } },
    input: {
      pointer1: { isDown: false, x: 0, y: 0 },
      pointer2: { isDown: false, x: 0, y: 0 },
      addPointer: vi.fn(),
      on: (event: string, handler: unknown) => { handlers.set(event, handler); },
    },
    time: { addEvent },
    game: { events: {
      on: (event: string, handler: unknown) => handlers.set(`game:${event}`, handler), off: vi.fn(),
    } },
    scale: { on: vi.fn(), off: vi.fn() },
    events: { once: vi.fn() },
    unsub: [] as Array<() => void>,
    zoomMin: 0.14,
    zoomMax: 1.2,
    deployEnabled: true,
    holdFired: false,
    gesture: null,
    stopHoldDeploy: vi.fn(),
    startSprayDeploy: vi.fn(),
    drawHover: vi.fn(),
    clearHover: vi.fn(),
    emitTap,
    setZoom: vi.fn(),
    fitCamera: vi.fn(),
    applyInsets: vi.fn(),
    syncCameraBounds: vi.fn(),
    userMovedCamera: false,
  };
  const setup = (BattleScene.prototype as unknown as {
    setupCameraInput: (this: Record<string, unknown>) => void;
  }).setupCameraInput;
  setup.call(scene);
  return { scene, handlers, addEvent, emitTap };
}

const pointer = (overrides: Partial<GesturePointer> = {}): GesturePointer => ({
  id: 1,
  wasTouch: false,
  wasCanceled: false,
  button: 0,
  primaryDown: true,
  isDown: true,
  x: 120,
  y: 140,
  prevPosition: { x: 120, y: 140 },
  getDistance: () => 0,
  ...overrides,
});

describe('BattleScene late safe-area measurements', () => {
  it('requests a fresh measurement after subscribing when both initial HUD publications were missed', async () => {
    // Real cold-entry race: React's initial publish and ResizeObserver can both
    // run before Phaser creates the scene. Reusing cached geometry is not safe.
    const old = { top: 82, bottom: 168, left: 0, right: 0 };
    bus.emit('battle:insets', old);
    bus.emit('battle:insets', old);
    const fresh = { top: 104, bottom: 98, left: 9, right: 11 };
    const measure = vi.fn(() => bus.emit('battle:insets', fresh));
    const off = bus.on('battle:insetsRequest', measure);
    let scene: Record<string, unknown> | undefined;
    try {
      ({ scene } = await gestureHarness());
      expect(measure).toHaveBeenCalledOnce();
      expect(scene.applyInsets).toHaveBeenCalledExactlyOnceWith(fresh);
    } finally {
      off();
      (scene?.unsub as Array<() => void> | undefined)?.forEach((dispose) => dispose());
    }
  });

  it('re-bands a player-moved camera without re-fitting and clamps only when needed', async () => {
    const { BattleScene } = await import('./BattleScene');
    const rebandCamera = vi.fn(function (this: Record<string, unknown>) {
      this['zoomMin'] = 0.2;
      this['zoomMax'] = 1;
      return {};
    });
    const setZoom = vi.fn();
    const centerOn = vi.fn();
    const fitCamera = vi.fn();
    const syncCameraBounds = vi.fn();
    const scene = {
      insets: { top: 80, bottom: 180, left: 0, right: 0 },
      userMovedCamera: true,
      zoomMin: 0.1,
      zoomMax: 1.2,
      cameras: { main: { zoom: 0.15, midPoint: { x: 333, y: 444 }, setZoom, centerOn } },
      rebandCamera,
      setZoom,
      fitCamera,
      syncCameraBounds,
    };
    const applyInsets = (BattleScene.prototype as unknown as {
      applyInsets: (this: typeof scene, value: {
        top: number; bottom: number; left?: number; right?: number;
      }) => void;
    }).applyInsets;

    applyInsets.call(scene, { top: 104, bottom: 244, left: 18, right: 12 });

    expect(rebandCamera).toHaveBeenCalledOnce();
    expect(fitCamera).not.toHaveBeenCalled();
    expect(setZoom).toHaveBeenCalledWith(0.2);
    expect(centerOn).toHaveBeenCalledWith(333, 444);
    expect(syncCameraBounds).toHaveBeenCalledWith(0.15);
    expect(scene.insets).toEqual({ top: 104, bottom: 244, left: 18, right: 12 });

    scene.cameras.main.zoom = 0.5;
    applyInsets.call(scene, { top: 110, bottom: 250, left: 18, right: 12 });
    expect(rebandCamera).toHaveBeenCalledTimes(2);
    expect(setZoom).toHaveBeenCalledTimes(1);
    expect(centerOn).toHaveBeenCalledTimes(1);
    expect(syncCameraBounds).toHaveBeenCalledTimes(2);
    expect(syncCameraBounds).toHaveBeenLastCalledWith(0.5);
  });
});

describe('BattleScene deploy gesture ownership', () => {
  it.each([1, 2])('ignores an orphaned global slot %s while the next real canvas contact pans and taps', async orphanSlot => {
    // Use the installed Phaser allocation and Pointer lifecycle. Only its
    // browser feature probes and canvas coordinate conversion are substituted.
    vi.stubGlobal('importScripts', () => undefined);
    const require = createRequire(import.meta.url);
    const RealPointer = require(fileURLToPath(new URL('../../../node_modules/phaser/src/input/Pointer.js', import.meta.url))) as typeof Phaser.Input.Pointer;
    const RealManager = require(fileURLToPath(new URL('../../../node_modules/phaser/src/input/InputManager.js', import.meta.url))) as typeof Phaser.Input.InputManager;
    vi.unstubAllGlobals();
    type NativePointer = Phaser.Input.Pointer & {
      touchstart: (touch: Touch, event: TouchEvent) => void;
      touchmove: (touch: Touch, event: TouchEvent) => void;
    };
    const { scene, handlers, emitTap } = await gestureHarness();
    const canvas = {} as HTMLCanvasElement;
    const manager = Object.assign(Object.create(RealManager.prototype), {
      pointers: [] as Phaser.Input.Pointer[], pointersTotal: 0, config: { inputSmoothFactor: 0 },
      transformPointer: (p: Phaser.Input.Pointer, x: number, y: number) => {
        p.prevPosition.copy(p.position); p.position.set(x, y);
      },
      updateInputPlugins: (_type: number, changed: Phaser.Input.Pointer[]) => {
        for (const p of changed) if (p.downElement === canvas) {
          (handlers.get(p.isDown ? 'pointerdown' : 'pointerup') as (p: Phaser.Input.Pointer) => void)(p);
        }
      },
    }) as Phaser.Input.InputManager & {
      onTouchStart: (event: TouchEvent) => void; onTouchEnd: (event: TouchEvent) => void;
    };
    manager.pointers.push(new RealPointer(manager, 0));
    manager.addPointer(3);
    const input = scene.input as { pointer1: Phaser.Input.Pointer; pointer2: Phaser.Input.Pointer };
    input.pointer1 = manager.pointers[1]!; input.pointer2 = manager.pointers[2]!;
    const camera = (scene.cameras as { main: { zoom: number; scrollX: number; setZoom: ReturnType<typeof vi.fn> } }).main;
    const event = (identifier: number, x: number, y: number) => ({ timeStamp: 100,
      touches: [{ identifier }], changedTouches: [{ identifier, target: canvas, pageX: x, pageY: y }],
    }) as unknown as TouchEvent;
    // A contact from a prior scene remains globally active; this scene never
    // received its down. New touches need not occupy the first Phaser slot.
    const stale = manager.pointers[orphanSlot]! as NativePointer;
    stale.touchstart({ identifier: 99, target: {}, pageX: 50, pageY: 50 } as unknown as Touch, event(99, 50, 50));
    try {
      manager.onTouchStart(event(101, 120, 140));
      const active = manager.activePointer as NativePointer;
      expect(active.id).toBe(orphanSlot === 1 ? 2 : 1);
      expect(scene.gesture).toMatchObject({ mode: 'pending' });
      active.touchmove({ identifier: 101, target: canvas, pageX: 180, pageY: 140 } as unknown as Touch, event(101, 180, 140));
      (handlers.get('pointermove') as (p: Phaser.Input.Pointer) => void)(active);
      active.touchmove({ identifier: 101, target: canvas, pageX: 220, pageY: 140 } as unknown as Touch, event(101, 220, 140));
      (handlers.get('pointermove') as (p: Phaser.Input.Pointer) => void)(active);
      expect(camera.scrollX).toBeLessThan(0);
      expect(camera.setZoom).not.toHaveBeenCalled();
      manager.onTouchEnd({ ...event(101, 220, 140), touches: [] } as unknown as TouchEvent);
      expect(emitTap).not.toHaveBeenCalled();
      manager.onTouchStart(event(102, 120, 140));
      manager.onTouchEnd({ ...event(102, 120, 140), touches: [] } as unknown as TouchEvent);
      expect(emitTap).toHaveBeenCalledOnce();
    } finally { (scene.unsub as Array<() => void>).forEach(dispose => dispose()); }
  });

  it('treats pinch, wheel, and zoom pills as player camera movement until FIT resets it', async () => {
    const { scene, handlers } = await gestureHarness();
    const down = handlers.get('pointerdown') as (p: GesturePointer) => void;
    const move = handlers.get('pointermove') as (p: GesturePointer) => void;
    const wheel = handlers.get('wheel') as (
      p: unknown, over: unknown, dx: number, dy: number,
    ) => void;
    scene['pinch'] = { onMove: () => true, onUp: vi.fn(), active: () => true };
    // A pinch belongs to two actual downs in this scene, not global slots.
    down(pointer({ id: 3, wasTouch: true }));
    down(pointer({ id: 5, wasTouch: true, x: 200 }));
    move(pointer({ id: 5, wasTouch: true, x: 220 }));
    expect(scene['userMovedCamera']).toBe(true);

    scene['userMovedCamera'] = false;
    wheel(null, null, 0, -1);
    expect(scene['userMovedCamera']).toBe(true);

    scene['userMovedCamera'] = false;
    bus.emit('battle:camera', { op: 'in' });
    expect(scene['userMovedCamera']).toBe(true);

    bus.emit('battle:camera', { op: 'fit' });
    expect(scene['userMovedCamera']).toBe(false);
    expect(scene['fitCamera']).toHaveBeenCalledOnce();
    (scene['unsub'] as Array<() => void>).forEach((off) => off());
  });

  it('recovers from a missing native touchend using the next event’s complete live contact list', async () => {
    const { scene, handlers, emitTap } = await gestureHarness();
    const down = handlers.get('pointerdown') as (p: GesturePointer) => void;
    const move = handlers.get('pointermove') as (p: GesturePointer) => void;
    const up = handlers.get('pointerup') as (p: GesturePointer) => void;
    const contact = (id: number, x: number, live: number[]) => ({
      ...pointer({ id, x, wasTouch: true }), identifier: id,
      event: { touches: live.map(identifier => ({ identifier })) } as unknown as TouchEvent,
    });
    try {
      down(contact(3, 120, [3]));
      // No release reaches Phaser; the old object remains isDown=true.
      down(contact(5, 120, [5]));
      expect(scene.gesture).toMatchObject({ mode: 'pending' });
      move(contact(5, 180, [5]));
      expect((scene.cameras as { main: { scrollX: number } }).main.scrollX).toBeLessThan(0);
      expect(scene.syncCameraBounds).not.toHaveBeenCalled();
      up({ ...contact(5, 180, []), isDown: false });
      expect(emitTap).not.toHaveBeenCalled();
      down(contact(6, 120, [6])); up({ ...contact(6, 120, []), isDown: false });
      expect(emitTap).toHaveBeenCalledOnce();
    } finally { (scene.unsub as Array<() => void>).forEach(dispose => dispose()); }
  });

  it.each(['gameout', 'game:blur', 'game:hidden'])('cancels owned contacts on %s and requires a fresh down before deploying', async event => {
    const { scene, handlers, emitTap } = await gestureHarness();
    const down = handlers.get('pointerdown') as (p: GesturePointer) => void;
    const move = handlers.get('pointermove') as (p: GesturePointer) => void;
    const up = handlers.get('pointerup') as (p: GesturePointer) => void;
    try {
      down(pointer({ id: 3, wasTouch: true }));
      (handlers.get(event) as () => void)();
      move(pointer({ id: 3, wasTouch: true, x: 180 }));
      up(pointer({ id: 3, wasTouch: true, isDown: false }));
      expect(scene.gesture).toBeNull(); expect(emitTap).not.toHaveBeenCalled();
      down(pointer({ id: 5, wasTouch: true }));
      // A late release from the abandoned contact cannot cancel the new one.
      up(pointer({ id: 3, wasTouch: true, isDown: false }));
      expect(scene.gesture).toMatchObject({ mode: 'pending' });
      up(pointer({ id: 5, wasTouch: true, isDown: false }));
      expect(emitTap).toHaveBeenCalledOnce();
    } finally { (scene.unsub as Array<() => void>).forEach(dispose => dispose()); }
  });

  it('pinches using two scene-owned higher slots and never deploys either released finger', async () => {
    const { scene, handlers, emitTap } = await gestureHarness();
    const down = handlers.get('pointerdown') as (p: GesturePointer) => void;
    const move = handlers.get('pointermove') as (p: GesturePointer) => void;
    const up = handlers.get('pointerup') as (p: GesturePointer) => void;
    const camera = (scene.cameras as { main: { setZoom: ReturnType<typeof vi.fn> } }).main;
    try {
      down(pointer({ id: 3, wasTouch: true, x: 100 }));
      down(pointer({ id: 5, wasTouch: true, x: 200 }));
      move(pointer({ id: 5, wasTouch: true, x: 200 }));
      move(pointer({ id: 5, wasTouch: true, x: 250 }));
      expect(camera.setZoom).toHaveBeenCalledExactlyOnceWith(0.75);
      up(pointer({ id: 5, wasTouch: true, x: 250, isDown: false }));
      up(pointer({ id: 3, wasTouch: true, x: 100, isDown: false }));
      expect(emitTap).not.toHaveBeenCalled();
      down(pointer({ id: 5, wasTouch: true })); up(pointer({ id: 5, wasTouch: true, isDown: false }));
      expect(emitTap).toHaveBeenCalledOnce();
    } finally { (scene.unsub as Array<() => void>).forEach(dispose => dispose()); }
  });

  it('reuses the existing game-global second pointer on each raid entry', async () => {
    const { scene } = await gestureHarness();
    expect((scene.input as { addPointer: ReturnType<typeof vi.fn> }).addPointer).not.toHaveBeenCalled();
    (scene.unsub as Array<() => void>).forEach(dispose => dispose());
  });

  it('rejects secondary mouse starts without disturbing the primary-only timer path', async () => {
    const { scene, handlers, addEvent } = await gestureHarness();
    const down = handlers.get('pointerdown') as (p: GesturePointer) => void;

    down(pointer({ button: 2, primaryDown: false }));

    expect(addEvent).not.toHaveBeenCalled();
    expect(scene['gesture']).toBeNull();
    expect(scene['stopHoldDeploy']).not.toHaveBeenCalled();
    (scene['unsub'] as Array<() => void>).forEach((off) => off());
  });

  it.each([
    ['desktop primary mouse', pointer()],
    ['touch', pointer({ wasTouch: true })],
  ])('accepts %s and releases it as exactly one tap', async (_label, p) => {
    const { scene, handlers, addEvent, emitTap } = await gestureHarness();
    const down = handlers.get('pointerdown') as (event: GesturePointer) => void;
    const up = handlers.get('pointerup') as (event: GesturePointer) => void;

    down(p);
    expect(addEvent).toHaveBeenCalledOnce();
    expect(scene['gesture']).toEqual({ mode: 'pending', x: 120, y: 140 });

    up({ ...p, isDown: false, primaryDown: false });
    expect(emitTap).toHaveBeenCalledOnce();
    expect(scene['gesture']).toBeNull();
    (scene['unsub'] as Array<() => void>).forEach((off) => off());
  });

  it('does not let a secondary release finish an in-flight primary gesture', async () => {
    const { scene, handlers, emitTap } = await gestureHarness();
    const down = handlers.get('pointerdown') as (p: GesturePointer) => void;
    const up = handlers.get('pointerup') as (p: GesturePointer) => void;
    const upOutside = handlers.get('pointerupoutside') as (p: GesturePointer) => void;

    down(pointer());
    up(pointer({ button: 2, primaryDown: true }));
    upOutside(pointer({ button: 2, primaryDown: true }));

    expect(scene['gesture']).toEqual({ mode: 'pending', x: 120, y: 140 });
    expect(emitTap).not.toHaveBeenCalled();
    (scene['unsub'] as Array<() => void>).forEach((off) => off());
  });

  it.each(['pointerup', 'pointerupoutside'] as const)(
    'treats Phaser TOUCH_CANCEL delivered through %s as cleanup, never a deploy',
    async (event) => {
      const { scene, handlers, emitTap } = await gestureHarness();
      const down = handlers.get('pointerdown') as (p: GesturePointer) => void;
      const cancelled = handlers.get(event) as (p: GesturePointer) => void;

      down(pointer({ wasTouch: true }));
      cancelled(pointer({
        wasTouch: true,
        wasCanceled: true,
        primaryDown: false,
        isDown: false,
      }));

      expect(scene['gesture']).toBeNull();
      expect(scene['clearHover']).toHaveBeenCalled();
      expect(scene['stopHoldDeploy']).toHaveBeenCalled();
      expect(emitTap).not.toHaveBeenCalled();
      (scene['unsub'] as Array<() => void>).forEach((off) => off());
    },
  );
});

describe('BattleScene undersized-field centring', () => {
  it.each([
    ['390×844 portrait', 390, 844, 0.14],
    ['915×311 Seeker landscape', 915, 311, 0.14],
  ] as const)('centres the whole field in %s instead of pinning it left/top', async (
    _name, width, height, zoom,
  ) => {
    const { centeredBattleBounds } = await import('./BattleScene');
    const origin = -256;
    const field = 2_432;
    const bounds = centeredBattleBounds(origin, field, width, height, zoom);
    const fieldCentre = origin + field / 2;
    expect(bounds.x + bounds.width / 2).toBeCloseTo(fieldCentre);
    expect(bounds.y + bounds.height / 2).toBeCloseTo(fieldCentre);
    expect(bounds.width).toBeGreaterThanOrEqual(width / zoom);
    expect(bounds.height).toBeGreaterThanOrEqual(height / zoom);
  });

  it('retains the exact gameplay field bounds when the zoomed viewport fits inside', async () => {
    const { centeredBattleBounds } = await import('./BattleScene');
    expect(centeredBattleBounds(-256, 2_432, 915, 311, 0.6)).toEqual({
      x: -256, y: -256, width: 2_432, height: 2_432,
    });
  });

  it('reserves existing actor overhang on every render edge without widening gameplay space', async () => {
    const { centeredBattleRenderBounds } = await import('./BattleScene');
    expect(centeredBattleRenderBounds(-256, 2_432, 915, 311, 0.6, 128)).toEqual({
      x: -384, y: -384, width: 2_688, height: 2_688,
    });
  });
});

// The installed BaseCamera imports no browser device probe. Use its real
// bounds clamp and transform matrices while the rest of this file mocks Scene.
const RealBaseCamera = createRequire(import.meta.url)(fileURLToPath(new URL(
  '../../../node_modules/phaser/src/cameras/2d/BaseCamera.js', import.meta.url,
))) as typeof Phaser.Cameras.Scene2D.BaseCamera;
function projectWithCamera(cam: Phaser.Cameras.Scene2D.BaseCamera, x: number, y: number): { x: number; y: number } {
  // Camera.preRender's unrotated matrix setup, using actual Phaser matrices.
  cam.matrixCombined.applyITRS(cam.width / 2, cam.height / 2, 0, cam.zoom, cam.zoom);
  cam.matrixCombined.translate(-cam.scrollX - cam.width / 2, -cam.scrollY - cam.height / 2);
  return cam.matrixCombined.transformPoint(x, y);
}

describe('deployment camera reach with real Phaser bounds', () => {
  it.each([
    [412, 892, null],
    [320, 892, null],
    [1280, 400, null],
    [892, 412, { top: 54, bottom: 112, left: 29, right: 87 }],
    [1280, 720, { top: 100, bottom: 200, left: 0, right: 0 }],
  ])('covers the entire %sx%s camera at FIT, minimum zoom and every pan edge', async (width, height, insets) => {
    const { BattleScene, centeredBattleRenderBounds } = await import('./BattleScene');
    const cam = new RealBaseCamera(0, 0, width, height);
    const setCoverage = vi.fn();
    const scene = Object.assign(Object.create(BattleScene.prototype), {
      cameras: { main: cam }, claimMin: 2, claimMax: 28, insets,
      pinch: { setLimits: vi.fn() }, fantasyGround: { setCoverage },
    });
    scene.fitCamera();
    const coverage = setCoverage.mock.lastCall![0] as { x: number; y: number; width: number; height: number };
    const boundsSpy = vi.spyOn(cam, 'setBounds');
    for (const zoom of [scene.zoomMin, cam.zoom, scene.zoomMax]) {
      scene.setZoom(zoom);
      expect(setCoverage.mock.lastCall![0], 'pinching inside the band must reuse the same terrain rectangle').toEqual(coverage);
      const oldBounds = centeredBattleRenderBounds(-256, 2432, width, height, zoom, 128,
        insets ?? { top: 96, bottom: 152, left: 0, right: 0 });
      expect(boundsSpy).toHaveBeenLastCalledWith(oldBounds.x, oldBounds.y, oldBounds.width, oldBounds.height);
      for (const panX of [-100000, 100000]) for (const panY of [-100000, 100000]) {
        cam.scrollX = cam.clampX(panX); cam.scrollY = cam.clampY(panY);
        projectWithCamera(cam, 0, 0);
        const nw = cam.getWorldPoint(0, 0), se = cam.getWorldPoint(width, height);
        // Whole canvas coverage includes the area underneath translucent HUD,
        // where the phone screenshot previously exposed a hard terrain cutoff.
        expect(nw.x).toBeGreaterThanOrEqual(coverage.x - 0.001);
        expect(nw.y).toBeGreaterThanOrEqual(coverage.y - 0.001);
        expect(se.x).toBeLessThanOrEqual(coverage.x + coverage.width + 0.001);
        expect(se.y).toBeLessThanOrEqual(coverage.y + coverage.height + 0.001);
      }
    }
  });

  it.each([[false, 412, 892], [true, 412, 892], [false, 400, 1280], [true, 400, 1280]] as const)(
    'recomputes coverage after rotation without changing camera policy (player moved: %s, %sx%s)', async (userMovedCamera, width, height) => {
    const { BattleScene, centeredBattleRenderBounds } = await import('./BattleScene');
    const cam = new RealBaseCamera(0, 0, width, height);
    const setCoverage = vi.fn();
    const scene = Object.assign(Object.create(BattleScene.prototype), {
      cameras: { main: cam }, claimMin: 2, claimMax: 28, insets: null,
      pinch: { setLimits: vi.fn() }, fantasyGround: { setCoverage }, userMovedCamera,
    });
    scene.fitCamera();
    const portrait = setCoverage.mock.lastCall![0];
    cam.setSize(height, width);
    scene.onResize();
    const landscape = setCoverage.mock.lastCall![0];
    expect(landscape.width).toBeGreaterThan(portrait.width);
    expect(landscape.height).toBeLessThan(portrait.height);
    expect(landscape).toEqual(centeredBattleRenderBounds(-256, 2432, height, width, scene.zoomMin, 128,
      { top: 96, bottom: 152, left: 0, right: 0 }));
    cam.setSize(width, height);
    scene.onResize();
    expect(setCoverage.mock.lastCall![0]).toEqual(portrait);
  });

  it.each([
    [1280, 720, 0.6, 100], [390, 844, 0.6, 104], [915, 311, 0.14, 54],
  ])('can pan legal row -4 below HUD at %sx%s zoom%s', async (width, height, zoom, hudTop) => {
    const { BattleScene, centeredBattleRenderBounds, battleCanvasInputRect } = await import('./BattleScene');
    const cam = new RealBaseCamera(0, 0, width, height).setZoom(zoom);
    const old = centeredBattleRenderBounds(-256, 2432, width, height, zoom, 128);
    cam.setBounds(old.x, old.y, old.width, old.height);
    cam.scrollY = cam.clampY(-10000);
    if (width === 1280) expect(projectWithCamera(cam, 32, -256).y).toBeLessThan(hudTop);
    const scene = Object.assign(Object.create(BattleScene.prototype), {
      cameras: { main: cam }, insets: { top: hudTop, bottom: 72, left: 0, right: 0 },
    });
    scene.syncCameraBounds(zoom);
    cam.scrollY = cam.clampY(-10000);
    const top = projectWithCamera(cam, 32, -256);
    const bottom = projectWithCamera(cam, 96, -192);
    const input = battleCanvasInputRect(width, height, scene.insets);
    expect(top.y).toBeGreaterThanOrEqual(input.top);
    expect(bottom.y).toBeLessThanOrEqual(input.bottom);
    const restored = cam.getWorldPoint(top.x, top.y);
    expect(restored.y).toBeCloseTo(-256, 4); // camera never changes the legal tile
    expect(restored.x).toBeCloseTo(32, 4);
  });

  it.each(['top', 'bottom', 'left', 'right'] as const)('reveals the entire legal %s boundary through the actual camera clamp', async (edge) => {
    const { BattleScene, battleCanvasInputRect } = await import('./BattleScene');
    for (const [width, height, zoom] of [[1280, 720, 0.6], [390, 844, 0.6], [915, 311, 0.14]]) {
      const cam = new RealBaseCamera(0, 0, width!, height!).setZoom(zoom!);
      const insets = height === 311 ? { top: 54, bottom: 112, left: 29, right: 87 }
        : { top: 100, bottom: 200, left: 29, right: 87 };
      const scene = Object.assign(Object.create(BattleScene.prototype), { cameras: { main: cam }, insets });
      scene.syncCameraBounds(cam.zoom);
      const tx = edge === 'left' ? -4 : edge === 'right' ? 33 : 10;
      const ty = edge === 'top' ? -4 : edge === 'bottom' ? 33 : 10;
      cam.centerOn((tx + 0.5) * 64, (ty + 0.5) * 64);
      if (edge === 'top' || edge === 'bottom') cam.scrollY = cam.clampY(edge === 'top' ? -10000 : 10000);
      else cam.scrollX = cam.clampX(edge === 'left' ? -10000 : 10000);
      const topLeft = projectWithCamera(cam, tx * 64, ty * 64);
      const bottomRight = projectWithCamera(cam, (tx + 1) * 64, (ty + 1) * 64);
      const input = battleCanvasInputRect(cam.width, cam.height, insets);
      expect(topLeft.x, `${width}/${edge}/left`).toBeGreaterThanOrEqual(input.left);
      expect(topLeft.y, `${width}/${edge}/top`).toBeGreaterThanOrEqual(input.top);
      expect(bottomRight.x, `${width}/${edge}/right`).toBeLessThanOrEqual(input.right);
      expect(bottomRight.y, `${width}/${edge}/bottom`).toBeLessThanOrEqual(input.bottom);
      const restored = cam.getWorldPoint(topLeft.x, topLeft.y);
      expect(restored.x).toBeCloseTo(tx * 64, 3); expect(restored.y).toBeCloseTo(ty * 64, 3);
    }
  });

  it('preserves a player-panned position while HUD changes and permits further northward panning', async () => {
    const { BattleScene } = await import('./BattleScene');
    const cam = new RealBaseCamera(0, 0, 1280, 720).setZoom(0.6);
    const scene = Object.assign(Object.create(BattleScene.prototype), {
      cameras: { main: cam }, insets: { top: 100, bottom: 100, left: 0, right: 0 },
      userMovedCamera: true, zoomMin: 0.1, zoomMax: 1.2, rebandCamera: vi.fn(), fitCamera: vi.fn(),
    });
    scene.syncCameraBounds(cam.zoom);
    cam.scrollY = cam.clampY(-10000); cam.scrollX = 300;
    const previous = { x: cam.scrollX, y: cam.scrollY };
    scene.applyInsets({ top: 160, bottom: 100 });
    expect(cam.scrollX).toBe(previous.x); expect(cam.scrollY).toBe(previous.y);
    expect(scene.fitCamera).not.toHaveBeenCalled();
    cam.scrollY = cam.clampY(-10000);
    expect(cam.scrollY).toBeLessThan(previous.y);
    expect(projectWithCamera(cam, 32, -256).y).toBeCloseTo(160 + 128 * 0.6, 4);
  });

  it('updates zoom-dependent pan limits through the direct pinch observer without fitting', async () => {
    const { scene } = await gestureHarness();
    const cam = (scene.cameras as { main: { zoom: number; setZoom: (z: number) => void } }).main;
    cam.setZoom = vi.fn((z: number) => { cam.zoom = z; });
    const pinch = scene.pinch as import('../world/pinch').PinchZoom;
    const left = pointer({ x: 100, y: 200 });
    pinch.onMove(left as unknown as Phaser.Input.Pointer, pointer({ x: 200, y: 200 }) as unknown as Phaser.Input.Pointer);
    pinch.onMove(left as unknown as Phaser.Input.Pointer, pointer({ x: 250, y: 200 }) as unknown as Phaser.Input.Pointer);
    expect(scene.syncCameraBounds).toHaveBeenCalledExactlyOnceWith(0.75);
    expect(scene.fitCamera).not.toHaveBeenCalled();
    (scene.unsub as Array<() => void>).forEach(dispose => dispose());
  });
});

describe('BattleScene HUD-owned canvas input', () => {
  it('does not highlight a legal raw tile green when only its corner is exposed', async () => {
    const { BattleScene } = await import('./BattleScene');
    let covered = true;
    const panel = {};
    const canvas = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 320 }),
      ownerDocument: { elementFromPoint: (x: number): unknown => covered && x >= 102 ? panel : canvas },
    };
    const hoverG = {
      clear: vi.fn(), fillStyle: vi.fn(), fillRect: vi.fn(), lineStyle: vi.fn(), strokeRect: vi.fn(),
    };
    const scene = {
      hoverG, game: { canvas }, insets: { top: 80, bottom: 80, left: 0, right: 0 },
      cameras: { main: { width: 390, height: 320, zoom: 1,
        getWorldPoint: () => ({ x: 156, y: 160 }) } },
      isDeployable: () => true,
    };
    const draw = (BattleScene.prototype as unknown as { drawHover(p: { x: number; y: number }): void }).drawHover;
    // The touched corner is on canvas, but the actual spawn centre projects
    // four pixels farther right beneath the pill. Green would promise a drop.
    expect(canvas.ownerDocument.elementFromPoint(100)).toBe(canvas);
    draw.call(scene, { x: 100, y: 160 });
    expect(hoverG.fillStyle).toHaveBeenLastCalledWith(0xc75a2e, 0.35);
    covered = false;
    draw.call(scene, { x: 100, y: 160 });
    expect(hoverG.fillStyle).toHaveBeenLastCalledWith(0x8cb36e, 0.35);
  });

  it.each([[390, 844], [844, 320]])('accepts exposed north ground and pans through wrapped HUD gaps at %s×%s', async (width, height) => {
    const { BattleScene } = await import('./BattleScene');
    const cam = new RealBaseCamera(0, 0, width, height).setZoom(0.6);
    const { scene, handlers, addEvent } = await gestureHarness(cam);
    const world = { x: 14.5 * 64, y: -3.5 * 64 };
    cam.centerOn(world.x, world.y);
    cam.scrollY += (projectWithCamera(cam, world.x, world.y).y - 132) / cam.zoom;
    const screen = projectWithCamera(cam, world.x, world.y);
    expect(screen.y).toBeCloseTo(132);
    const rect = { left: 17, top: 81, width: width * 0.8, height: height * 0.8 };
    let covered: { left: number; top: number; right: number; bottom: number } | null = null;
    const panel = {};
    const canvas = {
      getBoundingClientRect: () => rect,
      ownerDocument: { elementFromPoint: vi.fn((clientX: number, clientY: number): unknown => {
        const x = (clientX - rect.left) * width / rect.width;
        const y = (clientY - rect.top) * height / rect.height;
        return y < 98 || (covered && x >= covered.left && x < covered.right
          && y >= covered.top && y < covered.bottom) ? panel : canvas;
      }) },
    };
    Object.assign(scene, {
      cameras: { main: cam }, insets: { top: 170, bottom: 80, left: 0, right: 0 },
      time: { now: 1000, addEvent }, lastDenyAt: Number.NEGATIVE_INFINITY,
      isDeployable: (_tx: number, ty: number) => ty >= -4,
      createDeployMark: vi.fn(() => { throw new Error('eligibility must not create artwork'); }),
    });
    (scene.game as Record<string, unknown>).canvas = canvas;
    const proto = BattleScene.prototype as unknown as {
      emitTap(p: GesturePointer): void;
      deployPreviewVisible: (...args: unknown[]) => boolean;
    };
    scene.emitTap = proto.emitTap.bind(scene);
    scene.deployPreviewVisible = proto.deployPreviewVisible.bind(scene);
    const taps: Array<{
      tx: number; ty: number; visibleTiles?: string[];
      previewVisible?: (destination: { tx: number; ty: number }, troop: string, hero?: 'vex' | 'theodor') => boolean;
    }> = [];
    const off = bus.on('battle:tap', event => taps.push(event));
    const down = handlers.get('pointerdown') as (p: GesturePointer) => void;
    const up = handlers.get('pointerup') as (p: GesturePointer) => void;
    const move = handlers.get('pointermove') as (p: GesturePointer) => void;
    try {
      // This terrain is below actual HUD content but inside the old full-height
      // layout rectangle. A real camera maps it to the legal north row -4.
      const contact = pointer({ ...screen, wasTouch: true });
      down(contact); up({ ...contact, isDown: false });
      expect(taps).toHaveLength(1);
      expect(taps[0]).toMatchObject({ tx: 14, ty: -4 });
      expect(taps[0]!.visibleTiles).toContain('14,-4');
      expect(taps[0]!.previewVisible?.({ tx: 14, ty: -4 }, 'direwyvern')).toBe(true);
      expect(scene.createDeployMark).not.toHaveBeenCalled();
      expect(canvas.ownerDocument.elementFromPoint).toHaveBeenCalledWith(
        expect.closeTo(rect.left + screen.x * 0.8, 8), expect.closeTo(rect.top + screen.y * 0.8, 8),
      );

      // A final snapped destination must be checked independently of the tap:
      // the neighbouring ground point can be behind a real pill or offscreen.
      const neighborX = screen.x - 64 * cam.zoom;
      covered = { left: neighborX - 5, right: neighborX + 5, top: 120, bottom: 145 };
      expect(taps[0]!.previewVisible?.({ tx: 13, ty: -4 }, 'highlander')).toBe(false);
      expect(taps[0]!.previewVisible?.({ tx: -100, ty: -4 }, 'highlander')).toBe(false);
      covered = null;

      const priorX = cam.scrollX;
      down(contact);
      move({ ...contact, x: contact.x + 40, prevPosition: { x: contact.x, y: contact.y } });
      up({ ...contact, x: contact.x + 40, isDown: false });
      expect(cam.scrollX).toBeCloseTo(priorX - 40 / cam.zoom);
      expect(taps).toHaveLength(1); // a pan never emits a troop order

      // A forwarded start on opaque HUD is neither a deploy nor a scene-owned
      // contact. It cannot turn the next exposed-canvas touch into a pinch.
      addEvent.mockClear();
      down(pointer({ x: screen.x, y: 70, wasTouch: true, id: 9 }));
      expect(addEvent).not.toHaveBeenCalled();
      expect(scene.gesture).toBeNull();
      down(pointer({ ...screen, wasTouch: true, id: 10 }));
      expect(scene.gesture).toMatchObject({ mode: 'pending' });
      up(pointer({ ...screen, wasTouch: true, id: 10, isDown: false }));
      expect(taps).toHaveLength(2);
      down(pointer({ x: -1, y: 132, wasTouch: true, id: 11 }));
      expect(scene.gesture).toBeNull();
      rect.width = Number.POSITIVE_INFINITY;
      expect(taps[0]!.previewVisible?.({ tx: 14, ty: -4 }, 'highlander')).toBe(false);
      rect.width = width * 0.8;
      rect.left = Number.NaN;
      expect(taps[0]!.previewVisible?.({ tx: 14, ty: -4 }, 'highlander')).toBe(false);
    } finally {
      off(); (scene.unsub as Array<() => void>).forEach(dispose => dispose());
    }
  });

  it('keeps pan and zoom available while deployment waits for measured HUD bounds', async () => {
    const { scene, handlers, emitTap } = await gestureHarness();
    scene.insets = null;
    try {
      const down = handlers.get('pointerdown') as (p: GesturePointer) => void;
      const move = handlers.get('pointermove') as (p: GesturePointer) => void;
      const up = handlers.get('pointerup') as (p: GesturePointer) => void;
      down(pointer());
      move(pointer({ x: 190, y: 220 }));
      up(pointer({ x: 190, y: 220, isDown: false }));
      expect((scene.cameras as { main: { scrollX: number } }).main.scrollX).toBe(-140);
      bus.emit('battle:camera', { op: 'in' });
      expect(scene.setZoom).toHaveBeenCalledOnce();
      expect(emitTap).not.toHaveBeenCalled();
    } finally { (scene.unsub as Array<() => void>).forEach(dispose => dispose()); }
  });

  it('cannot emit a deployment until this scene has measured HUD bounds', async () => {
    const { BattleScene } = await import('./BattleScene');
    const taps: unknown[] = [];
    const off = bus.on('battle:tap', event => taps.push(event));
    const scene = {
      cameras: { main: { width: 390, height: 844, zoom: 1, getWorldPoint: (x: number, y: number) => ({ x, y }) } },
      insets: null as null | { top: number; bottom: number; left: number; right: number },
      isDeployable: () => true, time: { now: 0 }, lastDenyAt: Number.NEGATIVE_INFINITY,
    };
    const emit = (BattleScene.prototype as unknown as { emitTap(this: typeof scene, p: { x: number; y: number }): void }).emitTap;
    try {
      emit.call(scene, { x: 160, y: 160 });
      expect(taps, 'unknown chrome cannot mean the whole canvas is safe').toEqual([]);
      scene.insets = { top: 100, bottom: 200, left: 0, right: 0 };
      emit.call(scene, { x: 160, y: 160 });
      expect(taps).toEqual([expect.objectContaining({ tx: 2, ty: 2 })]);
    } finally { off(); }
  });

  it('subtracts all measured React chrome from the input rectangle', async () => {
    const { battleCanvasInputRect } = await import('./BattleScene');
    expect(battleCanvasInputRect(390, 844, { top: 96, bottom: 212, left: 7, right: 11 }))
      .toEqual({ left: 7, top: 96, right: 379, bottom: 632 });
  });

  it('does not arm a deploy gesture under the measured HUD', async () => {
    const { scene, handlers, addEvent } = await gestureHarness();
    (scene.cameras as { main: Record<string, unknown> }).main.width = 390;
    (scene.cameras as { main: Record<string, unknown> }).main.height = 844;
    scene.insets = { top: 100, bottom: 200, left: 0, right: 0 };
    const down = handlers.get('pointerdown') as (p: GesturePointer) => void;
    down(pointer({ y: 60 }));
    expect(scene.gesture).toBeNull();
    expect(addEvent).not.toHaveBeenCalled();
    (scene.unsub as Array<() => void>).forEach((off) => off());
  });

  it.each([
    [390, 844, 'top'], [390, 844, 'bottom'], [390, 844, 'left'], [390, 844, 'right'],
    [844, 320, 'top'], [844, 320, 'bottom'], [844, 320, 'left'], [844, 320, 'right'],
  ] as const)('explains canvas taps in the %s×%s %s HUD band at minimum zoom without deploying', async (width, height, edge) => {
    const { BattleScene } = await import('./BattleScene');
    const { scene, handlers, addEvent } = await gestureHarness();
    const camera = (scene.cameras as { main: Record<string, unknown> }).main;
    Object.assign(camera, { width, height, zoom: scene.zoomMin, getWorldPoint: () => ({ x: 160, y: 160 }) });
    scene.insets = { top: 80, bottom: 100, left: 12, right: 12 };
    scene.time = { now: 1000, addEvent }; scene.lastDenyAt = Number.NEGATIVE_INFINITY;
    scene.isDeployable = () => true;
    scene.emitTap = (BattleScene.prototype as unknown as { emitTap: (p: GesturePointer) => void }).emitTap.bind(scene);
    const down = handlers.get('pointerdown') as (p: GesturePointer) => void;
    const up = handlers.get('pointerup') as (p: GesturePointer) => void;
    const position = { x: edge === 'left' ? 6 : edge === 'right' ? width - 6 : width / 2,
      y: edge === 'top' ? 60 : edge === 'bottom' ? height - 60 : height / 2 };
    const taps: unknown[] = []; const toasts: unknown[] = [];
    const offTap = bus.on('battle:tap', event => taps.push(event));
    const offToast = bus.on('ui:toast', event => toasts.push(event));
    try {
      // Drive the real gesture entry and release. Calling emitTap directly hid
      // the early pointerdown return that swallowed these mobile canvas taps.
      down(pointer({ ...position, wasTouch: true }));
      up(pointer({ ...position, wasTouch: true, isDown: false }));
      expect(scene.gesture).toBeNull(); expect(addEvent).not.toHaveBeenCalled();
      expect(taps).toEqual([]);
      expect(toasts).toEqual([{ msg: 'PAN TO REVEAL THIS TILE' }]);
      down(pointer({ ...position, wasTouch: true }));
      up(pointer({ ...position, wasTouch: true, isDown: false }));
      expect(toasts, 'repeated covered taps cannot flood feedback').toHaveLength(1);
      // A visible tap still follows the same camera conversion and submits once.
      const visible = pointer({ x: width / 2, y: 110, wasTouch: true });
      down(visible); up({ ...visible, isDown: false });
      expect(taps).toEqual([expect.objectContaining({ tx: 2, ty: 2 })]);
    } finally {
      offTap(); offToast(); (scene.unsub as Array<() => void>).forEach(dispose => dispose());
    }
  });

  it.each([[390, 844], [844, 320]])('ignores an unowned second HUD contact without cancelling the %s×%s canvas gesture', async (width, height) => {
    const { scene, handlers, addEvent, emitTap } = await gestureHarness();
    Object.assign((scene.cameras as { main: Record<string, unknown> }).main, { width, height });
    scene.insets = { top: 80, bottom: 100, left: 0, right: 0 };
    scene.time = { now: 1000, addEvent }; scene.lastDenyAt = Number.NEGATIVE_INFINITY;
    const down = handlers.get('pointerdown') as (p: GesturePointer) => void;
    const up = handlers.get('pointerup') as (p: GesturePointer) => void;
    const covered = pointer({ id: 5, x: width / 2, y: height - 60, wasTouch: true });
    const toasts: unknown[] = []; const off = bus.on('ui:toast', event => toasts.push(event));
    try {
      down(pointer({ id: 3, x: width / 2, y: 110, wasTouch: true }));
      addEvent.mockClear();
      down(covered); up({ ...covered, isDown: false });
      expect(scene.gesture).toEqual({ mode: 'pending', x: width / 2, y: 110 });
      expect(addEvent).not.toHaveBeenCalled();
      expect(emitTap).not.toHaveBeenCalled(); expect(toasts).toEqual([]);
      // A denied contact never belongs to the scene and cannot poison a pan.
      const move = handlers.get('pointermove') as (p: GesturePointer) => void;
      move(pointer({ id: 3, x: width / 2 + 40, y: 110, wasTouch: true }));
      expect(scene.userMovedCamera).toBe(true);
      up(pointer({ id: 3, x: width / 2 + 40, y: 110, wasTouch: true, isDown: false }));
      // An unrelated HUD touch must not consume the next refusal cooldown.
      down(covered); up({ ...covered, isDown: false });
      expect(toasts).toEqual([{ msg: 'PAN TO REVEAL THIS TILE' }]);
      expect(emitTap).not.toHaveBeenCalled();
    } finally { off(); (scene.unsub as Array<() => void>).forEach(dispose => dispose()); }
  });

  it('does not show deployment refusals for read-only scout gestures under HUD chrome', async () => {
    const { scene, handlers } = await gestureHarness();
    Object.assign((scene.cameras as { main: Record<string, unknown> }).main, { width: 390, height: 844 });
    scene.insets = { top: 80, bottom: 100, left: 0, right: 0 };
    scene.deployEnabled = false;
    scene.time = { now: 1000 }; scene.lastDenyAt = Number.NEGATIVE_INFINITY;
    const toasts: unknown[] = []; const off = bus.on('ui:toast', event => toasts.push(event));
    try {
      (handlers.get('pointerdown') as (p: GesturePointer) => void)(pointer({ y: 60, wasTouch: true }));
      (handlers.get('pointerup') as (p: GesturePointer) => void)(pointer({ y: 60, wasTouch: true, isDown: false }));
      expect(toasts).toEqual([]);
    } finally { off(); (scene.unsub as Array<() => void>).forEach(dispose => dispose()); }
  });

  it('withholds a pointer inside HUD chrome and asks the player to pan', async () => {
    const { BattleScene } = await import('./BattleScene');
    const taps: unknown[] = [];
    const toasts: unknown[] = [];
    const offTap = bus.on('battle:tap', (event) => taps.push(event));
    const offToast = bus.on('ui:toast', (event) => toasts.push(event));
    const scene = {
      cameras: { main: { width: 390, height: 844, zoom: 1, getWorldPoint: (x: number, y: number) => ({ x, y }) } },
      insets: { top: 100, bottom: 200, left: 0, right: 0 },
      isDeployable: () => true,
      time: { now: 0 },
      lastDenyAt: Number.NEGATIVE_INFINITY,
    };
    (BattleScene.prototype as unknown as { emitTap(this: typeof scene, p: { x: number; y: number }): void })
      .emitTap.call(scene, { x: 160, y: 90 });
    expect(taps).toEqual([]);
    expect(toasts).toEqual([{ msg: 'PAN TO REVEAL THIS TILE' }]);
    (BattleScene.prototype as unknown as { emitTap(this: typeof scene, p: { x: number; y: number }): void })
      .emitTap.call(scene, { x: 160, y: 90 });
    expect(toasts).toHaveLength(1); // held/swiped covered tiles must not spam the toast host
    offTap(); offToast();
  });

  it('passes a visible pointer on a partly covered raw tile to the final legal snap', async () => {
    // The former whole-raw-tile guard rejected before RaidUI could snap -5 to -4.
    const { BattleScene } = await import('./BattleScene');
    const taps: Array<{ tx: number; ty: number }> = [];
    const off = bus.on('battle:tap', (tap) => taps.push(tap));
    const scene = {
      cameras: { main: { width: 1280, height: 720, zoom: .6,
        getWorldPoint: () => ({ x: 672, y: -288 }) } },
      insets: { top: 108, bottom: 178, left: 0, right: 0 },
      isDeployable: (_x: number, y: number) => y >= -4,
    };
    (BattleScene.prototype as unknown as { emitTap(this: typeof scene, p: { x: number; y: number }): void })
      .emitTap.call(scene, { x: 634, y: 116 });
    expect(taps).toEqual([expect.objectContaining({ tx: 10, ty: -5 })]);
    off();
  });

  it('does not treat render-only northern camera headroom as actor height', async () => {
    const { BattleScene } = await import('./BattleScene');
    const taps: Array<{ tx: number; ty: number }> = [];
    const offTap = bus.on('battle:tap', (event) => taps.push(event));
    const scene = {
      cameras: { main: { width: 390, height: 844, zoom: 1, getWorldPoint: (x: number, y: number) => ({ x, y }) } },
      insets: { top: 100, bottom: 200, left: 0, right: 0 },
      isDeployable: () => true,
    };
    (BattleScene.prototype as unknown as { emitTap(this: typeof scene, p: { x: number; y: number }): void })
      .emitTap.call(scene, { x: 160, y: 160 });
    expect(taps).toEqual([expect.objectContaining({ tx: 2, ty: 2 })]);
    offTap();
  });

  it('permits a visible Dire ground tile even when fanned artwork overlaps the side rail', async () => {
    // WHY: presentation size cannot remove a legal ground destination. Existing
    // previews stay intact and checking the next drop creates no temporary actor.
    const { BattleScene } = await import('./BattleScene');
    const destroy = vi.fn();
    const existing = {
      tx: 12, ty: 2, troop: 'highlander', fx: { destroy: vi.fn() },
      sprite: {
        x: 800, y: 160,
        getBounds: () => ({ left: 768, top: 128, right: 832, bottom: 192 }),
      },
    };
    const candidate = {
      tx: 12, ty: 2, troop: 'direwyvern', fx: { destroy },
      sprite: {
        x: 800, y: 160,
        getBounds: () => ({ left: 720, top: 96, right: 880, bottom: 208 }),
      },
    };
    const scene = {
      marks: [existing],
      createDeployMark: vi.fn(() => candidate),
    };
    const visible = (BattleScene.prototype as unknown as {
      deployPreviewVisible: (
        tx: number, ty: number, troop: string, hero: undefined,
        input: { left: number; top: number; right: number; bottom: number },
        screenX: number, screenY: number, worldX: number, worldY: number, zoom: number,
      ) => boolean;
    }).deployPreviewVisible.call(
      scene, 12, 2, 'direwyvern', undefined,
      { left: 0, top: 0, right: 839, bottom: 412 },
      800, 160, 800, 160, 1,
    );
    expect(visible).toBe(true);
    expect(scene.createDeployMark).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });
});

describe('packed actor deployment envelopes (requires built assets)', () => {
  // Real constructor, ticker, packed frame dimensions, anchor and scale; only
  // the unrotated root Sprite geometry is adapted for Node. This deliberately
  // does not claim browser/WebGL, DOM safe-area measurement or device proof.
  const packed = JSON.parse(readFileSync(
    new URL('../../../public/atlas/meta.json', import.meta.url), 'utf8',
  )) as { v2Clips: import('../v2/clips').V2ClipMap };
  interface PackedFrame {
    filename: string; rotated: boolean; trimmed: boolean;
    sourceSize: { w: number; h: number };
  }
  const atlasFrames = new Map<string, Map<string, PackedFrame>>();
  function frameOf(atlas: string, frame: string): PackedFrame {
    const scale = atlas === 'hero' ? 2 : 1;
    const file = `${atlas}@${scale}x.json`;
    if (!atlasFrames.has(file)) {
      const json = JSON.parse(readFileSync(
        new URL(`../../../public/atlas/${file}`, import.meta.url), 'utf8',
      )) as { textures: Array<{ frames: PackedFrame[] }> };
      atlasFrames.set(file, new Map(json.textures.flatMap((texture) =>
        texture.frames.map((entry) => [entry.filename, entry] as const))));
    }
    const entry = atlasFrames.get(file)!.get(frame);
    if (!entry) throw new Error(`Missing packed preview ${file}/${frame}`);
    // A future trimmed/rotated pack requires real Phaser geometry, not a
    // silently inaccurate rectangular test adapter.
    expect(entry.rotated, `${file}/${frame}`).toBe(false);
    expect(entry.trimmed, `${file}/${frame}`).toBe(false);
    return entry;
  }
  class PackedSprite {
    active = true;
    width = 0;
    height = 0;
    originX = 0.5;
    originY = 0.5;
    scale = 1;
    depth = 0;
    constructor(public x: number, public y: number, atlas: string, frame: string) {
      this.setTexture(atlas, frame);
    }
    setTexture(atlas: string, frame: string): this {
      const entry = frameOf(atlas, frame);
      this.width = entry.sourceSize.w; this.height = entry.sourceSize.h;
      return this;
    }
    setOrigin(x: number, y: number): this { this.originX = x; this.originY = y; return this; }
    setScale(scale: number): this { this.scale = scale; return this; }
    setDepth(depth: number): this { this.depth = depth; return this; }
    setFlipX(): this { return this; }
    once(): this { return this; }
    destroy(): void { this.active = false; }
    getBounds(): { left: number; top: number; right: number; bottom: number } {
      return {
        left: this.x - this.width * this.originX * this.scale,
        top: this.y - this.height * this.originY * this.scale,
        right: this.x + this.width * (1 - this.originX) * this.scale,
        bottom: this.y + this.height * (1 - this.originY) * this.scale,
      };
    }
  }
  const cases = [
    ...(['dragon', 'direwyvern'] as const).flatMap((troop) =>
      [1, 2, 3, 4].flatMap((tier) =>
        (['rich', 'compact', 'fallback'] as const).map((path) => ({
          label: `${troop} T${tier} ${path}`, troop, tier, path,
          hero: undefined as 'vex' | 'theodor' | undefined,
        })))),
    ...(['vex', 'theodor'] as const).map((hero) => ({
      label: hero, troop: 'highlander' as const, tier: 1, path: 'hero' as const, hero,
    })),
  ];

  it('keeps mobile 1x hero files in the same logical frame space as desktop 2x', async () => {
    const { deviceAtlasScale, eagerAtlasScale } = await import('@shardkeep/shared');
    const fileScale = deviceAtlasScale('hero', 'constrained');
    const logicalScale = eagerAtlasScale('hero');
    const mobile = JSON.parse(readFileSync(
      new URL(`../../../public/atlas/hero@${fileScale}x.json`, import.meta.url), 'utf8',
    )) as { textures: Array<{ frames: PackedFrame[] }> };
    const heroFrames = mobile.textures.flatMap((texture) => texture.frames)
      .filter((frame) => /^hero_(vex|theo)_(walk|attack)_/.test(frame.filename));
    expect(fileScale).toBe(1);
    expect(logicalScale).toBe(2);
    expect(heroFrames.length).toBeGreaterThan(0);
    for (const frame of heroFrames) {
      const logical = frameOf('hero', frame.filename);
      expect(frame.sourceSize.w * logicalScale / fileScale, frame.filename).toBe(logical.sourceSize.w);
      expect(frame.sourceSize.h * logicalScale / fileScale, frame.filename).toBe(logical.sourceSize.h);
    }
  });

  it.each(cases)('$label keeps ground eligibility independent of packed/fanned artwork after zoom or resize', async ({ troop, tier, path, hero }) => {
    const { BattleScene, battleCanvasInputRect } = await import('./BattleScene');
    const { AnimTicker } = await import('../anim');
    const { V2Ticker } = await import('../v2/ticker');
    const { BATTLE_SCALE, RAID_CAMERA } = await import('@shardkeep/shared');
    const { v2TroopDrawScale } = await import('../v2/troop');
    type Mark = { tx: number; ty: number; troop: string; hero?: 'vex' | 'theodor' | undefined; sprite: PackedSprite; fx: { destroy(): void } };
    type Rect = { left: number; top: number; right: number; bottom: number };
    const created: PackedSprite[] = [];
    const ticker = new V2Ticker();
    const scene = Object.assign(Object.create(BattleScene.prototype), {
      marks: [] as Mark[], anim: new AnimTicker(),
      textures: { exists: () => true },
      tweens: { killTweensOf: () => undefined },
      add: { sprite: (x: number, y: number, atlas: string, frame: string) => {
        const sprite = new PackedSprite(x, y, atlas, frame);
        created.push(sprite); return sprite;
      } },
      v2TroopDepsOf: () => path === 'rich' || path === 'compact'
        ? { clips: packed.v2Clips, ticker, unit: troop, tier, compact: path === 'compact', breath: null }
        : undefined,
      v2TroopFallbackOf: () => path === 'fallback'
        ? { clips: packed.v2Clips, unit: troop, tier }
        : undefined,
      nearestBuildingX: () => null,
    }) as {
      marks: Mark[];
      createDeployMark(spec: Omit<Mark, 'sprite' | 'fx'>): Mark;
      deployPreviewVisible(tx: number, ty: number, troop: string, hero: 'vex' | 'theodor' | undefined,
        input: Rect, screenX: number, screenY: number, worldX: number, worldY: number, zoom: number): boolean;
    };
    // Northern deploy-margin tile; panning changes only screen projection.
    const spec = { troop, hero, tx: 0, ty: -1 };
    const probe = scene.createDeployMark(spec);
    const body = probe.sprite.getBounds();
    if (!hero) {
      const clip = packed.v2Clips[`v2_trp_${troop}_t${tier}_hover`]!;
      const scale = v2TroopDrawScale(troop) * BATTLE_SCALE.troop;
      expect(body.right - body.left).toBeCloseTo(clip.cellW * scale, 8);
      expect(body.bottom - body.top).toBeCloseTo(clip.cellH * scale, 8);
      expect(probe.sprite.y - body.top).toBeCloseTo(clip.anchorPx![1] * scale, 8);
    }
    probe.fx.destroy();

    // The packed dimensions above remain the artwork contract. Placement is a
    // ground-point contract: neither the selected frame nor fan count owns it.
    for (const total of hero ? [1] : [1, 2, 10]) {
      scene.marks = Array.from({ length: total - 1 }, () => scene.createDeployMark(spec));
      // Existing marks may already be offset; the next stack must re-seat them
      // rather than adding the fan to their old world position a second time.
      scene.marks.forEach((mark, index) => { mark.sprite.x += index + 9; mark.sprite.y -= index + 12; });
      for (const viewport of [
        { width: 390, height: 844, insets: { top: 104, bottom: 212, left: 7, right: 11 } },
        { width: 915, height: 412, insets: { top: 54, bottom: 72, left: 29, right: 87 } },
        { width: 915, height: 311, insets: { top: 54, bottom: 112, left: 29, right: 87 } },
      ]) {
        const input = battleCanvasInputRect(viewport.width, viewport.height, viewport.insets);
        for (const zoom of [RAID_CAMERA.minZoom, 0.6, RAID_CAMERA.maxZoom]) {
          const middleX = (input.left + input.right) / 2;
          const middleY = (input.top + input.bottom) / 2;
          for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
            for (const visible of [false, true]) {
              const inset = visible ? 0.25 : -0.25;
              let x = middleX; let y = middleY;
              if (edge === 'left') x = input.left + inset;
              if (edge === 'right') x = input.right - inset;
              if (edge === 'top') y = input.top + inset;
              if (edge === 'bottom') y = input.bottom - inset;
              const before = created.length;
              expect(scene.deployPreviewVisible(
                spec.tx, spec.ty, troop, hero, input,
                x + 7 * zoom, y - 5 * zoom, 39, -37, zoom,
              ), `${path}/${total}/${viewport.width}x${viewport.height}/${zoom}/${edge}/${visible}`).toBe(visible);
              expect(scene.marks).toHaveLength(total - 1);
              expect(created).toHaveLength(before); // visibility cannot allocate a temporary sprite
              expect(scene.marks.every((mark) => mark.tx === 0 && mark.ty === -1 && mark.sprite.active)).toBe(true);
            }
          }
        }
      }
      scene.marks.forEach((mark) => mark.fx.destroy());
    }
    // Real camera framing continues to make every legal outer ground point
    // reachable for the same packed roster; art does not change those bounds.
    const cam = new RealBaseCamera(0, 0, 1280, 720).setZoom(0.6);
    const cameraScene = Object.assign(scene, {
      cameras: { main: cam }, insets: { top: 100, bottom: 200, left: 29, right: 87 },
      syncCameraBounds: (BattleScene.prototype as unknown as { syncCameraBounds(zoom: number): void }).syncCameraBounds,
    });
    cameraScene.syncCameraBounds(cam.zoom);
    for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
      const edgeSpec = { troop, hero, tx: edge === 'left' ? -4 : edge === 'right' ? 33 : 10,
        ty: edge === 'top' ? -4 : edge === 'bottom' ? 33 : 10 };
      const worldX = (edgeSpec.tx + 0.5) * 64; const worldY = (edgeSpec.ty + 0.5) * 64;
      cam.centerOn(worldX, worldY);
      if (edge === 'top' || edge === 'bottom') cam.scrollY = cam.clampY(edge === 'top' ? -10000 : 10000);
      else cam.scrollX = cam.clampX(edge === 'left' ? -10000 : 10000);
      for (const total of hero ? [1] : [1, 2, 10]) {
        scene.marks = Array.from({ length: total - 1 }, () => scene.createDeployMark(edgeSpec));
        const projected = projectWithCamera(cam, worldX, worldY);
        expect(scene.deployPreviewVisible(
          edgeSpec.tx, edgeSpec.ty, troop, hero, battleCanvasInputRect(cam.width, cam.height, cameraScene.insets),
          projected.x, projected.y, worldX, worldY, cam.zoom,
        ), `${path}/${total} packed ${edge} ground point is reachable`).toBe(true);
        expect(scene.marks.every(mark => mark.tx === edgeSpec.tx && mark.ty === edgeSpec.ty)).toBe(true);
        scene.marks.forEach(mark => mark.fx.destroy());
      }
    }
  });
});

describe('BattleScene hold-to-deploy cancellation', () => {
  it('installs the repeat before the hero beat so synchronous holdCancel removes it', async () => {
    const { BattleScene } = await import('./BattleScene');
    const lifecycle: string[] = [];
    let removed = false;
    let repeatBeat: (() => void) | undefined;
    const repeat = {
      remove: vi.fn(() => { removed = true; lifecycle.push('remove-repeat'); }),
    };
    const confirmation = { remove: vi.fn(() => { lifecycle.push('remove-confirm'); }) };
    const scene: Record<string, unknown> = {
      holdFired: false,
      holdTimer: confirmation,
      pinch: { active: () => false },
      time: {
        addEvent: vi.fn((config: { callback: () => void }) => {
          lifecycle.push('install-repeat');
          repeatBeat = config.callback;
          return repeat;
        }),
      },
    };
    const stop = (BattleScene.prototype as unknown as {
      stopHoldDeploy: (this: Record<string, unknown>) => void;
    }).stopHoldDeploy;
    scene['emitTap'] = vi.fn(() => {
      lifecycle.push('hero-beat');
      stop.call(scene); // RaidUI's synchronous battle:holdCancel listener.
    });
    const start = (BattleScene.prototype as unknown as {
      startSprayDeploy: (this: Record<string, unknown>, p: GesturePointer) => void;
    }).startSprayDeploy;

    start.call(scene, pointer());
    if (!removed) repeatBeat?.(); // model the next Phaser timer beat if it survived.

    expect(lifecycle).toEqual(['install-repeat', 'hero-beat', 'remove-repeat']);
    expect(scene['emitTap']).toHaveBeenCalledOnce();
    expect(confirmation.remove).not.toHaveBeenCalled();
    expect(scene['holdTimer']).toBeNull();
  });
});

describe('BattleScene current-art fallback', () => {
  it.each([
    ['dragon', 'hover', 160, 120, [80, 110]],
    ['turrider', 'idle', 128, 104, [64, 94]],
  ] as const)(
    'uses the eager current %s frame for a marker while its full atlas is unavailable',
    async (unit, stand, cellW, cellH, anchorPx) => {
      const { BattleScene } = await import('./BattleScene');
      const prototype = BattleScene.prototype as unknown as {
        createDeployMark: (
          spec: { troop: string; tx: number; ty: number },
        ) => { sprite: unknown };
        v2TroopDepsOf: (troop: string) => unknown;
        v2TroopFallbackOf: (troop: string) => unknown;
      };
      const sprite = {
        setOrigin: vi.fn().mockReturnThis(),
        setAlpha: vi.fn().mockReturnThis(),
        setDepth: vi.fn().mockReturnThis(),
        setScale: vi.fn().mockReturnThis(),
      };
      const addSprite = vi.fn(() => sprite);
      const scene = {
        armyLevels: { [unit]: 7 },
        v2TroopTiers: new Map(),
        v2TroopLocomotionTiers: new Map(),
        meleeDrivenIds: new Set(),
        v2meta: {
          clips: {
            [`v2_trp_${unit}_t2_${stand}`]: {
              frames: 4, rows: 8, cellW, cellH, anchorPx,
            },
          },
          breathStream: null,
          atlasBytes: {},
        },
        add: { sprite: addSprite },
        anim: { register: vi.fn(), unregister: vi.fn() },
        v2TroopDepsOf: prototype.v2TroopDepsOf,
        v2TroopFallbackOf: prototype.v2TroopFallbackOf,
      };

      prototype.createDeployMark.call(scene, { troop: unit, tx: 3, ty: 4 });

      expect(addSprite).toHaveBeenCalledWith(
        224, 288, 'v2fallback', `v2_fallback_${unit}_t2`,
      );
      expect(sprite.setOrigin).toHaveBeenCalledWith(anchorPx[0] / cellW, anchorPx[1] / cellH);
    },
  );
});

describe('BattleScene defensive art priority', () => {
  it('decodes the snapshot geometry contract before rendering and rejects unknown versions', async () => {
    const { battleGeometryVersion } = await import('./BattleScene');
    expect(battleGeometryVersion({})).toBe(1);
    expect(battleGeometryVersion({ geometryVersion: 1 })).toBe(1);
    expect(battleGeometryVersion({ geometryVersion: 2 })).toBe(2);
    expect(() => battleGeometryVersion({ geometryVersion: 3 }))
      .toThrow(/unsupported building geometry version/);
  });

  it('K-060: refuses an unsupported persisted geometry by waking base, not dying mid-create', async () => {
    // WHY: create() runs after the base scene sleeps. An unguarded resolver
    // throw aborts create() before the battle:exit lifecycle exists, so
    // NOTHING wakes base again — the player is left with neither view. The
    // guard must run before any scene object or subscription is created, which
    // this stub enforces structurally: it provides ONLY the scene plugin, so
    // any earlier side effect (registry, audio, ticker) throws and fails here.
    const { BattleScene } = await import('./BattleScene');
    const stop = vi.fn();
    const wake = vi.fn();
    const refreshes: unknown[] = [];
    const off = bus.on('base:refresh', (payload) => { refreshes.push(payload); });
    try {
      const scene = { scene: { stop, wake } } as unknown as InstanceType<typeof BattleScene>;
      expect(() => BattleScene.prototype.create.call(
        scene, { snapshot: { geometryVersion: 3, keepLevel: 1, buildings: [] } },
      )).not.toThrow();
    } finally {
      off();
    }
    expect(stop).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith('base');
    expect(refreshes).toHaveLength(1); // the same base-refresh signal battle:exit emits
  });

  it('threads v2 KEEP geometry through seating, occupancy, targeting and deploy exclusion', async () => {
    const { BattleScene } = await import('./BattleScene');
    const prototype = BattleScene.prototype as unknown as {
      spawnBuilding: (building: Record<string, unknown>) => void;
      spriteKeyFor: (building: Record<string, unknown>) => string;
      buildingSeat: (frame: string) => unknown;
      nearestBuildingX: (x: number, y: number) => { x: number; y: number } | null;
      isDeployable: (tx: number, ty: number) => boolean;
    };
    const sprite = {
      // The @2x Keep cell (272 px) at its published fit. The seat is the
      // sprite's BOTTOM EDGE on the footprint's south edge, so a fake with no
      // drawn height cannot be seated.
      displayHeight: 272 * 0.625,
      setOrigin: vi.fn().mockReturnThis(),
      setScale: vi.fn().mockReturnThis(),
      setDepth: vi.fn().mockReturnThis(),
      setY: vi.fn().mockReturnThis(),
    };
    const graphics = { setDepth: vi.fn().mockReturnThis() };
    const scene = {
      geometryVersion: 2,
      claimMin: 8,
      claimMax: 22,
      wallFrames: new Map(),
      spriteKeyFor: prototype.spriteKeyFor,
      buildingSeat: prototype.buildingSeat,
      v2meta: { clips: {} },
      waremeta: { clips: {} },
      meta: {
        bld_keep_l1: {
          anchor: [0.5, 0.5], anchorAtFootprintCentre: true,
          sourceScale: 0.625, offsetGamePx: [0, 0],
        },
      },
      add: { sprite: vi.fn(() => sprite), graphics: vi.fn(() => graphics) },
      anim: { register: vi.fn(), unregister: vi.fn() },
      occupied: new Set<string>(),
      destructibleMaxHp: 0,
      buildings: new Map(),
    };

    prototype.spawnBuilding.call(scene, {
      id: 'keep', type: 'keep', level: 1, tx: 0, ty: 0,
    });

    // X at construction, Y only after origin and scale are on — the seat is
    // measured off the sprite's drawn height: bottom edge on the south edge.
    expect(scene.add.sprite).toHaveBeenCalledWith(2 * 64, 0, 'bld', 'bld_keep_l1');
    expect(sprite.setY).toHaveBeenCalledWith(4 * 64 - 0.5 * 272 * 0.625);
    // The south edge, lifted into the BUILDING band: still the Y that sorts
    // this Keep against its neighbours, now in a layer the troops draw above
    // (owner 2026-08-30 — a raid must never paint a unit inside a building).
    expect(sprite.setDepth).toHaveBeenCalledWith(structureDepth('building', 4 * 64));
    expect(scene.buildings.get('keep')).toMatchObject({ fw: 4, fh: 4 });
    expect(scene.occupied.size).toBe(16);
    expect(prototype.nearestBuildingX.call(scene, -1, -1)).toEqual({ x: 128, y: 256 });
    expect(prototype.isDeployable.call(scene, 3, 3)).toBe(false);
    expect(prototype.isDeployable.call(scene, 4, 3)).toBe(true);
  });

  it('uses SIM15 full-field legality without turning the whole claim into a no-deploy core', async () => {
    const { BattleScene } = await import('./BattleScene');
    const scene = Object.assign(Object.create(BattleScene.prototype), {
      battlefieldVersion: 2, claimMin: 2, claimMax: 28,
      occupied: new Set(['14,14', '15,14', '14,15', '15,15', '18,18']),
      deploymentBlockers: [{ tx: 20, ty: 20, fw: 2, fh: 2 }],
    });
    for (const [x, y] of [[-34,-34], [63,63], [15,-7], [17,17]]) expect(scene.isDeployable(x, y)).toBe(true);
    for (const [x, y] of [[-35,0], [64,0], [14,14], [18,18], [21,21]]) expect(scene.isDeployable(x, y)).toBe(false);
    const cam = new RealBaseCamera(0, 0, 412, 892);
    Object.assign(scene, { cameras: { main: cam }, pinch: { setLimits: vi.fn() },
      fantasyGround: { setCoverage: vi.fn() }, insets: { top: 64, bottom: 152, left: 0, right: 0 } });
    scene.fitCamera();
    // Full-field travel must not be mistaken for entry framing around the Keep.
    expect(cam.zoom).toBeGreaterThan(scene.zoomMin);
    expect(scene.deployMargin).toBe(34);
    expect(98 * 64 * scene.zoomMin).toBeLessThanOrEqual(412 + 0.001);
    expect(cam.getBounds().width).toBeGreaterThanOrEqual(98 * 64);
  });

  it('paints v3holes and narrow corridors as blocked while every clear2×2 corner stays deployable', async () => {
    const { BattleScene } = await import('./BattleScene');
    const scene = Object.assign(Object.create(BattleScene.prototype), {
      battlefieldVersion: 3, claimMin: 2, claimMax: 28, occupied: new Set<string>(),
      deploymentBlockers: [{ tx: -1, ty: -3, fw: 1, fh: 7 }, { tx: 1, ty: -3, fw: 1, fh: 7 },
        { tx: 4, ty: 4, fw: 4, fh: 1 }, { tx: 4, ty: 7, fw: 4, fh: 1 },
        { tx: 4, ty: 5, fw: 1, fh: 2 }, { tx: 7, ty: 5, fw: 1, fh: 2 }],
    });
    expect(scene.isDeployable(0, 0)).toBe(false);
    for (const [x, y] of [[5,5],[6,5],[5,6],[6,6],[-34,-34],[63,63]]) expect(scene.isDeployable(x, y)).toBe(true);
    scene.occupied.add('6,6');
    for (const [x, y] of [[5,5],[6,5],[5,6],[6,6]]) expect(scene.isDeployable(x, y)).toBe(false);
  });

  it('spawns eager WARE buildings once from their already-2× bld atlas', async () => {
    const { BattleScene } = await import('./BattleScene');
    const prototype = BattleScene.prototype as unknown as {
      spawnBuilding: (building: Record<string, unknown>) => void;
      spriteKeyFor: (building: Record<string, unknown>) => string;
      buildingSeat: (frame: string) => unknown;
    };
    const sprite = {
      // The @2x Keep cell (272 px) at its published fit. The seat is the
      // sprite's BOTTOM EDGE on the footprint's south edge, so a fake with no
      // drawn height cannot be seated.
      displayHeight: 272 * 0.625,
      setOrigin: vi.fn().mockReturnThis(),
      setScale: vi.fn().mockReturnThis(),
      setDepth: vi.fn().mockReturnThis(),
      setY: vi.fn().mockReturnThis(),
    };
    const graphics = { setDepth: vi.fn().mockReturnThis() };
    const scene = {
      wallFrames: new Map(),
      spriteKeyFor: prototype.spriteKeyFor,
      buildingSeat: prototype.buildingSeat,
      v2meta: { clips: {} },
      waremeta: { clips: {} },
      meta: {
        bld_keep_l1: {
          anchor: [0.5, 0.5], anchorAtFootprintCentre: true,
          sourceScale: 0.625, offsetGamePx: [0, 0],
        },
      },
      add: { sprite: vi.fn(() => sprite), graphics: vi.fn(() => graphics) },
      anim: { register: vi.fn(), unregister: vi.fn() },
      occupied: new Set<string>(),
      destructibleMaxHp: 0,
      buildings: new Map(),
    };

    prototype.spawnBuilding.call(scene, {
      id: 'keep', type: 'keep', level: 1, tx: 3, ty: 4,
    });

    expect(scene.add.sprite).toHaveBeenCalledWith(
      (3 + 1) * 64, 0, 'bld', 'bld_keep_l1',
    );
    expect(sprite.setY).toHaveBeenCalledWith((4 + 2) * 64 - 0.5 * 272 * 0.625);
    expect(sprite.setScale).toHaveBeenCalledWith(0.625);
  });

  // These rows pin the CONTRACT — one fitted world seat across the eager, rich
  // and damage-fallback art paths — not the fits themselves, so the fixture
  // reads each family's fit from the constant the RASTERIZER bakes into
  // meta.sprites rather than restating it. Restating it is how this case broke
  // twice: once when the dragon-nest art was replaced in c2320c8 and 0.95 hung
  // it outside its own 2x2, and again on 2026-08-30 when the size contract took
  // the Barracks to 0.735. A fixture that goes stale every time a fit is tuned
  // is testing the wrong thing.
  it.each([
    ['keep', 'keep', 'l1', [0, 0]],
    ['mine', 'mine', 't1', [1, 0]],
    ['barracks', 'barracks', 't1', [0, 0]],
    ['dragonnest', 'dragonnest', 't1', [0, 0]],
  ] as const)(
    'keeps eager, rich, and damage-fallback %s art on one fitted world seat',
    async (unit, packUnit, progression, offsetGamePx) => {
      const { sourceScale } = WARE_WORLD_PRESENTATION[unit];
      const { BattleScene } = await import('./BattleScene');
      const buildingSeat = (BattleScene.prototype as unknown as {
        buildingSeat: (frame: string) => {
          origin: readonly [number, number]; scale: number;
          offsetGamePx: readonly [number, number];
        };
      }).buildingSeat;
      const eager = `bld_${unit}_l1`;
      const fallback = wareBuildingStateAliasKey(unit, 1, 'damaged');
      const richBase = `ware_bld_${packUnit}_${progression}_idle`;
      const rich = `${richBase}_f1`;
      const sharedMeta = {
        anchor: [0.5, 0.5] as [number, number],
        anchorAtFootprintCentre: true,
        sourceScale,
        offsetGamePx,
      };
      const scene = {
        v2meta: { clips: {} },
        waremeta: { clips: {
          [richBase]: {
            frames: 1, rows: 1, cellW: 64, cellH: 64,
            anchorPx: [32, 32], unit: packUnit,
          },
        } },
        meta: { [eager]: sharedMeta, [fallback]: sharedMeta },
      };

      const eagerSeat = buildingSeat.call(scene, eager);
      const richSeat = buildingSeat.call(scene, rich);
      const fallbackSeat = buildingSeat.call(scene, fallback);

      // Eager aliases are @2x; rich and damage fallbacks are @1x. Once pixel
      // density is accounted for, all three display at the same world size.
      expect(eagerSeat.scale * 2).toBeCloseTo(richSeat.scale);
      expect(fallbackSeat.scale).toBeCloseTo(richSeat.scale);
      expect([eagerSeat.origin, richSeat.origin, fallbackSeat.origin])
        .toEqual([[0.5, 0.5], [0.5, 0.5], [0.5, 0.5]]);
      expect([eagerSeat.offsetGamePx, richSeat.offsetGamePx, fallbackSeat.offsetGamePx])
        .toEqual([offsetGamePx, offsetGamePx, offsetGamePx]);
    },
  );

  it('re-seats Mine fallback from canonical tiles without accumulating its correction', async () => {
    const { BattleScene } = await import('./BattleScene');
    const apply = (BattleScene.prototype as unknown as {
      applyWareFallbackState: (building: Record<string, unknown>, state: 'damaged') => void;
    }).applyWareFallbackState;
    const key = wareBuildingStateAliasKey('mine', 1, 'damaged');
    const sprite = {
      // The @1x Mine damage cell (88 px) at the fallback's ×2 density and the
      // Mine's published fit — the drawn height the seat measures from.
      displayHeight: 88 * 0.9,
      setTexture: vi.fn().mockReturnThis(),
      setPosition: vi.fn().mockReturnThis(),
      setOrigin: vi.fn().mockReturnThis(),
      setScale: vi.fn().mockReturnThis(),
      clearTint: vi.fn().mockReturnThis(),
    };
    const scene = {
      meta: { [key]: {
        anchor: [0.5, 0.5], anchorAtFootprintCentre: true,
        sourceScale: 0.45, offsetGamePx: [1, 0],
      } },
      v2meta: { clips: {} },
      waremeta: { clips: {} },
      anim: { unregister: vi.fn() },
      v2Ticker: { unregister: vi.fn() },
      buildingSeat: (BattleScene.prototype as unknown as { buildingSeat: (frame: string) => unknown }).buildingSeat,
      positionBuildingSprite: (BattleScene.prototype as unknown as {
        positionBuildingSprite: (sprite: unknown, b: unknown, frame: string) => void;
      }).positionBuildingSprite,
    };
    apply.call(scene, {
      sprite, type: 'mine', level: 1, tx: 3, ty: 4, fw: 1, fh: 1,
    }, 'damaged');

    // Canonical centre is x=224. The WARE2 open-yard correction is exactly +2
    // world pixels, even if the eager alias already occupied that seat. Y is
    // the 1×1's south edge (5×64) less the half-cell below the centre anchor.
    expect(sprite.setPosition).toHaveBeenCalledWith(226, 5 * 64 - 0.5 * 88 * 0.9);
    expect(sprite.setScale).toHaveBeenCalledWith(0.9);
  });

  it('occupies all four canonical tiles for Air Defence and Clan Hall', async () => {
    const { BattleScene } = await import('./BattleScene');
    const prototype = BattleScene.prototype as unknown as {
      spawnBuilding: (building: Record<string, unknown>) => void;
      spriteKeyFor: (building: Record<string, unknown>) => string;
      buildingSeat: (frame: string) => unknown;
    };
    const makeSprite = () => ({
      displayHeight: 120, // any drawn height: this case pins occupancy, not Y
      setOrigin: vi.fn().mockReturnThis(),
      setScale: vi.fn().mockReturnThis(),
      setDepth: vi.fn().mockReturnThis(),
      setY: vi.fn().mockReturnThis(),
    });
    const graphics = { setDepth: vi.fn().mockReturnThis() };
    const scene = {
      wallFrames: new Map(),
      spriteKeyFor: prototype.spriteKeyFor,
      buildingSeat: prototype.buildingSeat,
      v2meta: { clips: {} },
      waremeta: { clips: {} },
      meta: {
        bld_airdefence_l1: {
          anchor: [0.5, 0.5], anchorAtFootprintCentre: true,
          sourceScale: 1, offsetGamePx: [0, 0],
        },
        bld_clanhall_l1: {
          anchor: [0.5, 0.5], anchorAtFootprintCentre: true,
          sourceScale: 0.85, offsetGamePx: [0, 0],
        },
      },
      add: { sprite: vi.fn(makeSprite), graphics: vi.fn(() => graphics) },
      anim: { register: vi.fn(), unregister: vi.fn() },
      occupied: new Set<string>(),
      destructibleMaxHp: 0,
      buildings: new Map(),
    };

    prototype.spawnBuilding.call(scene, {
      id: 'air', type: 'airdefence', level: 1, tx: 3, ty: 4,
    });
    prototype.spawnBuilding.call(scene, {
      id: 'clan', type: 'clanhall', level: 1, tx: 8, ty: 9,
    });

    expect([...scene.occupied].sort()).toEqual([
      '3,4', '3,5', '4,4', '4,5',
      '8,9', '8,10', '9,9', '9,10',
    ].sort());
    expect(scene.buildings.get('air')).toMatchObject({ fw: 2, fh: 2 });
    expect(scene.buildings.get('clan')).toMatchObject({ fw: 2, fh: 2 });
  });

  it('spawns every Cannon and Mortar tier from exact-current eager art, never old-pack art', async () => {
    // Cannon joined the eager v2fallback set on 2026-08-16 (owner: "old cannon
    // loaded in assets in campaign bases map instead of new one"): a campaign
    // fight whose rich tier atlas the texture budget rejects must degrade to
    // the CURRENT still, exactly like Mortar — never the legacy pack.
    const { BattleScene } = await import('./BattleScene');
    const spriteKeyFor = (BattleScene.prototype as unknown as {
      spriteKeyFor: (building: Record<string, unknown>) => string;
    }).spriteKeyFor;
    const scene = { wallFrames: new Map<string, string>() };

    for (const unit of ['cannon', 'mortar'] as const) {
      for (const [tier, level] of [1, 6, 11, 16].entries()) {
        const key = spriteKeyFor.call(scene, {
          id: `${unit}-${tier + 1}`, type: unit, level, tx: 0, ty: 0,
        });
        expect(key).toBe(v2BuildingFallbackFrameKey(unit, tier + 1, 1));
        expect(key).not.toMatch(new RegExp(`^bld_${unit}_`));
      }
    }
  });

  it('loops the complete eager Cannon/Mortar idle pairs until the rich controller adopts them', async () => {
    const { BattleScene } = await import('./BattleScene');
    const prototype = BattleScene.prototype as unknown as {
      spawnBuilding: (building: Record<string, unknown>) => void;
      spriteKeyFor: (building: Record<string, unknown>) => string;
      buildingSeat: (frame: string) => unknown;
    };
    for (const unit of ['cannon', 'mortar'] as const) {
      const sprite = {
        displayHeight: 120 * v2BldDrawScale(unit), // the 120-px cell, fitted
        setOrigin: vi.fn().mockReturnThis(),
        setScale: vi.fn().mockReturnThis(),
        setDepth: vi.fn().mockReturnThis(),
        setY: vi.fn().mockReturnThis(),
      };
      const graphics = { setDepth: vi.fn().mockReturnThis() };
      const register = vi.fn();
      const scene = {
        wallFrames: new Map(),
        spriteKeyFor: prototype.spriteKeyFor,
        buildingSeat: prototype.buildingSeat,
        v2meta: { clips: {
          [`v2_bld_${unit}_t3_idle`]: {
            cellW: 112, cellH: 120, anchorPx: [56, 104],
          },
        } },
        waremeta: { clips: {} },
        meta: {},
        add: { sprite: vi.fn(() => sprite), graphics: vi.fn(() => graphics) },
        anim: { register },
        occupied: new Set<string>(),
        destructibleMaxHp: 0,
        buildings: new Map(),
      };

      prototype.spawnBuilding.call(scene, {
        id: unit, type: unit, level: 11, tx: 3, ty: 4,
      });

      expect(register).toHaveBeenCalledWith(sprite, 'v2fallback', [
        v2BuildingFallbackFrameKey(unit, 3, 1),
        v2BuildingFallbackFrameKey(unit, 3, 2),
      ]);
      expect(sprite.setOrigin).toHaveBeenCalledWith(0.5, 104 / 120);
      // The eager still is a pixel copy of the same protected idle frame, so it
      // takes the same PUBLISHED world fit the rich controller will take when it
      // adopts. A bare ×2 here (what shipped) would pop the tower down a size at
      // the moment of adoption — and it is the value that let the Cannon
      // out-size the Keep in the first place (owner 2026-08-30).
      expect(sprite.setScale).toHaveBeenCalledWith(v2BldDrawScale(unit));
      // …and it stands on the south edge of the footprint it occupies, less the
      // 16 authored px of cell below the (56,104) anchor. The eager still and
      // the rich master share cell and anchor, so adoption cannot move it.
      const [, fh] = footprintOf(unit); // fx/stats returns a [fw, fh] tuple
      expect(sprite.setY).toHaveBeenCalledWith(
        (4 + fh) * 64 - (120 - 104) * v2BldDrawScale(unit),
      );
    }
  });

  it('routes every direct-fire defense to its intended shot visual', async () => {
    const { defenseShotVisual } = await import('./BattleScene');
    expect([
      defenseShotVisual('archertower', 'arrow', false),
      defenseShotVisual('cannon', 'cannonball', false),
      defenseShotVisual('mortar', 'shell', false),
      defenseShotVisual('magetower', 'arrow', false),
      defenseShotVisual('electrictower', 'arrow', false),
      defenseShotVisual('lasertower', 'beam', false),
      defenseShotVisual('cannon', 'cannonball', true),
      defenseShotVisual('mortar', 'shell', true),
    ]).toEqual(['arrow', 'cannonball', 'none', 'orb', 'zap', 'beam', 'v2', 'v2']);
  });

  it('fails closed for every non-adopted Mortar projectile cue instead of old fire FX', async () => {
    const { defenseShotVisual } = await import('./BattleScene');
    expect(['cannonball', 'arrow', 'shell', 'beam'].map((projectile) =>
      defenseShotVisual('mortar', projectile as 'cannonball' | 'arrow' | 'shell' | 'beam', false),
    )).toEqual(['none', 'none', 'none', 'none']);
    expect(readFileSync(new URL('./BattleScene.ts', import.meta.url), 'utf8'))
      .not.toContain('fx_fire_mortar');
  });

  it('reclaims sleeping home defenses and retries the exact atomic candidate once', async () => {
    const { BattleScene } = await import('./BattleScene');
    const releaseV2DefenseArtForBattle = vi.fn();
    const reserveV2Candidates = vi.fn()
      .mockReturnValueOnce(new Set<string>())
      .mockReturnValueOnce(new Set(['defences']));
    const scene = {
      reserveV2Candidates,
      scene: { get: () => ({ releaseV2DefenseArtForBattle }) },
    };
    const candidate = { id: 'defences', groups: ['v2bld_cannon_t1', 'v2fx'] };
    const reserve = (BattleScene.prototype as unknown as {
      reserveDefenseArt: (candidate: { id: string; groups: string[] }) => boolean;
    }).reserveDefenseArt;

    expect(reserve.call(scene, candidate)).toBe(true);
    expect(releaseV2DefenseArtForBattle).toHaveBeenCalledOnce();
    expect(reserveV2Candidates).toHaveBeenNthCalledWith(1, [candidate]);
    expect(reserveV2Candidates).toHaveBeenNthCalledWith(2, [candidate]);
  });

  it('routes one authoritative Cannon fire event through the adopted v2 controller', async () => {
    const { BattleScene } = await import('./BattleScene');
    const fire = vi.fn();
    const scene = {
      buildings: new Map([['cannon', {
        destroyed: false, type: 'cannon', v2: { fire },
      }]]),
      artDecidedDefenses: new Set<string>(),
      ux: (n: number) => n / 2,
      uy: (n: number) => n / 2,
    };
    const onFire = (BattleScene.prototype as unknown as {
      onFire: (ev: Record<string, unknown>) => void;
    }).onFire;
    onFire.call(scene, { id: 'cannon', proj: 'cannonball', ix: 200, iy: 400 });
    expect(fire).toHaveBeenCalledOnce();
    expect(fire).toHaveBeenCalledWith(100, 200);
    expect(scene.artDecidedDefenses).toEqual(new Set(['cannon']));
  });

  it('routes a trap contact into the admitted current WARE lifecycle', async () => {
    const { BattleScene } = await import('./BattleScene');
    const trigger = vi.fn();
    const scene = {
      buildings: new Map([['trap', {
        sprite: { active: true }, wareTrap: { trigger }, type: 'spiketrap',
      }]]),
    };
    const onTrap = (BattleScene.prototype as unknown as {
      onTrap: (ev: Record<string, unknown>) => void;
    }).onTrap;

    onTrap.call(scene, { id: 'trap', kind: 'spiketrap', victim: 0 });
    expect(trigger).toHaveBeenCalledOnce();
    expect(scene.buildings.get('trap')).toMatchObject({ trapSpent: true, destroyed: true });
  });
});

describe('BattleScene playback generation', () => {
  it('warms only the bounded Dragon action bank and releases it on replacement or exit', async () => {
    const first = { ready: Promise.resolve(), release: vi.fn() };
    const second = { ready: Promise.resolve(), release: vi.fn() };
    const manifest = vi.spyOn(audio, 'loadProductionSfxManifest').mockResolvedValue(true);
    const acquire = vi.spyOn(audio, 'acquireSfxBank')
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const { BattleScene } = await import('./BattleScene');
    const prototype = BattleScene.prototype as unknown as {
      warmDragonDeploymentSfx: (hasDragon: boolean) => void;
      releaseDragonDeploymentSfxBank: (generation?: number) => void;
    };
    const scene = {
      dragonDeploymentSfxBank: null,
      dragonDeploymentSfxGeneration: 0,
      scene: { isActive: () => true },
    };

    prototype.warmDragonDeploymentSfx.call(scene, true);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(1));
    expect(acquire).toHaveBeenLastCalledWith(audio.DRAGON_BATTLE_WARM_SFX);

    // A replacement roster without Dragon must immediately surrender the old
    // lease; it must not inherit six pinned buffers from the prior raid.
    prototype.warmDragonDeploymentSfx.call(scene, false);
    expect(first.release).toHaveBeenCalledOnce();

    prototype.warmDragonDeploymentSfx.call(scene, true);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(2));
    prototype.releaseDragonDeploymentSfxBank.call(scene);
    expect(second.release).toHaveBeenCalledOnce();

    manifest.mockRestore();
    acquire.mockRestore();
  });

  it('re-feeds the future suffix of a compact run that started before fromTick', async () => {
    const { BattleScene } = await import('./BattleScene');
    const calls: Array<{ delay: number; callback: () => void }> = [];
    const apply = vi.fn();
    const scene = {
      ...playbackHarness(Promise.resolve()),
      artDecidedTroops: new Set(['mage']),
      apply,
      time: {
        now: 0,
        delayedCall: (delay: number, callback: () => void) => {
          calls.push({ delay, callback });
          return { remove: vi.fn() };
        },
      },
    };
    const play = (BattleScene.prototype as unknown as {
      play: (events: Array<Record<string, unknown>>, fromTick?: number, simVersion?: number) => Promise<void>;
    }).play;
    await play.call(scene, [{
      e: 'attackRun', t: 10, id: 7, side: 'attacker', troop: 'mage',
      targetKind: 'building', target: 'keep', ix: 100, iy: 200,
      mode: 'projectile', technique: 'bolt', cycleMs: 600, releaseOffsetMs: 200,
      cycleTicks: 6, releaseOffsetTicks: 2, impactOffsetsTicks: [4],
      cadenceTicks: 6, count: 3,
    }], 13, 9);

    const suffix = calls.find((call) => call.delay === 300);
    expect(suffix).toBeDefined();
    suffix!.callback();
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({
      e: 'attackRun', t: 16, count: 2,
    }));
  });

  it('waits for compact Dragon motion, then hydrates the elapsed prefix instead of sliding', async () => {
    const { BattleScene } = await import('./BattleScene');
    const entryArt = deferred();
    const compact = deferred();
    const rich = deferred();
    const actors = new Set<number>();
    const applied: string[] = [];
    const tiers = new Map<string, number>();
    const scene = {
      ...playbackHarness(entryArt.promise),
      artDecidedTroops: new Set<string>(),
      v2TroopLocomotionTiers: tiers,
      requestV2TroopLocomotionArt: vi.fn(() => compact.promise.then(() => {
        tiers.set('dragon', 1);
      })),
      requestV2TroopArt: vi.fn(() => rich.promise),
      apply: (ev: { e: string; id?: number }) => {
        applied.push(ev.e);
        if (ev.e === 'deploy') actors.add(ev.id!);
      },
    };
    const play = (BattleScene.prototype as unknown as {
      play: (events: Array<Record<string, unknown>>, fromTick?: number) => Promise<void>;
    }).play;

    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const started = play.call(scene, [
        { e: 'deploy', t: 0, id: 41, troop: 'dragon', x: 0, y: 0 },
        { e: 'hit', t: 2, target: 41, dmg: 5 },
      ]);

      expect(started).toBeInstanceOf(Promise);
      expect(actors).toEqual(new Set());
      now.mockReturnValue(1_350);
      compact.resolve();
      await started;
      await vi.waitFor(() => expect(applied).toEqual(['deploy', 'hit']));
      expect(actors).toEqual(new Set([41]));
      expect(scene.requestV2TroopLocomotionArt).toHaveBeenCalledWith(['dragon']);
      expect(scene.requestV2TroopArt).toHaveBeenCalledWith('dragon');
    } finally {
      now.mockRestore();
    }
  });

  it('advances a carried compact gate by accepted 2x simulator time', async () => {
    // WHY: an overlapping refeed can discover that its earlier art gate already
    // settled. The retained wall wait still represents twice as much SIM time
    // at 2x and must be included before playback resumes.
    const { BattleScene } = await import('./BattleScene');
    const scene = {
      ...playbackHarness(Promise.resolve()),
      playbackRate: 2,
      renderedPlaybackState: true,
      pendingPlaybackGate: {
        fromTick: 10, requestedAt: 1_000, catchUpMs: 0, appliedPrefix: true,
      },
      artDecidedTroops: new Set(['mage']),
    };
    const play = (BattleScene.prototype as unknown as {
      play: (events: Array<Record<string, unknown>>, fromTick?: number) => void;
    }).play;
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_500);
    try {
      play.call(scene, [
        { e: 'deploy', t: 0, id: 1, troop: 'mage', x: 0, y: 0 },
        { e: 'hit', t: 15, target: 'keep', dmg: 1 },
        { e: 'hit', t: 25, target: 'keep', dmg: 1 },
      ], 30);
      expect((scene as unknown as { playbackOriginTick: number }).playbackOriginTick).toBe(20);
    } finally {
      now.mockRestore();
    }
  });

  it('advances an asynchronous compact gate by accepted 2x simulator time', async () => {
    // WHY: the old schedule is deliberately cancelled during the gate. If one
    // wall second of a 2x wait advances only ten ticks, the resumed field stays
    // a full simulator second behind with no catch-up path left.
    const { BattleScene } = await import('./BattleScene');
    const compact = deferred();
    const tiers = new Map<string, number>();
    const scene = {
      ...playbackHarness(Promise.resolve()),
      playbackRate: 2,
      armyLevels: { dragon: 1 },
      v2TroopLocomotionTiers: tiers,
      requestV2TroopLocomotionArt: vi.fn(() => compact.promise.then(() => {
        tiers.set('dragon', 1);
      })),
      requestV2TroopArt: vi.fn(() => Promise.resolve()),
      requestV2DireEnhancementArt: vi.fn(() => Promise.resolve()),
    };
    const play = (BattleScene.prototype as unknown as {
      play: (events: Array<Record<string, unknown>>, fromTick?: number) => Promise<void>;
    }).play;
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const started = play.call(scene, [
        { e: 'deploy', t: 10, id: 1, troop: 'dragon', x: 0, y: 0 },
        { e: 'hit', t: 25, target: 'keep', dmg: 1 },
      ], 10);
      now.mockReturnValue(1_500);
      compact.resolve();
      await started;
      expect((scene as unknown as { playbackOriginTick: number }).playbackOriginTick).toBe(20);
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    ['1x→2x', 1, 2],
    ['2x→1x', 2, 1],
  ] as const)('integrates an in-flight compact gate piecewise across %s', async (
    _label, initialRate, nextRate,
  ) => {
    // WHY: two one-second spans at 1x and 2x always equal 3000 simulator ms.
    // Charging the entire wait at only the final rate produces 2000 or 4000.
    const { BattleScene } = await import('./BattleScene');
    const compact = deferred();
    const tiers = new Map<string, number>();
    const scene = {
      ...playbackHarness(Promise.resolve()),
      playbackRate: initialRate,
      armyLevels: { dragon: 1 },
      v2TroopLocomotionTiers: tiers,
      requestV2TroopLocomotionArt: vi.fn(() => compact.promise.then(() => {
        tiers.set('dragon', 1);
      })),
      requestV2TroopArt: vi.fn(() => Promise.resolve()),
      requestV2DireEnhancementArt: vi.fn(() => Promise.resolve()),
    };
    const prototype = BattleScene.prototype as unknown as {
      play: (events: Array<Record<string, unknown>>, fromTick?: number) => Promise<void>;
      adoptPlaybackRate: (rate: 1 | 2) => void;
    };
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const started = prototype.play.call(scene, [
        { e: 'deploy', t: 10, id: 1, troop: 'dragon', x: 0, y: 0 },
        { e: 'hit', t: 50, target: 'keep', dmg: 1 },
      ], 10);
      now.mockReturnValue(2_000);
      prototype.adoptPlaybackRate.call(scene, nextRate);
      now.mockReturnValue(3_000);
      compact.resolve();
      await started;
      expect((scene as unknown as { playbackOriginTick: number }).playbackOriginTick).toBe(40);
    } finally {
      now.mockRestore();
    }
  });

  it('fails loud to exact-position fallback and still emits battle:done when compact art fails', async () => {
    const { BattleScene } = await import('./BattleScene');
    const timers: Array<{ delay: number; callback: () => void }> = [];
    const applied: string[] = [];
    const toasts: string[] = [];
    const scene = {
      ...playbackHarness(Promise.resolve()),
      armyLevels: { dragon: 1 },
      v2TroopTiers: new Map<string, number>(),
      requestV2TroopLocomotionArt: vi.fn(() => Promise.reject(new Error('atlas denied'))),
      requestV2TroopArt: vi.fn(() => Promise.resolve()),
      requestV2DireEnhancementArt: vi.fn(() => Promise.resolve()),
      apply: (ev: { e: string }) => { applied.push(ev.e); },
      time: {
        now: 0,
        delayedCall: (delay: number, callback: () => void) => {
          timers.push({ delay, callback });
          return { remove: vi.fn(), getRemaining: () => delay };
        },
      },
    };
    const play = (BattleScene.prototype as unknown as {
      play: (events: Array<Record<string, unknown>>) => Promise<void>;
    }).play;
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const offToast = bus.on('ui:toast', ({ msg }) => { toasts.push(msg); });
    const done = vi.fn();
    const offDone = bus.on('battle:done', done);
    try {
      const playback = play.call(scene, [
        { e: 'deploy', t: 0, id: 41, troop: 'dragon', x: 0, y: 0 },
        { e: 'pos', t: 1, id: 41, x: 256, y: 0 },
        { e: 'hit', t: 2, target: 41, dmg: 5 },
      ]);
      now.mockReturnValue(1_300);
      await playback;
      expect(applied).toEqual(['deploy', 'pos', 'hit']);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('using snap playback: dragon'));
      expect(toasts).toEqual(['BATTLE MOTION UNAVAILABLE — USING SNAP PLAYBACK']);
      const verdict = timers.find((timer) => timer.delay === 1_000);
      expect(verdict, 'failed media still schedules the authoritative verdict').toBeDefined();
      verdict!.callback();
      expect(done).toHaveBeenCalledOnce();
    } finally {
      offToast();
      offDone();
      error.mockRestore();
      now.mockRestore();
    }
  });

  it('bounds a never-settling compact request and still schedules the verdict', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const never = deferred();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { BattleScene } = await import('./BattleScene');
      const timers: Array<{ delay: number; callback: () => void }> = [];
      const applied: string[] = [];
      const scene = {
        ...playbackHarness(Promise.resolve()),
        armyLevels: { dragon: 1 },
        v2TroopTiers: new Map<string, number>(),
        requestV2TroopLocomotionArt: vi.fn(() => never.promise),
        requestV2TroopArt: vi.fn(() => Promise.resolve()),
        requestV2DireEnhancementArt: vi.fn(() => Promise.resolve()),
        apply: (event: { e: string }) => { applied.push(event.e); },
        time: {
          now: 0,
          delayedCall: (delay: number, callback: () => void) => {
            timers.push({ delay, callback });
            return { remove: vi.fn(), getRemaining: () => delay };
          },
        },
      };
      const play = (BattleScene.prototype as unknown as {
        play: (events: Array<Record<string, unknown>>) => Promise<void>;
      }).play;
      const playback = play.call(scene, [
        { e: 'deploy', t: 0, id: 1, troop: 'dragon', x: 0, y: 0 },
        { e: 'hit', t: 2, target: 1, dmg: 5 },
      ]);
      await vi.advanceTimersByTimeAsync(atlasLoader.ON_DEMAND_ATLAS_LOAD_TIMEOUT_MS);
      await playback;
      expect(applied).toEqual(['deploy', 'hit']);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('using snap playback: dragon'));
      expect(timers.some(({ delay }) => delay === 1_000)).toBe(true);
    } finally {
      error.mockRestore();
      vi.useRealTimers();
    }
  });

  it('hydrates a newly added Dragon while an applied-prefix replacement waits for art', async () => {
    const { BattleScene } = await import('./BattleScene');
    const compact = deferred();
    const tiers = new Map<string, number>();
    const oldTimer = { remove: vi.fn() };
    const applied: string[] = [];
    const timers: Array<{ delay: number; callback: () => void }> = [];
    const scene = {
      ...playbackHarness(Promise.resolve()),
      playGeneration: 4,
      renderedPlaybackState: true,
      playbackActive: true,
      playbackOriginTick: 0,
      playbackOriginSceneTime: 0,
      playbackRenderedSceneTime: 1_000,
      catchUpMs: 1_000,
      timeline: [oldTimer],
      artDecidedTroops: new Set(['mage']),
      armyLevels: { mage: 1, dragon: 1 },
      v2TroopTiers: new Map<string, number>([['mage', 1]]),
      v2TroopLocomotionTiers: tiers,
      requestV2TroopLocomotionArt: vi.fn(() => compact.promise.then(() => {
        tiers.set('dragon', 1);
      })),
      requestV2TroopArt: vi.fn(() => Promise.resolve()),
      requestV2DireEnhancementArt: vi.fn(() => Promise.resolve()),
      apply: (ev: { e: string; id?: number }) => applied.push(`${ev.e}:${String(ev.id ?? '')}`),
      onPos: (ev: { id: number }) => applied.push(`pos:${String(ev.id)}`),
      setPlaybackTimeScale(scale: number) { this.time.timeScale = scale; },
      time: {
        now: 1_000,
        timeScale: 8,
        delayedCall: (delay: number, callback: () => void) => {
          timers.push({ delay, callback });
          return { remove: vi.fn(), getRemaining: () => delay };
        },
      },
    };
    const play = (BattleScene.prototype as unknown as {
      play: (
        events: Array<Record<string, unknown>>, fromTick: number,
        simVersion: number | undefined, appliedPrefix: boolean,
      ) => Promise<void>;
    }).play;
    const events = [
      { e: 'deploy', t: 0, id: 1, troop: 'mage', x: 0, y: 0 },
      { e: 'hit', t: 11, id: 'keep', target: 'keep', dmg: 5 },
      { e: 'deploy', t: 20, id: 2, troop: 'dragon', x: 0, y: 0 },
      { e: 'pos', t: 22, id: 2, x: 512, y: 0 },
      { e: 'hit', t: 24, id: 'keep', target: 'keep', dmg: 10 },
    ];
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const replacement = play.call(scene, events, 20, undefined, true);
      expect(oldTimer.remove).toHaveBeenCalledOnce();
      expect(applied).toEqual([]);
      now.mockReturnValue(1_350);
      compact.resolve();
      await replacement;
      // The field was at tick 10, not RaidUI's wall tick 20. Only the three
      // atlas-wait ticks are hydrated; the owed tick-11 hit is not skipped and
      // the new wall-authored tick-20 deploy remains an ordered future event.
      expect(applied).toEqual(['hit:keep']);
      const deployment = timers.filter((timer) => timer.delay === 650);
      deployment.forEach(({ callback }) => callback());
      expect(applied).toEqual(['hit:keep', 'deploy:2', 'pos:2']);
      const future = timers.find((timer) => timer.delay === 1_050);
      expect(future).toBeDefined();
      future!.callback();
      expect(applied).toEqual(['hit:keep', 'deploy:2', 'pos:2', 'hit:keep']);
      expect(applied.filter((entry) => entry === 'deploy:2')).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it('keeps one canonical boundary, original wait and hidden debt across overlapping replacements', async () => {
    const { BattleScene } = await import('./BattleScene');
    const compact = deferred();
    const tiers = new Map<string, number>();
    const oldTimer = { remove: vi.fn() };
    const applied: string[] = ['hit:prefix', 'hit:boundary'];
    const timers: Array<{ delay: number; callback: () => void }> = [];
    const scene = {
      ...playbackHarness(Promise.resolve()),
      renderedPlaybackState: true,
      playbackActive: true,
      playbackOriginTick: 0,
      playbackOriginSceneTime: 0,
      playbackRenderedSceneTime: 1_000,
      catchUpMs: 900,
      timeline: [oldTimer],
      artDecidedTroops: new Set(['mage', 'bowman']),
      armyLevels: { mage: 1, bowman: 1, dragon: 1 },
      v2TroopTiers: new Map([['mage', 1], ['bowman', 1]]),
      v2TroopLocomotionTiers: tiers,
      requestV2TroopLocomotionArt: vi.fn(() => compact.promise.then(() => {
        tiers.set('dragon', 1);
      })),
      requestV2TroopArt: vi.fn(() => Promise.resolve()),
      requestV2DireEnhancementArt: vi.fn(() => Promise.resolve()),
      resetPauseCatchUp() {
        this.catchUpMs = 0;
        this.playbackActive = false;
        this.time.timeScale = 1;
      },
      apply: (event: { e: string; id?: number; target?: unknown }) => {
        applied.push(`${event.e}:${String(event.id ?? event.target ?? '')}`);
      },
      setPlaybackTimeScale(scale: number) { this.time.timeScale = scale; },
      time: {
        now: 1_000, timeScale: 8,
        delayedCall: (delay: number, callback: () => void) => {
          timers.push({ delay, callback });
          return { remove: vi.fn(), getRemaining: () => delay };
        },
      },
    };
    const play = (BattleScene.prototype as unknown as {
      play: (
        events: Array<Record<string, unknown>>, fromTick: number,
        simVersion: number | undefined, appliedPrefix: boolean,
      ) => Promise<void>;
    }).play;
    const base = [
      { e: 'deploy', t: 0, id: 1, troop: 'mage', x: 0, y: 0 },
      { e: 'hit', t: 5, target: 'prefix', dmg: 1 },
      { e: 'hit', t: 10, target: 'boundary', dmg: 1 },
      { e: 'hit', t: 11, target: 'wall-a', dmg: 1 },
      { e: 'hit', t: 14, target: 'wall-b', dmg: 1 },
      { e: 'deploy', t: 20, id: 2, troop: 'dragon', x: 0, y: 0 },
    ];
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const first = play.call(scene, base, 19, undefined, true);
      now.mockReturnValue(1_200);
      const second = play.call(scene, [
        ...base, { e: 'deploy', t: 22, id: 3, troop: 'bowman', x: 0, y: 0 },
      ], 21, undefined, true);
      now.mockReturnValue(1_400);
      const latestEvents = [
        ...base,
        { e: 'deploy', t: 22, id: 3, troop: 'bowman', x: 0, y: 0 },
        { e: 'deploy', t: 24, id: 4, troop: 'giant', hero: 'theodor', x: 0, y: 0 },
      ];
      const third = play.call(scene, latestEvents, 23, undefined, true);
      now.mockReturnValue(1_500);
      compact.resolve();
      await Promise.all([first, second, third]);

      expect(oldTimer.remove).toHaveBeenCalledOnce();
      expect(applied).toEqual([
        'hit:prefix', 'hit:boundary', 'hit:wall-a', 'hit:wall-b',
      ]);
      expect((scene as unknown as { playbackOriginTick: number }).playbackOriginTick).toBe(15);
      expect(scene.catchUpMs).toBe(900);
      timers.filter(({ delay }) => delay === 500).forEach(({ callback }) => callback());
      timers.filter(({ delay }) => delay === 700).forEach(({ callback }) => callback());
      timers.filter(({ delay }) => delay === 900).forEach(({ callback }) => callback());
      expect(applied.filter((entry) => entry === 'hit:prefix')).toHaveLength(1);
      expect(applied.filter((entry) => entry === 'hit:boundary')).toHaveLength(1);
      expect(applied).toEqual([
        'hit:prefix', 'hit:boundary', 'hit:wall-a', 'hit:wall-b',
        'deploy:2', 'deploy:3', 'deploy:4',
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it('keeps a multi-cycle attackRun across a fractional rendered replacement boundary', async () => {
    const { BattleScene } = await import('./BattleScene');
    const timers: Array<{ delay: number; callback: () => void }> = [];
    const onAttackRun = vi.fn();
    const prototype = BattleScene.prototype as unknown as {
      play: (
        events: Array<Record<string, unknown>>, fromTick: number,
        simVersion: number | undefined, appliedPrefix: boolean,
      ) => void;
      apply: (event: Record<string, unknown>) => void;
    };
    const scene = {
      ...playbackHarness(Promise.resolve()),
      renderedPlaybackState: true,
      playbackActive: true,
      playbackOriginTick: 0,
      playbackOriginSceneTime: 0,
      playbackRenderedSceneTime: 1_350,
      artDecidedTroops: new Set(['mage']),
      v2TroopTiers: new Map([['mage', 1]]),
      onAttackRun,
      apply: prototype.apply,
      time: {
        now: 1_350,
        delayedCall: (delay: number, callback: () => void) => {
          timers.push({ delay, callback });
          return { remove: vi.fn(), getRemaining: () => delay };
        },
      },
    };
    prototype.play.call(scene, [
      { e: 'deploy', t: 0, id: 7, troop: 'mage', x: 0, y: 0 },
      { e: 'attackRun', t: 10, id: 7, side: 'attacker', troop: 'mage',
        targetKind: 'building', target: 'keep', ix: 0, iy: 0,
        mode: 'projectile', technique: 'bolt', cycleMs: 200, releaseOffsetMs: 100,
        cycleTicks: 2, releaseOffsetTicks: 1, impactOffsetsTicks: [2],
        cadenceTicks: 2, count: 4 },
      { e: 'hit', t: 20, target: 'keep', dmg: 1 },
    ], 20, 13, true);

    const suffix = timers.filter(({ delay }) => delay === 50);
    expect(suffix.length).toBeGreaterThan(0);
    suffix.forEach(({ callback }) => callback());
    expect(onAttackRun).toHaveBeenCalledWith(expect.objectContaining({ t: 14, count: 2 }));
  });

  it('cold-seek position hydration mutates the real troop transform without a zero-duration tween', async () => {
    const { BattleScene } = await import('./BattleScene');
    const { TroopFx } = await import('../fx/troop');
    const addTween = vi.fn();
    const killTweensOf = vi.fn();
    const sprite = {
      x: 0, y: 0, depth: 0, active: true,
      setPosition(x: number, y: number) { this.x = x; this.y = y; return this; },
      setDepth(depth: number) { this.depth = depth; return this; },
    };
    const fx = {
      hatchling: null, v2: null, alive: true, sprite, mound: null,
      moveGeneration: 0, meleeGeneration: 0, pendingHeroPos: null,
      compactMeleeOrigin: null,
      scene: { tweens: { add: addTween, killTweensOf } },
      snapPosition: TroopFx.prototype.snapPosition,
    };
    const prototype = BattleScene.prototype as unknown as {
      applyPlaybackStateRange: (
        events: Array<Record<string, unknown>>, start: number, end: number,
      ) => void;
      onPos: (event: Record<string, unknown>, duration?: number) => void;
    };
    const scene = {
      jumping: false,
      troops: new Map([[7, { fx }]]),
      ux: (n: number) => n / 4,
      uy: (n: number) => n / 4,
      onPos: prototype.onPos,
      apply(event: Record<string, unknown>) { this.onPos(event); },
    };
    prototype.applyPlaybackStateRange.call(scene, [
      { e: 'pos', t: 4, id: 7, x: 512, y: 256 },
    ], 0, 5);
    expect(sprite).toMatchObject({ x: 128, y: 64 });
    expect(killTweensOf).toHaveBeenCalledWith(sprite);
    expect(addTween).not.toHaveBeenCalled();
    expect(scene.jumping).toBe(false);
  });

  it('hydrates chain HP and burrow/emerge state without replaying transient FX', async () => {
    const { BattleScene } = await import('./BattleScene');
    const seekBurrowed = vi.fn();
    const seekEmerged = vi.fn();
    const fx = {
      alive: true,
      sprite: { x: 20, y: 30, displayHeight: 40 },
      seekBurrowed,
      seekEmerged,
    };
    const prototype = BattleScene.prototype as unknown as {
      applyPlaybackStateRange: (
        events: Array<Record<string, unknown>>, start: number, end: number,
      ) => void;
      onChain: (event: Record<string, unknown>) => void;
      onBurrow: (event: Record<string, unknown>) => void;
      onEmerge: (event: Record<string, unknown>) => void;
    };
    const scene = {
      jumping: false,
      troops: new Map([[7, { hp: 100, fx, troop: 'tunneler' }]]),
      buildings: new Map([['tesla', { sprite: { x: 0, y: 0 }, type: 'electrictower' }]]),
      ux: (n: number) => n,
      uy: (n: number) => n,
      stopLoop: vi.fn(),
      onChain: prototype.onChain,
      onBurrow: prototype.onBurrow,
      onEmerge: prototype.onEmerge,
      apply(event: Record<string, unknown>) {
        if (event.e === 'chain') this.onChain(event);
        if (event.e === 'burrow') this.onBurrow(event);
        if (event.e === 'emerge') this.onEmerge(event);
      },
    };
    prototype.applyPlaybackStateRange.call(scene, [
      { e: 'chain', t: 1, id: 'tesla', targets: [7], dmg: [25] },
      { e: 'burrow', t: 2, id: 7 },
      { e: 'emerge', t: 4, id: 7, x: 64, y: 96 },
    ], 0, 5);
    expect(scene.troops.get(7)!.hp).toBe(75);
    expect(seekBurrowed).toHaveBeenCalledOnce();
    expect(seekEmerged).toHaveBeenCalledWith(64, 96);
    expect(scene.jumping).toBe(false);
  });

  it('a live secondary chain hop crosses Hexbarrow half health once without triggering a direct-hit flinch', async () => {
    const { BattleScene } = await import('./BattleScene');
    const juice = await import('../../lib/juice');
    const projectiles = await import('../fx/projectiles');
    const zap = vi.spyOn(projectiles, 'zapBolt').mockImplementation(() => undefined);
    const numbers = vi.spyOn(juice, 'floatText').mockImplementation(() => undefined);
    const syncHealth = vi.fn(); const onHit = vi.fn();
    const actor = { hp: 60, maxHp: 100, fx: { alive: true,
      sprite: { x: 20, y: 30, displayHeight: 40 }, v2: { syncHealth, onHit } } };
    const scene = { jumping: false, troops: new Map([[7, actor]]), hitStar: vi.fn(),
      buildings: new Map([['tesla', { type: 'electrictower', sprite: { x: 0, y: 0, displayHeight: 40 } }]]) };
    try {
      (BattleScene.prototype as unknown as { onChain: (event: Record<string, unknown>) => void }).onChain.call(scene,
        { e: 'chain', t: 1, id: 'tesla', targets: [7], dmg: [10] });
      expect(actor.hp).toBe(50);
      expect(syncHealth).toHaveBeenCalledExactlyOnceWith(0.5);
      expect(onHit).not.toHaveBeenCalled();
      expect(zap).toHaveBeenCalledOnce(); expect(numbers).toHaveBeenCalledOnce();
    } finally { zap.mockRestore(); numbers.mockRestore(); }
  });

  it.each(['hit', 'chain'])('cold-seek %s hydrates Hexbarrow persistent health without historical flinches or damage FX', async (kind) => {
    const { BattleScene } = await import('./BattleScene');
    const syncHealth = vi.fn(); const onHit = vi.fn();
    const fx = { alive: true, sprite: { x: 20, y: 30 }, v2: { syncHealth, onHit } };
    const actor = { troop: 'hexbarrow', hp: 100, maxHp: 100, fx };
    const prototype = BattleScene.prototype as unknown as {
      applyColdPlaybackPrefix: (events: Array<Record<string, unknown>>, tick: number) => void;
      onHit: (event: Record<string, unknown>) => void;
      onChain: (event: Record<string, unknown>) => void;
      onHeal: (event: Record<string, unknown>) => void;
    };
    const scene = {
      jumping: false, troops: new Map([[7, actor]]),
      buildings: new Map([['tesla', { sprite: { x: 0, y: 0 }, type: 'electrictower' }]]),
      hitStar: vi.fn(), add: { graphics: vi.fn(() => { throw new Error('cold effects are forbidden'); }) },
      apply(event: Record<string, unknown>) {
        if (event.e === 'hit') prototype.onHit.call(this, event);
        if (event.e === 'chain') prototype.onChain.call(this, event);
        if (event.e === 'heal') prototype.onHeal.call(this, event);
      },
    };
    prototype.applyColdPlaybackPrefix.call(scene, [
      kind === 'hit' ? { e: 'hit', t: 1, target: 7, dmg: 50 }
        : { e: 'chain', t: 1, id: 'tesla', targets: [7], dmg: [50] },
      { e: 'heal', t: 2, id: 7, amount: 500 },
      { e: 'hit', t: 4, target: 7, dmg: 1 }, // seek ends before this future event
    ], 3);
    expect(actor.hp).toBe(100);
    expect(syncHealth).toHaveBeenCalledExactlyOnceWith(0.5);
    expect(onHit).not.toHaveBeenCalled();
    expect(scene.hitStar).not.toHaveBeenCalled();
    expect(scene.add.graphics).not.toHaveBeenCalled();
    expect(scene.jumping).toBe(false);
  });

  it('keeps a cold-seek hero visible and resumes its authoritative wall attack cue', async () => {
    const { BattleScene } = await import('./BattleScene');
    const onHeroAttack = vi.fn();
    const prototype = BattleScene.prototype as unknown as {
      applyPlaybackStateRange: (
        events: Array<Record<string, unknown>>, start: number, end: number,
      ) => void;
      onHeroAttack: (event: Record<string, unknown>) => void;
    };
    const scene = {
      jumping: false,
      troops: new Map<number, { fx: { onHeroAttack: typeof onHeroAttack } }>(),
      ux: (n: number) => n,
      uy: (n: number) => n,
      onHeroAttack: prototype.onHeroAttack,
      apply(event: Record<string, unknown>) {
        if (event.e === 'deploy' && event.hero) {
          this.troops.set(event.id as number, { fx: { onHeroAttack } });
        }
      },
    };
    prototype.applyPlaybackStateRange.call(scene, [
      { e: 'deploy', t: 0, id: 9, troop: 'giant', hero: 'theodor', x: 0, y: 0 },
      {
        e: 'heroAttack', t: 6, id: 9, hero: 'theodor', side: 'attacker',
        targetKind: 'building', target: 'w_6_11', ix: 80, iy: 96, recoveryUntil: 12,
      },
    ], 0, 8);
    expect(scene.troops.has(9), 'the IN BATTLE hero remains a rendered actor').toBe(true);
    expect(onHeroAttack).toHaveBeenCalledWith(80, 96, 400);
  });

  it('restores only active hero-skill body phases with their exact remaining locks', async () => {
    const { BattleScene } = await import('./BattleScene');
    const rage = { finishSeek: vi.fn(), onHeroSkill: vi.fn(), onHeroTravel: vi.fn() };
    const silent = { finishSeek: vi.fn(), onHeroSkill: vi.fn(), onHeroTravel: vi.fn() };
    const degenNear = { finishSeek: vi.fn(), onHeroSkill: vi.fn(), onHeroTravel: vi.fn() };
    const degenExpired = { finishSeek: vi.fn(), onHeroSkill: vi.fn(), onHeroTravel: vi.fn() };
    const prototype = BattleScene.prototype as unknown as {
      applyPlaybackStateRange: (
        events: Array<Record<string, unknown>>, start: number, end: number,
      ) => void;
      resumeHeroSkillPhase: (event: Record<string, unknown>, fromTick: number) => void;
    };
    const scene = {
      jumping: false,
      troops: new Map<number, { fx: typeof rage }>(),
      ux: (n: number) => n,
      uy: (n: number) => n,
      resumeHeroSkillPhase: prototype.resumeHeroSkillPhase,
      apply(event: Record<string, unknown>) {
        if (event.e === 'deploy') {
          this.troops.set(event.id as number, {
            fx: event.id === 1 ? rage : event.id === 2 ? silent
              : event.id === 3 ? degenNear : degenExpired,
          });
        }
      },
    };

    prototype.applyPlaybackStateRange.call(scene, [
      { e: 'deploy', t: 0, id: 1, troop: 'giant', hero: 'theodor', x: 0, y: 0 },
      { e: 'deploy', t: 0, id: 2, troop: 'giant', hero: 'theodor', x: 0, y: 0 },
      { e: 'deploy', t: 0, id: 3, troop: 'giant', hero: 'theodor', x: 0, y: 0 },
      { e: 'deploy', t: 0, id: 4, troop: 'giant', hero: 'vex', x: 0, y: 0 },
      { e: 'heroSkill', t: 1, id: 1, skill: 'rageQuit', phase: 'fakeDeath', until: 2 },
      { e: 'heroSkill', t: 56, id: 1, skill: 'rageQuit', phase: 'fakeDeath', until: 64 },
      { e: 'heroSkill', t: 0, id: 2, skill: 'silentButDeadly', phase: 'windup', until: 80 },
      { e: 'heroSkill', t: 56, id: 3, skill: 'degenAwakening', phase: 'active', until: 100 },
      { e: 'heroSkill', t: 54, id: 4, skill: 'degenAwakening', phase: 'active', until: 100 },
    ], 0, 60);

    expect(rage.finishSeek).toHaveBeenCalledOnce();
    expect(silent.finishSeek).toHaveBeenCalledOnce();
    expect(rage.onHeroSkill).toHaveBeenCalledOnce();
    expect(rage.onHeroSkill).toHaveBeenCalledWith('rageQuit', 'fakeDeath', 400, 400);
    expect(silent.onHeroSkill).toHaveBeenCalledWith(
      'silentButDeadly', 'windup', 2_000, 6_000,
    );
    expect(degenNear.onHeroSkill).toHaveBeenCalledWith(
      'degenAwakening', 'active', 100, 400,
    );
    expect(degenExpired.onHeroSkill).not.toHaveBeenCalled();
    expect(scene.jumping).toBe(false);
  });

  it('hydrates a cold seek with surviving actor position/HP and omits actors already dead', async () => {
    const { BattleScene } = await import('./BattleScene');
    const actors = new Map<number, { hp: number; x: number }>();
    const scene = {
      jumping: false,
      apply: (event: Record<string, unknown>) => {
        const id = event.id as number;
        if (event.e === 'deploy') actors.set(id, { hp: 100, x: event.x as number });
        if (event.e === 'pos') actors.get(id)!.x = event.x as number;
        if (event.e === 'hit' && typeof event.target === 'number') {
          actors.get(event.target)!.hp -= event.dmg as number;
        }
        if (event.e === 'troopDeath') actors.delete(id);
      },
    };
    const hydrate = (BattleScene.prototype as unknown as {
      applyColdPlaybackPrefix: (
        events: Array<Record<string, unknown>>, fromTick: number,
      ) => void;
    }).applyColdPlaybackPrefix;
    hydrate.call(scene, [
      { e: 'deploy', t: 0, id: 1, troop: 'dragon', x: 0, y: 0 },
      { e: 'deploy', t: 0, id: 2, troop: 'mage', x: 0, y: 0 },
      { e: 'pos', t: 2, id: 1, x: 512, y: 0 },
      { e: 'hit', t: 3, target: 1, dmg: 35 },
      { e: 'troopFire', t: 4, id: 1 }, // expired transient: never replay
      { e: 'troopDeath', t: 5, id: 2 },
      { e: 'hit', t: 8, target: 1, dmg: 65 }, // at/after seek: still future
    ], 8);
    expect(actors).toEqual(new Map([[1, { hp: 65, x: 512 }]]));
    expect(scene.jumping).toBe(false);
  });

  it('lets an unresolved entry preload settle for a troop not decided by the first replay', async () => {
    // WHY: ATTACK advances replay generation immediately. That must invalidate
    // timers/audio only; otherwise the create-time promise remains cached after
    // rejecting its own healthy atlas result and the later troop can never
    // adopt current motion without leaving and re-entering the raid.
    const atlas = deferred();
    const ensure = vi.spyOn(atlasLoader, 'ensureV2Atlases')
      .mockReturnValue(atlas.promise);
    const { BattleScene } = await import('./BattleScene');
    const scene = {
      ...playbackHarness(Promise.resolve()),
      playGeneration: 0,
      artLifecycleEpoch: 4,
      armyLevels: { hexbarrow: 1, barrowling: 1 },
      v2meta: { clips: {}, breathStream: null, atlasBytes: {} },
      textures: { exists: () => true },
      v2TroopTiers: new Map<string, number>(),
      v2TroopLocomotionTiers: new Map<string, number>(),
      v2TroopLocomotionLoads: new Map<string, Promise<void>>(),
      v2TroopLoads: new Map<string, Promise<void>>(),
      v2TroopControllerReserved: new Set<string>(),
      reserveV2Candidates: (input: Array<{ id: string }>) =>
        new Set(input.map((candidate) => candidate.id)),
      requestV2TroopLocomotionArt: vi.fn(() => Promise.resolve()),
      rebuildDeployMarks: vi.fn(),
      releaseUngrantableGroups: vi.fn(),
      retainTroopArt: vi.fn(),
    };
    const prototype = BattleScene.prototype as unknown as {
      requestV2TroopArt: (troop: string) => Promise<void>;
      play: (events: Array<Record<string, unknown>>, fromTick?: number) => void;
    };

    try {
      const entryPreload = prototype.requestV2TroopArt.call(scene, 'hexbarrow');
      prototype.play.call(scene, []);
      const reused = prototype.requestV2TroopArt.call(scene, 'barrowling');

      expect(scene.playGeneration).toBe(1);
      expect(scene.artLifecycleEpoch).toBe(4);
      expect(reused).toBe(entryPreload);
      expect(scene.v2TroopTiers).toEqual(new Map());

      atlas.resolve();
      await entryPreload;

      expect(scene.v2TroopTiers).toEqual(new Map([
        ['hexbarrow', 1], ['barrowling', 1],
      ]));
      expect(scene.rebuildDeployMarks).toHaveBeenCalledTimes(2);
      expect(scene.releaseUngrantableGroups).not.toHaveBeenCalled();
    } finally {
      ensure.mockRestore();
    }
  });

  it('rejects stale art work after shutdown/recreate while the new epoch can retry', async () => {
    // WHY: Phaser reuses the BattleScene object. A promise from the old raid
    // must neither adopt into the new raid nor remain in its request cache.
    const oldAtlas = deferred();
    const ensure = vi.spyOn(atlasLoader, 'ensureV2Atlases')
      .mockReturnValueOnce(oldAtlas.promise)
      .mockResolvedValueOnce(undefined);
    const { BattleScene } = await import('./BattleScene');
    const scene = {
      artLifecycleEpoch: 8,
      playGeneration: 0,
      scene: { isActive: () => true },
      armyLevels: { hexbarrow: 1, barrowling: 1 },
      v2meta: { clips: {}, breathStream: null, atlasBytes: {} },
      textures: { exists: () => true },
      v2TroopTiers: new Map<string, number>(),
      v2TroopLocomotionTiers: new Map<string, number>(),
      v2TroopLocomotionLoads: new Map<string, Promise<void>>(),
      v2TroopLoads: new Map<string, Promise<void>>(),
      v2TroopControllerReserved: new Set<string>(),
      artDecidedTroops: new Set<string>(),
      reserveV2Candidates: (input: Array<{ id: string }>) =>
        new Set(input.map((candidate) => candidate.id)),
      requestV2TroopLocomotionArt: vi.fn(() => Promise.resolve()),
      rebuildDeployMarks: vi.fn(),
      releaseUngrantableGroups: vi.fn(),
      retainTroopArt: vi.fn(),
    };
    const request = (BattleScene.prototype as unknown as {
      requestV2TroopArt: (troop: string) => Promise<void>;
    }).requestV2TroopArt;

    try {
      const stale = request.call(scene, 'hexbarrow');
      // Mirrors SHUTDOWN (invalidate + clear) followed by the reused scene's
      // next create() (a fresh epoch).
      scene.artLifecycleEpoch++;
      scene.v2TroopLoads.clear();
      scene.v2TroopControllerReserved.clear();
      scene.artLifecycleEpoch++;

      const retry = request.call(scene, 'hexbarrow');
      expect(retry).not.toBe(stale);
      await retry;
      expect(scene.v2TroopTiers).toEqual(new Map([
        ['hexbarrow', 1], ['barrowling', 1],
      ]));
      expect(scene.rebuildDeployMarks).toHaveBeenCalledTimes(2);

      oldAtlas.resolve();
      await stale;
      expect(scene.rebuildDeployMarks).toHaveBeenCalledTimes(2);
      expect(scene.v2TroopLoads.get('hexbarrow')).toBe(retry);
      expect(scene.releaseUngrantableGroups).toHaveBeenCalledOnce();
    } finally {
      ensure.mockRestore();
    }
  });

  it('does not duplicate an explicitly applied prefix when generation two replaces a stream', async () => {
    const { BattleScene } = await import('./BattleScene');
    const art = deferred();
    const timers: Array<{ delay: number; callback: () => void; remove: ReturnType<typeof vi.fn> }> = [];
    const applied: string[] = [];
    const actors = new Set<number>();
    const scene = {
      ...playbackHarness(art.promise),
      artDecidedTroops: new Set(['dragon']),
      v2TroopLocomotionTiers: new Map([['dragon', 1]]),
      apply: (ev: { e: string; id?: number }) => {
        applied.push(`${ev.e}:${String(ev.id ?? '')}`);
        if (ev.e === 'deploy') actors.add(ev.id!);
      },
      time: {
        now: 0,
        delayedCall: (delay: number, callback: () => void) => {
          const timer = { delay, callback, remove: vi.fn() };
          timers.push(timer);
          return timer;
        },
      },
    };
    const play = (BattleScene.prototype as unknown as {
      play: (
        events: Array<Record<string, unknown>>, fromTick?: number,
        simVersion?: number, appliedPrefix?: boolean,
      ) => void;
    }).play;
    const events = [
      { e: 'deploy', t: 0, id: 7, troop: 'dragon', x: 12_160, y: 6_272 },
      { e: 'hit', t: 1, id: 'wall', target: 'wall', dmg: 5 },
      { e: 'hit', t: 2, id: 'keep', target: 'keep', dmg: 10 },
    ];

    play.call(scene, events);
    timers.find((timer) => timer.delay === 100)!.callback();
    const staleHit = timers.find((timer) => timer.delay === 200)!;
    expect(actors).toEqual(new Set([7]));

    // One and a half rendered Scene-Clock ticks: tick 1 is prefix, while tick 2
    // must retain its final 50 ms rather than duplicate or fire early.
    (scene as Record<string, unknown>).playbackRenderedSceneTime = 150;
    play.call(scene, events, 2, undefined, true);
    const currentHit = timers.filter((timer) => timer.delay === 50).at(-1)!;
    expect(actors).toEqual(new Set([7]));

    staleHit.callback();
    expect(applied).toEqual(['deploy:7', 'hit:wall']);
    currentHit.callback();
    expect(applied).toEqual(['deploy:7', 'hit:wall', 'hit:keep']);

    art.resolve();
    await Promise.resolve();
    expect(scene.artDecidedTroops).toEqual(new Set(['dragon']));
  });

  it('replaces from the rendered Scene Clock while hidden-tab debt is still outstanding', async () => {
    const { BattleScene } = await import('./BattleScene');
    const { RAID_PLAYBACK } = await import('@shardkeep/shared');
    const timers: Array<{
      delay: number; callback: () => void; remove: ReturnType<typeof vi.fn>;
      getRemaining: () => number;
    }> = [];
    const applied: string[] = ['hit:prefix'];
    const prototype = BattleScene.prototype as unknown as {
      play: (
        events: Array<Record<string, unknown>>, fromTick: number,
        simVersion: number | undefined, appliedPrefix: boolean,
      ) => void;
      setPlaybackTimeScale: (scale: number) => void;
    };
    const scene = {
      ...playbackHarness(Promise.resolve()),
      renderedPlaybackState: true,
      playbackActive: true,
      playbackOriginTick: 0,
      playbackOriginSceneTime: 1_000,
      playbackRenderedSceneTime: 1_500, // the field has rendered through tick 5
      catchUpMs: 1_000,                 // RaidUI's wall clock is at tick 15
      catchingUp: true,
      artDecidedTroops: new Set(['bowman']),
      apply: (event: { e: string; id?: number; target?: unknown }) => {
        applied.push(`${event.e}:${String(event.id ?? event.target ?? '')}`);
      },
      time: {
        now: 9_000, timeScale: RAID_PLAYBACK.catchUpTimeScale,
        delayedCall: (delay: number, callback: () => void) => {
          const timer = { delay, callback, remove: vi.fn(), getRemaining: () => delay };
          timers.push(timer);
          return timer;
        },
      },
      tweens: { timeScale: RAID_PLAYBACK.catchUpTimeScale },
      anims: { globalTimeScale: RAID_PLAYBACK.catchUpTimeScale },
      v2Ticker: { setTimeScale: vi.fn() },
      setPlaybackTimeScale: prototype.setPlaybackTimeScale,
    };
    const offDone = bus.on('battle:done', () => applied.push('done'));
    try {
      prototype.play.call(scene, [
        { e: 'hit', t: 3, target: 'keep', dmg: 5 },       // already rendered
        { e: 'hit', t: 6, target: 'keep', dmg: 5 },       // owed ordered suffix
        { e: 'deploy', t: 15, id: 20, troop: 'bowman', x: 0, y: 0 },
        { e: 'deploy', t: 15, id: 21, troop: 'giant', hero: 'theodor', x: 0, y: 0 },
        { e: 'heroAttack', t: 16, id: 21, hero: 'theodor', targetKind: 'building',
          target: 'wall', ix: 0, iy: 0, recoveryUntil: 18 },
      ], 15, undefined, true);

      expect((scene as unknown as { playbackOriginTick: number }).playbackOriginTick).toBe(5);
      expect(scene.catchUpMs).toBe(1_000);
      expect(scene.time.timeScale).toBe(RAID_PLAYBACK.catchUpTimeScale);
      expect(applied).toEqual(['hit:prefix']);

      timers.find(({ delay }) => delay === 100)!.callback();
      expect(applied).toEqual(['hit:prefix', 'hit:keep']);
      const deploys = timers.filter(({ delay }) => delay === 1_000);
      deploys.forEach(({ callback }) => callback());
      expect(applied).toContain('deploy:20');
      expect(applied).toContain('deploy:21');
      expect(applied.filter((entry) => entry === 'hit:prefix')).toHaveLength(1);

      timers.at(-1)!.callback();
      expect(applied.at(-1)).toBe('done');
    } finally {
      offDone();
    }
  });

  it('treats an applied-prefix claim as a cold seek when this scene has rendered nothing', async () => {
    const { BattleScene } = await import('./BattleScene');
    const applied: string[] = [];
    const scene = {
      ...playbackHarness(Promise.resolve()),
      onPos: vi.fn(),
      apply: (event: { e: string; id?: number }) => {
        applied.push(`${event.e}:${String(event.id ?? '')}`);
      },
    };
    const play = (BattleScene.prototype as unknown as {
      play: (
        events: Array<Record<string, unknown>>, fromTick: number,
        simVersion: number | undefined, appliedPrefix: boolean,
      ) => void;
    }).play;
    play.call(scene, [
      { e: 'deploy', t: 0, id: 9, troop: 'giant', hero: 'theodor', x: 0, y: 0 },
      { e: 'hit', t: 3, target: 9, dmg: 10 },
      { e: 'pos', t: 7, id: 9, x: 512, y: 0 },
    ], 5, undefined, true);
    expect(applied).toEqual(['deploy:9', 'hit:']);
    expect((scene as Record<string, unknown>).renderedPlaybackState).toBe(true);
  });

  it('progresses a production-shaped right-edge Dragon and Mage stream', async () => {
    const { BattleScene } = await import('./BattleScene');
    const never = deferred();
    const timers: Array<{ delay: number; callback: () => void }> = [];
    const applied: string[] = [];
    const scene = {
      ...playbackHarness(never.promise),
      // This case exercises right-edge scheduling, not cold art readiness.
      artDecidedTroops: new Set(['dragon', 'mage']),
      v2TroopLocomotionTiers: new Map([['dragon', 1]]),
      requestV2TroopLocomotionArt: vi.fn(() => never.promise),
      requestV2TroopArt: vi.fn(() => never.promise),
      apply: (ev: { e: string; id?: number }) => applied.push(`${ev.e}:${String(ev.id ?? '')}`),
      onPos: (ev: { id: number }) => applied.push(`pos:${String(ev.id)}`),
      time: {
        now: 0,
        delayedCall: (delay: number, callback: () => void) => {
          timers.push({ delay, callback });
          return { remove: vi.fn() };
        },
      },
    };
    const play = (BattleScene.prototype as unknown as {
      play: (events: Array<Record<string, unknown>>, fromTick?: number, simVersion?: number) => void;
    }).play;
    const rightEdge = 47 * 256 + 128;
    play.call(scene, [
      { e: 'deploy', t: 0, id: 1, troop: 'dragon', x: rightEdge, y: 8_320 },
      { e: 'deploy', t: 0, id: 2, troop: 'mage', x: rightEdge, y: 8_576 },
      { e: 'pos', t: 5, id: 1, x: rightEdge - 512, y: 8_320 },
      { e: 'pos', t: 5, id: 2, x: rightEdge - 512, y: 8_576 },
      { e: 'troopFire', t: 6, id: 1, ix: 9_600, iy: 8_320 },
      { e: 'troopFire', t: 6, id: 2, ix: 9_600, iy: 8_576 },
      { e: 'hit', t: 8, id: 'keep', target: 'keep', dmg: 25 },
    ], 0, 10);

    expect(applied).toEqual(['deploy:1', 'deploy:2', 'pos:1', 'pos:2']);
    timers.sort((a, b) => a.delay - b.delay).forEach(({ callback }) => callback());

    expect(applied).toEqual([
      'deploy:1', 'deploy:2', 'pos:1', 'pos:2',
      'troopFire:1', 'troopFire:2', 'hit:keep',
    ]);
  });

  it('pre-arms every v5 Troll even when an actor never reaches contact', async () => {
    const { BattleScene } = await import('./BattleScene');
    const setMeleeDriven = vi.fn();
    const scene = {
      ...playbackHarness(Promise.resolve()),
      artDecidedTroops: new Set(['troll']),
      meleeDrivenIds: new Set<number>(),
      troops: new Map([[4, { fx: { cancelPrime: vi.fn(), setMeleeDriven } }]]),
    };
    const play = (BattleScene.prototype as unknown as {
      play: (events: Array<Record<string, unknown>>, fromTick?: number, simVersion?: number) => Promise<void>;
    }).play;

    await play.call(scene, [
      { e: 'deploy', t: 0, id: 4, troop: 'troll' },
      { e: 'deploy', t: 0, id: 5, troop: 'troll' },
      { e: 'troopDeath', t: 10, id: 5 },
    ], 0, 5);

    expect(scene.meleeDrivenIds).toEqual(new Set([4, 5]));
    expect(setMeleeDriven).toHaveBeenCalledOnce();

    const depsScene = {
      v2TroopTiers: new Map([['troll', 2]]),
      v2TroopLocomotionTiers: new Map<string, number>(),
      armyLevels: { troll: 7 },
      meleeDrivenIds: scene.meleeDrivenIds,
      v2Ticker: {},
      v2meta: { clips: {}, breathStream: null },
    };
    const depsOf = (BattleScene.prototype as unknown as {
      v2TroopDepsOf: (troop: string, id?: number) => { unit: string; tier: number; meleeDriven?: boolean } | undefined;
    }).v2TroopDepsOf;
    expect(depsOf.call(depsScene, 'troll', 5)).toMatchObject({
      unit: 'troll', tier: 2, meleeDriven: true,
    });
  });

  it('retains the generic fallback for a no-cue v4 replay', async () => {
    const { BattleScene } = await import('./BattleScene');
    const setMeleeDriven = vi.fn();
    const scene = {
      ...playbackHarness(Promise.resolve()),
      artDecidedTroops: new Set(['troll']),
      meleeDrivenIds: new Set<number>(),
      troops: new Map([[4, { fx: { cancelPrime: vi.fn(), setMeleeDriven } }]]),
    };
    const play = (BattleScene.prototype as unknown as {
      play: (events: Array<Record<string, unknown>>, fromTick?: number, simVersion?: number) => Promise<void>;
    }).play;

    await play.call(scene, [
      { e: 'deploy', t: 0, id: 4, troop: 'troll' },
      { e: 'troopDeath', t: 10, id: 4 },
    ], 0, 4);

    expect(scene.meleeDrivenIds).toEqual(new Set());
    expect(setMeleeDriven).not.toHaveBeenCalled();
  });

  it('pre-arms a SIM7 troopSpawn Barrowling and dispatches its authoritative contact', async () => {
    const { BattleScene } = await import('./BattleScene');
    const setMeleeDriven = vi.fn();
    const onMeleeAttack = vi.fn();
    const scene = {
      ...playbackHarness(Promise.resolve()),
      artDecidedTroops: new Set([
        'highlander', 'tunneler', 'barrowling', 'bowman', 'kegrunner', 'giant',
      ]),
      meleeDrivenIds: new Set<number>(),
      troops: new Map([[1, { fx: { cancelPrime: vi.fn(), setMeleeDriven } }]]),
    };
    const play = (BattleScene.prototype as unknown as {
      play: (events: Array<Record<string, unknown>>, fromTick?: number, simVersion?: number) => Promise<void>;
    }).play;

    await play.call(scene, [
      { e: 'deploy', t: 0, id: 1, troop: 'highlander' },
      { e: 'deploy', t: 0, id: 2, troop: 'tunneler' },
      {
        e: 'troopSpawn', t: 5, id: 3, from: 30, troop: 'barrowling',
        level: 1, variant: 2, x: 512, y: 768,
      },
      { e: 'deploy', t: 0, id: 4, troop: 'bowman' },
      { e: 'deploy', t: 0, id: 5, troop: 'kegrunner' },
      { e: 'deploy', t: 0, id: 6, troop: 'giant', hero: 'theodor' },
      {
        e: 'troopAttack', t: 8, id: 3, targetKind: 'building', target: 'keep',
        technique: 'strike', ix: 64, iy: 96,
      },
    ], 0, 7);

    expect(scene.meleeDrivenIds).toEqual(new Set([1, 2, 3]));
    expect(setMeleeDriven).toHaveBeenCalledOnce();

    const depsOf = (BattleScene.prototype as unknown as {
      v2TroopDepsOf: (
        troop: string, id?: number, level?: number, variant?: number,
      ) => Record<string, unknown> | undefined;
    }).v2TroopDepsOf;
    expect(depsOf.call({
      v2TroopTiers: new Map([['barrowling', 1]]),
      v2TroopLocomotionTiers: new Map<string, number>(),
      armyLevels: { barrowling: 1 },
      meleeDrivenIds: scene.meleeDrivenIds,
      v2Ticker: {},
      v2meta: { clips: {}, breathStream: null },
    }, 'barrowling', 3, 1, 2)).toMatchObject({
      unit: 'barrowling', tier: 1, variant: 2, meleeDriven: true,
    });

    const attackScene = {
      troops: new Map([[3, {
        troop: 'barrowling', hero: false, fx: { onMeleeAttack },
      }]]),
      ux: (n: number) => n + 100,
      uy: (n: number) => n + 200,
    };
    const onTroopAttack = (BattleScene.prototype as unknown as {
      onTroopAttack: (ev: Record<string, unknown>) => void;
    }).onTroopAttack;
    onTroopAttack.call(attackScene, {
      id: 3, targetKind: 'building', target: 'keep',
      technique: 'strike', ix: 64, iy: 96,
    });
    expect(onMeleeAttack).toHaveBeenCalledWith('building', 164, 296, 'strike');
  });

  it('retains spawned-brood auto-attack fallback before SIM7', async () => {
    const { BattleScene } = await import('./BattleScene');
    const scene = {
      ...playbackHarness(Promise.resolve()),
      artDecidedTroops: new Set(['barrowling']),
      meleeDrivenIds: new Set<number>(),
    };
    const play = (BattleScene.prototype as unknown as {
      play: (events: Array<Record<string, unknown>>, fromTick?: number, simVersion?: number) => Promise<void>;
    }).play;

    await play.call(scene, [{
      e: 'troopSpawn', t: 5, id: 3, from: 30, troop: 'barrowling',
      level: 1, variant: 2, x: 512, y: 768,
    }], 0, 6);

    expect(scene.meleeDrivenIds).toEqual(new Set());
  });

  it('pre-arms from a future cue when an older bundle omits simVersion', async () => {
    const { BattleScene } = await import('./BattleScene');
    const setMeleeDriven = vi.fn();
    const scene = {
      ...playbackHarness(Promise.resolve()),
      artDecidedTroops: new Set(['troll']),
      meleeDrivenIds: new Set<number>(),
      troops: new Map([[4, { fx: { cancelPrime: vi.fn(), setMeleeDriven } }]]),
    };
    const play = (BattleScene.prototype as unknown as {
      play: (events: Array<Record<string, unknown>>, fromTick?: number, simVersion?: number) => Promise<void>;
    }).play;

    await play.call(scene, [
      { e: 'deploy', t: 0, id: 4, troop: 'troll' },
      { e: 'troopAttack', t: 15, id: 4, target: 'keep', ix: 100, iy: 100 },
    ]);

    expect(scene.meleeDrivenIds).toEqual(new Set([4]));
    expect(setMeleeDriven).toHaveBeenCalledOnce();
  });
});

describe('BattleScene Keg Runner detonation placement', () => {
  it('derives one prime-loop lead from packed frames and fps', async () => {
    const { BattleScene } = await import('./BattleScene');
    const lead = (BattleScene.prototype as unknown as {
      kegPrimeLeadTicks: () => number;
    }).kegPrimeLeadTicks;
    const scene = {
      v2TroopTiers: new Map([['kegrunner', 2]]),
      v2meta: {
        clips: {
          v2_trp_kegrunner_t2_prime: { frames: 6, fps: 14 },
        },
      },
    };

    // 6 / 14 seconds = 428.6 ms, rounded up to five 100 ms sim ticks.
    expect(lead.call(scene)).toBe(5);
  });

  it('schedules prime before detonation, including a replay resumed inside the lead window', async () => {
    const { BattleScene } = await import('./BattleScene');
    const prototype = BattleScene.prototype as unknown as {
      play: (events: Array<Record<string, unknown>>, fromTick?: number) => Promise<void>;
      kegPrimeLeadTicks: () => number;
    };
    const calls: Array<{ delay: number; callback: () => void }> = [];
    const onPrime = vi.fn();
    const scene = {
      ...playbackHarness(Promise.resolve()),
      artDecidedTroops: new Set(['kegrunner']),
      v2TroopTiers: new Map([['kegrunner', 1]]),
      v2meta: {
        clips: { v2_trp_kegrunner_t1_prime: { frames: 6, fps: 14 } },
      },
      kegPrimeLeadTicks: prototype.kegPrimeLeadTicks,
      troops: new Map([[3, { fx: { onPrime, cancelPrime: vi.fn() } }]]),
      time: {
        now: 0,
        delayedCall: (delay: number, callback: () => void) => {
          calls.push({ delay, callback });
          return { remove: vi.fn() };
        },
      },
    };
    const play = prototype.play;
    const events = [
      { e: 'deploy', t: 0, id: 3, troop: 'kegrunner' },
      { e: 'detonate', t: 10, id: 3, x: 10, y: 10 },
    ];

    await play.call(scene, events, 8);

    // Full lead would start at tick 5, but a resumed replay at tick 8 primes
    // synchronously and still detonates at its original relative 200 ms point.
    expect(onPrime).toHaveBeenCalledOnce();
    expect(calls.some((call) => call.delay === 200)).toBe(true);
  });

  it('cancels an already-fired prime when replacement playback supersedes its detonation', async () => {
    const { BattleScene } = await import('./BattleScene');
    const prototype = BattleScene.prototype as unknown as {
      play: (events: Array<Record<string, unknown>>, fromTick?: number) => Promise<void>;
      kegPrimeLeadTicks: () => number;
    };
    const calls: Array<{ delay: number; callback: () => void }> = [];
    let priming = false;
    const fx = {
      onPrime: () => { priming = true; },
      cancelPrime: () => { priming = false; },
    };
    const scene = {
      ...playbackHarness(Promise.resolve()),
      artDecidedTroops: new Set(['kegrunner']),
      v2TroopTiers: new Map([['kegrunner', 1]]),
      v2meta: { clips: { v2_trp_kegrunner_t1_prime: { frames: 6, fps: 14 } } },
      kegPrimeLeadTicks: prototype.kegPrimeLeadTicks,
      troops: new Map([[3, { fx }]]),
      time: {
        now: 0,
        delayedCall: (delay: number, callback: () => void) => {
          calls.push({ delay, callback });
          return { remove: vi.fn() };
        },
      },
    };

    await prototype.play.call(scene, [
      { e: 'deploy', t: 0, id: 3, troop: 'kegrunner' },
      { e: 'detonate', t: 10, id: 3, x: 10, y: 10 },
    ]);
    calls.find((call) => call.delay === 500)!.callback();
    expect(priming).toBe(true);

    await prototype.play.call(scene, [
      { e: 'deploy', t: 0, id: 3, troop: 'kegrunner' },
      { e: 'detonate', t: 20, id: 3, x: 20, y: 20 },
    ], 5);
    expect(priming).toBe(false);
  });

  it('clamps prime to a late deployment and runs deploy before prime at the same tick', async () => {
    const { BattleScene } = await import('./BattleScene');
    const prototype = BattleScene.prototype as unknown as {
      play: (events: Array<Record<string, unknown>>, fromTick?: number) => Promise<void>;
      kegPrimeLeadTicks: () => number;
    };
    const calls: Array<{ delay: number; callback: () => void }> = [];
    const onPrime = vi.fn();
    const troops = new Map<number, { fx: { onPrime: () => void; cancelPrime: () => void } }>();
    const scene = {
      ...playbackHarness(Promise.resolve()),
      artDecidedTroops: new Set(['kegrunner']),
      v2TroopTiers: new Map([['kegrunner', 1]]),
      v2meta: { clips: { v2_trp_kegrunner_t1_prime: { frames: 6, fps: 14 } } },
      kegPrimeLeadTicks: prototype.kegPrimeLeadTicks,
      troops,
      apply: (ev: Record<string, unknown>) => {
        if (ev.e === 'deploy') troops.set(ev.id as number, { fx: { onPrime, cancelPrime: vi.fn() } });
      },
      time: {
        now: 0,
        delayedCall: (delay: number, callback: () => void) => {
          calls.push({ delay, callback });
          return { remove: vi.fn() };
        },
      },
    };

    await prototype.play.call(scene, [
      { e: 'deploy', t: 8, id: 3, troop: 'kegrunner' },
      { e: 'detonate', t: 10, id: 3, x: 10, y: 10 },
    ]);
    const atDeploy = calls.filter((call) => call.delay === 800);
    // Production deploy audio shares the authoritative tick, followed by the
    // deploy event and its clamped prime. The extra presentation timer must not
    // disturb the actor-before-prime ordering.
    expect(atDeploy).toHaveLength(3);
    atDeploy.forEach((call) => call.callback());
    expect(onPrime).toHaveBeenCalledOnce();
  });

  it('snaps V2 art to the authoritative event coordinate before the authored blast', async () => {
    const { BattleScene } = await import('./BattleScene');
    const writes: string[] = [];
    const sprite = {
      setPosition: (x: number, y: number) => {
        writes.push(`position:${x},${y}`);
        return sprite;
      },
      setDepth: (y: number) => {
        writes.push(`depth:${y}`);
        return sprite;
      },
    };
    const fx = {
      v2: {}, usesCurrentV2Art: true, sprite,
      onDetonate: () => { writes.push('detonate'); },
    };
    const scene = {
      troops: new Map([[7, { fx }]]),
      stopLoop: vi.fn(),
      ux: (x: number) => x + 100,
      uy: (y: number) => y + 200,
      tweens: { killTweensOf: vi.fn(() => { writes.push('killTween'); }) },
    };
    const onDetonate = (BattleScene.prototype as unknown as {
      onDetonate: (ev: Record<string, unknown>) => void;
    }).onDetonate;

    onDetonate.call(scene, { id: 7, x: 12, y: 34 });

    expect(writes).toEqual([
      'killTween', 'position:112,234', `depth:${WORLD_DEPTH.actor + 234}`, 'detonate',
    ]);
    expect(scene.tweens.killTweensOf).toHaveBeenCalledWith(sprite);
  });

  it('snaps legacy fallback art before its same-tick detonation and death', async () => {
    const { BattleScene } = await import('./BattleScene');
    const writes: string[] = [];
    const sprite = {
      active: true,
      setPosition: (x: number, y: number) => { writes.push(`position:${x},${y}`); return sprite; },
      setDepth: (y: number) => { writes.push(`depth:${y}`); return sprite; },
    };
    const explosion = {
      active: true,
      setDepth: () => explosion,
      setScale: () => explosion,
      setTexture: () => explosion,
      destroy: vi.fn(),
    };
    const scene = {
      troops: new Map([[7, { fx: { v2: null, usesCurrentV2Art: false, sprite } }]]),
      stopLoop: vi.fn(),
      ux: (x: number) => x + 100,
      uy: (y: number) => y + 200,
      tweens: { killTweensOf: vi.fn(() => { writes.push('killTween'); }) },
      add: { image: vi.fn(() => explosion) },
      time: { delayedCall: vi.fn(() => ({ remove: vi.fn() })) },
      cameras: { main: { shake: vi.fn() } },
    };
    const onDetonate = (BattleScene.prototype as unknown as {
      onDetonate: (ev: Record<string, unknown>) => void;
    }).onDetonate;

    onDetonate.call(scene, { id: 7, x: 12, y: 34 });

    expect(writes).toEqual([
      'killTween', 'position:112,234', `depth:${WORLD_DEPTH.actor + 234}`,
    ]);
    expect(scene.add.image).toHaveBeenCalledWith(112, 234, 'fx', 'fx_explosion_f1');
  });

  it('keeps compact-current Keg Runner feedback but never flashes the old explosion', async () => {
    const { BattleScene } = await import('./BattleScene');
    const sprite = {
      setPosition: vi.fn().mockReturnThis(),
      setDepth: vi.fn().mockReturnThis(),
    };
    const onDetonateFx = vi.fn((feedback: () => void) => feedback());
    const scene = {
      troops: new Map([[7, {
        fx: { v2: null, usesCurrentV2Art: true, sprite, onDetonate: onDetonateFx },
      }]]),
      stopLoop: vi.fn(),
      ux: (x: number) => x + 100,
      uy: (y: number) => y + 200,
      tweens: { killTweensOf: vi.fn() },
      add: { image: vi.fn() },
      cameras: { main: { shake: vi.fn() } },
      time: { delayedCall: vi.fn(() => ({ remove: vi.fn() })) },
    };
    const onDetonate = (BattleScene.prototype as unknown as {
      onDetonate: (ev: Record<string, unknown>) => void;
    }).onDetonate;

    onDetonate.call(scene, { id: 7, x: 12, y: 34 });

    expect(onDetonateFx).toHaveBeenCalledOnce();
    expect(scene.add.image).not.toHaveBeenCalled();
  });
});

describe('BattleScene target-aware troop attacks', () => {
  it('dispatches legacy Troll plus SIM7 generic/specialized contacts with authoritative coordinates', async () => {
    const { BattleScene } = await import('./BattleScene');
    const onMeleeAttack = vi.fn();
    const scene = {
      troops: new Map([
        [4, { troop: 'troll', hero: false, fx: { onMeleeAttack } }],
        [5, { troop: 'gloamfang', hero: false, fx: { onMeleeAttack } }],
        [6, { troop: 'highlander', hero: false, fx: { onMeleeAttack } }],
      ]),
      ux: (x: number) => x + 100,
      uy: (y: number) => y + 200,
    };
    const onTroopAttack = (BattleScene.prototype as unknown as {
      onTroopAttack: (ev: Record<string, unknown>) => void;
    }).onTroopAttack;

    onTroopAttack.call(scene, { id: 4, target: 9, ix: 12, iy: 34 });
    onTroopAttack.call(scene, { id: 4, target: 'wall_1', ix: 56, iy: 78 });
    onTroopAttack.call(scene, {
      id: 5, targetKind: 'building', target: 'keep', technique: 'rend', ix: 90, iy: 12,
    });
    onTroopAttack.call(scene, {
      id: 6, targetKind: 'building', target: 'wall_2', technique: 'strike', ix: 4, iy: 8,
    });

    expect(onMeleeAttack).toHaveBeenNthCalledWith(1, 'troop', 112, 234, 'slam');
    expect(onMeleeAttack).toHaveBeenNthCalledWith(2, 'building', 156, 278, 'slam');
    expect(onMeleeAttack).toHaveBeenNthCalledWith(3, 'building', 190, 212, 'rend');
    expect(onMeleeAttack).toHaveBeenNthCalledWith(4, 'building', 104, 208, 'strike');
  });
});

describe('BattleScene pending actor promotion', () => {
  it('fans repeated accepted placements inside their one authoritative tile and publishes the exact count', async () => {
    const { BattleScene, deployPreviewOffset } = await import('./BattleScene');
    const sprite = () => ({
      setPosition: vi.fn().mockReturnThis(),
      setAlpha: vi.fn().mockReturnThis(),
      setDepth: vi.fn().mockReturnThis(),
    });
    const sprites = [sprite(), sprite(), sprite(), sprite()];
    const badge = {
      destroy: vi.fn(), setOrigin: vi.fn().mockReturnThis(), setDepth: vi.fn().mockReturnThis(),
    };
    const addText = vi.fn(() => badge);
    const scene = {
      marks: sprites.map((value) => ({ troop: 'dragon', tx: 3, ty: 4, sprite: value })),
      markBadges: new Map(),
      add: { text: addText },
    };
    const refresh = (BattleScene.prototype as unknown as {
      refreshDeployStack: (this: typeof scene, tx: number, ty: number) => void;
    }).refreshDeployStack;

    refresh.call(scene, 3, 4);

    const offsets = sprites.map((value) => value.setPosition.mock.calls[0]!.join(','));
    expect(new Set(offsets).size).toBe(4);
    expect(addText).toHaveBeenCalledWith(252, 260, '×4', expect.any(Object));
    expect(scene.markBadges.get('3,4')).toBe(badge);
    // Even a hold-drop well beyond the eight direction slots has one distinct
    // position per ring plus the count; no accepted order can masquerade as one.
    expect(new Set(Array.from({ length: 16 }, (_, index) => {
      const p = deployPreviewOffset(index, 16);
      return `${p.x},${p.y}`;
    })).size).toBe(16);
  });

  it('promotes stacked identical placement actors FIFO without recreating them', async () => {
    const { BattleScene } = await import('./BattleScene');
    const actor = () => {
      const sprite = {
        x: 0, y: 0,
        setPosition: vi.fn(function (this: { x: number; y: number }, x: number, y: number) {
          this.x = x; this.y = y; return this;
        }),
        setAlpha: vi.fn().mockReturnThis(),
        setDepth: vi.fn().mockReturnThis(),
      };
      return { sprite, setNearestBuildingFn: vi.fn(), setMeleeDriven: vi.fn() };
    };
    const first = actor();
    const second = actor();
    const graphics = {
      setDepth: vi.fn().mockReturnThis(), clear: vi.fn(), fillStyle: vi.fn(),
      fillRect: vi.fn(), setVisible: vi.fn(), destroy: vi.fn(),
    };
    const scene = {
      marks: [
        { troop: 'highlander', tx: 3, ty: 4, fx: first, sprite: first.sprite },
        { troop: 'highlander', tx: 3, ty: 4, fx: second, sprite: second.sprite },
      ],
      troops: new Map(), armyLevels: {}, heroLevels: {}, meleeDrivenIds: new Set(),
      add: { graphics: () => graphics }, loops: new Map(),
      refreshDeployStack: vi.fn(),
      ux: (n: number) => n / 4, uy: (n: number) => n / 4,
      nearestBuildingX: () => null,
    };
    const onDeploy = (BattleScene.prototype as unknown as {
      onDeploy: (ev: Record<string, unknown>) => void;
    }).onDeploy;
    const event = { troop: 'highlander', x: 3 * 256 + 128, y: 4 * 256 + 128 };

    onDeploy.call(scene, { ...event, id: 10 });
    onDeploy.call(scene, { ...event, id: 11 });

    expect((scene.troops.get(10) as { fx: unknown }).fx).toBe(first);
    expect((scene.troops.get(11) as { fx: unknown }).fx).toBe(second);
    expect(scene.marks).toHaveLength(0);
  });
});

describe('BattleScene live troop multiplicity', () => {
  async function fixture() {
    const { BattleScene } = await import('./BattleScene');
    const texts: Array<ReturnType<typeof text>> = [];
    function text(label: string) {
      return { label, setText: vi.fn(), setPosition: vi.fn().mockReturnThis(),
        setOrigin: vi.fn().mockReturnThis(), setDepth: vi.fn().mockReturnThis(), destroy: vi.fn() };
    }
    const actor = (x = 100, y = 100) => ({
      fx: { alive: true, sprite: { active: true, visible: true, alpha: 1, x, y, displayHeight: 50 },
        destroy: vi.fn() },
      bar: { destroy: vi.fn() },
    });
    const troops = new Map([[10, actor()], [11, actor()], [12, actor()]]);
    const scene = Object.assign(Object.create(BattleScene.prototype), {
      troops, liveTroopBadges: new Map(), retiredTroopIds: new Map(), jumping: true,
      stopLoop: vi.fn(), clearTransientFx: vi.fn(), retileSurvivingWalls: vi.fn(),
      add: { text: vi.fn((_x: number, _y: number, label: string) => {
        const result = text(label); texts.push(result); return result;
      }) },
    }) as {
      refreshLiveTroopStacks(): void;
      onTroopDeath(event: { id: number }): void;
      resetPlaybackActors(ids: Set<number>): void;
    };
    return { scene, troops, actor, texts };
  }

  it('counts coincident living bodies, excluding nearby, invisible and dead actors without moving them', async () => {
    const { scene, troops, actor, texts } = await fixture();
    troops.set(13, actor(102, 100));
    const invisible = actor(); invisible.fx.sprite.visible = false; troops.set(14, invisible);
    const dead = actor(); dead.fx.alive = false; troops.set(15, dead);
    const transparent = actor(); transparent.fx.sprite.alpha = 0; troops.set(16, transparent);
    const before = [...troops].map(([id, t]) => [id, t.fx.sprite.x, t.fx.sprite.y]);
    scene.refreshLiveTroopStacks();
    expect(texts.map((t) => t.label)).toEqual(['×3']);
    expect(texts[0]!.setPosition).toHaveBeenLastCalledWith(100, 44);
    expect([...troops].map(([id, t]) => [id, t.fx.sprite.x, t.fx.sprite.y])).toEqual(before);
  });

  it('reuses a moving stack badge and removes it when those actors separate', async () => {
    const { scene, troops, texts } = await fixture();
    scene.refreshLiveTroopStacks();
    for (const t of troops.values()) t.fx.sprite.x = 140;
    scene.refreshLiveTroopStacks();
    expect(texts).toHaveLength(1);
    expect(texts[0]!.setText).not.toHaveBeenCalled();
    expect(texts[0]!.setPosition).toHaveBeenLastCalledWith(140, 44);
    troops.get(11)!.fx.sprite.x = 150;
    troops.get(12)!.fx.sprite.x = 160;
    scene.refreshLiveTroopStacks();
    expect(texts[0]!.destroy).toHaveBeenCalledOnce();
    expect(troops.size).toBe(3);
  });

  it('tracks authoritative deaths and corrected replay actors without retaining their previous count', async () => {
    const { scene, troops, actor, texts } = await fixture();
    scene.refreshLiveTroopStacks();
    scene.onTroopDeath({ id: 12 });
    scene.refreshLiveTroopStacks();
    expect(texts[0]!.setText).toHaveBeenCalledWith('×2');
    expect(troops.size).toBe(2);
    scene.resetPlaybackActors(new Set([10, 11]));
    scene.refreshLiveTroopStacks();
    expect(texts[0]!.destroy).toHaveBeenCalledOnce();
    expect(troops.size).toBe(0);
    // A cold replay rebuild may reuse actor ids. Its count comes only from the
    // newly hydrated bodies; no previous stream/death badge can survive.
    troops.set(10, actor()); troops.set(11, actor());
    scene.refreshLiveTroopStacks();
    expect(texts.map((t) => t.label)).toEqual(['×3', '×2']);
  });
});

describe('BattleScene rejected-rich projectile generation guard', () => {
  it('renders the defender Wyrmling breath cue from the spawned body', async () => {
    const { BattleScene } = await import('./BattleScene');
    const frames: string[] = [];
    const image = {
      active: true,
      setDepth: vi.fn().mockReturnThis(), setOrigin: vi.fn().mockReturnThis(),
      setScale: vi.fn().mockReturnThis(), setPosition: vi.fn().mockReturnThis(),
      setRotation: vi.fn().mockReturnThis(),
      setTexture: vi.fn((_atlas: string, frame: string) => { frames.push(frame); return image; }),
      destroy: vi.fn(),
    };
    const scene = Object.assign(Object.create(BattleScene.prototype), {
      troops: new Map([[91, {
        troop: 'wyrmling', hero: false,
        fx: {
          v2: null, sprite: { x: 20, y: 30, displayHeight: 20, depth: 30 },
          onRangedAttack: vi.fn((
            _x: number, _y: number, release: (at: { x: number; y: number }) => void,
          ) => release({ x: 20, y: 20 })),
        },
      }]]),
      ux: (x: number) => x, uy: (y: number) => y,
      waremeta: { clips: {
        ware_unt_hatchling_t1_attack: { cellW: 80, cellH: 64, frames: 6, rows: 8 },
        ware_fx_hatchfire: { cellW: 24, cellH: 16, frames: 3, rows: 8, fps: 12 },
        ware_fx_hatchhit: { cellW: 24, cellH: 16, frames: 3, rows: 1, fps: 12 },
      } },
      textures: { exists: vi.fn(() => true) },
      add: { image: vi.fn((_x: number, _y: number, atlas: string, frame: string) => {
        frames.push(`${atlas}/${frame}`); return image;
      }) },
      time: { delayedCall: vi.fn(() => ({ remove: vi.fn() })) },
    });
    const fire = (BattleScene.prototype as unknown as {
      onTroopFire: (ev: Record<string, unknown>) => void;
    }).onTroopFire;

    fire.call(scene, { id: 91, ix: 100, iy: 50 });

    expect((scene.troops.get(91) as { fx: { onRangedAttack: ReturnType<typeof vi.fn> } })
      .fx.onRangedAttack).toHaveBeenCalledWith(100, 50, expect.any(Function));
    expect(frames[0]).toBe('warefx/ware_fx_hatchfire_d0_f1');
    expect(frames.join(' ')).not.toMatch(/fx_breath_wyrm|legacy|batch13/);
  });

  it('routes every essential ART_V2 fallback shot to compact-current textures only', async () => {
    const { BattleScene } = await import('./BattleScene');
    const writes: string[] = [];
    const image = (atlas: string, frame: string) => {
      const value = {
        active: true,
        setDepth: () => value,
        setOrigin: () => value,
        setScale: () => value,
        setRotation: () => value,
        setAlpha: () => value,
        setPosition: () => value,
        setTexture: (nextAtlas: string, nextFrame: string) => {
          writes.push(`${nextAtlas}/${nextFrame}`); return value;
        },
        destroy: () => { value.active = false; },
      };
      writes.push(`${atlas}/${frame}`);
      return value;
    };
    const travel = {
      frames: 3, rows: 8, cellW: 32, cellH: 32,
      anchorPx: [16, 16], fps: 14, loop: true, travel: true,
    };
    const impact = {
      frames: 4, rows: 1, cellW: 40, cellH: 40,
      anchorPx: [20, 26], fps: 18, loop: false,
    };
    const scene = Object.assign(Object.create(BattleScene.prototype), {
      troops: new Map<number, unknown>(),
      armyLevels: {
        dragon: 1, giant: 1, bowman: 1, mage: 1, hexbarrow: 1,
      },
      v2TroopFallbackFxTiers: new Map([
        ['dragon', 1], ['giant', 1], ['bowman', 1], ['mage', 1], ['hexbarrow', 1],
      ]),
      v2meta: {
        clips: {
          v2_fx_breath_t1: { ...impact, cellW: 80, anchorPx: [8, 20] },
          v2_fx_boulder_t1: travel,
          v2_fx_arrow_t1: travel,
          v2_fx_bolt_t1: travel,
          v2_fx_hexshot_t1: travel,
          v2_fx_shadow: { frames: 3, rows: 1, cellW: 20, cellH: 12, anchorPx: [10, 6] },
          v2_fx_impact_burn_t1: impact,
          v2_fx_impact_rubble_t1: impact,
          v2_fx_bolt_hit_t1: impact,
          v2_fx_impact_crater_t1: impact,
        },
      },
      ux: (x: number) => x,
      uy: (y: number) => y,
      textures: { exists: () => true },
      add: { image: (x: number, y: number, atlas: string, frame: string) => image(atlas, frame) },
      time: {
        delayedCall: () => ({ remove: vi.fn() }),
        addEvent: () => ({ remove: vi.fn() }),
      },
      tweens: { addCounter: () => ({}) },
    });
    const fire = (BattleScene.prototype as unknown as {
      onTroopFire: (ev: Record<string, unknown>) => void;
    }).onTroopFire;
    const sprite = { x: 20, y: 30, displayHeight: 20, depth: 30 };

    for (const [id, troop] of [
      [1, 'dragon'], [2, 'giant'], [3, 'bowman'], [4, 'mage'], [5, 'hexbarrow'],
    ] as const) {
      scene.troops.set(id, { troop, hero: false, fx: { v2: null, sprite } });
      fire.call(scene, {
        id, ix: 100, iy: 50, ...(troop === 'giant' ? { proj: 'boulder' } : {}),
      });
    }

    expect(writes.length).toBeGreaterThanOrEqual(6);
    expect(writes.every((write) => /^v2(?:trp|bld)_[a-z]+_t1_compactfx\//.test(write)),
      writes.join(', ')).toBe(true);
    expect(writes.some((write) => /^(?:fx|trp|trpdg|v2fx)\//.test(write))).toBe(false);
  });

  it('draws nothing instead of an old shot when compact-current FX admission is absent', async () => {
    const { BattleScene } = await import('./BattleScene');
    const addImage = vi.fn();
    const scene = Object.assign(Object.create(BattleScene.prototype), {
      troops: new Map<number, unknown>(),
      armyLevels: { dragon: 1, giant: 1, bowman: 1, mage: 1, hexbarrow: 1 },
      v2TroopFallbackFxTiers: new Map<string, number>(),
      v2meta: { clips: {} },
      ux: (x: number) => x,
      uy: (y: number) => y,
      textures: { exists: () => true },
      add: { image: addImage },
    });
    const fire = (BattleScene.prototype as unknown as {
      onTroopFire: (ev: Record<string, unknown>) => void;
    }).onTroopFire;
    const sprite = { x: 20, y: 30, displayHeight: 20, depth: 30 };
    for (const [id, troop] of [
      [1, 'dragon'], [2, 'giant'], [3, 'bowman'], [4, 'mage'], [5, 'hexbarrow'],
    ] as const) {
      scene.troops.set(id, { troop, hero: false, fx: { v2: null, sprite } });
      fire.call(scene, {
        id, ix: 100, iy: 50, ...(troop === 'giant' ? { proj: 'boulder' } : {}),
      });
    }
    expect(addImage).not.toHaveBeenCalled();
  });
});

describe('BattleScene future troop replay contracts', () => {
  it('excludes positive-level API roots whose deployable count is zero', async () => {
    const { countedArmyTroopTypes } = await import('./BattleScene');
    expect(countedArmyTroopTypes(
      { bowman: 4, dragon: 8, mage: 2, troll: 0 },
      { bowman: 30, dragon: 0, mage: 0, troll: 12 },
    )).toEqual(['bowman']);
  });

  it('joins an already-running Bowman compact load instead of reporting ready', async () => {
    const { BattleScene } = await import('./BattleScene');
    const compact = deferred();
    const scene = {
      artLifecycleEpoch: 1,
      v2TroopLocomotionLoads: new Map([['bowman', compact.promise]]),
    };
    const request = (BattleScene.prototype as unknown as {
      requestV2TroopLocomotionArt: (troops: string[]) => Promise<void>;
    }).requestV2TroopLocomotionArt;
    let settled = false;
    const joined = request.call(scene, ['bowman']).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    compact.resolve();
    await joined;
    expect(settled).toBe(true);
  });

  it('prewarms Bowman draw/loose/idle plus current projectile and impact as one family', async () => {
    const { BattleScene } = await import('./BattleScene');
    const candidates: Array<{ id: string; groups: readonly string[] }> = [];
    const scene = {
      artLifecycleEpoch: 1,
      scene: { isActive: () => true },
      armyLevels: { bowman: 1 },
      v2meta: { clips: bowmanCompactClips(), breathStream: null, atlasBytes: {} },
      textures: { exists: () => true },
      v2TroopLocomotionTiers: new Map<string, number>(),
      v2TroopLocomotionLoads: new Map<string, Promise<void>>(),
      v2TroopLocomotionGeneration: new Map<string, number>(),
      v2TroopFallbackFxTiers: new Map<string, number>(),
      artDecidedTroops: new Set<string>(),
      reserveV2Candidates: (input: Array<{ id: string; groups: readonly string[] }>) => {
        candidates.push(...input);
        return new Set(input.map(({ id }) => id));
      },
      rebuildDeployMarks: vi.fn(),
      releaseUngrantableGroups: vi.fn(),
      retainTroopArt: vi.fn(),
    };
    const request = (BattleScene.prototype as unknown as {
      requestV2TroopLocomotionArt: (troops: string[]) => Promise<void>;
    }).requestV2TroopLocomotionArt;

    await request.call(scene, ['bowman']);

    expect(candidates).toEqual([{
      id: 'locomotion:bowman:t1',
      groups: ['v2trp_bowman_t1_combatcore', 'v2trp_bowman_t1_compactfx'],
    }]);
    expect(scene.v2TroopLocomotionTiers.get('bowman')).toBe(1);
    expect(scene.v2TroopFallbackFxTiers.get('bowman')).toBe(1);
  });

  it('adopts current attacker art before first deploy and refuses a completion after freeze', async () => {
    const { BattleScene, freezeTroopArtFamily } = await import('./BattleScene');
    const preGate = deferred();
    const postGate = deferred();
    const makeScene = (gate: Deferred) => {
      const loaded = new Set<string>();
      return {
        gate,
        loaded,
        scene: {
          artLifecycleEpoch: 1,
          scene: { isActive: () => true },
          armyLevels: { bowman: 1 },
          v2meta: { clips: bowmanCompactClips(), breathStream: null, atlasBytes: {} },
          textures: { exists: (group: string) => loaded.has(group) },
          v2TroopLocomotionTiers: new Map<string, number>(),
          v2TroopLocomotionLoads: new Map<string, Promise<void>>(),
          v2TroopLocomotionGeneration: new Map<string, number>(),
          v2TroopFallbackFxTiers: new Map<string, number>(),
          artDecidedTroops: new Set<string>(),
          reserveV2Candidates: (input: Array<{ id: string }>) =>
            new Set(input.map(({ id }) => id)),
          rebuildDeployMarks: vi.fn(),
          releaseUngrantableGroups: vi.fn(),
          retainTroopArt: vi.fn(),
        },
      };
    };
    const pre = makeScene(preGate);
    const post = makeScene(postGate);
    const ensure = vi.spyOn(atlasLoader, 'ensureV2Atlases')
      .mockImplementation(async (target, groups) => {
        const harness = (target as unknown) === pre.scene ? pre : post;
        await harness.gate.promise;
        for (const group of groups) harness.loaded.add(group);
      });
    const request = (BattleScene.prototype as unknown as {
      requestV2TroopLocomotionArt: (troops: string[]) => Promise<void>;
    }).requestV2TroopLocomotionArt;

    try {
      const before = request.call(pre.scene, ['bowman']);
      preGate.resolve();
      await before;
      expect(pre.scene.v2TroopLocomotionTiers.get('bowman')).toBe(1);

      const after = request.call(post.scene, ['bowman']);
      freezeTroopArtFamily(post.scene.artDecidedTroops, 'bowman');
      postGate.resolve();
      await after;
      expect(post.scene.v2TroopLocomotionTiers.has('bowman')).toBe(false);
      expect(post.scene.releaseUngrantableGroups).toHaveBeenCalled();
    } finally {
      ensure.mockRestore();
    }
  });

  it('retries a failed attacker family once and never polls again in the same raid', async () => {
    const { BattleScene } = await import('./BattleScene');
    const ensure = vi.spyOn(atlasLoader, 'ensureV2Atlases')
      .mockRejectedValue(new Error('offline'));
    const scene = {
      artLifecycleEpoch: 1,
      scene: { isActive: () => true },
      armyLevels: { bowman: 1 },
      v2meta: { clips: bowmanCompactClips(), breathStream: null, atlasBytes: {} },
      textures: { exists: () => false },
      v2TroopLocomotionTiers: new Map<string, number>(),
      v2TroopLocomotionLoads: new Map<string, Promise<void>>(),
      v2TroopLocomotionGeneration: new Map<string, number>(),
      v2TroopFallbackFxTiers: new Map<string, number>(),
      artDecidedTroops: new Set<string>(),
      reserveV2Candidates: (input: Array<{ id: string }>) =>
        new Set(input.map(({ id }) => id)),
      rebuildDeployMarks: vi.fn(),
      releaseUngrantableGroups: vi.fn(),
      retainTroopArt: vi.fn(),
    };
    const request = (BattleScene.prototype as unknown as {
      requestV2TroopLocomotionArt: (troops: string[]) => Promise<void>;
    }).requestV2TroopLocomotionArt;

    try {
      await request.call(scene, ['bowman']);
      await request.call(scene, ['bowman']);
      expect(ensure).toHaveBeenCalledTimes(2);
      expect(scene.v2TroopLocomotionLoads.has('bowman')).toBe(true);
      expect(scene.v2TroopLocomotionTiers.has('bowman')).toBe(false);
    } finally {
      ensure.mockRestore();
    }
  });

  it('keeps a successful cold-cache Archer family when another WARE family fails', async () => {
    const { BattleScene } = await import('./BattleScene');
    const loaded = new Set<string>();
    const adopted: Set<string>[] = [];
    const ensure = vi.spyOn(atlasLoader, 'ensureV2Atlases')
      .mockImplementation(async (_target, groups) => {
        const requested = [...groups];
        if (!requested.some((group) => group.includes('archer'))) {
          throw new Error('mage family unavailable');
        }
        requested.forEach((group) => loaded.add(group));
      });
    const scene = {
      artLifecycleEpoch: 1,
      scene: { isActive: () => true, get: () => undefined },
      buildings: new Map([
        ['archer', { type: 'archertower', level: 1 }],
        ['mage', { type: 'magetower', level: 1 }],
        ['idle-barracks', { type: 'barracks', level: 1 }],
      ]),
      textures: { exists: (group: string) => loaded.has(group) },
      defenseArtLoads: new Map<string, Promise<void>>(),
      defenseSharedReservations: new Set<string>(),
      releaseDefenseFxLease: null,
      releaseWareFxLease: null,
      reserveDefenseArt: vi.fn(() => true),
      adoptV2Defenses: vi.fn(() => false),
      adoptWareBuildings: vi.fn((groups: Set<string>) => {
        adopted.push(groups);
        return true;
      }),
    };
    const request = (BattleScene.prototype as unknown as {
      requestDefenseArtForEvents: (events: Array<Record<string, unknown>>) => Promise<void>[];
    }).requestDefenseArtForEvents;

    try {
      await Promise.all(request.call(scene, [
        { e: 'fire', t: 5, id: 'archer' },
        { e: 'fire', t: 5, id: 'mage' },
      ]));

      expect(adopted).toHaveLength(1);
      expect([...adopted[0]!]).toEqual(['ware_archer_1']);
      expect(loaded).toEqual(new Set(['ware_archer_1', 'warefx']));
      // Archer fire/reload and its arrow/impact sheet are one atomic candidate.
      expect(scene.reserveDefenseArt).toHaveBeenCalledWith(expect.objectContaining({
        bodyGroup: 'ware_archer_1', groups: ['ware_archer_1', 'warefx'],
      }));
      expect(scene.reserveDefenseArt).toHaveBeenCalledTimes(2);
      expect(scene.reserveDefenseArt).not.toHaveBeenCalledWith(expect.objectContaining({
        bodyGroup: 'ware_barracks_1',
      }));
      expect(ensure).toHaveBeenCalledTimes(3); // Archer once; failed Mage twice.
    } finally {
      ensure.mockRestore();
    }
  });

  it.each([[1, 1], [2, 6], [3, 11], [4, 16]] as const)(
    'prioritizes T%i Dragon Nest body, hatchling lifecycle and WARE FX atomically',
    async (tier, level) => {
      const { BattleScene } = await import('./BattleScene');
      const scene = {
        artDecidedDefenses: new Set<string>(),
        buildings: new Map([
          ['archer', { type: 'archertower', level: 16 }],
          ['nest', { type: 'dragonnest', level }],
        ]),
        defenseArtLoads: new Map<string, Promise<void>>(),
        reserveDefenseArt: vi.fn(() => false),
      };
      const request = (BattleScene.prototype as unknown as {
        requestDefenseArtForEvents: (events: Array<Record<string, unknown>>) => Promise<void>[];
      }).requestDefenseArtForEvents;

      expect(request.call(scene, [
        { e: 'fire', t: 4, id: 'archer' },
        { e: 'spawn', t: 5, from: 'nest' },
      ])).toEqual([]);
      expect(scene.reserveDefenseArt).toHaveBeenNthCalledWith(1, expect.objectContaining({
        bodyGroup: `ware_dragonnest_${tier}`,
        groups: [`ware_dragonnest_${tier}`, `ware_hatchling_${tier}`, 'warefx'],
      }));
    },
  );

  it('reserves the exact snapshot Nest dependencies before the placement-rich listener', async () => {
    const { BattleScene } = await import('./BattleScene');
    const prototype = BattleScene.prototype as unknown as {
      requestSnapshotNestArt: (buildings: Array<Record<string, unknown>>) => Promise<void>[];
      requestDefenseArtCandidates: (candidates: Array<Record<string, unknown>>) => Promise<void>[];
    };
    const reserveDefenseArt = vi.fn((_candidate: Record<string, unknown>) => false);
    const scene = {
      artLifecycleEpoch: 1,
      defenseArtLoads: new Map<string, Promise<void>>(),
      defenseSharedReservations: new Set<string>(),
      reserveDefenseArt,
      requestDefenseArtCandidates: prototype.requestDefenseArtCandidates,
    };
    const levels = [1, 6, 11, 16];
    expect(prototype.requestSnapshotNestArt.call(scene, levels.map((level, index) => ({
      id: `nest-${index}`, type: 'dragonnest', level, tx: index, ty: 0,
    })))).toEqual([]);
    expect(reserveDefenseArt.mock.calls.map(([candidate]) => candidate)).toEqual(
      [1, 2, 3, 4].map((tier) => expect.objectContaining({
        bodyGroup: `ware_dragonnest_${tier}`,
        groups: [`ware_dragonnest_${tier}`, `ware_hatchling_${tier}`, 'warefx'],
      })),
    );

    const source = readFileSync(new URL('./BattleScene.ts', import.meta.url), 'utf8');
    const nestReservation = source.indexOf('const nestBootLoads = this.requestSnapshotNestArt');
    const optionalPlacement = source.indexOf("bus.on('battle:mark'");
    expect(nestReservation).toBeGreaterThanOrEqual(0);
    expect(optionalPlacement).toBeGreaterThanOrEqual(0);
    expect(nestReservation).toBeLessThan(optionalPlacement);
  });

  it('releases a rejected Nest body and unique Hatchling so the same scene can retry', async () => {
    const { BattleScene } = await import('./BattleScene');
    const loaded = new Set<string>();
    let attempt = 0;
    const ensure = vi.spyOn(atlasLoader, 'ensureV2Atlases')
      .mockImplementation(async (_scene, groups) => {
        attempt++;
        if (attempt <= 2) throw new Error('missing hatchling');
        for (const group of groups) loaded.add(group);
      });
    const releaseGroups = vi.spyOn(atlasLoader, 'releaseAtlasGroups')
      .mockImplementation(() => 0);
    const releaseReservations = vi.spyOn(atlasLoader, 'releaseAtlasReservations')
      .mockImplementation(() => undefined);
    const retain = vi.spyOn(atlasLoader, 'retainAtlasGroups').mockImplementation(() => vi.fn());
    const prototype = BattleScene.prototype as unknown as {
      requestSnapshotNestArt: (buildings: Array<Record<string, unknown>>) => Promise<void>[];
      requestDefenseArtCandidates: (candidates: Array<Record<string, unknown>>) => Promise<void>[];
    };
    const scene = {
      artLifecycleEpoch: 1,
      scene: { isActive: () => true, get: () => undefined },
      textures: { exists: (group: string) => loaded.has(group) },
      defenseArtLoads: new Map<string, Promise<void>>(),
      defenseSharedReservations: new Set<string>(),
      wareDependencyLeases: new Map<string, () => void>(),
      releaseDefenseFxLease: null,
      releaseWareFxLease: null,
      reserveDefenseArt: vi.fn(() => true),
      adoptV2Defenses: vi.fn(() => false),
      adoptWareBuildings: vi.fn(() => true),
      requestDefenseArtCandidates: prototype.requestDefenseArtCandidates,
    };
    const snapshot = [{ id: 'nest', type: 'dragonnest', level: 16, tx: 0, ty: 0 }];
    try {
      await Promise.all(prototype.requestSnapshotNestArt.call(scene, snapshot));
      expect(scene.defenseArtLoads.size).toBe(0);
      expect(scene.defenseSharedReservations).toEqual(new Set(['warefx']));
      expect(releaseGroups).toHaveBeenCalledWith(
        scene, ['ware_dragonnest_4', 'ware_hatchling_4'],
      );
      expect(releaseReservations).toHaveBeenCalledWith(
        scene, ['ware_dragonnest_4', 'ware_hatchling_4'],
      );

      await Promise.all(prototype.requestSnapshotNestArt.call(scene, snapshot));
      expect(scene.reserveDefenseArt).toHaveBeenCalledTimes(2);
      expect(attempt).toBe(3);
      expect(scene.adoptWareBuildings).toHaveBeenCalledOnce();
      expect(retain).toHaveBeenCalledWith(scene, ['ware_hatchling_4']);
    } finally {
      ensure.mockRestore();
      releaseGroups.mockRestore();
      releaseReservations.mockRestore();
      retain.mockRestore();
    }
  });

  it('retains the admitted Hatchling lifecycle until the battle scene shuts down', async () => {
    const { BattleScene } = await import('./BattleScene');
    const loaded = new Set<string>();
    const ensure = vi.spyOn(atlasLoader, 'ensureV2Atlases')
      .mockImplementation(async (_scene, groups) => {
        for (const group of groups) loaded.add(group);
      });
    const retain = vi.spyOn(atlasLoader, 'retainAtlasGroups')
      .mockImplementation(() => vi.fn());
    const scene = {
      artLifecycleEpoch: 1,
      scene: { isActive: () => true, get: () => undefined },
      buildings: new Map([['nest', { type: 'dragonnest', level: 16 }]]),
      textures: { exists: (group: string) => loaded.has(group) },
      defenseArtLoads: new Map<string, Promise<void>>(),
      defenseSharedReservations: new Set<string>(),
      releaseDefenseFxLease: null,
      releaseWareFxLease: null,
      wareDependencyLeases: new Map<string, () => void>(),
      reserveDefenseArt: vi.fn(() => true),
      adoptV2Defenses: vi.fn(() => false),
      adoptWareBuildings: vi.fn(() => true),
    };
    const request = (BattleScene.prototype as unknown as {
      requestDefenseArtForEvents: (events: Array<Record<string, unknown>>) => Promise<void>[];
    }).requestDefenseArtForEvents;

    try {
      await Promise.all(request.call(scene, [{ e: 'spawn', t: 5, from: 'nest' }]));
      expect(retain).toHaveBeenCalledWith(scene, ['warefx']);
      expect(retain).toHaveBeenCalledWith(scene, ['ware_hatchling_4']);
      expect(scene.wareDependencyLeases.has('ware_hatchling_4')).toBe(true);
    } finally {
      ensure.mockRestore();
      retain.mockRestore();
    }
  });

  it('reserves and gates a spawned Nest/Hatchling before attacker compact art', async () => {
    const { BattleScene } = await import('./BattleScene');
    const nest = deferred();
    const order: string[] = [];
    const compact = new Map<string, number>();
    const scene = {
      ...playbackHarness(Promise.resolve()),
      armyLevels: { bowman: 1 },
      v2TroopLocomotionTiers: compact,
      requestDefenseArtForEvents: vi.fn((
        _events: Array<Record<string, unknown>>, mandatoryNestOnly = false,
      ) => {
        order.push(`defense:${String(mandatoryNestOnly)}`);
        return mandatoryNestOnly ? [nest.promise] : [];
      }),
      requestV2TroopLocomotionArt: vi.fn((troops: string[]) => {
        order.push(`compact:${troops.join('+')}`);
        troops.forEach((troop) => compact.set(troop, 1));
        return Promise.resolve();
      }),
      requestV2TroopArt: vi.fn(() => Promise.resolve()),
      requestV2DireEnhancementArt: vi.fn(() => Promise.resolve()),
      apply: vi.fn(),
    };
    const play = (BattleScene.prototype as unknown as {
      play: (events: Array<Record<string, unknown>>) => Promise<void>;
    }).play;
    const running = play.call(scene, [
      { e: 'deploy', t: 0, id: 1, troop: 'bowman', x: 0, y: 0 },
      { e: 'spawn', t: 0, id: 2, from: 'nest', troop: 'wyrmling', x: 0, y: 0 },
    ]);

    expect(order.slice(0, 2)).toEqual(['defense:true', 'compact:bowman']);
    expect(scene.apply).not.toHaveBeenCalled();
    nest.resolve();
    await running;
    expect(scene.apply).toHaveBeenCalledTimes(2);
    expect(order).toContain('defense:false');
  });

  it('adopts Archer before its first fire but never flips it after that event freezes the building', async () => {
    const { BattleScene } = await import('./BattleScene');
    const sprite = () => ({
      active: true,
      setOrigin: vi.fn().mockReturnThis(),
      setScale: vi.fn().mockReturnThis(),
      setTexture: vi.fn().mockReturnThis(),
    });
    const building = () => ({
      type: 'archertower', level: 1, destroyed: false, ware: undefined,
      sprite: sprite(), key: 'bld_archertower_l1', tx: 1, ty: 1, fw: 1, fh: 1,
    });
    const adopt = (BattleScene.prototype as unknown as {
      adoptWareBuildings: (groups: Set<string>) => boolean;
    }).adoptWareBuildings;
    const makeScene = (decided: Set<string>) => ({
      buildings: new Map([['archer', building()]]),
      artDecidedDefenses: decided,
      textures: { exists: (group: string) => group === 'ware_archer_1' },
      waremeta: { clips: {
        ware_bld_archer_t1_idle: {
          frames: 2, rows: 1, cellW: 96, cellH: 96,
          anchorPx: [48, 86], fps: 6, unit: 'archer',
        },
      } },
      v2Ticker: { play: vi.fn() },
      anim: { unregister: vi.fn() },
      positionBuildingSprite: vi.fn(),
    });

    const before = makeScene(new Set());
    expect(adopt.call(before, new Set(['ware_archer_1']))).toBe(true);
    expect(before.buildings.get('archer')!.ware).toBeDefined();

    const after = makeScene(new Set(['archer']));
    expect(adopt.call(after, new Set(['ware_archer_1']))).toBe(false);
    expect(after.buildings.get('archer')!.ware).toBeUndefined();
  });

  it('does not reserve or download defence art after the first event freezes that building', async () => {
    const { BattleScene } = await import('./BattleScene');
    const ensure = vi.spyOn(atlasLoader, 'ensureV2Atlases');
    const scene = {
      artDecidedDefenses: new Set(['archer']),
      buildings: new Map([['archer', { type: 'archertower', level: 16 }]]),
      defenseArtLoads: new Map<string, Promise<void>>(),
      reserveDefenseArt: vi.fn(() => true),
    };
    const request = (BattleScene.prototype as unknown as {
      requestDefenseArtForEvents: (events: Array<Record<string, unknown>>) => Promise<void>[];
    }).requestDefenseArtForEvents;

    try {
      expect(request.call(scene, [{ e: 'fire', t: 5, id: 'archer' }])).toEqual([]);
      expect(scene.reserveDefenseArt).not.toHaveBeenCalled();
      expect(ensure).not.toHaveBeenCalled();
    } finally {
      ensure.mockRestore();
    }
  });

  it('reserves behavior-complete compact art for every family before rich enhancements', async () => {
    const { BattleScene } = await import('./BattleScene');
    const order: string[] = [];
    const compactTiers = new Map<string, number>();
    const scene = {
      ...playbackHarness(Promise.resolve()),
      armyLevels: { bowman: 1, troll: 1, direwyvern: 1 },
      v2TroopTiers: new Map<string, number>(),
      v2TroopLocomotionTiers: compactTiers,
      v2TroopLoads: new Map<string, Promise<void>>(),
      v2TroopControllerReserved: new Set<string>(),
      requestV2TroopArt: vi.fn((troop: string) => {
        order.push(`controller:${troop}`);
        if (troop === 'direwyvern') scene.v2TroopControllerReserved.add(troop);
        return Promise.resolve();
      }),
      requestV2TroopLocomotionArt: vi.fn((troops: string[]) => {
        order.push(`compact:${troops.join('+')}`);
        troops.forEach((troop) => compactTiers.set(troop, 1));
        return Promise.resolve();
      }),
      requestV2DireEnhancementArt: vi.fn(() => {
        order.push('enhancement:direwyvern');
        return Promise.resolve();
      }),
    };
    const play = (BattleScene.prototype as unknown as {
      play: (events: Array<Record<string, unknown>>, fromTick?: number) => Promise<void>;
    }).play;

    await play.call(scene, [
      { e: 'deploy', t: 0, id: 1, troop: 'bowman', x: 0, y: 0 },
      { e: 'deploy', t: 0, id: 2, troop: 'direwyvern', x: 0, y: 0 },
      { e: 'deploy', t: 0, id: 3, troop: 'troll', x: 0, y: 0 },
    ]);

    expect(order).toEqual([
      'compact:bowman',
      'compact:troll',
      'compact:direwyvern',
      'controller:bowman',
      'controller:troll',
      'controller:direwyvern',
      'enhancement:direwyvern',
    ]);
  });

  it('has no actor-count or Dire-specific compact eviction path', async () => {
    const { BattleScene } = await import('./BattleScene');
    expect((BattleScene.prototype as unknown as Record<string, unknown>)
      .reclaimCompactForDire).toBeUndefined();
  });

  it('freezes Hexbarrow and its spawn-only brood as one replay art family', async () => {
    const { BattleScene, freezeTroopArtFamily } = await import('./BattleScene');
    const compactTiers = new Map<string, number>();
    const scene = {
      ...playbackHarness(Promise.resolve()),
      armyLevels: { hexbarrow: 1, barrowling: 1 },
      artDecidedTroops: new Set<string>(),
      v2TroopLocomotionTiers: compactTiers,
      requestV2TroopArt: vi.fn(() => Promise.resolve()),
      requestV2TroopLocomotionArt: vi.fn((troops: string[]) => {
        troops.forEach((troop) => compactTiers.set(troop, 1));
        return Promise.resolve();
      }),
      requestV2TroopFallbackFxArt: vi.fn(() => Promise.resolve()),
    };
    const play = (BattleScene.prototype as unknown as {
      play: (events: Array<Record<string, unknown>>, fromTick?: number) => Promise<void>;
    }).play;

    await play.call(scene, [
      { e: 'deploy', t: 0, id: 4, troop: 'hexbarrow', x: 0, y: 0 },
    ]);

    expect(scene.requestV2TroopArt).toHaveBeenCalledWith('hexbarrow');
    expect(scene.artDecidedTroops).toEqual(new Set());
    freezeTroopArtFamily(scene.artDecidedTroops, 'hexbarrow');
    expect(scene.artDecidedTroops).toEqual(new Set(['hexbarrow', 'barrowling']));
  });

  it('dispatches authored ability coordinates without client-side retargeting', async () => {
    const { BattleScene } = await import('./BattleScene');
    const onAbility = vi.fn();
    const scene = {
      troops: new Map([[4, { fx: { v2: { onAbility } } }]]),
      buildings: new Map([['keep', {
        destroyed: false,
        sprite: { visible: true, getBounds: () => ({ centerX: 444, centerY: 333 }) },
      }]]),
      ux: (x: number) => x + 100,
      uy: (y: number) => y + 200,
    };
    const handler = (BattleScene.prototype as unknown as {
      onTroopAbility: (ev: Record<string, unknown>) => void;
    }).onTroopAbility;

    handler.call(scene, {
      id: 4, ability: 'firestorm', x: 12, y: 34, ix: 56, iy: 78,
    });

    expect(onAbility).toHaveBeenCalledWith('firestorm', 112, 234, 156, 278);

    handler.call(scene, {
      id: 4, ability: 'firestorm', x: 12, y: 34, ix: 56, iy: 78,
      targetBuildingId: 'keep',
    });
    expect(onAbility).toHaveBeenLastCalledWith('firestorm', 112, 234, 444, 333);
  });

  it('keeps spawned Wyrmling and Barrowling health independent of equipped attacker HP in actual handlers', async () => {
    const { BattleScene } = await import('./BattleScene');
    const troopModule = await import('../fx/troop');
    const constructor = vi.spyOn(troopModule, 'TroopFx').mockImplementation(class {
      sprite = {}; setNearestBuildingFn = vi.fn();
    } as unknown as typeof troopModule.TroopFx);
    const scene = { armyHpBps: 1500, armyLevels: { wyrmling: 20, barrowling: 1 }, jumping: true,
      troops: new Map<number, { hp: number; maxHp: number }>(),
      buildings: new Map([['nest', { level: 20, destroyed: false }]]),
      ux: (n: number) => n, uy: (n: number) => n,
      wareHatchlingDepsOf: vi.fn(() => undefined), v2TroopDepsOf: vi.fn(() => undefined), v2TroopFallbackOf: vi.fn(() => undefined),
      add: { graphics: () => ({ setDepth: vi.fn().mockReturnThis() }) },
    };
    const prototype = BattleScene.prototype as unknown as {
      onSpawn: (event: Record<string, unknown>) => void;
      onTroopSpawn: (event: Record<string, unknown>) => void;
    };
    try {
      prototype.onSpawn.call(scene, { e: 'spawn', t: 10, id: 7, from: 'nest', troop: 'wyrmling', x: 0, y: 0 });
      prototype.onTroopSpawn.call(scene, { e: 'troopSpawn', t: 10, id: 8, from: 1, troop: 'barrowling', level: 20, variant: 3, x: 0, y: 0 });
      expect(scene.troops.get(7)).toMatchObject({ hp: troopMaxHp('wyrmling', 1), maxHp: troopMaxHp('wyrmling', 1) });
      expect(scene.wareHatchlingDepsOf).toHaveBeenCalledWith(20);
      expect(scene.troops.get(8)).toMatchObject({ hp: troopMaxHp('barrowling', 20), maxHp: troopMaxHp('barrowling', 20) });
      expect(scene.v2TroopDepsOf).toHaveBeenCalledWith('barrowling', 8, 20, 3);
    } finally { constructor.mockRestore(); }
  });

  it('threads the event-authored Barrowling level and variant into its controller', async () => {
    const { BattleScene } = await import('./BattleScene');
    const depsOf = (BattleScene.prototype as unknown as {
      v2TroopDepsOf: (
        troop: string, id?: number, level?: number, variant?: number,
      ) => Record<string, unknown> | undefined;
    }).v2TroopDepsOf;
    const scene = {
      v2TroopTiers: new Map([['barrowling', 2]]),
      v2TroopLocomotionTiers: new Map<string, number>(),
      armyLevels: { barrowling: 7 },
      meleeDrivenIds: new Set<number>(),
      v2Ticker: {},
      v2meta: { clips: {}, breathStream: null },
    };

    expect(depsOf.call(scene, 'barrowling', 91, 7, 3)).toMatchObject({
      unit: 'barrowling', tier: 2, variant: 3,
    });
    // A stale/different event level must not render from a mismatched tier.
    expect(depsOf.call(scene, 'barrowling', 91, 1, 3)).toBeUndefined();
  });

  it('atomically reserves Hexbarrow and its spawn-only brood before either adopts art', async () => {
    const { BattleScene } = await import('./BattleScene');
    const candidates: Array<{ id: string; groups: readonly string[] }> = [];
    const scene = {
      playGeneration: 0,
      scene: { isActive: () => true },
      v2TroopTiers: new Map<string, number>(),
      v2TroopLocomotionTiers: new Map<string, number>(),
      v2TroopLoads: new Map<string, Promise<void>>(),
      v2TroopLocomotionLoads: new Map<string, Promise<void>>(),
      v2TroopControllerReserved: new Set<string>(),
      artDecidedTroops: new Set<string>(),
      armyLevels: { hexbarrow: 1, barrowling: 1 },
      v2meta: { clips: {}, breathStream: null, atlasBytes: {} },
      textures: { exists: () => true },
      reserveV2Candidates: (input: Array<{ id: string; groups: readonly string[] }>) => {
        candidates.push(...input);
        return new Set(input.map((candidate) => candidate.id));
      },
      requestV2TroopLocomotionArt: vi.fn(() => Promise.resolve()),
      rebuildDeployMarks: vi.fn(),
      releaseUngrantableGroups: vi.fn(),
      retainTroopArt: vi.fn(),
    };
    const request = (BattleScene.prototype as unknown as {
      requestV2TroopArt: (troop: string) => Promise<void>;
    }).requestV2TroopArt;

    const load = request.call(scene, 'hexbarrow');
    expect(scene.v2TroopLoads.get('hexbarrow')).toBe(load);
    expect(scene.v2TroopLoads.get('barrowling')).toBe(load);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.id).toBe('hexbarrow-family:t1');
    expect(candidates[0]!.groups).toEqual(expect.arrayContaining([
      'v2fx', 'v2bld_hexbarrow_t1', 'v2trp_barrowling_t1',
    ]));
    await load;
    expect(scene.v2TroopTiers).toEqual(new Map([
      ['hexbarrow', 1], ['barrowling', 1],
    ]));
  });

  it('admits Direwyvern with its measured tiny FX shard, never global v2fx', async () => {
    const { BattleScene } = await import('./BattleScene');
    const candidates: Array<{ id: string; groups: readonly string[] }> = [];
    const scene = {
      playGeneration: 0,
      scene: { isActive: () => true },
      v2TroopTiers: new Map<string, number>(),
      v2TroopLocomotionTiers: new Map<string, number>(),
      v2TroopLoads: new Map<string, Promise<void>>(),
      v2TroopLocomotionLoads: new Map<string, Promise<void>>(),
      v2TroopControllerReserved: new Set<string>(),
      v2DireEnhancementLoad: null,
      artDecidedTroops: new Set<string>(),
      armyLevels: { direwyvern: 1 },
      v2meta: { clips: {}, breathStream: null, atlasBytes: {} },
      textures: { exists: () => true },
      reserveV2Candidates: (input: Array<{ id: string; groups: readonly string[] }>) => {
        candidates.push(...input);
        return new Set(input.map((entry) => entry.id));
      },
      requestV2TroopLocomotionArt: vi.fn(() => Promise.resolve()),
      rebuildDeployMarks: vi.fn(),
      releaseUngrantableGroups: vi.fn(),
      retainTroopArt: vi.fn(),
    };
    const request = (BattleScene.prototype as unknown as {
      requestV2TroopArt: (troop: string) => Promise<void>;
    }).requestV2TroopArt;

    const core = request.call(scene, 'direwyvern');
    await core;

    expect(candidates[0]).toEqual({
      id: 'direwyvern:t1',
      groups: [
        'v2trp_direwyvern_t1_locomotion',
        'v2trp_direwyvern_t1_maul',
        'v2trp_direwyvern_t1_firestorm',
        'v2trp_direwyvern_t1_fx',
      ],
    });
    expect(candidates[0]!.groups).not.toContain('v2fx');
    const enhance = (BattleScene.prototype as unknown as {
      requestV2DireEnhancementArt: (coreLoad: Promise<void>) => Promise<void>;
    }).requestV2DireEnhancementArt;
    await enhance.call(scene, core);
    expect(candidates[1]).toEqual({
      id: 'direwyvern-enhancement:t1',
      groups: ['v2trp_direwyvern_t1', 'v2trp_direwyvern_t1_lifecycle'],
    });
    expect(scene.v2TroopTiers.get('direwyvern')).toBe(1);
  });

  it('renders each burn cell once, coexists within a cast, and clears on the next cast', async () => {
    const { BattleScene } = await import('./BattleScene');
    const sprites: Array<{ active: boolean; destroy: ReturnType<typeof vi.fn> }> = [];
    const delayed: Array<{ delay: number; callback: () => void }> = [];
    const scene = {
      burnfields: new Map(),
      burnfieldCastTicks: new Map(),
      armyLevels: { direwyvern: 1 },
      v2meta: {
        clips: {
          v2_fx_burnfield_t1: {
            frames: 4, rows: 1, cellW: 96, cellH: 64,
            anchorPx: [48, 34], fps: 6,
          },
        },
      },
      textures: { exists: () => true },
      ux: (x: number) => x + 100,
      uy: (y: number) => y + 200,
      add: {
        image: vi.fn(() => {
          const sprite = {
            active: true,
            setOrigin: vi.fn().mockReturnThis(),
            setScale: vi.fn().mockReturnThis(),
            setDepth: vi.fn().mockReturnThis(),
            setTexture: vi.fn().mockReturnThis(),
            destroy: vi.fn(function (this: { active: boolean }) { this.active = false; }),
          };
          sprites.push(sprite);
          return sprite;
        }),
      },
      time: {
        addEvent: vi.fn(() => ({ remove: vi.fn() })),
        delayedCall: (delay: number, callback: () => void) => {
          delayed.push({ delay, callback });
          return { remove: vi.fn() };
        },
      },
    };
    const onBurnfield = (BattleScene.prototype as unknown as {
      onBurnfield: (ev: Record<string, unknown>, resumeTick?: number) => void;
    }).onBurnfield;
    const first = { e: 'burnfield', t: 10, id: 5, x: 12, y: 34, until: 30 };

    onBurnfield.call(scene, first, 15);
    onBurnfield.call(scene, first, 15);
    onBurnfield.call(scene, { ...first, x: 13 }, 15);
    expect(scene.add.image).toHaveBeenCalledTimes(2);
    expect(scene.add.image).toHaveBeenNthCalledWith(
      1, 112, 234, 'v2trp_direwyvern_t1_fx', 'v2_direwyvern_fx_burnfield_t1_f1',
    );
    expect(delayed[0]!.delay).toBe(1500);

    onBurnfield.call(scene, { ...first, t: 40, until: 50 }, 40);
    expect(sprites[0]!.destroy).toHaveBeenCalledOnce();
    expect(sprites[1]!.destroy).toHaveBeenCalledOnce();
    expect(scene.add.image).toHaveBeenCalledTimes(3);
  });

  it('reconstructs a still-live burnfield when playback resumes after its start', async () => {
    const { BattleScene } = await import('./BattleScene');
    const scene = {
      ...playbackHarness(Promise.resolve()),
      onBurnfield: vi.fn(),
    };
    const play = (BattleScene.prototype as unknown as {
      play: (events: Array<Record<string, unknown>>, fromTick?: number) => Promise<void>;
    }).play;
    const event = { e: 'burnfield', t: 2, id: 9, x: 10, y: 20, until: 12 };

    await play.call(scene, [event], 7);

    expect(scene.onBurnfield).toHaveBeenCalledOnce();
    expect(scene.onBurnfield).toHaveBeenCalledWith(event, 7);
  });
});

describe('BattleScene burrow emergence placement', () => {
  it('passes the authoritative v5 exit coordinate to the troop controller', async () => {
    const { BattleScene } = await import('./BattleScene');
    const onEmerge = vi.fn();
    const scene = {
      troops: new Map([[6, { fx: { onEmerge } }]]),
      stopLoop: vi.fn(),
      ux: (x: number) => x + 100,
      uy: (y: number) => y + 200,
    };
    const onSceneEmerge = (BattleScene.prototype as unknown as {
      onEmerge: (ev: Record<string, unknown>) => void;
    }).onEmerge;

    onSceneEmerge.call(scene, { e: 'emerge', t: 20, id: 6, x: 12, y: 34 });

    expect(scene.stopLoop).toHaveBeenCalledWith(6);
    expect(onEmerge).toHaveBeenCalledWith(112, 234);
  });
});

describe('BattleScene retiring actor ownership', () => {
  it('retains a removed death body until its sprite finishes, so verdict cleanup can reach it', async () => {
    // WHY: troopDeath removes the actor from the authoritative live map before
    // its death clip/fade completes. Without a separate owner, a hidden-tab
    // jump can kill the completion and leave an unreachable corpse forever.
    const { BattleScene } = await import('./BattleScene');
    let onDestroyed!: () => void;
    const fx = {
      onDeath: vi.fn(), destroy: vi.fn(),
      sprite: { once: vi.fn((_event: string, callback: () => void) => { onDestroyed = callback; }) },
    };
    const bar = { destroy: vi.fn() };
    const scene = {
      jumping: false,
      troops: new Map([[7, { fx, bar }]]),
      retiredTroops: new Set<typeof fx>(),
      stopLoop: vi.fn(),
    };
    const onTroopDeath = (BattleScene.prototype as unknown as {
      onTroopDeath: (ev: Record<string, unknown>) => void;
    }).onTroopDeath;

    onTroopDeath.call(scene, { e: 'troopDeath', t: 8, id: 7 });

    expect(scene.troops.has(7)).toBe(false);
    expect(scene.retiredTroops.has(fx)).toBe(true);
    expect(fx.onDeath).toHaveBeenCalledOnce();
    onDestroyed();
    expect(scene.retiredTroops.size).toBe(0);
  });
});

function heroPresentationHarness(targetIsTroop = false): {
  scene: Record<string, unknown>;
  actor: {
    onHeroSkill: ReturnType<typeof vi.fn>;
    onHeroTravel: ReturnType<typeof vi.fn>;
    sprite: { active: boolean; x: number; y: number };
  };
  images: Array<Record<string, unknown>>;
  addImage: ReturnType<typeof vi.fn>;
  addTween: ReturnType<typeof vi.fn>;
} {
  const images: Array<Record<string, unknown>> = [];
  const addImage = vi.fn((x: number, y: number, atlas: string, frame: string) => {
    const destroyListeners: Array<() => void> = [];
    const image: Record<string, unknown> = {
      active: true, x, y, atlas, frame,
      setDepth: vi.fn().mockReturnThis(),
      setScale: vi.fn().mockReturnThis(),
      setTexture: vi.fn().mockReturnThis(),
      once: vi.fn((event: string, callback: () => void) => {
        if (event === 'destroy') destroyListeners.push(callback);
      }),
      destroy: vi.fn(function (this: { active: boolean }) {
        this.active = false;
        destroyListeners.splice(0).forEach((callback) => callback());
      }),
    };
    images.push(image);
    return image;
  });
  const addTween = vi.fn(() => ({}));
  const actor = {
    onHeroSkill: vi.fn(), onHeroTravel: vi.fn(),
    alive: true,
    sprite: { active: true, x: 111, y: 222 },
  };
  const troops = new Map<number, Record<string, unknown>>([[
    1, { fx: actor, hp: 100, maxHp: 100 },
  ]]);
  if (targetIsTroop) {
    troops.set(2, {
      fx: {
        sprite: { active: true, getCenter: () => ({ x: 333, y: 444 }) },
      },
    });
  }
  return {
    scene: {
      troops,
      ux: (value: unknown) => Number(value) + 100,
      uy: (value: unknown) => Number(value) + 200,
      add: { image: addImage },
      tweens: { add: addTween },
      time: { delayedCall: vi.fn(() => ({ remove: vi.fn() })) },
    },
    actor, images, addImage, addTween,
  };
}

describe('hero presentation-only skill orchestration', () => {
  it('clears a stationary timer-owned hero sweep before a verdict or shutdown', async () => {
    // WHY: coin/quake/ZZZ images have no tween target. If the tab resumes past
    // the verdict and their destroy timers are cleared, explicit scene
    // ownership is the only way to keep them from remaining forever.
    const { BattleScene } = await import('./BattleScene');
    const prototype = BattleScene.prototype as unknown as {
      onHeroSkill: (ev: Record<string, unknown>) => void;
      clearTransientFx: () => void;
    };
    const harness = heroPresentationHarness();
    prototype.onHeroSkill.call(harness.scene, {
      e: 'heroSkill', t: 10, id: 1, skill: 'doubleOrNothingTails', phase: 'tails', x: 1, y: 2,
    });
    expect(harness.images[0]!.active).toBe(true);

    prototype.clearTransientFx.call(harness.scene);
    prototype.clearTransientFx.call(harness.scene);

    expect(harness.images[0]!.active).toBe(false);
    expect(harness.images[0]!.destroy).toHaveBeenCalledOnce();
  });

  it('mirrors deterministic cheat-death HP before a jump verdict without spawning skill FX', async () => {
    // WHY: the sim emits the lethal hit before the already-authoritative revive
    // cue. Replaying only the hit leaves a living hero visibly at zero HP; a
    // verdict seek must apply the HP reset but never create a late coin/ZZZ FX.
    const { BattleScene } = await import('./BattleScene');
    const onHeroSkill = (BattleScene.prototype as unknown as {
      onHeroSkill: (ev: Record<string, unknown>) => void;
    }).onHeroSkill;

    const rage = heroPresentationHarness();
    rage.scene.jumping = true;
    const rageRec = (rage.scene.troops as Map<number, { hp: number; maxHp: number }>).get(1)!;
    rageRec.hp = 0;
    onHeroSkill.call(rage.scene, {
      e: 'heroSkill', t: 10, id: 1, hero: 'theodor', skill: 'rageQuit',
      phase: 'fakeDeath', x: 10, y: 20, until: 40,
    });
    expect(rageRec.hp).toBe(60);
    expect(rage.addImage).not.toHaveBeenCalled();

    const heads = heroPresentationHarness();
    heads.scene.jumping = true;
    const headsRec = (heads.scene.troops as Map<number, { hp: number; maxHp: number }>).get(1)!;
    headsRec.hp = 0;
    onHeroSkill.call(heads.scene, {
      e: 'heroSkill', t: 10, id: 1, hero: 'vex', skill: 'doubleOrNothingHeads',
      phase: 'heads', x: 10, y: 20,
    });
    expect(headsRec.hp).toBe(50);
    expect(heads.addImage).not.toHaveBeenCalled();
  });

  it('hydrates an expired cheat-death cue into the cold-seek HP mirror', async () => {
    const { BattleScene } = await import('./BattleScene');
    const prototype = BattleScene.prototype as unknown as {
      applyPlaybackStateRange: (
        events: Array<Record<string, unknown>>, start: number, end: number,
      ) => void;
      applyHeroSkillState: (event: Record<string, unknown>) => void;
    };
    const scene = {
      jumping: false,
      troops: new Map<number, { hp: number; maxHp: number; fx: { finishSeek: () => void } }>(),
      applyHeroSkillState: prototype.applyHeroSkillState,
      apply(event: Record<string, unknown>) {
        const id = event.id as number;
        if (event.e === 'deploy') {
          this.troops.set(id, { hp: 200, maxHp: 200, fx: { finishSeek: vi.fn() } });
        } else if (event.e === 'hit') {
          const troop = this.troops.get(event.target as number)!;
          troop.hp = Math.max(0, troop.hp - (event.dmg as number));
        }
      },
    };

    prototype.applyPlaybackStateRange.call(scene, [
      { e: 'deploy', t: 0, id: 1, troop: 'giant', hero: 'theodor', x: 0, y: 0 },
      { e: 'hit', t: 2, target: 1, dmg: 200 },
      { e: 'heroSkill', t: 2, id: 1, hero: 'theodor', skill: 'rageQuit',
        phase: 'fakeDeath', x: 0, y: 0, until: 5 },
      { e: 'hit', t: 7, target: 1, dmg: 20 },
    ], 0, 10);

    expect(scene.troops.get(1)!.hp).toBe(100);
  });

  it('uses authored until only for persistent bodies, not active buff lifetime', async () => {
    const { BattleScene } = await import('./BattleScene');
    const onHeroSkill = (BattleScene.prototype as unknown as {
      onHeroSkill: (ev: Record<string, unknown>) => void;
    }).onHeroSkill;
    const active = heroPresentationHarness();
    onHeroSkill.call(active.scene, {
      e: 'heroSkill', t: 10, id: 1, skill: 'degenAwakening', phase: 'active',
      x: 10, y: 20, until: 100,
    });
    expect(active.actor.onHeroSkill).toHaveBeenCalledWith(
      'degenAwakening', 'active', 500,
    );

    const windup = heroPresentationHarness();
    onHeroSkill.call(windup.scene, {
      e: 'heroSkill', t: 10, id: 1, skill: 'silentButDeadly', phase: 'windup',
      x: 10, y: 20, until: 90,
    });
    expect(windup.actor.onHeroSkill).toHaveBeenCalledWith(
      'silentButDeadly', 'windup', 8_000,
    );
  });

  it('moves Moonsunder from caster to target and marks only a named troop victim', async () => {
    // WHY: event-centred FX made a six-tile wave stand still, while drawing
    // bleed on a building would falsely communicate a status it cannot receive.
    const { BattleScene } = await import('./BattleScene');
    const harness = heroPresentationHarness(true);
    const onHeroSkill = (BattleScene.prototype as unknown as {
      onHeroSkill: (ev: Record<string, unknown>) => void;
    }).onHeroSkill;

    onHeroSkill.call(harness.scene, {
      e: 'heroSkill', t: 10, id: 1, skill: 'moonsunderWave', phase: 'impact',
      x: 10, y: 20, toX: 30, toY: 40, target: 2,
    });

    expect(harness.addImage).toHaveBeenNthCalledWith(1, 110, 220, 'fx', 'fx_vex_crescent_f1');
    expect(harness.addTween).toHaveBeenCalledWith(expect.objectContaining({
      targets: harness.images[0], duration: 500, ease: 'Linear',
    }));
    const travel = harness.addTween.mock.calls[0]![0] as { x: number; y: number };
    expect(travel.x).toBeCloseTo(110 + 384 / Math.SQRT2);
    expect(travel.y).toBeCloseTo(220 + 384 / Math.SQRT2);
    expect(harness.addImage).toHaveBeenNthCalledWith(2, 333, 444, 'fx', 'fx_vex_bleed_f1');
  });

  it('does not invent a bleed marker when Moonsunder names a building', async () => {
    const { BattleScene } = await import('./BattleScene');
    const harness = heroPresentationHarness();
    const onHeroSkill = (BattleScene.prototype as unknown as {
      onHeroSkill: (ev: Record<string, unknown>) => void;
    }).onHeroSkill;

    onHeroSkill.call(harness.scene, {
      e: 'heroSkill', t: 10, id: 1, skill: 'moonsunderWave', phase: 'impact',
      x: 10, y: 20, toX: 30, toY: 40, target: 'keep',
    });

    expect(harness.addImage).toHaveBeenCalledTimes(1);
    expect(harness.addImage).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'fx', 'fx_vex_bleed_f1',
    );
  });

  it('moves Crimson Dash trail over the same authoritative endpoints as the hero', async () => {
    // WHY: the old trail was born at the landing tile and stayed there, so it
    // could never communicate the path the sim event already supplied.
    const { BattleScene } = await import('./BattleScene');
    const harness = heroPresentationHarness();
    const onHeroSkill = (BattleScene.prototype as unknown as {
      onHeroSkill: (ev: Record<string, unknown>) => void;
    }).onHeroSkill;

    onHeroSkill.call(harness.scene, {
      e: 'heroSkill', t: 10, id: 1, skill: 'crimsonDash', phase: 'impact',
      x: 30, y: 40, fromX: 10, fromY: 20, toX: 30, toY: 40,
    });

    expect(harness.addImage).toHaveBeenCalledWith(110, 220, 'fx', 'fx_vex_dashtrail_f1');
    expect(harness.addTween).toHaveBeenCalledWith(expect.objectContaining({
      targets: harness.images[0], x: 130, y: 240, duration: 500, ease: 'Linear',
    }));
    expect(harness.actor.onHeroTravel).toHaveBeenCalledWith(130, 240, 500);
  });

  it('sends Omega Shardstorm crescents through all eight authored spokes', async () => {
    // WHY: the body previously borrowed Moonsunder's cast while the FX stopped
    // at a stationary nova, hiding the eight-crescent contract completely.
    const { BattleScene } = await import('./BattleScene');
    const harness = heroPresentationHarness();
    const onHeroSkill = (BattleScene.prototype as unknown as {
      onHeroSkill: (ev: Record<string, unknown>) => void;
    }).onHeroSkill;

    onHeroSkill.call(harness.scene, {
      e: 'heroSkill', t: 10, id: 1, skill: 'omegaShardstorm', phase: 'impact', x: 10, y: 20,
    });

    expect(harness.addImage).toHaveBeenCalledTimes(9);
    expect(harness.addImage.mock.calls[0]![3]).toBe('fx_vex_shardnova_f1');
    expect(harness.addImage.mock.calls.slice(1).map((call) => call[3])).toEqual(
      Array(8).fill('fx_vex_crescent_f1'),
    );
    expect(harness.addTween).toHaveBeenCalledTimes(8);
    const endpoints = harness.addTween.mock.calls.map((call) => {
      const config = call[0] as { x: number; y: number };
      return [Math.round(config.x), Math.round(config.y)];
    });
    expect(new Set(endpoints.map(([px, py]) => `${px},${py}`)).size).toBe(8);
  });

  it('moves Theodor projectiles and delays Silent But Deadly FX until impact', async () => {
    // WHY: stink-linger was standing in for Brown Note's authored wall burst,
    // and the ultimate cloud fired eight seconds before its sim impact.
    const { BattleScene } = await import('./BattleScene');
    const onHeroSkill = (BattleScene.prototype as unknown as {
      onHeroSkill: (ev: Record<string, unknown>) => void;
    }).onHeroSkill;

    const snot = heroPresentationHarness();
    onHeroSkill.call(snot.scene, {
      e: 'heroSkill', t: 10, id: 1, skill: 'snotRocket', phase: 'impact', x: 10, y: 20,
    });
    expect(snot.addImage).toHaveBeenCalledWith(111, 222, 'fx', 'fx_theo_snot_f1');
    expect(snot.addTween).toHaveBeenCalledWith(expect.objectContaining({
      targets: snot.images[0], x: 110, y: 220, duration: 500, ease: 'Linear',
    }));

    const brown = heroPresentationHarness();
    onHeroSkill.call(brown.scene, {
      e: 'heroSkill', t: 10, id: 1, skill: 'brownNote', phase: 'impact', x: 10, y: 20,
    });
    expect(brown.addImage).toHaveBeenCalledWith(111, 222, 'fx', 'fx_theo_gasburst_f1');
    expect(brown.addTween).toHaveBeenCalledWith(expect.objectContaining({
      targets: brown.images[0], x: 110, y: 220, duration: 500, ease: 'Linear',
    }));

    const silent = heroPresentationHarness();
    onHeroSkill.call(silent.scene, {
      e: 'heroSkill', t: 10, id: 1, skill: 'silentButDeadly', phase: 'windup',
      x: 10, y: 20, until: 90,
    });
    expect(silent.addImage).not.toHaveBeenCalled();
    onHeroSkill.call(silent.scene, {
      e: 'heroSkill', t: 90, id: 1, skill: 'silentButDeadly', phase: 'impact', x: 10, y: 20,
    });
    expect(silent.addImage.mock.calls.map((call) => call[3])).toEqual([
      'fx_theo_stink_f1', 'fx_theo_stinklinger_f1',
    ]);
  });
});

describe('BattleScene hidden-tab catch-up (D-096 battle clock, D-099 catch-up visuals)', () => {
  /** Sim playback clock — mirrors BattleScene's TICK_MS. */
  const TICK_MS = 100;
  /** deploy → two walks → the done timer 10 ticks past the last event (3 000 ms). */
  const events = [
    { e: 'deploy', t: 0, id: 3, troop: 'kegrunner' },
    { e: 'pos', t: 8, id: 3, x: 2048, y: 2048 },
    { e: 'pos', t: 20, id: 3, x: 4096, y: 4096 },
  ];
  const DONE_AT_MS = (20 + 10) * TICK_MS;

  interface ClockTimer extends FakeTimer {
    delay: number;
    callback: () => void;
    getRemaining: () => number;
    loop: boolean;
    removed: boolean;
  }

  /** The scene seam the catch-up code needs: the game RESUME listener, the
   *  three playback clocks, one troop whose moves the timeline drives, and a
   *  scene Clock whose delayedCall records timers and whose update(time, delta)
   *  fires — in insertion order, as Phaser's Clock does — every timer `delta`
   *  reaches. The harness never steps its own clock, so a timer's remaining
   *  delay is its whole delay. `log` records moves (with their tween length),
   *  the HUD signal and the verdict in the order they happened. */
  async function catchUpHarness() {
    const { BattleScene } = await import('./BattleScene');
    const { AnimTicker } = await import('../anim');
    const prototype = BattleScene.prototype as unknown as {
      armPauseCatchUp: (this: unknown) => void;
      play: (this: unknown, events: Array<Record<string, unknown>>) => void;
      update: (this: unknown, time: number, delta: number) => void;
      repayPauseCatchUp: (delta: number) => void;
      resetPauseCatchUp: () => void;
      setPlaybackTimeScale: (scale: number) => void;
      jumpToEnd: (remainingMs: number) => void;
      onPos: (ev: Record<string, unknown>, durationMs?: number) => void;
      stopHoldDeploy: () => void;
    };
    const listeners = new Map<string, (pauseDuration: number) => void>();
    const timers: ClockTimer[] = [];
    const pendingInsertion: ClockTimer[] = [];
    const active: ClockTimer[] = [];
    const pendingRemoval: ClockTimer[] = [];
    const log: string[] = [];
    const anim = new AnimTicker();
    const scene = {
      ...playbackHarness(Promise.resolve()),
      artDecidedTroops: new Set(['kegrunner']),
      buildings: new Map(),
      retiredTroops: new Set<{ destroy: ReturnType<typeof vi.fn> }>(),
      troops: new Map([[3, { fx: {
        sprite: { active: false }, // update()'s facing/HP pass skips an inactive body
        cancelPrime: vi.fn(),
        settle: vi.fn(),
        onPos: vi.fn((_x: number, _y: number, durMs: number) => { log.push(`pos:${durMs}`); }),
        snapPosition: vi.fn(() => { log.push('pos:snap'); }),
      } }]]),
      ux: (n: number) => n,
      uy: (n: number) => n,
      time: {
        now: 0,
        timeScale: 1,
        delayedCall: (delay: number, callback: () => void): ClockTimer => {
          const timer = {
            delay, callback, loop: false, removed: false,
            remove: vi.fn(() => {
              timer.removed = true;
              for (const queue of [pendingInsertion, active, pendingRemoval]) {
                const index = queue.indexOf(timer);
                if (index >= 0) queue.splice(index, 1);
              }
            }),
            getRemaining: () => delay,
          };
          timers.push(timer);
          pendingInsertion.push(timer);
          return timer;
        },
        addEvent: ({ delay, callback, loop = false }: {
          delay: number; callback: () => void; loop?: boolean;
        }): ClockTimer => {
          const timer = {
            delay, callback, loop, removed: false,
            remove: vi.fn(() => {
              timer.removed = true;
              for (const queue of [pendingInsertion, active, pendingRemoval]) {
                const index = queue.indexOf(timer);
                if (index >= 0) queue.splice(index, 1);
              }
            }),
            getRemaining: () => delay,
          };
          timers.push(timer);
          pendingInsertion.push(timer);
          return timer;
        },
        preUpdate: vi.fn(() => {
          for (const timer of pendingRemoval.splice(0)) {
            const index = active.indexOf(timer);
            if (index >= 0) active.splice(index, 1);
            timer.removed = true;
          }
          active.push(...pendingInsertion.splice(0));
        }),
        update: vi.fn((_time: number, delta: number) => {
          for (const timer of [...active]) {
            if (timer.removed || delta < timer.delay) continue;
            if (timer.loop) {
              const repetitions = Math.floor(delta / timer.delay);
              for (let n = 0; n < repetitions && !timer.removed; n++) timer.callback();
            } else {
              timer.callback();
              pendingRemoval.push(timer);
            }
          }
        }),
        clearPendingEvents: vi.fn(() => {
          for (const timer of pendingInsertion.splice(0)) timer.removed = true;
        }),
        removeAllEvents: vi.fn(() => { pendingRemoval.push(...active); }),
      },
      tweens: {
        timeScale: 1,
        getTweens: vi.fn(() => [] as Array<{ targets: unknown[] | null }>),
        killAll: vi.fn(),
      },
      anims: { globalTimeScale: 1 },
      anim,
      v2Ticker: { setTimeScale: vi.fn(), settle: vi.fn() },
      loops: new Map([[3, { stop: vi.fn() }]]),
      burnfields: new Map<string, { destroy: () => void }>(),
      clearBurnfields: vi.fn(function (this: {
        burnfields: Map<string, { destroy: () => void }>;
      }) {
        this.burnfields.forEach((field) => field.destroy());
        this.burnfields.clear();
      }),
      artLifecycleEpoch: 1,
      catchUpMs: 0,
      playbackActive: false,
      playbackEnd: undefined as ClockTimer | undefined,
      jumping: false,
      catchingUp: false,
      holdTimer: null as ClockTimer | null,
      holdFired: false,
      events: { on: vi.fn(), once: vi.fn(), off: vi.fn() },
      repayPauseCatchUp: prototype.repayPauseCatchUp,
      resetPauseCatchUp: prototype.resetPauseCatchUp,
      setPlaybackTimeScale: prototype.setPlaybackTimeScale,
      jumpToEnd: prototype.jumpToEnd,
      onPos: prototype.onPos,
      stopHoldDeploy: prototype.stopHoldDeploy,
      game: {
        events: {
          on: (event: string, handler: (pauseDuration: number) => void) => { listeners.set(event, handler); },
          off: (event: string) => { listeners.delete(event); },
        },
      },
      unsub: [] as Array<() => void>,
    };
    anim.attach(scene as never);
    prototype.armPauseCatchUp.call(scene);
    const resume = listeners.get('resume')!;
    expect(resume).toBeDefined();
    const offCatchUp = bus.on('battle:catchup', ({ active }) => { log.push(`catchup:${String(active)}`); });
    const offDone = bus.on('battle:done', () => { log.push('done'); });
    const release = (): void => {
      offCatchUp();
      offDone();
      scene.unsub.forEach((unsubscribe) => unsubscribe());
    };
    return {
      prototype, scene, listeners, resume, timers, log, release,
      active, pendingInsertion, pendingRemoval,
    };
  }

  /** Wire the real create() listener over the deterministic playback Clock.
   * Rendering setup is inert; playback, seek, generation checks and bus delivery
   * remain production code rather than a copied implementation of the handler. */
  async function wirePlaybackListener(
    scene: Awaited<ReturnType<typeof catchUpHarness>>['scene'],
    visualContext?: import('@shardkeep/shared/baseVisual').BaseVisualContext,
    claim?: { claimMin: number; claimMax: number },
  ) {
    const { BattleScene } = await import('./BattleScene');
    const display = {
      setDepth: vi.fn().mockReturnThis(), setOrigin: vi.fn().mockReturnThis(),
      setTilePosition: vi.fn().mockReturnThis(), fillStyle: vi.fn().mockReturnThis(),
      fillRect: vi.fn().mockReturnThis(), lineStyle: vi.fn().mockReturnThis(),
      strokeRect: vi.fn().mockReturnThis(),
    };
    Object.assign(scene, {
      registry: { get: () => ({}) }, textures: { exists: () => true },
      add: { image: () => display, tileSprite: () => display, graphics: () => display },
      cameras: { main: { setBackgroundColor: vi.fn(), setBounds: vi.fn(), resetFX: vi.fn() } },
      v2Ticker: { ...scene.v2Ticker, attach: vi.fn() },
      setupCameraInput: vi.fn(), fitCamera: vi.fn(), syncCameraBounds: vi.fn(), warmDragonDeploymentSfx: vi.fn(),
      requestSnapshotNestArt: () => [], requestSnapshotMarketArt: () => [], requestSnapshotBerthArt: () => [], armPauseCatchUp: vi.fn(), isDeployable: () => true,
      retileSurvivingWalls: vi.fn(),
      play: (BattleScene.prototype as unknown as { play: (...args: unknown[]) => unknown }).play,
    });
    BattleScene.prototype.create.call(scene as unknown as InstanceType<typeof BattleScene>, {
      snapshot: { keepLevel: 1, buildings: [], ...claim }, armyCounts: {}, visualContext,
    });
  }

  it('clears prior-scene HUD bounds at entry without clearing current bounds on playback', async () => {
    const { scene, release } = await catchUpHarness();
    const mutable = scene as Record<string, unknown>;
    mutable.insets = { top: 82, bottom: 168, left: 0, right: 0 };
    try {
      await wirePlaybackListener(scene);
      expect(terrain.set).toHaveBeenLastCalledWith(undefined);
      expect(mutable.insets, 'a reused scene must not inherit stale portrait/landscape chrome').toBeNull();
      const current = { top: 104, bottom: 98, left: 9, right: 11 };
      mutable.insets = current;
      bus.emit('battle:play', { events });
      expect(mutable.insets, 'ordinary playback and timeline refresh must retain this entry measurement').toBe(current);
    } finally { release(); }
  });

  it('uses the frozen defender terrain when entering or restarting playback', async () => {
    const { scene, release } = await catchUpHarness();
    const context = { version: 1, realmId: 'frostveil', artVersion: 1 } as const;
    try {
      await wirePlaybackListener(scene, context);
      expect(terrain.set).toHaveBeenLastCalledWith(context);
      bus.emit('battle:play', { events });
      expect(terrain.set).toHaveBeenLastCalledWith(context);
    } finally { release(); }
  });

  it('hands the raid snapshot claim to SceneGround, not the GRID deploy default', async () => {
    // Revision 5 draws the defender's kingdom ring and prop clearing from the
    // claim the server stamped on the raid. A 22-tile claim centred on the
    // 30-plot sits at [4,26); the GRID default this scene keeps for deploy
    // geometry is [2,16). Only the snapshot's own bounds may reach the ground.
    const setClaim = vi.spyOn(SceneGround.prototype, 'setClaim');
    const { scene, release } = await catchUpHarness();
    try {
      await wirePlaybackListener(scene, undefined, { claimMin: 4, claimMax: 26 });
      expect(setClaim).toHaveBeenLastCalledWith({ min: 4, max: 26 });
    } finally { setClaim.mockRestore(); release(); }
  });

  it('leaves SceneGround without a claim for a legacy snapshot that stamped none', async () => {
    // A pre-claim raid must not be redrawn around the GRID default: the kit
    // ground reports the missing claim through diagnostics instead of
    // guessing a 14-tile kingdom at [2,16) that the server never issued.
    const setClaim = vi.spyOn(SceneGround.prototype, 'setClaim');
    const { scene, release } = await catchUpHarness();
    try {
      await wirePlaybackListener(scene);
      expect(setClaim).toHaveBeenCalledTimes(1);
      expect(setClaim).toHaveBeenLastCalledWith(undefined);
    } finally { setClaim.mockRestore(); release(); }
  });

  it('terminal server playback silently seeks the remaining timeline before one done event', async () => {
    const { scene, log, timers, active, pendingInsertion, release } = await catchUpHarness();
    await wirePlaybackListener(scene);
    const jumping: boolean[] = [];
    (scene as Record<string, unknown>).apply = vi.fn(() => { jumping.push(scene.jumping); });
    const terminalEvents = [
      events[0]!, events[1]!, { e: 'hit', t: 12, target: 'keep', dmg: 5 }, events[2]!,
    ];
    try {
      bus.emit('battle:play', {
        events: terminalEvents,
        terminal: true,
      });
      expect(jumping.length).toBeGreaterThan(0);
      expect(jumping.every(Boolean), 'terminal state must be silent, including synchronous tick-zero deploys').toBe(true);
      expect(log.filter((entry) => entry === 'done')).toHaveLength(1);
      expect(log.filter((entry) => entry.startsWith('pos:'))).toEqual(['pos:snap', 'pos:snap']);
      expect(scene.jumping).toBe(false);
      expect(scene.playbackActive).toBe(false);
      expect(active).toHaveLength(0);
      expect(pendingInsertion).toHaveLength(0);
      expect(scene.tweens.killAll).toHaveBeenCalledOnce();
      const count = log.length;
      timers.forEach((timer) => timer.callback());
      expect(log).toHaveLength(count);
    } finally { release(); }
  });

  it('a terminal art waiter cannot finish a replacement playback generation', async () => {
    const { scene, log, release } = await catchUpHarness();
    await wirePlaybackListener(scene);
    const compact = deferred();
    const mutable = scene as Record<string, unknown>;
    mutable.requestV2TroopLocomotionArt = vi.fn(() => compact.promise);
    mutable.requestV2TroopArt = vi.fn(() => Promise.resolve());
    const terminalEvents = [{ e: 'deploy', t: 0, id: 7, troop: 'dragon', x: 0, y: 0 }];
    try {
      bus.emit('battle:play', {
        events: terminalEvents, terminal: true,
      });
      expect(log).not.toContain('done');
      bus.emit('battle:play', { events });
      const generation = mutable.playRequestGeneration;
      compact.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mutable.playRequestGeneration).toBe(generation);
      expect(log, 'the old terminal request must not jump the replacement to its verdict').not.toContain('done');
      expect(scene.playbackActive).toBe(true);
      expect(scene.tweens.killAll).not.toHaveBeenCalled();
    } finally { compact.resolve(); release(); }
  });

  it('an immediate troop+hero replacement after RESUME starts at the rendered tick', async () => {
    const { prototype, scene, resume, timers, release } = await catchUpHarness();
    try {
      scene.artDecidedTroops.add('bowman');
      prototype.play.call(scene, events);
      // The real Scene update path records five rendered ticks. The following
      // RESUME adds seven wall-clock ticks of debt but renders none of them.
      prototype.update.call(scene, 500, 500);
      resume(700);
      const oldTimerCount = timers.length;
      const replacement = [
        events[0]!,
        { e: 'hit', t: 6, target: 'keep', dmg: 5 },
        events[1]!,
        { e: 'deploy', t: 12, id: 7, troop: 'bowman', x: 0, y: 0 },
        { e: 'deploy', t: 12, id: 8, troop: 'giant', hero: 'theodor', x: 0, y: 0 },
        { e: 'heroAttack', t: 13, id: 8, hero: 'theodor', targetKind: 'building',
          target: 'wall', ix: 0, iy: 0, recoveryUntil: 15 },
        events[2]!,
      ];
      (prototype.play as unknown as (
        this: unknown, events: Array<Record<string, unknown>>, fromTick: number,
        simVersion: number | undefined, appliedPrefix: boolean,
      ) => void).call(scene, replacement, 12, undefined, true);

      expect((scene as unknown as { playbackOriginTick: number }).playbackOriginTick).toBe(5);
      expect(scene.catchUpMs).toBe(700);
      const replacementTimers = timers.slice(oldTimerCount);
      expect(replacementTimers.some(({ delay }) => delay === 100)).toBe(true);
      expect(replacementTimers.filter(({ delay }) => delay === 700).length)
        .toBeGreaterThanOrEqual(2);
      expect(replacementTimers.at(-1)!.delay).toBe(2_500);
    } finally {
      release();
    }
  });

  type PlayWithFlags = (
    this: unknown, events: Array<Record<string, unknown>>, fromTick: number,
    simVersion: number | undefined, appliedPrefix: boolean, terminal: boolean, fightOpen: boolean,
  ) => void;

  it('keeps the field clock running after a stream\'s done while the fight is open, so the next reserve is rebased at the tick the field really reached (D-106)', async () => {
    // WHY (ferdblabla 2026-09-04, "when those troops died it immediate end
    // the raid"): a batch wave dying ends the STREAM, not the fight, while
    // reserves sit in the tray. The done timer used to freeze the rendered
    // clock (playbackActive = false), so a reserve released 30 s later was
    // rebased at the tick the last troop died and scheduled 30 s late on the
    // field. With `fightOpen` the clock idles on; a RESUME during the idle span
    // is owed straight to the clock (nothing to replay: no 8×, no pill); the
    // replacement lands at the true tick.
    const { prototype, scene, resume, timers, log, release } = await catchUpHarness();
    try {
      scene.artDecidedTroops.add('bowman');
      (prototype.play as unknown as PlayWithFlags).call(scene, events, 0, undefined, false, false, true);
      // Render the whole timeline: the done timer (3.0 s) fires.
      prototype.update.call(scene, 0, DONE_AT_MS);
      scene.time.preUpdate();
      scene.time.update(0, DONE_AT_MS);
      expect(log).toContain('done');
      expect(scene.playbackActive, 'the field idles OPEN: the clock keeps counting').toBe(true);
      expect(scene.playbackEnd).toBeUndefined();
      expect(scene.time.timeScale).toBe(1);
      // One idle second on screen, then a two-second hidden pause.
      prototype.update.call(scene, 0, 1_000);
      resume(2_000);
      expect(scene.time.timeScale, 'nothing to replay: the pause is owed to the clock, not repaid at 8×').toBe(1);
      expect(scene.catchUpMs).toBe(0);
      expect(log).not.toContain('catchup:true');

      // The reserve RaidUI releases now (its tick 60, landing on the next
      // tick) replaces the stream.
      const oldTimerCount = timers.length;
      const replacement = [
        ...events,
        { e: 'deploy', t: 61, id: 7, troop: 'bowman', x: 0, y: 0 },
        { e: 'pos', t: 70, id: 7, x: 2048, y: 2048 },
      ];
      (prototype.play as unknown as PlayWithFlags).call(scene, replacement, 60, undefined, true, false, false);
      expect(
        (scene as unknown as { playbackOriginTick: number }).playbackOriginTick,
        'rebased at 3 s rendered + 1 s idle + 2 s pause = tick 60, not at the tick the wave died',
      ).toBe(60);
      const replacementTimers = timers.slice(oldTimerCount);
      expect(replacementTimers.some(({ delay }) => delay === 100), 'the reserve lands one tick out — not 30 s late').toBe(true);
      const verdictDelay = (70 - 60 + 10) * TICK_MS;
      expect(replacementTimers.at(-1)!.delay, 'the verdict timer sits ten ticks past its last event').toBe(verdictDelay);
      expect(replacementTimers.every(({ delay }) => delay <= verdictDelay), 'nothing of the new stream is scheduled behind its verdict').toBe(true);
    } finally {
      release();
    }
  });

  it('a stream\'s done still stops the field clock when the fight is not held open (no reserves)', async () => {
    // WHY: the idle clock exists only for a fight that can continue. With an
    // empty tray the verdict follows and a pause under it owes nothing (D-099).
    const { prototype, scene, log, release } = await catchUpHarness();
    try {
      prototype.play.call(scene, events);
      scene.time.preUpdate();
      scene.time.update(0, DONE_AT_MS);
      expect(log).toContain('done');
      expect(scene.playbackActive).toBe(false);
    } finally {
      release();
    }
  });

  it('a RESUME shorter than the remaining timeline accelerates the scene clock until the missed span is consumed, then restores 1×, and reports the span to the HUD', async () => {
    // WHY (D-096): Phaser pauses its whole loop while the tab is hidden, so
    // every timeline delayedCall would fire late by the entire absence while
    // RaidUI's wall-clock HUD and commit ran on — the field froze mid-fight
    // under a bar that already said 100 %. Repaying the pause at speed replays
    // the missed events in order and lets battle:done still come from the
    // timeline. WHY (D-099): the 8× span is reported on 'battle:catchup' so the
    // HUD can label it — unlabeled, the fast-forward read as a broken fight.
    const { RAID_PLAYBACK } = await import('@shardkeep/shared');
    const { prototype, scene, listeners, resume, log, release } = await catchUpHarness();

    // A pause BEFORE playback owes nothing: the deploy window is wall-clock in
    // RaidUI and the field has no timeline yet.
    resume(5_000);
    prototype.update.call(scene, 0, 16);
    expect(scene.time.timeScale).toBe(1);
    expect(log).toEqual([]);

    prototype.play.call(scene, events);
    expect(scene.playbackEnd?.getRemaining()).toBe(DONE_AT_MS);
    const projectile = vi.fn();
    combatEffectPool(scene as never).add(800, projectile);
    resume(700); // the tab was hidden for 0.7 s mid-fight — well short of the end
    const scale = RAID_PLAYBACK.catchUpTimeScale;
    // This frame's clock step already ran at 1× (the Clock updates before the
    // scene), so update() only arms the speed-up here.
    prototype.update.call(scene, 16, 16);
    expect(scene.time.timeScale).toBe(scale);
    expect(scene.tweens.timeScale).toBe(scale);
    expect(scene.anims.globalTimeScale).toBe(scale);
    expect(log).toEqual(['catchup:true']);
    advanceCombatEffects(scene as never, 50);
    expect(projectile).toHaveBeenLastCalledWith(400, 0.5);
    // Every following 16 ms frame at 8× repays 16 × (8 − 1) = 112 ms of debt:
    // six frames cover 672 ms (< 700, still owed), the seventh clears it.
    for (let frame = 0; frame < 6; frame++) prototype.update.call(scene, 32 + frame * 16, 16);
    expect(scene.time.timeScale).toBe(scale);
    expect(log).toEqual(['catchup:true']);
    prototype.update.call(scene, 200, 16);
    expect(scene.time.timeScale).toBe(1);
    expect(scene.tweens.timeScale).toBe(1);
    expect(scene.anims.globalTimeScale).toBe(1);
    // The HUD hears the end of the span once; the timeline itself was never
    // jumped — the scene Clock repaid the debt frame by frame.
    expect(log).toEqual(['catchup:true', 'catchup:false']);
    expect(scene.time.update).not.toHaveBeenCalled();
    expect(scene.playbackActive).toBe(true);
    expect(scene.playbackEnd).toBeDefined();
    resume(100);
    expect(scene.catchUpMs).toBe(100);

    // The game-level listener is released with the other create() subscriptions.
    release();
    expect(listeners.has('resume')).toBe(false);
  });

  it('a RESUME at least as long as the remaining timeline jumps to the verdict in one Clock step: moves snap, the 8× catch-up never starts, battle:done fires last (D-099)', async () => {
    // WHY: a return AFTER the wall-clock end found the HUD at 100 %, the raid
    // already posted by RaidUI's timer, and the field fast-forwarding the
    // whole remaining fight at 8× with the verdict landing on top of it
    // (player report, D-099). The pause is compared with the done timer's
    // remaining delay: past it, the scene Clock is stepped once by that span
    // (+ one tick) so every outstanding callback fires in schedule order and
    // the last-scheduled `battle:done` closes the fight synchronously. While
    // jumping, positional moves land with a 0 ms tween — a real tween would
    // glide across the verdict — and no timeScale is raised, so the HUD never
    // hears a catch-up it would have to un-show.
    const {
      prototype, scene, resume, log, release, active, pendingInsertion, pendingRemoval,
    } = await catchUpHarness();
    prototype.play.call(scene, events);
    expect(scene.playbackEnd?.getRemaining()).toBe(DONE_AT_MS);
    const dispose = vi.fn();
    combatEffectPool(scene as never).addLoop(() => undefined, dispose);
    const lateMutation = vi.fn();
    scene.time.delayedCall(1, () => {
      scene.time.delayedCall(1, lateMutation);
    });
    const holdRepeat = vi.fn();
    scene.holdTimer = scene.time.addEvent({ delay: 120, loop: true, callback: holdRepeat });
    const burnfieldRepeat = vi.fn();
    const burnfieldLoop = scene.time.addEvent({
      delay: 160, loop: true, callback: burnfieldRepeat,
    });
    scene.burnfields.set('dire:cell', { destroy: () => burnfieldLoop.remove() });
    const legacyAnimated = {
      active: true,
      setTexture: vi.fn(),
      once: vi.fn(),
    };
    scene.anim.register(legacyAnimated as never, 'trp', ['walk_f1', 'walk_f2']);
    legacyAnimated.setTexture.mockClear();
    const skillTransient = {
      active: true,
      destroy: vi.fn(() => { skillTransient.active = false; log.push('skill:destroy'); }),
    };
    (scene as Record<string, unknown>).transientFx = new Set([skillTransient]);
    const corpse = { destroy: vi.fn(() => { log.push('corpse:destroy'); }) };
    scene.retiredTroops.add(corpse);
    const counterTween = { targets: [{ value: 0 }] };
    const flightImages: Array<{
      active: boolean;
      frame: string;
      textureWrites: number;
      destroy: ReturnType<typeof vi.fn>;
      setDepth: (depth: number) => unknown;
      setOrigin: (x: number, y: number) => unknown;
      setRotation: (angle: number) => unknown;
      setAlpha: (alpha: number) => unknown;
      setPosition: (x: number, y: number) => unknown;
      setTexture: (atlas: string, frame: string) => unknown;
    }> = [];
    (scene as Record<string, unknown>).add = {
      image: (_x: number, _y: number, _atlas: string, frame: string) => {
        const destroyListeners: Array<() => void> = [];
        const image = {
          active: true,
          frame,
          textureWrites: 0,
          destroy: vi.fn(() => {
            image.active = false;
            const kind = frame === 'fx_shell_shadow'
              ? 'shadow' : frame === 'fx_burn_1x1_f1' ? 'scorch' : 'shell';
            log.push(`${kind}:destroy`);
            destroyListeners.splice(0).forEach((callback) => callback());
          }),
          once: (event: string, callback: () => void) => {
            if (event === 'destroy') destroyListeners.push(callback);
            return image;
          },
          setDepth: () => image,
          setOrigin: () => image,
          setRotation: () => image,
          setAlpha: () => image,
          setPosition: () => image,
          setTexture: (_atlas: string, nextFrame: string) => {
            image.frame = nextFrame;
            image.textureWrites++;
            return image;
          },
        };
        flightImages.push(image);
        return image;
      },
    };
    const damageTexts: Array<{
      active: boolean;
      visible: boolean;
      setOrigin: () => unknown;
      setDepth: () => unknown;
      setColor: () => unknown;
      setText: () => unknown;
      setPosition: () => unknown;
      setAlpha: (alpha: number) => unknown;
      setVisible: (visible: boolean) => unknown;
    }> = [];
    (scene as Record<string, unknown>).add = {
      ...(scene as unknown as { add: object }).add,
      text: () => {
        const text = {
          active: true,
          visible: true,
          setOrigin: () => text,
          setDepth: () => text,
          setColor: () => text,
          setText: () => text,
          setPosition: () => text,
          setAlpha: () => text,
          setVisible: (visible: boolean) => { text.visible = visible; return text; },
        };
        damageTexts.push(text);
        return text;
      },
    };
    (scene as Record<string, unknown>).cameras = {
      main: { resetFX: vi.fn(() => { log.push('camera:reset'); }) },
    };
    (scene.tweens as Record<string, unknown>).addCounter = vi.fn(() => counterTween);
    const tweenConfigs: Array<{ targets?: unknown; onComplete?: () => void }> = [];
    (scene.tweens as Record<string, unknown>).add = vi.fn((config) => {
      tweenConfigs.push(config as { targets?: unknown; onComplete?: () => void });
      return {};
    });
    scene.tweens.getTweens.mockReturnValue([
      { targets: null }, // Phaser retains a just-destroyed tween in this shape.
      { targets: [skillTransient] },
      // Phaser addCounter owns only its private numeric counter; the visible
      // shell and shadow are closure variables and cannot be found here.
      counterTween,
    ]);
    const { burnScorch, launchProjectile } = await import('../fx/projectiles');
    const { popDamage } = await import('../fx/damagetext');
    launchProjectile(scene as never, 'shell', 10, 20, 30, 40);
    burnScorch(scene as never, 50, 60);
    popDamage(scene as never, 50, 60, 12);
    const firstDamageComplete = tweenConfigs.find(
      ({ targets }) => targets === damageTexts[0],
    )!.onComplete!;
    expect(flightImages.map(({ frame }) => frame)).toEqual([
      'fx_shell_f1', 'fx_shell_shadow', 'fx_burn_1x1_f1',
    ]);

    // At accepted 2x, half as much wall absence reaches the same canonical end.
    (scene as typeof scene & { playbackRate: 1 | 2 }).playbackRate = 2;
    resume(DONE_AT_MS / 2);
    expect(scene.time.update).toHaveBeenCalledOnce();
    expect(scene.time.update).toHaveBeenCalledWith(0, DONE_AT_MS + TICK_MS);
    // Both walks snapped directly, then the verdict — no deferred 0.01 ms
    // Phaser tween can leave the final field one keyframe behind.
    expect(log).toEqual([
      'pos:snap', 'pos:snap', 'shell:destroy', 'shadow:destroy', 'scorch:destroy',
      'skill:destroy', 'corpse:destroy', 'camera:reset', 'done',
    ]);
    expect(scene.time.timeScale).toBe(1);
    expect(scene.tweens.timeScale).toBe(1);
    expect(scene.anims.globalTimeScale).toBe(1);
    expect(scene.jumping).toBe(false);
    expect(scene.catchUpMs).toBe(0);
    expect(scene.playbackEnd).toBeUndefined();
    expect(scene.artLifecycleEpoch).toBe(2);
    expect(scene.time.removeAllEvents).toHaveBeenCalledOnce();
    expect(scene.time.clearPendingEvents).toHaveBeenCalledOnce();
    expect(active).toHaveLength(0);
    expect(pendingInsertion).toHaveLength(0);
    expect(pendingRemoval).toHaveLength(0);
    expect(scene.tweens.killAll).toHaveBeenCalledOnce();
    expect(scene.tweens.getTweens).not.toHaveBeenCalled();
    expect(skillTransient.destroy).toHaveBeenCalledOnce();
    expect(corpse.destroy).toHaveBeenCalledOnce();
    expect(scene.retiredTroops.size).toBe(0);
    expect(flightImages[0]!.destroy).toHaveBeenCalledOnce();
    expect(flightImages[1]!.destroy).toHaveBeenCalledOnce();
    expect(flightImages[2]!.destroy).toHaveBeenCalledOnce();
    expect(flightImages.every(({ textureWrites }) => textureWrites === 0)).toBe(true);
    expect(holdRepeat).not.toHaveBeenCalled();
    expect(burnfieldRepeat).not.toHaveBeenCalled();
    expect(legacyAnimated.setTexture).not.toHaveBeenCalled();
    expect(scene.holdTimer).toBeNull();
    expect(scene.v2Ticker.settle).toHaveBeenCalledOnce();
    expect(combatEffectCount(scene as never)).toBe(0);
    expect(dispose).toHaveBeenCalledOnce();
    expect(scene.loops.size).toBe(0);
    expect(scene.clearBurnfields).toHaveBeenCalledTimes(2); // play reset + verdict settle
    expect(damageTexts).toHaveLength(1);
    expect(damageTexts[0]).toMatchObject({ active: true, visible: false });
    popDamage(scene as never, 70, 80, 5);
    expect(damageTexts).toHaveLength(1); // same pooled Text was reused, not destroyed
    expect(damageTexts[0]!.visible).toBe(true);
    firstDamageComplete(); // stale completion from the killed pre-verdict tween
    expect(damageTexts[0]!.visible).toBe(true);

    // The spent timeline owes nothing more: a later frame stays at 1× and a
    // second RESUME (say, the verdict screen was backgrounded) does nothing.
    prototype.update.call(scene, 16, 16);
    scene.time.preUpdate();
    scene.time.update(16, 60_000);
    expect(lateMutation).not.toHaveBeenCalled();
    expect(scene.time.timeScale).toBe(1);
    resume(60_000);
    expect(scene.time.update).toHaveBeenCalledTimes(2);
    expect(log).toEqual([
      'pos:snap', 'pos:snap', 'shell:destroy', 'shadow:destroy', 'scorch:destroy',
      'skill:destroy', 'corpse:destroy', 'camera:reset', 'done',
    ]);
    release();
  });
});

/**
 * A phone's main thread stalls for hundreds of milliseconds on a full raid
 * re-simulation, a GC pause or an atlas upload. While it is stalled the DOM
 * release of a finger that has already lifted sits in the event queue behind
 * the next frame, so Phaser's `pointer.isDown` is stale in that frame — and
 * Phaser's clock replays every 120 ms beat the stall "earned" inside that ONE
 * frame. Either would deploy units the player never asked for.
 */
describe('BattleScene hold-to-deploy under a stalled main thread', () => {
  async function sprayHarness(rawDelta: number): Promise<{
    scene: Record<string, unknown>; beat: () => void; emitTap: ReturnType<typeof vi.fn>;
    loop: { rawDelta: number }; p: GesturePointer;
  }> {
    const { BattleScene } = await import('./BattleScene');
    let beat: (() => void) | undefined;
    const loop = { rawDelta };
    const emitTap = vi.fn();
    // On the real prototype so the beat reaches the scene's own stall check.
    const scene = Object.assign(Object.create(BattleScene.prototype) as Record<string, unknown>, {
      holdFired: false,
      holdTimer: null,
      pinch: { active: () => false },
      game: { loop },
      time: {
        addEvent: vi.fn((config: { callback: () => void }) => {
          beat = config.callback;
          return { remove: vi.fn() };
        }),
      },
      emitTap,
    });
    const start = (BattleScene.prototype as unknown as {
      startSprayDeploy: (this: Record<string, unknown>, p: GesturePointer) => void;
    }).startSprayDeploy;
    const p = pointer();
    start.call(scene, p);
    return { scene, beat: () => beat!(), emitTap, loop, p };
  }

  it('beats once per repeat on ordinary frames', async () => {
    const { beat, emitTap } = await sprayHarness(16);
    expect(emitTap, 'the first unit lands the moment the hold confirms').toHaveBeenCalledOnce();
    beat();
    beat();
    expect(emitTap).toHaveBeenCalledTimes(3);
  });

  it('never repeats on a frame that took longer than one hold beat, however many beats Phaser replays in it', async () => {
    const { beat, emitTap, loop } = await sprayHarness(16);
    emitTap.mockClear();
    loop.rawDelta = 400; // one stalled frame: Phaser clamps its game delta, the raw loop delta shows the stall
    beat();
    beat(); // Phaser's catch-up loop dispatching the beat the stall "earned"
    expect(emitTap, 'a stalled frame cannot vouch for the finger').not.toHaveBeenCalled();
    loop.rawDelta = 16;
    beat();
    expect(emitTap, 'the next real frame beats again while the finger is really parked').toHaveBeenCalledOnce();
  });

  it('still ends the stream on a processed release, stalled frame or not', async () => {
    const { scene, beat, emitTap, loop, p } = await sprayHarness(16);
    const stop = vi.fn();
    scene['stopHoldDeploy'] = stop;
    emitTap.mockClear();
    p.isDown = false; // the release WAS processed before this frame
    loop.rawDelta = 400;
    beat();
    expect(stop).toHaveBeenCalledOnce();
    expect(emitTap).not.toHaveBeenCalled();
  });
});

describe('BattleScene tap across a stalled frame', () => {
  it('lands exactly one unit when the hold confirmation fires on a stalled frame ahead of a queued release', async () => {
    // (ii) pointerdown, a 400 ms stall, the finger lifted 80 ms in but its
    // release is queued behind the frame that fires the 260 ms confirmation.
    const { scene, handlers, addEvent, emitTap } = await gestureHarness();
    scene['game'] = { loop: { rawDelta: 400 } };
    (scene['startSprayDeploy'] as ReturnType<typeof vi.fn>).mockImplementation(function (this: Record<string, unknown>, p: GesturePointer) {
      this['holdFired'] = true;
      (this['emitTap'] as (pointer: GesturePointer) => void)(p); // the immediate hold unit — the tap the player made
    });
    const down = handlers.get('pointerdown') as (p: GesturePointer) => void;
    const up = handlers.get('pointerup') as (p: GesturePointer) => void;
    const p = pointer({ wasTouch: true });
    down(p);
    const confirmation = (addEvent.mock.calls[0] as unknown as [{ callback: () => void }])[0];
    confirmation.callback(); // p.isDown is still (stalely) true in this frame
    expect(emitTap).toHaveBeenCalledOnce();
    expect(scene['gesture']).toMatchObject({ mode: 'hold' });
    up({ ...p, isDown: false, primaryDown: false });
    expect(emitTap, 'the queued release adds nothing after the hold already landed the tap').toHaveBeenCalledOnce();
    expect(scene['gesture']).toBeNull();
    (scene['unsub'] as Array<() => void>).forEach((off) => off());
  });
});

describe('BattleScene rejected-deploy markers', () => {
  type FakeMark = {
    troop: string; hero?: 'vex' | 'theodor' | undefined; tx: number; ty: number;
    fx: { destroy: ReturnType<typeof vi.fn<() => void>> };
  };
  const mark = (troop: string, tx: number, ty: number, hero?: 'vex' | 'theodor'): FakeMark => ({
    troop, hero, tx, ty, fx: { destroy: vi.fn<() => void>() },
  });
  async function unmark(marks: FakeMark[], spec: { troop: string; hero?: 'vex' | 'theodor'; tx: number; ty: number }) {
    const { BattleScene } = await import('./BattleScene');
    const refreshDeployStack = vi.fn();
    const scene = { marks, refreshDeployStack, destroyDeployMark: (m: FakeMark) => m.fx.destroy() };
    (BattleScene.prototype as unknown as {
      removeDeployMark: (this: typeof scene, s: typeof spec) => void;
    }).removeDeployMark.call(scene, spec);
    return { refreshDeployStack };
  }

  it('takes back exactly one marker — the newest on that tile — and re-fans the stack', async () => {
    // WHY: a live raid marks a tap before its receipt. When the server rejects
    // that ONE command, the other queued/accepted units on the same tile must
    // keep their markers, or the field lies in the other direction.
    const older = mark('giant', 3, 4);
    const newer = mark('giant', 3, 4);
    const elsewhere = mark('giant', 5, 4);
    const marks = [older, elsewhere, newer];
    const { refreshDeployStack } = await unmark(marks, { troop: 'giant', tx: 3, ty: 4 });
    expect(marks).toEqual([older, elsewhere]);
    expect(newer.fx.destroy).toHaveBeenCalledOnce();
    expect(older.fx.destroy).not.toHaveBeenCalled();
    expect(refreshDeployStack).toHaveBeenCalledExactlyOnceWith(3, 4);
  });

  it('matches the hero key too, and a miss is a no-op', async () => {
    const donor = mark('highlander', 3, 4);
    const hero = mark('highlander', 3, 4, 'vex');
    const marks = [donor, hero];
    await unmark(marks, { troop: 'highlander', hero: 'vex', tx: 3, ty: 4 });
    expect(marks).toEqual([donor]);
    // Already consumed by the accepted deploy event (or a new raid cleared the field).
    const { refreshDeployStack } = await unmark(marks, { troop: 'bowman', tx: 3, ty: 4 });
    expect(marks).toEqual([donor]);
    expect(refreshDeployStack).not.toHaveBeenCalled();
  });
});

describe('battle exit isolates visual cleanup failures', () => {
  it('releases later effects, removes broken children, and wakes HOME once async playback is invalidated', async () => {
    const { BattleScene } = await import('./BattleScene');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reservations = vi.spyOn(atlasLoader, 'releaseAtlasReservations').mockImplementation(() => undefined);
    const atlases = vi.spyOn(atlasLoader, 'releaseUnusedAtlases').mockImplementation(() => 0);
    const bad = { destroy: vi.fn(() => { throw new Error('broken child'); }) };
    const good = { destroy: vi.fn() };
    const children = [bad, good];
    const stopped = vi.fn();
    const wake = vi.fn();
    const refreshed = vi.fn();
    const off = bus.on('base:refresh', refreshed);
    const scene = new BattleScene();
    Object.assign(scene, {
      stopHoldDeploy: vi.fn(), resetPauseCatchUp: vi.fn(),
      clearTransientFx: vi.fn(), clearBurnfields: vi.fn(),
      releaseDragonDeploymentSfxBank: vi.fn(), releaseProductionSfxBanks: vi.fn(),
      scene: { stop: stopped, wake },
      children: { getChildren: () => children, remove: (child: typeof bad) => {
        const index = children.indexOf(child); if (index >= 0) children.splice(index, 1);
      } },
      sys: { updateList: { remove: vi.fn() } },
    });
    const owned = scene as unknown as {
      exitBattle(): void; cleanupBattle(): void;
      buildings: Map<string, { damage: { destroy(): void } }>;
      timeline: Array<{ remove(): void }>;
      unsub: Array<() => void>;
      playGeneration: number; playRequestGeneration: number; artLifecycleEpoch: number;
      playbackActive: boolean;
    };
    const laterEffect = vi.fn();
    const lateSubscription = vi.fn();
    const firstGeneration = owned.playGeneration;
    owned.playbackActive = true;
    owned.buildings.set('bad', { damage: { destroy: () => { throw new Error('broken effect'); } } });
    owned.buildings.set('good', { damage: { destroy: laterEffect } });
    owned.timeline.push({ remove: () => { throw new Error('broken timer'); } });
    owned.unsub.push(() => { throw new Error('broken unsubscribe'); }, lateSubscription);
    try {
      expect(() => owned.exitBattle()).not.toThrow();
      expect(owned.playGeneration).toBe(firstGeneration + 1);
      expect(owned.playbackActive).toBe(false);
      expect(owned.timeline).toEqual([]);
      expect(owned.buildings.size).toBe(0);
      expect(laterEffect).toHaveBeenCalledTimes(1);
      expect(lateSubscription).toHaveBeenCalledTimes(1);
      expect(good.destroy).toHaveBeenCalledTimes(1);
      expect(children).toEqual([]);
      expect(stopped).toHaveBeenCalledTimes(1);
      expect(wake).toHaveBeenCalledWith('base');
      expect(refreshed).toHaveBeenCalledTimes(1);
      owned.cleanupBattle(); // Phaser SHUTDOWN follows explicit HOME
      expect(laterEffect).toHaveBeenCalledTimes(1);
      expect(owned.playGeneration).toBe(firstGeneration + 1);
    } finally {
      off(); logged.mockRestore(); reservations.mockRestore(); atlases.mockRestore();
    }
  });
});

describe('BattleScene Phase E Market art (C3)', () => {
  const evidence = (name: string): unknown => JSON.parse(readFileSync(
    new URL(`../../../../../docs/evidence/2026-09-30-bound-cosmetic-visuals/${name}`, import.meta.url), 'utf8',
  ));
  const marketArt = parseMarketArtMetadata(evidence('pe_market.manifest.json'), evidence('pe_cosmetics.manifest.json'));
  const starterManifest = JSON.parse(readFileSync(new URL('../../../testFixtures/pe_fleet_starter.manifest.json', import.meta.url), 'utf8')) as Record<string, unknown> & { clips: unknown; tracks: unknown };
  const { clips: starterClips, tracks: starterTracks, ...starterIdentity } = starterManifest;
  const starterFleetArt = parseStarterFleetMetadata(starterIdentity, starterClips, starterTracks);
  const advancedFleetArt = parseAdvancedFleetMetadata(JSON.parse(readFileSync(new URL('../../../testFixtures/pe_advanced_fleet.manifest.json', import.meta.url), 'utf8')));
  const presentation = evidence('actual-presentation.fixture.json') as {
    pendingRaid: { boundCosmeticVisual: unknown; snapshot: { buildings: Array<{ id: string; type: string; level: number; tx: number; ty: number }> } };
  };
  const MARKET = presentation.pendingRaid.snapshot.buildings.find((b) => b.type === 'market')!;
  type Proto = {
    spawnBuilding: (building: Record<string, unknown>) => void;
    spriteKeyFor: (building: Record<string, unknown>) => string;
    buildingSeat: (frame: string) => unknown;
    marketChoiceFor: (b: { id: string; level: number }) => unknown;
    positionBuildingSprite: (sprite: unknown, b: unknown, frame: string) => void;
    adoptMarketBuildings: (groups?: ReadonlySet<string>, restoring?: ReadonlySet<string>) => boolean;
    applyMarketFallbackState: (id: string, b: unknown, state: 'damaged' | 'destroyed') => void;
    ownsMarketArt: (b: Record<string, unknown>) => boolean;
    requestSnapshotMarketArt: (buildings: Array<Record<string, unknown>>) => Promise<void>[];
    requestSnapshotBerthArt: (buildings: Array<Record<string, unknown>>) => Promise<void>[];
    adoptBerthBuildings: (groups?: ReadonlySet<string>, restoring?: ReadonlySet<string>) => boolean;
    applyBerthFallbackState: (id: string, b: unknown, state: 'damaged' | 'destroyed') => void;
    berthCompositionFor: (id: string) => unknown;
    berthRestKeyFor: (b: { id: string }) => string | null;
    berthArtResident: (id: string) => boolean;
    onHit: (event: Record<string, unknown>) => void;
    onDestroyed: (event: Record<string, unknown>) => void;
  };
  const sprite = () => {
    const s: Record<string, unknown> = {
      active: true, displayHeight: 112, x: 0, y: 0,
      setOrigin: vi.fn().mockReturnThis(), setScale: vi.fn().mockReturnThis(), setDepth: vi.fn().mockReturnThis(),
      setY: vi.fn().mockReturnThis(), setPosition: vi.fn().mockReturnThis(), setVisible: vi.fn().mockReturnThis(),
      setTexture: vi.fn().mockReturnThis(), clearTint: vi.fn().mockReturnThis(), destroy: vi.fn(),
      setAlpha: vi.fn().mockReturnThis(), visible: true, alpha: 1, depth: 0, scaleX: 1, scaleY: 1,
    };
    s['setVisible'] = vi.fn((v: boolean) => { s['visible'] = v; return s; });
    return s;
  };
  async function harness(resident: Set<string>, awnings: Map<string, string> = new Map()) {
    const { BattleScene } = await import('./BattleScene');
    const prototype = BattleScene.prototype as unknown as Proto;
    const created: Array<ReturnType<typeof sprite>> = [];
    const scene = {
      geometryVersion: 2, claimMin: 8, claimMax: 22, wallFrames: new Map(),
      spriteKeyFor: prototype.spriteKeyFor, buildingSeat: prototype.buildingSeat,
      marketChoiceFor: prototype.marketChoiceFor, positionBuildingSprite: prototype.positionBuildingSprite,
      adoptMarketBuildings: prototype.adoptMarketBuildings, applyMarketFallbackState: prototype.applyMarketFallbackState,
      ownsMarketArt: prototype.ownsMarketArt,
      adoptBerthBuildings: prototype.adoptBerthBuildings, applyBerthFallbackState: prototype.applyBerthFallbackState,
      berthCompositionFor: prototype.berthCompositionFor, berthRestKeyFor: prototype.berthRestKeyFor, berthArtResident: prototype.berthArtResident,
      starterFleetArt, advancedFleetArt, berthFacts: { berths: new Map(), unavailable: false } as BerthFactsSelection,
      marketArt, marketAwnings: awnings, v2meta: { clips: {}, atlasBytes: {} }, waremeta: { clips: {} }, meta: {},
      textures: { exists: (group: string) => resident.has(group) },
      add: { sprite: vi.fn((...args: unknown[]) => { const s = sprite(); s['created'] = args; created.push(s); return s; }), graphics: vi.fn(() => ({ setDepth: vi.fn().mockReturnThis(), destroy: vi.fn(), clear: vi.fn().mockReturnThis() })) },
      anim: { register: vi.fn(), unregister: vi.fn() }, v2Ticker: { play: vi.fn(), unregister: vi.fn() },
      occupied: new Set<string>(), destructibleMaxHp: 0, buildings: new Map<string, Record<string, unknown>>(),
      jumping: false, hitStar: vi.fn(), emitProgress: vi.fn(), retileSurvivingWalls: vi.fn(), keepClock: { remove: vi.fn() },
      lastProgressAt: 0,
    };
    return { prototype, scene, created };
  }

  it('spawns a pending Market hidden and frameless on its 2×2 seat, and a resident one keyed by its family cell', async () => {
    const { prototype, scene, created } = await harness(new Set());
    prototype.spawnBuilding.call(scene, { ...MARKET });
    expect(scene.add.sprite).toHaveBeenCalledExactlyOnceWith((MARKET.tx + 1) * 64, 0, 'pe_market_t1');
    expect(created[0]!['setVisible']).toHaveBeenCalledWith(false);
    expect(created[0]!['setOrigin']).toHaveBeenCalledWith(0.5, 1);
    expect(created[0]!['setScale']).toHaveBeenCalledWith(1);
    expect(created[0]!['setY']).toHaveBeenCalledWith((MARKET.ty + 2) * 64);
    expect(created[0]!['setDepth']).toHaveBeenCalledWith(structureDepth('building', (MARKET.ty + 2) * 64));
    expect(scene.occupied.size).toBe(4);
    expect(scene.buildings.get(MARKET.id)).toMatchObject({ fw: 2, fh: 2, key: 'pe_market_t1_idle_f1', maxHp: expect.any(Number) });
    const ready = await harness(new Set(['pe_market_t2']));
    ready.prototype.spawnBuilding.call(ready.scene, { ...MARKET, level: 7 });
    expect(ready.scene.add.sprite).toHaveBeenCalledExactlyOnceWith((MARKET.tx + 1) * 64, 0, 'pe_market_t2', 'pe_market_t2_idle_f1');
    expect(ready.created[0]!['setVisible']).not.toHaveBeenCalled();
  });

  it('adopts the resident family, upgrades ordinary to the frozen Awning when pe_cosmetics lands, and re-selects damage from the HP mirror', async () => {
    const awnings = new Map([[MARKET.id, 'artisan_market_awning_t1']]);
    const resident = new Set(['pe_market_t1']);
    const { prototype, scene, created } = await harness(resident, awnings);
    prototype.spawnBuilding.call(scene, { ...MARKET });
    const rec = scene.buildings.get(MARKET.id)!;
    rec['hp'] = (rec['maxHp'] as number) * 0.25;
    expect(prototype.adoptMarketBuildings.call(scene, new Set(['pe_market_t1']))).toBe(true);
    expect(rec['artMode']).toBe('market');
    expect((rec['market'] as { atlas: string }).atlas).toBe('pe_market_t1');
    expect(created[0]!['setVisible']).toHaveBeenLastCalledWith(true);
    expect(scene.v2Ticker.play).toHaveBeenLastCalledWith(created[0], expect.objectContaining({ base: 'pe_market_t1_damaged' }));
    expect(prototype.adoptMarketBuildings.call(scene, new Set(['pe_market_t1'])), 'idempotent').toBe(false);
    resident.add('pe_cosmetics');
    const ordinary = rec['market'] as { destroy: () => void };
    const destroy = vi.spyOn(ordinary, 'destroy');
    expect(prototype.adoptMarketBuildings.call(scene, new Set(['pe_cosmetics']))).toBe(true);
    expect(destroy).toHaveBeenCalledOnce();
    expect((rec['market'] as { atlas: string }).atlas).toBe('pe_cosmetics');
    expect(scene.v2Ticker.play).toHaveBeenLastCalledWith(created[0], expect.objectContaining({ base: 'pe_cos_market_t1_damaged', atlas: 'pe_cosmetics' }));
    // A restore pass reuses only already-admitted routes.
    delete rec['market'];
    expect(prototype.adoptMarketBuildings.call(scene, undefined, new Set([MARKET.id]))).toBe(true);
    expect((rec['market'] as { atlas: string }).atlas).toBe('pe_cosmetics');
  });

  it('P5: spawns a frozen Workshop/Lodge hidden and frameless until resident, keys them by their family cell, adopts them and lands destruction on their own rubble', async () => {
    const service = JSON.parse(readFileSync(new URL('../../../testFixtures/pe_service_buildings.manifest.json', import.meta.url), 'utf8')) as unknown;
    const serviceArt = parseMarketArtMetadata(evidence('pe_market.manifest.json'), evidence('pe_cosmetics.manifest.json'), service);
    const WORKSHOP = { id: 'ws-1', type: 'workshop', level: 1, tx: 12, ty: 14 };
    const LODGE = { id: 'lodge-1', type: 'lodge', level: 6, tx: 16, ty: 14 };
    const pending = await harness(new Set());
    pending.scene.marketArt = serviceArt;
    pending.prototype.spawnBuilding.call(pending.scene, { ...WORKSHOP });
    expect(pending.scene.add.sprite).toHaveBeenCalledExactlyOnceWith((WORKSHOP.tx + 1) * 64, 0, 'pe_workshop_t1');
    expect(pending.created[0]!['setVisible']).toHaveBeenCalledWith(false);
    expect(pending.scene.buildings.get(WORKSHOP.id)).toMatchObject({ fw: 2, fh: 2, key: 'pe_workshop_t1_idle_f1' });
    const resident = new Set(['pe_workshop_t1', 'pe_lodge_t2']);
    const { prototype, scene, created } = await harness(resident, new Map([[WORKSHOP.id, 'artisan_market_awning_t1']]));
    scene.marketArt = serviceArt;
    prototype.spawnBuilding.call(scene, { ...WORKSHOP });
    prototype.spawnBuilding.call(scene, { ...LODGE });
    expect(scene.add.sprite).toHaveBeenCalledWith((WORKSHOP.tx + 1) * 64, 0, 'pe_workshop_t1', 'pe_workshop_t1_idle_f1');
    expect(scene.add.sprite).toHaveBeenCalledWith((LODGE.tx + 1) * 64, 0, 'pe_lodge_t2', 'pe_lodge_t2_idle_f1');
    // A stray Awning entry never applies to a Workshop.
    expect(prototype.marketChoiceFor.call(scene, { id: WORKSHOP.id, level: 1, type: 'workshop' })).toEqual({ family: 'workshop', tier: 1, awning: null });
    const ws = scene.buildings.get(WORKSHOP.id)!;
    ws['hp'] = (ws['maxHp'] as number) * 0.25;
    expect(prototype.adoptMarketBuildings.call(scene, resident)).toBe(true);
    expect(ws['artMode']).toBe('market');
    expect((ws['market'] as { atlas: string }).atlas).toBe('pe_workshop_t1');
    expect(scene.v2Ticker.play).toHaveBeenCalledWith(created[0], expect.objectContaining({ base: 'pe_workshop_t1_damaged', atlas: 'pe_workshop_t1' }));
    expect((scene.buildings.get(LODGE.id)!['market'] as { atlas: string }).atlas).toBe('pe_lodge_t2');
    // Destruction through the controller lands on the pack rubble, never generic fx_rubble.
    scene.jumping = true;
    prototype.onDestroyed.call(scene, { id: LODGE.id });
    const lodgeSprite = created[1]!;
    expect(lodgeSprite['setTexture']).toHaveBeenLastCalledWith('pe_lodge_t2', 'pe_lodge_t2_destroyed_f1');
    expect(lodgeSprite['setTexture']).not.toHaveBeenCalledWith('fx', expect.anything());
  });

  it('P5 S1: a Workshop keyed by the legacy sheet (service table refused) keeps the generic M22 damage and rubble — the seam owns only art it selected', async () => {
    const juice = await import('../../lib/juice');
    const numbers = vi.spyOn(juice, 'floatText').mockImplementation(() => undefined);
    const WORKSHOP = { id: 'ws-legacy', type: 'workshop', level: 1, tx: 12, ty: 14 };
    const { prototype, scene, created } = await harness(new Set(['pe_workshop_t1']));
    scene.marketArt = parseMarketArtMetadata(evidence('pe_market.manifest.json'), evidence('pe_cosmetics.manifest.json')); // no service families
    Object.assign(scene, { hitStar: vi.fn() });
    prototype.spawnBuilding.call(scene, { ...WORKSHOP });
    const rec = scene.buildings.get(WORKSHOP.id)!;
    expect(rec['key'], 'historical ordinary key, not a family cell').toBe('bld_workshop_l1');
    expect(rec['artMode']).toBeUndefined();
    const damage = { update: vi.fn(), collapse: vi.fn(), destroy: vi.fn() };
    rec['damage'] = damage;
    prototype.onHit.call(scene, { e: 'hit', t: 1, target: WORKSHOP.id, dmg: (rec['maxHp'] as number) * 0.6 });
    expect(damage.update, 'the generic HP overlay owns a legacy-keyed body').toHaveBeenCalledOnce();
    expect(created[0]!['setTexture']).not.toHaveBeenCalledWith('pe_workshop_t1', expect.anything());
    prototype.onDestroyed.call(scene, { e: 'destroyed', t: 2, id: WORKSHOP.id });
    expect(damage.collapse, 'generic rubble, exactly as before the seam').toHaveBeenCalledOnce();
    // The same body keyed by its resident family cell is owned by the seam, never doubly overlaid.
    const owned = await harness(new Set(['pe_workshop_t1']));
    owned.scene.marketArt = parseMarketArtMetadata(evidence('pe_market.manifest.json'), evidence('pe_cosmetics.manifest.json'),
      JSON.parse(readFileSync(new URL('../../../testFixtures/pe_service_buildings.manifest.json', import.meta.url), 'utf8')));
    Object.assign(owned.scene, { hitStar: vi.fn() });
    owned.prototype.spawnBuilding.call(owned.scene, { ...WORKSHOP });
    const ownedRec = owned.scene.buildings.get(WORKSHOP.id)!;
    expect(ownedRec['key']).toBe('pe_workshop_t1_idle_f1');
    const ownedDamage = { update: vi.fn(), collapse: vi.fn(), destroy: vi.fn() };
    ownedRec['damage'] = ownedDamage;
    owned.prototype.onHit.call(owned.scene, { e: 'hit', t: 1, target: WORKSHOP.id, dmg: (ownedRec['maxHp'] as number) * 0.6 });
    expect(ownedDamage.update).not.toHaveBeenCalled();
    numbers.mockRestore();
  });

  it('P6a: frozen berths come from the payload siblings only; a presented berth spawns hidden on its berth group until BOTH groups land, an unpresented one is a hidden footprint on the plain sheet', async () => {
    const BERTH = { id: 'berth-a', type: 'berth', level: 1, tx: 10, ty: 10 };
    const EMPTY = { id: 'berth-b', type: 'berth', level: 1, tx: 14, ty: 10 };
    const snapshot = [{ id: 'keep', type: 'keep', level: 3, tx: 2, ty: 2 }, EMPTY, BERTH];
    const advanced = { version: 1, berths: [{ buildingId: 'berth-a', installation: { family: 'survey_balloon', tier: 1, presence: 'occupied' } }, { buildingId: 'berth-b', installation: null }] };
    const facts = selectFrozenBerths(undefined, advanced, snapshot);
    expect(facts.unavailable).toBe(false);
    const pending = await harness(new Set());
    pending.scene.berthFacts = facts;
    expect(pending.prototype.spriteKeyFor.call(pending.scene, { ...BERTH })).toBe('pe_berth_survey_balloon_intact_f1');
    expect(pending.prototype.spriteKeyFor.call(pending.scene, { ...EMPTY })).toBe(BERTH_UNPRESENTED_KEY);
    pending.prototype.spawnBuilding.call(pending.scene, { ...BERTH });
    pending.prototype.spawnBuilding.call(pending.scene, { ...EMPTY });
    expect(pending.scene.add.sprite).toHaveBeenNthCalledWith(1, (BERTH.tx + 1) * 64, 0, 'pe_berth_survey_balloon');
    expect(pending.scene.add.sprite).toHaveBeenNthCalledWith(2, (EMPTY.tx + 1) * 64, 0, 'bld');
    expect(pending.created[0]!['setVisible']).toHaveBeenCalledWith(false);
    expect(pending.created[1]!['setVisible']).toHaveBeenCalledWith(false);
    expect(pending.scene.buildings.get(BERTH.id)).toMatchObject({ fw: 2, fh: 2, key: 'pe_berth_survey_balloon_intact_f1' });
    expect(pending.scene.buildings.get(EMPTY.id)).toMatchObject({ fw: 2, fh: 2, key: BERTH_UNPRESENTED_KEY });
    // Residency requests: the berth group and the vehicle tier group, nothing for the empty berth.
    const requested: unknown[] = [];
    const request = vi.spyOn(pending.prototype as unknown as { requestDefenseArtCandidates: (c: unknown) => Promise<void>[] }, 'requestDefenseArtCandidates')
      .mockImplementation((candidates) => { requested.push(candidates); return []; });
    try {
      pending.prototype.requestSnapshotBerthArt.call(pending.scene, snapshot);
      expect(requested[0]).toEqual([
        { id: 'berth:pe_berth_survey_balloon', kind: 'berth', bodyGroup: 'pe_berth_survey_balloon', groups: ['pe_berth_survey_balloon'] },
        { id: 'berth:pe_veh_survey_balloon_t1', kind: 'berth', bodyGroup: 'pe_veh_survey_balloon_t1', groups: ['pe_veh_survey_balloon_t1'] },
      ]);
    } finally { request.mockRestore(); }
    // Berth group alone: no adoption (an occupied berth never shows empty); both groups: controller + vehicle sprite.
    const resident = new Set(['pe_berth_survey_balloon']);
    const { prototype, scene, created } = await harness(resident);
    scene.berthFacts = facts;
    prototype.spawnBuilding.call(scene, { ...BERTH });
    expect(prototype.adoptBerthBuildings.call(scene, new Set(['pe_berth_survey_balloon']))).toBe(false);
    expect(created[0]!['visible']).toBe(false);
    resident.add('pe_veh_survey_balloon_t1');
    expect(prototype.adoptBerthBuildings.call(scene, new Set(['pe_veh_survey_balloon_t1']))).toBe(true);
    const rec = scene.buildings.get(BERTH.id)!;
    expect(rec['artMode']).toBe('berth');
    expect((rec['berth'] as { atlas: string }).atlas).toBe('pe_berth_survey_balloon');
    expect(created[0]!['visible']).toBe(true);
    expect(scene.add.sprite).toHaveBeenLastCalledWith(0, 0, 'pe_veh_survey_balloon_t1');
    expect(created[1]!['visible'], 'cold-loaded occupied berth: the vehicle is revealed with the berth').toBe(true);
    expect(scene.v2Ticker.play).toHaveBeenCalledWith(created[0], expect.objectContaining({ base: 'pe_berth_survey_balloon_ambient', atlas: 'pe_berth_survey_balloon' }));
    expect(scene.v2Ticker.play).toHaveBeenCalledWith(created[1], expect.objectContaining({ base: 'pe_veh_survey_balloon_t1_docked', atlas: 'pe_veh_survey_balloon_t1' }));
    // The frozen starter sibling adopts through the same seam on its own group.
    const starterFacts = selectFrozenBerths({ version: 1, berths: [{ buildingId: 'berth-a', installation: { family: 'starter', presence: 'occupied' } }, { buildingId: 'berth-b', installation: null }] }, undefined, snapshot);
    const starter = await harness(new Set(['pe_fleet_starter']));
    starter.scene.berthFacts = starterFacts;
    starter.prototype.spawnBuilding.call(starter.scene, { ...BERTH });
    expect(starter.scene.add.sprite).toHaveBeenCalledWith((BERTH.tx + 1) * 64, 0, 'pe_fleet_starter', 'pe_berth_starter_intact_f1');
    expect(starter.prototype.adoptBerthBuildings.call(starter.scene)).toBe(true);
    expect(starter.scene.add.sprite).toHaveBeenLastCalledWith(0, 0, 'pe_fleet_starter');
    // Legacy originals (no siblings) and an unavailable sibling keep every berth a hidden footprint.
    expect(selectFrozenBerths(undefined, undefined, snapshot).berths.size).toBe(0);
    expect(selectFrozenBerths(undefined, null, snapshot)).toEqual({ berths: new Map(), unavailable: true });
  });

  it('P6a D-b: damage keeps the vehicle on the damaged berth still, destruction drops it onto the destroyed still, a seek lands on the same stills, and nothing generic is ever drawn', async () => {
    const juice = await import('../../lib/juice');
    const numbers = vi.spyOn(juice, 'floatText').mockImplementation(() => undefined);
    const BERTH = { id: 'berth-a', type: 'berth', level: 1, tx: 10, ty: 10 };
    const facts = selectFrozenBerths(undefined, { version: 1, berths: [{ buildingId: 'berth-a', installation: { family: 'cargo_cutter', tier: 2, presence: 'exhausted' } }] }, [BERTH]);
    const { prototype, scene, created } = await harness(new Set(['pe_berth_cargo_cutter', 'pe_veh_cargo_cutter_t2']));
    Object.assign(scene, { hitStar: vi.fn(), berthFacts: facts });
    prototype.spawnBuilding.call(scene, { ...BERTH });
    expect(prototype.adoptBerthBuildings.call(scene)).toBe(true);
    const rec = scene.buildings.get(BERTH.id)!;
    const damage = { update: vi.fn(), collapse: vi.fn(), destroy: vi.fn() };
    rec['damage'] = damage;
    const berthSprite = created[0]!, vehicle = created[1]!;
    expect(scene.v2Ticker.play).toHaveBeenCalledWith(vehicle, expect.objectContaining({ base: 'pe_veh_cargo_cutter_t2_exhausted', seq: ['pe_veh_cargo_cutter_t2_exhausted_f1'] }));
    prototype.onHit.call(scene, { e: 'hit', t: 1, target: BERTH.id, dmg: (rec['maxHp'] as number) * 0.6 });
    expect(damage.update, 'the seam owns the berth body').not.toHaveBeenCalled();
    expect(scene.v2Ticker.play).toHaveBeenCalledWith(berthSprite, expect.objectContaining({ base: 'pe_berth_cargo_cutter_damaged', seq: ['pe_berth_cargo_cutter_damaged_f1'] }));
    expect(vehicle['destroy'], 'D-b: the vehicle stays through damage').not.toHaveBeenCalled();
    prototype.onDestroyed.call(scene, { e: 'destroyed', t: 2, id: BERTH.id });
    expect(damage.collapse).not.toHaveBeenCalled();
    expect(scene.v2Ticker.play).toHaveBeenCalledWith(berthSprite, expect.objectContaining({ base: 'pe_berth_cargo_cutter_destroyed' }));
    expect(vehicle['destroy'], 'D-b: the vehicle leaves with the destroyed berth').toHaveBeenCalledOnce();
    expect(berthSprite['setTexture']).not.toHaveBeenCalledWith('fx', expect.anything());
    // A seek (jumping) destroys the controller and rests the berth on its destroyed still; the vehicle is gone.
    const seek = await harness(new Set(['pe_berth_cargo_cutter', 'pe_veh_cargo_cutter_t2']));
    Object.assign(seek.scene, { berthFacts: facts, jumping: true });
    seek.prototype.spawnBuilding.call(seek.scene, { ...BERTH });
    seek.prototype.adoptBerthBuildings.call(seek.scene);
    (seek.scene.buildings.get(BERTH.id)!)['damage'] = { update: vi.fn(), collapse: vi.fn(), destroy: vi.fn() };
    seek.prototype.onDestroyed.call(seek.scene, { e: 'destroyed', t: 2, id: BERTH.id });
    expect(seek.created[0]!['setTexture']).toHaveBeenLastCalledWith('pe_berth_cargo_cutter', 'pe_berth_cargo_cutter_destroyed_f1');
    expect(seek.created[1]!['destroy']).toHaveBeenCalledOnce();
    expect(seek.scene.buildings.get(BERTH.id)!['berth']).toBeUndefined();
    // Pending art (not resident) and unpresented berths: a seek draws nothing and substitutes nothing generic.
    for (const [label, resident, selection] of [['pending', new Set<string>(), facts], ['unpresented', new Set(['pe_berth_cargo_cutter']), selectFrozenBerths(undefined, { version: 1, berths: [{ buildingId: 'berth-a', installation: null }] }, [BERTH])]] as const) {
      const quiet = await harness(resident);
      Object.assign(quiet.scene, { berthFacts: selection, jumping: true });
      quiet.prototype.spawnBuilding.call(quiet.scene, { ...BERTH });
      (quiet.scene.buildings.get(BERTH.id)!)['damage'] = { update: vi.fn(), collapse: vi.fn(), destroy: vi.fn() };
      quiet.prototype.onDestroyed.call(quiet.scene, { e: 'destroyed', t: 2, id: BERTH.id });
      expect(quiet.created[0]!['setTexture'], label).not.toHaveBeenCalled();
      expect(quiet.created[0]!['visible'], label).toBe(false);
    }
    numbers.mockRestore();
  });

  it.each(['occupied', 'exhausted'] as const)('P6a (review S1 + cold residency): a %s berth whose vehicle group is still pending draws no bare damaged still; adoption after the reveal shows the berth AND its vehicle', async (presence) => {
    const juice = await import('../../lib/juice');
    const numbers = vi.spyOn(juice, 'floatText').mockImplementation(() => undefined);
    const BERTH = { id: 'berth-a', type: 'berth', level: 1, tx: 10, ty: 10 };
    const facts = selectFrozenBerths(undefined, { version: 1, berths: [{ buildingId: 'berth-a', installation: { family: 'cargo_cutter', tier: 2, presence } }] }, [BERTH]);
    const resident = new Set(['pe_berth_cargo_cutter']);
    const { prototype, scene, created } = await harness(resident);
    Object.assign(scene, { hitStar: vi.fn(), berthFacts: facts });
    prototype.spawnBuilding.call(scene, { ...BERTH });
    expect(created[0]!['visible'], 'berth group alone: pending').toBe(false);
    const rec = scene.buildings.get(BERTH.id)!;
    rec['damage'] = { update: vi.fn(), collapse: vi.fn(), destroy: vi.fn() };
    prototype.onHit.call(scene, { e: 'hit', t: 1, target: BERTH.id, dmg: (rec['maxHp'] as number) * 0.6 });
    expect(created[0]!['setTexture'], 'no bare damaged berth without its vehicle (D-b)').not.toHaveBeenCalled();
    expect(created[0]!['visible']).toBe(false);
    resident.add('pe_veh_cargo_cutter_t2');
    expect(prototype.adoptBerthBuildings.call(scene, new Set(['pe_veh_cargo_cutter_t2']))).toBe(true);
    expect(scene.v2Ticker.play).toHaveBeenCalledWith(created[0], expect.objectContaining({ base: 'pe_berth_cargo_cutter_damaged' }));
    expect(scene.v2Ticker.play).toHaveBeenCalledWith(created[1], expect.objectContaining({ base: presence === 'exhausted' ? 'pe_veh_cargo_cutter_t2_exhausted' : 'pe_veh_cargo_cutter_t2_docked' }));
    expect(created[0]!['visible']).toBe(true);
    // Cold residency: the controller rested while the berth was still hidden, so the
    // vehicle mirrored that; the reveal must re-sync it or the berth stays bare.
    expect(created[1]!['visible'], 'vehicle visible after the cold reveal').toBe(true);
    expect(created[1]!['setVisible']).toHaveBeenLastCalledWith(true);
    numbers.mockRestore();
  });

  it('requests the ordinary group and, for a frozen Awning, pe_cosmetics as separate candidates', async () => {
    const { prototype, scene } = await harness(new Set(), new Map([[MARKET.id, 'artisan_market_awning_t1']]));
    const requested: unknown[] = [];
    const request = vi.spyOn(prototype as unknown as { requestDefenseArtCandidates: (c: unknown) => Promise<void>[] }, 'requestDefenseArtCandidates')
      .mockImplementation((candidates) => { requested.push(candidates); return []; });
    try {
      prototype.requestSnapshotMarketArt.call(scene, [{ ...MARKET }, { id: 'ws', type: 'workshop', level: 1, tx: 2, ty: 2 }]);
      expect(requested[0]).toEqual([
        { id: 'market:pe_market_t1', kind: 'market', bodyGroup: 'pe_market_t1', groups: ['pe_market_t1'] },
        { id: 'market:pe_cosmetics', kind: 'market', bodyGroup: 'pe_cosmetics', groups: ['pe_cosmetics'] },
      ]);
      scene.marketAwnings = new Map();
      prototype.requestSnapshotMarketArt.call(scene, [{ ...MARKET, level: 12 }]);
      expect(requested[1]).toEqual([{ id: 'market:pe_market_t3', kind: 'market', bodyGroup: 'pe_market_t3', groups: ['pe_market_t3'] }]);
    } finally { request.mockRestore(); }
  });

  it('routes damage and destruction to the Market controller, and seeks onto the pack rubble — never generic fx_rubble', async () => {
    const juice = await import('../../lib/juice');
    const numbers = vi.spyOn(juice, 'floatText').mockImplementation(() => undefined);
    const { prototype, scene, created } = await harness(new Set(['pe_market_t1']));
    Object.assign(scene, { hitStar: vi.fn() });
    prototype.spawnBuilding.call(scene, { ...MARKET });
    const rec = scene.buildings.get(MARKET.id)!;
    const damage = { update: vi.fn(), collapse: vi.fn(), destroy: vi.fn() };
    rec['damage'] = damage;
    const market = { setDamaged: vi.fn(), collapse: vi.fn(), destroy: vi.fn(), atlas: 'pe_market_t1' };
    rec['market'] = market;
    prototype.onHit.call(scene, { e: 'hit', t: 1, target: MARKET.id, dmg: (rec['maxHp'] as number) * 0.6 });
    expect(market.setDamaged).toHaveBeenCalledExactlyOnceWith(true);
    expect(damage.update, 'the pack owns its damaged state').not.toHaveBeenCalled();
    prototype.onDestroyed.call(scene, { e: 'destroyed', t: 2, id: MARKET.id });
    expect(market.collapse).toHaveBeenCalledOnce();
    expect(damage.collapse).not.toHaveBeenCalled();
    expect(created[0]!['setTexture']).not.toHaveBeenCalledWith('fx', expect.anything());
    // A seek (jumping) lands directly on the rubble cell of the same family.
    const seek = await harness(new Set(['pe_market_t1']));
    seek.prototype.spawnBuilding.call(seek.scene, { ...MARKET });
    const seekRec = seek.scene.buildings.get(MARKET.id)!;
    seekRec['damage'] = { update: vi.fn(), collapse: vi.fn(), destroy: vi.fn() };
    seek.scene.jumping = true;
    seek.prototype.onDestroyed.call(seek.scene, { e: 'destroyed', t: 2, id: MARKET.id });
    expect(seek.created[0]!['setTexture']).toHaveBeenLastCalledWith('pe_market_t1', 'pe_market_t1_destroyed_f1');
    expect(seek.created[0]!['setVisible']).toHaveBeenLastCalledWith(true);
    expect(seekRec['destroyed']).toBe(true);
    // Pending art (not resident): nothing is drawn, nothing generic is substituted.
    const pending = await harness(new Set());
    pending.prototype.spawnBuilding.call(pending.scene, { ...MARKET });
    pending.scene.jumping = true;
    (pending.scene.buildings.get(MARKET.id)!)['damage'] = { update: vi.fn(), collapse: vi.fn(), destroy: vi.fn() };
    pending.prototype.onDestroyed.call(pending.scene, { e: 'destroyed', t: 2, id: MARKET.id });
    expect(pending.created[0]!['setTexture']).not.toHaveBeenCalled();
    numbers.mockRestore();
  });

  it('rests a Market destroyed before its family landed on the pack rubble once the group is resident', async () => {
    const resident = new Set<string>();
    const { prototype, scene, created } = await harness(resident);
    prototype.spawnBuilding.call(scene, { ...MARKET });
    const rec = scene.buildings.get(MARKET.id)!;
    rec['damage'] = { update: vi.fn(), collapse: vi.fn(), destroy: vi.fn() };
    scene.jumping = true;
    prototype.onDestroyed.call(scene, { e: 'destroyed', t: 2, id: MARKET.id });
    expect(created[0]!['setTexture'], 'nothing to draw yet').not.toHaveBeenCalled();
    resident.add('pe_market_t1');
    expect(prototype.adoptMarketBuildings.call(scene, new Set(['pe_market_t1']))).toBe(true);
    expect(created[0]!['setTexture']).toHaveBeenLastCalledWith('pe_market_t1', 'pe_market_t1_destroyed_f1');
    expect(created[0]!['setVisible']).toHaveBeenLastCalledWith(true);
    expect(rec['market'], 'a ruin needs no controller').toBeUndefined();
    expect(rec['artMode']).toBe('market');
    // Idempotent: a second pass over an already-resting ruin changes nothing.
    created[0]!['visible'] = true;
    expect(prototype.adoptMarketBuildings.call(scene, new Set(['pe_market_t1']))).toBe(false);
  });

  it('matches the frozen projection against the frozen snapshot at entry and restores the market route after a correction', () => {
    const source = readFileSync(new URL('./BattleScene.ts', import.meta.url), 'utf8');
    const create = source.indexOf('  create(data: {');
    const selection = source.indexOf('this.marketAwnings = selectMarketAwnings(', create);
    const request = source.indexOf('this.requestSnapshotMarketArt(data.snapshot.buildings)', selection);
    expect(selection).toBeGreaterThan(create);
    expect(request).toBeGreaterThan(selection);
    expect(source.slice(selection, request)).toContain('data.boundCosmeticVisual');
    expect(source.slice(selection, request)).toContain('underConstruction: false');
    const reset = source.indexOf('private resetPlaybackActors(');
    expect(source.slice(reset, source.indexOf('this.retileSurvivingWalls();', reset))).toContain("if (building.artMode === 'market') restoreMarket.add(id);");
    expect(source.slice(reset, source.indexOf('this.retileSurvivingWalls();', reset))).toContain('this.adoptMarketBuildings(undefined, restoreMarket)');
    const cleanup = source.indexOf('private cleanupBattle(): void');
    expect(source.slice(cleanup, cleanup + 6000)).toContain("sceneCleanup('building-market', () => b.market?.destroy())");
  });
});
