/**
 * M33 notification sweep (D-101). Runs on the worker every
 * NOTIFICATIONS.sweepEveryMs and pushes four kinds of event to the wallets
 * that hold a live subscription:
 *
 *   raided    raids.status='resolved' with a defender (PvP only — PvE and
 *             campaign raids have no defender_wallet and never notify)
 *   build     builder_jobs.finishes_at <= now — REGARDLESS of completed_at,
 *             because completion is lazy (set on the player's next read) and
 *             a player who is not looking is exactly who needs the push
 *   training  training_queue (per wallet) and base_training_queue (per base,
 *             joined to bases.owner_wallet), same lazy rule; cancelled rows and
 *             paid early completions (completed_at < finishes_at) are excluded
 *   mail      mail_messages.created_at
 *
 * At-most-once: every candidate is claimed with
 * INSERT INTO push_events … ON CONFLICT (kind, ref_id) DO NOTHING RETURNING,
 * and only the returned rows are sent — two workers, a crash between claim and
 * send, or the same row seen by a later sweep can never push twice. Everything
 * is bounded by NOTIFICATIONS.sweepLookbackMs so the first deploy does not
 * flood players with history, and only wallets that hold a live subscription
 * are scanned at all.
 */
import { randomUUID } from 'node:crypto';
import { NOTIFICATIONS, type NotificationKind } from '@shardkeep/shared';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { nativePushSubscriptions, pushEvents, pushSubscriptions } from '../db/schema';
import {
  sendToSubscription, type PushDeliveryTarget, type PushPayload, type PushTransport,
} from './webPush';
import { claimDueMineFullGroups } from './mineFull';
import { nativePushPayload, sendToNativeSubscription, type FcmTransport } from './fcm';

const SCREEN_URL: Record<NotificationKind, string> = {
  raided: '/?screen=raidlog',
  mine_full: '/?screen=base',
  mail: '/?screen=mail',
  build: '/?screen=base',
  training: '/?screen=base',
};

export interface SweepSummary {
  /** Rows claimed this sweep (one per source row, before batching). */
  claimed: number;
  /** Pushes handed to the transport (one per wallet group). */
  sent: number;
  failed: number;
  capped: number;
  /** Wallets whose build/training push waits for a job finishing inside the batch window. */
  held: number;
}

interface Candidate { refId: string; wallet: string; occurredAt: Date }
interface RaidCandidate extends Candidate { attackerName: string | null }
interface MailCandidate extends Candidate { subject: string }
interface WorkCandidate extends Candidate { kind: 'build' | 'training' }

/** A group of source rows that becomes ONE push to one wallet. */
interface PushGroup {
  wallet: string;
  /** Oldest source represented by this payload; only consent predating it is eligible. */
  occurredAt: Date;
  refs: ReadonlyArray<{ kind: NotificationKind; refId: string }>;
  payload: PushPayload;
}

function payloadFor(kind: NotificationKind, title: string, body: string): PushPayload {
  return { kind, title, body, tag: kind, url: SCREEN_URL[kind] };
}

interface DeliveryChannels { web: boolean; native: boolean }
const eligibleSubscriptionExists = (walletColumn: string, occurredExpr: string, channels: DeliveryChannels) => sql.raw(
  '(' + [
    ...(channels.web ? [`EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.wallet = ${walletColumn} AND s.disabled_at IS NULL AND s.enabled_at <= ${occurredExpr})`] : []),
    ...(channels.native ? [`EXISTS (SELECT 1 FROM native_push_subscriptions s WHERE s.wallet = ${walletColumn} AND s.disabled_at IS NULL AND s.enabled_at <= ${occurredExpr})`] : []),
  ].join(' OR ') + ')',
);
const notYetClaimed = (kind: NotificationKind, refExpr: string) => sql.raw(
  `NOT EXISTS (SELECT 1 FROM push_events e WHERE e.kind = '${kind}' AND e.ref_id = ${refExpr})`,
);

async function raidCandidates(db: Db, since: Date, now: Date, channels: DeliveryChannels): Promise<RaidCandidate[]> {
  const rows = await db.execute(sql`
    SELECT r.id::text AS "refId", r.defender_wallet AS "wallet", r.resolved_at AS "occurredAt",
      NULLIF(p.name, '') AS "attackerName"
    FROM raids r
    LEFT JOIN players p ON p.wallet = r.attacker_wallet
    WHERE r.status = 'resolved' AND r.defender_wallet IS NOT NULL
      AND r.resolved_at > ${since.toISOString()}::timestamptz
      AND r.resolved_at <= ${now.toISOString()}::timestamptz
      AND ${eligibleSubscriptionExists('r.defender_wallet', 'r.resolved_at', channels)}
      AND ${notYetClaimed('raided', 'r.id::text')}
    ORDER BY r.resolved_at ASC
  `);
  return rows as unknown as RaidCandidate[];
}

