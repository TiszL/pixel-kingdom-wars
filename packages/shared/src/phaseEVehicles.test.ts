import { describe, expect, it } from 'vitest';
import { PHASE_E_VEHICLES } from './constants';
import { PHASE_E_VEHICLE_FAMILY_IDS, PhaseEVehicleFamilySchema, PhaseEVehicleTierSchema,
  PhaseEVehicleMintIdentitySchema } from './phaseEVehicles';

const assetId = '1'.repeat(31) + '2', collection = '1'.repeat(31) + '3';
const identity = { assetId, collection, family: 'survey_balloon', tier: 1 };

describe('advanced vehicle mint identity without activation authority', () => {
  it('pins the four owner-approved families separately from the free starter', () => {
    expect(PHASE_E_VEHICLE_FAMILY_IDS).toEqual(['survey_balloon', 'cargo_cutter', 'courier_airship', 'expedition_barge']);
    expect(PHASE_E_VEHICLES.advancedFamilyCount).toBe(4);
    expect(PHASE_E_VEHICLE_FAMILY_IDS).toHaveLength(PHASE_E_VEHICLES.advancedFamilyCount);
    expect(PHASE_E_VEHICLES.tiers).toEqual([1, 2, 3, 4]);
    expect(PHASE_E_VEHICLES.installationsPerFamilyPerBase).toBe(1);
    expect(PHASE_E_VEHICLES.installationsPerBaseMax).toBe(5);
    expect(PHASE_E_VEHICLES.completedUsesPerInstall).toBe(100);
  });

  it('admits all sixteen advanced family/tier combinations without replacing their identity', () => {
    const combinations = PHASE_E_VEHICLE_FAMILY_IDS.flatMap(family => PHASE_E_VEHICLES.tiers.map(tier => ({ ...identity, family, tier })));
    expect(combinations).toHaveLength(16);
    expect(new Set(combinations.map(v => `${v.family}:${v.tier}`)).size).toBe(16);
    for (const original of combinations) expect(PhaseEVehicleMintIdentitySchema.parse(original)).toEqual(original);
  });

  it('does not reinterpret the starter, utility NFTs, recovery actions or display names as advanced families', () => {
    for (const family of ['starter', 'starter_boat', 'stormwarden_relic', 'voyager_keepsake', 'recovery', 'repair_bundle',
      'Survey Balloon', 'survey-balloon', 'SURVEY_BALLOON', 'survey_balloon ', 'survey_balloon\n', '', null]) {
      expect(PhaseEVehicleFamilySchema.safeParse(family).success).toBe(false);
      expect(PhaseEVehicleMintIdentitySchema.safeParse({ ...identity, family }).success).toBe(false);
    }
  });

  it('requires an exact integer tier from the approved catalogue, without string or fractional coercion', () => {
    for (const tier of [0, -1, 5, 1.5, NaN, Infinity, '1', 'T1', true, null, undefined]) {
      expect(PhaseEVehicleTierSchema.safeParse(tier).success).toBe(false);
      expect(PhaseEVehicleMintIdentitySchema.safeParse({ ...identity, tier }).success).toBe(false);
    }
  });

  it('preserves valid leading-zero public keys and accepts canonical full-width keys', () => {
    expect(PhaseEVehicleMintIdentitySchema.parse(identity)).toEqual(identity);
    const fullWidth = { ...identity, assetId: 'So11111111111111111111111111111111111111112' };
    expect(PhaseEVehicleMintIdentitySchema.parse(fullWidth)).toEqual(fullWidth);
  });

  it('rejects absent, zero, noncanonical or wrong-width asset and collection keys rather than normalizing them', () => {
    for (const field of ['assetId', 'collection']) for (const key of ['', null, undefined, 1, '1'.repeat(32),
      '1'.repeat(30) + '2', '1'.repeat(32) + '2', 'z'.repeat(44), '0'.repeat(32), 'O'.repeat(32),
      assetId + '\n', assetId + '\r', assetId + '\u2028', ' ' + assetId, assetId + ' ']) {
      expect(PhaseEVehicleMintIdentitySchema.safeParse({ ...identity, [field]: key }).success).toBe(false);
    }
    expect(PhaseEVehicleMintIdentitySchema.safeParse({ ...identity, collection: assetId }).success).toBe(false);
  });

  it('requires every registry identity field and refuses authority or lifecycle fields even when false', () => {
    for (const field of Object.keys(identity)) {
      const incomplete: Record<string, unknown> = { ...identity }; delete incomplete[field];
      expect(PhaseEVehicleMintIdentitySchema.safeParse(incomplete).success).toBe(false);
    }
    for (const extra of [{ owner: assetId }, { wallet: assetId }, { burnVerified: true }, { installationAuthorized: false },
      { familyCount: 4 }, { uses: 100 }, { action: 'recovery' }, { version: 1 }, { mintSignature: 'caller-asserted' }]) {
      expect(PhaseEVehicleMintIdentitySchema.safeParse({ ...identity, ...extra }).success).toBe(false);
    }
    expect(Object.keys(PhaseEVehicleMintIdentitySchema.parse(identity)).sort()).toEqual(['assetId', 'collection', 'family', 'tier']);
  });
});
