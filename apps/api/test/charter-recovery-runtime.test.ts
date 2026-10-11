/** Genuine saved workflow originals, encoded finalized fixture banks, actual
 * loopback RPC and provisioned owner/request composition. No live issuance. */
import {createServer} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Keypair,PublicKey} from '@solana/web3.js';
import bs58 from 'bs58';
import {SOLANA_GENESIS_HASH} from '@shardkeep/chain';
import type {CharterCreationEvidenceTrust} from '@shardkeep/chain/charter-creation-evidence';
import type {CharterTransferRpc} from '@shardkeep/chain/charter-transfer-evidence';
import {afterEach,expect,it,vi} from 'vitest';
import {createCharterRecoveryRuntime} from '../src/game/clanCharterRecoveryRuntime';
import {createClanCharterClient} from '../src/game/clanCharterClient';
import {createPhaseEServices} from '../src/phaseEServices';
import {createDb} from '../src/db/client';
import {buildApp} from '../src/app';
import {loadConfig,type Config} from '../src/config';
import {TEST_CONFIG} from './helpers';
import {releaseMigratedTemplates} from './migratedTemplate';
import {charterCreationWorkflowFixture,charterPath} from './fixtures/charterCreationWorkflow';
import {charterSalesWorkflowFixture,salesPath} from './fixtures/charterSalesWorkflow';

