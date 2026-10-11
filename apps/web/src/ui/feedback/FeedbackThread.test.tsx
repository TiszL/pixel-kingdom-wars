/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeedbackThreadDto } from '@shardkeep/shared/feedback';
import { useApp } from '../../state/store';
import FeedbackThread, { type FeedbackThreadProps } from './FeedbackThread';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { get, post, binary, blob } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), binary: vi.fn(), blob: vi.fn() }));
vi.mock('../../lib/api', async (original) => ({ ...await original<typeof import('../../lib/api')>(), api: { get, postRaw: post, postBinary: binary, getBlob: blob } }));
const page = (over: Partial<FeedbackThreadDto> = {}): FeedbackThreadDto => ({
  report: { id: 'report', title: 'Private report', category: 'bug', body: 'A private description', status: 'new',
    importance: null, points: 0, adminNote: null, createdAt: '2026-09-07T00:00:00Z', fixedAt: null, fixedRef: null, locked: false, closed: false },
  messages: [{ id: 'm2', revision: 2, body: 'Team reply', kind: 'reply', visibility: 'reporter', authorRole: 'admin', createdAt: '2026-09-07T00:00:00Z' }],
  hasMore: false, oldestRevision: 2, hasEarlier: false, nextRevision: 2, latestRevision: 2, readRevision: 0, unread: true, ...over,
});
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); }); };
const cleanups: Array<() => Promise<void>> = [];
async function mount(over: Partial<FeedbackThreadProps> = {}) {
  useApp.setState({ wallet: 'owner' });
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  const props: FeedbackThreadProps = { wallet: 'owner', mode: 'reporter', reportId: 'report', onBack: vi.fn(), ...over };
  await act(async () => root.render(<FeedbackThread {...props} />)); await flush();
  const unmount = async (): Promise<void> => { await act(async () => root.unmount()); host.remove(); };
  cleanups.push(unmount);
  return { host, props, unmount: async () => { cleanups.splice(cleanups.indexOf(unmount), 1); await unmount(); },
    rerender: async (next: Partial<FeedbackThreadProps>) => { await act(async () => root.render(<FeedbackThread {...props} {...next} />)); } };
}
async function click(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!button) throw new Error(`missing ${label}`);
  await act(async () => button.click()); await flush();
}
async function write(host: HTMLElement, value: string) {
  const field = host.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); get.mockReset(); post.mockReset(); binary.mockReset(); blob.mockReset(); });

it('offers acceptance and its point receipt inside the opened admin report without a separate review screen', async () => {
  await import('./AdminFeedbackReview');
  const current = page({ report: { ...page().report, revision: 4, rewardPolicyVersion: 2, basePoints: 0, bonusPoints: 0,
    linkedIssue: { id: 'issue', title: 'Verified issue', revision: 1, status: 'open', publishedAt: null, mergedInto: null } } });
  get.mockImplementation((path: string) => Promise.resolve(path.startsWith('/admin/tester/issues?') ? { issues: [], nextCursor: null } : current));
  post.mockResolvedValue({ points: 30, delta: 30 });
  const { host } = await mount({ mode: 'admin' });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(host.querySelector('[aria-label="Review & reward"]')).not.toBeNull();
  expect(host.textContent).toContain('A private description');
  // WHY: a normal acceptance must be one explicit action, with no required form filling.
  expect(host.querySelector('textarea[aria-label="Review reason"]')?.closest('details')?.open).toBe(false);
  await click(host, 'ACCEPT & AWARD +30 POINTS');
  expect(post.mock.calls.find(call => call[0].endsWith('/review'))?.[1]).toMatchObject({ status: 'accepted', award: 'first_actionable', importance: 'medium' });
  expect(host.textContent).toContain('30 TOTAL POINTS · 30 ADDED');
});