async function mailCandidates(db: Db, since: Date, now: Date, channels: DeliveryChannels): Promise<MailCandidate[]> {
  const rows = await db.execute(sql`
    SELECT m.id::text AS "refId", m.recipient_wallet AS "wallet", m.created_at AS "occurredAt",
      m.subject AS "subject"
    FROM mail_messages m
    WHERE m.created_at > ${since.toISOString()}::timestamptz
      AND m.created_at <= ${now.toISOString()}::timestamptz
      AND ${eligibleSubscriptionExists('m.recipient_wallet', 'm.created_at', channels)}
      AND ${notYetClaimed('mail', 'm.id::text')}
    ORDER BY m.created_at ASC
  `);
  return rows as unknown as MailCandidate[];
}

async function workCandidates(db: Db, since: Date, now: Date, channels: DeliveryChannels): Promise<WorkCandidate[]> {
  const rows = await db.execute(sql`
    SELECT 'build' AS "kind", j.id::text AS "refId", j.player_wallet AS "wallet",
      j.finishes_at AS "occurredAt"
    FROM builder_jobs j
    WHERE j.cancelled_at IS NULL
      AND j.finishes_at > ${since.toISOString()}::timestamptz
      AND j.finishes_at <= ${now.toISOString()}::timestamptz
      AND ${eligibleSubscriptionExists('j.player_wallet', 'j.finishes_at', channels)}
      AND ${notYetClaimed('build', 'j.id::text')}
    UNION ALL
    SELECT 'training', 'training_queue:' || q.id::text, q.player_wallet, q.finishes_at
    FROM training_queue q
    WHERE q.cancelled_at IS NULL
      AND q.finishes_at > ${since.toISOString()}::timestamptz
      AND q.finishes_at <= ${now.toISOString()}::timestamptz
      AND (q.completed_at IS NULL OR q.completed_at >= q.finishes_at)
      AND ${eligibleSubscriptionExists('q.player_wallet', 'q.finishes_at', channels)}
      AND ${notYetClaimed('training', "'training_queue:' || q.id::text")}
    UNION ALL
    SELECT 'training', 'base_training_queue:' || q.id::text, b.owner_wallet, q.finishes_at
    FROM base_training_queue q
    JOIN bases b ON b.id = q.base_id
    WHERE q.cancelled_at IS NULL
      AND q.finishes_at > ${since.toISOString()}::timestamptz
      AND q.finishes_at <= ${now.toISOString()}::timestamptz
      AND (q.completed_at IS NULL OR q.completed_at >= q.finishes_at)
      AND ${eligibleSubscriptionExists('b.owner_wallet', 'q.finishes_at', channels)}
      AND ${notYetClaimed('training', "'base_training_queue:' || q.id::text")}
  `);
  return rows as unknown as WorkCandidate[];
}

/** Wallets with another build/training job finishing inside the batch window:
 * their push waits so back-to-back finishes become one notification. */
async function walletsWithImminentWork(
  db: Db, oldestDue: ReadonlyMap<string, Date>, now: Date, channels: DeliveryChannels,
): Promise<Set<string>> {
  const openWindows = new Map([...oldestDue].filter(([, due]) =>
    now.getTime() - due.getTime() < NOTIFICATIONS.batchWindowMs));
  if (openWindows.size === 0) return new Set();
  const until = new Date(Math.max(...[...openWindows.values()].map((due) =>
    due.getTime() + NOTIFICATIONS.batchWindowMs)));
  const rows = await db.execute(sql`
    SELECT wallet, "finishesAt" FROM (
      SELECT j.player_wallet AS wallet, j.finishes_at AS "finishesAt" FROM builder_jobs j
      WHERE j.completed_at IS NULL
        AND j.finishes_at > ${now.toISOString()}::timestamptz
        AND j.finishes_at <= ${until.toISOString()}::timestamptz
        AND ${eligibleSubscriptionExists('j.player_wallet', 'j.finishes_at', channels)}
      UNION ALL
      SELECT q.player_wallet, q.finishes_at FROM training_queue q
      WHERE q.completed_at IS NULL AND q.cancelled_at IS NULL
        AND q.finishes_at > ${now.toISOString()}::timestamptz
        AND q.finishes_at <= ${until.toISOString()}::timestamptz
        AND ${eligibleSubscriptionExists('q.player_wallet', 'q.finishes_at', channels)}
      UNION ALL
      SELECT b.owner_wallet, q.finishes_at FROM base_training_queue q
      JOIN bases b ON b.id = q.base_id
      WHERE q.completed_at IS NULL AND q.cancelled_at IS NULL
        AND q.finishes_at > ${now.toISOString()}::timestamptz
        AND q.finishes_at <= ${until.toISOString()}::timestamptz
        AND ${eligibleSubscriptionExists('b.owner_wallet', 'q.finishes_at', channels)}
    ) imminent
  `);
  const held = new Set<string>();
  for (const row of rows as unknown as Array<{ wallet: string; finishesAt: Date }>) {
    const due = openWindows.get(row.wallet);
    if (due && new Date(row.finishesAt).getTime() <= due.getTime() + NOTIFICATIONS.batchWindowMs) {
      held.add(row.wallet);
    }
  }
  return held;
}

