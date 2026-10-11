/** Consistency/retention guards do not turn owner-supplied RPC assertions into
 * cryptographic funding or current chain authority. No live signing service. */
import { randomUUID } from 'node:crypto';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { createDb,type Db } from '../src/db/client';
import { createCharterCreationPreparation } from '../src/game/clanCharterCreationPreparation';
import { charterCreationPreparationFixture,postgresLeaf,preparationRefusal,type PreparationFixture } from './fixtures/charterCreationPreparation';
let active:PreparationFixture|undefined;
const fixture=()=>{if(!active)throw Error('Preparation fixture setup did not complete');return active;};
beforeEach(async()=>{active=undefined;active=await charterCreationPreparationFixture();},120_000);
afterEach(async()=>{vi.restoreAllMocks();const current=active;active=undefined;await current?.dispose();},120_000);
const json=(v:unknown)=>JSON.stringify(v,(_key,value:unknown)=>typeof value==='bigint'?value.toString():value);
async function guard(work:PromiseLike<unknown>,suffix:string,code='P0001'){
 expect(postgresLeaf(await Promise.resolve(work).then(()=>null,error=>error))).toEqual({code,message:'CLAN_CHARTER_PREPARATION_'+suffix});
}
async function control(){const f=fixture(),p=await f.admitted(),saved=await p.service().prepare(p.actor.wallet,p.consent.creationIntentId);return {...p,saved};}

