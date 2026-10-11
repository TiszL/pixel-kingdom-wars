/** Real retained qualification/backing captures; resource escrow/SQL publication
 * acceptance belongs to its integration suite, not this pure manifest replay. */
import { describe,it,expect } from 'vitest';
import { PHASE_E_MINING_CONTRIBUTION_V2 as V2 } from '@shardkeep/shared';
import { valueMiningContribution } from '@shardkeep/shared/miningContribution';
import { withFundedMiningReplayFixture as fixture } from './fixtures/fundedMiningReplay';
import { deriveFundedMiningWallet,type FundedMiningCapture } from '../src/mining/fundedMiningQualification';
import { miningCanonical,miningDigest } from '../src/mining/fundedMiningAudit';
import { loadAuditedMiningPrior } from '../src/mining/publicationHistory';
import { calculateResourceMining,deriveResourceMiningWallet,planResourceMiningContributions,type ResourceMiningOriginal,type ResourceMiningCapture } from '../src/mining/resourceMiningAllocation';
import { auditResourceMiningManifest,resourceMiningPolicy,validateResourceMiningOriginals,type ResourceMiningManifest } from '../src/mining/resourceMiningAudit';
import type { AuditedPriorMiningPublication } from '../src/mining/cumulativeFreePublication';
import type { PreparedMiningPublication } from '../src/mining/publicationPreparation';

