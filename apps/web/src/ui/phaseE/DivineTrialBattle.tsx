import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {PHASE_E_DIVINE_TRIALS as P} from '@shardkeep/shared';
import {DivineBattleController,type DivineBattleState} from '../../lib/divineTrials/battleController';
import {currentDivineBattle,endDivineBattle,type DivineBattleSession} from '../../lib/divineTrials/battleSession';
import {useDivineTrials} from '../../lib/divineTrials/useDivineTrials';
import {bus} from '../../lib/events';
import {useMobileBackHandler} from '../../lib/mobileBackGuard';
import {readGameViewport,readGameUiViewport,subscribeGameViewport} from '../../lib/gameViewport';
import {readSafeAreaInsets} from '../layout';
import {Btn,Panel9,Pill} from '../primitives';
const idle:DivineBattleState={ready:false,selected:'highlander',deploys:[],playing:false,displayed:false,error:null},empty=()=>idle,off=()=>()=>undefined;
const stop=(e:{stopPropagation():void})=>e.stopPropagation(),prevent=(e:{preventDefault():void})=>e.preventDefault();
export function DivineTrialBattle({session,actionsEnabled}:{session:DivineBattleSession;actionsEnabled:boolean}){
 const {state,run,actionsAllowed}=useDivineTrials(actionsEnabled,session.eventId),[renderer,setRenderer]=useState<DivineBattleController|null>(null),hud=useRef<HTMLDivElement>(null);
 const row=state.journal?.events.find(e=>e.eventId===session.eventId),saved=row?.attempts.find(a=>a.original?.id===session.attemptId),attempt=saved?.original,view=useSyncExternalStore(renderer?.subscribe??off,renderer?.getSnapshot??empty),close=()=>endDivineBattle(session);
 useMobileBackHandler(close,true,120);
 useEffect(()=>{if(!attempt||!currentDivineBattle(session))return;const controller=new DivineBattleController(attempt,()=>currentDivineBattle(session));setRenderer(controller);controller.start();return()=>controller.stop();},[session,attempt?.id]);
 useEffect(()=>{if(renderer&&attempt)renderer.update(attempt);},[renderer,attempt]);
 useEffect(()=>{const publish=()=>{if(!currentDivineBattle(session)||!hud.current)return;const safe=readSafeAreaInsets(),canvas=document.querySelector('[data-game-canvas-container]')?.getBoundingClientRect(),rect=hud.current.getBoundingClientRect();bus.emit('battle:insets',{top:safe.top,bottom:Math.max(safe.bottom+Math.max(0,readGameViewport().h-readGameUiViewport().h),(canvas?.bottom??readGameViewport().h)-rect.top),left:safe.left,right:safe.right});};const dispose=bus.on('battle:insetsRequest',publish),viewport=subscribeGameViewport(publish),observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(publish);if(hud.current)observer?.observe(hud.current);publish();return()=>{dispose();viewport();observer?.disconnect();};},[session,attempt?.id]);
 const planning=attempt?.status==='admitted'&&!saved?.orders&&!saved?.abandon,disabled=state.busy||!view.ready||!actionsAllowed||!currentDivineBattle(session);
 return <div onMouseDown={stop} onTouchStart={stop} onDragStart={prevent} onContextMenu={prevent} style={{pointerEvents:'none',userSelect:'none',WebkitUserSelect:'none',WebkitTouchCallout:'none'}}><div ref={hud} className="interactive" aria-label="Divine trial controls" style={{position:'absolute',bottom:'env(safe-area-inset-bottom)',left:8,right:8,zIndex:1400,pointerEvents:'auto'}}><Panel9 style={{padding:12,maxHeight:'42vh',overflowY:'auto'}}>
 <strong>DIVINE TRIAL · attempt {attempt?.ordinal??'…'}/{P.attemptsPerWallet}</strong><p>Same fixed army for every entrant. No energy or owned troops are spent.</p>{state.error&&<p role="alert">{state.error}</p>}{view.error&&<p role="alert">{view.error}</p>}{!actionsAllowed&&<p role="status">New commands are paused. Exact saved recovery remains available.</p>}
 {planning&&<><p>Choose a troop, then tap an empty deployment tile. Place all {P.maxDeploys} troops before submitting.</p><div style={{display:'flex',gap:8,flexWrap:'wrap',touchAction:'pan-x'}}>{(Object.keys(P.army) as Array<keyof typeof P.army>).map(t=><Btn key={t} variant={view.selected===t?'gold':'sec'} disabled={disabled} aria-pressed={view.selected===t} onClick={()=>renderer?.choose(t)}>{t.toUpperCase()} · {P.army[t]-view.deploys.filter(d=>d.troop===t).length} left</Btn>)}<Btn variant="sec" disabled={disabled||!view.deploys.length} onClick={()=>renderer?.undo()}>UNDO LAST</Btn><Btn disabled={disabled||view.deploys.length!==P.maxDeploys} onClick={()=>{if(!renderer)return;const plan=renderer.freeze();run(c=>c.submit(session.attemptId,plan));}}>SUBMIT FIXED PLAN</Btn></div></>}
 {attempt?.result&&<Pill>Canonical result: {attempt.result.stars} stars · {attempt.result.destruction}%{view.playing?' · replaying':view.displayed?' · replay complete':''}</Pill>}
 {saved?.orders&&!attempt?.result&&<p role="status">Exact plan saved. Recovery never changes its troops or positions.</p>}
 <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:8}}><Btn variant="sec" disabled={state.busy} onClick={()=>run(c=>c.recover(true))}>RECOVER ORIGINAL</Btn>{planning&&<Btn variant="sec" style={{maxWidth:'100%'}} disabled={state.busy} onClick={()=>run(c=>c.abandon(session.attemptId))}>ABANDON UNSUBMITTED ATTEMPT</Btn>}<Btn variant="sec" onClick={()=>bus.emit('battle:camera',{op:'fit'})}>FIT FIELD</Btn><Btn variant="sec" onClick={close}>RETURN HOME</Btn></div>{attempt?.completedAt&&!attempt.result&&<p>This attempt is {attempt.status}. It consumes its ordinal and has no score.</p>}
 </Panel9></div></div>;
}
