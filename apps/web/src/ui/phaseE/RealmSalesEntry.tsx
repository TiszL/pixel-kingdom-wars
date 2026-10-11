import { withPhaseEWebHold } from './webHold';
import {lazy,Suspense,useEffect,useState} from 'react';
import {PhaseECatalogueResponseSchema} from '@shardkeep/shared/phaseE';
import {authCookies} from '../../auth/authCookieCoordinator';
import {api} from '../../lib/api';
import type {RealmSaleSigningTrust} from '../../lib/realmSales/signing';
import {useApp} from '../../state/store';
import {PhaseEEntryButton as Btn} from './PhaseEActionDock';
const Screen=lazy(()=>import('./RealmSalesScreen').then(m=>({default:m.RealmSalesScreen})));
/** Local recovery is discoverable even while new sales and their source are off. */
function RealmSalesEntryEnabled({actionsEnabled,trust=null}:{actionsEnabled:boolean;trust?:RealmSaleSigningTrust|null}):React.JSX.Element|null{
 const wallet=useApp(s=>s.wallet),authed=useApp(s=>s.authed),[found,setFound]=useState<{wallet:string;local:boolean}|null>(null),[open,setOpen]=useState<string|null>(null);
 useEffect(()=>{
  if(!wallet||!authed)return;let active=true;const abort=new AbortController(),generation=authCookies.captureGeneration();
  const current=()=>active&&authCookies.current(generation)&&useApp.getState().authed&&useApp.getState().wallet===wallet;
  void Promise.all([import('../../lib/realmSales/journal'),import('../../lib/realmSales/browser')]).then(async([journal,browser])=>{
   if(!current())return;const store=new journal.RealmSaleJournalStore(browser.realmSaleIdentity(wallet));try{const row=await store.read();if(current()&&(row.operation||row.lastArchivedKey))setFound({wallet,local:true});}
   catch{if(current())setFound({wallet,local:true});}finally{await store.close().catch(()=>undefined);}
  }).catch(()=>{if(current())setFound({wallet,local:true});});
  void api.getPrivate('/game/phase-e/catalogue',{signal:abort.signal,isCurrent:current}).then(raw=>{PhaseECatalogueResponseSchema.parse(raw);if(current())setFound(old=>old?.wallet===wallet&&old.local?old:{wallet,local:false});}).catch(()=>undefined);
  return()=>{active=false;abort.abort();};
 },[wallet,authed]);
 if(!wallet||!authed||found?.wallet!==wallet)return null;
 return <><Btn variant="sec" style={{minHeight:44,position:'absolute',right:12,bottom:'calc(var(--safe-bottom, 0px) + 448px)',zIndex:20}} onClick={()=>setOpen(wallet)}>{found.local?'REALM ACCESS & HISTORY':'REALM ACCESS'}</Btn>
  {open===wallet&&<Suspense fallback={<p role="status">Opening saved realm purchases…</p>}><Screen actionsEnabled={actionsEnabled} trust={trust} onClose={()=>setOpen(null)}/></Suspense>}</>;
}

// The build hold prevents controller hooks and recovery discovery from mounting.
export const RealmSalesEntry = withPhaseEWebHold(RealmSalesEntryEnabled);
