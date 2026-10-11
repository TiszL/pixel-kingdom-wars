/** A current observation binds saved consent but grants no action authority. */
import {describe,expect,it,vi} from 'vitest';
import {MiningTaxClaimPreparationSchema} from './miningTaxClaimsApi';
import {MiningTaxClaimReviewResponseSchema as Schema,validateMiningTaxClaimCurrentReview} from './miningTaxClaimReviewApi';
import fixtures from './testFixtures/miningTaxClaimRecoveryApi.json';
function fixture(kind:'claim'|'combined'|'split'='combined',ordinal=0){
 const p=MiningTaxClaimPreparationSchema.parse(structuredClone(fixtures[kind].preparation)),tx=p.transactions[ordinal]!,paid=ordinal===1?fixtures.split.settlement.receipt.transactions[0]!:null;
 return {p,response:{wallet:p.wallet,idempotencyKey:p.idempotencyKey,ordinal,status:'ready',review:{wallet:p.wallet,idempotencyKey:p.idempotencyKey,claimId:p.claimId,ordinal,status:'ready',
  messageSha256:tx.messageSha256,blockhash:p.blockhash,preparedAt:p.preparedAt,expiresAt:p.expiresAt,observedAt:'2035-01-01T00:00:01.000Z',
  feeLamports:tx.feeLamports,rentLamports:tx.rentLamports,totalLamports:(BigInt(tx.feeLamports)+BigInt(tx.rentLamports)).toString(),paidFeeLamports:paid?.feeLamports??'0',paidRentLamports:paid?.rentLamports??'0',
  source:{genesisHash:p.source.genesisHash,programId:p.source.programId,reviewedDeploymentSlot:p.source.reviewedDeploymentSlot,reviewedProgramDataSha256:p.source.reviewedProgramDataSha256,
   snapshotSlot:p.source.snapshotSlot+1,feeSlot:p.source.snapshotSlot+1,blockHeight:p.blockHeight+1,lastValidBlockHeight:p.lastValidBlockHeight},currentSigningAuthorized:false,relayAuthorized:false,settlementAuthorized:false},serverNow:'2035-01-01T00:00:02.000Z'}};
}
describe('current original KEEP tax review contract',()=>{
 it.each(['claim','combined','split'] as const)('binds exact retained %s consent without granting signing or relay',kind=>{
  const {p,response}=fixture(kind),result=validateMiningTaxClaimCurrentReview(p,response);expect(result).toEqual(response);expect(Object.isFrozen(result.review!.source)).toBe(true);
  response.review.messageSha256='00'.repeat(32);expect(result.review!.messageSha256).not.toBe(response.review.messageSha256);
 });
 it('supports a selected unsigned claim after paid setup within the original aggregate caps',()=>{
  const {p,response}=fixture('split',1);response.review.paidFeeLamports='6';response.review.feeLamports='4';response.review.totalLamports='4';
  expect(validateMiningTaxClaimCurrentReview(p,response)).toEqual(response);
  response.review.feeLamports='5';response.review.totalLamports='5';expect(()=>validateMiningTaxClaimCurrentReview(p,response)).toThrow();
 });
 it('requires exact request, original identity, message, blockhash and immutable quote interval',()=>{
  const original=fixture();for(const field of ['wallet','idempotencyKey','claimId','messageSha256','blockhash','preparedAt','expiresAt'] as const){
   const {p,response}=fixture(),r=response.review;r[field]=field==='wallet'||field==='blockhash'?p.identity.keepMint:field==='idempotencyKey'||field==='claimId'?p.claimId===r[field]?p.idempotencyKey:p.claimId:field==='messageSha256'?'ab'.repeat(32):'2035-01-01T00:00:03.000Z';
   expect(()=>validateMiningTaxClaimCurrentReview(p,response),field).toThrow();
  }
  for(const extra of [{wallet:original.p.identity.keepMint},{idempotencyKey:original.p.claimId},{ordinal:1}])expect(()=>validateMiningTaxClaimCurrentReview(original.p,{...original.response,...extra})).toThrow();
 });
 it('requires the exact reviewed deployment and advancing slot and height observations',()=>{
  for(const field of ['genesisHash','programId','reviewedDeploymentSlot','reviewedProgramDataSha256','snapshotSlot','feeSlot','blockHeight','lastValidBlockHeight'] as const){
   const {p,response}=fixture(),s=response.review.source;const changed={...s,[field]:field==='genesisHash'||field==='programId'?p.identity.keepMint:field==='reviewedProgramDataSha256'?'ab'.repeat(32):field==='lastValidBlockHeight'?p.lastValidBlockHeight+1:field==='blockHeight'?p.blockHeight-1:0};
   expect(()=>validateMiningTaxClaimCurrentReview(p,{...response,review:{...response.review,source:changed}}),field).toThrow();
  }
 });
 it('requires observedAt <= serverNow < saved expiry and rejects backwards or invalid clocks',()=>{
  const {p,response}=fixture();for(const observedAt of ['2034-12-31T23:59:59.999Z','2035-01-01T00:00:03.000Z',p.expiresAt,'2035-02-30T00:00:01.000Z'])expect(()=>validateMiningTaxClaimCurrentReview(p,{...response,review:{...response.review,observedAt}})).toThrow();
  for(const serverNow of ['2035-01-01T00:00:00.000Z',p.expiresAt,'2035-01-01T00:00:01Z'])expect(()=>validateMiningTaxClaimCurrentReview(p,{...response,serverNow})).toThrow();
 });
 it('conserves measured selected cost and prior paid costs within each explicit original cap',()=>{
  for(const change of [{totalLamports:'0'},{feeLamports:'11',totalLamports:'211'},{rentLamports:'1001',totalLamports:'1006'},{paidFeeLamports:'1'},{paidRentLamports:'1'}]){
   const {p,response}=fixture();expect(()=>validateMiningTaxClaimCurrentReview(p,{...response,review:{...response.review,...change}})).toThrow();
  }
  const {p,response}=fixture('claim');expect(()=>validateMiningTaxClaimCurrentReview(p,{...response,review:{...response.review,rentLamports:'1',totalLamports:'6'}})).toThrow();
  const split=fixture('split',1);split.p.caps.maxTotalLamports=split.p.fees.totalLamports;split.response.review.paidFeeLamports='6';expect(()=>validateMiningTaxClaimCurrentReview(split.p,split.response)).toThrow();
 });
 it('preserves syntax-only semantics and validates historical preparation without current tuning',()=>{
  const {p,response}=fixture();p.quoteTtlSec++;p.expiresAt='2035-01-01T00:02:01.000Z';p.spot=255;response.review.expiresAt=p.expiresAt;
  p.transactions[0]!.messageSha256='ab'.repeat(32);response.review.messageSha256=p.transactions[0]!.messageSha256;
  expect(validateMiningTaxClaimCurrentReview(p,response).review!.currentSigningAuthorized).toBe(false);
 });
 it('keeps unavailable responses empty and reason bounded, never implying a send',()=>{
  const {p,response}=fixture(),unavailable={...response,status:'unavailable',review:null,reason:'PROVIDER_UNAVAILABLE'};
  expect(validateMiningTaxClaimCurrentReview(p,unavailable)).toEqual(unavailable);
  for(const changed of [{...unavailable,reason:undefined},{...unavailable,reason:'SEND_NOW'},{...unavailable,review:response.review},{...response,reason:'EXPIRED'},{...response,review:null}])expect(Schema.safeParse(changed).success).toBe(false);
 });
 it('rejects malformed scalar types, authority and private fields before numeric conversion',()=>{
  const {response}=fixture();for(const extra of [{currentSigningAuthorized:true},{relayAuthorized:true},{settlementAuthorized:true},{finalityAuthenticated:true},{signature:'abc'},{snapshot:{}}])expect(Schema.safeParse({...response,review:{...response.review,...extra}}).success).toBe(false);
  expect(Schema.safeParse({...response,ordinal:'0'}).success).toBe(false);expect(Schema.safeParse({...response,ordinal:2}).success).toBe(false);
  const spy=vi.spyOn(globalThis,'BigInt');try{for(const value of ['x','01','-1','18446744073709551616','9'.repeat(10000)])expect(Schema.safeParse({...response,review:{...response.review,feeLamports:value}}).success).toBe(false);
   expect(spy.mock.calls.some(([v])=>typeof v==='string'&&(!/^[0-9]+$/.test(v)||v.length>20))).toBe(false);
  }finally{spy.mockRestore();}
 });
});
