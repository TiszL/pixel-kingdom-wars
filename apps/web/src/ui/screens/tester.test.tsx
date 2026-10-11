/** @vitest-environment happy-dom */
import { act } from 'react';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot } from 'react-dom/client';
import { PLAYTEST_CAMPAIGN, TESTER_DAILY } from '@shardkeep/shared';
import { FEEDBACK_ISSUES } from '@shardkeep/shared/feedback';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../lib/events';
import { useApp } from '../../state/store';
import { resetTesterMeForTests } from '../testerDaily';
import { FEEDBACK_DELIVERY_TIMEOUT_MS } from '../feedback/feedbackReportDelivery';

const apiGet = vi.fn();
const apiPostRaw = vi.fn();
const apiBinary = vi.fn();
const apiBlob = vi.fn();
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: { ...actual.api, get: (...a: unknown[]) => apiGet(...a), postRaw: (...a: unknown[]) => apiPostRaw(...a), postBinary: (...a: unknown[]) => apiBinary(...a), getBlob: (...a: unknown[]) => apiBlob(...a) } };
});
vi.mock('../../lib/analytics', async (orig) => ({ ...(await orig<typeof import('../../lib/analytics')>()), track: vi.fn() }));
vi.mock('../feedback/FeedbackThread', () => ({ default: ({ mode, reportId, onBack }: { mode: string; reportId: string; onBack: () => void }) =>
  <section aria-label="Private conversation"><span>{mode} thread {reportId}</span><button onClick={onBack}>BACK TO REPORTS</button></section> }));

import TesterScreen, {
  BOARD_PREVIEW_ROWS, campaignDayLabel, earnedToast, groupMilestones, pointBuckets, SITE_LEADERBOARD_URL, todayLedger,
} from './tester';

const ms = (key: string, category: string, points: number, achievedAt: string | null) =>
  ({ key, category, title: key.replace(/_/g, ' '), hint: 'h', points, achievedAt });

/** The M35 /tester/me shape: milestones plus today's daily rows, referrals
 *  and the listed flag. `over` lets a case drop or change one part. */
const meDto = (over: Record<string, unknown> = {}) => ({
  wallet: 'AAAA…AAAA', name: null, points: 55, rank: 2, milestonePoints: 30, feedbackPoints: 10, feedbackCount: 1,
  dailyPoints: 12, referralPoints: 3,
  milestones: [ms('signed_in', 'first_steps', 5, '2026-08-21T00:00:00Z'), ms('raid_attack', 'combat', 25, '2026-08-21T01:00:00Z'), ms('land_bought', 'web3', 100, null)],
  justEarned: [{ key: 'raid_attack', points: 25 }],
  listed: true,
  daily: {
    todayPoints: 12, streakDays: 3,
    byKey: [{ key: 'played', count: 1, points: 2 }, { key: 'pvp_win', count: 5, points: 10 }, { key: 'streak_3', count: 1, points: 5 }],
    catalog: { sources: TESTER_DAILY.sources, streaks: TESTER_DAILY.streaks },
  },
  referrals: { invited: 2, qualified: 1, activeToday: 1 },
  ...over,
});

