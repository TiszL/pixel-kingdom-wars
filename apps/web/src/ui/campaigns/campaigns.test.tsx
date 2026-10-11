/** @vitest-environment happy-dom */
import { PLAYTEST_COMPETITIONS as RULES } from '@shardkeep/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../lib/api';
import { useApp } from '../../state/store';
import AdminCampaignPanel, { utcSchedule } from './AdminCampaignPanel';
import PlayerCampaignPanel from './PlayerCampaignPanel';
import type { AdminCampaignView } from './types';

const wallet = 'B'.repeat(44);
function campaign(kind: 'founding' | 'rewarded' = 'rewarded'): AdminCampaignView {
  return {
    id: kind === 'founding' ? RULES.foundingId : RULES.rewardedId, kind,
    name: RULES.names[kind], phase: 'running',
    startAt: '2026-09-08T15:33:00.000Z', endAt: '2026-09-22T15:33:00.000Z',
    revision: 3, registrationOpen: true, reconciledAt: '2026-09-08T16:00:00Z', snapshotAt: '2026-09-07T16:00:00Z',
    stale: false, measurementSince: '2026-09-07T00:00:00Z', participant: null,
    standings: [{ rank: 1, wallet, username: '<script>unsafe</script>', points: 75, activeDays: 2, longestStreak: 2, revenge: 1, stages: 3, achievedAt: '2026-09-08T16:00:00Z', eligible: true, guaranteed: false }],
    founders: [], winners: [], prizes: kind === 'rewarded' ? RULES.prizes : [], ownSubmissions: [],
    spots: kind === 'founding' ? { reserved: RULES.founderSpots, ranked: RULES.rankedSpots, total: RULES.founderSpots + RULES.rankedSpots } : null,
    checkpoint: kind === 'founding' ? { count: 50, target: 50, frozen: true, available: true } : null,
    participants: [{ wallet, username: 'Player B', joinedAt: '2026-09-08T15:34:00Z', disqualifiedAt: null, disqualificationReason: null, bonusAt: null }],
    submissions: [], awards: [], mintVerification: { complete: true, unresolvedAssets: [], verifiedUniqueWallets: 50, inventoryCompletedAt: '2026-09-07T16:00:00Z' },
  };
}
let root: Root, host: HTMLDivElement;
let founding: AdminCampaignView, rewarded: AdminCampaignView;
function button(label: string): HTMLButtonElement {
  const b = [...host.querySelectorAll('button')].find(el => el.textContent?.trim() === label);
  if (!b) throw new Error(`Missing button ${label}`); return b;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function input(label: string, value: string) {
  const field = [...host.querySelectorAll('label')].find(el => el.textContent?.startsWith(label))?.querySelector('input,textarea,select');
  if (!field) throw new Error(`Missing field ${label}`);
  await act(async () => {
    const proto = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
const mountPlayer = async () => { await act(async () => root.render(<PlayerCampaignPanel />)); };
const mountAdmin = async () => { await act(async () => root.render(<AdminCampaignPanel />)); };
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear(); useApp.getState().setAuth(wallet, true);
  founding = campaign('founding'); rewarded = campaign();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.spyOn(api, 'get').mockImplementation(async path => {
    if (path === '/admin/playtest/campaigns') return { campaigns: [founding, rewarded] };
    if (path === `/playtest/campaigns/${RULES.foundingId}/me`) return founding;
    if (path === `/playtest/campaigns/${RULES.rewardedId}/me`) return rewarded;
    if (path === '/tester/feedback/page') return { feedback: [{ id: 'report-1', title: 'A useful private report' }], nextCursor: null };
    throw new Error(`Unexpected GET ${path}`);
  });
  vi.spyOn(api, 'postRaw').mockResolvedValue({ revision: 4 });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useApp.getState().setAuth(null); sessionStorage.clear(); vi.restoreAllMocks(); });

describe('independent player campaigns', () => {
  it('distinguishes unavailable mint verification from a confirmed empty checkpoint', async () => {
    // An RPC interruption must not look like player reservations disappeared.
    founding.snapshotAt = null;
    founding.checkpoint = { count: null, target: 50, frozen: false, available: false };
    await mountPlayer();
    expect(host.textContent).toContain('CHECKPOINT VERIFICATION UNAVAILABLE');
    expect(host.textContent).not.toContain('Checkpoint 0/50');
    founding.checkpoint = { count: 0, target: 50, frozen: false, available: true };
    await click('REFRESH CAMPAIGN');
    expect(host.textContent).toContain('Checkpoint 0/50');
    expect(host.textContent).not.toContain('CHECKPOINT VERIFICATION UNAVAILABLE');
  });
  it('shows the last verified time without presenting an unavailable checkpoint as current', async () => {
    founding.snapshotAt = null;
    founding.checkpoint = { count: null, target: 50, frozen: false, available: false,
      verification: { status: 'unavailable', lastSuccessAt: '2026-09-08T11:31:00Z', lastAttemptAt: '2026-09-08T11:32:00Z' } };
    await mountPlayer();
    expect(host.textContent).toContain('Verification will retry automatically');
    expect(host.textContent).toContain('Last verified');
    expect(host.textContent).toContain('UTC');
    expect(host.textContent).not.toContain('Checkpoint 0/50');
  });
  it('keeps Founding automatic and renders score names as escaped text', async () => {
    await mountPlayer();
    expect(host.textContent).toContain('Automatic participation');
    expect(host.textContent).toContain('HELD UNTIL LAUNCH');
    expect(host.textContent).toContain('<script>unsafe</script>');
    expect(host.querySelector('script')).toBeNull();
    expect([...host.querySelectorAll('button')].some(b => b.textContent === 'PARTICIPATE')).toBe(false);
    expect(host.textContent).toContain('Lifetime leaderboard points keep growing');
  });
  it('requires explicit rewarded participation and locks a same-tick double tap', async () => {
    await mountPlayer(); await click('CROWN CLASH');
    let resolve!: (value: unknown) => void;
    vi.mocked(api.postRaw).mockImplementation(() => new Promise(done => { resolve = done; }));
    await act(async () => { button('PARTICIPATE').click(); button('PARTICIPATE').click(); });
    expect(api.postRaw).toHaveBeenCalledTimes(1);
    expect(api.postRaw).toHaveBeenCalledWith(`/playtest/campaigns/${RULES.rewardedId}/participate`, { requestId: expect.any(String) }, expect.anything());
    rewarded.participant = rewarded.participants[0]!;
    await act(async () => resolve({}));
    expect(host.textContent).toContain('Participating since');
  });
  it('submits only selected own report IDs or public HTTPS video URLs', async () => {
    rewarded.participant = rewarded.participants[0]!;
    await mountPlayer(); await click('CROWN CLASH');
    await input('Public social-post URL', 'https://example.com/honest-gameplay');
    await click('SUBMIT VIDEO');
    expect(api.postRaw).toHaveBeenLastCalledWith(`/playtest/campaigns/${RULES.rewardedId}/submissions`, { requestId: expect.any(String), kind: 'video', url: 'https://example.com/honest-gameplay' }, expect.anything());
    await input('Choose one of your private reports', 'report-1'); await click('ENTER REPORT FOR BUG SCOUT');
    expect(api.postRaw).toHaveBeenLastCalledWith(`/playtest/campaigns/${RULES.rewardedId}/submissions`, { requestId: expect.any(String), kind: 'report', reportId: 'report-1' }, expect.anything());
  });
  it('retains the exact receipt after an unknown response and across remount', async () => {
    rewarded.participant = rewarded.participants[0]!;
    vi.mocked(api.postRaw).mockRejectedValueOnce(new ApiError(0, 'Connection interrupted'));
    await mountPlayer(); await click('CROWN CLASH');
    await input('Public social-post URL', 'https://example.com/post'); await click('SUBMIT VIDEO');
    const first = vi.mocked(api.postRaw).mock.calls[0]!;
    await act(async () => root.unmount()); root = createRoot(host); await mountPlayer(); await click('CROWN CLASH');
    await click('RETRY REQUEST');
    expect(vi.mocked(api.postRaw).mock.calls[1]!.slice(0, 2)).toEqual(first.slice(0, 2));
  });
  it('blocks entries after closing and report/video submission before joining', async () => {
    rewarded.phase = 'ended'; rewarded.registrationOpen = false;
    await mountPlayer(); await click('CROWN CLASH');
    expect(button('PARTICIPATE').disabled).toBe(true);
    expect(host.querySelector('input[type="url"]')).toBeNull();
  });
});

describe('audited admin campaign controls', () => {
  it('interprets the entered calendar time as UTC, independent of device timezone', async () => {
    expect(utcSchedule('2026-09-08T15:33')).toBe('2026-09-08T15:33:00.000Z');
    expect(utcSchedule('2026-02-30T15:33')).toBeNull();
    founding.phase = 'draft'; founding.startAt = null;
    // A later scan outage cannot undo a previously verified immutable snapshot.
    founding.mintVerification.complete = false;
    founding.mintVerification.inventoryCompletedAt = null;
    await mountAdmin();
    expect(host.textContent).toContain('First checkpoint verified and frozen.');
    expect(host.textContent).not.toContain('Launch blocked');
    await input('Start date and time (UTC)', '2026-09-08T15:33'); await click('SAVE UTC SCHEDULE');
    expect(api.postRaw).toHaveBeenCalledWith(`/admin/playtest/campaigns/${RULES.foundingId}/schedule`, { requestId: expect.any(String), revision: 3, startAt: '2026-09-08T15:33:00.000Z', registrationOpen: false }, expect.anything());
  });
  it('keeps Founding launch blocked without the verified frozen checkpoint', async () => {
    founding.phase = 'draft'; founding.snapshotAt = null; founding.mintVerification.complete = false;
    founding.mintVerification.unresolvedAssets = ['unverified-deed'];
    await mountAdmin();
    expect(button('SAVE UTC SCHEDULE').disabled).toBe(true);
    expect(host.textContent).toContain('unverified-deed');
  });
  it('records a reasoned disqualification and keeps closeout manual', async () => {
    await mountAdmin(); await click('Crown Clash');
    await input('Entrant', wallet); await input('Disqualification reason', 'Repeated empty visits do not qualify.');
    await click('DISQUALIFY SELECTED ENTRANT');
    expect(api.postRaw).toHaveBeenCalledWith(`/admin/playtest/campaigns/${RULES.rewardedId}/disqualify`, { requestId: expect.any(String), revision: 3, wallet, reason: 'Repeated empty visits do not qualify.' }, expect.anything());
    expect(button('RECONCILE & FINALIZE RESULTS').disabled).toBe(true);
  });
  it('requires a fresh review after a stale revision instead of silently replaying a decision', async () => {
    vi.mocked(api.postRaw).mockRejectedValue(new ApiError(409, 'Campaign changed; refresh and review.'));
    rewarded.phase = 'ended';
    await mountAdmin(); await click('Crown Clash'); await click('RECONCILE & FINALIZE RESULTS');
    expect(api.postRaw).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Campaign changed; refresh and review.');
    expect(host.textContent).not.toContain('RETRY REQUEST');
  });
  it('records video scores and external payment references without issuing payments', async () => {
    rewarded.phase = 'finalized';
    rewarded.submissions = [{ id: 'video-entry', wallet, username: 'Player B', kind: 'video', reportId: null, url: 'https://example.com/video', createdAt: '2026-09-10T12:00:00Z' }];
    await mountAdmin(); await click('Crown Clash'); await click('SELECT FOR JUDGING');
    await input('Award', 'video'); await input('Judging notes', 'Useful criticism backed by real gameplay.');
    await input('FEEDBACK', '80'); await input('EVIDENCE', '90'); await input('CLARITY', '70'); await input('COVERAGE', '60');
    await click('RECORD JUDGED AWARD');
    expect(api.postRaw).toHaveBeenLastCalledWith(`/admin/playtest/campaigns/${RULES.rewardedId}/award`, { requestId: expect.any(String), revision: 3, prizeId: 'video', wallet, submissionId: 'video-entry', reason: 'Useful criticism backed by real gameplay.', scores: { feedback: 80, evidence: 90, clarity: 70, coverage: 60 } }, expect.anything());
    rewarded.awards = [{ prizeId: 'video', wallet, username: 'Player B', amountUsd: 100, category: 'video', paidAt: null }];
    await click('REFRESH CAMPAIGNS'); await input('Unpaid award', `video:${wallet}`); await input('External payment reference', 'External transaction receipt'); await click('RECORD EXTERNAL PAYMENT');
    expect(api.postRaw).toHaveBeenLastCalledWith(`/admin/playtest/campaigns/${RULES.rewardedId}/payment`, { requestId: expect.any(String), revision: 3, prizeId: 'video', wallet, reference: 'External transaction receipt' }, expect.anything());
  });
  it('requires a separate cancellation reason', async () => {
    await mountAdmin(); await input('Disqualification reason', 'Not a cancellation reason');
    expect(button('CANCEL CAMPAIGN WITH REASON').disabled).toBe(true);
    await input('Cancellation reason', 'Schedule needs an owner review'); await click('CANCEL CAMPAIGN WITH REASON');
    expect(api.postRaw).toHaveBeenLastCalledWith(`/admin/playtest/campaigns/${RULES.foundingId}/cancel`, { requestId: expect.any(String), revision: 3, reason: 'Schedule needs an owner review' }, expect.anything());
  });
});