it('marks an opened admin report as sent from the Android app, and never shows the marker to a reporter', async () => {
  // WHY (owner 2026-09-18): the owner could not tell Android-app reports apart from web ones while
  // reading a report. Reporter pages are unchanged: the server never sends them a context at all.
  const native = page({ report: { ...page().report, context: { client: 'android-native', clientRelease: '0.5.4', platform: 'android' } } });
  get.mockImplementation((path: string) => Promise.resolve(path.startsWith('/admin/tester/issues?') ? { issues: [], nextCursor: null } : native));
  const admin = await mount({ mode: 'admin' });
  const badge = admin.host.querySelector('[data-testid=origin-badge]');
  expect(badge?.textContent).toBe('ANDROID APP 0.5.4'); expect(badge?.getAttribute('data-client')).toBe('android-native');
  await admin.unmount();
  const legacy = page({ report: { ...page().report, context: { platform: 'android', screen: 'feedback', build: 'a'.repeat(40) } } });
  get.mockImplementation((path: string) => Promise.resolve(path.startsWith('/admin/tester/issues?') ? { issues: [], nextCursor: null } : legacy));
  const older = await mount({ mode: 'admin' });
  expect(older.host.querySelector('[data-testid=origin-badge]')?.textContent).toBe('ANDROID APP');
  await older.unmount();
  get.mockResolvedValue(native);
  const reporter = await mount();
  expect(reporter.host.textContent).toContain('A private description');
  expect(reporter.host.querySelector('[data-testid=origin-badge]')).toBeNull();
});

