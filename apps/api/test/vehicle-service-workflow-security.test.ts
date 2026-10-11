/** Closed-capability and redaction acceptance over real encoded Core accounts.
 * Deliberate owner storage damage below is not a runtime-role exploit. */
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createDb} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';
import {vehicleServicePreparationFixture} from './fixtures/vehicleServicePreparation';

let f:Awaited<ReturnType<typeof vehicleServicePreparationFixture>>;
beforeEach(async()=>{
 for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'])vi.stubEnv(flag,'true');
 f=await vehicleServicePreparationFixture();
},120_000);
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await f?.dispose();},120_000);
async function factory(){return (await import('../src/game/vehicleServiceWorkflow')).createVehicleServiceWorkflow;}
const command=()=>({installationId:f.reservation.id,assetId:f.asset.identity.assetId,operation:'upgrade' as const,idempotencyKey:f.intent.idempotencyKey});
async function workflow(){return (await factory())(f.conn.db,{connect:()=>f.rpc,trust:f.trust,getBlockhash:async()=>f.blockhash});}
async function prepare(){const p=await f.preparations.prepare(f.actor,f.intent.id);return {p,signed:f.finalizeService(p)};}
async function snapshot(){
 const result:Record<string,unknown>={};
 for(const table of ['vehicle_mint_registry','vehicle_service_intents','vehicle_service_burn_preparations','vehicle_service_signed_wires','vehicle_service_consumptions','vehicle_service_applications','advanced_vehicle_installations','accounts'])result[table]=await f.conn.sql.unsafe(`select to_jsonb(t)::text row from public.${table} t order by to_jsonb(t)::text`);
 return result;
}
function comparable<T extends {serverNow:string}>(value:T){const {serverNow:ignored,...rest}=value;return rest;}
// Remove exactly one immutable parent for corruption testing. Only its row
// guard and inbound FK DELETE checks are disabled; all are restored before the
// ordinary facade reads it. No production guard or migration is weakened.
async function withoutParent(table:'vehicle_mint_registry'|'vehicle_service_burn_preparations',key:'asset_id'|'intent_id',id:string,check:()=>Promise<void>){
 const [saved]=await f.conn.sql`select to_jsonb(t) row from ${f.conn.sql(table)} t where ${f.conn.sql(key)}=${id}`;
 expect(saved).toBeDefined();
 const checks=await f.conn.sql`select t.tgname name from pg_trigger t join pg_constraint c on c.oid=t.tgconstraint where c.contype='f' and c.confrelid=${'public.'+table}::regclass and t.tgrelid=c.confrelid and t.tgisinternal and (t.tgtype::integer&8)=8`;
 expect(checks.length).toBeGreaterThan(0);
 // 2026-10-10 (CI 37503885235): 0266 (e6af3ddd4) added vehicle_mint_registry_issuance_guard, a second
 // BEFORE DELETE guard (VEHICLE_ISSUANCE_IMMUTABLE). Model the same owner tamper by stepping past EVERY
 // user delete guard on the parent, not only the original <table>_guard; all are restored in this transaction.
 const guards=await f.conn.sql`select tgname name from pg_trigger where tgrelid=${'public.'+table}::regclass and not tgisinternal and (tgtype::integer&8)=8 order by tgname`;
 expect(guards.map(row=>row.name)).toContain(table+'_guard');
 await f.conn.sql.begin(async tx=>{
  for(const row of guards)await tx`alter table ${tx(table)} disable trigger ${tx(String(row.name))}`;
  for(const row of checks)await tx`alter table ${tx(table)} disable trigger ${tx(String(row.name))}`;
  await tx`delete from ${tx(table)} where ${tx(key)}=${id}`;
  for(const row of checks)await tx`alter table ${tx(table)} enable trigger ${tx(String(row.name))}`;
  for(const row of guards)await tx`alter table ${tx(table)} enable trigger ${tx(String(row.name))}`;
 });
 try{await check();}finally{await f.conn.sql.begin(async tx=>{
  await tx`alter table ${tx(table)} disable trigger ${tx(table+'_guard')}`;
  await tx`insert into ${tx(table)} select * from jsonb_populate_record(null::${tx(table)},${JSON.stringify(saved!.row)}::jsonb)`;
  await tx`alter table ${tx(table)} enable trigger ${tx(table+'_guard')}`;
 });}
 expect(await f.conn.sql`select tgname from pg_trigger where tgrelid=${'public.'+table}::regclass and tgenabled<>'O'`).toHaveLength(0);
}

