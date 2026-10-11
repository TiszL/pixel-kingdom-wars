/** Actual birth, source epoch, fences and payout. Only finalized RPC bytes and
 * the independently gated policy issuer are synthetic fixture transports. */
import {randomUUID} from 'node:crypto';
import {AddressLookupTableAccount,AddressLookupTableProgram,Keypair,PublicKey,SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import bs58 from 'bs58';
import {expect,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {PHASE_E_CHARTER_TRANSFER,PHASE_E_POLICY} from '@shardkeep/shared';
import {charterClanIdBytes} from '@shardkeep/chain/charter-protocol';
import {charterTransferAccounts,transferDisc} from '@shardkeep/chain/charter-transfer-protocol';
import {createCharterTransferQuoteReader,transferCandidate,transferParts,type CharterTransferQuote} from '@shardkeep/chain/charter-transfer-preparation';
import {buildApp} from '../../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../../src/auth/session';
import {sessions} from '../../src/db/schema';
import type {Db} from '../../src/db/client';
import {createClanCharterSales,type CharterSaleView,type CharterSalesOptions,type CharterSalesProvider,type CharterSaleIssueReceipt,type TypedCharterSaleIssuer} from '../../src/game/clanCharterSales';
import {registerCharterSalesRoutes} from '../../src/game/clanCharterSalesRoutes';
import {refreshBaseOwnership} from '../../src/game/baseOwnership';
import {TEST_CONFIG} from '../helpers';
import {charterSalesSigningFixture} from './charterSalesSigning';
import {policyBank} from './charterCreationPolicyAdmission';
import {digest,sign} from '../../../../packages/chain/src/testFixtures/charterPreparation';
export const salesPath='/clans/charter/sales';
export const noSaleAuthority={signingAuthorized:false,relayAuthorized:false,transferAuthorized:false,fenceReleaseAuthorized:false};
export function saleGate(){let arrive!:()=>void,release!:()=>void;const arrived=new Promise<void>(r=>arrive=r),wait=new Promise<void>(r=>release=r);return {arrived,release,enter:async()=>{arrive();await wait;}};}
export async function charterSalesWorkflowFixture(settings:NonNullable<Parameters<typeof charterSalesSigningFixture>[0]>&{staticLookupTable?:boolean}={}){
 const f=await charterSalesSigningFixture(settings),apps:FastifyInstance[]=[];
 try{
  // The production provider pins one deed collection for every beneficiary and
  // buyer. Normalize only this declared upstream fixture before either is used;
  // the real protected observation records the same collection at a newer slot.
  async function sharedCollection(actor:typeof f.source){
   const originalProof=actor.proof;actor.collection=f.source.collection;
   actor.proof=(owner=actor.wallet,slot=101)=>({...originalProof(owner,slot),collection:actor.collection});
   actor.refresh=(owner=actor.wallet,slot=101)=>refreshBaseOwnership(f.db,actor.baseId,async()=>actor.proof(owner,slot),actor.collection);
   if(await actor.refresh()!=='owned')throw Error('Shared fixture deed collection refused');return actor;
  }
  await sharedCollection(f.buyer);
  await f.initialize();const birth=await f.birth(),bank=policyBank(birth.inventory),policy=Keypair.generate();bank.setMinted(true);policy.publicKey.toBuffer().copy(bank.row.data,bank.offsets['current']!);
  const economy=new PublicKey(f.domain.economyProgram),treasury=new PublicKey(f.domain.treasury),[configAddress,configBump]=PublicKey.findProgramAddressSync([Buffer.from('charter_transfer_config')],economy);
  const config=Buffer.concat([transferDisc('account:CharterTransferConfig'),Buffer.of(1),new PublicKey(birth.consent.chain.config).toBuffer(),treasury.toBuffer(),Buffer.alloc(2),Buffer.of(configBump)]);config.writeUInt16LE(PHASE_E_CHARTER_TRANSFER.royaltyBps,73);
  bank.rows.push({address:configAddress,owner:economy,executable:false,data:config});
  // The reusable table contains static domain/clan keys only; transfer/fence IDs
  // remain server generated and their receipt stays in the message's static keys.
  const domain={economy,craft:new PublicKey(f.domain.craftProgram),seller:new PublicKey(birth.actor.wallet),buyer:new PublicKey(f.buyer.wallet),treasury};
  const all=charterTransferAccounts(domain,{clanId:birth.consent.clanId,transferId:randomUUID(),fenceId:randomUUID(),expectedRevision:0,priceLamports:1000000000n,termsHash:Buffer.alloc(32)},Buffer.alloc(16,1));
  const derive=(program:PublicKey,seed:string)=>PublicKey.findProgramAddressSync([Buffer.from(seed)],program)[0],craft=domain.craft;
  const keys=settings.staticLookupTable?[derive(economy,'seeker_authority'),derive(economy,'charter_config'),configAddress,craft,derive(craft,'charter_control'),derive(craft,'charter_collection'),derive(craft,'charter_collection_authority'),new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'),SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram.programId,economy,treasury]:Object.entries(all).filter(([key])=>!['receipt','transferReceipt'].includes(key)).map(([,value])=>value).filter((p,i,rows)=>rows.findIndex(v=>v.equals(p))===i),data=Buffer.alloc(56+keys.length*32),lookupAddress=Keypair.generate().publicKey;
  data.writeUInt32LE(1);data.writeBigUInt64LE((1n<<64n)-1n,4);data.writeBigUInt64LE(100n,12);keys.forEach((k,i)=>k.toBuffer().copy(data,56+i*32));
  const lookupTable=new AddressLookupTableAccount({key:lookupAddress,state:AddressLookupTableAccount.deserialize(data)}),lookupRow={address:lookupAddress,owner:AddressLookupTableProgram.programId,executable:false,data};bank.rows.push(lookupRow);
  let online=true,tick=0,slot=150,finalized:VersionedTransactionResponse|null=null;const blockhash=Keypair.generate().publicKey.toBase58();
  const hooks={beforeRpc:async()=>{},beforeIssue:async()=>{},afterIssue:async()=>{},beforeLookup:async()=>{},lookupNull:false};
  const available=()=>{if(!online)throw Error('Fixture chain offline');};
  const rpc={getGenesisHash:vi.fn(async()=>{await hooks.beforeRpc();available();return f.domain.genesisHash;}),getSlot:vi.fn(async()=>{available();return slot;}),
   getMultipleAccountsInfoAndContext:vi.fn(async(...args:Parameters<typeof bank.rpc.getMultipleAccountsInfoAndContext>)=>{available();const response=await bank.rpc.getMultipleAccountsInfoAndContext(...args);return {...response,context:{slot}};}),
   getAccountInfoAndContext:vi.fn(async()=>{available();return {context:{slot},value:{owner:lookupRow.owner,executable:lookupRow.executable,data:lookupRow.data}};}),getLatestBlockhashAndContext:vi.fn(async()=>{available();return {context:{slot},value:{blockhash,lastValidBlockHeight:300}};}),
   getFeeForMessage:vi.fn(async()=>{available();return {context:{slot},value:10000};}),getMinimumBalanceForRentExemption:vi.fn(async(n:number)=>{available();return 1000+n*5;}),getBlockHeight:vi.fn(async()=>{available();return 200;}),getTransaction:vi.fn(async()=>{available();return finalized;})};
  const connect=vi.fn((_signal:AbortSignal)=>rpc),chain={connect,trust:bank.trust,expectedCurrentSigner:policy.publicKey.toBase58(),lookupTable:{address:lookupAddress.toBase58(),dataSha256:digest(data)},costLimits:{maxNetworkFeeLamports:100000n,maxRentLamports:100000n,maxAdditionalLamports:200000n}};
  const receipts=new Map<string,CharterSaleIssueReceipt>(),copy=(v:CharterSaleIssueReceipt)=>({...v,message:Buffer.from(v.message),signature:Buffer.from(v.signature)});
  const issuer:TypedCharterSaleIssuer={issueOnce:vi.fn(async(request,signal)=>{
   const prior=receipts.get(request.requestId);if(prior){if(!Buffer.from(prior.message).equals(request.message))throw Error('Issuer conflict');return copy(prior);}
   await hooks.beforeIssue();if(request.kind!=='charter-transfer-v1'||request.message.length!==161||signal.aborted)throw Error('Issuer input');
   const state=await f.store().read(currentSeller,currentId!),quote=state.attempt!.quote as CharterTransferQuote;
   // Re-run the actual pinned bank boundary independently at the issuer.
   const {connect:_connect,...quoteOptions}=chain;
   const current=await createCharterTransferQuoteReader(connect,quoteOptions)(quote.packetInput.original,Buffer.from(request.message).subarray(73,89));
   if(current.packetInput.candidateHex!==Buffer.from(request.message).toString('hex'))throw Error('Issuer stale candidate');
   const receipt={requestId:request.requestId,publicKey:policy.publicKey.toBase58(),message:Buffer.from(request.message),signature:sign(policy,request.message)};receipts.set(request.requestId,copy(receipt));await hooks.afterIssue();return copy(receipt);
  }),lookup:vi.fn(async id=>{await hooks.beforeLookup();const value=receipts.get(id);return hooks.lookupNull||!value?null:copy(value);})};
  let currentId:string|undefined,currentSeller=birth.actor.wallet;
  const actors=new Map([f.source,f.buyer].map(a=>[a.deed,a]));
  const reader=async(asset:string)=>actors.get(asset)?.proof()??null;
  async function actor(...args:Parameters<typeof f.actor>){const added=await sharedCollection(await f.actor(...args));actors.set(added.deed,added);return added;}
  function selectSale(state:CharterSaleView){currentId=state.id;currentSeller=state.original.seller;}
  async function session(wallet:string){const [saved]=await f.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {id:saved!.id,cookies:{[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,saved!.id)}};}
  const sellerAuth=await session(birth.actor.wallet),buyerAuth=await session(f.buyer.wallet);
  const options=():CharterSalesOptions=>({newSaleDomain:f.domain,chain,issuer,finalizedDeedReader:reader,deedCollection:f.buyer.collection,monotonicNow:()=>tick});
  async function open(settings:{options?:Partial<CharterSalesOptions>;provider?:CharterSalesProvider|null;runtimeDb?:Db}={}){
   const provider=settings.provider===undefined?createClanCharterSales(f.db,{...options(),...settings.options}):settings.provider,previous=process.env['MULTI_BASE_ENABLED'];process.env['MULTI_BASE_ENABLED']='false';
   try{const app=await buildApp({...TEST_CONFIG,PLAYTEST_OPEN:'true'},settings.runtimeDb??f.db);apps.push(app);registerCharterSalesRoutes(app,provider);await app.ready();return app;}
   finally{if(previous===undefined)delete process.env['MULTI_BASE_ENABLED'];else process.env['MULTI_BASE_ENABLED']=previous;}
  }
  const request=()=>({clanId:birth.consent.clanId,buyer:f.buyer.wallet,priceLamports:'1000000000',sellerLeaves:true,idempotencyKey:randomUUID()});
  const post=(app:FastifyInstance,url:string,payload:Record<string,unknown>={},cookies=sellerAuth.cookies)=>app.inject({method:'POST',url,payload,cookies});
  async function drafted(app:FastifyInstance,input=request()){const response=await post(app,salesPath,input);expect(response.statusCode,response.body).toBe(201);const state=response.json<CharterSaleView>();selectSale(state);return {input,state};}
  async function accepted(app:FastifyInstance){const p=await drafted(app),response=await post(app,`${salesPath}/${p.state.id}/accept`,{termsHash:p.state.original.termsHash,buyerBaseId:f.buyer.baseId},buyerAuth.cookies);expect(response.statusCode,response.body).toBe(200);return {...p,state:response.json<CharterSaleView>()};}
  async function prepared(app:FastifyInstance){const p=await accepted(app),response=await post(app,`${salesPath}/${p.state.id}/prepare`);
   expect(response.statusCode,response.body).toBe(200);return {...p,state:response.json<CharterSaleView>()};}
  function signed(state:CharterSaleView,omitSeller=false){const tx=VersionedTransaction.deserialize(Buffer.from(state.preparation!.packet.unsignedTransactionHex,'hex')),buyer=f.keys.get(state.original.buyer)!,seller=f.keys.get(state.original.seller)!;if(!buyer||!seller)throw Error('Missing real fixture key');tx.sign(omitSeller?[buyer]:[buyer,seller]);const bytes=Buffer.from(tx.serialize());return {tx,bytes,body:{signedTransaction:bytes.toString('base64')}};}
  async function finalize(id:string,seller=currentSeller){
   const state=await f.store().read(seller,id),quote=state.attempt!.quote as CharterTransferQuote,original=quote.packetInput.original,{domain,terms}=transferParts(original),permit=transferCandidate(original,state.attempt!.candidateHex),a=charterTransferAccounts(domain,terms,permit.permitId),tx=VersionedTransaction.deserialize(Buffer.from(state.signed!.signedTransactionHex,'hex'));
   const u32=(v:number)=>{const b=Buffer.alloc(4);b.writeUInt32LE(v);return b;},u64=(v:bigint)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(v);return b;},royalty=terms.priceLamports*BigInt(PHASE_E_CHARTER_TRANSFER.royaltyBps)/BigInt(PHASE_E_POLICY.basisPoints),time=bank.clock.readBigInt64LE(32);
   const receipt=Buffer.concat([transferDisc('account:CharterTransferReceipt'),Buffer.of(1),a.transferConfig.toBuffer(),...[terms.transferId,terms.fenceId,terms.clanId].map(charterClanIdBytes),...[a.charter,a.asset,a.seller,a.buyer,a.treasury].map(k=>k.toBuffer()),u64(terms.priceLamports),u64(terms.priceLamports-royalty),u64(royalty),u32(terms.expectedRevision),u32(terms.expectedRevision+1),Buffer.from(terms.termsHash),permit.permitId,u64(time),Buffer.of(PublicKey.findProgramAddressSync([Buffer.from('charter_transfer'),charterClanIdBytes(terms.transferId)],domain.economy)[1])]);
   bank.rows.push({address:a.transferReceipt,owner:domain.economy,executable:false,data:receipt});
   const registry=bank.rows.find(r=>r.address.equals(a.charter))!,asset=bank.rows.find(r=>r.address.equals(a.asset))!;a.buyer.toBuffer().copy(registry.data,121);registry.data.writeUInt32LE(terms.expectedRevision+1,153);a.buyer.toBuffer().copy(asset.data,1);
   if(tx.message.version!==0)throw Error('Fixture requires canonical v0');
   const loaded=tx.message.resolveAddressTableLookups([lookupTable]),keys=[...tx.message.staticAccountKeys,...loaded.writable,...loaded.readonly],pre=keys.map(()=>3000000000),post=[...pre],fee=10000,rent=4878960;
   keys.forEach((k,i)=>{if(k.equals(a.buyer))post[i]!-=Number(terms.priceLamports)+fee+rent;else if(k.equals(a.seller))post[i]!+=Number(terms.priceLamports-royalty);else if(k.equals(a.treasury))post[i]!+=Number(royalty);else if(k.equals(a.transferReceipt))post[i]!+=rent;});
   slot++;finalized={slot,version:0,transaction:{message:tx.message,signatures:tx.signatures.map(s=>bs58.encode(s))},meta:{err:null,fee,preBalances:pre,postBalances:post,loadedAddresses:loaded}} as unknown as VersionedTransactionResponse;
   bank.clock.writeBigUInt64LE(BigInt(slot));
  }
  async function dispose(){try{await Promise.all(apps.splice(0).map(app=>app.close()));}finally{await f.dispose();}}
  return {...f,actor,reader,birth,bank,policy,chain,issuer,connect,rpc,hooks,receipts,options,open,session,sellerAuth,buyerAuth,request,post,drafted,accepted,prepared,signed,finalize,selectSale,dispose,setOnline:(v:boolean)=>{online=v;},setTick:(v:number)=>{tick=v;}};
 }catch(error){await f.dispose();throw error;}
}
export type SalesWorkflowFixture=Awaited<ReturnType<typeof charterSalesWorkflowFixture>>;
