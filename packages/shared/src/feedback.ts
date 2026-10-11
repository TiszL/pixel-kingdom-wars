/** Private-feedback contract subpath; avoid a new first-paint import. */
export { FEEDBACK_SCREENSHOTS, FEEDBACK_THREADS, FEEDBACK_ISSUES, FEEDBACK_EXPORTS } from './constants';
import { FEEDBACK_THREADS } from './constants';

export type FeedbackActorMode = 'reporter' | 'admin';
export type FeedbackVisibility = 'reporter' | 'admin';
export interface FeedbackAttachmentDto {
  id: string; width: number | null; height: number | null; byteLength: number | null;
  contentType: string | null; expired: boolean;
  /** Admin responses only; absent for reporters to hide private preservation. */
  preserved?: boolean;
}
export interface FeedbackMessageDto {
  attachments?: FeedbackAttachmentDto[];
  id: string; revision: number; body: string; kind: 'reply' | 'status' | 'note';
  visibility: FeedbackVisibility; authorRole: FeedbackActorMode; createdAt: string;
  /** Admin response only. Never needed to render a reporter's thread. */
  author?: string;
}
export interface FeedbackReportDto {
  id: string; category: string; title: string; body: string; status: string;
  importance: string | null; points: number; adminNote: string | null; createdAt: string;
  fixedAt: string | null; fixedRef: string | null; locked: boolean; closed: boolean;
  /** Admin response only. */
  wallet?: string; context?: unknown; revision?: number;
  rewardPolicyVersion?: number; basePoints?: number; bonusPoints?: number;
  verificationVerdict?: 'unverified' | 'actionable' | 'not_actionable';
  trashed?: boolean; trashedAt?: string | null;
  linkedIssue?: { id: string; title: string; revision: number; status: string; publishedAt: string | null; mergedInto: string | null } | null;
}
export interface FeedbackThreadDto {
  report: FeedbackReportDto; messages: FeedbackMessageDto[]; hasMore: boolean;
  oldestRevision: number; hasEarlier: boolean;
  nextRevision: number; latestRevision: number; readRevision: number; unread: boolean;
}

/** Published allowlist only; private reports/identities never ride this DTO. */
export interface FeedbackPublishedIssueDto {
  id: string; title: string; summary: string; category: string; status: string;
  workaround: string | null; fixedRelease: string | null; affectedPlayerCount: number;
}

/** Which client sent a report (owner 2026-09-18: Android-app reports must be
 * tellable apart from web ones). DISPLAY ONLY: the server derives it from
 * spoofable request headers, so nothing may award points, trust or access on it. */
export const FEEDBACK_CLIENTS = ['android-native', 'web'] as const;
export type FeedbackClient = (typeof FEEDBACK_CLIENTS)[number];
/** The release the native app names in `User-Agent: PKW-Native/<release>`. */
export const FEEDBACK_CLIENT_RELEASE = new RegExp(`^[0-9A-Za-z.:+-]{1,${FEEDBACK_THREADS.clientReleaseMaxLen}}$`);
export interface FeedbackOrigin { client: FeedbackClient; label: string; release?: string; platform?: string }
const ORIGIN_PLATFORMS = ['desktop', 'android', 'ios', 'web', 'unknown'];

/** Read-time origin of a stored report context; needs no backfill migration.
 * A server-stamped `client` wins. Rows older than the stamp are native only when
 * they carry the native app's signature: platform android + screen "feedback" +
 * a full 40-hex build (the web client sends screen "tester" and a 7-hex sha).
 * `feedbackOriginSql` in apps/api mirrors this rule; change both together. */
export function feedbackOrigin(context: unknown): FeedbackOrigin {
  const c = (context !== null && typeof context === 'object' ? context : {}) as Record<string, unknown>;
  const stored = FEEDBACK_CLIENTS.find(client => client === c['client']);
  const legacyNative = c['platform'] === 'android' && c['screen'] === 'feedback'
    && typeof c['build'] === 'string' && /^[0-9a-f]{40}$/i.test(c['build']);
  const client: FeedbackClient = stored ?? (legacyNative ? 'android-native' : 'web');
  if (client === 'android-native') {
    const release = typeof c['clientRelease'] === 'string' && FEEDBACK_CLIENT_RELEASE.test(c['clientRelease']) ? c['clientRelease'] : undefined;
    return { client, label: release ? `ANDROID APP ${release}` : 'ANDROID APP', ...(release ? { release } : {}) };
  }
  const platform = ORIGIN_PLATFORMS.find(name => name === c['platform']);
  return { client, label: platform ? `WEB · ${platform}` : 'WEB', ...(platform ? { platform } : {}) };
}
