/**
 * The globe's view rules, pinned to WHY they exist.
 *
 * These are the assertions that would otherwise only be checked by looking at a
 * screenshot: that a band change is a CROSS-FADE (both layers visible at once, so
 * nothing pops), that reach is a HIGHLIGHT and never a filter (owner decision 1 —
 * no sector is ever dropped for being far away), that a 4 px pin is still a 44 px
 * tap target, that the terminator is a real sun vector rather than a screen-space
 * gradient, that the camera is quantised so pixel art cannot shimmer, and — the
 * one that protects everything the owner has already accepted — that with the
 * feature flag OFF the WORLD board solves the identical chrome it shipped before
 * the globe existed.
 */
import { readFileSync } from 'node:fs';
import { GLOBE } from '@shardkeep/shared';
import { EARTH_COARSE } from '@shardkeep/shared/earthMask';
import { bandForZoom, isLandAtDeg, sectorCentreDeg, sectorIdOf } from '@shardkeep/shared/globe';
import { describe, expect, it } from 'vitest';
import { MAPCHROME, mapChrome } from '../../layout';
import { GRID_MIN_PX } from './globeRaster';
import * as view from './globeView';
import {
  bandKey, bandMix, clampGlobeBrowseZoom, clampNav, earthChunks, earthTilesFeature,
  GLOBE_VIEW, globeBrowseZoomMax, globeFeature,
  interactiveFlipZoom, labelBudget,
  latTintIndex, navCamera, parcelPins, parcelRadius, pinHitRadius,
  pinRadius, quantiseNav, radiusPx, railRowsForWorld, sectorPins, settleZoom,
  sunCameraVector, sunLonLat, tileHomeZoom, tileLabelled, tilePx, TINT_BANDS, viewBand,
  type SectorCounts,
} from './globeView';

describe('globe-only browsing ceiling', () => {
  it('keeps repeated mobile zoom input on a fully visible parcel surface', () => {
    const top = globeBrowseZoomMax();
    expect(clampGlobeBrowseZoom(Number.POSITIVE_INFINITY)).toBe(top);
    // The canvas mounts here and the opening tween starts here. A first touch that
    // interrupts it must land on the visible browse surface, never remain at z4.
    expect(clampGlobeBrowseZoom(GLOBE.localZoom)).toBe(top);
    expect(clampGlobeBrowseZoom(GLOBE.zoomMin - 10)).toBe(GLOBE.zoomMin);
    expect(top).toBeLessThan(GLOBE.localZoom - GLOBE_VIEW.fade);
    expect(bandMix(top).earth).toBe(1);
    expect(bandMix(top).parcelPins).toBe(1);
  });
});

const DEG = Math.PI / 180;

describe('the feature flag is the do-not-regress guarantee', () => {
  it('is OFF for everything except an explicit 1/true', () => {
    expect(globeFeature(undefined)).toBe(false);
    expect(globeFeature('')).toBe(false);
    // The two that matter: a deployed `.env` carrying an explicit off switch must
    // never ship the globe by accident.
    expect(globeFeature('0')).toBe(false);
    expect(globeFeature('false')).toBe(false);
    expect(globeFeature('1')).toBe(true);
    expect(globeFeature('true')).toBe(true);
  });

  it('EARTH TILES parses exactly as conservatively, because it nests inside', () => {
    // Nested, not parallel (docs/EARTH-TILES-PLAN.md §6): nothing the tiles flag
    // turns on is reachable with the globe flag off, so the two guarantees compose.
    // Same parse for the same reason — a deployed `.env` with an explicit off
    // switch must never ship it.
    for (const raw of [undefined, '', '0', 'false', 'off', 'yes', 2]) {
      expect(earthTilesFeature(raw)).toBe(false);
    }
    expect(earthTilesFeature('1')).toBe(true);
    expect(earthTilesFeature('true')).toBe(true);
  });

  it('solves the WORLD board chrome exactly as it did before the globe — flag on OR off (D-097)', () => {
    // The pre-globe board asked for THREE rail rows (war room / hide shielded /
    // legend). The globe used to add a fourth for its own toggles; on a 390 px
    // phone that column ate the map, so the globe's chrome now asks the solver
    // for no rail at all (MY PARCEL rides the zoom rail's home slot, WARZONE is
    // a top-bar badge) and the board's answer is the pre-globe three either way.
    expect(railRowsForWorld(false)).toBe(3);
    expect(railRowsForWorld(true)).toBe(3);
    for (const [w, h] of [[375, 812], [412, 814], [915, 311], [320, 568]] as const) {
      for (const on of [false, true]) {
        expect(mapChrome(w, h, MAPCHROME.peek, railRowsForWorld(on), 3))
          .toEqual(mapChrome(w, h, MAPCHROME.peek, 3, 3));
      }
    }
  });

  it('the globe’s own chrome (no rail, three zoom buttons) keeps the zoom cluster on screen', () => {
    // With no rail the sheet ceiling is the viewport's; the one control that can
    // still collide is the zoom cluster, which must stay inside the window, below
    // the bar and above the sheet on every phone — including the landscape one
    // where the solver lays it out as a row.
    for (const [w, h] of [[320, 568], [390, 844], [915, 311]] as const) {
      const L = mapChrome(w, h, MAPCHROME.peek, 0, 3);
      // An empty slot: no height in portrait, no width in landscape (where the
      // solver lays the rail out as a row).
      expect(L.rail.width * L.rail.height).toBe(0);
      expect(L.zoom).not.toBeNull();
      expect(L.zoom!.left).toBeGreaterThanOrEqual(0);
      expect(L.zoom!.top).toBeGreaterThanOrEqual(L.bar.height + MAPCHROME.pad);
      expect(L.zoom!.top + L.zoom!.height).toBeLessThanOrEqual(L.sheet.top);
    }
  });
});

