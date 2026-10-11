/** Actual prospective birth, raid-tithe ledger and member payout. This transport
 * declares simulated finalized bank envelopes; the separate Core runner executes
 * the same original through SBF. Every policy and wallet signature is genuine. */
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AddressLookupTableAccount,PublicKey,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import bs58 from 'bs58';
import {charterClanIdBytes} from '@shardkeep/chain/charter-protocol';
import {transferDisc} from '@shardkeep/chain/charter-transfer-protocol';
import {retirementCandidate,retirementParts} from '@shardkeep/chain/charter-retirement-preparation';
import {charterRetirementAccounts} from '@shardkeep/chain/charter-retirement-protocol';
import {createCharterRetirementReader} from '@shardkeep/chain/charter-retirement-evidence';
import {createCharterRetirementCancellationReader} from '@shardkeep/chain/charter-retirement-cancellation';
import {vi} from 'vitest';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {sign} from '../../../../packages/chain/src/testFixtures/charterPreparation';
import {createCharterPolicyIssuer} from '../../src/charterPolicyIssuer';
import {initializeCharterIssuerJournal} from '../../src/charterPolicyIssuerJournal';
import {createClanCharterMemberFences} from '../../src/game/clanCharterMemberFences';
import {createClanCharterMemberSettlement} from '../../src/game/clanCharterMemberSettlement';
import {createClanCharterRetirementWorkflow,type CharterRetirementWorkflowOptions} from '../../src/game/clanCharterRetirementWorkflow';
import {retirementOperationQuote} from '../../src/game/clanCharterRetirementPreparation';
import {createClanCharterRetirementsStore} from '../../src/db/charterRetirements';
import {createRaid} from '../../src/game/raids';
import {charterSalesWorkflowFixture} from './charterSalesWorkflow';
import {setupCharterSaleRaidActor} from './charterSalesRaid';
import {settleCharterSaleFixtureGross} from './charterSalesRaidPayout';

