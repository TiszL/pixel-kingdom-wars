/** @vitest-environment happy-dom */
import { act } from 'react';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApp } from '../../state/store';

const apiGet = vi.fn();
const apiPostRaw = vi.fn();
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: { ...actual.api, get: (...a: unknown[]) => apiGet(...a), postRaw: (...a: unknown[]) => apiPostRaw(...a) } };
});
vi.mock('../feedback/FeedbackThread', () => ({ default: ({ mode, reportId, onBack, onChanged, navigation }: import('../feedback/FeedbackThread').FeedbackThreadProps) =>
  <section aria-label="Private conversation"><span>{mode} thread {reportId}</span><button onClick={onBack}>BACK TO REPORTS</button>
    <button onClick={onChanged}>SIMULATE ACCEPTED</button><span>{navigation?.position} of {navigation?.total} loaded reports</span>
    <button disabled={!navigation?.onPrevious} onClick={navigation?.onPrevious}>PREVIOUS</button>
    <button disabled={!navigation?.onNext} onClick={navigation?.onNext}>NEXT REPORT</button>
    {navigation?.onMore && <button disabled={navigation.loadingMore} onClick={navigation.onMore}>LOAD MORE REPORTS</button>}
  </section> }));

import AdminFeedbackPanel, { feedbackAsText, type FeedbackRow } from './AdminFeedbackPanel';

const row = (over: Partial<FeedbackRow> = {}): FeedbackRow => ({
  id: '11111111-1111-4111-8111-111111111111', wallet: '4A3o8QioSxrZ57rutVzaDn1YAh6mA6NHekHC1G6hzxNC', name: 'Suga',
  category: 'bug', title: 'Hero attacks happen but animation and building HP reduction are not displayed',
  body: 'The hero attack animation is missing,\nthe target building HP bar does not visibly decrease.',
  context: { build: 'cee3869', platform: 'desktop' }, status: 'new', importance: null,
  basePoints: 10, bonusPoints: 0, points: 10, adminNote: null, createdAt: '2026-09-04T04:41:00.000Z', reviewedAt: null,
  fixed: false, fixedAt: null, fixedRef: null, exportedAt: null, rewardPolicyVersion: 1, revision: 7,
  ...over,
});
const SECOND = '22222222-2222-4222-8222-222222222222';

const flush = async (): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function mount(): Promise<{ host: HTMLElement; unmount: () => Promise<void> }> {
  useApp.setState({ wallet: 'admin-wallet' });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(<AdminFeedbackPanel />); });
  await flush();
  return { host, unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}
const click = async (el: Element | null | undefined): Promise<void> => {
  if (!el) throw new Error('element missing');
  await act(async () => { (el as HTMLElement).click(); });
  await flush();
};
const buttonNamed = (host: HTMLElement, text: string | RegExp): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => (typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent?.trim() ?? '')));

const openTools = async (host: HTMLElement): Promise<void> => {
  const details = host.querySelector('details')!;
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')); });
  await flush();
};

afterEach(() => { apiGet.mockReset(); apiPostRaw.mockReset(); localStorage.clear(); });

