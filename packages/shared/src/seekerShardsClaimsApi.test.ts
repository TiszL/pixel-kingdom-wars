import { describe, expect, it } from 'vitest';
import fixture from './testFixtures/seekerShardsClaimsApi.json';
import {PHASE_E_POLICY} from './constants';
import { SeekerShardsClaimRequestSchema, SeekerShardsClaimReceiptSchema, SeekerShardsEntitlementViewSchema, matchSeekerShardsClaimEnvelope,
 matchSeekerShardsClaimReceipt, matchSeekerShardsEntitlementView } from './seekerShardsClaimsApi';
const wallet='11111111111111111111111111111111', other='11111111111111111111111111111112';
const id='10000000-0000-4000-8000-000000000001', base='20000000-0000-4000-8000-000000000001', term='30000000-0000-4000-8000-000000000001';
const request={idempotencyKey:id,baseId:base,termId:term,spotId:0};
const receipt={...request,id,wallet,termHash:'a'.repeat(64),winnerCount:3,poolTotal:'8',previousTotal:'1',cumulativeTotal:'2',quantity:'1',balanceBefore:'4',balanceAfter:'5',claimedAt:'2026-09-25T00:00:00.000Z',currency:'SHARDS' as const,ledgerTransactionId:'40000000-0000-4000-8000-000000000001'};
const row={termId:term,termHash:receipt.termHash,startsAt:'2026-09-18T00:00:00.000Z',endsAt:'2026-09-25T00:00:00.000Z',spotId:0,winnerCount:3,poolTotal:'8',cumulativeTotal:'2',claimedTotal:'1',dueQuantity:'1'};
const view={version:1 as const,wallet,claimsEnabled:false,currency:'SHARDS' as const,status:'available' as const,reason:null,cursor:null,nextCursor:term,rows:[row]};
describe('original Seeker SHARDS claim wire contract',()=>{
 it('pins the portable public receipt fixture to the request and entitlement arithmetic',()=>{
  expect(fixture.policy).toEqual({totalSpots:PHASE_E_POLICY.seekerIsland.totalSpots,operatingTermSec:PHASE_E_POLICY.seekerIsland.operatingTermSec});
  expect(fixture.request).toEqual(request);
  expect(matchSeekerShardsClaimEnvelope(fixture.envelope,wallet,request)).toEqual({wallet,receipt});
  expect(matchSeekerShardsEntitlementView(fixture.entitlements,wallet)).toEqual(view);
 });
 it('never accepts client amounts, tax or source authority in a claim request',()=>{
  expect(SeekerShardsClaimRequestSchema.parse(request)).toEqual(request);
  for(const patch of [{quantity:'1'},{poolTotal:'8'},{winnerCount:3},{wallet},{termHash:'a'.repeat(64)},{ledgerTransactionId:id}])expect(SeekerShardsClaimRequestSchema.safeParse({...request,...patch}).success).toBe(false);
 });
 it('accepts exact conserved receipt and wallet/body-bound recovery',()=>{
  expect(matchSeekerShardsClaimReceipt(receipt,wallet,request)).toEqual(receipt);
  expect(matchSeekerShardsClaimEnvelope({wallet,receipt},wallet,request)).toEqual({wallet,receipt});
  expect(matchSeekerShardsClaimEnvelope({wallet,receipt:null},wallet,request).receipt).toBeNull();
 });
 it('rejects wrong authenticated recipient, changed retry body and envelope substitution',()=>{
  expect(()=>matchSeekerShardsClaimReceipt(receipt,other,request)).toThrow();
  expect(()=>matchSeekerShardsClaimReceipt(receipt,wallet,{...request,spotId:20})).toThrow();
  expect(()=>matchSeekerShardsClaimEnvelope({wallet:other,receipt},other,request)).toThrow();
 });
 it('rejects invented shares, stock effects, counter regressions and noncanonical bounded quantities',()=>{
  for(const patch of [{quantity:'2'},{poolTotal:'9'},{previousTotal:'3'},{balanceAfter:'6'},{id:base},{winnerCount:0},{quantity:'0'},{poolTotal:'08'},{balanceBefore:'9223372036854775808'},{quantity:'9'.repeat(100000)}])
   expect(SeekerShardsClaimReceiptSchema.safeParse({...receipt,...patch}).success).toBe(false);
 });
 it('binds page recipient and cursor, preserving an empty page with a next position',()=>{
  expect(matchSeekerShardsEntitlementView(view,wallet)).toEqual(view);
  expect(matchSeekerShardsEntitlementView({...view,rows:[]},wallet).nextCursor).toBe(term);
  expect(()=>matchSeekerShardsEntitlementView(view,other)).toThrow();
  expect(()=>matchSeekerShardsEntitlementView(view,wallet,term)).toThrow();
 });
 it('refuses contradictory entitlement arithmetic and order instead of displaying a false zero',()=>{
  for(const patch of [{dueQuantity:'0'},{claimedTotal:'3'},{poolTotal:'9'},{endsAt:'2026-09-26T00:00:00.000Z'},{startsAt:'2026-02-30T00:00:00.000Z'}])
   expect(SeekerShardsEntitlementViewSchema.safeParse({...view,rows:[{...row,...patch}]}).success).toBe(false);
  expect(SeekerShardsEntitlementViewSchema.safeParse({...view,rows:[row,row]}).success).toBe(false);
  expect(SeekerShardsEntitlementViewSchema.safeParse({...view,rows:[{...row,spotId:20},row]}).success).toBe(false);
 });
 it('refuses conflicting pool totals across spots of one original term',()=>{
  expect(SeekerShardsEntitlementViewSchema.safeParse({...view,rows:[row,{...row,spotId:20,poolTotal:'9',cumulativeTotal:'3',dueQuantity:'2'}]}).success).toBe(false);
 });
 it('unknown source cannot report quantities, a resumable successful page or absence',()=>{
  const unavailable={...view,status:'unavailable',reason:'SOURCE_INTEGRITY',rows:[],nextCursor:null};
  expect(SeekerShardsEntitlementViewSchema.parse(unavailable).status).toBe('unavailable');
  for(const patch of [{reason:null},{rows:[row]},{nextCursor:term}]) expect(SeekerShardsEntitlementViewSchema.safeParse({...unavailable,...patch}).success).toBe(false);
 });
 it('rejects authority extras, raw resources and malformed ledger/wallet encodings',()=>{
  for(const patch of [{amount:'1'},{resourceId:'frost_quartz'},{currency:'KEEP'},{ledgerTransactionId:'invalid'},{wallet:'1'.repeat(100000)},{wallet:'0'.repeat(32)},{claimedAt:'2026-09-25T00:00:00Z'}])
   expect(SeekerShardsClaimReceiptSchema.safeParse({...receipt,...patch}).success).toBe(false);
 });
});
