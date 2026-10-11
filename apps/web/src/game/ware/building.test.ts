import { describe, expect, it } from 'vitest';
import {
  AMBIENCE, AUTHORED_ATTACK_TIMINGS, type WareBuildingUnit,
} from '@shardkeep/shared';
import {
  WareTrapFx,
  WareBuildingFx,
  wareFirePlan,
  launchWareShot,
  wareEmitterWorld,
  wareProjectileSpec,
} from './building';
import { SHAPES, composeWall, resolveWall, wallFrameKey, wallDamageStage } from '@shardkeep/shared/wallRender';
import { combatEffectPool } from '../v2/effects';
import { V2_DRAW_SCALE } from '../v2/clips';
import { V2Ticker } from '../v2/ticker';
import { wareBuildingClipKey, wareTrapClipKey, type WareClipMap } from './clips';

class FakeSprite {
  active = true;
  scale = 1;
  readonly writes: Array<[string, string]> = [];

  setTexture(atlas: string, frame: string): this { this.writes.push([atlas, frame]); return this; }
  setOrigin(): this { return this; }
  setScale(scale: number): this { this.scale = scale; return this; }
  clearTint(): this { return this; }
  once(): this { return this; }
}

function clip(frames = 1, rows = 1): WareClipMap[string] {
  return { frames, rows, cellW: 32, cellH: 32, anchorPx: rows > 1 ? [0.5, 1] : [16, 16] };
}

describe('M22 authored defense routing', () => {
  it('registers a laser beam with verdict-disposable combat FX ownership', () => {
    // WHY: a killed Phaser tween skips onComplete. The beam must live in the
    // scene effect pool so jumpToEnd can destroy it before the verdict.
    const beam = {
      active: true,
      setDepth: () => beam,
      lineStyle: () => beam,
      lineBetween: () => beam,
      setAlpha: () => beam,
      destroy: () => { beam.active = false; },
    };
    const scene = {
      add: { graphics: () => beam },
      time: { delayedCall: () => ({ remove: () => undefined }) },
    };
    expect(launchWareShot(scene as never, {}, {
      kind: 'laser', row: 0, clip: clip(), frame1: 1, targetX: 100, targetY: 20,
    }, 0, 0, 1)).toBe(true);
    expect(beam.active).toBe(true);

    combatEffectPool(scene as never).clear();

    expect(beam.active).toBe(false);
  });

  it('uses every tower-specific state and effect instead of legacy generic FX', () => {
    expect(wareFirePlan('archertower', 'arrow')).toMatchObject({ states: ['fire', 'reload'], shot: 'arrow' });
    expect(wareFirePlan('electrictower', 'arrow')).toMatchObject({ states: ['charge', 'discharge'], shot: 'tesla' });
    expect(wareFirePlan('magetower', 'arrow')).toMatchObject({ states: ['cast', 'burst'], shot: 'magebolt' });
    expect(wareFirePlan('lasertower', 'beam')).toMatchObject({ states: ['charge', 'fire'], shot: 'laser' });
    expect(wareFirePlan('airdefence', 'arrow')).toMatchObject({ states: ['track', 'fire', 'reel', 'reload'], shot: 'harpoon' });
  });

  it('selects exactly one Keep battery and makes both low-range FX reachable', () => {
    expect(wareFirePlan('keep', 'shell')).toMatchObject({ states: ['hr_load', 'hr_fire'], shot: 'trebuchet' });
    expect(wareFirePlan('keep', 'cannonball', true)?.shot).toBe('keepoil');
    expect(wareFirePlan('keep', 'cannonball', false)?.shot).toBe('keepbolt');
    expect(wareFirePlan('keep', 'arrow')).toBeNull();
  });

  it('routes projectiles and impacts only through ware frame bases', () => {
    for (const kind of ['arrow', 'magebolt', 'tesla', 'laser', 'harpoon', 'trebuchet', 'keepoil', 'keepbolt', 'hatchfire'] as const) {
      const spec = wareProjectileSpec(kind, 3)!;
      expect(`${spec.base}${spec.impact ?? ''}`).not.toMatch(/blddef|batch13|legacy/);
      expect(`${spec.base}${spec.impact ?? ''}`).toMatch(/ware_/);
    }
  });

  it('keeps tower emitters attached to the fitted body scale', () => {
    const clip = {
      frames: 1, rows: 1, cellW: 64, cellH: 96,
      anchorPx: [32, 76] as const,
      emitters: { tip: [[[42, 56]]] },
    };
    expect(wareEmitterWorld(
      { x: 320, y: 240, scaleX: 1.3, scaleY: 1.3 } as never,
      { kind: 'harpoon', row: 0, clip, frame1: 1, targetX: 0, targetY: 0 },
      'tip',
    )).toEqual({ x: 333, y: 214 });
  });

  it('uses the current Hatchling fire keys and the shared authored flight clock', () => {
    expect(wareProjectileSpec('hatchfire', 1)).toEqual({
      base: 'ware_fx_hatchfire',
      impact: 'ware_fx_hatchhit',
      durationMs: AUTHORED_ATTACK_TIMINGS.wyrmling.projectileTravelMs,
    });
  });
});

