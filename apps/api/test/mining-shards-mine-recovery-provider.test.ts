/** Capability boundary only; mocked resolver establishes no source authority. */
import {randomUUID} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {beforeEach,expect,it,vi} from 'vitest';
import type {Db} from '../src/db/client';
import type {ReviewedSeekerSourcePolicy,SeekerTermRpc} from '@shardkeep/chain/seeker-terms';
import {createPhysicalMineRecoveryProvider} from '../src/mining/shardsTaxMineRecoveryProvider';
const calls=vi.hoisted(()=>({resolve:vi.fn(),capture:vi.fn(),original:vi.fn()}));
vi.mock('../src/mining/shardsTaxMineResolution',()=>({resolvePhysicalMineTaxSource:calls.resolve}));
vi.mock('../src/mining/shardsTaxMineFullCapture',()=>({captureFullPhysicalMineSources:calls.capture,capturePhysicalMineSources:calls.original}));
beforeEach(()=>{calls.resolve.mockReset();calls.capture.mockReset();calls.original.mockReset();});
const key=(n:number)=>new PublicKey(new Uint8Array(32).fill(n));
function fixture(){
 const policy:ReviewedSeekerSourcePolicy={genesisHash:key(201),programId:key(202),config:key(203),mint:key(204),prizeOwner:key(205),prizeAta:key(206),stateProvenance:'fresh-reviewed-deployment',deployment:{programDataAddress:key(207).toBase58(),programDataSha256:'ab'.repeat(32),upgradeAuthority:null}};
 const db={marker:'owner-only'} as unknown as Db,connect=vi.fn(()=>{throw Error('mock boundary must not connect');}) as (signal:AbortSignal)=>SeekerTermRpc;
 const clock=()=>new Date('2035-01-16T00:00:00Z');return {policy,db,connect,clock};
}
it('exposes only bounded capture and source repair and discards private evidence returned by the owner resolver',async()=>{
 const f=fixture(),id=randomUUID(),provider=createPhysicalMineRecoveryProvider(f.db,{historicalTerm:{connect:f.connect,policy:f.policy},clock:f.clock});
 calls.resolve.mockResolvedValue({privateEvidence:'not an HTTP return value'});
 expect(Object.keys(provider)).toEqual(['recover','captureOriginal','captureFull']);expect(Object.isFrozen(provider)).toBe(true);
 expect(await provider.recover(id)).toBeUndefined();expect(calls.resolve).toHaveBeenCalledExactlyOnceWith(f.db,id,expect.objectContaining({clock:f.clock,historicalTerm:{connect:f.connect,policy:expect.objectContaining({programId:f.policy.programId})}}));
});
it('keeps full capture on the private owner connection and returns no capture authority',async()=>{
 const f=fixture(),id=randomUUID(),wallet=key(209).toBase58(),provider=createPhysicalMineRecoveryProvider(f.db,{historicalTerm:{connect:f.connect,policy:f.policy},clock:f.clock});
 calls.capture.mockResolvedValue({privateProjection:'not an HTTP return value'});
 expect(await provider.captureFull!(wallet,id)).toBeUndefined();
 expect(calls.capture).toHaveBeenCalledExactlyOnceWith(f.db,wallet,id,{clock:f.clock});expect(calls.resolve).not.toHaveBeenCalled();
});
it('pins the server policy and connector at construction before the first request',async()=>{
 const f=fixture(),deps={historicalTerm:{connect:f.connect,policy:f.policy},clock:f.clock},provider=createPhysicalMineRecoveryProvider(f.db,deps),original=f.policy.programId.toBase58();
 const mutable=deps.historicalTerm.policy as {programId:PublicKey;deployment:{programDataSha256:string}};
 mutable.programId=key(220);mutable.deployment.programDataSha256='ff'.repeat(32);deps.historicalTerm.connect=()=>{throw Error('changed connector');};deps.clock=()=>new Date('2099-01-01');
 calls.resolve.mockResolvedValue({});await provider.recover(randomUUID());const used=calls.resolve.mock.calls[0]![2];
 expect(used.historicalTerm.policy.programId.toBase58()).toBe(original);expect(used.historicalTerm.policy.deployment.programDataSha256).toBe('ab'.repeat(32));expect(used.historicalTerm.connect).toBe(f.connect);expect(used.clock).toBe(f.clock);
 await provider.captureFull!(key(209).toBase58(),randomUUID());expect(calls.capture.mock.calls[0]![3]).toEqual({clock:f.clock});
});
it('refuses a caller transaction instead of retaining its locks around provider work',()=>{
 const f=fixture();expect(()=>createPhysicalMineRecoveryProvider({rollback(){}} as unknown as Db,{historicalTerm:{connect:f.connect,policy:f.policy}})).toThrow('top-level');expect(calls.resolve).not.toHaveBeenCalled();
});

it('extends normal collection with private original capture while retaining the old full-only capability',async()=>{
 const f=fixture(),id=randomUUID(),wallet=key(209).toBase58(),provider=createPhysicalMineRecoveryProvider(f.db,{historicalTerm:{connect:f.connect,policy:f.policy},clock:f.clock});
 calls.original.mockResolvedValue({privateProjection:'not returned'});
 expect(await provider.captureOriginal!(wallet,id)).toBeUndefined();
 expect(calls.original).toHaveBeenCalledExactlyOnceWith(f.db,wallet,id,{clock:f.clock});
 expect(calls.capture).not.toHaveBeenCalled();expect(calls.resolve).not.toHaveBeenCalled();
});
