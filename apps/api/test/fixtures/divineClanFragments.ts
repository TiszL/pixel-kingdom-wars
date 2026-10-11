/** Actual D181 funding, original finalized entry and normal simulated raid feed
 * D193. Finalized RPC banks are explicit local fixtures, never live evidence. */
import {randomUUID} from 'node:crypto';
import {Keypair,PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {vi} from 'vitest';
import {RAID_RULES} from '@shardkeep/shared';
import {CharterTournamentEventSchema} from '@shardkeep/shared/charterTournamentApi';
import {createMiningTermFixture} from '../../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {baseArmy} from '../../src/db/schema';
import {joinClan} from '../../src/game/clans';
import {createCharterTournamentEventsClient} from '../../src/game/clanCharterTournamentEventsClient';
import {acceptLiveRaidCommand} from '../../src/game/liveRaids';
import {recoverDueStartedLiveRaids} from '../../src/game/raids';
import {createDivineFragmentTermSource} from '../../src/game/divineFragmentTermReader';
import {createDivineFragments} from '../../src/game/divineFragments';
import {createDivineClanFragments} from '../../src/game/divineClanFragments';
import {createSeekerFragmentClaims} from '../../src/game/seekerFragmentClaims';
import {charterTournamentWorkflowFixture} from './charterTournamentWorkflow';

export async function divineClanFragmentFixture(rosterSize=3,winnerCount=2,settings:Parameters<typeof charterTournamentWorkflowFixture>[0]={}){
 const flags=['PHASE_E_CATALOG_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_MINING_ENABLED','PHASE_E_SEEKER_ENABLED'];
 const previous=flags.map(k=>[k,process.env[k]] as const);for(const flag of flags)process.env[flag]='true';
 const restore=()=>{for(const [k,v]of previous){if(v===undefined)delete process.env[k];else process.env[k]=v;}};
 let f:Awaited<ReturnType<typeof charterTournamentWorkflowFixture>>;
 try{f=await charterTournamentWorkflowFixture(settings);}catch(error){restore();throw error;}
 try{
  const members:{wallet:string;baseId:string}[]=[f.source];
  for(let i=1;i<rosterSize;i++){const member=await f.actor();await joinClan(f.db,member.wallet,f.birth.consent.clanId);members.push(member);}
  // 2026-10-10: every instant below is relative to the fixture's real past week (pastTournamentWeek) rather than the
  // 2035-01-06 week: 0286 refuses a raid capture and 0256/0279 a settlement after the real Postgres clock.
  const funded=new Date(Date.parse(f.event.entryStartsAt)-86_400_000),sourceAt=new Date(Date.parse(f.event.playEndsAt)+86_400_000).toISOString();
  const bank=await createMiningTermFixture({day:f.event.playEndsAt.slice(0,10),genesisHash:new PublicKey(f.domain.genesisHash),programId:Keypair.generate().publicKey,
   winners:Array.from({length:winnerCount},(_,spotId)=>({spotId,wallet:new PublicKey(spotId%2?f.buyer.wallet:f.source.wallet)}))});
  const source=createDivineFragmentTermSource(signal=>bank.connect(signal),bank.policy);
  const options={domain:{genesisHash:f.domain.genesisHash,economyProgram:f.domain.economyProgram},clock:f.clock,termSource:source,finalizedDeedReader:f.reader,deedCollection:f.source.collection};
  const clan=createDivineClanFragments(f.db,{...options,domain:f.domain}),fragments=createDivineFragments(f.db,options),seeker=createSeekerFragmentClaims(f.db,options);
  const events=createCharterTournamentEventsClient(f.db,{clock:f.clock,finalizedDeedReader:f.reader,deedCollection:f.source.collection});
  f.setTime(funded);
  async function complete(id:string){const prepared=await f.prepare(id);await f.service().retainSigned(f.source.wallet,id,f.signed(prepared));await f.finalizeLock(id);return f.service().recover(f.source.wallet,id);}
  let entered:Awaited<ReturnType<typeof f.entry>>|null=null;
  async function play(){
   f.setTime(new Date(Date.parse(f.event.entryStartsAt)+3_600_000));entered=await f.entry();await complete(entered.state.set.original.operation.id);
   f.setTime(new Date(Date.parse(f.event.playStartsAt)+3_600_000));
   await f.db.insert(baseArmy).values({baseId:f.source.baseId,troop:'highlander',count:5}).onConflictDoUpdate({target:[baseArmy.baseId,baseArmy.troop],set:{count:5}});
   const admission=await events.startRaid(f.source.wallet,f.event.id,{baseId:f.source.baseId,idempotencyKey:randomUUID()});
   const raid=admission.raid as {id:string};
   await acceptLiveRaidCommand(f.db,f.source.wallet,raid.id,randomUUID(),{kind:'deploy',payload:{troop:'highlander',tx:6,ty:10}},f.clock());
   f.setTime(new Date(f.clock().getTime()+RAID_RULES.battleDurationSec*1000+1));
   const result=await recoverDueStartedLiveRaids(f.db,f.clock(),undefined,raid.id);
   if(result.resolved!==1)throw Error('Fragment fixture must resolve one actual matched raid');
   f.setTime(new Date(f.event.playEndsAt));const terminal=CharterTournamentEventSchema.parse(await events.close(f.source.wallet,f.event.id));
   if(terminal.terminal?.occupations.length!==1)throw Error('Fragment fixture must earn an actual clan occupation');
   return terminal;
  }
  async function withSourceClock<T>(run:()=>Promise<T>,at=sourceAt){
   f.setTime(new Date(at));bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(Date.parse(at)/1000),32);
   vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(at));
   try{return await run();}finally{vi.useRealTimers();}
  }
  async function clear(){if(!entered)throw Error('Original entry missing');const row=await f.tournamentStore.createClear(f.source.wallet,entered.state.id,randomUUID());return complete(row.original.operation.id);}
  async function dispose(){try{await f.dispose();}finally{vi.useRealTimers();restore();}}
  return {...f,members,fragmentBank:bank,fragmentSource:source,fragmentOptions:options,clan,fragments,seeker,events,play,clear,withSourceClock,
   settle:(id=f.event.id,at?:string)=>withSourceClock(()=>clan.settle(id),at),dispose};
 }catch(error){try{await f.dispose();}finally{restore();}throw error;}
}
export type DivineClanFragmentFixture=Awaited<ReturnType<typeof divineClanFragmentFixture>>;
