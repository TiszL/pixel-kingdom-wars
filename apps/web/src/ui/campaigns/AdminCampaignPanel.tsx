import { PLAYTEST_COMPETITIONS as RULES } from '@shardkeep/shared';
import { lazy, Suspense, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useApp } from '../../state/store';
import { Btn, COLORS as C } from '../primitives';
import { CampaignHeader, CampaignStandings, MutationNotice, inputStyle, stack, utc } from './CampaignShared';
import type { AdminCampaignView, CampaignSubmission } from './types';
import { useCampaignData } from './useCampaignData';
import { useCampaignMutation } from './useCampaignMutation';
const FeedbackThread = lazy(() => import('../feedback/FeedbackThread'));
export function utcSchedule(input: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input)) return null;
  const date = new Date(`${input}:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(input) ? date.toISOString() : null;
}
export default function AdminCampaignPanel(): React.JSX.Element {
  const wallet = useApp(s => s.wallet);
  return wallet ? <AdminCampaigns key={wallet} wallet={wallet} /> : <p>Sign in to manage campaigns.</p>;
}
function AdminCampaigns({ wallet }: { wallet: string }): React.JSX.Element {
  const state = useCampaignData<{ campaigns: AdminCampaignView[] }>('/admin/playtest/campaigns');
  const [selected, setSelected] = useState<string>(RULES.foundingId);
  const [report, setReport] = useState<string | null>(null);
  const c = state.data?.campaigns.find(campaign => campaign.id === selected);
  if (report) return <Suspense fallback={<p role="status">LOADING PRIVATE REPORT…</p>}><FeedbackThread wallet={wallet} mode="admin" reportId={report} onBack={() => setReport(null)} /></Suspense>;
  return <div style={stack}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{state.data?.campaigns.map(campaign => <Btn key={campaign.id} variant={selected === campaign.id ? 'gold' : 'sec'} fontSize={15} onClick={() => setSelected(campaign.id)}>{campaign.name}</Btn>)}</div>
    {state.error && <p role="alert">{state.error}<Btn onClick={() => void state.refresh()}>RETRY</Btn></p>}
    {state.loading && <p role="status">LOADING CAMPAIGNS…</p>}
    {c && <AdminCampaign key={c.id} campaign={c} refresh={state.refresh} onReport={setReport} />}
  </div>;
}
function AdminCampaign({ campaign: c, refresh, onReport }: { campaign: AdminCampaignView; refresh: () => Promise<void>; onReport: (id: string) => void }): React.JSX.Element {
  const path = `/admin/playtest/campaigns/${c.id}`;
  const mutation = useCampaignMutation(path, refresh);
  const [start, setStart] = useState(c.startAt?.slice(0, 16) ?? ''), [registration, setRegistration] = useState(c.registrationOpen);
  const [reason, setReason] = useState(''), [entrant, setEntrant] = useState('');
  const [judgingReason, setJudgingReason] = useState(''), [cancelReason, setCancelReason] = useState('');
  const [submission, setSubmission] = useState(''), [prizeId, setPrizeId] = useState('');
  const [scores, setScores] = useState({ feedback: 0, evidence: 0, clarity: 0, coverage: 0 });
  const [paymentAward, setPaymentAward] = useState(''), [reference, setReference] = useState('');
  const [exportError, setExportError] = useState<string | null>(null);
  useEffect(() => { setStart(c.startAt?.slice(0, 16) ?? ''); setRegistration(c.registrationOpen); }, [c.startAt, c.registrationOpen]);
  const locked = mutation.busy || mutation.pending !== null;
  const before = ['draft', 'scheduled'].includes(c.phase);
  const selectedEntry = c.submissions.find(s => s.id === submission);
  const availablePrizes = c.prizes.filter(p => p.category === selectedEntry?.kind && !c.awards.some(a => a.prizeId === p.id));
  const award = c.awards.find(a => `${a.prizeId}:${a.wallet}` === paymentAward);
  const command = (action: string, body: Record<string, unknown> = {}): void => mutation.run(`${path}/${action}`, { revision: c.revision, ...body });
  const download = async (): Promise<void> => {
    const wallet = useApp.getState().wallet, controller = new AbortController();
    const off = useApp.subscribe(s => { if (s.wallet !== wallet) controller.abort(); });
    try {
      setExportError(null);
      const snapshot = await api.get(`${path}/export`, { signal: controller.signal });
      if (controller.signal.aborted || useApp.getState().wallet !== wallet) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `${c.id}-results.json`; a.click(); URL.revokeObjectURL(url);
    } catch (e) { if (!controller.signal.aborted) setExportError(e instanceof Error ? e.message : 'Export failed.'); }
    finally { off(); }
  };
  const selectSubmission = (entry: CampaignSubmission): void => { setSubmission(entry.id); setPrizeId(''); };
  return <div style={stack}>
    <CampaignHeader campaign={c} />
    <MutationNotice mutation={mutation} />
    {c.mintVerification.unresolvedAssets.length > 0 && <details><summary>Unverified mint assets</summary><ul>{c.mintVerification.unresolvedAssets.map(asset => <li key={asset} style={{ overflowWrap: 'anywhere' }}>{asset}</li>)}</ul></details>}
    <section style={stack} aria-label="Campaign schedule"><h3>Launch controls</h3>
      {c.kind === 'founding' && <p>{c.snapshotAt ? 'First checkpoint verified and frozen.' : 'Launch blocked until the first checkpoint is verified and frozen.'} {c.mintVerification.complete ? `${c.mintVerification.verifiedUniqueWallets} verified original wallets;` : 'Verified wallet count is unavailable;'} {c.mintVerification.unresolvedAssets.length} unresolved assets. {c.mintVerification.inventoryCompletedAt ? `Inventory checked ${utc(c.mintVerification.inventoryCompletedAt)}.` : 'Waiting for a complete mint inventory.'} {c.mintVerification.lastSuccessAt && <>Last successful verification {utc(c.mintVerification.lastSuccessAt)}.</>} {c.mintVerification.lastAttemptAt && <> Last attempt {utc(c.mintVerification.lastAttemptAt)}.</>} {c.mintVerification.reason && <> Status: {c.mintVerification.reason.replaceAll('_', ' ')}.</>} {c.mintVerification.diagnostics && <> Scan attempts: {c.mintVerification.diagnostics.attempts}.</>}</p>}
      <label>Start date and time (UTC)<input type="datetime-local" style={inputStyle} value={start} onInput={e => setStart(e.currentTarget.value)} onChange={e => setStart(e.target.value)} disabled={locked || !before} /></label>
      {c.kind === 'rewarded' && <label><input type="checkbox" checked={registration} disabled={locked || !before} onChange={e => setRegistration(e.target.checked)} /> Open participation registration</label>}
      <p>All times are UTC, regardless of this device's timezone. Duration: {RULES.durationDays} days. Dates and rules lock at launch.</p>
      <Btn disabled={locked || !before || !utcSchedule(start) || (c.kind === 'founding' && !c.snapshotAt)} onClick={() => command('schedule', { startAt: utcSchedule(start), registrationOpen: c.kind === 'rewarded' && registration })}>SAVE UTC SCHEDULE</Btn>
    </section>
    <section style={stack}><h3>Entrants and eligibility</h3>
      <label>Entrant<select style={inputStyle} value={entrant} disabled={locked} onChange={e => setEntrant(e.target.value)}><option value="">Select an entrant</option>{c.participants.map(p => <option key={p.wallet} value={p.wallet}>{p.username || p.wallet}{p.disqualifiedAt ? ' · disqualified' : ''}</option>)}</select></label>
      {entrant && <p style={{ overflowWrap: 'anywhere' }}>{entrant} · Joined {utc(c.participants.find(p => p.wallet === entrant)?.joinedAt)}</p>}
      <label>Disqualification reason<textarea style={inputStyle} value={reason} disabled={locked} onChange={e => setReason(e.target.value)} /></label>
      <Btn variant="sec" disabled={locked || !entrant || !reason.trim() || ['finalized', 'cancelled'].includes(c.phase)} onClick={() => command('disqualify', { wallet: entrant, reason: reason.trim() })}>DISQUALIFY SELECTED ENTRANT</Btn>
    </section>
    {c.kind === 'rewarded' && <section style={stack}><h3>Private submissions and judging</h3>
      <p>Read reports in the existing private feedback view. Public videos are opened only when selected. Judge useful criticism equally with positive feedback.</p>
      {c.submissions.map(entry => <div key={entry.id} style={{ ...stack, border: `1px solid ${C.border}`, padding: 10 }}>
        <span style={{ overflowWrap: 'anywhere' }}>{entry.username || entry.wallet} · {entry.kind} · {utc(entry.createdAt)}</span>
        {entry.kind === 'report' && entry.reportId && <Btn variant="sec" onClick={() => onReport(entry.reportId!)}>OPEN PRIVATE REPORT</Btn>}
        {entry.url && <a href={entry.url} target="_blank" rel="noreferrer">OPEN VIDEO POST</a>}
        <Btn variant={submission === entry.id ? 'gold' : 'sec'} onClick={() => selectSubmission(entry)} disabled={locked}>SELECT FOR JUDGING</Btn>
      </div>)}
      {selectedEntry && <>
        <p>Selected {selectedEntry.kind}: {selectedEntry.username || selectedEntry.wallet}</p>
        <label>Award<select style={inputStyle} value={prizeId} disabled={locked} onChange={e => setPrizeId(e.target.value)}><option value="">Choose an unawarded prize</option>{availablePrizes.map(p => <option key={p.id} value={p.id}>{p.title} · ${p.amountUsd} · {p.id}</option>)}</select></label>
        {selectedEntry.kind === 'video' && <fieldset style={stack}><legend>Video rubric · score each criterion out of 100</legend>{(Object.keys(RULES.videoWeights) as Array<keyof typeof scores>).map(metric => <label key={metric}>{metric.toUpperCase()} · {RULES.videoWeights[metric]}%<input style={inputStyle} type="number" min={0} max={100} value={scores[metric]} disabled={locked} onChange={e => setScores(s => ({ ...s, [metric]: Number(e.target.value) }))} /></label>)}</fieldset>}
        <label>Judging notes<textarea style={inputStyle} value={judgingReason} disabled={locked} onChange={e => setJudgingReason(e.target.value)} /></label>
        <p>Bug Scout reports must be accepted as actionable in the private feedback view. Consider reproducibility, evidence and usefulness; duplicate reports are ineligible.</p>
        <Btn disabled={locked || !prizeId || !judgingReason.trim() || c.phase !== 'finalized'} onClick={() => command('award', { prizeId, wallet: selectedEntry.wallet, submissionId: selectedEntry.id, reason: judgingReason.trim(), ...(selectedEntry.kind === 'video' ? { scores } : {}) })}>RECORD JUDGED AWARD</Btn>
        {c.phase !== 'finalized' && <p>Judged awards can be recorded after campaign results are finalized.</p>}
      </>}
    </section>}
    <CampaignStandings campaign={c} />
    <section style={stack}><h3>Closeout and payment records</h3>
      {c.closeVerification && !c.closeVerification.complete && c.phase === 'ended' && <div role="status"><p>Chain ownership at campaign close needs verification before Founding awards can freeze.</p><ul>{c.closeVerification.missingAssets.map(a => <li key={a.assetId} style={{ overflowWrap: 'anywhere' }}>{a.assetId} · {a.wallet} · {a.reason}</li>)}</ul></div>}
      <Btn disabled={locked || c.phase !== 'ended'} onClick={() => command('finalize')}>RECONCILE &amp; FINALIZE RESULTS</Btn>
      <p>Finalization reconciles the full window and freezes rankings and eligibility. Payments happen externally; this panel only records receipts.</p>
      <ul>{c.awards.map(a => <li key={`${a.prizeId}:${a.wallet}`} style={{ overflowWrap: 'anywhere' }}>{a.prizeId} · {a.username || a.wallet} · ${a.amountUsd} · {a.paidAt ? `Paid ${utc(a.paidAt)} · ${a.paymentReference}` : 'Unpaid'}</li>)}</ul>
      <label>Unpaid award<select style={inputStyle} value={paymentAward} disabled={locked} onChange={e => setPaymentAward(e.target.value)}><option value="">Select award</option>{c.awards.filter(a => !a.paidAt && a.amountUsd > 0).map(a => <option key={`${a.prizeId}:${a.wallet}`} value={`${a.prizeId}:${a.wallet}`}>{a.prizeId} · {a.username || a.wallet} · ${a.amountUsd}</option>)}</select></label>
      <label>External payment reference<input style={inputStyle} value={reference} disabled={locked} onChange={e => setReference(e.target.value)} /></label>
      <Btn disabled={locked || !award || !reference.trim()} onClick={() => { if (award) command('payment', { prizeId: award.prizeId, wallet: award.wallet, reference: reference.trim() }); }}>RECORD EXTERNAL PAYMENT</Btn>
      <Btn variant="sec" onClick={() => void download()}>EXPORT PRIVATE RESULTS JSON</Btn>{exportError && <p role="alert">{exportError}</p>}
      <label>Cancellation reason<textarea style={inputStyle} value={cancelReason} disabled={locked} onChange={e => setCancelReason(e.target.value)} /></label>
      <Btn variant="ghost" disabled={locked || ['cancelled', 'finalized'].includes(c.phase) || !cancelReason.trim()} onClick={() => command('cancel', { reason: cancelReason.trim() })}>CANCEL CAMPAIGN WITH REASON</Btn>
    </section>
    <Btn variant="sec" onClick={() => void refresh()}>REFRESH CAMPAIGNS</Btn>
  </div>;
}
