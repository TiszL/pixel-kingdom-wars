/** D181 actual birth, funded stock and private SQL saga. Calendar and finalized
 * RPC bank bytes are explicit R1 fixtures; real local Core is a separate run. */
import {randomUUID} from 'node:crypto';
import {AddressLookupTableAccount,Ed25519Program,PublicKey,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import bs58 from 'bs58';
import {vi} from 'vitest';
import {ORDINARY_REFINED_IDS} from '@shardkeep/shared/phaseEOrdinaryCrafting';
import {charterClanIdBytes} from '@shardkeep/chain/charter-protocol';
import {createCharterLockQuoteReader,verifyCharterLockQuote} from '@shardkeep/chain/charter-lock-preparation';
import {charterSalesWorkflowFixture} from './charterSalesWorkflow';
import {pastTournamentWeek} from './pastTournamentWeek';
import {createCharterTournamentsStore,type TournamentOperationState} from '../../src/db/charterTournaments';
import {createClanCharterTournaments,type CharterTournamentsOptions,type CharterLockIssueReceipt,type TypedCharterLockIssuer} from '../../src/game/clanCharterTournaments';
import {fundCharterTournamentEvent} from '../../src/game/charterTournamentEvents';
import {assertFreshLockedBaseAuthority} from '../../src/game/baseOwnership';
import {craftingStocks} from '../../src/db/schema';
// 2026-10-10: the default week is the latest real one that has closed (see pastTournamentWeek), not 2035-01-06.
export async function charterTournamentWorkflowFixture(settings:Parameters<typeof charterSalesWorkflowFixture>[0]={},calendar=pastTournamentWeek()){
 const f=await charterSalesWorkflowFixture({...settings,staticLookupTable:true});
 try{
  let time=new Date(calendar.fundedAt);const clock=()=>new Date(time),store=createCharterTournamentsStore(f.db,{clock});await store.initializeEpoch(f.domain);
  const budget=Object.fromEntries(ORDINARY_REFINED_IDS.map(item=>[item,'13'])) as Record<typeof ORDINARY_REFINED_IDS[number],string>;
  await f.db.insert(craftingStocks).values(ORDINARY_REFINED_IDS.map(itemId=>({baseId:f.source.baseId,itemId,available:17n})));
  await f.source.refresh();
  const event=await fundCharterTournamentEvent(f.db,f.source.wallet,{id:randomUUID(),baseId:f.source.baseId,weekStart:calendar.weekStart,budget},{baseId:f.source.baseId,assertAuthority:async(tx,wallet,baseId)=>{await assertFreshLockedBaseAuthority(tx,wallet,baseId);}},{domain:f.domain,sponsorWallet:f.source.wallet,clock});
  time=new Date(calendar.enteredAt);
  const transactions=new Map<string,VersionedTransactionResponse>(),statuses=new Map<string,{slot:number;confirmations:null;err:null;confirmationStatus:'finalized'}>();
  const sent:Uint8Array[]=[],hooks={beforeIssue:async()=>{},afterIssue:async()=>{},beforeSend:async()=>{},afterSend:async()=>{},lookupNull:false};
  const rpc={...f.rpc,getTransaction:async(signature:string)=>transactions.get(signature)??f.rpc.getTransaction(),getSignatureStatuses:vi.fn(async(signatures:string[])=>({context:{slot:150},value:signatures.map(s=>statuses.get(s)??null)})),sendRawTransaction:vi.fn(async(bytes:Uint8Array)=>{await hooks.beforeSend();sent.push(Uint8Array.from(bytes));const tx=VersionedTransaction.deserialize(bytes),signature=bs58.encode(tx.signatures[0]!);await hooks.afterSend();return signature;})};
  const connect=vi.fn((_signal:AbortSignal)=>rpc),chain={...f.chain,connect},receipts=new Map<string,CharterLockIssueReceipt>();let selected:string|undefined;
  const copy=(value:CharterLockIssueReceipt)=>({...value,message:Uint8Array.from(value.message),signature:Uint8Array.from(value.signature)});
  const issuer:TypedCharterLockIssuer={issueOnce:vi.fn(async(request,signal)=>{
   const prior=receipts.get(request.requestId);if(prior){if(Buffer.from(prior.message).toString('hex')!==Buffer.from(request.message).toString('hex'))throw Error('Fixture issuer conflict');return copy(prior);}
   await hooks.beforeIssue();if(!selected||signal.aborted||request.kind!=='charter-lock-v1')throw Error('Fixture issuer unavailable');
   const saved=await store.readOperation(f.source.wallet,selected),quote=verifyCharterLockQuote(saved.attempt!.quote);
   if(!saved.attempt||saved.attempt.id!==request.requestId||saved.attempt.candidateHex!==Buffer.from(request.message).toString('hex'))throw Error('Exposure not committed');
   const {connect:_connect,...quoteOptions}=chain;
   const current=await createCharterLockQuoteReader(connect,quoteOptions)(saved.original,Buffer.from(request.message).subarray(73,89));
   if(current.packetInput.candidateHex!==quote.packetInput.candidateHex)throw Error('Fixture issuer stale candidate');
   const receipt={requestId:request.requestId,publicKey:f.policy.publicKey.toBase58(),message:Uint8Array.from(request.message),signature:Uint8Array.from(Ed25519Program.createInstructionWithPrivateKey({privateKey:f.policy.secretKey,message:request.message}).data.subarray(48,112))};receipts.set(request.requestId,copy(receipt));await hooks.afterIssue();return copy(receipt);
  }),lookup:vi.fn(async id=>hooks.lookupNull?null:receipts.has(id)?copy(receipts.get(id)!):null)};
  const options=():CharterTournamentsOptions=>({chain,issuer,clock,delivery:{connect,trust:chain.trust,expectedCurrentSigner:chain.expectedCurrentSigner,lookupTable:chain.lookupTable},monotonicNow:()=>0});
  const service=(overrides:Partial<CharterTournamentsOptions>={})=>createClanCharterTournaments(f.db,{...options(),...overrides});
  const request=()=>({eventId:event.id,clanId:f.birth.consent.clanId,idempotencyKey:randomUUID()});
  async function entry(){const input=request(),state=await service().createEntry(f.source.wallet,input);selected=state.set.original.operation.id;return {input,state};}
  async function prepare(id:string){selected=id;return service().prepare(f.source.wallet,id);}
  function signed(state:TournamentOperationState){if(!state.preparation)throw Error('Fixture preparation absent');const packet=state.preparation.packet as {unsignedTransactionHex:string},tx=VersionedTransaction.deserialize(Buffer.from(packet.unsignedTransactionHex,'hex'));tx.sign([f.keys.get(state.original.operation.leader)!]);return Buffer.from(tx.serialize());}
  async function finalize(id:string){
   const state=await store.readOperation(f.source.wallet,id),quote=verifyCharterLockQuote(state.attempt!.quote);if(!state.signed)throw Error('Fixture wire absent');
   const tx=VersionedTransaction.deserialize(Buffer.from(state.signed.signedTransactionHex,'hex'));if(tx.message.version!==0)throw Error('Fixture v0 required');
   const lookup=new AddressLookupTableAccount({key:new PublicKey(quote.packetInput.lookupTable.address),state:AddressLookupTableAccount.deserialize(Buffer.from(quote.packetInput.lookupTable.dataHex,'hex'))}),loaded=tx.message.resolveAddressTableLookups([lookup]),keys=[...tx.message.staticAccountKeys,...loaded.writable,...loaded.readonly],pre=keys.map(()=>1000000000),post=[...pre];
   const fee=Number(quote.costs.networkFeeLamports),rent=Number(quote.costs.rentLamports),receipt=keys.findIndex(key=>key.toBase58()===quote.costs.allocations[0]!.address);if(receipt<0)throw Error('Fixture receipt missing');pre[receipt]=0;post[receipt]=rent;post[0]!-=fee+rent;
   const registry=f.bank.rows.find(row=>row.address.toBase58()===state.original.creation.chain.charter)!,op=state.original.operation;registry.data.writeUInt32LE(op.expectedRevision+1,153);registry.data[158]=op.action==='set'?1:0;if(op.action==='set')charterClanIdBytes(op.lockId).copy(registry.data,159);else registry.data.fill(0,159,175);
   const slot=140+op.expectedRevision,transaction={slot,version:0,transaction:{message:tx.message,signatures:tx.signatures.map(signature=>bs58.encode(signature))},meta:{err:null,fee,preBalances:pre,postBalances:post,loadedAddresses:loaded}} as unknown as VersionedTransactionResponse;
   transactions.set(state.signed.signature,transaction);statuses.set(state.signed.signature,{slot,confirmations:null,err:null,confirmationStatus:'finalized'});return transaction;
  }
  return {...f,event,tournamentStore:store,clock,service,entry,prepare,signed,finalizeLock:finalize,lockChain:chain,lockRpc:rpc,lockIssuer:issuer,lockHooks:hooks,lockReceipts:receipts,sent,request,setTime:(value:Date)=>{time=new Date(value);}};
 }catch(error){await f.dispose();throw error;}
}
export type CharterTournamentWorkflowFixture=Awaited<ReturnType<typeof charterTournamentWorkflowFixture>>;
