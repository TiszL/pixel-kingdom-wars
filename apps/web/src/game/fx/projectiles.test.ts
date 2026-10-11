/**
 * The fx art tables (batch-13 v2 pack) are pure data, and every wrong entry is
 * SILENT: Phaser draws nothing for a missing frame, and a wrong origin just
 * draws the art beside the target — nobody reports either as a bug, the combat
 * simply looks "off". So these pin the literal keys, the measured manifest
 * origins (including the two impacts the pack README wrongly calls centred),
 * and the README §6 rate bands.
 *
 * The launch/impact FUNCTIONS are exercised only by typecheck + reading: they
 * drive tweens, camera shake and SFX (Phaser-adjacent side effects), the same
 * reason BattleScene itself has no unit tests.
 */
import { atlasGroupFor } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import { BREATH_ART, FX_RATES, PROJ_ART, type ProjKind } from './projectiles';

const KINDS = Object.keys(PROJ_ART) as ProjKind[];

describe('projectile art tables', () => {
  it('flight frames are the literal v2 pack keys', () => {
    expect(PROJ_ART.cannonball.frames).toEqual(['fx_cannonball_f1', 'fx_cannonball_f2']);
    expect(PROJ_ART.arrow.frames).toEqual(['fx_arrow_f1']);
    expect(PROJ_ART.shell.frames).toEqual(['fx_shell_f1', 'fx_shell_f2']);
    expect(PROJ_ART.orb.frames).toEqual(['fx_orb_f1', 'fx_orb_f2']);
  });

  it('hit clips are the literal v2 families at their shipped lengths', () => {
    expect(PROJ_ART.cannonball.hit).toMatchObject({ base: 'fx_cannonball_hit', frames: 3 });
    expect(PROJ_ART.arrow.hit).toMatchObject({ base: 'fx_arrow_hit', frames: 2 });
    expect(PROJ_ART.shell.hit).toMatchObject({ base: 'fx_shell_hit', frames: 4 });
    expect(PROJ_ART.orb.hit).toMatchObject({ base: 'fx_orb_hit', frames: 3 });
  });

  it('the mortar shell hit is the biggest impact in the kit', () => {
    // README: "biggest explosion". Encoded two ways — most frames, and the
    // only impact drawn scaled up — so a drive-by "tidy the scales" edit that
    // demoted the mortar's landing fails here.
    for (const kind of KINDS) {
      if (kind === 'shell') continue;
      expect(PROJ_ART.shell.hit.frames, kind).toBeGreaterThan(PROJ_ART[kind].hit.frames);
      expect(PROJ_ART.shell.hit.scale, kind).toBeGreaterThan(PROJ_ART[kind].hit.scale);
    }
  });

  it('impact origins follow the MANIFEST, exceptions included', () => {
    // The pack README claims every impact anchors at sprite centre; the
    // manifest measures two exceptions and the manifest wins: the arrow's hit
    // is a stuck shaft anchored (6,10) of 14×12, the cannonball's crater sits
    // at y 0.6. Centring them plants the shaft mid-air and floats the crater.
    expect(PROJ_ART.arrow.hit.origin).toEqual([6 / 14, 10 / 12]);
    expect(PROJ_ART.cannonball.hit.origin).toEqual([0.5, 0.6]);
    expect(PROJ_ART.shell.hit.origin).toEqual([0.5, 0.5]);
    expect(PROJ_ART.orb.hit.origin).toEqual([0.5, 0.5]);
  });

  it('keeps only Dragon on the generic breath route, rooted at its maw', () => {
    // Hatchling uses the WARE hatchfire route. Keeping the table exact makes a
    // reintroduced legacy breath kind a failing test instead of latent art.
    expect(Object.keys(BREATH_ART)).toEqual(['dragon']);
    expect(BREATH_ART.dragon).toEqual({ base: 'fx_breath_dragon', frames: 4, origin: [1 / 40, 0.5] });
  });

  it('every origin is normalized 0..1 — a raw pixel anchor draws off-screen', () => {
    const origins = [
      ...KINDS.flatMap((k) => [PROJ_ART[k].origin, PROJ_ART[k].hit.origin]),
      BREATH_ART.dragon.origin,
    ];
    for (const [ox, oy] of origins) {
      expect(ox).toBeGreaterThanOrEqual(0);
      expect(ox).toBeLessThanOrEqual(1);
      expect(oy).toBeGreaterThanOrEqual(0);
      expect(oy).toBeLessThanOrEqual(1);
    }
  });

  it('every key routes to the fx atlas group (the packer’s own rule)', () => {
    const keys = [
      ...KINDS.flatMap((k) => [...PROJ_ART[k].frames, `${PROJ_ART[k].hit.base}_f1`]),
      `${BREATH_ART.dragon.base}_f1`,
      'fx_burn_1x1_f1', 'fx_burn_1x1_f2', // burnScorch's loop
      'fx_beam_f1', 'fx_zap_f1', 'fx_zap_hit_f1', // beam + zap segments/hit
      'fx_shell_shadow',
    ];
    for (const key of keys) expect(atlasGroupFor(key), key).toBe('fx');
  });
});

describe('README §6 rates', () => {
  it('sit inside the pack’s suggested bands', () => {
    // Art facts, not game numbers: flight loop 110–160, impact once 150–180,
    // breath 110–130, burn 200–240 (ms per frame). Out-of-band means someone
    // retimed the kit without re-reading the pack README.
    expect(FX_RATES.flightFrameMs).toBeGreaterThanOrEqual(110);
    expect(FX_RATES.flightFrameMs).toBeLessThanOrEqual(160);
    expect(FX_RATES.impactFrameMs).toBeGreaterThanOrEqual(150);
    expect(FX_RATES.impactFrameMs).toBeLessThanOrEqual(180);
    expect(FX_RATES.breathFrameMs).toBeGreaterThanOrEqual(110);
    expect(FX_RATES.breathFrameMs).toBeLessThanOrEqual(130);
    expect(FX_RATES.burnFrameMs).toBeGreaterThanOrEqual(200);
    expect(FX_RATES.burnFrameMs).toBeLessThanOrEqual(240);
  });
});
