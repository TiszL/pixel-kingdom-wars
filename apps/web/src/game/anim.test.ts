/**
 * The animation ticker's phase handling.
 *
 * THE BUG THESE PIN (owner 2026-08-02): heroes walking the base would, at some
 * point and not always, break into a fast "dribbling"/dizzy shuffle — one frame
 * at a time, impossible to screenshot because every individual frame looks like
 * a correct walk frame. patrol.ts calls walk() on EVERY update frame, so a
 * walker whose facing flapped between two directions re-registered a
 * same-length sequence 60 times a second; register() reset the frame index to 0
 * each time, pinning the sprite at frame 1 and flickering between two facings.
 */
import { describe, expect, it, vi } from 'vitest';
import { LEVELED_TROOPS, TROOP_TYPES, atlasGroupFor } from '@shardkeep/shared';
import {
  AnimTicker,
  attackSeq,
  deathSeq,
  firstMoveFrame,
  troopSpriteBase,
  walkSeq,
  type Dir,
} from './anim';

const DIRS: Dir[] = ['e', 's', 'n'];
/** Everything that did NOT get generic per-level art in batch 13. Wyrmling is
 *  excluded because M22 routes it through the WARE Hatchling controller. */
const LEGACY_ONLY = TROOP_TYPES.filter(
  (t) => !(LEVELED_TROOPS as readonly string[]).includes(t) && t !== 'wyrmling',
);

/** Minimal Sprite stand-in: the ticker only ever calls setTexture/once/active. */
function fakeSprite() {
  const calls: Array<[string, string]> = [];
  return {
    active: true,
    calls,
    setTexture: (atlas: string, frame: string) => { calls.push([atlas, frame]); },
    once: () => {},
  } as never as Phaser.GameObjects.Sprite & { calls: Array<[string, string]> };
}

/** Drive the private tick without a Phaser clock. */
const tick = (t: AnimTicker): void => (t as never as { tick(): void }).tick();

