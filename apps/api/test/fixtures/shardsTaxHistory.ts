/** Real source/collect/raid service fixture. Keys and funding are isolated test facts. */
import {randomUUID,randomBytes} from 'node:crypto';
import {Keypair,PublicKey} from '@solana/web3.js';
import bs58 from 'bs58';
import {PHASE_E_POLICY,MINING,getMiningQuota} from '@shardkeep/shared';
import type {Db} from '../../src/db/client';
import {players,bases,baseSlots,buildings,mineAccrualStates,raids,baseRaidLocks,baseForgePositions} from '../../src/db/schema';
import {createTestPlayer} from '../helpers';
import {admitPhysicalMineTaxSources} from '../../src/mining/shardsTaxMineSources';
import {hashExpeditionTermSnapshot} from '../../src/game/expeditionTerms';
import {collectBaseMines,MINE_DAY_MS} from '../../src/game/baseMining';
import {rewardBaseShards} from '../../src/game/baseEconomy';
import {reserveDeedRaidLoot,settleDeedRaidLoot} from '../../src/game/raidLoot';
import {bootstrapSystemAccounts,getOrCreateBaseAccount,getOrCreatePlayerAccount,postTransaction} from '../../src/ledger';
export async function createShardsHistoryFixture(db:Db,options:{legacy?:bigint;zeroWinners?:boolean}={}){
 const start=new Date('2036-01-01T00:00:00.000Z'),key=(n:number)=>new PublicKey(new Uint8Array(32).fill(n)).toBase58();
 // Deed-authority HTTP coverage requires a signable wallet, not arbitrary bytes.
 const wallet=Keypair.generate().publicKey.toBase58();await db.insert(players).values({wallet});
 const player={wallet,keepAccountId:(await getOrCreatePlayerAccount(db,wallet,'player_keep')).id},[base]=await db.insert(bases).values({ownerWallet:player.wallet,status:'active',keepLevel:1}).returning();
 await db.insert(baseSlots).values({wallet:player.wallet,slot:1,baseId:base!.id});
 const [mine]=await db.insert(buildings).values({playerWallet:player.wallet,baseId:base!.id,type:'mine',level:1,tx:1,ty:1}).returning();
 await db.insert(mineAccrualStates).values({mineBuildingId:mine!.id,lastAccrualAt:start,accruedShards:options.legacy??0n});
 const observation={snapshot:{version:1 as const,termId:randomUUID(),startsAt:start.toISOString(),endsAt:new Date(+start+PHASE_E_POLICY.seekerIsland.operatingTermSec*1000).toISOString(),source:{kind:'solana_auction_round' as const,genesisHash:key(201),programId:key(202),auctionConfig:new PublicKey(randomBytes(32)).toBase58(),round:'1'},spots:Array.from({length:PHASE_E_POLICY.seekerIsland.totalSpots},(_,spotId)=>({spotId,ownerWallet:!options.zeroWinners&&spotId<2?player.wallet:null,auctionAccount:key(spotId+1),settlementSignature:bs58.encode(new Uint8Array(64).fill(7)),settlementSlot:String(100+spotId),termsHash:'ab'.repeat(32)}))},finality:{commitment:'finalized' as const,contextSlot:'200',observedAt:start.toISOString()}};
 const context={baseId:base!.id,assertAuthority:async()=>{}},command={idempotencyKey:randomUUID(),baseId:base!.id};
 await admitPhysicalMineTaxSources(db,player.wallet,command,context,{reader:{readOperatingTerm:async()=>observation},clock:()=>start});
 const quota=BigInt(getMiningQuota(1,[1],0,MINING.EPOCH_RATE_BPS)),termId=observation.snapshot.termId,termHash=hashExpeditionTermSnapshot(observation.snapshot);
 return {player,base:base!,mine:mine!,start,quota,termId,termHash,observation,context,command,
  collect:(at=new Date(+start+MINE_DAY_MS))=>collectBaseMines(db,player.wallet,context,at),
  async mixedRaid(){
   const at=new Date(+start+MINE_DAY_MS),attacker=await createTestPlayer(db),[destination]=await db.insert(bases).values({ownerWallet:attacker.wallet,status:'active',keepLevel:1}).returning();
   await rewardBaseShards(db,base!.id,10000n,'test.history.liquid',randomUUID());
   const systems=await bootstrapSystemAccounts(db),forge=await getOrCreateBaseAccount(db,base!.id,'base_forge_escrow');
   await postTransaction(db,{idempotencyKey:randomUUID(),type:'test.history.forge',entries:[{account:systems.shard_genesis,delta:-2000n},{account:forge.id,delta:2000n}]});
   await db.insert(baseForgePositions).values({baseId:base!.id,day:'2036-01-01',contributedShards:2000n,updatedAt:at});
   const [raid]=await db.insert(raids).values({idempotencyKey:randomUUID(),attackerWallet:attacker.wallet,attackerBaseId:destination!.id,defenderWallet:player.wallet,defenderBaseId:base!.id,seed:1n,snapshot:{},armySnapshot:{},simVersion:9,ordersDeadlineAt:new Date(+at+120000)}).returning();
   await db.insert(baseRaidLocks).values({baseId:base!.id,raidId:raid!.id,expiresAt:new Date(+at+180000)});
   await reserveDeedRaidLoot(db,{raidId:raid!.id,attackerBaseId:destination!.id,defenderBaseId:base!.id,now:at});
   const payout=await settleDeedRaidLoot(db,raid!.id,2,[{id:mine!.id,type:'mine',destroyed:true}],at);
   return {raid:raid!,destination:destination!,payout};
  }};
}
