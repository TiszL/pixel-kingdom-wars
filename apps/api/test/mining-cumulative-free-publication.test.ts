/** Today's useful work adds to every retained funded right; it cannot replace
 * inactive wallets or spend backing already owed to players and held tax. */
import { randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { describe,expect,it } from 'vitest';
import { PHASE_E_MINING_PUBLICATION as SPLIT } from '@shardkeep/shared';
import { createMiningBackingSnapshotReader } from '@shardkeep/chain/mining-backing';
import { buildMiningAllocationTree } from '@shardkeep/chain/mining-allocation';
import { createCumulativeFreeAllocationPlanner } from '../src/mining/initialFreeAllocation';
import { auditInitialFreePublicationManifest,auditCumulativeFreePublicationManifest } from '../src/mining/initialFreePublicationAudit';
import { assertCumulativeMiningFunding,assertCumulativeMiningDay,buildCumulativeFreeDeclaration,type AuditedPriorMiningPublication } from '../src/mining/cumulativeFreePublication';
import { withInitialFreePublicationFixture as fixture } from './fixtures/initialFreePublication';
type Fixture=Parameters<Parameters<typeof fixture>[0]>[0];
const canonical=(v:unknown):string=>typeof v==='bigint'?JSON.stringify(String(v)):Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v!==null&&typeof v==='object'?`{${Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>`${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`:JSON.stringify(v);
async function prior(f:Fixture,continuing=true){
 const day=BigInt(+new Date(`${f.request.day}T00:00:00.000Z`)/(SPLIT.daySec*1000));
 const leaves=(continuing?[{wallet:f.wallet,net:50n},{wallet:f.buyer,net:33n}]:[{wallet:f.buyer,net:83n}]).map(a=>({wallet:a.wallet,sequence:1n,cumulativeKeep:a.net,cumulativeRenown:0n,cumulativeDays:0n}));
 const tree=buildMiningAllocationTree(leaves),root=Buffer.from(tree.root).toString('hex');
 const frontier={genesisDay:day-2n,latestSequence:1n,latestDay:day-1n,totalPublished:83n,totalPublishedHighwater:83n,taxHighwater:10n,recycledTotal:10n,grossPublished:103n,splitCursor:3};
 Object.assign(f.backing.model,{genesis_day:frontier.genesisDay,latest_sequence:1n,latest_day:frontier.latestDay,total_published:83n,total_published_highwater:83n,total_claimed:20n,tax_highwater:10n,tax_paid:5n,recycled_total:10n,gross_published:103n,split_cursor:3});await f.backing.config();
 const captured=await createMiningBackingSnapshotReader(f.backing.reader,f.backing.trust)();
 const previous:AuditedPriorMiningPublication={reference:{epochId:randomUUID(),sequence:'1',day:String(frontier.latestDay),root,total:'83',leafCount:tree.leafCount,sourceHash:'a'.repeat(64),signature:bs58.encode(Buffer.alloc(64,7)),publicationSlot:captured.slot,messageSha256:'b'.repeat(64),wireSha256:'c'.repeat(64)},
  declaration:{sequence:1n,root,total:tree.total,leafCount:tree.leafCount,leaves:tree.leaves},frontier};
 return {previous,captured,plan:createCumulativeFreeAllocationPlanner(f.conn.db,{...f.sources,loadPrior:async()=>previous})};
}
function capturedInput(f:Fixture,result:Awaited<ReturnType<ReturnType<typeof createCumulativeFreeAllocationPlanner>>>,previous:AuditedPriorMiningPublication){
 if(!result.publication)throw Error('Fixture must fund useful cumulative KEEP');
 const publication={...JSON.parse(canonical(Object.fromEntries(Object.entries(result.publication).filter(([key])=>key!=='leaves')))),signer:f.backing.model.publisher.toBase58(),programId:f.backing.trust.programId.toBase58(),keepMint:f.backing.trust.keepMint.toBase58(),reserveOwner:f.backing.trust.reserveOwner.toBase58(),kind:0};
 return {manifestJson:result.manifestJson,publication,previousPublication:previous,reservations:result.reservations.map(r=>({reservationId:r.reservationId,baseId:r.baseId,actorWallet:r.actorWallet,ingots:r.reserved}))};
}
describe('cumulative free-only retained publication',()=>{
 it('adds a continuing player day, keeps inactive rights and starts the retained nonzero split cursor',async()=>fixture(async f=>{
  const h=await prior(f),result=await h.plan(f.request),p=result.publication!;
  expect(result.projection).toBe('READY');expect(p.sequence).toBe(2n);expect(p.splitStart).toBe(3);expect(p.total).toBe(83n+p.playerNet);
  expect(p.leaves.find(l=>l.wallet===f.wallet)).toMatchObject({sequence:2n,cumulativeKeep:50n+p.playerNet,cumulativeRenown:0n,cumulativeDays:0n});
  expect(p.leaves.find(l=>l.wallet===f.buyer)).toMatchObject({sequence:2n,cumulativeKeep:33n,cumulativeRenown:0n,cumulativeDays:0n});
  const input=capturedInput(f,result,h.previous),audited=auditCumulativeFreePublicationManifest(input);
  expect(audited.declaration).toEqual({sequence:p.sequence,root:p.root,total:p.total,leafCount:p.leafCount,leaves:p.leaves});
  expect(JSON.parse(result.manifestJson).previousPublication).toEqual(h.previous.reference);
  expect(()=>auditInitialFreePublicationManifest(input)).toThrowError(expect.objectContaining({code:'SOURCE_CONFLICT'}));
  await expect(f.plan(f.request)).rejects.toMatchObject({code:'PRIOR_PUBLICATION_UNAVAILABLE'});
 }));
 it('introduces a new player without dropping the prior inactive player or granting Renown',async()=>fixture(async f=>{
  const h=await prior(f,false),result=await h.plan(f.request),p=result.publication!;
  expect(p.leafCount).toBe(2);expect(p.leaves.find(l=>l.wallet===f.buyer)?.cumulativeKeep).toBe(83n);expect(p.leaves.find(l=>l.wallet===f.wallet)?.cumulativeKeep).toBe(p.playerNet);
  expect(p.leaves.every(l=>l.cumulativeRenown===0n&&l.cumulativeDays===0n)).toBe(true);
  expect(auditCumulativeFreePublicationManifest(capturedInput(f,result,h.previous)).declaration.total).toBe(83n+p.playerNet);
 }));
 it('subtracts outstanding player and tax liabilities while allowing independently paid amounts to advance',async()=>fixture(async f=>{
  const h=await prior(f),result=await h.plan(f.request),m=JSON.parse(result.manifestJson);
  expect(m.funding.playerOutstanding).toBe('63');expect(m.funding.taxOutstanding).toBe('5');expect(m.budgetGross).toBe(String(h.captured.vaultAmount-68n));
  expect(()=>assertCumulativeMiningFunding(h.captured,h.previous)).not.toThrow();
  const advanced={...h.captured,config:{...h.captured.config,totalClaimed:23n,taxPaid:6n},playerOutstanding:60n,taxOutstanding:4n,totalOutstanding:64n,availableBudget:h.captured.vaultAmount-64n,maximumEpochBudget:h.captured.vaultAmount-64n};
  expect(()=>assertCumulativeMiningFunding(advanced,h.previous)).not.toThrow();
  for(const forged of [{...h.captured,availableBudget:h.captured.vaultAmount},{...h.captured,config:{...h.captured.config,totalClaimed:84n}},{...h.captured,config:{...h.captured.config,taxPaid:11n}},{...h.captured,slot:h.previous.reference.publicationSlot-1}])
   expect(()=>assertCumulativeMiningFunding(forged,h.previous)).toThrowError(expect.objectContaining({code:'SOURCE_CONFLICT'}));
 }));
 it('rejects omitted or fake predecessors, stale cumulative frontiers and self-consistent replacement roots',async()=>fixture(async f=>{
  const h=await prior(f),result=await h.plan(f.request),input=capturedInput(f,result,h.previous);
  for(const edit of [(m:ReturnType<typeof JSON.parse>)=>{m.previousPublication=null;},(m:ReturnType<typeof JSON.parse>)=>{m.previousPublication.sourceHash='f'.repeat(64);},(m:ReturnType<typeof JSON.parse>)=>{m.previousPublication.epochId=randomUUID();},(m:ReturnType<typeof JSON.parse>)=>{m.funding.config.latestSequence='2';},(m:ReturnType<typeof JSON.parse>)=>{m.funding.config.totalPublishedHighwater='84';},(m:ReturnType<typeof JSON.parse>)=>{m.funding.config.splitCursor=4;}]){
   const m=JSON.parse(input.manifestJson);edit(m);expect(()=>auditCumulativeFreePublicationManifest({...input,manifestJson:canonical(m)})).toThrowError(expect.objectContaining({code:'SOURCE_CONFLICT'}));
  }
  const replaced=buildMiningAllocationTree(result.publication!.leaves.filter(l=>l.wallet===f.wallet));
  expect(()=>auditCumulativeFreePublicationManifest({...input,publication:{...input.publication,root:Buffer.from(replaced.root).toString('hex'),total:String(replaced.total),leafCount:replaced.leafCount}})).toThrowError(expect.objectContaining({code:'SOURCE_CONFLICT'}));
  const unavailable=createCumulativeFreeAllocationPlanner(f.conn.db,{...f.sources,loadPrior:async()=>{throw Error('Owner history unavailable');}});
  await expect(unavailable(f.request)).rejects.toMatchObject({code:'PRIOR_PUBLICATION_UNAVAILABLE'});
  expect(()=>assertCumulativeMiningDay(h.previous.frontier.latestDay+3n,h.previous.frontier.latestDay+4n,h.previous)).toThrowError(expect.objectContaining({code:'SOURCE_CONFLICT'}));
  const fake={...h.previous,reference:{...h.previous.reference,total:'84'}};
  await expect(createCumulativeFreeAllocationPlanner(f.conn.db,{...f.sources,loadPrior:async()=>fake})(f.request)).rejects.toMatchObject({code:'PRIOR_PUBLICATION_UNAVAILABLE'});
 }));
 it('preserves prior non-KEEP counters and fails before growing beyond the complete technical leaf bound',()=>{
  const wallet=bs58.encode(Buffer.alloc(32,9)),tree=buildMiningAllocationTree([{wallet,sequence:1n,cumulativeKeep:4n,cumulativeRenown:7n,cumulativeDays:2n}]);
  const declaration={sequence:1n,root:Buffer.from(tree.root).toString('hex'),total:tree.total,leafCount:1,leaves:tree.leaves};
  expect(buildCumulativeFreeDeclaration(declaration,[{wallet,net:3n}]).nextPublication.leaves[0]).toMatchObject({sequence:2n,cumulativeKeep:7n,cumulativeRenown:7n,cumulativeDays:2n});
  expect(()=>buildCumulativeFreeDeclaration({...declaration,leaves:Array(10001).fill(tree.leaves[0])},[])).toThrowError(expect.objectContaining({code:'TOO_LARGE'}));
 });
 it('keeps more than the current-day actor limit in the complete cumulative root',()=>{
  const leaves=Array.from({length:33},(_,i)=>({wallet:bs58.encode(Buffer.alloc(32,i+1)),sequence:1n,cumulativeKeep:BigInt(i+1),cumulativeRenown:0n,cumulativeDays:0n})),tree=buildMiningAllocationTree(leaves);
  const result=buildCumulativeFreeDeclaration({sequence:1n,root:Buffer.from(tree.root).toString('hex'),total:tree.total,leafCount:tree.leafCount,leaves:tree.leaves},[{wallet:bs58.encode(Buffer.alloc(32,34)),net:1n}]);
  expect(result.nextPublication.leafCount).toBe(34);expect(result.retainedWallets).toBe(33);expect(result.newWallets).toBe(1);expect(result.incrementalNetKeep).toBe(1n);
 });
 it('only proposes zero-useful-award abort after authenticating the complete prior frontier',async()=>fixture(async f=>{
  const h=await prior(f),result=await h.plan(f.request);
  expect(result.projection).toBe('ABORT_NO_USEFUL_PLAYER_AWARD');expect(result.publication).toBeNull();
  expect(result.reservations.every(r=>r.proposedConsumed===0&&r.proposedReturned===r.reserved)).toBe(true);
  await expect(createCumulativeFreeAllocationPlanner(f.conn.db,{...f.sources,loadPrior:async()=>{throw Error('Unavailable is not a zero award');}})(f.request)).rejects.toMatchObject({code:'PRIOR_PUBLICATION_UNAVAILABLE'});
 },{budgetGross:68n}));
});
