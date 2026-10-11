import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Keypair} from '@solana/web3.js';
import {buildVehicleServiceBurnMessage} from '@shardkeep/chain/vehicle-service-burn-message';
import {vehicleServicePreparationFixture} from './fixtures/vehicleServicePreparation';
import {createVehicleServiceBurnPreparations} from '../src/game/vehicleServiceBurnPreparations';
import {registerOwnedDeed,transferStableBase} from '../src/game/baseOwnership';
import {deedOwnershipObservations,players} from '../src/db/schema';
let f:Awaited<ReturnType<typeof vehicleServicePreparationFixture>>;
beforeEach(async()=>{for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'])vi.stubEnv(flag,'true');f=await vehicleServicePreparationFixture();},120_000);
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await f?.dispose();},120_000);
it('commits exact original service consent and supplies the real finalized service reader after reconnect',async()=>{
 const p=await f.preparations.prepare(f.actor,f.intent.id),built=buildVehicleServiceBurnMessage(p.plan),observer=f.conn.reopen();
 try{expect(await observer.sql`select intent_id from vehicle_service_burn_preparations`).toEqual([{intent_id:f.intent.id}]);expect(p.plan.service).toEqual(f.intent.state);expect(p.plan.identity).toEqual(f.intent.identity);expect(p.plan.reservationId).toBe(f.intent.id);expect(p.intentId).not.toBe(f.reservation.id);expect(p.messageSha256).toBe(built.messageSha256);expect(p.serviceAuthorized).toBe(false);expect(await createVehicleServiceBurnPreparations(observer.db).get(f.actor,f.intent.id)).toEqual(p);
  const signed=f.finalizeService(p),proof=await f.reader.verify({reservationId:f.intent.id,signedTransaction:signed.signedTransaction});expect(proof).toMatchObject({purpose:'vehicle_service',service:{installationId:f.reservation.id,completedTotal:f.intent.state.completedTotal},originalMessageSha256:p.messageSha256,finalityVerified:true,serviceAuthorized:false});
  expect(await f.reader.verify({reservationId:f.intent.id})).toEqual(proof);
 }finally{await observer.sql.end();}
});
it('serializes competing provider candidates and returns only the single committed winner',async()=>{
 const make=()=>createVehicleServiceBurnPreparations(f.conn.db,{captureOwner:f.reader.captureOwner,getBlockhash:async()=>({...f.blockhash,blockhash:Keypair.generate().publicKey.toBase58()})});const [a,b]=await Promise.all([make().prepare(f.actor,f.intent.id),make().prepare(f.actor,f.intent.id)]);expect(a).toEqual(b);expect(await f.conn.sql`select * from vehicle_service_burn_preparations`).toHaveLength(1);
});
it('preserves original intent rights for first preparation after base transfer, then replays without flags or providers',async()=>{
 const mint=Keypair.generate().publicKey.toBase58(),buyer=Keypair.generate().publicKey.toBase58();await registerOwnedDeed(f.conn.db,f.actor,mint);await f.conn.db.insert(players).values({wallet:buyer});await f.conn.db.insert(deedOwnershipObservations).values({baseId:f.baseId,assetId:mint,owner:f.actor,slot:100n,checkedAt:new Date(),status:'owned',source:'rpc-finalized',auditHash:randomUUID()});await transferStableBase(f.conn.db,f.baseId,f.actor,buyer,mint,{owner:buyer,collection:'test',frozen:false,delegate:null,slot:101,observedAtMs:Date.now()});
 const p=await f.preparations.prepare(f.actor,f.intent.id);expect(p.plan.service).toEqual(f.intent.state);expect(p.wallet).toBe(f.actor);await expect(f.preparations.prepare(buyer,f.intent.id)).rejects.toMatchObject({code:'VEHICLE_SERVICE_PREPARATION_ACTOR'});
 vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');f.setOnline(false);expect(await createVehicleServiceBurnPreparations(f.conn.db).prepare(f.actor,f.intent.id)).toEqual(p);expect((await f.conn.sql`select owner_wallet from bases where id=${f.baseId}`)[0]!.owner_wallet).toBe(buyer);
});
it.each(['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'])('requires strict parent %s even when the optional restriction returns true',async flag=>{
 const captureOwner=vi.fn(f.reader.captureOwner);vi.stubEnv(flag,'false');await expect(createVehicleServiceBurnPreparations(f.conn.db,{enabled:()=>true,captureOwner,getBlockhash:async()=>f.blockhash}).prepare(f.actor,f.intent.id)).rejects.toMatchObject({code:'VEHICLE_SERVICE_PREPARATION_DISABLED'});expect(captureOwner).not.toHaveBeenCalled();expect(await f.conn.sql`select * from vehicle_service_burn_preparations`).toHaveLength(0);
});
it('copies provider evidence before later awaits and returns independent saved copies',async()=>{
 const mutableAnchor=(actual:Awaited<ReturnType<typeof f.reader.captureOwner>>)=>({...actual,identity:{...actual.identity}});let handed:ReturnType<typeof mutableAnchor>|undefined;const observer=f.conn.reopen();
 try{const deps={captureOwner:async(input:Parameters<typeof f.reader.captureOwner>[0])=>{await observer.sql.begin(async tx=>{expect(await tx`select id from vehicle_service_intents where id=${f.intent.id} for update nowait`).toHaveLength(1);expect(await tx`select reservation_id from advanced_vehicle_installations where reservation_id=${f.reservation.id} for update nowait`).toHaveLength(1);});const actual=await f.reader.captureOwner(input);handed=mutableAnchor(actual);return handed;},getBlockhash:async()=>{handed!.wallet=Keypair.generate().publicKey.toBase58();handed!.identity.tier=4;handed!.assetDataHex='00';return f.blockhash;}};
  const factory=createVehicleServiceBurnPreparations(f.conn.db,deps);deps.captureOwner=async()=>{throw Error('changed callback');};const p=await factory.prepare(f.actor,f.intent.id);expect(p.anchor.wallet).toBe(f.actor);expect(p.anchor.identity).toEqual(f.intent.identity);expect(p.anchor.assetDataHex).not.toBe('00');
  const expected=structuredClone(p),saved=await factory.loadSavedReservation(f.intent.id);saved!.preparedMessageBytes[0]=255;saved!.anchor.identity.tier=4;saved!.plan.service.completedTotal='99';expect(await factory.get(f.actor,f.intent.id)).toEqual(expected);
 }finally{await observer.sql.end();}
});
it('refuses foreign actors, unavailable providers, stale contexts and changed actual Core ownership without writing',async()=>{
 const captureOwner=vi.fn(f.reader.captureOwner);await expect(createVehicleServiceBurnPreparations(f.conn.db,{captureOwner,getBlockhash:async()=>f.blockhash}).prepare(Keypair.generate().publicKey.toBase58(),f.intent.id)).rejects.toMatchObject({code:'VEHICLE_SERVICE_PREPARATION_ACTOR'});expect(captureOwner).not.toHaveBeenCalled();
 await expect(createVehicleServiceBurnPreparations(f.conn.db).prepare(f.actor,f.intent.id)).rejects.toMatchObject({code:'VEHICLE_SERVICE_PREPARATION_UNAVAILABLE'});
 await expect(createVehicleServiceBurnPreparations(f.conn.db,{captureOwner,getBlockhash:async()=>({...f.blockhash,contextSlot:199})}).prepare(f.actor,f.intent.id)).rejects.toMatchObject({code:'VEHICLE_SERVICE_PREPARATION_SOURCE'});
 const {createVehicleServiceBurnFinalityReader}=await import('@shardkeep/chain/vehicle-service-burn-finality');const rpc={...f.rpc,getMultipleAccountsInfoAndContext:async(...args:Parameters<typeof f.rpc.getMultipleAccountsInfoAndContext>)=>{const result=await f.rpc.getMultipleAccountsInfoAndContext(...args);return {...result,value:result.value.map((r,i)=>{if(!r||args[0][i]!.toBase58()!==f.asset.identity.assetId)return r;const data=Buffer.from(r.data);Keypair.generate().publicKey.toBuffer().copy(data,1);return {...r,data};})};}};
 const reader=createVehicleServiceBurnFinalityReader(()=>rpc,f.trust,async()=>null);await expect(createVehicleServiceBurnPreparations(f.conn.db,{captureOwner:reader.captureOwner,getBlockhash:async()=>f.blockhash}).prepare(f.actor,f.intent.id)).rejects.toMatchObject({code:'VEHICLE_SERVICE_PREPARATION_UNAVAILABLE'});expect(await f.conn.sql`select * from vehicle_service_burn_preparations`).toHaveLength(0);
});
it('rolls back a strict pause after insertion and retains the committed intent',async()=>{
 let checks=0;const factory=createVehicleServiceBurnPreparations(f.conn.db,{enabled:()=>{if(++checks===3)vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');return true;},captureOwner:f.reader.captureOwner,getBlockhash:async()=>f.blockhash});
 // Additional callback cannot weaken a strict flag, including one flipped at its boundary.
 await expect(factory.prepare(f.actor,f.intent.id)).rejects.toMatchObject({code:'VEHICLE_SERVICE_PREPARATION_DISABLED'});expect(await f.conn.sql`select * from vehicle_service_burn_preparations`).toHaveLength(0);expect(await f.conn.sql`select id from vehicle_service_intents`).toEqual([{id:f.intent.id}]);
});
it('holds changed live state for new preparation but keeps original artifacts readable after later state advancement',async()=>{
 await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`update advanced_vehicle_installations set tier=3 where reservation_id=${f.reservation.id}`;});
 // The shared lifecycle detects the corrupted original installation first.
 await expect(f.preparations.prepare(f.actor,f.intent.id)).rejects.toMatchObject({cause:{code:'P0001',message:'VEHICLE_LIFECYCLE_SOURCE'}});
 await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`update advanced_vehicle_installations set tier=${f.intent.state.tier} where reservation_id=${f.reservation.id}`;});const p=await f.preparations.prepare(f.actor,f.intent.id);
 await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`update advanced_vehicle_installations set tier=3 where reservation_id=${f.reservation.id}`;});expect(await f.preparations.get(f.actor,f.intent.id)).toEqual(p);expect(await f.preparations.loadSavedReservation(f.intent.id)).not.toBeNull();
});
it('holds corrupted original consent even when saved bytes and digest are internally rebuilt consistently',async()=>{
 const p=await f.preparations.prepare(f.actor,f.intent.id),plan={...p.plan,service:{...p.plan.service,completedTotal:'1'}},built=buildVehicleServiceBurnMessage(plan);
 await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`update vehicle_service_burn_preparations set plan=${JSON.stringify(plan)}::jsonb,message_bytes=${Buffer.from(built.messageBytes)},message_sha256=${built.messageSha256} where intent_id=${f.intent.id}`;});await expect(f.preparations.get(f.actor,f.intent.id)).rejects.toMatchObject({code:'VEHICLE_SERVICE_PREPARATION_SOURCE'});await expect(f.preparations.loadSavedReservation(f.intent.id)).rejects.toMatchObject({code:'VEHICLE_SERVICE_PREPARATION_SOURCE'});
});
it('requires top-level owner capability and rejects stale SQL isolation or changed raw service state',async()=>{
 const anchor=await f.reader.captureOwner({wallet:f.actor,identity:f.intent.identity}),plan={wallet:f.actor,reservationId:f.intent.id,identity:f.intent.identity,blockhash:f.blockhash.blockhash,service:f.intent.state},built=buildVehicleServiceBurnMessage(plan);
 await expect(f.conn.db.transaction(async tx=>createVehicleServiceBurnPreparations(tx as unknown as Parameters<typeof createVehicleServiceBurnPreparations>[0]))).rejects.toMatchObject({code:'VEHICLE_SERVICE_PREPARATION_TOP_LEVEL'});
 await expect(f.conn.sql.begin('isolation level repeatable read',async tx=>{await tx`insert into vehicle_service_burn_preparations(intent_id,plan,owner_anchor,message_bytes,blockhash_context_slot,last_valid_block_height) values(${f.intent.id},${JSON.stringify(plan)}::jsonb,${JSON.stringify(anchor)}::jsonb,${Buffer.from(built.messageBytes)},200,1000)`;})).rejects.toThrow('VEHICLE_SERVICE_PREPARATION_READ_COMMITTED');
 const altered={...plan,service:{...plan.service,completedTotal:'1'}};await expect(f.conn.sql`insert into vehicle_service_burn_preparations(intent_id,plan,owner_anchor,message_bytes,blockhash_context_slot,last_valid_block_height) values(${f.intent.id},${JSON.stringify(altered)}::jsonb,${JSON.stringify(anchor)}::jsonb,${Buffer.from(built.messageBytes)},200,1000)`).rejects.toThrow('VEHICLE_SERVICE_PREPARATION_SOURCE');
});
it('keeps immutable receipts and unchanged initial preparations across migration repeats',async()=>{
 const initial=await f.conn.sql`select * from vehicle_burn_preparations`,p=await f.preparations.prepare(f.actor,f.intent.id),before=await f.conn.sql`select * from vehicle_service_burn_preparations`;
 for(const statement of ['update vehicle_service_burn_preparations set plan=plan','delete from vehicle_service_burn_preparations'])await expect(f.conn.sql.unsafe(statement)).rejects.toThrow('VEHICLE_SERVICE_PREPARATION_IMMUTABLE');
 // Signed-wire child FKs mask the truncate trigger unless CASCADE is explicit.
 await expect(f.conn.sql`truncate vehicle_service_burn_preparations`).rejects.toMatchObject({code:'0A000'});
 await expect(f.conn.sql`truncate vehicle_service_burn_preparations cascade`).rejects.toThrow('VEHICLE_SERVICE_PREPARATION_IMMUTABLE');
 for(let n=0;n<2;n++)await f.conn.sql.begin(async tx=>{for(const statement of readFileSync(new URL('../drizzle/0212_vehicle_service_burn_preparations.sql',import.meta.url),'utf8').split('--> statement-breakpoint'))if(statement.trim())await tx.unsafe(statement);});expect(await f.conn.sql`select * from vehicle_service_burn_preparations`).toEqual(before);expect(await f.preparations.get(f.actor,f.intent.id)).toEqual(p);expect(await f.conn.sql`select * from vehicle_burn_preparations`).toEqual(initial);
});
it('denies restricted LOGIN reads and owner impersonation after accidental grants or copied triggers',async()=>{
 const {createDb}=await import('../src/db/client'),{ADMIN_DATABASE_URL}=await import('./db-url');const role='service_prep_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;await f.conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 try{const [database]=await f.conn.sql`select current_database() name`;await f.conn.sql.unsafe(`grant usage on schema public to ${role}`);const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());await expect(runtime.sql`select * from vehicle_service_burn_preparations`).rejects.toMatchObject({code:'42501'});await expect(createVehicleServiceBurnPreparations(runtime.db).get(f.actor,f.intent.id)).rejects.toMatchObject({code:'VEHICLE_SERVICE_PREPARATION_OWNER'});
  const anchor=await f.reader.captureOwner({wallet:f.actor,identity:f.intent.identity}),plan={wallet:f.actor,reservationId:f.intent.id,identity:f.intent.identity,blockhash:f.blockhash.blockhash,service:f.intent.state},built=buildVehicleServiceBurnMessage(plan);
  await f.conn.sql.unsafe(`grant all on vehicle_service_burn_preparations to ${role};grant execute on function shardkeep_vehicle_service_preparation_guard() to ${role};grant create on schema public to ${role}`);
  await expect(runtime.sql`insert into vehicle_service_burn_preparations(intent_id,plan,owner_anchor,message_bytes,blockhash_context_slot,last_valid_block_height) values(${f.intent.id},${JSON.stringify(plan)}::jsonb,${JSON.stringify(anchor)}::jsonb,${Buffer.from(built.messageBytes)},200,1000)`).rejects.toMatchObject({code:'42501'});
  await runtime.sql.unsafe('create table fake_preparation(like vehicle_service_burn_preparations including defaults);create trigger vehicle_service_burn_preparations_guard before insert on fake_preparation for each row execute function public.shardkeep_vehicle_service_preparation_guard()');await expect(runtime.sql`insert into fake_preparation(intent_id,plan,owner_anchor,message_bytes,blockhash_context_slot,last_valid_block_height) values(${f.intent.id},${JSON.stringify(plan)}::jsonb,${JSON.stringify(anchor)}::jsonb,${Buffer.from(built.messageBytes)},200,1000)`).rejects.toThrow('VEHICLE_SERVICE_PREPARATION_TRIGGER');
 }finally{await runtime?.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
});
