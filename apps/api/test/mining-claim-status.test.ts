/** A settled two-player publication plus current raw chain accounts determines
 * readiness; neither the saved root nor a missing provider is a balance. */
import { Keypair,PublicKey } from '@solana/web3.js';
import { describe,it,expect,vi } from 'vitest';
import { PHASE_E_MINING_PUBLICATION as POLICY } from '@shardkeep/shared';
import { createMiningClaimFixture } from '../../../packages/chain/src/testFixtures/miningClaim';
import type { MiningClaimSnapshotReader } from '@shardkeep/chain/mining-claim-snapshot';
import { projectMiningClaimEntitlements } from '../src/mining/claimEntitlement';
import { createMiningClaimReader } from '../src/mining/claimStatus';
import { withMiningClaimEntitlementFixture, type MiningClaimEntitlementFixture } from './fixtures/miningClaimEntitlement';

async function currentBank(f:MiningClaimEntitlementFixture,wallet=f.wallet){
 const bank=await createMiningClaimFixture({wallet:new PublicKey(wallet),day:'2020-01-01'});
 for(let i=0;i<8;i++)bank.rows[i]={...f.backing.rows[i]!,data:Buffer.from(f.backing.rows[i]!.data)};
 const clock=bank.rows[7]!.data as Buffer;clock.writeBigUInt64LE(3000n);clock.writeBigInt64LE(BigInt(f.prepared.publication.day)*BigInt(POLICY.daySec)+BigInt(POLICY.daySec+POLICY.claimDelaySec),32);
 function sync(){bank.rows[0]=f.chain.accounts[0]!;bank.rows[8]=f.chain.accounts[2]!;bank.rows[9]=f.chain.accounts[1]!;}
 sync();
 for(const [i,which] of [[1,0],[2,1]] as const){// Classic SPL amount is the u64 at byte64. Keep all other serialized fields.
  (bank.rows[i]!.data as Buffer).writeBigUInt64LE(BigInt(f.chain.tx.meta!.postTokenBalances![which]!.uiTokenAmount.amount),64);}
 let reads=0;const reader:MiningClaimSnapshotReader={getGenesisHash:async()=>f.identity.genesisHash,getSlot:async()=>3000,getMultipleAccountsInfoAndContext:async()=>{reads++;return {context:{slot:3000},value:bank.rows};}};
 return {...bank,reader,trust:f.chain.trusted,sync,clock:(at:bigint)=>clock.writeBigInt64LE(at,32),reads:()=>reads,
  async config(change:Record<string,unknown>){Object.assign(f.chain.models[0]!,change);await f.chain.encode(0);sync();},
  async allocation(change:Record<string,unknown>){Object.assign(f.chain.models[2]!,change);await f.chain.encode(2);sync();}};
}
async function fixture(run:(f:MiningClaimEntitlementFixture,b:Awaited<ReturnType<typeof currentBank>>)=>Promise<void>){return withMiningClaimEntitlementFixture(async f=>{await f.settle();await projectMiningClaimEntitlements(f.conn.db,{epochId:f.epochId});await run(f,await currentBank(f));});}
describe('current authenticated-wallet mining claim status',()=>{
 it('exposes only this wallet amount after the real projection and fresh finalized snapshot, with no signing authority',async()=>fixture(async(f,b)=>{
  const read=createMiningClaimReader(f.conn.db,b),result=await read.status(f.wallet);
  expect(result).toMatchObject({state:'ready',wallet:f.wallet,sequence:'1',observedSlot:3000,preparationAllowed:true,claimSubmissionAuthorized:false,needsMinerRecords:true,needsAta:false});
  expect(BigInt(result.amountBaseUnits!)).toBeGreaterThan(0n);expect(BigInt(result.amountBaseUnits!)).toBeLessThan(BigInt(f.prepared.publication.total));
  expect(JSON.stringify(result)).not.toContain(f.buyer);expect(result).not.toHaveProperty('projection');expect(result).not.toHaveProperty('snapshot');expect(b.reads()).toBe(1);
 }));
 it('treats unpublished or unprojected membership as unavailable, not zero',async()=>withMiningClaimEntitlementFixture(async f=>{
  const b=await currentBank(f),result=await createMiningClaimReader(f.conn.db,b).status(f.wallet);
  expect(result).toMatchObject({state:'unavailable',reason:'NOT_PROJECTED'});expect(result.amountBaseUnits).toBeUndefined();expect(b.reads()).toBe(0);
 }));
 it('proves a nonmember zero only after checking the complete root against the current frontier',async()=>fixture(async(f)=>{
  const outsider=Keypair.generate().publicKey.toBase58(),b=await currentBank(f,outsider),read=createMiningClaimReader(f.conn.db,b);
  expect(await read.status(outsider)).toMatchObject({state:'no_allocation',amountBaseUnits:'0',preparationAllowed:false});
  await b.config({latest_sequence:2n});expect(await read.status(outsider)).toMatchObject({state:'unavailable',reason:'UNSUPPORTED_FRONTIER'});
 }));
 it('uses chain Clock for the exact delay boundary and distinguishes the claim pause from publisher pause',async()=>fixture(async(f,b)=>{
  const read=createMiningClaimReader(f.conn.db,b),after=BigInt(f.prepared.publication.day)*BigInt(POLICY.daySec)+BigInt(POLICY.daySec+POLICY.claimDelaySec);
  b.clock(after-1n);expect(await read.status(f.wallet)).toMatchObject({state:'delayed',claimableAfterUnixTimestamp:after.toString(),preparationAllowed:false});
  b.clock(after);await b.config({flags:2});expect(await read.status(f.wallet)).toMatchObject({state:'ready'});
  await b.config({flags:1});expect(await read.status(f.wallet)).toMatchObject({state:'paused',preparationAllowed:false});
 }));
 it('reports revoked roots without treating a saved finalized receipt as a current claim',async()=>fixture(async(f,b)=>{
  await b.allocation({revoked:true});await b.config({total_published:0n,correction_pending:true});
  expect(await createMiningClaimReader(f.conn.db,b).status(f.wallet)).toMatchObject({state:'revoked',preparationAllowed:false});
 }));
 it('subtracts the permanent wallet cursor once and reports already claimed without inventing a signature',async()=>fixture(async(f,b)=>{
  const read=createMiningClaimReader(f.conn.db,b),first=await read.status(f.wallet),total=BigInt(first.amountBaseUnits!);
  b.miner.claimed_total=total-1n;b.miner.last_sequence=1n;b.renown.last_sequence=1n;await b.records();await b.config({total_claimed:total-1n});
  expect(await read.status(f.wallet)).toMatchObject({state:'ready',amountBaseUnits:'1',alreadyClaimedBaseUnits:(total-1n).toString()});
  b.miner.claimed_total=total;await b.records();await b.config({total_claimed:total});
  const claimed=await read.status(f.wallet);expect(claimed).toMatchObject({state:'claimed',amountBaseUnits:'0',preparationAllowed:false});expect(claimed).not.toHaveProperty('signature');
 }));
 it('keeps missing setup accounts explicit instead of inventing a SOL or token balance',async()=>fixture(async(f,b)=>{
  b.rows[12]=null;b.rows[13]=null;const assessment=await createMiningClaimReader(f.conn.db,b).assess(f.wallet);
  expect(assessment.status).toMatchObject({state:'ready',needsAta:true,needsMinerRecords:true});expect(assessment.snapshot?.payer).toMatchObject({exists:false,lamports:null});
 }));
 it('refuses a substituted allocation even when its metadata is internally well formed',async()=>fixture(async(f,b)=>{
  await b.allocation({root:Buffer.alloc(32,93)});expect(await createMiningClaimReader(f.conn.db,b).status(f.wallet)).toMatchObject({state:'unavailable',reason:'SOURCE_CONFLICT'});
 }));
 it('refuses partial cursors and unavailable provider evidence without converting either to zero',async()=>fixture(async(f,b)=>{
  await b.records();b.rows[11]=null;const read=createMiningClaimReader(f.conn.db,b);expect(await read.status(f.wallet)).toMatchObject({state:'unavailable'});
  b.rows[10]=null;b.reader.getGenesisHash=async()=>{throw Error('offline');};const result=await read.status(f.wallet);expect(result).toMatchObject({state:'unavailable',reason:'SOURCE_UNAVAILABLE'});expect(result.amountBaseUnits).toBeUndefined();
 }));
 it('does not query sources while disabled or for an invalid authenticated key and rechecks pause after the bank read',async()=>fixture(async(f,b)=>{
  const read=createMiningClaimReader(f.conn.db,b);expect(await read.status('not-a-wallet')).toMatchObject({reason:'INVALID_WALLET'});
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');expect(await read.status(f.wallet)).toMatchObject({reason:'DISABLED'});expect(b.reads()).toBe(0);
  vi.stubEnv('PHASE_E_MINING_ENABLED','true');const original=b.reader.getMultipleAccountsInfoAndContext;b.reader.getMultipleAccountsInfoAndContext=async(...a)=>{const r=await original(...a);vi.stubEnv('PHASE_E_MINING_ENABLED','false');return r;};
  expect(await read.status(f.wallet)).toMatchObject({reason:'DISABLED'});
 }));
 it('times out once while retaining the pending wallet slot, then discards the late result and permits a fresh read',async()=>fixture(async(f,b)=>{
  let resume!:(v:string)=>void;const pending=new Promise<string>(resolve=>{resume=resolve;});const original=b.reader.getGenesisHash;let calls=0;b.reader.getGenesisHash=()=>{calls++;return pending;};
  const read=createMiningClaimReader(f.conn.db,{...b,timeoutMs:20});const [a,c]=await Promise.all([read.status(f.wallet),read.status(f.wallet)]);expect(a).toMatchObject({state:'unavailable',reason:'TIMEOUT'});expect(c).toEqual(a);expect(calls).toBe(1);
  expect(await read.status(f.wallet)).toEqual(a);expect(calls).toBe(1);b.reader.getGenesisHash=original;resume(f.identity.genesisHash);
  await vi.waitFor(()=>expect(b.reads()).toBe(1));expect(await read.status(f.wallet)).toMatchObject({state:'ready'});expect(b.reads()).toBe(2);
 }));
});
