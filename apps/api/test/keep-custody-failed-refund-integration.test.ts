/** Actual worker/refund/retirement composition. Network finality is synthetic;
 * no raw failed-state update or operator marker manufactures refund authority. */
import { randomUUID } from 'node:crypto';
import { GEMS } from '@shardkeep/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { spendGems } from '../src/game/spend';
import { refundFailedWithdrawal, reconcileProcessingWithdrawals } from '../src/money/withdrawals';
import { makeTestKeepSender, FINALITY_PENDING } from './withdrawalSender';
import { custodyWithdrawalDrainFixture, DRAIN_GROSS, leaf,
 type CustodyWithdrawalDrainFixture } from './fixtures/custodyWithdrawalDrain';
let f:CustodyWithdrawalDrainFixture|undefined;
beforeEach(async()=>{
 vi.stubEnv('MULTI_BASE_ENABLED','false');vi.stubEnv('WITHDRAWALS_ENABLED','true');vi.stubEnv('PAYOUT_COVERAGE_OVERRIDE','false');
 f=await custodyWithdrawalDrainFixture();
},60_000);
afterEach(async()=>{try{await f?.dispose();}finally{f=undefined;vi.restoreAllMocks();vi.unstubAllEnvs();}});
const failureSender=()=>makeTestKeepSender({reconcile:async()=>({status:'finalized_error',source:'fixture-finalized-bank',error:'InstructionError: transfer failed'})});
async function failed(){
 const c=f!;expect(await c.worker(failureSender())).toMatchObject({sent:0,failed:1});
 const [w]=await c.sql`select status,tx_signature,last_error from withdrawals where id=${c.first.withdrawal.id}`;
 const [a]=await c.sql`select status,tx_signature,signed_transaction from withdrawal_attempts where withdrawal_id=${c.first.withdrawal.id}`;
 expect(w).toMatchObject({status:'failed',tx_signature:expect.any(String),last_error:expect.stringMatching(/^FINALIZED ERROR —/)});
 expect(a).toMatchObject({status:'finalized_error',tx_signature:w!.tx_signature});expect(a!.signed_transaction.length).toBeGreaterThan(0);
 expect(await c.sql`select status from withdrawal_payout_reservations where withdrawal_id=${c.first.withdrawal.id}`).toEqual([{status:'released'}]);
 return a!;
}
async function finish(companion:Awaited<ReturnType<CustodyWithdrawalDrainFixture['actor']>>){
 const c=f!,request=c.request([companion.withdrawal.id]),drain=await c.apply(request);
 expect(drain.cancelled.map(r=>r.withdrawalId)).toEqual([companion.withdrawal.id]);expect(drain.totalKeepReturned).toBe(DRAIN_GROSS.toString());
 expect(await c.balance('withdrawal_escrow')).toBe(0n);expect(await c.phase()).toBe('withdrawals_closed');
 const retirement=await c.retire();expect(retirement).toMatchObject({measuredG8:true,totalKeepConverted:(DRAIN_GROSS*2n).toString(),retirementAuthorized:false});
 for(const actor of c.actors){expect(await c.balance('player_keep',actor.wallet)).toBe(0n);expect(await c.balance('player_gems',actor.wallet)).toBe(DRAIN_GROSS*BigInt(GEMS.gemsPerKeep));}
 expect(await c.balance('burn')).toBe(0n);expect(await c.balance('onchain_outflow')).toBe(0n);
 expect(await c.sql`select id from ledger_transactions where type='withdrawal.refund'`).toHaveLength(1);
 expect(await c.sql`select id from ledger_transactions where type='withdrawal.cancel'`).toHaveLength(1);
 expect(await c.sql`select id from ledger_transactions where type='withdrawal.payout'`).toHaveLength(0);
 await spendGems(c.db,c.first.wallet,1n,'fixture.failed-refund.gems-spend',randomUUID());
 const snapshot=await c.snapshot();expect(await c.apply(request)).toEqual(drain);expect(await c.snapshot()).toBe(snapshot);
 await expect(refundFailedWithdrawal(c.db,c.first.withdrawal.id,{wallet:c.first.wallet})).rejects.toMatchObject({statusCode:422});
 expect(await c.snapshot()).toBe(snapshot);
}

it('returns actual finalized-failure gross before F and retires it once with the remaining unbonding drain',async()=>{
 const c=f!,attempt=await failed(),companion=await c.actor(),requestGraph=await c.requestGraph();await c.fence();
 const refund=await refundFailedWithdrawal(c.db,c.first.withdrawal.id,{wallet:c.first.wallet});
 expect(refund).toMatchObject({status:'refunded',amount:DRAIN_GROSS,refundLedgerTxnId:expect.any(String),txSignature:attempt.tx_signature});
 const legs=await c.receipt(refund.refundLedgerTxnId!);
 expect(legs.map(r=>[r.kind,r.currency,r.owner_wallet,r.base_id,r.delta])).toEqual([
  ['player_keep','KEEP',c.first.wallet,null,DRAIN_GROSS.toString()],['withdrawal_escrow','KEEP',null,null,(-DRAIN_GROSS).toString()],
 ]);
 expect(legs.every(r=>r.type==='withdrawal.refund'&&r.idempotency_key===`withdrawal:${refund.id}:refund`)).toBe(true);
 expect(await c.requestGraph()).toBe(requestGraph);await finish(companion);
});

