/** Test helpers: snapshot/order builders for small, legible scenarios. */
import { BuildingType, type BaseSnapshot, type Building, type DeployOrder, type TroopType } from '@shardkeep/shared';
import type { RaidOrders, SimEvent } from '../src/types';

let nextId = 0;
/**
 * Reset the auto-id counter. Golden scenarios are LAZY arrows, so `nextId` at the
 * time one runs depends on how many auto-ids every earlier scenario consumed —
 * meaning a change to scenario A silently renamed walls in scenarios B and C and
 * broke their fingerprints for no behavioural reason (hit 2026-07-26 when a wall
 * line became a ring). Each scenario resets first, so ids are per-scenario stable
 * and a fixture only moves when that scenario's BEHAVIOUR moves.
 */
export function resetIds(): void { nextId = 0; }
export function b(type: BuildingType, tx: number, ty: number, level = 1, id?: string): Building {
  return { id: id ?? `${type}_${nextId++}`, type, level, tx, ty };
}

export function base(buildings: Building[], keepLevel = 1, surplusShards = 1000): BaseSnapshot {
  return { keepLevel, buildings, surplusShards };
}

export function deploy(troop: TroopType, tx: number, ty: number, tMs = 0): DeployOrder {
  return { troop, tx, ty, tMs };
}

export function orders(deploys: DeployOrder[], extra: Omit<RaidOrders, 'deploys'> = {}): RaidOrders {
  return { deploys, ...extra };
}

/** A vertical wall line at column x covering rows [y0, y1]. */
export function wallLine(x: number, y0: number, y1: number, tier = 1): Building[] {
  const walls: Building[] = [];
  for (let y = y0; y <= y1; y++) walls.push(b(BuildingType.Wall, x, y, tier));
  return walls;
}

/**
 * A CLOSED wall ring around [min, max] inclusive — the only way to make a troop
 * genuinely blocked now that rule 2 routes troops through any gap. A single
 * `wallLine` never encloses anything (the battlefield extends past it on both
 * ends), so a troop simply walks around one; tests that mean to exercise
 * wall-BREAKING must seal the base. `idPrefix` gives addressable ids because
 * BuildingOutcome carries no coordinates.
 */
export function wallRing(min: number, max: number, tier = 1, idPrefix?: string): Building[] {
  const walls: Building[] = [];
  const id = (sx: number, sy: number): string | undefined =>
    idPrefix ? `${idPrefix}_${sx}_${sy}` : undefined;
  for (let x = min; x <= max; x++) {
    walls.push(b(BuildingType.Wall, x, min, tier, id(x, min)));
    walls.push(b(BuildingType.Wall, x, max, tier, id(x, max)));
  }
  for (let y = min + 1; y < max; y++) {
    walls.push(b(BuildingType.Wall, min, y, tier, id(min, y)));
    walls.push(b(BuildingType.Wall, max, y, tier, id(max, y)));
  }
  return walls;
}

/** FNV-1a 32-bit over a string — deterministic event-log fingerprint. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * The log as SIM13 would have written it: SIM14 publishes every hero basic
 * swing's applied building damage as a `hit` pushed IMMEDIATELY after the
 * swing's `heroAttack` cue (same tick, same target), and nothing else. Dropping
 * exactly those adjacent records must therefore reproduce a pre-SIM14
 * fingerprint — the mechanical proof that the bump added records only.
 */
export function withoutHeroSwingHits(events: readonly SimEvent[]): SimEvent[] {
  const kept: SimEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const prev = events[i - 1];
    if (e.e === 'hit' && prev && prev.e === 'heroAttack' && prev.targetKind === 'building'
      && prev.t === e.t && prev.target === e.target) continue;
    kept.push(e);
  }
  return kept;
}
