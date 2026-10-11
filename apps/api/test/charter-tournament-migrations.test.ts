/** Retained budgets, entry identities and schema witnesses survive exact replay;
 * a migration rerun must never reseal a weakened source as trusted. */
import {readFile} from 'node:fs/promises';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readCharterTournamentEvent} from '../src/game/charterTournamentEvents';
import {charterTournamentWorkflowFixture,type CharterTournamentWorkflowFixture} from './fixtures/charterTournamentWorkflow';
let f:CharterTournamentWorkflowFixture|undefined;
beforeEach(async()=>{f=await charterTournamentWorkflowFixture();},120000);
afterEach(async()=>{const prior=f;f=undefined;try{await prior?.dispose();}finally{vi.restoreAllMocks();vi.unstubAllEnvs();}},120000);
const migrations=[['0234_charter_tournament_events.sql','charter_tournament_events'],['0235_charter_tournament_source.sql','charter_tournament_operations'],['0236_charter_tournament_raids.sql','charter_tournament_raid_requests']] as const;
async function statements(name:string){return (await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8')).split('--> statement-breakpoint').filter(v=>v.trim());}
it('reapplies the exact three migrations without replacing a funded budget, original entry or source contract',async()=>{
 const c=f!,entry=(await c.entry()).state,before=await readCharterTournamentEvent(c.db,c.event.id),stock=await c.sql`select * from crafting_stocks order by base_id,item_id`;
 await c.sql.begin(async tx=>{for(const [name] of migrations)for(const statement of await statements(name))await tx.unsafe(statement);});
 expect(await c.tournamentStore.readEntry(c.source.wallet,entry.id)).toEqual(entry);expect(await readCharterTournamentEvent(c.db,c.event.id)).toEqual(before);expect(await c.sql`select * from crafting_stocks order by base_id,item_id`).toEqual(stock);
},120000);
for(const [name,table] of migrations)it(`refuses to reseal a weakened ${table} before replaying its migration`,async()=>{
 const c=f!,entry=(await c.entry()).state,source=await statements(name);
 await expect(c.sql.begin(async tx=>{await tx.unsafe(`alter table public.${table} alter column tx_key drop not null`);for(const statement of source)await tx.unsafe(statement);})).rejects.toThrow();
 expect(await c.tournamentStore.readEntry(c.source.wallet,entry.id)).toEqual(entry);
},120000);
