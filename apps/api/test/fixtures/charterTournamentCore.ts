/** Extends the accepted actual Core fixture; only event calendar and opening
 * refined stock are fixtures. Every lock transition comes from its real wire. */
import {randomUUID} from 'node:crypto';
import {Ed25519Program,VersionedTransaction} from '@solana/web3.js';
import {expect} from 'vitest';
import {PHASE_E_SEEKER_AUCTION} from '@shardkeep/shared';
import {ORDINARY_REFINED_IDS} from '@shardkeep/shared/phaseEOrdinaryCrafting';
import {CharterTournamentEntrySchema,CharterTournamentOperationSchema,CharterTournamentDeliverySchema,CharterTournamentEventSchema,type CharterTournamentOperation} from '@shardkeep/shared/charterTournamentApi';
import {createCharterLockQuoteReader,verifyCharterLockQuote} from '@shardkeep/chain/charter-lock-preparation';
import {createCharterLockEvidenceReader} from '@shardkeep/chain/charter-lock-evidence';
import {prepareTournamentSigning,signTournament} from '../../../web/src/lib/charterTournament/signing';
import {createCharterTournamentsStore} from '../../src/db/charterTournaments';
import {createClanCharterTournaments,type CharterLockIssueReceipt,type TypedCharterLockIssuer} from '../../src/game/clanCharterTournaments';
import {createCharterTournamentEventsClient} from '../../src/game/clanCharterTournamentEventsClient';
import {fundCharterTournamentEvent} from '../../src/game/charterTournamentEvents';
import {assertFreshLockedBaseAuthority} from '../../src/game/baseOwnership';
import {craftingStocks} from '../../src/db/schema';
import {buildApp} from '../../src/app';
import {TEST_CONFIG} from '../helpers';
import type {CharterSalesCoreTournamentContext,CharterSalesCoreTournamentResult} from './charterSalesCore';

