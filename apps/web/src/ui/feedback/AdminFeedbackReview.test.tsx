/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { useApp } from '../../state/store';
import AdminFeedbackReview from './AdminFeedbackReview';
const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('./AdminFeedbackModeration', () => ({ default: () => null }));
vi.mock('../../lib/api', async original => ({ ...await original<typeof import('../../lib/api')>(), api: { get, postRaw: post } }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const linked = { id: 'issue', title: 'Curated issue', revision: 1, status: 'investigating', publishedAt: null, mergedInto: null as string | null };
const thread = (revision = 4, issue: typeof linked | null = linked) => ({ report: { revision, linkedIssue: issue, fixedAt: null, rewardPolicyVersion: 2, status: 'new', basePoints: 0, bonusPoints: 0, points: 0, importance: null, verificationVerdict: 'unverified' } });
const cleanups: Array<() => Promise<void>> = [];
async function mount(wallet = 'admin') {
  useApp.setState({ wallet }); const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); const changed = vi.fn();
  await act(async () => root.render(<AdminFeedbackReview wallet="admin" reportId="report" onChanged={changed} />));
  const dispose = async () => { await act(async () => root.unmount()); host.remove(); }; cleanups.push(dispose);
  const click = async (label: string) => { const b = [...host.querySelectorAll('button')].find(b => b.textContent === label)!; await act(async () => b.click()); };
  const field = async (name: string, value: string) => {
    const el = host.querySelector(`[aria-label="${name}"]`)!;
    await act(async () => {
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(el,value); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input',{bubbles:true}));
    });
  };
  return { host, changed, click, field, unmount: async () => { cleanups.splice(cleanups.indexOf(dispose),1); await dispose(); } };
}
afterEach(async () => { for (const dispose of cleanups.splice(0)) await dispose(); localStorage.clear(); get.mockReset(); post.mockReset(); });
it('status review defaults to no award and never posts on opening or editing', async () => {
  get.mockResolvedValue(thread()); post.mockResolvedValue({ points: 0, delta: 0 }); const view = await mount();
  await view.field('Review status', 'accepted'); await view.field('Review reason','Verified reproduction is still pending.');
  expect(post).not.toHaveBeenCalled(); await view.click('SAVE CUSTOM REVIEW');
  expect(post.mock.calls[0]?.[1]).toMatchObject({ status:'accepted',award:'none',verdict:'unverified',expectedRevision:4 });
  expect(view.changed).toHaveBeenCalledTimes(1);
});
it('replays the exact explicit award after a lost response and remount, without automatically sending', async () => {
  get.mockResolvedValue(thread()); post.mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValue({ points: 30, delta: 30 }); let view = await mount();
  await view.click('ACCEPT & AWARD +30 POINTS'); const input = post.mock.calls[0]?.[1]; await view.unmount(); view = await mount();
  expect(post).toHaveBeenCalledTimes(1); expect(view.host.querySelector<HTMLSelectElement>('[aria-label="Explicit reward"]')?.disabled).toBe(true);
  await view.click('RETRY SAVED REVIEW'); expect(post.mock.calls[1]?.[1]).toEqual(input);
});
it('refreshes a stale review and requires another deliberate confirmation using the new revision', async () => {
  get.mockResolvedValueOnce(thread(4)).mockResolvedValue(thread(9)); post.mockRejectedValueOnce(new ApiError(409,'changed','FEEDBACK_REVIEW_STALE')).mockResolvedValue({ points:0,delta:0 });
  const view = await mount(); await view.field('Review reason','Inspected report.'); await view.click('SAVE CUSTOM REVIEW');
  expect(view.host.textContent).toContain('review your choices and confirm again'); expect(post).toHaveBeenCalledTimes(1);
  await view.click('SAVE CUSTOM REVIEW'); expect(post.mock.calls[1]?.[1].expectedRevision).toBe(9); expect(post.mock.calls[1]?.[1].requestId).not.toBe(post.mock.calls[0]?.[1].requestId);
});
it('keeps awards disabled without a canonical issue and when the canonical issue has merged', async () => {
  for (const issue of [null,{...linked,status:'merged',mergedInto:'replacement'}]) {
    get.mockResolvedValue(thread(4,issue as typeof linked|null)); const view = await mount();
    const choice = view.host.querySelector<HTMLOptionElement>('option[value="first_actionable"]')!; expect(choice.disabled).toBe(true);
    expect(post).not.toHaveBeenCalled(); await view.unmount();
  }
});
it('does not read or mutate with the wrong account and fences an in-flight review after account switching', async () => {
  get.mockResolvedValue(thread()); let view = await mount('other'); expect(get).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled(); await view.unmount();
  let resolve!: (value: unknown) => void; post.mockImplementation(() => new Promise(r => {resolve=r})); view = await mount(); await view.field('Review reason','Private staff review.');
  const button = [...view.host.querySelectorAll('button')].find(b => b.textContent==='SAVE CUSTOM REVIEW')!; await act(async()=>button.click());
  await act(async()=>useApp.setState({wallet:'other'})); expect(post.mock.calls[0]?.[2].signal.aborted).toBe(true);
  await act(async()=>resolve({points:0,delta:0})); expect(view.changed).not.toHaveBeenCalled(); expect(view.host.textContent).toContain('ACCOUNT CHANGED');
});
it('blocks a formerly valid award when refreshed canonical state is merged, preserving choices without sending again', async () => {
  get.mockResolvedValueOnce(thread()).mockResolvedValue(thread(8,{...linked,status:'merged',mergedInto:'replacement'} as typeof linked));
  post.mockRejectedValue(new ApiError(409,'issue changed','FEEDBACK_REVIEW_STALE'));
  const view = await mount(); await view.field('Reward importance','high');
  await view.click('ACCEPT & AWARD +60 POINTS');
  expect(post).toHaveBeenCalledTimes(1);
  const button = [...view.host.querySelectorAll('button')].find(b=>b.textContent==='ACCEPT & AWARD +60 POINTS')!;
  expect(button.disabled).toBe(true); expect(view.host.textContent).toContain('This issue was merged');
});

it('keeps Fixed as the displayed lifecycle while an explicit reward review preserves its stored Accepted status', async () => {
  get.mockResolvedValue({ report: { ...thread().report, status: 'fixed', fixedAt: '2026-09-07' } }); post.mockResolvedValue({ points: 0, delta: 0 });
  const view = await mount(); expect(view.host.textContent).toContain('REPORT STATUS: FIXED'); expect(view.host.querySelector('[aria-label="Review status"]')).toBeNull();
  await view.field('Review reason', 'Verified existing fixed report'); await view.click('SAVE CUSTOM REVIEW');
  expect(post.mock.calls[0]?.[1]).toMatchObject({ status: 'accepted', award: 'none' });
});

it('restores the saved accepted review and previews only the additional points over an existing reward', async () => {
  get.mockResolvedValue({ report: { ...thread().report, status: 'accepted', importance: 'medium', points: 30, basePoints: 10, bonusPoints: 20, verificationVerdict: 'actionable' } });
  post.mockResolvedValue({ points: 60, delta: 30 });
  const view = await mount();
  expect(view.host.querySelector<HTMLSelectElement>('[aria-label="Review status"]')?.value).toBe('accepted');
  expect(view.host.querySelector<HTMLSelectElement>('[aria-label="Verification verdict"]')?.value).toBe('actionable');
  await view.field('Reward importance', 'high');
  expect(view.host.textContent).toContain('60 total points');
  await view.click('AWARD +30 POINTS');
  expect(view.host.textContent).toContain('60 TOTAL POINTS · 30 ADDED');
});

it('keeps existing points on Duplicate and Reject actions and shows a daily-limit refusal without claiming success', async () => {
  get.mockResolvedValue({ report: { ...thread().report, points: 30, basePoints: 10, bonusPoints: 20 } });
  post.mockRejectedValue(new ApiError(409, 'Rewarded report limit reached for that submission day', 'FEEDBACK_REWARD_DAY_LIMIT'));
  const view = await mount();
  await view.click('DUPLICATE');
  expect(post.mock.calls[0]?.[1]).toMatchObject({ status: 'duplicate', award: 'none' });
  expect(view.host.textContent).toContain('Rewarded report limit reached');
  expect(view.host.textContent).not.toContain('REVIEW SAVED');
  await view.click('REJECT');
  expect(post.mock.calls[1]?.[1]).toMatchObject({ status: 'rejected', award: 'none', verdict: 'not_actionable' });
});

it('routes historical reports through their original rating contract and displays the replacement total', async () => {
  get.mockResolvedValue({ report: { ...thread().report, id: 'report', rewardPolicyVersion: 1, status: 'accepted', importance: 'medium', points: 30, basePoints: 10, bonusPoints: 20 } });
  post.mockResolvedValue({ points: 60 }); const view = await mount();
  expect(view.host.textContent).toContain('HISTORICAL RATING');
  await view.field('Historical reward importance', 'high');
  expect(view.host.textContent).toContain('AFTER SAVING: 60 TOTAL POINTS');
  await view.click('SAVE HISTORICAL RATING');
  expect(post.mock.calls[0]?.[0]).toBe('/admin/tester/feedback/report/rate');
  expect(post.mock.calls[0]?.[1]).toMatchObject({ status: 'accepted', importance: 'high' });
});


it('accepts an unlinked report and awards the displayed default with one click and no forms', async () => {
  get.mockResolvedValue(thread(4, null)); post.mockResolvedValue({ points: 30, delta: 30 });
  const view = await mount();
  expect(post).not.toHaveBeenCalled();
  expect([...view.host.querySelectorAll('details')].every(d => !d.open)).toBe(true);
  await view.click('ACCEPT & AWARD +30 POINTS');
  expect(post).toHaveBeenCalledTimes(1);
  expect(post.mock.calls[0]?.[1]).toMatchObject({ expectedRevision: 4, status: 'accepted', verdict: 'actionable',
    award: 'first_actionable', importance: 'medium', preparePrivateIssue: true });
  expect(post.mock.calls[0]?.[1].verificationEvidence).not.toMatch(/reproduced/i);
  expect(view.host.textContent).toContain('30 TOTAL POINTS · 30 ADDED');
});

it('does not manufacture another award when reopening an accepted paid report', async () => {
  get.mockResolvedValue({ report: { ...thread().report, status: 'accepted', importance: 'high', points: 60, basePoints: 10, bonusPoints: 50 } });
  const view = await mount(); const button = [...view.host.querySelectorAll('button')].find(b => b.textContent === 'POINTS AWARDED')!;
  expect(button.disabled).toBe(true); await view.click('POINTS AWARDED'); expect(post).not.toHaveBeenCalled();
  expect(view.host.querySelector<HTMLSelectElement>('[aria-label="Reward importance"]')?.value).toBe('high');
});

it('coalesces rapid acceptance clicks while keeping the exact saved decision recoverable', async () => {
  get.mockResolvedValue(thread(4, null)); let resolve!: (value: unknown) => void;
  post.mockImplementation(() => new Promise(r => { resolve = r; }));
  const view = await mount(); const button = [...view.host.querySelectorAll('button')].find(b => b.textContent === 'ACCEPT & AWARD +30 POINTS')!;
  await act(async () => { button.click(); button.click(); });
  expect(post).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem('pkw:feedback-review:v1:["admin","report"]')).toContain('preparePrivateIssue');
  await act(async () => resolve({ points: 30, delta: 30 })); expect(view.changed).toHaveBeenCalledTimes(1);
});

