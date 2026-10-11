import {randomUUID,randomBytes} from 'node:crypto';
import {Keypair,PublicKey} from '@solana/web3.js';
import bs58 from 'bs58';
import {afterAll,afterEach,expect,it,vi} from 'vitest';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {bases,baseSlots,buildings,mineAccrualStates,raids,baseRaidLocks} from '../src/db/schema';
import {connectTestDb,createTestPlayer} from './helpers';
import {admitPhysicalMineTaxSources} from '../src/mining/shardsTaxMineSources';
import {collectBaseMines} from '../src/game/baseMining';
import {reserveDeedRaidLoot,releaseDeedRaidLoot,settleDeedRaidLoot,getSettledDeedRaidLoot} from '../src/game/raidLoot';
const conn=connectTestDb(),db=conn.db,at=new Date('2036-01-01T00:00:00.000Z');
afterAll(()=>conn.sql.end());afterEach(()=>vi.unstubAllEnvs());
async function fixture(gross:bigint){
 vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','false');
 const player=await createTestPlayer(db),attacker=await createTestPlayer(db);
 const [base]=await db.insert(bases).values({ownerWallet:player.wallet,status:'active',keepLevel:1}).returning();
 const [destination]=await db.insert(bases).values({ownerWallet:attacker.wallet,status:'active',keepLevel:1}).returning();
 await db.insert(baseSlots).values({wallet:player.wallet,slot:1,baseId:base!.id});
 const [mine]=await db.insert(buildings).values({playerWallet:player.wallet,baseId:base!.id,type:'mine',level:1,tx:1,ty:1}).returning();
 await db.insert(mineAccrualStates).values({mineBuildingId:mine!.id,lastAccrualAt:at,accruedShards:gross});
 const [raid]=await db.insert(raids).values({idempotencyKey:randomUUID(),attackerWallet:attacker.wallet,attackerBaseId:destination!.id,defenderWallet:player.wallet,defenderBaseId:base!.id,seed:1n,snapshot:{},armySnapshot:{},simVersion:9,ordersDeadlineAt:new Date(+at+120000)}).returning();
 await db.insert(baseRaidLocks).values({baseId:base!.id,raidId:raid!.id,expiresAt:new Date(+at+180000)});
 await reserveDeedRaidLoot(db,{raidId:raid!.id,attackerBaseId:destination!.id,defenderBaseId:base!.id,now:at});
 const key=(n:number)=>new PublicKey(new Uint8Array(32).fill(n)).toBase58(),snapshot={version:1 as const,termId:randomUUID(),startsAt:at.toISOString(),endsAt:new Date(+at+PHASE_E_POLICY.seekerIsland.operatingTermSec*1000).toISOString(),source:{kind:'solana_auction_round' as const,genesisHash:key(201),programId:key(202),auctionConfig:Keypair.generate().publicKey.toBase58(),round:'1'},spots:Array.from({length:PHASE_E_POLICY.seekerIsland.totalSpots},(_,spotId)=>({spotId,ownerWallet:spotId===0?player.wallet:null,auctionAccount:new PublicKey(randomBytes(32)).toBase58(),settlementSignature:bs58.encode(new Uint8Array(64).fill(7)),settlementSlot:String(100+spotId),termsHash:'ab'.repeat(32)}))};
 const observation={snapshot,finality:{commitment:'finalized' as const,contextSlot:'200',observedAt:at.toISOString()}},context={baseId:base!.id,assertAuthority:async()=>{}},request={idempotencyKey:randomUUID(),baseId:base!.id};
 vi.stubEnv('PHASE_E_MINING_ENABLED','true');
 const admit=()=>admitPhysicalMineTaxSources(db,player.wallet,request,context,{reader:{readOperatingTerm:async()=>observation},clock:()=>new Date(at)});
 return {player,base:base!,destination:destination!,mine:mine!,raid:raid!,context,admit};
}
it.each(['restore','award'] as const)('holds source admission until a pre-era raid finishes %s, preserving the old output untaxed',async mode=>{
 const f=await fixture(7n);await expect(f.admit()).rejects.toMatchObject({code:'BASE_BEING_RAIDED'});
 expect(await conn.sql`select * from shards_mine_eras where mine_id=${f.mine.id}`).toHaveLength(0);
 expect(await conn.sql`select * from shards_mine_segments where mine_id=${f.mine.id}`).toHaveLength(0);
 if(mode==='restore')await releaseDeedRaidLoot(db,f.raid.id,at);
 else expect((await settleDeedRaidLoot(db,f.raid.id,1,[{id:f.mine.id,type:'mine',destroyed:true}],at)).mines).toBe(7n);
 // The same timestamp does not imply concurrent eligibility: terminal state and
 // its exact base lock, rather than wall-clock ordering, protect the boundary.
 const admission=await f.admit();expect(await f.admit()).toEqual(admission);
 expect(await conn.sql`select * from shards_mine_raid_eras where raid_id=${f.raid.id}`).toHaveLength(0);
 if(mode==='restore'){
  const [saved]=await conn.sql`select * from shards_mine_segments where mine_id=${f.mine.id}`;expect(saved).toMatchObject({wallet:null,admission_id:null});expect(BigInt(saved!.gross)).toBe(7n);
  expect((await collectBaseMines(db,f.player.wallet,f.context,at)).amount).toBe(7n);expect((await collectBaseMines(db,f.player.wallet,f.context,at)).amount).toBe(0n);
  const [after]=await conn.sql`select * from shards_mine_segments where mine_id=${f.mine.id}`;expect(BigInt(after!.issued)).toBe(7n);expect(BigInt(after!.buffer)+BigInt(after!.reserved)+BigInt(after!.discarded)).toBe(0n);
 }else{
  await expect(settleDeedRaidLoot(db,f.raid.id,1,[{id:f.mine.id,type:'mine',destroyed:true}],at)).rejects.toThrow('already settled');
  expect((await getSettledDeedRaidLoot(db,f.raid.id))!.mines).toBe(7n);
  expect(await conn.sql`select * from shards_mine_segments where mine_id=${f.mine.id}`).toHaveLength(0);
 }
 expect(await conn.sql`select * from shards_tax_assessments where wallet=${f.player.wallet}`).toHaveLength(0);
});
it('keeps zero-quantity raid custody fenced until terminal release without creating source stock',async()=>{
 const f=await fixture(0n);await expect(f.admit()).rejects.toMatchObject({code:'BASE_BEING_RAIDED'});await releaseDeedRaidLoot(db,f.raid.id,at);await f.admit();expect(await conn.sql`select * from shards_mine_segments where mine_id=${f.mine.id}`).toHaveLength(0);expect((await collectBaseMines(db,f.player.wallet,f.context,at)).amount).toBe(0n);
});
