import {useEffect,useRef,useState} from 'react';
import type {DivineFragmentAward} from '@shardkeep/shared/divineFragmentsApi';
import {useDivineFragments} from '../../lib/divineFragments/useDivineFragments';
import {EconomyPanel} from './EconomyPanel';
import {Btn,btnStyle} from '../primitives';
const quantity=(value:string)=>BigInt(value).toLocaleString('en-US');
const control={minHeight:44,width:'100%'};
function Award({award}:{award:DivineFragmentAward}){const clan='clan' in award?award.clan:null;return <><h3>{clan?'Clan occupation award':'Divine occupation award'}</h3>
 <p>{new Date(award.earnedAt).toLocaleDateString()} · Site {award.site.slice(-3)}{clan&&<> · Original roster: {clan.rosterSize} members</>}</p>
 <dl className="sk-economy-values" aria-label="Original fragment allocation"><div><dt>{clan?'Your gross roster share':'Earned'}</dt><dd>{quantity(award.gross)} fragments</dd></div><div><dt>Your protected stock</dt><dd>{quantity(award.net)} fragments</dd></div><div><dt>Original Seeker pool</dt><dd>{quantity(award.tax)} fragments</dd></div></dl>
 <p>Tax was recorded once at earning. Delivery is untaxed.{award.poolDisposition==='held_zero_winners'&&' The original pool is held: no winning spots.'}</p>
 <details><summary>Original award details</summary>
  {clan&&<section aria-label="Original clan roster share"><p>This award belongs to your place on the original tournament roster. Later membership or leadership changes do not redirect it.</p>
   <dl className="sk-economy-values"><div><dt>Original roster</dt><dd>{clan.rosterSize} members</dd></div><div><dt>Site gross allowance</dt><dd>{quantity(clan.siteGross)} fragments</dd></div></dl>
   <p>The site allowance is divided equally among that roster, rounded down. Unissued remainder stays unissued.</p></section>}
  <p>{award.poolDisposition==='held_zero_winners'?'This term had no winning spots. Its pool remains held in that original term.':'The original winning spots share the Seeker pool equally.'}</p>
  <p>Event: {award.eventId}</p><p>Original wallet: {award.wallet}</p><p>Seeker term: {award.termId}</p><p>Earned: {award.earnedAt}</p><p>Fractional carry: {award.carryBefore} → {award.carryAfter}</p><p>Source: {award.sourceHash}</p>
  {clan&&<><p>Original clan: {clan.clanId}</p><p>Original entry: {clan.entryId}</p><p>Roster proof: {clan.rosterHash}</p><p>Tournament genesis: {clan.tournamentDomain.genesisHash}</p><p>Economy program: {clan.tournamentDomain.economyProgram}</p><p>Craft program: {clan.tournamentDomain.craftProgram}</p><p>Treasury: {clan.tournamentDomain.treasury}</p></>}</details></>;}
