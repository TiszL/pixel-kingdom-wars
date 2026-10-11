import { test } from 'vitest';
import assert from 'node:assert/strict';
import { landPaymentLine as refusalCopy } from './AccountLogic';
test('authoritative refusal copy normalizes a reason without punctuation',()=>{
 assert.equal(refusalCopy('REFUSED','  Realm is full  '),'Realm is full. Nothing was spent.');
});
test('authoritative refusal copy preserves existing terminal punctuation',()=>{
 assert.equal(refusalCopy('REFUSED','Try another realm!'),'Try another realm! Nothing was spent.');
});
import { primaryTap, shortAddress, settleLook, addKingdomSub, canUnlink, nameSaveEnabled, sortMembers, memberPowers, landPaymentLine, faucetLook } from './AccountLogic';
const price = (status: any, amount: string | null = null) => ({currency: 'SOL' as const, status, amount});
test('primary taps route short to need-more, locked to an explanation and busy to nothing', () => {
 assert.equal(primaryTap({state:'SHORT', reason:null}), 'NEED_MORE');
 assert.equal(primaryTap({state:'LOCKED', reason:'Wait'}), 'EXPLAIN');
 assert.equal(primaryTap({state:'BUSY', reason:null}), 'IGNORE');
});
test('addresses shorten to head and tail and unknown is an ellipsis', () => { assert.equal(shortAddress(null),'…'); assert.equal(shortAddress('123456789012'), '1234…9012'); });
test('settle stays enabled while the price is checking and shows an ellipsis, not zero', () => {
 const x = settleLook('Earth', 'NONE', price('CHECKING','0')); assert.equal(x.state,'ENABLED'); assert.match(x.sub!,/… SOL/);
 assert.equal(settleLook('Earth','NONE',price('UNAVAILABLE')).state,'DISABLED');
 assert.equal(settleLook('Earth','NONE',price('SHORT','2')).state,'SHORT');
});
test('a second land is called free only on a server zero', () => { assert.equal(addKingdomSub(price('SERVER_ZERO','0')),'Your second land is free'); assert.equal(addKingdomSub(price('CHECKING','0')),'Another land: … SOL'); });
test('the last sign-in method cannot be unlinked', () => { assert.equal(canUnlink({WALLET:true},'WALLET'),false);assert.equal(canUnlink({WALLET:true,EMAIL:true},'WALLET'),true); });
test('save name only for a real change and never twice', () => { assert.equal(nameSaveEnabled(' A ','A',false),false);assert.equal(nameSaveEnabled('B','A',true),false);assert.equal(nameSaveEnabled('B','A',false),true); });
test('members sort by trophies, wins or online first, unknown last', () => {const x=[{id:'a',trophies:null,wins:null,online:true},{id:'b',trophies:2,wins:1,online:false},{id:'c',trophies:2,wins:1,online:false}];assert.deepEqual(sortMembers(x,'TROPHIES').map(v=>v.id),['b','c','a']);assert.deepEqual(sortMembers(x,'ONLINE').map(v=>v.id),['a','b','c']);});
test('member powers follow the clan roles', () => {assert.deepEqual(memberPowers('ELDER',{role:'MEMBER',isYou:false}),{canPromote:true,canKick:false});assert.deepEqual(memberPowers('LEADER',{role:'LEADER',isYou:true}),{canPromote:false,canKick:false});});
test('a lost land payment answer is being checked and only a refusal says nothing was spent', () => {assert.doesNotMatch(landPaymentLine('CHECKING')!,/nothing was spent/i); assert.match(landPaymentLine('REFUSED')!,/Nothing was spent/);});
test('the faucet card follows the deed rule and honest outcomes', () => {assert.equal(faucetLook({state:'HIDDEN',amount:null}),null);assert.equal(faucetLook({state:'CHECKING',amount:null})?.button,'RECHECK');assert.doesNotMatch(faucetLook({state:'NEEDS_DEED',amount:null})!.headline,/1,000/);});


import { priceLabel } from './AccountLogic';
import type { PriceUi } from '../types';
test('unavailable account prices use explicit copy for absent or retained amounts in every currency', () => {
 const currencies: PriceUi['currency'][] = ['SHARDS', 'GEMS', 'KEEP', 'SKR', 'SOL', 'ITEM'];
 for (const currency of currencies) {
  for (const amount of [null, '', '   ', '0', '17']) {
   assert.equal(priceLabel({ currency, status: 'UNAVAILABLE', amount }), 'unavailable');
  }
 }
});
test('account price copy keeps checking, known amounts and explicit server zero distinct', () => {
 for (const amount of [null, '', '0', '17']) {
  assert.equal(priceLabel({ currency: 'SOL', status: 'CHECKING', amount }), '…');
 }
 for (const status of ['OK', 'SHORT'] as const) {
  for (const amount of [null, '', '   ']) {
   assert.equal(priceLabel({ currency: 'SOL', status, amount }), '…');
  }
  assert.equal(priceLabel({ currency: 'SOL', status, amount: '17' }), '17');
 }
 assert.equal(priceLabel({ currency: 'SOL', status: 'SERVER_ZERO', amount: '0' }), 'FREE');
});


test('a full realm with an unavailable price keeps its lock and shows no price fragment', () => {
 for (const amount of [null, '0', '17']) {
  const actual = settleLook('Earth', 'FULL', price('UNAVAILABLE', amount));
  assert.equal(actual.state, 'DISABLED');
  assert.equal(actual.reason, 'Earth is full right now');
  assert.equal(actual.sub, 'Land price unavailable right now');
 }
});
test('an SKR-locked realm with an unavailable price keeps its lock and shows no price fragment', () => {
 for (const amount of [null, '0', '17']) {
  const actual = settleLook('Seeker Reach', 'SKR_UNLOCK', price('UNAVAILABLE', amount));
  assert.equal(actual.state, 'LOCKED');
  assert.equal(actual.reason, 'Seeker tiles open with SKR');
  assert.equal(actual.sub, 'Land price unavailable right now');
 }
});
