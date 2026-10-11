import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GAME_V4_OVERLAY_LOGICAL_ROOT,
  gameV4OverlayCoverage,
  buildGameV4ManifestIndex,
  resolveGameV4Overlay,
  parseGameV4OverlayName,
  readPngSize,
} from './game-v4-overlay.js';
import {
  GAME_V4_TRAVEL_ROW_SOURCE,
  GAME_V4_WARE_TRAVEL_CLIP_KEYS,
  attachGameV4OverlayRenderSources,
  buildMeta,
  renderBase,
  renderV2Sheet,
  type ManifestEntry,
  type V2GridEntry,
  type V2Manifest,
  type WareGridEntry,
  type WareManifest,
} from './rasterize.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shardkeep-game-v4-overlay-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function writePng(
  root: string, file: string, width: number, height: number, tint = 0,
): Promise<Buffer> {
  const destination = path.join(root, ...file.split('/'));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const png = await sharp({
    create: { width, height, channels: 4, background: { r: tint, g: 0, b: 0, alpha: tint ? 1 : 0 } },
  }).png().toBuffer();
  await fs.writeFile(destination, png);
  return png;
}

/** The Keep L20 idle contract: 3 columns of one 144x136 cell, one row. */
function wareKeepEntry(): WareGridEntry {
  return {
    file: 'bld_keep_l20_idle.svg', srcDir: '/not-read', batch: 22,
    atlas: { cellW: 144, cellH: 136, cols: 3, rows: 1 },
  } as WareGridEntry;
}

/** Giant T4 walk: 8 facing rows x 8 frames of a 112x112 cell. */
function v2GiantWalkEntry(): V2GridEntry {
  return {
    file: 'assets/trp_giant_t4_walk.svg', srcDir: '/not-read', batch: 14,
    atlas: { cellW: 112, cellH: 112, cols: 8, rows: 8 },
  } as V2GridEntry;
}

function legacyEntry(file: string, w: number, h: number): ManifestEntry {
  return {
    file, w, h, frames: 1, anchor: [0.5, 1], footprint: null, batch: 1,
    tags: [], palette_swap: null, srcDir: '/not-read',
  };
}

function manifests(options: {
  v2?: V2GridEntry[];
  ware?: WareGridEntry[];
}): { v2Manifest: V2Manifest; wareManifest: WareManifest } {
  return {
    v2Manifest: { entries: options.v2 ?? [], breathStream: null },
    wareManifest: {
      entries: options.ware ?? [], declaredEntries: 827, declaredCandidates: 5_558,
      ignoredUiRefs: [], exceptions: [],
    },
  };
}

const ENABLED = { SHARDKEEP_GAME_V4_OVERLAY: '1' } as const;

describe('game-v4 overlay gate', () => {
  it('stays off unless the environment variable is truthy', async () => {
    const root = await temporaryRoot();
    await expect(resolveGameV4Overlay({ root, environment: {} })).resolves.toBeNull();
    await expect(resolveGameV4Overlay({
      root, environment: { SHARDKEEP_GAME_V4_OVERLAY: 'false' },
    })).resolves.toBeNull();
    await expect(resolveGameV4Overlay({
      root, environment: { SHARDKEEP_GAME_V4_OVERLAY: '0' },
    })).resolves.toBeNull();
  });

  it('refuses production and CI, and only a second explicit opt-in lifts that', async () => {
    // WHY: unlike the hash-pinned three-file proof this overlay has no fixed
    // inventory, so an unattended release job must never be able to bake
    // unapproved art into a shipped atlas by inheriting one env var.
    const root = await temporaryRoot();
    await writePng(root, 'buildings/ware-ware_bld_keep_l20_idle.png', 432, 136);

    await expect(resolveGameV4Overlay({
      root, environment: { ...ENABLED, NODE_ENV: 'production' },
    })).rejects.toThrow('forbidden when NODE_ENV=production');
    await expect(resolveGameV4Overlay({
      root, environment: { ...ENABLED, CI: 'true' },
    })).rejects.toThrow('forbidden in CI');

    const released = await resolveGameV4Overlay({
      root,
      environment: {
        ...ENABLED, NODE_ENV: 'production', CI: 'true',
        SHARDKEEP_GAME_V4_OVERLAY_ALLOW_RELEASE: '1',
      },
    });
    expect(released?.releaseOptIn).toBe(true);
    expect(released?.sources).toHaveLength(1);
  });

  it('requires an absolute, existing root', async () => {
    await expect(resolveGameV4Overlay({
      root: 'art/game-v4', environment: ENABLED,
    })).rejects.toThrow('must be an absolute path');
    await expect(resolveGameV4Overlay({
      root: path.join(await temporaryRoot(), 'absent'), environment: ENABLED,
    })).rejects.toThrow('root is missing');
  });
});

