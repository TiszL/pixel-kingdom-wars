import { useEffect, useRef, useState } from 'react';
import type { BoundCosmeticEnvelope } from '@shardkeep/shared/boundCosmeticApi';
import type { BoundCosmeticRecipeSnapshot } from '@shardkeep/shared/phaseEBoundCosmetics';
import { boundCosmeticAwningForCompletedLevel } from '@shardkeep/shared/boundCosmeticVisual';
import { useBoundCosmeticWorkshop } from '../../lib/boundCosmetics/workshopBrowser';
import { awningCraftBlock, type AvailableWorkshopBase } from '../../lib/boundCosmetics/workshopController';
import { BoundCosmeticPreview } from './BoundCosmeticPreview';
import './BoundCosmeticWorkshop.css';

const title = (output: string): string => output === 'aurora_wake' ? 'Aurora Wake' : `Artisan Awning ${['I', 'II', 'III', 'IV'][Number(output.slice(-1)) - 1] ?? ''}`;
const material = (id: string) => id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const amount = (value: string) => BigInt(value).toLocaleString();
const duration = (seconds: number) => seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} sec`;
const date = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export function CosmeticMaterials({ recipe, base }: { recipe: BoundCosmeticRecipeSnapshot; base: Pick<AvailableWorkshopBase, 'craftingStock'> | null }) {
  return <dl className="sk-awning-materials" aria-label="Refined material requirements">{recipe.inputs.map(input => {
    const available = base?.craftingStock.find(row => row.itemId === input.itemId)?.available;
    const missing = available === undefined ? null : BigInt(input.quantity) > BigInt(available) ? BigInt(input.quantity) - BigInt(available) : 0n;
    return <div key={input.itemId} data-missing={missing !== null && missing > 0n}><dt>{material(input.itemId)}</dt><dd><span><strong>{amount(input.quantity)}</strong> needed</span>
      <span>{available === undefined ? 'Stock unavailable' : `${amount(available)} available`}</span><strong>{missing === null ? 'Not verified' : missing > 0n ? `${missing.toLocaleString()} missing` : 'Ready'}</strong></dd></div>;
  })}</dl>;
}
export function CosmeticReceipt({ proof }: { proof: Extract<BoundCosmeticEnvelope, { status: 'accepted' }> }) {
  return <article className="sk-awning-history-row"><div><strong>{title(proof.receipt.recipe.outputId)}</strong><span>{proof.completion ? 'Owned · stays with your account' : 'Crafting · original request accepted'}</span></div>
    <p>{proof.completion ? <>Completed <time dateTime={proof.completion.completedAt}>{date(proof.completion.completedAt)}</time></>
      : <>Due <time dateTime={proof.receipt.readyAt}>{date(proof.receipt.readyAt)}</time>. Refresh to check completion.</>}</p>
    <details><summary>Receipt details</summary><p>Original kingdom: {proof.receipt.request.baseId}</p><p>Request: {proof.idempotencyKey}</p><p>Recipe version: {proof.receipt.recipe.recipeVersion}</p>
      <p>Appearance binding: {proof.receipt.appearance.bindingSha256}</p><p>Observed: {proof.serverNow}</p></details></article>;
}
/** Unmounted section for the ordinary Workshop. Preview alone never enables
 * spending: the authoritative view must admit actual Awning application. */
export function BoundCosmeticWorkshop({ actionsEnabled = false }: { actionsEnabled?: boolean }) {
  const { state, baseId, actionsAllowed, preferenceAllowed, run, refresh, cancelReview } = useBoundCosmeticWorkshop(actionsEnabled);
  const [selected, setSelected] = useState<string | null>(null);
  const reviewNode = useRef<HTMLElement>(null), savedNode = useRef<HTMLElement>(null), alertNode = useRef<HTMLParagraphElement>(null);
  const view = state.view, base = view?.selectedBase?.state === 'available' ? view.selectedBase : null;
  const recipes = view?.recipes ?? [], row = recipes.find(r => r.recipe.recipeId === selected) ?? recipes[0];
  const operation = state.journal?.operation, review = state.review, accepted = operation?.proof?.status === 'accepted' ? operation.proof : null;
  const history = new Map<string, Extract<BoundCosmeticEnvelope, { status: 'accepted' }>>();
  for (const op of [...(state.journal?.archives ?? []), ...(operation ? [operation] : [])])
    if (op.proof?.status === 'accepted' && op.proof.receipt.recipe.outputId !== 'aurora_wake') history.set(op.proof.idempotencyKey, op.proof);
  for (const proof of view?.originals ?? []) if (proof.status === 'accepted' && proof.receipt.recipe.outputId !== 'aurora_wake') history.set(proof.idempotencyKey, proof);
  const owned = (view?.originals ?? []).filter((proof): proof is Extract<BoundCosmeticEnvelope, { status: 'accepted' }> => proof.status === 'accepted' && proof.completion !== null);
  const ownedCurrentTier = base?.markets.some(market => owned.some(proof => proof.receipt.recipe.outputId === boundCosmeticAwningForCompletedLevel(market.level))) ?? false;
  const originalSelected = !!operation && operation.command.request.baseId === baseId;
  const blocked = view && row ? awningCraftBlock(view, row) : null;
  useEffect(() => { if (review) reviewNode.current?.focus(); }, [review]);
  useEffect(() => { if (accepted) savedNode.current?.focus(); }, [accepted?.idempotencyKey]);
  useEffect(() => { if (state.error) alertNode.current?.focus(); }, [state.error]);
  return <section className="sk-awning-workshop" aria-label="Artisan Awning Workshop">
    <header className="sk-awning-heading"><div><p className="sk-awning-eyebrow">WORKSHOP · ACCOUNT APPEARANCES</p><h3>Artisan Market Awnings</h3></div><span className="sk-awning-badge">COSMETIC ONLY</span></header>
    <p className="sk-awning-intro">Craft a permanent appearance for your Market. Each tier stays with your account, and switching it on or off is free.</p>
    {state.error && <p className="sk-awning-message" role="alert" ref={alertNode} tabIndex={-1}>{state.error}</p>}
    {state.notice && <p className="sk-awning-message" role="status">{state.notice}</p>}
    {!state.loaded && <p role="status">Opening Workshop recovery…</p>}
    {state.loaded && !view && <p role="status">Current Workshop details are unavailable. Saved requests and receipts can still be checked below.</p>}
    {view && <>
      {!view.applicationReady && <p className="sk-awning-message" role="status">Awning application is unavailable. New crafts and switching on are paused. Your original receipts remain recoverable.</p>}
      {view.applicationReady && !view.acceptingJobs && <p className="sk-awning-message" role="status">New cosmetic crafting is paused. Existing appearances and original receipts remain yours.</p>}
      <section className="sk-equipment-card sk-awning-facts" aria-label="Workshop requirements"><h4>Before you craft</h4><dl>
        <div><dt>Artisan Finishes Blueprint</dt><dd>{view.blueprint.state === 'eligible' ? 'Earned from your completed refining job' : view.blueprint.state === 'not-earned' ? 'Complete one refining job to earn it' : 'History unavailable · try refreshing'}</dd></div>
        <div><dt>Completed Workshop</dt><dd>{base ? base.workshops.length ? 'Ready in this kingdom' : 'Build and complete a Workshop' : 'Choose a verified kingdom'}</dd></div>
        <div><dt>Completed Market</dt><dd>{base ? base.markets.length ? `Level ${Math.max(...base.markets.map(f => f.level))}` : 'Build and complete a Market' : 'Not verified'}</dd></div>
      </dl><p>Upgrades count when completed. Higher Awning tiers do not require crafting the lower ones.</p></section>
      <section className="sk-awning-queue" aria-label="Shared Workshop queue"><div><h4>Workshop queue</h4><span>{base ? base.queue.length ? 'IN PROGRESS' : 'AVAILABLE' : 'UNAVAILABLE'}</span></div>
        <p>Refining, equipment and cosmetics use the same job slot.</p>{base?.queue.map(job => <p key={job.jobId}><strong>{job.kind === 'cosmetic' ? title(job.recipe.outputId) : job.kind === 'equipment' ? 'Equipment crafting' : 'Material refining'}</strong> · Due <time dateTime={job.readyAt}>{date(job.readyAt)}</time>. Completion is checked by the server.</p>)}</section>
      <div className="sk-awning-catalogue" aria-label="Choose an Awning tier">{recipes.map(candidate => {
        const proof = [...history.values()].find(p => p.receipt.recipe.outputId === candidate.recipe.outputId), chosen = row?.recipe.recipeId === candidate.recipe.recipeId;
        return <article key={candidate.recipe.recipeId} className="sk-awning-choice" data-selected={chosen}>
          <BoundCosmeticPreview appearance={candidate.appearance} label={title(candidate.recipe.outputId)} animation="paused" />
          <div className="sk-awning-choice-footer"><p>Market level {candidate.recipe.requiredFacility.level} · {duration(candidate.recipe.durationSec)}</p>
            <span>{proof ? proof.completion ? 'OWNED' : 'CRAFTING' : 'NOT CRAFTED'}</span><button type="button" aria-pressed={chosen} onClick={() => setSelected(candidate.recipe.recipeId)}>{chosen ? 'SELECTED' : `SELECT TIER ${candidate.recipe.outputId.slice(-1)}`}</button></div>
        </article>;
      })}</div>
      {row && <section className="sk-equipment-card sk-awning-selected" aria-label="Selected Awning requirements"><div className="sk-awning-heading"><h4>{title(row.recipe.outputId)}</h4><span>{duration(row.recipe.durationSec)} · permanent</span></div>
        <CosmeticMaterials recipe={row.recipe} base={base} />{blocked && <p role="status">{blocked}</p>}
        <button type="button" className="sk-awning-primary" disabled={state.busy || !actionsAllowed || !base || !!blocked || !!operation}
          onClick={() => { if (base) run(c => c.begin(base.baseId, row.recipe.recipeId)); }}>REVIEW CRAFT</button>
        {operation && <p>Finish reviewing your saved request below before starting another.</p>}
      </section>}
      <section className="sk-equipment-card sk-awning-application" aria-label="Kingdom Awning setting"><div><h4>This kingdom’s Market</h4><strong>{base ? base.preference.enabled
        ? base.visual.state === 'unavailable' ? 'PREFERENCE ON · APPEARANCE UNVERIFIED' : base.visual.visual.marketAwnings.length ? 'AWNING APPLIED' : 'PREFERENCE ON · ORDINARY MARKET SHOWN'
        : 'ORDINARY APPEARANCE' : 'SETTING UNAVAILABLE'}</strong></div>
        <p>Use your owned appearance for the Market’s completed tier. If that tier is not owned, the ordinary Market stays visible. Ownership does not transfer with a kingdom.</p>
        {base?.visual.state === 'unavailable' && <p role="status">Current appearance could not be verified. This does not mean your setting was switched off.</p>}
        <button type="button" disabled={state.busy || !base || !preferenceAllowed || !base.preference.enabled && (!actionsAllowed || !view.applicationReady || !ownedCurrentTier)}
          onClick={() => { if (base) run(c => c.setPreference(base.baseId, !base.preference.enabled)); }}>{base?.preference.enabled ? 'USE ORDINARY APPEARANCE' : 'ENABLE OWNED AWNING'}</button><span className="sk-awning-free">Free · no materials consumed</span>
      </section>
    </>}
    {operation && <section ref={savedNode} tabIndex={-1} className="sk-equipment-card sk-awning-saved" aria-label="Saved Awning request">
      <p className="sk-awning-eyebrow">{accepted ? 'ORIGINAL REQUEST ACCEPTED' : operation.attempted ? 'OUTCOME NOT YET CONFIRMED' : 'SAVED · NOT SENT'}</p><h4>{title(operation.command.recipe.outputId)}</h4>
      <p>{accepted ? accepted.completion ? 'Your appearance is owned. Current kingdom settings are shown above.' : 'Your original craft is in progress. The server completes it automatically.'
        : operation.attempted ? 'This craft may already have started. Check its original receipt. Any resend uses the same saved request and cannot create a second craft.' : 'Your recipe, materials, appearance and original kingdom are saved. Nothing is consumed until you confirm.'}</p>
      {!originalSelected && !accepted && <p>Select the original kingdom before reviewing this request again. Receipt recovery remains available here.</p>}
      {review && !accepted && <section className="sk-awning-confirm" ref={reviewNode} tabIndex={-1} aria-label="Confirm Awning craft"><h4>Review before crafting</h4>
        <CosmeticMaterials recipe={review.command.recipe} base={review.view.selectedBase?.state === 'available' ? review.view.selectedBase : null} />
        <p><strong>These refined materials are consumed when crafting starts.</strong> The craft cannot be cancelled or refunded. It takes {duration(review.command.recipe.durationSec)} and grants one permanent account appearance, including if the kingdom changes owners.</p>
        <p>No SOL, KEEP, SHARDS or Gems payment. This is an appearance, with no Market advantage.</p>
        {operation.attempted && <p>This explicitly resends the same original request after checking its receipt.</p>}
        <div className="sk-awning-actions"><button type="button" className="sk-awning-primary" disabled={state.busy || !actionsAllowed || !originalSelected} onClick={() => run(c => c.confirm())}>{operation.attempted ? 'RESEND SAME CRAFT REQUEST' : 'CONFIRM & USE MATERIALS'}</button>
          <button type="button" onClick={cancelReview}>CANCEL REVIEW</button></div></section>}
      <div className="sk-awning-actions"><button type="button" disabled={state.busy} onClick={() => run(c => c.checkOriginal())}>CHECK ORIGINAL RECEIPT</button>
        {!accepted && !review && <button type="button" disabled={state.busy || !actionsAllowed || !originalSelected} onClick={() => run(c => c.reviewOriginal())}>REVIEW SAVED REQUEST</button>}
        {(accepted || !operation.attempted) && <button type="button" disabled={state.busy} onClick={() => run(c => c.archive())}>{accepted ? 'SAVE TO HISTORY' : 'ARCHIVE UNSENT DRAFT'}</button>}</div>
      <details><summary>Original request details</summary><p>Original kingdom: {operation.command.request.baseId}</p><p>Request: {operation.command.request.idempotencyKey}</p><p>Appearance binding: {operation.command.appearance.bindingSha256}</p></details>
    </section>}
    <details className="sk-awning-history"><summary>Craft history · {history.size}</summary>
      {!view && <p>Saved receipts are historical evidence. Refresh to check the current server state.</p>}
      {history.size ? [...history.values()].map(proof => <div key={proof.idempotencyKey}><CosmeticReceipt proof={proof} />
        {[...(state.journal?.archives ?? []), ...(operation ? [operation] : [])].some(op => op.command.request.idempotencyKey === proof.idempotencyKey)
          && <button type="button" disabled={state.busy} onClick={() => run(c => c.checkReceipt(proof.idempotencyKey))}>CHECK {title(proof.receipt.recipe.outputId).toUpperCase()} RECEIPT</button>}</div>) : <p>No accepted Awning crafts are available in this view.</p>}
    </details>
    <button type="button" disabled={state.busy} onClick={refresh}>REFRESH WORKSHOP & RECEIPTS</button>
  </section>;
}