it('retains constructor trust and provider functions after the caller replaces every original dependency',async()=>{
 const make=await factory(),connect=vi.fn(()=>f.rpc),getBlockhash=vi.fn(async()=>f.blockhash),trust={...f.trust},deps={connect,trust,getBlockhash};
 const service=make(f.conn.db,deps),replacementConnect=vi.fn(()=>{throw Error('replaced connector');}),replacementBlockhash=vi.fn(async()=>{throw Error('replaced blockhash provider');});
 deps.connect=replacementConnect;deps.getBlockhash=replacementBlockhash;
 trust.expectedGenesisHash=Keypair.generate().publicKey.toBase58();trust.reviewedDeploymentSlot++;
 trust.reviewedProgramDataSha256='0'.repeat(64);
 const prepared=await service.prepare(f.actor,f.intent.id),original=await f.preparations.get(f.actor,f.intent.id);
 expect(prepared.preparation!.messageSha256).toBe(original!.messageSha256);
 expect(original!.anchor.genesisHash).toBe(f.trust.expectedGenesisHash);
 expect(original!.anchor.reviewedProgramDataSha256).toBe(f.trust.reviewedProgramDataSha256);
 f.finalizeService(original!);expect((await service.recover(f.actor,f.intent.id)).status).toBe('applied');
 expect(connect).toHaveBeenCalled();expect(getBlockhash).toHaveBeenCalledTimes(1);
 expect(replacementConnect).not.toHaveBeenCalled();expect(replacementBlockhash).not.toHaveBeenCalled();
},30_000);

it('owns replay commands and signed bytes before the first asynchronous authority read',async()=>{
 const service=await workflow(),input=command(),pending=service.reserve(f.actor,input);
 input.assetId=Keypair.generate().publicKey.toBase58();input.installationId=randomUUID();input.idempotencyKey=randomUUID();
 const replay=await pending;expect(replay.intent.intentId).toBe(f.intent.id);expect(replay.intent.request.idempotencyKey).toBe(f.intent.idempotencyKey);
 const {signed}=await prepare(),bytes=Uint8Array.from(signed.signedTransaction),hex=Buffer.from(bytes).toString('hex'),retention=service.retainSigned(f.actor,f.intent.id,bytes);bytes.fill(0);
 expect((await retention).signed!.signature).toBe(signed.signature);
 expect(await f.conn.sql`select encode(signed_transaction,'hex') wire from vehicle_service_signed_wires where intent_id=${f.intent.id}`).toEqual([{wire:hex}]);
 expect(await f.conn.sql`select id from vehicle_service_intents`).toEqual([{id:f.intent.id}]);
},30_000);

it('refuses a lower workflow status when signed or applied history has lost its preparation',async()=>{
 const service=await workflow(),{signed}=await prepare();await service.retainSigned(f.actor,f.intent.id,signed.signedTransaction);
 const assertHeld=async()=>{const before=await snapshot();await expect(service.read(f.actor,f.intent.id)).rejects.toMatchObject({code:'VEHICLE_SERVICE_HISTORY_HELD'});await expect(service.readByKey(f.actor,f.intent.idempotencyKey)).rejects.toMatchObject({code:'VEHICLE_SERVICE_HISTORY_HELD'});await expect(service.prepare(f.actor,f.intent.id)).rejects.toMatchObject({code:'VEHICLE_SERVICE_HISTORY_HELD'});expect(await snapshot()).toEqual(before);};
 await withoutParent('vehicle_service_burn_preparations','intent_id',f.intent.id,assertHeld);
 expect((await service.read(f.actor,f.intent.id)).status).toBe('signed');await service.recover(f.actor,f.intent.id);
 await withoutParent('vehicle_service_burn_preparations','intent_id',f.intent.id,assertHeld);
 expect((await service.read(f.actor,f.intent.id)).status).toBe('applied');
 // Also exercise the downstream complete-pair reader through the facade.
 await f.conn.sql.begin(async tx=>{await tx`alter table vehicle_service_consumptions disable trigger vehicle_service_consumptions_guard`;await tx`update vehicle_service_consumptions set slot=slot+1 where intent_id=${f.intent.id}`;await tx`alter table vehicle_service_consumptions enable trigger vehicle_service_consumptions_guard`;});
 const before=await snapshot();await expect(service.read(f.actor,f.intent.id)).rejects.toMatchObject({code:'VEHICLE_SERVICE_APPLICATION_SOURCE'});await expect(service.recover(f.actor,f.intent.id)).rejects.toMatchObject({code:'VEHICLE_SERVICE_RECOVERY_HELD'});expect(await snapshot()).toEqual(before);
},30_000);

