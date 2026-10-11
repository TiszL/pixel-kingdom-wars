import { useEffect, useRef, useState } from 'react';
import type { MiningContributionLine, MiningContributionResource } from '@shardkeep/shared/miningContribution';
import { PHASE_E_RAW_RESOURCE_IDS } from '@shardkeep/shared/phaseEResources';
import { useApp } from '../../state/store';
import { useMiningContribution } from '../../lib/miningContribution/useMiningContribution';
import { contributionTotal } from '../../lib/miningContribution/controller';
import type { MiningContributionOperation } from '../../lib/miningContribution/journal';
import { Btn, Icon } from '../primitives';
import { EconomyPanel } from './EconomyPanel';
import './mining-contribution.css';

const whole = (value: string | bigint | number) => BigInt(value).toLocaleString('en-US');
const label = (id: string) => id === 'shards' ? 'SHARDS' : id === 'forge_ingot' ? 'Gold Ingots'
  : id.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
const group = (id: MiningContributionResource) => id === 'shards' ? 'SHARDS'
  : (PHASE_E_RAW_RESOURCE_IDS as readonly string[]).includes(id) ? 'Raw materials' : 'Crafted materials';
const full = { width: '100%', minHeight: 48 };
function Basket({ lines }: { lines: readonly MiningContributionLine[] }) {
  return <ul className="sk-mining-basket">{lines.map(line => <li key={line.resourceId}><span>{label(line.resourceId)}</span><strong>{whole(line.quantity)}</strong></li>)}</ul>;
}
function Details({ operation }: { operation: MiningContributionOperation }) {
  const { request } = operation.command, proof = operation.proof;
  return <details className="sk-mining-details"><summary>Receipt details</summary><Basket lines={request.lines} />
    <p>Mining day: {request.expectedDay} (UTC)</p><p>Kingdom: {request.baseId}</p><p>Request: {request.idempotencyKey}</p>
    {proof?.status === 'accepted' && <><p>Contribution value: {whole(proof.receipt.totalValue)}</p>
      <p>{proof.settlement ? `${proof.settlement.outcome === 'consumed' ? 'Resources consumed' : 'Resources returned'} · ${proof.settlement.settledAt}` : 'Reserved · awaiting daily settlement'}</p></>}
  </details>;
}

