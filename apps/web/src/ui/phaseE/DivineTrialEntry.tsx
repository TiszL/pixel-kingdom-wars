import { withPhaseEWebHold } from './webHold';
import {lazy,Suspense,useState} from 'react';
import {useApp} from '../../state/store';
import {PhaseEEntryButton} from './PhaseEActionDock';
const Screen=lazy(()=>import('./DivineTrialScreen').then(m=>({default:m.DivineTrialScreen})));
function DivineTrialEntryEnabled({actionsEnabled,onOpen}:{actionsEnabled:boolean;onOpen?:(()=>void)|undefined}){const wallet=useApp(s=>s.wallet),authed=useApp(s=>s.authed),[open,setOpen]=useState<string|null>(null);if(!wallet||!authed)return null;return <><PhaseEEntryButton variant="sec" onClick={()=>onOpen?onOpen():setOpen(wallet)}>DIVINE TRIALS</PhaseEEntryButton>{open===wallet&&<Suspense fallback={<p role="status">Opening trial history…</p>}><Screen actionsEnabled={actionsEnabled} onClose={()=>setOpen(null)}/></Suspense>}</>;}

// The build hold prevents controller hooks and recovery discovery from mounting.
export const DivineTrialEntry = withPhaseEWebHold(DivineTrialEntryEnabled);
