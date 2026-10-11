import { withPhaseEWebHold } from './webHold';
import {lazy,Suspense,useEffect,useState} from 'react';
import {PhaseECatalogueResponseSchema} from '@shardkeep/shared/phaseE';
import {authCookies} from '../../auth/authCookieCoordinator';
import {api} from '../../lib/api';
import type {MiningTaxClaimSigningTrust} from '../../lib/miningTaxClaims/signing';
import {useApp} from '../../state/store';
import {PhaseEEntryButton as Btn} from './PhaseEActionDock';
const Screen=lazy(()=>import('./MiningTaxClaimsScreen').then(m=>({default:m.MiningTaxClaimsScreen})));
/** Discovery is read-only. Deployment and historical verification pins are
 * independent application inputs; neither catalogue nor storage supplies them. */
function MiningTaxClaimsEntryEnabled({actionsEnabled,trust=null,recoveryTrust=trust}:{actionsEnabled:boolean;trust?:MiningTaxClaimSigningTrust|null;recoveryTrust?:MiningTaxClaimSigningTrust|null}):React.JSX.Element|null{
 const wallet=useApp(s=>s.wallet),authed=useApp(s=>s.authed),[found,setFound]=useState<{wallet:string;local:boolean}|null>(null),[open,setOpen]=useState<string|null>(null);
 useEffect(()=>{
  if(!wallet||!authed)return;let active=true;const abort=new AbortController(),generation=authCookies.captureGeneration();
  const current=()=>active&&authCookies.current(generation)&&useApp.getState().authed&&useApp.getState().wallet===wallet;
  void Promise.all([import('../../lib/miningTaxClaims/journal'),import('../../lib/miningTaxClaims/browser')]).then(async([journal,browser])=>{
   if(current()&&await journal.hasMiningTaxClaimRecovery(browser.miningTaxClaimIdentity(wallet))&&current())setFound({wallet,local:true});
  }).catch(()=>{if(current())setFound({wallet,local:true});});
  void api.getPrivate('/game/phase-e/catalogue',{signal:abort.signal,isCurrent:current}).then(raw=>{PhaseECatalogueResponseSchema.parse(raw);if(current())setFound(old=>old?.wallet===wallet&&old.local?old:{wallet,local:false});}).catch(()=>undefined);
  return()=>{active=false;abort.abort();};
 },[wallet,authed]);
 if(!wallet||!authed||found?.wallet!==wallet)return null;
 return <><Btn variant="sec" style={{minHeight:44,position:'absolute',right:12,bottom:'calc(var(--safe-bottom, 0px) + 496px)',zIndex:20}} onClick={()=>setOpen(wallet)}>{found.local?'KEEP TAX & HISTORY':'KEEP TAX CLAIMS'}</Btn>
  {open===wallet&&<Suspense fallback={<p role="status">Opening saved KEEP tax claims…</p>}><Screen actionsEnabled={actionsEnabled} trust={trust} recoveryTrust={recoveryTrust} onClose={()=>setOpen(null)}/></Suspense>}</>;
}

// The build hold prevents controller hooks and recovery discovery from mounting.
export const MiningTaxClaimsEntry = withPhaseEWebHold(MiningTaxClaimsEntryEnabled);
