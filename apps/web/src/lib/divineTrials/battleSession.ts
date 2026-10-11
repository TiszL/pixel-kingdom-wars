/** Tiny canvas ownership selector, deliberately free of feature/schema/sim imports. */
import {authCookies} from '../../auth/authCookieCoordinator';
import {useApp} from '../../state/store';
import {bus} from '../events';
export type DivineBattleSession={token:number;wallet:string;baseId:string;selectionEpoch:number;generation:number;eventId:string;attemptId:string};
let owner:DivineBattleSession|null=null,epoch=0,ending=false;const listeners=new Set<()=>void>();
const changed=()=>listeners.forEach(fn=>fn());
export const divineBattleSession={getSnapshot:()=>owner,getEpoch:()=>epoch,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};}};
export function beginDivineBattle(input:{wallet:string;eventId:string;attemptId:string}):DivineBattleSession{
 const s=useApp.getState();if(owner||!s.booted||!s.authed||s.wallet!==input.wallet||!s.selectedBaseId||!['base','build','bases'].includes(s.screen)||document.visibilityState==='hidden')throw Error('Open this trial from your current kingdom.');
 const next={...input,token:++epoch,baseId:s.selectedBaseId,selectionEpoch:s.baseSelectionEpoch,generation:authCookies.captureGeneration()};owner=next;changed();s.setScreen('battle');return next;
}
export function currentDivineBattle(session:DivineBattleSession){const s=useApp.getState();return owner===session&&s.authed&&s.wallet===session.wallet&&s.selectedBaseId===session.baseId&&s.baseSelectionEpoch===session.selectionEpoch&&s.screen==='battle'&&authCookies.current(session.generation)&&document.visibilityState!=='hidden';}
export function endDivineBattle(session:DivineBattleSession){if(owner!==session||ending)return;ending=true;try{try{bus.emit('battle:holdCancel',undefined);}finally{try{bus.emit('battle:exit',undefined);}finally{const s=useApp.getState();if(s.screen==='battle')s.setScreen(s.authed?'base':'title');}}}finally{if(owner===session){owner=null;epoch++;changed();}ending=false;}}
