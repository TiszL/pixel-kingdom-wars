import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { BASE_GROUND_ART, BASE_GROUND_ART_V2, BASE_GROUND_ART_V3, BASE_GROUND_ART_V4, CURRENT_BASE_VISUAL, DEFAULT_BASE_VISUAL, REALM_IDS, baseGroundArt, baseGroundPath, baseGroundTransport, campaignBaseVisualForAct, currentBaseVisualForRealm, isBaseVisualContext, isLayeredBaseVisualContext, isRealmKitBaseVisualContext, createGroundRaster, renderGroundPixels, resolveBaseVisualContext, unsupportedGroundRevision, CURRENT_LAYERED_REVISION_BY_REALM } from './baseVisual';
import { BASE_LAYERED_GROUND_V5, layeredGroundDescriptor } from './layeredGroundCatalogue';

const FROZEN_CLEARING_V1 = { version: 1, realmId: 'crownlands', artVersion: 2, groundRevision: 1 } as const;
const source = { width: 320, height: 320, data: new Uint8ClampedArray(320 * 320 * 4) };
for (let y = 0; y < 320; y++) for (let x = 0; x < 320; x++) {
  const offset = (y * 320 + x) * 4;
  source.data.set([x % 256, y % 256, Math.floor(x / 256), 255], offset);
}
describe('frozen base visuals', () => {
  it('changes only v2 download representation while preserving frozen contexts and canonical deed PNGs', () => {
    for (const realmId of REALM_IDS) {
      const context = { version: 1 as const, realmId, artVersion: 2 as const };
      const before = JSON.stringify(context);
      const transport = baseGroundTransport(context);
      expect(transport.path).toBe(`/atlas/fantasy/ground-v2/${realmId}.webp`);
      expect(transport.mime).toBe('image/webp');
      expect(transport.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(transport.sha256).not.toBe(BASE_GROUND_ART_V2.sources[realmId].sha256);
      expect(baseGroundPath(context)).toBe(`/atlas/fantasy/ground-v2/${realmId}.png`);
      expect(JSON.stringify(context)).toBe(before);
      const historical = { ...context, artVersion: 1 as const };
      expect(baseGroundTransport(historical)).toEqual({ path: baseGroundPath(historical),
        sha256: BASE_GROUND_ART.sources[realmId].sha256, mime: 'image/png' });
    }
    expect(baseGroundTransport(FROZEN_CLEARING_V1)).toEqual({
      path: '/atlas/fantasy/ground-v3/crownlands.png',
      sha256: BASE_GROUND_ART_V3.sources.crownlands.sha256, mime: 'image/png',
    });
  });

  const historicalCropHashes = {
    frostveil: '83baed92fb1121a599d5e3dc3669cfa9aafeaf14289b8502185b98a084d6f3eb',
    elderwood: 'f30a816ba9390d6b29eb6b4cf14408818274819657c8416d2828a25abe17d420',
    sunscar: '666953eba182e53cbf8f793aa177fb83469dbc3dce83e44baf541b7d11f38f23',
    crownlands: 'f4681dc9a0a9b690493581a7bb73ef0a60e21e7415d9e09791683c86883f7091',
    'seeker-reach': '9ad7556a3f70a351c325dc16bfe4e16c82fc1db0cbdcb044bd567abed93a0415',
    stormcairn: 'a909c62d6958b64d35decc3d59d5243890868c54aa8e2a1f5f9156b93f4c7175',
    thornwake: 'bc0fb54a15cb6c0dbf9353364f345ce2e245fd6a7fdffab4e9737cf084d7ad64',
    cinderfall: '7b645b91c6fccea463e4f9dc4ee94f29aaccd16eeba7680a2b37f4d01c0d57ff',
  };
  const cropSources = new Map<number, Uint8Array>();
  it.each([
    ...REALM_IDS.flatMap(realmId => [
      { version: 1, realmId, artVersion: 1 } as const,
      { version: 1, realmId, artVersion: 2 } as const,
    ]), FROZEN_CLEARING_V1,
  ])('preserves pre-optimization crop bytes for $realmId art $artVersion across row-copy boundaries', context => {
    // These hashes were recorded from the original scalar writer before row
    // reuse. Clamp regions, source-row transitions and frozen v1 fade/grit must
    // stay exact regardless of where the browser yields. Input alpha varies;
    // every published pixel must still be opaque.
    const size = baseGroundArt(context).sourceSize;
    let data = cropSources.get(size);
    if (!data) {
      data = new Uint8Array(size * size * 4);
      for (let i = 0; i < data.length; i++) data[i] = (i * 31 + Math.floor(i / 7)) % 256;
      cropSources.set(size, data);
    }
    const hash = createHash('sha256');
    for (const [x, y, width, height] of [
      [-1400, -1301, 43, 37], [-1100, -1090, 47, 61], [-39, -47, 71, 67], [2048, 2070, 59, 71],
    ] as const) {
      const raster = createGroundRaster({ data, width: size, height: size }, context, width, height, x, y);
      const buffer = raster.data;
      let batch = 0;
      while (!raster.complete) raster.drawRows([1, 8, 3, 13][batch++ % 4]!);
      raster.drawRows(8);
      expect(raster.completedRows).toBe(height); expect(raster.data).toBe(buffer);
      hash.update(buffer);
    }
    expect(hash.digest('hex')).toBe(context.artVersion === 2
      ? '31e9c7930f0aeab68159437a9e1a7d906dcac4eee106afd72eb6b8311ad7aea1'
      : historicalCropHashes[context.realmId]);
  });

  it('yields row batches without changing historical replay, boundary or current deed pixels', () => {
    // SHA-256 baselines were captured from the pre-batching 6bb0a0a4 sampler,
    // not generated from this writer: both synchronous and staged paths must agree.
    const hashes = [
      ['3a8d118de348b410d2690a3846c5107104564ea35deea419da99ac40f8033867', '97d711ea7b9498b774c18661b66d23c416e7cab30b783a33552bf7a66170b413', '1b8cda77b2d0615a33584da2e3424e8157a3d2eb139bd7e7704f005b0cae8a5b'],
      ['2d754c7da5b4ca6f2109c8505322b9c3e0ef678da316db91f9dad378335ae8e6', '838750c8820802a034b83991a779b68697687068503b2fbb946ad786b60f95c5', '1ea7f7152800c229263fac1258ba4dee08033e8879ff76859dc273dd796d168d'],
    ];
    for (const context of [DEFAULT_BASE_VISUAL, { ...DEFAULT_BASE_VISUAL, artVersion: 2 } as const, FROZEN_CLEARING_V1]) {
      const size = baseGroundArt(context).sourceSize, data = new Uint8Array(size * size * 4);
      for (let i = 0; i < data.length; i++) data[i] = (i * 31 + Math.floor(i / 7)) % 256;
      const input = { width: size, height: size, data };
      for (const [index, [x, y]] of [[-1150, -1190], [-30, -22], [2640, 2640]].entries()) {
        const raster = createGroundRaster(input, context, 81, 67, x, y), buffer = raster.data;
        for (const rows of [1, 8, 7, 13, 38]) raster.drawRows(rows);
        expect(raster.complete).toBe(true); expect(raster.completedRows).toBe(67);
        raster.drawRows(8);
        expect(raster.data).toBe(buffer);
        expect(createHash('sha256').update(buffer).digest('hex')).toBe(hashes[context.artVersion - 1]![index]);
        expect(renderGroundPixels(input, context, 81, 67, x, y)).toEqual(buffer);
      }
    }
  });

  it('requires the current candidate to use its hashed layered manifest instead of a historical raster URL', () => {
    // The current selector no longer participates in old painted-raster goldens.
    // Both download and PNG callers must dispatch through the layered renderer.
    expect(CURRENT_BASE_VISUAL).toEqual(currentBaseVisualForRealm('crownlands'));
    // Since the owner's flip (2026-09-26) the current selector is the revision-5 realm kit:
    // the r3/r4 layered reader refuses it exactly like the raster readers do, and its
    // art is the pinned V5 descriptor — a raid stamped today must never resolve to r4 art.
    expect(isRealmKitBaseVisualContext(CURRENT_BASE_VISUAL)).toBe(true);
    expect(() => layeredGroundDescriptor(CURRENT_BASE_VISUAL)).toThrow('explicit layered revision');
    expect(BASE_LAYERED_GROUND_V5.crownlands).toMatchObject({ realmId: 'crownlands', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(() => baseGroundPath(CURRENT_BASE_VISUAL)).toThrow('versioned manifest');
    expect(() => baseGroundTransport(CURRENT_BASE_VISUAL)).toThrow('versioned manifest');
  });

  it('defaults historical missing contexts to Crownlands v1 without guessing from participants', () => {
    for (const value of [undefined, null, {}, { realmId: 'frostveil' }, { version: 99, realmId: 'frostveil', artVersion: 1 }]) {
      expect(resolveBaseVisualContext(value)).toEqual(DEFAULT_BASE_VISUAL);
    }
    expect(REALM_IDS).toHaveLength(8);
    expect(REALM_IDS[4]).toBe('seeker-reach');
    for (const realmId of REALM_IDS) {
      const context = { version: 1, realmId, artVersion: 1 };
      expect(resolveBaseVisualContext(context)).toEqual(context);
      expect(baseGroundPath(context)).toBe(`/atlas/fantasy/ground/${realmId}.png`);
      expect(BASE_GROUND_ART.sources[realmId].sha256).toMatch(/^[a-f0-9]{64}$/);
      const current = currentBaseVisualForRealm(realmId);
      expect(resolveBaseVisualContext(current)).toEqual(current);
      // Every realm presents the accepted revision-5 realm kit (owner flip 2026-09-26, D-175):
      // its art is the pinned V5 descriptor, and the r3/r4 layered reader refuses the context.
      expect(current).toEqual({ version: 1, realmId, artVersion: 2, groundRevision: 5 });
      expect(BASE_LAYERED_GROUND_V5[realmId]).toMatchObject({ realmId, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(() => layeredGroundDescriptor(current)).toThrow('explicit layered revision');
      expect(() => baseGroundArt(current)).toThrow('versioned manifest');
    }
  });
  it('retains the historical Crownlands correction and exact legacy v2 fallback contract', () => {
    const frozen = { version: 1, realmId: 'crownlands', artVersion: 2 } as const;
    expect(isBaseVisualContext(CURRENT_BASE_VISUAL)).toBe(true);
    expect(resolveBaseVisualContext(FROZEN_CLEARING_V1)).toEqual({ ...frozen, groundRevision: 1 });
    expect(baseGroundArt(FROZEN_CLEARING_V1)).toBe(BASE_GROUND_ART_V3);
    expect(resolveBaseVisualContext(frozen)).toEqual(frozen);
    expect(baseGroundArt(frozen)).toBe(BASE_GROUND_ART_V2);
    expect(baseGroundPath(frozen)).toBe('/atlas/fantasy/ground-v2/crownlands.png');
    // Shipped legacy clients reconstruct exactly these three fields. The
    // additive revision must not send them to unknown-art fallback v1.
    const legacy = { version: CURRENT_BASE_VISUAL.version, realmId: CURRENT_BASE_VISUAL.realmId,
      artVersion: CURRENT_BASE_VISUAL.artVersion };
    expect(legacy).toEqual(frozen);
    expect(baseGroundPath(legacy)).toBe(baseGroundPath(frozen));
    // Current scenery is the revision-5 realm kit in every realm (owner flip 2026-09-26).
    for (const realm of REALM_IDS.filter(id => id !== 'crownlands')) {
      expect(currentBaseVisualForRealm(realm)).toEqual({ version: 1, realmId: realm, artVersion: 2, groundRevision: 5 });
    }
    for (const groundRevision of [null, '1', 0, 6, 1.5]) {
      const unsupported = { ...frozen, groundRevision };
      expect(isBaseVisualContext(unsupported)).toBe(false);
      expect(resolveBaseVisualContext(unsupported)).toEqual(frozen);
      expect(baseGroundPath(unsupported)).toBe(baseGroundPath(frozen));
    }
    for (const core of [DEFAULT_BASE_VISUAL, { ...frozen, realmId: 'frostveil' }]) {
      const unsupported = { ...core, groundRevision: 1 };
      expect(isBaseVisualContext(unsupported)).toBe(false);
      expect(resolveBaseVisualContext(unsupported)).toEqual(core);
    }
  });
  it('admits groundRevision 5 (the realm kit, D-173) so a stamped kit context survives resolve, while 6 stays unknown and falls back to the frozen v2 painting', () => {
    // Revision 5 joins the layered family (docs/REALM-KIT-PLAN.md E-2): a raid or
    // deed stamped with it must round-trip intact, and the painted-raster readers
    // must refuse it exactly as they refuse 3 and 4. Every realm presents it since the
    // owner's flip order of 2026-09-26 (D-175 accepted all eight kits; M45 "the
    // revision-5 flip"): CURRENT_LAYERED_REVISION_BY_REALM is 5 everywhere.
    const frozen = { version: 1, realmId: 'crownlands', artVersion: 2 } as const;
    for (const realmId of REALM_IDS) {
      const kit = { ...frozen, realmId, groundRevision: 5 } as const;
      expect(isBaseVisualContext(kit)).toBe(true);
      expect(isRealmKitBaseVisualContext(kit)).toBe(true);
      expect(isLayeredBaseVisualContext(kit)).toBe(false);
      expect(resolveBaseVisualContext(kit)).toEqual(kit);
      expect(() => baseGroundArt(kit)).toThrow('versioned manifest');
      expect(() => baseGroundPath(kit)).toThrow('versioned manifest');
      expect(() => baseGroundTransport(kit)).toThrow('versioned manifest');
      expect(() => layeredGroundDescriptor(kit)).toThrow('explicit layered revision');
      expect(isBaseVisualContext({ ...kit, artVersion: 1 })).toBe(false);
      expect(CURRENT_LAYERED_REVISION_BY_REALM[realmId]).toBe(5);
    }
    const unknown = { ...frozen, groundRevision: 6 };
    expect(isBaseVisualContext(unknown)).toBe(false);
    expect(resolveBaseVisualContext(unknown)).toEqual(frozen);
  });

  it('names a server revision this bundle cannot draw, so a stale tab asks for a reload instead of painting old ground', () => {
    // WHY: after the revision-5 flip (2026-09-26) a tab on a pre-kit bundle received 5, dropped
    // it and silently painted the frozen v2 ground; the owner saw "old realms" on web. The next
    // revision must reach the player as a reload prompt, and the prompt is non-dismissible, so
    // it may fire ONLY where a reload can fix it: a revision newer than this bundle.
    const frozen = { version: 1, realmId: 'crownlands', artVersion: 2 } as const;
    for (const realmId of REALM_IDS) {
      for (const groundRevision of [6, 7, 42]) {
        const newer = { ...frozen, realmId, groundRevision };
        expect(unsupportedGroundRevision(newer)).toBe(groundRevision);
        // The scene still paints its fallback: detection never changes what resolve draws.
        expect(resolveBaseVisualContext(newer)).toEqual({ ...frozen, realmId });
      }
      // This bundle's own current revision is never "newer than this bundle".
      expect(unsupportedGroundRevision(currentBaseVisualForRealm(realmId))).toBeUndefined();
      for (const groundRevision of [2, 3, 4, 5, undefined]) {
        expect(unsupportedGroundRevision({ ...frozen, realmId, groundRevision })).toBeUndefined();
      }
    }
    expect(unsupportedGroundRevision({ ...frozen, groundRevision: 1 })).toBeUndefined();
    // Malformed or mispaired values are not newer art; a reload would land on the same answer.
    for (const groundRevision of [null, '6', 0, -3, 1.5, 6.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(unsupportedGroundRevision({ ...frozen, groundRevision })).toBeUndefined();
    }
    expect(unsupportedGroundRevision({ ...frozen, realmId: 'frostveil', groundRevision: 1 })).toBeUndefined();
    expect(unsupportedGroundRevision({ ...frozen, artVersion: 1, groundRevision: 6 })).toBeUndefined();
    for (const value of [undefined, null, {}, { realmId: 'crownlands', groundRevision: 6 }, { ...frozen, realmId: 'atlantis', groundRevision: 6 }]) {
      expect(unsupportedGroundRevision(value)).toBeUndefined();
    }
  });

  it.each(REALM_IDS)('retains explicitly requested revision2 %s study evidence without admitting it as live art', realmId => {
    const current = { version: 1, realmId, artVersion: 2, groundRevision: 2 } as const;
    expect(current.groundRevision).toBe(2);
    expect(isBaseVisualContext(current)).toBe(true);
    expect(baseGroundArt(current)).toBe(BASE_GROUND_ART_V4);
    expect(BASE_GROUND_ART_V4.sources[realmId].sha256).not.toBe(BASE_GROUND_ART_V2.sources[realmId].sha256);
    expect(baseGroundTransport(current)).toMatchObject({ path: `/atlas/fantasy/ground-v4/${realmId}.webp`, mime: 'image/webp' });
    expect(baseGroundTransport(current).sha256).toMatch(/^[a-f0-9]{64}$/);
    const legacy = { version: 1, realmId, artVersion: 2 };
    expect(baseGroundArt(legacy)).toBe(BASE_GROUND_ART_V2);
    expect(baseGroundArt({ ...legacy, artVersion: 1, groundRevision: 2 })).toBe(BASE_GROUND_ART);
  });

  it('keeps the accepted ten campaign acts on their original four realm progression', () => {
    expect(Array.from({ length: 10 }, (_, index) => campaignBaseVisualForAct(index + 1).realmId))
      .toEqual(['crownlands', 'crownlands', 'elderwood', 'elderwood', 'sunscar', 'sunscar', 'frostveil', 'frostveil', 'crownlands', 'frostveil']);
    expect(campaignBaseVisualForAct(0)).toEqual(CURRENT_BASE_VISUAL);
  });
  it('maps each painting once across the complete plot, without repeating or mirroring', () => {
    const pixels = renderGroundPixels(source, undefined, 960, 960);
    // Compare every channel without 102,400 assertion objects; this stays
    // deterministic under the full workspace's concurrent test load.
    let mismatch = -1;
    for (let y = 0; y < 320 && mismatch < 0; y++) for (let x = 0; x < 320 && mismatch < 0; x++) {
      for (let channel = 0; channel < 4; channel++) {
        if (pixels[(y * 3 * 960 + x * 3) * 4 + channel] !== source.data[(y * 320 + x) * 4 + channel]) {
          mismatch = (y * 320 + x) * 4 + channel;
          break;
        }
      }
    }
    expect(mismatch, 'each accepted source pixel maps once onto the complete plot').toBe(-1);
  });
  it('keeps deed crops and differently sized battle/base fields aligned, including skirts', () => {
    const big = renderGroundPixels(source, undefined, 150, 160, -50, -60);
    const crop = renderGroundPixels(source, undefined, 32, 64, -25, -33);
    for (let y = 0; y < 64; y++) {
      const start = ((y + 27) * 150 + 25) * 4;
      expect(crop.slice(y * 32 * 4, (y + 1) * 32 * 4)).toEqual(big.slice(start, start + 32 * 4));
    }
  });
  it('rejects incomplete image buffers and oversized raster requests', () => {
    expect(() => renderGroundPixels({ ...source, data: new Uint8Array(4) }, undefined, 32, 32)).toThrow();
    expect(() => renderGroundPixels(source, undefined, 5000, 32)).toThrow();
  });
  it('uses the full v2 painting beyond the plot at fixed coordinates for every scene crop', () => {
    const size = BASE_GROUND_ART_V2.sourceSize;
    const world = { width: size, height: size, data: new Uint8Array(size * size * 4) };
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      world.data.set([x % 251, y % 251, Math.floor(x / 251), 255], (y * size + x) * 4);
    }
    const start = BASE_GROUND_ART_V2.worldOriginTiles * BASE_GROUND_ART_V2.tilePx;
    const span = BASE_GROUND_ART_V2.worldTiles * BASE_GROUND_ART_V2.tilePx;
    // Both corners, outskirts and the buildable plot must sample authored
    // source pixels, not v1's flat material after a 48px fade.
    for (const [wx, wy] of [[start, start], [start + span - 1, start + span - 1], [-300, 1100], [0, 0], [480, 480]]) {
      const expected = (Math.floor((wy! - start) * size / span) * size
        + Math.floor((wx! - start) * size / span)) * 4;
      expect(renderGroundPixels(world, FROZEN_CLEARING_V1, 1, 1, wx, wy))
        .toEqual(new Uint8ClampedArray(world.data.slice(expected, expected + 4)));
    }
    const base = renderGroundPixels(world, FROZEN_CLEARING_V1, 240, 180, -120, -80);
    const deed = renderGroundPixels(world, FROZEN_CLEARING_V1, 64, 64, -23, -11);
    for (let y = 0; y < 64; y++) {
      const offset = ((y + 69) * 240 + 97) * 4;
      expect(deed.slice(y * 64 * 4, (y + 1) * 64 * 4)).toEqual(base.slice(offset, offset + 64 * 4));
    }
    expect(() => renderGroundPixels(source, FROZEN_CLEARING_V1, 32, 32)).toThrow(/1536/);
  });
});