describe('AnimTicker.register', () => {
  const walkE = ['w_e_f1', 'w_e_f2', 'w_e_f3', 'w_e_f4'];
  const walkS = ['w_s_f1', 'w_s_f2', 'w_s_f3', 'w_s_f4'];
  const idle6 = ['i_f1', 'i_f2', 'i_f3', 'i_f4', 'i_f5', 'i_f6'];

  it('KEEPS THE PHASE when a walker turns (same-length sequence)', () => {
    const t = new AnimTicker();
    const s = fakeSprite();
    t.register(s, 'hero', walkE);
    tick(t); tick(t);                      // advance to frame index 2
    (s as never as { calls: unknown[] }).calls.length = 0;

    t.register(s, 'hero', walkS);          // the turn

    // Before the fix this emitted w_s_f1 — the gait restarted mid-stride, and
    // re-registering every frame pinned it there forever.
    expect((s as never as { calls: [string, string][] }).calls).toEqual([['hero', 'w_s_f3']]);
  });

  it('re-registering the SAME facing repeatedly does not touch the sprite', () => {
    // patrol.ts calls walk() unconditionally each frame; the identical-sequence
    // early-out is what keeps that from being 60 texture writes a second.
    const t = new AnimTicker();
    const s = fakeSprite();
    t.register(s, 'hero', walkE);
    (s as never as { calls: unknown[] }).calls.length = 0;
    for (let i = 0; i < 10; i++) t.register(s, 'hero', walkE);
    expect((s as never as { calls: unknown[] }).calls).toHaveLength(0);
  });

  it('flapping between two facings every frame still ADVANCES the gait', () => {
    // The exact reported symptom. Even in the pathological case, the walk must
    // keep cycling rather than freezing near frame 1.
    const t = new AnimTicker();
    const s = fakeSprite();
    t.register(s, 'hero', walkE);
    const seen = new Set<string>();
    for (let f = 0; f < 12; f++) {
      t.register(s, 'hero', f % 2 === 0 ? walkE : walkS); // flap
      tick(t);
      const c = (s as never as { calls: [string, string][] }).calls;
      seen.add(c[c.length - 1]![1].slice(-2)); // f1..f4
    }
    expect(seen.size).toBeGreaterThan(1); // fails when pinned at f1
  });

  it('RESTARTS when the sequence length differs (walk <-> idle is a real change)', () => {
    const t = new AnimTicker();
    const s = fakeSprite();
    t.register(s, 'hero', walkE);
    tick(t); tick(t);
    (s as never as { calls: unknown[] }).calls.length = 0;
    t.register(s, 'hero', idle6);
    expect((s as never as { calls: [string, string][] }).calls).toEqual([['hero', 'i_f1']]);
  });

  it('an index carried into a shorter-but-equal-length seq stays in range', () => {
    const t = new AnimTicker();
    const s = fakeSprite();
    t.register(s, 'hero', walkE);
    for (let i = 0; i < 7; i++) tick(t);
    t.register(s, 'hero', walkS);
    const c = (s as never as { calls: [string, string][] }).calls;
    expect(walkS).toContain(c[c.length - 1]![1]); // never undefined
  });

  it('drops a destroyed/inactive sprite instead of writing to it', () => {
    const t = new AnimTicker();
    const s = fakeSprite();
    t.register(s, 'hero', walkE);
    (s as never as { active: boolean }).active = false;
    (s as never as { calls: unknown[] }).calls.length = 0;
    tick(t);
    expect((s as never as { calls: unknown[] }).calls).toHaveLength(0);
  });

  it('settles its Clock loop before a seek and can attach again on scene reuse', () => {
    const callbacks: Array<() => void> = [];
    const removes: Array<ReturnType<typeof vi.fn>> = [];
    const scene = {
      time: {
        addEvent: ({ callback }: { callback: () => void }) => {
          const remove = vi.fn();
          callbacks.push(callback);
          removes.push(remove);
          return { remove };
        },
      },
      events: { once: vi.fn() },
    };
    const t = new AnimTicker();
    const first = fakeSprite();
    t.attach(scene as never);
    t.register(first, 'hero', walkE);
    first.calls.length = 0;

    t.settle();
    // A callback already captured by Phaser for the current Clock pass is
    // harmless too: settle cleared the inventory as well as removing the timer.
    callbacks[0]!();
    expect(removes[0]).toHaveBeenCalledOnce();
    expect(first.calls).toEqual([]);

    const second = fakeSprite();
    t.attach(scene as never);
    t.register(second, 'hero', walkS);
    second.calls.length = 0;
    callbacks[1]!();
    expect(second.calls).toEqual([['hero', 'w_s_f2']]);
  });
});

/**
 * Batch-13 changed locomotion from 4 entries to 6 for the levelled dragon and
 * giant, and register() decides whether to PRESERVE the frame index purely by
 * comparing sequence LENGTHS. So the pairings above are not the whole story any
 * more: these pin the new ones, using the real sequences rather than synthetic
 * ones so a change to either side has to keep them consistent.
 */
