/** Actual private vehicle lifecycle through authenticated HTTP; no live RPC/relay. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {buildApp,type AppDeps} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {sessions} from '../src/db/schema';
import {TEST_CONFIG} from './helpers';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {Keypair,PublicKey,Message,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import type {VehicleBurnFinalityRpc} from '@shardkeep/chain/vehicle-burn-finality';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createVehicleActivationReservations} from '../src/game/vehicleActivationReservations';
import {createDb,type Db} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';
const requireChain=createRequire(new URL('../../../packages/chain/package.json',import.meta.url));
const {Key,MPL_CORE_PROGRAM_ID}=requireChain('@metaplex-foundation/mpl-core') as {Key:{AssetV1:number;CollectionV1:number};MPL_CORE_PROGRAM_ID:string};
const {publicKey}=requireChain('@metaplex-foundation/umi') as {publicKey:(v:string)=>string};
const bs58=(requireChain('bs58') as {default:{encode:(v:Uint8Array)=>string}}).default;
interface Serializer {serialize:(v:Record<string,unknown>)=>Uint8Array}
const {getAssetV1AccountDataSerializer}=requireChain('@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData') as {getAssetV1AccountDataSerializer:()=>Serializer};
const {getCollectionV1AccountDataSerializer}=requireChain('@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData') as {getCollectionV1AccountDataSerializer:()=>Serializer};
async function setup(){const family='survey_balloon' as const,tier=1 as const;
 const conn=resourceClaimsDatabase();await conn.setup();const wallet=Keypair.generate(),baseId=randomUUID(),berthId=randomUUID(),jobId=randomUUID();
 const identity={assetId:Keypair.generate().publicKey.toBase58(),collection:Keypair.generate().publicKey.toBase58(),family,tier},actor=wallet.publicKey.toBase58();
 await conn.sql`insert into players(wallet) values(${actor})`;
 await conn.sql`insert into bases(id,owner_wallet) values(${baseId},${actor})`;
 await conn.sql`insert into base_slots(wallet,slot,base_id) values(${actor},1,${baseId})`;
 await conn.sql`insert into buildings(id,player_wallet,base_id,type,tx,ty) values(${berthId},${actor},${baseId},'berth',2,2)`;
 await conn.sql`insert into builder_jobs(id,player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at) values(${jobId},${actor},${baseId},${berthId},'build',now()-interval '2 hours',now()-interval '1 hour',now()-interval '1 hour')`;
 const reservations=createVehicleActivationReservations(conn.db);await reservations.register(identity,{fixture:'owner-attested mint identity; no live mint provenance'});
 const core=new PublicKey(MPL_CORE_PROGRAM_ID),loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),programData=PublicKey.findProgramAddressSync([core.toBuffer()],loader)[0];
 const code=Buffer.alloc(50);code.writeUInt32LE(3);code.writeBigUInt64LE(50n,4);code[45]=99;
 const raw=(address:PublicKey,data:Uint8Array,owner=core,executable=false)=>({address,data:Buffer.from(data),owner,executable});
 const accounts=[raw(core,Buffer.concat([Buffer.of(2,0,0,0),programData.toBuffer()]),loader,true),raw(programData,code,loader),
  raw(new PublicKey(identity.assetId),getAssetV1AccountDataSerializer().serialize({key:Key.AssetV1,owner:publicKey(actor),updateAuthority:{__kind:'Collection',fields:[publicKey(identity.collection)]},name:'Vehicle',uri:'',seq:null})),
  raw(new PublicKey(identity.collection),getCollectionV1AccountDataSerializer().serialize({key:Key.CollectionV1,updateAuthority:publicKey(actor),name:'Vehicles',uri:'',numMinted:1,currentSize:1}))];
 const trust={expectedGenesisHash:Keypair.generate().publicKey.toBase58(),reviewedDeploymentSlot:50,reviewedProgramDataSha256:createHash('sha256').update(code).digest('hex'),upgradeAuthority:null};
 const blockhash={blockhash:Keypair.generate().publicKey.toBase58(),contextSlot:100,lastValidBlockHeight:1000};
 let slot=100,transaction:VersionedTransactionResponse|null=null,online=true;
 const ensure=()=>{if(!online)throw Error('fixture archive unavailable');};
 const rpc:VehicleBurnFinalityRpc={getGenesisHash:async()=>{ensure();return trust.expectedGenesisHash;},getSlot:async()=>{ensure();return slot;},
  getMultipleAccountsInfoAndContext:async addresses=>{ensure();return {context:{slot},value:addresses.map(k=>accounts.find(a=>a.address.equals(k))??null)};},
  getSignaturesForAddress:async()=>{ensure();return [...transaction?[{signature:transaction.transaction.signatures[0]!,slot:transaction.slot,err:transaction.meta!.err,memo:null,blockTime:transaction.blockTime??null,confirmationStatus:'finalized' as const}]:[],
   {signature:bs58.encode(Buffer.alloc(64,1)),slot:90,err:null,memo:null,blockTime:null,confirmationStatus:'finalized' as const}];},
  getTransaction:async signature=>{ensure();return transaction?.transaction.signatures[0]===signature?transaction:null;},
  getBlockSignatures:async requested=>{ensure();return {signatures:transaction?.slot===requested?[transaction.transaction.signatures[0]!]:[]};}};
 function finalizeBurn(preparation:{messageHex:string}){
  const message=Message.from(Buffer.from(preparation.messageHex,'hex')),signed=new VersionedTransaction(message);signed.sign([wallet]);
  const signature=bs58.encode(signed.signatures[0]!),pre=message.accountKeys.map(()=>10_000_000),post=[...pre],asset=message.accountKeys.findIndex(k=>k.toBase58()===identity.assetId);
  post[0]!+=995_000;post[asset]!-=1_000_000;
  transaction={slot:110,blockTime:1_700_000_000,version:'legacy',transaction:{message,signatures:[signature]},meta:{err:null,fee:5000,preBalances:pre,postBalances:post,innerInstructions:[],loadedAddresses:{readonly:[],writable:[]}}};slot=120;
  return {signature,signedTransaction:signed.serialize(),transaction};
 }
 return {conn,wallet,actor,baseId,berthId,jobId,identity,rpc,trust,blockhash,finalizeBurn,
  setOnline(value:boolean){online=value;},dispose:()=>conn.close()};
}

let f:Awaited<ReturnType<typeof setup>>,cookies:Record<string,string>;const apps:FastifyInstance[]=[];
beforeEach(async()=>{f=await setup();const [s]=await f.conn.db.insert(sessions).values({wallet:f.actor,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,f.actor,s!.id)};},120_000);
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));vi.unstubAllEnvs();await f?.dispose();},120_000);
async function open(provider?:Awaited<ReturnType<typeof workflow>>,db:Db=f.conn.db){vi.stubEnv('MULTI_BASE_ENABLED','false');const app=await buildApp(TEST_CONFIG,db,{...(provider?{vehicleWorkflowProvider:provider}:{})} as AppDeps);apps.push(app);await app.ready();vi.stubEnv('MULTI_BASE_ENABLED','true');return app;}
async function workflow(online=true){const {createVehicleWorkflow}=await import('../src/game/vehicleWorkflow');return createVehicleWorkflow(f.conn.db,online?{connect:()=>f.rpc,trust:f.trust,getBlockhash:async()=>f.blockhash}:{});}
function enabled(){vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_BUILDINGS_ENABLED','true');vi.stubEnv('PHASE_E_VEHICLES_ENABLED','true');}
const command=()=>({baseId:f.baseId,assetId:f.identity.assetId,berthId:f.berthId,idempotencyKey:randomUUID()});
const post=(app:FastifyInstance,url:string,payload:Record<string,unknown>={})=>app.inject({method:'POST',url,cookies,payload});
async function start(app:FastifyInstance){const input=command(),reservation=await post(app,'/vehicles/reservations',input);expect(reservation.statusCode,reservation.body).toBe(200);const id=reservation.json().reservation.id,result=await post(app,'/vehicles/reservations/'+id+'/prepare');expect(result.statusCode,result.body).toBe(200);return {input,id,prepared:result.json().preparation};}

describe('authenticated vehicle workflow',()=>{
 it('authenticates private history and holds an absent owner capability without exposing SQL',async()=>{
  const app=await open(),url='/vehicles/reservations/'+randomUUID();expect((await app.inject({url})).statusCode).toBe(401);const result=await app.inject({url,cookies});expect(result.statusCode,result.body).toBe(503);expect(result.json().error.code).toBe('VEHICLE_WORKFLOW_UNAVAILABLE');
 });
 it('persists actual reservation and preparation before exposure, retains exact signed bytes and installs once',async()=>{
  const app=await open(await workflow());enabled();const before=await f.conn.sql`select to_jsonb(a)::text value from accounts a order by id`,{input,id,prepared}=await start(app),observer=f.conn.reopen();
  try{expect(await observer.sql`select reservation_id from vehicle_burn_preparations where reservation_id=${id}`).toHaveLength(1);}finally{await observer.sql.end();}
  expect(prepared.signingAuthorized).toBe(false);expect(prepared.broadcastAuthorized).toBe(false);const signed=f.finalizeBurn(prepared),body={signedTransaction:Buffer.from(signed.signedTransaction).toString('base64')};
  const stored=await post(app,'/vehicles/reservations/'+id+'/signed',body);expect(stored.statusCode,stored.body).toBe(200);expect(stored.json().signed.relayAuthorized).toBe(false);
  for(let n=0;n<2;n++){const result=await post(app,'/vehicles/reservations/'+id+'/recover');expect(result.statusCode,result.body).toBe(200);expect(result.json()).toMatchObject({status:'installed',reservation:{id},installation:{assetId:f.identity.assetId},broadcastAuthorized:false,reservationReleaseAuthorized:false});}
  expect((await app.inject({url:'/vehicles/reservations/by-key/'+input.idempotencyKey,cookies})).json().reservation.id).toBe(id);expect(await f.conn.sql`select * from advanced_vehicle_installations`).toHaveLength(1);expect(await f.conn.sql`select * from vehicle_burn_consumptions`).toHaveLength(1);expect(await f.conn.sql`select to_jsonb(a)::text value from accounts a order by id`).toEqual(before);
 });
 it('recovers a lost local signed wire after restart while paused and replays original artifacts providerless',async()=>{
  const app=await open(await workflow());enabled();const {input,id,prepared}=await start(app);f.finalizeBurn(prepared);vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');const restarted=await open(await workflow());const recovered=await post(restarted,'/vehicles/reservations/'+id+'/recover');expect(recovered.statusCode,recovered.body).toBe(200);expect(await f.conn.sql`select * from vehicle_burn_signed_wires`).toHaveLength(0);
  f.setOnline(false);const offline=await open(await workflow(false));expect((await post(offline,'/vehicles/reservations',input)).json().reservation.id).toBe(id);expect((await post(offline,'/vehicles/reservations/'+id+'/prepare')).json().preparation).toEqual(prepared);expect((await post(offline,'/vehicles/reservations/'+id+'/recover')).json().installation).toEqual(recovered.json().installation);
 });
 it('retains held original identity on finality outage and makes history GET strictly read-only',async()=>{
  const app=await open(await workflow());enabled();const {id,prepared}=await start(app);const signed=f.finalizeBurn(prepared);vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');const retained=await post(app,'/vehicles/reservations/'+id+'/signed',{signedTransaction:Buffer.from(signed.signedTransaction).toString('base64')});expect(retained.statusCode,retained.body).toBe(200);f.setOnline(false);
  const failed=await post(app,'/vehicles/reservations/'+id+'/recover');expect(failed.statusCode,failed.body).toBe(503);expect(failed.json().error).toMatchObject({code:'VEHICLE_RECOVERY_HELD',reservationId:id,status:'held',reservationReleaseAuthorized:false});
  const before=await f.conn.sql`select (select count(*) from vehicle_activation_reservations) r,(select count(*) from vehicle_burn_signed_wires) s,(select count(*) from advanced_vehicle_installations) i`,spy=vi.spyOn(f.rpc,'getGenesisHash');spy.mockClear();
  const history=await app.inject({url:'/vehicles/reservations/'+id,cookies});expect(history.statusCode,history.body).toBe(200);expect(history.json().status).toBe('signed');expect(history.headers['cache-control']).toBe('private, no-store');expect(spy).not.toHaveBeenCalled();expect(await f.conn.sql`select (select count(*) from vehicle_activation_reservations) r,(select count(*) from vehicle_burn_signed_wires) s,(select count(*) from advanced_vehicle_installations) i`).toEqual(before);
  f.setOnline(true);expect((await post(app,'/vehicles/reservations/'+id+'/recover')).statusCode).toBe(200);
 });
 it('makes unknown and foreign original actors indistinguishable on every saved-artifact route',async()=>{
  const app=await open(await workflow());enabled();const {id}=await start(app),other=Keypair.generate().publicKey.toBase58();await f.conn.sql`insert into players(wallet) values(${other})`;const [session]=await f.conn.db.insert(sessions).values({wallet:other,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();const foreign={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,other,session!.id)};
  for(const method of ['GET','POST'] as const)for(const suffix of method==='GET'?['']:['/prepare','/signed','/recover']){const payload=suffix==='/signed'?{signedTransaction:Buffer.alloc(66).toString('base64')}:{},a=await app.inject({method,url:'/vehicles/reservations/'+id+suffix,cookies:foreign,...method==='POST'?{payload}:{}}),b=await app.inject({method,url:'/vehicles/reservations/'+randomUUID()+suffix,cookies:foreign,...method==='POST'?{payload}:{}});expect(a.statusCode,a.body).toBe(404);expect(a.json()).toEqual(b.json());}
  expect((await app.inject({url:'/vehicles/reservations/by-key/'+randomUUID(),cookies:foreign})).statusCode).toBe(404);
 });
 it('rejects caller authority, malformed/corrupt signed bytes and oversized bodies without accepting consent',async()=>{
  const app=await open(await workflow());enabled();expect((await post(app,'/vehicles/reservations',{...command(),family:'cargo_cutter'})).statusCode).toBe(400);const {id,prepared}=await start(app),signed=f.finalizeBurn(prepared),url='/vehicles/reservations/'+id+'/signed';
  for(const value of ['not base64',Buffer.from(signed.signedTransaction).toString('base64')+'\n',Buffer.alloc(1233).toString('base64')])expect((await post(app,url,{signedTransaction:value})).statusCode).toBe(400);
  const bad=Uint8Array.from(signed.signedTransaction);bad[4]=bad[4]!^1;const result=await post(app,url,{signedTransaction:Buffer.from(bad).toString('base64')});expect(result.statusCode,result.body).toBe(400);expect(result.json().error.code).toBe('VEHICLE_SIGNED_WIRE');expect((await post(app,url,{signedTransaction:'x'.repeat(5000)})).statusCode).toBe(413);expect(await f.conn.sql`select * from vehicle_burn_signed_wires`).toHaveLength(0);expect((await post(app,'/vehicles/reservations/'+id+'/recover',{proof:{finalityVerified:true}})).statusCode).toBe(400);
 });
 it('requires all strict false-default parents for new work while saved history stays available',async()=>{
  const {phaseEVehiclesEnabled}=await import('../src/config');expect(phaseEVehiclesEnabled({})).toBe(false);for(const value of ['false','TRUE','1',''])expect(phaseEVehiclesEnabled({MULTI_BASE_ENABLED:'true',PHASE_E_BUILDINGS_ENABLED:'true',PHASE_E_VEHICLES_ENABLED:value})).toBe(false);
  const app=await open(await workflow());enabled();for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED']){vi.stubEnv(flag,'false');expect((await post(app,'/vehicles/reservations',command())).statusCode).toBe(503);vi.stubEnv(flag,'true');}expect(await f.conn.sql`select * from vehicle_activation_reservations`).toHaveLength(0);
 });
 it('serves the owner capability through a nonowner runtime without granting private SQL access',async()=>{
  const provider=await workflow(),ownerApp=await open(provider);enabled();const {id}=await start(ownerApp),role=`vehicle_http_${randomUUID().replaceAll('-','')}`,password=randomUUID(),[database]=await f.conn.sql`select current_database() name`;let runtime:ReturnType<typeof createDb>|undefined;
  await f.conn.sql.unsafe(`create role ${role} login password '${password}'`);try{await f.conn.sql.unsafe(`grant usage on schema public to ${role};grant usage,select on all sequences in schema public to ${role}`);const tables=await f.conn.sql`select tablename from pg_tables where schemaname='public' and tablename not like 'vehicle_%' and tablename<>'advanced_vehicle_installations'`;for(const table of tables)await f.conn.sql.unsafe(`grant select,insert,update,delete on public."${String(table.tablename).replaceAll('"','""')}" to ${role}`);
   const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());await expect(runtime.sql`select * from vehicle_activation_reservations`).rejects.toMatchObject({code:'42501'});const app=await open(provider,runtime.db);expect((await app.inject({url:'/vehicles/reservations/'+id,cookies})).statusCode).toBe(200);expect(await runtime.sql`select has_table_privilege(current_user,'vehicle_activation_reservations','SELECT') allowed`).toEqual([{allowed:false}]);await app.close();apps.splice(apps.indexOf(app),1);
  }finally{await runtime?.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 });
});
