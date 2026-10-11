import { test } from 'vitest';
import assert from 'node:assert/strict';
import { housingFractions, canAddTroop, trimDraft, commandTap, researchTap, revengeLook, scoutCommands, settlementRows } from './armyLogic.ts';

const h = (values = {}) => ({ready: 4, training: 2, draft: 1, capacity: 10, known: true, full: false, ...values});
test('the housing meter never overflows even when the server sends more than capacity', () => {
  assert.deepEqual(housingFractions(h({ready: 12})), {ready: 1, training: 0, draft: 0});
  const f = housingFractions(h({draft: 9})); assert.equal(f.ready + f.training + f.draft, 1);
});
test('unknown or zero capacity draws an empty track instead of a misleading fill', () => {
  for (const value of [h({known: false}), h({capacity: 0})]) assert.deepEqual(housingFractions(value), {ready: 0, training: 0, draft: 0});
});
test('the ARMY tab meter ignores the TRAIN draft', () => assert.equal(housingFractions(h(), false).draft, 0));
test('a troop fits the draft only while the camp has room for its housing points', () => {
  assert.equal(canAddTroop(h(), 3), true); assert.equal(canAddTroop(h(), 4), false);
  for (const value of [h({known: false}), h({full: true})]) assert.equal(canAddTroop(value, 1), false);
  assert.equal(canAddTroop(h(), 0), false);
});
test('saved armies are trimmed in order without changing the original draft', () => {
  const wanted = [{troop:'a', pts:2, count:3}, {troop:'b', pts:1, count:3}];
  assert.deepEqual(trimDraft(5, wanted), {kept:[{troop:'a', pts:2, count:2},{troop:'b', pts:1, count:1}], droppedTroops:3});
  assert.equal(wanted[0].count, 3);
});
test('CHECKING prices navigate to review and SHORT never spends', () => {
  assert.equal(commandTap({state:'ENABLED', price:{status:'CHECKING'}}), 'RUN');
  assert.equal(commandTap({state:'ENABLED', price:{status:'SHORT'}}), 'NEED_MORE');
  assert.equal(commandTap({state:'ENABLED', price:{status:'UNAVAILABLE'}}), 'EXPLAIN');
});
test('busy commands cannot be sent twice and locked commands explain', () => {
  assert.equal(commandTap({state:'BUSY', price:null}), 'IGNORE');
  assert.equal(commandTap({state:'LOCKED', price:null}), 'EXPLAIN');
});
test('research selects without starting and a busy Lab always explains', () => {
  assert.equal(researchTap('DEFAULT', false), 'SELECT'); assert.equal(researchTap('SHORT', false), 'NEED_MORE');
  assert.equal(researchTap('DEFAULT', true), 'BUSY'); assert.equal(researchTap('MAX', false), 'NONE');
});
test('one answer verb everywhere, ATTACK BACK draws the same red REVENGE', () => {
  for (const state of ['AVAILABLE','ATTACK_BACK']) assert.equal(revengeLook(state, 'IDLE', 'Rival').label, 'REVENGE');
});
test('a pressed REVENGE waits, a lost one keeps RETRY, a gated one says why', () => {
  assert.equal(revengeLook('AVAILABLE', 'BUSY', 'Rival').kind, 'BUSY');
  assert.deepEqual(revengeLook('AVAILABLE', 'CHECKING', 'Rival'), {kind:'RETRY', label:'RETRY', note:'Being checked'});
  assert.equal(revengeLook('AVAILABLE','IDLE','Rival','Shielded').note,'Shielded');
});
test('SKIP only exists on a matched base, and ATTACK is always last', () => {
  assert.deepEqual(scoutCommands('MATCH','HOME','SKIP','ATTACK'), ['HOME','SKIP','ATTACK']);
  for (const source of ['MAP','CAMPAIGN','REVENGE']) assert.deepEqual(scoutCommands(source,'HOME','SKIP','ATTACK'), ['HOME','ATTACK']);
});
test('unsettled and redacted results never expose projected loot as paid rewards', () => {
  for (const state of ['PENDING','REDACTED','FAILED']) assert.deepEqual(settlementRows(state,[{delta:'+8'}]), []);
  assert.deepEqual(settlementRows('SETTLED',[{delta:'+8'}]), [{delta:'+8'}]);
});
