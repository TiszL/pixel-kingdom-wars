/** Real source acceptance for the Realm Passport read model: actual accepted
 * departures with settled returns, real audited projected publications and a
 * real current assessment over an encoded bank. Synthetic term/bank authority
 * only; nothing here proves a live auction or chain. Every refusal case is a
 * genuine source change, never a mocked reader. */
import {Keypair} from '@solana/web3.js';
import {verifyMiningAllocationProof} from '@shardkeep/chain/mining-allocation';
import {REALM_PASSPORT_PAGE_SIZE as PAGE,RealmPassportCurrentResponseSchema,RealmPassportExpeditionsResponseSchema,RealmPassportInclusionsResponseSchema} from '@shardkeep/shared/realmPassportApi';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {RealmPassportError} from '../src/game/realmPassport';
import {createMiningClaimEntitlementHistoryReader} from '../src/mining/claimEntitlement';
import type {MiningClaimAssessment} from '../src/mining/claimStatus';
import {MINING_SOURCE_TABLES,REALM_PASSPORT_TEST_FLAGS,STARTER_SOURCE_TABLES,realmPassportAdvancedFixture,realmPassportStarterFixture,snapshotTables,
 withRealmPassportCurrentFixture,withRealmPassportFundedFixture,withRealmPassportInclusionsFixture} from './fixtures/realmPassport';

const outsider=()=>Keypair.generate().publicKey.toBase58();
const PRIVATE=['leafHex','proofHex','leafIndex','manifest','custodyWallet','homeEvidence','finality','accessEvidence','preparationAllowed','claimSubmissionAuthorized','signedTransaction'];
function noPrivateWire(value:unknown,...wallets:string[]){const text=JSON.stringify(value);for(const key of [...PRIVATE,...wallets])expect(text).not.toContain(key);}
function available<T extends {state:string}>(v:T):Extract<T,{state:'available'}>{expect(v.state,JSON.stringify(v)).toBe('available');return v as Extract<T,{state:'available'}>;}
function unavailable<T extends {state:string}>(v:T,reason:string){expect(v).toMatchObject({state:'unavailable',reason,data:null,projection:'history-only',version:1});return v;}

