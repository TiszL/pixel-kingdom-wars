/** D-153.129: current NFT + stable-base authority before permanent reservation. */
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {Keypair,PublicKey} from '@solana/web3.js';
import {createVehicleBurnFinalityReader,type VehicleBurnFinalityRpc} from '@shardkeep/chain/vehicle-burn-finality';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createVehicleActivationReservations} from '../src/game/vehicleActivationReservations';
import {assertFreshLockedBaseAuthority,registerOwnedDeed,transferStableBase} from '../src/game/baseOwnership';
import {createDb,type Db} from '../src/db/client';
import {deedOwnershipObservations,players} from '../src/db/schema';
import {ADMIN_DATABASE_URL} from './db-url';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
const requireChain=createRequire(new URL('../../../packages/chain/package.json',import.meta.url));
const {Key,MPL_CORE_PROGRAM_ID}=requireChain('@metaplex-foundation/mpl-core') as {Key:{AssetV1:number;CollectionV1:number};MPL_CORE_PROGRAM_ID:string};
const {publicKey}=requireChain('@metaplex-foundation/umi') as {publicKey:(v:string)=>string};
interface Serializer {serialize:(v:Record<string,unknown>)=>Uint8Array}
const {getAssetV1AccountDataSerializer}=requireChain('@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData') as {getAssetV1AccountDataSerializer:()=>Serializer};
const {getCollectionV1AccountDataSerializer}=requireChain('@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData') as {getCollectionV1AccountDataSerializer:()=>Serializer};
async function setup(){
 const family='survey_balloon' as const,tier=1 as const;
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
 const slot=100;let online=true;
 const ensure=()=>{if(!online)throw Error('fixture archive unavailable');};
 const rpc:VehicleBurnFinalityRpc={getGenesisHash:async()=>{ensure();return trust.expectedGenesisHash;},getSlot:async()=>{ensure();return slot;},
  getMultipleAccountsInfoAndContext:async addresses=>{ensure();return {context:{slot},value:addresses.map(k=>accounts.find(a=>a.address.equals(k))??null)};},
  getSignaturesForAddress:async()=>[],getTransaction:async()=>null,getBlockSignatures:async()=>({signatures:[]})};
 const reader=createVehicleBurnFinalityReader(()=>rpc,trust,async()=>null),input={wallet:actor,baseId,assetId:identity.assetId,berthId,idempotencyKey:randomUUID()};
 return {conn,actor,baseId,berthId,jobId,identity,input,reader,rpc,accounts,assetSerializer:getAssetV1AccountDataSerializer(),setOnline(value:boolean){online=value;},dispose:()=>conn.close()};
}

