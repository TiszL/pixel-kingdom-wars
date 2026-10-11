import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {VehicleCraftHistoryPageSchema,VehicleCraftQuoteSchema,VehicleCraftRecoverySchema,type VehicleCraftQuote,type VehicleCraftRecord,type VehicleCraftQuoteRequest} from '@shardkeep/shared/vehicleCraftClientApi';
import {useApp} from '../../state/store';
import {browserVehicleIdentity} from '../vehicles/browser';
import {mutationGate} from '../mutationGate';
import {VehicleCraftCache} from './cache';
import {requestVehicleCraft} from './transport';
type View={wallet:string|null;records:VehicleCraftRecord[];cursor:string|null;loaded:boolean;busy:boolean;error:string|null};
const empty:View={wallet:null,records:[],cursor:null,loaded:false,busy:false,error:null};
const message=(e:unknown)=>e instanceof Error?e.message:'Vehicle craft history is unavailable.';
export function useVehicleCraft(){
 const wallet=useApp(s=>s.wallet),authed=useApp(s=>s.authed),baseId=useApp(s=>s.selectedBaseId),screen=useApp(s=>s.screen),selection=useApp(s=>s.baseSelectionEpoch);
 const cache=useMemo(()=>wallet&&authed?new VehicleCraftCache(browserVehicleIdentity(wallet)):null,[wallet,authed]);
 const [view,setView]=useState<View>(empty),[quote,setQuote]=useState<VehicleCraftQuote|null>(null),[quoteError,setQuoteError]=useState<string|null>(null),[quoting,setQuoting]=useState(false);
 const life=useMemo(()=>({active:false,epoch:0,working:0}),[cache,screen]),quoteEpoch=useRef(0);
 const visible=view.wallet===wallet&&authed?view:empty;
 function capture(selectedBase?:string){const epoch=life.epoch,selection=useApp.getState().baseSelectionEpoch;return()=>{const now=useApp.getState();return life.active&&life.epoch===epoch&&now.wallet===wallet&&now.authed&&now.screen===screen&&document.visibilityState!=='hidden'&&(selectedBase===undefined||now.baseSelectionEpoch===selection&&now.selectedBaseId===selectedBase&&mutationGate.getSnapshot());};}
 async function history(cursor?:string){
  if(!cache||life.working)return;const operation=++life.working,epoch=life.epoch,current=capture();
  setView(v=>({...v,wallet,error:null,busy:true}));
  try{const page=VehicleCraftHistoryPageSchema.parse(await requestVehicleCraft({wallet:cache.identity.wallet,request:{kind:'history',...(cursor?{cursor}:{})},isCurrent:current,retain:r=>cache.retain(r).then(()=>undefined)}));
   if(current())setView({wallet,records:cache.read(),cursor:page.nextCursor,loaded:true,busy:false,error:null});
  }catch(e){if(current())setView(v=>({...v,wallet,loaded:true,busy:false,error:message(e)}));}
  finally{if(life.epoch===epoch&&life.working===operation)life.working=0;if(life.active&&life.epoch===epoch)setView(v=>v.wallet===wallet?{...v,busy:false}:v);}
 }
 async function recover(key:string){
  if(!cache||life.working)return;const operation=++life.working,epoch=life.epoch,current=capture();setView(v=>({...v,error:null,busy:true}));
  try{const result=VehicleCraftRecoverySchema.parse(await requestVehicleCraft({wallet:cache.identity.wallet,request:{kind:'recover',key},isCurrent:current,retain:r=>cache.retain(r).then(()=>undefined)}));
   if(current())setView(v=>({...v,records:cache.read(),busy:false,error:result.status==='held'?'A fresh outcome could not be confirmed. Your saved original remains below.':null}));
  }catch(e){if(current())setView(v=>({...v,busy:false,error:message(e)}));}
  finally{if(life.epoch===epoch&&life.working===operation)life.working=0;if(life.active&&life.epoch===epoch)setView(v=>v.wallet===wallet?{...v,busy:false}:v);}
 }
 const clearQuote=useCallback(()=>{quoteEpoch.current++;setQuote(null);setQuoteError(null);setQuoting(false);},[]);
 async function preview(request:VehicleCraftQuoteRequest){
  if(!cache)return;const epoch=++quoteEpoch.current,current=capture(request.baseId);setQuote(null);setQuoteError(null);setQuoting(true);
  try{const value=VehicleCraftQuoteSchema.parse(await requestVehicleCraft({wallet:cache.identity.wallet,request:{kind:'quote',request},isCurrent:()=>current()&&quoteEpoch.current===epoch,retain:async()=>{throw Error('A preview cannot replace a craft receipt.');}}));if(current()&&quoteEpoch.current===epoch)setQuote(value);}
  catch(e){if(current()&&quoteEpoch.current===epoch)setQuoteError(message(e));}
  finally{if(life.active&&quoteEpoch.current===epoch)setQuoting(false);}
 }
 useEffect(()=>{
  life.active=true;life.epoch++;life.working=0;setQuote(null);setQuoteError(null);
  if(cache){try{setView({wallet,records:cache.read(),cursor:null,loaded:false,busy:false,error:null});void history();}catch(e){setView({wallet,records:[],cursor:null,loaded:true,busy:false,error:message(e)});}}
  else setView(empty);
  return()=>{life.active=false;life.epoch++;quoteEpoch.current++;};
 // This effect owns one authenticated actor lifetime; requests capture it.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[cache,screen,life]);
 useEffect(()=>{clearQuote();},[baseId,selection,clearQuote]);
 useEffect(()=>{const invalidate=()=>{quoteEpoch.current++;setQuote(null);setQuoteError(null);setQuoting(false);};document.addEventListener('visibilitychange',invalidate);document.addEventListener('freeze',invalidate);window.addEventListener('pagehide',invalidate);return()=>{document.removeEventListener('visibilitychange',invalidate);document.removeEventListener('freeze',invalidate);window.removeEventListener('pagehide',invalidate);};},[]);
 return {...visible,quote:quote?.wallet===wallet&&quote.baseId===baseId?quote:null,quoteError,quoting,preview,clearQuote,refresh:()=>history(),more:()=>visible.cursor?history(visible.cursor):Promise.resolve(),recover};
}
