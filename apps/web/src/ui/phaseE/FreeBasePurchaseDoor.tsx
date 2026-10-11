import { withPhaseEWebHold } from './webHold';
import { useUserCommand } from '../pk/useUserCommand';
import { useEffect,useState } from 'react';
import { FreeBasePurchaseViewSchema } from '@shardkeep/shared/freeBasePurchaseApi';
import { api } from '../../lib/api';
import { captureBaseSnapshotGuard,isBaseSnapshotGuardCurrent,useApp } from '../../state/store';
import { freeBasePurchaseIdentity } from '../../lib/freeBasePurchase/browser';
import { FreeBasePurchaseJournalStore } from '../../lib/freeBasePurchase/journal';
import { PhaseEEntryButton as Btn } from './PhaseEActionDock';
function FreeBasePurchaseDoorEnabled({discover=false,floating=false}:{discover?:boolean;floating?:boolean}):React.JSX.Element|null {
 const requestCommand=useUserCommand(()=>useApp.getState().authed);
 const wallet=useApp(s=>s.wallet),authed=useApp(s=>s.authed),baseId=useApp(s=>s.selectedBaseId),epoch=useApp(s=>s.baseSelectionEpoch);
 const [found,setFound]=useState<{wallet:string;baseId:string|null;local:boolean}|null>(null);
 useEffect(()=>{
  if(!wallet||!authed)return;
  let active=true;const scope=captureBaseSnapshotGuard(),store=new FreeBasePurchaseJournalStore(freeBasePurchaseIdentity(wallet));
  void store.read().then(j=>{if(active&&(j.operation||j.archives.length))setFound({wallet,baseId:null,local:true});})
   .catch(()=>{if(active)setFound({wallet,baseId:null,local:true});}).finally(()=>store.close().catch(()=>undefined));
  if(discover)void api.get(`/bases/free-purchases${baseId?`?sourceBaseId=${encodeURIComponent(baseId)}`:''}`).then(raw=>{
   const view=FreeBasePurchaseViewSchema.parse(raw);
   if(active&&isBaseSnapshotGuardCurrent(scope)&&view.wallet===wallet&&view.sourceBaseId===baseId&&(view.enabled||view.receipt!==null))
    setFound(old=>old?.wallet===wallet&&old.local?old:{wallet,baseId,local:false});
  }).catch(()=>undefined);
  return()=>{active=false;};
 },[wallet,authed,baseId,epoch,discover]);
 if(!authed||found?.wallet!==wallet||!found.local&&found.baseId!==baseId)return null;
 return <Btn variant="sec" style={{minHeight:44,...(floating?{position:'absolute',right:12,bottom:'calc(var(--safe-bottom, 0px) + 352px)',zIndex:20}:{width:'100%'})}}
  onClick={()=>requestCommand(()=>useApp.getState().setScreen('free-base-purchase'))}>{found.local?'SECOND KINGDOM & SAVED PURCHASE':'SECOND KINGDOM'}</Btn>;
}

// The build hold prevents controller hooks and recovery discovery from mounting.
export const FreeBasePurchaseDoor = withPhaseEWebHold(FreeBasePurchaseDoorEnabled);
