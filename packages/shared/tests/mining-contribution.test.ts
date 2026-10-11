import { describe, expect, it } from 'vitest';
import { MINING_CONTRIBUTION_RESOURCE_IDS, miningConsistency, miningResourceUnitValue, valueMiningContribution } from '../src/miningContribution';
import { ordinaryCraftingRecipe, ORDINARY_RECIPE_IDS } from '../src/phaseEOrdinaryCrafting';

describe('D153.199 resource mining value', () => {
  it('accepts every admitted resource and keeps rare/refined stock distinct from raw counts', () => {
    const basket = valueMiningContribution(MINING_CONTRIBUTION_RESOURCE_IDS.map(resourceId => ({ resourceId, quantity: '1' })), 2);
    expect(basket.lines).toHaveLength(20);
    expect(basket.totalValue).toBe('30801');
    expect(miningResourceUnitValue('shards', 2)).toBe(1n);
    expect(miningResourceUnitValue('crown_iron_ore', 2)).toBe(100n);
    expect(miningResourceUnitValue('crownsteel', 2)).toBe(1000n);
    expect(miningResourceUnitValue('navigation_kit', 2)).toBe(2000n);
    expect(miningResourceUnitValue('forge_ingot', 2)).toBe(10000n);
    expect(miningResourceUnitValue('crystal_fragment', 2)).toBe(10000n);
  });
  it('cannot manufacture mining value by repeatedly refining or crafting a kit', () => {
    for (const recipeId of ORDINARY_RECIPE_IDS) {
      const recipe = ordinaryCraftingRecipe(recipeId, 1, 10);
      const input = valueMiningContribution(recipe.inputs.map(row => ({ resourceId: row.itemId, quantity: row.quantity })), 2);
      const output = valueMiningContribution([{ resourceId: recipe.output.itemId, quantity: recipe.output.quantity }], 2);
      expect(output.totalValue, recipeId).toBe(input.totalValue);
    }
  });
  it('keeps small inputs and full int64 quantities exact, without imposing a deed plateau', () => {
    const before = valueMiningContribution([{ resourceId: 'frost_quartz', quantity: '9223372036854775806' }], 2);
    const after = valueMiningContribution([{ resourceId: 'frost_quartz', quantity: '9223372036854775807' }], 2);
    expect(BigInt(after.totalValue) - BigInt(before.totalValue)).toBe(100n);
    expect(valueMiningContribution([{ resourceId: 'shards', quantity: '1' }], 2).totalValue).toBe('1');
  });
  it.each(['0', '-1', '1.0', '01', '1e3', '9223372036854775808'])('refuses noncanonical or out-of-storage-domain quantity %s', quantity => {
    expect(() => valueMiningContribution([{ resourceId: 'shards', quantity }], 2)).toThrow();
  });
  it('refuses duplicate inputs, currencies, equipment, client prices and unknown versions', () => {
    expect(() => valueMiningContribution([{ resourceId: 'shards', quantity: '1' }, { resourceId: 'shards', quantity: '2' }], 2)).toThrow();
    for (const resourceId of ['gems', 'keep', 'sol', 'navigation_compass', '__proto__']) {
      expect(() => valueMiningContribution([{ resourceId, quantity: '1' }] as never, 2)).toThrow();
    }
    expect(() => valueMiningContribution([{ resourceId: 'shards', quantity: '1', unitValue: '10000' }] as never, 2)).toThrow();
    expect(() => valueMiningContribution([{ resourceId: 'shards', quantity: '1' }], 1)).toThrow();
  });
});

describe('qualified daily consistency', () => {
  const day = (index: number) => `2020-01-${String(index).padStart(2, '0')}`;
  const history = (length: number) => Array.from({ length }, (_, i) => ({ day: day(i + 1), qualified: true }));
  it('builds per qualified day and remains bounded for ongoing participation', () => {
    expect(miningConsistency(day(1), day(1), history(1))).toEqual({ qualifiedDays: 1, bonusBps: 200, multiplierBps: 10200 });
    expect(miningConsistency(day(7), day(1), history(7)).multiplierBps).toBe(11400);
    expect(miningConsistency(day(14), day(1), history(14)).multiplierBps).toBe(12800);
    expect(miningConsistency(day(28), day(1), history(28)).multiplierBps).toBe(12800);
  });
  it('ages out missed days without erasing history or inventing daily activity', () => {
    const days = history(28).map((row, i) => ({ ...row, qualified: i < 14 }));
    expect(miningConsistency(day(15), day(1), days.slice(0, 15)).qualifiedDays).toBe(13);
    expect(miningConsistency(day(28), day(1), days).multiplierBps).toBe(10000);
  });
  it('refuses missing, duplicate, reversed and invalid calendar-day coverage', () => {
    expect(() => miningConsistency(day(3), day(1), history(3).slice(1))).toThrow();
    expect(() => miningConsistency(day(3), day(1), [history(3)[0]!, history(3)[0]!, history(3)[2]!])).toThrow();
    expect(() => miningConsistency(day(3), day(1), history(3).reverse())).toThrow();
    expect(() => miningConsistency('2020-02-30', day(1), [])).toThrow();
  });
});
