import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BaseFeatureProps } from '../featureRegistry';
import { useApp } from '../../../state/store';
import { useBuildingActivityAccess } from '../../../lib/phaseEActivity/access';
import { useWorkshop } from '../../../lib/workshop/useWorkshop';
import { useOrdinaryCrafting } from '../../../lib/ordinaryCrafting/useOrdinaryCrafting';
import { workshopBase, type WorkshopOperation } from '../../../lib/workshop/journal';
import type { OrdinaryCraftingOperation } from '../../../lib/ordinaryCrafting/journal';
import { PkSecondaryButton } from '../Button';
import { featureId, type CommandUi } from '../types';
import { PkWorkshopSheet, type CraftFrameUi } from './CraftSheets';
import { ingotJobs, ingotWorkshopModel, ordinaryJobs, ordinaryWorkshopModel, workshopItemName } from './workshopAdapter';
import './WorkshopPanel.css';

type Tab = 'REFINE' | 'INGOTS' | 'EQUIPMENT' | 'COSMETICS';
const whole = (value: string | number | bigint): string => BigInt(value).toLocaleString('en-US');
function OrdinaryDetails({ operation }: { operation: OrdinaryCraftingOperation }): React.JSX.Element {
  const { command, proof } = operation;
  return <details><summary>Original refining details</summary>
    <p>Kingdom: {command.request.baseId}</p><p>Request: {command.request.idempotencyKey}</p>
    <p>{whole(command.recipe.output.quantity)} {workshopItemName(command.recipe.output.itemId)}</p>
    <p>Inputs: {command.recipe.inputs.map(input => `${whole(input.quantity)} ${workshopItemName(input.itemId)}`).join(' + ')}</p>
    {operation.refusal ? <p>Original refusal: {operation.refusal.code}</p> : null}
    {proof?.status === 'accepted' ? <><p>Accepted job: {proof.receipt.jobId}</p><p>Due: {proof.receipt.readyAt}</p><p>{proof.completion ? `Automatic completion observed: ${proof.completion.completedAt}` : 'Automatic completion has not yet been observed.'}</p></> : null}
  </details>;
}
function IngotDetails({ operation }: { operation: WorkshopOperation }): React.JSX.Element {
  const receipt = operation.proof?.receipt;
  return <details><summary>Original ingot details</summary><p>Kingdom: {workshopBase(operation.command)}</p><p>Request: {operation.command.request.idempotencyKey}</p>
    {operation.command.kind === 'start' ? <p>{whole(operation.command.request.ingots)} Forge Ingots</p> : <p>Job: {operation.command.jobId}</p>}
    {operation.refusal ? <p>Original refusal: {operation.refusal.code}</p> : null}
    {receipt ? <><p>Receipt: {receipt.receiptId}</p>{'shardsCharged' in receipt ? <p>{whole(receipt.shardsCharged)} SHARDS spent · Ready {receipt.readyAt}</p> : <p>{whole(receipt.ingotsCredited)} ingots collected · {receipt.collectedAt}</p>}</> : null}
  </details>;
}

/** A new sheet body over the two unchanged original hooks. No fetch, POST,
 * signing, optimistic stock, new idempotency key or independently owned journal. */
