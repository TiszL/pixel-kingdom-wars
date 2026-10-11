/** Current advanced appearance (unchanged parser) plus the SAME locked read's installed reservation identities.
 * Presentation freshness for native continuity only: no rewards, assets, balances, mint metadata or caller JSON. */
import { PhaseEVehicleFamilySchema, PhaseEVehicleTierSchema } from '@shardkeep/shared/phaseEVehicles';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DbTx } from '../db/client';
import { parseAdvancedServicePresentation, type AdvancedServicePresentation } from './advancedServicePresentation';

const Uuid = z.uuid().regex(/^[0-9a-f-]+$/);
export const AdvancedFleetIdentitySchema = z.object({
  version: z.literal(1),
  berths: z.array(z.object({
    buildingId: Uuid,
    installation: z.object({ installationId: Uuid, family: PhaseEVehicleFamilySchema, tier: PhaseEVehicleTierSchema }).strict().nullable(),
  }).strict()),
}).strict();
export type AdvancedFleetIdentity = z.infer<typeof AdvancedFleetIdentitySchema>;
const Combined = z.object({ appearance: z.unknown(), identity: z.unknown() }).strict();

export interface CurrentAdvancedIdentity {
  /** Byte-identical to the predecessor reader's appearance; null when the visual cutoff/source is unavailable. */
  presentation: AdvancedServicePresentation | null;
  /** Current-only sibling; null exactly when the appearance is null. */
  identity: AdvancedFleetIdentity | null;
}

/** Pure, strict: the identity must mirror the SAME visual projection — berth order, null pattern, family and tier — with distinct
 * real installation ids. Mandatory appearance corruption still throws through the unchanged parser. */
export function parseCurrentAdvancedIdentity(value: unknown, buildings: unknown): CurrentAdvancedIdentity {
  const combined = Combined.parse(value);
  const presentation = parseAdvancedServicePresentation(combined.appearance, buildings);
  if (presentation === null) {
    if (combined.identity !== null) throw new Error('Current advanced identity without an appearance');
    return { presentation: null, identity: null };
  }
  if (combined.identity === null) throw new Error('Current advanced appearance without its identity');
  const identity = AdvancedFleetIdentitySchema.parse(combined.identity);
  if (identity.berths.length !== presentation.berths.length) throw new Error('Current advanced identity differs from its appearance');
  const seen = new Set<string>();
  identity.berths.forEach((berth, index) => {
    const visual = presentation.berths[index]!;
    if (berth.buildingId !== visual.buildingId || (berth.installation === null) !== (visual.installation === null))
      throw new Error('Current advanced identity differs from its appearance');
    if (berth.installation === null || visual.installation === null) return;
    if (berth.installation.family !== visual.installation.family || berth.installation.tier !== visual.installation.tier)
      throw new Error('Current advanced identity differs from its appearance');
    if (seen.has(berth.installation.installationId)) throw new Error('Duplicate current advanced installation identity');
    seen.add(berth.installation.installationId);
  });
  return { presentation, identity };
}

/** ONE combined protected read inside the caller's player→base→slot transaction and cutoff. */
export async function readCurrentAdvancedIdentity(
  tx: DbTx, wallet: string, baseId: string, buildings: unknown, cutoff: Date,
): Promise<CurrentAdvancedIdentity> {
  if (!('rollback' in tx)) throw new Error('Current advanced identity requires a protected transaction');
  Uuid.parse(baseId);
  if (!Number.isFinite(+cutoff)) throw new Error('Invalid current advanced cutoff');
  const [row] = await tx.execute<{ value: unknown }>(sql`select public.shardkeep_advanced_identity_current(
    ${wallet}, ${baseId}::uuid, ${JSON.stringify(buildings)}::jsonb, ${cutoff.toISOString()}::timestamptz
  ) value`);
  return parseCurrentAdvancedIdentity(row?.value, buildings);
}
