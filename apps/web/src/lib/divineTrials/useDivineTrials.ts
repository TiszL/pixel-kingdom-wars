import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {useApp} from '../../state/store';
import {mutationGate} from '../mutationGate';
import {DivineTrialController,emptyDivineState} from './controller';
import {DivineTrialJournalStore} from './journal';
import {browserDivineIdentity,createDivineBrowserPorts} from './browser';
const empty=emptyDivineState(),emptySnapshot=()=>empty,emptySubscribe=()=>()=>undefined;
export function useDivineTrials(actionsEnabled:boolean,eventId?:string){
 const wallet=useApp(s=>s.wallet),authed=useApp(s=>s.authed),screen=useApp(s=>s.screen),gate=useSyncExternalStore(mutationGate.subscribe,mutationGate.getSnapshot),allowed=useRef(actionsEnabled&&gate);allowed.current=actionsEnabled&&gate;
 const [ready,setReady]=useState<DivineTrialController|null>(null);
 const owned=useMemo(()=>{if(!wallet||!authed)return null;const lifecycle={active:false,visible:document.visibilityState!=='hidden',epoch:0};let controller:DivineTrialController|null=null,store:DivineTrialJournalStore|null=null,pending=0,closed=false;
  const close=()=>queueMicrotask(()=>{if(!lifecycle.active&&!pending&&!closed){closed=true;void store?.close().catch(()=>undefined);}});
  const invoke=(fn:(c:DivineTrialController)=>Promise<unknown>)=>{if(!controller||!lifecycle.active||!lifecycle.visible||pending||closed)return;pending++;void Promise.resolve().then(()=>fn(controller!)).catch(()=>undefined).finally(()=>{pending--;close();});};
  return {lifecycle,start:()=>{lifecycle.active=true;lifecycle.visible=document.visibilityState!=='hidden';if(!controller){store=new DivineTrialJournalStore(browserDivineIdentity(wallet));controller=new DivineTrialController(store,createDivineBrowserPorts({identity:store.identity,lifecycle:()=>({...lifecycle,active:lifecycle.active&&useApp.getState().screen===screen,actionsEnabled:allowed.current})}));}return controller;},current:()=>controller,invoke,close};
 },[wallet,authed,screen]);
 const controller=ready===owned?.current()?ready:null,state=useSyncExternalStore(controller?.subscribe??emptySubscribe,controller?.getSnapshot??emptySnapshot);
 useEffect(()=>{if(!owned)return;const c=owned.start();setReady(c);const hidden=()=>{owned.lifecycle.visible=false;owned.lifecycle.epoch++;};const visible=()=>{owned.lifecycle.visible=document.visibilityState!=='hidden';};const visibility=()=>document.visibilityState==='hidden'?hidden():visible();document.addEventListener('visibilitychange',visibility);document.addEventListener('freeze',hidden);document.addEventListener('resume',visible);window.addEventListener('pagehide',hidden);window.addEventListener('pageshow',visible);owned.invoke(x=>eventId?x.open(eventId):x.load());return()=>{owned.lifecycle.active=false;hidden();document.removeEventListener('visibilitychange',visibility);document.removeEventListener('freeze',hidden);document.removeEventListener('resume',visible);window.removeEventListener('pagehide',hidden);window.removeEventListener('pageshow',visible);owned.close();};},[owned,eventId]);
 return {state,controller,actionsAllowed:actionsEnabled&&gate,run:(fn:(c:DivineTrialController)=>Promise<unknown>)=>owned?.invoke(fn)};
}