describe('tester screen helpers', () => {
  it('groups milestones by category in the catalog order with earned/total points', () => {
    // WHY: the checklist must read top-down the way a new tester plays — first
    // steps before web3 — and each header must show how much of the category
    // is already banked, or the board feels like an undifferentiated list.
    const groups = groupMilestones([
      ms('withdrawal_sent', 'web3', 120, null), ms('signed_in', 'first_steps', 5, '2026-08-21T00:00:00Z'),
      ms('raid_attack', 'combat', 25, '2026-08-21T00:00:00Z'), ms('raid_star', 'combat', 15, null),
    ]);
    expect(groups.map((g) => g.category)).toEqual(['first_steps', 'combat', 'web3']);
    expect(groups[1]).toMatchObject({ label: 'COMBAT', earned: 25, total: 40 });
  });

  it('labels daily and referral categories from TESTER_DAILY and never drops an unknown one', () => {
    // WHY (D-103): the grouping used to silently drop any category it did not
    // know, so a catalog entry the server added would be invisible in-game —
    // a milestone nobody could aim for. Known categories keep their order;
    // daily and referral take their labels from the shared catalog; anything
    // newer is appended rather than hidden.
    const groups = groupMilestones([
      ms('future_thing', 'brand_new', 9, null), ms('referral_active', 'referral', 3, null),
      ms('played', 'daily', 2, '2026-09-04T00:00:00Z'), ms('signed_in', 'first_steps', 5, null),
    ]);
    expect(groups.map((g) => g.category)).toEqual(['first_steps', 'daily', 'referral', 'brand_new']);
    expect(groups[1]!.label).toBe(TESTER_DAILY.categoryLabels.daily.toUpperCase());
    expect(groups[2]!.label).toBe(TESTER_DAILY.categoryLabels.referral.toUpperCase());
    expect(groups[3]!.label).toBe('BRAND_NEW');
  });

  it('words the earned toast as points first, then the first milestone, then "+N more"', () => {
    const titles = new Map([['raid_attack', 'Attack another player'], ['raid_star', 'Earn a star']]);
    expect(earnedToast([], titles)).toBeNull();
    expect(earnedToast([{ key: 'raid_attack', points: 25 }], titles)).toBe('+25 TESTER POINTS — ATTACK ANOTHER PLAYER');
    expect(earnedToast([{ key: 'raid_attack', points: 25 }, { key: 'raid_star', points: 15 }], titles))
      .toBe('+40 TESTER POINTS — ATTACK ANOTHER PLAYER +1 MORE');
  });

  it('lists every daily source in the ledger with what it paid today, capped sources as count/cap', () => {
    // WHY: the ledger's job is "what is left today" — an open source must be
    // listed as much as a fired one, and a capped source (PvP wins, up to 20)
    // must show its count so the player knows how much room is left.
    const { rows, streaks } = todayLedger(meDto() as never);
    expect(rows).toHaveLength(TESTER_DAILY.sources.length);
    expect(rows.find((r) => r.key === 'played')).toMatchObject({ done: true, count: 1, earned: 2, cap: 1 });
    expect(rows.find((r) => r.key === 'pvp_win')).toMatchObject({ done: true, count: 5, earned: 10, cap: 20 });
    expect(rows.find((r) => r.key === 'chat_sent')).toMatchObject({ done: false, count: 0, earned: 0, unit: 1 });
    expect(streaks.find((s) => s.key === 'streak_3')).toMatchObject({ done: true, earned: 5 });
    expect(streaks.find((s) => s.key === 'streak_7')).toMatchObject({ done: false });
    // An API cut with daily rows but no catalog falls back to the shared table.
    const bare = todayLedger({ daily: { todayPoints: 2, streakDays: 1, byKey: [{ key: 'played', count: 1, points: 2 }] } });
    expect(bare.rows).toHaveLength(TESTER_DAILY.sources.length);
    expect(bare.rows[0]).toMatchObject({ key: 'played', done: true });
  });

  it('shows the day counter only inside a set window and says TBA without one', () => {
    // WHY (D-103): there is no start date yet; the window is optional env and
    // must only change presentation. No window → TBA (owner 2026-09-04), never a fake countdown.
    expect(campaignDayLabel(undefined)).toBe('TBA');
    expect(campaignDayLabel({ name: 'Founding Kingdoms', totalDays: 14, startAt: null, endAt: null, dayIndex: null })).toBe('TBA');
    expect(campaignDayLabel({ name: 'Founding Kingdoms', totalDays: 14, startAt: 's', endAt: 'e', dayIndex: 3 })).toBe('DAY 3 OF 14');
    expect(campaignDayLabel({ name: 'Founding Kingdoms', totalDays: 14, startAt: 's', endAt: 'e', dayIndex: 0 })).toBe('OPENS SOON');
    expect(campaignDayLabel({ name: 'Founding Kingdoms', totalDays: 14, startAt: 's', endAt: 'e', dayIndex: 15 })).toBe('CLOSED');
  });

  it('splits the total into four buckets and never invents referral points the API did not send', () => {
    const full = pointBuckets(meDto() as never);
    expect(full.map((b) => b.label)).toEqual(['MILESTONES', 'DAILY', 'REFERRALS', 'FEEDBACK']);
    expect(full.map((b) => b.value)).toEqual(['30 PTS', '12 PTS', '3 PTS', '10 PTS']);
    expect(full[1]!.sub).toBe('+12 TODAY');
    expect(full[2]!.sub).toBe('2 INVITED · 1 ACTIVE TODAY');
    // Without the all-time fields, DAILY is what the total cannot otherwise
    // explain (total − milestones − feedback) and REFERRALS shows the count.
    const partial = pointBuckets(meDto({ dailyPoints: undefined, referralPoints: undefined }) as never);
    expect(partial[1]!.value).toBe('15 PTS');
    expect(partial[2]!.value).toBe('1 QUALIFIED');
  });
});

