/** The new facade preserves private original authority across ownership changes,
 * damaged history and a limited HTTP database role. Existing SQL writers remain. */
import {randomUUID} from 'node:crypto';
import {Keypair,Message,VersionedTransaction,PublicKey} from '@solana/web3.js';
import {afterEach,it,expect,vi} from 'vitest';
import {vehicleBurnDatabase} from './fixtures/vehicleBurn';
import {vehicleServiceAsset} from './fixtures/vehicleService';
import {createVehicleClient} from '../src/game/vehicleClient';
import {registerOwnedDeed,transferStableBase} from '../src/game/baseOwnership';
import {createDb} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';
afterEach(()=>vi.unstubAllEnvs());
function enable(){for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'])vi.stubEnv(flag,'true');}
it('keeps the irreversible original destination after base sale and hides seller consent from buyer',async()=>{
 const f=await vehicleBurnDatabase();try{enable();const buyer=Keypair.generate().publicKey.toBase58(),mint=Keypair.generate().publicKey.toBase58();await registerOwnedDeed(f.conn.db,f.actor,mint);await f.conn.sql`insert into players(wallet) values(${buyer})`;await transferStableBase(f.conn.db,f.baseId,f.actor,buyer,mint,{owner:buyer,collection:'test',frozen:false,delegate:null,slot:101,observedAtMs:Date.now()});
  const c=createVehicleClient(f.conn.db,{installation:{connect:()=>f.rpc,trust:f.trust}}),ref={kind:'installation' as const,id:f.reservation.id},saved=await c.prepare(f.actor,ref);expect(saved).toMatchObject({record:{reservation:{request:{baseId:f.baseId,berthId:f.berthId}}}});
  const signed=f.finalizeBurn();await c.retainSigned(f.actor,ref,signed.signedTransaction);expect(await c.recover(f.actor,ref)).toMatchObject({record:{status:'installed',installation:{baseId:f.baseId,berthId:f.berthId,installedWallet:f.actor}}});
  for(const action of ['read','review','deliver','recover'] as const)await expect(c[action](buyer,ref)).rejects.toMatchObject({statusCode:404});
  expect((await c.activity(f.actor)).items).toMatchObject([{id:ref.id,baseId:f.baseId}]);expect((await c.activity(buyer)).items).toEqual([]);
 }finally{await f.dispose();}
},120000);
it.each(['preparation','burn-receipt'])('holds damaged %s rather than making disappeared private proof look unprepared',async broken=>{
 const f=await vehicleBurnDatabase();try{enable();const c=createVehicleClient(f.conn.db,{installation:{connect:()=>f.rpc,trust:f.trust}}),ref={kind:'installation' as const,id:f.reservation.id};
  const tx=new VersionedTransaction(Message.from(Buffer.from(f.preparation.messageHex,'hex')));tx.sign([f.wallet]);await c.retainSigned(f.actor,ref,tx.serialize());if(broken==='burn-receipt'){f.finalizeBurn();await c.recover(f.actor,ref);}
  await f.conn.sql.begin(async db=>{await db`set local session_replication_role=replica`;if(broken==='preparation')await db`delete from vehicle_burn_preparations where reservation_id=${ref.id}`;else await db`delete from vehicle_burn_consumptions where reservation_id=${ref.id}`;});
  await expect(c.read(f.actor,ref)).rejects.toThrow();await expect(c.activity(f.actor)).rejects.toThrow();expect(await f.conn.sql`select count(*)::int n from vehicle_burn_signed_wires`).toEqual([{n:1}]);
 }finally{await f.dispose();}
},120000);
it('paginates the scanned admitted asset set, excludes other owners and holds malformed current sources',async()=>{
 const f=await vehicleBurnDatabase();try{enable();const assets:Awaited<ReturnType<typeof vehicleServiceAsset>>[]=[];for(let n=0;n<21;n++)assets.push(await vehicleServiceAsset(f,{...n%2?{owner:Keypair.generate().publicKey.toBase58()}:{}}));
  let corrupt=false;const rpc={...f.rpc,getMultipleAccountsInfoAndContext:async(keys:PublicKey[],options:Parameters<typeof f.rpc.getMultipleAccountsInfoAndContext>[1])=>({context:{slot:100},value:await Promise.all(keys.map(async key=>{const source=assets.find(a=>a.identity.assetId===key.toBase58())?.rpc??f.rpc,row=(await source.getMultipleAccountsInfoAndContext([key],options)).value[0]??null;return corrupt&&row&&key.toBase58()===f.identity.collection?{...row,data:Buffer.of(255)}:row;}))}),getFeeForMessage:async()=>({context:{slot:100},value:5000}),getBalanceAndContext:async()=>({context:{slot:100},value:100000}),isBlockhashValid:async()=>({context:{slot:100},value:true}),getBlockHeight:async()=>100,getSignatureStatuses:async()=>({context:{slot:100},value:[null]}),sendRawTransaction:async()=>{throw Error('No discovery send');}};
  const c=createVehicleClient(f.conn.db,{current:{connect:()=>rpc,trust:f.trust}}),first=await c.assets(f.actor);expect(first.provenance).toBe('owner-attested-registry');expect(first.nextCursor).not.toBeNull();const second=await c.assets(f.actor,first.nextCursor!);expect(second.nextCursor).toBeNull();const ids=[...first.items,...second.items].map(v=>v.identity.assetId);expect(ids.sort()).toEqual(assets.filter((_,n)=>n%2===0).map(a=>a.identity.assetId).sort());expect(new Set(ids).size).toBe(11);
  corrupt=true;await expect(c.assets(f.actor)).rejects.toMatchObject({code:'VEHICLE_CLIENT_PROVIDER_UNAVAILABLE'});
 }finally{await f.dispose();}
},120000);
it('denies ambient private source access to a nonowner runtime while owner composition stays available',async()=>{
 const f=await vehicleBurnDatabase(),role='vehicle_client_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
 try{await f.conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);await f.conn.sql.unsafe(`grant usage on schema public to ${role}`);const [db]=await f.conn.sql`select current_database() name`;const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+db!.name;url.username=role;url.password=password;runtime=createDb(url.toString());
  for(const table of ['vehicle_activation_reservations','vehicle_burn_preparations','vehicle_burn_signed_wires','vehicle_service_intents','vehicle_service_applications'])await expect(runtime.sql.unsafe(`select * from public.${table}`)).rejects.toMatchObject({code:'42501'});
  const c=createVehicleClient(runtime.db);await expect(c.activity(f.actor)).rejects.toMatchObject({code:'VEHICLE_CLIENT_HISTORY_HELD'});await expect(c.assets(f.actor)).rejects.toMatchObject({code:'VEHICLE_CLIENT_HISTORY_HELD'});expect((await createVehicleClient(f.conn.db).activity(f.actor)).items).toHaveLength(1);
 }finally{await runtime?.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);await f.dispose();}
},120000);
