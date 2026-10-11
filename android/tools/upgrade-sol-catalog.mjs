// catalogue.display.upgradeSolLamports[type][targetLevel] — the SOL price (lamports, decimal
// string) of upgrading `type` TO `targetLevel`, for every level 1..max of EVERY building type.
//
// Owner incident 2026-09-18: the exporter sized each table from `settings.maxLevel`, which only
// STRUCTURES entries carry. DEFENSES entries have no `maxLevel` and the wall carries `maxTier`,
// so every defence, trap and wall exported `{}` in every published pack and the native client
// dimmed UPGRADE on all of them. The ceiling now comes from the same canonical fields the
// server's MAX_LEVEL table is built from (apps/api/src/game/base.ts), cross-checked against the
// UPGRADE_COSTS step count, and an incomplete table refuses the export.

/** Canonical level ceiling of `type`: STRUCTURES[type].maxLevel, the wall's maxTier, or
 *  DEFENSE_LEVELING.maxLevel for every DEFENSES type — the fields the server's MAX_LEVEL uses. */
export function canonicalMaxLevel(constants, type) {
  const structure = Object.hasOwn(constants.STRUCTURES, type) ? constants.STRUCTURES[type] : undefined;
  const max = structure ? structure.maxLevel ?? structure.maxTier
    : Object.hasOwn(constants.DEFENSES, type) ? constants.DEFENSE_LEVELING.maxLevel : undefined;
  if (!Number.isInteger(max) || max < 1) throw new Error(`No canonical max level for building type: ${type}`);
  // UPGRADE_COSTS holds one step per L(n)->L(n+1): a disagreement means one of the two canonical
  // sources moved without the other, and either answer would publish a wrong table.
  const steps = Object.hasOwn(constants.UPGRADE_COSTS, type) ? constants.UPGRADE_COSTS[type].length : undefined;
  if (steps !== undefined && steps + 1 !== max) throw new Error(`Max level ${max} of ${type} disagrees with its ${steps} UPGRADE_COSTS steps`);
  return max;
}

/** STRUCTURES first, then DEFENSES: the key order every published pack already uses. */
export const upgradableTypes = (constants) => [...Object.keys(constants.STRUCTURES), ...Object.keys(constants.DEFENSES)];

/** Refuses a table that is missing a type or a level, or that disagrees with the canonical function. */
export function assertUpgradeSolLamports(table, constants) {
  const types = upgradableTypes(constants);
  for (const type of Object.keys(constants.UPGRADE_COSTS)) if (!types.includes(type)) throw new Error(`UPGRADE_COSTS type has no canonical max level: ${type}`);
  if (Object.keys(table).join() !== types.join()) throw new Error(`upgradeSolLamports types differ from STRUCTURES + DEFENSES: ${Object.keys(table).join()}`);
  for (const type of types) {
    const max = canonicalMaxLevel(constants, type);
    const levels = Object.keys(table[type]);
    if (levels.length === 0) throw new Error(`upgradeSolLamports table is empty for ${type}`);
    if (levels.join() !== Array.from({ length: max }, (_, index) => String(index + 1)).join()) throw new Error(`upgradeSolLamports levels of ${type} are not 1..${max}: ${levels.join()}`);
    for (const level of levels) {
      const lamports = constants.upgradeSolLamports(type, Number(level));
      if (!Number.isSafeInteger(lamports) || lamports < 0) throw new Error(`Canonical SOL price of ${type} L${level} is not a whole lamport amount: ${lamports}`);
      if (table[type][level] !== String(lamports)) throw new Error(`upgradeSolLamports ${type} L${level} is ${JSON.stringify(table[type][level])}, canonical ${lamports}`);
    }
  }
  return table;
}

/** @param constants the `packages/shared/src/constants.ts` module namespace */
export function buildUpgradeSolLamports(constants) {
  return assertUpgradeSolLamports(Object.fromEntries(upgradableTypes(constants).map((type) => [type,
    Object.fromEntries(Array.from({ length: canonicalMaxLevel(constants, type) }, (_, index) => [String(index + 1), String(constants.upgradeSolLamports(type, index + 1))]))])), constants);
}
