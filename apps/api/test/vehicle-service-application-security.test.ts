/** Application boundaries over actual Core/service fixtures. Damaged storage
 * below is deliberate owner-only corruption, never a runtime-role exploit. */
import {createHash,randomUUID} from 'node:crypto';
import {Message,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {buildVehicleBurnMessage} from '@shardkeep/chain/vehicle-burn-message';
import {verifyMiningClaimSignedWire} from '@shardkeep/chain/mining-claim-wire';
import {createVehicleServiceApplications} from '../src/game/vehicleServiceApplications';
import {createDb} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';
import {vehicleServicePreparationFixture} from './fixtures/vehicleServicePreparation';

let f:Awaited<ReturnType<typeof vehicleServicePreparationFixture>>;
beforeEach(async()=>{
 for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'])vi.stubEnv(flag,'true');
 f=await vehicleServicePreparationFixture();
 // The ordinary migration runner must install0214; this file does not silently
 // apply a draft migration or skip acceptance before registration.
 expect((await f.conn.sql`select to_regclass('public.vehicle_service_applications')::text name`)[0]!.name).toBe('vehicle_service_applications');
},120_000);
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await f?.dispose();},120_000);
async function ready(){const p=await f.preparations.prepare(f.actor,f.intent.id),signed=f.finalizeService(p),proof=await f.reader.verify({reservationId:f.intent.id});return {p,signed,proof};}
async function snapshot(){return {
 consumption:await f.conn.sql`select to_jsonb(c) row from vehicle_service_consumptions c order by intent_id`,
 application:await f.conn.sql`select to_jsonb(a) row from vehicle_service_applications a order by intent_id`,
 installation:await f.conn.sql`select to_jsonb(i) row from advanced_vehicle_installations i order by reservation_id`,
 returns:await f.conn.sql`select to_jsonb(r) row from advanced_expedition_returns r order by id`,
 ledger:await f.conn.sql`select id from ledger_transactions order by id`,
};}

it('refuses a genuinely signed initial-purpose packet before verification on fresh and applied recovery',async()=>{
 const {p,signed}=await ready(),initial=buildVehicleBurnMessage({wallet:f.actor,reservationId:f.intent.id,identity:p.plan.identity,blockhash:p.plan.blockhash});
 const wrong=new VersionedTransaction(Message.from(initial.messageBytes));wrong.sign([f.wallet]);const packet=wrong.serialize();
 // Same actor/asset/intent/blockhash and valid Ed25519; only consent purpose is wrong.
 expect(verifyMiningClaimSignedWire({wallet:f.wallet.publicKey,intentBytes:initial.messageBytes,signedTransaction:packet}).messageSha256).toBe(initial.messageSha256);
 const verifyBurn=vi.fn(f.reader.verify),service=createVehicleServiceApplications(f.conn.db,{verifyBurn}),before=await snapshot();
 await expect(service.recover(f.actor,f.intent.id,packet)).rejects.toMatchObject({code:'VEHICLE_SERVICE_APPLICATION_WIRE'});
 expect(verifyBurn).not.toHaveBeenCalled();expect(await snapshot()).toEqual(before);
 const receipt=await service.recover(f.actor,f.intent.id,signed.signedTransaction);expect(verifyBurn).toHaveBeenCalledTimes(1);verifyBurn.mockClear();
 const committed=await snapshot();f.setOnline(false);vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');
 await expect(service.recover(f.actor,f.intent.id,packet)).rejects.toMatchObject({code:'VEHICLE_SERVICE_APPLICATION_WIRE'});
 expect(verifyBurn).not.toHaveBeenCalled();expect(await snapshot()).toEqual(committed);
 expect(await service.recover(f.actor,f.intent.id,signed.signedTransaction)).toEqual(receipt);expect(verifyBurn).not.toHaveBeenCalled();
},30_000);

