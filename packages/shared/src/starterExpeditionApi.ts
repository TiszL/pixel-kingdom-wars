import {EquipmentSecondaryOutputSchema,EquipmentFittingSchema,EquipmentFittingSnapshotSchema,equipmentFittingMatches,fittingSelection,applyEquipmentFitting,withoutEquipmentFitting} from './phaseEOrdinaryEquipment';
/** D153.31 public starter routes and immutable departure/return proofs. Lazy only. */
import { z } from 'zod';
import { REALM_IDS } from './baseVisual';
import { StarterRouteIdSchema, StarterRoutePreviewSchema, starterRoutePreview } from './phaseEExpeditions';
import { PHASE_E_RAW_RESOURCE_IDS, PHASE_E_RAW_RESOURCES, PhaseERawResourceIdSchema,
  PositiveRawResourceQuantitySchema, RawResourceQuantitySchema, RawResourceStockSchema } from './phaseEResources';
import { StarterFleetInstallationSchema } from './starterFleetApi';
import { PaidStarterExpeditionRouteSnapshotSchema, paidStarterRouteAtDeparture } from './paidStarterExpeditions';

export const STARTER_EXPEDITION_FEATURE = { version: 1, receipts: 1 } as const;
export const StarterExpeditionUuidSchema = z.uuid().regex(/^[0-9a-f-]+$/);
const Timestamp = z.iso.datetime().refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
const Wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const Version = z.number().int().positive().max(2_147_483_647);
const RouteId = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/);
export const StarterExpeditionRequestSchema = z.object({ idempotencyKey: StarterExpeditionUuidSchema,
  baseId: StarterExpeditionUuidSchema, installationId: StarterExpeditionUuidSchema,
  routeId: RouteId, routeVersion: Version, rewardVersion: Version, fitting: EquipmentFittingSchema.optional() }).strict();
export type StarterExpeditionRequest = z.infer<typeof StarterExpeditionRequestSchema>;
// Historical formats copied from the original stored proof parser, independent
// of today's route amounts/versions. A stripped common marker is never HOME.
const historicalRouteFields = z.object({ routeCatalogueVersion: Version, rewardTableVersion: Version,
  routeId: RouteId, realmId: z.enum(REALM_IDS), resourceId: PhaseERawResourceIdSchema,
  vehicleFamily: z.literal('starter'), fitting: EquipmentFittingSnapshotSchema.optional(), secondaryOutput:EquipmentSecondaryOutputSchema.optional(), durationSec: z.number().int().positive().safe(),
  grossQuantity: PositiveRawResourceQuantitySchema, netQuantity: RawResourceQuantitySchema, islandPoolQuantity: RawResourceQuantitySchema,
}).strict();
export const StarterExpeditionRouteSnapshotSchema = z.union([
  historicalRouteFields.refine(route => !route.routeId.startsWith('common_') && !route.routeId.startsWith('paid_')),
  historicalRouteFields.extend({ routeCatalogueVersion: z.literal(2), rewardTableVersion: z.literal(2),
    access: z.object({ kind: z.literal('starter_common'), policyVersion: z.literal(1) }).strict(),
  }).strict().refine(route => route.routeId === `common_${route.realmId.replaceAll('-', '_')}`
    && PHASE_E_RAW_RESOURCES[route.resourceId].realmId === route.realmId),
  PaidStarterExpeditionRouteSnapshotSchema,
]).refine(equipmentFittingMatches).refine(route => [route.netQuantity, route.islandPoolQuantity, route.grossQuantity]
  .every(value => value.length <= 19 && RawResourceQuantitySchema.safeParse(value).success)
  && BigInt(route.netQuantity) + BigInt(route.islandPoolQuantity) === BigInt(route.grossQuantity), 'Original gross must equal net plus tax');
const trip = { expeditionId: StarterExpeditionUuidSchema, installationId: StarterExpeditionUuidSchema,
  route: StarterExpeditionRouteSnapshotSchema, departedAt: Timestamp, returnsAt: Timestamp,
  termId: StarterExpeditionUuidSchema, termHash: z.string().regex(/^[0-9a-f]{64}$/) };
const chronology = (v: { route: z.infer<typeof StarterExpeditionRouteSnapshotSchema>; departedAt: string; returnsAt: string }) =>
  Date.parse(v.returnsAt) - Date.parse(v.departedAt) === v.route.durationSec * 1_000
  && paidStarterRouteAtDeparture(v.route, v.departedAt);
export const StarterExpeditionFlightSchema = z.object(trip).strict().refine(chronology, 'Flight differs from original duration');
export const StarterExpeditionReceiptSchema = z.object({ ...trip, wallet: Wallet, request: StarterExpeditionRequestSchema,
}).strict().refine(v => chronology(v) && v.expeditionId === v.request.idempotencyKey && v.installationId === v.request.installationId
  && v.route.routeId === v.request.routeId && v.route.routeCatalogueVersion === v.request.routeVersion
  && JSON.stringify(fittingSelection(v.route).fitting) === JSON.stringify(v.request.fitting)
  && v.route.rewardTableVersion === v.request.rewardVersion && paidStarterRouteAtDeparture(v.route, v.departedAt, v.wallet), 'Departure differs from original request');
