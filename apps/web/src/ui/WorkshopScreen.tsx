import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state/store';
import { workshopBase, type WorkshopOperation } from '../lib/workshop/journal';
import { useWorkshop } from '../lib/workshop/useWorkshop';
import { Btn } from './primitives';
import { EconomyPanel } from './phaseE/EconomyPanel';
const whole = (value: string | number | bigint) => BigInt(value).toLocaleString('en-US');
const control = { minHeight: 44, width: '100%' };
function Details({ operation }: { operation: WorkshopOperation }): React.JSX.Element {
  const c = operation.command, receipt = operation.proof?.receipt;
  return <details><summary className="interactive" style={{ minHeight: 44, paddingTop: 12 }}>ORIGINAL {c.kind.toUpperCase()} DETAILS</summary>
    <p>Base: {workshopBase(c)}</p><p>Request: {c.request.idempotencyKey}</p>
    {c.kind === 'start' ? <p>{whole(c.request.ingots)} ingots · Recipe {c.request.recipeVersion}</p> : <p>Job: {c.jobId}</p>}
    {operation.refusal && <p>Declined: {operation.refusal.code.replaceAll('_', ' ').toLowerCase()}.</p>}
    {receipt && <><p>Receipt: {receipt.receiptId}</p>{'shardsCharged' in receipt ? <p>{whole(receipt.shardsCharged)} SHARDS spent · Ready {receipt.readyAt}</p> : <p>{whole(receipt.ingotsCredited)} ingots collected · {receipt.collectedAt}</p>}</>}
  </details>;
}
export function WorkshopScreen({ actionsEnabled = true }: { actionsEnabled?: boolean }): React.JSX.Element {
  const baseId = useApp(s => s.selectedBaseId), { state, snapshot, refreshError, run, refresh, dismiss, actionsAllowed } = useWorkshop(actionsEnabled);
  const [quantity, setQuantity] = useState('1'), reviewNode = useRef<HTMLElement>(null), operationNode = useRef<HTMLElement>(null);
  const view = snapshot?.view, op = state.journal?.operation, review = state.review, receipt = op?.proof?.receipt;
  const ingots = /^[1-9][0-9]{0,15}$/.test(quantity) && Number.isSafeInteger(Number(quantity)) ? Number(quantity) : null;
  const busy = !state.loaded || state.busy, canAct = !busy && actionsAllowed;
  const originalSelected = !!op && workshopBase(op.command) === baseId;
  const close = () => { dismiss(); useApp.getState().setScreen('base'); };
  useEffect(() => { const node=review?reviewNode.current:operationNode.current;node?.focus();node?.scrollIntoView?.({block:'nearest'}); }, [review,receipt?.receiptId,op?.command.request.idempotencyKey,op?.refusal?.code]);
  return <EconomyPanel title="Ingot Workshop" eyebrow="REFINE · STORE · COLLECT" onClose={close} error={state.error??refreshError}>
      <p className="sk-equipment-muted">Turn SHARDS into Forge Ingots. Payment is final when refining starts; collection has no SOL fee.</p>
      {!actionsAllowed && <p role="status">Base actions are temporarily unavailable. Original receipts can still be checked.</p>}
      {!state.loaded && <p role="status">Loading saved Workshop commands…</p>}
      {!view && state.loaded && <p>Current base inventory is unavailable. Saved receipts remain historical proof; they do not show current stock.</p>}
      {view && <section aria-label="Current selected-base Workshop">
        <div className="sk-economy-hero"><div><span>FORGE INGOTS · SELECTED KINGDOM</span><strong>{whole(view.inventory.held)}</strong><span>{whole(view.inventory.held)} held · {whole(view.inventory.pending)} refining</span></div></div>
        <dl className="sk-economy-values"><div><dt>SHARDS available</dt><dd>{whole(snapshot!.balances.shards)}</dd></div><div><dt>{view.allowance.scope === 'free_wallet' ? 'Shared daily starts remaining' : 'Daily starts remaining'}</dt><dd>{whole(view.allowance.daily.remaining)}</dd></div><div><dt>{view.allowance.scope === 'free_wallet' ? 'Shared Ingot space remaining' : 'Ingot space remaining'}</dt><dd>{whole(view.allowance.holding.remaining)}</dd></div></dl>
        <details><summary>{view.allowance.scope === 'free_wallet' ? 'SHARED FREE-BASE WALLET ALLOWANCE' : 'THIS DEED’S ALLOWANCE'}</summary>
        <p>Daily: {whole(view.allowance.daily.used)} / {whole(view.allowance.daily.cap)} started · {whole(view.allowance.daily.remaining)} remaining.</p>
        <p>Holding: {whole(view.allowance.holding.held)} held + {whole(view.allowance.holding.pending)} pending / {whole(view.allowance.holding.cap)} · {whole(view.allowance.holding.remaining)} space.</p>
        {view.allowance.scope === 'free_wallet' && <p>Includes all currently owned free bases, even inactive bases. This is separate from the selected base’s stock.</p>}
        <p>Daily reset: {view.allowance.resetsAt} (00:00 UTC).</p><p>Base: {view.inventory.baseId} · Observed {view.serverNow}</p></details>
        {!snapshot!.enabled && <p>New refining is paused. Paid jobs and their receipts remain recoverable.</p>}
        {snapshot!.enabled && view.level > 0 && !op && <section aria-label="New refining job" className="sk-equipment-card"><h3>Start a refining batch</h3>
          <p>{whole(view.shardsPerIngot)} SHARDS → 1 Forge Ingot · Recipe {view.recipeVersion}. Batch limit {view.batch.size}.</p>
          <label>Ingots to refine<input aria-label="Ingots to refine" className="interactive" inputMode="numeric" maxLength={16} value={quantity}
            onChange={e => setQuantity(e.target.value.replace(/[^0-9]/g, ''))}  /></label>
          <Btn style={control} disabled={!canAct || ingots === null || ingots > Math.min(view.batch.size, view.allowance.daily.remaining, view.allowance.holding.remaining)}
            onClick={() => { if (ingots !== null) run(c => c.beginStart(view.inventory.baseId, ingots, view.recipeVersion)); }}>REVIEW REFINING</Btn>
        </section>}
        {!!view.jobs.length && <section aria-label="Selected-base refining jobs"><h3>Refining jobs</h3>{view.jobs.map(job => <div key={job.jobId} className="sk-equipment-card">
          <strong>{whole(job.ingots)} INGOTS · {job.collectedAt ? 'COLLECTED' : job.ready ? 'READY TO COLLECT' : 'REFINING'}</strong>
          <p className="sk-equipment-muted">Ready {new Date(job.readyAt).toLocaleString()}. Refresh to confirm readiness.</p>
          {!job.collectedAt && <Btn style={control} disabled={!canAct || !!op || !job.ready} onClick={() => run(c => c.beginCollect(view.inventory.baseId, job.jobId))}>REVIEW COLLECTION</Btn>}
        </div>)}</section>}
      </section>}
      {op && <section ref={operationNode} tabIndex={-1} aria-label="Saved Workshop command" className="sk-equipment-card">
        <strong>{receipt ? 'ORIGINAL RECEIPT CONFIRMED' : op.refusal ? 'ORIGINAL REQUEST DECLINED' : op.attempted ? 'ORIGINAL REQUEST OUTCOME PENDING' : 'ORIGINAL UNSENT DRAFT'}</strong>
        <p>{receipt ? 'Historical proof only. Current inventory and balances come from the selected-base refresh above.' : op.refusal ? 'The server declined this request before accepting it. Nothing was spent or credited by this request. Check its proof and archive the decline to review a new request.' : op.attempted ? 'This request may have completed. Keep its original key; check the receipt before explicitly reviewing the same request again.' : 'The original quantity, recipe and destination are saved. Review them before confirming.'}</p>
        {!originalSelected && <p>This command belongs to another base. Select its original base to review a mutation. Receipt checks and unused-draft archives remain available here.</p>}
        {review && !receipt && !op.refusal && <section ref={reviewNode} tabIndex={-1} aria-label="Confirm Workshop command" className="sk-equipment-review">
          {review.command.kind === 'start' ? <><strong>{whole(BigInt(review.command.request.ingots) * BigInt(review.view.shardsPerIngot))} SHARDS → {whole(review.command.request.ingots)} INGOTS</strong>
            <p>Recipe {review.command.request.recipeVersion} · Workshop level {review.view.level} · Duration {whole(BigInt(review.command.request.ingots) * BigInt(review.view.secPerIngot!))} seconds.</p>
            <p>Charge is final at start. No cancellation, refund or SOL fee. Allowance day: {review.view.allowance.day.slice(0,10)} (UTC).</p></> : <><strong>COLLECT ORIGINAL PAID JOB</strong>
            <p>{whole(review.view.jobs.find(j => j.jobId === (review.command.kind === 'collect' ? review.command.jobId : ''))!.ingots)} ingots go to the producing base.</p></>}
          <p>Destination: the originally selected kingdom.</p><details><summary>Confirm destination</summary><p>Base: {workshopBase(review.command)}</p></details>
          <Btn style={control} disabled={!canAct || !originalSelected} onClick={() => run(c => c.confirm())}>{review.command.kind === 'start' ? 'CONFIRM REFINING' : 'CONFIRM COLLECTION'}</Btn>
          <Btn style={{ ...control, marginTop: 8 }} variant="sec" onClick={dismiss}>CANCEL REVIEW</Btn>
        </section>}
        <div className="sk-economy-actions">
          {!receipt && !op.refusal && !review && <Btn style={control} disabled={!canAct || !originalSelected} onClick={() => run(c => c.reviewCommand())}>REVIEW ORIGINAL REQUEST</Btn>}
          <Btn style={control} variant="sec" disabled={busy} onClick={() => run(c => c.open())}>CHECK ORIGINAL RECEIPT</Btn>
          {!op.attempted && !receipt && <Btn style={control} variant="sec" disabled={busy} onClick={() => run(c => c.abandonDraft())}>ARCHIVE UNUSED DRAFT</Btn>}
          {receipt && <Btn style={control} variant="sec" disabled={busy} onClick={() => run(c => c.finish())}>ARCHIVE CONFIRMED RECEIPT</Btn>}
          {op.refusal && <Btn style={control} variant="sec" disabled={busy} onClick={() => run(c => c.archiveRefusal())}>ARCHIVE DECLINED REQUEST</Btn>}
        </div>
        <Details operation={op} />
      </section>}
      {!!state.journal?.archives.length && <details><summary className="interactive" style={{ minHeight: 44, paddingTop: 12 }}>WORKSHOP HISTORY ({state.journal.archives.length})</summary>
        {state.journal.archives.map(a => <section key={a.operation.command.request.idempotencyKey}><p>{a.reason === 'accepted' ? 'Confirmed historical receipt' : a.reason === 'refused' ? 'Declined request archived with its original proof' : 'Unused draft archived before any attempt'}</p><Details operation={a.operation} /></section>)}
      </details>}
      <Btn style={control} variant="sec" disabled={busy} onClick={refresh}>REFRESH WORKSHOP & RECEIPTS</Btn>
      <Btn style={control} variant="sec" onClick={close}>BACK TO BASE</Btn>
  </EconomyPanel>;
}
