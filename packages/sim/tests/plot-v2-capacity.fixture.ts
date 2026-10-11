import {
  BUILD_COUNT_CAP_BY_KEEP, BuildingType, CAPS, MINING, PHASE_E_BUILDINGS,
  plotBounds, type BaseSnapshot, type Building,
} from '@shardkeep/shared';
import { footprintOf } from '../src/stats';

/** Capacity fixture only: every existing L20 building allowance, with unchanged
 * counts, spread into all four corners of the proposed signed building frame. */
export function maximumPlot2Snapshot(): BaseSnapshot {
  const level = 20;
  const { min, max } = plotBounds(2);
  const wallCap = BUILD_COUNT_CAP_BY_KEEP.wall![level - 1]!;
  const walls: Building[] = [];
  const wall = (tx: number, ty: number): void => {
    walls.push({ id: `wall_${tx}_${ty}`, type: BuildingType.Wall, level, tx, ty });
  };
  for (let x = min; x < max; x++) { wall(x, min); wall(x, max - 1); }
  for (let y = min + 1; y < max - 1; y++) { wall(min, y); wall(max - 1, y); }
  // A second closed compartment forces routing and repeated cost-field rebuilds.
  for (let x = -4; x <= 9; x++) { wall(x, -4); wall(x, 9); }
  for (let y = -3; y < 9; y++) { wall(-4, y); wall(9, y); }
  for (let x = 13; walls.length < wallCap; x++) wall(x, -4);
  const occupied = new Set(walls.map(building => `${building.tx},${building.ty}`));
  const candidates: { tx: number; ty: number }[] = [];
  for (let ty = min + 2; ty < max - 2; ty += 4) {
    for (let tx = min + 2; tx < max - 2; tx += 4) candidates.push({ tx, ty });
  }
  const distance = ({ tx, ty }: { tx: number; ty: number }): number => (tx - 15) ** 2 + (ty - 15) ** 2;
  candidates.sort((a, b) => distance(b) - distance(a) || a.ty - b.ty || a.tx - b.tx);
  const buildings: Building[] = [...walls];
  const place = (type: BuildingType, count: number): void => {
    const { fw, fh } = footprintOf(type);
    for (let index = 0; index < count; index++) {
      const tile = candidates.find(({ tx, ty }) => {
        for (let dy = 0; dy < fh; dy++) for (let dx = 0; dx < fw; dx++) {
          if (occupied.has(`${tx + dx},${ty + dy}`)) return false;
        }
        return tx + fw < max && ty + fh < max;
      });
      if (!tile) throw new Error(`capacity fixture exhausted placement space for ${type}`);
      for (let dy = 0; dy < fh; dy++) for (let dx = 0; dx < fw; dx++) occupied.add(`${tile.tx + dx},${tile.ty + dy}`);
      buildings.push({ id: `${type}_${index}`, type, level, ...tile });
    }
  };
  place(BuildingType.Keep, 1);
  // The five Phase E types are DARK (D-152 §5 commit A): no placement exists, so
  // no snapshot can carry them; adding them here would silently move the signed
  // plot-v2 goldens. Commit B (SIM 18) gets its own fixture for them.
  const dark: readonly string[] = PHASE_E_BUILDINGS.types;
  for (const [type, counts] of Object.entries(BUILD_COUNT_CAP_BY_KEEP)) {
    if (type !== BuildingType.Wall && !dark.includes(type)) place(type as BuildingType, counts[level - 1]!);
  }
  place(BuildingType.Mine, MINING.MAX_MINES_BY_KEEP[level - 1]!);
  const traps = [BuildingType.SpikeTrap, BuildingType.PowderMine, BuildingType.Pitfall, BuildingType.AirMine];
  for (let index = 0; index < CAPS.trapsByKeepLevel[level - 1]!; index++) {
    const type = traps[index % traps.length]!;
    // Keep ids unique while distributing the aggregate trap budget.
    const before = buildings.length;
    place(type, 1);
    buildings[before]!.id = `${type}_${index}`;
  }
  const guard = (type: BuildingType, hero: 'vex' | 'theodor') => {
    const altar = buildings.find(building => building.type === type)!;
    return { hero, level, guardTx: altar.tx, guardTy: altar.ty };
  };
  return { plotVersion: 2, battlefieldVersion: 2, claimMin: min, claimMax: max,
    keepLevel: level, surplusShards: 100_000, buildings,
    defenderHeroes: [guard(BuildingType.HeroAltar, 'vex'), guard(BuildingType.SiegeStool, 'theodor')] };
}