describe('game-v4 overlay naming', () => {
  it('reads a runtime key only from the ledger output convention', () => {
    expect(parseGameV4OverlayName('buildings/ware-ware_bld_keep_l20_idle.png'))
      .toEqual({ kind: 'target', collection: 'ware', runtimeKey: 'ware_bld_keep_l20_idle' });
    expect(parseGameV4OverlayName('actors/v2-v2_trp_giant_t4_walk.png'))
      .toEqual({ kind: 'target', collection: 'v2', runtimeKey: 'v2_trp_giant_t4_walk' });
    expect(parseGameV4OverlayName('buildings/legacy-bld_heroaltar.png'))
      .toEqual({ kind: 'target', collection: 'legacy', runtimeKey: 'bld_heroaltar' });
    expect(parseGameV4OverlayName('brand/direct-brand_emblem_f2.png'))
      .toEqual({ kind: 'unsupported', collection: 'direct', runtimeKey: 'brand_emblem_f2' });
    // The studio's authoring layout, which is not a runtime target.
    expect(parseGameV4OverlayName('buildings/keep/l20/idle.png')).toEqual({ kind: 'unnamed' });
    expect(parseGameV4OverlayName('fx/giant/t4/impact-rubble.png')).toEqual({ kind: 'unnamed' });
    expect(parseGameV4OverlayName('contract.json')).toEqual({ kind: 'unnamed' });
  });

  it('never lets a nested working tree claim a runtime key', () => {
    // WHY: art/game-v4 also carries withdrawn sheets under superseded/<family>/
    // flat/ whose basenames are byte-identical runtime-target names. Matching
    // on the basename alone would ship rejected art.
    expect(parseGameV4OverlayName('superseded/vault/flat/ware-ware_bld_vault_t1_build.png'))
      .toEqual({ kind: 'unnamed' });
    expect(parseGameV4OverlayName('superseded/ware-ware_bld_vault_t1_build.png'))
      .toEqual({ kind: 'unnamed' });
    expect(parseGameV4OverlayName('labs/buildings/ware-ware_bld_keep_l20_idle.png'))
      .toEqual({ kind: 'unnamed' });
    expect(parseGameV4OverlayName('ware-ware_bld_keep_l20_idle.png')).toEqual({ kind: 'unnamed' });
  });

  it('reads exact pixel size from IHDR and rejects a non-PNG', async () => {
    const png = await sharp({
      create: { width: 7, height: 5, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer();
    expect(readPngSize(png, 'x.png')).toEqual({ width: 7, height: 5 });
    expect(() => readPngSize(Buffer.alloc(64), 'x.png')).toThrow('is not a PNG');
  });

  it('fails on an unsupported collection and on two files claiming one key', async () => {
    const direct = await temporaryRoot();
    await writePng(direct, 'brand/direct-brand_emblem_f2.png', 64, 64);
    await expect(resolveGameV4Overlay({ root: direct, environment: ENABLED }))
      .rejects.toThrow("names the unsupported 'direct' collection");

    // Two files may claim one runtime key legitimately while the tree is being
    // normalised. Different bytes still need an explicit review decision: a
    // directory name must never become an accidental art approval.
    const conflict = await temporaryRoot();
    await writePng(conflict, 'buildings/ware-ware_bld_keep_l20_idle.png', 432, 136, 0);
    await writePng(conflict, 'world/ware-ware_bld_keep_l20_idle.png', 432, 136, 200);
    await expect(resolveGameV4Overlay({ root: conflict, environment: ENABLED }))
      .rejects.toThrow('different duplicate claims with no explicit overlay-policy.json select/hold');

    const harmless = await temporaryRoot();
    await fs.writeFile(path.join(harmless, 'manifest.json'), JSON.stringify({ masters: [{
      id: 'ware:bld_keep_l20_idle', key: 'ware_bld_keep_l20_idle',
      path: 'buildings/keep/l20/idle.png',
      legacyFlatPath: 'buildings/ware-ware_bld_keep_l20_idle.png',
    }] }));
    await writePng(harmless, 'buildings/keep/l20/idle.png', 432, 136);
    await writePng(harmless, 'buildings/ware-ware_bld_keep_l20_idle.png', 432, 136);
    const resolved = await resolveGameV4Overlay({ root: harmless, environment: ENABLED });
    expect(resolved!.sources).toHaveLength(1);
    expect(resolved!.sources[0]!.file).toBe('buildings/keep/l20/idle.png');
    expect(resolved!.duplicateFiles).toHaveLength(1);
  });
});

describe('game-v4 overlay manifest binding', () => {
  it('replaces only the PNG bytes of the entry that owns the runtime key', async () => {
    const root = await temporaryRoot();
    const keepPng = await writePng(root, 'buildings/ware-ware_bld_keep_l20_idle.png', 432, 136);
    const walkPng = await writePng(root, 'actors/v2-v2_trp_giant_t4_walk.png', 896, 896);
    const altarPng = await writePng(root, 'buildings/legacy-bld_heroaltar.png', 64, 80);
    // Authoring layout and withdrawn art under the same root must be counted,
    // never bound and never a build failure.
    await writePng(root, 'buildings/keep/l20/identity.png', 144, 136);
    await writePng(root, 'superseded/keep/flat/ware-ware_bld_keep_l20_idle.png', 432, 136);

    const keep = wareKeepEntry();
    const walk = v2GiantWalkEntry();
    const idle = {
      file: 'assets/trp_giant_t4_idle.svg', srcDir: '/not-read', batch: 14,
      atlas: { cellW: 112, cellH: 112, cols: 4, rows: 8 },
    } as V2GridEntry;
    const altar = legacyEntry('bld_heroaltar.svg', 64, 80);
    const siege = legacyEntry('bld_siegestool.svg', 64, 80);
    const { v2Manifest, wareManifest } = manifests({ v2: [walk, idle], ware: [keep] });

    const overlay = await resolveGameV4Overlay({ root, environment: ENABLED });
    const coverage = attachGameV4OverlayRenderSources(
      overlay!, [altar, siege], v2Manifest, wareManifest,
    );

    // The manifest still owns geometry; only bytes changed.
    await expect(renderV2Sheet(keep)).resolves.toEqual(keepPng);
    await expect(renderV2Sheet(walk)).resolves.toEqual(walkPng);
    await expect(renderBase(altar)).resolves.toEqual(altarPng);
    expect(keep.atlas).toEqual({ cellW: 144, cellH: 136, cols: 3, rows: 1 });
    // Untouched entries still resolve through the legacy SVG path.
    await expect(renderV2Sheet(idle)).rejects.toThrow();
    await expect(renderBase(siege)).rejects.toThrow();

    expect(coverage).toEqual({
      root: GAME_V4_OVERLAY_LOGICAL_ROOT,
      selectionMode: 'local-review',
      scannedFiles: 5,
      matchedFiles: 3,
      selectedFiles: 3,
      unmatchedFiles: 2,
      outsideLedgerFiles: 0,
      manifestEntries: 5,
      overriddenEntries: 3,
      fallbackEntries: 2,
      activeLedgerFallbacks: 2,
      outsideLedgerBaseline: 0,
      unresolvedHolds: 0,
      identicalAlternates: 0,
      conflictingAlternates: 0,
      unbindableEntries: 0,
      byCollection: {
        legacy: { manifestEntries: 2, overridden: 1, fallback: 1 },
        v2: { manifestEntries: 2, overridden: 1, fallback: 1 },
        ware: { manifestEntries: 1, overridden: 1, fallback: 0 },
      },
      unmatchedSample: [
        'buildings/keep/l20/identity.png',
        'superseded/keep/flat/ware-ware_bld_keep_l20_idle.png',
      ],
      holdSample: [],
      identicalAlternateSample: [],
      conflictingAlternateSample: [],
      unbindableSample: [],
    });

    const meta = buildMeta(
      [], [], { manifest: { entries: [], breathStream: null }, frameKeys: [] }, {},
      undefined, [], coverage,
    );
    expect(meta.gameV4Overlay).toEqual(coverage);
    expect(JSON.stringify(meta)).not.toContain(root);
  });

  it('fails the build when an overlay sheet is not exactly cellW*cols x cellH*rows', async () => {
    // WHY: the manifest owns geometry. Silently resizing, cropping or
    // stretching would desynchronise every sliced frame from its anchor,
    // which renders as buildings sunk into or floating above the ground.
    const short = await temporaryRoot();
    await writePng(short, 'buildings/ware-ware_bld_keep_l20_idle.png', 432, 135);
    const shortOverlay = await resolveGameV4Overlay({ root: short, environment: ENABLED });
    const shortManifests = manifests({ ware: [wareKeepEntry()] });
    expect(() => attachGameV4OverlayRenderSources(
      shortOverlay!, [], shortManifests.v2Manifest, shortManifests.wareManifest,
    )).toThrow('is 432x135, but ware_bld_keep_l20_idle requires 432x136');

    const wide = await temporaryRoot();
    await writePng(wide, 'actors/v2-v2_trp_giant_t4_walk.png', 897, 896);
    const wideOverlay = await resolveGameV4Overlay({ root: wide, environment: ENABLED });
    const wideManifests = manifests({ v2: [v2GiantWalkEntry()] });
    expect(() => attachGameV4OverlayRenderSources(
      wideOverlay!, [], wideManifests.v2Manifest, wideManifests.wareManifest,
    )).toThrow('is 897x896, but v2_trp_giant_t4_walk requires 896x896');

    const legacy = await temporaryRoot();
    await writePng(legacy, 'buildings/legacy-bld_heroaltar.png', 64, 81);
    const legacyOverlay = await resolveGameV4Overlay({ root: legacy, environment: ENABLED });
    const legacyManifests = manifests({});
    expect(() => attachGameV4OverlayRenderSources(
      legacyOverlay!, [legacyEntry('bld_heroaltar.svg', 64, 80)],
      legacyManifests.v2Manifest, legacyManifests.wareManifest,
    )).toThrow('is 64x81, but bld_heroaltar requires 64x80');
  });

  it('fails the build on a runtime key no manifest entry owns', async () => {
    // WHY: a stale or mistyped key would otherwise be a silent no-op, and the
    // build would report success while shipping the old silhouette.
    const root = await temporaryRoot();
    await writePng(root, 'buildings/ware-ware_bld_keep_l21_idle.png', 432, 136);
    const overlay = await resolveGameV4Overlay({ root, environment: ENABLED });
    const { v2Manifest, wareManifest } = manifests({ ware: [wareKeepEntry()] });
    expect(() => attachGameV4OverlayRenderSources(overlay!, [], v2Manifest, wareManifest))
      .toThrow('names unknown ware runtime key ware_bld_keep_l21_idle');
  });

  it('refuses brand standalones instead of silently doing nothing', async () => {
    // WHY: brand keys reach apps/web/public/brand through three bypasses that
    // never call renderBase, so an accepted override there would not render.
    const root = await temporaryRoot();
    await writePng(root, 'brand/legacy-brand_app_icon.png', 1024, 1024);
    const overlay = await resolveGameV4Overlay({ root, environment: ENABLED });
    const { v2Manifest, wareManifest } = manifests({});
    expect(() => attachGameV4OverlayRenderSources(
      overlay!, [legacyEntry('brand_app_icon.svg', 1024, 1024)], v2Manifest, wareManifest,
    )).toThrow('targets brand standalone brand_app_icon');
  });
});

describe('game-v4 overlay coverage arithmetic', () => {
  it('derives fallback from what the manifests hold, not from the files', () => {
    const coverage = gameV4OverlayCoverage({
      scannedFiles: 413,
      unmatchedFiles: ['buildings/keep/l20/idle.png', 'actors/giant/t4/walk.png'],
      manifestEntries: { legacy: 500, v2: 679, ware: 848 },
      overridden: { legacy: 0, v2: 3, ware: 408 },
    });
    expect(coverage.matchedFiles).toBe(411);
    expect(coverage.unmatchedFiles).toBe(2);
    expect(coverage.manifestEntries).toBe(2_027);
    expect(coverage.overriddenEntries).toBe(411);
    expect(coverage.fallbackEntries).toBe(1_616);
    expect(coverage.byCollection.legacy).toEqual({ manifestEntries: 500, overridden: 0, fallback: 500 });
    expect(coverage.byCollection.v2).toEqual({ manifestEntries: 679, overridden: 3, fallback: 676 });
    expect(coverage.byCollection.ware).toEqual({ manifestEntries: 848, overridden: 408, fallback: 440 });
    expect(coverage.unmatchedSample).toEqual(['actors/giant/t4/walk.png', 'buildings/keep/l20/idle.png']);
    expect(coverage.overriddenEntries + coverage.fallbackEntries).toBe(coverage.manifestEntries);
    expect(coverage.matchedFiles + coverage.unmatchedFiles).toBe(coverage.scannedFiles);
  });

  it('caps the unmatched sample without distorting the count', () => {
    const unmatchedFiles = Array.from({ length: 24 }, (_, index) => `world/tile-${index}.png`);
    const coverage = gameV4OverlayCoverage({
      scannedFiles: 24,
      unmatchedFiles,
      manifestEntries: { legacy: 1, v2: 1, ware: 1 },
      overridden: { legacy: 0, v2: 0, ware: 0 },
    });
    expect(coverage.unmatchedFiles).toBe(24);
    expect(coverage.unmatchedSample).toHaveLength(10);
    expect(coverage.fallbackEntries).toBe(3);
  });

  it('refuses arithmetic that cannot be true', () => {
    expect(() => gameV4OverlayCoverage({
      scannedFiles: 1,
      unmatchedFiles: [],
      manifestEntries: { legacy: 0, v2: 0, ware: 1 },
      overridden: { legacy: 0, v2: 0, ware: 2 },
    })).toThrow('ware overrode 2 of 1 manifest entries');
    expect(() => gameV4OverlayCoverage({
      scannedFiles: 5,
      unmatchedFiles: [],
      manifestEntries: { legacy: 0, v2: 0, ware: 9 },
      overridden: { legacy: 0, v2: 0, ware: 1 },
    })).toThrow('5 selected files (0 unbindable) bound 1 manifest entries');

    // A matched file that bound nothing because its ledger key has no legacy entry yet is
    // accounted for, not an arithmetic error.
    expect(() => gameV4OverlayCoverage({
      scannedFiles: 5,
      unmatchedFiles: [],
      manifestEntries: { legacy: 0, v2: 0, ware: 9 },
      overridden: { legacy: 0, v2: 0, ware: 4 },
      unbindableFiles: 1,
    })).not.toThrow();
  });
});

describe('nested canonical layout via the manifest index', () => {
  // The canonical layout is nested; the flat spelling is legacy. Before the manifest
  // join, every nested master was classified 'unnamed' and reached the game as nothing.
  const manifest = {
    masters: [
      {
        id: 'ware:bld_keep_l20_idle',
        key: 'ware_bld_keep_l20_idle',
        path: 'buildings/keep/l20/idle.png',
        legacyFlatPath: 'buildings/ware-ware_bld_keep_l20_idle.png',
      },
      {
        id: 'v2:trp_giant_t4_walk',
        key: 'v2_trp_giant_t4_walk',
        path: 'actors/giant/t4/walk.png',
        legacyFlatPath: 'actors/v2-v2_trp_giant_t4_walk.png',
      },
      { id: 'direct:globe_pin', key: 'map_keep_t1', path: 'world/map/keep_t1.png' },
    ],
  };

  it('resolves a nested path to its runtime key', () => {
    const index = buildGameV4ManifestIndex(manifest);
    expect(parseGameV4OverlayName('buildings/keep/l20/idle.png', index)).toEqual({
      kind: 'target',
      collection: 'ware',
      runtimeKey: 'ware_bld_keep_l20_idle',
      ledgerKey: true,
    });
    expect(parseGameV4OverlayName('actors/giant/t4/walk.png', index)).toEqual({
      kind: 'target',
      collection: 'v2',
      runtimeKey: 'v2_trp_giant_t4_walk',
      ledgerKey: true,
    });
  });

  it('still resolves the legacy flat spelling of the same master', () => {
    const index = buildGameV4ManifestIndex(manifest);
    expect(parseGameV4OverlayName('actors/v2-v2_trp_giant_t4_walk.png', index)).toEqual({
      kind: 'target',
      collection: 'v2',
      runtimeKey: 'v2_trp_giant_t4_walk',
      ledgerKey: true,
    });
  });

  it('drops manifest rows whose collection the overlay cannot serve', () => {
    const index = buildGameV4ManifestIndex(manifest);
    expect(index.has('world/map/keep_t1.png')).toBe(false);
  });

  it('leaves working material outside the manifest unmatched', () => {
    const index = buildGameV4ManifestIndex(manifest);
    expect(parseGameV4OverlayName('buildings/superseded/keep/l20/idle.png', index).kind)
      .toBe('unnamed');
    expect(parseGameV4OverlayName('labs/review.png', index).kind).toBe('unnamed');
  });

  it('behaves exactly as before when no index is supplied', () => {
    expect(parseGameV4OverlayName('buildings/keep/l20/idle.png').kind).toBe('unnamed');
    expect(parseGameV4OverlayName('actors/v2-v2_trp_giant_t4_walk.png')).toEqual({
      kind: 'target',
      collection: 'v2',
      runtimeKey: 'v2_trp_giant_t4_walk',
    });
  });
});

describe('duplicate runtime-key claims', () => {
  // While the tree is being normalised the same master legitimately exists at BOTH the
  // canonical nested path and the ledger's flat spelling. 128 such pairs existed at one
  // point; throwing on them would fail `pnpm assets` and stop the game building.
  const manifest = {
    masters: [{
      id: 'v2:fx_arrow_t4',
      key: 'v2_fx_arrow_t4',
      path: 'fx/v2/arrow/t4.png',
      legacyFlatPath: 'fx/v2-v2_fx_arrow_t4.png',
    }],
  }

  const makeRoot = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkw-dup-'))
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
    await fs.mkdir(path.join(dir, 'fx', 'v2', 'arrow'), { recursive: true })
    return dir
  }
  const png = (w: number, h: number, r: number) =>
    sharp({ create: { width: w, height: h, channels: 4, background: { r, g: 0, b: 0, alpha: 1 } } })
      .png().toBuffer()

  const env = { SHARDKEEP_GAME_V4_OVERLAY: '1' } as never
  const roots: string[] = []
  afterEach(async () => { for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true }) })

  it('keeps one source and records the other when the bytes are identical', async () => {
    const dir = await makeRoot(); roots.push(dir)
    const bytes = await png(8, 8, 10)
    await fs.writeFile(path.join(dir, 'fx', 'v2', 'arrow', 't4.png'), bytes)
    await fs.writeFile(path.join(dir, 'fx', 'v2-v2_fx_arrow_t4.png'), bytes)
    const overlay = await resolveGameV4Overlay({ root: dir, environment: env })
    expect(overlay!.sources).toHaveLength(1)
    expect(overlay!.sources[0]!.runtimeKey).toBe('v2_fx_arrow_t4')
    expect(overlay!.duplicateFiles).toHaveLength(1)
  })

  it('still throws when two files claim one key with DIFFERENT bytes', async () => {
    const dir = await makeRoot(); roots.push(dir)
    await fs.writeFile(path.join(dir, 'fx', 'v2', 'arrow', 't4.png'), await png(8, 8, 10))
    await fs.writeFile(path.join(dir, 'fx', 'v2-v2_fx_arrow_t4.png'), await png(8, 8, 200))
    await expect(resolveGameV4Overlay({ root: dir, environment: env }))
      .rejects.toThrow(/different duplicate claims.*explicit overlay-policy\.json/s)
  })
})

