/**
 * @shardkeep/sim — deterministic raid simulator (ARCHITECTURE §6).
 * Pure functions, zero I/O. simulateRaid(snapshot, orders, seed) replays
 * bit-identically on every JS engine; see sim.ts header for the contracts.
 */
export { mulberry32, type Rng } from './rng';
export { simulateRaid, computeStars, type SimOptions } from './sim';
export {
  SimInputError,
  SimRepresentationLimitError,
  type BuffSet,
  type BuildingOutcome,
  type RaidOrders,
  type RaidOutcome,
  type RallyOrder,
  type SimEvent,
} from './types';
export { UNITS_PER_TILE, tileCenter, unitToTile } from './fixed';
export { MAX_TICKS, DEPLOY_WINDOW_TICKS } from './stats';
export { SIM_VERSION } from './version';
