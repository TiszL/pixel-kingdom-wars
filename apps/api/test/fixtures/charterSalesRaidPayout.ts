/** Reuses B6p's accepted settlement boundary: real admitted raid, terminal,
 * tithe ledger and attribution with explicit synthetic gross, not combat proof.
 * Production submitOrders/K232 remains untouched. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import type {Db} from '../../src/db/client';
import {clans} from '../../src/db/schema';
import {resolveOriginalClanRaidChest,assertOriginalClanRaidChestPosting} from '../../src/game/clanCharterRaidChest';
import {rewardShards} from '../../src/game/spend';
import {bootstrapSystemAccounts,getOrCreatePlayerAccount,postTransaction} from '../../src/ledger';

export async function settleCharterSaleFixtureGross(db:Db,raidId:string,gross:bigint){
 const [original]=await db.execute<{defender_wallet:string}>(sql`select defender_wallet from raids where id=${raidId}`);
 if(!original||gross<=0n)throw Error('Expected actual admitted raid and positive fixture gross');
 await rewardShards(db,original.defender_wallet,gross,'test.charter-sale.gross',randomUUID());
 return db.transaction(async tx=>{
  const [r]=await tx.execute<{attacker_wallet:string;defender_wallet:string;status:string}>(sql`select attacker_wallet,defender_wallet,status from raids where id=${raidId} for update`);
  if(!r||r.status!=='pending_orders')throw Error('Expected unsettled actual raid');
  await tx.execute(sql`update raids set status='resolving' where id=${raidId}`);
  const sys=await bootstrapSystemAccounts(tx),attacker=await getOrCreatePlayerAccount(tx,r.attacker_wallet,'player_shards'),defender=await getOrCreatePlayerAccount(tx,r.defender_wallet,'player_shards');
  await tx.execute(sql`select id from accounts where id in(${attacker.id},${defender.id},${sys.clan_chest}) order by id for update`);
  const route=await resolveOriginalClanRaidChest(tx,raidId,r.attacker_wallet,gross);
  if(route.chestCut<=0n||route.clanId===null)throw Error('Fixture must exercise positive captured clan tithe');
  const posted=await postTransaction(tx,{idempotencyKey:`raid:${raidId}:loot`,type:'raid.loot',
   entries:[{account:defender.id,delta:-gross},{account:attacker.id,delta:gross-route.chestCut},{account:sys.clan_chest,delta:route.chestCut}],
   metadata:{raidId,attacker:r.attacker_wallet,defender:r.defender_wallet,clanChest:String(route.chestCut)}});
  if(posted.duplicate)throw Error('Fixture gross must be posted once');
  const changed=await tx.update(clans).set({chestShards:sql`${clans.chestShards}+${route.chestCut}`}).where(eq(clans.id,route.clanId)).returning({id:clans.id});
  if(changed.length!==1)throw Error('Fixture lost original clan');
  await assertOriginalClanRaidChestPosting(tx,raidId,posted.transaction.id);
  await tx.execute(sql`update raids set status='resolved',resolved_at=now(),result=jsonb_build_object('lootShards',${String(gross-route.chestCut)}::numeric) where id=${raidId}`);
  return {...route,ledgerId:posted.transaction.id};
 },{isolationLevel:'read committed'});
}
