/** Actual resource custody → frozen original publication → cumulative claim.
 * Chain finality is a bounded local bank; no live signer or activation. */
import { Keypair } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { withDivineFragmentFixture } from './fixtures/divineFragments';
import { randomUUID } from 'node:crypto';
import { describe,it,expect,vi,afterEach } from 'vitest';
import { PHASE_E_RAW_RESOURCE_IDS } from '@shardkeep/shared/phaseEResources';
import { ORDINARY_REFINED_IDS } from '@shardkeep/shared/phaseEOrdinaryCrafting';
import type { MiningContributionLine } from '@shardkeep/shared/miningContribution';
import { withFundedMiningReplayFixture as fixture } from './fixtures/fundedMiningReplay';
import { executeFundedMiningClaim } from './fixtures/fundedMiningClaims';
import { getResourceMiningPublicationAttempt } from '../src/mining/resourcePublicationCustody';
import { getPreparedMiningPublication } from '../src/mining/publicationPreparation';
import { createMiningClaimEntitlementReader } from '../src/mining/claimEntitlement';
import { readMiningContribution, reserveMiningContribution, abortMiningContributions } from '../src/game/miningContributions';
import { miningCanonical,miningDigest } from '../src/mining/fundedMiningAudit';
import { getBaseShardBalance } from '../src/game/baseEconomy';
const basket=():{free:MiningContributionLine[];paid:MiningContributionLine[]}=>({
 free:[{resourceId:'forge_ingot',quantity:'1'},{resourceId:'heartwood_logs',quantity:'20'},{resourceId:'shards',quantity:'200'}],
 paid:[{resourceId:'forge_ingot',quantity:'1'},{resourceId:'shards',quantity:'700'},
  ...PHASE_E_RAW_RESOURCE_IDS.map(resourceId=>({resourceId,quantity:'20'})),
  ...ORDINARY_REFINED_IDS.map(resourceId=>({resourceId,quantity:'8'})),{resourceId:'navigation_kit',quantity:'2'}],
});
const leaf=(e:unknown):{message?:string}=>{let x=e as {cause?:unknown;message?:string};while(x?.cause)x=x.cause as typeof x;return x;};
afterEach(()=>vi.unstubAllEnvs());
describe('native resource funded publication',()=>{
 it('extends retained ingot rights across two resource days, consumes every exact basket once and claims cumulative KEEP/Renown',async()=>fixture(async f=>{
  const old=await(await f.stage('2020-01-01')).publish(),saved=old.prepared.manifestJson;
  let last:Awaited<ReturnType<Awaited<ReturnType<typeof f.stageResources>>['publish']>>|undefined;
  for(const day of ['2020-01-02','2020-01-03']){
   const stage=await f.stageResources(day,basket()),p=await stage.publish();last=p;
   const m=JSON.parse(p.prepared.manifestJson);
   expect(m).toMatchObject({version:5,scope:'ordinary-resource-mining-v2',input:{policyVersion:2}});
   expect(m).not.toHaveProperty('reservations');expect(m.epoch).not.toHaveProperty('reservations');
   const paid=m.participants.find((r:{wallet:string})=>r.wallet===f.buyer);
   expect(paid.capacityValue).toBeNull();expect(BigInt(paid.eligibleValue)).toBeGreaterThan(80_000n);
   expect(p.settlement.contributions.every(r=>r.outcome==='consumed')).toBe(true);
   expect(p.settlement.contributions.find(r=>r.actorWallet===f.buyer)!.lines).toHaveLength(19);
   expect((await f.conn.sql`select mining_pending from resource_stocks`).every(r=>r.mining_pending==='0')).toBe(true);
   expect((await f.conn.sql`select mining_pending from crafting_stocks`).every(r=>r.mining_pending==='0')).toBe(true);
   const attempt=await getResourceMiningPublicationAttempt(f.conn.db,p.prepared.epochId);
   expect(attempt!.contributionSetSha256).toBe(miningDigest(miningCanonical(attempt!.contributions)));
   const [columns]=await f.conn.sql`select reservations,reservation_count,reserved_ingots,contributions_sha256 from mining_publication_attempts where epoch_id=${p.prepared.epochId}`;
   expect(columns).toMatchObject({reservations:null,reservation_count:null,reserved_ingots:null,contributions_sha256:attempt!.contributionSetSha256});
   expect(await f.conn.sql`select * from mining_ingot_reservations where epoch_id=${p.prepared.epochId}`).toHaveLength(0);
   expect(await p.settle()).toEqual(p.settlement);
   expect((await readMiningContribution(f.conn.db,f.buyer,stage.paid.command.idempotencyKey)).settlement?.outcome).toBe('consumed');
  }
  if(!last)throw Error('Resource publication missing');
  const claim=await executeFundedMiningClaim({...f,wallet:f.buyer,walletSigner:f.buyerSigner},last,null);f.acceptClaim(claim);
  expect(claim.postSnapshot.renownRecord).toMatchObject({renownTotal:3n,daysAttested:3n});
  expect((await createMiningClaimEntitlementReader(f.conn.db,f.identity)(f.buyer)).kind).toBe('entitlement');
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');last.chain.reader.getGenesisHash=async()=>{throw Error('Offline original recovery');};
  expect(await last.settle()).toEqual(last.settlement);expect(await getPreparedMiningPublication(f.conn.db,last.prepared.epochId)).toEqual(last.prepared);
  expect(old.prepared.manifestJson).toBe(saved);expect(await old.settle()).toEqual(old.settlement);
 }),180_000);
 it('freezes actual canonical sources, rejects altered outcomes and fences return after an attempted publication',async()=>fixture(async f=>{
  const stage=await f.stageResources('2020-01-01',basket()),p=await stage.prepare(stage.request);
  if(p.status!=='prepared')throw Error('Useful source required');
  await expect(abortMiningContributions(f.conn.db,{epochId:p.epochId,decisionKey:randomUUID(),reason:'unsafe-return'})).rejects.toThrow();
  await expect(reserveMiningContribution(f.conn.db,f.wallet,{...stage.free.command,idempotencyKey:randomUUID(),lines:[{resourceId:'shards',quantity:'1'}]},f.context,{clock:()=>new Date('2020-01-01T14:00:00Z')})).rejects.toThrow();
  const m=JSON.parse(p.manifestJson);m.contributions[0].lines[0].quantity='99999';
  await expect(f.conn.sql`insert into mining_publication_manifests(epoch_id,manifest_json,publication) values(${p.epochId},${miningCanonical(m)},${JSON.stringify(p.publication)}::jsonb)`).rejects.toThrow('MINING_SETTLEMENT_MANIFEST');
  const original=await getResourceMiningPublicationAttempt(f.conn.db,p.epochId);
  expect(original!.contributions).toEqual(JSON.parse(p.manifestJson).epoch.contributions);
  expect(await f.conn.sql`select * from mining_contribution_terminals`).toHaveLength(0);
  expect(await stage.publish()).toMatchObject({settlement:{contributions:expect.any(Array)}});
 }),180_000);
 it('returns full native baskets when no funded reward exists without creating an attempted publication',async()=>fixture(async f=>{
  const stage=await f.stageResources('2020-01-01',basket());
  stage.backing.rows[1]!.data.writeBigUInt64LE(0n,64);stage.backing.rows[2]!.data.writeBigUInt64LE(0n,64);
  const before=await getBaseShardBalance(f.conn.db,f.baseId),plan=await stage.prepare(stage.request);
  expect(plan.status).toBe('abort-proposed');
  if(plan.status!=='abort-proposed')throw Error('Empty funding must return a whole basket');
  expect(JSON.parse(plan.plan.manifestJson).contributions.every((r:{outcome:string})=>r.outcome==='returned')).toBe(true);
  expect(await getResourceMiningPublicationAttempt(f.conn.db,stage.request.epochId)).toBeNull();
  await abortMiningContributions(f.conn.db,{epochId:stage.request.epochId,decisionKey:randomUUID(),reason:'no-useful-funded-award'});
  expect(await getBaseShardBalance(f.conn.db,f.baseId)).toBe(before+200n);
  expect((await readMiningContribution(f.conn.db,f.wallet,stage.free.command.idempotencyKey)).settlement?.outcome).toBe('returned');
  expect(await f.conn.sql`select * from mining_publication_settlements`).toHaveLength(0);
 }),180_000);
 it('rolls back finalized settlement and every debit together, then recovers the original saved transaction',async()=>fixture(async f=>{
  const stage=await f.stageResources('2020-01-01',basket()),balance=await getBaseShardBalance(f.conn.db,f.baseId);
  // This fault used to be a deferred constraint trigger on ledger_entries. Since
  // 0285/0287 (kept by 0301) the retirement seal fingerprints every trigger on
  // accounts, ledger_transactions, ledger_entries and raids, so a fixture trigger
  // there is catalog tamper: every guarded Phase E path, this settlement included,
  // fails closed with DIVINE_FRAGMENT_SOURCE before the fault could fire. Inject
  // the same commit-time fault without touching the sealed catalog: inside the
  // settlement's own transaction, after its last write and every deferred guard.
  const db=f.conn.db,commit=db.transaction.bind(db);let written:number|undefined;
  const faulted:typeof db.transaction=(run,config)=>commit(async tx=>{const out=await run(tx);
   if((await tx.execute(sql`select 1 from mining_publication_settlements limit 1`)).length){
    await tx.execute(sql`set constraints all immediate`);
    written=Number((await tx.execute<{n:string}>(sql`select count(*)::text n from mining_contribution_terminals`))[0]!.n);
    throw Error('FIXTURE_RESOURCE_ATOMIC');}
   return out;},config);
  let failure:unknown;Reflect.set(db,'transaction',faulted);try{await stage.publish();}catch(e){failure=e;}finally{Reflect.deleteProperty(db,'transaction');}
  expect(leaf(failure)?.message).toBe('FIXTURE_RESOURCE_ATOMIC');expect(written).toBe(2);
  expect(await f.conn.sql`select * from mining_publication_signed_wires`).toHaveLength(1);
  expect(await f.conn.sql`select * from mining_publication_settlements`).toHaveLength(0);
  expect(await f.conn.sql`select * from mining_contribution_terminals`).toHaveLength(0);
  expect(await getBaseShardBalance(f.conn.db,f.baseId)).toBe(balance);
  await f.conn.sql`select public.shardkeep_divine_fragment_source()`;
  const published=await stage.publish();expect(published.settlement.contributions).toHaveLength(2);
  expect(await published.settle()).toEqual(published.settlement);
 }),180_000);
 it('returns an ineligible transferred kingdom basket to its original base during finalized settlement',async()=>fixture(async f=>{
  const stage=await f.stageResources('2020-01-01',basket()),next=Keypair.generate().publicKey.toBase58();
  const before=await getBaseShardBalance(f.conn.db,f.paidBaseId);
  await f.clock('2020-01-01T14:00:00Z');
  await f.conn.sql`insert into players(wallet) values(${next})`;
  await f.conn.sql`update bases set owner_wallet=${next},status='inactive' where id=${f.paidBaseId}`;
  await f.conn.sql`update base_slots set wallet=${next},active=false where base_id=${f.paidBaseId}`;
  await f.clock(null);
  const p=await stage.publish();
  expect(p.prepared.publication.deedGross).toBe('0');expect(BigInt(p.prepared.publication.freeGross)).toBeGreaterThan(0n);
  expect(p.settlement.contributions.find(r=>r.actorWallet===f.buyer)).toMatchObject({baseId:f.paidBaseId,outcome:'returned',lines:stage.paid.envelope.receipt!.lines});
  expect(await getBaseShardBalance(f.conn.db,f.paidBaseId)).toBe(before+700n);
  expect((await f.conn.sql`select available,mining_pending from crafting_stocks where base_id=${f.paidBaseId}`).every(r=>r.mining_pending==='0'&&BigInt(r.available)>0n)).toBe(true);
  expect((await readMiningContribution(f.conn.db,next,stage.paid.command.idempotencyKey)).status).toBe('unknown');
  expect((await readMiningContribution(f.conn.db,f.buyer,stage.paid.command.idempotencyKey)).settlement?.outcome).toBe('returned');
  expect(await p.settle()).toEqual(p.settlement);
 }),180_000);
 it('consumes an earned Divine Crystal Fragment through manifest5 without weakening earned-source conservation',async()=>withDivineFragmentFixture(async d=>{
  await d.fragments.enroll(d.event.id);await d.play();await d.settle();
  await d.fragments.deliver(d.wallet,d.event.id,{idempotencyKey:randomUUID(),baseId:d.baseId});
  const [opening]=await d.sql`select available from crystal_fragment_stocks where base_id=${d.baseId}`;
  expect(BigInt(opening!.available)).toBeGreaterThan(0n);
  // Preserve every intervening funded frontier; the fragment is earned on Jan7.
  for(const day of ['2020-01-02','2020-01-03','2020-01-04','2020-01-05','2020-01-06'])await(await d.f.stage(day)).publish();
  const stage=await d.f.stageResources('2020-01-07',{free:[{resourceId:'crystal_fragment',quantity:'1'}],paid:[{resourceId:'forge_ingot',quantity:'1'}]});
  const p=await stage.publish();
  expect(p.settlement.contributions.find(r=>r.actorWallet===d.wallet)).toMatchObject({outcome:'consumed',lines:[{resourceId:'crystal_fragment',quantity:'1'}]});
  const [closed]=await d.sql`select available,mining_pending from crystal_fragment_stocks where base_id=${d.baseId}`;
  expect(closed!.available).toBe(String(BigInt(opening!.available)-1n));expect(closed!.mining_pending).toBe('0');
  await expect(d.sql`update crystal_fragment_stocks set available=available+1 where base_id=${d.baseId}`).rejects.toThrow('DIVINE_FRAGMENT_STOCK_CONSERVATION');
  expect(await p.settle()).toEqual(p.settlement);
 }),180_000);

});
