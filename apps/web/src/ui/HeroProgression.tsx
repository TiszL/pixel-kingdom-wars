import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { HeroProgressionContext } from '../lib/heroProgression/context';
import { useHeroProgression } from '../lib/heroProgression/useHeroProgression';
import type { HeroOperation } from '../lib/heroProgression/journal';
import { useApp } from '../state/store';
import { Btn, COLORS as C, Icon, ModalWrap, Phead } from './primitives';

const control = { minHeight: 44, width: '100%' };
const amount = (value: string) => BigInt(value).toLocaleString('en-US');
function OriginalDetails({ op }: { op: HeroOperation }): React.JSX.Element {
  const intent = op.intent, proof = op.proof?.status === 'accepted' ? op.proof : null;
  return <details><summary className="interactive" style={{ minHeight: 44, paddingTop: 12 }}>ORIGINAL PAYMENT DETAILS</summary>
    <p>{intent.hero.toUpperCase()} · {intent.kind === 'upgrade' ? `LEVEL ${intent.expectedLevel} → ${intent.expectedLevel + 1}` : `INJURY ${intent.recoveryUntil}`}</p>
    <p>Original kingdom: {intent.baseId}</p><p>Request: {intent.idempotencyKey}</p>
    <p>Approved maximum: {amount(intent.maxCostKeep)} {intent.expectedCurrency}</p>
    {proof && <><p>Paid: {amount(proof.funding.amount)} {proof.funding.currency}</p><p>Receipt: {proof.receiptId} · {proof.acceptedAt}</p></>}
    {op.refusal && <p>Declined: {op.refusal.code.replaceAll('_', ' ').toLowerCase()}.</p>}
  </details>;
}

/** A single wallet journal owner spans the altar, tray and historical recovery
 * surfaces. Entry-point controls and the dedicated confirmation use this context. */
