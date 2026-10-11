import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {withDivineFragmentFixture,playFragmentTrial} from './fixtures/divineFragments';
import {createDivineFragments} from '../src/game/divineFragments';
import {createSeekerFragmentClaims} from '../src/game/seekerFragmentClaims';

it('real earned Renown and played occupation produce fixed fragment liabilities, exact delivery and original equal Seeker shares',async()=>withDivineFragmentFixture(async f=>{
 await f.fragments.enroll(f.event.id);expect((await f.fragments.award(f.wallet,f.event.id)).award).toBeNull();
 const terminal=await f.play();expect(terminal.terminal?.occupations).toHaveLength(2);
 const result=await f.settle();expect(result.record).toMatchObject({occupiedSites:2,gross:'28',net:'24',tax:'4',unissuedIndividual:'6972',unissuedGlobal:'9972'});
 expect(result.awards.map(a=>[a.gross,a.net,a.tax,a.carryBefore,a.carryAfter])).toEqual([['14','12','2','0','8000'],['14','12','2','0','8000']]);
 const before=await f.sql`select * from crafting_stocks order by base_id,item_id`;
 const cmd={idempotencyKey:randomUUID(),baseId:f.baseId},delivery=await f.fragments.deliver(f.wallet,f.event.id,cmd);
 expect(delivery).toMatchObject({quantity:'12',stockBefore:'0',stockAfter:'12'});expect(await f.fragments.deliver(f.wallet,f.event.id,cmd)).toEqual(delivery);
 const terms=await f.seeker.terms(f.wallet);expect(terms.rows).toHaveLength(1);expect(terms.rows[0]).toMatchObject({winnerCount:2,poolTotal:'4',previousTotal:'0',cumulativeTotal:'2',claimable:'2'});
 const claim=await f.seeker.claim(f.wallet,{idempotencyKey:randomUUID(),baseId:f.baseId,termId:terms.rows[0]!.termId,spotId:0});expect(claim).toMatchObject({quantity:'2',stockBefore:'12',stockAfter:'14'});
 expect((await f.fragments.stock(f.wallet,f.baseId)).available).toBe('14');expect((await f.seeker.terms(f.wallet)).rows[0]?.claimable).toBe('0');
 expect(await f.sql`select * from crafting_stocks order by base_id,item_id`).toEqual(before);
 const sponsorPrize=await f.client.claim(f.wallet,f.event.id,{baseId:f.baseId});expect(Object.values(sponsorPrize.amounts)).toEqual(Array(8).fill('4'));
 expect((await f.fragments.awards(f.wallet)).rows[0]).toEqual({award:result.awards.find(a=>a.wallet===f.wallet),delivery});
}),120000);

it('paused original delivery and claim recover after destination transfer without changing base-owned stock or consulting term/deed providers',async()=>withDivineFragmentFixture(async f=>{
 await f.fragments.enroll(f.event.id);await f.play();const original=await f.settle();const termId=original.term!.snapshot.termId;
 const cmd={idempotencyKey:randomUUID(),baseId:f.buyerBaseId},claimCmd={...cmd,idempotencyKey:randomUUID(),termId,spotId:1};
 const delivery=await f.fragments.deliver(f.buyer,f.event.id,cmd),claim=await f.seeker.claim(f.buyer,claimCmd);
 const recovered=createDivineFragments(f.db,{...f.options,termSource:null,finalizedDeedReader:null}),claims=createSeekerFragmentClaims(f.db,{...f.options,finalizedDeedReader:null});
 f.setOnline(false);f.setDeedOnline(false);for(const flag of ['PHASE_E_CATALOG_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_MINING_ENABLED','PHASE_E_SEEKER_ENABLED'])process.env[flag]='false';
 await f.sql.begin(async tx=>{await tx`update bases set owner_wallet=${f.wallet},status='inactive' where id=${f.buyerBaseId}`;await tx`update base_slots set active=false where base_id=${f.buyerBaseId}`;});
 expect(await recovered.deliver(f.buyer,f.event.id,cmd)).toEqual(delivery);expect(await claims.claim(f.buyer,claimCmd)).toEqual(claim);
 expect((await recovered.deliveryRead(f.buyer,cmd.idempotencyKey)).receipt).toEqual(delivery);expect((await claims.claimRead(f.buyer,claimCmd.idempotencyKey)).receipt).toEqual(claim);
 expect((await recovered.award(f.buyer,f.event.id)).delivery).toEqual(delivery);expect((await recovered.settle(f.event.id)).awards).toEqual(original.awards);
 expect((await recovered.deliveryRead(f.wallet,cmd.idempotencyKey)).receipt).toBeNull();expect((await claims.claimRead(f.wallet,claimCmd.idempotencyKey)).receipt).toBeNull();
 await expect(recovered.deliver(f.buyer,f.event.id,{...cmd,baseId:f.baseId})).rejects.toMatchObject({code:'DIVINE_FRAGMENT_IDEMPOTENCY_BODY_MISMATCH'});
 expect((await f.sql`select available::text from crystal_fragment_stocks where base_id=${f.buyerBaseId}`)[0]?.available).toBe('14');
}),120000);

