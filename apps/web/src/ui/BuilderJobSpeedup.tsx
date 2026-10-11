import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { BuilderJobSpeedupContext } from '../lib/builderJobSpeedup/context';
import { useBuilderJobSpeedup } from '../lib/builderJobSpeedup/useBuilderJobSpeedup';
import type { BuilderOperation } from '../lib/builderJobSpeedup/journal';
import { useApp, type BaseStateDto } from '../state/store';
import { Btn, COLORS as C, Icon, ModalWrap, Phead } from './primitives';

const control = { minHeight: 44, width: '100%' };
const amount = (value: string) => BigInt(value).toLocaleString('en-US');
const actionName = { upgrade: 'UPGRADE', repair: 'REPAIR', clear_obstacle: 'OBSTACLE CLEARING' } as const;
const completionTime = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
// Optional display context only; never use a replacement job's label for saved consent.
function targetName(base: BaseStateDto | undefined, intent: BuilderOperation['intent'] | null): string | null {
  if (!base || !intent || base.baseId !== intent.baseId) return null;
  const c = intent.consent, job = base.jobs.find(row => row.id === intent.jobId);
  if (!job || job.kind !== c.kind || job.buildingId !== c.buildingId || job.obstacleId !== c.obstacleId || job.startedAt !== c.startedAt || job.finishesAt !== c.finishesAt) return null;
  const name = c.buildingId ? base.buildings.find(row => row.id === c.buildingId)?.type : base.obstacles.find(row => row.id === c.obstacleId)?.spriteKey;
  return typeof name === 'string' ? name.replaceAll('_', ' ').toUpperCase() : null;
}
function OriginalDetails({ op }: { op: BuilderOperation }): React.JSX.Element {
  const intent = op.intent, proof = op.proof?.status === 'accepted' ? op.proof : null;
  return <details><summary className="interactive" style={{ minHeight: 44, paddingTop: 12 }}>ORIGINAL PAYMENT DETAILS</summary>
    <p>Original job: {intent.jobId} · {intent.consent.kind.replaceAll('_', ' ')}</p>
    <p>Original target: {intent.consent.buildingId ?? intent.consent.obstacleId}</p>
    <p>{intent.consent.startedAt} → {intent.consent.finishesAt}</p>
    <p>Original kingdom: {intent.baseId}</p><p>Request: {intent.idempotencyKey}</p>
    <p>Approved maximum: {amount(intent.consent.maxCostKeep)} {intent.expectedCurrency}</p>
    {proof && <><p>Paid: {amount(proof.funding.amount)} {proof.funding.currency}</p><p>Receipt: {proof.receiptId} · {proof.acceptedAt}</p></>}
    {op.refusal && <p>Declined: {op.refusal.code.replaceAll('_', ' ').toLowerCase()}.</p>}
  </details>;
}

/** A single wallet journal owner spans the building sheet, obstacle sheet and historical recovery
 * surfaces. Entry-point controls and the dedicated confirmation use this context. */