it('holds a known actor intent with missing registry provenance instead of treating it as unknown or reserving again',async()=>{
 const make=await factory(),connect=vi.fn(()=>f.rpc),service=make(f.conn.db,{connect,trust:f.trust,getBlockhash:async()=>f.blockhash});
 await withoutParent('vehicle_mint_registry','asset_id',f.asset.identity.assetId,async()=>{
  const before=await snapshot();
  for(const action of [()=>service.read(f.actor,f.intent.id),()=>service.readByKey(f.actor,f.intent.idempotencyKey),()=>service.reserve(f.actor,command())])await expect(action()).rejects.toMatchObject({code:'VEHICLE_SERVICE_HISTORY_HELD'});
  expect(connect).not.toHaveBeenCalled();expect(await snapshot()).toEqual(before);
 });
 expect((await service.read(f.actor,f.intent.id)).intent.intentId).toBe(f.intent.id);
},30_000);

it('returns only the explicit public DTO and detached objects at every durable stage',async()=>{
 const service=await workflow(),reserved=await service.read(f.actor,f.intent.id),prepared=await service.prepare(f.actor,f.intent.id),original=await f.preparations.get(f.actor,f.intent.id),signed=f.finalizeService(original!),retained=await service.retainSigned(f.actor,f.intent.id,signed.signedTransaction),applied=await service.recover(f.actor,f.intent.id);
 for(const value of [reserved,prepared,retained,applied]){
  expect(Object.keys(value).sort()).toEqual(['version','purpose','wallet','idempotencyKey','intent','preparation','signed','application','status','serverNow','signingAuthorized','broadcastAuthorized','serviceAuthorized','reservationReleaseAuthorized'].sort());
  expect(Object.keys(value.intent).sort()).toEqual(['intentId','wallet','request','identity','state','reservedAt'].sort());
  if(value.preparation)expect(Object.keys(value.preparation).sort()).toEqual(['messageHex','messageSha256','serviceSha256','blockhash','blockhashContextSlot','lastValidBlockHeight','recordedAt'].sort());
  if(value.signed)expect(Object.keys(value.signed).sort()).toEqual(['signature','wireSha256','messageSha256','acceptedAt'].sort());
  if(value.application)expect(Object.keys(value.application).sort()).toEqual(['tierAfter','revisionAfter','completedTotal','allowanceStartAfter','remainingUses','appliedAt','signature'].sort());
  const text=JSON.stringify(value);for(const secret of ['owner_anchor','assetDataHex','collectionDataHex','signedTransactionHex','transactionEvidenceVerified','configured-provider-trust','finalizedThroughSlot'])expect(text).not.toContain(secret);
  expect(text).not.toContain(original!.anchor.assetDataHex);expect(text).not.toContain(Buffer.from(signed.signedTransaction).toString('hex'));
 }
 const expected=comparable(await service.read(f.actor,f.intent.id)),before=await snapshot();
 applied.intent.state.tier=4;applied.intent.identity.assetId=Keypair.generate().publicKey.toBase58();applied.preparation!.messageHex='00';applied.application!.tierAfter=4;
 expect(comparable(await service.read(f.actor,f.intent.id))).toEqual(expected);expect(await snapshot()).toEqual(before);
},30_000);

it('rejects a transaction facade and nonowner factories even after accidental private table grants',async()=>{
 const make=await factory(),{signed}=await prepare(),connect=vi.fn(()=>f.rpc),before=await snapshot();
 await f.conn.db.transaction(async tx=>{expect(()=>Reflect.apply(make,undefined,[tx,{connect,trust:f.trust}])).toThrow(expect.objectContaining({code:'VEHICLE_SERVICE_WORKFLOW_TOP_LEVEL'}));});
 const role='service_facade_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
 await f.conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 try{
  const [database]=await f.conn.sql`select current_database() name`,url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());
  await expect(runtime.sql`select * from vehicle_service_intents`).rejects.toMatchObject({code:'42501'});
  const service=make(runtime.db,{connect,trust:f.trust,getBlockhash:async()=>f.blockhash});
  for(const grants of [false,true]){
   if(grants)await f.conn.sql.unsafe(`grant usage on schema public to ${role};grant all on all tables in schema public to ${role}`);
   for(const action of [()=>service.read(f.actor,f.intent.id),()=>service.readByKey(f.actor,f.intent.idempotencyKey),()=>service.reserve(f.actor,command()),()=>service.prepare(f.actor,f.intent.id),()=>service.retainSigned(f.actor,f.intent.id,signed.signedTransaction),()=>service.recover(f.actor,f.intent.id)])await expect(action()).rejects.toMatchObject({code:expect.stringMatching(/_OWNER$/)});
  }
  expect(connect).not.toHaveBeenCalled();expect(await snapshot()).toEqual(before);
 }finally{await runtime?.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
},30_000);
