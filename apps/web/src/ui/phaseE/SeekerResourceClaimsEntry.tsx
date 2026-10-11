import { withPhaseEWebHold } from './webHold';
import {lazy,Suspense,useEffect,useState} from 'react';
import {LAND_CHECKOUT_RECOVERY} from '@shardkeep/shared';
import {matchSeekerResourceEntitlementView} from '@shardkeep/shared/seekerResourceClaimsApi';
import {authCookies} from '../../auth/authCookieCoordinator';
import {api} from '../../lib/api';
import {seekerResourceClaimsIdentity} from '../../lib/seekerResourceClaims/browser';
import {SeekerResourceClaimsJournalStore} from '../../lib/seekerResourceClaims/journal';
import {useApp} from '../../state/store';
import {PhaseEEntryButton as Btn} from './PhaseEActionDock';
const SeekerResourceClaimsScreen=lazy(()=>import('./SeekerResourceClaimsScreen').then(m=>({default:m.SeekerResourceClaimsScreen})));
function SeekerResourceClaimsEntryEnabled({actionsEnabled}:{actionsEnabled:boolean}):React.JSX.Element|null{
 const wallet=useApp(s=>s.wallet),authed=useApp(s=>s.authed);
 const [found,setFound]=useState<{wallet:string;local:boolean}|null>(null),[open,setOpen]=useState<string|null>(null);
 useEffect(()=>{
  if(!wallet||!authed)return;let active=true;
  const generation=authCookies.captureGeneration(),current=()=>active&&authCookies.current(generation)&&useApp.getState().authed&&useApp.getState().wallet===wallet;
  const store=new SeekerResourceClaimsJournalStore(seekerResourceClaimsIdentity(wallet));
  void store.read().then(j=>{if(current()&&(j.operation||j.archives.length))setFound({wallet,local:true});}).catch(()=>{if(current())setFound({wallet,local:true});}).finally(()=>store.close().catch(()=>undefined));
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
  void api.getPrivate('/seeker/resource-claims',{signal:abort.signal,isCurrent:current}).then(raw=>{
   const view=matchSeekerResourceEntitlementView(raw,wallet);
   if(current()&&(view.claimsEnabled||view.rows.length||view.nextCursor||view.status==='unavailable'))setFound(old=>old?.wallet===wallet&&old.local?old:{wallet,local:false});
  }).catch(()=>undefined).finally(()=>clearTimeout(timer));
  return()=>{active=false;clearTimeout(timer);abort.abort();};
 },[wallet,authed]);
 if(!authed||!wallet||found?.wallet!==wallet)return null;
 return <><Btn variant="sec" style={{minHeight:44,position:'absolute',right:12,bottom:'calc(var(--safe-bottom, 0px) + 448px)',zIndex:20}} onClick={()=>setOpen(wallet)}>{found.local?'SEEKER SHARES & HISTORY':'SEEKER RESOURCE SHARES'}</Btn>
  {open===wallet&&<Suspense fallback={<p role="status">Opening saved resource shares…</p>}><SeekerResourceClaimsScreen actionsEnabled={actionsEnabled} onClose={()=>setOpen(null)}/></Suspense>}
 </>;
}

// The build hold prevents controller hooks and recovery discovery from mounting.
export const SeekerResourceClaimsEntry = withPhaseEWebHold(SeekerResourceClaimsEntryEnabled);
