import {randomUUID} from 'node:crypto';
import {CLANS,PHASE_E_POLICY} from '@shardkeep/shared';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createClanCharterMemberFences} from '../src/game/clanCharterMemberFences';
import {createClanCharterMemberSettlement} from '../src/game/clanCharterMemberSettlement';
import {transferStableBase} from '../src/game/baseOwnership';
import {clanChestInvariantHolds,joinClan,kickMember,leaveClan} from '../src/game/clans';
import {memberSettlementFixture,type MemberSettlementFixture} from './fixtures/clanCharterMemberSettlement';
let f:MemberSettlementFixture|undefined;
beforeEach(async()=>{f=await memberSettlementFixture();},120_000);
afterEach(async()=>{try{await f?.close();}finally{f=undefined;vi.restoreAllMocks();vi.unstubAllEnvs();}},120_000);
const held=(suffix:string)=>({code:'CLAN_CHARTER_MEMBER_SETTLEMENT_'+suffix});
const noAuthority={signingAuthorized:false,transferAuthorized:false,fenceReleaseAuthorized:false};
const gross=()=>BigInt(PHASE_E_POLICY.basisPoints);

it('distributes the entire backed chest and deterministic remainder to frozen members without transfer authority',async()=>{
 const c=f!,s=await c.source({grossBefore:gross()}),total=BigInt(CLANS.chestTitheBps),before=new Map(await Promise.all(c.receivers.map(async r=>[r.wallet,await c.balance(r.accountId)] as const)));
 const paid=await c.service().settle(s.leader.wallet,s.fence.fenceId);
 expect(paid).toMatchObject({id:expect.any(String),fenceId:s.fence.fenceId,clanId:s.clan.id,actorWallet:s.leader.wallet,totalShards:total.toString(),ledgerTransactionId:expect.any(String),...noAuthority});
 const wallets=s.roster.map(r=>r.wallet).sort();expect(paid.allocations.map(a=>a.wallet)).toEqual(wallets);
 for(const [i,wallet] of wallets.entries()){
  const r=c.receivers.find(r=>r.wallet===wallet)!,amount=total/BigInt(wallets.length)+(BigInt(i)<total%BigInt(wallets.length)?1n:0n);
  expect(paid.allocations[i]).toMatchObject({wallet,baseId:r.baseId,accountId:r.accountId,shards:amount.toString()});expect(await c.balance(r.accountId)).toBe(before.get(wallet)!+amount);
 }
 expect(await c.sql`select chest_shards::text from clans where id=${s.clan.id}`).toEqual([{chest_shards:'0'}]);expect(await clanChestInvariantHolds(c.db)).toBe(true);
 const reopened=c.reopen();try{expect(await createClanCharterMemberSettlement(reopened.db).read(s.leader.wallet,s.fence.fenceId)).toEqual(paid);}finally{await reopened.sql.end();}
 expect((await createClanCharterMemberFences(c.db).read(s.fence.fenceId)).members).toEqual(s.fence.members);
});

it('waits for actual late pre-fence loot then pays it once without double-counting earlier settled credits',async()=>{
 const c=f!,s=await c.source({grossBefore:gross(),pending:true,settledBefore:gross()}),before=await c.snapshot();
 await expect(c.service().settle(s.leader.wallet,s.fence.fenceId)).rejects.toMatchObject(held('SOURCE'));expect(await c.snapshot()).toBe(before);
 await c.settle(s.raid!.id,gross());await c.refresh();const paid=await c.service().settle(s.leader.wallet,s.fence.fenceId);
 expect(s.fence.chestShards).toBe(String(CLANS.chestTitheBps));expect(paid.totalShards).toBe(String(CLANS.chestTitheBps*2));expect(paid.allocations.reduce((n,a)=>n+BigInt(a.shards),0n)).toBe(BigInt(CLANS.chestTitheBps)*2n);
 expect(await clanChestInvariantHolds(c.db)).toBe(true);
});