it('rejects transaction factories, old RR snapshots and an over-granted nonowner before private visibility',async()=>{
 const f=fixture();await f.db.transaction(async tx=>{
  expect(()=>createCharterCreationPreparation(tx as unknown as Db,{chain:null,issuer:null})).toThrow(expect.objectContaining(preparationRefusal('TOP_LEVEL')));
 });
 const p=await f.admitted(),owner=await f.dedicatedOwner();
 try{await owner.sql`begin isolation level repeatable read`;expect(await owner.sql`select * from charter_creation_issuance_attempts`).toHaveLength(0);
  await p.service().prepare(p.actor.wallet,p.consent.creationIntentId);
  await guard(owner.sql`select public.shardkeep_charter_preparation_read(${p.actor.wallet},${p.consent.creationIntentId}::uuid)`,'READ_COMMITTED');
 }finally{await owner.sql`rollback`;await owner.sql.end();}
 const role='prep_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
 await f.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 try{await f.sql.unsafe(`grant usage on schema public to ${role};grant all on all tables in schema public to ${role};
   grant usage,select on all sequences in schema public to ${role};grant execute on all functions in schema public to ${role}`);
  const url=await f.ownerUrl();url.username=role;url.password=password;runtime=createDb(url.toString());
  await expect(createCharterCreationPreparation(runtime.db,{chain:null,issuer:null}).read(p.actor.wallet,p.consent.creationIntentId)).rejects.toMatchObject(preparationRefusal('OWNER'));
  await guard(runtime.sql`insert into charter_creation_issuance_attempts select * from charter_creation_issuance_attempts`,'OWNER','42501');
 }finally{await runtime?.sql.end();await f.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
});

it('retains both private records against UPDATE DELETE and TRUNCATE and detects missing retention hooks',async()=>{
 const f=fixture(),p=await control(),before={attempts:await f.attempts(),preparations:await f.preparations()};
 for(const table of ['charter_creation_issuance_attempts','charter_creation_preparations']){
  await guard(f.sql.unsafe(`update public.${table} set record=record`),'IMMUTABLE');
  await guard(f.sql.unsafe(`delete from public.${table}`),'IMMUTABLE');
  await guard(f.sql.unsafe(`truncate public.${table} cascade`),'IMMUTABLE');
  const hooks=await f.sql`select tgname from pg_trigger where tgrelid=${'public.'+table}::regclass and not tgisinternal order by tgname`;
  expect(hooks.length).toBeGreaterThan(0);const name=String(hooks[0]!.tgname);
  await f.sql.unsafe(`alter table public.${table} disable trigger "${name}"`);
  try{await expect(p.service().read(p.actor.wallet,p.consent.creationIntentId)).rejects.toMatchObject(preparationRefusal('HELD'));}
  finally{await f.sql.unsafe(`alter table public.${table} enable trigger "${name}"`);}
 }
 expect({attempts:await f.attempts(),preparations:await f.preparations()}).toEqual(before);
 expect(await p.service().read(p.actor.wallet,p.consent.creationIntentId)).toEqual(p.saved);
});

it('rejects fresh-key direct and TEMP copied attempts that do not bind their genuine funded admission',async()=>{
 const f=fixture(),p=await control(),q=await f.admitted(await f.actor()),row=(await f.attempts())[0]!,id=randomUUID(),owner=await f.dedicatedOwner();
 // Fresh keys avoid PK/FK rejection masking the intended source mismatch. The
 // proposed record still belongs to p and cannot be relabeled as q's source.
 await guard(f.sql`insert into charter_creation_issuance_attempts(id,reservation_id,record)
  values(${id},${q.consent.reservationId},${json(row.record)}::jsonb)`,'SOURCE');
 try{await owner.sql.unsafe(`create temporary table prep_attack(id uuid,reservation_id uuid,record jsonb);
   create function pg_temp.prep_attack() returns trigger language plpgsql as $$begin
    insert into public.charter_creation_issuance_attempts(id,reservation_id,record) values(NEW.id,NEW.reservation_id,NEW.record);return NEW;end$$;
   create trigger prep_attack after insert on prep_attack for each row execute function pg_temp.prep_attack();`);
  await guard(owner.sql`insert into prep_attack values(${id},${q.consent.reservationId},${json(row.record)}::jsonb)`,'SOURCE');
 }finally{await owner.sql.end();}
 expect(await q.service().read(q.actor.wallet,q.consent.creationIntentId)).toBeNull();expect(await f.attempts()).toHaveLength(1);
 expect(await p.service().read(p.actor.wallet,p.consent.creationIntentId)).toEqual(p.saved);
});

it('revalidates cryptographic signature and canonical packet on every history path after owner storage damage',async()=>{
 const f=fixture(),p=await control(),row=(await f.preparations())[0]!;
 expect(row.record.policySignatureHex).toBe(p.saved.preparation!.policySignatureHex);
 const hooks=await f.sql`select tgname from pg_trigger where tgrelid='public.charter_creation_preparations'::regclass and not tgisinternal order by tgname`;
 expect(hooks.length).toBeGreaterThan(0);
 await f.sql.begin(async tx=>{
  for(const h of hooks)await tx.unsafe(`alter table public.charter_creation_preparations disable trigger "${String(h.tgname)}"`);
  await tx`update charter_creation_preparations set record=jsonb_set(record,'{policySignatureHex}',to_jsonb(${ '00'.repeat(64) }::text)) where attempt_id=${row.attempt_id}`;
  for(const h of hooks)await tx.unsafe(`alter table public.charter_creation_preparations enable trigger "${String(h.tgname)}"`);
 });
 const damaged=await f.preparations(),offline=createCharterCreationPreparation(f.db,{chain:null,issuer:null});
 for(const method of ['read','prepare','recover'] as const)await expect(offline[method](p.actor.wallet,p.consent.creationIntentId)).rejects.toMatchObject(preparationRefusal('HELD'));
 expect(await f.preparations()).toEqual(damaged);expect(p.issuer.issueOnce).toHaveBeenCalledTimes(1);
});

it('rolls back a failed prepared-result insert but recovers the exact already-issued receipt without another issuance',async()=>{
 const f=fixture(),p=await f.admitted();
 expect(await p.service().read(p.actor.wallet,p.consent.creationIntentId)).toBeNull();
 await f.sql.unsafe(`create sequence public.preparation_fixture_reached;create function public.preparation_fixture_abort() returns trigger language plpgsql as $$begin
  perform nextval('public.preparation_fixture_reached');raise exception 'PREPARATION_FIXTURE_AFTER_INSERT';end$$;
  create trigger zzz_preparation_fixture_abort after insert on public.charter_creation_preparations
   for each row execute function public.preparation_fixture_abort();`);
 await expect(p.service().prepare(p.actor.wallet,p.consent.creationIntentId)).rejects.toMatchObject(preparationRefusal('HELD'));
 expect(await f.attempts()).toHaveLength(1);expect(await f.preparations()).toHaveLength(0);expect(p.signatures()).toBe(1);
 // The AFTER marker proves the actual private insert was reached, rather than
 // accepting an unrelated original-source refusal as rollback evidence.
 expect(p.receipts.size).toBe(1);expect(await f.sql`select is_called from preparation_fixture_reached`).toEqual([{is_called:true}]);
 await f.sql`drop trigger zzz_preparation_fixture_abort on charter_creation_preparations`;
 const recovered=await p.service().recover(p.actor.wallet,p.consent.creationIntentId);expect(recovered.preparation).not.toBeNull();
 expect(p.issuer.issueOnce).toHaveBeenCalledTimes(1);expect(p.rpc.getLatestBlockhashAndContext).toHaveBeenCalledTimes(1);
});