it('still supports a reasoned useful-evidence award through optional custom review', async () => {
  get.mockResolvedValue(thread()); post.mockResolvedValue({ points: 20, delta: 20 }); const view = await mount();
  await view.field('Review status', 'duplicate'); await view.field('Verification verdict', 'actionable');
  await view.field('Explicit reward', 'useful_evidence'); await view.field('Verification evidence', 'Additional capture isolates the missing animation.');
  await view.field('Review reason', 'Useful extra evidence for the existing issue.');
  await view.click('SAVE CUSTOM REVIEW');
  expect(post.mock.calls[0]?.[1]).toMatchObject({ status: 'duplicate', award: 'useful_evidence' });
  expect(post.mock.calls[0]?.[1]).not.toHaveProperty('preparePrivateIssue');
});


it('accepts historical reports in one click using their original rating endpoint and existing importance', async () => {
  get.mockResolvedValue({ report: { ...thread().report, id: 'report', rewardPolicyVersion: 1, status: 'new', importance: 'high', points: 10, basePoints: 10, bonusPoints: 0 } });
  post.mockResolvedValue({ points: 60 }); const view = await mount();
  await view.click('ACCEPT & AWARD +50 POINTS');
  expect(post).toHaveBeenCalledTimes(1);
  expect(post.mock.calls[0]?.[0]).toBe('/admin/tester/feedback/report/rate');
  expect(post.mock.calls[0]?.[1]).toMatchObject({ status: 'accepted', importance: 'high', note: '' });
  expect(view.host.textContent).toContain('60 TOTAL POINTS');
});