export function MiningContributionScreen({ actionsEnabled = true, onClose }: { actionsEnabled?: boolean; onClose: () => void }) {
  const baseId = useApp(s => s.selectedBaseId);
  const { state, snapshot, refreshError, run, refresh, dismiss, finish, actionsAllowed } = useMiningContribution(actionsEnabled);
  const [quantities, setQuantities] = useState<Partial<Record<MiningContributionResource, string>>>({});
  const [search, setSearch] = useState(''), [filter, setFilter] = useState('All resources'), [consent, setConsent] = useState(false);
  const reviewNode = useRef<HTMLElement>(null), receiptNode = useRef<HTMLElement>(null);
  const view = snapshot?.view, operation = state.journal?.operation, review = state.review;
  const accepted = operation?.proof?.status === 'accepted', busy = !state.loaded || state.busy;
  const canAct = !busy && actionsAllowed, originalSelected = operation?.command.request.baseId === baseId;
  const lines: MiningContributionLine[] = (view?.resources ?? []).flatMap(row => {
    const quantity = quantities[row.resourceId];
    return quantity && /^[1-9][0-9]{0,18}$/.test(quantity) ? [{ resourceId: row.resourceId, quantity }] : [];
  });
  const total = view ? contributionTotal(view, lines) : 0n;
  const overStock = view && lines.some(line => BigInt(line.quantity) > BigInt(view.resources.find(row => row.resourceId === line.resourceId)!.available));
  const overCap = !!view && view.remainingValue !== null && total > BigInt(view.remainingValue);
  const qualifiedDayTerms = 'Your basket is reserved now and cannot be cancelled. If this basket earns a KEEP allocation, the whole basket is permanently consumed. Otherwise, the whole basket is returned.';
  useEffect(() => { setConsent(false); if (review) { reviewNode.current?.focus(); reviewNode.current?.scrollIntoView?.({ block: 'nearest' }); } }, [review]);
  useEffect(() => { if (accepted || operation?.refusal) { receiptNode.current?.focus(); receiptNode.current?.scrollIntoView?.({ block: 'nearest' }); } }, [accepted, operation?.refusal]);
  useEffect(() => { setQuantities({}); setConsent(false); }, [baseId]);
  const close = () => { dismiss(); onClose(); };
  return <EconomyPanel title="KEEP Mining" eyebrow="GOLD FORGE · DAILY CONTRIBUTIONS" icon={<Icon name="keep" size={40} />} onClose={close} error={state.error ?? refreshError}>
    <p className="sk-mining-intro">Put your kingdom’s resources to work. Build a basket for today’s mining pool, then complete today’s qualifying activity.</p>
    {!actionsAllowed && <p role="status">Game orders are paused. Your saved contribution receipts remain available.</p>}
    {!state.loaded && <p role="status">Loading saved contributions…</p>}
    {view ? <>
      <section className="sk-mining-overview" aria-label="Today’s mining allowance">
        <div className="sk-mining-pool"><Icon name="keep" size={32} /><div><span>{view.pool === 'deed' ? 'DEED POOL' : 'FREE POOL'}</span><strong>{view.remainingValue === null ? 'Uncapped contributions' : `${whole(view.remainingValue)} value remaining`}</strong></div></div>
        <dl><div><dt>Today · UTC</dt><dd>{view.day}</dd></div><div><dt>Already committed</dt><dd>{whole(view.committedValue)} value</dd></div>
          <div><dt>Daily allowance</dt><dd>{view.dailyCapValue === null ? 'Uncapped' : `${whole(view.dailyCapValue)} across your wallet`}</dd></div></dl>
      </section>
      <details className="sk-mining-details"><summary><Icon name="streak" /> How daily participation helps</summary>
        <p>Each day with qualifying raid activity in the last {view.consistency.windowDays} days adds {view.consistency.bonusPerQualifiedDayBps / 100}% to your mining weight, up to {view.consistency.maximumBonusBps / 100}%. Days do not have to be consecutive.</p>
        <p>This is the consistency policy, not your current earned bonus. Contribution value is mining weight, not a guaranteed amount of KEEP.</p>
        <p>Complete qualifying raid activity before this UTC day closes. Your kingdom and deed eligibility are also checked at daily settlement. {qualifiedDayTerms}</p>
      </details>
      {!view.developmentReady && <p className="sk-mining-notice" role="status">Complete the minimum mining buildings in this kingdom before contributing resources.</p>}
      {!view.acceptingContributions && <p className="sk-mining-notice" role="status">New contributions are paused. Saved receipts and settlement checks remain available.</p>}
      {!operation && <section aria-label="Choose mining resources" className="sk-mining-picker">
        <div className="sk-mining-heading"><div><span>BUILD YOUR BASKET</span><h3>Choose resources</h3></div><span>{view.resources.length} resource types</span></div>
        <div className="sk-mining-filters"><label>Find a resource<input type="search" className="interactive" value={search} placeholder="Search materials…" onChange={event => setSearch(event.target.value)} /></label>
          <label>Resource group<select className="interactive" value={filter} onChange={event => setFilter(event.target.value)}>{['All resources', 'SHARDS', 'Raw materials', 'Crafted materials'].map(value => <option key={value}>{value}</option>)}</select></label></div>
        <div className="sk-mining-summary" aria-label="Basket summary"><div><span>{lines.length} selected resource {lines.length === 1 ? 'type' : 'types'}</span><strong>{whole(total)} contribution value</strong></div>
          {overCap && <p className="sk-mining-invalid" role="status">Reduce your basket to fit today’s remaining allowance.</p>}
          <Btn style={full} disabled={!canAct || !view.developmentReady || !view.acceptingContributions || !lines.length || !!overStock || overCap}
            onClick={() => run(controller => controller.begin(view.baseId, lines))}>REVIEW CONTRIBUTION</Btn>
          <span>Nothing is reserved until you confirm.</span></div>
        <div className="sk-mining-resources">{view.resources.filter(row => (filter === 'All resources' || filter === group(row.resourceId)) && label(row.resourceId).toLowerCase().includes(search.toLowerCase())).map(row => {
          const value = quantities[row.resourceId] ?? '', amount = /^[0-9]{1,19}$/.test(value) ? BigInt(value) : 0n;
          const tooMany = amount > BigInt(row.available), selected = amount > 0n;
          const otherValue = total - amount * BigInt(row.unitValue);
          const room = view.remainingValue === null ? BigInt(row.available) : (BigInt(view.remainingValue) > otherValue ? (BigInt(view.remainingValue) - otherValue) / BigInt(row.unitValue) : 0n);
          const maximum = BigInt(row.available) < room ? BigInt(row.available) : room;
          const change = (quantity: string) => setQuantities(old => ({ ...old, [row.resourceId]: quantity }));
          return <article key={row.resourceId} className={`sk-mining-resource${selected ? ' is-selected' : ''}`}>
            <div className="sk-mining-resource-title"><Icon name={row.resourceId === 'shards' ? 'shard' : 'backpack'} size={28} /><div><h4>{label(row.resourceId)}</h4><span>{whole(row.available)} available · {whole(row.unitValue)} value each</span></div></div>
            <div className="sk-mining-quantity"><button className="interactive" type="button" aria-label={`Remove one ${label(row.resourceId)}`} disabled={!canAct || amount === 0n} onClick={() => change(String(amount - 1n))}>−</button>
              <input className="interactive" aria-label={`${label(row.resourceId)} quantity`} aria-invalid={tooMany} inputMode="numeric" pattern="[0-9]*" maxLength={19} value={value} placeholder="0" disabled={!canAct}
                onChange={event => change(event.target.value.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, ''))} />
              <button className="interactive" type="button" aria-label={`Add one ${label(row.resourceId)}`} disabled={!canAct || amount >= maximum} onClick={() => change(String(amount + 1n))}>+</button>
              <button className="interactive sk-mining-max" type="button" aria-label={`Maximum ${label(row.resourceId)}`} disabled={!canAct || maximum === 0n} onClick={() => change(String(maximum))}>MAX</button></div>
            {tooMany && <p className="sk-mining-invalid">Exceeds available stock</p>}
          </article>;
        })}</div>
        {!view.resources.some(row => (filter === 'All resources' || filter === group(row.resourceId)) && label(row.resourceId).toLowerCase().includes(search.toLowerCase())) && <p role="status">No matching resources. Try another name or group.</p>}

      </section>}
    </> : state.loaded && <p>Current kingdom stock is unavailable. Receipts below are historical proof; they do not show spendable resources.</p>}
    {operation && <section ref={receiptNode} tabIndex={-1} className="sk-mining-saved" aria-label="Saved mining contribution">
      <span className="sk-mining-kicker">{accepted ? 'CONTRIBUTION ACCEPTED' : operation.refusal ? 'CONTRIBUTION DECLINED' : operation.attemptRevision !== null ? 'AWAITING ORIGINAL RECEIPT' : 'SAVED BASKET'}</span>
      <h3>{accepted ? operation.proof?.settlement?.outcome === 'consumed' ? 'Resources consumed' : operation.proof?.settlement?.outcome === 'returned' ? 'Resources returned' : 'Resources reserved for mining' : 'Your original basket is safe'}</h3>
      {operation.attemptRevision !== null && !accepted && !operation.refusal && <p>This contribution may have been accepted. Checking its receipt never sends another contribution. Keep this original request while its outcome is unknown.</p>}
      {accepted && <p>{operation.proof?.settlement ? 'Daily settlement is recorded below. Refresh to see current available stock.' : 'Complete today’s qualifying activity before the UTC day closes. The server settles this basket automatically.'}</p>}
      {!originalSelected && !accepted && <p>Select the original kingdom to review this basket. Receipt checks remain available here.</p>}
      {review && !accepted && !operation.refusal && <section ref={reviewNode} tabIndex={-1} className="sk-mining-review" aria-label="Confirm mining contribution">
        <h3>Review your contribution</h3><p>{review.view.day} · UTC · {review.view.pool === 'deed' ? 'Deed pool' : 'Free pool'}</p>
        <Basket lines={review.command.request.lines} /><p className="sk-mining-review-value">{whole(contributionTotal(review.view, review.command.request.lines))} contribution value</p>
        <p>{qualifiedDayTerms}</p><p>Mining rewards depend on qualification and your share of the daily pool. KEEP is not guaranteed.</p>
        {operation.attemptRevision !== null && <p>This explicitly resends the same saved request after checking its original receipt.</p>}
        <label className="sk-mining-consent"><input type="checkbox" className="interactive" checked={consent} onChange={event => setConsent(event.target.checked)} />
          <span>I understand the reservation cannot be cancelled and resources are permanently consumed if this basket earns a KEEP allocation.</span></label>
        <Btn style={full} disabled={!canAct || !originalSelected || !consent} onClick={() => run(controller => controller.confirm())}>CONFIRM CONTRIBUTION</Btn>
        <Btn style={full} variant="sec" onClick={dismiss}>BACK TO SAVED BASKET</Btn>
      </section>}
      <div className="sk-economy-actions">
        {!accepted && !operation.refusal && !review && <Btn style={full} disabled={!canAct || !originalSelected} onClick={() => run(controller => controller.reviewCommand())}>REVIEW SAVED BASKET</Btn>}
        <Btn style={full} variant="sec" disabled={busy} onClick={() => run(controller => controller.open())}>CHECK ORIGINAL RECEIPT</Btn>
        {operation.attemptRevision === null && !accepted && <Btn style={full} variant="sec" disabled={busy} onClick={() => run(controller => controller.abandonDraft())}>DISCARD UNSENT BASKET</Btn>}
        {accepted && <Btn style={full} variant="sec" disabled={busy} onClick={finish}>SAVE TO HISTORY</Btn>}
        {operation.refusal && !accepted && <Btn style={full} variant="sec" disabled={busy} onClick={() => run(controller => controller.archiveRefusal())}>ARCHIVE DECLINED BASKET</Btn>}
      </div><Details operation={operation} />
    </section>}
    {!!state.journal?.archives.length && <details className="sk-mining-details"><summary>Contribution history ({state.journal.archives.length})</summary>
      {state.journal.archives.map(row => <article key={row.operation.command.request.idempotencyKey} className="sk-mining-history">
        <h3>{row.operation.proof?.status === 'accepted' ? 'Accepted contribution' : row.reason === 'refused' ? 'Declined basket' : 'Unsent basket'}</h3>
        <Details operation={row.operation} /><Btn style={full} variant="sec" disabled={busy} onClick={() => run(controller => controller.checkArchived(row.operation.command.request.idempotencyKey))}>CHECK SAVED RECEIPT</Btn>
      </article>)}
    </details>}
    <Btn style={full} variant="sec" disabled={busy} onClick={refresh}>REFRESH STOCK & RECEIPTS</Btn>
  </EconomyPanel>;
}
