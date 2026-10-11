/** New private request boundary only. Earned stock comes from the accepted
 * fixture; quote banks are explicit serialized fixtures, never live finality. */
import {randomUUID} from 'node:crypto';
import {Keypair,Message,VersionedTransaction} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {expect,it,vi} from 'vitest';
import {VEHICLE_CRAFT_PROGRAM} from '@shardkeep/chain/vehicle-issuance-protocol';
import {createVehicleIssuanceQuoteReader,type VehicleIssuanceQuoteInput} from '@shardkeep/chain/vehicle-issuance-quote';
import {vehicleIssuanceQuoteFixture} from '../../../packages/chain/src/testFixtures/vehicleIssuanceQuote';
import type {VehicleCraftMaterialRecord} from '../src/game/vehicleCraftMaterials';
import {createVehicleCraftPreparation} from '../src/game/vehicleCraftPreparation';
import {createVehicleCraftSignedStore} from '../src/game/vehicleCraftSignedStore';
import {VEHICLE_ISSUER_PURPOSE,vehicleIssuerAttemptFromMaterial,vehicleIssuerReceipt} from '../src/vehiclePolicyIssuerJournal';
import {withVehicleCraftClientFixture} from './fixtures/vehicleCraftClient';
import {resealVehicleRequestFixture} from './fixtures/vehicleCraftPreparation';
import {signVehiclePolicy} from './fixtures/vehiclePolicyIssuer';
import {SEAL_BOUND_EARNED_VEHICLE_CASE_MS} from './sealLatencyBudgets';
const signal=()=>new AbortController().signal;
const request=(m:VehicleCraftMaterialRecord)=>({wallet:m.actorWallet,idempotencyKey:m.request.idempotencyKey});
function fixtures(m:VehicleCraftMaterialRecord){
 const policy=Keypair.generate(),publicKey=policy.publicKey.toBase58(),attempt=vehicleIssuerAttemptFromMaterial(m,request(m),publicKey,{purpose:VEHICLE_ISSUER_PURPOSE,genesisHash:m.original.genesisHash,craftProgram:VEHICLE_CRAFT_PROGRAM});
 const receipt=vehicleIssuerReceipt({attempt,signatureHex:Buffer.from(signVehiclePolicy(policy,Buffer.from(attempt.messageHex,'hex'))).toString('hex')})!;
 const quote=vi.fn(async(input:VehicleIssuanceQuoteInput,s:AbortSignal)=>{const b=vehicleIssuanceQuoteFixture(m.original,policy);return createVehicleIssuanceQuoteReader(()=>b.rpc,b.trust,publicKey,{costLimits:b.costLimits})(input,s);});
 return {policy,publicKey,attempt,receipt,quote};
}
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}