describe('M22 building job presentation', () => {
  function buildingController(unit: WareBuildingUnit = 'barracks'): {
    fx: WareBuildingFx; ticker: V2Ticker; sprite: FakeSprite;
  } {
    const clips: WareClipMap = Object.fromEntries(
      ['idle', 'build', 'levelup'].map((state) => [
        wareBuildingClipKey(unit, 1, state), clip(4),
      ]),
    );
    const ticker = new V2Ticker();
    const sprite = new FakeSprite();
    const fx = new WareBuildingFx({
      ticker, clips, unit, level: 1,
    }, sprite as never);
    return { fx, ticker, sprite };
  }

  it('holds the fitted build scaffold during upgrade, then flashes levelup once and rests', () => {
    const { fx, ticker, sprite } = buildingController();
    const build = wareBuildingClipKey('barracks', 1, 'build');
    const levelup = wareBuildingClipKey('barracks', 1, 'levelup');
    const idle = wareBuildingClipKey('barracks', 1, 'idle');

    fx.setJob('upgrade');
    expect(sprite.writes.at(-1)?.[1]).toBe(`${build}_f1`);
    expect(sprite.writes.some(([, frame]) => frame.startsWith(levelup))).toBe(false);
    ticker.tick(500); // non-loop scaffold reaches and safely holds its fitted final frame
    expect(sprite.writes.at(-1)?.[1]).toBe(`${build}_f4`);

    fx.setJob(null);
    expect(sprite.writes.at(-1)?.[1]).toBe(`${levelup}_f1`);
    ticker.tick(500); // four 8fps frames, including the final frame's dwell
    expect(sprite.writes.at(-1)?.[1]).toBe(`${idle}_f1`);
    const flashes = sprite.writes.filter(([, frame]) => frame.startsWith(levelup));
    expect(flashes.map(([, frame]) => frame)).toEqual([
      `${levelup}_f1`, `${levelup}_f2`, `${levelup}_f3`, `${levelup}_f4`,
    ]);
    ticker.tick(2_000);
    expect(sprite.writes.filter(([, frame]) => frame.startsWith(levelup))).toHaveLength(4);
  });

  it('does not let the Keep rest battery replace its active upgrade scaffold', () => {
    const { fx, sprite } = buildingController('keep');
    fx.setJob('upgrade');
    expect(sprite.writes.at(-1)?.[1]).toBe(`${wareBuildingClipKey('keep', 1, 'build')}_f1`);
  });

  it('treats a forward job kind as normalized upgrade completion', () => {
    const { fx, sprite } = buildingController();
    fx.setJob('upgrade');
    fx.setJob('future_job_kind');
    expect(sprite.writes.at(-1)?.[1])
      .toBe(`${wareBuildingClipKey('barracks', 1, 'levelup')}_f1`);
  });

  it('preserves plain build completion and invalidates an old levelup on a newer job', () => {
    const { fx, ticker, sprite } = buildingController();
    const build = wareBuildingClipKey('barracks', 1, 'build');
    const levelup = wareBuildingClipKey('barracks', 1, 'levelup');
    const idle = wareBuildingClipKey('barracks', 1, 'idle');

    fx.setJob('build');
    fx.setJob(null);
    expect(sprite.writes.at(-1)?.[1]).toBe(`${idle}_f1`);
    expect(sprite.writes.some(([, frame]) => frame.startsWith(levelup))).toBe(false);

    fx.setJob('upgrade');
    fx.setJob(null);
    expect(sprite.writes.at(-1)?.[1]).toBe(`${levelup}_f1`);
    fx.setJob('build');
    expect(sprite.writes.at(-1)?.[1]).toBe(`${build}_f1`);
    ticker.tick(2_000);
    expect(sprite.writes.at(-1)?.[1]).toBe(`${build}_f4`);
  });
});

