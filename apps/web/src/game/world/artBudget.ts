/**
 * A hard ceiling for ON-DEMAND art resident at once. This is presentation
 * memory, not a game number: Phaser uploads atlas PNGs as RGBA8 textures, so a
 * 4K sheet costs ~64 MiB even when its compressed transfer is only a few MiB.
 * The game targets Android WebViews; staying below 96 MiB for the optional
 * troop/tower layer leaves room for the eager world atlases and framebuffers.
 */
export const ON_DEMAND_ART_BUDGET_BYTES = 96 * 1024 * 1024;

/** Network/loader failures retry without asking the player to reload. The
 * sequence is deliberately finite; a permanently missing atlas degrades to a
 * stationary exact-current still instead of polling forever. */
export const BASE_ART_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;

export interface AtlasCandidate {
  /** Stable caller-owned identity (unit name, `defences`, etc.). */
  id: string;
  /** Atomic group set: partial admission would create an incomplete controller. */
  groups: readonly string[];
}

export interface AtlasAdmission {
  accepted: Set<string>;
  /** Existing reservations plus every newly accepted group. */
  reservedGroups: Set<string>;
  reservedBytes: number;
}

/** Base patrol motion is functional current art. Sort both inputs so a database
 * row order change cannot decide which walker animates, then reserve every
 * visible compact patrol group before spending the remainder on tower sheets. */
export function basePatrolFirstCandidates(
  patrol: readonly AtlasCandidate[],
  enhancements: readonly AtlasCandidate[],
): AtlasCandidate[] {
  const byId = (a: AtlasCandidate, b: AtlasCandidate): number =>
    a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
  return [...patrol].sort(byId).concat([...enhancements].sort(byId));
}

/** Snapshot row order is database incidental. Towers whose sim events demand a
 * visible shot reserve before passive building/wall animation, deterministically. */
export function defenseCombatFirstCandidates(
  combat: readonly AtlasCandidate[], enhancements: readonly AtlasCandidate[],
): AtlasCandidate[] {
  const byId = (a: AtlasCandidate, b: AtlasCandidate): number =>
    a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
  return [...combat].sort(byId).concat([...enhancements].sort(byId));
}

/** The three locomotion regressions reported by the owner. Their compact
 * current-pack walk sheets reserve ahead of other optional motion regardless
 * of deploy order; everything else keeps first-event order. */
export const REQUIRED_WALKER_PRIORITY = ['bowman', 'troll', 'plunderer'] as const;

export function prioritizeRequiredWalkers(troops: readonly string[]): string[] {
  const rank = new Map<string, number>(
    REQUIRED_WALKER_PRIORITY.map((troop, index) => [troop, index]),
  );
  return troops
    .map((troop, index) => ({ troop, index, rank: rank.get(troop) }))
    .sort((a, b) => {
      if (a.rank !== undefined || b.rank !== undefined) {
        if (a.rank === undefined) return 1;
        if (b.rank === undefined) return -1;
        return a.rank - b.rank;
      }
      return a.index - b.index;
    })
    .map(({ troop }) => troop);
}

export function isRequiredWalker(troop: string): boolean {
  return (REQUIRED_WALKER_PRIORITY as readonly string[]).includes(troop);
}

/** Unique non-hero troop types the event stream will actually render, including
 * simulator-authored spawn products that never appear in an army count. */
export function deployedTroopTypes(
  events: ReadonlyArray<{ e: string } & Record<string, unknown>>,
): string[] {
  const seen = new Set<string>();
  for (const event of events) {
    if (event.e !== 'deploy' && event.e !== 'troopSpawn') continue;
    if (event.e === 'deploy' && event.hero) continue;
    if (typeof event.troop === 'string') seen.add(event.troop);
  }
  return [...seen];
}

/**
 * Admit atomic atlas sets in caller priority order without exceeding decoded
 * texture residency. Missing size metadata fails closed: the legacy renderer
 * is preferable to an unbounded allocation after an art-pipeline drift.
 *
 * `residentBytes` is measured from textures already registered by the shared
 * loader (including legacy trpdg atlases). `reservedGroups` covers accepted
 * requests still in flight, so two markers arriving in one loader batch cannot
 * each spend the same remaining budget.
 */
export function admitAtlasCandidates(
  atlasBytes: Readonly<Record<string, number>>,
  residentBytes: number,
  residentGroups: ReadonlySet<string>,
  reservedGroups: ReadonlySet<string>,
  candidates: readonly AtlasCandidate[],
  budgetBytes = ON_DEMAND_ART_BUDGET_BYTES,
): AtlasAdmission {
  const reserved = new Set(reservedGroups);
  let total = Math.max(0, residentBytes);

  // A reservation stops costing separately once the texture is resident.
  for (const group of reserved) {
    if (residentGroups.has(group)) continue;
    const bytes = atlasBytes[group];
    if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0) total += bytes;
  }

  const accepted = new Set<string>();
  for (const candidate of candidates) {
    const additions = [...new Set(candidate.groups)]
      .filter((group) => !residentGroups.has(group) && !reserved.has(group));
    let extra = 0;
    let sized = true;
    for (const group of additions) {
      const bytes = atlasBytes[group];
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
        sized = false;
        break;
      }
      extra += bytes;
    }
    if (!sized || total + extra > budgetBytes) continue;
    accepted.add(candidate.id);
    additions.forEach((group) => reserved.add(group));
    total += extra;
  }

  return { accepted, reservedGroups: reserved, reservedBytes: total };
}