describe('starter expedition history',()=>{
 let f:Awaited<ReturnType<typeof realmPassportStarterFixture>>;
 beforeAll(async()=>{for(const flag of REALM_PASSPORT_TEST_FLAGS)vi.stubEnv(flag,'true');f=await realmPassportStarterFixture({completed:PAGE+1});},300_000);
 afterAll(async()=>{vi.unstubAllEnvs();await f?.close();},120_000);
 const ids=()=>f.completed.map(p=>p.expedition.id).sort();
 async function walk(provider:ReturnType<typeof f.provider>,wallet:string,cursor?:string){const out:string[]=[];for(let n=0;n<8;n++){const page=available(await provider.expeditions(wallet,{kind:'starter',...(cursor?{cursor}:{})}));out.push(...page.data.rows.map(r=>r.expeditionId));if(!page.data.nextCursor)return out;expect(page.data.rows).toHaveLength(PAGE);cursor=page.data.nextCursor;}throw Error('page walk did not end');}

 it('pages actual settled returns of the original actor by ascending expeditionId, one extra row deciding nextCursor, without writing',async()=>{
  const before=await snapshotTables(f.sql,STARTER_SOURCE_TABLES),provider=f.provider();
  const first=available(await provider.expeditions(f.wallet,{kind:'starter'}));
  expect(RealmPassportExpeditionsResponseSchema.parse(first)).toEqual(first);expect(first.wallet).toBe(f.wallet);
  expect(first.data.kind).toBe('starter');expect(first.data.rows).toHaveLength(PAGE);expect(first.data.nextCursor).toBe(first.data.rows[PAGE-1]!.expeditionId);
  const second=available(await provider.expeditions(f.wallet,{kind:'starter',cursor:first.data.nextCursor!}));
  expect(second.data.rows).toHaveLength(1);expect(second.data.nextCursor).toBeNull();
  const rows=[...first.data.rows,...second.data.rows];
  expect(rows.map(r=>r.expeditionId)).toEqual(ids());expect(new Set(rows.map(r=>r.returnId)).size).toBe(rows.length);
  for(const row of rows){
   const proof=f.completed.find(p=>p.expedition.id===row.expeditionId)!,e=proof.expedition;
   expect(row).toEqual({kind:'starter',expeditionId:e.id,returnId:proof.receipt.id,originalBaseId:f.baseId,realmId:e.routeSnapshot.realmId,routeId:e.routeId,routeVersion:e.routeVersion,policyVersion:null,
    departedAt:e.departedAt.toISOString(),scheduledReturnAt:e.returnsAt.toISOString(),returnedAt:proof.receipt.returnedAt.toISOString()});
   expect(Date.parse(row.returnedAt)).toBeGreaterThanOrEqual(Date.parse(row.scheduledReturnAt));
  }
  noPrivateWire([first,second]);
  // The cursor is only a bound: a later completion behind an old cursor is found by refreshing from the first page.
  expect(available(await provider.expeditions(f.wallet,{kind:'starter',cursor:ids()[ids().length-1]!})).data.rows).toEqual([]);
  expect(await snapshotTables(f.sql,STARTER_SOURCE_TABLES)).toBe(before);
 },120_000);

 it('never selects or settles an accepted unreturned trip, and exposes the original actor through a base sale without mixing actors',async()=>{
  const pending=await f.depart();f.base.now=new Date(pending.returnsAt.getTime()+60_000);
  const before=await snapshotTables(f.sql,STARTER_SOURCE_TABLES),provider=f.provider();
  // Walk from the first page: the accepted-but-unreturned trip is absent wherever its id sorts, and no return row appears afterwards.
  expect(await walk(provider,f.wallet)).toEqual(ids());
  expect(await f.sql`select expedition_id from starter_expedition_returns where expedition_id=${pending.id}`).toHaveLength(0);
  expect(await snapshotTables(f.sql,STARTER_SOURCE_TABLES)).toBe(before);
  await f.sell();const sold=await f.settle(pending);f.completed.push(sold);
  expect(sold.receipt.custodyWallet).toBe(f.buyer);expect(sold.expedition.actorWallet).toBe(f.wallet);
  expect(await walk(provider,f.wallet)).toEqual(ids());
  // The buyer now has a real trip of their own on another base; neither actor's page ever carries the other's rows.
  const own=await f.ownTrip(f.buyer),ownId=own.proof.expedition.id;
  const buyer=available(await provider.expeditions(f.buyer,{kind:'starter'}));expect(buyer.wallet).toBe(f.buyer);
  expect(buyer.data.rows.map(r=>r.expeditionId)).toEqual([ownId]);expect(buyer.data.rows[0]!.originalBaseId).toBe(own.base.baseId);
  expect(await walk(provider,f.wallet)).toEqual(ids());
  // A foreign cursor is only a bound: the buyer gets exactly their own ids above it, never the seller's.
  for(const cursor of [ids()[0]!,ids()[ids().length-1]!])expect(available(await provider.expeditions(f.buyer,{kind:'starter',cursor})).data.rows.map(r=>r.expeditionId)).toEqual([ownId].filter(id=>id>cursor));
  expect(available(await provider.expeditions(f.wallet,{kind:'starter',cursor:ownId})).data.rows.map(r=>r.expeditionId)).toEqual(ids().filter(id=>id>ownId).slice(0,PAGE));
  expect(available(await provider.expeditions(f.wallet,{kind:'advanced'})).data).toEqual({kind:'advanced',rows:[],nextCursor:null});
  noPrivateWire(await provider.expeditions(f.wallet,{kind:'starter'}),f.buyer);noPrivateWire(buyer,f.wallet);
 },120_000);

 it('serves starter history to a non-owner reader boundary while advanced history is not configured there',async()=>{
  const reader=await f.readerRole(),provider=f.provider(reader.db);
  expect(await walk(provider,f.wallet)).toEqual(ids());
  unavailable(await provider.expeditions(f.wallet,{kind:'advanced'}),'NOT_CONFIGURED');
  unavailable(await provider.inclusions(f.wallet),'NOT_CONFIGURED');unavailable(await provider.current(f.wallet),'NOT_CONFIGURED');
 },120_000);

 it('fails the whole page on a changed return and reports an unreachable source, never zeros or a partial list',async()=>{
  const provider=f.provider(),target=ids()[0]!;
  await f.shiftReturn(target,-1);
  try{
   unavailable(await provider.expeditions(f.wallet,{kind:'starter'}),'SOURCE_CONFLICT');
   expect(await walk(provider,f.wallet,target)).toEqual(ids().slice(1));
  }finally{await f.shiftReturn(target,1);}
  expect(available(await provider.expeditions(f.wallet,{kind:'starter'})).data.rows).toHaveLength(PAGE);
  const gone=f.conn.reopen();await gone.sql.end();
  unavailable(await f.provider(gone.db).expeditions(f.wallet,{kind:'starter'}),'SOURCE_UNAVAILABLE');
  for(const bad of [{kind:'paid'},{},{kind:'starter',cursor:target.toUpperCase()},{kind:'starter',cursor:'7'},{kind:'starter',wallet:f.wallet}])
   await expect(provider.expeditions(f.wallet,bad as never)).rejects.toBeInstanceOf(RealmPassportError);
  for(const wallet of ['not-a-wallet','1'.repeat(32),''])await expect(provider.expeditions(wallet,{kind:'starter'})).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(()=>f.provider(f.db,{identity:{genesisHash:f.wallet,programId:f.wallet,configAddress:f.wallet}})).toThrow('REALM_PASSPORT_IDENTITY');
 },120_000);
});

