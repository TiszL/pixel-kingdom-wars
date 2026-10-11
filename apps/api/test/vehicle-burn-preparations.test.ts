/** D-153.126: retained consent bytes are not signing, mint, installation or release authority. */
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Keypair,PublicKey} from '@solana/web3.js';
import {createRequire} from 'node:module';
import {createVehicleBurnFinalityReader,type VehicleBurnFinalityRpc,type VehicleBurnOwnerAnchor} from '@shardkeep/chain/vehicle-burn-finality';
import {buildVehicleBurnMessage} from '@shardkeep/chain/vehicle-burn-message';
import {describe,expect,it,vi} from 'vitest';
import {createDb,type Db} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';
import {createVehicleActivationReservations} from '../src/game/vehicleActivationReservations';
import {assertFreshLockedBaseAuthority} from '../src/game/baseOwnership';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
const chainRequire=createRequire(new URL('../../../packages/chain/package.json',import.meta.url));
const {Key,MPL_CORE_PROGRAM_ID}=chainRequire('@metaplex-foundation/mpl-core') as {Key:{AssetV1:number;CollectionV1:number};MPL_CORE_PROGRAM_ID:string};
const {publicKey}=chainRequire('@metaplex-foundation/umi') as {publicKey:(value:string)=>string};
type Serializer={serialize:(value:Record<string,unknown>)=>Uint8Array};
const {getAssetV1AccountDataSerializer}=chainRequire('@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData') as {getAssetV1AccountDataSerializer:()=>Serializer};
const {getCollectionV1AccountDataSerializer}=chainRequire('@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData') as {getCollectionV1AccountDataSerializer:()=>Serializer};
const key=()=>Keypair.generate().publicKey.toBase58();
async function setup(){
 const conn=resourceClaimsDatabase();await conn.setup();const wallet=key(),base=randomUUID(),berth=randomUUID(),job=randomUUID(),identity={assetId:key(),collection:key(),family:'cargo_cutter' as const,tier:2 as const};
 await conn.sql`insert into players(wallet) values(${wallet})`;await conn.sql`insert into bases(id,owner_wallet) values(${base},${wallet})`;await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${base})`;
 await conn.sql`insert into buildings(id,player_wallet,base_id,type,tx,ty) values(${berth},${wallet},${base},'berth',2,2)`;
 await conn.sql`insert into builder_jobs(id,player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at) values(${job},${wallet},${base},${berth},'build',now()-interval '2 hours',now()-interval '1 hour',now()-interval '1 hour')`;
 const reservations=createVehicleActivationReservations(conn.db);await reservations.register(identity,{fixture:'private owner attestation; mint verification remains open'});
 const reservation=await reservations.reserve({wallet,assetId:identity.assetId,berthId:berth,idempotencyKey:randomUUID()},{baseId:base,assertAuthority:async(tx,w,id)=>{await assertFreshLockedBaseAuthority(tx,w,id);}});
 const plan={wallet,reservationId:reservation.id,identity,blockhash:key()},built=buildVehicleBurnMessage(plan),blockhash={blockhash:plan.blockhash,lastValidBlockHeight:1234,contextSlot:100};
 const code=Buffer.alloc(50);code.writeUInt32LE(3);code.writeBigUInt64LE(50n,4);code[12]=0;code[45]=99;
 const anchor={version:1 as const,wallet,identity,slot:100,genesisHash:key(),reviewedDeploymentSlot:50,reviewedProgramDataSha256:createHash('sha256').update(code).digest('hex'),
  assetDataHex:Buffer.from(getAssetV1AccountDataSerializer().serialize({key:Key.AssetV1,owner:publicKey(wallet),updateAuthority:{__kind:'Collection',fields:[publicKey(identity.collection)]},name:'Vehicle',uri:'',seq:null})).toString('hex'),
  collectionDataHex:Buffer.from(getCollectionV1AccountDataSerializer().serialize({key:Key.CollectionV1,updateAuthority:publicKey(wallet),name:'Vehicles',uri:'',numMinted:1,currentSize:1})).toString('hex')};
 const insert=()=>conn.sql`insert into vehicle_burn_preparations(reservation_id,plan,owner_anchor,message_bytes,blockhash_context_slot,last_valid_block_height) values(${reservation.id},${JSON.stringify(plan)}::jsonb,${JSON.stringify(anchor)}::jsonb,${Buffer.from(built.messageBytes)},${blockhash.contextSlot},${blockhash.lastValidBlockHeight}) returning *`;
 return {conn,wallet,identity,reservation,plan,built,anchor,blockhash,code,insert};
}
function provider(f:Awaited<ReturnType<typeof setup>>){
 const core=new PublicKey(MPL_CORE_PROGRAM_ID),loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),programData=PublicKey.findProgramAddressSync([core.toBuffer()],loader)[0];
 const rows=[{address:core,owner:loader,executable:true,data:Buffer.concat([Buffer.of(2,0,0,0),programData.toBuffer()])},{address:programData,owner:loader,executable:false,data:f.code},
 {address:new PublicKey(f.identity.assetId),owner:core,executable:false,data:Buffer.from(f.anchor.assetDataHex,'hex')},{address:new PublicKey(f.identity.collection),owner:core,executable:false,data:Buffer.from(f.anchor.collectionDataHex,'hex')}];
 const unused=async():Promise<never>=>{throw Error('history is outside preparation');};
 const rpc:VehicleBurnFinalityRpc={getGenesisHash:async()=>f.anchor.genesisHash,getSlot:async()=>100,getMultipleAccountsInfoAndContext:async addresses=>({context:{slot:100},value:addresses.map(k=>rows.find(r=>r.address.equals(k))??null)}),getSignaturesForAddress:unused,getTransaction:unused,getBlockSignatures:unused};
 return createVehicleBurnFinalityReader(()=>rpc,{expectedGenesisHash:f.anchor.genesisHash,reviewedDeploymentSlot:50,reviewedProgramDataSha256:f.anchor.reviewedProgramDataSha256,upgradeAuthority:null},async()=>null);
}
async function fixture(work:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>){const f=await setup();try{await work(f);}finally{vi.unstubAllEnvs();await f.conn.close();}}
describe('durable vehicle burn preparations',()=>{
 it('retains exact message and original anchor against the committed reservation',async()=>fixture(async f=>{
  const [saved]=await f.insert();expect(saved).toMatchObject({reservation_id:f.reservation.id,wallet:f.wallet,message_sha256:f.built.messageSha256,plan:f.plan,owner_anchor:f.anchor});
  expect(Buffer.from(saved!.message_bytes as Uint8Array)).toEqual(Buffer.from(f.built.messageBytes));
 }),30_000);
 it('captures actual finalized owner evidence outside locks only after another connection can see the reservation, and returns only committed bytes',async()=>fixture(async f=>{
  const {createVehicleBurnPreparations}=await import('../src/game/vehicleBurnPreparations'),reader=provider(f),observer=f.conn.reopen();let captured=0,handed:VehicleBurnOwnerAnchor|undefined;
  try{const captureOwner=async(input:Parameters<typeof reader.captureOwner>[0])=>{captured++;await observer.sql.begin(async tx=>{expect(await tx`select id from vehicle_activation_reservations where id=${f.reservation.id} for update nowait`).toHaveLength(1);expect(await tx`select * from vehicle_burn_preparations`).toHaveLength(0);});const genuine=await reader.captureOwner(input);handed={...genuine,identity:{...genuine.identity}};return handed;};
   const deps={enabled:()=>true,captureOwner,getBlockhash:async()=>{handed!.wallet=key();handed!.identity.tier=4;handed!.assetDataHex='00';return f.blockhash;}},service=createVehicleBurnPreparations(f.conn.db,deps);deps.captureOwner=async()=>{throw Error('mutated callback');};
   const saved=await service.prepare(f.wallet,f.reservation.id);expect(captured).toBe(1);expect(saved.messageHex).toBe(Buffer.from(f.built.messageBytes).toString('hex'));expect(saved.anchor).toEqual(f.anchor);expect(saved.signingAuthorized).toBe(false);expect(saved.broadcastAuthorized).toBe(false);
   expect(await observer.sql`select reservation_id from vehicle_burn_preparations`).toHaveLength(1);expect(await service.loadSavedReservation(f.reservation.id)).toEqual({plan:f.plan,preparedMessageBytes:f.built.messageBytes,anchor:f.anchor});
  }finally{await observer.sql.end();}
 }),30_000);
 it('replays the original lifetime and bytes after restart, pause and provider loss without reprepare or release',async()=>fixture(async f=>{
  const {createVehicleBurnPreparations}=await import('../src/game/vehicleBurnPreparations'),reader=provider(f),service=createVehicleBurnPreparations(f.conn.db,{enabled:()=>true,captureOwner:reader.captureOwner,getBlockhash:async()=>f.blockhash});
  const saved=await service.prepare(f.wallet,f.reservation.id),reopened=f.conn.reopen();try{const offline=createVehicleBurnPreparations(reopened.db);expect(await offline.prepare(f.wallet,f.reservation.id)).toEqual(saved);expect(await offline.get(f.wallet,f.reservation.id)).toEqual(saved);expect(saved.lastValidBlockHeight).toBe(f.blockhash.lastValidBlockHeight);expect(saved.reservationReleaseAuthorized).toBe(false);}finally{await reopened.sql.end();}
  expect(await f.conn.sql`select * from vehicle_activation_reservations`).toHaveLength(1);expect(await f.conn.sql`select * from vehicle_burn_preparations`).toHaveLength(1);
 }),30_000);
 it('chooses one immutable original when concurrent providers propose different messages',async()=>fixture(async f=>{
  const {createVehicleBurnPreparations}=await import('../src/game/vehicleBurnPreparations'),reader=provider(f);let calls=0,release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const captureOwner=async(input:Parameters<typeof reader.captureOwner>[0])=>{const anchor=await reader.captureOwner(input);if(++calls===2)release();await gate;return anchor;};
  const make=()=>createVehicleBurnPreparations(f.conn.db,{enabled:()=>true,captureOwner,getBlockhash:async()=>({...f.blockhash,blockhash:key()})});
  const [a,b]=await Promise.all([make().prepare(f.wallet,f.reservation.id),make().prepare(f.wallet,f.reservation.id)]);expect(a).toEqual(b);expect(await f.conn.sql`select * from vehicle_burn_preparations`).toHaveLength(1);
 }),30_000);
 it('refuses a changed actor before providers and also on committed replay',async()=>fixture(async f=>{
  const {createVehicleBurnPreparations}=await import('../src/game/vehicleBurnPreparations'),captureOwner=vi.fn(provider(f).captureOwner),service=createVehicleBurnPreparations(f.conn.db,{enabled:()=>true,captureOwner,getBlockhash:async()=>f.blockhash});
  await expect(service.prepare(key(),f.reservation.id)).rejects.toMatchObject({code:'VEHICLE_PREPARATION_ACTOR'});expect(captureOwner).not.toHaveBeenCalled();await service.prepare(f.wallet,f.reservation.id);
  await expect(service.get(key(),f.reservation.id)).rejects.toMatchObject({code:'VEHICLE_PREPARATION_ACTOR'});await expect(service.prepare(key(),f.reservation.id)).rejects.toMatchObject({code:'VEHICLE_PREPARATION_ACTOR'});expect(captureOwner).toHaveBeenCalledTimes(1);
 }),30_000);
 it('rolls back a pause after insertion and preserves the reservation on provider outage',async()=>fixture(async f=>{
  const {createVehicleBurnPreparations}=await import('../src/game/vehicleBurnPreparations');let checks=0;
  const paused=createVehicleBurnPreparations(f.conn.db,{enabled:()=>++checks<3,captureOwner:provider(f).captureOwner,getBlockhash:async()=>f.blockhash});
  await expect(paused.prepare(f.wallet,f.reservation.id)).rejects.toMatchObject({code:'VEHICLE_PREPARATION_DISABLED'});expect(checks).toBe(3);expect(await f.conn.sql`select * from vehicle_burn_preparations`).toHaveLength(0);
  const outage=createVehicleBurnPreparations(f.conn.db,{enabled:()=>true,captureOwner:async()=>{throw Error('RPC unavailable');},getBlockhash:async()=>f.blockhash});await expect(outage.prepare(f.wallet,f.reservation.id)).rejects.toMatchObject({code:'VEHICLE_PREPARATION_UNAVAILABLE'});expect(await f.conn.sql`select * from vehicle_burn_preparations`).toHaveLength(0);expect(await f.conn.sql`select * from vehicle_activation_reservations`).toHaveLength(1);
 }),30_000);
 it('requires a top-level owner DB, trusted provider bindings and a blockhash context covering the anchor',async()=>fixture(async f=>{
  const {createVehicleBurnPreparations}=await import('../src/game/vehicleBurnPreparations');await expect(f.conn.db.transaction(async tx=>createVehicleBurnPreparations(tx as unknown as Db))).rejects.toMatchObject({code:'VEHICLE_PREPARATION_TOP_LEVEL'});
  await expect(createVehicleBurnPreparations(f.conn.db).prepare(f.wallet,f.reservation.id)).rejects.toMatchObject({code:'VEHICLE_PREPARATION_DISABLED'});
  await expect(createVehicleBurnPreparations(f.conn.db,{enabled:()=>true,captureOwner:provider(f).captureOwner,getBlockhash:async()=>({...f.blockhash,contextSlot:99})}).prepare(f.wallet,f.reservation.id)).rejects.toMatchObject({code:'VEHICLE_PREPARATION_SOURCE'});
  expect(await f.conn.sql`select * from vehicle_burn_preparations`).toHaveLength(0);
 }),30_000);
 it('rejects mismatched registry/anchor fields and stale SQL isolation',async()=>fixture(async f=>{
  const invalid={...f.plan,identity:{...f.identity,tier:4}};await expect(f.conn.sql`insert into vehicle_burn_preparations(reservation_id,plan,owner_anchor,message_bytes,blockhash_context_slot,last_valid_block_height) values(${f.reservation.id},${JSON.stringify(invalid)}::jsonb,${JSON.stringify(f.anchor)}::jsonb,${Buffer.from(f.built.messageBytes)},100,1234)`).rejects.toThrow('VEHICLE_PREPARATION_SOURCE');
  await expect(f.conn.sql.begin('isolation level repeatable read',async tx=>{await tx`select * from vehicle_activation_reservations`;await tx`insert into vehicle_burn_preparations(reservation_id,plan,owner_anchor,message_bytes,blockhash_context_slot,last_valid_block_height) values(${f.reservation.id},${JSON.stringify(f.plan)}::jsonb,${JSON.stringify(f.anchor)}::jsonb,${Buffer.from(f.built.messageBytes)},100,1234)`;})).rejects.toThrow('VEHICLE_PREPARATION_READ_COMMITTED');
 }),30_000);
 it('keeps immutable receipts across migration repeats',async()=>fixture(async f=>{
  const {createVehicleBurnPreparations}=await import('../src/game/vehicleBurnPreparations');await f.insert();const before=await f.conn.sql`select * from vehicle_burn_preparations`;
  for(const statement of ['update vehicle_burn_preparations set plan=plan','delete from vehicle_burn_preparations'])await expect(f.conn.sql.unsafe(statement)).rejects.toThrow('VEHICLE_PREPARATION_IMMUTABLE');
  // Child FKs refuse a bare truncate before its trigger; CASCADE reaches the
  // exact immutability guard without weakening either protection.
  await expect(f.conn.sql`truncate vehicle_burn_preparations`).rejects.toMatchObject({code:'0A000'});
  await expect(f.conn.sql`truncate vehicle_burn_preparations cascade`).rejects.toThrow('VEHICLE_PREPARATION_IMMUTABLE');
  for(let n=0;n<2;n++)await f.conn.sql.begin(async tx=>{for(const statement of readFileSync(new URL('../drizzle/0206_vehicle_burn_preparations.sql',import.meta.url),'utf8').split('--> statement-breakpoint'))if(statement.trim())await tx.unsafe(statement);});expect(await f.conn.sql`select * from vehicle_burn_preparations`).toEqual(before);expect(await createVehicleBurnPreparations(f.conn.db).get(f.wallet,f.reservation.id)).not.toBeNull();
 }),30_000);
 it('denies ordinary LOGIN reads and fabricated writes even with accidental grants and fake triggers',async()=>fixture(async f=>{
  const role='vehicle_preparation_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;await f.conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
  try{const [database]=await f.conn.sql`select current_database() name`;await f.conn.sql.unsafe(`grant usage on schema public to ${role}`);const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());await expect(runtime.sql`select * from vehicle_burn_preparations`).rejects.toMatchObject({code:'42501'});
   await f.conn.sql.unsafe(`grant all on vehicle_burn_preparations to ${role};grant execute on function shardkeep_vehicle_preparation_guard() to ${role};grant create on schema public to ${role}`);
   await expect(runtime.sql`insert into vehicle_burn_preparations(reservation_id,plan,owner_anchor,message_bytes,blockhash_context_slot,last_valid_block_height) values(${f.reservation.id},${JSON.stringify(f.plan)}::jsonb,${JSON.stringify(f.anchor)}::jsonb,${Buffer.from(f.built.messageBytes)},100,1234)`).rejects.toMatchObject({code:'42501'});
   await runtime.sql.unsafe('create table fake_preparation(like vehicle_burn_preparations including defaults);create trigger vehicle_burn_preparations_guard before insert on fake_preparation for each row execute function public.shardkeep_vehicle_preparation_guard()');
   await expect(runtime.sql`insert into fake_preparation(reservation_id,plan,owner_anchor,message_bytes,blockhash_context_slot,last_valid_block_height) values(${f.reservation.id},${JSON.stringify(f.plan)}::jsonb,${JSON.stringify(f.anchor)}::jsonb,${Buffer.from(f.built.messageBytes)},100,1234)`).rejects.toThrow('VEHICLE_PREPARATION_TRIGGER');
  }finally{await runtime?.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }),30_000);
});
