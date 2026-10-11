/** Actual unfunded players and HTTP auth; synthetic raw finalized banks only.
 * The transport is populated from the HTTP-funded original. No fixture writes
 * a policy admission, issuance attempt, signed receipt or terminal result. */
import {randomUUID} from 'node:crypto';
import {AddressLookupTableProgram,Keypair,PublicKey,SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram,VersionedTransaction} from '@solana/web3.js';
import {expect,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {createCharterAdmissionReader} from '@shardkeep/chain/charter-admission';
import {decodeCharterRegistrationPermit} from '@shardkeep/chain/charter-protocol';
import type {CharterCreationQuoteRpc} from '@shardkeep/chain/charter-creation-preparation';
import {PHASE_E_SEEKER_AUCTION} from '@shardkeep/shared';
import {buildApp} from '../../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../../src/auth/session';
import type {Db} from '../../src/db/client';
import {sessions} from '../../src/db/schema';
import {createCharterCreationWorkflow,type CharterCreationWorkflowOptions,type CharterCreationWorkflowProvider,type CharterCreationWorkflowState} from '../../src/game/clanCharterCreationWorkflow';
import {registerCharterCreationRoutes} from '../../src/game/clanCharterCreationRoutes';
import type {CharterCreationPermitInventory} from '../../src/game/clanCharterCreationPermitInventory';
import type {CharterIssueReceipt,TypedCharterIssuer} from '../../src/game/clanCharterCreationPreparation';
import {TEST_CONFIG} from '../helpers';
import {charterCreationTerminalFixture} from './charterCreationTerminal';
import {policyBank} from './charterCreationPolicyAdmission';
import {candidateFor,digest,lookupFixture,registrationKeys,sign} from '../../../../packages/chain/src/testFixtures/charterPreparation';
export const charterPath='/clans/charter/creations';
export const noWorkflowAuthority={signingAuthorized:false,relayAuthorized:false,reservationReleaseAuthorized:false,
 mintAuthorized:false,paymentAuthorized:false,activationAuthorized:false,refundAuthorized:false};
export function gate(){let entered!:()=>void,release!:()=>void;const arrived=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);return {arrived,release,enter:async()=>{entered();await wait;}};}
export async function charterCreationWorkflowFixture(settings:{staticLookupTable?:boolean;genesisHash?:string}={}){
 const f=await charterCreationTerminalFixture(settings.genesisHash?{domain:{genesisHash:settings.genesisHash,economyProgram:Keypair.generate().publicKey.toBase58()}}:{}),apps:FastifyInstance[]=[],policyKey=Keypair.generate();
 let actor=f.source,payer:Keypair|undefined,bank:ReturnType<typeof policyBank>|null=null,online=true,tick=0;
 async function session(wallet:string){const [saved]=await f.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
  return {id:saved!.id,cookies:{[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,saved!.id)}};}
 let auth=await session(actor.wallet);
 async function useSigningActor(){
  const key=Keypair.generate(),generate=vi.spyOn(Keypair,'generate').mockReturnValueOnce(key);let pending:ReturnType<typeof f.actor>;
  try{pending=f.actor();}finally{generate.mockRestore();}actor=await pending!;payer=key;
  if(actor.wallet!==key.publicKey.toBase58())throw Error('Fixture payer key mismatch');auth=await session(actor.wallet);
 }
 // A declared fixture original supplies only static domain addresses here. Its
 // synthetic bank is never served; trusted program bytes are domain-independent
 // of the later server UUIDs and are reproduced in the actual funded bank.
 const declared=f.consent(f.source),zero:CharterCreationPermitInventory={reservation:{consent:declared,reserveTransactionId:randomUUID(),state:'reserved'},
  admission:{version:1,preimageHex:'00',commitment:'ab'.repeat(32)},permitInventory:{version:1,revision:'0',count:0,messages:[]},
  mintAuthorized:false,paymentAuthorized:false,signingAuthorized:false,activationAuthorized:false,refundAuthorized:false,reservationReleaseAuthorized:false};
 const trust=policyBank(zero).trust,original={creationIntentId:declared.creationIntentId,clanId:declared.clanId,payer:declared.payer,
  metadata:declared.metadata,chain:declared.chain,admissionCommitment:zero.admission.commitment},candidate=candidateFor(original),all=registrationKeys(original,candidate);
 const economy=new PublicKey(f.domain.economyProgram),craft=new PublicKey(f.domain.craftProgram),derive=(program:PublicKey,seed:string)=>PublicKey.findProgramAddressSync([Buffer.from(seed)],program)[0];
 const staticKeys=settings.staticLookupTable?[derive(economy,'seeker_authority'),derive(economy,'charter_config'),derive(economy,'charter_transfer_config'),craft,derive(craft,'charter_control'),derive(craft,'charter_collection'),derive(craft,'charter_collection_authority'),new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'),SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram.programId,economy,Keypair.generate().publicKey]:[1,2,8,9,11,12,14,15,16,17].map(index=>all[index]!.pubkey),lookup=lookupFixture(original,candidate);
 const data=Buffer.alloc(56+staticKeys.length*32);data.writeUInt32LE(1);data.writeBigUInt64LE((1n<<64n)-1n,4);data.writeBigUInt64LE(100n,12);
 staticKeys.forEach((key,index)=>key.toBuffer().copy(data,56+index*32));
 const lookupPin={address:lookup.row.address,dataSha256:digest(data)},blockhash=Keypair.generate().publicKey.toBase58();
 const hooks={beforeRpc:async()=>{},beforeIssue:async()=>{},afterIssue:async()=>{},beforeLookup:async()=>{},lookupNull:false};
 const current=()=>{if(!online||!bank)throw Error('Fixture finalized bank unavailable');return bank;};
 const rpc:CharterCreationQuoteRpc={getGenesisHash:vi.fn(async()=>{await hooks.beforeRpc();current();return f.domain.genesisHash;}),
  getSlot:vi.fn(async()=>{current();return 150;}),getMultipleAccountsInfoAndContext:vi.fn(async(addresses,options)=>current().rpc.getMultipleAccountsInfoAndContext(addresses,options)),
  getAccountInfoAndContext:vi.fn(async()=>{current();return {context:{slot:150},value:{owner:AddressLookupTableProgram.programId,executable:false,data}};}),
  getLatestBlockhashAndContext:vi.fn(async()=>{current();return {context:{slot:150},value:{blockhash,lastValidBlockHeight:300}};}),
  getFeeForMessage:vi.fn(async()=>{current();return {context:{slot:150},value:10000};}),
  getMinimumBalanceForRentExemption:vi.fn(async n=>{current();return 1000+n*5;}),getBlockHeight:vi.fn(async()=>{current();return 200;})};
 const connect=vi.fn((_signal:AbortSignal)=>rpc),receipts=new Map<string,CharterIssueReceipt>();
 const receiptCopy=(r:CharterIssueReceipt)=>({...r,message:Buffer.from(r.message),signature:Buffer.from(r.signature)});
 const issuer:TypedCharterIssuer={issueOnce:vi.fn(async(request,signal)=>{
  const bytes=Buffer.from(request.message),prior=receipts.get(request.requestId);if(prior){if(!Buffer.from(prior.message).equals(bytes))throw Error('Fixture issuer conflict');return receiptCopy(prior);}
  const permit=decodeCharterRegistrationPermit(bytes);if(request.kind!=='charter-registration-v1'||permit.kind!==5||permit.genesisHash.toBase58()!==f.domain.genesisHash||permit.programId.toBase58()!==f.domain.economyProgram)throw Error('Fixture issuer domain');
  await hooks.beforeIssue();const observed=await createCharterAdmissionReader(connect,trust,policyKey.publicKey.toBase58())();
  if(signal.aborted||permit.expiry<=observed.unixTimestamp||permit.expiry-observed.unixTimestamp>BigInt(PHASE_E_SEEKER_AUCTION.maxPolicyPermitTtlSec))throw Error('Fixture issuer stale');
  const receipt={requestId:request.requestId,publicKey:policyKey.publicKey.toBase58(),message:bytes,signature:sign(policyKey,bytes)};
  receipts.set(request.requestId,receiptCopy(receipt));await hooks.afterIssue();return receiptCopy(receipt);
 }),lookup:vi.fn(async id=>{await hooks.beforeLookup();return hooks.lookupNull?null:receipts.has(id)?receiptCopy(receipts.get(id)!):null;})};
 const chain={connect,trust,expectedCurrentSigner:policyKey.publicKey.toBase58(),lookupTable:lookupPin,
  coreCostProfile:{version:1 as const,profile:'mpl-core-0.15.2-charter-pfd-seq-none' as const,reviewedProgramDataSha256:trust.core.reviewedProgramDataSha256},
  costLimits:{maxNetworkFeeLamports:100000n,maxRentLamports:100000n,maxTotalLamports:2000000n}};
 function options():CharterCreationWorkflowOptions{return {newCreation:{domain:f.domain,metadataUriPrefix:'https://invalid.example/charters/'},chain,issuer,monotonicNow:()=>tick,
  finalizedDeedReader:async()=>actor.proof(),deedCollection:actor.collection};}
 function request(overrides:Partial<{creationIntentId:string;baseId:string;name:string;tag:string;inviteMode:'open'|'invite'}>={}){
  const id=randomUUID();return {creationIntentId:id,baseId:actor.baseId,name:'Clan '+id.slice(0,8),tag:id.replaceAll('-','').slice(0,5).toUpperCase(),inviteMode:'open' as const,...overrides};
 }
 async function sync(id:string,minted=false){const saved=await f.inventory().read(actor.wallet,id);bank=policyBank(saved);
  policyKey.publicKey.toBuffer().copy(bank.row.data,bank.offsets['current']!);bank.setMinted(minted);return saved;}
 async function open(settings:{options?:Partial<CharterCreationWorkflowOptions>;provider?:CharterCreationWorkflowProvider|null;runtimeDb?:Db}={}){
  const supplied=settings.provider===undefined?createCharterCreationWorkflow(f.db,{...options(),...settings.options}):settings.provider;
  const previous=process.env['MULTI_BASE_ENABLED'];process.env['MULTI_BASE_ENABLED']='false';
  try{const app=await buildApp({...TEST_CONFIG,PLAYTEST_OPEN:'true'},settings.runtimeDb??f.db);apps.push(app);registerCharterCreationRoutes(app,supplied);await app.ready();return app;}
  finally{if(previous===undefined)delete process.env['MULTI_BASE_ENABLED'];else process.env['MULTI_BASE_ENABLED']=previous;}
 }
 const post=(app:FastifyInstance,url:string,payload:Record<string,unknown>={},cookies=auth.cookies)=>app.inject({method:'POST',url,cookies,payload});
 async function funded(app:FastifyInstance,input=request()){const response=await post(app,charterPath,input);expect(response.statusCode,response.body).toBe(201);await sync(input.creationIntentId);return {input,state:response.json<CharterCreationWorkflowState>()};}
 async function prepared(app:FastifyInstance,input=request()){const fundedResult=await funded(app,input),response=await post(app,`${charterPath}/${input.creationIntentId}/prepare`);
  expect(response.statusCode,response.body).toBe(200);return {...fundedResult,state:response.json<CharterCreationWorkflowState>()};}
 function signed(state:CharterCreationWorkflowState){if(!payer||!state.preparation)throw Error('Expected an actual prepared signing actor');const tx=VersionedTransaction.deserialize(Buffer.from(state.preparation.packet.unsignedTransactionHex,'hex'));tx.sign([payer]);return {tx,bytes:Buffer.from(tx.serialize()),body:{signedTransaction:Buffer.from(tx.serialize()).toString('base64')}};}
 async function dispose(){try{await Promise.all(apps.splice(0).map(app=>app.close()));}finally{await f.dispose();}}
 return {...f,get payerActor(){return actor;},get auth(){return auth;},get bank(){return current();},session,useSigningActor,options,request,chain,issuer,connect,rpc,hooks,receipts,lookupData:data,
  open,post,funded,prepared,signed,sync,dispose,setOnline:(value:boolean)=>{online=value;},setTick:(value:number)=>{tick=value;}};
}
export type WorkflowFixture=Awaited<ReturnType<typeof charterCreationWorkflowFixture>>;
