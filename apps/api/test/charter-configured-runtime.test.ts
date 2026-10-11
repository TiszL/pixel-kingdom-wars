/** Actual configured API/issuer HTTP and restricted LOGIN; raw finalized banks
 * are local fixtures. No live trust, policy issuance or wallet relay is claimed. */
import {createServer} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Keypair,MessageV0,PublicKey,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {afterEach,expect,it,vi} from 'vitest';
import {SOLANA_GENESIS_HASH} from '@shardkeep/chain';
import {PHASE_E_POLICY,PHASE_E_CHARTER_TRANSFER} from '@shardkeep/shared';
import type {CharterRetirementDraft} from '@shardkeep/shared/charterRetirementApi';
import type {CharterMigration} from '@shardkeep/shared/charterMigrationApi';
import {charterMigrationHttpFixture} from './fixtures/charterMigrationHttp';
import type {CharterRetirementDeliveryRpc} from '../src/game/clanCharterRetirementWorkflow';
import {createRaid} from '../src/game/raids';
import {setupCharterSaleRaidActor} from './fixtures/charterSalesRaid';
import {settleCharterSaleFixtureGross} from './fixtures/charterSalesRaidPayout';
import {simulatedRetirementFinality} from './fixtures/charterRetirementFinality';
import type {CharterCreationQuoteRpc} from '@shardkeep/chain/charter-creation-preparation';
import type {CharterTransferRpc} from '@shardkeep/chain/charter-transfer-evidence';
import type {CharterCreationEvidenceTrust} from '@shardkeep/chain/charter-creation-evidence';
import {createSeekerRealmAccessFixture} from '../../../packages/chain/src/testFixtures/seekerRealmAccess';
import {sign} from '../../../packages/chain/src/testFixtures/charterPreparation';
import {createConfiguredCharterWorkflowRuntime} from '../src/game/charterConfiguredRuntime';
import {createCharterRecoveryRuntime} from '../src/game/clanCharterRecoveryRuntime';
import {createCharterWorkflowRpc} from '../src/game/charterWorkflowRpc';
import {createCharterPolicyIssuer} from '../src/charterPolicyIssuer';
import {initializeCharterIssuerJournal} from '../src/charterPolicyIssuerJournal';
import {createCharterPolicyIssuerService} from '../src/charterPolicyIssuerService';
import {createPhaseEServices} from '../src/phaseEServices';
import {createDb,type Db} from '../src/db/client';
import {buildApp} from '../src/app';
import {loadConfig} from '../src/config';
import {refreshBaseOwnership} from '../src/game/baseOwnership';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {TEST_CONFIG} from './helpers';
import {charterCreationWorkflowFixture} from './fixtures/charterCreationWorkflow';
import {charterSalesWorkflowFixture} from './fixtures/charterSalesWorkflow';
import {divineClanFragmentFixture} from './fixtures/divineClanFragments';

