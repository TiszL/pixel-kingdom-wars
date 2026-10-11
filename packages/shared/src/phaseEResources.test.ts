import { describe, expect, it } from 'vitest';
import { REALM_IDS } from './baseVisual';
import {
  PHASE_E_RAW_RESOURCE_IDS, PHASE_E_RAW_RESOURCES, PhaseERawResourceIdSchema,
  PositiveRawResourceQuantitySchema, RAW_RESOURCE_STORAGE_MAX, RawResourceQuantitySchema,
  RawResourceStockSchema,
} from './phaseEResources';

describe('E2 raw stock custody contract', () => {
  it('pins one accepted raw input per existing realm without admitting protected crafting items', () => {
    expect(Object.keys(PHASE_E_RAW_RESOURCES)).toEqual([...PHASE_E_RAW_RESOURCE_IDS]);
    expect(new Set(Object.values(PHASE_E_RAW_RESOURCES).map(resource => resource.realmId))).toEqual(new Set(REALM_IDS));
    expect(PHASE_E_RAW_RESOURCES.rough_prism.realmId).toBe('seeker-reach');
    for (const protectedItem of ['frostglass', 'forge_ingot', 'expedition_kit', 'crystal_fragment', 'powder_charge'])
      expect(PhaseERawResourceIdSchema.safeParse(protectedItem).success).toBe(false);
  });
  it.each(['-1', '+1', '01', '1.5', '1e3', ' 1', '1 ', '', 'NaN', 'Infinity',
    '0\n', '1\n', '1\r', '1\r\n', '1\u2028', '1\u2029', String(RAW_RESOURCE_STORAGE_MAX + 1n)])(
    'rejects %s instead of rounding, coercing or overflowing stock', value => {
      expect(RawResourceQuantitySchema.safeParse(value).success).toBe(false);
      expect(PositiveRawResourceQuantitySchema.safeParse(value).success).toBe(false);
      expect(RawResourceStockSchema.safeParse({ resourceId: 'frost_quartz', available: value, reserved: '0', total: value }).success).toBe(false);
    });
  it('preserves quantities above Number precision and the signed-bigint storage edge', () => {
    for (const value of ['0', '9007199254740993', String(RAW_RESOURCE_STORAGE_MAX)])
      expect(RawResourceQuantitySchema.parse(value)).toBe(value);
    expect(RawResourceQuantitySchema.safeParse(1).success).toBe(false);
    expect(PositiveRawResourceQuantitySchema.safeParse('0').success).toBe(false);
    expect(PositiveRawResourceQuantitySchema.parse('1')).toBe('1');
  });
  it('keeps reservations exposed and refuses an overflowed or hidden-stock total', () => {
    const stock = { resourceId: 'frost_quartz', available: '80', reserved: '20', total: '100' };
    expect(RawResourceStockSchema.parse(stock)).toEqual(stock);
    expect(RawResourceStockSchema.safeParse({ ...stock, total: '80' }).success).toBe(false);
    expect(RawResourceStockSchema.safeParse({ ...stock, available: String(RAW_RESOURCE_STORAGE_MAX), reserved: '1', total: String(RAW_RESOURCE_STORAGE_MAX) }).success).toBe(false);
    expect(RawResourceStockSchema.safeParse({ ...stock, currentOwner: 'injected' }).success).toBe(false);
  });
});