export async function actualCharterTournamentCoreBeforeSale(c:CharterSalesCoreTournamentContext):Promise<CharterSalesCoreTournamentResult>{
 const f=c.fixture,actor=f.source.wallet,root='/clans/charter/tournaments';
 let time=new Date('2035-01-05T00:00:00.000Z');const clock=()=>new Date(time),store=createCharterTournamentsStore(f.db,{clock});
 const epoch=await store.initializeEpoch(c.domain),budget=Object.fromEntries(ORDINARY_REFINED_IDS.map(item=>[item,'13'])) as Record<typeof ORDINARY_REFINED_IDS[number],string>;
 await f.db.insert(craftingStocks).values(ORDINARY_REFINED_IDS.map(itemId=>({baseId:f.source.baseId,itemId,available:17n})));
 const event=await fundCharterTournamentEvent(f.db,actor,{id:randomUUID(),baseId:f.source.baseId,weekStart:'2035-01-06T00:00:00.000Z',budget},
  {baseId:f.source.baseId,assertAuthority:async(tx,wallet,id)=>{await assertFreshLockedBaseAuthority(tx,wallet,id);}},{domain:c.domain,sponsorWallet:actor,clock});
 time=new Date('2035-01-06T01:00:00.000Z');
 const receipts=new Map<string,CharterLockIssueReceipt>();let selected:string|undefined;
 const copy=(r:CharterLockIssueReceipt)=>({...r,message:Uint8Array.from(r.message),signature:Uint8Array.from(r.signature)});
 const issuer:TypedCharterLockIssuer={issueOnce:async(request,signal)=>{
  const prior=receipts.get(request.requestId);if(prior){expect(prior.message).toEqual(request.message);return copy(prior);}
  if(!selected||signal.aborted||request.kind!=='charter-lock-v1')throw Error('Fixture lock issuer unavailable');
  const saved=await store.readOperation(actor,selected);if(!saved.attempt)throw Error('Uncommitted exposure');
  expect(saved.attempt.id).toBe(request.requestId);expect(saved.attempt.candidateHex).toBe(Buffer.from(request.message).toString('hex'));
  const quote=verifyCharterLockQuote(saved.attempt.quote),{connect,...pins}=c.chain,current=await createCharterLockQuoteReader(connect,pins)(saved.original,Buffer.from(request.message).subarray(73,89));
  const candidate=Buffer.from(quote.packetInput.candidateHex,'hex'),fresh=Buffer.from(current.packetInput.candidateHex,'hex'),expiry=candidate.readBigInt64LE(121),now=BigInt(current.observation.unixTimestamp);
  expect(candidate.subarray(0,121)).toEqual(fresh.subarray(0,121));expect(candidate.subarray(129)).toEqual(fresh.subarray(129));
  if(expiry<=now||expiry-now>BigInt(PHASE_E_SEEKER_AUCTION.maxPolicyPermitTtlSec)||signal.aborted)throw Error('Fixture lock permit expired');
  const receipt={requestId:request.requestId,publicKey:c.policy.publicKey.toBase58(),message:Uint8Array.from(request.message),signature:Uint8Array.from(Ed25519Program.createInstructionWithPrivateKey({privateKey:c.policy.secretKey,message:request.message}).data.subarray(48,112))};
  receipts.set(request.requestId,copy(receipt));return copy(receipt);
 },lookup:async id=>receipts.has(id)?copy(receipts.get(id)!):null};
 const service=createClanCharterTournaments(f.db,{chain:c.chain,issuer,clock,delivery:{connect:()=>c.delivery,trust:c.chain.trust,expectedCurrentSigner:c.chain.expectedCurrentSigner,lookupTable:c.chain.lookupTable}});
 const app=await buildApp({...TEST_CONFIG,PLAYTEST_OPEN:'true'},f.db,{charterTournamentProvider:service,charterTournamentEventsProvider:createCharterTournamentEventsClient(f.db,{clock})});
 try{
  await app.ready();
  async function post(path:string,payload:Record<string,unknown>={},status=200){const r=await app.inject({method:'POST',url:root+path,payload,cookies:c.sellerAuth});expect(r.statusCode,r.body).toBe(status);return r.json();}
  async function read(path:string){const r=await app.inject({method:'GET',url:root+path,cookies:c.sellerAuth});expect(r.statusCode,r.body).toBe(200);return r.json();}
  const entry=CharterTournamentEntrySchema.parse(await post('/entries',{eventId:event.id,clanId:c.clanId,idempotencyKey:randomUUID()},201));expect(entry.status).toBe('pending');
  async function complete(operation:CharterTournamentOperation){
   selected=operation.original.operation.id;const prepared=CharterTournamentOperationSchema.parse(await post(`/operations/${selected}/prepare`));
   const approval=await signTournament(await prepareTournamentSigning(prepared,c.trust,actor),{publicKey:c.leader.publicKey,signVersionedTransaction:async(tx:VersionedTransaction)=>{tx.sign([c.leader]);return tx;}});
   const wire=Buffer.from(approval.signedTransactionHex,'hex');await post(`/operations/${selected}/signed`,{signedTransaction:wire.toString('base64')});
   await c.submitExact('tournament-'+operation.original.operation.action,wire,prepared.attempt!.quote.packetInput.lastValidBlockHeight,async()=>{
    const delivery=CharterTournamentDeliverySchema.parse(await post(`/operations/${selected}/deliver`));expect(delivery.status,JSON.stringify(delivery)).toBe('submitted');expect(delivery.signature).toBe(approval.signature);expect(delivery.operation.signed).toEqual(approval);
   });
   const terminal=CharterTournamentOperationSchema.parse(await post(`/operations/${selected}/recover`));expect(terminal.status).toBe('completed');return terminal;
  }
  const set=await complete(entry.set);expect(CharterTournamentEntrySchema.parse(await read('/entries/'+entry.id)).status).toBe('entered');
  const denied=await c.saleApp.inject({method:'POST',url:c.salesPath,payload:{clanId:c.clanId,buyer:f.buyer.wallet,priceLamports:'101000003',sellerLeaves:true,idempotencyKey:randomUUID()},cookies:c.sellerAuth});
  expect(denied.statusCode,denied.body).toBeGreaterThanOrEqual(400);expect(await f.sql`select id from charter_sales where clan_id=${c.clanId}`).toHaveLength(0);
  time=new Date(event.playEndsAt);const closed=CharterTournamentEventSchema.parse(await post('/events/'+event.id+'/close'));expect(closed.terminal?.rankings).toEqual([]);expect(closed.terminal?.entitlements).toEqual([{wallet:actor,amounts:budget}]);
  const clear=await complete(CharterTournamentOperationSchema.parse(await post('/entries/'+entry.id+'/clear',{idempotencyKey:randomUUID()})));expect(clear.original.operation.expectedRevision).toBe(1);
  const released=CharterTournamentEntrySchema.parse(await read('/entries/'+entry.id));expect(released.status).toBe('released');
  expect(await f.sql`select revision::text from charter_sale_heads where clan_id=${c.clanId}`).toEqual([{revision:'2'}]);
  const sourceSet=await store.readOperation(actor,set.original.operation.id),sourceClear=await store.readOperation(actor,clear.original.operation.id);
  return {epochId:epoch.id,revision:2,entryId:entry.id,setSignature:set.signed!.signature,clearSignature:clear.signed!.signature,verifyHistory:async()=>{
   const offline=createCharterTournamentsStore(f.db);expect(await offline.readOperation(actor,set.original.operation.id)).toEqual(sourceSet);expect(await offline.readOperation(actor,clear.original.operation.id)).toEqual(sourceClear);
   const evidence=createCharterLockEvidenceReader(c.chain.connect,c.chain.trust,async id=>{const state=id===set.original.operation.id?set:id===clear.original.operation.id?clear:null;if(!state?.attempt||!state.preparation||!state.signed)return null;return {packetInput:{...state.attempt.quote.packetInput,policySignatureHex:state.preparation.policySignatureHex},signedTransactionHex:state.signed.signedTransactionHex};});
   for(const op of [set,clear]){const historical=await evidence(op.original.operation.id,undefined);expect(historical.finalizedTransitionObserved).toBe(true);expect(historical.currentStateMatchesResult).toBe(false);}
   expect(await f.sql`select revision::text,leader_wallet from charter_sale_heads where clan_id=${c.clanId}`).toEqual([{revision:'3',leader_wallet:f.buyer.wallet}]);
  }};
 }finally{await app.close();}
}