describe('private feedback thread', () => {
  it('acknowledges only loaded replies so opening page one cannot clear unseen later updates', async () => {
    get.mockResolvedValueOnce(page({ hasMore: true, latestRevision: 9 })).mockResolvedValueOnce(page({ messages: [
      { ...page().messages[0]!, id: 'm9', revision: 9, body: 'Later reply' },
    ], nextRevision: 9, latestRevision: 9, readRevision: 2 }));
    post.mockImplementation((_path, body) => Promise.resolve({ readRevision: body.revision }));
    const { host } = await mount();
    expect(post).not.toHaveBeenCalled();
    await click(host, 'MARK LOADED AS READ');
    expect(post.mock.calls[0]?.[1]).toEqual({ revision: 2 });
    expect(host.textContent).toContain('UNREAD UPDATES');
    await click(host, 'LOAD NEWER REPLIES');
    expect(get.mock.calls[1]?.[0]).toContain('afterRevision=2');
    expect(host.textContent).toContain('Team reply'); expect(host.textContent).toContain('Later reply');
    await click(host, 'MARK LOADED AS READ');
    expect(post.mock.calls[1]?.[1]).toEqual({ revision: 9 });
    expect(host.textContent).not.toContain('UNREAD UPDATES');
  });

  it('keeps internal and public drafts separate and reuses the exact uncertain request', async () => {
    get.mockResolvedValue(page()); post.mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce(page().messages[0]);
    const { host } = await mount({ mode: 'admin' });
    expect(host.querySelector('button[aria-pressed=true]')?.textContent).toBe('REPLY TO PLAYER');
    await write(host, 'Public answer'); await click(host, 'INTERNAL NOTE');
    expect(host.querySelector('button[aria-pressed=true]')?.textContent).toBe('INTERNAL NOTE');
    expect(host.querySelector('button[aria-pressed=false]')?.textContent).toBe('REPLY TO PLAYER');
    expect(host.querySelector('textarea')?.value).toBe('');
    await write(host, 'Private investigation'); await click(host, 'SAVE PRIVATE NOTE');
    const first = post.mock.calls[0]?.[1];
    expect(first).toMatchObject({ body: 'Private investigation', visibility: 'admin' });
    expect(host.querySelector('textarea')?.disabled).toBe(true);
    await click(host, 'RETRY SAME REPLY');
    expect(post.mock.calls[1]?.[1]).toEqual(first);
    await click(host, 'REPLY TO PLAYER');
    expect(host.querySelector('textarea')?.value).toBe('Public answer');
    expect(host.textContent).not.toContain('Private investigation');
  });

  it('aborts and discards the old wallet response before it can expose private content', async () => {
    let resolve!: (value: FeedbackThreadDto) => void;
    get.mockImplementation(() => new Promise<FeedbackThreadDto>((done) => { resolve = done; }));
    const { host } = await mount();
    const signal = get.mock.calls[0]?.[1].signal as AbortSignal;
    await act(async () => useApp.setState({ wallet: 'other' }));
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(page()));
    expect(host.textContent).not.toContain('Private description');
    expect(host.textContent).not.toContain('Private report');
    expect(host.textContent).toContain('ACCOUNT CHANGED'); expect(post).not.toHaveBeenCalled();
  });

  it('does not show internal notes or author wallets to reporters and leaves closed reports readable', async () => {
    const result = page(); result.report.closed = true;
    result.messages.push({ ...result.messages[0]!, id: 'secret', revision: 3, visibility: 'admin', kind: 'note', body: 'Private staff text', author: 'AdminWalletNeverRendered' });
    result.messages[0]!.author = 'AdminWalletNeverRendered';
    get.mockResolvedValue(result);
    const { host, props } = await mount();
    expect(host.textContent).toContain('Team reply'); expect(host.textContent).toContain('THIS THREAD IS CLOSED');
    expect(host.textContent).not.toContain('Private staff text'); expect(host.textContent).not.toContain('AdminWalletNeverRendered');
    expect(host.querySelector('textarea')).toBeNull();
    await click(host, 'BACK TO REPORTS'); expect(props.onBack).toHaveBeenCalledOnce();
  });

  it('remounts mode and report changes, aborting a reply without clearing the new draft', async () => {
    get.mockResolvedValue(page()); let resolve!: (value: unknown) => void;
    post.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const { host, rerender } = await mount({ mode: 'admin' });
    await write(host, 'Old answer'); await click(host, 'SEND REPLY');
    const signal = post.mock.calls[0]?.[2].signal as AbortSignal;
    await rerender({ mode: 'reporter', reportId: 'other-report' }); await flush();
    expect(signal.aborted).toBe(true); await write(host, 'New answer');
    await act(async () => resolve({}));
    expect(host.querySelector('textarea')?.value).toBe('New answer');
    expect(host.textContent).not.toContain('REPLY SENT');
  });

  it('recovers an uncertain reply on remount without posting until the player retries the exact stored request', async () => {
    get.mockResolvedValue(page()); post.mockRejectedValueOnce(new Error('Lost response')).mockResolvedValueOnce(page().messages[0]);
    const first = await mount(); await write(first.host, 'Recover this exact reply'); await click(first.host, 'SEND REPLY');
    const intent = post.mock.calls[0]?.[1]; await first.unmount();
    const second = await mount();
    expect(post).toHaveBeenCalledTimes(1);
    expect(second.host.querySelector('textarea')?.value).toBe(intent.body);
    expect(second.host.querySelector('textarea')?.disabled).toBe(true);
    expect(second.host.textContent).toContain('SAVED REPLY AWAITS CONFIRMATION');
    await click(second.host, 'RETRY SAME REPLY'); expect(post.mock.calls[1]?.[1]).toEqual(intent);
    await second.unmount(); const third = await mount();
    expect(third.host.querySelector('textarea')?.value).toBe(''); expect(third.host.textContent).not.toContain('SAVED REPLY');
  });

  it('persists separate note and reply drafts without leaking them to another mode, report or wallet', async () => {
    get.mockResolvedValue(page()); post.mockRejectedValue(new Error('Offline'));
    const first = await mount({ mode: 'admin' });
    await write(first.host, 'Player-facing draft'); await click(first.host, 'INTERNAL NOTE');
    await write(first.host, 'Sensitive staff draft'); await click(first.host, 'SAVE PRIVATE NOTE'); await first.unmount();
    const otherReport = await mount({ mode: 'admin', reportId: 'different' });
    expect(otherReport.host.querySelector('textarea')?.value).toBe(''); await otherReport.unmount();
    const reporter = await mount(); expect(reporter.host.querySelector('textarea')?.value).toBe(''); await reporter.unmount();
    useApp.setState({ wallet: 'another' });
    const otherWallet = await mount({ wallet: 'another', mode: 'admin' });
    await act(async () => useApp.setState({ wallet: 'another' })); await flush();
    expect(otherWallet.host.querySelector('textarea')?.value).toBe(''); await otherWallet.unmount();
    const restored = await mount({ mode: 'admin' });
    expect(restored.host.querySelector('textarea')?.value).toBe('Sensitive staff draft');
    await click(restored.host, 'REPLY TO PLAYER'); expect(restored.host.querySelector('textarea')?.value).toBe('Player-facing draft');
  });

  it('refuses to post if the exact recovery intent cannot be persisted and read back', async () => {
    get.mockResolvedValue(page()); const { host } = await mount(); await write(host, 'Keep this draft');
    const original = localStorage;
    vi.stubGlobal('localStorage', { getItem: original.getItem.bind(original), setItem: () => { throw new Error('quota'); } });
    await click(host, 'SEND REPLY'); expect(post).not.toHaveBeenCalled();
    expect(host.textContent).toContain('allow browser storage');
    expect(host.querySelector('textarea')?.value).toBe('Keep this draft');
  });

  it('does not replace an unresolved request discovered from another tab with a different reply', async () => {
    get.mockResolvedValue(page()); const first = await mount(); await write(first.host, 'First draft');
    const key = localStorage.key(0)!;
    const saved = JSON.parse(localStorage.getItem(key)!);
    const intent = { requestId: 'earlier_request', body: 'Earlier uncertain reply', visibility: 'reporter' };
    localStorage.setItem(key, JSON.stringify({ ...saved, draft: intent.body, intent }));
    await click(first.host, 'SEND REPLY'); expect(post).not.toHaveBeenCalled();
    expect(first.host.textContent).toContain('Close and reopen this thread');
    await first.unmount(); const reopened = await mount();
    expect(reopened.host.querySelector('textarea')?.value).toBe(intent.body);
    post.mockResolvedValue(page().messages[0]); await click(reopened.host, 'RETRY SAME REPLY');
    expect(post.mock.calls[0]?.[1]).toEqual(intent);
  });

  it('does not clear another saved intent when an older acknowledgement arrives', async () => {
    get.mockResolvedValue(page()); const { host } = await mount(); await write(host, 'Original');
    const key = localStorage.key(0)!;
    post.mockImplementation(() => {
      const saved = JSON.parse(localStorage.getItem(key)!);
      localStorage.setItem(key, JSON.stringify({ ...saved, draft: 'Different', intent: { requestId: 'different', body: 'Different', visibility: 'reporter' } }));
      return Promise.resolve(page().messages[0]);
    });
    await click(host, 'SEND REPLY');
    expect(JSON.parse(localStorage.getItem(key)!).intent.requestId).toBe('different');
    expect(host.textContent).toContain('Reply draft changed in another tab');
  });

  it('opens the newest page, prepends earlier history and refreshes newer replies without losing either end', async () => {
    const message = page().messages[0]!;
    get.mockResolvedValueOnce(page({ messages: [{ ...message, id: 'm60', revision: 60, body: 'Newest initially' }], oldestRevision: 60, nextRevision: 60, latestRevision: 60, hasEarlier: true }))
      .mockResolvedValueOnce(page({ messages: [{ ...message, id: 'm10', revision: 10, body: 'Earlier history' }], oldestRevision: 10, nextRevision: 10, latestRevision: 60, hasMore: true }))
      .mockResolvedValueOnce(page({ messages: [{ ...message, id: 'm61', revision: 61, body: 'Just arrived' }], oldestRevision: 61, nextRevision: 61, latestRevision: 61, hasEarlier: true }));
    const { host } = await mount(); expect(get.mock.calls[0]?.[0]).toBe('/tester/feedback/report/thread');
    await write(host, 'Unsent draft'); await click(host, 'LOAD EARLIER REPLIES');
    expect(get.mock.calls[1]?.[0]).toContain('beforeRevision=60');
    expect(host.textContent).toContain('Newest initially'); expect(host.textContent).toContain('Earlier history');
    await click(host, 'REFRESH'); expect(get.mock.calls[2]?.[0]).toContain('afterRevision=60');
    expect(host.textContent).toContain('Earlier history'); expect(host.textContent).toContain('Just arrived');
    expect(host.querySelector('textarea')?.value).toBe('Unsent draft');
    expect([...host.querySelectorAll('button')].find((node) => node.textContent === 'REFRESH')?.style.fontSize).toBe('18px');
  });

  it('marks through the newest shown message only after its boundary is visible, retaining newer unread replies', async () => {
    const callbacks: IntersectionObserverCallback[] = [];
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
      observe() {} unobserve() {} disconnect() {}
    });
    get.mockResolvedValue(page({ nextRevision: 50, latestRevision: 70, oldestRevision: 1, hasMore: true }));
    post.mockResolvedValue({ readRevision: 50 });
    const { host } = await mount(); expect(post).not.toHaveBeenCalled();
    const entry = { target: host.querySelector('[data-testid=feedback-read-boundary]'), isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry;
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => callbacks.at(-1)!([entry], {} as IntersectionObserver)); expect(post).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    await act(async () => callbacks.at(-1)!([entry], {} as IntersectionObserver));
    expect(post.mock.calls[0]?.[1]).toEqual({ revision: 50 }); expect(host.textContent).toContain('UNREAD UPDATES');
    await act(async () => callbacks.at(-1)!([entry], {} as IntersectionObserver));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('does not loop automatic read failures and leaves an explicit retry', async () => {
    const callbacks: IntersectionObserverCallback[] = [];
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
      observe() {} unobserve() {} disconnect() {}
    });
    get.mockResolvedValue(page()); post.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({ readRevision: 2 });
    const { host } = await mount();
    const entry = { target: host.querySelector('[data-testid=feedback-read-boundary]'), isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry;
    await act(async () => callbacks.at(-1)!([entry], {} as IntersectionObserver));
    expect(post).toHaveBeenCalledTimes(1); expect(host.textContent).toContain('Offline');
    await click(host, 'MARK LOADED AS READ'); expect(post).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain('UNREAD UPDATES');
  });
});

