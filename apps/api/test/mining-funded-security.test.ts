/** Source incompleteness cannot mint free eligibility, and finality does not let
 * stock dispositions survive a failed atomic publication settlement. */
import { describe,it,expect } from 'vitest';
import { Keypair,PublicKey } from '@solana/web3.js';
import { fixture as rawBank,tx as rawTx } from '../../../packages/chain/src/testFixtures/deedMiningWallet';
import type { DeedMiningWalletReader } from '@shardkeep/chain/mining-wallet';
import { createFundedMiningPublicationPreparer } from '../src/mining/fundedMiningAllocation';
import { withFundedMiningFixture } from './fixtures/fundedMining';
import { withFundedMiningReplayFixture } from './fixtures/fundedMiningReplay';
const leaf=(e:unknown):{code?:string;message?:string}=>{let x=e as {cause?:unknown;code?:string;message?:string};while(x.cause)x=x.cause as typeof x;return x;};
describe('funded mining source and atomic custody boundaries',()=>{
 it.each(['unregistered','minted-in-day'] as const)('excludes a wallet with a %s deed from the free pool while preserving the separate paid pool',async kind=>withFundedMiningFixture(async f=>{
  const stage=await f.stage(),start=Date.parse('2020-01-01')/1000,end=start+86400,paid=new PublicKey(f.assetId),extra=Keypair.generate().publicKey;
  const times:Record<number,number>={1:start-100,9:start-2,10:start-1,12:start+100,19:end,20:end+1,21:end+2,25:end+3};
  const rows=[rawTx('collection',1),rawTx('mint',10,new PublicKey(f.buyer),paid),rawTx('mint',kind==='unregistered'?9:12,new PublicKey(f.wallet),extra)];
  for(const r of rows)r.blockTime=times[r.slot]!;
  const source=()=>{const bank=rawBank(rows,[{id:paid,owner:new PublicKey(f.buyer)},{id:extra,owner:new PublicKey(f.wallet)}]);
   bank.reader.getBlockTime.mockImplementation(async slot=>times[slot]??null);bank.reader.getBlockSignatures.mockImplementation(async slot=>({blockTime:times[slot]!,signatures:rows.filter(r=>r.slot===slot).map(r=>r.transaction.signatures[0])}));return bank.reader as unknown as DeedMiningWalletReader;};
  const prepare=createFundedMiningPublicationPreparer(f.conn.db,{...stage.optionsForPrepare,sources:{...stage.sources,qualification:{...stage.sources.qualification,source}}});
  const p=await prepare(stage.request);expect(p.status).toBe('prepared');if(p.status!=='prepared')throw Error('Paid pool must remain useful');
  expect(p.publication.freeGross).toBe('0');expect(BigInt(p.publication.deedGross)).toBeGreaterThan(0n);
  const m=JSON.parse(p.manifestJson);expect(m.reservations.find((r:{baseId:string})=>r.baseId===f.baseId)).toMatchObject({proposedConsumed:0,proposedReturned:1});
  expect(m.awards.find((r:{wallet:string})=>r.wallet===f.wallet)).toMatchObject({net:'0',renown:'0',days:'0'});
  expect(await f.conn.sql`select * from mining_ingot_dispositions`).toHaveLength(0);
 }));
 it('rolls final settlement and both stock dispositions back together, then settles the retained original once',async()=>withFundedMiningReplayFixture(async f=>{
  const stage=await f.stage('2020-01-01'),before=await f.conn.sql`select base_id,item_id,qty from base_items where item_id='forge_ingot' order by base_id`;
  await f.conn.sql.unsafe(`create function public.fixture_funded_terminal_failure() returns trigger language plpgsql as $$ begin raise exception 'FIXTURE_FUNDED_TERMINAL_ROLLBACK'; end $$;
   create constraint trigger fixture_funded_terminal_failure after insert on mining_ingot_dispositions deferrable initially deferred for each row execute function public.fixture_funded_terminal_failure()`);
  let error:unknown;try{await stage.publish();}catch(e){error=e;}
  expect(leaf(error)).toMatchObject({code:'P0001',message:'FIXTURE_FUNDED_TERMINAL_ROLLBACK'});
  expect(await f.conn.sql`select * from mining_publication_signed_wires`).toHaveLength(1);
  expect(await f.conn.sql`select * from mining_publication_settlements`).toHaveLength(0);expect(await f.conn.sql`select * from mining_ingot_dispositions`).toHaveLength(0);
  expect(await f.conn.sql`select * from mining_claim_entitlement_headers`).toHaveLength(0);
  expect(await f.conn.sql`select base_id,item_id,qty from base_items where item_id='forge_ingot' order by base_id`).toEqual(before);
  await f.conn.sql.unsafe('drop trigger fixture_funded_terminal_failure on mining_ingot_dispositions; drop function public.fixture_funded_terminal_failure()');
  const p=await stage.publish();expect(p.settlement.dispositions.reduce((n,r)=>n+r.consumed,0)).toBe(2);
  expect(await p.settle()).toEqual(p.settlement);expect(await f.conn.sql`select * from mining_publication_settlements`).toHaveLength(1);
  expect(await f.conn.sql`select * from mining_ingot_dispositions`).toHaveLength(2);
 }),60000);
});