it('keeps expired null-history exposure held until the same signed attempt gains positive finalized failure',async()=>{
 const c=f!,broadcast=vi.fn(async()=>{throw Error('fixture reply lost after broadcast');});
 const sender=makeTestKeepSender({broadcast,reconcile:async()=>FINALITY_PENDING});
 expect(await c.worker(sender)).toMatchObject({sent:0,failed:0,held:1});
 const companion=await c.actor();await c.fence();
 const [saved]=await c.sql`select id,tx_signature,signed_transaction from withdrawal_attempts where withdrawal_id=${c.first.withdrawal.id}`;
 expect(broadcast).toHaveBeenCalledTimes(1);
 await reconcileProcessingWithdrawals(c.db,makeTestKeepSender({reconcile:async()=>({status:'expired_unresolved',sources:['fixture-pruned-a','fixture-pruned-b']})}));
 const held=await c.snapshot();
 await expect(refundFailedWithdrawal(c.db,c.first.withdrawal.id,{wallet:c.first.wallet})).rejects.toMatchObject({statusCode:422});
 await expect(c.apply(c.request([companion.withdrawal.id])).catch(leaf)).resolves.toMatchObject({message:'CUSTODY_WITHDRAWAL_SCOPE_CONFLICT'});
 expect(await c.snapshot()).toBe(held);expect(await c.phase()).toBe('fenced');expect(await c.balance('withdrawal_escrow')).toBe(DRAIN_GROSS*2n);
 expect(await reconcileProcessingWithdrawals(c.db,failureSender())).toEqual({sent:0,failed:1,processing:0});
 expect(await c.sql`select id,tx_signature,signed_transaction from withdrawal_attempts where withdrawal_id=${c.first.withdrawal.id}`).toEqual([saved]);
 await refundFailedWithdrawal(c.db,c.first.withdrawal.id,{wallet:c.first.wallet});await finish(companion);
});

it('refuses a foreign refund and pays exactly once under concurrent refund requests before retirement',async()=>{
 const c=f!;await failed();const companion=await c.actor();await c.fence();const before=await c.snapshot();
 await expect(refundFailedWithdrawal(c.db,c.first.withdrawal.id,{wallet:companion.wallet})).rejects.toMatchObject({statusCode:404});
 expect(await c.snapshot()).toBe(before);
 const outcomes=await Promise.allSettled([refundFailedWithdrawal(c.db,c.first.withdrawal.id,{wallet:c.first.wallet}),refundFailedWithdrawal(c.db,c.first.withdrawal.id,{wallet:c.first.wallet})]);
 expect(outcomes.filter(v=>v.status==='fulfilled')).toHaveLength(1);
 expect(outcomes.filter(v=>v.status==='rejected')).toEqual([expect.objectContaining({reason:expect.objectContaining({statusCode:422})})]);
 expect(await c.balance('player_keep',c.first.wallet)).toBe(DRAIN_GROSS);await finish(companion);
});

it('rolls back actual refund posting on deferred COMMIT failure and preserves the original attempt for retry',async()=>{
 const c=f!;await failed();const companion=await c.actor();await c.fence();
 await c.sql.unsafe(`create sequence fixture_refund_commit_reached;
  create function fixture_refund_commit_fail() returns trigger language plpgsql as $$begin
   if new.status::text='refunded' and new.refund_ledger_txn_id is not null then
    if not exists(select 1 from ledger_entries where txn_id=new.refund_ledger_txn_id) then raise exception 'FIXTURE_REFUND_POST_NOT_REACHED';end if;
    perform nextval('fixture_refund_commit_reached');raise exception 'FIXTURE_REFUND_COMMIT';
   end if;return null;end$$;
  create constraint trigger zz_fixture_refund_commit after update on withdrawals deferrable initially deferred
   for each row execute function fixture_refund_commit_fail()`);
 const before=await c.snapshot();
 await expect(refundFailedWithdrawal(c.db,c.first.withdrawal.id,{wallet:c.first.wallet}).catch(leaf)).resolves.toMatchObject({message:'FIXTURE_REFUND_COMMIT'});
 expect(await c.sql`select is_called,last_value::text from fixture_refund_commit_reached`).toEqual([{is_called:true,last_value:'1'}]);expect(await c.snapshot()).toBe(before);
 await c.sql.unsafe('drop trigger zz_fixture_refund_commit on withdrawals;drop function fixture_refund_commit_fail();drop sequence fixture_refund_commit_reached');
 await refundFailedWithdrawal(c.db,c.first.withdrawal.id,{wallet:c.first.wallet});await finish(companion);
});
