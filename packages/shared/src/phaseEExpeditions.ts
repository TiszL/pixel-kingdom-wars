/** Current starter HOME and explicit common route previews only. A selected realm is not access
 * evidence. This subpath grants no dispatch, stock, fleet or term capability.
 * Never use its current-table parser for historical accepted-trip receipts. */
import { z } from 'zod';
import { REALM_IDS, type RealmId } from './baseVisual';
import { PHASE_E_STARTER_ROUTES as CATALOGUE } from './constants';
import { splitResourceEarnings } from './phaseEResourceTax';
import {
  PHASE_E_RAW_RESOURCE_IDS, PHASE_E_RAW_RESOURCES, PhaseERawResourceIdSchema,
  RawResourceQuantitySchema, type PhaseERawResourceId,
} from './phaseEResources';

export const StarterHomeRouteIdSchema = z.enum(['introduction', 'coastal_survey', 'long_survey']);
export const StarterCommonRouteIdSchema = z.enum(['common_frostveil', 'common_elderwood', 'common_sunscar',
  'common_crownlands', 'common_seeker_reach', 'common_stormcairn', 'common_thornwake', 'common_cinderfall']);
export const StarterRouteIdSchema = z.enum([...StarterHomeRouteIdSchema.options, ...StarterCommonRouteIdSchema.options]);
export type StarterRouteId = z.infer<typeof StarterRouteIdSchema>;
const RealmIdSchema = z.enum(REALM_IDS);

export interface StarterRoutePreview {
  routeCatalogueVersion: number;
  rewardTableVersion: number;
  routeId: StarterRouteId;
  realmId: RealmId;
  resourceId: PhaseERawResourceId;
  vehicleFamily: 'starter';
  access?: { kind: 'starter_common'; policyVersion: number };
  durationSec: number;
  grossQuantity: string;
  islandPoolQuantity: string;
  netQuantity: string;
}

export function starterRoutePreview(realmId: RealmId, routeId: StarterRouteId): StarterRoutePreview {
  RealmIdSchema.parse(realmId);
  StarterRouteIdSchema.parse(routeId);
  const common = StarterCommonRouteIdSchema.safeParse(routeId);
  const destination = common.success ? CATALOGUE.commonV1.routes[common.data] : realmId;
  const resourceId = PHASE_E_RAW_RESOURCE_IDS.find(id => PHASE_E_RAW_RESOURCES[id].realmId === destination);
  if (!resourceId) throw new Error('Home realm has no accepted raw resource');
  const route = common.success ? CATALOGUE.commonV1 : CATALOGUE.routes[StarterHomeRouteIdSchema.parse(routeId)];
  const gross = BigInt(route.grossRaw);
  const split = splitResourceEarnings(gross, 0n);
  // This intentionally refuses new tuning that needs fractional attribution.
  // An existing generic-source carry would be preserved, not reset, by these trips.
  if (split.nextCarry !== 0n) throw new Error('Starter route requires exact whole-resource tax');
  return {
    routeCatalogueVersion: CATALOGUE.routeCatalogueVersion,
    rewardTableVersion: CATALOGUE.rewardTableVersion,
    ...(common.success ? { access: { kind: 'starter_common' as const, policyVersion: CATALOGUE.commonV1.accessPolicyVersion } } : {}),
    routeId, realmId: destination, resourceId, vehicleFamily: 'starter', durationSec: route.durationSec,
    grossQuantity: gross.toString(), islandPoolQuantity: split.tax.toString(), netQuantity: split.net.toString(),
  };
}

/** Strict CURRENT preview validation. Future acceptance also needs authenticated
 * home, installed berth/vehicle, server time and genuine island-term evidence. */
export const StarterRoutePreviewSchema = z.object({
  routeCatalogueVersion: z.literal(CATALOGUE.routeCatalogueVersion),
  rewardTableVersion: z.literal(CATALOGUE.rewardTableVersion),
  routeId: StarterRouteIdSchema,
  realmId: RealmIdSchema,
  resourceId: PhaseERawResourceIdSchema,
  vehicleFamily: z.literal('starter'),
  access: z.object({ kind: z.literal('starter_common'), policyVersion: z.literal(CATALOGUE.commonV1.accessPolicyVersion) }).strict().optional(),
  durationSec: z.number().int().positive().safe(),
  grossQuantity: RawResourceQuantitySchema,
  islandPoolQuantity: RawResourceQuantitySchema,
  netQuantity: RawResourceQuantitySchema,
}).strict().refine(preview => {
  const expected = starterRoutePreview(preview.realmId, preview.routeId);
  return preview.realmId === expected.realmId && preview.access?.kind === expected.access?.kind
    && preview.access?.policyVersion === expected.access?.policyVersion && preview.resourceId === expected.resourceId && preview.durationSec === expected.durationSec
    && preview.grossQuantity === expected.grossQuantity && preview.islandPoolQuantity === expected.islandPoolQuantity
    && preview.netQuantity === expected.netQuantity;
}, 'Preview must match the current route, access policy and reward table');
