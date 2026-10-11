/** Actual DB qualification plus injected serialized finalized backing/Seeker proofs. */
import { PublicKey } from '@solana/web3.js';
import { PHASE_E_POLICY,TOKEN } from '@shardkeep/shared';
import { MINING_PROGRAM_ADDRESS } from '@shardkeep/chain/mining-program';
import type { DeedMiningWalletReader } from '@shardkeep/chain/mining-wallet';
import { createMiningWalletFixture } from '../../../../packages/chain/src/testFixtures/deedMiningWallet';
import { createMiningTermFixture } from '../../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import { createMiningBackingFixture } from '../../../../packages/chain/src/testFixtures/miningBacking';
import { createInitialFreeAllocationPlanner } from '../../src/mining/initialFreeAllocation';
import { withInitialFreeMiningFixture as fixture } from './initialFreeMining';
export const INITIAL_FREE_PUBLICATION_DAY='2020-01-01';
const day=INITIAL_FREE_PUBLICATION_DAY,startAt=new Date(`${day}T00:00:00.000Z`),endAt=new Date('2020-01-02T00:00:00.000Z');
type Fixture=Parameters<Parameters<typeof fixture>[0]>[0];
type Winners=NonNullable<Parameters<typeof createMiningTermFixture>[0]['winners']>;
export async function prepareInitialFreePublication(f:Fixture,quantities:readonly number[]=[1]){
 if(!quantities.length)throw Error('A publication fixture needs real reservations');
 const receipts=[];for(const qty of quantities)receipts.push((await f.reserve(day,qty)).receipt);
 await f.battle(day);await f.clock(null);await f.collect('2019-12-31');await f.collect(day);
 return {epochId:receipts[0]!.epochId,day,policyVersion:1 as const};
}
export function createInitialFreeQualificationFixture(wallet:string,genesisHash?:string){
 const make=()=>{const chain=createMiningWalletFixture({targetWallet:wallet,startAt,endAt,scenario:'none'});
  if(genesisHash){chain.reader.getGenesisHash.mockResolvedValue(genesisHash);chain.expectedGenesisHash=genesisHash;}return chain;},chain=make();let first=true;
 return {chain,source:{source:()=>{const next=first?chain:make();first=false;return next.reader as unknown as DeedMiningWalletReader;},collection:chain.collection,expectedGenesisHash:chain.expectedGenesisHash}};
}
export async function createInitialFreePublicationSources(f:Fixture,budgetGross=BigInt(PHASE_E_POLICY.mining.grossDailyCeilingKeep)*10n**BigInt(TOKEN.decimals),winners:Winners=[],genesisHash?:string){
 const q=createInitialFreeQualificationFixture(f.wallet,genesisHash),term=await createMiningTermFixture({day,genesisHash:new PublicKey(q.source.expectedGenesisHash),programId:new PublicKey(MINING_PROGRAM_ADDRESS),winners});
 const backing=await createMiningBackingFixture({day,genesisHash:new PublicKey(q.source.expectedGenesisHash),programId:term.policy.programId,programData:term.programData,programDataAddress:term.programDataAddress,upgradeAuthority:term.upgradeAuthority,virginConfig:true,budgetGross});
 const sources={qualification:q.source,backing:{reader:backing.reader,trust:backing.trust},tax:{connect:term.connect,policy:term.policy}};
 return {q,term,backing,sources,plan:createInitialFreeAllocationPlanner(f.conn.db,sources)};
}
export async function withInitialFreePublicationFixture(
 run:(f:Fixture & Awaited<ReturnType<typeof createInitialFreePublicationSources>> & {request:Awaited<ReturnType<typeof prepareInitialFreePublication>>})=>Promise<void>,
 options:{budgetGross?:bigint;quantities?:readonly number[];winners?:Winners}={},
){return fixture(async f=>{const request=await prepareInitialFreePublication(f,options.quantities),sources=await createInitialFreePublicationSources(f,options.budgetGross,options.winners);await run({...f,...sources,request});},{roster:true});}
