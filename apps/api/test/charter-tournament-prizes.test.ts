import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ORDINARY_REFINED_IDS} from '@shardkeep/shared/phaseEOrdinaryCrafting';
import {CHARTER_TOURNAMENT_POLICY} from '@shardkeep/shared/charterTournament';
import {RAW_RESOURCE_STORAGE_MAX} from '@shardkeep/shared/phaseEResources';
import {craftingStocks} from '../src/db/schema';
import {fundCharterTournamentEvent,closeCharterTournamentEvent,claimCharterTournamentPrize,readCharterTournamentClaim,readCharterTournamentEvent} from '../src/game/charterTournamentEvents';
import {connectTestDb,createTestPlayer} from './helpers';
import {createStarterExpeditionFixture} from './fixtures/starterExpeditions';
const conn=connectTestDb(),db=conn.db;afterAll(()=>conn.sql.end());
beforeEach(()=>{vi.stubEnv('PHASE_E_CHARTER_ENABLED','true');vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_BUILDINGS_ENABLED','true');});afterEach(()=>vi.unstubAllEnvs());
const claimClock={clock:()=>new Date('2035-02-09T00:00:00.000Z')};
const key=()=>Keypair.generate().publicKey.toBase58();
async function fixture(){const f=await createStarterExpeditionFixture(db);const budget=Object.fromEntries(ORDINARY_REFINED_IDS.map(i=>[i,'7'])) as Record<typeof ORDINARY_REFINED_IDS[number],string>;await db.insert(craftingStocks).values(ORDINARY_REFINED_IDS.map(itemId=>({baseId:f.baseId,itemId,available:11n})));const cmd={id:randomUUID(),baseId:f.baseId,weekStart:'2035-01-06T00:00:00.000Z',budget},options={domain:{genesisHash:key(),economyProgram:key(),craftProgram:key(),treasury:key()},sponsorWallet:f.wallet,clock:()=>f.now};await fundCharterTournamentEvent(db,f.wallet,cmd,f.authority,options);return {...f,budget,cmd,options};}
it('an empty funded event closes with no manufactured occupancy and refunds every original unit once',async()=>{const f=await fixture();const state=await closeCharterTournamentEvent(db,f.cmd.id,{clock:()=>new Date('2035-01-08T00:00:00.000Z')});expect(state.terminal).toMatchObject({rankings:[],occupations:[],entitlements:[{wallet:f.wallet,amounts:f.budget}]});vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');const claim=await claimCharterTournamentPrize(db,f.wallet,{eventId:f.cmd.id,baseId:f.baseId},f.authority,claimClock);expect(claim.amounts).toEqual(f.budget);expect(await claimCharterTournamentPrize(db,f.wallet,{eventId:f.cmd.id,baseId:f.baseId},{baseId:f.baseId,assertAuthority:async()=>{throw new Error('provider unavailable');}},claimClock)).toEqual(claim);expect(await readCharterTournamentClaim(db,f.wallet,f.cmd.id)).toEqual(claim);expect((await db.select().from(craftingStocks).where(eq(craftingStocks.baseId,f.baseId))).every(s=>s.available===11n)).toBe(true);expect((await readCharterTournamentEvent(db,f.cmd.id)).terminal).toEqual(state.terminal);});
it('full destination storage holds all eight rights without a partial claim or credit',async()=>{const f=await fixture();await closeCharterTournamentEvent(db,f.cmd.id,{clock:()=>new Date('2035-01-08T00:00:00.000Z')});await db.update(craftingStocks).set({available:RAW_RESOURCE_STORAGE_MAX}).where(and(eq(craftingStocks.baseId,f.baseId),eq(craftingStocks.itemId,'thornsilk')));await expect(claimCharterTournamentPrize(db,f.wallet,{eventId:f.cmd.id,baseId:f.baseId},f.authority,claimClock)).rejects.toThrow();expect(await readCharterTournamentClaim(db,f.wallet,f.cmd.id)).toBeNull();expect((await db.select().from(craftingStocks).where(eq(craftingStocks.baseId,f.baseId))).filter(s=>s.itemId!=='thornsilk').every(s=>s.available===4n)).toBe(true);await db.update(craftingStocks).set({available:4n}).where(and(eq(craftingStocks.baseId,f.baseId),eq(craftingStocks.itemId,'thornsilk')));expect((await claimCharterTournamentPrize(db,f.wallet,{eventId:f.cmd.id,baseId:f.baseId},f.authority,claimClock)).amounts).toEqual(f.budget);});
it('late closure keeps the original occupation deadline and does not transfer sponsor rights to another wallet',async()=>{const f=await fixture();const state=await closeCharterTournamentEvent(db,f.cmd.id,{clock:()=>new Date('2035-02-08T00:00:00.000Z')});expect(state.occupationEndsAt).toBe('2035-01-15T00:00:00.000Z');const stranger=await createStarterExpeditionFixture(db,{wallet:(await createTestPlayer(db)).wallet});await expect(claimCharterTournamentPrize(db,stranger.wallet,{eventId:f.cmd.id,baseId:stranger.baseId},stranger.authority,claimClock)).rejects.toThrow();expect(await readCharterTournamentClaim(db,stranger.wallet,f.cmd.id)).toBeNull();expect(await readCharterTournamentClaim(db,f.wallet,f.cmd.id)).toBeNull();});
it('same-transaction stock restoration cannot retain a funded event with a fictitious debit',async()=>{const f=await createStarterExpeditionFixture(db),budget=Object.fromEntries(ORDINARY_REFINED_IDS.map(i=>[i,'1']));await db.insert(craftingStocks).values(ORDINARY_REFINED_IDS.map(itemId=>({baseId:f.baseId,itemId,available:1n})));const id=randomUUID(),domain={genesisHash:key(),economyProgram:key(),craftProgram:key(),treasury:key()};await expect(db.transaction(async tx=>{await tx.execute(sql`INSERT INTO public.charter_tournament_events(id,domain,week_start,sponsor_wallet,policy,budget,funding,funded_at,tx_key) VALUES(${id}::uuid,${JSON.stringify(domain)}::jsonb,'2035-01-06T00:00:00Z',${f.wallet},${JSON.stringify(CHARTER_TOURNAMENT_POLICY)}::jsonb,${JSON.stringify(budget)}::jsonb,${JSON.stringify({baseId:f.baseId})}::jsonb,'2035-01-01T00:00:00Z',pg_current_xact_id()::text)`);await tx.update(craftingStocks).set({available:1n}).where(eq(craftingStocks.baseId,f.baseId));})).rejects.toThrow();expect(await db.execute(sql`SELECT id FROM public.charter_tournament_events WHERE id=${id}::uuid`)).toHaveLength(0);});

it('conflict-ignore cannot turn a duplicate original claim into an extra credit',async()=>{const f=await fixture();await closeCharterTournamentEvent(db,f.cmd.id,{clock:()=>new Date('2035-01-08T00:00:00Z')});await claimCharterTournamentPrize(db,f.wallet,{eventId:f.cmd.id,baseId:f.baseId},f.authority,claimClock);const before=await db.select().from(craftingStocks).where(eq(craftingStocks.baseId,f.baseId));await expect(db.execute(sql`INSERT INTO public.charter_tournament_prize_claims(event_id,wallet,base_id,amounts,stock,claimed_at,tx_key) VALUES(${f.cmd.id}::uuid,${f.wallet},${f.baseId}::uuid,'{}','[]','2035-02-09T00:00:00Z',pg_current_xact_id()::text) ON CONFLICT DO NOTHING`)).rejects.toThrow();expect(await db.select().from(craftingStocks).where(eq(craftingStocks.baseId,f.baseId))).toEqual(before);});
it('claim chronology cannot precede its canonical fixed obligation',async()=>{const f=await fixture();await closeCharterTournamentEvent(db,f.cmd.id,{clock:()=>new Date('2035-01-08T00:00:00Z')});await expect(claimCharterTournamentPrize(db,f.wallet,{eventId:f.cmd.id,baseId:f.baseId},f.authority,{clock:()=>new Date('2035-01-07T23:59:59Z')})).rejects.toThrow();expect(await readCharterTournamentClaim(db,f.wallet,f.cmd.id)).toBeNull();});

it.each(['before','after'] as const)('early-flush %s funding insertion cannot restore its immutable stock debit',async timing=>{
 const f=await createStarterExpeditionFixture(db),budget=Object.fromEntries(ORDINARY_REFINED_IDS.map(item=>[item,'1']));
 await db.insert(craftingStocks).values(ORDINARY_REFINED_IDS.map(itemId=>({baseId:f.baseId,itemId,available:1n})));
 const id=randomUUID(),domain={genesisHash:key(),economyProgram:key(),craftProgram:key(),treasury:key()};
 await expect(db.transaction(async tx=>{
  if(timing==='before')await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  await tx.execute(sql`INSERT INTO public.charter_tournament_events(id,domain,week_start,sponsor_wallet,policy,budget,funding,funded_at,tx_key) VALUES(${id}::uuid,${JSON.stringify(domain)}::jsonb,'2035-01-06T00:00:00Z',${f.wallet},${JSON.stringify(CHARTER_TOURNAMENT_POLICY)}::jsonb,${JSON.stringify(budget)}::jsonb,${JSON.stringify({baseId:f.baseId})}::jsonb,'2035-01-01T00:00:00Z',pg_current_xact_id()::text)`);
  if(timing==='after')await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  await tx.update(craftingStocks).set({available:1n}).where(eq(craftingStocks.baseId,f.baseId));
 })).rejects.toThrow();
 expect(await db.execute(sql`SELECT id FROM public.charter_tournament_events WHERE id=${id}::uuid`)).toHaveLength(0);
 expect((await db.select().from(craftingStocks).where(eq(craftingStocks.baseId,f.baseId))).every(s=>s.available===1n)).toBe(true);
});

it.each(['before','after'] as const)('early-flush %s claim insertion cannot erase its immutable stock credit',async timing=>{
 const f=await fixture();await closeCharterTournamentEvent(db,f.cmd.id,{clock:()=>new Date('2035-01-08T00:00:00Z')});
 await expect(db.transaction(async tx=>{
  if(timing==='before')await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  await tx.execute(sql`INSERT INTO public.charter_tournament_prize_claims(event_id,wallet,base_id,amounts,stock,claimed_at,tx_key) VALUES(${f.cmd.id}::uuid,${f.wallet},${f.baseId}::uuid,'{}','[]','2035-02-09T00:00:00Z',pg_current_xact_id()::text)`);
  if(timing==='after')await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  await tx.update(craftingStocks).set({available:4n}).where(eq(craftingStocks.baseId,f.baseId));
 })).rejects.toThrow();
 expect(await readCharterTournamentClaim(db,f.wallet,f.cmd.id)).toBeNull();
 expect((await db.select().from(craftingStocks).where(eq(craftingStocks.baseId,f.baseId))).every(s=>s.available===4n)).toBe(true);
});
