import { withPhaseEWebHold } from './webHold';
import {lazy,Suspense,useEffect,useState} from 'react';
import {CharterActivitySchema} from '@shardkeep/shared/charterApi';
import {CharterMigrationActivitySchema} from '@shardkeep/shared/charterMigrationApi';
import {authCookies} from '../../auth/authCookieCoordinator';
import {api} from '../../lib/api';
import type {CharterSigningTrust} from '../../lib/charter/signing';
import {useApp} from '../../state/store';
import {PhaseEEntryButton as Btn} from './PhaseEActionDock';
const Screen=lazy(()=>import('./CharterScreen').then(m=>({default:m.CharterScreen})));
/** Discovery never supplies trust. Production pins remain null until reviewed. */
function CharterEntryEnabled({actionsEnabled,trust=null}:{actionsEnabled:boolean;trust?:CharterSigningTrust|null}):React.JSX.Element|null{
 const wallet=useApp(s=>s.wallet),authed=useApp(s=>s.authed),[found,setFound]=useState<string|null>(null),[open,setOpen]=useState<string|null>(null);
 useEffect(()=>{if(!wallet||!authed)return;let active=true;const generation=authCookies.captureGeneration(),abort=new AbortController(),current=()=>active&&authCookies.current(generation)&&useApp.getState().authed&&useApp.getState().wallet===wallet;
  void Promise.all([import('../../lib/charter/journal'),import('../../lib/charter/browser')]).then(async([journal,browser])=>{if(!current())return;const store=new journal.CharterJournalStore(browser.browserCharterIdentity(wallet));try{const row=await store.read();if(current()&&(row.operation||row.lastArchivedKey))setFound(wallet);}catch{if(current())setFound(wallet);}finally{await store.close().catch(()=>undefined);}}).catch(()=>{if(current())setFound(wallet);});
  void Promise.all([import('../../lib/charterRetirement/journal'),import('../../lib/charterRetirement/browser')]).then(async([journal,browser])=>{if(!current())return;const store=new journal.RetirementJournalStore(browser.browserRetirementIdentity(wallet));try{const row=await store.read();if(current()&&(row.request||row.draftId||(await store.archives()).length))setFound(wallet);}catch{if(current())setFound(wallet);}finally{await store.close().catch(()=>undefined);}}).catch(()=>{if(current())setFound(wallet);});
  void Promise.all([import('../../lib/charterMigration/journal'),import('../../lib/charterMigration/browser')]).then(async([journal,browser])=>{if(!current())return;const store=new journal.MigrationJournalStore(browser.browserMigrationIdentity(wallet));try{const row=await store.read();if(current()&&(row.request||row.migrationId||(await store.archives()).length))setFound(wallet);}catch{if(current())setFound(wallet);}finally{await store.close().catch(()=>undefined);}}).catch(()=>{if(current())setFound(wallet);});
  void api.getPrivate('/clans/charter/migrations/activity',{signal:abort.signal,isCurrent:current}).then(raw=>{const activity=CharterMigrationActivitySchema.parse(raw);if(current()&&activity.actor===wallet&&(activity.currentClan||activity.items.length))setFound(wallet);}).catch(()=>undefined);
  void api.getPrivate('/clans/charter/client/activity',{signal:abort.signal,isCurrent:current}).then(raw=>{const activity=CharterActivitySchema.parse(raw);if(current()&&activity.actor===wallet&&(activity.items.length||activity.newActions.creation||activity.newActions.sale))setFound(wallet);}).catch(()=>undefined);
  return()=>{active=false;abort.abort();};
 },[wallet,authed]);
 if(!wallet||!authed||found!==wallet)return null;
 return <><Btn variant="sec" onClick={()=>setOpen(wallet)}>CHARTERS &amp; HISTORY</Btn>{open===wallet&&<Suspense fallback={<p role="status">Opening saved Charters…</p>}><Screen actionsEnabled={actionsEnabled} trust={trust} onClose={()=>setOpen(null)}/></Suspense>}</>;
}

// The build hold prevents controller hooks and recovery discovery from mounting.
export const CharterEntry = withPhaseEWebHold(CharterEntryEnabled);