// Browser fetch/navigator fixtures must not leak into the following HTTP journey.
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();vi.unstubAllEnvs();});
const clientPath='/clans/charter/client',tournamentPath='/clans/charter/tournaments';
type BankRpc=CharterCreationQuoteRpc&CharterTransferRpc&Partial<Pick<CharterRetirementDeliveryRpc,'getSignatureStatuses'|'sendRawTransaction'>>;
async function loopback(source:BankRpc){
 const seen:string[]=[];
 const encode=(row:{owner:PublicKey;executable:boolean;data:Uint8Array}|null)=>row?{owner:row.owner.toBase58(),executable:row.executable,data:[Buffer.from(row.data).toString('base64'),'base64'],lamports:1,rentEpoch:0}:null;
 const server=createServer(async(req,res)=>{try{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw) as {id:string;method:string;params:unknown[]};seen.push(body.method);let result:unknown;
  const finalized=(value:unknown)=>{const options=value as {commitment:'finalized';minContextSlot:number};expect(options.commitment).toBe('finalized');expect(Number.isSafeInteger(options.minContextSlot)).toBe(true);return options;};
  if(body.method==='getGenesisHash')result=await source.getGenesisHash();
  else if(body.method==='getSlot')result=await source.getSlot('finalized');
  else if(body.method==='getMultipleAccounts'){const value=await source.getMultipleAccountsInfoAndContext((body.params[0] as string[]).map(k=>new PublicKey(k)),finalized(body.params[1]));result={context:value.context,value:value.value.map(encode)};}
  else if(body.method==='getAccountInfo'){const value=await source.getAccountInfoAndContext(new PublicKey(body.params[0] as string),finalized(body.params[1]));result={context:value.context,value:encode(value.value)};}
  else if(body.method==='getLatestBlockhash')result=await source.getLatestBlockhashAndContext(finalized(body.params[0]));
  else if(body.method==='getFeeForMessage')result=await source.getFeeForMessage(MessageV0.deserialize(Buffer.from(body.params[0] as string,'base64')),'finalized');
  else if(body.method==='getMinimumBalanceForRentExemption')result=await source.getMinimumBalanceForRentExemption(body.params[0] as number,'finalized');
  else if(body.method==='getBlockHeight')result=await source.getBlockHeight(finalized(body.params[0]));
  else if(body.method==='getSignatureStatuses'&&source.getSignatureStatuses)result=await source.getSignatureStatuses(body.params[0] as string[],{searchTransactionHistory:true});
  else if(body.method==='sendTransaction'&&source.sendRawTransaction){const options=body.params[1] as {skipPreflight:false;preflightCommitment:'finalized';maxRetries:0;minContextSlot:number};expect(options.skipPreflight??false).toBe(false);expect(options).toMatchObject({preflightCommitment:'finalized',maxRetries:0});expect(Number.isSafeInteger(options.minContextSlot)).toBe(true);result=await source.sendRawTransaction(Buffer.from(body.params[0] as string,'base64'),{...options,skipPreflight:false});}
  else if(body.method==='getTransaction'){
   const tx=await source.getTransaction(body.params[0] as string,{commitment:'finalized',maxSupportedTransactionVersion:0});
   if(!tx)result=null;else{const m=tx.transaction.message;result={...tx,meta:tx.meta?{...tx.meta,loadedAddresses:tx.meta.loadedAddresses?{writable:tx.meta.loadedAddresses.writable.map(k=>k.toBase58()),readonly:tx.meta.loadedAddresses.readonly.map(k=>k.toBase58())}:undefined}:null,
    transaction:{signatures:tx.transaction.signatures,message:{header:m.header,accountKeys:m.staticAccountKeys.map(k=>k.toBase58()),recentBlockhash:m.recentBlockhash,instructions:m.compiledInstructions.map(ix=>({programIdIndex:ix.programIdIndex,accounts:ix.accountKeyIndexes,data:bs58.encode(ix.data)})),addressTableLookups:m.addressTableLookups.map(t=>({accountKey:t.accountKey.toBase58(),writableIndexes:t.writableIndexes,readonlyIndexes:t.readonlyIndexes}))}}};}
  }else throw Error('Unexpected RPC '+body.method);
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
 }catch{res.statusCode=500;res.end('Fixture RPC refused');}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('No port');
 return {url:`http://127.0.0.1:${address.port}`,seen,close:async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}
function pins(t:CharterCreationEvidenceTrust){return Object.fromEntries([
 ...(['economy','craft','core'] as const).flatMap(name=>{
  const p=t[name],prefix='CHARTER_RECOVERY_'+name.toUpperCase();return [...(name==='core'?[]:[[prefix+'_PROGRAM_ID',p.programId]]),[prefix+'_DEPLOYMENT_SLOT',String(p.reviewedDeploymentSlot)],[prefix+'_PROGRAM_DATA_SHA256',p.reviewedProgramDataSha256],[prefix+'_UPGRADE_AUTHORITY',p.upgradeAuthority??'none']];
 }),['CHARTER_RECOVERY_STATE_PROVENANCE',t.stateProvenance]]);}
type FixtureDb={db:Db;sql:ReturnType<typeof createDb>['sql'];ownerUrl:()=>Promise<URL>};
type Ownership=NonNullable<Parameters<typeof createPhaseEServices>[2]>;
type Seeker=Parameters<typeof createPhaseEServices>[7];
async function runtime(f:FixtureDb,settings:{trust:CharterCreationEvidenceTrust;rpc:BankRpc;policy:Keypair;lookup:{address:string;dataSha256:string};treasury:string;ownership:Ownership;seeker?:Seeker;sponsor?:string;relay?:boolean}){
 const peer=await loopback(settings.rpc),dir=await mkdtemp(join(tmpdir(),'charter-configured-')),journal=join(dir,'journal'),token=randomBytes(32).toString('hex'),tokenFile=join(dir,'token');
 await writeFile(tokenFile,token,{mode:0o600});await initializeCharterIssuerJournal(journal,{genesisHash:settings.trust.expectedGenesisHash,economyProgram:settings.trust.economy.programId});
 const independent=createCharterWorkflowRpc({readRpcUrl:peer.url,nodeEnv:'test'}),issuer=await createCharterPolicyIssuer({journalFile:journal,trust:settings.trust,connect:independent.recoveryConnect,signer:{publicKey:settings.policy.publicKey.toBase58(),sign:message=>sign(settings.policy,message)}});
 let issued=0,lookedUp=0,loseReply=false;
 const service=createCharterPolicyIssuerService({authToken:token,issuer:{issueOnce:async(...args)=>{issued++;const result=await issuer.issueOnce(...args);if(loseReply){loseReply=false;throw Error('Fixture lost completed issuer response');}return result;},lookup:async(...args)=>{lookedUp++;return issuer.lookup(...args);}}});
 await service.listen({host:'127.0.0.1',port:0});const address=service.server.address();if(!address||typeof address==='string')throw Error('No issuer port');
 const owner=await f.ownerUrl(),suffix=randomUUID().replaceAll('-',''),role='charter_api_'+suffix,worker='charter_worker_'+suffix,password=randomBytes(32).toString('hex');
 execFileSync('sh',[fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh',import.meta.url))],{timeout:30000,maxBuffer:2*1024*1024,env:{PATH:process.env.PATH,PGHOST:owner.hostname,PGPORT:owner.port,PGDATABASE:owner.pathname.slice(1),PGUSER:decodeURIComponent(owner.username),PGPASSWORD:decodeURIComponent(owner.password),POSTGRES_USER:decodeURIComponent(owner.username),POSTGRES_PASSWORD:decodeURIComponent(owner.password),DB_ROLE_MODE:'isolated',SOLANA_CLUSTER:'devnet',API_DB_USER:role,API_DB_PASSWORD:password,WORKER_DB_USER:worker,WORKER_DB_PASSWORD:randomBytes(32).toString('hex')}});
 const requestUrl=new URL(owner);requestUrl.username=role;requestUrl.password=password;const request=createDb(requestUrl.toString(),{max:3});
 const env:Record<string,string>={DATABASE_URL:requestUrl.toString(),PHASE_E_SERVICE_DATABASE_URL:owner.toString(),JWT_SECRET:TEST_CONFIG.JWT_SECRET,WEB_ORIGIN:TEST_CONFIG.WEB_ORIGIN[0]!,NODE_ENV:'test',PLAYTEST_OPEN:'true',SOLANA_CLUSTER:'devnet',SOLANA_RPC_URL:peer.url,...pins(settings.trust),
  CHARTER_POLICY_ISSUER_URL:`http://127.0.0.1:${address.port}`,CHARTER_POLICY_ISSUER_PUBLIC_KEY:settings.policy.publicKey.toBase58(),CHARTER_POLICY_ISSUER_AUTH_TOKEN_FILE:tokenFile,CHARTER_POLICY_ISSUER_ALLOW_PRIVATE_HTTP:'true',
  CHARTER_WORKFLOW_METADATA_URI_PREFIX:'https://invalid.example/charters/',CHARTER_WORKFLOW_SALE_TREASURY:settings.treasury,CHARTER_WORKFLOW_LOOKUP_TABLE_ADDRESS:settings.lookup.address,CHARTER_WORKFLOW_LOOKUP_TABLE_SHA256:settings.lookup.dataSha256,CHARTER_WORKFLOW_CORE_COST_PROFILE:'mpl-core-0.15.2-charter-pfd-seq-none',CHARTER_WORKFLOW_MAX_NETWORK_FEE_LAMPORTS:'100000',CHARTER_WORKFLOW_MAX_RENT_LAMPORTS:'100000',CHARTER_WORKFLOW_MAX_TOTAL_LAMPORTS:'2000000',CHARTER_WORKFLOW_MAX_ADDITIONAL_LAMPORTS:'200000'};
 if(settings.relay)env.CHARTER_WORKFLOW_RELAY_RPC_URL=peer.url;
 // Explicit funding identity is fixture-owned; the test uses only enrollment of
 // the already funded real event, never implicit source or epoch bootstrapping.
 let services!:Awaited<ReturnType<typeof createPhaseEServices>>,app!:Awaited<ReturnType<typeof buildApp>>,configured!:Awaited<ReturnType<typeof createConfiguredCharterWorkflowRuntime>>,recovery:ReturnType<typeof createCharterRecoveryRuntime>=null;
 const cookies=new Map<string,Record<string,string>>();
 async function mount(mode:'full'|'issuer'|'recovery'|'none'='full',publicKey=settings.policy.publicKey.toBase58()){
  const selected=Object.fromEntries(Object.entries(env).filter(([key])=>mode==='full'||(!key.startsWith('CHARTER_WORKFLOW_')&&(mode==='issuer'||!key.startsWith('CHARTER_POLICY_ISSUER_')))));
  if(mode==='issuer')selected['CHARTER_POLICY_ISSUER_PUBLIC_KEY']=publicKey;
  const config=loadConfig(selected);
  if(settings.sponsor&&mode==='full'){config.CHARTER_TOURNAMENT_SPONSOR_WALLET=settings.sponsor;config.CHARTER_TOURNAMENT_TREASURY=settings.treasury;}
  for(const base of await f.sql`select id from bases where status='active' and deed_asset_id is not null`)expect(await refreshBaseOwnership(f.db,base.id,settings.ownership.finalizedDeedReader!,settings.ownership.deedCollection!)).toBe('owned');
  recovery=mode==='none'||mode==='issuer'?null:createCharterRecoveryRuntime(config);
  configured=await createConfiguredCharterWorkflowRuntime(config,recovery?.source);
  services=await createPhaseEServices(config,request.db,settings.ownership,undefined,undefined,undefined,undefined,mode==='full'?settings.seeker:undefined,recovery?.source,undefined,undefined,configured.tournaments,configured.client,configured.retirement,configured.migration);
  expect(services).not.toBeNull();app=await buildApp(config,request.db,services!.deps);
  for(const {wallet} of await f.sql`select wallet from players`){const [session]=await f.sql`insert into sessions(wallet,expires_at) values(${wallet},${new Date(Date.now()+SESSION_TTL_SEC*1000).toISOString()}) returning id`;cookies.set(wallet,{[SESSION_COOKIE]:await issueSessionJwt(config,wallet,session!.id)});}
 }
 const closeRecovery=()=>recovery?.close();
 try{await mount();}catch(error){await app?.close();await services?.close();configured?.close();closeRecovery();await request.sql.end();for(const name of [role,worker])await f.sql.unsafe(`drop owned by ${name};drop role ${name}`);await service.close();await issuer.close();independent.close();await peer.close();await rm(dir,{recursive:true,force:true});throw error;}
 const http=(wallet:string,url:string,payload?:Record<string,unknown>)=>app.inject({method:payload?'POST':'GET',url,cookies:cookies.get(wallet)!,headers:{origin:TEST_CONFIG.WEB_ORIGIN[0]!},...payload?{payload}:{}});
 const unmount=async()=>{await app.close();await services!.close();configured.close();recovery?.close();};
 return {request,http,peer,get app(){return app;},get services(){return services!;},counts:()=>({issued,lookedUp,rpc:peer.seen.length}),loseNextReply:()=>{loseReply=true;},
  restart:async(mode:Parameters<typeof mount>[0],key?:string)=>{await unmount();await mount(mode,key);},
  close:async()=>{await unmount();await request.sql.end();for(const name of [role,worker])await f.sql.unsafe(`drop owned by ${name};drop role ${name}`);await service.close();await issuer.close();independent.close();await peer.close();await rm(dir,{recursive:true,force:true});}};
}

it('configures real creation issuance, recovers a lost receipt across signer rotation, and keeps paused originals private',async()=>{
 const f=await charterCreationWorkflowFixture({genesisHash:SOLANA_GENESIS_HASH.devnet,staticLookupTable:true});let r:Awaited<ReturnType<typeof runtime>>|undefined;
 try{
  await f.useSigningActor();const actors=[f.source,f.payerActor],collection=f.payerActor.collection,reader=async(asset:string)=>{const a=actors.find(v=>v.deed===asset);return a?{...a.proof(),collection}:null;};
  const policy=Keypair.generate();r=await runtime(f,{trust:f.chain.trust,rpc:{...f.rpc,getTransaction:async()=>null},policy,lookup:f.chain.lookupTable,treasury:Keypair.generate().publicKey.toBase58(),ownership:{finalizedDeedReader:reader,deedCollection:collection}});
  const input=f.request(),path=`${clientPath}/creations/${input.creationIntentId}`,before=r.counts();
  expect((await r.app.inject({method:'POST',url:clientPath+'/creations',payload:input})).statusCode).toBe(401);expect(r.counts()).toEqual(before);
  const funded=await r.http(f.payerActor.wallet,clientPath+'/creations',input);expect(funded.statusCode,funded.body).toBe(201);await f.sync(input.creationIntentId);policy.publicKey.toBuffer().copy(f.bank.row.data,f.bank.offsets['current']!);
  r.loseNextReply();const lost=await r.http(f.payerActor.wallet,path+'/prepare',{});expect(lost.statusCode,lost.body).toBe(503);expect((await r.http(f.payerActor.wallet,path)).json().state.status).toBe('issuing');expect(r.counts().issued).toBe(1);
  const rotated=Keypair.generate();rotated.publicKey.toBuffer().copy(f.bank.row.data,f.bank.offsets['current']!);vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');await r.restart('issuer',rotated.publicKey.toBase58());
  const beforeLookup=r.counts(),recovered=await r.http(f.payerActor.wallet,path+'/recover-preparation',{});expect(recovered.statusCode,recovered.body).toBe(200);expect(recovered.json().state.status).toBe('prepared');expect(r.counts()).toEqual({...beforeLookup,lookedUp:beforeLookup.lookedUp+1});
  const signed=f.signed(recovered.json().state),retained=await r.http(f.payerActor.wallet,path+'/signed',signed.body);expect(retained.statusCode,retained.body).toBe(200);
  await f.sync(input.creationIntentId,true);await r.restart('recovery');const deniedBefore=r.counts();expect((await r.http(f.source.wallet,path+'/recover',{})).statusCode).toBe(404);expect(r.counts()).toEqual(deniedBefore);
  const terminal=await r.http(f.payerActor.wallet,path+'/recover',{});expect(terminal.statusCode,terminal.body).toBe(200);expect(terminal.json().state.status).toBe('activated');
  await expect(r.request.sql`select * from charter_creation_terminals`).rejects.toMatchObject({code:'42501'});expect(await f.balance('charter_creation_escrow')).toBe(0n);
  await r.restart('none');const offline=r.counts(),replay=await r.http(f.payerActor.wallet,path+'/recover',{});expect(replay.json()).toEqual(terminal.json());expect(r.counts()).toEqual(offline);expect(r.peer.seen).not.toContain('sendTransaction');expect(f.issuer.issueOnce).not.toHaveBeenCalled();
 }finally{await r?.close();await f.dispose();}
},120000);

it('configures actual two-wallet sale preparation and original signed finality through restricted HTTP',async()=>{
 const f=await charterSalesWorkflowFixture({staticLookupTable:true,domain:{genesisHash:SOLANA_GENESIS_HASH.devnet,economyProgram:Keypair.generate().publicKey.toBase58()}});let r:Awaited<ReturnType<typeof runtime>>|undefined;
 try{
  r=await runtime(f,{trust:f.chain.trust,rpc:f.rpc,policy:f.policy,lookup:f.chain.lookupTable,treasury:f.domain.treasury,ownership:{finalizedDeedReader:f.reader,deedCollection:f.source.collection}});
  const created=await r.http(f.source.wallet,clientPath+'/sales',f.request());expect(created.statusCode,created.body).toBe(201);const saved=created.json(),path=`${clientPath}/sales/${saved.key}`;
  const accepted=await r.http(f.buyer.wallet,path+'/accept',{termsHash:saved.state.original.termsHash,buyerBaseId:f.buyer.baseId});expect(accepted.statusCode,accepted.body).toBe(200);
  const prepared=await r.http(f.source.wallet,path+'/prepare',{});expect(prepared.statusCode,prepared.body).toBe(200);const state=prepared.json(),signed=f.signed(state.state);
  for(const [i,wallet]of[f.buyer.wallet,f.source.wallet].entries()){const response=await r.http(wallet,path+'/signature',{attemptId:state.signing.attemptId,messageSha256:state.signing.packet.messageSha256,signature:Buffer.from(signed.tx.signatures[i]!).toString('base64')});expect(response.statusCode,response.body).toBe(200);}
  await f.finalize(saved.key);vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');await r.restart('recovery');
  const terminal=await r.http(f.buyer.wallet,path+'/recover',{});expect(terminal.statusCode,terminal.body).toBe(200);expect(terminal.json().state.status).toBe('completed');
  expect(r.counts().issued).toBe(1);expect(f.issuer.issueOnce).not.toHaveBeenCalled();await expect(r.request.sql`select * from charter_sale_terminals`).rejects.toMatchObject({code:'42501'});
  await r.restart('none');const before=r.counts(),replay=await r.http(f.buyer.wallet,path+'/recover',{});expect(replay.json()).toEqual(terminal.json());expect(r.counts()).toEqual(before);expect(r.peer.seen).toContain('getTransaction');expect(r.peer.seen).not.toContain('sendTransaction');
 }finally{await r?.close();await f.dispose();}
},120000);

it('configures a genuinely enrolled original tournament lock and recovers it after current providers disappear',async()=>{
 const f=await divineClanFragmentFixture(3,2,{domain:{genesisHash:SOLANA_GENESIS_HASH.devnet,economyProgram:Keypair.generate().publicKey.toBase58()}});let r:Awaited<ReturnType<typeof runtime>>|undefined;
 try{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(f.clock());const access=await createSeekerRealmAccessFixture();
  r=await runtime(f,{trust:f.lockChain.trust,rpc:f.lockRpc,policy:f.policy,lookup:f.chain.lookupTable,treasury:f.domain.treasury,ownership:{finalizedDeedReader:f.reader,deedCollection:f.source.collection},sponsor:f.source.wallet,seeker:{term:{policy:f.fragmentBank.policy,connect:f.fragmentBank.connect},access:{trust:access.trust,connect:()=>access.rpc}}});
  await r.services.clanOperator!.enroll(f.event.id);f.setTime(new Date(Date.parse(f.event.entryStartsAt)+3_600_000));vi.setSystemTime(f.clock());
  const input=f.request(),entered=await r.http(f.source.wallet,tournamentPath+'/entries',input);expect(entered.statusCode,entered.body).toBe(201);const entry=entered.json(),path=`${tournamentPath}/operations/${entry.set.original.operation.id}`;
  const prepared=await r.http(f.source.wallet,path+'/prepare',{});expect(prepared.statusCode,prepared.body).toBe(200);const retained=await r.http(f.source.wallet,path+'/signed',{signedTransaction:f.signed(prepared.json()).toString('base64')});expect(retained.statusCode,retained.body).toBe(200);
  await f.finalizeLock(entry.set.original.operation.id);vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');await r.restart('recovery');
  const beforeWrong=r.counts();expect((await r.http(f.buyer.wallet,path+'/recover',{})).statusCode).toBe(404);expect(r.counts()).toEqual(beforeWrong);
  const terminal=await r.http(f.source.wallet,path+'/recover',{});expect(terminal.statusCode,terminal.body).toBe(200);expect(terminal.json().terminal.outcome).toBe('completed');
  await expect(r.request.sql`select * from charter_tournament_operations`).rejects.toMatchObject({code:'42501'});expect(r.counts().issued).toBe(1);expect(f.lockIssuer.issueOnce).not.toHaveBeenCalled();
  const original=await r.http(f.source.wallet,tournamentPath+'/entries/'+entry.id);await r.restart('none');const before=r.counts(),replay=await r.http(f.source.wallet,tournamentPath+'/entries',input);expect(replay.statusCode,replay.body).toBe(201);expect(replay.json()).toEqual(original.json());expect(r.counts()).toEqual(before);expect(r.peer.seen).not.toContain('sendTransaction');
 }finally{await r?.close();await f.dispose();}
},120000);


it('configures ordinary retirement from positive payout review through durable HTTP issuance, exact wallet relay and paused original recovery',async()=>{
 const f=await charterSalesWorkflowFixture({staticLookupTable:true,domain:{genesisHash:SOLANA_GENESIS_HASH.devnet,economyProgram:Keypair.generate().publicKey.toBase58()}});let r:Awaited<ReturnType<typeof runtime>>|undefined;
 try{
  await setupCharterSaleRaidActor(f,f.source.wallet);vi.stubEnv('MULTI_BASE_ENABLED','false');const raid=await createRaid(f.db,f.source.wallet,{defenderWallet:f.buyer.wallet,idempotencyKey:randomUUID()});
  const cut=(await settleCharterSaleFixtureGross(f.db,raid.id,BigInt(PHASE_E_POLICY.basisPoints))).chestCut;expect(cut).toBeGreaterThan(0n);vi.stubEnv('MULTI_BASE_ENABLED','true');await f.source.refresh();
  const sent:Buffer[]=[];const rpc={...f.rpc,getSignatureStatuses:async()=>({context:{slot:150},value:[null]}),sendRawTransaction:async(bytes:Uint8Array)=>{sent.push(Buffer.from(bytes));return bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]!);}};
  r=await runtime(f,{trust:f.chain.trust,rpc,policy:f.policy,lookup:f.chain.lookupTable,treasury:f.domain.treasury,ownership:{finalizedDeedReader:f.reader,deedCollection:f.source.collection},relay:true});
  const root='/clans/charter/retirements',input={clanId:f.birth.consent.clanId,idempotencyKey:randomUUID()},before=r.counts();
  expect((await r.app.inject({method:'POST',url:root,payload:input})).statusCode).toBe(401);
  expect((await r.http(f.source.wallet,root,{...input,actor:f.buyer.wallet})).statusCode).toBe(400);expect(r.counts()).toEqual(before);
  const {requestRetirement}=await vi.importActual<{requestRetirement(input:{actor:string;request:{key:string|null;action:string;body?:unknown};isCurrent:()=>boolean;retain:(raw:unknown)=>Promise<void>}):Promise<CharterRetirementDraft|null>}>('../../web/src/lib/charterRetirement/transport');
  const {API_URL}=await vi.importActual<{API_URL:string}>('../../web/src/lib/api');
  const originalFetch=globalThis.fetch,browserPaths:string[]=[],retained:unknown[]=[];
  vi.stubGlobal('navigator',{locks:{request:async(_name:unknown,_options:unknown,run:()=>Promise<unknown>)=>run()}});
  vi.spyOn(globalThis,'fetch').mockImplementation(async(resource,init)=>{
   const url=new URL(typeof resource==='string'?resource:resource instanceof URL?resource.href:resource.url);
   if(url.origin!==new URL(API_URL).origin||!url.pathname.startsWith(root))return originalFetch(resource,init);
   browserPaths.push(`${init?.method??'GET'} ${url.pathname}`);
   expect(init?.credentials).toBe('include');
   const payload=init?.body===undefined?undefined:JSON.parse(String(init.body)) as Record<string,unknown>;
   const reply=await r!.http(f.source.wallet,url.pathname,payload);
   return new Response(reply.body,{status:reply.statusCode,headers:{'content-type':'application/json'}});
  });
  const fromBrowser=(request:Parameters<typeof requestRetirement>[0]['request'])=>requestRetirement({actor:f.source.wallet,request,isCurrent:()=>true,retain:async raw=>{retained.push(raw);}});
  const draft=(await fromBrowser({key:null,action:'create',body:input}))!,path=root+'/'+draft.id;
  expect(draft).toMatchObject({memberPayment:null,operation:null,totalShards:cut.toString(),shares:[{wallet:f.source.wallet,shards:cut.toString()}]});
  const privateBefore=r.counts();expect((await r.http(f.buyer.wallet,path)).statusCode).toBe(404);expect((await r.http(f.buyer.wallet,path+'/pay-members',{})).statusCode).toBe(404);expect(r.counts()).toEqual(privateBefore);
  await expect(r.request.sql`select * from charter_retirement_drafts`).rejects.toMatchObject({code:'42501'});await expect(r.request.sql`select * from charter_retirements`).rejects.toMatchObject({code:'42501'});
  // Simulate the client losing the successful payout reply: resume by its saved
  // idempotency key, then repeat the same command; the ledger must stay identical.
  await fromBrowser({key:draft.id,action:'pay-members',body:{}});const ledger=await f.sql`select * from ledger_entries order by id`;
  const paid=(await fromBrowser({key:input.idempotencyKey,action:'by-key'}))!;
  expect(paid).toMatchObject({memberPayment:{totalShards:cut.toString()},operation:{status:'cleared'}});expect((await r.http(f.source.wallet,path+'/pay-members',{})).json()).toEqual(paid);expect(await f.sql`select * from ledger_entries order by id`).toEqual(ledger);
  r.loseNextReply();const lost=await r.http(f.source.wallet,path+'/prepare',{});expect(lost.statusCode,lost.body).toBe(503);expect((await r.http(f.source.wallet,path)).json().operation.status).toBe('issuing');expect(r.counts().issued).toBe(1);
  const prepared=(await fromBrowser({key:draft.id,action:'recover-preparation',body:{}}))!;expect(prepared.operation!.status).toBe('prepared');expect(r.counts().issued).toBe(1);expect(r.counts().lookedUp).toBe(1);
  const trust={version:1 as const,revision:'local-retirement-http-pair-v1',deployment:f.chain.trust,policySigner:f.policy.publicKey.toBase58(),treasury:f.domain.treasury,royaltyBps:PHASE_E_CHARTER_TRANSFER.royaltyBps,lookupTables:[f.chain.lookupTable]};
  const browser=await import('../../web/src/lib/charterRetirement/signing');const reviewed=await browser.prepareRetirementSigning(prepared.operation!,trust,f.source.wallet);expect(Buffer.from(reviewed.unsignedTransaction).toString('hex')).toBe(prepared.operation!.preparation!.packet.unsignedTransactionHex);
  const tx=VersionedTransaction.deserialize(Buffer.from(prepared.operation!.preparation!.packet.unsignedTransactionHex,'hex'));tx.sign([f.keys.get(f.source.wallet)!]);const bytes=Buffer.from(tx.serialize());
  const saved=(await fromBrowser({key:draft.id,action:'signed',body:{signedTransaction:bytes.toString('base64')}}))!;expect(await browser.verifyRetirementWire(saved.operation!,saved.operation!.signed)).toEqual(saved.operation!.signed);
  const delivered=await fromBrowser({key:draft.id,action:'deliver',body:{}});expect(sent.length,JSON.stringify({response:delivered,rpc:r.peer.seen})).toBe(1);expect(sent[0]).toEqual(bytes);
  f.rpc.getTransaction.mockResolvedValue(simulatedRetirementFinality(f.bank,saved.operation!));vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');await r.restart('recovery');
  const browserTerminal=await fromBrowser({key:draft.id,action:'recover',body:{}});const terminal=await r.http(f.source.wallet,path);expect(terminal.json()).toEqual(browserTerminal);expect(retained.at(-1)).toEqual(browserTerminal);expect(browserPaths).toHaveLength(7);expect(terminal.statusCode,terminal.body).toBe(200);expect(terminal.json().operation.status).toBe('completed');expect(await f.sql`select * from clans where id=${input.clanId}`).toHaveLength(0);expect(await f.sql`select * from ledger_entries order by id`).toEqual(ledger);
  await r.restart('none');f.setOnline(false);const offline=r.counts();expect((await r.http(f.source.wallet,path+'/recover',{})).json()).toEqual(terminal.json());expect((await r.http(f.source.wallet,root,input)).json()).toEqual(terminal.json());expect(r.counts()).toEqual(offline);expect(r.counts().issued).toBe(1);expect(f.issuer.issueOnce).not.toHaveBeenCalled();
  // Public test DTOs and public deployment pins only: no keypair, issuer token,
  // database URI or other credential enters this cross-client evidence file.
  await writeFile('/tmp/phase-e-retirement-http-transport-pair.json',JSON.stringify({version:1,actor:f.source.wallet,trust,preparedDraft:prepared,signedDraft:saved,completedDraft:terminal.json(),actualWireHex:bytes.toString('hex'),browserReconstructionVerified:true,browserSignatureVerified:true},null,2),{mode:0o600});
 }finally{await r?.close();await f.dispose();}
},180000);

it('keeps unpaid cancellation distinct from exposed-permit cancellation through the ordinary configured retirement API',async()=>{
 const f=await charterSalesWorkflowFixture({staticLookupTable:true,domain:{genesisHash:SOLANA_GENESIS_HASH.devnet,economyProgram:Keypair.generate().publicKey.toBase58()}});let r:Awaited<ReturnType<typeof runtime>>|undefined;
 try{
  r=await runtime(f,{trust:f.chain.trust,rpc:f.rpc,policy:f.policy,lookup:f.chain.lookupTable,treasury:f.domain.treasury,ownership:{finalizedDeedReader:f.reader,deedCollection:f.source.collection}});
  const root='/clans/charter/retirements',input={clanId:f.birth.consent.clanId,idempotencyKey:randomUUID()},created=await r.http(f.source.wallet,root,input);expect(created.statusCode,created.body).toBe(201);const first=created.json<CharterRetirementDraft>(),path=root+'/'+first.id;
  const counts=r.counts(),cancelled=await r.http(f.source.wallet,path+'/cancel',{});expect(cancelled.statusCode,cancelled.body).toBe(200);expect(cancelled.json()).toMatchObject({cancelled:true,memberPayment:null,operation:null});expect(r.counts()).toEqual(counts);
  const late=await r.http(f.source.wallet,path+'/pay-members',{});expect(late.statusCode,late.body).toBe(200);expect(late.json()).toEqual(cancelled.json());expect(await f.sql`select * from clan_charter_member_payments`).toHaveLength(0);
  const next=await r.http(f.source.wallet,root,{...input,idempotencyKey:randomUUID()});expect(next.statusCode,next.body).toBe(201);const nextPath=root+'/'+next.json().id;
  const paid=await r.http(f.source.wallet,nextPath+'/pay-members',{});expect(paid.statusCode,paid.body).toBe(200);const prepared=await r.http(f.source.wallet,nextPath+'/prepare',{});expect(prepared.statusCode,prepared.body).toBe(200);const original=prepared.json<CharterRetirementDraft>();
  const active=await r.http(f.source.wallet,nextPath+'/cancel',{});expect(active.statusCode,active.body).toBe(503);expect(await f.sql`select * from charter_retirement_draft_cancellations`).toHaveLength(1);expect((await r.http(f.source.wallet,nextPath)).json()).toEqual(original);
  f.bank.clock.writeBigInt64LE(Buffer.from(original.operation!.attempt!.candidateHex,'hex').readBigInt64LE(121)+1n,32);vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');await r.restart('recovery');
  const expired=await r.http(f.source.wallet,nextPath+'/cancel',{});expect(expired.statusCode,expired.body).toBe(200);expect(expired.json()).toMatchObject({cancelled:false,operation:{status:'cancelled'}});expect(await f.sql`select * from clans where id=${input.clanId}`).toHaveLength(1);
  await r.restart('none');f.setOnline(false);const offline=r.counts();expect((await r.http(f.source.wallet,nextPath+'/cancel',{})).json()).toEqual(expired.json());expect((await r.http(f.source.wallet,path)).json()).toEqual(cancelled.json());expect(r.counts()).toEqual(offline);expect(r.counts().issued).toBe(1);
 }finally{await r?.close();await f.dispose();}
},180000);


it('migrates a landless existing leader through normal discovery, browser HTTP, exact signed relay and paused recovery without charging or replacing the clan',async()=>{
 const f=await charterMigrationHttpFixture();let r:Awaited<ReturnType<typeof runtime>>|undefined;
 try{
  r=await runtime(f,{trust:f.trust,rpc:f.rpc,policy:f.policy,lookup:f.lookup,treasury:f.domain.treasury,ownership:f.ownership,relay:true});
  const root='/clans/charter/migrations',before=r.counts(),snapshot=await f.snapshot();
  expect(await f.sql`select * from bases where owner_wallet=${f.actor}`).toHaveLength(0);
  expect((await r.app.inject({method:'POST',url:root,payload:f.input})).statusCode).toBe(401);
  expect((await r.http(f.actor,root,{...f.input,actor:f.actor})).statusCode).toBe(400);
  const discovered=await r.http(f.actor,root+'/activity');expect(discovered.statusCode,discovered.body).toBe(200);
  expect(discovered.headers['cache-control']).toBe('private, no-store');expect(discovered.json()).toMatchObject({actor:f.actor,newActions:true,currentClan:{id:f.clanId,authority:'legacy'},items:[]});expect(r.counts()).toEqual(before);
  const {requestMigration}=await vi.importActual<{requestMigration(input:{actor:string;request:{key:string|null;action:string;body?:unknown};isCurrent:()=>boolean;retain:(raw:unknown)=>Promise<void>}):Promise<CharterMigration|null>}>('../../web/src/lib/charterMigration/transport');
  const {API_URL}=await vi.importActual<{API_URL:string}>('../../web/src/lib/api');
  // A preceding browser journey must not leave a spy as this fallback's original.
  expect(vi.isMockFunction(globalThis.fetch)).toBe(false);
  const originalFetch=globalThis.fetch,browserPaths:string[]=[],retained:unknown[]=[];
  vi.stubGlobal('navigator',{locks:{request:async(_name:unknown,_options:unknown,run:()=>Promise<unknown>)=>run()}});
  vi.spyOn(globalThis,'fetch').mockImplementation(async(resource,init)=>{
   const url=new URL(typeof resource==='string'?resource:resource instanceof URL?resource.href:resource.url);
   if(url.origin!==new URL(API_URL).origin||!url.pathname.startsWith(root))return originalFetch(resource,init);
   browserPaths.push(`${init?.method??'GET'} ${url.pathname}`);expect(init?.credentials).toBe('include');
   const payload=init?.body===undefined?undefined:JSON.parse(String(init.body)) as Record<string,unknown>,reply=await r!.http(f.actor,url.pathname,payload);
   return new Response(reply.body,{status:reply.statusCode,headers:{'content-type':'application/json'}});
  });
  const fromBrowser=(request:Parameters<typeof requestMigration>[0]['request'])=>requestMigration({actor:f.actor,request,isCurrent:()=>true,retain:async raw=>{retained.push(raw);}});
  const pending=(await fromBrowser({key:null,action:'create',body:f.input}))!,path=root+'/'+pending.id;
  expect(pending).toMatchObject({actor:f.actor,status:'pending',request:f.input,snapshot:{clan:{id:f.clanId},memberCount:1,chestShards:'0'},signing:null,wire:null});
  expect(await f.snapshot()).toBe(snapshot);expect(await f.sql`select * from charter_creation_reservations`).toHaveLength(0);
  expect((await r.http(f.actor,root+'/activity')).json()).toMatchObject({newActions:false,currentClan:{authority:'pending',migrationId:pending.id},items:[{id:pending.id,status:'pending'}]});
  const [other]=await f.sql`select wallet from players where wallet<>${f.actor} limit 1`,privateBefore=r.counts();
  expect((await r.http(other!.wallet,path)).statusCode).toBe(404);expect((await r.http(other!.wallet,path+'/prepare',{})).statusCode).toBe(404);expect(r.counts()).toEqual(privateBefore);
  await expect(r.request.sql`select * from charter_migrations`).rejects.toMatchObject({code:'42501'});await expect(r.request.sql`select * from charter_migration_terminals`).rejects.toMatchObject({code:'42501'});
  await f.sync(pending.id);r.loseNextReply();const lost=await r.http(f.actor,path+'/prepare',{});expect(lost.statusCode,lost.body).toBe(503);expect((await r.http(f.actor,path)).json().status).toBe('issuing');expect(r.counts().issued).toBe(1);
  const issuing=await fromBrowser({key:f.input.idempotencyKey,action:'by-key'});expect(issuing?.id).toBe(pending.id);
  const prepared=(await fromBrowser({key:pending.id,action:'recover-preparation',body:{}}))!;expect(prepared.status).toBe('prepared');expect(r.counts().issued).toBe(1);expect(r.counts().lookedUp).toBe(1);
  const trust={version:1 as const,revision:'local-migration-http-pair-v1',deployment:f.trust,policySigner:f.policy.publicKey.toBase58(),treasury:f.domain.treasury,royaltyBps:PHASE_E_CHARTER_TRANSFER.royaltyBps,lookupTables:[f.lookup]};
  const browser=await import('../../web/src/lib/charter/signing'),reviewed=await browser.prepareCharterSigning(prepared.signing!,trust,f.actor);
  expect(Buffer.from(reviewed.unsignedTransaction).toString('hex')).toBe(prepared.signing!.packet.unsignedTransactionHex);
  const signed=await browser.signCharter(reviewed,{publicKey:f.leader.publicKey,signVersionedTransaction:async tx=>{tx.sign([f.leader]);return tx;}});if(signed.kind!=='creation')throw Error('Wrong registration signature kind');
  const bytes=Buffer.from(signed.wire.signedTransaction,'base64'),saved=(await fromBrowser({key:pending.id,action:'signed',body:{signedTransaction:signed.wire.signedTransaction}}))!;
  expect(saved.wire).toEqual(signed.wire);const delivered=await fromBrowser({key:pending.id,action:'deliver',body:{}});expect(delivered?.wire).toEqual(saved.wire);expect(f.sent).toEqual([bytes]);
  await f.sync(pending.id,true);vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');await r.restart('recovery');
  const terminal=(await fromBrowser({key:pending.id,action:'recover',body:{}}))!;expect(terminal.status).toBe('controlled');expect(retained.at(-1)).toEqual(terminal);expect(browserPaths).toHaveLength(6);
  expect(await f.snapshot()).toBe(snapshot);expect(await f.sql`select * from charter_creation_reservations`).toHaveLength(0);
  expect((await r.http(f.actor,root+'/activity')).json()).toMatchObject({newActions:false,currentClan:{id:f.clanId,authority:'controlled',migrationId:null},items:[{id:pending.id,status:'controlled'}]});
  await r.restart('none');f.setOnline(false);const offline=r.counts();expect((await r.http(f.actor,path+'/recover',{})).json()).toEqual(terminal);expect((await r.http(f.actor,root,f.input)).json()).toEqual(terminal);expect((await r.http(f.actor,path+'/deliver',{})).json()).toEqual(terminal);expect(r.counts()).toEqual(offline);
  // Export public DTOs/pins and exact transaction bytes only, never wallet keys,
  // issuer credentials, sessions or database connection details.
  await writeFile('/tmp/phase-e-migration-http-client-pair.json',JSON.stringify({version:1,actor:f.actor,trust,pendingMigration:pending,preparedMigration:prepared,signedMigration:saved,controlledMigration:terminal,actualWireHex:bytes.toString('hex'),browserReconstructionVerified:true,browserSignatureVerified:true,browserHttpRequests:browserPaths},null,2),{mode:0o600});
 }finally{await r?.close();await f.dispose();vi.unstubAllGlobals();}
},180000);
