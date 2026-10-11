/** Actual earned Renown -> actual D184 simulation -> original historical Seeker
 * account/settlement bytes. Finality is supplied by a local fixture bank. */
import {Keypair,PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {vi} from 'vitest';
import {createMiningTermFixture} from '../../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {createDivineFragmentTermSource} from '../../src/game/divineFragmentTermReader';
import {createDivineFragments} from '../../src/game/divineFragments';
import {createSeekerFragmentClaims} from '../../src/game/seekerFragmentClaims';
import {withDivineTrialFixture,type DivineTrialFixture} from './divineTrials';
import {randomUUID} from 'node:crypto';
export async function playFragmentTrial(f:DivineTrialFixture,event=f.event,actors=[{wallet:f.wallet,baseId:f.baseId},{wallet:f.buyer,baseId:f.buyerBaseId}]){
 f.setTime(event.entryStartsAt);
 for(const actor of actors)await f.client.enter(actor.wallet,event.id,{baseId:actor.baseId,idempotencyKey:randomUUID()});
 f.setTime(event.playStartsAt);
 for(const actor of actors){const attempt=await f.client.admit(actor.wallet,event.id,{baseId:actor.baseId,idempotencyKey:randomUUID()});await f.client.submit(actor.wallet,attempt.id,{orders:f.orders(actor.wallet===f.wallet?'north':'south')});}
 f.setTime(event.playEndsAt);return f.client.close(event.id);
}
export async function withDivineFragmentFixture(run:(f:Awaited<ReturnType<typeof fixture>>)=>Promise<void>,winnerCount=2){
 const prior=process.env.PHASE_E_SEEKER_ENABLED;process.env.PHASE_E_SEEKER_ENABLED='true';
 try{await withDivineTrialFixture(async f=>run(await fixture(f,winnerCount)));}finally{vi.useRealTimers();if(prior===undefined)delete process.env.PHASE_E_SEEKER_ENABLED;else process.env.PHASE_E_SEEKER_ENABLED=prior;}
}
async function fixture(f:DivineTrialFixture,winnerCount:number):Promise<DivineFragmentFixture>{
 const bank=await createMiningTermFixture({day:'2020-01-06',genesisHash:new PublicKey(f.domain.genesisHash),programId:Keypair.generate().publicKey,
  winners:Array.from({length:winnerCount},(_,spotId)=>({spotId,wallet:new PublicKey(spotId%2?f.buyer:f.wallet)}))});
 const nextBank=await createMiningTermFixture({day:'2020-01-13',round:1n,genesisHash:bank.policy.genesisHash,programId:bank.policy.programId,mint:bank.policy.mint,prizeOwner:bank.policy.prizeOwner,programData:bank.programData,programDataAddress:bank.programDataAddress,upgradeAuthority:bank.upgradeAuthority,winners:Array.from({length:winnerCount},(_,spotId)=>({spotId,wallet:new PublicKey(spotId%2?f.buyer:f.wallet)}))});
 let activeBank=bank;
 const source=createDivineFragmentTermSource(signal=>activeBank.connect(signal),bank.policy),options={...f.options,termSource:source},client=createDivineFragments(f.db,options),seeker=createSeekerFragmentClaims(f.db,options);
 const withSourceClock=async<T>(run:()=>Promise<T>,at='2020-01-07T00:00:00.000Z')=>{
  f.setTime(at);for(const selected of [bank,nextBank])selected.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(Date.parse(at)/1000),32);
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(at));
  try{return await run();}finally{vi.useRealTimers();}
 };
 const settle=(id=f.event.id,at='2020-01-07T00:00:00.000Z')=>{activeBank=id===f.event.id?bank:nextBank;return withSourceClock(()=>client.settle(id),at);};
 return {...f,fragmentBank:bank,source,options,fragments:client,seeker,settle,withSourceClock,play:()=>playFragmentTrial(f)};
}
export interface DivineFragmentFixture extends DivineTrialFixture {
 fragmentBank:Awaited<ReturnType<typeof createMiningTermFixture>>;
 source:ReturnType<typeof createDivineFragmentTermSource>;
 options:DivineTrialFixture['options'] & {termSource:ReturnType<typeof createDivineFragmentTermSource>};
 fragments:ReturnType<typeof createDivineFragments>;seeker:ReturnType<typeof createSeekerFragmentClaims>;
 settle:(id?:string,at?:string)=>ReturnType<ReturnType<typeof createDivineFragments>['settle']>;
 withSourceClock:<T>(run:()=>Promise<T>,at?:string)=>Promise<T>;
 play:()=>ReturnType<DivineTrialFixture['client']['close']>;
}
