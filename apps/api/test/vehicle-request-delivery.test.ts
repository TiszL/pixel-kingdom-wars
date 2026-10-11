import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {expect,it,vi} from 'vitest';
import {createVehicleIssuanceRequestReceiptReader} from '@shardkeep/chain/vehicle-issuance-request-receipt';
import {vehicleIssuanceRequestReceiptFixture} from '../../../packages/chain/src/testFixtures/vehicleIssuanceRequestReceipt';
import {createVehicleCraftDelivery} from '../src/game/vehicleCraftDelivery';
import {createVehicleCraftMaterials} from '../src/game/vehicleCraftMaterials';
import {withVehicleCraftClientFixture} from './fixtures/vehicleCraftClient';
import {resealVehicleDeliveryFixture,prepareVehicleDeliveryFixture} from './fixtures/vehicleCraftDelivery';
import {SEAL_BOUND_EARNED_VEHICLE_CASE_MS} from './sealLatencyBudgets';
const signal=()=>new AbortController().signal;
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}

it('commits one dispatch before exact send, never resends wrong acknowledgements or crash markers, and seals SQL custody',()=>withVehicleCraftClientFixture(async f=>{
 await resealVehicleDeliveryFixture(f.conn);const x=await prepareVehicleDeliveryFixture(f),off=createVehicleCraftDelivery(f.db);
 expect((await off.get(x.request)).status).toBe('held');expect((await off.deliver(x.request,signal())).status).toBe('held');
 await expect(off.get({...x.request,wire:'replacement'} as typeof x.request)).rejects.toThrow();await expect(off.get({...x.request,wallet:Keypair.generate().publicKey.toBase58()})).rejects.toThrow();
 let enabled=false;const delivery=createVehicleCraftDelivery(f.db,{enabled:()=>enabled,current:{connect:()=>x.rpc,trust:x.bank.trust}});
 expect((await delivery.deliver(x.request,signal())).reason).toBe('DISABLED');expect(x.status).not.toHaveBeenCalled();enabled=true;
 x.bank.controls.networkFee++;expect((await delivery.deliver(x.request,signal())).status).toBe('held');expect(await f.conn.sql`select reservation_id from vehicle_request_dispatches`).toHaveLength(0);x.bank.controls.networkFee--;
 x.send.mockImplementation(async(bytes,options)=>{
  expect(Buffer.from(bytes)).toEqual(Buffer.from(x.bytes));expect(options).toMatchObject({skipPreflight:false,preflightCommitment:'finalized',maxRetries:0});
  expect(await f.conn.sql`select reservation_id from vehicle_request_dispatches where reservation_id=${x.material.id}`).toHaveLength(1);
  await f.db.transaction(async tx=>{await tx.execute(sql`select id from vehicle_craft_material_reservations where id=${x.material.id}::uuid for update nowait`);});return x.wire.signature;
 });
 const pair=await Promise.all([delivery.deliver(x.request,signal()),delivery.deliver(x.request,signal())]);expect(pair.some(r=>r.status==='submitted')).toBe(true);expect(x.send).toHaveBeenCalledTimes(1);
 const acknowledged=await off.get(x.request);expect(acknowledged.status).toBe('submitted');expect(acknowledged.broadcastAuthorized).toBe(false);
 expect(await f.conn.sql`select reservation_id from vehicle_request_dispatches`).toHaveLength(1);expect(await f.conn.sql`select reservation_id from vehicle_request_dispatch_acknowledgements`).toHaveLength(1);
 const y=await prepareVehicleDeliveryFixture(f);y.send.mockResolvedValue('wrong acknowledgement');const uncertain=createVehicleCraftDelivery(f.db,{enabled:()=>true,current:{connect:()=>y.rpc,trust:y.bank.trust}});
 expect((await uncertain.deliver(y.request,signal())).status).toBe('unknown');expect((await uncertain.deliver(y.request,signal())).status).toBe('unknown');expect(y.send).toHaveBeenCalledTimes(1);
 await expect(f.conn.sql`insert into vehicle_request_dispatch_acknowledgements(reservation_id,signature) values(${y.material.id},${Buffer.alloc(64)})`).rejects.toThrow('ACKNOWLEDGEMENT');
 const z=await prepareVehicleDeliveryFixture(f);
 await expect(f.conn.sql`insert into vehicle_request_dispatches(reservation_id,actor_wallet) values(${z.material.id},${x.request.wallet})`).rejects.toThrow('DISPATCH');
 await f.conn.sql`insert into vehicle_request_dispatches(reservation_id) values(${z.material.id})`;
 const crashed=createVehicleCraftDelivery(f.db,{enabled:()=>true,current:{connect:()=>z.rpc,trust:z.bank.trust}});expect((await crashed.deliver(z.request,signal())).status).toBe('unknown');expect(z.send).not.toHaveBeenCalled();expect(z.status).not.toHaveBeenCalled();
 expect((await createVehicleCraftMaterials(f.db).read(x.request.wallet,x.request.idempotencyKey))?.status).toBe('held');
 await expect(f.conn.sql`update vehicle_request_dispatches set wire_sha256=wire_sha256`).rejects.toThrow('IMMUTABLE');await expect(f.conn.sql`delete from vehicle_request_dispatch_acknowledgements`).rejects.toThrow('IMMUTABLE');await expect(f.conn.sql`truncate vehicle_request_delivery_receipts`).rejects.toThrow('IMMUTABLE');
 await expect(f.conn.sql`update vehicle_request_delivery_contract set record=record`).rejects.toThrow('SEAL_IMMUTABLE');
 await expect(f.conn.sql.begin(async tx=>{await tx`set transaction isolation level repeatable read`;await tx`select public.shardkeep_vehicle_delivery_source()`;})).rejects.toThrow('OWNER_ISOLATION');
 await expect(f.db.transaction(async tx=>createVehicleCraftDelivery(tx as never))).rejects.toMatchObject({code:'VEHICLE_DELIVERY_TOP_LEVEL'});
 const drift=[['alter table vehicle_request_dispatches disable trigger vehicle_request_dispatches_guard','alter table vehicle_request_dispatches enable trigger vehicle_request_dispatches_guard'],['grant select on vehicle_request_dispatches to public','revoke select on vehicle_request_dispatches from public'],['alter table vehicle_request_dispatches enable row level security','alter table vehicle_request_dispatches disable row level security'],['alter table vehicle_request_dispatches alter column recorded_at set default now()','alter table vehicle_request_dispatches alter column recorded_at drop default'],['alter function shardkeep_vehicle_request_source() security definer','alter function shardkeep_vehicle_request_source() security invoker']];
 for(const [mutate,restore] of drift){await f.conn.sql.unsafe(mutate!);try{await expect(off.get(x.request)).rejects.toThrow();}finally{await f.conn.sql.unsafe(restore!);}expect(await off.get(x.request)).toEqual(acknowledged);}
 const role='vehicle_delivery_test_'+randomUUID().replaceAll('-','');await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`create role ${role} nologin`);await tx.unsafe(`grant execute on function shardkeep_vehicle_delivery_owner() to ${role}`);await tx.unsafe(`set local role ${role}`);await tx`select shardkeep_vehicle_delivery_owner()`;})).rejects.toThrow('OWNER_ISOLATION');
 await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`update vehicle_request_dispatches set message_sha256=${'00'.repeat(32)} where reservation_id=${x.material.id}`;});await expect(off.get(x.request)).rejects.toMatchObject({code:'VEHICLE_DELIVERY_BINDING'});
 await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`update vehicle_request_dispatches set message_sha256=${x.wire.messageSha256} where reservation_id=${x.material.id}`;});expect(await off.get(x.request)).toEqual(acknowledged);
 await expect(resealVehicleDeliveryFixture(f.conn)).rejects.toThrow('empty disposable');
}),SEAL_BOUND_EARNED_VEHICLE_CASE_MS);

