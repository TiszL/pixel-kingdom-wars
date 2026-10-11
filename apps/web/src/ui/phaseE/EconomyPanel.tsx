import {useEffect,useRef,type CSSProperties,type ReactNode} from 'react';
import {COLORS as C,ModalWrap} from '../primitives';
import {hudStripStyle} from '../hudChrome';
import './route-compass.css';
import './economy-panel.css';
/** Shared frame for owned Phase E economy and Workshop journeys. */
export function EconomyPanel({title,eyebrow,icon,onClose,error,children}:{title:string;eyebrow:string;icon?:ReactNode;onClose:()=>void;error?:string|null;children:ReactNode}){
 const dialog=useRef<HTMLDivElement>(null),alert=useRef<HTMLParagraphElement>(null);
 useEffect(()=>{const previous=document.activeElement;dialog.current?.focus();return()=>{if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};},[]);
 useEffect(()=>{if(error)alert.current?.focus();},[error]);
 return <ModalWrap width={760} onBackdrop={onClose}><div ref={dialog} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="sk-equipment-panel sk-economy-panel" style={Object.fromEntries(Object.entries(C).map(([key,value])=>['--sk-'+key,value])) as CSSProperties} onKeyDown={event=>{
  if(event.key==='Escape'){event.preventDefault();onClose();}
  if(event.key==='Tab'){const nodes=[...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],summary,[tabindex="0"]')].filter(node=>{const closed=node.closest('details:not([open])');return !closed||node===closed.querySelector(':scope > summary');}),first=nodes[0],last=nodes.at(-1);if(!first){event.preventDefault();return;}if(event.shiftKey&&(document.activeElement===first||document.activeElement===event.currentTarget)){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
 }}>
 <header className="sk-equipment-header" style={hudStripStyle()}>{icon}<div><p>{eyebrow}</p><h2>{title}</h2></div><button type="button" className="sk-equipment-close" aria-label={'Close '+title} onClick={onClose}>×</button></header>
 <div className="sk-equipment-body sk-economy-body">{error&&<p ref={alert} tabIndex={-1} role="alert">{error}</p>}{children}</div>
 </div></ModalWrap>;
}
