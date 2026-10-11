/** Current/frozen base appearance grammar. This proves neither custody nor art readiness. */
import { z } from 'zod';
import { PHASE_E_BUILDINGS, STRUCTURES } from './constants';
import { BoundCosmeticAppearanceSchema } from './boundCosmeticApi';
import { BoundCosmeticIdSchema } from './phaseEBoundCosmetics';

const AwningOutputId = BoundCosmeticIdSchema.exclude(['aurora_wake']);
export type BoundCosmeticAwningId = z.infer<typeof AwningOutputId>;

export const BoundCosmeticBaseVisualV1Schema = z.object({
  version: z.literal(1),
  marketAwnings: z.array(z.object({
    buildingId: z.uuid().regex(/^[0-9a-f-]+$/),
    appearance: BoundCosmeticAppearanceSchema.refine(
      (value) => value.outputId !== 'aurora_wake', 'A base Market requires an Awning',
    ),
  }).strict()),
}).strict().refine(
  (value) => new Set(value.marketAwnings.map((entry) => entry.buildingId)).size === value.marketAwnings.length,
  'A Market may have only one Awning',
);
export type BoundCosmeticBaseVisualV1 = z.infer<typeof BoundCosmeticBaseVisualV1Schema>;

export const BoundCosmeticBaseReadSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('available'), visual: BoundCosmeticBaseVisualV1Schema }).strict(),
  z.object({ state: z.literal('unavailable'), visual: z.null() }).strict(),
]);
export type BoundCosmeticBaseRead = z.infer<typeof BoundCosmeticBaseReadSchema>;

/** Existing Market tier boundaries, without a second tuning table. */
export function boundCosmeticAwningForCompletedLevel(level: number): BoundCosmeticAwningId {
  if (!Number.isInteger(level) || level < 1 || level > STRUCTURES.market.maxLevel)
    throw new Error('Market completed level is invalid');
  const tier = Math.ceil(level / (STRUCTURES.market.maxLevel / PHASE_E_BUILDINGS.visualTiers));
  return AwningOutputId.parse(`artisan_market_awning_t${tier}`);
}

export interface BoundCosmeticVisualBuilding {
  readonly id: string;
  readonly type: string;
  /** Completed level, not an upgrade target. */
  readonly level: number;
  /** Initial build only, as in base.ts. An active upgrade does not set this flag. */
  readonly underConstruction: boolean;
}

/** Match against the same authoritative base or frozen snapshot as the projection. */
export function matchBoundCosmeticBaseVisual(
  raw: unknown, buildings: readonly BoundCosmeticVisualBuilding[],
): BoundCosmeticBaseVisualV1 {
  const visual = BoundCosmeticBaseVisualV1Schema.parse(raw);
  if (visual.marketAwnings.length === 0) return visual;
  const byId = new Map(buildings.map((building) => [building.id, building]));
  if (byId.size !== buildings.length) throw new Error('Authoritative building identity is ambiguous');
  for (const entry of visual.marketAwnings) {
    const building = byId.get(entry.buildingId);
    if (!building || building.type !== 'market' || building.underConstruction !== false)
      throw new Error('Awning does not name a completed Market');
    if (entry.appearance.outputId !== boundCosmeticAwningForCompletedLevel(building.level))
      throw new Error('Awning differs from the completed Market tier');
  }
  return visual;
}

/** Legacy absence uses ordinary art; unavailable must remain distinct from verified empty. */
export function matchBoundCosmeticBaseRead(
  raw: unknown, buildings: readonly BoundCosmeticVisualBuilding[],
): BoundCosmeticBaseRead | undefined {
  if (raw === undefined) return undefined;
  const read = BoundCosmeticBaseReadSchema.parse(raw);
  if (read.state === 'available') matchBoundCosmeticBaseVisual(read.visual, buildings);
  return read;
}
