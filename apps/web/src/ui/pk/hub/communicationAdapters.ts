/** Presentation only. The existing private screen owners retain requests, cursors and journals. */
import type { ChatMessage } from '@shardkeep/shared';
import type { ChatStatus, ChatBlock, ChatReportReason, chatDraft } from '../../chat/protocol';
import type { FeedbackSubmission } from '../../feedback/feedbackSubmission';
import type { HubAction } from './HubSheets';
export interface ChatContentInput {
 wallet: string | null;
 snapshot: { wallet: string; status: ChatStatus; rows: Array<{ message: ChatMessage; delivery?: 'sending' | 'failed' }>;
  blocks: ChatBlock[]; nextBefore: string | null; blocksNext: string | null; newCount: number; reported: string[]; reporting: string | null } | null;
 body: string; draft: ReturnType<typeof chatDraft>; limits: { maxGraphemes: number; maxUtf8Bytes: number; maxLines: number };
 /** Existing ChatScreen REPORT_REASONS, exported by its owner; no second local catalogue. */
 reportReasons: ReadonlyArray<{ id: ChatReportReason; label: string }>;
 fresh: boolean; ready: boolean; loadingOlder: boolean; blocksBusy: boolean; blocksOpen: boolean;
 notice: string | null; formatTime: (value: string) => string;
}
export function chatContentModel(input: ChatContentInput) {
 const bound = !!input.wallet && input.snapshot?.wallet === input.wallet;
 const s = bound ? input.snapshot : null;
 const live = !!s?.status.enabled && input.fresh && input.ready;
 const canCompose = live && s!.status.canSend;
 const canEdit = !!s?.status.enabled && s.status.canSend;
 const status = s?.status;
 const reason = !s ? 'READING GLOBAL CHAT' : !status?.enabled ? 'GLOBAL CHAT IS NOT AVAILABLE'
  : !input.fresh ? 'CHAT IS RECONNECTING' : !input.ready ? 'READING GLOBAL CHAT'
  : status.canSend ? 'MESSAGE GLOBAL CHAT' : status.sendBlockedReason === 'USERNAME_REQUIRED' ? 'SET A USERNAME TO CHAT'
  : status.sendBlockedReason === 'DEED_REQUIRED' ? 'A DEED IS REQUIRED TO CHAT'
  : status.sendBlockedReason === 'MUTED' ? (status.mutedUntil ? `MUTED UNTIL ${input.formatTime(status.mutedUntil)}` : 'CHAT MUTED') : 'READ ONLY';
 const valid = input.draft.valid && input.draft.text === input.body.replace(/\r\n?/g, '\n');
 const send: HubAction = { id: 'chat.send', label: 'SEND', state: canCompose && valid ? 'ENABLED' : 'DISABLED', kind: 'action', reason: canCompose ? 'Enter a message within the shown limits.' : reason };
 return { bound, rows: s?.rows ?? [], blocks: s?.blocks ?? [], notice: bound ? input.notice : null, reason, canCompose, canEdit, canModerate: live,
  send, nextBefore: s?.nextBefore ?? null, blocksNext: s?.blocksNext ?? null, newCount: s?.newCount ?? 0,
  reported: s?.reported ?? [], reporting: s?.reporting ?? null };
}
/** Render only server-resolved UTF-16 spans. No client-side name guessing or HTML. */
export function mentionSegments(text: string, mentions: ChatMessage['mentions']) {
 const parts: Array<{ text: string; mention: boolean }> = []; let cursor = 0;
 for (const span of mentions ?? []) {
  if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < cursor || span.end <= span.start || span.end > text.length) continue;
  if (span.start > cursor) parts.push({ text: text.slice(cursor, span.start), mention: false });
  parts.push({ text: text.slice(span.start, span.end), mention: true }); cursor = span.end;
 }
 if (cursor < text.length) parts.push({ text: text.slice(cursor), mention: false });
 return parts;
}
/** Structural copy of the private FeedbackRow in screens/tester.tsx; export/hoist requires its owner. */
export interface PlayerFeedbackRow { id: string; category: string; title: string; body: string; status: string;
 importance: string | null; points: number; adminNote: string | null; createdAt: string; unread?: boolean;
 fixedAt?: string | null; fixedRef?: string | null }