it.each([true,false])('records zero chest completion with eligible members=%s without a fake posting and keeps the fence active',async eligible=>{
 const c=f!,s=await c.source({grossBefore:0n,eligible}),before=await c.sql`select count(*)::int n from ledger_transactions`;
 const paid=await c.service().settle(s.leader.wallet,s.fence.fenceId);expect(paid).toMatchObject({totalShards:'0',ledgerTransactionId:null,...noAuthority});
 expect(c.reader).not.toHaveBeenCalled();
 expect(paid.allocations).toHaveLength(eligible?s.roster.length:0);
 expect(paid.allocations.every(a=>a.shards==='0'&&a.entryId===null)).toBe(true);expect(await c.sql`select count(*)::int n from ledger_transactions`).toEqual(before);
 await expect(kickMember(c.db,s.leader.wallet,s.roster[1]!.wallet)).rejects.toThrow();expect(await c.service().read(s.leader.wallet,s.fence.fenceId)).toEqual(paid);
});

it('holds even a zero baseline without an actual prospective B6p head',async()=>{
 const c=f!,s=await c.source({head:false}),before=await c.snapshot();await expect(c.service().settle(s.leader.wallet,s.fence.fenceId)).rejects.toMatchObject(held('SOURCE'));expect(await c.snapshot()).toBe(before);
});

it('returns the exact paid receipt on paused replay without paying twice or rechecking current destination ownership',async()=>{
 const c=f!,s=await c.source(),paid=await c.service().settle(s.leader.wallet,s.fence.fenceId);
 vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');vi.stubEnv('MULTI_BASE_ENABLED','false');
 const before=await c.snapshot(),offline=createClanCharterMemberSettlement(c.db);
 expect(await offline.settle(s.leader.wallet,s.fence.fenceId)).toEqual(paid);expect(await offline.read(s.leader.wallet,s.fence.fenceId)).toEqual(paid);expect(await c.snapshot()).toBe(before);
 await expect(offline.read(s.roster[1]!.wallet,s.fence.fenceId)).rejects.toMatchObject(held('NOT_FOUND'));
 await expect(offline.read(s.leader.wallet,randomUUID())).rejects.toMatchObject(held('NOT_FOUND'));
});

it('keeps post-payment positive credits and ordinary member extraction fenced',async()=>{
 const c=f!,s=await c.source(),paid=await c.service().settle(s.leader.wallet,s.fence.fenceId),before=await c.snapshot();
 await expect(c.sql`update clans set chest_shards=chest_shards+1 where id=${s.clan.id}`).rejects.toThrow();
 await expect(kickMember(c.db,s.leader.wallet,s.roster[1]!.wallet)).rejects.toThrow();await expect(leaveClan(c.db,s.roster[1]!.wallet)).rejects.toThrow();
 // No new funded player is needed: an existing member cannot use a redundant
 // join or leader mutation to escape the frozen membership rule.
 await expect(joinClan(c.db,s.roster[1]!.wallet,s.clan.id)).rejects.toThrow();
 expect(await c.snapshot()).toBe(before);expect(await c.service().read(s.leader.wallet,s.fence.fenceId)).toEqual(paid);
});

it('preserves every unit when the chest is smaller than the frozen eligible roster',async()=>{
 const c=f!,smallGross=(gross()+BigInt(CLANS.chestTitheBps)-1n)/BigInt(CLANS.chestTitheBps),s=await c.source({grossBefore:smallGross});
 const paid=await c.service().settle(s.leader.wallet,s.fence.fenceId),wallets=s.roster.map(m=>m.wallet).sort();
 expect(paid.totalShards).toBe('1');expect(paid.allocations.map(a=>[a.wallet,a.shards])).toEqual(wallets.map((wallet,i)=>[wallet,i===0?'1':'0']));
 expect(c.reader).toHaveBeenCalledTimes(1);
 expect(paid.allocations.filter(a=>a.entryId!==null)).toHaveLength(1);
 expect(await c.sql`select delta::text from ledger_entries where txn_id=${paid.ledgerTransactionId} order by delta`).toEqual([{delta:'-1'},{delta:'1'}]);
 expect(await clanChestInvariantHolds(c.db)).toBe(true);
});

it('holds the entire positive chest when no original member was eligible, even if a destination later becomes paid',async()=>{
 const c=f!,s=await c.source({eligible:false});expect(s.fence.members.every(m=>!m.eligibilityAtFence)).toBe(true);
 await c.sql`update bases set land_paid_at=now() where id=${c.receivers[0]!.baseId}`;const before=await c.snapshot();
 await expect(c.service().settle(s.leader.wallet,s.fence.fenceId)).rejects.toMatchObject(held('SOURCE'));expect(await c.snapshot()).toBe(before);
});

