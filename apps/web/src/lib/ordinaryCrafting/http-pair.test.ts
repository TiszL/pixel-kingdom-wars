/** Actual local earned source/API captures; facilities/deed history are declared
 * fixtures. No stock or money is granted by replaying these browser receipts. */
import {IDBFactory} from 'fake-indexeddb';
import {expect,it,vi} from 'vitest';
import {OrdinaryCraftingViewSchema,OrdinaryCraftingEnvelopeSchema} from '@shardkeep/shared/ordinaryCraftingApi';
import {KeepEquipmentPurchaseSchema,KeepEquipmentStockViewSchema} from '@shardkeep/shared/keepEquipmentMarketApi';
import {OrdinaryCraftingJournalStore,parseOrdinaryCraftingCommand} from './journal';
import {OrdinaryCraftingController,type OrdinaryCraftingPorts} from './controller';
import earned from './test-fixtures/earned-kits.json';
import market from './test-fixtures/earned-kit-market.json';

it('real earned catalogue preserves legacy nine, two kit ingredients and exact finalized market delivery',()=>{
 const view=OrdinaryCraftingViewSchema.parse(earned.view),old=OrdinaryCraftingViewSchema.parse(earned.legacy);
 expect(view.recipes).toHaveLength(11);expect(old.recipes).toHaveLength(9);expect(old).not.toHaveProperty('shardsAvailable');
 expect(view.recipes.find(r=>r.recipeId==='craft_expedition_kit')!.inputs).toContainEqual({kind:'shards',itemId:'shards',quantity:'25'});
 expect(KeepEquipmentStockViewSchema.parse(market.buyerStock)).toMatchObject({catalogueVersion:4});
 expect(KeepEquipmentStockViewSchema.parse(market.sellerStock).items).toHaveLength(14);
 expect(KeepEquipmentPurchaseSchema.parse(market.delivered)).toMatchObject({status:'delivered',delivery:{itemId:'expedition_kit',quantity:'1'}});
});
it.each([...earned.receipts,market.legacyRecipe])('cold original recovery uses real accepted API bytes without current authority: $idempotencyKey',async raw=>{
 const proof=OrdinaryCraftingEnvelopeSchema.parse(raw);if(proof.status!=='accepted')throw Error('Expected actual accepted source');
 const command=parseOrdinaryCraftingCommand({request:proof.receipt.request,recipe:proof.receipt.recipe});
 const identity={origin:'https://kits.example',api:'https://kits.example/api',cluster:'devnet' as const,wallet:proof.wallet},factory=new IDBFactory();
 const store=new OrdinaryCraftingJournalStore(identity,factory);
 const saved=await store.compareAndSet(0,old=>({...old,operation:{command,attemptRevision:null,proof:null,refusal:null}}));
 await store.compareAndSet(saved.revision,old=>({...old,operation:{...old.operation!,attemptRevision:old.revision+1}}));await store.close();
 const reopened=new OrdinaryCraftingJournalStore(identity,factory);
 const ports:OrdinaryCraftingPorts={get:vi.fn(async()=>{throw Error('No current source');}),post:vi.fn(async()=>{throw Error('No POST permitted');}),
  getProof:vi.fn(async(request,guard,retain)=>{expect(request).toEqual(command.request);guard();await retain(proof);return proof;}),
  capture:baseId=>()=>{if(baseId)throw Error('Current base unavailable');},lock:async(_key,run)=>run(),key:()=>proof.idempotencyKey};
 const controller=new OrdinaryCraftingController(reopened,ports);await controller.open();
 expect(controller.snapshot().error).toBeNull();expect((await reopened.read()).operation?.proof).toEqual(proof);
 expect(ports.get).not.toHaveBeenCalled();expect(ports.post).not.toHaveBeenCalled();await reopened.close();
});
