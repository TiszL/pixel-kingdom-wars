/** Actual account bytes and signed synthetic settlements; injected finality is
 * local fixture authority, not a live-chain/provider-independence assertion. */
import {Keypair,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {afterEach,expect,it,vi} from 'vitest';
import {createMiningTermFixture} from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {createDivineFragmentTermSource,readDivineFragmentHistoricalTerm,type DivineFragmentTermSource} from '../src/game/divineFragmentTermReader';
const earnedAt='2035-01-01T00:00:00.000Z';
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
async function fixture(zero=false){
 const owner=Keypair.generate().publicKey;
 const f=await createMiningTermFixture({day:'2035-01-01',round:7n,programId:Keypair.generate().publicKey,genesisHash:Keypair.generate().publicKey,winners:zero?[]:[{spotId:0,wallet:owner}]});
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2035-01-02T00:00:00.000Z'));
 const connect=vi.fn((signal:AbortSignal)=>{signal.throwIfAborted();return f.rpc;});
 return {...f,owner,connect,source:createDivineFragmentTermSource(connect,f.policy)};
}
it('reads the original finalized term using its actual signed settlements, even after operating expiry',async()=>{
 const f=await fixture();vi.setSystemTime(new Date('2035-02-01T00:00:00.000Z'));
 f.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(Date.now()/1000),32);
 const proof=await readDivineFragmentHistoricalTerm(f.source,earnedAt,f.policy.genesisHash.toBase58());
 expect(proof.snapshot.source.round).toBe('7');expect(proof.snapshot.spots[0]!.ownerWallet).toBe(f.owner.toBase58());
 expect(proof.completedAt).toBe(earnedAt);expect(proof.operatingAdmissionAuthorized).toBe(false);expect(Object.isFrozen(proof)).toBe(true);
});
it('requires the same complete finalized evidence to establish a zero-winner term',async()=>{
 const f=await fixture(true),proof=await readDivineFragmentHistoricalTerm(f.source,earnedAt,f.policy.genesisHash.toBase58());
 expect(proof.snapshot.spots.every(s=>s.ownerWallet===null)).toBe(true);
 f.bodies.clear();await expect(readDivineFragmentHistoricalTerm(f.source,earnedAt,f.policy.genesisHash.toBase58())).rejects.toThrow();
});
it('refuses a lookalike or cloned source before any RPC, preventing certificate callback injection',async()=>{
 const f=await fixture();
 for(const source of [{...f.source},{read:()=>({snapshot:{}})},null]){
  await expect(readDivineFragmentHistoricalTerm(source as unknown as DivineFragmentTermSource,earnedAt,f.policy.genesisHash.toBase58())).rejects.toThrow('DIVINE_FRAGMENT_TERM_SOURCE');
 }
 expect(f.connect).not.toHaveBeenCalled();
});
it('refuses an economy genesis mismatch before requesting chain evidence',async()=>{
 const f=await fixture();await expect(readDivineFragmentHistoricalTerm(f.source,earnedAt,Keypair.generate().publicKey.toBase58())).rejects.toThrow('DIVINE_FRAGMENT_TERM_DOMAIN');expect(f.connect).not.toHaveBeenCalled();
});
it('retains privately copied policy pins when the caller changes its input after construction',async()=>{
 const f=await fixture(),genesis=f.policy.genesisHash.toBase58();
 Object.assign(f.policy,{config:Keypair.generate().publicKey});Object.assign(f.policy.deployment,{programDataSha256:'0'.repeat(64)});
 expect((await readDivineFragmentHistoricalTerm(f.source,earnedAt,genesis)).snapshot.source.round).toBe('7');
});
it('does not accept changed program bytes under a saved source configuration',async()=>{
 const f=await fixture();const bytes=f.store.get(f.programDataAddress.toBase58())!.data;bytes[48]=bytes[48]!^1;
 await expect(readDivineFragmentHistoricalTerm(f.source,earnedAt,f.policy.genesisHash.toBase58())).rejects.toThrow();
});
it.each(['2035-01-01','2035-01-01T00:00:00Z','2035-01-01T00:00:00.000+00:00','2035-02-30T00:00:00.000Z'])('rejects a noncanonical earning time %s before RPC',async at=>{
 const f=await fixture();await expect(readDivineFragmentHistoricalTerm(f.source,at,f.policy.genesisHash.toBase58())).rejects.toThrow();expect(f.connect).not.toHaveBeenCalled();
});
it('never substitutes a later completed term for earning before the original completion',async()=>{
 const f=await fixture();await expect(readDivineFragmentHistoricalTerm(f.source,'2034-12-31T23:59:59.999Z',f.policy.genesisHash.toBase58())).rejects.toThrow();
});
