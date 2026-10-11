/** RPC-BUDGET pacing contract for the finalized deed observer and the
 * foreground deed reader. Intentionally DB/RPC-free: everything is recomputed
 * from BASE_OWNERSHIP and checked against DEED_RPC_BUDGET, so a future retune
 * cannot silently break the arithmetic written next to the constants.
 *
 * REWRITTEN 2026-09-19 — the owner upgraded the production RPC key to the
 * Helius Developer plan (50 req/s, 10M credits/month). This file used to pin a
 * 10.25 s wave interval, the rule that kept the observer under the PUBLIC
 * Solana RPC's "40 calls to one method per rolling 10 seconds" after a 26-deed
 * startup burst returned 429 in production. Production never reads the public
 * endpoint any more (D-142), and that rule cost players: one 75-deed sweep took
 * ~31 s, so a proof was inside the 10 s mutation rule about a third of the
 * time, most privileged requests needed a foreground read, and real owners saw
 * false 503 DEED_AUTHORITY_UNAVAILABLE (incident 2026-09-18).
 *
 * The rule pinned now is the BUDGET: proofs stay fresh at the current load AND
 * at the supported ceiling while the deed subsystem keeps to its 20 % slice of
 * the key it shares with the player relay and the money paths. Its request
 * RATE would be harmless on the Free plan too; its CREDITS are not, and the
 * budget tests below say so explicitly (security/operations review 2026-09-19).
 *
 * What this file CANNOT see: the arithmetic below is the steady state. After an
 * occurrence that becomes active more than one period late, BullMQ realigns the
 * schedule with its stored offset; that model and its bound are pinned below,
 * and the Redis-backed half (the offset really is on the new grid after a boot)
 * lives in jobs.test.ts. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BASE_OWNERSHIP, DEED_RPC_BUDGET } from '@shardkeep/shared';
import { ownershipSweepBatchDelayMs, summarizeOwnershipSweep } from '../src/game/baseOwnership';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const MS_PER_MONTH = 31 * 86_400_000; // longest month: the conservative credit bill

const wavesFor = (deeds: number): number => Math.ceil(deeds / BASE_OWNERSHIP.observationConcurrency);
/** A full sweep holds its queue-global job one interval past its last wave. */
const sweepDurationMs = (deeds: number): number =>
  wavesFor(deeds) * BASE_OWNERSHIP.observationBatchIntervalMs;
/** BullMQ 5.78 `every` (getJobSchedulerEveryNextMillis): the next occurrence is
 * produced when the current one becomes active, at previous + every, and the
 * queue-global concurrency of 1 makes a due occurrence wait for the running
 * sweep. STEADY-STATE period = the longer of the two, never an overlap. It is
 * NOT a bound after a late occurrence: see lateOccurrenceNextStartMs. */
const sweepPeriodMs = (deeds: number): number =>
  Math.max(BASE_OWNERSHIP.observationPollMs, sweepDurationMs(deeds));
const observerRequestsPerSecond = (deeds: number): number =>
  wavesFor(deeds) / (sweepPeriodMs(deeds) / 1_000);
const worstProofAgeMs = (deeds: number): number =>
  sweepPeriodMs(deeds) + DEED_RPC_BUDGET.proofReadLatencyBudgetMs;
/** The same Lua function's missed-iteration branch: an occurrence that becomes
 * active when previous + every is already in the past schedules its successor
 * on the STORED offset's grid, not at now. */
const lateOccurrenceNextStartMs = (now: number, every: number, storedOffset: number): number =>
  Math.floor(now / every) * every + every + storedOffset;
const foregroundStartsPerSecond = 1_000 / BASE_OWNERSHIP.foregroundReadStartIntervalMs;
const creditsPerMonth = (deeds: number): number => observerRequestsPerSecond(deeds)
  * (MS_PER_MONTH / 1_000) * DEED_RPC_BUDGET.creditsPerRequest;
const everyDeedCount = Array.from(
  { length: BASE_OWNERSHIP.observationMaxActiveDeeds }, (_, index) => index + 1,
);

