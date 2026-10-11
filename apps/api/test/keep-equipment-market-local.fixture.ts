/** Manual actual API + SQL + local Classic SPL acceptance, never a public RPC.
 * Run: PHASE_E_KEEP_LOCAL_FIXTURE=1 pnpm exec tsx test/keep-equipment-market-local.fixture.ts
 * Both named adapters target one owned bank; this proves composition, not
 * independent production RPC operation. No durable keys or live player writes. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Keypair,Message,MessageV0,VersionedTransaction} from '@solana/web3.js';
import type {FastifyInstance} from 'fastify';
import type {KeepEquipmentPaymentDependencies} from '../src/game/keepEquipmentPayments';
import {PHASE_E_KEEP_EQUIPMENT_MARKET,PHASE_E_POLICY,TOKEN} from '@shardkeep/shared';
import {KeepEquipmentListingSchema,KeepEquipmentPurchaseSchema,KeepEquipmentReviewSchema,KeepEquipmentSendSchema,KeepEquipmentMarketPolicySchema} from '@shardkeep/shared/keepEquipmentMarketApi';
import {openKeepEquipmentLocal} from './fixtures/keepEquipmentMarketLocal';

async function main(){
 assert.equal(process.env['PHASE_E_KEEP_LOCAL_FIXTURE'],'1','Explicit local fixture mode is required');
 const failureOnly=process.env['PHASE_E_KEEP_LOCAL_FAILURE_ONLY']==='1';
 const local=await openKeepEquipmentLocal();let app:FastifyInstance|undefined,closeDatabase:(()=>Promise<void>)|undefined;
 try{
  process.env['NODE_ENV']='test';process.env['TEST_DATABASE_URL']=local.databaseUrl;process.env['TEST_REDIS_URL']=local.redisUrl;
  for(const flag of ['MULTI_BASE_ENABLED','KEEP_EQUIPMENT_MARKET_ENABLED','PHASE_E_CATALOG_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_MINING_ENABLED','PHASE_E_SEEKER_ENABLED','PHASE_E_VEHICLES_ENABLED','PHASE_E_CHARTER_ENABLED','ENABLE_WORKERS'])process.env[flag]='false';
  const [{createKeepEquipmentMarketProvider},{createDb},{runMigrations},{bootstrapEconomyAllocations},{buildApp},{TEST_CONFIG},{sessions},{issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC}]=await Promise.all([
   import('../src/game/keepEquipmentMarketProvider'),
   import('../src/db/client'),import('../src/db/migrate'),import('../src/ledger'),import('../src/app'),import('./helpers'),import('../src/db/schema'),import('../src/auth/session'),
  ]);
  const conn=createDb(local.databaseUrl,{max:8,legacyTestEscape:true});closeDatabase=()=>conn.sql.end();
  await runMigrations(conn.db);await bootstrapEconomyAllocations(conn.db);
  const collection=Keypair.generate().publicKey.toBase58(),owners=new Map<string,string>(),config={...TEST_CONFIG,DATABASE_URL:local.databaseUrl,REDIS_URL:local.redisUrl,SOLANA_RPC_URL:local.endpoint,PLAYTEST_OPEN:'true' as const};
  async function player(available:string){
   const signer=Keypair.generate(),wallet=signer.publicKey.toBase58(),baseId=randomUUID(),deed=Keypair.generate().publicKey.toBase58();owners.set(deed,wallet);
   await conn.sql`insert into players(wallet) values(${wallet})`;
   await conn.sql`insert into bases(id,owner_wallet,deed_asset_id,land_paid_at) values(${baseId},${wallet},${deed},now())`;
   await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${baseId})`;
   await conn.sql`insert into ordinary_equipment_stocks(base_id,item_id,available) values(${baseId},'route_compass',${available}::bigint)`;
   const [session]=await conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
   return {signer,wallet,baseId,deed,cookies:{[SESSION_COOKIE]:await issueSessionJwt(config,wallet,session!.id)}};
  }
  async function open(payments:KeepEquipmentPaymentDependencies){
   assert(payments.trust,'Owned local fixture requires explicit private trust');
   await app?.close();app=undefined;
   // App startup must not create ambient multi-base dependencies. The dedicated
   // private route gets its own finalized deed fixture and pinned local readers.
   process.env['MULTI_BASE_ENABLED']='false';
   app=await buildApp(config,conn.db,{keepEquipmentMarket:createKeepEquipmentMarketProvider(conn.db,{deedCollection:collection,finalizedDeedReader:async asset=>({owner:owners.get(asset)!,collection,frozen:false,delegate:null,slot:100}),payments,releases:{trust:payments.trust,failureConnect:[signal=>local.connect(signal),signal=>local.connect(signal)]}})});
   await app.ready();process.env['MULTI_BASE_ENABLED']='true';
  }
  async function post(path:string,cookies:Record<string,string>,body:unknown={}){
   assert(app);const reply=await app.inject({method:'POST',url:'/keep-equipment-market'+path,cookies,headers:{'content-type':'application/json'},payload:JSON.stringify(body)});
   assert.equal(reply.statusCode,200,`${path}: ${reply.body}`);assert.equal(reply.headers['cache-control'],'private, no-store');return reply.json() as unknown;
  }
  const results=[];
  for(const version of ['legacy',0] as const){
   const seller=await player('1'),buyer=await player('0'),existing=version==='legacy',token=await local.tokens(buyer.signer,seller.signer.publicKey,existing),total=PHASE_E_KEEP_EQUIPMENT_MARKET.minFillBaseUnits+1n;
   const sellerAmount=total*BigInt(PHASE_E_POLICY.taxes.keepMarket.sellerBps)/BigInt(PHASE_E_POLICY.basisPoints),burn=total-sellerAmount;
   let sendCount=0,fillId='',retainedHex='';
   const deps:KeepEquipmentPaymentDependencies={trust:{transactionVersion:version,expectedGenesisHash:local.genesis,expectedKeepMint:token.mint.toBase58(),providerIds:['owned-bank-adapter-one','owned-bank-adapter-two'],minContextSlot:1,deadlineMs:10_000,maxFeeLamports:100_000n,maxPriorityFeeLamports:0n,maxComputeUnitLimit:300_000},
    preparationConnect:[signal=>local.connect(signal),signal=>local.connect(signal)],finalityConnect:[signal=>local.connect(signal),signal=>local.connect(signal)],
    broadcastConnect:signal=>{const rpc=local.connect(signal);return {getGenesisHash:()=>rpc.getGenesisHash(),getSlot:commitment=>rpc.getSlot(commitment),sendRawTransaction:async(bytes,options)=>{
     const [saved]=await conn.sql`select signature,encode(signed_transaction,'hex') wire from keep_equipment_payment_wires where fill_id=${fillId}`;
     assert(saved,'The signed original must commit before any network send');assert.equal(saved.wire,retainedHex);assert.equal(Buffer.from(bytes).toString('hex'),retainedHex);
     const [claim]=await conn.sql`select consumer_kind,consumer_id from payment_signature_claims where signature=${saved.signature}`;assert.deepEqual(claim,{consumer_kind:'keep_equipment_market',consumer_id:fillId});
     assert.equal(options.skipPreflight,false);assert.equal(options.preflightCommitment,'finalized');assert.equal(options.maxRetries,0);sendCount++;
     return rpc.sendRawTransaction(bytes,options);
    }};},
   };
   process.env['KEEP_EQUIPMENT_MARKET_ENABLED']='true';await open(deps);
   const offer=KeepEquipmentListingSchema.parse(await post('/listings',seller.cookies,{idempotencyKey:randomUUID(),baseId:seller.baseId,itemId:'route_compass',quantity:'1',unitPriceBaseUnits:total.toString()}));
   const reserved=KeepEquipmentPurchaseSchema.parse(await post('/fills',buyer.cookies,{idempotencyKey:randomUUID(),listingId:offer.id,buyerBaseId:buyer.baseId,quantity:'1'}));fillId=reserved.fill.id;assert.equal(reserved.status,'reserved');
   const prepared=KeepEquipmentPurchaseSchema.parse(await post(`/fills/${fillId}/prepare`,buyer.cookies)),p=prepared.preparation;assert(p);assert.equal(p.original.sellerAtaExists,existing);assert.equal(p.expectedGenesisHash,local.genesis);assert.equal(p.expectedKeepMint,token.mint.toBase58());
   const review=KeepEquipmentReviewSchema.parse(await post(`/fills/${fillId}/review`,buyer.cookies));assert.equal(review.current.messageHex,p.messageHex);assert.equal(review.current.messageSha256,p.messageSha256);
   const tx=new VersionedTransaction(version==='legacy'?Message.from(Buffer.from(p.messageHex,'hex')):MessageV0.deserialize(Buffer.from(p.messageHex,'hex')));tx.sign([buyer.signer]);retainedHex=Buffer.from(tx.serialize()).toString('hex');
   const retained=KeepEquipmentPurchaseSchema.parse(await post(`/fills/${fillId}/signed`,buyer.cookies,{signedTransactionHex:retainedHex}));assert.equal(retained.status,'signed');assert(retained.wire);
   assert.deepEqual(Array.from(await conn.sql`select available::text,market_incoming::text from ordinary_equipment_stocks where base_id=${buyer.baseId}`),[{available:'0',market_incoming:'1'}]);
   if(failureOnly){
    // A real fee-only bank failure must be included despite preflight. This
    // fixture-only direct send is NOT evidence of production relay behavior.
    await local.burnForFailure(buyer.signer,token.mint,token.buyerAta,token.initial-sellerAmount);
    const before={sol:await local.connection.getBalance(buyer.signer.publicKey,'finalized'),supply:(await local.connection.getTokenSupply(token.mint,'finalized')).value.amount,buyer:(await local.connection.getTokenAccountBalance(token.buyerAta,'finalized')).value.amount,seller:existing?(await local.connection.getTokenAccountBalance(token.sellerAta,'finalized')).value.amount:null};
    assert.equal(before.buyer,sellerAmount.toString());assert.equal(before.supply,sellerAmount.toString());
    assert.equal(await local.connection.sendRawTransaction(Buffer.from(retainedHex,'hex'),{skipPreflight:true,maxRetries:0}),retained.wire.signature);
    await local.finalized(retained.wire.signature,p.lastValidBlockHeight,true);
    const raw=await local.connection.getTransaction(retained.wire.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});assert(raw?.meta?.err);assert.deepEqual(raw.meta.err,{InstructionError:[existing?1:2,{Custom:1}]});
    await writeFile(join(local.directory,`${version}-actual-failed-transaction.json`),JSON.stringify(raw,null,2)+'\n');
    const after={sol:await local.connection.getBalance(buyer.signer.publicKey,'finalized'),supply:(await local.connection.getTokenSupply(token.mint,'finalized')).value.amount,buyer:(await local.connection.getTokenAccountBalance(token.buyerAta,'finalized')).value.amount,seller:existing?(await local.connection.getTokenAccountBalance(token.sellerAta,'finalized')).value.amount:null};
    assert.equal(before.sol-after.sol,raw.meta.fee);assert.equal(after.supply,before.supply);assert.equal(after.buyer,before.buyer);assert.equal(after.seller,before.seller);
    if(!existing)assert.equal(await local.connection.getAccountInfo(token.sellerAta,'finalized'),null,'Failed ATA creation and its rent must roll back');
    const {refreshBaseOwnership}=await import('../src/game/baseOwnership');
    for(const actor of [buyer,seller]){const next=Keypair.generate().publicKey.toBase58(),now=new Date();owners.set(actor.deed,next);await conn.sql`insert into players(wallet) values(${next})`;
     assert.equal(await refreshBaseOwnership(conn.db,actor.baseId,async()=>({owner:next,collection,frozen:false,delegate:null,slot:200}),collection,now,'local-keep-failed-transfer',()=>now),'mismatch');
     await conn.sql`update bases set status='active' where id=${actor.baseId}`;await conn.sql`insert into base_slots(wallet,slot,base_id) values(${next},1,${actor.baseId})`;
     assert.equal(await refreshBaseOwnership(conn.db,actor.baseId,async()=>({owner:next,collection,frozen:false,delegate:null,slot:201}),collection,now,'local-keep-new-owner',()=>now),'owned');
    }
    process.env['KEEP_EQUIPMENT_MARKET_ENABLED']='false';await open(deps);
    const [a,b]=await Promise.all([post(`/fills/${fillId}/release`,buyer.cookies),post(`/fills/${fillId}/release`,buyer.cookies)]),released=KeepEquipmentPurchaseSchema.parse(a);assert.deepEqual(a,b);
    assert.equal(released.status,'released');assert.equal(released.release?.reason,'finalized_failed');assert.equal(released.delivery,null);assert.deepEqual(released.preparation,p);assert.deepEqual(released.wire,retained.wire);assert.equal(released.release?.proof?.feeLamports,String(raw.meta.fee));
    assert.equal(released.release?.proof?.paidKeepBaseUnits,'0');assert.equal(released.release?.proof?.rentLamports,'0');
    await open(deps);assert.deepEqual(await post(`/fills/${fillId}/recover`,buyer.cookies),released);
    const late=KeepEquipmentSendSchema.parse(await post(`/fills/${fillId}/deliver`,buyer.cookies));assert.equal(late.status,'held');assert.deepEqual(late.purchase,released);assert.equal(sendCount,0);
    assert.deepEqual(Array.from(await conn.sql`select available::text,market_outgoing::text from ordinary_equipment_stocks where base_id=${seller.baseId}`),[{available:'1',market_outgoing:'0'}]);
    assert.deepEqual(Array.from(await conn.sql`select available::text,market_incoming::text from ordinary_equipment_stocks where base_id=${buyer.baseId}`),[{available:'0',market_incoming:'0'}]);
    assert.equal((await conn.sql`select fill_id from keep_equipment_fill_releases where fill_id=${fillId}`).length,1);assert.equal((await conn.sql`select fill_id from keep_equipment_deliveries where fill_id=${fillId}`).length,0);
    assert.deepEqual(Array.from(await conn.sql`select consumer_kind,consumer_id from payment_signature_claims where signature=${retained.wire.signature}`),[{consumer_kind:'keep_equipment_market',consumer_id:fillId}]);
    const policyReply=await app!.inject({url:'/keep-equipment-market/policy?version=1',cookies:buyer.cookies});assert.equal(policyReply.statusCode,200);
    await writeFile(join(local.directory,`${version}-released-purchase.json`),JSON.stringify({purchase:released,policy:KeepEquipmentMarketPolicySchema.parse(policyReply.json())},null,2)+'\n');
    results.push({version,sellerAta:existing?'existing':'creation rolled back',fillId,signature:retained.wire.signature,messageSha256:p.messageSha256,evidenceSha256:released.release!.proof!.evidenceSha256,before,after,feeLamports:raw.meta.fee,realExecutionError:raw.meta.err,actualSupplyBurn:'0',sellerCredit:'0',releasedEquipment:'1',deliveredEquipment:'0',productionRelayCount:sendCount,fixtureForcedInclusion:true,pauseRestartTransferRecovery:true,globalSignatureFenceRetained:true});
    console.log(JSON.stringify({completed:results.at(-1)}));await app!.close();app=undefined;continue;
   }
   const sent=KeepEquipmentSendSchema.parse(await post(`/fills/${fillId}/deliver`,buyer.cookies));assert.equal(sent.status,'submitted');assert.equal(sent.purchase.status,'signed');assert.equal(sendCount,1);
   await local.finalized(retained.wire.signature,p.lastValidBlockHeight);
   const raw=await local.connection.getTransaction(retained.wire.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});assert(raw);await writeFile(join(local.directory,`${version}-actual-transaction.json`),JSON.stringify(raw,null,2)+'\n');
   // Close the actual Fastify/service instances and pause all new admission after
   // payment. Saved actor, wire and original base still authorize paid recovery.
   process.env['KEEP_EQUIPMENT_MARKET_ENABLED']='false';await open(deps);
   const policyReply=await app!.inject({url:'/keep-equipment-market/policy?version=1',cookies:buyer.cookies});assert.equal(policyReply.statusCode,200,policyReply.body);
   const policy=KeepEquipmentMarketPolicySchema.parse(policyReply.json());assert.equal(policy.version,PHASE_E_KEEP_EQUIPMENT_MARKET.policyVersion);assert.equal(policy.sellerBps,PHASE_E_POLICY.taxes.keepMarket.sellerBps);assert.equal(policy.basisPoints,PHASE_E_POLICY.basisPoints);assert.equal(policy.decimals,TOKEN.decimals);
   assert.equal((await app!.inject({url:'/keep-equipment-market/policy?version=2',cookies:buyer.cookies})).statusCode,400);
   const recovered=KeepEquipmentPurchaseSchema.parse(await post(`/fills/${fillId}/recover`,buyer.cookies));assert.equal(recovered.status,'delivered');assert(recovered.delivery);
   assert.equal(recovered.delivery.proof.sellerBaseUnits,sellerAmount.toString());assert.equal(recovered.delivery.proof.burnBaseUnits,burn.toString());assert.equal(recovered.delivery.proof.sellerAtaCreated,!existing);
   assert.equal(recovered.delivery.buyerBaseId,buyer.baseId);assert.deepEqual(recovered.wire,retained.wire);
   const replay=KeepEquipmentSendSchema.parse(await post(`/fills/${fillId}/deliver`,buyer.cookies));assert.equal(replay.status,'delivered');assert.deepEqual(replay.purchase,recovered);assert.equal(sendCount,1);
   assert.deepEqual(Array.from(await conn.sql`select available::text,market_outgoing::text from ordinary_equipment_stocks where base_id=${seller.baseId}`),[{available:'0',market_outgoing:'0'}]);
   assert.deepEqual(Array.from(await conn.sql`select available::text,market_incoming::text from ordinary_equipment_stocks where base_id=${buyer.baseId}`),[{available:'1',market_incoming:'0'}]);
   assert.equal((await conn.sql`select fill_id from keep_equipment_deliveries where fill_id=${fillId}`).length,1);
   const supply=await local.connection.getTokenSupply(token.mint,'finalized'),buyerBalance=await local.connection.getTokenAccountBalance(token.buyerAta,'finalized'),sellerBalance=await local.connection.getTokenAccountBalance(token.sellerAta,'finalized');
   assert.equal(supply.value.amount,(token.initial-burn).toString());assert.equal(buyerBalance.value.amount,(token.initial-total).toString());assert.equal(sellerBalance.value.amount,sellerAmount.toString());
   results.push({version,sellerAta:existing?'existing':'created',fillId,mint:token.mint.toBase58(),signature:retained.wire.signature,messageSha256:p.messageSha256,evidenceSha256:recovered.delivery.proof.evidenceSha256,initialSupply:token.initial.toString(),mintSupply:supply.value.amount,actualSupplyBurn:burn.toString(),sellerCredit:sellerBalance.value.amount,buyerSpent:total.toString(),deliveredEquipment:'1',relayCount:sendCount,pauseRestartRecovery:true});
   console.log(JSON.stringify({completed:results.at(-1)}));await app!.close();app=undefined;
  }
  const report={kind:failureOnly?'actual local failed signed payments and authenticated API stock release':'actual local authenticated API, SQL and SPL composition',genesis:local.genesis,validatorPid:local.validatorPid,containerName:local.name,twoIndependentProvidersProven:false,deedOwnershipUsesFixtureReader:true,results};
  const path=join(local.directory,'report.json');await writeFile(path,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({report:path,...report},null,2));
 }finally{
  try{await app?.close();}finally{
   try{await closeDatabase?.();}finally{await local.close();console.log(JSON.stringify({ownedResourcesStopped:true,directory:local.directory}));}
  }
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
