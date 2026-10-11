/** Recovered earnings fund the existing original-spot claim path exactly once;
 * payout is an escrow transfer, not another source of production or tax. */
import {randomUUID} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {afterEach,expect,it,vi} from 'vitest';
import {PHASE_E_HARVESTER} from '@shardkeep/shared';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createHistoricalMineResolutionFixture,mineResolutionFixtureTimes} from './fixtures/historicalMineResolution';
import {createTestPlayer} from './helpers';
import {bases,baseSlots} from '../src/db/schema';
import {reanchorBaseMineAccrual,collectBaseMines} from '../src/game/baseMining';
import {claimSeekerShardsTax,readSeekerShardsClaim} from '../src/mining/seekerShardsClaims';
import {readCompleteShardsTaxPool} from '../src/mining/shardsTaxHistory';
let conn:ReturnType<typeof resourceClaimsDatabase>|undefined;
afterEach(async()=>{vi.unstubAllEnvs();vi.useRealTimers();await conn?.close();conn=undefined;});
it('delivers late recovered tax to actual original winning spots, retains dust and replays paused without minting or retaxing',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(mineResolutionFixtureTimes.verified);
 vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');
 const db=conn=resourceClaimsDatabase();await db.setup();const winner=await createTestPlayer(db.db);
 const [destination]=await db.db.insert(bases).values({ownerWallet:winner.wallet,status:'active',keepLevel:1}).returning();
 await db.db.insert(baseSlots).values({wallet:winner.wallet,baseId:destination!.id,slot:1});
 const wallet=new PublicKey(winner.wallet),fixture=await createHistoricalMineResolutionFixture(db,{round1Winners:[{spotId:0,wallet},{spotId:1,wallet}]}),f=await fixture.createResolvedSource();
 await db.db.transaction(tx=>reanchorBaseMineAccrual(tx,f.base.id,fixture.verified));
 const parents=await db.sql`select id from shards_mine_segments where mine_id=${f.mine.id} and wallet=${f.wallet} and admission_id is null and recovery_parent_id is null and buffer>0`;
 expect(parents).toHaveLength(1);await fixture.resolve(parents[0]!.id);
 const tax=(BigInt(fixture.quota)-4n)*BigInt(PHASE_E_HARVESTER.v1.islandPoolBps)/BigInt(PHASE_E_HARVESTER.v1.taxBasisPoints);
 const collected=await collectBaseMines(db.db,f.wallet,{baseId:f.base.id,assertAuthority:async()=>{}},fixture.verified);
 expect(collected.amount).toBe(BigInt(fixture.quota)-tax);
 const term=f.resolution.children[1]!;expect(term.certificate.snapshot.spots.filter(s=>s.ownerWallet!==null)).toHaveLength(2);
 expect(term.certificate.snapshot.spots.slice(0,2).map(s=>s.ownerWallet)).toEqual([winner.wallet,winner.wallet]);
 expect(await readCompleteShardsTaxPool(db.db,term.termId,term.termHash)).toBe(tax);
 const balance=async(kind:string,baseId?:string)=>BigInt((baseId?await db.sql`select balance::text from accounts where kind=${kind} and base_id=${baseId}`:await db.sql`select balance::text from accounts where kind=${kind} and owner_wallet is null and base_id is null`)[0]?.balance??'0');
 const genesis=await balance('shard_genesis'),assessments=await db.sql`select to_jsonb(a) value from shards_tax_assessments a order by wallet_sequence`;
 const command=(spotId:number)=>({idempotencyKey:randomUUID(),baseId:destination!.id,termId:term.termId,spotId});
 const authority={baseId:destination!.id,assertAuthority:async()=>{}},admission={assertAdmission(){}};
 await expect(claimSeekerShardsTax(db.db,f.wallet,{...command(0),baseId:f.base.id},{baseId:f.base.id,assertAuthority:async()=>{}},admission)).rejects.toMatchObject({code:'SEEKER_SHARDS_NOT_OWNER'});
 const request=command(0),first=await claimSeekerShardsTax(db.db,winner.wallet,request,authority,admission),second=await claimSeekerShardsTax(db.db,winner.wallet,command(1),authority,admission);
 expect(first).toMatchObject({termId:term.termId,termHash:term.termHash,winnerCount:2,poolTotal:tax.toString(),quantity:(tax/2n).toString()});
 expect(second.quantity).toBe(first.quantity);expect(await balance('base_shards',destination!.id)).toBe(tax/2n*2n);
 expect(await balance('shards_tax_escrow')).toBe(tax%2n);expect(await balance('shard_genesis')).toBe(genesis);
 expect(await db.sql`select to_jsonb(a) value from shards_tax_assessments a order by wallet_sequence`).toEqual(assessments);
 await expect(claimSeekerShardsTax(db.db,winner.wallet,command(0),authority,admission)).rejects.toMatchObject({code:'SEEKER_SHARDS_NOTHING_DUE'});
 vi.stubEnv('PHASE_E_MINING_ENABLED','false');vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');const reopened=db.reopen();
 try{expect(await claimSeekerShardsTax(reopened.db,winner.wallet,request,authority)).toEqual(first);expect(await readSeekerShardsClaim(reopened.db,winner.wallet,first.id)).toEqual(first);}
 finally{await reopened.sql.end();}
 expect(await balance('shard_genesis')).toBe(genesis);expect(await readCompleteShardsTaxPool(db.db,term.termId,term.termHash)).toBe(tax);
},120000);