function simulateFullSweep(deeds: number, startedAt: number) {
  let now = startedAt;
  let previous: number | null = null;
  const starts: number[] = [];
  for (let offset = 0; offset < deeds; offset += BASE_OWNERSHIP.observationConcurrency) {
    now += ownershipSweepBatchDelayMs(previous, now);
    starts.push(now);
    previous = now;
  }
  now += ownershipSweepBatchDelayMs(previous, now); // full-sweep tail hold
  return { starts, releasedAt: now };
}

describe('deed ownership observer pacing', () => {
  it('keeps each wave inside the account-list limit and one request per interval', () => {
    // getMultipleAccounts accepts 100 accounts; the transport adds exactly one
    // collection account to the asset list.
    expect(BASE_OWNERSHIP.observationConcurrency + 1).toBeLessThanOrEqual(100);

    const sweep = simulateFullSweep(BASE_OWNERSHIP.observationMaxActiveDeeds, 1_000);
    expect(sweep.starts).toEqual([1_000, 2_000, 3_000, 4_000, 5_000]);
    expect(sweep.releasedAt).toBe(6_000);
    for (let wave = 1; wave < sweep.starts.length; wave++) {
      expect(sweep.starts[wave]! - sweep.starts[wave - 1]!)
        .toBeGreaterThanOrEqual(1_000 / DEED_RPC_BUDGET.maxObserverRequestsPerSecond);
    }
  });

  it('spaces consecutive full sweeps by a whole wave interval', () => {
    // WHY: at the ceiling (and right after the startup sweep) the next
    // occurrence is already queued, possibly for another worker replica whose
    // local wave clock starts at zero. Only the tail hold of the globally
    // serialized job keeps the observer at one request per interval ACROSS
    // sweeps; without it two requests could land in the same instant.
    const first = simulateFullSweep(BASE_OWNERSHIP.observationMaxActiveDeeds, 1_000);
    const next = simulateFullSweep(BASE_OWNERSHIP.observationMaxActiveDeeds, first.releasedAt);
    expect(next.starts[0]! - first.starts.at(-1)!).toBe(BASE_OWNERSHIP.observationBatchIntervalMs);
  });

  it('never exceeds the observer request budget at any supported deed count', () => {
    for (const deeds of everyDeedCount) {
      expect(observerRequestsPerSecond(deeds), `${deeds} deeds`)
        .toBeLessThanOrEqual(DEED_RPC_BUDGET.maxObserverRequestsPerSecond);
    }
    expect(observerRequestsPerSecond(DEED_RPC_BUDGET.typicalActiveDeeds)).toBeCloseTo(0.6, 10);
    expect(observerRequestsPerSecond(BASE_OWNERSHIP.observationMaxActiveDeeds)).toBe(1);
  });

  it('renews every proof inside the ten-second rule, before the gate needs an early read', () => {
    // WHY: a privileged action is refused (503) unless the owner's proof is at
    // most mutationFreshnessMs old, and the gate already spends a foreground
    // read once less than gateRefreshAheadMs of life is left. If the observer's
    // worst steady-state age stays under THAT line, real owners are served from
    // the observer's proof and the paced foreground queue is only a fallback.
    const earlyRenewalAgeMs = BASE_OWNERSHIP.mutationFreshnessMs - BASE_OWNERSHIP.gateRefreshAheadMs;
    for (const deeds of everyDeedCount) {
      expect(worstProofAgeMs(deeds), `${deeds} deeds`).toBeLessThan(earlyRenewalAgeMs);
      expect(worstProofAgeMs(deeds), `${deeds} deeds`).toBeLessThan(BASE_OWNERSHIP.mutationFreshnessMs);
    }
    expect(worstProofAgeMs(DEED_RPC_BUDGET.typicalActiveDeeds)).toBe(6_500);
    expect(worstProofAgeMs(BASE_OWNERSHIP.observationMaxActiveDeeds)).toBe(6_500);
  });

  it('fits a ceiling sweep in one poll period so occurrences never pile up', () => {
    // A sweep longer than the poll period would turn the period into the sweep
    // duration and silently stretch every proof's age with the deed count.
    expect(sweepDurationMs(BASE_OWNERSHIP.observationMaxActiveDeeds))
      .toBeLessThanOrEqual(BASE_OWNERSHIP.observationPollMs);
    expect(sweepPeriodMs(BASE_OWNERSHIP.observationMaxActiveDeeds)).toBe(5_000);
    expect(sweepPeriodMs(DEED_RPC_BUDGET.typicalActiveDeeds)).toBe(5_000);
  });

  it('bounds the hole after a late sweep to under two poll periods, given an on-grid offset', () => {
    // WHY: a sweep of 10 s or more (ONE wave hitting observationReadTimeoutMs at
    // 75 deeds is enough) or a worker restart makes the next occurrence late,
    // and BullMQ then adds the scheduler's STORED offset to the next slot. With
    // the offset on this grid (what scheduleDeedOwnershipObserver guarantees,
    // jobs.test.ts) the hole is one gap under 2 x poll and the foreground read
    // covers the last moments of it. With the offset production stored on the
    // old 15 s grid the hole reaches poll + 15 s: every proof past the 10 s
    // rule for 5-10 s, every gated request on the 2.5/s foreground queue, and
    // bursts above 21 deeds answered 503 - the 2026-09-18 incident shape.
    const every = BASE_OWNERSHIP.observationPollMs;
    const staleGridMs = 15_000; // observationPollMs until 2026-09-19
    let worstOnGrid = 0;
    let worstStale = 0;
    for (let now = 1_000_000; now < 1_000_000 + every; now += 50) {
      for (let offset = 0; offset < staleGridMs; offset += 50) {
        const gap = lateOccurrenceNextStartMs(now, every, offset) - now;
        if (offset < every) worstOnGrid = Math.max(worstOnGrid, gap);
        worstStale = Math.max(worstStale, gap);
      }
    }
    expect(worstOnGrid).toBeLessThan(2 * every);
    expect(worstOnGrid + DEED_RPC_BUDGET.proofReadLatencyBudgetMs)
      .toBeLessThan(BASE_OWNERSHIP.observationHealthFreshnessMs);
    // The defect the boot-time reset removes, pinned so nobody reads the
    // steady-state figure above as a bound again.
    expect(worstStale).toBeGreaterThan(every + BASE_OWNERSHIP.mutationFreshnessMs);
  });

  it('keeps the supported 160-deed worst case inside the one-minute SLA', () => {
    // Waves are awaited one after another, so against a sick RPC every wave
    // costs its full read deadline instead of the wave interval.
    const waves = wavesFor(BASE_OWNERSHIP.observationMaxActiveDeeds);
    const worstCaseMs = waves * Math.max(
      BASE_OWNERSHIP.observationReadTimeoutMs, BASE_OWNERSHIP.observationBatchIntervalMs,
    );
    expect(worstCaseMs).toBe(40_000);
    const jobReleaseMs = worstCaseMs + BASE_OWNERSHIP.observationBatchIntervalMs;
    expect(jobReleaseMs).toBe(41_000);
    expect(jobReleaseMs).toBeLessThan(BASE_OWNERSHIP.observationHealthFreshnessMs);
  });
});