afterEach(()=>vi.unstubAllEnvs());
function pins(t:CharterCreationEvidenceTrust){return {
 CHARTER_RECOVERY_ECONOMY_PROGRAM_ID:t.economy.programId,CHARTER_RECOVERY_ECONOMY_DEPLOYMENT_SLOT:t.economy.reviewedDeploymentSlot,
 CHARTER_RECOVERY_ECONOMY_PROGRAM_DATA_SHA256:t.economy.reviewedProgramDataSha256,CHARTER_RECOVERY_ECONOMY_UPGRADE_AUTHORITY:t.economy.upgradeAuthority??'none',
 CHARTER_RECOVERY_CRAFT_PROGRAM_ID:t.craft.programId,CHARTER_RECOVERY_CRAFT_DEPLOYMENT_SLOT:t.craft.reviewedDeploymentSlot,
 CHARTER_RECOVERY_CRAFT_PROGRAM_DATA_SHA256:t.craft.reviewedProgramDataSha256,CHARTER_RECOVERY_CRAFT_UPGRADE_AUTHORITY:t.craft.upgradeAuthority??'none',
 CHARTER_RECOVERY_CORE_DEPLOYMENT_SLOT:t.core.reviewedDeploymentSlot,CHARTER_RECOVERY_CORE_PROGRAM_DATA_SHA256:t.core.reviewedProgramDataSha256,
 CHARTER_RECOVERY_CORE_UPGRADE_AUTHORITY:t.core.upgradeAuthority??'none',CHARTER_RECOVERY_STATE_PROVENANCE:t.stateProvenance,
};}
function trust():CharterCreationEvidenceTrust{
 const p=(id=Keypair.generate().publicKey.toBase58())=>({programId:id,reviewedDeploymentSlot:1,reviewedProgramDataSha256:'1'.repeat(64),upgradeAuthority:null});
 return {expectedGenesisHash:SOLANA_GENESIS_HASH.devnet,economy:p(),craft:p(),core:p('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'),stateProvenance:'fresh-reviewed-deployment'};
}
it('requires complete independent trust and exposes only four captured reads',()=>{
 expect(createCharterRecoveryRuntime(TEST_CONFIG)).toBeNull();
 const fields=pins(trust()),env={DATABASE_URL:TEST_CONFIG.DATABASE_URL,JWT_SECRET:TEST_CONFIG.JWT_SECRET,WEB_ORIGIN:TEST_CONFIG.WEB_ORIGIN[0],NODE_ENV:'test'};
 const strings=Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,String(value)]));
 expect(createCharterRecoveryRuntime(loadConfig({...env,...Object.fromEntries(Object.keys(fields).map(key=>[key,'']))}))).toBeNull();
 for(const key of Object.keys(fields))expect(()=>loadConfig({...env,...strings,[key]:undefined})).toThrow();
 for(const patch of [{CHARTER_RECOVERY_CORE_DEPLOYMENT_SLOT:-1},{CHARTER_RECOVERY_CORE_PROGRAM_DATA_SHA256:'bad'},
  {CHARTER_RECOVERY_CRAFT_PROGRAM_ID:fields.CHARTER_RECOVERY_ECONOMY_PROGRAM_ID},{CHARTER_RECOVERY_CORE_UPGRADE_AUTHORITY:PublicKey.default.toBase58()}])
  expect(()=>createCharterRecoveryRuntime({...TEST_CONFIG,...fields,...patch})).toThrow();
 const runtime=createCharterRecoveryRuntime({...TEST_CONFIG,...fields})!;
 expect(Object.keys(runtime.source.connect(new AbortController().signal)).sort()).toEqual(['getGenesisHash','getMultipleAccountsInfoAndContext','getSlot','getTransaction']);runtime.close();
});
it('aborts an actual stalled RPC and retained methods after process close',async()=>{
 let arrived!:()=>void;const entered=new Promise<void>(resolve=>arrived=resolve);let calls=0;
 const server=createServer(()=>{calls++;arrived();});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address();if(!port||typeof port==='string')throw Error('No port');
 const runtime=createCharterRecoveryRuntime({...TEST_CONFIG,...pins(trust()),SOLANA_RPC_URL:`http://127.0.0.1:${port.port}`})!,read=runtime.source.connect(new AbortController().signal).getGenesisHash;
 try{const pending=read(),refused=expect(pending).rejects.toThrow();await entered;runtime.close();await refused;await expect(read()).rejects.toThrow();expect(calls).toBe(1);expect(()=>runtime.source.connect(new AbortController().signal)).toThrow();}
 finally{runtime.close();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
async function loopback(source:CharterTransferRpc){
 const seen:string[]=[];
 const server=createServer(async(req,res)=>{try{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw) as {id:string;method:string;params:unknown[]};seen.push(body.method);let result:unknown;
  if(body.method==='getGenesisHash')result=await source.getGenesisHash();
  else if(body.method==='getSlot')result=await source.getSlot('finalized');
  else if(body.method==='getMultipleAccounts'){
   const options=body.params[1] as {commitment:'finalized';minContextSlot:number};expect(options.commitment).toBe('finalized');
   const value=await source.getMultipleAccountsInfoAndContext((body.params[0] as string[]).map(key=>new PublicKey(key)),options);
   result={context:value.context,value:value.value.map(row=>row?{owner:row.owner.toBase58(),executable:row.executable,data:[Buffer.from(row.data).toString('base64'),'base64'],lamports:1,rentEpoch:0}:null)};
  }else if(body.method==='getTransaction'){
   const tx=await source.getTransaction(body.params[0] as string,body.params[1] as {commitment:'finalized';maxSupportedTransactionVersion:0});
   if(!tx)result=null;else{const m=tx.transaction.message;result={...tx,meta:{...tx.meta,loadedAddresses:tx.meta?.loadedAddresses?{writable:tx.meta.loadedAddresses.writable.map(k=>k.toBase58()),readonly:tx.meta.loadedAddresses.readonly.map(k=>k.toBase58())}:undefined},transaction:{signatures:tx.transaction.signatures,message:{header:m.header,accountKeys:m.staticAccountKeys.map(k=>k.toBase58()),recentBlockhash:m.recentBlockhash,instructions:m.compiledInstructions.map(ix=>({programIdIndex:ix.programIdIndex,accounts:ix.accountKeyIndexes,data:bs58.encode(ix.data)})),addressTableLookups:m.addressTableLookups.map(t=>({accountKey:t.accountKey.toBase58(),writableIndexes:t.writableIndexes,readonlyIndexes:t.readonlyIndexes}))}}};}
  }else throw Error('Unexpected RPC '+body.method);
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
 }catch(error){res.statusCode=500;res.end(String(error));}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('No port');
 return {url:`http://127.0.0.1:${address.port}`,seen,close:async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}
async function privateRuntime(ownerUrl:URL,t:CharterCreationEvidenceTrust,url:string){
 const role=`charter_runtime_${randomUUID().replaceAll('-','')}`,worker=`charter_worker_${randomUUID().replaceAll('-','')}`,password=randomBytes(32).toString('hex');
 execFileSync('sh',[fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh',import.meta.url))],{timeout:30_000,maxBuffer:2*1024*1024,env:{PATH:process.env.PATH,
  PGHOST:ownerUrl.hostname,PGPORT:ownerUrl.port,PGDATABASE:ownerUrl.pathname.slice(1),PGUSER:decodeURIComponent(ownerUrl.username),PGPASSWORD:decodeURIComponent(ownerUrl.password),
  POSTGRES_USER:decodeURIComponent(ownerUrl.username),POSTGRES_PASSWORD:decodeURIComponent(ownerUrl.password),DB_ROLE_MODE:'isolated',SOLANA_CLUSTER:'devnet',API_DB_USER:role,API_DB_PASSWORD:password,WORKER_DB_USER:worker,WORKER_DB_PASSWORD:randomBytes(32).toString('hex')}});
 const requestUrl=new URL(ownerUrl);requestUrl.username=role;requestUrl.password=password;const request=createDb(requestUrl.toString(),{max:2});
 const config:Config={...TEST_CONFIG,...pins(t),DATABASE_URL:requestUrl.toString(),PHASE_E_SERVICE_DATABASE_URL:ownerUrl.toString(),SOLANA_RPC_URL:url,PLAYTEST_OPEN:'true'};
 const source=createCharterRecoveryRuntime(config)!;
 const open=async(withSource=true,recovery=source.source)=>{const services=await createPhaseEServices(config,request.db,{},undefined,undefined,undefined,undefined,undefined,withSource?recovery:undefined);
  return {services:services!,app:await buildApp(config,request.db,services!.deps)};};
 return {request,config,source,open,roles:[role,worker,'shardkeep_api_runtime','shardkeep_worker_runtime']};
}
it.each(['activated','cancelled_unpaid'] as const)('recovers original creation %s through actual private startup without new issuance',async outcome=>{
 const f=await charterCreationWorkflowFixture({genesisHash:SOLANA_GENESIS_HASH.devnet,staticLookupTable:true});
 let mounted:Awaited<ReturnType<Awaited<ReturnType<typeof privateRuntime>>['open']>>|undefined;
 let p:Awaited<ReturnType<typeof privateRuntime>>|undefined,rpc:Awaited<ReturnType<typeof loopback>>|undefined;
 try{
  const setup=await f.open(),saved=await f.prepared(setup),id=saved.input.creationIntentId;await f.sync(id,outcome==='activated');
  if(outcome==='cancelled_unpaid')f.bank.clock.writeBigInt64LE(BigInt(saved.state.policy!.expiry)+1n,32);
  rpc=await loopback({...f.rpc,getTransaction:async()=>null});p=await privateRuntime(await f.ownerUrl(),f.chain.trust,rpc.url);mounted=await p.open();
  const path=`/clans/charter/client/creations/${id}`,cookies=f.auth.cookies,headers={origin:p.config.WEB_ORIGIN[0]!};
  p.config.SOLANA_RPC_URL='http://127.0.0.1:1';
  const calls=rpc.seen.length;
  expect((await mounted.app.inject({method:'POST',url:path+'/recover',payload:{}})).statusCode).toBe(401);expect(rpc.seen).toHaveLength(calls);
  const newAttempt=await mounted.app.inject({method:'POST',url:'/clans/charter/client/creations',payload:f.request(),cookies,headers});expect(newAttempt.statusCode,newAttempt.body).toBe(503);
  const wrong=createCharterRecoveryRuntime({...p.config,SOLANA_RPC_URL:rpc.url,CHARTER_RECOVERY_CORE_PROGRAM_DATA_SHA256:'0'.repeat(64)})!,held=await p.open(true,wrong.source);
  try{const refused=await held.app.inject({method:'POST',url:path+'/recover',payload:{},cookies,headers});expect(refused.statusCode,refused.body).toBe(503);}
  finally{await held.app.close();await held.services.close();wrong.close();}
  const other=await f.actor(),foreign=await f.session(other.wallet),beforeForeign=rpc.seen.length;
  const refused=await mounted.app.inject({method:'POST',url:path+'/recover',payload:{},cookies:foreign.cookies,headers});expect(refused.statusCode,refused.body).toBe(404);expect(rpc.seen).toHaveLength(beforeForeign);
  vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');
  const reply=await mounted.app.inject({method:'POST',url:path+'/recover',payload:{},cookies,headers});expect(reply.statusCode,reply.body).toBe(200);expect(reply.json().state.status).toBe(outcome);
  expect(f.issuer.issueOnce).toHaveBeenCalledTimes(1);expect(rpc.seen).not.toContain('sendTransaction');
  await expect(p.request.sql`select * from charter_creation_terminals`).rejects.toMatchObject({code:'42501'});
  await expect(p.request.sql`insert into charter_creation_terminals default values`).rejects.toMatchObject({code:'42501'});
  if(outcome==='cancelled_unpaid'){
   const refund=await mounted.app.inject({method:'POST',url:path+'/refund',payload:{},cookies,headers});expect(refund.statusCode,refund.body).toBe(200);expect(refund.json().state.status).toBe('refunded');
  }
  const final=await mounted.app.inject({url:path,cookies});expect(final.statusCode,final.body).toBe(200);
  await mounted.app.close();await mounted.services.close();p.source.close();mounted=await p.open(false);const before=rpc.seen.length;
  const recovered=await mounted.app.inject({method:'POST',url:path+'/recover',payload:{},cookies,headers});expect(recovered.statusCode,recovered.body).toBe(200);expect(recovered.json()).toEqual(final.json());expect(recovered.headers['cache-control']).toBe('private, no-store');expect(rpc.seen).toHaveLength(before);
 }finally{
  await mounted?.app.close();await mounted?.services.close();p?.source.close();await p?.request.sql.end();
  // A migrated template holds GRANTs to the groups; release it before dropping them.
  // Dispose even when DROP ROLE fails: a leaked fixture database keeps GRANTs to the groups (K-night-R3b).
  await releaseMigratedTemplates();try{for(const role of p?.roles??[])await f.sql.unsafe(`drop owned by ${role};drop role ${role}`);}finally{await rpc?.close();await f.dispose();}
 }
},120_000);
it.each(['completed','cancelled'] as const)('recovers original sale %s with original transaction or full expiry bank',async outcome=>{
 const f=await charterSalesWorkflowFixture({staticLookupTable:true,domain:{genesisHash:SOLANA_GENESIS_HASH.devnet,economyProgram:Keypair.generate().publicKey.toBase58()}});
 let mounted:Awaited<ReturnType<Awaited<ReturnType<typeof privateRuntime>>['open']>>|undefined;
 let p:Awaited<ReturnType<typeof privateRuntime>>|undefined,rpc:Awaited<ReturnType<typeof loopback>>|undefined;
 try{
  const setup=await f.open(),saved=await f.prepared(setup),id=saved.state.id;
  const client=createClanCharterClient(f.db),original=await client.readSale(f.birth.actor.wallet,id),wire=f.signed(saved.state);
  for(const [i,actor] of [f.buyer.wallet,f.birth.actor.wallet].entries())await client.retainSaleSignature(actor,id,{attemptId:original.signing!.attemptId,messageSha256:original.signing!.packet.messageSha256,signature:Buffer.from(wire.tx.signatures[i]!).toString('base64')});
  if(outcome==='completed')await f.finalize(id);else{const state=await f.store().read(f.birth.actor.wallet,id);f.bank.clock.writeBigInt64LE(Buffer.from(state.attempt!.candidateHex,'hex').readBigInt64LE(121)+1n,32);}
  rpc=await loopback(f.rpc);p=await privateRuntime(await f.ownerUrl(),f.chain.trust,rpc.url);mounted=await p.open();
  const path=`/clans/charter/client/sales/${id}`,cookies=f.sellerAuth.cookies,headers={origin:p.config.WEB_ORIGIN[0]!};
  const activity=await mounted.app.inject({url:'/clans/charter/client/activity',cookies});expect(activity.statusCode,activity.body).toBe(200);expect(activity.json().newActions).toEqual({creation:false,sale:false});
  const newAttempt=await mounted.app.inject({method:'POST',url:'/clans/charter/client/sales',payload:{...f.request(),clanId:randomUUID()},cookies,headers});expect(newAttempt.statusCode).not.toBe(201);
  const wrong=createCharterRecoveryRuntime({...p.config,SOLANA_RPC_URL:rpc.url,CHARTER_RECOVERY_CORE_PROGRAM_DATA_SHA256:'0'.repeat(64)})!,held=await p.open(true,wrong.source);
  try{const refused=await held.app.inject({method:'POST',url:path+'/recover',payload:{},cookies,headers});expect(refused.statusCode,refused.body).toBe(503);}
  finally{await held.app.close();await held.services.close();wrong.close();}
  const other=await f.actor(),foreign=await f.session(other.wallet),beforeForeign=rpc.seen.length;
  const refused=await mounted.app.inject({method:'POST',url:path+'/recover',payload:{},cookies:foreign.cookies,headers});expect(refused.statusCode,refused.body).toBe(404);expect(rpc.seen).toHaveLength(beforeForeign);
  vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');
  const reply=await mounted.app.inject({method:'POST',url:path+'/recover',payload:{},cookies,headers});expect(reply.statusCode,reply.body).toBe(200);expect(reply.json().state.status).toBe(outcome);
  expect(f.issuer.issueOnce).toHaveBeenCalledTimes(1);expect(rpc.seen).toContain('getTransaction');expect(rpc.seen).not.toContain('sendTransaction');
  await expect(p.request.sql`select * from charter_sale_terminals`).rejects.toMatchObject({code:'42501'});
  await expect(p.request.sql`insert into charter_sale_terminals default values`).rejects.toMatchObject({code:'42501'});
  await mounted.app.close();await mounted.services.close();p.source.close();mounted=await p.open(false);const before=rpc.seen.length;
  const recovered=await mounted.app.inject({method:'POST',url:path+'/recover',payload:{},cookies:f.buyerAuth.cookies,headers});expect(recovered.statusCode,recovered.body).toBe(200);expect(recovered.json().state).toEqual(reply.json().state);expect(rpc.seen).toHaveLength(before);
 }finally{
  await mounted?.app.close();await mounted?.services.close();p?.source.close();await p?.request.sql.end();
  // A migrated template holds GRANTs to the groups; release it before dropping them.
  // Dispose even when DROP ROLE fails: a leaked fixture database keeps GRANTs to the groups (K-night-R3b).
  await releaseMigratedTemplates();try{for(const role of p?.roles??[])await f.sql.unsafe(`drop owned by ${role};drop role ${role}`);}finally{await rpc?.close();await f.dispose();}
 }
},120_000);