describe('base-only cosmetic building cadence', () => {
  function fixture(restLoopSpeed?: number, ruinTexture?: () => string | null) {
    const unit = 'archertower', ticker = new V2Ticker(), sprite = new FakeSprite();
    const releases: number[] = [];
    const clips: WareClipMap = Object.fromEntries(
      ['idle', 'work', 'damaged', 'build', 'levelup', 'fire', 'reload', 'collapse'].map(state => [
        wareBuildingClipKey(unit, 1, state), { ...clip(4), fps: 12 },
      ]),
    );
    const fx = new WareBuildingFx({
      ticker, clips, unit, level: 1, ...(restLoopSpeed === undefined ? {} : { restLoopSpeed }),
      ...(ruinTexture === undefined ? {} : { ruinTexture }),
      onShot: release => { releases.push(release.frame1); },
    }, sprite as never);
    return { fx, ticker, sprite, releases };
  }

  it('plays the authored collapse in full and then rests on the resident ruin texture', () => {
    // WHY: the camp collapse sinks into the ground and its last cell is not a
    // ruin (owner 2026-09-17). The resolver runs AT collapse so a texture that
    // finished decoding after adoption is still honoured; a null resolver
    // keeps the authored hold, which is right for packs with real rubble.
    const ruined = fixture(undefined, () => 'ware_ruin_camp');
    const key = (state: string): string => wareBuildingClipKey('archertower', 1, state);
    ruined.fx.collapse(); ruined.ticker.tick(250);
    expect(ruined.sprite.writes.at(-1)?.[1]).toBe(`${key('collapse')}_f4`);
    ruined.ticker.tick(84);
    expect(ruined.sprite.writes.at(-1)).toEqual(['ware_ruin_camp', undefined]);
    expect(ruined.ticker.size).toBe(0);

    const authored = fixture(undefined, () => null);
    authored.fx.collapse(); authored.ticker.tick(334);
    expect(authored.sprite.writes.at(-1)?.[1]).toBe(`${key('collapse')}_f4`);
  });

  it.each(['idle', 'work', 'damaged'] as const)('slows the base %s loop while leaving battle defaults and repeated state refreshes alone', state => {
    const base = fixture(AMBIENCE.baseBuildingLoopSpeed), battle = fixture();
    const synchronize = ({ fx }: ReturnType<typeof fixture>): void => {
      fx.setJob(null); fx.setWorking(state === 'work'); fx.setDamaged(state === 'damaged');
    };
    synchronize(base); synchronize(battle);
    const key = wareBuildingClipKey('archertower', 1, state);
    base.ticker.tick(84); battle.ticker.tick(84);
    expect(base.sprite.writes.at(-1)?.[1]).toBe(`${key}_f1`);
    expect(battle.sprite.writes.at(-1)?.[1]).toBe(`${key}_f2`);
    const phase = base.ticker.phase(base.sprite as never);
    synchronize(base);
    expect(base.ticker.phase(base.sprite as never)).toEqual(phase);
    base.ticker.tick(28);
    expect(base.sprite.writes.at(-1)?.[1]).toBe(`${key}_f2`);
  });

  it('does not slow projectile release or replay action sequencing when leaving a slower work loop', () => {
    const base = fixture(AMBIENCE.baseBuildingLoopSpeed), battle = fixture();
    for (const f of [base, battle]) {
      f.fx.setWorking(true); f.ticker.tick(60);
      expect(f.fx.fire(100, 0, 'arrow')).toBe(true);
      f.ticker.tick(83); expect(f.releases).toEqual([]);
      f.ticker.tick(1); expect(f.releases).toEqual([2]);
      f.ticker.tick(250); // fire finishes; reload is a fresh one-shot
      expect(f.sprite.writes.at(-1)?.[1]).toBe(`${wareBuildingClipKey('archertower', 1, 'reload')}_f1`);
      f.ticker.tick(334);
      expect(f.sprite.writes.at(-1)?.[1]).toBe(`${wareBuildingClipKey('archertower', 1, 'work')}_f1`);
      expect(f.releases).toEqual([2]);
    }
    expect(base.sprite.writes).toEqual(battle.sprite.writes);
  });

  it('keeps upgrade and collapse one-shots on the authored clock even with slower base ambience', () => {
    const { fx, ticker, sprite } = fixture(AMBIENCE.baseBuildingLoopSpeed);
    const key = (state: string): string => wareBuildingClipKey('archertower', 1, state);
    fx.setJob('upgrade'); ticker.tick(334);
    expect(sprite.writes.at(-1)?.[1]).toBe(`${key('build')}_f4`);
    fx.setJob(null); ticker.tick(334);
    expect(sprite.writes.at(-1)?.[1]).toBe(`${key('idle')}_f1`);
    ticker.tick(1_000);
    expect(sprite.writes.filter(([, frame]) => frame.startsWith(key('levelup')))).toHaveLength(4);
    fx.collapse(); ticker.tick(334);
    expect(sprite.writes.at(-1)?.[1]).toBe(`${key('collapse')}_f4`);
    expect(ticker.size).toBe(0);
  });
});

