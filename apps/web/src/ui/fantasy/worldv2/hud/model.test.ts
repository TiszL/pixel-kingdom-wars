import { describe, expect, it } from 'vitest';
import { FANTASY_WORLD } from '@shardkeep/shared';
import { DEFAULT_REALM_FILTER, RAIL_ENTRIES, cardTags, levelFiltered, markersCarryShield, realmCtaRows, realmStats, splitSearch, type CardDetail, type RealmFilter } from './model';
import type { FantasySearchResult } from '../../data';

const shield = (over: Partial<CardDetail['shield']> = {}): CardDetail['shield'] =>
  ({ active: false, source: null, expiresAt: null, remainingMs: 0, suppressedByWarzone: false, ...over });
const actions = (allowed: boolean): CardDetail['actions'] =>
  ({ scout: { allowed: true, blockedBy: null }, attack: { allowed, blockedBy: allowed ? null : 'shielded' } });
const labels = (own: boolean, detail: Pick<CardDetail, 'shield' | 'actions'> | null): string[] => cardTags(own, detail).map(t => t.label);

describe('"You can attack" is the server\'s word, never the client\'s', () => {
  // Why: raiding has no location rule (owner 2026-09-26). The tag may only echo actions.attack.allowed; a client
  // guess would tell a player to attack someone the server then refuses, or hide a legal target.
  it('shows exactly when actions.attack.allowed is true for a rival', () => {
    expect(labels(false, { shield: shield(), actions: actions(true) })).toContain('You can attack');
    expect(labels(false, { shield: shield(), actions: actions(false) })).not.toContain('You can attack');
    expect(labels(false, null)).toEqual([]);
  });
  it('never on your own base, which reads "Your base"', () => {
    expect(labels(true, { shield: shield(), actions: actions(true) })).toEqual(['Your base']);
  });
  it('a warzone-suppressed shield says so beside the attack tag; an active one reads Shielded', () => {
    expect(labels(false, { shield: shield({ active: true, suppressedByWarzone: true }), actions: actions(true) })).toEqual(['Shield suppressed', 'You can attack']);
    expect(cardTags(false, { shield: shield({ active: true }), actions: actions(false) })).toEqual([{ label: 'Shielded', tone: 'blue' }]);
    expect(cardTags(false, { shield: shield(), actions: actions(true) })).toEqual([{ label: 'You can attack', tone: 'red' }]);
  });
});

describe('the Unshielded filter is absent until a read carries the field', () => {
  // Why (D-181, D-191): an API or validator that drops `shielded` (K-188) would make every rival look open; the chip must
  // hide rather than filter on a missing key — and with D-191's Unshielded chip a missing key must never pass as "open".
  it('reads the key, not its value', () => {
    expect(markersCarryShield(undefined)).toBe(false);
    expect(markersCarryShield([{ tileId: 1, name: 'a', keepLevel: 3 }])).toBe(false);
    expect(markersCarryShield([{ tileId: 1, name: 'a', keepLevel: 3, shielded: false }])).toBe(true);
    expect(markersCarryShield([{ tileId: 1, name: 'a', keepLevel: 3, shielded: 'yes' }])).toBe(false);
  });
  it('D-191: the filter kinds are all / mine / unshielded (no shielded), starting on All over the whole level range', () => {
    const kinds: Array<RealmFilter['kind']> = ['all', 'mine', 'unshielded'];
    expect(kinds).toContain(DEFAULT_REALM_FILTER.kind);
    expect(DEFAULT_REALM_FILTER.kind).toBe('all'); expect(levelFiltered(DEFAULT_REALM_FILTER)).toBe(false);
    expect(levelFiltered({ ...DEFAULT_REALM_FILTER, lo: 7 })).toBe(true);
  });
});