describe('tester screen', () => {
  beforeEach(() => {
    apiGet.mockReset(); apiPostRaw.mockReset(); apiBinary.mockReset(); apiBlob.mockReset();
    resetTesterMeForTests();
    useApp.setState({ screen: 'tester', wallet: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', authed: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    resetTesterMeForTests();
    useApp.setState({ screen: 'loading', wallet: null, authed: false });
    localStorage.clear();
  });

  const mount = async (): Promise<{ host: HTMLDivElement; unmount: () => Promise<void> }> => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<TesterScreen />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
  };

  it('shows reporter-visible rejected and fixed outcomes in My reports without hiding replies or rewards', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/tester/me') return Promise.resolve(meDto());
      if (path.startsWith('/tester/issues?')) return Promise.resolve({ issues: [] });
      if (path === '/tester/feedback/page') return Promise.resolve({ feedback: [
        { id: 'rejected-report', title: 'Rejected report', body: 'Original rejected description', category: 'bug', status: 'rejected', points: 0, importance: null, createdAt: '2026-09-09T00:00:00Z' },
        { id: 'fixed-report', title: 'Solved report', body: 'Original fixed description', category: 'bug', status: 'accepted', fixedAt: '2026-09-09T01:00:00Z', points: 30, importance: 'medium', createdAt: '2026-09-09T00:00:00Z' },
      ] });
      return Promise.resolve({ entries: [], totals: { testers: 0, points: 0, feedback: 0 } });
    });
    const { host, unmount } = await mount();
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'FEEDBACK')!.click());
    expect(host.textContent).toContain('REJECTED'); expect(host.textContent).toContain('FIXED');
    expect(host.textContent).toContain('Original fixed description'); expect(host.textContent).toContain('+30');
    const open = [...host.querySelectorAll('button')].filter(b => b.textContent === 'OPEN REPORT'); expect(open).toHaveLength(2);
    await act(async () => open[1]!.click()); expect(host.textContent).toContain('reporter thread fixed-report'); await unmount();
  });

  it('renders progress from the server, toasts newly earned points once, and submits feedback with context', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/tester/me') return Promise.resolve(meDto());
      if (path === '/tester/feedback/page') return Promise.resolve({ feedback: [] });
      if (path === '/tester/leaderboard') return Promise.resolve({ entries: [], totals: { testers: 0, points: 0, feedback: 0 } });
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    // Policy 2 deliberately replaces automatic submission awards with review.
    apiPostRaw.mockResolvedValue({ id: 'f1', basePoints: 0, dailyRemaining: 7 });
    const toasts: string[] = [];
    const off = bus.on('ui:toast', (t) => { toasts.push(t.msg); });

    const { host, unmount } = await mount();

    expect(host.textContent).toContain('55');
    expect(host.textContent).toContain('RANK #2');
    expect(host.querySelector('[data-testid="milestone-raid_attack"]')?.textContent).toContain('✓');
    expect(host.querySelector('[data-testid="milestone-land_bought"]')?.textContent).toContain('○');
    expect(toasts).toEqual(['+25 TESTER POINTS — RAID ATTACK']);

    // FOUR buckets (D-103), the campaign card with the reward sentence and no
    // day counter (no window set), TODAY's ledger and the streak line.
    expect(host.querySelector('[data-testid="bucket-milestones"]')?.textContent).toContain('30 PTS');
    expect(host.querySelector('[data-testid="bucket-daily"]')?.textContent).toContain('12 PTS');
    expect(host.querySelector('[data-testid="bucket-referrals"]')?.textContent).toContain('3 PTS');
    expect(host.querySelector('[data-testid="bucket-feedback"]')?.textContent).toContain('10 PTS');
    expect(host.textContent).toContain(PLAYTEST_CAMPAIGN.name.toUpperCase());
    expect(host.textContent).toContain('Open CAMPAIGNS for current dates, independent scores, eligibility and rewards. Lifetime points continue throughout.');
    expect(host.querySelector('[data-testid="campaign-day"]')?.textContent).toBe('TBA');
    expect(host.querySelector('[data-testid="daily-played"]')?.textContent).toContain('✓');
    expect(host.querySelector('[data-testid="daily-chat_sent"]')?.textContent).toContain('○');
    expect(host.querySelector('[data-testid="daily-pvp_win"]')?.parentElement?.textContent).toContain('5/20 · +10');
    expect(host.querySelector('[data-testid="streak-line"]')?.textContent).toContain('3-DAY STREAK');
    expect(host.querySelector('[data-testid="streak-line"]')?.textContent).toContain('7-DAY STREAK PAYS +15');
    // A listed wallet gets no "how to get listed" line; retired copy is gone.
    expect(host.querySelector('[data-testid="listed-hint"]')).toBeNull();
    expect(host.textContent).not.toMatch(/rewarded after the playtest|pays once/i);

    const feedbackTab = [...host.querySelectorAll('button')].find((b) => b.textContent === 'FEEDBACK')!;
    await act(async () => feedbackTab.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => { await Promise.resolve(); });
    const title = host.querySelector('input[aria-label="Feedback title"]') as HTMLInputElement;
    const body = host.querySelector('textarea[aria-label="Feedback details"]') as HTMLTextAreaElement;
    const setValue = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => { setValue(title, 'Vault chip'); setValue(body, 'The SHIELDS chip shows twice after upgrading.'); });
    const send = [...host.querySelectorAll('button')].find((b) => b.textContent === 'SEND FEEDBACK')!;
    await act(async () => send.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(apiPostRaw).toHaveBeenCalledTimes(1);
    const [path, payload] = apiPostRaw.mock.calls[0] as [string, { category: string; title: string; body: string; context: Record<string, unknown> }];
    expect(path).toBe('/tester/feedback');
    expect(payload).toMatchObject({ category: 'bug', title: 'Vault chip' });
    expect(payload).toHaveProperty('requestId', expect.any(String));
    expect(payload.context).toMatchObject({ screen: 'tester' });
    expect(toasts.at(-1)).toBe('FEEDBACK SENT — THANK YOU');
    expect(host.querySelector('[aria-label="Private conversation"]')?.textContent).toContain('reporter thread f1');
    expect(host.querySelector('[data-viewport-safe]')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Private conversation"] button')!.click());
    expect(host.textContent).toContain('Points are awarded after review');
    expect(host.querySelector('input[aria-label="Feedback title"]')).not.toBeNull();

    off();
    await unmount();
  });

  it.each(['lost', 'stalled'] as const)('reopens a %s report response with its original request and context instead of submitting a duplicate', async (response) => {
    apiGet.mockImplementation((path: string) => Promise.resolve(path === '/tester/me' ? meDto() : path.startsWith('/tester/issues?') ? { issues: [] } : { feedback: [] }));
    if (response === 'stalled') { vi.useFakeTimers(); apiPostRaw.mockReturnValueOnce(new Promise(() => undefined)); }
    else apiPostRaw.mockRejectedValueOnce(new Error('Lost response'));
    apiPostRaw.mockResolvedValueOnce({ id: 'recovered-report', basePoints: 0, dailyRemaining: 7 });
    const open = async (host: HTMLElement, label: string): Promise<void> => {
      await act(async () => [...host.querySelectorAll('button')].find((node) => node.textContent === label)!.click());
      await act(async () => { await Promise.resolve(); });
    };
    const first = await mount(); await open(first.host, 'FEEDBACK');
    await act(async () => {
      const title = first.host.querySelector<HTMLInputElement>('[aria-label="Feedback title"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, 'Saved report');
      title.dispatchEvent(new Event('input', { bubbles: true }));
      const body = first.host.querySelector<HTMLTextAreaElement>('[aria-label="Feedback details"]')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(body, 'This report must only be created once.');
      body.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await open(first.host, 'SEND FEEDBACK'); const original = apiPostRaw.mock.calls[0]![1];
    if (response === 'stalled') {
      expect(first.host.textContent).toContain('SENDING…');
      await act(async () => vi.advanceTimersByTimeAsync(FEEDBACK_DELIVERY_TIMEOUT_MS));
      expect(first.host.textContent).toContain('RETRY TO CONFIRM THE SAME REPORT');
    }
    expect(first.host.textContent).toContain('RETRY SAVED REPORT');
    await first.unmount(); useApp.setState({ selectedBaseId: 'different-base' });
    const second = await mount(); await open(second.host, 'FEEDBACK');
    expect(apiPostRaw).toHaveBeenCalledTimes(1);
    expect(second.host.querySelector<HTMLInputElement>('[aria-label="Feedback title"]')?.value).toBe('Saved report');
    expect(second.host.querySelector<HTMLInputElement>('[aria-label="Feedback title"]')?.disabled).toBe(true);
    await open(second.host, 'RETRY SAVED REPORT');
    expect(apiPostRaw.mock.calls[1]![1]).toEqual(original);
    expect(second.host.textContent).toContain('reporter thread recovered-report');
    await second.unmount(); useApp.setState({ selectedBaseId: null });
  });

  it('keeps selected screenshots local until Send, then recovers the existing report after an upload failure', async () => {
    vi.useFakeTimers();
    apiGet.mockImplementation((path: string) => Promise.resolve(path === '/tester/me' ? meDto({ justEarned: [] }) : path.startsWith('/tester/issues?') ? { issues: [] } : { feedback: [] }));
    apiPostRaw.mockResolvedValue({ id: '00000000-0000-4000-8000-000000000104', basePoints: 0 });
    const attachmentId = '00000000-0000-4000-8000-000000000001';
    apiBinary.mockRejectedValueOnce(new Error('Image upload interrupted')).mockResolvedValue({ id: attachmentId });
    apiBlob.mockResolvedValue(new Blob(['image']));
    vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:local'); vi.spyOn(URL,'revokeObjectURL').mockImplementation(() => undefined);
    const view = await mount();
    const click = async (label: string) => { const b = [...view.host.querySelectorAll('button')].find(n => n.textContent === label)!; await act(async () => b.click()); };
    await click('FEEDBACK');
    await act(async () => {
      const title = view.host.querySelector<HTMLInputElement>('[aria-label="Feedback title"]')!;
      const body = view.host.querySelector<HTMLTextAreaElement>('[aria-label="Feedback details"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(title,'Screenshot report'); title.dispatchEvent(new Event('input',{bubbles:true}));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(body,'Here is the private screenshot.'); body.dispatchEvent(new Event('input',{bubbles:true}));
      const picker = view.host.querySelector('input[type=file]')!; Object.defineProperty(picker,'files',{configurable:true,value:[new File(['image'],'photo.png',{type:'image/png'})]}); picker.dispatchEvent(new Event('change',{bubbles:true}));
    });
    // A slow device can complete the independent suggestion read before Send;
    // its response must not depend on racing through the upload interaction.
    await act(async () => vi.advanceTimersByTimeAsync(FEEDBACK_ISSUES.searchDebounceMs));
    expect(apiGet).toHaveBeenCalledWith('/tester/issues?query=Screenshot+report&category=bug', expect.any(Object));
    expect(view.host.textContent).toContain('No matching published issue.');
    expect(apiBinary).not.toHaveBeenCalled(); expect(apiPostRaw).not.toHaveBeenCalled();
    await click('SEND FEEDBACK'); expect(apiPostRaw).toHaveBeenCalledTimes(1); expect(view.host.textContent).toContain('IMAGE UPLOAD INTERRUPTED');
    await click('RETRY SCREENSHOTS');
    expect(apiPostRaw.mock.calls.map(c => c[0])).toEqual(['/tester/feedback','/tester/feedback/00000000-0000-4000-8000-000000000104/replies']);
    expect(apiBinary.mock.calls[0]?.[0]).toBe(apiBinary.mock.calls[1]?.[0]);
    expect(apiPostRaw.mock.calls[1]?.[1]).toMatchObject({body:'',attachmentIds:[attachmentId]});
    expect(view.host.textContent).toContain('reporter thread 00000000-0000-4000-8000-000000000104'); await view.unmount();
  });

  it('opens a private evidence form without creating a thread and requires explicit recurrence before retrying its exact send', async () => {
    const id = '00000000-0000-4000-8000-000000000009';
    apiGet.mockImplementation((path: string) => Promise.resolve(path === '/tester/me' ? meDto({justEarned:[]}) : path.startsWith('/tester/issues') ? {issues:[{id,title:'Resolved issue',category:'bug',status:'fixed',summary:'Published summary',workaround:null,fixedRelease:'release',affectedPlayerCount:1}]} : {feedback:[]}));
    apiPostRaw.mockRejectedValueOnce(new Error('Lost evidence response')).mockResolvedValueOnce({reportId:'existing-evidence-thread',basePoints:0,reused:true});
    const view = await mount();
    const click = async(label:string) => { const b=[...view.host.querySelectorAll('button')].find(b=>b.textContent===label)!; await act(async()=>b.click()); };
    await click('FEEDBACK'); await act(async()=>{await new Promise(resolve=>setTimeout(resolve,300))});
    await click('Resolved issue'); await click('ADD PRIVATE EVIDENCE'); expect(apiPostRaw).not.toHaveBeenCalled();
    const body=view.host.querySelector<HTMLTextAreaElement>('[aria-label="Feedback details"]')!;
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(body,'It happened again after the fix.');body.dispatchEvent(new Event('input',{bubbles:true}))});
    await click('SEND PRIVATE EVIDENCE'); expect(apiPostRaw).not.toHaveBeenCalled();
    await act(async()=>view.host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
    await click('SEND PRIVATE EVIDENCE'); const original=apiPostRaw.mock.calls[0]?.[1]; expect(original).toMatchObject({mode:'recurrence',body:'It happened again after the fix.'});
    expect(apiPostRaw.mock.calls[0]?.[0]).toBe(`/tester/issues/${id}/evidence`); expect(body.value).toBe('It happened again after the fix.');
    await click('RETRY SAVED REPORT'); expect(apiPostRaw.mock.calls[1]?.[1]).toEqual(original); expect(view.host.textContent).toContain('reporter thread existing-evidence-thread'); await view.unmount();
  });

  it('tells an unlisted wallet how to get on the board, in the server\'s words', async () => {
    // WHY: `listed` used to be dropped on the floor, so a tester with points
    // and rank null had no idea why. The reason is server copy (the board
    // rule lives in the API); the client only carries a fallback sentence.
    apiGet.mockImplementation((path: string) => path === '/tester/me'
      ? Promise.resolve(meDto({ rank: null, listed: false, listedReason: 'Found a base and sign in once.', justEarned: [] }))
      : Promise.reject(new Error(`unexpected ${path}`)));
    const { host, unmount } = await mount();
    expect(host.textContent).toContain('UNRANKED');
    expect(host.querySelector('[data-testid="listed-hint"]')?.textContent).toBe('HOW TO GET LISTED: Found a base and sign in once.');
    await unmount();
  });

  it('turns the server\'s listed-reason CODE into a sentence, never showing the code', async () => {
    // WHY: the API names the board rule that failed with a short code
    // (no_base | no_action | no_session | hidden | internal). A Seeker player
    // who has founded a Keep but done nothing else must read what to do next,
    // not "no_action"; an unknown future code falls back to the generic rule.
    for (const [code, expected] of [
      ['no_action', /Do one more thing beyond founding/],
      ['no_base', /Found your Keep/],
      ['internal', /Team wallets are never listed/],
      ['some_future_code', /earn one more milestone and sign in once/],
    ] as const) {
      resetTesterMeForTests(); // the shared /tester/me cache would replay the previous code
      apiGet.mockImplementation((path: string) => path === '/tester/me'
        ? Promise.resolve(meDto({ rank: null, listed: false, listedReason: code, justEarned: [] }))
        : Promise.reject(new Error(`unexpected ${path}`)));
      const { host, unmount } = await mount();
      const hint = host.querySelector('[data-testid="listed-hint"]')?.textContent ?? '';
      expect(hint).toMatch(expected);
      expect(hint).not.toContain(code);
      await unmount();
    }
  });

  it('distinguishes a currently held deed from guaranteed original-minter and ranked campaign spots (D-118)', async () => {
    // D-118: current ownership alone cannot promise a spot, and selling a deed
    // does not remove a guaranteed first-minter spot. Both paths need clear copy.
    for (const [landOwner, expected] of [[true, /Land Deed held.*first 50.*another 250/], [false, /Previously guaranteed first-minter spots are retained after selling/]] as const) {
      resetTesterMeForTests();
      apiGet.mockImplementation((path: string) => path === '/tester/me'
        ? Promise.resolve(meDto({ landOwner, justEarned: [] }))
        : Promise.reject(new Error(`unexpected ${path}`)));
      const { host, unmount } = await mount();
      expect(host.querySelector('[data-testid="wl-eligibility"]')?.textContent).toMatch(expected);
      await unmount();
    }
  });

  it('shows the day counter when the server sets the window and toasts daily keys too', async () => {
    apiGet.mockImplementation((path: string) => path === '/tester/me'
      ? Promise.resolve(meDto({
        campaign: { name: 'Founding Kingdoms', totalDays: 14, startAt: '2026-09-10T00:00:00Z', endAt: '2026-09-24T00:00:00Z', dayIndex: 4 },
        justEarned: [{ key: 'pvp_win', points: 2 }],
      }))
      : Promise.reject(new Error(`unexpected ${path}`)));
    const toasts: string[] = [];
    const off = bus.on('ui:toast', (t) => { toasts.push(t.msg); });
    const { host, unmount } = await mount();
    expect(host.querySelector('[data-testid="campaign-day"]')?.textContent).toBe('DAY 4 OF 14');
    expect(toasts).toEqual(['+2 TESTER POINTS — WIN A PVP RAID']);
    off();
    await unmount();
  });

  it('keeps a compact top ten in-game and links out to the full board on the site', async () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      rank: i + 1, name: `K${i + 1}`, wallet: `W${i + 1}…${i + 1}`, points: 100 - i, milestones: 3, feedback: 1,
      dailyPoints: 10 - i, referralPoints: i === 0 ? 3 : 0,
    }));
    apiGet.mockImplementation((path: string) => {
      if (path === '/tester/me') return Promise.resolve(meDto({ justEarned: [] }));
      if (path === '/tester/leaderboard') return Promise.resolve({ entries, totals: { testers: 12, points: 1_000, feedback: 12 } });
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    const { host, unmount } = await mount();
    const boardTab = [...host.querySelectorAll('button')].find((b) => b.textContent === 'LEADERBOARD')!;
    await act(async () => boardTab.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const link = host.querySelector(`a[href="${SITE_LEADERBOARD_URL}"]`) as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    expect(host.textContent).toContain(`TOP ${BOARD_PREVIEW_ROWS}`);
    expect(host.textContent).toContain('K10');
    expect(host.textContent).not.toContain('K11');
    expect(host.textContent).toContain('DAILY 10 · REFERRALS 3');
    await unmount();
  });
});
