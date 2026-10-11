import { withPhaseEWebHold } from './webHold';
import {lazy,Suspense,useEffect,useState} from 'react';
import {CharterTournamentEventsSchema} from '@shardkeep/shared/charterTournamentApi';
import {authCookies} from '../../auth/authCookieCoordinator';
import {api} from '../../lib/api';
import type {TournamentSigningTrust} from '../../lib/charterTournament/signing';
import {useApp} from '../../state/store';
import {PhaseEEntryButton as Btn} from './PhaseEActionDock';
const Screen=lazy(()=>import('./CharterTournamentScreen').then(m=>({default:m.CharterTournamentScreen})));
/** Funded-event discovery supplies no application trust. Production pins stay null. */
function CharterTournamentEntryEnabled({actionsEnabled,trust=null}:{actionsEnabled:boolean;trust?:TournamentSigningTrust|null}):React.JSX.Element|null{
 const wallet=useApp(s=>s.wallet),authed=useApp(s=>s.authed),[found,setFound]=useState<string|null>(null),[open,setOpen]=useState<string|null>(null);
 useEffect(()=>{if(!wallet||!authed)return;let active=true;const generation=authCookies.captureGeneration(),abort=new AbortController(),current=()=>active&&authCookies.current(generation)&&useApp.getState().authed&&useApp.getState().wallet===wallet;
  void Promise.all([import('../../lib/charterTournament/journal'),import('../../lib/charterTournament/browser')]).then(async([journal,browser])=>{if(!current())return;const store=new journal.TournamentJournalStore(browser.browserTournamentIdentity(wallet));try{if(((await store.read()).eventId||(await store.archives()).length>0)&&current())setFound(wallet);}catch{if(current())setFound(wallet);}finally{await store.close().catch(()=>undefined);}}).catch(()=>{if(current())setFound(wallet);});
  void api.getPrivate('/clans/charter/tournaments/events',{signal:abort.signal,isCurrent:current}).then(raw=>{const list=CharterTournamentEventsSchema.parse(raw);if(current()&&list.events.length)setFound(wallet);}).catch(()=>undefined);
  return()=>{active=false;abort.abort();};
 },[wallet,authed]);
 if(!wallet||!authed||found!==wallet)return null;
 return <><Btn variant="sec" onClick={()=>setOpen(wallet)}>CLAN TOURNAMENTS</Btn>{open===wallet&&<Suspense fallback={<p role="status">Opening tournament history…</p>}><Screen actionsEnabled={actionsEnabled} trust={trust} onClose={()=>setOpen(null)}/></Suspense>}</>;
}

// The build hold prevents controller hooks and recovery discovery from mounting.
export const CharterTournamentEntry = withPhaseEWebHold(CharterTournamentEntryEnabled);