describe('advanced expedition history',()=>{
 let f:Awaited<ReturnType<typeof realmPassportAdvancedFixture>>;
 beforeAll(async()=>{for(const flag of REALM_PASSPORT_TEST_FLAGS)vi.stubEnv(flag,'true');f=await realmPassportAdvancedFixture();},300_000);
 afterAll(async()=>{vi.useRealTimers();vi.unstubAllEnvs();await f?.dispose();},120_000);
 it('exposes the settled advanced return with its original policy version and visited realm, excluding the accepted pending trip',async()=>{
  const tables=['advanced_expeditions','advanced_expedition_inflight','advanced_expedition_returns','advanced_expedition_entries','resource_stocks'];
  const before=await snapshotTables(f.sql,tables),provider=f.provider(),page=available(await provider.expeditions(f.wallet,{kind:'advanced'}));
  expect(RealmPassportExpeditionsResponseSchema.parse(page)).toEqual(page);
  const e=f.proof.expedition,snapshot=e.routeSnapshot as {realmId:string};
  expect(page.data).toEqual({kind:'advanced',nextCursor:null,rows:[{kind:'advanced',expeditionId:e.id,returnId:f.proof.receipt.id,originalBaseId:f.baseId,realmId:snapshot.realmId,routeId:'coastal_survey',
   routeVersion:null,policyVersion:1,departedAt:e.departedAt.toISOString(),scheduledReturnAt:e.returnsAt.toISOString(),returnedAt:f.proof.receipt.returnedAt.toISOString()}]});
  expect(page.data.rows[0]!.expeditionId).not.toBe(f.pending.id);
  expect(available(await provider.expeditions(outsider(),{kind:'advanced'})).data.rows).toEqual([]);
  expect(available(await provider.expeditions(f.wallet,{kind:'starter'})).data.rows).toEqual([]);
  expect(await f.sql`select expedition_id from advanced_expedition_returns where expedition_id=${f.pending.id}`).toHaveLength(0);
  expect(await snapshotTables(f.sql,tables)).toBe(before);noPrivateWire(page);
 },120_000);
});

