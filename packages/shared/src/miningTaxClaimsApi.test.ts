/** Serialized actual quote/planner fixtures; grammar does not authenticate their chain evidence.
 * createMiningTaxQuoteReader claim/combined and createMiningTaxReceiptFixture split:
 * largest private quote JSON measured 152,230 bytes; public cases total 15,082. */
import {describe,expect,it,vi} from 'vitest';
import {PHASE_E_MINING_CLAIM_QUOTE,PHASE_E_POLICY} from './constants';
import {MiningTaxClaimPrepareRequestSchema,MiningTaxClaimPreparationSchema,MiningTaxClaimPreparationEnvelopeSchema} from './miningTaxClaimsApi';
import fixtures from './testFixtures/miningTaxClaimsApi.json';
const original=()=>structuredClone(fixtures.claim),combined=()=>structuredClone(fixtures.combined),split=()=>structuredClone(fixtures.split);
const request=()=>{const p=original();return {idempotencyKey:p.idempotencyKey,round:p.round,spot:p.spot,caps:p.caps};};
describe('original spot KEEP tax preparation and recovery',()=>{
 it.each(['claim','combined','split'] as const)('retains exact original %s message order, costs and immutable source identity',kind=>{
  expect(MiningTaxClaimPreparationSchema.parse(fixtures[kind])).toEqual(fixtures[kind]);
  expect(fixtures[kind].quoteTtlSec).toBe(PHASE_E_MINING_CLAIM_QUOTE.ttlSec);
 });
 it('accepts explicit original round/spot and caps but refuses caller wallet, source or payment authority',()=>{
  expect(MiningTaxClaimPrepareRequestSchema.parse(request())).toEqual(request());
  for(const extra of [{wallet:original().wallet},{amount:'1'},{source:{}},{signature:'x'},{submissionAuthorized:true}])expect(MiningTaxClaimPrepareRequestSchema.safeParse({...request(),...extra}).success).toBe(false);
  for(const spot of [-1,1.5,PHASE_E_POLICY.seekerIsland.totalSpots])expect(MiningTaxClaimPrepareRequestSchema.safeParse({...request(),spot}).success).toBe(false);
 });
 it('bounds canonical decimal inputs before BigInt even when other fields are invalid',()=>{
  const spy=vi.spyOn(globalThis,'BigInt');try{
   for(const value of ['01','-1','1e3','x','18446744073709551616','9'.repeat(100000)]){
    expect(MiningTaxClaimPrepareRequestSchema.safeParse({...request(),round:value}).success).toBe(false);
    const p=original();p.fees.totalLamports=value;expect(MiningTaxClaimPreparationSchema.safeParse(p).success).toBe(false);
   }
   expect(spy.mock.calls.some(([v])=>typeof v==='string'&&(!/^[0-9]+$/.test(v)||v.length>20))).toBe(false);
  }finally{spy.mockRestore();}
 });
 it('keeps immutable expiry metadata separate from live recovery time and current game tuning',()=>{
  const p=original();p.quoteTtlSec+=1;p.expiresAt=new Date(Date.parse(p.preparedAt)+p.quoteTtlSec*1000).toISOString();
  p.term.operatingEnd=(BigInt(p.term.operatingEnd)+1n).toString();p.spot=255;
  expect(MiningTaxClaimPreparationSchema.parse(p)).toEqual(p);
  const serverNow='2040-01-01T00:00:00.000Z';
  expect(MiningTaxClaimPreparationEnvelopeSchema.parse({wallet:p.wallet,idempotencyKey:p.idempotencyKey,status:'prepared',preparation:p,serverNow}).preparation).toEqual(p);
  expect(MiningTaxClaimPreparationSchema.safeParse({...p,serverNow}).success).toBe(false);
 });
 it('requires explicit bounded source pins and snapshot Clock without implying signature or finality authority',()=>{
  for(const change of [(p:ReturnType<typeof original>)=>{p.identity.originalWinner=p.identity.programId;},(p:ReturnType<typeof original>)=>{p.source.programId=p.identity.keepMint;},(p:ReturnType<typeof original>)=>{p.source.snapshotSlot=p.source.feeSlot-1;},(p:ReturnType<typeof original>)=>{p.source.blockhashSlot=p.source.firstSnapshotSlot-1;},(p:ReturnType<typeof original>)=>{p.source.reviewedDeploymentSlot=Number(p.term.completedSlot);},(p:ReturnType<typeof original>)=>{p.snapshot.unixTimestamp='0';}]){
   const p=original();change(p);expect(MiningTaxClaimPreparationSchema.safeParse(p).success).toBe(false);
  }
  for(const extra of [{snapshotProof:{}},{finalityAuthenticated:true},{currentSigningAuthorized:true},{submissionAuthorized:true}])expect(MiningTaxClaimPreparationSchema.safeParse({...original(),...extra}).success).toBe(false);
  const p=original();p.transactions[0]!.messageSha256='cd'.repeat(32);
  // The separate client cryptographic verifier must reject this changed hash.
  expect(MiningTaxClaimPreparationSchema.safeParse(p).success).toBe(true);
 });
 it('checks intended delta, original winner distribution and dust without recosting history',()=>{
  for(const change of [(p:ReturnType<typeof original>)=>{p.intended.claimBaseUnits='0';},(p:ReturnType<typeof original>)=>{p.intended.cumulativeBaseUnits='9';},(p:ReturnType<typeof original>)=>{p.intended.dustBaseUnits=String(p.term.winnerCount);},(p:ReturnType<typeof original>)=>{p.snapshot.poolAccruedBaseUnits='18446744073709551615';},(p:ReturnType<typeof original>)=>{p.term.winnerCount=0;}]){
   const p=original();change(p);expect(MiningTaxClaimPreparationSchema.safeParse(p).success).toBe(false);
  }
  const p=original();p.intended.claimBaseUnits='4';p.intended.cumulativeBaseUnits='4';
  expect(MiningTaxClaimPreparationSchema.safeParse(p).success).toBe(false); // No new accrual instruction can increase the pool.
 });
 it('checks individual and aggregate SOL costs against the exact saved caps and payer balance',()=>{
  for(const change of [(p:ReturnType<typeof original>)=>{p.caps.maxFeeLamports='1';},(p:ReturnType<typeof original>)=>{p.caps.maxTotalLamports='1';},(p:ReturnType<typeof original>)=>{p.fees.totalLamports='1';},(p:ReturnType<typeof original>)=>{p.fees.payerBalanceLamports='1';},(p:ReturnType<typeof original>)=>{p.transactions[0]!.feeLamports='1';}]){
   const p=original();change(p);expect(MiningTaxClaimPreparationSchema.safeParse(p).success).toBe(false);
  }
  const p=combined();p.caps.maxRentLamports='1';expect(MiningTaxClaimPreparationSchema.safeParse(p).success).toBe(false);
 });
 it('binds the ordered new-account roster to saved setup fields and exact rent totals',()=>{
  for(const change of [(p:ReturnType<typeof combined>)=>{p.transactions[0]!.newAccounts.reverse();},(p:ReturnType<typeof combined>)=>{p.transactions[0]!.newAccounts[0]!.rentLamports='1';},(p:ReturnType<typeof combined>)=>{p.transactions[0]!.newAccounts[1]!.address=p.transactions[0]!.newAccounts[0]!.address;},(p:ReturnType<typeof combined>)=>{p.setup.needsPool=false;},(p:ReturnType<typeof combined>)=>{p.setup.accrualDays.push(p.setup.accrualDays[0]!);}]){
   const p=combined();change(p);expect(MiningTaxClaimPreparationSchema.safeParse(p).success).toBe(false);
  }
 });
 it('preserves setup then claim ordering and never accepts setup alone as a complete preparation',()=>{
  for(const change of [(p:ReturnType<typeof split>)=>{p.transactions.reverse();},(p:ReturnType<typeof split>)=>{p.transactions.pop();},(p:ReturnType<typeof split>)=>{p.transactions[1]!.ordinal=0;},(p:ReturnType<typeof split>)=>{p.transactions[1]!.newAccounts=p.transactions[0]!.newAccounts;},(p:ReturnType<typeof split>)=>{p.transactions[1]!.messageHex=p.transactions[0]!.messageHex;}]){
   const p=split();change(p);expect(MiningTaxClaimPreparationSchema.safeParse(p).success).toBe(false);
  }
 });
 it('rejects oversized arrays before traversing their elements',()=>{
  let touched=0;const hostile=Array(10001);Object.defineProperty(hostile,0,{get(){touched++;throw Error('must not traverse');}});
  for(const p of [{...original(),transactions:hostile},{...original(),setup:{...original().setup,accrualDays:hostile}},{...combined(),transactions:[{...combined().transactions[0],newAccounts:hostile}]}])expect(MiningTaxClaimPreparationSchema.safeParse(p).success).toBe(false);
  expect(touched).toBe(0);
 });
 it('rejects malformed packet, addresses, hashes, timestamps and unknown nested fields',()=>{
  for(const change of [(p:ReturnType<typeof original>)=>{p.transactions[0]!.messageHex='80';},(p:ReturnType<typeof original>)=>{p.transactions[0]!.packetBytes++;},(p:ReturnType<typeof original>)=>{p.transactions[0]!.messageSha256='AB'.repeat(32);},(p:ReturnType<typeof original>)=>{p.wallet='1'.repeat(32);},(p:ReturnType<typeof original>)=>{p.identity.registry='x'.repeat(44);},(p:ReturnType<typeof original>)=>{p.expiresAt=p.preparedAt;},(p:ReturnType<typeof original>)=>{p.blockHeight=p.lastValidBlockHeight+1;}]){
   const p=original();change(p);expect(MiningTaxClaimPreparationSchema.safeParse(p).success).toBe(false);
  }
  expect(MiningTaxClaimPreparationSchema.safeParse({...original(),identity:{...original().identity,proof:{}}}).success).toBe(false);
 });
 it('returns private unknown recovery and binds prepared recovery to the same wallet and original key',()=>{
  const p=original(),base={wallet:p.wallet,idempotencyKey:p.idempotencyKey,serverNow:p.preparedAt};
  expect(MiningTaxClaimPreparationEnvelopeSchema.safeParse({...base,status:'unknown',preparation:null}).success).toBe(true);
  for(const extra of [{wallet:p.identity.programId},{idempotencyKey:p.claimId},{status:'unknown'}])expect(MiningTaxClaimPreparationEnvelopeSchema.safeParse({...base,status:'prepared',preparation:p,...extra}).success).toBe(false);
 });
});
