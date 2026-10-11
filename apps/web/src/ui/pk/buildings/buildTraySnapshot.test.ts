/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { BUILD_TRAY_TABS, type BuildTrayTabId } from './BuildTray';
import type { PriceUi } from '../types';
import { buildTraySnapshot, type BuildTrayOfferFact, type BuildTraySnapshotFacts } from './buildTraySnapshot';

// Explicit fixture records, not a seeded production catalogue or an inferred offer list.
const offer: BuildTrayOfferFact = {
  status: 'OFFERED', type: 'supplied-type', name: 'Supplied name', purpose: 'Supplied purpose', art: 'supplied-art',
  count: 'server owned / server cap', countTone: 'BLUE', state: 'AVAILABLE',
  price: { currency: 'KEEP', amount: 'server price', status: 'OK', description: 'Server price description' },
  time: 'server duration', reason: null, isNew: false, requires: null,
};
const facts: BuildTraySnapshotFacts = {
  selectedTab: 'BUILDINGS', builders: 'server free / server total', buildersFree: true,
  categories: [{ tab: 'BUILDINGS', id: 'supplied-category', title: 'Supplied category', icon: 'supplied-icon', count: 'server category count', offers: [offer] }],
  missingOffers: [], firstTimeHint: true, focusType: null, emptyReason: 'No construction offers supplied.',
  suppliesUnavailableReason: 'Supplies owner unavailable.', layoutsUnavailableReason: 'Layout owner unavailable.',
};