it('holds an abort-ignoring actual send and recovers the committed original without rebroadcast',()=>withVehicleCraftClientFixture(async f=>{
 await resealVehicleDeliveryFixture(f.conn);const x=await prepareVehicleDeliveryFixture(f),entered=deferred<void>(),drain=deferred<void>(),abort=new AbortController();
 x.send.mockImplementation(async()=>{entered.resolve();await drain.promise;return x.wire.signature;});
 const delivery=createVehicleCraftDelivery(f.db,{enabled:()=>true,current:{connect:()=>x.rpc,trust:x.bank.trust}}),pending=delivery.deliver(x.request,abort.signal);
 await Promise.race([entered.promise,pending.then(()=>{throw Error('send was not reached');})]);abort.abort();const result=await pending;
 expect(result.status).toBe('unknown');expect(result.dispatch).not.toBeNull();expect(result.acknowledgement).toBeNull();expect(x.send).toHaveBeenCalledTimes(1);
 const reopened=createVehicleCraftDelivery(f.db,{enabled:()=>true,current:{connect:()=>{throw Error('recovery must not construct current transport');},trust:x.bank.trust}});
 expect((await reopened.deliver(x.request,signal())).status).toBe('unknown');expect(x.send).toHaveBeenCalledTimes(1);drain.resolve();await new Promise(resolve=>setImmediate(resolve));
 expect((await reopened.get(x.request)).acknowledgement).toBeNull();expect((await createVehicleCraftMaterials(f.db).read(x.request.wallet,x.request.idempotencyKey))?.status).toBe('held');
}),SEAL_BOUND_EARNED_VEHICLE_CASE_MS);

