import { useEffect, useRef } from 'react';
import type { HarvesterPolicy, HarvesterSourceSummary } from '@shardkeep/shared/harvesterApi';
import type { HarvesterOperation } from '../../lib/harvester/journal';
import { useHarvester } from '../../lib/harvester/useHarvester';
import { useApp } from '../../state/store';
import { fmtDur } from '@shardkeep/shared';
import { REALM_NAMES } from '@shardkeep/shared/baseVisual';
import { PHASE_E_RAW_RESOURCES } from '@shardkeep/shared/phaseEResources';
import { Btn } from '../primitives';
import { EconomyPanel } from './EconomyPanel';
const control = { minHeight: 44, width: '100%' };
const label = (value: string) => value.replaceAll('_', ' ').replaceAll('-', ' ');
const whole = (value: string | number) => BigInt(value).toLocaleString('en-US');
function Policy({ policy }: { policy: HarvesterPolicy }): React.JSX.Element {
  return <><p>{whole(policy.producingSourcesPerWallet)} producing source per wallet · up to {whole(policy.grossPerCadence)} gross every {fmtDur(policy.cadenceSec)}.</p>
    <p>{whole(policy.grossPerWalletUtcDay)} gross limit per wallet per UTC day · {whole(policy.islandPoolBps)} of every {whole(policy.taxBasisPoints)} units go to the island pool, with rounding carried forward.</p>
    <p>Maximum unattended interval: {fmtDur(policy.maxLeaseSec)}. Only completed earning periods count.</p>
    <p>Policy version {policy.policyVersion} · Tax version {policy.taxPolicyVersion}</p></>;
}
function Source({ source }: { source: HarvesterSourceSummary }): React.JSX.Element {
  return <><strong>{PHASE_E_RAW_RESOURCES[source.resourceId].name} · {REALM_NAMES[source.realmId]}</strong>
    <p>Interval: {source.admittedAt} to {source.leaseExpiresAt} (UTC).</p>
    <details><summary>Producing kingdom and source details</summary><p>Producing kingdom: {source.baseId}</p>
      <p>Harvester: {source.harvesterId} · Source: {source.sourceId}</p></details></>;
}
function ObservedEarnings({ operation }: { operation: HarvesterOperation }): React.JSX.Element | null {
  if (operation.proof?.status !== 'accepted') return null;
  const { settlement, originalReceipt } = operation.proof, last = settlement.events.at(-1);
  return <section aria-label="Original earning result"><h3>{settlement.closure ? 'Source closed' : settlement.custodyStop ? 'Source stopped · settlement pending' : 'Source accepted · check earnings'}</h3>
    <p>{settlement.events.length} earning periods observed by the server.</p>
    {last ? <><dl className="sk-economy-values" aria-label="Last observed earning period">
      <div><dt>Gathered</dt><dd>{whole(last.grossQuantity)} {PHASE_E_RAW_RESOURCES[last.resourceId].name}</dd></div>
      <div><dt>Island pool</dt><dd>{whole(last.islandPoolQuantity)}</dd></div>
      <div><dt>Delivered to producing kingdom</dt><dd>{whole(last.netQuantity)}</dd></div>
    </dl><p>Last observed earning: {last.earnedAt} (UTC). These historical amounts do not show current spendable stock.</p></>
      : <p>No completed earning period has been observed yet. An accepted selection alone does not prove resources were delivered.</p>}
    <p>{settlement.closure ? 'The server recorded the end of this source. Earlier deliveries remain in its history.' : 'Check the original receipt for later earnings and server-confirmed closure. The interval ending on your clock does not confirm closure.'}</p>
    <details><summary>Original producing source</summary><Source source={originalReceipt.source} /></details>
  </section>;
}
function Details({ operation }: { operation: HarvesterOperation }): React.JSX.Element {
  const { command, proof } = operation;
  return <details><summary className="interactive" style={{ minHeight: 44, paddingTop: 12 }}>ORIGINAL HARVESTER DETAILS</summary>
    <p>Producing kingdom: {command.request.baseId}</p><p>Harvester: {command.request.harvesterId}</p><p>Request: {command.request.idempotencyKey}</p>
    <p>Home realm: {REALM_NAMES[command.realmId]}</p><Policy policy={command.policy} />
    {operation.refusal && <p>Original refusal: {label(operation.refusal.code.toLowerCase())}.</p>}
    {proof?.status === 'accepted' && <><Source source={proof.originalReceipt.source} />
      <p>{proof.settlement.events.length} original earning observations. Historical deliveries do not show current spendable stock.</p>
      {proof.settlement.events.map(event => <p key={event.ordinal}>{event.earnedAt}: {whole(event.grossQuantity)} gross · {whole(event.netQuantity)} delivered · {whole(event.islandPoolQuantity)} island pool.</p>)}
      {proof.settlement.custodyStop && <p>Authority cutoff recorded: {proof.settlement.custodyStop.cutoffAt} (UTC). Earlier earned periods may still await settlement.</p>}
      <p>{proof.settlement.closure ? `Source closed: ${label(proof.settlement.closure.reason)} · ${proof.settlement.closure.cutoffAt} (UTC).`
        : 'Closure has not yet been observed. Check the original receipt for later earning observations.'}</p></>}
  </details>;
}
export function HarvesterScreen({ actionsEnabled = true, historyOnly = false }: { actionsEnabled?: boolean; historyOnly?: boolean }): React.JSX.Element {
  const baseId = useApp(s => s.selectedBaseId);
  const { state, snapshot, refreshError, run, refresh, dismiss, finish, actionsAllowed } = useHarvester(actionsEnabled && !historyOnly);
  const reviewNode = useRef<HTMLElement>(null), savedNode = useRef<HTMLElement>(null), view = snapshot?.view, op = state.journal?.operation, review = state.review;
  const accepted = op?.proof?.status === 'accepted', busy = !state.loaded || state.busy, canAct = !busy && actionsAllowed;
  const originalSelected = !!op && op.command.request.baseId === baseId;
  const close = () => { dismiss(); useApp.getState().setScreen('base'); };
  useEffect(() => { const node = review ? reviewNode.current : accepted || op?.refusal ? savedNode.current : null; node?.focus(); node?.scrollIntoView?.({ block: 'nearest' }); }, [review, accepted, op?.refusal]);
  return <EconomyPanel title="Realm Harvester" eyebrow="AUTOMATIC RESOURCE EARNINGS" onClose={close} error={state.error ?? refreshError}>
      <p>Select a completed Harvester for a limited earning interval. Earned resources arrive automatically in its producing kingdom.</p>
      {!actionsAllowed && <p role="status">Game orders are paused. Original sources and earning history remain available.</p>}
      {!state.loaded && <p role="status">Loading saved selections…</p>}
      {!view && state.loaded && <p>Current kingdom stock and Harvesters are unavailable. Saved receipts are historical proof and do not show spendable stock.</p>}
      {view && <section aria-label="Current selected kingdom Harvesters">
        <div className="sk-economy-hero"><div><span>SELECTED KINGDOM · HARVESTER</span><strong>{view.facilities.length ? `${whole(view.facilities.length)} completed` : 'Build a Harvester'}</strong><span>{view.home ? REALM_NAMES[view.home.realmId] : 'Home authority unavailable'}</span></div></div>
        {view.home ? <p>{view.home.source === 'free_policy_preview' ? 'Home preview' : 'Current home'}: {REALM_NAMES[view.home.realmId]}.</p>
          : <p>Home authority is unavailable. New selections cannot begin.</p>}
        {!historyOnly && view.facilities.map((facility, index) => <section key={facility.harvesterId} aria-label="Completed Harvester" className="sk-equipment-card">
          <h3>Harvester {index + 1} · completed</h3><p>{view.walletSource?.harvesterId === facility.harvesterId ? 'Review a new interval for this facility. The original wallet limits still apply.' : 'Review this facility as your wallet’s producing source.'}</p>
          <details><summary>Facility details</summary><p>Harvester: {facility.harvesterId}</p><p>Completed: {facility.harvesterCompletedAt} (UTC).</p></details>
          <Btn style={control} disabled={!canAct || !snapshot!.enabled || !!op} onClick={() => run(controller => controller.beginSelection(view.baseId, facility.harvesterId))}>
            {view.walletSource?.harvesterId === facility.harvesterId ? 'REVIEW NEW INTERVAL' : 'REVIEW SELECTION'}</Btn>
        </section>)}
        <dl className="sk-economy-values" aria-label="Current Harvester policy">
          <div><dt>Gross per completed period</dt><dd>Up to {whole(view.policy.grossPerCadence)}</dd></div>
          <div><dt>Earning period</dt><dd>{fmtDur(view.policy.cadenceSec)}</dd></div>
          <div><dt>Wallet daily gross limit</dt><dd>{whole(view.policy.grossPerWalletUtcDay)}</dd></div>
          <div><dt>Maximum unattended interval</dt><dd>{fmtDur(view.policy.maxLeaseSec)}</dd></div>
        </dl>
        <p>Switching kingdoms or Harvesters does not reset wallet-wide limits or tax rounding. More facilities do not raise these limits. Remaining daily earnings are not guaranteed.</p>
        <details><summary>Current kingdom stock</summary><dl className="sk-economy-values" aria-label="Current Harvester stock">
          {view.rawStock.map(stock => <div key={stock.resourceId}><dt>{PHASE_E_RAW_RESOURCES[stock.resourceId].name}</dt><dd>{whole(stock.available)} available · {whole(stock.reserved)} reserved · {whole(stock.total)} total</dd></div>)}
        </dl><p>Kingdom: {view.baseId} · Observed {view.serverNow} (UTC).</p></details>
        <details><summary>Current earning policy and limits</summary><Policy policy={view.policy} /></details>
        {view.walletSource && <section aria-label="Current wallet source" className="sk-equipment-card"><h3>Wallet source recorded</h3><Source source={view.walletSource} />
          <p>This selection remains recorded until the server closes it, including after its interval ends. A new interval requires fresh confirmation.</p></section>}
        {!view.acceptingSelections && <p>New selections are unavailable. Original earning observations remain recoverable.</p>}
        {!view.facilities.length && <p>Complete a Harvester in this kingdom before selecting a source.</p>}
      </section>}
      {op && <section ref={savedNode} tabIndex={-1} aria-label="Saved Harvester request" className="sk-equipment-card">
        <strong>{accepted ? 'ORIGINAL SOURCE ACCEPTED' : op.refusal ? 'ORIGINAL REQUEST DECLINED' : op.attemptRevision !== null ? 'ORIGINAL OUTCOME UNKNOWN' : 'SAVED UNSENT DRAFT'}</strong>
        <p>{accepted ? 'Historical proof only. Archiving does not stop production. Current resources come from the selected kingdom snapshot above.'
          : op.attemptRevision !== null && !op.refusal ? 'This selection may have been accepted. Check its original receipt before explicitly reviewing the same request again.'
            : 'The exact facility, policy and wallet source replacement consent remain saved.'}</p>
        {!originalSelected && <p>Select the original kingdom to review a new attempt. Receipt checks and history remain available here.</p>}
        <ObservedEarnings operation={op} />
        {review && !accepted && !op.refusal && <section ref={reviewNode} tabIndex={-1} aria-label="Confirm Harvester selection" className="sk-equipment-review sk-equipment-card">
          <h3>Confirm the original earning interval</h3><p>Home realm: {REALM_NAMES[review.command.realmId]}</p>
          <Policy policy={review.command.policy} />
          <details><summary>Confirm producing kingdom and facility</summary><p>Producing kingdom: {review.command.request.baseId}</p><p>Harvester: {review.command.request.harvesterId}</p><p>Completed: {review.command.facility.harvesterCompletedAt} (UTC).</p></details>
          {review.command.replacedSource ? <section aria-label="Source being replaced"><p>This closes the previous source below and starts a new earning interval. Its unfinished earning period is discarded; already earned units remain owed to their producing kingdom.</p>
            <Source source={review.command.replacedSource} /></section> : <p>No existing wallet source will be replaced.</p>}
          <p>Earning may stop earlier when the operating term ends or kingdom authority changes. Future earnings are not guaranteed. No SOL, KEEP, Gems or SHARDS payment.</p>
          {op.attemptRevision !== null && <p>This explicitly resends the same original request after checking its receipt.</p>}
          <Btn style={control} disabled={!canAct || !originalSelected} onClick={() => run(controller => controller.confirm())}>CONFIRM SELECTION</Btn>
          <Btn style={{ ...control, marginTop: 8 }} variant="sec" onClick={dismiss}>CANCEL REVIEW</Btn>
        </section>}
        <div className="sk-economy-actions">
          {!accepted && !op.refusal && !review && <Btn style={control} disabled={!canAct || !originalSelected} onClick={() => run(controller => controller.reviewCommand())}>REVIEW ORIGINAL REQUEST</Btn>}
          <Btn style={control} variant="sec" disabled={busy} onClick={() => run(controller => controller.open())}>CHECK ORIGINAL RECEIPT</Btn>
          {op.attemptRevision === null && !accepted && <Btn style={control} variant="sec" disabled={busy} onClick={() => run(controller => controller.abandonDraft())}>ARCHIVE UNUSED DRAFT</Btn>}
          {accepted && <Btn style={control} variant="sec" disabled={busy} onClick={finish}>ARCHIVE ACCEPTED SOURCE</Btn>}
          {op.refusal && !accepted && <Btn style={control} variant="sec" disabled={busy} onClick={() => run(controller => controller.archiveRefusal())}>ARCHIVE DECLINED REQUEST</Btn>}
        </div><Details operation={op} />
      </section>}
      {!!state.journal?.archives.length && <details><summary className="interactive" style={{ minHeight: 44, paddingTop: 12 }}>EARNING HISTORY ({state.journal.archives.length})</summary>
        {state.journal.archives.map(archive => <section className="sk-equipment-card" key={archive.operation.command.request.idempotencyKey}>
          <p>{archive.reason === 'accepted' ? 'Historical accepted source' : archive.reason === 'refused' ? 'Declined request' : 'Unused draft'}</p><ObservedEarnings operation={archive.operation} /><Details operation={archive.operation} />
          {archive.reason !== 'accepted' && archive.operation.proof && <p>Original acceptance recovered after archival. Earlier refusal or absence evidence remains saved.</p>}
          <Btn style={control} variant="sec" disabled={busy} onClick={() => run(controller => controller.checkArchived(archive.operation.command.request.idempotencyKey))}>
            {archive.operation.proof ? 'CHECK EARNING OBSERVATIONS' : 'CHECK ARCHIVED RECEIPT'}</Btn>
        </section>)}
      </details>}
      <Btn style={control} variant="sec" disabled={busy} onClick={refresh}>REFRESH STOCK & RECEIPTS</Btn>
      <Btn style={control} variant="sec" onClick={close}>BACK TO KINGDOM</Btn>
  </EconomyPanel>;
}
