/** D-134: server-only official FCM SDK. No Firebase notification auto-display. */
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { NOTIFICATIONS } from '@shardkeep/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { cert, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Message } from 'firebase-admin/messaging';
import type { Config } from '../config';
import type { DbOrTx } from '../db/client';
import { nativePushSubscriptions } from '../db/schema';
import type { PushDeliveryOutcome, PushPayload, PushSendOptions } from './webPush';

export type NativePushTarget = Pick<typeof nativePushSubscriptions.$inferSelect,
  'id' | 'wallet' | 'token' | 'bindingId' | 'packageName' | 'enabledAt'>;
export interface NativePushPayload {
  version: '1';
  bindingId: string;
  eventId: string;
  kind: PushPayload['kind'];
  title: string;
  body: string;
  url: string;
}
export type FcmTransport = (target: NativePushTarget, payload: NativePushPayload, opts: PushSendOptions) => Promise<void>;

const clip = (value: string, max: number): string => value.slice(0, max).replace(/[\uD800-\uDBFF]$/, '');
export function nativePushPayload(target: NativePushTarget, payload: PushPayload, eventId: string): NativePushPayload {
  return {
    version: '1', bindingId: target.bindingId, eventId, kind: payload.kind,
    title: clip(payload.title, 120), body: clip(payload.body, 500), url: payload.url,
  };
}

/** Exposed as a pure seam: tests assert the exact SDK message without keys or sends. */
export function fcmMessage(target: NativePushTarget, payload: NativePushPayload, opts: PushSendOptions): Message {
  return {
    token: target.token,
    data: { ...payload },
    android: {
      restrictedPackageName: target.packageName,
      priority: opts.urgency === 'high' ? 'high' : 'normal',
      ttl: opts.ttl * 1000,
    },
  };
}

export function makeFcmTransport(config: Pick<Config, 'FCM_NOTIFICATIONS_ENABLED' | 'FCM_SERVICE_ACCOUNT_FILE'>): FcmTransport | null {
  if (config.FCM_NOTIFICATIONS_ENABLED !== 'true') return null;
  const path = config.FCM_SERVICE_ACCOUNT_FILE;
  // Do not leak SDK parser messages, credential bytes or token values in errors.
  let messaging: ReturnType<typeof getMessaging>;
  try {
    if (!path || !isAbsolute(path)) throw new Error('path');
    const stat = statSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('permissions');
    const credential = cert(JSON.parse(readFileSync(path, 'utf8')));
    messaging = getMessaging(initializeApp({ credential }, `pkw-fcm-${randomUUID()}`));
  } catch {
    throw new Error('FCM requires a valid owner-readable service-account file (0600)');
  }
  return async (target, payload, opts) => {
    await messaging.send(fcmMessage(target, payload, opts));
  };
}

const exactLiveTarget = (target: NativePushTarget) => and(
  eq(nativePushSubscriptions.id, target.id), eq(nativePushSubscriptions.wallet, target.wallet),
  eq(nativePushSubscriptions.token, target.token), eq(nativePushSubscriptions.bindingId, target.bindingId),
  eq(nativePushSubscriptions.packageName, target.packageName), eq(nativePushSubscriptions.enabledAt, target.enabledAt),
  isNull(nativePushSubscriptions.disabledAt),
);

export async function sendToNativeSubscription(
  db: DbOrTx, transport: FcmTransport, target: NativePushTarget, payload: NativePushPayload,
  opts: PushSendOptions, now: Date,
): Promise<PushDeliveryOutcome> {
  // Recheck immediately before dispatch; an in-flight provider request still
  // carries its original binding, which the native client must reject after logout.
  const [live] = await db.select({ id: nativePushSubscriptions.id }).from(nativePushSubscriptions)
    .where(exactLiveTarget(target));
  if (!live) return 'disabled';
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // SDK requests can outlive this deadline. Never retry an uncertain send;
    // the SDK/provider may redeliver, so one original eventId also fences display.
    await Promise.race([
      transport(target, payload, opts),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('FCM deadline')), opts.timeout); }),
    ]);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
      await db.update(nativePushSubscriptions).set({ disabledAt: now }).where(exactLiveTarget(target));
      return 'disabled';
    }
    const [row] = await db.update(nativePushSubscriptions).set({
      failures: sql`${nativePushSubscriptions.failures} + 1`,
      disabledAt: sql`CASE WHEN ${nativePushSubscriptions.failures} + 1 >= ${NOTIFICATIONS.disableAfterFailures}
        THEN ${now.toISOString()}::timestamptz ELSE ${nativePushSubscriptions.disabledAt} END`,
    }).where(exactLiveTarget(target)).returning({ disabledAt: nativePushSubscriptions.disabledAt });
    return !row || row.disabledAt ? 'disabled' : 'failed';
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  await db.update(nativePushSubscriptions).set({ lastSuccessAt: now, failures: 0 }).where(exactLiveTarget(target));
  return 'sent';
}
