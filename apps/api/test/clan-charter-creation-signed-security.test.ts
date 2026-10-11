import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { createDb,type Db } from '../src/db/client';
import { createCharterCreationSignedStore } from '../src/game/clanCharterCreationSignedStore';
import { charterCreationSignedFixture,postgresLeaf,signedRefusal,type SignedFixture } from './fixtures/charterCreationSigned';
let active:SignedFixture|undefined;
const fixture=()=>{if(!active)throw Error('Signed fixture setup incomplete');return active;};
beforeEach(async()=>{active=undefined;active=await charterCreationSignedFixture();},120_000);
afterEach(async()=>{vi.restoreAllMocks();const f=active;active=undefined;await f?.dispose();},120_000);
async function control(){const f=fixture(),p=await f.preparedSigned();return {...p,receipt:await f.store().accept(p.actor.wallet,p.consent.creationIntentId,p.wire)};}
async function guard(work:PromiseLike<unknown>,suffix:string,code='P0001'){
 expect(postgresLeaf(await Promise.resolve(work).then(()=>null,e=>e))).toEqual({code,message:'CLAN_CHARTER_SIGNED_'+suffix});
}

it('requires a top-level owner connection and rejects old RR or over-granted roles before private recovery',async()=>{
 const f=fixture(),p=await control();
 await f.db.transaction(async tx=>{expect(()=>createCharterCreationSignedStore(tx as unknown as Db)).toThrow(expect.objectContaining(signedRefusal('TOP_LEVEL')));});
 const owner=await f.dedicatedOwner();try{await owner.sql`begin isolation level repeatable read`;
  await guard(owner.sql`select public.shardkeep_charter_signed_read(${p.actor.wallet},${p.consent.creationIntentId}::uuid)`,'READ_COMMITTED');
 }finally{await owner.sql`rollback`;await owner.sql.end();}
 const role='charter_signed_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
 await f.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 try{await f.sql.unsafe(`grant usage on schema public to ${role};grant all on all tables in schema public to ${role};
   grant usage,select on all sequences in schema public to ${role};grant execute on all functions in schema public to ${role}`);
  const url=await f.ownerUrl();url.username=role;url.password=password;runtime=createDb(url.toString());
  await expect(createCharterCreationSignedStore(runtime.db).get(p.actor.wallet,p.consent.creationIntentId)).rejects.toMatchObject(signedRefusal('OWNER'));
  await guard(runtime.sql`insert into charter_creation_signed_wires(attempt_id,signed_transaction) values(${p.saved.attempt.id},${p.wire})`,'OWNER','42501');
 }finally{await runtime?.sql.end();await f.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
});

it('preserves signed source immutability and refuses disabled, conditional or column-restricted canonical hooks',async()=>{
 const f=fixture(),p=await control(),before=await f.signedRows();
 // Reapplying the additive DDL must preserve an already retained consent.
 await f.sql.unsafe(readFileSync(new URL('../drizzle/0228_charter_creation_signed_wires.sql',import.meta.url),'utf8'));
 expect(await f.signedRows()).toEqual(before);
 expect(await f.store().get(p.actor.wallet,p.consent.creationIntentId)).toEqual(p.receipt);
 await guard(f.sql`update charter_creation_signed_wires set signed_transaction=signed_transaction`,'IMMUTABLE');
 await guard(f.sql`delete from charter_creation_signed_wires`,'IMMUTABLE');
 await guard(f.sql`truncate charter_creation_signed_wires`,'IMMUTABLE');
 for(const hook of ['charter_creation_signed_wires_guard','charter_creation_signed_wires_no_truncate','charter_creation_signed_wires_complete']){
  await f.sql.unsafe(`alter table charter_creation_signed_wires disable trigger ${hook}`);
  try{await expect(f.store().get(p.actor.wallet,p.consent.creationIntentId)).rejects.toMatchObject(signedRefusal('HELD'));}
  finally{await f.sql.unsafe(`alter table charter_creation_signed_wires enable trigger ${hook}`);}
 }
 const owner=await f.dedicatedOwner();try{await owner.sql`begin`;
  await owner.sql`drop trigger charter_creation_signed_wires_guard on charter_creation_signed_wires`;
  await owner.sql.unsafe(`create trigger charter_creation_signed_wires_guard before insert or update of signed_transaction or delete on charter_creation_signed_wires for each row execute function shardkeep_charter_signed_private()`);
  await guard(owner.sql`select public.shardkeep_charter_signed_read(${p.actor.wallet},${p.consent.creationIntentId}::uuid)`,'HELD');
  await owner.sql`rollback`;await owner.sql`begin`;
  await owner.sql`drop trigger charter_creation_signed_wires_complete on charter_creation_signed_wires`;
  await owner.sql.unsafe(`create constraint trigger charter_creation_signed_wires_complete after insert on charter_creation_signed_wires deferrable initially deferred for each row when(false) execute function shardkeep_charter_signed_complete()`);
  await guard(owner.sql`select public.shardkeep_charter_signed_read(${p.actor.wallet},${p.consent.creationIntentId}::uuid)`,'HELD');
 }finally{await owner.sql`rollback`;await owner.sql.end();}
 expect(await f.signedRows()).toEqual(before);expect(await f.store().get(p.actor.wallet,p.consent.creationIntentId)).toEqual(p.receipt);
});

it('refuses copied TEMP triggers and caller-derived columns rather than trusting row shape or hashes',async()=>{
 const f=fixture(),p=await control(),q=await f.preparedSigned(),owner=await f.dedicatedOwner();
 await guard(f.sql`insert into charter_creation_signed_wires(attempt_id,signed_transaction,wallet) values(${q.saved.attempt.id},${q.wire},${q.actor.wallet})`,'DERIVED');
 await guard(f.sql`insert into charter_creation_signed_wires(attempt_id,signed_transaction) values(${q.saved.attempt.id},${p.wire})`,'WIRE');
 try{await owner.sql.unsafe(`create temporary table signed_copy(like public.charter_creation_signed_wires including defaults);
   create trigger charter_creation_signed_wires_guard before insert or update or delete on signed_copy for each row execute function public.shardkeep_charter_signed_private()`);
  await guard(owner.sql`insert into signed_copy(attempt_id,signed_transaction) values(${q.saved.attempt.id},${q.wire})`,'TRIGGER');
 }finally{await owner.sql.end();}
 expect(await f.signedRows()).toHaveLength(1);expect(await f.store().get(p.actor.wallet,p.consent.creationIntentId)).toEqual(p.receipt);
});

it('revalidates real wallet signatures on every read even when stored wire and digest are coherently damaged by the owner',async()=>{
 const f=fixture(),p=await control(),bad=Buffer.from(p.wire);bad[1]!^=1;
 const hooks=await f.sql`select tgname from pg_trigger where tgrelid='public.charter_creation_signed_wires'::regclass and not tgisinternal`;
 await f.sql.begin(async tx=>{
  for(const h of hooks)await tx.unsafe(`alter table charter_creation_signed_wires disable trigger "${String(h.tgname)}"`);
  await tx`update charter_creation_signed_wires set signed_transaction=${bad},signature=substring(${bad}::bytea from 2 for 64),wire_sha256=encode(sha256(${bad}::bytea),'hex') where attempt_id=${p.saved.attempt.id}`;
  for(const h of hooks)await tx.unsafe(`alter table charter_creation_signed_wires enable trigger "${String(h.tgname)}"`);
 });
 await expect(f.store().get(p.actor.wallet,p.consent.creationIntentId)).rejects.toMatchObject(signedRefusal('SOURCE'));
 await expect(f.store().accept(p.actor.wallet,p.consent.creationIntentId,p.wire)).rejects.toMatchObject(signedRefusal('SOURCE'));
 expect(await f.signedRows()).toHaveLength(1);
});

it('refuses damaged D166 policy preparation on both saved reads and duplicate accepts even when the wallet wire is valid',async()=>{
 const f=fixture(),p=await control(),before=await f.signedRows();
 const hooks=await f.sql`select tgname from pg_trigger where tgrelid='public.charter_creation_preparations'::regclass and not tgisinternal`;
 await f.sql.begin(async tx=>{
  for(const h of hooks)await tx.unsafe(`alter table charter_creation_preparations disable trigger "${String(h.tgname)}"`);
  await tx`update charter_creation_preparations set record=jsonb_set(record,'{policySignatureHex}',to_jsonb(${ '00'.repeat(64) }::text)) where attempt_id=${p.saved.attempt.id}`;
  for(const h of hooks)await tx.unsafe(`alter table charter_creation_preparations enable trigger "${String(h.tgname)}"`);
 });
 await expect(f.store().get(p.actor.wallet,p.consent.creationIntentId)).rejects.toMatchObject(signedRefusal('SOURCE'));
 await expect(f.store().accept(p.actor.wallet,p.consent.creationIntentId,p.wire)).rejects.toMatchObject(signedRefusal('SOURCE'));
 expect(await f.signedRows()).toEqual(before);
});

it('waits for actual commit and rolls back a deferred failure after the signed insert, then accepts one exact retry',async()=>{
 const f=fixture(),p=await f.preparedSigned();
 // Establish a completed control before installing the intentional abort, so
 // RED and unrelated setup errors cannot masquerade as rollback evidence.
 const q=await control(),before=await f.terminalSnapshot();
 await f.sql.unsafe(`create sequence signed_insert_reached;create function signed_insert_abort() returns trigger language plpgsql as $$begin
   perform nextval('signed_insert_reached');raise exception 'SIGNED_FIXTURE_COMMIT_FAILURE';end$$;
   create constraint trigger zzz_signed_insert_abort after insert on charter_creation_signed_wires deferrable initially deferred
   for each row execute function signed_insert_abort()`);
 await expect(f.store().accept(p.actor.wallet,p.consent.creationIntentId,p.wire)).rejects.toMatchObject(signedRefusal('HELD'));
 expect(await f.sql`select is_called from signed_insert_reached`).toEqual([{is_called:true}]);
 expect(await f.signedRows()).toHaveLength(1);expect(await f.terminalSnapshot()).toEqual(before);
 await f.sql`drop trigger zzz_signed_insert_abort on charter_creation_signed_wires`;
 expect((await f.store().accept(p.actor.wallet,p.consent.creationIntentId,p.wire)).signedTransactionHex).toBe(p.wire.toString('hex'));
 expect(await f.signedRows()).toHaveLength(2);expect(await f.store().get(q.actor.wallet,q.consent.creationIntentId)).toEqual(q.receipt);
});
