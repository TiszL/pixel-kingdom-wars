import { describe, expect, it } from 'vitest';
import { placeLook } from './buildingsLogic';
import { placementSnapshot, type PlacementSnapshotFacts } from './placementSnapshot';

const facts = (patch: Partial<PlacementSnapshotFacts> = {}): PlacementSnapshotFacts => ({
  type: 'barracks', name: 'Barracks', tile: [4, 7], tileValid: true, tileReason: null, currency: 'SHARDS',
  price: { currency: 'SHARDS', amount: '1,500', status: 'OK' }, shortfall: null,
  time: '2h', freeBuilders: 1, totalBuilders: 2, nextBuilderFreeIn: '2h 14m',
  available: true, readOnly: false, constructionBlocked: false, busy: false, heroOffer: false,
  orderState: 'IDLE', orderReason: null, ...patch,
});
const route = (input: PlacementSnapshotFacts) => {
  const ui = placementSnapshot(input);
  return ui ? placeLook(ui.state, ui.price, ui.reason).tap : null;
};

describe('placementSnapshot — native LivePlacementMapper strip facts', () => {
  it('maps a picked tile and a supplied Shards quote without calculating a price or footprint', () => {
    const ui = placementSnapshot(facts())!;
    expect(ui).toEqual({ type: 'barracks', name: 'BARRACKS', price: { currency: 'SHARDS', amount: '1,500', status: 'OK' },
      time: '2h', builders: '1/2', state: 'VALID', hint: 'Tap another spot to move it · PLACE to build', reason: null });
    expect(route(facts())).toBe('PLACE');
    expect('takenTiles' in ui).toBe(false);
  });

  it.each([{ type: 'wall' }, { heroOffer: true }])('declines the existing wall or hero flow: %j', patch => {
    expect(placementSnapshot(facts(patch))).toBeNull();
  });

  it.each(['GEMS', 'KEEP', 'SOL', 'SKR', 'ITEM'] as const)('declines %s instead of creating a new spend route', currency => {
    expect(placementSnapshot(facts({ currency, price: { currency, amount: '10', status: 'OK' } }))).toBeNull();
  });

  it('does not assume Shards when currency and quote are absent or contradict one another', () => {
    expect(placementSnapshot(facts({ currency: null, price: null }))).toBeNull();
    expect(placementSnapshot(facts({ currency: 'KEEP' }))).toBeNull();
    expect(placementSnapshot(facts({ currency: null }))?.price.currency).toBe('SHARDS'); // Currency is supplied by the quote.
  });

  it.each([
    [{ busy: true, readOnly: true }, 'SENDING', null],
    [{ readOnly: true, constructionBlocked: true }, 'BLOCKED', 'Orders are paused here'],
    [{ constructionBlocked: true, available: false }, 'BLOCKED', 'Check the saved payment first'],
    [{ available: false, tile: null }, 'BLOCKED', 'Not available now'],
    [{ tile: null, freeBuilders: 0 }, 'BLOCKED', 'Tap a spot first'],
  ] as const)('keeps native admission precedence for %j', (patch, state, reason) => {
    const input = facts(patch); const ui = placementSnapshot(input)!;
    expect(ui.state).toBe(state); expect(ui.reason).toBe(reason); expect(route(input)).toBe('NONE');
  });

  it.each([
    { busy: true }, { shortfall: '1,490' }, { freeBuilders: 0 },
    { price: null }, { readOnly: true, tileValid: false },
  ])('preserves original-controller uncertainty ahead of competing facts: %j', patch => {
    const input = facts({ ...patch, orderState: 'VERIFYING', orderReason: 'Checking the original request' });
    const ui = placementSnapshot(input)!;
    expect(ui.state).toBe('VERIFYING'); expect(ui.reason).toBe('Checking the original request');
    const look = placeLook(ui.state, ui.price, ui.reason);
    expect(look.tap).toBe('NONE'); expect(look.draggable).toBe(false);
    expect(JSON.stringify(ui)).not.toContain('Nothing was spent');
  });

  it.each([false, null])('requires a supplied valid tile rather than only picked coordinates (%j)', tileValid => {
    const input = facts({ tileValid, tileReason: 'Original controller tile reason' });
    expect(placementSnapshot(input)?.state).toBe('BLOCKED');
    expect(placementSnapshot(input)?.reason).toBe('Original controller tile reason');
    expect(route(input)).toBe('NONE');
  });

  it('keeps a missing known-currency quote unavailable ahead of the builder gate', () => {
    const input = facts({ price: null, freeBuilders: 0 }); const ui = placementSnapshot(input)!;
    expect(ui.price).toEqual({ currency: 'SHARDS', amount: null, status: 'UNAVAILABLE' });
    expect(ui.state).toBe('VALID'); expect(route(input)).toBe('NONE');
  });

  it('uses the supplied shortfall fact and preserves the no-builder priority', () => {
    const short = facts({ shortfall: '1,490' });
    expect(placementSnapshot(short)?.price.status).toBe('SHORT'); expect(route(short)).toBe('NEED_MORE');
    const noBuilder = facts({ shortfall: '1,490', freeBuilders: 0 });
    expect(route(noBuilder)).toBe('BUILDERS');
    expect(placementSnapshot(noBuilder)?.builders).toBe('free in 2h 14m');
    expect(route(facts({ shortfall: null }))).toBe('PLACE'); // Unknown affordability is not fabricated as SHORT.
  });

  it('preserves supplied checking and unavailable statuses without stale spoken amounts', () => {
    for (const status of ['CHECKING', 'UNAVAILABLE'] as const) {
      const input = facts({ price: { currency: 'SHARDS', amount: 'old amount', status, description: 'Costs an old amount' } });
      expect(route(input)).toBe('NONE');
      expect(placementSnapshot(input)?.price.amount).toBeNull();
      expect(placementSnapshot(input)?.price.description).toBeNull();
    }
  });

  it.each([null, '', '   ', '0'])('does not authorize an incomplete OK quote (%j)', amount => {
    const input = facts({ price: { currency: 'SHARDS', amount, status: 'OK' } });
    expect(route(input)).toBe('NONE'); expect(placementSnapshot(input)?.price.status).toBe('UNAVAILABLE');
  });

  it.each(['00', '0.0', '000.000', '+0.00', '-0.0', '.0', '0.', ' 00.00 '])
  ('rejects exact decimal zero %j unless the server supplied SERVER_ZERO', amount => {
    const input = facts({ price: { currency: 'SHARDS', amount, status: 'OK', description: 'Stale cost' } });
    const ui = placementSnapshot(input)!;
    expect(ui.price.status).toBe('UNAVAILABLE'); expect(ui.price.amount).toBeNull();
    expect(ui.price.description).toBeNull(); expect(route(input)).toBe('NONE');
  });

  it('preserves a canonical positive integer above Number.MAX_SAFE_INTEGER exactly', () => {
    const amount = '9007199254740993';
    const input = facts({ price: { currency: 'SHARDS', amount, status: 'OK' } });
    expect(placementSnapshot(input)?.price).toEqual(input.price);
    expect(route(input)).toBe('PLACE');
  });

  it.each(['00', '0.0'])('preserves the authoritative SERVER_ZERO status for displayed amount %j', amount => {
    const input = facts({ price: { currency: 'SHARDS', amount, status: 'SERVER_ZERO' } });
    expect(placementSnapshot(input)?.price).toEqual(input.price); expect(route(input)).toBe('PLACE');
  });

  it('preserves an explicit server zero without manufacturing one from a missing amount', () => {
    const input = facts({ price: { currency: 'SHARDS', amount: null, status: 'SERVER_ZERO' } });
    expect(placementSnapshot(input)?.price.status).toBe('SERVER_ZERO'); expect(route(input)).toBe('PLACE');
  });

  it('keeps duration strings opaque and unknown text honest', () => {
    const ui = placementSnapshot(facts({ tile: null, time: null, totalBuilders: null }))!;
    expect(ui.time).toBe('…'); expect(ui.builders).toBe('1/…');
    expect(ui.hint).toBe('Tap where the barracks goes · pinch to zoom');
    expect(placementSnapshot(facts({ time: '6d 2h' }))?.time).toBe('6d 2h');
    expect(placementSnapshot(facts({ freeBuilders: 0, totalBuilders: null, nextBuilderFreeIn: null }))?.builders).toBe('0/…');
  });

  it('returns a new price without mutating supplied quote facts', () => {
    const price = Object.freeze({ currency: 'SHARDS' as const, amount: '1,500', status: 'OK' as const });
    const input = Object.freeze(facts({ price, shortfall: '1,490' }));
    expect(placementSnapshot(input)?.price).not.toBe(price);
    expect(price.status).toBe('OK');
  });
});