describe('feedbackAsText', () => {
  it('renders Fixed as the exclusive lifecycle status with context and fix reference', () => {
    // WHY: the owner shares tester reports outside the game (a chat, a doc);
    // the text must stand alone — who, when, what was decided, and the body.
    // The owner now wants Fixed to replace Accepted in display and filters.
    const text = feedbackAsText([
      row({ status: 'accepted', fixed: true, importance: 'high', points: 60, fixedRef: '54a3d18e', fixedAt: '2026-09-04T11:00:00.000Z', adminNote: 'thank you' }),
      row({ id: SECOND, title: 'Add cancel option', category: 'idea', context: null }),
    ], new Date('2026-09-04T12:00:00.000Z'));
    expect(text).toContain('2 reports · exported 2026-09-04 12:00 UTC');
    expect(text).toContain('## [BUG] Hero attacks happen but animation and building HP reduction are not displayed');
    expect(text).toContain('Suga · 4A3o8QioSxrZ57rutVzaDn1YAh6mA6NHekHC1G6hzxNC · 2026-09-04 04:41 UTC');
    expect(text).toContain('status: fixed · importance: high · points: 60 · fix reference: 54a3d18e · fixed at: 2026-09-04 11:00 UTC');
    expect(text).toContain('context: build=cee3869 · platform=desktop');
    expect(text).toContain('note to tester: thank you');
    expect(text).toContain('## [IDEA] Add cancel option');
    expect(text).toContain('status: new · points: 10\n');
  });

  it('says which client sent each report right under its heading', () => {
    // WHY (owner 2026-09-18): Android-app reports were indistinguishable from web ones once
    // copied out of the game. Reports older than the server stamp are inferred, not lost.
    const text = feedbackAsText([
      row({ context: { client: 'android-native', clientRelease: '0.5.4', platform: 'android' } }),
      row({ id: SECOND, title: 'Older native report', context: { platform: 'android', screen: 'feedback', build: 'a'.repeat(40) } }),
      row({ id: '33333333-3333-4333-8333-333333333333', title: 'Phone browser', context: { platform: 'android', screen: 'tester', build: 'cee3869' } }),
    ], new Date('2026-09-18T12:00:00.000Z'));
    expect(text).toContain('not displayed\nSOURCE: ANDROID APP 0.5.4\n');
    expect(text).toContain('## [BUG] Older native report\nSOURCE: ANDROID APP\n');
    expect(text).toContain('## [BUG] Phone browser\nSOURCE: WEB · android\n');
  });
});

