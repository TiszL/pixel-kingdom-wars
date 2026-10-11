/** Local visual verification of the real reusable component and packed assets.
 * No entitlement, API admission or protected in-game application is simulated. */
import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {BoundCosmeticAppearance} from '@shardkeep/shared/boundCosmeticApi';
import {BoundCosmeticPreview} from '../src/ui/phaseE/BoundCosmeticPreview';
import '../src/styles.css';
const names=['Artisan Awning I','Artisan Awning II','Artisan Awning III','Artisan Awning IV','Aurora Wake'];
function App(){
 const [items,setItems]=useState<BoundCosmeticAppearance[]>([]),[selected,setSelected]=useState(0),[width,setWidth]=useState(600),[paused,setPaused]=useState(false),[wrong,setWrong]=useState(false);
 useEffect(()=>{let active=true;void fetch('/atlas/pe_cosmetics.manifest.json').then(r=>r.json()).then((m:{bindings:Record<string,{sha256:string;value:Omit<BoundCosmeticAppearance,'bindingSha256'>}>})=>{if(active)setItems(Object.values(m.bindings).map(({sha256,value})=>({version:1,outputId:value.outputId,sourceId:value.sourceId,sourceManifestSha256:value.sourceManifestSha256,sourceIndexSha256:value.sourceIndexSha256,bindingSha256:sha256})));});return()=>{active=false;};},[]);
 const selectedAppearance=items[selected],appearance=selectedAppearance&&{...selectedAppearance,bindingSha256:wrong?'0'.repeat(64):selectedAppearance.bindingSha256};
 const button={minHeight:44,padding:'8px 12px',border:'1px solid #7e6846',borderRadius:4,background:'#322a31',color:'#f6e8c9',font:'inherit',cursor:'pointer'};
 return <main style={{height:'100%',overflow:'auto',padding:16,boxSizing:'border-box'}}><h1 style={{fontSize:24}}>Bound appearances · local preview</h1><p>Exact packed appearance verification. Crafting and in-game application are not enabled here.</p><nav aria-label="Preview fixture controls" style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:20}}>{names.map((name,i)=><button style={button} key={name} aria-pressed={selected===i} onClick={()=>setSelected(i)}>{name}</button>)}<button style={button} onClick={()=>setWidth(288)}>288px pane</button><button style={button} onClick={()=>setWidth(600)}>Wide layout</button><button style={button} onClick={()=>setPaused(p=>!p)}>{paused?'Allow motion':'Still motion'}</button><button style={button} onClick={()=>setWrong(p=>!p)}>{wrong?'Restore binding':'Wrong binding'}</button></nav><section aria-label="Preview layout" style={{width,maxWidth:'100%'}}>{appearance?<BoundCosmeticPreview appearance={appearance} label={names[selected]!} animation={paused?'paused':'auto'}/>:<p role="status">Reading admitted assets…</p>}</section></main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
