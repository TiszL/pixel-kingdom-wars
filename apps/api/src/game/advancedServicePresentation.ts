/** Current advanced appearance from accepted originals, never a clock-made return. */
import { BuildingType, PHASE_E_VEHICLES } from '@shardkeep/shared';
import { PhaseEVehicleFamilySchema, PhaseEVehicleTierSchema } from '@shardkeep/shared/phaseEVehicles';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DbTx } from '../db/client';
import { RaidAdvancedPresentationSchema, type RaidAdvancedPresentation } from './raidAdvancedPresentation';

const Uuid = z.uuid().regex(/^[0-9a-f-]+$/);
const Counter = z.string().max(19).regex(/^(0|[1-9][0-9]*)$/)
  .refine(value => BigInt(value) <= (1n << 63n) - 1n);
const Facts = z.object({
  version: z.literal(1),
  berths: z.array(z.object({
    buildingId: Uuid,
    installation: z.object({
      family: PhaseEVehicleFamilySchema,
      tier: PhaseEVehicleTierSchema,
      away: z.boolean(),
      completedTotal: Counter,
      allowanceStart: Counter,
    }).strict().nullable(),
  }).strict()),
}).strict();
const Buildings = z.array(z.object({
  id: Uuid, type: z.string(), level: z.number().int().nonnegative(),
  underConstruction: z.boolean().optional(),
}).passthrough());
export type AdvancedServicePresentation = RaidAdvancedPresentation;

export function parseAdvancedServicePresentation(value: unknown, buildings: unknown): AdvancedServicePresentation | null {
  if (value === null) return null;
  const facts = Facts.parse(value);
  const current = Buildings.parse(buildings);
  if (new Set(current.map(b => b.id)).size !== current.length) throw new Error('Duplicate current building identity');
  const berths = current.filter(b => b.type === BuildingType.Berth).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const allowance = BigInt(PHASE_E_VEHICLES.completedUsesPerInstall);
  const presentation = RaidAdvancedPresentationSchema.parse({
    version: 1,
    berths: facts.berths.map(b => {
      if (b.installation === null) return { buildingId: b.buildingId, installation: null };
      const { family, tier, away, completedTotal, allowanceStart } = b.installation;
      const used = BigInt(completedTotal) - BigInt(allowanceStart);
      if (used < 0n || used > allowance) throw new Error('Invalid current advanced allowance');
      return { buildingId: b.buildingId, installation: { family, tier,
        presence: away ? 'away' : used === allowance ? 'exhausted' : 'occupied' } };
    }),
  });
  if (berths.length !== presentation.berths.length || berths.some((b, i) => {
    const row = presentation.berths[i]!;
    return b.id !== row.buildingId || (row.installation !== null && (b.level < 1 || b.underConstruction === true));
  })) throw new Error('Current advanced presentation differs from its buildings');
  return presentation;
}

export async function readAdvancedServicePresentation(
  tx: DbTx, wallet: string, baseId: string, buildings: unknown, cutoff: Date,
): Promise<AdvancedServicePresentation | null> {
  if (!('rollback' in tx)) throw new Error('Current advanced presentation requires a protected transaction');
  Uuid.parse(baseId);
  if (!Number.isFinite(+cutoff)) throw new Error('Invalid current advanced cutoff');
  const [row] = await tx.execute<{ value: unknown }>(sql`select public.shardkeep_current_advanced_presentation(
    ${wallet}, ${baseId}::uuid, ${JSON.stringify(buildings)}::jsonb, ${cutoff.toISOString()}::timestamptz
  ) value`);
  return parseAdvancedServicePresentation(row?.value, buildings);
}
