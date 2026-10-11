import type { FeedbackAttachmentDto } from '@shardkeep/shared/feedback';
import { api } from '../../lib/api';
import { waitForCaller } from '../../lib/callerCancellation';
import { advanceFeedbackSubmission, type FeedbackSubmission } from './feedbackSubmission';

/** One user-confirmed delivery. Every stage records its exact receipt before
 * continuing; an error stops the remaining stages until an explicit retry. */
export const FEEDBACK_DELIVERY_TIMEOUT_MS = 30_000;
export async function deliverFeedbackReport(wallet: string, initial: FeedbackSubmission, files: ReadonlyMap<string, File>,
  signal: AbortSignal, isCurrent: () => boolean, onProgress: (request: FeedbackSubmission, phase: string) => void,
): Promise<{ request: FeedbackSubmission; id: string; basePoints: number }> {
  const controller = new AbortController();
  const cancel = (): void => controller.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new Error(
    'Sending paused. Your report is saved on this device. Retry to confirm the same report.',
  )), FEEDBACK_DELIVERY_TIMEOUT_MS);
  try {
    return await waitForCaller(deliver(wallet, initial, files, controller.signal, isCurrent, onProgress), controller.signal);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}

async function deliver(wallet: string, initial: FeedbackSubmission, files: ReadonlyMap<string, File>,
  signal: AbortSignal, isCurrent: () => boolean, onProgress: (request: FeedbackSubmission, phase: string) => void,
): Promise<{ request: FeedbackSubmission; id: string; basePoints: number }> {
  let request = initial;
  const check = (): void => { signal.throwIfAborted(); if (!isCurrent()) throw new Error('Account changed. Reopen feedback.'); };
  check();
  const progress = (shots: NonNullable<FeedbackSubmission['screenshots']>, phase: string): void => {
    check(); request = advanceFeedbackSubmission(wallet, request, shots); onProgress(request, phase);
  };
  let id = request.screenshots?.reportId; let basePoints = 0;
  if (!id) {
    const { screenshots: _screenshots, evidence, ...body } = request;
    const receipt = evidence
      ? await api.postRaw<{ reportId: string; basePoints: number }>(`/tester/issues/${evidence.issueId}/evidence`, { requestId: body.requestId, mode: evidence.mode, title: body.title, body: body.body, context: body.context }, { signal })
      : await api.postRaw<{ id: string; basePoints: number }>('/tester/feedback', body, { signal });
    check(); id = 'reportId' in receipt ? receipt.reportId : receipt.id; basePoints = receipt.basePoints;
    if (request.screenshots) progress({ ...request.screenshots, reportId: id }, 'REPORT SAVED — UPLOADING SCREENSHOTS');
  }
  if (request.screenshots) {
    for (const item of request.screenshots.files) {
      if (item.attachmentId) continue;
      const file = files.get(item.requestId);
      if (!file) throw new Error('REPORT SAVED — LOCAL IMAGE FILES ARE MISSING. REATTACH THE ORIGINAL SCREENSHOTS OR CLEAR MISSING FILES.');
      const image = await api.postBinary<FeedbackAttachmentDto>(`/tester/feedback/${id}/screenshots/${item.requestId}`, file, { signal });
      check(); progress({ ...request.screenshots, files: request.screenshots.files.map(f => f.requestId === item.requestId ? { ...f, attachmentId: image.id } : f) }, 'REPORT SAVED — UPLOADING SCREENSHOTS');
    }
    const shots = request.screenshots;
    if (shots.files.length) {
      progress({ ...shots, replyPending: true }, 'REPORT SAVED — ATTACHING SCREENSHOTS');
      await api.postRaw(`/tester/feedback/${id}/replies`, { requestId: shots.replyRequestId, body: '', visibility: 'reporter', attachmentIds: shots.files.map(f => f.attachmentId!) }, { signal });
      check();
    }
  }
  return { request, id, basePoints };
}
