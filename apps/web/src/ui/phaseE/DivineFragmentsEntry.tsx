import { withPhaseEWebHold } from './webHold';
import {lazy,Suspense,useEffect,useState} from 'react';
import {DivineFragmentPolicySchema} from '@shardkeep/shared/divineFragmentsApi';
import {authCookies} from '../../auth/authCookieCoordinator';
import {api} from '../../lib/api';
import {useApp} from '../../state/store';
import {PhaseEEntryButton} from './PhaseEActionDock';
const Screen=lazy(()=>import('./DivineFragmentsScreen').then(m=>({default:m.DivineFragmentsScreen})));
/** A disabled production provider cannot advertise a new economy action.
 * Original local requests remain reachable independently of source admission. */
function DivineFragmentsEntryEnabled({actionsEnabled,onOpen}:{actionsEnabled:boolean;onOpen?:(()=>void)|undefined}){
 const wallet=useApp(s=>s.wallet),authed=useApp(s=>s.authed),[found,setFound]=useState<{wallet:string;generation:ReturnType<typeof authCookies.captureGeneration>;local:boolean}|null>(null),[open,setOpen]=useState<string|null>(null);
 useEffect(()=>{if(!wallet||!authed)return;let active=true;const generation=authCookies.captureGeneration(),abort=new AbortController(),current=()=>active&&authCookies.current(generation)&&useApp.getState().authed&&useApp.getState().wallet===wallet;
  void Promise.all([import('../../lib/divineFragments/journal'),import('../../lib/divineFragments/browser')]).then(async([journal,browser])=>{
   if(!current())return;const store=new journal.DivineFragmentsJournalStore(browser.divineFragmentsIdentity(wallet));
   try{const row=await store.read();if(current()&&(row.operation||row.archives.length))setFound({wallet,generation,local:true});}
   finally{await store.close().catch(()=>undefined);}
  }).catch(()=>undefined);
  void api.getPrivate('/divine-fragments/policy',{signal:abort.signal,isCurrent:current}).then(raw=>{
   DivineFragmentPolicySchema.parse(raw);if(current())setFound(old=>old?.wallet===wallet&&old.generation===generation&&old.local?old:{wallet,generation,local:false});
  }).catch(()=>undefined);
  return()=>{active=false;abort.abort();};
 },[wallet,authed]);
 if(!wallet||!authed||found?.wallet!==wallet||!authCookies.current(found.generation))return null;
 return <><PhaseEEntryButton variant="sec" onClick={()=>onOpen?onOpen():setOpen(wallet)}>{found.local?'FRAGMENTS & HISTORY':'CRYSTAL FRAGMENTS'}</PhaseEEntryButton>{open===wallet&&<Suspense fallback={<p role="status">Opening fragment history…</p>}><Screen actionsEnabled={actionsEnabled} onClose={()=>setOpen(null)}/></Suspense>}</>;
}

// The build hold prevents controller hooks and recovery discovery from mounting.
export const DivineFragmentsEntry = withPhaseEWebHold(DivineFragmentsEntryEnabled);
