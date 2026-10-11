/** Transient committed-response presentation only. A parsed shape does not prove
 * a new journey event; producers must supply actual insert/settlement provenance.
 * Never persist these callbacks as base state or derive them from elapsed time. */
import { z } from 'zod';
import { BoundCosmeticWakeCaptureSchema } from './boundCosmeticWakePresentation';
import { PhaseEVehicleFamilySchema, PhaseEVehicleTierSchema } from './phaseEVehicles';

const Uuid = z.uuid().regex(/^[0-9a-f-]+$/);
const Timestamp = z.iso.datetime().refine(value => Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value);
const Vehicle = z.union([
  z.object({ family: z.literal('starter') }).strict(),
  z.object({ family: PhaseEVehicleFamilySchema, tier: PhaseEVehicleTierSchema }).strict(),
]);
const common = {
  version: z.literal(1), baseId: Uuid, berthId: Uuid, installationId: Uuid,
  expeditionId: Uuid, at: Timestamp, vehicle: Vehicle, wake: BoundCosmeticWakeCaptureSchema,
};

export const FleetJourneyEventSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('departure') }).strict(),
  z.object({ ...common, kind: z.literal('return'), returnId: Uuid }).strict(),
]);
export type FleetJourneyEvent = z.infer<typeof FleetJourneyEventSchema>;

export function fleetJourneyEventKey(event: FleetJourneyEvent): string {
  // Starter and advanced originals live in separate identity domains.
  return `${event.kind}:${event.vehicle.family}:${event.kind === 'return' ? event.returnId : event.expeditionId}`;
}

export const FleetJourneyEventBatchSchema = z.object({
  version: z.literal(1), events: z.array(FleetJourneyEventSchema),
}).strict().refine(value => new Set(value.events.map(fleetJourneyEventKey)).size === value.events.length,
  'Duplicate journey event');
export type FleetJourneyEventBatch = z.infer<typeof FleetJourneyEventBatchSchema>;

export function matchFleetJourneyEventBatch(raw: unknown, baseId: string): FleetJourneyEventBatch {
  const expected = Uuid.parse(baseId), batch = FleetJourneyEventBatchSchema.parse(raw);
  if (batch.events.some(event => event.baseId !== expected)) throw Error('Journey event belongs to another base');
  return batch;
}