export type StarterExpeditionReceipt = z.infer<typeof StarterExpeditionReceiptSchema>;
const envelope = { wallet: Wallet, idempotencyKey: StarterExpeditionUuidSchema, serverNow: Timestamp };
export const StarterExpeditionEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ ...envelope, status: z.literal('unknown'), receipt: z.null(), return: z.null() }).strict(),
  z.object({ ...envelope, status: z.literal('accepted'), receipt: StarterExpeditionReceiptSchema,
    return: z.object({ returnId: StarterExpeditionUuidSchema, returnedAt: Timestamp,secondaryOutput:EquipmentSecondaryOutputSchema.optional() }).strict().nullable() }).strict(),
]).refine(v => v.status === 'unknown' || v.wallet === v.receipt.wallet && v.idempotencyKey === v.receipt.request.idempotencyKey
  && (v.return === null || Date.parse(v.return.returnedAt) >= Date.parse(v.receipt.returnsAt) && JSON.stringify(v.return.secondaryOutput)===JSON.stringify(v.receipt.route.secondaryOutput)), 'Envelope differs from original actor/key/return');
export type StarterExpeditionEnvelope = z.infer<typeof StarterExpeditionEnvelopeSchema>;
export const StarterExpeditionHomeSchema = z.object({
  source: z.enum(['free_assignment', 'deed_location', 'free_policy_preview']), version: Version, realmId: z.enum(REALM_IDS),
}).strict();
/** Explicit current fitted previews. Removing the fitting must recover today's
 * complete policy; historical receipts alone never authorize a fresh quote. */
export const StarterEquipmentRoutePreviewSchema = z.object({...StarterRoutePreviewSchema.shape,
  fitting: EquipmentFittingSnapshotSchema.optional(), secondaryOutput:EquipmentSecondaryOutputSchema.optional(),
}).strict().refine(v => StarterRoutePreviewSchema.safeParse(withoutEquipmentFitting(v)).success && equipmentFittingMatches(v));
export function starterEquipmentRoutes(home: z.infer<typeof StarterExpeditionHomeSchema>, fitting: z.infer<typeof EquipmentFittingSchema>) {
  return StarterRouteIdSchema.options.flatMap(id => {
    const route = starterRoutePreview(home.realmId, id);
    try { return [applyEquipmentFitting(route, fitting)]; } catch { return []; }
  });
}
export const StarterExpeditionViewSchema = z.object({ wallet: Wallet, baseId: StarterExpeditionUuidSchema,
  serverNow: Timestamp, features: z.object({ starterExpeditions: z.object({ version: z.literal(1), receipts: z.literal(1) }).strict() }).strict(),
  acceptingDepartures: z.boolean(), home: StarterExpeditionHomeSchema.nullable(), routes: z.array(StarterEquipmentRoutePreviewSchema), fitting: EquipmentFittingSchema.optional(),
  installation: StarterFleetInstallationSchema.nullable(), flight: StarterExpeditionFlightSchema.nullable(),
  lodgeCompletedAt: Timestamp.nullable(), rawStock: z.array(RawResourceStockSchema),
}).strict().refine(v => {
  if (v.rawStock.length !== PHASE_E_RAW_RESOURCE_IDS.length
    || !PHASE_E_RAW_RESOURCE_IDS.every(id => v.rawStock.filter(s => s.resourceId === id).length === 1)
    || v.installation !== null && v.installation.baseId !== v.baseId
    || v.lodgeCompletedAt !== null && Date.parse(v.lodgeCompletedAt) > Date.parse(v.serverNow)
    || v.flight !== null && (v.installation === null || v.flight.installationId !== v.installation.installationId
      || Date.parse(v.flight.returnsAt) <= Date.parse(v.serverNow))) return false;
  if (v.home === null) return v.routes.length === 0;
  const expected = v.fitting ? starterEquipmentRoutes(v.home, v.fitting).map(r => r.routeId) : StarterRouteIdSchema.options;
  return v.routes.length === expected.length
    && expected.every(id => v.routes.filter(r => r.routeId === id).length === 1)
    && v.routes.every(r => JSON.stringify(fittingSelection(r).fitting) === JSON.stringify(v.fitting)
      && (r.access?.kind === 'starter_common' || r.realmId === v.home!.realmId));
}, 'Current expedition view must describe one complete authorized settled snapshot');
export type StarterExpeditionView = z.infer<typeof StarterExpeditionViewSchema>;
export function matchStarterExpeditionEnvelope(raw: unknown, wallet: string, original: StarterExpeditionRequest): StarterExpeditionEnvelope {
  const request = StarterExpeditionRequestSchema.parse(original), proof = StarterExpeditionEnvelopeSchema.parse(raw);
  if (proof.wallet !== wallet || proof.idempotencyKey !== request.idempotencyKey
    || proof.status === 'accepted' && JSON.stringify(proof.receipt.request) !== JSON.stringify(request)) throw new Error('Expedition proof differs from original command');
  return proof;
}