function workPayload(builds: number, trainings: number): PushPayload {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (builds > 0 && trainings > 0) {
    return payloadFor('build', 'BUILD & TRAINING FINISHED',
      `${plural(builds, 'builder job', 'builder jobs')} and ${plural(trainings, 'troop', 'troops')} are ready.`);
  }
  if (builds > 0) {
    return payloadFor('build', 'BUILD FINISHED',
      `${plural(builds, 'builder job is', 'builder jobs are')} done — your builders are free.`);
  }
  return payloadFor('training', 'TRAINING FINISHED',
    `${plural(trainings, 'troop has', 'troops have')} joined your army.`);
}

async function pushesSentLastHour(db: Db, wallet: string, now: Date): Promise<number> {
  // One delivery UUID is shared by every source row in a collapsed batch.
  // sent_at cannot be the identity: every group in one sweep receives the same
  // `now`, which used to make twelve distinct pushes count as one.
  const [row] = await db.select({ n: sql<number>`count(DISTINCT ${pushEvents.deliveryId})::int` })
    .from(pushEvents)
    .where(and(
      eq(pushEvents.wallet, wallet),
      gt(pushEvents.sentAt, new Date(now.getTime() - NOTIFICATIONS.hourlyWindowMs)),
    ));
  return row?.n ?? 0;
}

async function deliverGroup(
  db: Db, transport: PushTransport | null, group: PushGroup, now: Date, summary: SweepSummary,
  fcmTransport: FcmTransport | undefined, alreadyClaimed = false,
): Promise<void> {
  // Claim first: the primary key makes this the at-most-once decision. A row
  // that was claimed by another worker or an earlier sweep simply comes back
  // empty here and is never sent again.
  const claimed = alreadyClaimed
    ? group.refs.map((ref) => ({ kind: ref.kind, refId: ref.refId }))
    : await db.insert(pushEvents)
      .values(group.refs.map((ref) => ({ kind: ref.kind, refId: ref.refId, wallet: group.wallet, createdAt: now })))
      .onConflictDoNothing()
      .returning({ kind: pushEvents.kind, refId: pushEvents.refId });
  if (claimed.length === 0) return;
  summary.claimed += claimed.length;
  const claimedRows = and(
    eq(pushEvents.wallet, group.wallet),
    or(...claimed.map((c) => and(eq(pushEvents.kind, c.kind), eq(pushEvents.refId, c.refId)))),
  );

  if (await pushesSentLastHour(db, group.wallet, now) >= NOTIFICATIONS.perWalletHourlyCap) {
    await db.update(pushEvents).set({ outcome: 'capped' }).where(claimedRows);
    summary.capped += 1;
    return;
  }

  const targets: PushDeliveryTarget[] = transport ? await db.select({
    id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint,
    p256dh: pushSubscriptions.p256dh, auth: pushSubscriptions.auth,
    wallet: pushSubscriptions.wallet, enabledAt: pushSubscriptions.enabledAt,
  }).from(pushSubscriptions)
    .where(and(
      eq(pushSubscriptions.wallet, group.wallet),
      isNull(pushSubscriptions.disabledAt),
      sql`${pushSubscriptions.enabledAt} <= ${group.occurredAt.toISOString()}::timestamptz`,
    )) : [];
  const nativeTargets = fcmTransport ? await db.select().from(nativePushSubscriptions).where(and(
    eq(nativePushSubscriptions.wallet, group.wallet), isNull(nativePushSubscriptions.disabledAt),
    sql`${nativePushSubscriptions.enabledAt} <= ${group.occurredAt.toISOString()}::timestamptz`,
  )) : [];
  // Global queue concurrency normally means every ref in the group is ours.
  // The primary key remains the last line of defence: should another caller
  // claim a subset first, never describe its rows again in this push.
  const claimedKeys = new Set(claimed.map((c) => `${c.kind}\0${c.refId}`));
  const claimedRefs = group.refs.filter((r) => claimedKeys.has(`${r.kind}\0${r.refId}`));
  const payload = claimedRefs.every((r) => r.kind === 'build' || r.kind === 'training')
    ? workPayload(
        claimedRefs.filter((r) => r.kind === 'build').length,
        claimedRefs.filter((r) => r.kind === 'training').length,
      )
    : group.payload;
  const opts = {
    ttl: NOTIFICATIONS.ttlSec[payload.kind],
    urgency: NOTIFICATIONS.urgency[payload.kind],
    topic: payload.kind,
    timeout: NOTIFICATIONS.deliveryTimeoutMs,
  };
  // A wallet has at most five endpoints. Deliver those concurrently so one
  // dead push service cannot multiply the bounded request timeout by five;
  // wallet groups remain sequential and therefore bound provider pressure.
  const eventId = randomUUID();
  const outcomes = await Promise.all([
    ...targets.map((target) => sendToSubscription(db, transport!, target, payload, opts, now)),
    ...nativeTargets.map((target) => sendToNativeSubscription(
      db, fcmTransport!, target, nativePushPayload(target, payload, eventId), opts, now,
    )),
  ]);
  const delivered = outcomes.includes('sent');
  const deliveryId = delivered ? eventId : null;
  await db.update(pushEvents)
    .set(delivered ? { sentAt: now, deliveryId, outcome: 'sent' } : { outcome: 'failed' })
    .where(claimedRows);
  if (delivered) summary.sent += 1; else summary.failed += 1;
}

