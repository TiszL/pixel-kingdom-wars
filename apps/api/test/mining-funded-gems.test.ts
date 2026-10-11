/** Actual converted Gems proof enters paid mining only after original transfer
 * and terminal gameplay effect verification; unsupported/missing proof holds. */
import { afterEach,describe,it,expect,vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { PHASE_E_GEMS_MINING_CREDIT as GEMS,PHASE_E_MINING_SCORE_POLICY as SCORE,TOKEN } from '@shardkeep/shared';
import { withFundedMiningReplayFixture as fixture } from './fixtures/fundedMiningReplay';
import { fundedMiningGems } from './fixtures/fundedMiningGems';
import { executeFundedMiningClaim } from './fixtures/fundedMiningClaims';
import { createFundedMiningPublicationPreparer } from '../src/mining/fundedMiningAllocation';
import { getPreparedMiningPublication } from '../src/mining/publicationPreparation';
import { composeGemsContribution } from '../src/mining/gemsContribution';
import type { FundedMiningCapture } from '../src/mining/fundedMiningQualification';
afterEach(()=>vi.unstubAllEnvs());
describe('positive useful converted Gems in funded mining',()=>{
 it('requires actual original inflow and completed spend before the bounded score, final stock consumption and paid claim',async()=>fixture(async f=>{
  vi.stubEnv('MULTI_BASE_ENABLED','false');
  const gems=await fundedMiningGems(f,f.identity),stage=await f.stage('2020-01-01',{gems:gems.wiring});
  expect(gems.cost).toBeGreaterThanOrEqual(BigInt(GEMS.minConvertedGemsSpent));
  expect((await f.conn.sql`select level from troop_research where player_wallet=${f.buyer} and troop='giant'`)[0]?.level).toBe(2);
  const money=await f.conn.sql`select id,balance from accounts order by id`,ledger=await f.conn.sql`select id from ledger_transactions order by id`;
  const {gems:_gems,...without}=stage.sources;
  const absent=createFundedMiningPublicationPreparer(f.conn.db,{...stage.optionsForPrepare,sources:without});
  await expect(absent(stage.request)).rejects.toMatchObject({code:'USEFUL_CHAIN_UNAVAILABLE'});
  gems.transactions.delete(gems.signature);await expect(stage.prepare(stage.request)).rejects.toMatchObject({code:'CHAIN_UNAVAILABLE'});gems.transactions.set(gems.signature,gems.transaction);
  const foreign=createFundedMiningPublicationPreparer(f.conn.db,{...stage.optionsForPrepare,sources:{...stage.sources,gems:{...gems.wiring,trust:{...gems.wiring.trust,expectedGenesisHash:Keypair.generate().publicKey.toBase58()}}}});
  await expect(foreign(stage.request)).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
  expect(await f.conn.sql`select * from mining_publication_attempts`).toHaveLength(0);expect(await f.conn.sql`select * from mining_ingot_dispositions`).toHaveLength(0);
  const p=await stage.publish(),manifest=JSON.parse(p.prepared.manifestJson),capture=(manifest.captures as FundedMiningCapture[]).find(c=>c.wallet===f.buyer)!;
  expect(capture.gems).toMatchObject({zeroQualifyingCredit:false,reason:'paid-origin'});expect(capture.gemsContribution).not.toBeNull();
  const contribution=composeGemsContribution(capture.gemsContribution!.use,capture.gemsContribution!.origins);
  expect(contribution).toMatchObject({credits:GEMS.maxCreditsPerWalletDay,convertedGemsSpent:String(gems.cost),usefulGemsComponentBps:GEMS.usefulComponentBps,reason:'qualified'});
  expect(capture.gemsContribution!.origins.origins).toMatchObject([{signature:gems.signature,rawKeepBaseUnits:String(gems.cost*10n**BigInt(TOKEN.decimals)+123n),trust:'trusted-finalized-rpc'}]);
  expect(contribution.eligibleSpends).toMatchObject([{kind:'research-finish',convertedGems:String(gems.cost)}]);
  const participant=manifest.participants.find((c:{wallet:string})=>c.wallet===f.buyer),a=capture.activity;
  expect(participant.usefulChainBps).toBe(GEMS.usefulComponentBps);
  expect(participant.walletScoreBps).toBe(Math.floor((a.latestDayActivityBps*SCORE.activityWeight+a.experienceBps*SCORE.experienceWeight+GEMS.usefulComponentBps*SCORE.usefulChainWeight)/(SCORE.activityWeight+SCORE.experienceWeight+SCORE.usefulChainWeight)));
  expect(p.settlement.dispositions.reduce((n,r)=>n+r.consumed,0)).toBe(2);
  const claim=await executeFundedMiningClaim({...f,wallet:f.buyer,walletSigner:f.buyerSigner},p,null);
  const award=manifest.awards.find((r:{wallet:string})=>r.wallet===f.buyer);expect(claim.payment).toBe(BigInt(award.net));expect(claim.postSnapshot.renownRecord).toMatchObject({renownTotal:1n,daysAttested:1n});
  const calls=[...gems.calls];gems.transactions.clear();vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  expect(await getPreparedMiningPublication(f.conn.db,p.prepared.epochId)).toEqual(p.prepared);expect(await claim.recover()).toEqual(claim.settlement);expect(gems.calls).toEqual(calls);
  expect(await f.conn.sql`select id,balance from accounts order by id`).toEqual(money);expect(await f.conn.sql`select id from ledger_transactions order by id`).toEqual(ledger);
 }),90000);
});
