/** Fourteen actual source days, finalized roots and cumulative token/renown claims.
 * The separate D149 experiment is the gross oracle, not production allocation. */
import { describe,it,expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { PHASE_E_MINING_SCORE_POLICY as SCORE,PHASE_E_POLICY as POLICY,KEEP_MINING_FLOOR } from '@shardkeep/shared';
import { settleWalletMining,type MiningWallet } from '../../../scripts/src/phase-e-wallet-mining-model';
import { withFundedMiningReplayFixture as fixture } from './fixtures/fundedMiningReplay';
import { executeFundedMiningClaim } from './fixtures/fundedMiningClaims';
import { createMiningClaimEntitlementReader } from '../src/mining/claimEntitlement';
import type { FundedMiningCapture } from '../src/mining/fundedMiningQualification';
import { getPreparedMiningPublication } from '../src/mining/publicationPreparation';
function independent(c:FundedMiningCapture):MiningWallet {
 const today=c.activity.qualifiedRaids.filter(r=>r.day===c.day),hours=Math.floor((Date.parse(c.day)+86400000-Date.parse(c.activity.latestQualifiedAt!))/3600000);
 return {id:c.wallet,controller:c.wallet,seeker:false,ownsAnyDeed:!c.qualification.sources.deeds.deedlessThroughout,developmentEligible:true,freshActivity:today.length>0,
  activityBps:c.activity.latestDayActivityBps,experienceBps:c.activity.experienceBps,usefulChainBps:0,hoursSinceScoreRefresh:hours,
  bases:c.bases.map(b=>{let total=0,parts=0;for(const kind of ['keep','workshop','goldforge'] as const){const level=b.development.completed[kind][0]?.level??0,weight=SCORE.developmentWeights[kind];
    total+=Math.floor(Math.min(level,SCORE.fullLevel[kind])*POLICY.basisPoints/SCORE.fullLevel[kind])*weight;parts+=weight;}
   const source=c.qualification.sources.registeredRoster.open.bases.find(r=>r.id===b.baseId)!;
   return {id:b.baseId,hasDeed:source.land_paid_at!==null,genesis:false,ownedEntireDay:source.deed_asset_id===null||c.qualification.sources.deeds.continuouslyHeldAssetIds.includes(source.deed_asset_id),
    forgeReady:b.development.completed.goldforge.length>0,progressBps:Math.floor(total/parts),committedIngots:b.reservedUnits};})};
}
describe('ordinary paid and free fourteen-day funded replay',()=>{
 it('independently replays both pools, two genuine term rounds and once-only cumulative KEEP/Renown/day claims',async()=>fixture(async f=>{
  let cursor=0,totalNet=0n,totalTax=0n,totalRecycle=0n,expectedConsumed=0;
  const expected=new Map<string,bigint>(),terms=new Map<string,string[]>(),publications=[];
  let freeClaim:Awaited<ReturnType<typeof executeFundedMiningClaim>>|null=null;
  for(let i=0;i<14;i++){
   const day=`2020-01-${String(i+1).padStart(2,'0')}`,stage=await f.stage(day,{paidQuantity:i%3+1}),p=await stage.publish(),m=JSON.parse(p.prepared.manifestJson);
   publications.push(p);const oracle=settleWalletMining((m.captures as FundedMiningCapture[]).map(independent),BigInt(m.budgetGross),false,{free:KEEP_MINING_FLOOR.minUnitsPerPool,deed:KEEP_MINING_FLOOR.minUnitsPerPool});
   expect(BigInt(p.prepared.publication.freeGross),day).toBe(oracle.pools.free.awarded);expect(BigInt(p.prepared.publication.deedGross),day).toBe(oracle.pools.deed.awarded);
   let dailyNet=0n,dailyTax=0n,dailyRecycle=0n;
   for(const [wallet,gross] of [...oracle.walletAwards].sort(([a],[b])=>Buffer.compare(new PublicKey(a).toBuffer(),new PublicKey(b).toBuffer()))){
    // Independent per-atom cycle partition, including the global retained carry.
    const complete=gross/10n,tail=Number(gross%10n);let net=complete*8n,recycle=complete,tax=complete;
    for(let n=0;n<tail;n++){if(cursor<8)net++;else if(cursor===8)recycle++;else tax++;cursor=(cursor+1)%10;}
    expect(net).toBeGreaterThan(0n);expected.set(wallet,(expected.get(wallet)??0n)+net);dailyNet+=net;dailyTax+=tax;dailyRecycle+=recycle;
   }
   totalNet+=dailyNet;totalTax+=dailyTax;totalRecycle+=dailyRecycle;
   expect(p.prepared.publication).toMatchObject({playerNet:String(dailyNet),tax:String(dailyTax),recycle:String(dailyRecycle),splitEnd:cursor,total:String(totalNet)});
   expect(p.chain.nextFrontier).toMatchObject({totalPublished:totalNet,taxHighwater:totalTax,recycledTotal:totalRecycle,grossPublished:totalNet+totalTax+totalRecycle});
   expectedConsumed+=oracle.entries.reduce((n,row)=>n+row.consumed,0);
   expect(p.settlement.dispositions.reduce((n,r)=>n+r.consumed,0)).toBe(oracle.entries.reduce((n,r)=>n+r.consumed,0));
   expect(p.original.vaultAmount-p.chain.afterTokenBalance.vaultAfter).toBe(dailyRecycle);
   expect(p.chain.afterTokenBalance.reserveAfter-p.original.reserveAmount).toBe(dailyRecycle);
   const round=String(stage.tax.round);if(terms.has(round))expect(stage.tax.signatures).toEqual(terms.get(round));else terms.set(round,stage.tax.signatures);
   const histories=(m.captures as FundedMiningCapture[]).map(c=>c.qualification.sources.deeds.evidence.assets[0]!.mint.signature);
   expect(histories).toEqual([f.originalDeedSignatures[1],f.originalDeedSignatures[1]]);
   if(i===0||i===6||i===13){freeClaim=await executeFundedMiningClaim(f,p,freeClaim);f.acceptClaim(freeClaim);
    expect(freeClaim.postSnapshot.claimantAta.balanceBaseUnits).toBe(expected.get(f.wallet));
    expect(freeClaim.postSnapshot.renownRecord).toMatchObject({renownTotal:BigInt(i+1),daysAttested:BigInt(i+1)});
   }
  }
  expect(terms.size).toBe(2);expect(new Set([...terms.values()].flat()).size).toBe(200);
  const current=f.current()!;
  const paidClaim=await executeFundedMiningClaim({...f,wallet:f.buyer,walletSigner:f.buyerSigner},current,null);f.acceptClaim(paidClaim);
  expect(paidClaim.payment).toBe(expected.get(f.buyer));expect(paidClaim.postSnapshot.renownRecord).toMatchObject({renownTotal:14n,daysAttested:14n});
  expect(paidClaim.postSnapshot.backing.config.totalClaimed).toBe(totalNet);
  expect(paidClaim.postSnapshot.backing.config.taxPaid).toBe(0n); // Original zero-winner tax stays encumbered.
  expect(paidClaim.postSnapshot.backing.vaultAmount).toBe(publications[0]!.original.vaultAmount-totalNet-totalRecycle);
  expect(paidClaim.postSnapshot.backing.vaultAmount).toBeGreaterThanOrEqual(totalTax);
  const stock=await f.conn.sql`select * from mining_ingot_dispositions order by reservation_id`;
  expect(stock).toHaveLength(28);expect(stock.reduce((n,r)=>n+r.consumed_qty,0)).toBe(expectedConsumed);
  for(const wallet of [f.wallet,f.buyer]){const entitlement=await createMiningClaimEntitlementReader(f.conn.db,f.identity)(wallet);
   expect(entitlement.kind).toBe('entitlement');if(entitlement.kind!=='entitlement')throw Error('Final rights missing');
   expect(entitlement.leaf).toMatchObject({cumulativeKeep:String(expected.get(wallet)),cumulativeRenown:'14',cumulativeDays:'14'});}
  for(const claim of [freeClaim!,paidClaim]){claim.receiptReader.getGenesisHash=async()=>{throw Error('Historical replay must not use RPC');};expect(await claim.settle()).toEqual(claim.settlement);expect(await claim.recover()).toEqual(claim.settlement);}
  for(const p of publications){p.chain.reader.getGenesisHash=async()=>{throw Error('Publication replay must not use RPC');};expect(await p.settle()).toEqual(p.settlement);expect(await getPreparedMiningPublication(f.conn.db,p.prepared.epochId)).toEqual(p.prepared);}
  expect(await f.conn.sql`select * from mining_ingot_dispositions order by reservation_id`).toEqual(stock);
  expect(await f.conn.sql`select * from mining_claim_receipts`).toHaveLength(4);
 }),240_000);
});
