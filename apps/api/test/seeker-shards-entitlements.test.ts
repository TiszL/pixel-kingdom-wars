/** Read-only original rights remain discoverable without a currently owned base. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {beforeAll,afterAll,afterEach,it,expect,vi} from 'vitest';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createShardsHistoryFixture} from './fixtures/shardsTaxHistory';
import {claimSeekerShardsTax} from '../src/mining/seekerShardsClaims';
import {readSeekerShardsEntitlements} from '../src/mining/seekerShardsEntitlements';
import {bases,baseSlots} from '../src/db/schema';
import {createTestPlayer} from './helpers';
const conn=resourceClaimsDatabase(),db=conn.db;
beforeAll(()=>conn.setup());
afterAll(()=>conn.close());afterEach(()=>vi.unstubAllEnvs());
async function fixture(){vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');const f=await createShardsHistoryFixture(db);await f.collect();return f;}
it('discovers exact original spot shares and subtracts only committed cumulative payouts',async()=>{const f=await fixture();const first=await readSeekerShardsEntitlements(db,f.player.wallet,{});expect(first).toMatchObject({status:'available',currency:'SHARDS',claimsEnabled:false});expect(first.rows.map(r=>r.spotId)).toEqual([0,1]);expect(first.rows[0]!.dueQuantity).toBe(first.rows[1]!.dueQuantity);await claimSeekerShardsTax(db,f.player.wallet,{idempotencyKey:randomUUID(),baseId:f.base.id,termId:f.termId,spotId:0},f.context,{assertAdmission(){}});const later=await readSeekerShardsEntitlements(db,f.player.wallet,{});expect(later.rows[0]!.dueQuantity).toBe('0');expect(later.rows[1]!.dueQuantity).toBe(first.rows[1]!.dueQuantity);expect(later.rows[0]!.poolTotal).toBe(first.rows[0]!.poolTotal);});
it('discovers prior-term rights while paused after the base is sold without disclosing them to its buyer',async()=>{const f=await fixture(),before=await readSeekerShardsEntitlements(db,f.player.wallet,{}),buyer=await createTestPlayer(db);await db.delete(baseSlots).where(eq(baseSlots.baseId,f.base.id));await db.update(bases).set({ownerWallet:buyer.wallet,status:'inactive'}).where(eq(bases.id,f.base.id));vi.stubEnv('PHASE_E_MINING_ENABLED','false');vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');expect(await readSeekerShardsEntitlements(db,f.player.wallet,{})).toEqual(before);expect((await readSeekerShardsEntitlements(db,buyer.wallet,{})).rows).toEqual([]);});
it('returns unavailable with no amounts or continuation for contradictory source evidence',async()=>{const f=await fixture();await conn.sql`alter table shards_tax_assessments disable trigger user`;try{await conn.sql`update shards_tax_assessments set receipt=jsonb_set(receipt,'{source,key}','"forged"') where term_id=${f.termId}`;expect(await readSeekerShardsEntitlements(db,f.player.wallet,{})).toMatchObject({status:'unavailable',reason:'SOURCE_INTEGRITY',rows:[],nextCursor:null});}finally{await conn.sql`alter table shards_tax_assessments enable trigger user`;}});
it('binds the bounded UUID page cursor and refuses amount/owner query authority',async()=>{const f=await fixture();const end=await readSeekerShardsEntitlements(db,f.player.wallet,{cursor:'ffffffff-ffff-4fff-bfff-ffffffffffff'});expect(end.rows).toEqual([]);expect(end.nextCursor).toBeNull();await expect(readSeekerShardsEntitlements(db,f.player.wallet,{wallet:f.player.wallet})).rejects.toThrow();await expect(readSeekerShardsEntitlements(db,f.player.wallet,{cursor:'not-a-key'})).rejects.toThrow();});
