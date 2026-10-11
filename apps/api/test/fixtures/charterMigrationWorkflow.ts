/** Real SQL legacy source/cutover and policy journal; raw finalized banks are
 * explicitly synthetic here. The separate Core test executes real SBF bytes. */
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Keypair,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {expect,vi} from 'vitest';
import {createClanCharterMigrationsStore} from '../../src/db/charterMigrations';
import {createClanCharterMigrationWorkflow,type CharterMigrationWorkflowOptions} from '../../src/game/clanCharterMigrationWorkflow';
import {createCharterPolicyIssuer} from '../../src/charterPolicyIssuer';
import {initializeCharterIssuerJournal} from '../../src/charterPolicyIssuerJournal';
import {sign} from '../../../../packages/chain/src/testFixtures/charterPreparation';
import {charterSalesFixture} from './charterSales';
import {migrationBank} from './charterMigrationBank';
export async function charterMigrationWorkflowFixture(){
 const f=await charterSalesFixture(),directory=await mkdtemp(path.join(tmpdir(),'charter-migration-workflow-'));let issuer:Awaited<ReturnType<typeof createCharterPolicyIssuer>>|undefined;
 try{await f.initialize();const leader=Keypair.generate(),actor=leader.publicKey.toBase58(),clanId=randomUUID();
  await f.sql`insert into players(wallet) values(${actor})`;await f.sql`insert into clans(id,name,tag,leader_wallet) values(${clanId},${'Legacy '+clanId.slice(0,8)},${clanId.slice(0,4).toUpperCase()},${actor})`;await f.sql`insert into clan_members(player_wallet,clan_id) values(${actor},${clanId})`;
  const store=createClanCharterMigrationsStore(f.db),configuration={domain:{genesisHash:f.domain.genesisHash,economyProgram:f.domain.economyProgram,craftProgram:f.domain.craftProgram},metadataUriPrefix:'https://invalid.example/charters/'},input={clanId,idempotencyKey:randomUUID()},pending=await store.create(actor,input,configuration),policy=Keypair.generate();let bank=migrationBank(pending,policy),online=true,tick=0,submitted=false;
  const hooks={beforeRpc:async()=>{},beforeIssue:async()=>{},afterIssue:async()=>{},beforeLookup:async()=>{},beforeSend:async()=>{},afterSend:async()=>{},lookupNull:false};
  const rpc={...bank.rpc,getGenesisHash:vi.fn(async()=>{await hooks.beforeRpc();if(!online)throw Error('Synthetic bank offline');return f.domain.genesisHash;}),
   getMultipleAccountsInfoAndContext:vi.fn(async(...args:Parameters<typeof bank.rpc.getMultipleAccountsInfoAndContext>)=>{if(!online)throw Error('Synthetic bank offline');return bank.rpc.getMultipleAccountsInfoAndContext(...args);}),
   getSignatureStatuses:vi.fn(async()=>({context:{slot:150},value:[submitted?{slot:150,confirmations:null,err:null,confirmationStatus:'finalized' as const}:null]})),
   sendRawTransaction:vi.fn(async(bytes:Uint8Array)=>{await hooks.beforeSend();submitted=true;const signature=bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]!);await hooks.afterSend();return signature;})};
  const connect=vi.fn((_signal:AbortSignal)=>rpc),chain={...bank.options,connect},journalFile=path.join(directory,'policy.jsonl');
  await initializeCharterIssuerJournal(journalFile,{genesisHash:f.domain.genesisHash,economyProgram:f.domain.economyProgram});
  const signing=vi.fn((bytes:Uint8Array)=>sign(policy,bytes));issuer=await createCharterPolicyIssuer({journalFile,trust:chain.trust,connect,signer:{publicKey:policy.publicKey.toBase58(),sign:signing}});const actual=issuer;
  const typed={issueOnce:vi.fn(async(...args:Parameters<typeof actual.issueOnce>)=>{const saved=await store.read(actor,pending.id);expect(saved.attempt?.id).toBe(args[0].requestId);expect(saved.inventory.messages).toEqual([Buffer.from(args[0].message).toString('hex')]);await hooks.beforeIssue();const receipt=await actual.issueOnce(...args);await hooks.afterIssue();return receipt;}),
   lookup:vi.fn(async(...args:Parameters<typeof actual.lookup>)=>{await hooks.beforeLookup();return hooks.lookupNull?null:actual.lookup(...args);})};
  const options=():CharterMigrationWorkflowOptions=>({newMigration:configuration,chain,issuer:typed,recovery:{connect,trust:chain.trust},delivery:{connect,trust:chain.trust,expectedCurrentSigner:chain.expectedCurrentSigner,lookupTable:chain.lookupTable},monotonicNow:()=>tick});
  const service=(override:Partial<CharterMigrationWorkflowOptions>={})=>createClanCharterMigrationWorkflow(f.db,{...options(),...override});
  async function signed(){const prepared=await service().prepare(actor,pending.id),tx=VersionedTransaction.deserialize(Buffer.from(prepared.preparation!.packet.unsignedTransactionHex,'hex'));tx.sign([leader]);const bytes=Buffer.from(tx.serialize());return {bytes,state:await service().retainSigned(actor,pending.id,bytes)};}
  async function finalize(){const state=await store.read(actor,pending.id);bank=migrationBank(state,policy,true);}
  async function expire(){const state=await store.read(actor,pending.id);bank.clock.writeBigInt64LE(state.attempt?Buffer.from(state.attempt.candidateHex,'hex').readBigInt64LE(121)+1n:bank.clock.readBigInt64LE(32),32);}
  async function close(){try{await issuer?.close();}finally{try{await f.dispose();}finally{await rm(directory,{recursive:true,force:true});vi.restoreAllMocks();vi.unstubAllEnvs();}}}
  return {...f,leader,actor,clanId,configuration,input,pending,store,get bank(){return bank;},chain,typed,signing,rpc,connect,hooks,options,service,signed,finalize,expire,close,setOnline:(value:boolean)=>{online=value;},setTick:(value:number)=>{tick=value;}};
 }catch(e){try{await issuer?.close();}finally{try{await f.dispose();}finally{await rm(directory,{recursive:true,force:true});vi.unstubAllEnvs();}}throw e;}
}
