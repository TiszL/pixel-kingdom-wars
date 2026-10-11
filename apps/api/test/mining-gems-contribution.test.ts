import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { speedupCostKeep, TOKEN } from '@shardkeep/shared';
import { researchSpeedup } from '../src/game/army';
import { withClientCurrencyContext } from '../src/game/clientCurrency';
import { withFinalizedGems } from './fixtures/gemsFinalizedOrigins';
import { PHASE_E_GEMS_MINING_CREDIT as POLICY } from '@shardkeep/shared';
import { Keypair } from '@solana/web3.js';
import { composeGemsContribution, createGemsContributionReader } from '../src/mining/gemsContribution';
import { deriveGemsSinkUseEvidence } from '../src/mining/gemsSinkUseEvidence';
import { attributeGemsFlowEvidence } from '../src/mining/gemsFlowAttribution';
import type { FinalizedGemsOrigins } from '../src/mining/gemsFinalizedOrigins';
import { sinkUseFixture } from './fixtures/gemsSinkUse';
const originalBps = POLICY.usefulComponentBps;
afterEach(() => { Object.assign(POLICY, { usefulComponentBps: originalBps }); });
function fixture() {
 const f = sinkUseFixture(); f.evidence.day = '2035-01-01';
 const views = () => {
  const use = deriveGemsSinkUseEvidence(f.evidence), k = () => Keypair.generate().publicKey.toBase58();
  const origins: FinalizedGemsOrigins = { version: 1, sourcePolicyVersion: 1, wallet: f.wallet, day: f.evidence.day,
   birthEventId: f.evidence.birthEventId, sourceDigest: use.sourceDigest, chainIdentity: { cluster: 'devnet', expectedGenesisHash: k(), keepMint: k(), reserveOwner: k(), reserveAta: k() },
   origins: [], attribution: attributeGemsFlowEvidence(f.evidence), usefulChainCreditAuthorized: false, allocationReady: false, publicationAuthorized: false };
  return { use, origins };
 };
 return { ...f, views, read: () => { const { use, origins } = views(); return composeGemsContribution(use, origins); } };
}
describe('bounded daily contribution from useful converted Gems', () => {
 it.each([99,100,200])('awards at most one bounded contribution for %s verified converted Gems', spent => {
  const f = fixture(); f.spend(100n,{excluded:true});
  if(spent>100){f.add('builder',100n);f.add('research',BigInt(spent-100));}else f.add('builder',BigInt(spent));
  const r=f.read();expect(r.convertedGemsSpent).toBe(String(spent));expect(r.credits).toBe(spent>=POLICY.minConvertedGemsSpent?1:0);
  expect(r.usefulGemsComponentBps).toBe(r.credits?POLICY.usefulComponentBps:0);expect(r).toMatchObject({allocationReady:false,publicationAuthorized:false});
 });
 it('does not count grant-funded completion, conversions or Gems-to-SHARDS depletion',()=>{
  const f=fixture();f.add('builder',100n);f.spend(200n,{excluded:true});f.origin(1000n);
  expect(f.read()).toMatchObject({credits:0,convertedGemsSpent:'0',reason:'below_threshold'});
 });
 it('uses only the converted portion of a mixed-origin completed purchase',()=>{
  const f=fixture();f.spend(50n,{excluded:true});f.add('builder',100n);
  expect(f.read()).toMatchObject({credits:0,convertedGemsSpent:'50'});
 });
 it('returns restored provenance without granting a credit for a refunded buff',()=>{
  const f=fixture();f.spend(100n,{excluded:true});const buff=f.spend(100n,{raidId:crypto.randomUUID()});f.refund(buff);
  expect(f.read()).toMatchObject({credits:0,convertedGemsSpent:'0',unresolvedConvertedGems:'0'});
 });
 it('refuses an unknown positive converted use instead of treating missing proof as zero',()=>{
  const f=fixture();f.spend(100n,{excluded:true});f.spend(100n);
  expect(()=>f.read()).toThrowError(expect.objectContaining({code:'USE_UNAVAILABLE'}));
 });
 it('keeps a proved daily maximum when extra unproven use cannot increase it',()=>{
  const f=fixture();f.spend(100n,{excluded:true});f.add('builder',100n);f.spend(25n);
  expect(f.read()).toMatchObject({credits:1,convertedGemsSpent:'100',unresolvedConvertedGems:'25'});
 });
 it('never carries yesterday’s spending or unknown old spending into today’s credit',()=>{
  const f=fixture();f.spend(100n,{excluded:true});f.add('builder',100n);f.spend(25n);f.evidence.day='2035-01-02';
  expect(f.read()).toMatchObject({credits:0,convertedGemsSpent:'0',unresolvedConvertedGems:'0'});
 });
 it('uses whole-transaction effective time at the UTC day boundary',()=>{
  const f=fixture();f.spend(100n,{excluded:true});const receipt=f.add('builder',100n);receipt.fact.effectiveObservedAt='2035-01-02T00:00:00.000000Z';f.evidence.day='2035-01-02';
  expect(f.read()).toMatchObject({credits:1,convertedGemsSpent:'100'});
 });
 it.each(['digest','wallet','day','amount','missing','composition'] as const)('refuses %s disagreement between independently verified views',change=>{
  const f=fixture();f.spend(100n,{excluded:true});f.add('builder',100n);const {use,origins}=f.views();
  if(change==='digest')origins.sourceDigest='f'.repeat(64);else if(change==='wallet')origins.wallet=Keypair.generate().publicKey.toBase58();else if(change==='day')origins.day='2035-01-02';
  else if(change==='amount')origins.attribution.debits[1]!.amount='101';else if(change==='missing')use.verified=[];else origins.attribution.debits[1]!.consumed[0]!.amount='99';
  expect(()=>composeGemsContribution(use,origins)).toThrowError(expect.objectContaining({code:'SOURCE_MISMATCH'}));
 });
 it('refuses wallet-conversion lots whose finalized origin has not been established',()=>{
  const f=fixture();f.spend(300n,{excluded:true});f.origin(100n,'wallet-conversion-ledger');f.add('builder',100n);
  expect(()=>f.read()).toThrowError(expect.objectContaining({code:'SOURCE_MISMATCH'}));
 });
 it('joins an ordinary finalized wallet credit and completed research into one recoverable daily contribution',async()=>withFinalizedGems(async f=>{
  vi.stubEnv('MULTI_BASE_ENABLED','false');
  const cost=BigInt(speedupCostKeep(3600));expect(cost).toBeGreaterThanOrEqual(BigInt(POLICY.minConvertedGemsSpent));
  const payment=await f.credit(f.transfer(cost*10n**BigInt(TOKEN.decimals)+123n));
  const now=new Date('2035-01-01T02:00:00.000Z'),finishesAt=new Date('2035-01-01T03:00:00.000Z');
  await f.conn.sql`insert into troop_research(player_wallet,troop,level,researching_to_level,finishes_at) values(${f.wallet},'giant',1,2,${finishesAt.toISOString()})`;
  await f.clock('2035-01-01T02:00:00.000999Z');
  await withClientCurrencyContext({currency:undefined,expectedCurrency:'GEMS'},()=>researchSpeedup(f.conn.db,f.wallet,'giant',randomUUID(),now,undefined,{currentLevel:1,toLevel:2,finishesAt:finishesAt.toISOString(),episodeId:null,maxCostKeep:cost.toString()}));
  await f.close();const read=createGemsContributionReader(f.conn.db,f.wiring),before=await f.conn.sql`select count(*)::int n from ledger_transactions`;
  const result=await read(f.request);expect(result).toMatchObject({credits:1,convertedGemsSpent:cost.toString(),usefulGemsComponentBps:POLICY.usefulComponentBps});
  expect(result.eligibleSpends).toMatchObject([{kind:'research-finish',convertedGems:cost.toString()}]);
  expect((await f.conn.sql`select level from troop_research where player_wallet=${f.wallet}`)[0]?.level).toBe(2);
  f.transactions.delete(payment.signature);await expect(read(f.request)).rejects.toMatchObject({code:'CHAIN_UNAVAILABLE'});f.transactions.set(payment.signature,payment.tx);
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');expect(await read(f.request)).toEqual(result);
  expect(await f.conn.sql`select count(*)::int n from ledger_transactions`).toEqual(before);
 }),30000);
 it('the zero contribution switch prevents a credit including unresolved extra use',()=>{
  const f=fixture();f.spend(100n,{excluded:true});f.add('builder',100n);f.spend(25n);Object.assign(POLICY,{usefulComponentBps:0});
  expect(f.read()).toMatchObject({credits:0,usefulGemsComponentBps:0,reason:'disabled'});
 });
});