it('later periods wait for earlier enrolled periods; carry follows wallets and original spots retain distinct period entitlements',async()=>withDivineFragmentFixture(async f=>{
 await f.fragments.enroll(f.event.id);
 const later=await f.client.fund(f.wallet,{id:randomUUID(),baseId:f.baseId,weekStart:'2020-01-11T00:00:00.000Z',budget:Object.fromEntries(Object.keys(f.budget).map(k=>[k,'1']))});await f.fragments.enroll(later.id);
 await f.play();await playFragmentTrial(f,later);
 await expect(f.settle(later.id,'2020-01-14T00:00:00.000Z')).rejects.toMatchObject({cause:{message:'DIVINE_FRAGMENT_ORDER'}});
 expect(await f.sql`select * from divine_fragment_awards`).toHaveLength(0);
 const first=await f.settle(f.event.id,'2020-01-14T00:00:00.000Z'),termId=first.term!.snapshot.termId;
 const a=await f.seeker.claim(f.wallet,{idempotencyKey:randomUUID(),baseId:f.baseId,termId,spotId:0});expect(a.quantity).toBe('2');
 const second=await f.settle(later.id,'2020-01-14T00:00:00.000Z');expect(second.awards.every(a=>a.carryBefore==='8000'&&a.net==='11'&&a.tax==='3'&&a.carryAfter==='6000')).toBe(true);
 await expect(f.seeker.claim(f.wallet,{idempotencyKey:randomUUID(),baseId:f.baseId,termId,spotId:0})).rejects.toThrow();
 const b=await f.seeker.claim(f.wallet,{idempotencyKey:randomUUID(),baseId:f.baseId,termId:second.term!.snapshot.termId,spotId:0});expect(b).toMatchObject({poolTotal:'6',previousTotal:'0',cumulativeTotal:'3',quantity:'3'});
 expect((await f.fragments.stock(f.wallet,f.baseId)).available).toBe('5');
}),120000);

it('true zero winners hold all original tax without reallocation and player delivery still conserves',async()=>withDivineFragmentFixture(async f=>{
 await f.fragments.enroll(f.event.id);await f.play();const result=await f.settle();expect(result.awards.every(a=>a.winnerCount===0&&a.poolDisposition==='held_zero_winners')).toBe(true);
 expect((await f.seeker.terms(f.wallet)).rows).toEqual([]);await expect(f.seeker.claim(f.wallet,{idempotencyKey:randomUUID(),baseId:f.baseId,termId:result.term!.snapshot.termId,spotId:0})).rejects.toMatchObject({code:'DIVINE_FRAGMENT_SPOT_OWNER'});
 expect((await f.fragments.deliver(f.wallet,f.event.id,{idempotencyKey:randomUUID(),baseId:f.baseId})).quantity).toBe('12');
 expect((await f.sql`select sum((record->>'tax')::bigint)::text total from divine_fragment_awards`)[0]?.total).toBe('4');
},0),120000);

it('a full original hundred-spot term retains division dust and creates no zero-value claim or developer diversion',async()=>withDivineFragmentFixture(async f=>{
 await f.fragments.enroll(f.event.id);await f.play();const result=await f.settle();expect(result.awards.every(a=>a.winnerCount===100)).toBe(true);
 const page=await f.seeker.terms(f.wallet);expect(page.rows).toHaveLength(50);expect(page.rows.every(r=>r.poolTotal==='4'&&r.claimable==='0')).toBe(true);
 expect(page.rows.some(r=>r.spotId===0)).toBe(true);expect(page.rows.some(r=>r.spotId===98)).toBe(true);
 await expect(f.seeker.claim(f.wallet,{idempotencyKey:randomUUID(),baseId:f.baseId,termId:result.term!.snapshot.termId,spotId:0})).rejects.toThrow();expect(await f.sql`select * from seeker_fragment_claims`).toHaveLength(0);expect(await f.sql`select * from crystal_fragment_stocks`).toHaveLength(0);
},100),120000);

it('source settlement preserves a beneficiary liability with no active base and first paused delivery chooses a fresh owned destination',async()=>withDivineFragmentFixture(async f=>{
 await f.fragments.enroll(f.event.id);await f.play();
 await f.sql.begin(async tx=>{await tx`update bases set status='inactive' where id=${f.baseId}`;await tx`update base_slots set active=false where base_id=${f.baseId}`;});
 await f.settle();expect((await f.fragments.award(f.wallet,f.event.id)).award?.net).toBe('12');
 const baseId=randomUUID();await f.sql`insert into bases(id,owner_wallet) values(${baseId},${f.wallet})`;await f.sql`insert into base_slots(wallet,slot,base_id) values(${f.wallet},2,${baseId})`;
 const paused=createDivineFragments(f.db,{...f.options,termSource:null});for(const key of ['PHASE_E_CATALOG_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_MINING_ENABLED','PHASE_E_SEEKER_ENABLED'])process.env[key]='false';
 await expect(paused.deliver(f.wallet,f.event.id,{idempotencyKey:randomUUID(),baseId:f.baseId})).rejects.toMatchObject({code:'DIVINE_FRAGMENT_BASE_NOT_OWNED'});
 expect((await paused.deliver(f.wallet,f.event.id,{idempotencyKey:randomUUID(),baseId})).stockAfter).toBe('12');expect((await paused.stock(f.wallet,baseId)).available).toBe('12');
}),120000);