describe('AnimTicker phase across batch-13 clip lengths', () => {
  const frames = (s: { calls: [string, string][] }): string[] => s.calls.map((c) => c[1]);
  const clear = (s: { calls: unknown[] }): void => { s.calls.length = 0; };

  it('a levelled dragon that TURNS keeps its phase (6 -> 6)', () => {
    // Same bug as the hero shuffle above, one clip length up: a banking dragon
    // must not restart its wingbeat.
    const t = new AnimTicker();
    const s = fakeSprite();
    t.register(s, 'trpdg_l7', walkSeq('dragon', 'e', 7));
    tick(t); tick(t); tick(t); tick(t);          // index 4
    clear(s);
    t.register(s, 'trpdg_l7', walkSeq('dragon', 's', 7));
    expect(frames(s)).toEqual(['trp_dragon_l7_fly_s_f5']);
  });

  it('a levelled dragon re-registered every frame still ADVANCES', () => {
    // patrol.ts/TroopFx call the walk helper unconditionally; the 6-frame cycle
    // must survive that the same way the 4-frame one does.
    const t = new AnimTicker();
    const s = fakeSprite();
    const seen = new Set<string>();
    for (let f = 0; f < 12; f++) {
      t.register(s, 'trpdg_l7', walkSeq('dragon', f % 2 === 0 ? 'e' : 's', 7));
      tick(t);
      seen.add(frames(s).at(-1)!.slice(-2));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('levelled locomotion -> levelled attack RESTARTS the swing (6 vs 4)', () => {
    // A landing dragon must begin its attack at f1; carrying the flight index
    // would start the swing mid-follow-through.
    const t = new AnimTicker();
    const s = fakeSprite();
    t.register(s, 'trpdg_l7', walkSeq('dragon', 'e', 7));
    tick(t); tick(t); tick(t);
    clear(s);
    t.register(s, 'trpdg_l7', attackSeq('dragon', 7));
    expect(frames(s)).toEqual(['trp_dragon_l7_attack_e_f1']);
  });

  it('levelled attack and levelled locomotion never collide on length', () => {
    // The whole preserve-vs-restart decision is length equality, so these two
    // MUST differ or every landing would carry a stale index.
    for (const troop of LEVELED_TROOPS) {
      expect(attackSeq(troop, 3).length).not.toBe(walkSeq(troop, 'e', 3).length);
    }
  });

  it('a rejected Wyrmling sequence cannot mutate the generic ticker', () => {
    const t = new AnimTicker();
    const s = fakeSprite();
    expect(() => t.register(s, 'trp', walkSeq('wyrmling', 'e')))
      .toThrow(/M22 WARE Hatchling adapter/);
    expect(frames(s)).toEqual([]);
  });

  it('a dragon swapping from legacy to per-level art restarts (4 vs 6)', () => {
    // trpdg_l<N> loads on demand, so a dragon can be walking with legacy keys
    // when its own atlas arrives. The families are different animations at
    // different lengths — carrying the index across would be meaningless.
    const t = new AnimTicker();
    const s = fakeSprite();
    t.register(s, 'trp', walkSeq('dragon', 'e'));
    tick(t); tick(t); tick(t);
    clear(s);
    t.register(s, 'trpdg_l4', walkSeq('dragon', 'e', 4));
    expect(frames(s)).toEqual(['trp_dragon_l4_fly_e_f1']);
  });
});

/**
 * The sequence helpers are pure string builders, and a wrong frame name is
 * SILENT — Phaser draws nothing for a missing frame instead of throwing. So
 * these assert the literal keys, not just their shape.
 */
describe('legacy (level-agnostic) troop sequences', () => {
  /** anim.ts's walk cycle EXACTLY as it stood before batch 13, kept verbatim so
   *  "the other 10 troops are untouched" is a claim that can actually fail. */
  function preBatch13WalkSeq(troop: string, dir: string): string[] {
    const b = `trp_${troop}_walk_${dir}`;
    return [`${b}_f1`, `${b}_f2`, `${b}_f3`, `${b}_f2`];
  }

  it('every generic troop keeps its exact pre-batch-13 walk cycle', () => {
    for (const troop of TROOP_TYPES) {
      if (troop === 'wyrmling') continue; // owned by the WARE Hatchling adapter
      for (const dir of DIRS) {
        expect(walkSeq(troop, dir)).toEqual(preBatch13WalkSeq(troop, dir));
      }
    }
  });

  it('spells the ping-pong out for one troop, in case the reference above drifts', () => {
    expect(walkSeq('highlander', 'e')).toEqual([
      'trp_highlander_walk_e_f1',
      'trp_highlander_walk_e_f2',
      'trp_highlander_walk_e_f3',
      'trp_highlander_walk_e_f2',
    ]);
    expect(firstMoveFrame('highlander')).toBe('trp_highlander_walk_s_f1');
    expect(attackSeq('highlander')).toEqual([
      'trp_highlander_attack_e_f1',
      'trp_highlander_attack_e_f2',
    ]);
    expect(deathSeq('highlander')).toEqual([
      'trp_highlander_death_f1',
      'trp_highlander_death_f2',
    ]);
  });

  it('the UNLEVELLED dragon still walks — it has walk_ masters and no fly_ ones', () => {
    // The batch-13 dragon flies, but `trp_dragon_walk_*` is what the `trp` atlas
    // ships and what the base view renders (its /base army payload has no level).
    // Treating the dragon as flying without a level renders literally nothing.
    for (const dir of DIRS) {
      expect(walkSeq('dragon', dir)[0]).toBe(`trp_dragon_walk_${dir}_f1`);
    }
    expect(troopSpriteBase('dragon')).toBe('trp_dragon');
  });

  it('every generic legacy troop ships 2 attack and 2 death frames', () => {
    for (const troop of TROOP_TYPES) {
      if (troop === 'wyrmling') continue; // owned by the WARE Hatchling adapter
      expect(attackSeq(troop)).toEqual([
        `trp_${troop}_attack_e_f1`,
        `trp_${troop}_attack_e_f2`,
      ]);
      expect(deathSeq(troop)).toEqual([`trp_${troop}_death_f1`, `trp_${troop}_death_f2`]);
      expect(troopSpriteBase(troop)).toBe(`trp_${troop}`);
    }
  });

  it('every legacy key resolves to the `trp` atlas', () => {
    for (const troop of TROOP_TYPES) {
      if (troop === 'wyrmling') continue;
      for (const key of [...walkSeq(troop, 'e'), ...attackSeq(troop), ...deathSeq(troop)]) {
        expect(atlasGroupFor(key)).toBe('trp');
      }
    }
  });

  it('never lets the generic locomotion builder select Wyrmling art', () => {
    for (const dir of DIRS) {
      expect(() => walkSeq('wyrmling', dir)).toThrow(/M22 WARE Hatchling adapter/);
    }
  });

  it('never lets generic attack or death builders select Wyrmling art', () => {
    expect(() => attackSeq('wyrmling')).toThrow(/M22 WARE Hatchling adapter/);
    expect(() => deathSeq('wyrmling')).toThrow(/M22 WARE Hatchling adapter/);
  });

  it('a level on a troop with no per-level art is ignored, not appended', () => {
    // Every non-dragon/giant caller may pass armyLevels blindly; `trp_mage_l3_…`
    // does not exist in any atlas.
    for (const troop of LEGACY_ONLY) {
      expect(walkSeq(troop, 'e', 3)).toEqual(walkSeq(troop, 'e'));
      expect(attackSeq(troop, 3)).toEqual(attackSeq(troop));
      expect(deathSeq(troop, 3)).toEqual(deathSeq(troop));
      expect(troopSpriteBase(troop, 3)).toBe(`trp_${troop}`);
    }
  });
});

describe('batch-13 per-level dragon/giant sequences', () => {
  it('the dragon FLIES over 6 true-cycle frames', () => {
    for (const dir of DIRS) {
      expect(walkSeq('dragon', dir, 7)).toEqual([
        `trp_dragon_l7_fly_${dir}_f1`,
        `trp_dragon_l7_fly_${dir}_f2`,
        `trp_dragon_l7_fly_${dir}_f3`,
        `trp_dragon_l7_fly_${dir}_f4`,
        `trp_dragon_l7_fly_${dir}_f5`,
        `trp_dragon_l7_fly_${dir}_f6`,
      ]);
    }
  });

  it('the giant WALKS over 6 true-cycle frames (it ships no fly_ masters)', () => {
    expect(walkSeq('giant', 'n', 12)).toEqual([
      'trp_giant_l12_walk_n_f1',
      'trp_giant_l12_walk_n_f2',
      'trp_giant_l12_walk_n_f3',
      'trp_giant_l12_walk_n_f4',
      'trp_giant_l12_walk_n_f5',
      'trp_giant_l12_walk_n_f6',
    ]);
  });

  it('locomotion never repeats a frame — the masters close their own loop', () => {
    for (const troop of LEVELED_TROOPS) {
      for (const dir of DIRS) {
        const seq = walkSeq(troop, dir, 5);
        expect(new Set(seq).size).toBe(seq.length);
      }
    }
  });

  it('attack is 4 east-only frames and death is 4 directionless frames', () => {
    expect(attackSeq('giant', 2)).toEqual([
      'trp_giant_l2_attack_e_f1',
      'trp_giant_l2_attack_e_f2',
      'trp_giant_l2_attack_e_f3',
      'trp_giant_l2_attack_e_f4',
    ]);
    expect(deathSeq('dragon', 20)).toEqual([
      'trp_dragon_l20_death_f1',
      'trp_dragon_l20_death_f2',
      'trp_dragon_l20_death_f3',
      'trp_dragon_l20_death_f4',
    ]);
  });

  it('firstMoveFrame defaults to south and honours the level', () => {
    expect(firstMoveFrame('dragon', undefined, 9)).toBe('trp_dragon_l9_fly_s_f1');
    expect(firstMoveFrame('giant', 'e', 9)).toBe('trp_giant_l9_walk_e_f1');
  });

  it('every level 1..20 produces keys the loader will find in trpdg_l<N>', () => {
    // atlasGroupFor is the packer's OWN rule. If these keys did not match it the
    // client would request a texture that exists for a frame packed elsewhere,
    // and Phaser would draw nothing rather than error.
    for (const troop of LEVELED_TROOPS) {
      for (let l = 1; l <= 20; l++) {
        const keys = [...walkSeq(troop, 'e', l), ...attackSeq(troop, l), ...deathSeq(troop, l)];
        for (const key of keys) expect(atlasGroupFor(key)).toBe(`trpdg_l${l}`);
      }
    }
  });

  it('clamps out-of-range levels to the art that exists', () => {
    // 20 levels of masters shipped; a troop levelled past them renders the top
    // tier, and a bad 0/negative renders l1 — never a missing texture.
    expect(troopSpriteBase('dragon', 0)).toBe('trp_dragon_l1');
    expect(troopSpriteBase('dragon', -5)).toBe('trp_dragon_l1');
    expect(troopSpriteBase('dragon', 21)).toBe('trp_dragon_l20');
    expect(troopSpriteBase('dragon', 999)).toBe('trp_dragon_l20');
    expect(troopSpriteBase('giant', 7.9)).toBe('trp_giant_l7');
  });

  it('falls back to legacy keys for undefined and non-finite levels', () => {
    // undefined is the documented "unlevelled" case; NaN would otherwise build
    // `trp_dragon_lNaN_…`, which exists in no atlas.
    expect(troopSpriteBase('dragon', undefined)).toBe('trp_dragon');
    expect(troopSpriteBase('dragon', Number.NaN)).toBe('trp_dragon');
    expect(walkSeq('dragon', 'e', Number.NaN)).toEqual(walkSeq('dragon', 'e'));
    expect(atlasGroupFor(walkSeq('dragon', 'e', Number.NaN)[0]!)).toBe('trp');
  });
});

/** M22 retires every generic Wyrmling key path. The sim identity remains
 * `wyrmling`, but only WareHatchlingFx may translate it into renderable art. */
describe('M22 WARE Hatchling boundary', () => {
  it('rejects generic locomotion for every requested direction', () => {
    for (const dir of DIRS) {
      expect(() => walkSeq('wyrmling', dir, 7)).toThrow(/M22 WARE Hatchling adapter/);
    }
  });

  it('rejects first-frame selection before a sprite can be allocated', () => {
    expect(() => firstMoveFrame('wyrmling', 's', 3))
      .toThrow(/M22 WARE Hatchling adapter/);
  });

  it('rejects generic attack selection at every art level', () => {
    for (const level of [1, 7, 20]) {
      expect(() => attackSeq('wyrmling', level)).toThrow(/M22 WARE Hatchling adapter/);
    }
  });

  it('rejects generic death selection at every art level', () => {
    for (const level of [1, 7, 20]) {
      expect(() => deathSeq('wyrmling', level)).toThrow(/M22 WARE Hatchling adapter/);
    }
  });

  it('rejects generic sprite bases instead of clamping into retired art', () => {
    for (const level of [undefined, Number.NaN, 0, 12, 25]) {
      expect(() => troopSpriteBase('wyrmling', level)).toThrow(/M22 WARE Hatchling adapter/);
    }
  });

  it('cannot bypass the WARE boundary with an omitted or non-finite level', () => {
    for (const level of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => walkSeq('wyrmling', 'e', level)).toThrow(/M22 WARE Hatchling adapter/);
      expect(() => attackSeq('wyrmling', level)).toThrow(/M22 WARE Hatchling adapter/);
      expect(() => deathSeq('wyrmling', level)).toThrow(/M22 WARE Hatchling adapter/);
    }
  });
});
