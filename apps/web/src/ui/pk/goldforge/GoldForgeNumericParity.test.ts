import { expect, it } from 'vitest';
import { basketCount } from './GoldForgeLogic';
import type { SmeltTileUi } from './goldForgeModel';

// Kotlin's source function sums Int presentation values. These are representation
// boundaries, not game balances or limits; exact transport quantities stay outside it.
const tile = (chosen: number): SmeltTileUi => ({
  resourceId: 'fixture', icon: 'shards', have: '…', chosen, unitValue: '…', source: '',
});

it('basket count preserves the native Int sum at its representation boundary', () => {
  expect(basketCount([tile(2_147_483_647), tile(1)])).toBe(-2_147_483_648);
  expect(basketCount([tile(2_147_483_647), tile(2_147_483_647), tile(2)])).toBe(0);
  expect(basketCount([tile(-2_147_483_648), tile(1)])).toBe(1);
});
