/** D153.187 finite prerequisite matrix, frozen before the model implementation.
 * Fixtures are synthetic logical days/results, never provider or free-route proof. */
import { describe, expect, it } from 'vitest';
import { PHASE_E_FRAGMENT_MODEL as P, PHASE_E_POLICY } from '../../packages/shared/src/constants';
import { createModel, openPeriod, awardSite, earnOpportunity, precommit, settle,
  transfer, allocateTax, claimTax, invariant, recipeExpectation, validatePolicy,
  type Model, type Outcome } from './phase-e-fragment-model';

const winners = [{ site: 'king', wallet: 'king' }, { site: 'regular', wallet: 'regular' }];
const original = (initial = 0n, exempt = false) => openPeriod(createModel({ alice: initial }, exempt), 'old', 'term-old', 0n, P.weeklyCeiling, P.allocations[0], winners);
const earn = (s: Model, wallet = 'alice', day = 0n) => earnOpportunity(s, { wallet, day, sourceId: `${wallet}:${day}`, increment: 1n, finalized: true, personallyEarned: true, source: 'renown' });
const quote = { family: 'survey-balloon', tier: 0, quotedFragments: P.recipeInputs[0], boundInput: false, transferableOutput: true };
const commit = (s: Model, id = 'attempt', wallet = 'alice', earnedDay: bigint | null = 0n, day = 0n, period = 'old') =>
  precommit(s, { id, wallet, earnedDay, day, period, ...quote });
const loss: Outcome = { kind: 'gameplay-failure', rollBps: 0n };

