/** D-153.123 advanced vehicle identities, deliberately subpath-only. A parsed
 * identity is data, not proof of registry membership, minting, ownership or burn.
 * The private server mint registry supplies family/tier; public requests cannot.
 * Starter boats and utility NFTs have separate lifecycles and are not admitted. */
import { z } from 'zod';
import { PHASE_E_VEHICLES } from './constants';

export const PHASE_E_VEHICLE_FAMILY_IDS = [
  'survey_balloon', 'cargo_cutter', 'courier_airship', 'expedition_barge',
] as const;
export const PhaseEVehicleFamilySchema = z.enum(PHASE_E_VEHICLE_FAMILY_IDS);
export type PhaseEVehicleFamily = z.infer<typeof PhaseEVehicleFamilySchema>;
export const PhaseEVehicleTierSchema = z.literal(PHASE_E_VEHICLES.tiers);
export type PhaseEVehicleTier = z.infer<typeof PhaseEVehicleTierSchema>;

// Canonical Solana public-key encoding bounds, not gameplay numbers. This
// follows the existing shared receipt schemas without importing a chain client.
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function address(value: string): boolean {
  if (value.length < 32 || value.length > 44 || value === '1'.repeat(32)) return false;
  let decoded = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return false;
    decoded = decoded * 58n + BigInt(digit);
  }
  let bytes = 0;
  while (decoded) { bytes++; decoded >>= 8n; }
  return bytes + (value.match(/^1*/)?.[0].length ?? 0) === 32;
}
const Address = z.string().max(44).refine(address, 'Expected a canonical nonzero Solana public key');
export const PhaseEVehicleMintIdentitySchema = z.object({
  assetId: Address,
  collection: Address,
  family: PhaseEVehicleFamilySchema,
  tier: PhaseEVehicleTierSchema,
}).strict().refine(value => value.assetId !== value.collection, 'Asset and collection must be distinct');
export type PhaseEVehicleMintIdentity = z.infer<typeof PhaseEVehicleMintIdentitySchema>;
