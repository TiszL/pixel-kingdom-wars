import { describe, expect, it } from 'vitest';
import {
  wareBuildingClipKey, wareFrameClipBase, wareHatchlingClipKey, wareSeat,
  wareTrapClipKey,
} from './clips';

describe('ware clip identity', () => {
  it('translates stable runtime identities without rewriting saved rows', () => {
    expect(wareBuildingClipKey('archertower', 6, 'idle')).toBe('ware_bld_archer_t2_idle');
    expect(wareBuildingClipKey('forge', 20, 'work')).toBe('ware_bld_alchemylab_t4_work');
    expect(wareBuildingClipKey('keep', 17, 'lr_fire')).toBe('ware_bld_keep_l17_lr_fire');
    expect(wareTrapClipKey('airmine', 11, 'trigger')).toBe('ware_trp_airmine_t3_trigger');
    expect(wareHatchlingClipKey(16, 'hover')).toBe('ware_unt_hatchling_t4_hover');
  });

  it('recovers a clip base from both single and directional frame names', () => {
    expect(wareFrameClipBase('ware_bld_vault_t1_idle_f2')).toBe('ware_bld_vault_t1_idle');
    expect(wareFrameClipBase('ware_bld_archer_t1_fire_d7_f4')).toBe('ware_bld_archer_t1_fire');
    expect(wareFrameClipBase('bld_vault_l1')).toBeNull();
  });

  /**
   * The seat publishes the sprite ORIGIN and draw scale only. It used to publish
   * `footprintFrac` too — 0.5 for a pixel anchor, 1 for the wall's fractional
   * one — and seating the pixel families on their footprint's middle row is what
   * lifted the whole pack off its plots (owner 2026-08-30). WHERE a building
   * sits is now one rule for every family, in `v2/clips.ts#buildingSeatY`.
   */
  it('reads pixel anchors as cell fractions and passes fractional wall anchors through', () => {
    const clips = {
      ware_bld_wall_t1_collapse: { frames: 4, rows: 16, cellW: 32, cellH: 40, anchorPx: [0.5, 1] as const },
      ware_bld_keep_l15_idle: {
        frames: 3, rows: 1, cellW: 144, cellH: 136,
        anchorPx: [72, 116] as const, unit: 'keep',
      },
      ware_bld_mine_t4_idle: {
        frames: 3, rows: 1, cellW: 96, cellH: 88,
        anchorPx: [48, 70] as const, unit: 'mine',
      },
    };
    // The wall anchor is a FRACTION, not a half-pixel coordinate — the range
    // test in wareSeat is what tells the two apart.
    expect(wareSeat(clips, 'ware_bld_wall_t1_collapse_d10_f1')).toEqual({
      origin: [0.5, 1], scale: 2,
    });
    expect(wareSeat(clips, 'ware_bld_keep_l15_idle_f1')).toEqual({
      origin: [0.5, 116 / 136], scale: 1.25, offsetGamePx: [0, 0],
    });
    expect(wareSeat(clips, 'ware_bld_mine_t4_idle_f1')).toEqual({
      origin: [0.5, 70 / 88], scale: 0.9, offsetGamePx: [1, 0],
    });
  });
});
