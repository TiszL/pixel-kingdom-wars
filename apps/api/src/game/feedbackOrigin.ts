/** Which client sent a feedback report, reply or evidence (owner 2026-09-18:
 * "I want to receive android feedback visible marked sent from android app").
 *
 * The origin is derived HERE from request headers, never from a request body.
 * Headers are spoofable, so this is a DISPLAY label only: nothing may award
 * points, trust or access on it, and it stays outside every idempotency hash
 * (an app update between a lost response and its retry must replay, not 409). */
import { FEEDBACK_CLIENTS, FEEDBACK_CLIENT_RELEASE, type FeedbackClient } from '@shardkeep/shared/feedback';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

export interface FeedbackClientOrigin { client: FeedbackClient; clientRelease?: string }
/** The additive keys written beside the diagnostic context of a report or message. */
export const FeedbackClientOriginContext = z.object({
  client: z.enum(FEEDBACK_CLIENTS).optional(),
  clientRelease: z.string().regex(FEEDBACK_CLIENT_RELEASE).optional(),
});

const header = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
/** Closed vocabulary: exactly `X-PKW-Client: android-native` is the app, all else is web.
 * The release comes from `User-Agent: PKW-Native/<release>` and is dropped unless it is
 * the whole remainder, bounded, and made only of [0-9A-Za-z.:+-]. */
export function feedbackClientOrigin(headers: Record<string, unknown>): FeedbackClientOrigin {
  if (header(headers['x-pkw-client']) !== 'android-native') return { client: 'web' };
  const release = /^PKW-Native\/(.+)$/.exec(header(headers['user-agent']) ?? '')?.[1];
  return { client: 'android-native', ...(release && FEEDBACK_CLIENT_RELEASE.test(release) ? { clientRelease: release } : {}) };
}

/** SQL twin of the shared `feedbackOrigin` inference, for server-side list and
 * export filters: the stamped client wins, else the legacy native signature. */
export function feedbackOriginSql(context: SQL): SQL<FeedbackClient> {
  return sql<FeedbackClient>`case
    when ${context}->>'client' in ('android-native','web') then ${context}->>'client'
    when ${context}->>'platform'='android' and ${context}->>'screen'='feedback'
      and ${context}->>'build' ~* '^[0-9a-f]{40}$' then 'android-native'
    else 'web' end`;
}
