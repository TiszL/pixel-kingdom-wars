import { withPhaseEWebHold } from './webHold';
import {lazy,Suspense,useState} from 'react';
import {useApp} from '../../state/store';
import {PhaseEEntryButton} from './PhaseEActionDock';
const Screen=lazy(()=>import('./RouteCompassScreen').then(m=>({default:m.RouteCompassScreen})));
function RouteCompassEntryEnabled({actionsEnabled}:{actionsEnabled:boolean}){const wallet=useApp(s=>s.wallet),authed=useApp(s=>s.authed),[open,setOpen]=useState<string|null>(null);if(!wallet||!authed)return null;return <><PhaseEEntryButton variant="sec" onClick={()=>setOpen(wallet)}>EXPEDITION EQUIPMENT</PhaseEEntryButton>{open===wallet&&<Suspense fallback={<p role="status">Opening equipment stores…</p>}><Screen actionsEnabled={actionsEnabled} onClose={()=>setOpen(null)}/></Suspense>}</>;}

// The build hold prevents controller hooks and recovery discovery from mounting.
export const RouteCompassEntry = withPhaseEWebHold(RouteCompassEntryEnabled);