describe('deed RPC budget (Helius Developer plan, owner 2026-09-19)', () => {
  it('keeps the whole deed subsystem inside its 20 % slice of the shared key', () => {
    expect(DEED_RPC_BUDGET.maxSubsystemRequestsPerSecond)
      .toBeLessThanOrEqual(DEED_RPC_BUDGET.planRequestsPerSecond * 0.2);
    // Sustained worst case: the observer at the ceiling while EVERY foreground
    // reader is saturated (retries are ordinary paced starts, so they are in).
    const worstCase = observerRequestsPerSecond(BASE_OWNERSHIP.observationMaxActiveDeeds)
      + DEED_RPC_BUDGET.foregroundReaders * foregroundStartsPerSecond;
    expect(worstCase).toBe(8.5);
    expect(worstCase).toBeLessThanOrEqual(DEED_RPC_BUDGET.maxSubsystemRequestsPerSecond);
  });

  it('counts every foreground reader the budget multiplies by', () => {
    // Each makeFinalizedDeedReader call owns an independent paced FIFO. A new
    // call site raises the worst case above without touching a constant.
    const sources = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return sources(full);
      return full.endsWith('.ts') ? [full] : [];
    });
    const callSites = sources(SRC).flatMap((file) => {
      const calls = readFileSync(file, 'utf8').match(/(?<!function )makeFinalizedDeedReader\(/g);
      return calls ? [`${path.relative(SRC, file)} x${calls.length}`] : [];
    });
    // 2026-10-10 (CI 37503885235, cluster D): on 2026-09-29 the divine (56c43379c), clan-divine (220f3078c) and
    // charter-sale (17b0a5512) operator CLIs each added a call. Each runs ONE explicit operator command in its own
    // process and exits, so it holds no sustained FIFO, and DEED_RPC_BUDGET.foregroundReaders is defined
    // (constants.ts) as the call sites "that carry traffic". They are pinned exactly, and their one-shot shape is
    // checked, so a new or long-running one is a reviewed change. Every OTHER call site is a traffic FIFO and the
    // budget's multiplier must EQUAL their count. 8495c1a6f (2026-09-29) added server.ts (the Phase E services' own
    // reader): 4 traffic FIFOs, worst case 1 + 4 x 2.5 = 11 req/s over the 10 req/s slice. That is K-night-D2,
    // an open production defect whose fix belongs to its own reviewed lane; this test stays red on it until then.
    const operatorCli = (site: string) => /OperatorCli\.ts x\d+$/.test(site);
    expect(callSites.filter(operatorCli).sort()).toEqual([
      'game/charterSaleOperatorCli.ts x1', 'game/clanDivineOperatorCli.ts x1', 'game/divineOperatorCli.ts x1']);
    for (const site of callSites.filter(operatorCli)) {
      const cli = readFileSync(path.join(SRC, site.replace(/ x\d+$/, '')), 'utf8');
      expect(cli, site).toMatch(/process\.exitCode=await main\(process\.argv\.slice\(2\)\);\s*$/);
      expect(cli, site).not.toMatch(/setInterval|setTimeout|\.listen\(/);
    }
    const trafficSites = callSites.filter((site) => !operatorCli(site)).sort();
    expect(trafficSites).toEqual(['game/routes.ts x1', 'jobs.ts x1', 'mail/routes.ts x1']);
    expect(DEED_RPC_BUDGET.foregroundReaders).toBe(trafficSites.length);
  });

  it('keeps a request RATE that would be harmless on the Free plan (rate only, not credits)', () => {
    // Rate only. The Free plan's CREDITS do not cover this pacing: next test.
    expect(foregroundStartsPerSecond).toBe(2.5);
    expect(foregroundStartsPerSecond)
      .toBeLessThanOrEqual(DEED_RPC_BUDGET.maxForegroundStartsPerSecondPerReader);
    expect(DEED_RPC_BUDGET.maxObserverRequestsPerSecond)
      .toBeLessThanOrEqual(DEED_RPC_BUDGET.freePlanRequestsPerSecond * 0.1);
    // The observer plus the busiest single reader leave most of 10 req/s free.
    expect(observerRequestsPerSecond(BASE_OWNERSHIP.observationMaxActiveDeeds) + foregroundStartsPerSecond)
      .toBeLessThan(DEED_RPC_BUDGET.freePlanRequestsPerSecond / 2);
  });

  it('bills a typical month well inside the credit budget', () => {
    expect(creditsPerMonth(DEED_RPC_BUDGET.typicalActiveDeeds)).toBeCloseTo(1_607_040, 3);
    expect(DEED_RPC_BUDGET.maxTypicalCreditsPerMonth)
      .toBeLessThanOrEqual(DEED_RPC_BUDGET.planCreditsPerMonth * 0.25);
    expect(creditsPerMonth(DEED_RPC_BUDGET.typicalActiveDeeds))
      .toBeLessThanOrEqual(DEED_RPC_BUDGET.maxTypicalCreditsPerMonth);
    // The ceiling is NOT typical; it is pinned so its price stays a decision,
    // and even it leaves the relay and the money paths over 70 % of the plan.
    expect(creditsPerMonth(BASE_OWNERSHIP.observationMaxActiveDeeds)).toBe(2_678_400);
    expect(creditsPerMonth(BASE_OWNERSHIP.observationMaxActiveDeeds))
      .toBeLessThan(DEED_RPC_BUDGET.planCreditsPerMonth * 0.3);
  });

  it('is NOT Free-plan-safe on credits: the observer alone outspends the Free allowance', () => {
    // WHY: this is a deploy precondition, not a nicety. If the production key's
    // Helius project is not on Developer (upgrade landed on another project,
    // billing lapsed) the observer alone empties the Free month by about day 19
    // at 75 deeds and day 11-12 at the ceiling, and Helius then rejects EVERY
    // call on the shared key until the monthly reset: payment verification,
    // payouts, deed minting, the relay and deed authority all go down together.
    // The previous cadence (~0.26M credits a month) fitted; this one does not.
    // If a retune ever makes this test fail, the pacing became Free-safe again:
    // reword the constants note rather than deleting the assertion.
    const typical = creditsPerMonth(DEED_RPC_BUDGET.typicalActiveDeeds);
    const ceiling = creditsPerMonth(BASE_OWNERSHIP.observationMaxActiveDeeds);
    expect(typical).toBeGreaterThan(DEED_RPC_BUDGET.freePlanCreditsPerMonth);
    expect(ceiling).toBeGreaterThan(DEED_RPC_BUDGET.freePlanCreditsPerMonth);
    const dayFreeRunsOut = (monthly: number): number =>
      DEED_RPC_BUDGET.freePlanCreditsPerMonth / (monthly / 31);
    expect(Math.floor(dayFreeRunsOut(typical))).toBe(19);
    expect(Math.floor(dayFreeRunsOut(ceiling))).toBe(11);
    // What the owner checks 24 h after the deploy: the observer's daily bill.
    expect(typical / 31).toBeCloseTo(51_840, 6);
  });

  it('gives a burst of stale deeds a start slot instead of a queue-timeout 503', () => {
    // Starts at t = 0 through the inclusive queue deadline (baseOwnershipReader
    // test pins that behaviour); a later FIFO entrant is refused unread.
    const burstCapacity = Math.floor(
      BASE_OWNERSHIP.foregroundReadQueueTimeoutMs / BASE_OWNERSHIP.foregroundReadStartIntervalMs,
    ) + 1;
    expect(burstCapacity).toBe(21);
    expect(burstCapacity).toBeGreaterThanOrEqual(DEED_RPC_BUDGET.foregroundBurstDeeds);
  });
});

describe('deed ownership observer job result', () => {
  it('stores a compact summary that still names every deed that is not owned', () => {
    // WHY: completed observer jobs are retained for a day. At the 5-second
    // cadence that is 17,280 results; the full per-deed array would pin
    // 90-190 MB of Redis, while the only rows an operator ever needs are the
    // ones that are NOT plain `owned`.
    const results = [
      ...Array.from({ length: 158 }, (_, i) => ({ baseId: `base-${i}`, status: 'owned' })),
      { baseId: 'base-sold', status: 'mismatch' },
      { baseId: 'base-rpc', status: 'unavailable' },
    ];
    const summary = summarizeOwnershipSweep(results);
    expect(summary).toEqual({
      deeds: 160, owned: 158,
      notOwned: [
        { baseId: 'base-sold', status: 'mismatch' },
        { baseId: 'base-rpc', status: 'unavailable' },
      ],
    });
    expect(JSON.stringify(summary).length).toBeLessThan(200);
    expect(readFileSync(path.join(SRC, 'jobs.ts'), 'utf8')).toContain(
      'return summarizeOwnershipSweep(\n          await sweepActiveBaseOwnership(',
    );
  });
});