it('commits before dispatch, recovers a failed quote once and retains one canonical wallet wire',()=>withVehicleCraftClientFixture(async f=>{
 await resealVehicleRequestFixture(f.conn);const m=await f.reserve(),r=request(m),x=fixtures(m);
 await expect(createVehicleCraftPreparation(f.db).prepare(r,signal())).rejects.toMatchObject({code:'VEHICLE_REQUEST_UNCONFIGURED'});
 expect(await createVehicleCraftPreparation(f.db).get(r)).toBeNull();
 await expect(createVehicleCraftPreparation(f.db).get({...r,extra:true} as typeof r)).rejects.toThrow();
 await expect(createVehicleCraftPreparation(f.db).get({...r,wallet:Keypair.generate().publicKey.toBase58()})).rejects.toThrow();
 const issuer={publicKey:x.publicKey,issueOnce:vi.fn(async()=>{
  expect(await f.conn.sql`select reservation_id from public.vehicle_request_issuance_attempts where reservation_id=${m.id}`).toHaveLength(1);
  // A separate transaction can take the game row while the external call runs.
  await f.db.transaction(async tx=>{await tx.execute(sql`select id from public.vehicle_craft_material_reservations where id=${m.id}::uuid for update nowait`);});return x.receipt;
 }),lookup:vi.fn(async()=>x.receipt)};
 let rejectQuote=true;const quote=vi.fn(async(input:VehicleIssuanceQuoteInput,s:AbortSignal)=>{if(rejectQuote)throw Error('lost provider');return x.quote(input,s);});
 const service=createVehicleCraftPreparation(f.db,{enabled:()=>true,issuer,quote});
 await expect(service.prepare(r,signal())).rejects.toThrow('lost provider');
 expect((await service.get(r))?.preparation).toBeNull();expect(issuer.issueOnce).toHaveBeenCalledTimes(1);
 rejectQuote=false;const prepared=await service.prepare(r,signal());expect(prepared.preparation).not.toBeNull();expect(issuer.lookup).toHaveBeenCalledTimes(1);
 expect(prepared.attempt.record).toEqual(x.attempt);expect(prepared.signingAuthorized).toBe(false);
 const tx=new VersionedTransaction(Message.from(Buffer.from(prepared.preparation!.quote.messageHex,'hex')));tx.sign([f.seller.signer]);const bytes=tx.serialize(),wrong=Uint8Array.from(bytes);wrong[1]=wrong[1]!^1;
 const store=createVehicleCraftSignedStore(f.db);expect(await store.get(r)).toBeNull();await expect(store.accept(r,wrong)).rejects.toThrow();
 const [a,b]=await Promise.all([store.accept(r,bytes),store.accept(r,bytes)]);expect(a).toEqual(b);expect(a.messageSha256).toBe(prepared.preparation!.quote.messageSha256);expect(a.broadcastAuthorized).toBe(false);
 expect(await f.conn.sql`select reservation_id from public.vehicle_request_signed_wires`).toHaveLength(1);
 const detached=Uint8Array.from(bytes),retaining=store.accept(r,detached);detached.fill(0);expect(await retaining).toEqual(a);
 const reopened=createVehicleCraftPreparation(f.db);expect(await reopened.prepare(r,signal())).toEqual(prepared);expect(await reopened.get(r)).toEqual(prepared);
 expect(await createVehicleCraftSignedStore(f.db).get(r)).toEqual(a);expect(issuer.issueOnce).toHaveBeenCalledTimes(1);expect(quote).toHaveBeenCalledTimes(2);
 await expect(resealVehicleRequestFixture(f.conn)).rejects.toThrow('empty disposable');
}),SEAL_BOUND_EARNED_VEHICLE_CASE_MS);

it('reopens even a crash-before-dispatch by lookup only and preserves the first racing quote',()=>withVehicleCraftClientFixture(async f=>{
 await resealVehicleRequestFixture(f.conn);const m=await f.reserve(),r=request(m),x=fixtures(m);
 await f.conn.sql`insert into public.vehicle_request_issuance_attempts(reservation_id,actor_wallet,idempotency_key,policy_authority,record) values(${m.id},${r.wallet},${r.idempotencyKey},${x.publicKey},${JSON.stringify(x.attempt)}::jsonb)`;
 const issuer={publicKey:x.publicKey,issueOnce:vi.fn(async()=>x.receipt),lookup:vi.fn(async()=>null as typeof x.receipt|null)};
 const service=createVehicleCraftPreparation(f.db,{enabled:()=>true,issuer,quote:x.quote});await expect(service.prepare(r,signal())).rejects.toMatchObject({code:'VEHICLE_REQUEST_ISSUER_PENDING'});expect(issuer.issueOnce).not.toHaveBeenCalled();expect(x.quote).not.toHaveBeenCalled();
 // A completed issuer journal can recover this same immutable attempt; quote
 // racers may observe different fees, but exactly one preparation is retained.
 issuer.lookup.mockResolvedValue(x.receipt);const gate=deferred<void>();let arrivals=0;
 // The two real readers use the receipt's actual policy key through x.quote.
 const racingQuote=vi.fn(async(input:VehicleIssuanceQuoteInput,s:AbortSignal)=>{const n=++arrivals;if(n===2)gate.resolve();await gate.promise;const b=vehicleIssuanceQuoteFixture(m.original,x.policy);b.controls.networkFee+=n;return createVehicleIssuanceQuoteReader(()=>b.rpc,b.trust,x.publicKey,{costLimits:b.costLimits})(input,s);});
 const raced=createVehicleCraftPreparation(f.db,{enabled:()=>true,issuer,quote:racingQuote}),[a,b]=await Promise.all([raced.prepare(r,signal()),raced.prepare(r,signal())]);
 expect(a).toEqual(b);expect(await f.conn.sql`select reservation_id from public.vehicle_request_preparations`).toHaveLength(1);expect(issuer.issueOnce).not.toHaveBeenCalled();expect(issuer.lookup).toHaveBeenCalledTimes(3);
 const m2=await f.reserve(),r2=request(m2),x2=fixtures(m2),entered=deferred<void>(),release=deferred<void>();
 const issue=vi.fn(async()=>{entered.resolve();await release.promise;throw Error('reply lost after journal completion');}),lookup=vi.fn(async()=>x2.receipt);
 const lost=createVehicleCraftPreparation(f.db,{enabled:()=>true,issuer:{publicKey:x2.publicKey,issueOnce:issue,lookup},quote:x2.quote}),first=lost.prepare(r2,signal());const firstChecked=expect(first).rejects.toThrow('reply lost');await entered.promise;
 const recovered=await lost.prepare(r2,signal());release.resolve();await firstChecked;expect(await lost.get(r2)).toEqual(recovered);expect(issue).toHaveBeenCalledTimes(1);expect(lookup).toHaveBeenCalledTimes(1);
}),SEAL_BOUND_EARNED_VEHICLE_CASE_MS);

