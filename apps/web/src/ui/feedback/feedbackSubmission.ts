import { TESTER_PROGRAM } from '@shardkeep/shared';
import { FEEDBACK_SCREENSHOTS, FEEDBACK_THREADS } from '@shardkeep/shared/feedback';

export interface FeedbackSubmission {
  requestId: string; category: string; title: string; body: string; context: Record<string, unknown>;
  evidence?: { issueId: string; mode: 'evidence' | 'recurrence' };
  screenshots?: { replyRequestId: string; reportId?: string; replyPending?: boolean; files: Array<{ requestId: string; attachmentId?: string }> };
}
const key = (wallet: string): string => `pkw:feedback-submission:v1:${wallet}`;
const validRequestId = (value: unknown): value is string => typeof value === 'string' && value.length <= FEEDBACK_THREADS.requestIdMaxLen && /^[A-Za-z0-9_-]+$/.test(value);
const message = 'Feedback recovery needs working site storage. Keep your browser data and retry.';
export function readFeedbackSubmission(wallet: string): FeedbackSubmission | null {
  try {
    const raw = localStorage.getItem(key(wallet)); if (raw === null) return null;
    const row = JSON.parse(raw) as { wallet: string; version: number; request: FeedbackSubmission };
    const r = row?.request; const cfg = TESTER_PROGRAM.feedback;
    if (row?.wallet !== wallet || row.version !== 1 || !r || typeof r.requestId !== 'string'
      || !/^[A-Za-z0-9_-]+$/.test(r.requestId) || r.requestId.length > FEEDBACK_THREADS.requestIdMaxLen
      || !(cfg.categories as readonly string[]).includes(r.category) || typeof r.title !== 'string' || !r.title.trim() || r.title.length > cfg.titleMaxLen
      || typeof r.body !== 'string' || r.body.length < cfg.bodyMinLen || r.body.length > cfg.bodyMaxLen
      || (r.evidence !== undefined && (!r.evidence || typeof r.evidence.issueId !== 'string' || !/^[0-9a-f-]{36}$/i.test(r.evidence.issueId) || !['evidence','recurrence'].includes(r.evidence.mode)))
      || (r.screenshots !== undefined && (!r.screenshots || !validRequestId(r.screenshots.replyRequestId)
        || (r.screenshots.reportId !== undefined && (typeof r.screenshots.reportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(r.screenshots.reportId)))
        || (r.screenshots.replyPending !== undefined && typeof r.screenshots.replyPending !== 'boolean')
        || !Array.isArray(r.screenshots.files) || r.screenshots.files.length > FEEDBACK_SCREENSHOTS.maxPerMessage
        || new Set(r.screenshots.files.map(f => f?.requestId)).size !== r.screenshots.files.length
        || (r.screenshots.replyPending && r.screenshots.files.some(f => !f?.attachmentId))
        || r.screenshots.files.some(f => !f || !validRequestId(f.requestId) || (f.attachmentId !== undefined && !/^[0-9a-f-]{36}$/i.test(f.attachmentId)))))
      || !r.context || typeof r.context !== 'object' || Array.isArray(r.context)) throw new Error(message);
    return r;
  } catch { throw new Error(message); }
}
export function saveFeedbackSubmission(wallet: string, request: FeedbackSubmission): void {
  const previous = readFeedbackSubmission(wallet);
  if (previous && JSON.stringify(previous) !== JSON.stringify(request)) throw new Error('An earlier report needs recovery. Reopen feedback before sending another.');
  try {
    const raw = JSON.stringify({ version: 1, wallet, request });
    localStorage.setItem(key(wallet), raw);
    if (localStorage.getItem(key(wallet)) !== raw) throw new Error(message);
  } catch { throw new Error(message); }
}
export function clearFeedbackSubmission(wallet: string, request: FeedbackSubmission): void {
  if (JSON.stringify(readFeedbackSubmission(wallet)) !== JSON.stringify(request)) throw new Error('The saved report changed. Reopen feedback to recover it.');
  try { localStorage.removeItem(key(wallet)); if (localStorage.getItem(key(wallet)) !== null) throw new Error(message); }
  catch { throw new Error(message); }
}

/** Advance only this immutable report's delivery receipt, never overwrite a
 * concurrent tab's newer progress or change the reviewed report text. */
export function advanceFeedbackSubmission(wallet: string, expected: FeedbackSubmission, screenshots: NonNullable<FeedbackSubmission['screenshots']>): FeedbackSubmission {
  if (JSON.stringify(readFeedbackSubmission(wallet)) !== JSON.stringify(expected)) throw new Error('Report delivery changed in another tab. Reopen feedback to recover it.');
  const next = { ...expected, screenshots };
  try {
    const raw = JSON.stringify({ version: 1, wallet, request: next }); localStorage.setItem(key(wallet), raw);
    if (localStorage.getItem(key(wallet)) !== raw) throw new Error(message);
  } catch { throw new Error(message); }
  return next;
}
