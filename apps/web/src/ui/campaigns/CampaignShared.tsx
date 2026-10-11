import { PLAYTEST_COMPETITIONS as RULES } from '@shardkeep/shared';
import type { CSSProperties } from 'react';
import { Btn, Chip, COLORS as C, fmtN } from '../primitives';
import type { CampaignView } from './types';
export const stack: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 };
export const inputStyle: CSSProperties = { minHeight: 44, width: '100%', minWidth: 0, boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 16, color: C.text, background: C.surface, border: `2px solid ${C.border}`, padding: 8 };
export const utc = (value: string | null | undefined) => value ? `${value.slice(0, 16).replace('T', ' ')} UTC` : 'Not scheduled';
export function CampaignHeader({ campaign: c }: { campaign: CampaignView }): React.JSX.Element {
  return <Chip style={{ ...stack, alignItems: 'stretch' }}><strong style={{ color: C.goldHi }}>{c.name}</strong>
    <span>{c.phase.toUpperCase()} · {RULES.durationDays} DAYS</span>
    <span>Starts {utc(c.startAt)} · Ends {utc(c.endAt)}</span>
    <span style={{ color: c.stale ? C.gold : C.textFaint }}>{c.reconciledAt ? `Scores updated ${utc(c.reconciledAt)}` : 'Scores not updated yet'}{c.stale ? ' · UPDATE DELAYED' : ''}</span>
    <p style={{ margin: 0 }}>Campaign points start fresh. Lifetime leaderboard points keep growing throughout.</p>
    {c.spots && <p style={{ margin: 0 }}>{c.spots.total} whitelist spots · {c.spots.reserved} reserved for original minters + {c.spots.ranked} ranked campaign awards.</p>}
    {c.founders.length > 0 && <details><summary>{c.snapshotAt ? 'Guaranteed whitelist recipients · frozen snapshot' : 'Verified original minters · snapshot not frozen'}</summary>
      <ol>{c.founders.map(founder => <li key={founder.position} value={founder.position} style={{ overflowWrap: 'anywhere' }}>{founder.username || 'Keeper'} · {founder.wallet}</li>)}</ol>
    </details>}
  </Chip>;
}
export function CampaignRules({ campaign: c }: { campaign: CampaignView }): React.JSX.Element {
  return <details><summary className="interactive" style={{ minHeight: 44 }}>RULES &amp; REWARDS</summary>
    {c.kind === 'founding' ? <p>Everyone participates automatically. The first {RULES.founderSpots} unique original deed minters keep guaranteed whitelist spots, even after selling. During this campaign, another {RULES.rankedSpots} spots go to the highest-scoring eligible deed holders, excluding guaranteed recipients. Deed eligibility is checked at close.</p> : <>
      <p>Tap Participate to enter. Only activity after both launch and your entry counts. Play on {RULES.participationBonus.activeDays} distinct UTC days to earn +{RULES.participationBonus.points} lifetime points once.</p>
      <p>Feedback review points count toward your lifetime leaderboard, not this campaign score. Eligible reports can separately win Bug Scout awards.</p>
      <p>Daily activity, caps and streak rewards match normal play. Campaign streaks start fresh. Score ties use active days, the earliest time reaching the score, then wallet address.</p>
      <ul>{c.prizes.map(p => <li key={p.id}>${p.amountUsd} — {p.title}{p.id === 'champion' ? ' · highest score' : p.id === 'challenger' ? ' · second-highest score' : p.id === 'bronze' ? ' · third-highest score' : ''}</li>)}</ul>
      <p>One gameplay award and one Bug Scout award per wallet; you can also win the video award. Gameplay awards are allocated in the order shown, skipping earlier winners. Revenge counts once per opposing wallet per UTC day. Daily Defender uses active days, then longest streak. Realm Explorer counts distinct three-star stages completed during participation.</p>
      <p>Bug Scouts reward actionable, reproducible reports with useful evidence. Duplicate reports are ineligible. Submit reports and your public social-video URL before close. Video judging: useful feedback {RULES.videoWeights.feedback}%, gameplay evidence {RULES.videoWeights.evidence}%, clarity {RULES.videoWeights.clarity}%, player-experience coverage {RULES.videoWeights.coverage}%. Honest criticism is welcome; praise, views and likes give no advantage.</p>
    </>}
  </details>;
}
export function CampaignStandings({ campaign: c }: { campaign: CampaignView }): React.JSX.Element {
  return <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', minWidth: c.kind === 'rewarded' ? 640 : 360, borderCollapse: 'collapse', fontSize: 14 }}>
    <caption style={{ textAlign: 'left', padding: 8 }}>{c.name} scores</caption>
    <thead><tr>{['Rank', 'Player', 'Points', 'Active days', ...(c.kind === 'rewarded' ? ['Best streak', 'Revenge wins', 'Three-star stages'] : []), 'Status'].map(h => <th key={h} scope="col" style={{ textAlign: 'left', padding: 8 }}>{h}</th>)}</tr></thead>
    <tbody>{c.standings.map(row => <tr key={row.wallet}><td>{row.rank}</td><td style={{ padding: 8, overflowWrap: 'anywhere' }}>{row.username || row.wallet}</td><td>{fmtN(row.points)}</td><td>{row.activeDays}</td>{c.kind === 'rewarded' && <><td>{row.longestStreak}</td><td>{row.revenge}</td><td>{row.stages}</td></>}<td>{row.guaranteed ? 'Guaranteed spot' : row.eligible ? 'Eligible' : 'Not eligible'}</td></tr>)}</tbody>
  </table>{c.standings.length === 0 && <p>No scored activity yet.</p>}</div>;
}
export function MutationNotice({ mutation }: { mutation: { busy: boolean; error: string | null; pending: unknown; retry: () => void } }): React.JSX.Element {
  return <>{mutation.error && <p role="alert" style={{ color: C.danger }}>{mutation.error}</p>}
    {mutation.pending && !mutation.busy ? <div role="status">An earlier request needs confirmation. Retrying uses the same request.<Btn disabled={mutation.busy} onClick={mutation.retry}>RETRY REQUEST</Btn></div> : null}
  </>;
}
