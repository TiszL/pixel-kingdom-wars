/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearFeedbackSubmission, readFeedbackSubmission, saveFeedbackSubmission, type FeedbackSubmission } from './feedbackSubmission';
const request: FeedbackSubmission = { requestId: 'original-request', category: 'bug', title: 'Cannot build', body: 'The build button does not respond.', context: { screen: 'tester', build: 'revision' } };
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
describe('private report recovery', () => {
  it('restores the exact request for the same wallet and prevents replacing an uncertain submission', () => {
    saveFeedbackSubmission('wallet-one', request);
    expect(readFeedbackSubmission('wallet-one')).toEqual(request);
    expect(readFeedbackSubmission('wallet-two')).toBeNull();
    expect(() => saveFeedbackSubmission('wallet-one', { ...request, requestId: 'replacement' })).toThrow('earlier report needs recovery');
    expect(() => clearFeedbackSubmission('wallet-one', { ...request, body: 'Different body' })).toThrow('saved report changed');
    clearFeedbackSubmission('wallet-one', request); expect(readFeedbackSubmission('wallet-one')).toBeNull();
  });
  it('rejects malformed saved screenshot report IDs before constructing a recovery route', () => {
    for (const reportId of ['', '../other-report', 'not-a-uuid', 123]) {
      const raw = JSON.stringify({ version: 1, wallet: 'wallet', request: { ...request,
        screenshots: { replyRequestId: 'reply', reportId, files: [{ requestId: 'upload' }] } } });
      localStorage.setItem('pkw:feedback-submission:v1:wallet', raw);
      expect(() => readFeedbackSubmission('wallet')).toThrow('working site storage');
      expect(localStorage.getItem('pkw:feedback-submission:v1:wallet')).toBe(raw);
    }
    for (const reportId of [undefined, '12345678-1234-4234-8234-123456789abc']) {
      const original = { ...request, screenshots: { replyRequestId: 'reply', reportId, files: [{ requestId: 'upload' }] } };
      localStorage.setItem('pkw:feedback-submission:v1:wallet', JSON.stringify({ version: 1, wallet: 'wallet', request: original }));
      expect(readFeedbackSubmission('wallet')).toEqual(original);
    }
  });
  it('fails closed on unavailable or corrupted storage rather than silently dropping retry identity', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('quota'); } });
    expect(() => saveFeedbackSubmission('wallet', request)).toThrow('working site storage');
    vi.unstubAllGlobals();
    localStorage.setItem('pkw:feedback-submission:v1:wallet', '{broken');
    expect(() => readFeedbackSubmission('wallet')).toThrow('working site storage');
    expect(() => saveFeedbackSubmission('wallet', request)).toThrow('working site storage');
    expect(localStorage.getItem('pkw:feedback-submission:v1:wallet')).toBe('{broken');
  });
});
