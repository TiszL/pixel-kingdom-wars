import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FANTASY_WORLD } from '../src/constants';
import {
  FANTASY_CATALOG_HASH, FANTASY_MEMBERSHIP_HASH, FANTASY_WORLD_ID, crownlandsMigrationTiles, fantasyTileAt,
  fantasyTiles, getFantasyTile,
} from '../src/fantasyWorld';

describe('approved fantasy deed identity', () => {
  const tiles = [...fantasyTiles()];
  it('freezes all eight realm supplies; paint cannot create or erase deeds', () => {
    expect(tiles).toHaveLength(FANTASY_WORLD.totalTiles);
    expect(Object.fromEntries([...new Set(tiles.map(t => t.realmId))].map(id => [id, tiles.filter(t => t.realmId === id).length])))
      .toEqual({ frostveil: 13126, elderwood: 13610, sunscar: 13925, crownlands: 12959,
        'seeker-reach': 5582, stormcairn: 15270, thornwake: 6705, cinderfall: 4237 });
    expect(new Set(tiles.map(t => t.tileId)).size).toBe(FANTASY_WORLD.totalTiles);
    expect(FANTASY_MEMBERSHIP_HASH).toBe('c147d5dcab8c6175452136283117d5a71d1b60ec7d953bb18116b0206cae0ccb');
    expect(createHash('sha256').update(JSON.stringify(tiles.map(t => t.tileId))).digest('hex'))
      .toBe(FANTASY_MEMBERSHIP_HASH);
  });
  it('fingerprints realm and reservation identity, including same-count substitutions', () => {
    const digest = (records: typeof tiles) => createHash('sha256').update(JSON.stringify({
      worldId: FANTASY_WORLD_ID, columns: FANTASY_WORLD.columns, rows: FANTASY_WORLD.rows,
      tiles: records.map(t => [t.tileId, t.realmId, t.allocation]),
    })).digest('hex');
    expect(digest(tiles)).toBe(FANTASY_CATALOG_HASH);
    const g = tiles.findIndex(t => t.allocation === 'genesis');
    const s = tiles.findIndex(t => t.allocation === 'seeker');
    const swapped = tiles.map(t => ({ ...t }));
    [swapped[g]!.allocation, swapped[s]!.allocation] = [swapped[s]!.allocation, swapped[g]!.allocation];
    expect(digest(swapped)).not.toBe(FANTASY_CATALOG_HASH);
    const other = tiles.findIndex(t => t.realmId !== tiles[0]!.realmId);
    const realmSwapped = tiles.map(t => ({ ...t }));
    [realmSwapped[0]!.realmId, realmSwapped[other]!.realmId] = [realmSwapped[other]!.realmId, realmSwapped[0]!.realmId];
    expect(digest(realmSwapped)).not.toBe(FANTASY_CATALOG_HASH);
  });
  it('reserves every Solana cell with exact Genesis and Seeker membership', () => {
    expect(tiles.filter(t => t.allocation === 'ordinary')).toHaveLength(FANTASY_WORLD.ordinaryTiles);
    expect(tiles.filter(t => t.allocation === 'genesis')).toHaveLength(FANTASY_WORLD.genesisTiles);
    expect(tiles.filter(t => t.allocation === 'seeker')).toHaveLength(FANTASY_WORLD.seekerTiles);
    expect(tiles.filter(t => t.realmId === 'seeker-reach').every(t => t.allocation !== 'ordinary')).toBe(true);
  });
  it('centres round-trip for every deed, including dateline cells', () => {
    for (const t of tiles) expect(fantasyTileAt(t.lon, t.lat)).toEqual(t);
    for (const t of tiles.filter(t => Math.abs(t.lon) > 175)) {
      expect(fantasyTileAt(t.lon + 360, t.lat)).toEqual(t);
      expect(fantasyTileAt(t.lon - 360, t.lat)).toEqual(t);
    }
  });
  it('never turns malformed addresses or ocean into an allocation', () => {
    for (const id of [NaN, Infinity, -1, 1.1, 259200]) expect(getFantasyTile(id)).toBeNull();
    expect(fantasyTileAt(0, 0)).toBeNull();
    expect(fantasyTileAt(Infinity, 0)).toBeNull();
    expect(fantasyTileAt(0, 91)).toBeNull();
  });
  it('uses stable central Crownlands order, without name or owner dependence', () => {
    const ranking = crownlandsMigrationTiles();
    expect(ranking).toHaveLength(12959);
    expect(ranking[0]).toMatchObject({ realmId: 'crownlands', lon: 25.75, lat: 23.25 });
    expect(ranking.every(t => t.allocation === 'ordinary')).toBe(true);
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    expect(hash(ranking)).toBe(hash(crownlandsMigrationTiles()));
  });
});