describe('D153.187 PROPOSED fragment model finite acceptance', () => {
  it('partitions every allocation/ceiling and leaves vacant site allowances unissued', () => {
    for (const allocation of P.allocations) for (const ceiling of P.weeklyCeilings) {
      const s = openPeriod(createModel(), 'p', 't', 0n, ceiling, allocation);
      const a = awardSite(s, 'p', 'individual', 0n, ['alice']);
      expect(a.periods.get('p')!.issued).toBe(s.periods.get('p')!.sources.individual.ceiling / BigInt(P.individualSites));
      invariant(a); expect(s.periods.get('p')!.issued).toBe(0n);
      const empty = awardSite(s, 'p', 'clan', 0n, []);
      expect(empty.periods.get('p')!.issued).toBe(0n);
      expect(() => awardSite(empty, 'p', 'clan', 0n, ['alice'])).toThrow('site');
    }
  });
  it('clan roster changes divide one frozen award without creating supply', () => {
    for (const n of [1, 3, 20]) {
      const members = Array.from({ length: n }, (_, i) => `member-${i}`);
      const s = awardSite(original(), 'old', 'clan', 0n, members);
      expect(s.periods.get('old')!.issued).toBe(40n);
      invariant(s);
      expect(awardSite(original(), 'old', 'clan', 0n, [...members].reverse())).toEqual(s);
    }
    expect(() => awardSite(original(), 'old', 'clan', 0n, ['alice', 'alice'])).toThrow('duplicate');
  });
  it.each(P.populationScenarios)('conserves empty/low/full/high synthetic population %s', (population) => {
    let s = original();
    for (let slot = 0n; slot < population && slot < BigInt(P.individualSites); slot++) s = awardSite(s, 'old', 'individual', slot, [`wallet-${slot}`]);
    invariant(s); expect(s.periods.get('old')!.issued <= s.periods.get('old')!.sources.individual.ceiling).toBe(true);
  });
  it('synthetic free finalized Renown grants one nontransferable wallet/day identity; market/spend/gear/base changes do not', () => {
    const s = earn(original(100n));
    expect(earn(s)).toEqual(s);
    for (const source of ['purchase', 'spend', 'equipment', 'base-refresh']) {
      expect(() => earnOpportunity(s, { wallet: 'alice', day: 0n, sourceId: 'synthetic-increment', increment: 1n, finalized: true, personallyEarned: true, source })).toThrow('earned');
    }
    expect(() => earnOpportunity(s, { wallet: 'bob', day: 0n, sourceId: 'synthetic-increment', increment: 1n, finalized: false, personallyEarned: true, source: 'renown' })).toThrow('earned');
    expect(() => earnOpportunity(s, { wallet: 'bob', day: 0n, sourceId: 'synthetic-increment', increment: 1n, finalized: true, personallyEarned: false, source: 'renown' })).toThrow('earned');
    expect(() => commit(s, 'stolen', 'bob')).toThrow('opportunity');
    const pending = commit(s);
    expect(commit(pending)).toEqual(pending);
    expect(() => commit(pending, 'duplicate')).toThrow('opportunity');
    expect(() => precommit(pending, { id: 'attempt', wallet: 'alice', earnedDay: 0n, day: 1n, period: 'old', ...quote })).toThrow('replay');
  });
  it('rejects uncommitted outcomes and expired admission, while pending original budgets survive rollover', () => {
    expect(() => settle(original(), 'missing', loss)).toThrow('attempt');
    const expired = openPeriod(earn(original(100n)), 'new', 'term-new', P.periodDays);
    expect(() => commit(expired, 'late', 'alice', 0n, P.admissionDays, 'new')).toThrow('expired');
    let s = commit(earn(original(100n)));
    s = openPeriod(s, 'new', 'term-new', P.periodDays);
    s = settle(s, 'attempt', { kind: 'unknown' });
    s = settle(s, 'attempt', { kind: 'technical-failure' });
    expect(s.periods.get('old')!.reserved).toBe(P.salvageMax);
    expect(s.periods.get('new')!.reserved).toBe(0n);
    expect(s.attempts.get('attempt')!.reservedFragments).toBe(P.recipeInputs[0]);
    expect(s.players.get('alice')).toBe(100n - P.recipeInputs[0]);
    expect(s.burned).toBe(0n); invariant(s);
    const finished = settle(s, 'attempt', loss);
    expect(finished.periods.get('old')!.issued).toBe(P.salvageMax);
    expect(finished.periods.get('new')!.issued).toBe(0n);
    expect(finished.burned).toBe(P.recipeInputs[0]);
    expect(finished.attempts.get('attempt')!.reservedFragments).toBe(0n);
    expect(settle(finished, 'attempt', loss)).toEqual(finished);
    expect(() => settle(finished, 'attempt', { kind: 'success' })).toThrow('replay');
    invariant(finished);
  });
  it.each([{ kind: 'success' }, { kind: 'gameplay-failure', rollBps: P.salvageBps }] as Outcome[])('nonwinning settlement releases reservation but consumes opportunity: %s', outcome => {
    const s = settle(commit(earn(original(100n))), 'attempt', outcome);
    expect(s.periods.get('old')!.reserved).toBe(0n); expect(s.periods.get('old')!.issued).toBe(0n);
    expect(() => commit(s, 'again')).toThrow('opportunity'); invariant(s);
  });
  it('full salvage budget locks admission while unknown outcomes hold every reservation', () => {
    let s = openPeriod(createModel(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [i === 100 ? 'extra' : `w${i}`, P.recipeInputs[0]]))), 'old', 'term', 0n, P.weeklyCeilings[0]);
    const ceiling = s.periods.get('old')!.sources.salvage.ceiling;
    for (let i = 0n; i < ceiling; i++) s = commit(earn(s, `w${i}`), `a${i}`, `w${i}`);
    expect(() => commit(earn(s, 'extra'), 'extra', 'extra')).toThrow('budget');
    invariant(s);
  });
  it('wallet tax carry spans bases/claims/terms, with no recursive tax on pool proceeds or transfers', () => {
    let s = openPeriod(createModel(), 'old', 'term-old', 0n, P.weeklyCeilings[0]);
    s = awardSite(s, 'old', 'individual', 0n, ['alice']);
    s = openPeriod(s, 'next', 'term-next', P.periodDays, P.weeklyCeilings[0], P.allocations[0], [{ site: 'king', wallet: 'alice' }]);
    for (let i = 0n; i < 4n; i++) s = awardSite(s, 'next', 'individual', i, ['alice']);
    expect(s.taxPools.get('term-next')).toBe(1n);
    const before = s.carry.get('alice');
    s = allocateTax(s, 'term-next', [{ site: 'king', wallet: 'alice' }]);
    s = claimTax(s, 'term-next', 'king');
    expect(claimTax(s, 'term-next', 'king')).toEqual(s);
    s = transfer(s, 'alice', 'bob', 1n, true, true);
    expect(s.carry.get('alice')).toBe(before); expect(s.opportunities.size).toBe(0); invariant(s);
  });
  it('splits existing tax equally across actual frozen winning spots, king ordinary, zero winners held', () => {
    const taxed = awardSite(original(), 'old', 'clan', 0n, ['alice']);
    const winners = [{ site: 'king', wallet: 'king' }, { site: 'regular', wallet: 'regular' }];
    const a = allocateTax(taxed, 'term-old', winners);
    expect(a.entitlements.get('term-old')!.get('king')!.amount).toBe(4n);
    expect(a.entitlements.get('term-old')!.get('regular')!.amount).toBe(4n);
    expect(allocateTax(a, 'term-old', winners)).toEqual(a);
    expect(() => allocateTax(a, 'term-old', [])).toThrow('replay');
    const held = allocateTax(awardSite(openPeriod(createModel(), 'zero', 'term-zero', 0n), 'zero', 'clan', 0n, ['alice']), 'term-zero', []);
    expect(held.taxPools.get('term-zero')).toBe(8n); invariant(held);
    expect(allocateTax(openPeriod(createModel(), 'empty', 'empty-term', 0n), 'empty-term', []).taxPools.get('empty-term') ?? 0n).toBe(0n);
  });
  it('exempt-source sensitivity leaves gross budget unchanged and reports no owner classification', () => {
    const a = awardSite(original(), 'old', 'clan', 0n, ['alice']);
    const b = awardSite(original(0n, true), 'old', 'clan', 0n, ['alice']);
    expect(a.periods).toEqual(b.periods); expect(a.players.get('alice')).toBe(32n); expect(b.players.get('alice')).toBe(40n); invariant(b);
  });
  it('existing-stock purchase adds inputs but no opportunity or supply and enforces deed trading', () => {
    const s = transfer(original(100n), 'alice', 'bob', 10n, true, true);
    expect(s.players.get('bob')).toBe(10n); expect(s.opportunities.size).toBe(0); invariant(s);
    expect(() => transfer(s, 'alice', 'bob', 1n, true, false)).toThrow('deed');
  });
  it('every terminal craft burns frozen fragments once; purchased inputs need no earned opportunity', () => {
    for (const tier of [0, 1, 2, 3]) for (const success of [false, true]) {
      const bought = transfer(original(100n), 'alice', 'bob', P.recipeInputs[tier]!, true, true);
      const pending = precommit(bought, { id: 'craft', wallet: 'bob', earnedDay: null, day: 0n, period: 'old', ...quote, tier, quotedFragments: P.recipeInputs[tier]! });
      expect(pending.players.get('bob')).toBe(0n); expect(pending.burned).toBe(0n);
      expect(pending.periods.get('old')!.reserved).toBe(0n); invariant(pending);
      const outcome: Outcome = success ? { kind: 'success' } : loss;
      const s = settle(pending, 'craft', outcome);
      expect(s.burned).toBe(P.recipeInputs[tier]); expect(s.periods.get('old')!.issued).toBe(0n);
      expect(settle(s, 'craft', outcome)).toEqual(s); invariant(s);
    }
    expect(() => precommit(original(100n), { id: 'bound', wallet: 'alice', earnedDay: null, day: 0n, period: 'old', ...quote, boundInput: true })).toThrow('bound');
  });
  it('rejects salvage without fragment inputs and freezes family/tier/quoted input before any result', () => {
    expect(() => commit(earn(original()))).toThrow('fragments');
    const s = commit(earn(original(100n)));
    const input = { id: 'attempt', wallet: 'alice', earnedDay: 0n, day: 0n, period: 'old', ...quote };
    expect(() => precommit(s, { ...input, family: 'cargo-cutter' })).toThrow('replay');
    expect(() => precommit(s, { ...input, tier: 1 })).toThrow('replay');
    expect(() => precommit(s, { ...input, quotedFragments: 0n })).toThrow('replay');
    expect(() => precommit(original(100n), { ...input, earnedDay: null, quotedFragments: 0n })).toThrow('quote');
    expect(() => transfer(s, 'alice', 'bob', 100n, true, true)).toThrow('stock');
  });
  it('cannot duplicate a weekly ceiling under aliases or commit outside the selected week', () => {
    const s = earn(original(100n));
    expect(() => openPeriod(s, 'alias', 'other-term', 0n)).toThrow('overlap');
    expect(() => openPeriod(s, 'unaligned', 'other-term', 1n)).toThrow('aligned');
    expect(() => openPeriod(s, 'negative', 'other-term', -P.periodDays)).toThrow('negative');
    expect(() => commit(s, 'late', 'alice', 0n, P.periodDays)).toThrow('period');
    const next = openPeriod(s, 'next', 'next-term', P.periodDays);
    expect(() => commit(next, 'early', 'alice', 0n, 0n, 'next')).toThrow('period');
  });
  it('even an always-winning salvage plus trade/craft loop strictly consumes fragments', () => {
    let s = original(100n);
    s = openPeriod(s, 'next', 'next-term', P.periodDays);
    for (let day = 0n; day < 10n; day++) {
      const before = s.players.get('alice')!;
      s = settle(commit(earn(s, 'alice', day), `a${day}`, 'alice', day, day, day < P.periodDays ? 'old' : 'next'), `a${day}`, loss);
      s = transfer(transfer(s, 'alice', 'bob', 1n, true, true), 'bob', 'alice', 1n, true, true);
      expect(s.players.get('alice')! < before).toBe(true); invariant(s);
    }
  });
  it('rational expected fees read current locked application fee and fragment sink remains positive', () => {
    for (let tier = 0; tier < P.recipeInputs.length; tier++) {
      const r = recipeExpectation(tier);
      expect(r.fee.n * r.attempts.d).toBe(r.attempts.n * r.fee.d * BigInt(PHASE_E_POLICY.craft.applicationFeeLamports));
      expect(r.netFragments.n > 0n).toBe(true);
    }
  });
  it('conserves above JS safe integer quantities', () => {
    let s = openPeriod(createModel({ alice: 2n ** 90n }), 'p', 't', 0n, 2n ** 100n);
    s = awardSite(s, 'p', 'clan', 0n, ['alice']);
    s = transfer(s, 'alice', 'bob', 2n ** 80n, true, true); invariant(s);
  });
  it('unavailable term authority blocks earning and proven-zero tax cannot move to later terms', () => {
    const unknown = openPeriod(createModel(), 'old', 'term', 0n, P.weeklyCeiling, P.allocations[0], null);
    expect(() => awardSite(unknown, 'old', 'clan', 0n, ['alice'])).toThrow('authority');
    expect(() => commit(earn(unknown))).toThrow('authority');
    const held = allocateTax(awardSite(openPeriod(createModel(), 'z', 'zero', 0n), 'z', 'clan', 0n, ['alice']), 'zero', []);
    const next = openPeriod(held, 'next', 'next', P.periodDays, P.weeklyCeiling, P.allocations[0], winners);
    expect(next.taxPools.get('zero')).toBe(8n);
    expect(() => allocateTax(next, 'zero', winners)).toThrow('replay');
    expect(() => claimTax(next, 'zero', 'king')).toThrow('entitlement'); invariant(next);
  });
  it('rejects cumulative Renown and source replay across wallets/days', () => {
    const source = { wallet: 'alice', day: 0n, sourceId: 'finalized-source', increment: 1n, finalized: true, personallyEarned: true, source: 'renown' };
    const s = earnOpportunity(original(100n), source);
    expect(() => earnOpportunity(s, { ...source, increment: 0n })).toThrow('increment');
    expect(() => earnOpportunity(s, { ...source, day: 1n })).toThrow('theft');
    expect(() => earnOpportunity(s, { ...source, wallet: 'bob' })).toThrow('theft');
    expect(() => allocateTax(commit(s), 'term-old', winners)).toThrow('pending');
  });
  it('rejects deliberate policy mutants and duplicate identity laundering', () => {
    expect(() => validatePolicy({ ...P, allocations: [[10_000n, 1n, 0n]] })).toThrow('allocation');
    expect(() => validatePolicy({ ...P, salvageMax: P.recipeInputs[0] })).toThrow('sink');
    expect(() => validatePolicy({ ...P, marketCreatesEligibility: true })).toThrow('market');
    expect(() => validatePolicy({ ...P, opportunitiesPerWalletDay: 2n })).toThrow('opportunity');
  });
});
