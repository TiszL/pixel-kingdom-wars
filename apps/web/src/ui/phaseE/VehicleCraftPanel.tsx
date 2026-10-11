import {useEffect,useState} from 'react';
import {PHASE_E_VEHICLES,PHASE_E_VEHICLE_RECIPES} from '@shardkeep/shared';
import {PHASE_E_VEHICLE_FAMILY_IDS} from '@shardkeep/shared/phaseEVehicles';
import type {VehicleCraftRecord,VehicleCraftQuoteRequest} from '@shardkeep/shared/vehicleCraftClientApi';
import {useApp} from '../../state/store';
import {useVehicleCraft} from '../../lib/vehicleCraft/useVehicleCraft';
import {Btn} from '../primitives';
import {exactMarketSol} from '../screens/marketRecovery';
import './vehicle-craft.css';
const label=(v:string)=>v.replaceAll('_',' ').replace(/\b[a-z]/g,c=>c.toUpperCase());
const number=(v:string)=>BigInt(v).toLocaleString('en-US');
const statusText={held:'Materials held',paid_loss:'Craft unsuccessful',won_unminted:'Craft won · mint pending',minted:'NFT minted'};
const explanation={held:'Your original materials remain held until its paid outcome is confirmed.',paid_loss:'The paid attempt consumed these materials. No vehicle was minted.',won_unminted:'The paid attempt consumed these materials and won. Its original mint is still pending.',minted:'The original NFT mint is confirmed. Check current ownership before choosing a berth.'};
function Ingredients({record}:{record:VehicleCraftRecord}){return <ul className="sk-vehicle-craft-leaves" aria-label="Original craft materials">{record.recipe.inputs.map(i=><li key={i.kind+':'+i.itemId}><span>{label(i.itemId)}</span><strong>{number(i.quantity)}</strong></li>)}</ul>;}
export function VehicleCraftPanel({actionsEnabled,onInstall}:{actionsEnabled:boolean;onInstall:()=>void}){
 const baseId=useApp(s=>s.selectedBaseId),wallet=useApp(s=>s.wallet),base=useApp(s=>s.base),directory=useApp(s=>s.baseDirectory),craft=useVehicleCraft();
 const [family,setFamily]=useState<VehicleCraftQuoteRequest['family']>(PHASE_E_VEHICLE_FAMILY_IDS[0]),[tier,setTier]=useState<VehicleCraftQuoteRequest['tier']>(PHASE_E_VEHICLES.tiers[0]);
 const owned=!!baseId&&base?.player.wallet===wallet&&(base.baseId==null||base.baseId===baseId),quote=owned&&actionsEnabled?craft.quote:null;
 useEffect(()=>{if(!owned||!actionsEnabled)craft.clearQuote();},[owned,actionsEnabled,craft.clearQuote]);
 const baseName=(id:string)=>{const row=directory?.bases.find(b=>b.id===id);return row?.slot?'Kingdom '+row.slot:'Original kingdom';};
 return <div className="sk-vehicle-craft" aria-label="Vehicle crafting">
  <section className="sk-vehicle-craft-card" aria-labelledby="vehicle-recipe-title">
   <p className="sk-equipment-eyebrow">WORKSHOP · RECIPE PREVIEW</p><h3 id="vehicle-recipe-title">Plan your next vehicle</h3><p>Check the exact materials in your selected kingdom. Previewing does not spend or hold them.</p>
   <div className="sk-vehicle-craft-selectors"><label>Vehicle family<select aria-label="Craft vehicle family" value={family} onChange={e=>{setFamily(e.target.value as typeof family);craft.clearQuote();}}>{PHASE_E_VEHICLE_FAMILY_IDS.map(f=><option key={f} value={f}>{label(f)}</option>)}</select></label><label>Tier<select aria-label="Craft vehicle tier" value={tier} onChange={e=>{setTier(Number(e.target.value) as typeof tier);craft.clearQuote();}}>{PHASE_E_VEHICLES.tiers.map(t=><option key={t} value={t}>Tier {t}</option>)}</select></label></div>
   {!owned&&<p role="status">Select and refresh a kingdom you own to preview its materials.</p>}
   <Btn variant="sec" disabled={!actionsEnabled||!owned||craft.quoting} onClick={()=>void craft.preview({baseId:baseId!,family,tier,recipeVersion:PHASE_E_VEHICLE_RECIPES.recipeVersion})}>{craft.quoting?'CHECKING MATERIALS…':'PREVIEW MATERIALS'}</Btn>
   {craft.quoteError&&<p role="alert" className="sk-vehicle-craft-notice">{craft.quoteError}</p>}
   {quote&&<div aria-label="Current vehicle recipe"><h4>{label(quote.recipe.family)} · tier {quote.recipe.tier}</h4><dl className="sk-vehicle-craft-stats"><div><dt>Application charge</dt><dd>{exactMarketSol(quote.applicationFeeLamports)} SOL</dd></div><div><dt>Success chance</dt><dd>{quote.recipe.oddsBps/100}%</dd></div></dl><p className="sk-vehicle-craft-muted">Network, oracle and account costs are not included. A total payment quote is unavailable.</p>
    <ul className="sk-vehicle-craft-materials" aria-label="Required vehicle materials">{quote.ingredients.map(i=><li key={i.kind+':'+i.itemId}><div><strong>{label(i.itemId)}</strong><span>{number(i.held)} held by earlier crafts</span></div><div className={BigInt(i.available)<BigInt(i.required)?'sk-vehicle-craft-short':''}><strong>{number(i.available)} / {number(i.required)}</strong><span>available / required</span></div></li>)}</ul>
    <p className="sk-vehicle-craft-notice">New crafting is not available yet. Your materials stay in this kingdom.</p></div>}
  </section>
  <section className="sk-vehicle-craft-history" aria-labelledby="vehicle-craft-history-title"><div className="sk-vehicle-craft-heading"><div><p className="sk-equipment-eyebrow">YOUR ORIGINAL CRAFTS</p><h3 id="vehicle-craft-history-title">Materials & outcomes</h3></div><Btn variant="sec" disabled={craft.busy} onClick={()=>void craft.refresh()}>{craft.busy?'CHECKING…':'REFRESH HISTORY'}</Btn></div>
   <p>Original crafts stay with this account after kingdom selection or ownership changes. Saved receipts remain available during an outage.</p>
   {craft.error&&<p role="alert" className="sk-vehicle-craft-notice">{craft.error}</p>}
   {!craft.loaded&&!craft.records.length&&<p role="status">Opening your saved craft history…</p>}
   {craft.loaded&&!craft.records.length&&!craft.error&&<div className="sk-vehicle-craft-empty"><strong>No original crafts yet</strong><p>When an original is committed, its materials and outcome will appear here.</p></div>}
   {craft.records.map(r=><article className="sk-vehicle-craft-card" key={r.idempotencyKey} aria-label={'Original craft '+r.idempotencyKey}><div className="sk-vehicle-craft-heading"><h4>{label(r.recipe.family)} · tier {r.recipe.tier}</h4><span className={'sk-vehicle-craft-status sk-vehicle-craft-status-'+r.status}>{statusText[r.status]}</span></div><p>{explanation[r.status]}</p><p className="sk-vehicle-craft-muted">{baseName(r.baseId)} · {r.status==='held'?'Reserved materials':'Consumed materials'}</p><Ingredients record={r}/><details><summary>Original kingdom & receipt details</summary><p>Kingdom: {r.baseId}</p><p>Request: {r.idempotencyKey}</p><p>NFT: {r.identity.assetId}</p><p>Materials reserved: {r.reservedAt}</p><p>Recipe: {r.recipeHash}</p><p>Material commitment: {r.materialHash}</p><p>Saved receipt only. Current NFT ownership is checked separately.</p></details><div className="sk-vehicle-craft-actions"><Btn variant="sec" disabled={craft.busy} onClick={()=>void craft.recover(r.idempotencyKey)}>CHECK CRAFT OUTCOME</Btn>{r.status==='minted'&&<Btn onClick={onInstall}>FIND NFT TO INSTALL</Btn>}</div></article>)}
   {craft.cursor&&<Btn variant="sec" disabled={craft.busy} onClick={()=>void craft.more()}>LOAD EARLIER CRAFTS</Btn>}
  </section>
 </div>;
}