it('keeps ignored-abort provider work charged until it drains and never dispatches a replacement',()=>withVehicleCraftClientFixture(async f=>{
 await resealVehicleRequestFixture(f.conn);const m=await f.reserve(),r=request(m),x=fixtures(m),drain=deferred<void>();let entered=0;const notifications:ReturnType<typeof deferred<void>>[]=[];
 const external=async()=>{entered++;notifications.shift()?.resolve();await drain.promise;return x.receipt;};
 const issue=vi.fn(external),lookup=vi.fn(external),service=createVehicleCraftPreparation(f.db,{enabled:()=>true,issuer:{publicKey:x.publicKey,issueOnce:issue,lookup},quote:x.quote});
 for(let i=0;i<8;i++){const ready=deferred<void>();notifications.push(ready);const abort=new AbortController(),result=service.prepare(r,abort.signal),checked=expect(result).rejects.toMatchObject({code:'VEHICLE_REQUEST_ABORTED'});await Promise.race([ready.promise,result.then(()=>{throw Error('provider was not reached');},e=>{throw e;})]);abort.abort();await checked;}
 expect(entered).toBe(8);await expect(service.prepare(r,signal())).rejects.toMatchObject({code:'VEHICLE_REQUEST_BUSY'});expect(issue).toHaveBeenCalledTimes(1);expect(x.quote).not.toHaveBeenCalled();
 drain.resolve();await new Promise(resolve=>setImmediate(resolve));const saved=await service.prepare(r,signal());expect(saved.preparation).not.toBeNull();expect(issue).toHaveBeenCalledTimes(1);expect(lookup).toHaveBeenCalledTimes(8);
}),SEAL_BOUND_EARNED_VEHICLE_CASE_MS);

