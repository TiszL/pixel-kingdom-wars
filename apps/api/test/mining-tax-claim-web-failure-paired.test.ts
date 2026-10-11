/** Real private API, owner failure verifier, browser custody and atomic history. */
import {expect,it} from 'vitest';
import {SOLANA_GENESIS_HASH} from '../../../packages/chain/src/cluster';
import {withMiningTaxWebFixture} from './fixtures/miningTaxWeb';

it.each(['combined','split'] as const)('recovers %s failed tax history while paused, then archives all exact outcomes without repeating effects',mode=>withMiningTaxWebFixture(async f=>{
 let client=f.client();await client.controller.begin(f.preparation.round,f.preparation.spot,f.preparation.caps);
 await client.controller.review(0);await client.controller.sign();await client.controller.submit(0);expect(client.controller.snapshot().error).toContain('lost submit reply');
 if(mode==='split'){
  await f.settle({key:f.preparation.idempotencyKey,ordinal:0,setupFee:6});await client.controller.open();expect(client.controller.snapshot().error).toBeNull();
  expect((await client.store.read()).operation!.setup!.settlement!.receipt.feeLamports).toBe('6');
  await client.controller.archiveFailed();expect((await client.store.read()).operation).not.toBeNull();
  await client.controller.review(1);await client.controller.sign();await client.controller.submit(1);expect(client.controller.snapshot().error).toBeNull();
 }
 const ordinal=mode==='split'?1:0;
 // Historical fee can exceed the signing quote/cap without proving a refund.
 await f.fail({key:f.preparation.idempotencyKey,ordinal,fee:20});
 const before=await client.store.read(),counts=await f.inspect(),admissionCalls=f.chain.calls.connect;
 await f.restartPaused();client=f.client(false);await client.controller.open();expect(client.controller.snapshot().error).toBeNull();
 const failed=(await client.store.read()).operation!;
 expect(failed.failure!.failures[0]!.receipt).toMatchObject({feeLamports:'20',paidKeepBaseUnits:'0',rentLamports:'0',journalClearingAuthorized:false});
 expect(failed.transactions).toEqual(before.operation!.transactions);expect(failed.settlement).toBeNull();
 if(mode==='split')expect(failed.setup!.settlement!.receipt.feeLamports).toBe('6');
 await client.controller.archiveFailed();expect(client.controller.snapshot().error).toBeNull();expect((await client.store.read()).operation).toBeNull();
 const history=(await f.client(false).store.archived(f.preparation.idempotencyKey))!.operation!;
 expect(history.failure).toEqual(failed.failure);expect(history.setup).toEqual(failed.setup);expect(history.transactions).toEqual(failed.transactions);
 expect(await f.inspect()).toEqual(counts);expect(f.chain.calls.connect).toBe(admissionCalls);expect(f.broadcast).not.toHaveBeenCalled();
}, {mode,genesisHash:SOLANA_GENESIS_HASH.devnet,loseSubmit:true,loseRelay:true}),120_000);