describe('UNBOUND buildTraySnapshot', () => {
  const eligibleStates = ['AVAILABLE', 'CHECKING', 'SHORT'] as const;
  const guardedPrices: readonly { input: string; price: PriceUi | null; expected: 'UNAVAILABLE' | 'CHECKING' | 'SHORT' }[] = [
    { input: 'UNAVAILABLE', price: { currency: 'SHARDS', amount: 'previous quote', status: 'UNAVAILABLE' }, expected: 'UNAVAILABLE' },
    { input: 'CHECKING', price: { currency: 'SHARDS', amount: 'previous quote', status: 'CHECKING' }, expected: 'CHECKING' },
    { input: 'SHORT', price: { currency: 'SHARDS', amount: 'server short quote', status: 'SHORT' }, expected: 'SHORT' },
    { input: 'null price', price: null, expected: 'CHECKING' },
    { input: 'OK with null amount', price: { currency: 'SHARDS', amount: null, status: 'OK' }, expected: 'CHECKING' },
    { input: 'OK with empty amount', price: { currency: 'SHARDS', amount: '', status: 'OK' }, expected: 'CHECKING' },
    { input: 'OK with whitespace amount', price: { currency: 'SHARDS', amount: ' \t\n ', status: 'OK' }, expected: 'CHECKING' },
  ];

  it.each(guardedPrices)('guards $input for every eligible OFFERED state and keeps the supplied reason', ({ price, expected }) => {
    for (const state of eligibleStates) {
      const supplied: BuildTrayOfferFact = { ...offer, state, price, reason: 'Supplied server reason' };
      const result = buildTraySnapshot({ ...facts, categories: [{ ...facts.categories[0]!, offers: [supplied] }] });
      const card = result.ui.sections[0]!.cards[0]!;
      expect(card.state).toBe(expected); expect(card.reason).toBe('Supplied server reason');
      expect(card.price).toEqual(price); expect(supplied.state).toBe(state);
    }
  });

  it.each(['UNAVAILABLE', 'LOCKED', 'MAX', 'REQUIRES'] as const)('preserves supplied %s precedence over guarded prices', state => {
    for (const { price } of guardedPrices) {
      const result = buildTraySnapshot({ ...facts, categories: [{ ...facts.categories[0]!, offers: [
        { ...offer, state, price, reason: 'Supplied state reason' },
      ] }] });
      const card = result.ui.sections[0]!.cards[0]!;
      expect(card.state).toBe(state); expect(card.reason).toBe('Supplied state reason');
    }
  });

  it.each([
    { currency: 'SHARDS', amount: '250', status: 'OK' },
    { currency: 'SHARDS', amount: null, status: 'SERVER_ZERO' },
  ] satisfies readonly PriceUi[])('preserves eligible states for authoritative $status prices', price => {
    for (const state of eligibleStates) {
      const result = buildTraySnapshot({ ...facts, categories: [{ ...facts.categories[0]!, offers: [{ ...offer, state, price }] }] });
      expect(result.ui.sections[0]!.cards[0]!.state).toBe(state);
      expect(result.ui.sections[0]!.cards[0]!.price).toEqual(price);
    }
  });

  it('preserves a non-null supplied focus target without selecting or creating its card', () => {
    const result = buildTraySnapshot({ ...facts, categories: [], focusType: 'supplied-focus-type' });
    expect(result.ui.focusType).toBe('supplied-focus-type'); expect(result.ui.sections).toEqual([]);
  });

  it('pins its pure local tab identifiers to the rendered BUILD tray labels', () => {
    expect(buildTraySnapshot(facts).ui.tabs?.map(tab => tab.id)).toEqual(BUILD_TRAY_TABS);
  });

  it('projects only explicit supplied offers and preserves presentation fields and currency', () => {
    const result = buildTraySnapshot(facts);
    expect(result.ui.sections).toEqual([{ id: 'supplied-category', title: 'Supplied category', icon: 'supplied-icon', count: 'server category count', cards: [{
      type: 'supplied-type', name: 'Supplied name', purpose: 'Supplied purpose', art: 'supplied-art',
      count: 'server owned / server cap', countTone: 'BLUE', state: 'AVAILABLE',
      price: offer.price, time: 'server duration', reason: null, isNew: false, requires: null,
    }] }]);
    expect(result.ui.builders).toBe(facts.builders); expect(result.ui.buildersFree).toBe(true);
    expect(result.ui.firstTimeHint).toBe(true); expect(result.ui.focusType).toBeNull();
  });

  it('does not discover cards from enabledTypes or fill absent Phase E records', () => {
    const input = { ...facts, categories: [], features: { phaseEBuildings: { version: 1, enabledTypes: ['workshop', 'lodge', 'market', 'harvester', 'berth'] } } };
    const result = buildTraySnapshot(input);
    expect(result.ui.sections).toEqual([]); expect(result.ui.unavailableReasons).toEqual([]);
    expect(result.ui.emptyReason).toBe(facts.emptyReason);
  });

  it('projects missing-offer reasons for the selected tab without manufacturing a card', () => {
    const result = buildTraySnapshot({ ...facts, categories: [], missingOffers: [
      { tab: 'BUILDINGS', id: 'missing-service', name: 'Supplied service', reason: 'Server says why it is missing.' },
      { tab: 'TRAPS', id: 'missing-trap', name: 'Supplied trap', reason: 'A different server reason.' },
    ] });
    expect(result.ui.sections).toEqual([]);
    expect(result.ui.unavailableReasons).toEqual([{ id: 'missing-service', name: 'Supplied service', reason: 'Server says why it is missing.' }]);
  });

  it('preserves supplied category ordering, labels and counts without local grouping or sums', () => {
    const category = facts.categories[0]!;
    const result = buildTraySnapshot({ ...facts, categories: [
      { ...category, id: 'second', count: 'server count B', offers: [{ ...offer, type: 'B' }] },
      { ...category, id: 'first', count: 'server count A', offers: [{ ...offer, type: 'A', isNew: true }] },
    ] });
    expect(result.ui.sections.map(section => section.id)).toEqual(['second', 'first']);
    expect(result.ui.sections.map(section => section.count)).toEqual(['server count B', 'server count A']);
    expect(result.ui.sections[1]!.cards[0]!.isNew).toBe(true);
  });

  it('preserves empty supplied categories without inventing count labels or fallback offers', () => {
    const result = buildTraySnapshot({ ...facts, categories: [{ ...facts.categories[0]!, offers: [], count: 'server empty count' }] });
    expect(result.ui.sections[0]!.cards).toEqual([]); expect(result.ui.sections[0]!.count).toBe('server empty count');
  });

  it.each(['BUILDINGS', 'DEFENCES', 'TRAPS', 'HEROES', 'SUPPLIES', 'LAYOUTS'] as const)('retains selected %s and all six labelled tabs', selectedTab => {
    const result = buildTraySnapshot({ ...facts, selectedTab });
    expect(result.ui.selectedTab).toBe(selectedTab);
    expect(result.ui.tabs?.map(tab => tab.id)).toEqual(['BUILDINGS', 'DEFENCES', 'TRAPS', 'HEROES', 'SUPPLIES', 'LAYOUTS']);
    if (selectedTab !== 'BUILDINGS') expect(result.ui.sections).toEqual([]);
  });

  it('filters cards by supplied tab rather than inferring a category from the building type', () => {
    const tabs: BuildTrayTabId[] = ['BUILDINGS', 'DEFENCES', 'TRAPS', 'HEROES'];
    const result = buildTraySnapshot({ ...facts, selectedTab: 'TRAPS', categories: tabs.map(tab => ({
      ...facts.categories[0]!, tab, id: tab, offers: [{ ...offer, type: `server-type-${tab}` }],
    })) });
    expect(result.ui.sections.map(section => section.id)).toEqual(['TRAPS']);
    expect(result.ui.sections[0]!.cards[0]!.type).toBe('server-type-TRAPS');
  });

  it('keeps server cap and required-building states and reasons without recomputing precedence', () => {
    const states = ['MAX', 'LOCKED', 'REQUIRES', 'SHORT'] as const;
    const result = buildTraySnapshot({ ...facts, categories: [{ ...facts.categories[0]!, offers: states.map(state => ({
      ...offer, state, reason: `Server ${state} reason`, count: `Server ${state} count`, requires: 'server-required-type',
    })) }] });
    expect(result.ui.sections[0]!.cards.map(card => [card.state, card.reason, card.count, card.requires])).toEqual(
      states.map(state => [state, `Server ${state} reason`, `Server ${state} count`, 'server-required-type']),
    );
  });

  it('draws an explicitly unavailable record off with its required supplied reason', () => {
    const unavailable: BuildTrayOfferFact = { ...offer, status: 'UNAVAILABLE', reason: 'Server unavailable reason' };
    const result = buildTraySnapshot({ ...facts, categories: [{ ...facts.categories[0]!, offers: [unavailable] }] });
    expect(result.ui.sections[0]!.cards[0]!.state).toBe('UNAVAILABLE');
    expect(result.ui.sections[0]!.cards[0]!.reason).toBe('Server unavailable reason');
    expect(result.ui.sections[0]!.cards[0]!.price).toEqual(offer.price);
  });

  it('marks unknown supplied records CHECKING and masks their last quote through price status', () => {
    const unknown: BuildTrayOfferFact = { ...offer, status: 'UNKNOWN', reason: 'Server quote is pending' };
    const result = buildTraySnapshot({ ...facts, categories: [{ ...facts.categories[0]!, offers: [unknown] }] });
    const card = result.ui.sections[0]!.cards[0]!;
    expect(card.state).toBe('CHECKING'); expect(card.price).toEqual({ ...offer.price, status: 'CHECKING' });
    expect(card.reason).toBe('Server quote is pending'); expect(offer.price?.status).toBe('OK');
  });

  it('preserves absent price, time and reasons without zero prices or invented copy', () => {
    const result = buildTraySnapshot({ ...facts, emptyReason: null, categories: [{ ...facts.categories[0]!, offers: [
      { ...offer, status: 'UNKNOWN', price: null, time: null, reason: null },
    ] }] });
    const card = result.ui.sections[0]!.cards[0]!;
    expect(card.price).toBeNull(); expect(card.time).toBeNull(); expect(card.reason).toBeNull(); expect(result.ui.emptyReason).toBeNull();
  });

  it('keeps Supplies and Layouts required fallback reasons separate from construction empty copy', () => {
    const result = buildTraySnapshot({ ...facts, selectedTab: 'LAYOUTS' });
    expect(result.layoutsUnavailableReason).toBe('Layout owner unavailable.');
    expect(result.suppliesUnavailableReason).toBe('Supplies owner unavailable.');
    expect(result.ui.emptyReason).toBe('No construction offers supplied.');
  });

  it('copies supplied tab metadata into the fixed six labels without inventing badges or locks', () => {
    const result = buildTraySnapshot({ ...facts, tabs: [{ id: 'TRAPS', icon: 'supplied-tab-art', locked: true,
      badge: { text: 'supplied badge', tone: 'INFO', description: 'Server badge description' } }] });
    expect(result.ui.tabs?.[2]).toEqual({ id: 'TRAPS', icon: 'supplied-tab-art', locked: true,
      badge: { text: 'supplied badge', tone: 'INFO', description: 'Server badge description' } });
    expect(result.ui.tabs?.[0]).toEqual({ id: 'BUILDINGS' });
  });

  it('returns fresh records so presentation changes cannot mutate the supplied snapshot', () => {
    const result = buildTraySnapshot(facts);
    expect(result.ui.sections[0]).not.toBe(facts.categories[0]);
    expect(result.ui.sections[0]!.cards[0]).not.toBe(offer);
    expect(result.ui.sections[0]!.cards[0]!.price).not.toBe(offer.price);
    expect(facts.categories[0]!.offers[0]!.status).toBe('OFFERED');
  });
});
