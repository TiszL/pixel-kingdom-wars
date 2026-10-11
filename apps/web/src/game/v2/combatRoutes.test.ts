/**
 * D-034 renderer matrix.
 *
 * These are deliberately end-to-end at the controller/FX seam: Phaser fails
 * soft when one directional frame or compact alias is absent, and a body-only
 * assertion cannot prove that the projectile still arrives when damage does.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AUTHORED_ATTACK_TIMINGS,
  DEFENSE_PROJECTILE_TIMINGS,
  authoredAttackTiming,
  atlasGroupFor,
  resolveAttackTiming,
  v2CompactCombatAtlasGroup,
  v2CompactCombatFrameKey,
  v2TroopFallbackFxBaseKey,
} from '@shardkeep/shared';
import {
  clipFrames, clipKey, facingRow,
  V2_PROJ, V2_TICK_MS,
  type BreathStreamMeta, type Facing8, type V2Clip, type V2ClipMap,
  type V2ProjKind,
} from './clips';
import { advanceCombatEffects } from './effects';
import { V2DefenseFx } from './defense';
import { launchV2Projectile } from './projectiles';
import {
  V2TroopFx, V2_TROOP_PROFILES,
  type V2TroopDeps, type V2TroopProfile, type V2TroopUnit,
} from './troop';
import { V2Ticker } from './ticker';

const metaUrl = new URL('../../../public/atlas/meta.json', import.meta.url);
if (!existsSync(metaUrl)) {
  throw new Error('apps/web/public/atlas/meta.json is not built — run `pnpm assets` first');
}
const META = JSON.parse(readFileSync(metaUrl, 'utf8')) as {
  v2Clips: V2ClipMap;
  breathStream: BreathStreamMeta;
};

const HEADINGS: ReadonlyArray<readonly [Facing8, number, number, number]> = [
  // Literal travel rows after the renderer's y×0.25 projection. Keeping these
  // independent of headingRow prevents the test from restating the bug.
  ['s', 0, 400, 2], ['sw', -400, 400, 4], ['w', -400, 0, 4], ['nw', -400, -400, 4],
  ['n', 0, -400, 6], ['ne', 400, -400, 0], ['e', 400, 0, 0], ['se', 400, 400, 0],
];
const PROJECTILE_ROWS: ReadonlyArray<readonly [number, number, number]> = [
  // [generated row, screen dx, screen dy]; dy is ×0.25 in launchV2Projectile.
  [0, 400, 0], [1, 100, 400], [2, 0, 400], [3, -100, 400],
  [4, -400, 0], [5, -100, -400], [6, 0, -400], [7, 100, -400],
];
const ACTIVE_ROSTER = Object.keys(V2_TROOP_PROFILES) as V2TroopUnit[];
const packedFrameCache = new Map<string, Set<string>>();

function packedFrames(atlas: string): Set<string> {
  const cached = packedFrameCache.get(atlas);
  if (cached) return cached;
  const url = new URL(`../../../public/atlas/${atlas}@1x.json`, import.meta.url);
  if (!existsSync(url)) throw new Error(`missing packed atlas ${atlas}@1x.json`);
  const json = JSON.parse(readFileSync(url, 'utf8')) as {
    textures: Array<{ frames: Array<{ filename: string }> }>;
  };
  const frames = new Set(json.textures.flatMap((texture) =>
    texture.frames.map((frame) => frame.filename)));
  packedFrameCache.set(atlas, frames);
  return frames;
}

function expectPackedWrite(write: string, route: string): void {
  const slash = write.indexOf('/');
  const atlas = write.slice(0, slash);
  const frame = write.slice(slash + 1);
  expect(packedFrames(atlas).has(frame), `${route}: ${write} exists in generated art`).toBe(true);
}

class FakeDisplay {
  active = true;
  depth = 0;
  scale = 1;
  scaleY = 1;
  rotation = 0;
  alpha = 1;
  visible = true;
  width = 0;
  height = 0;
  readonly writes: string[] = [];
  private destroyHandlers: Array<() => void> = [];

  constructor(public x: number, public y: number, atlas = '', frame = '') {
    if (frame) this.writes.push(`${atlas}/${frame}`);
  }

  setTexture(atlas: string, frame: string): this { this.writes.push(`${atlas}/${frame}`); return this; }
  setOrigin(_x?: number, _y?: number): this { return this; }
  setDepth(depth: number): this { this.depth = depth; return this; }
  setPosition(x: number, y: number): this { this.x = x; this.y = y; return this; }
  setScale(scale: number, scaleY = scale): this { this.scale = scale; this.scaleY = scaleY; return this; }
  setRotation(rotation: number): this { this.rotation = rotation; return this; }
  setAlpha(alpha: number): this { this.alpha = alpha; return this; }
  setVisible(visible: boolean): this { this.visible = visible; return this; }
  setSize(width: number, height: number): this { this.width = width; this.height = height; return this; }
  once(event: string, callback: () => void): this {
    if (event === 'destroy') this.destroyHandlers.push(callback);
    return this;
  }
  destroy(): void {
    if (!this.active) return;
    this.active = false;
    for (const callback of this.destroyHandlers.splice(0)) callback();
  }
}

class FakeContainer {
  active = true;
  depth = 0;
  scale = 1;
  rotation = 0;
  readonly children: FakeDisplay[] = [];
  constructor(public x: number, public y: number) {}
  setDepth(depth: number): this { this.depth = depth; return this; }
  setScale(scale: number): this { this.scale = scale; return this; }
  setPosition(x: number, y: number): this { this.x = x; this.y = y; return this; }
  setRotation(rotation: number): this { this.rotation = rotation; return this; }
  add(children: FakeDisplay[]): this { this.children.push(...children); return this; }
  destroy(destroyChildren = false): void {
    this.active = false;
    if (destroyChildren) for (const child of this.children) child.destroy();
  }
}

interface FakeTimer {
  delay: number;
  callback: () => void;
  removed: boolean;
  remove: () => void;
}

class FakeScene {
  readonly sprites: FakeDisplay[] = [];
  readonly images: FakeDisplay[] = [];
  readonly containers: FakeContainer[] = [];
  readonly delayed: FakeTimer[] = [];
  readonly tweensAdded: Array<{ onComplete?: () => void }> = [];
  readonly killedTweens: unknown[] = [];
  readonly textures = { exists: (): boolean => true };
  readonly cameras = { main: { shake: (): void => undefined } };
  readonly add = {
    sprite: (x: number, y: number, atlas: string, frame: string): FakeDisplay => {
      const value = new FakeDisplay(x, y, atlas, frame);
      this.sprites.push(value);
      return value;
    },
    image: (x: number, y: number, atlas: string, frame: string): FakeDisplay => {
      const value = new FakeDisplay(x, y, atlas, frame);
      this.images.push(value);
      return value;
    },
    tileSprite: (
      x: number, y: number, width: number, height: number, atlas: string, frame: string,
    ): FakeDisplay => {
      const value = new FakeDisplay(x, y, atlas, frame).setSize(width, height);
      this.images.push(value);
      return value;
    },
    container: (x: number, y: number): FakeContainer => {
      const value = new FakeContainer(x, y);
      this.containers.push(value);
      return value;
    },
  };
  readonly time = {
    delayedCall: (delay: number, callback: () => void): FakeTimer => {
      const timer: FakeTimer = {
        delay, callback, removed: false,
        remove(): void { this.removed = true; },
      };
      this.delayed.push(timer);
      return timer;
    },
  };
  readonly tweens = {
    add: (config: { onComplete?: () => void }): object => {
      this.tweensAdded.push(config);
      return {};
    },
    addCounter: (): object => ({}),
    killTweensOf: (target: unknown): void => { this.killedTweens.push(target); },
  };
}

function controller(unit: V2TroopUnit, compact: boolean) {
  const ticker = new V2Ticker();
  const scene = new FakeScene();
  const deps: V2TroopDeps = {
    ticker,
    clips: META.v2Clips,
    breath: META.breathStream,
    unit,
    tier: 1,
    compact,
    meleeDriven: true,
    ...(compact ? {
      fxBaseFor: (base: string) => v2TroopFallbackFxBaseKey(unit, 1, base),
    } : {}),
  };
  const fx = new V2TroopFx(scene as never, deps, 500, 600, 600);
  ticker.tick(5_000); // settle the optional spawn before measuring a combat route
  return { deps, fx, scene, ticker, sprite: scene.sprites[0]! };
}

const imagesNamed = (scene: FakeScene, fragment: string): FakeDisplay[] =>
  scene.images.filter((image) => image.writes[0]?.includes(fragment));

describe('generated projectile row contract', () => {
  it('selects every literal row for every active rich/compact projectile family', () => {
    const families: ReadonlyArray<readonly [V2ProjKind, V2TroopUnit | null]> = [
      ['arrow', 'bowman'], ['boulder', 'giant'], ['bolt', 'mage'],
      ['hexshot', 'hexbarrow'], ['cannonball', null], ['shell', null],
    ];
    let verified = 0;
    for (const [projectile, compactUnit] of families) {
      for (const compact of compactUnit ? [false, true] : [false]) {
        for (const [expectedRow, dx, dy] of PROJECTILE_ROWS) {
          const scene = new FakeScene();
          const launched = launchV2Projectile(
            scene as never, META.v2Clips, projectile, 1,
            500, 600, 500 + dx, 600 + dy, undefined,
            compact && compactUnit
              ? { baseFor: (base) => v2TroopFallbackFxBaseKey(compactUnit, 1, base) }
              : undefined,
          );
          expect(launched, `${projectile} ${compact ? 'compact' : 'rich'} row ${expectedRow}`)
            .toBe(true);
          const shot = imagesNamed(scene, projectile)[0]!;
          expect(shot.writes[0]).toContain(`_d${expectedRow}_f1`);
          expectPackedWrite(
            shot.writes[0]!, `${projectile} ${compact ? 'compact' : 'rich'} row ${expectedRow}`,
          );
          verified++;
        }
      }
    }
    // Four troop families have rich+compact art; two defense families are rich-only.
    expect(verified).toBe((4 * 2 + 2) * 8);
  });
});

describe('D-034 complete directional troop lifecycle', () => {
  it('plays motion → every authored death frame → hold/fade in all 240 routes', () => {
    expect(ACTIVE_ROSTER).toEqual([
      'highlander', 'bowman', 'kegrunner', 'tunneler', 'turrider', 'plunderer',
      'giant', 'troll', 'dragon', 'mage', 'bilgewraith', 'gloamfang',
      'direwyvern', 'hexbarrow', 'barrowling',
    ]);
    let verified = 0;
    for (const unit of ACTIVE_ROSTER) {
      const profile = V2_TROOP_PROFILES[unit] as V2TroopProfile;
      const base = clipKey(profile.kind, unit, 1, profile.death);
      const clip = META.v2Clips[base]!;
      for (const compact of [false, true]) {
        for (const [heading, dx, dy] of HEADINGS) {
          const h = controller(unit, compact);
          h.fx.onPos(h.sprite.x + dx, h.sprite.y + dy, 500);
          const mark = h.sprite.writes.length;
          h.fx.onDeath();
          h.ticker.tick((1_000 / (clip.fps ?? 10)) * clip.frames + 1);

          const row = facingRow(clip, heading);
          const frames = compact
            ? Array.from({ length: clip.frames }, (_, i) =>
              v2CompactCombatFrameKey(unit, 1, profile.death, row, i + 1, clip.rows))
            : clipFrames(base, clip, row);
          const atlas = compact ? v2CompactCombatAtlasGroup(unit, 1) : atlasGroupFor(frames[0]!);
          expect(h.sprite.writes.slice(mark), `${unit} ${compact ? 'compact' : 'rich'} ${heading}`)
            .toEqual(frames.map((frame) => `${atlas}/${frame}`));
          for (const write of h.sprite.writes.slice(mark)) {
            expectPackedWrite(write, `${unit} ${compact ? 'compact' : 'rich'} ${heading}`);
          }
          const hold = h.scene.delayed.at(-1)!;
          expect(hold.delay).toBe(400);
          expect(h.sprite.active).toBe(true);
          hold.callback();
          h.scene.tweensAdded.at(-1)!.onComplete?.();
          expect(h.sprite.active).toBe(false);
          const settledWrites = h.sprite.writes.length;
          h.ticker.tick(10_000);
          expect(h.sprite.writes).toHaveLength(settledWrites);
          verified++;
        }
      }
    }
    expect(verified).toBe(15 * 2 * 8);
  });
});

describe('D-034 ranged release → flight → impact matrix', () => {
  const routes: ReadonlyArray<readonly [
    'bowman' | 'giant' | 'mage' | 'hexbarrow', V2ProjKind, string,
  ]> = [
    ['bowman', 'arrow', 'impact_burn'],
    ['giant', 'boulder', 'impact_rubble'],
    ['mage', 'bolt', 'bolt_hit'],
    ['hexbarrow', 'hexshot', 'impact_crater'],
  ];

  it('matches SIM9 release/impact clocks and directional travel art in all 64 routes', () => {
    let verified = 0;
    for (const [unit, projectile, impact] of routes) {
      const timing = authoredAttackTiming(unit, 'building', unit === 'giant');
      const flightMs = V2_PROJ[projectile].travelTicks * V2_TICK_MS;
      expect(timing.projectileTravelMs, unit).toBe(flightMs);
      expect(timing.impactOffsetsTicks, unit).toEqual([
        Math.ceil((timing.releaseOffsetMs + flightMs) / 100),
      ]);
      for (const compact of [false, true]) {
        for (const [heading, dx, dy, expectedTravelRow] of HEADINGS) {
          const h = controller(unit, compact);
          const target = { x: h.sprite.x + dx, y: h.sprite.y + dy };
          let releases = 0;
          const launch = (from: { x: number; y: number }): void => {
            releases++;
            launchV2Projectile(
              h.scene as never, META.v2Clips, projectile, 1,
              from.x, from.y, target.x, target.y, undefined,
              compact ? { baseFor: h.deps.fxBaseFor! } : undefined,
            );
          };
          if (unit === 'giant') h.fx.onSiegeThrow(target.x, target.y);
          else h.fx.onRangedAttack(target.x, target.y, launch);

          h.ticker.tick(timing.releaseOffsetMs - 1);
          expect(imagesNamed(h.scene, projectile), `${unit} early ${heading}`).toHaveLength(0);
          h.ticker.tick(1);
          const shots = imagesNamed(h.scene, projectile);
          expect(shots, `${unit} release ${heading}`).toHaveLength(1);
          if (unit !== 'giant') expect(releases).toBe(1);
          const shot = shots[0]!;
          expect(shot.writes[0], `${unit} projectile ${heading}`)
            .toContain(`_d${expectedTravelRow}_f1`);
          expectPackedWrite(shot.writes[0]!, `${unit} projectile ${heading}`);
          const bodyClip = META.v2Clips[clipKey(
            (V2_TROOP_PROFILES[unit] as V2TroopProfile).kind,
            unit, 1, unit === 'giant' ? 'throw' : (V2_TROOP_PROFILES[unit] as V2TroopProfile).ranged!.state,
          )]!;
          const bodyWrite = h.sprite.writes.find(
            (write) => write.includes(`_d${facingRow(bodyClip, heading)}_`)
              && write.includes(`_${unit === 'giant' ? 'throw' : (V2_TROOP_PROFILES[unit] as V2TroopProfile).ranged!.state}_`),
          );
          expect(bodyWrite, `${unit} body ${heading}`).toBeDefined();
          expectPackedWrite(bodyWrite!, `${unit} body ${heading}`);

          advanceCombatEffects(h.scene as never, flightMs - 1);
          expect(imagesNamed(h.scene, impact), `${unit} premature impact ${heading}`).toHaveLength(0);
          advanceCombatEffects(h.scene as never, 1);
          expect(imagesNamed(h.scene, impact), `${unit} impact ${heading}`).toHaveLength(1);
          expectPackedWrite(imagesNamed(h.scene, impact)[0]!.writes[0]!, `${unit} impact ${heading}`);
          verified++;
        }
      }
    }
    expect(verified).toBe(4 * 2 * 8);
  });
});

describe('D-034 Dragon and Direwyvern streams', () => {
  it('keeps Dragon root/mid/tip connected through all three contacts in all 32 routes', () => {
    const timing = authoredAttackTiming('dragon', 'building');
    expect(timing.impactOffsetsTicks).toEqual([3, 4, 5]);
    expect(timing.releaseOffsetTicks).toBe(Math.ceil(timing.releaseOffsetMs / 100));
    let verified = 0;
    for (const compact of [false, true]) {
      for (const [heading, dx, dy] of HEADINGS) {
        const h = controller('dragon', compact);
        const target = { x: h.sprite.x + dx, y: h.sprite.y + dy };
        h.fx.onBreath(target.x, target.y);
        h.ticker.tick(timing.releaseOffsetMs - 1);
        expect(h.scene.containers).toHaveLength(0);
        h.ticker.tick(1);
        const stream = h.scene.containers[0]!;
        expect(stream.children).toHaveLength(3);
        expect(stream.children.every((part) => part.active)).toBe(true);
        for (const part of stream.children) {
          expectPackedWrite(part.writes[0]!, `dragon ${compact ? 'compact' : 'rich'} ${heading}`);
        }
        expect(stream.rotation).toBeCloseTo(Math.atan2(target.y - stream.y, target.x - stream.x), 6);
        expect(imagesNamed(h.scene, 'impact_burn')).toHaveLength(1);
        const body = META.v2Clips.v2_trp_dragon_t1_breath!;
        const bodyWrite = h.sprite.writes.find((write) =>
          write.includes('_breath_') && write.includes(`_d${facingRow(body, heading)}_`));
        expect(bodyWrite).toBeDefined();
        expectPackedWrite(bodyWrite!, `dragon body ${compact ? 'compact' : 'rich'} ${heading}`);
        h.ticker.tick(timing.impactOffsetsTicks.at(-1)! * 100 - timing.releaseOffsetMs - 1);
        expect(stream.children.every((part) => part.active), `${compact} ${heading}`).toBe(true);
        h.ticker.tick(1); // the final contact owns the end of the last stream-frame dwell
        expect(stream.children.every((part) => !part.active)).toBe(true);
        verified++;

        const close = controller('dragon', compact);
        close.fx.onBreath(close.sprite.x + dx / 10, close.sprite.y + dy / 10);
        close.ticker.tick(timing.releaseOffsetMs);
        expect(close.scene.containers).toHaveLength(0);
        expect(imagesNamed(close.scene, 'breath')).toHaveLength(1);
        const puff = imagesNamed(close.scene, 'breath')[0]!;
        expectPackedWrite(puff.writes[0]!,
          `dragon puff ${compact ? 'compact' : 'rich'} ${heading}`);
        expect(imagesNamed(close.scene, 'impact_burn')).toHaveLength(0);
        advanceCombatEffects(close.scene as never,
          timing.impactOffsetsTicks.at(-1)! * 100 - timing.releaseOffsetMs);
        expect(puff.active).toBe(true); // one-piece puff covers the final contact tick
        verified++;
      }
    }
    expect(verified).toBe(2 * 2 * 8);
  });

  it('keeps Dire fan and maul impacts on their ability clocks in all 32 routes', () => {
    const firestorm = resolveAttackTiming(AUTHORED_ATTACK_TIMINGS.direFirestorm);
    const maul = resolveAttackTiming(AUTHORED_ATTACK_TIMINGS.direMaul);
    expect(firestorm.impactOffsetsTicks).toEqual([
      Math.ceil((6 * 1_000 / 11) / 100),
    ]);
    expect(maul.impactOffsetsTicks).toEqual([
      Math.ceil(maul.releaseOffsetMs / 100),
    ]);
    let verified = 0;
    for (const compact of [false, true]) {
      for (const [heading, dx, dy] of HEADINGS) {
        const fan = controller('direwyvern', compact);
        const target = { x: fan.sprite.x + dx, y: fan.sprite.y + dy };
        fan.fx.onAbility('firestorm', fan.sprite.x, fan.sprite.y, target.x, target.y);
        fan.ticker.tick(firestorm.releaseOffsetMs - 1);
        expect(fan.scene.sprites).toHaveLength(1);
        fan.ticker.tick(1);
        expect(fan.scene.sprites).toHaveLength(2);
        const fanFx = fan.scene.sprites[1]!;
        expectPackedWrite(fanFx.writes[0]!, `dire fan ${compact ? 'compact' : 'rich'} ${heading}`);
        expect(fanFx.rotation).toBeCloseTo(Math.atan2(target.y - fanFx.y, target.x - fanFx.x), 6);
        // The owner lab aims AND stretches its fan to the struck target.
        // A correctly rotated fixed-length sprite can still burn empty ground.
        const fanClip = META.v2Clips.v2_fx_firestorm_t1!;
        const reach = (fanClip.cellW - fanClip.anchorPx![0]) * fanFx.scale;
        expect(fanFx.x + Math.cos(fanFx.rotation) * reach).toBeCloseTo(target.x, 6);
        expect(fanFx.y + Math.sin(fanFx.rotation) * reach).toBeCloseTo(target.y, 6);

        fan.ticker.tick(firestorm.impactOffsetsTicks[0]! * 100 - firestorm.releaseOffsetMs);
        expect(fanFx.active).toBe(true); // burnfield event arrives while the authored fan is visible
        const body = META.v2Clips.v2_trp_direwyvern_t1_firestorm!;
        const fanBodyWrite = fan.sprite.writes.find((write) =>
          write.includes('_firestorm_') && write.includes(`_d${facingRow(body, heading)}_`));
        expect(fanBodyWrite).toBeDefined();
        expectPackedWrite(fanBodyWrite!, `dire body ${compact ? 'compact' : 'rich'} ${heading}`);
        verified++;

        const hit = controller('direwyvern', compact);
        hit.fx.onPos(hit.sprite.x + dx, hit.sprite.y + dy, 500);
        hit.fx.onAbility('maul', hit.sprite.x, hit.sprite.y);
        hit.ticker.tick(maul.releaseOffsetMs - 1);
        expect(imagesNamed(hit.scene, 'impact_slam')).toHaveLength(0);
        hit.ticker.tick(1);
        expect(imagesNamed(hit.scene, 'impact_slam')).toHaveLength(1);
        expectPackedWrite(imagesNamed(hit.scene, 'impact_slam')[0]!.writes[0]!,
          `dire maul ${compact ? 'compact' : 'rich'} ${heading}`);
        const secondWing = hit.scene.delayed.at(-1)!;
        expect(secondWing.delay).toBeCloseTo(1_000 / 12, 6);
        secondWing.callback();
        expect(imagesNamed(hit.scene, 'impact_slam')).toHaveLength(2);
        expectPackedWrite(imagesNamed(hit.scene, 'impact_slam')[1]!.writes[0]!,
          `dire second maul ${compact ? 'compact' : 'rich'} ${heading}`);
        const maulBody = META.v2Clips.v2_trp_direwyvern_t1_maul!;
        const maulBodyWrite = hit.sprite.writes.find((write) =>
          write.includes('_maul_') && write.includes(`_d${facingRow(maulBody, heading)}_`));
        expect(maulBodyWrite).toBeDefined();
        expectPackedWrite(maulBodyWrite!, `dire maul body ${compact ? 'compact' : 'rich'} ${heading}`);
        verified++;
      }
    }
    expect(verified).toBe(2 * 2 * 8);
  });
});

describe('D-034 protected defense projectiles', () => {
  it('releases and lands Cannon/Mortar on their event clock in all 16 headings', () => {
    let verified = 0;
    for (const [unit, projectile, impact] of [
      ['cannon', 'cannonball', 'impact_crater'],
      ['mortar', 'shell', 'impact_crater'],
    ] as const) {
      const timing = DEFENSE_PROJECTILE_TIMINGS[unit];
      expect(V2_PROJ[projectile].travelTicks * V2_TICK_MS).toBe(timing.flightMs);
      for (const [heading, dx, dy, expectedTravelRow] of HEADINGS) {
        const scene = new FakeScene();
        const ticker = new V2Ticker();
        const sprite = new FakeDisplay(500, 600);
        const fx = new V2DefenseFx(
          scene as never, { ticker, clips: META.v2Clips, unit, tier: 1 }, sprite as never,
        );
        const target = { x: sprite.x + dx, y: sprite.y + dy };
        fx.fire(target.x, target.y);
        ticker.tick(timing.releaseOffsetMs - 1);
        expect(imagesNamed(scene, projectile), `${unit} early ${heading}`).toHaveLength(0);
        ticker.tick(1);
        const shots = imagesNamed(scene, projectile);
        expect(shots, `${unit} release ${heading}`).toHaveLength(1);
        const shot = shots[0]!;
        expectPackedWrite(shot.writes[0]!, `${unit} projectile ${heading}`);
        expect(shot.writes[0]).toContain(`_d${expectedTravelRow}_f1`);
        const fire = META.v2Clips[`v2_bld_${unit}_t1_fire`]!;
        const fireWrite = sprite.writes.find((write) =>
          write.includes('_fire_') && write.includes(`_d${facingRow(fire, heading)}_`));
        expect(fireWrite).toBeDefined();
        expectPackedWrite(fireWrite!, `${unit} body ${heading}`);
        advanceCombatEffects(scene as never, timing.flightMs - 1);
        expect(imagesNamed(scene, impact)).toHaveLength(0);
        advanceCombatEffects(scene as never, 1);
        expect(imagesNamed(scene, impact)).toHaveLength(1);
        expectPackedWrite(imagesNamed(scene, impact)[0]!.writes[0]!, `${unit} impact ${heading}`);
        verified++;
      }
    }
    expect(verified).toBe(2 * 8);
  });
});