export function BuilderJobSpeedupProvider({ children, actionsEnabled }: { children: ReactNode; actionsEnabled: boolean }): React.JSX.Element {
  const money = useBuilderJobSpeedup(actionsEnabled), { state, run, dismiss } = money;
  const [opened, setOpened] = useState(false), focus = useRef<HTMLDivElement>(null);
  const screen = useApp(s => s.screen), baseId = useApp(s => s.selectedBaseId), wallet = useApp(s => s.wallet), selected = useApp(s => s.selectedBuildingId), category = useApp(s => s.buildCategory), obstacle = useApp(s => s.selectedObstacleId);
  const close = () => { dismiss(); setOpened(false); };
  const op = state.journal?.operation, review = state.review, busy = !state.loaded || state.busy;
  const canAct = !busy && money.actionsEnabled, originalSelected = !!op && op.intent.baseId === baseId;
  const history = state.journal?.archives ?? [];
  const target = targetName(money.snapshot?.base, review);
  const visible = ['base', 'build', 'army', 'bases', 'inventory'].includes(screen);
  useEffect(() => { setOpened(false); }, [wallet, screen, selected, obstacle, category, baseId]);
  useEffect(() => {
    if (!opened) return;
    focus.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); setOpened(false); } };
    window.addEventListener('keydown', escape, true); return () => window.removeEventListener('keydown', escape, true);
  }, [opened, review, dismiss]);
  return <BuilderJobSpeedupContext.Provider value={{ ...money,
    begin: input => { setOpened(true); run(c => c.begin(input)); }, openHistory: () => { setOpened(true); money.refresh(); } }}>
    {children}
    {visible && opened && createPortal(<ModalWrap onBackdrop={close}><Phead title={review ? 'REVIEW BUILDER PAYMENT' : 'BUILDER PAYMENTS'} onClose={close} />
      <div ref={focus} tabIndex={-1} role={review ? 'alertdialog' : 'dialog'} aria-modal="true" aria-label={review ? 'Confirm Builder payment' : 'Builder payment recovery'}
        style={{ padding: 14, display: 'grid', gap: 12, overflowWrap: 'anywhere', minWidth: 0 }}>
        {!money.actionsEnabled && <p role="status">New Builder payments are paused. Your original receipts remain available.</p>}
        {busy && <p role="status">Checking the original Builder request…</p>}
        {(state.error || money.refreshError) && <p role="alert" style={{ color: C.danger }}>{state.error ?? money.refreshError}</p>}
        {review ? <>
          <strong style={{ color: C.goldHi }}>FINISH {actionName[review.consent.kind]}{target ? ` · ${target}` : ''}</strong>
          <div role="group" aria-label={`Up to ${amount(review.consent.maxCostKeep)} ${review.expectedCurrency}`} style={{ padding: 12, border: `2px solid ${C.gold}`, textAlign: 'center', display: 'grid', gap: 8 }}>
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}><Icon name={review.expectedCurrency === 'GEMS' ? 'gem' : 'keep'} size={32} /> {review.expectedCurrency}</span>
            <strong style={{ fontSize: 24 }}>UP TO {amount(review.consent.maxCostKeep)}</strong>
          </div>
          <p>Scheduled completion: {completionTime(review.consent.finishesAt)}</p>
          {op && <OriginalDetails op={op} />}
          <p>This payment can use only {review.expectedCurrency}. It cannot switch to another balance.</p>
          <p>Finishes only this original job. The final price may decrease as it runs; this maximum cannot increase. A naturally completed job is not proof of payment.</p>
          <Btn style={control} disabled={!canAct || !originalSelected} onClick={() => run(c => c.confirm())}>CONFIRM {review.expectedCurrency}</Btn>
          <Btn style={control} variant="sec" onClick={close}>CANCEL REVIEW</Btn>
        </> : <>
          {op && <section aria-label="Saved Builder command">
            <strong>{op.proof ? 'ORIGINAL PAYMENT CONFIRMED' : op.refusal ? 'ORIGINAL PAYMENT DECLINED' : op.attempted ? 'ORIGINAL PAYMENT OUTCOME PENDING' : 'ORIGINAL UNSENT DRAFT'}</strong>
            <p>{op.proof ? 'This is historical payment evidence. Current buildings, obstacles and balances come from a fresh server view.'
              : op.refusal ? 'The first request was declined before spending. Archive its original record before reviewing another.'
                : op.attempted ? 'Keep this original request. A missing reply does not prove that nothing was spent.' : 'No payment has been attempted. Closing this panel keeps the original draft.'}</p>
            <OriginalDetails op={op} />
            {!op.proof && !op.refusal && <Btn style={control} disabled={!canAct || !originalSelected} onClick={() => run(c => c.reviewCommand())}>{op.attempted ? 'REVIEW SAME-KEY RETRY' : 'REVIEW ORIGINAL REQUEST'}</Btn>}
            <Btn style={control} variant="sec" disabled={busy} onClick={() => run(c => c.open())}>CHECK ORIGINAL RECEIPT</Btn>
            {!op.attempted && !op.proof && !op.refusal && <Btn style={control} variant="sec" disabled={busy} onClick={() => run(c => c.abandon())}>ARCHIVE UNUSED DRAFT</Btn>}
            {(op.proof || op.refusal) && <Btn style={control} variant="sec" disabled={busy} onClick={() => run(c => c.finish())}>{op.proof ? 'ARCHIVE CONFIRMED RECEIPT' : 'ARCHIVE DECLINED REQUEST'}</Btn>}
          </section>}
          {history.length > 0 && <details><summary className="interactive" style={{ minHeight: 44, paddingTop: 12 }}>BUILDER PAYMENT HISTORY ({history.length})</summary>
            {history.map(a => <section key={a.operation.intent.idempotencyKey}><p>{a.reason === 'accepted' ? 'Confirmed historical payment' : a.reason === 'refused' ? 'Declined original request' : 'Unused draft archived before any attempt'}</p><OriginalDetails op={a.operation} /></section>)}
          </details>}
          {!op && !history.length && !busy && <p>No saved Builder payment. Open a running upgrade, repair or obstacle clearing to review its current server price.</p>}
          <Btn style={control} variant="sec" onClick={close}>CLOSE</Btn>
        </>}
      </div>
    </ModalWrap>, document.body)}
  </BuilderJobSpeedupContext.Provider>;
}