it('recovers an exact saved reward even when the separate report refresh is unavailable', async () => {
  get.mockResolvedValue(thread()); post.mockRejectedValueOnce(new Error('Response lost')).mockResolvedValue({ points: 30, delta: 30 });
  let view = await mount(); await view.click('ACCEPT & AWARD +30 POINTS'); const input = post.mock.calls[0]?.[1];
  await view.unmount(); get.mockRejectedValue(new Error('Read unavailable')); view = await mount();
  await view.click('RETRY SAVED REVIEW'); expect(post.mock.calls[1]?.[1]).toEqual(input);
  expect(view.changed).toHaveBeenCalledTimes(1);
});


it('keeps a higher historical reward intact without rendering a negative award label', async () => {
  get.mockResolvedValue({ report: { ...thread().report, id: 'report', rewardPolicyVersion: 1, status: 'accepted', importance: null, points: 70, basePoints: 10, bonusPoints: 60 } });
  const view = await mount(); const button = [...view.host.querySelectorAll('button')].find(b => b.textContent === 'EXISTING REWARD IS HIGHER')!;
  expect(button.disabled).toBe(true); expect(view.host.textContent).not.toContain('+-'); expect(post).not.toHaveBeenCalled();
});

it('requires a fresh reward total before promising a one-click point amount', async () => {
  get.mockResolvedValueOnce({ report: { ...thread().report, basePoints: undefined, bonusPoints: undefined } }).mockResolvedValue(thread());
  post.mockResolvedValue({points:30,delta:30});
  const view = await mount(); expect(view.host.textContent).toContain('Reward totals are unavailable');
  await view.click('REFRESH REWARD'); await view.click('ACCEPT & AWARD +30 POINTS'); expect(post).toHaveBeenCalledTimes(1);
});