it('rejects invalid Ed25519 even when the provider signature shape and recomputed packet digest agree',async()=>{
 const {p,proof}=await ready(),signature=Uint8Array.from(bs58.decode(proof.signature));signature[17]=signature[17]!^1;
 const encoded=bs58.encode(signature),message=Buffer.from(p.messageHex,'hex'),packet=Buffer.concat([Buffer.of(1),signature,message]);
 expect(encoded).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);expect(bs58.decode(encoded)).toHaveLength(64);
 expect(()=>verifyMiningClaimSignedWire({wallet:f.wallet.publicKey,intentBytes:message,signedTransaction:packet})).toThrow();
 const falseProof={...proof,signature:encoded,signedTransactionSha256:createHash('sha256').update(packet).digest('hex')},verifyBurn=vi.fn(async()=>falseProof),before=await snapshot();
 await expect(createVehicleServiceApplications(f.conn.db,{verifyBurn}).recover(f.actor,f.intent.id)).rejects.toMatchObject({code:'VEHICLE_SERVICE_APPLICATION_SOURCE'});
 expect(verifyBurn).toHaveBeenCalledTimes(1);expect(await snapshot()).toEqual(before);expect(await f.preparations.get(f.actor,f.intent.id)).toEqual(p);
},30_000);

it('holds orphan pairs and mismatched consumption identifiers on get and recovery with guards restored',async()=>{
 const {proof}=await ready(),saved=await createVehicleServiceApplications(f.conn.db,{verifyBurn:f.reader.verify}).recover(f.actor,f.intent.id);
 const pristine=await snapshot(),consumption=pristine.consumption[0]!.row,application=pristine.application[0]!.row;
 const verifyBurn=vi.fn(f.reader.verify),service=createVehicleServiceApplications(f.conn.db,{verifyBurn});
 const assertHeld=async()=>{const before=await snapshot();await expect(service.get(f.actor,f.intent.id)).rejects.toMatchObject({code:'VEHICLE_SERVICE_APPLICATION_SOURCE'});await expect(service.recover(f.actor,f.intent.id)).rejects.toMatchObject({code:'VEHICLE_SERVICE_APPLICATION_SOURCE'});expect(verifyBurn).not.toHaveBeenCalled();expect(await snapshot()).toEqual(before);};
 // Simulate damaged owner storage, one exact row guard at a time. Restore the
 // guard in the same transaction before testing the normal reader capability.
 await f.conn.sql.begin(async tx=>{await tx`alter table vehicle_service_applications disable trigger vehicle_service_applications_guard`;await tx`delete from vehicle_service_applications where intent_id=${f.intent.id}`;await tx`alter table vehicle_service_applications enable trigger vehicle_service_applications_guard`;});
 try{await assertHeld();}finally{await f.conn.sql.begin(async tx=>{await tx`alter table vehicle_service_applications disable trigger vehicle_service_applications_guard`;await tx`insert into vehicle_service_applications select * from jsonb_populate_record(null::vehicle_service_applications,${JSON.stringify(application)}::jsonb)`;await tx`set constraints vehicle_service_applications_complete immediate`;await tx`alter table vehicle_service_applications enable trigger vehicle_service_applications_guard`;});}
 expect(await service.get(f.actor,f.intent.id)).toEqual(saved);
 // An application-only orphan is normally impossible because of its FK. Disable
 // only that FK's DELETE check and the consumption row guard for fixture damage.
 const checks=await f.conn.sql`select t.tgname name from pg_trigger t join pg_constraint c on c.oid=t.tgconstraint
  where c.contype='f' and c.conrelid='public.vehicle_service_applications'::regclass and c.confrelid='public.vehicle_service_consumptions'::regclass
  and t.tgrelid=c.confrelid and t.tgisinternal and (t.tgtype::integer&8)=8`;
 expect(checks).toHaveLength(1);const deleteCheck=String(checks[0]!.name);
 await f.conn.sql.begin(async tx=>{await tx`alter table vehicle_service_consumptions disable trigger vehicle_service_consumptions_guard`;await tx`alter table vehicle_service_consumptions disable trigger ${tx(deleteCheck)}`;await tx`delete from vehicle_service_consumptions where intent_id=${f.intent.id}`;await tx`alter table vehicle_service_consumptions enable trigger ${tx(deleteCheck)}`;await tx`alter table vehicle_service_consumptions enable trigger vehicle_service_consumptions_guard`;});
 try{await assertHeld();}finally{await f.conn.sql.begin(async tx=>{await tx`alter table vehicle_service_consumptions disable trigger vehicle_service_consumptions_guard`;await tx`insert into vehicle_service_consumptions select * from jsonb_populate_record(null::vehicle_service_consumptions,${JSON.stringify(consumption)}::jsonb)`;await tx`set constraints vehicle_service_consumptions_complete immediate`;await tx`alter table vehicle_service_consumptions enable trigger vehicle_service_consumptions_guard`;});}
 expect(await service.get(f.actor,f.intent.id)).toEqual(saved);
 const flip=(v:string)=>(v[0]==='0'?'1':'0')+v.slice(1),alteredSignature=Uint8Array.from(bs58.decode(proof.signature));alteredSignature[17]=alteredSignature[17]!^1;
 const mismatches=[['signature',bs58.encode(alteredSignature)],['signed_transaction_sha256',flip(proof.signedTransactionSha256)],['original_message_sha256',flip(proof.originalMessageSha256)],['slot',proof.slot+1]] as const;
 for(const [field,value] of mismatches){
  await f.conn.sql.begin(async tx=>{await tx`alter table vehicle_service_consumptions disable trigger vehicle_service_consumptions_guard`;await tx`update vehicle_service_consumptions set ${tx(field)}=${value} where intent_id=${f.intent.id}`;await tx`alter table vehicle_service_consumptions enable trigger vehicle_service_consumptions_guard`;});
  try{await assertHeld();}finally{await f.conn.sql.begin(async tx=>{await tx`alter table vehicle_service_consumptions disable trigger vehicle_service_consumptions_guard`;await tx`update vehicle_service_consumptions set signature=${proof.signature},signed_transaction_sha256=${proof.signedTransactionSha256},original_message_sha256=${proof.originalMessageSha256},slot=${proof.slot} where intent_id=${f.intent.id}`;await tx`alter table vehicle_service_consumptions enable trigger vehicle_service_consumptions_guard`;});}
 }
 expect(await snapshot()).toEqual(pristine);expect(await service.get(f.actor,f.intent.id)).toEqual(saved);
 expect(await f.conn.sql`select tgname from pg_trigger where tgrelid in('public.vehicle_service_consumptions'::regclass,'public.vehicle_service_applications'::regclass) and tgenabled<>'O'`).toHaveLength(0);
},30_000);

