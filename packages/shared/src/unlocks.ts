/**
 * Keep-level unlock reverse index (owner 2026-08-15, M23 a19: "listed unlocks
 * for each upgrade … same as same type games do").
 *
 * DERIVED ONLY. Every fact here is read from the constants that already govern
 * gameplay — BUILD_COSTS gates, count-cap tables, troop/hero gates, rally and
 * Keep batteries — never written down a second time, so the list can never
 * disagree with what the server actually allows. Display naming stays in the
 * web layer (TRAY_LABELS / TROOP_DISPLAY); this module returns typed ids.
 *
 * The dark-roster caveat is deliberate: giant/troll/dragon/mage/bilgewraith
 * are gated by the server rollout feature, not Keep level, so they are
 * intentionally absent — a Keep-level list that promised them would over-
 * promise (see troopRolloutGate in the web).
 */
import {
  BUILD_COSTS, BUILD_COUNT_CAP_BY_KEEP, CAPS, HEROES, KEEP_BATTERIES, MINING, RALLY, STRUCTURES, TROOPS,
} from './constants';

export interface KeepLevelUnlock {
  /** What kind of thing unlocks/grows at this Keep level. */
  kind: 'building' | 'troop' | 'hero' | 'rally' | 'keepBattery' | 'buildCount' | 'mineCap' | 'trapCap' | 'expansion';
  /** building/troop/hero id where applicable (e.g. 'mortar', 'gloamfang', 'vex'). */
  id?: string;
  /** For cap growth: how many MORE may be placed at this level. */
  delta?: number;
  /** For cap growth/expansion: the new absolute value (count or claim tiles). */
  value?: number;
}

/** Everything that becomes available when the Keep reaches `level` (2..max). */
export function unlocksAtKeepLevel(level: number): KeepLevelUnlock[] {
  const out: KeepLevelUnlock[] = [];

  // New building TYPES gated exactly at this level. Un-gated types are the
  // level-1 baseline — available from the first Keep, so never an "unlock".
  const newBuildings = new Set<string>();
  for (const [type, spec] of Object.entries(BUILD_COSTS)) {
    const req = (spec as { requiresKeepLevel?: number }).requiresKeepLevel;
    if (req !== undefined && req === level) {
      newBuildings.add(type);
      out.push({ kind: 'building', id: type });
    }
  }

  // Troops with an explicit Keep gate.
  for (const [troop, spec] of Object.entries(TROOPS)) {
    if ((spec as { requiresKeepLevel?: number }).requiresKeepLevel === level) {
      out.push({ kind: 'troop', id: troop });
    }
  }

  // Heroes, rally, and the Keep's own batteries.
  for (const [hero, spec] of Object.entries(HEROES)) {
    if (spec.unlockKeepLevel === level) out.push({ kind: 'hero', id: hero });
  }
  if (RALLY.unlockKeepLevel === level) out.push({ kind: 'rally' });
  if (KEEP_BATTERIES.highRangeUnlockLevel === level) out.push({ kind: 'keepBattery', id: 'high' });
  if (KEEP_BATTERIES.lowRangeUnlockLevel === level) out.push({ kind: 'keepBattery', id: 'low' });

  // Placement-count growth for existing types (skip a type that unlocks at
  // this exact level — its first slot IS the unlock row above).
  for (const [type, caps] of Object.entries(BUILD_COUNT_CAP_BY_KEEP)) {
    if (newBuildings.has(type)) continue;
    const prev = caps[level - 2] ?? 0;
    const next = caps[level - 1] ?? prev;
    if (next > prev) out.push({ kind: 'buildCount', id: type, delta: next - prev, value: next });
  }

  // Mine and aggregate-trap caps keep their own Keep curves.
  {
    const prev = MINING.MAX_MINES_BY_KEEP[level - 2] ?? 0;
    const next = MINING.MAX_MINES_BY_KEEP[level - 1] ?? prev;
    if (next > prev) out.push({ kind: 'mineCap', delta: next - prev, value: next });
  }
  {
    const prev = CAPS.trapsByKeepLevel[level - 2] ?? 0;
    const next = CAPS.trapsByKeepLevel[level - 1] ?? prev;
    if (next > prev) out.push({ kind: 'trapCap', delta: next - prev, value: next });
  }

  // Land expansions whose purchase gate is this level.
  CAPS.expansionReqKeepLevel.forEach((req, i) => {
    const claim = CAPS.claimTilesByExpansion[i + 1];
    if (req === level && claim !== undefined) {
      out.push({ kind: 'expansion', value: claim });
    }
  });

  return out;
}

/** Max Keep level, from the structure table (single source). */
export function maxKeepLevel(): number {
  return STRUCTURES.keep.maxLevel;
}