export default function WorkshopPanel({ session, onClose, actionsEnabled: hostActionsEnabled }: BaseFeatureProps): React.JSX.Element {
  // Required host capability; untyped omissions must never invoke a hook default of true.
  const actionsEnabled=hostActionsEnabled===true;
  const baseId = useApp(state => state.selectedBaseId);
  // Subscribe unconditionally: a retained panel must react to grant revocation.
  // Navigation grants intentionally survive host capability loss; require both.
  const ordinaryAccess = useBuildingActivityAccess('ordinary-crafting');
  const ordinary = useOrdinaryCrafting(actionsEnabled && ordinaryAccess), ingots = useWorkshop(actionsEnabled);
  const [tab, setTab] = useState<Tab>('REFINE'), [recipeId, setRecipe] = useState(''), [quantity, setQuantity] = useState(1);
  const [history, setHistory] = useState(false), [sourceNotice, setSourceNotice] = useState<string | null>(null), [dispatchHeld, setDispatchHeld] = useState(false);
  useEffect(()=>{setDispatchHeld(false);},[ordinary.actionsAllowed,ingots.actionsAllowed]);
  const initialized = useRef(false), reviewNode = useRef<HTMLElement>(null);
  const ordinaryOp = ordinary.state.journal?.operation, ingotOp = ingots.state.journal?.operation;
  const saved = !!ordinaryOp || !!ingotOp, busy = ordinary.state.busy || ingots.state.busy;
  const loaded = ordinary.state.loaded && ingots.state.loaded;
  const active = tab === 'INGOTS' ? ingots : ordinary;
  const live = useRef({ busy, allowed: active.actionsAllowed }); live.current = { busy, allowed: active.actionsAllowed };
  useLayoutEffect(() => session.setDismissPolicy(request => {
    if (live.current.busy) { request.cancel?.(); return; }
    // Dismiss the current consent, preserve its durable original draft/proof,
    // then invoke exactly the host continuation (never navigate independently).
    ordinary.dismiss(); ingots.dismiss(); request.proceed();
  }), [session, ordinary.dismiss, ingots.dismiss]);
  useEffect(() => {
    if (!loaded || initialized.current) return;
    initialized.current = true;
    if (!ordinaryOp && (ingotOp || ingotJobs(ingots.snapshot, baseId).some(job => job.state === 'READY'))) setTab('INGOTS');
  }, [loaded, ordinaryOp, ingotOp, ingots.snapshot, baseId]);
  useEffect(() => { reviewNode.current?.focus(); }, [ordinary.state.review, ingots.state.review]);
  const read = (action: () => void) => { if (!busy) session.dispatch('recover', action); };
  const mutate = (owner: { actionsAllowed: boolean }, action: () => void) => { if (loaded && !busy && owner.actionsAllowed) { const accepted = session.dispatch('mutate', action); setDispatchHeld(!accepted); } };
  const refresh = () => read(() => { ordinary.refresh(); ingots.refresh(); });
  const check = () => read(() => {
    if (ordinaryOp) ordinary.run(controller => controller.open());
    if (ingotOp) ingots.run(controller => controller.open());
  });
  const ordinaryModel = ordinaryWorkshopModel(ordinary.snapshot, baseId, tab === 'EQUIPMENT' ? 'EQUIPMENT' : 'REFINE', recipeId, tab === 'EQUIPMENT' ? 1 : quantity);
  const ingotModel = ingotWorkshopModel(ingots.snapshot, baseId, quantity);
  const model = tab === 'INGOTS' ? ingotModel : ordinaryModel;
  const appearance = tab === 'COSMETICS';
  const error = active.state.error ?? active.refreshError;
  const frame: CraftFrameUi = { title: 'Workshop', level: active.snapshot ? `LV ${tab === 'INGOTS' ? ingots.snapshot!.view.level : ordinary.snapshot!.workshopLevel}` : null,
    status: active.snapshot ? 'Current kingdom stock' : 'Current stock is unavailable', art: null,
    hydration: !loaded || busy ? 'LOADING' : error ? 'ERROR' : 'READY', error, submit: busy ? 'CHECKING' : 'IDLE', authoritativeRefusal: null, savedRequest: saved };
  const primary: CommandUi = { id: featureId('craft.workshop.review'), caption: appearance ? 'UNAVAILABLE' : 'REVIEW REFINING', icon: 'shape:hammer', price: appearance ? null : model.price,
    primary: true, state: !appearance && model.canStart && active.actionsAllowed && !saved ? 'ENABLED' : 'DISABLED', reason: appearance ? 'Appearances are unavailable here.' : model.reason, badge: null, verb: 'GOLD' };
  const start = () => {
    if (!model.canStart || saved || appearance || !baseId) return;
    mutate(tab === 'INGOTS' ? ingots : ordinary, () => tab === 'INGOTS' ? ingots.run(controller => controller.beginStart(baseId, quantity, ingots.snapshot!.view.recipeVersion))
      : ordinary.run(controller => controller.beginStart(baseId, recipeId, tab === 'EQUIPMENT' ? 1 : quantity)));
  };
  const jobs = tab === 'INGOTS' ? ingotJobs(ingots.snapshot, baseId) : ordinaryJobs(ordinary.snapshot, baseId);
  const ordinaryAccepted = ordinaryOp?.proof?.status === 'accepted', ingotAccepted = ingotOp?.proof?.status === 'accepted';
  const ordinaryOriginal = !!ordinaryOp && ordinaryOp.command.request.baseId === baseId;
  const ingotOriginal = !!ingotOp && workshopBase(ingotOp.command) === baseId;
  const cancelReview = () => read(() => { ordinary.dismiss(); ingots.dismiss(); });
  return <PkWorkshopSheet frame={frame} primary={primary} tab={tab} recipes={appearance ? [] : model.recipes} selectedRecipe={appearance ? null : model.recipe}
    job={null} ingotLimits={ingotModel.limits} onRecipe={id => { if (!busy && !saved) { setRecipe(id); setQuantity(1); } }} onQuantity={setQuantity}
    onTab={id => { if (!busy && !saved && ['REFINE', 'INGOTS', 'EQUIPMENT', 'COSMETICS'].includes(id)) { setTab(id as Tab); setRecipe(''); setQuantity(1); setSourceNotice(null); } }}
    onSource={id => {
      const madeHere = ordinary.snapshot?.view.recipes.find(recipe => recipe.output.itemId === id);
      if (madeHere && !busy && !saved) { setTab(madeHere.recipeId.startsWith('refine_') ? 'REFINE' : 'EQUIPMENT'); setRecipe(madeHere.recipeId); setQuantity(1); }
      else setSourceNotice(`Gather ${workshopItemName(id)} in your kingdom, then refresh your stock.`);
    }} onCollection={() => undefined}
    actions={{ onClose, onHistory: () => setHistory(value => !value), onRetry: refresh, onCheckSaved: check, onCommand: start }}>
    <div className="pk-workshop-adapter">
      {!active.actionsAllowed || dispatchHeld ? <p role="status">Orders are paused. Original receipts remain available.</p> : null}
      {sourceNotice ? <p role="status">{sourceNotice}</p> : null}
      {appearance ? <p>Appearances are unavailable here.</p> : null}
      {tab === 'INGOTS' && ingots.snapshot?.view.inventory.baseId === baseId ? <dl aria-label="Current ingot stock and allowance">
        <div><dt>Held in this kingdom</dt><dd>{whole(ingots.snapshot.view.inventory.held)}</dd></div>
        <div><dt>{ingots.snapshot.view.allowance.scope === 'free_wallet' ? 'Shared daily starts remaining' : 'Kingdom daily starts remaining'}</dt><dd>{whole(ingots.snapshot.view.allowance.daily.remaining)}</dd></div>
        <div><dt>{ingots.snapshot.view.allowance.scope === 'free_wallet' ? 'Shared ingot space remaining' : 'Kingdom ingot space remaining'}</dt><dd>{whole(ingots.snapshot.view.allowance.holding.remaining)}</dd></div>
      </dl> : null}
      {!appearance && jobs.map(job => <section key={job.id} className="pk-craft__job"><h3>{job.name}</h3><p>{job.quantity} · {job.statusLabel}</p>
        {job.mode === 'SERVER' ? <PkSecondaryButton label="REVIEW COLLECTION" enabled={loaded && !busy && !saved && ingots.actionsAllowed && job.state === 'READY'}
          onClick={() => { if (job.state === 'READY' && !saved && baseId) mutate(ingots, () => ingots.run(controller => controller.beginCollect(baseId, job.id))); }} /> : null}
      </section>)}
      {ordinaryOp ? <section aria-label="Saved refining request">
        <h3>{ordinaryAccepted ? 'Original job accepted' : ordinaryOp.refusal ? 'Original request declined' : ordinaryOp.attemptRevision !== null ? 'The original outcome is being checked' : 'Saved unsent draft'}</h3>
        <p>Historical proof does not change the current stock shown above.</p>
        {!ordinaryOriginal ? <p>Select the original kingdom to review a new attempt.</p> : null}
        {ordinary.state.review && !ordinaryAccepted && !ordinaryOp.refusal ? <section ref={reviewNode} tabIndex={-1} aria-label="Confirm ordinary refining">
          <p>{ordinary.state.review.command.recipe.inputs.map(input => `${whole(input.quantity)} ${workshopItemName(input.itemId)}`).join(' + ')}</p>
          <p>Receive {whole(ordinary.state.review.command.recipe.output.quantity)} {workshopItemName(ordinary.state.review.command.recipe.output.itemId)} in the original kingdom.</p>
          <p>Inputs are consumed at start. No cancellation or refund. Delivery is automatic. No SOL, KEEP or Gems payment.</p>
          <PkSecondaryButton label="CONFIRM REFINING" enabled={!busy && ordinary.actionsAllowed && ordinaryOriginal} onClick={() => mutate(ordinary, () => ordinary.run(controller => controller.confirm()))} />
          <PkSecondaryButton label="CANCEL REVIEW" enabled={!busy} onClick={cancelReview} />
        </section> : null}
        {!ordinaryAccepted && !ordinaryOp.refusal && !ordinary.state.review ? <PkSecondaryButton label="REVIEW ORIGINAL REQUEST" enabled={!busy && ordinary.actionsAllowed && ordinaryOriginal} onClick={() => mutate(ordinary, () => ordinary.run(controller => controller.reviewCommand()))} /> : null}
        <PkSecondaryButton label="CHECK ORIGINAL RECEIPT" enabled={!busy} onClick={() => read(() => ordinary.run(controller => controller.open()))} />
        {ordinaryOp.attemptRevision === null && !ordinaryAccepted ? <PkSecondaryButton label="ARCHIVE UNUSED DRAFT" enabled={!busy} onClick={() => read(() => ordinary.run(controller => controller.abandonDraft()))} /> : null}
        {ordinaryAccepted ? <PkSecondaryButton label="ARCHIVE ACCEPTED JOB" enabled={!busy} onClick={() => read(ordinary.finish)} /> : null}
        {ordinaryOp.refusal && !ordinaryAccepted ? <PkSecondaryButton label="ARCHIVE DECLINED REQUEST" enabled={!busy} onClick={() => read(() => ordinary.run(controller => controller.archiveRefusal()))} /> : null}
        <OrdinaryDetails operation={ordinaryOp} />
      </section> : null}
      {ingotOp ? <section aria-label="Saved ingot request"><h3>{ingotAccepted ? 'Original receipt confirmed' : ingotOp.refusal ? 'Original request declined' : ingotOp.attempted ? 'The original outcome is being checked' : 'Saved unsent draft'}</h3>
        <p>Historical proof does not change the current inventory or allowance.</p>
        {!ingotOriginal ? <p>Select the original kingdom to review a new attempt.</p> : null}
        {ingots.state.review && !ingotAccepted && !ingotOp.refusal ? <section ref={reviewNode} tabIndex={-1} aria-label="Confirm ingot request">
          {ingots.state.review.command.kind === 'start' ? <><p>{whole(BigInt(ingots.state.review.command.request.ingots) * BigInt(ingots.state.review.view.shardsPerIngot))} SHARDS → {whole(ingots.state.review.command.request.ingots)} INGOTS</p>
            <p>Final charge at start. No cancellation, refund or SOL fee.</p></> : <p>Collect the original paid job into its producing kingdom. No SOL fee.</p>}
          <PkSecondaryButton label={ingots.state.review.command.kind === 'start' ? 'CONFIRM REFINING' : 'CONFIRM COLLECTION'} enabled={!busy && ingots.actionsAllowed && ingotOriginal} onClick={() => mutate(ingots, () => ingots.run(controller => controller.confirm()))} />
          <PkSecondaryButton label="CANCEL REVIEW" enabled={!busy} onClick={cancelReview} />
        </section> : null}
        {!ingotAccepted && !ingotOp.refusal && !ingots.state.review ? <PkSecondaryButton label="REVIEW ORIGINAL REQUEST" enabled={!busy && ingots.actionsAllowed && ingotOriginal} onClick={() => mutate(ingots, () => ingots.run(controller => controller.reviewCommand()))} /> : null}
        <PkSecondaryButton label="CHECK ORIGINAL INGOT RECEIPT" enabled={!busy} onClick={() => read(() => ingots.run(controller => controller.open()))} />
        {!ingotOp.attempted && !ingotAccepted ? <PkSecondaryButton label="ARCHIVE UNUSED INGOT DRAFT" enabled={!busy} onClick={() => read(() => ingots.run(controller => controller.abandonDraft()))} /> : null}
        {ingotAccepted ? <PkSecondaryButton label="ARCHIVE CONFIRMED RECEIPT" enabled={!busy} onClick={() => read(() => ingots.run(controller => controller.finish()))} /> : null}
        {ingotOp.refusal && !ingotAccepted ? <PkSecondaryButton label="ARCHIVE DECLINED INGOT REQUEST" enabled={!busy} onClick={() => read(() => ingots.run(controller => controller.archiveRefusal()))} /> : null}
        <IngotDetails operation={ingotOp} />
      </section> : null}
      {history ? <section aria-label="Workshop history"><h3>Original receipts</h3>
        {ordinary.state.journal?.archives.map(archive => <article key={archive.operation.command.request.idempotencyKey}><OrdinaryDetails operation={archive.operation} />
          <PkSecondaryButton label="CHECK ARCHIVED RECEIPT" enabled={!busy} onClick={() => read(() => ordinary.run(controller => controller.checkArchived(archive.operation.command.request.idempotencyKey)))} /></article>)}
        {ingots.state.journal?.archives.map(archive => <IngotDetails key={archive.operation.command.request.idempotencyKey} operation={archive.operation} />)}
      </section> : null}
      <PkSecondaryButton label="REFRESH" enabled={!busy} onClick={refresh} />
    </div>
  </PkWorkshopSheet>;
}
