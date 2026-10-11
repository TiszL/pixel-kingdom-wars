/** New private original provenance cannot be fabricated by runtime or attestation. */
import {randomBytes,randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,expect,it} from 'vitest';
import {createVehicleIssuanceEvidenceReader,normalizeVehicleIssuanceOriginal} from '@shardkeep/chain/vehicle-issuance-evidence';
import {vehicleIssuanceFixture} from '../../../packages/chain/src/testFixtures/vehicleIssuance';
import {createVehicleIssuanceAcquisitions} from '../src/game/vehicleIssuanceAcquisitions';
import {createVehicleActivationReservations} from '../src/game/vehicleActivationReservations';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createDb,type Db} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';
const fixture=()=>vehicleIssuanceFixture(randomBytes(16).toString('hex'));
describe('private finalized vehicle acquisition bridge',()=>{
 const db=resourceClaimsDatabase();beforeAll(()=>db.setup(),120000);afterAll(()=>db.close());
 function service(f:ReturnType<typeof fixture>){const storage=createVehicleIssuanceAcquisitions(db.db);const readFinalized=createVehicleIssuanceEvidenceReader(()=>f.rpc,f.trust,storage.loadOriginal);return createVehicleIssuanceAcquisitions(db.db,{readFinalized});}
 it('records original before observing and preserves exact historical evidence offline without disguising owner assertions',async()=>{
  const f=fixture(),s=service(f);await s.saveOriginal(f.original);const proof=await s.acquire(f.original.rootId);
  expect(await createVehicleIssuanceAcquisitions(db.db).acquire(f.original.rootId)).toEqual(proof);
  const [row]=await db.sql`select provenance,owner_attestation,issuance_root from vehicle_mint_registry where asset_id=${f.original.identity.assetId}`;expect(row).toEqual({provenance:'finalized_issuance',owner_attestation:null,issuance_root:f.original.rootId});
  await expect(createVehicleActivationReservations(db.db).register(f.original.identity,{})).rejects.toThrow();
 });
 it('serializes two actual acquisition readers across independent database pools to one immutable result',async()=>{
  const f=fixture(),s=service(f);await s.saveOriginal(f.original);const reopened=db.reopen();try{const other=createVehicleIssuanceAcquisitions(reopened.db,{readFinalized:createVehicleIssuanceEvidenceReader(()=>f.rpc,f.trust,s.loadOriginal)});const [a,b]=await Promise.all([s.acquire(f.original.rootId),other.acquire(f.original.rootId)]);expect(a).toEqual(b);expect(await db.sql`select root_id from vehicle_issuance_acquisitions where root_id=${f.original.rootId}`).toHaveLength(1);}finally{await reopened.sql.end();}
 });
 it('rejects changed original terms, escrow reserves and any acquisition sourced from another original',async()=>{
  const f=fixture(),s=service(f);await s.saveOriginal(f.original);const {originalHash,...input}=f.original;
  const changed=normalizeVehicleIssuanceOriginal({...input,terms:{...input.terms,oddsBps:9999}});await expect(s.saveOriginal(changed)).rejects.toMatchObject({code:'VEHICLE_ISSUANCE_CONFLICT'});
  const changedReserve=normalizeVehicleIssuanceOriginal({...input,escrowRentReserve:(BigInt(input.escrowRentReserve)+1n).toString()});await expect(s.saveOriginal(changedReserve)).rejects.toMatchObject({code:'VEHICLE_ISSUANCE_CONFLICT'});
  const g=fixture(),foreign=await createVehicleIssuanceEvidenceReader(()=>g.rpc,g.trust,async()=>g.original)(g.original.rootId);await expect(createVehicleIssuanceAcquisitions(db.db,{readFinalized:async()=>foreign}).acquire(f.original.rootId)).rejects.toMatchObject({code:'VEHICLE_ISSUANCE_SOURCE'});
  expect(await s.get(f.original.rootId)).toBeNull();
 });
 it('keeps missing, pending, failed or unknown originals held without registry admission',async()=>{
  const f=fixture(),s=service(f);await expect(s.acquire(f.original.rootId)).rejects.toMatchObject({code:'VEHICLE_ISSUANCE_ORIGINAL'});await s.saveOriginal(f.original);f.rows[8]!.data=Buffer.from(f.rows[8]!.data);f.rows[8]!.data[513]=0;
  await expect(s.acquire(f.original.rootId)).rejects.toMatchObject({code:'VEHICLE_ISSUANCE_HELD'});expect(await s.get(f.original.rootId)).toBeNull();expect(await db.sql`select * from vehicle_mint_registry where asset_id=${f.original.identity.assetId}`).toHaveLength(0);
 });
 it('preserves legacy attestations and refuses upgrading one to independently verified issuance',async()=>{
  const f=fixture(),s=service(f);await createVehicleActivationReservations(db.db).register(f.original.identity,{source:'legacy assertion'});await s.saveOriginal(f.original);await expect(s.acquire(f.original.rootId)).rejects.toThrow();expect(await s.get(f.original.rootId)).toBeNull();
  expect((await db.sql`select provenance,issuance_root from vehicle_mint_registry where asset_id=${f.original.identity.assetId}`)[0]).toEqual({provenance:'owner_attestation',issuance_root:null});
 });
 it('rejects immutable table mutation and stale transaction isolation',async()=>{
  for(const table of ['vehicle_issuance_originals','vehicle_issuance_acquisitions'])for(const statement of [`update ${table} set root_id=root_id`,`delete from ${table}`,`truncate ${table} cascade`])await expect(db.sql.unsafe(statement)).rejects.toThrow('VEHICLE_ISSUANCE_IMMUTABLE');
  const f=fixture();await expect(db.sql.begin('isolation level repeatable read',async tx=>{await tx`insert into vehicle_issuance_originals(root_id,attempt_id,permit_id,asset_id,buyer,original) values(${f.original.rootId},${f.original.attemptId},${f.original.permitId},${f.original.identity.assetId},${f.original.buyer},${JSON.stringify(f.original)}::jsonb)`;})).rejects.toThrow('VEHICLE_ISSUANCE_READ_COMMITTED');
  await expect(db.db.transaction(async tx=>createVehicleIssuanceAcquisitions(tx as unknown as Db))).rejects.toMatchObject({code:'VEHICLE_ISSUANCE_TOP_LEVEL'});
 });
 it('denies direct runtime provenance even after accidental grants and rejects forged guard attachment',async()=>{
  const f=fixture(),role='vi_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
  await db.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
  try{const [database]=await db.sql`select current_database() name`;await db.sql.unsafe(`grant usage on schema public to ${role}`);const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());await expect(runtime.sql`select * from vehicle_issuance_originals`).rejects.toMatchObject({code:'42501'});
   await db.sql.unsafe(`grant all on vehicle_issuance_originals,vehicle_issuance_acquisitions,vehicle_mint_registry to ${role};grant execute on all functions in schema public to ${role};grant create on schema public to ${role}`);
   await expect(runtime.sql`insert into vehicle_issuance_originals(root_id,attempt_id,permit_id,asset_id,buyer,original) values(${f.original.rootId},${f.original.attemptId},${f.original.permitId},${f.original.identity.assetId},${f.original.buyer},${JSON.stringify(f.original)}::jsonb)`).rejects.toMatchObject({code:'42501'});
   await expect(runtime.sql`update vehicle_issuance_acquisitions set root_id=root_id`).rejects.toThrow();await expect(runtime.sql`truncate vehicle_issuance_acquisitions cascade`).rejects.toThrow();
   await runtime.sql.unsafe('create table fake_issuance (like vehicle_issuance_originals including defaults);create trigger fake_issuance_issuance_guard before insert on fake_issuance for each row execute function public.shardkeep_vehicle_issuance_guard()');
   await expect(runtime.sql`insert into fake_issuance(root_id,attempt_id,permit_id,asset_id,buyer,original) values(${f.original.rootId},${f.original.attemptId},${f.original.permitId},${f.original.identity.assetId},${f.original.buyer},${JSON.stringify(f.original)}::jsonb)`).rejects.toThrow('VEHICLE_ISSUANCE_TRIGGER');
  }finally{await runtime?.sql.end();await db.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 });
});