export function DivineFragmentsScreen({actionsEnabled=true,onClose}:{actionsEnabled?:boolean;onClose:()=>void}){
 const {state,baseId,actionsAllowed,run,refresh,dismiss}=useDivineFragments(actionsEnabled),[tab,setTab]=useState<'stock'|'awards'|'seeker'|'history'>('stock');
 const reviewNode=useRef<HTMLElement>(null),savedNode=useRef<HTMLElement>(null),op=state.journal?.operation,review=state.review,busy=!state.loaded||state.busy,accepted=!!op?.proof?.receipt;
 const canAct=!busy&&actionsAllowed&&!!baseId,originalSelected=op?.command.consent.request.baseId===baseId;
 useEffect(()=>{const node=review?reviewNode.current:accepted?savedNode.current:null;node?.focus({preventScroll:true});node?.scrollIntoView?.({block:'start'});},[review,accepted]);
 const close=()=>{dismiss();onClose();};
 return <EconomyPanel title="Crystal Fragments" eyebrow="DIVINE AWARDS · PROTECTED STOCK" onClose={close} error={state.error}>
  <p>Receive your individual and clan occupation awards and original Seeker shares into a kingdom’s protected stock.</p>
  {!actionsAllowed&&<p role="status">New game orders are paused. Original receipts and history remain available.</p>}
  {!state.loaded&&<p role="status">Opening saved fragment requests…</p>}
  <nav aria-label="Fragment journeys" className="sk-fragment-tabs">{(['stock','awards','seeker','history'] as const).map(name=><button type="button" className="interactive" key={name} style={{...btnStyle(tab===name?'gold':'sec'),minWidth:0,padding:8}} aria-pressed={tab===name} onClick={()=>setTab(name)}>{name==='seeker'?'SEEKER RIGHTS':name.toUpperCase()}</button>)}</nav>
  {tab==='stock'&&<section aria-label="Current fragment stock" className="sk-equipment-card"><div className="sk-economy-hero"><div><span>SELECTED KINGDOM · PROTECTED</span><strong>{state.stock?.baseId===baseId?quantity(state.stock.available):'—'}</strong><span>Crystal Fragments available</span></div></div>
   <p>Protected from raw-resource theft. This stock stays with the kingdom if its ownership changes.</p>
   {!state.stock&&<p>Select an owned kingdom and refresh to view its stock.</p>}
   <details><summary>Receiving kingdom details</summary><p>{baseId??'No kingdom selected'}</p></details>
   <Btn style={control} onClick={()=>setTab('awards')}>VIEW EARNED AWARDS</Btn><p>Cosmetic crafting is not yet available.</p></section>}
  {tab==='awards'&&<section aria-label="Earned fragment awards"><h3>Your original awards</h3>
   {!state.awards?.rows.length&&<p>No settled fragment awards are shown on this page. An enrolled Divine occupation must settle before an award appears.</p>}
   {state.awards?.rows.map(row=><section className="sk-equipment-card" key={row.award.eventId}><Award award={row.award}/>{row.delivery?<><p>Delivered once: {quantity(row.delivery.quantity)} fragments.</p><details><summary>Original delivery</summary><p>Kingdom: {row.delivery.baseId}</p><p>Received: {row.delivery.deliveredAt}</p></details></>:<Btn style={control} disabled={!canAct||!!op} onClick={()=>{if(baseId)run(c=>c.beginDelivery(baseId,row.award));}}>REVIEW DELIVERY</Btn>}</section>)}
   <div className="sk-economy-actions"><Btn variant="sec" disabled={busy} onClick={()=>run(c=>c.loadAwards())}>FIRST AWARD PAGE</Btn>{state.awards?.nextCursor&&<Btn variant="sec" disabled={busy} onClick={()=>run(c=>c.loadAwards(state.awards!.nextCursor))}>MORE AWARDS</Btn>}</div></section>}
  {tab==='seeker'&&<section aria-label="Original Seeker fragment rights"><h3>Permanent original spot rights</h3><p>Each winning spot has an equal share, including King spots. Claiming does not create another earning or another tax. Unclaimed fractions remain in the original pool.</p>
   {!state.terms?.rows.length&&<p>No fragment entitlement is shown on this page. Continue or refresh from the first page to find newly retained terms.</p>}
   {state.terms?.rows.map(row=><section key={`${row.termId}:${row.spotId}`} className="sk-equipment-card"><h3>Spot {row.spotId+1}</h3><dl className="sk-economy-values"><div><dt>Currently claimable</dt><dd>{quantity(row.claimable)} fragments</dd></div><div><dt>Already received</dt><dd>{quantity(row.previousTotal)}</dd></div></dl><p>Original term: {new Date(row.startsAt).toLocaleDateString()} – {new Date(row.endsAt).toLocaleDateString()}</p>
    <details><summary>Original spot details</summary><p>Term: {row.termId}</p><p>Winning spots: {row.winnerCount}</p><p>Original cumulative pool: {quantity(row.poolTotal)}</p></details>
    <Btn style={control} disabled={!canAct||!!op||row.claimable==='0'} onClick={()=>{if(baseId)run(c=>c.beginClaim(baseId,row,state.termsCursor));}}>REVIEW FRAGMENT CLAIM</Btn></section>)}
   <div className="sk-economy-actions"><Btn variant="sec" disabled={busy} onClick={()=>{run(c=>c.loadTerms());}}>FIRST TERM PAGE</Btn>{state.terms?.nextCursor&&<Btn variant="sec" disabled={busy} onClick={()=>{const cursor=state.terms!.nextCursor;run(c=>c.loadTerms(cursor));}}>MORE TERMS</Btn>}</div></section>}
  {op&&<section ref={savedNode} tabIndex={-1} className="sk-equipment-card" aria-label="Saved fragment request"><h3>{accepted?'ORIGINAL DELIVERY RECEIVED':op.attemptRevision!==null?'ORIGINAL OUTCOME UNKNOWN':'SAVED DELIVERY DRAFT'}</h3>
   <p>{accepted?'The original receipt is retained. Refresh stock for the currently selected kingdom.':op.attemptRevision!==null?'The original request may have succeeded. Check its receipt before an explicit retry of the same saved request.':'Review the saved receiving kingdom before confirming. Nothing is sent automatically.'}</p>
   {!originalSelected&&!accepted&&<p>Choose the original kingdom to review this request. Receipt checks remain available here.</p>}
   {review&&!accepted&&<section ref={reviewNode} tabIndex={-1} className="sk-equipment-card sk-equipment-review" aria-label="Confirm fragment delivery"><h3>Receive {quantity(review.quantity)} fragments</h3>
    {review.command.kind==='delivery'&&<Award award={review.command.consent.award}/>}
    <p>This credits the original receiving kingdom saved in this review. Its future owner keeps this protected stock. No SOL, KEEP, Gems or SHARDS payment.</p>
    <details><summary>Confirm receiving kingdom</summary><p>Receiving kingdom: {review.command.consent.request.baseId}</p></details>
    {review.command.kind==='claim'&&<p>The server calculates the original spot’s cumulative unpaid share when accepted. This is an untaxed pool claim.</p>}
    <Btn style={control} disabled={!canAct||!originalSelected} onClick={()=>run(c=>c.confirm())}>{op.attemptRevision!==null?'RETRY SAME SAVED REQUEST':'CONFIRM FRAGMENT DELIVERY'}</Btn>
    <Btn style={control} variant="sec" onClick={dismiss}>CANCEL REVIEW</Btn></section>}
   <div className="sk-economy-actions">{!accepted&&!review&&<Btn disabled={!canAct||!originalSelected} onClick={()=>run(c=>c.reviewOriginal())}>REVIEW ORIGINAL REQUEST</Btn>}
    <Btn variant="sec" disabled={busy} onClick={()=>run(c=>c.checkOriginal())}>CHECK ORIGINAL RECEIPT</Btn>
    {(accepted||op.attemptRevision===null)&&<Btn variant="sec" disabled={busy} onClick={()=>run(c=>c.archive())}>{accepted?'ARCHIVE RECEIPT':'ARCHIVE UNSENT DRAFT'}</Btn>}</div>
   <details><summary>Original request details</summary><p>Kind: {op.command.kind==='claim'?'Seeker pool claim':'Divine award delivery'}</p><p>Wallet: {op.command.consent.wallet}</p><p>Kingdom: {op.command.consent.request.baseId}</p><p>Request: {op.command.consent.request.idempotencyKey}</p>{op.proof?.receipt&&<p>Received: {quantity(op.proof.receipt.quantity)} fragments</p>}</details></section>}
  {tab==='history'&&<section aria-label="Fragment recovery history"><h3>Saved originals on this device</h3>{!state.journal?.archives.length&&<p>No archived fragment requests on this device.</p>}{state.journal?.archives.map(row=><section key={row.operation.command.consent.request.idempotencyKey} className="sk-equipment-card"><p>{row.operation.proof?.receipt?'Original receipt retained':'Archived unsent draft'}</p>{row.operation.command.kind==='delivery'&&<Award award={row.operation.command.consent.award}/>}<details><summary>Original history details</summary><p>Original kingdom: {row.operation.command.consent.request.baseId}</p><p>Request: {row.operation.command.consent.request.idempotencyKey}</p>{row.operation.proof?.receipt&&<p>Received {quantity(row.operation.proof.receipt.quantity)} fragments.</p>}</details><Btn variant="sec" style={control} disabled={busy} onClick={()=>run(c=>c.checkArchived(row.operation.command.consent.request.idempotencyKey))}>CHECK SAVED RECEIPT</Btn></section>)}</section>}
  <Btn style={control} variant="sec" disabled={busy} onClick={()=>{refresh();}}>REFRESH STOCK & HISTORY</Btn>
 </EconomyPanel>;
}
