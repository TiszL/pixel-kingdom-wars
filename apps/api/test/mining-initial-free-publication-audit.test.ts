/** Retained source facts bind the recipient and consumed stock together. */
import { createHash,randomUUID } from 'node:crypto';
import { Keypair,PublicKey,TransactionMessage } from '@solana/web3.js';
import { describe,expect,it,vi } from 'vitest';
import { buildMiningAllocationTree } from '@shardkeep/chain/mining-allocation';
import { buildPublishMiningInstruction } from '@shardkeep/chain/mining-program';
import { beginMiningPublicationAttempt } from '../src/mining/publicationCustody';
import { auditInitialFreePublicationManifest as audit } from '../src/mining/initialFreePublicationAudit';
import { withInitialFreePublicationFixture as fixture } from './fixtures/initialFreePublication';
const canonical=(v:unknown):string=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v!==null&&typeof v==='object'?`{${Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>`${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`:JSON.stringify(v);
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
type Fixture=Parameters<Parameters<typeof fixture>[0]>[0];
async function ready(f:Fixture){
 const result=await f.plan(f.request);if(!result.publication)throw Error('Fixture must fund a useful award');const p=result.publication;
 const publication={...Object.fromEntries(Object.entries(p).filter(([k])=>k!=='leaves').map(([k,v])=>[k,typeof v==='bigint'?String(v):v])),signer:f.backing.model.publisher.toBase58(),programId:f.backing.trust.programId.toBase58(),keepMint:f.backing.trust.keepMint.toBase58(),reserveOwner:f.backing.trust.reserveOwner.toBase58(),kind:0,blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:2001,blockhashContextSlot:2000};
 const ix=buildPublishMiningInstruction(f.backing.trust,{signer:new PublicKey(publication.signer),args:{sequence:p.sequence,root:Buffer.from(p.root,'hex'),totalCumulative:p.total,leafCount:p.leafCount,kind:0,day:p.day,budgetGross:p.budgetGross,freeGross:p.freeGross,deedGross:p.deedGross,sourceHash:Buffer.from(result.sourceHash,'hex'),taxCommitment:Buffer.from(p.taxCommitment,'hex'),taxVersion:p.taxVersion}});
 const intentBytes=new TransactionMessage({payerKey:new PublicKey(publication.signer),recentBlockhash:publication.blockhash,instructions:[ix]}).compileToLegacyMessage().serialize();
 const attempt=await beginMiningPublicationAttempt(f.conn.db,{epochId:f.request.epochId,attemptKey:randomUUID(),intentBytes});
 return {manifestJson:result.manifestJson,publication,reservations:attempt.reservations};
}
function forge(input:Awaited<ReturnType<typeof ready>>,change:(m:ReturnType<typeof JSON.parse>,p:Record<string,unknown>)=>void){const m=JSON.parse(input.manifestJson),p=structuredClone(input.publication);change(m,p);return {...input,manifestJson:canonical(m),publication:p};}
function replaceRoot(m:ReturnType<typeof JSON.parse>,p:Record<string,unknown>){const tree=buildMiningAllocationTree(m.awards.filter((a:{net:string})=>BigInt(a.net)>0n).map((a:{wallet:string;net:string})=>({wallet:a.wallet,cumulativeKeep:BigInt(a.net),cumulativeRenown:0n,cumulativeDays:0n,sequence:1n})));p.root=Buffer.from(tree.root).toString('hex');p.total=String(tree.total);p.leafCount=tree.leafCount;}
describe('retained initial-free publication source audit',()=>{
 it('accepts the actual planner and captured 0168 set, retaining exact excess without a new source read',async()=>fixture(async f=>{
  const input=await ready(f);f.backing.reader.getMultipleAccountsInfoAndContext=async()=>{throw Error('No new backing read is permitted');};const out=audit(input);
  expect(out).toMatchObject({sourceHash:sha(input.manifestJson),netAndCustodyConsistent:true,historicalQualificationReverified:false,publicationAuthorized:false,consumptionAuthorized:false});
  expect(out.reservations.map(r=>r.proposedConsumed)).toEqual([1,1,0]);expect(out.reservations.map(r=>r.proposedReturned)).toEqual([0,0,1]);
 },{quantities:[1,1,1]}));
 it('rejects a self-consistent tree paying a foreign recipient while consuming the original actor',async()=>fixture(async f=>{
  const input=await ready(f),foreign=Keypair.generate().publicKey.toBase58();
  for(const change of [
   (m:ReturnType<typeof JSON.parse>,p:Record<string,unknown>)=>{m.awards[0].wallet=foreign;replaceRoot(m,p);},
   (m:ReturnType<typeof JSON.parse>,p:Record<string,unknown>)=>{m.awards[0].wallet=foreign;m.participants[0].wallet=foreign;m.participants[0].evidence.wallet=foreign;replaceRoot(m,p);},
  ])expect(()=>audit(forge(input,change))).toThrowError(expect.objectContaining({code:'SOURCE_CONFLICT'}));
 }));
 it('rejects identity or source-universe substitution even after canonical source hashes are regenerated',async()=>fixture(async f=>{
  const input=await ready(f);
  const edits=[(m:ReturnType<typeof JSON.parse>)=>{m.participants=[];},(m:ReturnType<typeof JSON.parse>)=>{m.participants.push(structuredClone(m.participants[0]));},
   (m:ReturnType<typeof JSON.parse>)=>{m.participants[0].evidence.baseId=randomUUID();},(m:ReturnType<typeof JSON.parse>)=>{m.participants[0].evidence.day='2020-01-02';},
   (m:ReturnType<typeof JSON.parse>)=>{m.participants[0].evidence.policyVersion=2;},(m:ReturnType<typeof JSON.parse>)=>{m.participants[0].evidence.reservationIds=[];},
   (m:ReturnType<typeof JSON.parse>)=>{m.participants[0].shadow.evidence.reservations[0].actorWallet=f.buyer;},
   (m:ReturnType<typeof JSON.parse>)=>{m.participants[0].evidence.sources.deeds.targetWallet=f.buyer;},
   (m:ReturnType<typeof JSON.parse>)=>{m.participants[0].evidence.sources.registeredRoster.wallet=f.buyer;},
   (m:ReturnType<typeof JSON.parse>)=>{m.epoch.reservations[0].actorWallet=f.buyer;},(m:ReturnType<typeof JSON.parse>)=>{m.epoch.reservations=[];}];
  for(const edit of edits)expect(()=>audit(forge(input,edit))).toThrowError(expect.objectContaining({code:'SOURCE_CONFLICT'}));
  expect(()=>audit({...input,reservations:[]})).toThrowError(expect.objectContaining({code:'SOURCE_CONFLICT'}));
  expect(()=>audit({...input,reservations:[...input.reservations,input.reservations[0]!]})).toThrowError(expect.objectContaining({code:'SOURCE_CONFLICT'}));
 }));
 it('rejects excess or reordered consumption, quantity inflation and eligibility beyond the original cap',async()=>fixture(async f=>{
  const input=await ready(f);
  for(const change of [
   (m:ReturnType<typeof JSON.parse>)=>{m.reservations[2].proposedConsumed=1;m.reservations[2].proposedReturned=0;},
   (m:ReturnType<typeof JSON.parse>)=>{[m.reservations[0],m.reservations[2]]=[m.reservations[2],m.reservations[0]];},
   (m:ReturnType<typeof JSON.parse>)=>{m.participants[0].eligibleUnits=3;m.participants[0].evidence.eligibleUnits=3;m.participants[0].weight=m.participants[0].evidence.weight=String(3*m.participants[0].evidence.baseScoreBps);},
   (m:ReturnType<typeof JSON.parse>)=>{m.participants[0].shadow.result.pendingUnits=4;},
   (m:ReturnType<typeof JSON.parse>)=>{m.participants[0].evidence.reason='external_deed_owned';},
   (m:ReturnType<typeof JSON.parse>)=>{m.participants[0].evidence.baseScoreBps++;},
  ])expect(()=>audit(forge(input,change))).toThrowError(expect.objectContaining({code:'SOURCE_CONFLICT'}));
 },{quantities:[1,1,1]}));
 it('recomputes budgets, participation floor and persistent split rather than trusting matching summaries',async()=>fixture(async f=>{
  const input=await ready(f);
  for(const change of [
   (m:ReturnType<typeof JSON.parse>,p:Record<string,unknown>)=>{m.budgetGross=p.budgetGross=String(BigInt(m.budgetGross)+1n);},
   (m:ReturnType<typeof JSON.parse>)=>{m.policy.floor.minUnitsPerPool=1;},
   (m:ReturnType<typeof JSON.parse>)=>{m.denominator=m.sumWeight;},
   (m:ReturnType<typeof JSON.parse>)=>{m.awards[0].splitEnd=(m.awards[0].splitEnd+1)%10;},
   (m:ReturnType<typeof JSON.parse>,p:Record<string,unknown>)=>{m.awards[0].net=String(BigInt(m.awards[0].net)+1n);m.playerNet=p.playerNet=m.awards[0].net;replaceRoot(m,p);},
   (m:ReturnType<typeof JSON.parse>,p:Record<string,unknown>)=>{m.taxCommitment=p.taxCommitment='0'.repeat(64);},
   (m:ReturnType<typeof JSON.parse>)=>{m.funding.config.latestSequence='1';},
   (m:ReturnType<typeof JSON.parse>)=>{m.projection='ABORT_NO_USEFUL_PLAYER_AWARD';},
  ])expect(()=>audit(forge(input,change))).toThrowError(expect.objectContaining({code:'SOURCE_CONFLICT'}));
 }));
 it('refuses oversized or malformed decimals before attempting BigInt conversion',async()=>fixture(async f=>{
  const input=await ready(f),convert=globalThis.BigInt;
  for(const value of ['1'.repeat(100_000),'1e99','00','-1']){
   const spy=vi.spyOn(globalThis,'BigInt').mockImplementation(v=>{if(v===value)throw Error('Forbidden decimal reached conversion');return convert(v);});
   try{
    expect(()=>audit({...input,publication:{...input.publication,budgetGross:value}})).toThrowError(expect.objectContaining({code:'SOURCE_CONFLICT'}));
    expect(spy).not.toHaveBeenCalledWith(value);
   }finally{spy.mockRestore();}
  }
 }));
 it('rejects noncanonical, duplicate-key and oversized data as SOURCE_CONFLICT',async()=>fixture(async f=>{
  const input=await ready(f);
  for(const manifestJson of ['{',` ${input.manifestJson}`,input.manifestJson.replace('{','{"version":1,'),' '.repeat(4*1024*1024+1)])
   expect(()=>audit({...input,manifestJson})).toThrowError(expect.objectContaining({code:'SOURCE_CONFLICT'}));
 }));
});
