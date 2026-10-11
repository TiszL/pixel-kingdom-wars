import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ingredientState, stepQuantity, ingotCastMax, submitNotice, craftGate, workshopDefaultTab, workshopTabs, marketTabs, collectionAction } from './craftLogic.ts';

test('unknown counts render as an ellipsis and are neither OK nor short', () => {
  assert.deepEqual(ingredientState(null, 4), {count:'…/4', missing:null, ok:false, short:false});
});
test('ingredients use available stock rather than total or reserved stock', () => {
  assert.deepEqual(ingredientState(2, 4), {count:'2/4',missing:2,ok:false,short:true});
  assert.equal(ingredientState(6,4).ok,true);
});
test('steppers clamp to the server limits', () => {
  assert.equal(stepQuantity(2, 5, 1, 4), 4); assert.equal(stepQuantity(2,-9,1,4),1);
  assert.equal(stepQuantity(2,1,1,0),1);
});
test('ingot casting respects today\'s cap and the holding room without inventing unknown values', () => {
  assert.equal(ingotCastMax(8,3,5),3); assert.equal(ingotCastMax(8,null,5),null); assert.equal(ingotCastMax(8,-1,5),0);
});
test('an uncertain request is being checked and never claims nothing was spent', () => {
  assert.match(submitNotice('CHECKING'), /being checked/); assert.doesNotMatch(submitNotice('CHECKING'), /Nothing was spent/);
  assert.match(submitNotice('REFUSED'), /Nothing was spent/); assert.equal(submitNotice('IDLE'),null);
});
test('pending recovery and sending block the primary even when a refresh fails', () => {
  assert.equal(craftGate('ERROR','CHECKING',true).action,'NONE');
  assert.equal(craftGate('READY','IDLE',true).action,'CHECK');
  assert.equal(craftGate('ERROR','IDLE',false).action,'RETRY');
  assert.equal(craftGate('READY','IDLE',false),null);
});
test('default tabs follow the SPEC priority and only offer available tabs', () => {
  const a=['REFINE','INGOTS','EQUIPMENT','COSMETICS'];
  assert.equal(workshopDefaultTab(true,'EQUIPMENT','COSMETICS',a),'INGOTS');
  assert.equal(workshopDefaultTab(false,'EQUIPMENT','COSMETICS',a),'EQUIPMENT');
  assert.equal(workshopDefaultTab(false,null,'COSMETICS',a),'COSMETICS');
  assert.equal(workshopDefaultTab(true,null,'COSMETICS',['REFINE']),'REFINE');
});
test('stacked tab labels fit and keep the registry ids', () => {
  assert.deepEqual(workshopTabs.map(t=>[t.id,t.label]), [['REFINE','REFINE'],['INGOTS','INGOTS'],['EQUIPMENT','TOOLS'],['COSMETICS','STYLE']]);
  assert.deepEqual(marketTabs.map(t=>t.id), ['BUY','SELL','MY ORDERS','COLLECTION']);
});
test('a countdown never claims done before the server does', () => {
  assert.equal(collectionAction({mode:'AUTO',state:'WORKING',id:'job',receiptId:null}),'NONE');
  assert.equal(collectionAction({mode:'SERVER',state:'WORKING',id:'job',receiptId:null}),'NONE');
});
test('an arrived haul is acknowledged client-side even on a read-only base', () => {
  assert.equal(collectionAction({mode:'AUTO',state:'DELIVERED',id:'job',receiptId:null}),'MARK_SEEN');
});
test('ingots collect through the receipt sequence and cannot collect twice', () => {
  assert.equal(collectionAction({mode:'SERVER',state:'READY',id:'job',receiptId:null}),'REVIEW_COLLECTION');
  assert.equal(collectionAction({mode:'SERVER',state:'COLLECTING',id:'job',receiptId:null}),'NONE');
  assert.equal(collectionAction({mode:'SERVER',state:'DELIVERED',id:'job',receiptId:null}),'NONE');
  assert.equal(collectionAction({mode:'SERVER',state:'DELIVERED',id:'job',receiptId:'receipt'}),'CELEBRATE');
});
