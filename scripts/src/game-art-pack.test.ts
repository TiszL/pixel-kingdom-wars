import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GAME_ART_CONTRACT_SCHEMA,
  gameArtContractSha256,
  type GameArtContract,
  type GameArtIdentity,
} from './game-art-contract.js';
import {
  GAME_ART_PACK_SCHEMA,
  GAME_ART_PACK_VALIDATION_CONCURRENCY,
  GAME_ART_PROVENANCE_SCHEMA,
  gameArtManifestSha256,
  gameArtProvenanceSha256,
  loadGameArtPack,
  type GameArtPackManifest,
  type GameArtPackProfile,
  type GameArtPackProvenance,
} from './game-art-pack.js';

const SPECS = [
  { identity: 'simple:tile_grass_1', file: 'world/tile_grass_1.png', width: 4, height: 4 },
  { identity: 'v2:v2_trp_giant_t4_walk', file: 'actors/giant_walk.png', width: 8, height: 8 },
  { identity: 'ware:ware_bld_keep_l20_idle', file: 'buildings/keep_idle.png', width: 6, height: 5 },
  { identity: 'standalone:ui/item_helm', file: 'ui/item_helm.png', width: 3, height: 3 },
] as const;

const CONTRACT: GameArtContract = {
  schemaVersion: GAME_ART_CONTRACT_SCHEMA,
  entries: SPECS.map(({ identity, width, height }) => ({
    identity, width, height, pixelLaw: 'test-pixels', metadata: { anchor: [0.5, 1] },
  })),
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shardkeep-game-art-pack-'));
  temporaryDirectories.push(directory);
  return directory;
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface Fixture {
  root: string;
  manifest: GameArtPackManifest;
  provenance: GameArtPackProvenance;
  managedRoots: string[];
  bytes: Map<GameArtIdentity, Buffer>;
}

async function fixture(profile: GameArtPackProfile, scope: readonly GameArtIdentity[]): Promise<Fixture> {
  const root = await temporaryDirectory();
  const bytes = new Map<GameArtIdentity, Buffer>();
  const selected = scope.map((identity) => SPECS.find((spec) => spec.identity === identity)!);
  for (const [index, spec] of selected.entries()) {
    const encoded = await sharp({
      create: {
        width: spec.width,
        height: spec.height,
        channels: 4,
        background: { r: index + 1, g: index + 2, b: index + 3, alpha: 1 },
      },
    }).png().toBuffer();
    const destination = path.join(root, ...spec.file.split('/'));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, encoded);
    bytes.set(spec.identity, encoded);
  }
  const entries = selected.map((spec) => ({
    identity: spec.identity,
    file: spec.file,
    sha256: hash(bytes.get(spec.identity)!),
  }));
  return {
    root,
    manifest: {
      schemaVersion: GAME_ART_PACK_SCHEMA,
      packId: 'game-v4-test',
      profile,
      contractSha256: gameArtContractSha256(CONTRACT),
      scope,
      entries,
    },
    provenance: {
      schemaVersion: GAME_ART_PROVENANCE_SCHEMA,
      producer: 'test-normalizer',
      outputs: selected.map((spec) => ({
        identity: spec.identity,
        file: spec.file,
        sha256: hash(bytes.get(spec.identity)!),
        width: spec.width,
        height: spec.height,
      })),
    },
    managedRoots: [...new Set(selected.map(({ file }) => file.split('/')[0]!))],
    bytes,
  };
}

const validators = { 'test-pixels': vi.fn() };

