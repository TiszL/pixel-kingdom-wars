import {useEffect,useState} from 'react';
import {PHASE_E_VEHICLES,PHASE_E_VEHICLE_RECIPES} from '@shardkeep/shared';
import {PHASE_E_VEHICLE_FAMILY_IDS} from '@shardkeep/shared/phaseEVehicles';
import type {VehicleCraftQuoteRequest} from '@shardkeep/shared/vehicleCraftClientApi';
import {useApp} from '../../../state/store';
import {useVehicleCraft} from '../../../lib/vehicleCraft/useVehicleCraft';
import type {PanelSession} from '../panelSession';
import {PkSecondaryButton} from '../Button';
import {formatUnits} from '../craft/marketLogic';
import {voyageName} from './VoyageAdapterFrame';
const whole=(value:string)=>BigInt(value).toLocaleString('en-US');
const explains={held:'Your original materials remain held until its paid outcome is confirmed.',paid_loss:'The paid attempt consumed these materials. No vehicle was minted.',won_unminted:'The paid attempt consumed these materials and won. Its original mint is still pending.',minted:'The original NFT mint is confirmed. Check current ownership before choosing a berth.'};
const labels={held:'Materials held',paid_loss:'Craft unsuccessful',won_unminted:'Craft won · mint pending',minted:'NFT minted'};
/** Existing preview/history API only. It does not expose a new craft/payment API. */
export default function VehicleCraftBody({actionsEnabled,busy,session,onInstall}:{actionsEnabled:boolean;busy:boolean;session:Pick<PanelSession,'dispatch'>;onInstall:()=>void}):React.JSX.Element {
 const wallet=useApp(s=>s.wallet),baseId=useApp(s=>s.selectedBaseId),base=useApp(s=>s.base),craft=useVehicleCraft();
 const [family,setFamily]=useState<VehicleCraftQuoteRequest['family']>(PHASE_E_VEHICLE_FAMILY_IDS[0]),[tier,setTier]=useState<VehicleCraftQuoteRequest['tier']>(PHASE_E_VEHICLES.tiers[0]);
 const current=craft.wallet===wallet,owned=!!baseId&&base?.baseId===baseId&&base.player.wallet===wallet,quote=owned&&actionsEnabled&&current&&craft.quote?.wallet===wallet&&craft.quote.baseId===baseId&&craft.quote.recipe.family===family&&craft.quote.recipe.tier===tier?craft.quote:null;
 useEffect(()=>{if(!owned||!actionsEnabled)craft.clearQuote();},[owned,actionsEnabled,craft.clearQuote]);
 const read=(action:()=>void)=>{if(!busy&&!craft.busy)session.dispatch('recover',action);};
 return <section aria-label="Vehicle crafting"><h3>Plan your next vehicle</h3><p>Check the selected kingdom's original recipe and materials. Previewing does not hold or spend them.</p>
  <div className="pk-voyage-adapter__actions"><label>Vehicle family<select aria-label="Craft vehicle family" disabled={busy||craft.quoting} value={family} onChange={event=>{const next=event.target.value as typeof family;if(PHASE_E_VEHICLE_FAMILY_IDS.includes(next)){setFamily(next);craft.clearQuote();}}}>{PHASE_E_VEHICLE_FAMILY_IDS.map(value=><option key={value} value={value}>{voyageName(value)}</option>)}</select></label>
  <label>Tier<select aria-label="Craft vehicle tier" disabled={busy||craft.quoting} value={tier} onChange={event=>{const next=Number(event.target.value) as typeof tier;if(PHASE_E_VEHICLES.tiers.includes(next)){setTier(next);craft.clearQuote();}}}>{PHASE_E_VEHICLES.tiers.map(value=><option key={value} value={value}>Tier {value}</option>)}</select></label></div>
  <PkSecondaryButton label="PREVIEW MATERIALS" enabled={owned&&actionsEnabled&&!busy&&!craft.busy&&!craft.quoting&&current&&!!baseId} onClick={()=>{if(owned&&actionsEnabled&&baseId&&!busy&&!craft.quoting&&current)session.dispatch('read',()=>{void craft.preview({baseId,family,tier,recipeVersion:PHASE_E_VEHICLE_RECIPES.recipeVersion});});}}/>
  {craft.quoteError?<p role="alert">{craft.quoteError}</p>:null}
  {quote?<section aria-label="Current vehicle recipe"><h3>{voyageName(quote.recipe.family)} · tier {quote.recipe.tier}</h3><p>Application charge: {formatUnits(BigInt(quote.applicationFeeLamports),9,9)} SOL · success chance {quote.recipe.oddsBps/100}%.</p>
   <p>Network, oracle and account costs are not included. A total payment quote is unavailable.</p>
   <dl aria-label="Required vehicle materials">{quote.ingredients.map(item=><div key={`${item.kind}:${item.itemId}`}><dt>{voyageName(item.itemId)} · {whole(item.held)} held</dt><dd>{whole(item.available)} / {whole(item.required)} available / required</dd></div>)}</dl></section>:null}
  <p>New crafting is not available yet. A preview does not create a request or reserve materials.</p>
  <h3>Original materials and outcomes</h3><PkSecondaryButton label="REFRESH CRAFT HISTORY" enabled={!busy&&!craft.busy} onClick={()=>read(()=>{void craft.refresh();})}/>
  {craft.error?<p role="alert">{craft.error}</p>:null}{!craft.loaded?<p role="status">Opening saved craft history…</p>:current&&craft.records.length===0?<p>No original crafts are saved.</p>:null}
  {(current?craft.records:[]).map(record=><article key={record.idempotencyKey}><h3>{voyageName(record.recipe.family)} · tier {record.recipe.tier}</h3><p>{labels[record.status]}</p><p>{explains[record.status]}</p>
   <dl>{record.recipe.inputs.map(item=><div key={`${item.kind}:${item.itemId}`}><dt>{voyageName(item.itemId)}</dt><dd>{whole(item.quantity)} {record.status==='held'?'reserved':'consumed'}</dd></div>)}</dl>
   <details><summary>Original craft identities</summary><p>Kingdom: {record.baseId}</p><p>Request: {record.idempotencyKey}</p><p>NFT: {record.identity.assetId}</p><p>Recipe: {record.recipeHash}</p><p>Material commitment: {record.materialHash}</p><p>Saved mint history does not establish current NFT ownership.</p></details>
   <div className="pk-voyage-adapter__actions"><PkSecondaryButton label="CHECK CRAFT OUTCOME" enabled={!busy&&!craft.busy} onClick={()=>read(()=>{void craft.recover(record.idempotencyKey);})}/>{record.status==='minted'?<PkSecondaryButton label="FIND NFT TO INSTALL" enabled={!busy} onClick={onInstall}/>:null}</div>
  </article>)}
  {current&&craft.cursor?<PkSecondaryButton label="LOAD EARLIER CRAFTS" enabled={!busy&&!craft.busy} onClick={()=>read(()=>{void craft.more();})}/>:null}
 </section>;
}