export interface FeedbackContentInput {
 wallet: string | null;
 snapshot: { wallet: string; category: string; title: string; body: string; pending: FeedbackSubmission | null;
  busy: boolean; storageError: string | null; notice: string | null;
  evidenceIssue: { id: string; title: string; status: string; category: string } | null; recurrence: boolean;
  localImageIds: string[]; reports: PlayerFeedbackRow[] | null; loading: boolean; error: string | null; nextCursor: string | null } | null;
 limits: { categories: readonly string[]; titleMaxLen: number; bodyMinLen: number; bodyMaxLen: number };
 formatTime: (value: string) => string;
}
export type FeedbackCloseState = 'busy' | 'saved' | 'dirty' | 'clean';
export function feedbackContentModel(input: FeedbackContentInput) {
 const bound = !!input.wallet && input.snapshot?.wallet === input.wallet;
 const s = bound ? input.snapshot : null; const p = s?.pending ?? null;
 const title = p?.title ?? s?.title ?? ''; const body = p?.body ?? s?.body ?? ''; const category = p?.category ?? s?.category ?? '';
 const recurrenceNeeded = !!s?.evidenceIssue && ['fixed', 'closed'].includes(s.evidenceIssue.status);
 const missingImages = p?.screenshots?.files.filter(f => !f.attachmentId && !s?.localImageIds.includes(f.requestId)).length ?? 0;
 // A loaded saved request was validated by its original owner. New catalogue/limits cannot strand it.
 const invalid = !p && (!input.limits.categories.includes(category) || !title.trim() || title.length > input.limits.titleMaxLen
  || body.trim().length < input.limits.bodyMinLen || body.length > input.limits.bodyMaxLen);
 const reason = !bound ? 'Sign in with the report wallet.' : s?.storageError ? s.storageError : missingImages ? 'Reattach the original missing screenshots or explicitly clear missing files.'
  : !p && recurrenceNeeded && !s?.recurrence ? 'Confirm a new recurrence before sending evidence for a resolved issue.'
  : invalid ? `Choose a category, enter a title and at least ${input.limits.bodyMinLen} characters within the shown limits.` : '';
 const send: HubAction = { id: p ? `feedback.retry:${p.requestId}` : 'feedback.submit', label: s?.busy ? 'SENDING…'
  : p?.screenshots?.reportId ? 'RETRY SCREENSHOTS' : p ? 'RETRY SAVED REPORT' : s?.evidenceIssue ? 'SEND PRIVATE EVIDENCE' : 'SEND FEEDBACK',
  state: s?.busy ? 'BUSY' : reason ? 'DISABLED' : 'ENABLED', kind: p ? 'recover' : 'action', reason };
 const closeState: FeedbackCloseState = s?.busy ? 'busy' : p ? 'saved' : title.trim() || body.trim() || s?.localImageIds.length || s?.evidenceIssue ? 'dirty' : 'clean';
 return { bound, title, body, category, pending: p, reason, send, editable: bound && !s?.busy && !p,
  canPickImages: bound && !s?.busy && !s?.storageError && !p?.screenshots?.replyPending,
  canClearMissing: bound && !s?.busy && !s?.storageError && missingImages > 0 && !p?.screenshots?.replyPending,
  missingImages, closeState, recurrenceNeeded, evidence: p?.evidence ? { title: p.title, mode: p.evidence.mode } : s?.evidenceIssue ? { title: s.evidenceIssue.title, mode: s.recurrence ? 'recurrence' : 'evidence' } : null,
  pendingNote: !p ? null : p.screenshots?.reportId ? p.screenshots.replyPending ? 'REPORT SAVED. SCREENSHOTS AWAIT ATTACHMENT CONFIRMATION.' : 'REPORT SAVED. SCREENSHOTS STILL NEED UPLOADING.' : 'A SAVED REPORT AWAITS CONFIRMATION. RETRY TO RECOVER THE SAME REPORT.',
  notice: s?.notice ?? null, listError: s?.error ?? null, listLoading: s?.loading ?? false, hasReports: s?.reports !== null && s?.reports !== undefined,
  nextCursor: s?.nextCursor ?? null, reports: (s?.reports ?? []).map(r => ({ ...r, points: Number.isSafeInteger(r.points) && r.points >= 0 ? String(r.points).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '…', date: input.formatTime(r.createdAt) })) };
}
const feedbackLabels: Record<string, string> = { bug: 'BUG', balance: 'BALANCE', ux: 'UX / CONFUSING', idea: 'IDEA', other: 'OTHER' };
export const feedbackCategoryLabel = (category: string) => feedbackLabels[category] ?? category.toUpperCase();
