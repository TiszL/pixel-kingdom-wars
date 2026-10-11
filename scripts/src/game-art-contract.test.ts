import { describe, expect, it } from 'vitest';

import {
  GAME_ART_CONTRACT_SCHEMA,
  gameArtContractSha256,
  normalizeGameArtContract,
  normalizeGameArtPath,
  type GameArtContract,
} from './game-art-contract.js';

function contract(entries: GameArtContract['entries']): GameArtContract {
  return { schemaVersion: GAME_ART_CONTRACT_SCHEMA, entries };
}

describe('game art runtime contract', () => {
  it('uses explicit identities for every source shape and hashes independently of entry/object ordering', () => {
    // WHY: v4 sources are PNGs, while the legacy key helpers strip only `.svg`.
    // Explicit identities prevent a source extension or directory move from
    // silently renaming an atlas frame.
    const first = contract([
      { identity: 'standalone:ui/items/helm', width: 56, height: 56, pixelLaw: 'v4-ui' },
      {
        identity: 'ware:ware_bld_wall_cross_t4', width: 48, height: 48, pixelLaw: 'v4-world',
        metadata: { mask: 15, anchor: [0.5, 0.75] },
      },
      { identity: 'v2:v2_trp_giant_t4_walk', width: 896, height: 896, pixelLaw: 'v4-actor' },
      { identity: 'simple:tile_grass_1', width: 64, height: 64, pixelLaw: 'v4-tile' },
    ]);
    const reordered = contract([
      { identity: 'simple:tile_grass_1', height: 64, width: 64, pixelLaw: 'v4-tile' },
      { identity: 'v2:v2_trp_giant_t4_walk', height: 896, width: 896, pixelLaw: 'v4-actor' },
      {
        identity: 'ware:ware_bld_wall_cross_t4', height: 48, width: 48, pixelLaw: 'v4-world',
        metadata: { anchor: [0.5, 0.75], mask: 15 },
      },
      { identity: 'standalone:ui/items/helm', height: 56, width: 56, pixelLaw: 'v4-ui' },
    ]);

    const normalized = normalizeGameArtContract(first);
    expect(normalized.entries.map(({ identity }) => identity)).toEqual([
      'simple:tile_grass_1',
      'standalone:ui/items/helm',
      'v2:v2_trp_giant_t4_walk',
      'ware:ware_bld_wall_cross_t4',
    ]);
    expect(Object.isFrozen(normalized.entries[3]!.metadata)).toBe(true);
    expect(Object.isFrozen((normalized.entries[3]!.metadata as { anchor: number[] }).anchor)).toBe(true);
    expect(gameArtContractSha256(first)).toBe(gameArtContractSha256(reordered));
  });

  it('keeps ordered animation facts inside the digest', () => {
    // WHY: rowOrder changes the meaning of every cell while leaving dimensions
    // and file bytes plausible. Contract hashing must detect that semantic drift.
    const southFirst = contract([{
      identity: 'v2:v2_trp_giant_t4_walk', width: 896, height: 896, pixelLaw: 'v4-actor',
      metadata: { rowOrder: ['s', 'sw', 'w', 'nw', 'n', 'ne', 'e', 'se'], fps: 8 },
    }]);
    const northFirst = contract([{
      identity: 'v2:v2_trp_giant_t4_walk', width: 896, height: 896, pixelLaw: 'v4-actor',
      metadata: { rowOrder: ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'], fps: 8 },
    }]);
    expect(gameArtContractSha256(southFirst)).not.toBe(gameArtContractSha256(northFirst));
  });

  it('rejects ambiguous identities, duplicates, and non-JSON runtime metadata', () => {
    expect(() => normalizeGameArtContract(contract([
      { identity: 'simple:tile_grass_1', width: 64, height: 64, pixelLaw: 'tile' },
      { identity: 'simple:tile_grass_1', width: 64, height: 64, pixelLaw: 'tile' },
    ]))).toThrow('duplicate game art contract identity');
    expect(() => normalizeGameArtContract(contract([
      { identity: 'v2:../giant' as never, width: 1, height: 1, pixelLaw: 'v2' },
    ]))).toThrow('normalized lower-case id');
    expect(() => normalizeGameArtContract(contract([{
      identity: 'simple:tile', width: 1, height: 1, pixelLaw: 'tile',
      metadata: { fps: Number.NaN },
    }]))).toThrow('non-finite number');
  });

  it('accepts only normalized secret-free relative paths', () => {
    expect(normalizeGameArtPath('actors/giant/walk.png')).toBe('actors/giant/walk.png');
    for (const unsafe of ['/tmp/walk.png', '../walk.png', 'actors/../walk.png', 'actors\\walk.png']) {
      expect(() => normalizeGameArtPath(unsafe), unsafe).toThrow('normalized relative POSIX path');
    }
  });
});