const image = { id: '00000000-0000-4000-8000-000000000101', width: 10, height: 20, byteLength: 20, contentType: 'image/webp', expired: false };
async function selectImage(host: HTMLElement) {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:private-image'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const file = new File(['image'], 'private.png', { type: 'image/png' });
  const input = host.querySelector('input[type=file]')!;
  await act(async () => { Object.defineProperty(input, 'files', { configurable: true, value: [file] }); input.dispatchEvent(new Event('change', { bubbles: true })); });
  return file;
}
it('selects locally, retries the same failed upload and recovers an image-only reply after a lost response', async () => {
  get.mockResolvedValue(page()); blob.mockResolvedValue(new Blob(['private'], { type: 'image/webp' }));
  binary.mockRejectedValueOnce(new Error('Upload response lost')).mockResolvedValue(image);
  post.mockRejectedValueOnce(new Error('Reply response lost')).mockResolvedValue({});
  let view = await mount(); const file = await selectImage(view.host);
  expect(binary).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  await click(view.host, 'UPLOAD SELECTED SCREENSHOTS'); expect(view.host.textContent).toContain('UPLOAD NEEDS RETRY');
  await click(view.host, 'RETRY UPLOAD');
  expect(binary.mock.calls[0]?.[0]).toBe(binary.mock.calls[1]?.[0]);
  expect(binary.mock.calls[1]?.[1]).toBe(file);
  await click(view.host, 'SEND REPLY');
  const intent = post.mock.calls[0]?.[1]; expect(intent).toMatchObject({ body: '', attachmentIds: [image.id] });
  await view.unmount(); view = await mount();
  expect(view.host.textContent).toContain('SAVED REPLY AWAITS CONFIRMATION');
  await click(view.host, 'RETRY SAME REPLY'); expect(post.mock.calls[1]?.[1]).toEqual(intent);
  expect(binary).toHaveBeenCalledTimes(2);
  expect(view.host.textContent).not.toContain('REMOVE UPLOADED SCREENSHOT');
});
it('keeps text after reload but explicitly requires missing local files to be reattached or cleared', async () => {
  get.mockResolvedValue(page()); let view = await mount(); await write(view.host, 'Keep my description');
  await selectImage(view.host); await view.unmount(); view = await mount();
  expect(view.host.querySelector('textarea')?.value).toBe('Keep my description');
  expect(view.host.textContent).toContain('Local image files were not restored');
  expect([...view.host.querySelectorAll('button')].find(b => b.textContent === 'SEND REPLY')?.disabled).toBe(true);
  await click(view.host, 'CLEAR MISSING FILES');
  expect(binary).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  expect([...view.host.querySelectorAll('button')].find(b => b.textContent === 'SEND REPLY')?.disabled).toBe(false);
});
it('aborts a private upload on wallet switch and never admits its late screenshot into another account', async () => {
  get.mockResolvedValue(page()); let resolve!: (value: unknown) => void;
  binary.mockImplementation(() => new Promise(r => { resolve = r; }));
  const view = await mount(); await selectImage(view.host);
  const upload = [...view.host.querySelectorAll('button')].find(b => b.textContent === 'UPLOAD SELECTED SCREENSHOTS')!;
  await act(async () => upload.click());
  await act(async () => useApp.setState({ wallet: 'other' }));
  expect(binary.mock.calls[0]?.[2].signal.aborted).toBe(true);
  await act(async () => resolve(image));
  expect(view.host.textContent).toContain('ACCOUNT CHANGED'); expect(view.host.querySelector('img')).toBeNull();
  expect(localStorage.getItem('pkw:feedback-reply:v1:'+JSON.stringify(['owner','reporter','report','reporter']))).not.toContain(image.id);
});
it('fetches only visible private attachments, shows expiry without fetching and revokes image bytes on close', async () => {
  get.mockResolvedValue(page({ messages: [
    { ...page().messages[0]!, attachments: [image, { ...image, id: 'expired', expired: true }] },
    { ...page().messages[0]!, id: 'secret-note', visibility: 'admin', attachments: [{ ...image, id: 'staff-secret' }] },
  ] }));
  blob.mockResolvedValue(new Blob(['private'], { type: 'image/webp' }));
  vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:private-image'); const revoke = vi.spyOn(URL,'revokeObjectURL').mockImplementation(() => undefined);
  const view = await mount();
  expect(blob).toHaveBeenCalledTimes(1); expect(blob.mock.calls[0]?.[0]).toContain(image.id);
  expect(view.host.textContent).toContain('SCREENSHOT EXPIRED'); await view.unmount(); expect(revoke).toHaveBeenCalledWith('blob:private-image');
});
it('restores an uncertain upload identity after reload and reattachment before completing the ordered reply', async () => {
  get.mockResolvedValue(page()); blob.mockResolvedValue(new Blob(['private']));
  binary.mockRejectedValueOnce(new Error('Accepted upload response lost')).mockResolvedValue(image); post.mockResolvedValue({});
  let view = await mount(); await selectImage(view.host); await click(view.host, 'UPLOAD SELECTED SCREENSHOTS');
  const originalPath = binary.mock.calls[0]?.[0]; await view.unmount(); view = await mount();
  expect(view.host.textContent).toContain('Local image files were not restored');
  await selectImage(view.host); await click(view.host, 'UPLOAD SELECTED SCREENSHOTS');
  expect(binary.mock.calls[1]?.[0]).toBe(originalPath);
  await click(view.host, 'SEND REPLY'); expect(post.mock.calls[0]?.[1].attachmentIds).toEqual([image.id]);
});
it('requires reviewing another tab’s changed text, images or local pending selection before sending', async () => {
  for (const change of [
    { draft: 'Text changed elsewhere' },
    { attachmentIds: [image.id] },
    { localFilesPending: 1 },
  ]) {
    get.mockResolvedValue(page()); const view = await mount(); await write(view.host, 'The text I reviewed');
    const key = 'pkw:feedback-reply:v1:'+JSON.stringify(['owner','reporter','report','reporter']);
    localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key)!), ...change }));
    await click(view.host, 'SEND REPLY'); expect(post).not.toHaveBeenCalled();
    expect(view.host.textContent).toContain('Reply draft changed in another tab');
    await view.unmount(); localStorage.clear();
  }
});

