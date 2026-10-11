/**
 * The shared barrel.
 *
 * `./globe` AND `./earthMask` ARE DELIBERATELY NOT HERE — reach them at
 * `@shardkeep/shared/globe` / `@shardkeep/shared/earthMask` (package.json
 * `exports`), the same subpath pattern `./earthMaskFine` already uses.
 *
 * WHY: `packages/sim` imports THIS barrel (src/stats.ts, src/sim.ts), and an
 * `export *` puts every re-exported module inside the simulator's module graph.
 * globe.ts is trig (Math.sin/atan2/hypot) and earthMask.ts decodes a base64 land
 * bitmask at module load — neither belongs anywhere near a deterministic replay,
 * and WORLDMAP-GLOBE-PLAN's named guard is exactly "packages/sim must never
 * import globe.ts". banned-tokens.test.ts scans the TEXT of packages/sim/src, so
 * it cannot see a transitive import; packages/sim/tests/import-graph.test.ts
 * walks the graph and fails if either module ever becomes reachable again.
 */
export * from './atlas';
export * from './combatTiming';
export * from './duration';
export * from './constants';
export * from './mining';
export * from './types';
export * from './replay';
export * from './raidLoot';
export * from './unlocks';
export * from './wallConnect';
export * from './plotGeometry';