describe('manifest-driven game art pack', () => {
  it('pins locale-independent contract, manifest, and provenance digests', () => {
    // WHY: these hashes are release identities. A host locale or ICU upgrade
    // must not reorder entries and produce a different approved pack digest.
    const pinnedContract: GameArtContract = {
      schemaVersion: GAME_ART_CONTRACT_SCHEMA,
      entries: [
        {
          identity: 'ware:wall', width: 32, height: 40, pixelLaw: 'v4-world',
          metadata: { mask: 15, rowOrder: ['s', 'n'] },
        },
        { identity: 'simple:tile', width: 32, height: 32, pixelLaw: 'v4-tile' },
      ],
    };
    const contractDigest = gameArtContractSha256(pinnedContract);
    const manifest: GameArtPackManifest = {
      schemaVersion: GAME_ART_PACK_SCHEMA,
      packId: 'digest-pin',
      profile: 'candidate',
      contractSha256: contractDigest,
      scope: ['ware:wall', 'simple:tile'],
      entries: [
        { identity: 'ware:wall', file: 'buildings/wall.png', sha256: 'b'.repeat(64) },
        { identity: 'simple:tile', file: 'world/tile.png', sha256: 'a'.repeat(64) },
      ],
    };
    const provenance: GameArtPackProvenance = {
      schemaVersion: GAME_ART_PROVENANCE_SCHEMA,
      producer: 'digest-test',
      outputs: [
        {
          identity: 'ware:wall', file: 'buildings/wall.png', sha256: 'b'.repeat(64),
          width: 32, height: 40,
        },
        {
          identity: 'simple:tile', file: 'world/tile.png', sha256: 'a'.repeat(64),
          width: 32, height: 32,
        },
      ],
    };

    expect(contractDigest).toBe('50c7cf410497271e92bfea32c9f06868b3bd2b739b9067db8e3894b6ce8b3925');
    expect(gameArtManifestSha256(manifest))
      .toBe('4746c9286c7e45269adf3817094b04c7fab896f4f6ef9a1a050fd760b3a4edf7');
    expect(gameArtProvenanceSha256(provenance))
      .toBe('a3c046e9512ff964fd838f35a6f97dcf6d6ada1b847004a50b535d9b9a35b2bf');
  });

  it('allows an exact candidate subset but requires complete approved coverage', async () => {
    // WHY: local review must be able to replace two assets without making a
    // partial pack look production-complete. Profile is supplied by the caller,
    // not trusted merely because the manifest claims it.
    const subset = SPECS.slice(0, 2).map(({ identity }) => identity);
    const candidate = await fixture('candidate', subset);
    await expect(loadGameArtPack({
      ...candidate, expectedProfile: 'candidate', contract: CONTRACT, pixelValidators: validators,
    })).resolves.toMatchObject({ profile: 'candidate', identities: [...subset].sort() });
    await expect(loadGameArtPack({
      ...candidate, expectedProfile: 'approved', contract: CONTRACT, pixelValidators: validators,
    })).rejects.toThrow('does not match expected approved');

    const falselyApproved = { ...candidate.manifest, profile: 'approved' as const };
    await expect(loadGameArtPack({
      ...candidate,
      manifest: falselyApproved,
      expectedProfile: 'approved',
      contract: CONTRACT,
      pixelValidators: validators,
    })).rejects.toThrow('approved game art coverage differs');

    const complete = await fixture('approved', SPECS.map(({ identity }) => identity));
    await expect(loadGameArtPack({
      ...complete, expectedProfile: 'approved', contract: CONTRACT, pixelValidators: validators,
    })).resolves.toMatchObject({ profile: 'approved', identities: SPECS.map(({ identity }) => identity).sort() });
  });

  it('binds manifest, provenance, dimensions, pixels, and disk bytes before returning anything', async () => {
    const item = await fixture('candidate', [SPECS[0].identity]);
    const validate = vi.fn();
    const loaded = await loadGameArtPack({
      ...item,
      expectedProfile: 'candidate',
      contract: CONTRACT,
      pixelValidators: { 'test-pixels': validate },
    });
    expect(validate).toHaveBeenCalledOnce();
    expect(validate.mock.calls[0]![0]).toMatchObject({ width: 4, height: 4 });

    const tampered = await fixture('candidate', [SPECS[0].identity]);
    await fs.appendFile(path.join(tampered.root, SPECS[0].file), 'tamper');
    await expect(loadGameArtPack({
      ...tampered, expectedProfile: 'candidate', contract: CONTRACT, pixelValidators: validators,
    })).rejects.toThrow('PNG SHA256 does not match provenance');

    const wrongProvenance = {
      ...item.provenance,
      outputs: [{ ...item.provenance.outputs[0]!, width: 5 }],
    };
    await expect(loadGameArtPack({
      ...item,
      provenance: wrongProvenance,
      expectedProfile: 'candidate',
      contract: CONTRACT,
      pixelValidators: validators,
    })).rejects.toThrow('provenance differs from manifest or runtime contract');

    await expect(loadGameArtPack({
      ...item,
      manifest: { ...item.manifest, contractSha256: '0'.repeat(64) },
      expectedProfile: 'candidate',
      contract: CONTRACT,
      pixelValidators: validators,
    })).rejects.toThrow('contractSha256 does not match the runtime contract');

    const rgb = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).png().toBuffer();
    await fs.writeFile(path.join(item.root, SPECS[0].file), rgb);
    const rgbSha = hash(rgb);
    await expect(loadGameArtPack({
      ...item,
      manifest: {
        ...item.manifest,
        entries: [{ ...item.manifest.entries[0]!, sha256: rgbSha }],
      },
      provenance: {
        ...item.provenance,
        outputs: [{ ...item.provenance.outputs[0]!, sha256: rgbSha }],
      },
      expectedProfile: 'candidate',
      contract: CONTRACT,
      pixelValidators: validators,
    })).rejects.toThrow('one static 8-bit RGBA PNG');

    expect(loaded.contractSha256).toBe(gameArtContractSha256(CONTRACT));
    expect(loaded.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.provenanceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('snapshots validated PNG bytes and returns defensive copies', async () => {
    // WHY: validating a path and reopening it during atlas packing admits a
    // different file. The accepted bytes must be the bytes later consumed.
    const item = await fixture('candidate', [SPECS[0].identity]);
    const loaded = await loadGameArtPack({
      ...item, expectedProfile: 'candidate', contract: CONTRACT, pixelValidators: validators,
    });
    const accepted = item.bytes.get(SPECS[0].identity)!;
    await fs.writeFile(path.join(item.root, SPECS[0].file), Buffer.from('changed after validation'));

    const firstRead = loaded.readPng(SPECS[0].identity);
    expect(firstRead).toEqual(accepted);
    firstRead.fill(0);
    expect(loaded.readPng(SPECS[0].identity)).toEqual(accepted);
  });

  it('rejects missing, extra, duplicate, and unmanaged inventory exactly', async () => {
    const scope = SPECS.slice(0, 2).map(({ identity }) => identity);
    const item = await fixture('candidate', scope);
    await fs.writeFile(path.join(item.root, 'world', 'unexpected.png'), Buffer.from('extra'));
    await expect(loadGameArtPack({
      ...item, expectedProfile: 'candidate', contract: CONTRACT, pixelValidators: validators,
    })).rejects.toThrow('managed file inventory differs');
    await fs.rm(path.join(item.root, 'world', 'unexpected.png'));

    const missingEntry = { ...item.manifest, entries: item.manifest.entries.slice(0, 1) };
    await expect(loadGameArtPack({
      ...item,
      manifest: missingEntry,
      expectedProfile: 'candidate',
      contract: CONTRACT,
      pixelValidators: validators,
    })).rejects.toThrow('manifest entries vs scope differs');

    const duplicateEntry = {
      ...item.manifest,
      entries: [item.manifest.entries[0]!, item.manifest.entries[0]!],
      scope: [item.manifest.scope[0]!],
    };
    await expect(loadGameArtPack({
      ...item,
      manifest: duplicateEntry,
      expectedProfile: 'candidate',
      contract: CONTRACT,
      pixelValidators: validators,
    })).rejects.toThrow('duplicate game art manifest identity');

    const missingProvenance = { ...item.provenance, outputs: item.provenance.outputs.slice(0, 1) };
    await expect(loadGameArtPack({
      ...item,
      provenance: missingProvenance,
      expectedProfile: 'candidate',
      contract: CONTRACT,
      pixelValidators: validators,
    })).rejects.toThrow('provenance outputs vs manifest differs');

    const duplicateProvenance = {
      ...item.provenance,
      outputs: [item.provenance.outputs[0]!, item.provenance.outputs[0]!],
    };
    await expect(loadGameArtPack({
      ...item,
      provenance: duplicateProvenance,
      expectedProfile: 'candidate',
      contract: CONTRACT,
      pixelValidators: validators,
    })).rejects.toThrow('duplicate game art provenance identity');
  });

  it('produces the same manifest and provenance digests for reordered records', async () => {
    const item = await fixture('candidate', SPECS.slice(0, 2).map(({ identity }) => identity));
    const normal = await loadGameArtPack({
      ...item, expectedProfile: 'candidate', contract: CONTRACT, pixelValidators: validators,
    });
    const reordered = await loadGameArtPack({
      ...item,
      manifest: {
        ...item.manifest,
        scope: [...item.manifest.scope].reverse(),
        entries: [...item.manifest.entries].reverse(),
      },
      provenance: { ...item.provenance, outputs: [...item.provenance.outputs].reverse() },
      expectedProfile: 'candidate',
      contract: CONTRACT,
      pixelValidators: validators,
    });
    expect(reordered.manifestSha256).toBe(normal.manifestSha256);
    expect(reordered.provenanceSha256).toBe(normal.provenanceSha256);
  });

  it('bounds full-pack PNG validation while preserving every deterministic snapshot', async () => {
    // WHY: an approved pack has roughly 2,111 PNG masters. Starting every
    // Sharp metadata/decode job at once can exhaust memory and native worker
    // capacity, while completion order must not affect release identities.
    const count = GAME_ART_PACK_VALIDATION_CONCURRENCY * 3 + 1;
    const root = await temporaryDirectory();
    const specs = Array.from({ length: count }, (_, index) => {
      const suffix = index.toString().padStart(3, '0');
      return {
        identity: `simple:stress_${suffix}` as GameArtIdentity,
        file: `stress/item_${suffix}.png`,
        width: 2,
        height: 2,
      };
    });
    const bytes = new Map<GameArtIdentity, Buffer>();
    for (const [index, spec] of specs.entries()) {
      const encoded = await sharp({
        create: {
          width: spec.width,
          height: spec.height,
          channels: 4,
          background: { r: index + 1, g: index + 2, b: index + 3, alpha: 1 },
        },
      }).png().toBuffer();
      const destination = path.join(root, ...spec.file.split('/'));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, encoded);
      bytes.set(spec.identity, encoded);
    }
    const contract: GameArtContract = {
      schemaVersion: GAME_ART_CONTRACT_SCHEMA,
      entries: specs.map(({ identity, width, height }) => ({
        identity, width, height, pixelLaw: 'stress-pixels',
      })),
    };
    const entries = specs.map(({ identity, file }) => ({
      identity,
      file,
      sha256: hash(bytes.get(identity)!),
    }));
    const manifest: GameArtPackManifest = {
      schemaVersion: GAME_ART_PACK_SCHEMA,
      packId: 'bounded-stress',
      profile: 'approved',
      contractSha256: gameArtContractSha256(contract),
      scope: specs.map(({ identity }) => identity),
      entries,
    };
    const provenance: GameArtPackProvenance = {
      schemaVersion: GAME_ART_PROVENANCE_SCHEMA,
      producer: 'bounded-stress',
      outputs: specs.map(({ identity, file, width, height }) => ({
        identity, file, width, height, sha256: hash(bytes.get(identity)!),
      })),
    };

    let active = 0;
    let peak = 0;
    let entered = 0;
    let releaseFirstWave!: () => void;
    const firstWave = new Promise<void>((resolve) => { releaseFirstWave = resolve; });
    const validated = new Set<GameArtIdentity>();
    const validate = vi.fn(async (_png, entry) => {
      active += 1;
      peak = Math.max(peak, active);
      entered += 1;
      if (entered === GAME_ART_PACK_VALIDATION_CONCURRENCY) releaseFirstWave();
      try {
        await firstWave;
        await new Promise((resolve) => setTimeout(resolve, 10));
        validated.add(entry.identity);
      } finally {
        active -= 1;
      }
    });

    const loaded = await loadGameArtPack({
      root,
      expectedProfile: 'approved',
      contract,
      manifest,
      provenance,
      managedRoots: ['stress'],
      pixelValidators: { 'stress-pixels': validate },
    });

    expect(peak).toBe(GAME_ART_PACK_VALIDATION_CONCURRENCY);
    expect(active).toBe(0);
    expect(validate).toHaveBeenCalledTimes(count);
    expect(validated).toEqual(new Set(specs.map(({ identity }) => identity)));
    expect(loaded.identities).toEqual(specs.map(({ identity }) => identity));
    expect(loaded.manifestSha256).toBe(gameArtManifestSha256(manifest));
    expect(loaded.provenanceSha256).toBe(gameArtProvenanceSha256(provenance));
    for (const { identity } of specs) {
      expect(hash(loaded.readPng(identity))).toBe(hash(bytes.get(identity)!));
    }
  });
});

describe('game art filesystem containment', () => {
  it('rejects a managed root that is itself a symlink', async () => {
    const item = await fixture('candidate', [SPECS[0].identity]);
    const outside = await temporaryDirectory();
    const outsideWorld = path.join(outside, 'world');
    await fs.rename(path.join(item.root, 'world'), outsideWorld);
    await fs.symlink(outsideWorld, path.join(item.root, 'world'), 'dir');

    await expect(loadGameArtPack({
      ...item, expectedProfile: 'candidate', contract: CONTRACT, pixelValidators: validators,
    })).rejects.toThrow('refuses symbolic link world');
  });

  it('rejects a nested directory symlink even when it points inside a declared tree', async () => {
    // WHY: an exact filename inventory is not a containment proof if recursive
    // walking can follow a directory entry into another tree.
    const item = await fixture('candidate', [SPECS[0].identity]);
    const outside = await temporaryDirectory();
    await fs.symlink(outside, path.join(item.root, 'world', 'escape'), 'dir');

    await expect(loadGameArtPack({
      ...item, expectedProfile: 'candidate', contract: CONTRACT, pixelValidators: validators,
    })).rejects.toThrow('refuses symbolic link world/escape');
  });

  it('rejects an expected file replaced by a symlink to matching outside bytes', async () => {
    // WHY: hash equality does not authorize reading outside the selected pack.
    const item = await fixture('candidate', [SPECS[0].identity]);
    const outside = await temporaryDirectory();
    const outsideFile = path.join(outside, 'matching.png');
    await fs.writeFile(outsideFile, item.bytes.get(SPECS[0].identity)!);
    const expectedFile = path.join(item.root, SPECS[0].file);
    await fs.rm(expectedFile);
    await fs.symlink(outsideFile, expectedFile, 'file');

    await expect(loadGameArtPack({
      ...item, expectedProfile: 'candidate', contract: CONTRACT, pixelValidators: validators,
    })).rejects.toThrow(`refuses symbolic link ${SPECS[0].file}`);
  });

  it('uses real paths to reject a symlinked managed-root ancestor escape', async () => {
    const item = await fixture('candidate', [SPECS[0].identity]);
    const outside = await temporaryDirectory();
    const outsideWorld = path.join(outside, 'world');
    await fs.rename(path.join(item.root, 'world'), outsideWorld);
    await fs.symlink(outside, path.join(item.root, 'bundle'), 'dir');
    const escapedFile = `bundle/${SPECS[0].file}`;
    const manifest = {
      ...item.manifest,
      entries: [{ ...item.manifest.entries[0]!, file: escapedFile }],
    };
    const provenance = {
      ...item.provenance,
      outputs: [{ ...item.provenance.outputs[0]!, file: escapedFile }],
    };

    await expect(loadGameArtPack({
      ...item,
      manifest,
      provenance,
      managedRoots: ['bundle/world'],
      expectedProfile: 'candidate',
      contract: CONTRACT,
      pixelValidators: validators,
    })).rejects.toThrow('resolves outside the game art pack root');
  });
});
