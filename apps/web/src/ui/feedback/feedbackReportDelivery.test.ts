/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest';
import { deliverFeedbackReport, FEEDBACK_DELIVERY_TIMEOUT_MS } from './feedbackReportDelivery';
import { readFeedbackSubmission, saveFeedbackSubmission, type FeedbackSubmission } from './feedbackSubmission';
const { post, binary } = vi.hoisted(() => ({ post: vi.fn(), binary: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { postRaw: post, postBinary: binary } }));
const initial: FeedbackSubmission = { requestId: 'create-once', category: 'bug', title: 'Private report', body: 'Please inspect these two screenshots.', context: {},
  screenshots: { replyRequestId: 'reply-once', files: [{ requestId: 'image-one' }, { requestId: 'image-two' }] } };
const a = '00000000-0000-4000-8000-000000000001', b = '00000000-0000-4000-8000-000000000002';
const files = new Map(['image-one','image-two'].map(id => [id, new File(['image'], id+'.png', { type: 'image/png' })]));
const run = (request: FeedbackSubmission, supplied = files) => deliverFeedbackReport('owner', request, supplied, new AbortController().signal, () => true, vi.fn());
afterEach(() => { localStorage.clear(); vi.clearAllMocks(); post.mockReset(); binary.mockReset(); vi.useRealTimers(); });
it('bounds a stalled create, retries the identical journal, and rejects late progress from the timed-out attempt', async () => {
  vi.useFakeTimers(); saveFeedbackSubmission('owner', initial);
  let late!: (value: unknown) => void;
  post.mockReturnValueOnce(new Promise(resolve => { late = resolve; }));
  const first = run(initial).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(FEEDBACK_DELIVERY_TIMEOUT_MS);
  expect(await first).toMatchObject({ message: expect.stringContaining('Retry to confirm the same report') });
  expect(post.mock.calls[0]?.[2].signal.aborted).toBe(true);
  expect(readFeedbackSubmission('owner')).toEqual(initial);
  post.mockResolvedValueOnce({ id: '00000000-0000-4000-8000-000000000101', basePoints: 0 }).mockResolvedValueOnce({});
  binary.mockResolvedValueOnce({ id: a }).mockResolvedValueOnce({ id: b });
  await run(readFeedbackSubmission('owner')!);
  expect(post.mock.calls[1]?.slice(0, 2)).toEqual(post.mock.calls[0]?.slice(0, 2));
  const saved = readFeedbackSubmission('owner');
  late({ id: '00000000-0000-4000-8000-000000000999', basePoints: 0 });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(readFeedbackSubmission('owner')).toEqual(saved);
  expect(binary).toHaveBeenCalledTimes(2);
});
it('bounds a stalled attachment reply while preserving all exact upload and reply receipts', async () => {
  vi.useFakeTimers(); saveFeedbackSubmission('owner', initial);
  post.mockResolvedValueOnce({ id: '00000000-0000-4000-8000-000000000101', basePoints: 0 }).mockReturnValueOnce(new Promise(() => undefined));
  binary.mockResolvedValueOnce({ id: a }).mockResolvedValueOnce({ id: b });
  const first = run(initial).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(FEEDBACK_DELIVERY_TIMEOUT_MS);
  expect(await first).toBeInstanceOf(Error);
  const saved = readFeedbackSubmission('owner')!;
  expect(saved.screenshots).toMatchObject({ replyPending: true, files: [{ attachmentId: a }, { attachmentId: b }] });
  post.mockResolvedValueOnce({}); await run(saved, new Map());
  expect(post.mock.calls[2]?.slice(0, 2)).toEqual(post.mock.calls[1]?.slice(0, 2));
  expect(binary).toHaveBeenCalledTimes(2);
});
it('never replies with a subset; an explicit retry skips completed upload and never creates another report', async () => {
  saveFeedbackSubmission('owner', initial); post.mockResolvedValue({ id: '00000000-0000-4000-8000-000000000101', basePoints: 0 });
  binary.mockResolvedValueOnce({ id: a }).mockRejectedValueOnce(new Error('lost upload')).mockResolvedValueOnce({ id: b });
  await expect(run(initial)).rejects.toThrow('lost upload');
  expect(post).toHaveBeenCalledTimes(1); expect(post.mock.calls[0]?.[1]).not.toHaveProperty('screenshots');
  const saved = readFeedbackSubmission('owner')!; expect(saved.screenshots).toMatchObject({ reportId: '00000000-0000-4000-8000-000000000101', files: [{ requestId: 'image-one', attachmentId: a }, { requestId: 'image-two' }] });
  await run(saved);
  expect(binary.mock.calls.map(c => c[0])).toEqual(['/tester/feedback/00000000-0000-4000-8000-000000000101/screenshots/image-one','/tester/feedback/00000000-0000-4000-8000-000000000101/screenshots/image-two','/tester/feedback/00000000-0000-4000-8000-000000000101/screenshots/image-two']);
  expect(post).toHaveBeenCalledTimes(2); expect(post.mock.calls[1]?.[1]).toEqual({ requestId: 'reply-once', body: '', visibility: 'reporter', attachmentIds: [a,b] });
});
it('restores all uploaded IDs after reload and safely repeats only the uncertain final reply', async () => {
  saveFeedbackSubmission('owner', initial); binary.mockResolvedValueOnce({ id: a }).mockResolvedValueOnce({ id: b });
  post.mockResolvedValueOnce({ id: '00000000-0000-4000-8000-000000000101', basePoints: 0 }).mockRejectedValueOnce(new Error('lost reply')).mockResolvedValueOnce({});
  await expect(run(initial)).rejects.toThrow('lost reply'); const saved = readFeedbackSubmission('owner')!;
  expect(saved.screenshots?.replyPending).toBe(true); await run(saved, new Map());
  expect(binary).toHaveBeenCalledTimes(2); expect(post.mock.calls[2]?.slice(0,2)).toEqual(post.mock.calls[1]?.slice(0,2));
});
it('keeps a created report pending when raw files disappeared; does not silently finish without them', async () => {
  const saved = { ...initial, screenshots: { ...initial.screenshots!, reportId: '00000000-0000-4000-8000-000000000102' } }; saveFeedbackSubmission('owner', saved);
  await expect(run(saved,new Map())).rejects.toThrow('LOCAL IMAGE FILES ARE MISSING');
  expect(post).not.toHaveBeenCalled(); expect(binary).not.toHaveBeenCalled(); expect(readFeedbackSubmission('owner')).toEqual(saved);
});
it('discards an accepted create response after an account switch before any private upload or local promotion', async () => {
  saveFeedbackSubmission('owner', initial); post.mockResolvedValue({ id: '00000000-0000-4000-8000-000000000101', basePoints: 0 });
  await expect(deliverFeedbackReport('owner', initial, files, new AbortController().signal, () => false, vi.fn())).rejects.toThrow('Account changed');
  expect(binary).not.toHaveBeenCalled(); expect(readFeedbackSubmission('owner')).toEqual(initial);
});
it('sends private evidence through its strict issue endpoint and attaches images to the reused report', async () => {
  const request = { ...initial, evidence: { issueId: a, mode: 'evidence' as const } }; saveFeedbackSubmission('owner',request);
  post.mockResolvedValueOnce({reportId:'00000000-0000-4000-8000-000000000103',basePoints:0,reused:true}).mockResolvedValueOnce({});
  binary.mockResolvedValueOnce({id:a}).mockResolvedValueOnce({id:b}); const result=await run(request);
  expect(result.id).toBe('00000000-0000-4000-8000-000000000103'); expect(post.mock.calls[0]?.[0]).toBe(`/tester/issues/${a}/evidence`);
  expect(post.mock.calls[0]?.[1]).toEqual({requestId:initial.requestId,mode:'evidence',title:initial.title,body:initial.body,context:{}});
  expect(post.mock.calls[1]?.[0]).toBe('/tester/feedback/00000000-0000-4000-8000-000000000103/replies'); expect(post.mock.calls[1]?.[1].attachmentIds).toEqual([a,b]);
});
