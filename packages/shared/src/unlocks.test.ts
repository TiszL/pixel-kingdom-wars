/**
 * The unlock list is a DERIVED view — these tests pin that it stays truthful
 * to the gating constants, because a list that drifts from what the server
 * allows is worse than no list (M23 a19).
 */
import { describe, expect, it } from 'vitest';
import { BUILD_COSTS, CAPS, HEROES, TROOPS } from './constants';
import { maxKeepLevel, unlocksAtKeepLevel } from './unlocks';

describe('unlocksAtKeepLevel', () => {
  it('surfaces every Keep-gated building exactly once, at its gate level', () => {
    const seen = new Map<string, number>();
    for (let level = 2; level <= maxKeepLevel(); level++) {
      for (const u of unlocksAtKeepLevel(level)) {
        if (u.kind !== 'building') continue;
        expect(seen.has(u.id!)).toBe(false);
        seen.set(u.id!, level);
      }
    }
    for (const [type, spec] of Object.entries(BUILD_COSTS)) {
      const req = (spec as { requiresKeepLevel?: number }).requiresKeepLevel;
      if (req !== undefined && req >= 2) {
        expect(seen.get(type)).toBe(req);
      }
    }
  });

  it('surfaces every Keep-gated troop and hero at its gate level', () => {
    for (const [troop, spec] of Object.entries(TROOPS)) {
      const req = (spec as { requiresKeepLevel?: number }).requiresKeepLevel;
      if (req === undefined) continue;
      expect(unlocksAtKeepLevel(req)).toContainEqual({ kind: 'troop', id: troop });
    }
    for (const [hero, spec] of Object.entries(HEROES)) {
      expect(unlocksAtKeepLevel(spec.unlockKeepLevel)).toContainEqual({ kind: 'hero', id: hero });
    }
  });

  it('knows the load-bearing early levels the sheet will show most', () => {
    // L2: the Forge (research) opens.
    expect(unlocksAtKeepLevel(2).some((u) => u.kind === 'building' && u.id === 'forge')).toBe(true);
    // L3: mortar, goldforge, rally, first expansion.
    const l3 = unlocksAtKeepLevel(3);
    for (const id of ['mortar', 'goldforge']) {
      expect(l3).toContainEqual({ kind: 'building', id });
    }
    expect(l3).toContainEqual({ kind: 'rally' });
    expect(l3.some((u) => u.kind === 'expansion' && u.value === CAPS.claimTilesByExpansion[1])).toBe(true);
    // L5: BOTH heroes + their altars (D-058, owner 2026-08-16: "hero unlock
    // start from keep level 5" — this moved from the retired Vex-L3/Theodor-L4
    // spec gates, so the unlock sheet must advertise them at 5, nowhere else).
    const l5 = unlocksAtKeepLevel(5);
    for (const id of ['heroaltar', 'siegestool']) {
      expect(l5).toContainEqual({ kind: 'building', id });
    }
    expect(l5).toContainEqual({ kind: 'hero', id: 'vex' });
    expect(l5).toContainEqual({ kind: 'hero', id: 'theodor' });
    // L15/L17: the Keep's own batteries.
    expect(unlocksAtKeepLevel(15)).toContainEqual({ kind: 'keepBattery', id: 'high' });
    expect(unlocksAtKeepLevel(17)).toContainEqual({ kind: 'keepBattery', id: 'low' });
  });

  it('reports cap GROWTH with both delta and the new absolute value', () => {
    // Keep L5: barracks/camp go 1 → 2 and clanhall unlocks (its own row).
    const l5 = unlocksAtKeepLevel(5);
    expect(l5).toContainEqual({ kind: 'buildCount', id: 'barracks', delta: 1, value: 2 });
    expect(l5).toContainEqual({ kind: 'building', id: 'clanhall' });
    // A type unlocking at this level must NOT also appear as count growth.
    expect(l5.some((u) => u.kind === 'buildCount' && u.id === 'clanhall')).toBe(false);
  });

  it('never reports a unlock outside 2..maxKeepLevel or an empty max level range', () => {
    expect(unlocksAtKeepLevel(1)).not.toContainEqual(expect.objectContaining({ kind: 'building' }));
    let total = 0;
    for (let level = 2; level <= maxKeepLevel(); level++) total += unlocksAtKeepLevel(level).length;
    expect(total).toBeGreaterThan(30); // the tree is genuinely populated
  });
});
