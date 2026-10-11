import {Keypair,TransactionMessage} from '@solana/web3.js';
import {describe,it,expect} from 'vitest';
import {buildPublishMiningInstruction,decodeMiningConfig,decodeMiningEpoch,decodeMiningRoot,miningLiabilityFloor} from './miningProgramProtocol';
import {createMiningPublicationReceiptVerifier} from './miningPublicationReceipt';
import {createMiningPublicationFixture as fixture} from './testFixtures/miningPublication';
const verify=(f:Awaited<ReturnType<typeof fixture>>)=>createMiningPublicationReceiptVerifier(f.reader,f.trusted)(f.request);
async function publications(){
 const signer=Keypair.generate(),first=await fixture('legacy',{signer});
 const second=await fixture('legacy',{signer,identity:first.trusted,priorFrontier:{...first.nextFrontier,totalClaimed:30n,taxPaid:4n},
  args:{...first.request.args,sequence:2n,day:101n,totalCumulative:87n,budgetGross:20n,freeGross:1n,deedGross:6n},publicationSlot:201});
 const third=await fixture('legacy',{signer,identity:first.trusted,priorFrontier:second.nextFrontier,vaultBefore:second.afterTokenBalance.vaultAfter+30n,reserveBefore:second.afterTokenBalance.reserveAfter,
  args:{...first.request.args,sequence:3n,day:102n,totalCumulative:90n,budgetGross:30n,freeGross:1n,deedGross:4n},publicationSlot:301});
 return {first,second,third};
}
describe('serialized cumulative publication fixture frontier',()=>{
 it('preserves the original virgin account and token economics by default',async()=>{
  const f=await fixture(),c=decodeMiningConfig(f.accounts[0]!,f.trusted),e=decodeMiningEpoch(f.accounts[1]!,{programId:f.trusted.programId,day:100n}),r=decodeMiningRoot(f.accounts[2]!,{programId:f.trusted.programId,sequence:1n});
  expect(c).toMatchObject({genesisDay:99n,latestDay:100n,latestSequence:1n,totalPublished:80n,totalPublishedHighwater:80n,totalClaimed:0n,taxHighwater:10n,taxPaid:0n,recycledTotal:10n,grossPublished:100n,splitCursor:0});
  expect(e).toMatchObject({playerNet:80n,tax:10n,recycle:10n,splitStart:0,splitEnd:0});expect(r).toMatchObject({prevDay:99n,prevTotal:0n,kind:0});
  expect(f.tx.meta!.preTokenBalances!.map(x=>x.uiTokenAmount.amount)).toEqual(['100','0']);expect(f.tx.meta!.postTokenBalances!.map(x=>x.uiTokenAmount.amount)).toEqual(['90','10']);
  expect((await verify(f)).playerNet).toBe(80n);
 });
 it('verifies consecutive sequence2/3 with persistent carry and prior claim/tax payments',async()=>{
  const {first,second,third}=await publications(),a=await verify(first),b=await verify(second),c=await verify(third);
  expect(a.totalCumulative).toBe(80n);expect(b).toMatchObject({sequence:2n,totalCumulative:87n,playerNet:7n,recycle:0n,tax:0n,splitStart:0,splitEnd:7});
  expect(c).toMatchObject({sequence:3n,totalCumulative:90n,playerNet:3n,recycle:1n,tax:1n,splitStart:7,splitEnd:2});
  const config=decodeMiningConfig(third.accounts[0]!,third.trusted),root=decodeMiningRoot(third.accounts[2]!,{programId:third.trusted.programId,sequence:3n});
  expect(root).toMatchObject({prevDay:101n,prevTotal:87n});expect(config).toMatchObject({genesisDay:99n,totalPublished:90n,totalPublishedHighwater:90n,totalClaimed:30n,taxHighwater:11n,taxPaid:4n,recycledTotal:11n,grossPublished:112n,splitCursor:2});
  expect(third.afterTokenBalance).toEqual({vaultAfter:105n,reserveAfter:11n});expect(third.afterTokenBalance.vaultAfter).toBeGreaterThanOrEqual(miningLiabilityFloor(config));
  expect(third.contextSlot).toBeGreaterThanOrEqual(c.slot);expect(third.fundedAt).toBe(c.fundedAt);
 });
 it('preserves an exact supplied unsigned intent with a carried frontier',async()=>{
  const {first,second}=await publications(),signer=Keypair.generate();
  // Supply a matching signer identity when regenerating the canonical message.
  const intentBytes=new TransactionMessage({payerKey:signer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[buildPublishMiningInstruction(first.trusted,{signer:signer.publicKey,args:second.request.args})]}).compileToLegacyMessage().serialize();
  const original=await fixture('legacy',{signer,identity:first.trusted,args:second.request.args,priorFrontier:first.nextFrontier,intentBytes});
  const copy=await fixture('legacy',{signer,identity:first.trusted,args:second.request.args,priorFrontier:first.nextFrontier,intentBytes:original.tx.transaction.message.serialize()});
  expect(copy.tx.transaction.message.serialize()).toEqual(original.tx.transaction.message.serialize());expect((await verify(copy)).totalCumulative).toBe(87n);
 });
 it('accepts a decoded prior config directly and returns independently owned frontier values',async()=>{
  const first=await fixture(),prior={...decodeMiningConfig(first.accounts[0]!,first.trusted)};
  const second=await fixture('legacy',{identity:first.trusted,priorFrontier:prior,args:{...first.request.args,sequence:2n,day:101n,totalCumulative:87n,budgetGross:20n,freeGross:1n,deedGross:6n}});
  prior.totalPublished=1n;prior.splitCursor=9;expect(second.nextFrontier.totalPublished).toBe(87n);expect(second.nextFrontier.splitCursor).toBe(7);expect(Object.isFrozen(second.nextFrontier)).toBe(true);expect((await verify(second)).playerNet).toBe(7n);
 });
 it.each(['previous-total','split-start','split-end','player-highwater','tax-highwater','recycle-highwater','gross-highwater','recycle-delta'] as const)('refuses %s contradictions in the serialized current proof',async kind=>{
  const {third:f}=await publications();
  if(kind==='previous-total'){Object.assign(f.models[2]!,{prev_total:86n});await f.encode(2);}
  if(kind==='split-start'){Object.assign(f.models[1]!,{split_start:0});await f.encode(1);}
  if(kind==='split-end'){Object.assign(f.models[1]!,{split_end:3});await f.encode(1);}
  if(kind==='player-highwater'){Object.assign(f.models[0]!,{total_published_highwater:89n});await f.encode(0);}
  if(kind==='tax-highwater'){Object.assign(f.models[0]!,{tax_highwater:0n,tax_paid:0n});await f.encode(0);}
  if(kind==='recycle-highwater'){Object.assign(f.models[0]!,{recycled_total:0n});await f.encode(0);}
  if(kind==='gross-highwater'){Object.assign(f.models[0]!,{gross_published:4n});await f.encode(0);}
  if(kind==='recycle-delta')f.tx.meta!.postTokenBalances![1]!.uiTokenAmount.amount='12';
  await expect(verify(f)).rejects.toMatchObject({code:expect.stringMatching(/ACCOUNTS|ECONOMICS/)});
 });
 it('does not mistake historical receipt minimum highwater checks for exact current frontier history',async()=>{
  const {third:f}=await publications();Object.assign(f.models[0]!,{latest_sequence:4n,total_published:95n,total_published_highwater:95n,tax_highwater:12n,recycled_total:12n,gross_published:120n,split_cursor:0});await f.encode(0);
  expect((await verify(f)).totalCumulative).toBe(90n);
 });
 it('rejects impossible fixture prior arithmetic, reused sequence and insufficient full-liability backing',async()=>{
  const {first}=await publications(),options={identity:first.trusted,priorFrontier:first.nextFrontier,args:{...first.request.args,sequence:2n,day:101n,totalCumulative:87n,budgetGross:20n,freeGross:1n,deedGross:6n}};
  await expect(fixture('legacy',{...options,args:{...options.args,totalCumulative:88n}})).rejects.toThrow();
  await expect(fixture('legacy',{...options,args:{...options.args,sequence:1n}})).rejects.toThrow();
  await expect(fixture('legacy',{...options,vaultBefore:109n})).rejects.toThrow();
  await expect(fixture('legacy',{...options,priorFrontier:{...first.nextFrontier,totalClaimed:81n}})).rejects.toThrow();
  await expect(fixture('legacy',{...options,priorFrontier:{...first.nextFrontier,taxHighwater:(1n<<64n)-1n,taxPaid:(1n<<64n)-1n},args:{...options.args,totalCumulative:87n,freeGross:1n,deedGross:18n}})).rejects.toThrow();
 });
});
