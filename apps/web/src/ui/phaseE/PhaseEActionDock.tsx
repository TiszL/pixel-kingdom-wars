import { withPhaseEWebHold } from './webHold';
import {createContext,useCallback,useContext,useEffect,useRef,useState,type ComponentProps,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {Btn,COLORS as C,GAME_FONT,Icon} from '../primitives';
import {hudStripStyle,hudTabStyle} from '../hudChrome';
import {useMobileBackHandler} from '../../lib/mobileBackGuard';

const GROUPS=[
 ['kingdom','Kingdom & economy'],['fleet','Fleet & travel'],['clan','Clan'],['islands','Island rewards'],
] as const;
type ActionGroup=typeof GROUPS[number][0];
type ActionHosts=Partial<Record<ActionGroup,HTMLDivElement>>;
const ActionsHost=createContext<{hosts:ActionHosts;launch:()=>void}|undefined>(undefined);
const ActionsGroup=createContext<ActionGroup>('kingdom');

export function PhaseEActionGroup({group,children}:{group:ActionGroup;children:ReactNode}):React.JSX.Element{
 return <ActionsGroup.Provider value={group}>{children}</ActionsGroup.Provider>;
}

/** Only launch buttons move into the dock. Dialogs keep their overlay parent,
 * outside the scrolling menu, so game-sized panels cannot be clipped by it. */
function PhaseEEntryButtonEnabled(props:ComponentProps<typeof Btn>):React.JSX.Element|null{
 const dock=useContext(ActionsHost),group=useContext(ActionsGroup);
 if(dock===undefined)return <Btn {...props}/>;
 const host=dock.hosts[group];
 if(!host)return null;
 return createPortal(<Btn {...props} onClick={()=>{dock.launch();props.onClick?.();}} fontSize={18} style={{...hudTabStyle('nav'),width:'100%',minHeight:48,color:C.text,padding:'10px 12px',whiteSpace:'normal',textAlign:'left',justifyContent:'flex-start',letterSpacing:0,boxShadow:'none'}}/>,host);
}
function PhaseEActionDockEnabled({children}:{children:ReactNode}):React.JSX.Element{
 const [menu,setMenu]=useState<HTMLDivElement|null>(null),[hosts,setHosts]=useState<ActionHosts>({});
 const [available,setAvailable]=useState<ActionGroup[]>([]),[open,setOpen]=useState(false),toggle=useRef<HTMLButtonElement>(null);
 const close=useCallback(()=>{setOpen(false);toggle.current?.focus();},[]);
 useEffect(()=>{
  if(!menu)return;
  const targets:ActionHosts={};
  for(const [group] of GROUPS){const target=menu.querySelector<HTMLDivElement>(`[data-action-group="${group}"]`);if(target)targets[group]=target;}
  setHosts(targets);
  const sync=()=>{
   const next=GROUPS.map(([group])=>group).filter(group=>(targets[group]?.childElementCount??0)>0);
   setAvailable(previous=>previous.join()===next.join()?previous:next);
  },observer=new MutationObserver(sync);
  // Portal events follow their feature's React parent, outside this nav.
  // Listen at the menu DOM boundary so Escape also works from launch buttons.
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}};
  menu.addEventListener('keydown',escape);
  observer.observe(menu,{childList:true,subtree:true});sync();
  return()=>{observer.disconnect();menu.removeEventListener('keydown',escape);};
 },[menu,close]);
 useEffect(()=>{if(open)menu?.querySelector<HTMLButtonElement>('section:not([hidden]) button:not(:disabled)')?.focus();},[open,menu]);
 useMobileBackHandler(()=>{close();return true;},open,200);
 return <>
  <style>{`.phase-e-action-dock button:focus-visible{outline:2px solid ${C.text};outline-offset:2px}`}</style>
  <nav className="interactive phase-e-action-dock" aria-label="Kingdom activities" hidden={available.length===0} onKeyDown={event=>{if(open&&event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}}}
   style={{position:'absolute',right:'calc(12px + env(safe-area-inset-right))',bottom:'calc(108px + var(--safe-bottom, 0px))',zIndex:1100,maxWidth:'calc(100% - 24px)',width:open?300:'max-content',fontFamily:GAME_FONT}}>
   <div id="phase-e-actions" ref={setMenu} hidden={!open} style={{...hudStripStyle(),display:open?'grid':'none',gap:16,padding:12,maxHeight:'min(420px, calc(100dvh - 230px))',overflowY:'auto',overscrollBehavior:'contain',marginBottom:6}}>
    {GROUPS.map(([group,label])=><section key={group} aria-labelledby={`phase-e-${group}-heading`} hidden={!available.includes(group)}>
     <h2 id={`phase-e-${group}-heading`} style={{margin:'0 0 8px',paddingBottom:6,borderBottom:`1px solid ${C.borderLt}`,fontSize:18,fontWeight:400,color:C.goldHi}}>{label}</h2>
     <div data-action-group={group} style={{display:'grid',gap:6}}/>
    </section>)}
   </div>
   <button ref={toggle} type="button" aria-controls="phase-e-actions" aria-expanded={open} onClick={()=>{if(open)close();else setOpen(true);}} style={{...hudTabStyle('nav'),fontFamily:GAME_FONT,fontSize:20,color:C.goldHi,minHeight:48,padding:'8px 14px',display:'flex',gap:8,alignItems:'center',marginLeft:'auto',cursor:'pointer'}}>
    <Icon name="quest" size={24}/> KINGDOM <span aria-hidden="true">{open?'▾':'▴'}</span>
   </button>
  </nav>
  {/* Focus the visible opener before a feature mounts its dialog, so closing
      that dialog restores focus outside the now-hidden launch list. */}
  <ActionsHost.Provider value={{hosts,launch:close}}>{children}</ActionsHost.Provider>
 </>;
}

// The build hold prevents controller hooks and recovery discovery from mounting.
export const PhaseEActionDock = withPhaseEWebHold(PhaseEActionDockEnabled);
export const PhaseEEntryButton = withPhaseEWebHold(PhaseEEntryButtonEnabled);