it('keeps a trashed admin report readable but hides all reply and editing controls except Restore', async () => {
  get.mockResolvedValue(page({ report: { ...page().report, revision: 7, trashed: true, trashedAt: '2026-09-07' } }));
  const view = await mount({ mode: 'admin' });
  expect(view.host.textContent).toContain('Team reply'); expect(view.host.textContent).toContain('RESTORE REPORT'); expect(view.host.textContent).toContain('READ ONLY');
  expect(view.host.querySelector('textarea')).toBeNull(); expect(view.host.textContent).not.toContain('THREAD OPEN · CHANGE'); expect(view.host.textContent).not.toContain('MARK FIXED'); expect(view.host.textContent).not.toContain('REPLY TO PLAYER');
});

it('shows Fixed instead of Accepted even when a compatible API returns the legacy stored triage', async () => {
  get.mockResolvedValue(page({ report: { ...page().report, status: 'accepted', fixedAt: '2026-09-07' } }));
  const view = await mount(); const summary = view.host.querySelector('h3')!.parentElement!;
  expect(summary.textContent).toContain('FIXED'); expect(summary.textContent).not.toContain('ACCEPTED');
  expect(view.host.textContent).toContain('Only you and the support team');
});


it('keeps report navigation and reply access simple without losing scoped drafts or administrative controls', async () => {
  get.mockResolvedValue(page());
  const previous = vi.fn(), next = vi.fn();
  const { host, rerender } = await mount({ mode: 'admin', navigation: { position: 2, total: 3, onPrevious: previous, onNext: next } });
  host.style.overflowY = 'auto';
  await write(host, 'Player draft'); await click(host, 'INTERNAL NOTE');
  await write(host, 'Private note draft');
  await click(host, 'REPLY');
  expect(host.querySelector('textarea')?.value).toBe('Player draft');
  expect(document.activeElement).toBe(host.querySelector('textarea'));
  await click(host, 'PREV'); expect(previous).toHaveBeenCalledOnce();
  await click(host, 'NEXT'); expect(next).toHaveBeenCalledOnce();
  host.scrollTop = 600;
  await rerender({ reportId: 'other-report' }); await flush();
  expect(host.scrollTop).toBe(0);
  expect(host.querySelector('textarea')?.value).toBe('');
  await rerender({ reportId: 'report' }); await flush();
  expect(host.querySelector('textarea')?.value).toBe('Player draft');
  await click(host, 'INTERNAL NOTE');
  expect(host.querySelector('textarea')?.value).toBe('Private note draft');
  expect(post).not.toHaveBeenCalled();
});

