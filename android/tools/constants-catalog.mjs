// catalogue.constants carries every top-level runtime export of
// packages/shared/src/constants.ts (keyed by export name) so the native client never
// keeps a Kotlin copy of a cost, stat, cap or timer (native CLAUDE.md "Authority";
// review finding: LAND_CHECKOUT_RECOVERY, MOBILE_BACK, WORLD, ECONOMY had been copied).
//
// The renderer/network readers were written against the allowlisted keys, so those keep
// their position and value shape exactly; every other export follows in name order.
// Top-level function exports are skipped (they are executed by the exporter and described
// by the render catalogue or `display` sections). A nested function or a value JSON cannot
// carry (non-finite number, undefined, Set/Map/RegExp/Date, class instance, symbol) fails
// the export: silently dropping it would hide a game rule from the client.

/** Keys the renderer/network readers were written against (renderer contract <= 13): kept first, in this order. */
export const CATALOGUE_CONSTANT_ALLOWLIST = ['GRID', 'BASE_CAMERA', 'CAPS', 'TROOPS', 'TROOP_ABILITIES', 'TROOP_LEVELING', 'DEFENSES', 'STRUCTURES', 'BUILD_COSTS', 'UPGRADE_COSTS', 'UPGRADE_TIMES_SEC', 'MINING', 'TRAP_REPAIR', 'TUTORIAL_STEPS',
  'ART_V2', 'BUILDING_FIT', 'WARE_WORLD_PRESENTATION', 'HEROES', 'HERO_SKILLS', 'HERO_COMBAT', 'AUTHORED_ATTACK_TIMINGS',
  'DEFENSE_PROJECTILE_TIMINGS', 'BATTLE_SCALE', 'RAID_RULES', 'LEVEL_STEP_BUILDING', 'LEVEL_STEP_TROOP',
  // Contract 13 additions: five-tier walls, Builder Workman, realm ground, fantasy world, training schedule v2.
  'WALL_ART', 'AMBIENCE', 'BASE_GROUND_GEOMETRY', 'BASE_GROUND_WORLD_GEOMETRY', 'BASE_GROUND_MOTION', 'FANTASY_WORLD',
  'TRAINING_SCHEDULE', 'TRAINING_FIRST_FINISH', 'CAMPAIGN', 'OBSTACLES'];

/** Names whose nested function fields were already dropped by the allowlisted export
 *  (HEROES.<hero>.hpAt/dpsAt/regenMinAt/upgradeCostAt); the per-level values they compute
 *  reach the client through server state. Frozen here so any new nested function fails loud. */
export const KNOWN_NESTED_FUNCTIONS = new Set(['HEROES']);

export function assertJsonCarriable(value, trail, seen = new Set()) {
  const type = typeof value;
  if (value === null || type === 'string' || type === 'boolean') return;
  if (type === 'number') { if (!Number.isFinite(value)) throw new Error(`Constant ${trail} is not JSON-carriable: ${value}`); return; }
  if (type === 'bigint') return; // the exporter serialises bigint as a decimal string
  if (type === 'undefined' || type === 'function' || type === 'symbol') throw new Error(`Constant ${trail} is not JSON-carriable: ${type}`);
  if (seen.has(value)) throw new Error(`Constant ${trail} is circular`);
  seen.add(value);
  if (Array.isArray(value)) { value.forEach((item, index) => assertJsonCarriable(item, `${trail}[${index}]`, seen)); return; }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`Constant ${trail} is not a plain object: ${prototype?.constructor?.name ?? 'null-prototype'}`);
  for (const [key, item] of Object.entries(value)) assertJsonCarriable(item, `${trail}.${key}`, seen);
}

export const constantFunctionExports = (constants) => Object.keys(constants).filter((key) => typeof constants[key] === 'function').sort();

/** @param constants the `packages/shared/src/constants.ts` module namespace
 *  @param allowlist keys the existing readers depend on, kept first in this order */
export function buildConstantsCatalogue(constants, allowlist = CATALOGUE_CONSTANT_ALLOWLIST) {
  for (const key of allowlist) if (constants[key] === undefined) throw new Error(`Canonical constant missing: ${key}`);
  const rest = Object.keys(constants).filter((key) => !allowlist.includes(key) && typeof constants[key] !== 'function').sort();
  const entries = [...allowlist, ...rest].map((key) => [key, constants[key]]);
  for (const [key, value] of entries) if (!KNOWN_NESTED_FUNCTIONS.has(key)) assertJsonCarriable(value, key);
  return Object.fromEntries(entries);
}