describe('brand standalones are never indexed', () => {
  // attach() refuses a brand standalone on sight because brand reaches public/brand through
  // three bypasses this seam cannot touch. Once brand art is actually delivered under
  // art/game-v4/brand/, indexing it would turn `pnpm assets` into a hard failure. So the
  // index must skip brand entirely and let those files count as unmatched.
  it('leaves a delivered brand master unmatched instead of claiming it', () => {
    const index = buildGameV4ManifestIndex({
      masters: [
        { id: 'legacy:brand_emblem', key: 'brand_emblem', path: 'brand/emblem.png' },
        { id: 'legacy:bld_heroaltar', key: 'bld_heroaltar', path: 'buildings/heroaltar/idle.png' },
      ],
    })
    expect(index.has('brand/emblem.png')).toBe(false)
    expect(parseGameV4OverlayName('brand/emblem.png', index).kind).toBe('unnamed')
    // a normal legacy master in the same collection still resolves
    expect(parseGameV4OverlayName('buildings/heroaltar/idle.png', index)).toEqual({
      kind: 'target', collection: 'legacy', runtimeKey: 'bld_heroaltar', ledgerKey: true,
    })
  })
})

describe('a delivered master whose runtime key is NEW', () => {
  // local_map_keep_t1..t5 are the forked non-globe Keep pins: real ledger targets authored
  // fresh alongside the frozen map_keep_t*. They have no legacy manifest entry to override.
  // This seam replaces the BYTES of an existing entry, so a brand-new LEDGER key has nothing
  // to replace and needs real manifest wiring. Failing the build over it would make shipping
  // any new key impossible — but a key that is NOT in the ledger is still a typo and fatal.
  it('is skipped with a warning, while a non-ledger key still fails the build', async () => {
    const root = await temporaryRoot();
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({
      masters: [
        {
          id: 'legacy:local_map_keep_t1',
          key: 'local_map_keep_t1',
          path: 'world/local_map/keep_t1.png',
        },
        {
          id: 'legacy:bld_heroaltar',
          key: 'bld_heroaltar',
          path: 'buildings/heroaltar/base.png',
          legacyFlatPath: 'buildings/legacy-bld_heroaltar.png',
        },
      ],
    }));
    await writePng(root, 'world/local_map/keep_t1.png', 40, 44);
    await writePng(root, 'buildings/legacy-bld_heroaltar.png', 64, 80);
    const overlay = await resolveGameV4Overlay({ root, environment: ENABLED });
    const m = manifests({});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const coverage = attachGameV4OverlayRenderSources(
      overlay!, [legacyEntry('bld_heroaltar.svg', 64, 80)], m.v2Manifest, m.wareManifest,
    );
    expect(coverage.overriddenEntries).toBe(1);
    expect(warn.mock.calls.flat().join(' ')).toContain('local_map_keep_t1');
    warn.mockRestore();
  });
});