let active:Awaited<ReturnType<typeof setup>>|undefined;
beforeEach(async()=>{active=await setup();},120_000);
afterEach(async()=>{vi.restoreAllMocks();await active?.dispose();active=undefined;},120_000);
async function fixture(work:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>){if(!active)throw Error('fixture not ready');await work(active);}
const count=async(f:Awaited<ReturnType<typeof setup>>)=>Number((await f.conn.sql`select count(*) n from vehicle_activation_reservations`)[0]!.n);
describe('private vehicle admission',()=>{
 it('rolls back a permanent reservation when the retained gate pauses after insertion',async()=>fixture(async f=>{
  let calls=0;const service=Reflect.apply(createVehicleActivationReservations,null,[f.conn.db,{assertNewReservation:()=>{if(++calls===2)throw Error('paused after insert');}}]);
  await expect(service.reserve({wallet:f.actor,assetId:f.identity.assetId,berthId:f.berthId,idempotencyKey:f.input.idempotencyKey},{baseId:f.baseId,assertAuthority:async(tx:Parameters<typeof assertFreshLockedBaseAuthority>[0],wallet:string,id:string)=>{await assertFreshLockedBaseAuthority(tx,wallet,id);}})).rejects.toThrow('paused after insert');
  expect(calls).toBe(2);expect(await count(f)).toBe(0);
 }),30_000);
 it('rolls back new admission when its feature gate flips after the INSERT',async()=>fixture(async f=>{
  const {createVehicleAdmission}=await import('../src/game/vehicleAdmission');let calls=0;
  await expect(createVehicleAdmission(f.conn.db,{enabled:()=>++calls<3,captureOwner:f.reader.captureOwner}).admit(f.input)).rejects.toMatchObject({code:'VEHICLE_ADMISSION_DISABLED'});
  expect(calls).toBe(3);expect(await count(f)).toBe(0);
 }),30_000);
 it('captures actual Core ownership outside locks before committing an unchanged free-base reservation',async()=>fixture(async f=>{
  const {createVehicleAdmission}=await import('../src/game/vehicleAdmission'),observer=f.conn.reopen(),before=await f.conn.sql`select to_jsonb(a)::text value from accounts a order by id`;
  try{const service=createVehicleAdmission(f.conn.db,{enabled:()=>true,captureOwner:async input=>{expect(await count(f)).toBe(0);await observer.sql.begin(async tx=>{await tx`select id from bases where id=${f.baseId} for update nowait`;await tx`select id from builder_jobs where id=${f.jobId} for update nowait`;});return f.reader.captureOwner(input);}});
   expect(Object.keys(service)).toEqual(['admit']);expect(Object.isFrozen(service)).toBe(true);const saved=await service.admit(f.input);expect(saved).toMatchObject({wallet:f.actor,assetId:f.identity.assetId,baseId:f.baseId,berthId:f.berthId,family:'survey_balloon',tier:1});
   expect(await observer.sql`select id from vehicle_activation_reservations where id=${saved.id}`).toHaveLength(1);expect(await f.conn.sql`select to_jsonb(a)::text value from accounts a order by id`).toEqual(before);expect(await f.conn.sql`select * from vehicle_burn_preparations`).toHaveLength(0);
  }finally{await observer.sql.end();}
 }),30_000);
 it('refuses a borrowed NFT using its actual encoded Core owner without reserving any berth',async()=>fixture(async f=>{
  const {createVehicleAdmission}=await import('../src/game/vehicleAdmission');f.accounts[2]!.data=Buffer.from(f.assetSerializer.serialize({key:Key.AssetV1,owner:publicKey(Keypair.generate().publicKey.toBase58()),updateAuthority:{__kind:'Collection',fields:[publicKey(f.identity.collection)]},name:'Borrowed',uri:'',seq:null}));
  await expect(createVehicleAdmission(f.conn.db,{enabled:()=>true,captureOwner:f.reader.captureOwner}).admit(f.input)).rejects.toMatchObject({code:'VEHICLE_ADMISSION_UNAVAILABLE'});expect(await count(f)).toBe(0);
 }),30_000);
 it('remains dark by default and holds missing source, unknown registry and extra caller authority fields',async()=>fixture(async f=>{
  const {createVehicleAdmission}=await import('../src/game/vehicleAdmission'),captureOwner=vi.fn(f.reader.captureOwner);
  await expect(createVehicleAdmission(f.conn.db,{captureOwner}).admit(f.input)).rejects.toMatchObject({code:'VEHICLE_ADMISSION_DISABLED'});
  await expect(createVehicleAdmission(f.conn.db,{enabled:()=>true}).admit(f.input)).rejects.toMatchObject({code:'VEHICLE_ADMISSION_UNAVAILABLE'});
  const service=createVehicleAdmission(f.conn.db,{enabled:()=>true,captureOwner});await expect(service.admit({...f.input,assetId:Keypair.generate().publicKey.toBase58()})).rejects.toMatchObject({code:'VEHICLE_ADMISSION_REGISTRY'});
  await expect(service.admit({...f.input,family:'cargo_cutter'} as typeof f.input)).rejects.toThrow();expect(captureOwner).not.toHaveBeenCalled();expect(await count(f)).toBe(0);
 }),30_000);
 it('binds returned anchor identity and actor before base prefetch or writes',async()=>fixture(async f=>{
  const {createVehicleAdmission}=await import('../src/game/vehicleAdmission'),anchor=await f.reader.captureOwner({wallet:f.actor,identity:f.identity});
  for(const patch of [{wallet:Keypair.generate().publicKey.toBase58()},{identity:{...anchor.identity,tier:4 as const}},{reviewedDeploymentSlot:anchor.slot+1}])await expect(createVehicleAdmission(f.conn.db,{enabled:()=>true,captureOwner:async()=>({...anchor,...patch})}).admit(f.input)).rejects.toMatchObject({code:'VEHICLE_ADMISSION_SOURCE'});
  expect(await count(f)).toBe(0);
 }),30_000);
 it('holds source outage and a pause during capture, then retries the untouched intent',async()=>fixture(async f=>{
  const {createVehicleAdmission}=await import('../src/game/vehicleAdmission');f.setOnline(false);await expect(createVehicleAdmission(f.conn.db,{enabled:()=>true,captureOwner:f.reader.captureOwner}).admit(f.input)).rejects.toMatchObject({code:'VEHICLE_ADMISSION_UNAVAILABLE'});f.setOnline(true);
  let enabled=true;await expect(createVehicleAdmission(f.conn.db,{enabled:()=>enabled,captureOwner:async input=>{const anchor=await f.reader.captureOwner(input);enabled=false;return anchor;}}).admit(f.input)).rejects.toMatchObject({code:'VEHICLE_ADMISSION_DISABLED'});expect(await count(f)).toBe(0);
  await createVehicleAdmission(f.conn.db,{enabled:()=>true,captureOwner:f.reader.captureOwner}).admit(f.input);expect(await count(f)).toBe(1);
 }),30_000);
 it('uses paid-base finalized authority and snapshots dependency references and owner output before later awaits',async()=>fixture(async f=>{
  const {createVehicleAdmission}=await import('../src/game/vehicleAdmission'),mint=Keypair.generate().publicKey.toBase58(),collection=Keypair.generate().publicKey.toBase58();await registerOwnedDeed(f.conn.db,f.actor,mint);
  const actual=await f.reader.captureOwner({wallet:f.actor,identity:f.identity}),captured={...actual,identity:{...actual.identity}};const deps={enabled:()=>true,captureOwner:async()=>captured,deedCollection:collection,finalizedDeedReader:vi.fn(async()=>{captured.wallet=Keypair.generate().publicKey.toBase58();captured.identity.tier=4;return {owner:f.actor,collection,frozen:false,delegate:null,slot:100};})};
  const service=createVehicleAdmission(f.conn.db,deps);deps.enabled=()=>false;deps.captureOwner=async()=>{throw Error('replaced');};deps.deedCollection=Keypair.generate().publicKey.toBase58();await service.admit(f.input);expect(deps.finalizedDeedReader).toHaveBeenCalledOnce();expect(await count(f)).toBe(1);
 }),30_000);
 it('does not invent paid-base authority when both fresh observation and deed provider are missing',async()=>fixture(async f=>{
  const {createVehicleAdmission}=await import('../src/game/vehicleAdmission');await registerOwnedDeed(f.conn.db,f.actor,Keypair.generate().publicKey.toBase58());await expect(createVehicleAdmission(f.conn.db,{enabled:()=>true,captureOwner:f.reader.captureOwner}).admit(f.input)).rejects.toMatchObject({code:'DEED_AUTHORITY_UNAVAILABLE'});expect(await count(f)).toBe(0);
 }),30_000);
 it('replays the exact original request after transfer without source or gates but rejects changed intent',async()=>fixture(async f=>{
  const {createVehicleAdmission}=await import('../src/game/vehicleAdmission'),mint=Keypair.generate().publicKey.toBase58(),buyer=Keypair.generate().publicKey.toBase58();const saved=await createVehicleAdmission(f.conn.db,{enabled:()=>true,captureOwner:f.reader.captureOwner}).admit(f.input);
  await registerOwnedDeed(f.conn.db,f.actor,mint);await f.conn.db.insert(players).values({wallet:buyer});await transferStableBase(f.conn.db,f.baseId,f.actor,buyer,mint,{owner:buyer,collection:'test',frozen:false,delegate:null,slot:101,observedAtMs:Date.now()});
  const offline=createVehicleAdmission(f.conn.db);expect(await offline.admit(f.input)).toEqual(saved);await expect(offline.admit({...f.input,berthId:randomUUID()})).rejects.toMatchObject({code:'VEHICLE_IDEMPOTENCY_CONFLICT'});await expect(offline.admit({...f.input,wallet:buyer})).rejects.toMatchObject({code:'VEHICLE_ADMISSION_DISABLED'});expect(await count(f)).toBe(1);
 }),30_000);
 it('rechecks current base ownership after a transfer between fresh prefetch and final locking',async()=>fixture(async f=>{
  const {createVehicleAdmission}=await import('../src/game/vehicleAdmission'),mint=Keypair.generate().publicKey.toBase58(),buyer=Keypair.generate().publicKey.toBase58();await registerOwnedDeed(f.conn.db,f.actor,mint);await f.conn.db.insert(players).values({wallet:buyer});
  await f.conn.db.insert(deedOwnershipObservations).values({baseId:f.baseId,assetId:mint,owner:f.actor,slot:100n,checkedAt:new Date(),status:'owned',source:'rpc-finalized',auditHash:randomUUID()});const observer=f.conn.reopen(),original=f.conn.db.transaction.bind(f.conn.db);let transferred=false;
  vi.spyOn(f.conn.db,'transaction').mockImplementation(async(...args:Parameters<typeof original>)=>{if(!transferred){transferred=true;await transferStableBase(observer.db,f.baseId,f.actor,buyer,mint,{owner:buyer,collection:'test',frozen:false,delegate:null,slot:101,observedAtMs:Date.now()});}return original(...args);});
  try{await expect(createVehicleAdmission(f.conn.db,{enabled:()=>true,captureOwner:f.reader.captureOwner}).admit(f.input)).rejects.toMatchObject({code:'BASE_NOT_OWNED'});expect(transferred).toBe(true);expect(await count(f)).toBe(0);}finally{await observer.sql.end();}
 }),30_000);
 it('concurrent identical admission has one permanent winner and retry recovers that same identity',async()=>fixture(async f=>{
  const {createVehicleAdmission}=await import('../src/game/vehicleAdmission'),service=createVehicleAdmission(f.conn.db,{enabled:()=>true,captureOwner:f.reader.captureOwner}),results=await Promise.allSettled([service.admit(f.input),service.admit(f.input),service.admit(f.input)]);
  const successes=results.filter(r=>r.status==='fulfilled');expect(successes.length).toBeGreaterThan(0);for(const r of results)if(r.status==='rejected')expect(r.reason).toMatchObject({code:'VEHICLE_BUSY'});const saved=await service.admit(f.input);for(const r of successes)if(r.status==='fulfilled')expect(r.value).toEqual(saved);expect(await count(f)).toBe(1);
 }),30_000);
 it('keeps the private owner boundary despite accidental grants and rejects transaction capabilities',async()=>fixture(async f=>{
  const {createVehicleAdmission}=await import('../src/game/vehicleAdmission');await expect(f.conn.db.transaction(async tx=>createVehicleAdmission(tx as unknown as Db))).rejects.toMatchObject({code:'VEHICLE_ADMISSION_TOP_LEVEL'});
  const role=`vehicle_admission_${randomUUID().replaceAll('-','')}`,password=randomUUID(),url=new URL(ADMIN_DATABASE_URL),[db]=await f.conn.sql`select current_database() name`;url.pathname=`/${String(db!.name)}`;url.username=role;url.password=password;let runtime:ReturnType<typeof createDb>|undefined;
  await f.conn.sql.unsafe(`create role ${role} login password '${password}'`);try{runtime=createDb(url.toString());await f.conn.sql.unsafe(`grant usage on schema public to ${role};grant all on all tables in schema public to ${role};grant execute on all functions in schema public to ${role}`);const captureOwner=vi.fn(f.reader.captureOwner);await expect(createVehicleAdmission(runtime.db,{enabled:()=>true,captureOwner}).admit(f.input)).rejects.toMatchObject({code:'VEHICLE_ADMISSION_OWNER'});expect(captureOwner).not.toHaveBeenCalled();expect(await count(f)).toBe(0);}finally{await runtime?.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }),30_000);
});
