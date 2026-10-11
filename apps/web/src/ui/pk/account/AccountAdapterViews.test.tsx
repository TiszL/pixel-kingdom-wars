// @vitest-environment happy-dom
import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AccountLandAdapter, AccountKingdomsAdapter } from './AccountAdapterViews';
import type { LandAdapterInput, KingdomsAdapterInput } from './accountAdapters';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root|undefined;
function render(node:React.ReactNode){const el=document.createElement('div');document.body.append(el);act(()=>{root=createRoot(el);root.render(node);});}
function click(label:string){const b=[...document.querySelectorAll('button')].find(x=>(x.textContent??'').includes(label));assert.ok(b);act(()=>b.dispatchEvent(new MouseEvent('click',{bubbles:true})));}
afterEach(()=>{act(()=>root?.unmount());root=undefined;document.body.replaceChildren();});
const input=():LandAdapterInput=>({entry:{phase:'idle',error:null,reservation:null,paymentSignature:null},kind:'entry',walletLinked:true,entryPaid:false,actionsEnabled:true,serverOffReason:null,quotedPrice:{currency:'SOL',amount:null,status:'CHECKING'},formatReservedLamports:String});
test('land adapter renders the authoritative unknown price and emits navigation once',()=>{
 const onIntent=vi.fn();render(<AccountLandAdapter input={input()} onIntent={onIntent}/>);assert.match(document.body.textContent??'',/…/);click('CHOOSE REALM');assert.deepEqual(onIntent.mock.calls,[[{id:'land.choose',kind:'navigate'}]]);
});
test('confirming land adapter cannot emit a second payment',()=>{
 const x=input();x.entry.phase='confirming';const onIntent=vi.fn();render(<AccountLandAdapter input={x} onIntent={onIntent}/>);click('CHECKING PAYMENT');assert.equal(onIntent.mock.calls.length,0);assert.match(document.body.textContent??'',/checking your payment/i);
});
test('failed land adapter exposes history while retaining the server error',()=>{
 const x=input();x.entry.phase='failed';x.entry.error='Needs support';const onIntent=vi.fn();render(<AccountLandAdapter input={x} onIntent={onIntent}/>);click('PAYMENT HISTORY');assert.deepEqual(onIntent.mock.calls,[[{id:'land.history',kind:'navigate'}]]);assert.match(document.body.textContent??'',/Needs support/);
});
test('KINGDOMS adapter keeps unavailable data explicit without an invented free quote',()=>{
 const x:KingdomsAdapterInput={wallet:'wallet',entryPaid:null,directory:null,selectedBaseId:null,loading:false,busy:false,error:'Ownership unavailable',realmLabel:()=>'',freePurchase:{actionsAllowed:false,refreshError:null,snapshot:null,state:{loaded:true,busy:false,journal:null,review:null,error:null}}};
 render(<AccountKingdomsAdapter input={x} onIntent={vi.fn()}/>);assert.match(document.body.textContent??'',/Unable to load/);assert.doesNotMatch(document.body.textContent??'',/second land is free|0 SOL/);
});

function refused():KingdomsAdapterInput{return {wallet:'wallet',entryPaid:null,directory:null,selectedBaseId:null,loading:false,busy:false,error:null,realmLabel:()=>'',freePurchase:{actionsAllowed:false,refreshError:null,snapshot:null,state:{loaded:true,busy:false,error:null,review:null,journal:{version:1,identity:{origin:'https://game.example',api:'https://api.example',cluster:'devnet',wallet:'wallet'},revision:1,archives:[],operation:{command:{request:{sourceBaseId:'base',idempotencyKey:'original-key'},terms:{} as never},attemptRevision:1,proof:null,refusal:{phase:'first_post',status:422,code:'INSUFFICIENT_SHARDS'}}}}}};}
test('KINGDOMS archive is a confirm intent and does not replace saved-request recovery',()=>{
 const onIntent=vi.fn();render(<AccountKingdomsAdapter input={refused()} onIntent={onIntent}/>);click('ARCHIVE REFUSAL');click('CHECK SAVED REQUEST');
 assert.deepEqual(onIntent.mock.calls,[[{id:'kingdom.purchase.archive',kind:'confirm'}],[{id:'kingdom.purchase.recover',kind:'recover'}]]);assert.match(document.body.textContent??'',/INSUFFICIENT_SHARDS/);
});
test('KINGDOMS unsent draft discard emits a confirm-class intent for the host Seal',()=>{
 const x=refused();x.freePurchase.state.journal!.operation!.refusal=null;x.freePurchase.state.journal!.operation!.attemptRevision=null;const onIntent=vi.fn();
 render(<AccountKingdomsAdapter input={x} onIntent={onIntent}/>);click('DISCARD UNSENT REQUEST');assert.deepEqual(onIntent.mock.calls,[[{id:'kingdom.purchase.abandon',kind:'confirm'}]]);
});