describe('game-v4 travel-row assembly (K-052)', () => {
  it('reassembles an overlay WARE travel sheet from semantic into runtime heading order', async () => {
    // WHY: game-v4 travel sheets are generated by semantic heading name
    // (e,ne,n,nw,w,sw,s,se) while headingRow() reads rows clockwise in
    // screen-y-down order (e,se,s,sw,w,nw,n,ne). Without this reassembly six of
    // eight headings render a projectile pointing the wrong way, and the two
    // that look right (e/w) hide the defect.
    const root = await temporaryRoot();
    const cellH = 14;
    const width = 84;
    // Tint each SEMANTIC row (i+1)*10 red so the permutation is observable.
    const rows = await Promise.all(Array.from({ length: 8 }, (_, i) => sharp({
      create: {
        width, height: cellH, channels: 4,
        background: { r: (i + 1) * 10, g: 0, b: 0, alpha: 1 },
      },
    }).png().toBuffer()));
    const sheet = await sharp({
      create: {
        width, height: cellH * 8, channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    }).composite(rows.map((input, i) => ({ input, left: 0, top: i * cellH }))).png().toBuffer();
    const destination = path.join(root, 'fx', 'ware-ware_fx_arrow.png');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, sheet);

    const arrow = {
      file: 'fx_arrow.svg', srcDir: '/not-read', batch: 22,
      atlas: { cellW: 28, cellH, cols: 3, rows: 8 },
    } as WareGridEntry;
    const { v2Manifest, wareManifest } = manifests({ ware: [arrow] });
    const overlay = await resolveGameV4Overlay({ root, environment: ENABLED });
    attachGameV4OverlayRenderSources(overlay!, [], v2Manifest, wareManifest);

    const out = await renderV2Sheet(arrow);
    const { data, info } = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(width);
    expect(info.height).toBe(cellH * 8);
    for (let runtimeRow = 0; runtimeRow < 8; runtimeRow++) {
      const y = runtimeRow * cellH + Math.floor(cellH / 2);
      const red = data[(y * width + 1) * 4]!;
      expect(red, `runtime row ${runtimeRow}`)
        .toBe((GAME_V4_TRAVEL_ROW_SOURCE[runtimeRow]! + 1) * 10);
    }
    // East (row 0) and west (row 4) map to themselves — exactly why those two
    // headings looked correct before the fix.
    expect(GAME_V4_TRAVEL_ROW_SOURCE[0]).toBe(0);
    expect(GAME_V4_TRAVEL_ROW_SOURCE[4]).toBe(4);
    // The affected inventory is exactly K-052's enumerated active travel sets.
    expect([...GAME_V4_WARE_TRAVEL_CLIP_KEYS].sort()).toEqual([
      'ware_fx_arrow', 'ware_fx_harpoon_t1', 'ware_fx_harpoon_t2', 'ware_fx_harpoon_t3',
      'ware_fx_harpoon_t4', 'ware_fx_hatchfire', 'ware_fx_keepbolt', 'ware_fx_magebolt',
    ]);
  });
});