export function HeroProgressionProvider({ children, actionsEnabled }: { children: ReactNode; actionsEnabled: boolean }): React.JSX.Element {
  const money = useHeroProgression(actionsEnabled), { state, run, dismiss } = money;
  const [opened, setOpened] = useState(false), focus = useRef<HTMLDivElement>(null);
  const screen = useApp(s => s.screen), baseId = useApp(s => s.selectedBaseId), wallet = useApp(s => s.wallet), selected = useApp(s => s.selectedBuildingId), category = useApp(s => s.buildCategory);
  const close = () => { dismiss(); setOpened(false); };
  const op = state.journal?.operation, review = state.review, busy = !state.loaded || state.busy;
  const canAct = !busy && money.actionsEnabled, originalSelected = !!op && op.intent.baseId === baseId;
  const history = state.journal?.archives ?? [], hasSaved = !!op || history.length > 0 || !!state.error;
  const visible = ['base', 'build', 'bases', 'inventory'].includes(screen);
  useEffect(() => { setOpened(false); }, [wallet, screen, selected, category]);
  useEffect(() => {
    if (!opened) return;
    focus.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); setOpened(false); } };
    window.addEventListener('keydown', escape, true); return () => window.removeEventListener('keydown', escape, true);
  }, [opened, review, dismiss]);
  return <HeroProgressionContext.Provider value={{ ...money,
    begin: input => { setOpened(true); run(c => c.begin(input)); }, openHistory: () => { setOpened(true); money.refresh(); } }}>
    {children}
    {visible && hasSaved && !opened && <Btn variant="sec" fontSize={16} style={{ minHeight: 44, position: 'absolute', left: 12, top: 'calc(var(--safe-top, 0px) + 104px)', zIndex: 1200, maxWidth: 'calc(100% - 24px)' }}
      onClick={() => { setOpened(true); money.refresh(); }}>HERO PAYMENTS & RECEIPTS</Btn>}
    {visible && opened && createPortal(<ModalWrap onBackdrop={close}><Phead title={review ? 'REVIEW HERO PAYMENT' : 'HERO PAYMENTS'} onClose={close} />
      <div ref={focus} tabIndex={-1} role={review ? 'alertdialog' : 'dialog'} aria-modal="true" aria-label={review ? 'Confirm Hero payment' : 'Hero payment recovery'}
        style={{ padding: 14, display: 'grid', gap: 12, overflowWrap: 'anywhere', minWidth: 0 }}>
        {!money.actionsEnabled && <p role="status">New Hero payments are paused. Your original receipts remain available.</p>}
        {busy && <p role="status">Checking the original Hero request…</p>}
        {(state.error || money.refreshError) && <p role="alert" style={{ color: C.danger }}>{state.error ?? money.refreshError}</p>}
        {review ? <>
          <strong style={{ color: C.goldHi }}>{review.kind === 'upgrade' ? `UPGRADE ${review.hero.toUpperCase()} TO LEVEL ${review.expectedLevel + 1}` : `RECOVER ${review.hero.toUpperCase()}`}</strong>
          <div role="group" aria-label={`Up to ${amount(review.maxCostKeep)} ${review.expectedCurrency}`} style={{ padding: 12, border: `2px solid ${C.gold}`, textAlign: 'center', display: 'grid', gap: 8 }}>
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}><Icon name={review.expectedCurrency === 'GEMS' ? 'gem' : 'keep'} size={32} /> {review.expectedCurrency}</span>
            <strong style={{ fontSize: 24 }}>UP TO {amount(review.maxCostKeep)}</strong>
          </div>
          <p>Original kingdom: {review.baseId}</p>
          <p>This payment can use only {review.expectedCurrency}. It cannot switch to another balance.</p>
          {review.kind === 'recovery' && <p>Recovers only the injury ending {review.recoveryUntil}. The final price may decrease as its timer runs.</p>}
          <Btn style={control} disabled={!canAct || !originalSelected} onClick={() => run(c => c.confirm())}>CONFIRM {review.expectedCurrency}</Btn>
          <Btn style={control} variant="sec" onClick={close}>CANCEL REVIEW</Btn>
        </> : <>
          {op && <section aria-label="Saved Hero command">
            <strong>{op.proof ? 'ORIGINAL PAYMENT CONFIRMED' : op.refusal ? 'ORIGINAL PAYMENT DECLINED' : op.attempted ? 'ORIGINAL PAYMENT OUTCOME PENDING' : 'ORIGINAL UNSENT DRAFT'}</strong>
            <p>{op.proof ? 'This is historical payment evidence. Current Hero level, recovery and balances come from a fresh server view.'
              : op.refusal ? 'The first request was declined before spending. Archive its original record before reviewing another.'
                : op.attempted ? 'Keep this original request. A missing reply does not prove that nothing was spent.' : 'No payment has been attempted. Closing this panel keeps the original draft.'}</p>
            <OriginalDetails op={op} />
            {!op.proof && !op.refusal && <Btn style={control} disabled={!canAct || !originalSelected} onClick={() => run(c => c.reviewCommand())}>{op.attempted ? 'REVIEW SAME-KEY RETRY' : 'REVIEW ORIGINAL REQUEST'}</Btn>}
            <Btn style={control} variant="sec" disabled={busy} onClick={() => run(c => c.open())}>CHECK ORIGINAL RECEIPT</Btn>
            {!op.attempted && !op.proof && !op.refusal && <Btn style={control} variant="sec" disabled={busy} onClick={() => run(c => c.abandon())}>ARCHIVE UNUSED DRAFT</Btn>}
            {(op.proof || op.refusal) && <Btn style={control} variant="sec" disabled={busy} onClick={() => run(c => c.finish())}>{op.proof ? 'ARCHIVE CONFIRMED RECEIPT' : 'ARCHIVE DECLINED REQUEST'}</Btn>}
          </section>}
          {history.length > 0 && <details><summary className="interactive" style={{ minHeight: 44, paddingTop: 12 }}>HERO PAYMENT HISTORY ({history.length})</summary>
            {history.map(a => <section key={a.operation.intent.idempotencyKey}><p>{a.reason === 'accepted' ? 'Confirmed historical payment' : a.reason === 'refused' ? 'Declined original request' : 'Unused draft archived before any attempt'}</p><OriginalDetails op={a.operation} /></section>)}
          </details>}
          {!op && !history.length && !busy && <p>No saved Hero payment. Choose a Hero to review its current server price.</p>}
          <Btn style={control} variant="sec" onClick={close}>CLOSE</Btn>
        </>}
      </div>
    </ModalWrap>, document.body)}
  </HeroProgressionContext.Provider>;
}
