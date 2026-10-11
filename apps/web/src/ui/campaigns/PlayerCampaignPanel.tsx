import { PLAYTEST_COMPETITIONS as RULES } from '@shardkeep/shared';
import { useState } from 'react';
import { useApp } from '../../state/store';
import { Btn, COLORS as C } from '../primitives';
import { useFeedbackPages } from '../feedback/useFeedbackPages';
import { CampaignHeader, CampaignRules, CampaignStandings, MutationNotice, inputStyle, stack, utc } from './CampaignShared';
import type { CampaignView } from './types';
import { useCampaignData } from './useCampaignData';
import { useCampaignMutation } from './useCampaignMutation';

export default function PlayerCampaignPanel(): React.JSX.Element {
  const wallet = useApp(s => s.wallet);
  const [id, setId] = useState<string>(RULES.foundingId);
  return <div style={stack}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <Btn variant={id === RULES.foundingId ? 'gold' : 'sec'} fontSize={15} onClick={() => setId(RULES.foundingId)}>{RULES.names.founding.toUpperCase()}</Btn>
      <Btn variant={id === RULES.rewardedId ? 'gold' : 'sec'} fontSize={15} onClick={() => setId(RULES.rewardedId)}>{RULES.names.rewarded.toUpperCase()}</Btn>
    </div>
    {wallet && <PlayerCampaign key={`${wallet}:${id}`} id={id} wallet={wallet} />}
  </div>;
}
function PlayerCampaign({ id, wallet }: { id: string; wallet: string }): React.JSX.Element {
  const path = `/playtest/campaigns/${id}`;
  const data = useCampaignData<CampaignView>(`${path}/me`);
  const mutation = useCampaignMutation(path, data.refresh);
  const [url, setUrl] = useState(''), [reportId, setReportId] = useState('');
  const c = data.data;
  const reports = useFeedbackPages<{ id: string; title: string }>(wallet, '/tester/feedback/page');
  const locked = mutation.busy || mutation.pending !== null;
  if (!c) return <div role={data.error ? 'alert' : 'status'}>{data.error ?? 'LOADING CAMPAIGN…'}{data.error && <Btn onClick={() => void data.refresh()}>RETRY</Btn>}</div>;
  const joined = c.kind === 'founding' || c.participant !== null;
  const disqualified = !!c.participant?.disqualifiedAt;
  const canEnter = c.registrationOpen && ['draft', 'scheduled', 'running'].includes(c.phase);
  const mine = c.standings.find(row => row.wallet === wallet);
  return <div style={stack}>
    <CampaignHeader campaign={c} />
    {data.error && <p role="alert">Latest refresh failed: {data.error}. Showing the previous snapshot.</p>}
    {c.kind === 'founding' ? <p>Automatic participation · {c.checkpoint?.available !== false && typeof c.checkpoint?.count === 'number'
      ? <>Checkpoint {c.checkpoint.count}/{c.checkpoint.target}{c.checkpoint.frozen ? ' · HELD UNTIL LAUNCH' : ''}{c.snapshotAt ? ' · FIRST SNAPSHOT COMPLETE' : ' · VERIFYING FIRST CHECKPOINT'}.</>
      : 'CHECKPOINT VERIFICATION UNAVAILABLE. Verification will retry automatically.'} {c.checkpoint?.verification?.lastSuccessAt && <>Last verified {utc(c.checkpoint.verification.lastSuccessAt)}.</>}</p> : <>
      <p role="status">{disqualified ? `Disqualified: ${c.participant?.disqualificationReason ?? 'See campaign rules.'}` : joined ? `Participating since ${utc(c.participant?.joinedAt)}.` : canEnter ? 'Participation is optional. Join to start earning competition points.' : 'Registration is not open.'}</p>
      {!joined && <Btn disabled={!canEnter || locked} onClick={() => mutation.run(`${path}/participate`, {})}>PARTICIPATE</Btn>}
      {c.participant?.bonusAt && <p>+{RULES.participationBonus.points} lifetime participation points earned.</p>}
    </>}
    <p>Your campaign score: <strong>{mine ? mine.points : 'Not scored yet'}</strong>{mine ? ` · ${mine.activeDays} active UTC days · longest streak ${mine.longestStreak}` : ''}</p>
    {mine && c.kind === 'rewarded' && <p>{mine.revenge} qualifying revenge wins · {mine.stages} distinct three-star stages.</p>}
    <CampaignRules campaign={c} />
    <MutationNotice mutation={mutation} />
    {c.kind === 'rewarded' && joined && !disqualified && <section aria-label="Your competition submissions" style={stack}>
      <h3>Your submissions</h3>
      <p>Submit an original public gameplay video with objective feedback. Constructive criticism helps improve the game.</p>
      <label>Public social-post URL<input style={inputStyle} type="url" value={url} onChange={e => setUrl(e.target.value)} disabled={locked || c.phase !== 'running'} /></label>
      <Btn disabled={locked || c.phase !== 'running' || !/^https:\/\//i.test(url.trim())} onClick={() => mutation.run(`${path}/submissions`, { kind: 'video', url: url.trim() })}>SUBMIT VIDEO</Btn>
      <label>Choose one of your private reports<select style={inputStyle} value={reportId} disabled={locked || c.phase !== 'running'} onChange={e => setReportId(e.target.value)}>
        <option value="">Select a report</option>{reports.data?.feedback.map(report => <option key={report.id} value={report.id}>{report.title}</option>)}
      </select></label>
      {reports.error && <p role="alert">{reports.error}<Btn onClick={reports.reload}>RETRY REPORTS</Btn></p>}
      {reports.nextCursor && <Btn onClick={reports.more} disabled={reports.loading}>MORE REPORTS</Btn>}
      <Btn disabled={locked || c.phase !== 'running' || !reportId} onClick={() => mutation.run(`${path}/submissions`, { kind: 'report', reportId })}>ENTER REPORT FOR BUG SCOUT</Btn>
      <p style={{ color: C.textFaint }}>Create a report in the FEEDBACK tab first. Only reports submitted during eligible participation qualify. Reports and judging notes remain private.</p>
      <ul>{c.ownSubmissions.map(s => <li key={s.id}>{s.kind === 'video' ? 'Video' : 'Report'} · {utc(s.createdAt)}{s.url && <> · <a href={s.url} target="_blank" rel="noreferrer">View post</a></>}</li>)}</ul>
    </section>}
    <CampaignStandings campaign={c} />
    {c.winners.length > 0 && <section><h3>Awards</h3><ul>{c.winners.map(w => <li key={`${w.prizeId}:${w.wallet}`}>{c.prizes.find(p => p.id === w.prizeId)?.title ?? 'Whitelist spot'} — {w.username || w.wallet}{w.amountUsd > 0 ? ` · $${w.amountUsd}` : ''}</li>)}</ul></section>}
    <Btn variant="sec" onClick={() => void data.refresh()}>REFRESH CAMPAIGN</Btn>
  </div>;
}