export async function charterRetirementWorkflowFixture(settings:{positive?:boolean;existing?:Omit<Awaited<ReturnType<typeof charterSalesWorkflowFixture>>,'issuer'|'options'|'request'|'signed'|'service'>}={}){
 const f=settings.existing??await charterSalesWorkflowFixture(),directory=await mkdtemp(path.join(tmpdir(),'charter-retirement-workflow-'));
 let issuer:Awaited<ReturnType<typeof createCharterPolicyIssuer>>|undefined;
 try{
  const actor=f.birth.actor.wallet;let raidId:string|null=null,cut=0n;
  if(settings.positive){
   await setupCharterSaleRaidActor(f,actor);const defender=await f.actor();vi.stubEnv('MULTI_BASE_ENABLED','false');
   const raid=await createRaid(f.db,actor,{defenderWallet:defender.wallet,idempotencyKey:randomUUID()});raidId=raid.id;
   cut=(await settleCharterSaleFixtureGross(f.db,raid.id,BigInt(PHASE_E_POLICY.basisPoints))).chestCut;
  }
  vi.stubEnv('MULTI_BASE_ENABLED','true');await f.birth.actor.refresh();
  const fence=await createClanCharterMemberFences(f.db).begin(actor,{clanId:f.birth.consent.clanId,idempotencyKey:randomUUID()});
  const payment=await createClanCharterMemberSettlement(f.db,{deedCollection:f.source.collection,finalizedDeedReader:f.reader}).settle(actor,fence.fenceId),journalFile=path.join(directory,'issuer.jsonl');
  await initializeCharterIssuerJournal(journalFile,{genesisHash:f.chain.trust.expectedGenesisHash,economyProgram:f.chain.trust.economy.programId});
  const signing=vi.fn((bytes:Uint8Array)=>sign(f.policy,bytes));
  issuer=await createCharterPolicyIssuer({journalFile,trust:f.chain.trust,connect:f.connect,signer:{publicKey:f.policy.publicKey.toBase58(),sign:signing}});
  const typed={issueOnce:vi.fn(issuer.issueOnce),lookup:vi.fn(issuer.lookup)},store=createClanCharterRetirementsStore(f.db);
  let finalized:VersionedTransactionResponse|null=null,submitted=false;
  const hooks={beforeSend:async()=>{},afterSend:async()=>{},beforeTransaction:async()=>{}},sent:Buffer[]=[];
  const rpc={...f.rpc,getTransaction:vi.fn(async()=>{await hooks.beforeTransaction();await f.rpc.getGenesisHash();return finalized;}),
   getSignatureStatuses:vi.fn(async()=>({context:{slot:150},value:[submitted?{slot:150,confirmations:null,err:null,confirmationStatus:'finalized' as const}:null]})),
   sendRawTransaction:vi.fn(async(bytes:Uint8Array)=>{await hooks.beforeSend();sent.push(Buffer.from(bytes));submitted=true;const signature=bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]!);await hooks.afterSend();return signature;})};
  const connect=vi.fn((_signal:AbortSignal)=>rpc),options=():CharterRetirementWorkflowOptions=>({chain:f.chain,issuer:typed,recovery:{connect,trust:f.chain.trust},delivery:{connect,trust:f.chain.trust,expectedCurrentSigner:f.chain.expectedCurrentSigner,lookupTable:f.chain.lookupTable}});
  const service=(overrides:Partial<CharterRetirementWorkflowOptions>={})=>createClanCharterRetirementWorkflow(f.db,{...options(),...overrides});
  const input={fenceId:fence.fenceId,idempotencyKey:randomUUID()},cleared=await service().create(actor,input);
  async function preparedSigned(id=cleared.id){const prepared=await service().prepare(actor,id),tx=VersionedTransaction.deserialize(Buffer.from(prepared.preparation!.packet.unsignedTransactionHex,'hex'));tx.sign([f.keys.get(actor)!]);return service().retainSigned(actor,id,tx.serialize());}
  async function finalizeRetirement(id=cleared.id){
   const state=await store.read(actor,id),quote=retirementOperationQuote(state),{economy,craft,leader,terms}=retirementParts(state.original),permit=retirementCandidate(state.original,state.attempt!.candidateHex),a=charterRetirementAccounts(economy,craft,leader,terms,permit.permitId);
   const tx=VersionedTransaction.deserialize(Buffer.from(state.signed!.signedTransactionHex,'hex')),u32=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;},u64=(n:bigint)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(n);return b;};
   const receipt=Buffer.concat([transferDisc('account:CharterRetirementReceipt'),Buffer.of(1),a.config.toBuffer(),...[terms.retirementId,terms.fenceId,terms.clanId].map(charterClanIdBytes),...[a.charter,a.asset,leader].map(k=>k.toBuffer()),u32(terms.expectedRevision),u32(terms.expectedRevision+1),Buffer.from(terms.clearanceHash),permit.permitId,u64(f.bank.clock.readBigInt64LE(32)),Buffer.of(PublicKey.findProgramAddressSync([Buffer.from('charter_retirement'),charterClanIdBytes(terms.clanId)],economy)[1])]);
   f.bank.rows.push({address:a.retirementReceipt,owner:economy,executable:false,data:receipt});
   const registry=f.bank.rows.find(row=>row.address.equals(a.charter))!;registry.data.writeUInt32LE(terms.expectedRevision+1,153);registry.data[157]=2;
   if(tx.message.version!==0)throw Error('Canonical v0 required');
   const table=new AddressLookupTableAccount({key:new PublicKey(quote.packetInput.lookupTable.address),state:AddressLookupTableAccount.deserialize(Buffer.from(quote.packetInput.lookupTable.dataHex,'hex'))}),loaded=tx.message.resolveAddressTableLookups([table]),keys=[...tx.message.staticAccountKeys,...loaded.writable,...loaded.readonly],pre=keys.map(()=>10000000),post=[...pre],fee=10000,rent=2000;
   keys.forEach((key,i)=>{if(key.equals(leader))post[i]!-=fee+rent;else if(key.equals(a.retirementReceipt))post[i]!+=rent;});
   finalized={slot:150,version:0,transaction:{message:tx.message,signatures:tx.signatures.map(s=>bs58.encode(s))},meta:{err:null,fee,preBalances:pre,postBalances:post,loadedAddresses:loaded}} as unknown as VersionedTransactionResponse;
   return finalized;
  }
  const readEvidence=createCharterRetirementReader(connect,f.chain.trust,async id=>{const state=await store.read(actor,id);if(!state.signed||!state.preparation)return null;return {packetInput:{...retirementOperationQuote(state).packetInput,policySignatureHex:state.preparation.policySignatureHex},signedTransactionHex:state.signed.signedTransactionHex};});
  const cancellationProof=createCharterRetirementCancellationReader(connect,f.chain.trust,async id=>{const state=await store.read(actor,id);return {original:state.original,inventory:state.inventory};});
  async function expire(){const state=await store.read(actor,cleared.id);if(state.attempt)f.bank.clock.writeBigInt64LE(Buffer.from(state.attempt.candidateHex,'hex').readBigInt64LE(121)+1n,32);}
  async function close(){try{await issuer?.close();}finally{try{await f.dispose();}finally{await rm(directory,{recursive:true,force:true});vi.restoreAllMocks();vi.unstubAllEnvs();}}}
  return {...f,actor,fence,payment,signing,typed,store,service,input,cleared,preparedSigned,close,raidId,cut,retirementRpc:rpc,retirementConnect:connect,retirementOptions:options,retirementHooks:hooks,sent,finalizeRetirement,readEvidence,cancellationProof,expire};
 }catch(error){try{await issuer?.close();}finally{try{await f.dispose();}finally{await rm(directory,{recursive:true,force:true});vi.restoreAllMocks();vi.unstubAllEnvs();}}throw error;}
}