describe('band selection is derived from ONE zoom scalar', () => {
  it('agrees with the shared derivation at every band edge', () => {
    for (const z of [0, 0.5, GLOBE.regionZoom, 2, 3.9, GLOBE.localZoom]) {
      expect(bandMix(z).band).toBe(bandForZoom(z));
    }
    expect(bandMix(GLOBE.zoomMin).band).toBe('globe');
    expect(bandMix(GLOBE.regionZoom).band).toBe('region');
    expect(bandMix(GLOBE.localZoom).band).toBe('local');
  });

  it('hands the board back to the LOCAL map: earth reaches exactly 0', () => {
    // Not 0.01: a globe layer left at a sliver of opacity still swallows taps, and
    // the local map underneath is the screen the owner already accepted.
    expect(bandMix(GLOBE.localZoom).earth).toBe(0);
    expect(bandMix(GLOBE.zoomMin).earth).toBe(1);
    // Both ends are unambiguous from EITHER side of the hysteresis — the dead band
    // only exists in the middle, and at the ends the answer cannot depend on which
    // way you arrived.
    for (const was of [false, true]) {
      expect(bandMix(GLOBE.localZoom, was).interactive).toBe(false);
      expect(bandMix(GLOBE.zoomMin, was).interactive).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // POINTER OWNERSHIP HAS HYSTERESIS (fixed 2026-08-09)
  //
  // It was `interactive: earth > 0.5` — ONE boolean, a hard edge at zoom 3.8 — and
  // PixelGlobe writes the layer's `pointerEvents` from the rAF. A pinch never takes
  // pointer capture (capture is single-finger-drag only), so the instant a pinch
  // crossed 3.8 the layer went `pointer-events: none` UNDER THE LIVE GESTURE,
  // hit-testing fell through to the local map, and the pinch died mid-stroke. And
  // the reverse was impossible: from the local band the layer is already inert, so
  // a pinch-out could not start there at all and the GLOBE button was the only way
  // back (that half is closed in map.tsx by PULL_OUT_FRAC).
  //
  // Two thresholds are the structural half of the fix; PixelGlobe's gesture latch
  // is the other. These pin the thresholds' ORDER and the resulting dead band,
  // because a hysteresis whose two edges coincide is just the old bug spelled with
  // more code.
  // -------------------------------------------------------------------------
  describe('the band edge cannot strand a live gesture', () => {
    it('takes pointers LATER than it gives them up — a real dead band, not one edge', () => {
      expect(GLOBE_VIEW.interactiveExit).toBeLessThan(GLOBE_VIEW.interactiveEnter);
      const enter = interactiveFlipZoom(true);
      const exit = interactiveFlipZoom(false);
      // Descending (zoom rising) the globe keeps pointers PAST the zoom at which it
      // would have taken them, so the crossing is one-way per gesture.
      expect(exit).toBeGreaterThan(enter);
      // …and the dead band is wider than one pinch sample yet far narrower than the
      // fade itself, so it costs nothing visually.
      expect(exit - enter).toBeGreaterThan(0.05);
      expect(exit - enter).toBeLessThan(GLOBE_VIEW.fade / 2);
    });

    it('does not hand the surface over mid-pinch: descending keeps it past the enter edge', () => {
      const enter = interactiveFlipZoom(true);
      const exit = interactiveFlipZoom(false);
      const mid = (enter + exit) / 2;
      // Inside the dead band the answer is whatever it already was — which is what
      // "a band flip cannot steal a live pinch" means as a pure function.
      expect(bandMix(mid, true).interactive).toBe(true);
      expect(bandMix(mid, false).interactive).toBe(false);
    });

    it('a pinch OUT from the local band eventually claims the surface', () => {
      // Walking the zoom back down out of the local band, ownership must flip at the
      // enter edge and never later — otherwise the globe you are pinching towards
      // stays untouchable.
      let owns = false;
      const seen: number[] = [];
      for (let z = GLOBE.localZoom; z >= GLOBE.localZoom - GLOBE_VIEW.fade; z -= 0.01) {
        const next: boolean = bandMix(z, owns).interactive;
        if (next !== owns) seen.push(z);
        owns = next;
      }
      expect(owns).toBe(true); // it does claim it
      expect(seen).toHaveLength(1); // exactly once — no chatter
      expect(seen[0]!).toBeCloseTo(interactiveFlipZoom(true), 1);
    });

    it('never chatters: one sweep in and back out flips ownership exactly twice', () => {
      let owns = true;
      let flips = 0;
      const sweep = (from: number, to: number, step: number): void => {
        for (let z = from; step > 0 ? z <= to : z >= to; z += step) {
          const next: boolean = bandMix(z, owns).interactive;
          if (next !== owns) flips++;
          owns = next;
        }
      };
      sweep(GLOBE.zoomMin, GLOBE.localZoom, 0.01);
      sweep(GLOBE.localZoom, GLOBE.zoomMin, -0.01);
      expect(flips).toBe(2);
      expect(owns).toBe(true);
    });
  });

  it('CROSS-fades: mid-fade both the earth and the local map are visible', () => {
    const mid = bandMix(GLOBE.localZoom - GLOBE_VIEW.fade / 2);
    expect(mid.earth).toBeGreaterThan(0);
    expect(mid.earth).toBeLessThan(1);
    // Monotone, so a descend never brightens on the way down.
    const steps = [3.6, 3.7, 3.8, 3.9, 4].map((z) => bandMix(z).earth);
    for (let i = 1; i < steps.length; i++) expect(steps[i]!).toBeLessThanOrEqual(steps[i - 1]!);
  });

  it('cross-fades sector pins into valley pins instead of switching them', () => {
    const mid = bandMix(GLOBE.regionZoom - GLOBE_VIEW.fade / 2);
    expect(mid.sectorPins).toBeGreaterThan(0);
    expect(mid.valleyPins).toBeGreaterThan(0);
    // Fully in the region band: sector pins are gone, valley pins own the screen.
    expect(bandMix(GLOBE.regionZoom).sectorPins).toBe(0);
    expect(bandMix(GLOBE.regionZoom).valleyPins).toBe(1);
    // At the globe band there are no valley pins to draw at all.
    expect(bandMix(GLOBE.zoomMin).valleyPins).toBe(0);
    expect(bandMix(GLOBE.zoomMin).sectorPins).toBe(1);
  });

  it('never leaves a pin floating over the local map', () => {
    // Pin opacity is multiplied by the earth's, so when the earth is gone so are
    // the pins — otherwise valley labels would hover over today's terrain.
    const local = bandMix(GLOBE.localZoom);
    expect(local.sectorPins).toBe(0);
    expect(local.valleyPins).toBe(0);
  });

  // -------------------------------------------------------------------------
  // THE CROSS-FADE IS A PLACE TO TRAVEL THROUGH, NOT A PLACE TO STOP
  //
  // Nothing settled the camera when a gesture ended, so releasing a pinch or a
  // wheel anywhere inside [localZoom − fade, localZoom) left `earth` strictly
  // between 0 and 1 as the RESTING state: a frozen part-opacity planet, its opaque
  // backdrop dimming the valley, ghost pins over the terrain and a second ghosted
  // chrome set — permanently, because the rAF sleeps once nothing is owed, so no
  // later frame could ever resolve it. Reload was the only way out.
  //
  // `settleZoom` is the rule that makes that state unrepresentable; PixelGlobe
  // tweens to its answer on every gesture end, commit, tween end and inertia stop.
  // These assertions are the reason it can be trusted without a browser.
  // -------------------------------------------------------------------------
  describe('the camera can never come to rest half-way through the fade', () => {
    const fadeZooms = (): number[] => {
      const out: number[] = [];
      // Every 0.005 across the band, endpoints included — ~80 samples, all of which
      // used to be legal resting states.
      for (let z = GLOBE.localZoom - GLOBE_VIEW.fade; z <= GLOBE.localZoom + 1e-9; z += 0.005) {
        out.push(Math.round(z * 1000) / 1000);
      }
      return out;
    };

    it('resolves EVERY zoom in the fade band to a band edge', () => {
      const lo = GLOBE.localZoom - GLOBE_VIEW.fade;
      for (const z of fadeZooms()) {
        expect([lo, GLOBE.localZoom]).toContain(settleZoom(z));
      }
    });

    it('leaves the earth fully drawn or fully gone — never a translucent ghost', () => {
      // The invariant that actually matters on screen, stated over the whole ladder
      // rather than only the band: whatever the gesture ended on, the settled camera
      // renders one band or the other, and `earth` is exactly 0 or exactly 1.
      for (let z = GLOBE.zoomMin; z <= GLOBE.localZoom + 1e-9; z += 0.01) {
        const earth = bandMix(settleZoom(Math.round(z * 100) / 100)).earth;
        expect(earth === 0 || earth === 1).toBe(true);
      }
    });

    it('picks the NEARER edge, so the settle agrees with the gesture in progress', () => {
      const lo = GLOBE.localZoom - GLOBE_VIEW.fade;
      for (const z of fadeZooms()) {
        const settled = settleZoom(z);
        // Distance to the chosen edge is never greater than to the other one.
        expect(Math.abs(z - settled)).toBeLessThanOrEqual(
          Math.abs(z - (settled === lo ? GLOBE.localZoom : lo)) + 1e-9,
        );
      }
      // Spot-checks, so a sign error cannot hide behind the sweep above.
      expect(settleZoom(3.65)).toBe(3.6);
      expect(settleZoom(3.95)).toBe(GLOBE.localZoom);
      // A tie hands the board to the LOCAL map: at the midpoint earth is 0.5, below
      // `interactiveEnter`, so the local map already owns the pointer surface — and
      // the "midpoint" is never exact in doubles (4 − 0.4 = 3.6000000000000000888,
      // so the true midpoint is not a representable number), which is why the
      // tie-break is written with a tolerance rather than a bare comparison.
      expect(settleZoom(GLOBE.localZoom - GLOBE_VIEW.fade / 2)).toBe(GLOBE.localZoom);
    });

    it('is the IDENTITY everywhere else — the region band is a real place to sit', () => {
      // A settle that snapped the region band too would make reading a sector
      // impossible: you could not stop between the planet and the valley at all.
      for (const z of [GLOBE.zoomMin, 0.5, GLOBE.regionZoom, 1.4, 2, 3, 3.59, GLOBE.localZoom]) {
        expect(settleZoom(z)).toBe(z);
      }
      // And a settle is idempotent: settling a settled camera moves nothing, which
      // is what stops the tween that lands on an edge from tweening again forever.
      for (const z of fadeZooms()) expect(settleZoom(settleZoom(z))).toBe(settleZoom(z));
    });
  });

  it('does not want the fine mask at the globe band (first-paint budget)', () => {
    // The fine mask is a dynamic import; asking for it at zoom 0 would fetch ~7 KB
    // gzip nobody can see yet, on the band every player lands on first.
    // WITH EARTH TILES OFF — the shipped ladder, unchanged.
    expect(bandMix(GLOBE.zoomMin, false, false).wantFineMask).toBe(false);
    expect(bandMix(GLOBE.regionZoom, false, false).wantFineMask).toBe(true);
    // Requested slightly BEFORE the region band so it has landed by the time the
    // fade needs it — the coarse mask keeps drawing until then.
    expect(bandMix(GLOBE.regionZoom - GLOBE_VIEW.fade / 2, false, false).wantFineMask).toBe(true);
  });

  it('EARTH TILES holds the fine mask back to z1.2 — the measured cliff', () => {
    // THE ONE BAND EDGE P2 MOVES, and it is a performance floor, not taste.
    // docs/EARTH-TILES-PLAN.md §4.3: below z1 a 0.5° cell is 0.55-1.11 raster px
    // and 49,515 sub-pixel cells fight over ~12,700 disc pixels — measured
    // 2.5-3.3 ms on an M3, i.e. 7-17 ms on a phone. The SHIPPED trigger (0.6) sits
    // inside that cliff, which is why this is asserted rather than tuned.
    expect(GLOBE_VIEW.fineMaskZoom).toBeGreaterThan(GLOBE.regionZoom - GLOBE_VIEW.fade);
    expect(bandMix(GLOBE.regionZoom - GLOBE_VIEW.fade, false, true).wantFineMask).toBe(false);
    expect(bandMix(GLOBE.regionZoom, false, true).wantFineMask).toBe(false);
    expect(bandMix(GLOBE_VIEW.fineMaskZoom, false, true).wantFineMask).toBe(true);
    // AND THE TWO NUMBERS AGREE, WHICH IS THE POINT. One 0.5° cell's HEIGHT in
    // raster px on a 375×812 board (the narrowest the layout tests assert) is
    // 0.5546 · 4^z, measured here rather than asserted from memory:
    //   z0.6 (the SHIPPED trigger) 1.27 px — sub-pixel colour noise, no grid and no
    //     border is even representable, which is the cliff §4.3 measured;
    //   z1.2 (the new trigger)     2.93 px;
    //   z1.218                     3.00 px — where GRID_MIN_PX is reached.
    // So the fine mask lands a hair BEFORE the grid it feeds can be drawn, which is
    // the same discipline as fetching the mask before the fade needs it. If either
    // number moves, they have to move together.
    const cellPx = (z: number): number =>
      (radiusPx(z, 375) * (GLOBE.px / 812) * Math.PI) / GLOBE.fineRows;
    expect(cellPx(GLOBE.regionZoom - GLOBE_VIEW.fade)).toBeLessThan(2);
    expect(cellPx(GLOBE_VIEW.fineMaskZoom)).toBeGreaterThan(GRID_MIN_PX - 1);
    expect(cellPx(GLOBE_VIEW.fineMaskZoom + 0.05)).toBeGreaterThanOrEqual(GRID_MIN_PX);
  });

  it('FLAG OFF DOWNLOADS NOTHING NEW — at every zoom, including the open animation', () => {
    // THE BUG (adversarial pass D5, 2026-08-10): the parcel grid and the fine country
    // index were fetched off `mix.wantParcels` alone, and GlobeLayer's open effect
    // SEEDS the camera at `GLOBE.localZoom` before tweening out to the whole planet —
    // which is above `parcelZoom − fade`, so every GLOBE press with the flag UNSET
    // pulled 13.1 KB gzip of a feature that was switched off. A flag that still ships
    // its payload is not a rollback, and the network tab is the easiest place to catch
    // it, so this sweeps the WHOLE ladder rather than the two thresholds.
    for (let z = GLOBE.zoomMin; z <= GLOBE.localZoom + 0.001; z += 0.05) {
      const off = earthChunks(bandMix(z, false, false), false);
      expect(off.countryIndex).toBe(false);
      expect(off.parcelGrid).toBe(false);
      // …and the fine mask is NOT gated: it ships today at the region band, so
      // withholding it would be a change to flag-off behaviour in the other
      // direction. The flag moves WHEN it is wanted, never WHETHER.
      expect(off.fineMask).toBe(bandMix(z, false, false).wantFineMask);
    }
    // The exact zoom the open animation seeds, named, because that is the frame the
    // leak happened on and a threshold sweep could step over it.
    expect(earthChunks(bandMix(GLOBE.localZoom, false, false), false)).toEqual({
      fineMask: true, countryIndex: false, parcelGrid: false,
    });
    // WITH THE FLAG ON the same camera authorises both, or the feature could not draw
    // a tile — the guard must not be a switch that turns the phase off as well.
    const on = earthChunks(bandMix(GLOBE_VIEW.parcelZoom, false, true), true);
    expect(on).toEqual({ fineMask: true, countryIndex: true, parcelGrid: true });
    // …and the parcel grid still waits for the band, so the globe band never fetches
    // it even with the flag on (the 13.1 KB is paid by a player who descends).
    expect(earthChunks(bandMix(GLOBE.zoomMin, false, true), true).parcelGrid).toBe(false);
  });

  it('the flag moves the fine mask and NOTHING else', () => {
    // A flag that changed a second thing would make "flag off is today's globe" a
    // claim about two code paths instead of one.
    for (const z of [0, 0.6, 1, 1.2, 2, 2.6, 3.9, GLOBE.localZoom]) {
      const off = bandMix(z, false, false);
      const on = bandMix(z, false, true);
      expect({ ...on, wantFineMask: off.wantFineMask }).toEqual(off);
    }
  });
});

describe('pin size reads population without lying about it', () => {
  it('is logarithmic: a 40,000-player sector is not 3,000× a 12-player one', () => {
    const small = pinRadius(12);
    const huge = pinRadius(40_000);
    expect(huge).toBeGreaterThan(small);
    expect(huge / small).toBeLessThan(3);
  });

  it('clamps at both ends — legible at the bottom, neighbourly at the top', () => {
    expect(pinRadius(0)).toBe(GLOBE_VIEW.pinMin);
    expect(pinRadius(-5)).toBe(GLOBE_VIEW.pinMin); // never negative geometry
    expect(pinRadius(50_000_000)).toBe(GLOBE_VIEW.pinMax);
  });

  it('is monotonic in population', () => {
    let prev = 0;
    for (const n of [0, 1, 10, 100, 1_000, 10_000, 100_000]) {
      const r = pinRadius(n);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });

  it('keeps the 44px touch minimum every other map control is held to', () => {
    expect(pinHitRadius(GLOBE_VIEW.pinMin) * 2).toBeGreaterThanOrEqual(MAPCHROME.tap);
    expect(pinHitRadius(GLOBE_VIEW.pinMax) * 2).toBeGreaterThanOrEqual(MAPCHROME.tap);
  });
});

describe('sector aggregation to pins', () => {
  // Three real places bases could stand — Tokyo, Nairobi, Denver — each served as
  // the centroid of the bases its sector counts, in the sector that contains it.
  // Tokyo's sector (135–150°E, 30–45°N) has its geometric centre in the Pacific,
  // which is the whole point of the first test below.
  const TOKYO = { lon: 139.7, lat: 35.7 };
  const NAIROBI = { lon: 36.8, lat: -1.3 };
  const DENVER = { lon: -105, lat: 39.7 };
  const ID_TOKYO = sectorIdOf(TOKYO.lon, TOKYO.lat);
  const ID_NAIROBI = sectorIdOf(NAIROBI.lon, NAIROBI.lat);
  const ID_DENVER = sectorIdOf(DENVER.lon, DENVER.lat);
  const counts: SectorCounts[] = [
    { id: ID_TOKYO, valleys: 1, players: 5, active: 1, ...TOKYO, warzone: false },
    { id: ID_NAIROBI, valleys: 9, players: 4_000, active: 40, ...NAIROBI, warzone: false },
    { id: ID_DENVER, valleys: 2, players: 60, active: 3, ...DENVER, warzone: false },
  ];

  it('places each pin at the SERVED centroid — never the sector’s geometric centre, never sea', () => {
    // WHY (D-096): a pin used to be drawn at `sectorCentreDeg(id)`, and 186 of the
    // 288 centres are open water — a yellow square in the Atlantic that zoomed into
    // nothing. The server now averages the counted bases' cells, so the pin stands
    // on ground somebody holds; the client must draw it THERE and nowhere else.
    const pins = sectorPins(counts);
    expect(pins).toHaveLength(3);
    for (const p of pins) {
      const served = counts.find((c) => c.id === p.id)!;
      expect(p.lon).toBe(served.lon);
      expect(p.lat).toBe(served.lat);
      expect({ lon: p.lon, lat: p.lat }).not.toEqual(sectorCentreDeg(p.id));
      // The centroid classifies back to its sector (it is inside the box it was
      // averaged from), so a tap descends into the right place…
      expect(sectorIdOf(p.lon, p.lat)).toBe(p.id);
      // …and it is land on the coarse mask, because a base's cell is.
      expect(isLandAtDeg(EARTH_COARSE, p.lon, p.lat)).toBe(true);
    }
    // The old anchor really was the problem: one of these three sectors' geometric
    // centres is sea, and that is where its pin would have gone.
    expect(counts.some((c) => {
      const centre = sectorCentreDeg(c.id);
      return !isLandAtDeg(EARTH_COARSE, centre.lon, centre.lat);
    })).toBe(true);
  });

  it('has no geometric-centre fallback left — a sector without lon/lat is a server bug (D-097)', () => {
    // The one-release fallback drew a sector a pre-D-096 server sent no position
    // for at its geometric centre. With the pair deployed together there is no
    // such server, and a fallback nobody can reach is a placement rule nobody
    // tests — so `SectorCounts.lon`/`lat` are required and the client never
    // computes a position of its own: a served position off the geometric
    // centre is drawn exactly where it was served.
    const source = readFileSync(new URL('./globeView.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('sectorCentreDeg');
    const off = { lon: 139.7, lat: 35.7 };
    const [pin] = sectorPins([{ id: ID_TOKYO, valleys: 1, players: 5, active: 1, ...off, warzone: false }]);
    expect({ lon: pin!.lon, lat: pin!.lat }).toEqual(off);
    expect({ lon: pin!.lon, lat: pin!.lat }).not.toEqual(sectorCentreDeg(ID_TOKYO));
  });

  it('NEVER omits a sector for being out of reach (owner decision 1)', () => {
    // The honest globe: reach is trophies, not distance. With no reach at all the
    // whole populated planet is still drawn — the ring is the only difference.
    const none = sectorPins(counts, [], null);
    expect(none).toHaveLength(counts.length);
    expect(none.every((p) => !p.ring)).toBe(true);
    const some = sectorPins(counts, [ID_NAIROBI], null);
    expect(some).toHaveLength(counts.length);
    expect(some.filter((p) => p.ring).map((p) => p.id)).toEqual([ID_NAIROBI]);
  });

  it('flags the viewer’s own sector and draws it LAST so its pulse is never buried', () => {
    const pins = sectorPins(counts, [ID_NAIROBI], ID_TOKYO);
    expect(pins.at(-1)!.id).toBe(ID_TOKYO);
    expect(pins.at(-1)!.mine).toBe(true);
    expect(pins.filter((p) => p.mine)).toHaveLength(1);
  });

  it('draws small pins before big ones so a busy neighbour cannot bury a quiet sector', () => {
    const pins = sectorPins(counts, [], null);
    for (let i = 1; i < pins.length; i++) expect(pins[i]!.r).toBeGreaterThanOrEqual(pins[i - 1]!.r);
  });

  it('carries counts through unchanged — the globe shows population, never ownership', () => {
    const pins = sectorPins(counts, [], null);
    const byId = new Map(pins.map((p) => [p.id, p]));
    for (const c of counts) {
      expect(byId.get(c.id)!.players).toBe(c.players);
      expect(byId.get(c.id)!.valleys).toBe(c.valleys);
      expect(byId.get(c.id)!.active).toBe(c.active);
    }
  });
});

/**
 * THE PARCEL BAND — "1 deed = 1 parcel", made visible (P6).
 *
 * The owner asked whether one deed is one valley and whether it READS on the world
 * UI. The data half was already true (`plots.player_wallet` is unique and the plots
 * row moves with the deed); what did not exist was a zoom at which one dot is one
 * base. These assertions pin the four things about that band that a screenshot
 * cannot: that it is a CROSS-FADE out of the valley pins rather than a fourth
 * screen, that it never re-decides GLOBE / REGION / LOCAL behind `bandForZoom`'s
 * back, that it cannot be stranded by the settle, and that the lattice which makes
 * ~491 parcels visible inside a 1.5 km valley is anchored, bounded and centred.
 */
describe('the parcel band makes one deed = one parcel visible', () => {
  it('is a REFINEMENT of the shared band derivation, never a second one', () => {
    // Everything outside the region span must answer exactly what bandForZoom says,
    // or the globe would have two disagreeing opinions about which band is live.
    for (const z of [GLOBE.zoomMin, 0.5, 0.99, GLOBE.localZoom, GLOBE.localZoom + 1]) {
      expect(viewBand(z)).toBe(bandForZoom(z));
    }
    // Inside it, only the deep half is renamed.
    expect(viewBand(GLOBE.regionZoom)).toBe('region');
    expect(viewBand(GLOBE_VIEW.parcelZoom - 0.01)).toBe('region');
    expect(viewBand(GLOBE_VIEW.parcelZoom)).toBe('parcel');
    expect(viewBand(GLOBE.localZoom - 0.01)).toBe('parcel');
    expect(bandForZoom(GLOBE_VIEW.parcelZoom)).toBe('region');
  });

  it('cross-fades valley pins into parcel pins instead of switching them', () => {
    const mid = bandMix(GLOBE_VIEW.parcelZoom - GLOBE_VIEW.fade / 2);
    expect(mid.valleyPins).toBeGreaterThan(0);
    expect(mid.parcelPins).toBeGreaterThan(0);
    // Fully in the parcel band: the valley pins have handed over completely.
    expect(bandMix(GLOBE_VIEW.parcelZoom).parcelPins).toBe(1);
    expect(bandMix(GLOBE_VIEW.parcelZoom).valleyPins).toBe(0);
    // …and there are no parcels to draw while the player is still browsing regions.
    expect(bandMix(GLOBE.regionZoom).parcelPins).toBe(0);
    expect(bandMix(GLOBE.zoomMin).parcelPins).toBe(0);
  });

  it('never leaves a parcel floating over the local map', () => {
    // Same rule the other two layers obey: pin opacity is multiplied by the
    // earth's, so when the local board owns the screen nothing hovers over it.
    expect(bandMix(GLOBE.localZoom).parcelPins).toBe(0);
  });

  it('fetches the roster BEFORE the lattice is visible, and never sooner', () => {
    // ~500 markers: it must not fire while the player is reading a region, and it
    // must have landed by the time the pins are wanted.
    expect(bandMix(GLOBE.regionZoom).wantParcels).toBe(false);
    expect(bandMix(GLOBE_VIEW.parcelZoom - GLOBE_VIEW.fade / 2).wantParcels).toBe(true);
    expect(bandMix(GLOBE_VIEW.parcelZoom).wantParcels).toBe(true);
  });

  it('sits clear of the settle band, so the parcels are a place you may STOP', () => {
    // The band the camera may not rest in is [localZoom − fade, localZoom). If the
    // parcel band overlapped it, a gesture that ended on the parcels would be
    // evicted from them — the one state P6 must not be able to reach.
    expect(GLOBE_VIEW.parcelZoom).toBeLessThan(GLOBE.localZoom - GLOBE_VIEW.fade);
    expect(settleZoom(GLOBE_VIEW.parcelZoom)).toBe(GLOBE_VIEW.parcelZoom);
    for (let z = GLOBE_VIEW.parcelZoom; z < GLOBE.localZoom - GLOBE_VIEW.fade; z += 0.05) {
      expect(viewBand(settleZoom(z))).toBe('parcel');
    }
    // And it starts after the REGION fade has finished, so the two hand-overs
    // cannot happen on top of each other.
    expect(GLOBE_VIEW.parcelZoom - GLOBE_VIEW.fade).toBeGreaterThan(GLOBE.regionZoom);
  });

  it('commits to React on every boundary that changes the words or the data', () => {
    // The camera lives in a ref and commits on gesture boundaries; these are the
    // extra boundaries the parcel band adds. Without them a pinch that sails past
    // an edge draws the deeper band with the shallower band's data.
    const key = (z: number): string => bandKey(bandMix(z));
    expect(key(GLOBE.regionZoom)).not.toBe(key(GLOBE_VIEW.parcelZoom - GLOBE_VIEW.fade / 2));
    expect(key(GLOBE_VIEW.parcelZoom - 0.01)).not.toBe(key(GLOBE_VIEW.parcelZoom));
    // …and it is stable WITHIN a band, or every frame would re-render the chrome.
    expect(key(GLOBE_VIEW.parcelZoom)).toBe(key(GLOBE_VIEW.parcelZoom + 0.3));
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE SCREEN-SPACE LATTICE IS GONE, AND ~270 LINES OF ITS TESTS WITH IT. (P4b)
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * WHAT USED TO BE ASSERTED HERE, and why every one of those assertions was RIGHT
   * about the code and WRONG about the world:
   *
   *  - "opens with the fade: every parcel starts ON its valley pin" — `parcelSpread`.
   *  - "ARRIVES as the whole 25×20 valley, portrait and landscape" — `parcelStepPx`
   *    derived from the short side so one screen held one neighbourhood.
   *  - "refuses parcel taps until one parcel owns a 44 px cell" — `parcelsTappable`,
   *    because ~11 overlapping `pinHitRadius` circles made "nearest wins"
   *    deterministic rather than correct.
   *  - "gives each parcel a target that TILES the lattice" — `parcelHitRadius`.
   *  - "centres the lattice on the valley's real site" — `parcelOffset`, which read
   *    `gx`, `gy` and `step` and NOTHING ELSE: no mask, no cell, no lat/lon, no
   *    projection.
   *  - "puts the viewer's own parcel in the MIDDLE of the board" — `parcelHomeNav`'s
   *    three-pass residual solve, needed only because a parcel had no position of its
   *    own to look at.
   *
   * THE REASON THEY WERE WRITTEN IS THE REASON THEY ARE DELETED. globeView.ts said it
   * in its own words: "THE LATTICE IS DRAWN IN SCREEN SPACE, AND THAT IS A DELIBERATE
   * FICTION … a valley is 1.5 km × 1.2 km and at these zooms the whole valley is ~5 px
   * across: geographically-honest parcels would be one dot." That premise was true
   * while a parcel was 3.49 km² of nowhere in particular. The owner's decision of
   * 2026-08-10 (Q1) changed the premise: a parcel IS one real 0.5° Earth land cell,
   * ~39 × 56 km — a county — so it has a lat/lon of its own, it is 51.7 px at z2.6 on a
   * phone, and it needs no explosion to be visible. The fiction's whole job was to
   * make something visible that is now simply there.
   *
   * These tests are therefore not weakened to pass, and not renamed to survive: the
   * behaviour they pinned no longer exists, so they are gone, and the law that replaced
   * them is pinned below. The one thing NOT deleted is the arithmetic they were built
   * around — a 25×20 lattice ~1,100 px wide anchored in a 2° cell a few px wide is why
   * parcels landed in the sea, and `tiles.test.ts` now asserts the opposite property
   * directly: every parcel is on claimable Earth.
   */
  describe('a tile’s size is a fact about the projection, not an invention', () => {
    it('is R·π/rows — the same measure for every latitude, and the generous one', () => {
      // A 0.5° cell subtends π/rows of LATITUDE wherever it is, so height is a single
      // honest measure of "how big is a tile"; its WIDTH shrinks with cos φ (2.02×
      // narrower at 60°, 5.90× at 80°), so height also never over-promises a target.
      for (const z of [0, 1, 1.2, 2, 2.6, 3.5]) {
        expect(tilePx(z, 375)).toBeCloseTo((radiusPx(z, 375) * Math.PI) / GLOBE.fineRows, 9);
      }
      // The measured ladder on the narrowest board the layout tests assert, which is
      // what every zoom decision in the plan was solved from: 1.407 · 4^zoom CSS px.
      expect(tilePx(0, 375)).toBeCloseTo(1.407, 3);
      expect(tilePx(1, 375)).toBeCloseTo(5.63, 2);
      expect(tilePx(2, 375)).toBeCloseTo(22.5, 1);
      expect(tilePx(2.6, 375)).toBeCloseTo(51.7, 1);
      // Monotone in zoom — a descend can never shrink a tile, which is the property
      // the old lattice needed two multiplied factors to guarantee.
      let prev = -1;
      for (let z = GLOBE.zoomMin; z <= GLOBE.localZoom; z += 0.05) {
        const px = tilePx(z, 375);
        expect(px).toBeGreaterThan(prev);
        prev = px;
      }
    });

    it('reaches a 44 px target at the SAME zoom the label ladder speaks at', () => {
      // ONE number doing two jobs on purpose: the plan's "the selected tile's own
      // label only at z ≥ 2.5" and "44 px like every other control" are the same
      // threshold on a 375 board, so writing them as two constants would let them
      // drift apart. Measured: it solves to z 2.494.
      expect(tileLabelled(MAPCHROME.tap)).toBe(true);
      expect(tileLabelled(MAPCHROME.tap - 0.01)).toBe(false);
      expect(tileLabelled(tilePx(2.4, 375))).toBe(false);
      expect(tileLabelled(tilePx(2.5, 375))).toBe(true);
    });

    it('flies MY PARCEL to a zoom where the aim can be honoured, in the parcel band', () => {
      for (const [w, h] of [[375, 812], [412, 814], [915, 311], [320, 568]] as const) {
        const short = Math.min(w, h);
        const z = tileHomeZoom(short);
        // A real place to sit: inside the parcel band, and clear of the cross-fade
        // `settleZoom` would evict the flight from the instant it landed.
        expect(bandForZoom(z)).toBe('region');
        expect(viewBand(z)).toBe('parcel');
        expect(settleZoom(z)).toBe(z);
        expect(z).toBeLessThan(GLOBE.localZoom - GLOBE_VIEW.fade);
        // …and the tile there is a full tap target, which is the whole claim. (It is
        // clamped up to `parcelZoom` on every one of these viewports, because a county
        // is 44 px slightly BELOW the band — the honest consequence of the scale.)
        expect(tileLabelled(tilePx(z, short))).toBe(true);
        expect(z).toBeGreaterThanOrEqual(GLOBE_VIEW.parcelZoom);
      }
    });

    it('caps canvas labels at a NUMBER, because 86,122 tiles cannot each have one', () => {
      // The shipped code drew every pin's label with a plate, no collision test and no
      // zoom gate, while GLOBE.valleysPerSectorCap is 240 — up to 240 plates on a
      // 375 px board. The ladder is now three rungs and one hard cap, and the cap is
      // what makes the worst case a fact rather than a hope.
      expect(GLOBE_VIEW.labelMax).toBeLessThanOrEqual(6);
      expect(GLOBE_VIEW.labelMax).toBeGreaterThan(0);
      // Cluster counts arrive only once a sector is a screenful — WORLDMAP-GLOBE-PLAN's
      // "names at z > 2" intent, moved to 1.5 with `parcelZoom` at 2 (D-096) — and
      // that is above the band where the crosshair country answers instead, and
      // below the band where the parcels take over from the clusters.
      expect(GLOBE_VIEW.valleyLabelZoom).toBeGreaterThan(GLOBE.regionZoom);
      expect(GLOBE_VIEW.valleyLabelZoom).toBeLessThan(GLOBE_VIEW.parcelZoom);
    });

    it('names every parcel on screen when the neighbourhood is sparse, and only then (D-096)', () => {
      // WHY: "only Samuel is named" was the 6-plate cap biting on a screen of four
      // bases. With ≤ labelMaxSparse parcel markers on the canvas every one may carry
      // its name; one more and the hard cap returns, so label spam stays impossible.
      // The sparse budget needs the PARCEL layer live: cluster counts at region zoom
      // and country names below z1 never unlock it.
      expect(GLOBE_VIEW.labelMaxSparse).toBe(24);
      expect(GLOBE_VIEW.labelMaxSparse).toBeGreaterThan(GLOBE_VIEW.labelMax);
      expect(labelBudget(4, true)).toBe(GLOBE_VIEW.labelMaxSparse);
      expect(labelBudget(GLOBE_VIEW.labelMaxSparse, true)).toBe(GLOBE_VIEW.labelMaxSparse);
      expect(labelBudget(GLOBE_VIEW.labelMaxSparse + 1, true)).toBe(GLOBE_VIEW.labelMax);
      expect(labelBudget(491, true)).toBe(GLOBE_VIEW.labelMax);
      expect(labelBudget(0, false)).toBe(GLOBE_VIEW.labelMax);
      expect(labelBudget(4, false)).toBe(GLOBE_VIEW.labelMax);
    });

    it('opens the parcel band as soon as tiles are legible on a wide board (D-096)', () => {
      // 2.6 → 2.0: at the new band edge a tile is already a 44 px name target on any
      // board 733 px or wider, and one pinch away on a phone. The hand-over still
      // starts after the REGION fade has finished (asserted above), so lowering it
      // did not stack two cross-fades.
      expect(GLOBE_VIEW.parcelZoom).toBe(2);
      expect(tileLabelled(tilePx(GLOBE_VIEW.parcelZoom, 733))).toBe(true);
      expect(tileLabelled(tilePx(GLOBE_VIEW.parcelZoom, 375))).toBe(false);
      expect(tileLabelled(tilePx(2.5, 375))).toBe(true);
    });

    it('does not bring the fiction back under another name', () => {
      // A regression pin with teeth: these seven exports were the entire screen-space
      // parcel lattice, and re-introducing any of them would mean a parcel had stopped
      // being a place again. Asserted on the module's own keys so it fails HERE.
      for (const gone of [
        'parcelOffset', 'parcelStepPx', 'parcelSpread', 'parcelsTappable',
        'parcelHitRadius', 'parcelTapZoom', 'parcelHomeNav',
      ]) {
        expect(Object.keys(view)).not.toContain(gone);
      }
      // …and the two tuning numbers that existed only to serve them.
      expect(Object.keys(GLOBE_VIEW)).not.toContain('parcelGridPad');
      expect(Object.keys(GLOBE_VIEW)).not.toContain('parcelGrowBase');
    });
  });

  describe('parcel pins', () => {
    const rows = [
      { x: 3, y: 4, earthCell: 101, keepLevel: 9, mine: false },
      { x: 12, y: 8, earthCell: 102, keepLevel: 1, mine: true },
      { x: 20, y: 2, earthCell: 103, keepLevel: 4, mine: false },
    ];

    it('draws YOUR parcel LAST so its marker is never buried by 490 others', () => {
      const pins = parcelPins(rows);
      expect(pins.at(-1)).toMatchObject({ x: 12, y: 8, mine: true });
      expect(pins.filter((p) => p.mine)).toHaveLength(1);
      // Everyone else: small keeps first, same reason sector pins are ordered.
      const others = pins.filter((p) => !p.mine);
      for (let i = 1; i < others.length; i++) {
        expect(others[i]!.r).toBeGreaterThanOrEqual(others[i - 1]!.r);
      }
    });

    it('keeps plot coordinates EXACTLY as the server sent them', () => {
      // plots.(x, y) is the parcel's identity and the deed's Location — a pin may
      // be drawn anywhere, but it may not renumber the land.
      expect(parcelPins(rows).map((p) => `${p.x},${p.y}`).sort())
        .toEqual(['12,8', '20,2', '3,4']);
    });

    it('sizes by keep level, clamped at both ends', () => {
      expect(parcelRadius(1)).toBe(GLOBE_VIEW.parcelPinMin);
      expect(parcelRadius(0)).toBe(GLOBE_VIEW.parcelPinMin);
      expect(parcelRadius(-5)).toBe(GLOBE_VIEW.parcelPinMin);
      expect(parcelRadius(99)).toBe(GLOBE_VIEW.parcelPinMax);
      expect(parcelRadius(4)).toBeGreaterThan(parcelRadius(2));
    });

    it('carries no identity at all — the type cannot hold a wallet or a name', () => {
      // The read-only visit contract, enforced by SHAPE rather than by remembering
      // to omit something: a parcel row is a place, a size and "is this mine".
      // Object.keys is the assertion because a future field would break it here
      // rather than on somebody else's screen.
      const pin = parcelPins([{ x: 1, y: 2, earthCell: 100, keepLevel: 3, mine: false }])[0]!;
      expect(Object.keys(pin).sort()).toEqual(['earthCell', 'keepLevel', 'mine', 'r', 'x', 'y']);
    });
  });
});

describe('the terminator is a real sun, at a real instant', () => {
  it('puts the subsolar point over the tropics at the solstices', () => {
    // June solstice: the sun is overhead at the Tropic of Cancer (+23.44°).
    expect(sunLonLat(Date.UTC(2026, 5, 21, 12)).lat).toBeCloseTo(23.4, 0);
    // December solstice: Tropic of Capricorn.
    expect(sunLonLat(Date.UTC(2026, 11, 21, 12)).lat).toBeCloseTo(-23.4, 0);
    // Equinoxes: on the equator, within the approximation's half-degree.
    expect(Math.abs(sunLonLat(Date.UTC(2026, 2, 20, 12)).lat)).toBeLessThan(1.5);
    expect(Math.abs(sunLonLat(Date.UTC(2026, 8, 22, 12)).lat)).toBeLessThan(1.5);
  });

  it('tracks 15° of longitude per hour, westward, from noon UTC over Greenwich', () => {
    expect(sunLonLat(Date.UTC(2026, 5, 21, 12)).lon).toBeCloseTo(0, 6);
    expect(sunLonLat(Date.UTC(2026, 5, 21, 6)).lon).toBeCloseTo(90, 6); // Asia at 06:00Z
    expect(sunLonLat(Date.UTC(2026, 5, 21, 18)).lon).toBeCloseTo(-90, 6); // the Americas at 18:00Z
    // Midnight UTC lands on the antimeridian, and normalizeLon's half-open range
    // puts it at −180 (the same convention every sector and mask bin uses).
    expect(sunLonLat(Date.UTC(2026, 5, 21, 0)).lon).toBeCloseTo(-180, 6);
  });

  it('is deterministic in the timestamp — a fixed instant is a fixed shadow', () => {
    const a = sunLonLat(1_800_000_000_000);
    const b = sunLonLat(1_800_000_000_000);
    expect(a).toEqual(b);
  });

  it('rotates the sun into camera space: noon at the centre is pure out-of-screen', () => {
    // An exact sun, so the assertion is about the ROTATION and not about the
    // declination approximation (which is ±0.5° — see sunLonLat's own tests).
    const centre = sunCameraVector({ lam0: 0, phi0: 0, zoom: 0 }, { lon: 0, lat: 0 });
    expect(centre.so).toBeCloseTo(1, 9);
    expect(centre.se).toBeCloseTo(0, 9);
    expect(centre.sn).toBeCloseTo(0, 9);
    // …and the same point seen from a camera 30° north: the sun is now 30° SOUTH
    // of the centre, i.e. screen −y, with the rest of it still out-of-screen.
    const tilted = sunCameraVector({ lam0: 0, phi0: 30 * DEG, zoom: 0 }, { lon: 0, lat: 0 });
    expect(tilted.sn).toBeCloseTo(-Math.sin(30 * DEG), 9);
    expect(tilted.so).toBeCloseTo(Math.cos(30 * DEG), 9);
  });

  it('puts the sun on the EAST limb when the camera faces 90° west of it', () => {
    // Camera centred on 90°W with the sun over 0°: the daylight side is to the
    // camera's east, i.e. screen +x, and the centre of the disc is at dusk.
    const v = sunCameraVector({ lam0: -90 * DEG, phi0: 0, zoom: 0 }, { lon: 0, lat: 0 });
    expect(v.se).toBeCloseTo(1, 6);
    expect(v.so).toBeCloseTo(0, 6);
  });

  it('reports night when the sun is behind the planet', () => {
    // Sun over the antipode of the camera centre ⇒ the whole visible disc, whose
    // depth term dominates at the centre, is unlit.
    const v = sunCameraVector({ lam0: 0, phi0: 0, zoom: 0 }, { lon: 180, lat: 0 });
    expect(v.so).toBeCloseTo(-1, 6);
  });

  it('is a UNIT vector, so the day/night test needs no normalisation per pixel', () => {
    for (const ms of [0, 1_700_000_000_000, Date.UTC(2026, 7, 9, 3, 17)]) {
      const v = sunCameraVector({ lam0: 1.2, phi0: -0.4, zoom: 1 }, sunLonLat(ms));
      expect(Math.hypot(v.se, v.sn, v.so)).toBeCloseTo(1, 9);
    }
  });
});

describe('the camera cannot shimmer, escape, or invert', () => {
  it('quantises rotation to whole raster pixels', () => {
    const R = 150;
    const a = quantiseNav({ lam0: 0.5, phi0: 0.2, zoom: 0 }, R);
    // On the 1/R grid: multiplying back by R must land on an integer.
    expect(a.lam0 * R).toBeCloseTo(Math.round(a.lam0 * R), 9);
    expect(a.phi0 * R).toBeCloseTo(Math.round(a.phi0 * R), 9);
    // THE anti-shimmer property: two cameras less than half a raster pixel apart
    // quantise to the SAME angle, so a slow spin redraws identical pixels instead
    // of re-sampling the mask a fraction of a pixel at a time.
    const b = quantiseNav({ lam0: 0.5 + 0.4 / R, phi0: 0.2, zoom: 0 }, R);
    expect(b.lam0).toBe(a.lam0);
    // Zoom is never quantised — it drives the cross-fade, which must stay smooth.
    expect(quantiseNav({ lam0: 0, phi0: 0, zoom: 1.234 }, R).zoom).toBe(1.234);
  });

  it('clamps latitude off the poles and zoom to the band ladder', () => {
    const max = GLOBE_VIEW.phiMaxDeg * DEG;
    expect(clampNav({ lam0: 0, phi0: 3, zoom: 0 }).phi0).toBeCloseTo(max, 9);
    expect(clampNav({ lam0: 0, phi0: -3, zoom: 0 }).phi0).toBeCloseTo(-max, 9);
    expect(clampNav({ lam0: 0, phi0: 0, zoom: -5 }).zoom).toBe(GLOBE.zoomMin);
    expect(clampNav({ lam0: 0, phi0: 0, zoom: 99 }).zoom).toBe(GLOBE.localZoom);
  });

  it('normalises longitude half-open, matching every sector and mask bin', () => {
    // Spinning east forever must not accumulate: 3π wraps to −π, not to +π (the
    // antimeridian belongs to the FIRST bin, not the last).
    expect(clampNav({ lam0: Math.PI * 3, phi0: 0, zoom: 0 }).lam0).toBeCloseTo(-Math.PI, 9);
    expect(clampNav({ lam0: -Math.PI * 3, phi0: 0, zoom: 0 }).lam0).toBeCloseTo(-Math.PI, 9);
  });

  it('fits the whole planet on the short side at zoom 0, and scales by band', () => {
    expect(radiusPx(0, 375) * 2).toBeLessThan(375);
    expect(radiusPx(0, 375) * 2).toBeGreaterThan(375 * 0.7); // and fills it
    // One band = one zoomBase step, which is what makes a 4× pinch exactly one band.
    expect(radiusPx(1, 375) / radiusPx(0, 375)).toBeCloseTo(GLOBE_VIEW.zoomBase, 9);
  });

  it('projects pins with the SAME camera as the continents, only scaled', () => {
    const nav = { lam0: 0.3, phi0: 0.2, zoom: 1 };
    const screen = navCamera(nav, 375, 812);
    const raster = navCamera(nav, 375, 812, GLOBE.px / 812);
    expect(screen.cx).toBe(375 / 2);
    expect(screen.cy).toBe(812 / 2);
    const k = GLOBE.px / 812;
    expect(raster.R).toBeCloseTo(screen.R * k, 9);
    expect(raster.cx).toBeCloseTo(screen.cx * k, 9);
    expect(raster.lam0).toBe(screen.lam0);
    expect(raster.phi0).toBe(screen.phi0);
  });
});

describe('continents read as terrain, not silhouette', () => {
  it('tints by climate band, ice at the caps and jungle at the equator', () => {
    expect(latTintIndex(84)).toBe(0); // Greenland / Antarctica
    expect(latTintIndex(-79)).toBe(0);
    expect(latTintIndex(51)).toBe(2); // temperate-boreal Europe
    expect(latTintIndex(25)).toBe(4); // the Sahara belt
    expect(latTintIndex(2)).toBe(TINT_BANDS - 1); // Congo
  });

  it('is symmetric about the equator and covers every band', () => {
    const seen = new Set<number>();
    for (let lat = -90; lat <= 90; lat += 1) {
      const i = latTintIndex(lat);
      expect(latTintIndex(-lat)).toBe(i);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(TINT_BANDS);
      seen.add(i);
    }
    expect(seen.size).toBe(TINT_BANDS);
  });
});
