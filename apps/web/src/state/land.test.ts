/**
 * THE THIRD STATE, PINNED.
 *
 * Free onboarding turns one client boolean into three player tiers, and getting
 * the derivation wrong is not a cosmetic bug in either direction:
 *   • too permissive → a wallet that still owes 0.2 SOL is shown a base the
 *     server will not serve, i.e. the paywall silently disappears on a server
 *     that never enabled the free tier;
 *   • too strict → a legitimately free player is bounced to a paywall they do
 *     not need and cannot get past, which is the old wall with extra steps.
 *
 * So every case below encodes WHY, not just WHAT. The load-bearing one is
 * `hasBase: false`: that IS the flag-off world (the server 402s /base for a
 * deedless wallet), and it must still produce the blocking paywall.
 */
import { describe, expect, it } from 'vitest';
import { canPlay, landState, LAND_LOCKED, LAND_UNLOCKS, LAND_NO_MAP_NOTE } from './land';

const S = (o: Partial<Parameters<typeof landState>[0]>): ReturnType<typeof landState> =>
  landState({ authed: true, hasBase: false, landOwned: false, paying: false, ...o });

describe('landState — three tiers from server facts only', () => {
  it('not signed in is anon, whatever else is true', () => {
    expect(S({ authed: false, hasBase: true, landOwned: true, paying: true })).toBe('anon');
  });

  it('FREE_ONBOARDING OFF (server refused a base) → gated: the blocking paywall survives', () => {
    // This is the whole flag-off safety story. The client is told nothing about
    // FREE_ONBOARDING; it learns the tier is unavailable because GET /base 402'd
    // and therefore no base was ever set. If this ever returned 'no-land' the
    // client would sit on a base screen with no base.
    expect(S({ hasBase: false })).toBe('gated');
    expect(canPlay('gated')).toBe(false);
  });

  it('base + no land → no-land: signed in, playing, limited', () => {
    expect(S({ hasBase: true })).toBe('no-land');
    expect(canPlay('no-land')).toBe(true);
  });

  it('land owned → landowner, and it does not depend on hasBase', () => {
    // A landowner mid-reload has entryPaid from /me before /base resolves. If the
    // base question could demote them they would flash the paywall on every load.
    expect(S({ landOwned: true, hasBase: false })).toBe('landowner');
    expect(S({ landOwned: true, hasBase: true })).toBe('landowner');
    expect(canPlay('landowner')).toBe(true);
  });

  it('a credited payment ENDS paying — server truth beats the in-flight flag', () => {
    // Ordering matters: the poll flips landOwned and the phase can lag a tick.
    // If `paying` won, the player would be held on the entry screen after paying.
    expect(S({ paying: true, landOwned: true, hasBase: true })).toBe('landowner');
  });

  it('paying holds the player on the entry screen — from EITHER tier', () => {
    // The confirmation poll lives in useEntry, which unmounts with the screen, so
    // wandering off mid-payment abandons the watch on money already sent.
    expect(S({ paying: true, hasBase: false })).toBe('paying'); // paywall path
    expect(S({ paying: true, hasBase: true })).toBe('paying'); // free-tier path
  });
});

describe('the pitch stays honest', () => {
  it('names only things the server actually gates behind land', () => {
    // Every title maps to a gate in LAND-DEED-ONBOARDING-PLAN §2.2. Nothing
    // aspirational: the deed once advertised Trophies/League traits that were
    // never delivered (apps/api/test/deed.test.ts), and that is the mistake this
    // list must not repeat.
    expect(LAND_UNLOCKS.map((u) => u.title)).toEqual([
      'YOUR PARCEL', 'GOLD FORGE', 'TRADE ON THE MARKET', 'RAID LANDOWNERS',
      'PVE BOUNTIES', 'CLANS',
    ]);
  });

  it('promises BOTH sides of the market, because the server gates both', () => {
    // The pitch said "SELL ON THE MARKET" while /market/listings/:id/reserve —
    // the BUY path — is `owned` too. A deedless player who read the list and then
    // tapped BUY found a gate nobody had mentioned (security review F10).
    const market = LAND_UNLOCKS.find((u) => /MARKET/.test(u.title));
    expect(market).toBeDefined();
    expect(`${market?.title} ${market?.sub}`).toMatch(/buy/i);
    expect(`${market?.title} ${market?.sub}`).toMatch(/sell/i);
    // …and it must not sell the free half as if it were the paid one.
    expect(market?.sub).toMatch(/brows/i);
  });

  it('states BOTH halves of having no land, not just the flattering one', () => {
    // No land ⇒ no deeded Earth cell. That single mechanism both protects the
    // free base AND locks it out of attacking landowners; advertising only the
    // protection would sell a shield that is really a fence.
    expect(LAND_NO_MAP_NOTE).toMatch(/nobody can find, scout or raid you/i);
    expect(LAND_NO_MAP_NOTE).toMatch(/cannot raid landowners/i);
  });

  it('presents the frozen parcel without Earth-history or private allocator details', () => {
    const publicCopy = [
      ...LAND_UNLOCKS.flatMap(({ title, sub }) => [title, sub]),
      LAND_NO_MAP_NOTE,
    ].join('\n');
    expect(publicCopy).toMatch(/frozen land tile/i);
    expect(publicCopy).toMatch(/globe/i);
    expect(publicCopy).not.toMatch(/Earth|valley|patch|\b\d+\s*,\s*\d+\b/i);
  });

  it('quotes no PRICE — that number has exactly one source', () => {
    // ECONOMY.entryFeeSol is a two-place fact with the deployed on-chain Config
    // PDA (plan R13); a copy of it in UI strings would be a third. Naming SOL as
    // a currency is fine ("list for SOL") — a SOL AMOUNT is not.
    const all = JSON.stringify(LAND_UNLOCKS) + LAND_NO_MAP_NOTE + JSON.stringify(LAND_LOCKED);
    expect(all).not.toMatch(/\d+(\.\d+)?\s*(SOL|KEEP|shards)/i);
  });
});

describe('LAND_LOCKED — the copy that replaces a dead toast', () => {
  it('covers every screen that renders a locked state', () => {
    // One entry per screen wired in menu.tsx. A screen added to the locked set
    // without copy would fall back to a bare 402 toast, which is the bug.
    expect(Object.keys(LAND_LOCKED).sort()).toEqual(
      ['clans', 'forge', 'keepWallet', 'market', 'twofa', 'withdraw']);
  });

  it('says what the screen was FOR, not just that it is locked', () => {
    for (const [k, v] of Object.entries(LAND_LOCKED)) {
      expect(v.title, k).toMatch(/\S/);
      // A refusal has to carry a reason: "NEEDS LAND" alone is the toast again.
      expect(v.why.length, k).toBeGreaterThan(40);
    }
  });

  it('never tells a player that reaching their own KEY needs land', () => {
    // Security review F8: exporting your private key is a custody right. The 2FA
    // panel is the one locked state that sits on the same screen as key export,
    // so it must scope its claim to withdrawals and say the key is not gated.
    expect(LAND_LOCKED.twofa.why).toMatch(/withdrawal/i);
    expect(LAND_LOCKED.twofa.why).toMatch(/key/i);
    expect(LAND_LOCKED.twofa.why).toMatch(/does not/i);
  });

  it('does not claim Shards were ever withdrawable', () => {
    // The free tier mines Shards and only KEEP leaves the game. A locked KEEP
    // wallet that implied lost earnings would be the same lie as the quest board's.
    expect(LAND_LOCKED.keepWallet.why).toMatch(/shards were never withdrawable/i);
  });
});
