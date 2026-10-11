import type * as A from '@shardkeep/shared/divineFragmentsApi';
import {divineFragmentWeekAt,DIVINE_FRAGMENT_POLICY,splitDivineClanFragmentAward,DIVINE_FRAGMENT_CLAN_SITE_GROSS} from '@shardkeep/shared/divineFragments';
import type {DivineFragmentsCommand as Command} from './journal';
export {DIVINE_FRAGMENT_POLICY};
export const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const identity={origin:'https://game.test',api:'https://game.test',cluster:'devnet' as const,wallet:'11111111111111111111111111111111'};
export const time='2026-09-28T00:00:00.000Z';
export const award:A.DivineFragmentAward={version:1,resourceId:'crystal_fragment',economicLineage:'shardkeep',domain:{genesisHash:identity.wallet,economyProgram:identity.wallet},eventId:id(3),wallet:identity.wallet,site:'divine-individual-001',weekStart:divineFragmentWeekAt(time),earnedAt:time,sourceHash:'a'.repeat(64),termId:id(4),termHash:'b'.repeat(64),winnerCount:2,poolDisposition:'original_winning_spots',gross:'14',net:'12',tax:'2',carryBefore:'0',carryAfter:'8000',settledAt:time};
/** Synthetic original roster source only; actual tournament/API acceptance is separate. */
export function clanAward(rosterSize=3,carryBefore=0n):Extract<A.DivineFragmentAward,{clan:unknown}>{
 const split=splitDivineClanFragmentAward(rosterSize,carryBefore);
 return {...award,eventId:id(30),site:'divine-clan-001',gross:String(split.gross),net:String(split.net),tax:String(split.tax),carryBefore:String(carryBefore),carryAfter:String(split.nextCarry),
  clan:{clanId:id(31),entryId:id(32),rosterSize,rosterHash:'c'.repeat(64),siteGross:String(DIVINE_FRAGMENT_CLAN_SITE_GROSS),tournamentDomain:{...award.domain,craftProgram:identity.wallet,treasury:identity.wallet}}};
}
export const entitlement:A.DivineFragmentSeekerEntitlement={termId:id(4),termHash:award.termHash,startsAt:'2026-09-21T00:00:00.000Z',endsAt:time,spotId:0,winnerCount:2,poolTotal:'11',previousTotal:'2',cumulativeTotal:'5',claimable:'3'};
export const delivery:Command={kind:'delivery',consent:{version:1,wallet:identity.wallet,eventId:award.eventId,award,request:{baseId:id(1),idempotencyKey:id(2)}}};
export const claim:Command={kind:'claim',consent:{version:1,wallet:identity.wallet,request:{baseId:id(1),idempotencyKey:id(2),termId:entitlement.termId,spotId:entitlement.spotId}},termHash:entitlement.termHash,browseCursor:null};
export const stock=(baseId=id(1))=>({version:1,resourceId:'crystal_fragment',wallet:identity.wallet,baseId,available:'5'});
export const event=()=>({version:1,wallet:identity.wallet,eventId:award.eventId,enrolled:true,settled:true,award,delivery:null});
export function proof(command:Command,accepted:boolean){const common={version:1 as const,resourceId:'crystal_fragment' as const,wallet:identity.wallet,...command.consent.request,stockBefore:'5'};
 const receipt=command.kind==='delivery'?{...common,eventId:command.consent.eventId,quantity:command.consent.award.net,stockAfter:String(5n+BigInt(command.consent.award.net)),deliveredAt:time}:{...common,termId:entitlement.termId,spotId:entitlement.spotId,termHash:entitlement.termHash,winnerCount:2,poolTotal:'11',previousTotal:'2',cumulativeTotal:'5',quantity:'3',stockAfter:'8',claimedAt:time};
 return {version:1,wallet:identity.wallet,idempotencyKey:command.consent.request.idempotencyKey,receipt:accepted?receipt:null};}
export function read(path:string):unknown {if(path==='/divine-fragments/policy')return DIVINE_FRAGMENT_POLICY;if(path.startsWith('/divine-fragments/stock/'))return stock(path.split('/').at(-1));if(path.startsWith('/divine-fragments/events/'))return event();if(path.startsWith('/divine-fragments/awards'))return {version:1,wallet:identity.wallet,rows:[{award,delivery:null}],nextCursor:null};if(path.startsWith('/divine-fragments/seeker/terms'))return {version:1,wallet:identity.wallet,rows:[entitlement],nextCursor:null};throw Error('Unexpected '+path);}
