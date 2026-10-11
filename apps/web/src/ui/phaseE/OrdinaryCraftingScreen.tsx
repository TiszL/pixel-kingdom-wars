import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import type { OrdinaryCraftingRecipeSnapshot } from '@shardkeep/shared/phaseEOrdinaryCrafting';
import type { OrdinaryCraftingView } from '@shardkeep/shared/ordinaryCraftingApi';
import { useApp } from '../../state/store';
import type { OrdinaryCraftingOperation } from '../../lib/ordinaryCrafting/journal';
import { useOrdinaryCrafting } from '../../lib/ordinaryCrafting/useOrdinaryCrafting';
import { ordinaryCraftingBatch } from '../../lib/ordinaryCrafting/controller';
import { Btn, btnStyle, COLORS as C } from '../primitives';
import { EconomyPanel } from './EconomyPanel';
const whole = (value: string | number) => BigInt(value).toLocaleString('en-US');
const label = (id: string) => id === 'shards' ? 'SHARDS' : id.replaceAll('_', ' ').replaceAll('-', ' ').replace(/\b\w/g, c => c.toUpperCase());
const control = { minHeight: 48, width: '100%' };
const Awnings = lazy(() => import('./BoundCosmeticWorkshop').then(module => ({ default: module.BoundCosmeticWorkshop })));
const Wake = lazy(() => import('./BoundCosmeticWakeWorkshop').then(module => ({ default: module.BoundCosmeticWakeWorkshop })));
const inputStyle = { ...control, boxSizing: 'border-box' as const, margin: '8px 0', padding: 10, font: 'inherit', color: C.text, background: C.surface, border: `2px solid ${C.borderLt}` };
function Recipe({ recipe }: { recipe: OrdinaryCraftingRecipeSnapshot }): React.JSX.Element {
  return <><strong>{whole(recipe.output.quantity)} {label(recipe.output.itemId)}</strong>
    <p>Inputs: {recipe.inputs.map(input => `${whole(input.quantity)} ${label(input.itemId)}`).join(' + ')}</p>
    <p>{whole(recipe.durationSec)} seconds · Delivered automatically</p></>;
}
function ingredientStock(view: OrdinaryCraftingView, input: OrdinaryCraftingRecipeSnapshot['inputs'][number]): string | null {
  return input.kind === 'shards' ? ('shardsAvailable' in view ? view.shardsAvailable : null)
    : (input.kind === 'raw' ? view.rawStock.find(row => row.resourceId === input.itemId) : view.craftingStock.find(row => row.itemId === input.itemId))?.available ?? null;
}
function Ingredients({ recipe, view }: { recipe: OrdinaryCraftingRecipeSnapshot; view: OrdinaryCraftingView }): React.JSX.Element {
  return <dl className="sk-ordinary-ingredients" aria-label="Ingredients needed and owned">{recipe.inputs.map(input => {
    const owned = ingredientStock(view, input), missing = owned === null ? null : BigInt(input.quantity) - BigInt(owned);
    return <div key={input.itemId} data-missing={missing === null || missing > 0n}>
      <dt>{label(input.itemId)}</dt><dd><span>Need <strong>{whole(input.quantity)}</strong></span><span>Owned <strong>{owned === null ? 'Unavailable' : whole(owned)}</strong></span>
        <span className="sk-ordinary-ingredient-status">{missing === null ? 'Refresh stock' : missing > 0n ? `Missing ${whole(missing.toString())}` : 'Ready'}</span></dd>
    </div>;
  })}</dl>;
}
function Details({ operation }: { operation: OrdinaryCraftingOperation }): React.JSX.Element {
  const { command, proof } = operation;
  return <details><summary className="interactive" style={{ minHeight: 44, paddingTop: 12 }}>ORIGINAL REFINING DETAILS</summary>
    <p>Producing kingdom: {command.request.baseId}</p><p>Request: {command.request.idempotencyKey}</p><p>Recipe version: {command.recipe.recipeVersion}</p><Recipe recipe={command.recipe} />
    {operation.refusal && <p>Original refusal: {label(operation.refusal.code.toLowerCase())}.</p>}
    {proof?.status === 'accepted' && <><p>Started: {proof.receipt.startedAt} · Due: {proof.receipt.readyAt} (UTC).</p>
      <p>{proof.completion ? `Automatic completion observed: ${proof.completion.completedAt} (UTC).` : 'Automatic completion has not yet been observed. Check the original receipt for its completion.'}</p></>}
  </details>;
}
export function OrdinaryCraftingScreen({ actionsEnabled = true, historyOnly = false }: { actionsEnabled?: boolean; historyOnly?: boolean }): React.JSX.Element {
  const [section, setSection] = useState<'materials' | 'awnings' | 'wake'>('materials');
  const selector = <div role="group" aria-label="Workshop sections" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 110px), 1fr))', gap: 8, marginBottom: 16 }}>
    <button type="button" className="interactive" style={{ ...btnStyle(section === 'materials' ? 'gold' : 'sec', 18), ...control, minWidth: 0, paddingInline: 8, letterSpacing: '0.5px' }} aria-pressed={section === 'materials'} onClick={() => setSection('materials')}>MATERIALS</button>
    <button type="button" className="interactive" style={{ ...btnStyle(section === 'awnings' ? 'gold' : 'sec', 18), ...control, minWidth: 0, paddingInline: 8, letterSpacing: '0.5px' }} aria-pressed={section === 'awnings'} onClick={() => setSection('awnings')}>AWNINGS</button>
    <button type="button" className="interactive" style={{ ...btnStyle(section === 'wake' ? 'gold' : 'sec', 18), ...control, minWidth: 0, paddingInline: 8, letterSpacing: '0.5px' }} aria-pressed={section === 'wake'} onClick={() => setSection('wake')}>AURORA</button>
  </div>;
  if (section === 'materials') return <MaterialsWorkshop actionsEnabled={actionsEnabled && !historyOnly} historyOnly={historyOnly} selector={selector} />;
  const close = () => useApp.getState().setScreen('base');
  return <EconomyPanel title="Workshop" eyebrow="MATERIALS · APPEARANCES · HISTORY" onClose={close}>
    {selector}<Suspense fallback={<p role="status">Opening appearance Workshop…</p>}>{section === 'awnings' ? <Awnings actionsEnabled={actionsEnabled && !historyOnly} /> : <Wake actionsEnabled={actionsEnabled && !historyOnly} />}</Suspense>
    <Btn style={control} variant="sec" onClick={close}>BACK TO KINGDOM</Btn>
  </EconomyPanel>;
}
function MaterialsWorkshop({ actionsEnabled, historyOnly, selector }: { actionsEnabled: boolean; historyOnly: boolean; selector: ReactNode }): React.JSX.Element {
  const baseId = useApp(s => s.selectedBaseId);
  const { state, snapshot, refreshError, run, refresh, dismiss, finish, actionsAllowed } = useOrdinaryCrafting(actionsEnabled && !historyOnly);
  const [quantity, setQuantity] = useState('1'), [recipeId, setRecipeId] = useState(''), reviewNode = useRef<HTMLElement>(null), savedNode = useRef<HTMLElement>(null);
  const view = snapshot?.view, op = state.journal?.operation, review = state.review, accepted = op?.proof?.status === 'accepted';
  const count = /^[1-9][0-9]{0,9}$/.test(quantity) && Number.isSafeInteger(Number(quantity)) ? Number(quantity) : null;
  const busy = !state.loaded || state.busy, canAct = !busy && actionsAllowed;
  const originalSelected = !!op && op.command.request.baseId === baseId;
  const close = () => { dismiss(); useApp.getState().setScreen('base'); };
  const selectedRecipe = view?.recipes.find(recipe => recipe.recipeId === recipeId);
  const batch = selectedRecipe && count !== null && view && count <= view.maxBatch ? ordinaryCraftingBatch(selectedRecipe, count) : null;
  const missingIngredients = !!batch && !!view && batch.inputs.some(input => {
    const available = ingredientStock(view, input); return available === null || BigInt(available) < BigInt(input.quantity);
  });
  useEffect(() => { const node=review?reviewNode.current:accepted||op?.refusal?savedNode.current:null;node?.focus();node?.scrollIntoView?.({block:'start'}); }, [review,accepted,op?.refusal]);
  return <EconomyPanel title="Workshop" eyebrow="MATERIALS · APPEARANCES · HISTORY" onClose={close} error={state.error??refreshError}>
      {selector}
      <p>Refine resources or assemble kits. Review the ingredients before starting; finished output arrives automatically.</p>
      {!actionsAllowed && <p role="status">Game orders are paused. Original receipts remain available.</p>}
      {!state.loaded && <p role="status">Loading saved refining requests…</p>}
      {!view && state.loaded && <p>Current kingdom stock is unavailable. Saved receipts are historical proof and do not show spendable stock.</p>}
      {view && <section aria-label="Current selected kingdom stock">
        <div className="sk-economy-hero"><div><span>SELECTED KINGDOM · WORKSHOP</span><strong>{snapshot!.workshopLevel ? `Level ${snapshot!.workshopLevel}` : 'Not built'}</strong><span>{view.pendingJobs.length ? 'Crafting in progress' : 'Refine materials · Assemble kits'}</span></div></div>
        {!snapshot!.workshopLevel && <p>Complete a Workshop in this kingdom before starting a job.</p>}
        {!view.acceptingJobs && <p>New refining is paused. Accepted jobs still complete automatically.</p>}
        {view.pendingJobs.map(job => <section key={job.jobId} aria-label="Original pending refining job" className="sk-equipment-card"><h3>Refining in progress</h3><Recipe recipe={job.recipe} />
          <p>Due: {job.readyAt} (UTC). Refresh for the server's completion observation.</p></section>)}
        {!historyOnly && snapshot!.enabled && !op && <section aria-label="New ordinary refining job" className="sk-equipment-card"><h3>Choose your recipe</h3>
          <label>Recipe<select className="interactive" aria-label="Refining recipe" value={recipeId} onChange={event => setRecipeId(event.target.value)} disabled={!canAct || !!view.pendingJobs.length} style={inputStyle}>
            <option value="">Choose recipe</option>{['Refined materials', 'Crafted kits'].map(group => <optgroup key={group} label={group}>{view.recipes.filter(recipe => recipe.recipeId.startsWith('refine_') === (group === 'Refined materials')).map(recipe => <option key={recipe.recipeId} value={recipe.recipeId}>{label(recipe.output.itemId)}</option>)}</optgroup>)}
          </select></label>
          <label>Batches<input aria-label="Refining batches" className="interactive" inputMode="numeric" maxLength={10} value={quantity}
            onChange={event => setQuantity(event.target.value.replace(/[^0-9]/g, ''))} style={inputStyle} /></label>
          <p>Server batch limit: {whole(view.maxBatch)}. One refining job may run at a time.</p>
          {batch && <section aria-label="Selected recipe ingredients" className="sk-ordinary-recipe"><strong>{whole(batch.output.quantity)} {label(batch.output.itemId)}</strong><p>{whole(batch.durationSec)} seconds · Automatic delivery</p><Ingredients recipe={batch} view={view} /></section>}
          {missingIngredients && <p role="status">Gather the missing ingredients before starting this job.</p>}
          <Btn style={control} disabled={!canAct || !selectedRecipe || count === null || count > view.maxBatch || missingIngredients || !!view.pendingJobs.length}
            onClick={() => { if (selectedRecipe && count !== null) run(controller => controller.beginStart(view.baseId, selectedRecipe.recipeId, count)); }}>REVIEW REFINING</Btn>
        </section>}
        <div className="sk-economy-grid">
          <details className="sk-equipment-card"><summary>Raw resource stock</summary><dl className="sk-economy-values" aria-label="Raw resource stock">{view.rawStock.map(stock => <div key={stock.resourceId}><dt>{label(stock.resourceId)}</dt><dd>{whole(stock.available)} available · {whole(stock.reserved)} reserved · {whole(stock.total)} total</dd></div>)}</dl></details>
          <details className="sk-equipment-card"><summary>Refined materials & kits</summary><dl className="sk-economy-values" aria-label="Protected refined stock">{view.craftingStock.map(stock => <div key={stock.itemId}><dt>{label(stock.itemId)}</dt><dd>{whole(stock.available)} available · {whole(stock.pendingOutput)} pending output</dd></div>)}</dl></details>
        </div>
        <details><summary>Stock snapshot details</summary><p>Kingdom: {view.baseId} · Observed {view.serverNow} (UTC).</p></details>
      </section>}
      {op && <section aria-label="Saved refining request" ref={savedNode} tabIndex={-1} className="sk-equipment-card">
        <strong>{accepted ? 'ORIGINAL JOB ACCEPTED' : op.refusal ? 'ORIGINAL REQUEST DECLINED' : op.attemptRevision !== null ? 'ORIGINAL OUTCOME UNKNOWN' : 'SAVED UNSENT DRAFT'}</strong>
        <p>{accepted ? 'Historical proof only. Current stock comes from the selected kingdom snapshot above.' : op.attemptRevision !== null && !op.refusal
          ? 'This job may have been accepted. Check its original receipt before explicitly reviewing the same request again.' : 'The exact recipe, inputs, output and kingdom remain saved.'}</p>
        {!originalSelected && <p>Select the original kingdom to review a new attempt. Receipt checks and history remain available here.</p>}
        {review && !accepted && !op.refusal && <section ref={reviewNode} tabIndex={-1} aria-label="Confirm ordinary refining" className="sk-equipment-review sk-equipment-card">
          <Recipe recipe={review.command.recipe} /><Ingredients recipe={review.command.recipe} view={review.view} /><p>Output goes to the originally selected kingdom.</p><details><summary>Confirm destination</summary><p>Producing kingdom: {review.command.request.baseId}</p></details>
          <p>Inputs are consumed at start. This job cannot be cancelled or refunded. Output arrives automatically, including after a kingdom transfer. No SOL, KEEP or Gems payment.</p>
          {review.command.recipe.inputs.some(input => input.kind === 'shards') && <p>SHARDS shown above are a recipe ingredient and are consumed with the materials.</p>}
          {op.attemptRevision !== null && <p>This explicitly resends the same original request after checking its receipt.</p>}
          <Btn style={control} disabled={!canAct || !originalSelected} onClick={() => run(controller => controller.confirm())}>CONFIRM REFINING</Btn>
          <Btn style={{ ...control, marginTop: 8 }} variant="sec" onClick={dismiss}>CANCEL REVIEW</Btn>
        </section>}
        <div className="sk-economy-actions">
          {!accepted && !op.refusal && !review && <Btn style={control} disabled={!canAct || !originalSelected} onClick={() => run(controller => controller.reviewCommand())}>REVIEW ORIGINAL REQUEST</Btn>}
          <Btn style={control} variant="sec" disabled={busy} onClick={() => run(controller => controller.open())}>CHECK ORIGINAL RECEIPT</Btn>
          {op.attemptRevision === null && !accepted && <Btn style={control} variant="sec" disabled={busy} onClick={() => run(controller => controller.abandonDraft())}>ARCHIVE UNUSED DRAFT</Btn>}
          {accepted && <Btn style={control} variant="sec" disabled={busy} onClick={finish}>ARCHIVE ACCEPTED JOB</Btn>}
          {op.refusal && !accepted && <Btn style={control} variant="sec" disabled={busy} onClick={() => run(controller => controller.archiveRefusal())}>ARCHIVE DECLINED REQUEST</Btn>}
        </div>
        <Details operation={op} />
      </section>}
      {!!state.journal?.archives.length && <details><summary className="interactive" style={{ minHeight: 44, paddingTop: 12 }}>REFINING HISTORY ({state.journal.archives.length})</summary>
        {state.journal.archives.map(archive => <section key={archive.operation.command.request.idempotencyKey}>
          <p>{archive.reason === 'accepted' ? 'Historical accepted job' : archive.reason === 'refused' ? 'Declined request' : 'Unused draft'}</p><Details operation={archive.operation} />
          {archive.reason !== 'accepted' && archive.operation.proof && <p>Original acceptance recovered after archival. Earlier refusal or absence evidence remains saved.</p>}
          <Btn style={control} variant="sec" disabled={busy} onClick={() => run(controller => controller.checkArchived(archive.operation.command.request.idempotencyKey))}>{archive.operation.proof ? 'CHECK AUTOMATIC COMPLETION' : 'CHECK ARCHIVED RECEIPT'}</Btn>
        </section>)}
      </details>}
      <Btn style={control} variant="sec" disabled={busy} onClick={refresh}>REFRESH STOCK & RECEIPTS</Btn>
      <Btn style={control} variant="sec" onClick={close}>BACK TO KINGDOM</Btn>
  </EconomyPanel>;
}