function resourceReplay(prepared:PreparedMiningPublication,previousPublication:AuditedPriorMiningPublication|null){
 const old=JSON.parse(prepared.manifestJson),day=old.input.day as string;
 const captures:ResourceMiningCapture[]=(old.captures as FundedMiningCapture[]).map(c=>({...c,bases:c.bases.map(({reservedUnits,...b})=>({...b,reservedValue:String(BigInt(reservedUnits)*BigInt(V2.valuePerIngot))}))}));
 const originals:ResourceMiningOriginal[]=old.epoch.reservations.map((r:{id:string;baseId:string;actorWallet:string;qty:number})=>{
  const lines=[{resourceId:'forge_ingot' as const,quantity:String(r.qty)}],valued=valueMiningContribution(lines,V2.version);
  return {id:r.id,baseId:r.baseId,actorWallet:r.actorWallet,pool:old.participants.find((p:{wallet:string;baseId:string})=>p.wallet===r.actorWallet&&p.baseId===r.baseId).pool,
   request:{idempotencyKey:r.id,baseId:r.baseId,policyVersion:2,expectedDay:day,lines},lines:[...valued.lines],totalValue:valued.totalValue,createdAt:day+'T12:00:00.000Z'};
 });
 const epochAt=day+'T00:00:00.000000Z',participants=captures.flatMap(c=>deriveResourceMiningWallet(c,old.funding.source.genesisHash));
 const {declaration,consumed,...totals}=calculateResourceMining(participants,BigInt(old.budgetGross),old.splitStart,previousPublication?.declaration??null);
 const {reservations:ignored,...rest}=old;void ignored;
 const manifest:ResourceMiningManifest={...rest,version:5,scope:'ordinary-resource-mining-v2',policy:resourceMiningPolicy,captures,participants,...totals,
  epoch:{id:old.epoch.id,key:`resource-mining-v2:${day}`,createdAt:epochAt,contributionSetSha256:validateResourceMiningOriginals(old.epoch.id,day,epochAt,originals),contributions:originals},
  contributions:planResourceMiningContributions(originals,consumed)};
 const audit=(value:ResourceMiningManifest=manifest,source:ResourceMiningOriginal[]=originals)=>auditResourceMiningManifest({manifestJson:miningCanonical(value),publication:prepared.publication,contributions:source,previousPublication});
 return {manifest,originals,participants,captures,declaration,audit};
}
describe('resource contribution manifest 5 replay',()=>{
 it('retains real qualification, fund backing, split and tax provenance while binding each immutable basket',async()=>fixture(async f=>{
  const published=await(await f.stage('2020-01-01',{policyVersion:2,paidQuantity:8,freeQuantity:2})).publish();
  const r=resourceReplay(published.prepared,null),result=r.audit();
  expect(result.declaration).toEqual(r.declaration);expect(result.sourceHash).toBe(miningDigest(miningCanonical(r.manifest)));
  expect(result.contributions.every(c=>c.outcome==='consumed')).toBe(true);
  const old=JSON.parse(published.prepared.manifestJson);
  for(const c of old.captures as FundedMiningCapture[]){
   const before=deriveFundedMiningWallet(c,f.identity.genesisHash,2),after=r.participants.filter(p=>p.wallet===c.wallet);
   expect(after.map(p=>p.baseScoreBps)).toEqual(before.map(p=>p.baseScoreBps));
   expect(after.map(p=>p.weight)).toEqual(before.map(p=>String(BigInt(p.weight)*BigInt(V2.valuePerIngot))));
   expect(r.captures.flatMap(p=>p.bases).every(b=>!Object.hasOwn(b,'reservedUnits'))).toBe(true);
  }
  const mutations:((m:ResourceMiningManifest)=>void)[]=[
   m=>{m.epoch.contributionSetSha256='0'.repeat(64);},m=>{m.epoch.key='free-shadow-v2:2020-01-01';},
   m=>{m.captures[0]!.bases[0]!.reservedValue='1';},m=>{m.participants[0]!.weight=String(BigInt(m.participants[0]!.weight)+1n);},
   m=>{m.contributions[0]!.outcome='returned';},m=>{m.contributions[0]!.totalValue='1';},
   m=>{m.epoch.contributions[0]!.pool=m.epoch.contributions[0]!.pool==='free'?'deed':'free';},
   m=>{m.epoch.contributions[0]!.lines[0]!.unitValue='1';},m=>{m.taxCommitment='0'.repeat(64);},
   m=>{m.renownAuthorized=true;},m=>{m.input.policyVersion=1 as 2;},m=>{m.budgetGross='1';},
  ];
  for(const mutate of mutations){const changed=structuredClone(r.manifest);mutate(changed);expect(()=>r.audit(changed)).toThrow();}
  const fakeSource=structuredClone(r.originals);fakeSource[0]!.actorWallet=fakeSource[0]!.actorWallet===f.wallet?f.buyer:f.wallet;
  expect(()=>r.audit(r.manifest,fakeSource)).toThrow();
  const noToday=structuredClone(r.captures.find(c=>c.wallet===f.wallet)!);
  noToday.activity.qualifiedRaids=noToday.activity.qualifiedRaids.filter(row=>row.day!==noToday.day);
  noToday.activity.todayQualifyingRaidIds=[];noToday.activity.days.at(-1)!.qualifyingRaidIds=[];
  // An originally deed-paid large basket becoming ineligible must be returned,
  // even if the final roster calls this base free. Never clip part of the basket.
  noToday.bases[0]!.reservedValue='9007199254740993';
  const inactive=deriveResourceMiningWallet(noToday,f.identity.genesisHash);
  expect(inactive[0]).toMatchObject({eligible:false,eligibleValue:'0',weight:'0'});
  expect(calculateResourceMining(inactive,BigInt(old.budgetGross),old.splitStart,null).consumed[0]!.value).toBe('0');
  const overflow=structuredClone(r.captures.find(c=>c.wallet===f.wallet)!);overflow.bases[0]!.reservedValue=String(BigInt(V2.freeValuePerWalletDay)+1n);
  expect(()=>deriveResourceMiningWallet(overflow,f.identity.genesisHash)).toThrow();
  const huge=structuredClone(r.captures.find(c=>c.wallet===f.buyer)!);huge.bases[0]!.reservedValue='9007199254740993';
  expect(deriveResourceMiningWallet(huge,f.identity.genesisHash)[0]!.eligibleValue).toBe('9007199254740993');
 }),180_000);
 it('extends an actual v1 publication with resource rights and refuses to reset the funded frontier',async()=>fixture(async f=>{
  const first=await(await f.stage('2020-01-01')).publish(),saved=first.prepared.manifestJson;
  const second=await(await f.stage('2020-01-02',{policyVersion:2,paidQuantity:8,freeQuantity:2})).publish(),m=JSON.parse(second.prepared.manifestJson);
  const s=m.funding.source,c=m.funding.config,prior=await loadAuditedMiningPrior(f.conn.db,{genesisHash:s.genesisHash,programId:s.programId,configAddress:c.address,
   keepMint:c.keepMint,reserveOwner:c.emissionReserveOwner,reviewedDeploymentSlot:s.reviewedDeploymentSlot,reviewedProgramDataSha256:s.reviewedProgramDataSha256,
   sequence:'1',expectedReference:m.previousPublication});
  const r=resourceReplay(second.prepared,prior),audited=r.audit();
  expect(audited.declaration.sequence).toBe(2n);
  expect(audited.declaration.total).toBe(prior.declaration.total+BigInt(m.playerNet));
  expect(audited.declaration.leaves.every(l=>l.cumulativeRenown===2n&&l.cumulativeDays===2n)).toBe(true);
  expect(()=>auditResourceMiningManifest({manifestJson:miningCanonical(r.manifest),publication:second.prepared.publication,contributions:r.originals,previousPublication:null})).toThrow();
  const reset=structuredClone(r.manifest);reset.previousPublication=null;expect(()=>r.audit(reset)).toThrow();
  expect(first.prepared.manifestJson).toBe(saved);expect(await first.settle()).toEqual(first.settlement);
 }),180_000);
});