it('guards SQL actor/body bindings, immutable artifacts, isolation, ACL and source drift',()=>withVehicleCraftClientFixture(async f=>{
 await resealVehicleRequestFixture(f.conn);const m=await f.reserve(),r=request(m),x=fixtures(m);
 const insert=async(record:unknown=x.attempt)=>f.conn.sql`insert into public.vehicle_request_issuance_attempts(reservation_id,actor_wallet,idempotency_key,policy_authority,record) values(${m.id},${r.wallet},${r.idempotencyKey},${x.publicKey},${JSON.stringify(record)}::jsonb)`;
 await expect(insert({...x.attempt,material:{...x.attempt.material,nonce:'00'.repeat(32)}})).rejects.toThrow('VEHICLE_REQUEST_ATTEMPT');
 await expect(insert({...x.attempt,wallet:Keypair.generate().publicKey.toBase58()})).rejects.toThrow('VEHICLE_REQUEST_ATTEMPT');
 expect(await f.conn.sql`select reservation_id from public.vehicle_request_issuance_attempts`).toHaveLength(0);
 const service=createVehicleCraftPreparation(f.db,{enabled:()=>true,issuer:{publicKey:x.publicKey,issueOnce:async()=>x.receipt,lookup:async()=>x.receipt},quote:x.quote}),saved=await service.prepare(r,signal());
 await expect(f.conn.sql`update public.vehicle_request_issuance_attempts set record=record`).rejects.toThrow('IMMUTABLE');
 await expect(f.conn.sql`delete from public.vehicle_request_preparations`).rejects.toThrow('IMMUTABLE');
 // 2026-10-10 (r2 v-vehicle-seal-latency): since 0274 (5fd4a3cd3, D153.215) the delivery dispatches and
 // receipts reference signed wires, so PostgreSQL refuses a lone TRUNCATE (0A000) before any trigger runs.
 // This pin sat behind the case's 120 s timeout. Prove both refusals: the foreign-key refusal, and, with
 // every referencing table named so that check passes, the request guard itself (listed first, so it fires first).
 await expect(f.conn.sql`truncate public.vehicle_request_signed_wires`).rejects.toMatchObject({code:'0A000'});
 await expect(f.conn.sql`truncate public.vehicle_request_signed_wires,public.vehicle_request_dispatches,public.vehicle_request_dispatch_acknowledgements,public.vehicle_request_delivery_receipts`).rejects.toThrow('VEHICLE_REQUEST_IMMUTABLE');
 await expect(f.conn.sql`update public.vehicle_request_preparation_contract set record=record`).rejects.toThrow('SEAL_IMMUTABLE');
 await expect(f.conn.sql.begin(async tx=>{await tx`set transaction isolation level repeatable read`;await tx`select public.shardkeep_vehicle_request_source()`;})).rejects.toThrow('OWNER_ISOLATION');
 await expect(f.db.transaction(async tx=>createVehicleCraftPreparation(tx as never))).rejects.toMatchObject({code:'VEHICLE_REQUEST_TOP_LEVEL'});
 await expect(f.db.transaction(async tx=>createVehicleCraftSignedStore(tx as never))).rejects.toMatchObject({code:'VEHICLE_REQUEST_SIGNED_TOP_LEVEL'});
 const drift=[
  ['alter table public.vehicle_request_preparations disable trigger vehicle_request_preparations_guard','alter table public.vehicle_request_preparations enable trigger vehicle_request_preparations_guard'],
  ['grant select on public.vehicle_request_preparations to public','revoke select on public.vehicle_request_preparations from public'],
  ['alter table public.vehicle_request_preparations enable row level security','alter table public.vehicle_request_preparations disable row level security'],
  ["alter table public.vehicle_request_preparations alter column recorded_at set default now()",'alter table public.vehicle_request_preparations alter column recorded_at drop default'],
  ['alter function public.shardkeep_divine_fragment_source() security definer','alter function public.shardkeep_divine_fragment_source() security invoker'],
 ];
 for(const [change,restore] of drift){await f.conn.sql.unsafe(change!);try{await expect(service.get(r)).rejects.toThrow();}finally{await f.conn.sql.unsafe(restore!);}expect(await service.get(r)).toEqual(saved);}
 const role='vehicle_request_test_'+randomUUID().replaceAll('-','');
 await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`create role ${role} nologin`);await tx.unsafe(`grant execute on function public.shardkeep_vehicle_request_owner() to ${role}`);await tx.unsafe(`set local role ${role}`);await tx`select public.shardkeep_vehicle_request_owner()`;})).rejects.toThrow('OWNER_ISOLATION');
 expect(await service.get(r)).toEqual(saved);
 // Replica bypass is an explicit owner corruption fixture. Restored origin
 // reads still refuse forged data even when the structural contract is intact.
 await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`update public.vehicle_request_issuance_attempts set policy_authority=${Keypair.generate().publicKey.toBase58()} where reservation_id=${m.id}`;});
 await expect(service.get(r)).rejects.toMatchObject({code:'VEHICLE_REQUEST_BINDING'});
 await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`update public.vehicle_request_issuance_attempts set policy_authority=${x.publicKey} where reservation_id=${m.id}`;});
 expect(await service.get(r)).toEqual(saved);
 const wire=new VersionedTransaction(Message.from(Buffer.from(saved.preparation!.quote.messageHex,'hex')));wire.sign([f.seller.signer]);const bytes=wire.serialize();
 await expect(f.conn.sql`insert into public.vehicle_request_signed_wires(reservation_id,signed_transaction,signature) values(${m.id},${Buffer.from(bytes)},${Buffer.alloc(64)})`).rejects.toThrow('VEHICLE_REQUEST_WIRE');
 const store=createVehicleCraftSignedStore(f.db),receipt=await store.accept(r,bytes);
 await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`update public.vehicle_request_signed_wires set message_sha256=${'00'.repeat(32)} where reservation_id=${m.id}`;});
 await expect(store.get(r)).rejects.toMatchObject({code:'VEHICLE_REQUEST_SIGNED_SOURCE'});
 expect(receipt.broadcastAuthorized).toBe(false);
}),SEAL_BOUND_EARNED_VEHICLE_CASE_MS);
