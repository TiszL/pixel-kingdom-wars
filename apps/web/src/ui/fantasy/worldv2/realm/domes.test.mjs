// Why (D-181, K-188): a rival drawn without his dome reads as open to attack while he is shielded, and the player's own
// fresh shield must show before the next feed poll. The feed's true always wins; the own read only adds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domeState, feedCarriesShield } from './domes.mjs';

test('a feed true always draws a dome, whatever the own base read says', () => {
  for (const own of [true, false, undefined]) for (const mine of [true, false]) assert.equal(domeState(true, own, mine), true, `own ${own} mine ${mine}`);
});

test('the own base read only adds a dome, and only to the own kingdom', () => {
  assert.equal(domeState(false, true, true), true, 'a shield the feed has not polled yet');
  assert.equal(domeState(undefined, true, true), true);
  assert.equal(domeState(false, true, false), false, 'a rival never takes the player\'s own read');
  assert.equal(domeState(false, false, true), false);
});

test('no field is unknown, never "open"; the chip waits for a read that carries the key', () => {
  assert.equal(domeState(undefined, undefined, false), undefined);
  assert.equal(domeState(undefined, false, true), undefined, 'a shield-less own read does not claim the feed said open');
  assert.equal(feedCarriesShield([{ tileId: 1 }, { tileId: 2, shielded: undefined }]), false);
  assert.equal(feedCarriesShield([{ tileId: 1 }, { tileId: 2, shielded: false }]), true);
  assert.equal(feedCarriesShield(null), false);
});
