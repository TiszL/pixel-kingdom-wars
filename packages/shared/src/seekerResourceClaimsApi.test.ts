import { describe, expect, it } from 'vitest';
import { SeekerResourceClaimReceiptSchema, SeekerResourceEntitlementViewSchema, matchSeekerResourceClaimEnvelope,
 matchSeekerResourceClaimReceipt, matchSeekerResourceEntitlementView } from './seekerResourceClaimsApi';
const wallet='11111111111111111111111111111111', other='11111111111111111111111111111112';
const id='10000000-0000-4000-8000-000000000001', base='20000000-0000-4000-8000-000000000001', term='30000000-0000-4000-8000-000000000001';
const request={idempotencyKey:id,baseId:base,termId:term,resourceId:'frost_quartz' as const,spotId:0};
const receipt={...request,id,wallet,termHash:'a'.repeat(64),winnerCount:3,poolTotal:'8',previousTotal:'1',cumulativeTotal:'2',quantity:'1',stockBefore:'4',stockAfter:'5',claimedAt:'2026-09-25T00:00:00.000Z',shardsIncluded:false as const};
const row={termId:term,termHash:receipt.termHash,startsAt:'2026-09-18T00:00:00.000Z',endsAt:'2026-09-25T00:00:00.000Z',spotId:0,resourceId:request.resourceId,winnerCount:3,poolTotal:'8',cumulativeTotal:'2',claimedTotal:'1',dueQuantity:'1'};
const view={version:1 as const,wallet,claimsEnabled:false,shardsIncluded:false as const,status:'available' as const,reason:null,cursor:null,nextCursor:term,rows:[row]};
describe('original Seeker resource claim wire contract',()=>{
 it('accepts exact conserved receipt and wallet/body-bound recovery',()=>{
  expect(matchSeekerResourceClaimReceipt(receipt,wallet,request)).toEqual(receipt);
  expect(matchSeekerResourceClaimEnvelope({wallet,receipt},wallet,request)).toEqual({wallet,receipt});
  expect(matchSeekerResourceClaimEnvelope({wallet,receipt:null},wallet,request).receipt).toBeNull();
 });
 it('rejects wrong authenticated recipient, changed retry body and envelope substitution',()=>{
  expect(()=>matchSeekerResourceClaimReceipt(receipt,other,request)).toThrow();
  expect(()=>matchSeekerResourceClaimReceipt(receipt,wallet,{...request,spotId:20})).toThrow();
  expect(()=>matchSeekerResourceClaimEnvelope({wallet:other,receipt},other,request)).toThrow();
 });
 it('rejects invented shares, stock effects, counter regressions and noncanonical bounded quantities',()=>{
  for(const patch of [{quantity:'2'},{poolTotal:'9'},{previousTotal:'3'},{stockAfter:'6'},{id:base},{winnerCount:0},{quantity:'0'},{poolTotal:'08'},{stockBefore:'9223372036854775808'},{quantity:'9'.repeat(100000)}])
   expect(SeekerResourceClaimReceiptSchema.safeParse({...receipt,...patch}).success).toBe(false);
 });
 it('binds page recipient and cursor, preserving an empty page with a next position',()=>{
  expect(matchSeekerResourceEntitlementView(view,wallet)).toEqual(view);
  expect(matchSeekerResourceEntitlementView({...view,rows:[]},wallet).nextCursor).toBe(term);
  expect(()=>matchSeekerResourceEntitlementView(view,other)).toThrow();
  expect(()=>matchSeekerResourceEntitlementView(view,wallet,term)).toThrow();
 });
 it('refuses contradictory entitlement arithmetic and order instead of displaying a false zero',()=>{
  for(const patch of [{dueQuantity:'0'},{claimedTotal:'3'},{poolTotal:'9'},{endsAt:'2026-09-26T00:00:00.000Z'},{startsAt:'2026-02-30T00:00:00.000Z'}])
   expect(SeekerResourceEntitlementViewSchema.safeParse({...view,rows:[{...row,...patch}]}).success).toBe(false);
  expect(SeekerResourceEntitlementViewSchema.safeParse({...view,rows:[row,row]}).success).toBe(false);
  expect(SeekerResourceEntitlementViewSchema.safeParse({...view,rows:[{...row,spotId:20},row]}).success).toBe(false);
 });
 it('unknown source cannot report quantities, a resumable successful page or absence',()=>{
  const unavailable={...view,status:'unavailable',reason:'SOURCE_INTEGRITY',rows:[],nextCursor:null};
  expect(SeekerResourceEntitlementViewSchema.parse(unavailable).status).toBe('unavailable');
  for(const patch of [{reason:null},{rows:[row]},{nextCursor:term}]) expect(SeekerResourceEntitlementViewSchema.safeParse({...unavailable,...patch}).success).toBe(false);
 });
 it('rejects authority extras, SHARDS and oversized or invalid wallet encodings',()=>{
  for(const patch of [{amount:'1'},{resourceId:'shards'},{wallet:'1'.repeat(100000)},{wallet:'0'.repeat(32)},{claimedAt:'2026-09-25T00:00:00Z'}])
   expect(SeekerResourceClaimReceiptSchema.safeParse({...receipt,...patch}).success).toBe(false);
 });
});
