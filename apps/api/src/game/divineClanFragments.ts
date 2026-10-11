/** D153.193 private actual D181 occupation composition. No HTTP grant path. */
import type {Db} from '../db/client';
import {createDivineFragmentAccounting,fragmentTournamentDomain,type DivineFragmentOptions} from './divineFragments';
export interface DivineClanFragmentOptions extends Omit<DivineFragmentOptions,'domain'>{
 readonly domain:{genesisHash:string;economyProgram:string;craftProgram:string;treasury:string};
}
export function createDivineClanFragments(db:Db,options:DivineClanFragmentOptions){
 const domain=fragmentTournamentDomain.parse(options.domain);
 const service=createDivineFragmentAccounting(db,{...options,domain:{genesisHash:domain.genesisHash,economyProgram:domain.economyProgram}},'clan',domain);
 return Object.freeze({enroll:service.enroll,settle:service.settle});
}
