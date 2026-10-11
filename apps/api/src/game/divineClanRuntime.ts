/** Private D193 lifecycle over the actual D181 tournament source. Mounting
 * neither initializes an epoch nor selects a sponsor, event or lock issuer. */
import {isDeepStrictEqual} from 'node:util';
import {sql} from 'drizzle-orm';
import type {Db} from '../db/client';
import {createCharterTournamentsStore} from '../db/charterTournaments';
import {HttpError} from '../lib/errors';
import type {SeekerGameplaySources} from '../seeker/realmSaleRuntime';
import {createClanCharterTournaments,TournamentEntryRequest,type CharterTournamentsOptions,type CharterTournamentProvider} from './clanCharterTournaments';
import {createCharterTournamentEventsClient,type CharterTournamentEventsClientOptions,type CharterTournamentEventsClientProvider} from './clanCharterTournamentEventsClient';
import {createDivineClanFragments} from './divineClanFragments';
import {createDivineFragmentTermSource} from './divineFragmentTermReader';
import {assertFragmentSource,fragmentFail,fragmentId,fragmentTournamentDomain,type FragmentDestinationOptions} from './divineFragments';

export interface DivineClanRuntimeOptions {
 readonly history?:FragmentDestinationOptions;
 readonly funding?:NonNullable<CharterTournamentEventsClientOptions['newFunding']>|null;
 readonly term?:SeekerGameplaySources['term']|null;
 readonly tournaments?:CharterTournamentsOptions;
}
export type DivineClanEventProvider=CharterTournamentEventsClientProvider;
export function createDivineClanRuntime(db:Db,options:DivineClanRuntimeOptions={}){
 if('rollback'in db)throw Error('DIVINE_CLAN_RUNTIME_TOP_LEVEL');
 const destination=options.history??{},funding=options.funding?structuredClone(options.funding):null;
 if(funding)fragmentTournamentDomain.parse(funding.domain);
 // Preserve the accepted public ABI and old funding retries without granting
 // its HTTP fund command a new sponsor capability.
 const events=createCharterTournamentEventsClient(db,destination);
 const fundingEvents=funding?createCharterTournamentEventsClient(db,{...destination,newFunding:funding}):null;
 const tournaments=createClanCharterTournaments(db,{...options.tournaments,...destination.clock?{clock:destination.clock}:{}});
 const originals=createCharterTournamentsStore(db);
 const termSource=options.term?createDivineFragmentTermSource(options.term.connect,options.term.policy):null;
 const accounting=funding&&termSource?createDivineClanFragments(db,{...destination,domain:funding.domain,termSource}):null;
 const charterTournamentProvider:CharterTournamentProvider=Object.freeze({
  ...tournaments,
  createEntry:async(wallet,raw)=>{
   const input=TournamentEntryRequest.parse(raw),prior=await originals.entryByKey(wallet,input.idempotencyKey);
   // An accepted original remains recoverable without a new source or gate.
   // A reused key must never authorize a different event or clan.
   if(prior){if(prior.eventId!==input.eventId||prior.clanId!==input.clanId)throw new HttpError(409,'Tournament command differs','CLAN_CHARTER_TOURNAMENT_CONFLICT');return prior;}
   await assertFragmentSource(db);
   const [enrolled]=await db.execute<{source_kind:string}>(sql`select source_kind from public.divine_fragment_enrollments where event_id=${input.eventId}::uuid`);
   if(enrolled?.source_kind!=='clan')fragmentFail('NOT_ENROLLED',503);
   return tournaments.createEntry(wallet,input);
  },
 });
 const charterTournamentEventsProvider:DivineClanEventProvider=events;
 const operator=accounting&&funding&&fundingEvents?Object.freeze({
  initializeEpoch:()=>originals.initializeEpoch(funding.domain),
  fundAndEnroll:async(actor:string,command:unknown)=>{
   if(actor!==funding.sponsorWallet)throw new HttpError(403,'Sponsor differs','CLAN_CHARTER_TOURNAMENT_SPONSOR');
   const event=await fundingEvents.fund(actor,command);await accounting.enroll(event.id);return event;
  },
  enroll:(eventId:string)=>accounting.enroll(fragmentId.parse(eventId)),
  closeAndSettle:async(eventId:string)=>{
   fragmentId.parse(eventId);const saved=await events.read(funding.sponsorWallet,eventId);
   // Reject a foreign domain before closing any genuine tournament source.
   if(!isDeepStrictEqual(saved.domain,funding.domain))fragmentFail('DOMAIN',503);
   const event=await events.close(funding.sponsorWallet,eventId),settlement=await accounting.settle(event.id);
   return {event,settlement};
  },
 }):null;
 return Object.freeze({deps:Object.freeze({charterTournamentProvider,charterTournamentEventsProvider}),operator});
}
