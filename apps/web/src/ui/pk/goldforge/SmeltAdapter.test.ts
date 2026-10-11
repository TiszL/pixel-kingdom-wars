import { describe, expect, it } from 'vitest';
import type { MiningContributionState } from '../../../lib/miningContribution/controller';
import { command, identity, proof, view } from '../../../lib/miningContribution/fixtures.test-support';
import { projectSmelt, smeltBasket, smeltMaximum } from './SmeltAdapter';

const idle = (): MiningContributionState => ({ loaded: true, busy: false, journal: {
  version: 1, identity, revision: 0, operation: null, archives: [],
}, review: null, error: null });
const admission = { scopeMatches: true, observationCurrent: true, actionsAllowed: true,
  ownerHandoffReady: true, freshEntryAllowed: true };
const basket = [{ resourceId: 'frost_quartz' as const, quantity: '1' }];

describe('Gold Forge SMELT read-only adapter', () => {
  it('does not call an absent view uncapped or invent raid progress and payouts', () => {
    const result = projectSmelt(idle(), null, [], admission);
    expect(result.cap).toEqual({ kind: 'unknown', amount: null });
    expect(result.day).toBeNull();
    expect(result.canReviewNew).toBe(false);
    expect(result.estimate).toBeNull();
    expect(result.qualified).toBeNull();
    expect(result.raidDays).toBeNull();
  });

  it('requires explicit current owner admission and authoritative readiness for a new basket', () => {
    expect(projectSmelt(idle(), view(), basket).canReviewNew).toBe(false);
    expect(projectSmelt(idle(), view(), basket, admission).canReviewNew).toBe(true);
    for (const gate of Object.keys(admission) as (keyof typeof admission)[]) {
      expect(projectSmelt(idle(), view(), basket, { ...admission, [gate]: false }).canReviewNew).toBe(false);
    }
    expect(projectSmelt(idle(), { ...view(), acceptingContributions: false }, basket, admission).canReviewNew).toBe(false);
    expect(projectSmelt(idle(), { ...view(), developmentReady: false }, basket, admission).canReviewNew).toBe(false);
    expect(projectSmelt({ ...idle(), busy: true }, view(), basket, admission).canReviewNew).toBe(false);
    expect(projectSmelt({ ...idle(), error: 'refresh failed' }, view(), basket, admission).canReviewNew).toBe(false);
  });

  it('keeps exact quantities beyond Number precision and values only from the view', () => {
    const large = { ...view(), pool: 'deed' as const, dailyCapValue: null, remainingValue: null,
      resources: [{ resourceId: 'shards' as const, available: '9007199254740993', unitValue: '7' }] };
    const lines = [{ resourceId: 'shards' as const, quantity: '9007199254740993' }];
    expect(smeltBasket(large, lines)).toEqual({ valid: true, reason: null,
      count: '9007199254740993', value: '63050394783186951' });
    expect(smeltMaximum(large, [], 'shards')).toBe('9007199254740993');
    expect(projectSmelt(idle(), large, lines, admission).cap).toEqual({ kind: 'uncapped', amount: null });
  });

  it('MAX subtracts other lines, floors by unit value and clips by stock without Number', () => {
    const data = { ...view(), remainingValue: '23', resources: [
      { resourceId: 'shards' as const, available: '100', unitValue: '3' },
      { resourceId: 'forge_ingot' as const, available: '2', unitValue: '7' },
    ] };
    const lines = [{ resourceId: 'forge_ingot' as const, quantity: '2' }, { resourceId: 'shards' as const, quantity: '1' }];
    expect(smeltMaximum(data, lines, 'shards')).toBe('3');
    expect(smeltMaximum(data, [{ resourceId: 'shards', quantity: '1' }], 'forge_ingot')).toBe('2');
    expect(smeltMaximum({ ...data, remainingValue: '1' }, lines, 'shards')).toBe('0');
  });

  it('rejects a whole invalid basket without silently clamping or combining duplicates', () => {
    const data = view();
    for (const lines of [[], [...basket, ...basket], [{ ...basket[0]!, quantity: '0' }],
      [{ ...basket[0]!, quantity: '-1' }], [{ ...basket[0]!, quantity: '1.5' }],
      [{ ...basket[0]!, quantity: '01' }], [{ ...basket[0]!, quantity: '9999999999999999999' }]]) {
      expect(smeltBasket(data, lines).valid).toBe(false);
    }
    expect(smeltBasket({ ...data, remainingValue: '0' }, basket).valid).toBe(false);
    expect(smeltBasket({ ...data, resources: [] }, basket).valid).toBe(false);
    expect(smeltMaximum({ ...data, resources: [] }, basket, 'frost_quartz')).toBeNull();
  });

  it('preserves the original attempted basket under new-entry hold and refresh failure', () => {
    const state = idle(), original = command();
    state.journal!.operation = { command: original, attemptRevision: 1, proof: null, refusal: null };
    state.journal!.revision = 1;
    const result = projectSmelt({ ...state, error: 'lost answer' }, null, [], {
      ...admission, observationCurrent: false, actionsAllowed: false, freshEntryAllowed: false,
    });
    expect(result.original?.requestKey).toBe(original.request.idempotencyKey);
    expect(result.original?.lines).toEqual(original.request.lines);
    expect(result.original?.outcome).toBe('uncertain');
    expect(result.canReviewNew).toBe(false);
    expect(result.message).not.toContain('Nothing');
  });

  it('labels an unattempted saved basket as a draft, never held resources', () => {
    const state = idle();
    state.journal!.operation = { command: command(), attemptRevision: null, proof: null, refusal: null };
    const result = projectSmelt(state, view(), basket, admission);
    expect(result.original?.outcome).toBe('draft');
    expect(result.canReviewNew).toBe(false);
  });

  it('accepted proof means held, never a raid win or settled KEEP', () => {
    const state = idle(), original = command();
    state.journal!.revision = 1;
    state.journal!.operation = { command: original, attemptRevision: 1, proof: proof(original, true), refusal: null };
    const result = projectSmelt(state, view(), basket, admission);
    expect(result.original?.outcome).toBe('held');
    expect(result.qualified).toBeNull();
    expect(result.estimate).toBeNull();
    expect(result.canReviewNew).toBe(false);
  });

  it('terminal resource outcomes remain separate from a paid KEEP receipt', () => {
    const original = command(), accepted = proof(original, true, true);
    const state = idle();
    state.journal!.revision = 1;
    state.journal!.operation = { command: original, attemptRevision: 1, proof: accepted, refusal: null };
    expect(projectSmelt(state, view(), [], admission).original?.outcome).toBe('consumed');
    if (accepted.status !== 'accepted' || !accepted.settlement) throw Error('Fixture requires settled proof');
    accepted.settlement.outcome = 'returned';
    expect(projectSmelt(state, view(), [], admission).original?.outcome).toBe('returned');
  });

  it('suppresses another owner scope without confusing a stale observation with a wallet switch', () => {
    const state = idle();
    state.journal!.revision = 1;
    state.journal!.operation = { command: command(), attemptRevision: 1, proof: null, refusal: null };
    const hidden = projectSmelt(state, view(), basket, { ...admission, scopeMatches: false });
    expect(hidden.original).toBeNull();
    expect(hidden.resources).toEqual([]);
    expect(hidden.committed).toBeNull();
    const retained = projectSmelt(state, view(), basket, { ...admission, observationCurrent: false });
    expect(retained.original).not.toBeNull();
    expect(retained.freshness).toBe('retained');
    expect(retained.canReviewNew).toBe(false);
  });

  it('keeps accepted archived baskets reachable after finish while new entry is held', () => {
    // finish() may archive an accepted basket before settlement. It is still
    // checked by the original owner's open()/checkArchived(key), not a new basket.
    const state = idle(), original = command(), accepted = proof(original, true);
    // A durable attempt cannot be newer than its enclosing journal revision.
    state.journal!.revision = 1;
    state.journal!.archives = [{ reason: 'accepted', evidence: null,
      operation: { command: original, attemptRevision: 1, proof: accepted, refusal: null } }];
    const held = projectSmelt(state, null, [], { ...admission, freshEntryAllowed: false, observationCurrent: false });
    expect(held.original).toBeNull();
    expect(held.history).toHaveLength(1);
    expect(held.history[0]?.requestKey).toBe(original.request.idempotencyKey);
    expect(held.history[0]?.outcome).toBe('held');
    expect(held.canReviewNew).toBe(false);
    state.journal!.archives[0]!.operation.proof = proof(original, true, true);
    expect(projectSmelt(state, null, [], admission).history[0]?.outcome).toBe('consumed');
    const settled = state.journal!.archives[0]!.operation.proof;
    if (settled.status !== 'accepted' || !settled.settlement) throw Error('Fixture requires settled proof');
    settled.settlement.outcome = 'returned';
    expect(projectSmelt(state, null, [], admission).history[0]?.outcome).toBe('returned');
    expect(projectSmelt(state, view(), [], { ...admission, scopeMatches: false }).history).toEqual([]);
  });
});