it('keeps a retry reachable if an admin report cannot load, and guards the reply jump during a send', async () => {
  get.mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(page());
  const { host } = await mount({ mode: 'admin' });
  expect(host.textContent).toContain('Offline');
  await click(host, 'REFRESH');
  expect(host.textContent).toContain('A private description');
  await write(host, 'Reply in flight');
  post.mockImplementation(() => new Promise(() => {}));
  await click(host, 'SEND REPLY');
  expect([...host.querySelectorAll('button')].find(button => button.textContent === 'REPLY')?.disabled).toBe(true);
});

it('loads more reports from the compact end-of-queue control before enabling Next', async () => {
  get.mockResolvedValue(page()); const more = vi.fn(), next = vi.fn();
  const { host, rerender } = await mount({ mode: 'admin', navigation: { position: 2, total: 2, onMore: more } });
  await click(host, 'MORE'); expect(more).toHaveBeenCalledOnce();
  await rerender({ navigation: { position: 2, total: 2, onMore: more, loadingMore: true } });
  expect([...host.querySelectorAll('button')].find(button => button.textContent === 'MORE')?.disabled).toBe(true);
  await rerender({ navigation: { position: 2, total: 3, onNext: next } });
  expect(host.textContent).toContain('2 / 3 LOADED');
  await click(host, 'NEXT'); expect(next).toHaveBeenCalledOnce();
});

