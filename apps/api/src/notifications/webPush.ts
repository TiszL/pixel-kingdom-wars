/**
 * M33 Web Push transport (D-101) — the only file that touches `web-push`.
 *
 * The sweep decides WHAT to send; this file knows HOW one subscription is
 * delivered to and what a delivery outcome does to the subscription row:
 * 404/410 from the push service means the browser unsubscribed (retire at
 * once), any other failure counts toward NOTIFICATIONS.disableAfterFailures,
 * and a success resets the counter. Tests inject a fake transport and drive
 * the same bookkeeping.
 */
import { NOTIFICATIONS, type NotificationKind } from '@shardkeep/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import webpush from 'web-push';
import type { Config } from '../config';
import type { DbOrTx } from '../db/client';
import { pushSubscriptions } from '../db/schema';

export type PushUrgency = (typeof NOTIFICATIONS.urgency)[NotificationKind];

/** What the service worker receives (`event.data.json()`); the client contract. */
export interface PushPayload {
  kind: NotificationKind;
  title: string;
  body: string;
  tag: NotificationKind;
  url: string;
}

export interface PushDeliveryTarget {
  id: string;
  wallet: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  enabledAt: Date;
}

export interface PushSendOptions {
  ttl: number;
  urgency: PushUrgency;
  topic: string;
  timeout: number;
}

/** Delivers one payload to one endpoint; rejects on any non-2xx (with a
 * `statusCode` when the push service answered) or transport error. */
export type PushTransport = (
  target: PushDeliveryTarget, payload: PushPayload, opts: PushSendOptions,
) => Promise<void>;

export type PushDeliveryOutcome = 'sent' | 'failed' | 'disabled';

/** Real transport. VAPID details are process-global in `web-push`; the worker
 * creates one transport at boot. Setting them on each construction also keeps
 * tests and an in-process config reload from retaining an older identity. */
export function makeWebPushTransport(
  config: Pick<Config, 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT'>,
): PushTransport {
  if (!config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY || !config.VAPID_SUBJECT) {
    throw new Error('web push transport requires VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT');
  }
  webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY);
  return async (target, payload, opts) => {
    await webpush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      JSON.stringify(payload),
      { TTL: opts.ttl, urgency: opts.urgency, topic: opts.topic, timeout: opts.timeout },
    );
  };
}

function pushStatusCode(e: unknown): number | null {
  const code = (e as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === 'number' ? code : null;
}

/** A transport result belongs only to the exact live capability snapshot it
 * started with. A concurrent re-key or revival must not inherit stale state. */
const exactLiveTarget = (target: PushDeliveryTarget) => and(
  eq(pushSubscriptions.id, target.id),
  eq(pushSubscriptions.wallet, target.wallet),
  eq(pushSubscriptions.p256dh, target.p256dh),
  eq(pushSubscriptions.auth, target.auth),
  eq(pushSubscriptions.enabledAt, target.enabledAt),
  isNull(pushSubscriptions.disabledAt),
);

/**
 * Sends and records the outcome on the subscription row. Never throws for a
 * delivery failure: one dead endpoint must not stop the wallet's other
 * subscriptions or the rest of the sweep.
 */
export async function sendToSubscription(
  db: DbOrTx,
  transport: PushTransport,
  target: PushDeliveryTarget,
  payload: PushPayload,
  opts: PushSendOptions,
  now: Date,
): Promise<PushDeliveryOutcome> {
  try {
    await transport(target, payload, opts);
  } catch (e) {
    const status = pushStatusCode(e);
    if (status === 404 || status === 410) {
      // The push service says this endpoint no longer exists (browser
      // unsubscribed, SW re-registered). Retire it now; a re-sync from the
      // client creates a fresh row.
      await db.update(pushSubscriptions)
        .set({ disabledAt: now })
        .where(exactLiveTarget(target));
      return 'disabled';
    }
    const [row] = await db.update(pushSubscriptions)
      .set({
        failures: sql`${pushSubscriptions.failures} + 1`,
        disabledAt: sql`CASE WHEN ${pushSubscriptions.failures} + 1 >= ${NOTIFICATIONS.disableAfterFailures}
          THEN ${now.toISOString()}::timestamptz ELSE ${pushSubscriptions.disabledAt} END`,
      })
      .where(exactLiveTarget(target))
      .returning({ disabledAt: pushSubscriptions.disabledAt });
    if (!row) return 'disabled';
    return row.disabledAt ? 'disabled' : 'failed';
  }
  await db.update(pushSubscriptions)
    .set({ lastSuccessAt: now, failures: 0 })
    .where(exactLiveTarget(target));
  return 'sent';
}
