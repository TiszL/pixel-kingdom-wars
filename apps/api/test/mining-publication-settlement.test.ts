/** Paid custody terminalization uses serialized finalized program receipts, never a verifier boolean. */
import { createHash,randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ComputeBudgetProgram,Keypair,PublicKey,TransactionMessage } from '@solana/web3.js';
import { describe,it,expect,vi } from 'vitest';
import { createMiningPublicationReceiptVerifier } from '@shardkeep/chain/mining-publication';
import { buildMiningAllocationTree } from '@shardkeep/chain/mining-allocation';
import { buildPublishMiningInstruction } from '@shardkeep/chain/mining-program';
import { beginMiningPublicationAttempt } from '../src/mining/publicationCustody';
import { getWorkshopView } from '../src/game/workshop';
import { createMiningPublicationFixture } from '../../../packages/chain/src/testFixtures/miningPublication';
import { withInitialFreePublicationFixture } from './fixtures/initialFreePublication';
import { createInitialFreePublicationPreparer,getPreparedMiningPublication } from '../src/mining/publicationPreparation';
import { createMiningPublicationSettlement } from '../src/mining/publicationSettlement';
import { createTestPlayer } from './helpers';
const json=(v:unknown)=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x);
type BaseFixture=Parameters<Parameters<typeof withInitialFreePublicationFixture>[0]>[0];
async function ready(f:BaseFixture){
 const signer=Keypair.generate();f.backing.model.publisher=signer.publicKey;f.backing.model.flags=0;await f.backing.config();
 const attemptKey=randomUUID(),prepare=createInitialFreePublicationPreparer(f.conn.db,{sources:f.sources,signer:signer.publicKey,blockhashSource:()=>({
  getGenesisHash:async()=>f.backing.trust.expectedGenesisHash,
  getLatestBlockhashAndContext:async()=>({context:{slot:2000},value:{blockhash:new PublicKey(Buffer.alloc(32,91)).toBase58(),lastValidBlockHeight:5000}}),
 })});
 const saved=await prepare({...f.request,attemptKey});if(saved.status!=='prepared')throw Error('fixture must qualify');
 const p=saved.publication,identity={programId:f.backing.trust.programId,keepMint:f.backing.trust.keepMint,reserveOwner:f.backing.trust.reserveOwner};
 const args={sequence:BigInt(p.sequence),day:BigInt(p.day),kind:0 as const,root:Buffer.from(p.root,'hex'),totalCumulative:BigInt(p.total),leafCount:p.leafCount,budgetGross:BigInt(p.budgetGross),freeGross:BigInt(p.freeGross),deedGross:BigInt(p.deedGross),sourceHash:Buffer.from(saved.sourceHash,'hex'),taxCommitment:Buffer.from(p.taxCommitment,'hex'),taxVersion:p.taxVersion};
 const chain=await createMiningPublicationFixture('legacy',{signer,identity,args,genesisHash:f.backing.trust.expectedGenesisHash,programData:f.backing.programData,intentBytes:Buffer.from(saved.intentHex,'hex'),publicationSlot:2001});
 const request={epochId:f.request.epochId,attemptKey,signature:chain.request.signature,signedTransaction:chain.request.signedTransaction};
 const settle=createMiningPublicationSettlement(f.conn.db,{reader:chain.reader,trust:chain.trusted});
 const stock=async()=>Number((await f.conn.sql`select qty from base_items where base_id=${f.baseId} and item_id='forge_ingot'`)[0]?.qty??0);
 return {...f,saved,chain,request,settle,stock};
}
async function fixture(run:(f:Awaited<ReturnType<typeof ready>>)=>Promise<void>){return withInitialFreePublicationFixture(async f=>run(await ready(f)),{quantities:[3]});}
describe('verified funded publication terminal custody',()=>{
 it('consumes qualified units and returns excess once, preserving original actors after transfer and paused replay',async()=>fixture(async f=>{
  const before=await f.stock(),{wallet:newOwner}=await createTestPlayer(f.conn.db);
  await f.conn.sql.begin(async tx=>{await tx`update bases set owner_wallet=${newOwner} where id=${f.baseId}`;await tx`update base_slots set wallet=${newOwner} where base_id=${f.baseId}`;});
  const result=await f.settle(f.request);expect(result.dispositions).toMatchObject([{actorWallet:f.wallet,consumed:2,returned:1}]);expect(await f.stock()).toBe(before+1);
  expect((await getWorkshopView(f.conn.db,newOwner,f.baseId)).holding.reserved).toBe(0);
  expect((await getWorkshopView(f.conn.db,newOwner,f.baseId)).allowance.holding.remaining).toBeGreaterThan(0);
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');f.chain.reader.getTransaction=async()=>{throw Error('replay must not use RPC');};
  try{expect(await f.settle(f.request)).toEqual(result);}finally{vi.stubEnv('PHASE_E_MINING_ENABLED','true');}
  expect(await f.stock()).toBe(before+1);
  const migration=readFileSync(new URL('../drizzle/0169_mining_publication_settlement.sql',import.meta.url),'utf8');
  for(let i=0;i<2;i++)await f.conn.sql.begin(async tx=>{for(const stmt of migration.split('--> statement-breakpoint').filter(s=>s.trim()))await tx.unsafe(stmt);});
  expect(await f.settle(f.request)).toEqual(result);
 }));
 it('holds all stock on unavailable or changed publication proof and rejects changed replay bytes',async()=>fixture(async f=>{
  const before=await f.stock(),get=f.chain.reader.getTransaction;f.chain.reader.getTransaction=async()=>null;
  await expect(f.settle(f.request)).rejects.toThrow();expect(await f.stock()).toBe(before);
  f.chain.reader.getTransaction=get;f.chain.tx.meta!.err={InstructionError:[0,'Custom']};await expect(f.settle(f.request)).rejects.toThrow();
  f.chain.tx.meta!.err=null;await f.settle(f.request);
  const wire=Uint8Array.from(f.request.signedTransaction);wire[5]=wire[5]!^1;
  await expect(f.settle({...f.request,signedTransaction:wire})).rejects.toMatchObject({code:'IDEMPOTENCY_BODY_MISMATCH'});
 }));
 it('rolls back settlement and dispositions when a return fails, then retries without duplicate consumption',async()=>fixture(async f=>{
  await f.conn.sql.unsafe("create function test_refuse_ingot_return() returns trigger language plpgsql as $$begin if NEW.item_id='forge_ingot' then raise exception 'injected return failure';end if;return NEW;end$$; create trigger test_refuse_ingot_return before insert or update on base_items for each row execute function test_refuse_ingot_return()");
  await expect(f.settle(f.request)).rejects.toMatchObject({cause:{message:'injected return failure'}});
  expect(await f.conn.sql`select epoch_id from mining_publication_settlements`).toHaveLength(0);expect(await f.conn.sql`select reservation_id from mining_ingot_dispositions`).toHaveLength(0);
  await f.conn.sql.unsafe('drop trigger test_refuse_ingot_return on base_items;drop function test_refuse_ingot_return()');
  expect((await f.settle(f.request)).dispositions[0]!.consumed).toBe(2);
 }));
 it('rejects broad-grant runtime forgery and incomplete terminal SQL even with the valid saved receipt',async()=>fixture(async f=>{
  const verified=await createMiningPublicationReceiptVerifier(f.chain.reader,f.chain.trusted)(f.chain.request);
  await expect(f.conn.sql.begin(async tx=>{await tx`insert into mining_publication_settlements(epoch_id,signature,signed_transaction,receipt) values(${f.request.epochId},${f.request.signature},${Buffer.from(f.request.signedTransaction)},${json(verified)}::jsonb)`;})).rejects.toThrow('MINING_SETTLEMENT_INCOMPLETE');
  const valid=await f.settle(f.request),role=`settle_${randomUUID().replaceAll('-','')}`;
  await f.conn.sql.unsafe(`create role ${role};grant usage on schema public to ${role};grant all on all tables in schema public to ${role}`);
  try{await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`insert into mining_publication_settlements(epoch_id,signature,signed_transaction,receipt) values(${f.request.epochId},${f.request.signature},${Buffer.from(f.request.signedTransaction)},${json(valid.receipt)}::jsonb)`;})).rejects.toThrow('MINING_SETTLEMENT_OWNER_REQUIRED');}
  finally{await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
  await expect(f.conn.sql`delete from mining_ingot_dispositions`).rejects.toThrow('MINING_SETTLEMENT_IMMUTABLE');
 }));
 it('serializes concurrent finalizers and replays one disposition set without a second return',async()=>fixture(async f=>{
  const before=await f.stock(),runs=await Promise.allSettled([f.settle(f.request),f.settle(f.request)]);
  expect(runs.some(r=>r.status==='fulfilled')).toBe(true);const saved=await f.settle(f.request);
  for(const r of runs)if(r.status==='fulfilled')expect(r.value).toEqual(saved);else expect(r.reason).toMatchObject({code:'BUSY'});
  expect(await f.stock()).toBe(before+1);expect(await f.conn.sql`select epoch_id from mining_publication_settlements`).toHaveLength(1);
  expect(await f.conn.sql`select reservation_id from mining_ingot_dispositions`).toHaveLength(1);
 }));
 it.each(['root','source'] as const)('refuses finalized %s account contradictions without releasing custody',async kind=>fixture(async f=>{
  const i=kind==='root'?2:1;Object.assign(f.chain.models[i]!,kind==='root'?{root:Buffer.alloc(32,19)}:{source_hash:Buffer.alloc(32,19)});await f.chain.encode(i);
  await expect(f.settle(f.request)).rejects.toMatchObject({code:'RECEIPT_UNAVAILABLE'});
  expect(await f.stock()).toBe(0);expect(await f.conn.sql`select epoch_id from mining_publication_settlements`).toHaveLength(0);
 }));
 it.each(['foreign-award','excess-consumption','message-declaration'] as const)('refuses self-consistent owner-inserted %s manifests before RPC',async kind=>withInitialFreePublicationFixture(async f=>{
  const signer=Keypair.generate();f.backing.model.publisher=signer.publicKey;f.backing.model.flags=0;await f.backing.config();
  const plan=await f.plan(f.request);if(plan.projection!=='READY')throw Error('fixture must qualify');
  const raw=JSON.parse(plan.manifestJson) as {awards:Array<{wallet:string;net:string}>;reservations:Array<{proposedConsumed:number;proposedReturned:number}>};
  if(kind==='foreign-award')raw.awards[0]!.wallet=Keypair.generate().publicKey.toBase58();
  else if(kind==='excess-consumption'){raw.reservations[0]!.proposedConsumed=3;raw.reservations[0]!.proposedReturned=0;}
  const manifestJson=json(raw),sourceHash=createHash('sha256').update(manifestJson).digest('hex');
  const tree=buildMiningAllocationTree(raw.awards.filter(a=>BigInt(a.net)>0n).map(a=>({wallet:a.wallet,cumulativeKeep:BigInt(a.net),cumulativeRenown:0n,cumulativeDays:0n,sequence:1n})));
  const p={...plan.publication,root:Buffer.from(tree.root).toString('hex')},identity={programId:f.backing.trust.programId,keepMint:f.backing.trust.keepMint,reserveOwner:f.backing.trust.reserveOwner};
  const args={sequence:p.sequence,day:p.day,kind:0 as const,root:tree.root,totalCumulative:p.total,leafCount:p.leafCount,budgetGross:p.budgetGross,freeGross:p.freeGross,deedGross:p.deedGross,sourceHash:Buffer.from(sourceHash,'hex'),taxCommitment:Buffer.from(p.taxCommitment,'hex'),taxVersion:p.taxVersion};
  const blockhash=Keypair.generate().publicKey.toBase58(),intentBytes=new TransactionMessage({payerKey:signer.publicKey,recentBlockhash:blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:400_000}),buildPublishMiningInstruction(identity,{signer:signer.publicKey,args})]}).compileToLegacyMessage().serialize();
  const attemptKey=randomUUID();await beginMiningPublicationAttempt(f.conn.db,{epochId:f.request.epochId,attemptKey,intentBytes});
  const publication={...p,signer:signer.publicKey.toBase58(),programId:identity.programId.toBase58(),keepMint:identity.keepMint.toBase58(),reserveOwner:identity.reserveOwner.toBase58(),kind:0,blockhash,lastValidBlockHeight:5000,blockhashContextSlot:2000};
  delete (publication as Record<string,unknown>).leaves;
  if(kind==='message-declaration')publication.blockhash=Keypair.generate().publicKey.toBase58();
  await f.conn.sql`insert into mining_publication_manifests(epoch_id,manifest_json,publication) values(${f.request.epochId},${manifestJson},${json(publication)}::jsonb)`;
  const chain=await createMiningPublicationFixture('legacy',{signer,identity,args,genesisHash:f.backing.trust.expectedGenesisHash,programData:f.backing.programData,intentBytes,publicationSlot:2001});
  const rpc=vi.fn(chain.reader.getTransaction);chain.reader.getTransaction=rpc;
  await expect(getPreparedMiningPublication(f.conn.db,f.request.epochId)).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
  await expect(createMiningPublicationSettlement(f.conn.db,{reader:chain.reader,trust:chain.trusted})({epochId:f.request.epochId,attemptKey,signature:chain.request.signature,signedTransaction:chain.request.signedTransaction})).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
  expect(rpc).not.toHaveBeenCalled();expect(await f.conn.sql`select epoch_id from mining_publication_settlements`).toHaveLength(0);
 },{quantities:[3]}));

 it('refuses an otherwise valid finalized receipt that predates the prepared blockhash bank',async()=>fixture(async f=>{
  f.chain.tx.slot=f.saved.publication.blockhashContextSlot-1;
  await expect(f.settle(f.request)).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
  expect(await f.stock()).toBe(0);expect(await f.conn.sql`select epoch_id from mining_publication_settlements`).toHaveLength(0);
 }));

});