it('keeps one-click fixed by the review result and pauses other mutations until its lost response is recovered', async () => {
  await import('./AdminFeedbackReview');
  let current = page({ unread: false, report: { ...page().report, revision: 4, status: 'accepted', rewardPolicyVersion: 2, basePoints: 10, bonusPoints: 20, points: 30 } });
  get.mockImplementation((path: string) => Promise.resolve(path.startsWith('/admin/tester/issues?') ? { issues: [], nextCursor: null } : current));
  post.mockImplementationOnce(async () => { current = { ...current, report: { ...current.report, status: 'fixed', fixedAt: '2026-09-09', revision: 5 } }; throw Error('Response lost'); }).mockResolvedValue({ revision: 5 });
  const { host } = await mount({ mode: 'admin' });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(host.querySelectorAll('[aria-label="fixed report action"]')).toHaveLength(1);
  const fixed = [...host.querySelectorAll('button')].find(b => b.textContent === 'MARK FIXED')!;
  expect(fixed.closest('[aria-label="Review & reward"]')).not.toBeNull(); expect(fixed.closest('details')).toBeNull();
  await click(host, 'MARK FIXED');
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Reply"]')?.disabled).toBe(true);
  expect([...host.querySelectorAll('button')].find(b => b.textContent === 'MOVE TO TRASH')?.disabled).toBe(true);
  await click(host, 'RETRY SAVED REPORT ACTION');
  expect(post.mock.calls[1]?.[1]).toEqual(post.mock.calls[0]?.[1]); expect(post.mock.calls.every(call => call[0].endsWith('/fixed'))).toBe(true);
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Reply"]')?.disabled).toBe(false); expect(host.textContent).toContain('Team reply'); expect(host.textContent).toContain('30 POINTS');
});