describe('mining publication inclusions',()=>{
 it('projects this wallet\'s audited inclusions with verifiable proofs, carries leaves without inventing activity, pages by sequence and refuses a changed leaf as a whole page',async()=>withRealmPassportInclusionsFixture(async f=>{
  const before=await snapshotTables(f.sql,MINING_SOURCE_TABLES),provider=f.provider();
  const page=available(await provider.inclusions(f.wallet));expect(RealmPassportInclusionsResponseSchema.parse(page)).toEqual(page);
  expect(page.data.nextCursor).toBeNull();expect(page.data.rows.map(r=>r.sequence)).toEqual(['1','2']);
  for(const row of page.data.rows){
   const proven=await createMiningClaimEntitlementHistoryReader(f.db,f.identity,row.sequence)(f.wallet);if(proven.kind!=='entitlement')throw Error('fixture leaf missing');
   const h=proven.header;
   expect(row).toEqual({sequence:h.sequence,day:h.day,root:h.root,sourceHash:h.sourceHash,publicationSignature:h.publicationSignature,publicationSlot:h.publicationSlot,genesisHash:h.genesisHash,programId:h.programId,
    configAddress:h.configAddress,keepMint:h.keepMint,reserveOwner:h.reserveOwner,totalCumulativeBaseUnits:h.totalCumulative,
    leaf:{wallet:f.wallet,sequence:h.sequence,cumulativeKeepBaseUnits:proven.leaf.cumulativeKeep,cumulativeRenown:proven.leaf.cumulativeRenown,cumulativeDays:proven.leaf.cumulativeDays},proof:row.proof});
   expect(row.proof.length).toBeGreaterThan(0);
   expect(verifyMiningAllocationProof({wallet:row.leaf.wallet,cumulativeKeep:BigInt(row.leaf.cumulativeKeepBaseUnits),cumulativeRenown:BigInt(row.leaf.cumulativeRenown),cumulativeDays:BigInt(row.leaf.cumulativeDays),sequence:BigInt(row.leaf.sequence)},
    row.proof.map(n=>({hash:Buffer.from(n.hash,'hex'),sum:BigInt(n.sumBaseUnits),isLeft:n.isLeft})),Buffer.from(row.root,'hex'),BigInt(row.totalCumulativeBaseUnits))).toBe(true);
  }
  // Free-cohort publications carry zero renown/days by policy; the values are copied from the audited leaf, never derived from the day count.
  expect(BigInt(page.data.rows[1]!.leaf.cumulativeKeepBaseUnits)).toBeGreaterThan(BigInt(page.data.rows[0]!.leaf.cumulativeKeepBaseUnits));
  noPrivateWire(page,f.buyer);
  const carried=available(await provider.inclusions(f.buyer));expect(carried.data.rows.map(r=>r.sequence)).toEqual(['1','2']);
  expect(carried.data.rows[1]!.leaf).toEqual({...carried.data.rows[0]!.leaf,sequence:'2'});noPrivateWire(carried,f.wallet);
  expect(available(await provider.inclusions(f.wallet,{cursor:'1'})).data.rows.map(r=>r.sequence)).toEqual(['2']);
  expect(available(await provider.inclusions(f.wallet,{cursor:'2'})).data).toEqual({rows:[],nextCursor:null});
  expect(available(await provider.inclusions(outsider())).data).toEqual({rows:[],nextCursor:null});
  // A domain with no projected publication at all is an unavailable source, never an empty history.
  unavailable(await f.provider({identity:{...f.identity,genesisHash:outsider()}}).inclusions(f.wallet),'SOURCE_UNAVAILABLE');
  for(const bad of [{cursor:'0'},{cursor:'01'},{cursor:1},{kind:'starter'}])await expect(provider.inclusions(f.wallet,bad as never)).rejects.toMatchObject({code:'INVALID_INPUT'});
  unavailable(await f.provider(null).inclusions(f.wallet),'NOT_CONFIGURED');unavailable(await provider.current(f.wallet),'NOT_CONFIGURED');
  // Immutable history stays independent of the current provider: a disabled or failing assessment never hides a saved page.
  const disabled=async(wallet:string):Promise<MiningClaimAssessment>=>({status:{state:'unavailable',wallet,reason:'DISABLED',decimals:9,preparationAllowed:false,claimSubmissionAuthorized:false}});
  const paused=f.provider({identity:f.identity,assess:disabled});unavailable(await paused.current(f.wallet),'NOT_CONFIGURED');expect(available(await paused.inclusions(f.wallet)).data.rows).toHaveLength(2);
  const failing=f.provider({identity:f.identity,assess:async()=>{throw Error('offline');}});unavailable(await failing.current(f.wallet),'SOURCE_UNAVAILABLE');expect(available(await failing.inclusions(f.wallet)).data.rows).toHaveLength(2);
  expect(await snapshotTables(f.sql,MINING_SOURCE_TABLES)).toBe(before);
  await f.corruptLeaf(f.wallet,'2');
  unavailable(await provider.inclusions(f.wallet),'SOURCE_CONFLICT');
  expect(available(await provider.inclusions(f.buyer)).data.rows).toHaveLength(2);
  expect(available(await provider.inclusions(f.wallet,{cursor:'2'})).data.rows).toEqual([]);
 }),240_000);
});

