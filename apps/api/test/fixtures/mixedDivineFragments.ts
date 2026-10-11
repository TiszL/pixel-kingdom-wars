/** One owned DB, actual funded mining/claim/Renown and actual Charter birth and
 * tournament. Both issuers share one economic domain, roster wallet and term. */
import {randomUUID} from 'node:crypto';
import {createDb} from '../../src/db/client';
import {shields} from '../../src/db/schema';
import {getEffectiveShieldStatus} from '../../src/game/baseShields';
import {joinClan} from '../../src/game/clans';
import {createDivineFragments} from '../../src/game/divineFragments';
import {withDivineTrialFixture} from './divineTrials';
import {playFragmentTrial} from './divineFragments';
import {divineClanFragmentFixture} from './divineClanFragments';

export async function withMixedDivineFragmentFixture(run:(f:MixedDivineFragmentFixture)=>Promise<void>){
 await withDivineTrialFixture(async individual=>{
  // The outer fixture alone owns setup/drop. Charter fixture helpers may borrow
  // the same connection, but cannot migrate, reset or dispose somebody else's DB.
  const database={...individual.f.conn,reopen:()=>createDb(String(individual.f.url),{max:4}),setup:async()=>{},close:async()=>{}};
  const clan=await divineClanFragmentFixture(2,2,{domain:individual.domain,database});
  try{
   // The outer paid kingdom belongs to another finalized deed bank. Keep it
   // protected from this fixture's automatic PvP pool, including during warzone;
   // its mining/source history and both exact deed readers remain unchanged.
   await clan.db.insert(shields).values({playerWallet:individual.buyer,baseId:individual.buyerBaseId,source:'warzone',expiresAt:new Date(clan.event.playEndsAt)});
   const lastPlayInstant=new Date(new Date(clan.event.playEndsAt).getTime()-1);
   for(const warzone of [false,true])if(!(await getEffectiveShieldStatus(clan.db,individual.buyer,lastPlayInstant,warzone,individual.buyerBaseId)).active)
    throw Error('Mixed fixture outer paid kingdom must be excluded from clan matchmaking');
   await joinClan(clan.db,individual.wallet,clan.birth.consent.clanId);
   clan.members.push({wallet:individual.wallet,baseId:individual.baseId});
   individual.setTime(new Date(Date.parse(clan.event.entryStartsAt)-86_400_000));
   const budget=Object.fromEntries(Object.keys(individual.budget).map(k=>[k,'1']));
   const individualEvent=await individual.client.fund(individual.wallet,{id:randomUUID(),baseId:individual.baseId,weekStart:clan.event.entryStartsAt,budget});
   const issuer=createDivineFragments(clan.db,{...clan.fragmentOptions,clock:individual.clock});
   async function enroll(){await issuer.enroll(individualEvent.id);await clan.clan.enroll(clan.event.id);}
   async function play(){
    await playFragmentTrial(individual,individualEvent,[{wallet:individual.wallet,baseId:individual.baseId}]);const terminal=await clan.play();
    const raids=await clan.sql`select r.defender_base_id from charter_tournament_raid_admissions a join raids r on r.id=a.raid_id where a.event_id=${clan.event.id}`;
    if(raids.length!==1||raids[0]!.defender_base_id===individual.buyerBaseId)throw Error('Mixed fixture must resolve one clan-bank opponent');
    return terminal;
   }
   async function settleIndividual(){return clan.withSourceClock(()=>{individual.setTime(clan.clock());return issuer.settle(individualEvent.id);});}
   await run({clan,individual,individualEvent,issuer,enroll,play,settleIndividual});
  }finally{await clan.dispose();}
 });
}
export interface MixedDivineFragmentFixture {
 clan:Awaited<ReturnType<typeof divineClanFragmentFixture>>;
 individual:Parameters<Parameters<typeof withDivineTrialFixture>[0]>[0];
 individualEvent:Awaited<ReturnType<Parameters<Parameters<typeof withDivineTrialFixture>[0]>[0]['client']['fund']>>;
 issuer:ReturnType<typeof createDivineFragments>;
 enroll:()=>Promise<void>;play:()=>ReturnType<Awaited<ReturnType<typeof divineClanFragmentFixture>>['play']>;
 settleIndividual:()=>ReturnType<ReturnType<typeof createDivineFragments>['settle']>;
}
