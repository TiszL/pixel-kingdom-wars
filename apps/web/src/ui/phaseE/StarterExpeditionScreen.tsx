import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../state/store';
import type { StarterExpeditionOperation } from '../../lib/starterExpedition/journal';
import { isPaidStarterCommand } from '../../lib/paidStarterExpeditions/command';
import { useStarterExpedition } from '../../lib/starterExpedition/useStarterExpedition';
import { Btn, COLORS as C } from '../primitives';
import { EconomyPanel } from './EconomyPanel';
import { ExpeditionRouteSummary as Route, ExpeditionStock } from './ExpeditionSummary';
const control = { minHeight: 44, width: '100%' };
const label = (value: string) => value.replaceAll('_', ' ').replaceAll('-', ' ');
function Details({ operation }: { operation: StarterExpeditionOperation }): React.JSX.Element {
  const { command, proof } = operation;
  return <details><summary className="interactive" style={{ minHeight: 44, paddingTop: 12 }}>ORIGINAL EXPEDITION DETAILS</summary>
    <p>Producing kingdom: {command.request.baseId}</p><p>Vehicle: {command.installation.installationId}</p><p>Request: {command.request.idempotencyKey}</p>
    <Route route={command.route} />
    {operation.refusal && <p>Original refusal: {label(operation.refusal.code.toLowerCase())}.</p>}
    {proof?.status === 'accepted' && <><p>Departed: {proof.receipt.departedAt} · Due: {proof.receipt.returnsAt} (UTC).</p>
      <p>{proof.return ? `Automatic return observed: ${proof.return.returnedAt} (UTC).` : 'Automatic return has not yet been observed. Check the original receipt for its return.'}</p></>}
  </details>;
}
export function StarterExpeditionScreen({ actionsEnabled = true, historyOnly = false }: { actionsEnabled?: boolean; historyOnly?: boolean }): React.JSX.Element {
  const baseId = useApp(s => s.selectedBaseId);
  const { state, snapshot, refreshError, run, refresh, dismiss, finish, actionsAllowed } = useStarterExpedition(actionsEnabled && !historyOnly);
  const [routeId, setRouteId] = useState(''), reviewNode = useRef<HTMLElement>(null), savedNode = useRef<HTMLElement>(null);
  const view = snapshot?.view, op = state.journal?.operation, review = state.review, accepted = op?.proof?.status === 'accepted';
  const busy = !state.loaded || state.busy, canAct = !busy && actionsAllowed, originalSelected = !!op && op.command.request.baseId === baseId;
  const paidHeld = !!op && isPaidStarterCommand(op.command.route) && op.attemptRevision !== null && !accepted && !op.refusal;
  const selectedRoute = view?.routes.find(route => route.routeId === routeId);
  const close = () => { dismiss(); useApp.getState().setScreen('base'); };
  useEffect(() => { const node = review ? reviewNode.current : accepted || op?.refusal ? savedNode.current : null; node?.focus(); node?.scrollIntoView?.({ block: 'nearest' }); }, [review, accepted, op?.refusal]);
  return <EconomyPanel title="Starter expeditions" eyebrow="HOME & COMMON ROUTES" onClose={close} error={state.error ?? refreshError}>
      <p>Send your installed starter from a completed Lodge. The vehicle returns automatically and delivers its net resources to the producing kingdom.</p>
      {!actionsAllowed && <p role="status">Game orders are paused. Original receipts remain available.</p>}
      {!state.loaded && <p role="status">Loading saved departures…</p>}
      {!view && state.loaded && <p>Current kingdom stock and fleet are unavailable. Saved receipts are historical proof and do not show spendable stock.</p>}
      {view && <section aria-label="Current selected kingdom expeditions">
        <div className="sk-economy-hero"><div><span>SELECTED KINGDOM · STARTER</span><strong>{view.flight ? 'On expedition' : !view.installation ? 'Install a starter' : !view.lodgeCompletedAt ? 'Build a Lodge' : 'Starter at home'}</strong><span>{view.flight ? 'Automatic return to its producing kingdom' : 'Choose a destination to review its cargo'}</span></div></div>
        <ExpeditionStock view={view} />
        {view.home ? <p>{view.home.source === 'free_policy_preview' ? 'Home preview' : 'Current home'}: {label(view.home.realmId)}.</p> : <p>Home authority is unavailable. New departures cannot begin.</p>}
        {!view.installation && <p>Install a starter at a completed berth before departing.</p>}
        {!view.lodgeCompletedAt && <p>A completed Lodge is required in this kingdom.</p>}
        {!view.acceptingDepartures && <p>New departures are unavailable. Accepted trips and saved receipts remain recoverable.</p>}
        {view.flight && <section aria-label="Current flight" className="sk-equipment-card"><h3>Current expedition</h3><Route route={view.flight.route} /><p>Departed: {view.flight.departedAt} · Due: {view.flight.returnsAt} (UTC).</p>
          <p>The vehicle is away. Refresh for the server's return observation.</p></section>}
        {!historyOnly && snapshot!.enabled && !op && <section aria-label="New starter departure" className="sk-equipment-card"><h3>Choose your route</h3>
          <label>Route<select className="interactive" aria-label="Expedition route" value={routeId} onChange={event => setRouteId(event.target.value)} disabled={!canAct}
            style={{ ...control, boxSizing: 'border-box', margin: '8px 0', padding: 10, font: 'inherit', color: C.text, background: C.surface, border: `2px solid ${C.border}` }}>
            <option value="">Choose route</option>{view.routes.map(route => <option key={route.routeId} value={route.routeId}>{label(route.routeId)} · {label(route.resourceId)}</option>)}
          </select></label>
          {selectedRoute && <Route route={selectedRoute} />}
          <Btn style={control} disabled={!canAct || !selectedRoute} onClick={() => { if (selectedRoute) run(controller => controller.beginDeparture(view.baseId, selectedRoute.routeId)); }}>REVIEW DEPARTURE</Btn>
        </section>}
      </section>}
      {op && <section ref={savedNode} tabIndex={-1} aria-label="Saved expedition request" className="sk-equipment-card">
        <strong>{accepted ? 'ORIGINAL DEPARTURE ACCEPTED' : op.refusal ? 'ORIGINAL REQUEST DECLINED' : op.attemptRevision !== null ? 'ORIGINAL OUTCOME UNKNOWN' : 'SAVED UNSENT DRAFT'}</strong>
        <p>{accepted ? 'Historical proof only. Current resources come from the selected kingdom snapshot above.' : op.attemptRevision !== null && !op.refusal
          ? paidHeld ? 'This paid trip may have departed. Check its original receipt; the saved request will not be sent again.' : 'This trip may have departed. Check its original receipt before explicitly reviewing the same request again.' : 'The exact route, vehicle and kingdom remain saved.'}</p>
        {!originalSelected && <p>Select the original kingdom to review a new attempt. Receipt checks and history remain available here.</p>}
        {review && !accepted && !op.refusal && !paidHeld && <section ref={reviewNode} tabIndex={-1} aria-label="Confirm starter departure" className="sk-equipment-card" style={{ borderColor: C.gold, margin: '12px 0' }}><h3>Confirm this expedition</h3>
          <Route route={review.command.route} /><details><summary>Confirm kingdom and vehicle</summary><p>Producing kingdom: {review.command.request.baseId}</p><p>Vehicle: {review.command.installation.installationId}</p></details>
          <p>The vehicle is unavailable until its automatic return. This departure cannot be cancelled. Resources arrive in its producing kingdom, including after transfer. No SOL, KEEP, Gems or SHARDS payment.</p>
          {op.attemptRevision !== null && <p>This explicitly resends the same original request after checking its receipt.</p>}
          <Btn style={control} disabled={!canAct || !originalSelected} onClick={() => run(controller => controller.confirm())}>CONFIRM DEPARTURE</Btn>
          <Btn style={{ ...control, marginTop: 8 }} variant="sec" onClick={dismiss}>CANCEL REVIEW</Btn>
        </section>}
        <div className="sk-economy-actions">
          {!accepted && !op.refusal && !review && !paidHeld && <Btn style={control} disabled={!canAct || !originalSelected} onClick={() => run(controller => controller.reviewCommand())}>REVIEW ORIGINAL REQUEST</Btn>}
          <Btn style={control} variant="sec" disabled={busy} onClick={() => run(controller => controller.open())}>CHECK ORIGINAL RECEIPT</Btn>
          {op.attemptRevision === null && !accepted && <Btn style={control} variant="sec" disabled={busy} onClick={() => run(controller => controller.abandonDraft())}>ARCHIVE UNUSED DRAFT</Btn>}
          {accepted && <Btn style={control} variant="sec" disabled={busy} onClick={finish}>ARCHIVE ACCEPTED DEPARTURE</Btn>}
          {op.refusal && !accepted && <Btn style={control} variant="sec" disabled={busy} onClick={() => run(controller => controller.archiveRefusal())}>ARCHIVE DECLINED REQUEST</Btn>}
        </div>
        <Details operation={op} />
      </section>}
      {!!state.journal?.archives.length && <details><summary className="interactive" style={{ minHeight: 44, paddingTop: 12 }}>EXPEDITION HISTORY ({state.journal.archives.length})</summary>
        {state.journal.archives.map(archive => <section key={archive.operation.command.request.idempotencyKey}>
          <p>{archive.reason === 'accepted' ? 'Historical accepted departure' : archive.reason === 'refused' ? 'Declined request' : 'Unused draft'}</p><Details operation={archive.operation} />
          {archive.reason !== 'accepted' && archive.operation.proof && <p>Original acceptance recovered after archival. Earlier refusal or absence evidence remains saved.</p>}
          <Btn style={control} variant="sec" disabled={busy} onClick={() => run(controller => controller.checkArchived(archive.operation.command.request.idempotencyKey))}>{archive.operation.proof ? 'CHECK AUTOMATIC RETURN' : 'CHECK ARCHIVED RECEIPT'}</Btn>
        </section>)}
      </details>}
      <Btn style={control} variant="sec" disabled={busy} onClick={refresh}>REFRESH EXPEDITIONS & RECEIPTS</Btn>
      <Btn style={control} variant="sec" onClick={close}>BACK TO KINGDOM</Btn>
  </EconomyPanel>;
}
