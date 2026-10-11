import {CharterTournamentRaidSchema,type CharterTournamentRaid} from '@shardkeep/shared/charterTournamentApi';
import {authCookies} from '../../auth/authCookieCoordinator';
import {useApp} from '../../state/store';
/** Resume the existing canonical battle. Never creates a second ordinary raid. */
export function openTournamentBattle(raw:CharterTournamentRaid,actor:string,baseId:string){
 authCookies.assertSession();const r=CharterTournamentRaidSchema.parse(raw),raid=r.raid as Record<string,unknown>|null,state=useApp.getState();
 if(!raid||typeof raid.id!=='string'||r.status!=='admitted'||!state.authed||state.wallet!==actor||state.selectedBaseId!==baseId||r.baseId!==baseId||raid.attackerBaseId!==baseId)throw Error('Return to the original account and attacking kingdom before opening this match.');
 state.setRaidTarget({kind:'pvp',raidId:raid.id});state.setScreen('battle');
}
