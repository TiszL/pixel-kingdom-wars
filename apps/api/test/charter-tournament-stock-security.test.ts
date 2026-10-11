import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {eq} from 'drizzle-orm';
import {afterAll,afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ORDINARY_REFINED_IDS} from '@shardkeep/shared/phaseEOrdinaryCrafting';
import {craftingStocks} from '../src/db/schema';
import {fundCharterTournamentEvent,closeCharterTournamentEvent,claimCharterTournamentPrize,readCharterTournamentClaim} from '../src/game/charterTournamentEvents';
import {connectTestDb} from './helpers';
import {createStarterExpeditionFixture} from './fixtures/starterExpeditions';
const conn=connectTestDb(),db=conn.db;afterAll(()=>conn.sql.end());
beforeEach(()=>{vi.stubEnv('PHASE_E_CHARTER_ENABLED','true');vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_BUILDINGS_ENABLED','true');});afterEach(()=>vi.unstubAllEnvs());
const key=()=>Keypair.generate().publicKey.toBase58();
async function fixture(){
 const f=await createStarterExpeditionFixture(db),id=randomUUID(),budget=Object.fromEntries(ORDINARY_REFINED_IDS.map(item=>[item,'7'])) as Record<typeof ORDINARY_REFINED_IDS[number],string>;
 await db.insert(craftingStocks).values(ORDINARY_REFINED_IDS.map(itemId=>({baseId:f.baseId,itemId,available:11n})));
 await fundCharterTournamentEvent(db,f.wallet,{id,baseId:f.baseId,weekStart:'2035-01-06T00:00:00.000Z',budget},f.authority,{domain:{genesisHash:key(),economyProgram:key(),craftProgram:key(),treasury:key()},sponsorWallet:f.wallet,clock:()=>f.now});
 await closeCharterTournamentEvent(db,id,{clock:()=>new Date('2035-01-08T00:00:00.000Z')});return {...f,id};
}
it.each(['delete-reinsert','reassign-base','reassign-item','truncate'] as const)('flushed claim stock witness rejects %s mutation atomically',async mutation=>{
 const f=await fixture(),other=await createStarterExpeditionFixture(db),before=await db.select().from(craftingStocks).where(eq(craftingStocks.baseId,f.baseId));
 await expect(conn.sql.begin(async tx=>{
  await tx`insert into charter_tournament_prize_claims(event_id,wallet,base_id,amounts,stock,claimed_at,tx_key) values(${f.id},${f.wallet},${f.baseId},'{}','[]','2035-01-08T01:00:00Z',pg_current_xact_id()::text)`;
  await tx`set constraints all immediate`;
  if(mutation==='delete-reinsert'){
   await tx`delete from crafting_stocks where base_id=${f.baseId} and item_id='thornsilk'`;
   await tx`insert into crafting_stocks(base_id,item_id,available) values(${f.baseId},'thornsilk',4)`;
  }else if(mutation==='reassign-base')await tx`update crafting_stocks set base_id=${other.baseId} where base_id=${f.baseId} and item_id='thornsilk'`;
  else if(mutation==='reassign-item')await tx`update crafting_stocks set item_id='thornsilk-reassigned' where base_id=${f.baseId} and item_id='thornsilk'`;
  else await tx`truncate crafting_stocks`;
 })).rejects.toThrow('CHARTER_TOURNAMENT_STOCK_CONSERVATION');
 expect(await readCharterTournamentClaim(db,f.wallet,f.id)).toBeNull();
 expect(await db.select().from(craftingStocks).where(eq(craftingStocks.baseId,f.baseId))).toEqual(before);
});
it('later ordinary stock transactions remain valid after funding and claiming',async()=>{
 const f=await fixture();await db.update(craftingStocks).set({available:5n}).where(eq(craftingStocks.baseId,f.baseId));
 await claimCharterTournamentPrize(db,f.wallet,{eventId:f.id,baseId:f.baseId},f.authority,{clock:()=>new Date('2035-01-08T01:00:00Z')});
 expect((await db.select().from(craftingStocks).where(eq(craftingStocks.baseId,f.baseId))).every(row=>row.available===12n)).toBe(true);
 await db.update(craftingStocks).set({available:10n}).where(eq(craftingStocks.baseId,f.baseId));
 expect((await db.select().from(craftingStocks).where(eq(craftingStocks.baseId,f.baseId))).every(row=>row.available===10n)).toBe(true);
});
it('disabling the mutation fence invalidates the attested source',async()=>{
 await expect(conn.sql.begin(async tx=>{
  await tx`alter table crafting_stocks disable trigger crafting_stocks_charter_tournament_guard`;
  await tx`select public.shardkeep_charter_tournament_event_source()`;
 })).rejects.toThrow('CHARTER_TOURNAMENT_SOURCE');
});
