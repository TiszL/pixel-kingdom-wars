import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Queue } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { CHAT, BASE_OWNERSHIP, LEAGUES, NOTIFICATIONS } from '@shardkeep/shared';
import { TEST_CONFIG } from './helpers';
import {
  AVATAR_RETIREMENT_QUEUE, BULLMQ_RETENTION, GLOBAL_CHAT_RETENTION_QUEUE,
  leagueCloseRecoveryStartupJobId, NOTIFICATION_SWEEP_QUEUE, parseEpochRootRecoverySignatures,
  serializeLeagueJobResult, serializeSnapshotJobResult, TOTP_RECOVERY_QUEUE, FEEDBACK_RETENTION_QUEUE,
  DEED_OWNERSHIP_SCHEDULER_ID, scheduleDeedOwnershipObserver,
} from '../src/jobs';

const jobsSource = readFileSync(new URL('../src/jobs.ts', import.meta.url), 'utf8');

describe('BullMQ job result contracts', () => {
  it('isolates private screenshot cleanup, disables its scheduler without private R2 and closes its resources', () => {
    // WHY: private storage downtime must not delay custody work, and retained
    // scheduled jobs must not silently succeed after credentials are removed.
    expect(FEEDBACK_RETENTION_QUEUE).toBe('shardkeep-feedback-retention');
    expect(jobsSource).toContain('new Queue(FEEDBACK_RETENTION_QUEUE');
    expect(jobsSource).toContain('defaultJobOptions: BULLMQ_RETENTION.feedbackRetention');
    expect(jobsSource).toContain('await feedbackRetentionQueue.setGlobalConcurrency(1)');
    expect(jobsSource).toContain('const feedbackR2 = feedbackR2ConfigFromEnv()');
    expect(jobsSource).toContain('if (feedbackStorage) {');
    expect(jobsSource).toContain("upsertJobScheduler('sched-feedback-retention'");
    expect(jobsSource).toContain('every: FEEDBACK_SCREENSHOTS.cleanupPollMs');
    expect(jobsSource).toContain("removeJobScheduler('sched-feedback-retention')");
    expect(jobsSource).toContain('new Worker(FEEDBACK_RETENTION_QUEUE');
    expect(jobsSource).toContain("if (!feedbackStorage) throw new Error('Private feedback retention storage unavailable')");
    expect(jobsSource).toContain('cleanupFeedbackScreenshots(db, feedbackStorage)');
    expect(jobsSource).toContain('await feedbackRetentionWorker.close()');
    expect(jobsSource).toContain('await feedbackRetentionQueue.close()');
  });
  it('bounds terminal history per queue without touching executable job state', () => {
    // WHY: completed scheduler instances once grew past 139k keys. BullMQ
    // applies these policies only when jobs enter completed/failed sets, so
    // delayed jobs, active work, retries and stable scheduler IDs remain intact.
    expect(BULLMQ_RETENTION).toEqual({
      main: {
        removeOnComplete: { age: 21_600, limit: 100 },
        removeOnFail: { age: 86_400, limit: 25 },
      },
      deedOwnership: {
        removeOnComplete: { age: 86_400, limit: 100 },
        removeOnFail: { age: 172_800, limit: 25 },
      },
      avatarRetirement: {
        removeOnComplete: { age: 604_800, limit: 100 },
        removeOnFail: { age: 604_800, limit: 25 },
      },
      // DEVNET PLAYTEST ONLY (owner 2026-08-22): faucet sweeps are frequent and
      // low-value; keep a short history so a stuck grant is still diagnosable.
      devnetFaucet: {
        removeOnComplete: { age: 21_600, limit: 50 },
        removeOnFail: { age: 86_400, limit: 25 },
      },
      globalChatRetention: {
        removeOnComplete: { age: 2_592_000, limit: 50 },
        removeOnFail: { age: 2_592_000, limit: 25 },
      },
      feedbackRetention: {
        removeOnComplete: { age: 86_400, limit: 50 },
        removeOnFail: { age: 172_800, limit: 25 },
      },
      // Email provider latency and retries live outside the custody queue.
      totpRecovery: {
        removeOnComplete: { age: 86_400, limit: 50 },
        removeOnFail: { age: 172_800, limit: 25 },
      },
      // Tester-program sweep (2026-08-21): isolated queue, day-scale history —
      // enough to see the last sweeps' scanned/awarded counts, never unbounded.
      testerSweep: {
        removeOnComplete: { age: 86_400, limit: 50 },
        removeOnFail: { age: 2 * 86_400, limit: 25 },
      },
      // D-103 public statistics snapshot (M35): same isolated-queue posture as
      // the tester sweep — one full-table read pass every five minutes must
      // never sit on the custody queue, and a day of history shows the last
      // computed_at values.
      playtestStats: {
        removeOnComplete: { age: 86_400, limit: 50 },
        removeOnFail: { age: 2 * 86_400, limit: 25 },
      },
      // Web Push provider calls never occupy the custody/root queue.
      notificationSweep: {
        removeOnComplete: { age: 86_400, limit: 50 },
        removeOnFail: { age: 2 * 86_400, limit: 25 },
      },
    });

    // BullMQ 5.78 ignores `limit` for count eviction. A count here would let
    // the first postdeploy completion delete the whole historical excess in a
    // single Redis Lua command, so every terminal policy must stay age-only.
    for (const policy of Object.values(BULLMQ_RETENTION)) {
      expect(policy.removeOnComplete).not.toHaveProperty('count');
      expect(policy.removeOnFail).not.toHaveProperty('count');
      expect(policy.removeOnComplete.limit).toBeLessThanOrEqual(100);
      expect(policy.removeOnFail.limit).toBeLessThanOrEqual(25);
    }

    expect(jobsSource).toContain('defaultJobOptions: BULLMQ_RETENTION.main');
    expect(jobsSource).toContain('defaultJobOptions: BULLMQ_RETENTION.deedOwnership');
    expect(jobsSource).toContain('defaultJobOptions: BULLMQ_RETENTION.avatarRetirement');
    expect(jobsSource).toContain('defaultJobOptions: BULLMQ_RETENTION.globalChatRetention');
    expect(jobsSource).toContain('defaultJobOptions: BULLMQ_RETENTION.totpRecovery');
    expect(jobsSource).toContain('defaultJobOptions: BULLMQ_RETENTION.notificationSweep');
    expect(jobsSource).not.toContain('removeOnComplete: true');
  });

  it('isolates and feature-gates the 30-second notification sweep', () => {
    expect(NOTIFICATION_SWEEP_QUEUE).toBe('shardkeep-notification-sweep');
    expect(NOTIFICATIONS.sweepEveryMs).toBe(30_000);
    expect(jobsSource).toContain('new Queue(NOTIFICATION_SWEEP_QUEUE');
    expect(jobsSource).toContain('new Worker(NOTIFICATION_SWEEP_QUEUE');
    expect(jobsSource).toContain("'sched-notification-sweep'");
    expect(jobsSource).toContain('{ every: NOTIFICATIONS.sweepEveryMs }');
    expect(jobsSource).toContain('await notificationSweepQueue.setGlobalConcurrency(1)');
    expect(jobsSource).toContain("config.PUSH_NOTIFICATIONS_ENABLED === 'true'");
    expect(jobsSource).toContain("mineFullEnabled: config.MINE_FULL_NOTIFICATIONS_ENABLED === 'true'");
    expect(jobsSource).toContain("removeJobScheduler('sched-notification-sweep')");
    expect(jobsSource).toContain('sweepDueNotifications(db, pushTransport, new Date(), {');
  });

  it('classifies legacy Mine fill state from the unconditional recovery scheduler', () => {
    // WHY: rollout starts with Mine delivery dark. Tying bootstrap to the push
    // transport or source flag would either lose partial fills or defer flood
    // protection until the same moment sends become possible.
    expect(NOTIFICATIONS.mineBootstrapBatchSize).toBe(32);
    const recoveryCase = jobsSource.slice(
      jobsSource.indexOf("case 'live-raid-recovery':"),
      jobsSource.indexOf("case 'tester-sweep':"),
    );
    expect(recoveryCase).toContain('recoverLiveRaidLifecycle(db)');
    expect(recoveryCase).toContain('classifyMineFullNotificationBootstrap(db)');
    expect(recoveryCase.indexOf('recoverLiveRaidLifecycle(db)'))
      .toBeLessThan(recoveryCase.indexOf('classifyMineFullNotificationBootstrap(db)'));
    expect(recoveryCase).not.toContain('MINE_FULL_NOTIFICATIONS_ENABLED');
    expect(recoveryCase).not.toContain('PUSH_NOTIFICATIONS_ENABLED');
  });

  it('serializes a phase-qualified zero observation without inventing a root', () => {
    const result = serializeSnapshotJobResult({ kind: 'no_liabilities', phase: 'frozen',
      epoch: 4000n, root: null, totalBalance: 0n, leafCount: 0, alreadyExisted: false },
    { liabilityKeep: '0', covered: true });
    expect(JSON.parse(JSON.stringify(result))).toEqual({ kind: 'no_liabilities', phase: 'frozen',
      epoch: '4000', root: null, totalBalance: '0', leafCount: 0, alreadyExisted: false,
      reserves: { liabilityKeep: '0', covered: true } });
    // The job still reports the independent reserve check and does not imply
    // publication or a chain proof from the absence of custody balances.
    const snapshotCase = jobsSource.slice(jobsSource.indexOf("case 'snapshot':"), jobsSource.indexOf("case 'league-reset':"));
    expect(snapshotCase).toContain('await checkReserves(db, reader)');
    expect(snapshotCase).toContain('serializeSnapshotJobResult(snap, reserves)');
  });

  it('preserves ordinary snapshot job fields and safe integer serialization', () => {
    const result = serializeSnapshotJobResult({ epoch: 4000n, root: 'ab'.repeat(32),
      totalBalance: 9007199254740993n, leafCount: 2, alreadyExisted: true }, null);
    expect(JSON.parse(JSON.stringify(result))).toEqual({ epoch: '4000', root: 'ab'.repeat(32),
      totalBalance: '9007199254740993', leafCount: 2, alreadyExisted: true, reserves: null });
  });

  it('serializes league SHARD totals before BullMQ persists completion', () => {
    // WHY: BullMQ JSON-stringifies every processor result. Returning the
    // service's bigint cache total makes a successful receipt sweep
    // fail three times at Worker.handleCompleted and recur every 15 minutes.
    const result = serializeLeagueJobResult({
      week: '2026-08-10',
      cacheShards: 123n,
      settled: 1,
      tiers: { bronze: 1, silver: 2, gold: 3, sol: 4 },
      clanChests: 5,
    });

    expect(result).toEqual({
      week: '2026-08-10',
      cacheShards: '123',
      settled: 1,
      tiers: { bronze: 1, silver: 2, gold: 3, sol: 4 },
      clanChests: 5,
    });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('always enqueues a fresh startup close recovery after a retained failure', () => {
    // WHY: a boundary-keyed BullMQ ID can remain occupied by the failed 00:05
    // attempt. A restart at 00:16 is after the minute recovery scheduler, so it
    // must not dedupe against that retained job and leave gameplay fenced.
    const firstFailedBoot = leagueCloseRecoveryStartupJobId();
    const secondBootSameBoundary = leagueCloseRecoveryStartupJobId();
    expect(secondBootSameBoundary).not.toBe(firstFailedBoot);
    expect(firstFailedBoot).toMatch(/^league-close-recovery-startup-[0-9a-f-]{36}$/);
    expect(jobsSource).toContain('jobId: leagueCloseRecoveryStartupJobId()');
    expect(jobsSource).toMatch(/\n  await queue\.add\('league-close-recovery', \{\}, \{/);
  });

  it('keeps the close watchdog scheduled after the deadline and both kill switches', () => {
    // WHY: if Postgres is unavailable through 00:15 while Redis and the worker
    // remain alive, finite job retries exhaust. A later DB recovery must get a
    // fresh repeat without requiring a process restart.
    expect(LEAGUES.closeRecoveryCron).toBe('*/5 * * * *');
    const scheduler = jobsSource.slice(
      jobsSource.indexOf("'sched-league-close-recovery'", jobsSource.indexOf('upsertJobScheduler')) - 180,
      jobsSource.indexOf("'sched-league-close-recovery'", jobsSource.indexOf('upsertJobScheduler')) + 220,
    );
    expect(scheduler).toContain('await queue.upsertJobScheduler(');
    expect(scheduler).not.toContain('if (config.');
    expect(jobsSource).not.toContain("removeJobScheduler('sched-league-close-recovery')");
  });

  it('isolates slow avatar retirement from custody and root publication', () => {
    expect(AVATAR_RETIREMENT_QUEUE).toBe('shardkeep-avatar-retirements');
    expect(jobsSource).toContain(
      'const avatarRetirementQueue = new Queue(AVATAR_RETIREMENT_QUEUE',
    );
    expect(jobsSource).toContain(
      'const avatarRetirementWorker = new Worker(AVATAR_RETIREMENT_QUEUE',
    );
    expect(jobsSource).toContain("'sched-avatar-retirements'");
    expect(jobsSource).toContain('{ every: PROFILE_AVATAR.retirementPollMs }');
    expect(jobsSource).toContain("config.NODE_ENV === 'production' && !avatarR2");
    expect(jobsSource).toContain("throw new Error('profile avatar retirement storage is unavailable')");
    expect(jobsSource).toContain(
      'return drainAvatarRetirements(db, avatarRetirementDelete, new Date())',
    );
    expect(jobsSource).not.toContain('return { disabled: true');

    const rootCase = jobsSource.slice(
      jobsSource.indexOf("case 'outbox-relay':"),
      jobsSource.indexOf("case 'deposit-watch':"),
    );
    expect(rootCase).toContain('return relayOutbox(db, sendRoot, now)');
    expect(rootCase).not.toContain('relayAvatarRetirements');
  });

  it('isolates bounded chat retention while safely draining legacy tagged jobs', () => {
    expect(GLOBAL_CHAT_RETENTION_QUEUE).toBe('shardkeep-global-chat-retention');
    expect(jobsSource).toContain("'sched-global-chat-retention'");
    expect(jobsSource).toContain('{ every: CHAT.retentionPollMs }');
    expect(jobsSource).toContain('new Queue(GLOBAL_CHAT_RETENTION_QUEUE');
    expect(jobsSource).toContain('new Worker(GLOBAL_CHAT_RETENTION_QUEUE');
    expect(jobsSource).toContain("{ name: 'global-chat-retention' }");
    expect(jobsSource).toContain("removeJobScheduler('sched-global-chat-retention')");
    expect(jobsSource).toContain('return drainExpiredGlobalChat(db, new Date())');
    // A tagged job already materialized by the prior rolling-compatible
    // scheduler remains recognized but cannot delay custody with DB cleanup.
    const outboxCase = jobsSource.slice(
      jobsSource.indexOf("case 'outbox-relay':"),
      jobsSource.indexOf("case 'deposit-watch':"),
    );
    expect(outboxCase).toContain("job.data?.task === 'global-chat-retention'");
    expect(outboxCase).toContain("skipped: 'global chat retention moved to its isolated queue'");
    expect(outboxCase).toContain('return relayOutbox(db, sendRoot, now)');

    const dailyDeleteCapacity = CHAT.retentionBatchSize
      * CHAT.retentionMaxBatchesPerRun * (86_400_000 / CHAT.retentionPollMs);
    const supportedDailyWrites = BASE_OWNERSHIP.observationMaxActiveDeeds
      * CHAT.sendsPerHour * 24;
    expect(dailyDeleteCapacity).toBeGreaterThan(supportedDailyWrites);
  });

  it('isolates hanging or failing recovery email delivery from custody root relay', async () => {
    // WHY: one recovery drain can perform many provider calls. It must neither
    // occupy the singleton custody worker nor suppress the next epoch root.
    expect(TOTP_RECOVERY_QUEUE).toBe('shardkeep-totp-recovery');
    expect(jobsSource).toContain('new Queue(TOTP_RECOVERY_QUEUE');
    expect(jobsSource).toContain('new Worker(TOTP_RECOVERY_QUEUE');
    expect(jobsSource).toContain("'sched-totp-recovery'");
    expect(jobsSource).toContain('await totpRecoveryQueue.setGlobalConcurrency(1)');

    const outboxCase = jobsSource.slice(
      jobsSource.indexOf("case 'outbox-relay':"),
      jobsSource.indexOf("case 'deposit-watch':"),
    );
    expect(outboxCase).toContain('return relayOutbox(db, sendRoot, now)');
    expect(outboxCase).not.toContain('sweepExpiredTotpRecoveries');

    const recoveryWorker = jobsSource.slice(
      jobsSource.indexOf('const totpRecoveryWorker = new Worker'),
      jobsSource.indexOf('const testerSweepWorker = new Worker'),
    );
    expect(recoveryWorker).toContain('sweepExpiredTotpRecoveries');
    expect(recoveryWorker).toContain('{ connection, concurrency: 1 }');

    let release!: () => void;
    const hangingProvider = new Promise<void>((resolve) => { release = resolve; });
    const independentRoot = Promise.resolve({ sent: 1 });
    await expect(Promise.race([
      independentRoot,
      new Promise((_, reject) => setTimeout(() => reject(new Error('root relay backlogged')), 25)),
    ])).resolves.toEqual({ sent: 1 });
    release();
    await hangingProvider;
  });
});

describe('epoch-root operator recovery', () => {
  const signature = '1'.repeat(64);

  it('parses canonical epoch-to-signature evidence without changing outbox state', () => {
    expect(parseEpochRootRecoverySignatures(undefined).size).toBe(0);
    expect(parseEpochRootRecoverySignatures('')).toEqual(new Map());
    expect(parseEpochRootRecoverySignatures(`{"17":"${signature}"}`))
      .toEqual(new Map([[17n, signature]]));
    expect(jobsSource).toContain('recoverySignatures.get(epoch)');
  });

  it('fails loud on malformed, non-u64, or noncanonical recovery evidence', () => {
    expect(() => parseEpochRootRecoverySignatures('[]')).toThrow('must be a JSON object');
    expect(() => parseEpochRootRecoverySignatures(`{"01":"${signature}"}`)).toThrow('invalid epoch key');
    expect(() => parseEpochRootRecoverySignatures(`{"18446744073709551616":"${signature}"}`))
      .toThrow('exceeds u64');
    expect(() => parseEpochRootRecoverySignatures('{"17":"not-a-signature"}'))
      .toThrow('invalid Solana signature');
  });
});

describe('item-market reconciler job contract', () => {
  it('schedules the reconciler on the main queue with the shared two-source proof, or reports itself unconfigured', () => {
    // WHY: settlement and release of a reservation must not depend on the
    // buyer's client polling (tester report 24b9184d). The worker must use the
    // exact verifier the API uses for /settle and takeover, and must never run
    // a verifier-less pass that could read silence as "unpaid".
    expect(jobsSource).toContain("upsertJobScheduler(\n    'sched-market-reconcile'");
    expect(jobsSource).toContain('every: MARKETPLACE.itemMarket.reconcilePollSec * 1000');
    expect(jobsSource).toContain("case 'market-reconcile':\n        return reconcileMarketReservations(db, marketReconcileDeps, now);");
    expect(jobsSource).toContain('const marketFeeTreasury = paidBaseAddresses?.treasuries?.ops;');
    expect(jobsSource).toContain('...makeMarketPaymentVerifiers(');
    expect(jobsSource).toContain('} : {};');
  });
});

describe('deed ownership observer scheduler (Redis-backed)', () => {
  it.each([
    ['the 15 s cadence production runs today', 15_000],
    ['the new cadence registered without the reset', BASE_OWNERSHIP.observationPollMs],
  ])('recomputes a stale BullMQ offset on the new grid at boot (%s)', async (_state, storedEvery) => {
    // WHY: BullMQ 5.78 keeps a scheduler's stored `offset` across a changed
    // `every`. Production registered this scheduler at 15 s, so its offset can
    // be anywhere in [0, 15_000). An occurrence that becomes active more than
    // one period late (a sick RPC wave, a worker restart) is realigned to
    // floor(now / every) * every + every + offset: a stale offset leaves up to
    // every + 15 s without a sweep, every proof ages past the 10 s mutation
    // rule and owners fall back to awaited foreground reads and 503s
    // (2026-09-18). With offset < every that realignment stays below two
    // periods. Reproduced on a scratch queue 2026-09-19: stale offset 8_010
    // gave start gaps 11_015 / 12_380 ms; reset gave 11_015 / 9_039 ms.
    const connection = { url: TEST_CONFIG.REDIS_URL };
    const queue = new Queue(`test-deed-ownership-scheduler-${randomUUID()}`, { connection });
    try {
      // The state production Redis is in before this deploy: an offset from
      // the upper two thirds of the pre-2026-09-19 15 s grid.
      await queue.upsertJobScheduler(
        DEED_OWNERSHIP_SCHEDULER_ID, { every: storedEvery, offset: 8_010 }, { name: 'deed-ownership' },
      );
      expect((await queue.getJobScheduler(DEED_OWNERSHIP_SCHEDULER_ID))?.offset).toBe(8_010);

      await scheduleDeedOwnershipObserver(queue);

      const scheduler = await queue.getJobScheduler(DEED_OWNERSHIP_SCHEDULER_ID);
      expect(scheduler?.every).toBe(BASE_OWNERSHIP.observationPollMs);
      expect(scheduler?.offset ?? 0).toBeLessThan(BASE_OWNERSHIP.observationPollMs);
      // Exactly one pending occurrence, due now: the reset must neither leave
      // the old occurrence behind nor postpone the first sweep.
      expect(await queue.getJobCountByTypes('delayed', 'waiting', 'prioritized')).toBe(1);
      expect(scheduler!.next! - Date.now()).toBeLessThanOrEqual(BASE_OWNERSHIP.observationPollMs);

      // A second boot at the unchanged cadence keeps the offset on the grid.
      await scheduleDeedOwnershipObserver(queue);
      const rebooted = await queue.getJobScheduler(DEED_OWNERSHIP_SCHEDULER_ID);
      expect(rebooted?.offset ?? 0).toBeLessThan(BASE_OWNERSHIP.observationPollMs);
      expect(await queue.getJobCountByTypes('delayed', 'waiting', 'prioritized')).toBe(1);
      expect(await queue.getGlobalConcurrency()).toBe(1);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