describe('current published versus attested record',()=>{
 it('supplies facts only from a verified positive assessment, separates the published leaf from the attested chain record, and is unavailable otherwise',async()=>withRealmPassportCurrentFixture(async f=>{
  const provider=f.provider(),proven=await createMiningClaimEntitlementHistoryReader(f.db,f.identity,'1')(f.wallet);if(proven.kind!=='entitlement')throw Error('fixture leaf missing');
  const ready=available(await provider.current(f.wallet));expect(RealmPassportCurrentResponseSchema.parse(ready)).toEqual(ready);
  expect(ready.data).toEqual({observedSlot:3000,chainUnixTimestamp:(BigInt(f.fixture.prepared.publication.day)*86_400n+86_400n+BigInt((await import('@shardkeep/shared')).PHASE_E_MINING_PUBLICATION.claimDelaySec)).toString(),
   publicationSequence:'1',published:{cumulativeRenown:proven.leaf.cumulativeRenown,cumulativeDays:proven.leaf.cumulativeDays},attested:null});
  noPrivateWire(ready,f.buyer);
  // A zero-initialised chain record is a real attested record, reported apart from the published leaf; it is never merged into it.
  await f.bank.records();const recorded=available(await provider.current(f.wallet));
  expect(recorded.data.attested).toEqual({renownTotal:'0',daysAttested:'0',lastSequence:'0'});expect(recorded.data.published).toEqual(ready.data.published);
  f.bank.renown.renown_total=BigInt(proven.leaf.cumulativeRenown);f.bank.renown.days_attested=BigInt(proven.leaf.cumulativeDays);f.bank.renown.last_sequence=1n;f.bank.miner.last_sequence=1n;await f.bank.records();
  const synced=available(await provider.current(f.wallet));expect(synced.data.attested).toEqual({renownTotal:proven.leaf.cumulativeRenown,daysAttested:proven.leaf.cumulativeDays,lastSequence:'1'});
  // Every positive assessment state supplies the same facts: the real claim-pause bit, the pre-delay clock and a fully claimed cursor change nothing here.
  await f.bank.config({flags:1});expect(available(await provider.current(f.wallet)).data).toEqual(synced.data);await f.bank.config({flags:0});
  const after=BigInt(synced.data.chainUnixTimestamp);f.bank.clock(after-1n);expect(available(await provider.current(f.wallet)).data).toEqual({...synced.data,chainUnixTimestamp:(after-1n).toString()});f.bank.clock(after);
  f.bank.miner.claimed_total=BigInt(proven.leaf.cumulativeKeep);await f.bank.records();await f.bank.config({total_claimed:BigInt(proven.leaf.cumulativeKeep)});expect(available(await provider.current(f.wallet)).data).toEqual(synced.data);
  f.bank.renown.days_attested=BigInt(proven.leaf.cumulativeDays)+1n;await f.bank.records();unavailable(await provider.current(f.wallet),'SOURCE_CONFLICT');
  f.bank.renown.days_attested=BigInt(proven.leaf.cumulativeDays);await f.bank.records();
  unavailable(await provider.current(outsider()),'SOURCE_UNAVAILABLE');
  await f.bank.config({latest_sequence:2n});unavailable(await provider.current(f.wallet),'SOURCE_UNAVAILABLE');await f.bank.config({latest_sequence:1n});
  await f.bank.allocation({revoked:true});unavailable(await provider.current(f.wallet),'SOURCE_UNAVAILABLE');await f.bank.allocation({revoked:false});
  const root=f.fixture.chain.models[2]!['root'];await f.bank.allocation({root:Buffer.alloc(32,93)});unavailable(await provider.current(f.wallet),'SOURCE_CONFLICT');await f.bank.allocation({root});
  expect(available(await provider.current(f.wallet)).data.publicationSequence).toBe('1');
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');unavailable(await provider.current(f.wallet),'NOT_CONFIGURED');vi.unstubAllEnvs();
  unavailable(await f.provider({identity:{...f.identity,genesisHash:outsider()},assess:f.assess}).current(f.wallet),'SOURCE_CONFLICT');
  unavailable(await f.provider({identity:f.identity}).current(f.wallet),'NOT_CONFIGURED');
  expect(available(await f.provider({identity:f.identity}).inclusions(f.wallet)).data.rows.map(r=>r.sequence)).toEqual(['1']);
  await expect(provider.current('not-a-wallet')).rejects.toMatchObject({code:'INVALID_INPUT'});
 }),240_000);
 it('shows nonzero published renown/days from the funded day-two leaf apart from the lagging day-one attested record, with matching inclusions',async()=>withRealmPassportFundedFixture(async f=>{
  const provider=f.provider(),history=available(await provider.inclusions(f.wallet));
  expect(history.data.rows.map(r=>[r.sequence,r.leaf.cumulativeRenown,r.leaf.cumulativeDays])).toEqual([['1','1','1'],['2','2','2']]);
  for(const row of history.data.rows)expect(verifyMiningAllocationProof({wallet:row.leaf.wallet,cumulativeKeep:BigInt(row.leaf.cumulativeKeepBaseUnits),cumulativeRenown:BigInt(row.leaf.cumulativeRenown),cumulativeDays:BigInt(row.leaf.cumulativeDays),sequence:BigInt(row.leaf.sequence)},
   row.proof.map(n=>({hash:Buffer.from(n.hash,'hex'),sum:BigInt(n.sumBaseUnits),isLeft:n.isLeft})),Buffer.from(row.root,'hex'),BigInt(row.totalCumulativeBaseUnits))).toBe(true);
  const record=f.claim.postSnapshot.renownRecord;if(!record)throw Error('fixture claim left no chain record');
  expect(record).toMatchObject({renownTotal:1n,daysAttested:1n,lastSequence:1n});
  const current=available(await provider.current(f.wallet));expect(RealmPassportCurrentResponseSchema.parse(current)).toEqual(current);
  expect(current.data).toEqual({observedSlot:f.observedSlot,chainUnixTimestamp:f.chainUnixTimestamp,publicationSequence:'2',published:{cumulativeRenown:'2',cumulativeDays:'2'},attested:{renownTotal:'1',daysAttested:'1',lastSequence:'1'}});
  noPrivateWire(current,f.buyer);
  // The buyer's paid history is its own; the free wallet's page never carries it and vice versa.
  const paid=available(await provider.inclusions(f.buyer));expect(paid.data.rows.map(r=>r.leaf.wallet)).toEqual([f.buyer,f.buyer]);noPrivateWire(paid,f.wallet);
 }),300_000);
});
