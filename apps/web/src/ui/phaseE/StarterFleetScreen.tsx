import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../state/store';
import type { StarterFleetOperation } from '../../lib/starterFleet/journal';
import { useStarterFleet } from '../../lib/starterFleet/useStarterFleet';
import { Btn, COLORS as C } from '../primitives';
import { EconomyPanel } from './EconomyPanel';
const control = { minHeight: 44, width: '100%' };
function Details({ operation }: { operation: StarterFleetOperation }): React.JSX.Element {
  const { command, proof } = operation;
  return <details><summary className="interactive" style={{ minHeight: 44, paddingTop: 12 }}>ORIGINAL STARTER DETAILS</summary>
    <p>Kingdom: {command.request.baseId}</p><p>Berth: {command.request.berthId}</p><p>Request: {command.request.idempotencyKey}</p>
    <p>Completed berth: {command.berth.berthCompletedAt} (UTC).</p>
    {operation.refusal && <p>Original refusal: {operation.refusal.code.toLowerCase().replaceAll('_', ' ')}.</p>}
    {proof?.status === 'accepted' && <><p>Installation: {proof.receipt.installation.installationId}</p>
      <p>Installed: {proof.receipt.installation.installedAt} · Accepted: {proof.receipt.acceptedAt} (UTC).</p></>}
  </details>;
}
export function StarterFleetScreen({ actionsEnabled = true, historyOnly = false }: { actionsEnabled?: boolean; historyOnly?: boolean }): React.JSX.Element {
  const baseId = useApp(s => s.selectedBaseId);
  const { state, snapshot, refreshError, run, refresh, dismiss, finish, actionsAllowed } = useStarterFleet(actionsEnabled && !historyOnly);
  const [berthId, setBerthId] = useState(''), reviewNode = useRef<HTMLElement>(null), savedNode = useRef<HTMLElement>(null);
  const view = snapshot?.view, op = state.journal?.operation, review = state.review, accepted = op?.proof?.status === 'accepted';
  const busy = !state.loaded || state.busy, canAct = !busy && actionsAllowed, originalSelected = !!op && op.command.request.baseId === baseId;
  const close = () => { dismiss(); useApp.getState().setScreen('base'); };
  useEffect(() => { const node=review?reviewNode.current:accepted||op?.refusal?savedNode.current:null;node?.focus();node?.scrollIntoView?.({block:'nearest'}); }, [review,accepted,op?.refusal]);
  return <EconomyPanel title="Starter vehicle" eyebrow="YOUR FIRST EXPEDITION VEHICLE" onClose={close} error={state.error??refreshError}>
      <p>Install the free starter vehicle at a completed berth. It remains bound to that berth and kingdom. Installation does not start an expedition.</p>
      {!actionsAllowed && <p role="status">Game orders are paused. Original receipts remain available.</p>}
      {!state.loaded && <p role="status">Loading saved starter requests…</p>}
      {!view && state.loaded && <p>Current kingdom fleet is unavailable. Saved receipts are historical proof and do not establish current ownership.</p>}
      {view && <section aria-label="Current selected kingdom fleet">
        <div className="sk-economy-hero"><div><span>SELECTED KINGDOM · STARTER</span><strong>{view.installation ? 'Installed' : view.eligibleBerths.length ? 'Berth ready' : 'Build a berth'}</strong><span>One permanent vehicle for this kingdom</span></div></div>
        <details><summary>Fleet snapshot details</summary><p>Kingdom: {view.baseId} · Observed {view.serverNow} (UTC).</p></details>
        {view.installation ? <><p>Starter installed at its original berth.</p><details><summary>Installed vehicle details</summary><p>Berth: {view.installation.berthId}</p><p>Installation: {view.installation.installationId}</p></details></> : <p>No starter is installed in this kingdom.</p>}
        {!view.acceptingInstallations && <p>New starter confirmations are paused. Saved receipts remain available.</p>}
        {!view.eligibleBerths.length && <p>No eligible completed berth is available. Complete its construction before installing a starter.</p>}
        {!historyOnly && snapshot!.enabled && !op && <section aria-label="New starter installation" className="sk-equipment-card"><h3>{view.installation ? 'Confirm your starter' : 'Choose its permanent berth'}</h3>
          <label>Completed berth<select className="interactive" aria-label="Starter berth" value={berthId} onChange={event => setBerthId(event.target.value)} disabled={!canAct}
            style={{ ...control, boxSizing: 'border-box', margin: '8px 0', padding: 10, font: 'inherit', color: C.text, background: C.surface, border: `2px solid ${C.borderLt}` }}>
            <option value="">Choose completed berth</option>{view.eligibleBerths.map((berth, index) => <option key={berth.berthId} value={berth.berthId}>Berth {index + 1} · completed</option>)}
          </select></label>
          {view.installation && <p>Confirm the existing starter at its original berth. This does not create a second vehicle or move it.</p>}
          <Btn style={control} disabled={!canAct || !view.eligibleBerths.some(berth => berth.berthId === berthId)}
            onClick={() => run(controller => controller.beginInstall(view.baseId, berthId))}>REVIEW STARTER INSTALLATION</Btn>
        </section>}
      </section>}
      {op && <section aria-label="Saved starter request" ref={savedNode} tabIndex={-1} className="sk-equipment-card">
        <strong>{accepted ? 'ORIGINAL STARTER ACCEPTED' : op.refusal ? 'ORIGINAL REQUEST DECLINED' : op.attemptRevision !== null ? 'ORIGINAL OUTCOME UNKNOWN' : 'SAVED UNSENT DRAFT'}</strong>
        <p>{accepted ? 'Historical proof only. Current fleet and ownership come from the selected kingdom snapshot above.' : op.attemptRevision !== null && !op.refusal
          ? 'This installation may have been accepted. Check its original receipt before explicitly reviewing the same request again.' : 'The exact kingdom and completed berth remain saved.'}</p>
        {!originalSelected && <p>Select the original kingdom to review a new attempt. Receipt checks and history remain available here.</p>}
        {review && !accepted && !op.refusal && <section ref={reviewNode} tabIndex={-1} aria-label="Confirm starter installation" className="sk-equipment-review sk-equipment-card">
          <h3>Confirm permanent installation</h3><details><summary>Confirm kingdom and berth</summary><p>Kingdom: {review.command.request.baseId}</p><p>Berth: {review.command.berth.berthId}</p><p>Completed: {review.command.berth.berthCompletedAt} (UTC).</p></details>
          <p>{review.command.installation ? 'Accept the existing starter at this berth. No additional vehicle is created.' : 'Permanently bind the free starter to this completed berth.'}</p>
          <p>It cannot be moved to another berth. No SOL, KEEP, Gems or SHARDS payment.</p>
          {op.attemptRevision !== null && <p>This explicitly resends the same original request after checking its receipt.</p>}
          <Btn style={control} disabled={!canAct || !originalSelected} onClick={() => run(controller => controller.confirm())}>CONFIRM STARTER INSTALLATION</Btn>
          <Btn style={{ ...control, marginTop: 8 }} variant="sec" onClick={dismiss}>CANCEL REVIEW</Btn>
        </section>}
        <div className="sk-economy-actions">
          {!accepted && !op.refusal && !review && <Btn style={control} disabled={!canAct || !originalSelected} onClick={() => run(controller => controller.reviewCommand())}>REVIEW ORIGINAL REQUEST</Btn>}
          <Btn style={control} variant="sec" disabled={busy} onClick={() => run(controller => controller.open())}>CHECK ORIGINAL RECEIPT</Btn>
          {op.attemptRevision === null && !accepted && <Btn style={control} variant="sec" disabled={busy} onClick={() => run(controller => controller.abandonDraft())}>ARCHIVE UNUSED DRAFT</Btn>}
          {accepted && <Btn style={control} variant="sec" disabled={busy} onClick={finish}>ARCHIVE ACCEPTED STARTER</Btn>}
          {op.refusal && !accepted && <Btn style={control} variant="sec" disabled={busy} onClick={() => run(controller => controller.archiveRefusal())}>ARCHIVE DECLINED REQUEST</Btn>}
        </div>
        <Details operation={op} />
      </section>}
      {!!state.journal?.archives.length && <details><summary className="interactive" style={{ minHeight: 44, paddingTop: 12 }}>STARTER HISTORY ({state.journal.archives.length})</summary>
        {state.journal.archives.map(archive => <section key={archive.operation.command.request.idempotencyKey}>
          <p>{archive.reason === 'accepted' ? 'Historical accepted starter' : archive.reason === 'refused' ? 'Declined request' : 'Unused draft'}</p><Details operation={archive.operation} />
          {archive.reason !== 'accepted' && archive.operation.proof && <p>Original acceptance recovered after archival. Earlier refusal or absence evidence remains saved.</p>}
          <Btn style={control} variant="sec" disabled={busy} onClick={() => run(controller => controller.checkArchived(archive.operation.command.request.idempotencyKey))}>CHECK ARCHIVED RECEIPT</Btn>
        </section>)}
      </details>}
      <Btn style={control} variant="sec" disabled={busy} onClick={refresh}>REFRESH FLEET & RECEIPTS</Btn>
      <Btn style={control} variant="sec" onClick={close}>BACK TO KINGDOM</Btn>
  </EconomyPanel>;
}
