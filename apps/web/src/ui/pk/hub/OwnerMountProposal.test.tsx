// @vitest-environment happy-dom
// Exercises the existing production mount chains, with network and timers mocked.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { ChatLauncher } from '../../chat/ChatLauncher';
import type { ChatOwnerBridge, ChatOwnerProjection } from '../../chat/ChatScreen';
import TesterScreen, { type FeedbackOwnerBridge, type FeedbackOwnerProjection } from '../../screens/tester';
import { chatApi, startChatPoller, type ChatStatus } from '../../chat/protocol';

const mocks = vi.hoisted(() => ({
  state: { wallet: 'wallet', authed: true, screen: 'base', selectedBaseId: null },
  readSaved: vi.fn(), save: vi.fn(), deliver: vi.fn(),
}));
vi.mock('../../../state/store', () => ({ useApp: Object.assign(
  (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state), { getState: () => mocks.state }) }));
vi.mock('../../layout', () => ({ useWindowSize: () => ({ w: 400, h: 800 }),
  baseChatPlacement: () => ({ bottom: 0, right: 0 }), mapChatSlot: () => ({ width: 48, height: 48, left: 0, top: 0 }) }));
vi.mock('../../chat/useChatFrame', () => ({ useChatFrame: () => ({ top: 0, height: 800 }) }));
vi.mock('../../screens/seeker', () => ({ SeekerBadge: () => null }));
vi.mock('../../chat/protocol', async original => ({
  ...await original<typeof import('../../chat/protocol')>(),
  startChatPoller: vi.fn(() => () => undefined), scheduleChatRetry: vi.fn(() => () => undefined),
}));
vi.mock('../../../lib/analytics', () => ({ EVENTS: {}, track: vi.fn() }));
vi.mock('../../testerDaily', () => ({ earnedToast: vi.fn(), useTesterMe: () => ({ data: null, loading: false, error: null }) }));
vi.mock('../../feedback/feedbackSubmission', () => ({ readFeedbackSubmission: () => mocks.readSaved(),
  saveFeedbackSubmission: (...args: unknown[]) => mocks.save(...args), clearFeedbackSubmission: vi.fn(), advanceFeedbackSubmission: vi.fn() }));
vi.mock('../../feedback/feedbackReportDelivery', () => ({ deliverFeedbackReport: (...args: unknown[]) => mocks.deliver(...args) }));
vi.mock('../../feedback/useFeedbackPages', () => ({ useFeedbackPages: () => ({ data: { feedback: [] }, loading: false,
  error: null, nextCursor: null, reload: vi.fn(), more: vi.fn() }) }));
vi.mock('../../feedback/KnownIssueSuggestions', () => ({ default: () => null }));
vi.mock('../../feedback/FeedbackScreenshotPicker', () => ({ default: () => null }));
vi.mock('../../feedback/FeedbackThreadScreenshots', () => ({ FeedbackPrivateImage: () => null }));
vi.mock('../../feedback/FeedbackThread', () => ({ default: () => <div>Existing private thread</div> }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root;
const status: ChatStatus = { enabled: true, canSend: true, sendBlockedReason: null, mutedUntil: null,
  pollOpenMs: 1, pollClosedMs: 1, latestEventId: 'cursor' };
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  mocks.state.wallet = 'wallet'; mocks.state.screen = 'base';
  mocks.readSaved.mockReset().mockReturnValue(null); mocks.save.mockClear(); mocks.deliver.mockClear();
  vi.mocked(startChatPoller).mockClear();
  vi.spyOn(chatApi, 'status').mockResolvedValue(status);
  vi.spyOn(chatApi, 'history').mockResolvedValue({ messages: [], nextBefore: null });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
test('ChatLauncher forwards the bridge to its single existing lazy ChatScreen', async () => {
  let read!: () => ChatOwnerProjection | null;
  const release = vi.fn(); const attach = vi.fn((get: () => ChatOwnerProjection | null) => { read = get; return release; });
  const bridge: ChatOwnerBridge = { wallet: 'wallet', sessionKey: 'session', isCurrent: () => true, attach };
  await act(async () => { root.render(<ChatLauncher ownerBridge={bridge} />); });
  assert.equal(attach.mock.calls.length, 0);
  const probe = vi.mocked(startChatPoller).mock.calls[0]![0];
  await act(async () => { await probe.poll(() => true); });
  const open = host.querySelector<HTMLButtonElement>('button[aria-label="Open global chat"]'); assert.ok(open);
  // Import completion only; no second render or second owner is introduced by the test.
  await act(async () => { open.click(); await import('../../chat/ChatScreen'); });
  assert.equal(attach.mock.calls.length, 1); assert.ok(read?.());
  assert.equal(host.querySelectorAll('[role="dialog"]').length, 1);
  assert.equal(host.querySelectorAll('textarea').length, 1);
  assert.equal(vi.mocked(chatApi.history).mock.calls.length, 1);
  await act(async () => { read!()!.actions.setBody('Original mounted owner'); });
  assert.equal(host.querySelector('textarea')?.value, 'Original mounted owner');
  await act(async () => { read!()!.actions.close(); });
  assert.equal(release.mock.calls.length, 1); assert.equal(read!(), null);
  assert.equal(host.querySelectorAll('textarea').length, 0);
});
test('TesterScreen forwards to its single wallet-keyed FeedbackTab and retires it on wallet change', async () => {
  mocks.state.screen = 'tester';
  let read!: () => FeedbackOwnerProjection | null;
  const release = vi.fn(); const attach = vi.fn((get: () => FeedbackOwnerProjection | null) => { read = get; return release; });
  const bridge: FeedbackOwnerBridge = { wallet: 'wallet', sessionKey: 'session', isCurrent: () => true, attach };
  await act(async () => { root.render(<TesterScreen ownerBridge={bridge} />); });
  assert.equal(attach.mock.calls.length, 0); assert.equal(mocks.readSaved.mock.calls.length, 0);
  const feedback = [...host.querySelectorAll('button')].find(button => button.textContent === 'FEEDBACK'); assert.ok(feedback);
  await act(async () => { feedback.click(); });
  assert.equal(attach.mock.calls.length, 1); assert.equal(mocks.readSaved.mock.calls.length, 1);
  assert.equal(host.querySelectorAll('textarea').length, 1);
  await act(async () => { read!()!.actions.setTitle('Existing owner'); });
  assert.equal(host.querySelector<HTMLInputElement>('input[aria-label="Feedback title"]')?.value, 'Existing owner');
  const held = read!; mocks.state.wallet = 'other';
  await act(async () => { root.render(<TesterScreen ownerBridge={{ ...bridge, wallet: 'other', sessionKey: 'other-session' }} />); });
  assert.equal(held(), null); assert.equal(release.mock.calls.length, 1);
  assert.equal(mocks.readSaved.mock.calls.length, 2); assert.equal(host.querySelectorAll('textarea').length, 1);
  assert.equal(read!()!.data.title, ''); assert.equal(mocks.save.mock.calls.length, 0); assert.equal(mocks.deliver.mock.calls.length, 0);
});
