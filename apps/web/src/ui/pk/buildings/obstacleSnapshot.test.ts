import { describe, expect, it } from 'vitest';
import { quotePresentation } from './quotePresentation';
import { obstacleSnapshot, type ObstacleSnapshotFacts, type ObstacleQuoteFacts } from './obstacleSnapshot';

const quote = (patch: Partial<ObstacleQuoteFacts> = {}): ObstacleQuoteFacts => ({
  price: { currency: 'SHARDS', amount: 'server cost', status: 'OK' }, time: '30s', builders: '1/2 free',
  reward: null, state: 'READY', shortfall: null, builderFreeIn: null, reason: null,
  primaryDetail: 'Uses a builder for 30s', ...patch,
});
const facts = (patch: Partial<ObstacleSnapshotFacts> = {}): ObstacleSnapshotFacts => ({
  base: { obstacles: [{ id: 'rock-1', spriteKey: 'mossy_rock' }], jobs: [] }, selectedObstacleId: 'rock-1',
  currency: 'SHARDS', quote: quote(), art: 'supplied art', name: null, title: null, ...patch,
});

describe('obstacleSnapshot — selected obstacle and explicit removal quote', () => {
  it.each([{ base: null }, { selectedObstacleId: null }, { selectedObstacleId: 'gone' }])
  ('does not paint a quote without a current selected obstacle: %j', patch => {
    expect(obstacleSnapshot(facts(patch))).toBeNull();
  });

  it('declines a new removal as soon as the selected obstacle has any server job', () => {
    const input = facts({ base: { obstacles: [{ id: 'rock-1', spriteKey: 'mossy_rock' }], jobs: [{ obstacleId: 'rock-1' }] } });
    expect(obstacleSnapshot(input)).toBeNull(); // Existing clearing/recovery view owns it, even if its timer elapsed.
    expect(obstacleSnapshot({ ...input, selectedObstacleId: 'other' })).toBeNull();
  });

  it('does not let another obstacle job suppress this selected obstacle', () => {
    const input = facts({ base: { obstacles: [{ id: 'rock-1', spriteKey: 'mossy_rock' }], jobs: [{ obstacleId: 'other' }, { obstacleId: null }] } });
    expect(obstacleSnapshot(input)?.obstacleId).toBe('rock-1');
  });

  it.each(['GEMS', 'KEEP', 'SOL', 'SKR', 'ITEM'] as const)('declines a %s quote without a source-backed removal route', currency => {
    expect(obstacleSnapshot(facts({ currency, quote: quote({ price: { currency, amount: '1', status: 'OK' } }) }))).toBeNull();
  });

  it('declines unknown or conflicting currency instead of defaulting to Shards', () => {
    expect(obstacleSnapshot(facts({ currency: null, quote: null }))).toBeNull();
    expect(obstacleSnapshot(facts({ currency: 'KEEP' }))).toBeNull();
    expect(obstacleSnapshot(facts({ currency: null }))?.price.currency).toBe('SHARDS');
  });

  it('maps only supplied values and uses the existing sprite-key name and native REMOVE title defaults', () => {
    expect(obstacleSnapshot(facts())).toEqual({ obstacleId: 'rock-1', name: 'MOSSY ROCK', title: 'REMOVE', art: 'supplied art',
      price: { currency: 'SHARDS', amount: 'server cost', status: 'OK' }, time: '30s', builders: '1/2 free', reward: null,
      state: 'READY', shortfall: null, builderFreeIn: null, reason: null, primaryDetail: 'Uses a builder for 30s' });
  });

  it('paints loading only with a supplied known currency and never adds catalogue reward or price', () => {
    const ui = obstacleSnapshot(facts({ quote: null }))!;
    expect(ui.state).toBe('CHECKING'); expect(ui.price).toEqual({ currency: 'SHARDS', amount: null, status: 'CHECKING' });
    expect(ui.time).toBe('…'); expect(ui.builders).toBe('…'); expect(ui.reward).toBeNull(); expect(ui.primaryDetail).toBeNull();
  });

  it('clears an earlier displayed and spoken cost when the original controller starts checking a quote', () => {
    const ui = obstacleSnapshot(facts({ quote: quote({ state: 'CHECKING',
      price: { currency: 'SHARDS', amount: 'old amount', status: 'OK', description: 'Costs an old amount' } }) }))!;
    expect(ui.price.status).toBe('CHECKING'); expect(ui.price.amount).toBeNull(); expect(ui.price.description).toBeNull();
    expect(quotePresentation(ui.state, ui.price, ui.reason).sends).toBe(false);
  });

  it('marks a supplied short state without retaining earlier affordable speech', () => {
    const ui = obstacleSnapshot(facts({ quote: quote({ state: 'SHORT',
      price: { currency: 'SHARDS', amount: 'server cost', status: 'OK', description: 'Old affordable quote' } }) }))!;
    expect(ui.price.status).toBe('SHORT'); expect(ui.price.amount).toBe('server cost'); expect(ui.price.description).toBeNull();
    expect(quotePresentation(ui.state, ui.price, ui.reason).sends).toBe(false);
  });

  it('keeps supplied reward and text overrides without recomputing durations or builder quantities', () => {
    const ui = obstacleSnapshot(facts({ name: 'OLD PINE', title: 'REMOVE TREE',
      quote: quote({ time: '6d 2h', reward: 'Server reward sentence', builders: 'server builders', primaryDetail: 'Server detail' }) }))!;
    expect(ui.name).toBe('OLD PINE'); expect(ui.title).toBe('REMOVE TREE'); expect(ui.time).toBe('6d 2h');
    expect(ui.builders).toBe('server builders'); expect(ui.reward).toBe('Server reward sentence'); expect(ui.primaryDetail).toBe('Server detail');
  });

  it.each(['BUSY', 'VERIFYING', 'ERROR', 'READ_ONLY', 'SHORT', 'NO_BUILDER'] as const)
  ('preserves the original controller %s state and recovery facts', state => {
    const ui = obstacleSnapshot(facts({ quote: quote({ state, reason: 'Controller reason', shortfall: 'server gap', builderFreeIn: '2h 14m' }) }))!;
    expect(ui.state).toBe(state); expect(ui.reason).toBe('Controller reason');
    expect(ui.shortfall).toBe('server gap'); expect(ui.builderFreeIn).toBe('2h 14m');
    if (state !== 'ERROR') expect(quotePresentation(ui.state, ui.price, ui.reason).sends).toBe(false);
    expect(JSON.stringify(ui)).not.toContain('Nothing was spent');
  });

  it('does not turn a missing ready quote price into authorization or a fallback zero', () => {
    const ui = obstacleSnapshot(facts({ quote: quote({ price: null }) }))!;
    expect(ui.price).toEqual({ currency: 'SHARDS', amount: null, status: 'UNAVAILABLE' });
    expect(quotePresentation(ui.state, ui.price, ui.reason).sends).toBe(false);
  });

  it.each([null, '', '   ', '0'])('keeps malformed OK amount %j unavailable', amount => {
    const ui = obstacleSnapshot(facts({ quote: quote({ price: { currency: 'SHARDS', amount, status: 'OK' } }) }))!;
    expect(ui.price.status).toBe('UNAVAILABLE'); expect(ui.price.amount).toBeNull();
    expect(quotePresentation(ui.state, ui.price, ui.reason).sends).toBe(false);
  });

  it.each(['00', '0.0', '000.000', '+0.00', '-0.0', '.0', '0.', ' 00.00 '])
  ('keeps exact decimal zero %j unavailable without SERVER_ZERO', amount => {
    const ui = obstacleSnapshot(facts({ quote: quote({
      price: { currency: 'SHARDS', amount, status: 'OK', description: 'Stale cost' },
    }) }))!;
    expect(ui.price.status).toBe('UNAVAILABLE'); expect(ui.price.amount).toBeNull(); expect(ui.price.description).toBeNull();
    expect(quotePresentation(ui.state, ui.price, ui.reason).sends).toBe(false);
  });

  it('preserves a canonical positive integer above Number.MAX_SAFE_INTEGER exactly', () => {
    const price = { currency: 'SHARDS' as const, amount: '9007199254740993', status: 'OK' as const };
    const ui = obstacleSnapshot(facts({ quote: quote({ price }) }))!;
    expect(ui.price).toEqual(price); expect(quotePresentation(ui.state, ui.price, ui.reason).sends).toBe(true);
  });

  it.each(['00', '0.0'])('preserves authoritative SERVER_ZERO with displayed amount %j', amount => {
    const price = { currency: 'SHARDS' as const, amount, status: 'SERVER_ZERO' as const };
    const ui = obstacleSnapshot(facts({ quote: quote({ price }) }))!;
    expect(ui.price).toEqual(price); expect(quotePresentation(ui.state, ui.price, ui.reason).sends).toBe(true);
  });

  it('preserves explicit server zero and keeps missing or blank readouts unknown', () => {
    const ui = obstacleSnapshot(facts({ quote: quote({ price: { currency: 'SHARDS', amount: null, status: 'SERVER_ZERO' }, time: null, builders: ' ' }) }))!;
    expect(ui.price.status).toBe('SERVER_ZERO'); expect(ui.time).toBe('…'); expect(ui.builders).toBe('…');
  });

  it('copies a quote without mutating supplied snapshot or price facts', () => {
    const price = Object.freeze({ currency: 'SHARDS' as const, amount: 'old', status: 'CHECKING' as const, description: 'stale speech' });
    const input = Object.freeze(facts({ quote: Object.freeze(quote({ price })) }));
    const ui = obstacleSnapshot(input)!;
    expect(ui.price.amount).toBeNull(); expect(ui.price.description).toBeNull(); expect(ui.price).not.toBe(price);
    expect(price.amount).toBe('old'); expect(price.description).toBe('stale speech');
  });
});
