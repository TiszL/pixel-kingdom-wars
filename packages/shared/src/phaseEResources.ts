/** E2 raw-stock identities and persistence wire domain only. No earning, pricing,
 * recipe, art admission or gameplay capability. Deliberately subpath-only.
 * Authority: native PHASE_E_DECISIONS.md@11504e2, accepted resource table.
 * `seeker-reach` is the existing stable ID displayed as Solana Reach. */
import { z } from 'zod';
import type { RealmId } from './baseVisual';

export const PHASE_E_RAW_RESOURCE_IDS = [
  'frost_quartz', 'heartwood_logs', 'sunstone_rubble', 'crown_iron_ore',
  'rough_prism', 'storm_ore', 'thorn_fibre', 'ember_nodules',
] as const;
export type PhaseERawResourceId = typeof PHASE_E_RAW_RESOURCE_IDS[number];
export const PhaseERawResourceIdSchema = z.enum(PHASE_E_RAW_RESOURCE_IDS);

export const PHASE_E_RAW_RESOURCES = {
  frost_quartz: { name: 'Frost Quartz', realmId: 'frostveil' },
  heartwood_logs: { name: 'Heartwood Logs', realmId: 'elderwood' },
  sunstone_rubble: { name: 'Sunstone Rubble', realmId: 'sunscar' },
  crown_iron_ore: { name: 'Crown Iron Ore', realmId: 'crownlands' },
  rough_prism: { name: 'Rough Prism', realmId: 'seeker-reach' },
  storm_ore: { name: 'Storm Ore', realmId: 'stormcairn' },
  thorn_fibre: { name: 'Thorn Fibre', realmId: 'thornwake' },
  ember_nodules: { name: 'Ember Nodules', realmId: 'cinderfall' },
} as const satisfies Record<PhaseERawResourceId, { name: string; realmId: RealmId }>;

/** PostgreSQL signed bigint domain, not a gameplay allowance or inventory cap. */
export const RAW_RESOURCE_STORAGE_MAX = 9223372036854775807n;
const canonicalQuantity = (value: string) => /^(0|[1-9][0-9]{0,18})$/.test(value)
  && BigInt(value) <= RAW_RESOURCE_STORAGE_MAX;
export const RawResourceQuantitySchema = z.string().refine(canonicalQuantity,
  'Expected a canonical nonnegative signed-int64 quantity');
export const PositiveRawResourceQuantitySchema = RawResourceQuantitySchema.refine(value => value !== '0',
  'A stock command must move a positive quantity');

/** Reservations remain Keep-exposed until actual consumption/settlement. A view
 * must never silently omit reserved stock from its total or round through Number. */
export const RawResourceStockSchema = z.object({
  resourceId: PhaseERawResourceIdSchema,
  available: RawResourceQuantitySchema,
  reserved: RawResourceQuantitySchema,
  total: RawResourceQuantitySchema,
}).strict().refine(value => [value.available, value.reserved, value.total].every(canonicalQuantity)
  && BigInt(value.available) + BigInt(value.reserved) === BigInt(value.total),
'Raw stock total must include the original reserved quantity');
export type RawResourceStock = z.infer<typeof RawResourceStockSchema>;