it.each(['missing','stale','frozen','foreign'] as const)('holds everyone when a positive-share destination has %s finalized authority',async mode=>{
 // Each case starts from authentic ownership. A foreign finalized observation
 // really transfers the base and removes its slot; replaying an older observation
 // must not undo that custody change merely to prepare the next refusal case.
 const c=f!,s=await c.source(),target=c.receivers[1]!,current=c.proofs.get(target.deed)!,before=await c.snapshot();
 const invalid=mode==='missing'?null:mode==='stale'?{...current,slot:current.slot-1}:
  mode==='frozen'?{...current,frozen:true,slot:current.slot+1}:{...current,owner:s.leader.wallet,slot:current.slot+1};
 c.reader.mockImplementation(async asset=>asset===target.deed?invalid:c.proofs.get(asset)??null);
 await expect(c.service().settle(s.leader.wallet,s.fence.fenceId)).rejects.toMatchObject(held('DESTINATION'));
 expect(c.reader).toHaveBeenCalledWith(target.deed,current.slot);expect(await c.snapshot()).toBe(before);
});

it('rejects a global attribution mismatch rather than using the target clan balance alone',async()=>{
 const c=f!,outsider=await c.funded(),other=await c.clan(outsider.wallet),s=await c.source();
 await c.sql`update clans set chest_shards=chest_shards+1 where id=${other.id}`;expect(await clanChestInvariantHolds(c.db)).toBe(false);const before=await c.snapshot();
 await expect(c.service().settle(s.leader.wallet,s.fence.fenceId)).rejects.toMatchObject(held('SOURCE'));expect(await c.snapshot()).toBe(before);
});

it('pays the original member on an alternate currently owned base after an actual historical-deed sale, never its buyer',async()=>{
 const c=f!,s=await c.source(),original=c.receivers[1]!,buyer=await c.funded(),donor=await c.funded(),alternative=await c.receiver(donor.wallet);
 const transfer=async(base:typeof original,from:string,to:string,slot:number)=>{
  const proof={owner:to,collection:c.collection,frozen:false as const,delegate:null,slot};
  await transferStableBase(c.db,base.baseId,from,to,base.deed,{...proof,observedAtMs:Date.now()});c.proofs.set(base.deed,proof);
 };
 await transfer(original,original.wallet,buyer.wallet,101);await transfer(alternative,donor.wallet,original.wallet,102);c.enabled();
 const originalBefore=await c.balance(original.accountId),alternativeBefore=await c.balance(alternative.accountId);
 const paid=await c.service().settle(s.leader.wallet,s.fence.fenceId),allocation=paid.allocations.find(a=>a.wallet===original.wallet)!;
 expect(allocation.baseId).toBe(alternative.baseId);expect(await c.balance(original.accountId)).toBe(originalBefore);expect(await c.balance(alternative.accountId)).toBe(alternativeBefore+BigInt(allocation.shards));
 expect(paid.allocations.some(a=>a.wallet===buyer.wallet||a.wallet===donor.wallet)).toBe(false);
 await transfer(alternative,original.wallet,buyer.wallet,103);expect(await c.service().read(s.leader.wallet,s.fence.fenceId)).toEqual(paid);
});

it('commits at most one payout under concurrent calls and reopens the same durable result for a held caller',async()=>{
 const c=f!,s=await c.source(),a=c.service(),b=c.service(),results=await Promise.allSettled([a.settle(s.leader.wallet,s.fence.fenceId),b.settle(s.leader.wallet,s.fence.fenceId)]);
 const successes=results.filter((r):r is PromiseFulfilledResult<Awaited<ReturnType<typeof a.settle>>>=>r.status==='fulfilled');expect(successes.length).toBeGreaterThan(0);
 const paid=successes[0]!.value;for(const r of successes)expect(r.value).toEqual(paid);
 for(const r of results)if(r.status==='rejected')expect(r.reason).toMatchObject(held('BUSY'));
 const before=await c.snapshot();expect(await a.settle(s.leader.wallet,s.fence.fenceId)).toEqual(paid);expect(await b.read(s.leader.wallet,s.fence.fenceId)).toEqual(paid);expect(await c.snapshot()).toBe(before);
 expect(await c.sql`select count(*)::int n from ledger_transactions where id=${paid.ledgerTransactionId}`).toEqual([{n:1}]);expect(await clanChestInvariantHolds(c.db)).toBe(true);
});
