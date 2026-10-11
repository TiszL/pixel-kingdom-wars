import {createHash,randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {keepAta} from '@shardkeep/chain';
import {GEMS,speedupCostKeep,PHASE_E_GEMS_MINING_CREDIT as POLICY} from '@shardkeep/shared';
import {describe,expect,it,vi} from 'vitest';
import {getOrCreatePlayerAccount,postTransaction} from '../src/ledger';
import {convertKeepToGems,convertGemsToShards} from '../src/game/gems';
import {spendGems,refundPostedSpend} from '../src/game/spend';
import {researchSpeedup} from '../src/game/army';
import {withClientCurrencyContext} from '../src/game/clientCurrency';
import {createGemsPostZeroContributionReader,readGemsPostZeroFlow,replayGemsPostZeroContribution,replayGemsPostZeroFlow,type GemsPostZeroContribution} from '../src/mining/gemsPostZeroContribution';
import {createPostZeroGemsFinalizedOriginReader,replayPostZeroGemsFinalizedOrigins,type GemsFinalizedOriginWiring} from '../src/mining/gemsFinalizedOrigins';
import {readGemsFlowEvidence} from '../src/mining/gemsFlowEvidence';
import {withGemsZeroOpeningFixture} from './fixtures/gemsZeroOpening';
import {withFinalizedGems} from './fixtures/gemsFinalizedOrigins';
type F=Parameters<Parameters<typeof withGemsZeroOpeningFixture>[0]>[0];
const request=(f:F,id:string,day='2020-01-04')=>({wallet:f.wallet,openingId:id,day});
async function fund(f:F,n:bigint){const keep=await getOrCreatePlayerAccount(f.conn.db,f.wallet,'player_keep');await postTransaction(f.conn.db,{idempotencyKey:randomUUID(),type:'fixture.keep.funding',entries:[{account:f.sys.keep_genesis,delta:-n},{account:keep.id,delta:n}]});return keep;}
async function convert(f:F,n:bigint){await fund(f,n);await convertKeepToGems(f.conn.db,f.wallet,n,randomUUID());}
async function wiring(f:F):Promise<GemsFinalizedOriginWiring>{const mint=Keypair.generate().publicKey,owner=Keypair.generate().publicKey,reserve=keepAta(owner,mint,true),genesis=Keypair.generate().publicKey.toBase58();
 await f.conn.sql`insert into economy_chain_identity(singleton,cluster,keep_mint,core_program,config_pda,gems_reserve_owner,gems_reserve_ata) values(true,'devnet',${mint.toBase58()},${Keypair.generate().publicKey.toBase58()},${Keypair.generate().publicKey.toBase58()},${owner.toBase58()},${reserve.toBase58()})`;
 return {trust:{cluster:'devnet',expectedGenesisHash:genesis,keepMint:mint.toBase58(),reserveOwner:owner.toBase58(),reserveAta:reserve.toBase58()},connect:()=>{throw Error('custodial origin requires no RPC');}};
}
async function research(f:F){vi.stubEnv('MULTI_BASE_ENABLED','false');const n=BigInt(speedupCostKeep(3600)),now=new Date('2020-01-04T02:00:00.000Z'),end=new Date('2020-01-04T03:00:00.000Z');await f.clock('2020-01-04T01:00:00Z');await convert(f,n);
 await f.conn.sql`insert into troop_research(player_wallet,troop,level,researching_to_level,finishes_at) values(${f.wallet},'giant',1,2,${end.toISOString()})`;
 await f.clock('2020-01-04T02:00:00.000001Z');await withClientCurrencyContext({currency:undefined,expectedCurrency:'GEMS'},()=>researchSpeedup(f.conn.db,f.wallet,'giant',randomUUID(),now,undefined,{currentLevel:1,toLevel:2,finishesAt:end.toISOString(),episodeId:null,maxCostKeep:n.toString()}));return n;
}
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
describe('existing zero inventory preserves the ordinary Gems FIFO economics',()=>{
 it('proves actual custodial conversion and paid research from the committed old zero account and replays while paused',()=>withGemsZeroOpeningFixture(async f=>{
  const o=await f.capture(),w=await wiring(f),n=await research(f);await f.close();const read=createGemsPostZeroContributionReader(f.conn.db,w),p=await read(request(f,o.id));
  expect(p.result).toMatchObject({credits:1,convertedGemsSpent:n.toString(),usefulGemsComponentBps:POLICY.usefulComponentBps});expect(p.result.eligibleSpends).toMatchObject([{kind:'research-finish'}]);expect(p.flow.opening).toEqual(o);expect(p.flow.facts).toHaveLength(2);expect(p.flow).not.toHaveProperty('birthEventId');expect(p.origins.attribution).not.toHaveProperty('birthEventId');expect(p.flow.facts.some(x=>x.classification==='account-created')).toBe(false);
  expect((await f.conn.sql`select balance::text balance from accounts where id=${f.gems.id}`)[0]?.balance).toBe('0');expect((await f.conn.sql`select level from troop_research where player_wallet=${f.wallet}`)[0]?.level).toBe(2);
  expect(replayGemsPostZeroContribution(clone(p))).toEqual(p);const [stored]=await f.conn.sql`select ${JSON.stringify(p)}::jsonb evidence`;expect(replayGemsPostZeroContribution(stored!.evidence)).toEqual(p);expect(Object.isFrozen(p.flow.events[0]?.source)).toBe(true);vi.stubEnv('PHASE_E_MINING_ENABLED','false');expect(await read(request(f,o.id))).toEqual(p);
  const mutations:Array<(v:GemsPostZeroContribution)=>void>=[v=>{v.openingId=randomUUID();},v=>{v.flow.opening.account.id=randomUUID();},v=>{v.flow.events=[];},v=>{v.flow.groupRows=[];},v=>{v.flow.netGems='1';},v=>{v.flow.facts[0]!.classification='grant';},v=>{v.use.openingId=randomUUID();},v=>{v.origins.openingId=randomUUID();},v=>{v.origins.sourceDigest='0'.repeat(64);},v=>{v.result.usefulGemsComponentBps++;},v=>{Object.assign(v.flow,{birthEventId:'1'});},v=>{Object.assign(v.flow.events[0]!,{receiptComplete:false});},v=>{Object.assign(v.flow.groupRows[0]!,{receiptComplete:false});},v=>{v.flow.events[0]!.receipt[0]!.id='1';},v=>{v.flow.events[0]!.observedAt='2020-01-03T11:59:59.999999Z';}];
  for(const change of mutations){const q=clone(p);change(q);expect(()=>replayGemsPostZeroContribution(q)).toThrow();}
  const q=clone(p),get=vi.fn();Object.defineProperty(q.flow.events,'0',{enumerable:true,get});expect(()=>replayGemsPostZeroContribution(q)).toThrow();expect(get).not.toHaveBeenCalled();
 }));
 it('keeps excluded conversion in FIFO and restores only an exact known post-opening refund',()=>withGemsZeroOpeningFixture(async f=>{
  const o=await f.capture(),w=await wiring(f),n=BigInt(GEMS.minConvertKeep)+1n;await f.clock('2020-01-04T01:00:00Z');await convert(f,n);await convertGemsToShards(f.conn.db,f.wallet,1n,randomUUID());
  const raidId=randomUUID(),buff='speed',key=`raid:${raidId}:live-buff:${buff}`;
  const spent=await spendGems(f.conn.db,f.wallet,1n,'raid.buffs',key,{raidId,buff,live:true});await refundPostedSpend(f.conn.db,spent,`raid:${raidId}:live-buff-refund:${buff}`,'raid.buffs.system_refund',{wallet:f.wallet,currency:'GEMS',refundOf:spent.transaction.id,raidId,buff,originalKey:key});
  await f.close();const p=await createGemsPostZeroContributionReader(f.conn.db,w)(request(f,o.id));expect(p.result).toMatchObject({credits:0,convertedGemsSpent:'0'});expect(p.origins.attribution.refunds).toHaveLength(1);expect(p.origins.attribution.balanceGems).toBe(String(n-1n));expect(p.origins.attribution.debits[0]?.excludedGemsToShards).toBe(true);
 }));
 it('holds unknown new credits rather than assigning an origin to them',()=>withGemsZeroOpeningFixture(async f=>{
  const o=await f.capture();await f.clock('2020-01-04T01:00:00Z');const keep=await fund(f,1n);await postTransaction(f.conn.db,{idempotencyKey:randomUUID(),type:'fixture.unknown',entries:[{account:keep.id,delta:-1n},{account:f.sys.emission_pool,delta:1n},{account:f.sys.gems_mint,delta:-1n},{account:f.gems.id,delta:1n}]});await f.close();await expect(readGemsPostZeroFlow(f.conn.db,request(f,o.id))).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
 }));
 it('refuses a refund of an original debit before the zero boundary',()=>withGemsZeroOpeningFixture(async f=>{
  const n=BigInt(GEMS.minConvertKeep);await f.clock('2020-01-03T12:30:00Z');await convert(f,n);const raidId=randomUUID(),buff='speed',key=`raid:${raidId}:live-buff:${buff}`,spent=await spendGems(f.conn.db,f.wallet,n,'raid.buffs',key,{raidId,buff,live:true});const o=await f.capture('2020-01-03T13:00:00Z');
  await f.clock('2020-01-04T01:00:00Z');await refundPostedSpend(f.conn.db,spent,`raid:${raidId}:live-buff-refund:${buff}`,'raid.buffs.system_refund',{wallet:f.wallet,currency:'GEMS',refundOf:spent.transaction.id,raidId,buff,originalKey:key});await f.close();await expect(readGemsPostZeroFlow(f.conn.db,request(f,o.id))).rejects.toMatchObject({code:'REFUND_UNAVAILABLE'});
 }));
 it('does not omit a global group crossing the requested cutoff',()=>withGemsZeroOpeningFixture(async f=>{
  const o=await f.capture(),other=await getOrCreatePlayerAccount(f.conn.db,f.buyer,'player_gems');await f.clock('2020-01-04T01:00:00Z');await convert(f,BigInt(GEMS.minConvertKeep));await f.clock('2020-01-04T23:59:59.999999Z');
  await f.conn.db.transaction(async tx=>{await spendGems(tx,f.wallet,1n,'fixture.crossing',randomUUID());await f.clock('2020-01-05T00:00:00.000001Z');await postTransaction(tx,{idempotencyKey:randomUUID(),type:'fixture.foreign',entries:[{account:f.sys.gems_sink,delta:-1n},{account:other.id,delta:1n}]});});await f.clock('2020-01-06T00:00:00Z');await expect(readGemsPostZeroFlow(f.conn.db,request(f,o.id))).rejects.toMatchObject({code:'SOURCE_CONFLICT'});const later=await readGemsPostZeroFlow(f.conn.db,request(f,o.id,'2020-01-05'));expect(later.facts.at(-1)?.effectiveObservedAt).toBe('2020-01-05T00:00:00.000001Z');
 }));
 it('holds source mutations after the closed day while preserving the original retained proof',()=>withGemsZeroOpeningFixture(async f=>{
  const o=await f.capture();await f.clock('2020-01-04T01:00:00Z');await convert(f,BigInt(GEMS.minConvertKeep));await spendGems(f.conn.db,f.wallet,1n,'fixture.prior.spend',randomUUID());await f.close();const p=await readGemsPostZeroFlow(f.conn.db,request(f,o.id));
  await f.clock('2020-01-05T12:00:00Z');await f.conn.sql`update ledger_transactions set type='changed' where id=${p.facts[1]!.transactionId}`;await expect(readGemsPostZeroFlow(f.conn.db,request(f,o.id))).rejects.toMatchObject({code:'SOURCE_CONFLICT'});expect(replayGemsPostZeroFlow(p)).toEqual(p);
 }));
 it('refuses an incomplete raw posting without turning it into empty future flow',()=>withGemsZeroOpeningFixture(async f=>{
  const o=await f.capture();await f.clock('2020-01-04T01:00:00Z');const id=randomUUID();await f.conn.sql`insert into ledger_transactions(id,idempotency_key,type,metadata) values(${id},${randomUUID()},'fixture.incomplete','{}')`;await f.conn.sql`insert into ledger_entries(txn_id,account_id,delta,balance_after) values(${id},${f.gems.id},1,1)`;await f.close();await expect(readGemsPostZeroFlow(f.conn.db,request(f,o.id))).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
 }));
 it('refuses post-opening microsecond backdating before the requested day',()=>withGemsZeroOpeningFixture(async f=>{
  const o=await f.capture();await f.clock('2020-01-03T11:59:59.999999Z');await convert(f,BigInt(GEMS.minConvertKeep));await f.close();await expect(readGemsPostZeroFlow(f.conn.db,request(f,o.id))).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
 }));
 it('retains exact finalized wallet-deposit checks in the explicit policy2 adapter',()=>withFinalizedGems(async f=>{
  const payment=await f.credit();await f.close();const old=await readGemsFlowEvidence(f.conn.db,f.request),source={sourceKind:'committed-zero-inventory-fifo' as const,openingId:randomUUID(),accountId:f.gems.id,wallet:f.wallet,day:old.day,coverageStartedAt:old.coverageStartedAt,facts:old.facts.filter(x=>x.classification!=='account-created'),netGems:old.netGems!},digest=createHash('sha256').update(JSON.stringify(source)).digest('hex');
  const read=createPostZeroGemsFinalizedOriginReader(f.conn.db,f.wiring),p=await read(source,digest);expect(p.origins).toHaveLength(1);expect(p.attribution.currentLots[0]?.requiresDepositVerification).toBe(false);expect(replayPostZeroGemsFinalizedOrigins(clone(p),source,digest)).toEqual(p);
  f.transactions.delete(payment.signature);await expect(read(source,digest)).rejects.toMatchObject({code:'CHAIN_UNAVAILABLE'});f.transactions.set(payment.signature,payment.tx);payment.tx.meta!.postTokenBalances![0]!.uiTokenAmount.amount='501';await expect(read(source,digest)).rejects.toMatchObject({code:'CHAIN_MISMATCH'});
  const q=clone(p);q.origins[0]!.finalizedContextSlots=[q.origins[0]!.slot-1];expect(()=>replayPostZeroGemsFinalizedOrigins(q,source,digest)).toThrow();
 }));
});