it.each([1, 2])('gives policy %s accepted reports one prominent fixed action and keeps rewards secondary', async (rewardPolicyVersion) => {
  const report = { ...thread().report, id: 'report', status: 'accepted', importance: 'medium', points: 30, basePoints: 10, bonusPoints: 20, rewardPolicyVersion };
  get.mockResolvedValue({ report }); post.mockImplementation(async () => { get.mockResolvedValue({ report: { ...report, revision: 5, status: 'fixed', fixedAt: '2026-09-09' } }); return { revision: 5 }; });
  const view = await mount(); const button = [...view.host.querySelectorAll('button')].find(b => b.textContent === 'MARK FIXED')!;
  expect(button.closest('details')).toBeNull(); expect(view.host.querySelectorAll('[aria-label="fixed report action"]')).toHaveLength(1);
  expect([...view.host.querySelectorAll('button')].find(b => b.textContent === 'POINTS AWARDED')!.closest('details')).not.toBeNull();
  await view.click('MARK FIXED');
  expect(post.mock.calls[0]?.slice(0, 2)).toEqual(['/admin/tester/feedback/report/fixed', { requestId: expect.any(String), expectedRevision: 4, fixed: true, reason: 'The team has marked this report as fixed.' }]);
  expect(view.host.textContent).toContain('MARKED FIXED'); expect(view.host.textContent).toContain('30 POINTS ALREADY AWARDED');
  expect(view.host.querySelector('[aria-label="fixed reason"]')?.closest('details')?.open).toBe(false);
  await view.field('fixed reason', 'The reproduction still occurs.'); await view.click('REVIEW: REOPEN AS ACCEPTED'); await view.click('CONFIRM: REOPEN AS ACCEPTED');
  expect(post.mock.calls[1]?.[1]).toMatchObject({ fixed: false, expectedRevision: 5 });
});