describe('five-tier wall presentation replaces M22 controllers', () => {
  it('preserves the published outer-elbow rows with the wall-only five-tier progression', () => {
    expect(SHAPES).toHaveLength(16);
    expect(SHAPES[3]).toBe('corner_sw');
    expect(wallFrameKey(16, 'corner_ne')).toBe('wall5_t4_corner_ne_intact_f1');
    expect(wallFrameKey(17, 'corner_ne')).toBe('wall5_t5_corner_ne_intact_f1');
  });

  it('recomposes an existing damaged segment when its neighbour changes tier', () => {
    const grid = new Map([['0,0', { tier: 1, damage: true }], ['1,0', { tier: 2 }]]);
    const before = composeWall(grid, 0, 0)!;
    grid.set('1,0', { tier: 5 });
    const after = composeWall(grid, 0, 0)!;
    expect(resolveWall(grid, 0, 0)?.piece).toBe('end_e');
    expect(after.data).not.toEqual(before.data);
    expect(after.height).toBe(60);
  });

  it('holds separate light/heavy pixels without a zero-fps animation dependency', () => {
    const state = (hp: number) => {
      const stage = wallDamageStage(hp, 100);
      const grid = new Map([['0,0', { tier: 2, damage: stage > 0, damageStage: stage > 1 ? 2 as const : 1 as const }]]);
      return composeWall(grid, 0, 0)!.data;
    };
    expect(state(50)).not.toEqual(state(49));
    expect(state(25)).not.toEqual(state(24));
    expect(state(49)).toEqual(state(25));
    expect(state(100)).toEqual(state(50));
  });
});

describe('M22 persisted trap presentation', () => {
  it('reconciles spent and repaired state on the same live controller', () => {
    const clips: WareClipMap = {
      [wareTrapClipKey('spiketrap', 1, 'armed')]: clip(),
      [wareTrapClipKey('spiketrap', 1, 'sprung')]: clip(),
    };
    const sprite = new FakeSprite();
    const fx = new WareTrapFx({
      ticker: new V2Ticker(), clips, unit: 'spiketrap', level: 1,
    }, sprite as never, true, false);
    expect(sprite.writes.at(-1)?.[1]).toBe(`${wareTrapClipKey('spiketrap', 1, 'armed')}_f1`);

    fx.setSpent(true);
    expect(sprite.writes.at(-1)?.[1]).toBe(`${wareTrapClipKey('spiketrap', 1, 'sprung')}_f1`);
    fx.setSpent(false);
    expect(sprite.writes.at(-1)?.[1]).toBe(`${wareTrapClipKey('spiketrap', 1, 'armed')}_f1`);
    expect(sprite.scale).toBe(V2_DRAW_SCALE);
  });
});
