import { phaseEWebEnabled } from './webHold';
import {Component,lazy,Suspense,useEffect,useRef,useSyncExternalStore,type ReactNode} from 'react';
import {useApp} from '../../state/store';
import {divineBattleSession,currentDivineBattle,endDivineBattle,type DivineBattleSession} from '../../lib/divineTrials/battleSession';
const Battle=lazy(()=>import('./DivineTrialBattle').then(m=>({default:m.DivineTrialBattle})));
class TrialBoundary extends Component<{session:DivineBattleSession;children:ReactNode},{failed:boolean}>{state={failed:false};static getDerivedStateFromError(){return {failed:true};}render(){return this.state.failed?<div className="interactive" role="alert" style={{position:'absolute',inset:24,zIndex:1400,pointerEvents:'auto'}}>Trial display could not open. Your original is saved.<button onClick={()=>endDivineBattle(this.props.session)}>RETURN HOME</button></div>:this.props.children;}}
/** An owned or failed Divine view always excludes the ordinary raid component. */
function PhaseEBattleHostEnabled({ordinary,actionsEnabled}:{ordinary:ReactNode;actionsEnabled:boolean}){
 const session=useSyncExternalStore(divineBattleSession.subscribe,divineBattleSession.getSnapshot);
 const mounts=useRef(0);
 useEffect(()=>{if(!session)return;mounts.current++;const check=()=>{if(!currentDivineBattle(session))endDivineBattle(session);};const leave=()=>endDivineBattle(session);const off=useApp.subscribe(check);document.addEventListener('visibilitychange',check);window.addEventListener('focus',check);window.addEventListener('pagehide',leave);check();return()=>{mounts.current--;off();document.removeEventListener('visibilitychange',check);window.removeEventListener('focus',check);window.removeEventListener('pagehide',leave);queueMicrotask(()=>{if(!mounts.current)endDivineBattle(session);});};},[session]);
 return session?<TrialBoundary key={session.token} session={session}><Suspense fallback={<div className="interactive" role="status" style={{position:'absolute',inset:24,zIndex:1400,pointerEvents:'auto'}}>Opening saved trial… <button onClick={()=>endDivineBattle(session)}>RETURN HOME</button></div>}><Battle session={session} actionsEnabled={actionsEnabled}/></Suspense></TrialBoundary>:ordinary;
}

/** Holding Phase E must never hide the ordinary raid surface. */
export function PhaseEBattleHost(props: { ordinary: ReactNode; actionsEnabled: boolean }) {
  return phaseEWebEnabled() ? <PhaseEBattleHostEnabled {...props} /> : props.ordinary;
}