describe('AdminFeedbackPanel', () => {
  it('opens a policy2 private thread and returns to the list without offering unsupported legacy rewards', async () => {
    apiGet.mockResolvedValue({ feedback: [row({ rewardPolicyVersion: 2, unread: true })] });
    const { host, unmount } = await mount();
    expect(host.textContent).toContain('UNREAD THREAD UPDATES');
    expect(buttonNamed(host, 'SAVE RATING')).toBeUndefined();
    await click(buttonNamed(host, 'OPEN REPORT'));
    expect(host.querySelector('[aria-label="Private conversation"]')?.textContent).toContain('admin thread 11111111');
    await click(buttonNamed(host, 'BACK TO REPORTS'));
    expect(buttonNamed(host, 'OPEN REPORT')).toBeTruthy();
    expect(apiPostRaw).not.toHaveBeenCalled();
    await unmount();
  });
  it('offers a separate Fixed action for both reward policies without submitting a reward rating', async () => {
    apiGet.mockResolvedValue({ feedback: [row({ status: 'accepted' }), row({ id: SECOND, rewardPolicyVersion: 2, status: 'accepted' })] }); apiPostRaw.mockResolvedValue({});
    const { host, unmount } = await mount();
    expect([...host.querySelectorAll('button')].filter(b => b.textContent === 'MARK FIXED')).toHaveLength(2);
    await click(buttonNamed(host, 'MARK FIXED'));
    const reason = host.querySelector('textarea[aria-label="fixed reason"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(reason, 'Verified release'); reason.dispatchEvent(new Event('input', { bubbles: true })); });
    await click(buttonNamed(host, 'REVIEW: MARK FIXED')); await click(buttonNamed(host, 'CONFIRM: MARK FIXED'));
    expect(apiPostRaw.mock.calls[0]?.[0]).toBe(`/admin/tester/feedback/${row().id}/fixed`);
    expect(apiPostRaw.mock.calls[0]?.[1]).toEqual({ requestId: expect.any(String), expectedRevision: 7, reason: 'Verified release', fixed: true });
    expect(host.textContent).toContain('+10'); await unmount();
  });

  it('shows trashed reports as read-only with Restore and without reward or export controls', async () => {
    apiGet.mockImplementation((path: string) => Promise.resolve({ feedback: path.includes('trashed=true') ? [row({ trashed: true, trashedAt: '2026-09-07', rewardPolicyVersion: 2 })] : [] }));
    const { host, unmount } = await mount(); await openTools(host); await click(buttonNamed(host, 'TRASH'));
    expect(apiGet).toHaveBeenCalledWith('/admin/tester/feedback/page?trashed=true', expect.anything());
    expect(buttonNamed(host, 'RESTORE REPORT')).toBeTruthy(); expect(buttonNamed(host, 'REVIEW REPORT')).toBeUndefined(); expect(buttonNamed(host, 'MARK FIXED')).toBeUndefined();
    expect(host.querySelector<HTMLInputElement>('input[type=checkbox]')?.disabled).toBe(true); expect(buttonNamed(host, /^PRIVATE EXPORTS/)?.disabled).toBe(true); expect(buttonNamed(host, 'OPEN REPORT')).toBeTruthy();
    await click(buttonNamed(host, 'ACTIVE')); expect(buttonNamed(host, 'RESTORE REPORT')).toBeUndefined(); expect(apiPostRaw).not.toHaveBeenCalled(); await unmount();
  });

  it('prepares only selected report revisions through the private export job instead of stamping a client-side copy', async () => {
    const rows = [row(), row({ id: SECOND, title: 'Second', status: 'accepted' })];
    apiGet.mockImplementation((path: string) => Promise.resolve(path.endsWith('/exports') ? { exports: [], nextBefore: null } : { feedback: rows, nextCursor: null }));
    apiPostRaw.mockResolvedValue({ jobId: 'job', reportCount: 1 });
    const { host, unmount } = await mount();
    await openTools(host);
    await click(host.querySelector('input[type="checkbox"]'));
    await click(buttonNamed(host, /^PRIVATE EXPORTS \(1 SELECTED\)/));
    expect(apiPostRaw).not.toHaveBeenCalled();
    await click(buttonNamed(host, 'REVIEW EXPORT'));
    await click(buttonNamed(host, 'CONFIRM PREPARATION'));
    expect(apiPostRaw.mock.calls[0]?.slice(0, 2)).toEqual(['/admin/tester/feedback/exports', { requestId: expect.any(String), format: 'zip', selection: { ids: [rows[0]!.id] } }]);
    expect(apiPostRaw.mock.calls.some(c => c[0].endsWith('/exported'))).toBe(false);
    expect(host.textContent).toContain('PREPARATION REQUESTED');
    await unmount();
  });

  it('keeps selected reports from later pages in export after returning from a conversation', async () => {
    apiGet.mockImplementation((path: string) => Promise.resolve(path.endsWith('/exports') ? { exports: [], nextBefore: null } : path.includes('cursor=second') ? { feedback: [row({ id: SECOND, title: 'Second page report' })], nextCursor: null } : { feedback: [row()], nextCursor: 'second' }));
    apiPostRaw.mockResolvedValue({ jobId: 'job', reportCount: 2 });
    const { host, unmount } = await mount();
    await openTools(host);
    await click(host.querySelector('input[type="checkbox"]'));
    await click(buttonNamed(host, 'LOAD MORE REPORTS'));
    await click([...host.querySelectorAll('input[type="checkbox"]')].at(-1));
    await click([...host.querySelectorAll('button')].filter(b => b.textContent?.trim() === 'OPEN REPORT').at(-1));
    await click(buttonNamed(host, 'BACK TO REPORTS'));
    expect(host.textContent).toContain('Second page report');
    expect(buttonNamed(host, 'PRIVATE EXPORTS (2 SELECTED)')).toBeTruthy();
    await click(buttonNamed(host, 'PRIVATE EXPORTS (2 SELECTED)'));
    await click(buttonNamed(host, 'REVIEW EXPORT'));
    await click(buttonNamed(host, 'CONFIRM PREPARATION'));
    expect(apiPostRaw.mock.calls[0]?.[1].selection.ids).toEqual(['11111111-1111-4111-8111-111111111111', SECOND]);
    await unmount();
  });

  it('offers FIXED and NOT EXPORTED filters that query the flag, not a status', async () => {
    const seen: string[] = [];
    apiGet.mockImplementation((path: string) => { seen.push(path); return Promise.resolve({ feedback: [] }); });
    const { host, unmount } = await mount();
    await click(buttonNamed(host, 'FIXED'));
    await click(buttonNamed(host, 'NOT EXPORTED'));
    expect(seen).toContain('/admin/tester/feedback/page?fixed=true');
    expect(seen).toContain('/admin/tester/feedback/page?exported=false');
    await unmount();
  });
});

it('badges every listed report with its client and offers a server-side ANDROID APP ONLY filter that exports carry', async () => {
  // WHY (owner 2026-09-18): "I want to receive android feedback visible marked sent from android app."
  // The badge is always on the card (not inside the collapsed details), and the filter is a server
  // query — a client-side filter would miss native reports on pages that are not loaded yet.
  const seen: string[] = [];
  apiGet.mockImplementation((path: string) => { seen.push(path); return Promise.resolve(path.endsWith('/exports') ? { exports: [], nextBefore: null } : { feedback: [
    row({ context: { client: 'android-native', clientRelease: '0.5.4', platform: 'android' } }),
    row({ id: SECOND, context: { platform: 'android', screen: 'feedback', build: 'a'.repeat(40) } }),
    row({ id: '33333333-3333-4333-8333-333333333333' }),
  ], nextCursor: null }); });
  apiPostRaw.mockResolvedValue({ jobId: 'job', reportCount: 2 });
  const { host, unmount } = await mount();
  const badges = [...host.querySelectorAll('[data-testid=origin-badge]')];
  expect(badges.map(b => b.textContent)).toEqual(['ANDROID APP 0.5.4', 'ANDROID APP', 'WEB · DESKTOP']);
  expect(badges.map(b => b.getAttribute('data-client'))).toEqual(['android-native', 'android-native', 'web']);
  expect(badges.every(b => b.closest('details') === null)).toBe(true);
  await openTools(host);
  await click(buttonNamed(host, 'ANDROID APP ONLY'));
  expect(seen).toContain('/admin/tester/feedback/page?client=android-native');
  await click(buttonNamed(host, /^PRIVATE EXPORTS/));
  await click(buttonNamed(host, 'REVIEW EXPORT')); await click(buttonNamed(host, 'CONFIRM PREPARATION'));
  expect(apiPostRaw.mock.calls[0]?.[1]).toMatchObject({ selection: { filter: { client: 'android-native' } } });
  await unmount();
});

it('displays a Fixed report without an Accepted triage badge and offers reopening', async () => {
  apiGet.mockResolvedValue({ feedback: [row({ status: 'fixed', fixedAt: '2026-09-07', fixed: true })] });
  const { host, unmount } = await mount();
  expect(host.querySelector('[data-testid=fixed-badge]')?.textContent).toContain('FIXED');
  expect(host.querySelector('[data-testid=report-status]')).toBeNull();
  expect([...host.querySelectorAll('button')].filter(b => b.textContent === 'ACCEPTED')).toHaveLength(1); // List filter only, not a second report status.
  expect(buttonNamed(host, 'REOPEN AS ACCEPTED')).toBeTruthy(); await unmount();
});


it('keeps the default inbox compact while retaining advanced actions and full private details', async () => {
  apiGet.mockResolvedValue({ feedback: [row()] });
  const { host, unmount } = await mount();
  expect([...host.querySelectorAll('[aria-label="Feedback filters"] button')].map(button => button.textContent)).toEqual(['NEW', 'ACCEPTED', 'FIXED']);
  expect(host.querySelector('details')?.open).toBe(false);
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  expect(host.querySelector('textarea')).toBeNull();
  expect(buttonNamed(host, 'OPEN REPORT')).toBeTruthy();
  await openTools(host);
  expect(host.querySelector('input[type="checkbox"]')).not.toBeNull();
  expect(buttonNamed(host, 'CURATED ISSUES')).toBeTruthy();
  expect(host.textContent).toContain(row().wallet);
  await unmount();
});

it('never skips the next loaded report when acceptance removes the current report from New', async () => {
  const third = '33333333-3333-4333-8333-333333333333';
  let accepted = false;
  apiGet.mockImplementation(() => Promise.resolve({ feedback: accepted ? [row({ id: third }), row({ id: SECOND })] : [row(), row({ id: SECOND }), row({ id: third })], nextCursor: null }));
  const { host, unmount } = await mount();
  host.style.overflowY = 'auto'; host.scrollTop = 480;
  await click(buttonNamed(host, 'OPEN REPORT'));
  expect(host.scrollTop).toBe(0);
  accepted = true;
  await click(buttonNamed(host, 'SIMULATE ACCEPTED'));
  expect(host.textContent).toContain('1 of 3 loaded reports');
  host.scrollTop = 320;
  await click(buttonNamed(host, 'NEXT REPORT'));
  expect(host.textContent).toContain(`admin thread ${SECOND}`);
  expect(host.scrollTop).toBe(0);
  await click(buttonNamed(host, 'NEXT REPORT'));
  expect(host.textContent).toContain(`admin thread ${third}`);
  await click(buttonNamed(host, 'PREVIOUS'));
  expect(host.textContent).toContain(`admin thread ${SECOND}`);
  await click(buttonNamed(host, 'PREVIOUS'));
  expect(host.textContent).toContain(`admin thread ${row().id}`);
  await click(buttonNamed(host, 'BACK TO REPORTS'));
  expect(host.scrollTop).toBe(480);
  expect(apiGet.mock.calls.every(call => call[0] === '/admin/tester/feedback/page?status=new')).toBe(true);
  await unmount();
});

it('extends only the loaded reading queue on request and resets private navigation on wallet change', async () => {
  apiGet.mockImplementation((path: string) => Promise.resolve(path.includes('cursor=second') ? { feedback: [row({ id: SECOND })], nextCursor: null } : { feedback: [row()], nextCursor: 'second' }));
  const { host, unmount } = await mount();
  await click(buttonNamed(host, 'OPEN REPORT'));
  expect(host.textContent).toContain('1 of 1 loaded reports');
  expect(buttonNamed(host, 'NEXT REPORT')?.disabled).toBe(true);
  await click(buttonNamed(host, 'LOAD MORE REPORTS'));
  expect(host.textContent).toContain('1 of 2 loaded reports');
  await click(buttonNamed(host, 'NEXT REPORT'));
  expect(host.textContent).toContain(`admin thread ${SECOND}`);
  await act(async () => useApp.setState({ wallet: 'another-admin' })); await flush();
  expect(host.querySelector('[aria-label="Private conversation"]')).toBeNull();
  expect(buttonNamed(host, 'OPEN REPORT')).toBeTruthy();
  await unmount();
});

it('keeps the Accepted reading queue and list position when fixing removes the current report', async () => {
  let fixed = false;
  apiGet.mockImplementation((path: string) => Promise.resolve({ feedback: path.includes('status=accepted') ? fixed ? [row({ id: SECOND, status: 'accepted' })] : [row({ status: 'accepted' }), row({ id: SECOND, status: 'accepted' })] : [], nextCursor: null }));
  const { host, unmount } = await mount(); await click(buttonNamed(host, 'ACCEPTED')); host.style.overflowY = 'auto'; host.scrollTop = 280;
  await click(buttonNamed(host, 'OPEN REPORT')); fixed = true;
  // The thread's onChanged callback is shared by acceptance and Fixed receipts.
  await click(buttonNamed(host, 'SIMULATE ACCEPTED')); await click(buttonNamed(host, 'NEXT REPORT'));
  expect(host.textContent).toContain(`admin thread ${SECOND}`); await click(buttonNamed(host, 'PREVIOUS')); expect(host.textContent).toContain(`admin thread ${row().id}`);
  await click(buttonNamed(host, 'BACK TO REPORTS')); expect(host.scrollTop).toBe(280); expect(apiGet.mock.calls.at(-1)?.[0]).toBe('/admin/tester/feedback/page?status=accepted');
  await click(buttonNamed(host, 'FIXED')); expect(apiGet.mock.calls.at(-1)?.[0]).toBe('/admin/tester/feedback/page?fixed=true'); await openTools(host);
  expect(buttonNamed(host, 'ALL')!.closest('details')).not.toBeNull(); await unmount();
});