export async function sweepDueNotifications(
  db: Db, transport: PushTransport | null, now = new Date(),
  options: { mineFullEnabled?: boolean; fcmTransport?: FcmTransport } = {},
): Promise<SweepSummary> {
  const summary: SweepSummary = { claimed: 0, sent: 0, failed: 0, capped: 0, held: 0 };
  const channels = { web: transport !== null, native: options.fcmTransport !== undefined };
  if (!channels.web && !channels.native) return summary;
  const deliver = (group: PushGroup, alreadyClaimed = false) =>
    deliverGroup(db, transport, group, now, summary, options.fcmTransport, alreadyClaimed);
  const since = new Date(now.getTime() - NOTIFICATIONS.sweepLookbackMs);

  // Raids first (high urgency), then mail, then batched work — so when the
  // hourly cap bites, it bites the least time-sensitive kind.
  for (const raid of await raidCandidates(db, since, now, channels)) {
    await deliver({
      wallet: raid.wallet, occurredAt: new Date(raid.occurredAt), refs: [{ kind: 'raided', refId: raid.refId }],
      payload: payloadFor('raided', 'YOUR BASE WAS RAIDED', `${raid.attackerName ?? 'A rival'} attacked your base.`),
    });
  }
  // Attack warnings retain first claim on the wallet cap. Mine fullness is
  // next: more urgent than mail/build work because uncollected SHARDS are
  // exposed to rivals. Each group was transactionally claimed only after its
  // active deed, raid lock, cycle, fullness, history, and consent were rechecked.
  if (options.mineFullEnabled) {
    const mines = await claimDueMineFullGroups(db, now, { webPushEnabled: channels.web, nativePushEnabled: channels.native });
    summary.held += mines.heldWallets;
    for (const group of mines.groups) {
      await deliver(group, true);
    }
  }
  for (const mail of await mailCandidates(db, since, now, channels)) {
    await deliver({
      wallet: mail.wallet, occurredAt: new Date(mail.occurredAt), refs: [{ kind: 'mail', refId: mail.refId }],
      payload: payloadFor('mail', 'NEW MAIL', mail.subject),
    });
  }

  const byWallet = new Map<string, WorkCandidate[]>();
  for (const c of await workCandidates(db, since, now, channels)) {
    const list = byWallet.get(c.wallet);
    if (list) list.push(c); else byWallet.set(c.wallet, [c]);
  }
  const oldestDue = new Map([...byWallet].map(([wallet, rows]) => [
    wallet,
    new Date(Math.min(...rows.map((row) => new Date(row.occurredAt).getTime()))),
  ]));
  const held = await walletsWithImminentWork(db, oldestDue, now, channels);
  for (const [wallet, rows] of byWallet) {
    if (held.has(wallet)) { summary.held += 1; continue; }
    const builds = rows.filter((r) => r.kind === 'build').length;
    const trainings = rows.length - builds;
    const payload = workPayload(builds, trainings);
    await deliver({
      wallet, occurredAt: oldestDue.get(wallet)!,
      refs: rows.map((r) => ({ kind: r.kind, refId: r.refId })), payload,
    });
  }
  return summary;
}