describe('the realm panel always offers Enter map', () => {
  const kinds = (rows: ReturnType<typeof realmCtaRows>): string[][] => rows.map(r => r.map(c => `${c.kind}${c.gold ? '*' : ''}`));
  // Why: the owner (Seeker code 31b) lost Enter map when choose-land mode replaced the whole foot.
  it('choose mode leads with Choose land here and keeps the browse row', () => {
    expect(kinds(realmCtaRows({ realmId: 'crownlands', open: 12, mine: true, hasMap: true, choose: true })))
      .toEqual([['choose-land*'], ['my-base', 'enter-map']]);
    expect(kinds(realmCtaRows({ realmId: 'crownlands', open: 0, mine: false, hasMap: true, choose: true })))
      .toEqual([['no-open-land'], ['enter-map*']]);
  });
  it('Solana Reach never offers open land but still enters', () => {
    expect(kinds(realmCtaRows({ realmId: 'seeker-reach', open: 5, mine: false, hasMap: true, choose: true })))
      .toEqual([['no-open-land'], ['enter-map*']]);
  });
  it('browse mode: one gold, My base only when MY PARCEL opened the panel', () => {
    expect(kinds(realmCtaRows({ realmId: 'elderwood', open: 3, mine: true, hasMap: true }))).toEqual([['my-base', 'enter-map*']]);
    expect(kinds(realmCtaRows({ realmId: 'elderwood', open: 3, mine: true, hasMap: true, mineCta: true }))).toEqual([['my-base*', 'enter-map']]);
    expect(kinds(realmCtaRows({ realmId: 'elderwood', open: 3, mine: false, hasMap: true, ready: 0.42 }))).toEqual([['preparing*']]);
    expect(realmCtaRows({ realmId: 'elderwood', open: 3, mine: false, hasMap: true, ready: 0.42 })[0]![0]!.percent).toBe(42);
  });
});

describe('realm stats come from the server read and the catalogue', () => {
  const counts = { realmId: 'x', total: 9000, occupied: 120, held: 3, available: 8877, anchorTileId: null };
  it('ordinary realms: Deeds / Kingdoms / Open deeds / Your bases', () => {
    expect(realmStats('crownlands', counts, 2).map(s => [s.label, s.value, s.mine]))
      .toEqual([['Deeds', 9000, false], ['Kingdoms', 120, false], ['Open deeds', 8877, false], ['Your bases', 2, true]]);
  });
  it('Solana Reach: Deeds / Genesis / Seeker / Open deeds from FANTASY_WORLD', () => {
    expect(realmStats('seeker-reach', { ...counts, available: 0 }, 0).map(s => [s.label, s.value]))
      .toEqual([['Deeds', 9000], ['Genesis', FANTASY_WORLD.genesisTiles], ['Seeker', FANTASY_WORLD.seekerTiles], ['Open deeds', 0]]);
  });
  it('an unread count is unknown, never zero', () => {
    expect(realmStats('crownlands', null, 0).slice(0, 3).map(s => s.value)).toEqual([null, null, null]);
  });
});

describe('rail and search', () => {
  it('the rail has 11 destinations: 8 realms then 3 islands', () => {
    expect(RAIL_ENTRIES).toHaveLength(11);
    expect(RAIL_ENTRIES.slice(8).map(e => e.id)).toEqual(['seeker-island', 'solana-island', 'divine-isle']);
    expect(RAIL_ENTRIES.slice(0, 8).every(e => e.kind === 'realm')).toBe(true);
  });
  it('a realm map search splits this realm from "Go to ‹realm›" rows', () => {
    const row = (tileId: number, realmId: string): FantasySearchResult => ({ tileId, realmId, name: `k${tileId}`, keepLevel: 3, trophies: 0, seeker: false });
    const split = splitSearch([row(1, 'sunscar'), row(2, 'frostveil'), row(3, 'sunscar')], 'sunscar');
    expect(split.here.map(r => r.tileId)).toEqual([1, 3]);
    expect(split.elsewhere.map(r => r.tileId)).toEqual([2]);
  });
});
