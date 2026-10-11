/** Real owner expiry verification + browser consent custody and atomic adoption. */
import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {SOLANA_GENESIS_HASH} from '../../../packages/chain/src/cluster';
import {withMiningTaxWebFixture} from './fixtures/miningTaxWeb';

it.each(['lost committed reply','unexpired bank'] as const)('continues split setup after %s with the same additional consent and no repeated wallet effect',async mode=>{
 const childKey=randomUUID();
 await withMiningTaxWebFixture(async f=>{
  let client=f.client();await client.controller.begin(f.preparation.round,f.preparation.spot,f.preparation.caps);
  await client.controller.review(0);await client.controller.sign();await client.controller.submit(0);expect(client.controller.snapshot().error).toBeNull();
  await f.settle({key:f.preparation.idempotencyKey,ordinal:0,setupFee:6});await client.controller.open();expect(client.controller.snapshot().error).toBeNull();
  const before=await client.store.read(),caps={maxFeeLamports:'10',maxRentLamports:'1000',maxTotalLamports:'1010'};
  f.chain.control.now=new Date(Date.parse(f.preparation.expiresAt)+1);
  f.chain.control.height=f.preparation.lastValidBlockHeight+(mode==='unexpired bank'?0:1);
  await client.controller.prepareContinuation(caps);expect(client.controller.snapshot().error).not.toBeNull();
  const pending=(await client.store.read()).operation!;expect(pending.continuation).toMatchObject({request:{idempotencyKey:childKey,caps},attempted:true,envelope:null});
  expect(pending.transactions).toEqual(before.operation!.transactions);expect(pending.setup).toEqual(before.operation!.setup);
  const attempted=await f.inspect();expect(attempted.continuationPosts).toBe(1);expect(attempted.signatures).toEqual([0]);
  // Cold controller recovery never repeats the declined or lost POST.
  client=f.client();await client.controller.open();expect(client.controller.snapshot().error).toBeNull();expect((await f.inspect()).continuationPosts).toBe(1);
  if(mode==='unexpired bank'){
   expect(await f.chain.conn.sql`select * from mining_tax_claim_continuations`).toHaveLength(0);
   f.chain.control.height=f.preparation.lastValidBlockHeight+1;
   await client.controller.resumeContinuation();expect(client.controller.snapshot().error).toBeNull();expect((await f.inspect()).continuationPosts).toBe(2);
  }else expect((await client.store.read()).operation!.continuation!.envelope!.status).toBe('continued');
  const counts=await f.inspect(),reads=f.chain.calls.connect;
  await f.restartPaused();client=f.client(false);await client.controller.open();expect(client.controller.snapshot().error).toBeNull();
  await client.controller.activateContinuation();expect(client.controller.snapshot().error).toBeNull();
  const active=(await client.store.read()).operation!;expect(active.request).toEqual({idempotencyKey:childKey,round:f.preparation.round,spot:f.preparation.spot,caps});expect(active.transactions).toEqual([]);expect(active.setup).toBeNull();expect(client.controller.snapshot().review).toBeNull();
  const archived=(await f.client(false).store.archived(f.preparation.idempotencyKey))!.operation!;
  expect(archived.transactions).toEqual(before.operation!.transactions);expect(archived.setup).toEqual(before.operation!.setup);expect(archived.setup!.settlement!.receipt.feeLamports).toBe('6');expect(archived.settlement).toBeNull();expect(archived.failure).toBeUndefined();expect(archived.continuation!.envelope!.continuation!.childPreparation).toEqual(active.preparation);
  expect(await f.inspect()).toEqual(counts);expect(f.chain.calls.connect).toBe(reads);expect(f.sign).toHaveBeenCalledOnce();expect(f.broadcast).not.toHaveBeenCalled();
  expect(await f.chain.conn.sql`select * from mining_tax_claim_continuations`).toHaveLength(1);
 },{mode:'split',genesisHash:SOLANA_GENESIS_HASH.devnet,continuationKey:childKey,loseContinuation:mode==='lost committed reply',loseRelay:true});
},120_000);