it('keeps fixed disabled while an exact saved reply still needs recovery', async () => {
  await import('./AdminFeedbackReview');
  const current = page({ unread: false, report: { ...page().report, revision: 4, status: 'accepted', rewardPolicyVersion: 2, basePoints: 10, bonusPoints: 20, points: 30 } });
  get.mockImplementation((path: string) => Promise.resolve(path.startsWith('/admin/tester/issues?') ? { issues: [], nextCursor: null } : current));
  post.mockRejectedValue(Error('Response lost'));
  const { host } = await mount({ mode: 'admin' });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const field = host.querySelector<HTMLTextAreaElement>('[aria-label="Reply"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'The team is checking this.'); field.dispatchEvent(new Event('input', { bubbles: true })); });
  await click(host, 'SEND REPLY');
  expect([...host.querySelectorAll('button')].find(b => b.textContent === 'MARK FIXED')?.disabled).toBe(true);
  expect([...host.querySelectorAll('button')].find(b => b.textContent === 'RETRY SAME REPLY')?.disabled).toBe(false);
});

it.each(['rejected', 'fixed'] as const)('shows the reporter their %s outcome while retaining the private conversation', async (status) => {
  get.mockResolvedValue(page({ report: { ...page().report, status, points: 30 } }));
  const { host } = await mount(); expect(host.querySelector('h3')!.parentElement!.textContent).toContain(status.toUpperCase());
  expect(host.textContent).toContain('Team reply'); expect(host.textContent).toContain('30 POINTS');
});

it('blocks fixed and replies while closure is uncertain, but leaves the exact closure recovery usable', async () => {
  await import('./AdminFeedbackReview');
  const current = page({ unread: false, report: { ...page().report, revision: 4, status: 'accepted', rewardPolicyVersion: 2, basePoints: 10, bonusPoints: 20, points: 30 } });
  get.mockImplementation((path: string) => Promise.resolve(path.startsWith('/admin/tester/issues?') ? { issues: [], nextCursor: null } : current));
  post.mockRejectedValueOnce(Error('Response lost')).mockResolvedValue({ revision: 5 });
  const { host } = await mount({ mode: 'admin' });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const field = host.querySelector<HTMLTextAreaElement>('[aria-label="closure reason"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Conversation completed.'); field.dispatchEvent(new Event('input', { bubbles: true })); });
  await click(host, 'REVIEW THREAD CLOSURE'); await click(host, 'CONFIRM: CLOSE PRIVATE THREAD');
  expect([...host.querySelectorAll('button')].find(b => b.textContent === 'MARK FIXED')?.disabled).toBe(true);
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Reply"]')?.disabled).toBe(true);
  const retry = [...host.querySelectorAll('button')].find(b => b.textContent === 'RETRY SAVED RETENTION ACTION')!; expect(retry.disabled).toBe(false);
  await click(host, 'RETRY SAVED RETENTION ACTION'); expect(post.mock.calls[1]?.[1]).toEqual(post.mock.calls[0]?.[1]);
  expect([...host.querySelectorAll('button')].find(b => b.textContent === 'MARK FIXED')?.disabled).toBe(false);
});