it('recovers observed original success and exact revert without dispatch, preserves offline proof and never consumes materials',()=>withVehicleCraftClientFixture(async f=>{
 await resealVehicleDeliveryFixture(f.conn);const x=await prepareVehicleDeliveryFixture(f),history=vehicleIssuanceRequestReceiptFixture(x.saved,x.request);history.spendOracle(1n);
 history.control.missing=true;const reading=createVehicleCraftDelivery(f.db,{receipt:{connect:()=>history.rpc,trust:history.trust}});
 expect((await reading.recover(x.request,signal())).reason).toBe('PROOF_UNAVAILABLE');expect(await f.conn.sql`select reservation_id from vehicle_request_delivery_receipts`).toHaveLength(0);
 history.control.missing=false;const sourceProof=await createVehicleIssuanceRequestReceiptReader(()=>history.rpc,history.trust,async()=>x.saved)(x.request,signal());expect(sourceProof).toMatchObject({outcome:'request_succeeded',oracleSpendLamports:'1'});
 const rollback=Error('explicit receipt rollback');await expect(f.db.transaction(async tx=>{await tx.execute(sql`insert into vehicle_request_delivery_receipts(reservation_id,record) values(${x.material.id}::uuid,${JSON.stringify(sourceProof)}::jsonb)`);throw rollback;})).rejects.toBe(rollback);expect(await f.conn.sql`select reservation_id from vehicle_request_delivery_receipts`).toHaveLength(0);
 x.status.mockResolvedValue({context:{slot:history.control.slot},value:[{slot:history.tx.slot,confirmationStatus:'confirmed',err:null}]});
 const observed=createVehicleCraftDelivery(f.db,{enabled:()=>true,current:{connect:()=>x.rpc,trust:x.bank.trust},receipt:{connect:()=>history.rpc,trust:history.trust}});
 const [success,replayed]=await Promise.all([observed.deliver(x.request,signal()),reading.recover(x.request,signal())]);expect(success.status).toBe('finalized');expect(replayed).toEqual(success);expect(success.dispatch).toBeNull();expect(x.send).not.toHaveBeenCalled();expect(success.receipt?.proof.outcome).toBe('request_succeeded');expect(success.receipt?.proof.oracleSpendLamports).toBe('1');
 expect(await f.conn.sql`select reservation_id from vehicle_request_delivery_receipts`).toHaveLength(1);expect((await createVehicleCraftMaterials(f.db).read(x.request.wallet,x.request.idempotencyKey))?.status).toBe('held');
 const offline=createVehicleCraftDelivery(f.db);expect(await offline.get(x.request)).toEqual(success);expect(await offline.deliver(x.request,signal())).toEqual(success);expect(await offline.recover(x.request,signal())).toEqual(success);
 const y=await prepareVehicleDeliveryFixture(f),failure=vehicleIssuanceRequestReceiptFixture(y.saved,y.request);failure.revert();
 const reverted=await createVehicleCraftDelivery(f.db,{receipt:{connect:()=>failure.rpc,trust:failure.trust}}).recover(y.request,signal());expect(reverted.status).toBe('reverted');expect(reverted.receipt?.proof.outcome).toBe('wire_reverted');expect(reverted.receipt?.proof.oracleSpendLamports).toBeNull();expect(reverted.reservationReleaseAuthorized).toBe(false);expect((await createVehicleCraftMaterials(f.db).read(y.request.wallet,y.request.idempotencyKey))?.status).toBe('held');
 history.control.missing=true;history.tx.meta.err={InstructionError:[1,{Custom:6000}]};expect(await reading.recover(x.request,signal())).toEqual(success);
 const z=await prepareVehicleDeliveryFixture(f);await expect(f.conn.sql`insert into vehicle_request_delivery_receipts(reservation_id,record) values(${z.material.id},${JSON.stringify(success.receipt!.proof)}::jsonb)`).rejects.toThrow('RECEIPT');
 await expect(f.conn.sql`insert into vehicle_request_dispatches(reservation_id) values(${x.material.id})`).rejects.toThrow('DISPATCH');
 await expect(f.conn.sql`update vehicle_request_delivery_receipts set record=record`).rejects.toThrow('IMMUTABLE');await expect(f.conn.sql`delete from vehicle_request_delivery_receipts`).rejects.toThrow('IMMUTABLE');
 await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`update vehicle_request_delivery_receipts set record=jsonb_set(record,'{idempotencyKey}',${JSON.stringify(randomUUID())}::jsonb) where reservation_id=${x.material.id}`;});await expect(offline.get(x.request)).rejects.toMatchObject({code:'VEHICLE_DELIVERY_BINDING'});
 await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`update vehicle_request_delivery_receipts set record=${JSON.stringify(success.receipt!.proof)}::jsonb where reservation_id=${x.material.id}`;});expect(await offline.get(x.request)).toEqual(success);
}),SEAL_BOUND_EARNED_VEHICLE_CASE_MS);
