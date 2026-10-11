import { z } from 'zod';

export const ReplayBuildingHealthSchema = z.object({
  id: z.string().min(1), initialHp: z.number().int().nonnegative().safe(),
  maxHp: z.number().int().nonnegative().safe(),
});
export type ReplayBuildingHealth = z.infer<typeof ReplayBuildingHealthSchema>;

/** SIM14–18 start every building at maxHp (sim.ts building initialization;
 * SIM16 changed giant targeting, SIM17 clearance, SIM18 passive type admission).
 * Preserve only the isolated
 * worker or persisted outcome's own maxima. Historical formats need explicit
 * verification; never fill them from today's stat tables. */
const HEALTH_PROJECTION_SIM_VERSIONS: ReadonlySet<number> = new Set([14, 15, 16, 17, 18]);
export function replayBuildingHealth(simVersion: number, outcome: unknown): ReplayBuildingHealth[] | undefined {
  if (!HEALTH_PROJECTION_SIM_VERSIONS.has(simVersion) || !outcome || typeof outcome !== 'object') return undefined;
  const buildings = (outcome as { buildings?: unknown }).buildings;
  if (!Array.isArray(buildings)) return undefined;
  const seen = new Set<string>();
  return buildings.map((building: unknown) => {
    const value = z.object({ id: z.string().min(1), maxHp: z.number().int().nonnegative().safe() }).parse(building);
    if (seen.has(value.id)) throw new Error('Duplicate replay building health identity');
    seen.add(value.id);
    return { id: value.id, initialHp: value.maxHp, maxHp: value.maxHp };
  });
}

/** Settlement must never fail because this display projection is malformed:
 * the money path persists the outcome and simply omits the optional maxima,
 * which downstream readers already treat as unknown. Strict decoding stays for
 * archives, so a bad projection is reported instead of silently trusted. */
export function safeReplayBuildingHealth(
  simVersion: number, outcome: unknown,
  report: (reason: string) => void = (reason) => console.warn(`[replay-health] projection omitted: ${reason}`),
): ReplayBuildingHealth[] | undefined {
  try {
    return replayBuildingHealth(simVersion, outcome);
  } catch (error) {
    report(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/** Read only the optional frozen projection. Old summaries contain no maxima;
 * absence remains unknown and must never trigger a current-stat reconstruction. */
export function archivedBuildingHealth(archive: {
  simVersion: number; buildingHealth?: unknown;
}): ReplayBuildingHealth[] | undefined {
  if (!HEALTH_PROJECTION_SIM_VERSIONS.has(archive.simVersion) || archive.buildingHealth === undefined) return undefined;
  const values = z.array(ReplayBuildingHealthSchema).parse(archive.buildingHealth);
  if (new Set(values.map((value) => value.id)).size !== values.length) {
    throw new Error('Duplicate replay building health identity');
  }
  return values;
}