it('blocks review while fixed recovery is pending and recovers even when a refreshed snapshot is unavailable', async () => {
  const report = { ...thread().report, status: 'accepted', points: 30, basePoints: 10, bonusPoints: 20 };
  get.mockResolvedValue({ report }); post.mockRejectedValueOnce(Error('Response lost')).mockResolvedValue({ revision: 5 });
  const view = await mount(); await view.click('MARK FIXED');
  expect([...view.host.querySelectorAll('button')].find(b => b.textContent === 'ACCEPT WITHOUT POINTS')!.disabled).toBe(true);
  get.mockRejectedValue(Error('Read unavailable'));
  await view.click('RETRY SAVED REPORT ACTION');
  expect(post.mock.calls[1]?.[1]).toEqual(post.mock.calls[0]?.[1]); expect(view.changed).toHaveBeenCalledTimes(1);
  expect(view.host.textContent).toContain('MARKED FIXED');
});

it('requires explicit acceptance for New reports and prevents fixing before a saved review is recovered', async () => {
  get.mockResolvedValue(thread()); post.mockRejectedValueOnce(Error('Response lost'));
  const view = await mount(); expect([...view.host.querySelectorAll('button')].some(b => b.textContent === 'MARK FIXED')).toBe(false);
  await view.click('ACCEPT & AWARD +30 POINTS');
  expect([...view.host.querySelectorAll('button')].some(b => b.textContent === 'MARK FIXED')).toBe(false);
  expect(view.host.textContent).toContain('RETRY SAVED REVIEW');
});

it('restores the accepted historical status after quick acceptance so a later rating cannot undo it', async () => {
  const report = { ...thread().report, id: 'report', rewardPolicyVersion: 1, status: 'new', points: 10, basePoints: 10, bonusPoints: 0 };
  get.mockResolvedValue({ report });
  post.mockImplementationOnce(async () => { get.mockResolvedValue({ report: { ...report, status: 'accepted', importance: 'medium', points: 30, bonusPoints: 20, revision: 5 } }); return { points: 30 }; }).mockResolvedValue({ points: 60 });
  const view = await mount(); await view.click('ACCEPT & AWARD +20 POINTS');
  expect(view.host.querySelector<HTMLSelectElement>('[aria-label="Historical review status"]')?.value).toBe('accepted');
  await view.field('Historical reward importance', 'high'); await view.click('SAVE HISTORICAL RATING');
  expect(post.mock.calls[1]?.[1]).toMatchObject({ status: 'accepted', importance: 'high' });
});
