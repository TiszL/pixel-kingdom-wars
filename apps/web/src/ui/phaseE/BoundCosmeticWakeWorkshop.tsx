import { useEffect, useRef } from 'react';
import type { BoundCosmeticEnvelope } from '@shardkeep/shared/boundCosmeticApi';
import { useBoundCosmeticWakeWorkshop } from '../../lib/boundCosmetics/wakeWorkshopBrowser';
import { wakeCraftBlock } from '../../lib/boundCosmetics/wakeWorkshopController';
import { BoundCosmeticPreview } from './BoundCosmeticPreview';
import { CosmeticMaterials, CosmeticReceipt } from './BoundCosmeticWorkshop';
import './BoundCosmeticWorkshop.css';

const duration = (seconds: number) => seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} sec`;
const date = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Source preview and account recovery remain useful while fleet application is
 * held. Neither this page nor its preview can establish C5 delivery readiness. */
export function BoundCosmeticWakeWorkshop({ actionsEnabled = false }: { actionsEnabled?: boolean }) {
  const { state, baseId, preference, actionsAllowed, preferenceAllowed, applicationReady, run, refresh, cancelReview } = useBoundCosmeticWakeWorkshop(actionsEnabled);
  const alertNode = useRef<HTMLParagraphElement>(null), reviewNode = useRef<HTMLElement>(null);
  const view = state.view, base = view?.selectedBase?.state === 'available' ? view.selectedBase : null;
  const operation = state.journal?.operation, review = state.review;
  const accepted = operation?.proof?.status === 'accepted' ? operation.proof : null;
  const originalSelected = !!operation && operation.command.request.baseId === baseId;
  const blocked = view ? wakeCraftBlock(view) : null;
  const history = new Map<string, Extract<BoundCosmeticEnvelope, { status: 'accepted' }>>();
  for (const op of [...(state.journal?.archives ?? []), ...(operation ? [operation] : [])])
    if (op.proof?.status === 'accepted') history.set(op.proof.idempotencyKey, op.proof);
  // Independent original recovery can be newer than a retained current view.
  if (view?.original?.status === 'accepted' && !history.get(view.original.idempotencyKey)?.completion)
    history.set(view.original.idempotencyKey, view.original);
  const completed = view?.original?.status === 'accepted' && view.original.completion !== null;
  useEffect(() => { if (state.error) alertNode.current?.focus(); }, [state.error]);
  useEffect(() => { if (review) reviewNode.current?.focus(); }, [review]);
  return <section className="sk-awning-workshop" aria-label="Aurora Wake Workshop">
    <header className="sk-awning-heading"><div><p className="sk-awning-eyebrow">WORKSHOP · ACCOUNT APPEARANCES</p><h3>Aurora Wake</h3></div><span className="sk-awning-badge">COSMETIC ONLY</span></header>
    <p className="sk-awning-intro">A permanent fleet appearance for your account. Your choice is saved when each expedition departs and stays with that trip.</p>
    {state.error && <p className="sk-awning-message" role="alert" ref={alertNode} tabIndex={-1}>{state.error}</p>}
    {state.notice && <p className="sk-awning-message" role="status">{state.notice}</p>}
    {!state.loaded && <p role="status">Opening Aurora recovery…</p>}
    {state.loaded && !view && <p role="status">Current Workshop details are unavailable. Your account setting and saved receipts can be refreshed separately.</p>}
    {view && <>
      {(!view.applicationReady || !applicationReady) && <p className="sk-awning-message" role="status">Aurora Wake is not available for new crafts or switching on yet. You can preview its artwork, switch it off, and recover original receipts.</p>}
      <BoundCosmeticPreview appearance={view.recipe.appearance} label="Aurora Wake artwork preview" />
    </>}
    <section className="sk-equipment-card sk-awning-application" aria-label="Account Wake setting">
      <div><h4>Future departures</h4><strong>{!preference ? 'SETTING UNAVAILABLE' : preference.enabled ? 'AURORA WAKE ON' : 'AURORA WAKE OFF'}</strong></div>
      <p>This free setting applies across your kingdoms. Changing it does not alter an expedition already underway, its rewards, or its arrival time.</p>
      {preference?.visual.state === 'unavailable' && <p role="status">The saved setting is known, but its appearance could not be verified. It has not been silently switched off.</p>}
      <button type="button" disabled={state.busy || !preference || !preferenceAllowed || !preference.enabled && (!actionsAllowed || !applicationReady || !view?.applicationReady || !completed)}
        onClick={() => { if (preference) run(c => c.setPreference(!preference.enabled)); }}>{preference?.enabled ? 'SWITCH AURORA OFF' : 'ENABLE OWNED AURORA'}</button>
      <span className="sk-awning-free">Free · no materials consumed · no kingdom selection needed</span>
      <button type="button" disabled={state.busy} onClick={() => run(c => c.refreshPreference())}>REFRESH ACCOUNT SETTING</button>
    </section>
    {view && <>
      <section className="sk-equipment-card sk-awning-facts" aria-label="Aurora crafting requirements"><div className="sk-awning-heading"><h4>Craft once, keep it</h4><span>{duration(view.recipe.recipe.durationSec)} · permanent</span></div>
        <dl><div><dt>Artisan Finishes Blueprint</dt><dd>{view.blueprint.state === 'eligible' ? 'Earned from completed refining' : view.blueprint.state === 'not-earned' ? 'Complete one refining job' : 'History unavailable · refresh'}</dd></div>
          <div><dt>Completed Workshop</dt><dd>{base ? base.workshops.length ? 'Ready in this kingdom' : 'Build and complete a Workshop' : 'Choose a verified kingdom'}</dd></div>
          <div><dt>Completed Lodge</dt><dd>{base ? base.lodges.length ? `Level ${Math.max(...base.lodges.map(row => row.level))} · requires level ${view.recipe.recipe.requiredFacility.level}` : `Requires level ${view.recipe.recipe.requiredFacility.level}` : 'Not verified'}</dd></div></dl>
        <CosmeticMaterials recipe={view.recipe.recipe} base={base} />
        {blocked && <p role="status">{blocked}</p>}
        <button type="button" className="sk-awning-primary" disabled={state.busy || !actionsAllowed || !applicationReady || !base || !!blocked || !!operation}
          onClick={() => { if (base) run(c => c.begin(base.baseId, view.recipe.recipe.recipeId)); }}>REVIEW AURORA CRAFT</button>
      </section>
      <section className="sk-awning-queue" aria-label="Shared Workshop queue"><div><h4>Workshop queue</h4><span>{!base ? 'UNAVAILABLE' : base.queue.length ? 'IN PROGRESS' : 'AVAILABLE'}</span></div>
        <p>Refining, equipment and cosmetics share this queue.</p>{base?.queue.map(job => <p key={job.jobId}>{job.kind === 'ordinary' ? 'Material refining' : job.kind === 'equipment' ? 'Equipment crafting' : job.recipe.outputId === 'aurora_wake' ? 'Aurora Wake' : 'Artisan Awning'} · Due <time dateTime={job.readyAt}>{date(job.readyAt)}</time>. Refresh to check completion.</p>)}</section>
    </>}
    {operation && <section className="sk-equipment-card sk-awning-saved" aria-label="Saved Aurora request">
      <p className="sk-awning-eyebrow">{accepted ? 'ORIGINAL REQUEST ACCEPTED' : operation.attempted ? 'OUTCOME NOT YET CONFIRMED' : 'SAVED · NOT SENT'}</p><h4>Aurora Wake</h4>
      <p>{accepted ? accepted.completion ? 'Your account owns this appearance.' : 'Your original craft is in progress. The server completes it automatically.'
        : operation.attempted ? 'The craft may already have started. Check its original receipt before explicitly resending the same request.' : 'Your exact recipe, materials and original kingdom are saved. Nothing is consumed until you confirm.'}</p>
      {!originalSelected && !accepted && <p>Select the original kingdom to review this craft. Receipt recovery stays available here.</p>}
      {review && !accepted && <section className="sk-awning-confirm" aria-label="Confirm Aurora craft" ref={reviewNode} tabIndex={-1}><h4>Review before crafting</h4>
        <CosmeticMaterials recipe={review.command.recipe} base={review.view.selectedBase?.state === 'available' ? review.view.selectedBase : null} />
        <p><strong>These refined materials are consumed when crafting starts.</strong> This cannot be cancelled or refunded. The appearance stays with your account, including after a kingdom transfer.</p>
        <p>Takes {duration(review.command.recipe.durationSec)}. No SOL, KEEP, SHARDS or Gems payment. No fleet or reward advantage.</p>
        {operation.attempted && <p>This explicitly resends the same saved request.</p>}
        <div className="sk-awning-actions"><button type="button" className="sk-awning-primary" disabled={state.busy || !actionsAllowed || !applicationReady || !originalSelected} onClick={() => run(c => c.confirm())}>{operation.attempted ? 'RESEND SAME CRAFT REQUEST' : 'CONFIRM & USE MATERIALS'}</button><button type="button" onClick={cancelReview}>CANCEL REVIEW</button></div>
      </section>}
      <div className="sk-awning-actions"><button type="button" disabled={state.busy} onClick={() => run(c => c.checkOriginal())}>CHECK ORIGINAL RECEIPT</button>
        {!accepted && !review && <button type="button" disabled={state.busy || !actionsAllowed || !applicationReady || !originalSelected} onClick={() => run(c => c.reviewOriginal())}>REVIEW SAVED REQUEST</button>}
        {(accepted || !operation.attempted) && <button type="button" disabled={state.busy} onClick={() => run(c => c.archive())}>{accepted ? 'SAVE TO HISTORY' : 'ARCHIVE UNSENT DRAFT'}</button>}</div>
    </section>}
    <details className="sk-awning-history"><summary>Aurora history · {history.size}</summary>{!view && <p>Saved receipts are historical evidence. Check an original receipt to refresh it.</p>}
      {history.size ? [...history.values()].map(proof => <div key={proof.idempotencyKey}><CosmeticReceipt proof={proof} />
        {[...(state.journal?.archives ?? []), ...(operation ? [operation] : [])].some(op => op.command.request.idempotencyKey === proof.idempotencyKey)
          && <button type="button" disabled={state.busy} onClick={() => run(c => c.checkReceipt(proof.idempotencyKey))}>CHECK AURORA RECEIPT</button>}</div>) : <p>No accepted Aurora crafts are available in this view.</p>}</details>
    <button type="button" disabled={state.busy} onClick={refresh}>REFRESH WORKSHOP & RECEIPTS</button>
  </section>;
}
