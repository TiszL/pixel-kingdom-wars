/** D153.199 immutable mining input valuation and consistency; subpath-only.
 * This catalogue cannot debit inventory, grant eligibility or authorize rewards. */
import { z } from 'zod';
import { PHASE_E_MINING_CONTRIBUTION_V2 as POLICY, PHASE_E_ORDINARY_CRAFTING as CRAFT, PHASE_E_ORDINARY_CRAFTING_V2 as CRAFT_V2, PHASE_E_MINING_CONTRIBUTION_V3 as POLICY_V3, PHASE_E_POLICY } from './constants';
import { PHASE_E_RAW_RESOURCE_IDS, PositiveRawResourceQuantitySchema } from './phaseEResources';
import { ORDINARY_REFINED_IDS } from './phaseEOrdinaryCrafting';

export const MINING_CONTRIBUTION_RESOURCE_IDS = ['shards', ...PHASE_E_RAW_RESOURCE_IDS,
  ...ORDINARY_REFINED_IDS, 'navigation_kit', 'forge_ingot', 'crystal_fragment'] as const;
export const MINING_CONTRIBUTION_RESOURCE_IDS_V2 = MINING_CONTRIBUTION_RESOURCE_IDS;
export const MINING_CONTRIBUTION_RESOURCE_IDS_V3 = [...MINING_CONTRIBUTION_RESOURCE_IDS_V2, 'climate_kit', 'expedition_kit'] as const;
export const MiningContributionResourceSchema = z.enum(MINING_CONTRIBUTION_RESOURCE_IDS_V3);
export function miningContributionResourceIds(version: number) {
  if (version === POLICY.version) return MINING_CONTRIBUTION_RESOURCE_IDS_V2;
  if (version === POLICY_V3.version) return MINING_CONTRIBUTION_RESOURCE_IDS_V3;
  throw Error('Unsupported mining contribution policy');
}
export type MiningContributionResource = z.infer<typeof MiningContributionResourceSchema>;
export const MiningContributionLineSchema = z.object({ resourceId: MiningContributionResourceSchema,
  quantity: PositiveRawResourceQuantitySchema }).strict();
export type MiningContributionLine = z.infer<typeof MiningContributionLineSchema>;

export function miningResourceUnitValue(resourceId: MiningContributionResource, version: number): bigint {
  MiningContributionResourceSchema.parse(resourceId);
  if (!(miningContributionResourceIds(version) as readonly string[]).includes(resourceId)) throw Error('Resource is not admitted by mining policy');
  if (resourceId === 'shards') return BigInt(POLICY.shardsValue);
  if (resourceId === 'forge_ingot') return BigInt(POLICY.valuePerIngot);
  if (resourceId === 'crystal_fragment') return BigInt(POLICY.fragmentValue);
  const refined = BigInt(POLICY.rawValue) * BigInt(CRAFT.v1.refining.rawPerOutput) / BigInt(CRAFT.v1.refining.outputPerBatch);
  if (resourceId === 'climate_kit') return refined * BigInt(CRAFT_V2.climateKit.sunstoneBlocksPerOutput + CRAFT_V2.climateKit.embercorePerOutput)
    / BigInt(CRAFT_V2.climateKit.outputPerBatch);
  if (resourceId === 'expedition_kit') return (refined * BigInt(CRAFT_V2.expeditionKit.heartwoodBeamsPerOutput + CRAFT_V2.expeditionKit.thornsilkPerOutput)
    + BigInt(POLICY_V3.shardsValue) * BigInt(CRAFT_V2.expeditionKit.shardsPerOutput)) / BigInt(CRAFT_V2.expeditionKit.outputPerBatch);
  if (resourceId === 'navigation_kit') return refined * BigInt(CRAFT.v1.navigationKit.prismstoneLensPerOutput + CRAFT.v1.navigationKit.frostglassPerOutput)
    / BigInt(CRAFT.v1.navigationKit.outputPerBatch);
  if ((ORDINARY_REFINED_IDS as readonly string[]).includes(resourceId)) return refined;
  return BigInt(POLICY.rawValue);
}

/** Never round resource value through Number or silently combine duplicate lines. */
export function valueMiningContribution(lines: readonly MiningContributionLine[], version: number) {
  if (!lines.length || lines.length > miningContributionResourceIds(version).length
    || new Set(lines.map(line => line.resourceId)).size !== lines.length) throw Error('Invalid mining contribution basket');
  const valued = lines.map(line => {
    MiningContributionLineSchema.parse(line);
    const unitValue = miningResourceUnitValue(line.resourceId, version);
    return Object.freeze({ ...line, unitValue: String(unitValue), value: String(BigInt(line.quantity) * unitValue) });
  }).sort((a, b) => a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0);
  return Object.freeze({ policyVersion: version, lines: Object.freeze(valued),
    totalValue: String(valued.reduce((sum, line) => sum + BigInt(line.value), 0n)) });
}

function dayNumber(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw Error('Invalid mining activity day');
  const at = Date.parse(day + 'T00:00:00Z');
  if (!Number.isSafeInteger(at) || new Date(at).toISOString().slice(0, 10) !== day) throw Error('Invalid mining activity day');
  return at / POLICY.dayMs;
}

/** The authoritative reader must supply every day from identity coverage through
 * cutoff. Duplicate, unordered or missing days are errors, never free bonuses. */
export function miningConsistency(day: string, coverageFromDay: string,
  days: readonly { day: string; qualified: boolean }[]) {
  const cutoff = dayNumber(day), from = dayNumber(coverageFromDay);
  if (from > cutoff || days.length !== cutoff - from + 1) throw Error('Mining activity coverage incomplete');
  let qualifiedDays = 0;
  for (const [index, entry] of days.entries()) {
    const number = dayNumber(entry.day);
    if (number !== from + index || typeof entry.qualified !== 'boolean') throw Error('Mining activity coverage conflict');
    if (number > cutoff - POLICY.consistencyWindowDays && entry.qualified) qualifiedDays++;
  }
  const bonusBps = qualifiedDays * POLICY.consistencyBonusPerDayBps;
  return { qualifiedDays, bonusBps, multiplierBps: PHASE_E_POLICY.basisPoints + bonusBps };
}