it('denies a transaction facade and a restricted LOGIN even after accidental private-table grants',async()=>{
 await ready();const verifyBurn=vi.fn(f.reader.verify),before=await snapshot();
 await f.conn.db.transaction(async tx=>{expect(()=>Reflect.apply(createVehicleServiceApplications,undefined,[tx,{verifyBurn}])).toThrow('VEHICLE_SERVICE_APPLICATION_TOP_LEVEL');});
 const role='service_application_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
 await f.conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 try{
  const [database]=await f.conn.sql`select current_database() name`,url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());
  await expect(runtime.sql`select * from vehicle_service_consumptions`).rejects.toMatchObject({code:'42501'});
  const service=createVehicleServiceApplications(runtime.db,{verifyBurn});
  for(const request of [()=>service.get(f.actor,f.intent.id),()=>service.recover(f.actor,f.intent.id)])await expect(request()).rejects.toMatchObject({code:'VEHICLE_SERVICE_APPLICATION_OWNER'});
  await f.conn.sql.unsafe(`grant usage on schema public to ${role};grant select on all tables in schema public to ${role};grant all on vehicle_service_consumptions,vehicle_service_applications to ${role}`);
  expect(await runtime.sql`select has_table_privilege(current_user,'public.vehicle_service_consumptions','SELECT') reads,has_table_privilege(current_user,'public.vehicle_service_consumptions','INSERT') writes,current_user::regrole::oid=(select relowner from pg_class where oid='public.vehicle_service_consumptions'::regclass) owns`).toEqual([{reads:true,writes:true,owns:false}]);
  expect(await runtime.sql`select * from vehicle_service_consumptions`).toHaveLength(0);
  for(const request of [()=>service.get(f.actor,f.intent.id),()=>service.recover(f.actor,f.intent.id)])await expect(request()).rejects.toMatchObject({code:'VEHICLE_SERVICE_APPLICATION_OWNER'});
  expect(verifyBurn).not.toHaveBeenCalled();expect(await snapshot()).toEqual(before);
 }finally{await runtime?.sql.end();await f.conn.sql.unsafe(`drop owned by ${role}`);await f.conn.sql.unsafe(`drop role ${role}`);}
},30_000);
