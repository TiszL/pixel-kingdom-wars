/** Local-only connected presentation: original screen, authenticated normal GETs. */
import {Buffer} from 'buffer';
(globalThis as {Buffer?:typeof Buffer}).Buffer=Buffer;
import {useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {RealmPassportEntry} from '../src/ui/phaseE/RealmPassportEntry';
import {useApp} from '../src/state/store';
import {authCookies} from '../src/auth/authCookieCoordinator';
import {installGameViewport} from '../src/lib/gameViewport';
import '../src/styles.css';
const api='http://127.0.0.1:18950',origin=location.origin;
function Frame(){
 const [ready,setReady]=useState(false),[error,setError]=useState<string|null>(null);
 useEffect(()=>{const remove=installGameViewport();let active=true;void(async()=>{const response=await fetch(api+'/__fixture/login',{credentials:'include'});if(!response.ok)throw Error('Local fixture login failed');const value=await response.json() as {wallet:string};await authCookies.ready(async()=>{throw Error('Reopen isolated fixture to restore sign-in');});if(!active)return;useApp.getState().setAuth(value.wallet,true);useApp.getState().setScreen('economy');setReady(true);parent.postMessage({kind:'passport-ready'},origin);})().catch(e=>setError(String(e)));return()=>{active=false;remove();};},[]);
 useEffect(()=>{const receive=(event:MessageEvent)=>{if(event.origin!==origin||event.source!==parent)return;if(event.data?.kind==='passport-metrics'){const controls=[...document.querySelectorAll<HTMLElement>('button,summary')].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0;});parent.postMessage({kind:'passport-metrics',width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,controls:controls.map(e=>({text:e.textContent,width:Math.round(e.getBoundingClientRect().width),height:Math.round(e.getBoundingClientRect().height)}))},origin);}};addEventListener('message',receive);return()=>removeEventListener('message',receive);},[]);
 return error?<p role="alert">{error}</p>:!ready?<p role="status">Opening real local source…</p>:<div style={{padding:16}}><RealmPassportEntry/></div>;
}
function Shell(){
 const frame=useRef<HTMLIFrameElement>(null),[width,setWidth]=useState(1280),[height,setHeight]=useState(800),[status,setStatus]=useState('Starting fixture'),[metrics,setMetrics]=useState<unknown>(null);
 useEffect(()=>{const receive=(event:MessageEvent)=>{if(event.origin!==origin||event.source!==frame.current?.contentWindow)return;if(event.data?.kind==='passport-ready')setStatus('Connected to authenticated local source');if(event.data?.kind==='passport-metrics')setMetrics(event.data);};addEventListener('message',receive);return()=>removeEventListener('message',receive);},[]);
 const button={minHeight:44,padding:'8px 14px',border:'1px solid #b2a181',background:'#26212b',color:'#fff2d5',cursor:'pointer'};
 async function outage(value:boolean){const response=await fetch(api+'/__fixture/control',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({outage:value})});setStatus(response.ok?'Current mining source '+(value?'offline':'restored'):'Fixture control failed');}
 return <main style={{height:'100%',overflow:'auto',padding:8,boxSizing:'border-box'}}><h1 style={{fontSize:22,margin:0}}>Realm Passport · local verification</h1><p role="status">{status}</p><nav aria-label="Fixture controls" style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:8}}><button style={button} onClick={()=>setWidth(320)}>320px viewport</button><button style={button} onClick={()=>setWidth(1280)}>1280px viewport</button><button style={button} onClick={()=>setHeight(600)}>600px height</button><button style={button} onClick={()=>setHeight(800)}>800px height</button><button style={button} onClick={()=>void outage(true)}>Current provider offline</button><button style={button} onClick={()=>void outage(false)}>Restore current provider</button><button style={button} onClick={()=>frame.current?.contentWindow?.postMessage({kind:'passport-metrics'},origin)}>Layout metrics</button></nav><pre aria-label="Layout measurements" style={{whiteSpace:'pre-wrap'}}>{metrics?JSON.stringify(metrics,null,2):'Not sampled'}</pre><iframe ref={frame} title="Actual Realm Passport screen" src={location.pathname+'?frame=1'} style={{width,height,border:0,outline:'2px solid #6b6354',display:'block'}}/></main>;
}
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).has('frame')?<Frame/>:<Shell/>);
