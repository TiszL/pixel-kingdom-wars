import { useEffect, useRef } from 'react';
import type { FreeBasePurchaseAdmissionReason, FreeBasePurchaseReceipt, FreeBasePurchaseTerms } from '@shardkeep/shared/freeBasePurchaseApi';
import type { FreeBasePurchaseOperation } from '../../lib/freeBasePurchase/journal';
import { useApp } from '../../state/store';
import { useFreeBasePurchase } from '../../lib/freeBasePurchase/useFreeBasePurchase';
import { Btn } from '../primitives';
import { EconomyPanel } from './EconomyPanel';
const control = { minHeight: 44, width: '100%' };
const whole = (value: string | number) => BigInt(value).toLocaleString('en-US');
const admissionCopy: Record<FreeBasePurchaseAdmissionReason, string> = {
  ready: 'The server reports this source kingdom is eligible. Review the exact cost before confirming.',
  disabled: 'New kingdom purchases are paused. Original receipts remain available.',
  'stable-bases-required': 'Kingdom ownership must be available before a new purchase can begin.',
  'already-purchased': 'This account has already purchased its second free kingdom. Its original receipt remains available.',
  'source-required': 'Select an active free kingdom to supply the SHARDS.',
  'source-unavailable': 'The selected source kingdom is unavailable. Choose an active kingdom you own.',
  'source-not-free': 'The source must be a free kingdom. Select an eligible free kingdom.',
  'source-reserved': 'The selected source kingdom is reserved. Resolve its current reservation before purchasing.',
  'full-roster': 'No active kingdom slot is vacant. This purchase cannot replace an occupied slot.',
  'development-required': 'Complete the required Keep, Workshop and Gold Forge levels in the source kingdom.',
  'insufficient-shards': 'The source kingdom does not have enough available SHARDS for this purchase.',
  'being-raided': 'The source kingdom is being raided. Check availability again after the raid.',
};
function Requirements({ terms }: { terms: FreeBasePurchaseTerms }): React.JSX.Element {
  return <><h3>Required completed buildings</h3><dl className="sk-economy-values" aria-label="Purchase requirements">
    <div><dt>Keep</dt><dd>Level {whole(terms.minKeepLevel)}</dd></div>
    <div><dt>Workshop</dt><dd>Level {whole(terms.minWorkshopLevel)}</dd></div>
    <div><dt>Gold Forge</dt><dd>Level {whole(terms.minGoldForgeLevel)}</dd></div>
  </dl><p>A vacant active slot is required. Account limits: {whole(terms.maxFreeBases)} free kingdoms and {whole(terms.maxActiveBases)} active kingdoms.</p></>;
}
function Receipt({ receipt }: { receipt: FreeBasePurchaseReceipt }): React.JSX.Element {
  return <><h3>Second kingdom created</h3><dl className="sk-economy-values" aria-label="Original purchase result">
    <div><dt>SHARDS charged</dt><dd>{whole(receipt.shardsCharged)}</dd></div>
    <div><dt>Original active slot</dt><dd>{whole(receipt.slot)}</dd></div>
  </dl><p>This historical receipt does not establish current ownership or balances.</p>
    <details><summary>Created kingdom and payment details</summary><p>New kingdom: {receipt.baseId}</p><p>Source kingdom: {receipt.sourceBaseId}</p>
      <p>Receipt: {receipt.debitTransactionId}</p><p>Accepted: {receipt.acceptedAt} (UTC).</p></details></>;
}
function Details({ operation }: { operation: FreeBasePurchaseOperation }): React.JSX.Element {
  return <details><summary>Original purchase details</summary><p>Source kingdom: {operation.command.request.sourceBaseId}</p>
    <p>Original key: {operation.command.request.idempotencyKey}</p><p>Saved cost: {whole(operation.command.terms.costShards)} SHARDS · Policy {operation.command.terms.policyVersion}.</p>
    {operation.refusal && <p>Original refusal: {operation.refusal.code.toLowerCase().replaceAll('_', ' ')}.</p>}</details>;
}
export function FreeBasePurchaseScreen({ actionsEnabled = true }: { actionsEnabled?: boolean }): React.JSX.Element {
  const baseId = useApp(s => s.selectedBaseId);
  const { state, snapshot, refreshError, actionsAllowed, run, refresh, dismiss } = useFreeBasePurchase(actionsEnabled);
  const op = state.journal?.operation, review = state.review, accepted = op?.proof?.status === 'accepted' ? op.proof.receipt : null;
  const originalSelected = op?.command.request.sourceBaseId === baseId, acceptedKey = accepted?.idempotencyKey;
  const reviewNode = useRef<HTMLElement>(null), savedNode = useRef<HTMLElement>(null);
  const close = () => { dismiss(); useApp.getState().setScreen('bases'); };
  useEffect(() => { const node = review ? reviewNode.current : acceptedKey || op?.refusal ? savedNode.current : null; node?.focus(); node?.scrollIntoView?.({ block: 'nearest' }); }, [review, acceptedKey, op?.refusal]);
  return <EconomyPanel title="Second kingdom" eyebrow="EXPAND WITH SHARDS" onClose={close} error={state.error ?? refreshError}>
    <p>Purchase another free kingdom using SHARDS from the selected source kingdom. The new kingdom uses a vacant active slot.</p>
    {!actionsAllowed && <p role="status">Game orders are paused. Original purchase receipts remain available.</p>}
    {!state.loaded && <p role="status">Loading saved purchases and current availability…</p>}
    {!snapshot && state.loaded && <p>Current purchase availability is unavailable. Refresh to check eligibility; saved purchases remain recoverable below.</p>}
    {snapshot && <section aria-label="Current purchase availability">
      <div className="sk-economy-hero"><div><span>SECOND FREE KINGDOM · CURRENT PRICE</span><strong>{whole(snapshot.view.terms.costShards)} SHARDS</strong><span>Paid from the selected source kingdom</span></div></div>
      <dl className="sk-economy-values" aria-label="Selected source funds"><div><dt>Available SHARDS</dt><dd>{snapshot.balances ? whole(snapshot.balances.shards) : 'Unavailable'}</dd></div></dl>
      <p role="status">{!snapshot.enabled && snapshot.view.admission.allowed ? 'Current source kingdom authority is unavailable. Refresh before starting a purchase.' : admissionCopy[snapshot.view.admission.reason]}</p>
      <details><summary>Source kingdom and policy details</summary><p>Source kingdom: {snapshot.view.sourceBaseId ?? 'None selected'}</p><p>Policy version {snapshot.view.terms.policyVersion}.</p></details>
      <section className="sk-equipment-card">
        {!op && <Btn style={control} disabled={state.busy || !actionsAllowed || !snapshot.enabled || !baseId} onClick={() => baseId && run(c => c.beginPurchase(baseId))}>REVIEW SECOND KINGDOM</Btn>}
        <Requirements terms={snapshot.view.terms} />
      </section>
    </section>}
    {!op && snapshot?.view.receipt && <section aria-label="Historical purchase receipt" className="sk-equipment-card"><strong>PURCHASE ACCEPTED</strong><Receipt receipt={snapshot.view.receipt} /></section>}
    {op && <section ref={savedNode} tabIndex={-1} aria-label="Saved purchase" className="sk-equipment-card">
      <strong>{accepted ? 'PURCHASE ACCEPTED' : op.refusal ? 'ORIGINAL REQUEST DECLINED' : op.attemptRevision !== null ? 'ORIGINAL OUTCOME UNKNOWN' : 'SAVED PURCHASE DRAFT'}</strong>
      {accepted ? <Receipt receipt={accepted} /> : <><h3>{whole(op.command.terms.costShards)} SHARDS · saved purchase</h3>
        <p>{op.refusal ? 'The original request was declined. Check its receipt before archiving.' : op.attemptRevision !== null ? 'This purchase may have been accepted. Check its original receipt before explicitly reviewing the same request again.' : 'The exact source kingdom and purchase terms remain saved. Opening this review does not charge SHARDS.'}</p></>}
      {!originalSelected && <p>Select the original source kingdom to review a new attempt. Original receipt checks remain available here.</p>}
      {review && !accepted && <section ref={reviewNode} tabIndex={-1} aria-label="Confirm purchase" className="sk-equipment-review sk-equipment-card">
        <h3>Confirm the original purchase</h3><div className="sk-economy-hero"><div><span>SHARDS CHARGED ON ACCEPTANCE</span><strong>{whole(review.command.terms.costShards)}</strong><span>From the original source kingdom</span></div></div>
        <details><summary>Confirm source kingdom and terms</summary><p>Source kingdom: {review.command.request.sourceBaseId}</p><Requirements terms={review.command.terms} /><p>Policy version {review.command.terms.policyVersion}.</p></details>
        <p>Create another free kingdom in a vacant active slot. This does not replace a roster slot or establish mining eligibility.</p>
        {op.attemptRevision !== null && <p>This explicitly retries the same original request.</p>}
        <Btn style={control} disabled={state.busy || !actionsAllowed || !originalSelected} onClick={() => run(c => c.confirm())}>CONFIRM PURCHASE</Btn>
        <Btn style={{ ...control, marginTop: 8 }} variant="sec" onClick={dismiss}>CANCEL REVIEW</Btn>
      </section>}
      <div className="sk-economy-actions">
        {!accepted && !op.refusal && !review && <Btn style={control} disabled={state.busy || !actionsAllowed || !originalSelected} onClick={() => run(c => c.reviewCommand())}>REVIEW ORIGINAL REQUEST</Btn>}
        <Btn style={control} variant="sec" disabled={state.busy} onClick={() => run(c => c.open())}>CHECK ORIGINAL RECEIPT</Btn>
        {!accepted && op.attemptRevision === null && <Btn style={control} variant="sec" disabled={state.busy} onClick={() => run(c => c.abandonDraft())}>ARCHIVE UNUSED DRAFT</Btn>}
        {op.refusal && !accepted && <Btn style={control} variant="sec" disabled={state.busy} onClick={() => run(c => c.archiveRefusal())}>ARCHIVE DECLINED REQUEST</Btn>}
      </div><Details operation={op} />
    </section>}
    {!!state.journal?.archives.length && <details><summary>Purchase history ({state.journal.archives.length})</summary>{state.journal.archives.map(archive => <section className="sk-equipment-card" key={archive.operation.command.request.idempotencyKey}>
      <h3>{archive.operation.proof ? 'Accepted purchase' : archive.reason === 'refused' ? 'Declined request' : 'Unused draft'}</h3>
      {archive.operation.proof?.status === 'accepted' && <Receipt receipt={archive.operation.proof.receipt} />}<Details operation={archive.operation} />
      {archive.reason !== 'accepted' && archive.operation.proof && <p>Acceptance recovered after archival. The original archive reason remains saved.</p>}
      <Btn style={control} variant="sec" disabled={state.busy} onClick={() => run(c => c.checkArchived(archive.operation.command.request.idempotencyKey))}>CHECK ARCHIVED RECEIPT</Btn>
    </section>)}</details>}
    <Btn style={control} variant="sec" disabled={state.busy} onClick={refresh}>REFRESH PURCHASE & RECEIPTS</Btn>
    <Btn style={control} variant="sec" onClick={close}>BACK TO KINGDOMS</Btn>
  </EconomyPanel>;
}
