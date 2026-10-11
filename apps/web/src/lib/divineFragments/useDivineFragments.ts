import { useEffect,useMemo,useRef,useState,useSyncExternalStore } from 'react';
import { useApp } from '../../state/store';
import { mutationGate } from '../mutationGate';
import { createDivineFragmentsBrowserPorts,divineFragmentsIdentity } from './browser';
import { DivineFragmentsController,emptyDivineFragmentsState } from './controller';
import { DivineFragmentsJournalStore } from './journal';
const emptySnapshot=()=>emptyDivineFragmentsState,emptySubscribe=()=>()=>undefined;
export function useDivineFragments(actionsEnabled:boolean){
 const wallet=useApp(s=>s.wallet),authed=useApp(s=>s.authed),baseId=useApp(s=>s.selectedBaseId),baseEpoch=useApp(s=>s.baseSelectionEpoch);
 const gate=useSyncExternalStore(mutationGate.subscribe,mutationGate.getSnapshot),actionsAllowed=actionsEnabled&&gate,allowed=useRef(actionsAllowed);allowed.current=actionsAllowed;
 const [working,setWorking]=useState<object|null>(null);
 const owned=useMemo(()=>{if(!wallet||!authed)return null;
  const lifecycle={active:true,visible:document.visibilityState!=='hidden',epoch:0,baseEpoch:useApp.getState().baseSelectionEpoch},screen=useApp.getState().screen,owner={};
  const store=new DivineFragmentsJournalStore(divineFragmentsIdentity(wallet));
  const ports=createDivineFragmentsBrowserPorts({identity:store.identity,lifecycle:()=>({...lifecycle,actionsEnabled:allowed.current,active:lifecycle.active&&useApp.getState().screen===screen})});
  const controller=new DivineFragmentsController(store,ports);let pending=0,queued=false,closed=false;
  const closeIfIdle=()=>queueMicrotask(()=>{if(!lifecycle.active&&!pending&&!closed){closed=true;void store.close().catch(()=>undefined);}});
  const invoke=(action:(c:DivineFragmentsController)=>Promise<void>)=>{if(closed||!lifecycle.active||!lifecycle.visible)return;if(pending){queued=true;return;}
   pending++;lifecycle.baseEpoch=useApp.getState().baseSelectionEpoch;setWorking(owner);void action(controller).finally(()=>{pending--;if(queued&&lifecycle.active&&lifecycle.visible){queued=false;invoke(c=>c.open(useApp.getState().selectedBaseId??undefined));}
    else if(lifecycle.active)setWorking(old=>old===owner?null:old);closeIfIdle();});};
  const observe=()=>invoke(c=>c.open(useApp.getState().selectedBaseId??undefined));return {owner,controller,lifecycle,invoke,observe,closeIfIdle};
 },[wallet,authed]);
 const state=useSyncExternalStore(owned?.controller.subscribe??emptySubscribe,owned?.controller.snapshot??emptySnapshot);
 useEffect(()=>{if(!owned)return;owned.lifecycle.active=true;owned.lifecycle.visible=document.visibilityState!=='hidden';
  const suspend=()=>{owned.lifecycle.visible=false;owned.lifecycle.epoch++;owned.controller.dismiss();};
  const resume=()=>{owned.lifecycle.visible=document.visibilityState!=='hidden';owned.observe();};
  const visibility=()=>document.visibilityState==='hidden'?suspend():resume();
  document.addEventListener('visibilitychange',visibility);document.addEventListener('freeze',suspend);document.addEventListener('resume',resume);
  window.addEventListener('pagehide',suspend);window.addEventListener('pageshow',resume);window.addEventListener('focus',resume);window.addEventListener('online',resume);owned.observe();
  return()=>{owned.lifecycle.active=false;suspend();document.removeEventListener('visibilitychange',visibility);document.removeEventListener('freeze',suspend);document.removeEventListener('resume',resume);
   window.removeEventListener('pagehide',suspend);window.removeEventListener('pageshow',resume);window.removeEventListener('focus',resume);window.removeEventListener('online',resume);owned.closeIfIdle();};
 },[owned]);
 useEffect(()=>{if(owned){owned.lifecycle.epoch++;owned.controller.dismiss();owned.observe();}},[owned,baseId,baseEpoch,actionsAllowed]);
 return {baseId,actionsAllowed,state:{...state,stock:owned?.lifecycle.baseEpoch===baseEpoch?state.stock:null,busy:state.busy||working===owned?.owner},
  run:(action:(c:DivineFragmentsController)=>Promise<void>)=>owned?.invoke(action),refresh:()=>owned?.observe(),
  dismiss:()=>{if(owned){owned.lifecycle.epoch++;owned.controller.dismiss();}}};
}
