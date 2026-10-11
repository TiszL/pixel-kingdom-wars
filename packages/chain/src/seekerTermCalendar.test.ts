/** Calendar selection is a hint only; API discovery fixtures run the complete verifier. */
import {Keypair} from '@solana/web3.js';
import {PHASE_E_POLICY,PHASE_E_SEEKER_AUCTION} from '@shardkeep/shared';
import {describe,expect,it} from 'vitest';
import {candidateSeekerRoundAt,type SeekerRawAccount} from './seekerTermAccounts';
import {createMiningTermFixture} from './testFixtures/miningZeroWinnerTerm';

const start=(BigInt(Date.parse('2035-01-01T00:00:00.000Z'))-BigInt(PHASE_E_SEEKER_AUCTION.settlementGraceSec)*1000n);
const duration=BigInt(PHASE_E_POLICY.seekerIsland.operatingTermSec)*1000n;
async function fixture(){
 const f=await createMiningTermFixture({day:'2035-01-01',programId:Keypair.generate().publicKey,genesisHash:Keypair.generate().publicKey});
 const value=f.store.get(f.policy.config.toBase58())!;
 const raw:SeekerRawAccount={address:f.policy.config,owner:value.owner,executable:value.executable,data:value.data};
 return {...f,raw};
}
describe('non-authoritative fixed-calendar candidate',()=>{
 it('uses exact milliseconds and half-open boundaries for arbitrary rounds',async()=>{
  const f=await fixture();
  for(const [offset,round] of [[0n,0n],[duration-1n,0n],[duration,1n],[12345n*duration+1n,12345n]] as const)
   expect(candidateSeekerRoundAt(f.policy,f.raw,start+offset)).toBe(round);
  expect(()=>candidateSeekerRoundAt(f.policy,f.raw,start-1n)).toThrow();
 });
 it.each(['owner','address','executable','allocation','discriminator','version','duration'] as const)('rejects malformed %s before selecting a round',async field=>{
  const f=await fixture(),raw={...f.raw,data:Buffer.from(f.raw.data)};
  if(field==='owner')raw.owner=Keypair.generate().publicKey;
  if(field==='address')raw.address=Keypair.generate().publicKey;
  if(field==='executable')raw.executable=true;
  if(field==='allocation')raw.data=Buffer.concat([raw.data,Buffer.alloc(1)]);
  if(field==='discriminator')raw.data[0]=raw.data[0]!^1;
  if(field==='version')raw.data[8]=2;
  if(field==='duration')raw.data.writeBigInt64LE(0n,254);
  expect(()=>candidateSeekerRoundAt(f.policy,raw,start)).toThrow();
 });
 it('rejects unsafe earning types and calendars whose selected end overflows i64',async()=>{
  const f=await fixture();
  expect(()=>candidateSeekerRoundAt(f.policy,f.raw,Number(start) as unknown as bigint)).toThrow();
  const max=(1n<<63n)-1n,raw={...f.raw,data:Buffer.from(f.raw.data)};
  raw.data.writeBigInt64LE(max-1n,246);
  expect(()=>candidateSeekerRoundAt(f.policy,raw,(max-1n)*1000n)).toThrow();
  expect(()=>candidateSeekerRoundAt(f.policy,f.raw,(1n<<64n)*duration+start)).toThrow();
 });
});
